const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Notes } = require('../../notes/ledger');
const { PublicSite } = require('../lib/public');

test('Notes merges legacy balances exactly once and refuses changed legacy writers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-migration-'));
  const notesFile = path.join(root, 'notes.sqlite');
  const pubs = [];
  const site = key => {
    const dir = path.join(root, key); fs.mkdirSync(dir);
    return { key, dir, manifest: {}, memo: {}, options: () => ({}), has: () => false,
      defaultTypes: () => [], postMetrics: () => new Map(), trashed: new Set() };
  };
  const one = site('one'), two = site('two');
  t.after(() => { for (const pub of pubs) pub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [source, amount] of [[one, 7], [two, 11]]) {
    const legacy = new PublicSite(source);
    legacy.store.addEntry('0xAbCd', amount, 'deposit');
    legacy.store.markRewarded(99, '0xOther');
    legacy.close();
  }
  for (const source of [one, two]) pubs.push(new PublicSite(source, { notesFile }));
  assert.equal(pubs[0].store.balance('0xABCD'), 18);
  assert.equal(pubs[1].store.balance('0xabcd'), 18);
  pubs[0].store.transfer('0xABCD', '0xOther', 3, 'tip', 1);
  assert.equal(pubs[1].store.balance('0xabcd'), 15);
  assert.equal(pubs[1].store.balance('0xother'), 3);
  assert.throws(() => pubs[0].store.transfer('0xabcd', '0xother', 100, 'tip', 1), /insufficient/);
  assert.equal(pubs[1].store.balance('0xabcd'), 15);
  const notes = new Notes(notesFile);
  assert.equal(notes.summary().migrations.length, 2);
  assert.equal(notes.summary().migrations.reduce((sum, item) => sum + item.total, 0), 18);
  notes.validateBalances();
  notes.close();
  const reopened = new PublicSite(one, { notesFile }); pubs.push(reopened);
  assert.equal(reopened.store.balance('0xabcd'), 15);
  assert.equal(reopened.store.reactionReward(99, '0xOther', '0xAbCd', 'comment').reason, 'already');
  reopened.store.db.prepare("INSERT INTO qprn_ledger(address,amount,kind,at) VALUES ('0xAbCd',1,'deposit',0)").run();
  assert.throws(() => new PublicSite(one, { notesFile }), /Legacy FTHX changed/);
});

test('Notes reaction lottery pays only the creator, shares like/comment eligibility and persists losing attempts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-rewards-'));
  const site = { key: 'one', dir: root, manifest: {}, memo: {}, options: () => ({}), has: () => false,
    defaultTypes: () => [], postMetrics: () => new Map(), trashed: new Set() };
  const notes = new Notes(path.join(root, 'notes.sqlite'));
  const pub = new PublicSite(site, { notesFile: notes.file });
  t.after(() => { pub.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  notes.setProgram('one', { symbol: 'ART', chance: 10, amount: 1, enabled: true });
  const original = crypto.randomInt;
  t.after(() => { crypto.randomInt = original; });
  crypto.randomInt = () => 0;
  assert.equal(pub.store.reactionReward(1, '0xAUTHOR', '0xauthor', 'like').reason, 'own');
  const paid = pub.store.reactionReward(1, '0xReactor', '0xAuthor', 'like');
  assert.equal(paid.paid, 1);
  assert.equal(notes.balance('0xAuthor', 'ART'), 1);
  assert.equal(pub.store.balance('0xAuthor'), 0);
  assert.equal(pub.store.balance('0xReactor'), 0);
  assert.equal(pub.store.reactionReward(1, '0xREACTOR', '0xAuthor', 'comment').reason, 'already');
  crypto.randomInt = () => 10;
  assert.equal(pub.store.reactionReward(2, '0xReactor', '0xAuthor', 'comment').paid, 0);
  crypto.randomInt = () => 0;
  assert.equal(pub.store.reactionReward(2, '0xReactor', '0xAuthor', 'like').reason, 'already');
  notes.setProgram('one', { symbol: 'FTHZ', chance: 10, amount: 2, enabled: true });
  assert.equal(pub.store.reactionReward(3, '0xReactor', '0xAuthor', 'comment').paid, 2);
  assert.equal(notes.balance('0xAuthor', 'FTHZ'), 2);
  assert.equal(notes.balance('0xAuthor'), 0);
  for (const symbol of ['FTH$', 'FTHX']) {
    assert.throws(() => notes.setProgram('one', { symbol, chance: 10, amount: 1, enabled: true }), /system-native/);
    notes.setProgram('one', { symbol, chance: 10, amount: 1, enabled: false });
    assert.equal(notes.program('one').enabled, 0);
  }
  assert.equal(pub.store.reactionReward(4, '0xReactor', '0xAuthor', 'comment').paid, 0);
  for (const chance of [0, 100, NaN]) assert.throws(() => notes.validateProgram({ symbol: 'FTHX', chance, amount: 1, enabled: true }), /chance/);
  notes.setProgram('one', { symbol: 'ART', chance: 10, amount: 1, enabled: true });
  pub.store.addEntry('0xAuthor', Number.MAX_SAFE_INTEGER - 1, 'fixture', null, null, 'ART');
  assert.throws(() => pub.store.reactionReward(5, '0xReactor', '0xAuthor', 'like'), /Invalid/);
  assert.equal(notes.db.prepare('SELECT COUNT(*) AS n FROM notes_reactions WHERE post_id=5').get().n, 0);
  notes.validateBalances();
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES ('0xnegative',-1,'invalid',0,'one')").run();
  assert.throws(() => notes.validateBalances(), /balances are invalid/);
});

test('native notes never pay rewards, including previously enabled programs and legacy likes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-notes-'));
  const site = { key: 'one', dir: root, manifest: {}, memo: {}, options: () => ({}), has: () => false,
    defaultTypes: () => [], postMetrics: () => new Map(), trashed: new Set() };
  const notes = new Notes(path.join(root, 'notes.sqlite'));
  const pub = new PublicSite(site, { notesFile: notes.file });
  const original = crypto.randomInt;
  t.after(() => { crypto.randomInt = original; pub.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  crypto.randomInt = () => 0;
  assert.equal(notes.program('unconfigured').enabled, 0);
  for (const [index, symbol] of ['FTH$', 'FTHX'].entries()) {
    notes.db.prepare('INSERT OR REPLACE INTO notes_programs VALUES (?,?,99,1000,1)').run('one', symbol);
    assert.equal(notes.program('one').enabled, 0);
    assert.equal(notes.summary().programs[0].enabled, 0);
    const result = pub.store.reactionReward(index + 10, '0xReactor', '0xAuthor', 'like');
    assert.equal(result.paid, 0);
    assert.equal(result.reason, 'system-native');
    assert.equal(notes.balance('0xAuthor', symbol), 0);
    assert.equal(pub.store.reactionReward(index + 10, '0xReactor', '0xAuthor', 'comment').reason, 'already');
  }
  assert.equal(notes.db.prepare('SELECT COUNT(*) AS n FROM notes_entries').get().n, 0);
  pub.store.memberAuthor = () => '0xAuthor';
  pub.store.session = () => ({ address: '0xReactor' });
  pub.store.notes = false;
  pub.store.addEntry('0xReactor', 5, 'fixture');
  const balance = pub.store.balance('0xReactor');
  assert.equal(pub.likeReward(20, 'session').reason, 'system-native');
  assert.equal(pub.store.balance('0xReactor'), balance);
});
