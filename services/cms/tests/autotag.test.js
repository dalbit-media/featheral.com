const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { open } = require('../../database/sqlite');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { buildTags, autotag, tagPost, titleLabels, matchExistingTags, AUTO_MARK } = require('../lib/autotag');

const reddit = (sub, body = '') => `<table><tr><td><a href="https://www.reddit.com/r/${sub}/comments/abc/x/">img</a></td><td>`
  + `<!-- SC_OFF --><div class="md"><p>${body}</p></div><!-- SC_ON --> submitted by <a href="https://www.reddit.com/user/someone"> /u/someone </a>`
  + ' <span><a href="https://i.redd.it/x.jpg">[link]</a></span> <span><a href="https://reddit.com/r/x">[comments]</a></span></td></tr></table>';

const story = (extra) => Array.from({ length: 40 }, (_, i) => `The lighthouse keeper climbed the spiral staircase during the thunderstorm number ${i}. `
  + `Her lingerie and stockings lay by the hotel pool while the massage oil glowed. ${extra} `).join(' ');

function corpus() {
  const posts = [];
  let id = 1;
  for (let i = 0; i < 6; i++) posts.push({ id: id++, title: `Sunset beach bikini ${i}`, content: reddit('BabesNSFW') });
  for (let i = 0; i < 4; i++) posts.push({ id: id++, title: `Lighthouse night [M30/F28] [Romance] [Slow Burn] part ${i}`, content: reddit('eroticliterature', story('She hummed softly.')) });
  for (let i = 0; i < 3; i++) posts.push({ id: id++, title: `[ABP-10${i}] Office lady`, content: reddit('jav') });
  for (let i = 0; i < 3; i++) posts.push({ id: id++, title: 'Ali Larter', content: reddit('nsfwcelebs') });
  for (let i = 0; i < 30; i++) posts.push({ id: id++, title: `Filler post ${i} mountain cabin`, content: reddit('Other') });
  return posts;
}

test('title labels skip age/gender codes and keep kinks, fandoms and JAV series', () => {
  const r = titleLabels('Hinata (Sweetie_Fox) [Naruto] [M25/F23] [OC] [Car Sex] [JUR-252] [Part 2] &amp; more');
  assert.deepEqual(r.labels.sort(), ['car sex', 'naruto', 'sweetie fox']);
  assert.deepEqual(r.series, ['jur']);
});

test('tags come from labels, series and keywords; reviewed celebrity names are exempt from the topic minimum', () => {
  const tags = buildTags(corpus(), { maxDfRatio: 0.2, minPosts: 2 });
  assert.ok(![...tags.values()].flat().some((t) => t.startsWith('r/')), 'no subreddit tags');
  const use = new Map();
  for (const t of [...buildTags(corpus(), { maxDfRatio: 0.2, minPosts: 5 }).values()].flat()) use.set(t, (use.get(t) || 0) + 1);
  assert.ok(use.size > 0 && [...use].every(([name, n]) => n >= 5 || name === 'Ali Larter'), JSON.stringify([...use]));
  assert.ok(tags.get(1).some((t) => /bikini|beach/.test(t)), tags.get(1).join());
  const lit = tags.get(7);
  assert.ok(lit.includes('romance') && lit.includes('slow burn'), lit.join());
  assert.ok(lit.some((t) => /lingerie|stocking|hotel|pool|massage/.test(t)), lit.join());
  assert.ok(!lit.some((t) => /lighthouse|thunderstorm|staircase|keeper|spiral|glowed/.test(t)), `only meaningful keywords: ${lit.join()}`);
  assert.ok(!tags.get(17).some((t) => /filler|mountain|cabin/.test(t)), tags.get(17).join());
  assert.ok(!lit.some((t) => /submitted|someone|link|comments|reddit|m30/.test(t)), lit.join());
  assert.ok(lit.length > tags.get(1).length + 3, 'long story gets more tags');
  assert.ok(tags.get(11).includes('ABP series'), tags.get(11).join());
  assert.ok(tags.get(14).includes('Ali Larter'), tags.get(14).join());
  assert.deepEqual(matchExistingTags('My new bikini at the beach', ['bikini', 'r/BabesNSFW', 'Ali Larter', 'beach']).sort(), ['beach', 'bikini']);
});

test('autotag writes post_tag terms idempotently, keeps manual tags and feeds the admin term filter', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'autotag-test-'));
  const key = path.basename(dir);
  t.after(() => { dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  for (const p of corpus()) {
    posts.set(p.id, { ID: p.id, post_type: 'post', post_status: 'publish', post_content: p.content, post_title: p.title, post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 });
  }
  const manifest = { key, site: 'Tag test', status: 'ready' };
  const dbFile = path.join(dir, 'db.sqlite');
  new SyncRunner().writeDb(dbFile, key, { posts, postmeta: [], terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [] },
    { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  const raw = open(dbFile);
  const prefix = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get().name.replace(/term_taxonomy$/, '');
  raw.prepare(`INSERT INTO ${prefix}terms VALUES (1, 'Handpicked', 'handpicked', 0)`).run();
  raw.prepare(`INSERT INTO ${prefix}term_taxonomy VALUES (1, 1, 'post_tag', '', 0, 1)`).run();
  raw.prepare(`INSERT INTO ${prefix}term_relationships VALUES (1, 1, 0)`).run();
  raw.close();

  const first = autotag(dbFile, { minPosts: 2 });
  assert.equal(first.removed, 0);
  assert.ok(first.tags >= 5 && first.links >= 12, JSON.stringify([first.tags, first.links]));
  const second = autotag(dbFile, { minPosts: 2 });
  assert.deepEqual([second.removed, second.tags, second.links], [first.tags, first.tags, first.links]);

  const db = open(dbFile, { readOnly: true });
  const auto = db.prepare(`SELECT COUNT(*) AS n FROM ${prefix}term_taxonomy WHERE description = ?`).get(AUTO_MARK).n;
  assert.equal(auto, first.tags, 'no duplicate terms after rerun');
  const manual = db.prepare(`SELECT count FROM ${prefix}term_taxonomy WHERE term_taxonomy_id = 1`).get();
  assert.equal(manual.count, 1, 'manual tag kept');
  const bad = db.prepare(`SELECT COUNT(*) AS n FROM ${prefix}term_taxonomy tt WHERE count <> (SELECT COUNT(*) FROM ${prefix}term_relationships r WHERE r.term_taxonomy_id = tt.term_taxonomy_id)`).get().n;
  assert.equal(bad, 0, 'counts match relationships');
  const lit = db.prepare(`SELECT tt.term_taxonomy_id AS id FROM ${prefix}term_taxonomy tt JOIN ${prefix}terms t USING (term_id) WHERE t.name = 'romance'`).get();
  db.close();

  const site = getSite(key);
  const listed = site.posts({ term: lit.id, type: 'post' });
  assert.equal(listed.total, 4);
  const tagGroup = site.taxonomies().find((g) => g.taxonomy === 'post_tag');
  assert.equal(tagGroup.count, first.tags + 1);

  dropSite(key);
  const added = tagPost(dbFile, 16, 'Ali Larter on a sunset beach');
  assert.ok(added.includes('Ali Larter') && added.includes('r/BabesNSFW') === false, added.join());
  const after = open(dbFile, { readOnly: true });
  const stillOk = after.prepare(`SELECT COUNT(*) AS n FROM ${prefix}term_taxonomy tt WHERE count <> (SELECT COUNT(*) FROM ${prefix}term_relationships r WHERE r.term_taxonomy_id = tt.term_taxonomy_id)`).get().n;
  after.close();
  assert.equal(stillOk, 0);
});
