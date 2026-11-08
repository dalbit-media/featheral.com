"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ethers = require("ethers");
const { Vault } = require("../../../sites/wallet.featheral.com/vault")(ethers);
const root = path.resolve(__dirname, "../../..");

async function signupPage({ authenticated = true } = {}) {
  const wallet = ethers.Wallet.createRandom(), password = "existing-wallet-password-42";
  const keystore = await ethers.encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password,
    { scrypt: { N: 1024, r: 8, p: 1 } });
  const original = JSON.stringify({ version: 1, keystore, links: [] });
  const data = new Map([["featheral-encrypted-wallet-v1", original], ["featheral-wallet-public-account", wallet.address]]);
  const storage = { getItem: key => data.get(key) || null, setItem: () => { throw new Error("Signup must not overwrite the wallet"); } };
  const nodes = new Map(), tabs = ["register", "login"].map(mode => ({
    dataset: { mode }, setAttribute() {}, click() { this.onclick(); },
  }));
  const profileUsername = { value: "" };
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, value: "", textContent: "", classList: { add() {}, remove() {} }, replaceChildren() {},
      querySelector: () => profileUsername });
    return nodes.get(id);
  };
  const fields = { username: { value: "" }, password: { value: "" }, confirmation: { value: "", required: true } };
  get("credentials").elements = fields;
  get("credentials").reset = () => Object.values(fields).forEach(field => { field.value = ""; });
  get("password-note").textContent = "Create and encrypt a new wallet";
  const listeners = new Map(), requests = [], errors = [], signers = [];
  let session = { account: authenticated ? wallet.address : null, loginUsername: null, profile: null, complete: false };
  const world = {
    snapshot: () => session, refresh: async () => session, setSigner: signer => signers.push(signer),
    request: async (route, input) => {
      requests.push({ route, input });
      if (route === "/challenge") return { id: "signup", message: "Enable World password login" };
      if (route === "/register") {
        assert.equal(ethers.verifyMessage("Enable World password login", input.signature), wallet.address);
        session = { ...session, account: wallet.address, walletType: "built-in", loginUsername: fields.username.value };
        return session;
      }
      throw new Error("Unexpected signup operation: " + route);
    },
  };
  const context = vm.createContext({
    window: { FeatheralWorldAccount: world, addEventListener: (name, handler) => listeners.set(name, handler) },
    document: { getElementById: get, querySelectorAll: selector => selector === "[data-mode]" ? tabs : [],
      querySelector: selector => selector.includes('"login"') ? tabs[1] : tabs[0] },
    location: { search: "", hostname: "world.localhost", origin: "http://world.localhost" },
    localStorage: storage, FeatheralVault: { Vault }, ethers: { ...ethers, Wallet: { ...ethers.Wallet, createRandom() { throw new Error("Must reuse the existing wallet"); } } },
    FeatheralWorldProfile: { mount: async () => ({ load: async () => {} }) }, URL, URLSearchParams,
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "sites/world.featheral.com/account/account.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  async function submit(username, enteredPassword) {
    fields.username.value = username; fields.password.value = enteredPassword;
    get("credentials").onsubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 100 && fields.password.value; i++) await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { wallet, password, nodes, get, requests, errors, signers, data, original, tabs, submit, world, listeners, profileUsername };
}

test("connected built-in wallet signup only asks for username and its existing password and never creates or overwrites a wallet", async () => {
  for (const authenticated of [true, false]) {
    const page = await signupPage({ authenticated });
    assert.equal(page.get("confirmation").hidden, true);
    assert.equal(page.get("credentials").elements.confirmation.required, false);
    assert.equal(page.get("credentials-submit").textContent, "Enable username login");
    await page.submit("ExistingBuilder", page.password);
    assert.deepEqual(page.requests.map(request => request.route), ["/challenge", "/register"]);
    assert.equal(page.requests[0].input.address, page.wallet.address);
    assert.equal(page.world.snapshot().loginUsername, "ExistingBuilder");
    assert.equal(page.world.snapshot().account, page.wallet.address);
    assert.equal(page.signers[0].address, page.wallet.address);
    assert.equal(page.profileUsername.value, "ExistingBuilder");
    assert.equal(page.data.get("featheral-encrypted-wallet-v1"), page.original);
    assert.equal(page.errors.length, 0);
    assert.equal(page.get("continue").hidden, true);
  }
});

test("wrong existing-wallet password leaves credentials, wallet and World identity unchanged and permits retry", async () => {
  const page = await signupPage();
  await page.submit("ExistingBuilder", "wrong-wallet-password-42");
  assert.equal(page.requests.length, 0);
  assert.equal(page.world.snapshot().loginUsername, null);
  assert.equal(page.data.get("featheral-encrypted-wallet-v1"), page.original);
  assert.equal(page.errors.length, 1);
  assert.match(page.get("status").textContent, /password/i);
  await page.submit("ExistingBuilder", page.password);
  assert.equal(page.world.snapshot().loginUsername, "ExistingBuilder");
});

test("selecting an unrelated external wallet does not attach the saved built-in wallet", async () => {
  const page = await signupPage({ authenticated: false });
  page.data.set("featheral-wallet-public-account", ethers.Wallet.createRandom().address);
  page.tabs[0].click();
  assert.equal(page.get("confirmation").hidden, false);
  assert.equal(page.get("credentials-submit").textContent, "Create built-in wallet");
});

test("connecting a built-in wallet after the signup page loads updates the signup experience", async () => {
  const page = await signupPage({ authenticated: false });
  page.world.snapshot().account = page.wallet.address;
  page.listeners.get("featheral:world-session")({ detail: page.world.snapshot() });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.get("status").textContent, /built-in wallet is connected/);
  assert.equal(page.get("confirmation").hidden, true);
  assert.equal(page.get("credentials-submit").textContent, "Enable username login");
});

test("a wallet change during password decryption cancels signup instead of registering another wallet", async () => {
  const page = await signupPage({ authenticated: false });
  const signup = page.submit("ExistingBuilder", page.password);
  page.data.set("featheral-wallet-public-account", ethers.Wallet.createRandom().address);
  await signup;
  assert.equal(page.requests.length, 0);
  assert.equal(page.world.snapshot().account, null);
  assert.equal(page.data.get("featheral-encrypted-wallet-v1"), page.original);
  assert.match(page.get("status").textContent, /Wallet changed/);
});
