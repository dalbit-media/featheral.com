const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/x.featheral.com/site.js'), 'utf8');
const controller = source.slice(source.indexOf('function mediaGrid('), source.indexOf('function likedDate('));
const rows = source.slice(source.indexOf('function justifyRows('), source.indexOf('// Gap-free justified rows'));
const item = (id, media = {}) => ({ id, media: { url: `/media/${id}`, width: 160, height: 120, size: 1024, type: 'jpeg', ...media } });

function fixture(items, options = {}, connection = {}) {
  const frames = new Map(), timers = new Map(), handlers = new Map(), docHandlers = new Map();
  let serial = 0, top = 0, created = 0, requests = 0;
  const grid = {
    children: [], style: {}, clientWidth: 1000,
    getBoundingClientRect: () => ({ top }),
    append(el) { this.children.push(el); },
  };
  const context = vm.createContext({
    navigator: { connection }, innerHeight: 800, document: {
      hidden: false, addEventListener: (key, fn) => docHandlers.set(key, fn), removeEventListener: key => docHandlers.delete(key),
      createElement: () => ({ style: {}, remove() { grid.children = grid.children.filter(child => child !== this); } }),
    },
    window: { addEventListener: (key, fn) => handlers.set(key, fn), removeEventListener: key => handlers.delete(key) },
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(controller + rows, context);
  const gallery = context.mediaGrid(grid, items, value => {
    created++;
    const img = {
      removeAttribute() { delete this.url; },
      set src(url) { this.url = url; requests++; }, get src() { return this.url; },
    };
    const el = { dataset: {}, style: {}, img, querySelector: () => img,
      remove() { grid.children = grid.children.filter(child => child !== this); } };
    value.el = el;
    return el;
  }, options);
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn()); };
  return {
    grid, gallery, context, handlers, frames, timers,
    get created() { return created; }, get requests() { return requests; },
    loaded: () => grid.children.filter(el => el.img?.src),
    active: () => grid.children.filter(el => el.dataset?.mediaState === 'loading'),
    flush, scroll(y) { top = -y; handlers.get('scroll')(); flush(); },
    settleScroll() { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); flush(); },
    hidden(value) { context.document.hidden = value; docHandlers.get('visibilitychange')(); flush(); },
    complete() { const active = grid.children.filter(el => el.dataset?.mediaState === 'loading'); active.forEach(el => el.img.onload()); flush(); },
  };
}

test('10,000 grid items retain at most 80 tiles and two in-flight images during fast scrolling', () => {
  const items = Array.from({ length: 10000 }, (_, i) => item(i));
  const f = fixture(items);
  f.gallery.layout(); f.flush();
  assert(f.grid.children.length <= 80);
  assert.equal(f.active().length, 2);
  f.complete();
  const requested = f.requests, released = [...f.grid.children], late = f.active()[0].img.onload;
  for (let y = 4000; y <= 40000; y += 4000) {
    f.scroll(y);
    assert(f.grid.children.length <= 80);
    assert(f.active().length <= 2);
  }
  assert.equal(f.requests, requested, 'fast scrolling must not start transient media downloads');
  assert(released.every(el => !el.img.src), 'offscreen image sources are removed');
  late(); f.flush();
  assert.equal(f.requests, requested, 'late completion cannot restart abandoned downloads');
  f.settleScroll();
  assert.equal(f.active().length, 2);
  assert(f.grid.children.every(el => +el.dataset.i > 500));
  f.gallery.close();
  assert.equal(f.grid.children.length, 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test('GIFs, byte and pixel budgets remain bounded and oversized media stays accessible', () => {
  for (const [media, maximum] of [
    [{ type: 'gif' }, 2], [{ size: 10 * 1024 * 1024 }, 2],
    [{ width: 4000, height: 3000 }, 2], [{ size: 30 * 1024 * 1024 }, 1],
  ]) {
    const f = fixture(Array.from({ length: 200 }, (_, i) => item(i, media)));
    f.gallery.layout(); f.flush();
    for (let i = 0; i < 30; i++) f.complete();
    assert(f.loaded().length > 0);
    assert(f.loaded().length <= maximum);
    assert(f.grid.children.some(el => el.dataset.mediaState === 'paused'), 'budget-excluded tiles remain available to open');
    f.gallery.close();
  }
});

test('Data Saver uses one in-flight request; hidden tabs and viewers release all grid media', () => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => item(i)), {}, { saveData: true });
  f.gallery.layout(); f.flush();
  assert.equal(f.active().length, 1);
  f.gallery.pause(true); f.flush();
  assert.equal(f.grid.children.length, 0);
  f.gallery.pause(false); f.flush();
  assert.equal(f.active().length, 1);
  f.hidden(true);
  assert.equal(f.grid.children.length, 0);
  f.hidden(false);
  assert.equal(f.active().length, 1);
  f.gallery.close();
  f.gallery.layout(); f.flush();
  assert.equal(f.grid.children.length, 0);
});

test('appending, deleting and restoring items preserves visible identity, indexes and full scroll height', () => {
  const items = Array.from({ length: 100 }, (_, i) => item(i));
  const f = fixture(items, { justified: true, maxH: 250 });
  f.gallery.layout(); f.flush(); f.complete();
  const original = items[0], tile = original.el, oldHeight = parseInt(f.grid.style.height);
  items.push(...Array.from({ length: 100 }, (_, i) => item(i + 100)));
  f.gallery.layout(); f.flush();
  assert.equal(original.el, tile, 'append must not restart visible media');
  assert(parseInt(f.grid.style.height) > oldHeight);
  items.shift(); f.gallery.layout(); f.flush();
  assert.equal(original.el, null);
  for (const el of f.grid.children) assert.equal(items[+el.dataset.i].el, el);
  items.unshift(original); f.gallery.layout(); f.flush();
  assert(original.el);
  for (const el of f.grid.children) assert.equal(items[+el.dataset.i].el, el);
  f.gallery.close();
});

test('justified layout preserves original row selection without quadratic list compaction', () => {
  const context = vm.createContext({});
  vm.runInContext(rows, context);
  const sample = context.justifyRows({ style: {} }, [100, 200, 300].map(width => item(width, { width, height: 100 })), 600);
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), [
    { index: 0, x: 0, y: 0, w: 98, h: 98 },
    { index: 1, x: 104, y: 0, w: 196, h: 98 },
    { index: 2, x: 306, y: 0, w: 294, h: 98 },
  ]);
  let reads = 0;
  const items = Array.from({ length: 10000 }, (_, i) => ({ media: {
    get width() { reads++; return 100 + i % 200; }, height: 80 + i % 300,
  } }));
  const grid = { style: {} }, positions = context.justifyRows(grid, items, 1000, 6, { maxH: 240 });
  assert.equal(positions.length, items.length);
  assert.equal(new Set(positions.map(p => p.index)).size, items.length);
  assert.equal(reads, items.length, 'dimensions are read once per item, not once per lookahead');
  for (let i = 1; i < positions.length; i++) assert(positions[i].y >= positions[i - 1].y);
  for (const p of positions) assert(p.x >= 0 && p.x + p.w <= 1000 && p.h > 0 && p.h <= 240);
});

test('Liked uses large cards and windowed date headings without increasing media budgets', () => {
  const items = Array.from({ length: 240 }, (_, i) => item(i));
  const f = fixture(items, { minWidth: 320, groupBy: v => ({ key: String(Math.floor(v.id / 24)), label: 'Date' }) });
  f.gallery.layout(); f.flush();
  const tiles = f.grid.children.filter(el => el.img);
  assert(tiles.length <= 9);
  assert(tiles.every(el => /width:328px/.test(el.style.cssText)));
  assert.equal(f.grid.children.filter(el => !el.img).length, 1);
  assert.equal(f.active().length, 2);
  f.scroll(3600); f.settleScroll();
  assert(f.grid.children.filter(el => !el.img).length <= 2);
  f.gallery.pause(true); assert.equal(f.grid.children.length, 0);
  f.gallery.close();
});

test('pagination reflows only unfinished lookahead rows with exact full-layout geometry', () => {
  const context = vm.createContext({});
  vm.runInContext(rows, context);
  const items = [], cache = {};
  let reads = 0;
  for (let page = 0; page < 15; page++) {
    const offset = items.length;
    items.push(...Array.from({ length: 80 }, (_, i) => ({ media: {
      get width() { reads++; return 50 + (offset + i) % 310; }, height: 50 + (offset + i) % 270,
    } })));
    const before = reads;
    const actual = context.justifyRows({ style: {} }, items, 1000, 6, { maxH: 240, cache });
    assert(reads - before < 120, 'append reads only the new page and at most 39 unfinished items');
    const expected = context.justifyRows({ style: {} }, items, 1000, 6, { maxH: 240 });
    assert.deepEqual(actual, expected);
  }
  const resized = context.justifyRows({ style: {} }, items, 600, 6, { maxH: 240, cache });
  assert.deepEqual(resized, context.justifyRows({ style: {} }, items, 600, 6, { maxH: 240 }));
});

test('all three routes use the bounded grid and only viewers directly load original sources', () => {
  const routes = source.slice(source.indexOf('async function likedView('), source.indexOf('function openViewer('));
  assert.equal((routes.match(/mediaGrid\(grid,/g) || []).length, 3);
  assert.equal((routes.match(/gallery\.close\(\)/g) || []).length, 2);
  assert.equal((routes.match(/signal: request.signal/g) || []).length, 6);
  assert.doesNotMatch(routes, /loading="lazy"/);
  assert.equal((routes.match(/<img src=/g) || []).length, 0, 'all routes leave source loading to the bounded grid and shared viewer');
});

test('Liked infinite paging deduplicates requests, rearms after success and stops on errors or route exit', async () => {
  const liked = source.slice(source.indexOf('async function likedView('), source.indexOf('// ---------- thumbnail gallery'));
  const loader = liked.slice(liked.indexOf('  function loadMore()'), liked.indexOf('  async function fetchPage()'));
  let resolve, reject, calls = 0, observed = 0;
  const sentinel = {};
  const context = vm.createContext({
    disposed: false, more: true, pending: null, closeViewer: null,
    $: () => sentinel,
    paging: { unobserve: node => assert.equal(node, sentinel), observe: node => { assert.equal(node, sentinel); observed++; } },
    fetchPage: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); },
  });
  vm.runInContext(loader, context);
  const first = context.loadMore();
  assert.equal(first, context.loadMore());
  assert.equal(calls, 1);
  resolve(); await first;
  assert.equal(observed, 1, 'short pages recheck whether the sentinel is still near the viewport');
  const failed = context.loadMore(); reject(new Error('Offline'));
  await assert.rejects(failed, /Offline/);
  assert.equal(observed, 1, 'errors must not cause an automatic retry loop');
  context.closeViewer = () => {};
  const viewer = context.loadMore(); resolve(); await viewer;
  assert.equal(observed, 1, 'viewer continuation does not start background paging');
  context.closeViewer = null;
  const late = context.loadMore(); context.disposed = true; resolve(); await late;
  assert.equal(observed, 1);
  await context.loadMore(); assert.equal(calls, 4);
  context.disposed = false; context.more = false;
  await context.loadMore(); assert.equal(calls, 4);
  assert.match(liked, /paging\?\.disconnect\(\)/);
  assert.match(liked, /!disposed && !closeViewer && entries\.some\(entry => entry\.isIntersecting\)/);
  assert.match(liked, /rootMargin: '600px 0px'/);
});
