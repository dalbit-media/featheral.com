import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { ApiError, apply, createAccount, execute, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import { createApi } from './http.ts';
import { SqliteStore } from './store.ts';
import { actionRemaining, actionThrottleMs } from '../src/action-timing.ts';
import type { Command } from '../src/api-types.ts';
import { nextInvestigation } from '../src/workforce.ts';

const start = 1000000;
function fixture(): Account {
  const account = createAccount(start);
  account.game.stage = 0;
  account.game.population = 40;
  account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
  account.game.dollars = 100000000;
  account.game.explored = Array.from({ length: 41 }, (_, x) => Array.from({ length: 41 }, (_, y) => `${x - 20},${y - 20}`)).flat();
  snapshot(account);
  account.workforce!.automatic = false;
  account.workforce!.allocation = { wood: 0, water: 0, metal: 0, oil: 0 };
  account.workforce!.crews = {};
  return account;
}
test('craft cooldown covers all recipes and batches, survives serialization, and accepts exactly 2000 real ms', () => {
  const account = fixture();
  execute(account, { type: 'craft', item: 'torch', quantity: 3 }, start);
  assert.equal(account.actionReadyAt?.craft, start + actionThrottleMs);
  const restored: Account = JSON.parse(JSON.stringify(account));
  for (const time of [start, start + 250, start + 1999, start - 1000]) {
    const before = structuredClone(restored);
    assert.throws(() => execute(restored, { type: 'craft', item: 'bench' }, time),
      (error: unknown) => error instanceof ApiError && error.status === 429);
    assert.deepEqual(restored, before);
  }
  execute(restored, { type: 'craft', item: 'bench' }, start + 2000);
  assert.equal(restored.inventory!.items.length, 4);
  assert.equal(snapshot(restored).actionReadyAt?.craft, start + 4000);
});
test('investigate cooldown spans destinations but is independent of craft and accelerated game time', () => {
  const account = fixture();
  const first = nextInvestigation(account.game)!;
  execute(account, { type: 'investigate', x: first.x, y: first.y }, start);
  execute(account, { type: 'craft', item: 'torch' }, start);
  const next = nextInvestigation(account.game, account.workforce!.expeditions)!;
  account.updatedAt += 168000;
  const before = structuredClone(account);
  assert.throws(() => execute(account, { type: 'investigate', x: next.x, y: next.y }, start + 1999), /cooling down/);
  assert.deepEqual(account, before);
  execute(account, { type: 'investigate', x: next.x, y: next.y }, start + 2000);
  assert.equal(account.workforce!.expeditions.length, 2);
  assert.equal(actionRemaining(account.actionReadyAt, 'investigate', start + 2001), 1999);
});
test('failed crafting and investigation do not start cooldowns or consume resources', () => {
  const account = fixture();
  account.game.stock.wood = 0;
  const before = structuredClone(account);
  assert.throws(() => execute(account, { type: 'craft', item: 'torch' }, start), /Not enough/);
  assert.deepEqual(account, before);
  assert.throws(() => execute(account, { type: 'investigate', x: 999, y: 999 }, start), /Wood heating/);
  assert.deepEqual(account, before);
  assert.equal(account.actionReadyAt, undefined);
});
test('accepted idempotent retries return their receipt without spending again during cooldown', () => {
  const account = fixture();
  const request = { id: randomUUID(), revision: account.revision, command: { type: 'craft', item: 'torch' } };
  const accepted = apply(account, request, start, start);
  const restored: Account = JSON.parse(JSON.stringify(account));
  assert.deepEqual(apply(restored, request, start + 300, start + 300), accepted);
  assert.equal(restored.inventory!.items.length, 1);
  assert.throws(() => apply(restored, { ...request, id: randomUUID(), revision: restored.revision }, start + 300, start + 300), /cooling down/);
});
test('HTTP rejects forged throttle fields and new IDs, preserves balances, and permits exact-boundary retries', async () => {
  let time = start;
  const store = new SqliteStore(':memory:', () => time, 168);
  const identity = store.create();
  store.transaction(identity.token, session => { session.account = fixture(); });
  const origin = 'http://127.0.0.1:5173', server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { Origin: origin, Cookie: `terra-dev=${identity.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrf };
  const post = (body: unknown) => fetch(`${base}/actions`, { method: 'POST', headers, body: JSON.stringify(body) });
  const body = (command: Command) => store.read(identity.token, session => ({ id: randomUUID(), revision: session.account.revision, command }));
  try {
    const first = body({ type: 'craft', item: 'torch' });
    const accepted = await post(first);
    assert.equal(accepted.status, 200);
    const receipt = await accepted.json();
    assert.deepEqual(await (await post(first)).json(), receipt);
    for (const elapsed of [300, 1999]) {
      time = start + elapsed;
      const before = store.read(identity.token, session => structuredClone(session.account));
      const denied = await post(body({ type: 'craft', item: 'bench' }));
      assert.equal(denied.status, 429);
      assert.match((await denied.json()).error, /cooling down/);
      assert.deepEqual(store.read(identity.token, session => session.account), before);
    }
    assert.equal((await post({ ...body({ type: 'craft', item: 'torch' }), actionReadyAt: {} })).status, 400);
    time = start + 2000;
    assert.equal((await post(body({ type: 'craft', item: 'bench' }))).status, 200);
    const next = store.read(identity.token, session => nextInvestigation(session.account.game)!);
    time += 300;
    assert.equal((await post(body({ type: 'investigate', x: next.x, y: next.y }))).status, 200);
    time += 1999;
    const other = store.read(identity.token, session => nextInvestigation(session.account.game, session.account.workforce!.expeditions)!);
    assert.equal((await post(body({ type: 'investigate', x: other.x, y: other.y }))).status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});
