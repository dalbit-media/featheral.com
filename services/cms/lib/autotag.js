// Automatic keyword tagging. Each published post gets "post_tag" terms from the [bracket] / (paren)
// labels in its title, JAV code series and TF-IDF keywords from the title and body (no subreddit
// tags). Longer posts get more keyword tags; tags on fewer than MIN_POSTS posts are dropped. Auto tags carry the description AUTO_MARK, so a
// rerun replaces them without touching hand-made tags.
const path = require('path');
const { open } = require('../../database/sqlite');
const { htmlToText, decodeEntities } = require('./text');

const AUTO_MARK = 'auto-tag';
// every tag must group at least this many posts
const MIN_POSTS = 10;

const STOP = new Set(`
a about above after again against all almost alone along already also although always am among an and another any anybody anyone
anything anyway anywhere are aren around as at away back be became because become been before began behind being below beside
besides best better between beyond both but by came can cannot cant could couldn did didn do does doesn doing don done down during
each either else enough even ever every everyone everything except few find first for found from further get gets getting give
given gives go goes going gone got gotten had hadn has hasn have haven having he her here hers herself him himself his how however
i if in into is isn it its itself just keep kept know knew known last later least less let lets like likely made make makes making
many may maybe me might mine more most mostly much must my myself near need needed never new next no nobody none nor not nothing now
of off often oh ok okay on once one only onto or other others our ours ourselves out over own part per perhaps put quite rather
really said same saw say says see seem seemed seems seen several shall she should shouldn show since so some somebody someone
something sometimes somewhere soon still such sure take taken than that the their theirs them themselves then there these they thing
things think this those though thought through thus till to together too took toward towards try trying two under until up upon us
use used very via want wanted was wasn way we well went were weren what whatever when where whether which while who whom whose why
will with within without won would wouldn yeah yes yet you your yours yourself yourselves ll ve re im ive id youre theyre thats dont
cant wont didnt doesnt isnt wasnt couldnt wouldnt shouldnt hes shes its lets whats theres heres
also around asked away began came come comes coming could day days felt feel feeling feels look looked looking looks moment
moments right left time times told turned turn eyes hand hands head face pulled pushed started start tell trying tried went
little bit lot lots big good great nice pretty real new old long felt still enough every whole half anything anyone everything
submitted link comments comment reddit www http https com jpg jpeg png gif gifv webp mp4 imgur redgifs gfycat preview amp
post posts posted sub subreddit thread upvote upvotes edit update op oc nsfw sfw pic pics picture pictures photo photos video
videos clip watch full source credit thanks thank please enjoy enjoyed hope new today tonight anyone guys guy girl girls
code name view ready help ill type choose waiting wanna gonna gotta hehe lol omg tho kinda sorta stay starts able
breath lip lips mouth voice smile grin nod nodded whispered moaned gasped glanced hitched parted tightened bottom deep
morning night minute minutes second seconds hour hours week year years later room door floor wall
three four five six seven eight nine ten twenty hundred hear heard open opened clear miss check step stood held sat stand sit
lay laid kept leave left walk walked talk talked ask asked call called move moved hold sound sounds watch watched wait close
probably actually definitely completely finally suddenly slowly quickly immediately exactly simply barely nearly instead
`.trim().split(/\s+/));

const JAV_RE = /\b([A-Z]{2,6})-\d{2,5}[A-Z]?\b/g;

// Topical words that make a useful keyword tag even though they are not names: body, look, ethnicity,
// outfit, act, place, role and genre. Keywords must be one of these or a proper noun (see casing()).
const TOPIC = new Set(`
pussy tit titty tiddy boob boobie breast nipple areola ass butt booty butthole asshole cock dick penis clit vagina labia thigh leg feet
foot toe belly navel tummy abs waist hip curve armpit tongue muscle tattoo piercing tanline bush pubic hairy shaved
petite busty thick thicc curvy chubby skinny slim athletic tall tiny pale tan tanned redhead blonde brunette ginger goth emo alt
nerdy nerd tomboy bimbo baddie gyaru milf gilf mature teen virgin pregnant pawg bbw flexible perky natural innie pierced tattooed
asian korean japanese chinese thai vietnamese filipina filipino indian latina ebony wasian singaporean indonesian malaysian
taiwanese russian ukrainian german french british brazilian colombian mexican arab persian european american canadian australian
creampie creampied anal blowjob handjob titjob footjob deepthroat facial cumshot cum squirt squirting orgasm masturbation
masturbating fingering riding cowgirl doggy doggystyle missionary threesome foursome orgy gangbang lesbian bisexual dildo vibrator
toy strip striptease twerk twerking massage oiled oil breeding bondage bdsm spanking spank choking rimming pegging swallow
backshots bukkake cuckold hotwife cheating fetish kink submissive dom domme femdom roleplay tied rope
lingerie panty bra bikini dress skirt stocking fishnet heel thong underwear uniform cosplay costume swimsuit leotard legging
pantyhose corset latex leather sweater hoodie robe towel bodysuit glasses socks sheer transparent topless braless nude naked
nudity undress
beach pool shower bath bathtub bathroom bed bedroom gym workout yoga office hotel car outdoor outdoors kitchen classroom school
college forest nature boat island sauna balcony mirror
wife husband hubby girlfriend boyfriend mom mommy mother dad daddy stepmom stepsister stepbrother stepdaughter sister brother
daughter teacher student nurse maid secretary boss neighbor neighbour babysitter cheerleader roommate coworker stranger
pornstar camgirl streamer gamer dancer idol actress model doctor
jav hentai anime manga cartoon pov amateur homemade selfie photoshoot onlyfans asmr ppv uncensored solo couple vintage retro
celebrity celeb kpop gravure compilation haul tutorial
christmas halloween valentine birthday wedding holiday summer
`.trim().split(/\s+/));
// Capitalised often enough to look like names, but they group nothing useful.
const NOT_TOPIC = new Set(`
monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october
november december master crown moon ocean story instant access award edition league queen king lord god heaven sir mister miss
`.trim().split(/\s+/));

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'tag';
}

function cleanLabel(raw) {
  const s = decodeEntities(raw).replace(/&/g, ' and ').replace(/[“”"’']/g, '').replace(/_/g, ' ').replace(/^[\s_*~.-]+|[\s_*~.-]+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length < 3 || s.length > 32) return null;
  if (/\d/.test(s)) return null; // ages/genders (F24M30), 4K, part 2, dates
  if (s.split(' ').length > 4) return null;
  if (/^(oc|nc|f|m|ff|mf|fm|mm|ffm|mmf|part|pt|cont|continued|repost|request|original|other|misc|nsfw|sfw)$/.test(s)) return null;
  if (/[\/|:;,!?]/.test(s)) return null;
  return s;
}

function titleLabels(title) {
  const t = decodeEntities(title);
  const out = new Set();
  const series = new Set();
  for (const m of t.matchAll(JAV_RE)) series.add(m[1].toLowerCase());
  for (const m of t.matchAll(/\[([^\]]{2,60})\]|\(([^)]{2,60})\)/g)) {
    const inner = m[1] || m[2];
    for (const part of inner.split(/\s*[,/]\s*|\]\s*\[/)) {
      const l = cleanLabel(part);
      if (l) out.add(l);
    }
  }
  return { labels: [...out], series: [...series] };
}

function bodyText(html) {
  return htmlToText(html)
    .replace(/submitted by\s+\/?u\/\S+/gi, ' ')
    .replace(/\[(link|comments)\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[ur]\/[\w-]+/g, ' ');
}

function tokens(text, caps) {
  const words = String(text).replace(/[’']s\b/g, '').replace(/[’']/g, '').match(/[A-Za-z]+/g) || [];
  return words.map((orig, i) => {
    const w = orig.toLowerCase();
    if (w.length < 3 || STOP.has(w)) return null;
    // count capitalised uses away from sentence starts to spot names in stories
    if (caps && i > 0) { const c = caps.get(w) || [0, 0]; c[0]++; if (orig[0] !== w[0]) c[1]++; caps.set(w, c); }
    return w;
  });
}

function subredditOf(html) {
  const m = String(html || '').match(/reddit\.com\/r\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

// How often each word (and wanted two-word phrase) is capitalised away from the start of a sentence,
// over post texts and the titles not written in Title Case. Names, places and brands mostly are.
// Words are counted in their canonical form; ALL-CAPS words say nothing and are skipped.
function casing(texts, canon, wantPair) {
  const words = new Map();
  const pairs = new Map();
  const inc = (m, k, cap) => { const c = m.get(k) || [0, 0]; c[0]++; if (cap) c[1]++; m.set(k, c); };
  for (const text of texts) {
    for (const sent of text.split(/[.!?:;\n\r"“”()[\]{}|*#>]+/)) {
      const ws = sent.replace(/[’']s\b/g, '').replace(/[’']/g, '').match(/[A-Za-z]+/g) || [];
      let prev = null;
      for (let i = 0; i < ws.length; i++) {
        const o = ws[i];
        const shout = o.length > 1 && o === o.toUpperCase();
        const lower = o.toLowerCase();
        const w = canon.get(lower) || lower;
        const cap = !shout && o[0] !== lower[0];
        if (i > 0 && !shout && w.length >= 3) inc(words, w, cap);
        // at a sentence start only the second word of a phrase tells (“Margot Robbie in …”)
        if (prev && !shout && wantPair(prev.w + ' ' + w)) inc(pairs, prev.w + ' ' + w, (prev.first || prev.cap) && cap);
        prev = shout ? null : { w, cap, first: i === 0 };
      }
    }
  }
  const proper = (m, k) => { const c = m.get(k); return !!c && c[0] >= 3 && c[1] / c[0] >= 0.6; };
  return { word: (w) => proper(words, w), phrase: (k) => proper(pairs, k) };
}

const isTitleCase = (title) => {
  const long = title.match(/[A-Za-z]{4,}/g) || [];
  return long.length >= 2 && long.filter((w) => w[0] !== w[0].toLowerCase()).length / long.length >= 0.7;
};

// posts: [{ id, title, content }] -> Map(id -> [tag names])
function buildTags(posts, opts = {}) {
  const minDf = opts.minDf || 3;
  const maxDfRatio = opts.maxDfRatio || 0.08;
  const groupDfRatio = opts.groupDfRatio || 0.2;
  const maxTags = opts.maxTags || 30;
  const minPosts = opts.minPosts || MIN_POSTS;
  const N = posts.length;
  const caps = new Map();

  const docs = posts.map((p) => {
    const title = decodeEntities(p.title || '');
    const titleClean = title.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
    const body = bodyText(p.content || '');
    const tTok = tokens(titleClean);
    const bTok = tokens(body, caps);
    const { labels, series } = titleLabels(title);
    const name = titleClean.replace(/\s+/g, ' ').trim();
    if (/^\p{Lu}[\p{L}'’.-]+( \p{Lu}[\p{L}'’.-]+){1,3}$/u.test(name) && !name.split(' ').some((w) => STOP.has(w.toLowerCase()))) labels.push(name);
    return { id: p.id, sub: subredditOf(p.content), tTok, bTok, labels, series, words: bTok.filter(Boolean).length + tTok.filter(Boolean).length,
      texts: isTitleCase(title) ? [body] : [title, body] };
  });

  // plural -> singular when the singular exists in the corpus
  const raw = new Map();
  for (const d of docs) for (const w of d.tTok.concat(d.bTok)) if (w) raw.set(w, (raw.get(w) || 0) + 1);
  const canon = new Map();
  for (const w of raw.keys()) {
    let s = w;
    if (w.length > 4 && w.endsWith('ies') && raw.has(w.slice(0, -3) + 'y')) s = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && raw.has(w.slice(0, -1))) s = w.slice(0, -1);
    canon.set(w, s);
  }

  const df = new Map();
  const subDf = new Map();
  const subN = new Map();
  const labelDf = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const d of docs) {
    const terms = new Map();
    const inTitle = new Set();
    const add = (k, w) => { terms.set(k, (terms.get(k) || 0) + w); if (w > 1) inTitle.add(k); };
    for (const [arr, weight] of [[d.tTok, 3], [d.bTok, 1]]) {
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i]) continue;
        const a = canon.get(arr[i]);
        add(a, weight);
        if (arr[i + 1]) add(a + ' ' + canon.get(arr[i + 1]), weight);
      }
    }
    d.terms = terms;
    d.inTitle = inTitle;
    const sk = d.sub ? d.sub.toLowerCase() : '';
    inc(subN, sk);
    for (const k of terms.keys()) {
      inc(df, k);
      const sd = subDf.get(sk) || new Map();
      inc(sd, k);
      subDf.set(sk, sd);
    }
    for (const l of new Set(d.labels.concat(d.series.map((s) => s + ' series')))) inc(labelDf, l);
  }
  const properNoun = (w) => { const c = caps.get(w); return c && c[0] >= 3 && c[1] / c[0] > 0.6; };
  // story filler: names, past-tense verbs and adverbs that only appear in the body
  const bodyNoise = (k) => k.split(' ').some((w) => properNoun(w) || /(ed|ly)$/.test(w));
  // Only meaningful keywords become tags: names (capitalised mid-sentence across the posts) and topical
  // words. A phrase passes when it is a name itself or every word in it passes.
  const cased = casing(docs.flatMap((d) => d.texts), canon, (k) => (df.get(k) || 0) >= minDf + 2);
  for (const d of docs) delete d.texts;
  const meaningful = (k) => {
    const parts = k.split(' ');
    const ok = (w) => !NOT_TOPIC.has(w) && (TOPIC.has(w) || cased.word(w));
    return parts.length === 1 ? ok(k) : (cased.phrase(k) && parts.some(ok)) || parts.every(ok);
  };

  const out = new Map();
  for (const d of docs) {
    const tags = [];
    const seen = new Set();
    const covered = new Set();
    const push = (t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(t);
      for (const w of key.split(' ')) covered.add(canon.get(w) || w);
    };
    const sk = d.sub ? d.sub.toLowerCase() : '';
    for (const s of d.series) if (labelDf.get(s + ' series') >= minPosts) push(s.toUpperCase() + ' series');
    for (const l of d.labels) if (labelDf.get(l) >= minPosts) push(l);

    const sN = subN.get(sk) || 0;
    const sd = subDf.get(sk);
    const scored = [];
    for (const [k, tf] of d.terms) {
      const isBigram = k.includes(' ');
      const f = df.get(k);
      if (f < (isBigram ? minDf + 2 : minDf) || f > maxDfRatio * N) continue;
      if (sN >= 30 && sd.get(k) > groupDfRatio * sN) continue;
      if (isBigram && k.split(' ')[0] === k.split(' ')[1]) continue;
      if (!d.inTitle.has(k) && bodyNoise(k)) continue;
      if (!meaningful(k)) continue;
      const score = (1 + Math.log(tf)) * Math.log(N / f) * (isBigram ? 1.3 : 1);
      scored.push([k, score]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const want = Math.min(maxTags, 3 + Math.floor(d.words / 60));
    let added = 0;
    const fixed = tags.length;
    for (const [k] of scored) {
      if (added >= want * 2) break;
      if (seen.has(k)) continue;
      const parts = k.split(' ');
      if (parts.length === 1 && covered.has(k)) continue;
      if (parts.length === 2 && parts.every((w) => covered.has(w))) continue;
      push(k);
      added++;
    }
    out.set(d.id, { tags, fixed, want });
  }
  // a tag on fewer than minPosts posts groups too little; extra ranked candidates fill the gaps left by such tags
  const used = new Map();
  for (const { tags } of out.values()) for (const t of tags) used.set(t, (used.get(t) || 0) + 1);
  for (const [id, { tags, fixed, want }] of out) {
    const shared = (t) => used.get(t) >= minPosts;
    out.set(id, tags.slice(0, fixed).filter(shared).concat(tags.slice(fixed).filter(shared).slice(0, want)));
  }
  // dropping tags can push others under the limit, so prune until every tag is on minPosts posts
  for (let changed = true; changed;) {
    const final = new Map();
    for (const tags of out.values()) for (const t of tags) final.set(t, (final.get(t) || 0) + 1);
    changed = false;
    for (const [id, tags] of out) {
      const kept = tags.filter((t) => final.get(t) >= minPosts);
      if (kept.length !== tags.length) { out.set(id, kept); changed = true; }
    }
  }
  return out;
}

function tablePrefix(db) {
  const name = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%term_taxonomy'").get()?.name;
  if (!name) throw new Error('term tables not found');
  return name.replace(/term_taxonomy$/, '');
}

function loadPosts(db, prefix) {
  return db.prepare(`SELECT ID AS id, post_title AS title, post_content AS content FROM ${prefix}posts WHERE post_type = 'post' AND post_status = 'publish' ORDER BY ID`).all();
}

// Replaces all previous auto tags with tagsByPost (Map id -> names). Returns stats.
function applyTags(db, prefix, tagsByPost) {
  const [TM, TT, TR] = ['terms', 'term_taxonomy', 'term_relationships'].map((t) => prefix + t);
  db.exec('BEGIN');
  try {
    const old = db.prepare(`SELECT term_taxonomy_id AS tt, term_id AS t FROM ${TT} WHERE taxonomy = 'post_tag' AND description = ?`).all(AUTO_MARK);
    const delRel = db.prepare(`DELETE FROM ${TR} WHERE term_taxonomy_id = ?`);
    const delTT = db.prepare(`DELETE FROM ${TT} WHERE term_taxonomy_id = ?`);
    const delTerm = db.prepare(`DELETE FROM ${TM} WHERE term_id = ? AND NOT EXISTS (SELECT 1 FROM ${TT} WHERE term_id = ?)`);
    for (const o of old) { delRel.run(o.tt); delTT.run(o.tt); delTerm.run(o.t, o.t); }

    const existing = new Map(db.prepare(`SELECT t.name AS name, tt.term_taxonomy_id AS tt FROM ${TT} tt JOIN ${TM} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'post_tag'`).all().map((r) => [r.name.toLowerCase(), r.tt]));
    const slugs = new Set(db.prepare(`SELECT slug FROM ${TM}`).all().map((r) => r.slug));
    let termId = db.prepare(`SELECT COALESCE(MAX(term_id), 0) AS m FROM ${TM}`).get().m;
    let ttId = db.prepare(`SELECT COALESCE(MAX(term_taxonomy_id), 0) AS m FROM ${TT}`).get().m;
    const insTerm = db.prepare(`INSERT INTO ${TM} (term_id, name, slug, term_group) VALUES (?, ?, ?, 0)`);
    const insTT = db.prepare(`INSERT INTO ${TT} (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (?, ?, 'post_tag', ?, 0, 0)`);
    const insRel = db.prepare(`INSERT OR IGNORE INTO ${TR} (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)`);
    const ttFor = (name) => {
      const key = name.toLowerCase();
      if (existing.has(key)) return existing.get(key);
      let slug = slugify(name);
      for (let i = 2; slugs.has(slug); i++) slug = `${slugify(name)}-${i}`;
      slugs.add(slug);
      insTerm.run(++termId, name, slug);
      insTT.run(++ttId, termId, AUTO_MARK);
      existing.set(key, ttId);
      return ttId;
    };
    let links = 0;
    const created = new Set();
    for (const [id, names] of tagsByPost) {
      for (const n of names) { const tt = ttFor(n); created.add(tt); links += Number(insRel.run(id, tt).changes); }
    }
    db.exec(`UPDATE ${TT} SET count = (SELECT COUNT(*) FROM ${TR} r WHERE r.term_taxonomy_id = ${TT}.term_taxonomy_id) WHERE taxonomy = 'post_tag'`);
    db.exec('COMMIT');
    return { removed: old.length, tags: created.size, links, posts: tagsByPost.size };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function autotag(dbFile, opts = {}) {
  const db = open(dbFile, opts.dryRun ? { readOnly: true } : {});
  try {
    const prefix = tablePrefix(db);
    // posts deleted on the public site sit in its local trash; they get no tags
    const trashed = require('./wp').loadTrashed(path.join(path.dirname(dbFile), 'public.sqlite'));
    const posts = loadPosts(db, prefix).filter((p) => !trashed.has(p.id));
    const tags = buildTags(posts, opts);
    const stats = opts.dryRun ? { posts: tags.size, tags: new Set([...tags.values()].flat()).size, links: [...tags.values()].reduce((a, t) => a + t.length, 0) } : applyTags(db, prefix, tags);
    return { ...stats, byPost: tags, posts: posts.length, sample: posts };
  } finally {
    db.close();
  }
}

// Picks existing tags whose name appears in a new post's title/description.
function matchExistingTags(text, tagNames, limit = 12) {
  const hay = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const hit = [];
  for (const name of tagNames) {
    const n = name.toLowerCase().replace(/^r\//, '').replace(/ series$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (n.length >= 3 && hay.includes(' ' + n + ' ')) hit.push(name);
  }
  return hit.sort((a, b) => b.length - a.length).slice(0, limit);
}

// Tags one new post with the existing tags its text mentions. Returns the tag names used.
function tagPost(dbFile, postId, text, limit = 12) {
  const db = open(dbFile);
  try {
    const prefix = tablePrefix(db);
    const [TM, TT, TR] = ['terms', 'term_taxonomy', 'term_relationships'].map((t) => prefix + t);
    const rows = db.prepare(`SELECT t.name, tt.term_taxonomy_id AS id FROM ${TT} tt JOIN ${TM} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'post_tag' AND tt.count >= 2 AND t.name NOT LIKE 'r/%'`).all();
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    const names = matchExistingTags(text, byName.keys(), limit);
    const add = db.prepare(`INSERT OR IGNORE INTO ${TR} (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)`);
    const bump = db.prepare(`UPDATE ${TT} SET count = count + 1 WHERE term_taxonomy_id = ?`);
    for (const n of names) if (add.run(postId, byName.get(n)).changes) bump.run(byName.get(n));
    return names;
  } finally {
    db.close();
  }
}

module.exports = { AUTO_MARK, MIN_POSTS, buildTags, applyTags, autotag, tagPost, titleLabels, tokens, slugify, matchExistingTags, tablePrefix };
