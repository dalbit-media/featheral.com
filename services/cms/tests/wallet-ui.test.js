const { test } = require("node:test");
const assert = require("node:assert/strict");
const { walletUi, primaryFor, allowedOrigin } = require("../../wallet/ui");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
test("Admin header keeps its compact avatar while sign-in uses a direct accessible action", () => {
  const admin = path.resolve(__dirname, "../../../sites/admin.featheral.com");
  const login = fs.readFileSync(path.join(admin, "login.html"), "utf8");
  const header = fs.readFileSync(path.join(admin, "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(admin, "styles.css"), "utf8");
  assert.match(header, /id="admin-wallet" class="icon-btn wallet-icon"/);
  assert.doesNotMatch(login, /id="login-wallet"|wallet-profile\.js/);
  assert.match(login, /id="login-sign" type="button">Connect and sign in/);
  assert.match(login, /label id="login-provider-field" hidden/);
  assert.match(login, /class="login-actions"/);
  for (const [source, id] of [[styles, "admin-wallet"]]) {
    assert.match(source, new RegExp(`#${id} \\{[^}]*position: relative;[^}]*flex: 0 0 32px;[^}]*width: 32px; height: 32px;[^}]*padding: 0;`));
    assert.match(source, new RegExp(`#${id} \\.wp-avatar \\{ width: 32px; height: 32px; box-sizing: border-box; \\}`));
  }
});
test("gateway retains verified uninitialized Gold snapshots for opening valuation instead of discarding them", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../scripts/serve.js"), "utf8");
  let reader, reads = 0;
  const snapshot = { chain: { id: 1 }, bridge: { configured: true, deployed: false, initialized: false }, checkedAt: new Date().toISOString() };
  vm.runInNewContext(source.slice(source.indexOf("cms.setPortfolioGold("), source.indexOf("\nfunction siteFor")), {
    cms: { setPortfolioGold: callback => { reader = callback; } }, portfolioGoldAt: 0, portfolioGoldCache: undefined,
    gold: { stats: async () => { reads++; return snapshot; }, marketPrice: async () => null }, console,
  });
  const result = await reader();
  assert.equal(result.bridge, snapshot.bridge);
  assert.equal(result.chain, snapshot.chain);
  await reader();
  assert.equal(reads, 1, "verified snapshots retain the existing bounded cache");
});
test("central public summaries share valuation sources without exposing private account metadata", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const app = {}, sources = { ethereum: { balance: "4" }, world: { available: "5", duplicate: false } };
  let priced, requested, worldRequested;
  const address = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const native = { balance: { available: "7", reserved: "0" } };
  vm.runInNewContext(source.slice(source.indexOf("app.walletSummary ="), source.indexOf("async function walletPortfolio(")), {
    app, require, dollarExchange: { account: () => ({ trades: [] }) },
    trading: { portfolioHoldings: (_, holdings) => holdings, account: () => ({ holdings: [], trades: [], movements: [] }) },
    creation: { markets: { account: () => ({ trades: [] }) }, db: { prepare: () => ({ all: () => [] }) },
      account(owner) { requested = owner; return { address: owner,
      holdings: [{ symbol: "FTHX", balance: 3 }], requests: ["private-request"], sites: ["private-site"] }; } },
    dollarWalletReader: () => native, walletSourceReader: async (owner, world) => { worldRequested = world; return sources; },
    walletPortfolio: async (holdings, extra) => { priced = { holdings, extra }; return { usd: "1.00" }; },
  });
  const result = await app.walletSummary(address);
  assert.equal(requested, address.toLowerCase());
  assert.equal(result.address, requested); assert.equal(result.dollar, native); assert.equal(result.world, sources.world);
  assert.equal(priced.holdings[0].balance, "7"); assert.equal(priced.holdings[1].symbol, "FTHX");
  assert.equal(priced.extra, sources); assert.equal(result.requests, undefined); assert.equal(result.sites, undefined);
  assert.deepEqual(Array.from(result.exchange.requests), []);
  await assert.rejects(app.walletSummary("invalid"), /Invalid Ethereum/);
  const world = '0x' + 'ab'.repeat(32);
  await app.walletSummary(address, world);
  assert.equal(worldRequested, world);
  await assert.rejects(app.walletSummary(address, 'invalid'), /Invalid public World/);
});
test("Notes market cards link to Exchange instead of rendering executable trade forms", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../shared/creation.js"), "utf8");
  const trending = source.slice(source.indexOf("async function trending()"));
  assert.doesNotMatch(trending, /tradeNote|markets\/trade|markets\/quote|el\("form"/);
  assert.match(trending, /trade\.href = hostUrl\("ex"\) \+ "\?market=" \+ encodeURIComponent\(note\.symbol\)/);
  assert.match(trending, /swap\.href = hostUrl\("ex"\) \+ "\?market=" \+ encodeURIComponent\("FTH\$"\)/);
  const css = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-app.css"), "utf8");
  assert.doesNotMatch(css, /\[data-primary=FTHX\]/);
  assert.match(css, /\[data-primary\]\[data-embedded=true\] main/);
});
test("versioned wallet JSON validates options and network origin defaults", () => {
  for (const [site, primary] of [["gold", "FTHG"], ["silver", "FTHS"], ["dollar", "FTH$"], ["world", "FTH$"], ["pay", "FTH$"], ["notes", "FTHX"], ["ex", "FTHX"], ["foundation", "FTHG"]]) {
    assert.equal(primaryFor(`${site}.featheral.com`), primary);
    const config = walletUi(new URLSearchParams({ parentOrigin: `https://${site}.featheral.com`, compact: "1", view: "swap" }));
    assert.equal(config.version, 1); assert.equal(config.primary, primary); assert.equal(config.signing, "wallet-provider"); assert.equal(config.view, "swap");
  }
  for (const params of [{ primary: "FTH!" }, { view: "<script>" }, { compact: "yes" }, { embedded: "1" },
    { selectionNonce: "bad", parentOrigin: "https://gold.featheral.com" },
    { selectionNonce: "ab".repeat(16) },
    { selectionNonce: "ab".repeat(16), embedded: "1", parentOrigin: "https://gold.featheral.com" },
    { parentOrigin: "https://gold.featheral.com.evil.example" }, { parentOrigin: "https://wallet.featheral.com/path" }, { address: "invalid" }])
    assert.throws(() => walletUi(new URLSearchParams(params)), /Unsupported/);
  assert.equal(allowedOrigin("http://world.localhost:8080"), true);
  assert.equal(allowedOrigin("https://evil.example"), false);
});
test("wallet palettes follow the parent site rather than its primary token and full-wallet links can retain them", () => {
  const palette = require("../../../shared/site-colors.json");
  for (const [hostname, colors] of Object.entries(palette)) {
    const config = walletUi(new URLSearchParams({ parentOrigin: `https://${hostname}`, primary: 'FTHX', view: 'account' }));
    assert.equal(config.theme.accent, colors.color);
    assert.equal(config.view, 'account');
    assert.equal(config.assets.includes('FTHX'), true);
    const full = walletUi(new URLSearchParams({ theme: config.theme.site }));
    assert.equal(full.theme.accent, config.theme.accent);
  }
  assert.throws(() => walletUi(new URLSearchParams({ theme: 'url(evil)' })), /Unsupported/);
});
test("wallet icon actions have accessible labels and retain visible network safety warnings", () => {
  const migrated = walletUi(new URLSearchParams({ view: 'tip' }));
  assert.equal(migrated.view, 'swap');
  assert.equal(migrated.actions.includes('tip'), false);
  const html = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-app.html"), "utf8");
  assert.match(html, /role="tablist"/);
  for (const name of ['assets', 'send', 'receive', 'swap', 'activity', 'account']) {
    assert.ok(html.includes(`role="tab" aria-controls="${name}"`));
    assert.ok(html.includes(`aria-labelledby="tab-${name}"`));
  }
  for (const label of ['Refresh balances', 'Connect / create wallet']) {
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.ok(html.includes(`data-tooltip="${label}"`));
  }
  assert.match(html, /FTHG: Ethereum Mainnet only\. Never send FTH\$ or notes as Ethereum tokens/);
  assert.doesNotMatch(html, /valuation-details/);
  assert.match(html, /id="address" type="text" readonly aria-label="Wallet address"/);
  assert.match(html, /id="copy-wallet-address" class="icon-button"/);
  const css = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-app.css"), "utf8");
  assert.match(css, /\[data-primary\] \.wallet-address #address\{[^}]*margin:0;/,
    "address input must override legacy ID margins so the inline copy icon stays centered");
  assert.doesNotMatch(css, /\[data-embedded=true\]\s+#local-wallet\s*\{display:none/);
});
test("X keeps its funds wallet without restoring paused social sessions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../sites/x.featheral.com/site.js"), "utf8");
  for (const [hostname, enabled] of [["x.featheral.com", false], ["x.localhost", false], ["sites.featheral.com", true]]) {
    let removed = false, suppressed = false, reads = 0;
    const button = { hidden: true, remove() { removed = true; } };
    const context = vm.createContext({ location: { hostname }, document: { body: { dataset: {} } },
      $: selector => selector === "header" ? { setAttribute() { suppressed = true; } } : button,
      localStorage: { getItem() { reads++; return '{"token":"retained-session"}'; } }, storageKey: String });
    vm.runInContext(source.slice(source.indexOf("if (location.hostname ==="), source.indexOf("const storageKey =")), context);
    vm.runInContext(source.slice(source.indexOf("let wallet ="), source.indexOf("const short =")), context);
    assert.equal(vm.runInContext("walletEnabled", context), enabled);
    assert.equal(removed, false); assert.equal(suppressed, false);
    assert.equal(reads, enabled ? 1 : 0);
    assert.equal(button.hidden, false);
  }
  assert.match(source, /Comments are read-only on this site/);
  assert.match(source, /if \(!walletEnabled\) return `<div class="vauthor">Posted by/);
  assert.match(source, /#fab'\)\.hidden = !walletEnabled/);
  const links = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  assert.match(links, /current !== "wallet" && current !== "admin" && !document\.querySelector\('script\[data-central-wallet-loader\]'\)/);
  const embed = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/embed.js"), "utf8");
  assert.match(embed, /!button\.dataset\.walletBound && site !== "x"/);
});

test("shared funds wallet remains available on standalone X while social sign-in stays paused", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../sites/x.featheral.com/site.js"), "utf8");
  const snippet = source.slice(source.indexOf("async function openWalletPanel()"), source.indexOf("// After a like:"));
  const calls = [], root = { style: {} }, dialog = { querySelector: selector => selector === '[data-wallet-root]' ? root : null, append() {} };
  const context = vm.createContext({ window: { FeatheralWallet: { open: config => calls.push(config) } },
    document: { getElementById: () => dialog, createElement: () => ({ dataset: {}, style: {}, addEventListener() {} }) },
    walletEnabled: true, toast() {}, wallet: { address: "0x1111111111111111111111111111111111111111" } });
  vm.runInContext(snippet, context); await context.openWalletPanel();
  assert.equal(calls[0].primary, "FTHX"); assert.equal(calls[0].compact, true);
  assert.equal(calls[0].address, undefined, "social account must not override the current funds wallet");
  assert.equal(root.style.height, 'calc(100% - 64px)');
  context.walletEnabled = false;
  await context.openWalletPanel();
  assert.equal(calls.length, 2, "X opens its contextual funds wallet independently of social sign-in");
  assert.doesNotMatch(source, /function addFthx|className = 'wpanel'|wallet\/deposit\/request/);
  assert.match(source, /addEventListener\('click', openWalletPanel\)/);
  let applied = 0;
  const button = { textContent: 'Shared wallet identity' };
  const paint = { window: { FeatheralWallet: { apply() { applied++; } } }, $: () => button };
  vm.runInNewContext(source.slice(source.indexOf("function paintWallet()"), source.indexOf("function setBalance(")), paint);
  paint.paintWallet();
  assert.equal(applied, 1, "site-local sign-ins defer header rendering to the shared wallet");
  assert.equal(button.textContent, 'Shared wallet identity');
});
test("legacy Foundation and Gold controls never restore local accounts or connect providers, including before embed loads", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-profile.js"), "utf8");
  for (const host of ["featheral.com", "gold.featheral.com", "dollar.featheral.com"]) {
    const calls = [], opens = [], events = {}, button = { dataset: {}, setAttribute() {}, addEventListener(name, callback) { events[name] = callback; } };
    const window = { location: new URL(`https://${host}`), addEventListener() {}, dispatchEvent() {},
      ethereum: { request: async request => { calls.push(request); return []; } },
      open: href => opens.push(href) };
    vm.runInNewContext(source, { window, document: {}, Event: class {}, URL });
    await window.FeatheralProfile.mount(button);
    assert.equal(button.dataset.centralWallet, "true");
    assert.deepEqual(calls, [], "no origin-specific restoration or price readers");
    await events.click({});
    assert.deepEqual(opens, [], "loading does not redirect away from the site");
    assert.match(button.title, /still loading/);
    assert.deepEqual(calls, []);
    window.FeatheralWallet = { open: config => opens.push(config) };
    await events.click({});
    assert.equal(opens[0].address, undefined, "central account must win over site state");
    assert.equal(opens[0].primary, host === "dollar.featheral.com" ? "FTH$" : "FTHG");
  }
});
test("community, creation and trading sign-ins reuse central authorization without requiring a site extension", async () => {
  const address = "0x" + "11".repeat(20), signature = "0x" + "ab".repeat(65);
  const authorization = { address, signature }, calls = [];
  const window = { FeatheralWallet: { async authenticate(challenge) { await challenge(address); return authorization; } } };
  const social = fs.readFileSync(path.join(__dirname, "../../../sites/x.featheral.com/site.js"), "utf8");
  let socialAccount;
  const context = { window, walletEnabled: true, api: async (url, input) => {
    calls.push({ url, input }); return url.endsWith("/nonce") ? { message: "standard challenge" } : { ...authorization, token: "social-only" };
  }, setWallet: account => { socialAccount = account; }, toast() {}, short: value => value, refreshBalance() {} };
  vm.runInNewContext(social.slice(social.indexOf("async function connectWallet()"), social.indexOf("async function disconnectWallet()")), context);
  assert.equal(await context.connectWallet(), true);
  assert.equal(socialAccount.address, address);
  assert.equal(socialAccount.token, "social-only");
  assert.equal(calls[0].url, "/api/public/wallet/nonce");
  assert.equal(calls[1].input.json.signature, signature);
  const creation = fs.readFileSync(path.join(__dirname, "../../../shared/creation.js"), "utf8");
  const start = creation.indexOf("    run(connect, async () => {");
  let handler, refreshed = false, session;
  const creationContext = { window, connect: {}, token: "", address: "", run: (_, callback) => { handler = callback; },
    api: async (url, method, input) => {
      calls.push({ url, method, input }); return url === "/challenge" ? { message: "standard challenge" } : { token: "creation-only" };
    }, localStorage: { setItem: (key, value) => { session = { key, value }; } }, refresh: async () => { refreshed = true; } };
  vm.runInNewContext(creation.slice(start, creation.indexOf("    if (exchangePage)", start)), creationContext);
  await handler();
  assert.equal(refreshed, true);
  assert.equal(creationContext.address, address);
  assert.equal(session.value, "creation-only");
  assert.equal(calls.at(-1).input.signature, signature);
});
test("shared header spacing keeps the connected address readable instead of forcing an icon-only width", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.css"), "utf8");
  assert.match(css, /header\[data-wallet-header\]\{[^}]*padding:10px clamp\(12px,2vw,24px\)/);
  assert.match(css, /header\[data-wallet-header\] \.central-wallet-button\{[^}]*width:auto;/,
    "shared button sizing must override .wallet-icon[data-central-wallet]");
  assert.match(css, /\.central-wallet-label\{display:inline;white-space:nowrap/);
  assert.match(css, /:is\(\[data-wallet-state=selected\],\[data-wallet-state=authorized\]\) \.central-wallet-label\{[^}]*font-family:ui-monospace/);
  assert.match(css, /header\[data-wallet-header\]:not\(\[data-wallet-header=FTHX\]\)\{flex-wrap:nowrap\}/,
    "mobile brand and wallet stay on one row");
});
test("standalone Wallet has spacious gold styling, readable actions and a full-width ecosystem footer", () => {
  const root = path.resolve(__dirname, "../../../");
  const html = fs.readFileSync(path.join(root, "sites/wallet.featheral.com/wallet-app.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "sites/wallet.featheral.com/wallet-app.css"), "utf8");
  const shared = fs.readFileSync(path.join(root, "shared/site-links.css"), "utf8");
  assert.match(html, /id="wallet-connect-label"/);
  assert.match(html, /class="wallet-safety" aria-label="Wallet safety"/);
  assert.match(html, /href="#account" class="wallet-account-link"/);
  assert.match(html, /Ethereum transactions require gas/);
  assert.match(css, /body\[data-primary\]:not\(\[data-embedded=true\]\) main\{max-width:680px/);
  assert.match(css, /body\[data-primary\]:not\(\[data-embedded=true\]\) \.icon-button\{width:44px;height:44px/);
  assert.match(css, /#wallet-connect-label\{display:none\}/, "embedded actions retain the compact icon layout");
  assert.match(shared, /footer\.eco-footer\{[^}]*max-width:none/);
});
test("shared skip links focus the content without changing SPA routes or duplicating existing links", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  const prefix = source.slice(source.indexOf("  function apply("), source.indexOf('    const header =')) + "\n}";
  for (const [current, embedded, existingSkip] of [["gold", false, false], ["wallet", true, false], ["media", false, true], ["admin", false, false]]) {
    let skip, focused, scrolled, prevented = false;
    const main = { hasAttribute: () => false, focus: options => { focused = options; }, scrollIntoView: options => { scrolled = options; } };
    const document = { body: { dataset: { embedded: String(embedded) }, prepend: node => { skip = node; } },
      querySelector: () => existingSkip, createElement: () => ({ addEventListener(_name, listener) { this.click = listener; } }) };
    const context = { current, document, window: { location: { href: "http://gold.localhost:8080/#/docs" } } };
    vm.runInNewContext(prefix + "; apply({querySelector:()=>main});", vm.createContext({ ...context, main }));
    if (embedded || existingSkip || current === "admin") { assert.equal(skip, undefined); continue; }
    assert.equal(skip.href, "#eco-main");
    assert.equal(main.tabIndex, -1);
    skip.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(focused.preventScroll, true);
    assert.equal(scrolled.block, "start");
    assert.equal(context.window.location.href, "http://gold.localhost:8080/#/docs");
  }
});
test("family pages remove stale published X links without touching Exchange, external sites or app routes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  const cleanup = source.slice(source.indexOf("    if (!standalone) for"), source.indexOf("    // World game pages"));
  for (const origin of ["https://gold.featheral.com/", "http://notes.localhost:8080/"]) {
    const make = (href, site) => ({ dataset: { ...(site ? { site } : {}) }, getAttribute: () => href,
      remove() { this.removed = true; } });
    const links = [make("/", "x"), make("https://x.featheral.com/"), make("http://x.localhost:8080/#/read"),
      make("https://ex.featheral.com/"), make("https://example.com/"), make("#/read"), make("/", "world")];
    const context = { standalone: false, root: { querySelectorAll: () => links }, URL,
      window: { location: new URL(origin) }, url: () => origin.includes("localhost") ? "http://x.localhost:8080/" : "https://x.featheral.com/" };
    vm.runInNewContext(cleanup, context);
    assert.deepEqual(links.map(link => !!link.removed), [true, true, origin.includes("localhost"), false, false, false, false]);
    links.forEach(link => { delete link.removed; });
    vm.runInNewContext(cleanup, { ...context, standalone: true });
    assert.ok(links.every(link => !link.removed), "X keeps its own app navigation");
  }
});
test("standalone X retains existing routes, labelled mobile tabs and accessible motion/focus styling", () => {
  const base = path.join(__dirname, "../../../sites/x.featheral.com");
  const html = fs.readFileSync(path.join(base, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(base, "standalone.css"), "utf8");
  const source = fs.readFileSync(path.join(base, "site.js"), "utf8");
  for (const [tab, route] of [["swipe", "#/"], ["trending", "#/trending"], ["thumbs", "#/thumbs"], ["read", "#/read"], ["liked", "#/liked"]])
    assert.match(html, new RegExp(`href="${route}" data-tab="${tab}"[^>]*aria-label="[^"]+"`));
  assert.match(html, /href="\/site\/standalone\.css"/);
  assert.match(html, /<nav class="tabs" aria-label="Discover">/);
  assert.doesNotMatch(html, /<footer/);
  assert.match(source, /location\.hostname === 'x\.featheral\.com' \|\| location\.hostname === 'x\.localhost'/);
  assert.match(source, /setAttribute\('aria-current', 'page'\)/);
  assert.match(css, /body\[data-standalone="x"\]/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.tabs a span \{ display: inline; \}/);
});
test("ecosystem navigation has compact family headers and the full footer hierarchy without embedded duplication", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  function fixture(host, embedded = false, query = "", initialSites = [], game = false) {
    class Node {
      constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; }
      append(...children) { this.children.push(...children); }
      remove() { body.children = body.children.filter(child => child !== this); }
      replaceChildren(...children) { this.children = children; }
      setAttribute(key, value) { this.attributes[key] = value; }
      querySelectorAll(selector) {
        if (selector === ".eco-bar, .eco-footer")
          return [...this.querySelectorAll(".eco-bar"), ...this.querySelectorAll(".eco-footer")];
        return this.children.flatMap(child => [
          ...((selector === ".eco-bar" && child.className === "eco-bar")
            || (selector === ".eco-footer" && child.className === "eco-footer")
            || (selector === "a" && child.tag === "a")
            || (selector === "a[data-site]" && child.tag === "a" && child.dataset.site)
            || (selector === 'nav a, .eco-bar a' && child.tag === "a") ? [child] : []),
          ...child.querySelectorAll(selector),
        ]);
      }
      querySelector(selector) {
        if (selector === 'script[data-central-wallet-loader]') return {};
        if (selector === "#app") return game ? {} : undefined;
        if (selector === "body > header, #app > header, header.topbar, #app header.topbar") return header;
        const site = selector.match(/^a\[data-site="(.+)"\]$/)?.[1];
        if (site) return this.querySelectorAll("a[data-site]").find(link => link.dataset.site === site);
        return this.querySelectorAll(selector)[0];
      }
    }
    const body = new Node("body"), header = new Node("header"), bar = new Node("nav");
    body.dataset.embedded = String(embedded); bar.className = "eco-bar"; body.append(bar, header);
    for (const site of initialSites) {
      const link = new Node("a"); link.dataset.site = site; link.textContent = "Legacy label";
      bar.append(link);
    }
    const document = { body, head: new Node("head"), readyState: "loading", createElement: tag => new Node(tag),
      addEventListener() {}, querySelector: selector => body.querySelector(selector),
      querySelectorAll: selector => body.querySelectorAll(selector) };
    const window = { location: new URL(`http://${host}.localhost:8080/${query}`), getComputedStyle: () => ({ position: "static" }) };
    vm.runInNewContext(source, { window, document, URL });
    window.FeatheralSites.apply();
    const firstLink = bar.querySelectorAll("a[data-site]")[0];
    window.FeatheralSites.apply();
    return { body, bar, firstLink, footer: body.querySelector(".eco-footer") };
  }
  const ui = fixture("gold"), links = ui.footer.querySelectorAll("a[data-site]");
  assert.equal(ui.body.querySelectorAll(".eco-footer").length, 1);
  const familySites = ["foundation", "gold", "dollar", "silver", "stats", "world", "media"];
  const barSites = familySites.filter(site => site !== "stats");
  for (const host of ["foundation", "gold", "silver", "dollar", "stats", "world", "app", "media", "wallet"]) {
    const { bar } = fixture(host);
    const headerLinks = bar.querySelectorAll("a[data-site]");
    assert.equal(bar.attributes["aria-label"], "Featheral family sites");
    assert.equal(bar.dataset.familyReady, "true", "only reveal the bar after its final links are initialized");
    for (const site of barSites) {
      assert.equal(headerLinks.filter(link => link.dataset.site === site).length, 1, `${host} shows ${site} once`);
      assert.equal(headerLinks.find(link => link.dataset.site === site).href,
        `http://${site === "foundation" ? "" : `${site}.`}localhost:8080/`);
    }
    if (host !== "stats") assert.ok(!headerLinks.some(link => link.dataset.site === "stats"), `${host} leaves Stats to the footer`);
    assert.ok(headerLinks.some(link => link.dataset.site === host), "the current site remains in its header");
    assert.equal(headerLinks.filter(link => link.attributes["aria-current"] === "page").length, 1);
  }
  assert.equal(ui.bar.querySelectorAll("a[data-site]").length, 6);
  for (const host of familySites) {
    const { bar, body } = fixture(host, false, "", ["world", "gold", "gold", "foundation"]);
    assert.equal(body.dataset.familyLayout, "true");
    const headerLinks = bar.querySelectorAll("a[data-site]");
    const expected = host === "stats" ? familySites : barSites;
    assert.deepEqual(headerLinks.map(link => link.dataset.site), expected,
      `${host} replaces stale, duplicate and reordered links with the exact family list`);
    for (const site of expected)
      assert.equal(headerLinks.find(link => link.dataset.site === site).href,
        `http://${site === "foundation" ? "" : `${site}.`}localhost:8080/`);
  }
  assert.ok(fixture("dollar").bar.querySelector('a[data-site="world"]'), "all core sites share the six family links");
  assert.ok(fixture("app").bar.querySelector('a[data-site="media"]'), "FTHX siblings remain available");
  for (const site of ["pay", "dollar", "world"])
    assert.ok(fixture("pay").bar.querySelector(`a[data-site="${site}"]`), `Pay includes its FTH$ sibling ${site}`);
  const fthxSites = ["app", "media", "ex", "notes", "sites", "wallet"];
  for (const host of fthxSites) {
    if (familySites.includes(host)) continue;
    const headerLinks = fixture(host).bar.querySelectorAll("a[data-site]");
    for (const site of fthxSites)
      assert.equal(headerLinks.filter(link => link.dataset.site === site).length, 1, `${host} includes its FTHX sibling ${site}`);
  }
  const stable = fixture("wallet");
  assert.equal(stable.bar.querySelectorAll("a[data-site]")[0], stable.firstLink,
    "reapplying unchanged navigation preserves link nodes and keyboard focus");
  assert.equal(links.length, 16);
  assert.equal(new Set(links.map(link => link.dataset.site)).size, 16);
  assert.equal(links.find(link => link.dataset.site === "pay").href, "http://pay.localhost:8080/");
  assert.ok(!links.some(link => link.dataset.site === "x"));
  for (const host of [...familySites, ...fthxSites, "admin", "db", "ledger"])
    assert.ok(!fixture(host).bar.querySelector('a[data-site="x"]'), `${host} never advertises standalone X`);
  assert.ok(links.some(link => link.dataset.site === "admin"));
  assert.ok(links.some(link => link.dataset.site === "media"));
  assert.equal(links.find(link => link.dataset.site === "gold").href, "http://gold.localhost:8080/");
  assert.equal(links.find(link => link.dataset.site === "foundation").href, "http://localhost:8080/");
  assert.equal(links.filter(link => link.attributes["aria-current"] === "page").length, 1);
  const foundation = ui.footer.children[0].children[0].children[0];
  assert.equal(foundation.children[0].dataset.site, "foundation");
  assert.deepEqual(foundation.children[1].children.map(group => group.children[0].textContent), ["Currencies", "World & community", "Apps", "Ledgers", "Tools"]);
  assert.equal(fixture("wallet", true).footer, undefined, "embedded wallets do not repeat host navigation");
  assert.equal(fixture("wallet", false, "?embedded=1").footer, undefined, "embedding is detected before async wallet initialization");
  assert.equal(fixture("admin").footer, undefined, "Admin keeps navigation inside its viewport-height workspace");
  const play = fixture("world", false, "explore/", [], true);
  assert.equal(play.body.querySelectorAll(".eco-bar").length, 0, "World game pages drop the family bar");
  assert.equal(play.footer, undefined, "World game pages drop the family footer");
  assert.equal(play.body.dataset.familyLayout, undefined, "World game pages keep their own full-viewport layout");
  const standalone = fixture("x", false, "", ["foundation", "x"]);
  assert.equal(standalone.body.querySelectorAll(".eco-bar").length, 0);
  assert.equal(standalone.footer, undefined);
  assert.equal(standalone.body.dataset.standalone, "x");
  assert.equal(standalone.body.dataset.familyLayout, undefined);
  const css = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.css"), "utf8");
  assert.match(css, /\.eco-bar:not\(\[data-family-ready\]\)\{visibility:hidden\}/);
  assert.match(css, /\.eco-bar\[data-family-ready\]\{[^}]*font:11px\/1\.5/);
  assert.match(css, /\.eco-bar\[data-family-ready\] a\{[^}]*font-size:inherit/);
  assert.match(css, /\.eco-bar\[data-family-ready\] a\[aria-current=page\]\{color:var\(--txt,var\(--text,/,
    "the current World link must not inherit white accent text on a white panel");
  assert.match(css, /body\[data-family-layout\]\{--site-width:1280px;--site-gutter:24px\}/);
  assert.match(css, /body\[data-family-layout\]>header\.top\{[^}]*box-sizing:border-box;[^}]*max-width:none;width:100%;[^}]*var\(--site-width\)/,
    "family header widths must not depend on async wallet initialization");
  assert.match(css, /\.eco-bar\[data-family-ready\] a\{[^}]*color:var\(--txt,var\(--text,/,
    "family links use readable theme foreground colors rather than muted text");
  assert.match(css, /body\.eco-fixed-header>#view\{height:auto;min-height:calc\(100dvh - var\(--eco-height\)\)\}/,
    "long desktop pages grow to keep the footer below their content");
  assert.match(css, /footer\.eco-footer\{display:block/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.eco-bar\{display:none!important\}/);
  assert.match(css, /footer\.eco-footer\{[^}]*text-align:left/);
  assert.match(css, /body\.eco-fixed-header>#view\{height:auto;min-height:100dvh\}/,
    "footer follows all SPA content instead of overlapping a viewport-height main");
  assert.doesNotMatch(source, /eco-toggle/);
});
test("native Ethereum pages retain signer IDs and expose a separate central FTHG wallet", () => {
  for (const [file, signer] of [["sites/wallet.featheral.com/ethereum/index.html", "walletButton"], ["sites/gold.featheral.com/conversion/index.html", "wallet"]]) {
    const html = fs.readFileSync(path.join(__dirname, "../../..", file), "utf8");
    assert.match(html, /data-central-wallet data-wallet-primary="FTHG">Wallet/);
    assert.match(html, new RegExp(`id="${signer}"[^>]+title="Connect Ethereum signer"[^>]+aria-label="Connect Ethereum signer"`));
  }
  const embed = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/embed.js"), "utf8");
  assert.match(embed, /const primary = button\.dataset\.walletPrimary \|\| defaultPrimary/);
  assert.match(embed, /open\(\{ primary, compact: true \}\)/);
});
test("wallet swaps default to 1% slippage and compute exact minimum outputs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-app.js"), "utf8");
  const helpers = source.slice(source.indexOf("function parseSwapTolerance("), source.indexOf("async function mountFeatheralWallet("));
  const context = vm.createContext({});
  vm.runInContext(helpers, context);

  assert.match(source, /swapSlippage\.value = "1"/, "the visible per-swap control starts at 1%");
  assert.match(source, /Quoted output: \$\{format\(quote\.output, quote\.to\)\}/);
  assert.match(source, /Minimum output: \$\{format\(minimum, quote\.to\)\}/);
  assert.match(source, /minOutput: minimum/, "the confirmed minimum is sent unchanged for settlement");

  assert.equal(context.parseSwapTolerance("1"), 100n);
  assert.equal(context.minimumSwapOutput("1000", context.parseSwapTolerance("1")), "990");
  assert.equal(context.parseSwapTolerance("0.25"), 25n);
  assert.equal(context.minimumSwapOutput("1000", context.parseSwapTolerance("0.25")), "997");

  const largeOutput = "9007199254740993123456789";
  assert.equal(context.minimumSwapOutput(largeOutput, context.parseSwapTolerance("1")),
    (BigInt(largeOutput) * 9900n / 10000n).toString());
  assert.equal(context.parseSwapTolerance("0"), 0n);
  assert.equal(context.minimumSwapOutput("0", 0n), "0");
  assert.equal(context.minimumSwapOutput("101", context.parseSwapTolerance("50.00")), "50");
  assert.equal(context.minimumSwapOutput("1", context.parseSwapTolerance("1")), "0",
    "minimum output rounds down rather than overstating the guaranteed amount");
  for (const invalid of ["", "-0.01", "50.01", "1.001", "1e2", "abc"])
    assert.throws(() => context.parseSwapTolerance(invalid), /between 0% and 50%/);
});
