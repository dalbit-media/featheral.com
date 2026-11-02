/* Overview, content list & post detail */
VIEWS.overview = async (arg, q, token) => {
  const ov = await ensureOverview(state.key, true);
  renderSidebar('overview');
  setCrumbs(siteCrumb('Overview'));
  const o = ov.options || {};
  const typeTotals = {};
  for (const t of ov.contentTypes || []) {
    const x = (typeTotals[t.type] ||= { type: t.type, total: 0, statuses: {} });
    x.total += t.n; x.statuses[t.status] = t.n;
  }
  const types = Object.values(typeTotals).sort((a, b) => b.total - a.total);
  const up = ov.stats?.uploads || {};
  const published = (t) => typeTotals[t]?.statuses.publish || 0;
  const stat = (v, l, s, href) => `<${href ? `a href="${href}"` : 'div'} class="stat"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</${href ? 'a' : 'div'}>`;
  const dl = ov.download || {};
  const resyncHref = hrefFor([], { url: ov.siteUrl, user: ov.username || '' });
  setView(`
    <div class="card" style="background:linear-gradient(135deg,#fff,#f4f3ff)">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <h1 style="margin-bottom:4px">${esc(ov.managed ? ov.site : isLocal() ? state.config.brand : o.blogname || ov.site)}</h1>
          ${isLocal() ? `<div class="muted" style="font-size:15px">Local software running on stored data${o.blogname || ov.site ? ` · originally ${esc(o.blogname || ov.site)}` : ''}</div>` : o.blogdescription ? `<div class="muted" style="font-size:15px">${esc(o.blogdescription)}</div>` : ''}
          <div class="chips" style="margin-top:10px">
            ${o.home && !isLocal() ? `<a class="chip" href="${esc(o.home)}" target="_blank" rel="noopener">🌐 ${esc(o.home)} ↗</a>` : ''}
            ${o.stylesheet ? `<span class="chip">🎨 ${esc(o.current_theme || o.stylesheet)}</span>` : ''}
            ${o.timezone_string ? `<span class="chip">🕒 ${esc(o.timezone_string)}</span>` : ''}
            ${isLocal() ? '<span class="chip ok">💾 local data</span>' : ov.authenticated ? `<span class="chip ok">🔐 synced as ${esc(ov.username)}</span>` : '<span class="chip">🌐 public content only</span>'}
            ${ov.manifestLimit ? `<span class="chip warn">partial: ≤ ${fmtNum(ov.manifestLimit)} per type</span>` : ''}
            ${ov.warnings.length ? `<span class="chip warn" title="${esc(ov.warnings.join('\n'))}">⚠ ${plural(ov.warnings.length, 'warning')}</span>` : ''}
          </div>
        </div>
        <div class="right small muted">${isLocal() ? `Data as of ${esc(fmtDate(ov.syncedAt))}` : `Synced ${esc(fmtDate(ov.syncedAt))}<br><span class="mono">${esc(ov.apiRoot || '')}</span><br>
          <a class="btn sm primary" style="margin-top:8px" href="${resyncHref}">↻ Re-sync</a>`}</div>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="stats">
      ${stat(fmtNum(published('post')), 'Published posts', `${fmtNum(typeTotals.post?.total || 0)} ${isLocal() ? 'stored' : 'synced'}`, setHref('content', null, { type: 'post' }))}
      ${stat(fmtNum(published('page')), 'Pages', `${fmtNum(typeTotals.page?.total || 0)} ${isLocal() ? 'stored' : 'synced'}`, setHref('content', null, { type: 'page' }))}
      ${stat(fmtNum(ov.counts?.attachments ?? 0), 'Media items', 'library metadata', setHref('media'))}
      ${stat(fmtNum(up.files || 0), 'Downloaded files', fmtBytes(up.size || 0), setHref('media', null, { source: 'files' }))}
      ${stat(fmtNum(ov.counts?.comments), 'Comments', '', setHref('comments'))}
      ${stat(fmtNum(ov.counts?.users), 'Users', '', setHref('users'))}
      ${stat(fmtNum(ov.counts?.tables), 'Local tables', `${fmtNum(ov.db?.rows)} rows`, setHref('database'))}
      ${ov.authenticated ? stat(fmtNum(ov.addons?.plugins), 'Plugins', `${fmtNum((ov.activePlugins || []).length)} active`, setHref('addons')) : ''}
    </div>
    <div class="spacer"></div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>⬇ Media download</h3><a class="small" href="${setHref('media')}">Media library →</a></div>
        ${kvTable({
          'Mode': { originals: 'Originals only (pre-scaling uploads)', all: 'Originals + all generated sizes', none: 'Metadata only — images load from the live site' }[ov.mediaMode] || ov.mediaMode,
          'Files queued': dl.total !== undefined ? fmtNum(dl.total) : '—',
          'Downloaded': dl.total !== undefined ? `${fmtNum(dl.downloaded)} new · ${fmtNum(dl.skipped)} already present` : '—',
          'Failed': dl.failed ? `${fmtNum(dl.failed)} (see warnings)` : dl.total !== undefined ? '0' : '—',
          'On disk': `${fmtNum(up.files || 0)} files · ${fmtBytes(up.size || 0)}`,
          'Local folder': ov.localDir ? ov.localDir + (ov.localDir.includes('\\') ? '\\uploads' : '/uploads') : '',
          'Live uploads URL': isLocal() ? '' : ov.uploadsBase || '',
        })}
        <div class="spacer"></div>
        <div class="row"><a class="btn sm" href="/api/sets/${encodeURIComponent(state.key)}/export/media-originals.zip">🗜 Download originals .zip</a>
          <a class="btn sm" href="/api/sets/${encodeURIComponent(state.key)}/export/media.csv">📄 Media metadata .csv</a>
          ${!isLocal() && (ov.mediaMode === 'none' || dl.failed) ? `<a class="btn sm" href="${resyncHref}">⬇ Download missing</a>` : ''}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>🗂 Content types</h3><a class="small" href="${setHref('content')}">Browse content →</a></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Post type</th><th>Statuses</th><th class="num">Total</th></tr></thead><tbody>
        ${types.map((t) => `<tr><td>${HIDDEN_TYPES.includes(t.type) ? `<span class="muted">${esc(t.type)}</span>` : `<a href="${t.type === 'attachment' ? setHref('media') : setHref('content', null, { type: t.type })}">${TYPE_ICON[t.type] || '•'} <b>${esc(t.type)}</b></a>`}</td>
          <td><div class="chips">${Object.entries(t.statuses).map(([s, n]) => `<span class="chip">${esc(s)} <span class="n">${fmtNum(n)}</span></span>`).join('')}</div></td>
          <td class="num">${fmtNum(t.total)}</td></tr>`).join('') || `<tr><td colspan="3">${emptyBox('🗂', 'No content synced.')}</td></tr>`}</tbody></table></div>
      </div>
    </div>
    <div class="spacer"></div><div class="grid g2">
      <div class="card"><div class="card-head"><h3>⚙ Site settings</h3><a class="small" href="${setHref('database', (ov.db?.prefix || 'wp_') + 'options')}">All options →</a></div>
        ${kvTable({
          'Site URL': o.siteurl, 'Home URL': o.home, 'Admin email': o.admin_email, 'Theme': o.stylesheet && o.stylesheet !== o.template ? `${o.stylesheet} (child of ${o.template})` : o.stylesheet,
          'Timezone': o.timezone_string || (o.gmt_offset !== undefined && o.gmt_offset !== '' ? 'UTC' + (o.gmt_offset >= 0 ? '+' : '') + o.gmt_offset : ''),
          'Language': o.WPLANG, 'Front page': o.show_on_front ? (o.show_on_front === 'page' ? `static page #${o.page_on_front}` : 'latest posts') : '', 'Posts per page': o.posts_per_page,
          'Date format': o.date_format, 'Default comments': o.default_comment_status,
        })}
        ${!ov.authenticated && !isLocal() ? '<div class="note small" style="margin-top:10px">Some settings, drafts, menus, plugins and themes are only available when syncing with an Application Password.</div>' : ''}</div>
      <div class="card"><div class="card-head"><h3>🔗 ${isLocal() ? 'Data source' : 'Sync details'}</h3></div>
        ${kvTable(ov.backupInfo || {})}
        ${ov.warnings.length ? `<div class="spacer"></div><h4>Warnings</h4><div class="note small">${ov.warnings.map(esc).join('<br>')}</div>` : ''}
        ${(ov.taxonomies || []).length ? `<div class="spacer"></div><h4>Taxonomies</h4><div class="chips">${ov.taxonomies.map((t) => `<a class="chip" href="${setHref('taxonomies', null, { tax: t.taxonomy })}">${esc(t.taxonomy)} <span class="n">${fmtNum(t.n)}</span></a>`).join('')}</div>` : ''}
        ${(ov.activePlugins || []).length ? `<div class="spacer"></div><h4>Active plugins</h4><div class="chips">${ov.activePlugins.map((p) => `<span class="chip">${esc(String(p).split('/')[0])}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <section class="card"><h2>Traffic overview</h2><p class="muted small">Aggregate page views · UTC · no visitor identities</p><div id="overview-traffic"></div></section>
  `, token);
  if (token === state.seq) {
    const address = new URL(ov.siteUrl);
    await window.FeatheralTraffic.load($('#overview-traffic'), '/api/telemetry/report', address.hostname + address.pathname.replace(/\/$/, ''));
  }
};

let typesCache = {};
VIEWS.content = async (arg, q, token) => {
  if (arg) return VIEWS.post(arg, q, token);
  setCrumbs(siteCrumb('Content'));
  const types = typesCache[state.key] ||= await api(`/api/sets/${state.key}/types`);
  const qs = new URLSearchParams({ ...q, limit: 25 }).toString();
  const data = await api(`/api/sets/${state.key}/posts?${qs}`);
  const visible = types.filter((t) => !t.internal);
  const internal = types.filter((t) => t.internal && t.type !== 'attachment');
  const facet = (t) => `<a class="facet ${q.type === t.type ? 'on' : ''}" href="${setHref('content', null, { ...q, type: t.type, page: '' })}"><span>${TYPE_ICON[t.type] || '•'} ${esc(t.type)}</span><span class="n">${fmtNum(t.n)}</span></a>`;
  const years = [...new Set((await statsTimeline()).map((x) => x.ym.slice(0, 4)))].sort().reverse();
  setView(`
    <div class="layout-filters">
      <div class="filters">
        <div class="group"><h4>Post type</h4>
          <a class="facet ${!q.type ? 'on' : ''}" href="${setHref('content', null, { ...q, type: '', page: '' })}"><span>✱ All content</span><span class="n">${fmtNum(visible.reduce((a, t) => a + t.n, 0))}</span></a>
          ${visible.map(facet).join('')}
          ${internal.length ? `<details style="margin-top:6px"><summary class="small muted">System types (${internal.length})</summary>${internal.map(facet).join('')}</details>` : ''}
        </div>
        <div class="group"><h4>Status</h4><select data-q="status">${options([['publish', 'Published'], ['draft', 'Draft'], ['pending', 'Pending'], ['future', 'Scheduled'], ['private', 'Private'], ['trash', 'Trash'], ['inherit', 'Inherit (revisions)']], q.status, 'Any status')}</select></div>
        <div class="group"><h4>Year</h4><select data-q="year">${options(years, q.year, 'All years')}</select></div>
        <div class="group"><h4>Browse groups</h4><select id="post-group-by">${options([['words', 'Text length'], ['photo_size', 'Photo file size'], ['photo_pixels', 'Photo resolution'], ['video_size', 'Video file size'], ['video_pixels', 'Video resolution']], data.groupBy)}</select>
          <a class="facet ${!q.group ? 'on' : ''}" href="${setHref('content', null, { ...q, group: '', page: '' })}"><span>All groups</span><span class="n">${fmtNum(data.groups.reduce((sum, group) => sum + group.count, 0))}</span></a>
          ${data.groups.map((group) => `<a class="facet ${q.group === group.id ? 'on' : ''}" href="${setHref('content', null, { ...q, group_by: data.groupBy, group: group.id, page: '' })}"><span>${esc(group.label)}</span><span class="n">${fmtNum(group.count)}</span></a>`).join('')}
        </div>
        <div class="group"><h4>Image type</h4><select data-q="image_type">${options((data.imageTypes || []).map((t) => [t.id, `${t.id.toUpperCase()} (${fmtNum(t.count)})`]), q.image_type, 'All image types')}</select></div>
        <div class="group"><h4>Sort</h4><select data-q="sort">${options([['date', 'Newest first'], ['date_asc', 'Oldest first'], ['modified', 'Recently modified'], ['title', 'Title A→Z'], ['comments', 'Most comments'], ['length', 'Longest text'], ['length_asc', 'Shortest text'], ['words', 'Most words'], ['words_asc', 'Fewest words'], ['photo_size', 'Largest photo file'], ['photo_size_asc', 'Smallest photo file'], ['photo_pixels', 'Highest photo resolution'], ['photo_pixels_asc', 'Lowest photo resolution'], ['video_size', 'Largest video file'], ['video_size_asc', 'Smallest video file'], ['video_pixels', 'Highest video resolution'], ['video_pixels_asc', 'Lowest video resolution']], q.sort || 'date')}</select>
          <p class="small muted">Media sorting uses the largest associated item per post. Unknown sizes appear last.</p>
        </div>
      </div>
      <div>
        <div class="toolbar">
          <input type="search" id="search" placeholder="Search titles and content…" value="${esc(q.q || '')}" />
          ${q.term ? `<span class="chip brand">🏷 term #${esc(q.term)} <a href="${setHref('content', null, { ...q, term: '' })}">✕</a></span>` : ''}
          ${q.author ? `<span class="chip brand">👤 author #${esc(q.author)} <a href="${setHref('content', null, { ...q, author: '' })}">✕</a></span>` : ''}
          <a class="btn" href="/api/sets/${state.key}/export/posts.csv?${new URLSearchParams({ type: q.type || '', status: q.status || 'publish', group_by: data.groupBy, group: q.group || '', image_type: q.image_type || '' })}">⬇ CSV</a>
        </div>
        <div class="card list-card">${data.items.length ? data.items.map((p) => `
          <a class="post-item" href="${setHref('content', p.id)}">
            <div class="thumb" ${p.thumb?.thumb ? `style="background-image:url('${esc(p.thumb.thumb)}')"` : ''}>${p.thumb?.thumb ? '' : TYPE_ICON[p.type] || '📄'}</div>
            <div style="min-width:0">
              <div class="t">${esc(p.title || '(no title)')}</div>
              <div class="m"><span>${TYPE_ICON[p.type] || ''} ${esc(p.type)}</span><span class="status-${esc(p.status)}">● ${esc(p.status)}</span><span>📅 ${esc(fmtDate(p.date))}</span>
                <span>👤 ${esc(p.author)}</span>${p.comments ? `<span>💬 ${p.comments}</span>` : ''}<span>${fmtNum(p.wordCount)} words · ${fmtNum(p.textLength)} characters</span>
                ${p.photoSize !== null ? `<span>🖼 ${fmtBytes(p.photoSize)}</span>` : ''}${p.photoPixels !== null ? `<span>🖼 ${fmtNum(p.photoPixels / 1e6)} MP</span>` : ''}
                ${p.videoSize !== null ? `<span>🎬 ${fmtBytes(p.videoSize)}</span>` : ''}${p.videoPixels !== null ? `<span>🎬 ${fmtNum(p.videoPixels / 1e6)} MP</span>` : ''}<span class="mono">#${p.id}</span></div>
              <div class="x">${esc(p.excerpt)}</div>
              ${Object.keys(p.terms).length ? `<div class="chips" style="margin-top:6px">${Object.entries(p.terms).flatMap(([tax, ts]) => ts.map((t) => `<span class="chip ${tax === 'category' ? 'brand' : ''}">${tax === 'post_tag' ? '#' : ''}${esc(t.name)}</span>`)).join('')}</div>` : ''}
            </div>
          </a>`).join('') : emptyBox('🔍', 'No content matches these filters.')}</div>
        ${pager(data.total, data.page, data.limit)}
      </div>
    </div>`, token);
  bindSelects();
  $('#post-group-by').addEventListener('change', (event) => patchQuery({ group_by: event.target.value, group: '', page: '' }));
  bindPager();
  bindSearch($('#search'));
};

async function statsTimeline() {
  try { return (state.statsCache ||= {})[state.key] ||= (await api(`/api/sets/${state.key}/stats`)).timeline || []; } catch { return []; }
}

VIEWS.post = async (id, q, token) => {
  const p = await api(`/api/sets/${state.key}/posts/${id}`);
  setCrumbs(siteCrumb(`<a href="${setHref('content', null, { type: p.type })}">${esc(p.type)}</a>`, `<b>${esc(p.title || '(no title)')}</b>`),
    `<a class="btn sm" href="${setHref('content')}">← Back</a>`);
  const tab = q.tab || 'preview';
  const publicMeta = p.meta.filter((m) => !m.private);
  const tabs = [['preview', 'Preview'], ['text', 'Plain text'], ['markdown', 'Markdown'], ['html', 'HTML source'], ['media', 'Media', p.contentMedia.length + p.attachments.length],
    ['meta', 'Custom fields', p.meta.length], ['comments', 'Comments', p.comments.length], ['revisions', 'Revisions', p.revisions.length], ['fields', 'All fields']];
  const body = {
    preview: () => `<iframe class="preview" sandbox="allow-same-origin" id="pv"></iframe>`,
    text: () => `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn sm" data-copy="text">Copy text</button></div><pre class="text">${esc(p.text || '(empty)')}</pre>`,
    markdown: () => `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn sm" data-copy="markdown">Copy Markdown</button></div><pre class="code">${esc(p.markdown || '(empty)')}</pre>`,
    html: () => `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn sm" data-copy="raw">Copy HTML</button></div><pre class="code">${esc(p.raw || '(empty)')}</pre>`,
    media: () => {
      const tiles = (list) => `<div class="thumb-row">${list.map((m) => `<a href="${m.id ? setHref('media', null, { open: m.id }) : esc(m.url || '#')}" title="${esc(m.title || m.file)}" ${m.id ? '' : 'target="_blank"'}>${m.thumb ? `<img src="${esc(m.thumb)}" loading="lazy" alt="">` : '<span class="muted small" style="display:grid;place-items:center;height:100%">missing</span>'}</a>`).join('')}</div>`;
      return `<h4>Images used in the content (${p.contentMedia.length})</h4>${p.contentMedia.length ? tiles(p.contentMedia) : '<div class="muted small">None</div>'}
        <div class="spacer"></div><h4>Attached media (${p.attachments.length})</h4>${p.attachments.length ? tiles(p.attachments) : '<div class="muted small">None</div>'}`;
    },
    meta: () => p.meta.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${p.meta.map((m) => `<tr><td class="mono nowrap">${esc(m.key)} ${m.private ? '<span class="chip">internal</span>' : ''}</td>
      <td>${typeof m.value === 'object' && m.value !== null ? `<pre class="json">${esc(JSON.stringify(m.value, null, 2))}</pre>` : `<span class="mono small">${esc(String(m.value ?? '').slice(0, 2000))}</span>`}</td></tr>`).join('')}</tbody></table></div>` : emptyBox('🗒', 'No custom fields'),
    comments: () => p.comments.length ? p.comments.map((c) => `<div class="comment ${c.parent ? 'reply' : ''}"><b>${esc(c.author)}</b> <span class="muted small">${esc(fmtDate(c.date))} ${c.approved !== '1' ? `· <span class="chip warn">${esc(c.approved)}</span>` : ''}</span><div>${esc(c.content)}</div></div>`).join('') : emptyBox('💬', 'No comments'),
    revisions: () => p.revisions.length ? `<div class="tbl-wrap"><table class="tbl clickable"><thead><tr><th>Revision</th><th>Saved</th><th class="num">Length</th></tr></thead><tbody>${p.revisions.map((r) => `<tr onclick="location.hash='${setHref('content', r.ID)}'"><td>#${r.ID}</td><td>${esc(fmtDate(r.post_modified))}</td><td class="num">${fmtNum(r.len)} chars</td></tr>`).join('')}</tbody></table></div>` : emptyBox('🕘', 'No revisions stored'),
    fields: () => kvTable(p.fields),
  };
  setView(`
    <div class="post-layout">
      <div class="card">
        <h1>${esc(p.title || '(no title)')}</h1>
        <div class="muted small" style="margin-bottom:14px">${statusChip(p.status)} ${esc(p.type)} · 📅 ${esc(fmtDate(p.date))} · 👤 ${esc(p.author)} · ${fmtNum(p.wordCount)} words · ~${p.readingMinutes} min read</div>
        <div class="tabs">${tabs.map(([k, l, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
        <div id="tab-body">${body[tab] ? body[tab]() : ''}</div>
      </div>
      <div>
        ${p.featured ? `<div class="card"><h4>Featured image</h4><a href="${setHref('media', null, { open: p.featured.id })}"><img class="featured" src="${esc(p.featured.thumb || p.featured.url || '')}" alt=""></a><div class="small muted">${esc(p.featured.title)}</div></div>` : ''}
        <div class="card"><h4>Details</h4>${kvTable({ ID: p.id, Slug: p.slug, Type: p.type, Status: p.status, Published: p.date, Modified: p.modified, Author: p.author, Words: p.wordCount, Characters: p.charCount, GUID: p.guid })}
          ${p.parent ? `<div class="small" style="margin-top:8px">Parent: <a href="${setHref('content', p.parent.id)}">${esc(p.parent.title)}</a></div>` : ''}
          ${p.children.length ? `<div class="small" style="margin-top:8px">Children: ${p.children.map((c) => `<a href="${setHref('content', c.ID)}">${esc(c.post_title || '#' + c.ID)}</a>`).join(', ')}</div>` : ''}
        </div>
        ${Object.keys(p.terms).length ? `<div class="card"><h4>Taxonomies</h4>${Object.entries(p.terms).map(([tax, ts]) => `<div class="small muted" style="margin-top:6px">${esc(tax)}</div><div class="chips">${ts.map((t) => `<a class="chip" href="${setHref('content', null, { term: t.id })}">${esc(t.name)}</a>`).join('')}</div>`).join('')}</div>` : ''}
        ${p.blocks.length ? `<div class="card"><h4>Gutenberg blocks</h4><div class="chips">${p.blocks.map((b) => `<span class="chip">${esc(b)}</span>`).join('')}</div></div>` : ''}
        ${publicMeta.length ? `<div class="card"><h4>Public custom fields</h4>${kvTable(Object.fromEntries(publicMeta.map((m) => [m.key, m.value])))}</div>` : ''}
      </div>
    </div>`, token);
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => patchQuery({ tab: b.dataset.tab }, true)));
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(p[b.dataset.copy] || '')));
  const pv = $('#pv');
  if (pv) {
    pv.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      body{font:17px/1.7 Georgia,serif;color:#222;max-width:760px;margin:24px auto;padding:0 20px}
      img{max-width:100%;height:auto;border-radius:6px} figure{margin:1.5em 0} figcaption{font-size:13px;color:#666;text-align:center}
      h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25} blockquote{border-left:3px solid #ccc;margin:0;padding-left:16px;color:#555}
      pre{background:#f5f5f5;padding:12px;overflow:auto} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:6px}
      .wp-block-columns{display:flex;gap:20px;flex-wrap:wrap}.wp-block-column{flex:1;min-width:200px}
      .wp-block-gallery,.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
      .wp-block-button__link{display:inline-block;background:#4f46e5;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none}
    </style></head><body><h1>${esc(p.title)}</h1>${p.rendered}</body></html>`;
    pv.addEventListener('load', () => { try { pv.style.height = Math.max(480, pv.contentDocument.body.scrollHeight + 60) + 'px'; } catch {} });
  }
};
