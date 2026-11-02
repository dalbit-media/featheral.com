// Member posts: an uploaded JPEG or GIF becomes a regular WordPress post with one attachment in the
// stored data set (db.sqlite + uploads + uploads-index.json), so the swipe deck and thumbnail gallery
// pick it up like any synced post. Who posted it is kept in postmeta and in public.sqlite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('../../db-api/sqlite');
const { parse: imageDims } = require('./imagesize');
const { serialize } = require('./phpser');
const { moveToThumbnails } = require('./thumbnails');
const { tagPost } = require('./autotag');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const LIMITS = { gif: 15 * 1024 * 1024, jpeg: 8 * 1024 * 1024 };
const MIN_SIDE = 32;
const MAX_SIDE = 10000;

function sniff(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

const slugify = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'post';
const wpDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const paragraphs = (s) => s.split(/\n\s*\n/).map((p) => `<p>${escHtml(p.trim()).replace(/\n/g, '<br />')}</p>`).join('\n');

function cleanText({ title, description, source, video }) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw httpError(400, 'Give the post a title');
  if (t.length > 200) throw httpError(400, 'Titles are limited to 200 characters');
  const d = String(description ?? '').replace(/\r\n?/g, '\n').trim();
  if (d.length > 2000) throw httpError(400, 'Descriptions are limited to 2,000 characters');
  let s = String(source ?? '').trim();
  if (s) {
    try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw new Error(); s = u.href.slice(0, 2000); } catch { s = ''; }
  }
  const v = String(video ?? '').trim();
  if (v && !/^[A-Za-z0-9_-]{11}$/.test(v)) throw httpError(400, 'That is not a valid YouTube video id');
  if (v && !s) s = `https://www.youtube.com/watch?v=${v}`;
  return { title: t, description: d, source: s, video: v || null };
}

// Checks the upload and finds where it belongs; nothing is written yet.
function inspect(buffer, thumbMaxSide) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'Choose an image to post');
  const format = sniff(buffer);
  if (!format) throw httpError(415, 'Posts take a JPEG or GIF image');
  if (buffer.length > LIMITS[format]) throw httpError(413, `${format === 'gif' ? 'GIFs' : 'Images'} can be up to ${LIMITS[format] / 1048576} MB`);
  const dims = imageDims(buffer);
  if (!dims || !dims.width || !dims.height) throw httpError(415, "Couldn't read the image size");
  if (Math.min(dims.width, dims.height) < MIN_SIDE) throw httpError(400, `Images must be at least ${MIN_SIDE}px on each side`);
  if (Math.max(dims.width, dims.height) > MAX_SIDE) throw httpError(400, `Images can be up to ${MAX_SIDE}px on a side`);
  // Same rule as tools/thumbnails.js: small still images go to the gallery, the rest to the swipe deck.
  const thumbs = format !== 'gif' && Math.max(dims.width, dims.height) < thumbMaxSide;
  return { format, ...dims, thumbs };
}

// Identical bytes already stored (and not trashed) under uploads/.
function existingCopy(site, uploadsDir, buffer) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  for (const x of site.index) {
    if (x.size !== buffer.length) continue;
    const file = path.join(uploadsDir, x.path);
    try { if (crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') === hash) return x.path; } catch { /* moved to trash */ }
  }
  return null;
}

function writeRows(site, { rel, format, width, height, size, title, description, source, video, address, now }) {
  const db = open(path.join(site.dir, 'db.sqlite'));
  try {
    const P = site.t('posts'); const M = site.t('postmeta');
    const home = String(site.options(['home']).home || site.manifest.siteUrl || '').replace(/\/$/, '');
    const date = wpDate(now);
    const slug = `${slugify(title)}-${crypto.randomBytes(3).toString('hex')}`;
    const by = `posted by ${address}`;
    const content = [description ? paragraphs(description) : '', source ? `<p>Source: <a href="${escHtml(source)}">${escHtml(source)}</a></p>` : '', `<p>${by}</p>`].filter(Boolean).join('\n');
    const insert = db.prepare(`INSERT INTO ${P} (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password,
        post_name, post_modified, post_modified_gmt, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, '', ?, ?, ?, ?, ?, 0, ?, ?, 0)`);
    const meta = db.prepare(`INSERT INTO ${M} (post_id, meta_key, meta_value) VALUES (?, ?, ?)`);
    db.exec('BEGIN');
    try {
      const postId = Number(insert.run(1, date, date, content, title, description ? paragraphs(description) : '', 'publish', 'open', slug, date, date, 0, '', 'post', '').lastInsertRowid);
      db.prepare(`UPDATE ${P} SET guid = ? WHERE ID = ?`).run(`${home}/?p=${postId}`, postId);
      const mime = format === 'gif' ? 'image/gif' : 'image/jpeg';
      const attId = Number(insert.run(1, date, date, '', title, '', 'inherit', 'closed', `${slug}-media`, date, date, postId, `${home}/wp-content/uploads/${rel}`, 'attachment', mime).lastInsertRowid);
      const md = { width, height, file: rel, filesize: size, sizes: {}, image_meta: {} };
      meta.run(attId, '_wp_attached_file', rel);
      meta.run(attId, '_wp_attachment_metadata', serialize(md));
      meta.run(postId, '_thumbnail_id', String(attId));
      meta.run(postId, '_wpx_member_wallet', address);
      if (source) meta.run(postId, '_wpx_source_url', source);
      if (video) meta.run(postId, '_wpx_youtube', video);
      db.exec('COMMIT');
      return { postId, attId, date, slug, mime, home };
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  } finally { db.close(); }
}

// Adds a category (Video for GIFs, Photo for big stills) when the data set has it.
function categorize(site, postId, slug) {
  if (!site.has('terms') || !site.has('term_taxonomy') || !site.has('term_relationships')) return;
  const db = open(path.join(site.dir, 'db.sqlite'));
  try {
    const TT = site.t('term_taxonomy');
    const tt = db.prepare(`SELECT tt.term_taxonomy_id AS id FROM ${TT} tt JOIN ${site.t('terms')} t ON t.term_id = tt.term_id WHERE tt.taxonomy = 'category' AND t.slug = ?`).get(slug)?.id;
    if (!tt) return;
    db.prepare(`INSERT OR IGNORE INTO ${site.t('term_relationships')} (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)`).run(postId, tt);
    db.prepare(`UPDATE ${TT} SET count = count + 1 WHERE term_taxonomy_id = ?`).run(tt);
  } finally { db.close(); }
}

// Brings the site's in-memory caches up to date without rebuilding them (a rebuild takes seconds).
function remember(site, { postId, attId, rel, format, width, height, size, title, date, slug, mime, thumbs, url }) {
  const memo = site.memo;
  if (memo.attachments) {
    memo.attachments.unshift({
      id: attId, title, slug: `${slug}-media`, caption: '', description: '', alt: '', mime, kind: 'image', parent: postId, date, author: 1, guid: '',
      file: rel, url, thumb: url, exists: true, width, height, filesize: size, sizes: [], exif: {}, original: null,
    });
    memo.referenced?.add(rel);
  }
  if (memo.postMetrics) {
    const blank = { textLength: 0, wordCount: 0, photoSize: null, photoPixels: null, videoSize: null, videoPixels: null, imageTypes: [], imageBest: {} };
    memo.postMetrics.set(postId, { ...blank, photoSize: size, photoPixels: width * height, imageTypes: [format], imageBest: { [format]: { url, size, width, height } } });
    memo.postMetrics.set(attId, { ...blank });
    memo.postAssets?.set(postId, { files: [rel], attachments: [attId] });
    memo.attachmentFiles?.set(attId, [rel]);
  }
  if (memo.publicPosts) { memo.publicPosts.push({ ID: postId, post_date: date }); memo.publicIds?.add(postId); }
  if (thumbs) memo.thumbIds?.add(postId);
  for (const k of ['fileUsers', 'stats', 'imageFormats', 'publicDecks', 'postTags']) delete memo[k];
}

function createPost(pub, address, buffer, fields) {
  const site = pub.site;
  const text = cleanText(fields);
  const img = inspect(buffer, pub.thumbMaxSide);
  // YouTube posts always go to the swipe deck, where the video plays; their thumbnail is only the cover.
  if (text.video) img.thumbs = false;
  const dup = existingCopy(site, pub.uploadsDir, buffer);
  if (dup) throw httpError(409, text.video ? 'This video is already on the site' : 'This exact image is already on the site');

  const now = new Date();
  const yyyy = String(now.getUTCFullYear()); const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = img.format === 'gif' ? 'gif' : 'jpg';
  const rel = `${yyyy}/${mm}/fthx-${slugify(text.title).slice(0, 24)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const file = path.join(pub.uploadsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer, { flag: 'wx' });
  let rows;
  try {
    rows = writeRows(site, { rel, format: img.format, width: img.width, height: img.height, size: buffer.length, ...text, address, now });
  } catch (e) { fs.rmSync(file, { force: true }); throw e; }
  if (img.thumbs) moveToThumbnails(path.join(site.dir, 'db.sqlite'), [rows.postId]);
  else categorize(site, rows.postId, img.format === 'gif' ? 'gif' : 'photo');
  let tags = [];
  if (site.has('term_taxonomy')) {
    try { tags = tagPost(path.join(site.dir, 'db.sqlite'), rows.postId, `${text.title} ${text.description || ''}`); } catch { tags = []; }
  }

  const entry = { path: rel, size: buffer.length, mtime: now.toISOString(), ext, image: true, year: yyyy, month: mm, width: img.width, height: img.height, member: true };
  site.index.push(entry);
  site.indexMap.set(rel, entry);
  fs.writeFileSync(path.join(site.dir, 'uploads-index.json'), JSON.stringify(site.index));
  const url = site.localUrl(rel);
  remember(site, { ...rows, rel, format: img.format, width: img.width, height: img.height, size: buffer.length, title: text.title, thumbs: img.thumbs, url });
  return {
    id: rows.postId, attachment: rows.attId, title: text.title, destination: img.thumbs ? 'thumbs' : 'swipe', tags, video: text.video,
    media: { url, type: img.format, size: buffer.length, width: img.width, height: img.height },
  };
}

module.exports = { createPost, inspect, cleanText, LIMITS };
