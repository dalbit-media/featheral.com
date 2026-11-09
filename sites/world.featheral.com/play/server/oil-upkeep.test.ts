import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { accrue, apply, createAccount, initializeUpkeep, snapshot } from './economy.ts';
import { worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { oilConsumptionPerResident, settlementConsumptionForDays } from '../src/upkeep.ts';
import { resourceForecastPanel } from '../src/resource-forecast.ts';
import { translate } from '../src/i18n.ts';
import { SqliteStore } from './store.ts';

function settled(stage: number, population = 1000) {
  const account = createAccount(worldEpoch);
  account.game.stage = stage;
  account.game.population = population;
  account.game.home = { ...account.game.position };
  account.game.stock = { wood: 1000000, water: 10000000, metal: 1000000, oil: 100000 };
  account.game.dollars = 1000000000;
  account.workforce!.automatic = false;
  initializeUpkeep(account, worldEpoch);
  return account;
}

test('oil starts at Town and doubles every tier through Capital independently of climate and buildings', () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, stage) => oilConsumptionPerResident(stage)),
    [0, 0, 0, 0, .001, .002, .004, .008, .016]);
  for (let stage = 0; stage <= 8; stage++) {
    const account = settled(stage), expected = 1000 * oilConsumptionPerResident(stage);
    account.game.townhall = false;
    assert.equal(snapshot(account).settlementUpkeep!.resources.oil.dailyConsumption, expected);
    assert.equal(settlementConsumptionForDays('oil', 1000, worldEpoch, 7, stage), expected * 7);
    assert.equal(settlementConsumptionForDays('oil', 1000, worldEpoch + 100 * worldDayMs, 7, stage), expected * 7);
    const before = account.game.stock.oil;
    accrue(account, worldEpoch + worldDayMs);
    assert.equal(account.game.stock.oil, before - expected);
    assert.equal(snapshot(account).settlementUpkeep!.resources.oil.shortage, 0);
  }
});
test('oil carries fractional barrels exactly and offline bills match daily processing across population and downgrade boundaries', () => {
  const online = settled(8, 100), offline = structuredClone(online), initial = online.game.stock.oil;
  for (let day = 1; day <= 56; day++) accrue(online, worldEpoch + day * worldDayMs);
  accrue(offline, worldEpoch + 56 * worldDayMs);
  assert.deepEqual(offline, online);
  assert.ok(initial > offline.game.stock.oil);
  assert.ok(Number.isSafeInteger(offline.game.stock.oil));
  assert.ok(offline.game.stage < 8);
  const before = structuredClone(offline);
  accrue(offline, offline.updatedAt);
  assert.deepEqual(offline, before);
  const fractional = settled(4, 12);
  accrue(fractional, worldEpoch + worldDayMs);
  assert.equal(fractional.game.stock.oil, 100000);
  assert.equal(fractional.settlementUpkeep!.remainder.oil, 120);
});
test('legacy saves never back-bill Oil, preserving previous heating and repair deadlines and pending output', () => {
  const account = settled(7, 25000);
  delete account.settlementUpkeep!.oilStartedAt;
  delete account.settlementUpkeep!.remainder.oil;
  account.pending.oil = 123 * 60000;
  const now = worldEpoch + 20 * worldDayMs;
  initializeUpkeep(account, now);
  assert.equal(account.settlementUpkeep!.readyAt, worldEpoch + worldDayMs);
  assert.equal(account.settlementUpkeep!.oilStartedAt, now + worldDayMs);
  accrue(account, now);
  assert.equal(account.game.stock.oil, 100000);
  assert.equal(account.pending.oil, 123 * 60000);
  const expected = snapshot(account).settlementUpkeep!.resources.oil.dailyConsumption;
  accrue(account, now + worldDayMs);
  assert.equal(account.game.stock.oil, 100000 - Math.floor(expected));
  assert.equal(account.settlementUpkeep!.remainder.oil, Math.round(expected * 10000) % 10000);
  const offset = settled(4);
  delete offset.settlementUpkeep!.oilStartedAt;
  const firstRead = worldEpoch + 20.5 * worldDayMs;
  accrue(offset, firstRead);
  const oilDeadline = snapshot(offset).settlementUpkeep!.resources.oil.readyAt!;
  assert.equal(oilDeadline, worldEpoch + 22 * worldDayMs);
  accrue(offset, oilDeadline - 1);
  assert.equal(offset.game.stock.oil, 100000);
  const bill = snapshot(offset).settlementUpkeep!.resources.oil.dailyConsumption;
  accrue(offset, oilDeadline);
  assert.equal(offset.game.stock.oil, 100000 - Math.floor(bill));
});
test('oil shortages block new advanced actions and count toward weekly population loss while trade and paid work remain recoverable', () => {
  const account = settled(4, 1000);
  account.game.stock.oil = 0;
  account.pending.oil = 100 * 60000;
  account.workforce!.expeditions = [{ x: 5, y: 5, workers: 2, readyAt: worldEpoch + 2 * worldWeekMs, surveyRadius: 2 }];
  account.recruitment = { population: 18, startedAt: worldEpoch, readyAt: worldEpoch + 2 * worldWeekMs };
  assert.equal(snapshot(account).settlementUpkeep!.paused, true);
  assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'invite' } }, worldEpoch + 1000), /Oil fuel supplies/);
  accrue(account, worldEpoch + worldWeekMs);
  assert.equal(account.game.population, 950);
  assert.equal(account.game.stage, 4);
  assert.equal(account.pending.oil, 100 * 60000);
  assert.equal(account.workforce!.expeditions.length, 1);
  assert.equal(account.recruitment!.population, 18);
  account.game.stock.oil = 1000;
  assert.equal(snapshot(account).settlementUpkeep!.paused, false);
  account.recruitment = null;
  apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'invite' } }, worldEpoch + worldWeekMs + 1000);
  assert.ok(account.recruitment);
});
test('Oil forecasts show authoritative demand and buy links in both languages, but stay hidden before Town', () => {
  const town = snapshot(settled(4));
  for (const language of ['en', 'ko'] as const) {
    const html = resourceForecastPanel(town, language);
    assert.equal((html.match(/class="reserve-chart"/g) ?? []).length, 4);
    assert.match(html, /href="\/market\/\?asset=oil&amp;side=buy"/);
    assert.ok(html.includes(translate('Oil', language)));
  }
  assert.equal((resourceForecastPanel(snapshot(settled(3)), 'en').match(/class="reserve-chart"/g) ?? []).length, 3);
  for (const text of ['Oil fuel', 'Oil fuel shortage', 'Buy Oil', 'Restore Oil fuel supplies before starting advanced activity.',
    'Oil consumption starts at Town and doubles each tier through Capital.'])
    assert.notEqual(translate(text, 'ko'), text);
});
test('oil activation and fractional carry persist through repeated session serialization without charging twice', () => {
  let now = worldEpoch;
  const store = new SqliteStore(':memory:', () => now), user = store.create();
  try {
    store.transaction(user.token, session => { session.account = settled(4, 12); });
    now += worldDayMs;
    store.transaction(user.token, (session, time) => { accrue(session.account, time); return snapshot(session.account); });
    const before = store.read(user.token, session => structuredClone(session.account));
    assert.equal(before.settlementUpkeep!.remainder.oil, 120);
    assert.equal(before.game.stock.oil, 100000);
    store.transaction(user.token, (session, time) => { accrue(session.account, time); return snapshot(session.account); });
    assert.deepEqual(store.read(user.token, session => session.account), before);
    now += worldDayMs;
    assert.throws(() => store.transaction(user.token, (session, time) => {
      accrue(session.account, time);
      throw new Error('Oil rollback fixture');
    }), /Oil rollback fixture/);
    assert.deepEqual(store.read(user.token, session => session.account), before);
    store.transaction(user.token, (session, time) => { accrue(session.account, time); return snapshot(session.account); });
    assert.equal(store.read(user.token, session => session.account.settlementUpkeep!.remainder.oil), 240);
  } finally { store.close(); }
});
test('Oil demand changes only for future bills after upgrades and stays below realistic weekly crew output at Capital', () => {
  const account = settled(3, 1000);
  accrue(account, worldEpoch + worldDayMs);
  assert.equal(account.game.stock.oil, 100000);
  apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'upgrade' } }, worldEpoch + worldDayMs + 1000);
  assert.equal(account.game.stage, 4);
  accrue(account, worldEpoch + 2 * worldDayMs);
  assert.equal(account.game.stock.oil, 99999);
  for (let stage = 4; stage <= 8; stage++) assert.ok(oilConsumptionPerResident(stage) * 7 < 2 * .1, 'a tenth of residents can replace Oil upkeep at base output');
});
