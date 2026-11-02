const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseFragment } = require('parse5');
const { managementFor } = require('../lib/site-management');
const root = path.resolve(__dirname, '..', '..', '..');
const admin = path.join(root, 'sites', 'admin.featheral.com');
const kitSource = fs.readFileSync(path.join(root, 'shared', 'admin-kit.js'), 'utf8');

test('all core and hosted sites have accurate native, editor and deployment destinations', () => {
  const expected = {
    'featheral.com': '#/operations/foundation', 'gold.featheral.com': '#/operations/gold',
    'dollar.featheral.com': '#/operations/dollar', 'world.featheral.com': '#/operations/world',
    'app.featheral.com': '#/intranet', 'silver.featheral.com': '#/silver',
    'notes.featheral.com': '#/notes', 'ex.featheral.com': '#/notes',
    'stats.featheral.com': '#/overview', 'wallet.featheral.com': '#/operations',
    'admin.featheral.com': '#/', 'x.featheral.com': '#/site-pages/x.featheral.com',
    'sites.featheral.com': '#/site-pages/sites.featheral.com',
  };
  for (const [hostname, primary] of Object.entries(expected)) {
    const links = managementFor({ hostname, key: hostname, builtin: true });
    assert.equal(links[0].href, primary, hostname);
    assert.equal(links.at(-1).href, '#/deployment');
    assert.equal(new Set(links.map(link => link.href)).size, links.length);
  }
  for (const hostname of ['notes.featheral.com', 'ex.featheral.com', 'stats.featheral.com']) {
    assert.equal(managementFor({ hostname, key: hostname, managed: true })[0].href, expected[hostname]);
  }
  const hosted = managementFor({ hostname: 'sites.featheral.com', path: '/sample', key: 'hosted-sample' });
  assert.deepEqual(hosted.map(link => link.href), ['#/set/hosted-sample/cms-content', '#/set/hosted-sample/site-settings', '#/deployment']);
  assert.ok(!managementFor({ hostname: 'wallet.featheral.com', builtin: true, contentEditable: false })
    .some(link => link.href.includes('site-pages')));
});

test('native templates have no standalone shells, duplicate IDs, scripts or iframe consoles', () => {
  for (const key of ['foundation', 'gold', 'dollar', 'world']) {
    const html = fs.readFileSync(path.join(admin, 'views', key + '.html'), 'utf8');
    assert.doesNotMatch(html, /<html|<head\b|<body|<script|<iframe|admin-console\.js|https:\/\/cdn/i, key);
    const ids = [], tabs = [];
    const visit = node => {
      for (const attr of node.attrs || []) {
        if (attr.name === 'id') ids.push(attr.value);
        if (attr.name === 'data-tab') tabs.push(attr.value);
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(parseFragment(html));
    assert.equal(ids.length, new Set(ids).size, key);
    for (const tab of tabs) assert.ok(ids.includes(tab), `${key}: ${tab}`);
  }
  const shell = fs.readFileSync(path.join(admin, 'index.html'), 'utf8');
  assert.equal((shell.match(/id="admin-wallet"/g) || []).length, 1);
  assert.match(shell, /\/js\/vendor\/ethers.js/);
  assert.doesNotMatch(shell, /cdn\.jsdelivr|<iframe/);
});

function kitFixture(fetcher) {
  const window = new EventTarget();
  window.FeatheralProfile = { snapshot: () => ({ account: '' }) };
  vm.runInNewContext(kitSource, {
    window, fetch: fetcher, console,
    document: { createElement: () => ({ append() {} }) },
  });
  return { window, kit: window.AdminKit };
}

test('scoped wallet listeners are removed on navigation and detached views cannot submit', () => {
  const { window, kit } = kitFixture();
  const controller = new AbortController(), root = { isConnected: true };
  const scoped = kit.scope(root, controller.signal);
  let calls = 0;
  scoped.listen('featheral:wallet', () => calls++);
  window.dispatchEvent(new Event('featheral:wallet'));
  scoped.assertActive();
  root.isConnected = false;
  assert.throws(() => scoped.assertActive(), /view changed/);
  root.isConnected = true;
  controller.abort();
  window.dispatchEvent(new Event('featheral:wallet'));
  assert.equal(calls, 1);
  assert.throws(() => scoped.assertActive(), /view changed/);
});

test('a late wallet gate cannot revive a disposed native view', async () => {
  let resolve;
  const { kit } = kitFixture(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController(), host = { textContent: 'unchanged' };
  let callbacks = 0;
  const pending = kit.scope({ isConnected: true }, controller.signal).gate(host, 'world', () => callbacks++);
  controller.abort();
  resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ moderators: [] }) });
  await pending;
  assert.equal(callbacks, 0);
  assert.equal(host.textContent, 'unchanged');
});

test('Admin APIs reject HTML and retain explicit JSON errors instead of success-shaped fallbacks', async () => {
  const html = kitFixture(async () => ({ ok: false, status: 401, headers: { get: () => 'text/html' } }));
  await assert.rejects(html.kit.json('/api/test'), /did not return JSON.*401/);
  const json = kitFixture(async () => ({ ok: false, status: 403, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Actual role required' }) }));
  await assert.rejects(json.kit.json('/api/test'), /Actual role required/);
});

test('native loader ignores stale templates and keeps tab changes inside the Admin route', async () => {
  let resolve, mounted = 0, selectedTab, route;
  const ctx = vm.createContext({
    window: { addEventListener() {}, AdminKit: {
      scope: (_root, signal) => ({ signal }),
      tabs: (_root, initial, changed) => { selectedTab = initial; changed('access'); },
    } },
    state: { seq: 1 }, viewCleanup: null, OPERATION_VIEWS: [{ key: 'foundation', label: 'Foundation' }],
    fetch: () => new Promise(done => { resolve = done; }), AbortController,
    setCrumbs() {}, setView() { mounted++; }, $: () => ({}), $$: () => [], esc: String,
    history: { replaceState: (_state, _unused, href) => { route = href; } },
    hrefFor: (parts, q) => '#/' + parts.join('/') + '?tab=' + q.tab,
  });
  vm.runInContext(fs.readFileSync(path.join(admin, 'js', 'operations.js'), 'utf8'), ctx);
  let scope;
  ctx.window.FeatheralAdminControllers.foundation = (_root, kit) => { scope = kit; };
  const stale = ctx.mountOperation('foundation', {}, 1);
  ctx.state.seq++;
  resolve({ ok: true, text: async () => '<section>old</section>' });
  await stale;
  assert.equal(mounted, 0);
  const live = ctx.mountOperation('foundation', { tab: 'overview' }, 2);
  resolve({ ok: true, text: async () => '<section>current</section>' });
  await live;
  assert.equal(mounted, 1);
  assert.equal(selectedTab, 'overview');
  assert.equal(route, '#/operations/foundation?tab=access');
  assert.equal(scope.signal.aborted, false);
  ctx.viewCleanup();
  assert.equal(scope.signal.aborted, true);
});

test('Notes uses one funding handler with exact budget, eligibility, approval and lifecycle checks', async () => {
  const source = fs.readFileSync(path.join(admin, 'js', 'notes.js'), 'utf8');
  for (const scenario of ['insufficient', 'wrong-approval', 'reserved', 'cancelled', 'stale', 'success']) {
    let html = '', posts = 0, confirmed = 0;
    const nodes = new Map(), button = {};
    const get = selector => {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: '', handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
      return nodes.get(selector);
    };
    const context = vm.createContext({
      VIEWS: {}, state: { seq: 1 }, renderSidebar() {}, setCrumbs() {}, toast() {},
      setView: value => { html = value; }, fmtNum: String, esc: String, options: () => '',
      $: selector => selector === 'button' ? button : get(selector), $$: () => [],
      console: { error() {} },
      confirm: () => { confirmed++; return scenario !== 'cancelled'; },
      api: async (url, init) => {
        if (init) { posts++; return {}; }
        if (url === '/api/notes') return { reactions: { attempts: 0, awarded: 0 } };
        if (url === '/api/notes/sites') return [];
        return { treasuryFthx: scenario === 'insufficient' ? 999999 : 1000000,
          markets: [{ symbol: 'ABC', targetFthx: 1000000, reserved: scenario === 'reserved', funded: false }] };
      },
    });
    await vm.runInContext(source + '\nVIEWS.notes({}, 1)', context);
    if (['insufficient', 'reserved'].includes(scenario)) assert.match(html, /button class="btn" disabled/);
    else assert.doesNotMatch(html, /button class="btn" disabled/);
    if (scenario === 'stale') context.state.seq++;
    const form = { elements: { symbol: { value: 'ABC' }, approval: { value: scenario === 'wrong-approval' ? 'FUND ABC' : 'FUND ABC 1000000 FTHX 1000000 NOTES' } } };
    await get('#notes-funding').handlers.submit({ preventDefault() {}, target: form });
    assert.equal(posts, scenario === 'success' ? 1 : 0, scenario);
    assert.equal(confirmed, ['success', 'cancelled'].includes(scenario) ? 1 : 0, scenario);
  }
  const cms = fs.readFileSync(path.join(admin, 'js', 'cms.js'), 'utf8');
  assert.match(cms, /VIEWS\['note-markets'\] = .*VIEWS.notes\(q, token\)/);
  assert.doesNotMatch(cms, /\/markets\/.*\/fund/);
});
