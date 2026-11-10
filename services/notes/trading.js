"use strict";
const crypto = require("node:crypto");
const { walletAccountId } = require("../fth-ledger/transfer");
const { DOLLAR_POOL } = require("./exchange");
const fail = (status, message) => Object.assign(new Error(message), { status });
function positive(value, dollar = false) {
  if (typeof value !== "string" || !/^[1-9]\d{0,77}$/.test(value)
    || !dollar && BigInt(value) > 1000000000n) throw fail(400, "Enter a positive base-unit amount within trading limits.");
  return BigInt(value);
}
class Trading {
  constructor(creation, exchange) {
    this.creation = creation; this.exchange = exchange; this.db = creation.db; this.markets = creation.markets;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_dollars(owner TEXT PRIMARY KEY,balance TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trading_operations(owner TEXT NOT NULL,request TEXT NOT NULL,fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,symbol TEXT NOT NULL,amount TEXT NOT NULL,result TEXT NOT NULL,status TEXT NOT NULL,settlement TEXT,at INTEGER NOT NULL,
        PRIMARY KEY(owner,request));
      CREATE TABLE IF NOT EXISTS trading_dollar_trades(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,side TEXT NOT NULL,
        amount TEXT NOT NULL,output TEXT NOT NULL,at INTEGER NOT NULL);
    `);
    if (!this.db.readOnlyReplica) this.db.exec("CREATE INDEX IF NOT EXISTS trading_dollar_activity_time ON trading_dollar_trades(at DESC,id DESC)");
    exchange.trading = this;
  }
  custody(owner) { return `exchange-trading:${owner}`; }
  dollarBalance(owner) { return BigInt(this.db.prepare("SELECT balance FROM trading_dollars WHERE owner=?").get(owner)?.balance || "0"); }
  dollarLiability() {
    let value = this.db.prepare("SELECT balance FROM trading_dollars").all().reduce((sum, row) => sum + BigInt(row.balance), 0n);
    for (const row of this.db.prepare("SELECT amount FROM trading_operations WHERE status='settling'").all()) value += BigInt(row.amount);
    return value;
  }
  setDollars(owner, balance) {
    if (balance < 0n) throw fail(402, "Insufficient trading FTH$.");
    this.db.prepare("INSERT INTO trading_dollars VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET balance=excluded.balance").run(owner, balance.toString());
  }
  holdings(owner) {
    const result = this.db.prepare("SELECT symbol,SUM(amount) AS balance FROM notes_entries WHERE address=? GROUP BY symbol HAVING SUM(amount)>0")
      .all(this.custody(owner)).map(row => {
        if (!Number.isSafeInteger(row.balance)) throw fail(409, "Trading note balance exceeds safe limits.");
        return { symbol: row.symbol, balance: String(row.balance) };
      });
    const dollars = this.dollarBalance(owner);
    if (dollars > 0n) result.push({ symbol: "FTH$", balance: dollars.toString() });
    return result;
  }
  account(owner) {
    return { holdings: this.holdings(owner), depositCurrency: "FTHX",
      trades: [...this.markets.account(this.custody(owner)).trades, ...this.db.prepare("SELECT id,'FTH$' AS symbol,side,amount,output,at FROM trading_dollar_trades WHERE owner=? ORDER BY at DESC LIMIT 50").all(owner)]
        .sort((a, b) => b.at - a.at).slice(0, 50),
      movements: this.db.prepare("SELECT request,kind,symbol,amount,status,at FROM trading_operations WHERE owner=? AND kind!='trade' ORDER BY at DESC LIMIT 50").all(owner) };
  }
  operation(owner, requestId) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))
      throw fail(400, "A unique Exchange request ID is required.");
    const row = this.db.prepare("SELECT * FROM trading_operations WHERE owner=? AND request=?").get(owner, requestId);
    if (!row) throw fail(404, "Exchange operation not found.");
    return { requestId: row.request, kind: row.kind, symbol: row.symbol, amount: row.amount,
      status: row.status, result: row.status === "complete" ? JSON.parse(row.result) : null, at: row.at };
  }
  portfolioHoldings(owner, holdings) {
    const totals = new Map(holdings.map(asset => [asset.symbol, BigInt(asset.balance)]));
    for (const asset of this.holdings(owner)) totals.set(asset.symbol, (totals.get(asset.symbol) || 0n) + BigInt(asset.balance));
    return [...totals].map(([symbol, balance]) => ({ symbol, balance: balance.toString() }));
  }
  ready() {
    this.exchange.assertReady();
    if (this.db.prepare("SELECT 1 FROM trading_operations WHERE status='settling'").get())
      throw fail(409, "An Exchange withdrawal needs recovery. Resume it before trading.");
  }
  prior(owner, input, kind) {
    if (typeof input?.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))
      throw fail(400, "A unique Exchange request ID is required.");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ kind, symbol: input.symbol,
      side: input.side, amount: input.amount, minOutput: input.minOutput })).digest("hex");
    const row = this.db.prepare("SELECT * FROM trading_operations WHERE owner=? AND request=?").get(owner, input.requestId);
    if (row && row.fingerprint !== fingerprint) throw fail(409, "Exchange request ID already has different parameters.");
    return { fingerprint, row };
  }
  record(owner, input, kind, fingerprint, result, settlement = null) {
    this.db.prepare("INSERT INTO trading_operations VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(owner, input.requestId, fingerprint, kind, input.symbol || "FTHX", input.amount, JSON.stringify(result),
        settlement ? "settling" : "complete", settlement ? JSON.stringify(settlement) : null, Date.now());
    return result;
  }
  deposit(owner, input) {
    const { fingerprint, row } = this.prior(owner, input, "deposit");
    if (row) return JSON.parse(row.result);
    if (input.symbol !== "FTHX") throw fail(400, "Exchange trading deposits accept FTHX only.");
    const amount = Number(positive(input.amount));
    return this.markets.atomic(() => {
      this.ready();
      this.markets.entry(owner, -amount, "trading_deposit_out", "FTHX", this.custody(owner));
      this.markets.entry(this.custody(owner), amount, "trading_deposit_in", "FTHX", owner);
      return this.record(owner, input, "deposit", fingerprint, { symbol: "FTHX", amount: input.amount, status: "complete" });
    });
  }
  quote(input) {
    this.ready();
    if (input?.symbol !== "FTH$") {
      const amount = Number(positive(input?.amount));
      return { ...this.markets.quote(input?.symbol, input?.side, amount), amount: input.amount };
    }
    this.exchange.requireWriter();
    if (!["buy", "sell"].includes(input.side)) throw fail(400, "Choose buy or sell.");
    const buying = input.side === "buy", amount = positive(input.amount, !buying), pool = this.exchange.pool();
    if (!pool.funded) throw fail(409, "FTH$/FTHX pool is unfunded. An opening estimate is not executable liquidity.");
    this.exchange.validatePool(pool);
    const from = buying ? BigInt(pool.fthx) : BigInt(pool.dollars), to = buying ? BigInt(pool.dollars) : BigInt(pool.fthx);
    const output = amount * 9970n * to / (from * 10000n + amount * 9970n);
    if (output <= 0n || output >= to) throw fail(400, "Amount is too small or liquidity is insufficient.");
    if (BigInt(pool.fthx) + (buying ? amount : -output) > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail(409, "Pool exceeds safe note limits.");
    return { symbol: "FTH$", side: input.side, amount: input.amount, output: output.toString(),
      from: buying ? "FTHX" : "FTH$", to: buying ? "FTH$" : "FTHX", feeBps: 30 };
  }
  trade(owner, input) {
    const { fingerprint, row } = this.prior(owner, input, "trade");
    if (row) return JSON.parse(row.result);
    return this.markets.atomic(() => {
      const quote = this.quote(input), output = BigInt(quote.output);
      if (output < positive(input.minOutput, quote.to === "FTH$")) throw fail(409, "Price moved beyond the minimum output. Refresh the quote.");
      let result;
      if (input.symbol !== "FTH$") {
        result = this.markets.tradeInTransaction(this.custody(owner), { ...input, amount: Number(input.amount), minOutput: Number(input.minOutput) });
      } else {
        const buying = input.side === "buy", pool = this.exchange.pool(), amount = BigInt(input.amount), custody = this.custody(owner);
        this.setDollars(owner, this.dollarBalance(owner) + (buying ? output : -amount));
        this.markets.entry(custody, buying ? -Number(amount) : Number(output), "trading_swap", "FTHX", "exchange:fth-dollar");
        this.markets.entry("exchange:fth-dollar", buying ? Number(amount) : -Number(output), "trading_swap", "FTHX", custody);
        this.db.prepare("UPDATE dollar_note_pool SET dollars=?,fthx=?,version=version+1 WHERE id=1")
          .run((BigInt(pool.dollars) + (buying ? -output : amount)).toString(), pool.fthx + (buying ? Number(amount) : -Number(output)));
        const inserted = this.db.prepare("INSERT INTO trading_dollar_trades(owner,side,amount,output,at) VALUES (?,?,?,?,?)")
          .run(owner, input.side, input.amount, output.toString(), Date.now());
        this.db.prepare("INSERT INTO exchange_execution_order(source,reference) VALUES ('trading',?)").run(String(inserted.lastInsertRowid));
        this.exchange.validatePool(this.exchange.pool());
        result = { ...quote, id: Number(inserted.lastInsertRowid) };
      }
      return this.record(owner, input, "trade", fingerprint, result);
    });
  }
  withdraw(owner, input) {
    const { fingerprint, row } = this.prior(owner, input, "withdraw");
    if (row) return row.status === "settling" ? this.finish(row) : JSON.parse(row.result);
    const amount = positive(input.amount, input.symbol === "FTH$");
    if (input.symbol !== "FTH$" && !this.holdings(owner).some(asset => asset.symbol === input.symbol))
      throw fail(400, "Choose an asset held in your trading account.");
    const result = this.markets.atomic(() => {
      this.ready();
      const result = { symbol: input.symbol, amount: input.amount, status: "complete" };
      let settlement;
      if (input.symbol === "FTH$") {
        this.exchange.requireWriter(); this.exchange.validatePool(this.exchange.pool());
        this.setDollars(owner, this.dollarBalance(owner) - amount);
        const id = "trading-" + crypto.createHash("sha256").update(owner + ":" + input.requestId).digest("hex");
        settlement = this.exchange.dollar.prepareSettlement(id, [{ account: DOLLAR_POOL, delta: (-amount).toString() },
          { account: walletAccountId(owner), delta: amount.toString() }]);
      } else {
        this.markets.entry(this.custody(owner), -Number(amount), "trading_withdraw_out", input.symbol, owner);
        this.markets.entry(owner, Number(amount), "trading_withdraw_in", input.symbol, this.custody(owner));
      }
      return this.record(owner, input, "withdraw", fingerprint, result, settlement);
    });
    const pending = this.db.prepare("SELECT * FROM trading_operations WHERE owner=? AND request=?").get(owner, input.requestId);
    return pending.status === "settling" ? this.finish(pending) : result;
  }
  finish(row) {
    this.exchange.requireWriter();
    this.exchange.dollar.commitSettlement(JSON.parse(row.settlement));
    this.db.prepare("UPDATE trading_operations SET status='complete' WHERE owner=? AND request=?").run(row.owner, row.request);
    return JSON.parse(row.result);
  }
  recover() {
    for (const row of this.db.prepare("SELECT * FROM trading_operations WHERE status='settling' ORDER BY at").all()) this.finish(row);
  }
  executions(from, to) {
    return this.db.prepare(`SELECT t.id,t.side,t.amount,t.output,t.at,o.sequence FROM trading_dollar_trades t
      JOIN exchange_execution_order o ON o.source='trading' AND o.reference=CAST(t.id AS TEXT)
      WHERE t.at>=? AND t.at<=? ORDER BY t.at,o.sequence`).all(from, to);
  }
}
module.exports = { Trading };
