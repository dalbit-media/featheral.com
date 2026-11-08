import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connect, linkWorldProfile, readChatProfile } from './api.ts';

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
