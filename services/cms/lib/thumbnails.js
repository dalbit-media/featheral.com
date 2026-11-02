// Moves posts into the WordPress "Thumbnails" category of a stored data set: the category is
// created if needed, the posts lose their other categories (tags are kept) and category counts
// are recomputed.
const { open } = require('../../db-api/sqlite');

function moveToThumbnails(dbFile, ids, { name = 'Thumbnails', slug = 'thumbnails' } = {}) {
  const db = open(dbFile);
  try {
    const prefix = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get()?.name.replace(/term_taxonomy$/, '');
    if (prefix == null) throw new Error('This data set has no category tables');
    const [TM, TT, TR] = ['terms', 'term_taxonomy', 'term_relationships'].map((t) => prefix + t);
    db.exec('BEGIN');
    try {
      let tt = db.prepare(`SELECT tt.term_taxonomy_id AS id FROM ${TT} tt JOIN ${TM} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'category' AND t.slug = ?`).get(slug)?.id;
      if (!tt) {
        const termId = (db.prepare(`SELECT MAX(term_id) AS m FROM ${TM}`).get().m || 0) + 1;
        db.prepare(`INSERT INTO ${TM} (term_id, name, slug, term_group) VALUES (?, ?, ?, 0)`).run(termId, name, slug);
        tt = (db.prepare(`SELECT MAX(term_taxonomy_id) AS m FROM ${TT}`).get().m || 0) + 1;
        db.prepare(`INSERT INTO ${TT} (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (?, ?, 'category', '', 0, 0)`).run(tt, termId);
      }
      const drop = db.prepare(`DELETE FROM ${TR} WHERE object_id = ? AND term_taxonomy_id IN (SELECT term_taxonomy_id FROM ${TT} WHERE taxonomy = 'category' AND term_taxonomy_id <> ?)`);
      const add = db.prepare(`INSERT OR IGNORE INTO ${TR} (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)`);
      let moved = 0;
      for (const id of ids) {
        drop.run(id, tt);
        if (add.run(id, tt).changes) moved++;
      }
      db.exec(`UPDATE ${TT} SET count = (SELECT COUNT(*) FROM ${TR} r WHERE r.term_taxonomy_id = ${TT}.term_taxonomy_id) WHERE taxonomy = 'category'`);
      db.exec('COMMIT');
      const total = db.prepare(`SELECT count FROM ${TT} WHERE term_taxonomy_id = ?`).get(tt).count;
      return { termTaxonomyId: tt, moved, total };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
}

module.exports = { moveToThumbnails };
