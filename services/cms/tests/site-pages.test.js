const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SitePages } = require('../lib/site-pages');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-pages-'));
  const directory = path.join(root, 'sites', 'world.featheral.com');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), '<html><head></head><body><h2 id="welcome-title" data-cms-copy="welcome">Welcome <b>World</b></h2><p data-cms-copy="intro">Explore safely.</p><form><p>Wallet balance</p><button>Sign</button></form><div id="profileEditor"><p>Profile</p></div><script>window.app=true</script></body></html>');
  const pages = new SitePages({ root, dataDir: path.join(root, 'data') });
  t.after(() => { pages.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, pages };
}
test('native CMS templates preserve applications and formatting until prose is edited', t => {
  const { pages } = fixture(t);
  const blocks = pages.pages('world.featheral.com');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(page => page.type === 'page' && page.status === 'publish'));
  const html = pages.render('world.featheral.com', 'index.html');
  assert.match(html, /Welcome <b>World<\/b>/);
  assert.match(html, /<script>window.app=true<\/script>/);
  assert.match(html, /<form><p>Wallet balance<\/p>/);
});
test('publishing is revision checked, escaped and durable across template whitespace changes', t => {
  const { pages, root } = fixture(t);
  const page = pages.pages('world.featheral.com')[0];
  const saved = pages.save('world.featheral.com', page.id, { body: '<script>bad()</script>\nNew title', revision: page.revision });
  assert.equal(saved.revision, page.revision + 1);
  assert.throws(() => pages.save('world.featheral.com', page.id, { body: 'Old draft', revision: page.revision }), { status: 409 });
  assert.throws(() => pages.save('world.featheral.com', page.id, { body: 'No revision' }), { status: 400 });
  const file = path.join(root, 'sites', 'world.featheral.com', 'index.html');
  fs.writeFileSync(file, '\n\n' + fs.readFileSync(file, 'utf8'));
  assert.match(pages.render('world.featheral.com', 'index.html'), /&lt;script&gt;bad\(\)&lt;\/script&gt;<br>New title/);
  assert.equal(pages.pages('world.featheral.com').length, 2);
});
test('themes are allowlisted and traversal cannot access arbitrary application files', t => {
  const { pages } = fixture(t);
  pages.theme('world.featheral.com', 'ocean');
  assert.match(pages.render('world.featheral.com', 'index.html'), /data-cms-theme="ocean"/);
  assert.throws(() => pages.theme('world.featheral.com', '<style>'), { status: 400 });
  assert.throws(() => pages.blocks('world.featheral.com', '../index.html'), { status: 404 });
  assert.throws(() => pages.store('../../private'), { status: 404 });
});
test('renaming the CMS frontend preserves its existing private content database and theme', t => {
  const { pages } = fixture(t);
  fs.mkdirSync(pages.directory, { recursive: true });
  const CmsStore = require('../lib/cms');
  const legacy = new CmsStore(path.join(pages.directory, 'cms.featheral.com.sqlite'));
  const saved = legacy.save({ title: 'Existing admin text', body: 'Do not lose these edits', type: 'page', status: 'publish' });
  legacy.db.prepare("INSERT INTO cms_settings(key,value) VALUES ('site_theme','forest')").run();
  legacy.close();
  assert.equal(pages.store('admin.featheral.com').get(saved.id).body, saved.body);
  assert.equal(pages.theme('admin.featheral.com').theme, 'forest');
  assert.equal(fs.existsSync(path.join(pages.directory, 'admin.featheral.com.sqlite')), false);
});
test('catalog includes every local application, including non-editable central wallet', t => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-catalog-'));
  const pages = new SitePages({ root, dataDir });
  t.after(() => { pages.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const catalog = pages.catalog();
  for (const entry of fs.readdirSync(path.join(root, 'sites'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    assert.ok(catalog.some(site => site.hostname === entry.name), `Missing application: ${entry.name}`);
  }
  const wallet = catalog.find(site => site.hostname === 'wallet.featheral.com');
  assert.equal(wallet.cmsCompatible, false); assert.equal(wallet.contentEditable, false); assert.equal(wallet.management, 'classic');
  assert.match(pages.presentation(wallet.hostname).tagline, /FTHG|wallet/i);
  assert.deepEqual(pages.templates(wallet.hostname), []);
  assert.ok(!pages.snapshot().some(site => site.hostname === wallet.hostname));
});
test('new hostname-named applications are discovered as Classic without requiring CMS registration', t => {
  const { root } = fixture(t);
  const directory = path.join(root, 'sites', 'native.featheral.com');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'index.html'), '<html><head><meta name="description" content="Native app"></head><body><main>Application</main></body></html>');
  const pages = new SitePages({ root, dataDir: path.join(root, 'native-data') });
  t.after(() => pages.close());
  const site = pages.catalog().find(site => site.hostname === 'native.featheral.com');
  assert.equal(site.management, 'classic'); assert.equal(site.cmsCompatible, false);
  assert.equal(site.contentEditable, false);
  assert.equal(pages.presentation(site.hostname).tagline, 'Native app');
});
