/* CMS-managed posts, pages and public appearance. */
const cmsFor = (key) => (resource, opts) => api(`/api/sets/${encodeURIComponent(key)}/cms/${resource}`, opts);
const cmsApi = (resource, opts) => cmsFor(state.key)(resource, opts);

VIEWS['note-markets'] = (_arg, q, token) => VIEWS.notes(q, token);

VIEWS['cms-content'] = async (arg, q, token) => {
  const cmsApi = cmsFor(state.key);
  setCrumbs(siteCrumb('CMS content'));
  if (arg === 'new' || arg) {
    const editing = arg !== 'new';
    const post = editing ? await cmsApi(`content/${encodeURIComponent(arg)}`) : {
      type: 'post', status: 'draft', title: '', slug: '', excerpt: '', body: '',
    };
    setView(`<div class="card">
      <div class="card-head"><div><h1>${editing ? 'Edit content' : 'New content'}</h1><div class="muted small">CMS content is stored separately from the imported WordPress data.</div></div></div>
      <form id="cms-form" class="form-grid">
        <div class="editor-status" id="editor-status" role="status">${editing ? `Saved · revision ${post.revision}` : 'New unsaved content'}</div>
        <label>Title<input name="title" type="text" maxlength="300" required value="${esc(post.title)}"></label>
        <div class="grid g2">
          <label>Type<select name="type">${options([['post', 'Post'], ['page', 'Page']], post.type)}</select></label>
          <label>Status<select name="status">${options([['draft', 'Draft'], ['publish', 'Published']], post.status)}</select></label>
        </div>
        <label>Slug<input name="slug" type="text" maxlength="180" value="${esc(post.slug)}"><span class="muted small">Leave blank to create a slug from the title.</span></label>
        <label>Excerpt<textarea name="excerpt" rows="3" maxlength="5000">${esc(post.excerpt)}</textarea></label>
        <label>Content<textarea name="body" rows="16" maxlength="1000000">${esc(post.body)}</textarea><span id="word-count" class="muted small"></span></label>
        <div class="row editor-actions"><button class="btn primary" type="submit">Save changes</button>
          <button class="btn" type="button" id="editor-preview">Preview text</button>
          ${editing ? `<a class="btn" id="view-published" ${post.status === 'publish' ? '' : 'hidden'} href="${publicPreview(state.key, post.type === 'page' ? `#/page/${encodeURIComponent(post.slug)}` : `#/read/${-post.id}`)}" target="_blank" rel="noopener">View published</a>` : ''}
          <a class="btn" href="${setHref('cms-content')}">Cancel</a>
          ${editing ? '<button class="btn" id="cms-duplicate" type="button">Duplicate as draft</button><button class="btn" id="cms-history" type="button">Revision history</button>' : ''}
          ${editing ? '<button class="btn danger" id="cms-delete" type="button">Delete</button>' : ''}
        </div>
      </form>
    </div>`, token);
    const form = $('#cms-form');
    let saved = JSON.stringify(Object.fromEntries(new FormData(form)));
    let revision = post.revision;
    const dirty = () => JSON.stringify(Object.fromEntries(new FormData(form))) !== saved;
    const update = () => {
      $('#editor-status').textContent = dirty() ? 'Unsaved changes' : editing ? `Saved · revision ${revision}` : 'New unsaved content';
      const words = form.elements.body.value.trim().split(/\s+/).filter(Boolean).length;
      $('#word-count').textContent = `${fmtNum(words)} words · ${Math.max(1, Math.ceil(words / 230))} min read · Ctrl/Cmd+S to save`;
    };
    form.addEventListener('input', update);
    leaveView = () => {
      if (saving) { toast('Wait for saving to finish before leaving.'); return false; }
      return !dirty() || confirm('Discard unsaved content changes?');
    };
    const beforeUnload = (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
    const shortcut = (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); form.requestSubmit(); } };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('keydown', shortcut);
    viewCleanup = () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('keydown', shortcut); };
    $('#editor-preview').addEventListener('click', () => modal('Text preview (not published)',
      `<article class="cms-preview"><h1>${esc(form.elements.title.value)}</h1><p class="muted">${esc(form.elements.excerpt.value)}</p>${form.elements.body.value.split(/\n\s*\n|\n/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}</article>`));
    update();
    let saving = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      const values = Object.fromEntries(new FormData(form));
      if (editing) values.revision = revision;
      const submitted = JSON.stringify(Object.fromEntries(new FormData(form)));
      const button = form.querySelector('button[type=submit]');
      saving = true; button.disabled = true; form.inert = true; $('#editor-status').textContent = 'Saving…';
      try {
        const result = await cmsApi(editing ? `content/${encodeURIComponent(arg)}` : 'content', {
          method: editing ? 'PUT' : 'POST', json: values,
        });
        saved = submitted; revision = result.revision;
        if (editing) {
          const link = $('#view-published');
          link.hidden = result.status !== 'publish';
          link.href = publicPreview(state.key, result.type === 'page' ? `#/page/${encodeURIComponent(result.slug)}` : `#/read/${-result.id}`);
        }
        toast(values.status === 'publish' ? 'Content published' : 'Draft saved');
        if (!editing && !dirty()) location.hash = setHref('cms-content', result.id);
        update();
      } catch (error) { $('#editor-status').textContent = error.message; toast(error.message); }
      finally { saving = false; form.inert = false; button.disabled = false; }
    });
    $('#cms-duplicate')?.addEventListener('click', async () => {
      if (saving) return;
      saving = true; form.inert = true;
      try {
        const result = await cmsApi(`content/${arg}/duplicate`, { json: {} });
        saving = false;
        toast('Draft copy created'); location.hash = setHref('cms-content', result.id);
      } catch (error) { toast(error.message); }
      finally { saving = false; form.inert = false; }
    });
    $('#cms-history')?.addEventListener('click', async () => {
      try {
        const revisions = await cmsApi(`content/${arg}/revisions`);
        if (token !== state.seq) return;
        const box = modal('Revision history', `<p class="muted">Restoring creates a new revision. The latest 20 saved versions are retained.</p>${revisions.length ? revisions.map((r) => `<div class="card"><b>${esc(r.snapshot.title)}</b><p>${esc(fmtDate(r.at))} · ${esc(r.snapshot.status)}</p><button class="btn" data-restore="${r.id}">Restore this version</button></div>`).join('') : '<p>No earlier saved versions yet.</p>'}`);
        $$('[data-restore]', box).forEach((button) => button.addEventListener('click', async () => {
          if (!confirm('Restore this saved version? Unsaved edits will be discarded.')) return;
          button.disabled = true;
          try {
            await cmsApi(`content/${arg}/restore`, { json: { revisionId: Number(button.dataset.restore), revision } });
            saved = JSON.stringify(Object.fromEntries(new FormData(form)));
            closeModal(); await render();
          } catch (error) { toast(error.message); button.disabled = false; }
        }));
      } catch (error) { toast(error.message); }
    });
    $('#cms-delete')?.addEventListener('click', async () => {
      if (!confirm(`Delete “${post.title}”?`)) return;
      try {
        await cmsApi(`content/${encodeURIComponent(arg)}`, { method: 'DELETE' });
        saved = JSON.stringify(Object.fromEntries(new FormData(form)));
        toast('Content deleted');
        location.hash = setHref('cms-content');
      } catch (error) { toast(error.message); }
    });
    return;
  }

  const all = await cmsApi('content?summary=1');
  const items = all.filter((item) => (!q.status || item.status === q.status) && (!q.type || item.type === q.type) &&
    (!q.q || `${item.title} ${item.slug} ${item.excerpt}`.toLowerCase().includes(q.q.toLowerCase())));
  const requestedPage = Number(q.page);
  const page = Math.max(1, Math.min(Math.ceil(items.length / 20) || 1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const shown = items.slice((page - 1) * 20, page * 20);
  setView(`<div class="card">
    <div class="card-head"><div><h1>CMS content</h1><div class="muted small">Create and publish posts and pages on the public site's Read section.</div></div>
      <a class="btn primary" href="${setHref('cms-content', 'new')}">＋ New content</a></div>
    <div class="row" style="margin-bottom:12px"><input id="cms-search" type="search" placeholder="Search title, slug or excerpt…" value="${esc(q.q || '')}">
      <select data-q="status" aria-label="Content status">${options([['', 'All statuses'], ['draft', 'Drafts'], ['publish', 'Published']], q.status)}</select>
      <select data-q="type" aria-label="Content type">${options([['', 'All types'], ['post', 'Posts'], ['page', 'Pages']], q.type)}</select>
      <span class="muted">${all.filter((p) => p.status === 'draft').length} drafts · ${all.filter((p) => p.status === 'publish').length} published</span></div>
    ${items.length ? `<div class="tbl-wrap"><table class="tbl clickable"><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      ${shown.map((item) => `<tr><td><a href="${setHref('cms-content', item.id)}"><b>${esc(item.title)}</b></a><div class="muted small">${esc(item.slug)}</div></td><td>${esc(item.type)}</td><td>${statusChip(item.status)}</td><td>${esc(fmtDate(item.updatedAt))}</td></tr>`).join('')}
    </tbody></table></div>` : emptyBox('✍', 'No CMS content yet. Create a post or page to get started.') }
    ${pager(items.length, page, 20)}
  </div>`, token);
  bindSearch($('#cms-search'));
  bindSelects(); bindPager();
};

VIEWS.appearance = async (arg, q, token) => {
  setCrumbs(siteCrumb('Public themes'));
  const { theme, themes } = await cmsApi('theme');
  const site = state.overview[state.key];
  const publicHost = site?.hostname || state.config.publicHost || 'x.featheral.com';
  const publicHref = publicPreview();
  const descriptions = {
    featheral: ['Featheral', 'The original dark media look with pink accents.'],
    editorial: ['Editorial', 'Warm paper colors and a compact, classic reading style.'],
    ocean: ['Ocean', 'Deep blue panels with bright teal accents.'],
    journal: ['Journal', 'Monochrome editorial typography and fresh lime details.'],
    studio: ['Studio', 'Expressive violet accents and oversized portfolio headlines.'],
    launch: ['Launch', 'Clean blue SaaS styling and soft product cards.'],
    boutique: ['Boutique', 'Warm minimal retail styling with terracotta accents.'],
    terminal: ['Terminal', 'Dark trading workspace with vivid mint highlights.'],
  };
  setView(`<div class="card">
    <div class="card-head"><div><h1>Public site themes</h1><div class="muted small">Choose the visual style used by ${esc(publicHost)}.</div></div>
      <a class="btn" href="${esc(publicHref)}" target="_blank" rel="noopener">Open public site ↗</a></div>
    <div class="grid g3">${themes.map((id) => {
      const [name, description] = descriptions[id] || [id, ''];
      return `<button type="button" class="card theme-choice ${theme === id ? 'selected' : ''}" data-theme="${esc(id)}" aria-pressed="${theme === id}">
        <span class="theme-swatch ${esc(id)}"></span><b>${esc(name)}</b><span class="muted small">${esc(description)}</span>
        <span class="chip ${theme === id ? 'ok' : ''}">${theme === id ? 'Currently active' : 'Use this theme'}</span>
      </button>`;
    }).join('')}</div>
  </div>`, token);
  $$('[data-theme]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await cmsApi('theme', { method: 'PUT', json: { theme: button.dataset.theme } });
      toast('Public theme updated');
      await VIEWS.appearance(arg, q, token);
    } catch (error) { toast(error.message); }
  }));
};

VIEWS['site-settings'] = async (arg, q, token) => {
    setCrumbs(siteCrumb('Site features'));
    const settings = await cmsApi('settings');
    setView(`<div class="card"><h1>Site features</h1>
      <p class="muted">Native assets, shopping and swaps are local simulations. No real funds, blockchain settlement, shipping or Layer 3 deployment.</p>
      <form id="features-form" class="form-grid">
        <label>Public display name<input name="displayName" maxlength="200" value="${esc(settings.displayName)}" placeholder="Use the site hostname"></label>
        <label>Site description<input name="description" maxlength="500" value="${esc(settings.description)}" placeholder="A short introduction used in the header and page metadata"></label>
        <label>Footer text<input name="footer" maxlength="500" value="${esc(settings.footer)}"></label>
        <label>Homepage<select name="homepage">${options([['media', 'Media swipe'], ['content', 'CMS landing'], ['shop', 'Shop demo'], ['exchange', 'Exchange demo']], settings.homepage)}</select></label>
        <label>Homepage page slug<input name="homeSlug" value="${esc(settings.homeSlug)}" required></label>
        <label>Native demo currency<select name="nativeCurrency">${options([['FTHX', 'FTHX (Featheral X)'], ['FTH$', 'FTH$ (exchange base)']], settings.nativeCurrency)}</select></label>
        <label><input name="commerce" type="checkbox" ${settings.commerce ? 'checked' : ''}> Enable FTHX-credit ecommerce demo</label>
        <label><input name="exchange" type="checkbox" ${settings.exchange ? 'checked' : ''}> Enable FTH$-based exchange demo</label>
        <label><input name="stats" type="checkbox" ${settings.stats ? 'checked' : ''}> Show public ecosystem traffic charts on CMS homepage</label>
        <label><input name="weeklyTrash" type="checkbox" ${settings.weeklyTrash ? 'checked' : ''}> Permanently empty all trash once a week (cannot be undone; shared media and the active homepage remain protected)</label>
        <label>Age gate<select name="ageGate">${options([['default', 'Server default'], ['true', 'Adults only'], ['false', 'No age gate']], settings.ageGate === null ? 'default' : String(settings.ageGate))}</select></label>
        <button class="btn primary" type="submit">Save features</button>
      </form></div>`, token);
    $('#features-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      values.commerce = form.elements.commerce.checked; values.exchange = form.elements.exchange.checked;
      values.stats = form.elements.stats.checked;
      values.weeklyTrash = form.elements.weeklyTrash.checked;
      values.ageGate = values.ageGate === 'default' ? null : values.ageGate === 'true';
      const button = form.querySelector('button[type=submit]'); button.disabled = true;
      try { await cmsApi('settings', { method: 'PUT', json: values }); toast('Site features saved'); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
  };

VIEWS.shop = async (arg, q, token) => {
    setCrumbs(siteCrumb('Shop catalog & orders'));
    const settings = await cmsApi('settings');
    if (!settings.commerce) {
      setView(`<div class="card"><h1>Demo shop is disabled</h1><p>Enable commerce through <a href="${setHref('site-settings')}">Site features</a> before managing products.</p></div>`, token);
      return;
    }
    const base = `/api/sets/${encodeURIComponent(state.key)}/shop`;
    const [products, orders] = await Promise.all([api(`${base}/products`), api(`${base}/orders`)]);
    const product = arg ? products.find((p) => String(p.id) === arg) : null;
    if (arg && !product) throw new Error('Product not found');
    setView(`<div class="card"><h1>Demo catalog</h1><p class="muted">Prices use whole FTHX credits. No real fulfillment. Disable a product to remove it from the catalog without changing order history.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>FTHX</th><th>Stock</th><th>Active</th></tr></thead><tbody>
      ${products.map((p) => `<tr><td><a href="${setHref('shop', p.id)}">${esc(p.title)}</a></td><td>${p.price}</td><td>${p.stock}</td><td>${p.active ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>
      <h2>${product ? 'Edit product' : 'Add product'}</h2><form id="product-form" class="form-grid">
        <label>Title<input name="title" required maxlength="200" value="${esc(product?.title || '')}"></label>
        <label>Description<textarea name="description" maxlength="3000">${esc(product?.description || '')}</textarea></label>
        <label>FTHX price<input name="price" type="number" min="1" max="1000000" step="1" required value="${product?.price || 25}"></label>
        <label>Stock<input name="stock" type="number" min="0" max="100000" step="1" required value="${product?.stock ?? 10}"></label>
        <label><input name="active" type="checkbox" ${!product || product.active ? 'checked' : ''}> Active</label>
        <div><button class="btn primary" type="submit">Save product</button> <a class="btn" href="${setHref('shop')}">New product</a></div>
      </form></div><div class="card"><h2>Demo orders</h2>
      ${orders.length ? orders.map((o) => `<p>#${o.id} · ${esc(o.address)} · ${o.total} FTHX · ${esc(o.status)}<br>${o.items.map((p) => `${esc(p.title)} × ${p.quantity}`).join(', ')}</p>`).join('') : '<p class="muted">No demo orders yet.</p>'}</div>`, token);
    $('#product-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      values.price = Number(values.price); values.stock = Number(values.stock); values.active = form.elements.active.checked;
      try {
        await api(`${base}/products${product ? `/${product.id}` : ''}`, { method: product ? 'PUT' : 'POST', json: values });
        toast('Product saved'); await VIEWS.shop(arg, q, token);
      } catch (error) { toast(error.message); }
    });
  };
