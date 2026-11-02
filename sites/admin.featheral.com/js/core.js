/* Core helpers, router, sidebar */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n === null || n === undefined || n === '' ? '–' : Number(n).toLocaleString());
const fmtBytes = (b) => {
  if (!b && b !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (d) => (d ? String(d).replace('T', ' ').slice(0, 16) : '–');
const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
const TYPE_ICON = { post: '📝', page: '📄', attachment: '🖼', revision: '🕘', nav_menu_item: '☰', product: '🛒' };
const PALETTE = ['#4f46e5', '#db2777', '#059669', '#d97706', '#0891b2', '#7c3aed', '#dc2626', '#65a30d', '#2563eb', '#9333ea'];

async function api(url, opts = {}) {
  if (opts.json) { opts.method ||= 'POST'; opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || r.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed'); }
}

const state = { key: null, library: [], overview: {}, seq: 0, config: { brand: 'admin.featheral.com', siteKey: null, locked: false } };
let viewCleanup = null;
let leaveView = null;
let activeHash = location.hash;
const publicPreview = (key = state.key, hash = '') => {
  const site = state.library.find((s) => s.key === key);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname === 'admin.localhost';
  return (local ? `/?site=${encodeURIComponent(key)}` : `https://${site?.hostname || state.config.publicHost}${site?.path || ''}/`) + hash;
};
const isLocal = () => state.config.locked;
const managesSites = () => state.config.siteManagement === true;
const homeKey = () => state.config.siteKey || state.library.find((m) => m.status === 'ready')?.key || null;

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [p, qs] = h.split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function hrefFor(parts, q = {}) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();
  return '#/' + parts.map(encodeURIComponent).join('/') + (qs ? '?' + qs : '');
}

function setHref(view, arg, q) { return hrefFor(['set', state.key, view, ...(arg !== undefined && arg !== null ? [String(arg)] : [])], q); }

function patchQuery(patch, keepPage = false) {
  const { parts, q } = parseHash();
  const next = { ...q, ...patch };
  if (!keepPage && !('page' in patch)) delete next.page;
  location.hash = hrefFor(parts, next);
}

const STALE = Symbol('stale');
function setView(html, token) {
  if (token !== undefined && token !== state.seq) throw STALE;
  $('#view').innerHTML = html;
  return true;
}

function setCrumbs(html, actions = '') {
  $('#crumbs').innerHTML = html;
  $('#top-actions').innerHTML = actions;
}

function loading(msg = 'Loading…') { return `<div class="loading"><span class="spinner"></span>${esc(msg)}</div>`; }
function errorBox(e) { return `<div class="err"><b>Error:</b> ${esc(e.message || e)}</div>`; }
function emptyBox(icon, msg) { return `<div class="empty"><div class="big">${icon}</div>${msg}</div>`; }

function pager(total, page, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  page = +page || 1;
  const from = total ? (page - 1) * limit + 1 : 0;
  return `<div class="pager"><span class="muted">${fmtNum(from)}–${fmtNum(Math.min(total, page * limit))} of ${fmtNum(total)}</span>
    <span class="row">
      <button class="btn sm" data-page="1" ${page <= 1 ? 'disabled' : ''}>«</button>
      <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="small muted">Page ${page} / ${pages}</span>
      <button class="btn sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>
      <button class="btn sm" data-page="${pages}" ${page >= pages ? 'disabled' : ''}>»</button>
    </span></div>`;
}

function bindPager(root = $('#view')) {
  $$('[data-page]', root).forEach((b) => b.addEventListener('click', () => patchQuery({ page: b.dataset.page })));
}

function bindSearch(input, key = 'q') {
  if (!input) return;
  let h;
  input.addEventListener('input', () => { clearTimeout(h); h = setTimeout(() => patchQuery({ [key]: input.value.trim() }), 450); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(h); patchQuery({ [key]: input.value.trim() }); } });
}

function bindSelects(root = $('#view')) {
  $$('select[data-q]', root).forEach((s) => s.addEventListener('change', () => patchQuery({ [s.dataset.q]: s.value })));
}

function options(list, selected, emptyLabel) {
  return (emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : '') +
    list.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('');
}

function modal(title, body, { narrow = false, head = '' } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal ${narrow ? 'narrow' : ''}">
    <div class="modal-head"><h3>${title}</h3>${head}<button class="icon-btn" data-close title="Close (Esc)">✕</button></div>
    <div class="modal-content" style="display:flex;flex-direction:column;min-height:0;flex:1">${body}</div></div></div>`;
  const back = $('.modal-back', root);
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  $('[data-close]', root).addEventListener('click', closeModal);
  return $('.modal', root);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function kvTable(obj) {
  const rows = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!rows.length) return '<div class="muted small">No data</div>';
  return `<table class="tbl kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${typeof v === 'object' ? `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>` : esc(v)}</td></tr>`).join('')}</table>`;
}

function statusChip(s) {
  const cls = { publish: 'ok', draft: 'warn', pending: 'warn', future: 'brand', private: 'bad', trash: 'bad' }[s] || '';
  return `<span class="chip ${cls}">${esc(s)}</span>`;
}

// ---------- sidebar ----------
async function loadConfig() {
  state.config = { ...state.config, ...(await api('/api/config')) };
  document.title = state.config.brand;
  $('#brand-name').textContent = state.config.brand;
  if (isLocal()) $('.sidebar-foot').textContent = 'Local software · stored data only';
  if (managesSites()) state.integratedSites = (await api('/api/sites')).filter(site => site.builtin);
}

async function loadLibrary() {
  state.library = await api('/api/library');
  return state.library;
}

async function ensureOverview(key, force = false) {
  if (!state.overview[key] || force) state.overview[key] = await api(`/api/sets/${encodeURIComponent(key)}/overview`);
  return state.overview[key];
}

const HIDDEN_TYPES = ['attachment', 'revision', 'nav_menu_item', 'customize_changeset', 'oembed_cache', 'wp_global_styles', 'wp_template', 'wp_template_part', 'wp_navigation', 'custom_css', 'wp_font_family', 'wp_font_face', 'user_request', 'wp_block'];

function siteSelectionUrl(site) {
  return site.hostname ? `https://${site.hostname}${site.path || ''}/` : site.siteUrl;
}

const DEPLOY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>';
const OPERATION_VIEWS = [
  { key: 'foundation', hostname: 'featheral.com', label: 'Foundation overview', description: 'Governance, ecosystem status and foundation management.' },
  { key: 'gold', hostname: 'gold.featheral.com', label: 'Gold reserve & token', description: 'FTHG, Ethereum backing and reserve administration.' },
  { key: 'dollar', hostname: 'dollar.featheral.com', label: 'Dollar ledger & funds', description: 'FTH$ ledger, treasury, transfers and redemption management.' },
  { key: 'world', hostname: 'world.featheral.com', label: 'World moderation', description: 'Game, settlements and moderation management.' },
];
const isClassicSite = site => site.builtin === true || site.cmsCompatible === false;
const managementHref = site => site.managementLinks?.[0]?.href
  || (site.builtin ? hrefFor(['site-pages', site.hostname]) : hrefFor(['set', site.key, 'overview']));

function renderSidebar(active) {
  const lib = [...(state.integratedSites || []), ...state.library].filter((m, i, all) => m.status === 'ready'
    && all.findIndex(other => siteSelectionUrl(other) === siteSelectionUrl(m)) === i);
  const ov = state.key ? state.overview[state.key] : null;
  $('#set-switch').innerHTML = (lib.length || managesSites()) && (!isLocal() || managesSites())
    ? `<select id="set-select" aria-label="Choose a site"><option value="">— choose a site —</option>${lib.map((m) => `<option value="${esc(siteSelectionUrl(m))}" ${m.builtin ? location.hash === managementHref(m) || location.hash.startsWith(managementHref(m) + '?') ? 'selected' : '' : m.key === state.key ? 'selected' : ''}>${esc(m.hostname + (m.path || '') || m.name)}</option>`).join('')}</select>
       ${ov ? `<div class="site-mini ellipsis" title="${esc(ov.siteUrl || ov.options?.home || '')}">${esc(ov.siteUrl || ov.options?.home || '')}</div>` : ''}`
    : '';
  const sel = $('#set-select');
  if (sel) sel.addEventListener('change', () => {
    const selected = lib.find(site => siteSelectionUrl(site) === sel.value);
    if (selected) location.hash = managementHref(selected);
  });

  const nav = managesSites() ? [['home', '⌂', 'All sites', '#/'], ['operations', '⚙', 'Service operations', '#/operations'],
    ['deployment', DEPLOY_ICON, 'Deployment', hrefFor(['deployment'])]] : isLocal() ? [] : [['home', '⌂', 'Sites & sync', '#/']];
  if (managesSites()) nav.push(['notes', '↔', 'Notes · rewards & markets', '#/notes']);
  if (managesSites()) nav.push(['server-profile', '⚙', 'Server profile', '#/server-profile']);
  if (managesSites()) nav.push(['database', '▤', 'Database journals', '#/database']);
  nav.push(['intranet', '◎', 'App · insiders & missions', '#/intranet']);
  nav.push(['silver', '◇', 'Silver · products & codes', '#/silver']);
  if (ov) {
    const contentCount = (ov.contentTypes || []).filter((t) => !HIDDEN_TYPES.includes(t.type) && !['auto-draft', 'inherit'].includes(t.status)).reduce((a, t) => a + t.n, 0) - (ov.trashed || 0);
    nav.push(['sep', '', 'Explore']);
    nav.push(['overview', '📊', 'Overview']);
    if (ov.hasDb) nav.push(['content', '📝', 'Content', null, contentCount]);
    nav.push(['media', '🖼', 'Media library', null, ov.counts?.attachments ?? ov.stats?.uploads?.originals]);
    if (ov.hasDb) {
      nav.push(['taxonomies', '🏷', 'Categories & tags', null, (ov.taxonomies || []).reduce((a, t) => a + t.n, 0)]);
      nav.push(['menus', '☰', 'Menus']);
      nav.push(['comments', '💬', 'Comments', null, ov.counts?.comments]);
      nav.push(['users', '👤', 'Users', null, ov.counts?.users]);
    }
    nav.push(['sep', '', 'Analyze & reuse']);
    const publicHref = ov.hostname ? publicPreview() : '/';
    nav.push(['public', '🌐', 'Public site', publicHref]);
    if (ov.hasDb) nav.push(['trash', '🗑', 'Trash', null, ov.trashed]);
    if (ov.hasDb) nav.push(['analytics', '👥', 'Visitor analytics']);
    if (ov.hasDb) nav.push(['insights', '📈', 'Insights']);
    if (ov.hasDb) {
      nav.push(['sep', '', 'Manage site']);
      nav.push(['cms-content', '✍', 'CMS content']);
      if (ov.hostname === 'notes.featheral.com') nav.push(['note-markets', '↔', 'Note markets & funding']);
      nav.push(['appearance', '🎨', 'Public themes']);
      nav.push(['site-settings', '⚙', 'Site features']);
      nav.push(['shop', '🛍', 'Shop catalog & orders']);
    }
    nav.push(['export', '⬇', 'Export data']);
    nav.push(['sep', '', 'Site internals']);
    nav.push(['addons', '🧩', 'Plugins & themes', null, (ov.addons?.plugins || 0) + (ov.addons?.themes || 0)]);
    if (ov.hasDb) nav.push(['database', '🗄', 'Database tables', null, ov.counts?.tables]);
  }
  $('#nav').innerHTML = nav.map(([id, ic, label, href, count]) => {
    if (id === 'sep') return `<div class="sep">${label}</div>`;
    const isOn = id === active || (id === 'home' && active === 'import');
    return `<a href="${href || setHref(id)}" class="${isOn ? 'active' : ''}"><span class="ic">${ic}</span>${esc(label)}${count ? `<span class="count">${fmtNum(count)}</span>` : ''}</a>`;
  }).join('');
}

$('#menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#nav').addEventListener('click', () => document.body.classList.remove('nav-open'));

// ---------- router ----------
const VIEWS = {};

async function render() {
  if (location.hash === activeHash && leaveView?.cancelled) { leaveView.cancelled = false; return; }
  if (leaveView && !leaveView()) {
    leaveView.cancelled = true;
    location.replace(activeHash || '#/');
    return;
  }
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  leaveView = null;
  activeHash = location.hash;
  const token = ++state.seq;
  const { parts, q } = parseHash();
  closeModal();
  try {
    if (isLocal() && !managesSites() && (!parts.length || parts[0] === 'import' || (parts[0] === 'set' && parts[1] !== homeKey()))) {
      const key = homeKey();
      if (!key) { state.key = null; renderSidebar(''); return setView(`<div class="card">${emptyBox('🗄', 'No stored data found in the data folder.')}</div>`, token); }
      location.replace(hrefFor(['set', key, ...(parts[0] === 'set' ? parts.slice(2) : ['overview'])], q));
      return;
    }
    if (!parts.length) { state.key = null; renderSidebar('home'); return await (managesSites() ? VIEWS.sites(q, token) : VIEWS.home(q, token)); }
    if (parts[0] === 'overview' && managesSites()) { state.key = null; return await VIEWS.traffic(q, token); }
    if (parts[0] === 'operations') { state.key = null; return await VIEWS.operations(parts[1], q, token); }
    if (parts[0] === 'intranet') { state.key = null; return await VIEWS.intranet(q, token); }
    if (parts[0] === 'silver') { state.key = null; return await VIEWS.silver(q, token); }
    if (parts[0] === 'notes') { state.key = null; return await VIEWS.notes(q, token); }
    if (parts[0] === 'server-profile' || parts[0] === 'server-users') { state.key = null; return await VIEWS['server-profile'](q, token); }
    if (parts[0] === 'database' && managesSites()) { state.key = null; return await VIEWS.database(q, token); }
    if (parts[0] === 'deployment' && managesSites()) { state.key = null; return await VIEWS.deployment(q, token); }
    if (parts[0] === 'site-pages' && parts[1]) { state.key = null; renderSidebar('home'); return await VIEWS['site-pages'](parts[1], q, token); }
    if (parts[0] === 'import') {
      if (isLocal()) throw new Error('WordPress syncing is disabled');
      renderSidebar('import'); return await VIEWS.import(q, token);
    }
    if (parts[0] === 'set' && parts[1]) {
      state.key = parts[1];
      if (!state.library.length) await loadLibrary();
      await ensureOverview(state.key);
      const view = parts[2] || 'overview';
      renderSidebar(view);
      if (!VIEWS[view]) return setView(errorBox('Unknown view'));
      if (!$('#view').dataset.view || $('#view').dataset.view !== view) { setView(loading(), token); $('#view').scrollTop = 0; }
      $('#view').dataset.view = view;
      return await VIEWS[view](parts[3], q, token);
    }
    location.hash = '#/';
  } catch (e) {
    if (e === STALE) return;
    console.error(e);
    if (token === state.seq) setView(errorBox(e) + (isLocal() ? '' : `<p><a href="#/">← Back to sites</a></p>`), token);
  }
}

function siteCrumb(...rest) {
  const ov = state.overview[state.key];
  const name = ov?.managed ? ov.site : isLocal() ? state.config.brand : ov?.options?.blogname || ov?.site || state.key;
  const when = isLocal() ? `data as of ${fmtDate(ov?.syncedAt)}` : `synced ${fmtDate(ov?.syncedAt)}`;
  return `<a href="${setHref('overview')}"><b>${esc(name)}</b></a> <span class="muted">· ${esc(when)}</span>${rest.map((r) => ` <span class="muted">›</span> ${r}`).join('')}`;
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  try { await Promise.all([loadConfig(), loadLibrary()]); await render(); }
  catch (error) { console.error(error); setView(errorBox(error)); }
});
