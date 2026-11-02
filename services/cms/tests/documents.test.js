const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { SitePages } = require('../lib/site-pages');
const { Documents, validateBody } = require('../lib/documents');
const crypto = require('node:crypto');
const { parseFragment } = require('parse5');

const root = path.resolve(__dirname, '..', '..', '..');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-documents-'));
  const pages = new SitePages({ root, dataDir: directory });
  t.after(() => { pages.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { pages, directory };
}
test('seven complete documents replace static home/docs/governance pages, preserving live DOM and scripts', t => {
  const { pages } = fixture(t);
  let count = 0;
  for (const hostname of ['featheral.com', 'gold.featheral.com', 'dollar.featheral.com']) {
    for (const page of pages.pages(hostname)) {
      count++;
      assert.equal(page.format, 'document');
      assert.equal(page.type, 'page');
      assert.equal(page.status, 'publish');
      const template = pages.documents.template(hostname, page.template);
      const html = pages.render(hostname, page.template);
      assert.match(html, /<main class="cms-document">/);
      assert.match(html, /cms-document\.css/);
      assert.match(html, /id="walletButton"/);
      assert.match(html, /wallet-profile\.js/);
      if (page.template === 'index.html' && hostname !== 'featheral.com') assert.match(html, /src="\/landing\.js"/);
      assert.doesNotMatch(html, /cms-widget|data-cms-copy|\{\{CMS_DOCUMENT\}\}/);
      for (const widget of Object.values(template.widgets)) assert.ok(html.includes(widget));
      assert.equal(fs.existsSync(path.join(root, 'sites', hostname, ...page.template.split('/'))), false);
    }
  }
  assert.equal(count, 7);
  assert.equal(pages.pages('world.featheral.com').some(page => page.format === 'document'), false);
  assert.equal(new Documents(root).template('world.featheral.com', 'index.html'), undefined);
});
test('full document publication updates layout, metadata and theme, checks revisions and persists after reopening', t => {
  const { pages, directory } = fixture(t);
  const page = pages.pages('featheral.com').find(page => page.template === 'docs/index.html');
  const saved = pages.save('featheral.com', page.id, { title: 'New <Docs>', excerpt: 'Safe "description"',
    body: '<article class="custom-layout"><h1>Updated docs</h1><p>Read <a href="/governance/">governance</a>.</p></article>', revision: page.revision });
  assert.equal(saved.revision, page.revision + 1);
  assert.throws(() => pages.save('featheral.com', page.id, { body: saved.body, revision: page.revision }), { status: 409 });
  assert.throws(() => pages.save('featheral.com', page.id, { body: saved.body }), { status: 400 });
  pages.theme('featheral.com', 'ocean');
  const html = pages.render('featheral.com', page.template);
  assert.match(html, /<title>New &lt;Docs&gt;<\/title>/);
  assert.match(html, /content="Safe &quot;description&quot;"/);
  assert.match(html, /<article class="custom-layout">/);
  assert.match(html, /body\.cms-layout\{--bg:#edf7fc/);
  assert.equal(pages.store('featheral.com').revisions(page.id).length, 1);
  pages.close();
  const reopened = new SitePages({ root, dataDir: directory });
  try { assert.equal(reopened.render('featheral.com', page.template), html); }
  finally { reopened.close(); }
});
test('document migration preserves previous published text without reapplying it after a full-page edit', t => {
  const { pages } = fixture(t);
  const template = pages.documents.template('featheral.com', 'docs/index.html');
  const key = /data-cms-copy="([^"]+)"/.exec(template.body)[1];
  const legacy = pages.store('featheral.com').save({ title: 'Old docs block', slug: key, body: 'Saved <heading>', type: 'page', status: 'publish' });
  const document = pages.pages('featheral.com').find(page => page.template === template.file);
  assert.match(document.body, /Saved &lt;heading&gt;/);
  assert.doesNotMatch(document.body, /data-cms-copy/);
  pages.save('featheral.com', document.id, { body: '<h1>Whole-page edit wins</h1>', revision: document.revision });
  assert.match(pages.render('featheral.com', template.file), /Whole-page edit wins/);
  assert.equal(pages.store('featheral.com').get(legacy.id).body, legacy.body);
});
test('live widget slots are mandatory and unique, cannot shadow shell IDs, and can be reordered', t => {
  const { pages } = fixture(t);
  const page = pages.pages('dollar.featheral.com').find(page => page.template === 'index.html');
  const slot = `<cms-widget name="${page.widgets[0]}"></cms-widget>`;
  assert.ok(page.body.includes(slot));
  for (const body of [page.body.replace(slot, ''), page.body + slot, page.body + '<p id="walletButton">Shadow</p>',
    page.body + '<p id="primaryStats">Shadow</p>', page.body.replace(slot, '<cms-widget name="unknown"></cms-widget>')]) {
    assert.throws(() => pages.save('dollar.featheral.com', page.id, { body, revision: page.revision }), { status: 400 });
  }
  const body = slot + page.body.replace(slot, '');
  pages.save('dollar.featheral.com', page.id, { body, revision: page.revision });
  const html = pages.render('dollar.featheral.com', page.template);
  for (const id of ['heroTip', 'primaryStats', 'blockRows', 'txRows', 'holderRows', 'fileStats', 'signingInfo', 'refreshStats']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.match(html, /src="\/fth\.js"/);
  assert.match(html, /src="\/landing\.js"/);
});
test('document HTML allows rich safe links but rejects executable markup, unsafe URLs and invalid input', () => {
  for (const body of [null, '', '<script>alert(1)</script>', '<img src="/logo.svg" onerror="bad()">', '<iframe src="https://example.com"></iframe>',
    '<p style="display:none">Hidden</p>', '<a href="javascript:alert(1)">Bad</a>', '<a href="jav&#97;script:alert(1)">Bad</a>',
    '<a href="//example.com">Bad</a>', '<img src="data:text/html,bad">', '<p id="same">One</p><p id="same">Two</p>']) {
    assert.throws(() => validateBody(body, {}), { status: 400 });
  }
  assert.match(validateBody('<a href="https://example.com" target="_blank">Safe</a>', {}), /rel="noopener noreferrer"/);
  for (const site of ['notes', 'sites', 'stats', 'wallet', 'app', 'silver', 'ledger']) {
    assert.match(validateBody(`<a data-site="${site}" href="https://${site}.featheral.com/">Site</a>`, {}), new RegExp(`data-site="${site}"`));
  }
  assert.throws(() => validateBody('<a data-site="unknown" href="/">Bad</a>', {}), { status: 400 });
});
test('Foundation home and guide describe every current site without demo, placeholder or deployed-rollup claims', t => {
  const { pages } = fixture(t);
  for (const file of ['index.html', 'docs/index.html']) {
    const html = pages.render('featheral.com', file);
    for (const site of ['foundation', 'gold', 'silver', 'app', 'dollar', 'world', 'x', 'ex', 'notes', 'sites', 'stats', 'wallet']) {
      assert.ok(html.includes(`data-site="${site}"`), `${file}: ${site}`);
    }
    assert.match(html, /admin\.featheral\.com/);
    assert.doesNotMatch(html, /data-site="(?:admin|cms)"/);
    assert.doesNotMatch(html, /Coming soon|Demo only|demo exchange|Local simulation|~\$0\.01|This page is a placeholder/);
    assert.match(html, /not a deployed Layer 3 rollup/);
    assert.match(html, /Gold/);
    assert.match(html, /Notes/);
    assert.match(html, /Assets, Send, Receive, Swap, Activity and Account/);
    assert.match(html, /no (?:manual )?public-(?:wallet )?sync button/i);
    assert.doesNotMatch(html, /Convert FTHG into FTH\$ to play/);
    const targets = [];
    const walk = node => {
      const source = node.attrs?.find(attr => attr.name === 'src')?.value;
      if (source?.startsWith('/shared/')) targets.push(source);
      for (const child of node.childNodes || []) walk(child);
    };
    walk(parseFragment(html));
    for (const target of targets) {
      const local = target === '/shared/wallet-profile.js' ? path.join(root, 'sites', 'wallet.featheral.com', 'wallet-profile.js')
        : path.join(root, ...target.slice(1).split('/'));
      assert.ok(fs.existsSync(local), target);
    }
  }
  const governance = pages.render('featheral.com', 'governance/index.html');
  assert.match(governance, /does not announce a DAO/);
  assert.match(governance, /fresh signature/);
  assert.match(governance, /not a US-dollar redemption claim/);
});
const oldFoundationDocs = {
  title: 'Docs · Featheral Foundation',
  excerpt: 'Ecosystem-wide documentation covering the Foundation, token design and the layer architecture.',
  body: '<section class="hero">\n  <img class="hero-logo" src="/shared/logo.svg" alt="" width="112" height="112">\n  <h1>Docs</h1>\n  <p class="lead">Ecosystem-wide documentation covering the Foundation, token design and the layer architecture.</p>\n  <p class="muted">Coming soon. This page is a placeholder.</p>\n  <div class="cta"><a class="btn" href="/">Back to Featheral Foundation</a></div>\n</section>',
};
test('exact old published Foundation defaults upgrade once with a revision and survive reopening', t => {
  const { pages, directory } = fixture(t);
  const template = pages.documents.template('featheral.com', 'docs/index.html');
  const old = { ...oldFoundationDocs, body: validateBody(oldFoundationDocs.body, {}, template.layout) };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex');
  assert.ok(template.replaces.includes(fingerprint), 'the shipped upgrade fingerprint matches the actual old published page');
  const store = pages.store('featheral.com');
  const original = store.save({ ...old, slug: template.slug, type: 'page', status: 'publish' });
  const upgraded = pages.pages('featheral.com').find(page => page.slug === template.slug);
  assert.equal(upgraded.id, original.id);
  assert.equal(upgraded.revision, original.revision + 1);
  assert.equal(upgraded.title, template.title);
  assert.equal(upgraded.excerpt, template.description);
  assert.match(upgraded.body, /Every site, one purpose at a time/);
  assert.doesNotMatch(upgraded.body, /data-cms-copy|placeholder/);
  assert.equal(store.revisions(original.id).length, 1);
  assert.equal(store.revisions(original.id)[0].snapshot.body, original.body);
  pages.pages('featheral.com');
  assert.equal(store.get(original.id).revision, upgraded.revision, 'reading again must not rewrite the page');
  pages.close();
  const reopened = new SitePages({ root, dataDir: directory });
  try {
    assert.match(reopened.render('featheral.com', template.file), /Every site, one purpose at a time/);
    assert.equal(reopened.store('featheral.com').get(original.id).revision, upgraded.revision);
  } finally { reopened.close(); }
});
test('Foundation default upgrades preserve custom body, metadata and draft edits', t => {
  const { pages } = fixture(t);
  const template = pages.documents.template('featheral.com', 'docs/index.html');
  const store = pages.store('featheral.com');
  let page = store.save({ ...oldFoundationDocs, body: validateBody(oldFoundationDocs.body, {}, template.layout),
    slug: template.slug, type: 'page', status: 'publish' });
  const variants = [
    { title: 'My edited title' }, { excerpt: 'My edited description' },
    { body: '<section><h1>My custom page</h1></section>' }, { status: 'draft' },
  ];
  for (const variant of variants) {
    page = store.save({ ...page, ...oldFoundationDocs, ...variant, revision: page.revision }, page.id);
    const current = pages.pages('featheral.com').find(item => item.id === page.id);
    assert.equal(current.body, page.body);
    assert.equal(current.title, page.title);
    assert.equal(current.excerpt, page.excerpt);
    assert.equal(current.status, page.status);
    assert.equal(current.revision, page.revision);
  }
});
async function foundationStats(fetch) {
  const nodes = { goldStat: {}, dollarStat: {} }, errors = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'shared', 'foundation.js'), 'utf8'), {
    document: { getElementById: id => nodes[id] }, fetch, AbortSignal,
    console: { error: (...args) => errors.push(args) },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, errors };
}
test('Foundation stats use Gold and Note APIs with exact large supplies and no invented USD estimates', async () => {
  const calls = [];
  const ui = await foundationStats(async url => {
    calls.push(url);
    return { ok: true, json: async () => url.includes('/gold/')
      ? { chain: { id: 1, totalSupply: '216265000000000000000000000' } }
      : { ledger: { supply: '9007199254740993000000000000000001', height: 42, holders: 12 } } };
  });
  assert.deepEqual(calls, ['/api/v1/gold/stats', '/api/v1/notes/fth/stats?blocks=1&transactions=1&holders=1']);
  assert.equal(ui.nodes.goldStat.textContent, '216,265,000 FTHG total supply');
  assert.equal(ui.nodes.dollarStat.textContent, '9,007,199,254,740,993+ FTH$ supply · 12 holders · block #42');
  assert.doesNotMatch(ui.nodes.goldStat.textContent, /USD|\$/);
  assert.deepEqual(ui.errors, []);
});
test('Foundation stats explicitly disclose failed and malformed upstream reads rather than claiming success', async () => {
  for (const fetch of [
    async () => { throw new Error('Offline'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({ chain: { id: 5, totalSupply: '1000' }, ledger: { supply: 'bad' } }) }),
  ]) {
    const ui = await foundationStats(fetch);
    assert.equal(ui.nodes.goldStat.textContent, 'Ethereum data unavailable');
    assert.equal(ui.nodes.dollarStat.textContent, 'Native ledger data unavailable');
    assert.equal(ui.errors.length, 2);
    assert.ok(ui.nodes.goldStat.title);
  }
});
test('Foundation supply widgets fail independently and reject unsafe native ledger counts', async () => {
  for (const failed of ['gold', 'notes']) {
    const ui = await foundationStats(async url => ({
      ok: !url.includes(`/${failed}/`), status: 503,
      json: async () => ({ chain: { id: 1, totalSupply: '1000000000000000000' },
        ledger: { supply: '2000000000000000000', height: 7, holders: 3 } }),
    }));
    assert.equal(ui.errors.length, 1);
    assert.equal(ui.nodes.goldStat.textContent, failed === 'gold' ? 'Ethereum data unavailable' : '1 FTHG total supply');
    assert.equal(ui.nodes.dollarStat.textContent, failed === 'notes' ? 'Native ledger data unavailable' : '2 FTH$ supply · 3 holders · block #7');
  }
  for (const holders of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const ui = await foundationStats(async () => ({ ok: true, json: async () => ({
      chain: { id: 1, totalSupply: '0' }, ledger: { supply: '0', height: 0, holders },
    }) }));
    assert.equal(ui.nodes.goldStat.textContent, '0 FTHG total supply');
    assert.equal(ui.nodes.dollarStat.textContent, 'Native ledger data unavailable');
    assert.equal(ui.errors.length, 1);
  }
});
test('deployment snapshots include complete published documents and editable metadata', t => {
  const { pages } = fixture(t);
  const snapshot = pages.snapshot().filter(site => ['featheral.com', 'gold.featheral.com', 'dollar.featheral.com'].includes(site.hostname));
  assert.equal(snapshot.flatMap(site => site.pages).length, 7);
  for (const site of snapshot) for (const page of site.pages) {
    assert.equal(typeof page.title, 'string');
    assert.equal(typeof page.excerpt, 'string');
    assert.match(page.body, /<section/);
    assert.doesNotMatch(page.body, /data-cms-copy/);
  }
});
test('deployment imports full-page HTML, title, description and theme into a restored CMS', t => {
  const { pages, directory } = fixture(t);
  const original = pages.pages('featheral.com').find(page => page.template === 'docs/index.html');
  const saved = pages.save('featheral.com', original.id, { title: 'Deployed docs', excerpt: 'Deployed description',
    body: '<article><h1>Deployed full page</h1><a href="/governance/">Governance</a></article>', revision: original.revision });
  pages.theme('featheral.com', 'forest');
  const snapshot = { integrated: pages.snapshot().filter(site => site.hostname === 'featheral.com'), managed: [] };
  const target = path.join(directory, 'release');
  const documents = path.join(target, 'sites', 'admin.featheral.com', 'documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.cpSync(path.join(root, 'sites', 'admin.featheral.com', 'documents', 'featheral.com'), path.join(documents, 'featheral.com'), { recursive: true });
  const cmsData = path.join(target, 'services', 'cms', 'data');
  fs.mkdirSync(cmsData, { recursive: true });
  fs.writeFileSync(path.join(cmsData, 'sites.json'), '[]');
  fs.writeFileSync(path.join(target, '.cms-published.json'), JSON.stringify(snapshot));
  const script = path.join(root, 'scripts', 'import-site-pages.js');
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require: createRequire(script), __dirname: path.join(target, 'scripts') });
  const restored = new SitePages({ root: target, dataDir: cmsData });
  try {
    const imported = restored.pages('featheral.com').find(page => page.slug === saved.slug);
    assert.equal(imported.title, saved.title);
    assert.equal(imported.excerpt, saved.excerpt);
    assert.equal(imported.body, saved.body);
    assert.equal(restored.theme('featheral.com').theme, 'forest');
    assert.match(restored.render('featheral.com', original.template), /Deployed full page/);
  } finally { restored.close(); }
});
