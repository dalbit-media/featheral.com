import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { salePercentages, saleQuantity } from './resource-sale-quantity.ts';
import { accountingQuantity, displayQuantity } from './resource-units.ts';
import { marketQuantityLimit, marketSaleQuantityLimit, marketResources } from './market.ts';
import { translate } from './i18n.ts';

test('resource sale presets round down whole lots and default half retains the other half', () => {
  assert.deepEqual(salePercentages, [25, 50, 75, 100]);
  assert.deepEqual(salePercentages.map(percent => saleQuantity(1708, percent)), [427, 854, 1281, 1708]);
  assert.deepEqual(salePercentages.map(percent => saleQuantity(7, percent)), [1, 3, 5, 7]);
  assert.equal(saleQuantity(0, 50), 0);
  assert.equal(saleQuantity(.9, 50), 0);
  assert.equal(saleQuantity(1, 25), 1);
  for (const resource of marketResources) {
    const amount = displayQuantity(resource, saleQuantity(1708, 50));
    assert.equal(accountingQuantity(resource, amount), 854);
  }
});
test('resources have no fixed buy or sell cap while item limits remain unchanged', () => {
  assert.equal(saleQuantity(85401, 100), 85401);
  for (const resource of marketResources) {
    assert.equal(marketSaleQuantityLimit(resource), Number.MAX_SAFE_INTEGER);
    assert.equal(marketQuantityLimit(resource), Number.MAX_SAFE_INTEGER);
  }
  assert.equal(marketSaleQuantityLimit('torch'), 10000);
  assert.equal(marketSaleQuantityLimit('relic-forest'), 1);
  assert.equal(saleQuantity(Number.MAX_SAFE_INTEGER, 75), Number(BigInt(Number.MAX_SAFE_INTEGER) * 75n / 100n));
});
test('shared resource sale controls, input feedback and collection disclosure are bilingual', () => {
  for (const label of ['Item marketplace', 'Marketplace section', 'Resource source', 'Sale percentage',
    'Sale quantity slider', 'Available this sale', 'Review collect and sell', 'No resources available to sell.',
    'Enter a whole trading lot within the available amount.',
    'Only owned resources are sold. Pending resources and escrow are excluded.',
    'Collect all completed output, sell the selected amount, and store the rest. Full transport is deducted from proceeds.']) {
    assert.equal(translate(label, 'en'), label);
    assert.notEqual(translate(label, 'ko'), label, label);
  }
});
