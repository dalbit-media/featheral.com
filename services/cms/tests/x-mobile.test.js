const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/x.featheral.com/site.js'), 'utf8');
const warmCode = source.slice(source.indexOf('const imageBuffer ='), source.indexOf('function initialMediaRequest('));

test('viewer and startup media warmup respects Data Saver, parallelism, byte budget and cached decodes', async () => {
  const requests = [], warnings = [], timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    mediaPreloadPolicy: () => context.policy,
    publicUrl: url => '/tenant' + url,
    Image: class {
      set src(value) { this.url = value; requests.push(this); }
      decode() { return Promise.resolve(); }
      removeAttribute() { delete this.url; }
    },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    policy: { bytes: 12 * 1024 * 1024, parallel: 2, maxCards: 5 },
  });
  vm.runInContext(warmCode + '\nglobalThis.buffer = imageBuffer;', context);
  const items = Array.from({ length: 3 }, (_, id) => ({ id, media: { size: 1024, type: 'png', url: `/api/media/${id}` } }));
  const pending = context.warmImages(items);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].fetchPriority, 'high');
  assert.equal(requests[1].fetchPriority, 'low');
  requests.forEach(image => image.onload());
  await pending;
  await context.warmImages(items);
  assert.equal(requests.length, 2, 'reuse decoded media for the same URLs');
  context.policy.bytes = 0; context.policy.maxCards = 1;
  await context.warmImages(items);
  assert.equal(requests.length, 2, 'Data Saver starts no speculative requests');
  context.policy.bytes = 12 * 1024 * 1024;
  await context.warmImages([{ id: 9, media: { url: '/huge.gif', size: 30 * 1024 * 1024 } }]);
  assert.equal(requests.length, 2, 'large GIFs are left to the foreground loader');
  assert.equal(timers.size, 0);
  assert.equal(warnings.length, 0);
});

test('initial loading splash has a hard 1.5-second budget, reuses the initial response and follows warning acceptance', async () => {
  const gate = { hidden: true, innerHTML: '' }, cache = new Map(), timers = new Map();
  let calls = 0;
  const context = vm.createContext({
    document: { body: { dataset: { standalone: 'x' } } }, location: { hash: '#/' },
    initialMediaRequest: () => ['/api/public/feed?type=mix&limit=20', false],
    $: () => gate, warmedRequests: cache, gateBackground() {},
    api: () => { calls++; return new Promise(() => {}); },
    warmImages() {}, toast: message => assert.fail(message),
    setTimeout: (fn, delay) => { assert.equal(delay, 1500); timers.set(1, fn); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source.slice(source.indexOf('async function primeInitialView('), source.indexOf('// ---------- age gate & boot')), context);
  const pending = context.primeInitialView();
  assert.equal(gate.hidden, false);
  assert.match(gate.innerHTML, /role="status"/);
  assert.equal(cache.size, 1); assert.equal(calls, 1);
  timers.get(1)();
  await pending;
  assert.equal(gate.hidden, true); assert.equal(timers.size, 0);
  const boot = source.slice(source.indexOf("window.addEventListener('DOMContentLoaded'"));
  assert(boot.indexOf('await gate()') < boot.indexOf('await primeInitialView()'), 'no media warmup before explicit warning consent');
});

test('reading and image viewers use the same guest-capable comment component and authoritative vote type', () => {
  assert.match(source, /mountComments\(t, \$\('#reading-comments'\)/);
  assert.match(source, /mountComments\(v, \$\('.post-comments', box\)/);
  assert.match(source, /type: state.type, round: state.round/);
  assert.match(source, /!wallet.address && !info.guestComments/);
  assert.match(source, /if \(disposed \|\| posting \|\| deleted\) return/);
  assert.match(source, /request.abort\(\); sequence\+\+/);
  const css = fs.readFileSync(path.resolve(__dirname, '../../../sites/x.featheral.com/standalone.css'), 'utf8');
  assert.match(css, /height: 100dvh; min-height: 0; padding: 0/);
  assert.match(css, /header.top \{[\s\S]*?backdrop-filter: none; pointer-events: none/);
  assert.match(css, /\.card h2 \{ font-size: 14px/);
  assert.match(css, /\.viewer.comments-open \.vside \{ visibility: visible/);
});
test('shared comment rendering escapes visitor content and never presents visitors as wallet owners', () => {
  const context = vm.createContext({
    wallet: {}, esc: value => String(value).replace(/[<>"&]/g, character => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[character])),
  });
  vm.runInContext(source.slice(source.indexOf('function commentHtml('), source.indexOf('function mountComments(')), context);
  const result = context.commentHtml({ id: 1, author: 'Visitor', content: '<script>alert("x")</script>' });
  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<script|data-cdel|title="0x/);
});
