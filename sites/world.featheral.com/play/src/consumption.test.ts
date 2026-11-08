import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply, createAccount, resources, snapshot } from '../server/economy.ts';
import type { Command } from './api-types.ts';
import { gameConsumption, marketConsumption } from './consumption.ts';
import { translate } from './i18n.ts';
import { dollarsSlippage } from './dollars.ts';
import { explorationQuote, nextExploration } from './workforce.ts';

function fixture() {
  const account = createAccount(1000000);
  account.game.seed = 1542;
  account.game.stage = 6;
  account.game.population = 100000;
  account.game.home = { x: 0, y: 0 };
  for (const resource of resources) account.game.stock[resource] = 1000000;
  account.game.stock.water = account.game.population * 105 * 2;
  account.game.dollars = 1000000 * 10000;
  const work = snapshot(account).workforce;
  work.automatic = false;
  account.workforce = work;
  return account;
}
test('paid pickup, protected collect-and-sell and automation activation have exact confirmation shapes', () => {
  const account = fixture();
  account.pending.wood = 100 * 60000;
  account.pickupFees!.wood = 2 * 10000;
  const before = snapshot(account), claim = gameConsumption(before, { type: 'claim', resource: 'wood' })!;
  assert.equal(claim.subject, 'Wood');
  assert.deepEqual(claim.costs, [{ asset: 'dollars', amount: 2 }]);
  assert.deepEqual(claim.receives, [{ asset: 'wood', amount: 100 }]);
  const result = apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'claim', resource: 'wood' } }, account.updatedAt + 1000);
  assert.equal(before.dollars - result.dollars, 2);
  const sale = gameConsumption(before, { type: 'collect-sell', resource: 'wood', quantity: 100, minimumDollars: 12345 })!;
  assert.equal(sale.subject, 'Wood');
  assert.deepEqual(sale.receives, [{ asset: 'dollars', amount: 1.2345 }]);
  const automation = gameConsumption(before, { type: 'activate-collection', item: 'collection-wood-4' })!;
  assert.deepEqual(automation.costs, [{ asset: 'collection-wood-4', amount: 1 }]);
  assert.equal(automation.weeks, 4);
});
test('every one-shot gameplay payment matches the authoritative resource deduction', () => {
  const commands: Command[] = [
    { type: 'move', x: 5, y: 0 }, { type: 'investigate', x: 0, y: 0 }, { type: 'invite' }, { type: 'upgrade' },
    { type: 'build', kind: 'bank' }, { type: 'build', kind: 'townhall' },
    { type: 'build', kind: 'well' }, { type: 'build', kind: 'rainCollector' }, { type: 'build', kind: 'pumpingStation' },
    { type: 'warehouse' }, { type: 'item-storage' }, { type: 'craft', item: 'bench' },
    { type: 'construction', kind: 'housing' }, { type: 'construction', kind: 'cistern' },
    { type: 'construction', kind: 'workshop' }, { type: 'construction', kind: 'logistics' },
    { type: 'diplomacy', action: 'gift' }, { type: 'diplomacy', action: 'form' },
  ];
  for (const command of commands) {
    const account = fixture(), before = snapshot(account), quote = gameConsumption(before, command);
    assert.ok(quote, JSON.stringify(command));
    const after = apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000);
    for (const resource of resources) {
      assert.equal(before.game.stock[resource] - after.game.stock[resource],
        quote.costs.find(cost => cost.asset === resource)?.amount ?? 0, `${JSON.stringify(command)}: ${resource}`);
    }
    assert.equal(before.dollars - after.dollars, quote.costs.find(cost => cost.asset === 'dollars')?.amount ?? 0);
    for (const label of [quote.title, quote.subject, ...quote.notes]) {
      if ((command.type === 'move' || command.type === 'investigate') && label === quote.subject) continue;
      assert.notEqual(translate(label, 'ko'), label, label);
    }
  }
});
test('concurrent expedition previews and confirmation costs match authoritative charges', () => {
  const account = fixture();
  for (let concurrent = 0; concurrent < 4; concurrent++) {
    const before = snapshot(account), destination = nextExploration(before.game, before.workforce.expeditions)!;
    const command = { type: 'move', x: destination.x, y: destination.y } as const;
    const base = explorationQuote(before.game, command.x, command.y);
    const confirmation = gameConsumption(before, command)!;
    assert.equal(destination.dollars, base.dollars * 2 ** concurrent);
    assert.deepEqual(confirmation.costs, [{ asset: 'dollars', amount: destination.dollars }]);
    const after = apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000);
    assert.equal(before.dollars - after.dollars, destination.dollars);
    assert.equal(after.workforce.expeditions.length, concurrent + 1);
    assert.equal(after.availableWorkers, before.availableWorkers - 2);
  }
  for (const invalid of [-1, .5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => explorationQuote(account.game, 5, 0, invalid), /Invalid concurrent/);
});
test('founding, recruitment and expeditions disclose their different staffing and timing', () => {
  const account = createAccount(1000000), initial = snapshot(account);
  assert.deepEqual(gameConsumption(initial, { type: 'upgrade' })?.costs,
    [{ asset: 'wood', amount: 60 }, { asset: 'water', amount: 40 }]);
  const state = snapshot(fixture());
  const recruit = gameConsumption(state, { type: 'invite' })!;
  assert.equal(recruit.weeks, 1);
  assert.equal(recruit.arrivals, state.recruitmentDollars / 50);
  assert.equal(recruit.residents, undefined);
  const explore = gameConsumption(state, { type: 'move', x: 5, y: 0 })!;
  assert.equal(explore.residents, 2);
  assert.ok(explore.weeks! >= 1 && explore.weeks! <= 3);
  assert.equal(gameConsumption(state, { type: 'build', kind: 'well' })!.weeks, 0);
});
test('free movement, claims, allocation, equipment and market cancellation need no spending prompt', () => {
  const state = snapshot(fixture());
  for (const command of [
    { type: 'move', x: 0, y: 0 }, { type: 'home' }, { type: 'claim' }, { type: 'equip', item: null },
    { type: 'assign', resource: 'water', workers: 4 }, { type: 'automatic', enabled: false },
    { type: 'diplomacy', action: 'join' }, { type: 'diplomacy', action: 'vote' }, { type: 'collect-items' },
  ] satisfies Command[]) assert.equal(gameConsumption(state, command), null);
  assert.equal(marketConsumption({ type: 'cancel', orderId: 1 }), null);
  state.game.stage = 8;
  state.inventory.storage = 4;
  state.warehouseCost = null;
  for (const command of [{ type: 'upgrade' }, { type: 'item-storage' }, { type: 'warehouse' }] satisfies Command[]) {
    assert.equal(gameConsumption(state, command), null);
  }
});
test('market confirmations retain exact FTH$ limits, quantities and held-order semantics', () => {
  for (const side of ['buy', 'sell'] as const) {
    const limitDollars = dollarsSlippage(1.2345, side);
    const spot = marketConsumption({ type: 'spot', side, asset: 'water', quantity: 3, limitDollars })!;
    assert.deepEqual(spot.costs, [{ asset: side === 'buy' ? 'dollars' : 'water', amount: side === 'buy' ? limitDollars : 3 }]);
    assert.deepEqual(spot.receives, [{ asset: side === 'buy' ? 'water' : 'dollars', amount: side === 'buy' ? 3 : limitDollars }]);
    const limit = marketConsumption({ type: 'limit', side, asset: 'wood', quantity: 3, price: 0.0001 })!;
    assert.equal((side === 'buy' ? limit.costs : limit.receives)![0].amount, 0.0003);
    assert.equal(limit.weeks, null);
    assert.match(limit.notes[0], /held/);
    for (const label of [spot.title, spot.subject, ...spot.notes, ...limit.notes, spot.costLabel!, spot.receiveLabel!, limit.receiveLabel!]) {
      assert.notEqual(translate(label, 'ko'), label, label);
    }
  }
});
test('all common confirmation labels and game-week durations are bilingual', () => {
  for (const label of ['Confirm action', 'Confirm', 'Cancel', 'You spend', 'You receive', 'Assigned residents',
    'Arriving residents', 'Duration', 'Immediate', 'Until filled or cancelled', 'Nothing is spent until you confirm.',
    'Requirements changed. Review the updated costs and try again.', '1 game day', '1 game weeks', '2 game weeks', '3 game weeks']) {
    assert.notEqual(translate(label, 'ko'), label, label);
    assert.equal(translate(label, 'en'), label);
  }
});
test('investigation confirmation explains the exact week, population, probability and fees in both languages', () => {
  const quote = gameConsumption(snapshot(fixture()), { type: 'investigate', x: 0, y: 0 })!;
  assert.equal(quote.days, undefined); assert.equal(quote.weeks, 1); assert.equal(quote.residents, 2);
  for (const label of [quote.title, ...quote.notes]) {
    assert.notEqual(translate(label, 'ko'), label, label);
    assert.equal(translate(label, 'en'), label, label);
  }
});
