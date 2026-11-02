import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { build, claim, diplomacy, discover, gather, invite, isWater, move, newGame, parseSave, radius, recruitmentAmount, stages, terrainAt, terrainDetails, terrainResources, trade, upgrade } from './engine.ts';
import type { Game } from './engine.ts';
import { isWaterFacility, waterFacilities, waterFacilityKeys, waterProductionMultiplier } from './water-facilities.ts';
import { dollarsScale } from './dollars.ts';

function wealthy(): Game {
  const game = newGame();
  game.dollars = 1000000 * dollarsScale;
  for (const resource of Object.keys(game.stock) as (keyof Game['stock'])[]) game.stock[resource] = 1000000;
  return game;
}

test('new worlds have primary resources but no settlement or advanced stock', () => {
  const g = newGame();
  assert.equal(g.stage, -1);
  assert.equal(g.population, 0);
  assert.equal(g.stock.oil, 0);
  assert.equal(g.dollars, 0);
  assert.equal(Object.hasOwn(g.stock, 'lithium'), false);
  assert.equal(terrainAt(0, 0, g.seed), 'meadow');
});
test('three permanent Water facilities cost owned Wood and Metal once and stack additively to eightfold output', () => {
  const game = wealthy();
  assert.throws(() => build(game, 'well'), /settlement/);
  upgrade(game);
  const before = { ...game.stock };
  assert.equal(waterProductionMultiplier(game), 1);
  for (const key of waterFacilityKeys) {
    const cost = waterFacilities[key].cost, prior = { ...game.stock };
    build(game, key);
    assert.equal(game.stock.wood, prior.wood - cost.wood);
    assert.equal(game.stock.metal, prior.metal - cost.metal);
    assert.equal(game.stock.water, prior.water);
    assert.equal(game.waterFacilities?.[key], true);
    const paid = { ...game.stock };
    assert.throws(() => build(game, key), /already constructed/);
    assert.deepEqual(game.stock, paid);
  }
  assert.equal(waterProductionMultiplier(game), 8);
  assert.equal(before.wood - game.stock.wood, 420);
  assert.equal(before.metal - game.stock.metal, 155);
  const poor = newGame(); upgrade(poor); poor.dollars = 280 * dollarsScale; poor.stock.wood = 59;
  const saved = structuredClone(poor);
  assert.throws(() => build(poor, 'well'), /resources/);
  assert.deepEqual(poor, saved);
});
test('Water facility saves round trip, legacy saves stay unboosted and malformed ownership is rejected', () => {
  const game = wealthy(); upgrade(game); build(game, 'rainCollector');
  assert.deepEqual(parseSave(JSON.stringify(game)), game);
  assert.equal(waterProductionMultiplier(parseSave(JSON.stringify(game))), 3);
  delete game.waterFacilities;
  assert.equal(waterProductionMultiplier(parseSave(JSON.stringify(game))), 1);
  for (const invalid of [null, [], 2, { well: 3 }, { other: true }, { constructor: true }]) {
    assert.throws(() => parseSave(JSON.stringify({ ...game, waterFacilities: invalid })), /invalid/);
  }
  for (const invalid of ['constructor', '__proto__', null, 2]) assert.equal(isWaterFacility(invalid), false);
});

test('terrain is deterministic across returns and contains all resource biomes', () => {
  const seen = new Set();
  for (let x = -70; x < 70; x++) for (let y = -70; y < 70; y++) {
    const tile = terrainAt(x, y, 1542);
    assert.equal(tile, terrainAt(x, y, 1542));
    seen.add(tile);
  }
  assert.deepEqual([...seen].sort(), Object.keys(terrainDetails).sort());
  for (const terrain of Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]) {
    assert.ok(terrainResources[terrain]);
    assert.ok(terrainDetails[terrain].weeks >= 1 && terrainDetails[terrain].weeks <= 3);
    assert.ok(terrainDetails[terrain].yield > 0);
  }
});

test('all seeds offer starter wood, water and metal sites within the initial survey', () => {
  for (const seed of [0, 1, 1542, 999999]) {
    const game = newGame(); game.seed = seed; discover(game);
    const supplies = new Set(game.explored.map(key => {
      const [x, y] = key.split(',').map(Number);
      return terrainResources[terrainAt(x, y, seed)];
    }));
    for (const resource of ['wood', 'water', 'metal']) assert.ok(supplies.has(resource));
  }
});

test('all open water terrain rejects founding without spending supplies', () => {
  for (const terrain of Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]) {
    if (!isWater(terrain)) continue;
    const g = wealthy();
    g.seed = 1542;
    let location: { x: number; y: number } | undefined;
    for (let x = -70; x < 70 && !location; x++) for (let y = -70; y < 70 && !location; y++) {
      if (terrainAt(x, y, g.seed) === terrain) location = { x, y };
    }
    assert.ok(location, terrain);
    g.position = location;
    const stock = { ...g.stock };
    assert.throws(() => upgrade(g), /dry land/);
    assert.deepEqual(g.stock, stock);
  }
});

test('discovery is circular, persistent, and increases with lighting', () => {
  const g = wealthy();
  discover(g);
  assert.equal(g.explored.includes('0,0'), true);
  assert.equal(g.explored.includes(`${radius(g) + 1},0`), false);
  const initial = g.explored.length;
  build(g, 'light');
  assert.equal(radius(g), 6);
  assert.ok(g.explored.length > initial);
  build(g, 'light');
  assert.equal(radius(g), 8);
  assert.throws(() => build(g, 'light'), /best available/);
  move(g, 8, 0);
  assert.ok(g.explored.includes('0,0'));
});

test('movement rejects unreachable and fractional locations without mutation', () => {
  const g = newGame(), initial = structuredClone(g);
  assert.throws(() => move(g, 100, 100), /beyond your reach/);
  assert.throws(() => move(g, 0.5, 0), /valid map location/);
  assert.deepEqual(g, initial);
});

test('settlement establishes a home and consumes exact resource amounts', () => {
  const g = newGame();
  upgrade(g);
  assert.equal(g.stage, 0);
  assert.equal(g.population, 12);
  assert.deepEqual(g.home, { x: 0, y: 0 });
  assert.equal(g.stock.wood, 120);
  assert.equal(g.stock.water, 2520);
});

test('settlements require dry land', () => {
  const g = wealthy();
  let found = false;
  for (let x = 2; x < 100 && !found; x++) for (let y = 2; y < 100 && !found; y++) {
    if (terrainAt(x, y, g.seed) === 'water') { g.position = { x, y }; found = true; }
  }
  assert.ok(found);
  assert.throws(() => upgrade(g), /dry land/);
  assert.equal(g.stage, -1);
});

test('all upgrade stages enforce exact population thresholds and resource costs', () => {
  const g = wealthy();
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (stage.population > 0) {
      g.population = stage.population - 1;
      assert.throws(() => upgrade(g), /residents are required/);
      assert.equal(g.stage, i - 1);
    }
    g.population = stage.population;
    const before = { ...g.stock };
    upgrade(g);
    assert.equal(g.stage, i);
    for (const resource of Object.keys(before) as (keyof Game['stock'])[]) {
      assert.equal(g.stock[resource], before[resource] - (stage.cost[resource] ?? 0));
    }
  }
  assert.throws(() => upgrade(g), /highest/);
});

test('upgrades and resident invitations fail atomically without resources', () => {
  const g = newGame();
  assert.throws(() => invite(g), /first settlement/);
  upgrade(g);
  g.population = 100;
  g.stock.water = 0;
  g.stock.metal = 0;
  const initial = structuredClone(g);
  assert.throws(() => upgrade(g), /Not enough/);
  assert.deepEqual(g, initial);
  assert.throws(() => invite(g), /Not enough/);
  assert.deepEqual(g, initial);
});

test('resident recruitment charges supplies without instantly adding the quoted population', () => {
  const g = wealthy();
  upgrade(g);
  const metal = g.stock.metal, dollars = g.dollars;
  assert.match(invite(g), /Recruiting 18 residents/);
  assert.equal(g.stock.metal, metal);
  assert.equal(g.dollars, dollars - 900 * dollarsScale);
  assert.equal(g.population, 12);
  assert.equal(recruitmentAmount(g.population), 18);
  g.population = 10000;
  invite(g);
  assert.equal(g.population, 10000);
  assert.equal(recruitmentAmount(g.population), 1200);
});

test('five resource collections deplete a location and a new tile remains collectible', () => {
  const g = newGame(), before = g.stock.wood;
  for (let i = 0; i < 5; i++) gather(g);
  assert.equal(g.stock.wood, before + 175);
  assert.throws(() => gather(g), /depleted/);
  move(g, 1, 0);
  gather(g);
  assert.equal(g.stock.wood, before + 210);
});

test('market requires a settlement and a city bank for advanced resources', () => {
  const g = wealthy();
  assert.throws(() => trade(g, 'wood', 'buy', 1), /Use the marketplace/);
  upgrade(g);
  assert.throws(() => trade(g, 'oil', 'buy', 1), /Use the marketplace/);
  assert.throws(() => build(g, 'bank'), /city/);
  g.stage = 6;
  build(g, 'bank');
  assert.equal(g.bank, true);
  const metal = g.stock.metal, oil = g.stock.oil, dollars = g.dollars;
  assert.throws(() => trade(g, 'oil', 'buy', 10), /Use the marketplace/);
  assert.equal(g.stock.metal, metal);
  assert.equal(g.dollars, dollars);
  assert.equal(g.stock.oil, oil);
  assert.throws(() => trade(g, 'oil', 'sell', 10), /Use the marketplace/);
  assert.equal(g.stock.metal, metal);
  assert.equal(g.dollars, dollars);
  assert.equal(g.stock.oil, oil);
  assert.throws(() => build(g, 'bank'), /already/);
});

test('market rejects invalid quantities and insufficient balances without partial trades', () => {
  const g = newGame();
  upgrade(g);
  for (const amount of [0, -1, 0.1, NaN, Infinity, 10001]) assert.throws(() => trade(g, 'wood', 'buy', amount), /Use the marketplace/);
  const initial = structuredClone(g);
  assert.throws(() => trade(g, 'wood', 'buy', 1000), /Use the marketplace/);
  assert.throws(() => trade(g, 'water', 'sell', initial.stock.water + 1), /Use the marketplace/);
  assert.deepEqual(g, initial);
  assert.throws(() => trade(g, 'wood', 'sell', 10), /Use the marketplace/);
  assert.equal(g.stock.metal, initial.stock.metal);
  assert.equal(g.dollars, initial.dollars);
});

test('federation joining requires a village and established relations', () => {
  const g = wealthy();
  assert.throws(() => diplomacy(g, 'join'), /village/);
  g.stage = 3;
  assert.throws(() => diplomacy(g, 'join'), /relationship/);
  const before = { ...g.stock };
  diplomacy(g, 'gift');
  assert.equal(g.relationship, 50);
  assert.equal(g.stock.wood, before.wood - 40);
  assert.equal(g.stock.water, before.water - 30);
  diplomacy(g, 'join');
  assert.equal(g.federation, 'Evergreen Union');
  assert.throws(() => diplomacy(g, 'join'), /already belongs/);
});

test('a federation vote requires membership and a town hall and cannot be duplicated', () => {
  const g = wealthy();
  g.stage = 3;
  assert.throws(() => build(g, 'townhall'), /town/);
  g.stage = 4;
  build(g, 'townhall');
  assert.throws(() => diplomacy(g, 'vote'), /Join a federation/);
  g.federation = 'Evergreen Union';
  diplomacy(g, 'vote');
  assert.deepEqual(g.votes, ['watershed']);
  assert.equal(g.contribution, 50);
  assert.throws(() => diplomacy(g, 'vote'), /already voted/);
});

test('founding requires strictly more than 10000 residents and consumes 5000 metal', () => {
  const g = wealthy();
  g.stage = 6; g.population = 10000;
  assert.throws(() => diplomacy(g, 'form'), /more than 10,000/);
  g.population++;
  g.stock.metal = 4999;
  assert.throws(() => diplomacy(g, 'form'), /Not enough/);
  assert.equal(g.federation, null);
  g.stock.metal = 5000;
  diplomacy(g, 'form');
  assert.equal(g.stock.metal, 0);
  assert.equal(g.federation, 'Verdant Federation');
  assert.throws(() => diplomacy(g, 'form'), /already belongs/);
});

test('legacy global rewards cannot generate FTH$ at any membership or cooldown boundary', () => {
  const g = newGame();
  assert.throws(() => claim(g, 100000), /rewards are disabled/);
  g.federation = 'Evergreen Union';
  g.contribution = 129;
  assert.throws(() => claim(g, 100000), /rewards are disabled/);
  assert.equal(g.rewards, 0);
  assert.equal(g.contribution, 129);
  assert.equal(g.stock.metal, 80);
  assert.equal(g.dollars, 0);
  assert.throws(() => claim(g, 159999), /rewards are disabled/);
  assert.throws(() => claim(g, 160000), /rewards are disabled/);
  assert.equal(g.rewards, 0);
});

test('saves roundtrip and invalid or incomplete saves are explicitly rejected', () => {
  const g = wealthy();
  discover(g); upgrade(g); gather(g);
  assert.deepEqual(parseSave(JSON.stringify(g)), g);
  for (const raw of ['null', '{}', 'not json', JSON.stringify({ ...g, stock: { wood: 10 } }), JSON.stringify({ ...g, stage: 9 }), JSON.stringify({ ...g, light: 3 }), JSON.stringify({ ...g, position: { x: 0.5, y: 0 } }), JSON.stringify({ ...g, explored: ['bad'] })]) {
    assert.throws(() => parseSave(raw));
  }
});

test('the first camp is achievable with funded recruitment and supplied resources', () => {
  const g = newGame();
  discover(g);
  upgrade(g);
  g.dollars = 1500 * dollarsScale;
  invite(g);
  g.population += recruitmentAmount(g.population);
  gather(g);
  gather(g);
  g.stock.water += 8;
  upgrade(g);
  assert.equal(g.stage, 1);
  assert.equal(g.population, 30);
  assert.ok(Object.values(g.stock).every(n => n >= 0));
});
