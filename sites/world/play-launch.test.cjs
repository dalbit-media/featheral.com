const { strict: assert } = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(join(__dirname, "play-launch.js"), "utf8");

function harness(popup) {
  let click;
  const calls = [], alerts = [];
  runInNewContext(source, {
    document: { addEventListener: (name, handler) => { assert.equal(name, "click"); click = handler; } },
    window: {
      screen: { availWidth: 1024, availHeight: 768 },
      open: (...args) => { calls.push(args); return popup; },
      alert: message => alerts.push(message),
    },
  });
  return { click, calls, alerts };
}

function activation(overrides = {}) {
  return { target: { closest: () => ({ href: "https://world.featheral.com/play/" }) }, button: 0, preventDefault() { this.prevented = true; }, ...overrides };
}

test("Play opens a reusable, screen-sized popup without an opener", () => {
  const popup = { opener: {}, focus() { this.focused = true; } };
  const { click, calls, alerts } = harness(popup);
  const event = activation();
  click(event);
  assert.equal(event.prevented, true);
  assert.deepEqual(calls[0], ["https://world.featheral.com/play/", "featheral-play", "popup=yes,width=1024,height=768,resizable=yes,scrollbars=yes"]);
  assert.equal(popup.opener, null);
  assert.equal(popup.focused, true);
  assert.equal(alerts.length, 0);
});

test("blocked popups report the problem without navigating World", () => {
  const { click, alerts } = harness(null);
  const event = activation();
  click(event);
  assert.equal(event.prevented, true);
  assert.match(alerts[0], /Allow popups/);
});

test("modified clicks, other links and prevented events retain browser behavior", () => {
  const { click, calls } = harness(null);
  for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }, { target: { closest: () => null } }]) {
    const event = activation(overrides);
    click(event);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(calls.length, 0);
});

test("World headers place the colored Play icon immediately before the wallet", () => {
  for (const page of ["index.html", "docs/index.html", "news/index.html", "ledger/index.html", "featheral/about/index.html"]) {
    const html = readFileSync(join(__dirname, page), "utf8");
    assert.match(html, /class="play-launch"[^>]*data-play-launch[^>]*target="_blank"[^>]*rel="noopener"[^>]*>.*<svg.*<\/a>\s*<button id="walletButton"/);
    assert.match(html, /src="\/play-launch.js"/);
  }
  const wallet = readFileSync(join(__dirname, "..", "shared", "wallet-profile.js"), "utf8");
  assert.match(wallet, /insertBefore\(adminLink, headerNav\.querySelector\("\[data-play-launch\]"\) \|\| button\)/);
});

test("World About shares the ecosystem bar, World header links and header styling", () => {
  const html = readFileSync(join(__dirname, "featheral", "about", "index.html"), "utf8");
  const world = readFileSync(join(__dirname, "index.html"), "utf8");
  const links = page => [...page.match(/<nav aria-label="World site">([\s\S]*?)<\/nav>/)[1].matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links(html), links(world));
  for (const site of ["foundation", "gold", "dollar", "world"]) assert.ok(html.includes(`data-site="${site}"`));
  assert.match(html, /body class="site-world world-about"/);
  assert.match(html, /href="\/shared\/featheral.css"/);
  assert.match(html, /href="\/about\/" aria-current="page"/);
  const theme = readFileSync(join(__dirname, "..", "shared", "featheral.css"), "utf8");
  assert.match(theme, /\.world-header\{flex-wrap:wrap/);
});

test("World side navigation contains only social routes and retains posting", () => {
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  const rail = html.match(/<aside class="rail"[\s\S]*?<\/aside>/)[0];
  assert.deepEqual([...rail.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]), ["#/", "#/explore", "#/me"]);
  assert.match(rail, /id="railPost"/);
  const header = html.match(/<header class="top world-header"[\s\S]*?<\/header>/)[0];
  for (const path of ["/play/", "/ledger/", "/about/", "/docs/"]) assert.ok(header.includes(`href="${path}"`));
});

test("World centers its social layout and lets the feed fill its grid column", () => {
  const css = readFileSync(join(__dirname, "app.css"), "utf8");
  assert.match(css, /\.app\{width:100%;max-width:1280px;margin-inline:auto;/);
  assert.match(css, /\.column\{[^}]*min-width:0;width:100%;margin:0;padding:0;max-width:none/);
  assert.match(css, /grid-template-columns:minmax\(72px,260px\) minmax\(0,600px\) minmax\(0,350px\)/);
  assert.match(css, /@media \(max-width:640px\)[^{]*\{[^]*?\.app\{grid-template-columns:minmax\(0,1fr\)\}/);
});
