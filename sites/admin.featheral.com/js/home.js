/* Home: connect to a WordPress site via REST API, library of synced sites; Sync progress */
const COMP_ICON = { db: '🗄', uploads: '🖼', plugins: '🧩', themes: '🎨', others: '📦', 'mu-plugins': '🔌', wpcore: '⚙', more: '➕' };

VIEWS.home = async (q, token) => {
  $('#view').dataset.view = 'home';
  setCrumbs('<b>Sites</b> <span class="muted">· connect to WordPress via the REST API</span>');
  const saved = JSON.parse(localStorage.getItem('lastConn') || '{}');
  const url = q.url || saved.url || '';
  const user = q.user ?? saved.user ?? '';
  const media = saved.media || 'originals';
  setView(`
    <div class="hero">
      <h1>Connect to a WordPress site</h1>
      <p>Sync posts, pages, custom types, taxonomies, comments, users and the full media library through the
        <b>WordPress REST API</b>, then bulk-download the <b>original</b> uploaded media for data studies and content regeneration.
        Public content works without credentials; add an <a href="https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/" target="_blank" rel="noopener">Application Password</a>
        to include drafts, private items, raw editor content, menus, plugins &amp; themes.</p>
      <form id="conn-form" class="conn-form" autocomplete="off">
        <label class="f-url"><span>Site URL</span><input id="c-url" type="text" placeholder="https://example.com" value="${esc(url)}" spellcheck="false" required></label>
        <label><span>Username <i class="muted">(optional)</i></span><input id="c-user" type="text" value="${esc(user)}" spellcheck="false" autocomplete="off"></label>
        <label><span>Application password <i class="muted">(optional, never stored)</i></span><input id="c-pass" type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" autocomplete="new-password"></label>
        <div class="f-media"><span>Media download</span>
          <div class="seg">
            ${[['originals', '🖼 Originals only'], ['all', '🗂 Originals + all sizes'], ['none', '🚫 Metadata only']].map(([v, l]) => `<label><input type="radio" name="c-media" value="${v}" ${media === v ? 'checked' : ''}><b>${l}</b></label>`).join('')}
          </div>
        </div>
        <label><span>Max items per type <i class="muted">(0 = everything)</i></span><input id="c-limit" type="number" min="0" step="10" value="${esc(saved.limit ?? 0)}"></label>
        <label><span>Parallel downloads</span><input id="c-conc" type="number" min="1" max="12" value="${esc(saved.concurrency ?? 4)}"></label>
        <div class="f-actions">
          <button type="button" class="btn" id="c-test">🔌 Test connection</button>
          <button type="submit" class="btn primary" id="c-sync">⬇ Sync &amp; download</button>
        </div>
      </form>
    </div>
    <div id="conn-result"></div>
    <div class="card" id="library"><div class="card-head"><h2>Synced sites</h2></div>${loading()}</div>
  `, token);
  const form = $('#conn-form');
  const values = () => ({
    url: $('#c-url').value.trim(), username: $('#c-user').value.trim(), appPassword: $('#c-pass').value,
    media: (form.querySelector('[name=c-media]:checked') || {}).value || 'originals',
    limit: Math.max(0, +$('#c-limit').value || 0), concurrency: Math.min(12, Math.max(1, +$('#c-conc').value || 4)),
  });
  const remember = (v) => localStorage.setItem('lastConn', JSON.stringify({ url: v.url, user: v.username, media: v.media, limit: v.limit, concurrency: v.concurrency }));
  $('#c-test').addEventListener('click', async () => {
    const v = values();
    if (!v.url) return $('#c-url').focus();
    remember(v);
    testConnection(v);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = values();
    if (!v.url) return;
    if (v.username && !v.appPassword && !confirm('A username is set but no application password — sync public content only?')) return;
    remember(v);
    const btn = $('#c-sync');
    btn.disabled = true;
    try {
      await api('/api/sync', { json: v });
      location.hash = '#/import';
    } catch (err) { btn.disabled = false; toast(err.message); }
  });
  renderLibrary();
  if (q.url) $('#c-pass').focus();
};

async function testConnection(v) {
  const box = $('#conn-result');
  box.innerHTML = `<div class="card">${loading('Connecting to ' + v.url + '…')}</div>`;
  try {
    const r = await api('/api/connect', { json: { url: v.url, username: v.username, appPassword: v.appPassword } });
    const total = (slug) => (r.counts.find((c) => c.slug === slug) || {}).n;
    const media = total('attachment');
    const sum = r.counts.filter((c) => !['attachment', 'comment', 'user'].includes(c.slug)).reduce((a, c) => a + (c.n || 0), 0);
    const reqs = r.counts.reduce((a, c) => a + Math.ceil((v.limit ? Math.min(c.n || 0, v.limit) : c.n || 0) / 100), 0);
    box.innerHTML = `<div class="card conn-card">
      <div class="card-head"><div class="row">
          ${r.siteIcon ? `<img class="site-icon" src="${esc(r.siteIcon)}" alt="">` : '<div class="site-icon ph">W</div>'}
          <div><h2>✅ ${esc(r.name || r.siteUrl)}</h2><div class="muted small">${esc(r.description || '')}</div></div></div>
        <div class="right">${r.authenticated ? `<span class="chip ok">🔐 ${esc(r.user.name)} · ${esc(r.user.roles.join(', ') || 'no role')}</span>` : '<span class="chip">🌐 public access</span>'}</div></div>
      ${r.warnings.length ? `<div class="note small">${r.warnings.map(esc).join('<br>')}</div><div class="spacer"></div>` : ''}
      <div class="kv-grid small">
        <div><span class="muted">REST root</span><code>${esc(r.apiRoot)}</code></div>
        <div><span class="muted">Home</span><a href="${esc(r.home || r.siteUrl)}" target="_blank" rel="noopener">${esc(r.home || r.siteUrl)}</a></div>
        <div><span class="muted">Timezone</span>${esc(r.timezone || '—')}</div>
        <div><span class="muted">Namespaces</span>${r.namespaces.length} <span class="muted">(${esc(r.namespaces.slice(0, 6).join(', '))}${r.namespaces.length > 6 ? '…' : ''})</span></div>
      </div>
      <div class="spacer"></div>
      <div class="count-grid">${r.counts.map((c) => `<div class="count-tile ${c.n === null ? 'dim' : ''}"><b>${c.n === null ? '🔒' : fmtNum(c.n)}</b><span>${esc(c.name)}</span>${c.error ? `<i class="muted small">${esc(c.error)}</i>` : ''}</div>`).join('')}</div>
      <div class="spacer"></div>
      <div class="row small muted">
        <span>≈ ${fmtNum(sum)} content items · ${fmtNum(media || 0)} media files${v.limit ? ` (capped at ${fmtNum(v.limit)} per type)` : ''} · ≈ ${fmtNum(reqs)} API pages</span>
        <span class="grow"></span>
        ${r.existing ? `<span>Last synced ${esc(fmtDate(r.existing.syncedAt))}</span> <a class="btn sm" href="${hrefFor(['set', r.key, 'overview'])}">Open</a>` : ''}
        <button class="btn primary sm" id="c-sync2">⬇ Sync now</button>
      </div></div>`;
    $('#c-sync2', box).addEventListener('click', () => $('#conn-form').requestSubmit());
  } catch (e) {
    box.innerHTML = `<div class="card">${errorBox(e)}
      <div class="note small" style="margin-top:10px">Tips: check the URL, make sure the REST API isn't blocked by a security plugin or firewall,
      and for authentication create an Application Password under <b>Users → Profile</b> (requires HTTPS).</div></div>`;
  }
}

async function renderLibrary() {
  const lib = await loadLibrary();
  renderSidebar('home');
  const box = $('#library');
  if (!box) return;
  const contentCount = (m) => Object.entries(m.stats?.counts || {}).filter(([k]) => !['attachment', 'comments', 'users', 'terms'].includes(k)).reduce((a, [, n]) => a + n, 0);
  box.innerHTML = `<div class="card-head"><h2>Synced sites</h2><span class="muted small">${plural(lib.length, 'site')}</span></div>` + (lib.length
    ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Site</th><th>Last synced</th><th class="num">Content</th><th class="num">Media items</th><th class="num">Downloaded</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>
      ${lib.map((m) => `<tr>
        <td><b>${esc(m.site)}</b><div class="muted small mono">${esc(m.siteUrl || '')}</div></td>
        <td class="nowrap">${esc(fmtDate(m.syncedAt))}${m.limit ? ` <span class="chip warn" title="Partial sync">≤ ${fmtNum(m.limit)}/type</span>` : ''}</td>
        <td class="num">${fmtNum(contentCount(m))}</td>
        <td class="num">${fmtNum(m.stats?.counts?.attachment || 0)}</td>
        <td class="num">${fmtNum(m.stats?.uploads?.files || 0)} <div class="muted small">${fmtBytes(m.stats?.uploads?.size || 0)}</div></td>
        <td>${m.authenticated ? `<span class="chip ok">🔐 ${esc(m.username)}</span>` : '<span class="chip">🌐 public</span>'}</td>
        <td>${m.status === 'ready' ? '<span class="chip ok">ready</span>' : `<span class="chip warn">${esc(m.status)}</span>`}${m.warnings?.length ? ` <span class="chip warn" title="${esc(m.warnings.join('\n'))}">⚠ ${m.warnings.length}</span>` : ''}</td>
        <td class="right nowrap">${m.status === 'ready' ? `<a class="btn sm primary" href="${hrefFor(['set', m.key, 'overview'])}">Open</a>` : ''}
          <a class="btn sm" href="${hrefFor([], { url: m.siteUrl, user: m.username || '' })}" title="Pre-fill the form to sync again (already-downloaded files are skipped)">↻ Re-sync</a>
          <button class="btn sm danger" data-del="${esc(m.key)}" title="Delete local data and downloaded media">Delete</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : emptyBox('🌐', 'No sites synced yet. Enter a WordPress site URL above to get started.'));
  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete the local copy of this site, including all downloaded media? The live site is not touched.')) return;
    await api(`/api/sets/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
    delete state.overview[b.dataset.del];
    toast('Local data deleted');
    renderLibrary();
  }));
}

VIEWS.import = async (q, token) => {
  $('#view').dataset.view = 'import';
  setCrumbs('<a href="#/"><b>Sites</b></a> <span class="muted">› Sync</span>');
  setView(`<div class="card" id="job">${loading()}</div>`, token);
  const tick = async () => {
    if (token !== state.seq) return;
    let job;
    try { job = await api('/api/job'); } catch (e) { if (token === state.seq) $('#job').innerHTML = errorBox(e); return; }
    if (token !== state.seq) return;
    if (!job) { $('#job').innerHTML = emptyBox('💤', 'No sync running. <a href="#/">Go back</a>'); return; }
    const icon = { pending: '·', running: '<span class="spinner" style="margin:0;width:14px;height:14px"></span>', done: '✓', skipped: '–' };
    const title = job.state === 'done' ? (job.cancelled ? '⏹ Sync stopped (partial)' : '✅ Sync complete') : job.state === 'error' ? '❌ Sync failed' : 'Syncing…';
    $('#job').innerHTML = `
      <div class="card-head"><div><h2>${title} — ${esc(job.site)}</h2>
        <div class="muted small">Site key <code>${esc(job.key)}</code>${job.resuming ? ' · resuming saved API pages' : ''} · started ${esc(fmtDate(job.startedAt))}${job.finishedAt ? ' · finished ' + esc(fmtDate(job.finishedAt)) : ''}</div></div>
        <div class="row">${job.state === 'running' ? `<button class="btn danger" id="job-cancel" ${job.cancelled ? 'disabled' : ''}>⏹ ${job.cancelled ? 'Stopping…' : 'Stop'}</button>` : ''}
        ${job.state === 'done' ? `<a class="btn primary" href="${hrefFor(['set', job.key, 'overview'])}">Open explorer →</a>` : ''}
        ${job.state === 'error' ? '<a class="btn" href="#/">← Back</a>' : ''}</div></div>
      ${job.error ? errorBox(job.error) + '<div class="spacer"></div>' : ''}
      <div class="steps">${job.steps.map((s) => `<div class="step ${s.status}">
        <div class="dot">${icon[s.status] || '·'}</div>
        <div><b>${esc(s.label)}</b> <span class="muted small">${s.status === 'skipped' ? '(skipped)' : esc(s.detail || '')}</span>
          ${s.status === 'running' ? `<div class="bar"><i style="width:${Math.round((s.progress || 0) * 100)}%"></i></div>` : ''}</div></div>`).join('')}</div>
      ${job.warnings?.length ? `<div class="spacer"></div><div class="note small"><b>Warnings</b><br>${job.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="spacer"></div><h4>Log</h4><div class="logbox">${esc(job.log.join('\n'))}</div>`;
    const lb = $('.logbox');
    if (lb) lb.scrollTop = lb.scrollHeight;
    const cb = $('#job-cancel');
    if (cb) cb.addEventListener('click', async () => { cb.disabled = true; await api('/api/job/cancel', { method: 'POST' }); });
    if (job.state === 'running') setTimeout(tick, 700);
    else if (job.state === 'done') { delete state.overview[job.key]; await loadLibrary(); if (token === state.seq) renderSidebar('import'); }
  };
  tick();
};
