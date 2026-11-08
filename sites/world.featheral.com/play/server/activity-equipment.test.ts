import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { accrue, apply, execute, parseCommand, snapshot } from './economy.ts';
import { createFundedFixtureAccount } from './test-support.ts';
import { craft, equipActivity, inventory } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { activityEquipmentBenefit, activityEquipmentDiscount, activityEquipmentItems, discountedActivityCost, equipmentActivities } from '../src/activity-equipment.ts';
import { craftingCost, craftingIngredients, craftingMaximum, decorationItems, itemStorage, sellableItemCount } from '../src/items.ts';
import type { ItemId } from '../src/items.ts';
import type { Command } from '../src/api-types.ts';
import { dollarsScale } from '../src/dollars.ts';
import { recruitmentDollars } from '../src/engine.ts';
import { explorationCount, explorationQuote, investigationQuote, nextExploration, nextInvestigation } from '../src/workforce.ts';
import { gameConsumption } from '../src/consumption.ts';
import { craftingPanel, inventoryPanel } from '../src/inventory-view.ts';
import { itemArt } from '../src/item-art.ts';
import { translate } from '../src/i18n.ts';

const start = 1000000;
function fixture() {
  const account = createFundedFixtureAccount(start);
  account.game.seed = 1542;
  execute(account, { type: 'upgrade' }, start);
  account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
  account.game.dollars = 100000 * dollarsScale;
  inventory(account).items = [];
  return account;
}
function act(account: ReturnType<typeof fixture>, command: Command) {
  return apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 2000);
}
function supplyRecipe(account: ReturnType<typeof fixture>, item: keyof typeof activityEquipmentItems, quantity = 1) {
  const bag = inventory(account);
  for (const [id, amount] of Object.entries(craftingIngredients(item, quantity)))
    for (let n = 0; n < amount; n++) bag.items.push(id as ItemId);
  for (let x = -12; x <= 12; x++) for (let y = -12; y <= 12; y++) account.game.explored.push(`${x},${y}`);
}
test('nine staged equipment recipes consume decorations and unused permits atomically and match confirmations', () => {
  assert.equal(Object.keys(activityEquipmentItems).length, 9);
  for (const [id, recipe] of Object.entries(activityEquipmentItems)) {
    const item = id as keyof typeof activityEquipmentItems, account = fixture(), bag = inventory(account);
    account.game.stage = recipe.stage;
    supplyRecipe(account, item, 2);
    assert.ok(Object.keys(recipe.ingredients).some(input => Object.hasOwn(decorationItems, input)));
    assert.ok(Object.keys(recipe.ingredients).some(input => input.startsWith('collection-')));
    assert.equal(craftingMaximum(account.game, bag, item), 2);
    const cost = craftingCost(item, 2), stock = { ...account.game.stock }, dollars = account.game.dollars;
    const quote = gameConsumption(snapshot(account), { type: 'craft', item })!;
    assert.deepEqual(quote.costs, [...Object.entries(craftingCost(item)), ...Object.entries(craftingIngredients(item))]
      .map(([asset, amount]) => ({ asset, amount })));
    assert.match(quote.notes.join(' '), /permanently/);
    craft(account, item);
    craft(account, item);
    assert.deepEqual(bag.items, [item, item]);
    assert.equal(activityEquipmentDiscount(account.game, recipe.activity), 0, 'crafting does not auto-equip');
    for (const resource of ['wood', 'water', 'metal', 'oil'] as const)
      assert.equal(account.game.stock[resource], stock[resource] - (cost[resource] ?? 0));
    assert.equal(account.game.dollars, dollars - cost.dollars! * dollarsScale);
    const saved = structuredClone(account);
    assert.throws(() => craft(account, item), /unused decoration or collector/);
    assert.deepEqual(account, saved);
    assert.match(itemArt(item), /<svg/);
    assert.notEqual(translate(recipe.name, 'ko'), recipe.name);
    assert.notEqual(translate(activityEquipmentBenefit(item), 'ko'), activityEquipmentBenefit(item));
  }
});
test('placed inputs, market escrow, pending finds, stages and missing resources cannot be bypassed', () => {
  const account = fixture(), bag = inventory(account);
  supplyRecipe(account, 'survey-satchel');
  bag.layout!.positions.banner = { x: -9, y: 9 };
  assert.equal(craftingMaximum(account.game, bag, 'survey-satchel'), 0);
  const before = structuredClone(account);
  assert.throws(() => craft(account, 'survey-satchel'), /Return placed/);
  assert.deepEqual(account, before);
  bag.items.push('banner');
  craft(account, 'survey-satchel');
  assert.ok(bag.items.includes('banner'));
  assert.deepEqual(bag.layout!.positions.banner, { x: -9, y: 9 });
  delete bag.layout!.positions.banner;
  bag.items = []; bag.marketReserved = ['banner', 'logseat', 'collection-wood-1', 'collection-wood-1'];
  bag.pending = [...bag.marketReserved];
  assert.equal(craftingMaximum(account.game, bag, 'survey-satchel'), 0);
  assert.throws(() => craft(account, 'survey-satchel'), /unused decoration/);
  assert.throws(() => craft(account, 'survey-array'), /civilization level/);
  supplyRecipe(account, 'survey-satchel');
  account.game.stock.metal = 0;
  const unfunded = structuredClone(account);
  assert.throws(() => craft(account, 'survey-satchel'), /Not enough resources/);
  assert.deepEqual(account, unfunded);
});
test('crafting combines inputs even in a full inventory without consuming active timers', () => {
  const account = fixture(), bag = inventory(account);
  supplyRecipe(account, 'survey-satchel');
  while (bag.items.length < itemStorage[bag.storage].capacity) bag.items.push('torch');
  account.automationUntil!.wood = start + 5000;
  const timers = structuredClone(account.automationUntil), before = bag.items.length;
  craft(account, 'survey-satchel');
  assert.equal(bag.items.length, before - 3);
  assert.deepEqual(account.automationUntil, timers);
});
test('one permanent slot per activity replaces rather than stacks and protects only equipped copies', () => {
  const account = fixture(), bag = inventory(account);
  bag.items.push('survey-satchel', 'survey-array', 'survey-array', 'trail-network', 'welcome-network');
  equipActivity(account, 'investigation', 'survey-satchel');
  assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 10);
  equipActivity(account, 'investigation', 'survey-array');
  equipActivity(account, 'exploration', 'trail-network');
  equipActivity(account, 'attraction', 'welcome-network');
  for (const activity of equipmentActivities) assert.equal(activityEquipmentDiscount(account.game, activity), 50);
  assert.equal(sellableItemCount(bag, 'survey-array'), 1);
  assert.equal(sellableItemCount(bag, 'survey-satchel'), 1);
  assert.throws(() => equipActivity(account, 'investigation', 'trail-network'), /matching/);
  bag.items.splice(bag.items.indexOf('survey-array'), 1);
  assert.equal(sellableItemCount(bag, 'survey-array'), 0);
  equipActivity(account, 'investigation', null);
  assert.equal(sellableItemCount(bag, 'survey-array'), 1);
  assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 0);
  assert.equal(activityEquipmentDiscount(account.game, 'exploration'), 50);
});
test('every equipment tier applies exactly its own discount with upward four-decimal rounding', () => {
  for (const [id, recipe] of Object.entries(activityEquipmentItems)) {
    const game = { activityEquipment: { [recipe.activity]: id as keyof typeof activityEquipmentItems } };
    for (const base of [.0001, .1, .1001, 199.9999]) {
      const units = Math.round(base * dollarsScale);
      const expected = Math.ceil(units * (100 - recipe.discount) / 100);
      assert.equal(discountedActivityCost(game, recipe.activity, base), expected / dollarsScale);
      assert.ok(expected >= units / 2, 'never grants more than 50% off');
      assert.ok(expected > 0);
    }
  }
});
test('strict commands reject wrong slots, unowned gear and client supplied discounts', () => {
  assert.deepEqual(parseCommand({ type: 'activity-gear', activity: 'exploration', item: 'trail-kit' }),
    { type: 'activity-gear', activity: 'exploration', item: 'trail-kit' });
  for (const command of [
    { type: 'activity-gear', activity: 'exploration', item: 'survey-array' },
    { type: 'activity-gear', activity: 'invalid', item: null },
    { type: 'activity-gear', activity: 'attraction', item: 'welcome-network', discount: 100 },
  ]) assert.throws(() => parseCommand(command), /Invalid command/);
  const account = fixture();
  assert.throws(() => act(account, { type: 'activity-gear', activity: 'attraction', item: 'welcome-kit' }), /matching/);
  account.game.activityEquipment = { investigation: 'survey-array', exploration: 'trail-network' };
  inventory(account);
  assert.deepEqual(account.game.activityEquipment, {}, 'game mirror cannot grant unowned bonuses');
});
test('manual field prices exactly match quotes, remain independent and preserve paid jobs on unequip', () => {
  for (const activity of ['investigation', 'exploration'] as const) {
    const account = fixture(), bag = inventory(account), game = account.game;
    const destination = activity === 'investigation' ? nextInvestigation(game, [])! : nextExploration(game, [])!;
    const quoteFor = activity === 'investigation' ? investigationQuote : explorationQuote;
    const base = quoteFor(game, destination.x, destination.y, 0).dollars;
    bag.items.push('survey-array', 'trail-network');
    equipActivity(account, 'exploration', 'trail-network');
    assert.equal(investigationQuote(game, destination.x, destination.y, 0).dollars,
      investigationQuote({ ...game, activityEquipment: {} }, destination.x, destination.y, 0).dollars);
    equipActivity(account, 'investigation', 'survey-array');
    const expected = discountedActivityCost(game, activity, base);
    const command: Command = { type: activity === 'investigation' ? 'investigate' : 'move', x: destination.x, y: destination.y };
    assert.equal(gameConsumption(snapshot(account), command)!.costs[0].amount, expected);
    const money = game.dollars;
    execute(account, command, account.updatedAt);
    assert.equal(game.dollars, money - Math.round(expected * dollarsScale));
    const paid = structuredClone(account.workforce);
    equipActivity(account, activity, null);
    assert.deepEqual(account.workforce, paid);
    assert.equal(explorationCount(snapshot(account).workforce.expeditions), 1);
    assert.equal(quoteFor(game, destination.x, destination.y, 1).dollars, base * 2);
  }
});
test('recruitment fees, snapshot and confirmation agree without changing arrival population', () => {
  const account = fixture(), bag = inventory(account);
  bag.items.push('welcome-network');
  const base = snapshot(account).recruitmentDollars;
  equipActivity(account, 'attraction', 'welcome-network');
  const state = snapshot(account), quote = gameConsumption(state, { type: 'invite' })!;
  assert.equal(state.recruitmentDollars, base / 2);
  assert.equal(quote.costs[0].amount, base / 2);
  const money = account.game.dollars;
  execute(account, { type: 'invite' }, account.updatedAt);
  assert.equal(account.game.dollars, money - base / 2 * dollarsScale);
  assert.equal(account.recruitment!.population, quote.arrivals);
  const paid = structuredClone(account.recruitment);
  equipActivity(account, 'attraction', null);
  assert.deepEqual(account.recruitment, paid);
});
test('automatic exploration and attraction use discounted affordability and preserve offline progress', () => {
  for (const activity of ['exploration', 'attraction'] as const) {
    const account = fixture(), bag = inventory(account);
    const gear = activity === 'exploration' ? 'trail-network' : 'welcome-network';
    const permit = activity === 'exploration' ? 'activity-exploration-4' : 'activity-attraction-4';
    bag.items.push(gear, permit);
    equipActivity(account, activity, gear);
    const now = account.updatedAt + 2000;
    const cost = activity === 'exploration' ? nextExploration(account.game, [])!.dollars
      : recruitmentDollars(account.game.population, 0, now, account.game);
    account.game.dollars = Math.round(cost * dollarsScale);
    const result = act(account, { type: 'activate-activity', item: permit });
    assert.equal(account.game.dollars, 0);
    assert.equal(result.activityAutomation![activity].reason, activity === 'exploration' ? 'Waiting for expedition return' : 'Waiting for recruitment arrival');
    const once = structuredClone(account), frequent = structuredClone(account);
    const end = now + 10000;
    accrue(once, end);
    for (let time = now + 1000; time <= end; time += 1000) accrue(frequent, time);
    assert.deepEqual(once, frequent);
  }
});
test('equipment survives SQLite session serialization and idempotent command retries', () => {
  const store = new SqliteStore(':memory:', () => start), session = store.create();
  try {
    store.transaction(session.token, ({ account }) => {
      inventory(account).items.push('survey-satchel');
      const body = { id: randomUUID(), revision: account.revision,
        command: { type: 'activity-gear', activity: 'investigation', item: 'survey-satchel' } as const };
      const result = apply(account, body, start);
      assert.deepEqual(apply(account, body, start + 2000), result);
    });
    store.read(session.token, ({ account }) => {
      assert.equal(snapshot(account).inventory.activityEquipment!.investigation, 'survey-satchel');
      assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 10);
    });
  } finally { store.close(); }
});
test('cost equipment UI has nine compact recipes, available input counts and three equipment slots', () => {
  const account = fixture();
  supplyRecipe(account, 'survey-satchel');
  const state = snapshot(account);
  const html = craftingPanel(state, () => '', 'efficiency', 'en');
  assert.equal((html.match(/data-action="craft"/g) ?? []).length, 9);
  assert.match(html, /10% lower investigation fees/);
  assert.match(html, /Wood auto-collection/);
  assert.match(html, /1 \/ 1/);
  inventory(account).items.push('survey-satchel');
  equipActivity(account, 'investigation', 'survey-satchel');
  const panel = inventoryPanel(snapshot(account), () => '', 'efficiency', 'en');
  assert.equal((panel.match(/class="activity-equipment-slot"/g) ?? []).length, 3);
  assert.match(panel, /data-action="activity-gear" data-activity="investigation"/);
});
