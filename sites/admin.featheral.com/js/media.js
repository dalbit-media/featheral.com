/* Media library & uploads file browser */
VIEWS.media = async (arg, q, token) => {
  setCrumbs(siteCrumb('Media'));
  const ov = state.overview[state.key];
  const qs = new URLSearchParams({ ...q, limit: q.limit || 120 });
  delete q.open; qs.delete('open');
  const data = await api(`/api/sets/${state.key}/media?${qs}`);
  const lib = data.source === 'library';
  const tile = localStorage.getItem('tileSize') || '170';
  const facetList = (obj) => (Array.isArray(obj) ? obj.map((x) => [x.k, x.n]) : Object.entries(obj || {})).filter(([k]) => k).sort((a, b) => b[0].localeCompare(a[0]));
  const months = [['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'], ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'], ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']];
  const up = ov?.stats?.uploads || {};
  setView(`
    <div class="layout-filters">
      <div class="filters">
        <div class="group"><h4>Source</h4>
          <a class="facet ${lib ? 'on' : ''}" href="${setHref('media', null, { source: 'library' })}"><span>🗂 Media library (DB)</span><span class="n">${fmtNum(ov?.counts?.attachments)}</span></a>
          <a class="facet ${!lib ? 'on' : ''}" href="${setHref('media', null, { source: 'files' })}"><span>📁 Upload files</span><span class="n">${fmtNum(up.files)}</span></a>
        </div>
        ${lib ? `
        <div class="group"><h4>Kind</h4>${facetList(data.facets.kind).map(([k, n]) => `<a class="facet ${q.kind === k ? 'on' : ''}" href="${setHref('media', null, { ...q, kind: q.kind === k ? '' : k, page: '' })}"><span>${esc(k)}</span><span class="n">${fmtNum(n)}</span></a>`).join('')}</div>
        <div class="group"><h4>Image type</h4><select data-q="format">${options((data.facets.format || []).filter((x) => x.k !== '(none)').map((x) => [x.k, `${x.k.toUpperCase()} (${fmtNum(x.n)})`]), q.format, 'All image types')}</select></div>
        <div class="group"><h4>Year uploaded</h4><select data-q="year">${options(facetList(data.facets.year).map(([k, n]) => [k, `${k} (${n})`]), q.year, 'All years')}</select></div>
        <div class="group"><h4>Month</h4><select data-q="month">${options(months, q.month, 'Any month')}</select></div>
        <div class="group"><h4>Attachment</h4><select data-q="attached">${options([['yes', 'Attached to a post'], ['no', 'Unattached']], q.attached, 'Any')}</select></div>
        <div class="group"><label class="small"><input type="checkbox" id="f-missing" ${q.missing === '1' ? 'checked' : ''}> Only missing files</label></div>
        ` : `
        <div class="group"><h4>Kind</h4><select data-q="kind">${options([['image', 'Images'], ['other', 'Other files']], q.kind, 'All files')}</select></div>
        <div class="group"><h4>Folder / year</h4><select data-q="year">${options(facetList(data.facets.year).map(([k, n]) => [k, `${k} (${n})`]), q.year, 'All folders')}</select></div>
        <div class="group"><h4>Month</h4><select data-q="month">${options(months, q.month, 'Any month')}</select></div>
        <div class="group"><h4>Extension</h4><select data-q="ext">${options(Object.entries(data.facets.ext || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, `${k} (${n})`]), q.ext, 'Any')}</select></div>
        <div class="group"><label class="small"><input type="checkbox" id="f-all" ${q.view === 'all' ? 'checked' : ''}> Include resized variants</label><br>
          ${ov?.hasDb ? `<label class="small"><input type="checkbox" id="f-orphan" ${q.orphan === '1' ? 'checked' : ''}> Only orphans (not in library)</label>` : ''}</div>
        `}
        <div class="group"><h4>Sort</h4><select data-q="sort">${options([['date', 'Newest first'], ['date_asc', 'Oldest first'], ['size', 'Largest first'], ['name', 'Name A→Z'], ['pixels', 'Most pixels']], q.sort || (lib ? 'date' : ''), lib ? undefined : 'Folder order')}</select></div>
      </div>
      <div>
        <div class="toolbar">
          <input type="search" id="search" placeholder="${lib ? 'Search title, file name, alt text, caption…' : 'Search file path…'}" value="${esc(q.q || '')}" />
          <label class="small muted nowrap">Size <input type="range" id="tile-size" min="110" max="320" step="10" value="${tile}"></label>
          <a class="btn" href="/api/sets/${state.key}/export/${lib ? 'media.csv' : 'uploads-index.csv'}">⬇ CSV</a>
          <a class="btn" href="/api/sets/${state.key}/export/media-originals.zip" title="Zip of all original images (no resized variants)">⬇ Originals .zip</a>
        </div>
        ${data.items.length ? `<div class="media-grid" id="grid" style="--tile:${tile}px">${data.items.map((m, i) => lib ? `
          <div class="tile ${m.exists ? '' : 'missing'}" data-i="${i}">
            <div class="img" ${m.thumb ? `style="background-image:url('${esc(m.thumb)}')"` : ''}>${m.thumb ? '' : m.exists ? esc((m.file || '').split('.').pop()) : 'missing'}
              ${m.parent ? '' : '<span class="badge chip">unattached</span>'}</div>
            <div class="cap"><div class="t" title="${esc(m.title)}">${esc(m.title || m.file)}</div><div class="s">${m.width ? `${m.width}×${m.height} · ` : ''}${esc(fmtDate(m.date).slice(0, 10))}</div></div>
          </div>` : `
          <div class="tile" data-i="${i}">
            <div class="img" ${m.image ? `style="background-image:url('${esc(m.url)}')"` : ''}>${m.image ? '' : esc(m.ext)}
              ${m.orphan ? '<span class="badge chip warn">orphan</span>' : m.variantOf ? '<span class="badge chip">variant</span>' : ''}</div>
            <div class="cap"><div class="t" title="${esc(m.path)}">${esc(m.path.split('/').pop())}</div><div class="s">${m.width ? `${m.width}×${m.height} · ` : ''}${fmtBytes(m.size)}${m.variants ? ` · +${m.variants} sizes` : ''}</div></div>
          </div>`).join('')}</div>` : `<div class="card">${emptyBox('🖼', 'No media matches these filters.')}</div>`}
        ${pager(data.total, data.page, data.limit)}
      </div>
    </div>`, token);
  bindSelects(); bindPager(); bindSearch($('#search'));
  const chk = (id, key, on) => { const el = $(id); if (el) el.addEventListener('change', () => patchQuery({ [key]: el.checked ? on : '' })); };
  chk('#f-missing', 'missing', '1'); chk('#f-all', 'view', 'all'); chk('#f-orphan', 'orphan', '1');
  $('#tile-size').addEventListener('input', (e) => { localStorage.setItem('tileSize', e.target.value); const g = $('#grid'); if (g) g.style.setProperty('--tile', e.target.value + 'px'); });
  $$('.tile[data-i]').forEach((t) => t.addEventListener('click', () => openLightbox(data.items, +t.dataset.i, lib)));
  const openId = new URLSearchParams(location.hash.split('?')[1] || '').get('open');
  if (openId) {
    const i = data.items.findIndex((x) => String(x.id) === openId);
    openLightbox(i >= 0 ? data.items : [{ id: +openId }], Math.max(0, i), true);
  }
};

function openLightbox(items, index, lib) {
  let i = index;
  const m = modal('', `<div class="lightbox"><div class="stage" id="lb-stage"></div><div class="side" id="lb-side"></div></div>`);
  const onKey = (e) => {
    if (!document.body.contains(m)) return document.removeEventListener('keydown', onKey);
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
  function go(d) { const n = i + d; if (n >= 0 && n < items.length) { i = n; show(); } }
  async function show() {
    let it = items[i];
    $('.modal-head h3', m).textContent = `${i + 1} / ${items.length}`;
    const nav = `${i > 0 ? '<button class="nav-btn prev" data-d="-1">‹</button>' : ''}${i < items.length - 1 ? '<button class="nav-btn next" data-d="1">›</button>' : ''}`;
    const stage = $('#lb-stage', m);
    const side = $('#lb-side', m);
    if (lib) {
      side.innerHTML = loading();
      stage.innerHTML = nav;
      try { it = await api(`/api/sets/${state.key}/media/${it.id}`); } catch (e) { side.innerHTML = errorBox(e); return; }
      if (items[i].id !== it.id) return;
      const isImg = it.kind === 'image';
      stage.innerHTML = (it.url ? (isImg ? `<img src="${esc(it.url)}" alt="${esc(it.alt)}">` : it.kind === 'video' ? `<video src="${esc(it.url)}" controls style="max-width:100%"></video>` : it.kind === 'audio' ? `<audio src="${esc(it.url)}" controls></audio>` : `<div style="color:#fff">📄 ${esc(it.file)}</div>`) : '<div style="color:#f88">File not available</div>') + nav;
      side.innerHTML = `
        <h3 style="margin-top:0">${esc(it.title || '(untitled)')}</h3>
        <div class="row" style="margin-bottom:10px">
          ${it.url ? `<a class="btn sm" href="${esc(it.url)}" target="_blank">Open original</a><a class="btn sm" href="${esc(it.url)}" download>⬇ Download</a>` : '<span class="chip bad">missing file</span>'}
          ${it.original ? `<a class="btn sm" href="${esc(it.original)}" target="_blank">Pre-scaled original</a>` : ''}
        </div>
        ${kvTable({ ID: it.id, File: it.file, Type: it.mime, Dimensions: it.width ? `${it.width} × ${it.height}` : '', 'File size': it.filesize ? fmtBytes(it.filesize) : '', Uploaded: it.date, 'Alt text': it.alt, Caption: it.caption, Description: it.description })}
        ${it.parentInfo ? `<h4>Attached to</h4><a href="${setHref('content', it.parentInfo.id)}" onclick="closeModal()">${esc(it.parentInfo.title || '#' + it.parentInfo.id)}</a> <span class="muted small">(${esc(it.parentInfo.type)})</span>` : ''}
        ${it.featuredIn.length ? `<h4>Featured image of</h4>${it.featuredIn.map((p) => `<div><a href="${setHref('content', p.ID)}" onclick="closeModal()">${esc(p.post_title || '#' + p.ID)}</a> <span class="muted small">${esc(p.post_type)}</span></div>`).join('')}` : ''}
        ${it.usedIn.length ? `<h4>Used in content</h4>${it.usedIn.map((p) => `<div><a href="${setHref('content', p.ID)}" onclick="closeModal()">${esc(p.post_title || '#' + p.ID)}</a> <span class="muted small">${esc(p.post_type)} · ${esc(p.post_status)}</span></div>`).join('')}` : ''}
        ${it.sizes.length ? `<h4>Generated sizes</h4><table class="tbl"><tbody>${it.sizes.map((s) => `<tr><td>${esc(s.name)}</td><td class="num nowrap">${s.width}×${s.height}</td><td>${s.url ? `<a href="${esc(s.url)}" target="_blank">open</a>` : '<span class="muted small">missing</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
        ${Object.keys(it.exif || {}).length ? `<h4>Photo metadata (EXIF)</h4>${kvTable(it.exif)}` : ''}`;
    } else {
      stage.innerHTML = (it.image ? `<img src="${esc(it.url)}" alt="">` : `<div style="color:#fff">📄 ${esc(it.path)}</div>`) + nav;
      side.innerHTML = `<h3 style="margin-top:0;word-break:break-all">${esc(it.path.split('/').pop())}</h3>
        <div class="row" style="margin-bottom:10px"><a class="btn sm" href="${esc(it.url)}" target="_blank">Open</a><a class="btn sm" href="${esc(it.url)}" download>⬇ Download</a></div>
        ${kvTable({ Path: 'uploads/' + it.path, Size: fmtBytes(it.size), Dimensions: it.width ? `${it.width} × ${it.height}` : '', Modified: it.mtime ? fmtDate(it.mtime) : '', 'Resized from': it.variantOf, 'Resized variants': it.variants || '', 'In media library': it.orphan === undefined ? 'n/a (no database)' : it.orphan ? 'No — orphan file' : 'Yes' })}`;
    }
    $$('[data-d]', stage).forEach((b) => b.addEventListener('click', () => go(+b.dataset.d)));
  }
  show();
}
