const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { PublicSite } = require('../lib/public');
const implementation = fs.readFileSync(path.resolve(__dirname, '../lib/public.js'), 'utf8');
const Curation = vm.runInNewContext(`${implementation.slice(implementation.indexOf('class Curation {'), implementation.indexOf('module.exports ='))}; Curation`,
  { open: () => new DatabaseSync(':memory:'), Date });

function fixture(t, sharedCards = true) {
  const store = new Curation(':memory:', null, 'test');
  store.sharedCards = sharedCards;
  t.after(() => store.close());
  const subject = Object.assign(Object.create(PublicSite.prototype), {
    sharedCards, store, site: { key: 'test', memo: { publicPosts: [{ ID: 1 }], publicIds: new Set([1]), thumbIds: new Set() },
      trashed: new Set(), postMetrics: () => new Map([[1, { wordCount: 3, imageBest: { png: { url: '/one.png' } } }]]),
      has: () => false, t: value => value, all: () => [] },
    cms: { get: id => id === 10 ? { status: 'publish', body: 'A published page' } : null },
    walletOf: token => { if (token !== 'valid') throw Object.assign(new Error('Connect your wallet'), { status: 401 }); return '0xwallet'; },
    likeReward: () => null,
    analytics: { postView() {} },
  });
  subject.trash = (id, type, round) => {
    subject.site.trashed.add(id);
    store.addTrash({ id, type, round, title: 'Card', files: [], missed: [], attachments: [], bytes: 0, shared: 0 });
  };
  subject.restore = id => { subject.site.trashed.delete(id); store.removeTrash(id); };
  return subject;
}

test('X image and reading cards share one authoritative vote, round, Trash and undo', t => {
  const p = fixture(t);
  let result = p.vote(1, 'read', 'like');
  assert.equal(result.type, 'png');
  assert.equal(p.curation(1, 'png').vote, 'like');
  assert.equal(p.curation(1, 'read').likes, 1);
  p.vote(1, 'png', 'dislike');
  assert.equal(p.curation(1, 'read').deleted, true);
  assert.equal(p.curation(1, 'read').vote, 'dislike');
  p.vote(1, 'read', 'none');
  assert.equal(p.curation(1, 'png').deleted, false);
  assert.equal(p.curation(1, 'read').dislikes, 0);
  assert.equal(p.store.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  p.store.setRound('png', 2);
  assert.equal(p.curation(1, 'read').round, 2);
  p.vote(1, 'read', 'dislike', '', 2);
  assert.equal(p.site.trashed.has(1), false);
  const trashed = p.publicTrash().items[0];
  assert.equal(trashed.deck, 'png');
  assert.equal(trashed.reading, undefined, 'media-backed cards keep their media in Trash');
  assert.throws(() => p.vote(1, 'read', 'like', '', 1), error => error.status === 409);
});

test('legacy reading/media votes are deduplicated by post and round without rewriting snapshots', t => {
  const p = fixture(t), db = p.store.db;
  db.prepare('INSERT INTO votes VALUES (?,?,?,?,?)').run(1, 'read', 1, 'dislike', 10);
  db.prepare('INSERT INTO votes VALUES (?,?,?,?,?)').run(1, 'png', 1, 'like', 20);
  const before = db.prepare('SELECT * FROM votes').all();
  for (const type of ['', 'read', 'png']) {
    const counts = p.store.counts([1], type).get(1);
    assert.equal(counts.likes, 1); assert.equal(counts.dislikes, 0);
  }
  assert.equal(p.store.likedPosts('read')[0].likes, p.store.likedPosts('media')[0].likes);
  assert.equal(p.store.votesIn('png', 1, [1]).get(1), 'like');
  assert.equal(p.store.reviewed('png', 1).has(1), true);
  assert.deepEqual(db.prepare('SELECT * FROM votes').all(), before, 'read paths never migrate or mutate');
  p.vote(1, 'read', 'none');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
});

test('other sites keep their separate reading and media votes and wallet-only comments', t => {
  const p = fixture(t, false);
  p.vote(1, 'read', 'like');
  assert.equal(p.curation(1, 'png').vote, null);
  assert.equal(p.store.counts([1]).get(1), undefined);
  assert.throws(() => p.addComment(1, '', 'Guest', { visitor: 'visitor123', ip: '192.0.2.1' }), /Connect your wallet/);
});

test('guest comments are persistent shared post comments, not wallet identities or rewards', t => {
  const p = fixture(t), identity = { visitor: 'visitor123', ip: '192.0.2.1' };
  const c = p.addComment(1, '', '  Nice card\r\nThanks  ', identity);
  assert.equal(c.source, 'visitor'); assert.equal(c.author, 'Visitor');
  assert.equal(c.content, 'Nice card\nThanks');
  assert.equal(Object.hasOwn(c, 'address'), false);
  assert.equal(Object.hasOwn(c, 'reward'), false);
  assert.equal(p.comments(1).items[0].id, c.id);
  assert.throws(() => p.addComment(1, '', c.content, identity), error => error.status === 409);
  assert.throws(() => p.addComment(1, '', 'Another', identity), error => error.status === 429);
  assert.throws(() => p.addComment(1, '', '', identity), error => error.status === 400);
  assert.throws(() => p.addComment(1, '', 'x'.repeat(2001), identity), error => error.status === 400);
  assert.throws(() => p.addComment(1, '', 'Missing visitor'), error => error.status === 400);
  assert.throws(() => p.addComment(2, '', 'Draft', identity), error => error.status === 404);
  assert.throws(() => p.addComment(1, 'invalid', 'No bypass', identity), error => error.status === 401);
  assert.throws(() => p.deleteComment(c.id, 'valid'), error => error.status === 403);
  p.addComment(-10, '', 'Page comment', { ...identity, visitor: 'visitor456' });
  assert.equal(p.comments(-10).total, 1);
});

test('visitor and connection limits persist across reloads and reject spoofed visitor rotation', t => {
  const p = fixture(t), db = p.store.db, identity = { visitor: 'visitor123', ip: '192.0.2.1' };
  p.addComment(1, '', 'First', identity);
  const address = db.prepare('SELECT address FROM comments').get().address;
  db.prepare('UPDATE comments SET at=?').run(Date.now() - 20000);
  for (let i = 1; i < 6; i++) db.prepare('INSERT INTO comments (post_id,address,content,at) VALUES (?,?,?,?)').run(1, address, `Comment ${i}`, Date.now() - 20000 - i * 1000);
  assert.throws(() => p.addComment(1, '', 'Seventh', identity), error => error.status === 429);
  const prefix = address.slice(0, address.lastIndexOf(':') + 1);
  for (let i = 0; i < 14; i++) db.prepare('INSERT INTO comments (post_id,address,content,at) VALUES (?,?,?,?)').run(1, prefix + `rotated${i}`, `Other ${i}`, Date.now() - 30000);
  assert.throws(() => p.addComment(1, '', 'Rotated browser', { ...identity, visitor: 'rotated123' }), error => error.status === 429);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 20);
  p.addComment(1, '', 'Different connection', { visitor: 'visitor789', ip: '192.0.2.2' });
});

test('reading and image opens share a single deduplicated view count', t => {
  const p = fixture(t);
  assert.equal(p.view(1, 'visitor123').counted, true);
  assert.equal(p.view(1, 'visitor123').counted, false);
  assert.equal(p.store.viewCounts([1]).get(1), 1);
});
test('site-wide guest comment limit rejects at exactly 200 per hour and permits a slot below it', t => {
  const p = fixture(t), db = p.store.db;
  const insert = db.prepare('INSERT INTO comments (post_id,address,content,at) VALUES (?,?,?,?)');
  for (let i = 0; i < 199; i++) insert.run(1, 'other', `Existing ${i}`, Date.now());
  p.addComment(1, '', 'Slot 200', { visitor: 'visitor123', ip: '192.0.2.1' });
  assert.throws(() => p.addComment(1, '', 'Slot 201', { visitor: 'visitor456', ip: '192.0.2.2' }),
    error => error.status === 429 && /busy/.test(error.message));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 200);
});

test('guest connection identity trusts only the final address appended by loopback Nginx', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const code = source.slice(source.indexOf('function commentIP('), source.indexOf('function logSearch('));
  const ip = vm.runInNewContext(`${code}; commentIP`, { require });
  assert.equal(ip({ socket: { remoteAddress: '192.0.2.1' }, get: () => '198.51.100.1' }), '192.0.2.1');
  assert.equal(ip({ socket: { remoteAddress: '127.0.0.1' }, get: () => 'spoofed, 192.0.2.1' }), '192.0.2.1');
  assert.equal(ip({ socket: { remoteAddress: '::1' }, get: () => 'invalid' }), '::1');
});
