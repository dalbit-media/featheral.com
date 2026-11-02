const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');

test('views count once per visitor per post, persist, and show on post lists', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'views-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (ID, extra = {}) => ({ ID, post_type: 'post', post_status: 'publish', post_content: '<p>Some words to read here.</p>', post_title: `Post ${ID}`, post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0, ...extra });
  const posts = new Map([[1, post(1)], [2, post(2)], [3, post(3, { post_status: 'draft' })]]);
  const manifest = { key, site: 'Views test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, {
    posts, postmeta: [], terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(path.join(dir, 'uploads-index.json'), []);

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  assert.deepEqual(pub.view(1, 'alice'), { id: 1, views: 1, counted: true });
  assert.deepEqual(pub.view(1, 'alice'), { id: 1, views: 1, counted: false }, 'same visitor again is not counted');
  assert.equal(pub.view(1, 'bob').views, 2);
  assert.equal(pub.view(1, '').views, 3, 'anonymous views always count');
  assert.equal(pub.view('2', 'alice').views, 1);
  assert.throws(() => pub.view(3, 'alice'), /not found/i, 'unpublished posts are not viewable');
  assert.throws(() => pub.view(999, 'alice'), /not found/i);

  assert.equal(pub.text(1).views, 3);
  const list = pub.textList({ sort: 'newest' });
  assert.deepEqual(Object.fromEntries(list.items.map((x) => [x.id, x.views])), { 1: 3, 2: 1 });

  // Counts live in public.sqlite and survive a restart; the repeat-view window does not.
  pub.close();
  pub = new PublicSite(getSite(key), { brand: 'Public' });
  assert.equal(pub.viewCounts([1, 2]).get(1), 3);
  assert.equal(pub.view(1, 'alice').views, 4);
});
