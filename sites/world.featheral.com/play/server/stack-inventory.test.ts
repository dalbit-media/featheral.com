import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createFundedFixtureAccount } from './test-support.ts';
import { addPermitFind, collectFinds, findCustomizationItem, inventory } from './inventory.ts';
import { snapshot } from './economy.ts';
import { canCollectFinds, craftableKeys, craftingFits, craftingMaximum, inventoryFits, inventoryUsed, itemStorage } from '../src/items.ts';
import type { ItemId } from '../src/items.ts';
import { inventoryPanel } from '../src/inventory-view.ts';
import { customizationKeys } from '../src/customization.ts';
import { terrainDetails } from '../src/engine.ts';

test('stack capacity includes owned, equipped, placed and reserved copies only once per item type', () => {
  const account = createFundedFixtureAccount(1000000), bag = inventory(account);
  bag.items = [...Array<ItemId>(1000).fill('torch'), 'bench'];
  bag.equipped = 'torch';
  bag.placements = { square: 'bench' };
  bag.marketReserved = [...Array<ItemId>(1000).fill('torch'), 'bench', 'lamp'];
  assert.equal(inventoryUsed(bag), 3);
  bag.items.push(...craftableKeys.filter(id => !['torch', 'bench', 'lamp'].includes(id)).slice(0, 17));
  assert.equal(inventoryUsed(bag), 20);
  assert.ok(inventoryFits(bag, 'torch'));
  assert.ok(inventoryFits(bag, 'lamp'));
  assert.equal(inventoryFits(bag, 'collector-all-52'), false);
});

test('crafting releases a slot only when all owned ingredients are consumed and no escrow remains', () => {
  const account = createFundedFixtureAccount(1000000), bag = inventory(account);
  account.game.stage = 0;
  account.game.dollars = 100000000;
  const filler = craftableKeys.filter(id => id !== 'collector-wood-4' && id !== 'collection-wood-1').slice(0, 19);
  bag.items = [...filler, ...Array<ItemId>(4).fill('collection-wood-1')];
  assert.ok(craftingFits(bag, 'collector-wood-4', 1));
  assert.equal(craftingMaximum(account.game, bag, 'collector-wood-4'), 1);
  bag.items.push('collection-wood-1');
  assert.equal(craftingFits(bag, 'collector-wood-4', 1), false);
  assert.equal(craftingMaximum(account.game, bag, 'collector-wood-4'), 0);
  bag.items.pop();
  bag.marketReserved = ['collection-wood-1'];
  assert.equal(craftingFits(bag, 'collector-wood-4', 1), false);
  bag.items[0] = 'collector-wood-4';
  assert.ok(craftingFits(bag, 'collector-wood-4', 1));
});

test('full bags accept repeated finds and collect every copy of a fitting stack without discarding overflow', () => {
  const account = createFundedFixtureAccount(1000000), bag = inventory(account);
  bag.items = ['collection-wood-1', ...craftableKeys.filter(id => id !== 'collection-wood-1' && id !== 'collection-water-1').slice(0, 19)];
  addPermitFind(account, 'collection-wood-1');
  assert.equal(inventoryUsed(bag), 20);
  assert.equal(bag.items.filter(id => id === 'collection-wood-1').length, 2);
  assert.deepEqual(bag.pending, []);
  bag.pending = ['collection-water-1', 'collection-wood-1', 'collection-water-1'];
  assert.ok(canCollectFinds(bag));
  collectFinds(account);
  assert.equal(bag.items.filter(id => id === 'collection-wood-1').length, 3);
  assert.deepEqual(bag.pending, ['collection-water-1', 'collection-water-1']);
  assert.equal(canCollectFinds(bag), false);
  bag.items.splice(1, 1);
  collectFinds(account);
  assert.equal(inventoryUsed(bag), 20);
  assert.equal(bag.items.filter(id => id === 'collection-water-1').length, 2);
  assert.deepEqual(bag.pending, []);
});

test('finds share non-unique reserved stacks while unique keepsake reservations remain protected', () => {
  const account = createFundedFixtureAccount(1000000), bag = inventory(account);
  const custom = customizationKeys[Object.keys(terrainDetails).indexOf('water') % customizationKeys.length];
  bag.items = craftableKeys.filter(id => !['collection-water-1', custom].includes(id)).slice(0, 18);
  bag.marketReserved = ['collection-water-1', custom];
  addPermitFind(account, 'collection-water-1');
  findCustomizationItem(account, 'water');
  assert.equal(inventoryUsed(bag), 20);
  assert.ok(bag.items.includes('collection-water-1'));
  assert.ok(bag.items.includes(custom));
  bag.pending = ['relic-forest'];
  bag.marketReserved = ['collection-water-1', 'relic-forest'];
  assert.equal(canCollectFinds(bag), false);
  assert.throws(() => collectFinds(account), /reserved/);
});

test('storage unlocks exactly 20 slots and one page per tier up to 200 slots and ten pages', () => {
  const account = createFundedFixtureAccount(1000000), bag = inventory(account);
  assert.equal(itemStorage.length, 10);
  bag.items = Array<ItemId>(1000).fill('torch');
  for (let tier = 0; tier < itemStorage.length; tier++) {
    bag.storage = tier;
    assert.equal(itemStorage[tier].capacity, (tier + 1) * 20);
    const state = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 as const };
    const html = inventoryPanel(state, () => '', 'all', 'en', 'settlement', tier);
    assert.equal((html.match(/data-action="inventory-page"/g) ?? []).length, tier + 1);
    assert.equal((html.match(/class="inventory-slot(?: empty)?"/g) ?? []).length, 20);
    assert.match(html, new RegExp(`Page ${tier + 1} of ${tier + 1}`));
    assert.match(html, new RegExp(`1 / ${itemStorage[tier].capacity}`));
    if (tier === 9) assert.match(html, /Maximum item storage/);
  }
  bag.storage = 0;
  bag.items = ['collection-wood-1', ...craftableKeys.filter(id => id !== 'collection-wood-1').slice(0, 19)];
  bag.pending = ['collection-wood-1'];
  const state = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 as const };
  assert.match(inventoryPanel(state, () => '', 'all', 'en'), /data-action="collect-items" >Collect finds/);
});
