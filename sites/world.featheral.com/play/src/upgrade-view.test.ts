import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply, capacity, createAccount, execute, snapshot } from '../server/economy.ts';
import type { ApiState } from './api-types.ts';
import { civicUpgradeCards, commercialUpgradeCards, constructionUpgradeCards, warehouseUpgradeCard, waterUpgradeCards } from './upgrade-view.ts';
import { constructionCost, constructionKeys, constructionLevel, constructions } from './constructions.ts';
import { stages } from './engine.ts';
import { warehouseCost } from './costs.ts';
import { resourceCapacity, resourceKeys, warehouseCapacity } from './workforce.ts';
import { gameConsumption } from './consumption.ts';
import { translate } from './i18n.ts';

function fixture(stage = 8) {
  const account = createAccount(1000000);
  account.game.stage = stage;
  account.game.population = 0;
  account.game.home = stage >= 0 ? { x: 0, y: 0 } : null;
  account.game.stock = { wood: 100000000, water: 100000000, metal: 100000000, oil: 100000000 };
  account.game.dollars = 100000000 * 10000;
  return account;
}
function state(account: ReturnType<typeof fixture>): ApiState {
  return { ...snapshot(account), csrf: 'test', clockSpeed: 1, population: { global: 0, federation: null } };
}
test('upgrade cards explain material and currency shortages in physical units without dead-end disabled buttons', () => {
  const account = fixture();
  account.game.stock.wood = 79; account.game.stock.metal = 19; account.game.dollars = 0;
  const html = warehouseUpgradeCard(state(account), 'en');
  assert.match(html, /Missing supplies/);
  assert.match(html, /Missing: 50 kg/); assert.match(html, /Missing: 0.01 t/);
  assert.match(html, /Missing: [\d,]+ FTH\$/);
  assert.match(html, /data-action="warehouse"[^>]* disabled/);
  assert.match(html, /Upgrade cost/); assert.match(html, /Owned/);
  assert.match(html, /aria-label="Review build: Resource warehouse, Level 1"/);
  assert.match(html, /upgrade-capacity/);
});
test('construction cards preserve unlocks, exact next-level costs, legacy levels and maximum level 99', () => {
  const account = fixture(0);
  let html = constructionUpgradeCards(state(account), 'en');
  assert.match(html, /data-construction="housing"[^>]*>.*Review build/);
  assert.match(html, /data-construction="workshop"[^>]* disabled/);
  assert.match(html, /Requires settlement tier/);
  account.game.stage = 8; account.game.incomeFacilities = { workshop: true, 'trade-hub': true };
  html = constructionUpgradeCards(state(account), 'en');
  assert.match(html, /Review upgrade: Commercial workshop, Level 2/);
  for (const kind of constructionKeys) {
    const level = constructionLevel(account.game, kind);
    assert.deepEqual(constructionCost(account.game, kind), Object.fromEntries(Object.entries(constructions[kind].cost).map(([asset, amount]) => [asset, amount * (level + 1)])));
    account.game.constructionLevels = { ...account.game.constructionLevels, [kind]: 99 };
  }
  html = constructionUpgradeCards(state(account), 'en');
  assert.equal((html.match(/Maximum level/g) ?? []).length, 4);
  assert.doesNotMatch(html, /data-action="construction"|Next level|Upgrade cost/);
});
test('warehouse preview uses the authoritative capacity rule at every tier and level', () => {
  for (let stage = 0; stage < stages.length; stage++) {
    const account = fixture(stage);
    for (const level of [0, 1, 50, 98, 99]) {
      account.warehouse = level;
      const tier = stages[stage + 1] ?? stages[stage];
      const need = Math.max(...resourceKeys.map(resource => tier.cost[resource] ?? 0));
      const expected = Math.max(100 + stage * 100 + level * 500, need * (level + 1));
      assert.equal(warehouseCapacity(account.game, level), expected);
      assert.equal(capacity(account), expected);
      assert.equal(state(account).capacity, expected);
    }
  }
  assert.equal(warehouseCapacity(fixture(-1).game, 0), 0);
  const max = fixture(); max.warehouse = 99;
  const html = warehouseUpgradeCard(state(max), 'en');
  assert.match(html, /Maximum level/);
  assert.doesNotMatch(html, /data-action="warehouse"|Capacity after upgrade|Next level/);
});
test('water and civic facilities keep action routing and distinguish already built from locked and affordable', () => {
  const account = fixture(0);
  assert.match(waterUpgradeCards(state(account), 'en'), /data-action="water-facility" data-facility="well"/);
  assert.match(civicUpgradeCards(state(account), 'en'), /data-action="bank"[^>]* disabled/);
  account.game.stage = 8; account.game.bank = true; account.game.townhall = true;
  account.game.waterFacilities = { well: true, rainCollector: true, pumpingStation: true };
  account.game.incomeFacilities = { 'market-stall': true };
  for (const html of [waterUpgradeCards(state(account), 'en'), civicUpgradeCards(state(account), 'en'), commercialUpgradeCards(state(account), 'en')]) {
    assert.match(html, /Built/);
    assert.doesNotMatch(html, /data-action=|Missing supplies|Upgrade cost/);
  }
});
test('warehouse and all constructions reach level 99 with exact reviewed costs, unchanged production and no duplicate spending', () => {
  const account = fixture(); account.warehouse = 98;
  const original = state(account), cost = warehouseCost(99), funds = account.game.dollars;
  assert.deepEqual(gameConsumption(original, { type: 'warehouse' })!.costs, Object.entries(cost).map(([asset, amount]) => ({ asset, amount })));
  const body = { id: randomUUID(), revision: account.revision, command: { type: 'warehouse' } };
  const result = apply(account, body, account.updatedAt, account.updatedAt);
  assert.equal(account.warehouse, 99);
  assert.equal(account.game.dollars, funds - cost.dollars * 10000);
  assert.equal(account.game.stock.wood, original.game.stock.wood - cost.wood);
  assert.equal(account.game.stock.metal, original.game.stock.metal - cost.metal);
  assert.deepEqual(apply(account, body, account.updatedAt, account.updatedAt), result);
  assert.throws(() => execute(account, { type: 'warehouse' }), /maximum level/);
  for (const kind of constructionKeys) {
    account.game.constructionLevels = { ...account.game.constructionLevels, [kind]: 98 };
    const before = state(account), required = constructionCost(account.game, kind)!;
    const quote = gameConsumption(before, { type: 'construction', kind })!;
    assert.deepEqual(quote.costs, Object.entries(required).map(([asset, amount]) => ({ asset, amount })));
    execute(account, { type: 'construction', kind });
    assert.equal(constructionLevel(account.game, kind), 99);
    assert.deepEqual(state(account).workforce.crews, before.workforce.crews);
    assert.throws(() => execute(account, { type: 'construction', kind }), /maximum/);
  }
});
test('upgrade status and review labels are bilingual, including long names and shortage explanations', () => {
  for (const label of ['Level', 'Current', 'Maximum level', 'Review upgrade', 'Review build', 'Upgrade cost', 'Missing', 'Missing supplies', 'Ready to upgrade', 'Ready to build', 'Requires settlement tier', 'Capacity after upgrade', 'Locked']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
  const account = fixture();
  const html = warehouseUpgradeCard(state(account), 'ko');
  assert.match(html, /건설 검토/); assert.match(html, /필요 비용/);
  account.game.population = 1000000;
  account.game.constructionLevels = { cistern: 20 };
  assert.ok(resourceCapacity(capacity(account), 'water', account.game) > capacity(account));
  assert.match(constructionUpgradeCards(state(account), 'ko'), /현재/);
});
