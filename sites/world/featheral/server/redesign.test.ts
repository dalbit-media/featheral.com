import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { accrue, apply, capacity, createAccount, migrateEconomy, snapshot } from './economy.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldDayMs, worldWeekMs } from '../src/environment.ts';
import { basicWorkers, emptyAllocation, fundAllocation, resourceAccess, resourceCapacity, resourceKeys, transportCost } from '../src/workforce.ts';
import { constructions, constructionCost, constructionLevel } from '../src/constructions.ts';
import { poolPayment } from '../src/pool-pricing.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import { waterRequirement } from '../src/upkeep.ts';
import type { Account } from './economy.ts';
import type { Command } from '../src/api-types.ts';
import { DatabaseSync } from 'node:sqlite';
import { Exchange } from './market.ts';
import { enforceMonetaryPolicy } from './monetary-policy.ts';
import { SqliteStore } from './store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automateFixtureCollections } from './test-support.ts';

const start = 1000000;
const act = (account: Account, command: Command, now = account.updatedAt + 1000) =>
  apply(account, { id: randomUUID(), revision: account.revision, command }, now);
function colony() {
  const account = createAccount(start);
  account.game.seed = 1542;
  act(account, { type: 'upgrade' }, start);
  return account;
}
test('zero-cash crews require residents and a whole week; output waits for paid pickup', () => {
  const account = colony();
  account.game.stock.wood = 0;
  account.game.dollars = 0;
  account.workforce!.crews = {};
  act(account, { type: 'home' });
  const before = snapshot(account), due = before.workforce.cycleAt;
  assert.ok(before.workforce.crews.wood!.workers > 0);
  assert.ok(before.workforce.crews.wood!.weeklyDollarsCost! > 0);
  accrue(account, due - 1);
  assert.equal(account.game.stock.wood, 0);
  accrue(account, due);
  assert.equal(account.game.stock.wood, 0);
  assert.equal(snapshot(account).pending.wood, before.rates.wood);
  assert.equal(account.game.dollars, 0);
  const population = account.game.population;
  accrue(account, due + 1000000 * worldWeekMs);
  assert.equal(account.game.population, population);
  assert.equal(account.game.dollars, 0);
  assert.ok(account.game.stock.wood <= capacity(account));
});
test('funding has one free Wood/Water worker, charges every additional worker exactly and obeys physical storage', () => {
  const account = colony(), game = account.game;
  game.stock = { wood: 0, water: 2520, metal: 0, oil: 0 };
  game.dollars = 2 * dollarsScale;
  const access = resourceAccess(game), allocation = { wood: 3, water: 1, metal: 1, oil: 0 };
  const funded = fundAllocation(game, emptyAllocation(), 1000, allocation, access, 0, 0);
  assert.equal(funded.crews.metal, 1);
  assert.equal(funded.crews.wood, 2);
  assert.equal(funded.crews.water, 1);
  assert.equal(funded.dollars, 0);
  assert.equal(transportCost('wood', 3, 6), 12);
  assert.equal(transportCost('water', 1, 6), 0);
  assert.equal(transportCost('metal', 1, 6), 6);
  game.dollars = 0;
  const basic = fundAllocation(game, emptyAllocation(), 1000, allocation, access, 0, 0);
  assert.deepEqual(basic.crews, { wood: 1, water: 1, metal: 0, oil: 0 });
  for (const resource of resourceKeys) game.stock[resource] = resourceCapacity(1000, resource, game);
  game.stock.water += access.water.weeklyConsumption!;
  assert.deepEqual(fundAllocation(game, emptyAllocation(), 1000, allocation, access, 0, 0).crews, emptyAllocation());
});
test('funding stays nonnegative, respects reserves and never double-assigns across many budgets', () => {
  const account = colony(), game = account.game, access = resourceAccess(game);
  game.stock.wood = 0; game.stock.metal = 0;
  for (let budget = 0; budget <= 100; budget++) {
    game.dollars = (budget + 10) * dollarsScale;
    const plan = fundAllocation(game, emptyAllocation(), 10000, { wood: 5, water: 5, metal: 5, oil: 0 }, access, 2, 10);
    assert.ok(plan.dollars >= 10 * dollarsScale);
    assert.ok(Object.values(plan.crews).reduce((a, b) => a + b, 0) <= game.population - 2);
    assert.equal(game.dollars - plan.dollars, resourceKeys.reduce((total, resource) =>
      total + transportCost(resource, plan.crews[resource], access[resource].dollarsPerWorker) * dollarsScale, 0));
    for (const resource of resourceKeys) assert.ok(plan.crews[resource] <= plan.allocation[resource]);
  }
});
test('shortages preserve residents, paid gathering and expeditions and explicitly block new advanced activity', () => {
  const account = colony();
  account.game.dollars = 10000 * dollarsScale;
  act(account, { type: 'move', x: 5, y: 0 });
  account.game.stock.water = 0;
  const population = account.game.population, work = structuredClone(account.workforce);
  accrue(account, snapshot(account).waterUpkeep!.readyAt);
  assert.equal(account.game.population, population);
  assert.deepEqual(account.workforce!.crews, work!.crews);
  assert.deepEqual(account.workforce!.expeditions, work!.expeditions);
  assert.equal(snapshot(account).waterUpkeep!.paused, true);
  assert.equal(snapshot(account).waterUpkeep!.populationLoss, 0);
  assert.throws(() => act(account, { type: 'invite' }), /Restore Water/);
  account.game.stock.water = 100000;
  assert.equal(snapshot(account).waterUpkeep!.paused, false);
  const invited = act(account, { type: 'invite' });
  assert.equal(invited.recruitment!.population * 50, invited.recruitmentDollars);
});
test('a fully funded capital sustains its entire population without manual claims', () => {
  const account = colony();
  automateFixtureCollections(account);
  account.game.stage = 8; account.game.population = 100000; account.game.bank = true;
  account.game.waterFacilities = { well: true, rainCollector: true, pumpingStation: true };
  account.game.stock.water = waterRequirement(100000) * 2;
  account.game.dollars = 10000000 * dollarsScale;
  account.workforce!.crews = {};
  act(account, { type: 'automatic', enabled: true });
  assert.ok(resourceCapacity(capacity(account), 'water', account.game) >= Math.ceil(waterRequirement(100000) * 1.5) * 2);
  for (let week = 1; week <= 52; week++) {
    accrue(account, start + 1000 + week * worldWeekMs);
    assert.equal(account.game.population, 100000);
    assert.ok(account.game.stock.water >= snapshot(account).waterUpkeep!.dailyConsumption);
    assert.deepEqual(snapshot(account).pending, emptyAllocation());
  }
});
test('legacy completed stock becomes owned once without changing currency, receipts or paid deadlines', () => {
  const account = colony();
  delete account.playabilityVersion;
  account.pending.wood = 90 * 60000 + 123;
  const before = structuredClone(account);
  migrateEconomy(account, account.updatedAt);
  assert.equal(account.game.stock.wood, before.game.stock.wood + 90);
  assert.equal(account.pending.wood, 123);
  assert.equal(account.game.dollars, before.game.dollars);
  assert.deepEqual(account.workforce, before.workforce);
  assert.deepEqual(account.receipt, before.receipt);
  assert.equal(account.revision, before.revision + 1);
  migrateEconomy(account, account.updatedAt);
  assert.equal(account.revision, before.revision + 1);
});
test('legacy paid deliveries finish automatically even when current owned inventory exceeds the new cap', () => {
  const account = colony();
  account.game.stock.wood = 1000;
  account.workforce!.crews.wood = { workers: 2, readyAt: start + worldWeekMs, weeklyYield: 60, weeklyMetalCost: 10 };
  const dollars = account.game.dollars;
  accrue(account, start + worldWeekMs);
  assert.equal(account.game.stock.wood, 1060);
  assert.equal(account.game.dollars, dollars);
  assert.equal(snapshot(account).pending.wood, 0);
});
test('all construction levels pay their exact linear material and FTH$ costs, retain receipts and do not alter paid work', () => {
  for (const kind of Object.keys(constructions) as (keyof typeof constructions)[]) {
    const account = colony();
    account.game.stage = 6;
    account.game.stock = { wood: 1000000, water: 1000000, metal: 1000000, oil: 1000000 };
    account.game.dollars = 10000000 * dollarsScale;
    for (let level = 1; level <= constructions[kind].maxLevel; level++) {
      const cost = constructionCost(account.game, kind)!, before = structuredClone(account);
      const request = { id: randomUUID(), revision: account.revision, command: { type: 'construction', kind } };
      const result = apply(account, request, account.updatedAt + 1000);
      assert.equal(constructionLevel(account.game, kind), level);
      assert.equal(before.game.dollars - account.game.dollars, cost.dollars! * dollarsScale);
      for (const resource of resourceKeys) assert.equal(before.game.stock[resource] - account.game.stock[resource], cost[resource] ?? 0);
      assert.deepEqual(account.workforce!.crews, before.workforce!.crews);
      assert.deepEqual(apply(account, request, account.updatedAt + 1000), result);
    }
    assert.equal(constructionCost(account.game, kind), null);
    assert.throws(() => act(account, { type: 'construction', kind }), /maximum level/);
  }
});
test('housing changes only future recruitment batches at the fixed FTH$50 per resident', () => {
  const account = colony();
  account.game.dollars = 10000 * dollarsScale;
  act(account, { type: 'invite' });
  const locked = structuredClone(account.recruitment);
  act(account, { type: 'construction', kind: 'housing' });
  assert.deepEqual(account.recruitment, locked);
  accrue(account, locked!.readyAt);
  account.game.stock.water = 10000;
  const quote = snapshot(account).recruitmentDollars;
  assert.equal(act(account, { type: 'invite' }).recruitment!.population * 50, quote);
});
test('workshops and trade hubs preserve old ownership and improve only new work; reservoirs add a population-scaled week', () => {
  const account = colony(), game = account.game;
  const before = resourceAccess(game);
  game.incomeFacilities = { workshop: true, 'trade-hub': true };
  assert.equal(constructionLevel(game, 'workshop'), 1);
  assert.equal(constructionLevel(game, 'logistics'), 1);
  assert.equal(resourceAccess(game).wood.perWorker, Math.floor(before.wood.perWorker * 1.25));
  game.population = 100000;
  const cap = resourceCapacity(capacity(account), 'water', game);
  game.constructionLevels = { cistern: 1 };
  assert.equal(resourceCapacity(capacity(account), 'water', game) - cap, Math.ceil(waterRequirement(game.population) * 1.5));
});
test('weekly deliveries and paused maintenance are identical online and offline, including recruitment and expedition boundaries', () => {
  for (const cash of [0, 20, 10000]) {
    const account = colony();
    account.game.stock.wood = 0;
    account.game.dollars = cash * dollarsScale;
    if (cash === 10000) {
      act(account, { type: 'invite' });
      act(account, { type: 'move', x: 5, y: 0 });
    }
    const one = structuredClone(account), frequent = structuredClone(account);
    const finish = account.updatedAt + worldWeekMs * 52;
    for (let step = 1; step <= 364; step++) accrue(frequent, account.updatedAt + Math.floor((finish - account.updatedAt) * step / 364));
    accrue(one, finish);
    assert.deepEqual(snapshot(one), snapshot(frequent));
    const began = performance.now();
    accrue(one, finish + worldWeekMs * 1000000);
    assert.ok(performance.now() - began < 1000);
    assert.ok(one.game.population > 0);
    assert.ok(one.game.dollars >= 0);
  }
});
test('shared reserve pricing preserves 1% spread, fixed-point rounding and amount limits', () => {
  const pool = { units: 100000, dollars: 200000 * dollarsScale };
  for (const quantity of [1, 3, 10000, 25000]) {
    const buy = poolPayment(pool, 'buy', quantity), sell = poolPayment(pool, 'sell', quantity);
    assert.ok(buy > sell);
    assert.equal(buy, poolPayment({ units: pool.units * 10000, dollars: pool.dollars }, 'buy', quantity * 10000));
    assert.equal(sell, poolPayment({ units: pool.units * 10000, dollars: pool.dollars }, 'sell', quantity * 10000));
  }
  assert.throws(() => poolPayment(pool, 'buy', pool.units), RangeError);
  assert.equal(poolPayment({ units: 0, dollars: 0 }, 'sell', 1), 0);
  assert.equal(monetaryPolicy.spendingBurns, true);
  assert.equal(monetaryPolicy.mintAfterBootstrap, false);
  assert.equal(basicWorkers('oil'), 0);
  assert.equal(worldWeekMs, worldDayMs * 7);
});
test('recruits never join already-paid deliveries or receive partial-week output', () => {
  const account = colony();
  automateFixtureCollections(account);
  account.game.stock.wood = 0; account.game.stock.water = 1000000000;
  account.game.dollars = 1000000 * dollarsScale; account.warehouse = 10;
  account.workforce!.crews = {}; account.workforce!.automatic = false;
  account.workforce!.allocation = { wood: 28, water: 0, metal: 0, oil: 0 };
  act(account, { type: 'home' });
  const first = snapshot(account), due = first.workforce.cycleAt;
  const recruitment = act(account, { type: 'invite' }).recruitment!;
  assert.ok(due < recruitment.readyAt);
  accrue(account, due - 1); assert.equal(account.game.stock.wood, 0);
  accrue(account, due); assert.equal(account.game.stock.wood, first.rates.wood);
  const second = structuredClone(account.workforce!.crews.wood!);
  assert.equal(second.workers, 10);
  accrue(account, recruitment.readyAt);
  assert.equal(account.game.population, 12 + recruitment.population);
  assert.deepEqual(account.workforce!.crews.wood, second);
  assert.equal(account.game.stock.wood, first.rates.wood);
  accrue(account, second.readyAt);
  assert.equal(account.game.stock.wood, first.rates.wood + second.weeklyYield);
  assert.equal(account.workforce!.crews.wood!.workers, Math.min(28, account.game.population - 2));
});
test('permanent policy refuses mutation and issuance; later market registration cannot seed new FTH$', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER,data TEXT);
      CREATE TABLE gold_pool(id INTEGER PRIMARY KEY,gold INTEGER,dollars INTEGER);
      INSERT INTO gold_pool VALUES(1,10000000,10000000000);`);
    new Exchange(db);
    enforceMonetaryPolicy(db);
    const before = Number(db.prepare('SELECT SUM(dollars) AS dollars FROM market_pools').get()!.dollars);
    const missing = Number(db.prepare("SELECT dollars FROM market_pools WHERE asset='wood'").get()!.dollars);
    db.prepare('UPDATE gold_pool SET dollars=dollars+?').run(missing);
    db.exec("DELETE FROM market_pools WHERE asset='wood'");
    new Exchange(db);
    assert.equal(Number(db.prepare('SELECT SUM(dollars) AS dollars FROM market_pools').get()!.dollars), before - missing);
    assert.deepEqual({ ...db.prepare("SELECT units,dollars FROM market_pools WHERE asset='wood'").get()! }, { units: 0, dollars: 0 });
    enforceMonetaryPolicy(db);
    db.exec('UPDATE gold_pool SET dollars=dollars-1');
    enforceMonetaryPolicy(db);
    db.exec('UPDATE gold_pool SET dollars=dollars+2');
    assert.throws(() => enforceMonetaryPolicy(db), /issuance/);
    db.exec("UPDATE monetary_policy SET fingerprint='modified'");
    assert.throws(() => enforceMonetaryPolicy(db), /policy changed/);
  } finally { db.close(); }
});
test('startup converts pending Metal into public owned totals once and preserves paid work, money and receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-playability-')), path = join(directory, 'world.sqlite');
  const time = 1000000;
  let store = new SqliteStore(path, () => time);
  try {
    const identity = store.create();
    const before = store.transaction(identity.token, (session, now) => {
      apply(session.account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, now);
      session.account.pending.metal = 123 * 60000 + 555;
      delete session.account.playabilityVersion;
      return structuredClone(session.account);
    });
    const totals = store.publicTotals();
    store.close(); store = new SqliteStore(path, () => time);
    const migrated = store.read(identity.token, session => structuredClone(session.account));
    assert.equal(migrated.game.stock.metal, before.game.stock.metal + 123);
    assert.equal(migrated.pending.metal, 555);
    assert.equal(store.publicTotals().metal, totals.metal + 123);
    assert.equal(store.publicTotals().dollars, totals.dollars);
    assert.equal(migrated.revision, before.revision + 1);
    assert.deepEqual(migrated.workforce, before.workforce);
    assert.deepEqual(migrated.receipt, before.receipt);
    assert.equal(migrated.game.dollars, before.game.dollars);
    assert.equal(migrated.fthg, before.fthg);
    store.close(); store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, session => session.account), migrated);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('old unversioned crews credit completed whole output during migration and never consume fractional storage room', () => {
  const account = colony(), beforeMoney = account.game.dollars;
  account.game.stock.wood = 0; account.pending.wood = 123;
  delete account.playabilityVersion;
  account.workforce = { crews: { wood: { workers: 3, weeklyYield: 90, weeklyMetalCost: 0, readyAt: account.updatedAt - worldWeekMs } },
    expedition: null };
  migrateEconomy(account, account.updatedAt);
  assert.equal(account.game.stock.wood, 99);
  assert.equal(account.pending.wood, 123);
  assert.equal(account.game.dollars, beforeMoney);
  const request = { ...emptyAllocation(), wood: 5 };
  const plan = fundAllocation(account.game, { ...emptyAllocation(), wood: 123 / 60000 }, 100,
    request, resourceAccess(account.game), 0, 0);
  assert.equal(plan.crews.wood, 0);
  assert.equal(plan.dollars, beforeMoney);
});
