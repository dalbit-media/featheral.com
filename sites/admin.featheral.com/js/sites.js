function siteCardUrl(site) {
  const local = location.hostname.endsWith('.localhost') || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && site.hostname !== 'featheral.com' && !site.hostname.endsWith('.featheral.com')) return publicPreview(site.key);
  const hostname = local ? site.hostname.replace(/\.featheral\.com$/, '.localhost').replace(/^featheral\.com$/, 'localhost') : site.hostname;
  return `${location.protocol}//${hostname}${location.port ? ':' + location.port : ''}${site.path || ''}/`;
}

function siteCards(sites, traffic = false) {
  return `<div class="site-cards">${sites.map(site => {
    const url = siteCardUrl(site);
    const icon = new URL(site.favicon || '/shared/logo.svg', new URL(url, location.href)).href;
    const classic = isClassicSite(site);
    const manage = site.managementLinks?.[0]?.href || (classic && site.contentEditable === false ? hrefFor(['operations'])
      : site.builtin ? hrefFor(['site-pages', site.hostname]) : hrefFor(['set', site.key, 'cms-content']));
    const address = site.hostname + (site.path || '');
    return `<section class="card site-chart-card" data-site-card data-search="${esc(`${site.name} ${address} ${site.tagline || ''}`.toLowerCase())}">
      ${traffic ? '<div class="site-card-traffic" data-site-traffic></div>' : ''}
      <div class="site-card-info">
      <div class="site-card-heading"><img class="site-card-icon" src="${esc(icon)}" alt="" width="36" height="36"><div><h2>${esc(site.name)}</h2><a class="mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(address)}</a></div></div>
      ${site.tagline ? `<p class="site-card-tagline">${esc(site.tagline)}</p>` : '<p class="muted site-card-tagline">No site tagline set.</p>'}
      <div class="chips"><span class="chip ok">${esc(site.status)}</span><span class="chip">${site.cmsCompatible === false ? 'Application' : 'CMS'}</span><span class="chip">${esc(location.protocol === 'https:' ? 'HTTPS' : 'HTTP')}</span></div>
      </div><div class="site-card-actions">
      <div class="row"><a class="btn primary" href="${manage}">${esc(site.managementLinks?.[0]?.label || (classic && site.contentEditable === false ? 'Manage application' : `Manage content${site.builtin ? ' & theme' : ''}`))}</a>
        ${(site.managementLinks || []).slice(1).filter(link => link.href !== '#/deployment').map(link => `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>`).join('')}
        <a class="btn" href="${site.builtin ? hrefFor(['overview'], { site: site.hostname }) : hrefFor(['set', site.key, 'overview'])}">Overview</a>
        <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Preview site</a>
        ${classic ? '' : `<a class="btn" href="${hrefFor(['set', site.key, 'appearance'])}">Theme</a><a class="btn" href="${hrefFor(['set', site.key, 'site-settings'])}">Settings</a>`}</div>
      <details><summary class="muted small">Storage details</summary><p class="mono">${esc(site.localDir)}</p></details>
      </div>
    </section>`;
  }).join('')}</div>`;
}

VIEWS.traffic = (q, token) => VIEWS.sites(q, token);

function classicCardInfo(site) {
  if (!site) return '';
  const url = siteCardUrl(site);
  const icon = new URL(site.favicon || '/shared/logo.svg', url).href;
  return `<div class="row"><img src="${esc(icon)}" alt="" width="36" height="36"><a class="mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(site.hostname)}</a><span class="chip ok">${esc(site.status || 'ready')}</span></div>${site.tagline ? `<p class="site-card-tagline">${esc(site.tagline)}</p>` : ''}`;
}

VIEWS.operations = async (key, q, token) => {
  const catalog = await api('/api/sites');
  if (token !== state.seq) return;
  state.integratedSites = catalog.filter(site => site.builtin);
  renderSidebar('operations');
  if (!key) {
    setCrumbs('');
    const consoles = OPERATION_VIEWS.map(console => {
      const site = catalog.find(site => site.hostname === console.hostname && !site.path);
      const preview = site ? siteCardUrl(site) : '';
      return `<section class="card"><h2>${esc(console.label)}</h2>${classicCardInfo(site)}<p class="muted">${esc(console.description)}</p>
        <div class="row"><a class="btn primary" href="${hrefFor(['operations', console.key])}">Open management</a>
        ${site ? `<a class="btn" href="${site.builtin ? hrefFor(['site-pages', site.hostname]) : hrefFor(['set', site.key, 'cms-content'])}">${site.cmsCompatible === false ? 'Edit application text & theme' : 'Edit CMS content & theme'}</a><a class="btn" href="${esc(preview)}" target="_blank" rel="noopener">Visit site</a>` : ''}</div></section>`;
    }).join('');
    const applications = catalog.filter(site => isClassicSite(site) && !OPERATION_VIEWS.some(console => console.hostname === site.hostname)).map(site => `<section class="card"><h2>${esc(site.hostname)}</h2>${classicCardInfo(site)}<p class="muted">${site.contentEditable === false ? 'This application has no CMS-editable pages. Use its management workspace and reviewed deployment.' : 'Application text and themes remain editable without changing native service data.'}</p><div class="row">${(site.managementLinks || []).filter(link => link.href !== '#/operations').map(link => `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>`).join('')}<a class="btn" href="${esc(siteCardUrl(site))}" target="_blank" rel="noopener">Visit application</a>${site.hostname === 'wallet.featheral.com' ? `<a class="btn" href="${esc(siteCardUrl(site))}ethereum/" target="_blank" rel="noopener">Ethereum & staking</a>` : ''}</div></section>`).join('');
    setView(`<div class="grid g2">${consoles}${applications}</div>`, token);
    return;
  }
  await mountOperation(key, q, token);
};

VIEWS.sites = async (q, token) => {
  setCrumbs('', '<div id="traffic-interval"></div><button class="btn sm" id="traffic-refresh">Refresh charts</button>');
  const catalog = await api('/api/sites');
  const sites = catalog.filter(site => !q.site || site.hostname + (site.path || '') === q.site);
  state.integratedSites = catalog.filter(site => site.builtin);
  await loadLibrary();
  renderSidebar('home');
  setView(`<div id="aggregate-traffic"></div><div class="card">
    <div class="row"><input id="site-search" type="search" placeholder="Find a site by name or hostname…" aria-label="Find a site"><span class="muted">${sites.length} managed sites</span></div>
  </div><div id="all-site-traffic">${siteCards(sites, true)}</div><p id="site-no-results" class="muted" hidden>No sites match your search.</p>`, token);
  $('#site-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    const cards = $$('[data-site-card]');
    cards.forEach((card) => { card.hidden = !card.dataset.search.includes(query); });
    $('#site-no-results').hidden = cards.some((card) => !card.hidden);
  });
  const containers = $$('[data-site-traffic]');
  const refresh = () => window.FeatheralTraffic.loadSites([{ container: $('#aggregate-traffic'), aggregate: true }, ...containers.map((container, index) => ({
    container, hostname: sites[index].hostname + (sites[index].path || ''),
  }))], '/api/telemetry/report', $('#traffic-interval'));
  $('#traffic-refresh').addEventListener('click', refresh);
  await refresh();
};

VIEWS.deployment = async (q, token) => {
  renderSidebar('deployment');
  setCrumbs('<b>Sync</b>');
  setView(`<div class="deployment-page">
    <section class="card deployment-intro"><div class="deployment-icon">${DEPLOY_ICON}</div><div><h1>Sync</h1><p class="muted">Sync all sites to your server with one reviewed deployment.</p><div class="chips"><span class="chip">SFTP upload</span><span class="chip">SSH & PM2</span><span class="chip">Nginx & HTTPS</span></div></div></section>
    <div class="grid g2">
      <section class="card"><div class="deployment-step"><span>1</span><h2>Review the release</h2></div><p class="muted">Inspect the target, source files and server changes before approving anything.</p><button class="btn primary" id="deployment-plan">Generate review plan</button><pre class="deployment-plan" id="deployment-details">No plan generated yet.</pre></section>
      <section class="card form-grid"><div class="deployment-step"><span>2</span><h2>Approve & deploy</h2></div><p class="muted">Enter the exact approval phrase from the reviewed plan. Deployment remains disabled until enabled on the server.</p><label>Exact approval phrase<input id="deployment-approval" autocomplete="off" spellcheck="false" placeholder="DEPLOY …" disabled></label><button class="btn danger" id="deployment-start" disabled>${DEPLOY_ICON} Deploy reviewed release</button><div class="deployment-status"><b>Release status</b><p id="deployment-status" role="status" aria-live="polite">Checking deployment status…</p></div></section>
    </div><p class="note">Private data and signing keys are never uploaded. Before the first deployment, restore a consistent private backup on the target server. Generating a plan does not deploy or restart anything.</p>
    </div>`, token);
  let plan;
  let deploymentTimer;
  const viewHash = location.hash, active = () => token === state.seq && location.hash === viewHash;
  viewCleanup = () => clearInterval(deploymentTimer);
  const status = async () => {
    try {
      const current = await api('/api/deployment/status');
      if (token !== state.seq) { clearInterval(deploymentTimer); return; }
      $('#deployment-status').textContent = current.running ? 'Deployment running; inspect server deployment log for details.'
        : current.result ? current.result.success ? 'Deployment verified successfully.' : current.result.error : 'No deployment started.';
      if (!current.running) clearInterval(deploymentTimer);
    } catch (error) { clearInterval(deploymentTimer); if (token === state.seq) $('#deployment-status').textContent = error.message; }
  };
  $('#deployment-plan').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      plan = await api('/api/deployment/plan', { json: {} });
      if (!active()) return;
      $('#deployment-details').textContent = `${plan.target}\n${plan.files} source files\nExpires: ${new Date(plan.expiresAt).toLocaleString()}\n\n${plan.steps.join('\n')}\n\nApproval: DEPLOY ${plan.digest} ${plan.contentDigest}`;
      $('#deployment-start').disabled = !plan.enabled;
      $('#deployment-approval').disabled = !plan.enabled;
      $('#deployment-status').textContent = plan.enabled ? 'Review every step, then enter the approval phrase.' : 'Deployment disabled. Set DEPLOY_ENABLED=true server-side only after review.';
    } catch (error) { if (active()) { $('#deployment-status').textContent = error.message; $('#deployment-start').disabled = true; $('#deployment-approval').disabled = true; } }
    finally { event.currentTarget.disabled = false; }
  });
  $('#deployment-start').addEventListener('click', async event => {
    if (!active() || !plan || !confirm('Deploy this reviewed release? PM2 will restart the application and Nginx/HTTPS configuration may change.')) return;
    event.currentTarget.disabled = true;
    try {
      const payload = { planId: plan.id, approval: $('#deployment-approval').value };
      if (plan.walletApprovalRequired) {
        const challenge = await api('/api/database/deployment/challenge', { json: payload });
        Object.assign(payload, await approveAdminAction(challenge, active));
      }
      if (!active()) throw new Error('View changed. Deployment was not submitted.');
      await api(plan.walletApprovalRequired ? '/api/database/deployment/start' : '/api/deployment/start', { json: payload });
      if (!active()) { toast('Deployment accepted. Check its recorded status before retrying.'); return; }
      $('#deployment-status').textContent = 'Deployment accepted, not yet verified.';
      clearInterval(deploymentTimer); deploymentTimer = setInterval(status, 3000);
      await status();
    } catch (error) { if (active()) $('#deployment-status').textContent = error.message; else toast(error.message); }
  });
  await status();
};

VIEWS['site-pages'] = async (hostname, q, token) => {
  const base = `/api/sites/${encodeURIComponent(hostname)}`;
  const catalog = await api('/api/sites');
  if (token !== state.seq) return;
  const site = catalog.find(site => site.hostname === hostname && !site.path);
  if (site?.contentEditable === false) {
    await VIEWS.operations(undefined, q, token);
    return;
  }
  const data = await api(`${base}/pages`);
  state.integratedSites = catalog.filter(site => site.builtin);
  if (token !== state.seq) return;
  renderSidebar('home');
  setCrumbs(`<b>${esc(hostname)} content & theme</b>`);
  const documents = data.pages.some(page => page.format === 'document');
  const pageLabel = page => `${page.template === 'index.html' ? 'Homepage' : page.template.replace(/\/index\.html$/, '').replace(/-/g, ' ')} — ${page.title}`;
  data.pages.sort((a, b) => Number(b.template === 'index.html') - Number(a.template === 'index.html'));
  setView(`<section class="card site-page-editor">
    <div class="card-head"><div><h1>${esc(hostname)}</h1><p class="muted">Manage ${documents ? 'pages, content and appearance' : 'application text and appearance'}.</p></div><a class="btn" href="#/">All sites</a></div>
    <div class="form-grid site-page-controls">
      <div class="grid g2">
        <label>Site<select id="builtin-site">${catalog.map(site => `<option value="${esc(site.contentEditable === false ? managementHref(site) : site.builtin ? hrefFor(['site-pages', site.hostname]) : hrefFor(['set', site.key, 'cms-content']))}" ${site.hostname === hostname && !site.path ? 'selected' : ''}>${esc(site.hostname + (site.path || ''))}</option>`).join('')}</select></label>
        <label>${documents ? 'Page' : 'Text block'}<select id="builtin-page">${data.pages.map(page => `<option value="${page.id}">${esc(pageLabel(page))}</option>`).join('')}</select></label>
      </div>
      <div class="site-page-theme"><label>Site theme<select id="builtin-theme">${data.themes.map(theme => `<option ${theme === data.theme ? 'selected' : ''}>${esc(theme)}</option>`).join('')}</select></label><button class="btn" id="save-builtin-theme">Apply theme</button></div>
    </div>
    ${data.pages.length ? '' : '<p class="muted">This application has no editable content pages.</p>'}
    <form id="builtin-form" class="form-grid">
      ${documents ? '<label>Page title<input name="title" type="text" maxlength="300" required></label><label>Search description<textarea name="excerpt" rows="3" maxlength="5000"></textarea><span class="muted small">Shown in search results; does not change page content.</span></label>' : ''}
      <label>${documents ? 'Page content (HTML)' : 'Content'}<textarea name="body" class="${documents ? 'site-page-source' : ''}" rows="22" maxlength="${documents ? 250000 : 10000}" required spellcheck="${!documents}"></textarea><span class="muted small">Ctrl/Cmd+S to publish. Changes are not live until published.</span></label>
      ${documents ? '<details class="site-page-help"><summary>Editing HTML and protected live widgets</summary><p>Edit headings, prose, links, images and section layout with safe HTML. Keep each protected widget exactly once; you can move it but not edit its contents. Scripts, inline styles and event handlers are not supported.</p><p id="builtin-widgets"></p></details>' : '<p class="muted small">Plain text only. Native application controls, wallet logic and APIs are preserved.</p>'}
      <div class="editor-status" id="builtin-status" role="status"></div>
      <div class="row editor-actions"><button class="btn primary" type="submit">Publish changes</button><a class="btn" id="builtin-preview" target="_blank" rel="noopener">View published page</a></div>
    </form></section>`, token);
  let selected, saving = false, saved = '';
  const form = $('#builtin-form');
  const publicHost = location.hostname === 'localhost' || location.hostname.endsWith('.localhost')
    ? hostname.replace(/\.featheral\.com$/, '.localhost').replace(/^featheral\.com$/, 'localhost') : hostname;
  const load = () => {
    selected = data.pages.find(page => page.id === Number($('#builtin-page').value));
    form.hidden = !selected;
    if (selected) {
      form.elements.body.value = selected.body;
      if (documents) {
        form.elements.title.value = selected.title;
        form.elements.excerpt.value = selected.excerpt;
        $('#builtin-widgets').textContent = selected.widgets.length ? `Keep these protected widgets: ${selected.widgets.map(name => `<cms-widget name="${name}"></cms-widget>`).join(', ')}` : 'This page contains no protected live widgets.';
      }
      saved = JSON.stringify(Object.fromEntries(new FormData(form)));
      $('#builtin-status').textContent = `Published revision ${selected.revision}`;
      $('#builtin-preview').href = `${location.protocol}//${publicHost}${location.port ? ':' + location.port : ''}/${selected.template.replace(/index\.html$/, '')}`;
    }
  };
  load();
  const dirty = () => selected && JSON.stringify(Object.fromEntries(new FormData(form))) !== saved;
  form.addEventListener('input', () => { $('#builtin-status').textContent = dirty() ? 'Unsaved changes — publish to update the site.' : `Published revision ${selected.revision}`; });
  leaveView = () => !saving && (!dirty() || confirm('Discard unsaved content changes?'));
  $('#builtin-site').addEventListener('change', event => { location.hash = event.currentTarget.value; });
  const unload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  const shortcut = event => {
    if (selected && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); form.requestSubmit(); }
  };
  window.addEventListener('beforeunload', unload);
  document.addEventListener('keydown', shortcut);
  viewCleanup = () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('keydown', shortcut); };
  $('#builtin-page').addEventListener('change', () => {
    if (dirty() && !confirm('Discard unsaved content changes?')) { $('#builtin-page').value = selected.id; return; }
    load();
  });
  $('#save-builtin-theme').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await api(`${base}/theme`, { method: 'PUT', json: { theme: $('#builtin-theme').value } }); toast('Theme published'); }
    catch (error) { toast(error.message); }
    finally { event.currentTarget.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !selected) return;
    saving = true; form.inert = true; $('#builtin-status').textContent = 'Publishing…';
    try {
      const result = await api(`${base}/pages/${selected.id}`, { method: 'PUT', json: { ...Object.fromEntries(new FormData(form)), revision: selected.revision } });
      Object.assign(selected, result); load();
      $('#builtin-status').textContent = `Published revision ${result.revision}`;
    } catch (error) { $('#builtin-status').textContent = error.message; }
    finally { saving = false; form.inert = false; }
  });
  const traffic = document.createElement('section');
  traffic.className = 'card';
  $('.site-page-editor').append(traffic);
  await window.FeatheralTraffic.load(traffic, '/api/telemetry/report', hostname);
};
