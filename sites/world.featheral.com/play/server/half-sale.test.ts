import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { accrue, apply, migrateEconomy, snapshot } from './economy.ts';
import { createFundedFixtureAccount as createAccount } from './test-support.ts';
import { createApi } from './http.ts';
import type { Command } from '../src/api-types.ts';
import { SqliteStore } from './store.ts';
import { claim, trade } from '../src/engine.ts';
import { dollarsScale, dollarsSlippage, dollarsUnits } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { marketResources } from '../src/market.ts';
import type { HalfSaleQuote, MarketAsset, MarketCommand } from '../src/market.ts';
import { parseMarketCommand } from './market.ts';
import { seedFixturePools } from './test-support.ts';

const command = (quote: HalfSaleQuote): MarketCommand => ({ type: 'sell-half', sales: quote.sales.map(sale =>
  ({ asset: sale.asset, quantity: sale.quantity, limitDollars: dollarsSlippage(sale.dollars, 'sell') })) });
function setup(excluded: readonly MarketAsset[] = []) {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now), identity = store.create();
  seedFixturePools(store, excluded);
  store.transaction(identity.token, session => {
    session.account.game.stage = 0; session.account.game.home = { x: 0, y: 0 };
    session.account.game.population = 0; session.account.game.stock = { wood: 5, water: 7, metal: 1, oil: 4 };
  });
  const quote = () => store.transaction(identity.token, (session, _, realTime, exchange, owner) => exchange.halfQuote(owner, session.account, realTime));
  const request = (marketCommand: MarketCommand) => ({ id: randomUUID(), revision: store.read(identity.token, s => s.account.revision), command: marketCommand });
  const post = (body: unknown) => {
    now += 1000;
    return store.transaction(identity.token, (session, time, realTime, exchange, owner) => exchange.action(owner, session, body, time, realTime));
  };
  return { store, identity, quote, request, post };
}
test('founding, all commercial buildings, offline time and legacy expeditions never grant FTH$', () => {
  const account = createAccount(1000000);
  const found = apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'upgrade' } }, 1000000);
  assert.equal(found.dollars, 0); assert.equal(found.income.weekly, 0);
  account.game.bank = true; account.game.incomeFacilities = { 'market-stall': true, workshop: true, 'trade-hub': true };
  account.game.stock.water = 100000000;
  const work = snapshot(account).workforce;
  work.expeditions = [{ x: 5, y: 0, workers: 2, readyAt: 1000000 + worldWeekMs, surveyRadius: 4, dollarReward: 9999 }];
  account.workforce = work;
  const frequent = structuredClone(account);
  accrue(account, 1000000 + 52 * worldWeekMs);
  for (let week = 1; week <= 52; week++) accrue(frequent, 1000000 + week * worldWeekMs);
  assert.equal(account.game.dollars, 0); assert.equal(account.fthg, 0);
  assert.equal(snapshot(account).income.weekly, 0);
  assert.deepEqual(snapshot(account), snapshot(frequent));
  const before = structuredClone(account.game);
  assert.throws(() => trade(account.game, 'wood', 'sell', 1), /Use the marketplace/);
  assert.throws(() => claim(account.game), /rewards are disabled/);
  assert.deepEqual(account.game, before);
});
test('no-mint migration preserves money, owned buildings, paid crews, deadlines and receipts once', () => {
  const account = createAccount(1000000);
  account.game.dollars = 123456789;
  account.game.bank = true;
  const work = snapshot(account).workforce;
  work.crews.wood = { workers: 2, weeklyYield: 60, weeklyMetalCost: 0, weeklyDollarsCost: 2, readyAt: 1000000 + worldWeekMs };
  account.workforce = work;
  delete account.noMintVersion;
  const before = structuredClone(account);
  migrateEconomy(account, account.updatedAt);
  assert.equal(account.revision, before.revision + 1);
  assert.deepEqual(account.game, before.game);
  assert.deepEqual(account.workforce, before.workforce);
  assert.deepEqual(account.receipt, before.receipt);
  migrateEconomy(account, account.updatedAt);
  assert.equal(account.revision, before.revision + 1);
});
test('half-sale uses real spot quotes, rounds odd stock down, excludes pending and conserves existing FTH$', () => {
  const h = setup();
  try {
    h.store.transaction(h.identity.token, session => { session.account.pending.wood = 60000 * 5000; });
    const totals = dollarsUnits(h.store.publicTotals().dollars), quoted = h.quote();
    assert.deepEqual(quoted.halfSale.sales.map(s => [s.asset, s.quantity]), [['wood', 2], ['water', 3], ['oil', 2]]);
    let expected = 0;
    for (const sale of quoted.halfSale.sales) {
      const spot = h.store.transaction(h.identity.token, (session, now, realTime, exchange, owner) =>
        exchange.read(owner, session.account, now, realTime, sale.asset, sale.quantity));
      assert.equal(sale.dollars, spot.market.quotes.sell.dollars);
      expected += dollarsUnits(sale.dollars);
    }
    assert.equal(dollarsUnits(quoted.halfSale.dollars), expected);
    const request = h.request(command(quoted.halfSale)), sold = h.post(request);
    assert.deepEqual(sold.game.stock, { wood: 3, water: 4, metal: 1, oil: 2 });
    assert.equal(dollarsUnits(sold.dollars), expected);
    assert.equal(sold.pending.wood, 5000);
    assert.equal(dollarsUnits(h.store.publicTotals().dollars), totals);
    const before = h.store.read(h.identity.token, s => structuredClone(s.account));
    assert.deepEqual(h.post(request), sold);
    assert.deepEqual(h.store.read(h.identity.token, s => s.account), before);
    assert.throws(() => h.post({ ...request, id: randomUUID() }), /World changed/);
  } finally { h.store.close(); }
});
test('half-sale rolls back every earlier resource, pool and fill when a later quote fails', () => {
  const h = setup();
  try {
    const quote = h.quote(), sell = command(quote.halfSale);
    assert.equal(sell.type, 'sell-half'); if (sell.type !== 'sell-half') return;
    sell.sales.at(-1)!.limitDollars += 10;
    const before = h.store.read(h.identity.token, s => structuredClone(s.account)), totals = h.store.publicTotals();
    assert.throws(() => h.post(h.request(sell)), /Quote changed/);
    assert.deepEqual(h.store.read(h.identity.token, s => s.account), before);
    assert.deepEqual(h.quote().halfSale, quote.halfSale);
    assert.deepEqual(h.store.publicTotals(), totals);
    const trades = h.store.transaction(h.identity.token, (session, now, realTime, exchange, owner) =>
      exchange.read(owner, session.account, now, realTime, 'wood', 1).market.trades);
    assert.equal(trades.length, 0);
  } finally { h.store.close(); }
});
test('half-sale rejects missing, duplicate and forged quantities, and sells exact halves above 10,000', () => {
  const h = setup();
  try {
    const sell = command(h.quote().halfSale);
    assert.equal(sell.type, 'sell-half'); if (sell.type !== 'sell-half') return;
    assert.throws(() => h.post(h.request({ ...sell, sales: sell.sales.slice(1) })), /Resources changed/);
    assert.throws(() => parseMarketCommand({ ...sell, sales: [sell.sales[0], sell.sales[0]] }), /Invalid half-sale/);
    assert.throws(() => parseMarketCommand({ ...sell, sales: [{ ...sell.sales[0], quantity: .5 }] }), /Invalid half-sale/);
    h.store.transaction(h.identity.token, session => { session.account.game.stock.wood = 50001; });
    assert.throws(() => h.post(h.request(sell)), /Resources changed/);
    const quoted = h.quote();
    assert.equal(quoted.halfSale.sales.find(s => s.asset === 'wood')!.quantity, 25000);
    const sold = h.post(h.request(command(quoted.halfSale)));
    assert.equal(sold.game.stock.wood, 25001);
    assert.ok(sold.game.dollars > 0);
    h.store.transaction(h.identity.token, session => { for (const resource of marketResources) session.account.game.stock[resource] = 1; });
    assert.equal(h.quote().halfSale.available, false);
    assert.deepEqual(h.quote().halfSale.sales, []);
  } finally { h.store.close(); }
});
test('half-sales transfer player buy escrow and accept large payment limits', () => {
  const h = setup(['wood']);
  try {
    h.store.transaction(h.identity.token, session => { session.account.game.stock.wood = 50001; });
    const buyers = Array.from({ length: 3 }, () => h.store.create());
    for (const buyer of buyers) {
      h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) => {
        session.account.game.stage = 0; session.account.game.population = 0;
        session.account.game.dollars = dollarsUnits(100000);
        session.account.game.stock.wood = 0;
        exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision,
          command: { type: 'limit', asset: 'wood', side: 'buy', quantity: 10000, price: 4 } }, now, realTime);
      });
    }
    const total = h.store.publicTotals().dollars, quoted = h.quote();
    assert.doesNotThrow(() => parseMarketCommand({ type: 'sell-half',
      sales: [{ asset: 'wood', quantity: 25000, limitDollars: 25000000000 }] }));
    assert.equal(quoted.halfSale.available, true);
    const sold = h.post(h.request(command(quoted.halfSale)));
    assert.equal(sold.game.stock.wood, 25001);
    assert.equal(sold.dollars, quoted.halfSale.dollars);
    assert.equal(buyers.reduce((sum, buyer) => sum + h.store.read(buyer.token, session => session.account.game.stock.wood), 0), 25000);
    assert.equal(h.store.publicTotals().dollars, total);
  } finally { h.store.close(); }
});
test('a zero-resource founder earns Dollar only by selling completed production', () => {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now), identity = store.create();
  seedFixturePools(store);
  const act = (worldCommand: Command) => {
    now += 1000;
    return store.transaction(identity.token, (session, time) =>
      apply(session.account, { id: randomUUID(), revision: session.account.revision, command: worldCommand }, time));
  };
  try {
    act({ type: 'gather' }); act({ type: 'gather' });
    act({ type: 'move', x: 3, y: 0 }); act({ type: 'gather' }); act({ type: 'gather' });
    act({ type: 'move', x: 0, y: 0 });
    assert.equal(act({ type: 'upgrade' }).dollars, 0);
    assert.deepEqual(store.read(identity.token, session => session.account.game.stock), { wood: 0, water: 0, metal: 0, oil: 0 });
    now += 2 * worldWeekMs;
    const quote = store.transaction(identity.token, (session, time, realTime, exchange, owner) => {
      accrue(session.account, time);
      return exchange.collectionQuote(owner, session.account, 'wood', realTime).collectionQuote;
    });
    assert.ok(quote.available); assert.ok(quote.net > 0);
    const sold = store.transaction(identity.token, (session, time, realTime, exchange, owner) =>
      apply(session.account, { id: randomUUID(), revision: session.account.revision, command: {
        type: 'collect-sell', resource: 'wood', quantity: quote.quantity, minimumDollars: Math.floor(quote.net * dollarsScale),
      } }, time, realTime, command => exchange.collectSell(owner, session.account, command, time, realTime)));
    assert.ok(sold.dollars > 0);
    assert.equal(sold.game.stock.metal, 0);
    const collected = act({ type: 'claim', resource: 'water' });
    assert.ok(collected.game.stock.water > 0);
    assert.ok(collected.dollars <= sold.dollars);
    assert.deepEqual(collected.income, { weekly: 0, readyAt: 0 });
  } finally { store.close(); }
});
test('HTTP half-sale menu uses authenticated GET quotes and one CSRF-protected atomic POST', async () => {
  const h = setup(), origin = 'http://127.0.0.1:5173', server = createApi(h.store, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api`, headers = { Cookie: `terra-dev=${h.identity.token}` };
  try {
    assert.equal((await fetch(`${url}/market/half`)).status, 401);
    assert.equal((await fetch(`${url}/market/half?extra=1`, { headers })).status, 400);
    const response = await fetch(`${url}/market/half`, { headers }); assert.equal(response.status, 200);
    const quote = await response.json(), body = { id: randomUUID(), revision: quote.revision, command: command(quote.halfSale) };
    const post = (csrf: string) => fetch(`${url}/market/actions`, { method: 'POST', headers: { ...headers, Origin: origin,
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    assert.equal((await post('')).status, 403);
    const sold = await post(quote.csrf); assert.equal(sold.status, 200);
    assert.deepEqual((await sold.json()).game.stock, { wood: 3, water: 4, metal: 1, oil: 2 });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); h.store.close();
  }
});
