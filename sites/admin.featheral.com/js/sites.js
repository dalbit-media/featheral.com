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
    const manage = (site.managementLinks?.length ? managementHref(site) : '') || (classic && site.contentEditable === false ? hrefFor(['operations'])
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
        ${(site.managementLinks || []).slice(1).filter(link => !['#/deployment', '#/settings'].includes(link.href)).map(link => `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>`).join('')}
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
  state.integratedSites = catalog;
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
  state.integratedSites = catalog;
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

function consoleLineClass(line) {
  if (/^--- .+ ---$/.test(line)) return 'console-source';
  if (/\b(error|failed|failure|fatal|exception|denied|refused|unavailable|not read)\b|FEATHERAL_FAILURE:|"\s+5\d\d\s|^\s*at\s+\S+.*:\d+/i.test(line)) return 'console-error';
  if (/\b(warn(?:ing)?|deprecated|retry|rollback|not yet|omitted)\b|"\s+4\d\d\s/i.test(line)) return 'console-warning';
  if (/\b(success(?:ful(?:ly)?)?|verified|complete[ds]?|healthy|ready|syntax is ok)\b/i.test(line)) return 'console-success';
  if (/FEATHERAL_PHASE:|\b(provisioning|installing|building|starting|checking|verifying|preparing|activating|importing)\b/i.test(line)) return 'console-info';
  return '';
}
function renderConsole(element, text) {
  if (element.textContent === text) return;
  const fragment = document.createDocumentFragment();
  text.split('\n').forEach((line, index) => {
    if (index) fragment.append(document.createTextNode('\n'));
    const span = document.createElement('span');
    span.className = consoleLineClass(line);
    span.textContent = line;
    fragment.append(span);
  });
  element.replaceChildren(fragment);
}
function deploymentControlsHtml() {
  return `<div class="deployment-controls">
    <section class="form-grid deployment-review" aria-labelledby="deployment-review-heading">
    <div class="deployment-review-heading"><h3 id="deployment-review-heading">2. Review &amp; deploy</h3>
    <button class="btn" type="button" id="deployment-plan">Review release</button></div>
    <p class="muted small">One release for all assigned servers. Installation is detected automatically; existing data and keys are preserved.</p>
    <p id="deployment-summary" class="deployment-summary" role="status">Save the connection, then review the release.</p>
    <details class="deployment-technical"><summary>Servers &amp; technical details</summary>
    <pre class="deployment-plan" id="deployment-details">No plan generated yet.</pre></details>
    <label>Approval phrase<input id="deployment-phrase" readonly value="" placeholder="Available after review" aria-label="Reviewed approval phrase"></label>
    <label>Enter phrase to approve<input id="deployment-approval" autocomplete="off" spellcheck="false" placeholder="DEPLOY ..." disabled></label>
    <button class="btn primary deployment-launch" type="button" id="deployment-start" disabled>Sign &amp; deploy</button>
    <p class="muted small">Restarts services. New sites contain published content only, without source ownership, balances, rewards, uploads or history. Back up existing data first.</p>
    </section>
    <section class="form-grid deployment-output" aria-labelledby="deployment-console-heading">
    <div class="deployment-console-heading"><h3 id="deployment-console-heading">3. Deployment console</h3>
    <span id="deployment-status" class="muted small" role="status" aria-live="polite">Checking deployment status...</span></div>
    <pre id="deployment-console" class="deployment-console" role="log" aria-labelledby="deployment-console-heading" aria-live="polite" tabindex="0">No deployment logs yet.</pre>
    <p class="muted small">Live installer output appears here with known credentials redacted. The full server log remains in shared/logs/deployment.log. Logs may contain operational data; review before sharing. Back up existing private data before deploying.</p>
    </section>
  </div>`;
}
async function mountDeploymentControls(token, ready = () => true) {
  let plan;
  let deploymentTimer;
  let consoleLoaded = false;
  let submitting = false, reviewing = false, running = false;
  const viewHash = location.hash, active = () => token === state.seq && location.hash === viewHash;
  const approval = $('#deployment-approval'), start = $('#deployment-start'), review = $('#deployment-plan');
  const exactApproval = () => plan ? `DEPLOY ${plan.digest} ${plan.contentDigest}` : '';
  const updateStart = () => {
    start.disabled = !plan?.enabled || submitting || reviewing || running || !ready()
      || Date.now() >= plan.expiresAt || approval.value !== exactApproval();
    review.textContent = reviewing ? 'Reviewing...' : plan ? 'Refresh review' : 'Review release';
    start.textContent = submitting ? 'Awaiting approval...' : running ? 'Deploying...' : 'Sign & deploy';
  };
  approval.addEventListener('input', updateStart);
  const cleanup = viewCleanup;
  viewCleanup = () => { clearInterval(deploymentTimer); cleanup?.(); };
  const status = async () => {
    try {
      const current = await api('/api/deployment/status');
      if (!active()) { clearInterval(deploymentTimer); return; }
      running = current.running;
      review.disabled = submitting || reviewing || running;
      updateStart();
      $('#deployment-status').textContent = current.running ? 'Running'
        : current.result ? current.result.success ? 'Verified successfully' : 'Deployment failed' : 'No deployment started';
      const consoleView = $('#deployment-console');
      const lines = (current.logs || []).map(entry => `[${new Date(entry.at).toLocaleTimeString()}] ${entry.message}`);
      for (const target of current.result?.targets || []) {
        lines.push(`${target.host}: ${target.success ? 'verified' : 'failed'} (${target.hosts.join(', ')})`);
        if (target.error && !lines.some(line => line.includes(target.error))) lines.push(target.error);
      }
      if (!current.logs?.length && current.result?.error && !lines.some(line => line.includes(current.result.error))) lines.push(current.result.error);
      const text = lines.length ? lines.join('\n') : 'No deployment logs yet.';
      if (consoleView.textContent !== text) {
        const follow = !consoleLoaded || consoleView.scrollHeight - consoleView.scrollTop - consoleView.clientHeight < 32;
        renderConsole(consoleView, text);
        if (follow) consoleView.scrollTop = consoleView.scrollHeight;
      }
      consoleLoaded = true;
      if (current.running && !deploymentTimer) deploymentTimer = setInterval(status, 2000);
      if (!current.running) { clearInterval(deploymentTimer); deploymentTimer = null; }
    } catch (error) { clearInterval(deploymentTimer); deploymentTimer = null; if (active()) $('#deployment-status').textContent = error.message; }
  };
  $('#deployment-plan').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (submitting || reviewing || running) return;
    reviewing = true; plan = undefined;
    approval.value = ''; approval.disabled = true;
    $('#deployment-phrase').value = '';
    $('#deployment-summary').textContent = 'Preparing release review...';
    updateStart();
    button.disabled = true;
    try {
      if (!ready()) throw new Error('Save the deployment connection before reviewing a plan.');
      plan = await api('/api/deployment/plan', { json: {} });
      if (!active()) return;
      const targets = plan.targets?.map(target => `${target.username}@${target.host}:${target.port}${target.directory}\n  Sites: ${target.hosts.join(', ')}${target.urls?.length ? `\n  URL: ${target.urls.join(', ')}` : ''}`).join('\n\n') || plan.target;
      const count = plan.targets?.length || 1;
      $('#deployment-summary').textContent = `${count} server${count === 1 ? '' : 's'}${plan.hosts?.length ? ` | ${plan.hosts.length} sites` : ''} | ${plan.files} files\nReview expires ${new Date(plan.expiresAt).toLocaleTimeString()}`;
      $('#deployment-details').textContent = `${targets}\n\n${plan.files} Git-tracked source files per server\nExpires: ${new Date(plan.expiresAt).toLocaleString()}${plan.settingsRevision ? `\nSettings revision ${plan.settingsRevision}: upload ${plan.uploadLimitMiB} MiB; HTTP ${plan.requestTimeoutSeconds}s; deployment ${plan.deploymentTimeoutSeconds}s` : ''}\n\n${plan.steps.join('\n')}`;
      $('#deployment-phrase').value = exactApproval();
      approval.disabled = !plan.enabled;
      $('#deployment-status').textContent = plan.enabled ? 'Review every step, then enter the approval phrase.' : 'Deployment disabled. Sign and save the connection above, then review a new plan.';
    } catch (error) { plan = undefined; if (active()) { $('#deployment-status').textContent = error.message; $('#deployment-summary').textContent = 'Review unavailable. Resolve the error and retry.'; approval.disabled = true; } }
    finally { reviewing = false; if (active()) { button.disabled = running; updateStart(); } }
  });
  $('#deployment-start').addEventListener('click', async () => {
    if (!active() || !plan || submitting || reviewing || running) return;
    try {
      if (!ready()) throw new Error('Connection settings changed. Save them and review a new plan.');
      if (Date.now() >= plan.expiresAt) throw new Error('Deployment plan expired. Review a new plan.');
      if (approval.value !== exactApproval()) throw new Error('Enter the exact approval phrase from the reviewed plan.');
      if (!confirm('Deploy this reviewed release? PM2 will restart the application and Nginx/HTTPS configuration may change.')) return;
      submitting = true; start.disabled = true; review.disabled = true; approval.disabled = true;
      const payload = { planId: plan.id, approval: approval.value };
      $('#deployment-status').textContent = 'Preparing deployment approval...';
      if (plan.walletApprovalRequired) {
        const challenge = await api('/api/database/deployment/challenge', { json: payload });
        Object.assign(payload, await approveAdminAction(challenge, active));
      }
      if (!active()) throw new Error('View changed. Deployment was not submitted.');
      await api(plan.walletApprovalRequired ? '/api/database/deployment/start' : '/api/deployment/start', { json: payload });
      if (!active()) { toast('Deployment accepted. Check its recorded status before retrying.'); return; }
      plan = undefined;
      $('#deployment-phrase').value = '';
      approval.value = '';
      $('#deployment-summary').textContent = 'Release submitted. Follow progress in the console.';
      $('#deployment-status').textContent = 'Deployment accepted, not yet verified.';
      clearInterval(deploymentTimer); deploymentTimer = setInterval(status, 2000);
      await status();
    } catch (error) { if (active()) $('#deployment-status').textContent = error.message; else toast(error.message); }
    finally {
      submitting = false;
      if (active()) { review.disabled = running; approval.disabled = !plan?.enabled || running; updateStart(); }
    }
  });
  await status();
}
VIEWS.deployment = async () => { location.hash = '#/settings'; };

VIEWS.logs = async (_q, token) => {
  renderSidebar('logs'); setCrumbs('<b>Logs</b>');
  setView(`<section class="card server-logs">
    <div class="card-head"><h1>Server logs</h1><a class="btn" href="#/settings">Deployment settings</a></div>
    <p class="muted small">Remote logs are private and may contain personal or sensitive operational data. Reads require a wallet signature. Known credentials are redacted; review before sharing.</p>
    <div class="row"><label>Server <select id="logs-target" disabled></select></label>
    <label>Log <select id="logs-source"><option value="all">All tracked logs + deployment progress</option><option value="progress">Deployment progress (CMS only)</option></select></label>
    <button id="logs-read" class="btn primary" disabled>Refresh progress</button><span id="logs-status" role="status" aria-live="polite">Loading...</span></div>
    <pre id="server-log-output" class="deployment-console" role="log" aria-label="Server log contents" tabindex="0"></pre>
    <p class="muted small">Combined logs are grouped by source, not time-sorted. Remote files: latest 64 KiB, up to 400 lines each. CMS progress: latest 200 events across deployments. Missing or unreadable files report an error; logs are not automatically cleared or retried.</p>
  </section>`, token);
  const controller = new AbortController(), hash = location.hash;
  const active = () => token === state.seq && location.hash === hash && !controller.signal.aborted;
  viewCleanup = () => controller.abort();
  const source = $('#logs-source'), target = $('#logs-target'), button = $('#logs-read');
  const status = $('#logs-status'), output = $('#server-log-output');
  let busy = false, catalogLoaded = false;
  const controls = () => {
    target.disabled = busy || source.value === 'progress';
    source.disabled = busy;
    button.disabled = busy || source.value !== 'progress' && !catalogLoaded;
    button.textContent = source.value === 'progress' ? 'Refresh progress' : source.value === 'all' ? 'Sign & read all logs' : 'Sign & read log';
  };
  source.addEventListener('change', () => { output.textContent = ''; status.textContent = 'Select Sign & read log to load this private log.'; controls(); });
  target.addEventListener('change', () => { output.textContent = ''; status.textContent = 'Server changed. Sign a new log read.'; });
  const read = async () => {
    if (busy || source.value !== 'progress' && !catalogLoaded) return;
    busy = true; controls();
    try {
      status.textContent = 'Loading...';
      if (source.value === 'progress') {
        const data = await api('/api/deployment/status', { signal: controller.signal, cache: 'no-store' });
        if (!active()) return;
        renderConsole(output, data.logs?.length ? data.logs.map(entry => `[${new Date(entry.at).toLocaleString()}] ${entry.message}`).join('\n') : 'No deployment progress recorded.');
        status.textContent = data.running ? 'Running' : data.result ? data.result.success ? 'Verified' : 'Failed' : 'Not started';
      } else {
        const payload = { target: target.value, log: source.value };
        const challenge = await api('/api/database/logs/challenge', { json: payload, signal: controller.signal });
        Object.assign(payload, await approveAdminAction(challenge, active));
        if (!active()) return;
        const data = await api('/api/database/logs/read', { json: payload, signal: controller.signal });
        if (!active()) return;
        renderConsole(output, data.text || 'Log file is empty.');
        const errors = data.sources?.filter(source => source.error).length || 0;
        status.textContent = `${data.host} · ${data.limit} · ${new Date(data.at).toLocaleTimeString()}${errors ? ` · ${errors} source(s) unavailable` : ''}`;
      }
      output.scrollTop = output.scrollHeight;
    } catch (error) { if (active()) { output.textContent = ''; status.textContent = `Log read failed: ${error.message}`; } }
    finally { busy = false; if (active()) controls(); }
  };
  button.addEventListener('click', read);
  renderConsole(output, 'Choose a server, then sign to read its combined logs.');
  try {
    const catalog = await api('/api/database/logs', { signal: controller.signal, cache: 'no-store' });
    if (!active()) return;
    target.innerHTML = catalog.targets.map(server => `<option value="${esc(server.id)}">${esc(server.host)}</option>`).join('');
    source.insertAdjacentHTML('beforeend', catalog.logs.filter(log => log.id !== 'all').map(log => `<option value="${esc(log.id)}">${esc(log.label)}</option>`).join(''));
    catalogLoaded = catalog.targets.length > 0;
    status.textContent = catalogLoaded ? 'Ready. Sign to read all tracked logs for this server.' : 'No deployment servers configured. CMS progress is still available.';
    controls();
  } catch (error) { if (active()) status.textContent = `Remote log catalog unavailable: ${error.message}`; }
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
  state.integratedSites = catalog;
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
