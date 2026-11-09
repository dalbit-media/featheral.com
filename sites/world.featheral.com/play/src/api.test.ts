import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connect, linkWorldProfile, readAutoCraft, readChatProfile, readMarket, sendMarket } from './api.ts';
import { createAccount, snapshot } from '../server/economy.ts';

function merchantState() {
  return { ...snapshot(createAccount(1000000)), csrf: 'csrf', clockSpeed: 1 as const, population: { global: 0, federation: null } };
}

test('merchant review and execution allow 60 seconds while ordinary market requests retain 10 seconds', async t => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ autoCraft: {} }));
  await readAutoCraft();
  await sendMarket(merchantState(), { type: 'auto-craft', fingerprint: 'review' });
  await readMarket('wood', 1);
  assert.deepEqual(deadlines, [60000, 60000, 10000]);
});

test('lost merchant responses retry the exact receipt ID, revision and fingerprint without duplicate spending', async t => {
  const requests: RequestInit[] = [], deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(init);
    if (requests.length === 1) throw new DOMException('signal timed out', 'TimeoutError');
    return Response.json({ autoCraft: { estimatedProfit: 42 } });
  });
  const state = merchantState();
  const result = await sendMarket(state, { type: 'auto-craft', fingerprint: 'review' });
  assert.equal(result.autoCraft?.estimatedProfit, 42);
  assert.deepEqual(deadlines, [60000, 60000]);
  assert.equal(requests[0].body, requests[1].body);
  const body = JSON.parse(String(requests[0].body));
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.revision, state.revision);
  assert.deepEqual(body.command, { type: 'auto-craft', fingerprint: 'review' });
});

test('merchant timeouts distinguish an unspent preview from a potentially completed confirmation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new DOMException('signal timed out', 'TimeoutError');
  });
  await assert.rejects(readAutoCraft(), /Nothing was consumed/);
  assert.equal(calls, 1);
  await assert.rejects(sendMarket(merchantState(), { type: 'auto-craft', fingerprint: 'review' }), /may have completed.*Refresh inventory/);
  assert.equal(calls, 3);
});

test('merchant HTTP failures surface immediately without retrying a rejected operation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: 'Quote changed. Review again.' }, { status: 409 });
  });
  await assert.rejects(sendMarket(merchantState(), { type: 'auto-craft', fingerprint: 'review' }), /Quote changed/);
  assert.equal(calls, 1);
});

test('market quantity reads preserve manual requests and encode optional budget and limit price', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    return Response.json({ market: {} });
  });
  await readMarket('metal', 123);
  await readMarket('metal', 1, { percent: 25 });
  await readMarket('torch', 1, { percent: 100, price: 3.0001 });
  assert.deepEqual(requests, [
    '/api/dollar/game/market?asset=metal&quantity=123',
    '/api/dollar/game/market?asset=metal&quantity=1&budgetPercent=25',
    '/api/dollar/game/market?asset=torch&quantity=1&budgetPercent=100&price=3.0001',
  ]);
});

test('World profile reads, unlinking and reconnect accept a null profile', async t => {
  const requests: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Response.json(null);
  });

  assert.equal(await readChatProfile(), null);
  assert.equal(await linkWorldProfile('csrf', null), null);
  assert.equal(await readChatProfile(), null);
  assert.deepEqual(requests.map(request => request.url), [
    '/api/chat/profile', '/api/chat/profile', '/api/chat/profile',
  ]);
  assert.equal(requests[1].init?.method, 'POST');
  assert.equal(requests[1].init?.body, '{}');
});

test('null API errors preserve the HTTP failure and allow session reconnection', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(null, { status: 503 }));
  await assert.rejects(readChatProfile(), /API failed \(503\)\./);

  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    if (requests.length === 1) return Response.json(null, { status: 401 });
    if (requests.length === 2) return Response.json({ csrf: 'csrf' });
    return Response.json({ revision: 1 });
  });
  assert.equal((await connect()).revision, 1);
  assert.deepEqual(requests, ['/api/dollar/game/state', '/api/session', '/api/dollar/game/state']);
});

test('successful state responses still publish the public World account', async t => {
  const accountId = '0x' + 'ab'.repeat(32);
  const saved = new Map<string, string>(), events: Event[] = [];
  for (const [key, value] of Object.entries({
    localStorage: { setItem: (name: string, value: string) => saved.set(name, value) },
    window: { dispatchEvent: (event: Event) => events.push(event) },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ fundAccountId: accountId }));
  assert.equal((await connect()).fundAccountId, accountId);
  assert.equal(saved.get('featheral-world-account'), accountId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'featheral:world-account');
  assert.equal((events[0] as CustomEvent<string>).detail, accountId);
});
