import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { accrue, apply, createAccount, migrateEconomy, parseCommand, snapshot } from './economy.ts';
import { defaultClockSpeed, claimCooldownMs, worldWeekMs } from '../src/environment.ts';
import type { Command } from '../src/api-types.ts';
import { SqliteStore } from './store.ts';
import { DatabaseSync } from 'node:sqlite';
import { worldEpoch } from '../src/environment.ts';

test('registration and offline time never grant resources, Dollar or Gold', () => {
  const account = createAccount(1000000);
  const before = structuredClone(account.game);
  accrue(account, 1000000 + 100 * worldWeekMs);
  assert.deepEqual(account.game.stock, { wood: 0, water: 0, metal: 0, oil: 0 });
  assert.equal(account.game.dollars, 0); assert.equal(account.fthg, 0);
  assert.deepEqual(account.pending, { wood: 0, water: 0, metal: 0, oil: 0 });
  assert.equal(account.game.population, before.population);
});
test('zero-resource players can gather only founding materials and establish without receiving Dollar', () => {
  const account = createAccount(1000000);
  const act = (command: Command) => apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 500);
  assert.throws(() => act({ type: 'upgrade' }), /Not enough resources/);
  act({ type: 'gather' }); assert.equal(account.game.stock.wood, 35);
  const id = randomUUID(), revision = account.revision;
  const request = { id, revision, command: { type: 'gather' } };
  apply(account, request, account.updatedAt + 500);
  apply(account, request, account.updatedAt + 500);
  assert.equal(account.game.stock.wood, 60, 'gather retries cannot award twice');
  assert.throws(() => act({ type: 'gather' }), /enough/);
  act({ type: 'move', x: 3, y: 0 }); act({ type: 'gather' }); act({ type: 'gather' });
  assert.equal(account.game.stock.water, 40);
  assert.throws(() => act({ type: 'upgrade' }), /dry land/);
  act({ type: 'move', x: 0, y: 0 }); act({ type: 'upgrade' });
  assert.equal(account.game.stage, 0); assert.equal(account.game.population, 12);
  assert.deepEqual(account.game.stock, { wood: 0, water: 0, metal: 0, oil: 0 });
  assert.equal(account.game.dollars, 0);
  assert.throws(() => act({ type: 'gather' }), /resident crews/);
  assert.ok(snapshot(account).rates.water > 0, 'Water crews can start from zero without upfront Dollar');
});
test('gathering rejects forged fields and non-founding materials without granting stock', () => {
  assert.deepEqual(parseCommand({ type: 'gather' }), { type: 'gather' });
  assert.throws(() => parseCommand({ type: 'gather', resource: 'metal' }), /fields/);
  const account = createAccount(1000000);
  account.game.position = { x: 0, y: 3 };
  assert.throws(() => apply(account, { id: randomUUID(), revision: 0, command: { type: 'gather' } }, account.updatedAt + 500), /known Wood or Water/);
  assert.deepEqual(account.game.stock, { wood: 0, water: 0, metal: 0, oil: 0 });
});
test('continuous clock closes one week in exactly five real minutes with integer timestamps', t => {
  let realTime = 1000000;
  const store = new SqliteStore(':memory:', () => realTime, defaultClockSpeed);
  t.after(() => store.close());
  const session = store.create();
  const first = store.read(session.token, (_session, now) => now);
  assert.equal(worldWeekMs / defaultClockSpeed, 300000);
  realTime++;
  assert.equal(store.read(session.token, (_session, now) => now) - first, 33);
  realTime += 299998;
  assert.ok(store.read(session.token, (_session, now) => now) - first < worldWeekMs);
  realTime++;
  assert.equal(store.read(session.token, (_session, now) => now) - first, worldWeekMs);
  assert.equal(claimCooldownMs, 500);
});
test('existing owned resources and earned balances are not zeroed during migration', () => {
  const account = createAccount(1000000);
  account.game.stock = { wood: 120, water: 2000, metal: 50, oil: 5 };
  account.game.dollars = 1200; account.fthg = 300;
  const before = structuredClone(account.game);
  migrateEconomy(account, account.updatedAt);
  assert.deepEqual(account.game, before); assert.equal(account.fthg, 300);
});
test('a saved 168x clock migrates to five-minute weeks without rewinding its timeline', t => {
  const exec = DatabaseSync.prototype.exec;
  let db: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (!db) {
      db = this;
      exec.call(this, 'CREATE TABLE server_clock(id INTEGER PRIMARY KEY,realTime INTEGER NOT NULL,serverTime INTEGER NOT NULL,speed INTEGER NOT NULL CHECK(speed IN (1,10,20,168)))');
      this.prepare('INSERT INTO server_clock VALUES(1,?,?,168)').run(1000000, worldEpoch);
    }
    return exec.call(this, sql);
  });
  let now = 1000123;
  const store = new SqliteStore(':memory:', () => now, defaultClockSpeed);
  t.after(() => store.close());
  const session = store.create(), first = store.read(session.token, (_session, time) => time);
  assert.equal(first, worldEpoch + 123 * 168);
  assert.equal(db!.prepare('SELECT speed FROM server_clock').get()!.speed, 33.6);
  now++;
  assert.equal(store.read(session.token, (_session, time) => time), first + 33);
  now += 299999;
  assert.equal(store.read(session.token, (_session, time) => time), first + worldWeekMs);
});
test('restarting a fractional-speed clock counts offline milliseconds without fractional timestamps', t => {
  const exec = DatabaseSync.prototype.exec;
  let seeded = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (!seeded) {
      seeded = true;
      exec.call(this, 'CREATE TABLE server_clock(id INTEGER PRIMARY KEY,realTime INTEGER NOT NULL,serverTime INTEGER NOT NULL,speed REAL NOT NULL CHECK(speed IN (1,10,20,168,33.6)))');
      this.prepare('INSERT INTO server_clock VALUES(1,?,?,33.6)').run(1000000, worldEpoch);
    }
    return exec.call(this, sql);
  });
  let now = 1000001;
  const store = new SqliteStore(':memory:', () => now, defaultClockSpeed);
  t.after(() => store.close());
  const session = store.create();
  assert.equal(store.read(session.token, (_session, time) => time), worldEpoch + 33);
  now--;
  assert.equal(store.read(session.token, (_session, time) => time), worldEpoch + 33);
});
