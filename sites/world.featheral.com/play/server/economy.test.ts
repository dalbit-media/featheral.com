import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { accrue, apply, execute, migrateEconomy, snapshot } from './economy.ts';
import { createFundedFixtureAccount as createAccount } from './test-support.ts';
import type { Account } from './economy.ts';
import type { Command } from '../src/api-types.ts';
import type { Resource } from '../src/engine.ts';
import { recruitmentAmount, recruitmentDollars, terrainAt, terrainDetails } from '../src/engine.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldDayMs, worldWeekMs } from '../src/environment.ts';
import { balancedAllocation, emptyAllocation, explorationQuote, nextExploration, resourceAccess, resourceCapacity, resourceKeys } from '../src/workforce.ts';
import { waterConsumptionForDays, waterRequirement, waterUpkeep } from '../src/upkeep.ts';
import { waterFacilityKeys } from '../src/water-facilities.ts';
import { automateFixtureCollections } from './test-support.ts';
import { gameConsumption } from '../src/consumption.ts';

const start = 1000000, minute = 60000;
const envelope = (account: Account, command: Command) => ({ id: randomUUID(), revision: account.revision, command });
function act(account: Account, command: Command, time = account.updatedAt + 1000) {
  return apply(account, envelope(account, command), time);
}
function settled(): Account {
  const account = createAccount(start);
  account.game.seed = 1542;
  account.game.dollars = 1000000 * dollarsScale;
  act(account, { type: 'upgrade' }, start);
  account.game.stock.water = 1000000000000;
  account.game.dollars = 1000000 * dollarsScale;
  automateFixtureCollections(account);
  return account;
}
function manual(allocation = { ...emptyAllocation(), wood: 3 }): Account {
  const account = settled(), work = snapshot(account).workforce;
  account.game.stock.wood = 0;
  if (allocation.water) account.game.stock.water = 0;
  work.crews = {}; work.automatic = false; work.allocation = allocation;
  account.workforce = work;
  act(account, { type: 'home' });
  return account;
}
test('Water demand is 50 litres daily and 350 weekly; shortages never remove residents', () => {
  for (const population of [0, 1, 12, 100, 1000000]) assert.equal(waterRequirement(population), population * 35);
  assert.deepEqual(waterUpkeep(20, 300), { required: 100, consumed: 100, shortage: 0, populationLoss: 0 });
  assert.deepEqual(waterUpkeep(20, 64), { required: 100, consumed: 64, shortage: 36, populationLoss: 0 });
  assert.equal(waterUpkeep(21, 0).populationLoss, 0);
  assert.equal(waterUpkeep(12, 179).populationLoss, 0);
  assert.equal(waterUpkeep(0, 100).consumed, 0);
});
test('starter Water and unboosted automatic collection sustain all 12 residents with weekly claims', () => {
  for (const seed of [0, 1, 42, 1542, 999999]) {
    const account = createAccount(start);
    account.game.seed = seed;
    account.game.dollars = 1000000 * dollarsScale;
    act(account, { type: 'upgrade' }, start);
    assert.equal(account.game.stock.water, 2520);
    assert.ok(snapshot(account).resourceAccess.water.perWorker >= 300);
    for (let week = 1; week <= 26; week++) {
      const due = snapshot(account).workforce.cycleAt;
      accrue(account, due);
      const state = snapshot(account);
      assert.equal(state.game.population, 12, `seed ${seed}, week ${week}`);
      assert.equal(state.waterUpkeep!.lastPopulationLoss, 0);
      if (resourceKeys.some(resource => state.pending[resource] >= Math.ceil(resourceCapacity(state.capacity, resource) / 2))) {
        act(account, { type: 'claim' }, due);
      }
    }
    assert.equal(account.game.waterFacilities, undefined);
    assert.equal(account.warehouse, 0);
  }
});
test('a Water permit automates paid delivery; individual pickup has no half-storage threshold', () => {
  const account = manual({ ...emptyAllocation(), water: 10 });
  const state = snapshot(account), due = state.workforce.cycleAt;
  assert.equal(resourceCapacity(state.capacity, 'water'), 3000);
  assert.equal(resourceCapacity(state.capacity, 'wood'), 100);
  assert.equal(resourceCapacity(600, 'water'), 3500);
  assert.equal(resourceCapacity(0, 'water'), 0);
  accrue(account, due - 1);
  assert.equal(snapshot(account).pending.water, 0);
  accrue(account, due);
  assert.equal(snapshot(account).pending.water, 0);
  assert.equal(account.game.stock.water, 3000);
  account.pending.water = 1499 * minute;
  act(account, { type: 'claim', resource: 'water' });
  account.pending.water = 1500 * minute;
  const owned = account.game.stock.water;
  act(account, { type: 'claim', resource: 'water' });
  assert.equal(account.game.stock.water, owned + 1500);
  assert.equal(snapshot(account).pending.water, 0);
});
test('Water consumption has an independent exact daily deadline that commands cannot reset', () => {
  const account = manual(emptyAllocation());
  account.game.stock.water = 5000;
  const due = snapshot(account).waterUpkeep!.readyAt;
  const first = waterUpkeep(12, 0, due).required, second = waterUpkeep(12, 0, due + worldDayMs).required;
  accrue(account, due - 1);
  assert.equal(account.game.stock.water, 5000);
  act(account, { type: 'home' }, due - 1);
  assert.equal(snapshot(account).waterUpkeep!.readyAt, due);
  accrue(account, due);
  assert.equal(account.game.stock.water, 5000 - first);
  assert.equal(account.game.population, 12);
  assert.equal(snapshot(account).waterUpkeep!.readyAt, due + worldDayMs);
  accrue(account, due);
  assert.equal(account.game.stock.water, 5000 - first);
  accrue(account, due + worldDayMs);
  assert.equal(account.game.stock.water, 5000 - first - second);
});
test('legacy pending Water cannot pay upkeep and shortages preserve residents and workers', () => {
  const account = manual(emptyAllocation());
  account.game.stock.water = 15 * 2;
  account.pending.water = 100 * minute;
  const due = snapshot(account).waterUpkeep!.readyAt;
  accrue(account, due);
  assert.equal(account.game.stock.water, 0);
  assert.equal(account.game.population, 12);
  assert.equal(snapshot(account).pending.water, 100);
  assert.equal(snapshot(account).availableWorkers, 12);
  assert.equal(snapshot(account).waterUpkeep!.lastPopulationLoss, 0);
  assert.equal(snapshot(account).waterUpkeep!.paused, true);
});
test('weekly arrivals are charged only after joining and shortages require supply recovery before recruiting', () => {
  const account = manual(emptyAllocation());
  account.game.stock.water = 1260;
  const due = snapshot(account).waterUpkeep!.readyAt;
  account.recruitment = { population: 18, startedAt: due - worldWeekMs, readyAt: due };
  account.inviteReadyAt = due;
  accrue(account, due);
  assert.equal(account.game.population, 30);
  assert.equal(account.game.stock.water, 1260 - waterUpkeep(12, 0, due).required);
  assert.equal(snapshot(account).waterUpkeep!.lastPopulationLoss, 0);
  accrue(account, due + worldWeekMs * 50);
  assert.equal(account.game.population, 30);
  assert.equal(snapshot(account).availableWorkers, 30);
  assert.deepEqual(snapshot(account).workforce.crews, {});
  act(account, { type: 'assign', resource: 'water', workers: 0 });
  assert.throws(() => act(account, { type: 'invite' }), /Restore Water/);
  account.game.stock.water = 1000000;
  act(account, { type: 'invite' });
  const arrival = account.recruitment!.readyAt, arriving = account.recruitment!.population;
  accrue(account, arrival);
  assert.equal(account.game.population, 30 + arriving);
  assert.equal(account.recruitment, null);
});
test('shortages preserve paid crews and expeditions without granting early discoveries', () => {
  const account = manual({ ...emptyAllocation(), water: 1 });
  account.game.population = 3; account.game.stock.water = 0;
  const due = snapshot(account).waterUpkeep!.readyAt, known = [...account.game.explored];
  const work = snapshot(account).workforce;
  work.expeditions = [{ x: 5, y: 5, workers: 2, readyAt: due + worldWeekMs * 2, surveyRadius: 4 }];
  work.crews.water!.readyAt = due + worldWeekMs;
  account.workforce = work;
  accrue(account, due);
  assert.equal(account.game.population, 3);
  assert.equal(snapshot(account).workforce.crews.water?.workers, 1);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
  assert.equal(snapshot(account).availableWorkers, 0);
  accrue(account, due + worldDayMs);
  assert.equal(account.game.population, 3);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
  assert.deepEqual(account.game.explored, known);
  assert.equal(snapshot(account).pending.water, 0);
});
test('offline upkeep matches incremental settlement, gradually loses undersupplied residents and bulk-skips idle days', () => {
  const original = manual(emptyAllocation());
  original.game.stock.water = 1260 * 3 + 100;
  const one = structuredClone(original), stepped = structuredClone(original);
  const due = snapshot(original).waterUpkeep!.readyAt;
  const target = due + 1000000 * worldDayMs;
  const started = performance.now();
  accrue(one, target);
  assert.ok(performance.now() - started < 1000);
  for (let day = 0; day < 100; day++) accrue(stepped, due + day * worldDayMs);
  accrue(stepped, target);
  assert.deepEqual(snapshot(one), snapshot(stepped));
  assert.equal(one.game.population, 0);
  const funded = manual(emptyAllocation()), before = funded.game.stock.water;
  const fundedDue = snapshot(funded).waterUpkeep!.readyAt;
  accrue(funded, fundedDue + 1000000 * worldDayMs);
  assert.equal(funded.game.population, 0);
  assert.ok(funded.game.stock.water >= 0 && funded.game.stock.water < before, 'consumption stops after population reaches zero');
});
test('legacy saves receive a fresh full upkeep day without retroactive consumption', () => {
  const account = manual(emptyAllocation());
  delete account.waterUpkeep;
  delete account.populationCycle;
  account.game.stock.water = 180;
  const now = account.updatedAt + 10000 * worldWeekMs;
  accrue(account, now);
  assert.equal(account.game.stock.water, 180);
  assert.equal(account.game.population, 12);
  assert.equal(snapshot(account).waterUpkeep!.readyAt, now + worldDayMs);
  const restored = JSON.parse(JSON.stringify(account)) as Account;
  const bill = waterUpkeep(12, 0, now + worldDayMs).required;
  accrue(restored, now + worldDayMs);
  assert.equal(restored.game.stock.water, 180 - bill);
  assert.equal(restored.game.population, 12);
  accrue(restored, now + worldDayMs * 2);
  assert.equal(restored.game.population, 12);
});
test('action receipt retries preserve the original response without resetting or repeating Water upkeep', () => {
  const account = manual(emptyAllocation());
  account.game.stock.water = 0;
  const request = envelope(account, { type: 'home' });
  const original = apply(account, request, account.updatedAt + 1000);
  const due = original.waterUpkeep!.readyAt;
  accrue(account, due);
  const settled = structuredClone(account);
  assert.equal(account.game.population, 12);
  assert.deepEqual(apply(account, request, due + worldWeekMs), original);
  assert.deepEqual(account, settled);
});
test('weekly action receipts gain daily metadata without replaying payments or changing the saved account', () => {
  const account = manual(emptyAllocation());
  account.game.stock.water = 180;
  const request = envelope(account, { type: 'home' });
  const original = apply(account, request, account.updatedAt + 1000);
  const due = account.waterUpkeep!.readyAt;
  const upkeep = account.receipt!.result.waterUpkeep!;
  delete upkeep.dailyConsumption;
  upkeep.readyAt = account.updatedAt + worldWeekMs;
  upkeep.shortage = 1080; upkeep.populationLoss = 1; upkeep.lastPopulationLoss = 3;
  const before = structuredClone(account);
  const retry = apply(account, request, due + worldDayMs);
  assert.deepEqual(account, before);
  assert.deepEqual(retry.game, original.game);
  assert.equal(retry.waterUpkeep!.dailyConsumption, waterUpkeep(12, 0, due).required);
  assert.equal(retry.waterUpkeep!.weeklyConsumption, original.waterUpkeep!.weeklyConsumption);
  assert.equal(retry.waterUpkeep!.shortage, 0);
  assert.equal(retry.waterUpkeep!.populationLoss, 0);
  assert.equal(retry.waterUpkeep!.lastPopulationLoss, 0);
  assert.equal(retry.waterUpkeep!.readyAt, due);
});
test('automatic Water priority spends available FTH$ before other crews without using Metal', () => {
  const { game, access } = surplusFixture({ water: { yield: 100, transport: 2 }, metal: { yield: 100 }, wood: { yield: 200 } });
  game.stock.water = 0; game.stock.metal = 10; game.stock.wood = 0;
  game.dollars = 10 * dollarsScale;
  const plan = balancedAllocation(game, emptyAllocation(), 2000, 1, access);
  assert.equal(plan.crews.water, 6);
  assert.equal(plan.dollars, 0);
  assert.ok(Object.values(plan.crews).reduce((sum, workers) => sum + workers, 0) <= 10);
  assert.equal(game.stock.metal, 10);
});
test('Water facilities preserve paid deliveries and apply their multiplier only to a new full work week', () => {
  const account = manual({ ...emptyAllocation(), water: 2 });
  account.game.stock.wood = 120;
  const before = snapshot(account), stock = { ...account.game.stock };
  const request = envelope(account, { type: 'build', kind: 'well' });
  const built = apply(account, request, account.updatedAt + 1000);
  assert.deepEqual(built.workforce.crews, before.workforce.crews);
  assert.deepEqual(built.pending, before.pending);
  assert.equal(built.game.stock.water, stock.water);
  assert.equal(built.game.stock.wood, stock.wood - 60);
  assert.equal(built.game.stock.metal, stock.metal - 20);
  assert.equal(built.resourceAccess.water.perWorker, before.resourceAccess.water.perWorker * 2);
  assert.equal(built.rates.water, before.rates.water);
  assert.deepEqual(apply(account, request, account.updatedAt + 1000), built);
  const paid = structuredClone(account);
  assert.throws(() => act(account, { type: 'build', kind: 'well' }), /already constructed/);
  assert.deepEqual(account.game, paid.game);
  assert.deepEqual(account.workforce, paid.workforce);
  const due = before.workforce.crews.water!.readyAt;
  accrue(account, due - 1);
  assert.equal(snapshot(account).pending.water, 0);
  accrue(account, due);
  const next = snapshot(account);
  assert.equal(next.pending.water, 0);
  assert.equal(next.game.stock.water, before.rates.water);
  assert.equal(next.rates.water, Math.min(2 * next.resourceAccess.water.perWorker,
    resourceCapacity(next.capacity, 'water', next.game) - next.game.stock.water + next.resourceAccess.water.weeklyConsumption!));
  assert.equal(next.workforce.crews.water!.readyAt, due + worldWeekMs);
  assert.equal(next.workforce.crews.water!.weeklyMetalCost, before.workforce.crews.water!.weeklyMetalCost);
});
test('Water facility output stacks without changing other yields, transport, availability or storage', () => {
  const account = settled(), before = resourceAccess(account.game);
  for (const key of waterFacilityKeys) account.game.waterFacilities = { ...account.game.waterFacilities, [key]: true };
  const after = resourceAccess(account.game);
  assert.equal(after.water.perWorker, before.water.perWorker * 8);
  assert.equal(after.water.dollarsPerWorker, before.water.dollarsPerWorker);
  for (const resource of resourceKeys.filter(key => key !== 'water')) assert.deepEqual(after[resource], before[resource]);
  assert.equal(snapshot(account).capacity, 100);
  account.game.explored = ['0,0'];
  assert.equal(resourceAccess(account.game).water.available, false);
});
test('boosted automatic Water gathering sustains weekly population consumption when storage and claims are sufficient', () => {
  const account = manual(emptyAllocation());
  account.warehouse = 10;
  account.game.stock = { wood: 1000000, metal: 1000000, water: 2520, oil: 0, lithium: 0 };
  for (const key of waterFacilityKeys) act(account, { type: 'build', kind: key });
  act(account, { type: 'automatic', enabled: true });
  for (let week = 0; week < 12; week++) {
    const due = snapshot(account).workforce.cycleAt;
    accrue(account, due);
    assert.equal(account.game.population, 13 + week, `natural population growth in week ${week + 1}`);
    assert.equal(snapshot(account).waterUpkeep!.lastPopulationLoss, 0);
    if (snapshot(account).pending.water >= Math.ceil(resourceCapacity(snapshot(account).capacity, 'water') / 2)) act(account, { type: 'claim', resource: 'water' }, due);
    assert.ok(account.game.stock.water >= waterRequirement(12), `next bill funded in week ${week + 1}`);
  }
  assert.ok((snapshot(account).workforce.crews.water?.workers ?? 0) <= Math.floor(account.game.population / 2));
  assert.ok(Object.values(snapshot(account).workforce.crews).reduce((sum, crew) => sum + crew.workers, 0) <= Math.floor(account.game.population / 2));
});
test('one work week is exactly seven world days and 168 server minutes', () => {
  assert.equal(worldWeekMs, worldDayMs * 7);
  assert.equal(worldWeekMs, 168 * minute);
});
test('visitors do not produce; founding defaults to balanced resource allocation with two explorers', () => {
  const visitor = createAccount(start);
  accrue(visitor, start + worldWeekMs * 100000);
  assert.deepEqual(snapshot(visitor).pending, emptyAllocation());
  const account = settled(), state = snapshot(account);
  assert.equal(state.workforce.automatic, true);
  assert.ok(Object.values(state.workforce.crews).length);
  assert.ok(state.availableWorkers >= 2);
  assert.equal(state.workforce.crews.wood, undefined);
  assert.ok(state.workforce.crews.water);
  assert.ok(!JSON.stringify(state.workforce.crews).includes('"x"'));
});
test('weekly production credits owned inventory only at exact full-week boundaries', () => {
  const account = manual(), state = snapshot(account), stock = { ...account.game.stock };
  const crew = state.workforce.crews.wood!, due = crew.readyAt;
  assert.equal(due - state.serverTime, worldWeekMs);
  accrue(account, due - 1);
  assert.equal(snapshot(account).pending.wood, 0);
  assert.throws(() => act(account, { type: 'claim' }, due - 1), /50%/);
  accrue(account, due);
  assert.equal(snapshot(account).pending.wood, 0);
  stock.wood += Math.min(100, crew.weeklyYield);
  stock.water -= waterConsumptionForDays(account.game.population, state.waterUpkeep!.readyAt, 7);
  assert.deepEqual(account.game.stock, stock);
  assert.throws(() => act(account, { type: 'claim', resource: 'wood' }, due), /No completed/);
  assert.equal(account.game.stock.wood, stock.wood);
  assert.equal(snapshot(account).workforce.crews.wood, undefined);
  const next = snapshot(account).workforce.cycleAt;
  accrue(account, next - 1);
  assert.equal(snapshot(account).pending.wood, 0);
});
test('manual changes queue without cancelling paid work, double assigning or giving recruits early rewards', () => {
  const account = manual(), before = snapshot(account);
  account.warehouse = 1;
  account.game.stock.water = 2520;
  act(account, { type: 'assign', resource: 'wood', workers: 1 });
  act(account, { type: 'assign', resource: 'water', workers: 2 });
  assert.deepEqual(snapshot(account).workforce.crews, before.workforce.crews);
  assert.throws(() => act(account, { type: 'assign', resource: 'metal', workers: 8 }), /two residents/);
  act(account, { type: 'invite' }, before.workforce.cycleAt - 1000);
  const due = before.workforce.cycleAt;
  accrue(account, due);
  const after = snapshot(account);
  assert.equal(after.pending.wood, 0);
  assert.equal(after.game.stock.wood, Math.min(100, before.rates.wood));
  assert.equal(after.pending.water, 0);
  assert.equal(after.workforce.crews.water!.readyAt, due + worldWeekMs);
  assert.equal(after.workforce.crews.wood!.workers, 1);
  assert.ok(after.availableWorkers >= 2);
});
test('allocation uses all explored resources without a selected tile and requires bank access for rare resources', () => {
  const account = manual();
  assert.throws(() => act(createAccount(start), { type: 'assign', resource: 'wood', workers: 1 }), /settlement/);
  assert.throws(() => act(account, { type: 'assign', resource: 'oil', workers: 1 }), /matching resource/);
  let deposit = '';
  for (let x = -50; x <= 50 && !deposit; x++) for (let y = -50; y <= 50 && !deposit; y++) {
    if (terrainAt(x, y, account.game.seed) === 'oil') deposit = `${x},${y}`;
  }
  assert.ok(deposit);
  account.game.explored.push(deposit);
  assert.equal(resourceAccess(account.game).oil.available, false);
  account.game.bank = true; account.game.stage = 6;
  act(account, { type: 'assign', resource: 'oil', workers: 1 });
  assert.equal(resourceAccess(account.game).oil.available, true);
  assert.equal(snapshot(account).workforce.allocation.oil, 1);
});
test('distance logistics charge all workers on pickup and claimed Metal is not transport currency', () => {
  const account = manual();
  account.warehouse = 1;
  account.game.explored = ['-3,0', '3,0', '0,3'];
  account.game.home = { x: 20, y: 0 };
  account.game.stock.metal = 30;
  account.game.dollars = 30 * dollarsScale;
  account.incomeReadyAt = account.updatedAt + worldWeekMs * 100;
  const work = snapshot(account).workforce;
  work.crews = {}; work.allocation = { ...emptyAllocation(), wood: 2 };
  account.workforce = work;
  const access = resourceAccess(account.game).wood;
  assert.equal(access.distance, 23);
  assert.equal(access.dollarsPerWorker, 6);
  act(account, { type: 'home' });
  const firstYield = snapshot(account).workforce.crews.wood!.weeklyYield;
  assert.equal(account.game.dollars, 30 * dollarsScale);
  assert.equal(account.game.stock.metal, 30);
  const due = snapshot(account).workforce.cycleAt;
  accrue(account, due);
  assert.equal(account.game.dollars, 18 * dollarsScale);
  assert.equal(account.game.stock.wood, firstYield);
  const secondYield = snapshot(account).workforce.crews.wood!.weeklyYield;
  assert.equal(snapshot(account).pending.wood, 0);
  account.game.dollars = 0;
  account.pending.metal = 100 * minute;
  accrue(account, due + worldWeekMs);
  assert.equal(account.game.stock.wood, firstYield);
  assert.equal(account.game.dollars, 0);
  assert.equal(snapshot(account).pending.wood, secondYield);
  assert.throws(() => act(account, { type: 'claim', resource: 'wood' }), /FTH/);
  act(account, { type: 'claim', resource: 'metal' });
  assert.equal(account.game.stock.metal, 130);
  assert.equal(account.game.dollars, 0);
  account.game.dollars = 18 * dollarsScale;
  act(account, { type: 'claim', resource: 'wood' });
  assert.equal(account.game.stock.wood, firstYield + secondYield);
  assert.equal(account.game.dollars, 6 * dollarsScale);
  account.game.stock.wood = 0;
  account.workforce!.crews = {};
  account.workforce!.cycleAt = account.updatedAt;
  act(account, { type: 'home' });
  assert.equal(snapshot(account).rates.wood, Math.min(600, 2 * snapshot(account).resourceAccess.wood.perWorker));
  assert.equal(account.game.dollars, 6 * dollarsScale);
});
test('automatic balance defers transport payment, respects storage and never consumes Metal', () => {
  const account = settled();
  account.game.home = { x: 20, y: 0 };
  account.game.stock.metal = 40;
  account.game.dollars = 5 * dollarsScale;
  const work = snapshot(account).workforce; work.crews = {}; account.workforce = work;
  act(account, { type: 'home' });
  assert.equal(account.game.stock.metal, 40);
  assert.ok(Object.values(snapshot(account).workforce.crews).every(crew => crew.payOnPickup));
  assert.equal(account.game.dollars, 5 * dollarsScale);
  const pending = { wood: 100, water: 3000, metal: 100, oil: 100, lithium: 100 };
  assert.deepEqual(balancedAllocation(account.game, pending, 100, 0, resourceAccess(account.game)).crews, emptyAllocation());
});
test('automatic production keeps a grandfathered over-cap owned balance spendable without claims', () => {
  const account = settled();
  account.game.stock.wood = 179;
  account.game.stock.metal = 1000;
  const work = snapshot(account).workforce; work.crews = {}; account.workforce = work;
  act(account, { type: 'home' });
  accrue(account, account.updatedAt + worldWeekMs * 20);
  assert.equal(snapshot(account).pending.wood, 0);
  assert.equal(account.game.stock.wood, 179);
});
function surplusFixture(sites: Partial<Record<Resource, { yield: number; transport?: number }>>) {
  const game = settled().game, access = resourceAccess(game);
  game.stock = { wood: 400, water: 3500, metal: 400, oil: 400 };
  for (const resource of resourceKeys) {
    const site = sites[resource];
    access[resource] = { available: !!site, distance: 0, efficiency: 1, perWorker: site?.yield ?? 0, dollarsPerWorker: site ? site.transport ?? 1 : 0,
      ...(resource === 'water' ? { weeklyConsumption: 0 } : {}) };
  }
  return { game, access };
}
test('automatic allocation targets half the total population, counts explorers and rounds down', () => {
  const { game, access } = surplusFixture({ wood: { yield: 30 }, water: { yield: 20 } });
  for (const [population, exploring, expected] of [[12, 0, 6], [11, 0, 5], [3, 0, 1], [2, 0, 0], [1, 0, 0], [12, 2, 4], [12, 4, 2], [12, 6, 0], [12, 8, 0]]) {
    game.population = population;
    const plan = balancedAllocation(game, emptyAllocation(), 600, 1, access, exploring);
    assert.deepEqual(plan.crews, { ...emptyAllocation(), wood: expected });
    assert.equal(plan.dollars, game.dollars - Math.max(0, expected - 1) * dollarsScale);
  }
});
test('weekly Water replacement is funded before surplus even when higher-value Metal extras use the reserve', () => {
  const { game, access } = surplusFixture({ water: { yield: 100, transport: 2 }, metal: { yield: 150, transport: 20 } });
  access.water.weeklyConsumption = 420;
  game.stock.water = 600; game.stock.metal = 100;
  game.dollars = 100 * dollarsScale;
  const pending = { ...emptyAllocation(), water: 100, metal: 500 };
  const plan = balancedAllocation(game, pending, 1000, 1, access);
  assert.equal(plan.crews.water, 5);
  assert.equal(plan.crews.metal, 1);
  assert.equal(plan.unfundedWorkers, 0);
  assert.equal(plan.dollars, 72 * dollarsScale);
});
test('priority demand and pickup-funded crews remain within the 50% utilization budget', () => {
  const { game, access } = surplusFixture({ water: { yield: 20 }, wood: { yield: 30 }, metal: { yield: 10 } });
  for (const population of [3, 11, 12, 30]) for (const exploring of [0, 2, 4, 6, 8]) {
    if (exploring > population) continue;
    game.population = population;
    access.water.weeklyConsumption = population * 35;
    game.stock = { ...emptyAllocation(), water: population * 15 };
    game.dollars = 0;
    const plan = balancedAllocation(game, emptyAllocation(), 600, 1, access, exploring, 0, true);
    const budget = Math.max(0, Math.min(Math.floor(population / 2) - exploring, population - Math.max(2, exploring)));
    assert.equal(resourceKeys.reduce((sum, resource) => sum + plan.crews[resource], 0), budget);
    assert.equal(resourceKeys.reduce((sum, resource) => sum + plan.allocation[resource], 0), budget);
    assert.equal(plan.crews.water, budget);
    assert.equal(plan.dollars, 0);
  }
});
test('surplus chooses net resource value rather than raw quantity and accounts for final partial deliveries', () => {
  const { game, access } = surplusFixture({ wood: { yield: 30 }, water: { yield: 20 }, oil: { yield: 6 } });
  game.bank = true;
  let plan = balancedAllocation(game, emptyAllocation(), 600, 1, access);
  assert.deepEqual(plan.crews, { ...emptyAllocation(), oil: 6 });
  access.oil.available = false;
  game.stock.wood = 599; game.stock.water = 3480;
  const nearFull = emptyAllocation();
  plan = balancedAllocation(game, nearFull, 600, 1, access);
  assert.deepEqual(plan.crews, { ...emptyAllocation(), wood: 1, water: 1 });
  access.wood.dollarsPerWorker = 5;
  plan = balancedAllocation(game, nearFull, 600, 1, access);
  assert.deepEqual(plan.crews, { ...emptyAllocation(), wood: 1, water: 1 });
});
test('surplus respects FTH$ affordability and cash reserves without spending pending resources', () => {
  const { game, access } = surplusFixture({ wood: { yield: 30, transport: 20 }, water: { yield: 20, transport: 2 } });
  game.stock.water = 3380;
  game.stock.metal = 0;
  game.dollars = 6 * dollarsScale;
  const plan = balancedAllocation(game, { ...emptyAllocation(), metal: 600 }, 600, 1, access);
  assert.deepEqual(plan.crews, { ...emptyAllocation(), wood: 1, water: 4 });
  assert.equal(plan.dollars, 0);
  game.stock.metal = 30;
  game.dollars = 36 * dollarsScale;
  const reserved = balancedAllocation(game, emptyAllocation(), 600, 1, access, 0, 30);
  assert.deepEqual(reserved.crews, { ...emptyAllocation(), wood: 1, water: 4 });
  assert.equal(reserved.dollars, 30 * dollarsScale);
});
test('surplus does not double-assign unfunded priority targets or report active workers as waiting', () => {
  const { game, access } = surplusFixture({ wood: { yield: 30, transport: 20 }, water: { yield: 20 } });
  game.stock.water = 3480;
  game.stock.wood = 0; game.stock.metal = 0;
  game.dollars = 6 * dollarsScale;
  const plan = balancedAllocation(game, emptyAllocation(), 600, 1, access);
  assert.equal(plan.crews.wood, 1);
  assert.equal(plan.crews.water, 1);
  assert.equal(plan.unfundedWorkers, plan.allocation.wood - plan.crews.wood);
  assert.ok(plan.unfundedWorkers > 0);
});
test('surplus planning is bounded by finite storage rather than a large idle population', () => {
  const { game, access } = surplusFixture({ wood: { yield: 1 }, water: { yield: 1 }, metal: { yield: 1 }, oil: { yield: 1 }, lithium: { yield: 1 } });
  game.population = 1000000; game.bank = true;
  for (const resource of resourceKeys) game.stock[resource] = 1000000000;
  const began = performance.now();
  const plan = balancedAllocation(game, emptyAllocation(), 600, 1, access);
  assert.ok(performance.now() - began < 1000);
  for (const resource of resourceKeys) assert.equal(plan.crews[resource], 0);
});
test('Metal crews require FTH$ too and full or net-negative routes receive no extras', () => {
  const { game, access } = surplusFixture({ metal: { yield: 10, transport: 2 } });
  game.stock.metal = 10;
  game.dollars = 10 * dollarsScale;
  const pending = { ...emptyAllocation(), metal: 300 };
  let plan = balancedAllocation(game, pending, 600, 1, access);
  assert.deepEqual(plan.crews, { ...emptyAllocation(), metal: 5 });
  assert.equal(plan.dollars, 0);
  access.metal.dollarsPerWorker = 20;
  plan = balancedAllocation(game, pending, 600, 1, access);
  assert.deepEqual(plan.crews, emptyAllocation());
  plan = balancedAllocation(game, { ...emptyAllocation(), metal: 600 }, 600, 1, access);
  assert.deepEqual(plan.crews, emptyAllocation());
});
test('surplus crews take a full week and output stops at storage limits', () => {
  const account = manual(emptyAllocation()), work = snapshot(account).workforce;
  account.warehouse = 1;
  account.game.stock = { wood: 500, water: 1000000000000, metal: 1000, oil: 1000 };
  work.crews = {}; work.automatic = true; account.workforce = work;
  act(account, { type: 'home' });
  const state = snapshot(account);
  assert.ok(Object.values(state.workforce.crews).reduce((sum, crew) => sum + crew.workers, 0) <= 6);
  assert.equal(state.workforce.crews.wood?.workers, Math.ceil(100 / state.resourceAccess.wood.perWorker));
  assert.equal(state.availableWorkers, 12 - state.workforce.crews.wood!.workers);
  const due = state.workforce.cycleAt;
  accrue(account, due - 1);
  assert.deepEqual(snapshot(account).pending, emptyAllocation());
  accrue(account, due);
  assert.equal(snapshot(account).pending.wood, 0);
  assert.equal(account.game.stock.wood, 600);
  accrue(account, due + worldWeekMs * 100000);
  const full = snapshot(account);
  assert.deepEqual(full.pending, emptyAllocation());
  assert.equal(full.game.stock.wood, resourceCapacity(full.capacity, 'wood', full.game));
  assert.equal(full.availableWorkers, 12);
  assert.deepEqual(full.workforce.crews, {});
});
test('pending fractions survive claims; full storage pauses transport rather than charging for overflow', () => {
  const account = manual({ ...emptyAllocation(), wood: 1, water: 1 });
  const due = snapshot(account).workforce.cycleAt;
  account.pending.wood = 50 * minute + 123;
  act(account, { type: 'claim', resource: 'wood' });
  const before = snapshot(account);
  assert.equal(account.pending.wood, 123);
  assert.equal(snapshot(account).pending.water, before.pending.water);
  accrue(account, due + worldWeekMs * 100000);
  assert.equal(account.pending.wood, 123);
  assert.equal(account.game.stock.wood, 99);
  assert.equal(snapshot(account).rates.wood, 0);
});
test('offline advancement is bounded and polling, duplicate or backward time cannot change the result', () => {
  const account = settled();
  const frequent = structuredClone(account), once = structuredClone(account);
  for (let i = 1; i <= 1000; i++) accrue(frequent, account.updatedAt + Math.floor(worldWeekMs * 20 * i / 1000));
  accrue(once, account.updatedAt + worldWeekMs * 20);
  assert.deepEqual(frequent, once);
  const before = structuredClone(once);
  accrue(once, start); accrue(once, once.updatedAt);
  assert.deepEqual(once, before);
  const began = performance.now();
  accrue(once, account.updatedAt + worldWeekMs * 1000000);
  assert.ok(performance.now() - began < 1000);
  assert.ok(once.game.stock.metal >= 0);
});
test('paid remote work and expedition return are also polling-invariant', () => {
  const account = manual({ ...emptyAllocation(), wood: 1 });
  account.game.home = { x: 20, y: 0 };
  account.game.stock.metal = 500;
  act(account, { type: 'move', x: 5, y: 0 });
  const frequent = structuredClone(account), once = structuredClone(account);
  for (let i = 1; i <= 1000; i++) accrue(frequent, account.updatedAt + Math.floor(worldWeekMs * 50 * i / 1000));
  accrue(once, account.updatedAt + worldWeekMs * 50);
  assert.deepEqual(frequent, once);
  assert.equal(once.game.stock.metal, account.game.stock.metal);
  assert.ok(once.game.stock.metal >= 0);
});
test('automatic mode changes preserve current work and rebalance only at the weekly boundary', () => {
  const account = manual({ ...emptyAllocation(), water: 1 });
  const before = snapshot(account);
  act(account, { type: 'automatic', enabled: true });
  assert.deepEqual(snapshot(account).workforce.crews, before.workforce.crews);
  accrue(account, before.workforce.cycleAt);
  const after = snapshot(account);
  assert.equal(after.pending.water, 0);
  assert.equal(after.game.stock.water, before.rates.water);
  assert.equal(after.workforce.automatic, true);
  assert.ok(after.workforce.crews.water);
  assert.notDeepEqual(after.workforce.crews, before.workforce.crews);
  assert.ok(Object.values(after.workforce.crews).reduce((sum, crew) => sum + crew.workers, 0) <= Math.floor(after.game.population / 2));
  assert.ok(after.availableWorkers >= 2);
});
test('resource routing is independent of exploration order and player travel', () => {
  const account = settled(), game = account.game;
  const before = resourceAccess(game);
  game.explored.reverse(); game.position = { x: 100, y: 100 };
  assert.deepEqual(resourceAccess(game), before);
});
test('exploration pays an upfront settlement-distance quote, reserves two residents and reveals only on return', () => {
  const account = settled(), known = [...account.game.explored], dollars = account.game.dollars;
  const quote = explorationQuote(account.game, 5, 0);
  const result = act(account, { type: 'move', x: 5, y: 0 });
  const mission = result.workforce.expeditions[0];
  assert.equal(account.game.dollars, dollars - quote.dollars * dollarsScale);
  assert.equal(mission.readyAt - result.serverTime, quote.weeks * worldWeekMs);
  assert.ok(mission.readyAt - result.serverTime >= worldWeekMs);
  assert.ok(result.availableWorkers >= 0);
  assert.deepEqual(account.game.explored, known);
  assert.throws(() => act(account, { type: 'move', x: 5, y: 0 }), /already exploring this destination/);
  act(account, { type: 'move', x: 1, y: 0 });
  assert.equal(account.game.dollars, dollars - quote.dollars * dollarsScale);
  accrue(account, mission.readyAt - 1);
  assert.deepEqual(account.game.explored, known);
  accrue(account, mission.readyAt);
  assert.deepEqual(snapshot(account).workforce.expeditions, []);
  assert.ok(account.game.explored.includes('5,0'));
  assert.deepEqual(account.game.position, { x: 1, y: 0 });
  const contribution = account.game.contribution;
  accrue(account, mission.readyAt + worldWeekMs);
  assert.equal(account.game.contribution, contribution);
});
test('exploration distance cannot be bypassed by free travel and insufficient FTH$ starts no mission', () => {
  const account = settled();
  const quote = explorationQuote(account.game, 8, 0);
  account.game.position = { x: 4, y: 0 };
  assert.deepEqual(explorationQuote(account.game, 8, 0), quote);
  assert.ok(quote.dollars > explorationQuote(account.game, 5, 0).dollars);
  account.game.dollars = 0;
  assert.throws(() => act(account, { type: 'move', x: 8, y: 0 }), /Not enough FTH\$/);
  assert.deepEqual(snapshot(account).workforce.expeditions, []);
  assert.throws(() => act(account, { type: 'move', x: 100, y: 100 }), /beyond/);
});
test('legacy migration preserves old completed batches, fractions, unfinished deadlines and never backcharges metal', () => {
  const account = settled(), metal = account.game.stock.metal;
  account.pending.wood = 123;
  account.workforce = { crews: { wood: { workers: 2, x: -3, y: 0, weeklyYield: 60,
    readyAt: start + worldWeekMs, lockedUntil: start + worldWeekMs } }, expedition: null };
  const migration = start + worldWeekMs * 2.5;
  migrateEconomy(account, migration);
  const work = snapshot(account).workforce;
  assert.equal(account.pending.wood, 100 * minute);
  assert.equal(account.game.stock.metal, metal);
  assert.equal(work.crews.wood!.readyAt, start + worldWeekMs * 3);
  assert.equal(work.crews.wood!.weeklyMetalCost, 0);
  assert.equal(work.automatic, true);
  const before = structuredClone(account);
  migrateEconomy(account, migration + worldWeekMs);
  assert.deepEqual(account, before);
});
test('concurrent expeditions are limited only by available residents and their individual FTH$ costs', () => {
  const account = manual(emptyAllocation());
  account.game.dollars = 1000 * dollarsScale;
  const targets = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 2], [-4, 2]];
  let spent = 0, sent = 0;
  for (const [x, y] of targets) {
    spent += explorationQuote(account.game, x, y, sent).dollars;
    act(account, { type: 'move', x, y });
    sent++;
    const state = snapshot(account);
    assert.equal(state.workforce.expeditions.length, sent);
    assert.equal(state.dollars, 1000 - spent);
    assert.equal(state.availableWorkers, 12 - state.workforce.expeditions.length * 2);
  }
  assert.throws(() => act(account, { type: 'move', x: 4, y: -2 }), /two available residents/);
  assert.equal(snapshot(account).workforce.expeditions.length, 6);
  assert.equal(account.game.dollars, (1000 - spent) * dollarsScale);
});
test('quick exploration skips active destinations and failed duplicate or unaffordable launches spend nothing', () => {
  const account = manual(emptyAllocation());
  const target = nextExploration(account.game)!;
  act(account, { type: 'move', x: target.x, y: target.y });
  const before = snapshot(account);
  const next = nextExploration(account.game, before.workforce.expeditions)!;
  assert.notDeepEqual([next.x, next.y], [target.x, target.y]);
  assert.throws(() => act(account, { type: 'move', x: target.x, y: target.y }), /already exploring this destination/);
  assert.equal(account.game.stock.metal, before.game.stock.metal);
  account.game.dollars = (next.dollars - 1) * dollarsScale;
  assert.throws(() => act(account, { type: 'move', x: next.x, y: next.y }), /Not enough FTH\$/);
  assert.equal(account.game.dollars, (next.dollars - 1) * dollarsScale);
  assert.deepEqual(snapshot(account).workforce.expeditions, before.workforce.expeditions);
});
test('editing automatic allocation switches to manual and reserves residents already exploring', () => {
  const account = manual({ ...emptyAllocation(), water: 1 });
  account.game.stock.water = waterRequirement(account.game.population);
  for (let i = 0; i < 4; i++) {
    const next = nextExploration(account.game, snapshot(account).workforce.expeditions)!;
    act(account, { type: 'move', x: next.x, y: next.y });
  }
  act(account, { type: 'automatic', enabled: true });
  const before = snapshot(account);
  assert.throws(() => act(account, { type: 'assign', resource: 'wood', workers: 4 }), /retain active explorers/);
  assert.equal(snapshot(account).workforce.automatic, true);
  const edited = act(account, { type: 'assign', resource: 'wood', workers: 3 });
  assert.equal(edited.workforce.automatic, false);
  assert.equal(edited.workforce.allocation.wood, 3);
  assert.deepEqual(edited.workforce.expeditions, before.workforce.expeditions);
  assert.deepEqual(edited.workforce.crews, before.workforce.crews);
});
test('teams return independently in deadline order and automatic allocation never borrows active explorers', () => {
  const account = manual({ ...emptyAllocation(), wood: 2 });
  account.game.population = 6; account.game.stock.metal = 10000;
  const launch = (weeks: number, away?: { x: number; y: number }) => {
    for (let x = -70; x <= 70; x++) for (let y = -70; y <= 70; y++) {
      if (account.game.explored.includes(`${x},${y}`) || (away && Math.hypot(x - away.x, y - away.y) < 15)
        || terrainDetails[terrainAt(x, y, account.game.seed)].weeks !== weeks) continue;
      account.game.position = { x: x - 1, y };
      return act(account, { type: 'move', x, y }).workforce.expeditions.find(expedition => expedition.x === x && expedition.y === y)!;
    }
    throw new Error('Expected expedition terrain fixture.');
  };
  const long = launch(3), short = launch(1, long);
  assert.equal(snapshot(account).workforce.expeditions[0].readyAt, short.readyAt);
  const known = [...account.game.explored], cycleAt = snapshot(account).workforce.cycleAt;
  account.game.stock.wood = 0;
  act(account, { type: 'automatic', enabled: true });
  accrue(account, cycleAt);
  const working = snapshot(account);
  assert.ok(Object.values(working.workforce.crews).reduce((sum, crew) => sum + crew.workers, 0) <= 2);
  assert.ok(working.availableWorkers >= 0);
  accrue(account, short.readyAt - 1);
  assert.deepEqual(account.game.explored, known);
  accrue(account, short.readyAt);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
  assert.equal(snapshot(account).workforce.expeditions[0].readyAt, long.readyAt);
  assert.ok(account.game.explored.includes(`${short.x},${short.y}`));
  assert.ok(!account.game.explored.includes(`${long.x},${long.y}`));
  const remaining = snapshot(account).workforce.expeditions, next = nextExploration(account.game, remaining)!;
  assert.equal(next.dollars, explorationQuote(account.game, next.x, next.y).dollars * 2);
  accrue(account, long.readyAt);
  assert.deepEqual(snapshot(account).workforce.expeditions, []);
  assert.ok(account.game.explored.includes(`${long.x},${long.y}`));
  assert.ok(snapshot(account).availableWorkers >= 0);
});
test('overlapping expeditions, weekly production and offline catch-up are polling-invariant without duplicate contribution', () => {
  const account = manual({ ...emptyAllocation(), wood: 1 });
  account.game.stock.metal = 1000;
  act(account, { type: 'move', x: 5, y: 0 });
  act(account, { type: 'move', x: 4, y: 2 });
  act(account, { type: 'automatic', enabled: true });
  const frequent = structuredClone(account), once = structuredClone(account);
  const before = account.game.explored.length, contribution = account.game.contribution;
  for (let i = 1; i <= 200; i++) accrue(frequent, account.updatedAt + Math.floor(worldWeekMs * 20 * i / 200));
  accrue(once, account.updatedAt + worldWeekMs * 20);
  assert.deepEqual(frequent, once);
  assert.equal(new Set(once.game.explored).size, once.game.explored.length);
  assert.equal(once.game.contribution - contribution, once.game.explored.length - before);
  const stock = { ...once.game.stock }, earned = once.game.contribution;
  const firstWaterDay = once.waterUpkeep!.readyAt;
  accrue(once, once.updatedAt + worldWeekMs * 1000000);
  stock.water -= waterConsumptionForDays(12, firstWaterDay, 7 * 1000000);
  assert.deepEqual(once.game.stock, stock);
  assert.equal(once.game.contribution, earned);
});
test('single-team save and idempotent receipt migration preserve paid work, deadlines and original results', () => {
  const account = manual(), request = envelope(account, { type: 'move', x: 5, y: 0 });
  const original = structuredClone(apply(account, request, account.updatedAt + 1000));
  const { expeditions, ...saved } = original.workforce;
  const old = { ...saved, version: 2 as const, expedition: expeditions[0] };
  account.workforce = structuredClone(old);
  account.receipt!.result.workforce = structuredClone(old);
  const metal = account.game.stock.metal, pending = { ...account.pending };
  migrateEconomy(account, account.updatedAt + worldWeekMs * 100);
  assert.deepEqual(snapshot(account).workforce, original.workforce);
  assert.equal(account.game.stock.metal, metal);
  assert.deepEqual(account.pending, pending);
  assert.deepEqual(apply(account, request, account.updatedAt + worldWeekMs * 100), original);
});
test('recruitment pays FTH$ upfront but adds residents only at the exact one-week deadline', () => {
  const account = settled(), before = { ...account.game.stock }, dollars = account.game.dollars;
  const result = act(account, { type: 'invite' });
  const cost = recruitmentDollars(12, 0, result.serverTime), arrivals = result.recruitment!.population;
  assert.equal(account.game.stock.metal, before.metal);
  assert.equal(account.game.dollars, dollars - cost * dollarsScale);
  assert.equal(account.game.stock.wood, before.wood);
  assert.equal(account.game.stock.water, before.water);
  assert.equal(account.game.population, 12);
  assert.equal(result.recruitmentDollars, cost);
  assert.deepEqual(result.recruitment, { population: arrivals, startedAt: result.serverTime, readyAt: result.serverTime + worldWeekMs });
  assert.equal(arrivals, recruitmentAmount(12, 0, result.serverTime));
  assert.equal(result.inviteReadyAt - result.serverTime, worldWeekMs);
  accrue(account, result.inviteReadyAt - 1);
  assert.throws(() => act(account, { type: 'invite' }, result.inviteReadyAt - 1), /Recruitment ready/);
  assert.equal(account.game.population, 13);
  accrue(account, result.inviteReadyAt);
  assert.equal(account.game.population, 13 + arrivals);
  assert.equal(snapshot(account).recruitment, null);
  assert.equal(snapshot(account).inviteReadyAt, 0);
  accrue(account, result.inviteReadyAt + worldWeekMs * 100);
  assert.ok(account.game.population > 13 + arrivals, 'natural growth continues without repeating the paid batch');
  const population = account.game.population;
  assert.equal(snapshot(account).recruitmentDollars, recruitmentDollars(account.game.population, 0, account.updatedAt));
  const second = act(account, { type: 'invite' });
  const secondArrivals = second.recruitment!.population;
  assert.equal(account.game.population, population);
  accrue(account, second.inviteReadyAt);
  assert.equal(account.game.population, population + Math.max(1, Math.floor(population * .01)) + secondArrivals);
});
test('recruitment survives idle-cycle fast-forward, completes once offline, and never grants early workforce or production', () => {
  const account = manual(emptyAllocation());
  const request = envelope(account, { type: 'invite' });
  const result = apply(account, request, account.updatedAt + 1000);
  const before = snapshot(account);
  const online = structuredClone(account), offline = structuredClone(account);
  assert.equal(before.availableWorkers, 12);
  assert.deepEqual(apply(account, request, result.inviteReadyAt + worldWeekMs), result);
  assert.equal(account.game.population, 12);
  accrue(online, result.inviteReadyAt - 1);
  assert.equal(snapshot(online).availableWorkers, 12);
  assert.deepEqual(snapshot(online).pending, emptyAllocation());
  accrue(online, result.inviteReadyAt);
  assert.equal(snapshot(online).availableWorkers, 12 + result.recruitment!.population);
  assert.deepEqual(snapshot(online).pending, emptyAllocation());
  accrue(online, result.inviteReadyAt + worldWeekMs * 100000);
  accrue(offline, result.inviteReadyAt + worldWeekMs * 100000);
  assert.deepEqual(snapshot(offline), snapshot(online));
  assert.equal(offline.game.population, 12 + result.recruitment!.population);
  assert.equal(offline.recruitment, null);
  assert.equal(offline.game.log.filter(message => message.includes('new residents joined')).length, 1);
});
test('recruitment size is locked at dispatch', () => {
  const account = manual({ ...emptyAllocation(), wood: 30 });
  account.game.population = 10000;
  account.game.stock.metal = 10000;
  const result = act(account, { type: 'invite' });
  assert.equal(result.recruitment?.population, recruitmentAmount(10000, 0, result.serverTime));
  const due = result.inviteReadyAt;
  account.game.population = 10001;
  accrue(account, due - 1);
  assert.equal(account.game.population, 10001);
  const pending = snapshot(account).pending.wood;
  accrue(account, due);
  assert.equal(account.game.population, 10001 + result.recruitment!.population);
  assert.equal(snapshot(account).pending.wood, pending);
});
test('already-paid larger recruitment batches retain their exact arrivals after the growth rebalance', () => {
  const account = manual(emptyAllocation());
  account.game.stock.wood = 1000000;
  account.game.stock.metal = 1000000;
  const startedAt = account.updatedAt, readyAt = startedAt + worldWeekMs;
  account.recruitment = { population: 18, startedAt, readyAt };
  account.inviteReadyAt = readyAt;
  const dollars = account.game.dollars;
  const withoutRecruitment = structuredClone(account);
  withoutRecruitment.recruitment = null;
  assert.ok(recruitmentAmount(12) < account.recruitment.population);
  assert.equal(snapshot(account).recruitment?.population, 18);
  accrue(account, readyAt);
  accrue(withoutRecruitment, readyAt);
  assert.equal(account.game.population, withoutRecruitment.game.population + 18);
  assert.equal(account.recruitment, null);
  assert.equal(account.game.dollars, dollars);
  accrue(account, readyAt + 1);
  assert.equal(account.game.population, withoutRecruitment.game.population + 18, 'paid batch arrives exactly once');
});
test('capped recruitment preview confirmation and dispatch charge only the final arrival count', () => {
  const account = manual(emptyAllocation());
  account.game.population = 1000;
  account.game.constructionLevels = { housing: 99 };
  account.game.stock.wood = 1000000;
  account.game.stock.metal = 1000000;
  const before = snapshot(account);
  const quote = gameConsumption({ ...before, csrf: 'test', population: { global: 1000, federation: null }, clockSpeed: 1 }, { type: 'invite' })!;
  assert.equal(quote.arrivals, 200);
  assert.equal(before.recruitmentDollars, 200 * 50);
  assert.equal(quote.costs.find(cost => cost.asset === 'dollars')?.amount, 200 * 50);
  const dollars = account.game.dollars;
  const result = act(account, { type: 'invite' });
  assert.equal(result.recruitment?.population, 200);
  assert.equal(account.game.dollars, dollars - 200 * 50 * dollarsScale);
});
test('new residents cannot join an active delivery or earn retroactive partial-week production', () => {
  const account = manual({ ...emptyAllocation(), wood: 28 });
  account.warehouse = 10;
  const result = act(account, { type: 'invite' });
  const workDue = snapshot(account).workforce.cycleAt;
  const firstYield = snapshot(account).workforce.crews.wood!.weeklyYield;
  assert.ok(workDue < result.inviteReadyAt);
  accrue(account, workDue);
  const delivery = snapshot(account);
  assert.equal(delivery.workforce.crews.wood?.workers, 10);
  const weeklyYield = delivery.workforce.crews.wood!.weeklyYield;
  assert.equal(delivery.game.stock.wood, firstYield);
  accrue(account, result.inviteReadyAt);
  assert.equal(account.game.population, 12 + result.recruitment!.population);
  assert.equal(account.game.stock.wood, firstYield);
  assert.equal(snapshot(account).workforce.crews.wood?.workers, 10);
  accrue(account, workDue + worldWeekMs);
  assert.equal(account.game.stock.wood, firstYield + weeklyYield);
  const nextCrew = snapshot(account).workforce.crews.wood!;
  assert.equal(nextCrew.workers, Math.min(28, account.game.population - 2));
  accrue(account, nextCrew.readyAt - 1);
  assert.equal(account.game.stock.wood, firstYield + weeklyYield);
  accrue(account, nextCrew.readyAt);
  assert.equal(account.game.stock.wood, firstYield + weeklyYield + nextCrew.weeklyYield);
});
test('legacy instant recruitment retains joined residents without fabricating a pending batch', () => {
  const account = settled();
  delete account.recruitment;
  account.game.population = 30;
  account.inviteReadyAt = account.updatedAt + 600000;
  assert.equal(snapshot(account).recruitment, null);
  accrue(account, account.updatedAt + worldWeekMs * 10);
  assert.equal(account.game.population, 40, 'ten natural arrivals are independent of paid recruitment');
  assert.equal(snapshot(account).recruitment, null);
  const result = act(account, { type: 'invite' });
  assert.equal(account.game.population, 40);
  assert.equal(result.inviteReadyAt - result.serverTime, worldWeekMs);
});
test('recruitment rejects an overflowing future population before charging metal', () => {
  const account = manual(emptyAllocation());
  account.game.population = Number.MAX_SAFE_INTEGER;
  account.game.stock.metal = Number.MAX_SAFE_INTEGER;
  assert.throws(() => act(account, { type: 'invite' }), /Account limit reached/);
  assert.equal(account.game.stock.metal, Number.MAX_SAFE_INTEGER);
  assert.equal(account.recruitment, null);
});
test('idempotency preserves exact paid results and rejects stale revisions and changed requests', () => {
  const account = settled(), request = envelope(account, { type: 'move', x: 5, y: 0 });
  const result = apply(account, request, start + 1000);
  assert.deepEqual(apply(account, request, start + worldWeekMs * 10), result);
  assert.throws(() => apply(account, { ...request, command: { type: 'invite' } }, start + 2000), /different request/);
  assert.throws(() => apply(account, { ...request, id: randomUUID() }, start + 2000), /World changed/);
});
test('real-time claim and action limits remain independent of accelerated game time', () => {
  const account = manual(), due = snapshot(account).workforce.cycleAt;
  assert.throws(() => apply(account, envelope(account, { type: 'invite' }), due, account.lastActionAt + 249), /four per second/);
  account.pending.wood = 50 * minute;
  apply(account, envelope(account, { type: 'claim' }), due, start + 10000);
  account.pending.water = 100 * minute;
  accrue(account, due + worldWeekMs);
  assert.throws(() => apply(account, envelope(account, { type: 'claim' }), due + worldWeekMs, start + 10499), /half a second/);
});
test('reject forged costs, tile assignments, timestamps, invalid quantities and instant gathering', () => {
  const account = settled();
  for (const command of [
    { type: 'claim', now: 999999999 }, { type: 'claim', amount: 100000 }, { type: 'claim', resource: '__proto__' },
    { type: 'gather', quantity: 35 }, { type: 'reward' }, { type: 'invite', metal: 0 },
    ...[-1, 0.5, 1000001, NaN].map(workers => ({ type: 'assign', resource: 'wood', workers })),
    { type: 'assign', resource: '__proto__', workers: 1 },
    { type: 'assign', resource: 'wood', workers: 1, x: 0, y: 0 },
    { type: 'assign', resource: 'wood', workers: 1, readyAt: 0 },
    { type: 'automatic', enabled: 1 }, { type: 'automatic', enabled: true, cost: 0 },
    { type: 'move', x: 5, y: 0, metal: 0 }, { type: 'move', x: 0.5, y: 0 },
  ]) assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command }, start + 1000), /Invalid command/);
  assert.throws(() => apply(account, envelope(account, { type: 'gather' }), start + 1000), /resident crews/);
  assert.equal(terrainDetails[terrainAt(5, 0, account.game.seed)].weeks >= 1, true);
});
test('level 99 warehouse and construction upgrades stop exactly at the cap', () => {
  const account = createAccount(start);
  account.game.stage = 8;
  account.game.home = { ...account.game.position };
  account.game.stock = { wood: 10000000, water: 10000000, metal: 10000000, oil: 0 };
  account.game.dollars = 10000000 * 10000;
  account.warehouse = 98;
  execute(account, { type: 'warehouse' });
  assert.equal(account.warehouse, 99);
  assert.equal(snapshot(account).warehouseCost, null);
  assert.throws(() => execute(account, { type: 'warehouse' }, account.updatedAt + 2000), /maximum level/);
  for (const kind of ['housing', 'cistern', 'workshop', 'logistics'] as const) {
    account.game.constructionLevels = { ...account.game.constructionLevels, [kind]: 98 };
    execute(account, { type: 'construction', kind });
    assert.equal(account.game.constructionLevels[kind], 99);
    const saved = structuredClone(account);
    assert.throws(() => execute(account, { type: 'construction', kind }, account.updatedAt + 2000), /maximum level/);
    assert.deepEqual(account, saved);
  }
});
