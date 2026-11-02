const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { SitePages } = require('../lib/site-pages');

test('service overview retains native workspaces and application editors without embedded consoles', async () => {
  const directory = path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js');
  const core = fs.readFileSync(path.join(directory, 'core.js'), 'utf8');
  const catalog = ['featheral.com', 'gold.featheral.com', 'dollar.featheral.com', 'world.featheral.com', 'admin.featheral.com']
    .map(hostname => ({ hostname, builtin: true, cmsCompatible: !['world.featheral.com', 'admin.featheral.com'].includes(hostname) }));
  catalog.push({ hostname: 'wallet.featheral.com', builtin: true, cmsCompatible: false, contentEditable: false });
  catalog.push({ hostname: 'native.featheral.com', builtin: false, cmsCompatible: false, contentEditable: false });
  for (const site of catalog) site.managementLinks = require('../lib/site-management').managementFor({ key: site.hostname, ...site });
  let html = '', crumbs = '', mounted;
  const context = vm.createContext({
    VIEWS: {}, URL, state: { seq: 1 }, location: { hostname: 'admin.localhost', protocol: 'http:', port: '8080' },
    api: async () => catalog, esc: String, hrefFor: parts => '#/' + parts.join('/'),
    renderSidebar: () => {}, setCrumbs: value => { crumbs = value; }, setView: value => { html = value; },
    mountOperation: async (key, q) => { mounted = { key, q }; },
  });
  vm.runInContext(core.slice(core.indexOf('function siteSelectionUrl'), core.indexOf('function renderSidebar')), context);
  vm.runInContext(fs.readFileSync(path.join(directory, 'sites.js'), 'utf8'), context);
  await context.VIEWS.operations(undefined, {}, 1);
  for (const key of ['foundation', 'gold', 'dollar', 'world']) assert.match(html, new RegExp(`href="#/operations/${key}"`));
  assert.match(html, /#\/site-pages\/world.featheral.com/);
  assert.match(html, /#\/site-pages\/admin.featheral.com/);
  assert.match(html, /wallet.localhost:8080\/ethereum\//);
  assert.match(html, /native.localhost:8080/);
  assert.match(html, /no CMS-editable pages/);
  assert.doesNotMatch(html, /#\/site-pages\/wallet.featheral.com/);
  assert.doesNotMatch(html, /<h1>|Ecosystem shortcuts/);
  assert.equal(crumbs, '');
  await context.VIEWS.operations('gold', { tab: 'reserve' }, 1);
  assert.equal(mounted.key, 'gold');
  assert.equal(mounted.q.tab, 'reserve');
  assert.doesNotMatch(html, /<iframe|\/operations\/gold\//);
});

test('site cards preserve icons, taglines and management with visible traffic and no port badge', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js', 'sites.js'), 'utf8');
  const context = vm.createContext({
    VIEWS: {}, URL, location: { hostname: 'admin.localhost', protocol: 'http:', port: '8080', href: 'http://admin.localhost:8080/' },
    esc: value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    hrefFor: parts => '#/' + parts.join('/'),
    publicPreview: key => '/?site=' + key,
  });
  vm.runInContext(source, context);
  context.isClassicSite = site => site.builtin === true || site.cmsCompatible === false;
  const site = { hostname: 'gold.featheral.com', key: 'gold', builtin: true, name: 'Gold',
    status: 'ready', tagline: 'Gold <reserve>', favicon: '/shared/logo.svg', localDir: 'sites\\gold.featheral.com' };
  const cards = context.siteCards([site], true);
  assert.match(cards, /src="http:\/\/gold.localhost:8080\/shared\/logo.svg"/);
  assert.match(cards, /Gold &lt;reserve&gt;/);
  assert.doesNotMatch(cards, /Gateway port/);
  assert.match(cards, /Manage content &amp; theme/);
  assert.match(cards, /Storage details/);
  assert.match(cards, /<div class="site-card-traffic" data-site-traffic><\/div>/);
  assert.doesNotMatch(cards, /<details class="site-card-traffic"/);
  assert.doesNotMatch(context.siteCards([site]), /data-site-traffic/);
  const stats = { ...site, builtin: false, hostname: 'stats.featheral.com', key: 'stats', favicon: '/site/logo.svg' };
  assert.equal(context.siteCardUrl(stats), 'http://stats.localhost:8080/');
  assert.match(context.siteCards([stats]), /#\/set\/stats\/site-settings/);
  const hosted = { ...stats, hostname: 'sites.featheral.com', path: '/my-website' };
  assert.equal(context.siteCardUrl(hosted), 'http://sites.localhost:8080/my-website/');
  assert.match(context.siteCards([hosted]), /sites.featheral.com\/my-website/);
  Object.assign(context.location, { hostname: 'admin.featheral.com', protocol: 'https:', port: '', href: 'https://admin.featheral.com/' });
  assert.equal(context.siteCardUrl(stats), 'https://stats.featheral.com/');
  assert.doesNotMatch(context.siteCards([stats]), /Gateway port/);
  const wallet = { ...site, hostname: 'wallet.featheral.com', cmsCompatible: false, contentEditable: false };
  const nativeCard = context.siteCards([wallet]);
  assert.match(nativeCard, /Manage application/);
  assert.match(nativeCard, /href="#\/operations"/);
  assert.doesNotMatch(nativeCard, /#\/site-pages\/wallet.featheral.com/);
});

test('direct editor links for non-editable apps open Classic management without loading CMS pages', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js', 'sites.js'), 'utf8');
  const calls = [], catalog = [{ hostname: 'wallet.featheral.com', builtin: true, cmsCompatible: false, contentEditable: false }];
  const context = vm.createContext({ VIEWS: {}, state: { seq: 1 }, api: async url => {
    calls.push(url); assert.equal(url, '/api/sites'); return catalog;
  } });
  vm.runInContext(source, context);
  let classic = false;
  context.VIEWS.operations = async () => { classic = true; };
  await context.VIEWS['site-pages']('wallet.featheral.com', {}, 1);
  assert.equal(classic, true); assert.deepEqual(calls, ['/api/sites']);
});

test('hosted website APIs and browser storage use tenant context without weakening authenticated previews', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'x.featheral.com', 'site.js'), 'utf8');
  const setup = source.slice(source.indexOf('const previewSite'), source.indexOf('async function api'));
  const run = search => {
    const context = vm.createContext({ URLSearchParams, URL, location: { search, origin: 'https://sites.featheral.com' },
      document: { querySelector: selector => ({ content: selector.includes('site-key') ? 'sites-featheral-com--one' : '/one' }) },
    });
    vm.runInContext(setup + '\nglobalThis.key = storageKey("wallet");', context);
    return context;
  };
  const tenant = run('');
  assert.equal(tenant.publicUrl('/api/public/info'), '/one/api/public/info');
  assert.equal(tenant.key, 'site:sites-featheral-com--one:wallet');
  const preview = run('?site=other-site');
  assert.equal(preview.publicUrl('/api/public/info'), '/api/public/info?site=other-site');
  assert.equal(preview.key, 'site:other-site:wallet');
});

test('integrated card metadata uses real favicons and current CMS homepage descriptions', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-metadata-'));
  const pages = new SitePages({ root: path.resolve(__dirname, '..', '..', '..'), dataDir });
  t.after(() => { pages.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const home = pages.pages('gold.featheral.com').find(page => page.template === 'index.html');
  pages.save('gold.featheral.com', home.id, { ...home, excerpt: 'Edited reserve tagline' });
  assert.equal(pages.presentation('gold.featheral.com').tagline, 'Edited reserve tagline');
  assert.equal(pages.presentation('dollar.featheral.com').favicon, '/shared/logo-dollar.svg');
  assert.equal(pages.presentation('world.featheral.com').favicon, '/shared/logo-world.svg');
  assert.match(pages.presentation('world.featheral.com').tagline, /정착지|settlement/i);
  assert.equal(pages.presentation('media.featheral.com').favicon, '/shared/logo-media.svg');
  assert.match(pages.presentation('media.featheral.com').tagline, /Public wallet-signed/);
  assert.equal(pages.presentation('ex.featheral.com').favicon, '/shared/logo-ex.svg');
  assert.equal(pages.catalog().find(site => site.hostname === 'gold.featheral.com').cmsCompatible, true);
  assert.equal(pages.catalog().find(site => site.hostname === 'world.featheral.com').cmsCompatible, false);
});

test('traffic defaults to hourly lines and switches periods with a shared scale', () => {
  const element = () => ({
    children: [], style: {}, attributes: {}, dataset: {},
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { const previous = this[name]; this[name] = () => { previous?.(); handler(); }; },
    set textContent(value) { this.text = value; },
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); },
  });

  test('site dropdown uses canonical URLs and resolves selections to unchanged CMS routes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js', 'core.js'), 'utf8');
    const elements = { '#set-switch': {}, '#nav': {}, '#set-select': { value: '', addEventListener(event, handler) { this.change = handler; } } };
    const sites = [
      { builtin: true, key: 'gold.featheral.com', hostname: 'gold.featheral.com', name: 'Gold', status: 'ready' },
      { key: 'stats-featheral-com', hostname: 'stats.featheral.com', name: 'Stats', status: 'ready' },
      { key: 'sites-featheral-com--one', hostname: 'sites.featheral.com', path: '/one', name: 'One', status: 'ready' },
    ];
    const context = vm.createContext({
      state: { integratedSites: [sites[0]], library: sites.slice(1), overview: {}, key: sites[1].key },
      location: { hash: '#/', hostname: 'admin.localhost', protocol: 'http:', port: '8080' },
      $: selector => elements[selector],
      esc: String, isLocal: () => true, managesSites: () => true,
      hrefFor: parts => '#/' + parts.join('/'),
      setHref: id => '#/' + id,
      parseHash: () => ({ parts: context.location.hash.slice(2).split('/'), q: {} }),
    });
    vm.runInContext(source.slice(source.indexOf('function siteSelectionUrl'), source.indexOf("$('#menu-toggle')")), context);
    context.renderSidebar('home');
    const html = elements['#set-switch'].innerHTML;
    assert.match(html, /value="https:\/\/gold.featheral.com\/"/);
    assert.match(html, /value="https:\/\/stats.featheral.com\/" selected/);
    assert.match(html, /value="https:\/\/sites.featheral.com\/one\/"/);
    assert.doesNotMatch(html, /value="stats-featheral-com"/);
    const select = elements['#set-select'];
    select.value = 'https://stats.featheral.com/';
    select.change();
    assert.equal(context.location.hash, '#/set/stats-featheral-com/overview');
    select.value = 'https://sites.featheral.com/one/';
    select.change();
    assert.equal(context.location.hash, '#/set/sites-featheral-com--one/overview');
    assert.doesNotMatch(html, /Classic|https:\/\/admin.featheral.com\/operations/);
    assert.match(elements['#nav'].innerHTML, /href="#\/deployment"/);
    assert.match(elements['#nav'].innerHTML, /href="#\/notes"/);
    context.state.integratedSites.push({ builtin: true, cmsCompatible: false, hostname: 'world.featheral.com', status: 'ready' });
    context.renderSidebar('operations');
    const main = elements['#set-switch'].innerHTML.split('</select>')[0];
    assert.match(main, /value="https:\/\/world.featheral.com\/"/);
    assert.match(main, /value="https:\/\/gold.featheral.com\/"/);
    assert.doesNotMatch(elements['#set-switch'].innerHTML, /classic-select/);
    assert.equal((elements['#set-switch'].innerHTML.match(/<select/g) || []).length, 1);
    context.location.hash = '#/operations/gold';
    context.renderSidebar('operations');
    assert.match(elements['#nav'].innerHTML, /href="#\/deployment"/);
    context.state.key = null;
    context.location.hash = '#/deployment';
    context.renderSidebar('deployment');
    assert.match(elements['#nav'].innerHTML, /All sites<\/a>/);
    assert.match(elements['#nav'].innerHTML, /href="#\/deployment"/);
    context.location.hash = '#/site-pages/gold.featheral.com';
    context.renderSidebar('home');
    assert.match(elements['#nav'].innerHTML, /href="#\/deployment"/);
  });

  test('deployment controls live on the dedicated view, not the Sites overview', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js', 'sites.js'), 'utf8');
    const sites = source.slice(source.indexOf('VIEWS.sites ='), source.indexOf('VIEWS.deployment ='));
    const deployment = source.slice(source.indexOf('VIEWS.deployment ='), source.indexOf("VIEWS['site-pages'] ="));
    assert.doesNotMatch(sites, /deployment-plan|deployment-start|deploymentTimer/);
    assert.match(sites, /traffic-refresh/);
    assert.match(deployment, /renderSidebar\('deployment'\)/);
    assert.match(deployment, /deployment-plan/);
    assert.match(deployment, /approval:.*deployment-approval/);
    assert.match(deployment, /viewCleanup = .*clearInterval/);
    assert.match(deployment, /await status\(\)/);
  });

  test('all core sites have hostname-named frontend folders and a shell or CMS documents', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'sites');
    for (const hostname of require('../lib/site-pages').hosts) {
      assert.ok(fs.statSync(path.join(root, hostname)).isDirectory(), hostname);
      const shell = hostname === 'world.featheral.com' ? path.join('play', 'index.html')
        : hostname === 'wallet.featheral.com' ? 'wallet-app.html' : 'index.html';
      assert.ok(fs.existsSync(path.join(root, hostname, shell)) ||
        fs.existsSync(path.join(root, 'admin.featheral.com', 'documents', hostname)), hostname);
    }
  });
  const context = vm.createContext({ window: {}, document: { createElement: element, createElementNS: element } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'traffic-charts.js'), 'utf8'), context);
  const container = element();
  const select = context.window.FeatheralTraffic.control();
  const rows = (count, step, views) => Array.from({ length: count }, (_, index) => ({ at: Date.UTC(2026, 10, 1) + index * step, views: index === 0 ? views : 0 }));
  context.window.FeatheralTraffic.render(container, { sites: [
    { hostname: 'stats.featheral.com', minutely: rows(60, 60000, 5), daily: rows(30, 86400000, 10), hourly: rows(24, 3600000, 5) },
  ] }, 'stats.featheral.com', select);
  const chart = container.children[0].children.find(child => child.className === 'traffic-chart');
  assert.equal(chart.children.length, 2);
  assert.equal(chart.children[0].children.length, 1);
  assert.equal(chart.children[0].children[0].attributes.points.split(' ').length, 24);
  assert.match(chart.children[0].children[0].attributes.points, /^0,100 /);
  assert.match(chart.attributes['aria-label'], /shared scale 0–10/);
  assert.match(chart.children[0].children[0].children[0].textContent, /page views/);
  assert.ok(!container.children[0].children.some(child => child.className === 'traffic-timeframe'));
  assert.equal(select.value, 'hourly');
  select.value = 'minutely';
  select.change();
  assert.equal(chart.children[0].children[0].attributes.points.split(' ').length, 60);
  select.value = 'daily';
  select.change();
  assert.equal(chart.children.length, 2);
  assert.equal(chart.children[0].children[0].attributes.points.split(' ').length, 30);
  assert.match(chart.attributes['aria-label'], /scale 0–10/);
  assert.match(chart.attributes['aria-label'], /daily/);
  const comparison = element();
  const report = { sites: [
    { hostname: 'one.featheral.com', minutely: rows(60, 60000, 5), hourly: rows(24, 3600000, 5), daily: rows(30, 86400000, 10) },
    { hostname: 'two.featheral.com', minutely: rows(60, 60000, 5), hourly: rows(24, 3600000, 5), daily: rows(30, 86400000, 20) },
  ] };
  const common = context.window.FeatheralTraffic.control();
  context.window.FeatheralTraffic.render(comparison, report, undefined, common);
  const aggregate = comparison.children[0];
  const totalChart = aggregate.children.find(child => child.className === 'traffic-chart');
  assert.equal(totalChart.children[0].children.length, 3);
  assert.equal(totalChart.dataset.scaleMax, '30');
  assert.match(aggregate.children.find(child => child.className === 'traffic-total').textContent, /10 page views · 2 sites/);
  const charts = comparison.children[1].children.map(panel => panel.children.find(child => child.className === 'traffic-chart'));
  assert.equal(charts[0].dataset.scaleMax, '20');
  assert.equal(charts[1].dataset.scaleMax, '20');
  assert.match(charts[0].children[0].children[0].attributes.points, /^0,150 /);
  assert.match(charts[1].children[0].children[0].attributes.points, /^0,150 /);
  assert.equal(charts[0].children[1].className, 'traffic-y-axis');
  assert.equal(charts[0].children[1].children.length, 5);
  common.value = 'daily';
  common.change();
  for (const chart of [totalChart, ...charts]) {
    assert.match(chart.attributes['aria-label'], /daily/);
    assert.equal(chart.children[0].children[0].attributes.points.split(' ').length, 30);
  }
  const filtered = element();
  context.window.FeatheralTraffic.render(filtered, report, 'one.featheral.com', common);
  assert.equal(filtered.children[0].children.find(child => child.className === 'traffic-chart').dataset.scaleMax, '20');
  const sums = context.window.FeatheralTraffic.totals([
    { hourly: [{ at: 2000, views: 3 }, { at: 1000, views: 2 }] },
    { hourly: [{ at: 1000, views: 5 }, { at: 3000, views: 4 }] },
  ], 'hourly');
  assert.equal(JSON.stringify(sums), JSON.stringify([{ at: 1000, views: 7 }, { at: 2000, views: 3 }, { at: 3000, views: 4 }]));
  const empty = element();
  context.window.FeatheralTraffic.render(empty, { sites: [] }, undefined, common);
  assert.match(empty.children[0].children.find(child => child.className === 'traffic-total').textContent, /0 page views · 0 sites/);
  assert.equal(empty.children[0].children.find(child => child.className === 'traffic-chart').dataset.scaleMax, '1');
});
