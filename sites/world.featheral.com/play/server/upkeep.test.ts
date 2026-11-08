import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { accrue, apply, createAccount, initializeUpkeep, snapshot } from './economy.ts';
import { climateCycleDays, seasonMs, worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { environmentAt } from '../src/environment.ts';
import { heatingDemandClimate, maintenanceDemandClimate } from '../src/climate.ts';
import { settlementConsumptionForDays, settlementUpkeep, suppliedWorkWeeks } from '../src/upkeep.ts';
import { formatResourceAmount } from '../src/resource-units.ts';
import { createFundedFixtureAccount, automateFixtureCollections } from './test-support.ts';
import { dollarsScale } from '../src/dollars.ts';

function settled(population = 12) {
  const account = createAccount(worldEpoch);
  account.game.stage = 0;
  account.game.population = population;
  account.game.home = { ...account.game.position };
  account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 7 };
  account.workforce!.automatic = false;
  account.workforce!.cycleAt = worldEpoch + worldWeekMs;
  initializeUpkeep(account, worldEpoch);
  return account;
}

test('heating and repairs respond to population, season, temperature and weather with useful small-unit display', () => {
  const mild = { ...environmentAt(worldEpoch), season: 'Spring' as const, temperature: 10, weather: 'Clear skies' as const };
  const cold = { ...mild, season: 'Winter' as const, temperature: -15, weather: 'Snow' as const };
  for (const effect of [heatingDemandClimate, maintenanceDemandClimate]) {
    assert.ok(effect(cold) > effect(mild));
    assert.ok(effect({ ...mild, weather: 'Storm' }) > effect(mild));
    assert.ok(effect({ ...mild, season: 'Winter' }) > effect(mild));
    assert.ok(effect({ ...mild, temperature: -15 }) > effect(mild));
  }
  for (const resource of ['wood', 'metal'] as const) {
    const first = settlementUpkeep(resource, 12, 100, worldEpoch).required;
    assert.ok(first > 0);
    assert.ok(settlementUpkeep(resource, 24, 100, worldEpoch).required > first);
    assert.equal(settlementUpkeep(resource, 0, 100, worldEpoch).required, 0);
    assert.ok(settlementUpkeep(resource, 12, 100, worldEpoch + 3 * seasonMs).required > first);
  }
  assert.equal(formatResourceAmount('metal', .02, 'en-US'), '0.2 kg');
});

test('bounded prefix sums match daily bills across season/cycle boundaries and long offline intervals', () => {
  for (const resource of ['wood', 'metal'] as const) {
    const first = worldEpoch - worldDayMs * 3, days = climateCycleDays + 17;
    let units = 0;
    for (let day = 0; day < days; day++)
      units += Math.round(settlementUpkeep(resource, 12, 10000, first + day * worldDayMs).required * 10000);
    assert.equal(settlementConsumptionForDays(resource, 12, first, days), units / 10000);
    assert.equal(settlementConsumptionForDays(resource, 12, first + climateCycleDays * worldDayMs, days), units / 10000);
    assert.equal(settlementConsumptionForDays(resource, 12, first, 0), 0);
    assert.throws(() => settlementConsumptionForDays(resource, -1, first, days), RangeError);
    assert.throws(() => settlementConsumptionForDays(resource, 12, first, .5), RangeError);
  }
  const account = settled(100), online = structuredClone(account), offline = structuredClone(account);
  const billed = { wood: 0, metal: 0 };
  for (let day = 1; day <= 400; day++) {
    for (const resource of ['wood', 'metal'] as const)
      billed[resource] += Math.round(settlementConsumptionForDays(resource, online.game.population, worldEpoch + day * worldDayMs, 1) * 10000);
    accrue(online, worldEpoch + day * worldDayMs);
  }
  accrue(offline, worldEpoch + 400 * worldDayMs);
  assert.deepEqual(offline, online);
  for (const resource of ['wood', 'metal'] as const) {
    const required = billed[resource] / 10000;
    assert.equal(offline.game.stock[resource], account.game.stock[resource] - Math.floor(required));
    assert.ok(Number.isSafeInteger(offline.game.stock[resource]));
  }
  assert.equal(offline.game.stock.oil, 7);
  const before = structuredClone(offline);
  accrue(offline, offline.updatedAt);
  assert.deepEqual(offline, before, 'repeated reads never bill the same day twice');
  const started = performance.now();
  accrue(offline, worldEpoch + 1000000 * worldWeekMs);
  assert.ok(performance.now() - started < 1000);
});

test('new upkeep does not back-bill old saves and preserves unclaimed production', () => {
  const account = settled();
  delete account.settlementUpkeep;
  account.pending.wood = 42 * 60000;
  account.pending.metal = 17 * 60000;
  const before = { wood: account.game.stock.wood, metal: account.game.stock.metal };
  const now = worldEpoch + 100 * worldDayMs;
  accrue(account, now);
  assert.equal(account.settlementUpkeep!.readyAt, now + worldDayMs);
  assert.equal(account.game.stock.wood, before.wood);
  assert.equal(account.game.stock.metal, before.metal);
  assert.equal(account.pending.wood, 42 * 60000);
  assert.equal(account.pending.metal, 17 * 60000);
  assert.ok(snapshot(account).settlementUpkeep);
  const visitor = createAccount(worldEpoch);
  accrue(visitor, now);
  assert.equal(visitor.settlementUpkeep, undefined);
});

test('shortages pause new advanced activities while keeping residents, buildings, travel and recovery', () => {
  for (const resource of ['wood', 'metal'] as const) {
    const account = settled();
    account.game.stock[resource] = 0;
    account.game.dollars = 100000000;
    const before = structuredClone(account.game);
    const request = (command: unknown, time: number) => apply(account, { id: randomUUID(), revision: account.revision, command }, time);
    assert.throws(() => request({ type: 'invite' }, worldEpoch + 1000), /heating supplies|repair supplies/);
    assert.equal(snapshot(account).settlementUpkeep!.paused, true);
    request({ type: 'home' }, worldEpoch + 2000);
    accrue(account, worldEpoch + worldWeekMs);
    assert.equal(account.game.population, before.population);
    assert.deepEqual(account.game.home, before.home);
    assert.equal(account.game.stock[resource], 0);
    account.game.stock[resource] = 100;
    assert.equal(snapshot(account).settlementUpkeep!.paused, false);
    request({ type: 'invite' }, worldEpoch + worldWeekMs + 2000);
    assert.ok(account.recruitment);
  }
});

test('upkeep leaves integer accounting lots compatible with pickup and idempotent actions', () => {
  const account = settled();
  accrue(account, worldEpoch + 2 * worldDayMs);
  account.pending.wood = 10 * 60000;
  const request = { id: randomUUID(), revision: account.revision, command: { type: 'claim', resource: 'wood' } };
  const first = apply(account, request, account.updatedAt + 1000);
  const before = structuredClone(account);
  assert.deepEqual(apply(account, request, account.updatedAt + 2000), first);
  assert.deepEqual(account, before);
  assert.ok(Number.isSafeInteger(first.game.stock.wood));
  assert.ok(first.settlementUpkeep);
});

test('bulk charged-week counts equal weekly fractional carry across multiple climate cycles', () => {
  for (const resource of ['wood', 'metal'] as const) for (const remainder of [0, 17, 9999]) {
    let carry = remainder, charged = 0;
    for (let week = 0; week < 2000; week++) {
      const units = Math.round(settlementConsumptionForDays(resource, 12, worldEpoch + week * worldWeekMs, 7) * 10000) + carry;
      if (Math.floor(units / 10000)) charged++;
      carry = units % 10000;
    }
    assert.equal(suppliedWorkWeeks(resource, 12, worldEpoch, 2000, remainder), charged);
  }
});

test('maintained-stock fast forward preserves exact stock, fees and crews at expiry, exhaustion and climate boundaries', () => {
  for (const cash of [20, 1000000]) for (const duration of [12, 1700]) {
    const account = createFundedFixtureAccount(worldEpoch + seasonMs - worldDayMs);
    account.game.seed = 1542;
    account.game.dollars = 1000000 * dollarsScale;
    apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'upgrade' } }, account.updatedAt);
    account.game.stock.water = 1000000000000;
    account.game.dollars = cash * dollarsScale;
    automateFixtureCollections(account);
    account.automationUntil!.wood = account.automationUntil!.metal = account.updatedAt + duration * worldWeekMs;
    const online = structuredClone(account), offline = structuredClone(account);
    const finish = account.updatedAt + 2000 * worldWeekMs + 3 * worldDayMs;
    for (let week = 1; week <= 2000; week++) accrue(online, account.updatedAt + week * worldWeekMs);
    accrue(online, finish);
    accrue(offline, finish);
    assert.deepEqual(offline, online, `${cash} FTH$, ${duration} weeks`);
  }
});

test('daily upkeep precedes coincident arrivals and bills the new population only afterward', () => {
  const account = settled();
  const due = account.settlementUpkeep!.readyAt;
  account.recruitment = { population: 18, startedAt: due - worldWeekMs, readyAt: due };
  const before = structuredClone(account);
  accrue(account, due);
  assert.equal(account.game.population, 30);
  for (const resource of ['wood', 'metal'] as const) {
    const first = Math.round(settlementConsumptionForDays(resource, 12, due, 1) * 10000);
    assert.equal(account.settlementUpkeep!.remainder[resource], first % 10000);
  }
  accrue(account, due + worldDayMs);
  for (const resource of ['wood', 'metal'] as const) {
    const first = Math.round(settlementConsumptionForDays(resource, 12, due, 1) * 10000);
    const second = Math.round(settlementConsumptionForDays(resource, 30, due + worldDayMs, 1) * 10000);
    assert.equal(account.game.stock[resource], before.game.stock[resource] - Math.floor((first + second) / 10000));
  }
});
