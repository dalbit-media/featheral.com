import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import type { ApiState } from './api-types.ts';
import { enhancementPanel, enhancedInventoryPanel } from './enhancement-view.ts';
import { enhancementQuote } from './enhancement.ts';
import { gameConsumption, marketConsumption } from './consumption.ts';
import { translate } from './i18n.ts';
import type { MarketSnapshot } from './market.ts';
import { dollarsScale } from './dollars.ts';

const equipmentId = 'c51a906b-0b2f-4d4a-9e6d-645760a1955a';
function fixture(): ApiState {
  const account = createAccount(0);
  account.game.stage = 8; account.game.home = { ...account.game.position };
  account.game.stock = { wood: 10000000, water: 10000000, metal: 10000000, oil: 10000000 };
  account.game.dollars = 10000000 * dollarsScale;
  const state: ApiState = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.inventory.items = ['survey-satchel', 'refinement-core'];
  return state;
}
test('enhancement preview shows the precise relative gain, full failure cost and a single review action', () => {
  const state = fixture(), before = structuredClone(state);
  const plan = enhancementQuote(state.game, state.inventory, 'survey-satchel');
  assert.equal(plan.discount, 8); assert.equal(plan.nextDiscount, 10);
  for (const language of ['en', 'ko'] as const) {
    const html = enhancementPanel(state, 'survey-satchel', null, false, '', false, language, () => '<span>resources</span>');
    assert.match(html, /8\.00%/); assert.match(html, /10\.00%/); assert.match(html, /80%/);
    assert.equal((html.match(/data-action="refine-equipment"/g) ?? []).length, 1);
    assert.ok(html.includes(translate('Failure consumes all listed costs. Equipment and level are retained.', language)));
    assert.ok(html.includes(translate('The first attempt converts one unused ordinary copy into individual equipment.', language)));
  }
  const confirmation = gameConsumption(state, { type: 'refine-equipment', target: 'survey-satchel', fingerprint: plan.fingerprint })!;
  assert.equal(confirmation.costs.find(cost => cost.asset === 'refinement-core')!.amount, 1);
  for (const [asset, amount] of Object.entries(plan.cost)) assert.equal(confirmation.costs.find(cost => cost.asset === asset)!.amount, amount);
  assert.ok(confirmation.warning?.includes('Failure consumes'));
  assert.match(gameConsumption(state, { type: 'refine-equipment', target: 'survey-satchel', fingerprint: 'changed' })!.warning!, /changed/);
  assert.deepEqual(state, before);
});
test('owned enhanced copies retain unique selection and equipped badges and cannot be listed while equipped', () => {
  const state = fixture();
  state.inventory.enhancedEquipment = [{ id: equipmentId, item: 'survey-satchel', level: 10 }];
  state.inventory.enhancedEquipped = { investigation: equipmentId };
  const owned = enhancedInventoryPanel(state, 'en');
  assert.match(owned, /Equipped/); assert.ok(owned.includes(equipmentId));
  assert.match(owned, /data-action="enhanced-gear"[^>]*data-unequip/);
  const html = enhancementPanel(state, equipmentId, null, false, '', false, 'en', () => '');
  assert.match(html, /data-action="enhancement-list"[^>]* disabled/);
  assert.match(html, /min="0\.0001" max="10000000000" step="0\.0001"/);
  assert.match(html, /Unequip enhanced equipment before listing it/);
});
test('listing purchase confirms the exact copy, level and FTH$ price; errors remain visible', () => {
  const state = fixture();
  const market: MarketSnapshot = { asset: 'torch', quantity: 1, tickers: [], bids: [], asks: [], history: [], trades: [], orders: [],
    quotes: { buy: { quantity: 1, dollars: 0, available: false }, sell: { quantity: 1, dollars: 0, available: false } },
    enhancedListings: [{ id: 1, equipment: { id: equipmentId, item: 'survey-satchel', level: 10 }, price: 250.5, createdAt: 0, yours: false }] };
  const html = enhancementPanel(state, null, market, false, '', false, 'en', () => '');
  assert.match(html, /Survey satchel \+10/);
  assert.match(html, /FTH\$ 250\.5/);
  const quote = marketConsumption({ type: 'enhancement-buy', listingId: 1, price: 250.5 }, state, market)!;
  assert.equal(quote.subject, 'Survey satchel');
  assert.deepEqual(quote.costs, [{ asset: 'dollars', amount: 250.5 }]);
  assert.equal(quote.details![0].value, '10');
  const failed = enhancementPanel(state, null, null, false, 'Equipment listings unavailable.', false, 'en', () => '');
  assert.match(failed, /role="alert">Equipment listings unavailable/);
});

test('refinement and individual trade outcomes are bilingual', () => {
  for (const message of [
    'Enhanced equipment equipped. Discounts apply to new activity only.',
    'Removed investigation equipment.',
    'Enhanced equipment listed at a fixed player price.',
    'Enhanced equipment listing cancelled. Your equipment was returned.',
    'Enhanced equipment purchased from another player.',
    'Enhanced equipment sold to another player.',
    'Refinement succeeded. Survey satchel is now +1.',
    'Refinement failed. Survey satchel remains +0; your equipment is safe.',
  ]) {
    assert.equal(translate(message, 'en'), message);
    assert.notEqual(translate(message, 'ko'), message);
  }
});
