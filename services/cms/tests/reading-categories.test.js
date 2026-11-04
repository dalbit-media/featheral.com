const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { open } = require('../../database/sqlite');
const { categorizeUncategorized } = require('../lib/reading-categories');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-categories-')), file = path.join(dir, 'db.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(file);
  db.exec(`CREATE TABLE wp_posts(ID INTEGER PRIMARY KEY,post_type TEXT,post_title TEXT);
    CREATE TABLE wp_terms(term_id INTEGER PRIMARY KEY,name TEXT,slug TEXT,term_group INTEGER);
    CREATE TABLE wp_term_taxonomy(term_taxonomy_id INTEGER PRIMARY KEY,term_id INTEGER,taxonomy TEXT,description TEXT,parent INTEGER,count INTEGER);
    CREATE TABLE wp_term_relationships(object_id INTEGER,term_taxonomy_id INTEGER,term_order INTEGER,PRIMARY KEY(object_id,term_taxonomy_id));
    INSERT INTO wp_terms VALUES(1,'Uncategorized','uncategorized',0),(2,'Existing','existing',0),(3,'Tag','tag',0),(4,'Photos','photos',0);
    INSERT INTO wp_term_taxonomy VALUES(1,1,'category','',0,8),(2,2,'category','',0,2),(3,3,'post_tag','',0,1),(4,4,'category','',0,1);`);
  for (let id = 1; id <= 9; id++) {
    db.prepare('INSERT INTO wp_posts VALUES(?,?,?)').run(id, id === 8 ? 'page' : id === 9 ? 'attachment' : 'post', `Post ${id}`);
    db.prepare('INSERT INTO wp_term_relationships VALUES(?,?,?)').run(id, id === 7 ? 2 : 1, 5);
  }
  db.exec('INSERT INTO wp_term_relationships VALUES(5,2,0),(1,3,7)');
  db.close();
  const types = { 1: ['jpeg'], 2: ['gif', 'jpeg'], 3: ['png'], 4: [], 5: ['gif'], 6: ['webp'], 7: ['gif'], 8: ['png'], 9: ['gif'] };
  const site = { dir, has: () => true, t: table => `"wp_${table}"`,
    postMetrics: () => new Map(Object.entries(types).map(([id, imageTypes]) => [+id, { imageTypes }])) };
  const snapshot = () => {
    const read = open(file, { readOnly: true });
    try { return ['posts', 'terms', 'term_taxonomy', 'term_relationships'].map(table => read.prepare(`SELECT * FROM wp_${table}`).all()); }
    finally { read.close(); }
  };
  return { dir, file, site, snapshot };
}

test('Uncategorized migration is a no-write dry run and moves only sole-category posts with GIF precedence', t => {
  const f = fixture(t), other = fixture(t), before = f.snapshot(), otherBefore = other.snapshot();
  assert.deepEqual(categorizeUncategorized(f.site), { applied: false, photos: 3, videos: 1, unchanged: 1 });
  assert.deepEqual(f.snapshot(), before);
  const backupFile = path.join(f.dir, 'before.sqlite');
  assert.deepEqual(categorizeUncategorized(f.site, { apply: true, backupFile }), { applied: true, photos: 3, videos: 1, unchanged: 1, backupFile });
  assert.deepEqual(other.snapshot(), otherBefore);
  const read = open(f.file, { readOnly: true }), backup = open(backupFile, { readOnly: true });
  try {
    const rels = read.prepare(`SELECT r.object_id AS id,t.slug,r.term_order AS ordering FROM wp_term_relationships r
      JOIN wp_term_taxonomy tt USING(term_taxonomy_id) JOIN wp_terms t USING(term_id) ORDER BY r.object_id,t.slug`).all().map(row => [...Object.values(row)]);
    assert.deepEqual(rels, [[1,'photos',5],[1,'tag',7],[2,'videos',5],[3,'photos',5],[4,'uncategorized',5],
      [5,'existing',0],[5,'uncategorized',5],[6,'photos',5],[7,'existing',5],[8,'uncategorized',5],[9,'uncategorized',5]]);
    assert.deepEqual(read.prepare('SELECT * FROM wp_posts').all(), before[0]);
    assert.deepEqual(backup.prepare('SELECT * FROM wp_term_relationships').all(), before[3]);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(read.prepare("SELECT count FROM wp_term_taxonomy JOIN wp_terms USING(term_id) WHERE slug='photos'").get().count, 3);
    assert.equal(read.prepare("SELECT count FROM wp_term_taxonomy JOIN wp_terms USING(term_id) WHERE slug='uncategorized'").get().count, 4);
  } finally { read.close(); backup.close(); }
  assert.deepEqual(categorizeUncategorized(f.site), { applied: false, photos: 0, videos: 0, unchanged: 1 });
  assert.throws(() => categorizeUncategorized(f.site, { apply: true, backupFile }), /new absolute backup/);
  assert.throws(() => categorizeUncategorized(f.site, { apply: true }), /new absolute backup/);
});

test('a failed category update rolls back category creation and all relationships, retaining the backup', t => {
  const f = fixture(t), db = open(f.file);
  db.exec("CREATE TRIGGER reject_move BEFORE UPDATE ON wp_term_relationships WHEN NEW.object_id=2 BEGIN SELECT RAISE(ABORT,'Migration blocked'); END");
  db.close();
  const before = f.snapshot(), backupFile = path.join(f.dir, 'rollback.sqlite');
  assert.throws(() => categorizeUncategorized(f.site, { apply: true, backupFile }), /Migration blocked/);
  assert.deepEqual(f.snapshot(), before);
  assert(fs.existsSync(backupFile));
});
