const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SitePages } = require('../lib/site-pages');
const { badges, logo } = require('../../../scripts/build-site-logos');
const colors = require('../../../shared/site-colors.json');

const root = path.resolve(__dirname, '..', '..', '..');
test('all core badges preserve the main SVG and have distinct symbols', () => {
  const base = fs.readFileSync(path.join(root, 'shared', 'logo.svg'), 'utf8');
  assert.equal(new Set(Object.values(badges)).size, 14);
  for (const name of Object.keys(badges)) {
    const generated = fs.readFileSync(path.join(root, 'shared', `logo-${name}.svg`), 'utf8');
    assert.equal(generated, logo(base, name));
    const palette = colors[`${name}.featheral.com`];
    assert.ok(generated.startsWith(base.trim().replace('</svg>', '').replace(/#ffe27a/g, palette.light).replace(/#c8891a/g, palette.color).replace(/#1b1608/g, palette.dark)));
    assert.match(generated, new RegExp(`aria-label="${name} badge"`));
    const document = ['gold', 'dollar'].includes(name)
      ? JSON.parse(fs.readFileSync(path.join(root, 'sites', 'admin.featheral.com', 'documents', `${name}.featheral.com`, 'document-index-html.json'), 'utf8'))
      : null;
    const shell = document ? document.layout + document.body
      : fs.readFileSync(path.join(root, 'sites', `${name}.featheral.com`, ...(name === 'world' ? ['play', 'index.html'] : ['index.html'])), 'utf8');
    assert.match(shell, new RegExp(`rel="icon"[^>]*href="/shared/logo-${name}\\.svg"`));
    assert.match(shell, new RegExp(`<img[^>]*src="/shared/logo-${name}\\.svg"`));
  }
  assert.equal(fs.readFileSync(path.join(root, 'sites', 'x.featheral.com', 'logo.svg'), 'utf8'), logo(base, 'x'));
  assert.equal(fs.readFileSync(path.join(root, 'sites', 'world.featheral.com', 'play', 'public', 'favicon.svg'), 'utf8'), logo(base, 'world'));
  assert.equal(new Set(Object.values(colors).map(palette => palette.color)).size, 14);
});

test('Gold published content uses the badge without rewriting user edits or revisions', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-logos-'));
  const pages = new SitePages({ root, dataDir });
  t.after(() => { pages.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const home = pages.pages('gold.featheral.com').find(page => page.template === 'index.html');
  const body = home.body.replace('/shared/logo-gold.svg', '/shared/logo.svg');
  pages.save('gold.featheral.com', home.id, { ...home, title: 'My edited Gold title', body });
  const before = pages.store('gold.featheral.com').get(home.id);
  const html = pages.render('gold.featheral.com', 'index.html');
  assert.match(html, /<title>My edited Gold title<\/title>/);
  assert.match(html, /class="hero-logo" src="\/shared\/logo-gold.svg"/);
  assert.deepEqual(pages.store('gold.featheral.com').get(home.id), before);
});

test('every World game entry uses the shared World favicon', () => {
  const game = path.join(root, 'sites', 'world.featheral.com', 'play');
  for (const directory of ['', 'explore', 'bank', 'communicate', 'help', 'market', 'federation', 'journal', 'settlement', 'whitepaper']) {
    const html = fs.readFileSync(path.join(game, directory, 'index.html'), 'utf8');
    assert.match(html, /rel="icon" href="\/shared\/logo-world.svg"/);
  }
});
