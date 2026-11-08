"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { ethers } = require("ethers");
const source = fs.readFileSync(path.join(__dirname, "../../../shared/world-account.js"), "utf8");
function fixture() {
  const wallet = ethers.Wallet.createRandom(), listeners = new Map(), timers = new Map(), approvals = [];
  let now = 1000, timerId = 0, decrypts = 0, account = wallet.address, csrf = "ab".repeat(32), decrypt;
  const window = {
    addEventListener: (type, handler) => listeners.set(type, handler), dispatchEvent() {},
    FeatheralWallet: { approveSignature(input) {
      return new Promise((resolve, reject) => approvals.push({ input, resolve, reject }));
    } },
  };
  const context = vm.createContext({
    window, URL, AbortSignal, CustomEvent, TextDecoder, TextEncoder, Uint8Array, console,
    location: { hostname: "world.localhost", origin: "http://world.localhost", href: "http://world.localhost/", port: "" },
    Date: class extends Date { static now() { return now; } },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    ethers: { ...ethers, Wallet: { fromEncryptedJson: async (_backup, password) => {
      decrypts++;
      if (password !== "correct") throw new Error("Incorrect password");
      return decrypt ? await decrypt() : wallet;
    } } },
    fetch: async url => Response.json(url.endsWith("/backup") ? { keystore: "encrypted" }
      : { account, csrf, walletType: "built-in", complete: true }),
  });
  vm.runInContext(source, context);
  const world = window.FeatheralWorldAccount;
  return {
    world, wallet, approvals, listeners, timers, decrypts: () => decrypts,
    advance: ms => { now += ms; }, switch: () => { account = ethers.Wallet.createRandom().address; },
    decrypt: callback => { decrypt = callback; },
    sign: () => world.provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes("Exact request")), account] }),
    approve: async (index, password = "") => {
      const approval = approvals[index];
      try { approval.resolve(await approval.input.sign(password)); } catch (error) { approval.reject(error); }
    },
  };
}
test("World unlock is reused for 30 minutes of inactivity but every signature requires wallet approval", async () => {
  const h = fixture(); await h.world.refresh();
  const first = h.sign(); assert.equal(h.approvals[0].input.passwordRequired(), true);
  await h.approve(0, "correct"); assert.equal(ethers.verifyMessage("Exact request", await first), h.wallet.address);
  const second = h.sign(); assert.equal(h.approvals[1].input.passwordRequired(), false);
  await h.approve(1); await second; assert.equal(h.decrypts(), 1);
  h.advance(1799999);
  h.listeners.get("pointerdown")({ isTrusted: true });
  h.advance(1799999);
  const third = h.sign(); assert.equal(h.approvals[2].input.passwordRequired(), false);
  await h.approve(2); await third;
  h.advance(1800000);
  const expired = h.sign(); assert.equal(h.approvals[3].input.passwordRequired(), true);
  await h.approve(3, "correct"); await expired; assert.equal(h.decrypts(), 2);
  h.world.lock(); assert.equal(h.timers.size, 0);
});
test("World sign-out, wallet changes, page closure and explicit locking discard the cached key", async () => {
  for (const action of ["logout", "account", "pagehide", "manual"]) {
    const h = fixture(); await h.world.refresh(); h.world.setSigner(h.wallet);
    if (action === "logout") await h.world.request("/logout", {});
    if (action === "account") { h.switch(); await h.world.refresh(); }
    if (action === "pagehide") h.listeners.get("pagehide")();
    if (action === "manual") h.listeners.get("featheral:wallet-lock")();
    const pending = h.sign(); assert.equal(h.approvals[0].input.passwordRequired(), true);
    h.approvals[0].reject(new Error("Rejected")); await assert.rejects(pending, /Rejected/);
    assert.equal(h.timers.size, 0);
  }
});
test("cancellation during decryption cannot cache a key or return a signature", async () => {
  const h = fixture(); await h.world.refresh();
  let release; h.decrypt(() => new Promise(resolve => { release = resolve; }));
  const pending = h.sign(), rejection = assert.rejects(pending, /locked or changed/);
  const approving = h.approve(0, "correct"); await new Promise(setImmediate);
  h.approvals[0].input.cancel(); release(h.wallet); await approving; await rejection;
  assert.equal(h.timers.size, 0);
});
