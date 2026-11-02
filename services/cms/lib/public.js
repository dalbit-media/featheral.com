const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('../../database/sqlite');
const T = require('./text');
const W = require('./wallet');
const Members = require('./members');
const { fetchImage } = require('./linkfetch');
const { Analytics } = require('./analytics');
const CmsStore = require('./cms');
const { Economy } = require('./economy');
const { isNativeNote, effectiveProgram } = require('../../notes/ledger');

const PUBLIC_TYPES = ['gif', 'jpeg', 'png'];
const VOTES = ['like', 'dislike', 'none'];
const clampInt = (v, min, max, dflt) => Math.min(max, Math.max(min, Number.isFinite(+v) ? Math.trunc(+v) : dflt));
const httpError = (status, message) => Object.assign(new Error(message), { status });
// FTHX: a token ledger kept in public.sqlite. Balances are topped up with a wallet-signed request.
const FTHX = { symbol: 'FTHX', postCost: 1, likeReward: 0, tips: [1, 5, 25], maxDeposit: 1000, maxTip: 1000 };
// Trending page: how many tags to offer (at most `maxSubreddits` of them r/… tags), the fewest posts a
// tag needs, the fewest tags to show (topped up with the most used ones), and one GIF after every `gifEvery` photos.
const TRENDING = { tags: 24, maxSubreddits: 4, minPosts: 3, minHot: 12, gifEvery: 5 };
// A visitor's repeat views of the same post within this window count once.
const VIEW_WINDOW_MS = 30 * 60 * 1000;

function publishedPosts(site) {
  if (site.memo.publicPosts) return site.memo.publicPosts;
  if (!site.has('posts')) return (site.memo.publicPosts = []);
  const types = site.defaultTypes();
  if (!types.length) return (site.memo.publicPosts = []);
  const rows = site.all(`SELECT ID, post_date FROM ${site.t('posts')} WHERE post_status = 'publish' AND post_type IN (${types.map(() => '?').join(',')}) AND COALESCE(post_password, '') = ''`, ...types);
  site.memo.publicIds = new Set(rows.map((r) => r.ID));
  return (site.memo.publicPosts = rows);
}

const isPublished = (site, id) => (publishedPosts(site), site.memo.publicIds?.has(id));
const isPublic = (site, id) => isPublished(site, id) && !site.trashed.has(id);

// Posts with only a small still image are moved to this category (tools/thumbnails.js) and are
// shown in the thumbnail gallery instead of the swipe deck.
const THUMB_SLUG = 'thumbnails';
const THUMB_MAX_SIDE = 640;
function thumbIds(site) {
  if (site.memo.thumbIds) return site.memo.thumbIds;
  if (!site.has('term_relationships') || !site.has('term_taxonomy') || !site.has('terms')) return (site.memo.thumbIds = new Set());
  const rows = site.all(`SELECT r.object_id FROM ${site.t('term_relationships')} r JOIN ${site.t('term_taxonomy')} tt ON tt.term_taxonomy_id = r.term_taxonomy_id
    JOIN ${site.t('terms')} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'category' AND t.slug = ?`, THUMB_SLUG);
  return (site.memo.thumbIds = new Set(rows.map((r) => r.object_id)));
}

// Keyword tags (post_tag, see tools/autotag.js): tag id -> { name, posts }, and post id -> tag ids.
function tagIndex(site) {
  if (site.memo.postTags) return site.memo.postTags;
  const tags = new Map();
  const byPost = new Map();
  if (site.has('term_relationships') && site.has('term_taxonomy') && site.has('terms')) {
    const rows = site.all(`SELECT r.object_id AS post, tt.term_taxonomy_id AS tag, t.name FROM ${site.t('term_relationships')} r
      JOIN ${site.t('term_taxonomy')} tt ON tt.term_taxonomy_id = r.term_taxonomy_id JOIN ${site.t('terms')} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'post_tag'`);
    for (const r of rows) {
      const tag = tags.get(r.tag) || tags.set(r.tag, { id: r.tag, name: T.decodeEntities(r.name), posts: [] }).get(r.tag);
      tag.posts.push(r.post);
      (byPost.get(r.post) || byPost.set(r.post, []).get(r.post)).push(r.tag);
    }
  }
  return (site.memo.postTags = { tags, byPost });
}

// The image a post is shown with: its largest GIF, else its largest still image.
function mainMedia(site, id) {
  const best = site.postMetrics().get(id)?.imageBest || {};
  const type = PUBLIC_TYPES.find((t) => best[t]);
  return type ? { ...best[type], type } : null;
}

// Published, kept posts whose main media is a still image under `maxSide` pixels on its longest side.
function smallImagePosts(site, maxSide = THUMB_MAX_SIDE) {
  const out = [];
  for (const row of publishedPosts(site)) {
    if (site.trashed.has(row.ID)) continue;
    const m = mainMedia(site, row.ID);
    if (m && m.type !== 'gif' && m.width && m.height && Math.max(m.width, m.height) < maxSide) out.push(row.ID);
  }
  return out;
}

// Every published post with an image of the given format, ordered by the size of its largest such image.
// Trashed posts stay in the cached deck and are skipped when it is read.
function deck(site, type, order) {
  site.memo.publicDecks ||= {};
  const cacheKey = `${type}:${order}`;
  if (site.memo.publicDecks[cacheKey]) return site.memo.publicDecks[cacheKey];
  const metrics = site.postMetrics();
  const thumbs = thumbIds(site);
  const items = [];
  for (const row of publishedPosts(site)) {
    if (thumbs.has(row.ID)) continue;
    const best = metrics.get(row.ID)?.imageBest[type];
    if (best) items.push({ id: row.ID, size: best.size });
  }
  const dir = order === 'asc' ? 1 : -1;
  items.sort((a, b) => (a.size == null) - (b.size == null) || dir * ((a.size || 0) - (b.size || 0)) || a.id - b.id);
  items.pos = new Map(items.map((x, i) => [x.id, i]));
  return (site.memo.publicDecks[cacheKey] = items);
}

// FNV-1a, used to shuffle the mixed deck in a stable order for a given seed.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// Every published post with any public media type, shuffled. GIFs win over still images when a
// post has both. The seed changes with the rounds, so each new round is shuffled differently.
function mixDeck(site, seed, fresh = new Set()) {
  site.memo.publicDecks ||= {};
  const cacheKey = `mix:${seed}:${fresh.size}`;
  if (site.memo.publicDecks[cacheKey]) return site.memo.publicDecks[cacheKey];
  for (const k of Object.keys(site.memo.publicDecks)) if (k.startsWith('mix:')) delete site.memo.publicDecks[k];
  const metrics = site.postMetrics();
  const thumbs = thumbIds(site);
  const items = [];
  for (const row of publishedPosts(site)) {
    if (thumbs.has(row.ID)) continue;
    const bestByType = metrics.get(row.ID)?.imageBest || {};
    const type = PUBLIC_TYPES.find((t) => bestByType[t]);
    // Member posts come first, newest first, so new uploads are seen before the rest of the shuffle.
    if (type) items.push({ id: row.ID, type, size: bestByType[type].size, key: fresh.has(row.ID) ? -row.ID : hash32(`${seed}:${row.ID}`) });
  }
  items.sort((a, b) => a.key - b.key || a.id - b.id);
  items.pos = new Map(items.map((x, i) => [x.id, i]));
  return (site.memo.publicDecks[cacheKey] = items);
}

function describe(row) {
  const excerpt = T.htmlToText(row.post_excerpt || '').trim();
  const text = excerpt || T.htmlToText(row.post_content || '').trim();
  return text.length > 600 ? text.slice(0, 600).replace(/\s+\S*$/, '') + '…' : text;
}

function postRows(site, ids) {
  if (!ids.length) return new Map();
  const rows = site.all(`SELECT ID, post_title, post_excerpt, post_content, post_date FROM ${site.t('posts')} WHERE ID IN (${ids.map(() => '?').join(',')})`, ...ids);
  return new Map(rows.map((r) => [r.ID, r]));
}

function inside(base, rel) {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = require('crypto').createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function chunks(list, size = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Poster's wallet and FTHX earned (tips + like rewards) for member posts; nothing for synced posts.
const memberFields = (m) => (m ? { author: m.address, earned: m.earned, video: m.video || null } : { author: null, earned: 0, video: null });
const tokenAmount = (v, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${what} must be a whole number of FTHX`);
  if (n > max) throw httpError(400, `${what} can be at most ${max.toLocaleString('en-US')} FTHX`);
  return n;
};

class PublicSite {
  constructor(site, { brand, tagline, notesFile } = {}) {
    this.site = site;
    this.brand = brand || site.options(['blogname']).blogname || site.manifest.site || 'Site';
    this.tagline = tagline || null;
    this.store = new Curation(path.join(site.dir, 'public.sqlite'), notesFile, site.key);
    this.analytics = new Analytics(this.store.db);
    this.cms = new CmsStore(path.join(site.dir, 'cms.sqlite'));
    this.economy = new Economy(this.store, this.cms);
    this.uploadsDir = path.join(site.dir, 'uploads');
    this.trashDir = path.join(site.dir, 'trash');
    this.thumbMaxSide = THUMB_MAX_SIDE;
  }

  info() {
    const options = this.site.options(['blogdescription']);
    const settings = this.cms.siteSettings();
    return {
      brand: settings.displayName || this.brand,
      tagline: settings.description || this.tagline || T.decodeEntities(options.blogdescription || ''),
      theme: this.cms.theme(),
      pages: this.cms.publicPages(),
      siteSettings: this.cms.siteSettings(),
      types: PUBLIC_TYPES.map((id) => ({ id, label: id === 'jpeg' ? 'JPG' : id.toUpperCase(), ...this.status(id) })),
      mix: this.mixStatus(),
      thumbs: this.thumbList({ limit: 1 }).total,
      texts: this.textList({ limit: 1 }).total,
      trash: this.site.trashed.size,
      token: { ...FTHX, native: true, ...(this.store.notes ? { global: true, rewardProgram: effectiveProgram(this.store.db.prepare('SELECT symbol,chance,amount,enabled FROM notes.notes_programs WHERE site=?').get(this.site.key) || { symbol: 'FTHX', chance: 10, amount: 1, enabled: 0 }) } : {}) },
    };
  }

  checkType(type, { mix = false } = {}) {
    if (mix && type === 'mix') return type;
    if (!PUBLIC_TYPES.includes(type)) throw httpError(400, 'Choose gif, jpeg or png');
    return type;
  }

  // The mixed deck keeps each post's vote under its own media type and that type's round.
  mixState() {
    const rounds = Object.fromEntries(PUBLIC_TYPES.map((t) => [t, this.store.round(t)]));
    const reviewed = Object.fromEntries(PUBLIC_TYPES.map((t) => [t, this.store.reviewed(t, rounds[t])]));
    const seed = PUBLIC_TYPES.map((t) => `${t}${rounds[t]}`).join(',');
    return { rounds, reviewed, all: mixDeck(this.site, seed, this.store.memberIds()) };
  }

  mixStatus() {
    const { rounds, reviewed, all } = this.mixState();
    let total = 0; let remaining = 0; const used = new Set();
    for (const { id, type } of all) {
      if (this.site.trashed.has(id)) continue;
      total++; used.add(type);
      if (!reviewed[type].has(id)) remaining++;
    }
    let liked = 0; let disliked = 0;
    for (const t of PUBLIC_TYPES) {
      const tally = this.store.roundTally(t, rounds[t]);
      liked += tally.like || 0; disliked += tally.dislike || 0;
    }
    const round = Math.max(1, ...[...used].map((t) => rounds[t]));
    return { type: 'mix', round, total, remaining, liked, disliked };
  }

  // Progress of the current review round for one media type.
  status(type) {
    if (this.checkType(type, { mix: true }) === 'mix') return this.mixStatus();
    const round = this.store.round(type);
    const reviewed = this.store.reviewed(type, round);
    let total = 0; let remaining = 0;
    for (const { id } of deck(this.site, type, 'desc')) {
      if (this.site.trashed.has(id)) continue;
      total++;
      if (!reviewed.has(id)) remaining++;
    }
    const tally = this.store.roundTally(type, round);
    return { type, round, total, remaining, liked: tally.like || 0, disliked: tally.dislike || 0 };
  }

  // Posts not yet reviewed in the current round, continuing after the `after` post in deck order.
  feed(q) {
    const type = this.checkType(String(q.type || ''), { mix: true });
    if (type === 'mix') return this.mixFeed(q);
    const order = q.order === 'asc' ? 'asc' : 'desc';
    const all = deck(this.site, type, order);
    const limit = clampInt(q.limit, 1, 50, 12);
    const status = this.status(type);
    const reviewed = this.store.reviewed(type, status.round);
    let i = q.after && all.pos.has(+q.after) ? all.pos.get(+q.after) + 1 : 0;
    const slice = [];
    for (; i < all.length && slice.length < limit; i++) {
      const { id } = all[i];
      if (!this.site.trashed.has(id) && !reviewed.has(id)) slice.push(all[i]);
    }
    let more = false;
    for (; i < all.length && !more; i++) more = !this.site.trashed.has(all[i].id) && !reviewed.has(all[i].id);
    return { ...status, order, more, items: this.feedItems(slice.map((x) => ({ id: x.id, type, round: status.round }))) };
  }

  feedItems(list) {
    const ids = list.map((x) => x.id);
    const rows = postRows(this.site, ids);
    const metrics = this.site.postMetrics();
    const counts = this.store.counts(ids);
    const talk = this.commentCounts(ids);
    const seen = this.store.viewCounts(ids);
    const members = this.store.memberInfo(ids);
    const { tags: allTags, byPost } = tagIndex(this.site);
    return list.map(({ id, type, round }) => {
      const r = rows.get(id);
      const c = counts.get(id) || { likes: 0, dislikes: 0 };
      // The post's most widely used keyword tags first: they link to the biggest Trending groups.
      const tags = (byPost.get(id) || []).map((t) => allTags.get(t)).filter(Boolean).sort((a, b) => b.posts.length - a.posts.length).slice(0, 6).map((t) => ({ id: t.id, name: t.name }));
      return {
        ...memberFields(members.get(id)),
        id, title: T.decodeEntities(r?.post_title || '') || 'Untitled', description: r ? describe(r) : '', date: r?.post_date,
        media: { ...metrics.get(id).imageBest[type], type }, likes: c.likes, dislikes: c.dislikes, score: c.likes - c.dislikes,
        comments: talk.get(id) || 0, views: seen.get(id) || 0, words: metrics.get(id).wordCount, round, deletes: round === 1, tags,
      };
    });
  }

  mixFeed(q) {
    const { rounds, reviewed, all } = this.mixState();
    const limit = clampInt(q.limit, 1, 50, 12);
    const open = (x) => !this.site.trashed.has(x.id) && !reviewed[x.type].has(x.id);
    let i = q.after && all.pos.has(+q.after) ? all.pos.get(+q.after) + 1 : 0;
    const slice = [];
    for (; i < all.length && slice.length < limit; i++) if (open(all[i])) slice.push(all[i]);
    let more = false;
    for (; i < all.length && !more; i++) more = open(all[i]);
    return { ...this.mixStatus(), order: 'shuffle', more, items: this.feedItems(slice.map((x) => ({ ...x, round: rounds[x.type] }))) };
  }

  // like: +1 and keep. dislike: −1; in round 1 this also moves the post with its media to the trash,
  // from round 2 on it is only recorded. none: undo this round's vote. `type` may also be 'thumbs'.
  vote(id, type, vote, token = '') {
    id = +id;
    if (type !== 'thumbs') this.checkType(type);
    if (!VOTES.includes(vote)) throw httpError(400, 'Invalid vote');
    const known = type === 'thumbs' ? thumbIds(this.site).has(id) && mainMedia(this.site, id) : this.site.postMetrics().get(id)?.imageBest[type];
    if (!isPublished(this.site, id) || !known) throw httpError(404, 'Post not found');
    const round = this.store.round(type);
    const existing = this.store.vote(id, type, round);
    const trashed = this.store.trashRow(id);
    const ownTrash = trashed && trashed.type === type && trashed.round === round;
    if (vote === 'none') {
      this.store.setVote(id, type, round, null);
      if (existing === 'dislike' && ownTrash) this.restore(id);
    } else if (vote === 'like') {
      if (trashed && !ownTrash) throw httpError(409, 'This post was already deleted');
      if (ownTrash) this.restore(id);
      this.store.setVote(id, type, round, 'like');
    } else {
      this.store.setVote(id, type, round, 'dislike');
      if (!trashed && round === 1) this.trash(id, type, round);
    }
    const c = this.store.counts([id]).get(id) || { likes: 0, dislikes: 0 };
    const reward = vote === 'like' ? this.likeReward(id, token) : null;
    return { id, type, round, vote, likes: c.likes, dislikes: c.dislikes, score: c.likes - c.dislikes, deleted: this.site.trashed.has(id), ...(reward ? { reward } : {}) };
  }

  likeReward(id, token) {
    const author = this.store.memberAuthor(id);
    if (!author) return null;
    const voter = token ? this.store.session(token)?.address : null;
    if (!voter) return { paid: 0, reason: 'guest' };
    if (this.store.notes) return this.store.reactionReward(id, voter, author, 'like');
    return { paid: 0, reason: 'system-native', balance: this.store.balance(voter) };
  }

  // ---- wallet sign-in and comments ----
  // Comment totals per post: approved synced WordPress comments plus wallet comments left here.
  commentCounts(ids) {
    const out = this.store.commentCounts(ids);
    if (!ids.length) return out;
    try {
      const rows = this.site.all(`SELECT comment_post_ID AS id, COUNT(*) AS n FROM ${this.site.t('comments')} WHERE comment_approved = '1' AND comment_type IN ('', 'comment')
        AND comment_post_ID IN (${ids.map(() => '?').join(',')}) GROUP BY comment_post_ID`, ...ids);
      for (const r of rows) out.set(r.id, (out.get(r.id) || 0) + r.n);
    } catch { /* no comments table in this data set */ }
    return out;
  }
  walletNonce(address) {
    if (!W.isAddress(address)) throw httpError(400, 'Invalid wallet address');
    const addr = W.checksum(address);
    const nonce = crypto.randomBytes(16).toString('hex');
    const at = Date.now();
    this.store.setNonce(addr, nonce, at);
    return { address: addr, message: W.signInMessage(this.brand, addr, nonce, at) };
  }

  // One-time nonce, valid for 10 minutes; a valid signature returns a session token for commenting.
  walletLogin(address, signature) {
    if (!W.isAddress(address)) throw httpError(400, 'Invalid wallet address');
    const addr = W.checksum(address);
    const n = this.store.takeNonce(addr);
    if (!n || Date.now() - n.at > 10 * 60 * 1000) throw httpError(401, 'Sign-in request expired, try again');
    if (W.recoverAddress(W.signInMessage(this.brand, addr, n.nonce, n.at), signature) !== addr) throw httpError(401, 'Signature does not match this wallet');
    const token = crypto.randomBytes(32).toString('hex');
    this.store.addSession(token, addr);
    return { address: addr, token };
  }

  walletOf(token, action = 'comment') {
    const s = typeof token === 'string' && token ? this.store.session(token) : null;
    if (!s) throw httpError(401, `Connect your wallet to ${action}`);
    return s.address;
  }

  walletLogout(token) { if (typeof token === 'string') this.store.dropSession(token); return { ok: true }; }

  // ---- FTHX balance, top-ups, tips and member posts ----
  walletMe(token) {
    const address = this.walletOf(token, 'continue');
    return { address, balance: this.store.balance(address), symbol: FTHX.symbol };
  }

  ledger(token, q = {}) {
    const address = this.walletOf(token, 'see your FTHX');
    const items = this.store.ledger(address, clampInt(q.limit, 1, 200, 30));
    const titles = postRows(this.site, [...new Set(items.map((x) => x.post_id).filter(Boolean))]);
    return {
      address, balance: this.store.balance(address), posts: this.store.memberCount(address), earned: this.store.earned(address),
      items: items.map((x) => ({ ...x, title: x.post_id ? T.decodeEntities(titles.get(x.post_id)?.post_title || '') || null : null })),
    };
  }

  // Step 1 of a top-up: the message the wallet signs. Step 2 (deposit) checks the signature and credits.
  depositRequest(token, amount) {
    const address = this.walletOf(token, 'add FTHX');
    const n = tokenAmount(amount, FTHX.maxDeposit, 'A top-up');
    const nonce = crypto.randomBytes(16).toString('hex');
    const at = Date.now();
    this.store.setIntent(address, 'deposit', nonce, n, at);
    return { address, amount: n, message: W.depositMessage(this.brand, address, n, nonce, at) };
  }

  deposit(token, signature) {
    const address = this.walletOf(token, 'add FTHX');
    const it = this.store.takeIntent(address, 'deposit');
    if (!it || Date.now() - it.at > 10 * 60 * 1000) throw httpError(401, 'Top-up request expired, try again');
    if (W.recoverAddress(W.depositMessage(this.brand, address, it.amount, it.nonce, it.at), signature) !== address) throw httpError(401, 'Signature does not match this wallet');
    this.store.addEntry(address, it.amount, 'deposit');
    return { address, added: it.amount, balance: this.store.balance(address) };
  }

  tip(id, token, amount) {
    id = +id;
    const from = this.walletOf(token, 'tip');
    if (!isPublic(this.site, id)) throw httpError(404, 'Post not found');
    const to = this.store.memberAuthor(id);
    if (!to) throw httpError(400, 'Only posts made by members can receive tips');
    if (to === from) throw httpError(400, "You can't tip your own post");
    const n = tokenAmount(amount, FTHX.maxTip, 'A tip');
    if (this.store.balance(from) < n) throw httpError(402, `Not enough FTHX — add more from your wallet to tip ${n}`);
    this.store.transfer(from, to, n, 'tip', id);
    return { id, amount: n, to, balance: this.store.balance(from), earned: this.store.memberInfo([id]).get(id)?.earned || 0 };
  }

  createPost(token, buffer, fields = {}) {
    const address = this.walletOf(token, 'post');
    if (this.store.balance(address) < FTHX.postCost) throw httpError(402, `Posting costs ${FTHX.postCost} FTHX — add FTHX from your wallet first`);
    const again = fields.video ? this.store.memberByVideo(String(fields.video)) : [];
    if (again.some((id) => isPublic(this.site, id) && !this.site.trashed.has(id))) throw httpError(409, 'This video is already on the site');
    const post = Members.createPost(this, address, buffer, fields);
    this.store.addMember(post.id, address, post.media, post.video ? `https://www.youtube.com/watch?v=${post.video}` : fields.source, post.video);
    this.store.addEntry(address, -FTHX.postCost, 'post', post.id);
    return { ...post, author: address, cost: FTHX.postCost, balance: this.store.balance(address) };
  }

  // Image behind a link (direct image or a page's preview image) for the browser to compress and post.
  async fetchLink(token, url) {
    this.walletOf(token, 'post');
    return fetchImage(url);
  }

  // Counts one view of a post. The same visitor (a random id kept in the browser) viewing the same
  // post again within VIEW_WINDOW_MS is not counted again, so re-opening or stepping back doesn't inflate it.
  view(id, visitor) {
    id = +id;
    const cmsPost = id < 0 ? this.cms.get(-id) : null;
    if (id < 0 ? !cmsPost || cmsPost.status !== 'publish' : !isPublic(this.site, id)) throw httpError(404, 'Post not found');
    const who = String(visitor || '').slice(0, 64);
    const now = Date.now();
    const seen = this.recentViews || (this.recentViews = new Map());
    const key = `${who}:${id}`;
    if (who && now - (seen.get(key) || 0) < VIEW_WINDOW_MS) return { id, views: this.store.viewCounts([id]).get(id) || 0, counted: false };
    if (who) {
      seen.delete(key); seen.set(key, now);
      if (seen.size > 50000) for (const [k, t] of seen) { if (now - t < VIEW_WINDOW_MS && seen.size <= 40000) break; seen.delete(k); }
    }
    this.analytics.postView(id, now);
    return { id, views: this.store.addView(id), counted: true };
  }
  viewCounts(ids) { return this.store.viewCounts(ids); }

  // Admin Analytics report, with titles for the most viewed posts.
  analyticsReport(q = {}) {
    const r = this.analytics.report({ days: q.days ?? 7, bots: q.bots === '1' || q.bots === true });
    const rows = postRows(this.site, r.topPosts.map((p) => p.id));
    const total = this.store.viewCounts(r.topPosts.map((p) => p.id));
    r.topPosts = r.topPosts.map((p) => ({ ...p, total: total.get(p.id) || 0, title: T.decodeEntities(rows.get(p.id)?.post_title || '') || `#${p.id}` }));
    return r;
  }

  comments(id) {
    id = +id;
    if (!isPublic(this.site, id)) throw httpError(404, 'Post not found');
    // Comments synced from WordPress (read-only) come first, then wallet comments left here.
    let wp = [];
    try {
      wp = this.site.all(`SELECT comment_ID AS id, comment_author AS author, comment_content AS content, comment_date_gmt AS date FROM ${this.site.t('comments')}
        WHERE comment_post_ID = ? AND comment_approved = '1' AND comment_type IN ('', 'comment') ORDER BY comment_date_gmt, comment_ID`, id)
        .map((c) => ({ id: `wp${c.id}`, source: 'wordpress', author: T.decodeEntities(c.author || '') || 'Anonymous', content: T.htmlToText(c.content || '').trim(), at: Date.parse(`${c.date}Z`) || null }));
    } catch { /* no comments table in this data set */ }
    const own = this.store.comments(id).map((c) => ({ id: c.id, source: 'wallet', author: c.address, address: c.address, content: c.content, at: c.at }));
    return { id, total: wp.length + own.length, items: [...wp, ...own] };
  }

  addComment(id, token, content) {
    id = +id;
    const address = this.walletOf(token);
    if (!isPublic(this.site, id)) throw httpError(404, 'Post not found');
    const text = String(content ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw httpError(400, 'Write a comment first');
    if (text.length > 2000) throw httpError(400, 'Comments are limited to 2,000 characters');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const c = this.store.addComment(id, address, text);
      const author = this.store.memberAuthor(id);
      const reward = this.store.notes && author ? this.store.reactionReward(id, address, author, 'comment', true) : null;
      this.store.db.exec('COMMIT');
      return { id: c.id, source: 'wallet', author: address, address, content: c.content, at: c.at, ...(reward ? { reward } : {}) };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  deleteComment(commentId, token) {
    const address = this.walletOf(token);
    const c = this.store.comment(+commentId);
    if (!c) throw httpError(404, 'Comment not found');
    if (c.address !== address) throw httpError(403, 'Only the wallet that wrote a comment can delete it');
    this.store.deleteComment(c.id);
    return { ok: true };
  }

  nextRound(type) {
    const s = this.status(type);
    if (s.remaining > 0) throw httpError(409, `${s.remaining} posts are still waiting for review in round ${s.round}`);
    if (!s.total) throw httpError(409, 'No posts are left to review');
    if (type === 'mix') {
      for (const t of PUBLIC_TYPES) this.store.setRound(t, this.store.round(t) + 1);
      return this.status(type);
    }
    this.store.setRound(type, s.round + 1);
    return this.status(type);
  }

  // Posts in the Thumbnails category, for the masonry gallery.
  thumbList(q = {}) {
    const sort = ['newest', 'oldest', 'largest', 'smallest'].includes(q.sort) ? q.sort : 'newest';
    const limit = clampInt(q.limit, 1, 200, 60);
    const offset = clampInt(q.offset, 0, 1e9, 0);
    const cacheKey = `thumbs:${sort}`;
    this.site.memo.publicDecks ||= {};
    let all = this.site.memo.publicDecks[cacheKey];
    if (!all) {
      const dates = new Map(publishedPosts(this.site).map((r) => [r.ID, r.post_date || '']));
      const thumbs = thumbIds(this.site);
      all = [];
      for (const id of thumbs) {
        const m = dates.has(id) && mainMedia(this.site, id);
        if (m) all.push({ id, date: dates.get(id), px: (m.width || 0) * (m.height || 0) });
      }
      const by = {
        newest: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id),
        oldest: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id),
        largest: (a, b) => b.px - a.px || b.id - a.id,
        smallest: (a, b) => a.px - b.px || a.id - b.id,
      }[sort];
      all.sort(by);
      this.site.memo.publicDecks[cacheKey] = all;
    }
    const kept = all.filter((x) => !this.site.trashed.has(x.id));
    const slice = kept.slice(offset, offset + limit);
    const ids = slice.map((x) => x.id);
    const rows = postRows(this.site, ids);
    const round = this.store.round('thumbs');
    const counts = this.store.counts(ids);
    const mine = this.store.votesIn('thumbs', round, ids);
    const talk = this.commentCounts(ids);
    const seen = this.store.viewCounts(ids);
    const members = this.store.memberInfo(ids);
    const items = slice.map(({ id }) => {
      const r = rows.get(id);
      const c = counts.get(id) || { likes: 0, dislikes: 0 };
      return {
        ...memberFields(members.get(id)),
        id, title: T.decodeEntities(r?.post_title || '') || 'Untitled', description: r ? describe(r) : '', date: r?.post_date, media: mainMedia(this.site, id),
        vote: mine.get(id) || null, likes: c.likes, dislikes: c.dislikes, comments: talk.get(id) || 0, views: seen.get(id) || 0,
      };
    });
    return { total: kept.length, offset, limit, sort, round, items };
  }

  // Called when the gallery has been scrolled to the end: every thumbnail was seen, so the next round starts.
  thumbsSeen(round) {
    const current = this.store.round('thumbs');
    if (+round === current && thumbIds(this.site).size) this.store.setRound('thumbs', current + 1);
    return { round: this.store.round('thumbs') };
  }

  // Published, kept posts whose image is small enough for the Thumbnails category.
  smallImagePosts(maxSide = THUMB_MAX_SIDE) { return smallImagePosts(this.site, maxSide); }

  // Votes made in a browser before reviews were stored on the server.
  importVotes(list) {
    if (!Array.isArray(list)) throw httpError(400, 'Expected a list of votes');
    const metrics = this.site.postMetrics();
    let liked = 0; let deleted = 0;
    for (const v of list.slice(0, 100000)) {
      const id = +v?.id;
      if (!isPublic(this.site, id) || !['like', 'dislike'].includes(v.vote)) continue;
      const best = metrics.get(id)?.imageBest || {};
      const type = PUBLIC_TYPES.includes(v.type) && best[v.type] ? v.type : PUBLIC_TYPES.find((t) => best[t]);
      if (!type) continue;
      const round = this.store.round(type);
      if (this.store.vote(id, type, round)) continue;
      this.vote(id, type, v.vote);
      if (v.vote === 'like') liked++; else deleted++;
    }
    return { liked, deleted };
  }

  // Most liked first within each media type, with GIFs spread evenly among the images (like the swipe
  // deck's mix): an item's place is its rank within its type as a fraction of that type's count, plus
  // a seeded jitter so the pattern isn't rigid. GIFs liked in more rounds no longer bunch at the top.
  liked(q) {
    const seed = String(q.seed || 'liked').slice(0, 40);
    const ranked = this.store.likedPosts().filter((r) => isPublic(this.site, r.post_id) && this.likedMedia(r));
    const isGif = (r) => this.likedMedia(r).type === 'gif';
    const counts = { gif: 0, still: 0 };
    for (const r of ranked) counts[isGif(r) ? 'gif' : 'still']++;
    const seen = { gif: 0, still: 0 };
    const all = ranked.map((r) => {
      const k = isGif(r) ? 'gif' : 'still';
      return { r, key: (seen[k]++ + hash32(`${seed}:${r.post_id}`) / 2 ** 32) / counts[k] };
    }).sort((a, b) => a.key - b.key).map((x) => x.r);
    const offset = clampInt(q.offset, 0, all.length, 0);
    const limit = clampInt(q.limit, 1, 200, 60);
    const slice = all.slice(offset, offset + limit);
    const rows = postRows(this.site, slice.map((r) => r.post_id));
    const viewed = this.store.viewCounts(slice.map((r) => r.post_id));
    const members = this.store.memberInfo(slice.map((r) => r.post_id));
    return {
      total: all.length, offset, limit,
      items: slice.map((r) => ({
        ...memberFields(members.get(r.post_id)),
        id: r.post_id, title: T.decodeEntities(rows.get(r.post_id)?.post_title || '') || 'Untitled', likes: r.likes, dislikes: r.dislikes,
        score: r.likes - r.dislikes, views: viewed.get(r.post_id) || 0, media: this.likedMedia(r), deck: r.type,
      })),
    };
  }

  // Likes from the thumbnail gallery are stored under 'thumbs'; those posts show their main image.
  likedMedia(r) {
    const best = this.site.postMetrics().get(r.post_id)?.imageBest[r.type];
    return best ? { ...best, type: r.type } : mainMedia(this.site, r.post_id);
  }

  // Likes + comments (wallet and synced WordPress ones) per post, with the time of the latest like or comment.
  activity() {
    const out = this.store.activity();
    try {
      const rows = this.site.all(`SELECT comment_post_ID AS id, COUNT(*) AS n FROM ${this.site.t('comments')} WHERE comment_approved = '1' AND comment_type IN ('', 'comment') GROUP BY comment_post_ID`);
      for (const r of rows) {
        const a = out.get(r.id) || out.set(r.id, { likes: 0, dislikes: 0, comments: 0, at: 0 }).get(r.id);
        a.comments += r.n;
      }
    } catch { /* no comments table in this data set */ }
    return out;
  }

  // Every kept post with media (swipe deck and thumbnails alike): id -> { media, date, deck }.
  galleryPosts() {
    this.site.memo.publicDecks ||= {};
    if (this.site.memo.publicDecks.gallery) return this.site.memo.publicDecks.gallery;
    const thumbs = thumbIds(this.site);
    const out = new Map();
    for (const row of publishedPosts(this.site)) {
      const media = mainMedia(this.site, row.ID);
      if (media) out.set(row.ID, { media, date: row.post_date || '', deck: thumbs.has(row.ID) ? 'thumbs' : media.type });
    }
    return (this.site.memo.publicDecks.gallery = out);
  }

  // Every tag ranked: tags heating up first (likes and comments ×2 of their posts, recent ones (by the
  // latest like/comment) counting up to 3×, divided by √posts so big tags don't win on size alone),
  // then the rest by how many posts they have. Cached for a few minutes; votes and comments refresh it.
  rankedTags(gallery = this.galleryPosts(), act = null) {
    const memo = this.site.memo.publicDecks;
    const cached = memo.tagRank;
    if (cached && !act && Date.now() - cached.at < 5 * 60 * 1000) return cached.list;
    act ||= this.activity();
    const { tags } = tagIndex(this.site);
    const now = Date.now();
    const scored = [];
    for (const tag of tags.values()) {
      let n = 0; let heat = 0; let likes = 0; let comments = 0;
      for (const id of tag.posts) {
        if (!gallery.has(id) || this.site.trashed.has(id)) continue;
        n++;
        const a = act.get(id);
        if (!a || (!a.likes && !a.comments)) continue;
        likes += a.likes; comments += a.comments;
        const recent = a.at ? 1 + 2 * Math.exp(-(now - a.at) / (7 * 864e5)) : 1;
        heat += (a.likes + 2 * a.comments) * recent;
      }
      if (n >= TRENDING.minPosts) scored.push({ id: tag.id, name: tag.name, posts: n, likes, comments, heat: heat / Math.sqrt(n) });
    }
    // Subreddit tags are broad and would lead the list on size alone; a few are enough up front.
    let subs = 0;
    const hot = scored.filter((t) => t.heat > 0).sort((a, b) => b.heat - a.heat || b.posts - a.posts);
    const lead = hot.filter((t) => !t.name.startsWith('r/') || subs++ < TRENDING.maxSubreddits);
    const leadIds = new Set(lead.map((t) => t.id));
    const rest = scored.filter((t) => !leadIds.has(t.id)).sort((a, b) => b.posts - a.posts || a.id - b.id);
    const list = lead.concat(rest);
    list.hot = lead.length;
    memo.tagRank = { at: Date.now(), list };
    return list;
  }

  // The tags the default gallery draws from: the hottest few, topped up with the most used ones.
  trendingTags(gallery, act) {
    const list = this.rankedTags(gallery, act);
    return list.slice(0, Math.min(TRENDING.tags, Math.max(list.hot, TRENDING.minHot)));
  }

  // The ranked tag list page by page ("more tags"), optionally only tags whose name contains q.
  tagList(q = {}) {
    const limit = clampInt(q.limit, 1, 200, 40);
    const offset = clampInt(q.offset, 0, 1e9, 0);
    const search = String(q.q || '').trim().toLowerCase().slice(0, 100);
    let list = this.rankedTags();
    if (search) list = list.filter((t) => t.name.toLowerCase().includes(search));
    return { total: list.length, offset, limit, q: search, tags: list.slice(offset, offset + limit).map(({ id, name, posts, likes, comments }) => ({ id, name, posts, likes, comments })) };
  }

  // Posts whose title, text or tags mention every word of the search.
  searchIds(search) {
    const words = search.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length || !this.site.has('posts')) return new Set();
    const where = words.map(() => '(post_title LIKE ? OR post_content LIKE ? OR post_excerpt LIKE ?)').join(' AND ');
    const args = words.flatMap((w) => { const p = `%${w.replace(/[%_\\]/g, (c) => '\\' + c)}%`; return [p, p, p]; });
    const hits = new Set(this.site.all(`SELECT ID FROM ${this.site.t('posts')} WHERE post_type = 'post' AND ${where.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")}`, ...args).map((r) => r.ID));
    const { tags } = tagIndex(this.site);
    const phrase = words.join(' ');
    for (const tag of tags.values()) if (tag.name.toLowerCase().includes(phrase)) for (const id of tag.posts) hits.add(id);
    return hits;
  }

  // Gallery of photos with a GIF after every few of them, from the posts of one tag or (by default)
  // of all trending tags. Sorted by likes + comments unless asked otherwise.
  trending(q = {}) {
    const sort = ['hot', 'likes', 'comments', 'newest'].includes(q.sort) ? q.sort : 'hot';
    const limit = clampInt(q.limit, 1, 200, 60);
    const offset = clampInt(q.offset, 0, 1e9, 0);
    const tagId = q.tag ? clampInt(q.tag, 1, 1e12, 0) : 0;
    const search = String(q.q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    const gallery = this.galleryPosts();
    const { tags: allTags, byPost } = tagIndex(this.site);
    if (tagId && !allTags.has(tagId)) throw httpError(404, 'Tag not found');
    const cacheKey = `trend:${tagId}:${sort}:${search}`;
    const memo = this.site.memo.publicDecks;
    memo.trend ||= new Map();
    let built = memo.trend.get(cacheKey);
    if (!built || offset === 0 || Date.now() - built.at > 5 * 60 * 1000) {
      const act = this.activity();
      const hot = this.trendingTags(gallery, act);
      // A search looks through every post (or the picked tag's); without one, the trending tags' posts.
      let ids = new Set(tagId ? allTags.get(tagId).posts : search ? gallery.keys() : hot.flatMap((t) => allTags.get(t.id).posts));
      if (search) { const hits = this.searchIds(search); ids = new Set([...ids].filter((id) => hits.has(id))); }
      const zero = { likes: 0, dislikes: 0, comments: 0, at: 0 };
      const rows = [...ids].filter((id) => gallery.has(id)).map((id) => ({ id, ...gallery.get(id), ...(act.get(id) || zero) }));
      const newest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
      const by = {
        hot: (a, b) => b.likes + b.comments - (a.likes + a.comments) || b.at - a.at || newest(a, b),
        likes: (a, b) => b.likes - a.likes || b.comments - a.comments || newest(a, b),
        comments: (a, b) => b.comments - a.comments || b.likes - a.likes || newest(a, b),
        newest,
      }[sort];
      rows.sort(by);
      // Stills keep their order; one GIF follows every few of them, so GIFs are scattered, never bunched.
      const stills = rows.filter((r) => r.media.type !== 'gif');
      const gifs = rows.filter((r) => r.media.type === 'gif');
      const list = [];
      let g = 0;
      stills.forEach((r, k) => { list.push(r.id); if ((k + 1) % TRENDING.gifEvery === 0 && g < gifs.length) list.push(gifs[g++].id); });
      while (g < gifs.length) list.push(gifs[g++].id);
      built = { at: Date.now(), list, hot };
      memo.trend.delete(cacheKey);
      memo.trend.set(cacheKey, built);
      // searches make many lists; keep the most recent ones
      while (memo.trend.size > 40) memo.trend.delete(memo.trend.keys().next().value);
    }
    const kept = built.list.filter((id) => !this.site.trashed.has(id));
    const slice = kept.slice(offset, offset + limit);
    const rows = postRows(this.site, slice);
    const counts = this.store.counts(slice);
    const talk = this.commentCounts(slice);
    const seen = this.store.viewCounts(slice);
    const members = this.store.memberInfo(slice);
    const mine = new Map();
    const decks = new Map();
    for (const id of slice) { const d = gallery.get(id).deck; (decks.get(d) || decks.set(d, []).get(d)).push(id); }
    for (const [d, ids] of decks) for (const [id, v] of this.store.votesIn(d, this.store.round(d), ids)) mine.set(id, v);
    const hotIds = new Set(built.hot.map((t) => t.id));
    const items = slice.map((id) => {
      const r = rows.get(id);
      const c = counts.get(id) || { likes: 0, dislikes: 0 };
      const { media, deck } = gallery.get(id);
      const tags = (byPost.get(id) || []).map((t) => allTags.get(t)).sort((a, b) => hotIds.has(b.id) - hotIds.has(a.id)).slice(0, 12).map((t) => ({ id: t.id, name: t.name }));
      return {
        ...memberFields(members.get(id)),
        id, title: T.decodeEntities(r?.post_title || '') || 'Untitled', description: r ? describe(r) : '', date: r?.post_date, media, deck,
        vote: mine.get(id) || null, likes: c.likes, dislikes: c.dislikes, comments: talk.get(id) || 0, views: seen.get(id) || 0, tags,
      };
    });
    const tag = tagId ? { id: tagId, name: allTags.get(tagId).name } : null;
    return { total: kept.length, offset, limit, sort, tag, q: search, moreTags: this.rankedTags().length > built.hot.length, tags: built.hot.map(({ id, name, posts, likes, comments }) => ({ id, name, posts, likes, comments })), items };
  }

  // Groups published posts whose media is the same: the same file, or files with identical bytes.
  // Within a group the first published post (oldest date, then lowest ID) is kept.
  async duplicates() {
    const site = this.site;
    site.postMetrics();
    const mainFile = new Map((site.attachments() || []).map((a) => [a.id, a.file]));
    const posts = publishedPosts(site).filter((r) => !site.trashed.has(r.ID));
    const filesOf = new Map();
    for (const r of posts) {
      const { files, attachments } = site.postAssets(r.ID);
      const main = attachments.map((a) => mainFile.get(a)).filter(Boolean);
      const list = [...new Set(main.length ? main : files)];
      if (list.length) filesOf.set(r.ID, list);
    }
    // Only files that share a byte size with another file need hashing.
    const sizes = new Map();
    for (const rel of new Set([...filesOf.values()].flat())) {
      const full = inside(this.uploadsDir, rel);
      let size = null;
      try { size = full ? (await fs.promises.stat(full)).size : null; } catch {}
      sizes.set(rel, size);
    }
    const sameSize = new Map();
    for (const [rel, size] of sizes) if (size != null) (sameSize.get(size) || sameSize.set(size, []).get(size)).push(rel);
    const identity = new Map();
    for (const [size, list] of sameSize) {
      if (list.length < 2) { identity.set(list[0], `size:${size}:${list[0]}`); continue; }
      for (const rel of list) identity.set(rel, `sha1:${size}:${await hashFile(inside(this.uploadsDir, rel))}`);
    }
    const groups = new Map();
    for (const r of posts) {
      const list = filesOf.get(r.ID);
      if (!list) continue;
      const key = list.map((rel) => identity.get(rel) || `path:${rel}`).sort().join('|');
      (groups.get(key) || groups.set(key, []).get(key)).push(r);
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => String(a.post_date).localeCompare(String(b.post_date)) || a.ID - b.ID);
      out.push({ keep: g[0].ID, remove: g.slice(1).map((r) => r.ID), file: filesOf.get(g[0].ID)[0] });
    }
    return out.sort((a, b) => b.remove.length - a.remove.length);
  }

  async dedupe({ apply = false } = {}) {
    const groups = await this.duplicates();
    const summary = { groups: groups.length, posts: groups.reduce((a, g) => a + g.remove.length, 0) };
    if (!apply) return { ...summary, top: groups.slice(0, 10).map((g) => ({ keep: g.keep, file: g.file, copies: g.remove.length })) };
    this.store.db.exec('BEGIN');
    try {
      for (const g of groups) for (const id of g.remove) if (!this.site.trashed.has(id)) this.trash(id, 'duplicate', 0, g.keep);
      this.store.db.exec('COMMIT');
    } catch (e) {
      try { this.store.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    return { ...summary, trashed: summary.posts };
  }

  // Moves a post's media to <set>/trash, keeping any file that a post outside the trash still uses.
  trash(id, type, round, dupOf = null) {
    const { files, attachments } = this.site.postAssets(id);
    const users = this.site.fileUsers();
    const shared = new Set();
    const moved = []; const missed = [];
    let bytes = 0;
    for (const rel of files) {
      if ((users.get(rel) || []).some((u) => u !== id && !this.site.trashed.has(u))) { shared.add(rel); continue; }
      const src = inside(this.uploadsDir, rel); const dst = inside(this.trashDir, rel);
      if (!src || !dst || !fs.existsSync(src)) continue;
      try {
        const size = fs.statSync(src).size;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        moved.push(rel); bytes += size;
      } catch { missed.push(rel); }
    }
    const attFiles = this.site.memo.attachmentFiles || new Map();
    const owned = attachments.filter((a) => !(attFiles.get(a) || []).some((f) => shared.has(f)));
    const title = this.site.get(`SELECT post_title FROM ${this.site.t('posts')} WHERE ID = ?`, id)?.post_title || '';
    this.store.addTrash({ id, type, round, title: T.decodeEntities(title), files: moved, missed, attachments: owned, bytes, shared: shared.size, dupOf });
    this.site.trashed.add(id);
  }

  restore(id) {
    id = +id;
    const row = this.store.trashRow(id);
    if (!row) throw httpError(404, 'Not in trash');
    for (const rel of row.files) {
      const src = inside(this.trashDir, rel); const dst = inside(this.uploadsDir, rel);
      if (!src || !dst || !fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    }
    this.store.removeTrash(id);
    this.store.clearVote(id, row.type, row.round, 'dislike');
    this.site.trashed.delete(id);
    return { id, restored: true };
  }

  trashList(q = {}) {
    const rows = this.store.trashRows();
    const limit = clampInt(q.limit, 1, 500, 100);
    const page = clampInt(q.page, 1, Math.max(1, Math.ceil(rows.length / limit)), 1);
    return {
      total: rows.length, bytes: rows.reduce((a, r) => a + (r.bytes || 0), 0), files: rows.reduce((a, r) => a + r.files.length, 0), page, limit,
      items: rows.slice((page - 1) * limit, page * limit).map((r) => ({ id: r.post_id, title: r.title, type: r.type, round: r.round, dupOf: r.dup_of, at: r.at, files: r.files.length, shared: r.shared, bytes: r.bytes })),
    };
  }

  // Permanently deletes every trashed post: its rows in db.sqlite, its attachment rows and its files.
  emptyTrash() {
    const rows = this.store.trashRows();
    if (!rows.length) return { posts: 0, files: 0, bytes: 0 };
    const site = this.site;
    const ids = rows.map((r) => r.post_id);
    const attachments = [...new Set(rows.flatMap((r) => r.attachments))];
    const gone = new Set(rows.flatMap((r) => [...r.files, ...r.missed]));
    for (const r of rows) {
      for (const rel of r.files) { const p = inside(this.trashDir, rel); if (p) fs.rmSync(p, { force: true }); }
      for (const rel of r.missed) { const p = inside(this.uploadsDir, rel); if (p) try { fs.rmSync(p, { force: true }); } catch {} }
    }
    const db = open(path.join(site.dir, 'db.sqlite'));
    try {
      db.exec('BEGIN');
      const run = (sql, list) => { for (const c of chunks(list)) db.prepare(sql.replace('(?)', `(${c.map(() => '?').join(',')})`)).run(...c); };
      const select = (sql, list) => chunks(list).flatMap((c) => db.prepare(sql.replace('(?)', `(${c.map(() => '?').join(',')})`)).all(...c));
      const posts = site.t('posts');
      const revisions = select(`SELECT ID FROM ${posts} WHERE post_type = 'revision' AND post_parent IN (?)`, ids).map((r) => r.ID);
      const all = [...new Set([...ids, ...attachments, ...revisions])];
      if (site.has('postmeta')) run(`DELETE FROM ${site.t('postmeta')} WHERE post_id IN (?)`, all);
      if (site.has('term_relationships')) run(`DELETE FROM ${site.t('term_relationships')} WHERE object_id IN (?)`, all);
      if (site.has('comments')) {
        const comments = select(`SELECT comment_ID FROM ${site.t('comments')} WHERE comment_post_ID IN (?)`, ids).map((r) => r.comment_ID);
        if (site.has('commentmeta')) run(`DELETE FROM ${site.t('commentmeta')} WHERE comment_id IN (?)`, comments);
        run(`DELETE FROM ${site.t('comments')} WHERE comment_ID IN (?)`, comments);
      }
      run(`DELETE FROM ${posts} WHERE ID IN (?)`, all);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally { db.close(); }
    const indexPath = path.join(site.dir, 'uploads-index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      fs.writeFileSync(indexPath, JSON.stringify(index.filter((x) => !gone.has(x.path))));
    }
    const bytes = rows.reduce((a, r) => a + (r.bytes || 0), 0);
    this.store.clearTrash();
    fs.rmSync(this.trashDir, { recursive: true, force: true });
    site.trashed.clear();
    return { posts: ids.length, files: gone.size, bytes };
  }

  textList(q) {
    const metrics = this.site.postMetrics();
    let list = publishedPosts(this.site).filter((r) => !this.site.trashed.has(r.ID) && (metrics.get(r.ID)?.wordCount || 0) >= 1);
    const search = String(q.q || '').trim().toLowerCase();
    if (search && this.site.has('posts')) {
      const s = `%${search}%`;
      const hits = new Set(this.site.all(`SELECT ID FROM ${this.site.t('posts')} WHERE post_title LIKE ? OR post_content LIKE ? OR post_excerpt LIKE ?`, s, s, s).map((r) => r.ID));
      list = list.filter((r) => hits.has(r.ID));
    }
    const cmsPosts = this.cms.published().filter((r) => T.wordCount(r.body) >= 1 && (!search ||
      `${r.title}\n${r.excerpt}\n${r.body}`.toLowerCase().includes(search)))
      .map((r) => ({ ID: -r.id, post_title: r.title, post_date: r.createdAt, cms: r }));
    list.push(...cmsPosts);
    const sort = q.sort || 'longest';
    const words = (r) => r.cms ? T.wordCount(r.cms.body) : metrics.get(r.ID).wordCount;
    if (sort === 'shortest') list = [...list].sort((a, b) => words(a) - words(b) || b.ID - a.ID);
    else if (sort === 'newest') list = [...list].sort((a, b) => String(b.post_date).localeCompare(String(a.post_date)) || b.ID - a.ID);
    else if (sort === 'oldest') list = [...list].sort((a, b) => String(a.post_date).localeCompare(String(b.post_date)) || a.ID - b.ID);
    else list = [...list].sort((a, b) => words(b) - words(a) || b.ID - a.ID);
    const limit = clampInt(q.limit, 1, 100, 30);
    const page = clampInt(q.page, 1, Math.max(1, Math.ceil(list.length / limit)), 1);
    const slice = list.slice((page - 1) * limit, page * limit);
    const rows = postRows(this.site, slice.filter((r) => !r.cms).map((r) => r.ID));
    const seen = this.store.viewCounts(slice.map((r) => r.ID));
    return {
      total: list.length, page, limit, sort,
      items: slice.map((r) => {
        const row = rows.get(r.ID);
        const title = r.cms ? r.cms.title : T.decodeEntities(row?.post_title || '') || 'Untitled';
        const snippet = r.cms ? T.htmlToText(r.cms.excerpt || r.cms.body).slice(0, 220) : row ? describe(row).slice(0, 220) : '';
        return {
          id: r.ID, title, date: r.post_date, words: words(r), views: seen.get(r.ID) || 0, snippet,
          ...(r.cms ? { type: r.cms.type, slug: r.cms.slug } : {}),
        };
      }),
    };
  }

  cmsText(post) {
    const text = T.htmlToText(post.body).trim();
    return {
      id: -post.id, title: post.title, date: post.createdAt, type: post.type, slug: post.slug,
      words: T.wordCount(text), views: this.store.viewCounts([-post.id]).get(-post.id) || 0,
      paragraphs: text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean),
    };
  }

  textBySlug(slug) {
    const post = this.cms.publishedPage(String(slug || ''));
    return post ? this.cmsText(post) : null;
  }

  text(id) {
    id = +id;
    if (id < 0) {
      const post = this.cms.get(-id);
      if (!post || post.status !== 'publish') return null;
      return this.cmsText(post);
    }
    if (!isPublic(this.site, id)) return null;
    const row = this.site.get(`SELECT ID, post_title, post_excerpt, post_content, post_date FROM ${this.site.t('posts')} WHERE ID = ?`, id);
    const text = T.htmlToText(row.post_content || '').trim();
    return {
      id, title: T.decodeEntities(row.post_title || '') || 'Untitled', date: row.post_date,
      words: T.wordCount(text), views: this.store.viewCounts([id]).get(id) || 0, paragraphs: text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean),
    };
  }

  close() { this.cms.close(); this.store.close(); }
}

// Review state kept beside the stored data in public.sqlite.
class Curation {
  constructor(file, notesFile, siteKey) {
    this.db = open(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rounds (type TEXT PRIMARY KEY, round INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS votes (post_id INTEGER NOT NULL, type TEXT NOT NULL, round INTEGER NOT NULL, vote TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (post_id, type, round));
      CREATE TABLE IF NOT EXISTS trash (post_id INTEGER PRIMARY KEY, type TEXT, round INTEGER, at INTEGER NOT NULL, title TEXT,
        files TEXT NOT NULL, missed TEXT NOT NULL, attachments TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, shared INTEGER NOT NULL DEFAULT 0);
    `);
    if (!this.db.prepare('PRAGMA table_info(trash)').all().some((c) => c.name === 'dup_of')) this.db.exec('ALTER TABLE trash ADD COLUMN dup_of INTEGER');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_nonces (address TEXT PRIMARY KEY, nonce TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, address TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, at);
      CREATE TABLE IF NOT EXISTS wallet_intents (address TEXT NOT NULL, purpose TEXT NOT NULL, nonce TEXT NOT NULL, amount INTEGER, at INTEGER NOT NULL, PRIMARY KEY (address, purpose));
      -- Preserve the legacy table name so FTHX reuses existing balances and history.
      CREATE TABLE IF NOT EXISTS qprn_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, amount INTEGER NOT NULL, kind TEXT NOT NULL,
        post_id INTEGER, other TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS qprn_ledger_address ON qprn_ledger (address, id);
      CREATE INDEX IF NOT EXISTS qprn_ledger_post ON qprn_ledger (post_id);
      CREATE TABLE IF NOT EXISTS member_posts (post_id INTEGER PRIMARY KEY, address TEXT NOT NULL, file TEXT, format TEXT, width INTEGER, height INTEGER, bytes INTEGER,
        source TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS member_posts_address ON member_posts (address);
      CREATE TABLE IF NOT EXISTS like_rewards (post_id INTEGER NOT NULL, voter TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (post_id, voter));
      CREATE TABLE IF NOT EXISTS views (post_id INTEGER PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL);
    `);
    // Added after member posts first shipped: the YouTube video a member post plays.
    if (!this.db.prepare('PRAGMA table_info(member_posts)').all().some((c) => c.name === 'video')) this.db.exec('ALTER TABLE member_posts ADD COLUMN video TEXT');
    this.siteKey = siteKey;
    this.notes = !!notesFile;
    this.ledgerTable = 'qprn_ledger';
    if (notesFile) {
      const { Notes, migrate } = require('../../notes/ledger');
      const notes = new Notes(notesFile);
      try { migrate(this.db, notes.db, siteKey); }
      catch (error) { this.db.close(); throw error; }
      finally { notes.close(); }
      this.db.prepare('ATTACH DATABASE ? AS notes').run(notesFile);
      this.ledgerTable = 'notes.notes_entries';
    }
  }

  addView(postId) {
    const at = Date.now();
    this.db.prepare('INSERT INTO views (post_id, n, at) VALUES (?, 1, ?) ON CONFLICT (post_id) DO UPDATE SET n = n + 1, at = excluded.at').run(postId, at);
    return this.db.prepare('SELECT n FROM views WHERE post_id = ?').get(postId).n;
  }
  viewCounts(ids) {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT post_id, n FROM views WHERE post_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return new Map(rows.map((r) => [r.post_id, r.n]));
  }

  setIntent(address, purpose, nonce, amount, at) {
    this.db.prepare('INSERT OR REPLACE INTO wallet_intents (address, purpose, nonce, amount, at) VALUES (?, ?, ?, ?, ?)').run(address, purpose, nonce, amount, at);
  }
  takeIntent(address, purpose) {
    const r = this.db.prepare('SELECT nonce, amount, at FROM wallet_intents WHERE address = ? AND purpose = ?').get(address, purpose);
    this.db.prepare('DELETE FROM wallet_intents WHERE address = ? AND purpose = ?').run(address, purpose);
    return r || null;
  }

  balance(address) { return this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM ${this.ledgerTable} WHERE address = ? ${this.notes ? "AND symbol='FTHX'" : ''}`).get(this.notes ? address.toLowerCase() : address).b; }
  addEntry(address, amount, kind, postId = null, other = null, symbol = 'FTHX') {
    if (this.notes) {
      const balance = this.db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM notes.notes_entries WHERE address=? AND symbol=?').get(address.toLowerCase(), symbol).n;
      if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(balance + amount) || balance + amount < 0)
        throw httpError(402, `Invalid or insufficient global ${symbol} balance`);
      return this.db.prepare('INSERT INTO notes.notes_entries(address,amount,kind,post_id,other,at,site,symbol) VALUES (?,?,?,?,?,?,?,?)')
        .run(address.toLowerCase(), amount, kind, postId, other, Date.now(), this.siteKey, symbol);
    }
    this.db.prepare('INSERT INTO qprn_ledger (address, amount, kind, post_id, other, at) VALUES (?, ?, ?, ?, ?, ?)').run(address, amount, kind, postId, other, Date.now());
  }
  transfer(from, to, amount, kind, postId) {
    this.db.exec('BEGIN');
    try {
      this.addEntry(from, -amount, `${kind}_out`, postId, to);
      this.addEntry(to, amount, `${kind}_in`, postId, from);
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  ledger(address, limit) {
    return this.db.prepare(`SELECT id, amount, kind, post_id, other, at FROM ${this.ledgerTable} WHERE address = ? ${this.notes ? "AND symbol='FTHX'" : ''} ORDER BY id DESC LIMIT ?`).all(this.notes ? address.toLowerCase() : address, limit);
  }
  earned(address) { return this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ${this.ledgerTable} WHERE address = ? AND kind IN ('tip_in', 'like_in', 'reaction_in') ${this.notes ? "AND symbol='FTHX'" : ''}`).get(this.notes ? address.toLowerCase() : address).n; }

  reactionReward(postId, reactor, author, kind, inTransaction = false) {
    reactor = reactor.toLowerCase(); author = author.toLowerCase();
    if (reactor === author) return { paid: 0, reason: 'own' };
    if (!inTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT 1 FROM notes.notes_reactions WHERE site=? AND post_id=? AND reactor=?').get(this.siteKey, postId, reactor);
      const program = this.db.prepare('SELECT * FROM notes.notes_programs WHERE site=?').get(this.siteKey) ||
        { symbol: 'FTHX', chance: 10, amount: 1, enabled: 0 };
      let result = { paid: 0, reason: 'already' };
      if (!existing) {
        const roll = crypto.randomInt(100);
        const native = isNativeNote(program.symbol);
        const paid = program.enabled && !native && roll < program.chance ? program.amount : 0;
        this.db.prepare('INSERT INTO notes.notes_reactions VALUES (?,?,?,?,?,?,?,?)').run(this.siteKey, postId, reactor, author, kind, roll, paid, Date.now());
        if (paid) {
          this.addEntry(author, paid, 'reaction_in', postId, reactor, program.symbol);
        }
        result = { paid, symbol: program.symbol, to: author, reason: native ? 'system-native' : paid ? 'awarded' : program.enabled ? 'chance' : 'disabled', balance: this.balance(reactor) };
      }
      if (!inTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) { if (!inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  addMember(postId, address, media, source, video = null) {
    this.db.prepare('INSERT OR REPLACE INTO member_posts (post_id, address, file, format, width, height, bytes, source, video, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(postId, address, media.url || null, media.type, media.width, media.height, media.size, source || null, video || null, Date.now());
  }
  memberAuthor(postId) { return this.db.prepare('SELECT address FROM member_posts WHERE post_id = ?').get(postId)?.address || null; }
  memberByVideo(video) { return this.db.prepare('SELECT post_id FROM member_posts WHERE video = ?').all(video).map((r) => r.post_id); }
  memberIds() { return new Set(this.db.prepare('SELECT post_id FROM member_posts').all().map((r) => r.post_id)); }
  memberCount(address) { return this.db.prepare('SELECT COUNT(*) AS n FROM member_posts WHERE address = ?').get(address).n; }
  memberInfo(ids) {
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT m.post_id, m.address, m.video, (SELECT COALESCE(SUM(l.amount), 0) FROM ${this.ledgerTable} l WHERE l.post_id = m.post_id AND l.address = ${this.notes ? 'lower(m.address)' : 'm.address'}
        ${this.notes ? "AND l.site=? AND l.symbol='FTHX'" : ''} AND l.kind IN ('tip_in', 'like_in', 'reaction_in')) AS earned FROM member_posts m WHERE m.post_id IN (${marks})`).all(...(this.notes ? [this.siteKey] : []), ...ids);
    return new Map(rows.map((r) => [r.post_id, { address: r.address, earned: r.earned, video: r.video }]));
  }
  rewarded(postId, voter) { return !!this.db.prepare('SELECT 1 FROM like_rewards WHERE post_id = ? AND voter = ?').get(postId, voter); }
  markRewarded(postId, voter) { this.db.prepare('INSERT OR IGNORE INTO like_rewards (post_id, voter, at) VALUES (?, ?, ?)').run(postId, voter, Date.now()); }

  setNonce(address, nonce, at) { this.db.prepare('INSERT OR REPLACE INTO wallet_nonces (address, nonce, at) VALUES (?, ?, ?)').run(address, nonce, at); }
  takeNonce(address) {
    const r = this.db.prepare('SELECT nonce, at FROM wallet_nonces WHERE address = ?').get(address);
    this.db.prepare('DELETE FROM wallet_nonces WHERE address = ?').run(address);
    return r || null;
  }
  addSession(token, address) { this.db.prepare('INSERT INTO wallet_sessions (token, address, at) VALUES (?, ?, ?)').run(token, address, Date.now()); }
  session(token) { return this.db.prepare('SELECT address, at FROM wallet_sessions WHERE token = ?').get(token) || null; }
  dropSession(token) { this.db.prepare('DELETE FROM wallet_sessions WHERE token = ?').run(token); }

  comments(postId) { return this.db.prepare('SELECT id, address, content, at FROM comments WHERE post_id = ? ORDER BY at, id').all(postId); }
  commentCounts(ids) {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id`).all(...ids);
    return new Map(rows.map((r) => [r.post_id, r.n]));
  }
  addComment(postId, address, content) {
    const at = Date.now();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO comments (post_id, address, content, at) VALUES (?, ?, ?, ?)').run(postId, address, content, at);
    return { id: Number(lastInsertRowid), address, content, at };
  }
  comment(id) { return this.db.prepare('SELECT id, post_id, address FROM comments WHERE id = ?').get(id) || null; }
  deleteComment(id) { this.db.prepare('DELETE FROM comments WHERE id = ?').run(id); }

  round(type) { return this.db.prepare('SELECT round FROM rounds WHERE type = ?').get(type)?.round || 1; }
  setRound(type, round) { this.db.prepare('INSERT INTO rounds (type, round) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET round = excluded.round').run(type, round); }

  reviewed(type, round) {
    return new Set(this.db.prepare('SELECT post_id FROM votes WHERE type = ? AND round = ?').all(type, round).map((r) => r.post_id));
  }

  roundTally(type, round) {
    return Object.fromEntries(this.db.prepare('SELECT vote, COUNT(*) AS n FROM votes WHERE type = ? AND round = ? GROUP BY vote').all(type, round).map((r) => [r.vote, r.n]));
  }

  vote(id, type, round) { return this.db.prepare('SELECT vote FROM votes WHERE post_id = ? AND type = ? AND round = ?').get(id, type, round)?.vote || null; }

  votesIn(type, round, ids) {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT post_id, vote FROM votes WHERE type = ? AND round = ? AND post_id IN (${ids.map(() => '?').join(',')})`).all(type, round, ...ids);
    return new Map(rows.map((r) => [r.post_id, r.vote]));
  }

  setVote(id, type, round, vote) {
    if (!vote) return this.db.prepare('DELETE FROM votes WHERE post_id = ? AND type = ? AND round = ?').run(id, type, round);
    this.db.prepare('INSERT INTO votes (post_id, type, round, vote, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(post_id, type, round) DO UPDATE SET vote = excluded.vote, at = excluded.at')
      .run(id, type, round, vote, Date.now());
  }

  clearVote(id, type, round, vote) { this.db.prepare('DELETE FROM votes WHERE post_id = ? AND type = ? AND round = ? AND vote = ?').run(id, type, round, vote); }

  counts(ids) {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT post_id, SUM(vote = 'like') AS likes, SUM(vote = 'dislike') AS dislikes FROM votes WHERE post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id`).all(...ids);
    return new Map(rows.map((r) => [r.post_id, { likes: r.likes, dislikes: r.dislikes }]));
  }

  // Likes, dislikes, wallet comments and the time of the latest of them, for every post that has any.
  activity() {
    const out = new Map();
    const get = (id) => out.get(id) || out.set(id, { likes: 0, dislikes: 0, comments: 0, at: 0 }).get(id);
    for (const r of this.db.prepare(`SELECT post_id, SUM(vote = 'like') AS likes, SUM(vote = 'dislike') AS dislikes, MAX(CASE WHEN vote = 'like' THEN at END) AS at FROM votes GROUP BY post_id`).all()) {
      Object.assign(get(r.post_id), { likes: r.likes, dislikes: r.dislikes, at: r.at || 0 });
    }
    for (const r of this.db.prepare('SELECT post_id, COUNT(*) AS n, MAX(at) AS at FROM comments GROUP BY post_id').all()) {
      const a = get(r.post_id); a.comments += r.n; a.at = Math.max(a.at, r.at || 0);
    }
    return out;
  }

  // Liked posts, best-voted first; `type` is the media type of the most recent like.
  likedPosts() {
    return this.db.prepare(`SELECT v.post_id, SUM(v.vote = 'like') AS likes, SUM(v.vote = 'dislike') AS dislikes, MAX(CASE WHEN v.vote = 'like' THEN v.at END) AS at,
        (SELECT type FROM votes l WHERE l.post_id = v.post_id AND l.vote = 'like' ORDER BY l.at DESC LIMIT 1) AS type
      FROM votes v GROUP BY v.post_id HAVING likes > 0 ORDER BY likes - dislikes DESC, at DESC`).all();
  }

  addTrash(t) {
    this.db.prepare('INSERT OR REPLACE INTO trash (post_id, type, round, at, title, files, missed, attachments, bytes, shared, dup_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.type, t.round, Date.now(), t.title, JSON.stringify(t.files), JSON.stringify(t.missed), JSON.stringify(t.attachments), t.bytes, t.shared, t.dupOf ?? null);
  }

  parse(r) { return r && { ...r, files: JSON.parse(r.files), missed: JSON.parse(r.missed), attachments: JSON.parse(r.attachments) }; }
  trashRow(id) { return this.parse(this.db.prepare('SELECT * FROM trash WHERE post_id = ?').get(id)); }
  trashRows() { return this.db.prepare('SELECT * FROM trash ORDER BY at DESC').all().map((r) => this.parse(r)); }
  removeTrash(id) { this.db.prepare('DELETE FROM trash WHERE post_id = ?').run(id); }
  clearTrash() { this.db.exec('DELETE FROM trash'); }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { PublicSite, PUBLIC_TYPES, THUMB_SLUG, THUMB_MAX_SIDE, FTHX, TRENDING };
