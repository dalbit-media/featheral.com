const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../../database/sqlite');
const { tablePrefix, loadPosts, buildCelebrityTags, applyTags, slugify } = require('./autotag');
const { meaningfulKeyword, canonicalKeyword, keywordKey } = require('./keyword-quality');
const { canonicalCelebrityName } = require('./celebrity-keywords');
const { loadTrashed } = require('./wp');

function reviewKeywords(dbFile, { apply = false, backupFile } = {}) {
  if (!fs.existsSync(dbFile)) throw new Error('The selected site database does not exist');
  if (apply && (!backupFile || !path.isAbsolute(backupFile) || fs.existsSync(backupFile)))
    throw new Error('Keyword cleanup requires a new absolute backup file path');
  const db = open(dbFile, { readOnly: !apply });
  try {
    if (apply && db.readOnlyReplica) throw new Error('This is a read-only replica. Run keyword cleanup on the writable source server.');
    const prefix = tablePrefix(db);
    const trashed = loadTrashed(path.join(path.dirname(dbFile), 'public.sqlite'));
    const posts = loadPosts(db, prefix).filter(post => !trashed.has(post.id));
    const byPost = buildCelebrityTags(posts);
    const tags = db.prepare(`SELECT tt.term_taxonomy_id AS id, t.name FROM ${prefix}term_taxonomy tt
      JOIN ${prefix}terms t USING(term_id) WHERE tt.taxonomy='post_tag' ORDER BY tt.term_taxonomy_id`).all();
    const decisions = tags.map(tag => {
      if (!meaningfulKeyword(tag.name)) return { ...tag, action: 'remove' };
      const canonical = canonicalCelebrityName(tag.name) || canonicalKeyword(tag.name);
      return { ...tag, action: keywordKey(canonical) !== keywordKey(tag.name) ? 'merge' : 'keep', canonical };
    });
    const changed = decisions.filter(tag => tag.action !== 'keep');
    const relations = db.prepare(`SELECT object_id FROM ${prefix}term_relationships WHERE term_taxonomy_id=?`);
    for (const tag of changed.filter(tag => tag.action === 'merge')) {
      for (const { object_id: id } of relations.all(tag.id)) {
        const names = new Set(byPost.get(id) || []);
        names.add(tag.canonical);
        byPost.set(id, [...names]);
      }
    }
    const existing = new Map(tags.filter(tag => !changed.some(change => change.id === tag.id))
      .map(tag => [slugify(tag.name), tag.id]));
    const hasLink = db.prepare(`SELECT 1 FROM ${prefix}term_relationships WHERE object_id=? AND term_taxonomy_id=?`);
    let addedLinks = 0;
    for (const [id, names] of byPost) {
      for (const name of names) if (!existing.has(slugify(name)) || !hasLink.get(id, existing.get(slugify(name)))) addedLinks++;
    }
    let stats;
    if (apply) {
      db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
      const backup = open(backupFile, { readOnly: true });
      try {
        if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Keyword backup failed integrity verification');
      } finally { backup.close(); }
      stats = applyTags(db, prefix, byPost, { replaceAuto: false, marker: 'auto-celebrity', removeTagIds: changed.map(tag => tag.id), recountAll: true });
      const manifest = path.join(path.dirname(dbFile), 'manifest.json');
      if (fs.existsSync(manifest)) { const now = new Date(); fs.utimesSync(manifest, now, now); }
    }
    return {
      applied: apply, reviewedTags: tags.length, reviewedPosts: posts.length,
      removedTags: decisions.filter(tag => tag.action === 'remove').map(tag => tag.name),
      mergedTags: decisions.filter(tag => tag.action === 'merge').map(tag => ({ from: tag.name, to: tag.canonical })),
      retainedTags: decisions.filter(tag => tag.action === 'keep').length,
      matchedPosts: byPost.size, addedLinks: stats ? stats.links : addedLinks,
      ...(apply ? { backupFile } : {}),
    };
  } finally { db.close(); }
}

module.exports = { reviewKeywords };
