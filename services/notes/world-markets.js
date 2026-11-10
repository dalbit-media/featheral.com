"use strict";
const { period, candles } = require("./candles");
const { RATE } = require("./fthx-settlement");
const UNIT = 10n ** 18n, GAME_UNIT = 10n ** 14n;
const fail = (status, message) => Object.assign(new Error(message), { status });
const description = "Executed World inventory trades, quoted in FTHX at the internal 100 FTHX/FTH$ denomination. Historical FTH$ fills are converted, not retroactive currency swaps. Legacy timestamps use the game clock and are excluded from rolling wall-clock volumes. World items are not redeemable wallet notes.";
class WorldMarkets {
  constructor(db, ledger) { this.db = db; this.ledger = ledger; }
  streams() {
    const exists = name => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!exists("market_fills")) throw fail(503, "World trade history is unavailable on this node.");
    const linked = Boolean(exists("world_trade_settlements"));
    const settlement = (venue, id) => linked
      ? `LEFT JOIN world_trade_settlements s ON s.venue='${venue}' AND s.fill=${id} LEFT JOIN fund_commits c ON c.id=s.commit_id` : "";
    const columns = linked ? `CASE WHEN s.fill IS NULL THEN 'historical-recorded' WHEN s.commit_id IS NULL
      THEN 'netted-inventory-fill' ELSE 'sealed-dollar-settlement' END AS settlement,
      CASE WHEN s.commit_id IS NOT NULL THEN json_extract(c.transaction_data,'$.i') END AS commitId` : "'historical-recorded' AS settlement,NULL AS commitId";
    const ready = linked ? "AND ((s.fill IS NULL AND NOT EXISTS(SELECT 1 FROM fund_commits WHERE settled=0)) OR (s.fill IS NOT NULL AND (s.commit_id IS NULL OR c.settled=1)))"
      : exists("fund_commits") ? "AND NOT EXISTS(SELECT 1 FROM fund_commits WHERE settled=0)" : "";
    const at = linked ? "COALESCE(s.executed_at,f.time)" : "f.time";
    const streams = [`SELECT 'market' AS stream,f.id,f.asset,f.quantity,f.dollars,${at} AS at,f.time AS sourceTime,f.venue,
      ${columns} FROM market_fills f ${settlement("market", "f.id")} WHERE f.quantity>0 AND f.dollars>0 ${ready}`];
    if (exists("enhancement_sales")) streams.push(`SELECT 'equipment' AS stream,f.listingId AS id,
      'enhanced-'||json_extract(l.equipment,'$.item')||'-level-'||json_extract(l.equipment,'$.level') AS asset,1 AS quantity,f.dollars,${at} AS at,f.time AS sourceTime,'players-equipment' AS venue,
      ${columns} FROM enhancement_sales f JOIN enhancement_listings l ON l.id=f.listingId
      ${settlement("equipment", "f.listingId")} WHERE f.dollars>0 ${ready}`);
    return streams.join(" UNION ALL ");
  }
  query(input = {}, now = Date.now()) {
    const interval = input.interval ?? "24h";
    if (typeof interval !== "string") throw fail(400, "Choose a supported chart interval.");
    const duration = interval === "all" ? now : period(interval)[0];
    const asset = input.asset ?? "";
    if (typeof asset !== "string" || asset && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(asset))
      throw fail(400, "Choose a valid World asset.");
    return { from: interval === "all" ? 0 : now - duration, to: interval === "all" ? 253402300799999 : now, asset, interval };
  }
  rows(query, limit) {
    const rows = this.db.prepare(`SELECT * FROM (${this.streams()}) WHERE at>=? AND at<=? AND (?='' OR asset=?)
      ORDER BY at DESC,stream DESC,id DESC ${limit ? "LIMIT ?" : ""}`)
      .all(query.from, query.to, query.asset, query.asset, ...(limit ? [limit] : []));
    const synchronized = rows.some(row => row.commitId) && this.ledger?.fthxSettlement?.summary().synchronized;
    return rows.map(row => {
      for (const key of ["id", "quantity", "dollars", "at"])
        if (!Number.isSafeInteger(row[key]) || row[key] < 1) throw fail(503, "World trade contains invalid exact accounting units.");
      if (typeof row.asset !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.asset))
        throw fail(503, "World trade contains an invalid inventory asset.");
      let settlementHash = null, backing = row.settlement === "netted-inventory-fill" ? "netted-no-currency-movement" : "historical-denomination";
      if (row.commitId) {
        const hash = this.ledger?.ids.get(row.commitId), record = hash && this.ledger.findTx(hash);
        if (!record?.location) return null;
        settlementHash = hash;
        backing = synchronized ? "locked-fthx-settlement" : "dollar-settlement";
      }
      const quoteAmount = BigInt(row.dollars) * GAME_UNIT * RATE;
      return { id: `world:${row.stream}:${row.id}`, marketId: `WORLD:${row.asset}`, symbol: `WORLD:${row.asset}`,
        asset: row.asset, ticker: row.asset.toUpperCase(), quantity: String(row.quantity),
        dollars: (BigInt(row.dollars) * GAME_UNIT).toString(), quoteAmount: quoteAmount.toString(),
        quoteCurrency: "FTHX", quoteDecimals: 18, assetDecimals: 0, at: row.at, sourceTime: row.sourceTime,
        clock: row.settlement === "historical-recorded" ? "historical-game-clock" : "execution-wall-clock", venue: `world-${row.venue}`,
        settlement: row.settlement, settlementHash, backing,
        price: { numerator: quoteAmount.toString(), denominator: (BigInt(row.quantity) * UNIT).toString(), currency: "FTHX" } };
    }).filter(Boolean);
  }
  tape(input = {}, now = Date.now()) {
    const query = this.query(input, now);
    return { rows: this.rows(query, 100), description };
  }
  catalog(now = Date.now(), rows = this.rows({ from: 0, to: 253402300799999, asset: "" })) {
    const assets = new Map();
    for (const row of rows) {
      if (!assets.has(row.asset)) assets.set(row.asset, { symbol: row.marketId, marketId: row.marketId,
        asset: row.asset, ticker: row.ticker, name: row.asset.replaceAll("-", " "), venue: "world",
        inventoryOnly: true, quoteCurrency: "FTHX", quoteDecimals: 18, funded: false, trades: 0, recordedTrades: 0,
        volume: "0", volumeBaseUnits: "0", recordedVolumeBaseUnits: "0", price: row.price, lastTradeAt: row.at,
        clock: row.clock, description });
      const market = assets.get(row.asset);
      market.recordedTrades++;
      market.recordedVolumeBaseUnits = (BigInt(market.recordedVolumeBaseUnits) + BigInt(row.quoteAmount)).toString();
      if (row.clock === "execution-wall-clock" && market.clock === "historical-game-clock") {
        market.price = row.price; market.lastTradeAt = row.at; market.clock = row.clock;
      }
      if (row.at >= now - 86400000 && row.at <= now && row.clock === "execution-wall-clock") {
        market.trades++;
        market.volumeBaseUnits = (BigInt(market.volumeBaseUnits) + BigInt(row.quoteAmount)).toString();
        market.volume = (BigInt(market.volumeBaseUnits) / UNIT).toString();
      }
    }
    return [...assets.values()].sort((a, b) => BigInt(a.volumeBaseUnits) > BigInt(b.volumeBaseUnits) ? -1
      : BigInt(a.volumeBaseUnits) < BigInt(b.volumeBaseUnits) ? 1
      : BigInt(a.recordedVolumeBaseUnits) > BigInt(b.recordedVolumeBaseUnits) ? -1
      : BigInt(a.recordedVolumeBaseUnits) < BigInt(b.recordedVolumeBaseUnits) ? 1 : a.symbol.localeCompare(b.symbol));
  }
  history(asset, interval = "24h", now = Date.now(), snapshot) {
    const query = this.query({ asset, interval }, now);
    const rows = (snapshot ? snapshot.filter(row => row.asset === asset && row.at >= query.from && row.at <= query.to)
      : this.rows(query)).reverse();
    const bucket = interval === "all" ? 86400000 : period(interval)[1];
    const result = candles(rows.map(row => ({ at: row.at, base: BigInt(row.quantity) * UNIT, quote: row.quoteAmount })), bucket)
      .map(candle => ({ ...candle, baseVolume: (BigInt(candle.baseVolume) / UNIT).toString() }));
    return { symbol: `WORLD:${asset}`, currency: "FTHX", interval, from: interval === "all" ? rows[0]?.at ?? now : query.from,
      to: interval === "all" ? Math.max(now, (rows.at(-1)?.at ?? now) + 1) : now,
      source: "world-executed-inventory", quoteDecimals: 18, assetDecimals: 0,
      baseVolumeDecimals: 0, quoteVolumeDecimals: 18, clocks: [...new Set(rows.map(row => row.clock))],
      description, candles: result, points: result.map(candle => ({ at: candle.at, ...candle.close })) };
  }
  overview(interval = "24h", now = Date.now()) {
    this.query({ interval }, now);
    const snapshot = this.rows({ from: 0, to: 253402300799999, asset: "" });
    return this.catalog(now, snapshot).map(market => ({ ...market,
      history: this.history(market.asset, market.trades ? interval : "all", now, snapshot) }));
  }
}
module.exports = { WorldMarkets, description };
