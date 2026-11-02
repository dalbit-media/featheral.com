const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { open } = require('../../database/sqlite');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { privateIp, checkUrl, pageInfo, youtubeId } = require('../lib/linkfetch');
const W = require('../lib/wallet');

function wallet(seed) {
  const priv = keccak_256(Buffer.from(seed));
  const address = W.checksum('0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1))).toString('hex').slice(-40));
  const sign = (message) => {
    const s = secp256k1.sign(W.hashMessage(message), priv);
    return '0x' + Buffer.from(s.toCompactRawBytes()).toString('hex') + (27 + s.recovery).toString(16);
  };
  return { address, sign };
}

// Smallest buffers the server accepts: a JPEG SOF0 header or a GIF header, plus random bytes so each is unique.
function jpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, crypto.randomBytes(64), Buffer.from([0xff, 0xd9])]);
}
function gif(width, height) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii'); head.writeUInt16LE(width, 6); head.writeUInt16LE(height, 8);
  return Buffer.concat([head, crypto.randomBytes(64), Buffer.from([0x3b])]);
}

test('members top up FTHX, pay to post, land in the right deck, and receive tips but no native like rewards', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'members-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  // One synced post with a big photo so the deck isn't empty.
  fs.mkdirSync(path.join(dir, 'uploads', '2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', '2026', 'old.jpg'), 'x'.repeat(10));
  const posts = new Map([
    [1, { ID: 1, post_type: 'post', post_status: 'publish', post_content: '', post_title: 'Synced', post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 }],
    [101, { ID: 101, post_type: 'attachment', post_status: 'inherit', post_content: '', post_title: '', post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 1, post_mime_type: 'image/jpeg', comment_count: 0 }],
  ]);
  const postmeta = [[101, '_wp_attached_file', '2026/old.jpg'], [101, '_wp_attachment_metadata', 'a:4:{s:4:"file";s:12:"2026/old.jpg";s:8:"filesize";i:10;s:5:"width";i:1200;s:6:"height";i:900;}']];
  writeJson(path.join(dir, 'uploads-index.json'), [{ path: '2026/old.jpg', size: 10, ext: 'jpg', image: true, width: 1200, height: 900 }]);
  const manifest = { key, site: 'Members test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  const raw = open(dbFile);
  const prefix = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get().name.replace(/term_taxonomy$/, '');
  raw.prepare(`INSERT INTO ${prefix}terms (term_id, name, slug, term_group) VALUES (5, 'Photo', 'photo', 0)`).run();
  raw.prepare(`INSERT INTO ${prefix}term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (5, 5, 'category', '', 0, 0)`).run();
  raw.close();

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  const alice = wallet('alice'); const bob = wallet('bob'); const eve = wallet('eve');
  const login = (w) => pub.walletLogin(w.address, w.sign(pub.walletNonce(w.address).message)).token;
  const topUp = (token, w, amount) => pub.deposit(token, w.sign(pub.depositRequest(token, amount).message));
  const a = login(alice); const b = login(bob); const e = login(eve);

  // Posting needs a wallet and a balance.
  assert.throws(() => pub.createPost('', jpeg(1200, 900), { title: 'x' }), /Connect your wallet to post/);
  assert.throws(() => pub.createPost(a, jpeg(1200, 900), { title: 'x' }), (err) => err.status === 402);
  assert.equal(pub.walletMe(a).balance, 0);
  assert.equal(pub.walletMe(a).symbol, 'FTHX');
  assert.equal(pub.info().token.symbol, 'FTHX');

  // Top-ups are signed by the wallet itself, once per request.
  assert.throws(() => pub.depositRequest(a, 0), /whole number/);
  assert.throws(() => pub.depositRequest(a, 1.5), /whole number/);
  assert.throws(() => pub.depositRequest(a, 1001), /at most 1,000/);
  let req = pub.depositRequest(a, 10);
  assert.match(req.message, new RegExp(alice.address));
  assert.match(req.message, /10 FTHX/);
  assert.doesNotMatch(req.message, /QPRN/);
  assert.throws(() => pub.deposit(a, bob.sign(req.message)), /does not match/);
  assert.throws(() => pub.deposit(a, alice.sign(req.message)), /expired/, 'a failed attempt uses up the request');
  req = pub.depositRequest(a, 10);
  assert.deepEqual([pub.deposit(a, alice.sign(req.message)).balance], [10]);
  assert.throws(() => pub.deposit(a, alice.sign(req.message)), /expired/, 'requests are single-use');
  topUp(b, bob, 3);

  // A big JPEG goes to the swipe deck, first in the mix, with its poster; posting costs 1.
  const big = pub.createPost(a, jpeg(1200, 900), { title: '  Big   one ', description: 'Hello\n\nworld', source: 'https://example.com/x' });
  assert.deepEqual([big.destination, big.media.type, big.media.width, big.balance, big.cost], ['swipe', 'jpeg', 1200, 9, 1]);
  assert.equal(big.title, 'Big one');
  assert.ok(fs.existsSync(path.join(dir, 'uploads', ...big.media.url.split('/media/')[1].split('/').slice(1))), 'the file is stored under uploads/');
  let deck = pub.feed({ type: 'mix', limit: 10 }).items;
  assert.deepEqual(deck.map((x) => [x.id, x.author, x.earned]), [[big.id, alice.address, 0], [1, null, 0]]);
  // A small still goes to Thumbs; a GIF stays in the swipe deck even when small.
  const small = pub.createPost(a, jpeg(300, 200), { title: 'Tiny' });
  assert.equal(small.destination, 'thumbs');
  assert.deepEqual(pub.thumbList({}).items.map((x) => [x.id, x.author]), [[small.id, alice.address]]);
  const anim = pub.createPost(a, gif(200, 150), { title: 'Moves' });
  assert.deepEqual([anim.destination, anim.media.type, anim.balance], ['swipe', 'gif', 7]);
  deck = pub.feed({ type: 'mix', limit: 10 }).items.map((x) => x.id);
  assert.deepEqual(deck, [anim.id, big.id, 1], 'newest member posts first');

  // Bad uploads cost nothing.
  const dupe = fs.readFileSync(path.join(dir, 'uploads', ...big.media.url.split('/media/')[1].split('/').slice(1)));
  assert.throws(() => pub.createPost(a, dupe, { title: 'Again' }), /already on the site/);
  assert.throws(() => pub.createPost(a, Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(40), 'binary'), { title: 'png' }), /JPEG or GIF/);
  assert.throws(() => pub.createPost(a, jpeg(800, 600), { title: '   ' }), /title/);
  assert.equal(pub.walletMe(a).balance, 7);

  // Likes never transfer system-native FTHX, regardless of wallet balance.
  let v = pub.vote(big.id, 'jpeg', 'like', b);
  assert.deepEqual([v.likes, v.reward.paid, v.reward.reason, v.reward.balance], [1, 0, 'system-native', 3]);
  pub.vote(big.id, 'jpeg', 'none', b);
  assert.equal(pub.vote(big.id, 'jpeg', 'like', b).reward.reason, 'system-native', 'undo and like again pays nothing');
  assert.equal(pub.vote(big.id, 'jpeg', 'like', a).reward.reason, 'system-native');
  assert.equal(pub.vote(big.id, 'jpeg', 'like', e).reward.reason, 'system-native');
  assert.equal(pub.vote(big.id, 'jpeg', 'like').reward.reason, 'guest');
  assert.equal(pub.vote(1, 'jpeg', 'like', b).reward, undefined, 'synced posts have no poster to reward');
  assert.equal(pub.walletMe(a).balance, 7);

  // Tips go to member posts only, never your own, and need the balance.
  assert.throws(() => pub.tip(big.id, '', 1), /Connect your wallet to tip/);
  assert.throws(() => pub.tip(big.id, a, 1), /own post/);
  assert.throws(() => pub.tip(1, b, 1), /Only posts made by members/);
  assert.throws(() => pub.tip(big.id, b, 5), (err) => err.status === 402);
  assert.throws(() => pub.tip(big.id, b, 0), /whole number/);
  const tip = pub.tip(big.id, b, 2);
  assert.deepEqual([tip.balance, tip.earned], [1, 2]);
  assert.equal(pub.walletMe(a).balance, 9);
  assert.equal(pub.store.memberInfo([big.id]).get(big.id).earned, 2);

  const led = pub.ledger(a);
  assert.deepEqual([led.balance, led.posts, led.earned], [9, 3, 2]);
  assert.deepEqual(led.items.map((x) => [x.kind, x.amount]), [['tip_in', 2], ['post', -1], ['post', -1], ['post', -1], ['deposit', 10]]);
  assert.equal(led.items[0].title, 'Big one');

  // Member posts survive a reload of the data set (voted posts have left this round's deck).
  pub.close(); dropSite(key);
  pub = new PublicSite(getSite(key), { brand: 'Public' });
  assert.deepEqual(pub.feed({ type: 'mix', limit: 10 }).items.map((x) => [x.id, x.author]), [[anim.id, alice.address]]);
  assert.deepEqual(pub.thumbList({}).items.map((x) => [x.id, x.author]), [[small.id, alice.address]]);
  assert.equal(pub.ledger(a).balance, 9);
  assert.equal(pub.walletMe(a).symbol, 'FTHX');
  assert.match(big.media.url, /\/fthx-/);

  // YouTube posts: the 480×360 cover goes to the swipe deck (not Thumbs) and the feed, viewer lists and Liked carry the video id.
  assert.throws(() => pub.createPost(a, jpeg(480, 360), { title: 'Clip', video: 'not-an-id' }), /YouTube video id/);
  const clip = pub.createPost(a, jpeg(480, 360), { title: 'Clip', video: 'dQw4w9WgXcQ' });
  assert.deepEqual([clip.destination, clip.video, clip.balance], ['swipe', 'dQw4w9WgXcQ', 8]);
  const top = pub.feed({ type: 'mix', limit: 10 }).items[0];
  assert.deepEqual([top.id, top.video, top.author], [clip.id, 'dQw4w9WgXcQ', alice.address]);
  assert.ok(Array.isArray(top.tags), 'swipe items list their keyword tags');
  assert.equal(pub.feed({ type: 'mix', limit: 10 }).items.find((x) => x.id === anim.id).video, null);
  pub.vote(clip.id, 'jpeg', 'like');
  assert.equal(pub.liked({}).items.find((x) => x.id === clip.id).video, 'dQw4w9WgXcQ');
  assert.throws(() => pub.createPost(a, jpeg(480, 360), { title: 'Clip again', video: 'dQw4w9WgXcQ' }), /video is already on the site/);
});

test('link fetching refuses private addresses and reads preview images from pages', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(privateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.140', '2606:4700::1111']) assert.equal(privateIp(ip), false, ip);
  await assert.rejects(checkUrl('http://127.0.0.1:5178/'), /private|local/i);
  await assert.rejects(checkUrl('http://localhost/'), /private|local/i);
  await assert.rejects(checkUrl('file:///etc/passwd'), /http/i);

  const info = pageInfo('<html><head><title>Fallback</title><meta property="og:title" content="Nice &amp; pic">'
    + '<meta content="/img/a.jpg" property="og:image"></head></html>', 'https://example.com/post/1');
  assert.deepEqual([info.image, info.title], ['https://example.com/img/a.jpg', 'Nice & pic']);
  assert.equal(pageInfo('<title>Only</title><img src="b.gif" width="400">', 'https://example.com/p/').image, 'https://example.com/p/b.gif');

  for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://youtube.com/live/dQw4w9WgXcQ']) assert.equal(youtubeId(link), 'dQw4w9WgXcQ', link);
  for (const link of ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'not a link']) assert.equal(youtubeId(link), null, link);
});
