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
test("Terminal rejects stale or incomplete HTML before requests, timers or trading handlers start", () => {
  const required = vm.runInNewContext(terminal.slice(terminal.indexOf("const requiredElements ="), terminal.indexOf("const missingElements =")) + ";requiredElements;");
  for (const match of terminal.matchAll(/\$\("([^"]+)"\)/g))
    assert.ok(required.includes(match[1]), `${match[1]} is part of the terminal DOM contract`);
  const html = fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/index.html"), "utf8");
  for (const missing of [["overview-markets", "pending-movements"], ["terminal-status"], ["funding-form"]]) {
    const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], {
      setAttribute(name, value) { this[name] = value; },
    }]));
    missing.forEach(id => nodes.delete(id));
    const errors = [], controls = [{}, {}], forms = [{ addEventListener(type, handler) { this[type] = handler; } }], body = [];
    vm.runInNewContext(terminal, {
      document: { getElementById: id => nodes.get(id) || null, body: { prepend: node => body.push(node) },
        createElement: () => ({ setAttribute(name, value) { this[name] = value; } }),
        querySelectorAll: selector => selector === "form" ? forms : controls },
      console: { error: (...args) => errors.push(args) },
      fetch() { assert.fail("Incompatible HTML must not make requests"); },
      setInterval() { assert.fail("Incompatible HTML must not start refresh timers"); },
    });
    assert.equal(errors.length, 1);
    assert.deepEqual(Array.from(errors[0][1].missingElements), missing);
    assert.ok(controls.every(control => control.disabled));
    let prevented = false; forms[0].submit({ preventDefault() { prevented = true; } });
    assert.ok(prevented, "Enter-key form submissions are also blocked");
    const status = nodes.get("terminal-status") || body[0];
    assert.equal(status.role, "alert");
    assert.match(status.textContent, /Ctrl\+Shift\+R/);
  }
});
async function browserFixture(t, respond = () => null, storage = new Map(), hash = "") {
  const owner = "0x" + "ab".repeat(20), requests = [], confirmations = [], errors = [], histories = [];
  class Element {
    constructor() { this.value = ""; this.children = []; this.listeners = new Map(); this.firstChild = { textContent: "" }; }
    addEventListener(event, handler) {
      const handlers = this.listeners.get(event) || []; handlers.push(handler); this.listeners.set(event, handlers);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    querySelectorAll() { return []; }
  }
  const nodes = new Map([...fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/index.html"), "utf8").matchAll(/id="([^"]+)"/g)]
    .map(match => [match[1], new Element()]));
  const node = id => { assert.ok(nodes.has(id), `Missing terminal node ${id}`); return nodes.get(id); };
  node("order-form").querySelectorAll = () => ["order-side", "order-amount", "order-slippage"].map(node);
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
    location: { protocol: "https:", hostname: "ex.featheral.com", port: "", search: "", hash },
    window: { FeatheralCandleChart: { mount: () => ({ update(value) { histories.push(value); }, reset() {}, sma() {} }) },
      addEventListener() {},
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
  return { owner, requests, confirmations, storage, node, dispatch, errors, histories };
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
    ? { body: { markets: [market, { symbol: "FTHA", funded: true, volume: "0" }], pair: { notes: [market] }, reference: { usdValue: null } } } : null);
  assert.equal(ui.node("spot-price").textContent, "Settlement recovery required");
  assert.match(ui.node("market-detail").textContent, /do not fund a replacement pool/);
  assert.equal(ui.node("market-list").children[0].children[0].textContent, "Recovery required");
  assert.equal(ui.node("market-list").children[1].children[0].textContent, "Reference only");
  assert.equal(ui.node("market-list").children[2].children[0].textContent, "Recovery required");
  assert.equal(ui.node("overview-funded").textContent, "0");
});
test("Market overview sums only actual FTHX volume exactly and excludes recovering pools from executable count", async t => {
  const dollar = { symbol: "FTH$", funded: true, price: null, history: { candles: [] } };
  const ui = await browserFixture(t, route => route.startsWith("/trading/markets")
    ? { body: { markets: [dollar, { symbol: "FTHA", funded: true, volume: "9007199254740993" },
      { symbol: "FTHB", funded: true, pendingSettlement: true, volume: "7" }],
    pair: { notes: [dollar], volumeFthx: "11" }, reference: { usdValue: null } } } : null);
  assert.equal(ui.node("overview-markets").textContent, "3");
  assert.equal(ui.node("overview-funded").textContent, "2");
  assert.equal(ui.node("overview-volume").textContent, `${9007199254741011n.toLocaleString()} FTHX`);
});
test("Missing volume is explicitly unavailable rather than displayed as zero", async t => {
  const ui = await browserFixture(t);
  assert.equal(ui.node("overview-volume").textContent, "Unavailable");
});
test("Primary markets are pinned and FTHG uses exact reference composition without invented trades or internal orders", async t => {
  const dollar = { symbol: "FTH$", funded: false, price: null, history: { candles: [] } };
  const ui = await browserFixture(t, route => route.startsWith("/trading/markets") ? { body: {
    markets: [dollar, { symbol: "ART", funded: false, volume: "5" }, { symbol: "FTHS", funded: false, volume: "0" }],
    pair: { notes: [dollar], volumeFthx: "0" },
    reference: { usdValue: null, goldReference: require("../../notes/exchange-price").publicGoldReference({
      dollars: 10000n * 10n ** 18n, fthg: 10n ** 18n, source: "opening" }),
      dollarReference: require("../../notes/exchange-price").publicReference({ funded: false, version: 0, dollars: "0", fthx: 0 }) },
  } } : route.startsWith("/markets/") && route.includes("/history") ? { body: { candles: [] } } : null);
  assert.deepEqual(ui.node("market-list").children.map(button => button.textContent), ["FTH$", "FTHG", "FTHS", "ART"]);
  await ui.dispatch(ui.node("market-list").children[1], "click");
  assert.equal(ui.node("market-title").textContent, "FTHG / FTHX");
  assert.equal(ui.node("spot-price").textContent, "Indicative 1000000 FTHX");
  assert.equal(ui.histories.at(-1).referenceOnly, true);
  assert.equal(ui.histories.at(-1).candles.length, 0);
  assert.equal(ui.node("order-amount").disabled, true);
  assert.match(ui.node("market-mode").textContent, /No internal FTHG pool/);
  assert.equal(ui.requests.filter(request => request.route.includes("/markets/FTHG/history")).length, 0);
  await ui.dispatch("order-form");
  assert.match(ui.node("terminal-status").textContent, /reference-only/);
  assert.equal(ui.requests.filter(request => request.route === "/trading/quote").length, 0);
  await ui.dispatch(ui.node("market-list").children[2], "click");
  assert.equal(ui.node("market-title").textContent, "FTHS / FTHX");
  assert.equal(ui.node("order-amount").disabled, false);
  assert.equal(ui.node("overview-volume").textContent, "5 FTHX", "Reference-only Gold has no fabricated volume");
});
test("Unavailable Gold references stay unavailable and expose missing underlying snapshots", async t => {
  const ui = await browserFixture(t);
  await ui.dispatch(ui.node("market-list").children[1], "click");
  assert.equal(ui.node("spot-price").textContent, "Reference unavailable");
  assert.ok(ui.node("gold-pool-details").children.some(node => node.textContent.includes("Gold reserve snapshot unavailable")));
});

class VisualElement {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.value = ""; this.dataset = {}; this.style = {};
    this.className = ""; this.listeners = {}; this.isConnected = true;
    this.classList = { add: name => { this.className += " " + name; } };
  }
  append(...children) { children.forEach(child => { child.parentElement = this; }); this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get options() { return this.children; }
}
const descendants = root => [root, ...root.children.flatMap(descendants)];
test("Empty candle chart is illustrative, labeled, and never draws data candles or volume", () => {
  const root = new VisualElement("div"), context = { window: {},
    document: { createElement: tag => new VisualElement(tag), createElementNS: (_, tag) => new VisualElement(tag) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/chart.js"), "utf8"), context);
  context.window.FeatheralCandleChart.mount(root).update({ candles: [] });
  const all = descendants(root);
  assert.ok(all.some(node => node.textContent?.includes("No executed candles yet")));
  assert.equal(all.filter(node => node.tag === "rect").length, 1, "Only the placeholder background, not candles");
  assert.ok(all.some(node => node.textContent?.includes("Empty periods are not fabricated")));
});
test("Liquidity visuals use exact reserves, independent capped targets, honest statuses and currency filters", async () => {
  const root = new VisualElement("section"), errors = [], markets = [
    { symbol: "FTH$", status: "unfunded", baseReserve: "0", tokenReserve: "0", initialTarget: null, feeBps: 30 },
    { symbol: "FTHA", status: "funded", baseReserve: "2000000", tokenReserve: "500000", initialTarget: { FTHX: "1000000", notes: "1000000" }, feeBps: 30 },
    { symbol: "FTHB", status: "recovery-required", baseReserve: "9007199254740993", tokenReserve: "0", initialTarget: null, feeBps: 30 },
  ];
  const script = fs.readFileSync(path.join(__dirname, "../../../shared/market-activity.js"), "utf8");
  const responses = {
    activity: { rows: [], summary: [], buckets: [], from: 0, to: 1, coverage: {}, nextCursor: null },
    liquidity: { markets, policy: "Existing funds only." },
    "market-tape": { rows: [], description: "Executed legs only." },
  };
  vm.runInNewContext(script, {
    document: { querySelectorAll: () => [root], createElement: tag => new VisualElement(tag) },
    location: { protocol: "https:", hostname: "notes.featheral.com", port: "" },
    URLSearchParams, AbortController, setInterval() {}, console: { error: (...args) => errors.push(args) },
    fetch: async url => ({ ok: true, json: async () => responses[url.split("/").at(-1).split("?")[0]] }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  const cards = () => descendants(root).filter(node => node.className === "liquidity-card");
  assert.equal(cards().length, 3);
  assert.equal(cards()[0].dataset.state, "funded");
  assert.deepEqual(descendants(cards()[0]).filter(node => node.style.width).map(node => node.style.width), ["100%", "50%"]);
  assert.ok(descendants(root).some(node => node.textContent === "No initial target defined / reserve shown unscaled"));
  assert.ok(descendants(root).some(node => node.textContent === `${9007199254740993n.toLocaleString()} FTHX`));
  assert.ok(descendants(root).some(node => node.textContent === "Awaiting approved initial funding. No executable price."));
  assert.ok(descendants(root).some(node => node.href === "https://ex.featheral.com/?market=FTHA"));
  assert.ok(descendants(root).some(node => node.textContent === "Fund and enable" && node.href === "https://ex.featheral.com/?market=FTH%24#initial-dollar-funding"));
  assert.equal(cards().filter(card => card.dataset.state !== "unfunded").flatMap(descendants).filter(node => node.textContent === "Fund and enable").length, 0);
  assert.ok(descendants(root).some(node => node.className === "activity-empty"));
  const currency = descendants(root).find(node => node.attributes["aria-label"] === "Currency");
  currency.value = "FTHG"; currency.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cards().length, 0);
  assert.ok(descendants(root).some(node => node.textContent?.includes("FTHG uses the separate Gold conversion channel")));
  currency.value = "";
  responses.liquidity.markets = [...markets, ...Array.from({ length: 5 }, (_, i) => ({ ...markets[0], symbol: `FTH${i}` }))];
  currency.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cards().length, 8, "Every underlying pool is visible without a six-pool cap");
  assert.ok(descendants(root).some(node => node.href === "https://admin.featheral.com/#/notes?site=ex.featheral.com&market=FTH0"));
});
test("Funding deep link opens the review form without submitting a funding request", async t => {
  const ui = await browserFixture(t, undefined, undefined, "#initial-dollar-funding");
  assert.equal(ui.node("initial-dollar-funding").open, true);
  assert.equal(ui.requests.filter(request => request.route === "/dollar-pool/fund").length, 0);
});
test("Pools workspace reads only reserves, keeps every pool and never requests unrelated history", async () => {
  const root = new VisualElement("section"), requests = [], errors = [];
  root.dataset.marketView = "pools";
  const markets = Array.from({ length: 9 }, (_, i) => ({
    symbol: `FTH${i}`, status: "unfunded", baseReserve: "0", tokenReserve: "0", initialTarget: null, feeBps: 30,
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../shared/market-activity.js"), "utf8"), {
    document: { querySelectorAll: () => [root], createElement: tag => new VisualElement(tag) },
    location: { protocol: "https:", hostname: "ex.featheral.com", port: "" },
    URLSearchParams, AbortController, setInterval() {}, console: { error: (...args) => errors.push(args) },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ markets, policy: "Existing funds only." }) }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, ["/api/creation/liquidity"]);
  assert.equal(descendants(root).filter(node => node.className === "liquidity-card").length, 9);
  assert.ok(descendants(root).filter(node => ["Window", "Activity"].includes(node.textContent)).every(node => node.hidden));
});
test("Activity workspace keeps source-separated native charts visible while Notes collapses only detailed records", async () => {
  const root = new VisualElement("section"), requests = [], errors = [];
  root.dataset.marketView = "activity"; root.dataset.marketRecords = "collapsed";
  const summary = ["world", "gold"].map(source => ({
    symbol: "FTH$", source, recordType: "transaction", events: 1, credits: "100", debits: "0",
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../shared/market-activity.js"), "utf8"), {
    document: { querySelectorAll: () => [root], createElement: tag => new VisualElement(tag), createElementNS: (_, tag) => new VisualElement(tag) },
    location: { protocol: "https:", hostname: "notes.featheral.com", port: "" },
    URLSearchParams, AbortController, setInterval() {}, console: { error: (...args) => errors.push(args) },
    fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => url.includes("market-tape") ? { rows: [], description: "Executed legs only." }
        : { rows: [], summary, buckets: summary.map(row => ({ ...row, at: 0 })), bucketMs: 86400000,
          from: 0, to: 86400000, coverage: {}, nextCursor: null } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.includes("liquidity")));
  assert.ok(requests.every(url => url.includes("interval=all")));
  const charts = root.children.find(node => node.className === "market-activity-charts");
  assert.ok(charts, "Charts remain visible, outside the detailed-record disclosure.");
  assert.equal(charts.children.length, 2);
  assert.ok(charts.children.every(card => descendants(card).filter(node => node.tag === "rect").length === 1));
  assert.ok(root.children.some(node => node.tag === "details" && descendants(node).some(child => child.tag === "table")));
});
test("Disconnect restores connection placeholders with correctly sized table cells", async t => {
  const ui = await browserFixture(t);
  await ui.dispatch("disconnect", "click");
  for (const [id, columns] of [["positions", 2], ["trade-history", 5], ["movement-history", 4]]) {
    const cell = ui.node(id).children[0].children[0];
    assert.match(cell.textContent, /^Connect to view/);
    assert.equal(cell.colSpan, columns);
  }
});
