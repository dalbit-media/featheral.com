"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Notes } = require("../../notes/ledger");
const { Creation } = require("../../notes/creation");
const { Exchange } = require("../../notes/exchange");
const { Trading } = require("../../notes/trading");
const { activity, readRows, options, liquidity, trades } = require("../../notes/activity");
const { activityRows } = require("../../fth-ledger/activity");
const { FthLedger } = require("../../fth-ledger/ledger");
const { ledgerFunds, SYSTEM_TREASURY_ACCOUNT } = require("../../notes/game-funds");
function fixture(t) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, { list: () => [] });
  const exchange = new Exchange(creation), trading = new Trading(creation, exchange);
  t.after(() => notes.close());
  const add = (amount, symbol = "FTHX", site = "notes-wallet", at = Date.now(), kind = "transfer") =>
    notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES ('private-wallet',?,?,'private-memo',?,?,?)")
      .run(amount, kind, at, site, symbol);
  return { notes, creation, exchange, trading, add };
}
test("a registered native definition is not duplicated as a placeholder community market", t => {
  const { creation } = fixture(t);
  creation.db.exec("INSERT INTO note_currencies VALUES ('FTHS','Featheral Silver','fixture',0)");
  const silver = creation.trending().filter(note => note.symbol === "FTHS");
  assert.equal(silver.length, 1);
  assert.equal(silver[0].native, true);
});
test("activity counts exact native postings without conflating transfers, prices, private metadata or legacy fake currencies", t => {
  const { creation, add } = fixture(t), now = Date.now();
  add(9007199254740991, "FTHX", "notes-wallet", now);
  add(9007199254740991, "FTHX", "notes-wallet", now);
  add(-2, "FTHX", "notes-wallet", now);
  add(10, "FTHS", "featheral-app", now, "silver_weekly_reward");
  add(20, "FTH$", "legacy", now); add(30, "FTHG", "legacy", now);
  add(5, "ART", "community", now - 86400001);
  const result = activity(creation, null, {}, now);
  assert.equal(result.partial, true);
  assert.equal(result.rows.length, 4);
  assert.equal(result.summary.find(row => row.symbol === "FTHX").credits, "18014398509481982");
  assert.equal(result.summary.find(row => row.symbol === "FTHX").debits, "2");
  assert.equal(result.buckets.reduce((sum, row) => sum + row.events, 0), 4);
  assert.doesNotMatch(JSON.stringify(result), /private-wallet|private-memo/);
  assert.equal(activity(creation, null, { source: "app" }, now).rows[0].symbol, "FTHS");
  assert.equal(activity(creation, null, { symbol: "FTHG" }, now).rows.length, 0);
  assert.equal(creation.markets.history("FTHA").candles.length, 0);
});
test("sealed Dollar and World settlements are captured with exact amounts, without pending transactions or signatures", async t => {
  const { creation, add } = fixture(t), root = fs.mkdtempSync(path.join(os.tmpdir(), "market-activity-"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const ledger = new FthLedger({ directory: root, blockIntervalMs: 0,
    genesis: { gamePublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() } }).open();
  t.after(() => { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const wallet = "0x" + "11".repeat(32), world = "0x" + "22".repeat(32), amount = "123456789012345678901234567890";
  await ledger.submit({ id: "fixture-credit", kind: "CREDIT", account: wallet, amount,
    data: { src: "FthgConverted", tx: "0x" + "ab".repeat(32) } });
  const funds = ledgerFunds(ledger, privateKey);
  funds.commit(funds.prepare([{ account: wallet, delta: "-" + amount }, { account: world, delta: amount }]));
  add(12);
  const reader = query => readRows(ledger.sql.db, "currency_activity", query);
  const result = activity(creation, reader, {});
  assert.equal(result.partial, false);
  const worldRows = activity(creation, reader, { source: "world" }).rows;
  assert.equal(worldRows.length, 1);
  assert.equal(worldRows[0].amount, amount);
  assert.equal(worldRows[0].credits, amount);
  assert.equal(worldRows[0].debits, amount);
  assert.equal(result.summary.filter(row => row.symbol === "FTH$").reduce((sum, row) => sum + BigInt(row.credits), 0n), BigInt(amount) * 2n);
  assert.deepEqual(result.summary.filter(row => row.symbol === "FTH$").map(row => row.source), ["gold", "world"]);
  assert.doesNotMatch(JSON.stringify(result), /signature|fixture-credit|"entries"|private-wallet/);
  const count = result.rows.length;
  ledger.blockIntervalMs = 600000;
  const pending = ledger.submit({ id: "pending-credit", kind: "CREDIT", account: wallet, amount: "1",
    data: { src: "StakeClaimed", tx: "0x" + "cd".repeat(32) } });
  assert.equal(activity(creation, reader, {}).rows.length, count);
  ledger.seal(); await pending;
  assert.equal(activity(creation, reader, {}).rows.length, count + 1);
  const beforeRestart = activity(creation, reader, {});
  ledger.close();
  const restarted = new FthLedger({ directory: root, mode: "reader" }).open();
  try {
    const restored = activity(creation, query => readRows(restarted.sql.db, "currency_activity", query), {}, beforeRestart.to);
    assert.deepEqual(restored.rows, beforeRestart.rows);
    assert.deepEqual(restored.summary, beforeRestart.summary);
  } finally { restarted.close(); }
});
test("keyset pages are stable across equal timestamps and retain complete window summaries", t => {
  const { creation, add } = fixture(t), now = Date.now();
  for (let i = 0; i < 7; i++) add(i + 1, "FTHX", "notes-wallet", now);
  let cursor, ids = [];
  do {
    const page = activity(creation, null, { limit: 2, ...(cursor ? { cursor } : {}) }, now);
    ids.push(...page.rows.map(row => row.id)); cursor = page.nextCursor;
    assert.equal(page.summary[0].events, 7);
    assert.equal(page.summary[0].credits, "28");
  } while (cursor);
  assert.equal(ids.length, 7); assert.equal(new Set(ids).size, 7);
  const first = activity(creation, null, { limit: 1 }, now);
  assert.throws(() => activity(creation, null, { cursor: first.nextCursor, symbol: "FTHS" }, now), /filters changed/);
  for (const input of [{ limit: 101 }, { interval: "constructor" }, { source: "private" }, { cursor: "bad" }, { symbol: ["FTHX"] }])
    assert.throws(() => options(input, now), error => error.status === 400);
});
test("all-history backfill includes old settlements, separates sources, and retains exact totals across stable pages", t => {
  const { creation, add } = fixture(t), now = Date.now(), old = now - 400 * 86400000;
  add(12, "FTHX", "notes-wallet", old);
  add(-3, "FTHX", "notes-market", now);
  add(3, "FTHX", "notes-market", now);
  assert.equal(activity(creation, null, {}, now).rows.length, 2);
  const first = activity(creation, null, { interval: "all", limit: 1 }, now);
  assert.equal(first.rows.length, 1);
  assert.ok(first.from <= old);
  assert.ok(first.bucketMs >= 5 * 86400000);
  assert.ok(first.buckets.length <= 90);
  assert.equal(first.summary.find(row => row.source === "wallet").credits, "12");
  assert.equal(first.summary.find(row => row.source === "exchange").debits, "3");
  const ids = [...first.rows.map(row => row.id)];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = activity(creation, null, { interval: "all", limit: 1, cursor }, now + 1000);
    assert.deepEqual(next.summary, first.summary);
    assert.deepEqual(next.buckets, first.buckets);
    assert.equal(next.to, first.to);
    ids.push(...next.rows.map(row => row.id)); cursor = next.nextCursor;
  }
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.equal(trades(creation, { interval: "all" }, now).rows.length, 0, "Historical postings never become pool trades.");
  assert.throws(() => options({ interval: "all", cursor: first.nextCursor }, now + 86400001), /expired/);
});
test("Gold activity backfill names actual conversion and funding operations without inferring an FTHX execution", () => {
  const hash = "0x" + "ab".repeat(32);
  const funding = activityRows({}, { i: "funding", k: "GOLD", a: "", v: "0", t: 1,
    d: { op: "market-liquidity", account: "reserve", dollars: "1000", fthg: "1" } }, hash);
  assert.equal(funding[0].kind, "market-liquidity");
  const converted = activityRows({}, { i: "credit", k: "CREDIT", a: "", v: "123", t: 2,
    d: { src: "FthgConverted" } }, hash);
  assert.equal(converted[0].kind, "FthgConverted");
  assert.equal(converted[0].source, "gold");
  assert.equal(converted.length, 1, "Do not infer missing Ethereum Gold amounts from a Dollar credit.");
});
test("FTHG reserve obligations and confirmed Ethereum records stay separate and never fabricate FTHX trades", t => {
  const { creation } = fixture(t), hash = "0x" + "ab".repeat(32), now = Date.now();
  const rows = [
    ...activityRows({}, { i: "reserve-convert", k: "GOLD", a: "", v: "0", t: now,
      d: { op: "market-liquidity", account: "reserve", dollars: "1000", fthg: "1" } }, hash),
    ...activityRows({}, { i: "reserve-sync", k: "GOLD", a: "", v: "0", t: now,
      d: { op: "sync", fthg: "1", direction: "origin-to-reserve" } }, "0x" + "cd".repeat(32)),
  ];
  const gold = rows.filter(row => row.symbol === "FTHG");
  assert.equal(rows.filter(row => row.symbol === "FTH$").length, 1, "Reserve synchronization does not fabricate a zero-dollar transaction.");
  assert.deepEqual(gold.map(row => row.recordType), ["off-chain-obligation", "ethereum-confirmed"]);
  const reader = () => ({ rows: gold, summary: gold.map(row => ({ symbol: row.symbol, recordType: row.recordType, events: 1, credits: row.credits, debits: row.debits })),
    buckets: gold.map(row => ({ symbol: row.symbol, recordType: row.recordType, at: now, events: 1, credits: row.credits, debits: row.debits })) });
  const result = activity(creation, reader, {}, now);
  assert.equal(result.summary.length, 2);
  assert.equal(creation.markets.history("FTHA").candles.length, 0);
});
test("reader failures are explicit, filters are bounded, and both public pages mount the same activity UI", t => {
  const { creation } = fixture(t);
  assert.throws(() => activity(creation, () => { throw Error("Ledger reader offline"); }, {}), /Ledger reader offline/);
  assert.throws(() => options({ interval: null }), error => error.status === 400);
  for (const host of ["ex.featheral.com", "notes.featheral.com"]) {
    const page = fs.readFileSync(path.join(__dirname, "../../../sites", host, "index.html"), "utf8");
    assert.match(page, /data-market-activity/);
    assert.match(page, /src="\/shared\/market-activity\.js"/);
    assert.match(page, /href="\/shared\/market-activity\.css"/);
  }
});
test("existing read-only replicas can read activity without attempting new index writes", t => {
  const { notes } = fixture(t);
  notes.db.exec(`DROP INDEX notes_activity_time; DROP INDEX notes_activity_symbol;
    DROP INDEX note_trades_time; DROP INDEX note_trades_symbol_time;
    DROP INDEX dollar_note_trades_time; DROP INDEX trading_dollar_activity_time`);
  notes.db.readOnlyReplica = true;
  notes.db.exec("PRAGMA query_only=ON");
  require("../../notes/ledger").initialize(notes.db);
  const creation = new Creation(notes, { list: () => [] }), exchange = new Exchange(creation);
  new Trading(creation, exchange);
  assert.equal(activity(creation, null, {}).rows.length, 0);
  assert.equal(liquidity(creation, exchange).automaticFunding, false);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='notes_activity_time'").get().n, 0);
});
test("liquidity is authoritative and diagnostic only, never automatic treasury funding or reserve rebalancing", t => {
  const { notes, creation, exchange } = fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1000000,'fixture',0,'test')").run(SYSTEM_TREASURY_ACCOUNT);
  const before = notes.balance(SYSTEM_TREASURY_ACCOUNT);
  const unfunded = liquidity(creation, exchange);
  assert.equal(unfunded.automaticFunding, false);
  assert.equal(unfunded.markets.find(row => row.symbol === "FTHA").fundingNeeded.FTHX, "1000000");
  assert.equal(notes.balance(SYSTEM_TREASURY_ACCOUNT), before);
  creation.markets.fund("FTHA", "FUND FTHA 1000000 FTHX 1000000 NOTES");
  assert.equal(liquidity(creation, exchange).markets.find(row => row.symbol === "FTHA").fundingNeeded, null);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1,'fixture',0,'test')").run(creation.markets.poolAccount("FTHA").toLowerCase());
  assert.equal(liquidity(creation, exchange).markets.find(row => row.symbol === "FTHA").status, "reserve-mismatch");
});
test("public execution tape contains actual legs only and strips custody owners", t => {
  const { notes, creation } = fixture(t);
  for (const [owner, value] of [[SYSTEM_TREASURY_ACCOUNT, 1000000], ["buyer", 100]])
    notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',0,'test')").run(owner, value);
  creation.markets.fund("FTHA", "FUND FTHA 1000000 FTHX 1000000 NOTES");
  const quote = creation.markets.quote("FTHA", "buy", 100);
  creation.markets.trade("buyer", { symbol: "FTHA", side: "buy", amount: 100, minOutput: quote.output, requestId: "activity-tape-trade-01" });
  const tape = trades(creation, {});
  assert.equal(tape.rows.length, 1);
  assert.equal(tape.rows[0].from, "FTHX");
  assert.equal(tape.rows[0].amount, "100");
  assert.doesNotMatch(JSON.stringify(tape), /buyer|owner|requestId/);
  assert.equal(trades(creation, { symbol: "FTH$" }).rows.length, 0);
});
test("Exchange Dollar custody trades appear separately from settlement flows and preserve full-range charts across pages", t => {
  const { creation } = fixture(t), now = Date.now();
  for (let i = 0; i < 120; i++) creation.db.prepare("INSERT INTO trading_dollar_trades(owner,side,amount,output,at) VALUES ('private-owner','buy','100','123456789012345678901',?)").run(now);
  const result = activity(creation, null, { symbol: "FTH$", limit: 1 }, now);
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary[0].recordType, "custody-trade");
  assert.equal(result.summary[0].events, 120);
  assert.equal(result.summary[0].credits, (123456789012345678901n * 120n).toString());
  assert.equal(result.buckets[0].events, 120);
  assert.ok(result.nextCursor);
  const second = activity(creation, null, { symbol: "FTH$", limit: 1, cursor: result.nextCursor }, now);
  assert.notEqual(second.rows[0].id, result.rows[0].id);
  assert.doesNotMatch(JSON.stringify(result), /private-owner/);
});
