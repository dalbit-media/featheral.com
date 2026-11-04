const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/wallet-app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/wallet-app.html'), 'utf8');
class Element {
  constructor(id = '') { this.id = id; this.value = ''; this.children = []; this.listeners = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.dataset = {}; this.textContent = ''; }
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  after() {}
  focus() { this.focused = true; }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  async fire(name, event = {}) { await this.listeners[name]?.({ preventDefault() {}, ...event }); }
  click() { return this.fire('click'); }
}
async function fixture(host, { embedded = false, storageBlocked = false, walletData = {}, publicAddress = null, markets = [], noProvider = false, vaultApi,
  activeAddress = null, followActive = false, worldAccount = null, noSession = embedded, view = 'assets', marketError = false,
  selectionNonce = null, popupBlocked = false, marketDelay = false, manualReview = false, parentProvider, storageAccess,
  readySelection = null, sessionExpired = false } = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  nodes['wallet-review'].showModal = () => {
    nodes['wallet-review'].open = true;
    if (!manualReview) queueMicrotask(() => nodes['wallet-review-confirm'].fire('click'));
  };
  nodes['wallet-review'].close = () => { nodes['wallet-review'].open = false; };
  const panels = ['assets', 'send', 'receive', 'swap', 'activity', 'account'].map(id => nodes[id]);
  const tabs = ['assets', 'send', 'receive', 'swap', 'activity', 'account'].map(id => {
    const node = nodes['tab-' + id]; node.dataset.tab = id; node.role = 'tab'; return node;
  });
  const shortcuts = [new Element()];
  shortcuts[0].dataset.tab = 'activity';
  nodes['send-symbol'].value = 'FTH$';
  nodes['swap-from'].value = 'FTHX'; nodes['swap-to'].value = 'FTH$';
  const address = '0x1111111111111111111111111111111111111111', calls = [], errors = [], requests = new Map(), tips = new Map();
  let funded = true, rejectSignature = false, tipReceiptLost = false, swapReceiptLost = false, completes = 0, elapsed = 0;
  const pendingMarkets = [];
  const documentListeners = {}, windowListeners = {}, intervals = [], popups = [], messages = [];
  const store = new Map([['featheral-creation-token', 'test-token']]);
  if (noSession) store.delete('featheral-creation-token');
  if (activeAddress) store.set('featheral-wallet-active-account', activeAddress);
  if (worldAccount) { store.set('featheral-world-account', worldAccount); store.delete('featheral-creation-token'); }
  const storage = { getItem: key => { if (storageBlocked) throw new Error('Storage denied'); return store.get(key) || null; }, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const reply = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body, headers: options.headers });
    if (url.startsWith('/api/wallet/ui')) return reply(require('../../wallet/ui').walletUi(new URLSearchParams({ primary: require('../../wallet/ui').primaryFor(`${host}.localhost`),
      view, ...(embedded ? { embedded: '1', parentOrigin: 'http://notes.localhost:8080' } : {}),
      ...(selectionNonce ? { selectionNonce, parentOrigin: 'http://gold.localhost:8080' } : {}),
      ...(publicAddress ? { address: publicAddress } : {}), followActive: followActive ? '1' : '0' })));
    if (url.startsWith('/api/v1/notes/fth/accounts/')) return reply({ fthDollar: { available: '1000000000000000000' }, wallet: null });
    if (url.includes('/wallet/portfolio/')) return reply({ totals: {
      FTHX: { value: '100000000000000000000', unpriced: [] }, 'FTH$': { value: '1000000000000000000', unpriced: [] } },
      pricedFthDollar: '1000000000000000000', usd: null, fthg: null, unpriced: [], source: 'Opening' });
    if (url.endsWith('/markets')) {
      if (marketError) throw new Error('Market server offline');
      if (marketDelay) return new Promise(resolve => pendingMarkets.push(() => resolve(reply({ markets }))));
      return reply({ markets });
    }
    if (url.endsWith('/dollar-pool')) return reply({ funded, settlementEnabled: true, dollars: '1000000000000000000000', fthx: 10000 });
    if (url.endsWith('/dollar-pool/market')) return reply({ volumeFthDollar: '1000000000000000000', volumeFthx: '10', trades: 1 });
    if (url.endsWith('/challenge')) return reply({ message: 'mock login challenge' });
    if (url.endsWith('/login')) return reply({ token: 'test-token' });
    if (url.endsWith('/logout')) return reply({ ok: true });
    if (url.endsWith('/wallet/send/prepare')) return reply({ message: 'exact native transfer', payment: { to: body.to, amount: body.amount, nonce: 'native-nonce' } });
    if (url === '/api/v1/notes/fth/transfers') return reply({ ok: true });
    if (sessionExpired && url.endsWith('/wallet')) return { ...reply({ error: 'Session expired' }), ok: false, status: 401 };
    if (url.endsWith('/wallet') || url.startsWith('/api/wallet/accounts/')) return reply({ address: url.startsWith('/api/wallet/accounts/') ? url.split('/').pop().split('?')[0] : publicAddress || address, holdings: [{ symbol: 'FTHX', balance: 123 }],
      dollar: { balance: { available: '10000000000000000000' }, transactions: [] }, markets: { trades: [] }, exchange: { trades: [], requests: [] }, noteTransfers: [], ...walletData });
    if (url.endsWith('/wallet/notes/send')) {
      tips.set(body.requestId, body);
      if (tipReceiptLost) { tipReceiptLost = false; throw new Error('lost tip receipt'); }
      return reply(body);
    }
    if (url.endsWith('/wallet/swaps/quote')) return reply({ ...body, output: body.to === 'FTH$' ? '1000000000000000000' : '9', route: [body.from, body.to], hops: 1 });
    if (url.endsWith('/wallet/swaps/prepare')) {
      if (!requests.has(body.requestId)) requests.set(body.requestId, { id: body.requestId, requestId: body.requestId, parameters: body,
        ...body, output: body.minOutput, route: [body.from, body.to], status: 'prepared', ...(body.from === 'FTH$' ? { payment: {}, message: 'exact mock transfer' } : {}) });
      return reply(requests.get(body.requestId));
    }
    if (url.endsWith('/refresh')) return reply(requests.get(url.split('/').at(-2)));
    if (url.endsWith('/complete')) {
      const request = requests.get(url.split('/').at(-2));
      if (request.status !== 'complete') { completes++; request.status = 'complete'; }
      if (swapReceiptLost) { swapReceiptLost = false; throw new Error('lost swap receipt'); }
      if (request.parameters.dollars) funded = true;
      return reply(request);
    }
    throw new Error(`Unexpected mocked API: ${url}`);
  };
  const document = { referrer: 'http://notes.localhost:8080/', body: new Element(), getElementById: id => nodes[id], createElement: () => new Element(),
    addEventListener(name, callback) { (documentListeners[name] ||= []).push(callback); },
    querySelectorAll: selector => selector === '.wallet-panel' ? panels : selector === '[data-tab]' ? [...tabs, ...shortcuts]
      : selector === '[role="tab"]' ? tabs : selector === 'form' ? ['send-form', 'swap-form', 'vault-form'].map(id => nodes[id]) : Object.values(nodes) };
  const clipboard = [];
  const context = { document, navigator: { clipboard: { writeText: async text => clipboard.push(text) } }, location: new URL(`http://${host}.localhost:8080/wallet/#${view === 'assets' ? 'swap' : view}`), localStorage: storage, sessionStorage: storage,
    URL, URLSearchParams, TextEncoder, crypto, fetch, Date: class extends Date { static now() { return Date.now() + elapsed; } },
    setInterval(callback, delay) { intervals.push({ callback, delay }); }, setTimeout, clearTimeout, btoa: value => Buffer.from(value).toString('base64'),
    console: { error: error => errors.push(error.message) }, history: { replaceState() {} },
    window: { parent: { postMessage(data, origin) {
      messages.push({ data, origin });
      if (embedded && !noProvider && data.type === 'featheral:wallet-ready') queueMicrotask(() => {
        for (const listener of windowListeners.message || []) listener({ origin: 'http://notes.localhost:8080', source: context.window.parent,
          data: { type: 'featheral:wallet-provider-status', available: true } });
      });
      if (readySelection && data.type === 'featheral:wallet-ready') queueMicrotask(() => {
        for (const listener of windowListeners.message || []) listener({ origin: 'http://notes.localhost:8080', source: context.window.parent,
          data: { type: 'featheral:wallet-selection', address: readySelection } });
      });
      if ((parentProvider || !noProvider) && data.type === 'featheral:wallet-provider') {
        Promise.resolve().then(() => parentProvider ? parentProvider(data.request) : context.window.ethereum.request(data.request)).then(result => {
          for (const listener of windowListeners.message || []) listener({ origin: 'http://notes.localhost:8080', source: context.window.parent,
            data: { type: 'featheral:wallet-provider-result', id: data.id, result } });
        }, error => {
          for (const listener of windowListeners.message || []) listener({ origin: 'http://notes.localhost:8080', source: context.window.parent,
            data: { type: 'featheral:wallet-provider-result', id: data.id, error: error.message } });
        });
      }
    } },
      opener: { postMessage: (data, origin) => messages.push({ data, origin }) },
      open(href) { if (popupBlocked) return null; const popup = { href }; popups.push(popup); return popup; },
      addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); }, ethereum: { on() {}, async request({ method }) {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'personal_sign') { if (rejectSignature) { rejectSignature = false; throw new Error('signature rejected'); } return 'mock-signature'; }
      throw new Error(`Unexpected provider method: ${method}`);
    } } } };
  if (!embedded) context.window.parent = context.window;
  if (noProvider) delete context.window.ethereum;
  let reloads = 0;
  context.location.reload = () => { reloads++; };
  if (storageAccess) document.requestStorageAccess = storageAccess;
  context.window.FeatheralPortfolio = require('../../../sites/wallet.featheral.com/portfolio-view');
  context.window.FeatheralSignIn = require('../../../sites/wallet.featheral.com/site-sign-in');
  if (vaultApi) {
    context.window.FeatheralVault = vaultApi;
  }
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, calls, document, errors, tips, store, intervals, popups, messages, clipboard, setFunded: value => { funded = value; },
    reloads: () => reloads,
    message: async (data, { origin = 'http://notes.localhost:8080', source = context.window.parent } = {}) => {
      for (const listener of windowListeners.message || []) listener({ origin, source, data });
      await new Promise(resolve => setImmediate(resolve));
    },
    recoverMarkets: async () => {
      marketError = false; marketDelay = false;
      for (const resolve of pendingMarkets.splice(0)) resolve();
      await new Promise(resolve => setImmediate(resolve));
    },
    selectAccount: async (address, { origin = context.location.origin, source = popups.at(-1),
      nonce = source?.href ? new URL(source.href).searchParams.get('selectionNonce') : null, fromParent = false } = {}) => {
      for (const listener of windowListeners.message || []) listener({ origin,
        source: fromParent ? context.window.parent : source,
        data: { type: fromParent ? 'featheral:wallet-selection' : 'featheral:wallet-selected', address, nonce } });
      await new Promise(resolve => setImmediate(resolve));
    },
    notifyUpdate: async ({ origin = 'http://notes.localhost:8080', source = context.window.parent } = {}) => {
      for (const listener of windowListeners.message || []) listener({ origin, source, data: { type: 'featheral:wallet-updated' } });
      await new Promise(resolve => setImmediate(resolve));
    },
    advanceTime: ms => { elapsed += ms; }, interact: () => { for (const listener of documentListeners.pointerdown || []) listener(); },
    storageChange: async (key, value) => {
      if (value === null) store.delete(key); else store.set(key, value);
      for (const listener of windowListeners.storage || []) listener({ key });
      await new Promise(resolve => setImmediate(resolve));
    },
    publicContext: async (value, { origin = 'http://notes.localhost:8080', source = context.window.parent } = {}) => {
      for (const listener of windowListeners.message || []) listener({ origin, source, data: { type: 'featheral:wallet-context', context: value } });
      await new Promise(resolve => setImmediate(resolve));
    },
    themeMessage: (theme, { origin = 'http://notes.localhost:8080', source = context.window.parent } = {}) => {
      for (const listener of windowListeners.message || []) listener({ origin, source, data: { type: 'featheral:wallet-theme', theme } });
    },
    rejectNextSignature: () => { rejectSignature = true; }, loseTipReceipt: () => { tipReceiptLost = true; },
    loseSwapReceipt: () => { swapReceiptLost = true; }, completes: () => completes };
}
test('without an injected provider the built-in wallet unlocks and authenticates without persisting its signing session', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  class LocalVault {
    read() { return { address, links: [] }; }
    verifiedLinks() { return []; }
    async unlock(password) { assert.equal(password, 'test vault password'); this.signer = { address }; }
    async sign(message, owner) { assert.equal(message, 'mock login challenge'); assert.equal(owner, address); return 'local-owner-signature'; }
    lock() { this.signer = null; }
  }
  const ui = await fixture('dollar', { embedded: true, noProvider: true, vaultApi: { Vault: LocalVault } });
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + address));
  await ui.nodes.connect.fire('click');
  assert.equal(ui.nodes.account.hidden, false);
  assert.equal(ui.nodes['local-wallet'].open, true);
  assert.equal(ui.nodes['vault-action'].value, 'unlock');
  ui.nodes['vault-password'].value = 'test vault password';
  await ui.nodes['vault-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.nodes.connect.textContent, 'Disconnect');
  assert.equal(ui.store.has('featheral-creation-token'), false);
  assert.equal(ui.nodes['vault-password'].value, '');
  assert.equal(ui.calls.find(call => call.url.endsWith('/login')).body.signature, 'local-owner-signature');
  ui.advanceTime(600001); ui.interact();
  assert.equal(ui.nodes.connect.textContent, 'Connect wallet');
  assert.match(ui.nodes['vault-status'].textContent, /inactivity/);
  assert.match(ui.nodes['vault-state'].textContent, /Locked/);
  ui.nodes['vault-password'].value = 'test vault password';
  await ui.nodes['vault-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  await ui.nodes['vault-lock'].fire('click');
  assert.equal(ui.nodes.connect.textContent, 'Connect wallet');
  assert.ok(ui.calls.some(call => call.url.endsWith('/logout')));
});
test('site wallet authorizes an existing extension inline and never sends without explicit in-panel approval', async () => {
  const ui = await fixture('dollar', { embedded: true, manualReview: true, followActive: true });
  assert.equal(ui.nodes.balance.textContent, '10 FTH$');
  ui.nodes['send-symbol'].value = 'FTHX'; ui.nodes['send-amount'].value = '2';
  ui.nodes.recipient.value = '0x' + '22'.repeat(20);
  const cancelled = ui.nodes['send-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ui.calls.some(call => call.url.endsWith('/login')));
  assert.equal(ui.nodes['wallet-review'].open, true);
  assert.match(ui.nodes['wallet-review-message'].textContent, /Send 2 FTHX to 0x22/);
  assert.ok(!ui.calls.some(call => call.url.endsWith('/wallet/notes/send')));
  await ui.nodes['wallet-review-cancel'].fire('click'); await cancelled;
  assert.ok(!ui.calls.some(call => call.url.endsWith('/wallet/notes/send')));
  const approved = ui.nodes['send-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  await ui.nodes['wallet-review-confirm'].fire('click'); await approved;
  assert.equal(ui.calls.filter(call => call.url.endsWith('/login')).length, 1, 'reuse the current wallet session');
  assert.equal(ui.calls.find(call => call.url.endsWith('/wallet/notes/send')).body.amount, 2);
  ui.nodes['send-symbol'].value = 'FTH$'; ui.nodes['send-amount'].value = '1';
  const native = ui.nodes['send-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  await ui.nodes['wallet-review-confirm'].fire('click'); await native;
  const transfer = ui.calls.find(call => call.url === '/api/v1/notes/fth/transfers');
  assert.equal(transfer.body.amount, '1000000000000000000');
  assert.equal(transfer.body.signature, 'mock-signature');
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.popups.length, 0);
});
test('a restoring parent selection never resets an existing session and expiration retains the public connection', async () => {
  const address = '0x' + '11'.repeat(20);
  const ui = await fixture('dollar', { embedded: true, noSession: false, followActive: true,
    activeAddress: address, readySelection: address });
  assert.equal(ui.nodes['wallet-connect'].title, 'Disconnect wallet');
  assert.equal(ui.calls.some(call => call.url.endsWith('/logout') || call.url.endsWith('/login')), false);
  assert.deepEqual(ui.errors, []);
  const expired = await fixture('dollar', { embedded: true, noSession: false, followActive: true,
    activeAddress: address, sessionExpired: true });
  assert.equal(expired.nodes.balance.textContent, '10 FTH$');
  assert.match(expired.nodes.address.title, /Connected/);
  assert.equal(expired.store.has('featheral-creation-token'), false);
  assert.match(expired.nodes.status.textContent, /authorization expired/);
});
test('inline provider bridge restores authorized accounts and signs only after deliberate actions', async () => {
  const providerCalls = [], address = '0x' + '11'.repeat(20);
  const ui = await fixture('gold', { embedded: true, noProvider: true, followActive: true,
    parentProvider: async request => { providerCalls.push(request); return request.method === 'personal_sign' ? 'mock-signature' : [address]; } });
  await ui.message({ type: 'featheral:wallet-provider-status', available: true }, { origin: 'https://evil.example' });
  assert.equal(providerCalls.length, 0);
  await ui.message({ type: 'featheral:wallet-provider-status', available: true });
  assert.deepEqual(providerCalls.map(call => call.method), ['eth_accounts']);
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + address));
  await ui.nodes.connect.fire('click');
  assert.ok(providerCalls.some(call => call.method === 'personal_sign'));
  assert.equal(ui.nodes['wallet-connect'].title, 'Disconnect wallet');
  assert.ok(ui.messages.filter(message => message.data.type === 'featheral:wallet-provider')
    .every(message => Object.keys(message.data).sort().join(',') === 'id,request,type'));
  assert.ok(!ui.messages.some(message => message.data.token || message.data.password));
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.popups.length, 0);
});
test('site sign-in approval is inline, rejects financial messages and returns only a signature', async () => {
  const address = '0x' + '11'.repeat(20), nonce = 'ab'.repeat(16);
  const challenge = require('../lib/wallet').signInMessage('Featheral X', address, 'cd'.repeat(16), Date.now());
  const ui = await fixture('notes', { embedded: true, followActive: true });
  await ui.message({ type: 'featheral:wallet-auth-start', nonce }, { source: {} });
  assert.notEqual(ui.nodes['site-approval'].hidden, false);
  await ui.message({ type: 'featheral:wallet-auth-start', nonce });
  assert.equal(ui.nodes['site-approval'].hidden, false);
  assert.equal(ui.nodes.account.hidden, false);
  assert.ok(ui.messages.some(message => message.data.type === 'featheral:wallet-auth-ready'));
  await ui.message({ type: 'featheral:wallet-auth', nonce, address, message: challenge });
  assert.equal(ui.nodes['site-approve'].disabled, false);
  assert.ok(!ui.messages.some(message => message.data.type === 'featheral:wallet-signature'));
  await ui.nodes['site-approve'].fire('click');
  const result = ui.messages.find(message => message.data.type === 'featheral:wallet-signature');
  assert.equal(result.data.signature, 'mock-signature');
  assert.deepEqual(Object.keys(result.data).sort(), ['address', 'nonce', 'signature', 'type']);
  const rejected = await fixture('notes', { embedded: true, followActive: true });
  await rejected.message({ type: 'featheral:wallet-auth-start', nonce });
  await rejected.message({ type: 'featheral:wallet-auth', nonce, address, message: 'Send all funds' });
  assert.match(rejected.messages.at(-1).data.error, /standard Featheral sign-in/);
  await rejected.nodes['site-approve'].fire('click');
  assert.ok(!rejected.messages.some(message => message.data.signature));
  assert.equal(ui.popups.length, 0);
});
test('existing built-in storage can be requested inside Account and denial never redirects', async () => {
  const ui = await fixture('notes', { embedded: true, noProvider: true, storageAccess: async () => {} });
  assert.equal(ui.nodes['wallet-storage'].hidden, false);
  await ui.nodes['wallet-storage'].fire('click');
  assert.equal(ui.reloads(), 1);
  const denied = await fixture('notes', { embedded: true, noProvider: true,
    storageAccess: async () => { throw new Error('Permission denied'); } });
  await denied.nodes['wallet-storage'].fire('click');
  assert.match(denied.nodes['wallet-storage-status'].textContent, /restore your encrypted backup/);
  assert.equal(denied.reloads(), 0); assert.equal(denied.popups.length, 0);
});
test('wallet tabs expose one panel and one keyboard stop, with wrapping arrows and Home/End navigation', async () => {
  const ui = await fixture('notes');
  const names = ['assets', 'send', 'receive', 'swap', 'activity', 'account'];
  for (const name of names) {
    await ui.nodes['tab-' + name].fire('click');
    assert.equal(ui.nodes[name].hidden, false);
    for (const other of names.filter(value => value !== name)) assert.equal(ui.nodes[other].hidden, true);
    assert.equal(ui.nodes['tab-' + name]['aria-selected'], 'true');
    assert.equal(names.filter(value => ui.nodes['tab-' + value].tabIndex === 0).length, 1);
  }
  await ui.nodes['tab-account'].fire('keydown', { key: 'ArrowRight' });
  assert.equal(ui.nodes.assets.hidden, false);
  assert.equal(ui.nodes['tab-assets'].focused, true);
  await ui.nodes['tab-assets'].fire('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.nodes.account.hidden, false);
  await ui.nodes['tab-account'].fire('keydown', { key: 'Home' });
  assert.equal(ui.nodes.assets.hidden, false);
  await ui.nodes['tab-assets'].fire('keydown', { key: 'End' });
  assert.equal(ui.nodes.account.hidden, false);
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.calls.some(call => call.body), false);
});
test('without an extension the central hero offers creation and account links open existing-wallet unlock', async () => {
  class EmptyVault {
    read() { return null; }
    verifiedLinks() { return []; }
  }
  const ui = await fixture('wallet', { noProvider: true, noSession: true, vaultApi: { Vault: EmptyVault } });
  assert.equal(ui.nodes['wallet-connect'].title, 'Connect / create wallet');
  await ui.nodes['wallet-connect'].fire('click');
  assert.equal(ui.nodes.account.hidden, false);
  assert.equal(ui.nodes['local-wallet'].open, true);
  assert.equal(ui.nodes['vault-action'].value, 'create');
  assert.equal(ui.nodes['vault-password'].focused, true);
  assert.deepEqual(ui.errors, []);
  class ExistingVault extends EmptyVault {
    read() { return { address: '0x' + '11'.repeat(20) }; }
  }
  const existing = await fixture('wallet', { view: 'account', noProvider: true, noSession: true, vaultApi: { Vault: ExistingVault } });
  assert.equal(existing.nodes.account.hidden, false);
  assert.equal(existing.nodes['local-wallet'].open, true);
  assert.equal(existing.nodes['vault-action'].value, 'unlock');
  assert.deepEqual(existing.errors, []);
});
test('embedded connection stays inline above tabs and exposes Account creation without a new window', async () => {
  const ui = await fixture('gold', { embedded: true, noSession: true });
  assert.equal(ui.nodes['wallet-connect-action'].hidden, false);
  assert.ok(html.indexOf('id="wallet-connect-action"') < html.indexOf('role="tablist"'));
  assert.equal(ui.nodes['full-wallet'], undefined);
  assert.equal(ui.popups.length, 0);
});
test('compact wallet connection icon exposes its state and keeps pricing explanations out of visible estimates', async () => {
  for (const [options, state, label] of [
    [{}, 'authorized', 'Disconnect wallet'],
    [{ noSession: true, noProvider: true }, 'disconnected', 'Connect / create wallet'],
    [{ noSession: true, activeAddress: '0x' + '11'.repeat(20) }, 'selected', 'Authorize wallet'],
  ]) {
    const ui = await fixture('notes', options), button = ui.nodes['wallet-connect'];
    assert.equal(button.dataset.state, state);
    assert.equal(button['aria-label'], label);
    assert.equal(button.dataset.tooltip, label);
    assert.equal(button.textContent, '');
    assert.deepEqual(ui.errors, []);
  }
  const ui = await fixture('gold', { walletData: { portfolio: { totals: { FTHG: { value: '1', partial: true, unpriced: ['FTHZ'] } },
    usd: '0.00', usdValue: '1', pricedFthDollar: '0', unpriced: ['FTHZ'], partial: true,
    source: 'Long detailed pricing provenance belongs in the tooltip.' } } });
  assert.match(ui.nodes['portfolio-primary'].title, /Long detailed pricing provenance/);
  assert.doesNotMatch(ui.nodes['portfolio-primary'].textContent, /estimated total/);
  assert.match(html, /id="wallet-connect" class="icon-button"/);
  assert.ok(html.indexOf('id="wallet-connect"') < html.indexOf('id="balance"'));
});
test('read-only address field copies the full active address and never copies a missing account', async () => {
  const address = '0x' + '22'.repeat(20);
  const ui = await fixture('gold', { embedded: true, publicAddress: address });
  assert.equal(ui.nodes.address.value, address);
  assert.equal(ui.nodes['copy-wallet-address'].disabled, false);
  await ui.nodes['copy-wallet-address'].fire('click');
  await ui.nodes['copy-address'].fire('click');
  assert.deepEqual(ui.clipboard, [address, address]);
  assert.equal(ui.nodes.status.textContent, 'Address copied.');
  const empty = await fixture('gold', { noSession: true, noProvider: true });
  assert.equal(empty.nodes['copy-wallet-address'].disabled, true);
  await empty.nodes['copy-wallet-address'].fire('click');
  assert.deepEqual(empty.clipboard, []);
  assert.match(empty.nodes.status.textContent, /Connect your wallet first/);
});
test('embedded themes accept only bounded colors from the configured parent and never alter public balances', async () => {
  const ui = await fixture('notes', { embedded: true, activeAddress: '0x1111111111111111111111111111111111111111' });
  const initial = ui.document.body.style['--brand'], reads = ui.calls.length;
  const theme = { accent: '#655bd4', panel: '#ffffff', text: '#202337', background: '#f6f7fb',
    muted: '#70758b', line: '#e4e6ef', button: '#f0f0fa', onAccent: '#ffffff', scheme: 'light' };
  ui.themeMessage(theme, { origin: 'https://evil.example' });
  ui.themeMessage(theme, { source: {} });
  assert.equal(ui.document.body.style['--brand'], initial);
  ui.themeMessage(theme);
  assert.equal(ui.document.body.style['--brand'], theme.accent);
  assert.equal(ui.document.body.style['--panel'], '#ffffff');
  assert.equal(ui.document.body.style.colorScheme, 'light');
  ui.themeMessage({ accent: 'url(https://evil.example/track)', panel: '#fff;background:red', text: 'x'.repeat(81), scheme: 'invalid' });
  assert.equal(ui.document.body.style['--brand'], theme.accent);
  assert.equal(ui.document.body.style['--panel'], '#ffffff');
  assert.equal(ui.document.body.style['--txt'], '#202337');
  assert.equal(ui.document.body.style.colorScheme, 'light');
  assert.equal(ui.calls.length, reads);
  assert.deepEqual(ui.errors, []);
});
test('standalone wallet defaults to gold with visible connection state while embeds keep their host accent', async () => {
  const disconnected = await fixture('wallet', { noSession: true, noProvider: true });
  assert.equal(disconnected.document.body.style['--brand'], '#e2b13c');
  assert.equal(disconnected.nodes['wallet-connect-label'].textContent, 'Connect wallet');
  const connected = await fixture('wallet');
  assert.equal(connected.nodes['wallet-connect-label'].textContent, 'Disconnect');
  const readOnly = await fixture('wallet', { publicAddress: '0x' + '22'.repeat(20) });
  assert.equal(readOnly.nodes['wallet-connect-label'].textContent, 'Read-only');
  assert.equal(readOnly.nodes['wallet-connect'].disabled, true);
  const embedded = await fixture('notes', { embedded: true });
  assert.equal(embedded.document.body.style['--brand'], require('../../../shared/site-colors.json')['notes.featheral.com'].color);
});
test('asset list hides zeros and shows icons for every positive internal and native ETH holding', async () => {
  const ui = await fixture('dollar', { walletData: { ethereum: { balance: '0' }, dollar: { balance: { available: '0' }, transactions: [] },
    holdings: [{ symbol: 'FTHX', balance: 7 }, { symbol: 'FTHA', balance: 3 }, { symbol: 'FTHB', balance: 0 }],
    portfolio: { assets: [], totals: {}, usd: null, fthg: null, pricedFthDollar: '0', unpriced: [], source: 'Test',
      nativeAssets: [{ name: 'Base', balance: '1000000000000000000', estimates: {} }, { name: 'Linea', balance: '0', estimates: {} }] } } });
  assert.deepEqual(ui.errors, []);
  assert.match(ui.nodes.holdings.textContent, /7 FTHX/);
  assert.match(ui.nodes.holdings.textContent, /3 FTHA/);
  assert.match(ui.nodes.holdings.textContent, /Base1 ETH/);
  assert.doesNotMatch(ui.nodes.holdings.textContent, /FTHB|FTHG|Linea|0 FTH\$/);
  const icons = ui.nodes.holdings.children.map(row => row.children[0].children[0]);
  assert.equal(icons.length, 3);
  assert.ok(icons.every(icon => typeof icon.src === 'string'));
  assert.match(icons[1].src, /^data:image\/svg\+xml,/);
  assert.equal(icons[2].src, '/shared/logo-eth.svg');
});
test('linked public accounts contribute to estimates but never inflate the active spendable balance', async () => {
  const address = '0x1111111111111111111111111111111111111111', linked = '0x2222222222222222222222222222222222222222';
  class LocalVault {
    read() { return { address, links: [{ address: linked }] }; }
    verifiedLinks() { return [{ address: linked }]; }
  }
  const value = '10000000000000000000';
  const ui = await fixture('dollar', { noProvider: true, vaultApi: { Vault: LocalVault },
    walletData: { portfolio: { totals: Object.fromEntries(['FTH$', 'FTHG', 'FTHX'].map(symbol => [symbol, { value, unpriced: [] }])),
      assets: [], usd: '2.00', usdValue: '2000000000000000000', fthg: value, pricedFthDollar: value, unpriced: [], source: 'Test' } } });
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.nodes.balance.textContent, '10 FTH$');
  assert.equal(ui.nodes['portfolio-primary'].textContent, '≈ 20 FTH$');
  assert.equal(ui.nodes['portfolio-usd'].textContent, '$4.0000');
  assert.equal(ui.nodes['available-balance'].textContent, 'Available to spend: 10 FTH$');
  assert.match(ui.nodes['account-label'].title, /funds separate/);
  assert.match(ui.nodes.holdings.textContent, /Linked.*separate funds/);
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + linked));
  assert.equal(ui.calls.some(call => call.body), false);
});
test('all embedded primary currencies read the same built-in account and linked portfolio without unlocking', async () => {
  const address = '0x1111111111111111111111111111111111111111', linked = '0x2222222222222222222222222222222222222222';
  class PublicVault {
    read() { return { address, links: [{ address: linked }] }; }
    verifiedLinks() { return [{ address: linked }]; }
    unlock() { throw new Error('Embeds must never unlock'); }
  }
  const value = '10000000000000000000', portfolio = { assets: [],
    totals: Object.fromEntries(['FTHX', 'FTHG', 'FTH$'].map(symbol => [symbol, { value, unpriced: [] }])),
    usd: '2.00', usdValue: '2000000000000000000', fthg: value, pricedFthDollar: value, unpriced: [], source: 'Test' };
  for (const host of ['gold', 'dollar', 'world', 'notes', 'ex', 'sites', 'x', 'foundation', 'stats']) {
    const ui = await fixture(host, { embedded: true, noProvider: true, followActive: true, vaultApi: { Vault: PublicVault }, walletData: { portfolio } });
    assert.deepEqual(ui.errors, [], host);
    assert.equal(ui.nodes['portfolio-usd'].textContent, '$4.0000', host);
    assert.match(ui.nodes['address'].title, /Built-in/, host);
    assert.notEqual(ui.nodes['local-wallet'].hidden, true);
    assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + linked), host);
    assert.ok(!ui.calls.some(call => call.url === '/api/creation/wallet'), host);
    assert.equal(ui.calls.some(call => call.body), false);
  }
});
test('normal site wallets follow central account switches and refreshes, while explicit address views stay pinned', async () => {
  const siteAccount = '0x3333333333333333333333333333333333333333', active = '0x1111111111111111111111111111111111111111',
    next = '0x2222222222222222222222222222222222222222';
  const ui = await fixture('notes', { embedded: true, publicAddress: siteAccount, activeAddress: active, followActive: true });
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + active));
  assert.ok(!ui.calls.some(call => call.url === '/api/wallet/accounts/' + siteAccount));
  await ui.storageChange('featheral-wallet-active-account', next);
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + next));
  const previous = ui.calls.filter(call => call.url === '/api/wallet/accounts/' + next).length;
  await ui.storageChange('featheral-wallet-updated', 'new-transaction');
  assert.equal(ui.calls.filter(call => call.url === '/api/wallet/accounts/' + next).length, previous + 1);
  assert.deepEqual(ui.errors, []);
  const pinned = await fixture('notes', { embedded: true, publicAddress: siteAccount, activeAddress: active });
  await pinned.storageChange('featheral-wallet-active-account', next);
  assert.ok(pinned.calls.filter(call => call.url.startsWith('/api/wallet/accounts/')).every(call => call.url.endsWith(siteAccount)));
  assert.deepEqual(pinned.errors, []);
});
test('Gold and Dollar retain actual balances and value FTHX and held notes when market discovery fails', async () => {
  const { portfolio } = require('../../notes/portfolio'), unit = 10n ** 18n;
  const ethereum = { balance: '0', chainId: 1, token: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665', checkedAt: new Date().toISOString() };
  const holdings = [{ symbol: 'FTHX', balance: '500000' }, { symbol: 'FTHA', balance: '500000' }];
  const gold = { chain: { id: 1, tokenAddress: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665' },
    checkedAt: new Date().toISOString(), bridge: { configured: true, deployed: true, initialized: true, paused: false,
      reserveFthg: String(unit), actualFthgBalance: String(unit), reserveFthDollar: String(10000n * unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  for (const host of ['gold', 'dollar']) {
    for (const unpriced of [false, true]) {
      const assets = [...holdings, ...(unpriced ? [{ symbol: 'FTHZ', balance: '1' }] : [])];
      const value = portfolio(assets, { funded: false, dollars: '0', fthx: 0, version: 0 },
        [{ symbol: 'FTHA', funded: true, price: { numerator: '1', denominator: '1' } }], gold, { ethereum });
      assert.equal(value.fthg, String(unit));
      const ui = await fixture(host, { embedded: true, noSession: true, noProvider: true, followActive: true,
        activeAddress: '0x' + '11'.repeat(20), marketError: true, walletData: {
          holdings: assets, ethereum, dollar: { balance: { available: '0' }, transactions: [] }, portfolio: value } });
      assert.deepEqual(ui.errors, ['Market server offline']);
      assert.equal(ui.nodes.balance.textContent, host === 'gold' ? '0.000 FTHG' : '0.00 FTH$');
      assert.equal(ui.nodes['portfolio-usd'].textContent, `$2.0000${unpriced ? ' (partial)' : ''}`);
      assert.equal(ui.nodes['portfolio-primary'].textContent,
        '≈ ' + (host === 'gold' ? '1 FTHG' : '10,000 FTH$') + `${unpriced ? ' (partial)' : ''}`);
      assert.match(ui.nodes.status.textContent, /Market list unavailable.*Held balances are shown independently/);
      if (unpriced) assert.match(ui.nodes['portfolio-usd'].title, /FTHZ/);
      assert.ok(ui.calls.some(call => call.url.startsWith('/api/wallet/accounts/')));
      assert.ok(!ui.calls.some(call => call.body || call.headers?.['x-creation-token']));
    }
  }
  assert.doesNotMatch(html, /valuation-details|id="portfolio-fthg"/);
});
test('temporary FTHG USD reference remains visible and positive dust never displays as zero USD', async () => {
  for (const host of ['gold', 'dollar']) {
    const ui = await fixture(host, { walletData: { portfolio: {
      totals: { FTHG: { value: '1000000000000000000', unpriced: [] } }, usd: '0.00',
      usdValue: '1000000000000000', fthg: '1000000000000000000', pricedFthDollar: '10000000000000000000000',
      unpriced: [], source: 'Test', usdMarket: { fallback: true, source: '1 FTHG = $0.01 temporary estimate' } } } });
    assert.equal(ui.nodes['portfolio-usd'].textContent, '$0.0010 · reference');
    assert.match(ui.nodes['portfolio-usd'].title, /1 FTHG = \$0.01/);
    assert.deepEqual(ui.errors, []);
  }
});
test('all asset balances show smaller USD and site-primary estimates without counting trading custody twice', async () => {
  const unit = 10n ** 18n;
  for (const [host, primary] of [['gold', 'FTHG'], ['dollar', 'FTH$'], ['notes', 'FTHX']]) {
    const estimates = Object.fromEntries(['FTHG', 'FTH$', 'FTHX'].map(symbol => [symbol, String(200n * unit)]));
    const ui = await fixture(host, { walletData: {
      ethereum: { balance: String(2n * unit) },
      holdings: [{ symbol: 'FTHX', balance: '123' }, { symbol: 'FTHA', balance: '3' }],
      trading: { holdings: [{ symbol: 'FTHX', balance: '77' }] },
      portfolio: { assets: [
        { symbol: 'FTH$', balance: String(10n * unit), estimates, usdValue: String(unit) },
        { symbol: 'FTHX', balance: '200', estimates, usdValue: String(20n * unit) },
        { symbol: 'FTHA', balance: '3', estimates, usdValue: '1000000000000000' },
      ], ethereumEstimates: estimates, ethereumUsdValue: '20000000000000000',
      nativeAssets: [{ symbol: 'ETH', name: 'Base', balance: String(unit), estimates, usdValue: String(2000n * unit) }],
      usdMarket: { fallback: true, source: 'Temporary reference: 1 FTHG = $0.01' },
      totals: { [primary]: { value: String(1000n * unit), unpriced: [] } }, usd: '2021.02', usdValue: String(202102n * unit / 100n),
      fthg: String(1000n * unit), pricedFthDollar: String(1000n * unit), unpriced: [], source: 'Test' },
    } });
    assert.deepEqual(ui.errors, []);
    const rows = ui.nodes.holdings.children;
    const fthx = rows.find(row => row.children[0].textContent.startsWith('FTHX'));
    assert.match(fthx.textContent, /123 FTHX≈ \$12\.3000 · reference/);
    assert.match(fthx.textContent, new RegExp(`≈ 123 ${primary.replace('$', '\\$')}`));
    const amounts = fthx.children[1];
    assert.equal(amounts.children[0].textContent, '123 FTHX');
    assert.match(amounts.children[1].textContent, /\$12\.30/);
    assert.match(amounts.children[2].textContent, /≈ 123 /);
    assert.match(ui.nodes['trading-holdings'].textContent, /77 FTHX≈ \$7\.7000 · reference/);
    assert.match(rows.find(row => row.children[0].textContent.startsWith('FTHA')).textContent, /\$0\.001/);
    const eth = rows.find(row => row.children[0].textContent.startsWith('ETH'));
    assert.match(eth.textContent, /≈ \$2,000\.00/);
    assert.doesNotMatch(eth.textContent, /reference/);
    assert.match(rows.find(row => row.children[0].textContent.startsWith('FTHG')).textContent, /2 FTHG≈ \$0\.0200 · reference/);
  }
  assert.ok(html.indexOf('id="available-balance"') < html.indexOf('id="portfolio-usd"'));
  assert.ok(html.indexOf('id="available-balance"') < html.indexOf('id="portfolio-primary"'));
});
test('Gold estimates remain visible at four decimal precision independently of the spendable balance', async () => {
  for (const [raw, usd, gold] of [
    ['1234567890123456', '$0.0012', '0.0012 FTHG'],
    ['999999999999999999', '$1.0000', '1 FTHG'],
    ['100000000000000', '$0.0001', '0.0001 FTHG'],
    ['1', '<$0.0001', '<0.0001 FTHG'],
    ['0', '$0.0000', '0 FTHG'],
  ]) {
    const ui = await fixture('gold', { walletData: { ethereum: { balance: '0' }, portfolio: {
      totals: { FTHG: { value: raw, unpriced: [] } }, usdValue: raw, usd: '0.00',
      fthg: raw, pricedFthDollar: '0', unpriced: [], source: 'Test',
    } } });
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.nodes.balance.textContent, '0.000 FTHG');
    assert.equal(ui.nodes['portfolio-usd'].textContent, usd);
    assert.equal(ui.nodes['portfolio-primary'].textContent, `≈ ${gold}`);
  }
});
test('public central-wallet selection returns amounts despite isolated iframe storage, without a session', async () => {
  const address = '0x' + '22'.repeat(20);
  for (const host of ['gold', 'dollar']) {
    const ui = await fixture(host, { embedded: true, followActive: true, noSession: true, noProvider: true });
    assert.ok(!ui.calls.some(call => call.url.startsWith('/api/wallet/accounts/')));
    await ui.selectAccount(address, { nonce: 'wrong' });
    await ui.selectAccount(address, { fromParent: true, origin: 'https://evil.example' });
    await ui.selectAccount(address, { origin: 'http://notes.localhost:8080', source: {} });
    assert.ok(!ui.calls.some(call => call.url.startsWith('/api/wallet/accounts/')));
    await ui.selectAccount(address, { fromParent: true, origin: 'http://notes.localhost:8080' });
    assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/' + address));
    assert.equal(ui.messages.at(-1).data.type, 'featheral:wallet-selected');
    assert.deepEqual(Object.keys(ui.messages.at(-1).data).sort(), ['address', 'type']);
    assert.ok(!ui.calls.some(call => call.body || call.headers?.['x-creation-token']));
    assert.equal(ui.store.has('featheral-creation-token'), false);
    assert.deepEqual(ui.errors, []);
  }
  const stale = await fixture('dollar', { embedded: true, noSession: true, followActive: true,
    activeAddress: '0x' + '11'.repeat(20) });
  await stale.selectAccount(address, { fromParent: true, origin: 'https://evil.example' });
  assert.ok(!stale.calls.some(call => call.url === '/api/wallet/accounts/' + address));
  await stale.selectAccount(address, { fromParent: true, origin: 'http://notes.localhost:8080' });
  assert.ok(stale.calls.some(call => call.url === '/api/wallet/accounts/' + address));
  const next = '0x' + '33'.repeat(20);
  await stale.storageChange('featheral-wallet-active-account', next);
  assert.equal(stale.calls.filter(call => call.url.startsWith('/api/wallet/accounts/')).at(-1).url, '/api/wallet/accounts/' + next);
  assert.equal(stale.messages.at(-1).data.address, next);
  assert.equal(stale.popups.length, 0);
});
test('slow market discovery never delays amounts or scheduled balance updates and recovery clears only its warning', async () => {
  const address = '0x' + '11'.repeat(20);
  for (const host of ['gold', 'dollar']) {
    const ui = await fixture(host, { embedded: true, noSession: true, activeAddress: address, followActive: true,
      marketDelay: true, walletData: { ethereum: { balance: '2000000000000000000' } } });
    assert.equal(ui.nodes.balance.textContent, host === 'gold' ? '2 FTHG' : '10 FTH$');
    const before = ui.calls.filter(call => call.url.startsWith('/api/wallet/accounts/')).length;
    await ui.intervals.find(timer => timer.delay === 30000).callback();
    assert.equal(ui.calls.filter(call => call.url.startsWith('/api/wallet/accounts/')).length, before + 1);
    await ui.recoverMarkets();
    assert.deepEqual(ui.errors, []);
  }
  const failed = await fixture('dollar', { marketError: true });
  assert.match(failed.nodes.status.textContent, /Market list unavailable/);
  await failed.recoverMarkets();
  await failed.nodes.refresh.fire('click');
  assert.equal(failed.nodes.status.textContent, '');
});
test('full central wallet restores only already-authorized extension accounts and returns public selection only', async () => {
  const nonce = 'ab'.repeat(16);
  const ui = await fixture('wallet', { noSession: true, selectionNonce: nonce });
  assert.ok(ui.calls.some(call => call.url === '/api/wallet/accounts/0x' + '11'.repeat(20)));
  const result = ui.messages.find(message => message.data.type === 'featheral:wallet-selected');
  assert.equal(result.origin, 'http://gold.localhost:8080');
  assert.deepEqual(Object.keys(result.data).sort(), ['address', 'nonce', 'type']);
  assert.equal(result.data.nonce, nonce);
  assert.equal(ui.store.has('featheral-creation-token'), false);
  assert.ok(!ui.calls.some(call => call.body));
  assert.deepEqual(ui.errors, []);
});
test('shared World guest valuations render in FTHX wallets as well as Dollar wallets', async () => {
  for (const host of ['notes', 'ex', 'dollar']) {
    const ui = await fixture(host, { embedded: true, noProvider: true, worldAccount: '0x' + 'ab'.repeat(32) });
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.nodes.balance.textContent, host === 'dollar' ? '1 FTH$' : '— FTHX');
    assert.equal(ui.nodes['portfolio-primary'].textContent, host === 'dollar' ? '≈ 1 FTH$' : '≈ 100 FTHX');
    assert.equal(ui.calls.some(call => call.body), false);
  }
});
test('embeds ignore retired parent account handoffs and follow only central public storage without sessions', async () => {
  const address = '0x1111111111111111111111111111111111111111', linked = '0x2222222222222222222222222222222222222222';
  const value = '1000000000000000000';
  const ui = await fixture('notes', { embedded: true, followActive: true, activeAddress: address, walletData: { portfolio: { assets: [],
    totals: Object.fromEntries(['FTHX', 'FTHG', 'FTH$'].map(symbol => [symbol, { value, unpriced: [] }])),
    usd: '1.00', usdValue: value, fthg: value, pricedFthDollar: value, unpriced: [], source: 'Test' } } });
  const context = { address, addresses: [address, linked], worldAccount: null };
  await ui.publicContext(context, { origin: 'https://evil.example' });
  await ui.publicContext(context, { source: {} });
  const before = ui.calls.length;
  const persisted = Array.from(ui.store.entries());
  await ui.publicContext(context);
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.calls.length, before);
  assert.equal(ui.nodes.balance.textContent, '123 FTHX');
  assert.equal(ui.nodes['portfolio-primary'].textContent, '≈ 1 FTHX');
  assert.equal(ui.nodes['portfolio-usd'].textContent, '$1.0000');
  assert.ok(!ui.calls.some(call => call.url === '/api/wallet/accounts/' + linked));
  assert.deepEqual(Array.from(ui.store.entries()), persisted);
  assert.equal(ui.calls.some(call => call.body), false);
  const world = '0x' + 'ab'.repeat(32);
  await ui.publicContext({ ...context, worldAccount: world });
  assert.equal(ui.calls.length, before);
  await ui.publicContext({ ...context, addresses: [address, address] });
  assert.deepEqual(ui.errors, []);
  assert.ok(!ui.calls.some(call => call.headers?.['x-creation-token']));
});
test('wallet displays only primary and USD portfolio totals without an expanded estimates section', async () => {
  const portfolio = { assets: [], totals: {
    FTHX: { value: '356000000000000000000', unpriced: [] }, 'FTH$': { value: '3560000000000000000', unpriced: [] } },
    usd: '0.71', fthg: null, pricedFthDollar: '3560000000000000000', unpriced: [], source: 'Test',
    dollarReference: { numerator: '100000000000000000000', denominator: '1000000000000000000', source: 'opening' } };
  for (const host of ['dollar', 'ex']) {
    const ui = await fixture(host, { walletData: { portfolio } });
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.nodes['portfolio-usd'].textContent, '$0.7100');
    assert.equal(ui.nodes['portfolio-primary'].textContent, host === 'ex' ? '≈ 356 FTHX' : '≈ 3.56 FTH$');
    if (host === 'ex') assert.equal(ui.nodes.balance.textContent, '123 FTHX');
  }
  portfolio.dollarReference = { numerator: '50000000000000000000', denominator: '1000000000000000000', source: 'exchange' };
  const live = await fixture('dollar', { walletData: { portfolio } });
  assert.equal(live.nodes['portfolio-primary'].textContent, '≈ 3.56 FTH$');
  assert.equal(live.nodes['portfolio-rate'], undefined);
});
test('one wallet defaults to FTH$ on Dollar and FTHX on Exchange/Notes, using the same balances and internal APIs', async () => {
  for (const host of ['dollar', 'ex', 'notes']) {
    const { nodes, errors, document } = await fixture(host), fthx = host !== 'dollar';
    assert.deepEqual(errors, []);
    assert.equal(document.body.dataset.primary, fthx ? 'FTHX' : 'FTH$');
    assert.equal(nodes.balance.textContent, fthx ? '123 FTHX' : '10 FTH$');
    assert.equal(nodes['send-symbol'].value, fthx ? 'FTHX' : 'FTH$');
    assert.equal(nodes.swap.hidden, false);
    assert.equal(nodes['exchange-link'].href, 'http://ex.localhost:8080/');
  }
});
test('all sites lead with actual primary holdings even when combined estimates differ or prices are missing', async () => {
  const portfolio = { assets: [], totals: Object.fromEntries(['FTHG', 'FTH$', 'FTHX'].map(symbol =>
    [symbol, { value: '9000000000000000000', unpriced: [] }])),
    usd: '12.34', fthg: '9000000000000000000', pricedFthDollar: '9000000000000000000', unpriced: [], source: 'Test' };
  for (const host of ['featheral', 'foundation', 'gold', 'dollar', 'world', 'notes', 'ex', 'x', 'sites', 'stats', 'wallet', 'community']) {
    const primary = require('../../wallet/ui').primaryFor(`${host}.localhost`);
    const options = { walletData: { ethereum: { balance: '2000000000000000000' }, portfolio } };
    const ui = await fixture(host, options);
    const balance = primary === 'FTHG' ? '2 FTHG' : primary === 'FTH$' ? '10 FTH$' : '123 FTHX';
    assert.deepEqual(ui.errors, [], host);
    assert.equal(ui.nodes.balance.textContent, balance, host);
    assert.equal(ui.nodes['account-label'].textContent, `Available ${primary}`, host);
    assert.equal(ui.nodes['portfolio-primary'].textContent, `≈ 9 ${primary}`, host);
    assert.equal(ui.nodes['portfolio-usd'].textContent, '$12.3400', host);
    const unpriced = await fixture(host, { walletData: { ...options.walletData, portfolio: { ...portfolio, totals: {}, usd: null } } });
    assert.deepEqual(unpriced.errors, [], host);
    assert.equal(unpriced.nodes.balance.textContent, balance, host);
    assert.equal(unpriced.nodes['portfolio-primary'].textContent, `${primary} total unavailable`, host);
    assert.equal(unpriced.nodes['portfolio-usd'].textContent, 'USD unavailable', host);
  }
});
test('empty wallets display currency-specific zero precision before connection and for confirmed zero balances', async () => {
  for (const [host, expected] of [['wallet', '0.00 FTHX'], ['dollar', '0.00 FTH$'], ['gold', '0.000 FTHG'], ['silver', '0.000 FTHS']]) {
    const empty = await fixture(host, { noSession: true, noProvider: true });
    assert.equal(empty.nodes.balance.textContent, expected);
    const connected = await fixture(host, { walletData: { ethereum: { balance: '0' },
      dollar: { balance: { available: '0' }, transactions: [] }, holdings: [] } });
    assert.equal(connected.nodes.balance.textContent, expected);
  }
});
test('Gold and Foundation never replace an unavailable or zero FTHG balance with portfolio estimates', async () => {
  for (const host of ['gold', 'featheral']) {
    for (const balance of [null, undefined, '0']) {
      const ui = await fixture(host, { walletData: { ethereum: { balance }, portfolio: { assets: [],
        totals: { FTHG: { value: '9000000000000000000', unpriced: [] } }, usd: null, fthg: null,
        pricedFthDollar: '0', unpriced: [], source: 'Test' } } });
      assert.deepEqual(ui.errors, []);
      assert.equal(ui.nodes.balance.textContent, balance == null ? '— FTHG' : '0.000 FTHG');
      assert.equal(ui.nodes['portfolio-primary'].textContent, '≈ 9 FTHG');
      assert.equal(ui.nodes['available-balance'].textContent, balance == null ? 'FTHG balance unavailable' : 'Available to spend: 0 FTHG');
    }
  }
});
test('pinned views cannot write and blocked storage explicitly explains inline storage requirements', async () => {
  const ui = await fixture('notes', { embedded: true, publicAddress: '0x' + '11'.repeat(20) });
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  await ui.nodes['swap-form'].listeners.submit(event);
  assert.equal(ui.calls.some(call => call.body), false);
  const blocked = await fixture('notes', { embedded: true, storageBlocked: true, noProvider: true });
  assert.match(blocked.nodes.status.textContent, /storage is blocked/);
  assert.equal(blocked.calls.some(call => call.body), false);
});
test('wallet leads with the actual primary balance, smaller portfolio estimates and newest transactions', async () => {
  const walletData = { portfolio: { assets: [], totals: { FTHX: { value: '150500000000000000000', partial: true, unpriced: ['Ethereum FTHG'] } },
    usd: '12.34', fthg: '2000000000000000000', partial: true, pricedFthDollar: '10000000000000000000', unpriced: ['FTHA'], source: 'Test' },
    noteTransfers: [{ owner: 'other', symbol: 'FTHX', amount: '1', at: 100 }, { owner: 'other', symbol: 'FTHX', amount: '9', at: 300 },
      { owner: 'other', symbol: 'FTHX', amount: '3', at: 200 }, { owner: 'other', symbol: 'FTHX', amount: '4', at: 50 }] };
  const { nodes, errors } = await fixture('notes', { walletData });
  assert.deepEqual(errors, []);
  assert.equal(nodes.balance.textContent, '123 FTHX');
  assert.equal(nodes['portfolio-primary'].textContent, '≈ 150.5 FTHX (partial)');
  assert.equal(nodes.balance.children[1].className, 'balance-currency');
  assert.equal(nodes.balance.children[1].textContent, ' FTHX');
  assert.equal(nodes['available-balance'].textContent, 'Available to spend: 123 FTHX');
  assert.equal(nodes['portfolio-usd'].textContent, '$12.3400 (partial)');
  assert.doesNotMatch(nodes['account-label'].textContent, /subtotal/i);
  assert.match(nodes['portfolio-usd'].title, /Unpriced: FTHA/);
  assert.equal(nodes['recent-history'].children.length, 3);
  assert.equal(nodes['recent-history'].children[0].children[1].textContent, '9 FTHX');
  assert.equal(nodes.history.children.length, 4);
  assert.equal(nodes['profile-link'].href, 'http://world.localhost:8080/#/setup');
});
test('public-address embeds ignore stored sessions belonging to another account', async () => {
  const publicAddress = '0x2222222222222222222222222222222222222222';
  const { calls, nodes, errors } = await fixture('notes', { embedded: true, publicAddress });
  assert.deepEqual(errors, []);
  assert.ok(calls.some(call => call.url === '/api/wallet/accounts/' + publicAddress));
  assert.ok(!calls.some(call => call.url === '/api/creation/wallet'));
  assert.equal(nodes.address.value, publicAddress);
  assert.match(nodes.address.title, /Read-only/);
});
test('central wallet replaces Thanks with inline Exchange swaps and resumable settlements', async () => {
  const ui = await fixture('dollar', { walletData: { exchange: { trades: [], requests: [
    { id: 'existing-request', parameters: {}, from: 'FTH$', to: 'FTHX', status: 'prepared' },
  ] } } });
  assert.deepEqual(ui.errors, []);
  assert.match(html, /id="swap-form"/);
  assert.doesNotMatch(html, /id="(?:tip-form|tab-tip|fund-form)"/);
  assert.match(source, /api\("\/wallet\/swaps\/quote"/);
  const button = ui.nodes.requests.children[0];
  assert.equal(button.textContent, 'Resume FTH$ → FTHX');
  assert.equal(typeof button.listeners.click, 'function');
  assert.equal(ui.calls.some(call => call.body), false);
  assert.match(html, /Gold native bridge/);
});
test('swap retries retain the exact request ID after a rejected signature and concurrent submits cannot double trade', async () => {
  const ui = await fixture('notes'), { nodes } = ui;
  nodes['swap-from'].value = 'FTH$'; nodes['swap-to'].value = 'FTHX';
  nodes['swap-amount'].value = '5'; ui.rejectNextSignature();
  await nodes['swap-form'].fire('submit');
  assert.match(nodes.status.textContent, /signature rejected/);
  await Promise.all([nodes['swap-form'].fire('submit'), nodes['swap-form'].fire('submit')]);
  const requests = ui.calls.filter(call => call.url.endsWith('/wallet/swaps/prepare'));
  assert.equal(requests.length, 2); assert.equal(requests[0].body.requestId, requests[1].body.requestId);
  assert.equal(requests[0].body.minOutput, '9');
  assert.equal(ui.completes(), 1);
  assert.match(nodes['swap-status'].textContent, /recorded on Exchange/);
});
test('Swap requires explicit approval, preserves exact Dollar minimums and recovers a lost receipt without a second trade', async () => {
  const ui = await fixture('notes', { manualReview: true, markets: [{ symbol: 'FTHA', funded: true }] });
  ui.nodes['swap-from'].value = 'FTH$'; ui.nodes['swap-to'].value = 'FTHA';
  ui.nodes['swap-amount'].value = '1.000000000000000001';
  const submit = ui.nodes['swap-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.some(call => call.url.endsWith('/wallet/swaps/prepare')), false);
  assert.match(ui.nodes['wallet-review-message'].textContent, /1\.000000000000000001 FTH\$ → at least 9 FTHA/);
  await ui.nodes['wallet-review-cancel'].fire('click'); await submit;
  assert.equal(ui.calls.some(call => call.url.endsWith('/wallet/swaps/prepare')), false);
  const approved = ui.nodes['swap-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  ui.loseSwapReceipt();
  await ui.nodes['wallet-review-confirm'].fire('click'); await approved;
  assert.equal(ui.completes(), 1);
  assert.match(ui.nodes.status.textContent, /lost swap receipt/);
  await ui.nodes['swap-form'].fire('submit');
  assert.equal(ui.completes(), 1);
  const prepared = ui.calls.filter(call => call.url.endsWith('/wallet/swaps/prepare'));
  assert.equal(prepared[0].body.amount, '1000000000000000001');
  assert.equal(prepared[0].body.minOutput, '9');
  assert.equal(prepared[0].body.requestId, prepared[1].body.requestId);
  assert.match(ui.nodes['swap-status'].textContent, /recorded on Exchange/);
  assert.equal(ui.popups.length, 0);
});
test('Dollar wallets show held notes and FTHX swaps independently of Dollar liquidity', async () => {
  const ui = await fixture('dollar', { markets: [{ symbol: 'FTHA', funded: true }, { symbol: 'FTHB', funded: false }],
    walletData: { holdings: [{ symbol: 'FTHX', balance: '42' }, { symbol: 'FTHA', balance: '3' }] } });
  assert.deepEqual(ui.errors, []);
  assert.match(ui.nodes.holdings.textContent, /42 FTHX/);
  assert.match(ui.nodes.holdings.textContent, /3 FTHA/);
  assert.equal(ui.nodes['note-pairs'].hidden, false);
  ui.setFunded(false); await ui.nodes.refresh.fire('click');
  for (const pair of ui.nodes['note-pairs'].children.slice(1)) {
    assert.equal(pair.textContent, 'FTHX ↔ FTHA');
    await pair.fire('click');
    assert.equal(ui.nodes['swap-to'].value, 'FTHA');
    assert.equal(ui.nodes.swap.hidden, false);
  }
  assert.equal(ui.nodes['swap-to'].children.some(option => option.value === 'FTHB'), false);
  const empty = await fixture('dollar', { markets: [{ symbol: 'FTHA', funded: true }], walletData: { holdings: [] } });
  assert.equal(empty.nodes['note-pairs'].hidden, true);
});
test('Exchange custody appears separately and never increases wallet spendable holdings or row estimates', async () => {
  const ui = await fixture('notes', { walletData: {
    trading: { holdings: [{ symbol: 'FTHX', balance: '77' }, { symbol: 'FTHA', balance: '5' }] },
    portfolio: { assets: [{ symbol: 'FTHX', balance: '200', estimates: { FTHX: '200000000000000000000' } }],
      totals: { FTHX: { value: '200000000000000000000', unpriced: [] } }, usd: null, fthg: null,
      pricedFthDollar: '10000000000000000000', unpriced: [], source: 'Test' },
  } });
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.nodes['available-balance'].textContent, 'Available to spend: 123 FTHX');
  assert.match(ui.nodes.holdings.textContent, /123 FTHX/);
  assert.doesNotMatch(ui.nodes.holdings.textContent, /77 FTHX|5 FTHA|200 FTHX/);
  assert.match(ui.nodes.holdings.textContent, /≈ 123 FTHX/);
  assert.equal(ui.nodes['trading-holdings'].hidden, false);
  assert.match(ui.nodes['trading-holdings'].textContent, /not available to send or swap.*77 FTHX.*5 FTHA/);
});
test('visible embedded wallets refresh public totals every 30 seconds and accept only their configured parent update hint', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const ui = await fixture('notes', { embedded: true, publicAddress: address });
  const poll = ui.intervals.find(timer => timer.delay === 30000);
  assert.ok(poll);
  const reads = () => ui.calls.filter(call => call.url.startsWith('/api/wallet/accounts/')).length;
  const initial = reads();
  await Promise.all([poll.callback(), poll.callback()]);
  assert.equal(reads(), initial + 1);
  ui.document.hidden = true;
  await poll.callback(); await ui.notifyUpdate();
  assert.equal(reads(), initial + 1);
  ui.document.hidden = false;
  await ui.notifyUpdate({ origin: 'https://evil.example' }); await ui.notifyUpdate({ source: {} });
  assert.equal(reads(), initial + 1);
  await ui.notifyUpdate();
  assert.equal(reads(), initial + 2);
  await ui.nodes.refresh.fire('click');
  assert.equal(reads(), initial + 3);
  assert.equal(ui.calls.some(call => call.body), false);
  assert.deepEqual(ui.errors, []);
});
