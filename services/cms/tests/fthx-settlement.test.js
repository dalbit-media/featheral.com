"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Notes } = require("../../notes/ledger");
const { createDollarApi } = require("../../notes/dollar");
const { canonical } = require("../../fth-ledger/codec");
const { FthxSettlement, backingAccount, RATE, TREASURY } = require("../../notes/fthx-settlement");
const { UNIT, MAX_BALANCE } = require("../../notes/fthx");
const ALICE = "0x" + "ab".repeat(32), BOB = "0x" + "cd".repeat(32);
async function fixture(t, amount = 10n * UNIT, finiteGold = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fthx-backing-"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const goldKey = crypto.generateKeyPairSync("ed25519");
  const options = { exchangeSigningKey: privateKey, env: { FTH_LEDGER_MODE: "writer", FTH_LEDGER_DIR: path.join(root, "dollar"),
    ...(finiteGold ? { FTH_GOLD_PUBLIC_KEY: goldKey.publicKey.export({ type: "spki", format: "pem" }).toString() } : {}),
    FTH_LEDGER_BLOCK_INTERVAL_MS: "0", FTH_GAME_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString() } };
  const api = createDollarApi(options), notesFile = path.join(root, "notes.sqlite"), notes = new Notes(notesFile);
  if (amount) await api.ledger.submit({ id: "fixture-credit", kind: "CREDIT", account: ALICE, amount: amount.toString(),
    data: { src: "FthgConverted", tx: "0x" + "12".repeat(32) } });
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES ('owner',17,'fixture',1,'test')").run();
  t.after(() => { api.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const game = (entries, value = "0") => {
    const tx = { i: "game:" + crypto.randomUUID(), k: "GAME", a: "", v: value, d: { entries }, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, entries, t: tx.t })), privateKey).toString("base64");
    return tx;
  };
  const gold = data => {
    const tx = { i: "gold:" + crypto.randomUUID(), k: "GOLD", a: "", v: "0", d: data, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(canonical(tx)), goldKey.privateKey).toString("base64");
    return tx;
  };
  return { api, notes, privateKey, game, gold, options, notesFile, attach: () => new FthxSettlement(api.ledger, notes.fthx, privateKey) };
}
test("migration preserves original owners, Dollar balances and reservations while issuing only exact locked backing", async t => {
  const { api, notes, attach } = await fixture(t);
  await api.ledger.submit({ id: "opening-reservation", kind: "RESERVE", account: ALICE, amount: "1",
    data: { r: "0x" + "ef".repeat(32), to: "0x" + "11".repeat(20), exp: Date.now() + 60000 } });
  const before = api.ledger.balance(ALICE), settlement = attach();
  assert.deepEqual(api.ledger.balance(ALICE), before);
  assert.equal(notes.balance("owner"), 17);
  assert.equal(notes.fthx.balance(backingAccount(ALICE)), 10n * UNIT * RATE);
  assert.equal(notes.fthx.balance(TREASURY), 0n);
  assert.equal(notes.fthx.supply(), (17n + 10n * RATE) * UNIT);
  assert.equal(notes.fthx.summary().circulating, (17n * UNIT).toString());
  assert.equal(notes.fthx.summary().reserved, (10n * UNIT * RATE).toString());
  assert.equal(settlement.summary().synchronized, true);
  assert.equal(notes.fthx.issuance().settlement.rate, RATE.toString());
  const issued = notes.fthx.issuance().issued;
  attach();
  assert.equal(notes.fthx.issuance().issued, issued, "Restart cannot mint the snapshot twice.");
  settlement.reconcile();
});
test("signed gameplay moves real fractional backing, retains displayed Dollar amounts and retries without duplicate movements", async t => {
  const { api, notes, game, attach } = await fixture(t);
  const settlement = attach(), supply = notes.fthx.supply();
  const tx = game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]);
  const receipt = api.ledger.commitGame(tx);
  assert.equal(api.ledger.balance(BOB).balance, "1");
  assert.equal(notes.fthx.balance(backingAccount(BOB)), RATE);
  assert.equal(notes.fthx.supply(), supply);
  const count = notes.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries").get().n;
  assert.deepEqual(api.ledger.commitGame(tx), receipt);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM fthx_base_entries").get().n, count);
  settlement.reconcile();
});
test("fixed market issuance is separate from locked backing and survives Dollar settlement and restart", async t => {
  const { api, notes, game, attach } = await fixture(t);
  const settlement = attach(), backing = notes.fthx.summary().reserved, owner = "0x" + "ab".repeat(20);
  const input = { supply: "1000", approval: `INITIALIZE FTHX 1000 TO ${owner}`, requestId: "fixed-supply-backing1" };
  notes.fthx.initializeSupply(owner, input, owner);
  assert.equal(notes.fthx.summary().reserved, backing);
  assert.equal(notes.fthx.balance(owner), 983n * UNIT);
  api.ledger.commitGame(game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]));
  assert.equal(notes.fthx.summary().circulating, (1000n * UNIT).toString());
  assert.equal(notes.fthx.summary().reserved, backing);
  attach();
  assert.equal(notes.fthx.summary().circulating, (1000n * UNIT).toString());
  settlement.reconcile();
});
test("unsealed Dollar activity never creates FTHX backing and batches settle exactly once", async t => {
  const { api, notes, attach } = await fixture(t);
  const settlement = attach();
  const reserve = await api.ledger.submit({ id: "reserve-test", kind: "RESERVE", account: ALICE, amount: "1",
    data: { r: "0x" + "ef".repeat(32), to: "0x" + "11".repeat(20), exp: Date.now() + 60000 } });
  assert.ok(reserve);
  const before = notes.fthx.balance(backingAccount(ALICE));
  const pending = api.ledger.submit({ id: "settle-test", kind: "SETTLE", account: ALICE, amount: "1",
    data: { r: "0x" + "ef".repeat(32), tx: "0x" + "34".repeat(32) } });
  assert.equal(notes.fthx.balance(backingAccount(ALICE)), before);
  api.ledger.seal(); await pending;
  assert.equal(notes.fthx.balance(backingAccount(ALICE)), before - RATE);
  assert.equal(notes.fthx.balance(TREASURY), RATE);
  settlement.reconcile();
});
test("burns release backing and later issuance reuses treasury without increasing the finite issuance count", async t => {
  const { api, notes, game, attach } = await fixture(t);
  const settlement = attach(), issued = notes.fthx.issuance().issued;
  api.ledger.commitGame(game([{ account: ALICE, delta: "-1" }], "1"));
  assert.equal(notes.fthx.balance(TREASURY), RATE);
  await api.ledger.submit({ id: "reuse-credit", kind: "CREDIT", account: BOB, amount: "1",
    data: { src: "FthgConverted", tx: "0x" + "56".repeat(32) } });
  assert.equal(notes.fthx.balance(TREASURY), 0n);
  assert.equal(notes.fthx.issuance().issued, issued);
  assert.equal(notes.fthx.balance(backingAccount(BOB)), RATE);
  settlement.reconcile();
});
test("finite cap exhaustion rejects source issuance before any Dollar mutation", async t => {
  const { api, notes, attach } = await fixture(t);
  attach();
  const height = api.ledger.height, supply = api.ledger.supply, issued = notes.fthx.issuance().issued;
  await assert.rejects(api.ledger.submit({ id: "over-cap-credit", kind: "CREDIT", account: BOB, amount: "1",
    data: { src: "FthgConverted", tx: "0x" + "78".repeat(32) } }), /capacity is exhausted/);
  assert.equal(api.ledger.height, height);
  assert.equal(api.ledger.supply, supply);
  assert.equal(api.ledger.pending.length, 0);
  assert.equal(api.ledger.ids.has("over-cap-credit"), false);
  assert.equal(notes.fthx.issuance().issued, issued);
});
test("a Notes write failure after a durable Dollar append blocks balance use and recovers by original signed transaction", async t => {
  const { api, notes, game, attach } = await fixture(t);
  const settlement = attach(), issued = notes.fthx.issuance().issued;
  const tx = game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]);
  notes.db.exec(`CREATE TRIGGER reject_backing BEFORE INSERT ON fthx_base_entries
    WHEN NEW.kind='backing_settlement' BEGIN SELECT RAISE(ABORT,'backing unavailable'); END`);
  assert.throws(() => api.ledger.commitGame(tx), error => error.status === 503);
  assert.equal(settlement.summary().synchronized, false);
  assert.throws(() => api.ledger.balance(BOB), /recovery is required/);
  assert.equal(notes.fthx.balance(backingAccount(BOB)), 0n);
  notes.db.exec("DROP TRIGGER reject_backing");
  api.ledger.commitGame(tx);
  assert.ok(api.ledger.findTx(api.ledger.ids.get(tx.i)).location);
  assert.equal(api.ledger.balance(BOB).balance, "1");
  assert.equal(notes.fthx.balance(backingAccount(BOB)), RATE);
  assert.equal(notes.fthx.issuance().issued, issued);
  settlement.reconcile();
});
test("both ledgers restart with stable fractional balances, checkpoint and original signed issuance policy", async t => {
  const { api, notes, game, attach, options, notesFile, privateKey } = await fixture(t);
  attach();
  api.ledger.commitGame(game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]));
  const issued = notes.fthx.issuance().issued;
  api.close(); notes.close();
  const restarted = createDollarApi(options), reopened = new Notes(notesFile);
  try {
    const settlement = new FthxSettlement(restarted.ledger, reopened.fthx, privateKey);
    assert.equal(reopened.fthx.balance(backingAccount(BOB)), RATE);
    assert.equal(reopened.fthx.issuance().issued, issued);
    assert.equal(settlement.summary().synchronized, true);
    settlement.reconcile();
  } finally { restarted.close(); reopened.close(); }
});
test("migration rejects foreign authority, corrupted policy signatures and orphan locked balances", async t => {
  const { api, notes, attach } = await fixture(t);
  assert.throws(() => new FthxSettlement(api.ledger, notes.fthx, crypto.generateKeyPairSync("ed25519").privateKey), /original authorized/);
  const settlement = attach();
  notes.fthx.atomic(() => notes.fthx.post(backingAccount("orphan"), 1n, "fixture", "test"));
  assert.throws(() => settlement.reconcile(), /orphan/);
  notes.fthx.atomic(() => notes.fthx.post(backingAccount("orphan"), -1n, "fixture", "test"));
  notes.db.prepare("UPDATE fthx_issuance_policy SET signature=?").run(Buffer.alloc(64).toString("base64"));
  assert.throws(attach, /different source journal or policy/);
});
test("migration refuses unsupported per-account backing before posting a partial snapshot", async t => {
  const { notes, attach } = await fixture(t, MAX_BALANCE / RATE + 1n);
  assert.throws(attach, /per-account FTHX limit/);
  assert.equal(notes.fthx.balance(backingAccount(ALICE)), 0n);
  assert.equal(notes.fthx.issuance().issued, "0");
  assert.equal(notes.fthx.issuance().authorized, false, "A failed snapshot cannot strand a committed issuance policy.");
  assert.equal(notes.balance("owner"), 17);
});
test("zero-start activation defers issuance until signed finite Gold initialization, then backs actual resource funding", async t => {
  const { api, notes, gold, attach } = await fixture(t, 0n, true);
  const settlement = attach();
  assert.equal(settlement.summary().enabled, false);
  assert.equal(notes.fthx.issuance().authorized, false);
  const cap = 1000000n * UNIT, evidence = { block: 1, hash: "0x" + "11".repeat(32) };
  api.ledger.commitAuthorized(gold({ op: "initialize", cap: cap.toString(), rate: "1000", evidence }));
  const target = api.ledger.genesis.goldMarkets.wood, dollars = BigInt(target.pricePerLot) * 2n;
  const account = "0x" + crypto.createHash("sha256").update("featheral:dollar:game:pool:wood").digest("hex");
  const tx = gold({ op: "resource-liquidity", asset: "wood", account, quantity: 2, dollars: dollars.toString(),
    fthg: (dollars / 1000n).toString(), origin: cap.toString(), reserve: "0", evidence });
  api.ledger.commitAuthorized(tx);
  assert.equal(api.ledger.balance(account).balance, dollars.toString());
  assert.equal(notes.fthx.balance(backingAccount(account)), dollars * RATE);
  assert.equal(notes.fthx.issuance().cap, (cap * 20000n * RATE).toString());
  assert.equal(notes.fthx.issuance().issued, (dollars * RATE).toString(), "Only funded backing is issued, not the entire allowance.");
  assert.equal(settlement.summary().enabled, true);
  settlement.reconcile();
});
test("per-account backing overflow is rejected before the source transaction, while aggregate supply may exceed one account's limit", async t => {
  const maximumDollars = MAX_BALANCE / RATE;
  const { api, notes, game, attach } = await fixture(t, maximumDollars);
  await api.ledger.submit({ id: "fixture-second-owner", kind: "CREDIT", account: BOB, amount: maximumDollars.toString(),
    data: { src: "FthgConverted", tx: "0x" + "9a".repeat(32) } });
  const settlement = attach(), height = api.ledger.height;
  const overflow = game([{ account: BOB, delta: "-1" }, { account: ALICE, delta: "1" }]);
  assert.throws(() => api.ledger.commitGame(overflow), /per-account backing limit/);
  assert.equal(api.ledger.height, height);
  assert.equal(api.ledger.ids.has(overflow.i), false);
  const carol = "0x" + "ef".repeat(32), dan = "0x" + "12".repeat(32);
  api.ledger.commitGame(game([
    { account: ALICE, delta: (-maximumDollars).toString() }, { account: BOB, delta: (-maximumDollars).toString() },
    { account: carol, delta: maximumDollars.toString() }, { account: dan, delta: maximumDollars.toString() },
  ]));
  assert.equal(notes.fthx.balance(backingAccount(carol)), maximumDollars * RATE);
  assert.equal(notes.fthx.balance(backingAccount(dan)), maximumDollars * RATE);
  assert.ok(notes.fthx.supply() > MAX_BALANCE);
  settlement.reconcile();
});
test("a mismatched source checkpoint cannot restart or expose a synchronized backing status", async t => {
  const { notes, attach } = await fixture(t);
  const settlement = attach();
  notes.db.prepare("UPDATE fthx_settlement_checkpoint SET hash=? WHERE id=1").run("0x" + "ff".repeat(32));
  assert.equal(settlement.summary().synchronized, false);
  assert.throws(attach, /ahead of or conflicts/);
  assert.throws(() => settlement.assertSynchronized(), /recovery is required/);
});
test("existing World funds migrate unchanged and its real fund journal recovers a failed backing commit exactly once", async t => {
  const { api, notes, privateKey, game, attach } = await fixture(t);
  const { SqliteStore } = require(path.join(__dirname, "..", "..", "..", "sites", "world.featheral.com", "play", "server", "store.ts"));
  const { ledgerFunds, SYSTEM_TREASURY_ACCOUNT } = require("../../notes/game-funds");
  const store = new SqliteStore(":memory:", Date.now, 1, ledgerFunds(api.ledger, privateKey));
  t.after(() => store.close());
  const { token } = store.create(), account = store.walletContext(token).fundAccountId;
  api.ledger.commitGame(game([{ account: ALICE, delta: (-UNIT).toString() }, { account, delta: UNIT.toString() }]));
  const visible = store.read(token, session => session.account.game.dollars);
  assert.equal(visible, 10000);
  const settlement = attach(), supply = notes.fthx.supply();
  const { WorldMarkets } = require("../../notes/world-markets"), worldMarkets = new WorldMarkets(store.db, api.ledger);
  const fill = () => store.db.prepare("INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES ('wood',1,1,1,?,'system','private-buyer','private-seller')").run(Date.now());
  assert.equal(store.read(token, session => session.account.game.dollars), visible);
  assert.equal(notes.fthx.balance(backingAccount(account)), UNIT * RATE);
  store.transaction(token, session => { session.account.game.dollars--; fill(); });
  assert.equal(store.read(token, session => session.account.game.dollars), 9999);
  assert.equal(worldMarkets.tape({ interval: "all" }).rows.length, 1);
  assert.equal(worldMarkets.tape({ interval: "all" }).rows[0].backing, "locked-fthx-settlement");
  notes.db.exec(`CREATE TRIGGER reject_world_backing BEFORE INSERT ON fthx_base_entries
    WHEN NEW.kind='backing_settlement' BEGIN SELECT RAISE(ABORT,'World backing unavailable'); END`);
  assert.throws(() => store.transaction(token, session => { session.account.game.dollars--; fill(); }), error => error.status === 503);
  assert.equal(worldMarkets.tape({ interval: "all" }).rows.length, 1, "Failed backing never exposes an unsettled execution.");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fund_commits WHERE settled=0").get().n, 1);
  notes.db.exec("DROP TRIGGER reject_world_backing");
  store.recoverFunds();
  store.recoverFunds();
  assert.equal(worldMarkets.tape({ interval: "all" }).rows.length, 2, "Recovery publishes each real execution once.");
  assert.equal(store.read(token, session => session.account.game.dollars), 9998);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fund_commits WHERE settled=0").get().n, 0);
  assert.equal(api.ledger.balance(SYSTEM_TREASURY_ACCOUNT).balance, (2n * 10n ** 14n).toString());
  assert.equal(notes.fthx.balance(backingAccount(account)), BigInt(9998) * 10n ** 14n * RATE);
  assert.equal(notes.fthx.supply(), supply);
  assert.equal(notes.balance("owner"), 17);
  settlement.reconcile();
});
test("synchronous World commits wait for their own durable backed block behind a full pending batch", async t => {
  const { api, notes, game, attach } = await fixture(t);
  const settlement = attach(), height = api.ledger.height;
  for (let index = 0; index < 1000; index++) {
    const tx = game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]);
    api.ledger.pending.push({ tx, hash: api.ledger.applyTx(tx) });
  }
  assert.equal(notes.fthx.balance(backingAccount(BOB)), 0n);
  const tx = game([{ account: ALICE, delta: "-1" }, { account: BOB, delta: "1" }]);
  api.ledger.commitGame(tx);
  assert.equal(api.ledger.height, height + 2);
  assert.equal(api.ledger.pending.length, 0);
  assert.ok(api.ledger.findTx(api.ledger.ids.get(tx.i)).location);
  assert.equal(notes.fthx.balance(backingAccount(BOB)), 1001n * RATE);
  assert.equal(api.ledger.balance(BOB).balance, "1001");
  settlement.reconcile();
});
