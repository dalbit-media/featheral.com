import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply, accrue, createAccount, migrateEconomy, snapshot } from './economy.ts';
import { build, buildingCosts, discover, newGame, stages, upgrade } from '../src/engine.ts';
import { dollarsScale } from '../src/dollars.ts';
import { emptyAllocation, fundAllocation, resourceAccess, resourceKeys } from '../src/workforce.ts';
import { worldWeekMs } from '../src/environment.ts';
import { waterFacilities } from '../src/water-facilities.ts';

test('basic Wood and Water crews are free; advanced transport uses FTH$ and never Metal', () => {
  const game = newGame(); game.seed = 1542; discover(game); upgrade(game);
  game.stage = 6; game.bank = true;
  const access = resourceAccess(game), allocation = { wood: 1, water: 1, metal: 1, oil: 1 };
  for (const resource of resourceKeys) {
    assert.equal(access[resource].available, true, resource);
    assert.equal(access[resource].dollarsPerWorker, 1 + Math.max(0, Math.ceil((access[resource].distance - 4) / 4)), resource);
  }
  const cost = access.metal.dollarsPerWorker + access.oil.dollarsPerWorker;
  game.dollars = cost * dollarsScale;
  const metal = game.stock.metal;
  const paid = fundAllocation(game, emptyAllocation(), 10000, allocation, access, 0, 0);
  assert.deepEqual(paid.crews, allocation); assert.equal(paid.dollars, 0);
  assert.equal(game.stock.metal, metal); assert.equal(game.dollars, cost * dollarsScale);
  game.dollars = 0;
  const blocked = fundAllocation(game, { ...emptyAllocation(), metal: 5000 }, 10000, allocation, access, 0, 0);
  assert.deepEqual(blocked.crews, { ...emptyAllocation(), wood: 1, water: 1 }); assert.equal(blocked.unfundedWorkers, 2);
});

test('settlement, warehouse and item storage upgrades require their exact FTH$ fee in addition to materials', () => {
  const account = createAccount(1000000), game = account.game;
  game.stage = 0; game.home = { x: 0, y: 0 }; game.population = 100000; game.stock = { wood: 1000000, water: 1000000, metal: 1000000, oil: 1000000 };
  const work = snapshot(account).workforce; work.automatic = false; work.allocation = emptyAllocation(); account.workforce = work;
  const run = (command: { type: 'upgrade' | 'warehouse' | 'item-storage' }) => apply(account,
    { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000);
  for (const command of [{ type: 'upgrade' }, { type: 'warehouse' }, { type: 'item-storage' }] as const) {
    const before = structuredClone(account);
    assert.throws(() => run(command), /Not enough FTH\$/);
    assert.deepEqual(account.game, before.game);
  }
  game.dollars = 100000 * dollarsScale;
  for (let stage = 1; stage < stages.length; stage++) {
    assert.equal(stages[stage].cost.dollars, stage === 8 ? 800 : (stage + 1) * 100);
    const before = game.dollars; run({ type: 'upgrade' });
    assert.equal(before - game.dollars, stages[stage].cost.dollars! * dollarsScale);
  }
  for (let level = 1; level <= 10; level++) {
    const before = game.dollars; run({ type: 'warehouse' });
    assert.equal(before - game.dollars, level * 50 * dollarsScale);
  }
  for (let level = 1; level <= 4; level++) {
    const before = game.dollars; run({ type: 'item-storage' });
    assert.equal(before - game.dollars, level * 100 * dollarsScale);
  }
  assert.equal(buildingCosts.bank.dollars, 3200);
  assert.equal(buildingCosts.townhall.dollars, 1500);
  assert.equal(waterFacilities.well.cost.dollars, 280);
  game.dollars = 0;
  assert.throws(() => build(game, 'bank'), /Not enough FTH\$/);
  assert.throws(() => build(game, 'well'), /Not enough FTH\$/);
});

test('cash-blocked collection stays paused offline without minting income and matches frequent polling', () => {
  const account = createAccount(1000000);
  const game = account.game; game.stage = 0; game.population = 12; game.home = { x: 0, y: 0 };
  game.explored = ['-3,0']; game.stock.water = 100000; game.dollars = 0;
  const work = snapshot(account).workforce;
  work.automatic = false; work.allocation = { ...emptyAllocation(), wood: 2 }; work.cycleAt = account.updatedAt;
  account.workforce = work;
  const frequent = structuredClone(account), offline = structuredClone(account);
  for (let step = 1; step <= 100; step++) accrue(frequent, 1000000 + Math.floor(worldWeekMs * 3 * step / 100));
  accrue(offline, 1000000 + worldWeekMs * 3);
  assert.deepEqual(offline, frequent);
  assert.equal(snapshot(offline).pending.wood, 0);
  assert.equal(offline.game.dollars, 0);
});

test('pricing migration invalidates stale action revisions once without recharging or resetting paid crews', () => {
  const account = createAccount(1000000), work = snapshot(account).workforce;
  delete work.transportVersion;
  work.crews.wood = { workers: 2, readyAt: 1000000 + worldWeekMs, weeklyYield: 60, weeklyMetalCost: 10 };
  account.workforce = work;
  const before = structuredClone(account);
  migrateEconomy(account, 1000000);
  assert.equal(account.revision, before.revision + 1);
  assert.deepEqual(account.workforce.crews, before.workforce!.crews);
  assert.deepEqual(account.game, before.game);
  migrateEconomy(account, 1000000);
  assert.equal(account.revision, before.revision + 1);
});

test('older versioned workforce migrates pricing and expedition layout together exactly once', () => {
  const account = createAccount(1000000);
  account.workforce = { version: 2, automatic: true, allocation: { wood: 2, water: 0, metal: 0, oil: 0 },
    cycleAt: 1000000 + worldWeekMs, unfundedWorkers: 0, expedition: null,
    crews: { wood: { workers: 2, readyAt: 1000000 + worldWeekMs, weeklyYield: 60, weeklyMetalCost: 10 } } };
  const before = structuredClone(account);
  migrateEconomy(account, 1000000);
  assert.equal(account.revision, before.revision + 1);
  assert.equal(account.workforce.transportVersion, 1);
  assert.deepEqual(account.workforce.crews, before.workforce!.crews);
  assert.deepEqual(account.game, before.game);
  migrateEconomy(account, 1000000);
  assert.equal(account.revision, before.revision + 1);
});

test('pricing changes reject stale new requests but retain completed receipts without paying twice', () => {
  const account = createAccount(1000000);
  discover(account.game); upgrade(account.game);
  const request = { id: randomUUID(), revision: account.revision, command: { type: 'move', x: 0, y: 0 } };
  const result = structuredClone(apply(account, request, 1001000));
  const before = structuredClone(account.game);
  delete account.workforce!.transportVersion;
  for (const resource of resourceKeys) Reflect.deleteProperty(account.receipt!.result.resourceAccess[resource], 'dollarsPerWorker');
  Reflect.deleteProperty(account.receipt!.result.warehouseCost!, 'dollars');
  migrateEconomy(account, 1001000);
  assert.throws(() => apply(account, { ...request, id: randomUUID() }, 1002000), /World changed/);
  assert.deepEqual(apply(account, request, 1002000), result);
  assert.deepEqual(account.game, before);
});
