const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { open } = require('../../db-api/sqlite');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { serialize } = require('../lib/phpser');

test('trending shows photos with scattered GIFs from hot tags, sorted by likes + comments', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'trend-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  const postmeta = [];
  const index = [];
  fs.mkdirSync(path.join(dir, 'uploads', '2026'), { recursive: true });
  // Posts 1-12 are photos, 13-17 are GIFs. Tag "beach" has 1-8 and 13-16, "night" has 9-12 and 17.
  for (let id = 1; id <= 17; id++) {
    const ext = id > 12 ? 'gif' : 'jpg';
    const file = `2026/p${id}.${ext}`;
    posts.set(id, { ID: id, post_type: 'post', post_status: 'publish', post_content: '', post_title: `Post ${id}`, post_excerpt: '', post_date: `2026-01-${String(id).padStart(2, '0')}`, post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 });
    posts.set(100 + id, { ID: 100 + id, post_type: 'attachment', post_status: 'inherit', post_content: '', post_title: '', post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: id, post_mime_type: ext === 'gif' ? 'image/gif' : 'image/jpeg', comment_count: 0 });
    postmeta.push([100 + id, '_wp_attached_file', file], [100 + id, '_wp_attachment_metadata', serialize({ file, filesize: 10, width: 1000, height: 800, sizes: {} })]);
    fs.writeFileSync(path.join(dir, 'uploads', file), 'x'.repeat(10));
    index.push({ path: file, size: 10, ext, image: true, width: 1000, height: 800 });
  }
  writeJson(path.join(dir, 'uploads-index.json'), index);
  const manifest = { key, site: 'Trend test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, { posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [] },
    { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  const raw = open(dbFile);
  const p = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get().name.replace(/term_taxonomy$/, '');
  raw.prepare(`INSERT INTO ${p}terms VALUES (1, 'beach', 'beach', 0), (2, 'night', 'night', 0)`).run();
  raw.prepare(`INSERT INTO ${p}term_taxonomy VALUES (1, 1, 'post_tag', 'auto-tag', 0, 12), (2, 2, 'post_tag', 'auto-tag', 0, 5)`).run();
  const rel = raw.prepare(`INSERT INTO ${p}term_relationships VALUES (?, ?, 0)`);
  for (let id = 1; id <= 17; id++) rel.run(id, (id <= 8 || (id >= 13 && id <= 16)) ? 1 : 2);
  raw.close();

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  // With no likes yet the most used tags are offered.
  assert.deepEqual(pub.trending({}).tags.map((x) => x.name), ['beach', 'night']);
  assert.equal(pub.trending({}).total, 17);

  pub.vote(10, 'jpeg', 'like');
  pub.vote(11, 'jpeg', 'like');
  pub.store.addComment(11, '0x0000000000000000000000000000000000000001', 'hot');
  pub.vote(3, 'jpeg', 'like');
  const r = pub.trending({ limit: 50 });
  assert.equal(r.tags[0].name, 'night', 'the tag whose posts got the likes/comments leads');
  assert.deepEqual(r.tags[0], { id: 2, name: 'night', posts: 5, likes: 2, comments: 1 });
  const order = r.items.map((x) => x.id);
  assert.deepEqual(order.slice(0, 3), [11, 3, 10], 'likes + comments first; ties go to the latest activity');
  // One GIF after every few photos; leftover GIFs come after the photos.
  const kinds = r.items.map((x) => (x.media.type === 'gif' ? 'G' : 'P')).join('');
  assert.equal(kinds, 'PPPPPGPPPPPGPPGGG');
  assert.deepEqual(r.items.find((x) => x.id === 11).tags, [{ id: 2, name: 'night' }]);
  assert.equal(r.items.find((x) => x.id === 11).comments, 1);
  assert.equal(r.items.find((x) => x.id === 10).vote, 'like');

  const night = pub.trending({ tag: 2 });
  assert.deepEqual([night.tag.name, night.total], ['night', 5]);
  assert.deepEqual(night.items.map((x) => x.id), [11, 10, 12, 9, 17]);
  assert.deepEqual(pub.trending({ tag: 2, sort: 'newest' }).items.map((x) => x.id), [12, 11, 10, 9, 17]);
  assert.throws(() => pub.trending({ tag: 99 }), /Tag not found/);

  // A deleted post leaves the page.
  pub.vote(12, 'jpeg', 'dislike');
  assert.equal(pub.trending({ tag: 2 }).total, 4);
  assert.equal(pub.trending({ offset: 2, limit: 2 }).items.length, 2);

  // Search: words in the title/text (all must match) or a tag name, across every post.
  assert.deepEqual(pub.trending({ q: 'Post 15' }).items.map((x) => x.id), [15]);
  assert.deepEqual(pub.trending({ q: 'NIGHT', sort: 'newest' }).items.map((x) => x.id), [11, 10, 9, 17]);
  assert.equal(pub.trending({ q: 'post', tag: 2 }).total, 4, 'search within a tag');
  assert.equal(pub.trending({ q: 'nothing like this' }).total, 0);
  assert.equal(pub.trending({ q: '100%' }).total, 0, 'LIKE wildcards are literal');

  // "More tags" pages through the whole ranking, hottest first.
  const all = pub.tagList({});
  assert.deepEqual([all.total, all.tags.map((x) => x.name)], [2, ['night', 'beach']]);
  assert.deepEqual(pub.tagList({ offset: 1, limit: 1 }).tags.map((x) => x.name), ['beach']);
  assert.deepEqual(pub.tagList({ q: 'Bea' }).tags.map((x) => x.name), ['beach']);
  assert.equal(pub.trending({}).moreTags, false);
});
