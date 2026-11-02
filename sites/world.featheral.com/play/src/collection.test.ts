import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { collectionClaimReason, collectionReceiptQuantity } from './collection.ts';

test('direct collection exposes readiness and transport without changing the authoritative cost', () => {
  const state = snapshot(createAccount(1000000));
  assert.equal(collectionClaimReason(state, 'wood'), 'Settlement required.');
  state.game.stage = 0;
  assert.equal(collectionClaimReason(state, 'wood'), 'No completed resources to collect.');
  state.pending.wood = 1;
  state.collection = { fees: { wood: 2, water: 0, metal: 0, oil: 0 }, automationUntil: { wood: 0, water: 0, metal: 0, oil: 0 } };
  state.dollars = 1.9999;
  assert.match(collectionClaimReason(state, 'wood')!, /Not enough FTH\$/);
  state.dollars = 2;
  assert.equal(collectionClaimReason(state, 'wood'), null);
  assert.equal(state.collection.fees.wood, 2);
});
test('collection feedback uses only the matching successful receipt, never estimated stock differences', () => {
  for (const resource of ['wood', 'water', 'metal', 'oil'] as const)
    assert.equal(collectionReceiptQuantity(`Collected 123 ${resource}. FTH$ transport paid.`, resource), 123);
  for (const message of [undefined, 'Connection failed.', 'Collected 123 metal. FTH$ transport paid.',
    'Collected 0 wood. FTH$ transport paid.', 'Collected 1.5 wood. FTH$ transport paid.',
    'Collected 9007199254740992 wood. FTH$ transport paid.'])
    assert.equal(collectionReceiptQuantity(message, 'wood'), null);
});
