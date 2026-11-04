const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Wallet } = require('ethers');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { serialize } = require('../lib/phpser');

function fixture(t) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'liked-timeline-')), key = path.basename(dir);
  const posts = new Map(), postmeta = [], index = [];
  for (let id = 1; id <= 30; id++) {
    const file = `${id}.jpg`;
    posts.set(id, { ID: id, post_type: 'post', post_status: 'publish', post_title: `Post ${id}`, post_content: 'Caption',
      post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 });
    posts.set(100 + id, { ...posts.get(id), ID: 100 + id, post_type: 'attachment', post_status: 'inherit',
      post_parent: id, post_mime_type: 'image/jpeg' });
    postmeta.push([100 + id, '_wp_attached_file', file],
      [100 + id, '_wp_attachment_metadata', serialize({ file, filesize: 100, width: 1200, height: 900, sizes: {} })]);
    index.push({ path: file, size: 100, ext: 'jpg', image: true });
  }
  writeJson(path.join(dir, 'uploads-index.json'), index);
  const manifest = { key, site: 'Timeline test', status: 'ready' };
  new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  let pub = new PublicSite(getSite(key), { brand: 'Test' });
  for (let id = 1; id <= 30; id++) {
    pub.store.setVote(id, 'jpeg', 1, 'like');
    pub.store.db.prepare('UPDATE votes SET at=? WHERE post_id=?').run(id * 1000, id);
  }
  t.after(() => { pub.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get pub() { return pub; }, reopen() { pub.close(); pub = new PublicSite(getSite(key), { brand: 'Test' }); return pub; } };
}
async function login(pub, wallet = Wallet.createRandom()) {
  const challenge = pub.walletNonce(wallet.address);
  return pub.walletLogin(wallet.address, await wallet.signMessage(challenge.message)).token;
}

test('liked timeline sorts by latest surviving like, defaults to 24 and pages deterministically', t => {
  const { pub } = fixture(t);
  pub.store.setVote(1, 'jpeg', 2, 'like');
  pub.store.db.prepare('UPDATE votes SET at=31000 WHERE post_id=1 AND round=2').run();
  const recent = pub.liked();
  assert.equal(recent.limit, 24);
  assert.equal(recent.sort, 'recent');
  assert.equal(recent.items[0].id, 1);
  assert.equal(recent.items[0].likedAt, 31000);
  assert.equal(recent.items[0].description, 'Caption');
  const all = [...recent.items, ...pub.liked({ offset: 24 }).items];
  assert.equal(all.length, 30);
  assert.equal(new Set(all.map(item => item.id)).size, 30);
  assert.equal(pub.liked({ sort: 'likes' }).items[0].id, 1);
  pub.store.setVote(1, 'jpeg', 2, null);
  assert.equal(pub.liked().items[0].id, 30, 'undo returns the item to its previous timeline position');
  pub.store.db.prepare('UPDATE votes SET at=30000 WHERE post_id=29').run();
  assert.deepEqual(pub.liked({ limit: 2 }).items.map(item => item.id), [30, 29], 'timestamp ties use post ID');
  assert.throws(() => pub.liked({ sort: 'random' }), { status: 400 });
});

test('wallet folders persist across sessions, enforce ownership and never alter votes or rounds', async t => {
  const f = fixture(t), pub = f.pub, alice = Wallet.createRandom(), a = await login(pub, alice), b = await login(pub);
  const folder = pub.saveCollection(a, null, 'Favorites');
  const votes = pub.store.db.prepare('SELECT * FROM votes ORDER BY post_id,round').all();
  const rounds = pub.store.db.prepare('SELECT * FROM rounds').all();
  assert.throws(() => pub.collections(''), { status: 401 });
  assert.throws(() => pub.saveCollection(a, null, 'favorites'), { status: 409 });
  assert.throws(() => pub.saveCollection(a, null, ' '), { status: 400 });
  assert.throws(() => pub.saveCollection(a, null, 'x'.repeat(81)), { status: 400 });
  assert.throws(() => pub.collectMedia(b, folder.id, 1, true), { status: 404 });
  assert.throws(() => pub.saveCollection(b, folder.id, 'Stolen'), { status: 404 });
  assert.throws(() => pub.deleteCollection(b, folder.id), { status: 404 });
  assert.throws(() => pub.liked({ collection: folder.id }, b), { status: 404 });
  assert.throws(() => pub.liked({ collection: folder.id }), { status: 401 });
  assert.throws(() => pub.liked({ collection: 'invalid' }, a), { status: 400 });
  assert.deepEqual(pub.collections(b).items, []);
  pub.collectMedia(a, folder.id, 1, true);
  pub.collectMedia(a, folder.id, 1, true);
  pub.collectMedia(a, folder.id, 30, true);
  assert.equal(pub.collections(a, 1).items[0].saved, 1);
  assert.equal(pub.collections(a).items[0].count, 2);
  assert.deepEqual(pub.liked({ collection: folder.id }, a).items.map(item => item.id), [30, 1]);
  assert.throws(() => pub.collectMedia(a, folder.id, 99999, true), { status: 404 });
  assert.throws(() => pub.collectMedia(a, folder.id, '1 OR 1=1', true), { status: 400 });
  assert.throws(() => pub.collections(a, '-1'), { status: 400 });
  assert.equal(pub.saveCollection(a, folder.id, 'Renamed').name, 'Renamed');
  pub.collectMedia(a, folder.id, 1, false);
  assert.equal(pub.collections(a).items[0].count, 1);
  assert.deepEqual(pub.store.db.prepare('SELECT * FROM votes ORDER BY post_id,round').all(), votes);
  assert.deepEqual(pub.store.db.prepare('SELECT * FROM rounds').all(), rounds);
  const reopened = f.reopen(), token = await login(reopened, alice);
  assert.equal(reopened.collections(token).items[0].name, 'Renamed');
  assert.deepEqual(reopened.liked({ collection: folder.id }, token).items.map(item => item.id), [30]);
  reopened.walletLogout(token);
  assert.throws(() => reopened.collections(token), { status: 401 });
  const next = await login(reopened, alice);
  reopened.deleteCollection(next, folder.id);
  assert.equal(reopened.collections(next).items.length, 0);
  assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM saved_media').get().n, 0);
  assert.equal(reopened.liked().total, 30);
});

test('folders are isolated per site and never reveal posts removed from shared likes', async t => {
  const one = fixture(t), two = fixture(t), wallet = Wallet.createRandom();
  const a = await login(one.pub, wallet), b = await login(two.pub, wallet);
  const folder = one.pub.saveCollection(a, null, 'Private');
  one.pub.collectMedia(a, folder.id, 1, true);
  assert.deepEqual(two.pub.collections(b).items, []);
  assert.throws(() => two.pub.liked({ collection: folder.id }, b), { status: 404 });
  one.pub.store.setVote(1, 'jpeg', 1, null);
  assert.equal(one.pub.liked({ collection: folder.id }, a).total, 0);
  one.pub.collectMedia(a, folder.id, 1, false);
  assert.equal(one.pub.collections(a).items[0].count, 0);
});

test('folder names and the 100-folder limit remain enforced after failed transactions', async t => {
  const { pub } = fixture(t), token = await login(pub);
  const first = pub.saveCollection(token, null, 'First');
  for (let i = 1; i < 100; i++) pub.saveCollection(token, null, `Folder ${i}`);
  assert.throws(() => pub.saveCollection(token, null, 'Overflow'), { status: 400 });
  assert.throws(() => pub.saveCollection(token, first.id, 'Folder 1'), { status: 409 });
  assert.equal(pub.collections(token).items.length, 100);
  assert.equal(pub.saveCollection(token, first.id, 'Renamed at capacity').name, 'Renamed at capacity');
  pub.deleteCollection(token, first.id);
  assert.equal(pub.saveCollection(token, null, 'Space available').name, 'Space available');
});
