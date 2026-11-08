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
    test('World transfer form shares its public budget, fills exact Max and retries the same prepared request', async () => {
      const source = fs.readFileSync(path.join(root, 'sites/world.featheral.com/world-funds.js'), 'utf8');
      const html = fs.readFileSync(path.join(root, 'sites/world.featheral.com/world-funds.html'), 'utf8');
      const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) =>
        [id, { value: '', children: [], textContent: '', addEventListener() {}, append(value) { this.children.push(value); },
          replaceChildren() { this.children = []; } }]));
      nodes.direction.value = 'deposit'; nodes.amount.value = '1.23456789';
      const saved = new Map(), posts = [], signed = [], errors = [], dispatched = [];
      let currentRequest, failed = false;
      const view = { csrf, accountId: account, wallet, mode: 'separate', available: '3000000000000000000',
        walletAvailable: '1234567890000000000', requests: [] };
      const tick = () => new Promise(setImmediate);
      vm.runInNewContext(source, {
        URL, URLSearchParams, BigInt, crypto: { randomUUID: () => 'transfer-request-0001' },
        location: { hostname: 'world.featheral.com', protocol: 'https:', port: '', assign() {} },
        document: { getElementById: id => nodes[id], createElement: () => ({}) },
        localStorage: { setItem: (key, value) => saved.set(key, value) },
        window: { addEventListener() {}, dispatchEvent: event => dispatched.push(event) },
        Event: class { constructor(type) { this.type = type; } },
        CustomEvent: class { constructor(type, input) { this.type = type; this.detail = input.detail; } },
        setInterval() {}, confirm: () => true, console: { error: (...args) => errors.push(args) },
        FeatheralWallet: { authenticate: async challenge => {
          const { message } = await challenge(wallet);
          validate(wallet, message, true, origin, account); signed.push(message);
          return { address: wallet, signature: 'fixture-signature' };
        } },
        fetch: async (url, options) => {
          const body = options.body && JSON.parse(options.body);
          let data = view, ok = true;
          if (body) posts.push({ url, body });
          if (url.endsWith('/prepare')) {
            currentRequest ||= { id: body.id, parameters: { direction: body.direction, amount: body.amount },
              status: 'prepared', message: messages().deposit };
            data = currentRequest;
          } else if (url.endsWith('/complete') && !failed) { failed = true; ok = false; data = { error: 'Receipt unavailable. Retry.' }; }
          return { ok, status: ok ? 200 : 503, json: async () => data };
        },
      });
      await tick();
      assert.equal(saved.get('featheral-world-account'), account);
      assert.equal(dispatched[0].type, 'featheral:world-account');
      nodes.max.onclick();
      assert.equal(nodes.amount.value, '1.23456789');
      await nodes['fund-form'].onsubmit({ preventDefault() {} });
      assert.match(nodes.status.textContent, /Receipt unavailable/);
      await nodes['fund-form'].onsubmit({ preventDefault() {} });
      const completions = posts.filter(post => post.url.endsWith('/complete'));
      assert.equal(completions.length, 2);
      assert.equal(completions[0].body.id, completions[1].body.id);
      assert.deepEqual(signed, [currentRequest.message, currentRequest.message]);
      assert.equal(saved.get('featheral-wallet-updated') !== undefined, true);
      assert.match(nodes.status.textContent, /Transfer settled/);
      nodes.direction.value = 'withdraw'; nodes.max.onclick();
      assert.equal(nodes.amount.value, '3');
      assert.equal(errors.length, 1);
    });
    // Resolve the source module's relative require without loading the serving gateway.
    context.require = name => name.endsWith('/ledger') ? require('../../fth-ledger/ledger') : require(name);
    await vm.runInContext(`${body}; readWorld();`, context);
    if (failure) { assert.equal(context.worldFunds, null); assert.equal(context.worldError, 'Ledger offline'); assert.equal(errors.length, 1); }
    else { assert.equal(context.worldFunds.available, '12345'); assert.equal(context.worldFunds.accountId, account); assert.equal(context.worldFunds.duplicate, false); assert.equal(errors.length, 0); }
  }
});
