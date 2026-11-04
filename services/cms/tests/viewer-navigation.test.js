const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/x.featheral.com/site.js'), 'utf8');
const viewer = source.slice(source.indexOf('function openViewer('), source.indexOf('// ---------- new post'));
const item = id => ({ id, title: `Post ${id}`, media: { url: `/media/${id}`, type: 'jpeg', size: 100 } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(list, opts = {}) {
  const calls = [], views = [], handlers = new Map(), nodes = new Map();
  let box, modal = false;
  const node = () => ({ innerHTML: '', textContent: '', disabled: false, complete: false,
    addEventListener() {}, removeAttribute() {}, remove() {}, classList: { toggle() {} } });
  const context = vm.createContext({
    document: {
      createElement: () => (box = { ...node(), events: new Map(), addEventListener(key, fn) { this.events.set(key, fn); } }),
      body: { append() {} }, querySelector: () => modal ? {} : null,
      addEventListener: (key, fn) => handlers.set(key, fn), removeEventListener: key => handlers.delete(key),
    },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    esc: String, fmtNum: String, fmtBytes: String, TYPE_LABEL: { jpeg: 'JPG' }, wallet: {}, info: {},
    countView: value => views.push(value.id), toast: message => calls.push({ error: message }),
    api: async url => { calls.push({ url }); return { total: 0, items: [] }; },
  });
  vm.runInContext(viewer, context);
  const close = context.openViewer(list, 0, opts);
  const media = { closest: selector => selector === '.vmedia' ? {} : null };
  const pointer = (kind, x, y, target = media) => box.events.get(kind)({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: y, target });
  return { close, calls, views, handlers, nodes, box, pointer,
    modal: value => { modal = value; }, key: key => handlers.get('keydown')({ key, target: { closest: () => null } }),
    title: () => /<b>(.*?)<\/b>/.exec(box.innerHTML)[1] };
}

test('viewer swipes and keyboard navigation load comments but never vote; vertical gestures and dialogs do not navigate', async () => {
  const f = fixture([item(1), item(2)]);
  assert.equal(f.title(), 'Post 1');
  f.pointer('pointerdown', 300, 100); f.pointer('pointerup', 100, 105);
  assert.equal(f.title(), 'Post 2');
  f.pointer('pointerdown', 100, 100); f.pointer('pointerup', 115, 300);
  assert.equal(f.title(), 'Post 2');
  f.pointer('pointerdown', 100, 100, { closest: () => null }); f.pointer('pointerup', 300, 100);
  assert.equal(f.title(), 'Post 2', 'comment-panel gestures are not media swipes');
  f.modal(true); f.key('ArrowLeft'); assert.equal(f.title(), 'Post 2');
  f.modal(false); f.key('ArrowLeft'); assert.equal(f.title(), 'Post 1');
  await tick();
  assert(f.calls.every(call => call.url?.endsWith('/comments')), 'navigation only reads comments');
  assert.deepEqual(f.views, [1, 2, 1]);
  f.close(); assert.equal(f.handlers.size, 0);
});

test('viewer continues pagination once, ignores duplicate steps while loading and cannot reopen after close', async () => {
  const list = [item(1)];
  let resolve, loads = 0;
  const f = fixture(list, { hasMore: () => list.length < 2, loadMore: () => {
    loads++;
    return new Promise(done => { resolve = () => { list.push(item(2)); done(); }; });
  } });
  f.key('ArrowRight'); f.key('ArrowRight');
  assert.equal(loads, 1);
  assert.equal(f.title(), 'Post 1');
  resolve(); await tick();
  assert.equal(f.title(), 'Post 2');
  assert.deepEqual(f.views, [1, 2]);
  f.close();
  const next = [item(1)];
  const closed = fixture(next, { hasMore: () => true, loadMore: () => new Promise(done => {
    resolve = () => { next.push(item(2)); done(); };
  }) });
  closed.key('ArrowRight'); closed.close(); resolve(); await tick();
  assert.deepEqual(closed.views, [1], 'late page completion must not show or count new media');
});
