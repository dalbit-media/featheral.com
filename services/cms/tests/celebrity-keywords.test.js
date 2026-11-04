const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { open } = require('../../database/sqlite');
const { celebrityKeywords, CELEBRITY_MARK } = require('../lib/celebrity-keywords');
const { buildTags, autotag, tagCelebrities, tagPost } = require('../lib/autotag');

test('reviewed names match aliases, Unicode, punctuation, possessives and multiple people without substring matches', () => {
  assert.deepEqual(celebrityKeywords('SYDNEY SWEENEY and Ana de Armas'), ['Sydney Sweeney', 'Ana de Armas']);
  assert.deepEqual(celebrityKeywords('Léa Seydoux & Lily-Rose Depp’s interview'), ['Léa Seydoux', 'Lily-Rose Depp']);
  assert.deepEqual(celebrityKeywords('Syndey Sweeney / Sidney Sweeney'), ['Sydney Sweeney']);
  assert.deepEqual(celebrityKeywords('Moon Kayoung, Mun Ka-young, Kim Tae Ri'), ['Moon Ga-young', 'Kim Tae-ri']);
  assert.deepEqual(celebrityKeywords('IU interview'), ['IU']);
  assert.deepEqual(celebrityKeywords('Sydney Sweeneyson and Margot Robbieson'), []);
  assert.deepEqual(celebrityKeywords('A pink dress and a rose beside Lisa and Nana'), []);
  assert.deepEqual(celebrityKeywords('Sakura and Kazuha cosplay with Momo'), [], 'ambiguous fictional names need celebrity context');
  assert.deepEqual(celebrityKeywords('Twice Momo & Le Sserafim Sakura'), ['Momo', 'Sakura']);
  assert.deepEqual(celebrityKeywords('Gal Gadot (pink bunny)', true), ['Gal Gadot']);
  assert.deepEqual(celebrityKeywords('Pink', true), ['Pink']);
  assert.deepEqual(celebrityKeywords('Jennie and Rose', true), ['Jennie', 'Rosé']);
  assert.deepEqual(celebrityKeywords('Rosé’s interview', true), ['Rosé']);
  assert.deepEqual(celebrityKeywords('Blackpink Rose'), ['Rosé']);
  assert.deepEqual(celebrityKeywords('Lisa Rinna'), ['Lisa Rinna'], 'longest names win over ambiguous stage names');
  assert.deepEqual(celebrityKeywords('Ahn Sohee & Alice Sohee', true), ['Ahn So-hee', 'Sohee']);
  assert.deepEqual(celebrityKeywords('Alice Braga, Rose Byrne, Jessica Chastain, Famke Janssen and Tao Okamoto'),
    ['Alice Braga', 'Rose Byrne', 'Jessica Chastain', 'Famke Janssen', 'Tao Okamoto']);
});

test('full autotagging keeps rare reviewed celebrity keywords without turning boilerplate or ambiguous body words into names', () => {
  const tags = buildTags([
    { id: 1, title: 'Ana de Armas interview', content: '' },
    { id: 2, title: 'JENNIE', content: '', celebrity: true },
    { id: 3, title: 'A pink dress', content: '<p>A rose.</p>' },
    { id: 4, title: 'Photo', content: '<a href="https://reddit.com/u/Ana_de_Armas">/u/Ana_de_Armas</a> [comments]' },
    { id: 5, title: 'Caption', content: '<p>Lily-Rose Depp’s interview.</p>' },
  ]);
  assert.deepEqual(tags.get(1), ['Ana de Armas']);
  assert.deepEqual(tags.get(2), ['Jennie']);
  assert.deepEqual(tags.get(3), []);
  assert.deepEqual(tags.get(4), []);
  assert.deepEqual(tags.get(5), ['Lily-Rose Depp']);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'celebrity-keywords-')), file = path.join(dir, 'db.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(file);
  db.exec(`CREATE TABLE wp_posts(ID INTEGER PRIMARY KEY,post_type TEXT,post_status TEXT,post_password TEXT,post_title TEXT,post_content TEXT,post_excerpt TEXT);
    CREATE TABLE wp_terms(term_id INTEGER PRIMARY KEY,name TEXT,slug TEXT,term_group INTEGER);
    CREATE TABLE wp_term_taxonomy(term_taxonomy_id INTEGER PRIMARY KEY,term_id INTEGER,taxonomy TEXT,description TEXT,parent INTEGER,count INTEGER);
    CREATE TABLE wp_term_relationships(object_id INTEGER,term_taxonomy_id INTEGER,term_order INTEGER,PRIMARY KEY(object_id,term_taxonomy_id));
    INSERT INTO wp_terms VALUES(1,'Celebrities','celebrities',0),(2,'Handmade','handmade',0),(3,'Existing auto','existing-auto',0),(4,'ana de armas','ana-de-armas',0);
    INSERT INTO wp_term_taxonomy VALUES(1,1,'category','',0,1),(2,2,'post_tag','',0,1),(3,3,'post_tag','auto-tag',0,1),(4,4,'post_tag','',0,1);
    INSERT INTO wp_term_relationships VALUES(1,1,7),(1,2,8),(2,3,9),(1,4,0);
    INSERT INTO wp_posts VALUES
      (1,'post','publish','','Ana de Armas & Jennie','',''),
      (2,'post','publish','','Caption','<p>Ana de Armas and Sydney Sweeney</p>',''),
      (3,'post','draft','','Sydney Sweeney','',''),
      (4,'post','publish','password','Sydney Sweeney','',''),
      (5,'page','publish','','Sydney Sweeney','',''),
      (6,'post','publish','','Sydney Sweeney','',''),
      (7,'post','publish','','Unknown person','',''),
      (8,'post','publish','','Caption','','Lily-Rose Depp');
    INSERT INTO wp_term_relationships VALUES(7,1,0);`);
  db.close();
  const trash = open(path.join(dir, 'public.sqlite'));
  trash.exec('CREATE TABLE trash(post_id INTEGER PRIMARY KEY); INSERT INTO trash VALUES(6);');
  trash.close();
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  const snapshot = () => {
    const read = open(file, { readOnly: true });
    try { return ['posts', 'terms', 'term_taxonomy', 'term_relationships'].map(table => read.prepare(`SELECT * FROM wp_${table}`).all()); }
    finally { read.close(); }
  };
  return { dir, file, snapshot };
}

test('celebrity backfill is additive, backed up, idempotent and applies across categories but never to protected or trashed posts', t => {
  const f = fixture(t), before = f.snapshot();
  const preview = tagCelebrities(f.file);
  assert.deepEqual(f.snapshot(), before, 'dry run never writes');
  assert.equal(preview.reviewed, 2);
  assert.equal(preview.matchedPosts, 3);
  assert.equal(preview.keywords, 4);
  assert.deepEqual(preview.unmatchedCelebrityPosts, [7]);
  assert.throws(() => tagCelebrities(f.file, { apply: true }), /new absolute backup/);
  const backupFile = path.join(f.dir, 'before.sqlite');
  const applied = tagCelebrities(f.file, { apply: true, backupFile });
  assert.equal(applied.addedLinks, 4);
  const db = open(f.file, { readOnly: true }), backup = open(backupFile, { readOnly: true });
  try {
    assert.deepEqual(backup.prepare('SELECT * FROM wp_term_relationships').all(), before[3]);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('SELECT * FROM wp_posts').all(), before[0]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wp_terms WHERE lower(name)='ana de armas'").get().n, 1, 'existing manual name tag is reused');
    assert.equal(db.prepare('SELECT count FROM wp_term_taxonomy WHERE term_taxonomy_id=4').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wp_term_taxonomy WHERE description=?").get(CELEBRITY_MARK).n, 3);
    for (const id of [1, 2, 3]) assert.deepEqual(db.prepare('SELECT * FROM wp_term_taxonomy WHERE term_taxonomy_id=?').get(id), before[2][id - 1]);
    for (const id of [3, 4, 5, 6]) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wp_term_relationships WHERE object_id=?').get(id).n, 0);
  } finally { db.close(); backup.close(); }
  assert.throws(() => tagCelebrities(f.file, { apply: true, backupFile }), /new absolute backup/);
  assert.equal(tagCelebrities(f.file, { apply: true, backupFile: path.join(f.dir, 'second.sqlite') }).addedLinks, 0);
  assert.deepEqual(tagPost(f.file, 7, 'Lily-Rose Depp interview'), ['Lily-Rose Depp', 'Interview'], 'new posts can reuse a reviewed name with just one prior post and add a reviewed theme');
  assert.deepEqual(tagPost(f.file, 7, 'Emma Stone interview').sort(), ['Emma Stone', 'Interview'], 'new names can be created from the reviewed catalogue');
  const prior = f.snapshot()[2].filter(row => row.description === CELEBRITY_MARK);
  autotag(f.file);
  const after = f.snapshot()[2].filter(row => row.description === CELEBRITY_MARK);
  assert.deepEqual(after, prior, 'general autotag reruns preserve reviewed name taxonomy IDs and counts');
  const missing = path.join(f.dir, 'missing.sqlite');
  assert.throws(() => tagCelebrities(missing), /does not exist/);
  assert(!fs.existsSync(missing));
});

test('celebrity backfill rolls back a failed write and preserves its verified backup', t => {
  const f = fixture(t), db = open(f.file);
  db.exec("CREATE TRIGGER reject_tag BEFORE INSERT ON wp_term_relationships WHEN NEW.object_id=2 BEGIN SELECT RAISE(ABORT,'Tagging blocked'); END");
  db.close();
  const before = f.snapshot(), backupFile = path.join(f.dir, 'rollback.sqlite');
  assert.throws(() => tagCelebrities(f.file, { apply: true, backupFile }), /Tagging blocked/);
  assert.deepEqual(f.snapshot(), before);
  assert(fs.existsSync(backupFile));
});
