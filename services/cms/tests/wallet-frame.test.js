const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/wallet-app.js'), 'utf8');

function fixture() {
  const parent = {}, messages = [], listeners = {}, timers = new Set(), nodes = new Map();
  let themeApplied = false, injectedCalls = 0;
  parent.postMessage = (data, origin) => messages.push({ data, origin, themeApplied });
  const window = { parent, addEventListener: (name, fn) => { listeners[name] = fn; } };
  Object.defineProperty(window, 'ethereum', { get: () => ({ request() { injectedCalls++; throw new Error('Frame provider must not be used'); } }) });
  const context = vm.createContext({
    window, config: { parentOrigin: 'https://x.featheral.com' }, interactive: true, browserProvider: null,
    builtInActive: false, token: '', publicAddress: () => '0x' + '11'.repeat(20), connectionLabel() {},
    storage: { setItem() {}, removeItem() {} }, ACTIVE_ACCOUNT: 'active', reset() {}, refresh: async () => {},
    status() {}, crypto: { randomUUID: () => 'request-id' }, applyTheme() { themeApplied = true; },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    $: id => { if (!nodes.has(id)) nodes.set(id, { addEventListener() {} }); return nodes.get(id); },
  });
  vm.runInContext(source.slice(source.indexOf('    const providerRequests ='), source.indexOf('    $("site-approve").addEventListener')), context);
  return { context, parent, messages, timers, get injectedCalls() { return injectedCalls; },
    receive(data, origin = 'https://x.featheral.com', eventSource = parent) { listeners.message({ origin, source: eventSource, data }); } };
}
test('embedded wallet always uses the parent bridge even when a read-only injected provider exists in the frame', async () => {
  const f = fixture();
  f.receive({ type: 'featheral:wallet-provider-status', available: true }, 'https://evil.example');
  assert.equal(f.context.browserProvider, null);
  f.receive({ type: 'featheral:wallet-provider-status', available: true });
  const pending = f.context.browserProvider.request({ method: 'eth_requestAccounts' });
  assert.equal(f.messages.at(-1).data.type, 'featheral:wallet-provider');
  const id = f.messages.at(-1).data.id;
  f.receive({ type: 'featheral:wallet-provider-result', id, result: ['wrong'] }, 'https://evil.example');
  assert.equal(f.timers.size, 1);
  f.receive({ type: 'featheral:wallet-provider-result', id, result: ['correct'] });
  assert.deepEqual(await pending, ['correct']);
  assert.equal(f.timers.size, 0);
  assert.equal(f.injectedCalls, 0);
  await assert.rejects(f.context.browserProvider.request({ method: 'eth_sendTransaction' }), /Unsupported/);
  const denied = f.context.browserProvider.request({ method: 'personal_sign', params: ['0x1234', '0x' + '11'.repeat(20)] });
  f.receive({ type: 'featheral:wallet-provider-result', id, error: 'Rejected', code: 4001 });
  await assert.rejects(denied, { message: 'Rejected', code: 4001 });
});
test('embedded renderer acknowledges the theme only after applying it and provider timeouts fail explicitly', async () => {
  const f = fixture();
  f.receive({ type: 'featheral:wallet-theme', theme: {} }, 'https://x.featheral.com', {});
  assert.equal(f.messages.length, 0);
  f.receive({ type: 'featheral:wallet-theme', theme: { panel: '#ffffff' } });
  assert.equal(f.messages.at(-1).data.type, 'featheral:wallet-themed');
  assert.equal(f.messages.at(-1).themeApplied, true);
  assert.equal(f.messages.at(-1).origin, 'https://x.featheral.com');
  f.receive({ type: 'featheral:wallet-provider-status', available: true });
  const pending = f.context.browserProvider.request({ method: 'eth_accounts' });
  [...f.timers][0]();
  await assert.rejects(pending, /request expired/);
  f.receive({ type: 'featheral:wallet-provider-status', available: false });
  assert.equal(f.context.browserProvider, null);
});
