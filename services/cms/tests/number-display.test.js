"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../../shared/number-display.js"), "utf8");
const context = { window: {}, document: {} };
vm.runInNewContext(source, context);
const compact = context.window.FeatheralNumbers.compactText;
test("compact metrics use exact integer rounding with up to three decimals and sensible unit promotion", () => {
  for (const [full, short] of [
    ["9,999.9999", "9,999.9999"], ["10,000", "10K"], ["12,345.678", "12.346K"],
    ["1,253,456 FTHX", "1.253M FTHX"], ["$12,345,678,900.12", "$12.346B"],
    ["-1,000,000", "-1M"], ["999,999.5", "1M"], ["999,999,999.5", "1B"],
    ["9007199254740993123456 FTH$", "9007.199Qi FTH$"],
    ["  1,000,000 ETH  ", "  1M ETH  "], ["1000000.000000000000000001 FTHG", "1M FTHG"],
    ["0.000000000000000001 FTH$", "0.000000000000000001 FTH$"],
  ]) assert.equal(compact(full), short, full);
});
test("dates, addresses, identifiers, localized ambiguous values and prose are never guessed as metrics", () => {
  for (const text of ["2026-11-10", "0x123456789012345", "123456789012345abc1", "123456789012345abc", "Block #100000",
    "Account 12345678", "1.234.567,89", "10,00", "1e18", "No liquidity", "1000000 / 12345678"])
    assert.equal(compact(text), text);
});
function fixture() {
  let mutation;
  const events = {}, windowEvents = {};
  class Element {
    constructor(tag, text = "", attributes = {}) {
      this.tag = tag; this.nodeType = 1; this.attributes = { ...attributes }; this.children = []; this.style = {}; this.fontSize = "18px";
      this.offsetWidth = 200; this.offsetHeight = 40;
      if (text) this.appendText(text);
    }
    appendText(value) {
      const node = { nodeType: 3, nodeValue: value, parentElement: this, isConnected: true };
      this.children.push(node); return node;
    }
    append(node) { node.parentElement = this; this.children.push(node); }
    get textContent() { return this.children.map(node => node.nodeType === 3 ? node.nodeValue : node.textContent).join(""); }
    set textContent(value) { this.children = []; this.appendText(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    set title(value) { this.setAttribute("title", value); }
    set tabIndex(value) { this.setAttribute("tabindex", value); }
    querySelector() { return null; }
    getBoundingClientRect() { return { left: 300, bottom: 910 }; }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector.split(",").some(part => part === node.tag || part.startsWith("#") && node.attributes.id === part.slice(1)
          || part.startsWith(".") && (node.attributes.class || "").split(" ").includes(part.slice(1))
          || part.startsWith("[") && node.getAttribute(part.slice(1, -1)) !== null)) return node;
      }
      return null;
    }
  }
  const body = new Element("body"), metric = new Element("strong", "1,253,456 FTHX", { title: "Available funds" });
  body.append(metric);
  const excluded = [];
  for (const tag of ["table", "small", "form", "code", "svg", "button"]) {
    const root = new Element(tag), value = new Element("strong", "1,253,456");
    root.append(value); body.append(root); excluded.push(value);
  }
  for (const attributes of [{ id: "terminal" }, { id: "trading-account" }, { id: "swap" }, { id: "history" },
    { class: "wallet-approval" }, { "data-exact-number": "" }]) {
    const root = new Element("section", "", attributes), value = new Element("strong", "1,253,456");
    root.append(value); body.append(root); excluded.push(value);
  }
  const small = new Element("strong", "1,253,456"); small.fontSize = "12px"; body.append(small); excluded.push(small);
  const currency = new Element("h1", "12,345,678.123 "), label = new Element("span", "FTHX"); currency.append(label); body.append(currency);
  const allText = root => root.nodeType === 3 ? [root] : root.children.flatMap(allText);
  const document = { body, createElement: tag => new Element(tag),
    createTreeWalker(root) {
      const nodes = allText(root); let index = 0;
      return { nextNode() { this.currentNode = nodes[index++]; return !!this.currentNode; } };
    }, addEventListener(name, callback) { events[name] = callback; } };
  vm.runInNewContext(source, {
    window: { addEventListener(name, callback) { windowEvents[name] = callback; } }, document,
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: node => ({ fontSize: node.fontSize }),
    innerWidth: 390, innerHeight: 844,
  });
  return { metric, excluded, currency, label, events, body, windowEvents,
    update(node) { mutation([{ type: "characterData", target: node }]); },
    replace(parent, value) {
      parent.children.forEach(node => { node.isConnected = false; });
      parent.children = []; const node = parent.appendText(value);
      mutation([{ type: "childList", addedNodes: [node] }]);
    } };
}
test("shared display retains exact accessible values and child nodes while leaving trading, tables and small print untouched", () => {
  const f = fixture();
  assert.equal(f.metric.textContent, "1.253M FTHX");
  assert.equal(f.metric.getAttribute("aria-label"), "1,253,456 FTHX");
  assert.equal(f.metric.getAttribute("title"), "Available funds / 1,253,456 FTHX");
  assert.equal(f.metric.getAttribute("tabindex"), "0");
  assert.equal(f.metric.getAttribute("data-number-full"), "1,253,456 FTHX");
  assert.ok(f.excluded.every(node => node.textContent === "1,253,456"));
  assert.equal(f.currency.textContent, "12.346M FTHX");
  assert.equal(f.currency.children[1], f.label, "Currency node is not replaced");
});
test("live updates do not accumulate stale titles and shrinking values restore original attributes", () => {
  const f = fixture(), node = f.metric.children[0];
  node.nodeValue = "2,345,678 FTHX"; f.update(node);
  assert.equal(f.metric.textContent, "2.346M FTHX");
  assert.equal(f.metric.getAttribute("title"), "Available funds / 2,345,678 FTHX");
  f.replace(f.metric, "3,456,789 FTHX");
  assert.equal(f.metric.textContent, "3.457M FTHX");
  assert.equal(f.metric.getAttribute("title"), "Available funds / 3,456,789 FTHX");
  f.metric.children[0].nodeValue = "42 FTHX"; f.update(f.metric.children[0]);
  assert.equal(f.metric.getAttribute("title"), "Available funds");
  assert.equal(f.metric.getAttribute("aria-label"), null);
  assert.equal(f.metric.getAttribute("tabindex"), null);
});
test("responsive small print restores the original value rather than abbreviating it", () => {
  const f = fixture();
  f.metric.fontSize = "12px"; f.windowEvents.resize();
  assert.equal(f.metric.textContent, "1,253,456 FTHX");
  assert.equal(f.metric.getAttribute("data-number-full"), null);
});
test("keyboard focus reveals the full amount in a viewport-bounded tooltip and Escape dismisses it", () => {
  const f = fixture(), tooltip = f.body.children.at(-1);
  f.events.focusin({ target: f.metric });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "1,253,456 FTHX");
  assert.equal(tooltip.style.left, "182px");
  assert.equal(tooltip.style.top, "796px");
  f.events.keydown({ key: "Escape" });
  assert.equal(tooltip.hidden, true);
});
test("shared loader includes the same formatter once and keeps full values on asset failure", () => {
  const chrome = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  const loader = chrome.slice(0, chrome.indexOf("// Animations"));
  const scripts = [], errors = [];
  const document = { querySelector: () => scripts[0], createElement: () => ({ dataset: {} }),
    head: { append: script => scripts.push(script) } };
  const ctx = { document, console: { error: message => errors.push(message) } };
  vm.runInNewContext(loader, ctx); vm.runInNewContext(loader, ctx);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "/shared/number-display.js");
  scripts[0].onerror();
  assert.match(errors[0], /full values are retained/);
});
