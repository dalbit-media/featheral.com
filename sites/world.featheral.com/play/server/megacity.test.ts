import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { accrue, createAccount, execute, initializeUpkeep, snapshot } from './economy.ts';
import { inventory } from './inventory.ts';
import { newGame, parseSave, stages, upgrade } from '../src/engine.ts';
import { dollarsUnits } from '../src/dollars.ts';
import { homeCount, settlementBuildings, settlementPositions, cellKey, validSettlementCell } from '../src/settlement-layout.ts';
import { settlementProfile, settlementScene } from '../src/settlement-scene.ts';
import { buildingArt } from '../src/building-art.ts';
import { oilConsumptionPerResident, settlementConsumptionForDays } from '../src/upkeep.ts';
import { worldDayMs, worldEpoch, worldWeekMs } from '../src/environment.ts';
import { translate } from '../src/i18n.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import type { ApiState } from '../src/api-types.ts';
import { houseHeight } from '../src/map-art.ts';
import { SqliteStore } from './store.ts';

test('seven new tiers reach exactly twenty million with increasing fees without rewriting original policy', () => {
  assert.equal(stages.length, 16);
  assert.deepEqual(stages.slice(9).map(stage => stage.name), ['Regional Hub', 'Urban Center', 'Metropolitan Region', 'World City', 'Global City', 'Megacity', 'Great Megacity']);
  assert.deepEqual(stages.slice(9).map(stage => stage.population), [250000, 500000, 1000000, 2000000, 5000000, 10000000, 20000000]);
  assert.deepEqual(stages.slice(9).map(stage => stage.cost.dollars), [1000, 2000, 3000, 4000, 5000, 15000, 40000]);
  assert.deepEqual(stages.slice(0, 9).map(stage => stage.population), [0, 25, 80, 250, 800, 2500, 10000, 25000, 100000]);
  assert.deepEqual(monetaryPolicy.stageFees, [0, 200, 300, 400, 500, 600, 700, 800, 800]);
  for (let tier = 9; tier < stages.length; tier++) {
    const account = createAccount(1000000), game = account.game, target = stages[tier];
    game.stage = tier - 1;
    game.home = { ...game.position };
    game.population = target.population - 1;
    game.stock = { wood: 1000000, water: 1000000, metal: 1000000, oil: 100000 };
    game.dollars = dollarsUnits(target.cost.dollars!);
    const before = structuredClone(game);
    assert.throws(() => upgrade(game), /residents are required/);
    assert.deepEqual(game, before);
    game.population++;
    game.dollars--;
    const short = structuredClone(game);
    assert.throws(() => upgrade(game), /Not enough/);
    assert.deepEqual(game, short);
    game.dollars++;
    const stock = structuredClone(game.stock);
    const quote = snapshot(account);
    assert.equal(quote.game.stage, tier - 1);
    execute(account, { type: 'upgrade' });
    assert.equal(game.stage, tier);
    assert.equal(game.population, target.population);
    assert.equal(game.dollars, 0);
    for (const resource of ['wood', 'water', 'metal', 'oil'] as const)
      assert.equal(game.stock[resource], stock[resource] - (target.cost[resource] ?? 0));
    assert.equal(parseSave(JSON.stringify(game)).stage, tier);
    assert.notEqual(translate(target.name, 'ko'), target.name);
  }
  const game = newGame();
  game.stage = stages.length - 1;
  game.population = 20000001;
  const before = structuredClone(game);
  assert.throws(() => upgrade(game), /highest settlement tier/);
  assert.deepEqual(game, before);
});

test('megacity layouts add bounded residential blocks, retain placements and show exact next tiers', () => {
  const account = createAccount(1000000);
  account.game.stage = 8;
  account.game.home = { ...account.game.position };
  const bag = inventory(account);
  bag.layout = { version: 1, positions: { 'home-0': { x: -9, y: -9 } } };
  for (let tier = 8; tier < stages.length; tier++) {
    account.game.stage = tier;
    account.game.population = stages[tier].population;
    const positions = settlementPositions(account.game, bag);
    assert.deepEqual(positions['home-0'], { x: -9, y: -9 });
    assert.equal(new Set(Object.values(positions).map(position => cellKey(position!))).size, Object.keys(positions).length);
    assert.ok(Object.values(positions).every(position => validSettlementCell(position!)));
    assert.equal(settlementBuildings(account.game).filter(building => building.id.startsWith('home-')).length, homeCount(tier));
    assert.ok(homeCount(tier) <= 48);
    bag.layout.positions = positions;
    const state: ApiState = { ...snapshot(account), csrf: 'test', clockSpeed: 1, population: { global: account.game.population, federation: null } };
    const html = settlementScene(state, 'en');
    assert.ok(html.includes(stages[tier].name));
    assert.doesNotMatch(html, /undefined|NaN|Capital complete/);
    assert.ok(html.includes(tier === stages.length - 1 ? 'Great Megacity complete' : stages[tier + 1].name));
    assert.equal(settlementProfile(tier).homes, homeCount(tier));
  }
});

test('all tiers have bounded distinct building art and megacity upkeep scales to twenty million', () => {
  const heights = Array.from({ length: stages.length - 6 }, (_, index) => houseHeight(index + 6));
  assert.ok(heights.every((height, index) => index === 0 || height > heights[index - 1]));
  const symbols = ['home', 'tool', 'warehouse', 'market', 'bank', 'hall', 'flag', 'well', 'rainCollector', 'pumpingStation'];
  const artStages = [0, 3, 6, 9, 10, 11, 12, 13, 14, 15];
  for (const stage of artStages) {
    const designs = symbols.map(symbol => buildingArt(symbol, stage));
    assert.equal(new Set(designs).size, symbols.length);
    for (const art of designs) {
      assert.doesNotMatch(art, /NaN|undefined/);
      assert.match(art, /viewBox="0 0 64 64"/);
    }
  }
  assert.equal(new Set(artStages.map(stage => buildingArt('home', stage))).size, artStages.length);
  assert.deepEqual(stages.slice(9).map((_, index) => oilConsumptionPerResident(index + 9)), [.024, .032, .04, .048, .064, .128, .256]);
  for (let tier = 9; tier < stages.length; tier++) {
    const cost = settlementConsumptionForDays('oil', 20000000, 1000000, 7, tier);
    assert.equal(cost, 20000000 * oilConsumptionPerResident(tier) * 7);
    assert.equal(cost, Array.from({ length: 7 }, (_, day) => settlementConsumptionForDays('oil', 20000000, 1000000 + day * worldDayMs, 1, tier)).reduce((sum, daily) => sum + daily, 0));
  }
});

test('twenty-million census persists, grows beyond the final threshold and downgrades safely on shortages', () => {
  let now = worldEpoch;
  const store = new SqliteStore(':memory:', () => now), user = store.create();
  try {
    store.transaction(user.token, session => {
      const account = session.account;
      account.game.stage = stages.length - 1;
      account.game.population = 20000000;
      account.game.home = { ...account.game.position };
      account.game.stock = { wood: 1000000000, water: 1000000000, metal: 1000000000, oil: 1000000000 };
      account.workforce!.automatic = false;
      account.workforce!.cycleAt = now + worldWeekMs;
      initializeUpkeep(account, now);
    });
    now += worldWeekMs;
    store.transaction(user.token, (session, time) => accrue(session.account, time));
    assert.equal(store.population(null).global, 20200000);
    assert.equal(store.read(user.token, session => session.account.game.stage), stages.length - 1);
    const saved = store.read(user.token, session => structuredClone(session.account));
    store.transaction(user.token, (session, time) => accrue(session.account, time));
    assert.deepEqual(store.read(user.token, session => session.account), saved);
    store.transaction(user.token, session => {
      session.account.game.population = 9999999;
      session.account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 };
    });
    now += worldWeekMs;
    store.transaction(user.token, (session, time) => accrue(session.account, time));
    assert.equal(store.read(user.token, session => session.account.game.stage), stages.length - 2);
    assert.ok(store.population(null).global < 9999999);
  } finally { store.close(); }
});
