const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'sites/x.featheral.com/site.js'), 'utf8');
const votes = source.slice(source.indexOf('function readingVotes('), source.indexOf('// ---------- liked'));
const tabs = source.slice(source.indexOf('function likedTabs('), source.indexOf('async function likedView('));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(api) {
  const calls = [], errors = [], events = new Map(), target = { innerHTML: '',
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  const context = vm.createContext({
    api: async (url, opts) => { calls.push({ url, opts }); return api(url, opts); },
    AbortController, fmtNum: String, esc: String, toast: message => errors.push(message),
    rewardNote() {}, loadReadingNavigation() {},
  });
  vm.runInContext(votes, context);
  const stop = context.readingVotes({ id: -10 }, target);
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

test('Liked tabs preserve route filters, escape private folder names and support keyboard navigation', () => {
  const context = vm.createContext({ fmtNum: String,
    esc: value => String(value).replace(/</g, '&lt;'),
    href: (parts, query) => '#/' + parts.join('/') + '?' + new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString() });
  vm.runInContext(tabs, context);
  const html = context.likedTabs({ kind: 'read', sort: 'recent' }, [{ id: 'abc', name: '<Private>', count: 2 }]);
  assert.match(html, /aria-selected="true" tabindex="0"[^>]+>Readings/);
  assert.match(html, /kind=read/);
  assert.match(html, /collection=abc/);
  assert.match(html, /&lt;Private>/);
  assert.doesNotMatch(html, /<Private>/);
  let focused = -1, clicked = -1;
  const nodes = Array.from({ length: 3 }, (_, i) => ({ focus() { focused = i; }, click() { clicked = i; } }));
  context.folderTabKeys({ key: 'ArrowRight', target: nodes[0], currentTarget: { querySelectorAll: () => nodes }, preventDefault() {} });
  assert.equal(focused, 1); assert.equal(clicked, 1);
  context.folderTabKeys({ key: 'End', target: nodes[1], currentTarget: { querySelectorAll: () => nodes }, preventDefault() {} });
  assert.equal(clicked, 2);
});

test('sidebar refreshes keep CMS page links current and ignore obsolete responses', async () => {
  const pending = [], target = { innerHTML: '' }, info = { pages: [] };
  const context = vm.createContext({ info, $: () => target, esc: String, fmtNum: String,
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

test('Trash is always discoverable and project pages are only under Read/sidebar, not the overflowing top tabs', () => {
  const html = fs.readFileSync(path.join(root, 'sites/x.featheral.com/index.html'), 'utf8');
  assert.match(html, /class="site-sidebar"[\s\S]*class="trash-link">Trash/);
  assert.match(html, /href="#\/trash" data-tab="trash" aria-label="Trash"/);
  assert.doesNotMatch(html, /data-cms-page="fthx/);
  assert.match(source, /category, page, limit: 30/);
  assert.match(source, /kind: 'read'/);
});
