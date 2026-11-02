"use strict";
const crypto = require("node:crypto");
const { SYSTEM_TREASURY_ACCOUNT } = require("../dollar-api/funds");
const fail = (status, message) => Object.assign(new Error(message), { status });
const SPECIAL_SUFFIXES = "#$@!%^&*()-_+=.,:;?~";
const PLACEHOLDERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", ..."0123456789", ...SPECIAL_SUFFIXES]
  .map(suffix => `FTH${suffix}`).filter(symbol => !["FTHX", "FTHG", "FTH$"].includes(symbol));
const TARGET = 1000000;
const isReservedSpecial = symbol => typeof symbol === "string" && /^FTH[^A-Z0-9]$/.test(symbol) && symbol !== "FTH$";
const isReservedMarket = symbol => symbol === "FTHG" || isReservedSpecial(symbol);
const requireTradingSymbol = symbol => {
  if (isReservedMarket(symbol) || ["FTHX", "FTH$"].includes(symbol)) throw fail(409, "This note symbol is reserved. Trading and funding are disabled.");
};
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) throw fail(400, `${name} must be a whole number from 1 to 1,000,000,000.`);
  return value;
};

class Markets {
  constructor(notes) {
    this.notes = notes;
    this.db = notes.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_markets(symbol TEXT PRIMARY KEY,placeholder INTEGER NOT NULL DEFAULT 0,
        base INTEGER NOT NULL DEFAULT 0 CHECK(base>=0),quote INTEGER NOT NULL DEFAULT 0 CHECK(quote>=0),
        funded_at INTEGER, CHECK((base=0 AND quote=0) OR (base>0 AND quote>0)));
      CREATE TABLE IF NOT EXISTS note_trades(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,amount INTEGER NOT NULL,output INTEGER NOT NULL,
        volume INTEGER NOT NULL,at INTEGER NOT NULL,UNIQUE(owner,request_id));
      CREATE TABLE IF NOT EXISTS note_positions(symbol TEXT NOT NULL,owner TEXT NOT NULL,shares INTEGER NOT NULL CHECK(shares>=0),PRIMARY KEY(symbol,owner));
      CREATE TABLE IF NOT EXISTS note_liquidity(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner,request_id));
    `);
    this.atomic(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO note_markets(symbol,placeholder) VALUES (?,1)");
      const definitions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_currencies'").get()
        ? new Set(this.db.prepare("SELECT symbol FROM note_currencies").all().map(row => row.symbol)) : new Set();
      for (const symbol of PLACEHOLDERS) if (!definitions.has(symbol)) insert.run(symbol);
      for (const symbol of definitions) if (!isReservedMarket(symbol) && !["FTHX", "FTH$"].includes(symbol))
        this.db.prepare("INSERT OR IGNORE INTO note_markets(symbol) VALUES (?)").run(symbol);
      for (const pool of this.db.prepare("SELECT symbol FROM note_markets WHERE base>0").all()) {
        if (!this.db.prepare("SELECT 1 FROM note_positions WHERE symbol=?").get(pool.symbol)) this.initialShares(pool.symbol);
      }
    });
  }
  atomic(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pool(symbol) {
    if (typeof symbol !== "string") throw fail(400, "A note symbol is required.");
    const pool = this.db.prepare("SELECT * FROM note_markets WHERE symbol=?").get(symbol);
    if (!pool) throw fail(404, "Unknown note market.");
    return pool;
  }
  requireUnlocked() {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dollar_note_requests'").get()
      && this.db.prepare("SELECT 1 FROM dollar_note_requests WHERE status IN ('paying','paid','settling','awaiting_signature')").get())
      throw fail(409, "A Dollar route is settling. Retry after settlement recovery.");
  }
  catalog(now = Date.now(), includeReserved = false) {
    return this.db.prepare(`SELECT m.*,COALESCE(v.volume,0) AS volume,COALESCE(v.trades,0) AS trades
      FROM note_markets m LEFT JOIN (SELECT symbol,SUM(volume) AS volume,COUNT(*) AS trades
      FROM note_trades WHERE at>=? AND at<=? GROUP BY symbol) v ON v.symbol=m.symbol
      ORDER BY volume DESC,m.symbol`).all(now - 86400000, now).map(pool => {
        if (!Number.isSafeInteger(pool.volume)) throw fail(409, "Market volume exceeds safe unit limits.");
        return {
        symbol: pool.symbol, name: pool.symbol === "FTHS" && !pool.placeholder ? "Featheral Silver" : `${pool.symbol} ${pool.placeholder ? "placeholder" : "community"} note`, placeholder: !!pool.placeholder,
        quoteCurrency: "FTHX", baseReserve: pool.base, noteReserve: pool.quote, volume: pool.volume,
        trades: pool.trades, funded: pool.base > 0, targetFthx: TARGET, targetNotes: TARGET, feeBps: 30,
        reserved: isReservedMarket(pool.symbol),
        price: pool.base > 0 ? { numerator: String(pool.base), denominator: String(pool.quote), currency: "FTHX" } : null,
      }; }).filter(market => includeReserved || !market.reserved);
  }
  fund(symbol, approval) {
    this.requireUnlocked();
    if (approval !== `FUND ${symbol} ${TARGET} FTHX ${TARGET} NOTES`) throw fail(400, "Exact market funding approval is required.");
    return this.atomic(() => {
      this.requireUnlocked();
      const pool = this.pool(symbol);
      requireTradingSymbol(symbol);
      if (pool.base > 0) throw fail(409, "This market is already funded.");
      this.entry(SYSTEM_TREASURY_ACCOUNT, -TARGET, "market_funding_out", "FTHX", symbol);
      this.db.prepare("UPDATE note_markets SET base=?,quote=?,funded_at=? WHERE symbol=?")
        .run(TARGET, TARGET, Date.now(), symbol);
      this.entry(this.poolAccount(symbol), TARGET, "market_funding_in", "FTHX", SYSTEM_TREASURY_ACCOUNT);
      this.entry(this.poolAccount(symbol), TARGET, "market_initial_issuance", symbol, SYSTEM_TREASURY_ACCOUNT);
      this.initialShares(symbol);
      return { symbol, funded: true, baseReserve: TARGET, noteReserve: TARGET };
    });
  }
  poolAccount(symbol) { return `note-pool:${symbol}`; }
  initialShares(symbol) {
    this.db.prepare("INSERT INTO note_positions VALUES (?,?,?)").run(symbol, "locked", 1000);
    this.db.prepare("INSERT INTO note_positions VALUES (?,?,?)").run(symbol, SYSTEM_TREASURY_ACCOUNT, TARGET - 1000);
  }
  history(symbol, interval = "24h", now = Date.now()) {
    const { period, candles } = require("./candles");
    this.pool(symbol); requireTradingSymbol(symbol);
    const [duration, bucket] = period(interval);
    const rows = this.db.prepare("SELECT id,side,amount,output,at FROM note_trades WHERE symbol=? AND at>=? AND at<=? ORDER BY at,id").all(symbol, now - duration, now);
    const points = new Map();
    for (const row of rows) points.set(Math.floor(row.at / bucket) * bucket, {
      at: Math.floor(row.at / bucket) * bucket,
      numerator: String(row.side === "buy" ? row.amount : row.output),
      denominator: String(row.side === "buy" ? row.output : row.amount),
    });
    return { symbol, currency: "FTHX", interval, from: now - duration, to: now, points: [...points.values()],
      candles: candles(rows.map(row => ({ at: row.at, base: row.side === "buy" ? row.output : row.amount,
        quote: row.side === "buy" ? row.amount : row.output })), bucket), source: "executed-trades" };
  }
  account(owner) {
    return {
      positions: this.db.prepare("SELECT symbol,shares FROM note_positions WHERE owner=? AND shares>0").all(owner),
      trades: this.db.prepare("SELECT id,symbol,side,amount,output,at FROM note_trades WHERE owner=? ORDER BY id DESC LIMIT 50").all(owner),
      liquidity: this.db.prepare("SELECT result,at FROM note_liquidity WHERE owner=? ORDER BY at DESC LIMIT 50").all(owner).map(row => ({ ...JSON.parse(row.result), at: row.at })),
    };
  }
  liquidityQuote(symbol, action, amount) {
    this.requireUnlocked();
    integer(amount, action === "add" ? "FTHX amount" : "Shares");
    if (!["add", "remove"].includes(action)) throw fail(400, "Choose add or remove liquidity.");
    const pool = this.pool(symbol); requireTradingSymbol(symbol);
    if (!pool.base) throw fail(409, "This market is unfunded. Authorized initial funding is required.");
    if (this.notes.balance(this.poolAccount(symbol), "FTHX") !== pool.base || this.notes.balance(this.poolAccount(symbol), symbol) !== pool.quote)
      throw fail(409, "Market reserves do not match ledger balances.");
    const total = this.db.prepare("SELECT SUM(shares) AS total FROM note_positions WHERE symbol=?").get(symbol).total;
    if (!Number.isSafeInteger(total) || total <= 0) throw fail(409, "Invalid liquidity shares.");
    const shares = action === "add" ? Number(BigInt(amount) * BigInt(total) / BigInt(pool.base)) : amount;
    if (!shares || (action === "remove" && shares >= total)) throw fail(400, "Invalid or insufficient liquidity amount.");
    const ceil = (a, b) => (a + b - 1n) / b;
    const base = action === "add" ? Number(ceil(BigInt(shares) * BigInt(pool.base), BigInt(total))) : Number(BigInt(shares) * BigInt(pool.base) / BigInt(total));
    const notes = action === "add" ? Number(ceil(BigInt(shares) * BigInt(pool.quote), BigInt(total))) : Number(BigInt(shares) * BigInt(pool.quote) / BigInt(total));
    if (!base || !notes || !Number.isSafeInteger(total + (action === "add" ? shares : 0))
      || !Number.isSafeInteger(pool.base + (action === "add" ? base : 0)) || !Number.isSafeInteger(pool.quote + (action === "add" ? notes : 0)))
      throw fail(400, "Liquidity amount is outside safe limits.");
    return { symbol, action, shares, base, notes };
  }
  liquidity(owner, input) {
    const { symbol, action, amount, base, notes, shares, requestId } = input || {};
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw fail(400, "A unique liquidity request ID is required.");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ symbol, action, amount, base, notes, shares })).digest("hex");
    return this.atomic(() => {
      const existing = this.db.prepare("SELECT * FROM note_liquidity WHERE owner=? AND request_id=?").get(owner, requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw fail(409, "Liquidity request ID is already used with different parameters.");
        return JSON.parse(existing.result);
      }
      const quote = this.liquidityQuote(symbol, action, amount);
      if (quote.base !== base || quote.notes !== notes || quote.shares !== shares) throw fail(409, "Liquidity changed. Request a new quote before confirming.");
      const position = this.db.prepare("SELECT shares FROM note_positions WHERE symbol=? AND owner=?").get(symbol, owner)?.shares || 0;
      if (action === "remove" && position < shares) throw fail(402, "Insufficient owned liquidity shares.");
      const sign = action === "add" ? 1 : -1, pool = this.pool(symbol), account = this.poolAccount(symbol);
      for (const [currency, value] of [["FTHX", base], [symbol, notes]]) {
        this.entry(owner, -sign * value, "market_liquidity_out", currency, account);
        this.entry(account, sign * value, "market_liquidity_in", currency, owner);
      }
      this.db.prepare("UPDATE note_markets SET base=?,quote=? WHERE symbol=?").run(pool.base + sign * base, pool.quote + sign * notes, symbol);
      this.db.prepare("INSERT INTO note_positions VALUES (?,?,?) ON CONFLICT(symbol,owner) DO UPDATE SET shares=excluded.shares").run(symbol, owner, position + sign * shares);
      this.db.prepare("INSERT INTO note_liquidity VALUES (?,?,?,?,?)").run(owner, requestId, fingerprint, JSON.stringify(quote), Date.now());
      return quote;
    });
  }
  entry(owner, amount, kind, symbol, other) {
    const balance = this.notes.balance(owner, symbol) + amount;
    if (!Number.isSafeInteger(balance) || balance < 0) throw fail(402, `Insufficient or invalid ${symbol} balance. Funding requires existing treasury FTHX; no FTHX is minted.`);
    this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES (?,?,?,?,?,'notes-market',?)")
      .run(owner.toLowerCase(), amount, kind, other, Date.now(), symbol);
  }
  quote(symbol, side, amount, internal = false) {
    if (!internal) this.requireUnlocked();
    integer(amount, "Trade amount");
    if (!["buy", "sell"].includes(side)) throw fail(400, "Choose buy or sell.");
    const pool = this.pool(symbol);
    requireTradingSymbol(symbol);
    if (!pool.base) throw fail(409, "This market is unfunded. Trading starts only after authorized treasury funding.");
    if (this.notes.balance(this.poolAccount(symbol), "FTHX") !== pool.base || this.notes.balance(this.poolAccount(symbol), symbol) !== pool.quote)
      throw fail(409, "Market reserves do not match ledger balances. Administrator recovery is required.");
    const reserveIn = BigInt(side === "buy" ? pool.base : pool.quote);
    const reserveOut = BigInt(side === "buy" ? pool.quote : pool.base);
    const net = BigInt(amount) * 9970n;
    const output = Number(net * reserveOut / (reserveIn * 10000n + net));
    if (output < 1 || output >= Number(reserveOut)) throw fail(400, "Trade amount is too small or liquidity is insufficient.");
    if (!Number.isSafeInteger(Number(reserveIn) + amount)) throw fail(409, "Pool exceeds safe unit limits.");
    return { symbol, side, amount, output, from: side === "buy" ? "FTHX" : symbol,
      to: side === "buy" ? symbol : "FTHX", feeBps: 30 };
  }
  trade(owner, input) {
    this.requireUnlocked();
    return this.atomic(() => { this.requireUnlocked(); return this.tradeInTransaction(owner, input); });
  }
  tradeInTransaction(owner, input) {
    const { symbol, side, amount, minOutput, requestId } = input || {};
    integer(minOutput, "Minimum output");
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw fail(400, "A unique trade request ID is required.");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ symbol, side, amount, minOutput })).digest("hex");
    {
      const existing = this.db.prepare("SELECT * FROM note_trades WHERE owner=? AND request_id=?").get(owner, requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw fail(409, "Trade request ID is already used with different parameters.");
        return { symbol: existing.symbol, side: existing.side, amount: existing.amount, output: existing.output, id: existing.id };
      }
      const quote = this.quote(symbol, side, amount, true);
      if (quote.output < minOutput) throw fail(409, "Price moved beyond your minimum output. Request a new quote.");
      const pool = this.pool(symbol), account = this.poolAccount(symbol);
      this.entry(owner, -amount, "market_trade_out", quote.from, account);
      this.entry(account, amount, "market_trade_in", quote.from, owner);
      this.entry(account, -quote.output, "market_trade_out", quote.to, owner);
      this.entry(owner, quote.output, "market_trade_in", quote.to, account);
      const base = pool.base + (side === "buy" ? amount : -quote.output);
      const note = pool.quote + (side === "buy" ? -quote.output : amount);
      this.db.prepare("UPDATE note_markets SET base=?,quote=? WHERE symbol=?").run(base, note, symbol);
      const result = this.db.prepare("INSERT INTO note_trades(owner,request_id,fingerprint,symbol,side,amount,output,volume,at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(owner, requestId, fingerprint, symbol, side, amount, quote.output, side === "buy" ? amount : quote.output, Date.now());
      return { symbol, side, amount, output: quote.output, id: Number(result.lastInsertRowid) };
    }
  }
}
module.exports = { Markets, PLACEHOLDERS, TARGET, isReservedSpecial, isReservedMarket };
