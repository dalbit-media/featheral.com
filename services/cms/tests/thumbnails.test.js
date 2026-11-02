const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { open } = require('../../database/sqlite');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { moveToThumbnails } = require('../lib/thumbnails');
const { serialize } = require('../lib/phpser');

test('small still images move to the Thumbnails category, leave the swipe deck and fill the gallery', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'thumbs-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  const postmeta = [];
  const index = [];
  fs.mkdirSync(path.join(dir, 'uploads', '2026'), { recursive: true });
  // [id, ext, width, height]: 1 and 2 are small JPGs, 3 is a large JPG, 4 is a small GIF.
  const media = [[1, 'jpg', 140, 100], [2, 'jpg', 320, 639], [3, 'jpg', 1080, 1350], [4, 'gif', 200, 150]];
  for (const [id, ext, width, height] of media) {
    const file = `2026/p${id}.${ext}`;
    posts.set(id, { ID: id, post_type: 'post', post_status: 'publish', post_content: '', post_title: `Post ${id}`, post_excerpt: '', post_date: `2026-01-0${id}`, post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 });
    posts.set(100 + id, { ID: 100 + id, post_type: 'attachment', post_status: 'inherit', post_content: '', post_title: '', post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: id, post_mime_type: ext === 'gif' ? 'image/gif' : 'image/jpeg', comment_count: 0 });
    postmeta.push([100 + id, '_wp_attached_file', file], [100 + id, '_wp_attachment_metadata', serialize({ file, filesize: 10, width, height, sizes: {} })]);
    fs.writeFileSync(path.join(dir, 'uploads', file), 'x'.repeat(10));
    index.push({ path: file, size: 10, ext, image: true, width, height });
  }
  writeJson(path.join(dir, 'uploads-index.json'), index);
  const manifest = { key, site: 'Thumbs test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  // Give post 1 an existing category, which the move replaces.
  const raw = open(dbFile);
  const prefix = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get().name.replace(/term_taxonomy$/, '');
  raw.prepare(`INSERT INTO ${prefix}terms (term_id, name, slug, term_group) VALUES (1, 'Photo', 'photo', 0)`).run();
  raw.prepare(`INSERT INTO ${prefix}term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 1)`).run();
  raw.prepare(`INSERT INTO ${prefix}term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0)`).run();
  raw.close();

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  assert.deepEqual(pub.smallImagePosts(640).sort(), [1, 2]);
  assert.equal(pub.status('mix').total, 4);
  pub.close(); dropSite(key);

  const r = moveToThumbnails(dbFile, [1, 2]);
  assert.deepEqual([r.moved, r.total], [2, 2]);
  assert.equal(moveToThumbnails(dbFile, [1, 2]).moved, 0, 'running again changes nothing');

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  const check = open(dbFile, { readOnly: true });
  const cats = check.prepare(`SELECT r.object_id AS id, t.slug, tt.count FROM ${prefix}term_relationships r JOIN ${prefix}term_taxonomy tt USING (term_taxonomy_id)
    JOIN ${prefix}terms t USING (term_id) ORDER BY r.object_id`).all().map((x) => [x.id, x.slug, x.count]);
  check.close();
  assert.deepEqual(cats, [[1, 'thumbnails', 2], [2, 'thumbnails', 2]]);

  const deck = pub.feed({ type: 'mix', limit: 50 }).items.map((x) => x.id).sort();
  assert.deepEqual(deck, [3, 4]);
  assert.equal(pub.status('jpeg').total, 1);
  const gallery = pub.thumbList({ sort: 'newest' });
  assert.equal(gallery.total, 2);
  assert.deepEqual(gallery.items.map((x) => [x.id, x.media.type, x.media.width]), [[2, 'jpeg', 320], [1, 'jpeg', 140]]);
  assert.deepEqual(pub.thumbList({ sort: 'smallest' }).items.map((x) => x.id), [1, 2]);
  assert.equal(pub.info().thumbs, 2);

  // Round 1: a thumbnail dislike deletes right away; undo restores it.
  assert.equal(pub.vote(1, 'thumbs', 'dislike').deleted, true);
  assert.equal(pub.thumbList().total, 1);
  assert.equal(pub.vote(1, 'thumbs', 'none').deleted, false);
  assert.equal(pub.thumbsSeen(5).round, 1, 'a stale round number does not advance');
  assert.equal(pub.thumbsSeen(1).round, 2);
  // Round 2: likes and dislikes are only counted.
  const d = pub.vote(1, 'thumbs', 'dislike');
  assert.deepEqual([d.deleted, d.dislikes], [false, 1]);
  pub.vote(2, 'thumbs', 'like');
  const listed = pub.thumbList({ sort: 'smallest' });
  assert.deepEqual([listed.round, listed.total], [2, 2]);
  assert.deepEqual(listed.items.map((x) => [x.id, x.vote]), [[1, 'dislike'], [2, 'like']]);
  assert.deepEqual(pub.liked({}).items.map((x) => [x.id, x.deck, x.media.type]), [[2, 'thumbs', 'jpeg']]);

  // Swipe deck: dislikes delete in round 1 only.
  assert.equal(pub.vote(3, 'jpeg', 'dislike').deleted, true);
  pub.vote(3, 'jpeg', 'none');
  pub.vote(4, 'gif', 'like'); pub.vote(3, 'jpeg', 'like');
  pub.nextRound('mix');
  const r2 = pub.vote(3, 'jpeg', 'dislike');
  assert.deepEqual([r2.round, r2.deleted], [2, false]);
  assert.deepEqual(pub.feed({ type: 'mix' }).items.map((x) => [x.id, x.round, x.deletes]), [[4, 2, false]]);

  // Comment counts appear on swipe cards and gallery tiles.
  pub.store.addComment(4, '0x0000000000000000000000000000000000000001', 'a');
  pub.store.addComment(4, '0x0000000000000000000000000000000000000001', 'b');
  pub.store.addComment(1, '0x0000000000000000000000000000000000000001', 'c');
  assert.deepEqual(pub.feed({ type: 'mix' }).items.map((x) => [x.id, x.comments]), [[4, 2]]);
  assert.deepEqual(pub.thumbList({ sort: 'smallest' }).items.map((x) => [x.id, x.comments]), [[1, 1], [2, 0]]);
});
