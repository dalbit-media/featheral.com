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
  const raw = require('../../database/sqlite').open(path.join(dir, 'db.sqlite'));
  const prefix = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%term_taxonomy'").get().name.replace(/term_taxonomy$/, '');
  raw.exec(`INSERT INTO ${prefix}terms VALUES (10,'Essays','essays',0),(20,'Guides','guides',0);
    INSERT INTO ${prefix}term_taxonomy VALUES (10,10,'category','',0,2),(20,20,'category','',0,1);
    INSERT INTO ${prefix}term_relationships VALUES (1,10,0),(2,10,0),(3,20,0);`);
  raw.close();
  let pub = new PublicSite(getSite(key), { brand: 'Test' });
  for (let id = 1; id <= 30; id++) {
    pub.store.setVote(id, 'jpeg', 1, 'like');
    pub.store.db.prepare('UPDATE votes SET at=? WHERE post_id=?').run(id * 1000, id);
  }
  t.after(() => { pub.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, get pub() { return pub; }, reopen() { pub.close(); dropSite(key); pub = new PublicSite(getSite(key), { brand: 'Test' }); return pub; } };
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

test('reading likes are separate from media likes and include only published kept CMS readings', t => {
  const { pub } = fixture(t);
  const page = pub.cms.save({ title: 'FTHX', slug: 'fthx', type: 'page', body: 'Published reference text.', status: 'publish' });
  const draft = pub.cms.save({ title: 'Private draft', body: 'Not public', status: 'draft' });
  const result = pub.vote(-page.id, 'read', 'like', '', 1);
  assert.equal(result.likes, 1);
  pub.vote(1, 'read', 'like', '', 1);
  assert.equal(pub.curation(1, 'read').likes, 1, 'reading counts do not inherit media likes');
  assert.equal(pub.curation(1, 'jpeg').likes, 1, 'media counts do not inherit reading likes');
  assert.equal(pub.store.activity().get(1).likes, 1, 'Trending activity remains media-only');
  assert.equal(pub.liked().total, 30, 'All media remains a media-only timeline');
  const readings = pub.liked({ kind: 'read' });
  assert.equal(readings.total, 2);
  assert(readings.items.every(item => item.deck === 'read' && !item.media && !item.paragraphs));
  assert(readings.items.some(item => item.slug === 'fthx'));
  assert.throws(() => pub.vote(-draft.id, 'read', 'like'), { status: 404 });
  assert.throws(() => pub.publicMediaFile(-page.id, 'read'), { status: 400 });
  pub.vote(-page.id, 'read', 'dislike', '', 1);
  assert.equal(pub.textBySlug('fthx'), null);
  assert.equal(pub.text(-page.id), null);
  assert.equal(pub.text(-page.id, true).title, 'FTHX');
  assert.equal(pub.liked({ kind: 'read' }).total, 1);
  const trashed = pub.publicTrash().items.find(item => item.id === -page.id);
  assert.equal(trashed.reading, true);
  assert.equal(trashed.media, undefined);
  assert(!pub.readingNavigation().pages.some(item => item.slug === 'fthx'));
  pub.vote(-page.id, 'read', 'none', '', 1);
  assert.equal(pub.textBySlug('fthx').title, 'FTHX');
  assert(pub.readingNavigation().pages.some(item => item.slug === 'fthx'));
  pub.store.setRound('read', 2);
  pub.vote(2, 'read', 'dislike', '', 2);
  assert.equal(pub.curation(2, 'read').deleted, false);
  assert(pub.publicTrash().items.some(item => item.id === 2 && item.reading), 'later-round net-disliked readings appear without moving their media');
  assert.throws(() => pub.vote(2, 'read', 'like', '', 1), { status: 409 });
});

test('reading sidebar categories filter kept readings without including CMS pages or private drafts', t => {
  const { pub } = fixture(t);
  pub.cms.save({ title: 'Whitepaper', slug: 'fthx-whitepaper', type: 'page', body: 'Public whitepaper.', status: 'publish' });
  pub.cms.save({ title: 'Private page', slug: 'private-page', type: 'page', body: 'Private', status: 'draft' });
  const nav = pub.readingNavigation();
  assert.equal(nav.pages.length, 1);
  assert.equal(nav.pages[0].slug, 'fthx-whitepaper');
  assert.deepEqual(nav.categories.map(row => [row.name, row.count]), [['Essays', 2], ['Guides', 1]]);
  assert.deepEqual(pub.textList({ category: 10 }).items.map(row => row.id), [2, 1]);
  assert.equal(pub.textList({ category: 999 }).total, 0);
  assert.throws(() => pub.textList({ category: 'bad' }), { status: 400 });
  pub.vote(1, 'read', 'dislike');
  assert.equal(pub.readingNavigation().categories.find(row => row.id === 10).count, 1);
  assert.deepEqual(pub.textList({ category: 10 }).items.map(row => row.id), [2]);
});

test('reading review rounds advance only after all kept readings were reviewed', t => {
  const { pub } = fixture(t);
  assert.equal(pub.status('read').remaining, 30);
  assert.throws(() => pub.nextRound('read'), { status: 409 });
  for (let id = 1; id <= 30; id++) pub.vote(id, 'read', 'like', '', 1);
  assert.equal(pub.status('read').remaining, 0);
  assert.equal(pub.nextRound('read').round, 2);
  const result = pub.vote(1, 'read', 'dislike', '', 2);
  assert.equal(result.deleted, false);
  assert.equal(pub.store.round('jpeg'), 1);
});

test('CMS reading trash survives reopen and Admin purge removes only trashed CMS content', t => {
  const f = fixture(t), pub = f.pub;
  const page = pub.cms.save({ title: 'Temporary reading', body: 'Neutral text', status: 'publish' });
  const kept = pub.cms.save({ title: 'Kept reading', body: 'Keep this text', status: 'publish' });
  pub.vote(-page.id, 'read', 'dislike');
  const reopened = f.reopen();
  assert(reopened.site.trashed.has(-page.id));
  assert.equal(reopened.publicTrash().total, 1);
  assert.equal(reopened.emptyTrash().posts, 1);
  assert.equal(reopened.cms.get(page.id), null);
  assert.equal(reopened.cms.get(kept.id).title, 'Kept reading');
  assert.equal(reopened.liked().total, 30);
});

test('Admin purge protects a trashed active CMS homepage before removing any other content', t => {
  const { pub } = fixture(t);
  const home = pub.cms.save({ title: 'Home', slug: 'home', type: 'page', body: 'Neutral home', status: 'publish' });
  pub.cms.setSiteSettings({ ...pub.cms.siteSettings(), homepage: 'content', homeSlug: home.slug });
  pub.vote(-home.id, 'read', 'dislike');
  pub.vote(1, 'read', 'dislike');
  assert.throws(() => pub.emptyTrash(), { status: 409 });
  assert(pub.cms.get(home.id));
  assert.equal(pub.store.trashRows().length, 2);
  pub.cms.setSiteSettings({ ...pub.cms.siteSettings(), homepage: 'media' });
  assert.equal(pub.emptyTrash().posts, 2);
});

test('public Trash includes first-round deletions and net-disliked posts without moving later-round media', t => {
  const f = fixture(t), pub = f.pub;
  fs.mkdirSync(path.join(f.dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'uploads', '1.jpg'), 'neutral-fixture');
  fs.writeFileSync(path.join(f.dir, 'uploads', '2.jpg'), 'neutral-fixture');
  pub.vote(1, 'jpeg', 'dislike');
  assert.equal(pub.curation(1, 'jpeg').deleted, true);
  assert.equal(pub.curation(1, 'jpeg').canRestore, true);
  assert.equal(pub.publicMediaFile(1, 'jpeg'), path.join(f.dir, 'trash', '1.jpg'));
  assert.equal(pub.comments(1).total, 0, 'trashed published media retain readable comments');
  pub.store.db.prepare("INSERT OR REPLACE INTO rounds(type,round) VALUES ('jpeg',2)").run();
  pub.vote(2, 'jpeg', 'dislike');
  pub.store.setVote(2, 'png', 2, 'dislike');
  pub.vote(3, 'jpeg', 'dislike');
  const trash = pub.publicTrash({ limit: 1 });
  assert.equal(trash.total, 2, 'tied likes/dislikes and ordinary liked posts do not enter Trash');
  assert.equal(trash.items[0].id, 1);
  assert.equal(trash.items[0].canRestore, false, 'a previous round deletion is not publicly restored');
  assert.equal(pub.publicTrash({ offset: 1 }).items[0].id, 2);
  assert.equal(fs.existsSync(path.join(f.dir, 'uploads', '2.jpg')), true);
  assert.throws(() => pub.vote(2, 'jpeg', 'like', '', 1), { status: 409 }, 'stale viewer rounds cannot accidentally vote');
  assert.throws(() => pub.publicMediaFile(999, 'jpeg'), { status: 404 });
  pub.site.memo.publicIds.delete(1);
  assert(!pub.publicTrash().items.some(item => item.id === 1), 'unpublished/private posts stay hidden even when in curation trash');
  assert.throws(() => pub.publicMediaFile(1, 'jpeg'), { status: 404 });
});

test('viewer round-one dislike, undo and like restore media without advancing rounds', t => {
  const f = fixture(t), pub = f.pub;
  fs.mkdirSync(path.join(f.dir, 'uploads'), { recursive: true });
  const file = path.join(f.dir, 'uploads', '1.jpg');
  fs.writeFileSync(file, 'neutral-fixture');
  pub.vote(1, 'jpeg', 'dislike', '', 1);
  assert(!fs.existsSync(file));
  assert.equal(pub.publicTrash().items[0].id, 1);
  pub.vote(1, 'jpeg', 'none', '', 1);
  assert(fs.existsSync(file));
  assert.equal(pub.publicTrash().total, 0);
  pub.vote(1, 'jpeg', 'dislike', '', 1);
  pub.vote(1, 'jpeg', 'like', '', 1);
  assert.equal(pub.curation(1, 'jpeg').vote, 'like');
  assert.equal(pub.publicTrash().total, 0);
  assert.equal(pub.store.round('jpeg'), 1);
});

test('Gallery viewers retain the thumbs deck instead of accidentally voting in the still-image round', t => {
  const { pub } = fixture(t);
  pub.site.memo.thumbIds = new Set([1]);
  pub.store.setRound('thumbs', 2);
  const post = pub.thumbList({}).items[0];
  assert.equal(post.deck, 'thumbs');
  assert.equal(pub.curation(post.id, post.deck).round, 2);
  assert.equal(pub.vote(post.id, post.deck, 'dislike', '', 2).deleted, false);
  assert.equal(pub.store.round('jpeg'), 1);
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
