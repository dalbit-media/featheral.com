const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Maintenance, WEEK } = require('../lib/maintenance');
const CmsStore = require('../lib/cms');
const { SiteManager } = require('../lib/sites');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.now(), busy = false, replica = false, fail = false, cleanupCount = 0;
  const calls = [], invalidated = [], errors = [], logs = [], sites = [
    { key: 'x', hostname: 'x.featheral.com' }, { key: 'existing', hostname: 'old.example.test' }, { key: 'new', hostname: 'new.example.test' },
  ];
  const enabled = { x: true, existing: false, new: true };
  const options = {
    root, now: () => time, sites: () => sites, busy: () => busy, replica: () => replica,
    cleanup() { cleanupCount++; return { candidates: [], removedBytes: 0 }; },
    publicByKey: key => ({
      cms: { siteSettings: () => ({ weeklyTrash: enabled[key] }) },
      emptyTrash() { calls.push(key); if (fail && key === 'x') throw new Error('purge failed'); return { posts: 3, files: 2, bytes: 42 }; },
    }),
    invalidateSite: key => invalidated.push(key),
    logger: { info: text => logs.push(text), error: (...args) => errors.push(args) },
  };
  return { root, options, enabled, calls, invalidated, errors, logs, advance: ms => { time += ms; },
    setBusy: value => { busy = value; }, setReplica: value => { replica = value; }, setFail: value => { fail = value; },
    cleanupCount: () => cleanupCount };
}

test('weekly schedules persist across restarts, catch up once, and never opt other existing sites in', t => {
  const f = fixture(t);
  let task = new Maintenance(f.options);
  task.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(Object.keys(task.state.sites), ['x', 'new']);
  f.advance(WEEK - 1);
  task.tick();
  assert.deepEqual(f.calls, []);
  task = new Maintenance(f.options);
  f.advance(1);
  task.tick();
  assert.deepEqual(f.calls, ['x', 'new']);
  assert.deepEqual(f.invalidated, ['x', 'new']);
  assert(f.logs.some(text => text.includes('permanently deleted')));
  task.tick();
  assert.equal(f.calls.length, 2);
  f.advance(3 * WEEK);
  new Maintenance(f.options).tick();
  assert.deepEqual(f.calls, ['x', 'new', 'x', 'new'], 'downtime causes only one catch-up purge, not a burst');
});

test('manual cleanup empties every CMS site regardless of weekly opt-in and reports bytes and failures', t => {
  const f = fixture(t), task = new Maintenance(f.options);
  f.options.cleanup = () => ({ candidates: [{ bytes: 100 }], removedBytes: 100, skipped: [], blocked: false });
  task.cleanup = f.options.cleanup;
  f.setFail(true);
  const partial = task.runNow();
  assert.deepEqual(f.calls, ['x', 'existing', 'new']);
  assert.deepEqual(partial.errors, [{ key: 'x', message: 'purge failed' }]);
  assert.equal(partial.temporary.removedBytes, 100);
  assert.equal(partial.sites.reduce((sum, site) => sum + site.bytes, 0), 84);
  assert.deepEqual(f.invalidated, ['x', 'existing', 'new']);
  assert(!task.state.sites.existing, 'manual purge does not opt a site into weekly cleanup');
  assert(task.state.sites.new.lastTrashAt);
  f.setFail(false);
  const complete = task.runNow();
  assert.deepEqual(complete.errors, []);
  assert.equal(complete.sites.length, 3);
  assert.equal(task.state.sites.x.nextTrashAt, task.state.sites.x.lastTrashAt + WEEK);
});

test('temporary-only cleanup uses immediate verified cleanup without purging trash or altering schedules', t => {
  const f = fixture(t), task = new Maintenance(f.options), options = [];
  task.cleanup = input => {
    options.push(input);
    return { candidates: [{ path: 'disposable', bytes: 42 }], removedBytes: input.apply ? 42 : 0, skipped: [], blocked: false };
  };
  assert.equal(task.preview().removedBytes, 0);
  assert.equal(task.runNow({ temporaryOnly: true }).temporary.removedBytes, 42);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(task.state.sites, {});
  assert(!fs.existsSync(task.file));
  for (const input of options) {
    assert.equal(input.minAgeMs, 0);
    assert.equal(input.discardCompletedBackups, true);
    assert.equal(input.discardOldReleases, true);
    assert.equal(input.busy, f.options.busy);
  }
});

test('manual cleanup protects replicas, active operations and blocked staging before trash deletion', t => {
  const f = fixture(t), task = new Maintenance(f.options);
  f.setBusy(true);
  assert.throws(() => task.runNow(), { status: 409 });
  assert.equal(f.cleanupCount(), 0);
  f.setBusy(false); f.setReplica(true);
  const replica = task.runNow();
  assert.equal(f.cleanupCount(), 1);
  assert.match(replica.trashSkipped, /read-only replica/);
  assert.deepEqual(f.calls, []);
  assert(!fs.existsSync(task.file));
  f.setReplica(false);
  task.cleanup = () => ({ blocked: true });
  assert.throws(() => task.runNow(), { status: 409 });
  assert.deepEqual(f.calls, []);
  task.deployment = { running: true };
  assert.throws(() => task.runNow(), { status: 409 });
});

test('busy servers skip maintenance; replicas clean staging only; failed purges log and retry without advancing', t => {
  const f = fixture(t), task = new Maintenance(f.options);
  f.setBusy(true); task.tick();
  assert.equal(f.cleanupCount(), 0);
  f.setBusy(false); f.setReplica(true); task.tick();
  assert.equal(f.cleanupCount(), 1);
  assert(!fs.existsSync(task.file));
  f.setReplica(false); task.tick();
  f.advance(WEEK); f.setFail(true); task.tick();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.invalidated, ['x', 'new']);
  f.setFail(false); task.tick();
  assert.deepEqual(f.calls, ['x', 'new', 'x']);
  assert(task.state.sites.x.lastTrashAt);
});

test('disabling weekly cleanup cancels the schedule and re-enabling gives a full week', t => {
  const f = fixture(t), task = new Maintenance(f.options);
  task.tick(); f.advance(WEEK);
  f.enabled.x = false; task.tick();
  assert.deepEqual(f.calls, ['new']);
  assert(!task.state.sites.x);
  f.enabled.x = true; task.tick();
  assert.deepEqual(f.calls, ['new']);
  f.advance(WEEK); task.tick();
  assert.deepEqual(f.calls, ['new', 'x', 'new']);
  task.start();
  const timer = task.timer;
  task.start();
  assert.equal(task.timer, timer);
  assert.equal(timer.hasRef(), false);
  task.close();
  assert.equal(task.timer, null);
});

test('weekly cleanup settings default only for new sites and the explicit X migration, retaining opt-outs and omitted fields', t => {
  const f = fixture(t), file = path.join(f.root, 'existing/cms.sqlite');
  const old = new CmsStore(file);
  assert.equal(old.siteSettings().weeklyTrash, false);
  const x = new CmsStore(path.join(f.root, 'x/cms.sqlite'));
  x.initializeTrashPolicy();
  assert.equal(x.siteSettings().weeklyTrash, true);
  x.setSiteSettings({ ...x.siteSettings(), weeklyTrash: false });
  x.initializeTrashPolicy();
  assert.equal(x.siteSettings().weeklyTrash, false, 'startup never overrides an explicit opt-out');
  const manager = new SiteManager({ dataDir: path.join(f.root, 'sites') });
  const created = manager.create({ hostname: 'new.example.test' });
  const fresh = new CmsStore(path.join(created.localDir, 'cms.sqlite'));
  assert.equal(fresh.siteSettings().weeklyTrash, true);
  const { weeklyTrash, ...legacy } = fresh.siteSettings();
  assert.equal(fresh.setSiteSettings(legacy).weeklyTrash, true);
  assert.throws(() => fresh.setSiteSettings({ ...legacy, weeklyTrash: 'yes' }), { status: 400 });
  assert.equal(old.siteSettings().weeklyTrash, false);
  for (const store of [old, x, fresh]) store.close();
});

test('production gateway and standalone CMS start maintenance and shutdown clears its timers', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const serve = fs.readFileSync(path.join(root, 'scripts/serve.js'), 'utf8');
  const cms = fs.readFileSync(path.join(root, 'services/cms/server.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'sites/admin.featheral.com/js/cms.js'), 'utf8');
  assert.match(serve, /cms\.startMaintenance\(\)/);
  assert.match(serve, /startStorageMaintenance\(root\)/);
  assert.match(cms, /app\.maintenance\?\.close\(\)/);
  assert.match(cms, /if \(require\.main === module\) \{\s*app\.startMaintenance\(\)/);
  assert.match(ui, /name="weeklyTrash" type="checkbox"/);
  assert.match(ui, /values\.weeklyTrash = form\.elements\.weeklyTrash\.checked/);
});

test('scheduled permanent purge deletes trash but restores files and attachments still needed by a restored post', t => {
  const { DATA_DIR, writeJson } = require('../lib/store');
  const { SyncRunner } = require('../lib/sync');
  const { getSite, dropSite } = require('../lib/wp');
  const { PublicSite } = require('../lib/public');
  const f = fixture(t), dir = fs.mkdtempSync(path.join(DATA_DIR, 'weekly-trash-test-')), key = path.basename(dir);
  const posts = new Map([1, 2, 10].map(id => [id, {
    ID: id, post_type: id === 10 ? 'attachment' : 'post', post_status: id === 10 ? 'inherit' : 'publish',
    post_content: id === 10 ? '' : '<img src="https://example.test/wp-content/uploads/shared.jpg">',
    post_title: `Post ${id}`, post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0,
    post_mime_type: id === 10 ? 'image/jpeg' : '', comment_count: 0,
  }]));
  const manifest = { key, site: 'Weekly purge test', status: 'ready' };
  new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
    posts, postmeta: [[10, '_wp_attached_file', 'shared.jpg']], terms: new Map(), rels: [], comments: [],
    users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(path.join(dir, 'uploads-index.json'), [{ path: 'shared.jpg', size: 10, ext: 'jpg', image: true }]);
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads/shared.jpg'), 'shared');
  const pub = new PublicSite(getSite(key));
  t.after(() => { pub.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  pub.cms.initializeTrashPolicy();
  pub.vote(1, 'jpeg', 'dislike');
  pub.vote(2, 'jpeg', 'dislike');
  assert(fs.existsSync(path.join(dir, 'trash/shared.jpg')));
  pub.restore(1);
  const task = new Maintenance({ ...f.options, sites: () => [{ key, hostname: 'x.featheral.com' }],
    publicByKey: () => pub, invalidateSite: () => {} });
  task.tick(); f.advance(WEEK); task.tick();
  assert.deepEqual(f.errors, []);
  assert.equal(pub.trashList().total, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'uploads/shared.jpg'), 'utf8'), 'shared');
  assert(!fs.existsSync(path.join(dir, 'trash')));
  const db = require('../../database/sqlite').open(path.join(dir, 'db.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT ID FROM wp_posts ORDER BY ID').all().map(row => row.ID), [1, 10]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

test('permanent purge refuses replicas before touching trash rows, databases or files', t => {
  const replica = require('../../operations/replica');
  const guard = t.mock.method(replica, 'readReplica', () => ({ readOnly: true }));
  const { PublicSite } = require('../lib/public');
  assert.throws(() => PublicSite.prototype.emptyTrash.call({}), { status: 403 });
  guard.mock.restore();
});
