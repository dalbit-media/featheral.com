import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { affordableBuyingQuantity, buyingBudgetUnits, isMarketPercentage } from './market-buy-quantity.ts';
import { salePercentages } from './resource-sale-quantity.ts';
import { accountingQuantity, displayQuantity } from './resource-units.ts';
import { marketResources } from './market.ts';
import { translate } from './i18n.ts';

test('buying percentages preserve accounting precision and match every sale preset', () => {
  assert.deepEqual(salePercentages, [25, 50, 75, 100]);
  assert.deepEqual(salePercentages.map(percent => buyingBudgetUnits(10003, percent)), [2500, 5001, 7502, 10003]);
  assert.equal(buyingBudgetUnits(Number.MAX_SAFE_INTEGER, 75), Number(BigInt(Number.MAX_SAFE_INTEGER) * 75n / 100n));
  for (const value of [0, 1, 24, 26, 101, NaN]) assert.equal(isMarketPercentage(value), false);
  assert.throws(() => buyingBudgetUnits(-1, 25), /Invalid/);
});
test('budget sizing finds the largest affordable whole quantity with depth, liquidity and caps', () => {
  const cost = (quantity: number) => quantity > 80 ? null : BigInt(quantity * quantity + 3 * quantity);
  for (const percent of salePercentages) {
    const budget = buyingBudgetUnits(10000, percent), quantity = affordableBuyingQuantity(100, budget, cost);
    assert.ok(cost(quantity)! <= BigInt(budget));
    assert.ok(cost(quantity + 1) === null || cost(quantity + 1)! > BigInt(budget));
    for (const resource of marketResources) assert.equal(accountingQuantity(resource, displayQuantity(resource, quantity)), quantity);
  }
  assert.equal(affordableBuyingQuantity(10000, 100000, quantity => BigInt(quantity)), 10000);
  assert.equal(affordableBuyingQuantity(1, 100000, quantity => BigInt(quantity)), 1);
  assert.equal(affordableBuyingQuantity(100, 0, quantity => BigInt(quantity)), 0);
  assert.equal(affordableBuyingQuantity(100, 1, () => 2n), 0);
  assert.equal(affordableBuyingQuantity(100, 100, () => null), 0);
  assert.equal(affordableBuyingQuantity(0, 100, () => 1n), 0);
  assert.equal(affordableBuyingQuantity(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, quantity => BigInt(quantity)), Number.MAX_SAFE_INTEGER);
  assert.equal(affordableBuyingQuantity(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, quantity => BigInt(quantity)), Number.MAX_SAFE_INTEGER - 1);
});
test('buying quantity and budget disclosures are bilingual', () => {
  for (const label of [
    'Percentages use your available FTH$ budget, rounded down to whole trading lots.',
    'Percentages use your sellable copies, rounded down to whole items.',
    'Minimum amount', 'Spending limit', 'Buy budget percentage', 'No whole trading lot fits the selected budget or available market.',
    'Buying budget quote is unavailable. Refresh and try again.',
  ]) assert.notEqual(translate(label, 'ko'), label);
});
