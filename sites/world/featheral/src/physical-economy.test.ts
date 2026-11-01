import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { accountingPrice, accountingQuantity, displayPrice, displayQuantity, formatResourceAmount, resourceUnits } from './resource-units.ts';
import { dailyClimate, expeditionFindPlan, productionClimate, recruitmentClimate, temperatureEfficiency, waterDemandClimate, weeklyClimate } from './climate.ts';
import { climateCycleDays, environmentAt, seasonMs, worldDayMs, worldEpoch, worldWeekMs } from './environment.ts';
import { recruitmentAmount } from './engine.ts';
import { waterConsumptionForDays, waterUpkeep } from './upkeep.ts';
import { dollarsUnits } from './dollars.ts';

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
