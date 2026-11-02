import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite from '../../../../services/db-api/sqlite.js';
import { test } from 'node:test';
import { accrue, apply, createAccount, snapshot } from './economy.ts';
import { SqliteStore } from './store.ts';
import type { Command } from '../src/api-types.ts';
import { environmentAt, seasonMs, worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { legacySpaceCells, settlementPositions } from '../src/settlement-layout.ts';
import { terrainDetails } from '../src/engine.ts';
import { waterConsumptionForDays, waterRequirement, waterUpkeep } from '../src/upkeep.ts';
import { isMarketResource, marketAssets, marketBasePrice } from '../src/market.ts';
import { waterFacilityKeys, waterProductionMultiplier } from '../src/water-facilities.ts';
import { automateFixtureCollections, fundFixtureFromReserves, seedFixturePools } from './test-support.ts';

function populationAndMaterialTotals(store: SqliteStore) {
  const { settlements, metal, population } = store.publicTotals();
  return { settlements, metal, population };
}

test('Water facility construction persists, charges once on retries and preserves the upkeep deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-facilities-')), path = join(directory, 'test.sqlite');
  let time = 1000000, store = new SqliteStore(path, () => time);
  try {
    const identity = store.create();
    const due = store.transaction(identity.token, (session, now) => {
      apply(session.account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, now);
      session.account.game.stock.wood = 1000;
      session.account.game.dollars = 2000 * 10000;
      session.account.game.stock.metal = 1000;
      return snapshot(session.account).waterUpkeep!.readyAt;
    });
    fundFixtureFromReserves(path, 2000);
    for (const kind of waterFacilityKeys) {
      time += 1000;
      const request = store.read(identity.token, session => ({
        id: randomUUID(), revision: session.account.revision, command: { type: 'build', kind } as const,
      }));
      const result = store.transaction(identity.token, (session, now) => apply(session.account, request, now));
      const paid = store.read(identity.token, session => structuredClone(session.account));
      assert.deepEqual(store.transaction(identity.token, (session, now) => apply(session.account, request, now)), result);
      assert.deepEqual(store.read(identity.token, session => session.account), paid);
    }
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.equal(before.game.stock.wood, 580);
    assert.equal(before.game.stock.metal, 845);
    assert.equal(populationAndMaterialTotals(store).metal, 845);
    assert.equal(before.waterUpkeep!.readyAt, due);
    store.close();
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    assert.equal(store.read(identity.token, session => waterProductionMultiplier(session.account.game)), 8);
    assert.throws(() => store.transaction(identity.token, (session, now) =>
      apply(session.account, { id: randomUUID(), revision: session.account.revision, command: { type: 'build', kind: '__proto__' } }, now)), /Invalid command/);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('daily Water pauses persist across restarts without changing global or federation census', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-water-')), path = join(directory, 'test.sqlite');
  let time = 1000000, store = new SqliteStore(path, () => time);
  try {
    const identity = store.create();
    const due = store.transaction(identity.token, (session, now) => {
      apply(session.account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, now);
      session.account.game.population = 40;
      session.account.game.federation = 'Evergreen Union';
      session.account.game.stock.water = 0;
      return snapshot(session.account).waterUpkeep!.readyAt;
    });
    store.close();
    store = new SqliteStore(path, () => time);
    assert.equal(store.read(identity.token, session => session.account.waterUpkeep!.readyAt), due);
    time = due;
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.throws(() => store.transaction(identity.token, (session, now) => {
      accrue(session.account, now);
      throw new Error('rollback upkeep');
    }), /rollback upkeep/);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    assert.deepEqual(store.population('Evergreen Union'), { global: 40, federation: 40 });
    store.transaction(identity.token, (session, now) => accrue(session.account, now));
    assert.deepEqual(store.population('Evergreen Union'), { global: 40, federation: 40 });
    assert.equal(populationAndMaterialTotals(store).population, 40);
    assert.equal(store.read(identity.token, session => snapshot(session.account).waterUpkeep!.paused), true);
    store.close();
    store = new SqliteStore(path, () => time, 10);
    store.transaction(identity.token, (session, now) => accrue(session.account, now));
    assert.deepEqual(store.population('Evergreen Union'), { global: 40, federation: 40 });
    assert.equal(store.read(identity.token, session => session.account.waterUpkeep!.readyAt), due + worldDayMs);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('weekly upkeep saves migrate once to a full daily grace period without retroactive charges or work resets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-daily-migration-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch, store = new SqliteStore(path, () => time);
  try {
    const identity = store.create();
    const before = store.transaction(identity.token, (session, now) => {
      apply(session.account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, now);
      session.account.game.population = 40;
      session.account.game.stock.water = 600;
      session.account.waterUpkeep = { readyAt: now + worldWeekMs, lastPopulationLoss: 3 };
      session.account.workforce!.crews = {};
      session.account.workforce!.automatic = false;
      session.account.workforce!.allocation = { wood: 0, water: 0, metal: 0, oil: 0 };
      return structuredClone(session.account);
    });
    store.close();
    time += worldWeekMs * 10;
    store = new SqliteStore(path, () => time);
    const migrated = store.read(identity.token, session => structuredClone(session.account));
    assert.deepEqual(migrated.game, before.game);
    assert.deepEqual(migrated.pending, before.pending);
    assert.deepEqual(migrated.workforce, before.workforce);
    assert.deepEqual(migrated.inventory, before.inventory);
    assert.equal(migrated.updatedAt, before.updatedAt);
    assert.deepEqual(migrated.waterUpkeep, { version: 2, readyAt: time + worldDayMs, lastPopulationLoss: 0 });
    assert.equal(populationAndMaterialTotals(store).population, 40);
    const due = migrated.waterUpkeep!.readyAt;
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, session => session.account.waterUpkeep), migrated.waterUpkeep);
    time = due;
    const billed = store.transaction(identity.token, (session, now) => {
      accrue(session.account, now);
      return snapshot(session.account);
    });
    assert.equal(billed.game.stock.water, 600 - waterUpkeep(40, 600, due).required);
    assert.equal(billed.game.population, 40);
    assert.equal(billed.waterUpkeep!.dailyConsumption, waterUpkeep(40, 0, due + worldDayMs).required);
    assert.equal(billed.waterUpkeep!.weeklyConsumption, waterRequirement(40, due + worldDayMs));
    assert.equal(billed.waterUpkeep!.readyAt, due + worldDayMs);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('public totals count settled owned metal, not pending or visitors, and preserve atomicity and inactive worlds', () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time);
  seedFixturePools(store);
  const a = store.create(), b = store.create();
  const act = (token: string, command: Command) => store.transaction(token, (session, now) =>
    apply(session.account, { id: randomUUID(), revision: session.account.revision, command }, now));
  try {
    assert.deepEqual(populationAndMaterialTotals(store), { settlements: 0, metal: 0, population: 0 });
    store.transaction(a.token, session => {
      session.account.game.seed = 1542;
      session.account.game.explored = ['0,0', '-3,0', '3,0', '0,3'];
      const work = snapshot(session.account).workforce;
      work.automatic = false; work.allocation.metal = 5;
      session.account.workforce = work;
    });
    act(a.token, { type: 'upgrade' });
    act(b.token, { type: 'upgrade' });
    for (const token of [a.token, b.token]) store.transaction(token, session => { session.account.game.stock.water = 1000000; session.account.game.dollars = 1000000 * 10000; automateFixtureCollections(session.account); });
    assert.deepEqual(populationAndMaterialTotals(store), { settlements: 2, metal: 160, population: 24 });
    time += 1000;
    act(a.token, { type: 'assign', resource: 'metal', workers: 5 });
    time += worldWeekMs;
    store.read(a.token, (session, now) => {
      accrue(session.account, now);
      assert.equal(snapshot(session.account).pending.metal, 0);
      assert.equal(session.account.game.stock.metal, 100);
      session.account.game.stock.metal = 99999;
    });
    assert.equal(populationAndMaterialTotals(store).metal, 160);
    store.transaction(a.token, (session, now) => accrue(session.account, now));
    store.transaction(a.token, (session, now) => accrue(session.account, now));
    assert.equal(populationAndMaterialTotals(store).metal, 180);
    time += 1000;
    act(a.token, { type: 'warehouse' });
    assert.equal(populationAndMaterialTotals(store).metal, 160);
    time += 1000;
    store.transaction(a.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'spot', asset: 'wood', side: 'sell', quantity: 10, limitDollars: 1 } }, now, realTime));
    const ownedMetal = () => [a.token, b.token].reduce((sum, token) =>
      sum + store.read(token, session => session.account.game.stock.metal), 0);
    assert.equal(populationAndMaterialTotals(store).metal, ownedMetal());
    time += 1000;
    store.transaction(a.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'spot', asset: 'wood', side: 'buy', quantity: 5, limitDollars: 10000 } }, now, realTime));
    assert.equal(populationAndMaterialTotals(store).metal, ownedMetal());
    time += 1000;
    const recruited = act(a.token, { type: 'invite' }).recruitment!.population;
    assert.equal(populationAndMaterialTotals(store).population, 24);
    time += worldWeekMs;
    store.transaction(a.token, (session, now) => accrue(session.account, now));
    const before = populationAndMaterialTotals(store);
    assert.equal(before.population, store.population(null).global);
    assert.equal(before.population, 24 + recruited);
    assert.throws(() => store.transaction(a.token, session => {
      session.account.game.stock.metal += 1000;
      session.account.game.population += 100;
      throw new Error('rollback');
    }), /rollback/);
    assert.deepEqual(populationAndMaterialTotals(store), before);
    time += 8 * 86400000;
    store.create();
    assert.deepEqual(populationAndMaterialTotals(store), before);
  } finally { store.close(); }
});

test('census tracks settlement, recruitment and federation changes atomically, not reads or retries', () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time);
  const a = store.create(), b = store.create();
  const act = (token: string, command: Command) => store.transaction(token, (session, now) =>
    apply(session.account, { id: randomUUID(), revision: session.account.revision, command }, now));
  try {
    assert.deepEqual(store.population(null), { global: 0, federation: null });
    act(a.token, { type: 'upgrade' });
    act(b.token, { type: 'upgrade' });
    for (const token of [a.token, b.token]) store.transaction(token, session => { session.account.game.stock.water = 1000000; session.account.game.dollars = 1000000 * 10000; });
    assert.equal(store.population(null).global, 24);
    time += 1000;
    const request = store.read(a.token, session => ({ id: randomUUID(), revision: session.account.revision, command: { type: 'invite' } as const }));
    const arrivalsA = store.transaction(a.token, (session, now) => apply(session.account, request, now)).recruitment!.population;
    store.transaction(a.token, (session, now) => apply(session.account, request, now));
    assert.equal(store.population(null).global, 24);
    time += worldWeekMs - 1;
    store.transaction(a.token, (session, now) => accrue(session.account, now));
    assert.equal(store.population(null).global, 24);
    time += 1;
    store.transaction(a.token, (session, now) => accrue(session.account, now));
    const firstTotal = 24 + arrivalsA;
    assert.equal(store.population(null).global, firstTotal);
    store.read(a.token, session => { session.account.game.population = 999999; });
    assert.equal(store.population(null).global, firstTotal);
    assert.throws(() => store.transaction(a.token, session => {
      session.account.game.population += 100;
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.population(null).global, firstTotal);
    for (const token of [a.token, b.token]) {
      store.transaction(token, session => { session.account.game.stage = 3; session.account.game.relationship = 50; });
      time += 1000;
      act(token, { type: 'diplomacy', action: 'join' });
    }
    assert.deepEqual(store.population('Evergreen Union'), { global: firstTotal, federation: firstTotal });
    time += 600000;
    const arrivalsB = act(b.token, { type: 'invite' }).recruitment!.population;
    assert.deepEqual(store.population('Evergreen Union'), { global: firstTotal, federation: firstTotal });
    time += worldWeekMs;
    store.transaction(b.token, (session, now) => accrue(session.account, now));
    const total = firstTotal + arrivalsB, populationA = 12 + arrivalsA, populationB = 12 + arrivalsB;
    assert.deepEqual(store.population('Evergreen Union'), { global: total, federation: total });
    store.transaction(b.token, session => { session.account.game.federation = 'Other'; });
    assert.deepEqual(store.population('Evergreen Union'), { global: total, federation: populationA });
    assert.equal(store.population('Other').federation, populationB);
    time += 8 * 86400000;
    assert.throws(() => store.read(a.token, () => true), /expired/);
    store.create();
    assert.deepEqual(store.population('Evergreen Union'), { global: total, federation: populationA });
  } finally { store.close(); }
});

test('legacy migration, restarts and clock speed switches preserve balances, census and recruitment work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'terra-census-')), path = join(directory, 'test.sqlite');
  let time = 1000000;
  const token = 'a'.repeat(64), account = createAccount(time);
  account.game.stage = 0;
  account.game.population = 12;
  account.game.federation = 'Evergreen Union';
  account.game.stock.water = 1000000;
  account.game.dollars = 1000000 * 10000;
  const legacy = { ...account, growthMultiplier: 10, inviteReadyAt: time + 60000 };
  const db = sqlite.open(path);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'),
    time + 7 * 86400000, JSON.stringify({ csrf: 'test', expires: time + 7 * 86400000, account: legacy }));
  db.close();
  let store: SqliteStore | undefined;
  try {
    time += 1000;
    store = new SqliteStore(path, () => time, 10);
    assert.deepEqual(store.population('Evergreen Union'), { global: 12, federation: 12 });
    assert.deepEqual(populationAndMaterialTotals(store), { settlements: 1, metal: 80, population: 12 });
    const migrated = store.read(token, session => session.account);
    assert.equal(migrated.pending.wood, 0);
    assert.equal('growthMultiplier' in migrated, false);
    assert.equal(migrated.inviteReadyAt, time + 590000);
    assert.equal(migrated.game.stock.wood, account.game.stock.wood);
    time += 58999;
    assert.throws(() => store!.transaction(token, (session, now, realTime) => apply(session.account,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'invite' } }, now, realTime)), /Recruitment ready/);
    time += 1;
    store.transaction(token, (session, now, realTime) => apply(session.account,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'invite' } }, now, realTime));
    assert.equal(store.population(null).global, 12);
    const readyAt = store.read(token, session => session.account.inviteReadyAt);
    const population = 12 + store.read(token, session => session.account.recruitment!.population);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time, 10);
    assert.equal(store.population(null).global, 12);
    const serverTime = store.read(token, (_, now) => now);
    assert.equal(readyAt - serverTime, worldWeekMs - 10000);
    store.close();
    store = new SqliteStore(path, () => time, 1);
    assert.deepEqual(populationAndMaterialTotals(store), { settlements: 1, metal: 80, population: 12 });
    assert.equal(store.read(token, (_, now) => now), serverTime);
    assert.equal(store.read(token, session => session.account.inviteReadyAt), readyAt);
    time += 1000;
    assert.equal(store.read(token, (_, now) => now), serverTime + 1000);
    assert.throws(() => store!.transaction(token, (session, now, realTime) => apply(session.account,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'invite' } }, now, realTime)), /Recruitment ready/);
    assert.equal(store.population(null).global, 12);
    time += readyAt - (serverTime + 1000);
    store.transaction(token, (session, now) => accrue(session.account, now));
    assert.deepEqual(store.population('Evergreen Union'), { global: population, federation: population });
    store.transaction(token, (session, now) => accrue(session.account, now));
    assert.equal(store.population(null).global, population);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true });
  }
});

test('one shared development clock drives resources and environment twentyfold with unchanged game rules', () => {
  let time = worldEpoch;
  const production = new SqliteStore(':memory:', () => time);
  const development = new SqliteStore(':memory:', () => time, 20);
  try {
    const prod = production.create(), dev = development.create(), peer = development.create();
    for (const [store, token] of [[production, prod.token], [development, dev.token]] as const) {
      store.transaction(token, (session, now, realTime) => {
        session.account.game.stage = 6;
        automateFixtureCollections(session.account);
        session.account.game.explored = ['0,0', '-3,0', '3,0', '0,3'];
        session.account.game.population = 12;
        session.account.game.stock.water = 1000000000;
        session.account.game.stock.wood = 0;
        session.account.game.dollars = 1000000 * 10000;
        session.account.game.bank = true;
        session.account.game.federation = 'Evergreen Union';
        session.account.warehouse = 10;
        apply(session.account, { id: randomUUID(), revision: session.account.revision,
          command: { type: 'assign', resource: 'wood', workers: 2 } }, now, realTime);
      });
    }
    const before = development.read(dev.token, session => structuredClone(session.account));
    time += 1234;
    const project = (store: SqliteStore, token: string) => store.read(token, (session, now) => {
      accrue(session.account, now);
      return { result: snapshot(session.account), fixed: session.account.pending };
    });
    const p = project(production, prod.token), d = project(development, dev.token);
    assert.equal(p.result.serverTime, worldEpoch + 1234);
    assert.equal(d.result.serverTime, worldEpoch + 24680);
    assert.equal(development.read(peer.token, (_, now) => now), d.result.serverTime);
    assert.deepEqual(d.result.rates, p.result.rates);
    assert.equal(d.result.capacity, p.result.capacity);
    assert.equal(d.result.claimThreshold, p.result.claimThreshold);
    assert.equal(d.result.pending.wood, 0);
    assert.equal(p.result.pending.wood, 0);
    assert.deepEqual(d.result.environment, environmentAt(worldEpoch + 24680));
    assert.deepEqual(development.read(dev.token, session => session.account), before);
    time = worldEpoch + worldDayMs / 20 - 1;
    assert.equal(project(development, dev.token).result.environment.minuteOfDay, 1439);
    time += 1;
    assert.equal(project(development, dev.token).result.environment.day, 2);
    time = worldEpoch + worldWeekMs / 20 - 1;
    assert.equal(project(development, dev.token).result.pending.wood, 0);
    time += 1;
    assert.equal(project(development, dev.token).result.game.stock.wood, before.workforce!.crews.wood!.weeklyYield);
    assert.equal(project(production, prod.token).result.pending.wood, 0);
    time = worldEpoch + seasonMs / 20 - 1;
    assert.equal(project(development, dev.token).result.environment.season, 'Spring');
    time += 1;
    assert.equal(project(development, dev.token).result.environment.season, 'Summer');
    time = worldEpoch + worldWeekMs;
    assert.equal(project(production, prod.token).result.game.stock.wood, before.workforce!.crews.wood!.weeklyYield);
    const expected = structuredClone(before);
    accrue(expected, worldEpoch + 20 * worldWeekMs);
    assert.equal(project(development, dev.token).result.game.stock.wood, expected.game.stock.wood);
    const last = development.read(dev.token, (_, now) => now);
    time -= 1000;
    assert.equal(development.read(dev.token, (_, now) => now), last);
  } finally { production.close(); development.close(); }
});

test('legacy 10x clock schema migrates to 20x without resetting time or saved work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-clock-20-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time, 10);
  const identity = store.create();
  try {
    store.transaction(identity.token, session => {
      const account = session.account;
      account.game.stage = 0; account.game.population = 12;
      account.game.stock.water = 1000000;
      account.pending.wood = 123;
      account.recruitment = { population: 18, startedAt: time, readyAt: time + worldWeekMs };
      account.inviteReadyAt = account.recruitment.readyAt;
      const work = snapshot(account).workforce;
      work.automatic = false;
      work.crews.wood = { workers: 2, readyAt: time + worldWeekMs, weeklyYield: 60, weeklyMetalCost: 0 };
      work.expeditions = [{ x: 5, y: 0, workers: 2, readyAt: time + worldWeekMs * 2, surveyRadius: 4 }];
      account.workforce = work;
    });
    const saved = store.read(identity.token, session => session.account);
    store.close();
    const db = sqlite.open(path);
    try {
      db.exec(`ALTER TABLE server_clock RENAME TO new_server_clock;
        CREATE TABLE server_clock (id INTEGER PRIMARY KEY CHECK(id=1), realTime INTEGER NOT NULL,
          serverTime INTEGER NOT NULL, speed INTEGER NOT NULL CHECK(speed IN (1,10)));
        INSERT INTO server_clock SELECT * FROM new_server_clock;
        DROP TABLE new_server_clock`);
    } finally { db.close(); }
    time += 1000;
    store = new SqliteStore(path, () => time, 20);
    assert.equal(store.clockSpeed, 20);
    const switched = worldEpoch + 10000;
    assert.equal(store.read(identity.token, (_, now) => now), switched);
    assert.deepEqual(store.read(identity.token, session => session.account), saved);
    time += 1000;
    assert.equal(store.read(identity.token, (_, now) => now), switched + 20000);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time, 20);
    assert.equal(store.read(identity.token, (_, now) => now), switched + 40000);
    assert.deepEqual(store.read(identity.token, session => session.account), saved);
    store.close();
    store = new SqliteStore(path, () => time, 1);
    assert.equal(store.read(identity.token, (_, now) => now), switched + 40000);
    time += 1000;
    assert.equal(store.read(identity.token, (_, now) => now), switched + 41000);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('weekly crews and expeditions persist through restart and speed changes without duplicate deliveries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'terra-weekly-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time, 10);
  const session = store.create();
  const act = (command: Command) => store.transaction(session.token, (record, now, realTime) =>
    apply(record.account, { id: randomUUID(), revision: record.account.revision, command }, now, realTime));
  try {
    store.transaction(session.token, record => {
      automateFixtureCollections(record.account);
      record.account.game.explored = ['0,0', '-3,0', '3,0', '0,3'];
      record.account.game.dollars = 500 * 10000;
      record.account.game.stock.metal = 1000;
      record.account.game.stock.water = 1000000;
      record.account.game.stock.wood = 60;
      const work = snapshot(record.account).workforce;
      work.automatic = false; work.allocation.wood = 3;
      record.account.workforce = work;
    });
    fundFixtureFromReserves(path, 500);
    act({ type: 'upgrade' });
    time += 1000;
    act({ type: 'assign', resource: 'wood', workers: 3 });
    time += 1000;
    act({ type: 'move', x: 5, y: 0 });
    time += 1000;
    act({ type: 'move', x: 0, y: -5 });
    const before = store.read(session.token, record => snapshot(record.account));
    const due = before.workforce.crews.wood!.readyAt;
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time, 1);
    const restored = store.read(session.token, record => snapshot(record.account));
    assert.deepEqual(restored.workforce, before.workforce);
    assert.equal(restored.availableWorkers, before.availableWorkers);
    const serverNow = store.read(session.token, (_, now) => now);
    time += due - serverNow;
    store.transaction(session.token, (record, now) => accrue(record.account, now));
    const delivered = store.read(session.token, record => snapshot(record.account));
    assert.equal(delivered.pending.wood, 0);
    assert.equal(delivered.game.stock.wood, before.workforce.crews.wood!.weeklyYield);
    assert.equal(delivered.workforce.crews.wood, undefined);
    store.close();
    store = new SqliteStore(path, () => time, 20);
    store.transaction(session.token, (record, now) => accrue(record.account, now));
    assert.equal(store.read(session.token, record => snapshot(record.account).game.stock.wood), delivered.game.stock.wood);
    const mission = before.workforce.expeditions[before.workforce.expeditions.length - 1];
    const now = store.read(session.token, (_, now) => now);
    time += Math.ceil(Math.max(0, mission.readyAt - now) / 20);
    store.transaction(session.token, (record, now) => accrue(record.account, now));
    const complete = store.read(session.token, record => snapshot(record.account));
    assert.deepEqual(complete.workforce.expeditions, []);
    assert.ok(complete.game.explored.includes('5,0'));
    assert.equal(complete.availableWorkers, complete.game.population
      - Object.values(complete.workforce.crews).reduce((sum, crew) => sum + crew.workers, 0));
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('resource migration is persisted once and preserves legacy progress without transport backcharges', () => {
  const directory = mkdtempSync(join(tmpdir(), 'terra-resource-migration-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time);
  const session = store.create();
  try {
    store.transaction(session.token, record => {
      const account = record.account;
      account.game.stage = 0; account.game.population = 12; account.game.home = { x: 20, y: 0 };
      account.pending.wood = 123;
      account.workforce = { crews: { wood: { workers: 1, x: -3, y: 0, weeklyYield: 30,
        readyAt: worldEpoch + worldWeekMs, lockedUntil: worldEpoch + worldWeekMs } },
      expedition: { x: 5, y: 0, workers: 2, surveyRadius: 4, readyAt: worldEpoch + worldWeekMs * 4 } };
    });
    store.close();
    time += worldWeekMs * 1.5;
    store = new SqliteStore(path, () => time);
    const migrated = store.read(session.token, record => snapshot(record.account));
    assert.equal(migrated.pending.wood, 30);
    assert.equal(store.read(session.token, record => record.account.pending.wood), 30 * 60000 + 123);
    assert.equal(migrated.game.stock.metal, 80);
    assert.equal(populationAndMaterialTotals(store).metal, 80);
    assert.equal(migrated.workforce.version, 3);
    assert.equal(migrated.workforce.automatic, true);
    assert.equal(migrated.workforce.crews.wood!.readyAt, worldEpoch + worldWeekMs * 2);
    assert.equal(migrated.workforce.crews.wood!.weeklyMetalCost, 0);
    assert.equal(migrated.workforce.expeditions[0].readyAt, worldEpoch + worldWeekMs * 4);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(session.token, record => snapshot(record.account)), migrated);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('version-two single expedition saves upgrade once without changing paid crews or balances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'terra-expedition-migration-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time);
  const identity = store.create();
  try {
    store.transaction(identity.token, session => {
      const { expeditions, ...work } = snapshot(session.account).workforce;
      assert.deepEqual(expeditions, []);
      session.account.game.stage = 0; session.account.game.population = 12;
      session.account.pending.wood = 123;
      session.account.workforce = { ...work, version: 2, automatic: false,
        crews: { wood: { workers: 2, readyAt: worldEpoch + worldWeekMs, weeklyYield: 60, weeklyMetalCost: 2 } },
        expedition: { x: 5, y: 0, workers: 2, readyAt: worldEpoch + worldWeekMs * 2, surveyRadius: 4 } };
    });
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    const saved = store.read(identity.token, session => structuredClone(session.account));
    const state = snapshot(saved);
    assert.equal(state.workforce.version, 3);
    assert.equal(state.workforce.automatic, false);
    assert.equal(state.workforce.crews.wood!.readyAt, worldEpoch + worldWeekMs);
    assert.equal(state.workforce.crews.wood!.weeklyMetalCost, 2);
    assert.equal(state.workforce.expeditions[0].readyAt, worldEpoch + worldWeekMs * 2);
    assert.equal(state.availableWorkers, 8);
    assert.equal(saved.pending.wood, 123);
    assert.equal(saved.game.stock.metal, 80);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, session => session.account), saved);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('inventory migration runs independently of workforce v3 and persists legacy equipment without charging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-items-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time);
  const identity = store.create();
  try {
    store.transaction(identity.token, session => {
      session.account.game.stage = 0; session.account.game.population = 12;
      session.account.game.light = 2;
      session.account.game.dollars = 500 * 10000;
      session.account.pending.wood = 12345;
      const work = snapshot(session.account).workforce;
      work.expeditions = [{ x: 7, y: 0, workers: 2, readyAt: time + worldWeekMs, surveyRadius: 8 }];
      session.account.workforce = work;
      delete session.account.inventory;
      delete session.account.game.visibilityRadius;
    });
    fundFixtureFromReserves(path, 500);
    const before = store.read(identity.token, record => structuredClone(record.account));
    const totals = populationAndMaterialTotals(store);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    const saved = store.read(identity.token, record => structuredClone(record.account));
    assert.deepEqual(saved.inventory, { version: 1, storage: 0, items: ['torch', 'lamp'], pending: [], equipped: 'lamp', placements: {},
      layout: { version: 1, positions: settlementPositions(saved.game, saved.inventory!) } });
    assert.equal(saved.game.visibilityRadius, 8);
    assert.deepEqual(saved.workforce, before.workforce);
    assert.deepEqual(saved.game.stock, before.game.stock);
    assert.deepEqual(saved.game.explored, before.game.explored);
    assert.equal(saved.pending.wood, 12345);
    assert.deepEqual(populationAndMaterialTotals(store), totals);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, record => record.account), saved);
    for (const command of [{ type: 'item-storage' }, { type: 'craft', item: 'fire' }, { type: 'equip', item: 'fire' },
      { type: 'craft', item: 'bench' }, { type: 'decorate', slot: 'garden', item: 'bench' }] as const) {
      time += 1000;
      store.transaction(identity.token, (record, now) => apply(record.account,
        { id: randomUUID(), revision: record.account.revision, command }, now));
    }
    const modern = store.read(identity.token, record => structuredClone(record.account));
    const modernTotals = populationAndMaterialTotals(store);
    assert.equal(modern.inventory!.storage, 1);
    assert.equal(modern.inventory!.equipped, 'fire');
    assert.ok(modern.inventory!.items.includes('fire'));
    assert.deepEqual(modern.inventory!.placements, { garden: 'bench' });
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, record => record.account), modern);
    assert.deepEqual(populationAndMaterialTotals(store), modernTotals);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('existing version-one inventory gets empty decoration spaces without resetting items or paid work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-decoration-migration-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store = new SqliteStore(path, () => time);
  const identity = store.create();
  try {
    store.transaction(identity.token, record => {
      record.account.game.stage = 3; record.account.game.population = 250;
      snapshot(record.account);
      record.account.inventory = { version: 1, items: ['torch', 'bench'], equipped: 'torch', storage: 1, pending: ['relic-coast'] };
      record.account.game.visibilityRadius = 6;
      record.account.pending.water = 12345;
    });
    const before = store.read(identity.token, record => structuredClone(record.account)), totals = populationAndMaterialTotals(store);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    const migrated = store.read(identity.token, record => structuredClone(record.account));
    assert.deepEqual(migrated.inventory, { ...before.inventory, placements: {},
      layout: { version: 1, positions: settlementPositions(migrated.game, migrated.inventory!) } });
    assert.deepEqual(migrated.game, before.game);
    assert.deepEqual(migrated.workforce, before.workforce);
    assert.deepEqual(migrated.pending, before.pending);
    assert.deepEqual(populationAndMaterialTotals(store), totals);
    store.close();
    time += 1000;
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, record => record.account), migrated);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('legacy decoration layouts migrate and free building arrangements survive restart with exact receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-layout-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch, store = new SqliteStore(path, () => time);
  const identity = store.create();
  try {
    store.transaction(identity.token, record => {
      record.account.game.stage = 6; record.account.game.population = 2000;
      record.account.game.bank = true; record.account.game.townhall = true;
      record.account.game.visibilityRadius = 6;
      const work = snapshot(record.account).workforce;
      work.expeditions = [{ x: 7, y: 0, workers: 2, readyAt: time + worldWeekMs, surveyRadius: 6 }];
      record.account.workforce = work;
      record.account.inventory = { version: 1, storage: 1, items: ['torch', 'bench', 'planter'], pending: ['relic-coast'],
        equipped: 'torch', placements: { square: 'bench', garden: 'planter' } };
      record.account.game.visibilityRadius = 6;
      record.account.pending.water = 12345;
    });
    const before = store.read(identity.token, record => structuredClone(record.account)), totals = populationAndMaterialTotals(store);
    store.close();
    store = new SqliteStore(path, () => time);
    const migrated = store.read(identity.token, record => structuredClone(record.account));
    assert.deepEqual(migrated.inventory!.layout!.positions.bench, legacySpaceCells.square);
    assert.deepEqual(migrated.inventory!.layout!.positions.planter, legacySpaceCells.garden);
    assert.equal(Object.keys(migrated.inventory!.layout!.positions).length, 19);
    assert.deepEqual(migrated.game, before.game);
    assert.deepEqual(migrated.pending, before.pending);
    assert.deepEqual(migrated.workforce, before.workforce);
    const body = { id: randomUUID(), revision: migrated.revision,
      command: { type: 'arrange', entity: 'workshop', position: { x: -8, y: -8 } } };
    time += 1000;
    const result = store.transaction(identity.token, (record, now) => apply(record.account, body, now));
    const saved = store.read(identity.token, record => structuredClone(record.account));
    store.close();
    store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, record => record.account), saved);
    assert.deepEqual(store.transaction(identity.token, (record, now) => apply(record.account, body, now)), result);
    assert.deepEqual(populationAndMaterialTotals(store), totals);
    assert.throws(() => store.transaction(identity.token, (record, now) => apply(record.account,
      { id: randomUUID(), revision: record.account.revision, command: { type: 'arrange', entity: 'centre', position: { x: -8, y: -8 } } }, now + 1000)), /occupied/);
    assert.deepEqual(store.read(identity.token, record => record.account), saved);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('item upgrades debit public metal exactly once and failed full-inventory crafting rolls back all state', () => {
  let time = worldEpoch;
  const store = new SqliteStore(':memory:', () => time), identity = store.create();
  store.transaction(identity.token, record => { record.account.game.dollars = 500 * 10000; });
  const act = (command: Command) => store.transaction(identity.token, (record, now) => apply(record.account,
    { id: randomUUID(), revision: record.account.revision, command }, now));
  try {
    act({ type: 'upgrade' });
    const totals = populationAndMaterialTotals(store);
    time += 1000;
    const body = store.read(identity.token, record => ({
      id: randomUUID(), revision: record.account.revision, command: { type: 'item-storage' } as const,
    }));
    store.transaction(identity.token, (record, now) => apply(record.account, body, now));
    store.transaction(identity.token, (record, now) => apply(record.account, body, now));
    assert.equal(populationAndMaterialTotals(store).metal, totals.metal - 50);
    assert.equal(populationAndMaterialTotals(store).population, totals.population);
    store.transaction(identity.token, record => {
      record.account.inventory = { version: 1, storage: 0,
        items: (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).slice(0, 20).map(terrain => `relic-${terrain}` as const), pending: [], equipped: null };
    });
    const before = store.read(identity.token, record => structuredClone(record.account));
    const beforeTotals = populationAndMaterialTotals(store);
    time += worldWeekMs;
    assert.throws(() => act({ type: 'craft', item: 'torch' }), /full/);
    assert.deepEqual(store.read(identity.token, record => record.account), before);
    assert.deepEqual(populationAndMaterialTotals(store), beforeTotals);
  } finally { store.close(); }
});
test('accelerated game time does not accelerate session expiry or initial grants', () => {
  let time = worldEpoch;
  const store = new SqliteStore(':memory:', () => time, 10);
  try {
    const session = store.create();
    assert.equal(session.expires, time + 7 * 86400000);
    time += 86400000;
    const state = store.read(session.token, (value, now) => ({ account: value.account, now }));
    assert.equal(state.now, worldEpoch + 10 * 86400000);
    assert.equal(state.account.game.stock.wood, 180);
    time = worldEpoch + 7 * 86400000 - 1;
    store.read(session.token, () => true);
    time += 1;
    assert.throws(() => store.read(session.token, () => true), /expired/);
  } finally { store.close(); }
});
