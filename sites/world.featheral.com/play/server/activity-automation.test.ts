import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accrue, apply, migrateClock, snapshot } from './economy.ts';
import { createFundedFixtureAccount as createAccount } from './test-support.ts';
import { SqliteStore } from './store.ts';
import { fundFixtureFromReserves } from './test-support.ts';
import { inventory } from './inventory.ts';
import { activityItems, activityItemName } from '../src/automation.ts';
import { gameConsumption } from '../src/consumption.ts';
import { recruitmentDollars } from '../src/engine.ts';
import { worldDayMs, worldWeekMs } from '../src/environment.ts';
import { dollarsScale } from '../src/dollars.ts';
import { translate } from '../src/i18n.ts';
import type { Command } from '../src/api-types.ts';

const start = 1000000;
function fixture() {
  const account = createAccount(start);
  apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'upgrade' } }, start);
  account.game.stock.water = 1000000000000;
  account.game.dollars = 1000000 * dollarsScale;
  inventory(account).items.push(...activityItems);
  return account;
}
function act(account: ReturnType<typeof fixture>, command: Command) {
  return apply(account, { id: randomUUID(), revision: account.revision, command }, account.updatedAt + 1000);
}
test('activity items share durations, Korean names, consumable confirmation and durable retries', () => {
  for (const item of activityItems) {
    assert.notEqual(translate(activityItemName(item), 'ko'), activityItemName(item));
    const account = fixture(), body = { id: randomUUID(), revision: account.revision, command: { type: 'activate-activity', item } as const };
    const quote = gameConsumption(snapshot(account), body.command)!;
    assert.deepEqual(quote.costs, [{ asset: item, amount: 1 }]);
    const result = apply(account, body, account.updatedAt + 1000), saved = structuredClone(account);
    assert.ok(!result.inventory.items.includes(item));
    assert.deepEqual(apply(account, body, account.updatedAt + 2000), result);
    assert.deepEqual(account, saved);
  }
});
test('auto exploration keeps one team, pays normal fees and completes paid work after expiry', () => {
  const account = fixture(), before = snapshot(account);
  const activated = act(account, { type: 'activate-activity', item: 'activity-exploration-1' });
  assert.equal(activated.workforce.expeditions.length, 1);
  assert.ok(activated.dollars < before.dollars);
  const expedition = activated.workforce.expeditions[0], dollars = account.game.dollars;
  accrue(account, expedition.readyAt - 1);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
  assert.equal(account.game.dollars, dollars);
  accrue(account, expedition.readyAt);
  assert.equal(snapshot(account).workforce.expeditions.length, 0);
  assert.equal(account.game.dollars, dollars);
  assert.equal(snapshot(account).activityAutomation!.exploration.reason, 'Inactive');
});
test('auto recruitment pays each batch once, respects housing fees and stops new work at expiry', () => {
  const account = fixture();
  account.game.constructionLevels = { housing: 4 };
  const cost = recruitmentDollars(account.game.population, 4, account.updatedAt + 1000), before = account.game.dollars;
  const activated = act(account, { type: 'activate-activity', item: 'activity-attraction-1' });
  assert.equal(activated.game.population, 12);
  assert.equal(activated.recruitment!.population, cost / 50);
  assert.equal(account.game.dollars, before - cost * dollarsScale);
  accrue(account, activated.recruitment!.readyAt - 1);
  assert.equal(account.game.population, 12);
  accrue(account, activated.recruitment!.readyAt);
  assert.equal(account.game.population, 12 + cost / 50);
  assert.equal(account.recruitment, null);
  assert.equal(account.game.dollars, before - cost * dollarsScale);
});
test('blocked automation reports its reason, retries daily and pauses without cancelling paid jobs', () => {
  const account = fixture();
  account.game.dollars = 0;
  const activated = act(account, { type: 'activate-activity', item: 'activity-attraction-4' });
  assert.equal(activated.recruitment, null);
  assert.equal(activated.activityAutomation!.attraction.reason, 'Not enough FTH$ for recruitment.');
  assert.equal(activated.activityAutomation!.attraction.nextAt, activated.serverTime + worldDayMs);
  account.game.dollars = 10000 * dollarsScale;
  accrue(account, activated.serverTime + worldDayMs);
  assert.ok(account.recruitment);
  const paid = structuredClone(account.recruitment), money = account.game.dollars;
  act(account, { type: 'activity-automation', activity: 'attraction', enabled: false });
  assert.deepEqual(account.recruitment, paid);
  accrue(account, paid!.readyAt);
  assert.equal(account.recruitment, null);
  assert.equal(account.game.dollars, money);
  assert.equal(snapshot(account).activityAutomation!.attraction.reason, 'Automation paused');
});
test('automation stacking, offline catch-up and fee deductions are polling-invariant and bounded', () => {
  const account = fixture();
  act(account, { type: 'activate-activity', item: 'activity-exploration-4' });
  const until = account.activityAutomation!.exploration.until;
  inventory(account).items.push('activity-exploration-1');
  act(account, { type: 'activate-activity', item: 'activity-exploration-1' });
  assert.equal(account.activityAutomation!.exploration.until, until + worldWeekMs);
  act(account, { type: 'activate-activity', item: 'activity-attraction-4' });
  const once = structuredClone(account), frequent = structuredClone(account), money = account.game.dollars;
  for (let i = 1; i <= 100; i++) accrue(frequent, account.updatedAt + Math.floor(12 * worldWeekMs * i / 100));
  accrue(once, account.updatedAt + 12 * worldWeekMs);
  assert.deepEqual(once, frequent);
  assert.ok(once.game.dollars < money);
  assert.equal(once.workforce && 'expeditions' in once.workforce ? once.workforce.expeditions.length : -1, 0);
  const began = performance.now();
  accrue(once, account.updatedAt + 1000000 * worldWeekMs);
  assert.ok(performance.now() - began < 1000);
});
test('housing-adjusted affordability and Water shortages pause rather than throwing during accrual', () => {
  const account = fixture();
  account.game.constructionLevels = { housing: 4 };
  account.game.dollars = 1000 * dollarsScale;
  act(account, { type: 'activate-activity', item: 'activity-attraction-4' });
  assert.equal(account.recruitment, null);
  accrue(account, account.updatedAt + worldDayMs);
  assert.equal(snapshot(account).activityAutomation!.attraction.reason, 'Not enough FTH$ for recruitment.');
  account.game.stock.water = 0;
  act(account, { type: 'activate-activity', item: 'activity-exploration-4' });
  assert.equal(snapshot(account).workforce.expeditions.length, 0);
  assert.equal(snapshot(account).activityAutomation!.exploration.reason, 'Restore Water supplies before starting advanced activity.');
  account.game.stock.water = 1000000;
  const nextAt = account.activityAutomation!.exploration.nextAt;
  accrue(account, nextAt - 1);
  assert.equal(snapshot(account).workforce.expeditions.length, 0);
  accrue(account, nextAt);
  assert.equal(snapshot(account).workforce.expeditions.length, 1);
});
test('resuming preserves expiry, waits for the current batch and then starts the next one', () => {
  const account = fixture();
  const first = act(account, { type: 'activate-activity', item: 'activity-attraction-4' });
  act(account, { type: 'activity-automation', activity: 'attraction', enabled: false });
  const resume = { type: 'activity-automation', activity: 'attraction', enabled: true } as const;
  assert.ok(gameConsumption(snapshot(account), resume));
  const resumed = act(account, resume);
  assert.equal(resumed.activityAutomation!.attraction.until, first.activityAutomation!.attraction.until);
  assert.equal(resumed.activityAutomation!.attraction.nextAt, first.recruitment!.readyAt);
  const population = 12 + first.recruitment!.population;
  const cost = recruitmentDollars(population, 0, first.recruitment!.readyAt), dollars = account.game.dollars;
  accrue(account, first.recruitment!.readyAt);
  assert.equal(account.game.population, population);
  assert.equal(account.game.dollars, dollars - cost * dollarsScale);
  assert.equal(account.recruitment!.readyAt, first.recruitment!.readyAt + worldWeekMs);
});
test('clock migration shifts automation deadlines without changing remaining work or item duration', () => {
  const account = fixture();
  act(account, { type: 'activate-activity', item: 'activity-exploration-4' });
  act(account, { type: 'activate-activity', item: 'activity-attraction-4' });
  const old = structuredClone(account), shift = 100000000;
  migrateClock(account, account.updatedAt, account.updatedAt + shift);
  for (const activity of ['exploration', 'attraction'] as const) {
    assert.equal(account.activityAutomation![activity].until, old.activityAutomation![activity].until + shift);
    assert.equal(account.activityAutomation![activity].nextAt, old.activityAutomation![activity].nextAt + shift);
  }
  assert.equal(account.recruitment!.readyAt, old.recruitment!.readyAt + shift);
  assert.equal(snapshot(account).workforce.expeditions[0].readyAt, snapshot(old).workforce.expeditions[0].readyAt + shift);
  assert.equal(account.game.dollars, old.game.dollars);
});
test('automation and its receipt survive restart, with no duplicate item consumption, fees or census arrivals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-activity-')), path = join(directory, 'test.sqlite');
  let now = start, store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path, () => now);
    const user = store.create();
    store.transaction(user.token, session => {
      apply(session.account, { id: randomUUID(), revision: session.account.revision, command: { type: 'upgrade' } }, now);
      session.account.game.dollars = 10000 * dollarsScale;
      session.account.game.stock.water = 1000000000;
      inventory(session.account).items.push('activity-attraction-1');
    });
    fundFixtureFromReserves(path, 10000);
    now += 1000;
    const body = { id: randomUUID(), revision: store.read(user.token, session => session.account.revision),
      command: { type: 'activate-activity', item: 'activity-attraction-1' } as const };
    const result = store.transaction(user.token, session => apply(session.account, body, now));
    const supply = store.publicTotals().dollars;
    store.close(); store = new SqliteStore(path, () => now);
    assert.deepEqual(store.transaction(user.token, session => apply(session.account, body, now)), result);
    assert.equal(store.publicTotals().dollars, supply);
    now = result.recruitment!.readyAt;
    store.transaction(user.token, session => accrue(session.account, now));
    assert.equal(store.population(null).global, 12 + result.recruitment!.population);
    assert.equal(store.publicTotals().dollars, supply);
    store.close(); store = new SqliteStore(path, () => now);
    store.transaction(user.token, session => accrue(session.account, now));
    assert.equal(store.population(null).global, 12 + result.recruitment!.population);
    assert.equal(store.read(user.token, session => session.account.recruitment), null);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
