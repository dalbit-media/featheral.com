const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const unit = 10n ** 18n, now = 1793590000000;
const source = fs.readFileSync(path.join(__dirname, '../../../sites/dollar.featheral.com/fth.js'), 'utf8');
function reference() {
  return { checkedAt: new Date(now).toISOString(), goldCheckedAt: new Date(now).toISOString(),
    goldReference: { numerator: String(10000n * unit * unit), denominator: String(unit), currency: 'FTH$',
      decimals: 18, source: 'opening', indicative: true },
    usdMarket: { usdPerFthg: String(2n * unit), token: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665',
      updatedAt: new Date(now).toISOString() } };
}
function fixture() {
  let time = now, data = reference(), failed = false, calls = [];
  class Clock extends Date { static now() { return time; } }
  const window = {};
  vm.runInNewContext(source, {
    window, Date: Clock, AbortSignal,
    location: { protocol: 'http:', hostname: 'dollar.localhost', port: '8080' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failed) throw new Error('RPC offline');
      return { ok: true, json: async () => url.startsWith('/api/v1/gold') ?
        { goldReserve: { enabled: true, rate: 1000 } } : data };
    },
  });
  return { F: window.FTH, calls, setData(value) { data = value; }, fail() { failed = true; }, tick(ms) { time += ms; } };
}
test('legacy Dollar USD estimates fetch central live references without changing fixed reserve obligations', async () => {
  const f = fixture();
  assert.equal(f.F.usd(unit), 'USD unavailable');
  await f.F.loadRate();
  assert.equal(f.F.state.rate, 1000, 'old finite-reserve obligations are not repriced');
  assert.equal(f.F.usd(10000n * unit), '$2.00', 'USD uses central opening 10000, not reserve obligations 1000');
  assert.equal(f.F.usdValue(unit, 'FTHG'), 2n * unit);
  assert.equal(f.F.usdValue(10000n * unit), 2n * unit);
  const call = f.calls.find(call => call.url.includes('/api/creation/economy/reference'));
  assert.equal(call.url, 'http://wallet.localhost:8080/api/creation/economy/reference');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(f.F.USD_PER_FTHG_ESTIMATE, undefined);
  const live = reference();
  live.goldReference = { ...live.goldReference, numerator: String(5000n * unit * unit), source: 'bridge', indicative: false };
  live.usdMarket.usdPerFthg = String(3n * unit);
  f.setData(live);
  await f.F.refreshRate();
  assert.equal(f.F.usd(10000n * unit), '$6.00');
  const huge = 10n ** 55n + 17n;
  assert.equal(f.F.usdValue(huge), huge * 3n / 5000n);
  assert.equal(f.F.usdAmount(123456789012345678901234n * unit), '$123,456,789,012,345,678,901,234.00');
});
test('legacy USD estimates never retain prices after failures, unknown state, identity mismatch or staleness', async () => {
  const f = fixture(), good = reference();
  for (const data of [
    null, {}, { ...good, error: 'Reader failed' }, { ...good, goldError: 'RPC mismatch' }, { ...good, goldReference: null },
    { ...good, checkedAt: new Date(now - 61000).toISOString() },
    { ...good, checkedAt: new Date(now + 31000).toISOString() },
    { ...good, goldCheckedAt: new Date(now - 61000).toISOString() },
    { ...good, goldReference: { ...good.goldReference, source: 'unknown' } },
    { ...good, goldReference: { ...good.goldReference, denominator: '0' } },
    { ...good, usdMarket: null },
    ...[{ usdPerFthg: '0' }, { usdPerFthg: '-1' }, { usdPerFthg: 'bad' }, { usdPerFthg: 2 },
      { token: 'wrong' }, { token: null }, { error: 'Feed unavailable' },
      { updatedAt: new Date(now - 301000).toISOString() }]
      .map(market => ({ ...good, usdMarket: { ...good.usdMarket, ...market } })),
  ]) {
    f.setData(data);
    await f.F.refreshRate();
    assert.equal(f.F.usd(unit), 'USD unavailable', JSON.stringify(data));
  }
  f.setData(good); await f.F.refreshRate();
  f.tick(61000);
  assert.equal(f.F.usd(unit), 'USD unavailable', 'an already loaded snapshot expires before a new fetch');
  f.fail(); await f.F.refreshRate();
  assert.equal(f.F.state.reference, null);
  assert.equal(f.F.usdValue(unit, 'FTHG'), null);
});
test('Ethereum USD totals add exact base-unit estimates and never treat missing mainnet balance as zero', async () => {
  const f = fixture();
  await f.F.refreshRate();
  const wallet = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/ethereum/wallet.js'), 'utf8');
  const start = wallet.indexOf('const fthgUsd =');
  const calculation = wallet.slice(start, wallet.indexOf('$("balanceStats").replaceChildren(', start));
  const total = (fthg, balance) => vm.runInNewContext(`${calculation}; totalUsd`, { F: f.F, fthg, balance });
  const balance = 10n ** 55n + 17n;
  assert.equal(total(unit + 17n, balance), f.F.usdValue(unit + 17n, 'FTHG') + f.F.usdValue(balance));
  assert.equal(total(null, balance), null);
  f.fail(); await f.F.refreshRate();
  assert.equal(total(unit, balance), null);
  assert.doesNotMatch(wallet, /USD_PER_FTHG_ESTIMATE|\$0\.01 \/ FTHG reference/);
  const html = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/ethereum/index.html'), 'utf8');
  assert.doesNotMatch(html, /\$0\.01\/FTHG internal reference/);
  assert.doesNotMatch(html, /1,000 FTH\$ \(opening\)/);
  assert.match(html, /Loading executable bridge rate/);
});
