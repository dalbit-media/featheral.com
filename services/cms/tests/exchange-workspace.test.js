"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const site = path.join(__dirname, "../../../sites/ex.featheral.com");
const script = fs.readFileSync(path.join(site, "workspace.js"), "utf8");
function fixture(hash = "") {
  const location = { hash }, events = {};
  const panels = ["trade", "pools", "portfolio", "activity", "pools"].map((name, i) => ({
    id: `panel-${i}`, dataset: { exchangePanel: name }, setAttribute(name, value) { this[name] = value; },
  }));
  const list = { setAttribute(name, value) { this[name] = value; } };
  const targets = new Map([["terminal", panels[0]], ["network-activity", panels[3]], ["trading-account", panels[2]],
    ["liquidity-network", panels[1]], ["initial-dollar-funding", panels[4]]]);
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
      getElementById: id => targets.has(id) ? { closest: () => targets.get(id) } : null,
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
  assert.doesNotMatch(html, /<details[^>]*>.*Native circulation/);
});
