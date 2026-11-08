import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, parseCommand, snapshot } from '../server/economy.ts';
import { craft, inventory } from '../server/inventory.ts';
import { craftingPanel } from './inventory-view.ts';
import { craftingMaximum, decorationItems, craftingStage, craftingStageName, isCraftableItem, isDecorationItem, itemName } from './items.ts';
import type { DecorationItem } from './items.ts';
import type { ApiState } from './api-types.ts';
import { decorationDrawing, itemArt } from './item-art.ts';
import { isMarketAsset, marketBasePrice } from './market.ts';
import { translate } from './i18n.ts';

function fixture(): ApiState {
  const account = createAccount(1000000);
  account.game.stage = 8;
  account.game.population = 12;
  account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
  account.game.dollars = 100000000;
  account.game.explored = Array.from({ length: 61 }, (_, x) => Array.from({ length: 61 }, (_, y) => `${x - 30},${y - 30}`)).flat();
  return { ...snapshot(account), csrf: 'test', clockSpeed: 1, population: { global: 12, federation: null } };
}
test('30 decorations cover all nine civilization levels with distinct artwork, recipes, translations and market support', () => {
  const ids = Object.keys(decorationItems) as DecorationItem[];
  assert.equal(ids.length, 30);
  assert.deepEqual([...new Set(ids.map(craftingStage))].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(ids.map(decorationDrawing)).size, 30);
  for (const id of ids) {
    assert.ok(isCraftableItem(id) && isDecorationItem(id) && isMarketAsset(id));
    assert.ok(marketBasePrice(id) > 0);
    assert.match(itemArt(id), /<svg viewBox="0 0 64 64"/);
    assert.doesNotMatch(decorationDrawing(id), /undefined|NaN/);
    assert.notEqual(translate(itemName(id), 'ko'), itemName(id));
    assert.ok(Object.values(decorationItems[id].cost).every(amount => Number.isSafeInteger(amount) && amount > 0));
    assert.deepEqual(parseCommand({ type: 'craft', item: id, quantity: 10 }), { type: 'craft', item: id, quantity: 10 });
  }
  assert.equal(Object.hasOwn(decorationItems.fountain.cost, 'wood'), false);
  assert.equal(decorationItems.logseat.cost.wood, 6);
  assert.equal(decorationItems.biodome.cost.water, 160);
});
test('civilization-level crafting checks are authoritative and leave existing owned cosmetics usable', () => {
  for (const id of Object.keys(decorationItems) as DecorationItem[]) {
    if (!craftingStage(id)) continue;
    const account = createAccount(1000000);
    account.game.stage = craftingStage(id) - 1;
    const bag = inventory(account);
    bag.items = [id];
    const before = structuredClone(account);
    assert.equal(craftingMaximum(account.game, bag, id), 0);
    assert.throws(() => craft(account, id), new RegExp(`Requires ${craftingStageName(id)}`));
    assert.deepEqual(account, before);
    assert.ok(bag.items.includes(id));
  }
});
test('recipe disclosure counts sufficient ingredient types and shows physical owned/needed amounts for the batch', () => {
  const state = fixture();
  state.game.stock.metal = 2;
  state.game.stock.wood = 10;
  const html = craftingPanel(state, () => '', 'decoration', 'settlement', 2);
  const bench = html.split('data-detail="recipe-bench"')[1].split('</article>')[0];
  assert.match(bench, /<span>Recipe<\/span> <strong>0\/2<\/strong>/);
  assert.match(bench, /500 kg \/ 2,400 kg/);
  assert.match(bench, /0.02 t \/ 0.04 t/);
  assert.equal((bench.match(/class="missing"/g) ?? []).length, 2);
  assert.match(bench, /data-action-eligible="false"/);
  const logseat = html.split('data-detail="recipe-logseat"')[1].split('</article>')[0];
  assert.match(logseat, /0\/1/);
  state.game.stock.wood = 100;
  const affordable = craftingPanel(state, () => '', 'affordable');
  assert.match(affordable, /recipe-bench/);
  assert.doesNotMatch(affordable, /recipe-skybeacon/);
});
test('collector recipe 4/8 discloses usable copies only, excluding market escrow and pending finds', () => {
  const state = fixture();
  state.inventory.items = ['collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-4',
    'collection-water-12', 'collection-water-12', 'collection-water-12', 'collection-water-12', 'collection-water-4'];
  state.inventory.marketReserved = ['collection-metal-4'];
  state.inventory.pending = ['collection-oil-4'];
  const html = craftingPanel(state, () => '', 'collectors');
  const recipe = html.split('data-detail="recipe-collector-all-52"')[1].split('</article>')[0];
  assert.match(recipe, /<span>Recipe<\/span> <strong>4\/8<\/strong>/);
  assert.equal((recipe.match(/class="available"/g) ?? []).length, 4);
  assert.equal((recipe.match(/class="missing"/g) ?? []).length, 4);
  assert.match(recipe, /Metal auto-collection · 4 game weeks<\/span><strong>0 \/ 1/);
  assert.match(recipe, /Oil auto-collection · 4 game weeks<\/span><strong>0 \/ 1/);
});
test('compact craft cards show batch consumption before collapsed recipe details and name their icon action', () => {
  const html = craftingPanel(fixture(), () => '<span class="cost">batch resources</span>', 'decoration', 'settlement', 2);
  const bench = html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
  assert.ok(bench.indexOf('batch resources') < bench.indexOf('<details'));
  assert.match(bench, /class="recipe-details" data-detail="recipe-bench"/);
  assert.doesNotMatch(bench, /<details[^>]* open/);
  assert.match(bench, /compact-item-action[^>]*data-item="bench"[^>]*aria-label="Craft: Wooden bench × 2"/);
  assert.doesNotMatch(bench, /<span>Craft<\/span>/);
});
