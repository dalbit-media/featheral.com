const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/context.js'), 'utf8');
const address = '0x1111111111111111111111111111111111111111', linked = '0x2222222222222222222222222222222222222222';
function run({ origin = 'https://notes.featheral.com', nonce = 'ab'.repeat(16), embedded = false, invalidProof = false } = {}) {
  const messages = [], errors = [], status = {};
  let closed = false;
  const window = { opener: { postMessage: (message, target) => messages.push({ message, target }) }, close() { closed = true; } };
  window.parent = embedded ? {} : window;
  const records = new Map([['featheral-wallet-active-account', linked], ['featheral-world-account', '0x' + 'ab'.repeat(32)]]);
  vm.runInNewContext(source, {
    window, URL, URLSearchParams, location: { search: '?' + new URLSearchParams({ origin, nonce }) },
    document: { getElementById: () => status }, console: { error: (...args) => errors.push(args) },
    localStorage: { getItem: key => records.get(key) || null },
    FeatheralVault: { Vault: class {
      read() { return { address, keystore: 'encrypted-private-backup-not-for-parent', links: [{ address: linked, localSignature: 'not-for-parent' }] }; }
      verifiedLinks() { if (invalidProof) throw new Error('Invalid linked wallet proof.'); return [{ address: linked }]; }
      unlock() { throw new Error('Public handoff must never unlock'); }
    } },
  });
  return { messages, errors, closed, status };
}
test('partition-safe handoff shares only selected public accounts with the exact requesting origin and nonce', () => {
  const result = run();
  assert.equal(result.closed, true); assert.deepEqual(result.errors, []);
  const { message, target } = result.messages[0];
  assert.equal(target, 'https://notes.featheral.com');
  assert.equal(message.type, 'featheral:wallet-context'); assert.equal(message.nonce, 'ab'.repeat(16));
  assert.equal(message.context.address, linked);
  assert.deepEqual(Array.from(message.context.addresses), [address, linked]);
  assert.deepEqual(Object.keys(message.context).sort(), ['address', 'addresses', 'worldAccount']);
  assert.doesNotMatch(JSON.stringify(message), /keystore|Signature|private|password|token/);
});
test('public wallet handoff rejects unsupported origins, nonces, embedded invocation and invalid linking proofs', () => {
  for (const options of [{ origin: 'https://evil.example' }, { origin: 'https://notes.featheral.com/path' },
    { origin: 'https://notes.featheral.com.evil.example' }, { nonce: 'invalid' }, { embedded: true }, { invalidProof: true }]) {
    const result = run(options);
    assert.equal(result.messages.length, 0); assert.equal(result.closed, false);
    assert.equal(result.errors.length, 1); assert.ok(result.status.textContent);
  }
});
