import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccount, accrue, apply, execute, parseCommand, snapshot } from './economy.ts';
import { investigationItem, inventory, collectFinds } from './inventory.ts';
import { worldDayMs, worldWeekMs } from '../src/environment.ts';
import { explorationCount, explorationQuote, investigationQuote, nextExploration, nextInvestigation, workforceCounts } from '../src/workforce.ts';
import { craftableKeys, inventoryUsed } from '../src/items.ts';
import { terrainAt, terrainDetails } from '../src/engine.ts';
import { gameConsumption } from '../src/consumption.ts';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';
import { fundFixtureFromReserves, seedFixturePools } from './test-support.ts';

const start = 1000000;
function fixture() {
  const account = createAccount(start);
  account.game.stage = 0;
  account.game.population = 12;
  account.game.home = { x: 0, y: 0 };
  account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 0 };
  account.game.dollars = 10000000;
  account.game.explored = ['0,0', '1,0', '0,1', '1,1'];
  snapshot(account);
  account.workforce.automatic = false;
  account.workforce.allocation = { wood: 0, water: 0, metal: 0, oil: 0 };
  account.workforce.crews = {};
  return account;
}
test('investigation locks two residents for exactly one week, charges one tenth route price and never charts land', () => {
  const account = fixture(), before = snapshot(account);
  const command = { type: 'investigate', x: 0, y: 0 } as const;
  const quote = investigationQuote(account.game, 0, 0);
  const confirmation = gameConsumption(before, command)!;
  assert.equal(quote.dollars, explorationQuote(account.game, 0, 0).dollars / 10);
  assert.ok(quote.dollars >= .1);
  assert.equal(confirmation.residents, 2); assert.equal(confirmation.weeks, 1);
  assert.equal(confirmation.days, undefined);
  assert.deepEqual(confirmation.costs, [{ asset: 'dollars', amount: quote.dollars }]);
  execute(account, command);
  const team = account.workforce.expeditions[0];
  assert.equal(team.kind, 'investigate'); assert.equal(team.workers, 2);
  assert.equal(team.startedAt, start);
  assert.equal(team.readyAt, start + worldWeekMs);
  assert.equal(team.surveyRadius, 0);
  assert.equal(snapshot(account).availableWorkers, 10);
  assert.equal(account.game.dollars, before.game.dollars - quote.dollars * 10000);
  assert.equal(explorationCount(account.workforce.expeditions), 1);
  const next = nextExploration(account.game, account.workforce.expeditions)!;
  assert.equal(next.dollars, explorationQuote(account.game, next.x, next.y).dollars * 2);
  const savedFind = team.itemFind;
  accrue(account, team.readyAt - 1);
  assert.equal(account.workforce.expeditions.length, 1);
  const restored = JSON.parse(JSON.stringify(account)) as typeof account;
  assert.equal(restored.workforce.expeditions[0].itemFind, savedFind);
  accrue(restored, team.readyAt);
  assert.equal(restored.workforce.expeditions.length, 0);
  assert.equal(snapshot(restored).availableWorkers, 12);
  assert.deepEqual(restored.game.explored, before.game.explored);
  assert.equal(restored.game.contribution, before.game.contribution);
  assert.equal(restored.game.position.x, before.game.position.x);
  assert.equal(restored.game.position.y, before.game.position.y);
  assert.equal(inventoryUsed(inventory(restored)), savedFind ? 1 : 0);
  const returned = structuredClone(restored.inventory);
  accrue(restored, team.readyAt + 1);
  assert.deepEqual(restored.inventory, returned);
  execute(restored, command);
  assert.equal(restored.workforce.expeditions.length, 1);
});
test('investigation uses only idle workers and known reachable unoccupied destinations', () => {
  const account = fixture();
  account.workforce.crews.wood = { workers: 11, readyAt: start + worldWeekMs, weeklyYield: 0, weeklyMetalCost: 0 };
  const destination = nextInvestigation(account.game)!;
  assert.ok(account.game.explored.includes(`${destination.x},${destination.y}`));
  assert.throws(() => execute(account, { type: 'investigate', x: destination.x, y: destination.y }), /two available residents/);
  account.workforce.crews.wood.workers = 10;
  execute(account, { type: 'investigate', x: destination.x, y: destination.y });
  assert.equal(workforceCounts(account.game.population, account.workforce).available, 0);
  const alternative = nextInvestigation(account.game, account.workforce.expeditions)!;
  assert.notDeepEqual([alternative.x, alternative.y], [destination.x, destination.y]);
  assert.throws(() => execute(account, { type: 'investigate', x: alternative.x, y: alternative.y }), /two available residents/);
  assert.throws(() => execute(account, { type: 'investigate', x: destination.x, y: destination.y }), /already exploring/);
  assert.throws(() => execute(account, { type: 'investigate', x: 3, y: 0 }), /discovered terrain/);
  account.game.explored.push('100,100');
  assert.throws(() => execute(account, { type: 'investigate', x: 100, y: 100 }), /beyond your reach/);
  account.game.explored = [`${destination.x},${destination.y}`];
  assert.equal(nextInvestigation(account.game, account.workforce.expeditions), null);
});
test('investigation rolls have exactly 10 percent item chance and 90/10 low-tier weights for every terrain', () => {
  for (const terrain of Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]) {
    let successes = 0, oneWeek = 0, fourWeek = 0;
    for (let chance = 0; chance < 100; chance++) {
      const item = investigationItem(terrain, chance, 0, 0);
      if (item) successes++;
    }
    for (let tier = 0; tier < 100; tier++) for (const category of [0, 99]) {
      const item = investigationItem(terrain, 0, tier, category)!;
      assert.match(item, /^(collection|activity)-.+-(1|4)$/);
      if (item.endsWith('-1')) oneWeek++; else fourWeek++;
    }
    assert.equal(successes, 10); assert.equal(oneWeek, 180); assert.equal(fourWeek, 20);
  }
  for (const roll of [-1, 100, .5, NaN]) assert.throws(() => investigationItem('forest', roll, 0, 0), /Invalid investigation rolls/);
});
test('full storage retains new investigation stacks as pending until a distinct slot opens', () => {
  const account = fixture(), bag = inventory(account);
  bag.items = craftableKeys.filter(id => id !== 'collection-wood-1').slice(0, 20);
  execute(account, { type: 'investigate', x: 0, y: 0 });
  const team = account.workforce.expeditions[0];
  team.itemFind = 'collection-wood-1';
  accrue(account, team.readyAt);
  assert.equal(inventoryUsed(bag), 20);
  assert.deepEqual(bag.pending, ['collection-wood-1']);
  bag.items.pop();
  collectFinds(account);
  assert.equal(bag.items.at(-1), 'collection-wood-1');
  assert.equal(inventoryUsed(bag), 20); assert.deepEqual(bag.pending, []);
});
test('investigation validates commands, founding, shortages and affordability without dispatching jobs', () => {
  const valid = { type: 'investigate', x: 0, y: 0 } as const;
  assert.deepEqual(parseCommand(valid), valid);
  for (const command of [{ ...valid, x: .5 }, { ...valid, y: 1000001 }, { type: 'investigate' }, { ...valid, itemFind: 'collection-wood-1' }])
    assert.throws(() => parseCommand(command), /Invalid command/);
  const account = fixture();
  account.game.stage = -1;
  assert.throws(() => execute(account, valid), /before investigating/);
  account.game.stage = 0; account.game.stock.water = 0;
  assert.throws(() => execute(account, valid), /Restore Water/);
  account.game.stock.water = 100000; account.game.dollars = 0;
  assert.throws(() => execute(account, valid), /FTH\$/);
  assert.deepEqual(account.workforce.expeditions, []);
});
test('investigation and normal exploration share exponential fees and finish at their own deadlines', () => {
  const account = fixture();
  execute(account, { type: 'investigate', x: 0, y: 0 });
  const destination = nextExploration(account.game, account.workforce.expeditions)!;
  const before = account.game.dollars;
  execute(account, { type: 'move', x: destination.x, y: destination.y });
  assert.equal(before - account.game.dollars, explorationQuote(account.game, destination.x, destination.y, 1).dollars * 10000);
  assert.equal(snapshot(account).availableWorkers, 8);
  const normal = account.workforce.expeditions.find(team => team.kind !== 'investigate')!;
  assert.equal(normal.readyAt, start + terrainDetails[terrainAt(destination.x, destination.y, account.game.seed)].weeks * worldWeekMs);
  accrue(account, start + worldDayMs);
  assert.equal(account.workforce.expeditions.length, 2);
  assert.equal(snapshot(account).availableWorkers, 8);
  accrue(account, normal.readyAt);
  assert.equal(account.workforce.expeditions.length, 0);
  assert.ok(account.game.explored.length > 4);
});
test('investigations do not block automated exploration or take over its return deadline', () => {
  const account = fixture();
  execute(account, { type: 'investigate', x: 0, y: 0 });
  inventory(account).items.push('activity-exploration-4');
  execute(account, { type: 'activate-activity', item: 'activity-exploration-4' });
  accrue(account, start);
  assert.equal(account.workforce.expeditions.length, 2);
  const normal = account.workforce.expeditions.find(team => team.kind !== 'investigate')!;
  assert.equal(account.activityAutomation!.exploration.nextAt, normal.readyAt);
  accrue(account, start + worldDayMs);
  assert.equal(account.workforce.expeditions.length, 2);
  assert.equal(account.activityAutomation!.exploration.nextAt, normal.readyAt);
});
test('mixed field teams charge shared 1x, 2x, 4x, 8x fees identically in previews and execution', () => {
  const account = fixture();
  for (let active = 0; active < 4; active++) {
    const before = snapshot(account);
    const destination = active % 2 ? nextExploration(account.game, account.workforce.expeditions)!
      : nextInvestigation(account.game, account.workforce.expeditions)!;
    const command = { type: active % 2 ? 'move' : 'investigate', x: destination.x, y: destination.y } as const;
    const base = command.type === 'move' ? explorationQuote(account.game, command.x, command.y).dollars
      : investigationQuote(account.game, command.x, command.y).dollars;
    assert.equal(destination.dollars, base * 2 ** active);
    const confirmation = gameConsumption(before, command)!;
    assert.deepEqual(confirmation.costs, [{ asset: 'dollars', amount: destination.dollars }]);
    execute(account, command, start + active * 2000);
    assert.equal(before.game.dollars - account.game.dollars, destination.dollars * 10000);
    assert.equal(explorationCount(account.workforce.expeditions), active + 1);
  }
  const firstReturn = account.workforce.expeditions[0].readyAt;
  accrue(account, firstReturn);
  const remaining = account.workforce.expeditions.length;
  const next = nextInvestigation(account.game, account.workforce.expeditions)!;
  assert.equal(next.dollars, investigationQuote(account.game, next.x, next.y).dollars * 2 ** remaining);
});
test('already-paid legacy investigations keep their one resident and one-day deadline', () => {
  const account = fixture();
  account.workforce.expeditions.push({ kind: 'investigate', x: 0, y: 0, workers: 1,
    readyAt: start + worldDayMs, surveyRadius: 0, itemFind: 'collection-wood-1' });
  assert.equal(snapshot(account).availableWorkers, 11);
  accrue(account, start + worldDayMs - 1);
  assert.equal(account.workforce.expeditions[0].readyAt, start + worldDayMs);
  assert.equal(account.workforce.expeditions[0].workers, 1);
  accrue(account, start + worldDayMs);
  assert.equal(snapshot(account).availableWorkers, 12);
  assert.deepEqual(inventory(account).items, ['collection-wood-1']);
});
test('investigation departure, fee and locked finds survive database reopen and exact-once retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-investigation-')), path = join(directory, 'test.sqlite');
  let time = start, store = new SqliteStore(path, () => time);
  try {
    seedFixturePools(store);
    const identity = store.create();
    store.transaction(identity.token, session => { session.account = fixture(); });
    fundFixtureFromReserves(path, 1000);
    time += 1000;
    const request = store.read(identity.token, session => ({
      id: randomUUID(), revision: session.account.revision, command: { type: 'investigate', x: 0, y: 0 } as const,
    }));
    const dispatched = store.transaction(identity.token, (session, now) => apply(session.account, request, now));
    store.close(); store = new SqliteStore(path, () => time);
    assert.deepEqual(store.transaction(identity.token, (session, now) => apply(session.account, request, now)), dispatched);
    assert.equal(store.read(identity.token, session => session.account.workforce.expeditions.length), 1);
    time = dispatched.workforce.expeditions[0].readyAt;
    const completed = store.transaction(identity.token, (session, now) => { accrue(session.account, now); return snapshot(session.account); });
    assert.equal(completed.workforce.expeditions.length, 0);
    assert.equal(completed.inventory.items.length, dispatched.workforce.expeditions[0].itemFind ? 1 : 0);
    assert.equal(completed.dollars, dispatched.dollars);
    store.close(); store = new SqliteStore(path, () => time);
    assert.deepEqual(store.read(identity.token, session => snapshot(session.account)).inventory, completed.inventory);
  } finally {
    store.close(); rmSync(directory, { recursive: true });
  }
});
test('investigation HTTP requires CSRF and replays dispatch and locked finds exactly once', async () => {
  let time = start;
  const store = new SqliteStore(':memory:', () => time);
  const identity = store.create();
  store.transaction(identity.token, session => { session.account = fixture(); });
  const origin = 'http://127.0.0.1', server = createApi(store, origin);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
    const base = `http://127.0.0.1:${address.port}`;
    const command = { type: 'investigate', x: 0, y: 0 };
    const body = JSON.stringify({ id: randomUUID(), revision: store.read(identity.token, session => session.account.revision), command });
    const headers = { cookie: `terra-dev=${identity.token}`, origin, 'content-type': 'application/json', 'x-csrf-token': 'wrong' };
    time += 1000;
    const rejected = await fetch(`${base}/api/actions`, { method: 'POST', headers, body });
    assert.equal(rejected.status, 403);
    assert.equal(store.read(identity.token, session => session.account.workforce.expeditions.length), 0);
    headers['x-csrf-token'] = identity.csrf;
    const response = await fetch(`${base}/api/actions`, { method: 'POST', headers, body });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const retry = await fetch(`${base}/api/actions`, { method: 'POST', headers, body });
    assert.equal(retry.status, 200);
    const replay = await retry.json();
    assert.equal(replay.dollars, result.dollars);
    assert.deepEqual(replay.workforce.expeditions, result.workforce.expeditions);
    assert.equal(store.read(identity.token, session => session.account.workforce.expeditions.length), 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
