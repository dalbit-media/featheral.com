"use strict";
const crypto = require("node:crypto");
const { walletAccountId, transferMessage } = require("../fth-ledger/transfer");
const { isReservedMarket } = require("./markets");
const fail = (status, message) => Object.assign(new Error(message), { status });
const DOLLAR_POOL = `0x${crypto.createHash("sha256").update("featheral:exchange:dollar-pool").digest("hex")}`;
const ESCROW = `0x${crypto.createHash("sha256").update("featheral:exchange:escrow").digest("hex")}`;
const NOTE_POOL = "exchange:fth-dollar";
const ratio = (input, from, to) => input * 9970n * to / (from * 10000n + input * 9970n);
function amount(value, symbol) {
  if (typeof value !== "string" || !/^[1-9]\d{0,77}$/.test(value)) throw fail(400, "Enter a positive base-unit amount.");
  const n = BigInt(value);
  if (symbol !== "FTH$" && n > 1000000000n) throw fail(400, "Note amounts must not exceed 1,000,000,000 whole units.");
  return n;
}
class Exchange {
  constructor(creation) {
    this.creation = creation; this.markets = creation.markets; this.db = creation.db; this.busy = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dollar_note_pool(id INTEGER PRIMARY KEY CHECK(id=1),dollars TEXT NOT NULL,fthx INTEGER NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dollar_note_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,
        payload TEXT NOT NULL,payment TEXT,signature TEXT,status TEXT NOT NULL,settlement TEXT,error TEXT,at INTEGER NOT NULL,UNIQUE(owner,request_id));
      CREATE TABLE IF NOT EXISTS dollar_note_trades(id TEXT PRIMARY KEY,owner TEXT NOT NULL,from_symbol TEXT NOT NULL,to_symbol TEXT NOT NULL,
        amount TEXT NOT NULL,output TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS exchange_execution_order(sequence INTEGER PRIMARY KEY,source TEXT NOT NULL,reference TEXT NOT NULL,UNIQUE(source,reference));
      CREATE TABLE IF NOT EXISTS wallet_note_swaps(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,
        parameters TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(owner,request_id));
    `);
    if (!this.db.readOnlyReplica) this.db.exec("INSERT OR IGNORE INTO dollar_note_pool VALUES (1,'0',0,0)");
  }
  setDollar(adapter) { this.dollar = adapter; }
  swapQuote(input) {
    const { from, to } = input || {};
    if (from === to) throw fail(400, "Choose two different tokens.");
    if ([from, to].includes("FTH$")) return this.quote(input);
    this.assertReady();
    this.markets.requireUnlocked();
    const available = new Set(["FTHX", ...this.markets.catalog().filter(market => market.funded).map(market => market.symbol)]);
    if (!available.has(from) || !available.has(to)) throw fail(409, "Choose FTHX or a funded native note. Ethereum FTHG conversion is separate.");
    let output = Number(amount(input.amount, from));
    const legs = [];
    if (from !== "FTHX") { const leg = this.markets.quote(from, "sell", output); legs.push(leg); output = leg.output; }
    if (to !== "FTHX") { const leg = this.markets.quote(to, "buy", output); legs.push(leg); output = leg.output; }
    return { from, to, amount: input.amount, output: String(output), route: [from, ...(from !== "FTHX" && to !== "FTHX" ? ["FTHX"] : []), to],
      legs, hops: legs.length, feeBps: 30 };
  }
  prepareSwap(owner, input) {
    if (typeof input?.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw fail(400, "A unique swap request ID is required.");
    const noteRequest = this.db.prepare("SELECT parameters FROM wallet_note_swaps WHERE owner=? AND request_id=?").get(owner, input?.requestId || "");
    const dollarRequest = this.db.prepare("SELECT 1 FROM dollar_note_requests WHERE owner=? AND request_id=?").get(owner, input?.requestId || "");
    if ((noteRequest && [input?.from, input?.to].includes("FTH$")) || (dollarRequest && ![input?.from, input?.to].includes("FTH$")))
      throw fail(409, "Swap request ID already has different parameters.");
    if ([input?.from, input?.to].includes("FTH$")) return this.prepare(owner, input);
    const parameters = JSON.stringify({ from: input.from, to: input.to, amount: input.amount, minOutput: input.minOutput });
    const existing = this.db.prepare("SELECT * FROM wallet_note_swaps WHERE owner=? AND request_id=?").get(owner, input.requestId);
    if (existing) {
      if (existing.parameters !== parameters) throw fail(409, "Swap request ID already has different parameters.");
      return this.noteSwapView(existing);
    }
    const quote = this.swapQuote(input);
    if (BigInt(quote.output) < amount(input.minOutput, input.to)) throw fail(409, "Price moved below the minimum output. Request a new quote.");
    if (this.creation.notes.balance(owner, input.from) < Number(input.amount)) throw fail(402, `Insufficient ${input.from}.`);
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO wallet_note_swaps VALUES (?,?,?,?,?,'prepared',?)")
      .run(id, owner, input.requestId, parameters, JSON.stringify(quote), Date.now());
    return this.noteSwapView(this.db.prepare("SELECT * FROM wallet_note_swaps WHERE id=?").get(id));
  }
  noteSwapView(row) {
    return { id: row.id, requestId: row.request_id, status: row.status, ...JSON.parse(row.payload), parameters: JSON.parse(row.parameters) };
  }
  refreshSwap(owner, id) {
    const row = this.db.prepare("SELECT * FROM wallet_note_swaps WHERE id=? AND owner=?").get(id, owner);
    if (!row) return this.refresh(owner, id);
    return this.noteSwapView(row);
  }
  cancelSwap(owner, id) {
    const note = this.db.prepare("SELECT status FROM wallet_note_swaps WHERE id=? AND owner=?").get(id, owner);
    const row = note || this.db.prepare("SELECT status,payload FROM dollar_note_requests WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw fail(404, "Exchange request not found.");
    if (row.status !== "prepared" || (row.payload && JSON.parse(row.payload).parameters.funding))
      throw fail(409, "Only an unsubmitted swap can be discarded. Resume any pending settlement.");
    this.db.prepare(note ? "DELETE FROM wallet_note_swaps WHERE id=? AND owner=?" : "DELETE FROM dollar_note_requests WHERE id=? AND owner=?").run(id, owner);
    return { status: "cancelled", id };
  }
  async completeSwap(owner, id, signature) {
    if (!this.db.prepare("SELECT 1 FROM wallet_note_swaps WHERE id=? AND owner=?").get(id, owner)) return this.complete(owner, id, signature);
    return this.markets.atomic(() => {
      const row = this.db.prepare("SELECT * FROM wallet_note_swaps WHERE id=? AND owner=?").get(id, owner);
      if (row.status === "complete") return this.noteSwapView(row);
      const parameters = JSON.parse(row.parameters), quote = this.swapQuote(parameters);
      if (BigInt(quote.output) < BigInt(parameters.minOutput)) throw fail(409, "Price moved below the minimum output. Request a new quote.");
      for (const [index, leg] of quote.legs.entries()) this.markets.tradeInTransaction(owner, {
        symbol: leg.symbol, side: leg.side, amount: leg.amount, minOutput: leg.output, requestId: `swap-${id}-${index}`,
      });
      this.db.prepare("UPDATE wallet_note_swaps SET payload=?,status='complete' WHERE id=?").run(JSON.stringify(quote), id);
      return this.noteSwapView(this.db.prepare("SELECT * FROM wallet_note_swaps WHERE id=?").get(id));
    });
  }
  requireWriter() { if (!this.dollar) throw fail(503, "Dollar exchange settlement requires the configured Dollar writer and its original authorized signing key."); }
  assertReady() {
    if (this.trading?.db.prepare("SELECT 1 FROM trading_operations WHERE status='settling'").get())
      throw fail(409, "An Exchange trading withdrawal needs recovery before another Dollar operation.");
    if (this.db.prepare("SELECT 1 FROM dollar_note_requests WHERE status IN ('paying','paid','settling','awaiting_signature')").get())
      throw fail(409, "An exchange settlement needs recovery. Resume it before starting another Dollar transaction.");
  }
  pool() {
    const row = this.db.prepare("SELECT * FROM dollar_note_pool WHERE id=1").get();
    return { dollars: row.dollars, fthx: row.fthx, version: row.version, funded: BigInt(row.dollars) > 0n,
      settlementEnabled: !!this.dollar, dollarAccount: DOLLAR_POOL, quoteCurrency: "FTHX", feeBps: 30,
      pendingSettlement: !!this.db.prepare("SELECT 1 FROM dollar_note_requests WHERE status IN ('paying','paid','settling','awaiting_signature')").get()
        || !!this.trading?.db.prepare("SELECT 1 FROM trading_operations WHERE status='settling'").get() };
  }
  market(interval = "24h", now = Date.now()) {
    const { period, candles } = require("./candles");
    const [duration, bucket] = period(interval), pool = this.pool();
    const ready = pool.funded && pool.settlementEnabled && !pool.pendingSettlement;
    if (ready) this.validatePool(pool);
    const rows = this.db.prepare(`SELECT t.*,json_extract(r.payload,'$.intermediate') AS fthx,o.sequence
      FROM dollar_note_trades t JOIN dollar_note_requests r ON r.id=t.id
      LEFT JOIN exchange_execution_order o ON o.source='dollar' AND o.reference=t.id
      WHERE r.status='complete' AND t.at>=? AND t.at<=? ORDER BY t.at,t.id`).all(now - Math.max(duration, 86400000), now);
    let volumeFthx = 0n, volumeFthDollar = 0n, trades = 0;
    for (const row of rows) {
      const fthx = BigInt(row.fthx), dollars = BigInt(row.from_symbol === "FTH$" ? row.amount : row.output);
      if (row.at >= now - 86400000) { volumeFthx += fthx; volumeFthDollar += dollars; trades++; }
    }
    const notes = ["FTH$", "FTHX"].map(symbol => {
      const dollar = symbol === "FTH$", currency = dollar ? "FTHX" : "FTH$";
      const executions = rows.filter(row => row.at >= now - duration).map(row => {
        const dollars = BigInt(row.from_symbol === "FTH$" ? row.amount : row.output), fthx = BigInt(row.fthx) * 10n ** 18n;
        return { at: row.at, sequence: row.sequence || 0, base: dollar ? dollars : fthx, quote: dollar ? fthx : dollars };
      });
      if (this.trading) executions.push(...this.trading.executions(now - duration, now).map(row => {
        const dollars = BigInt(row.side === "buy" ? row.output : row.amount), fthx = BigInt(row.side === "buy" ? row.amount : row.output) * 10n ** 18n;
        return { at: row.at, sequence: row.sequence, base: dollar ? dollars : fthx, quote: dollar ? fthx : dollars };
      }));
      executions.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      return { symbol, funded: ready, pendingSettlement: pool.pendingSettlement, quoteCurrency: currency,
        price: ready ? { numerator: dollar ? (BigInt(pool.fthx) * 10n ** 18n).toString() : pool.dollars,
          denominator: dollar ? pool.dollars : (BigInt(pool.fthx) * 10n ** 18n).toString(), currency } : null,
        history: { symbol, currency, interval, from: now - duration, to: now,
          points: candles(executions, bucket).map(candle => ({ at: candle.at, ...candle.close })),
          candles: candles(executions, bucket), source: "executed-trades" } };
    });
    for (const row of this.trading?.executions(now - 86400000, now) || []) {
      volumeFthx += BigInt(row.side === "buy" ? row.amount : row.output);
      volumeFthDollar += BigInt(row.side === "buy" ? row.output : row.amount); trades++;
    }
    return { pair: "FTH$/FTHX", referencePrice: pool.funded && !ready ? null : require("./exchange-price").publicReference(pool),
      volumeFthx: volumeFthx.toString(), volumeFthDollar: volumeFthDollar.toString(), trades, notes };
  }
  validatePool(pool) {
    const custody = this.trading ? this.trading.dollarLiability() : 0n;
    if (BigInt(this.dollar.balance(DOLLAR_POOL).available) !== BigInt(pool.dollars) + custody || this.creation.notes.balance(NOTE_POOL) !== pool.fthx)
      throw fail(409, "Dollar pool reserves do not match authoritative ledgers. Administrator recovery is required.");
  }
  quote(input) {
    this.requireWriter(); this.assertReady();
    const { from, to } = input || {};
    if (from === to || ![from, to].includes("FTH$")) throw fail(400, "Choose FTH$ and a different network note.");
    const note = from === "FTH$" ? to : from;
    if (typeof note !== "string" || isReservedMarket(note)) throw fail(400, "Choose an available network note.");
    const pool = this.pool();
    if (!pool.funded) throw fail(409, "FTH$/FTHX pool is unfunded. Swaps remain disabled until explicitly funded.");
    this.validatePool(pool);
    const inputAmount = amount(input.amount, from), buying = from === "FTH$";
    let output = inputAmount, noteQuote = null;
    if (!buying && note !== "FTHX") { noteQuote = this.markets.quote(note, "sell", Number(inputAmount)); output = BigInt(noteQuote.output); }
    const intermediate = buying
      ? ratio(output, BigInt(pool.dollars), BigInt(pool.fthx))
      : output;
    output = buying ? intermediate : ratio(output, BigInt(pool.fthx), BigInt(pool.dollars));
    if (buying && note !== "FTHX") {
      if (intermediate > 1000000000n) throw fail(400, "Routed amount exceeds note limits.");
      noteQuote = this.markets.quote(note, "buy", Number(intermediate)); output = BigInt(noteQuote.output);
    }
    if (output < 1n || intermediate < 1n) throw fail(400, "Amount is too small for available liquidity.");
    if (buying && !Number.isSafeInteger(pool.fthx - Number(intermediate))) throw fail(409, "Invalid pool reserves.");
    if (!buying && !Number.isSafeInteger(pool.fthx + Number(intermediate))) throw fail(409, "Pool exceeds safe note limits.");
    return { from, to, amount: input.amount, output: output.toString(), intermediate: intermediate.toString(),
      route: note === "FTHX" ? [from, to] : [from, "FTHX", to], feeBps: 30, hops: note === "FTHX" ? 1 : 2,
      version: pool.version, noteQuote };
  }
  view(row) {
    const payload = JSON.parse(row.payload), payment = row.payment ? JSON.parse(row.payment) : null;
    return { id: row.id, requestId: row.request_id, status: row.status, ...payload, payment,
      message: payment ? transferMessage(payment) : null, error: row.error };
  }
  refresh(owner, id) {
    const row = this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw fail(404, "Exchange request not found.");
    const { parameters } = JSON.parse(row.payload);
    return this.prepare(owner, { ...parameters, requestId: row.request_id }, parameters.funding);
  }
  prepare(owner, input, funding = false) {
    this.requireWriter();
    if (typeof input?.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw fail(400, "A unique request ID is required.");
    const existing = this.db.prepare("SELECT * FROM dollar_note_requests WHERE owner=? AND request_id=?").get(owner, input.requestId);
    const parameters = funding ? { funding: true, dollars: input.dollars, fthx: input.fthx, approval: input.approval }
      : { funding: false, from: input.from, to: input.to, amount: input.amount, minOutput: input.minOutput };
    if (existing) {
      if (JSON.stringify(JSON.parse(existing.payload).parameters) !== JSON.stringify(parameters)) throw fail(409, "Request ID already used with different parameters.");
      if (existing.status !== "prepared") return this.view(existing);
    }
    this.assertReady();
    if (!existing && this.db.prepare("SELECT COUNT(*) AS n FROM dollar_note_requests WHERE owner=? AND status='prepared'").get(owner).n >= 3)
      throw fail(409, "Finish prepared exchange requests before reserving another.");
    const pool = this.pool();
    let quote;
    if (funding) {
      const dollars = amount(input.dollars, "FTH$"), fthx = amount(input.fthx, "FTHX");
      if (input.approval !== `FUND FTH$ ${dollars} BASE_UNITS ${fthx} FTHX`) throw fail(400, "Exact initial pool funding approval is required.");
      if (pool.funded) throw fail(409, "Dollar pool is already funded.");
      if (this.creation.notes.balance(owner) < Number(fthx)) throw fail(402, "Insufficient existing FTHX for funding.");
      quote = { from: "FTH$", to: "FTHX", amount: dollars.toString(), output: "0", intermediate: fthx.toString(), version: pool.version };
    } else {
      quote = this.quote(input);
      const minimum = amount(input.minOutput, input.to);
      if (BigInt(quote.output) < minimum) throw fail(409, "Quote is below your minimum output.");
      if (quote.from !== "FTH$" && this.creation.notes.balance(owner, quote.from) < Number(BigInt(quote.amount)))
        throw fail(402, `Insufficient ${quote.from}.`);
    }
    const id = existing?.id || crypto.randomUUID();
    let payment = quote.from === "FTH$" ? {
      wallet: this.creation.address(owner), to: ESCROW, amount: quote.amount, nonce: this.dollar.nonce(walletAccountId(owner)) + 1,
      memo: `exchange:${id}`, issuedAt: new Date().toISOString(),
    } : null;
    if (existing?.payment && !this.dollar.conflict(JSON.parse(existing.payment))) payment = JSON.parse(existing.payment);
    if (payment && BigInt(this.dollar.balance(walletAccountId(owner)).available) < BigInt(payment.amount)) throw fail(402, "Insufficient real FTH$.");
    if (existing) this.db.prepare("UPDATE dollar_note_requests SET payload=?,payment=?,error=NULL WHERE id=?")
      .run(JSON.stringify({ ...quote, parameters }), payment ? JSON.stringify(payment) : null, id);
    else this.db.prepare("INSERT INTO dollar_note_requests(id,owner,request_id,payload,payment,status,at) VALUES (?,?,?,?,?,'prepared',?)")
      .run(id, owner, input.requestId, JSON.stringify({ ...quote, parameters }), payment ? JSON.stringify(payment) : null, Date.now());
    return this.view(this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=?").get(id));
  }
  async complete(owner, id, signature) {
    this.requireWriter();
    if (this.busy) throw fail(409, "Exchange is processing a settlement. Retry shortly.");
    this.busy = true;
    try { return await this.finish(owner, id, signature); }
    catch (error) {
      this.db.prepare("UPDATE dollar_note_requests SET error=? WHERE id=? AND owner=?").run(error.message, id, owner);
      throw error;
    }
    finally { this.busy = false; }
  }
  async finish(owner, id, signature) {
    let row = this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw fail(404, "Exchange request not found.");
    if (row.status === "complete") return this.view(row);
    const payload = JSON.parse(row.payload), { parameters } = payload;
    if (row.status === "awaiting_signature") {
      const payment = { ...JSON.parse(row.payment), signature };
      if (this.dollar.verify(payment).wallet.toLowerCase() !== owner) throw fail(403, "Payment signature must belong to your wallet.");
      this.db.prepare("UPDATE dollar_note_requests SET status='paying',signature=? WHERE id=?").run(signature, id);
      row.status = "paying"; row.signature = signature;
    }
    if (row.status === "prepared") {
      this.assertReady();
      const pool = this.pool();
      if (pool.version !== payload.version) throw fail(409, "Pool changed. Create a new quote.");
      if (!parameters.funding) {
        const current = this.quote(parameters);
        if (current.output !== payload.output || JSON.stringify(current.noteQuote) !== JSON.stringify(payload.noteQuote))
          throw fail(409, "Routed pool changed. Create a new quote.");
      } else if (pool.funded) throw fail(409, "Pool is already funded.");
      if (row.payment) {
        const payment = { ...JSON.parse(row.payment), signature };
        if (this.dollar.verify(payment).wallet.toLowerCase() !== owner) throw fail(403, "Payment signature must belong to your wallet.");
        if (this.dollar.conflict(payment)) throw fail(409, "Payment nonce changed. Prepare a new request.");
      }
      this.markets.atomic(() => {
        this.assertReady();
        if (this.pool().version !== payload.version) throw fail(409, "Pool changed. Refresh the request before signing again.");
        // Reserve only the input notes; no output is visible before Dollar payment seals.
        if (parameters.funding || payload.from !== "FTH$") {
          const symbol = parameters.funding ? "FTHX" : payload.from;
          const value = parameters.funding ? Number(payload.intermediate) : Number(payload.amount);
          this.markets.entry(owner, -value, "exchange_reserve_out", symbol, id);
          this.markets.entry(`exchange-request:${id}`, value, "exchange_reserve_in", symbol, owner);
        }
        this.db.prepare("UPDATE dollar_note_requests SET status=?,signature=? WHERE id=?").run(row.payment ? "paying" : "paid", signature || null, id);
      });
      row = this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=?").get(id);
    }
    if (row.status === "paying") {
      if (this.dollar.conflict(JSON.parse(row.payment))) {
        const payment = JSON.parse(row.payment);
        payment.nonce = this.dollar.nonce(walletAccountId(owner)) + 1; payment.issuedAt = new Date().toISOString();
        this.db.prepare("UPDATE dollar_note_requests SET status='awaiting_signature',payment=?,signature=NULL WHERE id=?").run(JSON.stringify(payment), id);
        throw fail(409, "Another transfer consumed this nonce. Refresh and resume to sign the replacement payment; reserved notes are retained.");
      }
      await this.dollar.submit({ ...JSON.parse(row.payment), signature: row.signature });
      this.db.prepare("UPDATE dollar_note_requests SET status='paid',error=NULL WHERE id=?").run(id);
      row.status = "paid";
    }
    if (row.status === "paid") {
      this.markets.atomic(() => {
        if (this.db.prepare("SELECT status FROM dollar_note_requests WHERE id=?").get(id).status !== "paid") return;
        const pool = this.pool(), buying = payload.from === "FTH$", intermediate = Number(payload.intermediate);
        const reserved = `exchange-request:${id}`;
        if (parameters.funding) {
          this.markets.entry(reserved, -intermediate, "exchange_funding_out", "FTHX", NOTE_POOL);
          this.markets.entry(NOTE_POOL, intermediate, "exchange_funding_in", "FTHX", owner);
        } else if (buying) {
          this.markets.entry(NOTE_POOL, -intermediate, "exchange_swap_out", "FTHX", owner);
          this.markets.entry(owner, intermediate, "exchange_swap_in", "FTHX", NOTE_POOL);
          if (payload.to !== "FTHX") this.markets.tradeInTransaction(owner, {
            symbol: payload.to, side: "buy", amount: intermediate, minOutput: Number(payload.output), requestId: `route-${id}`,
          });
        } else {
          this.markets.entry(reserved, -Number(payload.amount), "exchange_release_out", payload.from, owner);
          this.markets.entry(owner, Number(payload.amount), "exchange_release_in", payload.from, reserved);
          if (payload.from !== "FTHX") this.markets.tradeInTransaction(owner, {
            symbol: payload.from, side: "sell", amount: Number(payload.amount), minOutput: intermediate, requestId: `route-${id}`,
          });
          this.markets.entry(owner, -intermediate, "exchange_swap_out", "FTHX", NOTE_POOL);
          this.markets.entry(NOTE_POOL, intermediate, "exchange_swap_in", "FTHX", owner);
        }
        const dollars = parameters.funding ? payload.amount : (BigInt(pool.dollars) + (buying ? BigInt(payload.amount) : -BigInt(payload.output))).toString();
        const fthx = parameters.funding ? intermediate : pool.fthx + (buying ? -intermediate : intermediate);
        this.db.prepare("UPDATE dollar_note_pool SET dollars=?,fthx=?,version=version+1 WHERE id=1").run(dollars, fthx);
        const entries = buying ? [{ account: ESCROW, delta: `-${payload.amount}` }, { account: DOLLAR_POOL, delta: payload.amount }]
          : [{ account: DOLLAR_POOL, delta: `-${payload.output}` }, { account: walletAccountId(owner), delta: payload.output }];
        const tx = this.dollar.prepareSettlement(id, entries);
        this.db.prepare("UPDATE dollar_note_requests SET status='settling',settlement=?,error=NULL WHERE id=?").run(JSON.stringify(tx), id);
        if (!parameters.funding) {
          this.db.prepare("INSERT INTO dollar_note_trades VALUES (?,?,?,?,?,?,?)")
            .run(id, owner, payload.from, payload.to, payload.amount, payload.output, Date.now());
          this.db.prepare("INSERT INTO exchange_execution_order(source,reference) VALUES ('dollar',?)").run(id);
        }
      });
      row = this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=?").get(id);
    }
    if (row.status === "settling") {
      this.dollar.commitSettlement(JSON.parse(row.settlement));
      this.db.prepare("UPDATE dollar_note_requests SET status='complete',error=NULL WHERE id=?").run(id);
    }
    return this.view(this.db.prepare("SELECT * FROM dollar_note_requests WHERE id=?").get(id));
  }
  account(owner) {
    return { requests: [...this.db.prepare("SELECT * FROM dollar_note_requests WHERE owner=? AND status!='complete' ORDER BY at").all(owner).map(row => this.view(row)),
      ...this.db.prepare("SELECT * FROM wallet_note_swaps WHERE owner=? AND status!='complete' ORDER BY at").all(owner).map(row => this.noteSwapView(row))],
      trades: this.db.prepare(`SELECT t.id,t.from_symbol AS "from",t.to_symbol AS "to",t.amount,t.output,t.at
        FROM dollar_note_trades t JOIN dollar_note_requests r ON r.id=t.id
        WHERE t.owner=? AND r.status='complete' ORDER BY t.at DESC LIMIT 50`).all(owner) };
  }
  async recover() {
    for (const row of this.db.prepare("SELECT * FROM dollar_note_requests WHERE status IN ('paying','paid','settling') ORDER BY at").all()) {
      try { await this.complete(row.owner, row.id, row.signature); }
      catch (error) { this.db.prepare("UPDATE dollar_note_requests SET error=? WHERE id=?").run(error.message, row.id); console.error(`Dollar exchange ${row.id} needs recovery: ${error.message}`); }
    }
  }
  walletTrades(owner) {
    const dollars = this.db.prepare(`SELECT t.*,json_extract(r.payload,'$.intermediate') AS intermediate
      FROM dollar_note_trades t JOIN dollar_note_requests r ON r.id=t.id
      WHERE t.owner=? AND r.status='complete' ORDER BY t.at DESC LIMIT 50`).all(owner).map(row => {
      const buying = row.from_symbol !== "FTH$";
      return { id: row.id, symbol: "FTH$", side: buying ? "buy" : "sell",
        amount: buying ? row.intermediate : row.amount, output: buying ? row.output : row.intermediate, at: row.at };
    });
    return [...dollars, ...this.markets.account(owner).trades].sort((a, b) => b.at - a.at).slice(0, 50);
  }
}
module.exports = { Exchange, DOLLAR_POOL, ESCROW };
