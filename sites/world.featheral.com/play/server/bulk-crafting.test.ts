import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply, execute, parseCommand, snapshot } from './economy.ts';
import { createFundedFixtureAccount } from './test-support.ts';
import { craft, inventory } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { bulkCraftingItems, bulkCraftingKeys, craftBatchOptions } from '../src/bulk-crafting.ts';
import { craftingCost, craftingIngredients, craftingInputs, craftingStage, itemName } from '../src/items.ts';
import type { ItemId } from '../src/items.ts';
import { craftingPanel } from '../src/inventory-view.ts';
import { gameConsumption } from '../src/consumption.ts';
import { itemArt } from '../src/item-art.ts';
import { translate } from '../src/i18n.ts';

const start = 1000000;
function fixture() {
  const account = createFundedFixtureAccount(start);
  account.game.seed = 1542;
  execute(account, { type: 'upgrade' }, start);
  account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 100000 };
  account.game.dollars = 100000000;
  account.game.explored = Array.from({ length: 41 }, (_, x) => Array.from({ length: 41 }, (_, y) => `${x - 20},${y - 20}`)).flat();
  inventory(account).items = [];
  return account;
}
test('four exact batch permits use decorations and collectors, have distinct art and Korean names', () => {
  assert.deepEqual(bulkCraftingKeys.map(id => bulkCraftingItems[id].quantity), [10, 20, 50, 100]);
  assert.equal(new Set(bulkCraftingKeys.map(itemArt)).size, 4);
  for (const id of bulkCraftingKeys) {
    const account = fixture(), bag = inventory(account);
    account.game.stage = craftingStage(id);
    for (const [input, quantity] of Object.entries(craftingIngredients(id)))
      for (let i = 0; i < quantity; i++) bag.items.push(input as ItemId);
    assert.ok(bag.items.some(item => item.startsWith('collection-')));
    const quote = gameConsumption(snapshot(account), { type: 'craft', item: id })!;
    assert.deepEqual(quote.costs, [...Object.entries(craftingCost(id)), ...Object.entries(craftingIngredients(id))].map(([asset, amount]) => ({ asset, amount })));
    craft(account, id);
    assert.deepEqual(bag.items, [id]);
    assert.notEqual(translate(itemName(id), 'ko'), itemName(id));
  }
});
test('each exact batch consumes one matching permit and all raw resources, including 100 copies in a 100-slot bag', () => {
  for (const id of bulkCraftingKeys) {
    const account = fixture(), bag = inventory(account), quantity = bulkCraftingItems[id].quantity;
    bag.storage = 4;
    bag.items = [id];
    const before = account.game.stock.wood;
    const quote = gameConsumption(snapshot(account), { type: 'craft', item: 'torch', quantity })!;
    assert.deepEqual(quote.receives, [{ asset: 'torch', amount: quantity }]);
    assert.equal(quote.costs.find(cost => cost.asset === id)!.amount, 1);
    craft(account, 'torch', quantity);
    assert.equal(account.game.stock.wood, before - craftingCost('torch', quantity).wood!);
    assert.equal(bag.items.length, quantity);
    assert.ok(bag.items.every(item => item === 'torch'));
  }
});
test('single crafting requires no permit, arbitrary batches and wrong permits fail without spending', () => {
  const account = fixture(), bag = inventory(account);
  craft(account, 'torch');
  bag.items.push('craft-batch-100');
  for (const quantity of [2, 9, 11, 19, 21, 49, 51, 99, 101, 10.5, NaN]) {
    const before = structuredClone(account);
    assert.throws(() => craft(account, 'torch', quantity), /Invalid crafting quantity/);
    assert.deepEqual(account, before);
    assert.throws(() => parseCommand({ type: 'craft', item: 'torch', quantity }), /Invalid command/);
  }
  const before = structuredClone(account);
  assert.throws(() => craft(account, 'torch', 10), /matching bulk/);
  assert.deepEqual(account, before);
  assert.throws(() => parseCommand({ type: 'craft', item: 'torch', quantity: 10, permit: 'craft-batch-100' }), /Invalid command/);
});
test('failed batches retain permits for shortages, capacity, undiscovered resources and placed ingredients', () => {
  for (const failure of ['resources', 'capacity', 'discovery', 'ingredients', 'stage'] as const) {
    const account = fixture(), bag = inventory(account);
    bag.items = ['craft-batch-10'];
    const item = failure === 'ingredients' ? 'survey-satchel' : failure === 'stage' ? 'gazebo' : 'torch';
    if (failure === 'resources') account.game.stock.wood = 0;
    if (failure === 'capacity') while (bag.items.length < 20) bag.items.push('lamp');
    if (failure === 'discovery') account.game.explored = [];
    if (failure === 'ingredients') {
      bag.storage = 4;
      for (const [input, count] of Object.entries(craftingIngredients(item, 10)))
        for (let n = 0; n < count; n++) bag.items.push(input as ItemId);
      bag.layout!.positions.banner = { x: -9, y: 9 };
    }
    const before = structuredClone(account);
    assert.throws(() => craft(account, item, 10));
    assert.deepEqual(account, before);
  }
});
test('escrow and pending permits do not unlock batches and maximum only includes feasible owned exact options', () => {
  const account = fixture(), bag = inventory(account);
  bag.marketReserved = ['craft-batch-50'];
  assert.equal(craftBatchOptions(account.game, bag, 'torch').length, 1);
  bag.marketReserved = [];
  bag.items = ['craft-batch-10', 'craft-batch-20', 'craft-batch-50', 'craft-batch-100'];
  account.game.stock.wood = 8 * 20;
  const options = craftBatchOptions(account.game, bag, 'torch');
  assert.deepEqual(options.map(option => option.quantity), [1, 10, 20, 50, 100]);
  assert.equal(options.find(option => option.quantity === 10)!.reason, null);
  assert.equal(options.find(option => option.quantity === 20)!.reason, 'Item inventory full');
  assert.equal(options.find(option => option.quantity === 50)!.reason, 'Not enough resources');
  const html = craftingPanel(snapshot(account), () => '', 'utility');
  assert.match(html, /Maximum available batch: 10/);
  assert.doesNotMatch(html, /data-crafting-quantity/);
});
test('bulk permit crafting also requires a matching batch permit, counted once in addition to recipe ingredients', () => {
  const account = fixture(), bag = inventory(account);
  bag.storage = 4;
  bag.items = ['craft-batch-10'];
  for (const [input, count] of Object.entries(craftingIngredients('craft-batch-10', 10)))
    for (let n = 0; n < count; n++) bag.items.push(input as ItemId);
  assert.equal(craftingInputs('craft-batch-10', 10)['craft-batch-10'], 1);
  craft(account, 'craft-batch-10', 10);
  assert.deepEqual(bag.items, Array.from({ length: 10 }, () => 'craft-batch-10'));
});
test('bulk commands persist the same recipe cooldown, consume once and replay receipts without another permit', () => {
  const account = fixture(), bag = inventory(account);
  bag.storage = 4; bag.items = ['craft-batch-10', 'craft-batch-20'];
  const body = { id: randomUUID(), revision: account.revision, command: { type: 'craft', item: 'torch', quantity: 10 } };
  const result = apply(account, body, start + 2000), saved = structuredClone(account);
  assert.deepEqual(apply(account, body, start + 2200), result);
  assert.deepEqual(account, saved);
  assert.throws(() => execute(account, { type: 'craft', item: 'torch', quantity: 20 }, start + 3999), /cooling down/);
  assert.ok(bag.items.includes('craft-batch-20'));
  execute(account, { type: 'craft', item: 'bench' }, start + 2300);
  execute(account, { type: 'craft', item: 'torch', quantity: 20 }, start + 4000);
  assert.equal(bag.items.filter(item => item === 'torch').length, 30);
  assert.ok(!bag.items.includes('craft-batch-20'));
});
test('historically accepted arbitrary batches remain replayable without consuming new permits', () => {
  const account = fixture();
  const id = randomUUID(), command = { type: 'craft', item: 'torch', quantity: 3 }, revision = account.revision;
  const saved = { ...snapshot(account), message: 'Crafted 3 × Torch.' };
  account.receipt = { id, request: JSON.stringify({ revision, command }), result: saved };
  const before = structuredClone(account);
  assert.equal(apply(account, { id, revision, command }, start + 2000).message, saved.message);
  assert.deepEqual(account, before);
  assert.throws(() => apply(account, { id: randomUUID(), revision, command }, start + 2000), /Invalid command/);
});
test('stored bulk permits, completed batches and their retry receipts survive session serialization', () => {
  const store = new SqliteStore(':memory:', () => start), session = store.create();
  try {
    store.transaction(session.token, ({ account }) => {
      Object.assign(account, fixture());
      inventory(account).storage = 4;
      inventory(account).items = ['craft-batch-10'];
    });
    const body = store.read(session.token, ({ account }) => ({
      id: randomUUID(), revision: account.revision, command: { type: 'craft', item: 'torch', quantity: 10 },
    }));
    const result = store.transaction(session.token, ({ account }) => apply(account, body, start + 2000));
    const restored = store.read(session.token, ({ account }) => {
      assert.equal(account.inventory!.items.filter(item => item === 'torch').length, 10);
      assert.ok(!account.inventory!.items.includes('craft-batch-10'));
      assert.equal(account.actionReadyAt!['craft:torch'], start + 4000);
      return apply(account, body, start + 2500);
    });
    assert.deepEqual(restored, result);
  } finally { store.close(); }
});
