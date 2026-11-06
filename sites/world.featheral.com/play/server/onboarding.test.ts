import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { accrue, apply, createAccount, migrateEconomy, parseCommand, snapshot } from './economy.ts';
import { defaultClockSpeed, claimCooldownMs, worldWeekMs } from '../src/environment.ts';
import type { Command } from '../src/api-types.ts';
import { SqliteStore } from './store.ts';

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
test('faster continuous clock closes one week in exactly 60 real seconds', t => {
  let realTime = 1000000;
  const store = new SqliteStore(':memory:', () => realTime, defaultClockSpeed);
  t.after(() => store.close());
  const session = store.create();
  const first = store.read(session.token, (_session, now) => now);
  assert.equal(worldWeekMs / defaultClockSpeed, 60000);
  realTime += 59999;
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
