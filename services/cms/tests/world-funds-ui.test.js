"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../../sites/world.featheral.com/world-funds.js"), "utf8");
const wallet = "0x" + "11".repeat(20), account = "0x" + "ab".repeat(32), csrf = "cd".repeat(32);
const tick = () => new Promise(setImmediate);
function harness({ mode = "separate", builtIn = false, loseReceipt = false } = {}) {
  const nodes = new Map(), posts = [], signed = [], errors = [], saved = new Map(), listeners = new Map(), requests = new Map();
  const node = () => ({ value: "", hidden: false, disabled: false, textContent: "", children: [], classList: { add() {} },
    append(value) { this.children.push(value); }, replaceChildren() { this.children = []; }, setAttribute() {}, focus() {} });
  const get = name => { if (!nodes.has(name)) nodes.set(name, node()); return nodes.get(name); };
  const root = { ...node(), querySelector: selector => get(selector.match(/data-wf="([^"]+)"/)[1]), isConnected: true, getClientRects: () => [1], closest: () => null };
  let currentWallet = wallet, failed = false, settles = 0, interval;
  const view = { accountId: account, wallet, mode, csrf, available: "3000000000000000000", walletAvailable: "1234567890000000000", requests: [] };
  const window = {
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name),
    dispatchEvent() {},
    FeatheralWallet: { authenticate: async challenge => { const result = await challenge(wallet); signed.push(result.message); return { signature: "signature" }; } },
  };
  if (builtIn) window.FeatheralWorldAccount = {
    refresh: async () => ({ account: currentWallet }), snapshot: () => ({ account: currentWallet }),
    provider: { request: async ({ params }) => { signed.push(Buffer.from(params[0].slice(2), "hex").toString()); return "signature"; } },
  };
  vm.runInNewContext(source, {
    window, document: { querySelector: () => null, createElement: node, hidden: false },
    location: { href: "https://world.featheral.com/bank/" }, BigInt, TextEncoder, AbortController,
    Event: class {}, CustomEvent: class {}, crypto: { randomUUID: () => `request-${requests.size + 1}` },
    localStorage: { setItem: (key, value) => saved.set(key, value) }, console: { error: error => errors.push(error), warn() {} },
    setTimeout, clearTimeout, setInterval: handler => { interval = handler; return 1; }, clearInterval() {}, confirm: () => true,
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      let data = { ...view, requests: [...requests.values()] }, ok = true;
      if (body) {
        assert.equal(options.headers["X-CSRF-Token"], csrf);
        posts.push({ url, body });
      }
      if (url.endsWith("/prepare")) {
        if (!requests.has(body.id)) requests.set(body.id, { id: body.id, parameters: { direction: body.direction, amount: body.amount }, wallet,
          message: "Exact transfer", status: "prepared", at: Date.now() });
        data = requests.get(body.id);
      } else if (url.endsWith("/complete")) {
        const item = requests.get(body.id);
        if (item.status !== "complete") {
          const amount = BigInt(item.parameters.amount), deposit = item.parameters.direction === "deposit";
          view.available = (BigInt(view.available) + (deposit ? amount : -amount)).toString();
          view.walletAvailable = (BigInt(view.walletAvailable) + (deposit ? -amount : amount)).toString();
          item.status = "complete";
        }
        if (loseReceipt && !failed) { failed = true; ok = false; data = { error: "Receipt unavailable. Retry." }; }
        else data = { ...view, requests: [...requests.values()] };
      } else if (url.endsWith("/cancel")) requests.get(body.id).status = "cancelled";
      return { ok, status: ok ? 200 : 503, headers: { get: () => "application/json" }, json: async () => data };
    },
  });
  const panel = window.FeatheralWorldFunds.mount(root, { onSettled: async () => { settles++; } });
  return { get, root, panel, window, view, requests, posts, signed, saved, errors, listeners, interval: () => interval(),
    changeWallet: value => { currentWallet = value; }, settles: () => settles };
}
test("exact transfer amounts preserve dust and reject malformed or zero values", () => {
  const h = harness(), model = h.window.FeatheralWorldFunds;
  for (const text of ["0", "-1", "1e2", "1.0000000000000000001", "", "Infinity"]) assert.throws(() => model.amountUnits(text));
  for (const text of ["0.000000000000000001", "1.23456789", "999999999999.123456789012345678"]) assert.equal(model.exact(model.amountUnits(text)), text);
  h.panel.dispose();
});
test("integrated review preserves exact Max, recovers lost receipts with the same ID, and syncs balances", async () => {
  const h = harness({ builtIn: true, loseReceipt: true }); await h.panel.refresh();
  assert.equal(h.saved.get("featheral-world-account"), account);
  h.get("max").onclick(); assert.equal(h.get("amount").value, "1.23456789");
  assert.match(h.get("preview").textContent, /Game 4\.23.*Wallet 0/);
  h.get("form").onsubmit({ preventDefault() {} }); await tick();
  assert.equal(h.get("review").hidden, false); assert.equal(h.posts.length, 1);
  h.get("approve").onclick(); await tick();
  assert.match(h.get("status").textContent, /Receipt unavailable/);
  h.get("approve").onclick(); await tick();
  const completions = h.posts.filter(post => post.url.endsWith("/complete"));
  assert.equal(completions.length, 2); assert.equal(completions[0].body.id, completions[1].body.id);
  assert.equal(h.view.available, "4234567890000000000"); assert.equal(h.view.walletAvailable, "0");
  assert.match(h.get("status").textContent, /Transfer settled/); assert.equal(h.settles(), 1);
  h.get("withdraw").onclick(); h.get("max").onclick(); assert.equal(h.get("amount").value, "4.23456789");
  h.get("form").onsubmit({ preventDefault() {} }); await tick(); h.get("approve").onclick(); await tick();
  assert.equal(h.view.available, "0"); assert.equal(h.view.walletAvailable, "4234567890000000000");
  assert.equal(h.saved.has("featheral-wallet-updated"), true); h.panel.dispose();
});
test("wallet changes block signing and duplicate submissions prepare only one request", async () => {
  const h = harness({ builtIn: true }); await h.panel.refresh();
  h.get("amount").value = "1";
  h.get("form").onsubmit({ preventDefault() {} }); h.get("form").onsubmit({ preventDefault() {} }); await tick();
  assert.equal(h.posts.filter(post => post.url.endsWith("/prepare")).length, 1);
  h.changeWallet("0x" + "22".repeat(20)); h.get("approve").onclick(); await tick();
  assert.equal(h.posts.filter(post => post.url.endsWith("/complete")).length, 0);
  assert.match(h.get("status").textContent, /linked to this settlement/); h.panel.dispose();
});
test("legacy direct mode keeps a single shared balance and does not enable transfers automatically", async () => {
  const h = harness({ mode: "legacy-direct" }); await h.panel.refresh();
  assert.equal(h.get("form").hidden, true); assert.match(h.get("mode").textContent, /same balance/);
  assert.equal(h.posts.length, 0); assert.equal(h.get("authorize").hidden, false); h.panel.dispose();
});
test("visible polling refreshes balances and disposing removes event listeners", async () => {
  const h = harness(); await h.panel.refresh(); h.view.available = "1000000000000000001";
  h.interval(); await tick(); assert.equal(h.get("world").textContent, "1 FTH$");
  h.panel.dispose(); assert.equal(h.listeners.size, 0);
});
test("a durable paying request resumes without another wallet signature", async () => {
  const h = harness(); await h.panel.refresh();
  h.requests.set("paying-request", { id: "paying-request", status: "paying", wallet, message: "Already signed",
    parameters: { direction: "withdraw", amount: "1000000000000000000" }, at: Date.now() });
  await h.panel.refresh();
  h.get("pending").children[0].onclick(); await tick();
  assert.equal(h.get("approve").textContent, "Check and finish settlement");
  assert.match(h.get("summary").textContent, /Game budget → Dollar wallet: 1 FTH\$/);
  h.get("approve").onclick(); await tick();
  assert.equal(h.signed.length, 0);
  assert.equal(h.posts.find(post => post.url.endsWith("/complete")).body.signature, "");
  assert.equal(h.view.available, "2000000000000000000"); h.panel.dispose();
});
test("an unsigned preparation is cancelled without moving any balances", async () => {
  const h = harness(); await h.panel.refresh();
  h.get("amount").value = "1"; h.get("form").onsubmit({ preventDefault() {} }); await tick(); await h.panel.refresh();
  h.get("pending").children[1].onclick(); await tick();
  assert.equal(h.requests.values().next().value.status, "cancelled");
  assert.equal(h.view.available, "3000000000000000000"); assert.equal(h.signed.length, 0); h.panel.dispose();
});
test("legacy central wallet signing remains available and account changes clear reviewed transfers", async () => {
  const h = harness(); await h.panel.refresh();
  h.get("amount").value = "1"; h.get("form").onsubmit({ preventDefault() {} }); await tick();
  h.get("approve").onclick(); await tick(); assert.deepEqual(h.signed, ["Exact transfer"]);
  h.get("amount").value = "0.5"; h.get("form").onsubmit({ preventDefault() {} }); await tick();
  h.view.wallet = "0x" + "22".repeat(20); h.view.accountId = "0x" + "ef".repeat(32);
  await h.panel.refresh(); assert.equal(h.get("review").hidden, true); assert.equal(h.get("amount").value, "");
  h.panel.dispose();
});
test("Account, Bank and the legacy page mount the same transfer implementation", () => {
  const accountSource = fs.readFileSync(path.join(__dirname, "../../../sites/world.featheral.com/play/src/account.ts"), "utf8");
  const bankSource = fs.readFileSync(path.join(__dirname, "../../../sites/world.featheral.com/play/src/wallet-view.ts"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../../../sites/world.featheral.com/world-funds.html"), "utf8");
  assert.match(accountSource, /data-account-funds/); assert.match(bankSource, /data-game-funds/);
  assert.match(accountSource, /FeatheralWorldFunds!\.mount/); assert.match(bankSource, /FeatheralWorldFunds!\.mount/);
  assert.doesNotMatch(accountSource, /href="\/world-funds.html"/);
  assert.match(page, /data-world-funds/); assert.match(page, /world-account.js/);
  assert.match(source, /request\("\/game", \{\}\)/);
});
