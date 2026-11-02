const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { open } = require('../../database/sqlite');
const { SiteManager } = require('../lib/sites');
const CmsStore = require('../lib/cms');

test('sites have independent data folders, databases, content and themes across restarts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-sites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new SiteManager({ dataDir: dir, cmsHost: 'admin.featheral.com' });
  const first = manager.create({ hostname: 'x.featheral.com' });
  const second = manager.create({ hostname: 'news.featheral.com', name: 'News' });
  assert.notEqual(first.localDir, second.localDir);
  for (const site of [first, second]) {
    for (const file of ['db.sqlite', 'cms.sqlite', 'public.sqlite', 'manifest.json', 'uploads-index.json', 'uploads']) {
      assert.equal(fs.existsSync(path.join(site.localDir, file)), true);
    }
    const db = open(path.join(site.localDir, 'db.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wp_posts').get().n, 0);
    db.close();
  }
  const one = new CmsStore(path.join(first.localDir, 'cms.sqlite'));
  const two = new CmsStore(path.join(second.localDir, 'cms.sqlite'));
  one.save({ title: 'First site only', body: 'First content', status: 'publish' });
  one.setTheme('ocean');
  assert.equal(two.list().length, 0);
  assert.equal(two.theme(), 'featheral');
  one.close(); two.close();
  const restarted = new SiteManager({ dataDir: dir, cmsHost: 'admin.featheral.com' });
  assert.deepEqual(restarted.list().map((s) => s.hostname), ['x.featheral.com', 'news.featheral.com']);
  assert.throws(() => restarted.create({ hostname: 'x.featheral.com' }), { status: 409 });
  assert.throws(() => restarted.create({ hostname: 'admin.featheral.com' }), { status: 409 });
  assert.throws(() => restarted.create({ hostname: '../escape' }), { status: 400 });
});

test('registering the default public domain preserves its existing data folder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-existing-site-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = 'original-data';
  fs.mkdirSync(path.join(dir, key));
  fs.writeFileSync(path.join(dir, key, 'manifest.json'), JSON.stringify({ key, status: 'ready', site: 'Original' }));
  fs.writeFileSync(path.join(dir, key, 'db.sqlite'), 'unchanged');
  const options = { dataDir: dir, defaultHost: 'x.featheral.com', defaultKey: key };
  const manager = new SiteManager(options);
  assert.equal(manager.list()[0].key, key);
  assert.equal(manager.list()[0].site, 'x.featheral.com');
  assert.equal(fs.readFileSync(path.join(dir, key, 'db.sqlite'), 'utf8'), 'unchanged');
  assert.equal(new SiteManager(options).list().length, 1);
});
