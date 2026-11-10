import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { apply, createAccount, execute, parseCommand, snapshot } from './economy.ts';
import { craft, inventory } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';
import { builderCharter } from '../src/builder-items.ts';
import { hasBuilderCharter, maxUpgradePlan } from '../src/max-upgrades.ts';
import type { UpgradeTarget } from '../src/max-upgrades.ts';
import { constructionKeys, constructionLevel } from '../src/constructions.ts';
import { dollarsScale } from '../src/dollars.ts';
import { craftingCost, craftingIngredients, decorationItems, itemStorage } from '../src/items.ts';
import type { ItemId } from '../src/items.ts';
import { stages } from '../src/engine.ts';
import { isLiquidAsset, isReserveMarketAsset } from '../src/market.ts';
import { itemArt } from '../src/item-art.ts';
import { itemDescription } from '../src/item-details.ts';
import { translate } from '../src/i18n.ts';
import { gameConsumption } from '../src/consumption.ts';
import { timedActionKey } from '../src/action-timing.ts';

function fixture() {
  const account = createAccount(1000000);
  account.game.stage = 8;
  account.game.home = { ...account.game.position };
  account.game.population = 20000000;
  account.game.stock = { wood: 10000000, water: 10000000, metal: 10000000, oil: 10000000 };
  account.game.dollars = 10000000 * dollarsScale;
  account.game.explored = Array.from({ length: 441 }, (_, index) => `${index % 21 - 10},${Math.floor(index / 21) - 10}`);
  inventory(account).items = [builderCharter, builderCharter];
  snapshot(account);
  return account;
}
const targets: UpgradeTarget[] = [
  { type: 'upgrade' }, { type: 'warehouse' }, { type: 'item-storage' },
  ...constructionKeys.map(kind => ({ type: 'construction' as const, kind })),
  ...(['bank', 'townhall', 'well', 'rainCollector', 'pumpingStation', 'market-stall', 'trade-hub', 'workshop'] as const).map(kind => ({ type: 'build' as const, kind })),
];
test('every upgrade target plans exact maximum costs and executes the original upgrade behavior', () => {
  for (const target of targets) {
    const account = fixture(), before = structuredClone(account), expected = structuredClone(account);
    const plan = maxUpgradePlan(snapshot(account), target);
    assert.deepEqual(account, before);
    assert.ok(plan.count > 0, JSON.stringify(target));
    for (let index = 0; index < plan.count; index++) execute(expected, target, 1000000 + index * 2000);
    execute(account, { type: 'max-upgrade', target, fingerprint: plan.fingerprint }, 1000000);
    assert.deepEqual(account.game.stock, expected.game.stock);
    assert.equal(account.game.dollars, expected.game.dollars);
    assert.equal(account.game.stage, expected.game.stage);
    assert.equal(account.warehouse, expected.warehouse);
    assert.equal(account.inventory!.storage, expected.inventory!.storage);
    assert.deepEqual(account.game.constructionLevels, expected.game.constructionLevels);
    assert.deepEqual(account.game.waterFacilities, expected.game.waterFacilities);
    assert.deepEqual(account.game.incomeFacilities, expected.game.incomeFacilities);
    assert.equal(account.game.bank, expected.game.bank);
    assert.equal(account.game.townhall, expected.game.townhall);
    assert.equal(account.inventory!.items.filter(item => item === builderCharter).length, 1);
    if (target.type === 'warehouse') assert.equal(account.warehouse, 99);
    if (target.type === 'item-storage') assert.equal(account.inventory!.storage, itemStorage.length - 1);
    if (target.type === 'upgrade') assert.equal(account.game.stage, stages.length - 1);
    if (target.type === 'construction') assert.equal(constructionLevel(account.game, target.kind), 99);
    if (target.type === 'build') assert.equal(plan.count, 1);
    assert.equal(timedActionKey({ type: 'max-upgrade', target, fingerprint: plan.fingerprint }), timedActionKey(target));
  }
});

test('material and dollar boundaries, population unlocks and caps limit the plan without partial spending', () => {
  const target: UpgradeTarget = { type: 'warehouse' }, account = fixture();
  account.game.stock.wood = 240;
  account.game.dollars = 150 * dollarsScale;
  const plan = maxUpgradePlan(snapshot(account), target);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.costs, { wood: 240, metal: 60, dollars: 150 });
  execute(account, { type: 'max-upgrade', target, fingerprint: plan.fingerprint });
  assert.equal(account.warehouse, 2);
  assert.equal(account.game.stock.wood, 0);
  assert.equal(account.game.dollars, 0);
  const capped = fixture();
  capped.game.population = 999999;
  assert.equal(maxUpgradePlan(snapshot(capped), { type: 'upgrade' }).finalLevel, 10);
  capped.game.stage = 0;
  assert.equal(maxUpgradePlan(snapshot(capped), { type: 'build', kind: 'bank' }).count, 0);
  capped.game.stage = -1;
  assert.equal(maxUpgradePlan(snapshot(capped), { type: 'item-storage' }).count, 0);
});

test('missing, reserved charters, stale or forged plans reject atomically and receipts replay once', () => {
  const account = fixture(), target: UpgradeTarget = { type: 'warehouse' };
  const plan = maxUpgradePlan(snapshot(account), target);
  for (const mode of ['missing', 'reserved', 'pending', 'capped', 'changed', 'forged'] as const) {
    const current = structuredClone(account);
    if (mode === 'missing' || mode === 'reserved' || mode === 'pending') current.inventory!.items = [];
    if (mode === 'reserved') current.inventory!.marketReserved = [builderCharter];
    if (mode === 'pending') current.inventory!.pending = [builderCharter];
    if (mode === 'capped') current.warehouse = 99;
    if (mode === 'changed') current.game.dollars = 0;
    const before = structuredClone(current);
    assert.throws(() => execute(current, { type: 'max-upgrade', target, fingerprint: mode === 'forged' ? '{}' : plan.fingerprint }));
    assert.deepEqual(current, before);
  }
  const body = { id: randomUUID(), revision: account.revision, command: { type: 'max-upgrade' as const, target, fingerprint: plan.fingerprint } };
  const result = apply(account, body, account.updatedAt);
  const before = structuredClone(account);
  assert.deepEqual(apply(account, body, account.updatedAt), result);
  assert.deepEqual(account, before);
  for (const target of [{ type: 'max-upgrade', target: { type: 'gather' }, fingerprint: '{}' },
    { type: 'max-upgrade', target: { type: 'upgrade', free: true }, fingerprint: '{}' },
    { type: 'max-upgrade', target: { type: 'max-upgrade' }, fingerprint: '{}' }]) assert.throws(() => parseCommand(target));
});

test('builder charter crafts, trades without expanding reserves and previews exact aggregate consumption', () => {
  const account = fixture();
  assert.deepEqual(craftingCost(builderCharter), { wood: 20, metal: 10, dollars: 100 });
  assert.deepEqual(craftingIngredients(builderCharter), Object.fromEntries(Object.keys(decorationItems).map(item => [item, 1])));
  const missing = structuredClone(account);
  missing.inventory!.storage = itemStorage.length - 1;
  missing.inventory!.items = Object.keys(decorationItems).filter(item => item !== 'skybeacon') as ItemId[];
  const missingBefore = structuredClone(missing);
  assert.throws(() => craft(missing, builderCharter), /one unused copy of every decoration building/);
  assert.deepEqual(missing, missingBefore);
  account.inventory!.storage = itemStorage.length - 1;
  account.inventory!.items = [...Object.keys(decorationItems), builderCharter, builderCharter] as ItemId[];
  craft(account, builderCharter);
  assert.deepEqual(account.inventory!.items, [builderCharter, builderCharter, builderCharter]);
  assert.ok(hasBuilderCharter(snapshot(account)));
  assert.equal(isLiquidAsset(builderCharter), true);
  assert.equal(isReserveMarketAsset(builderCharter), false);
  assert.match(itemArt(builderCharter), /builder-charter-art/);
  assert.notEqual(translate('Master Builder Charter', 'ko'), 'Master Builder Charter');
  assert.notEqual(translate(itemDescription(builderCharter).effect, 'ko'), itemDescription(builderCharter).effect);
  const target: UpgradeTarget = { type: 'warehouse' }, state = snapshot(account), plan = maxUpgradePlan(state, target);
  const quote = gameConsumption(state, { type: 'max-upgrade', target, fingerprint: plan.fingerprint })!;
  assert.deepEqual(quote.costs, [...Object.entries(plan.costs).map(([asset, amount]) => ({ asset, amount })), { asset: builderCharter, amount: 1 }]);
  assert.equal(quote.subject, gameConsumption(state, target)!.subject);
  assert.notEqual(translate(quote.notes[0], 'ko'), quote.notes[0]);
});

test('HTTP max upgrades persist atomically with CSRF, plan validation, one cooldown and receipt replay', async () => {
  const now = 1000000, store = new SqliteStore(':memory:', () => now), user = store.create();
  store.transaction(user.token, session => { Object.assign(session.account, fixture()); });
  const saved = () => store.read(user.token, session => structuredClone(session.account));
  const target: UpgradeTarget = { type: 'construction', kind: 'workshop' };
  const plan = maxUpgradePlan(snapshot(saved()), target);
  const body = { id: randomUUID(), revision: 0, command: { type: 'max-upgrade', target, fingerprint: plan.fingerprint } };
  const origin = 'http://127.0.0.1:5173', server = createApi(store, origin);
  try {
    const before = saved();
    assert.throws(() => store.transaction(user.token, (session, time, realTime) => {
      apply(session.account, body, time, realTime);
      throw new Error('Rollback fixture');
    }), /Rollback fixture/);
    assert.deepEqual(saved(), before);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/actions`;
    const headers = { Cookie: `terra-dev=${user.token}`, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrf };
    const post = (request: unknown, csrf = user.csrf) => fetch(url, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': csrf }, body: JSON.stringify(request) });
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await post(body, 'invalid')).status, 403);
    assert.equal((await post({ ...body, revision: 1 })).status, 409);
    assert.equal((await post({ ...body, command: { ...body.command, fingerprint: 'forged' } })).status, 409);
    assert.deepEqual(saved(), before);
    const result = await post(body); assert.equal(result.status, 200);
    const after = saved();
    assert.equal(constructionLevel(after.game, 'workshop'), 99);
    assert.equal(after.inventory!.items.filter(item => item === builderCharter).length, 1);
    assert.equal(after.actionReadyAt!['building:workshop'], now + 2000);
    const response = await result.json();
    const replay = await post(body); assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), response);
    assert.deepEqual(saved(), after);
  } finally { server.close(); store.close(); }
});
