import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { accrue, apply, createAccount, migratePhysicalEconomy, snapshot } from './economy.ts';
import { SqliteStore } from './store.ts';
import { automateFixtureCollections, fundFixtureFromReserves } from './test-support.ts';
import { seasonMs, worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { dollarsScale } from '../src/dollars.ts';
import { emptyAllocation, resourceAccess, resourceCapacity, resourceWorkRoom } from '../src/workforce.ts';
import type { Command } from '../src/api-types.ts';

test('daily polling and annual offline catch-up preserve climate jobs, paid arrivals, locked finds and transport', () => {
  const start = worldEpoch + seasonMs - 3 * worldDayMs, account = createAccount(start);
  account.game.seed = 1542;
  account.game.dollars = 1000000 * dollarsScale;
  const act = (command: Command, time: number) => apply(account, { id: randomUUID(), revision: account.revision, command }, time);
  act({ type: 'upgrade' }, start);
  account.warehouse = 2;
  account.game.explored = ['0,0', '-3,0', '3,0', '0,3'];
  account.game.stock = { ...emptyAllocation(), water: 3000 };
  account.workforce!.automatic = false;
  account.workforce!.crews = {};
  account.workforce!.allocation = { wood: 2, water: 2, metal: 1, oil: 0 };
  automateFixtureCollections(account);
  act({ type: 'home' }, start + 1000);
  act({ type: 'invite' }, start + 2000);
  act({ type: 'move', x: 5, y: 0 }, start + 3000);
  const arrivals = account.recruitment!.population, finds = structuredClone(account.workforce!.expeditions[0].finds);
  assert.ok(finds);
  const online = structuredClone(account), offline = structuredClone(account);
  for (let day = 1; day <= 364; day++) accrue(online, start + day * worldDayMs);
  accrue(offline, start + 364 * worldDayMs);
  assert.deepEqual(offline, online);
  assert.equal(offline.game.population, 12 + arrivals);
  assert.ok(offline.game.stock.wood > 0 && offline.game.stock.metal > 0);
  assert.ok(offline.game.dollars < account.game.dollars);
  assert.equal(offline.workforce!.expeditions.length, 0);
});

test('Water refill forecasts never consume unclaimed inventory or create endless full-storage work', () => {
  const account = createAccount(worldEpoch);
  account.game.stage = 0; account.game.population = 12;
  account.game.stock.water = 0;
  const access = resourceAccess(account.game, worldEpoch).water, cap = resourceCapacity(100, 'water', account.game);
  assert.equal(resourceWorkRoom(100, 'water', account.game, cap, access), 0);
  account.game.stock.water = cap;
  assert.equal(resourceWorkRoom(100, 'water', account.game, 0, access), access.weeklyConsumption);
  account.game.stock.water = 10;
  assert.equal(resourceWorkRoom(100, 'water', account.game, cap - 10, access), 10);
  account.game.stock.water = 0;
  account.pending.water = cap * 60000 - 1;
  account.workforce!.automatic = false;
  account.workforce!.allocation = { ...emptyAllocation(), water: 1 };
  account.workforce!.crews = {};
  account.workforce!.cycleAt = worldEpoch;
  const started = performance.now();
  accrue(account, worldEpoch + 1000000 * worldWeekMs);
  assert.ok(performance.now() - started < 1000);
  assert.equal(account.pending.water, cap * 60000 - 1);
  assert.deepEqual(account.workforce!.crews, {});
});

test('physical migration is idempotent and preserves balances, fractional pending, locked jobs and receipts', () => {
  const account = createAccount(worldEpoch);
  account.pending.wood = 123;
  account.workforce!.crews.wood = { workers: 2, weeklyYield: 42, weeklyMetalCost: 0, readyAt: worldEpoch + worldWeekMs };
  delete account.physicalVersion; delete account.physicalStartedAt;
  const before = structuredClone(account);
  migratePhysicalEconomy(account, worldEpoch + worldDayMs);
  assert.equal(account.physicalVersion, 1);
  assert.equal(account.physicalStartedAt, worldEpoch + worldDayMs);
  const normalized = structuredClone(account);
  delete normalized.physicalVersion; delete normalized.physicalStartedAt;
  normalized.revision--;
  assert.deepEqual(normalized, before);
  const migrated = structuredClone(account);
  migratePhysicalEconomy(account, worldEpoch + 2 * worldDayMs);
  assert.deepEqual(account, migrated);
});

test('persistent physical migration preserves every financial table, ownership, escrow and action receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-physical-')), path = join(directory, 'test.sqlite');
  let time = worldEpoch;
  let store: SqliteStore | undefined = new SqliteStore(path, () => time, 20);
  let db: DatabaseSync | undefined;
  try {
    const identity = store.create();
    store.transaction(identity.token, (session, now) => apply(session.account,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'upgrade' } }, now));
    store.transaction(identity.token, session => { session.account.game.dollars = 1000 * dollarsScale; });
    fundFixtureFromReserves(path, 1000);
    time += 1000;
    store.transaction(identity.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session,
      { id: randomUUID(), revision: session.account.revision,
        command: { type: 'limit', asset: 'wood', side: 'sell', quantity: 10, price: 1000 } }, now, realTime));
    store.close();
    store = undefined;
    db = new DatabaseSync(path);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    for (const row of db.prepare('SELECT id,data FROM sessions').all()) {
      const session = JSON.parse(String(row.data));
      delete session.account.physicalVersion; delete session.account.physicalStartedAt;
      db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), String(row.id));
    }
    const read = () => Object.fromEntries(tables.map(table => [table, db!.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
    const before = read();
    db.close();
    db = undefined;
    store = new SqliteStore(path, () => time, 20);
    store.close();
    store = undefined;
    db = new DatabaseSync(path);
    const after = read();
    for (let index = 0; index < after.sessions.length; index++) {
      const saved = JSON.parse(String(before.sessions[index].data)), migrated = JSON.parse(String(after.sessions[index].data));
      assert.equal(migrated.account.physicalVersion, 1);
      assert.equal(migrated.account.physicalStartedAt, worldEpoch + 20000);
      delete migrated.account.physicalVersion; delete migrated.account.physicalStartedAt;
      migrated.account.revision--;
      assert.deepEqual(migrated, saved);
      after.sessions[index].data = before.sessions[index].data;
    }
    assert.equal(after.server_clock[0].speed, 20);
    assert.equal(after.server_clock[0].serverTime, worldEpoch + 20000);
    assert.equal(after.server_clock[0].realTime, time);
    after.server_clock = before.server_clock;
    assert.deepEqual(after, before);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    db.close();
    db = undefined;
    store = new SqliteStore(path, () => time, 20);
    assert.equal(store.read(identity.token, session => snapshot(session.account).physicalVersion), 1);
  } finally { db?.close(); store?.close(); rmSync(directory, { recursive: true }); }
});
