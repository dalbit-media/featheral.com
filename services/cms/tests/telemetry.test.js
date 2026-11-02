const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Telemetry, injectTelemetry } = require('../lib/telemetry');

test('minute counts have 60 UTC buckets, isolate hosts and preserve hourly history', () => {
  const traffic = new Telemetry(':memory:');
  try {
    const now = Date.UTC(2026, 10, 1, 12, 0, 30);
    traffic.hit('one', now - 60 * 60000);
    traffic.hit('one', now - 59 * 60000);
    traffic.hit('one', now - 60000);
    traffic.hit('one', now);
    traffic.hit('one', now);
    traffic.hit('two', now);
    const report = traffic.report(['one', 'two', 'empty'], now);
    assert.equal(report.sites[0].minutely.length, 60);
    assert.equal(report.sites[0].minutely[0].views, 1);
    assert.equal(report.sites[0].minutely.at(-2).views, 1);
    assert.equal(report.sites[0].minutely.at(-1).views, 2);
    assert.equal(report.sites[1].minutely.at(-1).views, 1);
    assert.ok(report.sites[2].minutely.every(row => row.views === 0));
    assert.equal(report.sites[0].daily.at(-1).views, 5);
    assert.equal(traffic.db.prepare('SELECT COUNT(*) AS n FROM traffic_minutely').get().n, 4);
  } finally { traffic.close(); }
});

test('telemetry keeps only per-host hourly counts and returns exact zero-filled UTC hourly/daily windows', () => {
  const traffic = new Telemetry(':memory:');
  try {
    const now = Date.UTC(2026, 10, 1, 10, 30);
    traffic.hit('featheral.com', now);
    traffic.hit('featheral.com', now);
    traffic.hit('featheral.com', now - 3600000);
    traffic.hit('gold.featheral.com', now);
    traffic.hit('featheral.com', now + 3600000);
    traffic.hit('featheral.com', now - 30 * 24 * 3600000);
    const report = traffic.report(['featheral.com', 'gold.featheral.com', 'stats.featheral.com'], now);
    assert.equal(report.timezone, 'UTC');
    assert.equal(report.sites.length, 3);
    for (const site of report.sites) {
      assert.equal(site.hourly.length, 24);
      assert.equal(site.daily.length, 30);
      assert.equal(site.daily.at(-1).at, Date.UTC(2026, 10, 1));
    }
    assert.equal(report.sites[0].hourly.at(-1).views, 2);
    assert.equal(report.sites[0].daily.at(-1).views, 3);
    assert.equal(report.sites[1].daily.at(-1).views, 1);
    assert.ok(report.sites[2].hourly.every(row => row.views === 0));
    assert.equal(report.sites[1].color, require('../../../shared/site-colors.json')['gold.featheral.com'].color);
    assert.equal(report.sites[1].favicon, '/shared/logo-gold.svg');
    const hosted = traffic.report(['sites.featheral.com/my-site'], now).sites[0];
    assert.equal(hosted.hostname, 'sites.featheral.com/my-site');
    assert.equal(hosted.favicon, '/shared/logo-sites.svg');
    assert.deepEqual(traffic.db.prepare('PRAGMA table_info(traffic_hourly)').all().map(row => row.name), ['host', 'hour', 'views']);
  } finally { traffic.close(); }
});
test('collector counts initial and SPA routes once, transmits no route and respects privacy opt-outs and console frames', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'telemetry.js'), 'utf8');
  const run = (navigator = {}, pathname = '/') => {
    const calls = [], events = {};
    const location = { pathname, search: '', hash: '' };
    const history = { pushState() {}, replaceState() {} };
    vm.runInNewContext(source, { navigator, location, history, console, document: { querySelector: () => null },
      fetch: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
      addEventListener: (name, handler) => { events[name] = handler; },
    });
    return { calls, events, location, history };
  };
  for (const navigator of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) assert.equal(run(navigator).calls.length, 0);
  assert.equal(run({}, '/operations/gold/').calls.length, 0);
  const tracked = run();
  assert.equal(tracked.calls.length, 1);
  tracked.events.hashchange();
  assert.equal(tracked.calls.length, 1);
  tracked.location.hash = '#/play?wallet=never-transmitted';
  tracked.history.pushState();
  tracked.events.hashchange();
  assert.equal(tracked.calls.length, 2);
  tracked.location.hash = '';
  tracked.events.popstate();
  assert.equal(tracked.calls.length, 3);
  for (const [url, request] of tracked.calls) {
    assert.equal(url, '/api/telemetry/hit');
    assert.equal(request.body, '{}');
    assert.deepEqual(Object.keys(request.headers), ['Content-Type']);
  }
});
test('native HTTP writeHead and chunked HTML produce valid framing with exactly one collector', async t => {
  const http = require('node:http'), { once } = require('node:events');
  const server = http.createServer((req, res) => {
    injectTelemetry(res);
    injectTelemetry(res);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 30 });
    res.write('<html><body>');
    res.end('Page</body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal((body.match(/shared\/telemetry\.js/g) || []).length, 1);
  assert.match(body, /Page<script src="\/shared\/telemetry.js" defer><\/script><script src="\/shared\/scroll-top.js" defer><\/script><script src="\/shared\/site-links.js" defer><\/script><\/body>/);
  assert.equal((body.match(/shared\/scroll-top\.js/g) || []).length, 1);
  assert.equal((body.match(/shared\/site-links\.js/g) || []).length, 1);
});
test('HTML injection covers buffered and streamed pages, corrects length and never modifies API responses', () => {
  for (const streamed of [true, false]) {
    let result;
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': 30 };
    const res = { statusCode: 200, getHeader: name => headers[name], removeHeader: name => delete headers[name],
      write() {}, end: body => { result = body; } };
    injectTelemetry(res);
    if (streamed) { res.write('<html><body>'); res.end('Page</body></html>'); }
    else res.end('<html><body>Page</body></html>');
    assert.match(result, /src="\/shared\/telemetry.js"/);
    assert.match(result, /src="\/shared\/scroll-top.js"/);
    assert.equal(headers['Content-Length'], undefined);
  }
  let result;
  const res = { statusCode: 200, getHeader: () => 'application/json', write() {}, end: body => { result = body; } };
  injectTelemetry(res);
  res.end('{"ok":true}');
  assert.equal(result, '{"ok":true}');
});
