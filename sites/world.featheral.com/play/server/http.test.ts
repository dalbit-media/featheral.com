import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { createApi } from './http.ts';
import { SqliteStore } from './store.ts';
import { apply, snapshot } from './economy.ts';
import type { ApiState, Command } from '../src/api-types.ts';
import { environmentAt, worldWeekMs } from '../src/environment.ts';
import { resourceCapacity } from '../src/workforce.ts';
import { dollarsScale } from '../src/dollars.ts';
import { automateFixtureCollections, fundFixtureFromReserves, fundFixtureResources } from './test-support.ts';

const origin = 'http://127.0.0.1:5173';
test('verified owners sharing an IP have independent quotas and forged cookies cannot create an identity', async () => {
  const store = new SqliteStore(':memory:'), identities = Array.from({ length: 300 }, () => store.create());
  const server = createApi(store, origin);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/state`;
    const read = async (token: string) => {
      const response = await fetch(url, { headers: { Cookie: `terra-dev=${token}` } });
      await response.arrayBuffer();
      return response.status;
    };
    for (let offset = 0; offset < identities.length; offset += 50)
      assert.ok((await Promise.all(identities.slice(offset, offset + 50).map(identity => read(identity.token)))).every(status => status === 200));
    for (let index = 0; index < 239; index++) assert.equal(await read(identities[0]!.token), 200);
    assert.equal(await read(identities[0]!.token), 429);
    assert.equal(await read('f'.repeat(64)), 401);
    assert.equal(await read(identities[1]!.token), 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('linked session aliases share the canonical owner quota', async t => {
  const store = new SqliteStore(':memory:'), first = store.create(), alias = store.create();
  const resolve = store.chatSession.bind(store);
  const canonical = resolve(first.token).owner;
  t.mock.method(store, 'chatSession', (token: string) => ({ ...resolve(token), owner: canonical }));
  const server = createApi(store, origin);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (let index = 0; index < 241; index++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/state`,
        { headers: { Cookie: `terra-dev=${index % 2 ? alias.token : first.token}` } });
      await response.arrayBuffer();
      assert.equal(response.status, index < 240 ? 200 : 429);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('item actions use authoritative inventory, strict payloads, durable retry receipts and rollback', async () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time), identity = store.create();
  store.transaction(identity.token, session => { fundFixtureResources(session.account); session.account.game.dollars = 500 * dollarsScale; });
  const server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const cookie = `terra-dev=${identity.token}`;
  let state = await (await fetch(`${base}/state`, { headers: { Cookie: cookie } })).json() as ApiState;
  const post = (body: unknown) => fetch(`${base}/actions`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
    body: JSON.stringify(body),
  });
  const act = async (command: Command) => {
    time += 1000;
    const response = await post({ id: randomUUID(), revision: state.revision, command });
    assert.equal(response.status, 200);
    state = await response.json() as ApiState;
  };
  try {
    await act({ type: 'upgrade' });
    await act({ type: 'craft', item: 'torch' });
    assert.deepEqual(state.inventory.items, ['torch']);
    assert.equal(state.inventory.equipped, 'torch');
    assert.equal(state.game.visibilityRadius, 6);
    await act({ type: 'equip', item: null });
    assert.equal(state.game.visibilityRadius, 4);
    await act({ type: 'craft', item: 'bench' });
    time += 1000;
    const placement = { id: randomUUID(), revision: state.revision, command: { type: 'decorate', slot: 'square', item: 'bench' } };
    const placed = await post(placement);
    assert.equal(placed.status, 200);
    state = await placed.json() as ApiState;
    assert.deepEqual(state.inventory.placements, { square: 'bench' });
    assert.equal(state.game.visibilityRadius, 4);
    assert.deepEqual(await (await post(placement)).json(), state);
    await act({ type: 'decorate', slot: 'garden', item: 'bench' });
    assert.deepEqual(state.inventory.placements, { garden: 'bench' });
    await act({ type: 'decorate', slot: 'garden', item: null });
    assert.deepEqual(state.inventory.placements, {});
    await act({ type: 'arrange', entity: 'workshop', position: { x: -8, y: -8 } });
    assert.deepEqual(state.inventory.layout!.positions.workshop, { x: -8, y: -8 });
    const layoutMove = { id: randomUUID(), revision: state.revision,
      command: { type: 'arrange', entity: 'bench', position: { x: -8, y: -7 } } };
    time += 1000;
    const layoutResponse = await post(layoutMove);
    assert.equal(layoutResponse.status, 200);
    state = await layoutResponse.json() as ApiState;
    assert.deepEqual(state.inventory.layout!.positions.bench, { x: -8, y: -7 });
    assert.deepEqual(await (await post(layoutMove)).json(), state);
    const layoutBefore = store.read(identity.token, record => structuredClone(record.account));
    for (const command of [
      { type: 'arrange', entity: 'centre', position: { x: -8, y: -8 } },
      { type: 'arrange', entity: 'centre', position: { x: 8, y: 2 } },
      { type: 'arrange', entity: 'bank', position: { x: -7, y: -7 } },
    ]) {
      time += 1000;
      assert.equal((await post({ id: randomUUID(), revision: state.revision, command })).status, 409);
      assert.deepEqual(store.read(identity.token, record => record.account), layoutBefore);
    }
    assert.equal((await post({ id: randomUUID(), revision: state.revision,
      command: { type: 'arrange', entity: 'centre', position: { x: 1, y: 1, cost: 0 } } })).status, 400);
    const before = store.read(identity.token, record => structuredClone(record.account));
    time += 1000;
    const forged = await post({ id: randomUUID(), revision: state.revision, command: { type: 'craft', item: 'lamp', cost: 0 } });
    assert.equal(forged.status, 400);
    assert.deepEqual(store.read(identity.token, record => record.account), before);
    const invalidSlot = await post({ id: randomUUID(), revision: state.revision, command: { type: 'decorate', slot: '__proto__', item: 'bench' } });
    assert.equal(invalidSlot.status, 400);
    const unowned = await post({ id: randomUUID(), revision: state.revision, command: { type: 'decorate', slot: 'square', item: 'fountain' } });
    assert.equal(unowned.status, 409);
    assert.deepEqual(store.read(identity.token, record => record.account), before);
    const upgrade = { id: randomUUID(), revision: state.revision, command: { type: 'item-storage' } };
    const first = await post(upgrade);
    assert.equal(first.status, 200);
    const upgraded = await first.json() as ApiState;
    const retry = await post(upgrade);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), upgraded);
    assert.equal(upgraded.inventory.storage, 1);
    assert.equal(upgraded.game.stock.metal, state.game.stock.metal - 50);
    assert.equal(store.publicTotals().metal, upgraded.game.stock.metal);
    assert.equal(upgraded.capacity, state.capacity);
    assert.equal(upgraded.warehouse, state.warehouse);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
test('public statistics are anonymous, cacheable, read-only and use the exact game population census', async () => {
  const store = new SqliteStore(':memory:', () => 1000000, 10);
  const server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    const empty = await fetch(`${base}/stats`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('set-cookie'), null);
    assert.equal(empty.headers.get('cache-control'), 'public, max-age=15, s-maxage=15');
    assert.equal(empty.headers.get('vary'), 'Origin, Sec-Fetch-Site');
    const data = await empty.json();
    assert.deepEqual(Object.keys(data).sort(), ['dollars', 'metal', 'population', 'settlements', 'updatedAt']);
    assert.deepEqual({ ...data, updatedAt: 0 }, { ...store.publicTotals(), updatedAt: 0 });
    assert.equal(data.dollars, 0);
    assert.ok(Math.abs(Date.now() - data.updatedAt) < 5000);
    const session = store.create();
    store.transaction(session.token, (record, now) => {
      fundFixtureResources(record.account);
      return apply(record.account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, now);
    });
    const before = store.read(session.token, record => structuredClone(record.account));
    const stats = await (await fetch(`${base}/stats`, { headers: { Cookie: 'terra-dev=invalid' } })).json();
    const stateResponse = await fetch(`${base}/state`, { headers: { Cookie: `terra-dev=${session.token}` } });
    const state = await stateResponse.json() as ApiState;
    assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
    assert.equal(stats.population, state.population.global);
    assert.equal(stats.population, 12);
    assert.equal(stats.settlements, 1);
    assert.equal(stats.metal, state.game.stock.metal);
    assert.deepEqual(store.read(session.token, record => record.account), before);
    const post = await fetch(`${base}/stats`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/stats`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/stats`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('HTTP trust boundary, isolated identities, atomic concurrency, rollback and durable restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'terra-api-')), path = join(directory, 'test.sqlite');
  let time = 1000000;
  let store = new SqliteStore(path, () => time);
  let server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, init?: RequestInit) => fetch(`${base}/api/${path}`, init);
  const post = (body: unknown, cookie = '', csrf = '', extra: Record<string, string> = {}) => ({
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...extra },
    body: JSON.stringify(body),
  });
  const create = async () => {
    const response = await call('session', post({}));
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
    const state = await (await call('state', { headers: { Cookie: cookie.split(';')[0] } })).json() as ApiState;
    assert.deepEqual(state.environment, environmentAt(time));
    return { cookie: cookie.split(';')[0], state };
  };
  try {
    await t.test('reject absent sessions, forged origins, fetch metadata and wrong content type', async () => {
      assert.equal((await call('state')).status, 401);
      assert.equal((await call('session', post({}, '', '', { Origin: 'https://evil.example' }))).status, 403);
      assert.equal((await call('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await call('session', post({}, '', '', { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
      assert.equal((await call('session', post({}, '', '', { 'Content-Type': 'text/plain' }))).status, 415);
      assert.equal((await call('session', post({ amount: 1 }))).status, 400);
    });
    const a = await create(), b = await create();
    store.transaction(a.cookie.split('=')[1], session => { session.account.game.dollars = 500 * dollarsScale; });
    fundFixtureFromReserves(path, 500);
    const body = (state: ApiState, command: Command) => ({ id: randomUUID(), revision: state.revision, command });
    await t.test('session-bound CSRF; no mutation from forged requests', async () => {
      const command = body(a.state, { type: 'upgrade' });
      assert.equal((await call('actions', post(command, a.cookie))).status, 403);
      assert.equal((await call('actions', post(command, a.cookie, b.state.csrf))).status, 403);
      assert.equal((await call('actions', post({ ...command, stock: { wood: 100000 } }, a.cookie, a.state.csrf))).status, 400);
      assert.equal((await call('actions', post({ ...command, padding: 'x'.repeat(3000) }, a.cookie, a.state.csrf))).status, 413);
      assert.equal((await call('actions', { ...post(command, a.cookie, a.state.csrf), body: '{' })).status, 400);
    });
    await t.test('duplicate concurrent actions have one durable effect', async () => {
      const command = body(a.state, { type: 'upgrade' });
      const replies = await Promise.all([call('actions', post(command, a.cookie, a.state.csrf)), call('actions', post(command, a.cookie, a.state.csrf))]);
      assert.deepEqual(replies.map(r => r.status), [200, 200]);
      const states = await Promise.all(replies.map(r => r.json()));
      assert.deepEqual(states[0], states[1]);
      a.state = states[0];
      assert.equal(a.state.game.stock.wood, 120);
      assert.deepEqual(a.state.population, { global: 12, federation: null });
      assert.equal((await (await call('state', { headers: { Cookie: b.cookie } })).json()).game.stage, -1);
    });
    await t.test('population assignments are authenticated, validated and idempotent', async () => {
      time += 1000;
      const request = body(a.state, { type: 'assign', resource: 'wood', workers: 2 });
      const replies = await Promise.all([1, 2].map(() => call('actions', post(request, a.cookie, a.state.csrf))));
      assert.deepEqual(replies.map(r => r.status), [200, 200]);
      const states = await Promise.all(replies.map(r => r.json()));
      assert.deepEqual(states[0], states[1]);
      a.state = states[0];
      assert.ok(a.state.availableWorkers >= 2);
      assert.equal(a.state.workforce.allocation.wood, 2);
      assert.equal(a.state.workforce.automatic, false);
      assert.equal(a.state.workforce.allocation.wood, 2);
    });
    await t.test('failed action rolls back both accrual and spending', async () => {
      time += 60000;
      const before = store.transaction(a.cookie.split('=')[1], session => structuredClone(session.account));
      const response = await call('actions', post(body(a.state, { type: 'trade', resource: 'wood', direction: 'buy', amount: 10000 }), a.cookie, a.state.csrf));
      assert.equal(response.status, 409);
      const after = store.transaction(a.cookie.split('=')[1], session => structuredClone(session.account));
      assert.deepEqual(after, before);
    });
    await t.test('state reads persist weekly settlement exactly once while low-level reads remain isolated', async () => {
      const token = a.cookie.split('=')[1];
      const before = store.read(token, session => structuredClone(session.account));
      const peer = new SqliteStore(path, () => time);
      try {
        peer.transaction(token, () => {
          assert.equal(store.read(token, session => session.account.revision), a.state.revision);
        });
      } finally { peer.close(); }
      for (let i = 0; i < 3; i++) {
        const response = await call('state', { headers: { Cookie: a.cookie } });
        assert.equal(response.status, 200);
        const state = await response.json() as ApiState;
        assert.equal(state.pending.wood, 0);
        assert.equal(state.claimThreshold, 50);
        assert.equal(state.serverTime, time);
      }
      const persisted = store.read(token, session => structuredClone(session.account));
      assert.equal(persisted.updatedAt, time);
      assert.deepEqual(persisted.game.stock, before.game.stock);
      store.read(token, session => { session.account.game.stock.wood = 999999; });
      assert.deepEqual(store.read(token, session => session.account), persisted);
    });
    await t.test('below-threshold single and bulk claims are rejected atomically', async () => {
      const token = a.cookie.split('=')[1];
      const before = store.read(token, session => structuredClone(session.account));
      for (const command of [{ type: 'claim' }, { type: 'claim', resource: 'wood' }] as const) {
        const response = await call('actions', post(body(a.state, command), a.cookie, a.state.csrf));
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /50%|No completed/);
        assert.deepEqual(store.read(token, session => session.account), before);
      }
    });
    await t.test('competing claims cannot spend the same pending stock twice', async () => {
      store.transaction(a.cookie.split('=')[1], session => {
        session.account.game.stock.water = 1000000;
        session.account.pending.wood = 80 * 60000;
      });
      a.state = await (await call('state', { headers: { Cookie: a.cookie } })).json();
      const expectedWood = a.state.game.stock.wood + Math.min(a.state.capacity, a.state.pending.wood + a.state.rates.wood);
      const expectedWater = a.state.game.stock.water - a.state.waterUpkeep!.weeklyConsumption;
      time += worldWeekMs;
      const replies = await Promise.all([1, 2].map(() => call('actions', post(body(a.state, { type: 'claim' }), a.cookie, a.state.csrf))));
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
      a.state = await replies.find(r => r.status === 200)!.json();
      assert.equal(a.state.game.stock.wood, expectedWood);
      assert.equal(a.state.pending.wood, 0);
      assert.equal(a.state.game.stock.water, expectedWater);
      assert.equal(a.state.pending.water, 0);
    });
    await t.test('concurrent recruitment and retries queue one paid batch without instant population', async () => {
      store.transaction(a.cookie.split('=')[1], session => { session.account.game.dollars += 10000 * 10000; });
      fundFixtureFromReserves(path, 10000);
      time += 1000;
      const request = body(a.state, { type: 'invite' });
      const replies = await Promise.all([request, { ...request, id: randomUUID() }].map(command =>
        call('actions', post(command, a.cookie, a.state.csrf))));
      assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
      a.state = await replies.find(response => response.status === 200)!.json();
      assert.equal(a.state.game.population, 12);
      assert.deepEqual(a.state.population, { global: 12, federation: null });
      assert.equal(a.state.recruitment!.population * 50, a.state.recruitmentDollars);
      assert.equal(a.state.inviteReadyAt - a.state.serverTime, worldWeekMs);
      time += 1000;
      const before = store.read(a.cookie.split('=')[1], session => structuredClone(session.account));
      const denied = await call('actions', post(body(a.state, { type: 'invite' }), a.cookie, a.state.csrf));
      assert.equal(denied.status, 409);
      assert.match((await denied.json()).error, /Recruitment ready/);
      assert.deepEqual(store.read(a.cookie.split('=')[1], session => session.account), before);
      assert.deepEqual(store.population(null), { global: 12, federation: null });
      const accepted = before.receipt!;
      const retry = await call('actions', post({ id: accepted.id, ...JSON.parse(accepted.request) }, a.cookie, a.state.csrf));
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).game.population, 12);
      assert.equal(store.population(null).global, 12);
    });
    await t.test('restart preserves session, owned balance, production, recruitment and receipt', async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      store = new SqliteStore(path, () => time);
      server = createApi(store, origin);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const restartedAddress = server.address();
      assert.ok(restartedAddress && typeof restartedAddress !== 'string');
      base = `http://127.0.0.1:${restartedAddress.port}`;
      const restored = store.transaction(a.cookie.split('=')[1], session => session);
      assert.equal(restored.account.game.stock.wood, a.state.game.stock.wood);
      assert.deepEqual(restored.account.workforce, a.state.workforce);
      assert.equal(restored.csrf, a.state.csrf);
      assert.equal(restored.account.revision, a.state.revision);
      assert.equal(restored.account.inviteReadyAt, a.state.inviteReadyAt);
      assert.deepEqual(restored.account.recruitment, a.state.recruitment);
      assert.equal(store.population(null).global, 12);
      assert.ok(restored.account.receipt);
    });
    await t.test('state reads complete recruitment at one week exactly once and update the census atomically', async () => {
      time = a.state.inviteReadyAt - 1;
      const read = async () => (await call('state', { headers: { Cookie: a.cookie } })).json();
      a.state = await read();
      assert.equal(a.state.game.population, 12);
      const population = 12 + a.state.recruitment!.population;
      assert.equal(store.population(null).global, 12);
      time += 1;
      a.state = await read();
      assert.equal(a.state.game.population, population);
      assert.equal(a.state.recruitment, null);
      assert.equal(a.state.inviteReadyAt, 0);
      assert.equal(a.state.population.global, population);
      assert.equal((await read()).game.population, population);
      assert.equal(store.population(null).global, population);
    });
    await t.test('expired identity is rejected', () => {
      time += 8 * 86400000;
      assert.throws(() => store.transaction(a.cookie.split('=')[1], () => true), /expired/);
      assert.throws(() => store.read(a.cookie.split('=')[1], () => true), /expired/);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true });
  }
});
test('HTTPS deployments use host-only Secure cookies and disallow remote plaintext origins', async () => {
  const store = new SqliteStore(':memory:');
  assert.throws(() => createApi(store, 'http://game.example'), /HTTPS/);
  assert.doesNotThrow(() => createApi(store, 'http://world.localhost:8080'));
  const server = createApi(store, 'https://game.example');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
      method: 'POST', headers: { Origin: 'https://game.example', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get('set-cookie')!, /^__Host-terra=.*; Secure$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.has('strict-transport-security'));
    for (const rejected of ['http://game.example', 'https://localhost', 'https://other.example']) {
      const forbidden = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
        method: 'POST', headers: { Origin: rejected, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(forbidden.status, 403);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
test('mock session creation is rate limited', async () => {
  const store = new SqliteStore(':memory:'), server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, i < 5 ? 201 : 429);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
test('state GET durably bills weekly transport once and failed actions roll back the same billing', async () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time), server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`, identity = store.create();
  const cookie = `terra-dev=${identity.token}`;
  try {
    store.transaction(identity.token, (session, now) => {
      const account = session.account, work = account.workforce!;
      fundFixtureResources(account);
      automateFixtureCollections(account);
      account.game.stage = 0; account.game.population = 12;
      account.game.home = { x: 20, y: 0 }; account.game.stock.metal = 50;
      account.game.stock.wood = 0;
      account.game.dollars = 50 * 10000;
      account.incomeReadyAt = now + 100 * worldWeekMs;
      account.game.explored = ['-3,0'];
      assert.ok('version' in work);
      work.automatic = false; work.allocation.wood = 2;
      apply(account, { id: randomUUID(), revision: 0, command: { type: 'home' } }, now);
    });
    assert.equal(store.publicTotals().metal, 50);
    const dollarsBefore = store.publicTotals().dollars;
    time += worldWeekMs;
    const before = store.read(identity.token, session => structuredClone(session.account));
    const failed = await fetch(`${base}/actions`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': identity.csrf },
      body: JSON.stringify({ id: randomUUID(), revision: before.revision,
        command: { type: 'trade', resource: 'wood', direction: 'buy', amount: 10000 } }),
    });
    assert.equal(failed.status, 409);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${base}/state`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const state = await response.json() as ApiState;
      assert.equal(state.game.stock.metal, 50);
      assert.equal(state.dollars, 38);
      assert.equal(state.game.stock.wood, 100);
      assert.equal(state.pending.wood, 0);
      assert.equal(state.workforce.crews.wood, undefined);
      assert.equal(store.publicTotals().metal, 50);
      assert.equal(store.publicTotals().dollars, dollarsBefore - 12);
      assert.equal(store.read(identity.token, session => session.account.game.stock.metal), 50);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('HTTP expeditions support independent launches while duplicate requests and stale revisions cannot double spend', async () => {
  let time = 1000000;
  const store = new SqliteStore(':memory:', () => time), server = createApi(store, origin), identity = store.create();
  store.transaction(identity.token, session => {
    const account = session.account, work = snapshot(account).workforce;
    fundFixtureResources(account);
    account.game.stage = 0; account.game.population = 12; account.game.home = { x: 0, y: 0 };
    account.game.stock.metal = 1000; account.game.dollars = 1000 * 10000; work.automatic = false; account.workforce = work;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const send = (command: Command, revision: number, id = randomUUID()) => fetch(`${base}/actions`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
      Cookie: `terra-dev=${identity.token}`, 'X-CSRF-Token': identity.csrf },
    body: JSON.stringify({ id, revision, command }),
  });
  try {
    const id = randomUUID(), firstCommand: Command = { type: 'move', x: 5, y: 0 };
    const firstResponse = await send(firstCommand, 0, id);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as ApiState;
    time += 1000;
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.equal((await send(firstCommand, first.revision)).status, 409);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    const secondResponse = await send({ type: 'move', x: -5, y: 0 }, first.revision);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as ApiState;
    assert.equal(second.workforce.expeditions.length, 2);
    assert.equal(second.availableWorkers, 8);
    assert.equal(second.game.stock.metal, first.game.stock.metal);
    assert.ok(second.dollars < first.dollars);
    const retry = await send({ type: 'move', x: -5, y: 0 }, second.revision - 1,
      store.read(identity.token, session => session.account.receipt!.id));
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), second);
    time += 1000;
    const competing = await Promise.all([
      send({ type: 'move', x: 0, y: 5 }, second.revision),
      send({ type: 'move', x: 0, y: -5 }, second.revision),
    ]);
    assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
    const state = store.read(identity.token, session => snapshot(session.account));
    assert.equal(state.workforce.expeditions.length, 3);
    assert.equal(state.availableWorkers, 6);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('development API exposes one accelerated game clock with baseline rules and real-time abuse limits', async () => {
  let time = Date.UTC(2026, 0, 1);
  const start = time, store = new SqliteStore(':memory:', () => time, 20), server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  try {
    const created = await fetch(`${base}/session`, { method: 'POST', headers, body: '{}' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    let state = await (await fetch(`${base}/state`, { headers: { Cookie: cookie } })).json() as ApiState;
    assert.equal(state.clockSpeed, 20);
    assert.equal('growthMultiplier' in state, false);
    store.transaction(cookie.split('=')[1], session => {
      fundFixtureResources(session.account);
      automateFixtureCollections(session.account);
      session.account.game.dollars = 500 * dollarsScale;
      session.account.game.stock.wood = 60;
      session.account.game.explored = ['0,0', '-3,0', '3,0', '0,3'];
      const work = session.account.workforce!;
      if ('version' in work) {
        work.automatic = false; work.allocation.wood = 2;
      }
    });
    const action = (command: Command) => fetch(`${base}/actions`, {
      method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': state.csrf },
      body: JSON.stringify({ id: randomUUID(), revision: state.revision, command }),
    });
    state = await (await action({ type: 'upgrade' })).json() as ApiState;
    const yieldWood = state.workforce.crews.wood!.weeklyYield;
    assert.equal(state.rates.wood, yieldWood);
    time += 1000;
    state = await (await action({ type: 'assign', resource: 'wood', workers: 2 })).json() as ApiState;
    assert.equal(state.rates.wood, yieldWood);
    time = start + worldWeekMs / 20 - 1;
    state = await (await fetch(`${base}/state`, { headers: { Cookie: cookie } })).json() as ApiState;
    assert.equal(state.pending.wood, 0);
    time += 1;
    state = await (await fetch(`${base}/state`, { headers: { Cookie: cookie } })).json() as ApiState;
    assert.equal(state.serverTime, start + worldWeekMs);
    assert.equal(state.game.population, 12);
    assert.equal(state.pending.wood, 0);
    assert.equal(state.game.stock.wood, yieldWood);
    assert.deepEqual(state.environment, environmentAt(state.serverTime));
    store.transaction(cookie.split('=')[1], session => { session.account.pending.wood = 50 * 60000; });
    state = await (await action({ type: 'claim' })).json() as ApiState;
    assert.equal(state.game.stock.wood, yieldWood + 50);
    time += 499;
    const rejected = await action({ type: 'claim' });
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('retry-after'), '1');
    assert.match((await rejected.json()).error, /half a second/);
    time += 1;
    store.transaction(cookie.split('=')[1], session => {
      session.account.game.dollars += 10000 * 10000;
      session.account.game.stock.water = 1000000;
    });
    state = await (await action({ type: 'invite' })).json() as ApiState;
    assert.equal(state.game.population, 12);
    const firstArrivals = state.recruitment!.population;
    assert.equal(state.inviteReadyAt - state.serverTime, worldWeekMs);
    time += worldWeekMs / 20 - 1;
    assert.equal((await action({ type: 'invite' })).status, 409);
    time += 1;
    state = await (await fetch(`${base}/state`, { headers: { Cookie: cookie } })).json() as ApiState;
    state = await (await action({ type: 'invite' })).json() as ApiState;
    assert.equal(state.game.population, 12 + firstArrivals);
    assert.equal(state.recruitment!.population * 50, state.recruitmentDollars);
    assert.equal(state.inviteReadyAt - state.serverTime, worldWeekMs);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
test('HTTP development accepts explicit loopback aliases only on the configured port', async () => {
  const store = new SqliteStore(':memory:'), server = createApi(store, origin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const headers = { Origin: `http://${host}:5173`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
      const session = await fetch(`${base}/session`, { method: 'POST', headers, body: '{}' });
      assert.equal(session.status, 201);
      const cookie = session.headers.get('set-cookie')!.split(';')[0];
      const { csrf } = await session.json();
      store.transaction(cookie.split('=')[1], session => fundFixtureResources(session.account));
      const action = await fetch(`${base}/actions`, {
        method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ id: randomUUID(), revision: 0, command: { type: 'upgrade' } }),
      });
      assert.equal(action.status, 200);
      assert.equal((await action.json()).game.stage, 0);
    }
    for (const rejected of ['http://localhost:5174', 'https://localhost:5173', 'http://localhost.evil.example:5173', 'http://127.0.0.2:5173', 'null']) {
      const forbidden = await fetch(`${base}/session`, {
        method: 'POST', headers: { Origin: rejected, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(forbidden.status, 403);
    }
    const crossSite = await fetch(`${base}/session`, {
      method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}',
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
