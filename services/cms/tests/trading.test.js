"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { ethers } = require("ethers");
const { Notes } = require("../../notes-api/ledger");
const { Creation } = require("../../notes-api/creation");
const { Exchange, DOLLAR_POOL } = require("../../notes-api/exchange");
const { Trading } = require("../../notes-api/trading");
const { createDollarApi } = require("../../notes-api/dollar");
const { walletAccountId } = require("../../fth-ledger/transfer");
const { SYSTEM_TREASURY_ACCOUNT } = require("../../dollar-api/funds");
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exchange-trading-")), notes = new Notes(path.join(root, "notes.sqlite"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const api = createDollarApi({ exchangeSigningKey: privateKey, env: { FTH_LEDGER_MODE: "writer", FTH_LEDGER_DIR: path.join(root, "dollar"),
    FTH_LEDGER_BLOCK_INTERVAL_MS: "0", FTH_GAME_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString() } });
  const creation = new Creation(notes, { list: () => [] }), exchange = new Exchange(creation), trading = new Trading(creation, exchange);
  exchange.setDollar(api.exchangeSettlement);
  const wallet = ethers.Wallet.createRandom(), owner = wallet.address.toLowerCase(), other = ethers.Wallet.createRandom().address.toLowerCase();
  for (const address of [owner, SYSTEM_TREASURY_ACCOUNT])
    notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,2000000,'fixture',0,'test')").run(address);
  await api.ledger.submit({ id: "fixture-dollar", kind: "CREDIT", account: walletAccountId(owner), amount: ethers.parseUnits("10000", 18).toString(),
    data: { src: "FthgConverted", tx: `0x${"ab".repeat(32)}` } });
  const request = exchange.prepare(owner, { requestId: "initial-funding-0001", dollars: ethers.parseUnits("1000", 18).toString(),
    fthx: "100000", approval: `FUND FTH$ ${ethers.parseUnits("1000", 18)} BASE_UNITS 100000 FTHX` }, true);
  await exchange.complete(owner, request.id, await wallet.signMessage(request.message));
  creation.markets.fund("FTHA", "FUND FTHA 1000000 FTHX 1000000 NOTES");
  t.after(() => { api.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const supply = () => ({ dollar: api.ledger.summary().supply,
    notes: notes.db.prepare("SELECT symbol,SUM(amount) AS supply FROM notes_entries GROUP BY symbol ORDER BY symbol").all() });
  const order = (symbol, side, amount, requestId) => {
    const quote = trading.quote({ symbol, side, amount });
    return trading.trade(owner, { symbol, side, amount, minOutput: String(quote.output), requestId });
  };
  return { notes, creation, exchange, trading, api, owner, other, supply, order };
}
test("Exchange accepts only existing FTHX deposits and trades from isolated custody with asset withdrawals", async t => {
  const { notes, creation, trading, owner, other, supply, order } = await fixture(t);
  const initial = supply(), walletBalance = notes.balance(owner);
  assert.throws(() => trading.deposit(owner, { symbol: "FTHA", amount: "20", requestId: "reject-note-deposit-01" }), /FTHX only/);
  assert.throws(() => order("FTHA", "buy", "100", "no-trading-deposit-01"), /Insufficient/);
  const deposit = { symbol: "FTHX", amount: "10000", requestId: "trading-deposit-00001" };
  trading.deposit(owner, deposit); trading.deposit(owner, deposit);
  assert.equal(notes.balance(owner), walletBalance - 10000);
  assert.equal(trading.holdings(owner)[0].balance, "10000");
  assert.throws(() => trading.deposit(owner, { ...deposit, amount: "1" }), /different parameters/);
  const bought = order("FTHA", "buy", "1000", "trading-buy-note-0001");
  assert.equal(notes.balance(owner, "FTHA"), 0);
  assert.equal(notes.balance(trading.custody(owner), "FTHA"), bought.output);
  assert.throws(() => trading.withdraw(other, { symbol: "FTHA", amount: "1", requestId: "foreign-withdraw-0001" }), /held/);
  const withdraw = { symbol: "FTHA", amount: String(bought.output), requestId: "trading-withdraw-0001" };
  trading.withdraw(owner, withdraw); trading.withdraw(owner, withdraw);
  assert.equal(notes.balance(owner, "FTHA"), bought.output);
  assert.equal(notes.balance(trading.custody(owner), "FTHA"), 0);
  assert.deepEqual(supply(), initial);
  const history = creation.markets.history("FTHA");
  assert.equal(history.candles.length, 1);
  assert.equal(history.candles[0].quoteVolume, "1000");
  assert.equal(history.candles[0].baseVolume, String(bought.output));
});
test("Dollar custody is fully backed by existing pool funds, dynamically priced and withdrawable exactly once", async t => {
  const { trading, exchange, api, owner, supply, order } = await fixture(t);
  const initial = supply(), poolBefore = exchange.pool(), walletBefore = api.ledger.balance(walletAccountId(owner)).available;
  trading.deposit(owner, { symbol: "FTHX", amount: "10000", requestId: "dollar-trading-deposit1" });
  const bought = order("FTH$", "buy", "1000", "trading-buy-dollar001");
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, walletBefore);
  assert.equal(trading.dollarBalance(owner), BigInt(bought.output));
  assert.equal(BigInt(api.ledger.balance(DOLLAR_POOL).available), BigInt(exchange.pool().dollars) + trading.dollarLiability());
  assert.notEqual(exchange.pool().dollars, poolBefore.dollars);
  assert.doesNotThrow(() => exchange.validatePool(exchange.pool()));
  const chart = exchange.market().notes[0].history.candles;
  assert.equal(chart[0].quoteVolume, ethers.parseUnits("1000", 18).toString());
  assert.equal(exchange.market().volumeFthx, "1000");
  const withdrawal = { symbol: "FTH$", amount: bought.output, requestId: "withdraw-acquired-dollar1" };
  trading.withdraw(owner, withdrawal); trading.withdraw(owner, withdrawal);
  assert.equal(trading.dollarBalance(owner), 0n);
  assert.equal(BigInt(api.ledger.balance(walletAccountId(owner)).available), BigInt(walletBefore) + BigInt(bought.output));
  assert.doesNotThrow(() => exchange.validatePool(exchange.pool()));
  assert.deepEqual(supply(), initial);
});
test("Trading enforces slippage, balances and rollback, and shares funded pool pricing with legacy settlement", async t => {
  const { trading, exchange, owner, supply, order } = await fixture(t);
  trading.deposit(owner, { symbol: "FTHX", amount: "1000", requestId: "slippage-deposit-0001" });
  const before = supply(), account = trading.account(owner);
  assert.throws(() => trading.trade(owner, { symbol: "FTHA", side: "buy", amount: "100", minOutput: "1000000", requestId: "bad-slippage-order01" }), /minimum output/);
  assert.deepEqual(trading.account(owner), account);
  const bought = order("FTH$", "buy", "100", "roundtrip-buy-dollar1");
  const sold = order("FTH$", "sell", bought.output, "roundtrip-sell-dollar1");
  assert.ok(BigInt(sold.output) < 100n, "fees prevent a free round-trip gain");
  assert.equal(trading.dollarLiability(), 0n);
  assert.doesNotThrow(() => exchange.validatePool(exchange.pool()));
  assert.deepEqual(supply(), before);
  assert.throws(() => trading.withdraw(owner, { symbol: "FTH$", amount: "1", requestId: "overspend-dollar-0001" }), /Insufficient/);
});
test("Interrupted Dollar withdrawals block new trades and recover after an acknowledged or lost commit without double credit", async t => {
  const { trading, exchange, api, owner, order, supply } = await fixture(t);
  trading.deposit(owner, { symbol: "FTHX", amount: "1000", requestId: "recover-deposit-00001" });
  const bought = order("FTH$", "buy", "100", "recover-buy-dollar001"), initial = supply();
  const commit = exchange.dollar.commitSettlement, walletBefore = BigInt(api.ledger.balance(walletAccountId(owner)).available);
  exchange.dollar.commitSettlement = tx => { commit(tx); throw Error("Receipt lost"); };
  const input = { symbol: "FTH$", amount: bought.output, requestId: "recover-withdraw-0001" };
  assert.throws(() => trading.withdraw(owner, input), /Receipt lost/);
  assert.throws(() => trading.quote({ symbol: "FTHA", side: "buy", amount: "1" }), /recovery/);
  exchange.dollar.commitSettlement = commit;
  trading.recover(); trading.withdraw(owner, input); trading.recover();
  assert.equal(BigInt(api.ledger.balance(walletAccountId(owner)).available), walletBefore + BigInt(bought.output));
  assert.doesNotThrow(() => exchange.validatePool(exchange.pool()));
  assert.deepEqual(supply(), initial);
});
test("Candles use exact executed OHLC ratios and volumes, omit empty buckets and reject invalid intervals", () => {
  const { candles, period } = require("../../notes-api/candles");
  const result = candles([{ at: 1, base: "3", quote: "9" }, { at: 2, base: "2", quote: "8" },
    { at: 3, base: "5", quote: "5" }, { at: 4, base: "4", quote: "8" }, { at: 1001, base: "1", quote: "2" }], 100);
  assert.deepEqual(result.map(c => c.at), [0, 1000]);
  assert.deepEqual(result[0], { at: 0, open: { numerator: "9", denominator: "3" }, high: { numerator: "8", denominator: "2" },
    low: { numerator: "5", denominator: "5" }, close: { numerator: "8", denominator: "4" }, baseVolume: "14", quoteVolume: "30", trades: 4 });
  assert.throws(() => period("constructor"), /supported chart/);
  assert.throws(() => candles([{ at: 1, base: "0", quote: "1" }], 100), /invalid candle/);
});
