const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { open } = require('../../database/sqlite');
const { interestKeywords, buildInterestTags, canonicalInterestName } = require('../lib/interest-keywords');
const { buildTags, bodyText, tagPost, matchExistingTags } = require('../lib/autotag');
const { reviewKeywords } = require('../lib/keyword-review');

test('reviewed interests match complete phrases, aliases, punctuation and Unicode without name fragments', () => {
  assert.deepEqual(interestKeywords('ZENLESS ZONE ZERO | Honkai: Star Rail | NieR: Automata'),
    ['Zenless Zone Zero', 'Honkai: Star Rail', 'NieR: Automata']);
  assert.deepEqual(interestKeywords('Baldur’s Gate / BALDURS GATE / Baldur gate'), ["Baldur's Gate"]);
  assert.deepEqual(interestKeywords('Try-on haul; try on haul; tryon haul'), ['Try-on haul']);
  assert.deepEqual(interestKeywords('A bodypainting photography workshop and music video'),
    ['Body painting', 'Photography', 'Photography workshop', 'Music video']);
  assert.deepEqual(interestKeywords('Sarah Lee; star; fantasy; rail; resident; bikini one piece'), []);
  assert.deepEqual(interestKeywords('One Piece cosplay by Lada Lyumos'), ['Lada Lyumos', 'One Piece']);
  assert.deepEqual(interestKeywords('NotResident Evilness, roadway, dancer, campingground'), []);
  assert.deepEqual(interestKeywords('Music.\nVideo; Resident / Evil'), [], 'phrases never bridge sentences or unrelated fields');
  assert.deepEqual(matchExistingTags('A one piece swimsuit', ['One Piece']), []);
  assert.deepEqual(matchExistingTags('Music.\nVideo', ['Music video']), []);
  assert.equal(canonicalInterestName('Bismill Story'), 'Bimill Story');
});

test('corpus matching reviews title, excerpt and substantive body, counts posts once and keeps only interests on at least three posts', () => {
  const posts = [
    { id: 1, title: 'Resident Evil', excerpt: 'Music video', content: '<p>Resident Evil; photography workshop</p>' },
    { id: 2, title: 'Caption', excerpt: 'Resident Evil and music video', content: '<p>Photography workshop</p>' },
    { id: 3, title: 'Caption', content: '<p>Resident Evil and a music video at the photography workshop.</p>' },
    { id: 4, title: 'Elden Ring and Elden Ring', content: '' },
    { id: 5, title: 'Caption', content: '<a href="https://reddit.com/u/Resident_Evil">/u/Resident_Evil</a> [comments]' },
    { id: 6, title: 'Music', excerpt: 'video', content: '' },
  ];
  const tags = buildInterestTags(posts, bodyText);
  for (const id of [1, 2, 3]) {
    assert(tags.get(id).includes('Resident Evil'));
    assert(tags.get(id).includes('Music video'));
    assert(tags.get(id).includes('Photography workshop'));
  }
  for (const id of [4, 5, 6]) assert(!tags.has(id));
  const auto = buildTags(posts, { maxTags: 1 });
  assert(auto.get(1).includes('Resident Evil'));
  assert(auto.get(1).includes('Music video'), 'reviewed interests do not get squeezed out by the statistical keyword budget');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interest-keywords-')), file = path.join(dir, 'db.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(file);
  db.exec(`CREATE TABLE wp_posts(ID INTEGER PRIMARY KEY,post_type TEXT,post_status TEXT,post_password TEXT,post_title TEXT,post_content TEXT,post_excerpt TEXT);
    CREATE TABLE wp_terms(term_id INTEGER PRIMARY KEY,name TEXT,slug TEXT,term_group INTEGER);
    CREATE TABLE wp_term_taxonomy(term_taxonomy_id INTEGER PRIMARY KEY,term_id INTEGER,taxonomy TEXT,description TEXT,parent INTEGER,count INTEGER);
    CREATE TABLE wp_term_relationships(object_id INTEGER,term_taxonomy_id INTEGER,term_order INTEGER,PRIMARY KEY(object_id,term_taxonomy_id));
    INSERT INTO wp_terms VALUES(1,'Photo','photo',0),(2,'Handmade','handmade',0),(3,'Existing auto','existing-auto',0);
    INSERT INTO wp_term_taxonomy VALUES(1,1,'category','',0,1),(2,2,'post_tag','',0,1),(3,3,'post_tag','auto-tag',0,1);
    INSERT INTO wp_term_relationships VALUES(1,1,7),(1,2,8),(2,3,9);
    INSERT INTO wp_posts VALUES
      (1,'post','publish','','Resident Evil cosplay','',''),
      (2,'post','publish','','A try on haul','<p>Resident Evil / Body painting / a MUSIC VIDEO</p>',''),
      (3,'post','publish','','Caption','','Resident Evil'),
      (4,'post','draft','','Resident Evil / Music video','',''),
      (5,'post','publish','password','Resident Evil / Music video','',''),
      (6,'page','publish','','Resident Evil / Music video','',''),
      (7,'post','publish','','Resident Evil / Music video','',''),
      (8,'post','publish','','Elden Ring','','');`);
  db.close();
  const trash = open(path.join(dir, 'public.sqlite'));
  trash.exec('CREATE TABLE trash(post_id INTEGER PRIMARY KEY); INSERT INTO trash VALUES(7);');
  trash.close();
  return { dir, file };
}

test('backed-up additive review applies interests across categories without changing content or existing valid relationships', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  const original = open(f.file, { readOnly: true });
  const tables = ['wp_posts', 'wp_terms', 'wp_term_taxonomy', 'wp_term_relationships'];
  const rows = new Map(tables.map(table => [table, original.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  original.close();
  const preview = reviewKeywords(f.file);
  assert.equal(preview.reviewedPosts, 4);
  assert.deepEqual(preview.newInterestKeywords, [{ name: 'Resident Evil', count: 3 }]);
  assert.equal(preview.addedLinks, 3);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const backupFile = path.join(f.dir, 'before.sqlite');
  const applied = reviewKeywords(f.file, { apply: true, backupFile });
  assert.equal(applied.addedLinks, 3);
  const backup = open(backupFile, { readOnly: true });
  try {
    for (const table of tables) assert.deepEqual(backup.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows.get(table));
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { backup.close(); }
  const db = open(f.file, { readOnly: true });
  try {
    const links = db.prepare(`SELECT object_id FROM wp_term_relationships JOIN wp_term_taxonomy USING(term_taxonomy_id)
      JOIN wp_terms USING(term_id) WHERE name='Resident Evil' ORDER BY object_id`).all();
    assert.deepEqual(links.map(row => row.object_id), [1, 2, 3]);
    assert.deepEqual(db.prepare('SELECT * FROM wp_posts ORDER BY rowid').all(), rows.get('wp_posts'));
    assert.equal(db.prepare('SELECT term_order FROM wp_term_relationships WHERE object_id=1 AND term_taxonomy_id=1').get().term_order, 7);
    assert.equal(db.prepare('SELECT term_order FROM wp_term_relationships WHERE object_id=1 AND term_taxonomy_id=2').get().term_order, 8);
    assert.equal(db.prepare('SELECT term_order FROM wp_term_relationships WHERE object_id=2 AND term_taxonomy_id=3').get().term_order, 9);
  } finally { db.close(); }
  const again = reviewKeywords(f.file, { apply: true, backupFile: path.join(f.dir, 'again.sqlite') });
  assert.equal(again.addedLinks, 0);
  assert.deepEqual(again.newInterestKeywords, []);
});

test('uploads use explicit reviewed interests even before a general autotag run or existing tag', t => {
  const f = fixture(t);
  const names = tagPost(f.file, 8, 'Honkai Star Rail and a bodypainting try-on haul by Lada Lyumos');
  for (const name of ['Honkai: Star Rail', 'Body painting', 'Try-on haul', 'Lada Lyumos']) assert(names.includes(name), name);
  assert(!names.includes('Lada'));
  assert.deepEqual(tagPost(f.file, 8, 'Honkai Star Rail and a bodypainting try-on haul by Lada Lyumos').sort(), names.sort());
});

test('failed reviewed-interest writes roll back completely and retain the mandatory backup', t => {
  const f = fixture(t), db = open(f.file);
  db.exec("CREATE TRIGGER reject_interests BEFORE INSERT ON wp_term_relationships BEGIN SELECT RAISE(ABORT,'Interest write blocked'); END");
  db.close();
  const before = fs.readFileSync(f.file), backupFile = path.join(f.dir, 'rollback.sqlite');
  assert.throws(() => reviewKeywords(f.file, { apply: true, backupFile }), /Interest write blocked/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert(fs.existsSync(backupFile));
});
