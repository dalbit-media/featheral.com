import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { accountingPrice, accountingQuantity, displayPrice, displayQuantity, formatResourceAmount, formatResourcePrice, resourceBasePrice, resourceEconomy, resourceUnits } from './resource-units.ts';
import { dailyClimate, expeditionFindPlan, productionClimate, recruitmentClimate, temperatureEfficiency, waterDemandClimate, weeklyClimate } from './climate.ts';
import { climateCycleDays, environmentAt, seasonMs, worldDayMs, worldEpoch, worldWeekMs } from './environment.ts';
import { newGame, recruitmentAmount } from './engine.ts';
import { dailyUpkeepPerResident, dailyWaterPerResident, waterConsumptionForDays, waterUpkeep } from './upkeep.ts';
import { dollarsUnits } from './dollars.ts';
import { marketBasePrice, marketPriceFloor } from './market.ts';
import { translate } from './i18n.ts';
import { balancedAllocation, editableAllocation, emptyAllocation, nextExploration, workforceCounts } from './workforce.ts';
import { availableWorkers, createAccount, execute, snapshot } from '../server/economy.ts';

test('population counts separate current gathering, explorers and waiting residents from next-week plans', () => {
  const account = createAccount(1000000);
  account.game.stage = 0; account.game.population = 12;
  const work = snapshot(account).workforce;
  work.automatic = true; work.allocation = { wood: 9, water: 0, metal: 0, oil: 0 };
  work.crews = { wood: { workers: 3, readyAt: work.cycleAt, weeklyYield: 300, weeklyMetalCost: 0, weeklyDollarsCost: 3 } };
  work.expeditions = [{ x: 5, y: 0, workers: 2, readyAt: work.cycleAt, surveyRadius: 4 }];
  account.workforce = work;
  assert.deepEqual(workforceCounts(12, work), { gathering: 3, exploring: 2, available: 7, assignmentCapacity: 10 });
  assert.equal(availableWorkers(account), 7);
  assert.deepEqual(editableAllocation(work), { wood: 3, water: 0, metal: 0, oil: 0 });
  const jobs = structuredClone({ crews: work.crews, expeditions: work.expeditions });
  execute(account, { type: 'assign', resource: 'wood', workers: 0 });
  assert.equal(work.automatic, false);
  assert.equal(work.allocation.wood, 0);
  assert.equal(availableWorkers(account), 7, 'editing next week never frees current workers');
  assert.deepEqual({ crews: work.crews, expeditions: work.expeditions }, jobs);
  const draft = editableAllocation(work); draft.wood = 99;
  assert.equal(work.allocation.wood, 0, 'editable allocation is a copy, not live state');
  work.expeditions.push({ x: 6, y: 0, workers: 2, readyAt: work.cycleAt, surveyRadius: 4 });
  assert.deepEqual(workforceCounts(12, work), { gathering: 3, exploring: 4, available: 5, assignmentCapacity: 8 });
  assert.throws(() => execute(account, { type: 'assign', resource: 'wood', workers: 9 }), /Keep two residents/);
  assert.deepEqual({ crews: work.crews, expeditions: work.expeditions.slice(0, 1) }, jobs);
});
test('automatic/manual switching preserves current jobs and zero-population counts stay empty', () => {
  const account = createAccount(1000000);
  account.game.stage = 0; account.game.population = 12;
  const work = snapshot(account).workforce;
  work.allocation.wood = 10;
  account.workforce = work;
  execute(account, { type: 'automatic', enabled: false });
  assert.deepEqual(work.allocation, emptyAllocation(), 'switching from auto uses actual crews');
  assert.equal(availableWorkers(account), 12);
  execute(account, { type: 'automatic', enabled: true });
  assert.equal(availableWorkers(account), 12);
  assert.deepEqual(workforceCounts(0, work), { gathering: 0, exploring: 0, available: 0, assignmentCapacity: 0 });
  for (const label of ['Busy now', 'Available now', 'Gathering now', 'Exploring now', 'Next-week assignment', 'Auto recalculates next week'])
    assert.notEqual(translate(label, 'ko'), label);
});
test('an expedition uses two currently available residents, not future assignment space', () => {
  const account = createAccount(1000000);
  account.game.stage = 0; account.game.population = 4;
  account.game.stock = { wood: 1000, water: 1000, metal: 1000, oil: 0 };
  account.game.dollars = dollarsUnits(1000);
  const work = snapshot(account).workforce;
  work.automatic = false; work.allocation = emptyAllocation();
  work.crews = { wood: { workers: 2, readyAt: work.cycleAt, weeklyYield: 200, weeklyMetalCost: 0, weeklyDollarsCost: 2 } };
  account.workforce = work;
  const destination = nextExploration(account.game)!;
  execute(account, { type: 'move', x: destination.x, y: destination.y });
  assert.deepEqual(workforceCounts(4, work), { gathering: 2, exploring: 2, available: 0, assignmentCapacity: 2 });
  const before = structuredClone(account);
  const another = nextExploration(account.game, work.expeditions)!;
  assert.throws(() => execute(account, { type: 'move', x: another.x, y: another.y }), /two available residents/);
  assert.deepEqual(account, before);
  execute(account, { type: 'assign', resource: 'wood', workers: 0 });
  assert.equal(availableWorkers(account), 0, 'future reductions cannot double-book gathering residents for exploration');
});

test('automatic crews value physical output at static prices and prioritize needed Water even below transport cost', () => {
  const game = newGame(1000000);
  game.stage = 0; game.population = 4; game.bank = true;
  game.stock = { wood: 3000, water: 100000, metal: 3000, oil: 3000 };
  const site = (perWorker: number) => ({ available: true, distance: 0, efficiency: 1, perWorker, dollarsPerWorker: 1 });
  const access = { wood: site(100), water: site(600), metal: site(100), oil: site(14) };
  const plan = balancedAllocation(game, emptyAllocation(), 6000, 99, access, 0, 0, true);
  assert.equal(plan.crews.oil, 2, 'Oil yields 420 FTH$ per worker versus Wood 250 FTH$');
  assert.equal(plan.crews.wood, 0);
  game.stock.water = 0;
  access.water.perWorker = 1;
  const supplies = balancedAllocation(game, emptyAllocation(), 6000, 99, access, 0, 0, true);
  assert.equal(supplies.crews.water, 2, 'needed drinking Water is not skipped for its low resale value');
  game.stock = { wood: 6000, water: 100000, metal: 5999, oil: 6000 };
  const repairs = balancedAllocation(game, emptyAllocation(), 6000, 99, access, 0, 0, true);
  assert.equal(repairs.crews.metal, 1, 'a break-even Metal lot can restore repair stock without a negative-value trip');
});

test('planning values retain physical production and upkeep without creating price floors or changing reserve seeds', () => {
  const gross = { wood: 250, water: 6, metal: 100, oil: 420 };
  const upkeep = { wood: .7, water: .35, metal: .14, oil: 0 };
  const seeds = { wood: 4, water: 2, metal: 2, oil: 24 };
  for (const resource of ['wood', 'water', 'metal', 'oil'] as const) {
    const reference = resourceEconomy[resource], price = resourceBasePrice(resource);
    assert.equal(displayPrice(resource, price), reference.pricePerUnit);
    assert.equal(marketPriceFloor(resource), .0001);
    assert.equal(marketBasePrice(resource), seeds[resource]);
    assert.equal(reference.weeklyProduction * dollarsUnits(price), dollarsUnits(gross[resource]));
    assert.equal(Math.round(reference.dailyConsumption * 7 * dollarsUnits(price)), dollarsUnits(upkeep[resource]));
  }
  assert.equal(dailyWaterPerResident, resourceEconomy.water.dailyConsumption);
  assert.deepEqual(dailyUpkeepPerResident, { wood: resourceEconomy.wood.dailyConsumption, metal: resourceEconomy.metal.dailyConsumption });
  assert.equal(formatResourcePrice('water', .01, 'en-US'), '0.001');
  assert.equal(formatResourcePrice('wood', 2.5, 'ko-KR'), '0.05');
  assert.equal(formatResourcePrice('wood', .0001, 'en-US'), '0.000002');
});
test('dynamic resource pricing and finite treasury explanations are available in Korean', () => {
  for (const text of [
    'Current market price', 'Production and upkeep value', 'Baseline output per worker/week', 'Baseline upkeep per resident/week',
    'Actual output and upkeep vary with climate, terrain and upgrades. Oil is used by construction and crafting, not daily resident upkeep.',
    'Resource prices move with trades, with deeper pricing liquidity to slow declines and a 1% spread. Existing treasury FTH$ replenishes low market funds; no currency is created.',
    'Not enough market funds for this sale. Treasury funds are finite. Sell less or try again after funds are replenished.',
    'Not enough resources in the market. Buy less or try again after players sell.',
  ]) assert.notEqual(translate(text, 'ko'), text);
});

test('familiar trading units use exact accounting lots without changing price times quantity', () => {
  for (const asset of ['wood', 'water', 'metal', 'oil'] as const) {
    for (const lots of [1, 3, 29, 100, 9999, 10000]) {
      assert.equal(accountingQuantity(asset, displayQuantity(asset, lots)), lots);
      assert.ok(Math.abs(displayPrice(asset, 2) * displayQuantity(asset, lots) - 2 * lots) < 1e-8);
      assert.equal(accountingPrice(asset, displayPrice(asset, 2)), 2);
    }
  }
  assert.equal(formatResourceAmount('wood', 180, 'en-US'), '9,000 kg');
  assert.equal(formatResourceAmount('water', 2560, 'ko-KR'), '25,600 L');
  assert.equal(displayQuantity('wood', 1), 50);
  assert.equal(displayQuantity('water', 1), 10);
  assert.equal(accountingQuantity('wood', 50), 1);
  assert.equal(accountingQuantity('water', 10), 1);
  assert.equal(displayPrice('wood', 4), .08);
  assert.equal(displayPrice('water', 2), .2);
  assert.equal(displayPrice('wood', .0001), .000002);
  assert.equal(displayPrice('water', .0001), .00001);
  assert.ok(Math.abs(accountingPrice('wood', .000002) - .0001) < 1e-12);
  assert.ok(Math.abs(accountingPrice('water', .00001) - .0001) < 1e-12);
  assert.equal(dollarsUnits(accountingPrice('wood', .000002)), 1);
  assert.equal(dollarsUnits(accountingPrice('water', .00001)), 1);
  assert.throws(() => dollarsUnits(accountingPrice('wood', .000003)), RangeError);
  assert.throws(() => dollarsUnits(accountingPrice('water', .000015)), RangeError);
  assert.equal(displayQuantity('wood', 10000), 500000);
  assert.equal(displayQuantity('water', 10000), 100000);
  assert.equal(formatResourceAmount('metal', 80, 'en-US'), '0.8 t');
  assert.equal(formatResourceAmount('oil', 14, 'en-US'), '14 bbl');
  assert.equal(formatResourceAmount('torch', 2, 'en-US'), '2 ea');
  assert.equal(formatResourceAmount('torch', 2, 'ko-KR'), '2 \uac1c');
  assert.equal(resourceUnits.oil.litresPerLot, 158.987294928);
  assert.ok(!Number.isInteger(accountingQuantity('water', .005)));
});
test('offline Water prefix sums exactly match daily rounded bills across climate-cycle wrap and pre-epoch days', () => {
  for (const population of [1, 12, 133]) {
    const first = worldEpoch - 3 * worldDayMs, days = climateCycleDays + 17;
    let expected = 0;
    for (let day = 0; day < days; day++) expected += waterUpkeep(population, 0, first + day * worldDayMs).required;
    assert.equal(waterConsumptionForDays(population, first, days), expected);
    assert.equal(waterConsumptionForDays(population, first + 2 * climateCycleDays * worldDayMs, days), expected);
    assert.equal(waterConsumptionForDays(population, first, 0), 0);
    assert.equal(waterConsumptionForDays(population, first, 100, true), population * 15 * 100);
  }
  for (const [population, first, days] of [[-1, worldEpoch, 1], [12, -1, 1], [12, worldEpoch, .5], [12, worldEpoch, -1]]) {
    assert.throws(() => waterConsumptionForDays(population, first, days), RangeError);
  }
});
test('household Water baseline is 50 litres per person and hot summer days demand more', () => {
  assert.equal(waterUpkeep(1, 100).required * resourceUnits.water.litresPerLot, 50);
  const mild = environmentAt(worldEpoch);
  const hot = { ...mild, season: 'Summer' as const, weather: 'Clear skies' as const, temperature: 35 };
  assert.ok(waterDemandClimate(hot) > waterDemandClimate(mild));
  assert.ok(waterUpkeep(12, 10000, worldEpoch + seasonMs).required > waterUpkeep(12, 10000, worldEpoch).required);
});
test('each resource, recruitment and discovery suitability respond to season, weather and temperature', () => {
  const mild = { ...environmentAt(worldEpoch), season: 'Spring' as const, weather: 'Clear skies' as const, temperature: 18 };
  const cold = { ...mild, season: 'Winter' as const, weather: 'Snow' as const, temperature: -15 };
  for (const asset of ['wood', 'water', 'metal', 'oil'] as const) {
    assert.ok(productionClimate(asset, cold) < productionClimate(asset, mild));
    assert.notEqual(productionClimate(asset, { ...mild, weather: 'Storm' }), productionClimate(asset, mild));
    assert.ok(productionClimate(asset, { ...mild, temperature: 40 }) < productionClimate(asset, mild));
  }
  assert.ok(productionClimate('water', { ...mild, weather: 'Rain' }) > productionClimate('water', mild));
  assert.ok(recruitmentClimate(cold) < recruitmentClimate(mild));
  assert.ok(temperatureEfficiency(40) < temperatureEfficiency(18));
  assert.ok(recruitmentAmount(1000, 0, worldEpoch + 3 * seasonMs) < recruitmentAmount(1000, 0, worldEpoch));
});
test('weekly effects average every daily weather window across season boundaries deterministically', () => {
  const time = worldEpoch + seasonMs - 3 * worldDayMs;
  const effect = (environment: ReturnType<typeof environmentAt>) => productionClimate('water', environment);
  const daily = Array.from({ length: 7 }, (_, day) => dailyClimate(time + day * worldDayMs, effect));
  assert.equal(weeklyClimate(time, effect), daily.reduce((sum, value) => sum + value, 0) / 7);
  assert.equal(weeklyClimate(time, effect), weeklyClimate(time, effect));
});
test('exploration finds vary by climate and seed, remain bounded and are deterministic', () => {
  let spring = 0, winter = 0;
  const outcomes = new Set<string>();
  for (let seed = 1; seed <= 500; seed++) {
    const warm = expeditionFindPlan(seed, 5, 0, worldEpoch, 1);
    const cold = expeditionFindPlan(seed, 5, 0, worldEpoch + 3 * seasonMs, 1);
    assert.deepEqual(warm, expeditionFindPlan(seed, 5, 0, worldEpoch, 1));
    for (const plan of [warm, cold]) {
      assert.ok(plan.collection >= 1 && plan.collection <= 2);
      assert.ok(plan.activity >= 0 && plan.activity <= 2);
      outcomes.add(JSON.stringify(plan));
    }
    spring += Number(warm.collectible) + warm.collection + warm.activity;
    winter += Number(cold.collectible) + cold.collection + cold.activity;
  }
  assert.ok(outcomes.size > 3);
  assert.ok(spring > winter * 1.2);
  assert.throws(() => dailyClimate(-1, effect => effect.temperature), RangeError);
  assert.ok(worldWeekMs > worldDayMs);
});
