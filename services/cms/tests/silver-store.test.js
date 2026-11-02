"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Wallet } = require("ethers");
const { Notes } = require("../../notes-api/ledger");
const { Creation } = require("../../notes-api/creation");
const { SilverStore } = require("../../notes-api/silver-store");
const approval = require("../../../sites/wallet.featheral.com/site-sign-in");
const ORIGIN = "http://silver.localhost:8080";
const productInput = (patch = {}) => ({ title: "Test collectible redemption", brand: "Fixture issuer", description: "An isolated digital redemption fixture.",
  category: "collectible", region: "Japan only; Japanese issuer account required", denomination: "One fixture collectible",
  sourcing: "Fixture supplier in Japan; test stock only", terms: "Redeem with the fixture issuer. No shipping by Featheral. Manual digital delivery.",
  redeemUrl: "https://example.com/redeem", price: 37, published: true, ...patch });
function fixture(t) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {}), buyer = Wallet.createRandom(), treasury = Wallet.createRandom(), key = crypto.randomBytes(32).toString("hex");
  let now = Date.now();
  const store = new SilverStore(notes, creation.markets, { SILVER_CODE_KEY: key }, () => now);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES(?,200,'fixture',?,'test','FTHS')").run(buyer.address.toLowerCase(), now);
  store.configure({ treasury: treasury.address, enabled: true, terms: "Digital codes only, no shipping.", revision: 0 });
  t.after(() => notes.close());
  const product = store.saveProduct(productInput());
  const stock = code => store.addStock(product.id, { codes: [code] });
  const prepare = () => store.prepare(buyer.address.toLowerCase(), { product: product.id, request: crypto.randomUUID() }, ORIGIN);
  const pay = async order => store.pay(buyer.address.toLowerCase(), order.id, await buyer.signMessage(order.message), ORIGIN);
  return { notes, creation, store, buyer, treasury, product, stock, prepare, pay, key, advance: ms => { now += ms; } };
}
test("Silver checkout requires receiving wallet, secure stock, published product and valid whole FTHS pricing", t => {
  const f = fixture(t), disabled = new SilverStore(f.notes, f.creation.markets, {});
  assert.throws(() => disabled.addStock(f.product.id, { codes: ["secret"] }), /SILVER_CODE_KEY/);
  assert.throws(() => new SilverStore(f.notes, f.creation.markets, { SILVER_CODE_KEY: "bad" }), /32 bytes/);
  assert.throws(() => disabled.configure({ ...f.store.settings(), enabled: true }), /receiving wallet and SILVER_CODE_KEY/);
  assert.throws(() => f.store.saveProduct(productInput({ price: 0.1 })), /whole FTHS/);
  assert.throws(() => f.store.saveProduct(productInput({ redeemUrl: "javascript:alert(1)" })), /HTTPS/);
  assert.throws(() => f.store.saveProduct(productInput({ region: "" })), /region/);
  assert.throws(() => f.prepare(), /not available/);
  const current = f.store.settings();
  f.store.configure({ ...current, enabled: false });
  assert.throws(() => f.prepare(), /not enabled/);
  assert.throws(() => f.store.configure({ ...current, enabled: true }), /changed/);
});
test("FTHS payment atomically reserves stock, transfers without minting and retries without charging twice", async t => {
  const f = fixture(t); f.stock("FIXTURE-PRIVATE-CODE");
  const order = f.prepare(), preparedAgain = f.store.prepare(f.buyer.address.toLowerCase(), { product: f.product.id, request: f.notes.db.prepare("SELECT request FROM silver_orders WHERE id=?").get(order.id).request }, ORIGIN);
  assert.equal(order.id, preparedAgain.id);
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 200);
  assert.equal(f.store.product(f.product.id).stock, 1);
  const signature = await f.buyer.signMessage(order.message), result = await f.pay(order);
  assert.equal(result.status, "paid"); assert.equal(f.store.product(f.product.id).stock, 0);
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 163); assert.equal(f.notes.balance(f.treasury.address, "FTHS"), 37);
  assert.equal(f.store.pay(f.buyer.address.toLowerCase(), order.id, signature, ORIGIN).status, "paid");
  assert.equal(f.notes.db.prepare("SELECT COUNT(*) AS n FROM notes_entries WHERE kind='silver-purchase'").get().n, 2);
  assert.equal(f.notes.db.prepare("SELECT SUM(amount) AS n FROM notes_entries WHERE symbol='FTHS'").get().n, 200);
  const rebuilt = new SilverStore(f.notes, f.creation.markets, { SILVER_CODE_KEY: f.key });
  assert.equal(rebuilt.orders(f.buyer.address.toLowerCase())[0].status, "paid");
});
test("Digital stock is encrypted, never listed publicly, and revealed only to the buyer after manual fulfillment", async t => {
  const f = fixture(t), code = "PRIVATE-NOT-PUBLIC-1234"; f.stock(code);
  assert.equal(JSON.stringify(f.store.admin()).includes(code), false);
  assert.equal(f.notes.db.prepare("SELECT sealed FROM silver_codes").get().sealed.includes(code), false);
  const order = await f.pay(f.prepare());
  assert.throws(() => f.store.reveal(f.buyer.address.toLowerCase(), order.id), /not delivered/);
  assert.throws(() => f.store.reveal(f.treasury.address.toLowerCase(), order.id), /not found/);
  assert.equal(f.store.fulfill(order.id).status, "delivered");
  assert.equal(f.store.fulfill(order.id).status, "delivered");
  assert.equal(f.store.reveal(f.buyer.address.toLowerCase(), order.id).code, code);
  assert.throws(() => f.store.refund(order.id), /undelivered/);
  assert.equal(JSON.stringify(f.store.orders()).includes(code), false);
});
test("Invalid payer, wrong origin, changed price or store terms, expired quotes and insufficient funds never debit", async t => {
  const f = fixture(t); f.stock("test-code-1"); const owner = f.buyer.address.toLowerCase(), other = Wallet.createRandom();
  const order = f.prepare();
  assert.throws(() => f.store.pay(owner, order.id, "0x", ORIGIN), /Invalid/);
  assert.throws(() => f.store.pay(owner, order.id, undefined, ORIGIN), /Invalid/);
  assert.throws(() => f.store.pay(owner, order.id, "0x", "http://app.localhost:8080"), /Invalid/);
  assert.throws(() => f.store.pay(owner, order.id, other.signingKey.sign(crypto.randomBytes(32)).serialized, ORIGIN), /Invalid/);
  f.store.saveProduct(productInput({ price: 38, revision: f.product.revision }), f.product.id);
  await assert.rejects(f.pay(order), /terms changed/);
  const expired = f.prepare(); f.advance(300001); await assert.rejects(f.pay(expired), /expired/);
  const changed = f.prepare(); f.store.configure({ ...f.store.settings(), terms: "Changed terms" }); await assert.rejects(f.pay(changed), /terms changed/);
  f.store.saveProduct(productInput({ price: 1000, revision: f.store.product(f.product.id).revision }), f.product.id);
  await assert.rejects(f.pay(f.prepare()), /Insufficient FTHS/);
  assert.equal(f.notes.balance(owner, "FTHS"), 200); assert.equal(f.store.product(f.product.id).stock, 1);
});
test("Two buyers cannot buy the same code; failed and expired inventory payments roll back completely", async t => {
  const f = fixture(t); f.stock("last-code");
  const first = f.prepare(), other = Wallet.createRandom(), second = f.store.prepare(other.address.toLowerCase(), { product: f.product.id, request: crypto.randomUUID() }, ORIGIN);
  f.notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES(?,200,'fixture',?,'test','FTHS')").run(other.address.toLowerCase(), Date.now());
  await f.pay(first);
  assert.throws(() => f.store.pay(other.address.toLowerCase(), second.id, other.signingKey.sign(crypto.randomBytes(32)).serialized, ORIGIN), /Invalid/);
  const signature = await other.signMessage(second.message);
  assert.throws(() => f.store.pay(other.address.toLowerCase(), second.id, signature, ORIGIN), /Sold out/);
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 163);
  f.store.addStock(f.product.id, { codes: ["expires-soon"], expiresAt: new Date(Date.now() + 1000).toISOString() });
  const expiring = f.prepare(); f.advance(2000); await assert.rejects(f.pay(expiring), /Sold out/);
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 163);
});
test("Undelivered refunds are exact, retry-safe, use the original treasury, and quarantine codes", async t => {
  const f = fixture(t); f.stock("refund-test");
  const order = await f.pay(f.prepare());
  f.store.configure({ ...f.store.settings(), treasury: Wallet.createRandom().address });
  assert.equal(f.store.refund(order.id).status, "refunded");
  assert.equal(f.store.refund(order.id).status, "refunded");
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 200); assert.equal(f.notes.balance(f.treasury.address, "FTHS"), 0);
  assert.equal(f.store.product(f.product.id).stock, 0); assert.equal(f.store.inventory(f.product.id)[0].state, "quarantined");
  assert.throws(() => f.store.fulfill(order.id), /Only paid/);
  assert.equal(f.notes.db.prepare("SELECT COUNT(*) AS n FROM notes_entries WHERE kind='silver-refund'").get().n, 2);
});
test("Code imports are all-or-nothing, duplicates and expired stock are rejected, available stock can be retired", t => {
  const f = fixture(t); f.stock("unique");
  assert.throws(() => f.store.addStock(f.product.id, { codes: ["new", "unique"] }), /already registered/);
  assert.equal(f.store.product(f.product.id).stock, 1);
  assert.throws(() => f.store.addStock(f.product.id, { codes: ["expired"], expiresAt: "2000-01-01" }), /future/);
  const code = f.store.inventory(f.product.id)[0];
  assert.equal(f.store.retireStock(f.product.id, code.id).retired, true);
  assert.equal(f.store.product(f.product.id).stock, 0); assert.equal(f.store.inventory(f.product.id)[0].sealed, undefined);
});
test("Corrupt or wrongly keyed inventory blocks payment without taking FTHS", async t => {
  const f = fixture(t); f.stock("encrypted");
  const order = f.prepare(), wrongKey = new SilverStore(f.notes, f.creation.markets, { SILVER_CODE_KEY: crypto.randomBytes(32).toString("hex") });
  const signature = await f.buyer.signMessage(order.message);
  assert.throws(() => wrongKey.pay(f.buyer.address.toLowerCase(), order.id, signature, ORIGIN));
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 200); assert.equal(f.store.product(f.product.id).stock, 1);
});
test("Changed code expiry and insufficient refund treasury funds cannot produce a partial settlement", async t => {
  const f = fixture(t); f.stock("no-expiry");
  const order = f.prepare();
  f.store.addStock(f.product.id, { codes: ["expires-first"], expiresAt: new Date(Date.now() + 600000).toISOString() });
  await assert.rejects(f.pay(order), /expiry changed/);
  const paid = await f.pay(f.prepare());
  f.notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES(?,-37,'fixture',?,'test','FTHS')").run(f.treasury.address.toLowerCase(), Date.now());
  assert.throws(() => f.store.refund(paid.id), /Insufficient FTHS/);
  assert.equal(f.store.order(paid.id).status, "paid");
  assert.equal(f.notes.balance(f.buyer.address, "FTHS"), 163);
  assert.equal(f.store.inventory(f.product.id).filter(code => code.state === "reserved").length, 1);
});
test("Digital orders, exact balances and encrypted codes survive closing and reopening the Notes database", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "silver-store-reopen-")), file = path.join(directory, "notes.sqlite");
  let notes;
  t.after(() => { notes?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const key = crypto.randomBytes(32).toString("hex"), buyer = Wallet.createRandom(), treasury = Wallet.createRandom(), owner = buyer.address.toLowerCase();
  notes = new Notes(file); let creation = new Creation(notes, {}), store = new SilverStore(notes, creation.markets, { SILVER_CODE_KEY: key });
  store.configure({ treasury: treasury.address, enabled: true, terms: "Test digital terms", revision: 0 });
  const product = store.saveProduct(productInput()); store.addStock(product.id, { codes: ["PERSISTENT-PRIVATE-CODE"] });
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES(?,50,'fixture',?,'test','FTHS')").run(owner, Date.now());
  const order = store.prepare(owner, { product: product.id, request: crypto.randomUUID() }, ORIGIN), signature = await buyer.signMessage(order.message);
  store.pay(owner, order.id, signature, ORIGIN); notes.close(); notes = new Notes(file);
  creation = new Creation(notes, {}); store = new SilverStore(notes, creation.markets, { SILVER_CODE_KEY: key });
  assert.equal(store.pay(owner, order.id, signature, ORIGIN).status, "paid");
  assert.equal(notes.balance(owner, "FTHS"), 13);
  store.fulfill(order.id); assert.equal(store.reveal(owner, order.id).code, "PERSISTENT-PRIVATE-CODE");
});
test("Silver login and payment approval are exact-message, wallet-bound, origin-bound, fresh and separately labeled", async t => {
  const f = fixture(t); f.stock("whitelist");
  const challenge = f.store.challenge(f.buyer.address, ORIGIN), order = f.prepare();
  approval.validate(f.buyer.address, challenge.message, true, ORIGIN);
  approval.validate(f.buyer.address, order.message, true, ORIGIN);
  for (const message of [challenge.message, order.message]) {
    assert.throws(() => approval.validate(f.buyer.address, message, true, "https://evil.example"), /origin/);
    assert.throws(() => approval.validate(f.treasury.address, message, true, ORIGIN), /Only the standard/);
    assert.throws(() => approval.validate(f.buyer.address, message, false, ORIGIN), /Only the standard/);
    assert.throws(() => approval.validate(f.buyer.address, message + "\nextra", true, ORIGIN), /Only the standard/);
  }
  const token = f.store.login({ address: f.buyer.address, signature: await f.buyer.signMessage(challenge.message) }, ORIGIN);
  assert.equal(f.store.owner(token), f.buyer.address.toLowerCase());
  assert.notEqual(f.notes.db.prepare("SELECT token FROM silver_sessions").get().token, token);
  assert.throws(() => f.store.login({ address: f.buyer.address, signature: "0x" }, ORIGIN), /expired/);
  f.store.logout(token); assert.throws(() => f.store.owner(token), /Connect/);
});
