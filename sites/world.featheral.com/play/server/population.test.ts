import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { accrue, createAccount, initializeUpkeep, snapshot } from './economy.ts';
import { worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { settlementConsumptionForDays, waterConsumptionForDays } from '../src/upkeep.ts';
import { stages } from '../src/engine.ts';
import { SqliteStore } from './store.ts';
import { translate } from '../src/i18n.ts';

function settled(population = 100) {
  const account = createAccount(worldEpoch);
  account.game.stage = 0;
  account.game.population = population;
  account.game.home = { ...account.game.position };
  account.game.stock = { wood: 1000000, water: 1000000, metal: 1000000, oil: 0 };
  account.workforce!.automatic = false;
  account.workforce!.cycleAt = worldEpoch + worldWeekMs;
  initializeUpkeep(account, worldEpoch);
  return account;
}

test('natural growth is exactly 1% rounded down, minimum one, once per supplied game week', () => {
  for (const [population, growth] of [[12, 1], [100, 1], [250, 2], [10000, 100]]) {
    const account = settled(population);
    accrue(account, worldEpoch + worldWeekMs - 1);
    assert.equal(account.game.population, population);
    accrue(account, worldEpoch + worldWeekMs);
    assert.equal(account.game.population, population + growth);
    assert.equal(snapshot(account).populationCycle!.lastChange, growth);
    assert.equal(snapshot(account).populationCycle!.readyAt, worldEpoch + 2 * worldWeekMs);
    const before = structuredClone(account);
    accrue(account, account.updatedAt);
    assert.deepEqual(account, before);
  }
});

test('each consumed resource independently prevents growth and produces proportional capped weekly decline', () => {
  for (const resource of ['water', 'wood', 'metal'] as const) {
    const account = settled(10000);
    account.game.stock[resource] = 0;
    accrue(account, worldEpoch + worldWeekMs);
    assert.equal(account.game.population, 9500);
    assert.equal(account.populationCycle!.lastChange, -500);
    assert.equal(account.game.stock[resource], 0);
  }
  const account = settled(10000);
  account.game.stock.water = Math.floor(waterConsumptionForDays(10000, worldEpoch + worldDayMs, 7) / 2);
  accrue(account, worldEpoch + worldWeekMs);
  assert.ok(account.game.population >= 9749 && account.game.population <= 9751);
  const missing = settled(10000);
  missing.game.stock = { water: 0, wood: 0, metal: 0, oil: 0 };
  accrue(missing, worldEpoch + worldWeekMs);
  assert.equal(missing.game.population, 9500, 'shortages do not stack beyond 5%');
});

test('fractional losses carry forward for small communities without rounding a weekly loss up', () => {
  const account = settled(12);
  account.game.stock.water = 0;
  accrue(account, worldEpoch + worldWeekMs);
  assert.equal(account.game.population, 12);
  accrue(account, worldEpoch + 2 * worldWeekMs);
  assert.equal(account.game.population, 11);
  account.game.stock.water = 1000000;
  accrue(account, worldEpoch + 3 * worldWeekMs);
  assert.equal(account.game.population, 12);
  assert.equal(account.populationCycle!.lossRemainder, 0);
});

test('downgrades use strict below-half thresholds, repeat tiers and retain structures, items and home', () => {
  for (let stage = 1; stage < stages.length; stage++) {
    const account = settled(Math.floor(stages[stage].population / 2));
    account.game.stage = stage;
    account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 };
    accrue(account, worldEpoch + worldWeekMs - 1);
    assert.equal(account.game.stage, stage, 'no premature downgrade');
    accrue(account, worldEpoch + worldWeekMs);
    assert.equal(account.game.stage, stage - 1);
  }
  const exact = settled(5000);
  exact.game.stage = 6;
  exact.game.stock.water = waterConsumptionForDays(5000, worldEpoch + worldDayMs, 7) - 1;
  accrue(exact, worldEpoch + worldWeekMs);
  assert.equal(exact.game.population, 5000);
  assert.equal(exact.game.stage, 6);
  const account = settled(100);
  account.game.stage = 8;
  account.game.bank = true;
  account.game.townhall = true;
  account.game.constructionLevels = { housing: 3 };
  account.inventory = { ...snapshot(account).inventory, items: ['lamp'] };
  const home = structuredClone(account.game.home), buildings = structuredClone(account.game.constructionLevels);
  accrue(account, worldEpoch + worldWeekMs);
  assert.equal(account.game.stage, 2);
  assert.deepEqual(account.game.home, home);
  assert.deepEqual(account.game.constructionLevels, buildings);
  assert.equal(account.game.bank, true);
  assert.equal(account.game.townhall, true);
  assert.deepEqual(account.inventory!.items, ['lamp']);
  account.game.population = 100000;
  accrue(account, worldEpoch + 2 * worldWeekMs);
  assert.equal(account.game.stage, 2, 're-upgrading remains manual');
});

test('online and offline population, climate bills and fractional resource carry match exactly', () => {
  const initial = settled(250), online = structuredClone(initial), offline = structuredClone(initial);
  for (let day = 1; day <= 400; day++) accrue(online, worldEpoch + day * worldDayMs);
  accrue(offline, worldEpoch + 400 * worldDayMs);
  assert.deepEqual(offline, online);
  assert.ok(offline.game.population > initial.game.population);
  let population = 250, wood = 0;
  for (let week = 0; week < 2; week++) {
    wood += settlementConsumptionForDays('wood', population, worldEpoch + week * worldWeekMs + worldDayMs, 7);
    population += Math.max(1, Math.floor(population * .01));
  }
  const twoWeeks = settled(250);
  accrue(twoWeeks, worldEpoch + 2 * worldWeekMs);
  assert.equal(twoWeeks.game.stock.wood, initial.game.stock.wood - Math.floor(wood));
});

test('old saves get a new population deadline without backdating growth or decline; unsettled worlds stay unchanged', () => {
  const account = settled();
  delete account.populationCycle;
  const now = worldEpoch + 40 * worldWeekMs;
  accrue(account, now);
  assert.equal(account.game.population, 100);
  assert.equal(account.populationCycle!.readyAt, now + worldWeekMs);
  assert.deepEqual(account.populationCycle!.required, { water: 0, wood: 0, metal: 0 });
  const visitor = createAccount(worldEpoch);
  accrue(visitor, now);
  assert.equal(visitor.populationCycle, undefined);
});

test('long abandoned settlements reach zero without negative population or unbounded offline processing', () => {
  const account = settled(10000);
  account.game.stage = 8;
  account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 };
  const start = performance.now();
  accrue(account, worldEpoch + 1000000 * worldWeekMs);
  assert.ok(performance.now() - start < 1000);
  assert.equal(account.game.population, 0);
  assert.equal(account.game.stage, 0);
  assert.ok(snapshot(account).availableWorkers >= 0);
});

test('decline and zero-population catch-up match daily processing, retaining the last actual change', () => {
  const account = settled(12), online = structuredClone(account), offline = structuredClone(account);
  online.game.stock.water = offline.game.stock.water = 0;
  for (let day = 1; day <= 2000; day++) accrue(online, worldEpoch + day * worldDayMs);
  accrue(offline, worldEpoch + 2000 * worldDayMs);
  assert.equal(offline.game.population, 0);
  assert.deepEqual(offline, online);
});

test('paid expeditions and arrivals survive population decline and newly available workers never go negative', () => {
  const account = settled(2);
  account.game.stock.water = 0;
  account.workforce!.expeditions = [{ x: 5, y: 5, workers: 2, readyAt: worldEpoch + 20 * worldWeekMs, surveyRadius: 2 }];
  account.recruitment = { population: 18, startedAt: worldEpoch, readyAt: worldEpoch + 20 * worldWeekMs };
  accrue(account, worldEpoch + 19 * worldWeekMs);
  assert.equal(account.game.population, 1);
  assert.equal(snapshot(account).availableWorkers, 0);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
  assert.equal(account.recruitment!.population, 18);
  accrue(account, worldEpoch + 20 * worldWeekMs);
  assert.equal(account.game.population, 19);
  assert.equal(snapshot(account).workforce.expeditions.length, 0);
  assert.equal(account.recruitment, null);
});

test('weekly deadlines, supply carry and census changes persist atomically and cannot be replayed', () => {
  let now = worldEpoch;
  const store = new SqliteStore(':memory:', () => now), identity = store.create();
  try {
    store.transaction(identity.token, session => { session.account = settled(100); });
    assert.equal(store.population(null).global, 100);
    now += worldWeekMs;
    store.transaction(identity.token, (session, time) => accrue(session.account, time));
    assert.equal(store.population(null).global, 101);
    const saved = store.read(identity.token, session => structuredClone(session.account));
    assert.equal(saved.populationCycle!.lastChange, 1);
    assert.equal(saved.populationCycle!.readyAt, now + worldWeekMs);
    store.transaction(identity.token, (session, time) => accrue(session.account, time));
    assert.equal(store.population(null).global, 101);
    assert.deepEqual(store.read(identity.token, session => session.account), saved);
    now += worldWeekMs;
    assert.throws(() => store.transaction(identity.token, (session, time) => {
      accrue(session.account, time);
      throw new Error('Fixture rollback');
    }), /Fixture rollback/);
    assert.equal(store.population(null).global, 101);
    assert.deepEqual(store.read(identity.token, session => session.account), saved);
    store.transaction(identity.token, (session, time) => accrue(session.account, time));
    assert.equal(store.population(null).global, 102);
  } finally { store.close(); }
});

test('population guidance and dynamic events are translated into Korean', () => {
  for (const source of ['Next population update', 'Last weekly population change',
    'Supply shortages pause advanced activity and gradually reduce population. Buildings and paid jobs remain.',
    '2 residents joined through natural weekly growth.',
    '3 residents left because consumption supplies were insufficient.',
    'Settlement downgraded to Camp. Population fell below half the required residents. Buildings and items are retained.'])
    assert.notEqual(translate(source, 'ko'), source);
});
