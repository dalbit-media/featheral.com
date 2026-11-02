const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { open } = require('../../database/sqlite');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const W = require('../lib/wallet');

// What a browser wallet does for personal_sign: EIP-191 hash, then a 65-byte r‖s‖v signature.
function wallet(seed) {
  const priv = keccak_256(Buffer.from(seed));
  const address = W.checksum('0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1))).toString('hex').slice(-40));
  const sign = (message) => {
    const s = secp256k1.sign(W.hashMessage(message), priv);
    return '0x' + Buffer.from(s.toCompactRawBytes()).toString('hex') + (27 + s.recovery).toString(16);
  };
  return { address, sign };
}

test('wallet signatures recover the signing address and nothing else', () => {
  // Well-known EIP-55 test vector.
  assert.equal(W.checksum('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  const a = wallet('alice'); const b = wallet('bob');
  assert.equal(W.recoverAddress('hello', a.sign('hello')), a.address);
  assert.notEqual(W.recoverAddress('hello!', a.sign('hello')), a.address);
  assert.notEqual(W.recoverAddress('hello', b.sign('hello')), a.address);
  assert.equal(W.recoverAddress('hello', '0x1234'), null);
});

test('posts show WordPress and wallet comments; only signed-in wallets can comment', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'comments-test-'));
  const key = path.basename(dir);
  let pub;
  t.after(() => { pub?.close(); dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (ID, extra = {}) => ({ ID, post_type: 'post', post_status: 'publish', post_content: '', post_title: `Post ${ID}`, post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0, ...extra });
  const posts = new Map([[1, post(1)], [2, post(2, { post_status: 'draft' })]]);
  const manifest = { key, site: 'Comments test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, {
    posts, postmeta: [], terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(path.join(dir, 'uploads-index.json'), []);
  const raw = open(dbFile);
  const table = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%comments'").get().name;
  raw.prepare(`INSERT INTO ${table} (comment_ID, comment_post_ID, comment_author, comment_author_email, comment_author_url, comment_date, comment_date_gmt, comment_content, comment_approved, comment_type, comment_parent, user_id)
    VALUES (7, 1, 'Synced &amp; Co', '', '', '2026-01-02 10:00:00', '2026-01-02 10:00:00', '<p>From WordPress</p>', '1', 'comment', 0, 0)`).run();
  raw.prepare(`INSERT INTO ${table} (comment_ID, comment_post_ID, comment_author, comment_author_email, comment_author_url, comment_date, comment_date_gmt, comment_content, comment_approved, comment_type, comment_parent, user_id)
    VALUES (8, 1, 'Spam', '', '', '2026-01-02 11:00:00', '2026-01-02 11:00:00', 'buy now', 'spam', 'comment', 0, 0)`).run();
  raw.close();

  pub = new PublicSite(getSite(key), { brand: 'Public' });
  const alice = wallet('alice'); const bob = wallet('bob');

  let c = pub.comments(1);
  assert.deepEqual(c.items.map((x) => [x.source, x.author, x.content]), [['wordpress', 'Synced & Co', 'From WordPress']], 'only approved WordPress comments');
  assert.throws(() => pub.comments(2), /not found/, 'drafts are not public');

  assert.throws(() => pub.addComment(1, '', 'hi'), /Connect your wallet/);
  assert.throws(() => pub.addComment(1, 'nope', 'hi'), /Connect your wallet/);

  // Sign-in: the message names the wallet and a one-time nonce; a wrong signer or a reused nonce fails.
  let n = pub.walletNonce(alice.address.toLowerCase());
  assert.equal(n.address, alice.address);
  assert.match(n.message, new RegExp(alice.address));
  assert.throws(() => pub.walletLogin(alice.address, bob.sign(n.message)), /does not match/);
  assert.throws(() => pub.walletLogin(alice.address, alice.sign(n.message)), /expired/, 'a failed attempt uses up the nonce');
  n = pub.walletNonce(alice.address);
  const s = pub.walletLogin(alice.address, alice.sign(n.message));
  assert.equal(s.address, alice.address);
  assert.throws(() => pub.walletLogin(alice.address, alice.sign(n.message)), /expired/, 'nonces are single-use');
  assert.equal(pub.walletOf(s.token), alice.address);

  assert.throws(() => pub.addComment(1, s.token, '   '), /Write a comment/);
  assert.throws(() => pub.addComment(1, s.token, 'x'.repeat(2001)), /2,000/);
  const mine = pub.addComment(1, s.token, '  Nice one\r\nreally  ');
  assert.deepEqual([mine.address, mine.content], [alice.address, 'Nice one\nreally']);
  c = pub.comments(1);
  assert.deepEqual(c.items.map((x) => [x.source, x.author]), [['wordpress', 'Synced & Co'], ['wallet', alice.address]]);
  assert.equal(c.total, 2);

  // Only the author's wallet can delete its comment.
  const bn = pub.walletNonce(bob.address);
  const bs = pub.walletLogin(bob.address, bob.sign(bn.message));
  assert.throws(() => pub.deleteComment(mine.id, bs.token), /Only the wallet/);
  pub.deleteComment(mine.id, s.token);
  assert.equal(pub.comments(1).total, 1);

  pub.walletLogout(s.token);
  assert.throws(() => pub.walletOf(s.token), /Connect your wallet/);
});
