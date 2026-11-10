"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const terminal = fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/terminal.js"), "utf8");
const helpers = vm.runInNewContext(terminal.slice(terminal.indexOf("const decimals ="), terminal.indexOf("async function api(")) + ";({amount,format,ratio});");
test("Exchange terminal parses exact whole notes and 18-decimal dollars without Number balance arithmetic", () => {
  assert.equal(helpers.amount("1.234567890123456789", "FTH$"), "1234567890123456789");
  assert.equal(helpers.amount("9007199254740993", "FTHX"), "9007199254740993");
  for (const [value, symbol] of [["1.1", "FTHX"], ["1.0000000000000000001", "FTH$"], ["-1", "FTH$"], ["1e3", "FTHX"], ["0", "FTHX"]])
    assert.throws(() => helpers.amount(value, symbol));
  assert.equal(helpers.format("9999000000000000000", "FTH$"), "10 FTH$");
  assert.equal(helpers.format("1", "FTH$"), "<0.01 FTH$");
  assert.equal(helpers.format("1234567890123456789", "FTH$"), "1.23 FTH$");
  assert.equal(helpers.ratio({ numerator: "1", denominator: "1000000000" }), "<0.01");
});
test("Exchange terminal keeps signing sessions in memory and preserves submitted request IDs across uncertain retries", () => {
  assert.doesNotMatch(terminal, /localStorage|featheral-creation-token|markets\/trade/);
  assert.match(terminal, /sessionStorage\.setItem\(`featheral-exchange-pending:\$\{owner\}:trade`/);
  assert.match(terminal, /!preview\.submitted && preview\.expires/);
  assert.match(terminal, /FeatheralWallet\.authenticate\(address => api\("\/challenge"/);
  assert.doesNotMatch(terminal, /eth_requestAccounts|featheral:exchange-auth|builtin-connect/);
});
async function browserFixture(t, respond = () => null, storage = new Map()) {
  const owner = "0x" + "ab".repeat(20), requests = [], confirmations = [], errors = [];
  class Element {
    constructor() { this.value = ""; this.children = []; this.listeners = new Map(); this.firstChild = { textContent: "" }; }
    addEventListener(event, handler) {
      const handlers = this.listeners.get(event) || []; handlers.push(handler); this.listeners.set(event, handlers);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
  }
  const nodes = new Map([...fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/index.html"), "utf8").matchAll(/id="([^"]+)"/g)]
    .map(match => [match[1], new Element()]));
  const node = id => { assert.ok(nodes.has(id), `Missing terminal node ${id}`); return nodes.get(id); };
  node("chart-interval").value = "24h"; node("order-side").value = "buy";
  const market = { symbol: "FTH$", funded: false, price: null, history: { candles: [] } };
  const defaults = route => {
    if (route.startsWith("/trading/markets")) return { markets: [market], pair: { notes: [market] }, reference: { usdValue: null } };
    if (route === "/trading/account") return { holdings: [], trades: [], movements: [], portfolio: { usd: null } };
    if (route === "/markets/account") return { positions: [] };
    if (route === "/challenge") return { message: "Challenge" };
    if (route === "/login") return { address: owner, token: "fixture-token" };
    if (route === "/logout") return { ok: true };
    throw Error(`Unexpected terminal request: ${route}`);
  };
  vm.runInNewContext(terminal, {
    document: { getElementById: node, createElement: () => new Element(), querySelectorAll: () => [], hidden: false },
    location: { protocol: "https:", hostname: "ex.featheral.com", port: "", search: "" },
    window: { FeatheralCandleChart: { mount: () => ({ update() {}, reset() {}, sma() {} }) },
      FeatheralWallet: { authenticate: async challenge => { await challenge(owner); return { address: owner, signature: "login-signature" }; } },
      ethereum: { on() {}, request: async ({ method }) => method === "eth_accounts" ? [owner] : "payment-signature" } },
    URLSearchParams, TextEncoder, crypto: require("node:crypto"), setInterval() {},
    console: { error: (...args) => errors.push(args) },
    confirm: message => { confirmations.push(message); return true; },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => {
      const route = url.slice("/api/creation".length), body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ route, body });
      const response = await respond(route, body);
      return { ok: !response?.status || response.status < 400, status: response?.status || 200,
        json: async () => response ? response.body : defaults(route) };
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const dispatch = async (id, event = "submit") => {
    const element = typeof id === "string" ? node(id) : id;
    for (const handler of element.listeners.get(event) || []) await handler({ preventDefault() {} });
    await settle();
  };
  await settle();
  await dispatch("provider-connect", "click");
  assert.equal(errors.length, 0, "Terminal initializes and connects");
  return { owner, requests, confirmations, storage, node, dispatch, errors };
}
test("Initial funding is wired at startup exactly once and resumes saved parameters despite edited form inputs", async t => {
  let submissions = 0;
  const ui = await browserFixture(t, (route, body) => {
    if (route === "/dollar-pool/fund") {
      submissions++;
      return submissions === 1 ? { status: 503, body: { error: "Receipt unavailable" } } : { body: { id: "funding-fixture", status: "prepared", message: "Approve funding" } };
    }
    if (route === "/dollar-pool/funding-fixture/complete") return { body: { status: "complete" } };
    return null;
  });
  assert.equal(ui.node("funding-form").listeners.get("submit").length, 1);
  const dollars = "1000000000000000000";
  ui.node("funding-dollar").value = "1"; ui.node("funding-fthx").value = "100";
  ui.node("funding-approval").value = `FUND FTH$ ${dollars} BASE_UNITS 100 FTHX`;
  await ui.dispatch("funding-form");
  const key = `featheral-exchange-pending:${ui.owner}:funding`, original = JSON.parse(ui.storage.get(key));
  assert.match(ui.node("terminal-status").textContent, /Receipt unavailable/);
  ui.node("funding-dollar").value = "2"; ui.node("funding-fthx").value = "999";
  await ui.dispatch("funding-form");
  const fundingRequests = ui.requests.filter(request => request.route === "/dollar-pool/fund");
  assert.equal(fundingRequests.length, 2);
  assert.deepEqual(fundingRequests[1].body, original);
  assert.equal(ui.storage.has(key), false);
  assert.match(ui.confirmations.at(-1), /Resume the previous funding request/);
  assert.equal(ui.node("funding-form").listeners.get("submit").length, 1);
});
test("Lost movement receipts retain identity and expose recovery without replacing requests when amounts change", async t => {
  let deposits = 0;
  const ui = await browserFixture(t, route => {
    if (route === "/trading/deposit") return ++deposits === 1
      ? { status: 503, body: { error: "Receipt lost" } } : { body: { status: "complete" } };
    if (route.startsWith("/trading/operations/")) return { body: { status: "complete" } };
    return null;
  });
  ui.node("deposit-amount").value = "100";
  await ui.dispatch("deposit-form");
  const key = `featheral-exchange-pending:${ui.owner}:deposit`, original = JSON.parse(ui.storage.get(key));
  assert.equal(ui.node("pending-movements").children.length, 1);
  ui.node("deposit-amount").value = "200";
  await ui.dispatch("deposit-form");
  assert.deepEqual(ui.requests.filter(request => request.route === "/trading/deposit").map(request => request.body), [original, original]);
  assert.equal(ui.storage.has(key), false);
  assert.equal(ui.node("pending-movements").children.length, 0);
  assert.match(ui.confirmations.at(-1), /previous request first.*100 FTHX/);
});
test("Rejected movements clear only after an authoritative missing-operation response", async t => {
  let lookupStatus = 503;
  const ui = await browserFixture(t, route => {
    if (route === "/trading/deposit") return { status: 402, body: { error: "Insufficient FTHX" } };
    if (route.startsWith("/trading/operations/")) return { status: lookupStatus, body: { error: "Recovery unavailable" } };
    return null;
  });
  ui.node("deposit-amount").value = "100";
  await ui.dispatch("deposit-form");
  const key = `featheral-exchange-pending:${ui.owner}:deposit`;
  assert.equal(ui.storage.has(key), true);
  assert.match(ui.node("terminal-status").textContent, /Recovery status could not be verified/);
  lookupStatus = 404;
  await ui.dispatch("deposit-form");
  assert.equal(ui.storage.has(key), false);
  assert.match(ui.node("terminal-status").textContent, /Insufficient FTHX/);
});
test("Reloaded funding and liquidity requests resume without requiring empty forms to pass validation", async t => {
  const owner = "0x" + "ab".repeat(20), storage = new Map();
  const funding = { dollars: "1000000000000000000", fthx: "100", approval: "FUND FTH$ 1000000000000000000 BASE_UNITS 100 FTHX", requestId: "saved-funding-request01" };
  const liquidity = { symbol: "FTHA", action: "add", amount: 10, base: 10, notes: 10, shares: 10, requestId: "saved-liquidity-request1" };
  storage.set(`featheral-exchange-pending:${owner}:funding`, JSON.stringify(funding));
  storage.set(`featheral-exchange-pending:${owner}:liquidity`, JSON.stringify(liquidity));
  const ui = await browserFixture(t, route => {
    if (route === "/dollar-pool/fund") return { body: { status: "complete" } };
    if (route === "/markets/liquidity") return { status: 409, body: { error: "Liquidity changed" } };
    return null;
  }, storage);
  assert.equal(ui.node("pending-movements").children.length, 2);
  const fundingButton = ui.node("pending-movements").children[1].children[0];
  await ui.dispatch(fundingButton, "click");
  assert.deepEqual(ui.requests.find(request => request.route === "/dollar-pool/fund").body, funding);
  assert.equal(storage.has(`featheral-exchange-pending:${owner}:funding`), false);
  const liquidityButton = ui.node("pending-movements").children[0].children[0];
  await ui.dispatch(liquidityButton, "click");
  assert.deepEqual(ui.requests.find(request => request.route === "/markets/liquidity").body, liquidity);
  assert.equal(storage.has(`featheral-exchange-pending:${owner}:liquidity`), false);
  assert.match(ui.node("terminal-status").textContent, /Liquidity changed/);
});
test("A settling Dollar market is labeled for recovery, not for fresh funding", async t => {
  const market = { symbol: "FTH$", funded: false, pendingSettlement: true, price: null, history: { candles: [] } };
  const ui = await browserFixture(t, route => route.startsWith("/trading/markets")
    ? { body: { markets: [market], pair: { notes: [market] }, reference: { usdValue: null } } } : null);
  assert.equal(ui.node("spot-price").textContent, "Settlement recovery required");
  assert.match(ui.node("market-detail").textContent, /do not fund a replacement pool/);
  assert.equal(ui.node("market-list").children[0].children[0].textContent, "Recovery required");
});
