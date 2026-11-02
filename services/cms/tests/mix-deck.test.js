const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { serialize } = require('../lib/phpser');

test('the mixed deck shuffles GIF and image posts and keeps votes per media type', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'mix-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  const postmeta = [];
  const index = [];
  const uploads = path.join(dir, 'uploads', '2026');
  fs.mkdirSync(uploads, { recursive: true });
  for (let id = 1; id <= 8; id++) {
    const ext = id % 2 ? 'gif' : 'jpg';
    const file = `2026/m${id}.${ext}`;
    posts.set(id, { ID: id, post_type: 'post', post_status: 'publish', post_content: '', post_title: `Post ${id}`, post_excerpt: '', post_date: `2026-01-0${id}`, post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 });
    posts.set(100 + id, { ID: 100 + id, post_type: 'attachment', post_status: 'inherit', post_content: '', post_title: '', post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: id, post_mime_type: ext === 'gif' ? 'image/gif' : 'image/jpeg', comment_count: 0 });
    postmeta.push([100 + id, '_wp_attached_file', file], [100 + id, '_wp_attachment_metadata', serialize({ file, filesize: id * 10, width: 10, height: 10, sizes: {} })]);
    fs.writeFileSync(path.join(uploads, `m${id}.${ext}`), 'x'.repeat(id * 10));
    index.push({ path: file, size: id * 10, ext, image: true });
  }
  writeJson(path.join(dir, 'uploads-index.json'), index);
  const manifest = { key, site: 'Mix test', status: 'ready' };
  new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  const first = pub.feed({ type: 'mix', limit: 3 });
  assert.equal(first.total, 8);
  assert.equal(first.items.length, 3);
  assert.ok(first.more);
  const rest = pub.feed({ type: 'mix', limit: 50, after: first.items.at(-1).id });
  const order = [...first.items, ...rest.items];
  assert.deepEqual(order.map((x) => x.id).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.notDeepEqual(order.map((x) => x.id), [8, 7, 6, 5, 4, 3, 2, 1], 'not sorted by size');
  for (const x of order) assert.equal(x.media.type, x.id % 2 ? 'gif' : 'jpeg');

  for (const x of order) pub.vote(x.id, x.media.type, x.id === 2 || x.id === 3 ? 'dislike' : 'like');
  assert.equal(pub.status('gif').liked, 3);
  assert.equal(pub.status('jpeg').liked, 3);
  const done = pub.status('mix');
  assert.deepEqual([done.total, done.remaining, done.liked, done.disliked], [6, 0, 6, 2]);

  const next = pub.nextRound('mix');
  assert.deepEqual([next.round, next.total, next.remaining], [2, 6, 6]);
  assert.equal(pub.status('gif').round, 2);
  const round2 = pub.feed({ type: 'mix', limit: 50 }).items.map((x) => x.id);
  assert.deepEqual([...round2].sort(), [1, 4, 5, 6, 7, 8]);
});
