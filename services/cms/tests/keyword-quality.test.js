const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { open } = require('../../database/sqlite');
const { meaningfulKeyword } = require('../lib/keyword-quality');
const { reviewKeywords } = require('../lib/keyword-review');
const { buildTags, matchExistingTags } = require('../lib/autotag');

test('keyword quality removes name fragments and boilerplate, not meaningful short topics or stage names', () => {
  for (const name of ['lee', 'Sarah', 'KIM', 'emily', 'williams', 'haul transparent', 'Final Part', 'r/example',
    'Yoo', 'YOON', 'Yu', 'Seo', 'Soo', 'Yui', 'Yua', 'Hikaru', 'Nagi', 'Miku', 'Asuka', 'Rei'])
    assert.equal(meaningfulKeyword(name), false, name);
  for (const name of ['Sarah Shahi', 'Jamie Lee Curtis', 'IU', 'CL', 'BIBI', 'Lisa', 'gym', 'art', 'cosplay', 'SONE series', 'Genshin Impact',
    'Kim Yoo-jung', 'Yoo Ji-won', 'Hikaru Nagi', 'Rei Kamiki', 'Hatsune Miku', 'Asuka Langley'])
    assert.equal(meaningfulKeyword(name), true, name);
  assert.deepEqual(matchExistingTags('Sarah Shahi and Jamie Lee Curtis', ['Sarah', 'lee', 'Sarah Shahi', 'Jamie Lee Curtis']).sort(),
    ['Jamie Lee Curtis', 'Sarah Shahi']);
  assert.deepEqual(matchExistingTags('Han Sohee and Han So-hee', ['han sohee', 'Han So-hee']), ['Han So-hee']);
  assert.deepEqual(matchExistingTags('Outdoor Star War scene', ['outdoor', 'star war']).sort(), ['Star Wars', 'outdoors']);
  assert.deepEqual(matchExistingTags('Yoo and Yua Mikami meet Rei Kamiki', ['Yoo', 'Yua', 'Rei', 'Yua Mikami', 'Rei Kamiki']).sort(),
    ['Rei Kamiki', 'Yua Mikami']);
  const posts = Array.from({ length: 15 }, (_, id) => ({ id, title: 'Sarah Shahi and Jamie Lee Curtis interview', content: '' }));
  for (const tags of buildTags(posts, { minPosts: 2 }).values()) {
    assert(tags.includes('Sarah Shahi') && tags.includes('Jamie Lee Curtis'));
    assert(tags.every(meaningfulKeyword));
  }
});

test('name review removes Yoo without guessing identities and merges Japanese aliases with a verified backup', t => {
  const f = fixture(t), db = open(f.file);
  db.exec(`INSERT INTO wp_terms VALUES(8,'Yoo','yoo',0),(9,'Mikami Yua','mikami-yua',0),(10,'Yui','yui',0);
    INSERT INTO wp_term_taxonomy VALUES(8,8,'post_tag','',0,2),(9,9,'post_tag','',0,2),(10,10,'post_tag','',0,1);
    INSERT INTO wp_posts VALUES(6,'post','publish','','Kim Yoojung and Nagi Hikaru','',''),
      (7,'post','publish','','Yoo and Yui','',''),(8,'post','publish','','Mikami Yua and Yua Mikami','',''),
      (9,'post','draft','','Mikami Yua','','');
    INSERT INTO wp_term_relationships VALUES(6,8,0),(7,8,0),(7,10,0),(8,9,0),(9,9,0);`);
  db.close();
  const before = f.snapshot(), preview = reviewKeywords(f.file);
  assert(preview.removedTags.includes('Yoo'));
  assert(preview.removedTags.includes('Yui'));
  assert(preview.mergedTags.some(tag => tag.from === 'Mikami Yua' && tag.to === 'Yua Mikami'));
  assert.deepEqual(f.snapshot(), before);
  const backupFile = path.join(f.dir, 'names-before.sqlite');
  reviewKeywords(f.file, { apply: true, backupFile });
  const read = open(f.file, { readOnly: true }), backup = open(backupFile, { readOnly: true });
  try {
    const tagsFor = id => read.prepare(`SELECT t.name FROM wp_terms t JOIN wp_term_taxonomy tt USING(term_id)
      JOIN wp_term_relationships r USING(term_taxonomy_id) WHERE tt.taxonomy='post_tag' AND object_id=? ORDER BY t.name`).all(id).map(row => row.name);
    assert.deepEqual(tagsFor(6), ['Hikaru Nagi', 'Kim Yoo-jung']);
    assert.deepEqual(tagsFor(7), [], 'surname and given-name fragments alone infer no identity');
    assert.deepEqual(tagsFor(8), ['Yua Mikami']);
    assert.deepEqual(tagsFor(9), ['Yua Mikami'], 'an existing alias link survives even on a draft');
    assert.deepEqual(read.prepare('SELECT * FROM wp_posts').all(), before[0]);
    assert.deepEqual(backup.prepare('SELECT * FROM wp_term_relationships').all(), before[3]);
    assert.equal(read.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { read.close(); backup.close(); }
  assert.equal(reviewKeywords(f.file, { apply: true, backupFile: path.join(f.dir, 'names-again.sqlite') }).addedLinks, 0);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-quality-')), file = path.join(dir, 'db.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(file);
  db.exec(`CREATE TABLE wp_posts(ID INTEGER PRIMARY KEY,post_type TEXT,post_status TEXT,post_password TEXT,post_title TEXT,post_content TEXT,post_excerpt TEXT);
    CREATE TABLE wp_terms(term_id INTEGER PRIMARY KEY,name TEXT,slug TEXT,term_group INTEGER);
    CREATE TABLE wp_term_taxonomy(term_taxonomy_id INTEGER PRIMARY KEY,term_id INTEGER,taxonomy TEXT,description TEXT,parent INTEGER,count INTEGER);
    CREATE TABLE wp_term_relationships(object_id INTEGER,term_taxonomy_id INTEGER,term_order INTEGER,PRIMARY KEY(object_id,term_taxonomy_id));
    INSERT INTO wp_terms VALUES(1,'Celebrities','celebrities',0),(2,'lee','lee',0),(3,'sarah','sarah',0),
      (4,'handpicked topic','handpicked-topic',0),(5,'han sohee','han-sohee',0),(6,'Han So-hee','han-so-hee',0),(7,'nagi hikaru','nagi-hikaru',0);
    INSERT INTO wp_term_taxonomy VALUES(1,1,'category','',0,2),(2,2,'post_tag','auto-tag',0,1),(3,3,'post_tag','',0,2),
      (4,4,'post_tag','',0,37),(5,5,'post_tag','auto-tag',0,1),(6,6,'post_tag','auto-celebrity',0,1),(7,7,'post_tag','',0,1);
    INSERT INTO wp_posts VALUES(1,'post','publish','','Sarah Shahi and Jamie Lee Curtis','',''),
      (2,'post','publish','','Britney and Sarah','',''),(3,'post','publish','','Han Sohee','',''),
      (4,'post','draft','','Sarah Shahi','',''),(5,'post','publish','','Nagi Hikaru','','');
    INSERT INTO wp_term_relationships VALUES(1,1,7),(2,1,8),(1,2,0),(1,3,0),(2,3,0),(1,4,0),(3,5,0),(3,6,0),(5,7,0),(4,7,0);`);
  db.close();
  const snapshot = () => {
    const read = open(file, { readOnly: true });
    try { return ['posts', 'terms', 'term_taxonomy', 'term_relationships'].map(table => read.prepare(`SELECT * FROM wp_${table}`).all()); }
    finally { read.close(); }
  };
  return { dir, file, snapshot };
}

test('all-tag review is a dry run by default and safely replaces fragments with explicit full names', t => {
  const f = fixture(t), before = f.snapshot(), preview = reviewKeywords(f.file);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(preview.reviewedTags, 6);
  assert.deepEqual(preview.removedTags, ['lee', 'sarah']);
  assert.equal(preview.mergedTags.length, 2);
  assert.throws(() => reviewKeywords(f.file, { apply: true }), /new absolute backup/);
  const backupFile = path.join(f.dir, 'before.sqlite');
  const result = reviewKeywords(f.file, { apply: true, backupFile });
  assert.equal(result.applied, true);
  const read = open(f.file, { readOnly: true }), backup = open(backupFile, { readOnly: true });
  try {
    assert.deepEqual(backup.prepare('SELECT * FROM wp_term_relationships').all(), before[3]);
    assert.deepEqual(read.prepare('SELECT * FROM wp_posts').all(), before[0]);
    assert.deepEqual(read.prepare('SELECT * FROM wp_term_relationships WHERE term_taxonomy_id=1').all(), before[3].filter(row => row.term_taxonomy_id === 1));
    const tagsFor = id => read.prepare(`SELECT t.name FROM wp_terms t JOIN wp_term_taxonomy tt USING(term_id)
      JOIN wp_term_relationships r USING(term_taxonomy_id) WHERE tt.taxonomy='post_tag' AND object_id=? ORDER BY t.name`).all(id).map(row => row.name);
    assert.deepEqual(tagsFor(1), ['Jamie Lee Curtis', 'Sarah Shahi', 'handpicked topic']);
    assert.deepEqual(tagsFor(2), [], 'Sarah alone never guesses an identity');
    assert.deepEqual(tagsFor(3), ['Han So-hee']);
    assert.deepEqual(tagsFor(4), ['Hikaru Nagi'], 'existing alias relationships survive on drafts without inferring new names');
    assert.deepEqual(tagsFor(5), ['Hikaru Nagi']);
    assert.equal(read.prepare('SELECT count FROM wp_term_taxonomy WHERE term_taxonomy_id=4').get().count, 1);
    assert.equal(read.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { read.close(); backup.close(); }
  const again = reviewKeywords(f.file, { apply: true, backupFile: path.join(f.dir, 'again.sqlite') });
  assert.equal(again.addedLinks, 0);
  assert.deepEqual(again.removedTags, []);
  assert.deepEqual(again.mergedTags, []);
});

test('a failed cleanup rolls back deletions and new full-name tags together', t => {
  const f = fixture(t), db = open(f.file);
  db.exec("CREATE TRIGGER reject_cleanup BEFORE INSERT ON wp_term_relationships BEGIN SELECT RAISE(ABORT,'Cleanup blocked'); END");
  db.close();
  const before = f.snapshot(), backupFile = path.join(f.dir, 'rollback.sqlite');
  assert.throws(() => reviewKeywords(f.file, { apply: true, backupFile }), /Cleanup blocked/);
  assert.deepEqual(f.snapshot(), before);
  assert(fs.existsSync(backupFile));
});
