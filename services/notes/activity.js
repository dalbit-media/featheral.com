"use strict";
const { period } = require("./candles");
const fail = message => Object.assign(new Error(message), { status: 400 });
const sources = ["world", "exchange", "wallet", "gold", "app", "silver", "notes", "other"];
const noteSource = `CASE WHEN site='notes-market' THEN 'exchange' WHEN site='notes-wallet' THEN 'wallet'
  WHEN site='featheral-app' THEN 'app' WHEN site='silver.featheral.com' THEN 'silver'
  WHEN site IN ('notes-creation','notes') THEN 'notes' ELSE 'other' END`;
function options(input = {}, now = Date.now()) {
  const interval = input.interval === undefined ? "24h" : input.interval;
  if (typeof interval !== "string") throw fail("Choose a supported chart interval.");
  const [duration, bucket] = period(interval);
  const symbol = input.symbol || "", source = input.source || "";
  if (typeof symbol !== "string" || symbol.length > 16 || /[\x00-\x20]/.test(symbol)) throw fail("Choose a valid currency.");
  if (typeof source !== "string" || source && !sources.includes(source)) throw fail("Choose a valid activity source.");
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("Activity page size must be from 1 to 100.");
  let end = now, cursor = null;
  if (input.cursor !== undefined && input.cursor !== "") {
    if (typeof input.cursor !== "string" || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw fail("Invalid activity cursor.");
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); }
    catch { throw fail("Invalid activity cursor."); }
    if (!cursor || !Number.isSafeInteger(cursor.end) || cursor.end > now || cursor.end < now - 86400000
      || !Number.isSafeInteger(cursor.at) || cursor.at > cursor.end || cursor.at < cursor.end - duration
      || typeof cursor.id !== "string" || !/^(?:[nt]:\d{20}|d:0x[0-9a-f]{64}(?::FTHG)?)$/.test(cursor.id)
      || cursor.interval !== interval || cursor.symbol !== symbol || cursor.source !== source) throw fail("Activity cursor expired or filters changed. Refresh activity.");
    end = cursor.end;
  }
  return { interval, bucket, from: end - duration, to: end, symbol, source, limit, cursor };
}
function readRows(db, table, query, type = "dollar") {
  const notes = type === "notes";
  const columns = notes ? `printf('n:%020d',id) AS id,at,symbol,${noteSource} AS source,kind,
    CAST(ABS(amount) AS TEXT) AS amount,CAST(MAX(amount,0) AS TEXT) AS credits,
    CAST(-MIN(amount,0) AS TEXT) AS debits,'posting' AS recordType`
    : type === "custody" ? `printf('t:%020d',id) AS id,at,'FTH$' AS symbol,'exchange' AS source,side AS kind,
      CASE WHEN side='buy' THEN output ELSE amount END AS amount,
      CASE WHEN side='buy' THEN output ELSE '0' END AS credits,
      CASE WHEN side='sell' THEN amount ELSE '0' END AS debits,'custody-trade' AS recordType`
      : "id,at,symbol,source,kind,amount,credits,debits,record_type AS recordType";
  const filters = ["at>=?", "at<=?"], args = [query.from, query.to];
  if (query.symbol) { filters.push("symbol=?"); args.push(query.symbol); }
  if (query.source) { filters.push("source=?"); args.push(query.source); }
  const sql = `WITH activity AS (SELECT ${columns} FROM ${table}${notes ? " WHERE symbol NOT IN ('FTH$','FTHG')" : ""})
    SELECT * FROM activity WHERE ${filters.join(" AND ")}`;
  const summary = new Map(), buckets = new Map();
  for (const row of db.prepare(sql).iterate(...args)) {
    const add = target => {
      target.events++;
      target.credits = (BigInt(target.credits) + BigInt(row.credits)).toString();
      target.debits = (BigInt(target.debits) + BigInt(row.debits)).toString();
    };
    const group = `${row.symbol}:${row.recordType}`;
    if (!summary.has(group)) summary.set(group, { symbol: row.symbol, recordType: row.recordType, events: 0, credits: "0", debits: "0" });
    add(summary.get(group));
    const at = Math.floor(row.at / query.bucket) * query.bucket, key = `${group}:${at}`;
    if (!buckets.has(key)) buckets.set(key, { symbol: row.symbol, recordType: row.recordType, at, events: 0, credits: "0", debits: "0" });
    add(buckets.get(key));
  }
  const cursor = query.cursor;
  const rows = db.prepare(sql + (cursor ? " AND (at<? OR (at=? AND id<?))" : "") + " ORDER BY at DESC,id DESC LIMIT ?")
    .all(...args, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), query.limit + 1);
  return { rows, summary: [...summary.values()], buckets: [...buckets.values()] };
}
function merge(groups, key) {
  const values = new Map();
  for (const row of groups.flat()) {
    const id = key(row), prior = values.get(id);
    if (!prior) values.set(id, { ...row });
    else {
      prior.events += row.events;
      prior.credits = (BigInt(prior.credits) + BigInt(row.credits)).toString();
      prior.debits = (BigInt(prior.debits) + BigInt(row.debits)).toString();
    }
  }
  return [...values.values()];
}
function activity(creation, dollarReader, input, now = Date.now()) {
  const query = options(input, now), notes = readRows(creation.db, "notes_entries", query, "notes");
  const custody = readRows(creation.db, "trading_dollar_trades", query, "custody");
  const dollar = dollarReader ? dollarReader(query) : { rows: [], summary: [], buckets: [] };
  const all = [...notes.rows, ...dollar.rows, ...custody.rows].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const rows = all.slice(0, query.limit), last = rows.at(-1);
  return { interval: query.interval, from: query.from, to: query.to, bucketMs: query.bucket, rows,
    nextCursor: all.length > query.limit ? Buffer.from(JSON.stringify({ end: query.to, at: last.at, id: last.id,
      interval: query.interval, symbol: query.symbol, source: query.source })).toString("base64url") : null,
    summary: merge([notes.summary, dollar.summary, custody.summary], row => `${row.symbol}:${row.recordType}`).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    buckets: merge([notes.buckets, dollar.buckets, custody.buckets], row => `${row.symbol}:${row.recordType}:${row.at}`).sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol)),
    coverage: { notes: "All committed native/community note ledger postings; debit and credit legs are separate records.",
      dollar: dollarReader ? "All sealed FTH$ financial transactions, including World, wallet, Exchange and Gold settlement. Pending transactions are excluded."
        : "Unavailable: Dollar activity reader is not connected.",
      gold: "FTHG reserve activity separates off-chain obligations from Ethereum-confirmed reserve transfers. Unrelated Ethereum transfers are not indexed. These series are never combined or treated as FTHX trades.",
      world: "Financial World settlements are included through the Dollar ledger. Non-financial gameplay is not a currency transaction.",
      custody: "Exchange FTH$ trades change custody liabilities without a Dollar transfer; custody-trade charts are separate from sealed settlement charts.",
      accounting: "Activity counts and gross credits/debits are not unique user actions, trade volume, net issuance or price candles." },
    partial: !dollarReader };
}
function trades(creation, input, now = Date.now()) {
  const query = options(input, now);
  const rows = creation.db.prepare(`SELECT t.id,t.symbol,t.side,t.amount,t.output,t.at FROM note_trades t
    WHERE t.at>=? AND t.at<=? AND (?='' OR t.symbol=? OR ?='FTHX')
    AND NOT EXISTS (SELECT 1 FROM dollar_note_requests r WHERE r.id=substr(t.request_id,7) AND t.request_id LIKE 'route-%' AND r.status!='complete')
    ORDER BY t.at DESC,t.id DESC LIMIT 100`)
    .all(query.from, query.to, query.symbol, query.symbol, query.symbol).map(row => ({
      id: `note:${row.id}`, at: row.at, symbol: row.symbol, from: row.side === "buy" ? "FTHX" : row.symbol,
      to: row.side === "buy" ? row.symbol : "FTHX", amount: String(row.amount), output: String(row.output) }));
  if (!query.symbol || ["FTH$", "FTHX"].includes(query.symbol)) {
    rows.push(...creation.db.prepare(`SELECT t.id,t.side,t.amount,t.output,t.at FROM trading_dollar_trades t
      WHERE t.at>=? AND t.at<=? ORDER BY t.at DESC,t.id DESC LIMIT 100`).all(query.from, query.to).map(row => ({
      id: `trading:${row.id}`, at: row.at, symbol: "FTH$", from: row.side === "buy" ? "FTHX" : "FTH$",
      to: row.side === "buy" ? "FTH$" : "FTHX", amount: row.amount, output: row.output })));
    rows.push(...creation.db.prepare(`SELECT t.*,json_extract(r.payload,'$.intermediate') AS intermediate FROM dollar_note_trades t
      JOIN dollar_note_requests r ON r.id=t.id WHERE r.status='complete' AND t.at>=? AND t.at<=?
      ORDER BY t.at DESC,t.id DESC LIMIT 100`).all(query.from, query.to).map(row => {
      const buying = row.from_symbol !== "FTH$";
      return { id: `wallet:${row.id}`, at: row.at, symbol: "FTH$", from: buying ? "FTHX" : "FTH$",
        to: buying ? "FTH$" : "FTHX", amount: buying ? row.intermediate : row.amount, output: buying ? row.output : row.intermediate };
    }));
  }
  return { rows: rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, 100),
    description: "Latest 100 executed pool legs in this window. Multi-hop routes have a leg per pool; transfers and payments are excluded." };
}
function liquidity(creation, exchange) {
  const pool = exchange.pool();
  let dollarError = null;
  if (pool.funded && !pool.pendingSettlement && pool.settlementEnabled) {
    try { exchange.validatePool(pool); }
    catch (error) {
      if (error.status !== 409) throw error;
      dollarError = error.message;
    }
  }
  const markets = creation.markets.catalog().map(market => {
    const account = creation.markets.poolAccount(market.symbol);
    const reconciled = creation.notes.balance(account, "FTHX") === market.baseReserve
      && creation.notes.balance(account, market.symbol) === market.noteReserve;
    return { symbol: market.symbol, base: "FTHX", baseReserve: String(market.baseReserve), tokenReserve: String(market.noteReserve),
      status: !reconciled ? "reserve-mismatch" : pool.pendingSettlement ? "recovery-required" : market.funded ? "funded" : "unfunded",
      initialTarget: { FTHX: String(market.targetFthx), notes: String(market.targetNotes) },
      fundingNeeded: !market.funded ? { FTHX: String(market.targetFthx), notes: String(market.targetNotes) } : null,
      feeBps: market.feeBps };
  });
  markets.unshift({ symbol: "FTH$", base: "FTHX", baseReserve: String(pool.fthx), tokenReserve: pool.dollars, feeBps: pool.feeBps,
    status: dollarError ? "reserve-mismatch" : pool.pendingSettlement ? "recovery-required"
      : !pool.settlementEnabled ? "writer-unavailable" : pool.funded ? "funded" : "unfunded",
    error: dollarError, initialTarget: null, fundingNeeded: null });
  return { markets, approvalRequired: true, automaticFunding: false,
    policy: "Existing funds only. Initial note targets are not rebalancing requirements: reserves change normally with trades. FTH$ initial amounts require explicit administrator approval; no target or peg is invented." };
}
module.exports = { activity, options, readRows, liquidity, trades };
