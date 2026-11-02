const { test } = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('ethers');
const { Vault } = require('../../../sites/wallet.featheral.com/vault')(ethers);
const { combine } = require('../../../sites/wallet.featheral.com/portfolio-view');
const { portfolio } = require('../../notes-api/portfolio');
const unit = 10n ** 18n;
function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}
async function backup(wallet, password = 'correct test password') {
  return { version: 1, links: [], keystore: await ethers.encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password,
    { scrypt: { N: 1024, r: 8, p: 1 } }) };
}
test('built-in wallet restores encrypted backups, signs the owner challenge and locks without persisting keys', async () => {
  const wallet = ethers.Wallet.createRandom(), store = storage(), vault = new Vault(store);
  const record = await backup(wallet);
  assert.equal(await vault.restore(record, 'correct test password'), wallet.address);
  const persisted = [...store.data.values()].join('');
  assert.ok(!persisted.includes(wallet.privateKey.slice(2)));
  assert.ok(!persisted.includes('correct test password'));
  assert.equal(ethers.verifyMessage('login challenge', await vault.sign('login challenge', wallet.address)), wallet.address);
  await assert.rejects(vault.sign('wrong owner', ethers.Wallet.createRandom().address), /Unlock/);
  vault.lock();
  await assert.rejects(vault.sign('locked', wallet.address), /Unlock/);
  await assert.rejects(vault.unlock('incorrect password'), /password/);
  assert.equal(vault.signer, null);
  await vault.unlock('correct test password');
  assert.equal(vault.signer.address, wallet.address);
  await assert.rejects(vault.restore(record, 'correct test password'), /already exists/);
  assert.deepEqual(JSON.parse(vault.backup()), record);
});
test('creation requires a strong password and retains nothing before the backup is activated', async () => {
  const store = storage();
  let generated = false;
  const { Vault: TestVault } = require('../../../sites/wallet.featheral.com/vault')({
    Wallet: { createRandom: () => { generated = true; return { encrypt: async password => `encrypted:${password.length}` }; } },
  });
  const vault = new TestVault(store);
  await assert.rejects(vault.prepare('short'), /12/);
  assert.equal(generated, false);
  assert.deepEqual(await vault.prepare('a long test password'), { version: 1, keystore: 'encrypted:20', links: [] });
  assert.equal(store.data.size, 0);
  assert.equal(vault.signer, null);
});
test('external linking requires both signatures, rejects tampered proofs and moves no funds', async () => {
  const local = ethers.Wallet.createRandom(), external = ethers.Wallet.createRandom(), store = storage(), vault = new Vault(store);
  await vault.restore(await backup(local), 'correct test password');
  const methods = [];
  const provider = { async request({ method, params }) {
    methods.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [external.address];
    if (method === 'personal_sign') return external.signMessage(ethers.getBytes(params[0]));
    throw new Error('Unexpected method: ' + method);
  } };
  assert.equal(await vault.link(provider), external.address);
  assert.deepEqual(methods, ['eth_requestAccounts', 'personal_sign', 'eth_accounts']);
  assert.equal(vault.verifiedLinks()[0].address, external.address);
  assert.equal(vault.signer.address, local.address);
  const record = JSON.parse(vault.backup());
  record.links[0].address = ethers.Wallet.createRandom().address;
  const target = new Vault(storage());
  await assert.rejects(target.restore(record, 'correct test password'), /proof is invalid/);
  assert.equal(target.read(), null);
  await assert.rejects(vault.link(provider), /proof is invalid/);
  assert.equal(vault.verifiedLinks().length, 1);
});
test('rejected or changed external-wallet signatures never save a link', async () => {
  const wallet = ethers.Wallet.createRandom(), store = storage(), vault = new Vault(store);
  await vault.restore(await backup(wallet), 'correct test password');
  const external = ethers.Wallet.createRandom();
  await assert.rejects(vault.link({ request: async ({ method }) => {
    if (method === 'eth_requestAccounts') return [external.address];
    throw new Error('User rejected signature');
  } }), /rejected/);
  assert.equal(vault.verifiedLinks().length, 0);
  await assert.rejects(vault.link({ request: async ({ method, params }) => method === 'eth_requestAccounts' ? [external.address]
    : method === 'personal_sign' ? external.signMessage(ethers.getBytes(params[0])) : [wallet.address] }), /changed/);
  assert.equal(vault.verifiedLinks().length, 0);
});
test('locking invalidates in-flight local signatures and unknown backup metadata never persists', async () => {
  const local = ethers.Wallet.createRandom(), store = storage(), vault = new Vault(store);
  const record = await backup(local);
  await vault.restore({ ...record, privateKey: local.privateKey, password: 'must not persist' }, 'correct test password');
  assert.ok(![...store.data.values()].join('').includes(local.privateKey));
  assert.ok(![...store.data.values()].join('').includes('must not persist'));
  let finish;
  vault.signer.signMessage = () => new Promise(resolve => { finish = resolve; });
  const signing = vault.sign('pending approval', local.address);
  vault.lock(); finish('discarded signature');
  await assert.rejects(signing, /locked while signing/);
  const unlocking = vault.unlock('correct test password');
  vault.lock();
  await assert.rejects(unlocking, /locked during unlock/);
  assert.equal(vault.signer, null);
  const target = new Vault(storage()), restoring = target.restore(record, 'correct test password');
  target.lock();
  await assert.rejects(restoring, /locked during recovery/);
  assert.equal(target.read(), null);
});
test('linked portfolio deduplicates owners and shared World accounts while retaining separate spendable balances', () => {
  const gold = { chain: { id: 1, tokenAddress: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665' }, checkedAt: new Date().toISOString(), bridge: { configured: true, deployed: true, initialized: true, paused: false,
    reserveFthg: String(unit), reserveFthDollar: String(10n * unit), actualFthgBalance: String(unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const pool = { funded: true, dollars: String(100n * unit), fthx: 1000 };
  const make = address => ({ address, world: { accountId: 'shared-world', available: String(20n * unit) },
    portfolio: portfolio([{ symbol: 'FTH$', balance: String(10n * unit) }], pool, [], gold,
      { world: { accountId: 'shared-world', available: String(20n * unit) } }) });
  const first = make('0x1111111111111111111111111111111111111111'), second = make('0x2222222222222222222222222222222222222222');
  const result = combine([first, second, first]);
  assert.equal(result.totals['FTH$'].value, String(40n * unit));
  assert.equal(result.totals.FTHG.value, String(4n * unit));
  assert.equal(result.usd, '8.00');
  assert.equal(result.pricedFthDollar, String(40n * unit));
  assert.equal(first.portfolio.totals['FTH$'].value, String(30n * unit));
  assert.match(result.source, /funds remain separate/);
  first.world = { accountId: '0x000000000000000000000000' + first.address.slice(2), available: String(10n * unit), duplicate: true };
  first.portfolio = portfolio([{ symbol: 'FTH$', balance: String(10n * unit) }], pool, [], gold, { world: first.world });
  second.world = { ...first.world, duplicate: false };
  second.portfolio = portfolio([{ symbol: 'FTH$', balance: String(10n * unit) }], pool, [], gold, { world: second.world });
  assert.equal(combine([first, second]).totals['FTH$'].value, String(20n * unit));
});
