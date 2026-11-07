const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { walletUi, primaryFor } = require('../../wallet/ui');
const root = path.resolve(__dirname, '../../..');
const embed = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/embed.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/wallet-app.js'), 'utf8');
const address = '0x' + '11'.repeat(20), other = '0x' + '22'.repeat(20), signature = '0x' + 'ab'.repeat(65);
const tick = () => new Promise(setImmediate);
test('reader-mode World balance lookup reports unavailability without throwing an expected capability error', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  const body = source.slice(source.indexOf('const readWorld = async () => {'), source.indexOf('const [native]'));
  const errors = [];
  const context = vm.createContext({ store: null, worldError: null, console: { error: (...args) => errors.push(args) } });
  vm.runInContext(`${body}; readWorld();`, context);
  assert.match(context.worldError, /read-only server/);
  assert.match(context.worldError, /World writer/);
  assert.equal(errors.length, 0);
});
test('wallet accepts the real open-membership App challenge and rejects changed origins or authorization terms', () => {
  const { Notes } = require('../../notes/ledger');
  const { Creation } = require('../../notes/creation');
  const { Workspace } = require('../../notes/workspace');
  const { validate } = require('../../../sites/wallet.featheral.com/site-sign-in');
  const notes = new Notes(':memory:');
  try {
    const creation = new Creation(notes, {}), workspace = new Workspace(notes, creation.markets);
    for (const origin of ['https://app.featheral.com', 'http://app.localhost:8080']) {
      const challenge = workspace.challenge(address, origin);
      assert.doesNotThrow(() => validate(address, challenge.message, true, origin));
      assert.throws(() => validate(address, challenge.message, true, 'https://notes.featheral.com'), /origin/);
      assert.throws(() => validate(other, challenge.message, true, origin), /standard/);
      assert.throws(() => validate(address, challenge.message.replace('No transfer or salary approval.', 'Approve all salary transfers.'), true, origin), /standard/);
    }
  } finally { notes.close(); }
});
function fixture({ hostname = 'notes.featheral.com', fail = false, store = new Map(), width = 1000, height = 800, buttonCount = 1 } = {}) {
  const elements = [], instances = [], requests = [], timers = new Set(), errors = [];
  class Element {
    constructor(tag) {
      assert.notEqual(tag, 'iframe');
      this.tag = tag; this.dataset = {}; this.children = []; this.listeners = {};
      this.style = { setProperty(name, value) { this[name] = value; } };
      this.isConnected = true; this.classList = { add() {} }; elements.push(this);
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(name, value) { this[name] = value; }
    getAttribute(name) { return this[name]; }
    hasAttribute() { return false; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelector(selector) {
      if (selector.startsWith('.connection-option')) return new Element('p');
      for (const child of this.children) {
        if (selector === child.tag || selector === '[data-wallet-root]' && child.dataset.walletRoot) return child;
        const found = child.querySelector(selector); if (found) return found;
      }
      return null;
    }
    querySelectorAll() { return []; }
    attachShadow() { return new Element('shadow'); }
    closest(tag) { return this.tag === tag ? this : this.parent?.closest(tag); }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    focus() {}
    getBoundingClientRect() { return { bottom: 52, right: 984 }; }
  }
  const header = new Element('header'), button = new Element('button'); header.append(button); header.querySelector = () => button;
  const buttons = [button, ...Array.from({ length: buttonCount - 1 }, () => new Element('button'))];
  header.querySelectorAll = selector => selector.includes('.wallet-icon') ? buttons : [];
  const document = { currentScript: { src: 'https://wallet.featheral.com/embed.js' }, readyState: 'complete',
    addEventListener() {},
    body: new Element('body'), head: new Element('head'), createElement: tag => new Element(tag),
    getElementById: id => elements.find(element => element.id === id), querySelector: () => header, querySelectorAll: () => [] };
  const walletApp = { async mount(context) {
    const instance = { context, tabs: [], suspended: 0, disposed: 0, resumed: 0 };
    context.receive = data => instance.messages.push(data); instance.messages = []; instances.push(instance);
    return { tab: value => instance.tabs.push(value), resume: async () => { instance.resumed++; },
      suspend: async () => { instance.suspended++; }, dispose: () => { instance.disposed++; } };
  } };
  const window = { innerWidth: width, innerHeight: height,
    localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    ethers: {}, FeatheralVault: {}, FeatheralPortfolio: {}, FeatheralSignIn: {}, FeatheralWalletApp: walletApp,
    addEventListener() {}, open() { assert.fail('Context wallet must never open a wallet-site window'); } };
  let counter = 0;
  vm.runInNewContext(embed, { window, document, location: new URL(hostname.endsWith('localhost') ? `http://${hostname}:8080` : `https://${hostname}`),
    localStorage: window.localStorage, crypto: { getRandomValues: array => array.fill(++counter) }, URL, URLSearchParams, AbortSignal,
    DOMParser: class { parseFromString() { return { body: { innerHTML: '<main></main>' }, querySelectorAll: () => [] }; } },
    getComputedStyle: () => ({ getPropertyValue: name => ({ '--brand': '#123456', '--panel': '#ffffff', '--txt': '#123123' }[name] || ''),
      color: '#123123', backgroundColor: '#ffffff', fontFamily: 'Test Font', colorScheme: 'light' }),
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: !fail, status: 503, text: async () => '', json: async () => ({ profile: null }) };
    },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) });
  return { wallet: window.FeatheralWallet, instances, store, timers, requests, errors, elements, button, buttons,
    dialog: () => document.getElementById('featheral-central-wallet'),
    async emit(data, instance = instances.at(-1)) { instance.context.onMessage(data); await tick(); } };
}
test('all site wallets mount full frame-free UI with local assets, currency, view and exact payment details', async () => {
  for (const hostname of ['featheral.com', 'gold.featheral.com', 'silver.featheral.com', 'world.featheral.com', 'dollar.localhost', 'pay.featheral.com', 'ex.featheral.com', 'x.localhost']) {
    const ui = fixture({ hostname });
    ui.wallet.open({ view: 'swap' }); await tick();
    const params = new URLSearchParams(ui.instances[0].context.search);
    assert.equal(params.get('primary'), primaryFor(hostname));
    assert.equal(params.get('view'), 'swap');
    assert.ok(ui.requests.every(request => String(request.url).startsWith('/')));
    assert.equal(ui.instances[0].context.body.style['--brand'], '#123456');
    assert.equal(ui.instances[0].context.body.style.fontFamily, 'Test Font');
    ui.dialog().close();
  }
  const ui = fixture({ hostname: 'dollar.localhost' });
  ui.wallet.open({ view: 'send', payment: new URLSearchParams({ to: other, amount: '1.000000000000000001', name: 'Shop & cafe', currency: 'FTH$' }).toString() });
  await tick();
  const params = new URLSearchParams(ui.instances[0].context.search);
  assert.equal(params.get('amount'), '1.000000000000000001');
  assert.equal(params.get('parentOrigin'), 'http://dollar.localhost:8080');
  assert.doesNotMatch(embed, /window\.open|location\.(?:href|assign|replace)\s*[=(]|createElement\(["']iframe/);
});
test('pinned address views remain read-only; contextual auth has no cross-window handoff', async () => {
  const ui = fixture();
  ui.wallet.open({ address, followActive: false }); await tick();
  const params = new URLSearchParams(ui.instances[0].context.search);
  assert.equal(params.get('address'), address);
  assert.equal(params.has('authNonce'), false);
  assert.equal(walletUi(params).interactive, false);
  assert.doesNotMatch(embed, /postMessage|walletOrigin/);
});
test('authorization binds instance, nonce and account and returns only approved address/signature', async () => {
  const ui = fixture(), challenges = [];
  const pending = ui.wallet.authenticate(async owner => { challenges.push(owner); return { message: 'standard challenge' }; });
  assert.equal(ui.dialog().open, true);
  await tick();
  const instance = ui.instances[0], nonce = new URLSearchParams(instance.context.search).get('authNonce');
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce: 'ff'.repeat(16), address });
  assert.deepEqual(challenges, []);
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce, address });
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce, address });
  assert.deepEqual(challenges, [address]);
  assert.equal(instance.messages.find(data => data.type === 'featheral:wallet-auth').message, 'standard challenge');
  await ui.emit({ type: 'featheral:wallet-signature', nonce, address, signature, token: 'must-not-return' });
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), ['address', 'signature']);
  assert.equal(result.signature, signature); assert.equal(ui.timers.size, 0);
  assert.equal(ui.dialog().open, false); assert.equal(instance.suspended, 1);
});
test('account selection and repeated header opens reuse the mounted context without new listeners', async () => {
  const ui = fixture(), pending = ui.wallet.account(); await tick();
  const nonce = new URLSearchParams(ui.instances[0].context.search).get('authNonce');
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce, address });
  assert.deepEqual(Object.keys(await pending), ['address']);
  assert.equal(ui.store.get('featheral-wallet-public-account'), address);
  ui.wallet.open({ view: 'account' }); await tick();
  assert.equal(ui.instances.length, 1);
  assert.equal(ui.button.children.at(-1).textContent, '..11111');
  assert.equal(ui.instances[0].resumed, 1);
});
test('wallet popout anchors below the header at the right edge and stays viewport bounded', async () => {
  for (const [width, height] of [[1000, 800], [320, 640], [390, 844], [740, 360]]) {
    const ui = fixture({ width, height });
    ui.wallet.open(); await tick();
    assert.match(ui.dialog().style.cssText, /position:fixed/);
    assert.doesNotMatch(ui.dialog().style.cssText, /margin:auto/);
    assert.equal(ui.dialog().style.top, '60px');
    assert.equal(ui.dialog().style.width, `${Math.min(460, width - 16)}px`);
    assert.equal(ui.dialog().style.maxHeight, `${height - 68}px`);
    assert.ok(parseFloat(ui.dialog().style.right) >= 8);
    assert.equal(ui.button['aria-expanded'], 'true');
    ui.dialog().close();
    assert.equal(ui.button['aria-expanded'], 'false');
  }
});
test('all header controls mirror live popout authorization and clear disconnected accounts', async () => {
  const ui = fixture({ buttonCount: 2, store: new Map([['featheral-wallet-public-account', other]]) });
  assert.equal(ui.button.dataset.walletState, 'selected');
  assert.match(ui.button.title, /approval or unlock required/);
  ui.wallet.open(); await tick();
  const context = ui.instances[0].context;
  context.onConnectionState({ address, state: 'authorized' }); await tick();
  for (const button of ui.buttons) {
    assert.equal(button.dataset.walletState, 'authorized');
    assert.match(button.title, /1111111.*connected/);
    assert.equal(button.children.at(-1).textContent, '..11111');
  }
  context.onConnectionState({ address, state: 'selected' }); await tick();
  assert.match(ui.button.title, /approval or unlock required/);
  context.onConnectionState({ address: null, state: 'disconnected' }); await tick();
  assert.equal(ui.store.has('featheral-wallet-public-account'), false);
  for (const button of ui.buttons) {
    assert.equal(button.dataset.walletState, 'disconnected');
    assert.equal(button.children.at(-1).textContent, 'Wallet');
  }
});
test('load errors, duplicate connections, challenge failure, close and expiry reject explicitly', async () => {
  await assert.rejects(fixture({ fail: true }).wallet.account(), /HTTP 503/);
  const ui = fixture(), pending = ui.wallet.authenticate(async () => { throw new Error('Challenge offline'); });
  const rejected = assert.rejects(pending, /Challenge offline/);
  await assert.rejects(ui.wallet.account(), /existing wallet connection/);
  await tick();
  const nonce = new URLSearchParams(ui.instances[0].context.search).get('authNonce');
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce, address }); await rejected;
  const cancel = ui.wallet.account(), cancelled = assert.rejects(cancel, /cancelled/);
  ui.dialog().close(); await cancelled;
  const expired = ui.wallet.account(), timedOut = assert.rejects(expired, /expired/);
  [...ui.timers][0](); await timedOut;
  assert.equal(ui.store.size, 0);
});
test('closing during a challenge prevents late approvals; changed signatures cannot connect', async () => {
  let release;
  const ui = fixture(), pending = ui.wallet.authenticate(() => new Promise(resolve => { release = resolve; }));
  const rejected = assert.rejects(pending, /cancelled/); await tick();
  const nonce = new URLSearchParams(ui.instances[0].context.search).get('authNonce');
  await ui.emit({ type: 'featheral:wallet-auth-ready', nonce, address });
  ui.dialog().close(); await rejected; release({ message: 'late' }); await tick();
  assert.equal(ui.instances[0].messages.some(data => data.type === 'featheral:wallet-auth'), false);
  for (const response of [{ address: other, signature }, { address, signature: 'invalid' }]) {
    const invalid = fixture(), result = invalid.wallet.authenticate(() => ({ message: 'challenge' }));
    const fail = assert.rejects(result, /Invalid wallet sign-in response/); await tick();
    const value = new URLSearchParams(invalid.instances[0].context.search).get('authNonce');
    await invalid.emit({ type: 'featheral:wallet-auth-ready', nonce: value, address });
    await invalid.emit({ type: 'featheral:wallet-signature', nonce: value, ...response }); await fail;
  }
});
function providerFixture(ethereum) {
  const nodes = new Map(), listeners = {};
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { children: [], replaceChildren(...children) { this.children = children; this.firstChild = children[0]; }, append(child) { this.children.push(child); } });
    return nodes.get(id);
  };
  const window = { ethereum };
  const context = vm.createContext({ $, el: (_, textContent) => ({ textContent }), window,
    listen: (_target, name, fn) => { listeners[name] = fn; }, config: { mode: 'auto' }, interactive: true, bindProvider() {} });
  vm.runInContext(app.slice(app.indexOf('  let browserProvider,'), app.indexOf('  const defaultStandaloneTheme')), context);
  context.updateProviders();
  return { context, nodes, listeners, provider: () => vm.runInContext('browserProvider', context) };
}
test('extension discovery prefers a single provider and explicitly selects among multiple extensions', () => {
  const one = { request() {}, isMetaMask: true }, two = { request() {} };
  assert.equal(providerFixture(one).provider(), one);
  const empty = providerFixture();
  assert.equal(empty.nodes.get('extension-connect').disabled, true);
  empty.listeners['eip6963:announceProvider']({ detail: { provider: one, info: { name: 'One' } } });
  assert.equal(empty.provider(), one);
  empty.listeners['eip6963:announceProvider']({ detail: { provider: two, info: { name: 'Two' } } });
  assert.equal(empty.provider(), null);
  assert.equal(providerFixture({ providers: [one, two] }).provider(), null);
});
test('no extension defaults to builtin create/unlock and extension rejection never creates a wallet', async () => {
  for (const record of [null, { address }]) for (const builtInPreferred of [false, true]) {
    const nodes = new Map(), calls = [];
    const context = vm.createContext({ token: '', interactive: true, builtInPreferred,
      providerChoices: () => builtInPreferred ? [{ provider: {} }] : [], browserProvider: builtInPreferred ? {} : null,
      vault: { read: () => record }, tab: view => calls.push(view), updateVault() {},
      $: id => { if (!nodes.has(id)) nodes.set(id, { focus: () => calls.push('focus') }); return nodes.get(id); } });
    vm.runInContext(app.slice(app.indexOf('  async function ensureSession()'), app.indexOf('  $("connect").addEventListener')), context);
    assert.equal(await context.ensureSession(), false);
    assert.equal(nodes.get('vault-action').value, record ? 'unlock' : 'create');
  }
  const context = vm.createContext({ token: '', interactive: true, builtInPreferred: false, providerChoices: () => [{}],
    vault: {}, providerChosen: false, epoch: 0, contextEpoch: 0, requireVisible() {},
    browserProvider: { request: async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); } } });
  vm.runInContext(app.slice(app.indexOf('  async function ensureSession()'), app.indexOf('  $("connect").addEventListener')), context);
  await assert.rejects(context.ensureSession(), { message: 'Rejected', code: 4001 });
});
test('extension signing rejects changed accounts, providers and closed contexts', async () => {
  for (const change of ['account', 'provider', 'context']) {
    let scope, signed = false;
    const provider = { async request(request) {
      if (request.method === 'personal_sign') {
        signed = true;
        if (change === 'provider') vm.runInContext('browserProvider = {}', scope);
        if (change === 'context') vm.runInContext('contextEpoch++', scope);
        return signature;
      }
      return [signed && change === 'account' ? other : address];
    } };
    scope = vm.createContext({ builtInActive: false, owner: address, browserProvider: provider, TextEncoder,
      requireVisible() {}, contextEpoch: 0 });
    vm.runInContext(app.slice(app.indexOf('  async function sign('), app.indexOf('  function lock(')), scope);
    await assert.rejects(scope.sign('challenge'), /Wallet changed while signing/);
  }
});
test('context sessions are separate from application sessions and frames remain rejected', () => {
  assert.match(app, /featheral-context-wallet-token/);
  assert.match(app, /window\.parent !== window\) throw new Error/);
  assert.match(app, /siteApproval !== approval/);
  assert.match(app, /context\.dispose/);
  assert.throws(() => walletUi(new URLSearchParams({ embedded: '1' })), /Unsupported/);
});
test('same-origin wallet route guards work on every site without opening creation or hosted-site privileges', async t => {
  const express = require('express'), http = require('node:http'), { once } = require('node:events');
  const source = fs.readFileSync(path.join(root, 'services/cms/server.js'), 'utf8');
  const router = express.Router(), serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => { req.hostedSite = req.get('x-fixture-hosted') === '1'; next(); });
  const scope = vm.createContext({ creationRouter: router, creation: {}, creationLimits: new Map(), Date,
    hostName: req => req.hostname.replace(/\.localhost$/, '.featheral.com'),
    require: () => require('../../wallet/ui') });
  const start = source.indexOf('function contextualWalletHost('), end = source.indexOf("creationRouter.get('/economy/reference", start);
  vm.runInContext(source.slice(start, end), scope);
  const swaps = source.indexOf("creationRouter.use('/wallet/swaps'");
  vm.runInContext(source.slice(swaps, source.indexOf("creationRouter.post('/wallet/swaps/quote'", swaps)), scope);
  router.all(['/wallet/swaps/quote', '/challenge', '/owned'], (_req, res) => res.json({ ok: true }));
  serverApp.use('/api/creation', router);
  const server = http.createServer(serverApp); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (host, route = '/wallet/swaps/quote', extra = {}) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/creation' + route, method: 'POST',
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', ...extra } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end('{}');
  });
  for (const host of ['featheral.com', 'gold.featheral.com', 'world.featheral.com', 'pay.featheral.com', 'x.featheral.com',
    'app.localhost', 'silver.localhost', 'media.localhost', 'stats.localhost', 'localhost'])
    assert.equal(await call(host), 200, host);
  assert.equal(await call('app.localhost', '/challenge'), 200);
  assert.equal(await call('app.localhost', '/owned'), 404);
  assert.equal(await call('untrusted.invalid'), 404);
  assert.equal(await call('app.localhost', '/wallet/swaps/quote', { Origin: 'https://untrusted.invalid' }), 403);
  assert.equal(await call('app.localhost', '/wallet/swaps/quote', { 'x-fixture-hosted': '1' }), 404);
});
test('gateway serves local wallet modules and configuration/summaries without redirects on family hosts', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  const start = source.indexOf('    if (url.pathname.startsWith("/shared/wallet/"))');
  const firstCreation = source.indexOf('    if (url.pathname.startsWith("/api/creation/")) return cms', start);
  const summaryStart = source.indexOf('    if (site === "wallet" ||', firstCreation);
  const summaryEnd = source.indexOf('      if (url.pathname.startsWith("/api/creation/")) return cms', summaryStart);
  const handler = source.slice(start, firstCreation) + source.slice(summaryStart, summaryEnd) + '\n}';
  for (const site of ['foundation', 'gold', 'world', 'x', 'pay']) {
    for (const pathname of ['/shared/wallet/wallet-app.js', '/api/wallet/ui?parentOrigin=http%3A%2F%2Fnotes.localhost%3A8080', `/api/wallet/accounts/${address}`]) {
      let status, result;
      await vm.runInNewContext(`(async () => {${handler}})()`, {
        site, root, fs, path, walletRoot: path.join(root, 'sites/wallet.featheral.com'),
        url: new URL(pathname, 'http://notes.localhost:8080'), req: { method: 'GET', headers: {} },
        types: { '.js': 'text/javascript', '.json': 'application/json' }, require: () => require('../../wallet/ui'),
        cms: { walletSummary: async account => ({ address: account }) },
        res: { setHeader() {}, writeHead(code) { status = code; }, end(value) { result = value; } },
      });
      test('World sync shares only a public account with a validated contextual origin and never redirects that context', async () => {
        const source = fs.readFileSync(path.join(root, 'sites/world.featheral.com/wallet-sync.js'), 'utf8');
        for (const valid of [true, false]) {
          const messages = [], nodes = new Map(), nonce = 'ab'.repeat(16), accountId = '0x' + 'cd'.repeat(32);
          const location = new URL(`http://world.localhost:8080/wallet-sync.html?returnOrigin=${encodeURIComponent(valid ? 'http://notes.localhost:8080' : 'https://untrusted.invalid')}&syncNonce=${nonce}`);
          location.replace = () => assert.fail('Contextual sync must not redirect to a wallet site');
          vm.runInNewContext(source, { location, URL, URLSearchParams,
            document: { referrer: 'http://notes.localhost:8080/', getElementById: id => {
              if (!nodes.has(id)) nodes.set(id, { removeAttribute() {} }); return nodes.get(id);
            } },
            window: { opener: { postMessage: (data, origin) => messages.push({ data, origin }) } },
            fetch: async () => ({ ok: true, json: async () => ({ accountId, secret: 'never-return' }) }), console });
          await tick();
          if (valid) {
            assert.deepEqual(Object.keys(messages[0].data).sort(), ['accountId', 'nonce', 'type']);
            assert.equal(messages[0].origin, 'http://notes.localhost:8080');
          } else { assert.equal(messages.length, 0); assert.match(nodes.get('sync-status').textContent, /invalid/); }
        }
      });
      assert.equal(status, 200, `${site} ${pathname}`);
      if (pathname.includes('/ui?')) assert.equal(JSON.parse(result).schema, 'featheral.wallet');
      if (pathname.includes('/accounts/')) assert.equal(JSON.parse(result).address, address);
    }
  }
});
