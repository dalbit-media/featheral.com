const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { walletUi, primaryFor } = require('../../wallet/ui');
const root = path.resolve(__dirname, '../../..');
const embed = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/embed.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/wallet-app.js'), 'utf8');
const address = '0x' + '11'.repeat(20), other = '0x' + '22'.repeat(20), signature = '0x' + 'ab'.repeat(65);
const walletOrigin = 'https://wallet.featheral.com';
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
      assert.throws(() => validate(address, challenge.message, false, origin), /standard/);
    }
  } finally { notes.close(); }
});
function fixture({ hostname = 'notes.featheral.com', blocked = false, store = new Map(), avatar, summary, failSummary = false } = {}) {
  const elements = [], listeners = new Map(), messages = [], popups = [], timers = new Set(), requests = [], errors = [];
  let elapsed = 0;
  class Element {
    constructor(tag) {
      assert.notEqual(tag, 'iframe', 'no wallet operation may create an iframe');
      this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.listeners = {};
      this.isConnected = true; this.classList = { add() {} }; elements.push(this);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    hasAttribute() { return false; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector === child.tag || selector === '[data-wallet-root]' && child.dataset.walletRoot) return child;
        const found = child.querySelector(selector); if (found) return found;
      }
      return null;
    }
    querySelectorAll() { return []; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const header = new Element('header'), button = new Element('button');
  header.append(button); header.querySelector = () => button;
  const document = { currentScript: { src: walletOrigin + '/embed.js' }, readyState: 'complete',
    body: new Element('body'), createElement: tag => new Element(tag),
    getElementById: id => elements.find(element => element.id === id), querySelector: () => header, querySelectorAll: () => [] };
  const window = { localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) },
    crypto: { getRandomValues: array => array.fill(popups.length + 1) },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    open(href) {
      if (blocked) return null;
      const popup = { href, closed: false, postMessage: (data, origin) => messages.push({ data, origin }), close() { this.closed = true; } };
      popups.push(popup); return popup;
    } };
  const location = new URL(hostname.endsWith('localhost') ? `http://${hostname}:8080` : `https://${hostname}`);
  vm.runInNewContext(embed, { window, document, location, URL, URLSearchParams,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (String(url).includes('/profiles/')) return { ok: true, json: async () => ({ profile: { avatar } }) };
      return { ok: !failSummary, status: 503, json: async () => summary || { address, portfolio: { usd: '12.34', partial: false } } };
    },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    Date: class extends Date { static now() { return Date.now() + elapsed; } } });
  return { wallet: window.FeatheralWallet, elements, button, store, messages, popups, timers, requests, errors,
    dialog: () => document.getElementById('featheral-central-wallet'), advanceTime: ms => { elapsed += ms; },
    async emit(name, event) { for (const fn of [...listeners.get(name) || []]) await fn(event); },
    async receive(popup, data, origin = walletOrigin) { await this.emit('message', { source: popup, origin, data }); } };
}
function nonce(popup, key = 'authNonce') { return new URL(popup.href).searchParams.get(key); }
async function ready(ui, popup, account = address) {
  await ui.receive(popup, { type: 'featheral:wallet-ready' });
  await ui.receive(popup, { type: 'featheral:wallet-auth-ready', nonce: nonce(popup), address: account });
}
test('all site previews are frame-free and retain primary, view, origin and payment precision', () => {
  for (const hostname of ['featheral.com', 'gold.featheral.com', 'silver.featheral.com', 'world.featheral.com', 'dollar.localhost', 'pay.featheral.com', 'ex.featheral.com']) {
    const ui = fixture({ hostname });
    ui.wallet.open({ view: 'swap' });
    const url = new URL(ui.dialog().querySelector('a').href);
    assert.equal(url.searchParams.get('primary'), primaryFor(hostname));
    assert.equal(url.searchParams.get('view'), 'swap');
    assert.equal(url.searchParams.has('embedded'), false);
    assert.equal(ui.popups.length, 0);
    assert.equal(ui.dialog().querySelector('a').rel, 'noopener');
  }
  const ui = fixture({ hostname: 'dollar.localhost' });
  const payment = new URLSearchParams({ to: other, amount: '1.000000000000000001', name: 'Shop & cafe', currency: 'FTH$' });
  ui.wallet.open({ payment: payment.toString(), view: 'send' });
  const url = new URL(ui.dialog().querySelector('a').href);
  for (const [key, value] of payment) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.get('parentOrigin'), 'http://dollar.localhost:8080');
  ui.wallet.open({ view: 'send' });
  assert.equal(new URL(ui.dialog().querySelector('a').href).searchParams.has('to'), false);
});
test('pinned previews never authorize and public reads omit credentials with explicit unavailable states', async () => {
  const ui = fixture();
  const root = ui.elements.find(element => element.tag === 'body');
  ui.wallet.mount(root, { address });
  await new Promise(setImmediate);
  assert.equal(ui.requests.at(-1).options.credentials, 'omit');
  assert.equal(root.children[1].textContent, 'Estimated total: $12.34 USD');
  assert.equal(new URL(root.querySelector('a').href).searchParams.get('address'), address);
  assert.equal(ui.popups.length, 0);
  const failed = fixture({ failSummary: true });
  failed.wallet.open({ address, followActive: false });
  await new Promise(setImmediate);
  assert.match(failed.dialog().querySelector('[data-wallet-root]').children[3].textContent, /HTTP 503/);
  const mismatch = fixture({ summary: { address: other } });
  mismatch.wallet.open({ address, followActive: false }); await new Promise(setImmediate);
  assert.match(mismatch.dialog().querySelector('[data-wallet-root]').children[3].textContent, /mismatch/);
});
test('authorization opens synchronously and binds popup, origin, nonce and signing account', async () => {
  const ui = fixture(), challenges = [];
  const pending = ui.wallet.authenticate(async owner => { challenges.push(owner); return { message: 'standard challenge' }; });
  assert.equal(ui.popups.length, 1);
  const popup = ui.popups[0], value = nonce(popup);
  const data = { type: 'featheral:wallet-auth-ready', nonce: value, address };
  await ui.receive(popup, data, 'https://evil.example');
  await ui.receive({}, data);
  await ui.receive(popup, { ...data, nonce: 'ff'.repeat(16) });
  assert.deepEqual(challenges, []);
  await ready(ui, popup);
  await ui.receive(popup, data);
  assert.deepEqual(challenges, [address]);
  assert.equal(ui.messages.find(message => message.data.type === 'featheral:wallet-auth').data.message, 'standard challenge');
  await ui.receive(popup, { type: 'featheral:wallet-signature', nonce: value, address, signature, token: 'must-not-return' });
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), ['address', 'signature']);
  assert.equal(result.signature, signature);
  assert.equal(ui.timers.size, 0); assert.equal(popup.closed, true);
  assert.deepEqual([...ui.store.keys()], ['featheral-wallet-public-account']);
});
test('account selection needs no site signature and restores safe header identity after reload', async () => {
  const ui = fixture({ avatar: 'data:image/png;base64,YXZhdGFy' });
  const pending = ui.wallet.account(), popup = ui.popups[0];
  await ready(ui, popup);
  assert.deepEqual(Object.keys(await pending), ['address']);
  assert.equal(ui.messages.some(message => message.data.type === 'featheral:wallet-auth'), false);
  await new Promise(setImmediate);
  assert.equal(ui.button.children.at(-1).textContent, '..11111');
  assert.equal(ui.button.children[1].children[0].src, 'data:image/png;base64,YXZhdGFy');
  const reloaded = fixture({ store: ui.store, avatar: 'https://evil.example/avatar.png' });
  await new Promise(setImmediate);
  assert.match(reloaded.button.title, /Avatar unavailable/);
  assert.equal(reloaded.button.children.at(-1).textContent, '..11111');
});
test('popup blocks, duplicate connections, challenge failures, closure and cancellation reject explicitly', async () => {
  await assert.rejects(fixture({ blocked: true }).wallet.account(), /popup blocked/);
  const ui = fixture(), pending = ui.wallet.authenticate(async () => { throw new Error('Challenge offline'); });
  const rejected = assert.rejects(pending, /Challenge offline/);
  await assert.rejects(ui.wallet.account(), /existing wallet connection/);
  await ready(ui, ui.popups[0]); await rejected;
  assert.equal(ui.timers.size, 0);
  const cancelled = ui.wallet.account(), cancelResult = assert.rejects(cancelled, /cancelled/);
  ui.popups.at(-1).closed = true; [...ui.timers][0](); await cancelResult;
  const explicit = ui.wallet.account(), explicitResult = assert.rejects(explicit, /User cancelled/);
  await ui.receive(ui.popups.at(-1), { type: 'featheral:wallet-signature', nonce: nonce(ui.popups.at(-1)), error: 'User cancelled' });
  await explicitResult;
  assert.equal(ui.store.size, 0); assert.equal(ui.timers.size, 0);
});
test('signatures with changed accounts or invalid output never connect', async () => {
  for (const response of [{ address: other, signature }, { address, signature: 'invalid' }]) {
    const ui = fixture(), pending = ui.wallet.authenticate(async () => ({ message: 'challenge' }));
    const rejected = assert.rejects(pending, /Invalid wallet sign-in response/);
    const popup = ui.popups[0]; await ready(ui, popup);
    await ui.receive(popup, { type: 'featheral:wallet-signature', nonce: nonce(popup), ...response });
    await rejected; assert.equal(ui.store.size, 0);
  }
});
test('authorization expires after ten minutes and never continues a cancelled asynchronous challenge', async () => {
  const expired = fixture(), pending = expired.wallet.account();
  const rejected = assert.rejects(pending, /expired/);
  expired.advanceTime(600001); [...expired.timers][0](); await rejected;
  assert.equal(expired.timers.size, 0);
  let release;
  const ui = fixture(), result = ui.wallet.authenticate(() => new Promise(resolve => { release = resolve; }));
  const cancelled = assert.rejects(result, /cancelled/), popup = ui.popups[0];
  const receiving = ready(ui, popup);
  await new Promise(setImmediate);
  popup.closed = true; [...ui.timers][0](); await cancelled;
  release({ message: 'late challenge' }); await receiving;
  assert.equal(ui.messages.some(message => message.data.type === 'featheral:wallet-auth'), false);
});
test('wallet management shares only nonce-bound public selection while keeping its window open', async () => {
  const ui = fixture();
  ui.wallet.open();
  ui.dialog().children[3].listeners.click();
  const popup = ui.popups[0], data = { type: 'featheral:wallet-selected', nonce: nonce(popup, 'selectionNonce'), address };
  await ui.receive(popup, data, 'https://evil.example');
  await ui.receive({}, data);
  assert.equal(ui.store.size, 0);
  await ui.receive(popup, data);
  assert.equal(ui.store.get('featheral-wallet-public-account'), address);
  assert.equal(popup.closed, false);
  const pinned = fixture();
  pinned.wallet.open({ address, followActive: false });
  pinned.dialog().children[3].listeners.click();
  const pinnedPopup = pinned.popups[0];
  assert.equal(new URL(pinnedPopup.href).searchParams.has('selectionNonce'), false);
  assert.equal(pinnedPopup.opener, null);
  await pinned.receive(pinnedPopup, { ...data, address: other });
  assert.equal(pinned.store.size, 0);
});
test('wallet approval configuration rejects framed, pinned, malformed and untrusted handoffs', () => {
  for (const params of [
    { authNonce: 'bad', parentOrigin: 'https://notes.featheral.com' },
    { authNonce: 'ab'.repeat(16) },
    { authNonce: 'ab'.repeat(16), parentOrigin: 'https://evil.example' },
    { authNonce: 'ab'.repeat(16), parentOrigin: 'https://notes.featheral.com', embedded: '1' },
    { authNonce: 'ab'.repeat(16), parentOrigin: 'https://notes.featheral.com', address },
    { mode: 'unknown' },
  ]) assert.throws(() => walletUi(new URLSearchParams(params)), /Unsupported/);
  const config = walletUi(new URLSearchParams({ authNonce: 'ab'.repeat(16), parentOrigin: 'https://notes.featheral.com', mode: 'builtin' }));
  assert.equal(config.authNonce, 'ab'.repeat(16)); assert.equal(config.mode, 'builtin'); assert.equal(config.interactive, true);
  assert.match(app, /window\.parent !== window\) throw new Error/);
  assert.doesNotMatch(app, /providerProxy|requestStorageAccess|wallet-provider-result/);
  const server = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  assert.match(server, /res\.setHeader\("Content-Security-Policy", "frame-ancestors 'none'"\)/);
});
function providerFixture(ethereum) {
  const nodes = new Map(), listeners = {}, bound = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { children: [], replaceChildren(...children) { this.children = children; this.firstChild = children[0]; }, append(child) { this.children.push(child); } });
    return nodes.get(id);
  };
  const window = { ethereum, addEventListener: (name, fn) => { listeners[name] = fn; }, dispatchEvent() {} };
  const context = vm.createContext({ $, el: (_, textContent) => ({ textContent }), window, Event: class {},
    config: { mode: 'auto' }, interactive: true, bindProvider: provider => bound.push(provider) });
  vm.runInContext(app.slice(app.indexOf('  let browserProvider,'), app.indexOf('  const defaultStandaloneTheme')), context);
  context.updateProviders();
  return { context, nodes, listeners, provider: () => vm.runInContext('browserProvider', context) };
}
test('extension discovery defaults to one provider but requires explicit choice with multiple extensions', () => {
  const one = { request() {}, isMetaMask: true }, two = { request() {} };
  const legacy = providerFixture(one);
  assert.equal(legacy.provider(), one);
  assert.equal(legacy.nodes.get('extension-connect').textContent, 'Connect MetaMask');
  const empty = providerFixture();
  assert.equal(empty.nodes.get('extension-connect').disabled, true);
  assert.match(empty.nodes.get('connection-help').textContent, /No extension detected/);
  empty.listeners['eip6963:announceProvider']({ detail: { provider: one, info: { name: 'One' } } });
  assert.equal(empty.provider(), one);
  empty.listeners['eip6963:announceProvider']({ detail: { provider: two, info: { name: 'Two' } } });
  assert.equal(empty.provider(), null, 'multiple discovered extensions require explicit selection');
  assert.equal(empty.nodes.get('extension-provider').hidden, false);
  const multiple = providerFixture({ providers: [one, two] });
  assert.equal(multiple.provider(), null);
});
test('no extension defaults to builtin create/unlock; choosing builtin overrides an installed extension', async () => {
  for (const record of [null, { address }]) for (const builtInPreferred of [false, true]) {
    const nodes = new Map(), calls = [];
    const context = vm.createContext({ token: '', interactive: true, builtInPreferred,
      providerChoices: () => builtInPreferred ? [{ provider: {} }] : [], browserProvider: builtInPreferred ? {} : null,
      vault: { read: () => record }, tab: view => calls.push(view), updateVault() {},
      $: id => { if (!nodes.has(id)) nodes.set(id, { focus: () => calls.push('focus') }); return nodes.get(id); } });
    vm.runInContext(app.slice(app.indexOf('  async function ensureSession()'), app.indexOf('  $("connect").addEventListener')), context);
    assert.equal(await context.ensureSession(), false);
    assert.equal(nodes.get('vault-action').value, record ? 'unlock' : 'create');
    assert.equal(nodes.get('local-wallet').open, true);
    assert.deepEqual(calls, ['account', 'focus']);
  }
});
test('extension rejection is not replaced with builtin wallet creation', async () => {
  const context = vm.createContext({ token: '', interactive: true, builtInPreferred: false,
    providerChoices: () => [{}], vault: {}, providerChosen: false, browserProvider: { request: async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); } } });
  vm.runInContext(app.slice(app.indexOf('  async function ensureSession()'), app.indexOf('  $("connect").addEventListener')), context);
  await assert.rejects(context.ensureSession(), { message: 'Rejected', code: 4001 });
});
test('switching after a failed builtin login signs with the selected extension, not the unlocked local key', async () => {
  const context = vm.createContext({ token: '', interactive: true, builtInPreferred: false, builtInActive: true,
    owner: '', returnedAddress: '', providerChosen: false, providerChoices: () => [{}], vault: {},
    browserProvider: { request: async () => [address] },
    api: async route => route === '/challenge' ? { message: 'challenge' } : { token: 'extension-session' },
    sign: async () => { assert.equal(vm.runInContext('builtInActive', context), false); return signature; },
    storage: { setItem() {} }, ACTIVE_ACCOUNT: 'active' });
  vm.runInContext(app.slice(app.indexOf('  async function ensureSession()'), app.indexOf('  $("connect").addEventListener')), context);
  assert.equal(await context.ensureSession(), true);
  assert.equal(context.token, 'extension-session');
});
test('extension signing rejects account and provider changes during approval', async () => {
  for (const changeProvider of [false, true]) {
    let context, signed = false;
    const provider = { async request(request) {
      if (request.method === 'personal_sign') {
        signed = true;
        if (changeProvider) vm.runInContext('browserProvider = {}', context);
        return signature;
      }
      return [signed ? other : address];
    } };
    context = vm.createContext({ builtInActive: false, owner: address, browserProvider: provider, TextEncoder });
    vm.runInContext(app.slice(app.indexOf('  async function sign('), app.indexOf('  function lock(')), context);
    await assert.rejects(context.sign('challenge'), /Wallet changed while signing/);
  }
});
