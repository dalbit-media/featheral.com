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
    const config = walletUi(new URLSearchParams({ embedded: "1", parentOrigin: `https://${site}.featheral.com`, compact: "1", view: "swap" }));
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
    const config = walletUi(new URLSearchParams({ parentOrigin: `https://${hostname}`, embedded: '1', primary: 'FTHX', view: 'account' }));
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
test("X hides wallet controls without loading saved sessions or changing other CMS hosts", () => {
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
    assert.equal(removed, !enabled); assert.equal(suppressed, !enabled);
    assert.equal(reads, enabled ? 1 : 0);
    if (enabled) assert.equal(button.hidden, false);
  }
  assert.match(source, /if \(!walletEnabled\) \{ f.innerHTML = '<p class="count">Comments are read-only/);
  assert.match(source, /if \(!walletEnabled\) return `<div class="vauthor">Posted by/);
  assert.match(source, /#fab'\)\.hidden = !walletEnabled/);
  const links = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  assert.match(links, /current !== "admin" && current !== "x"/);
  const embed = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/embed.js"), "utf8");
  assert.match(embed, /!\["x.featheral.com", "x.localhost"\]\.includes\(location.hostname\)/);
});

test("shared CMS wallet remains available when enabled but is paused on standalone X", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../sites/x.featheral.com/site.js"), "utf8");
  const snippet = source.slice(source.indexOf("async function openWalletPanel()"), source.indexOf("// After a like:"));
  const calls = [], root = { style: {} }, dialog = { querySelector: selector => selector === '[data-wallet-root]' ? root : null, append() {} };
  const context = vm.createContext({ window: { FeatheralWallet: { open: config => calls.push(config) } },
    document: { getElementById: () => dialog, createElement: () => ({ dataset: {}, style: {}, addEventListener() {} }) },
    walletEnabled: true, toast() {}, wallet: { address: "0x1111111111111111111111111111111111111111" } });
  vm.runInContext(snippet, context); await context.openWalletPanel();
  assert.equal(calls[0].primary, "FTHX"); assert.equal(calls[0].compact, true); assert.equal(calls[0].address, context.wallet.address);
  assert.equal(root.style.height, 'calc(100% - 64px)');
  context.walletEnabled = false;
  await context.openWalletPanel();
  assert.equal(calls.length, 1, "paused X never opens the wallet");
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
function embedFixture({ withHeader = false, localhost = false, primary, hostStyle, hostname, store = new Map(), provider, profileReader, selectedProvider } = {}) {
  const elements = [], listeners = {}, messages = [], popups = [], timers = new Set(), timeouts = new Set(), profileCalls = [], errors = [];
  class Element {
    constructor(tag) { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.listeners = {}; this.isConnected = true;
      if (tag === "iframe") this.contentWindow = { postMessage: (data, origin) => messages.push({ data, origin }) };
      this.classes = new Set(); this.classList = { add: name => this.classes.add(name) }; elements.push(this); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = (event = { preventDefault() {}, stopImmediatePropagation() {} }) => callback(event); }
    hasAttribute(name) { return name === "data-central-wallet" && this.dataset.centralWallet !== undefined; }
    getBoundingClientRect() { return { bottom: 97 }; }
    querySelector(selector) {
      for (const child of this.children) {
        const key = selector.match(/^\[data-(.*)\]$/)?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (key ? child.dataset[key] : child.tag === selector) return child;
        const descendant = child.querySelector(selector);
        if (descendant) return descendant;
      }
      return null;
    }
    showModal() { if (this.open) throw new Error("Already open"); this.open = true; }
    close() { this.open = false; }
  }
  const header = withHeader ? new Element("header") : null, button = new Element("button"), swap = new Element("a");
  button.dataset.centralWallet = ""; swap.dataset.walletView = "swap";
  if (primary) button.dataset.walletPrimary = primary;
  if (header) { header.append(button, swap); header.querySelector = () => button; header.querySelectorAll = () => [swap]; }
  const document = { currentScript: { src: "https://wallet.featheral.com/embed.js" }, readyState: "complete",
    body: new Element("body"), createElement: tag => new Element(tag),
    getElementById: id => elements.find(el => el.id === id), querySelectorAll: () => [],
    querySelector: selector => selector === "header .central-wallet-button" ? withHeader ? button : null : header };
  const window = { ethereum: provider, FeatheralProfile: { getProvider: () => selectedProvider },
    localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) },
    addEventListener: (name, listener) => { listeners[name] = listener; },
    removeEventListener: (name, listener) => { if (listeners[name] === listener) delete listeners[name]; },
    crypto: { getRandomValues: array => array.fill(1) },
    open: href => { const popup = { href, postMessage: (data, origin) => messages.push({ data, origin }), close() { this.closed = true; } }; popups.push(popup); return popup; } };
  if (hostStyle) window.getComputedStyle = () => ({
    getPropertyValue: name => hostStyle[name] || '', backgroundColor: '#ffffff', color: '#202337', colorScheme: 'light',
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/embed.js"), "utf8"),
    { document, window, location: new URL(hostname ? `${localhost ? "http" : "https"}://${hostname}${localhost ? ":8080" : ""}` : localhost ? "http://notes.localhost:8080" : "https://notes.featheral.com"), URL, URLSearchParams,
      console: { error: (...args) => errors.push(args) },
      fetch: async (url, options) => {
        profileCalls.push({ url: String(url), options });
        return { ok: true, json: async () => ({ profile: profileReader ? await profileReader(String(url)) : null }) };
      },
      setTimeout(callback) { timeouts.add(callback); return callback; }, clearTimeout(callback) { timeouts.delete(callback); },
      setInterval(callback) { timers.add(callback); return callback; }, clearInterval(callback) { timers.delete(callback); } });
  return { wallet: window.FeatheralWallet, dialog: () => document.getElementById("featheral-central-wallet"), header, button, swap,
    listeners, messages, popups, timers, timeouts, store, profileCalls, errors };
}
test("Dollar embeds and full-wallet fallback retain the same payment recipient and amount", () => {
  const ui = embedFixture({ localhost: true, hostname: 'dollar.localhost' });
  const payment = new URLSearchParams({ to: '0x' + '22'.repeat(20), amount: '1.000000000000000001', name: 'Shop & cafe', currency: 'FTH$' });
  ui.wallet.open({ primary: 'FTH$', view: 'send', payment: payment.toString() });
  const frame = ui.dialog().querySelector('iframe');
  for (const [key, value] of payment) assert.equal(new URL(frame.src).searchParams.get(key), value);
  const links = ui.dialog().children.flatMap(child => child.children || []).filter(child => child.tag === 'a');
  const fallback = links.find(link => link.textContent === 'Open full wallet ↗');
  assert.ok(fallback);
  for (const [key, value] of payment) assert.equal(new URL(fallback.href).searchParams.get(key), value);
  payment.set('amount', '2');
  ui.wallet.open({ primary: 'FTH$', view: 'send', payment: payment.toString() });
  assert.equal(new URL(ui.dialog().querySelector('iframe').src).searchParams.get('amount'), '2');
  ui.wallet.open({ primary: 'FTH$', view: 'send' });
  assert.equal(new URL(ui.dialog().querySelector('iframe').src).searchParams.has('to'), false);
});
test("site wallet buttons keep their wallet icon beside the public avatar and five-character address suffix", async () => {
  const address = '0x' + '1'.repeat(35) + 'abcde', avatar = 'data:image/png;base64,YXZhdGFy';
  for (const primary of ['FTHG', 'FTH$', 'FTHX']) {
    const ui = embedFixture({ withHeader: true, primary, profileReader: async () => ({ avatar }) });
    assert.equal(ui.button.children[0].className, 'central-wallet-icon');
    assert.equal(ui.button.children.at(-1).textContent, 'Wallet');
    ui.wallet.open({ primary });
    const frame = ui.dialog().querySelector('iframe');
    await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow,
      data: { type: 'featheral:wallet-selected', address } });
    await new Promise(setImmediate);
    assert.match(ui.button.children[0].innerHTML, /<rect/);
    assert.equal(ui.button.children[1].className, 'central-wallet-avatar');
    assert.equal(ui.button.children[1].children[0].src, avatar);
    assert.equal(ui.button.children.at(-1).textContent, '..abcde');
    assert.match(ui.button.title, new RegExp(address));
    assert.match(ui.button['aria-label'], new RegExp(primary.replace('$', '\\$')));
    assert.equal(ui.button.dataset.walletState, 'selected');
    assert.equal(ui.profileCalls[0].url, `/api/v1/notes/profiles/${address}`);
    assert.equal(ui.profileCalls[0].options.credentials, 'omit');
    ui.wallet.apply();
    assert.equal(ui.profileCalls.length, 1, 'applying the header again does not refetch the avatar');
    ui.button.listeners.click();
    assert.equal(ui.dialog().querySelector('iframe'), frame, 'identity rendering preserves the inline wallet');
    const reloaded = embedFixture({ withHeader: true, primary, store: ui.store, profileReader: async () => ({ avatar }) });
    await new Promise(setImmediate);
    assert.equal(reloaded.button.children.at(-1).textContent, '..abcde');
    assert.equal(reloaded.button.children[1].children[0].src, avatar);
    assert.equal(reloaded.errors.length, 0);
  }
});
test("header identity ignores untrusted and pinned selections, rejects unsafe avatars and avoids stale profile races", async () => {
  const first = '0x' + '1'.repeat(40), second = '0x' + '2'.repeat(40);
  let resolveFirst;
  const ui = embedFixture({ withHeader: true, profileReader: url => url.endsWith(first)
    ? new Promise(resolve => { resolveFirst = resolve; }) : { avatar: '' } });
  ui.wallet.open();
  const frame = ui.dialog().querySelector('iframe');
  const select = (source, address, origin = 'https://wallet.featheral.com') => ui.listeners.message({
    origin, source, data: { type: 'featheral:wallet-selected', address } });
  await select(frame.contentWindow, first, 'https://evil.example');
  await select({}, first);
  const root = { dataset: {}, style: {}, setAttribute() {}, replaceChildren(...children) { this.children = children; } };
  ui.wallet.mount(root, { address: first });
  await select(root.children[0].contentWindow, first);
  assert.equal(ui.button.children.at(-1).textContent, 'Wallet');
  assert.equal(ui.profileCalls.length, 0);
  await select(frame.contentWindow, first);
  await new Promise(setImmediate);
  await select(frame.contentWindow, second);
  await new Promise(setImmediate);
  resolveFirst({ avatar: 'data:image/png;base64,YXZhdGFy' });
  await new Promise(setImmediate);
  assert.equal(ui.button.children.at(-1).textContent, '..22222');
  assert.match(ui.button.children[1].innerHTML, /<circle/);
  assert.equal(ui.button.children[1].children.length, 0);
  const invalid = embedFixture({ withHeader: true, store: new Map([['featheral-wallet-public-account', first]]),
    profileReader: async () => ({ avatar: 'https://untrusted.example/tracking.png' }) });
  await new Promise(setImmediate);
  assert.match(invalid.button.title, /Avatar unavailable/);
  assert.match(invalid.button.children[1].innerHTML, /<circle/);
  assert.equal(invalid.errors.length, 1);
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
test("central public selection persists across page reloads while reopening retains the connected renderer", async () => {
  for (const hostname of ['gold.featheral.com', 'dollar.featheral.com']) {
    const ui = embedFixture({ hostname }), address = '0x' + '22'.repeat(20);
    ui.wallet.open();
    const frame = ui.dialog().querySelector('iframe');
    ui.wallet.connect();
    assert.equal(ui.dialog().querySelector('iframe'), frame);
    const origin = 'https://wallet.featheral.com', data = { type: 'featheral:wallet-selected', address };
    for (const event of [
      { origin: 'https://evil.example', source: frame.contentWindow, data },
      { origin, source: {}, data },
      { origin, source: frame.contentWindow, data: { ...data, address: 'invalid' } },
    ]) await ui.listeners.message(event);
    assert.equal(new URL(frame.src).searchParams.has('address'), false);
    await ui.listeners.message({ origin, source: frame.contentWindow, data });
    assert.equal(ui.messages.at(-1).data.address, address);
    const before = frame.src;
    await ui.listeners.message({ origin, source: frame.contentWindow, data });
    assert.equal(frame.src, before);
    await ui.listeners.message({ origin, source: frame.contentWindow, data: { type: 'featheral:wallet-ready' } });
    const selection = ui.messages.find(message => message.data.type === 'featheral:wallet-selection');
    assert.equal(selection.origin, origin);
    assert.deepEqual(Object.keys(selection.data).sort(), ['address', 'type']);
    ui.wallet.open();
    assert.equal(ui.dialog().querySelector('iframe'), frame);
    const reloaded = embedFixture({ hostname, store: ui.store }); reloaded.wallet.open();
    assert.equal(new URL(reloaded.dialog().querySelector('iframe').src).searchParams.get('address'), address);
    assert.deepEqual([...ui.store.keys()], ['featheral-wallet-public-account']);
    assert.equal(ui.dialog().querySelector('a').textContent, 'Open full wallet ↗');
    assert.equal(ui.popups.length, 0);
  }
});
test("inline extension bridge trusts only a mounted following renderer and validates methods and accounts", async () => {
  const address = '0x' + '11'.repeat(20), calls = [];
  const ui = embedFixture({ provider: { on() {}, async request(request) {
    calls.push(request); return request.method === 'personal_sign' ? 'signature' : [address];
  } } });
  ui.wallet.open();
  const frame = ui.dialog().querySelector('iframe'), origin = 'https://wallet.featheral.com';
  const data = { type: 'featheral:wallet-provider', id: 'one', request: { method: 'eth_accounts' } };
  await ui.listeners.message({ origin: 'https://evil.example', source: frame.contentWindow, data });
  await ui.listeners.message({ origin, source: {}, data });
  assert.deepEqual(calls, []);
  await ui.listeners.message({ origin, source: frame.contentWindow, data });
  assert.equal(calls.length, 1);
  assert.equal(ui.messages.at(-1).data.result[0], address);
  await ui.listeners.message({ origin, source: frame.contentWindow, data: { ...data, id: 'two', request: { method: 'eth_sendTransaction' } } });
  assert.match(ui.messages.at(-1).data.error, /Unsupported/);
  assert.equal(calls.length, 1);
  await ui.listeners.message({ origin, source: frame.contentWindow, data: { ...data, id: 'three',
    request: { method: 'personal_sign', params: ['0x1234', '0x' + '22'.repeat(20)] } } });
  assert.match(ui.messages.at(-1).data.error, /account changed/);
  assert.ok(!calls.some(call => call.method === 'personal_sign'));
  await ui.listeners.message({ origin, source: frame.contentWindow, data: { ...data, id: 'four',
    request: { method: 'personal_sign', params: ['0x1234', address] } } });
  assert.equal(ui.messages.at(-1).data.result, 'signature');
  const pinned = { dataset: {}, style: {}, setAttribute() {}, replaceChildren(...children) { this.children = children; } };
  ui.wallet.mount(pinned, { address });
  const pinnedFrame = pinned.children.find(child => child.tag === 'iframe');
  const before = calls.length;
  await ui.listeners.message({ origin, source: pinnedFrame.contentWindow, data });
  assert.equal(calls.length, before, 'pinned address embeds have no provider authority');
  assert.ok(frame.sandbox.includes('allow-popups-to-escape-sandbox'));
  assert.ok(!frame.sandbox.includes('allow-top-navigation'));
  assert.ok(frame.sandbox.includes('allow-downloads'));
  assert.ok(frame.sandbox.includes('allow-forms'));
});
test("central sign-in transport binds renderer, nonce and account, returning only a signature", async () => {
  const ui = embedFixture(), address = "0x" + "11".repeat(20), signature = "0x" + "ab".repeat(65), challenges = [];
  ui.wallet.open();
  const frame = ui.dialog().querySelector("iframe");
  const pending = ui.wallet.authenticate(async owner => { challenges.push(owner); return { message: "standard challenge" }; });
  const popup = frame.contentWindow, nonce = ui.messages.find(message => message.data.type === 'featheral:wallet-auth-start').data.nonce;
  const ready = { type: "featheral:wallet-auth-ready", nonce, address };
  await ui.listeners.message({ origin: "https://evil.example", source: popup, data: ready });
  await ui.listeners.message({ origin: "https://wallet.featheral.com", source: {}, data: ready });
  assert.deepEqual(challenges, []);
  await ui.listeners.message({ origin: "https://wallet.featheral.com", source: popup, data: ready });
  assert.deepEqual(challenges, [address]);
  assert.equal(ui.messages.find(message => message.data.type === 'featheral:wallet-auth').data.message, "standard challenge");
  await ui.listeners.message({ origin: "https://wallet.featheral.com", source: popup, data: { type: "featheral:wallet-signature", nonce, address, signature } });
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), ["address", "signature"]);
  assert.equal(result.address, address); assert.equal(result.signature, signature);
  const selection = ui.messages.find(message => message.data.type === "featheral:wallet-selection");
  assert.equal(selection.data.address, address, "approved central selection updates public views even if iframe storage is isolated");
  assert.deepEqual(Object.keys(selection.data).sort(), ["address", "type"]);
  assert.equal(selection.origin, "https://wallet.featheral.com");
  ui.wallet.open();
  assert.equal(ui.dialog().querySelector("iframe"), frame);
  assert.equal(ui.timers.size, 0); assert.equal(ui.popups.length, 0);
});
test("profile account selection uses only the mounted trusted wallet and never requests a signature", async () => {
  const ui = embedFixture(), address = "0x" + "12".repeat(20);
  const pending = ui.wallet.account(), frame = ui.dialog().querySelector("iframe");
  const nonce = ui.messages.find(message => message.data.type === "featheral:wallet-auth-start").data.nonce;
  const ready = { type: "featheral:wallet-auth-ready", nonce, address };
  await ui.listeners.message({ origin: "https://evil.example", source: frame.contentWindow, data: ready });
  assert.equal(ui.messages.some(message => message.data.type === "featheral:wallet-auth-cancel"), false);
  await ui.listeners.message({ origin: "https://wallet.featheral.com", source: frame.contentWindow, data: ready });
  const result = await pending;
  assert.equal(result.address, address); assert.deepEqual(Object.keys(result), ["address"]);
  assert.equal(ui.messages.some(message => message.data.type === "featheral:wallet-auth"), false);
  assert.equal(ui.messages.some(message => message.data.type === "featheral:wallet-auth-cancel"), true);
  assert.equal(ui.timers.size, 0);
});
test("central sign-in failures and cancellation clear popup listeners without silently connecting", async () => {
  const ui = embedFixture();
  const result = ui.wallet.authenticate(async () => { throw new Error("Challenge offline"); });
  const failed = assert.rejects(result, /Challenge offline/);
  await assert.rejects(ui.wallet.authenticate(async () => ({})), /existing wallet connection/);
  const popup = ui.dialog().querySelector('iframe').contentWindow,
    nonce = ui.messages.find(message => message.data.type === 'featheral:wallet-auth-start').data.nonce;
  await ui.listeners.message({ origin: "https://wallet.featheral.com", source: popup,
    data: { type: "featheral:wallet-auth-ready", nonce, address: "0x" + "11".repeat(20) } });
  await failed; assert.equal(ui.timers.size, 0);
  const cancelled = ui.wallet.authenticate(async () => ({}));
  const rejected = assert.rejects(cancelled, /cancelled/);
  ui.dialog().close(); [...ui.timers][0](); await rejected;
  assert.equal(ui.timers.size, 0);
});
test("API, embedded renderer and compatibility profile agree on every site's primary currency", () => {
  const profiles = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-profile.js"), "utf8");
  const groups = [
    ["featheral.com", "localhost", "gold.featheral.com", "gold.localhost", "foundation.localhost"],
    ["dollar.featheral.com", "dollar.localhost", "world.featheral.com", "world.localhost"],
    ["notes.featheral.com", "notes.localhost", "ex.featheral.com", "ex.localhost", "x.featheral.com",
      "x.localhost", "sites.featheral.com", "stats.featheral.com", "wallet.featheral.com", "admin.featheral.com", "community.featheral.com"],
    ["silver.featheral.com", "silver.localhost"],
  ];
  groups.forEach((hosts, i) => {
    const primary = ["FTHG", "FTH$", "FTHX", "FTHS"][i];
    for (const hostname of hosts) {
      const localhost = hostname === "localhost" || hostname.endsWith(".localhost");
      const origin = `${localhost ? "http" : "https"}://${hostname}${localhost ? ":8080" : ""}`;
      assert.equal(primaryFor(hostname), primary, hostname);
      assert.equal(walletUi(new URLSearchParams({ parentOrigin: origin, embedded: "1" })).primary, primary, hostname);
      const ui = embedFixture({ hostname, localhost });
      ui.wallet.open();
      const frame = ui.dialog().querySelector("iframe");
      assert.equal(new URL(frame.src).searchParams.get("primary"), primary, hostname);
      assert.equal(new URL(frame.src).pathname, "/", "all sites use the same renderer");
      const context = { window: { location: new URL(origin) } };
      vm.runInNewContext(profiles.slice(0, profiles.indexOf("  let primary = defaultPrimary;")) + "globalThis.result = defaultPrimary;})();", context);
      assert.equal(context.result, primary, hostname);
    }
  });
});
test("opening and reopening localhost wallets never launch a sync popup", () => {
  for (const primary of ["FTHG", "FTH$", "FTHX"]) {
    const ui = embedFixture({ withHeader: true, localhost: true, primary });
    ui.button.listeners.click();
    assert.equal(ui.dialog().open, true);
    ui.dialog().close();
    ui.button.listeners.click();
    assert.equal(ui.dialog().open, true);
    assert.equal(ui.popups.length, 0);
    ui.listeners.message({ origin: "https://wallet.featheral.com", source: ui.dialog().querySelector("iframe").contentWindow,
      data: { type: "featheral:wallet-ready" } });
    assert.equal(ui.popups.length, 0);
  }
});
test("wallet panels have no manual public sync or popup and only notify their own ready renderer", () => {
  const ui = embedFixture({ withHeader: true, localhost: true });
  ui.button.listeners.click();
  assert.equal(ui.popups.length, 0);
  const root = ui.dialog().querySelector("[data-wallet-root]");
  assert.equal(root.children.some(child => child.tag === "button"), false);
  const frame = ui.dialog().querySelector("iframe");
  const context = { address: "0x1111111111111111111111111111111111111111", addresses: ["0x1111111111111111111111111111111111111111"], worldAccount: null };
  const data = { type: "featheral:wallet-context", context };
  ui.listeners.message({ origin: "https://evil.example", source: frame.contentWindow, data });
  ui.listeners.message({ origin: "https://wallet.featheral.com", source: frame.contentWindow, data });
  ui.listeners.message({ origin: "https://wallet.featheral.com", source: {}, data: { type: "featheral:wallet-ready" } });
  assert.equal(ui.messages.length, 0);
  ui.listeners.message({ origin: "https://wallet.featheral.com", source: ui.dialog().querySelector("iframe").contentWindow,
    data: { type: "featheral:wallet-ready" } });
  assert.equal(ui.messages.length, 3);
  assert.equal(ui.messages[1].origin, "https://wallet.featheral.com");
  assert.equal(ui.messages[2].data.type, "featheral:wallet-updated");
  assert.equal(ui.messages[2].data.context, undefined);
  ui.listeners.message({ origin: "https://wallet.featheral.com", source: frame.contentWindow, data: { type: "featheral:wallet-sync" } });
  assert.equal(ui.popups.length, 0);
});
test("theme handoffs go only to a mounted central renderer and contain host colors, never account credentials", () => {
  const ui = embedFixture({ hostStyle: { '--gold': '#655bd4', '--panel': '#ffffff', '--txt': '#202337', '--mut': '#70758b' } });
  ui.wallet.open();
  const frame = ui.dialog().querySelector('iframe');
  ui.listeners.message({ origin: 'https://evil.example', source: frame.contentWindow, data: { type: 'featheral:wallet-ready' } });
  ui.listeners.message({ origin: 'https://wallet.featheral.com', source: {}, data: { type: 'featheral:wallet-ready' } });
  assert.equal(ui.messages.length, 0);
  ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow, data: { type: 'featheral:wallet-ready' } });
  assert.equal(ui.messages.length, 3);
  assert.equal(ui.messages[0].data.type, 'featheral:wallet-theme');
  assert.equal(ui.messages[0].data.theme.accent, '#655bd4');
  assert.equal(ui.messages[0].data.theme.panel, '#ffffff');
  assert.equal(ui.messages[0].data.theme.text, '#202337');
  assert.equal(ui.messages[0].data.theme.scheme, 'light');
  assert.equal(ui.messages[0].data.context, undefined);
  assert.equal(ui.messages[0].origin, 'https://wallet.featheral.com');
  assert.equal(ui.messages[1].data.type, 'featheral:wallet-provider-status');
  assert.equal(ui.messages[2].data.type, 'featheral:wallet-updated');
});
test("wallet stays hidden until its own renderer applies the host palette, with retry and a context-preserving full wallet", async () => {
  const ui = embedFixture({ hostStyle: { '--panel': '#ffffff', '--txt': '#202337' } });
  ui.wallet.open({ primary: 'FTHS', view: 'receive' });
  const root = ui.dialog().querySelector('[data-wallet-root]'), frame = root.querySelector('iframe');
  assert.match(frame.style.cssText, /visibility:hidden/);
  assert.equal(frame.loading, 'eager');
  assert.equal(root['aria-busy'], 'true');
  assert.equal(ui.timeouts.size, 1);
  const full = new URL(root.querySelector('a').href);
  assert.equal(full.searchParams.get('primary'), 'FTHS');
  assert.equal(full.searchParams.get('view'), 'receive');
  assert.equal(full.searchParams.get('parentOrigin'), 'https://notes.featheral.com');
  assert.equal(full.searchParams.has('embedded'), false);
  assert.equal(root.querySelector('a').rel, 'noopener');
  const ack = { type: 'featheral:wallet-themed' };
  await ui.listeners.message({ origin: 'https://evil.example', source: frame.contentWindow, data: ack });
  await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: {}, data: ack });
  assert.notEqual(frame.style.visibility, 'visible');
  await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow, data: ack });
  assert.equal(frame.style.visibility, 'visible');
  assert.equal(root.querySelector('div').hidden, true);
  assert.equal(root['aria-busy'], 'false');
  assert.equal(ui.timeouts.size, 0);

  await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow, data: { type: 'featheral:wallet-error' } });
  const status = root.querySelector('div');
  assert.equal(status.hidden, false);
  assert.match(status.querySelector('span').textContent, /could not load/);
  status.querySelector('button').listeners.click();
  const replacement = root.querySelector('iframe');
  assert.notEqual(replacement, frame);
  assert.equal(ui.timeouts.size, 1);
  await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow, data: ack });
  assert.notEqual(replacement.style.visibility, 'visible', 'old renderer cannot unhide its replacement');
  [...ui.timeouts][0]();
  assert.match(root.querySelector('div').querySelector('span').textContent, /longer than expected/);
  assert.equal(root.querySelector('div').querySelector('button').hidden, false);
  assert.equal(ui.popups.length, 0);
});
test("wallet bridge uses the site's selected provider and rejects account changes during a signature", async () => {
  const address = '0x' + '11'.repeat(20), calls = [];
  let changed = false;
  const selectedProvider = { async request(request) {
    calls.push(request.method);
    if (request.method === 'personal_sign') { changed = true; return 'signature'; }
    return [changed ? '0x' + '22'.repeat(20) : address];
  } };
  const ui = embedFixture({ provider: { request() { throw new Error('Wrong extension'); } }, selectedProvider });
  ui.wallet.open();
  const frame = ui.dialog().querySelector('iframe');
  await ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow,
    data: { type: 'featheral:wallet-provider', id: 'sign', request: { method: 'personal_sign', params: ['0x1234', address] } } });
  assert.deepEqual(calls, ['eth_accounts', 'personal_sign', 'eth_accounts']);
  assert.match(ui.messages.at(-1).data.error, /account changed/);
  assert.equal(ui.messages.at(-1).data.result, undefined);
});
test("EIP-6963 wallets can be selected without a global injected provider or silently choosing the wrong extension", async () => {
  const ui = embedFixture(), calls = [];
  const providers = ['One', 'Two'].map(name => ({ name, request: async () => { calls.push(name); return []; } }));
  for (const provider of providers) ui.listeners['eip6963:announceProvider']({ detail: { provider, info: { name: provider.name } } });
  ui.wallet.open();
  const frame = ui.dialog().querySelector('iframe'), picker = ui.dialog().querySelector('select');
  assert.equal(picker.hidden, false);
  const request = () => ui.listeners.message({ origin: 'https://wallet.featheral.com', source: frame.contentWindow,
    data: { type: 'featheral:wallet-provider', id: 'account', request: { method: 'eth_requestAccounts' } } });
  await request();
  assert.match(ui.messages.at(-1).data.error, /Choose your browser wallet/);
  assert.equal(calls.length, 0);
  picker.value = '1'; picker.listeners.change();
  await request();
  assert.deepEqual(calls, ['Two']);
});
test("header wallet and swap controls open the same inline wallet without credentials", () => {
  const { wallet, dialog, header, button, swap } = embedFixture({ withHeader: true });
  assert.equal(header.dataset.walletHeader, "FTHX");
  assert.ok(button.classes.has("central-wallet-button"));
  assert.equal(button["aria-label"], "Open FTHX wallet");
  button.dataset.walletAddress = "0x1111111111111111111111111111111111111111";
  button.listeners.click();
  assert.equal(dialog().style.top, "105px");
  assert.equal(dialog().style.height, "min(800px,calc(100dvh - 121px))");
  const url = new URL(dialog().querySelector("iframe").src);
  assert.equal(url.searchParams.has("address"), false, "normal headers follow the central account, not a stale site-local address");
  assert.equal(url.searchParams.get("primary"), "FTHX");
  assert.equal(url.searchParams.get("followActive"), "1");
  assert.equal(url.searchParams.has("token"), false);
  const handler = button.listeners.click;
  wallet.apply();
  assert.equal(button.listeners.click, handler);
  swap.listeners.click({ preventDefault() {} });
  assert.equal(dialog().open, true);
});
test("shared header spacing keeps the connected address readable instead of forcing an icon-only width", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.css"), "utf8");
  assert.match(css, /header\[data-wallet-header\]\{[^}]*padding:10px clamp\(12px,2vw,24px\)/);
  assert.match(css, /header\[data-wallet-header\] \.central-wallet-button\{[^}]*width:auto;/,
    "shared button sizing must override .wallet-icon[data-central-wallet]");
  assert.match(css, /\.central-wallet-label\{display:inline;white-space:nowrap/);
  assert.match(css, /\[data-wallet-state=selected\] \.central-wallet-label\{[^}]*font-family:ui-monospace/);
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
test("FTHX wallets reuse the previous X-sized panel and switch views without remounting", () => {
  const { wallet, dialog, messages } = embedFixture();
  wallet.open();
  const panel = dialog(), root = panel.querySelector("[data-wallet-root]");
  assert.equal(panel.dataset.walletPrimary, "FTHX");
  assert.match(panel.style.cssText, /inset:64px 12px auto auto;margin:0;width:min\(380px/);
  assert.match(panel.style.cssText, /background:var\(--panel,#16161f\)/);
  assert.match(root.querySelector("iframe").style.cssText, /min-height:0;flex:1/);
  assert.equal(new URL(root.querySelector("iframe").src).searchParams.get("primary"), "FTHX");
  wallet.open({ primary: "FTHX", view: "swap", address: "0x1111111111111111111111111111111111111111" });
  assert.equal(dialog(), panel);
  assert.equal(messages.at(-1).data.type, "featheral:wallet-view");
  assert.equal(messages.at(-1).data.view, "swap");
  assert.equal(new URL(root.querySelector("a").href).searchParams.has("address"), false);
  assert.equal(new URL(root.querySelector("iframe").src).searchParams.get("followActive"), "1");
  assert.equal(panel.open, true);
  panel.querySelector("button").listeners.click();
  assert.equal(panel.open, false);
  wallet.open();
  panel.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(panel.open, false);
});
test("every primary uses the same compact top-right layout while retaining its currency", () => {
  const { wallet, dialog } = embedFixture();
  let style;
  for (const primary of ["FTHX", "FTH$", "FTHG"]) {
    wallet.open({ primary, compact: true });
    const panel = dialog(), root = panel.querySelector("[data-wallet-root]");
    style ||= panel.style.cssText;
    assert.equal(panel.style.cssText, style);
    assert.match(panel.style.cssText, /inset:64px 12px auto auto/);
    assert.equal(panel.dataset.walletPrimary, primary);
    assert.match(root.style.cssText, /display:flex/);
    assert.match(root.querySelector("iframe").style.cssText, /min-height:0;flex:1/);
    assert.equal(panel.querySelector("b").textContent, "Wallet");
    assert.equal(root.querySelector("iframe").title, `Featheral ${primary} wallet`);
  }
});
test("native Ethereum pages retain signer IDs and expose a separate central FTHG wallet", () => {
  for (const [file, signer] of [["sites/wallet.featheral.com/ethereum/index.html", "walletButton"], ["sites/gold.featheral.com/conversion/index.html", "wallet"]]) {
    const html = fs.readFileSync(path.join(__dirname, "../../..", file), "utf8");
    assert.match(html, /data-central-wallet data-wallet-primary="FTHG">Wallet/);
    assert.match(html, new RegExp(`id="${signer}"[^>]+title="Connect Ethereum signer"[^>]+aria-label="Connect Ethereum signer"`));
  }
  const ui = embedFixture({ withHeader: true, primary: "FTHG" });
  assert.equal(ui.button["aria-label"], "Open FTHG wallet");
  ui.button.listeners.click();
  assert.equal(new URL(ui.dialog().querySelector("iframe").src).searchParams.get("primary"), "FTHG");
  assert.match(ui.dialog().style.cssText, /width:min\(380px/);
});
