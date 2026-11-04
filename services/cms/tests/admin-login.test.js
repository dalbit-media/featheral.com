const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { ethers } = require('ethers');
const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/admin.featheral.com/js/login.js'), 'utf8');
const address = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
function fixture({ providers = [], injected, account = address, request, auth } = {}) {
  const nodes = {}, events = new Map(), calls = [], rpc = [], errors = [];
  for (const id of ['login-status', 'login-sign', 'login-provider', 'login-provider-field']) {
    nodes[id] = { value: '', textContent: '', disabled: false, hidden: false, handlers: {}, options: [],
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; },
      replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }, add(option) { this.options.push(option); } };
  }
  const providerEvents = new Map();
  const provider = { async request(body) {
    rpc.push(body);
    if (request) return request(body);
    if (body.method === 'eth_requestAccounts' || body.method === 'eth_accounts') return [account];
    if (body.method === 'personal_sign') return 'signed-message';
    throw Error('Unexpected wallet method: ' + body.method);
  }, on(name, callback) { providerEvents.set(name, callback); }, removeListener(name) { providerEvents.delete(name); } };
  let reloads = 0;
  const window = { ethereum: injected === true ? provider : injected,
    addEventListener(name, callback) { events.set(name, callback); },
    dispatchEvent(event) { if (event.type === 'eip6963:requestProvider') for (const entry of providers) events.get('eip6963:announceProvider')?.({ detail: entry === true ? { provider, info: { name: 'Test wallet' } } : entry }); } };
  vm.runInNewContext(source, {
    document: { querySelector: selector => nodes[selector.slice(1)] }, window, ethers,
    location: { reload() { reloads++; } }, console: { error: (...args) => errors.push(args) },
    Event: class { constructor(type) { this.type = type; } }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    async fetch(url, opts) {
      const body = opts.body ? JSON.parse(opts.body) : undefined, route = url.split('/').at(-1);
      calls.push({ route, body, opts });
      const result = auth ? await auth(route, body) : { session: { authenticated: false, wallets: [address] }, challenge: { message: 'Admin challenge' },
        verify: { authenticated: true, wallet: address } }[route];
      return { ok: !result.error, status: result.error ? 403 : 200, headers: { get: () => 'application/json' }, json: async () => result };
    },
  });
  return { nodes, rpc, calls, provider, providerEvents, errors, events,
    click: () => nodes['login-sign'].handlers.click(), get reloads() { return reloads; } };
}
test('one click connects and signs on any chain, without profile, funds or chain dependencies', async () => {
  const f = fixture({ injected: true });
  await f.click();
  assert.deepEqual(f.rpc.map(call => call.method), ['eth_requestAccounts', 'personal_sign', 'eth_accounts']);
  assert.deepEqual(f.calls.map(call => call.route), ['session', 'challenge', 'verify']);
  assert.equal(f.rpc[1].params[0], ethers.hexlify(ethers.toUtf8Bytes('Admin challenge')));
  assert.equal(f.rpc[1].params[1], address);
  assert.equal(f.reloads, 1);
  assert.equal(f.nodes['login-sign'].disabled, false);
  assert.equal(f.providerEvents.size, 0);
  assert(f.calls.every(call => call.opts.credentials === 'same-origin' && call.opts.cache === 'no-store'));
});
test('missing wallets and unauthorized accounts give actionable errors without requesting a signature', async () => {
  const absent = fixture();
  await absent.click();
  assert.match(absent.nodes['login-status'].textContent, /No Ethereum signing wallet/);
  assert.equal(absent.calls.length, 0);
  const denied = fixture({ injected: true, account: other });
  await denied.click();
  assert.match(denied.nodes['login-status'].textContent, /not an Admin wallet/);
  assert.deepEqual(denied.rpc.map(call => call.method), ['eth_requestAccounts']);
  assert.equal(denied.nodes['login-status'].role, 'alert');
});
test('EIP-6963 discovery works without window.ethereum and requires a choice for multiple wallets', async () => {
  const single = fixture({ providers: [true] });
  await single.click(); assert.equal(single.reloads, 1);
  const alternate = { request() { throw Error('Wrong provider selected'); } };
  const multiple = fixture({ providers: [true, { provider: alternate, info: { name: 'Other wallet' } }] });
  await multiple.click(); assert.equal(multiple.calls.length, 0);
  assert.equal(multiple.nodes['login-provider-field'].hidden, false);
  assert.match(multiple.nodes['login-status'].textContent, /Choose the wallet/);
  multiple.nodes['login-provider'].value = '0';
  await multiple.click(); assert.equal(multiple.reloads, 1);
});
test('account changes, rejected signatures and pending extension requests never verify or silently succeed', async () => {
  for (const code of [4001, -32002]) {
    const f = fixture({ injected: true, request: async body => {
      if (body.method === 'eth_requestAccounts') return [address];
      throw Object.assign(Error('Wallet error'), { code });
    } });
    await f.click();
    assert.equal(f.reloads, 0); assert(!f.calls.some(call => call.route === 'verify'));
    assert.match(f.nodes['login-status'].textContent, code === 4001 ? /cancelled/ : /already open/);
  }
  const changed = fixture({ injected: true, request: async body => body.method === 'eth_accounts' ? [other] : body.method === 'personal_sign' ? 'signature' : [address] });
  await changed.click();
  assert.match(changed.nodes['login-status'].textContent, /account changed/);
  assert(!changed.calls.some(call => call.route === 'verify'));
  const event = fixture({ injected: true, request: async body => {
    if (body.method === 'personal_sign') { event.providerEvents.get('accountsChanged')(); return 'signature'; }
    return [address];
  } });
  await event.click();
  assert(!event.calls.some(call => call.route === 'verify'));
});
test('double clicks are deduplicated and failed verification remains an error', async () => {
  let resolve;
  const f = fixture({ injected: true, auth: async route => {
    if (route === 'session') return new Promise(done => { resolve = () => done({ authenticated: false, wallets: [address] }); });
    if (route === 'challenge') return { message: 'Challenge' };
    return { error: 'Signature expired. Retry.' };
  } });
  const pending = f.click(); await f.click();
  assert.equal(f.calls.length, 1); assert.equal(f.nodes['login-sign'].disabled, true);
  resolve(); await pending;
  assert.equal(f.reloads, 0);
  assert.match(f.nodes['login-status'].textContent, /Signature expired/);
  assert.equal(f.nodes['login-sign'].disabled, false);
});
