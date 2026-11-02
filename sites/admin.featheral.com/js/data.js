/* Taxonomies, menus, comments, users, add-ons */
VIEWS.taxonomies = async (arg, q, token) => {
  setCrumbs(siteCrumb('Taxonomies'));
  const list = await api(`/api/sets/${state.key}/taxonomies`);
  if (!list.length) return setView(`<div class="card">${emptyBox('🏷', 'No taxonomies synced.')}</div>`, token);
  const cur = list.find((t) => t.taxonomy === q.tax) || list.find((t) => t.taxonomy === 'category') || list[0];
  const kids = new Map();
  for (const t of cur.terms) { const p = t.parent || 0; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t); }
  const ids = new Set(cur.terms.map((t) => t.term_id));
  const roots = cur.terms.filter((t) => !t.parent || !ids.has(t.parent));
  const filter = (q.q || '').toLowerCase();
  const node = (t) => `<li><a href="${setHref('content', null, { term: t.id })}" title="Show content with this term"><b>${esc(t.name)}</b></a>
    <span class="chip">${fmtNum(t.count)}</span> <span class="muted small mono">${esc(t.slug)}</span>${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
    ${kids.has(t.term_id) ? `<ul>${kids.get(t.term_id).map(node).join('')}</ul>` : ''}</li>`;
  const max = Math.max(1, ...cur.terms.map((t) => t.count || 0));
  const shown = filter ? cur.terms.filter((t) => t.name.toLowerCase().includes(filter) || t.slug.includes(filter)) : null;
  setView(`
    <div class="tabs">${list.map((t) => `<a href="${setHref('taxonomies', null, { tax: t.taxonomy })}" class="${t === cur ? 'on' : ''}"><button class="${t === cur ? 'on' : ''}">${esc(t.taxonomy)}<span class="n">${fmtNum(t.count)}</span></button></a>`).join('')}</div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>${esc(cur.taxonomy)} <span class="muted small">${plural(cur.count, 'term')} · ${fmtNum(cur.totalUsage)} assignments ${cur.hierarchical ? '· hierarchical' : ''}</span></h3></div>
        <div class="toolbar"><input type="search" id="search" placeholder="Filter terms…" value="${esc(q.q || '')}"></div>
        <div class="tree">${shown ? `<ul>${shown.map((t) => `<li><a href="${setHref('content', null, { term: t.id })}"><b>${esc(t.name)}</b></a> <span class="chip">${fmtNum(t.count)}</span></li>`).join('') || '<li class="muted">No match</li>'}</ul>` : `<ul>${roots.map(node).join('')}</ul>`}</div>
      </div>
      <div class="card"><div class="card-head"><h3>Most used</h3></div>
        ${[...cur.terms].sort((a, b) => b.count - a.count).slice(0, 25).map((t) => `<div class="hbar"><a class="ellipsis" href="${setHref('content', null, { term: t.id })}">${esc(t.name)}</a><div class="track"><i style="width:${(t.count / max) * 100}%"></i></div><span class="num small">${fmtNum(t.count)}</span></div>`).join('')}
      </div>
    </div>`, token);
  bindSearch($('#search'));
};

VIEWS.menus = async (arg, q, token) => {
  setCrumbs(siteCrumb('Menus'));
  const menus = await api(`/api/sets/${state.key}/menus`);
  if (!menus.length) return setView(`<div class="card">${emptyBox('☰', 'No navigation menus found.')}</div>`, token);
  const tree = (items, parent) => {
    const level = items.filter((i) => i.parent === parent);
    if (!level.length) return '';
    return `<ul>${level.map((i) => `<li>${i.objectId && i.type === 'post_type' ? `<a href="${setHref('content', i.objectId)}">${esc(i.title)}</a>` : i.type === 'taxonomy' ? `<a href="${setHref('content', null, { term: i.objectId })}">${esc(i.title)}</a>` : `<b>${esc(i.title)}</b>`}
      <span class="chip">${esc(i.object || i.type || 'link')}</span>${i.url ? ` <span class="muted small mono">${esc(i.url)}</span>` : ''}${tree(items, i.id)}</li>`).join('')}</ul>`;
  };
  setView(`<div class="grid g2">${menus.map((m) => `<div class="card"><div class="card-head"><h3>☰ ${esc(m.name)}</h3><span class="muted small">${plural(m.items.length, 'item')}</span></div>
    <div class="tree">${tree(m.items, 0) || '<div class="muted small">Empty menu</div>'}</div></div>`).join('')}</div>`, token);
};

VIEWS.comments = async (arg, q, token) => {
  setCrumbs(siteCrumb('Comments'));
  const data = await api(`/api/sets/${state.key}/comments?${new URLSearchParams(q)}`);
  const stLabel = { 1: 'approved', 0: 'pending', spam: 'spam', trash: 'trash', 'post-trashed': 'post trashed' };
  setView(`
    <div class="layout-filters">
      <div class="filters">
        <div class="group"><h4>Status</h4><a class="facet ${!q.status ? 'on' : ''}" href="${setHref('comments', null, { ...q, status: '', page: '' })}"><span>All</span><span class="n">${fmtNum(data.facets?.status.reduce((a, s) => a + s.n, 0))}</span></a>
          ${(data.facets?.status || []).map((s) => `<a class="facet ${q.status === String(s.k) ? 'on' : ''}" href="${setHref('comments', null, { ...q, status: s.k, page: '' })}"><span>${esc(stLabel[s.k] || s.k)}</span><span class="n">${fmtNum(s.n)}</span></a>`).join('')}</div>
        <div class="group"><h4>Type</h4><select data-q="type">${options((data.facets?.type || []).map((t) => [t.k, `${t.k} (${t.n})`]), q.type, 'Any type')}</select></div>
      </div>
      <div>
        <div class="toolbar"><input type="search" id="search" placeholder="Search comment text or author…" value="${esc(q.q || '')}">
          <a class="btn" href="/api/sets/${state.key}/export/comments.csv">⬇ CSV</a></div>
        <div class="card list-card">${data.items.length ? data.items.map((c) => `<div class="comment" style="margin:0;border-radius:0;border-width:0 0 1px">
          <div class="row"><b>${esc(c.author || 'Anonymous')}</b> <span class="muted small">${esc(fmtDate(c.date))}</span>
            <span class="chip ${String(c.approved) === '1' ? 'ok' : c.approved === 'spam' ? 'bad' : 'warn'}">${esc(stLabel[c.approved] || c.approved)}</span>
            ${c.type !== 'comment' ? `<span class="chip">${esc(c.type)}</span>` : ''}<span class="grow"></span>
            <span class="small">on <a href="${setHref('content', c.postId)}">${esc(c.postTitle || '#' + c.postId)}</a></span></div>
          <div style="margin-top:4px;white-space:pre-wrap">${esc(c.content)}</div></div>`).join('') : emptyBox('💬', 'No comments match.')}</div>
        ${pager(data.total, data.page, data.limit)}
      </div>
    </div>`, token);
  bindSelects(); bindPager(); bindSearch($('#search'));
};

VIEWS.users = async (arg, q, token) => {
  setCrumbs(siteCrumb('Users'));
  const users = await api(`/api/sets/${state.key}/users`);
  setView(`<div class="card"><div class="card-head"><h3>👤 ${plural(users.length, 'user')}</h3><span class="row"><span class="muted small">Password hashes are never shown.</span><a class="btn sm" href="/api/sets/${state.key}/export/users.csv">⬇ CSV</a></span></div>
    ${users.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Login</th><th>Display name</th><th>Email</th><th>Roles</th><th>Registered</th><th class="num">Published</th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${u.ID}</td><td class="mono">${esc(u.user_login)}</td><td><b>${esc(u.display_name)}</b>${u.first_name || u.last_name ? `<div class="muted small">${esc([u.first_name, u.last_name].filter(Boolean).join(' '))}</div>` : ''}</td>
      <td>${esc(u.user_email)}</td><td><div class="chips">${(u.roles || []).map((r) => `<span class="chip ${r === 'administrator' ? 'brand' : ''}">${esc(r)}</span>`).join('')}</div></td>
      <td class="nowrap">${esc(fmtDate(u.user_registered))}</td><td class="num">${u.posts ? `<a href="${setHref('content', null, { author: u.ID })}">${fmtNum(u.posts)}</a>` : 0}</td></tr>`).join('')}</tbody></table></div>` : emptyBox('👤', 'No users synced.')}</div>`, token);
};

VIEWS.addons = async (arg, q, token) => {
  setCrumbs(siteCrumb('Plugins & themes'));
  const a = await api(`/api/sets/${state.key}/addons`);
  const ov = state.overview[state.key] || {};
  const needAuth = ov.authenticated ? '' : isLocal() ? '<div class="note small">Plugins and themes were not included in the stored data.</div>' : `<div class="note small">Plugins and themes are only exposed to authenticated users. <a href="${hrefFor([], { url: ov.siteUrl, user: ov.username || '' })}">Re-sync with an Application Password</a> (administrator) to list them.</div>`;
  setView(`
    <h2>🎨 Themes <span class="muted small">${a.themes.length}</span></h2>
    ${a.themes.length ? `<div class="grid g3">${[...a.themes].sort((x, y) => (y.active - x.active)).map((t) => `<div class="card">
      <div class="theme-shot" ${t.screenshotUrl ? `style="background-image:url('${esc(t.screenshotUrl)}')"` : ''}></div>
      <div class="row"><b class="grow">${esc(t.name)}</b>${t.active ? '<span class="chip ok">active</span>' : ''}${t.parentActive ? '<span class="chip brand">parent theme</span>' : ''}${t.blockTheme ? '<span class="chip">block theme</span>' : ''}</div>
      <div class="muted small">${t.version ? 'v' + esc(t.version) : ''} ${t.author ? '· by ' + esc(t.author) : ''} ${t.template && t.template !== t.slug ? '· child of ' + esc(t.template) : ''}</div>
      ${t.description ? `<p class="small">${esc(t.description).slice(0, 220)}</p>` : ''}
      <div class="muted small mono">${esc(t.slug)}${t.requiresPhp ? ' · PHP ' + esc(t.requiresPhp) + '+' : ''}</div>
    </div>`).join('')}</div>` : `<div class="card">${emptyBox('🎨', 'No themes synced.')}${needAuth}</div>`}
    <div class="spacer"></div>
    <h2>🧩 Plugins <span class="muted small">${a.plugins.length} · ${a.plugins.filter((p) => p.active).length} active</span></h2>
    ${a.plugins.length ? `<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Plugin</th><th>Version</th><th>Author</th><th>Requires</th><th>Slug</th></tr></thead><tbody>
      ${[...a.plugins].sort((x, y) => (y.active - x.active) || x.name.localeCompare(y.name)).map((p) => `<tr><td><b>${p.uri ? `<a href="${esc(p.uri)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</b> ${p.active ? `<span class="chip ok">${esc(p.status || 'active')}</span>` : '<span class="chip">inactive</span>'}
        ${p.description ? `<div class="muted small">${esc(p.description).slice(0, 180)}</div>` : ''}</td><td>${esc(p.version || '')}</td><td>${esc(p.author || '')}</td>
        <td class="small nowrap">${p.requires ? 'WP ' + esc(p.requires) : ''}${p.requiresPhp ? ' · PHP ' + esc(p.requiresPhp) : ''}</td>
        <td class="mono small">${esc(p.slug || '')}</td></tr>`).join('')}</tbody></table></div></div>` : `<div class="card">${emptyBox('🧩', 'No plugins synced.')}${needAuth}</div>`}
  `, token);
};

VIEWS.trash = async (arg, q, token) => {
  setCrumbs(siteCrumb('Trash'));
  const t = await api(`/api/sets/${state.key}/trash?${new URLSearchParams({ page: q.page || 1, limit: 100 })}`);
  if (state.overview[state.key]?.trashed !== t.total) { await ensureOverview(state.key, true); renderSidebar('trash'); }
  setView(`<div class="card"><div class="card-head"><h3>🗑 ${plural(t.total, 'post')} in trash</h3>
      <span class="row"><span class="muted small">${plural(t.files, 'file')} · ${fmtBytes(t.bytes)}</span>
      <button class="btn sm" id="dedupe">Remove duplicates…</button>
      <button class="btn sm danger" id="empty-trash" ${t.total ? '' : 'disabled'}>Delete permanently</button></span></div>
    <div class="note small">Posts disliked on the <a href="/">public site</a> land here with their media, and so do duplicates removed with <b>Remove duplicates</b>
      (posts whose media is the same file or an identical copy; the first published post of each group is kept). They are hidden everywhere already;
      files still used by a kept post are left in place. <b>Delete permanently</b> removes the posts, their attachment rows and their files from the stored data.</div>
    ${t.items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Title</th><th>Deck</th><th>Deleted</th><th class="num">Files</th><th class="num">Size</th><th></th></tr></thead><tbody>
      ${t.items.map((x) => `<tr><td>${x.id}</td><td><b>${esc(x.title || '(untitled)')}</b>${x.shared ? `<div class="muted small">${plural(x.shared, 'shared file')} kept</div>` : ''}</td>
        <td class="nowrap">${x.dupOf ? `Duplicate of #${x.dupOf}` : `${esc((x.type || '').toUpperCase())} · round ${fmtNum(x.round)}`}</td><td class="nowrap">${esc(fmtDate(new Date(x.at).toISOString()))}</td>
        <td class="num">${fmtNum(x.files)}</td><td class="num">${fmtBytes(x.bytes)}</td>
        <td><button class="btn sm" data-restore="${x.id}">Restore</button></td></tr>`).join('')}</tbody></table></div>${pager(t.total, t.page, t.limit)}`
      : emptyBox('🗑', 'The trash is empty.')}</div>`, token);
  bindPager();
  $$('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/sets/${state.key}/trash/${b.dataset.restore}/restore`, { method: 'POST' }); toast('Restored'); render(); } catch (e) { toast(e.message); b.disabled = false; }
  }));
  $('#dedupe')?.addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true; b.textContent = 'Comparing media…';
    try {
      const d = await api(`/api/sets/${state.key}/duplicates`);
      if (!d.posts) { toast('No duplicate posts found'); return; }
      if (!confirm(`${plural(d.posts, 'post')} share their media with an earlier post (${plural(d.groups, 'group')}).\n\nKeep the first published post of each group and move the other ${fmtNum(d.posts)} to the trash?`)) return;
      b.textContent = 'Moving to trash…';
      const r = await api(`/api/sets/${state.key}/duplicates`, { method: 'POST' });
      toast(`Moved ${plural(r.trashed, 'duplicate post')} to the trash`);
      await ensureOverview(state.key, true);
      render();
    } catch (err) { toast(err.message); } finally { b.disabled = false; b.textContent = 'Remove duplicates…'; }
  });
  $('#empty-trash')?.addEventListener('click', async (e) => {
    if (!confirm(`Permanently delete ${plural(t.total, 'post')} and ${plural(t.files, 'file')} (${fmtBytes(t.bytes)})? This cannot be undone.`)) return;
    e.target.disabled = true; e.target.textContent = 'Deleting…';
    try {
      const r = await api(`/api/sets/${state.key}/trash/empty`, { method: 'POST' });
      toast(`Deleted ${plural(r.posts, 'post')} and ${plural(r.files, 'file')}`);
      await ensureOverview(state.key, true);
      render();
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'Delete permanently'; }
  });
};
