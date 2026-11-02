const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { serialize } = require('../lib/phpser');

test('duplicate posts keep the first published post and trash the rest with their own media', async (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'dedupe-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  const postmeta = [];
  const addPost = (id, date, content = '', type = 'post', parent = 0, mime = '') => posts.set(id, {
    ID: id, post_type: type, post_status: type === 'attachment' ? 'inherit' : 'publish', post_content: content, post_title: `Post ${id}`,
    post_excerpt: '', post_date: date, post_author: 0, post_parent: parent, post_mime_type: mime, comment_count: 0,
  });
  const media = (id, file, parent) => {
    addPost(id, '2026-01-01', '', 'attachment', parent, 'image/jpeg');
    postmeta.push([id, '_wp_attached_file', file], [id, '_wp_attachment_metadata', serialize({ file, filesize: 3, width: 10, height: 10, sizes: {} })]);
  };
  // 1 and 2 use the same file; 3 and 4 have byte-identical files; 5 has a different file of the same size; 6 is unique.
  addPost(1, '2026-01-05');
  addPost(2, '2026-01-02', '<img class="wp-image-101" src="https://example.test/wp-content/uploads/2026/a.jpg">');
  addPost(3, '2026-01-03');
  addPost(4, '2026-01-04');
  addPost(5, '2026-01-01');
  addPost(6, '2026-01-01');
  media(101, '2026/a.jpg', 1);
  media(103, '2026/b.jpg', 3);
  media(104, '2026/c.jpg', 4);
  media(105, '2026/d.jpg', 5);
  media(106, '2026/e.jpg', 6);
  const uploads = path.join(dir, 'uploads');
  const bytes = { 'a.jpg': 'AAA', 'b.jpg': 'SAM', 'c.jpg': 'SAM', 'd.jpg': 'DIF', 'e.jpg': 'EEEE' };
  fs.mkdirSync(path.join(uploads, '2026'), { recursive: true });
  for (const [f, b] of Object.entries(bytes)) fs.writeFileSync(path.join(uploads, '2026', f), b);
  writeJson(path.join(dir, 'uploads-index.json'), Object.keys(bytes).map((f) => ({ path: `2026/${f}`, size: 3, ext: 'jpg', image: true })));
  const manifest = { key, site: 'Dedupe test', status: 'ready' };
  new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  const groups = await pub.duplicates();
  assert.deepEqual(groups.map((g) => [g.keep, g.remove]).sort(), [[2, [1]], [3, [4]]]);
  const preview = await pub.dedupe();
  assert.equal(preview.posts, 2);
  assert.equal(pub.site.trashed.size, 0);

  const done = await pub.dedupe({ apply: true });
  assert.deepEqual([done.groups, done.trashed], [2, 2]);
  assert.deepEqual([...pub.site.trashed].sort(), [1, 4]);
  assert.ok(fs.existsSync(path.join(uploads, '2026/a.jpg')), 'file still used by the kept post stays');
  assert.ok(!fs.existsSync(path.join(uploads, '2026/c.jpg')), 'identical copy owned by the duplicate is trashed');
  assert.ok(fs.existsSync(path.join(dir, 'trash/2026/c.jpg')));
  const list = pub.trashList();
  assert.deepEqual(list.items.map((x) => [x.id, x.dupOf]).sort(), [[1, 2], [4, 3]]);
  assert.equal((await pub.dedupe()).posts, 0);

  pub.restore(4);
  assert.ok(fs.existsSync(path.join(uploads, '2026/c.jpg')));
  assert.equal(pub.emptyTrash().posts, 1);
  assert.ok(fs.existsSync(path.join(uploads, '2026/a.jpg')));
});
