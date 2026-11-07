const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { PublicSite } = require('../lib/public');
const { SitePages } = require('../lib/site-pages');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'sites', 'x.featheral.com', 'site.js'), 'utf8');

test('public curation startup never creates tables or migrates an older read-only snapshot', t => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const implementation = fs.readFileSync(path.join(root, 'services', 'cms', 'lib', 'public.js'), 'utf8');
  const code = implementation.slice(implementation.indexOf('class Curation {'), implementation.indexOf('module.exports ='));
  const Curation = vm.runInNewContext(`${code}; Curation`, { open: () => db });
  new Curation(':memory:', null, 'test');
  db.exec('DROP TABLE saved_media; DROP TABLE media_collections; ALTER TABLE trash DROP COLUMN dup_of; ALTER TABLE member_posts DROP COLUMN video');
  const before = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  db.readOnlyReplica = true; db.exec('PRAGMA query_only=ON');
  const replica = new Curation(':memory:', null, 'test');
  assert.equal(replica.ledgerTable, 'qprn_ledger');
  assert.equal(replica.addView(1), 0);
  assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), before);
});

test('reading lists, details and liked summaries expose only available local thumbnail types', () => {
  const rows = [1, 2, 3].map(ID => ({ ID, post_title: `Reading ${ID}`, post_content: 'A short story.', post_date: '2026-01-01' }));
  const metrics = new Map([
    [1, { wordCount: 3, imageBest: { png: { url: '/uploads/one.png' } } }],
    [2, { wordCount: 3, imageBest: { gif: { url: 'https://other.invalid/two.gif' } } }],
    [3, { wordCount: 3 }],
  ]);
  const subject = Object.assign(Object.create(PublicSite.prototype), {
    site: { memo: { publicPosts: rows, publicIds: new Set([1, 2, 3]) }, trashed: new Set(), mediaBase: '/uploads',
      has: () => false, t: table => table, postMetrics: () => metrics, all: () => rows, get: (_sql, id) => rows.find(row => row.ID === id) },
    cms: { published: () => [] }, store: { viewCounts: () => new Map() },
  });
  const list = subject.textList({});
  assert.deepEqual(list.items.find(item => item.id === 1).thumbnail, { type: 'png' });
  for (const id of [2, 3]) assert.equal(list.items.find(item => item.id === id).thumbnail, null);
  assert.deepEqual(subject.text(1).thumbnail, { type: 'png' });
  assert.deepEqual(subject.readingSummary(1).thumbnail, { type: 'png' });
  assert(!Object.hasOwn(subject.readingSummary(1), 'paragraphs'));
  assert.equal(subject.readingThumbnail(-10), null);
  assert.equal(subject.cmsText({ id: 10, title: 'Page', body: 'Words here' }).thumbnail, null);
  const calls = [];
  subject.curation = (id, type) => { calls.push([id, type]); return { id, type, round: 2, likes: 3, dislikes: 1, vote: 'like', canRestore: true }; };
  assert(list.items.every(item => !Object.hasOwn(item, 'curation')), 'default text API remains lightweight');
  const cards = subject.textList({ curation: '1' });
  assert.equal(calls.length, cards.items.length);
  assert(calls.every(([, type]) => type === 'read'));
  assert(cards.items.every(item => item.curation.round === 2 && item.curation.vote === 'like'));
});

test('bootstrap metadata skips all media indexes and totals while preserving gate, pages, theme and features', () => {
  const settings = { ageGate: true, homepage: 'media', displayName: 'Custom brand', description: 'Custom description' };
  const calls = [];
  const site = {
    site: { options: () => ({}), trashed: new Set(), key: 'test' }, store: {}, brand: 'Brand',
    cms: { siteSettings: () => settings, theme: () => 'studio', publicPages: () => [{ slug: 'home', title: 'Home' }] },
    status: type => { calls.push(type); return { total: 10 }; },
    mixStatus: () => { calls.push('mix'); return { total: 30 }; },
    thumbList: () => { calls.push('thumbs'); return { total: 5 }; },
    textList: () => { calls.push('texts'); return { total: 8 }; },
  };
  const bootstrap = PublicSite.prototype.info.call(site, { counts: false });
  assert.deepEqual(calls, []);
  assert.equal(bootstrap.siteSettings.ageGate, true);
  assert.equal(bootstrap.brand, settings.displayName);
  assert.equal(bootstrap.theme, 'studio');
  assert.equal(bootstrap.pages[0].slug, 'home');
  assert(!Object.hasOwn(bootstrap, 'mix'));
  const full = PublicSite.prototype.info.call(site);
  assert.deepEqual(calls, ['gif', 'jpeg', 'png', 'mix', 'thumbs', 'texts']);
  assert.equal(full.mix.total, 30);
  assert.equal(full.texts, 8);
});
test('startup warms only the primary media site before accepting requests and exposes indexing failures', () => {
  const server = fs.readFileSync(path.join(root, 'services', 'cms', 'server.js'), 'utf8');
  const start = server.indexOf('const primaryPublicKey =');
  const code = server.slice(start, server.indexOf('notes.validateBalances();', start));
  assert(start < server.indexOf('module.exports = app;'));
  const calls = [];
  const context = {
    CONFIG: { publicHost: 'x.featheral.com', siteKey: 'single' },
    siteManager: { records: [{ hostname: 'other.example', key: 'other' }, { hostname: 'x.featheral.com', key: 'primary' }] },
    publicByKey: key => ({ cms: { siteSettings: () => ({ homepage: 'media' }) }, warmFeed: () => calls.push(key) }),
  };
  vm.runInNewContext(code, context);
  assert.deepEqual(calls, ['primary']);
  vm.runInNewContext(code, { ...context, siteManager: null });
  assert.deepEqual(calls, ['primary', 'single']);
  vm.runInNewContext(code, { ...context, publicByKey: () => ({ cms: { siteSettings: () => ({ homepage: 'content' }) } }) });
  assert.deepEqual(calls, ['primary', 'single']);
  assert.throws(() => vm.runInNewContext(code, { ...context, publicByKey: () => {
    throw new Error('Primary media indexing failed');
  } }), /Primary media indexing failed/);
});

function preloadFixture(connection, items) {
  const policySource = source.slice(source.indexOf('function mediaPreloadPolicy('), source.indexOf('function swipeView('));
  const preloadSource = source.slice(source.indexOf('  function preload() {'), source.indexOf('  function mediaFor(item) {'));
  const media = new Map(), state = { queue: items, history: [] };
  const context = vm.createContext({ navigator: { connection }, state, media, disposed: false, mediaFor(item) {
    const value = { img: { removeAttribute(name) { delete this[name]; } }, done: false, started: false };
    media.set(item.id, value);
    return value;
  } });
  vm.runInContext(policySource + '\nconst PRELOAD = mediaPreloadPolicy();\n' + preloadSource, context);
  return { media, state, cardMedia: item => context.mediaFor(item), preload: () => context.preload(), dispose: () => { context.disposed = true; } };
}
const item = (id, size = 1024 ** 2) => ({ id, media: { size, url: `/media/${id}.gif` } });
test('preloading prioritizes the visible card, limits lookahead and never starts a large background GIF', () => {
  const f = preloadFixture({}, [item(1), item(2), item(3), item(4)]);
  f.preload();
  assert.equal(f.media.size, 1, 'only visible media competes for bandwidth before its load completes');
  assert.equal(f.media.get(1).img.fetchPriority, 'high');
  f.media.get(1).done = true;
  f.preload();
  assert.equal(f.media.size, 3);
  assert.equal(f.media.get(2).img.fetchPriority, 'low');
  const large = preloadFixture({}, [item(1), item(2, 15 * 1024 ** 2)]);
  large.preload(); large.media.get(1).done = true; large.preload();
  assert.equal(large.media.size, 1, 'lookahead is bounded to 12 MiB including the visible card');
  large.state.queue.shift(); large.preload();
  assert.equal(large.media.get(2).img.fetchPriority, 'high', 'a large current card is still usable');
});
test('data-saver and 2G connections fetch only the visible card', () => {
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    const f = preloadFixture(connection, [item(1), item(2)]);
    f.preload(); f.media.get(1).done = true; f.preload();
    assert.equal(f.media.size, 1);
  }
});
test('decoded swipe lookahead fills five small cards without exceeding two concurrent loads or the byte budget', () => {
  const f = preloadFixture({}, Array.from({ length: 12 }, (_, i) => item(i + 1)));
  f.preload();
  for (let i = 0; i < 5; i++) {
    for (const media of f.media.values()) media.done = true;
    f.preload();
    assert([...f.media.values()].filter(media => media.started && !media.done).length <= 2);
  }
  assert.equal(f.media.size, 5);
  assert.equal([...f.media.values()].filter(media => media.img.src).length, 5);
});
test('swipe lookahead also bounds decoded pixels for highly compressed large images', () => {
  const f = preloadFixture({}, [1, 2, 3].map(id => ({ id, media: { size: 1024, width: 4000, height: 3000, url: `/media/${id}` } })));
  f.preload(); f.media.get(1).done = true; f.preload();
  assert.equal(f.media.size, 1, 'an oversized visible image cannot admit more decoded originals');
});
test('swiping promotes download priority, cancels unfinished history and never restarts after disposal', () => {
  const f = preloadFixture({}, [item(1), item(2), item(3)]);
  f.preload(); f.media.get(1).done = true; f.preload();
  assert.equal(f.media.get(2).img.fetchPriority, 'low');
  f.state.history.push({ item: f.state.queue.shift() }); f.preload();
  assert.equal(f.media.get(2).img.fetchPriority, 'high');
  const previous = f.media.get(2);
  f.state.history.push({ item: f.state.queue.shift() }); f.preload();
  assert(!f.media.has(2));
  assert.equal(previous.img.src, undefined, 'unfinished history cannot compete with the visible card');
  assert.equal(f.media.get(3).img.fetchPriority, 'high');
  f.dispose(); f.media.clear(); f.preload();
  assert.equal(f.media.size, 0, 'late load/error events cannot restart abandoned downloads');
});
test('a budget-excluded back card retains its DOM image for promotion without downloading early', () => {
  const f = preloadFixture({}, [item(1), item(2, 15 * 1024 ** 2)]);
  f.preload();
  const back = f.cardMedia(f.state.queue[1]);
  f.media.get(1).done = true; f.preload();
  assert.equal(f.media.get(2), back);
  assert.equal(back.img.src, undefined);
  f.state.queue.shift(); f.preload();
  assert.equal(f.media.get(2), back);
  assert.equal(back.img.src, '/media/2.gif');
  assert.equal(back.img.fetchPriority, 'high');
});
test('undo cannot consume history during an animation and starts restored media afterward', () => {
  const start = source.indexOf('  function undo() {');
  const undoSource = source.slice(start, source.indexOf('\n  ensure();', start));
  const state = { busy: true, history: [{ item: item(1) }], queue: [], remaining: 0 };
  let paints = 0, downloads = 0, votes = 0;
  const context = vm.createContext({ state, disposed: false, stack: { querySelector: () => null },
    send: () => votes++, paint: () => paints++, preload: () => downloads++ });
  vm.runInContext(undoSource, context);
  context.undo();
  assert.equal(state.history.length, 1);
  assert.equal(votes, 0);
  state.busy = false; context.undo();
  assert.equal(state.queue[0].id, 1);
  assert.equal(votes, 1);
  assert.equal(paints, 1);
  assert.equal(downloads, 1);
});
test('X boot requests lightweight metadata once and card construction does not bypass the preload budget', () => {
  const boot = source.slice(source.indexOf("window.addEventListener('DOMContentLoaded'"));
  assert.match(boot, /api\('\/api\/public\/info\?bootstrap=1'\)/);
  const route = source.slice(source.indexOf('async function render('), source.indexOf('// ---------- swipe deck'));
  assert.doesNotMatch(route, /api\('\/api\/public\/info'\)/);
  const card = source.slice(source.indexOf('  function cardEl('), source.indexOf('  function paint()'));
  assert.doesNotMatch(card, /\.img\.src\s*=/);
  const html = fs.readFileSync(path.join(root, 'sites', 'x.featheral.com', 'index.html'), 'utf8');
  assert.match(html, /role="status">Loading your feed/);
  assert.match(html, /<script defer src="\/site\/site.js"/);
});

test('CMS template and rendered caches reuse unchanged work and invalidate on code, content and theme edits', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-performance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const templates = path.join(directory, 'sites', 'admin.featheral.com', 'documents', 'featheral.com');
  const classic = path.join(directory, 'sites', 'silver.featheral.com');
  fs.mkdirSync(templates, { recursive: true }); fs.mkdirSync(classic, { recursive: true });
  const file = path.join(templates, 'home.json'), classicFile = path.join(classic, 'index.html');
  const template = { file: 'index.html', slug: 'home', title: 'Home', body: '<h1>Hello</h1>', widgets: {},
    layout: '<html><head><title>Home</title></head><body class="home">{{CMS_DOCUMENT}}</body></html>' };
  fs.writeFileSync(file, JSON.stringify(template));
  fs.writeFileSync(classicFile, '<html><head></head><body><h1 data-cms-copy="heading">Hello</h1></body></html>');
  const pages = new SitePages({ root: directory, dataDir: path.join(directory, 'data') });
  t.after(() => pages.close());
  const firstTemplate = pages.documents.template('featheral.com', 'index.html');
  assert.equal(pages.documents.template('featheral.com', 'index.html'), firstTemplate);
  const first = pages.render('featheral.com', 'index.html'), cached = pages.documents.rendered.get('featheral.com/index.html');
  assert.equal(pages.render('featheral.com', 'index.html'), first);
  assert.equal(pages.documents.rendered.get('featheral.com/index.html'), cached);
  const store = pages.store('featheral.com'), page = store.publishedPage('home');
  pages.save('featheral.com', page.id, { body: '<h1>Updated content</h1>', revision: page.revision });
  assert.match(pages.render('featheral.com', 'index.html'), /Updated content/);
  assert.notEqual(pages.documents.rendered.get('featheral.com/index.html'), cached);
  pages.theme('featheral.com', 'ocean');
  assert.match(pages.render('featheral.com', 'index.html'), /data-cms-theme="ocean"/);
  const current = store.publishedPage('home');
  pages.save('featheral.com', current.id, { body: current.body, title: 'New title', excerpt: 'New description', revision: current.revision });
  assert.match(pages.render('featheral.com', 'index.html'), /<title>New title<\/title>/);
  fs.writeFileSync(file, JSON.stringify({ ...template, layout: template.layout.replace('class="home"', 'class="new-layout"') }));
  assert.match(pages.render('featheral.com', 'index.html'), /class="new-layout cms-layout"/);
  const blocks = pages.blocks('silver.featheral.com', 'index.html');
  assert.equal(pages.blocks('silver.featheral.com', 'index.html'), blocks);
  fs.writeFileSync(classicFile, '<html><head></head><body><h1 data-cms-copy="heading">Updated template</h1></body></html>');
  assert.notEqual(pages.blocks('silver.featheral.com', 'index.html'), blocks);
  assert.match(pages.render('silver.featheral.com', 'index.html'), /Updated template/);
});
