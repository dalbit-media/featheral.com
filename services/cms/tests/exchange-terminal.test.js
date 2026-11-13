"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const terminal = fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/terminal.js"), "utf8");
const helpers = vm.runInNewContext(terminal.slice(terminal.indexOf("const decimals ="), terminal.indexOf("async function api(")) + ";({amount,format,ratio});");
const viewContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/market-view.js"), "utf8"), viewContext);
const marketView = viewContext.window.FeatheralMarketView;
test("Terminal statistics compare exact recorded ratios and never manufacture an empty 24h change", () => {
  const price = (numerator, denominator = "1") => ({ numerator, denominator });
  const first = { open: price("9007199254740993"), high: price("9007199254740994"), low: price("9007199254740992"), close: price("9007199254740993") };
  const last = { open: first.close, high: price("18014398509481986"), low: first.open, close: price("18014398509481986") };
  const stats = marketView.statistics({ candles: [first, last] });
  assert.equal(stats.change, "+100.00%");
  assert.equal(stats.high, last.high); assert.equal(stats.low, first.low);
  assert.equal(marketView.statistics({ candles: [] }), null);
  assert.equal(marketView.statistics({ candles: [{ ...first, close: price("9007199254740994") }] }).change, "+<0.01%");
  assert.equal(marketView.statistics({ candles: [{ ...first, close: price("9007199254740992") }] }).change, "-<0.01%");
  assert.throws(() => marketView.statistics({ candles: [{ ...first, high: price("1", "0") }] }), /invalid/);
});
test("Reserve depth respects whole note rounding, Dollar scales, empty pools and settlement recovery", () => {
  const market = { symbol: "FTHA", funded: true, baseReserve: 1000000, noteReserve: 1000000 };
  const levels = marketView.depth(market);
  assert.equal(levels.length, 12);
  assert.equal(levels[0].input, "1000"); assert.equal(levels[0].output, "996");
  assert.equal(levels[0].quantity, "996"); assert.equal(levels[0].total, "1000");
  assert.equal(levels[6].quantity, "1000"); assert.equal(levels[6].total, "996");
  assert.equal(marketView.depth({ ...market, funded: false }).length, 0);
  assert.equal(marketView.depth({ ...market, pendingSettlement: true }).length, 0);
  assert.equal(marketView.depth({ ...market, baseReserve: 1, noteReserve: 1 }).length, 0);
  const tiny = marketView.depth({ ...market, baseReserve: 10 });
  assert.equal(tiny[0].input, "1");
  assert.equal(tiny[0].output, "90661");
  assert.equal(tiny[0].width, 100);
  assert.throws(() => marketView.depth({ ...market, baseReserve: 0 }), /positive/);
  const dollars = { symbol: "FTH$", funded: true }, pool = { settlementEnabled: true, fthx: 1000000, dollars: "10000000000000000000000" };
  const dollarLevels = marketView.depth(dollars, pool);
  assert.equal(dollarLevels.length, 12);
  assert.equal(dollarLevels[0].price.numerator, "1000000000000000000000");
  assert.equal(dollarLevels[6].input, "10000000000000000000");
  assert.equal(dollarLevels[6].output, "996");
  assert.equal(marketView.depth(dollars, { ...pool, pendingSettlement: true }).length, 0);
});
test("Recent executions preserve exact scales and exclude World inventory and other pairs", () => {
  const rows = [
    { id: "trading:1", symbol: "FTH$", from: "FTHX", to: "FTH$", amount: "100", output: "1000000000000000000", at: 1000 },
    { id: "trading:2", symbol: "FTH$", from: "FTH$", to: "FTHX", amount: "2000000000000000000", output: "190", at: 2000 },
    { id: "world:1", symbol: "WORLD:wood", from: "WORLD:wood", to: "FTHX" },
    { id: "note:1", symbol: "WORLD:wood", from: "FTHX", to: "WORLD:wood", amount: "100", output: "99", at: 3000 },
  ];
  const dollars = marketView.executions(rows, "FTH$");
  assert.equal(dollars.length, 2);
  assert.equal(helpers.ratio(dollars[0].price), "100"); assert.equal(helpers.ratio(dollars[1].price), "95");
  assert.equal(dollars[0].side, "buy"); assert.equal(dollars[1].side, "sell");
  assert.equal(marketView.executions(rows, "WORLD:wood").length, 1);
});
test("Percentage sizes retain all Dollar decimals and reject sub-unit and invalid balances", () => {
  assert.equal(marketView.size("1234567890123456789", 25, "FTH$"), "0.308641972530864197");
  assert.equal(marketView.size("1", 100, "FTH$"), "0.000000000000000001");
  assert.throws(() => marketView.size("1", 25, "FTHX"), /minimum unit/);
  assert.throws(() => marketView.size("100", 30, "FTHX"), /supported/);
  assert.throws(() => marketView.size(9007199254740992, 100, "FTHX"), /exact unit/);
});
test("Exchange terminal parses exact whole notes and 18-decimal dollars without Number balance arithmetic", () => {
  assert.equal(helpers.amount("1.234567890123456789", "FTH$"), "1234567890123456789");
  assert.equal(helpers.amount("9007199254740993", "FTHX"), "9007199254740993");
  for (const [value, symbol] of [["1.1", "FTHX"], ["1.0000000000000000001", "FTH$"], ["-1", "FTH$"], ["1e3", "FTHX"], ["0", "FTHX"]])
    assert.throws(() => helpers.amount(value, symbol));
  assert.equal(helpers.format("9999000000000000000", "FTH$"), "9.999 FTH$");
  assert.equal(helpers.format("1", "FTH$"), "0.000000000000000001 FTH$");
  assert.equal(helpers.format("1234567890123456789", "FTH$"), "1.234567890123456789 FTH$");
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
  for (const missing of [["overview-markets", "pending-movements"], ["terminal-status"], ["funding-form"], []]) {
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
      window: {},
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
async function browserFixture(t, respond = () => null, storage = new Map(), hash = "", search = "") {
  const owner = "0x" + "ab".repeat(20), requests = [], confirmations = [], errors = [], histories = [];
  class Element {
    constructor() { this.value = ""; this.children = []; this.listeners = new Map(); this.firstChild = { textContent: "" }; this.style = {}; this.attributes = {}; }
    addEventListener(event, handler) {
      const handlers = this.listeners.get(event) || []; handlers.push(handler); this.listeners.set(event, handlers);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelectorAll() { return []; }
  }
  const nodes = new Map([...fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/index.html"), "utf8").matchAll(/id="([^"]+)"/g)]
    .map(match => [match[1], new Element()]));
  const node = id => { assert.ok(nodes.has(id), `Missing terminal node ${id}`); return nodes.get(id); };
  node("order-form").querySelectorAll = () => ["order-side", "order-amount", "order-slippage"].map(node);
  node("chart-interval").value = "24h"; node("order-side").value = "buy";
  node("market-filter").value = "all";
  const market = { symbol: "FTH$", funded: false, price: null, history: { candles: [] } };
  const defaults = route => {
    if (route.startsWith("/trading/markets")) return { markets: [market], pair: { notes: [market] }, reference: { usdValue: null } };
    if (route === "/trading/account") return { holdings: [], trades: [], movements: [], portfolio: { usd: null } };
    if (route === "/markets/account") return { positions: [] };
    if (/^\/markets\/[^/]+\/history\?/.test(route)) return { candles: [] };
    if (route.startsWith("/market-tape?")) return { rows: [] };
    if (route === "/challenge") return { message: "Challenge" };
    if (route === "/login") return { address: owner, token: "fixture-token" };
    if (route === "/logout") return { ok: true };
    throw Error(`Unexpected terminal request: ${route}`);
  };
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => new Element(), querySelectorAll: () => [], hidden: false },
    location: { protocol: "https:", hostname: "ex.featheral.com", port: "", search, hash },
    window: { FeatheralCandleChart: { mount: () => ({ update(value) { histories.push(value); }, reset() {}, sma() {} }) },
      FeatheralAssetIcons: { create: () => new Element() },
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
        json: async () => { if (response?.invalidJson) throw new SyntaxError("Invalid JSON"); return response ? response.body : defaults(route); } };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/market-view.js"), "utf8"), context);
  vm.runInContext(terminal, context);
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
test("Balance sizing uses only custody funds, switches sides exactly, invalidates previews and keeps account records selectable", async t => {
  const ui = await browserFixture(t, route => route === "/trading/account" ? { body: {
    holdings: [{ symbol: "FTHX", balance: "9007199254740993" }, { symbol: "FTH$", balance: "1234567890123456789" }],
    trades: [], movements: [], portfolio: { usd: null },
  } } : null);
  await ui.dispatch("size-25", "click");
  assert.equal(ui.node("order-amount").value, "2251799813685248");
  assert.equal(ui.node("execute-order").disabled, true);
  await ui.dispatch("side-sell", "click"); await ui.dispatch("size-100", "click");
  assert.equal(ui.node("order-amount").value, "1.234567890123456789");
  assert.equal(ui.node("side-sell").attributes["aria-pressed"], "true");
  assert.equal(ui.node("order-available").textContent, "Available: 1.234567890123456789 FTH$");
  await ui.dispatch("show-trades", "click");
  assert.equal(ui.node("trades-record").hidden, false); assert.equal(ui.node("balances-record").hidden, true);
  await ui.dispatch("show-movements", "click");
  assert.equal(ui.node("movements-record").hidden, false); assert.equal(ui.node("trades-record").hidden, true);
  await ui.dispatch("disconnect", "click");
  assert.equal(ui.node("order-available").textContent, "Connect to view available balance.");
  await ui.dispatch("size-50", "click");
  assert.match(ui.node("terminal-status").textContent, /Connect the owner wallet/);
  assert.equal(ui.requests.filter(request => request.route === "/trading/quote").length, 0);
});
test("Terminal clears depth and execution rows and labels stale data when market reads fail", async t => {
  let unavailable = false;
  const ui = await browserFixture(t, route => unavailable && route.startsWith("/market-tape?")
    ? { status: 503, body: { error: "Execution reader unavailable" } } : null);
  assert.match(ui.node("data-status").textContent, /Updated/);
  unavailable = true; await ui.dispatch("refresh-market", "click");
  assert.match(ui.node("terminal-status").textContent, /Execution reader unavailable/);
  assert.match(ui.node("data-status").textContent, /unavailable \/ stale/);
  assert.equal(ui.node("depth-asks").children.length, 0);
  assert.match(ui.node("recent-trades").children[0].children[0].textContent, /unavailable/);
  assert.equal(ui.node("execute-order").disabled, true);
});
test("24h statistics stay independent of the chart interval and real executions render with reserve depth", async t => {
  const price = n => ({ numerator: String(n), denominator: "1" });
  const candles = high => [{ at: Date.now() - 1000, open: price(1), high: price(high), low: price(1), close: price(2) }];
  const dollar = { symbol: "FTH$", funded: false, history: { candles: [] } };
  const market = { symbol: "FTHA", funded: true, baseReserve: 2000000, noteReserve: 1000000, volume: "4", price: price(2) };
  const ui = await browserFixture(t, route => {
    if (route.startsWith("/trading/markets")) return { body: { markets: [dollar, market],
      pair: { notes: [dollar], volumeFthx: "0" }, reference: { usdValue: null } } };
    if (route.startsWith("/markets/FTHA/history")) return { body: { candles: candles(route.endsWith("24h") ? 3 : 9) } };
    if (route.startsWith("/market-tape?")) return { body: { rows: [
      { id: "note:1", symbol: "FTHA", from: "FTHX", to: "FTHA", amount: "4", output: "2", at: Date.now() },
    ] } };
    return null;
  });
  ui.node("chart-interval").value = "1h"; await ui.dispatch("chart-interval", "change");
  assert.equal(ui.histories.at(-1).candles[0].high.numerator, "9");
  assert.equal(ui.node("day-high").textContent, "3");
  assert.equal(ui.node("day-change").textContent, "+100.00%");
  assert.equal(ui.node("pair-volume").textContent, "4");
  assert.equal(ui.node("pair-reserve").textContent, (2000000).toLocaleString());
  assert.equal(ui.node("depth-asks").children.length, 6);
  assert.equal(ui.node("depth-bids").children.length, 6);
  assert.equal(ui.node("recent-trades").children[0].children[0].textContent, "2");
  assert.equal(ui.node("recent-trades").children[0].attributes["data-side"], "buy");
  assert.ok(ui.requests.some(request => request.route.endsWith("venue=exchange")));
});
test("World pairs automatically show real recorded history when AMMs are unfunded, retain exact trade amounts, and block wallet-note orders", async t => {
  let unavailable = false;
  const market = { symbol: "WORLD:wood", asset: "wood", ticker: "WOOD", inventoryOnly: true, trades: 0,
    recordedTrades: 1, volumeBaseUnits: "0", recordedVolumeBaseUnits: "10000000000000000",
    price: { numerator: "1", denominator: "1000000000" }, description: "Recorded World fills." };
  const respond = route => {
    const native = { symbol: "FTH$", funded: false, history: { candles: [], currency: "FTHX" } };
    if (route.startsWith("/trading/markets")) return { body: { markets: [market, { symbol: "FTH$", funded: false }],
      pair: { notes: [native] }, reference: {} } };
    if (route.startsWith("/world-markets/")) return { body: { source: "world-executed-inventory", candles: [{ trades: 1 }], currency: "FTHX" } };
    if (unavailable && route.startsWith("/world-trades")) return { status: 503, body: { error: "World execution reader unavailable" } };
    if (route.startsWith("/world-trades")) return { body: { rows: [{ id: "world:market:1", at: Date.now(), clock: "historical-game-clock", quantity: "10000000",
      quoteAmount: "10000000000000000", dollars: "100000000000000", price: market.price, venue: "world-players", settlement: "historical-recorded" }] } };
    return null;
  };
  const ui = await browserFixture(t, respond);
  assert.equal(ui.node("market-title").textContent, "WOOD / FTHX · World");
  assert.equal(ui.node("spot-price").textContent, "0.000000001 FTHX · last fill");
  assert.equal(ui.node("chart-interval").value, "all");
  assert.equal(ui.node("world-executions").hidden, false);
  assert.equal(ui.node("world-trade-records").children[0].children[3].textContent, "0.01 FTHX");
  assert.equal(ui.node("world-trade-records").children[0].children[4].textContent, "0.0001 FTH$");
  assert.ok(ui.node("order-amount").disabled);
  await ui.dispatch("order-form");
  assert.match(ui.node("terminal-status").textContent, /must be placed in World/);
  assert.equal(ui.requests.filter(request => request.route === "/trading/quote").length, 0);
  unavailable = true;
  await ui.dispatch("refresh-market", "click");
  assert.equal(ui.node("world-executions").hidden, true, "A failed refresh cannot relabel stale executions as a different pair.");
  assert.equal(ui.node("world-trade-records").children.length, 0);
  assert.match(ui.node("terminal-status").textContent, /World execution reader unavailable/);
  const explicit = await browserFixture(t, respond, new Map(), "", "?market=FTH%24");
  assert.equal(explicit.node("market-title").textContent, "FTH$ / FTHX", "An explicit native-pair URL is never overridden.");
});
test("World trading notes enable Exchange orders while keeping game history separate from pool prices", async t => {
  let trades = 0;
  const symbol = "WORLD:wood", market = { symbol, asset: "wood", ticker: "WOOD", tradingOnly: true, gameUsable: false,
    inventoryOnly: false, funded: true, baseReserve: 1000000, noteReserve: 1000000, volume: 0, price: { numerator: "1", denominator: "1" },
    description: "Trading-only World item note. Cannot be used in the game." };
  const ui = await browserFixture(t, (route, body) => {
    if (route.startsWith("/trading/markets")) return { body: { markets: [market], pair: { notes: [] },
      reference: { usdValue: null }, worldCoverage: { available: true } } };
    if (route.startsWith("/markets/WORLD%3Awood/history")) return { body: { candles: [], source: "executed-trades", currency: "FTHX" } };
    if (route.startsWith("/world-trades")) return { body: { rows: [] } };
    if (route === "/trading/quote") return { body: { symbol, side: body.side, amount: body.amount, output: 996, from: "FTHX", to: symbol } };
    if (route === "/trading/trade") { trades++; return { body: { status: "complete" } }; }
    return null;
  }, new Map(), "", "?market=WORLD%3Awood");
  assert.equal(ui.node("market-title").textContent, "WOOD / FTHX · Trading only");
  assert.match(ui.node("market-mode").textContent, /Cannot be used in the game/);
  assert.equal(ui.node("order-amount").disabled, false);
  assert.equal(ui.histories.at(-1).source, "executed-trades");
  assert.equal(ui.requests.some(request => request.route.startsWith("/world-markets/")), false);
  assert.equal(ui.node("world-executions").hidden, false);
  ui.node("order-amount").value = "1000"; ui.node("order-slippage").value = "1";
  await ui.dispatch("order-form");
  assert.equal(ui.node("execute-order").disabled, false);
  await ui.dispatch("execute-order", "click");
  assert.equal(trades, 1);
  assert.equal(ui.node("terminal-status").textContent, "Trade executed.");
});
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
test("Submitted trades remain resumable on reference-only markets with their original request", async t => {
  const owner = "0x" + "ab".repeat(20), storage = new Map();
  const order = { owner, symbol: "FTH$", side: "sell", amount: "1234567890123456789",
    minOutput: "100", requestId: "saved-trade-request-0001", expires: 1, submitted: true };
  storage.set(`featheral-exchange-pending:${owner}:trade`, JSON.stringify(order));
  const ui = await browserFixture(t, route => route === "/trading/trade" ? { body: { status: "complete" } } : null, storage);
  await ui.dispatch(ui.node("market-list").children[1], "click");
  assert.equal(ui.node("market-title").textContent, "FTHG / FTHX");
  assert.equal(ui.node("execute-order").disabled, false);
  assert.equal(ui.node("execute-order").textContent, "Resume submitted trade");
  assert.match(ui.node("order-preview").textContent, /1\.234567890123456789 FTH\$/);
  await ui.dispatch("order-form");
  assert.match(ui.node("terminal-status").textContent, /Resolve the submitted trade/);
  await ui.dispatch("execute-order", "click");
  assert.deepEqual(ui.requests.find(request => request.route === "/trading/trade").body, order);
  assert.match(ui.confirmations.at(-1), /Resume submitted sell trade for FTH\$\/FTHX\? Spend 1\.234567890123456789 FTH\$/);
  assert.equal(storage.has(`featheral-exchange-pending:${owner}:trade`), false);
  assert.equal(ui.node("execute-order").disabled, true);
});
test("Trading balance, quote and withdrawal confirmations retain exact Dollar precision", async t => {
  const ui = await browserFixture(t, route => {
    if (route === "/trading/account") return { body: { holdings: [{ symbol: "FTH$", balance: "1234567890123456789" }],
      trades: [], movements: [], portfolio: { usd: null } } };
    if (route === "/trading/quote") return { body: { from: "FTH$", to: "FTHX", output: "1000" } };
    if (route === "/trading/withdraw") return { body: { status: "complete" } };
    return null;
  });
  assert.equal(ui.node("positions").children[0].children[1].textContent, "1.234567890123456789 FTH$");
  ui.node("order-side").value = "sell"; ui.node("order-amount").value = "1.234567890123456789";
  ui.node("order-slippage").value = "0.5";
  await ui.dispatch("order-form");
  assert.match(ui.node("order-preview").textContent, /Spend 1\.234567890123456789 FTH\$/);
  ui.node("withdraw-symbol").value = "FTH$"; ui.node("withdraw-amount").value = "0.000000000000000001";
  await ui.dispatch("withdraw-form");
  assert.match(ui.confirmations.at(-1), /0\.000000000000000001 FTH\$/);
});
test("Failed logout clears the local trading session and reports the server error", async t => {
  const ui = await browserFixture(t, route => route === "/logout" ? { status: 503, body: { error: "Logout unavailable" } } : null);
  await ui.dispatch("disconnect", "click");
  assert.match(ui.node("terminal-status").textContent, /Logout unavailable/);
  assert.match(ui.node("terminal-status").textContent, /server session revocation failed.*session may remain active/);
  assert.equal(ui.node("trading-owner").textContent, "Trading account not connected");
  ui.node("deposit-amount").value = "1";
  await ui.dispatch("deposit-form");
  assert.match(ui.node("terminal-status").textContent, /Connect the owner wallet/);
  assert.equal(ui.requests.filter(request => request.route === "/trading/deposit").length, 0);
});
test("Non-JSON exchange failures show an actionable error instead of a parser exception", async t => {
  const ui = await browserFixture(t, route => route === "/trading/deposit" ? { status: 503, invalidJson: true }
    : route.startsWith("/trading/operations/") ? { status: 404, body: { error: "Not found" } } : null);
  ui.node("deposit-amount").value = "1";
  await ui.dispatch("deposit-form");
  assert.match(ui.node("terminal-status").textContent, /invalid response \(HTTP 503\).*retry/);
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
    ? { body: { markets: [dollar, { symbol: "FTHA", funded: true, baseReserve: 1000000, noteReserve: 1000000, volume: "9007199254740993" },
      { symbol: "FTHB", funded: true, pendingSettlement: true, volume: "7" }],
    pair: { notes: [dollar], volumeFthx: "11" }, reference: { usdValue: null } } } : null);
  assert.equal(ui.node("overview-markets").textContent, "3");
  assert.equal(ui.node("overview-funded").textContent, "2");
  assert.equal(ui.node("overview-volume").textContent, `${9007199254741011n.toLocaleString()} FTHX`);
});
test("Missing volume is explicitly unavailable rather than displayed as zero", async t => {
  const ui = await browserFixture(t);
  assert.equal(ui.node("overview-volume").textContent, "Unavailable");
  assert.equal(ui.node("pair-volume").textContent, "Unavailable");
});
test("Active market filter uses exact 24h volumes, excludes dormant pairs, and keeps search and all-market discovery", async t => {
  const dollar = { symbol: "FTH$", funded: false, history: { candles: [] } };
  const ui = await browserFixture(t, route => {
    if (route.startsWith("/trading/markets")) return { body: {
      markets: [dollar, { symbol: "FTHA", volume: "10", funded: true, baseReserve: 1000000, noteReserve: 1000000 },
        { symbol: "FTHB", volume: "0", funded: false },
        { symbol: "WORLD:wood", asset: "wood", ticker: "WOOD", name: "Wood", inventoryOnly: true,
          volume: "0", volumeBaseUnits: "1", recordedVolumeBaseUnits: "1", recordedTrades: 1 }],
      pair: { notes: [dollar], volumeFthx: "0" }, reference: { usdValue: null },
    } };
    return null;
  });
  assert.equal(ui.node("market-title").textContent, "FTHA / FTHX", "A funded active market is selected before an unfunded default.");
  ui.node("market-filter").value = "active"; await ui.dispatch("market-filter", "change");
  assert.deepEqual(ui.node("market-list").children.map(button => button.textContent), ["FTHA", "WOOD"]);
  assert.equal(ui.node("market-list").children[1].children.at(-1).textContent, "0.000000000000000001 FTHX");
  ui.node("market-search").value = "FTHB"; await ui.dispatch("market-search", "input");
  assert.deepEqual(ui.node("market-list").children.map(button => button.textContent), ["FTHB"]);
  ui.node("market-search").value = ""; ui.node("market-filter").value = "all";
  await ui.dispatch("market-filter", "change");
  assert.ok(ui.node("market-list").children.some(button => button.textContent === "FTHB"));
  assert.ok(ui.node("market-list").children.some(button => button.textContent === "FTHG"));
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
function chartFixture() {
  const create = tag => {
    const node = new VisualElement(tag);
    node.querySelector = selector => selector === "[data-chart-volume]" || selector === "[data-chart-averages]" ? create("button") : null;
    node.querySelectorAll = () => [];
    return node;
  };
  const root = create("div"), context = { window: {}, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { callback(); return 0; },
    document: { createElement: create, addEventListener() {}, removeEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../../shared/trading-chart.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/chart.js"), "utf8"), context);
  return { root, engine: context.FeatheralTradingChart, chart: context.window.FeatheralCandleChart.mount(root) };
}
test("Shared chart empty states never draw fabricated prices, candles, or volume", () => {
  const { root, chart } = chartFixture();
  chart.update({ candles: [] });
  assert.match(root.children[1].innerHTML, /No executed candles yet/);
  assert.doesNotMatch(root.children[1].innerHTML, /data-chart-candle|chart-volume"|<polyline/);
  assert.match(root.children[1].innerHTML, /Empty periods are not fabricated/);
  chart.update({ candles: [], referenceOnly: true });
  assert.match(root.children[1].innerHTML, /Reference \/ conversion market/);
});
test("Exchange chart uses shared area renderer, exact volume scales and recorded clock disclosure", () => {
  const { root, chart } = chartFixture(), ratio = value => ({ numerator: String(value), denominator: "1000000000" });
  const candle = { at: 86400000, open: ratio(1), high: ratio(2), low: ratio(1), close: ratio(2), quoteVolume: "500000000000000000", trades: 2 };
  chart.update({ symbol: "WORLD:metal", currency: "FTHX", interval: "all", quoteVolumeDecimals: 18,
    clocks: ["historical-game-clock"], source: "world-executed-inventory", candles: [candle] });
  assert.match(root.children[1].innerHTML, /class="chart-body"/, "The professional terminal opens with actual candles");
  root.children[0].listeners.click({ target: { closest: () => ({ dataset: { chartStyle: "line" }, hasAttribute: () => false }) } });
  const markup = root.children[1].innerHTML;
  assert.match(markup, /chart-area/);
  assert.match(markup, /chart-endpoint/);
  assert.match(markup, /0\.5 FTHX/);
  assert.doesNotMatch(markup, /NaN|Infinity|class="chart-body"/);
  assert.match(root.children[2].textContent, /historical-game-clock/);
  assert.throws(() => chart.update({ candles: [{ ...candle, close: { numerator: "1", denominator: "0" } }] }), /invalid/);
  assert.equal(root.children[1].innerHTML, markup, "Malformed history does not replace the last successful chart");
  chart.update({ symbol: "FTH$", currency: "FTHX", candles: [candle] });
  assert.match(root.children[1].innerHTML, /0\.5 FTHX/);
  chart.update({ symbol: "FTHA", currency: "FTHX", candles: [{ ...candle, quoteVolume: "5" }] });
  assert.match(root.children[1].innerHTML, /Volume <strong>5 FTHX/);
});
test("Shared crosshair inspection scrubs the headline and signed return, then restores recorded latest values", () => {
  const { engine } = chartFixture(), nodes = new Map(), make = selector => {
    const node = new VisualElement("g"); nodes.set(selector, node); return node;
  };
  const svg = make(".trading-chart"), crosshair = make(".chart-crosshair");
  svg.dataset = { chartTop: "20", chartLeft: "12", chartRight: "700" };
  svg.viewBox = { baseVal: { height: 400 } }; svg.querySelector = selector => nodes.get(selector);
  crosshair.querySelector = selector => nodes.get(selector);
  for (const selector of ["[data-crosshair-x]", "[data-crosshair-y]", "circle", "text"]) make(selector);
  const defaults = [
    ["[data-chart-headline-price]", "106"],
    ["[data-chart-headline-label]", "Latest recorded close"],
    ["[data-chart-return-value]", "+6%"],
    ["[data-chart-inspection]", "Hover or focus a candle for OHLC and volume."],
  ].map(([selector, value]) => { const node = make(selector); node.dataset.chartDefault = value; return node; });
  make(".ft-chart").dataset.chartDirection = "up"; const change = make(".chart-return");
  const root = { querySelector: selector => nodes.get(selector), querySelectorAll: () => defaults };
  const candle = { dataset: { chartX: "45", chartY: "100", chartPrice: "95", chartTime: "Jan 1, UTC", chartChange: "-5%" },
    getAttribute: () => "Recorded OHLC and volume" };
  engine.inspect(root, candle);
  assert.equal(crosshair.attributes.visibility, "visible");
  assert.equal(nodes.get("[data-crosshair-x]").attributes.d, "M45 20V370");
  assert.equal(defaults[0].textContent, "95");
  assert.equal(defaults[1].textContent, "Jan 1, UTC");
  assert.equal(defaults[2].textContent, "-5%");
  assert.equal(change.dataset.chartReturnDirection, "down");
  engine.clearInspection(root);
  assert.equal(crosshair.attributes.visibility, "hidden");
  assert.equal(change.dataset.chartReturnDirection, "up");
  for (const node of defaults) assert.equal(node.textContent, node.dataset.chartDefault);
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
    window: { FeatheralAssetIcons: { create: () => new VisualElement("svg") } },
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
test("Pools workspace honors note setup deep links, retains all-pool discovery and never requests unrelated history", async () => {
  const root = new VisualElement("section"), requests = [], errors = [];
  root.dataset.marketView = "pools";
  const markets = Array.from({ length: 9 }, (_, i) => ({
    symbol: `FTH${i}`, status: "unfunded", baseReserve: "0", tokenReserve: "0", initialTarget: null, feeBps: 30,
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../shared/market-activity.js"), "utf8"), {
    window: { FeatheralAssetIcons: { create: () => new VisualElement("svg") } },
    document: { querySelectorAll: () => [root], createElement: tag => new VisualElement(tag) },
    location: { protocol: "https:", hostname: "ex.featheral.com", port: "", search: "?market=FTH4" },
    URLSearchParams, AbortController, setInterval() {}, console: { error: (...args) => errors.push(args) },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ markets, policy: "Existing funds only." }) }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, ["/api/creation/liquidity"]);
  assert.equal(descendants(root).filter(node => node.className === "liquidity-card").length, 1);
  const currency = descendants(root).find(node => node.attributes["aria-label"] === "Currency");
  assert.equal(currency.value, "FTH4");
  currency.value = ""; currency.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
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
