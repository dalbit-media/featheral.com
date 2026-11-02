const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('../../database/sqlite');
const { WpApi } = require('./wpapi');
const { setDir, readJson, writeJson, buildUploadsIndex } = require('./store');
const { serialize } = require('./phpser');
const T = require('./text');

const PREFIX = 'wp_';
const SKIP_TYPES = new Set(['attachment', 'nav_menu_item', 'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_font_family', 'wp_font_face']);
const SKIP_TAX = new Set(['nav_menu', 'wp_theme', 'wp_template_part_area']);

const SCHEMA = {
  posts: { cols: 'ID INTEGER, post_author INTEGER, post_date TEXT, post_date_gmt TEXT, post_content TEXT, post_title TEXT, post_excerpt TEXT, post_status TEXT, comment_status TEXT, ping_status TEXT, post_password TEXT, post_name TEXT, post_modified TEXT, post_modified_gmt TEXT, post_parent INTEGER, guid TEXT, menu_order INTEGER, post_type TEXT, post_mime_type TEXT, comment_count INTEGER', pk: ['ID'] },
  postmeta: { cols: 'meta_id INTEGER, post_id INTEGER, meta_key TEXT, meta_value TEXT', pk: ['meta_id'] },
  terms: { cols: 'term_id INTEGER, name TEXT, slug TEXT, term_group INTEGER', pk: ['term_id'] },
  term_taxonomy: { cols: 'term_taxonomy_id INTEGER, term_id INTEGER, taxonomy TEXT, description TEXT, parent INTEGER, count INTEGER', pk: ['term_taxonomy_id'] },
  term_relationships: { cols: 'object_id INTEGER, term_taxonomy_id INTEGER, term_order INTEGER', pk: ['object_id', 'term_taxonomy_id'] },
  comments: { cols: 'comment_ID INTEGER, comment_post_ID INTEGER, comment_author TEXT, comment_author_email TEXT, comment_author_url TEXT, comment_date TEXT, comment_date_gmt TEXT, comment_content TEXT, comment_approved TEXT, comment_type TEXT, comment_parent INTEGER, user_id INTEGER', pk: ['comment_ID'] },
  users: { cols: 'ID INTEGER, user_login TEXT, user_nicename TEXT, user_email TEXT, user_url TEXT, user_registered TEXT, display_name TEXT', pk: ['ID'] },
  usermeta: { cols: 'umeta_id INTEGER, user_id INTEGER, meta_key TEXT, meta_value TEXT', pk: ['umeta_id'] },
  options: { cols: 'option_id INTEGER, option_name TEXT, option_value TEXT, autoload TEXT', pk: ['option_id'] },
};
const RAW_TABLE = 'rest_objects';

const INDEXES = [
  ['posts', ['post_type', 'post_status']], ['posts', ['post_parent']], ['postmeta', ['post_id']], ['postmeta', ['meta_key']],
  ['term_relationships', ['term_taxonomy_id']], ['term_taxonomy', ['term_id']], ['comments', ['comment_post_ID']],
  ['usermeta', ['user_id']], ['options', ['option_name']],
];

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const dt = (s) => (s ? String(s).replace('T', ' ').slice(0, 19) : '0000-00-00 00:00:00');
const txt = (f) => (f == null ? '' : typeof f === 'object' ? (f.raw ?? f.rendered ?? '') : String(f));
const metaVal = (v) => (v == null ? '' : typeof v === 'object' ? serialize(v) : typeof v === 'boolean' ? (v ? '1' : '') : String(v));

function siteKey(siteUrl) {
  const u = new URL(siteUrl);
  return (u.hostname + u.pathname).toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function safeRel(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  return clean.replace(/[<>:"|?*\x00-\x1f]/g, '_') || null;
}

function uploadRel(m) {
  const src = m.source_url || '';
  let rel = null;
  const um = /\/uploads\/(.+)$/.exec(src.split('?')[0]);
  if (um) { try { rel = decodeURIComponent(um[1]); } catch { rel = um[1]; } }
  if (!rel && m.media_details && typeof m.media_details.file === 'string') rel = m.media_details.file;
  if (!rel) {
    const base = (() => { try { return decodeURIComponent(path.posix.basename(new URL(src).pathname)); } catch { return 'file-' + m.id; } })();
    rel = `${String(m.date || '').slice(0, 4) || '0000'}/${String(m.date || '').slice(5, 7) || '00'}/${base}`;
  }
  return safeRel(rel);
}

class SyncRunner {
  constructor({ onBeforeSwap } = {}) { this.job = null; this.onBeforeSwap = onBeforeSwap || (() => {}); }

  status() {
    if (!this.job) return null;
    const { api, ...pub } = this.job;
    return pub;
  }

  cancel() { if (this.job && this.job.state === 'running') { this.job.cancelled = true; this.log('Cancel requested — finishing up…'); } }

  start(opts) {
    if (this.job && this.job.state === 'running') throw new Error('Another sync is already running');
    const api = new WpApi({ url: opts.url, username: opts.username, appPassword: opts.appPassword });
    const key = siteKey(api.siteUrl);
    const progressDir = path.join(setDir(key), 'sync-progress');
    const resuming = fs.existsSync(progressDir) && fs.readdirSync(progressDir).some((name) => name.endsWith('.jsonl'));
    const media = ['none', 'originals', 'all'].includes(opts.media) ? opts.media : 'originals';
    const steps = [
      { id: 'connect', label: 'Connecting to REST API' },
      { id: 'structure', label: 'Reading content types & taxonomies' },
      { id: 'users', label: 'Fetching users' },
      { id: 'content', label: 'Fetching posts, pages & custom types' },
      { id: 'media', label: 'Fetching media library metadata' },
      { id: 'comments', label: 'Fetching comments' },
      { id: 'extras', label: 'Fetching menus, plugins & themes', skip: !api.authenticated },
      { id: 'database', label: 'Writing local database' },
      { id: 'download', label: media === 'all' ? 'Downloading originals + all sizes' : 'Downloading original media', skip: media === 'none' },
      { id: 'index', label: 'Indexing downloaded media' },
    ].map((s) => ({ ...s, status: s.skip ? 'skipped' : 'pending', progress: 0, detail: '' }));
    this.job = { key, site: api.siteUrl, state: 'running', steps, log: [], warnings: [], startedAt: new Date().toISOString(), error: null, resuming, api };
    this.run(api, key, { media, concurrency: Math.min(Math.max(+opts.concurrency || 4, 1), 12), limit: Math.max(0, +opts.limit || 0) }).then(() => {
      this.job.state = 'done';
      this.job.finishedAt = new Date().toISOString();
    }).catch((e) => {
      this.job.state = 'error';
      this.job.error = e.message;
      this.log('ERROR: ' + (e.stack || e.message));
      const dir = setDir(key);
      const m = readJson(path.join(dir, 'manifest.json'));
      if (m && m.status === 'syncing') { m.status = m.prevStatus === 'ready' ? 'ready' : 'error'; m.error = e.message; writeJson(path.join(dir, 'manifest.json'), m); }
    });
    return this.status();
  }

  log(msg) { this.job.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`); }

  warn(msg) { this.job.warnings.push(msg); this.log('⚠ ' + msg); }

  step(id) {
    const s = this.job.steps.find((x) => x.id === id);
    return {
      begin: () => { s.status = 'running'; this.log(s.label + '…'); },
      update: (progress, detail) => { s.progress = progress; if (detail !== undefined) s.detail = detail; },
      done: (detail) => { s.status = 'done'; s.progress = 1; if (detail !== undefined) s.detail = detail; this.log(`${s.label}: ${s.detail || 'done'}`); },
      skipped: s.status === 'skipped',
    };
  }

  // Fetch everything from an endpoint; on permission/availability errors record a warning and return [].
  async tryAll(api, route, params, onPage, label, max = 0) {
    try { return await this.getAll(api, route, params, onPage, max); } catch (e) {
      if (e.syncResumeAvailable) throw e;
      this.warn(`${label || route} skipped — ${e.message}${e.status === 401 || e.status === 403 ? ' (needs authentication / permission)' : ''}`);
      return [];
    }
  }

  async getAll(api, route, params = {}, onPage, max = 0) {
    const cacheKey = crypto.createHash('sha256')
      .update(JSON.stringify({ site: api.siteUrl, username: api.username, route, params, max }))
      .digest('hex');
    const file = path.join(this.progressDir, cacheKey + '.jsonl');
    const records = [];
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let valid = 0;
      for (const line of lines) {
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (record.complete === true || (Number.isInteger(record.page) && Array.isArray(record.items))) records.push(record);
          else break;
          valid++;
        } catch { break; }
      }
      if (valid < lines.filter(Boolean).length) {
        const good = records.map((record) => JSON.stringify(record)).join('\n');
        fs.writeFileSync(file, good ? good + '\n' : '');
      }
    }

    const cachedPages = records.filter((record) => Number.isInteger(record.page));
    const out = cachedPages.flatMap((record) => record.items);
    const isComplete = records.some((record) => record.complete === true);
    if (isComplete) {
      if (max && out.length > max) out.length = max;
      if (onPage) {
        const pages = cachedPages.length || 1;
        for (const record of cachedPages) {
          onPage({ page: record.page, pages: record.pages || pages, count: Math.min(out.length, record.count || out.length), total: record.total });
        }
      }
      return out;
    }
    if (onPage) {
      const pages = cachedPages[cachedPages.length - 1]?.pages || cachedPages.length;
      for (const record of cachedPages) {
        onPage({ page: record.page, pages, count: record.count || out.length, total: record.total });
      }
    }

    const perPage = max && max < 100 ? max : 100;
    let page = cachedPages.length + 1;
    let pages = cachedPages.length ? cachedPages[cachedPages.length - 1].pages || page : 1;
    let total = cachedPages.length ? cachedPages[cachedPages.length - 1].total : null;
    while (page <= pages) {
      let r;
      try { r = await api.request(route, { per_page: perPage, ...params, page }); } catch (e) {
        if (page > 1 || cachedPages.length) e.syncResumeAvailable = true;
        throw e;
      }
      if (!Array.isArray(r.data)) {
        const items = r.data && typeof r.data === 'object' ? Object.values(r.data) : [];
        fs.appendFileSync(file, JSON.stringify({ page: 1, items, count: items.length, pages: 1, total: r.total }) + '\n');
        fs.appendFileSync(file, JSON.stringify({ complete: true }) + '\n');
        return items;
      }
      out.push(...r.data);
      pages = r.pages || (r.data.length >= perPage ? page + 1 : page);
      total = r.total ?? total;
      if (max && out.length >= max) { out.length = max; pages = page; }
      const record = { page, items: r.data, count: out.length, pages, total };
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
      if (onPage) onPage({ page, pages, count: out.length, total: max && total ? Math.min(total, max) : total });
      if (!r.data.length) break;
      page++;
    }
    fs.appendFileSync(file, JSON.stringify({ complete: true }) + '\n');
    return out;
  }

  cleanupCompletedProgress() {
    for (const name of fs.readdirSync(this.progressDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.progressDir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      let complete = false;
      for (const line of lines) {
        try { if (JSON.parse(line).complete === true) complete = true; } catch { complete = false; break; }
      }
      if (complete) fs.rmSync(file, { force: true });
    }
    if (!fs.readdirSync(this.progressDir).length) fs.rmdirSync(this.progressDir);
  }

  async run(api, key, opts) {
    const dir = setDir(key);
    fs.mkdirSync(dir, { recursive: true });
    this.progressDir = path.join(dir, 'sync-progress');
    fs.mkdirSync(this.progressDir, { recursive: true });
    if (this.job.resuming) this.log('Resuming saved API page progress…');
    const prev = readJson(path.join(dir, 'manifest.json'), {});
    const ctx = api.authenticated ? 'edit' : 'view';
    const manifest = {
      key, site: api.siteUrl, siteUrl: api.siteUrl, username: api.username || null, authenticated: api.authenticated,
      mediaMode: opts.media, limit: opts.limit || 0, status: 'syncing', prevStatus: prev.status, date: prev.syncedAt || new Date().toISOString(),
      syncedAt: prev.syncedAt, stats: prev.stats || {}, uploadsBase: prev.uploadsBase,
    };
    writeJson(path.join(dir, 'manifest.json'), manifest);

    const data = { options: {}, posts: new Map(), postmeta: [], terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], raw: [] };
    const addMeta = (postId, k, v) => { if (v !== undefined && v !== null && v !== '') data.postmeta.push([postId, k, metaVal(v)]); };
    const raw = (kind, obj) => data.raw.push([kind, obj.id ?? obj.slug ?? obj.plugin ?? obj.stylesheet ?? '', JSON.stringify(obj)]);

    // 1. connect
    let s = this.step('connect');
    s.begin();
    await api.discover();
    const idx = api.index;
    manifest.apiRoot = api.root;
    manifest.site = idx.name || api.siteUrl;
    const home = (idx.home || idx.url || api.siteUrl).replace(/\/+$/, '');
    Object.assign(data.options, {
      siteurl: idx.url || api.siteUrl, home, blogname: idx.name || '', blogdescription: idx.description || '',
      gmt_offset: idx.gmt_offset ?? '', timezone_string: idx.timezone_string || '', rest_namespaces: idx.namespaces || [],
    });
    if (idx.site_icon_url) data.options.site_icon_url = idx.site_icon_url;
    if (api.authenticated) {
      try {
        const me = await api.get('/wp/v2/users/me', { context: 'edit' });
        this.log(`Authenticated as ${me.name} (${(me.roles || []).join(', ') || 'no roles'})`);
        manifest.authUser = { id: me.id, name: me.name, roles: me.roles || [] };
      } catch (e) {
        throw new Error(`Authentication failed: ${e.message}. Check the username and Application Password (Users → Profile → Application Passwords).`);
      }
      try {
        const st = await api.get('/wp/v2/settings');
        const map = { title: 'blogname', description: 'blogdescription', email: 'admin_email', timezone: 'timezone_string', language: 'WPLANG' };
        for (const [k, v] of Object.entries(st || {})) data.options[map[k] || k] = v;
      } catch (e) { this.warn('Settings skipped — ' + e.message); }
    }
    s.done(`${manifest.site} · ${api.pretty ? 'pretty' : 'plain'} REST at ${api.root}${api.authenticated ? ' · authenticated' : ' · public'}`);
    if (this.job.cancelled) throw new Error('Cancelled');

    // 2. types & taxonomies & terms
    s = this.step('structure');
    s.begin();
    let types = [];
    let taxes = [];
    try { types = Object.values(await api.get('/wp/v2/types', { context: ctx }) || {}); } catch (e) { this.warn('Types skipped — ' + e.message); }
    try { taxes = Object.values(await api.get('/wp/v2/taxonomies', { context: ctx }) || {}); } catch (e) { this.warn('Taxonomies skipped — ' + e.message); }
    if (!types.length) types = [{ slug: 'post', rest_base: 'posts' }, { slug: 'page', rest_base: 'pages' }];
    if (!taxes.length) taxes = [{ slug: 'category', rest_base: 'categories', types: ['post'] }, { slug: 'post_tag', rest_base: 'tags', types: ['post'] }];
    taxes = taxes.filter((t) => t.rest_base && !SKIP_TAX.has(t.slug));
    data.options.rest_types = types.map((t) => ({ slug: t.slug, name: t.name, rest_base: t.rest_base }));
    let ti = 0;
    for (const tx of taxes) {
      s.update(ti++ / taxes.length, tx.slug);
      const ns = tx.rest_namespace || 'wp/v2';
      const terms = await this.tryAll(api, `/${ns}/${tx.rest_base}`, { context: ctx, hide_empty: 'false' }, null, `Terms of ${tx.slug}`);
      for (const t of terms) { data.terms.set(t.id, { ...t, taxonomy: t.taxonomy || tx.slug }); raw('term', t); }
    }
    s.done(`${types.length} types, ${taxes.length} taxonomies, ${data.terms.size} terms`);

    // 3. users
    s = this.step('users');
    s.begin();
    let users;
    try { users = await this.getAll(api, '/wp/v2/users', { context: ctx }, (p) => s.update(p.page / p.pages, `${p.count} users`)); } catch (e) {
      if (e.syncResumeAvailable) throw e;
      users = ctx === 'edit' ? await this.tryAll(api, '/wp/v2/users', {}, null, 'Users') : (this.warn('Users skipped — ' + e.message), []);
    }
    for (const u of users) {
      data.users.set(u.id, [u.id, u.username || u.slug, u.slug, u.email || '', u.url || '', dt(u.registered_date), u.name || u.slug]);
      let um = 0;
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') data.usermeta.push([u.id, k, metaVal(v)]); um++; };
      add('nickname', u.nickname);
      add('first_name', u.first_name);
      add('last_name', u.last_name);
      add('description', u.description);
      if (u.roles) add(PREFIX + 'capabilities', Object.fromEntries(u.roles.map((r) => [r, true])));
      if (u.avatar_urls) add('_wpx_avatar', Object.values(u.avatar_urls).pop());
      raw('user', u);
    }
    s.done(`${users.length} users`);
    if (this.job.cancelled) throw new Error('Cancelled');

    // 4. posts of every public REST type
    s = this.step('content');
    s.begin();
    const taxByType = (slug) => taxes.filter((t) => !t.types || t.types.includes(slug));
    let contentFormat = null;
    const postTypes = types.filter((t) => t.rest_base && !SKIP_TYPES.has(t.slug));
    const typeCounts = {};
    for (let i = 0; i < postTypes.length; i++) {
      const t = postTypes[i];
      const ns = t.rest_namespace || 'wp/v2';
      const params = { context: ctx, ...(api.authenticated ? { status: 'any' } : {}), orderby: 'id', order: 'desc' };
      const items = await this.tryAll(api, `/${ns}/${t.rest_base}`, params, (p) => s.update((i + p.page / p.pages) / postTypes.length, `${t.slug}: ${p.count}${p.total ? '/' + p.total : ''}`), `Type "${t.slug}"`, opts.limit);
      typeCounts[t.slug] = items.length;
      for (const p of items) {
        const content = p.content || {};
        if (content.raw !== undefined) contentFormat ||= 'raw';
        else if (content.rendered !== undefined) contentFormat ||= 'rendered';
        data.posts.set(p.id, {
          ID: p.id, post_author: p.author || 0, post_date: dt(p.date), post_date_gmt: dt(p.date_gmt), post_content: txt(p.content),
          post_title: txt(p.title), post_excerpt: txt(p.excerpt), post_status: p.status || 'publish', comment_status: p.comment_status || '',
          ping_status: p.ping_status || '', post_password: p.password || '', post_name: p.slug || '', post_modified: dt(p.modified),
          post_modified_gmt: dt(p.modified_gmt), post_parent: p.parent || 0, guid: p.link || txt(p.guid), menu_order: p.menu_order || 0,
          post_type: p.type || t.slug, post_mime_type: '', comment_count: 0,
        });
        if (p.featured_media) addMeta(p.id, '_thumbnail_id', p.featured_media);
        if (p.template) addMeta(p.id, '_wp_page_template', p.template);
        if (p.format && p.format !== 'standard') addMeta(p.id, '_wpx_format', p.format);
        if (p.sticky) addMeta(p.id, '_wpx_sticky', 1);
        if (p.link) addMeta(p.id, '_wpx_link', p.link);
        if (p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta)) for (const [k, v] of Object.entries(p.meta)) addMeta(p.id, k, v);
        if (p.acf && typeof p.acf === 'object' && !Array.isArray(p.acf)) for (const [k, v] of Object.entries(p.acf)) addMeta(p.id, k, v);
        if (p.yoast_head_json) {
          const y = p.yoast_head_json;
          addMeta(p.id, '_wpx_seo', { title: y.title, description: y.description, canonical: y.canonical, og_title: y.og_title, og_description: y.og_description, og_image: (y.og_image || []).map((o) => o.url) });
        }
        for (const tx of taxByType(p.type || t.slug)) {
          const ids = p[tx.rest_base];
          if (Array.isArray(ids)) for (const id of ids) data.rels.push([p.id, typeof id === 'object' ? id.id : id]);
        }
        raw(p.type || t.slug, p);
      }
      if (this.job.cancelled) throw new Error('Cancelled');
    }
    s.done(Object.entries(typeCounts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no content found');

    // 5. media library
    s = this.step('media');
    s.begin();
    const mediaItems = await this.tryAll(api, '/wp/v2/media', { context: ctx, orderby: 'id', order: 'desc' }, (p) => s.update(p.page / p.pages, `${p.count}${p.total ? '/' + p.total : ''} items`), 'Media', opts.limit);
    // A limited sync keeps the newest media only — also pull featured images of the synced content
    if (opts.limit) {
      const have = new Set(mediaItems.map((m) => m.id));
      const want = [...new Set(data.postmeta.filter(([, k]) => k === '_thumbnail_id').map(([, , v]) => +v))].filter((id) => id && !have.has(id));
      for (let i = 0; i < want.length; i += 100) {
        const chunk = want.slice(i, i + 100);
        const extra = await this.tryAll(api, '/wp/v2/media', { context: ctx, include: chunk.join(','), per_page: 100 }, () => s.update(i / want.length, `featured images: ${i + chunk.length}/${want.length}`), 'Featured media');
        mediaItems.push(...extra);
      }
    }
    const downloads = [];
    const seenRel = new Set();
    const queue = (url, rel, expectedSize, kind) => {
      if (!url || !rel || seenRel.has(rel)) return;
      seenRel.add(rel);
      downloads.push({ url, rel, expectedSize, kind });
    };
    for (const m of mediaItems) {
      const rel = uploadRel(m);
      const md = m.media_details && typeof m.media_details === 'object' && !Array.isArray(m.media_details) ? m.media_details : {};
      if (!manifest.uploadsBase && rel && m.source_url) {
        const enc = m.source_url.split('?')[0];
        const tail = '/' + rel.split('/').map(encodeURIComponent).join('/');
        if (enc.endsWith(tail)) manifest.uploadsBase = enc.slice(0, -tail.length);
        else if (/\/uploads\//.test(enc)) manifest.uploadsBase = enc.slice(0, enc.indexOf('/uploads/') + 8);
      }
      const relDir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
      const srcDir = m.source_url ? m.source_url.slice(0, m.source_url.lastIndexOf('/') + 1) : '';
      const sizes = {};
      for (const [name, sz] of Object.entries(md.sizes && typeof md.sizes === 'object' ? md.sizes : {})) {
        if (!sz || !sz.file) continue;
        sizes[name] = { file: sz.file, width: sz.width, height: sz.height, 'mime-type': sz.mime_type || sz['mime-type'] || '', ...(sz.filesize ? { filesize: sz.filesize } : {}) };
      }
      const meta = {
        ...(md.width ? { width: md.width, height: md.height } : {}), file: rel, ...(md.filesize ? { filesize: md.filesize } : {}),
        sizes, ...(md.image_meta ? { image_meta: md.image_meta } : {}), ...(md.original_image ? { original_image: md.original_image } : {}),
      };
      for (const k of ['length', 'length_formatted', 'bitrate', 'dataformat', 'codec', 'sample_rate', 'channels', 'fileformat', 'mime_type', 'audio', 'artist', 'album']) if (md[k] !== undefined) meta[k] = md[k];
      data.posts.set(m.id, {
        ID: m.id, post_author: m.author || 0, post_date: dt(m.date), post_date_gmt: dt(m.date_gmt),
        post_content: m.description && m.description.raw !== undefined ? m.description.raw : T.htmlToText(txt(m.description)),
        post_title: txt(m.title), post_excerpt: m.caption && m.caption.raw !== undefined ? m.caption.raw : T.htmlToText(txt(m.caption)),
        post_status: m.status || 'inherit', comment_status: m.comment_status || '', ping_status: m.ping_status || '', post_password: '',
        post_name: m.slug || '', post_modified: dt(m.modified), post_modified_gmt: dt(m.modified_gmt), post_parent: m.post || 0,
        guid: m.source_url || txt(m.guid), menu_order: 0, post_type: 'attachment', post_mime_type: m.mime_type || '', comment_count: 0,
      });
      if (rel) addMeta(m.id, '_wp_attached_file', rel);
      addMeta(m.id, '_wp_attachment_metadata', meta);
      addMeta(m.id, '_wp_attachment_image_alt', m.alt_text);
      addMeta(m.id, '_wpx_source_url', m.source_url);
      if (m.link) addMeta(m.id, '_wpx_link', m.link);
      raw('attachment', m);
      // original first (pre-scaling upload), then the attached file, then generated sizes
      if (md.original_image && srcDir) queue(srcDir + encodeURIComponent(md.original_image).replace(/%2F/g, '/'), safeRel(relDir + md.original_image), null, 'original');
      else queue(m.source_url, rel, md.filesize || null, 'original');
      if (opts.media === 'all') {
        if (md.original_image) queue(m.source_url, rel, md.filesize || null, 'scaled');
        for (const sz of Object.values(md.sizes || {})) if (sz && sz.file) queue(sz.source_url || srcDir + sz.file, safeRel(relDir + sz.file), sz.filesize || null, 'size');
      }
    }
    if (!manifest.uploadsBase) manifest.uploadsBase = home + '/wp-content/uploads';
    s.done(`${mediaItems.length} media items · ${downloads.length} files to download`);
    if (this.job.cancelled) throw new Error('Cancelled');

    // 6. comments
    s = this.step('comments');
    s.begin();
    let comments = [];
    if (api.authenticated) {
      try { comments = await this.getAll(api, '/wp/v2/comments', { context: ctx, status: 'all' }, (p) => s.update(p.page / p.pages, `${p.count} comments`), opts.limit); } catch (e) {
        if (e.syncResumeAvailable) throw e;
        comments = null;
      }
      if (!comments) {
        comments = [];
        for (const st of ['approve', 'hold', 'spam']) comments.push(...await this.tryAll(api, '/wp/v2/comments', { context: ctx, status: st }, null, `Comments (${st})`, opts.limit));
      }
    } else {
      comments = await this.tryAll(api, '/wp/v2/comments', { context: ctx }, (p) => s.update(p.page / p.pages, `${p.count} comments`), 'Comments', opts.limit);
    }
    const approvedMap = { approved: '1', approve: '1', hold: '0', unapproved: '0', spam: 'spam', trash: 'trash' };
    for (const c of comments) {
      data.comments.push([c.id, c.post, c.author_name || '', c.author_email || '', c.author_url || '', dt(c.date), dt(c.date_gmt), txt(c.content),
        approvedMap[c.status] ?? String(c.status || '1'), c.type === 'comment' ? 'comment' : c.type || 'comment', c.parent || 0, c.author || 0]);
      raw('comment', c);
    }
    s.done(`${comments.length} comments`);

    // 7. menus, plugins, themes (authenticated only)
    s = this.step('extras');
    const addons = { plugins: [], themes: [], muPlugins: [] };
    if (!s.skipped) {
      s.begin();
      const menus = await this.tryAll(api, '/wp/v2/menus', { context: ctx }, null, 'Menus');
      const locations = {};
      for (const mn of menus) {
        data.terms.set(mn.id, { id: mn.id, name: mn.name, slug: mn.slug, taxonomy: 'nav_menu', description: mn.description || '', parent: 0, count: 0 });
        for (const loc of mn.locations || []) locations[loc] = mn.id;
        raw('menu', mn);
      }
      if (Object.keys(locations).length) data.options.nav_menu_locations = locations;
      s.update(0.3, `${menus.length} menus`);
      const items = menus.length ? await this.tryAll(api, '/wp/v2/menu-items', { context: ctx }, null, 'Menu items') : [];
      for (const it of items) {
        data.posts.set(it.id, {
          ID: it.id, post_author: 0, post_date: dt(null), post_date_gmt: dt(null), post_content: txt(it.description), post_title: txt(it.title),
          post_excerpt: txt(it.attr_title), post_status: it.status || 'publish', comment_status: '', ping_status: '', post_password: '',
          post_name: String(it.id), post_modified: dt(null), post_modified_gmt: dt(null), post_parent: 0, guid: it.url || '',
          menu_order: it.menu_order || 0, post_type: 'nav_menu_item', post_mime_type: '', comment_count: 0,
        });
        addMeta(it.id, '_menu_item_type', it.type);
        addMeta(it.id, '_menu_item_object', it.object);
        addMeta(it.id, '_menu_item_object_id', it.object_id);
        addMeta(it.id, '_menu_item_url', it.url);
        addMeta(it.id, '_menu_item_menu_item_parent', String(it.parent || 0));
        addMeta(it.id, '_menu_item_target', it.target);
        const mid = Array.isArray(it.menus) ? it.menus[0] : it.menus;
        if (mid) { data.rels.push([it.id, mid]); const term = data.terms.get(mid); if (term) term.count++; }
        raw('menu_item', it);
      }
      s.update(0.6, `${menus.length} menus, ${items.length} items`);
      const plugins = await this.tryAll(api, '/wp/v2/plugins', { context: ctx }, null, 'Plugins');
      for (const p of plugins) {
        addons.plugins.push({
          name: T.decodeEntities(p.name || p.plugin), slug: p.plugin, folder: String(p.plugin || '').split('/')[0], version: p.version,
          description: T.htmlToText(txt(p.description)), author: T.htmlToText(txt(p.author)), authorUri: p.author_uri, uri: p.plugin_uri,
          requires: p.requires_wp, requiresPhp: p.requires_php, textDomain: p.textdomain, status: p.status, active: /active/.test(p.status || '') && p.status !== 'inactive',
        });
        raw('plugin', p);
      }
      data.options.active_plugins = addons.plugins.filter((p) => p.active).map((p) => p.slug + '.php');
      const themes = await this.tryAll(api, '/wp/v2/themes', { context: ctx }, null, 'Themes');
      for (const t of themes) {
        const th = {
          name: T.decodeEntities(txt(t.name) || t.stylesheet), slug: t.stylesheet, template: t.template, version: t.version,
          description: T.htmlToText(txt(t.description)), author: T.htmlToText(txt(t.author)), authorUri: txt(t.author_uri), uri: txt(t.theme_uri),
          tags: (t.tags && (t.tags.rendered || t.tags.raw)) || '', screenshotUrl: t.screenshot || null, status: t.status, active: t.status === 'active',
          requires: t.requires_wp, requiresPhp: t.requires_php, textDomain: t.textdomain, blockTheme: t.is_block_theme,
        };
        if (Array.isArray(th.tags)) th.tags = th.tags.join(', ');
        addons.themes.push(th);
        if (th.active) Object.assign(data.options, { stylesheet: t.stylesheet, template: t.template, current_theme: th.name });
        raw('theme', t);
      }
      s.done(`${menus.length} menus, ${addons.plugins.length} plugins, ${addons.themes.length} themes`);
    }
    writeJson(path.join(dir, 'addons.json'), addons);

    // 8. database
    s = this.step('database');
    s.begin();
    const counts = this.writeDb(path.join(dir, 'db.sqlite'), key, data, { contentFormat: contentFormat || 'rendered', api, manifest });
    manifest.db = { tables: counts.tables, rows: counts.rows, prefix: PREFIX };
    manifest.stats.counts = { ...typeCounts, attachment: mediaItems.length, comments: comments.length, users: users.length, terms: data.terms.size };
    manifest.status = 'ready';
    manifest.syncedAt = new Date().toISOString();
    manifest.warnings = this.job.warnings;
    manifest.requests = api.requests;
    writeJson(path.join(dir, 'manifest.json'), manifest);
    s.done(`${counts.rows.toLocaleString()} rows in ${counts.tables} tables`);

    // 9. download
    s = this.step('download');
    const uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    if (!s.skipped) {
      s.begin();
      const stats = await this.downloadAll(api, downloads, uploadsDir, opts.concurrency, s);
      manifest.download = { ...stats, mode: opts.media, at: new Date().toISOString() };
      s.done(`${stats.downloaded} downloaded, ${stats.skipped} already present, ${stats.failed} failed · ${fmtBytes(stats.bytes)}${this.job.cancelled ? ' (cancelled)' : ''}`);
    }

    // 10. index
    s = this.step('index');
    s.begin();
    const index = buildUploadsIndex(uploadsDir);
    writeJson(path.join(dir, 'uploads-index.json'), index);
    manifest.stats.uploads = { files: index.length, images: index.filter((x) => x.image).length, originals: index.filter((x) => x.image && !x.variantOf).length, size: index.reduce((a, x) => a + x.size, 0) };
    manifest.totalSize = manifest.stats.uploads.size;
    manifest.warnings = this.job.warnings;
    manifest.requests = api.requests;
    delete manifest.prevStatus;
    this.onBeforeSwap(key);
    writeJson(path.join(dir, 'manifest.json'), manifest);
    s.done(`${index.length} files indexed`);
    if (!this.job.cancelled) this.cleanupCompletedProgress();
  }

  async downloadAll(api, list, uploadsDir, concurrency, s) {
    const stats = { total: list.length, downloaded: 0, skipped: 0, failed: 0, bytes: 0, failures: [] };
    let next = 0;
    let doneN = 0;
    let lastName = '';
    const tick = () => s.update(list.length ? doneN / list.length : 1, `${doneN}/${list.length} · ${fmtBytes(stats.bytes)} · ${lastName}`);
    const worker = async () => {
      while (next < list.length && !this.job.cancelled) {
        const d = list[next++];
        const dest = path.join(uploadsDir, ...d.rel.split('/'));
        if (!dest.startsWith(uploadsDir)) { stats.failed++; doneN++; continue; }
        try {
          const r = await api.download(d.url, dest, { expectedSize: d.expectedSize });
          if (r.skipped) stats.skipped++; else { stats.downloaded++; stats.bytes += r.size; }
        } catch (e) {
          stats.failed++;
          if (stats.failures.length < 200) stats.failures.push({ url: d.url, error: e.message });
          this.log(`✗ ${d.rel}: ${e.message}`);
        }
        doneN++;
        lastName = d.rel;
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
    if (stats.failed) this.warn(`${stats.failed} media file(s) failed to download (see log)`);
    return stats;
  }

  writeDb(file, key, data, { contentFormat, api, manifest }) {
    const tmp = file + '.tmp';
    fs.rmSync(tmp, { force: true });
    const db = open(tmp);
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
    db.exec(`CREATE TABLE __meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE __tables (name TEXT PRIMARY KEY, create_sql TEXT, columns TEXT, primary_key TEXT, rows INTEGER DEFAULT 0, bad_rows INTEGER DEFAULT 0);`);
    const insT = db.prepare('INSERT INTO __tables (name, create_sql, columns, primary_key, rows) VALUES (?,?,?,?,?)');
    let totalRows = 0;
    const tableCount = Object.keys(SCHEMA).length + 1;
    const make = (name, cols, pk, rows) => {
      const createSql = `CREATE TABLE ${qi(name)} (${cols}, PRIMARY KEY (${pk.map(qi).join(', ')}))`;
      db.exec(createSql);
      const colNames = cols.split(',').map((c) => c.trim().split(/\s+/));
      const ins = db.prepare(`INSERT OR REPLACE INTO ${qi(name)} VALUES (${colNames.map(() => '?').join(',')})`);
      db.exec('BEGIN');
      let n = 0;
      for (const r of rows) { ins.run(...r.map((v) => (v === undefined ? null : v))); n++; }
      db.exec('COMMIT');
      insT.run(name, createSql, JSON.stringify(colNames.map(([c, t]) => ({ name: c, type: t.toLowerCase() }))), JSON.stringify(pk), n);
      totalRows += n;
    };

    const commentCount = {};
    for (const c of data.comments) if (c[8] === '1') commentCount[c[1]] = (commentCount[c[1]] || 0) + 1;
    const postCols = SCHEMA.posts.cols.split(',').map((c) => c.trim().split(/\s+/)[0]);
    make(PREFIX + 'posts', SCHEMA.posts.cols, SCHEMA.posts.pk, [...data.posts.values()].map((p) => postCols.map((c) => (c === 'comment_count' ? commentCount[p.ID] || 0 : p[c]))));
    make(PREFIX + 'postmeta', SCHEMA.postmeta.cols, SCHEMA.postmeta.pk, data.postmeta.map((r, i) => [i + 1, ...r]));
    make(PREFIX + 'terms', SCHEMA.terms.cols, SCHEMA.terms.pk, [...data.terms.values()].map((t) => [t.id, t.name, t.slug, 0]));
    make(PREFIX + 'term_taxonomy', SCHEMA.term_taxonomy.cols, SCHEMA.term_taxonomy.pk, [...data.terms.values()].map((t) => [t.id, t.id, t.taxonomy, t.description || '', t.parent || 0, t.count || 0]));
    make(PREFIX + 'term_relationships', SCHEMA.term_relationships.cols, SCHEMA.term_relationships.pk, data.rels.map(([o, t]) => [o, t, 0]));
    make(PREFIX + 'comments', SCHEMA.comments.cols, SCHEMA.comments.pk, data.comments);
    make(PREFIX + 'users', SCHEMA.users.cols, SCHEMA.users.pk, [...data.users.values()]);
    make(PREFIX + 'usermeta', SCHEMA.usermeta.cols, SCHEMA.usermeta.pk, data.usermeta.map((r, i) => [i + 1, ...r]));
    make(PREFIX + 'options', SCHEMA.options.cols, SCHEMA.options.pk, Object.entries(data.options).map(([k, v], i) => [i + 1, k, metaVal(v), 'yes']));
    make(RAW_TABLE, 'kind TEXT, id TEXT, json TEXT', ['kind', 'id'], data.raw);

    for (const [t, cols] of INDEXES) db.exec(`CREATE INDEX ${qi('ix_' + PREFIX + t + '_' + cols.join('_'))} ON ${qi(PREFIX + t)} (${cols.map(qi).join(',')})`);
    const insMeta = db.prepare('INSERT INTO __meta (key, value) VALUES (?, ?)');
    const info = {
      'Site URL': api.siteUrl, 'Site name': manifest.site, 'REST API root': api.root, 'Synced at': new Date().toISOString(),
      'Access': api.authenticated ? `authenticated as ${api.username}` : 'public (unauthenticated)', 'Content format': contentFormat === 'raw' ? 'raw (editor source)' : 'rendered HTML',
      'Media mode': manifest.mediaMode, 'Uploads base URL': manifest.uploadsBase, 'REST requests': String(api.requests),
    };
    for (const [k, v] of Object.entries(info)) insMeta.run(k, v ?? '');
    insMeta.run('__prefix', PREFIX);
    insMeta.run('__content_format', contentFormat);
    insMeta.run('__source', 'wp-rest-api');
    db.close();
    this.onBeforeSwap(key);
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
    return { tables: tableCount, rows: totalRows };
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// Quick connection probe: discovers the API and counts items per public type without syncing.
async function probe({ url, username, appPassword }) {
  const api = new WpApi({ url, username, appPassword, timeout: 30000 });
  await api.discover();
  const idx = api.index;
  const out = {
    siteUrl: api.siteUrl, key: siteKey(api.siteUrl), apiRoot: api.root, pretty: api.pretty, name: idx.name, description: idx.description,
    home: idx.home, url: idx.url, timezone: idx.timezone_string, namespaces: idx.namespaces || [], siteIcon: idx.site_icon_url || null,
    authenticated: false, user: null, counts: [], warnings: [],
  };
  if (api.authenticated) {
    try {
      const me = await api.get('/wp/v2/users/me', { context: 'edit' });
      out.authenticated = true;
      out.user = { name: me.name, roles: me.roles || [] };
    } catch (e) { out.warnings.push('Authentication failed: ' + e.message); }
  }
  const ctxParams = out.authenticated ? { status: 'any', context: 'edit' } : {};
  let types = [];
  try { types = Object.values(await api.get('/wp/v2/types') || {}); } catch (e) { out.warnings.push('Types: ' + e.message); types = [{ slug: 'post', name: 'Posts', rest_base: 'posts' }, { slug: 'page', name: 'Pages', rest_base: 'pages' }]; }
  const targets = types.filter((t) => t.rest_base && !SKIP_TYPES.has(t.slug)).map((t) => ({ slug: t.slug, name: t.name || t.slug, route: `/${t.rest_namespace || 'wp/v2'}/${t.rest_base}`, params: ctxParams }));
  targets.push({ slug: 'attachment', name: 'Media', route: '/wp/v2/media', params: out.authenticated ? { context: 'edit' } : {} });
  targets.push({ slug: 'comment', name: 'Comments', route: '/wp/v2/comments', params: {} });
  targets.push({ slug: 'user', name: 'Users', route: '/wp/v2/users', params: {} });
  await Promise.all(targets.map(async (t) => {
    try { out.counts.push({ slug: t.slug, name: t.name, n: await api.count(t.route, t.params) }); } catch (e) { out.counts.push({ slug: t.slug, name: t.name, n: null, error: e.status === 401 || e.status === 403 ? 'needs auth' : e.message }); }
  }));
  const order = targets.map((t) => t.slug);
  out.counts.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  return out;
}

module.exports = { SyncRunner, probe, siteKey };
