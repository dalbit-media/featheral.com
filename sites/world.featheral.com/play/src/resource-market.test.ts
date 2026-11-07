import test from 'node:test';
import assert from 'node:assert/strict';
import { poolPayment } from './pool-pricing.ts';
import { emergencyCollection, emptyAllocation, expeditionSurveyRadius } from './workforce.ts';
import { emergencyTiles } from './world.ts';
import { radius, survey } from './engine.ts';
import type { Terrain } from './engine.ts';
import { accrue, createAccount, execute, snapshot } from '../server/economy.ts';
import { worldWeekMs } from './environment.ts';

test('tenfold resource depth declines at least five times slower than ordinary liquidity', () => {
  const shallow = { units: 10000, dollars: 400000000 };
  const deep = { ...shallow, depthUnits: 90000n, depthDollars: 3600000000n };
  const decline = (pool: typeof deep | typeof shallow) => {
    const before = poolPayment(pool, 'sell', 1);
    const dollars = poolPayment(pool, 'sell', 1000);
    const after = poolPayment({ ...pool, units: pool.units + 1000, dollars: pool.dollars - dollars }, 'sell', 1);
    return 1 - after / before;
  };
  assert.ok(decline(deep) > 0);
  assert.ok(decline(deep) < decline(shallow) / 5);
  assert.ok(decline(deep) < .025);
});
test('conservative resource curve rounding never pays for a profitable round trip', () => {
  const pool = { units: 10000, dollars: 400000000, depthUnits: 90000n, depthDollars: 3600000000n };
  for (const quantity of [1, 3, 100, 1000, 10000]) {
    const bought = poolPayment(pool, 'buy', quantity);
    const sold = poolPayment({ ...pool, units: pool.units - quantity, dollars: pool.dollars + bought }, 'sell', quantity);
    assert.ok(sold <= bought);
  }
});
test('emergency pickup requires pending whole lots and an unaffordable resource-specific fee', () => {
  const pending = { wood: 1, water: 100, metal: .9, oil: 2 };
  const fees = { wood: 5, water: 3, metal: 100, oil: 0 };
  assert.deepEqual(emergencyCollection(pending, fees, 3), { wood: 1, water: 0, metal: 0, oil: 0 });
  assert.deepEqual(emergencyCollection(pending, fees, 5), emptyAllocation());
  assert.deepEqual(emergencyCollection(pending, fees, 0), { wood: 1, water: 100, metal: 0, oil: 0 });
});
test('map selects one nearest visible marker per eligible resource, preserving the Oil unlock', () => {
  const terrains: Terrain[] = ['forest', 'water', 'mountain', 'oil'];
  const tiles = terrains.flatMap(terrain => [3, 1, 2].map(x => ({ x, y: 0, terrain, visible: true })));
  tiles.push({ x: 0, y: 0, terrain: 'forest', visible: false });
  const pending = { wood: 1, water: 100, metal: 1, oil: 1 }, home = { x: 0, y: 0 };
  const selected = emergencyTiles(tiles, pending, home, true);
  assert.equal(selected.length, 4); assert.ok(selected.every(tile => tile.x === 1));
  assert.equal(emergencyTiles(tiles, pending, home, false).length, 3);
  assert.equal(emergencyTiles(tiles, emptyAllocation(), home, true).length, 0);
});
test('new surveys trim the default reveal area by eight percent without fractional map coordinates', () => {
  const game = createAccount(1000000).game;
  game.explored = [];
  survey(game, { x: 20, y: 0 }, radius(game));
  assert.equal(game.explored.length, 49);
  game.explored = [];
  survey(game, { x: 20, y: 0 }, expeditionSurveyRadius(game));
  assert.equal(game.explored.length, 45);
  assert.ok(game.explored.every(key => key.split(',').every(value => Number.isInteger(Number(value)))));
});
test('dispatch locks reduced future radius while already-travelling expeditions retain their original survey', () => {
  const account = createAccount(1000000);
  account.game.stage = 0; account.game.population = 12;
  account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 0 };
  account.game.dollars = 100000000;
  const work = snapshot(account).workforce;
  work.automatic = false; work.allocation = emptyAllocation();
  work.expeditions = [{ x: -5, y: 0, workers: 2, readyAt: 1000000 + worldWeekMs, surveyRadius: 4 }];
  account.workforce = work;
  execute(account, { type: 'move', x: 5, y: 0 });
  assert.equal(work.expeditions[0].surveyRadius, 4);
  assert.equal(work.expeditions[1].surveyRadius, 3.75);
  const due = Math.max(...work.expeditions.map(expedition => expedition.readyAt));
  accrue(account, due);
  assert.ok(account.game.explored.includes('-9,0'));
  assert.ok(account.game.explored.includes('8,0'));
  assert.ok(!account.game.explored.includes('9,0'));
});
