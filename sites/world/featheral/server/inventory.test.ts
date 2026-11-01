import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply, accrue, createAccount, execute, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import type { Command } from '../src/api-types.ts';
import { radius, terrainAt, terrainDetails } from '../src/engine.ts';
import type { Cost } from '../src/engine.ts';
import { worldWeekMs } from '../src/environment.ts';
import { decorationItems, inventoryPageSize, itemStorage, visibilityItems } from '../src/items.ts';
import { collectFinds, findCollectible, inventory } from './inventory.ts';
import { cellKey, legacySpaceCells, settlementPositions } from '../src/settlement-layout.ts';

const start = 1000000;
const request = (account: Account, command: Command) => ({ id: randomUUID(), revision: account.revision, command });
function act(account: Account, command: Command) {
  return apply(account, request(account, command), account.updatedAt + 1000);
}
function settled(): Account {
  const account = createAccount(start);
  account.game.seed = 1542;
  account.game.dollars = 500 * 10000;
  act(account, { type: 'upgrade' });
  return account;
}
test('buildings and decorations move freely on the grid without economic or exploration effects', () => {
  const account = settled(), bag = inventory(account);
  bag.items = ['bench', 'planter', 'canopy', 'fountain'];
  account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 };
  const before = snapshot(account);
  act(account, { type: 'arrange', entity: 'workshop', position: { x: -8, y: -8 } });
  act(account, { type: 'arrange', entity: 'centre', position: { x: 7, y: 7 } });
  act(account, { type: 'arrange', entity: 'home-0', position: { x: 10, y: -10 } });
  act(account, { type: 'arrange', entity: 'bench', position: { x: -9, y: 9 } });
  const after = snapshot(account);
  assert.deepEqual(after.inventory.layout!.positions.workshop, { x: -8, y: -8 });
  assert.deepEqual(after.inventory.layout!.positions.centre, { x: 7, y: 7 });
  assert.deepEqual(after.inventory.layout!.positions['home-0'], { x: 10, y: -10 });
  assert.deepEqual(after.inventory.layout!.positions.bench, { x: -9, y: 9 });
  assert.deepEqual(after.game.stock, before.game.stock);
  assert.deepEqual(after.game.explored, before.game.explored);
  assert.deepEqual(after.game.home, before.game.home);
  assert.deepEqual(after.game.position, before.game.position);
  assert.deepEqual(after.workforce, before.workforce);
  assert.deepEqual(after.rates, before.rates);
  assert.equal(after.capacity, before.capacity);
  assert.equal(after.game.visibilityRadius, before.game.visibilityRadius);
  assert.equal(after.game.population, before.game.population);
  assert.deepEqual(after.inventory.items, before.inventory.items);
  act(account, { type: 'arrange', entity: 'bench', position: null });
  assert.equal(inventory(account).layout!.positions.bench, undefined);
  assert.ok(inventory(account).items.includes('bench'));
});
test('grid placement rejects occupied, water, out-of-bounds, unowned and demolished buildings without mutations', () => {
  const account = settled();
  for (const command of [
    { type: 'arrange', entity: 'workshop', position: { x: 0, y: 0 } },
    { type: 'arrange', entity: 'workshop', position: { x: 8, y: 2 } },
    { type: 'arrange', entity: 'workshop', position: { x: 11, y: 0 } },
    { type: 'arrange', entity: 'bank', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'home-19', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'bench', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'centre', position: null },
  ] satisfies Command[]) {
    const before = structuredClone(account);
    assert.throws(() => execute(account, command), /occupied|land cell|own|removed/);
    assert.deepEqual(account, before);
  }
  assert.throws(() => act(createAccount(start), { type: 'arrange', entity: 'centre', position: { x: 1, y: 1 } }), /settlement/);
});
test('arrangement payloads reject forged entities and malformed nested coordinates', () => {
  for (const command of [
    { type: 'arrange', entity: '__proto__', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'constructor', position: null },
    { type: 'arrange', entity: 'home-20', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'home-01', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'torch', position: { x: 1, y: 1 } },
    { type: 'arrange', entity: 'centre', position: { x: 1.1, y: 1 } },
    { type: 'arrange', entity: 'centre', position: { x: '1', y: 1 } },
    { type: 'arrange', entity: 'centre', position: { x: 1, y: 1, cost: 0 } },
    { type: 'arrange', entity: 'centre', position: { x: 1 } },
    { type: 'arrange', entity: 'centre', position: [] },
    { type: 'arrange', entity: 'centre' },
    { type: 'arrange', entity: 'centre', position: { x: 1, y: 1 }, cost: 0 },
  ]) {
    const account = settled(), before = structuredClone(account);
    assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000), /Invalid|Expected/);
    assert.deepEqual(account, before);
  }
});
test('legacy decoration spaces migrate once and remain compatible with free placement', () => {
  const account = settled(), bag = inventory(account);
  bag.items = ['bench', 'planter'];
  bag.placements = { square: 'bench', garden: 'planter' };
  delete bag.layout;
  const before = structuredClone(account.game);
  inventory(account);
  assert.deepEqual(bag.layout!.positions.bench, legacySpaceCells.square);
  assert.deepEqual(bag.layout!.positions.planter, legacySpaceCells.garden);
  const migrated = structuredClone(bag.layout);
  inventory(account);
  assert.deepEqual(bag.layout, migrated);
  assert.deepEqual(account.game, before);
  act(account, { type: 'arrange', entity: 'bench', position: { x: -9, y: 8 } });
  assert.deepEqual(bag.placements, { garden: 'planter' });
  act(account, { type: 'decorate', slot: 'gate', item: 'bench' });
  assert.deepEqual(bag.layout!.positions.bench, legacySpaceCells.gate);
  assert.deepEqual(bag.placements, { garden: 'planter', gate: 'bench' });
});
test('growth finds an empty default for new buildings without moving existing custom layouts', () => {
  const account = settled();
  act(account, { type: 'arrange', entity: 'home-0', position: { x: -1, y: -4 } });
  account.game.population = 25;
  account.game.stock = { wood: 500, water: 500, metal: 500, oil: 0 };
  const before = structuredClone(inventory(account).layout!.positions);
  act(account, { type: 'upgrade' });
  const positions = settlementPositions(account.game, inventory(account));
  for (const [id, position] of Object.entries(before)) assert.deepEqual(positions[id as keyof typeof positions], position);
  assert.ok(positions['home-1']);
  const cells = Object.values(positions).map(cell => cellKey(cell!));
  assert.equal(new Set(cells).size, cells.length);
});
test('arrangement retries replay exactly without reapplying moves or modifying historical receipts', () => {
  const account = settled(), body = request(account, { type: 'arrange', entity: 'workshop', position: { x: -8, y: -8 } });
  const result = apply(account, body, account.updatedAt + 1000), before = structuredClone(account);
  assert.deepEqual(apply(account, body, account.updatedAt + worldWeekMs), result);
  assert.deepEqual(account, before);
  delete account.receipt!.result.inventory!.layout;
  const legacy = structuredClone(account);
  const replay = apply(account, body, account.updatedAt + worldWeekMs);
  assert.equal(replay.inventory.layout!.version, 1);
  assert.deepEqual(account, legacy);
});
test('raw resources and resource storage never consume item slots', () => {
  const account = settled(), before = snapshot(account);
  account.game.stock.wood = 999999;
  account.pending.wood = 100 * 60000;
  const after = act(account, { type: 'claim' });
  assert.equal(after.game.stock.wood, 1000099);
  assert.equal(after.inventory.items.length, 0);
  assert.equal(after.capacity, before.capacity);
  assert.equal(after.warehouse, before.warehouse);
  assert.equal(itemStorage[after.inventory.storage].capacity, 20);
});
test('starter bags have 20 slots and every existing storage tier gains one additional 20-slot page without losing contents', () => {
  assert.equal(inventoryPageSize, 20);
  assert.deepEqual(itemStorage.map(tier => tier.capacity), [20, 40, 60, 80, 100]);
  const account = settled(), bag = inventory(account);
  bag.items = ['torch', 'bench', 'relic-forest']; bag.equipped = 'torch';
  for (let storage = 0; storage < itemStorage.length; storage++) {
    bag.storage = storage;
    const before = structuredClone(bag), result = snapshot(account);
    assert.deepEqual(result.inventory, before);
    assert.equal(itemStorage[result.inventory.storage].capacity, (storage + 1) * 20);
  }
});
test('decorations spend recipe resources but never change visibility, exploration or production', () => {
  for (const [item, recipe] of Object.entries(decorationItems)) {
    const cost: Cost = recipe.cost;
    const account = settled();
    account.game.stock = { wood: 1000, water: 1000, metal: 1000, oil: 0 };
    const before = snapshot(account);
    const after = act(account, { type: 'craft', item: item as keyof typeof decorationItems });
    for (const resource of ['wood', 'water', 'metal', 'oil'] as const) {
      assert.equal(after.game.stock[resource], before.game.stock[resource] - (cost[resource] ?? 0));
    }
    assert.ok(after.inventory.items.includes(item as keyof typeof decorationItems));
    assert.equal(after.inventory.equipped, null);
    assert.equal(radius(after.game), radius(before.game));
    assert.deepEqual(after.game.explored, before.game.explored);
    assert.deepEqual(after.rates, before.rates);
    assert.equal(after.capacity, before.capacity);
    const repeated = act(account, { type: 'craft', item: item as keyof typeof decorationItems });
    assert.equal(repeated.inventory.items.filter(id => id === item).length, 2);
  }
});
test('placing, moving, replacing and removing decorations never consumes items or extra slots', () => {
  const account = settled();
  act(account, { type: 'craft', item: 'bench' });
  act(account, { type: 'craft', item: 'planter' });
  const before = snapshot(account);
  act(account, { type: 'decorate', slot: 'square', item: 'bench' });
  assert.deepEqual(inventory(account).placements, { square: 'bench' });
  assert.throws(() => act(account, { type: 'decorate', slot: 'square', item: 'bench' }), /already placed/);
  act(account, { type: 'decorate', slot: 'garden', item: 'bench' });
  assert.deepEqual(inventory(account).placements, { garden: 'bench' });
  act(account, { type: 'decorate', slot: 'garden', item: 'planter' });
  assert.deepEqual(inventory(account).placements, { garden: 'planter' });
  act(account, { type: 'decorate', slot: 'garden', item: null });
  assert.deepEqual(inventory(account).placements, {});
  const after = snapshot(account);
  assert.deepEqual(after.inventory.items, before.inventory.items);
  assert.deepEqual(after.game.stock, before.game.stock);
  assert.equal(after.inventory.storage, before.inventory.storage);
  assert.equal(after.inventory.equipped, before.inventory.equipped);
  assert.deepEqual(after.rates, before.rates);
  assert.throws(() => act(account, { type: 'decorate', slot: 'garden', item: null }), /No decoration/);
  assert.throws(() => act(account, { type: 'decorate', slot: 'gate', item: 'fountain' }), /Craft this/);
  assert.throws(() => act(createAccount(start), { type: 'decorate', slot: 'square', item: 'bench' }), /settlement/);
});
test('decoration command validation rejects forged ownership, slots, utility items and hidden costs', () => {
  for (const command of [
    { type: 'decorate', slot: '__proto__', item: 'bench' },
    { type: 'decorate', slot: 'constructor', item: null },
    { type: 'decorate', slot: 'garden', item: '__proto__' },
    { type: 'decorate', slot: 'garden', item: 'torch' },
    { type: 'decorate', slot: 'garden', item: 'relic-forest' },
    { type: 'decorate', slot: 'garden', item: 'bench', cost: 0 },
    { type: 'decorate', slot: 'garden' }, { type: 'decorate', item: 'bench' },
    { type: 'equip', item: 'bench' },
  ]) {
    const account = settled(), before = structuredClone(account);
    assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000), /Invalid/);
    assert.deepEqual(account, before);
  }
});
test('a full inventory and empty resource balance never prevent moving or removing owned cosmetics', () => {
  const account = settled(), bag = inventory(account);
  bag.items = ['bench', 'planter', 'canopy', 'fountain'];
  for (const terrain of (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).slice(0, 16)) findCollectible(account, terrain);
  account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 };
  act(account, { type: 'decorate', slot: 'square', item: 'fountain' });
  act(account, { type: 'decorate', slot: 'riverside', item: 'fountain' });
  assert.deepEqual(bag.placements, { riverside: 'fountain' });
  act(account, { type: 'decorate', slot: 'riverside', item: null });
  assert.deepEqual(bag.placements, {});
  assert.equal(bag.items.length, 20);
  assert.deepEqual(account.game.stock, { wood: 0, water: 0, metal: 0, oil: 0 });
});
test('decoration retries and old inventory receipt normalization are read-only and exact-once', () => {
  const account = settled();
  act(account, { type: 'craft', item: 'bench' });
  const body = request(account, { type: 'decorate', slot: 'courtyard', item: 'bench' });
  const result = apply(account, body, account.updatedAt + 1000), before = structuredClone(account);
  assert.deepEqual(apply(account, body, account.updatedAt + worldWeekMs), result);
  assert.deepEqual(account, before);
  delete account.receipt!.result.inventory!.placements;
  const legacy = structuredClone(account);
  const replay = apply(account, body, account.updatedAt + worldWeekMs);
  assert.deepEqual(replay.inventory.placements, {});
  assert.deepEqual(account, legacy);
  assert.deepEqual(replay.inventory.items, result.inventory.items);
});
test('crafting spends exact owned ingredients, improves gear automatically and never reveals terrain', () => {
  const account = settled(), before = snapshot(account);
  const fire = act(account, { type: 'craft', item: 'fire' });
  assert.equal(fire.game.stock.wood, before.game.stock.wood - 15);
  assert.equal(fire.game.stock.water, before.game.stock.water - 5);
  assert.equal(fire.inventory.equipped, 'fire');
  assert.equal(radius(fire.game), 5);
  assert.deepEqual(fire.game.explored, before.game.explored);
  const torch = act(account, { type: 'craft', item: 'torch' });
  assert.equal(torch.inventory.equipped, 'torch');
  assert.equal(radius(torch.game), 6);
  assert.deepEqual(torch.inventory.items, ['fire', 'torch']);
  const stock = { ...account.game.stock };
  act(account, { type: 'craft', item: 'torch' });
  assert.deepEqual(account.game.stock, { ...stock, wood: stock.wood - 30 });
  const bag = inventory(account);
  act(account, { type: 'equip', item: 'fire' });
  assert.equal(radius(account.game), 5);
  assert.equal(bag.items.length, 3);
  act(account, { type: 'equip', item: null });
  assert.equal(radius(account.game), 4);
  assert.equal(bag.items.length, 3);
  assert.throws(() => act(account, { type: 'equip', item: 'lantern' }), /before equipping/);
});
test('owned market materials cannot bypass exploration discovery and unaffordable recipes spend nothing', () => {
  const account = settled();
  account.game.explored = [];
  account.game.stock = { wood: 500, water: 500, metal: 500, oil: 500 };
  account.game.dollars = 500 * 10000;
  const before = { ...account.game.stock };
  assert.throws(() => act(account, { type: 'craft', item: 'lantern' }), /Explore/);
  assert.deepEqual(account.game.stock, before);
  assert.deepEqual(inventory(account).items, []);
  for (let x = -30; x <= 30; x++) for (let y = -30; y <= 30; y++) account.game.explored.push(`${x},${y}`);
  const result = act(account, { type: 'craft', item: 'lantern' });
  assert.equal(radius(result.game), 10);
  assert.equal(result.game.stock.oil, 492);
  assert.equal(result.dollars, 496);
  act(account, { type: 'craft', item: 'fire' });
  assert.equal(inventory(account).equipped, 'lantern');
  account.game.stock.wood = 0;
  assert.throws(() => act(account, { type: 'craft', item: 'torch' }), /Not enough/);
  assert.equal(inventory(account).items.length, 2);
  const visitor = createAccount(start);
  assert.throws(() => act(visitor, { type: 'craft', item: 'torch' }), /settlement/);
  assert.throws(() => act(visitor, { type: 'item-storage' }), /settlement/);
});
test('item capacity includes equipped gear; metal-only storage tiers do not change resource warehouses', () => {
  const account = settled();
  for (const terrain of (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).slice(0, 20)) findCollectible(account, terrain);
  const before = snapshot(account);
  assert.throws(() => act(account, { type: 'craft', item: 'torch' }), /full/);
  assert.deepEqual(account.game.stock, before.game.stock);
  account.game.stock.metal = 2000;
  account.game.dollars = 2000 * 10000;
  let metal = 2000;
  for (let i = 1; i < itemStorage.length; i++) {
    const result = act(account, { type: 'item-storage' });
    metal -= itemStorage[i].metal;
    assert.equal(result.game.stock.metal, metal);
    assert.equal(result.game.stock.wood, before.game.stock.wood);
    assert.equal(result.inventory.storage, i);
    assert.equal(result.capacity, before.capacity);
    assert.equal(result.warehouse, before.warehouse);
    assert.deepEqual(result.warehouseCost, before.warehouseCost);
  }
  assert.throws(() => act(account, { type: 'item-storage' }), /maximum/);
  const poor = settled();
  poor.game.stock.metal = 49;
  assert.throws(() => act(poor, { type: 'item-storage' }), /Not enough metal/);
  assert.equal(poor.game.stock.metal, 49);
  assert.equal(inventory(poor).storage, 0);
});
test('full inventories keep every unique find pending and partial collection loses nothing', () => {
  const account = settled(), terrains = Object.keys(terrainDetails) as (keyof typeof terrainDetails)[];
  inventory(account).items = ['bench', 'planter', 'canopy', 'fountain'];
  for (const terrain of terrains) { findCollectible(account, terrain); findCollectible(account, terrain); }
  const bag = inventory(account);
  assert.equal(bag.items.length, 20);
  assert.equal(bag.pending.length, terrains.length + 4 - 20);
  assert.throws(() => collectFinds(account), /full/);
  bag.items.splice(0, 2);
  const before = [...bag.items, ...bag.pending];
  act(account, { type: 'collect-items' });
  assert.equal(bag.items.length, 20);
  assert.equal(bag.pending.length, terrains.length + 2 - 20);
  assert.deepEqual([...bag.items, ...bag.pending], before);
  act(account, { type: 'item-storage' });
  act(account, { type: 'collect-items' });
  assert.equal(bag.pending.length, 0);
  assert.equal(bag.items.length, terrains.length + 2);
  assert.equal(new Set(bag.items).size, terrains.length + 2);
  assert.throws(() => act(account, { type: 'collect-items' }), /No pending/);
});
test('actual returned exploration grants one biome keepsake; overlap and zero-reveal returns cannot duplicate finds', () => {
  const account = settled(), work = snapshot(account).workforce;
  work.crews = {}; work.automatic = false; work.cycleAt = start + worldWeekMs * 10;
  const due = account.updatedAt + worldWeekMs;
  work.expeditions = [{ x: 7, y: 0, workers: 2, readyAt: due, surveyRadius: 4 },
    { x: 7, y: 0, workers: 2, readyAt: due, surveyRadius: 4 }];
  account.workforce = work;
  accrue(account, due - 1);
  assert.equal(inventory(account).items.length, 0);
  accrue(account, due);
  const id = `relic-${terrainAt(7, 0, account.game.seed)}`;
  assert.equal(inventory(account).items[0], id);
  assert.equal(inventory(account).items.length, 3);
  assert.ok(inventory(account).items[1].startsWith('collection-'));
  assert.ok(inventory(account).items[2].startsWith('activity-'));
  assert.ok(account.game.log.some(entry => entry.includes('Charted 0 new tiles')));
  const after = structuredClone(inventory(account));
  accrue(account, due + worldWeekMs);
  assert.deepEqual(inventory(account), after);
});
test('equipment changes preserve each active team survey radius and polling-independent finds', () => {
  const account = settled();
  const expedition = act(account, { type: 'move', x: 4, y: 1 }).workforce.expeditions[0];
  assert.equal(expedition.surveyRadius, 4);
  act(account, { type: 'craft', item: 'torch' });
  assert.equal(snapshot(account).workforce.expeditions[0].surveyRadius, 4);
  assert.equal(radius(account.game), visibilityItems.torch.radius);
  const offline = structuredClone(account), polled = structuredClone(account);
  accrue(offline, expedition.readyAt + 3 * worldWeekMs);
  for (let t = polled.updatedAt + 100000; t < offline.updatedAt; t += 100000) accrue(polled, t);
  accrue(polled, offline.updatedAt);
  assert.deepEqual(snapshot(polled), snapshot(offline));
});
test('legacy visibility migrates for free without revealing terrain or losing paid expeditions', () => {
  for (const light of [0, 1, 2]) {
    const account = settled();
    delete account.inventory;
    delete account.game.visibilityRadius;
    account.game.light = light;
    const stock = { ...account.game.stock }, explored = [...account.game.explored];
    const work = structuredClone(account.workforce);
    const result = snapshot(account);
    assert.deepEqual(result.inventory.items, light === 2 ? ['torch', 'lamp'] : light ? ['torch'] : []);
    assert.equal(result.inventory.equipped, light === 2 ? 'lamp' : light ? 'torch' : null);
    assert.equal(radius(result.game), 4 + light * 2);
    assert.deepEqual(result.game.stock, stock);
    assert.deepEqual(result.game.explored, explored);
    assert.deepEqual(account.workforce, work);
  }
});
test('craft, equipment, storage and find commands reject forged prices, keys, IDs and standalone light upgrades', () => {
  for (const command of [
    { type: 'craft', item: '__proto__' }, { type: 'craft', item: 'relic-forest' },
    { type: 'craft', item: 'torch', cost: 0 }, { type: 'craft' },
    { type: 'equip', item: 'constructor' }, { type: 'equip' },
    { type: 'item-storage', metal: 0 }, { type: 'collect-items', items: ['lantern'] },
    { type: 'build', kind: 'light' },
  ]) {
    const account = settled(), before = structuredClone(account);
    assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000), /Invalid/);
    assert.deepEqual(account, before);
  }
});
test('new and historical receipt retries never spend twice or duplicate inventory', () => {
  const account = settled(), body = request(account, { type: 'craft', item: 'torch' });
  const result = apply(account, body, account.updatedAt + 1000);
  const before = structuredClone(account);
  assert.deepEqual(apply(account, body, account.updatedAt + worldWeekMs), result);
  assert.deepEqual(account, before);
  delete account.receipt!.result.inventory;
  delete account.receipt!.result.game.visibilityRadius;
  account.receipt!.result.game.light = 1;
  const legacy = structuredClone(account);
  const replay = apply(account, body, account.updatedAt + worldWeekMs);
  assert.deepEqual(replay.inventory.items, ['torch']);
  assert.equal(radius(replay.game), 6);
  assert.equal(replay.serverTime, result.serverTime);
  assert.deepEqual(account, legacy);
});
test('a retired light command can replay its historical receipt but cannot execute again', () => {
  const account = settled();
  const body = { id: account.receipt!.id, revision: 0, command: { type: 'build', kind: 'light' } };
  account.receipt!.request = JSON.stringify({ revision: body.revision, command: body.command });
  account.receipt!.result.game.light = 2;
  delete account.receipt!.result.inventory;
  delete account.receipt!.result.game.visibilityRadius;
  const before = structuredClone(account);
  const result = apply(account, body, account.updatedAt + worldWeekMs);
  assert.deepEqual(result.inventory.items, ['torch', 'lamp']);
  assert.equal(result.inventory.equipped, 'lamp');
  assert.equal(radius(result.game), 8);
  assert.deepEqual(account, before);
  assert.throws(() => apply(account, { ...body, id: randomUUID(), revision: account.revision }, account.updatedAt + 1000), /Invalid/);
});
