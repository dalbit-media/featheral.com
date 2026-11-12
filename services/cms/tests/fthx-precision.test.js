"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Notes } = require("../../notes/ledger");
const { Creation } = require("../../notes/creation");
const { Exchange } = require("../../notes/exchange");
const { Trading } = require("../../notes/trading");
const { UNIT, format, MAX_BALANCE } = require("../../notes/fthx");
const { canonical } = require("../../fth-ledger/codec");
const { activity } = require("../../notes/activity");
const { portfolio } = require("../../notes/portfolio");
function fixture(t, file = ":memory:") {
  const notes = new Notes(file), creation = new Creation(notes, { list: () => [] }), exchange = new Exchange(creation);
  const trading = new Trading(creation, exchange);
  t.after(() => notes.close());
  const add = (owner, whole) => notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',1,'test')")
    .run(owner, whole);
  return { notes, creation, exchange, trading, token: notes.fthx, add };
}
test("FTHX version 2 preserves every old whole-token entry and balance without rounding or minting", t => {
  const { token, notes, add } = fixture(t);
  add("alice", Number.MAX_SAFE_INTEGER);
  add("bob", 17);
  assert.equal(token.balance("ALICE"), BigInt(Number.MAX_SAFE_INTEGER) * UNIT);
  assert.equal(token.supply(), (BigInt(Number.MAX_SAFE_INTEGER) + 17n) * UNIT);
  assert.equal(token.view("bob").formatted, "17");
  assert.equal(notes.balance("bob"), 17, "Legacy callers retain explicit whole-token units.");
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries").get().n, 0);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM notes_entries").get().n, 2);
  assert.equal(token.issuance().authorized, false);
  assert.equal(format("1234567890123456789"), "1.234567890123456789");
});
test("one-base-unit transfers carry across whole boundaries, preserve supply and interoperate with legacy spending", t => {
  const { token, notes, add } = fixture(t);
  add("alice", 3);
  const supply = token.supply();
  const result = token.transfer("alice", { to: "bob", amount: "1", requestId: "fraction-transfer-0001" });
  assert.equal(token.balance("alice"), 3n * UNIT - 1n);
  assert.equal(token.balance("bob"), 1n);
  assert.equal(notes.balance("alice"), 2);
  assert.equal(notes.balance("bob"), 0);
  assert.equal(token.supply(), supply);
  assert.equal(token.view("alice").formatted, "2.999999999999999999");
  assert.deepEqual(token.transfer("ALICE", { to: "BOB", amount: "1", requestId: "fraction-transfer-0001" }), result);
  assert.throws(() => token.transfer("alice", { to: "bob", amount: "2", requestId: "fraction-transfer-0001" }), /different parameters/);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES ('alice',-2,'legacy-spend',2,'test'),('carol',2,'legacy-receive',2,'test')").run();
  assert.equal(token.balance("alice"), UNIT - 1n);
  token.transfer("bob", { to: "alice", amount: "1", requestId: "fraction-transfer-0002" });
  assert.equal(token.balance("alice"), UNIT);
  assert.equal(notes.balance("alice"), 1);
  assert.equal(token.balance("bob"), 0n);
  assert.equal(token.supply(), supply);
});
test("exact explorer history merges old and fractional entries without carry duplicates and keeps snapshot pagination stable", t => {
  const { token, notes, add } = fixture(t); add("alice", 3);
  token.transfer("alice", { to: "bob", amount: "1", requestId: "fraction-explorer-0001" });
  const first = token.entries({ limit: 1 });
  assert.equal(first.decimals, 18);
  assert.equal(first.entries[0].amount, "1");
  assert.equal(first.hasMore, true);
  token.transfer("alice", { to: "bob", amount: "2", requestId: "fraction-explorer-0002" });
  const second = token.entries({ limit: 1, before: first.nextBefore });
  assert.equal(second.entries[0].amount, "-1");
  const third = token.entries({ limit: 1, before: second.nextBefore });
  assert.equal(third.entries[0].amount, (3n * UNIT).toString());
  assert.equal(third.hasMore, false);
  assert.equal(token.entries().entries.length, 5);
  assert.ok(notes.db.prepare("SELECT COUNT(*) AS n FROM notes_entries WHERE site='fthx-base-units'").get().n > 0);
  const bob = token.entries({ address: "bob", limit: 1 });
  assert.equal(bob.entries[0].amount, "2");
  assert.throws(() => token.entries({ address: "alice", before: bob.nextBefore }), /changed address/);
  assert.throws(() => token.entries({ before: "not-a-cursor" }), error => error.status === 400);
});
test("fractional transfer rollback restores carries, remainders, audit and idempotency records after any partial write", t => {
  const { token, notes, add } = fixture(t); add("alice", 1);
  notes.db.exec(`CREATE TRIGGER reject_test_recipient BEFORE INSERT ON fthx_base_entries
    WHEN NEW.address='bob' BEGIN SELECT RAISE(ABORT,'fixture recipient unavailable'); END`);
  assert.throws(() => token.transfer("alice", { to: "bob", amount: "1", requestId: "fraction-rollback-0001" }), /recipient unavailable/);
  assert.equal(token.balance("alice"), UNIT);
  assert.equal(token.balance("bob"), 0n);
  for (const table of ["fthx_remainders", "fthx_base_entries", "fthx_operations"])
    assert.equal(notes.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  notes.db.exec("DROP TRIGGER reject_test_recipient");
  token.transfer("alice", { to: "bob", amount: "1", requestId: "fraction-rollback-0001" });
  assert.equal(token.balance("bob"), 1n);
});
test("fractional migration is durable and restarting never rescales balances or reissues transfers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fthx-precision-")), file = path.join(root, "notes.sqlite");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { notes, token, add } = fixture(t, file);
  add("alice", 7);
  const input = { to: "bob", amount: "1234567890123456789", requestId: "fraction-restart-0001" };
  const receipt = token.transfer("alice", input), supply = token.supply();
  notes.close();
  const reopened = new Notes(file);
  try {
    assert.equal(reopened.fthx.balance("bob"), 1234567890123456789n);
    assert.equal(reopened.fthx.supply(), supply);
    assert.deepEqual(reopened.fthx.transfer("alice", input), receipt);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries").get().n, 2);
  } finally { reopened.close(); }
});
test("finite migration issuance needs signed immutable authority, is capped and never changes existing owner balances", t => {
  const { token, add } = fixture(t); add("alice", 12);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const other = crypto.generateKeyPairSync("ed25519");
  const policy = { version: 1, symbol: "FTHX", decimals: 18, cap: (2n * UNIT).toString(), treasury: "migration-treasury",
    genesisHash: "0x" + "ab".repeat(32), snapshotHash: "0x" + "cd".repeat(32), snapshotHeight: 10 };
  const signature = crypto.sign(null, Buffer.from(canonical(policy)), privateKey).toString("base64");
  assert.throws(() => token.issue({ amount: "1", requestId: "finite-issuance-0001" }), /not authorized/);
  assert.throws(() => token.authorizeIssuance(policy, signature, other.publicKey), error => error.status === 403);
  token.authorizeIssuance(policy, signature, publicKey);
  token.authorizeIssuance(policy, signature, publicKey);
  const input = { amount: (UNIT + 1n).toString(), requestId: "finite-issuance-0001" };
  const issued = token.issue(input);
  assert.equal(token.balance("alice"), 12n * UNIT);
  assert.equal(token.balance("migration-treasury"), UNIT + 1n);
  assert.equal(token.supply(), 13n * UNIT + 1n);
  assert.deepEqual(token.issue(input), issued);
  assert.throws(() => token.issue({ ...input, amount: "1" }), /different parameters/);
  assert.throws(() => token.issue({ amount: UNIT.toString(), requestId: "finite-issuance-0002" }), /cap is exhausted/);
  assert.equal(token.issuance().remaining, (UNIT - 1n).toString());
  const bigger = { ...policy, cap: (3n * UNIT).toString() };
  const changedSignature = crypto.sign(null, Buffer.from(canonical(bigger)), privateKey).toString("base64");
  assert.throws(() => token.authorizeIssuance(bigger, changedSignature, publicKey), /cannot be replaced/);
});
test("one-time fixed market supply starts from zero, survives reload and cannot be reissued or increased", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fthx-fixed-")), file = path.join(root, "notes.sqlite");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { token, notes } = fixture(t, file), owner = "0x" + "ab".repeat(20), actor = "0x" + "cd".repeat(20);
  const input = { supply: "1000000", requestId: "fixed-market-supply-01", approval: `INITIALIZE FTHX 1000000 TO ${owner}` };
  assert.equal(token.summary().circulating, "0");
  const receipt = token.initializeSupply(owner, input, actor);
  assert.equal(token.balance(owner), 1000000n * UNIT);
  assert.equal(notes.balance(owner), 1000000);
  assert.equal(receipt.issued, (1000000n * UNIT).toString());
  assert.equal(receipt.actor, actor);
  assert.equal(notes.balance(owner, "FTHS"), 0);
  const reloaded = new (require("../../notes/fthx").Fthx)(notes.db);
  assert.deepEqual(reloaded.initializeSupply(owner, input, actor), receipt);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries").get().n, 1);
  assert.throws(() => token.initializeSupply(owner, { ...input, requestId: "fixed-market-supply-02" }, actor), /already fixed/);
  assert.throws(() => token.initializeSupply(owner, { ...input, supply: "2000000", approval: `INITIALIZE FTHX 2000000 TO ${owner}` }, actor), /already fixed/);
  token.transfer(owner, { to: actor, amount: UNIT.toString(), requestId: "fixed-supply-transfer1" });
  assert.equal(token.summary().circulating, (1000000n * UNIT).toString());
  assert.equal(token.summary().fixedSupply.supply, token.summary().circulating);
  notes.close();
  const reopened = new Notes(file);
  try {
    assert.deepEqual(reopened.fthx.initializeSupply(owner, input, actor), receipt);
    assert.equal(reopened.fthx.balance(owner), 999999n * UNIT);
    assert.equal(reopened.fthx.balance(actor), UNIT);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries WHERE kind='initial_supply'").get().n, 1);
  } finally { reopened.close(); }
});
test("fixed supply counts existing fractional balances and rejects invalid or partial initialization atomically", t => {
  const { token, notes, add } = fixture(t), owner = "0x" + "ab".repeat(20), actor = "0x" + "cd".repeat(20);
  add(owner, 10);
  token.transfer(owner, { to: actor, amount: "1", requestId: "fixed-supply-fraction" });
  const input = { supply: "100", requestId: "fixed-supply-rollback", approval: `INITIALIZE FTHX 100 TO ${owner}` };
  for (const bad of [{ ...input, approval: "wrong" }, { ...input, supply: "1.5" },
    { ...input, supply: "9", approval: `INITIALIZE FTHX 9 TO ${owner}` },
    { ...input, supply: "9007199254740992", approval: `INITIALIZE FTHX 9007199254740992 TO ${owner}` }])
    assert.throws(() => token.initializeSupply(owner, bad, actor));
  notes.db.exec("CREATE TRIGGER reject_fixed_supply BEFORE INSERT ON fthx_supply_policy BEGIN SELECT RAISE(ABORT,'fixture policy failure'); END");
  assert.throws(() => token.initializeSupply(owner, input, actor), /policy failure/);
  assert.equal(token.summary().circulating, (10n * UNIT).toString());
  assert.equal(token.fixedSupply().initialized, false);
  notes.db.exec("DROP TRIGGER reject_fixed_supply");
  const result = token.initializeSupply(owner, input, actor);
  assert.equal(result.existing, (10n * UNIT).toString());
  assert.equal(result.issued, (90n * UNIT).toString());
  assert.equal(token.balance(actor), 1n);
  assert.equal(token.summary().circulating, (100n * UNIT).toString());
});
test("fixing market supply blocks additional spendable migration issuance", t => {
  const { token } = fixture(t), owner = "0x" + "ab".repeat(20), actor = "0x" + "cd".repeat(20);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const policy = { version: 1, symbol: "FTHX", decimals: 18, cap: (10n * UNIT).toString(), treasury: owner,
    genesisHash: "0x" + "ab".repeat(32), snapshotHash: "0x" + "cd".repeat(32), snapshotHeight: 1 };
  token.authorizeIssuance(policy, crypto.sign(null, Buffer.from(canonical(policy)), privateKey).toString("base64"), publicKey);
  token.initializeSupply(owner, { supply: "100", approval: `INITIALIZE FTHX 100 TO ${owner}`, requestId: "fixed-supply-no-topup" }, actor);
  assert.throws(() => token.issue({ amount: "1", requestId: "fixed-supply-extra-01" }), /Further spendable issuance is disabled/);
  assert.equal(token.summary().circulating, (100n * UNIT).toString());
});
test("exact native balances and portfolio estimates include fractional-only holders without multiplying legacy market units", t => {
  const { token, creation, trading, add } = fixture(t); add("alice", 1);
  token.transfer("alice", { to: "bob", amount: (UNIT / 2n).toString(), requestId: "fraction-portfolio-01" });
  const bob = creation.account("bob");
  assert.equal(bob.fthx, 0);
  assert.equal(bob.fthxExact.balance, (UNIT / 2n).toString());
  assert.equal(bob.holdings[0].baseBalance, (UNIT / 2n).toString());
  assert.equal(creation.trending().find(note => note.symbol === "FTHX").circulating, UNIT.toString());
  const holdings = trading.portfolioHoldings("bob", bob.holdings);
  const result = portfolio(holdings, { funded: false, version: 0, dollars: "0", fthx: 0 }, []);
  assert.equal(result.assets[0].fthDollarValue, (UNIT / 200n).toString());
  assert.equal(result.totals.FTHX.value, (UNIT / 2n).toString());
});
test("fractional activity exposes exact movements once, excludes whole carry postings and never creates trades", t => {
  const { token, creation, add } = fixture(t); add("alice", 2);
  token.transfer("alice", { to: "bob", amount: "1", requestId: "fraction-activity-001" });
  const result = activity(creation, null, { interval: "all", symbol: "FTHX" });
  const exact = result.rows.filter(row => row.recordType === "base-unit-posting");
  assert.equal(exact.length, 2);
  assert.equal(exact.find(row => row.kind.endsWith("_in")).amount, "1");
  assert.equal(exact.find(row => row.kind.endsWith("_out")).debits, "1");
  assert.equal(result.rows.length, 3, "The original fixture issuance and the two exact postings, not a second carry debit.");
  const summary = result.summary.find(row => row.recordType === "base-unit-posting");
  assert.equal(summary.credits, "1"); assert.equal(summary.debits, "1");
  assert.doesNotMatch(JSON.stringify(result), /alice|bob/);
});
test("fractional input and precision boundaries reject unsafe or ambiguous amounts without changing balances", t => {
  const { token, add, notes } = fixture(t); add("alice", 1);
  for (const amount of [1, "", "0", "-1", "1.1", "1e18", "01", "9".repeat(79)]) {
    assert.throws(() => token.transfer("alice", { to: "bob", amount, requestId: "fraction-invalid-0001" }));
    assert.equal(token.balance("alice"), UNIT);
  }
  assert.throws(() => token.post("alice", 1n, "fixture", "test"), /atomic settlement/);
  assert.throws(() => token.transfer("alice", { to: "bob", amount: (UNIT + 1n).toString(), requestId: "fraction-invalid-0002" }), /Insufficient/);
  token.atomic(() => assert.throws(() => token.post("alice", MAX_BALANCE, "fixture", "test"), /accounting limits/));
  notes.db.prepare("UPDATE fthx_precision SET decimals=17 WHERE id=1").run();
  assert.throws(() => new (require("../../notes/fthx").Fthx)(notes.db), /Unsupported FTHX precision/);
});
