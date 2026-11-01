import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fundFixtureFromReserves } from './test-support.ts';
import { fthgScale, formatFthg, fthgSlippage, fthgUnits } from '../src/fthg.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { parseMarketCommand } from './market.ts';
import { SqliteStore } from './store.ts';
import { snapshot } from './economy.ts';
import type { MarketCommand } from '../src/market.ts';

test('FTHG display omits unnecessary decimals while parsing and slippage preserve four-place precision', () => {
  for (const [amount, units] of [[0, 0], [.0001, 1], [.0003, 3], [.1, 1000], [1.2345, 12345], [1000000, 10000000000]]) {
    assert.equal(fthgUnits(amount), units);
  }
  for (const value of [-1, NaN, Infinity, .00001, 1.23456, .1 + .2, '1.2345', null, 1e12])
    assert.throws(() => fthgUnits(value), /FTHG/);
  for (const language of ['en-US', 'ko-KR']) {
    for (const [amount, text] of [[0, '0'], [1000, '1,000'], [1.2, '1.2'], [1.23, '1.23'], [1.234, '1.234'], [.0001, '0.0001'], [1234.5678, '1,234.5678'], [1.23456, '1.2346']] as const)
      assert.equal(formatFthg(amount, language), text);
  }
  assert.equal(fthgSlippage(.0001, 'buy'), .0001);
  assert.equal(fthgSlippage(.0001, 'sell'), .0001);
  assert.equal(fthgSlippage(1.2345, 'buy'), 1.2591);
  assert.equal(fthgSlippage(1.2345, 'sell'), 1.2099);
  assert.equal((parseMarketCommand({ type: 'limit', asset: 'metal', side: 'buy', quantity: 3, price: 1.2345 }) as { price: number }).price, 12345);
  assert.equal((parseMarketCommand({ type: 'limit', asset: 'metal', side: 'buy', quantity: 1, price: .0001 }) as { price: number }).price, 1);
  for (const price of [.00001, 1.23456, 0, -1, 1000000.0001])
    assert.throws(() => parseMarketCommand({ type: 'limit', asset: 'metal', side: 'buy', quantity: 1, price }), /FTHG|FTH\$|Invalid market/);
});

test('fractional offers match, partially fill and cancel exactly; total supply includes escrow, pools and inactive wallets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-dollars-')), path = join(dir, 'currency.sqlite');
  let time = 1800000000000, store = new SqliteStore(path, () => time);
  const buyer = store.create(), seller = store.create();
  const post = (identity: typeof buyer, command: MarketCommand) => {
    time += 1000;
    return store.transaction(identity.token, (s, n, real, exchange, owner) => exchange.action(owner, s,
      { id: randomUUID(), revision: s.account.revision, command }, n, real));
  };
  const read = (identity: typeof buyer) => store.read(identity.token, s => snapshot(s.account));
  try {
    for (const identity of [buyer, seller]) store.transaction(identity.token, s => {
      s.account.game.stage = 0; s.account.game.population = 0;
      if (identity === buyer) s.account.game.dollars = dollarsUnits(100);
    });
    fundFixtureFromReserves(path, 100);
    const total = store.publicTotals().dollars;
    const bid = post(buyer, { type: 'limit', asset: 'metal', side: 'buy', quantity: 10, price: 1.9999 });
    assert.equal(bid.dollars, 80.001); assert.equal(bid.market.orders[0].price, 1.9999);
    assert.equal(store.publicTotals().dollars, total);
    const sold = post(seller, { type: 'spot', asset: 'metal', side: 'sell', quantity: 3, limitDollars: 5.9997 });
    assert.equal(sold.dollars, 5.9997); assert.equal(sold.market.trades[0].price, 1.9999);
    assert.equal(store.publicTotals().dollars, total);
    post(buyer, { type: 'cancel', orderId: bid.market.orders[0].id });
    assert.equal(read(buyer).dollars, 94.0003); assert.equal(store.publicTotals().dollars, total);
    const ticks = post(buyer, { type: 'limit', asset: 'metal', side: 'buy', quantity: 20, price: 1.9999 });
    for (let i = 0; i < 10; i++) post(seller, { type: 'spot', asset: 'metal', side: 'sell', quantity: 1, limitDollars: 1.9999 });
    assert.equal(read(seller).dollars, 25.9987);
    post(buyer, { type: 'cancel', orderId: ticks.market.orders.find(order => order.status === 'open')!.id });
    assert.equal(store.publicTotals().dollars, total);
    const before = read(buyer);
    assert.throws(() => post(buyer, { type: 'limit', asset: 'metal', side: 'buy', quantity: 1, price: 1.23456 }), /four decimal/);
    assert.equal(read(buyer).dollars, before.dollars);
    assert.equal(store.publicTotals().dollars, total);
    const q = store.transaction(seller.token, (s, n, real, exchange, owner) => exchange.read(owner, s.account, n, real, 'metal', 1));
    const sale = post(seller, { type: 'spot', asset: 'metal', side: 'sell', quantity: 1, limitDollars: q.market.quotes.sell.dollars });
    assert.equal(sale.market.trades[0].venue, 'system'); assert.equal(store.publicTotals().dollars, total);
    post(buyer, { type: 'limit', asset: 'metal', side: 'buy', quantity: 10, price: .0001 });
    store.close(); store = new SqliteStore(path, () => time);
    assert.equal(store.publicTotals().dollars, total);
    time += 8 * 86400000;
    store.create();
    assert.equal(store.publicTotals().dollars, total);
    store.close(); store = new SqliteStore(path, () => time);
    assert.equal(store.publicTotals().dollars, total);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

function oldFthgDatabase(path: string) {
  const time = 1800000000000, store = new SqliteStore(path, () => time), identity = store.create();
  const account = store.read(identity.token, s => s.account);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE monetary_policy; DELETE FROM market_currency; DROP TABLE gold_pool; ALTER TABLE market_pools RENAME COLUMN dollars TO fthg; ALTER TABLE market_fills RENAME COLUMN dollars TO fthg; ALTER TABLE public_totals DROP COLUMN fthg;
    UPDATE market_pools SET fthg=fthg/10000;
    UPDATE sessions SET data=json_set(data,'$.account.currencyVersion',2,'$.account.fthg',17,
      '$.account.revision',7,'$.account.game.stage',0);`);
  const owner = String(db.prepare('SELECT id FROM sessions').get()!.id);
  db.prepare("INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES(?,'metal','buy',1,5,5,'open',?)").run(owner, time);
  db.prepare("INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES(?,'wood','sell',1000,3,3,'open',?)").run(owner, time);
  db.prepare("INSERT INTO market_fills(asset,quantity,fthg,price,time,venue,buyer,seller) VALUES('wood',2,5,2.5,?,'system',?,'')").run(time, owner);
  const request = { id: randomUUID(), revision: 6, command: { type: 'spot', asset: 'metal', side: 'sell', quantity: 1, limitDollars: 1 } };
  const response = { ...snapshot(account), fthg: 17, revision: 7 };
  db.prepare('INSERT INTO market_receipts VALUES(?,?,?,?)').run(owner, request.id, JSON.stringify({ revision: request.revision, command: request.command }), JSON.stringify(response));
  db.close();
  return { time, identity, request, response };
}
test('whole-Gold saves rescale once, refund Gold escrow and archive original offers, history and receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-fthg-migrate-')), path = join(dir, 'currency.sqlite');
  const fixture = oldFthgDatabase(path);
  let store = new SqliteStore(path, () => fixture.time);
  try {
    assert.equal(store.read(fixture.identity.token, s => s.account.currencyVersion), 4);
    assert.equal(store.read(fixture.identity.token, s => s.account.fthg), 22 * fthgScale);
    const result = store.transaction(fixture.identity.token, (s, n, real, exchange, owner) => exchange.read(owner, s.account, n, real, 'wood', 1));
    assert.equal(result.fthg, 22); assert.equal(result.revision, 9);
    assert.deepEqual(result.market.orders, []);
    assert.deepEqual(result.market.history, []);
    const archive = new DatabaseSync(path);
    assert.equal(archive.prepare("SELECT price FROM legacy_gold_market_orders WHERE asset='wood'").get()!.price, 1000 * fthgScale);
    assert.equal(archive.prepare("SELECT price FROM legacy_gold_market_orders WHERE asset='metal'").get()!.price, fthgScale);
    assert.equal(archive.prepare('SELECT fthg FROM legacy_gold_market_fills').get()!.fthg, 5 * fthgScale);
    assert.equal(archive.prepare('SELECT COUNT(*) AS total FROM legacy_gold_market_receipts').get()!.total, 1);
    archive.close();
    const supply = store.publicTotals().fthg;
    assert.ok(supply > 17 + 5);
    assert.throws(() => store.transaction(fixture.identity.token, (s, n, real, exchange, owner) =>
      exchange.action(owner, s, fixture.request, n, real)), /Invalid market|World changed/);
    store.close(); store = new SqliteStore(path, () => fixture.time + 1000);
    assert.equal(store.publicTotals().fthg, supply);
    assert.equal(store.read(fixture.identity.token, s => snapshot(s.account)).fthg, 22);
    assert.equal(store.publicTotals().fthg, supply);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('unsafe precision migration rolls back wallets, offers, history and version marker atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-fthg-rollback-')), path = join(dir, 'currency.sqlite');
  const fixture = oldFthgDatabase(path), db = new DatabaseSync(path);
  db.exec(`UPDATE market_orders SET price=${Number.MAX_SAFE_INTEGER} WHERE asset='wood'`);
  const before = db.prepare('SELECT data FROM sessions').get()!.data; db.close();
  try {
    assert.throws(() => new SqliteStore(path, () => fixture.time), /overflowing FTHG/);
    const check = new DatabaseSync(path);
    try {
      assert.equal(check.prepare('SELECT data FROM sessions').get()!.data, before);
      assert.equal(check.prepare("SELECT fthg FROM market_pools WHERE asset='metal'").get()!.fthg, 200000);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM market_currency').get()!.n, 0);
      assert.equal(check.prepare('SELECT price FROM market_fills').get()!.price, 2.5);
    } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true }); }
});
