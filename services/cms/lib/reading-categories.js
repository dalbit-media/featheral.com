const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../../database/sqlite');

const STILL_TYPES = new Set(['jpeg', 'png', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tiff', 'heic']);

function categorizeUncategorized(site, { apply = false, backupFile } = {}) {
  if (!site || !['posts', 'terms', 'term_taxonomy', 'term_relationships'].every(table => site.has(table)))
    throw new Error('The selected site has no category tables');
  if (apply && (!backupFile || !path.isAbsolute(backupFile) || fs.existsSync(backupFile)))
    throw new Error('Applying category changes requires a new absolute backup file path');
  const db = open(path.join(site.dir, 'db.sqlite'), { readOnly: !apply });
  const posts = site.t('posts'), terms = site.t('terms'), taxonomy = site.t('term_taxonomy'), relationships = site.t('term_relationships');
  try {
    const metrics = site.postMetrics();
    const plan = () => {
      const categories = db.prepare(`SELECT tt.term_taxonomy_id AS id FROM ${taxonomy} tt JOIN ${terms} t USING(term_id)
        WHERE tt.taxonomy='category' AND (lower(t.slug)='uncategorized' OR lower(t.name)='uncategorized')`).all();
      const uncategorized = new Set(categories.map(row => row.id));
      const rows = db.prepare(`SELECT p.ID AS id, MIN(r.term_taxonomy_id) AS category FROM ${posts} p
        JOIN ${relationships} r ON r.object_id=p.ID JOIN ${taxonomy} tt USING(term_taxonomy_id)
        WHERE p.post_type='post' AND tt.taxonomy='category' GROUP BY p.ID HAVING COUNT(*)=1`).all();
      const moves = [], unchanged = [];
      for (const row of rows) {
        if (!uncategorized.has(row.category)) continue;
        const formats = metrics.get(row.id)?.imageTypes || [];
        const target = formats.includes('gif') ? 'videos' : formats.some(type => STILL_TYPES.has(type)) ? 'photos' : null;
        if (target) moves.push({ ...row, target });
        else unchanged.push(row.id);
      }
      return { moves, unchanged };
    };
    if (!apply) {
      const { moves, unchanged } = plan();
      return { applied: false, photos: moves.filter(row => row.target === 'photos').length,
        videos: moves.filter(row => row.target === 'videos').length, unchanged: unchanged.length };
    }
    db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
    const backup = open(backupFile, { readOnly: true });
    try {
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Category backup failed integrity verification');
    } finally { backup.close(); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const { moves, unchanged } = plan(), targets = new Map(), changed = new Set();
      for (const slug of new Set(moves.map(row => row.target))) {
        let category = db.prepare(`SELECT tt.term_taxonomy_id AS id FROM ${taxonomy} tt JOIN ${terms} t USING(term_id)
          WHERE tt.taxonomy='category' AND lower(t.slug)=?`).get(slug);
        if (!category) {
          let term = db.prepare(`SELECT term_id AS id FROM ${terms} WHERE lower(slug)=?`).get(slug);
          if (!term) {
            term = { id: (db.prepare(`SELECT MAX(term_id) AS id FROM ${terms}`).get().id || 0) + 1 };
            db.prepare(`INSERT INTO ${terms}(term_id,name,slug,term_group) VALUES(?,?,?,0)`).run(term.id, slug === 'photos' ? 'Photos' : 'Videos', slug);
          }
          category = { id: (db.prepare(`SELECT MAX(term_taxonomy_id) AS id FROM ${taxonomy}`).get().id || 0) + 1 };
          db.prepare(`INSERT INTO ${taxonomy}(term_taxonomy_id,term_id,taxonomy,description,parent,count) VALUES(?,?,'category','',0,0)`).run(category.id, term.id);
        }
        targets.set(slug, category.id);
      }
      const update = db.prepare(`UPDATE ${relationships} SET term_taxonomy_id=? WHERE object_id=? AND term_taxonomy_id=?`);
      for (const row of moves) {
        const target = targets.get(row.target);
        if (update.run(target, row.id, row.category).changes !== 1) throw new Error('A category relationship changed during migration');
        changed.add(row.category); changed.add(target);
      }
      const recount = db.prepare(`UPDATE ${taxonomy} SET count=(SELECT COUNT(*) FROM ${relationships} WHERE term_taxonomy_id=?) WHERE term_taxonomy_id=?`);
      for (const id of changed) recount.run(id, id);
      db.exec('COMMIT');
      return { applied: true, photos: moves.filter(row => row.target === 'photos').length,
        videos: moves.filter(row => row.target === 'videos').length, unchanged: unchanged.length, backupFile };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

module.exports = { categorizeUncategorized };
