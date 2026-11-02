const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { PublicSite } = require('../lib/public');
const { units } = require('../lib/economy');
const Templates = require('../lib/templates');
const { SiteManager } = require('../lib/sites');
const CmsStore = require('../lib/cms');
const vm = require('node:vm');
const request = (fields = {}) => ({ ...fields, requestId: crypto.randomUUID() });
function fixture(t, template = 'exchange') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-economy-'));
  const site = {
    dir, manifest: { site: 'Demo' }, memo: {}, options: () => ({}), has: () => false,
    defaultTypes: () => [], postMetrics: () => new Map(), trashed: new Set(),
  };
  let pub = new PublicSite(site, { brand: 'Demo' });
  Templates.install(pub.cms, template);
  t.after(() => { pub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get pub() { return pub; }, restart() { pub.close(); pub = new PublicSite(site, { brand: 'Demo' }); } };
}

test('demo assets parse exact units and reject unsafe, fractional FTHX and malformed inputs', () => {
  assert.equal(units('0.000001', 'FTH$'), 1);
  assert.equal(units('1.234567', 'FTH$'), 1234567);
  assert.equal(units('10', 'FTHX'), 10);
  for (const [value, symbol] of [['0', 'FTH$'], ['-1', 'FTH$'], ['1e6', 'FTH$'], ['1.1', 'FTHX'],
    ['0.0000001', 'FTH$'], ['10000000000000000000', 'FTH$'], [1, 'FTH$'], ['1', 'FAKE']]) {
    assert.throws(() => units(value, symbol), { status: 400 });
  }
});

test('UI minimum outputs enforce the chosen slippage even for whole-credit FTHX', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'ex.featheral.com', 'demos.js'), 'utf8');
  const minimum = vm.runInNewContext(source + '\nminimumAfterSlippage;');
  assert.equal(minimum(4, 100), 4, '1% tolerance must not become a 25% loss after rounding');
  assert.equal(minimum(100, 100), 99);
  assert.equal(minimum(1001, 50), 996);
});

test('CMS feature and commerce views are registered before visiting appearance', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sites', 'admin.featheral.com', 'js', 'cms.js'), 'utf8');
  const views = {};
  vm.runInNewContext(source, { VIEWS: views });
  for (const name of ['cms-content', 'appearance', 'site-settings', 'shop']) assert.equal(typeof views[name], 'function');
});

test('FTH$ native exchange faucet and positions persist without changing other site balances', (t) => {
  const first = fixture(t); const second = fixture(t);
  const e = first.pub.economy;
  assert.equal(e.account('alice').nativeCurrency, 'FTH$');
  const input = request();
  const result = e.faucet('alice', input);
  assert.deepEqual(e.faucet('alice', input), result);
  assert.equal(e.balance('alice', 'FTH$'), 10000000000);
  assert.equal(e.balance('alice', 'FTHX'), 1000);
  assert.equal(second.pub.economy.balance('alice', 'FTHX'), 0);
  assert.throws(() => e.faucet('alice', request()), { status: 409 });
  first.restart();
  assert.equal(first.pub.economy.balance('alice', 'FTH$'), 10000000000);
  assert.equal(first.pub.economy.account('alice').faucetUsed, true);
});

test('swaps use exact constant product quotes, preserve k and are idempotent in both directions', (t) => {
  const f = fixture(t); const e = f.pub.economy;
  e.faucet('alice', request());
  for (const from of ['FTH$', 'FTHX']) {
    const before = e.pools().pools[0];
    const q = e.quote({ poolId: before.id, from, amount: from === 'FTH$' ? '100' : '10' });
    const effective = BigInt(q.amount) * 9970n;
    const reserveIn = from === 'FTH$' ? before.base : before.quote;
    const reserveOut = from === 'FTH$' ? before.quote : before.base;
    assert.equal(q.output, Number(effective * BigInt(reserveOut) / (BigInt(reserveIn) * 10000n + effective)));
    const balanceIn = e.balance('alice', from); const balanceOut = e.balance('alice', q.to);
    const input = request({ poolId: before.id, from, amount: from === 'FTH$' ? '100' : '10', minOutput: q.output, deadline: Date.now() + 60000 });
    const result = e.swap('alice', input);
    assert.deepEqual(e.swap('alice', input), result);
    const after = e.pool(before.id);
    assert.ok(BigInt(after.base) * BigInt(after.quote) >= BigInt(before.base) * BigInt(before.quote));
    assert.equal(e.balance('alice', from), balanceIn - q.amount);
    assert.equal(e.balance('alice', q.to), balanceOut + q.output);
    assert.throws(() => e.swap('alice', { ...input, amount: '1' }), { status: 409 });
  }
});

test('slippage, insufficient funds, expired quotes and unsafe pools never mutate reserves or balances', (t) => {
  const f = fixture(t); const e = f.pub.economy;
  e.faucet('alice', request()); const p = e.pools().pools[0];
  const q = e.quote({ poolId: p.id, from: 'FTH$', amount: '100' });
  for (const [address, fields, status] of [
    ['alice', { minOutput: q.output + 1 }, 409],
    ['bob', { minOutput: 1 }, 402],
    ['alice', { minOutput: 1, deadline: Date.now() - 1 }, 400],
    ['alice', { minOutput: 0 }, 400],
    ['alice', { from: 'USD$', minOutput: 1 }, 400],
  ]) {
    const before = e.balance('alice', 'FTH$');
    assert.throws(() => e.swap(address, request({ poolId: p.id, from: 'FTH$', amount: '100', deadline: Date.now() + 60000, ...fields })), { status });
    assert.deepEqual(e.pool(p.id), p);
    assert.equal(e.balance('alice', 'FTH$'), before);
  }
});

test('pool creation requires FTH$ base, locks shares, supports fees, and persists liquidity withdrawals', (t) => {
  const f = fixture(t); const e = f.pub.economy;
  e.faucet('alice', request()); e.pools();
  assert.throws(() => e.createPool('alice', request({ symbol: 'FTH$', baseAmount: '10', quoteAmount: '10', feeBps: 30 })), { status: 400 });
  assert.throws(() => e.createPool('alice', request({ symbol: 'FTHX', baseAmount: '10', quoteAmount: '10', feeBps: 30 })), { status: 409 });
  const created = e.createPool('alice', request({ symbol: 'SOL$', baseAmount: '100', quoteAmount: '10', feeBps: 5 }));
  assert.equal(e.pool(created.poolId).fee_bps, 5);
  assert.equal(e.pool(created.poolId).shares - created.shares, 1000);
  const before = e.pool(created.poolId);
  const added = e.addLiquidity('alice', request({ poolId: created.poolId, baseAmount: '20', quoteAmount: '3', minShares: 1 }));
  assert.equal(added.base, 20000000);
  assert.equal(added.quote, 2000000);
  assert.throws(() => e.addLiquidity('alice', request({ poolId: created.poolId, baseAmount: '20', quoteAmount: '3', minShares: 10000000000 })), { status: 409 });
  assert.throws(() => e.removeLiquidity('alice', request({ poolId: created.poolId, shares: added.shares, minBase: 90000000, minQuote: 1 })), { status: 409 });
  const removed = e.removeLiquidity('alice', request({ poolId: created.poolId, shares: added.shares, minBase: 1, minQuote: 1 }));
  assert.ok(removed.base <= added.base && added.base - removed.base <= 1);
  assert.ok(removed.quote <= added.quote && added.quote - removed.quote <= 1);
  assert.deepEqual({ ...e.pool(created.poolId) }, { ...before, base: before.base + added.base - removed.base,
    quote: before.quote + added.quote - removed.quote });
  f.restart();
  const own = f.pub.economy.account('alice').positions.find((p) => p.poolId === created.poolId);
  assert.equal(own.shares, created.shares);
  f.pub.economy.removeLiquidity('alice', request({ poolId: created.poolId, shares: own.shares, minBase: 1, minQuote: 1 }));
  assert.equal(f.pub.economy.pool(created.poolId).shares, 1000);
  assert.throws(() => f.pub.economy.removeLiquidity('alice', request({ poolId: created.poolId, shares: 1, minBase: 1, minQuote: 1 })), { status: 400 });
});

test('FTHX checkout prices and stock are authoritative, atomic, wallet-isolated and persistent', (t) => {
  const f = fixture(t, 'store'); const e = f.pub.economy;
  e.faucet('alice', request());
  const products = e.products();
  const input = request({ items: [{ id: products[0].id, quantity: 2 }], expectedTotal: products[0].price * 2 });
  const order = e.checkout('alice', input);
  assert.equal(order.status, 'demo-paid');
  assert.equal(e.balance('alice', 'FTHX'), 1000 - order.total);
  assert.equal(e.products()[0].stock, products[0].stock - 2);
  assert.deepEqual(e.checkout('alice', input), order);
  assert.equal(e.orders('bob').length, 0);
  for (const [fields, status] of [
    [{ items: [{ id: products[0].id, quantity: 1 }], expectedTotal: 1 }, 409],
    [{ items: [{ id: products[0].id, quantity: 100 }], expectedTotal: products[0].price * 100 }, 409],
    [{ items: [{ id: products[0].id, quantity: 1 }, { id: products[0].id, quantity: 1 }], expectedTotal: 50 }, 400],
  ]) assert.throws(() => e.checkout('alice', request(fields)), { status });
  assert.equal(e.orders('alice').length, 1);
  assert.equal(e.balance('alice', 'FTHX'), 1000 - order.total);
  assert.throws(() => e.checkout('bob', request({ items: [{ id: products[0].id, quantity: 1 }], expectedTotal: products[0].price })), { status: 402 });
  f.restart();
  assert.deepEqual(f.pub.economy.orders('alice')[0].items, order.items);
  assert.equal(f.pub.economy.products()[0].stock, products[0].stock - 2);
});

test('CMS catalog activation, validation, theme and feature gates are enforced', (t) => {
  const f = fixture(t, 'store'); const e = f.pub.economy;
  assert.throws(() => e.pools(), { status: 404 });
  for (const theme of CmsStore.THEMES) assert.equal(f.pub.cms.setTheme(theme).theme, theme);
  assert.throws(() => f.pub.cms.setSiteSettings({ ...f.pub.cms.siteSettings(), homepage: 'exchange' }), { status: 400 });
  const first = e.products()[0];
  e.saveProduct({ ...first, active: false }, first.id);
  assert.equal(e.products().some((p) => p.id === first.id), false);
  assert.equal(e.products(true).some((p) => p.id === first.id), true);
  assert.throws(() => e.saveProduct({ title: 'Broken', price: 1.5, stock: 1, active: true }), { status: 400 });
  f.pub.cms.setSiteSettings({ ...f.pub.cms.siteSettings(), exchange: true });
  assert.equal(e.pools().pools.length, 4, 'enabling a feature later seeds it separately');
  assert.equal(e.products(true).length, 3);
});

test('professional sample sites provision once with isolated editable content and matching themes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-sites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new SiteManager({ dataDir: dir });
  Templates.provision(manager);
  assert.equal(manager.list().length, 5);
  assert.equal(manager.list().some(site => site.hostname === 'stats.featheral.com'), false);
  for (const [key, template] of Object.entries(Templates.TEMPLATES).filter(([key]) => !['stats', 'sites', 'website', 'notes'].includes(key))) {
    const s = manager.list().find((s) => s.hostname === template.hostname);
    const cms = new CmsStore(path.join(s.localDir, 'cms.sqlite'));
    try {
      assert.equal(cms.theme(), template.theme);
      assert.equal(cms.published().length, 4);
      assert.equal(cms.siteSettings().homepage, template.homepage);
      cms.save({ ...cms.publishedPage('home'), title: 'Edited title' }, cms.publishedPage('home').id);
    } finally { cms.close(); }
  }
  Templates.provision(new SiteManager({ dataDir: dir }));
  assert.equal(manager.list().length, 5);
  const cms = new CmsStore(path.join(dir, 'ex-featheral-com', 'cms.sqlite'));
  assert.equal(cms.publishedPage('home').title, 'Edited title'); cms.close();
  assert.throws(() => manager.create({ hostname: 'bad.example.test', template: 'missing' }), { status: 400 });
});

test('sample content upgrades replace only untouched legacy placeholders and remain idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new SiteManager({ dataDir: dir });
  const s = manager.create({ hostname: 'journal.featheral.com', template: 'magazine' });
  const cms = new CmsStore(path.join(s.localDir, 'cms.sqlite'));
  const config = Templates.TEMPLATES.magazine;
  const posts = cms.list().filter((p) => p.type === 'post');
  for (const post of posts) cms.save({ ...post, excerpt: `Sample content from ${config.name}.`,
    body: `${post.title}\n\nThis is editable sample content for ${config.name}. Replace it with your own story, project details, or policy through Featheral CMS.`,
  }, post.id);
  cms.save({ ...cms.get(posts[0].id), body: 'User-authored story. Keep this.' }, posts[0].id);
  Templates.provision(manager);
  assert.equal(cms.get(posts[0].id).body, 'User-authored story. Keep this.');
  assert.ok(cms.get(posts[1].id).body.length > 300);
  const revision = cms.get(posts[1].id).revision;
  Templates.provision(manager);
  assert.equal(cms.get(posts[1].id).revision, revision);
  cms.close();
});
