import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './store.ts';
import { seedFixturePools } from './test-support.ts';
import { inventory } from './inventory.ts';
import { createApi } from './http.ts';
import { dollarsScale, dollarsSlippage, dollarsUnits } from '../src/dollars.ts';
import { marketQuantityLimit } from '../src/market.ts';
import type { MarketAsset, MarketResponse } from '../src/market.ts';
import type { BuyQuantityRequest } from '../src/market-buy-quantity.ts';
import { buyingBudgetUnits } from '../src/market-buy-quantity.ts';
import { salePercentages } from '../src/resource-sale-quantity.ts';

function fixture(excluded: readonly MarketAsset[] = []) {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now);
  seedFixturePools(store, excluded);
  const buyer = store.create();
  store.transaction(buyer.token, session => {
    session.account.game.stage = 0; session.account.game.population = 0;
    session.account.game.dollars = 1000 * dollarsScale;
    session.account.workforce!.automatic = false;
    inventory(session.account);
  });
  const read = (asset: MarketAsset, quantity = 1, buying?: BuyQuantityRequest) =>
    store.transaction(buyer.token, (session, time, realTime, exchange, owner) =>
      exchange.read(owner, session.account, time, realTime, asset, quantity, buying));
  return { store, buyer, read, advance: () => { now += 1000; } };
}
test('all four buy budgets use executable depth quotes, not single-lot ticker estimates', () => {
  const h = fixture();
  try {
    h.read('wood');
    const initial = h.store.read(h.buyer.token, session => structuredClone(session.account));
    for (const asset of ['wood', 'water', 'metal', 'oil', 'torch', 'relic-forest'] as const) {
      for (const percent of salePercentages) {
        const result = h.read(asset, 1, { percent }), budget = result.market.buyBudget!;
        const quantity = budget.quantity;
        assert.equal(budget.dollars, buyingBudgetUnits(initial.game.dollars, percent) / dollarsScale);
        assert.ok(quantity > 0 && quantity <= marketQuantityLimit(asset));
        assert.equal(result.market.quantity, quantity);
        assert.equal(result.market.quotes.buy.available, true);
        assert.ok(result.market.quotes.buy.dollars <= budget.dollars);
        if (quantity < marketQuantityLimit(asset)) {
          const larger = h.read(asset, quantity + 1).market.quotes.buy;
          assert.ok(!larger.available || larger.dollars > budget.dollars);
        }
      }
    }
    assert.deepEqual(h.store.read(h.buyer.token, session => session.account), initial);
  } finally { h.store.close(); }
});
test('limit-price budgets use full escrow cost and keep the existing quantity cap', () => {
  const h = fixture();
  try {
    for (const percent of salePercentages) {
      const result = h.read('wood', 1, { percent, price: 3 }), budget = result.market.buyBudget!;
      assert.equal(budget.quantity, Math.floor(budget.dollars / 3));
      assert.ok(budget.quantity * 3 <= budget.dollars);
      assert.ok((budget.quantity + 1) * 3 > budget.dollars);
    }
    assert.equal(h.read('wood', 1, { percent: 100, price: .0001 }).market.buyBudget!.quantity, 10000);
    h.store.transaction(h.buyer.token, session => { session.account.game.dollars = 1; });
    assert.equal(h.read('wood', 1, { percent: 100, price: 1 }).market.buyBudget!.quantity, 0);
  } finally { h.store.close(); }
});
test('budget sizing combines cheaper player offers with pool liquidity and excludes own offers', () => {
  const h = fixture(['wood']), maker = h.store.create();
  try {
    h.store.transaction(maker.token, (session, time, realTime, exchange, owner) => {
      session.account.game.stage = 0; session.account.game.population = 0;
      session.account.game.stock.wood = 100;
      exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision,
        command: { type: 'limit', asset: 'wood', side: 'sell', quantity: 100, price: 1 } }, time, realTime);
    });
    seedFixturePools(h.store);
    const result = h.read('wood', 1, { percent: 25 }), budget = result.market.buyBudget!;
    assert.ok(result.market.asks.some(offer => offer.price === 1 && offer.quantity === 100));
    assert.ok(budget.quantity > 100);
    assert.ok(result.market.quotes.buy.dollars <= budget.dollars);
    assert.ok(h.read('wood', budget.quantity + 1).market.quotes.buy.dollars > budget.dollars);
    const makerView = h.store.transaction(maker.token, (session, time, realTime, exchange, owner) => {
      session.account.game.dollars = 250 * dollarsScale;
      return exchange.read(owner, session.account, time, realTime, 'wood', 1, { percent: 100 });
    });
    assert.ok(makerView.market.buyBudget!.quantity < budget.quantity);
  } finally { h.store.close(); }
});
test('buy budgets handle no balance, blocked collectibles and empty markets without manufacturing funds', () => {
  const h = fixture();
  try {
    h.store.transaction(h.buyer.token, session => { inventory(session.account).items.push('relic-forest'); });
    assert.equal(h.read('relic-forest', 1, { percent: 100 }).market.buyBudget!.quantity, 0);
    h.store.transaction(h.buyer.token, session => { session.account.game.dollars = 0; });
    assert.equal(h.read('metal', 1, { percent: 100 }).market.buyBudget!.quantity, 0);
  } finally { h.store.close(); }
  const store = new SqliteStore(':memory:'), buyer = store.create();
  try {
    const result = store.transaction(buyer.token, (session, time, realTime, exchange, owner) => {
      session.account.game.dollars = 100 * dollarsScale;
      return exchange.read(owner, session.account, time, realTime, 'wood', 1, { percent: 100 });
    });
    assert.equal(result.market.buyBudget!.quantity, 0);
    assert.equal(result.market.quotes.buy.available, false);
  } finally { store.close(); }
});
test('100% budget buys execute without requiring a spare 2% balance and never exceed the budget', () => {
  const h = fixture();
  try {
    const quoted = h.read('metal', 1, { percent: 100 }), budget = quoted.market.buyBudget!;
    const initial = quoted.dollars;
    h.advance();
    const purchased = h.store.transaction(h.buyer.token, (session, time, realTime, exchange, owner) =>
      exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision,
        command: { type: 'spot', asset: 'metal', side: 'buy', quantity: budget.quantity,
          limitDollars: Math.min(dollarsSlippage(quoted.market.quotes.buy.dollars, 'buy'), budget.dollars) } }, time, realTime));
    assert.equal(purchased.game.stock.metal, budget.quantity);
    assert.ok(initial - purchased.dollars <= budget.dollars);
    assert.equal(initial - purchased.dollars, quoted.market.quotes.buy.dollars);
  } finally { h.store.close(); }
});
test('HTTP budget reads validate percentages, price precision and duplicate query fields', async () => {
  const h = fixture(), origin = 'http://127.0.0.1:5173', server = createApi(h.store, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/dollar/game/market?asset=wood&quantity=1`;
    const headers = { Cookie: `terra-dev=${h.buyer.token}` };
    for (const percent of salePercentages) {
      const response = await fetch(`${base}&budgetPercent=${percent}`, { headers });
      assert.equal(response.status, 200);
      const result = await response.json() as MarketResponse;
      assert.equal(result.market.buyBudget!.percent, percent);
      assert.ok(dollarsUnits(result.market.quotes.buy.dollars) <= dollarsUnits(result.market.buyBudget!.dollars));
    }
    const limit = await fetch(`${base}&budgetPercent=50&price=3`, { headers });
    assert.equal(limit.status, 200);
    assert.equal((await limit.json() as MarketResponse).market.buyBudget!.quantity, 166);
    for (const query of ['budgetPercent=0', 'budgetPercent=101', 'budgetPercent=NaN', 'budgetPercent=25&budgetPercent=50',
      'budgetPercent=25&price=0', 'budgetPercent=25&price=1.00001', 'budgetPercent=25&price=1000001', 'price=1', 'quantity=2'])
      assert.equal((await fetch(`${base}&${query}`, { headers })).status, 400, query);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); h.store.close(); }
});
