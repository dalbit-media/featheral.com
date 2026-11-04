/* Public site: swipe a shuffled mix of GIF and image posts, read texts, review likes. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtBytes = (b) => {
  if (!b) return 'size unknown';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (d) => (d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const TYPE_LABEL = { gif: 'GIF', jpeg: 'JPG', png: 'PNG' };
const previewSite = new URLSearchParams(location.search).get('site');
const hostedSite = document.querySelector('meta[name=site-key]')?.content;
const siteBase = document.querySelector('meta[name=site-base]')?.content || '';
if (location.hostname === 'x.featheral.com' || location.hostname === 'x.localhost')
  document.body.dataset.standalone = 'x';
const storageKey = (key) => previewSite || hostedSite ? `site:${previewSite || hostedSite}:${key}` : key;
function publicUrl(url) {
  if (!previewSite) return url.startsWith('/api/') ? siteBase + url : url;
  const target = new URL(url, location.origin);
  target.searchParams.set('site', previewSite);
  return target.pathname + target.search;
}

async function api(url, opts = {}) {
  if (opts.json) { opts = { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.json) }; }
  if (wallet.token) opts.headers = { ...opts.headers, 'X-Wallet-Token': wallet.token };
  opts.headers = { ...opts.headers, 'X-Visitor': visitorId };
  const r = await fetch(publicUrl(url), opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && wallet.token && /wallet/i.test(data.error || '')) setWallet(null);
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ---------- Ethereum wallet sign-in ----------
// The wallet signs a one-time message (no transaction, no gas); the server checks the signature and
// returns a session token used to post comments.
let wallet = (() => { try { return JSON.parse(localStorage.getItem(storageKey('wallet'))) || {}; } catch { return {}; } })();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
function setWallet(w) {
  wallet = w || {};
  try { if (w) localStorage.setItem(storageKey('wallet'), JSON.stringify(w)); else localStorage.removeItem(storageKey('wallet')); } catch { /* storage disabled */ }
  paintWallet();
  document.dispatchEvent(new CustomEvent('wallet'));
}
function paintWallet() {
  const b = $('#wallet');
  if (!b) return;
  if (window.FeatheralWallet) { window.FeatheralWallet.apply(); return; }
  b.classList.toggle('on', !!wallet.address);
  b.classList.add('central-wallet-button');
  b.textContent = 'Wallet';
  b.title = wallet.address ? `Wallet · ${wallet.address} · FTHX balance and activity` : 'Open FTHX wallet';
  b.setAttribute('aria-label', 'Open FTHX wallet');
}
function setBalance(n) {
  if (!wallet.address || n == null) return;
  wallet.balance = n;
  store.set('wallet', wallet);
  paintWallet();
  document.dispatchEvent(new CustomEvent('balance'));
}
async function refreshBalance() {
  if (!wallet.token) return null;
  try { const r = await api('/api/public/wallet/me'); setBalance(r.balance); return r.balance; } catch { return null; }
}
async function connectWallet() {
  try {
    if (!window.FeatheralWallet) throw new Error('Central wallet is loading or unavailable. Reload and retry.');
    const authorization = await window.FeatheralWallet.authenticate(address => api('/api/public/wallet/nonce', { json: { address } }));
    const r = await api('/api/public/wallet/login', { json: authorization });
    setWallet({ address: r.address, token: r.token });
    toast(`Connected ${short(r.address)}`);
    refreshBalance();
    return true;
  } catch (e) {
    toast(e?.code === 4001 ? 'Wallet request was rejected' : (e?.message || 'Wallet connection failed'));
    return false;
  }
}
async function disconnectWallet() {
  try { await api('/api/public/wallet/logout', { json: {} }); } catch { /* already gone */ }
  setWallet(null);
  toast('Wallet disconnected');
}

// ---------- Shared FTHX wallet ----------
async function openWalletPanel() {
  if (window.FeatheralWallet) {
    window.FeatheralWallet.open({ primary: 'FTHX', address: wallet.address, compact: true });
    const dialog = document.getElementById('featheral-central-wallet');
    dialog.querySelector('[data-social-signout]')?.remove();
    if (wallet.address) {
      const signout = document.createElement('button');
      signout.type = 'button'; signout.className = 'btn'; signout.dataset.socialSignout = 'true';
      signout.textContent = 'Sign out of this site';
      signout.style.cssText = 'min-height:32px;padding:4px 8px;font-size:12px;margin-top:4px;background:transparent;color:inherit;border:1px solid var(--line,#262633);border-radius:5px';
      signout.addEventListener('click', () => { dialog.close(); disconnectWallet(); });
      dialog.append(signout);
      dialog.querySelector('[data-wallet-root]').style.height = 'calc(100% - 64px)';
    }
    return;
  }
  toast('Wallet is still loading or unavailable. Retry the Wallet button in a moment.');
}

// After a like: the server reports any community-note reward.
function rewardNote(r) {
  const w = r?.reward;
  if (!w) return;
  if (w.balance != null) setBalance(w.balance);
  if (w.paid) toast(`♥ +${fmtNum(w.paid)} ${w.symbol || 'FTHX'} awarded to ${short(w.to)}`);
  else if (w.reason === 'system-native') toast('Liked · FTH$ and FTHX are not regular rewards');
  else if (w.reason === 'guest' && !sessionStorage.getItem('guest-like-hint')) {
    sessionStorage.setItem('guest-like-hint', '1');
    toast('Liked · connect a wallet for eligible community-note rewards', { label: 'Connect', run: connectWallet });
  }
}

// `action` ({ label, run }) adds a button, e.g. Undo, and keeps the toast up longer.
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.run(); }, { once: true });
    t.append(' ', b);
  }
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), action ? 5000 : 1600);
}

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(storageKey(key))) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch { /* storage full or disabled */ } },
};

// Views: each post shown to this browser is counted once per page load; the server also ignores the
// same visitor re-viewing a post within 30 minutes. `done(v)` runs with the new v.views.
const visitorId = store.get('visitor', null) || (() => { const id = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('visitor', id); return id; })();
const viewedHere = new Set();
function countView(v, done) {
  if (!v?.id || viewedHere.has(v.id)) return;
  viewedHere.add(v.id);
  api(`/api/public/posts/${v.id}/view`, { json: { visitor: visitorId } })
    .then((r) => { v.views = r.views; tileStats(v); done?.(v); })
    .catch(() => viewedHere.delete(v.id));
}
// Traffic analytics: one hit per page shown. The first hit of a page load also carries where the visitor
// came from (referrer, unless it is this site) and any utm_source / utm_medium / utm_campaign tags.
let firstHit = true;
function trackHit() {
  const body = { visitor: visitorId, path: location.hash || '#/', lang: navigator.language || '' };
  if (firstHit) {
    firstHit = false;
    try { const r = new URL(document.referrer); if (r.host !== location.host) body.referrer = document.referrer; } catch { /* no referrer */ }
    const u = new URLSearchParams(location.search);
    body.utm = { source: u.get('utm_source') || u.get('ref') || '', medium: u.get('utm_medium') || '', campaign: u.get('utm_campaign') || '' };
  }
  fetch(publicUrl('/api/public/hit'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

// The 👁 views · 💬 comments badge on gallery tiles.
const statsHtml = (v) => `👁 ${fmtNum(v.views || 0)}&ensp;💬 ${fmtNum(v.comments || 0)}`;
// YouTube posts keep the video's thumbnail as their image and play the video itself when opened.
const ytWatch = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
function ytFrame(id, cls, autoplay = true) {
  const f = document.createElement('iframe');
  f.className = cls;
  f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0&modestbranding=1${autoplay ? '&autoplay=1' : ''}`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.title = 'YouTube video';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  return f;
}
const ytBadge = (v) => (v.video ? '<i class="ytbadge" title="YouTube video"></i>' : '');
const statsBadge = (v) => `<i class="tc${v.comments || v.views ? '' : ' zero'}" title="Views · comments">${statsHtml(v)}</i>`;
function tileStats(v) {
  const b = v.el && $('.tc', v.el);
  if (!b) return;
  b.classList.toggle('zero', !v.comments && !v.views);
  b.innerHTML = statsHtml(v);
}
// Reviews are stored on the server. Votes kept by older versions of this page are sent there once.
async function importLegacyVotes() {
  const legacy = store.get('votes', null);
  if (!legacy || typeof legacy !== 'object') return;
  const list = Object.entries(legacy).map(([id, v]) => ({ id: +id, vote: v?.vote, type: v?.type }));
  try {
    const r = await api('/api/public/import', { json: { votes: list } });
    localStorage.removeItem(storageKey('votes'));
    Object.keys(localStorage).filter((k) => k.startsWith(storageKey('pos:'))).forEach((k) => localStorage.removeItem(k));
    if (r.liked || r.deleted) toast(`Applied earlier votes: ${fmtNum(r.liked)} liked, ${fmtNum(r.deleted)} deleted`);
  } catch (e) { toast(e.message); }
}

function parseHash() {
  const [p, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const href = (parts, q = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString();
  return '#/' + parts.map(encodeURIComponent).join('/') + (qs ? '?' + qs : '');
};

let info = null;
let cleanup = null;
const view = () => $('#view');

function setTab(tab) {
  document.querySelectorAll('.tabs a').forEach((a) => {
    const active = a.dataset.tab === tab;
    a.classList.toggle('on', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  const { parts, q } = parseHash();
  trackHit();
  window.scrollTo(0, 0);
  $('#fab')?.classList.toggle('here', parts[0] === 'post');
  try {
    if (parts[0] === 'shop') { setTab('shop'); return await shopDemo(); }
    if (parts[0] === 'exchange') { setTab('exchange'); return await exchangeDemo(); }
    if (!parts.length || !parts[0]) {
      const home = info.siteSettings?.homepage;
      if (home === 'exchange') { setTab('exchange'); return await exchangeDemo(); }
      if (home === 'shop') { setTab('shop'); return await shopDemo(); }
      if (home === 'content') {
        setTab('home'); await templateHome();
        if (document.querySelector('meta[name=site-directory]')?.content === 'true') {
          const directory = await api('/api/public/sites');
          const section = document.createElement('section');
          section.className = 'website-directory';
          section.innerHTML = '<h2>Browse websites</h2>';
          const search = document.createElement('input');
          search.type = 'search'; search.placeholder = 'Search websites or note symbols'; search.setAttribute('aria-label', 'Search websites');
          const results = document.createElement('div');
          results.className = 'creation-grid';
          section.append(search, results);
          const renderDirectory = () => {
            const query = search.value.trim().toLowerCase();
            const sites = directory.sites.filter(site => `${site.name} ${site.description} ${site.noteSymbol || ''}`.toLowerCase().includes(query));
            results.innerHTML = sites.length ? sites.map(site => {
            const local = location.hostname.endsWith('.localhost') || ['localhost', '127.0.0.1'].includes(location.hostname);
            const url = `${location.protocol}//${local ? 'sites.localhost' : 'sites.featheral.com'}${location.port ? ':' + location.port : ''}${site.path}`;
            return `<article class="note-trending"><h3><a href="${esc(url)}">${esc(site.name)}</a></h3><p>${esc(site.description)}</p>${site.noteSymbol ? `<p>Note: ${esc(site.noteSymbol)}</p>` : ''}<a href="${esc(url)}">Visit website &rarr;</a></article>`;
            }).join('') : '<p>No matching websites.</p>';
          };
          search.addEventListener('input', renderDirectory); renderDirectory();
          section.addEventListener('featheral:sites-changed', async () => {
            try { directory.sites = (await api('/api/public/sites')).sites; renderDirectory(); }
            catch (error) { console.error(error); toast(error.message); }
          });
          $('#view').append(section);
        }
        if (info.siteSettings.stats) {
          const currencies = document.createElement('section');
          currencies.className = 'website-directory';
          currencies.innerHTML = '<h2>Native currencies</h2>';
          $('#view').prepend(currencies);
          try {
            const summary = await api('/api/creation/trending');
            for (const asset of summary.notes.filter(note => note.native)) {
              const row = document.createElement('p');
              const supply = asset.circulating == null ? 'unavailable' : (BigInt(asset.circulating) / 10n ** BigInt(asset.decimals)).toLocaleString();
              row.textContent = `${asset.name}${asset.alias ? ' / ' + asset.alias : ''} · ${asset.symbol} · ${supply} circulating`;
              currencies.append(row);
            }
          } catch (error) {
            console.error('Currency statistics:', error);
            const unavailable = document.createElement('p');
            unavailable.textContent = `Currency statistics unavailable: ${error.message}`; currencies.append(unavailable);
          }
          const charts = document.createElement('div');
          $('#view').prepend(charts);
          await window.FeatheralTraffic.load(charts, publicUrl('/api/telemetry/public'), undefined, document.querySelector('#traffic-interval'));
        }
        return;
      }
    }
    if (parts[0] === 'read' && parts[1]) { setTab('read'); return readerView(parts[1], q); }
    if (parts[0] === 'page' && parts[1]) {
      setTab(['fthx', 'fthx-whitepaper'].includes(parts[1]) ? parts[1] : 'read');
      return await readerView(parts[1], q, true);
    }
    if (parts[0] === 'read') { setTab('read'); return readListView(q); }
    if (parts[0] === 'liked') { setTab('liked'); return await likedView(q); }
    if (parts[0] === 'thumbs') { setTab('thumbs'); return thumbsView(q); }
    if (parts[0] === 'trending') { setTab('trending'); return trendingView(q); }
    if (parts[0] === 'post') { setTab('post'); return postView(); }
    setTab('swipe');
    return swipeView('mix');
  } catch (e) {
    view().innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message)}</div>`;
  }
}

// ---------- swipe deck ----------
// One deck of every GIF and image post, shuffled. Each vote is stored under the post's own media type.
function mediaPreloadPolicy(connection = navigator.connection) {
  const constrained = connection?.saveData || /^(slow-)?2g$/.test(connection?.effectiveType || '');
  return constrained
    ? { maxCards: 1, bytes: 0, parallel: 1, history: 1 }
    : { maxCards: 3, bytes: 12 * 1024 * 1024, parallel: 2, history: 1 };
}
function swipeView(type) {
  const t = info.mix || {};
  const state = { queue: [], loading: null, history: [], more: true, after: null, round: t.round || 1, total: t.total || 0, remaining: t.remaining || 0, busy: false };
  view().innerHTML = `<section class="swipe">
    <div class="bar">
      <span class="chip" title="GIFs and images, shuffled">🔀 Mixed</span>
      <span id="progress"></span>
    </div>
    <div class="stack" id="stack"></div>
    <div class="actions">
      <button class="undo" id="b-undo" title="Undo (Backspace)" disabled>↺</button>
      <button class="nope" id="b-nope" title="Dislike and delete (←)">✕</button>
      <button class="like" id="b-like" title="Like and keep (→)">♥</button>
    </div>
    <div class="hint">Right = like &amp; keep · Left = dislike &amp; delete · ← → keys · Backspace undoes</div>
  </section>`;
  const stack = $('#stack');
  $('#b-like').addEventListener('click', () => decide('like'));
  $('#b-nope').addEventListener('click', () => decide('dislike'));
  $('#b-undo').addEventListener('click', undo);
  const onKey = (e) => {
    if (e.target.closest('input, select, textarea') || $('.viewer')) return;
    if (e.key === 'ArrowRight') decide('like');
    else if (e.key === 'ArrowLeft') decide('dislike');
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); openComments(); }
  };
  let disposed = false;
  document.addEventListener('keydown', onKey);
  cleanup = () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    for (const m of media.values()) if (!m.done) m.img.removeAttribute('src');
    media.clear();
  };

  // Large GIFs must not crowd out the visible card or consume unbounded bandwidth.
  const PRELOAD = mediaPreloadPolicy();
  const media = new Map();
  function preload() {
    if (disposed) return;
    const keep = new Set(state.history.slice(-PRELOAD.history).filter(h => media.get(h.item.id)?.done).map(h => h.item.id));
    for (const item of state.queue.slice(0, 2)) keep.add(item.id);
    const wanted = [];
    let bytes = 0;
    for (let i = 0; i < state.queue.length && i < PRELOAD.maxCards; i++) {
      const item = state.queue[i];
      const size = item.media.size || 1024 * 1024;
      if (i > 0 && bytes + size > PRELOAD.bytes) break;
      bytes += size;
      wanted.push(item);
      keep.add(item.id);
    }
    for (const [id, m] of media) {
      if (!keep.has(id)) { if (!m.done) m.img.removeAttribute('src'); media.delete(id); }
    }
    let active = [...media.values()].filter((m) => m.started && !m.done).length;
    for (const item of wanted) {
      if (item !== state.queue[0] && !media.get(state.queue[0].id)?.done) break;
      let m = media.get(item.id);
      if (m) {
        m.img.fetchPriority = item === state.queue[0] ? 'high' : 'low';
        if (m.started) continue;
      }
      if (active >= PRELOAD.parallel) break;
      if (!m) { m = mediaFor(item); }
      m.started = true;
      active++;
      m.img.fetchPriority = item === state.queue[0] ? 'high' : 'low';
      m.img.src = item.media.url;
    }
  }
  function mediaFor(item) {
    let m = media.get(item.id);
    if (m) return m;
    const img = new Image();
    img.className = 'media'; img.alt = ''; img.draggable = false; img.decoding = 'async';
    m = { img, animated: item.media.type === 'gif', started: false, done: false, ok: false, still: null, blur: null, ready: null };
    const settle = (ok) => { m.done = true; m.ok = ok; preload(); };
    // Decode the first frame, then build the still frame and blurred backdrop while the browser is
    // idle, so promoting a card during a swipe is only a class change.
    m.ready = new Promise((resolve) => {
      img.addEventListener('load', () => {
        img.decode().catch(() => {}).finally(() => {
          settle(true);
          idle(() => prepare(m).finally(() => resolve(m)));
        });
      });
      img.addEventListener('error', () => { settle(false); resolve(m); });
    });
    media.set(item.id, m);
    return m;
  }
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 30));
  // createImageBitmap scales off the main thread; reading a canvas back (toDataURL) would decode
  // the whole GIF synchronously and freeze swiping for a second or more.
  async function prepare(m) {
    const { naturalWidth: w, naturalHeight: h } = m.img;
    if (m.blur || !w || !h) return;
    const bitmap = async (max, cls) => {
      const k = Math.min(1, max / Math.max(w, h));
      const bmp = await createImageBitmap(m.img, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'medium' });
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height; c.className = cls;
      c.getContext('bitmaprenderer').transferFromImageBitmap(bmp);
      return c;
    };
    try {
      m.blur = await bitmap(48, 'backdrop');
      if (m.animated) m.still = await bitmap(720, 'media still');
    } catch { /* the card still works without a backdrop or still frame */ }
  }

  // Fetches the next posts not yet reviewed in this round, after the last one already queued.
  async function load() {
    if (state.loading || !state.more) return state.loading;
    const params = { type, limit: 20, ...(state.after ? { after: state.after } : {}) };
    state.loading = api(`/api/public/feed?${new URLSearchParams(params)}`)
      .then((r) => {
        if (disposed) return;
        const queued = new Set(state.queue.map((x) => x.id));
        r.items.forEach((item) => { if (!queued.has(item.id)) state.queue.push(item); });
        if (r.items.length) state.after = r.items[r.items.length - 1].id;
        Object.assign(state, { more: r.more, round: r.round, total: r.total, remaining: r.remaining - pendingDelta });
        preload();
      })
      .catch((e) => toast(e.message))
      .finally(() => { state.loading = null; });
    return state.loading;
  }

  // Votes are sent one at a time so an undo always reaches the server after the vote it reverts.
  let chain = Promise.resolve();
  let pendingDelta = 0;
  function send(item, vote) {
    const delta = vote === 'none' ? -1 : 1;
    pendingDelta += delta;
    chain = chain.then(() => api('/api/public/vote', { json: { id: item.id, type: item.media.type, vote } }))
      .then((r) => { if (r?.reward && vote === 'like') { rewardNote(r); if (r.reward.paid && (!r.reward.symbol || r.reward.symbol === 'FTHX')) item.earned = (item.earned || 0) + r.reward.paid; } })
      .catch((e) => toast(e.message))
      .finally(() => { pendingDelta -= delta; });
    return chain;
  }

  function progress() {
    $('#progress').textContent = state.total ? `Round ${fmtNum(state.queue[0]?.round ?? state.round)} · ${fmtNum(Math.max(0, state.remaining))} left` : '';
    $('#b-undo').disabled = state.busy || !state.history.length;
    $('#b-like').disabled = $('#b-nope').disabled = state.busy || !state.queue.length;
    const deletes = state.queue[0]?.deletes ?? true;
    $('#b-nope').title = deletes ? 'Dislike and delete (←)' : 'Dislike (←)';
    $('.swipe .hint').innerHTML = `Right = like &amp; keep · Left = ${deletes ? 'dislike &amp; delete (round 1)' : 'dislike, kept and counted (round 2+)'} · ← → keys · C comments · Backspace undoes`;
  }

  function cardEl(item) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = item.id;
    const dims = item.media.width && item.media.height ? `${item.media.width}×${item.media.height}` : '';
    const label = TYPE_LABEL[item.media.type] || '';
    el.innerHTML = `<div class="blur"></div><div class="spin">Loading ${esc(label)}…</div>
      <div class="stamp like">KEEP</div><div class="stamp nope">${item.deletes ? 'DELETE' : 'NOPE'}</div>
      <button class="cbtn" type="button" title="Comments (C)">💬<b>${fmtNum(item.comments || 0)}</b></button>
      ${item.video ? '<button class="ytplay" type="button" title="Play the YouTube video" aria-label="Play video"></button>' : ''}
      <div class="overlay">
        <h2>${esc(item.title)}</h2>
        ${item.description ? `<p class="desc">${esc(item.description)}</p><button class="more" type="button">more</button>` : ''}
        <div class="meta"><span>${esc(label)} · ${esc(fmtBytes(item.media.size))}</span>${dims ? `<span>${dims}</span>` : ''}
          <span class="lk ${item.likes ? 'voted-like' : ''}" title="Likes from all rounds">♥ ${fmtNum(item.likes || 0)} ${item.likes === 1 ? 'like' : 'likes'}</span><span class="vw" title="Views">👁 ${fmtNum(item.views || 0)}</span>${item.date ? `<span>${esc(fmtDate(item.date))}</span>` : ''}
          ${item.author ? `<span class="by" title="Posted by ${esc(item.author)} · ${fmtNum(item.earned)} FTHX earned">🦊 ${esc(short(item.author))} · 🪙 ${fmtNum(item.earned)}</span>` : ''}</div>
        ${item.tags?.length ? `<div class="ctags">${item.tags.map((t) => `<a href="${href(['trending'], { tag: t.id })}" title="Trending posts tagged ${esc(t.name)}">#${esc(t.name)}</a>`).join('')}</div>` : ''}
      </div>`;
    const m = mediaFor(item);
    $('.spin', el).after(m.img);
    const finish = () => {
      if (!el.isConnected) return;
      if (!m.ok) { const s = $('.spin', el); if (s) s.textContent = 'Media unavailable'; return; }
      if (m.blur) $('.blur', el).replaceChildren(m.blur);
      if (m.still) m.img.after(m.still);
      setLive(el, el.classList.contains('top') && !el.classList.contains('gone'));
    };
    const shown = () => { $('.spin', el)?.remove(); };
    if (m.done && m.ok) shown();
    else m.img.addEventListener('load', shown, { once: true });
    m.ready.then(finish);
    const more = $('.more', el);
    const cbtn = $('.cbtn', el);
    cbtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    cbtn.addEventListener('click', () => { if (el.classList.contains('top')) openComments(); });
    const by = $('.by', el);
    by?.addEventListener('pointerdown', (e) => e.stopPropagation());
    by?.addEventListener('click', () => { if (el.classList.contains('top')) openComments(); });
    for (const a of el.querySelectorAll('.ctags a')) a.addEventListener('pointerdown', (e) => e.stopPropagation());
    const play = $('.ytplay', el);
    play?.addEventListener('pointerdown', (e) => e.stopPropagation());
    play?.addEventListener('click', () => {
      if (!el.classList.contains('top')) return;
      play.replaceWith(ytFrame(item.video, 'ytframe'));
    });
    if (more) {
      more.addEventListener('pointerdown', (e) => e.stopPropagation());
      more.addEventListener('click', () => { el.classList.toggle('expanded'); more.textContent = el.classList.contains('expanded') ? 'less' : 'more'; });
      requestAnimationFrame(() => { const d = $('.desc', el); if (d && d.scrollHeight <= d.clientHeight + 2) more.hidden = true; });
    }
    $('.desc', el)?.addEventListener('pointerdown', (e) => { if (el.classList.contains('expanded')) e.stopPropagation(); });
    bindDrag(el);
    return el;
  }

  // Counts a view once a card is on top (it is what the user is looking at).
  function seen(item, el) {
    countView(item, (x) => { const s = $('.vw', el); if (s) s.textContent = `👁 ${fmtNum(x.views)}`; });
  }

  // Opens the top card in the full viewer with its comments; the card's GIF pauses meanwhile.
  function openComments() {
    const item = state.queue[0];
    const el = item && stack.querySelector(`.card.top[data-id="${item.id}"]`);
    if (!el || state.busy || $('.viewer')) return;
    setLive(el, false);
    openViewer([item], 0, {
      focus: !!wallet.address,
      onCount: (v) => { const b = $('.cbtn b', el); if (b) b.textContent = fmtNum(v.comments || 0); },
      onEarned: (v) => { const b = $('.by', el); if (b) b.textContent = `🦊 ${short(v.author)} · 🪙 ${fmtNum(v.earned)}`; },
      onClose: () => { if (el.isConnected && el.classList.contains('top')) setLive(el, true); },
    });
  }

  // Only the top card animates. Other cards show a pre-rendered still frame over a hidden GIF;
  // the GIF stays in the DOM so promoting the card never has to fetch or decode it again.
  function setLive(el, live) {
    el.classList.toggle('frozen', !live && !!$('.media.still', el));
  }

  function bindDrag(el) {
    let start = null;
    const stamps = () => [$('.stamp.like', el), $('.stamp.nope', el)];
    el.addEventListener('pointerdown', (e) => {
      if (!el.classList.contains('top') || state.busy || e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now() };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      el.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 18}deg)`;
      const [like, nope] = stamps();
      like.style.opacity = Math.max(0, Math.min(1, dx / 110));
      nope.style.opacity = Math.max(0, Math.min(1, -dx / 110));
    });
    const end = (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - start.t);
      start = null;
      el.classList.remove('dragging');
      if (Math.abs(dx) > Math.min(130, el.clientWidth * 0.28) || (Math.abs(dx) > 40 && speed > 0.6)) decide(dx > 0 ? 'like' : 'dislike');
      else { el.style.transform = ''; stamps().forEach((s) => { s.style.opacity = 0; }); }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function paint() {
    if (disposed) return;
    const wanted = state.queue.slice(0, 2).map((x) => String(x.id));
    [...stack.querySelectorAll('.card')].forEach((c) => { if (!wanted.includes(c.dataset.id) || c.classList.contains('gone')) c.remove(); });
    if (state.queue.length) ending = false;
    if (!ending) $('.done', stack)?.remove();
    state.queue.slice(0, 2).forEach((item, i) => {
      let el = stack.querySelector(`.card[data-id="${item.id}"]`);
      if (!el) { el = cardEl(item); stack.prepend(el); }
      el.classList.toggle('top', i === 0);
      el.classList.toggle('back', i === 1);
      if (i === 0) { stack.append(el); seen(item, el); }
      setLive(el, i === 0);
    });
    if (!state.queue.length && !ending) {
      if (state.loading || state.more) stack.insertAdjacentHTML('beforeend', '<div class="done"><div class="loading">Loading…</div></div>');
      else roundEnd();
    }
    progress();
  }

  // Shown once every post in the round has a vote: offer the next round over the posts that were kept.
  let ending = false;
  async function roundEnd() {
    if (ending) return;
    ending = true;
    stack.insertAdjacentHTML('beforeend', '<div class="done"><div class="loading">Saving…</div></div>');
    try {
      await chain;
      const s = await api(`/api/public/round?type=${type}`);
      Object.assign(state, { round: s.round, total: s.total, remaining: s.remaining });
      if (s.remaining > 0) { state.more = true; state.after = null; ending = false; return ensure(); }
      $('.done', stack)?.remove();
      stack.insertAdjacentHTML('beforeend', `<div class="done"><div class="big">🏁</div><b>Round ${fmtNum(s.round)} complete</b>
        <div>${fmtNum(s.liked)} liked and kept · ${fmtNum(s.disliked)} deleted</div>
        ${s.total ? `<div class="m">${fmtNum(s.total)} posts are left. The next round shuffles them again; from round 2 dislikes are counted but nothing is deleted.</div>
          <div><button class="btn primary" id="next-round">Start round ${fmtNum(s.round + 1)}</button></div>`
          : '<div class="m">No posts are left.</div>'}</div>`);
      $('#next-round')?.addEventListener('click', async () => {
        try { await api('/api/public/round', { json: { type } }); info = { ...info, ...(await api('/api/public/info')) }; render(); } catch (e) { toast(e.message); }
      });
      progress();
    } catch (e) { toast(e.message); ending = false; }
  }

  async function ensure() {
    if (state.queue.length < 12 && state.more) {
      const p = load();
      if (!state.queue.length) { paint(); await p; }
    }
    paint();
    preload();
  }

  function decide(vote) {
    const item = state.queue[0];
    if (!item || state.busy) return;
    state.busy = true;
    const el = stack.querySelector(`.card[data-id="${item.id}"]`);
    send(item, vote);
    state.remaining--;
    state.history.push({ item, vote });
    if (state.history.length > 50) state.history.shift();
    state.queue.shift();
    const finish = () => { state.busy = false; ensure(); };
    if (el) {
      el.classList.remove('dragging');
      el.classList.add('gone');
      setLive(el, false);
      const dir = vote === 'like' ? 1 : -1;
      $(`.stamp.${vote === 'like' ? 'like' : 'nope'}`, el).style.opacity = 1;
      const lk = $('.lk', el);
      if (lk && vote === 'like') { const n = (item.likes || 0) + 1; lk.textContent = `♥ ${fmtNum(n)} ${n === 1 ? 'like' : 'likes'}`; lk.classList.add('voted-like'); }
      el.style.transition = 'transform .3s ease-in, opacity .3s';
      el.style.transform = `translate(${dir * (window.innerWidth + 200)}px, 40px) rotate(${dir * 28}deg)`;
      el.style.opacity = '0.6';
      setTimeout(() => { el.remove(); finish(); }, 280);
      paintNext();
    } else finish();
  }

  // Promote the next card immediately so it is ready while the old one flies away.
  function paintNext() {
    if (disposed) return;
    const item = state.queue[0];
    if (!item) return;
    let el = stack.querySelector(`.card[data-id="${item.id}"]:not(.gone)`);
    if (!el) { el = cardEl(item); stack.prepend(el); }
    el.classList.add('top'); el.classList.remove('back');
    setLive(el, true);
    seen(item, el);
    progress();
    preload();
  }

  function undo() {
    if (disposed || state.busy || !state.history.length) return;
    const last = state.history.pop();
    const { item } = last;
    send(item, 'none');
    state.remaining++;
    state.queue.unshift(item);
    stack.querySelector(`.card[data-id="${item.id}"]`)?.remove();
    paint();
    preload();
  }

  ensure();
}

// ---------- reading ----------
async function readListView(q) {
  const sort = q.sort || 'longest';
  const page = +q.page || 1;
  view().innerHTML = `<section class="read"><h1>📖 Read</h1>
    <div class="tools">
      <input type="search" id="q" placeholder="Search texts…" value="${esc(q.q || '')}">
      <select id="sort">${[['longest', 'Longest first'], ['shortest', 'Shortest first'], ['newest', 'Newest'], ['oldest', 'Oldest']].map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div><div id="list"><div class="loading">Loading…</div></div></section>`;
  const go = (patch) => { location.hash = href(['read'], { q: q.q || '', sort, ...patch, page: patch.page || '' }); };
  $('#sort').addEventListener('change', (e) => go({ sort: e.target.value }));
  let timer;
  $('#q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => go({ q: e.target.value.trim() }), 450); });
  const r = await api(`/api/public/texts?${new URLSearchParams({ q: q.q || '', sort, page, limit: 30 })}`);
  const pages = Math.max(1, Math.ceil(r.total / r.limit));
  $('#list').innerHTML = r.items.length ? `<div class="count">${fmtNum(r.total)} texts · page ${r.page} of ${fmtNum(pages)}</div>
    ${r.items.map((t) => `<a class="entry" href="${href(t.type === 'page' ? ['page', t.slug] : ['read', t.id], { from: location.hash.slice(1) })}"><h3>${esc(t.title)}${t.type === 'page' ? ' <span class="chip">Page</span>' : ''}</h3>
      ${t.snippet && t.snippet !== t.title ? `<p>${esc(t.snippet)}</p>` : ''}
      <div class="m">${fmtNum(t.words)} words · ${Math.max(1, Math.round(t.words / 230))} min read · 👁 ${fmtNum(t.views || 0)}${t.date ? ` · ${esc(fmtDate(t.date))}` : ''}</div></a>`).join('')}
    <div class="center">${r.page > 1 ? `<a class="btn" href="${href(['read'], { q: q.q || '', sort, page: r.page - 1 })}">← Previous</a> ` : ''}${r.page < pages ? `<a class="btn primary" href="${href(['read'], { q: q.q || '', sort, page: r.page + 1 })}">Next page →</a>` : ''}</div>`
    : '<div class="empty"><div class="big">🔎</div>No texts match.</div>';
}

async function readerView(id, q, bySlug = false) {
  view().innerHTML = '<div class="loading">Loading…</div>';
  const t = await api(bySlug
    ? `/api/public/texts/by-slug/${encodeURIComponent(id)}`
    : `/api/public/texts/${encodeURIComponent(id)}`);
  const back = q.from && q.from.startsWith('/read') ? '#' + q.from : '#/read';
  document.title = `${t.title} · ${info.brand}`;
  const projectPage = bySlug && ['fthx', 'fthx-whitepaper'].includes(id);
  const landing = projectPage && id === 'fthx';
  const hasPage = (slug) => info.pages?.some((page) => page.slug === slug);
  const actions = projectPage ? `<div class="project-actions">
    <a class="btn primary" href="#/post">Share media</a><a class="btn" href="#/">Explore Featheral X</a>
    ${hasPage(landing ? 'fthx-whitepaper' : 'fthx') ? `<a class="btn" href="#/page/${landing ? 'fthx-whitepaper' : 'fthx'}">${landing ? 'Read the whitepaper' : 'About FTHX'}</a>` : ''}
  </div>` : '';
  view().innerHTML = `<section class="reader${projectPage ? ' project-page' : ''}${landing ? ' project-landing' : ''}">
    <a class="btn" href="${esc(back)}">← All texts</a>
    ${projectPage ? '<div class="project-kicker">Featheral X · FTHX</div>' : ''}
    <h1>${esc(t.title)}</h1>
    ${actions}
    <div class="m">${t.date ? `${esc(fmtDate(t.date))} · ` : ''}${fmtNum(t.words)} words · ${Math.max(1, Math.round(t.words / 230))} min read · <span id="r-views">👁 ${fmtNum(t.views || 0)} views</span></div>
    <article>${t.paragraphs.map((p, i) => projectPage && i > 0 && p.length <= 100
      ? `<h2>${esc(p)}</h2>` : `<p${landing && i === 0 ? ' class="project-lead"' : ''}>${esc(p)}</p>`).join('') || '<p class="m">This post has no text.</p>'}</article>
    ${actions}
    <div class="nav"><a class="btn" href="${esc(back)}">← Back</a><button class="btn" id="top">↑ Top</button></div>
  </section>`;
  $('#top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  countView(t, (x) => { const e = $('#r-views'); if (e) e.textContent = `👁 ${fmtNum(x.views)} views`; });
  cleanup = () => { document.title = info.brand; };
}

// ---------- liked ----------
function mediaGrid(grid, items, tileFor, { justified = false, maxH = Infinity, minWidth = 150, groupBy = null } = {}) {
  const mounted = new Map();
  const headings = new Map();
  const constrained = navigator.connection?.saveData || /^(slow-)?2g$/.test(navigator.connection?.effectiveType || '');
  const limit = constrained ? 1 : 2;
  let positions = [], groups = [], bottom = [], rowCache = {}, frame = 0, resizeFrame = 0, timer = 0, stopped = false, scrolling = false, paused = false;
  function clearHeadings() { for (const el of headings.values()) el.remove(); headings.clear(); }
  function release(index) {
    const tile = mounted.get(index);
    if (!tile) return;
    const img = tile.el.querySelector('img');
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    tile.el.remove();
    if (tile.item.el === tile.el) tile.item.el = null;
    mounted.delete(index);
  }
  function pump() {
    if (stopped || paused || document.hidden) return;
    const bounds = grid.getBoundingClientRect();
    const visible = [...mounted.values()].filter(tile =>
      tile.position.y + tile.position.h > -bounds.top && tile.position.y < innerHeight - bounds.top);
    visible.sort((a, b) => Math.abs(a.position.y + a.position.h / 2 + bounds.top - innerHeight / 2)
      - Math.abs(b.position.y + b.position.h / 2 + bounds.top - innerHeight / 2));
    const wanted = new Set();
    let bytes = 0, pixels = 0, gifs = 0;
    for (const tile of visible) {
      const m = tile.item.media, size = m.size || 1024 * 1024;
      const area = (m.width || 1024) * (m.height || 1024);
      if (wanted.size && (bytes + size > 24 * 1024 * 1024 || pixels + area > 24 * 1024 * 1024
        || (m.type === 'gif' && gifs >= (constrained ? 1 : 2)))) continue;
      if (wanted.size >= 24) break;
      wanted.add(tile); bytes += size; pixels += area;
      if (m.type === 'gif') gifs++;
    }
    for (const tile of mounted.values()) {
      if (!wanted.has(tile)) {
        const img = tile.el.querySelector('img');
        img.onload = img.onerror = null;
        img.removeAttribute('src');
        tile.state = '';
        tile.el.dataset.mediaState = 'paused';
      }
    }
    if (scrolling) return;
    let active = [...mounted.values()].filter(tile => tile.state === 'loading').length;
    for (const tile of wanted) {
      if (active >= limit) break;
      if (tile.state) continue;
      tile.state = 'loading'; tile.el.dataset.mediaState = 'loading'; active++;
      const img = tile.el.querySelector('img');
      const settle = state => {
        if (stopped || mounted.get(tile.position.index) !== tile || tile.state !== 'loading') return;
        tile.state = state; tile.el.dataset.mediaState = state;
        schedule();
      };
      img.onload = () => settle('ready');
      img.onerror = () => settle('error');
      img.decoding = 'async'; img.fetchPriority = 'low';
      img.src = tile.item.media.url;
    }
  }
  function paint() {
    frame = 0;
    if (stopped || paused || document.hidden) return;
    const bounds = grid.getBoundingClientRect(), top = -bounds.top - 240, end = innerHeight - bounds.top + 240;
    const visibleGroups = groups.filter(group => group.y + 36 >= top && group.y <= end);
    const keys = new Set(visibleGroups.map(group => group.key));
    for (const [key, el] of headings) if (!keys.has(key)) { el.remove(); headings.delete(key); }
    for (const group of visibleGroups) {
      let el = headings.get(group.key);
      if (!el) { el = document.createElement('h2'); el.className = 'timeline-heading'; headings.set(group.key, el); grid.append(el); }
      el.textContent = group.label; el.style.cssText = `top:${group.y}px`;
    }
    let lo = 0, hi = bottom.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (bottom[mid] < top) lo = mid + 1; else hi = mid; }
    const wanted = [];
    for (let i = lo; i < positions.length && positions[i].y < end; i++) wanted.push(positions[i]);
    wanted.sort((a, b) => Math.abs(a.y + a.h / 2 + bounds.top - innerHeight / 2)
      - Math.abs(b.y + b.h / 2 + bounds.top - innerHeight / 2));
    const selected = wanted.slice(0, 80), indexes = new Set(selected.map(p => p.index));
    for (const [index, tile] of mounted) if (!indexes.has(index) || tile.item !== items[index]) release(index);
    selected.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const position of selected) {
      let tile = mounted.get(position.index);
      if (!tile) {
        const item = items[position.index], el = tileFor(item);
        tile = { el, item, position, state: '' };
        mounted.set(position.index, tile);
        el.dataset.i = position.index; el.dataset.mediaState = 'paused';
        grid.append(el);
      }
      tile.position = position;
      tile.el.style.cssText = `left:${position.x}px;top:${position.y}px;width:${position.w}px;height:${position.h}px`;
    }
    pump();
  }
  function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(paint); }
  function onScroll() {
    scrolling = true;
    clearTimeout(timer);
    schedule();
    timer = setTimeout(() => { scrolling = false; schedule(); }, 120);
  }
  function layout(append = false) {
    if (stopped || !grid.clientWidth) return;
    const width = Math.floor(grid.clientWidth);
    if (!append) rowCache = {};
    if (justified) positions = justifyRows(grid, items, width, 6, { maxH, cache: rowCache });
    else {
      const columns = Math.max(1, Math.floor((width + 8) / (minWidth + 8))), w = (width - (columns - 1) * 8) / columns, h = w * 4 / 3;
      positions = []; groups = [];
      let y = 0, column = 0, previous = null;
      items.forEach((item, index) => {
        const group = groupBy?.(item);
        if (group && group.key !== previous) {
          if (column) { y += h + 8; column = 0; }
          groups.push({ ...group, y }); y += 42; previous = group.key;
        }
        positions.push({ index, x: column * (w + 8), y, w, h });
        if (++column === columns) { column = 0; y += h + 8; }
      });
      grid.style.height = `${y + (column ? h + 8 : 0)}px`;
    }
    let max = 0;
    bottom = positions.map(p => (max = Math.max(max, p.y + p.h)));
    schedule();
  }
  function visibility() {
    if (document.hidden) { for (const index of mounted.keys()) release(index); clearHeadings(); }
    else schedule();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  let width = 0;
  const resize = new ResizeObserver(() => {
    if (grid.clientWidth !== width) {
      width = grid.clientWidth;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; layout(); });
    }
  });
  resize.observe(grid);
  return { layout, pause(value) {
    paused = value;
    if (paused) { for (const index of mounted.keys()) release(index); clearHeadings(); }
    else schedule();
  }, close() {
    stopped = true; clearTimeout(timer); cancelAnimationFrame(frame); cancelAnimationFrame(resizeFrame); resize.disconnect();
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', visibility);
    for (const index of mounted.keys()) release(index);
    clearHeadings();
  } };
}

function likedDate(item, grouping = 'day') {
  const date = new Date(item.likedAt);
  if (!Number.isFinite(date.getTime()) || !item.likedAt) return { key: 'unknown', label: 'Earlier likes' };
  const year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
  return { key: grouping === 'month' ? `${year}-${month}` : `${year}-${month}-${day}`,
    label: date.toLocaleDateString(undefined, grouping === 'month'
      ? { year: 'numeric', month: 'long' } : { year: 'numeric', month: 'long', day: 'numeric' }) };
}
async function likedView(q = {}) {
  cleanup?.();
  const sort = q.sort === 'likes' ? 'likes' : 'recent', grouping = q.group === 'month' ? 'month' : q.group === 'none' ? 'none' : 'day';
  const collection = q.collection || '';
  let disposed = false, gallery = null, closeViewer = null, folderDialog = null, pending = null, refreshOnClose = false, more = true, offset = 0;
  let folderNames = new Map();
  const items = [];
  const request = new AbortController();
  const onWallet = () => {
    if (disposed) return;
    if (collection) history.replaceState(null, '', href(['liked'], { sort, group: grouping }));
    render();
  };
  document.addEventListener('wallet', onWallet);
  cleanup = () => { disposed = true; request.abort(); gallery?.close(); closeViewer?.(); folderDialog?.close(); folderDialog?.remove(); document.removeEventListener('wallet', onWallet); };
  view().innerHTML = `<section class="read liked-timeline"><h1>♥ Liked <span class="count" id="liked-count"></span></h1>
    <p class="m">Shared site-wide likes. Newest likes first. Folders are private to your signed-in wallet. Browsing never changes likes.</p>
    <div class="liked-tools">
      <label>Sort <select id="liked-sort"><option value="recent">Recently liked</option><option value="likes">Most liked</option></select></label>
      <label>Group <select id="liked-group"><option value="day">By day</option><option value="month">By month</option><option value="none">No groups</option></select></label>
      <label>Folder <select id="liked-folder"><option value="">All shared likes</option></select></label>
      <button class="btn" id="folder-create">${wallet.token ? 'New folder' : 'Sign in for folders'}</button>
      ${collection && wallet.token ? '<button class="btn" id="folder-rename">Rename folder</button><button class="btn" id="folder-delete">Delete folder</button>' : ''}
    </div><p class="m" id="liked-status" role="status"></p>
    <div class="grid media-grid"></div><button class="btn" id="liked-more">Load more</button></section>`;
  const grid = $('.grid', view());
  const navigate = patch => { location.hash = href(['liked'], { sort, group: grouping, collection, ...patch }); };
  $('#liked-sort').value = sort; $('#liked-group').value = grouping; $('#liked-group').disabled = sort === 'likes';
  $('#liked-sort').onchange = e => navigate({ sort: e.target.value });
  $('#liked-group').onchange = e => navigate({ group: e.target.value });
  $('#liked-folder').onchange = e => navigate({ collection: e.target.value });
  gallery = mediaGrid(grid, items, v => {
    const tile = document.createElement('div');
    tile.className = 'tile'; tile.title = v.title;
    tile.innerHTML = `<button class="liked-open" aria-label="Open ${esc(v.title)} with comments"><img alt="">${ytBadge(v)}
      <span>${esc(v.title)}<br>♥ ${fmtNum(v.likes)} · 💬 ${fmtNum(v.comments)} · ${esc(likedDate(v).label)}</span></button>
      <button class="btn liked-save" data-folders aria-label="Organize ${esc(v.title)} in folders">Folders</button>`;
    return tile;
  }, { minWidth: 320, groupBy: sort === 'recent' && grouping !== 'none' ? v => likedDate(v, grouping) : null });
  function loadMore() {
    if (disposed || !more) return Promise.resolve();
    if (!pending) pending = fetchPage().finally(() => { pending = null; });
    return pending;
  }
  async function fetchPage() {
    $('#liked-more').disabled = true;
    $('#liked-status').textContent = 'Loading likes...';
    try {
      const r = await api(`/api/public/liked?${new URLSearchParams({ sort, offset, limit: 24, ...(collection ? { collection } : {}) })}`, { signal: request.signal });
      if (disposed) return;
      const known = new Set(items.map(item => item.id));
      items.push(...r.items.filter(item => !known.has(item.id)));
      offset = r.offset + r.items.length; more = offset < r.total && r.items.length > 0;
      $('#liked-count').textContent = fmtNum(r.total);
      $('#liked-status').textContent = items.length ? `${fmtNum(items.length)} of ${fmtNum(r.total)} shown` : collection ? 'No currently liked media in this folder.' : 'Nothing liked yet.';
      $('#liked-more').hidden = !more;
      gallery.layout();
    } catch (error) {
      if (!disposed) { $('#liked-status').textContent = error.message; throw error; }
    } finally { if (!disposed) $('#liked-more').disabled = false; }
  }
  async function refreshFolders() {
    if (!wallet.token) return;
    let r;
    try { r = await api('/api/public/collections', { signal: request.signal }); }
    catch (error) { if (disposed) return; throw error; }
    if (disposed) return;
    folderNames = new Map(r.items.map(folder => [folder.id, folder.name]));
    $('#liked-folder').innerHTML = '<option value="">All shared likes</option>' +
      r.items.map(folder => `<option value="${esc(folder.id)}">${esc(folder.name)} (${fmtNum(folder.count)})</option>`).join('');
    $('#liked-folder').value = collection;
  }
  function folderInput(action) {
    folderDialog?.close();
    const dialog = document.createElement('dialog'); folderDialog = dialog; dialog.className = 'collection-dialog';
    const deleting = action === 'delete';
    dialog.setAttribute('aria-label', deleting ? 'Delete folder' : action === 'create' ? 'New folder' : 'Rename folder');
    dialog.innerHTML = `<form><h2>${deleting ? 'Delete folder' : action === 'create' ? 'New folder' : 'Rename folder'}</h2>
      ${deleting ? '<p>Delete this private folder? Media and shared likes will not change.</p>' : `<label>Folder name <input name="name" required maxlength="80" value="${esc(action === 'create' ? '' : folderNames.get(collection) || '')}" autofocus></label>`}
      <div class="row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">${deleting ? 'Delete folder' : 'Save folder'}</button></div></form>`;
    return new Promise(resolve => {
      let value = null;
      $('form', dialog).onsubmit = event => {
        event.preventDefault();
        const name = deleting ? 'delete' : $('input', dialog).value.trim();
        if (!name) { $('input', dialog).setCustomValidity('Enter a folder name'); $('input', dialog).reportValidity(); return; }
        value = name; dialog.close();
      };
      $('input', dialog)?.addEventListener('input', event => event.target.setCustomValidity(''));
      $('[data-cancel]', dialog).onclick = () => dialog.close();
      dialog.addEventListener('close', () => { dialog.remove(); if (folderDialog === dialog) folderDialog = null; resolve(value); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  async function folderAction(action) {
    if (!wallet.token) { await connectWallet(); return; }
    const id = action === 'create' ? '' : collection;
    const name = await folderInput(action);
    if (name === null || disposed) return;
    if (action === 'delete') {
      await api(`/api/public/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!disposed) navigate({ collection: '' });
      return;
    }
    const folder = await api('/api/public/collections' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', json: { name } });
    if (!disposed) { if (action === 'create') navigate({ collection: folder.id }); else await refreshFolders(); }
  }
  for (const action of ['create', 'rename', 'delete']) $('#folder-' + action)?.addEventListener('click', () => folderAction(action).catch(error => toast(error.message)));
  async function organize(v) {
    if (!wallet.token) { await connectWallet(); return; }
    const r = await api(`/api/public/collections?post=${v.id}`, { signal: request.signal });
    if (disposed) return;
    folderDialog?.close();
    const dialog = document.createElement('dialog'); folderDialog = dialog; dialog.className = 'collection-dialog';
    dialog.setAttribute('aria-label', 'Organize in folders');
    dialog.innerHTML = `<form method="dialog"><h2>Organize ${esc(v.title)}</h2><p>Private folders for your wallet. Shared likes stay unchanged.</p>
      ${r.items.length ? r.items.map(folder => `<label><input type="checkbox" value="${esc(folder.id)}" ${folder.saved ? 'checked' : ''}> ${esc(folder.name)}</label>`).join('') : '<p>Create a folder using “New folder” above.</p>'}
      <button class="btn">Done</button></form><p role="status"></p>`;
    dialog.addEventListener('change', async event => {
      const input = event.target;
      if (!input.matches('input[type=checkbox]')) return;
      const saved = input.checked; input.disabled = true;
      try {
        await api(`/api/public/collections/${input.value}/posts/${v.id}`, { method: saved ? 'PUT' : 'DELETE' });
        if (disposed) return;
        $('p[role=status]', dialog).textContent = saved ? 'Saved to folder.' : 'Removed from folder.';
        if (collection === input.value) refreshOnClose = true;
        await refreshFolders();
      } catch (error) { input.checked = !saved; $('p[role=status]', dialog).textContent = error.message; }
      finally { input.disabled = false; }
    });
    dialog.addEventListener('close', () => {
      dialog.remove(); if (folderDialog === dialog) folderDialog = null;
      if (!disposed && !closeViewer && refreshOnClose) render();
    });
    document.body.append(dialog); dialog.showModal();
  }
  grid.addEventListener('click', event => {
    const b = event.target.closest('.tile');
    if (!b) return;
    const v = items[+b.dataset.i];
    if (!v) return;
    if (event.target.closest('[data-folders]')) { organize(v).catch(error => { if (!disposed) toast(error.message); }); return; }
    closeViewer?.(); gallery.pause(true);
    closeViewer = openViewer(items, +b.dataset.i, {
      onClose: () => { closeViewer = null; if (!disposed && refreshOnClose) render(); else gallery.pause(false); }, hasMore: () => more, loadMore,
      organize: v => organize(v).catch(error => { if (!disposed) toast(error.message); }),
    });
  });
  $('#liked-more').onclick = () => loadMore().catch(error => toast(error.message));
  await Promise.all([loadMore(), refreshFolders()]);
}

// ---------- thumbnail gallery ----------
// Justified rows that never enlarge an image: every row fills the page width exactly, and its
// height is at most the smallest original height in it, so each image shows at its own size or
// smaller. Each row starts with the next image in sort order and is completed with the nearby
// images (next LOOK) closest to it in height, so they need little or no shrinking.
// `maxH` caps row height (big photos would otherwise give one huge image per row).
function justifyRows(grid, items, width, GAP = 6, { LOOK = 40, maxH = Infinity, cache } = {}) {
  const nat = (v) => {
    const w = v.media.width || 140; const h = v.media.height || 140;
    return h > maxH ? { w: w * maxH / h, h: maxH } : { w, h };
  };
  const count = items.length, key = `${width}:${GAP}:${LOOK}:${maxH}`;
  const resume = cache?.key === key && count > cache.count && items[0] === cache.first && items[cache.count - 1] === cache.last;
  const indexes = resume ? [...cache.remaining, ...items.slice(cache.count).map((v, i) => i + cache.count)] : items.map((v, i) => i);
  const first = items[0], last = items[count - 1];
  if (resume) items = indexes.map(index => items[index]);
  const sizes = items.map(nat), next = items.map((v, i) => i + 1), prev = items.map((v, i) => i - 1);
  const positions = resume ? cache.positions.slice(0, cache.prefix) : [];
  let head = 0;
  let y = resume ? cache.y : 0, tail;
  while (head < items.length) {
    const seed = sizes[head].h;
    const pool = [];
    for (let index = head; index < items.length && pool.length < LOOK; index = next[index])
      pool.push({ index, k: pool.length, s: sizes[index] });
    // Appends can change only rows whose lookahead was not already full.
    if (!tail && pool.length < LOOK) tail = { remaining: pool.map(c => indexes[c.index]), prefix: positions.length, y };
    const order = [pool[0], ...pool.slice(1).sort((a, b) => Math.abs(Math.log(a.s.h / seed)) - Math.abs(Math.log(b.s.h / seed)) || a.k - b.k)];
    const row = []; let aspect = 0; let minH = Infinity; let full = false;
    for (const c of order) {
      row.push(c); aspect += c.s.w / c.s.h; minH = Math.min(minH, c.s.h);
      if (aspect * minH + GAP * (row.length - 1) >= width) { full = true; break; }
    }
    // Width-filling height; a row that cannot fill the page (only at the end) keeps its smallest original height.
    const h = full ? (width - GAP * (row.length - 1)) / aspect : minH;
    row.sort((a, b) => a.k - b.k);
    const rowH = Math.max(1, Math.floor(h));
    let x = 0;
    row.forEach((c, k) => {
      // The last tile of a full row absorbs rounding so the row ends exactly at the page edge.
      const w = full && k === row.length - 1 ? width - x : Math.max(1, Math.floor(c.s.w / c.s.h * h));
      positions.push({ index: indexes[c.index], x, y, w, h: rowH });
      x += w + GAP;
    });
    for (const { index } of row) {
      if (prev[index] < 0) head = next[index]; else next[prev[index]] = next[index];
      if (next[index] < items.length) prev[next[index]] = prev[index];
    }
    y += rowH + GAP;
  }
  grid.style.height = `${Math.max(0, y - GAP)}px`;
  if (cache) Object.assign(cache, { key, count, first, last, positions,
    ...(tail || { remaining: [], prefix: positions.length, y }) });
  return positions;
}

// Gap-free justified rows (never enlarged) built from the stored image sizes, so the layout is known
// before images load. More tiles load as the end of the page comes into view.
// Round 1: 👎 deletes right away. Round 2+: 👍/👎 are only counted. Reaching the end starts the next round.
function thumbsView(q) {
  const sort = ['newest', 'oldest', 'largest', 'smallest'].includes(q.sort) ? q.sort : 'newest';
  view().innerHTML = `<section class="thumbs">
    <div class="tools"><h1>▦ Thumbnails <span class="count" id="t-count"></span></h1><span class="count" id="t-round"></span>
      <select id="t-sort">${[['newest', 'Newest'], ['oldest', 'Oldest'], ['largest', 'Largest first'], ['smallest', 'Smallest first']]
        .map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="masonry" id="masonry"></div><div class="loading" id="t-more">Loading…</div></section>`;
  $('#t-sort').addEventListener('change', (e) => { location.hash = href(['thumbs'], { sort: e.target.value }); });
  const grid = $('#masonry');
  const items = [];
  let total = Infinity; let round = 1; let busy = false; let end = false; let advancing = false; let disposed = false; let closeViewer = null;
  const request = new AbortController();
  const gallery = mediaGrid(grid, items, tileFor, { justified: true });

  function roundLabel() {
    $('#t-round').textContent = round === 1 ? 'Round 1 · 👎 deletes right away' : `Round ${fmtNum(round)} · 👍 👎 are counted, nothing is deleted`;
  }
  function buttons(v) {
    return `<div class="tvote"><button class="tv like ${v.vote === 'like' ? 'on' : ''}" data-vote="like" title="Like (likes from all rounds)">👍 <b>${fmtNum(v.likes || 0)}</b></button>
      <button class="tv nope ${v.vote === 'dislike' ? 'on' : ''}" data-vote="dislike" title="${round === 1 ? 'Dislike and delete' : 'Dislike'}">👎</button></div>`;
  }
  function tileFor(v) {
    // Visible tiles survive reflows; offscreen tiles and decoded media are released.
    if (!v.el) {
      v.el = document.createElement('div');
      v.el.className = 'mtile'; v.el.title = v.title;
      v.el.innerHTML = `<img alt="">${ytBadge(v)}<span>${esc(v.title)}</span>${statsBadge(v)}${buttons(v)}`;
    }
    return v.el;
  }
  // Justified rows (see justifyRows); only re-flowed when the width changes or tiles change.
  function layout(append = false) {
    gallery.layout(append);
  }
  async function more() {
    if (disposed || busy || end) return;
    busy = true;
    try {
      // Deleted posts are dropped from `items` and from the server's list, so the offsets stay aligned.
      const r = await api(`/api/public/thumbs?${new URLSearchParams({ sort, offset: items.length, limit: 80 })}`, { signal: request.signal });
      if (disposed) return;
      total = r.total; round = r.round; roundLabel();
      $('#t-count').textContent = fmtNum(total);
      items.push(...r.items); layout(true);
      end = r.offset + r.items.length >= r.total;
      $('#t-more').textContent = end ? (total ? '' : 'No thumbnails.') : 'Loading…';
    } catch (e) { if (!disposed) { toast(e.message); return; } } finally { busy = false; }
    if (disposed) return;
    if (end) nextRound();
    else if ($('#t-more').getBoundingClientRect().top < innerHeight * 2) more();
  }
  // Every thumbnail of this round has been shown: start the next one once the end is on screen.
  async function nextRound() {
    if (disposed || advancing || !total || !items.length) return;
    const r0 = $('#t-more').getBoundingClientRect();
    if (r0.top > innerHeight) return;
    advancing = true;
    try {
      const r = await api('/api/public/thumbs/seen', { json: { round } });
      if (disposed) return;
      if (r.round !== round) {
        $('#t-more').innerHTML = `🏁 Round ${fmtNum(round)} complete. <a href="#" id="t-next">Start round ${fmtNum(r.round)} from the top</a>`;
        $('#t-next').addEventListener('click', (e) => { e.preventDefault(); render(); });
        toast(`Round ${fmtNum(r.round)} started`);
      }
    } catch (e) { toast(e.message); advancing = false; }
  }
  function setCount() { $('#t-count').textContent = fmtNum(total); }
  async function vote(v, kind) {
    if (v.pending) return;
    const next = v.vote === kind ? 'none' : kind;
    v.pending = true;
    try {
      const r = await api('/api/public/vote', { json: { id: v.id, type: 'thumbs', vote: next } });
      if (disposed) return;
      v.vote = next === 'none' ? null : next; v.likes = r.likes;
      if (next === 'like') { rewardNote(r); if (r.reward?.paid && (!r.reward.symbol || r.reward.symbol === 'FTHX')) v.earned = (v.earned || 0) + r.reward.paid; }
      if (r.deleted) {
        // Round 1: the post and its media are gone, so the tile leaves the gallery at once.
        const at = items.indexOf(v);
        if (at >= 0) items.splice(at, 1);
        total--; setCount(); layout();
        toast('Deleted', { label: 'Undo', run: () => undo(v, at) });
      } else {
        if (v.el) $('.tvote', v.el).outerHTML = buttons(v);
      }
    } catch (e) { toast(e.message); } finally { v.pending = false; }
  }
  async function undo(v, at) {
    if (disposed) return;
    try {
      const r = await api('/api/public/vote', { json: { id: v.id, type: 'thumbs', vote: 'none' } });
      if (disposed) return;
      v.vote = null; v.likes = r.likes;
      if (v.el) $('.tvote', v.el).outerHTML = buttons(v);
      items.splice(Math.min(at, items.length), 0, v); total++; setCount(); layout();
      toast('Restored');
    } catch (e) { toast(e.message); }
  }
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.mtile');
    if (!t) return;
    const v = items[+t.dataset.i];
    if (!v) return;
    const b = e.target.closest('[data-vote]');
    if (b) return vote(v, b.dataset.vote);
    closeViewer?.(); gallery.pause(true);
    closeViewer = openViewer(items, items.indexOf(v), { onClose: () => gallery.pause(false) });
  });
  const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) (end ? nextRound() : more()); }, { rootMargin: '1200px 0px' });
  io.observe($('#t-more'));
  const onEnd = () => { if (end) nextRound(); };
  window.addEventListener('scroll', onEnd, { passive: true });
  cleanup = () => { disposed = true; request.abort(); io.disconnect(); gallery.close(); closeViewer?.(); window.removeEventListener('scroll', onEnd); };
  layout();
  more();
}

// ---------- trending ----------
// Photos with a GIF after every few, from the posts of the trending tags (or one picked tag), most
// liked + commented first. Same justified rows as the thumbnails; 👍 toggles a like in the post's own deck.
const TREND_SORTS = [['hot', 'Likes + comments'], ['likes', 'Most liked'], ['comments', 'Most commented'], ['newest', 'Newest']];
let trendTyping = null;
function trendingView(q) {
  const sort = TREND_SORTS.some(([v]) => v === q.sort) ? q.sort : 'hot';
  const tag = q.tag ? +q.tag : 0;
  const query = (q.q || '').trim();
  const sortQ = sort === 'hot' ? '' : sort;
  view().innerHTML = `<section class="thumbs trending">
    <div class="tools"><h1>📈 Trending <span class="count" id="t-count"></span></h1>
      <input type="search" id="t-q" placeholder="Search posts and tags…" value="${esc(query)}" autocomplete="off" aria-label="Search">
      <select id="t-sort">${TREND_SORTS.map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="ttags" id="t-tags"></div>
    <div class="masonry" id="masonry"></div><div class="loading" id="t-more">Loading…</div></section>`;
  $('#t-sort').addEventListener('change', (e) => { location.hash = href(['trending'], { tag: tag || '', q: query, sort: e.target.value === 'hot' ? '' : e.target.value }); });
  // Typing searches every post (a picked tag is dropped); the box keeps focus across the re-render.
  const box = $('#t-q');
  let timer;
  const search = (now) => {
    clearTimeout(timer);
    const run = () => {
      const v = box.value.trim();
      if (v === query) return;
      trendTyping = { pos: box.selectionStart };
      location.hash = href(['trending'], { q: v, sort: sortQ });
    };
    if (now) run(); else timer = setTimeout(run, 450);
  };
  box.addEventListener('input', () => search(false));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(true); if (e.key === 'Escape' && box.value) { box.value = ''; search(true); } });
  if (trendTyping) { box.focus(); const p = Math.min(trendTyping.pos ?? box.value.length, box.value.length); box.setSelectionRange(p, p); trendTyping = null; }
  const grid = $('#masonry');
  const items = [];
  let busy = false; let end = false; let disposed = false; let closeViewer = null;
  const request = new AbortController();
  const gallery = mediaGrid(grid, items, tileFor, { justified: true, maxH: Math.max(220, Math.round(innerHeight * 0.45)) });

  // Tag chips: the trending tags, then "More tags" pages through every other tag (most active first).
  // While searching, the chips are the tags whose names match.
  const shownTags = new Set();
  let tagOffset = 0;
  const link = (id) => href(['trending'], { tag: id || '', sort: sortQ });
  const stat = (t) => `${fmtNum(t.posts)} posts${t.likes ? ` · 👍 ${fmtNum(t.likes)}` : ''}${t.comments ? ` · 💬 ${fmtNum(t.comments)}` : ''}`;
  const chip = (t) => `<a class="chip ${t.id === tag ? 'on' : ''}" href="${link(t.id)}" title="${esc(stat(t))}">#${esc(t.name)}</a>`;
  function addChips(list, hasMore) {
    const fresh = list.filter((t) => !shownTags.has(t.id));
    fresh.forEach((t) => shownTags.add(t.id));
    $('#t-tags .chip.more')?.remove();
    $('#t-tags').insertAdjacentHTML('beforeend', fresh.map(chip).join('')
      + (hasMore ? '<button type="button" class="chip more" title="Show more tags">＋ More tags</button>' : ''));
  }
  async function moreTags() {
    if (disposed) return;
    const btn = $('#t-tags .chip.more');
    if (!btn || btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const r = await api(`/api/public/trending/tags?${new URLSearchParams({ offset: tagOffset, limit: 40, ...(query ? { q: query } : {}) })}`, { signal: request.signal });
      if (disposed) return;
      tagOffset = r.offset + r.tags.length;
      addChips(r.tags, tagOffset < r.total);
    } catch (e) { if (!disposed) { toast(e.message); btn.disabled = false; btn.textContent = '＋ More tags'; } }
  }
  $('#t-tags').addEventListener('click', (e) => { if (e.target.closest('.chip.more')) moreTags(); });
  async function chips(r) {
    $('#t-tags').innerHTML = `<a class="chip ${tag || query ? '' : 'on'}" href="${link(0)}" title="Posts from every trending tag">🔥 All trending</a>`;
    if (r.tag) addChips([{ ...r.tag, posts: r.total, likes: 0, comments: 0 }], false);
    if (query) {
      // first page of matching tags; the button continues through the rest
      tagOffset = 0;
      $('#t-tags').insertAdjacentHTML('beforeend', '<button type="button" class="chip more">＋ More tags</button>');
      await moreTags();
    } else {
      tagOffset = r.tags.length;
      addChips(r.tags, r.moreTags);
    }
  }
  function likeBtn(v) {
    return `<div class="tvote"><button class="tv like ${v.vote === 'like' ? 'on' : ''}" data-vote="like" title="Like">👍 <b>${fmtNum(v.likes || 0)}</b></button></div>`;
  }
  function tileFor(v) {
    if (!v.el) {
      v.el = document.createElement('div');
      v.el.className = 'mtile'; v.el.title = v.title;
      v.el.innerHTML = `<img alt="">${ytBadge(v)}<span>${esc(v.title)}</span>`
        + `${v.media.type === 'gif' ? '<i class="tgif">GIF</i>' : ''}${likeBtn(v)}`;
    }
    return v.el;
  }
  function layout(append = false) {
    gallery.layout(append);
  }
  async function more() {
    if (disposed || busy || end) return;
    busy = true;
    try {
      const r = await api(`/api/public/trending?${new URLSearchParams({ sort, offset: items.length, limit: 60, ...(tag ? { tag } : {}), ...(query ? { q: query } : {}) })}`, { signal: request.signal });
      if (disposed) return;
      if (!items.length) chips(r);
      $('#t-count').textContent = query ? `${fmtNum(r.total)} for “${query}”` : fmtNum(r.total);
      items.push(...r.items); layout(true);
      end = r.offset + r.items.length >= r.total;
      $('#t-more').textContent = end ? (r.total ? '' : query ? 'No posts match.' : 'Nothing here yet.') : 'Loading…';
    } catch (e) { if (!disposed) { $('#t-more').textContent = e.message; end = true; } } finally { busy = false; }
    if (disposed) return;
    if (!end && $('#t-more').getBoundingClientRect().top < innerHeight * 2) more();
  }
  async function like(v) {
    if (v.pending) return;
    const next = v.vote === 'like' ? 'none' : 'like';
    v.pending = true;
    try {
      const r = await api('/api/public/vote', { json: { id: v.id, type: v.deck, vote: next } });
      if (disposed) return;
      v.vote = next === 'none' ? null : 'like'; v.likes = r.likes;
      if (next === 'like') { rewardNote(r); if (r.reward?.paid && (!r.reward.symbol || r.reward.symbol === 'FTHX')) v.earned = (v.earned || 0) + r.reward.paid; }
      if (v.el) $('.tvote', v.el).outerHTML = likeBtn(v);
    } catch (e) { toast(e.message); } finally { v.pending = false; }
  }
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.mtile');
    const v = t && items[+t.dataset.i];
    if (!v) return;
    if (e.target.closest('[data-vote]')) return like(v);
    closeViewer?.(); gallery.pause(true);
    closeViewer = openViewer(items, items.indexOf(v), { onClose: () => gallery.pause(false) });
  });
  const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) more(); }, { rootMargin: '1200px 0px' });
  io.observe($('#t-more'));
  cleanup = () => { disposed = true; request.abort(); clearTimeout(timer); io.disconnect(); gallery.close(); closeViewer?.(); };
  layout();
  more();
}

// Full-screen viewer for a list of posts; ← → step through them, Esc closes. The image is shown at its
// original pixel size (scaled down only when it does not fit), with the post's comments beside it.
// `opts.onCount(v)` runs whenever v.comments changes; `opts.focus` puts the cursor in the comment box.
function openViewer(list, i, opts = {}) {
  const box = document.createElement('div');
  box.className = 'viewer';
  let seq = 0; let closed = false;
  // Keeps a gallery tile's 💬 badge (or the caller's own counter) in step with the comments shown here.
  const badge = (v) => {
    opts.onCount?.(v);
    if (!v.el) return;
    let b = $('.tc', v.el);
    if (!b) $('span', v.el).insertAdjacentHTML('afterend', statsBadge(v));
    tileStats(v);
  };
  const show = () => {
    const v = list[i];
    $('.vmedia img', box)?.removeAttribute('src');
    const dims = v.media.width && v.media.height ? `${v.media.width}×${v.media.height}` : '';
    box.innerHTML = `<div class="vbar"><b>${esc(v.title)}</b><span class="count">${i + 1} / ${fmtNum(list.length)} · <span id="v-views">👁 ${fmtNum(v.views || 0)}</span> · ${esc(TYPE_LABEL[v.media.type] || '')} · ${dims ? `${dims} · ` : ''}${esc(fmtBytes(v.media.size))}</span>
      ${opts.organize ? '<button class="btn" data-organize>Folders</button>' : ''}
      <button class="btn" data-prev aria-label="Previous media" ${i ? '' : 'disabled'}>←</button><button class="btn" data-next aria-label="Next media" ${i < list.length - 1 || opts.hasMore?.() ? '' : 'disabled'}>→</button><button class="btn" data-close aria-label="Close media">✕</button></div>
      <div class="vbody">
        <div class="vmedia">${v.video ? `<figure><div class="ytbox"></div><figcaption>▶ YouTube video · <a href="${esc(ytWatch(v.video))}" target="_blank" rel="noopener noreferrer">open on YouTube ↗</a></figcaption></figure>` : `<figure><img src="${esc(v.media.url)}" alt=""${v.media.width ? ` width="${v.media.width}" height="${v.media.height}"` : ''}>
          <figcaption id="v-size">${dims ? `Original size ${dims}` : ''}</figcaption></figure>`}
          ${v.description ? `<p class="vdesc">${esc(v.description)}</p>` : ''}
          ${v.tags?.length ? `<div class="vtags">${v.tags.map((t) => `<a data-close href="${href(['trending'], { tag: t.id })}" title="Trending posts tagged ${esc(t.name)}">#${esc(t.name)}</a>`).join('')}</div>` : ''}</div>
        <aside class="vside">${authorHtml(v)}<h3>💬 Comments <span class="count" id="c-count"></span></h3>
          <div class="clist" id="c-list"><div class="loading">Loading…</div></div>
          <form class="cform" id="c-form"></form></aside>
      </div>`;
    const img = $('.vmedia img', box);
    if (v.video) $('.ytbox', box).append(ytFrame(v.video, 'ytplayer'));
    const fit = () => {
      if (!img?.naturalWidth) return;
      // Measure once the viewer is laid out; before that the image has no on-screen width.
      if (!img.clientWidth) { if (!closed && $('.vmedia img', box) === img) requestAnimationFrame(fit); return; }
      const scaled = img.clientWidth < img.naturalWidth - 1;
      $('#v-size', box).textContent = `Original size ${img.naturalWidth}×${img.naturalHeight}${scaled ? ` · shown at ${Math.round(img.clientWidth / img.naturalWidth * 100)}% to fit` : ''}`;
    };
    if (img && img.complete) fit(); else img?.addEventListener('load', fit, { once: true });
    paintForm();
    loadComments(v, ++seq);
    countView(v, (x) => { if (list[i] === x && !closed) { const e = $('#v-views', box); if (e) e.textContent = `👁 ${fmtNum(x.views)}`; } opts.onViews?.(x); });
  };
  // Member posts: who posted it, what it earned, and tip buttons.
  function authorHtml(v) {
    if (!v.author) return '';
    const own = wallet.address === v.author;
    const tips = info?.token?.tips || [1, 5, 25];
    return `<div class="vauthor"><div>Posted by <b title="${esc(v.author)}">🦊 ${esc(short(v.author))}</b> · <span id="v-earned">🪙 ${fmtNum(v.earned || 0)} FTHX earned</span></div>
      ${own ? '<div class="count">Your post — you earn from likes and tips</div>'
        : `<div class="tips">Tip ${tips.map((n) => `<button class="btn" data-tip="${n}" title="Send ${n} FTHX to the poster">${n}</button>`).join('')}<span class="count">FTHX</span></div>`}</div>`;
  }
  async function tip(n, btn) {
    const v = list[i];
    if (!wallet.address && !(await connectWallet())) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/public/posts/${v.id}/tip`, { json: { amount: n } });
      v.earned = r.earned; setBalance(r.balance);
      const e = $('#v-earned', box); if (e) e.textContent = `🪙 ${fmtNum(r.earned)} FTHX earned`;
      opts.onEarned?.(v);
      toast(`🪙 Tipped ${fmtNum(n)} FTHX to ${short(r.to)}`);
    } catch (e) {
      if (/Not enough FTHX/.test(e.message)) toast(e.message, { label: 'Add FTHX', run: openWalletPanel }); else toast(e.message);
    } finally { btn.disabled = false; }
  }
  async function loadComments(v, my) {
    try {
      const r = await api(`/api/public/posts/${v.id}/comments`);
      if (my !== seq) return;
      v.comments = r.total; badge(v);
      $('#c-count', box).textContent = fmtNum(r.total);
      $('#c-list', box).innerHTML = r.items.length ? r.items.map(commentHtml).join('') : '<div class="cempty">No comments yet. Be the first.</div>';
    } catch (e) { if (my === seq) $('#c-list', box).innerHTML = `<div class="cempty">${esc(e.message)}</div>`; }
  }
  function commentHtml(c) {
    const mine = c.address && c.address === wallet.address;
    const who = c.address ? `<span class="cwho" title="${esc(c.address)}">🦊 ${esc(short(c.address))}</span>` : `<span class="cwho">${esc(c.author)}</span>`;
    const when = c.at ? new Date(c.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<div class="comment" data-cid="${esc(c.id)}"><div class="chead">${who}<span class="cwhen">${esc(when)}</span>${mine ? '<button class="cdel" data-cdel title="Delete your comment">✕</button>' : ''}</div>
      <div class="ctext">${esc(c.content)}</div></div>`;
  }
  function paintForm() {
    const f = $('#c-form', box);
    if (!f) return;
    f.innerHTML = wallet.address
      ? `<textarea id="c-text" rows="3" maxlength="2000" placeholder="Write a comment as ${esc(short(wallet.address))}…"></textarea>
        <div class="crow"><span class="count">Ctrl+Enter to post</span><button class="btn primary" type="submit">Post</button></div>`
      : `<button class="btn primary" type="button" data-connect>🦊 Connect wallet to comment</button>`;
  }
  async function post() {
    const ta = $('#c-text', box);
    const text = ta?.value.trim();
    if (!text) return;
    const v = list[i]; const my = seq;
    ta.disabled = true;
    try {
      const c = await api(`/api/public/posts/${v.id}/comments`, { json: { content: text } });
      if (my !== seq) return;
      if (c.reward?.paid) {
        rewardNote(c);
        if (c.reward.symbol === 'FTHX') v.earned = (v.earned || 0) + c.reward.paid;
      }
      ta.value = '';
      const l = $('#c-list', box);
      $('.cempty', l)?.remove();
      l.insertAdjacentHTML('beforeend', commentHtml(c));
      l.scrollTop = l.scrollHeight;
      v.comments = (v.comments || 0) + 1; badge(v);
      $('#c-count', box).textContent = fmtNum(v.comments);
    } catch (e) { toast(e.message); if (!wallet.address) paintForm(); } finally { if (ta.isConnected) { ta.disabled = false; ta.focus(); } }
  }
  let stepping = false, swipe = null;
  const step = async d => {
    if (closed || stepping) return;
    stepping = true;
    try {
      const j = i + d;
      if (j >= list.length && opts.hasMore?.()) {
        $('[data-next]', box).disabled = true;
        await opts.loadMore();
      }
      if (!closed && j >= 0 && j < list.length) { i = j; show(); }
    } catch (error) { if (!closed) toast(error.message); }
    finally { stepping = false; if (!closed) $('[data-next]', box).disabled = i >= list.length - 1 && !opts.hasMore?.(); }
  };
  box.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || !event.target.closest('.vmedia') || event.target.closest('button,a,input,textarea,iframe')) return;
    swipe = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  box.addEventListener('pointerup', event => {
    if (!swipe || swipe.id !== event.pointerId) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y; swipe = null;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  box.addEventListener('pointercancel', () => { swipe = null; });
  const onWallet = () => { paintForm(); const a = $('.vauthor', box); if (a) a.outerHTML = authorHtml(list[i]); loadComments(list[i], ++seq); };
  const close = () => { if (closed) return; closed = true; seq++; $('.vmedia img', box)?.removeAttribute('src'); box.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('wallet', onWallet); opts.onClose?.(); };
  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('textarea, input')) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } else if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1);
  };
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-prev]')) step(-1);
    else if (e.target.closest('[data-next]')) step(1);
    else if (e.target.closest('[data-organize]')) opts.organize?.(list[i]);
    else if (e.target.closest('[data-connect]')) connectWallet();
    else if (e.target.closest('[data-tip]')) { const b = e.target.closest('[data-tip]'); tip(+b.dataset.tip, b); }
    else if (e.target.closest('[data-cdel]')) {
      const el = e.target.closest('.comment');
      if (!confirm('Delete your comment?')) return;
      try {
        await api(`/api/public/comments/${el.dataset.cid}`, { method: 'DELETE' });
        el.remove();
        const v = list[i]; v.comments = Math.max(0, (v.comments || 1) - 1); badge(v);
        $('#c-count', box).textContent = fmtNum(v.comments);
      } catch (err) { toast(err.message); }
    }
  });
  box.addEventListener('submit', (e) => { e.preventDefault(); post(); });
  document.addEventListener('keydown', onKey);
  document.addEventListener('wallet', onWallet);
  show();
  document.body.append(box);
  if (opts.focus) $('#c-text', box)?.focus();
  return close;
}

// ---------- new post ----------
// Any image source becomes one upload: animated GIFs are kept (up to 15 MB); everything else — photos,
// PNG/WebP/AVIF/HEIC the browser can read, SVG, screenshots, camera shots, video frames — is redrawn as a
// JPEG (longest side ≤ 2048 px, ≤ 1.5 MB, metadata such as GPS stripped). Small stills go to Thumbs.
const POST = { maxSide: 2048, target: 1.5 * 1048576, gifMax: 15 * 1048576, thumbSide: 640 };
const isGifBytes = (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
function gifFrames(b) {
  let n = 0;
  for (let k = 0; k + 2 < b.length; k++) if (b[k] === 0x21 && b[k + 1] === 0xf9 && b[k + 2] === 0x04 && ++n > 1) break;
  return n;
}
async function decodeImage(blob) {
  try {
    const bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { src: bm, width: bm.width, height: bm.height };
  } catch { /* fall back to <img>, e.g. for SVG */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth || 1024; const height = img.naturalHeight || 1024;
    return { src: img, width, height };
  } catch {
    throw new Error("This browser can't read that file — try a JPEG, PNG, GIF, WebP or a video");
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function toJpeg(src, w, h) {
  let scale = Math.min(1, POST.maxSide / Math.max(w, h));
  let q = 0.86; let out = null;
  for (let n = 0; n < 14; n++) {
    const cw = Math.max(1, Math.round(w * scale)); const ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, cw, ch);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (!blob) throw new Error("Couldn't encode the image");
    out = { blob, width: cw, height: ch, quality: q };
    if (blob.size <= POST.target) break;
    if (q > 0.63) q = Math.max(0.62, q - 0.08); else scale *= 0.85;
  }
  return out;
}
// → { blob, type: 'gif'|'jpeg', width, height, original, originalType, note }
async function prepareImage(blob) {
  const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, POST.gifMax + 1)).arrayBuffer());
  const originalType = (blob.type || '').replace('image/', '').toUpperCase() || (isGifBytes(bytes) ? 'GIF' : 'image');
  if (isGifBytes(bytes)) {
    const width = bytes[6] | (bytes[7] << 8); const height = bytes[8] | (bytes[9] << 8);
    if (gifFrames(bytes) > 1) {
      if (blob.size <= POST.gifMax) return { blob: new Blob([bytes], { type: 'image/gif' }), type: 'gif', width, height, original: blob.size, originalType: 'GIF', note: 'Animated GIF kept as is' };
      const d = await decodeImage(blob);
      const j = await toJpeg(d.src, d.width, d.height);
      return { ...j, type: 'jpeg', original: blob.size, originalType: 'GIF', note: `GIF is over ${POST.gifMax / 1048576} MB — posting its first frame as a JPEG` };
    }
  }
  const d = await decodeImage(blob);
  const j = await toJpeg(d.src, d.width, d.height);
  d.src.close?.();
  return { ...j, type: 'jpeg', original: blob.size, originalType, note: j.width < d.width ? `Resized from ${d.width}×${d.height}` : '' };
}
async function fetchLinkImage(url) {
  if (!wallet.address && !(await connectWallet())) throw new Error('Connect your wallet to fetch links');
  const r = await fetch(publicUrl('/api/public/fetch-link'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wallet-Token': wallet.token || '' }, body: JSON.stringify({ url }) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) setWallet(null);
    throw new Error(d.error || r.statusText);
  }
  const h = (k) => decodeURIComponent(r.headers.get(k) || '');
  return { blob: await r.blob(), title: h('X-Page-Title'), page: h('X-Page-Url'), image: h('X-Image-Url'), video: h('X-Video') || null };
}
const titleFromName = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const stamp = () => new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const looksLikeUrl = (s) => /^(https?:\/\/|data:image\/)/i.test(String(s || '').trim());
const isYoutube = (s) => /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i.test(String(s || '').trim());

function postView() {
  const cost = info?.token?.postCost ?? 1;
  view().innerHTML = `<section class="postpage">
    <div class="phead"><h1>New post</h1><span class="count">A YouTube video, an image, a GIF or a supported link · costs ${fmtNum(cost)} FTHX · community-note rewards only · FTHX tips transfer existing funds</span></div>
    <div class="pgrid">
      <div class="drop" id="p-drop" tabindex="0">
        <div class="dz" id="p-empty">
          <div class="big">⤓</div>
          <div>Drop an image, GIF, video or YouTube link here, or paste one with <kbd>Ctrl</kbd>+<kbd>V</kbd></div>
          <div class="srcs">
            <button class="btn" type="button" data-src="file" title="Choose a file">📁 Upload</button>
            <button class="btn" type="button" data-src="camera" title="Take a photo">📷 Camera</button>
            <button class="btn" type="button" data-src="screen" title="Capture a screen, window or tab">🖥 Screenshot</button>
            <button class="btn" type="button" data-src="clip" title="Paste an image or link from the clipboard">📋 Paste</button>
          </div>
          <form class="linkrow" id="p-link"><input id="p-url" type="url" inputmode="url" placeholder="…or a YouTube, image or page link (YouTube, Reddit, Imgur, any page with a preview image)">
            <button class="btn" type="submit">Fetch</button></form>
        </div>
        <div class="pv" id="p-pv" hidden></div>
        <input id="p-file" type="file" accept="image/*,video/*" hidden>
        <input id="p-cap" type="file" accept="image/*" capture="environment" hidden>
      </div>
      <form class="pform" id="p-form">
        <label>Title<input id="p-title" maxlength="200" placeholder="Say what it is"></label>
        <label><span>Description <span class="count">optional</span></span><textarea id="p-desc" rows="4" maxlength="2000" placeholder="Anything to add"></textarea></label>
        <label><span>Source <span class="count">optional link</span></span><input id="p-src" type="url" maxlength="2000" placeholder="https://"></label>
        <div class="pfoot"><span class="count" id="p-bal"></span><button class="btn primary" id="p-go" type="submit"></button></div>
      </form>
    </div></section>`;
  let cur = null; let busy = false; let seq = 0; let video = null; let stream = null;
  const drop = $('#p-drop');

  function paintFoot() {
    const go = $('#p-go');
    if (!wallet.address) { go.textContent = '🦊 Connect wallet to post'; $('#p-bal').textContent = ''; go.disabled = false; return; }
    const bal = wallet.balance ?? 0;
    $('#p-bal').innerHTML = `Balance ${fmtNum(bal)} FTHX${bal < cost ? ' · <a href="#" id="p-add">add FTHX</a>' : ''}`;
    go.textContent = busy ? 'Posting…' : `Post · ${fmtNum(cost)} FTHX`;
    go.disabled = busy || !cur;
  }
  function reset() {
    cur = null; seq++;
    stopVideo();
    $('#p-pv').hidden = true; $('#p-pv').innerHTML = ''; $('#p-empty').hidden = false;
    paintFoot();
  }
  function stopVideo() {
    if (video?.src?.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video = null;
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
  }
  function busyPreview(msg) {
    $('#p-empty').hidden = true;
    const pv = $('#p-pv'); pv.hidden = false;
    pv.innerHTML = `<div class="loading">${esc(msg)}</div>`;
  }
  // Takes any blob plus where it came from, and shows what will be posted.
  async function use(blob, meta = {}) {
    if (!blob) return;
    const my = ++seq;
    stopVideo();
    if (/^video\//.test(blob.type)) return pickFrame(blob, meta);
    busyPreview('Preparing image…');
    try {
      const p = await prepareImage(blob);
      if (my !== seq) return;
      if (Math.min(p.width, p.height) < 32) throw new Error('That image is too small (needs at least 32 px on each side)');
      if (cur?.url) URL.revokeObjectURL(cur.url);
      cur = { ...p, url: URL.createObjectURL(p.blob), video: meta.video || null };
      if (meta.title && !$('#p-title').value.trim()) $('#p-title').value = meta.title.slice(0, 200);
      if (meta.source && !$('#p-src').value.trim()) $('#p-src').value = meta.source;
      const thumbs = !cur.video && p.type !== 'gif' && Math.max(p.width, p.height) < POST.thumbSide;
      $('#p-pv').innerHTML = `${cur.video ? '<figure class="ytwrap"></figure>' : `<figure><img src="${esc(cur.url)}" alt="" width="${p.width}" height="${p.height}"></figure>`}
        <div class="pinfo">${cur.video ? `<span>▶ YouTube video · cover ${p.width}×${p.height}</span>` : `<span>${p.type === 'gif' ? 'GIF' : 'JPG'} · ${p.width}×${p.height} · ${esc(fmtBytes(p.blob.size))}</span>`}
          ${p.original !== p.blob.size && !cur.video ? `<span class="count">from ${esc(fmtBytes(p.original))} ${esc(p.originalType)}</span>` : ''}
          <span class="dest" title="${thumbs ? `Still images under ${POST.thumbSide}px go to the Thumbs gallery` : 'Shown in the swipe deck'}">→ ${thumbs ? '▦ Thumbs' : '🔥 Swipe'}</span>
          ${p.note ? `<span class="count">${esc(p.note)}</span>` : ''}
          <button class="btn" type="button" data-reset title="Choose another">✕ Remove</button></div>`;
      if (cur.video) $('.ytwrap', $('#p-pv')).append(ytFrame(cur.video, 'ytprev', false));
      paintFoot();
      if (!$('#p-title').value.trim()) $('#p-title').focus();
    } catch (e) { if (my === seq) { reset(); toast(e.message); } }
  }
  // Videos: scrub to a moment and post that frame.
  function pickFrame(blob, meta) {
    $('#p-empty').hidden = true;
    const pv = $('#p-pv'); pv.hidden = false;
    pv.innerHTML = `<figure><video playsinline muted controls preload="auto"></video></figure>
      <div class="pinfo"><span>Pick a frame from the video</span><button class="btn primary" type="button" data-frame>📸 Use this frame</button><button class="btn" type="button" data-reset>✕ Remove</button></div>`;
    video = $('video', pv);
    video.src = URL.createObjectURL(blob);
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(1, (video.duration || 0) / 2); }, { once: true });
    video.addEventListener('error', () => { toast("This browser can't play that video"); reset(); }, { once: true });
    video._meta = meta;
  }
  async function grabFrame(v) {
    if (!v.videoWidth) throw new Error('The video has no picture yet');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }
  async function useFrame() {
    try { const meta = video._meta; await use(await grabFrame(video), meta); } catch (e) { toast(e.message); }
  }
  async function useLink(url) {
    url = String(url || '').trim();
    if (!url) return;
    if (/^data:image\//i.test(url)) { try { return use(await (await fetch(url)).blob(), { title: 'Pasted image' }); } catch { toast('That image data is not valid'); return; } }
    busyPreview('Fetching link…');
    const my = ++seq;
    try {
      const r = await fetchLinkImage(url);
      if (my !== seq) return;
      $('#p-url').value = '';
      await use(r.blob, { title: r.title || (r.video ? 'YouTube video' : titleFromName(r.image.split('/').pop().split('?')[0])), source: r.page || url, video: r.video });
    } catch (e) { if (my === seq) { reset(); toast(e.message); } }
  }
  // Pulls the best thing out of a drop or paste: files first, then image links in HTML, then URLs.
  async function fromTransfer(dt) {
    const file = [...(dt.files || [])].find((f) => /^(image|video)\//.test(f.type)) || dt.files?.[0];
    if (file) return use(file, { title: titleFromName(file.name) });
    const link = (dt.getData?.('text/uri-list') || dt.getData?.('text/plain') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (isYoutube(link)) return useLink(link);
    const html = dt.getData?.('text/html') || '';
    const src = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    if (src) return useLink(src.replace(/&amp;/g, '&'));
    const text = (dt.getData?.('text/uri-list') || dt.getData?.('text/plain') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (looksLikeUrl(text)) return useLink(text);
    return false;
  }
  async function camera() {
    if (!navigator.mediaDevices?.getUserMedia) return $('#p-cap').click();
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); } catch (e) {
      if (e?.name === 'NotAllowedError') toast('Camera permission was denied'); else $('#p-cap').click();
      return;
    }
    seq++;
    $('#p-empty').hidden = true;
    const pv = $('#p-pv'); pv.hidden = false;
    pv.innerHTML = `<figure class="live"><video playsinline muted autoplay></video></figure>
      <div class="pinfo"><button class="btn primary" type="button" data-snap>📸 Snap</button><button class="btn" type="button" data-reset>✕ Cancel</button></div>`;
    video = $('video', pv);
    video.srcObject = stream;
    video._meta = { title: `Photo ${stamp()}` };
  }
  async function snap() {
    try { const b = await grabFrame(video); const meta = video._meta; stopVideo(); await use(b, meta); } catch (e) { toast(e.message); }
  }
  async function screenshot() {
    if (!navigator.mediaDevices?.getDisplayMedia) { toast('Screen capture is not available in this browser'); return; }
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch { return; }
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = s;
      await v.play();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = await grabFrame(v);
      await use(b, { title: `Screenshot ${stamp()}` });
    } catch (e) { toast(e.message); } finally { s.getTracks().forEach((t) => t.stop()); }
  }
  async function clipboard() {
    try {
      if (navigator.clipboard?.read) {
        for (const it of await navigator.clipboard.read()) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) return use(await it.getType(type), { title: `Pasted image ${stamp()}` });
          if (it.types.includes('text/html')) {
            const html = await (await it.getType('text/html')).text();
            const src = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
            if (src) return useLink(src.replace(/&amp;/g, '&'));
          }
        }
      }
      const text = await navigator.clipboard?.readText?.();
      if (looksLikeUrl(text)) return useLink(text);
      toast('No image or link on the clipboard');
    } catch { toast('Clipboard access was blocked — press Ctrl+V instead'); }
  }
  async function submit() {
    if (!wallet.address) { await connectWallet(); paintFoot(); return; }
    if (!cur || busy) return;
    const title = $('#p-title').value.trim();
    if (!title) { $('#p-title').focus(); toast('Give the post a title'); return; }
    if ((wallet.balance ?? 0) < cost) { toast(`Posting costs ${fmtNum(cost)} FTHX`, { label: 'Add FTHX', run: openWalletPanel }); return; }
    busy = true; paintFoot();
    try {
      const qs = new URLSearchParams({ title, description: $('#p-desc').value.trim(), source: $('#p-src').value.trim(), ...(cur.video ? { video: cur.video } : {}) });
      const res = await fetch(publicUrl(`/api/public/posts?${qs}`), { method: 'POST', headers: { 'Content-Type': cur.blob.type, 'X-Wallet-Token': wallet.token }, body: cur.blob });
      const r = await res.json().catch(() => ({}));
      if (res.status === 401) setWallet(null);
      if (res.status === 402) { toast(r.error, { label: 'Add FTHX', run: openWalletPanel }); return; }
      if (!res.ok) throw new Error(r.error || res.statusText);
      setBalance(r.balance);
      $('#p-title').value = ''; $('#p-desc').value = ''; $('#p-src').value = '';
      reset();
      const where = r.destination === 'thumbs' ? '#/thumbs' : '#/';
      $('#p-pv').hidden = false; $('#p-empty').hidden = true;
      $('#p-pv').innerHTML = `<div class="done"><div class="big">✅</div><b>Posted “${esc(r.title)}”</b>
        <span class="count">${r.destination === 'thumbs' ? 'Added to the Thumbs gallery' : 'First in the swipe deck'} · −${fmtNum(r.cost)} FTHX · balance ${fmtNum(r.balance)}</span>
        <div class="srcs"><a class="btn primary" href="${where}">See it</a><button class="btn" type="button" data-reset>➕ Post another</button></div></div>`;
      toast('Posted');
    } catch (e) { toast(e.message); } finally { busy = false; paintFoot(); }
  }

  drop.addEventListener('click', (e) => {
    const s = e.target.closest('[data-src]')?.dataset.src;
    if (s === 'file') $('#p-file').click();
    else if (s === 'camera') camera();
    else if (s === 'screen') screenshot();
    else if (s === 'clip') clipboard();
    else if (e.target.closest('[data-reset]')) reset();
    else if (e.target.closest('[data-frame]')) useFrame();
    else if (e.target.closest('[data-snap]')) snap();
  });
  for (const id of ['#p-file', '#p-cap']) {
    $(id).addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) use(f, { title: id === '#p-cap' ? `Photo ${stamp()}` : titleFromName(f.name) }); });
  }
  $('#p-link').addEventListener('submit', (e) => { e.preventDefault(); useLink($('#p-url').value); });
  $('#p-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('#p-form').addEventListener('click', (e) => { if (e.target.id === 'p-add') { e.preventDefault(); openWalletPanel(); } });
  let depth = 0;
  const onEnter = (e) => { e.preventDefault(); depth++; drop.classList.add('over'); };
  const onLeave = () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } };
  const onOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDrop = async (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    if ((await fromTransfer(e.dataTransfer)) === false) toast('Drop an image, GIF, video or link');
  };
  // Pasting into the text fields types text as usual, unless it is an image or a lone link in the URL box.
  const onPaste = async (e) => {
    const inField = e.target.closest?.('input, textarea');
    const hasFile = [...(e.clipboardData?.files || [])].length;
    if (inField && !hasFile && e.target.id !== 'p-url') return;
    if (e.target.id === 'p-url' && !hasFile) { const t = e.clipboardData.getData('text/plain'); if (looksLikeUrl(t)) { e.preventDefault(); useLink(t); } return; }
    e.preventDefault();
    if ((await fromTransfer(e.clipboardData)) === false) toast('No image or link to paste');
  };
  const onWallet = () => paintFoot();
  document.addEventListener('dragenter', onEnter);
  document.addEventListener('dragleave', onLeave);
  document.addEventListener('dragover', onOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  document.addEventListener('wallet', onWallet);
  document.addEventListener('balance', onWallet);
  cleanup = () => {
    stopVideo(); if (cur?.url) URL.revokeObjectURL(cur.url);
    for (const [k, f] of [['dragenter', onEnter], ['dragleave', onLeave], ['dragover', onOver], ['drop', onDrop], ['paste', onPaste], ['wallet', onWallet], ['balance', onWallet]]) document.removeEventListener(k, f);
  };
  paintFoot();
  refreshBalance();
}

// ---------- age gate & boot ----------
function gate() {
  return new Promise((resolve) => {
    if (!info.ageGate || store.get('adult-ok', false)) return resolve();
    const g = $('#gate');
    g.hidden = false;
    g.innerHTML = `<div class="box"><img src="${esc(document.querySelector('link[rel~="icon"]').href)}" alt="" width="84" height="84"><h2>${esc(info.brand)}</h2>${info.tagline ? `<p class="tl">${esc(info.tagline)}</p>` : ''}<h3>Adults only</h3>
      <p>This site may contain explicit material. Confirm that you are 18 or older (or the age of majority where you live) to continue.</p>
      <div class="row"><button class="btn primary" id="g-yes">I'm 18 or older</button><a class="btn" href="https://www.google.com">Leave</a></div></div>`;
    $('#g-yes').addEventListener('click', () => { store.set('adult-ok', true); g.hidden = true; g.innerHTML = ''; resolve(); });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  $('.skip-link')?.addEventListener('click', (event) => { event.preventDefault(); view().focus(); });
  try { info = await api('/api/public/info?bootstrap=1'); } catch (e) {
    view().innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message)}</div>`; return;
  }
  document.title = info.brand;
  document.body.dataset.theme = info.theme || 'featheral';
  $('#brand').textContent = info.brand;
  $('#tagline').textContent = info.tagline || '';
  document.querySelectorAll('[data-cms-page]').forEach((link) => {
    link.hidden = !info.pages?.some((page) => page.slug === link.dataset.cmsPage);
  });
  const settings = info.siteSettings;
  document.querySelectorAll('[data-feature]').forEach((link) => { link.hidden = !settings?.[link.dataset.feature]; });
  document.querySelectorAll('[data-media-tab]').forEach((link) => { link.hidden = settings?.homepage !== 'media'; });
  $('[data-tab="home"]').hidden = settings?.homepage === 'media';
  $('#fab').hidden = settings?.homepage !== 'media';
  $('.logo').title = info.tagline || info.brand;
  document.querySelector('meta[name=description]')?.setAttribute('content', info.tagline || info.brand);
  paintWallet();
  $('#wallet').addEventListener('click', openWalletPanel);
  if (wallet.token) refreshBalance().then((b) => { if (b == null && wallet.token) api('/api/public/wallet/me').catch(() => setWallet(null)); });
  // Switching accounts in the wallet ends the session of the account that signed in.
  window.ethereum?.on?.('accountsChanged', (accounts) => {
    if (wallet.address && (accounts?.[0] || '').toLowerCase() !== wallet.address.toLowerCase()) { setWallet(null); toast('Wallet account changed — connect again to comment'); }
  });
  await gate();
  await importLegacyVotes();
  window.addEventListener('hashchange', render);
  render();
});
