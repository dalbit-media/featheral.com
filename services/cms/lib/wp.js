const fs = require('fs');
const path = require('path');
const { open } = require('../../database/sqlite');
const { setDir, readJson } = require('./store');
const { maybeUnserialize } = require('./phpser');
const T = require('./text');

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const FORMAT_ALIASES = { jpg: 'jpeg', jpe: 'jpeg', pjpeg: 'jpeg', tif: 'tiff', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', 'x-ms-bmp': 'bmp' };
function imageFormat(mime, file) {
  let f = /^image\/(.+)$/i.exec(mime || '')?.[1] || /\.([a-z0-9]+)$/i.exec(file || '')?.[1] || '';
  f = f.toLowerCase();
  return FORMAT_ALIASES[f] || f || null;
}

const POST_GROUPS = {
  words: { metric: 'wordCount', label: 'Text length', ranges: [
    { id: 'empty', label: 'No text (0 words)', min: 0, max: 1 },
    { id: 'short', label: 'Short (1-299 words)', min: 1, max: 300 },
    { id: 'medium', label: 'Medium (300-999 words)', min: 300, max: 1000 },
    { id: 'long', label: 'Long (1,000+ words)', min: 1000 },
  ] },
  photo_size: { metric: 'photoSize', label: 'Photo file size', ranges: [
    { id: 'small', label: 'Small (<1 MiB)', min: 0, max: 1048576 },
    { id: 'medium', label: 'Medium (1-<5 MiB)', min: 1048576, max: 5242880 },
    { id: 'large', label: 'Large (5+ MiB)', min: 5242880 },
  ] },
  video_size: { metric: 'videoSize', label: 'Video file size', ranges: [
    { id: 'small', label: 'Small (<10 MiB)', min: 0, max: 10485760 },
    { id: 'medium', label: 'Medium (10-<100 MiB)', min: 10485760, max: 104857600 },
    { id: 'large', label: 'Large (100+ MiB)', min: 104857600 },
  ] },
  photo_pixels: { metric: 'photoPixels', label: 'Photo resolution', ranges: [
    { id: 'small', label: 'Low (<1 MP)', min: 0, max: 1000000 },
    { id: 'medium', label: 'Medium (1-<8 MP)', min: 1000000, max: 8000000 },
    { id: 'large', label: 'High (8+ MP)', min: 8000000 },
  ] },
  video_pixels: { metric: 'videoPixels', label: 'Video resolution', ranges: [
    { id: 'small', label: 'Low (<HD / 921,600 pixels)', min: 0, max: 921600 },
    { id: 'medium', label: 'HD (921,600-<2,073,600 pixels)', min: 921600, max: 2073600 },
    { id: 'large', label: 'Full HD+ (2,073,600+ pixels)', min: 2073600 },
  ] },
};

const INTERNAL_TYPES = new Set([
  'attachment', 'revision', 'nav_menu_item', 'customize_changeset', 'oembed_cache', 'user_request', 'wp_block',
  'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face',
  'custom_css', 'acf-field', 'acf-field-group', 'scheduled-action', 'wpcf7_contact_form', 'shop_order',
  'shop_order_refund', 'shop_coupon', 'elementor_library', 'jp_mem_plan', 'feedback', 'amn_exact-metrics',
]);

const STOPWORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves also one two get got like would may might must us new use used using many much make made per via etc s t don can’t it’s i’m don’t').split(/\s+/));

const KEY_OPTIONS = ['siteurl', 'home', 'blogname', 'blogdescription', 'admin_email', 'template', 'stylesheet', 'current_theme',
  'permalink_structure', 'timezone_string', 'gmt_offset', 'date_format', 'time_format', 'WPLANG', 'db_version', 'initial_db_version',
  'active_plugins', 'posts_per_page', 'show_on_front', 'page_on_front', 'page_for_posts', 'uploads_use_yearmonth_folders',
  'users_can_register', 'default_role', 'blog_public', 'default_comment_status', 'thumbnail_size_w', 'thumbnail_size_h',
  'medium_size_w', 'medium_size_h', 'large_size_w', 'large_size_h', 'sidebars_widgets'];

const cache = new Map();

function loadTrashed(file) {
  if (!fs.existsSync(file)) return new Set();
  let db;
  try {
    db = open(file, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash'").get()) return new Set();
    return new Set(db.prepare('SELECT post_id FROM trash').all().map((r) => r.post_id));
  } catch { return new Set(); } finally { try { db && db.close(); } catch {} }
}

function getSite(key) {
  const dir = setDir(key);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const mtime = fs.statSync(manifestPath).mtimeMs;
  const hit = cache.get(key);
  if (hit && hit.mtime === mtime) return hit.site;
  if (hit) hit.site.close();
  const site = new WpSite(key, dir);
  cache.set(key, { mtime, site });
  return site;
}

function dropSite(key) {
  const hit = cache.get(key);
  if (hit) { hit.site.close(); cache.delete(key); }
}

class WpSite {
  constructor(key, dir) {
    this.key = key;
    this.dir = dir;
    this.manifest = readJson(path.join(dir, 'manifest.json'), {});
    this.mediaBase = `/media/${key}`;
    this.index = readJson(path.join(dir, 'uploads-index.json'), []);
    this.indexMap = new Map(this.index.map((x) => [x.path, x]));
    this.addons = readJson(path.join(dir, 'addons.json'), { plugins: [], themes: [], muPlugins: [] });
    const dbPath = path.join(dir, 'db.sqlite');
    this.hasDb = fs.existsSync(dbPath) && this.manifest.status === 'ready';
    this.memo = {};
    // Posts moved to the curation trash (see lib/public.js); hidden everywhere until restored or purged.
    this.trashed = loadTrashed(path.join(dir, 'public.sqlite'));
    if (this.hasDb) {
      this.db = open(dbPath, { readOnly: true });
      const meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM __meta').all().map((r) => [r.key, r.value]));
      this.dbMeta = meta;
      this.prefix = meta.__prefix || 'wp_';
      this.tableNames = new Set(this.db.prepare('SELECT name FROM __tables').all().map((r) => r.name));
      this.db.function('wpx_post_metric', (id, metric) => this.postMetrics().get(id)?.[metric] ?? null);
      this.db.function('wpx_post_has_image_type', (id, type) => (this.postMetrics().get(id)?.imageTypes.includes(type) ? 1 : 0));
      this.db.function('wpx_trashed', (id) => (this.trashed.has(id) ? 1 : 0));
    }
  }

  close() { try { this.db && this.db.close(); } catch {} }

  t(name) { return qi(this.prefix + name); }
  has(name) { return this.hasDb && this.tableNames.has(this.prefix + name); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }

  // Files not downloaded locally are still served via /media/<key>/..., which redirects to the live site.
  localUrl(rel) { return rel && (this.indexMap.has(rel) || this.manifest.uploadsBase) ? `${this.mediaBase}/${encPath(rel)}` : null; }

  autop(content) { return this.dbMeta && this.dbMeta.__content_format === 'rendered' ? content || '' : T.autop(content); }

  options(names) {
    if (!this.has('options')) return {};
    const rows = this.all(`SELECT option_name, option_value FROM ${this.t('options')} WHERE option_name IN (${names.map(() => '?').join(',')})`, ...names);
    return Object.fromEntries(rows.map((r) => [r.option_name, maybeUnserialize(r.option_value)]));
  }

  // ---------- overview ----------
  overview() {
    const m = this.manifest;
    const out = {
      key: this.key, site: m.site, date: m.date, siteUrl: m.siteUrl, apiRoot: m.apiRoot, username: m.username, authenticated: !!m.authenticated,
      syncedAt: m.syncedAt, mediaMode: m.mediaMode, download: m.download, warnings: m.warnings || [],
      manifestLimit: m.limit || 0, uploadsBase: m.uploadsBase, localDir: this.dir,
      stats: m.stats, db: m.db, hasDb: this.hasDb, trashed: this.trashed.size,
      addons: { plugins: this.addons.plugins.length, themes: this.addons.themes.length },
    };
    if (!this.hasDb) return out;
    const opts = this.options(KEY_OPTIONS);
    out.options = opts;
    out.backupInfo = Object.fromEntries(Object.entries(this.dbMeta).filter(([k]) => !k.startsWith('__')));
    out.counts = {};
    if (this.has('posts')) {
      out.contentTypes = this.all(`SELECT post_type AS type, post_status AS status, COUNT(*) AS n FROM ${this.t('posts')} GROUP BY post_type, post_status ORDER BY n DESC`);
      out.counts.attachments = this.get(`SELECT COUNT(*) AS n FROM ${this.t('posts')} WHERE post_type='attachment'`).n;
    }
    if (this.has('comments')) out.counts.comments = this.get(`SELECT COUNT(*) AS n FROM ${this.t('comments')}`).n;
    if (this.has('users')) out.counts.users = this.get(`SELECT COUNT(*) AS n FROM ${this.t('users')}`).n;
    if (this.has('term_taxonomy')) out.taxonomies = this.all(`SELECT taxonomy, COUNT(*) AS n FROM ${this.t('term_taxonomy')} GROUP BY taxonomy ORDER BY n DESC`);
    out.counts.tables = this.tableNames.size;
    const active = Array.isArray(opts.active_plugins) ? opts.active_plugins : Object.values(opts.active_plugins || {});
    out.activePlugins = active;
    return out;
  }

  contentTypes() {
    if (!this.has('posts')) return [];
    return this.all(`SELECT post_type AS type, COUNT(*) AS n, SUM(post_status='publish') AS published FROM ${this.t('posts')} GROUP BY post_type ORDER BY n DESC`)
      .map((r) => ({ ...r, internal: INTERNAL_TYPES.has(r.type) }));
  }

  defaultTypes() {
    return this.contentTypes().filter((t) => !t.internal).map((t) => t.type);
  }

  // ---------- media ----------
  attachments() {
    if (this.memo.attachments) return this.memo.attachments;
    if (!this.has('posts')) return (this.memo.attachments = []);
    const pm = this.has('postmeta') ? this.t('postmeta') : null;
    const sub = (k) => (pm ? `(SELECT meta_value FROM ${pm} WHERE post_id=p.ID AND meta_key='${k}' LIMIT 1)` : 'NULL');
    const rows = this.all(`SELECT p.ID, p.post_title, p.post_excerpt, p.post_content, p.post_mime_type, p.post_parent, p.post_date, p.post_name, p.guid, p.post_author,
        ${sub('_wp_attached_file')} AS file, ${sub('_wp_attachment_metadata')} AS meta, ${sub('_wp_attachment_image_alt')} AS alt
      FROM ${this.t('posts')} p WHERE p.post_type='attachment' ORDER BY p.post_date DESC, p.ID DESC`);
    const referenced = new Set();
    const list = rows.map((r) => {
      let file = r.file;
      if (!file) file = T.extractUploadRefs(r.guid)[0] || null;
      const meta = maybeUnserialize(r.meta);
      const md = meta && typeof meta === 'object' ? meta : {};
      const dir = file && file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const sizes = Object.entries(md.sizes && typeof md.sizes === 'object' ? md.sizes : {}).map(([name, s]) => {
        const rel = s && s.file ? dir + s.file : null;
        if (rel) referenced.add(rel);
        return { name, file: rel, width: s?.width, height: s?.height, mime: s?.['mime-type'] || s?.mime_type, url: this.localUrl(rel) };
      });
      if (file) referenced.add(file);
      if (md.original_image) referenced.add(dir + md.original_image);
      const pick = (...names) => sizes.find((s) => names.includes(s.name) && s.url);
      const origRel = md.original_image ? dir + md.original_image : null;
      const haveFile = !!(file && this.indexMap.has(file));
      const haveOrig = !!(origRel && this.indexMap.has(origRel));
      const url = !haveFile && haveOrig ? this.localUrl(origRel) : this.localUrl(file);
      const thumb = (pick('medium', 'thumbnail', 'medium_large', 'large') || {}).url || (/^image\//.test(r.post_mime_type) ? url : null);
      const exif = md.image_meta ? Object.fromEntries(Object.entries(md.image_meta).filter(([, v]) => v !== '' && v !== 0 && v !== '0' && !(Array.isArray(v) && !v.length))) : {};
      const idx = file ? this.indexMap.get(file) : null;
      return {
        id: r.ID, title: r.post_title, slug: r.post_name, caption: r.post_excerpt, description: r.post_content, alt: r.alt || '',
        mime: r.post_mime_type || '', kind: (r.post_mime_type || 'other/').split('/')[0], parent: r.post_parent || 0, date: r.post_date,
        author: r.post_author, guid: r.guid, file, url, thumb, exists: haveFile || haveOrig,
        width: md.width || idx?.width || null, height: md.height || idx?.height || null,
        filesize: md.filesize || idx?.size || null, sizes, exif,
        original: md.original_image ? this.localUrl(dir + md.original_image) : null,
      };
    });
    this.memo.referenced = referenced;
    return (this.memo.attachments = list);
  }

  postTitles(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length || !this.has('posts')) return {};
    const rows = this.all(`SELECT ID, post_title, post_type FROM ${this.t('posts')} WHERE ID IN (${uniq.map(() => '?').join(',')})`, ...uniq);
    return Object.fromEntries(rows.map((r) => [r.ID, { title: r.post_title, type: r.post_type }]));
  }

  media(q) {
    const page = Math.max(1, +q.page || 1);
    const limit = Math.min(500, Math.max(1, +q.limit || 60));
    const source = q.source || (this.hasDb && this.attachments().length ? 'library' : 'files');
    if (source === 'library') {
      let items = this.attachments();
      const facets = { kind: count(items, (x) => x.kind), format: count(items.filter((x) => x.kind === 'image'), (x) => imageFormat(x.mime, x.file)), year: count(items, (x) => (x.date || '').slice(0, 4)) };
      if (q.kind) items = items.filter((x) => x.kind === q.kind);
      if (q.format) items = items.filter((x) => x.kind === 'image' && imageFormat(x.mime, x.file) === q.format);
      if (q.year) items = items.filter((x) => (x.date || '').startsWith(q.year));
      if (q.month) items = items.filter((x) => (x.date || '').slice(5, 7) === q.month);
      if (q.attached === 'yes') items = items.filter((x) => x.parent);
      if (q.attached === 'no') items = items.filter((x) => !x.parent);
      if (q.missing === '1') items = items.filter((x) => !x.exists);
      if (q.parent) items = items.filter((x) => String(x.parent) === String(q.parent));
      if (q.q) {
        const s = q.q.toLowerCase();
        items = items.filter((x) => [x.title, x.file, x.alt, x.caption, x.description].some((v) => v && String(v).toLowerCase().includes(s)));
      }
      items = sortItems(items, q.sort);
      const total = items.length;
      const pageItems = items.slice((page - 1) * limit, page * limit);
      const parents = this.postTitles(pageItems.map((x) => x.parent));
      return { source, total, page, limit, facets, items: pageItems.map((x) => ({ ...x, parentTitle: parents[x.parent]?.title })) };
    }
    if (this.hasDb) this.attachments();
    const ref = this.memo.referenced || new Set();
    let items = this.index.map((x) => ({ ...x, url: `${this.mediaBase}/${encPath(x.path)}`, orphan: this.hasDb ? !ref.has(x.path) : undefined }));
    const facets = { ext: count(items, (x) => x.ext), year: count(items, (x) => x.year || x.folder) };
    if (q.view !== 'all') items = items.filter((x) => !x.variantOf);
    if (q.kind === 'image') items = items.filter((x) => x.image);
    if (q.kind === 'other') items = items.filter((x) => !x.image);
    if (q.ext) items = items.filter((x) => x.ext === q.ext);
    if (q.year) items = items.filter((x) => (x.year || x.folder) === q.year);
    if (q.month) items = items.filter((x) => x.month === q.month);
    if (q.orphan === '1') items = items.filter((x) => x.orphan);
    if (q.q) { const s = q.q.toLowerCase(); items = items.filter((x) => x.path.toLowerCase().includes(s)); }
    items = sortItems(items, q.sort);
    const variants = new Map();
    for (const x of this.index) if (x.variantOf) variants.set(x.variantOf, (variants.get(x.variantOf) || 0) + 1);
    const total = items.length;
    return { source, total, page, limit, facets, items: items.slice((page - 1) * limit, page * limit).map((x) => ({ ...x, variants: variants.get(x.path) || 0 })) };
  }

  mediaItem(id) {
    const a = this.attachments().find((x) => String(x.id) === String(id));
    if (!a) return null;
    const parent = a.parent ? this.postTitles([a.parent])[a.parent] : null;
    let usedIn = [];
    if (this.has('posts') && a.file) {
      const base = a.file.replace(/\.[a-z0-9]+$/i, '');
      usedIn = this.all(`SELECT ID, post_title, post_type, post_status FROM ${this.t('posts')} WHERE post_type NOT IN ('revision','attachment') AND post_content LIKE ? LIMIT 50`, `%${base}%`);
    }
    let featuredIn = [];
    if (this.has('postmeta')) {
      featuredIn = this.all(`SELECT p.ID, p.post_title, p.post_type FROM ${this.t('postmeta')} m JOIN ${this.t('posts')} p ON p.ID=m.post_id WHERE m.meta_key='_thumbnail_id' AND m.meta_value=? LIMIT 50`, String(a.id));
    }
    return { ...a, parentInfo: parent ? { id: a.parent, ...parent } : null, usedIn, featuredIn };
  }

  // ---------- posts ----------
  postMetrics() {
    if (this.memo.postMetrics) return this.memo.postMetrics;
    const metrics = new Map();
    const byPath = new Map();
    const byId = new Map();
    const byParent = new Map();
    const featured = new Map();
    for (const a of this.attachments()) {
      byId.set(a.id, a);
      if (a.file) byPath.set(a.file, a);
      for (const size of a.sizes) if (size.file) byPath.set(size.file, a);
      if (a.original) {
        const rel = a.original.slice(this.mediaBase.length + 1).split('/').map(decodeURIComponent).join('/');
        byPath.set(rel, a);
      }
      if (a.parent) {
        if (!byParent.has(a.parent)) byParent.set(a.parent, []);
        byParent.get(a.parent).push(a);
      }
    }
    for (const file of this.index) {
      if (byPath.has(file.path)) continue;
      const kind = file.image ? 'image' : /^(mp4|m4v|mov|webm|ogv|avi|mkv|mpeg|mpg)$/i.test(file.ext) ? 'video' : 'other';
      byPath.set(file.path, { kind, file: file.path, filesize: file.size, width: file.width, height: file.height });
    }
    if (this.has('postmeta')) {
      for (const row of this.all(`SELECT post_id, meta_value FROM ${this.t('postmeta')} WHERE meta_key='_thumbnail_id'`)) {
        featured.set(row.post_id, byId.get(+row.meta_value));
      }
    }
    const assetsByPost = new Map();
    const attFiles = new Map();
    const variants = new Map();
    for (const x of this.index) if (x.variantOf) { if (!variants.has(x.variantOf)) variants.set(x.variantOf, []); variants.get(x.variantOf).push(x.path); }
    const filesOf = (a) => {
      if (a.id && attFiles.has(a.id)) return attFiles.get(a.id);
      const list = new Set([a.file, ...(a.sizes || []).map((s) => s.file)]);
      if (a.original) list.add(a.original.slice(this.mediaBase.length + 1).split('/').map(decodeURIComponent).join('/'));
      for (const f of [...list]) for (const v of variants.get(f) || []) list.add(v);
      list.delete(null); list.delete(undefined);
      const out = [...list];
      if (a.id) attFiles.set(a.id, out);
      return out;
    };
    for (const p of this.db.prepare(`SELECT ID, post_type, post_content FROM ${this.t('posts')}`).iterate()) {
      const text = T.htmlToText(p.post_content);
      const values = { textLength: [...text].length, wordCount: T.wordCount(text), photoSize: null, photoPixels: null, videoSize: null, videoPixels: null, imageTypes: [], imageBest: {} };
      const assets = new Set(byParent.get(p.ID) || []);
      if (featured.get(p.ID)) assets.add(featured.get(p.ID));
      for (const rel of T.extractUploadRefs(p.post_content)) {
        if (byPath.has(rel)) assets.add(byPath.get(rel));
      }
      for (const match of String(p.post_content || '').matchAll(/wp-(?:image|video)-(\d+)/g)) {
        if (byId.has(+match[1])) assets.add(byId.get(+match[1]));
      }
      for (const a of assets) {
        const kind = a.kind === 'image' ? 'photo' : a.kind === 'video' ? 'video' : null;
        if (!kind) continue;
        if (kind === 'photo') {
          const format = imageFormat(a.mime, a.file);
          if (format && !values.imageTypes.includes(format)) values.imageTypes.push(format);
          const url = a.url || this.localUrl(a.file);
          const local = a.exists !== false;
          const best = format && values.imageBest[format];
          if (format && url && local && (!best || (a.filesize || 0) > (best.size || 0))) {
            values.imageBest[format] = { url, size: a.filesize || null, width: a.width || null, height: a.height || null };
          }
        }
        if (a.filesize > 0) values[kind + 'Size'] = Math.max(values[kind + 'Size'] || 0, a.filesize);
        if (a.width > 0 && a.height > 0) values[kind + 'Pixels'] = Math.max(values[kind + 'Pixels'] || 0, a.width * a.height);
      }
      if (assets.size && p.post_type !== 'revision' && p.post_type !== 'attachment') {
        const files = new Set();
        const attachments = [];
        for (const a of assets) { if (a.id) attachments.push(a.id); for (const f of filesOf(a)) files.add(f); }
        assetsByPost.set(p.ID, { files: [...files], attachments });
      }
      metrics.set(p.ID, values);
    }
    this.memo.postAssets = assetsByPost;
    this.memo.attachmentFiles = attFiles;
    return (this.memo.postMetrics = metrics);
  }

  // Files and attachment rows that belong to a post (featured image, children, and inline references).
  postAssets(id) {
    this.postMetrics();
    return this.memo.postAssets.get(id) || { files: [], attachments: [] };
  }

  // Which posts use each file, for deciding whether a file is shared.
  fileUsers() {
    if (this.memo.fileUsers) return this.memo.fileUsers;
    this.postMetrics();
    const users = new Map();
    for (const [id, { files }] of this.memo.postAssets) {
      for (const f of files) { if (!users.has(f)) users.set(f, []); users.get(f).push(id); }
    }
    return (this.memo.fileUsers = users);
  }

  posts(q) {
    const page = Math.max(1, +q.page || 1);
    const limit = Math.min(200, Math.max(1, +q.limit || 25));
    const grouping = this.postGrouping(q);
    const empty = { total: 0, items: [], page, limit, types: [], groupBy: grouping.name,
      groups: grouping.ranges.map(range => ({ id: range.id, label: range.label, count: 0 })), imageTypes: [] };
    if (!this.has('posts')) return empty;
    const where = [];
    const params = [];
    const types = q.type ? String(q.type).split(',') : this.defaultTypes();
    if (!types.length) return empty;
    if (this.trashed.size) where.push('wpx_trashed(p.ID) = 0');
    where.push(`p.post_type IN (${types.map(() => '?').join(',')})`); params.push(...types);
    if (q.status) { where.push('p.post_status = ?'); params.push(q.status); } else { where.push("p.post_status NOT IN ('auto-draft','inherit')"); }
    if (q.author) { where.push('p.post_author = ?'); params.push(+q.author); }
    if (q.year) { where.push('substr(p.post_date,1,4) = ?'); params.push(String(q.year)); }
    if (q.month) { where.push('substr(p.post_date,6,2) = ?'); params.push(String(q.month).padStart(2, '0')); }
    if (q.q) { where.push('(p.post_title LIKE ? OR p.post_content LIKE ? OR p.post_excerpt LIKE ?)'); const s = `%${q.q}%`; params.push(s, s, s); }
    if (q.term && this.has('term_relationships')) {
      where.push(`p.ID IN (SELECT object_id FROM ${this.t('term_relationships')} WHERE term_taxonomy_id = ?)`); params.push(+q.term);
    }
    const groupClause = q.group ? [[`${grouping.expression} = ?`], [q.group]] : [[], []];
    const imageClause = q.image_type ? [['wpx_post_has_image_type(p.ID, ?) = 1'], [String(q.image_type)]] : [[], []];
    const groupCounts = this.all(`SELECT ${grouping.expression} AS bucket, COUNT(*) AS n FROM ${this.t('posts')} p WHERE ${[...where, ...imageClause[0]].join(' AND ')} GROUP BY bucket`, ...params, ...imageClause[1]);
    const groups = grouping.ranges.map((range) => ({
      id: range.id, label: range.label, count: groupCounts.find((row) => row.bucket === range.id)?.n || 0,
    }));
    const formats = this.imageFormats();
    const imageTypes = [];
    if (formats.length) {
      const row = this.get(`SELECT ${formats.map((_, i) => `SUM(wpx_post_has_image_type(p.ID, ?)) AS c${i}`).join(', ')} FROM ${this.t('posts')} p WHERE ${[...where, ...groupClause[0]].join(' AND ')}`, ...formats, ...params, ...groupClause[1]);
      formats.forEach((f, i) => imageTypes.push({ id: f, count: row[`c${i}`] || 0 }));
      imageTypes.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    }
    where.push(...groupClause[0], ...imageClause[0]); params.push(...groupClause[1], ...imageClause[1]);
    const sorts = { date: 'p.post_date DESC', date_asc: 'p.post_date ASC', title: 'p.post_title COLLATE NOCASE ASC', modified: 'p.post_modified DESC', comments: 'p.comment_count DESC' };
    for (const [name, metric] of Object.entries({ length: 'textLength', words: 'wordCount', photo_size: 'photoSize', photo_pixels: 'photoPixels', video_size: 'videoSize', video_pixels: 'videoPixels' })) {
      const value = `wpx_post_metric(p.ID, '${metric}')`;
      sorts[name] = `${value} IS NULL, ${value} DESC, p.ID DESC`;
      sorts[name + '_asc'] = `${value} IS NULL, ${value} ASC, p.ID DESC`;
    }
    const order = sorts[q.sort] || sorts.date;
    const w = 'WHERE ' + where.join(' AND ');
    const total = this.get(`SELECT COUNT(*) AS n FROM ${this.t('posts')} p ${w}`, ...params).n;
    const rows = this.all(`SELECT p.ID, p.post_title, p.post_type, p.post_status, p.post_date, p.post_modified, p.post_name, p.post_author, p.post_parent,
        p.comment_count, p.post_excerpt, substr(p.post_content, 1, 3000) AS head, length(p.post_content) AS len
      FROM ${this.t('posts')} p ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
    const ids = rows.map((r) => r.ID);
    const terms = this.termsFor(ids);
    const thumbs = this.featuredFor(ids);
    const authors = this.authorNames();
    return {
      total, page, limit, types, groupBy: grouping.name, groups, imageTypes,
      items: rows.map((r) => ({
        id: r.ID, title: T.decodeEntities(r.post_title || ''), type: r.post_type, status: r.post_status, date: r.post_date, modified: r.post_modified,
        slug: r.post_name, author: authors[r.post_author] || r.post_author, authorId: r.post_author, parent: r.post_parent, comments: r.comment_count,
        excerpt: (r.post_excerpt ? T.htmlToText(r.post_excerpt) : T.htmlToText(r.head)).slice(0, 260),
        length: r.len, ...this.postMetrics().get(r.ID), terms: terms[r.ID] || {}, thumb: thumbs[r.ID] || null,
      })),
    };
  }

  imageFormats() {
    if (this.memo.imageFormats) return this.memo.imageFormats;
    const set = new Set();
    for (const v of this.postMetrics().values()) for (const f of v.imageTypes) set.add(f);
    return (this.memo.imageFormats = [...set].sort());
  }

  postGrouping(q) {
    const name = q.group_by || 'words';
    if (!Object.hasOwn(POST_GROUPS, name)) throw Object.assign(new Error('Unknown post grouping'), { status: 400 });
    const definition = POST_GROUPS[name];
    const ranges = [...definition.ranges];
    if (name !== 'words') ranges.push({ id: 'unknown', label: 'No media / unknown size or resolution' });
    if (q.group && !ranges.some((range) => range.id === q.group)) throw Object.assign(new Error('Unknown post group'), { status: 400 });
    const value = `wpx_post_metric(p.ID, '${definition.metric}')`;
    const expression = 'CASE ' + definition.ranges.map((range) =>
      `WHEN ${value} >= ${range.min}${range.max === undefined ? '' : ` AND ${value} < ${range.max}`} THEN '${range.id}'`
    ).join(' ') + " ELSE 'unknown' END";
    return { name, ranges, expression };
  }

  authorNames() {
    if (this.memo.authors) return this.memo.authors;
    if (!this.has('users')) return (this.memo.authors = {});
    return (this.memo.authors = Object.fromEntries(this.all(`SELECT ID, display_name, user_login FROM ${this.t('users')}`).map((u) => [u.ID, u.display_name || u.user_login])));
  }

  termsFor(ids) {
    if (!ids.length || !this.has('term_relationships') || !this.has('term_taxonomy') || !this.has('terms')) return {};
    const rows = this.all(`SELECT r.object_id, tt.taxonomy, tt.term_taxonomy_id, t.name, t.slug FROM ${this.t('term_relationships')} r
      JOIN ${this.t('term_taxonomy')} tt ON tt.term_taxonomy_id = r.term_taxonomy_id
      JOIN ${this.t('terms')} t ON t.term_id = tt.term_id
      WHERE r.object_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const out = {};
    for (const r of rows) ((out[r.object_id] ||= {})[r.taxonomy] ||= []).push({ id: r.term_taxonomy_id, name: T.decodeEntities(r.name), slug: r.slug });
    return out;
  }

  featuredFor(ids) {
    if (!ids.length || !this.has('postmeta')) return {};
    const rows = this.all(`SELECT post_id, meta_value FROM ${this.t('postmeta')} WHERE meta_key='_thumbnail_id' AND post_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const byId = new Map(this.attachments().map((a) => [String(a.id), a]));
    const out = {};
    for (const r of rows) {
      const a = byId.get(String(r.meta_value));
      if (a) out[r.post_id] = { id: a.id, thumb: a.thumb, url: a.url, title: a.title };
    }
    return out;
  }

  post(id) {
    if (!this.has('posts')) return null;
    const p = this.get(`SELECT * FROM ${this.t('posts')} WHERE ID = ?`, +id);
    if (!p) return null;
    const meta = this.has('postmeta')
      ? this.all(`SELECT meta_id, meta_key, meta_value FROM ${this.t('postmeta')} WHERE post_id = ? ORDER BY meta_key`, +id).map((m) => {
        const v = maybeUnserialize(m.meta_value);
        return { key: m.meta_key, value: v, serialized: v !== m.meta_value, private: m.meta_key.startsWith('_') };
      })
      : [];
    const content = p.post_content || '';
    const rendered = T.rewriteUploadUrls(this.autop(content), this.mediaBase);
    const text = T.htmlToText(content);
    const refs = T.extractUploadRefs(content);
    const atts = this.attachments();
    const byFile = new Map();
    for (const a of atts) { if (a.file) byFile.set(a.file, a); for (const s of a.sizes) if (s.file) byFile.set(s.file, a); }
    const contentMedia = [];
    const seen = new Set();
    for (const r of refs) {
      const a = byFile.get(r);
      const key = a ? 'a' + a.id : 'f' + r;
      if (seen.has(key)) continue;
      seen.add(key);
      contentMedia.push(a ? { id: a.id, title: a.title, thumb: a.thumb, url: a.url, file: a.file, alt: a.alt } : { file: r, url: this.localUrl(r), thumb: this.localUrl(r) });
    }
    const children = atts.filter((a) => a.parent === p.ID);
    const comments = this.has('comments')
      ? this.all(`SELECT comment_ID AS id, comment_author AS author, comment_date AS date, comment_content AS content, comment_approved AS approved, comment_parent AS parent, comment_type AS type FROM ${this.t('comments')} WHERE comment_post_ID = ? ORDER BY comment_date`, +id)
      : [];
    const revisions = this.all(`SELECT ID, post_date, post_modified, post_author, length(post_content) AS len FROM ${this.t('posts')} WHERE post_parent = ? AND post_type = 'revision' ORDER BY post_modified DESC`, +id);
    const childrenPosts = this.all(`SELECT ID, post_title, post_type, post_status FROM ${this.t('posts')} WHERE post_parent = ? AND post_type NOT IN ('revision','attachment') ORDER BY menu_order, post_title`, +id);
    const featured = this.featuredFor([p.ID])[p.ID] || null;
    const parent = p.post_parent ? this.postTitles([p.post_parent])[p.post_parent] : null;
    const authors = this.authorNames();
    const fields = { ...p };
    delete fields.post_content;
    return {
      id: p.ID, title: T.decodeEntities(p.post_title || ''), type: p.post_type, status: p.post_status, date: p.post_date, modified: p.post_modified,
      slug: p.post_name, guid: p.guid, author: authors[p.post_author] || p.post_author, excerpt: p.post_excerpt,
      parent: parent ? { id: p.post_parent, ...parent } : null,
      fields, raw: content, rendered, text, markdown: T.rewriteUploadUrls(T.htmlToMarkdown(this.autop(content)), this.mediaBase),
      wordCount: T.wordCount(text), charCount: text.length, readingMinutes: Math.max(1, Math.round(T.wordCount(text) / 220)),
      blocks: [...new Set((content.match(/<!--\s*wp:([a-z0-9/-]+)/g) || []).map((x) => x.replace(/<!--\s*wp:/, '')))],
      terms: this.termsFor([p.ID])[p.ID] || {}, meta, featured, contentMedia, attachments: children, comments, revisions, children: childrenPosts,
    };
  }

  // ---------- taxonomies ----------
  taxonomies() {
    if (!this.has('term_taxonomy') || !this.has('terms')) return [];
    const rows = this.all(`SELECT tt.term_taxonomy_id AS id, tt.term_id, tt.taxonomy, tt.parent, tt.count, tt.description, t.name, t.slug
      FROM ${this.t('term_taxonomy')} tt JOIN ${this.t('terms')} t ON t.term_id = tt.term_id ORDER BY tt.taxonomy, t.name COLLATE NOCASE`);
    const groups = {};
    for (const r of rows) (groups[r.taxonomy] ||= []).push({ ...r, name: T.decodeEntities(r.name) });
    return Object.entries(groups).map(([taxonomy, terms]) => ({
      taxonomy, count: terms.length, hierarchical: terms.some((t) => t.parent), totalUsage: terms.reduce((a, t) => a + (t.count || 0), 0), terms,
    })).sort((a, b) => b.count - a.count);
  }

  // ---------- menus ----------
  menus() {
    if (!this.has('term_taxonomy') || !this.has('posts') || !this.has('postmeta')) return [];
    const menus = this.all(`SELECT tt.term_taxonomy_id AS id, t.name, t.slug FROM ${this.t('term_taxonomy')} tt JOIN ${this.t('terms')} t ON t.term_id=tt.term_id WHERE tt.taxonomy='nav_menu'`);
    return menus.map((menu) => {
      const items = this.all(`SELECT p.ID, p.post_title, p.menu_order FROM ${this.t('posts')} p JOIN ${this.t('term_relationships')} r ON r.object_id=p.ID
        WHERE r.term_taxonomy_id=? AND p.post_type='nav_menu_item' ORDER BY p.menu_order`, menu.id);
      const ids = items.map((i) => i.ID);
      const metaRows = ids.length ? this.all(`SELECT post_id, meta_key, meta_value FROM ${this.t('postmeta')} WHERE post_id IN (${ids.map(() => '?').join(',')}) AND meta_key LIKE '\\_menu\\_item\\_%' ESCAPE '\\'`, ...ids) : [];
      const meta = {};
      for (const m of metaRows) (meta[m.post_id] ||= {})[m.meta_key.replace('_menu_item_', '')] = m.meta_value;
      const linked = this.postTitles(items.map((i) => meta[i.ID]?.type === 'post_type' ? +meta[i.ID].object_id : 0));
      const flat = items.map((i) => {
        const m = meta[i.ID] || {};
        return { id: i.ID, title: i.post_title || linked[+m.object_id]?.title || m.url || '(untitled)', type: m.type, object: m.object, objectId: +m.object_id || null, url: m.url || '', parent: +m.menu_item_parent || 0, order: i.menu_order };
      });
      return { ...menu, items: flat };
    });
  }

  // ---------- comments ----------
  comments(q) {
    if (!this.has('comments')) return { total: 0, items: [] };
    const page = Math.max(1, +q.page || 1);
    const limit = Math.min(200, +q.limit || 50);
    const where = [];
    const params = [];
    if (q.status) { where.push('c.comment_approved = ?'); params.push(q.status); }
    if (q.type) { where.push("COALESCE(NULLIF(c.comment_type,''),'comment') = ?"); params.push(q.type); }
    if (q.q) { where.push('(c.comment_content LIKE ? OR c.comment_author LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.get(`SELECT COUNT(*) AS n FROM ${this.t('comments')} c ${w}`, ...params).n;
    const items = this.all(`SELECT c.comment_ID AS id, c.comment_post_ID AS postId, c.comment_author AS author, c.comment_author_url AS authorUrl,
        c.comment_date AS date, c.comment_content AS content, c.comment_approved AS approved, COALESCE(NULLIF(c.comment_type,''),'comment') AS type, c.comment_parent AS parent
      FROM ${this.t('comments')} c ${w} ORDER BY c.comment_date DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
    const titles = this.postTitles(items.map((c) => c.postId));
    const facets = {
      status: this.all(`SELECT comment_approved AS k, COUNT(*) AS n FROM ${this.t('comments')} GROUP BY comment_approved`),
      type: this.all(`SELECT COALESCE(NULLIF(comment_type,''),'comment') AS k, COUNT(*) AS n FROM ${this.t('comments')} GROUP BY k`),
    };
    return { total, page, limit, facets, items: items.map((c) => ({ ...c, postTitle: titles[c.postId]?.title })) };
  }

  // ---------- users ----------
  users() {
    if (!this.has('users')) return [];
    const users = this.all(`SELECT ID, user_login, user_nicename, user_email, user_url, user_registered, display_name FROM ${this.t('users')} ORDER BY ID`);
    const meta = {};
    if (this.has('usermeta')) {
      const capKey = this.prefix + 'capabilities';
      for (const m of this.all(`SELECT user_id, meta_key, meta_value FROM ${this.t('usermeta')} WHERE meta_key IN (?, 'first_name', 'last_name', 'description', 'nickname')`, capKey)) {
        (meta[m.user_id] ||= {})[m.meta_key === capKey ? 'roles' : m.meta_key] = m.meta_key === capKey ? Object.keys(maybeUnserialize(m.meta_value) || {}) : m.meta_value;
      }
    }
    const counts = this.has('posts') ? Object.fromEntries(this.all(`SELECT post_author, COUNT(*) AS n FROM ${this.t('posts')} WHERE post_type NOT IN ('revision','attachment','nav_menu_item') AND post_status='publish' GROUP BY post_author`).map((r) => [r.post_author, r.n])) : {};
    return users.map((u) => ({ ...u, ...(meta[u.ID] || {}), posts: counts[u.ID] || 0 }));
  }

  // ---------- stats for data studies ----------
  stats() {
    if (this.memo.stats) return this.memo.stats;
    const out = { timeline: [], words: null, topWords: [], media: {}, topTerms: [], authors: [] };
    if (this.has('posts')) {
      const types = this.defaultTypes();
      if (types.length) {
        const ph = types.map(() => '?').join(',');
        out.timeline = this.all(`SELECT substr(post_date,1,7) AS ym, post_type AS type, COUNT(*) AS n FROM ${this.t('posts')} WHERE post_type IN (${ph}) AND post_status='publish' GROUP BY ym, type ORDER BY ym`, ...types);
        const freq = new Map();
        let totalWords = 0, docs = 0, longest = null;
        const lengths = [];
        for (const r of this.db.prepare(`SELECT ID, post_title, post_content FROM ${this.t('posts')} WHERE post_type IN (${ph}) AND post_status='publish'`).iterate(...types)) {
          const text = T.htmlToText(r.post_content);
          const words = text.toLowerCase().match(/[\p{L}][\p{L}'’-]+/gu) || [];
          docs++;
          totalWords += words.length;
          lengths.push(words.length);
          if (!longest || words.length > longest.words) longest = { id: r.ID, title: r.post_title, words: words.length };
          for (const w of words) if (w.length > 2 && !STOPWORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
        }
        lengths.sort((a, b) => a - b);
        const buckets = [0, 100, 300, 600, 1000, 2000, 5000, Infinity];
        out.words = {
          total: totalWords, docs, avg: docs ? Math.round(totalWords / docs) : 0, median: lengths.length ? lengths[lengths.length >> 1] : 0, longest,
          histogram: buckets.slice(0, -1).map((b, i) => ({ label: buckets[i + 1] === Infinity ? `${b}+` : `${b}–${buckets[i + 1] - 1}`, n: lengths.filter((l) => l >= b && l < buckets[i + 1]).length })),
        };
        out.topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w, n]) => ({ w, n }));
      }
      out.authors = this.all(`SELECT post_author AS id, COUNT(*) AS n FROM ${this.t('posts')} WHERE post_type IN (${types.map(() => '?').join(',') || "''"}) AND post_status='publish' GROUP BY post_author ORDER BY n DESC`, ...types)
        .map((r) => ({ ...r, name: this.authorNames()[r.id] || r.id }));
    }
    const atts = this.attachments();
    out.media = {
      byKind: count(atts, (a) => a.kind), byYear: count(atts, (a) => (a.date || '').slice(0, 4)),
      byMime: count(atts, (a) => a.mime), missing: atts.filter((a) => !a.exists).length,
      withAlt: atts.filter((a) => a.alt).length, total: atts.length,
      bytes: this.index.reduce((s, x) => s + x.size, 0),
      cameras: count(atts.filter((a) => a.exif.camera), (a) => a.exif.camera),
    };
    if (this.has('term_taxonomy')) {
      out.topTerms = this.all(`SELECT tt.term_taxonomy_id AS id, tt.taxonomy, t.name, tt.count FROM ${this.t('term_taxonomy')} tt JOIN ${this.t('terms')} t ON t.term_id=tt.term_id
        WHERE tt.taxonomy NOT IN ('nav_menu','post_format','wp_theme','wp_template_part_area') ORDER BY tt.count DESC LIMIT 25`).map((r) => ({ ...r, name: T.decodeEntities(r.name) }));
    }
    if (this.has('comments')) out.commentsTimeline = this.all(`SELECT substr(comment_date,1,7) AS ym, COUNT(*) AS n FROM ${this.t('comments')} WHERE comment_approved='1' GROUP BY ym ORDER BY ym`);
    return (this.memo.stats = out);
  }

  // ---------- raw database ----------
  tables() {
    if (!this.hasDb) return [];
    return this.all('SELECT name, columns, primary_key, rows, bad_rows FROM __tables ORDER BY name').map((t) => ({
      name: t.name, short: t.name.startsWith(this.prefix) ? t.name.slice(this.prefix.length) : t.name,
      core: ['posts', 'postmeta', 'options', 'users', 'usermeta', 'terms', 'term_taxonomy', 'term_relationships', 'termmeta', 'comments', 'commentmeta', 'links'].includes(t.name.slice(this.prefix.length)) && t.name.startsWith(this.prefix),
      columns: JSON.parse(t.columns || '[]'), primary: JSON.parse(t.primary_key || '[]'), rows: t.rows, bad: t.bad_rows,
    }));
  }

  tableSchema(name) {
    return this.hasDb ? this.get('SELECT create_sql FROM __tables WHERE name = ?', name)?.create_sql : null;
  }

  tableRows(name, q) {
    const t = this.tables().find((x) => x.name === name);
    if (!t) return null;
    const page = Math.max(1, +q.page || 1);
    const limit = Math.min(500, +q.limit || 50);
    const cols = t.columns.map((c) => c.name);
    const realCols = this.all(`PRAGMA table_info(${qi(name)})`).map((c) => c.name);
    let w = '';
    const params = [];
    if (q.q) {
      w = 'WHERE ' + realCols.map((c) => `CAST(${qi(c)} AS TEXT) LIKE ?`).join(' OR ');
      for (let i = 0; i < realCols.length; i++) params.push(`%${q.q}%`);
    }
    let order = '';
    if (q.sort && realCols.includes(q.sort)) order = `ORDER BY ${qi(q.sort)} ${q.dir === 'desc' ? 'DESC' : 'ASC'}`;
    const total = this.get(`SELECT COUNT(*) AS n FROM ${qi(name)} ${w}`, ...params).n;
    const rows = this.all(`SELECT * FROM ${qi(name)} ${w} ${order} LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
    const isUsers = name === this.prefix + 'users';
    return {
      name, columns: cols.length ? cols : realCols, total, page, limit,
      rows: rows.map((r) => {
        if (isUsers) { if ('user_pass' in r) r.user_pass = '•••• (hidden)'; if ('user_activation_key' in r && r.user_activation_key) r.user_activation_key = '•••• (hidden)'; }
        return r;
      }),
    };
  }

  // ---------- export helpers ----------
  *exportPosts(q = {}) {
    if (!this.has('posts')) return;
    const types = q.type ? String(q.type).split(',') : this.defaultTypes();
    if (!types.length) return;
    const statuses = q.status === 'all' ? [] : q.status ? String(q.status).split(',') : ['publish'];
    const authors = this.authorNames();
    const home = this.options(['home']).home || '';
    const statusFilter = statuses.length ? ` AND post_status IN (${statuses.map(() => '?').join(',')})` : '';
    const groupFilter = q.group ? ` AND ${this.postGrouping(q).expression} = ?` : '';
    const imageFilter = q.image_type ? ' AND wpx_post_has_image_type(p.ID, ?) = 1' : '';
    const stmt = this.db.prepare(`SELECT * FROM ${this.t('posts')} p WHERE post_type IN (${types.map(() => '?').join(',')})${statusFilter}${groupFilter}${imageFilter} ORDER BY post_date, ID`);
    const batch = [];
    const flush = function* (self) {
      const ids = batch.map((p) => p.ID);
      const terms = self.termsFor(ids);
      const feat = self.featuredFor(ids);
      for (const p of batch) yield self.exportRecord(p, terms[p.ID] || {}, feat[p.ID], authors, home);
      batch.length = 0;
    };
    for (const p of stmt.iterate(...types, ...statuses, ...(q.group ? [q.group] : []), ...(q.image_type ? [String(q.image_type)] : []))) {
      batch.push(p);
      if (batch.length >= 200) yield* flush(this);
    }
    yield* flush(this);
  }

  exportRecord(p, terms, featured, authors, home) {
    const text = T.htmlToText(p.post_content);
    const refs = T.extractUploadRefs(p.post_content);
    return {
      id: p.ID, type: p.post_type, status: p.post_status, date: p.post_date, modified: p.post_modified,
      title: T.decodeEntities(p.post_title || ''), slug: p.post_name, author: authors[p.post_author] || String(p.post_author),
      url: p.guid || (home ? `${home}/?p=${p.ID}` : ''), parent: p.post_parent || null,
      categories: (terms.category || []).map((t) => t.name), tags: (terms.post_tag || []).map((t) => t.name),
      taxonomies: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, v.map((t) => t.name)])),
      excerpt: T.htmlToText(p.post_excerpt || ''), featured_image: featured?.url ? featured.url.replace(this.mediaBase + '/', '') : null,
      images: refs, word_count: T.wordCount(text), text, html: p.post_content,
    };
  }
}

function count(items, fn) {
  const m = {};
  for (const x of items) { const k = fn(x) || '(none)'; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
}

function sortItems(items, sort) {
  const by = {
    date: (a, b) => String(b.date || b.mtime || '').localeCompare(String(a.date || a.mtime || '')),
    date_asc: (a, b) => String(a.date || a.mtime || '').localeCompare(String(b.date || b.mtime || '')),
    name: (a, b) => String(a.title || a.path || '').localeCompare(String(b.title || b.path || '')),
    size: (a, b) => (b.filesize || b.size || 0) - (a.filesize || a.size || 0),
    pixels: (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
  };
  if (!sort && items[0] && 'path' in items[0]) return [...items].sort((a, b) => b.path.localeCompare(a.path));
  return by[sort] ? [...items].sort(by[sort]) : items;
}

module.exports = { getSite, dropSite, loadTrashed, INTERNAL_TYPES };
