const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupStorage, DAY } = require('../../operations/storage-cleanup');

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value = 'temporary content') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const age = (file, date = new Date(Date.now() - 2 * DAY)) => {
    if (fs.lstatSync(file).isDirectory()) for (const name of fs.readdirSync(file)) age(path.join(file, name), date);
    fs.utimesSync(file, date, date);
  };
  return { root, write, age };
}

test('cleanup previews without writes, removes only old named staging, and preserves live data and backups', t => {
  const f = fixture(t);
  const old = f.write(`data/deployment/${ids[0]}/release.zip`);
  const legacy = f.write(`data/deployment/${ids[1]}.zip`);
  const snapshot = f.write(`data/site-sync/${ids[0]}/snapshot/db.sqlite`);
  const fresh = f.write(`data/deployment/${ids[2]}/release.zip`);
  const retained = [
    f.write('data/deployment/status.json', { running: false }),
    f.write('data/site-sync/status.json', { running: false, phase: 'complete' }),
    f.write('data/site-sync/source-id', 'identity'),
    f.write('data/backups/before.sqlite'), f.write('data/site-sync/notes.txt'),
    f.write('services/cms/data/x/uploads/photo.jpg'), f.write('data/live.sqlite-wal'),
  ];
  f.age(path.dirname(old)); f.age(legacy); f.age(path.dirname(path.dirname(snapshot)));
  const preview = cleanupStorage({ root: f.root });
  assert.equal(preview.candidates.length, 3);
  assert.equal(preview.removedBytes, 0);
  assert(preview.skipped.some(entry => entry.path === path.dirname(fresh) && /Recent staging/.test(entry.reason)));
  assert(fs.existsSync(old));
  const applied = cleanupStorage({ root: f.root, apply: true });
  assert.equal(applied.removedBytes, 3 * Buffer.byteLength('temporary content'));
  for (const file of [old, legacy, snapshot]) assert(!fs.existsSync(file));
  for (const file of [...retained, fresh]) assert(fs.existsSync(file), file);
  assert.equal(cleanupStorage({ root: f.root, apply: true }).candidates.length, 0);
});
test('no-backup cleanup removes only confirmed payloads and inactive releases without following live data links', t => {
  const f = fixture(t), current = path.join(f.root, 'releases', 'release-123456-aaaaaaaaaaaa');
  fs.mkdirSync(current, { recursive: true });
  fs.symlinkSync(current, path.join(f.root, 'current'), 'junction');
  const old = 'releases/release-123455-bbbbbbbbbbbb';
  f.write(`${old}/.deployment-hosts.json`, { hosts: ['featheral.com'], primary: true });
  f.write(`${old}/node_modules/temporary.js`, 'unused');
  const live = f.write('shared/data/live.sqlite', 'live');
  fs.symlinkSync(path.dirname(live), path.join(f.root, old, 'data'), 'junction');
  const backed = f.write(`shared/sync-backups/${ids[0]}/data/old.sqlite`, 'old');
  fs.linkSync(live, path.join(path.dirname(backed), 'live-link.sqlite'));
  f.write(`shared/sync-backups/${ids[0]}/state.json`, { phase: 'complete' });
  const unfinished = f.write(`shared/sync-backups/${ids[1]}/data/old.sqlite`, 'recovery');
  f.write(`shared/sync-backups/${ids[1]}/state.json`, { phase: 'installing' });
  const options = { root: current, minAgeMs: 0, discardOldReleases: true, discardCompletedBackups: true,
    command: () => ({ status: 0, stdout: 'inactive\n' }) };
  const preview = cleanupStorage(options);
  assert.equal(preview.candidates.length, 2);
  assert(fs.existsSync(backed));
  assert(fs.existsSync(path.join(f.root, old)));
  cleanupStorage({ ...options, apply: true });
  assert(!fs.existsSync(backed));
  assert(!fs.existsSync(path.join(f.root, old)));
  assert.equal(fs.readFileSync(live, 'utf8'), 'live');
  assert(fs.existsSync(unfinished));
  assert(fs.existsSync(path.join(path.dirname(path.dirname(backed)), 'state.json')));
  assert(fs.existsSync(current));
});

test('cleanup protects active operations, reviewed plans and paused or uncertain resumable snapshots', t => {
  const f = fixture(t);
  for (const id of ids) f.write(`data/site-sync/${id}/snapshot/manifest.json`);
  f.write('data/site-sync/status.json', { running: false, phase: 'paused', id: ids[0], resumable: true });
  const options = { root: f.root, minAgeMs: 0, apply: true, siteSync: { plans: new Map([[ids[1], {}]]) } };
  const result = cleanupStorage(options);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.skipped.filter(entry => /snapshot/.test(entry.kind || '')).length, 2);
  assert(!fs.existsSync(path.join(f.root, 'data/site-sync', ids[2])));
  for (const id of ids.slice(0, 2)) assert(fs.existsSync(path.join(f.root, 'data/site-sync', id)));
  for (const state of [{ running: true }, { running: false, phase: 'uncertain' }]) {
    f.write('data/site-sync/status.json', state);
    assert.equal(cleanupStorage({ root: f.root, apply: true, minAgeMs: 0 }).candidates.length, 0);
  }
  assert.equal(cleanupStorage({ ...options, busy: () => true }).candidates.length, 0);
  assert.equal(cleanupStorage({ ...options, deployment: { running: true } }).candidates.length, 0);
  f.write('data/deployment/status.json', { running: true });
  const archive = f.write(`data/deployment/${ids[0]}.zip`);
  cleanupStorage({ root: f.root, apply: true, minAgeMs: 0 });
  assert(fs.existsSync(archive));
});

test('cleanup rejects corrupt receipts, unsafe retention and links without following them', t => {
  const f = fixture(t);
  f.write('data/site-sync/status.json', '{invalid');
  assert.throws(() => cleanupStorage({ root: f.root }), /JSON/);
  f.write('data/site-sync/status.json', { running: false, phase: 'complete' });
  f.write('data/deployment/status.json', {});
  assert.throws(() => cleanupStorage({ root: f.root }), /Invalid saved operation/);
  f.write('data/deployment/status.json', { running: false });
  assert.throws(() => cleanupStorage({ root: f.root, minAgeMs: -1 }), /retention/);
  const original = f.write('unrelated/keep.txt');
  const staged = f.write(`data/deployment/${ids[0]}/release.zip`);
  fs.linkSync(original, path.join(path.dirname(staged), 'hard-link'));
  assert.throws(() => cleanupStorage({ root: f.root, apply: true, minAgeMs: 0 }), /linked cleanup/);
  assert(fs.existsSync(original));
  assert(fs.existsSync(staged));
  fs.unlinkSync(path.join(path.dirname(staged), 'hard-link'));
  fs.symlinkSync(path.dirname(original), path.join(path.dirname(staged), 'junction'), 'junction');
  assert.throws(() => cleanupStorage({ root: f.root, apply: true, minAgeMs: 0 }), /linked cleanup/);
  assert(fs.existsSync(original));
  fs.unlinkSync(path.join(path.dirname(staged), 'junction'));
});

test('a fresh descendant protects an old-looking preparation directory', t => {
  const f = fixture(t), file = f.write(`data/deployment/${ids[0]}/nested/release.zip`);
  const old = new Date(Date.now() - 3 * DAY);
  fs.utimesSync(path.dirname(file), old, old);
  fs.utimesSync(path.dirname(path.dirname(file)), old, old);
  assert.equal(cleanupStorage({ root: f.root, apply: true }).candidates.length, 0);
  assert(fs.existsSync(file));
  const at = new Date('2026-01-01T00:00:00Z');
  f.age(path.dirname(path.dirname(file)), at);
  assert.equal(cleanupStorage({ root: f.root, now: +at + DAY - 1 }).candidates.length, 0);
  assert.equal(cleanupStorage({ root: f.root, apply: true, now: +at + DAY }).candidates.length, 1);
  assert(!fs.existsSync(file));
});

test('managed targets clean only confirmed completed transfers and preserve backups, checkouts, releases and rollback staging', t => {
  const f = fixture(t), root = path.join(f.root, 'releases', 'release-current');
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(root, path.join(f.root, 'current'), 'junction');
  const hash = 'a'.repeat(64), incomplete = 'b'.repeat(64);
  const completed = f.write(`shared/deployment/${hash}/release.zip`);
  f.write(`shared/deployment/${hash}/cleanup-complete.json`, { complete: true });
  const unconfirmed = f.write(`shared/deployment/${incomplete}/release.zip`);
  for (let i = 0; i < ids.length; i++) {
    f.write(`shared/site-sync/${ids[i]}/snapshot/media.jpg`);
    f.write(`shared/sync-backups/${ids[i]}/state.json`, { phase: ['complete', 'rolled-back', 'installing'][i] });
  }
  const checkout = f.write('shared/self-deployment/checkout/source.js');
  f.write(`shared/self-deployment/${ids[0]}/release.zip`);
  f.write('shared/self-deployment/status.json', { running: false, phase: 'failed' });
  const command = () => ({ status: 0, stdout: 'inactive\n' });
  const result = cleanupStorage({ root, apply: true, minAgeMs: 0, command });
  assert.equal(result.candidates.length, 3);
  assert(!fs.existsSync(completed));
  assert(fs.existsSync(unconfirmed));
  assert(fs.existsSync(checkout));
  assert(fs.existsSync(root));
  for (const id of ids) assert(fs.existsSync(path.join(f.root, 'shared/sync-backups', id, 'state.json')));
  for (const id of ids.slice(1)) assert(fs.existsSync(path.join(f.root, 'shared/site-sync', id)));
  assert.equal(cleanupStorage({ root, command: () => ({ status: 0, stdout: 'active\n' }) }).candidates.length, 0);
  assert.throws(() => cleanupStorage({ root, command: () => ({ status: 1, stdout: '' }) }), /Cannot verify/);
  f.write('shared/site-sync.lock', 'recovery needed');
  assert.equal(cleanupStorage({ root, apply: true, minAgeMs: 0, command }).candidates.length, 0);
  fs.unlinkSync(path.join(f.root, 'current'));
});

test('independent maintenance preserves review-ready snapshots until the source service can check its plans', t => {
  const f = fixture(t), file = f.write(`data/site-sync/${ids[0]}/snapshot/manifest.json`);
  f.write('data/site-sync/status.json', { running: false, phase: 'review-ready' });
  const options = { root: f.root, minAgeMs: 0, apply: true };
  assert.equal(cleanupStorage(options).candidates.length, 0);
  assert(fs.existsSync(file));
  assert.equal(cleanupStorage({ ...options, siteSync: { plans: new Map([[ids[0], {}]]) } }).candidates.length, 0);
  assert.equal(cleanupStorage({ ...options, siteSync: { plans: new Map() } }).candidates.length, 1);
  assert(!fs.existsSync(file));
});

test('recent confirmed rollback transfers are disposable while unknown target work and compact receipts stay protected', t => {
  const f = fixture(t), root = path.join(f.root, 'releases', 'release-123456-aaaaaaaaaaaa');
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(root, path.join(f.root, 'current'), 'junction');
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  const transfer = f.write(`shared/deployment/${hash}/release.zip`, 'zip');
  f.write(`shared/deployment/${hash}/cleanup-complete.json`, { complete: true, outcome: 'rolled-back' });
  const unknown = f.write(`shared/deployment/${other}/release.zip`, 'unknown');
  const backup = f.write(`shared/sync-backups/${ids[0]}/payload/old.sqlite`, 'old');
  const receipt = f.write(`shared/sync-backups/${ids[0]}/state.json`, { phase: 'rolled-back' });
  const sourcePlan = path.join(root, 'data', 'site-sync', ids[1], 'snapshot', 'manifest.json');
  fs.mkdirSync(path.dirname(sourcePlan), { recursive: true });
  fs.writeFileSync(sourcePlan, 'fresh reviewed source');
  const options = { root, discardCompletedBackups: true, operationCleanup: true };
  const preview = cleanupStorage(options);
  assert.deepEqual(preview.candidates.map(entry => entry.kind), ['deployment transfer', 'completed backup payload']);
  assert(preview.skipped.some(entry => entry.path === path.dirname(unknown) && /unconfirmed/.test(entry.reason)));
  const result = cleanupStorage({ ...options, apply: true });
  assert.equal(result.removedBytes, preview.candidates.reduce((sum, entry) => sum + entry.bytes, 0));
  for (const file of [transfer, backup]) assert(!fs.existsSync(file));
  for (const file of [unknown, receipt, sourcePlan]) assert(fs.existsSync(file));
  assert.equal(cleanupStorage({ ...options, apply: true }).candidates.length, 0);
  fs.unlinkSync(path.join(f.root, 'current'));
});
