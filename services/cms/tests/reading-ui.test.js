const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'sites/x.featheral.com/site.js'), 'utf8');
const votes = source.slice(source.indexOf('function readingVotes('), source.indexOf('// ---------- liked'));
const tabs = source.slice(source.indexOf('function likedTabs('), source.indexOf('async function likedView('));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(api, options) {
  const calls = [], errors = [], events = new Map(), target = { innerHTML: '',
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  const context = vm.createContext({
    api: async (url, opts) => { calls.push({ url, opts }); return api(url, opts); },
    AbortController, fmtNum: String, esc: String, toast: message => errors.push(message),
    rewardNote() {}, loadReadingNavigation() {},
  });
  vm.runInContext(votes, context);
  const stop = context.readingVotes({ id: -10 }, target, options);
  return { calls, errors, target, stop, events, click(kind) {
    events.get('click')({ target: { closest: selector => selector === '[data-reading-vote]' ? { dataset: { readingVote: kind } } : null } });
  } };
}

test('reading vote controls never vote on load, deduplicate clicks, and support dislike/undo with the authoritative round', async () => {
  let resolve;
  const f = fixture(async (url, opts) => {
    if (url.includes('/curation?')) return { type: 'read', round: 1, likes: 0, dislikes: 0, vote: null, canRestore: true };
    return new Promise(done => { resolve = () => done({ type: 'read', round: 1, likes: 0,
      dislikes: opts.json.vote === 'none' ? 0 : 1, deleted: opts.json.vote !== 'none' }); });
  });
  await tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.target.innerHTML, /Round 1/);
  f.click('dislike'); f.click('dislike');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].opts.json)), { id: -10, type: 'read', round: 1, vote: 'dislike' });
  resolve(); await tick();
  assert.match(f.target.innerHTML, /In Trash/);
  f.click('dislike');
  assert.equal(f.calls[2].opts.json.vote, 'none');
  resolve(); await tick();
  assert.doesNotMatch(f.target.innerHTML, /In Trash/);
  f.stop(); assert.equal(f.events.size, 0);
});

test('Read card controls reuse list state without extra requests and share delete, undo and later-round rules', async () => {
  const initialState = { type: 'read', round: 1, likes: 0, dislikes: 0, vote: null, canRestore: true };
  const f = fixture(async (_url, opts) => ({ ...initialState, deleted: opts.json.vote === 'dislike',
    dislikes: opts.json.vote === 'dislike' ? 1 : 0 }), { compact: true, initialState });
  assert.equal(f.calls.length, 0);
  assert.match(f.target.innerHTML, />Delete 0/);
  assert.doesNotMatch(f.target.innerHTML, /href=/);
  f.click('dislike'); await tick();
  assert.equal(f.calls[0].opts.json.type, 'read');
  assert.equal(f.calls[0].opts.json.round, 1);
  assert.match(f.target.innerHTML, /In Trash/);
  f.click('dislike'); await tick();
  assert.equal(f.calls[1].opts.json.vote, 'none');
  assert.doesNotMatch(f.target.innerHTML, /In Trash/);
  f.stop();
  const later = fixture(async () => ({}), { compact: true, initialState: { ...initialState, round: 2 } });
  assert.doesNotMatch(later.target.innerHTML, />Delete/);
  assert.match(later.target.innerHTML, /Dislike 0/);
  assert.match(later.target.innerHTML, /without removing this reading/);
  later.stop();
  const list = source.slice(source.indexOf('async function readListView('), source.indexOf('async function readerView('));
  assert.match(list, /<\/a><div class="reading-card-votes"/);
  assert.match(list, /stopVotes.forEach\(stop => stop\(\)\)/);
});

test('reading controls handle errors and disposal without reintroducing stale buttons', async () => {
  let resolve, attempts = 0;
  const f = fixture(async url => {
    if (url.includes('/curation?')) {
      if (++attempts > 1) throw Error('Status unavailable');
      return { type: 'read', round: 2, likes: 0, dislikes: 0, vote: null, canRestore: true };
    }
    return new Promise(done => { resolve = () => done({ type: 'read', round: 2, vote: 'like', likes: 1, dislikes: 0 }); });
  });
  await tick();
  f.click('like'); f.stop();
  const before = f.target.innerHTML;
  resolve(); await tick();
  assert.equal(f.target.innerHTML, before);
  const error = fixture(async () => { throw Error('Status unavailable'); });
  await tick();
  assert.match(error.target.innerHTML, /Status unavailable/);
  assert.match(error.target.innerHTML, /data-retry-reading-votes/);
  error.stop();
});

test('Read cards are removed only after confirmed deletion, never for a pending, failed or later-round dislike', async () => {
  let resolve, removed = 0;
  const initialState = { type: 'read', round: 1, likes: 0, dislikes: 0, vote: null, canRestore: true };
  const f = fixture(() => new Promise(done => { resolve = done; }), {
    compact: true, initialState, onDeleted() { removed++; f.stop(); },
  });
  f.click('dislike');
  assert.equal(removed, 0);
  resolve({ ...initialState, deleted: true });
  await tick();
  assert.equal(removed, 1);
  assert.equal(f.events.size, 0);
  const later = fixture(async () => ({ ...initialState, round: 2, deleted: false }), {
    compact: true, initialState: { ...initialState, round: 2 }, onDeleted() { removed++; },
  });
  later.click('dislike'); await tick();
  assert.equal(removed, 1);
  later.stop();
  const failed = fixture(async url => {
    if (url.includes('/curation?')) return initialState;
    throw Error('Vote failed');
  }, { compact: true, initialState, onDeleted() { removed++; } });
  failed.click('dislike'); await tick();
  assert.equal(removed, 1);
  assert.deepEqual(failed.errors, ['Vote failed']);
  failed.stop();
  const list = source.slice(source.indexOf('async function readListView('), source.indexOf('async function readerView('));
  assert.match(list, /card.remove\(\)/);
  assert.match(list, /r.total--/);
  assert.match(list, /No readings left on this page/);
  assert.match(list, /focus\(\{ preventScroll: true \}\)/);
});

test('Trash readings use the shared responsive card grid with equal-height rows', () => {
  assert.match(source, /id="trash-readings" class="reading-cards"/);
  const css = fs.readFileSync(path.join(root, 'sites/x.featheral.com/site.css'), 'utf8');
  assert.match(css, /#trash-readings \{ grid-auto-rows: 1fr/);
  assert.doesNotMatch(css, /#trash-readings \.entry \{ display: block/);
});

test('Liked offers only media and readings, drops legacy folder filters and supports keyboard navigation', () => {
  const context = vm.createContext({ fmtNum: String,
    esc: value => String(value).replace(/</g, '&lt;'),
    href: (parts, query) => '#/' + parts.join('/') + '?' + new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString() });
  vm.runInContext(tabs, context);
  const html = context.likedTabs({ kind: 'read', sort: 'recent', collection: 'abc' });
  assert.match(html, /aria-selected="true" tabindex="0"[^>]+>Readings/);
  assert.match(html, /kind=read/);
  assert.doesNotMatch(html, /collection=|Private|Folders/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  let focused = -1, clicked = -1;
  const nodes = Array.from({ length: 3 }, (_, i) => ({ focus() { focused = i; }, click() { clicked = i; } }));
  context.likedTabKeys({ key: 'ArrowRight', target: nodes[0], currentTarget: { querySelectorAll: () => nodes }, preventDefault() {} });
  assert.equal(focused, 1); assert.equal(clicked, 1);
  context.likedTabKeys({ key: 'End', target: nodes[1], currentTarget: { querySelectorAll: () => nodes }, preventDefault() {} });
  assert.equal(clicked, 2);
});

test('sidebar refreshes keep CMS page links current and ignore obsolete responses', async () => {
  const pending = [], target = { innerHTML: '' }, info = { pages: [] };
  const context = vm.createContext({ info, $: () => target, esc: String, fmtNum: String, readingCategoryIcon: () => '<svg aria-hidden="true"></svg>',
    api: () => new Promise(resolve => pending.push(resolve)), readingLink: page => `#/page/${page.slug}`,
    href: () => '#/read', parseHash: () => ({ parts: ['read'] }), setTab() {} });
  vm.runInContext(source.slice(source.indexOf('let readingNavigation ='), source.indexOf('async function render()')), context);
  const old = context.loadReadingNavigation(), current = context.loadReadingNavigation();
  pending[1]({ pages: [{ id: -2, slug: 'current', title: 'Current page' }], categories: [] });
  await current;
  pending[0]({ pages: [{ id: -1, slug: 'obsolete', title: 'Obsolete page' }], categories: [] });
  await old;
  assert.match(target.innerHTML, /Current page/);
  assert.doesNotMatch(target.innerHTML, /Obsolete page/);
  assert.equal(info.pages[0].slug, 'current');
});

test('reading layout is exclusive to Read and readers, and loads navigation only on demand', () => {
  const sidebar = { hidden: true }, details = { open: false }, classes = new Set();
  let requests = 0, compact = true;
  const context = vm.createContext({
    $: selector => selector === '.site-sidebar' ? sidebar : details,
    document: { body: { classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } } } },
    window: { matchMedia: () => ({ matches: compact }) },
    loadReadingNavigation() { requests++; },
  });
  vm.runInContext('let readingNavigation = null, readingNavigationRequest = 0;\n' +
    source.slice(source.indexOf('function readingLayout('), source.indexOf('async function loadReadingNavigation(')), context);
  for (const route of [[], ['trending'], ['thumbs'], ['liked'], ['trash'], ['post'], ['shop'], ['exchange']]) {
    context.readingLayout(route);
    assert.equal(sidebar.hidden, true);
    assert.equal(classes.size, 0);
  }
  assert.equal(requests, 0, 'media routes do not fetch reading navigation');
  context.readingLayout(['read']);
  assert.equal(sidebar.hidden, false);
  assert(classes.has('has-site-sidebar'));
  assert.equal(details.open, false, 'compact reading navigation starts collapsed');
  assert.equal(requests, 1);
  vm.runInContext('readingNavigation = { pages: [], categories: [] };', context);
  details.open = true;
  context.readingLayout(['read', '10']);
  assert.equal(details.open, true, 'reading navigation preserves the visitor toggle');
  assert.equal(requests, 1);
  context.readingLayout(['liked']);
  assert.equal(sidebar.hidden, true);
  compact = false;
  context.readingLayout(['page', 'fthx']);
  assert.equal(details.open, true, 'desktop readers open the sidebar');
  context.readingLayout(['trash']);
  assert.equal(sidebar.hidden, true);
  assert.equal(classes.size, 0);
});

test('Trash stays in the header with a decorative icon and Read alone owns the responsive layout', () => {
  const html = fs.readFileSync(path.join(root, 'sites/x.featheral.com/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'sites/x.featheral.com/site.css'), 'utf8');
  assert.match(html, /class="site-sidebar"[^>]+hidden/);
  assert.doesNotMatch(html, /<body class="has-site-sidebar">/);
  assert.doesNotMatch(html.match(/<aside class="site-sidebar"[\s\S]*?<\/aside>/)[0], /#\/trash|trash-button/);
  assert.match(html, /href="#\/trash" data-tab="trash" aria-label="Trash"/);
  const trashLink = html.match(/<a href="#\/trash" data-tab="trash"[\s\S]*?<\/a>/)[0];
  assert.match(trashLink, /<svg class="trash-icon"[^>]+aria-hidden="true"/);
  assert.doesNotMatch(trashLink, /<span>|🦝/);
  assert.doesNotMatch(html, /data-cms-page="fthx/);
  assert.match(css, /\.reading-cards \{[^}]+repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(source, /label for="q">Search readings/);
  assert.match(source, /setSelectionRange\(selection, selection\)/);
  assert.match(source, /category, tag, page, limit: 30/);
  assert.match(source, /kind: 'read'/);
  assert.match(source, /if \(readings\) grid.className = 'reading-liked-list reading-cards'/);
  const liked = source.slice(source.indexOf('async function likedView('), source.indexOf('function justifyRows('));
  const trash = source.slice(source.indexOf('async function trashView('), source.indexOf('async function trashView(') + 1800);
  assert.doesNotMatch(liked, /originalSize: true|tile original-tile/);
  assert.doesNotMatch(trash, /originalSize: true|tile original-tile/);
  assert.match(liked, /previews: true, minWidth: 250, minColumns: 2, groupBy:/);
  assert.doesNotMatch(source, /data-folders|data-organize|folder-create|folderDialog|\/api\/public\/collections/);
});

test('category keyword chips preserve search, sort and category, reset paging and escape names', () => {
  const context = vm.createContext({ fmtNum: String,
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    href: (parts, query) => '#/' + parts.join('/') + '?' + new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString() });
  vm.runInContext(source.slice(source.indexOf('function readingKeywords('), source.indexOf('async function readListView(')), context);
  const html = context.readingKeywords([{ id: 8, name: '<Name>', count: 15 }], { category: '6', tag: '8', q: 'sample', sort: 'newest', page: '3' });
  assert.match(html, /aria-label="Category keywords"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /#&lt;Name>/);
  assert.doesNotMatch(html, /<Name>|page=|trending/);
  assert.match(html, /q=sample&sort=newest&category=6&tag=8/);
  assert.match(html, /Clear keyword filter/);
  assert.match(context.readingKeywords([], { category: '6' }), /No keywords yet/);
  assert.match(context.readingKeywords([], { category: '6', tag: '999' }), /Clear keyword filter/);
  const list = source.slice(source.indexOf('async function readListView('), source.indexOf('async function readerView('));
  assert.match(list, /sort, category, tag, \.\.\.patch/);
  assert.match(list, /sort, category, tag, page: r\.page - 1/);
  assert.match(list, /sort, category, tag, page: r\.page \+ 1/);
});

test('reading thumbnails use lazy bounded previews, site scoping, and reject invalid media', () => {
  const context = vm.createContext({ TYPE_LABEL: { png: 'PNG', jpeg: 'JPG', gif: 'GIF' }, esc: String,
    publicUrl: url => '/tenant' + url });
  vm.runInContext(source.slice(source.indexOf('function readingThumbnail('), source.indexOf('function readingEntry(')), context);
  const html = context.readingThumbnail({ id: 8, thumbnail: { type: 'gif' } });
  assert.match(html, /src="\/tenant\/api\/public\/posts\/8\/preview\?type=gif"/);
  assert.match(html, /width="80" height="80" loading="lazy" decoding="async" alt=""/);
  for (const item of [{ id: -1, thumbnail: { type: 'png' } }, { id: 1 }, { id: 1, thumbnail: { type: 'read' } }]) {
    assert.equal(context.readingThumbnail(item), '');
  }
  const css = fs.readFileSync(path.join(root, 'sites/x.featheral.com/site.css'), 'utf8');
  assert.match(css, /\.reading-thumbnail \{[^}]+width: 80px; height: 80px/);
  assert.match(css, /\.reading-thumbnail \{[^}]+width: 64px; height: 64px/);
  assert.equal((source.match(/\$\{readingThumbnail\((?:item|t)\)\}/g) || []).length, 2, 'Read and shared Liked/Trash cards render previews');
});

test('reading category icons are decorative, semantic, and have a consistent fallback', () => {
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function readingCategoryIcon('), source.indexOf('let readingNavigation =')), context);
  const news = context.readingCategoryIcon('News');
  assert.match(news, /<svg class="category-icon"[^>]+aria-hidden="true"/);
  assert.notEqual(news, context.readingCategoryIcon('Stories'));
  assert.equal(context.readingCategoryIcon('Other'), context.readingCategoryIcon('<script>'));
  assert.doesNotMatch(context.readingCategoryIcon('<script>'), /<script>/);
  assert.match(source, /section class="reading-nav-group" aria-labelledby="reading-pages-title"/);
  assert.match(source, /section class="reading-nav-group reading-categories" aria-labelledby="reading-categories-title"/);
});

test('reading details show uncropped original media and provide an explicit loading error and retry', () => {
  const image = { dataset: { src: '/tenant/api/public/posts/8/media?type=gif' } }, status = {}, retry = {};
  const context = vm.createContext({ TYPE_LABEL: { png: 'PNG', jpeg: 'JPG', gif: 'GIF' }, esc: String,
    publicUrl: url => '/tenant' + url, $: selector => selector === 'img' ? image : selector === 'figcaption' ? status : retry });
  vm.runInContext(source.slice(source.indexOf('function readingMedia('), source.indexOf('function readingEntry(')), context);
  const html = context.readingMedia({ id: 8, title: 'A GIF', thumbnail: { type: 'gif' } });
  assert.match(html, /data-src="\/tenant\/api\/public\/posts\/8\/media\?type=gif"/);
  assert.doesNotMatch(html, /\/preview\?/);
  assert.equal(context.readingMedia({ id: -1, title: 'Text only' }), '');
  context.loadReadingMedia({});
  assert.equal(image.src, image.dataset.src);
  assert.equal(status.textContent, 'Loading media...');
  image.onerror();
  assert.equal(status.textContent, 'Media could not be loaded.');
  assert.equal(retry.hidden, false);
  retry.onclick();
  assert.equal(retry.hidden, true);
  image.onload();
  assert.equal(status.hidden, true);
  const reader = source.slice(source.indexOf('async function readerView('), source.indexOf('function readingVotes('));
  assert(reader.indexOf('${readingMedia(t)}') < reader.indexOf('<article>'));
  assert.match(reader, /mediaImage.removeAttribute\('src'\)/);
});
