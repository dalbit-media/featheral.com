/* Database browser, insights, export */
VIEWS.database = async (arg, q, token) => {
  setCrumbs(siteCrumb('Database'));
  const { tables } = (state.tablesCache ||= {})[state.key] ||= await api(`/api/sets/${state.key}/tables`);
  if (!tables.length) return setView(`<div class="card">${emptyBox('🗄', 'No data synced for this site.')}</div>`, token);
  const name = arg || tables.find((t) => t.short === 'posts')?.name || tables[0].name;
  const data = await api(`/api/sets/${state.key}/tables/${encodeURIComponent(name)}?${new URLSearchParams({ ...q, limit: 50 })}`);
  const tf = (q.tf || '').toLowerCase();
  setView(`
    <div class="db-layout">
      <div class="card" style="padding:0">
        <div style="padding:10px"><input type="search" id="tf" placeholder="Filter ${tables.length} tables…" value="${esc(q.tf || '')}" style="width:100%"></div>
        <div class="table-list">${tables.map((t) => `<a href="${setHref('database', t.name, { tf: q.tf || '' })}" class="${t.name === name ? 'on' : ''}" data-tname="${esc(t.name.toLowerCase())}" ${tf && !t.name.toLowerCase().includes(tf) ? 'hidden' : ''}>
          <span class="ellipsis">${t.core ? '' : '<span class="muted">·</span> '}${esc(t.name)}</span><span class="n">${fmtNum(t.rows)}</span></a>`).join('')}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="mono">${esc(name)} <span class="muted small">${plural(data.total, 'row')} · ${plural(data.columns.length, 'column')}</span></h3>
          <button class="btn sm" id="schema">Schema</button></div>
        <div class="toolbar"><input type="search" id="search" placeholder="Search all columns…" value="${esc(q.q || '')}"></div>
        <div class="tbl-wrap db-grid"><table class="tbl"><thead><tr>${data.columns.map((c) => `<th data-sort="${esc(c)}">${esc(c)}${q.sort === c ? (q.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>
          ${data.rows.map((r, i) => `<tr>${data.columns.map((c) => r[c] === null || r[c] === undefined ? `<td class="null" data-r="${i}" data-c="${esc(c)}">NULL</td>` : `<td data-r="${i}" data-c="${esc(c)}">${esc(String(r[c]).slice(0, 200))}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        ${pager(data.total, data.page, data.limit)}
      </div>
    </div>`, token);
  bindPager(); bindSearch($('#search'));
  $('#tf').addEventListener('input', (e) => { const v = e.target.value.toLowerCase(); $$('[data-tname]').forEach((a) => { a.hidden = v && !a.dataset.tname.includes(v); }); });
  $$('[data-sort]').forEach((th) => th.addEventListener('click', () => patchQuery({ sort: th.dataset.sort, dir: q.sort === th.dataset.sort && q.dir !== 'desc' ? 'desc' : 'asc' })));
  $('#schema').addEventListener('click', () => modal('Schema · ' + esc(name), `<div class="modal-body"><pre class="code">${esc(data.schema || 'n/a')}</pre></div>`));
  $$('td[data-r]').forEach((td) => td.addEventListener('click', () => {
    const v = data.rows[+td.dataset.r][td.dataset.c];
    let pretty = v === null ? 'NULL' : String(v);
    let parsed = '';
    if (typeof v === 'string' && /^(a|O|s|i|b):\d*[:;]/.test(v)) parsed = 'PHP serialized';
    else if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { pretty = JSON.stringify(JSON.parse(v), null, 2); parsed = 'JSON'; } catch {} }
    modal(esc(td.dataset.c), `<div class="modal-body">${parsed ? `<span class="chip brand">${parsed}</span> ` : ''}<span class="muted small">${fmtNum(pretty.length)} chars</span>
      <button class="btn sm" id="cp" style="float:right">Copy</button><div class="spacer"></div><pre class="code">${esc(pretty)}</pre></div>`, { narrow: true });
    $('#cp').addEventListener('click', () => copyText(String(v ?? '')));
  }));
};

VIEWS.insights = async (arg, q, token) => {
  setCrumbs(siteCrumb('Insights'));
  const s = await api(`/api/sets/${state.key}/stats`);
  const months = [...new Set(s.timeline.map((x) => x.ym))].sort();
  const ttypes = [...new Set(s.timeline.map((x) => x.type))];
  const by = {};
  for (const x of s.timeline) (by[x.ym] ||= {})[x.type] = x.n;
  // fill gaps so the timeline is continuous
  const fullMonths = [];
  if (months.length) {
    let [y, m] = months[0].split('-').map(Number);
    const [ey, em] = months[months.length - 1].split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) { fullMonths.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  }
  const maxMonth = Math.max(1, ...fullMonths.map((ym) => Object.values(by[ym] || {}).reduce((a, b) => a + b, 0)));
  const color = (t) => PALETTE[ttypes.indexOf(t) % PALETTE.length];
  const bars = (entries) => {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.map(([k, n, href]) => `<div class="hbar">${href ? `<a class="ellipsis" href="${href}">${esc(k)}</a>` : `<span class="ellipsis">${esc(k)}</span>`}<div class="track"><i style="width:${(n / max) * 100}%"></i></div><span class="num small">${fmtNum(n)}</span></div>`).join('');
  };
  const wmax = Math.max(1, ...s.topWords.map((w) => w.n));
  const ct = s.commentsTimeline || [];
  const ctMax = Math.max(1, ...ct.map((x) => x.n));
  const md = s.media || {};
  setView(`
    <div class="stats">
      <div class="stat"><div class="l">Published documents</div><div class="v">${fmtNum(s.words?.docs)}</div></div>
      <div class="stat"><div class="l">Total words</div><div class="v">${fmtNum(s.words?.total)}</div></div>
      <div class="stat"><div class="l">Avg / median words</div><div class="v">${fmtNum(s.words?.avg)} <span class="muted small">/ ${fmtNum(s.words?.median)}</span></div></div>
      <div class="stat"><div class="l">Media items</div><div class="v">${fmtNum(md.total)}</div><div class="s">${fmtBytes(md.bytes)} on disk</div></div>
      <div class="stat"><div class="l">Alt-text coverage</div><div class="v">${md.total ? Math.round((md.withAlt / md.total) * 100) : 0}%</div><div class="s">${fmtNum(md.withAlt)} of ${fmtNum(md.total)}</div></div>
      <div class="stat"><div class="l">Missing media files</div><div class="v">${fmtNum(md.missing)}</div>${md.missing ? `<div class="s"><a href="${setHref('media', null, { missing: 1 })}">review</a></div>` : ''}</div>
    </div>
    <div class="spacer"></div>
    <div class="card"><div class="card-head"><h3>📅 Publishing timeline</h3><span class="muted small">${fullMonths.length ? `${fullMonths[0]} → ${fullMonths[fullMonths.length - 1]}` : ''}</span></div>
      ${fullMonths.length ? `<div class="chart">${fullMonths.map((ym) => `<a class="col" href="${setHref('content', null, { year: ym.slice(0, 4) })}" title="${ym}: ${Object.entries(by[ym] || {}).map(([t, n]) => `${t} ${n}`).join(', ') || '0'}">
        ${ttypes.map((t) => by[ym]?.[t] ? `<i style="height:${(by[ym][t] / maxMonth) * 170}px;background:${color(t)}"></i>` : '').join('')}</a>`).join('')}</div>
        <div class="chart-labels"><span>${fullMonths[0]}</span><span>${fullMonths[fullMonths.length >> 1]}</span><span>${fullMonths[fullMonths.length - 1]}</span></div>
        <div class="legend">${ttypes.map((t) => `<span style="--c:${color(t)}">${esc(t)}</span>`).join('')}</div>` : emptyBox('📅', 'No published content')}
    </div>
    <div class="spacer"></div>
    <div class="grid g2">
      <div class="card"><h3>📏 Content length distribution</h3>${s.words ? bars(s.words.histogram.map((h) => [h.label + ' words', h.n])) : ''}
        ${s.words?.longest ? `<div class="small muted" style="margin-top:10px">Longest: <a href="${setHref('content', s.words.longest.id)}">${esc(s.words.longest.title)}</a> (${fmtNum(s.words.longest.words)} words)</div>` : ''}</div>
      <div class="card"><h3>☁ Top words</h3><div class="cloud">${s.topWords.map((w) => `<a href="${setHref('content', null, { q: w.w })}" style="font-size:${12 + (w.n / wmax) * 20}px;opacity:${0.55 + (w.n / wmax) * 0.45}">${esc(w.w)}</a>`).join('') || '<span class="muted">No text</span>'}</div></div>
      <div class="card"><h3>🏷 Top terms</h3>${bars(s.topTerms.map((t) => [`${t.name} · ${t.taxonomy}`, t.count, setHref('content', null, { term: t.id })]))}</div>
      <div class="card"><h3>✍ Authors</h3>${bars(s.authors.map((a) => [a.name, a.n, setHref('content', null, { author: a.id })]))}</div>
      <div class="card"><h3>🖼 Media by year</h3>${bars(Object.entries(md.byYear || {}).filter(([k]) => k).sort().map(([k, n]) => [k, n, setHref('media', null, { year: k })]))}</div>
      <div class="card"><h3>🧾 Media types</h3>${bars(Object.entries(md.byMime || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k || 'unknown', n]))}
        ${Object.keys(md.cameras || {}).length ? `<h4 style="margin-top:14px">📷 Cameras (EXIF)</h4>${bars(Object.entries(md.cameras).sort((a, b) => b[1] - a[1]))}` : ''}</div>
    </div>
    ${ct.length ? `<div class="spacer"></div><div class="card"><h3>💬 Approved comments over time</h3><div class="chart" style="height:120px">${ct.map((x) => `<div class="col" title="${x.ym}: ${x.n}"><i style="height:${(x.n / ctMax) * 110}px;background:${PALETTE[1]}"></i></div>`).join('')}</div>
      <div class="chart-labels"><span>${ct[0].ym}</span><span>${ct[ct.length - 1].ym}</span></div></div>` : ''}
  `, token);
};

VIEWS.export = async (arg, q, token) => {
  setCrumbs(siteCrumb('Export'));
  const types = (typesCache[state.key] ||= await api(`/api/sets/${state.key}/types`)).filter((t) => !t.internal);
  const ex = (name, extra = {}) => `/api/sets/${state.key}/export/${name}` + (Object.keys(extra).length ? '?' + new URLSearchParams(extra) : '');
  const card = (icon, title, fmt, desc, links) => `<div class="card export-card"><h3>${icon} ${title}</h3><span class="fmt">${fmt}</span><p>${desc}</p><div class="row">${links}</div></div>`;
  setView(`
    <div class="card"><div class="row">
      <b>Content filter for post exports:</b>
      <select id="x-type"><option value="">All public types (${types.map((t) => esc(t.type)).join(', ')})</option>${types.map((t) => `<option value="${esc(t.type)}">${esc(t.type)} (${t.n})</option>`).join('')}</select>
      <select id="x-status">${options([['publish', 'Published only'], ['publish,private', 'Published + private'], ['publish,draft,pending,future,private', 'Everything except trash'], ['all', 'All synced statuses (including trash)']], 'publish')}</select>
    </div></div>
    <div class="spacer"></div>
    <div class="grid g3" id="exports">
      ${card('📄', 'All post text', 'TXT · ZIP', 'Full titles, excerpts and body text without HTML, with post details. Download every synced content item in one UTF-8 text file or as individual text files. Includes drafts, private posts and trash; excludes internal types such as media and revisions.', `<a class="btn primary" href="${ex('posts.txt', { status: 'all' })}">⬇ All text</a><a class="btn" href="${ex('posts-text.zip', { status: 'all' })}">⬇ All text ZIP</a><a class="btn" data-px href="${ex('posts.txt')}">⬇ Filtered text</a><a class="btn" data-px href="${ex('posts-text.zip')}">⬇ Filtered ZIP</a>`)}
      ${card('🤖', 'AI / NLP corpus', 'JSONL', 'One JSON object per line with title, clean plain text, markdown, taxonomies, featured image & referenced media. Ideal for embeddings, fine-tuning and content regeneration.', `<a class="btn primary" data-px href="${ex('corpus.jsonl')}">⬇ corpus.jsonl</a>`)}
      ${card('📝', 'Markdown files', 'ZIP', 'Every post as a .md file with YAML front-matter, organized by post type. Image links point to the downloaded uploads.', `<a class="btn" data-px href="${ex('posts-markdown.zip')}">⬇ posts-markdown.zip</a>`)}
      ${card('📊', 'Posts table', 'CSV · JSON', 'Spreadsheet-friendly metadata with word counts, terms, featured image and plain text — for data studies in Excel, pandas or R.', `<a class="btn" data-px href="${ex('posts.csv')}">⬇ CSV</a><a class="btn" data-px href="${ex('posts.json')}">⬇ JSON</a>`)}
      ${card('🖼', 'Original photos', 'ZIP', 'All downloaded originals organized by year/month, without WordPress resized copies. Use "with variants" to include every downloaded file.', `<a class="btn" href="${ex('media-originals.zip')}">⬇ Originals</a><a class="btn" href="${ex('media-originals.zip', { all: 1 })}">⬇ With variants</a>`)}
      ${card('🗂', 'Media catalogue', 'CSV · JSON', 'Media library records: title, alt text, caption, dimensions, EXIF, attached post and local file path.', `<a class="btn" href="${ex('media.csv')}">⬇ CSV</a><a class="btn" href="${ex('media.json')}">⬇ JSON</a><a class="btn" href="${ex('uploads-index.csv')}">⬇ File index</a>`)}
      ${card('🏷', 'Taxonomies & menus', 'JSON', 'Categories, tags and custom taxonomies with hierarchy and counts, plus navigation menu structures.', `<a class="btn" href="${ex('taxonomies.json')}">⬇ Taxonomies</a><a class="btn" href="${ex('menus.json')}">⬇ Menus</a>`)}
      ${card('💬', 'Comments', 'CSV', 'All comments with author, date, status and the post they belong to.', `<a class="btn" href="${ex('comments.csv')}">⬇ comments.csv</a>`)}
      ${card('👤', 'Users', 'CSV', 'User accounts with roles and post counts (password hashes excluded).', `<a class="btn" href="${ex('users.csv')}">⬇ users.csv</a>`)}
      ${card('📈', 'Statistics', 'JSON', 'Timeline, word frequencies, length histogram, media and taxonomy stats used by the Insights page.', `<a class="btn" href="${ex('stats.json')}">⬇ stats.json</a>`)}
    </div>
    <div class="spacer"></div>
    <div class="note small">Downloaded media is also available directly on disk in <code>data/${esc(state.key)}/uploads/</code> inside the app folder.</div>`, token);
  const upd = () => {
    const extra = { type: $('#x-type').value, status: $('#x-status').value };
    $$('[data-px]').forEach((a) => { const u = new URL(a.href); u.search = new URLSearchParams(Object.entries(extra).filter(([, v]) => v)).toString(); a.href = u.toString(); });
  };
  $('#x-type').addEventListener('change', upd); $('#x-status').addEventListener('change', upd);
  upd();
};
