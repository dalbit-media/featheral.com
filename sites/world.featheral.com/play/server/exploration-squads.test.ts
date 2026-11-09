import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAccount, accrue, apply, execute, parseCommand, snapshot } from './economy.ts';
import { craft, inventory } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { squadKeys, squadItems, planSquad } from '../src/exploration-squads.ts';
import type { SquadActivity, SquadItem } from '../src/exploration-squads.ts';
import { craftingCost, itemName, inventoryUsed } from '../src/items.ts';
import { gameConsumption } from '../src/consumption.ts';
import { itemArt } from '../src/item-art.ts';
import { translate } from '../src/i18n.ts';
import { investigationQuote, explorationQuote, workforceCounts } from '../src/workforce.ts';
import { worldWeekMs } from '../src/environment.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { fieldMissionActivity, squadOptions } from '../src/squad-options.ts';
import { craftingPanel, inventoryPanel } from '../src/inventory-view.ts';
import type { ApiState } from '../src/api-types.ts';
import { marketBasePrice, marketAssets } from '../src/market.ts';
import { filterMarketCatalog } from '../src/marketplace-catalog.ts';
import { seedFixturePools } from './test-support.ts';

test('all squad sizes have executable dynamic buys and sales, recorded history and receipt replay', () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time);
  try {
    seedFixturePools(store);
    const user = store.create();
    store.transaction(user.token, session => {
      session.account.game.stage = 0;
      session.account.game.population = 0;
      session.account.game.dollars = dollarsUnits(1000000);
    });
    const total = store.publicTotals().dollars;
    for (const asset of squadKeys) {
      time += 1000;
      const before = store.transaction(user.token, (session, now, realTime, exchange, owner) =>
        exchange.read(owner, session.account, now, realTime, asset, 10));
      assert.ok(before.market.quotes.buy.available, asset);
      const buy = { id: randomUUID(), revision: before.revision,
        command: { type: 'spot', side: 'buy', asset, quantity: 10, limitDollars: before.market.quotes.buy.dollars } };
      const purchased = store.transaction(user.token, (session, now, realTime, exchange, owner) =>
        exchange.action(owner, session, buy, now, realTime));
      assert.equal(purchased.inventory.items.filter(item => item === asset).length, 10);
      const afterBuy = store.transaction(user.token, (session, now, realTime, exchange, owner) =>
        exchange.read(owner, session.account, now, realTime, asset, 10));
      assert.ok(afterBuy.market.quotes.buy.dollars > before.market.quotes.buy.dollars, asset);
      assert.ok(afterBuy.market.quotes.sell.available, asset);
      time += 250;
      const sell = { id: randomUUID(), revision: purchased.revision,
        command: { type: 'spot', side: 'sell', asset, quantity: 10, limitDollars: afterBuy.market.quotes.sell.dollars } };
      const sold = store.transaction(user.token, (session, now, realTime, exchange, owner) =>
        exchange.action(owner, session, sell, now, realTime));
      assert.equal(sold.inventory.items.includes(asset), false);
      assert.equal(sold.market.history.length, 2);
      assert.ok(sold.market.history.every(fill => fill.asset === asset && fill.quantity === 10));
      const saved = store.read(user.token, session => structuredClone(session.account));
      store.transaction(user.token, (session, now, realTime, exchange, owner) =>
        exchange.action(owner, session, sell, now, realTime));
      assert.deepEqual(store.read(user.token, session => session.account), saved);
      assert.equal(store.publicTotals().dollars, total);
    }
  } finally { store.close(); }
});

const start = 1000000;
function fixture() {
  const account = createAccount(start);
  account.game.stage = 0; account.game.population = 200; account.game.seed = 1542;
  account.game.home = account.game.position = { x: 0, y: 0 };
  account.game.stock = { wood: 1000000, water: 1000000, metal: 1000000, oil: 1000000 };
  account.game.dollars = Number.MAX_SAFE_INTEGER;
  account.game.explored = Array.from({ length: 21 }, (_, x) => Array.from({ length: 21 }, (_, y) => `${x - 10},${y - 10}`)).flat();
  snapshot(account);
  account.workforce!.automatic = false;
  account.workforce!.allocation = { wood: 0, water: 0, metal: 0, oil: 0 };
  account.workforce!.crews = {};
  inventory(account).items = [...squadKeys, ...squadKeys];
  return account;
}
function command(account: ReturnType<typeof fixture>, item: SquadItem, activity: SquadActivity) {
  const plan = planSquad(account.game, account.workforce!, activity, squadItems[item].quantity);
  return { type: 'dispatch-squad', item, activity, quantity: plan.missions.length, maximumDollars: plan.dollarsUnits } as const;
}
test('four vouchers craft as stackable, tradeable items with unique art and bilingual names', () => {
  assert.deepEqual(squadKeys.map(item => squadItems[item].quantity), [10, 20, 50, 100]);
  assert.equal(new Set(squadKeys.map(itemArt)).size, 4);
  for (const item of squadKeys) {
    const account = fixture(), bag = inventory(account), cost = craftingCost(item);
    bag.items = []; const before = structuredClone(account.game.stock);
    craft(account, item);
    assert.deepEqual(bag.items, [item]); assert.equal(inventoryUsed(bag), 1);
    assert.equal(account.game.stock.wood, before.wood - cost.wood!);
    assert.notEqual(translate(itemName(item), 'ko'), itemName(item));
  }
});
test('all four sizes launch the feasible batch, preserving exponential fees, workers and one-week investigation returns', () => {
  for (const item of squadKeys) {
    const account = fixture(), work = account.workforce!, request = command(account, item, 'investigation');
    const plan = planSquad(account.game, work, 'investigation', squadItems[item].quantity);
    assert.ok(request.quantity > 0 && request.quantity <= squadItems[item].quantity);
    if (squadItems[item].quantity <= 20) assert.equal(request.quantity, squadItems[item].quantity);
    else assert.ok(request.quantity < squadItems[item].quantity);
    assert.equal(new Set(plan.missions.map(mission => `${mission.x},${mission.y}`)).size, request.quantity);
    assert.equal(plan.dollarsUnits, plan.missions.reduce((sum, mission, index) =>
      sum + Math.round(investigationQuote(account.game, mission.x, mission.y, index).dollars * dollarsScale), 0));
    const before = snapshot(account), confirmation = gameConsumption(before, request)!;
    assert.equal(confirmation.residents, request.quantity * 2);
    assert.deepEqual(confirmation.costs, [{ asset: item, amount: 1 }, { asset: 'dollars', amount: plan.dollarsUnits / dollarsScale }]);
    execute(account, request);
    assert.equal(work.expeditions.length, request.quantity);
    assert.equal(inventory(account).items.filter(id => id === item).length, 1);
    assert.equal(account.game.dollars, before.game.dollars - plan.dollarsUnits);
    assert.equal(workforceCounts(account.game.population, work).available, 200 - request.quantity * 2);
    assert.ok(work.expeditions.every(mission => mission.kind === 'investigate' && mission.readyAt === start + worldWeekMs));
    const restored = structuredClone(account);
    accrue(restored, start + worldWeekMs - 1);
    assert.equal(restored.workforce!.expeditions.length, request.quantity);
    accrue(restored, start + worldWeekMs);
    assert.equal(restored.workforce!.expeditions.length, 0);
    assert.deepEqual(restored.game.explored, before.game.explored);
  }
});
test('bulk exploration avoids redundant destinations, respects active routes and reveals only on return', () => {
  const account = fixture(), work = account.workforce!;
  account.game.explored = ['0,0'];
  const request = command(account, 'squad-20', 'exploration'), plan = planSquad(account.game, work, 'exploration', 20);
  assert.ok(plan.missions.length > 1);
  const before = structuredClone(account.game.explored);
  execute(account, request);
  assert.deepEqual(account.game.explored, before);
  for (const mission of work.expeditions) {
    assert.equal(mission.workers, 2);
    assert.equal(mission.readyAt, start + explorationQuote(account.game, mission.x, mission.y).weeks * worldWeekMs);
  }
  const next = planSquad(account.game, work, 'exploration', 100);
  assert.ok(next.missions.every(mission => !work.expeditions.some(active => active.x === mission.x && active.y === mission.y)));
  accrue(account, Math.max(...work.expeditions.map(mission => mission.readyAt)));
  assert.equal(work.expeditions.length, 0);
  assert.ok(account.game.explored.length > before.length);
});
test('funds, idle residents, targets, missing vouchers, supply shortages and changed confirmations never consume on failure', () => {
  const account = fixture(), work = account.workforce!;
  work.crews.wood = { workers: 197, readyAt: start + worldWeekMs, weeklyYield: 0, weeklyMetalCost: 0 };
  assert.equal(planSquad(account.game, work, 'investigation', 100).missions.length, 1);
  work.crews = {};
  account.game.dollars = 0;
  assert.equal(planSquad(account.game, work, 'investigation', 100).missions.length, 0);
  account.game.dollars = Number.MAX_SAFE_INTEGER;
  const request = command(account, 'squad-10', 'investigation');
  for (const change of [
    () => { account.game.dollars = 0; },
    () => { inventory(account).items = []; },
    () => { account.game.stock.water = 0; },
    () => { account.game.explored = []; },
  ]) {
    const original = structuredClone(account); change();
    const before = structuredClone(account);
    assert.throws(() => execute(account, request));
    assert.deepEqual(account, before);
    Object.assign(account, original);
  }
  const before = structuredClone(account);
  assert.throws(() => execute(account, { ...request, maximumDollars: 1 }), /requirements changed/);
  assert.deepEqual(account, before);
  for (const invalid of [{ ...request, quantity: 0 }, { ...request, quantity: 11 }, { ...request, item: 'torch' },
    { ...request, activity: 'attraction' }, { ...request, quantity: 1.5 }, { ...request, maximumDollars: Infinity },
    { ...request, targets: [] }]) assert.throws(() => parseCommand(invalid), /Invalid command/);
});
test('one server action has an idempotent receipt and cooldown instead of one request per destination', () => {
  const store = new SqliteStore(':memory:', () => start), identity = store.create();
  try {
    store.transaction(identity.token, session => { Object.assign(session.account, fixture()); });
    const body = store.read(identity.token, session => ({ id: randomUUID(), revision: session.account.revision,
      command: command(session.account, 'squad-10', 'investigation') }));
    const first = store.transaction(identity.token, session => apply(session.account, body, start, start));
    const retry = store.transaction(identity.token, session => apply(session.account, body, start, start));
    assert.deepEqual(retry, first);
    store.read(identity.token, session => {
      assert.equal(session.account.workforce!.expeditions.length, body.command.quantity);
      assert.equal(inventory(session.account).items.filter(item => item === 'squad-10').length, 1);
      assert.throws(() => execute(session.account, command(session.account, 'squad-20', 'investigation'), start + 1), /cooling down/);
    });
  } finally { store.close(); }
});
test('normal field action options expose only owned vouchers with exact partial previews and no separate inventory action', () => {
  const account = fixture();
  account.game.dollars = 1000 * dollarsScale;
  const state: ApiState = { ...snapshot(account), csrf: 'test', population: { global: 200, federation: null }, clockSpeed: 1 };
  const options = squadOptions(state, 'investigation');
  assert.equal(options.length, 4);
  for (const option of options) {
    const plan = planSquad(state.game, state.workforce, 'investigation', squadItems[option.item].quantity);
    assert.equal(option.command.quantity, plan.missions.length);
    assert.equal(option.command.maximumDollars, plan.dollarsUnits);
  }
  for (const item of squadKeys) {
    assert.ok(marketAssets.includes(item));
    assert.ok(marketBasePrice(item) > 0);
    assert.notEqual(translate(itemName(item), 'ko'), itemName(item));
  }
  const inventoryHtml = inventoryPanel(state, () => '', 'bulk', 'en', 'explore', 0, 'squad-20');
  assert.doesNotMatch(inventoryHtml, /data-action="dispatch-squad"/);
  assert.match(inventoryHtml, /Click Explore or Investigate/);
  const recipes = craftingPanel(state, () => '', 'bulk', 'explore', 1, 'en');
  for (const item of squadKeys) assert.ok(recipes.includes(`data-item="${item}"`));
  const ticks = squadKeys.map(asset => ({ asset, bid: 1, ask: 2, last: null }));
  assert.equal(filterMarketCatalog(ticks, state, 'en', 'automation', '', 'name', false).length, 4);
  const request = command(account, 'squad-100', 'investigation'), consumption = gameConsumption(state, request)!;
  assert.ok(translate(consumption.subject, 'ko').includes('조사'));
  state.inventory.items = ['squad-10'];
  state.inventory.marketReserved = ['squad-20'];
  state.inventory.pending = ['squad-50'];
  assert.deepEqual(squadOptions(state, 'exploration').map(option => option.item), ['squad-10']);
  state.inventory.items = [];
  assert.deepEqual(squadOptions(state, 'investigation'), []);
  state.inventory.items = ['squad-10'];
  state.game.population = 0;
  assert.ok(squadOptions(state, 'investigation')[0].reason);
  state.game.population = 200;
  state.waterUpkeep = { ...state.waterUpkeep!, paused: true };
  assert.match(squadOptions(state, 'investigation')[0].reason!, /adequate supplies/);
});
test('field choices apply only to investigations and new exploration, preserving known travel and founding', () => {
  const account = fixture(), game = account.game;
  assert.equal(fieldMissionActivity({ type: 'investigate', x: 0, y: 0 }, game), 'investigation');
  assert.equal(fieldMissionActivity({ type: 'move', x: 100, y: 100 }, game), 'exploration');
  assert.equal(fieldMissionActivity({ type: 'move', x: 0, y: 0 }, game), null);
  assert.equal(fieldMissionActivity({ type: 'gather' }, game), null);
  game.stage = -1;
  assert.equal(fieldMissionActivity({ type: 'move', x: 100, y: 100 }, game), null);
});
