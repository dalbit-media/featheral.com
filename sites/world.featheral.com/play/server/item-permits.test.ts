import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sqlite from '../../../../services/database/sqlite.js';
import { apply, createAccount, execute, parseCommand, snapshot } from './economy.ts';
import { collectFinds, craft, findCustomizationItem, inventory, useCustomization } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { collectorRecipes } from '../src/collector-recipes.ts';
import type { CollectorBundle } from '../src/collector-recipes.ts';
import { collectionItemDetails, collectionPolicy } from '../src/collection.ts';
import { customizationKeys, titleItems } from '../src/customization.ts';
import { craftingFits, craftingIngredients, craftingMaximum, itemName, itemStorage } from '../src/items.ts';
import { marketAssets, marketBasePrice, marketResources } from '../src/market.ts';
import { worldWeekMs } from '../src/environment.ts';
import { gameConsumption } from '../src/consumption.ts';
import { ChatArchive } from './chat.ts';
import { craftingPanel, inventoryPanel } from '../src/inventory-view.ts';
import { translate } from '../src/i18n.ts';
import type { ApiState } from '../src/api-types.ts';

function settled() {
  const account = createAccount(1000000);
  account.game.stage = 0; account.game.home = { x: 0, y: 0 }; account.game.population = 0;
  return account;
}
test('all twenty collector recipes preserve exact time per resource, including annual all-resource bundles', () => {
  assert.equal(Object.keys(collectorRecipes).length, 20);
  assert.deepEqual(collectionPolicy, { version: 1, payOnPickup: true, allWorkersPay: true, automationDurations: [1, 4, 12] });
  for (const item of Object.keys(collectorRecipes) as CollectorBundle[]) {
    const account = settled(), bag = inventory(account), detail = collectionItemDetails(item);
    const totals = { wood: 0, water: 0, metal: 0, oil: 0 };
    for (const [ingredient, count] of Object.entries(craftingIngredients(item))) {
      const source = collectionItemDetails(ingredient as keyof ReturnType<typeof craftingIngredients>);
      assert.notEqual(source.resource, 'all');
      if (source.resource !== 'all') totals[source.resource] += source.weeks * count;
      for (let i = 0; i < count; i++) bag.items.push(ingredient as keyof ReturnType<typeof craftingIngredients>);
    }
    for (const resource of marketResources) assert.equal(totals[resource], detail.resource === 'all' || detail.resource === resource ? detail.weeks : 0);
    const funds = account.game.dollars, stock = structuredClone(account.game.stock);
    assert.equal(craftingMaximum(account.game, bag, item), 1);
    craft(account, item);
    assert.deepEqual(bag.items, [item]); assert.equal(account.game.dollars, funds); assert.deepEqual(account.game.stock, stock);
    execute(account, { type: 'activate-collection', item });
    assert.deepEqual(bag.items, []);
    for (const resource of marketResources) assert.equal(account.automationUntil![resource], totals[resource] ? account.updatedAt + totals[resource] * worldWeekMs : 0);
  }
});
test('collector crafting batches free full inventory slots, reject escrow inputs and disclose exact consumed copies', () => {
  const account = settled(), bag = inventory(account);
  bag.items = Array.from({ length: itemStorage[0].capacity }, () => 'collection-wood-1' as const);
  assert.ok(craftingFits(bag, 'collector-wood-4', 5));
  assert.equal(craftingMaximum(account.game, bag, 'collector-wood-4'), 5);
  const quote = gameConsumption(snapshot(account), { type: 'craft', item: 'collector-wood-4', quantity: 5 })!;
  assert.deepEqual(quote.costs, [{ asset: 'collection-wood-1', amount: 20 }]);
  craft(account, 'collector-wood-4', 5);
  assert.deepEqual(bag.items, Array.from({ length: 5 }, () => 'collector-wood-4'));
  bag.items = []; bag.marketSelling = ['collection-wood-1']; bag.marketReserved = ['collection-wood-1'];
  bag.pending = ['collection-wood-1']; account.automationUntil = { wood: account.updatedAt + worldWeekMs, water: 0, metal: 0, oil: 0 };
  const before = structuredClone(account);
  assert.throws(() => craft(account, 'collector-wood-4'), /Not enough collector/);
  assert.deepEqual(account, before);
});
test('all-resource activation stacks each expiry independently and fails atomically on unsafe time', () => {
  const account = settled(), bag = inventory(account);
  bag.items.push('collector-all-52');
  account.automationUntil = { wood: account.updatedAt + 4 * worldWeekMs, water: 1, metal: account.updatedAt + 2 * worldWeekMs, oil: 0 };
  const old = { ...account.automationUntil };
  execute(account, { type: 'activate-collection', item: 'collector-all-52' });
  for (const resource of marketResources) assert.equal(account.automationUntil[resource], Math.max(old[resource], account.updatedAt) + 52 * worldWeekMs);
  assert.equal(account.game.bank, false);
  bag.items.push('collector-all-52'); account.automationUntil.oil = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(account);
  assert.throws(() => execute(account, { type: 'activate-collection', item: 'collector-all-52' }), /Account limit/);
  assert.deepEqual(account, before);
});
test('naming permits and fixed player titles validate, consume once, survive snapshots and never change ownership', () => {
  const account = settled(), bag = inventory(account);
  bag.items.push('permit-settlement-name', 'permit-region-name', 'title-explorer');
  const game = structuredClone(account.game);
  useCustomization(account, 'permit-settlement-name', "  Oak   Haven  ");
  useCustomization(account, 'permit-region-name', '푸른 골짜기');
  useCustomization(account, 'title-explorer', 'Explorer');
  assert.deepEqual(snapshot(account).customization, { settlementName: 'Oak Haven', regionName: '푸른 골짜기', title: 'title-explorer' });
  assert.deepEqual(account.game.home, game.home); assert.equal(account.game.federation, game.federation); assert.equal(bag.items.length, 0);
  assert.throws(() => useCustomization(account, 'permit-settlement-name', 'Other'), /not available/);
  for (const value of ['<script>', 'x', 'a'.repeat(41), 'Oak\u202eHaven', 'Oak\nHaven']) {
    assert.throws(() => parseCommand({ type: 'use-customization', item: 'permit-region-name', value }), /Invalid command/);
  }
  assert.throws(() => parseCommand({ type: 'use-customization', item: 'title-explorer', value: 'Administrator' }), /Invalid command/);
  bag.items.push('title-explorer');
  assert.throws(() => useCustomization(account, 'title-explorer', 'Explorer'), /already active/);
  assert.deepEqual(bag.items, ['title-explorer']);
  bag.items.push('permit-region-name');
  assert.throws(() => useCustomization(account, 'permit-region-name', '<script>'), /Names must/);
  assert.ok(bag.items.includes('permit-region-name'));
});
test('naming permits and title badges are craftable and repeatable expedition finds with safe overflow', () => {
  const account = settled(), bag = inventory(account);
  account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
  account.game.explored = Array.from({ length: 81 }, (_, x) => Array.from({ length: 81 }, (_, y) => `${x - 40},${y - 40}`)).flat();
  for (const item of customizationKeys) {
    craft(account, item);
    assert.ok(bag.items.includes(item));
    assert.ok(marketAssets.includes(item));
    assert.ok(marketBasePrice(item) > 0);
  }
  bag.items = Array.from({ length: 20 }, () => 'torch' as const);
  findCustomizationItem(account, 'forest'); findCustomizationItem(account, 'forest');
  assert.equal(bag.pending.length, 2); assert.equal(bag.pending[0], bag.pending[1]);
  bag.marketReserved = [bag.pending[0]]; bag.items.splice(0, 3);
  collectFinds(account);
  assert.equal(bag.pending.length, 0);
  assert.equal(bag.items.filter(id => id === bag.marketReserved![0]).length, 2);
  assert.equal(marketAssets.length, new Set(marketAssets).size);
});
test('market trades transfer customization permits and annual collectors without activating them, conserving funds', () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time), seller = store.create(), buyer = store.create();
  try {
    for (const identity of [seller, buyer]) store.transaction(identity.token, session => { session.account.game.stage = 0; session.account.game.population = 0; });
    store.transaction(buyer.token, session => { session.account.game.dollars = 2000 * 10000; });
    for (const item of ['permit-settlement-name', 'title-artisan', 'collector-all-52', 'collector-metal-26'] as const) {
      store.transaction(seller.token, (session, _, __, exchange) => {
        session.account.game.dollars = 1000 * 10000; inventory(session.account).items.push(item, item, item);
        exchange.fundPool(session.account, item, 1, 100 * 10000);
      });
      const initial = store.publicTotals().dollars;
      const action = (token: string, command: unknown) => {
        time += 1000;
        return store.transaction(token, (session, now, real, exchange, owner) =>
          exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision, command }, now, real));
      };
      action(buyer.token, { type: 'limit', asset: item, side: 'buy', quantity: 2, price: 200 });
      action(seller.token, { type: 'spot', asset: item, side: 'sell', quantity: 2, limitDollars: 5 });
      assert.equal(store.read(buyer.token, session => inventory(session.account).items.filter(id => id === item).length), 2);
      assert.equal(store.publicTotals().dollars, initial);
      assert.equal(store.read(buyer.token, session => session.account.customization), undefined);
      assert.ok(!store.read(buyer.token, session => session.account.automationUntil?.wood));
    }
  } finally { store.close(); }
});
test('permit actions replay once and settlement display labels preserve room identities and permissions', () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time), identity = store.create();
  try {
    store.transaction(identity.token, session => {
      session.account.game.stage = 0; session.account.game.home = { x: 0, y: 0 }; session.account.game.population = 0;
      inventory(session.account).items.push('permit-settlement-name', 'permit-region-name', 'title-trader');
    });
    const owner = store.chatSession(identity.token).owner;
    store.chat.rename(owner, 'Original player', time);
    const before = store.chatDirectory.directory(owner, time);
    const body = { id: randomUUID(), revision: store.read(identity.token, session => session.account.revision),
      command: { type: 'use-customization', item: 'permit-settlement-name', value: 'New Harbor' } };
    time += 1000;
    const run = () => store.transaction(identity.token, (session, now, real) => apply(session.account, body, now, real));
    const changed = run(); assert.deepEqual(run(), changed);
    store.transaction(identity.token, session => {
      useCustomization(session.account, 'permit-region-name', 'Coastal Reach');
      useCustomization(session.account, 'title-trader', 'Trader');
    });
    const after = store.chatDirectory.directory(owner, time);
    assert.equal(after.ownSettlement, before.ownSettlement);
    assert.equal(after.settlements[0].name, 'New Harbor'); assert.equal(after.settlements[0].regionName, 'Coastal Reach');
    assert.equal(store.chatDirectory.authorize(owner, after.rooms[0].id, time).name, 'New Harbor');
    assert.equal(store.chatDirectory.visitor(owner, after.ownSettlement!, time).name, 'New Harbor');
    assert.equal(store.chat.profile(owner)!.nickname, 'Original player');
    assert.equal(store.chat.profile(owner)!.title, 'title-trader');
  } finally { store.close(); }
});
test('chat title history preserves the title at sending without rewriting older messages', () => {
  const db = sqlite.open(':memory:');
  try {
    const archive = new ChatArchive(db, () => 'title-artisan');
    archive.rename('owner', 'Player', 1000000);
    const profile = archive.profile('owner')!;
    const message = archive.append('owner', profile, { id: randomUUID(), text: 'Hello', createdAt: 1000000 }, 1000000);
    assert.equal(message.title, 'title-artisan');
    assert.ok(archive.history().includes('title-artisan'));
    const reopened = new ChatArchive(db, () => 'title-trader');
    assert.ok(reopened.history().includes('title-artisan'));
    assert.equal(reopened.profile('owner')!.title, 'title-trader');
    assert.equal(itemName(profile.title!), 'Artisan title badge');
    assert.equal(titleItems[profile.title!].title, 'Artisan');
  } finally { db.close(); }
});
test('collector recipes and identity controls disclose inputs, safe text entry and bilingual item names', () => {
  const account = settled(), bag = inventory(account);
  bag.items.push('collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-4');
  let state: ApiState = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  const html = craftingPanel(state, () => '', 'collectors');
  assert.match(html, /Wood auto-collection · 12 game weeks <strong>4 \/ 4<\/strong>/);
  assert.match(html, /data-item="collector-wood-52"\s*>Craft/);
  assert.match(html, /data-item="collector-all-52" disabled/);
  bag.items.push('permit-settlement-name', 'title-naturalist');
  state = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  const permit = inventoryPanel(state, () => '', 'customization', 'en', 'settlement', 0, 'permit-settlement-name');
  assert.match(permit, /data-customization-name type="text"/); assert.match(permit, /minlength="2" maxlength="40"/);
  assert.match(permit, /Review customization/);
  const badge = inventoryPanel(state, () => '', 'customization', 'en', 'settlement', 0, 'title-naturalist');
  assert.doesNotMatch(badge, /data-customization-name/); assert.match(badge, /Player title: Naturalist/);
  for (const item of [...customizationKeys, ...Object.keys(collectorRecipes) as CollectorBundle[]]) {
    assert.notEqual(translate(itemName(item), 'ko'), itemName(item));
  }
  for (const item of Object.values(titleItems)) assert.notEqual(translate(item.title, 'ko'), item.title);
  const quote = gameConsumption(state, { type: 'use-customization', item: 'permit-settlement-name', value: 'Explore' })!;
  assert.equal(quote.subject, 'Explore'); assert.equal(quote.literalSubject, true);
});
