import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { accrue, apply, collectResource, execute, snapshot } from './economy.ts';
import { inventory, craft } from './inventory.ts';
import { createFundedFixtureAccount, seedFixturePools } from './test-support.ts';
import { SqliteStore } from './store.ts';
import { transportItems, transportItemKeys, transportQuote, transportBenefit } from '../src/transport-items.ts';
import { craftingCost, craftingIngredients, craftingStage } from '../src/items.ts';
import type { ItemId } from '../src/items.ts';
import { dollarsScale } from '../src/dollars.ts';
import { claimConsumption, gameConsumption } from '../src/consumption.ts';
import { itemArt } from '../src/item-art.ts';
import { translate } from '../src/i18n.ts';
import { collectionClaimReason } from '../src/collection.ts';
import { emptyAllocation } from '../src/workforce.ts';

const start = 1000000;
function fixture() {
  const account = createFundedFixtureAccount(start);
  execute(account, { type: 'upgrade' }, start);
  account.game.population = 0;
  account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 100000 };
  account.game.dollars = 100000000;
  account.game.explored = Array.from({ length: 41 }, (_, x) => Array.from({ length: 41 }, (_, y) => `${x - 20},${y - 20}`)).flat();
  account.workforce!.automatic = false;
  account.workforce!.crews = {};
  account.workforce!.allocation = emptyAllocation();
  inventory(account).items = [];
  return account;
}
test('three vouchers are craftable from unused decorations and collectors with distinct artwork and localized names', () => {
  assert.deepEqual(transportItemKeys.map(id => transportItems[id].discount), [10, 25, 50]);
  assert.equal(new Set(transportItemKeys.map(itemArt)).size, 3);
  for (const item of transportItemKeys) {
    const account = fixture(), bag = inventory(account);
    account.game.stage = craftingStage(item);
    for (const [id, amount] of Object.entries(craftingIngredients(item)))
      for (let i = 0; i < amount; i++) bag.items.push(id as ItemId);
    const before = account.game.dollars, cost = craftingCost(item);
    craft(account, item);
    assert.deepEqual(bag.items, [item]);
    assert.equal(account.game.dollars, before - cost.dollars! * dollarsScale);
    assert.ok(cost.dollars! >= 1);
    assert.notEqual(translate(transportItems[item].name, 'ko'), transportItems[item].name);
    assert.notEqual(translate(transportBenefit(item), 'ko'), transportBenefit(item));
  }
});
test('strongest available voucher applies once with whole monetary units, never stacks or uses escrow', () => {
  const bag = inventory(fixture());
  bag.items = [...transportItemKeys];
  assert.deepEqual(transportQuote(101, bag), { fee: 51, discount: 50, item: 'transport-convoy' });
  assert.equal(transportQuote(Number.MAX_SAFE_INTEGER, bag).fee, 4503599627370496);
  bag.items = ['transport-cart']; bag.marketReserved = ['transport-convoy'];
  assert.deepEqual(transportQuote(100, bag), { fee: 90, discount: 10, item: 'transport-cart' });
  assert.deepEqual(transportQuote(0, bag), { fee: 0, discount: 0 });
  assert.throws(() => transportQuote(-1, bag), RangeError);
});
test('pickup charges discounted fees, consumes only one voucher and rejects insufficient funds without spending', () => {
  const account = fixture(), bag = inventory(account);
  bag.items = [...transportItemKeys];
  account.pending.wood = 20 * 60000;
  account.pickupFees!.wood = 10 * dollarsScale;
  account.game.dollars = 5 * dollarsScale - 1;
  const before = structuredClone(account);
  assert.throws(() => collectResource(account, 'wood'), /Not enough/);
  assert.deepEqual(account, before);
  account.game.dollars++;
  const state = snapshot(account);
  assert.equal(state.collection!.fees.wood, 5);
  assert.equal(state.collection!.vouchers!.wood, 'transport-convoy');
  assert.equal(collectionClaimReason(state, 'wood'), null);
  collectResource(account, 'wood');
  assert.equal(account.game.dollars, 0);
  assert.deepEqual(bag.items, ['transport-cart', 'transport-wagon']);
  assert.equal(account.pending.wood, 0);
  assert.equal(account.pickupFees!.wood, 0);
});
test('free map collection and zero-fee claims never burn vouchers; claim receipt retries consume once', () => {
  for (const free of [true, false]) {
    const account = fixture(), bag = inventory(account);
    bag.items = ['transport-convoy'];
    account.pending.wood = 60000;
    account.pickupFees!.wood = free ? dollarsScale : 0;
    collectResource(account, 'wood', free);
    assert.deepEqual(bag.items, ['transport-convoy']);
  }
  const account = fixture();
  inventory(account).items = ['transport-convoy', 'transport-convoy'];
  account.pending.wood = 60000;
  account.pickupFees!.wood = dollarsScale;
  const body = { id: randomUUID(), revision: account.revision, command: { type: 'claim', resource: 'wood' } };
  const result = apply(account, body, start, start + 1000), after = structuredClone(account);
  assert.deepEqual(apply(account, body, start, start + 1000), result);
  assert.deepEqual(account, after);
  assert.equal(inventory(account).items.length, 1);
});
test('auto-collection can use a voucher when funds cover only the discounted transport', () => {
  const account = fixture();
  account.game.population = 12;
  account.game.stock.wood = 0;
  inventory(account).items = ['transport-convoy'];
  account.game.dollars = dollarsScale;
  account.automationUntil!.wood = start + 10000;
  account.workforce!.crews.wood = { workers: 1, readyAt: start + 1000, weeklyYield: 10, weeklyMetalCost: 0, weeklyDollarsCost: 2, payOnPickup: true };
  accrue(account, start + 1000);
  assert.equal(account.game.stock.wood, 10);
  assert.equal(account.pending.wood, 0);
  assert.equal(account.game.dollars, 0);
  assert.deepEqual(inventory(account).items, []);
});
test('multi-resource claims allocate different vouchers once each without discount stacking', () => {
  const account = fixture(), bag = inventory(account);
  bag.items = ['transport-convoy', 'transport-wagon'];
  const state = snapshot(account);
  for (const resource of ['wood', 'metal'] as const) {
    account.pending[resource] = Math.ceil(state.capacity / 2) * 60000;
    account.pickupFees![resource] = 4 * dollarsScale;
  }
  const before = account.game.dollars;
  execute(account, { type: 'claim' }, start + 1000);
  assert.equal(account.game.dollars, before - 5 * dollarsScale);
  assert.deepEqual(bag.items, []);
});
test('loss review uses executable sell value, includes consumed voucher, and never invents profit', () => {
  const account = fixture(), state = snapshot(account);
  const quote = { resource: 'wood' as const, quantity: 20, transport: 10, proceeds: 6, net: -4, available: false, sellAvailable: true, voucher: 'transport-convoy' as const, discount: 50 };
  const review = claimConsumption(state, 'wood', quote, 'en');
  assert.match(review.warning!, /lose FTH\$/);
  assert.deepEqual(review.costs, [{ asset: 'dollars', amount: 10 }, { asset: 'transport-convoy', amount: 1 }]);
  assert.equal(review.recommendations?.length, 3);
  assert.ok(review.notes.some(note => note.includes('After transport: FTH$ -4')));
  assert.equal(claimConsumption(state, 'wood', { ...quote, sellAvailable: false }, 'en').warning, undefined);
  assert.equal(claimConsumption(state, 'wood', { ...quote, net: 0 }, 'en').warning, undefined);
  assert.match(claimConsumption(state, 'wood', quote, 'ko').notes.join(' '), /운송비 차감 후/);
  state.collection!.vouchers = { wood: 'transport-convoy' };
  assert.ok(gameConsumption(state, { type: 'collect-sell', resource: 'wood', quantity: 1, minimumDollars: 1 })!.costs.some(cost => cost.asset === 'transport-convoy'));
});
test('claim controller fetches loss review before spending, cancels safely and rejects changed quotes', async () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function act('), source.indexOf('function costChips(')));
  for (const scenario of ['cancel', 'changed', 'success', 'unavailable']) {
    const state = snapshot(fixture());
    let reads = 0, sends = 0, reviews = 0;
    const messages: string[] = [];
    const quote = { resource: 'wood', quantity: 10, transport: 10, proceeds: 5, net: -5, available: false, sellAvailable: true };
    const context = {
      state, busy: false, confirmationOpen: () => false, timedActionKey: () => null,
      readCollection: async () => {
        if (scenario === 'unavailable') throw new Error('Market quote request failed.');
        reads++;
        return { ...state, collectionQuote: scenario === 'changed' && reads > 1 ? { ...quote, transport: 9 } : quote };
      },
      claimConsumption, gameConsumption, language: 'en',
      confirmConsumption: async (review: { warning?: string }) => { reviews++; assert.ok(review.warning); return scenario !== 'cancel'; },
      synchronize: (next: typeof state) => { context.state = next; },
      refresh: async () => state,
      send: async () => { sends++; return state; },
      render() {}, renderActionTiming() {}, saveCrewAssignments() {},
      app: { classList: { add() {}, remove() {} } }, pendingTimedAction: null,
      toast: (message: string) => messages.push(message), Error,
    };
    const act = runInNewContext(`${code}; act;`, context);
    assert.equal(await act({ type: 'claim', resource: 'wood' }), scenario === 'success');
    assert.equal(sends, scenario === 'success' ? 1 : 0);
    assert.equal(reviews, scenario === 'unavailable' ? 0 : 1);
    assert.equal(reads, scenario === 'cancel' ? 1 : scenario === 'unavailable' ? 0 : 2);
    if (scenario === 'changed') assert.ok(messages.some(message => message.includes('Requirements changed')));
    if (scenario === 'unavailable') assert.ok(messages.includes('Market quote request failed.'));
  }
});
test('collect-and-sell quotes and transactions share the discount and roll back failures and retries', () => {
  const store = new SqliteStore(':memory:', () => start), identity = store.create();
  seedFixturePools(store);
  try {
    store.transaction(identity.token, session => {
      session.account.game.stage = 0; session.account.game.population = 0; session.account.game.dollars = 0;
      session.account.game.stock.wood = 3; session.account.pending.wood = 20 * 60000;
      session.account.pickupFees!.wood = 2 * dollarsScale;
      inventory(session.account).items = ['transport-convoy', 'transport-convoy'];
    });
    const quote = store.transaction(identity.token, (session, _, real, exchange, owner) => exchange.collectionQuote(owner, session.account, 'wood', real, 10).collectionQuote);
    assert.equal(quote.transport, 1); assert.equal(quote.voucher, 'transport-convoy'); assert.ok(quote.sellAvailable);
    const body = { id: randomUUID(), revision: store.read(identity.token, session => session.account.revision),
      command: { type: 'collect-sell', resource: 'wood', quantity: 10, minimumDollars: Math.round(quote.net * dollarsScale) } };
    const run = (request: unknown) => store.transaction(identity.token, (session, time, real, exchange, owner) =>
      apply(session.account, request, time, real, command => exchange.collectSell(owner, session.account, command, time, real)));
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.throws(() => run({ ...body, id: randomUUID(), command: { ...body.command, minimumDollars: 99999999999 } }), /Quote changed/);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    const result = run(body);
    assert.equal(result.dollars, quote.net); assert.equal(result.game.stock.wood, 13);
    assert.equal(result.inventory.items.length, 1);
    assert.deepEqual(run(body), result);
    assert.equal(store.read(identity.token, session => inventory(session.account).items.length), 1);
  } finally { store.close(); }
});
test('transport vouchers can be bought and sold through normal spot markets without activation', () => {
  let time = start;
  const store = new SqliteStore(':memory:', () => time), identity = store.create();
  seedFixturePools(store);
  try {
    store.transaction(identity.token, session => {
      session.account.game.stage = 0;
      session.account.game.dollars = 2000 * dollarsScale;
    });
    const spot = (side: 'buy' | 'sell', limitDollars: number) => {
      time += 1000;
      return store.transaction(identity.token, (session, now, real, exchange, owner) =>
      exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision,
        command: { type: 'spot', asset: 'transport-convoy', side, quantity: 1, limitDollars } }, now, real));
    };
    const bought = spot('buy', 1000);
    assert.deepEqual(bought.inventory.items, ['transport-convoy']);
    const sold = spot('sell', .0001);
    assert.deepEqual(sold.inventory.items, []);
    assert.ok(sold.dollars > bought.dollars);
  } finally { store.close(); }
});
