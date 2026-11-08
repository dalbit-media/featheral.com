"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ethers = require("ethers");
const { Vault } = require("../../../sites/wallet.featheral.com/vault")(ethers);
const root = path.resolve(__dirname, "../../..");

async function signupPage({ authenticated = true, pathname = "/register/", search = "", allowCreate = false } = {}) {
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
  const listeners = new Map(), requests = [], errors = [], signers = [], redirects = [];
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
      if (route === "/login") {
        if (input.password !== password) throw new Error("Incorrect username or password.");
        session = { ...session, account: wallet.address, walletType: "built-in", loginUsername: input.username, keystore };
        return session;
      }
      if (route === "/game") return { connected: true };
      if (route === "/app-handoff" || route === "/admin-handoff") return { code: "one-use-world-code" };
      throw new Error("Unexpected signup operation: " + route);
    },
  };
  const context = vm.createContext({
    window: { FeatheralWorldAccount: world, addEventListener: (name, handler) => listeners.set(name, handler) },
    document: { getElementById: get, querySelectorAll: selector => selector === "[data-mode]" ? tabs : [],
      querySelector: selector => selector.includes('"login"') ? tabs[1] : tabs[0] },
    location: { pathname, search, hostname: "world.localhost", origin: "http://world.localhost",
      replace: url => redirects.push(url), assign: url => redirects.push(url) },
    localStorage: storage, FeatheralVault: { Vault }, ethers: { ...ethers, Wallet: { fromEncryptedJson: ethers.Wallet.fromEncryptedJson, createRandom() {
      if (!allowCreate) throw new Error("Must reuse the existing wallet");
      return { address: wallet.address, encrypt: async () => keystore, signMessage: message => wallet.signMessage(message) };
    } } },
    FeatheralWorldProfile: { mount: async () => ({ load: async () => {} }) }, URL, URLSearchParams,
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "sites/world.featheral.com/account/account.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  async function submit(username, enteredPassword) {
    fields.username.value = username; fields.password.value = enteredPassword;
    get("credentials").onsubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 1000 && fields.password.value; i++) await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { wallet, password, nodes, get, requests, errors, signers, data, original, tabs, submit, world, listeners, profileUsername, redirects };
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
    assert.equal(new URL(page.redirects.at(-1)).pathname, "/account/");
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
  page.listeners.get("focus")();
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

test("account routes send signed-out visitors to login without losing their return destination", async () => {
  for (const pathname of ["/account/", "/account/index.html"]) {
    const page = await signupPage({ authenticated: false, pathname, search: "?switch=1&returnTo=https%3A%2F%2Fmedia.featheral.com%2F" });
    const destination = new URL(page.redirects[0]);
    assert.equal(destination.pathname, "/login/");
    assert.equal(destination.hash, "");
    assert.equal(destination.searchParams.get("switch"), "1");
    assert.equal(destination.searchParams.get("returnTo"), "https://media.featheral.com/");
    assert.equal(page.requests.length, 0);
  }
});

test("dedicated login uses password authentication and returns to profile with the original destination", async () => {
  const page = await signupPage({ authenticated: false, pathname: "/login/", search: "?returnTo=%2Fcommunity%2F" });
  assert.equal(page.get("confirmation").hidden, true);
  assert.equal(page.get("credentials-submit").textContent, "Sign in");
  await page.submit("ExistingBuilder", page.password);
  assert.deepEqual(page.requests.map(request => request.route), ["/login"]);
  const destination = new URL(page.redirects.at(-1));
  assert.equal(destination.pathname, "/account/");
  assert.equal(destination.searchParams.get("returnTo"), "/community/");
  assert.equal(page.signers[0].address, page.wallet.address);
});

test("login and registration navigation preserves return URLs without mixing forms or reloading switch indefinitely", async () => {
  const page = await signupPage({ authenticated: false, pathname: "/login/", search: "?returnTo=%2Fcommunity%2F" });
  page.tabs[0].click();
  assert.equal(new URL(page.redirects.at(-1)).pathname, "/register/");
  assert.equal(new URL(page.redirects.at(-1)).searchParams.get("returnTo"), "/community/");
  const switching = await signupPage({ pathname: "/login/", search: "?switch=1&returnTo=%2Fexplore%2F" });
  assert.equal(switching.redirects.length, 0);
  assert.equal(switching.get("profile").hidden, true);
  assert.equal(switching.get("sign-in").hidden, false);
  assert.equal(switching.get("credentials-submit").textContent, "Sign in");
});

test("new-wallet registration finishes credentials before navigating to the separate profile page", async () => {
  const page = await signupPage({ authenticated: false, allowCreate: true });
  page.data.delete("featheral-wallet-public-account");
  page.listeners.get("focus")();
  page.get("credentials").elements.confirmation.value = page.password;
  await page.submit("NewBuilder", page.password);
  assert.deepEqual(page.requests.map(request => request.route), ["/challenge", "/register"]);
  assert.equal(new URL(page.redirects.at(-1)).pathname, "/account/");
  assert.equal(page.get("profile").hidden, true);
  assert.equal(page.data.get("featheral-encrypted-wallet-v1"), page.original);
  assert.equal(page.errors.length, 0);
});

test("continuing to Community does not bootstrap a settlement, while gameplay still does", async () => {
  for (const target of ["/community/", "/explore/"]) {
    const page = await signupPage({ search: "?returnTo=" + encodeURIComponent(target) });
    page.world.snapshot().complete = true;
    await page.get("continue").onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new URL(page.redirects.at(-1)).pathname, target);
    assert.deepEqual(page.requests.map(request => request.route), target === "/explore/" ? ["/game"] : []);
  }
});
test("World continuation connects App and assigned Admin identity without creating a settlement", async () => {
  for (const [site, parameter] of [["app", "worldAppSignIn"], ["admin", "worldAdminSignIn"]]) {
    const target = `http://${site}.localhost/`;
    const page = await signupPage({ pathname: "/account/", search: "?returnTo=" + encodeURIComponent(target) });
    page.world.snapshot().complete = true;
    await page.get("continue").onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(page.requests.map(request => request.route), [`/${site}-handoff`]);
    assert.equal(page.requests[0].input.origin, new URL(target).origin);
    const destination = new URL(page.redirects.at(-1));
    assert.equal(destination.origin, new URL(target).origin);
    assert.equal(destination.searchParams.get(parameter), "one-use-world-code");
  }
});
