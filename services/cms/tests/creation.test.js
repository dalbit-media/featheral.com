const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { Notes } = require('../../notes-api/ledger');
const { Creation, SITE_COST } = require('../../notes-api/creation');
const { SiteManager } = require('../lib/sites');
const { createDollarApi } = require('../../notes-api/dollar');
const { SYSTEM_TREASURY_ACCOUNT } = require('../../dollar-api/funds');
const { walletAccountId } = require('../../fth-ledger/transfer');

function fixture(t, mode = 'writer') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-creation-'));
  const notes = new Notes(path.join(root, 'notes.sqlite'));
  const manager = new SiteManager({ dataDir: path.join(root, 'sites') });
  const service = new Creation(notes, manager);
  const api = createDollarApi({ env: { FTH_LEDGER_MODE: mode, FTH_LEDGER_DIR: path.join(root, 'dollar'), FTH_LEDGER_BLOCK_INTERVAL_MS: '0' } });
  service.payment = api.creationPayments;
  service.dollarSupply = api.noteSupply;
  const wallet = ethers.Wallet.createRandom(), owner = wallet.address.toLowerCase();
  t.after(() => { api.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, notes, manager, api, wallet, owner };
}

test('wallet authentication, exact FTHX note fees, reserved symbols and atomic retries', async t => {
  const { service, notes, wallet, owner } = fixture(t);
  const challenge = service.challenge(wallet.address);
  assert.throws(() => service.login(wallet.address, '0x00'), /Invalid wallet/);
  const login = service.login(wallet.address, await wallet.signMessage(challenge.message));
  assert.equal(service.owner(login.token), owner);
  assert.throws(() => service.owner('fake'), /Connect/);
  assert.throws(() => service.login(wallet.address, '0x00'), /expired/);
  assert.throws(() => service.createNote(owner, { symbol: 'ART', name: 'Art rewards' }), /1,000 FTHX/);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,2000,'fixture',0,'test')").run(owner);
  const created = service.createNote(owner, { symbol: 'ART', name: 'Art rewards' });
  assert.equal(created.owner, owner);
  assert.equal(notes.balance(owner), 1000);
  assert.equal(notes.balance(SYSTEM_TREASURY_ACCOUNT), 1000);
  service.createNote(owner, { symbol: 'ART', name: 'Art rewards' });
  assert.equal(notes.balance(owner), 1000);
  assert.throws(() => service.createNote(owner, { symbol: 'FTHX', name: 'Fake' }), /reserved/);
  assert.throws(() => service.createNote(ethers.Wallet.createRandom().address.toLowerCase(), { symbol: 'ART', name: 'Art rewards' }), /already exists/);
  assert.ok(service.trending().some(note => note.symbol === 'FTH$'));
  assert.ok(service.trending().some(note => note.symbol === 'FTHX'));
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES (?,1,'reaction_in',?,'test','ART')").run(owner, Date.now());
  assert.equal(service.trending().find(note => note.symbol === 'ART').awarded, 1);
  notes.db.exec("CREATE TRIGGER fail_note_insert BEFORE INSERT ON note_currencies WHEN NEW.symbol='FAIL' BEGIN SELECT RAISE(ABORT,'fixture write failed'); END");
  assert.throws(() => service.createNote(owner, { symbol: 'FAIL', name: 'Failure' }), /fixture write failed/);
  assert.equal(notes.balance(owner), 1000);
  assert.equal(notes.balance(SYSTEM_TREASURY_ACCOUNT), 1000);
});

test('public mint requires a new site, binds retries and rolls back fees if site reservation fails', async t => {
  const { service, notes, api, owner, wallet } = fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,2000,'fixture',0,'test')").run(owner);
  assert.throws(() => service.mintNote(owner, { symbol: 'ART', name: 'Art' }), /requires a new website/);
  const input = { symbol: 'ART', name: 'Art', site: { slug: 'my-art', name: 'My Art' } };
  assert.throws(() => service.mintNote(owner, input), /500 FTH/);
  assert.equal(notes.balance(owner), 2000);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM note_currencies").get().n, 0);
  await api.ledger.submit({ id: 'mint-funds', kind: 'CREDIT', account: walletAccountId(owner), amount: SITE_COST, data: { src: 'FthgConverted', tx: `0x${'ac'.repeat(32)}` } });
  const minted = service.mintNote(owner, input);
  assert.equal(notes.balance(owner), 1000);
  assert.equal(minted.request.noteSymbol, 'ART');
  assert.equal(service.mintNote(owner, input).request.id, minted.request.id);
  assert.throws(() => service.mintNote(owner, { ...input, site: { slug: 'other', name: 'Other' } }), /original website request/);
  assert.equal(notes.balance(owner), 1000);
  const site = await service.completeSite(owner, minted.request.id, await wallet.signMessage(minted.request.message));
  assert.equal(service.mintNote(owner, input).request.status, 'complete');
  assert.equal(service.account(owner).integrations[0].site, site.key);
  assert.equal(service.markets.pool('ART').base, 0, 'mint never auto-funds a pool');
});

test('site creation requires real 500 FTH$, signed treasury transfer and wallet ownership', async t => {
  const { service, notes, manager, api, wallet, owner } = fixture(t);
  const input = { slug: 'my-art', name: 'My art' };
  assert.throws(() => service.prepareSite(owner, input), /500 FTH/);
  await api.ledger.submit({ id: 'fixture-funds', kind: 'CREDIT', account: walletAccountId(owner), amount: ethers.parseUnits('1000', 18).toString(), data: { src: 'FthgConverted', tx: `0x${'aa'.repeat(32)}` } });
  const prepared = service.prepareSite(owner, input);
  assert.equal(prepared.payment.amount, SITE_COST);
  assert.equal(prepared.payment.to, SYSTEM_TREASURY_ACCOUNT);
  assert.equal(manager.records.length, 0);
  const other = ethers.Wallet.createRandom();
  await assert.rejects(service.completeSite(other.address.toLowerCase(), prepared.id, await other.signMessage(prepared.message)), /not found/);
  await assert.rejects(service.completeSite(owner, prepared.id, await other.signMessage(prepared.message)), /signature/);
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, ethers.parseUnits('1000', 18).toString());
  const signature = await wallet.signMessage(prepared.message);
  const created = await service.completeSite(owner, prepared.id, signature);
  assert.equal(created.path, '/my-art');
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, ethers.parseUnits('500', 18).toString());
  assert.equal(api.ledger.balance(SYSTEM_TREASURY_ACCOUNT).available, SITE_COST);
  assert.equal(notes.balance(owner), 0);
  assert.equal(service.requireSite(owner, created.key).key, created.key);
  assert.throws(() => service.requireSite(other.address.toLowerCase(), created.key), /only your own/);
  assert.equal((await service.completeSite(owner, prepared.id, signature)).key, created.key);
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, SITE_COST);
  assert.equal(service.account(owner).sites.length, 1);
});

test('native circulation uses all authoritative ledger units and never reward activity', async t => {
  const { service, notes, api, owner } = fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,697,'fixture',0,'one')").run(owner);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,-100,'transfer',0,'two')").run(owner);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,100,'transfer',0,'two')").run(SYSTEM_TREASURY_ACCOUNT);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES (?,99,'reaction_in',?,'one','ART')").run(owner, Date.now());
  const raw = '9007199254740993123456789012345678';
  await api.ledger.submit({ id: 'supply-fixture', kind: 'CREDIT', account: walletAccountId(owner), amount: raw,
    data: { src: 'FthgConverted', tx: `0x${'de'.repeat(32)}` } });
  const native = service.trending().filter(note => note.native);
  const dollar = native.find(note => note.symbol === 'FTH$'), fthx = native.find(note => note.symbol === 'FTHX');
  assert.equal(dollar.circulating, api.ledger.summary().circulating);
  assert.equal(dollar.supply, raw);
  assert.equal(dollar.decimals, 18);
  assert.equal(fthx.circulating, '697');
  assert.equal(fthx.decimals, 0);
  assert.equal(fthx.name, 'Featheral Exchange Token');
  assert.ok(native.every(note => note.rewards === 0 && note.awarded === 0));
  const reservation = `0x${'df'.repeat(32)}`;
  await api.ledger.submit({ id: 'reserve-fixture', kind: 'RESERVE', account: walletAccountId(owner), amount: SITE_COST,
    data: { r: reservation, to: ethers.getAddress(owner), exp: Date.now() + 60000 } });
  const reserved = service.trending().find(note => note.symbol === 'FTH$');
  assert.equal(reserved.supply, raw);
  assert.equal(reserved.reserved, SITE_COST);
  assert.equal(reserved.circulating, (BigInt(raw) - BigInt(SITE_COST)).toString());
  service.dollarSupply = null;
  assert.equal(service.trending().find(note => note.symbol === 'FTH$').circulating, null);
  service.payment = null;
  service.dollarSupply = api.noteSupply;
  assert.equal(service.trending().find(note => note.symbol === 'FTH$').circulating, reserved.circulating);
});

test('native Dollar circulation remains readable without payment-writer permissions', t => {
  const { service, api } = fixture(t, 'unconfigured');
  assert.equal(api.creationPayments, null);
  assert.equal(service.trending().find(note => note.symbol === 'FTH$').circulating, api.ledger.summary().circulating);
});

test('paid provisioning failures recover after restart without charging twice', async t => {
  const { service, notes, manager, api, wallet, owner } = fixture(t);
  await api.ledger.submit({ id: 'fixture-funds', kind: 'CREDIT', account: walletAccountId(owner), amount: SITE_COST, data: { src: 'FthgConverted', tx: `0x${'ab'.repeat(32)}` } });
  const prepared = service.prepareSite(owner, { slug: 'recover-art', name: 'Recover Art' });
  const signature = await wallet.signMessage(prepared.message);
  const create = manager.create.bind(manager);
  manager.create = () => { throw new Error('disk unavailable'); };
  await assert.rejects(service.completeSite(owner, prepared.id, signature), /disk unavailable/);
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, '0');
  manager.create = create;
  const restarted = new Creation(notes, manager); restarted.payment = api.creationPayments;
  const website = await restarted.completeSite(owner, prepared.id, signature);
  assert.equal(website.path, '/recover-art');
  assert.equal(api.ledger.balance(SYSTEM_TREASURY_ACCOUNT).available, SITE_COST);
  assert.equal(restarted.account(owner).requests.length, 0);
});

test('integrated site creation retains the note on failure, recovers the link and keeps rewards off', async t => {
  const { service, notes, manager, api, wallet, owner } = fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,2000,'fixture',0,'test')").run(owner);
  service.createNote(owner, { symbol: 'ART', name: 'Art' });
  assert.equal(notes.balance(owner), 1000);
  assert.throws(() => service.createNote(owner, { symbol: 'BAD', name: 'Bad', siteKey: false }), /website key/);
  assert.throws(() => service.createNote(owner, { symbol: 'BAD', name: 'Bad', siteKey: [] }), /website key/);
  await api.ledger.submit({ id: 'combined-funds', kind: 'CREDIT', account: walletAccountId(owner), amount: SITE_COST,
    data: { src: 'FthgConverted', tx: `0x${'bc'.repeat(32)}` } });
  assert.throws(() => service.prepareSite(owner, { slug: 'integrated', name: 'Integrated', noteSymbol: 'FTHX' }), /owned/);
  const request = service.prepareSite(owner, { slug: 'integrated', name: 'Integrated', noteSymbol: 'ART' });
  assert.equal(request.noteSymbol, 'ART');
  assert.throws(() => service.prepareSite(owner, { slug: 'integrated', name: 'Integrated' }), /reserved/);
  assert.throws(() => service.prepareSite(owner, { slug: 'invalid-note', name: 'Invalid', noteSymbol: false }), /owned/);
  const original = manager.create.bind(manager);
  manager.create = () => { throw new Error('site disk failed'); };
  const signature = await wallet.signMessage(request.message);
  await assert.rejects(service.completeSite(owner, request.id, signature), /site disk failed/);
  assert.equal(notes.db.prepare("SELECT owner FROM note_currencies WHERE symbol='ART'").get().owner, owner);
  service.createNote(owner, { symbol: 'ART', name: 'Art' });
  assert.equal(notes.balance(owner), 1000);
  manager.create = original;
  const site = await service.completeSite(owner, request.id, signature);
  await service.completeSite(owner, request.id, signature);
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, '0');
  assert.equal(api.ledger.balance(SYSTEM_TREASURY_ACCOUNT).available, SITE_COST);
  assert.equal(service.account(owner).integrations[0].symbol, 'ART');
  assert.equal(notes.program(site.key).enabled, 0);
  assert.equal(notes.program(site.key).symbol, 'ART');
  notes.setProgram(site.key, { symbol: 'ART', chance: 10, amount: 1, enabled: true });
  service.integrate(owner, site.key, 'ART');
  assert.equal(notes.program(site.key).enabled, 1, 'identical link retry preserves owner-enabled rewards');
  const other = ethers.Wallet.createRandom().address.toLowerCase();
  assert.throws(() => service.integrate(other, site.key, 'ART'), /own websites/);
  assert.throws(() => service.createNote(owner, { symbol: 'OTHER', name: 'Other', siteKey: 'missing' }), /own websites/);
  assert.equal(notes.balance(owner), 1000, 'invalid integration rolls back note creation fee');
  service.createNote(owner, { symbol: 'OTHER', name: 'Other', siteKey: site.key });
  assert.equal(notes.balance(owner), 0);
  assert.equal(notes.program(site.key).symbol, 'OTHER');
  assert.equal(notes.program(site.key).enabled, 0);
});

test('conflicting Dollar nonce gets a new payment without permitting the old signature to charge', async t => {
  const { service, api, wallet, owner } = fixture(t);
  await api.ledger.submit({ id: 'fixture-funds', kind: 'CREDIT', account: walletAccountId(owner), amount: ethers.parseUnits('1000', 18).toString(),
    data: { src: 'FthgConverted', tx: `0x${'ac'.repeat(32)}` } });
  const input = { slug: 'nonce-art', name: 'Nonce Art' };
  const original = service.prepareSite(owner, input);
  const otherPayment = { ...original.payment, amount: ethers.parseUnits('1', 18).toString(), memo: 'Other authorized transfer' };
  const { transferMessage } = require('../../fth-ledger/transfer');
  await api.creationPayments.submit({ ...otherPayment, signature: await wallet.signMessage(transferMessage(otherPayment)) });
  const updated = service.prepareSite(owner, input);
  assert.equal(updated.id, original.id);
  assert.equal(updated.payment.nonce, original.payment.nonce + 1);
  await assert.rejects(service.completeSite(owner, original.id, await wallet.signMessage(original.message)), /signature/);
  await service.completeSite(owner, updated.id, await wallet.signMessage(updated.message));
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, ethers.parseUnits('499', 18).toString());
  assert.equal(api.ledger.balance(SYSTEM_TREASURY_ACCOUNT).available, ethers.parseUnits('501', 18).toString());
});

test('Sites seed upgrade changes only untouched content and preserves edited metadata', t => {
  const { manager } = fixture(t);
  const site = manager.create({ hostname: 'sites.featheral.com', template: 'sites' });
  const CmsStore = require('../lib/cms'), Templates = require('../lib/templates');
  const cms = new CmsStore(path.join(site.localDir, 'cms.sqlite'));
  try {
    const home = cms.list()[0];
    const original = 'Featheral Sites is the home for free websites.\n\nEach website has its own address at sites.featheral.com/site-name, editable pages and theme.\n\nWebsites are currently created and managed by the administrator. Public self-service registration is not enabled.';
    cms.save({ ...home, body: original, excerpt: 'My custom description' }, home.id);
    Templates.upgradeSitesCreation(cms);
    assert.equal(cms.get(home.id).body, Templates.TEMPLATES.sites.body);
    assert.equal(cms.get(home.id).excerpt, 'My custom description');
    const changed = cms.get(home.id);
    cms.save({ ...changed, body: 'My edited home' }, home.id);
    Templates.upgradeSitesCreation(cms);
    assert.equal(cms.get(home.id).body, 'My edited home');
  } finally { cms.close(); }
});
