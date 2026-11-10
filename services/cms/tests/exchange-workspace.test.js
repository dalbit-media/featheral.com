"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const site = path.join(__dirname, "../../../sites/ex.featheral.com");
const script = fs.readFileSync(path.join(site, "workspace.js"), "utf8");
test("Notes renders World execution charts with fractional prices and honest historical-clock labels", () => {
  class Element {
    constructor(tag, value) { this.tag = tag; this.textContent = value || ""; this.children = []; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    get text() { return this.textContent + this.children.map(node => node.text).join(" "); }
  }
  const source = fs.readFileSync(path.join(__dirname, "../../../shared/creation.js"), "utf8");
  const trend = vm.runInNewContext(source.slice(source.indexOf("function priceTrend("), source.indexOf("let token =")) + ";priceTrend;", {
    el: (tag, value) => new Element(tag, value), noteColors: {},
    document: { querySelector: () => ({ value: "24h" }), createElementNS: (_ns, tag) => new Element(tag) },
  });
  const price = { numerator: "1", denominator: "1000000000", currency: "FTHX" };
  const card = trend({ symbol: "WORLD:wood", inventoryOnly: true, price,
    history: { interval: "all", clocks: ["historical-game-clock"], currency: "FTHX", from: 1000, to: 2000, points: [{ at: 1000, ...price }] } });
  assert.match(card.text, /0\.000000001 FTHX/);
  assert.match(card.text, /Latest recorded/);
  const svg = card.children.find(node => node.tag === "svg");
  assert.match(svg.attributes["aria-label"], /All recorded history \(legacy game clock\)/);
  assert.doesNotMatch(svg.attributes["aria-label"], /pool spot/);
  assert.ok(svg.children.every(node => !Object.values(node.attributes).some(value => String(value).includes("NaN"))));
});
function fixture(hash = "") {
  const location = { hash }, events = {};
  const panels = ["trade", "pools", "portfolio", "activity", "pools"].map((name, i) => ({
    id: `panel-${i}`, dataset: { exchangePanel: name }, setAttribute(name, value) { this[name] = value; },
  }));
  const list = { setAttribute(name, value) { this[name] = value; } };
  const targets = new Map([["terminal", panels[0]], ["network-activity", panels[3]], ["trading-account", panels[2]],
    ["liquidity-network", panels[1]], ["initial-dollar-funding", panels[4]], ["world-market-activity", panels[3]]]);
  const tabs = ["trade", "activity", "pools", "portfolio"].map((name, i) => ({
    dataset: { exchangeTab: name }, href: ["#terminal", "#network-activity", "#liquidity-network", "#trading-account"][i],
    listeners: {}, setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name]; },
    addEventListener(event, handler) { this.listeners[event] = handler; }, focus() { this.focused = true; },
    click() { this.listeners.click({ preventDefault() {} }); },
  }));
  vm.runInNewContext(script, {
    document: {
      querySelector: () => list,
      querySelectorAll: selector => selector === "[data-exchange-tab]" ? tabs : panels,
      getElementById: id => targets.has(id) ? { closest: selector => selector === "[data-exchange-panel]" ? targets.get(id) : null } : null,
    },
    location, history: { replaceState(_state, _title, url) { location.hash = url; } }, Event: class {},
    window: { addEventListener(name, callback) { events[name] = callback; }, dispatchEvent() {} },
    console,
  });
  return { tabs, panels, location, events, list };
}
test("workspace tabs expose only the selected sections and support keyboard navigation", () => {
  const ui = fixture();
  assert.equal(ui.list.role, "tablist");
  assert.equal(ui.panels.filter(panel => !panel.hidden).length, 1);
  assert.equal(ui.tabs[0]["aria-selected"], "true");
  ui.tabs[2].click();
  assert.equal(ui.location.hash, "#liquidity-network");
  assert.equal(ui.panels.filter(panel => !panel.hidden).length, 2);
  assert.equal(ui.tabs[2]["aria-controls"], "panel-1 panel-4");
  let prevented = false;
  ui.tabs[2].listeners.keydown({ key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(ui.tabs[3]["aria-selected"], "true");
  assert.ok(ui.tabs[3].focused);
  ui.tabs[3].listeners.keydown({ key: "Home", preventDefault() {} });
  assert.equal(ui.tabs[0].tabIndex, 0);
  assert.ok(ui.tabs.slice(1).every(tab => tab.tabIndex === -1));
  ui.tabs[1].listeners.keydown({ key: " ", preventDefault() {} });
  assert.equal(ui.tabs[1]["aria-selected"], "true");
});
test("workspace honors portfolio, activity and funding deep links and retains hash navigation", () => {
  for (const [hash, name] of [["#initial-dollar-funding", "pools"], ["#trading-account", "portfolio"], ["#network-activity", "activity"]]) {
    const ui = fixture(hash);
    assert.ok(ui.panels.filter(panel => !panel.hidden).every(panel => panel.dataset.exchangePanel === name));
    ui.location.hash = "#terminal"; ui.events.hashchange();
    assert.equal(ui.tabs[0]["aria-selected"], "true");
  }
});
test("Notes keeps native charts and recorded history above volume-ranked community markets", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../../sites/notes.featheral.com/index.html"), "utf8");
  assert.ok(html.indexOf('id="native-notes"') < html.indexOf("data-market-activity"));
  assert.ok(html.indexOf("data-market-activity") < html.indexOf('id="trending-notes"'));
  assert.match(html, /data-market-interval="all"/);
  assert.match(html, /value="all" selected/);
  assert.match(html, /<details class="notes-tools" open>/);
  assert.ok(html.indexOf('id="native-notes"') < html.indexOf('id="creation-root"'));
  assert.doesNotMatch(html, /<details[^>]*>.*Native circulation/);
});
class MarketElement {
  constructor(tag, value = "") { this.tag = tag; this.textContent = value; this.children = []; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get childElementCount() { return this.children.length; }
  get text() { return this.textContent + this.children.map(node => node.text).join(" "); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function notesRenderer(data, activity) {
  const nodes = new Map(["note-chart-interval", "world-markets", "world-market-coverage", "trending-notes", "native-notes", "inactive-notes"]
    .map(id => [id, new MarketElement("div")]));
  nodes.get("note-chart-interval").value = "all";
  const context = vm.createContext({
    window: {}, console, Date, el: (tag, text) => new MarketElement(tag, text),
    hostUrl: name => `https://${name}.featheral.com/`, ledgerUrl: symbol => `https://ledger.featheral.com/?currency=${symbol}`,
    document: { createElementNS: (_, tag) => new MarketElement(tag), querySelector: selector => nodes.get(selector.slice(1)) },
    api: async route => route.startsWith("/trending?") ? data : activity,
  });
  vm.runInContext(fs.readFileSync(path.join(site, "../../shared/asset-icons.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(site, "../../shared/creation.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const noteColors ="), source.indexOf("let token ="))
    + "let trendRequest = 0;\n"
    + source.slice(source.indexOf("async function trending()"), source.indexOf("if (notesPage || exchangePage)"))
    + "\nthis.render = trending;", context);
  return { nodes, context };
}
test("Notes shows real native activity charts without inventing pool prices and separates active markets from placeholders", async () => {
  const native = symbol => ({ symbol, native: true, name: symbol, volume: 0, circulating: "10", decimals: 0 });
  const item = (asset, volumeBaseUnits) => ({ symbol: `WORLD:${asset}`, inventoryOnly: true, asset, ticker: asset.toUpperCase(),
    name: asset, volumeBaseUnits, recordedVolumeBaseUnits: "1000000000000000000", recordedTrades: 1, marketId: `WORLD:${asset}` });
  const ui = notesRenderer({
    notes: [native("FTH$"), native("FTHX"), native("FTHS"), { symbol: "FTHA", volume: 20, quoteCurrency: "FTHX", funded: true },
      { symbol: "FTHB", volume: 0, quoteCurrency: "FTHX", placeholder: true }],
    worldMarkets: [item("wood", "1"), item("torch", "0")], worldCoverage: { available: true, description: "Recorded World fills." },
  }, { bucketMs: 86400000, buckets: ["FTH$", "FTHX", "FTHS", "FTHG"].map(symbol => ({ symbol, at: 1000, events: 3 })) });
  await ui.context.render();
  const natives = ui.nodes.get("native-notes");
  assert.equal(natives.children.length, 4);
  for (const card of natives.children) {
    const chart = descendants(card).find(node => node.attributes.role === "img");
    assert.match(chart.attributes["aria-label"], /recorded ledger activity counts, not prices/);
    assert.equal(chart.children.filter(node => node.tag === "rect").length, 1);
    assert.doesNotMatch(card.text, /No executed trades/);
  }
  assert.match(ui.nodes.get("trending-notes").text, /FTHA/);
  assert.doesNotMatch(ui.nodes.get("trending-notes").text, /FTHB/);
  assert.match(ui.nodes.get("inactive-notes").text, /FTHB/);
  const world = ui.nodes.get("world-markets");
  assert.equal(world.children.length, 1, "Historical-only fills do not masquerade as active volume.");
  assert.equal(descendants(world).find(node => node.tag === "use").attributes.href, "/shared/market-icons.svg#wood");
  assert.ok(descendants(ui.nodes.get("inactive-notes")).some(node => node.tag === "path"), "Placeholder feather icon is rendered.");
});
test("Shared icons use canonical World item artwork, including enhanced equipment, and native currency logos", () => {
  const { context } = notesRenderer({}, {});
  const icons = context.window.FeatheralAssetIcons;
  assert.equal(icons.create({ symbol: "WORLD:enhanced-torch-level-2" }).children[0].attributes.href, "/shared/market-icons.svg#torch");
  assert.equal(icons.create({ symbol: "FTH$" }).children[0].attributes.href, "/shared/logo-dollar.svg");
  assert.equal(icons.create({ symbol: "FTH1" }).attributes["aria-hidden"], "true");
  assert.throws(() => icons.create({ symbol: "WORLD:../invalid" }), /Invalid World/);
  const sprite = fs.readFileSync(path.join(site, "../../shared/market-icons.svg"), "utf8");
  for (const asset of ["wood", "water", "metal", "oil", "torch", "lantern", "collector-all-52", "refinement-core"])
    assert.ok(sprite.includes(`id="${asset}"`), `Canonical ${asset} artwork is available.`);
  const css = fs.readFileSync(path.join(site, "../../shared/asset-icons.css"), "utf8");
  assert.match(css, /ex\.featheral\.com.*width:20px;height:20px;filter:grayscale\(1\)/);
});
test("Native charts prefer executed prices and report missing activity without manufacturing a series", () => {
  const { context } = notesRenderer({}, {});
  const price = { numerator: "1", denominator: "100", currency: "FTH$" };
  const chart = context.nativeTrend({ symbol: "FTHX", price,
    history: { interval: "all", currency: "FTH$", from: 1000, to: 2000, points: [{ at: 1000, ...price }] } }, { error: "Reader offline" });
  assert.match(chart.text, /0\.01 FTH\$/);
  assert.match(descendants(chart).find(node => node.attributes.role === "img").attributes["aria-label"], /executed All recorded history/);
  const unavailable = context.nativeTrend({ symbol: "FTHG" }, { error: "Reader offline" });
  assert.match(unavailable.text, /Activity unavailable: Reader offline/);
  assert.equal(descendants(unavailable).filter(node => node.tag === "rect").length, 0);
});
test("Exchange prioritizes trading and World activity deep links open the Activity workspace", () => {
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert.ok(html.indexOf('id="world-market-activity"') > html.indexOf('id="workspace-activity"'));
  assert.match(html, /data-market-view="overview" data-market-source="world"/);
  assert.match(html, /href="#world-market-activity"/);
  const initial = fixture("#world-market-activity");
  assert.equal(initial.tabs[1]["aria-selected"], "true");
  const ui = fixture("#liquidity-network");
  ui.location.hash = "#world-market-activity"; ui.events.hashchange();
  assert.equal(ui.tabs[1]["aria-selected"], "true");
  assert.ok(ui.panels.filter(panel => !panel.hidden).every(panel => panel.dataset.exchangePanel === "activity"));
});
