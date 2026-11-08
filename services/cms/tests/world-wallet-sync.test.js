const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { ethers } = require('ethers');
const { validate } = require('../../../sites/wallet.featheral.com/site-sign-in');
const { transferMessage } = require('../../fth-ledger/transfer');
const root = path.resolve(__dirname, '../../..');
const wallet = '0x' + '11'.repeat(20), account = '0x' + 'ab'.repeat(32), csrf = 'cd'.repeat(32);
const origin = 'https://world.featheral.com';
function messages() {
  const issuedAt = new Date().toISOString();
  return {
    authorization: `Featheral World Dollar wallet session\n\nWallet: ${wallet}\nSession: ${csrf}\nIssued at: ${issuedAt}\nOrigin: ${origin}\n\nAuthorize a separate World fund for this wallet. Gameplay spends only World funds, not wallet funds. No funds move on authorization.\nNo Ethereum transaction is sent. Never share your recovery phrase or private key.`,
    withdrawal: `Featheral World fund withdrawal\n\nWorld account: ${account}\nWallet: ${wallet}\nBase units: 1000000000000000000\nRequest: withdraw-request-0001\nOrigin: ${origin}\nSession: ${csrf}\nIssued at: ${issuedAt}\n\nMove only this exact amount of existing World FTH$ to the authorized wallet. No Ethereum transaction is sent.`,
    deposit: transferMessage({ wallet, to: account, amount: ethers.parseUnits('1.23456789', 18).toString(), nonce: 1, memo: 'ef'.repeat(32), issuedAt }),
  };
}
test('native World approvals accept only separate authorization or exact current-budget transfers', () => {
  for (const message of Object.values(messages()))
    assert.doesNotThrow(() => validate(wallet, message, true, origin, account));
  const { authorization, deposit, withdrawal } = messages();
  for (const message of [authorization, deposit, withdrawal]) {
    assert.throws(() => validate(wallet, message, true, 'https://notes.featheral.com', account));
    assert.throws(() => validate('0x' + '22'.repeat(20), message, true, origin, account));
  }
  for (const message of [deposit, withdrawal]) {
    assert.throws(() => validate(wallet, message, true, origin, '0x' + '12'.repeat(32)), /budget/);
    assert.throws(() => validate(wallet, message, true, origin), /budget/);
  }
  assert.throws(() => validate(wallet, deposit.replace('Amount: 1.23456789', 'Amount: 2.0'), true, origin, account), /base units/);
  assert.throws(() => validate(wallet, authorization.replace(origin, 'https://evil.example'), true, origin, account), /origin/);
  assert.throws(() => validate(wallet, withdrawal.replace(origin, 'https://evil.example'), true, origin, account), /origin/);
  assert.throws(() => validate(wallet, authorization.replace('No funds move on authorization.', 'Move all guest funds.'), true, origin, account));
  assert.throws(() => validate(wallet, deposit.replace(`To account: ${account}`, `To: ${wallet}`), true, origin, account));
});
test('site wallet host persists only a public World account before native wallet mounting and surfaces invalid handoffs', () => {
  const source = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/wallet-host.js'), 'utf8');
  for (const [hash, expected] of [['#worldAccount=' + account, account], ['#worldAccount=invalid', null],
    ['#worldSyncError=World%20session%20required', null]]) {
    const saved = new Map(), errors = [], notices = [], scripts = [];
    const node = { dataset: {}, before: value => notices.push(value) };
    vm.runInNewContext(source, {
      URL, URLSearchParams, location: { href: origin + '/wallet/' + hash, hostname: 'world.featheral.com', protocol: 'https:', port: '' },
      document: { querySelector: () => node, createElement: () => ({ setAttribute() {} }), head: { append: script => scripts.push(script) } },
      localStorage: { setItem: (key, value) => saved.set(key, value) }, history: { replaceState() {} },
      console: { error: (...args) => errors.push(args) },
    });
    assert.equal(saved.get('featheral-world-account') || null, expected);
    assert.equal(saved.size, expected ? 1 : 0);
    assert.equal(notices.length, expected ? 0 : 1); assert.equal(errors.length, notices.length);
    assert.equal(scripts.length, 1);
  }
});
test('reader wallet panels use explicit public World accounts and preserve unavailability on ledger errors', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  const body = source.slice(source.indexOf('const readWorld = async () => {'), source.indexOf('const [native]'));
  for (const failure of [false, true]) {
    const errors = [];
    const context = vm.createContext({
      store: null, worldError: null, worldFunds: null, publicWorldAccount: account, owner: wallet, require,
      api: { walletAccount: id => { assert.equal(id, account); if (failure) throw new Error('Ledger offline'); return { balance: { available: '12345' } }; } },
      console: { error: (...args) => errors.push(args) },
    });
    // Resolve the source module's relative require without loading the serving gateway.
    context.require = name => name.endsWith('/ledger') ? require('../../fth-ledger/ledger') : require(name);
    await vm.runInContext(`${body}; readWorld();`, context);
    if (failure) { assert.equal(context.worldFunds, null); assert.equal(context.worldError, 'Ledger offline'); assert.equal(errors.length, 1); }
    else { assert.equal(context.worldFunds.available, '12345'); assert.equal(context.worldFunds.accountId, account); assert.equal(context.worldFunds.duplicate, false); assert.equal(errors.length, 0); }
  }
});

function frameHarness(hostname, response) {
  const listeners = [], replies = [], parent = { postMessage: (data, target) => replies.push({ data, target }) };
  const window = { addEventListener: (type, fn) => type === 'message' && listeners.push(fn) };
  window.parent = parent;
  const fetches = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sites/world.featheral.com/wallet-sync-frame.js'), 'utf8'), {
    window, URL, location: { hostname }, console: { error() {} },
    fetch: async (url, options) => { fetches.push({ url, options }); return response; },
  });
  const send = async (event) => { await listeners[0]({ source: parent, ...event }); };
  return { send, replies, fetches, parent };
}
const nonce = 'ab'.repeat(16);
test('World account frame answers only Featheral parents with the public account and no funds data', async () => {
  const ok = { status: 200, ok: true, json: async () => ({ accountId: account, balance: '5', csrf }) };
  const frame = frameHarness('world.featheral.com', ok);
  await frame.send({ origin: 'https://evil.example', data: { type: 'featheral:world-account-request', nonce } });
  await frame.send({ origin: 'https://wallet.featheral.com.evil.example', data: { type: 'featheral:world-account-request', nonce } });
  await frame.send({ origin: 'https://wallet.featheral.com', data: { type: 'featheral:world-account-request', nonce: 'short' } });
  await frame.send({ origin: 'https://wallet.featheral.com', source: {}, data: { type: 'featheral:world-account-request', nonce } });
  assert.equal(frame.fetches.length, 0); assert.equal(frame.replies.length, 0);
  await frame.send({ origin: 'https://wallet.featheral.com', data: { type: 'featheral:world-account-request', nonce } });
  assert.equal(frame.fetches[0].url, '/api/dollar/game/wallet/balance');
  assert.equal(frame.fetches[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(JSON.stringify(frame.replies)), [{ data: { type: 'featheral:world-account', nonce, accountId: account }, target: 'https://wallet.featheral.com' }]);

  const signedOut = frameHarness('world.featheral.com', { status: 401, ok: false, json: async () => ({ error: 'Sign in' }) });
  await signedOut.send({ origin: 'https://featheral.com', data: { type: 'featheral:world-account-request', nonce } });
  assert.deepEqual({ ...signedOut.replies[0].data }, { type: 'featheral:world-account', nonce, accountId: null, signedOut: true });

  const invalid = frameHarness('world.featheral.com', { status: 200, ok: true, json: async () => ({ accountId: 'bad' }) });
  await invalid.send({ origin: 'https://notes.featheral.com', data: { type: 'featheral:world-account-request', nonce } });
  assert.match(invalid.replies[0].data.error, /invalid account/);

  const foreign = frameHarness('world.example.com', ok);
  await foreign.send({ origin: 'https://wallet.featheral.com', data: { type: 'featheral:world-account-request', nonce } });
  assert.equal(foreign.fetches.length, 0); assert.match(foreign.replies[0].data.error, /canonical/);
});
test('World account frame is routed as a World file and framable only by Featheral origins', () => {
  const { worldResource } = require('../../../scripts/site-routing');
  for (const file of ['/wallet-sync-frame.html', '/wallet-sync-frame.js'])
    assert.deepEqual(worldResource('world', file), { directory: 'world.featheral.com', pathname: file });
  const serve = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  assert.match(serve, /p === "\/wallet-sync-frame\.html"[\s\S]{0,200}frame-ancestors[\s\S]{0,120}https:\/\/featheral\.com https:\/\/\*\.featheral\.com/);
  const html = fs.readFileSync(path.join(root, 'sites/world.featheral.com/wallet-sync-frame.html'), 'utf8');
  assert.match(html, /src="\/wallet-sync-frame\.js"/); assert.match(html, /noindex/);
});
test('wallet discovers the World account through a nonce-bound hidden World frame and ignores spoofed replies', () => {
  const source = fs.readFileSync(path.join(root, 'sites/wallet.featheral.com/wallet-app.js'), 'utf8');
  const body = source.slice(source.indexOf('  function discoverWorldAccount('), source.indexOf('  function syncWorldAccount('));
  let messageListener = null, appended = null, loadListener = null, removed = false;
  const posts = [], saved = new Map();
  const contentWindow = { postMessage: (data, target) => posts.push({ data, target }) };
  const frame = {
    contentWindow, setAttribute() {}, remove: () => { removed = true; },
    addEventListener: (type, fn) => { if (type === 'load') loadListener = fn; },
  };
  const context = vm.createContext({
    worldOrigin: 'https://world.featheral.com', worldAccount: null, worldSyncState: 'pending',
    worldDiscovery: null, worldDiscoveredAt: 0, cleanup: [], crypto: globalThis.crypto, Uint8Array, Date, Promise, console, setTimeout, clearTimeout,
    storage: { setItem: (key, value) => saved.set(key, value) },
    window: { addEventListener: (type, fn) => { messageListener = fn; }, removeEventListener() {} },
    nativeDocument: { body: { append: node => { appended = node; } }, createElement: () => frame },
  });
  vm.runInContext(body + '; globalThis.discover = discoverWorldAccount;', context);
  const result = context.discover(true);
  assert.equal(appended, frame); assert.equal(frame.src, 'https://world.featheral.com/wallet-sync-frame.html');
  loadListener();
  const request = posts[0];
  assert.equal(request.target, 'https://world.featheral.com');
  assert.match(request.data.nonce, /^[0-9a-f]{32}$/);
  const reply = { type: 'featheral:world-account', nonce: request.data.nonce, accountId: account };
  messageListener({ origin: 'https://evil.example', source: contentWindow, data: reply });
  messageListener({ origin: 'https://world.featheral.com', source: {}, data: reply });
  messageListener({ origin: 'https://world.featheral.com', source: contentWindow, data: { ...reply, nonce: 'cd'.repeat(16) } });
  assert.equal(context.worldAccount, null); assert.equal(removed, false);
  messageListener({ origin: 'https://world.featheral.com', source: contentWindow, data: reply });
  return result.then(changed => {
    assert.equal(changed, true); assert.equal(removed, true);
    assert.equal(vm.runInContext('worldAccount', context), account);
    assert.equal(vm.runInContext('worldSyncState', context), 'linked');
    assert.equal(saved.get('featheral-world-account'), account);
  });
});
