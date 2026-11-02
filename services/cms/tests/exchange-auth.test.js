const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ethers = require("ethers");
const source = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/exchange-auth.js"), "utf8");
const address = ethers.getAddress("0x1111111111111111111111111111111111111111"), nonce = "ab".repeat(16);
const challenge = (owner = address, issued = Date.now()) => `Sign in to Featheral Notes and Sites.\n\nWallet: ${owner}\nNonce: ${"cd".repeat(24)}\nIssued: ${new Date(issued).toISOString()}\n\nSigning in does not spend funds. Creating a note costs 1,000 FTHX; creating a website costs 500 FTH$. Creation requires separate confirmation.`;
function fixture({ origin = "https://ex.featheral.com", host = "https://wallet.featheral.com", popupNonce = nonce, embedded = false, noVault = false, shared = false, provider = false } = {}) {
  const nodes = {}, listeners = {}, messages = [], signed = [], unlocked = [], writes = [], errors = [];
  let locks = 0, rejectPassword = false, changeAddress = false;
  const providerCalls = [];
  for (const id of ["auth-password", "auth-submit", "auth-form", "auth-cancel", "auth-status", "auth-origin", "auth-address", "auth-message",
    "auth-title", "auth-choice", "auth-method", "auth-select", "auth-password-label", "auth-description"])
    nodes[id] = { value: "", disabled: id === "auth-submit", listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  class Vault {
    read() { return noVault ? null : { address: changeAddress ? "0x2222222222222222222222222222222222222222" : address }; }
    async unlock(password) { unlocked.push(password); if (rejectPassword) throw new Error("Incorrect wallet password."); }
    async sign(message, owner) { signed.push({ message, owner }); return "signature"; }
    lock() { locks++; }
  }
  const opener = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const window = { opener, FeatheralVault: { Vault }, FeatheralSignIn: require('../../../sites/wallet.featheral.com/site-sign-in'),
    close() {}, addEventListener: (type, fn) => { listeners[type] = fn; } };
  if (provider) window.ethereum = { async request({ method }) {
    providerCalls.push(method);
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [changeAddress ? "0x2222222222222222222222222222222222222222" : address];
    if (method === "personal_sign") return "0x" + "ab".repeat(65);
    throw new Error("Unexpected provider method");
  } };
  window.parent = embedded ? {} : window;
  const location = new URL(`${host}/exchange-auth.html?${new URLSearchParams({ origin, nonce: popupNonce, ...(shared ? { mode: "site" } : {}) })}`);
  vm.runInNewContext(source, { window, location, document: { getElementById: id => nodes[id] }, URLSearchParams, ethers, Date, console: { error: error => errors.push(error) },
    localStorage: { getItem() { return null; }, setItem(...args) { writes.push(args); } } });
  return { nodes, messages, signed, unlocked, writes, errors, providerCalls, locks: () => locks,
    rejectPassword: value => { rejectPassword = value; }, changeAddress: () => { changeAddress = true; },
    request: (data = {}, event = {}) => listeners.message?.({ origin, source: opener,
      data: { type: shared ? "featheral:wallet-auth" : "featheral:exchange-auth", nonce, address, message: challenge(), ...data }, ...event }),
    select: method => { nodes["auth-method"].value = method; return nodes["auth-select"].listeners.click?.(); },
    submit: () => nodes["auth-form"].listeners.submit?.({ preventDefault() {} }),
    event: type => listeners[type]?.() };
}
test("built-in Exchange sign-in is manually approved and only returns a signature to the exact opener origin", async () => {
  const ui = fixture();
  assert.equal(ui.messages[0].data.type, "featheral:exchange-auth-ready");
  assert.equal(ui.messages[0].data.nonce, nonce);
  assert.equal(ui.messages[0].data.address, address);
  ui.request();
  assert.equal(ui.unlocked.length, 0); assert.equal(ui.signed.length, 0);
  ui.nodes["auth-password"].value = "user-entered-password";
  await ui.submit();
  assert.deepEqual(ui.unlocked, ["user-entered-password"]);
  assert.equal(ui.signed.length, 1); assert.equal(ui.signed[0].owner, address);
  const response = ui.messages.at(-1);
  assert.equal(response.origin, "https://ex.featheral.com");
  assert.deepEqual(Object.keys(response.data).sort(), ["address", "nonce", "signature", "type"]);
  assert.equal(response.data.type, "featheral:exchange-signature");
  assert.equal(response.data.signature, "signature");
  assert.ok(ui.locks() >= 1); assert.equal(ui.nodes["auth-password"].value, "");
  assert.equal(ui.writes.length, 0);
  await ui.submit(); assert.equal(ui.signed.length, 1);
});
test("shared site sign-ins use the central built-in wallet, set only its public active account and never export sessions", async () => {
  for (const origin of ["https://featheral.com", "https://gold.featheral.com", "https://world.featheral.com",
    "https://notes.featheral.com", "https://x.featheral.com", "https://community.featheral.com"]) {
    const ui = fixture({ shared: true, origin });
    assert.equal(ui.messages.length, 0, "selection must be explicit");
    await ui.select("builtin");
    assert.equal(ui.messages[0].data.type, "featheral:wallet-auth-ready");
    ui.request();
    assert.equal(ui.unlocked.length, 0);
    ui.nodes["auth-password"].value = "test-password";
    await ui.submit();
    assert.equal(ui.signed.length, 1);
    assert.equal(ui.messages.at(-1).data.type, "featheral:wallet-signature");
    assert.equal(ui.messages.at(-1).origin, origin);
    assert.deepEqual(ui.writes, [["featheral-wallet-active-account", address.toLowerCase()]]);
    assert.deepEqual(Object.keys(ui.messages.at(-1).data).sort(), ["address", "nonce", "signature", "type"]);
  }
});
test("shared sign-in connects extensions only on the wallet origin and validates standard comment challenges", async () => {
  const ui = fixture({ shared: true, provider: true, noVault: true, origin: "https://x.featheral.com" });
  assert.equal(ui.providerCalls.length, 0);
  await ui.select("external");
  assert.deepEqual(ui.providerCalls, ["eth_requestAccounts"]);
  assert.equal(ui.nodes["auth-password"].required, false);
  const message = require("../lib/wallet").signInMessage("Featheral X", address, "ab".repeat(16), Date.now());
  ui.request({ message });
  await ui.submit();
  assert.deepEqual(ui.unlocked, []);
  assert.equal(ui.messages.at(-1).data.signature, "0x" + "ab".repeat(65));
  assert.deepEqual(ui.providerCalls, ["eth_requestAccounts", "eth_accounts", "personal_sign", "eth_accounts"]);
});
test("missing extensions and built-in wallets provide central creation guidance without signing or fabricated accounts", async () => {
  const ui = fixture({ shared: true, noVault: true });
  await ui.select("external");
  assert.match(ui.nodes["auth-status"].textContent, /Create or restore/);
  await ui.select("builtin");
  assert.match(ui.nodes["auth-status"].textContent, /Create or restore/);
  assert.deepEqual(ui.messages, []);
  assert.deepEqual(ui.signed, []);
  assert.deepEqual(ui.writes, []);
});
test("shared authorization rejects non-network origins, changed accounts, payment messages and expired sign-ins", async () => {
  for (const origin of ["https://featheral.com.evil.example", "https://ex.featheral.com/", "http://x.featheral.com"]) {
    const ui = fixture({ shared: true, origin });
    assert.equal(ui.nodes["auth-select"].listeners.click, undefined);
  }
  for (const message of ["Transfer all funds", challenge(address, Date.now() - 600001)]) {
    const ui = fixture({ shared: true });
    await ui.select("builtin"); ui.request({ message }); await ui.submit();
    assert.equal(ui.unlocked.length, 0);
    assert.match(ui.messages.at(-1).data.error, /sign-in message|expired/);
  }
  const ui = fixture({ shared: true, provider: true, noVault: true });
  await ui.select("external"); ui.request(); ui.changeAddress(); await ui.submit();
  assert.match(ui.nodes["auth-status"].textContent, /account changed/);
  assert.equal(ui.providerCalls.includes("personal_sign"), false);
});
test("unsupported origins, frames and malformed popup nonces never initialize authorization", () => {
  for (const options of [{ origin: "https://ex.featheral.com.evil.example" }, { origin: "http://ex.featheral.com" },
    { origin: "https://ex.featheral.com/" }, { popupNonce: "bad" }, { embedded: true }, { host: "https://other.featheral.com" }]) {
    const ui = fixture(options);
    ui.request(); assert.equal(ui.messages.length, 0); assert.equal(ui.nodes["auth-submit"].disabled, true);
  }
  const local = fixture({ origin: "http://ex.localhost:8080", host: "http://wallet.localhost:8080" });
  assert.equal(local.messages[0].origin, "http://ex.localhost:8080");
  const wrongPort = fixture({ origin: "http://ex.localhost:8081", host: "http://wallet.localhost:8080" });
  assert.equal(wrongPort.messages.length, 0);
});
test("wrong opener, origin or request nonce cannot present a signing request", () => {
  const ui = fixture();
  ui.request({}, { source: {} }); ui.request({}, { origin: "https://evil.example" }); ui.request({ nonce: "00".repeat(16) });
  assert.equal(ui.nodes["auth-submit"].disabled, true); assert.equal(ui.messages.length, 1);
});
test("arbitrary messages, stale challenges and a different wallet are rejected before unlocking", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  for (const data of [{ message: "Transfer all funds" }, { message: challenge() + "\nExtra instruction" },
    { message: challenge(address, Date.now() - 600001) }, { message: challenge(address, Date.now() + 60000) },
    { address: other, message: challenge(other) }, { message: challenge(other) }]) {
    const ui = fixture(); ui.request(data); await ui.submit();
    assert.equal(ui.unlocked.length, 0); assert.equal(ui.signed.length, 0);
    assert.equal(typeof ui.messages.at(-1).data.error, "string");
    assert.equal(ui.nodes["auth-submit"].disabled, true);
  }
});
test("password failure locks the vault, clears the password and allows a deliberate retry", async () => {
  const ui = fixture(); ui.request(); ui.rejectPassword(true);
  ui.nodes["auth-password"].value = "wrong"; await ui.submit();
  assert.equal(ui.signed.length, 0); assert.equal(ui.nodes["auth-password"].value, "");
  assert.match(ui.nodes["auth-status"].textContent, /Incorrect wallet password/);
  assert.equal(ui.errors.length, 1);
  assert.ok(ui.locks() > 0);
  ui.rejectPassword(false); ui.nodes["auth-password"].value = "right"; await ui.submit();
  assert.equal(ui.signed.length, 1);
});
test("a missing built-in wallet reports a null public address and full-wallet guidance", () => {
  const ui = fixture({ noVault: true });
  assert.equal(ui.messages[0].data.address, null);
  assert.match(ui.messages[0].data.error, /Open the full wallet/);
  assert.equal(ui.nodes["auth-submit"].disabled, true);
  assert.equal(ui.errors.length, 1);
});
test("cancellation, closing or changed wallet storage prevents further signing", async () => {
  for (const end of ["pagehide", "storage", "cancel"]) {
    const ui = fixture(); ui.request();
    if (end === "cancel") ui.nodes["auth-cancel"].listeners.click(); else ui.event(end);
    await ui.submit(); assert.equal(ui.signed.length, 0);
    assert.equal(typeof ui.messages.at(-1).data.error, "string"); assert.ok(ui.locks() > 0);
  }
  const ui = fixture(); ui.request(); ui.changeAddress(); await ui.submit();
  assert.equal(ui.signed.length, 0);
});
