import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Wallet } from 'ethers';
import { createApi } from './http.ts';
import { SqliteStore } from './store.ts';
import { ApiError } from './economy.ts';
import { verifyWorldProfileLink, worldProfileReader } from './world-profile.ts';
import { worldProfileLinkMessage } from '../src/world-profile.ts';
import type { WorldProfile } from '../src/world-profile.ts';

test('World profile links verify wallet ownership, freshness and the exact Play session', async () => {
  const wallet = Wallet.createRandom(), other = Wallet.createRandom(), issuedAt = Date.now(), csrf = 'session-one';
  const link = { address: wallet.address, issuedAt, signature: await wallet.signMessage(worldProfileLinkMessage(wallet.address, csrf, issuedAt)) };
  assert.equal(verifyWorldProfileLink(link, csrf, issuedAt), wallet.address);
  for (const [body, session, now] of [
    [{ ...link, address: other.address }, csrf, issuedAt], [link, 'session-two', issuedAt],
    [link, csrf, issuedAt + 300001], [{ ...link, username: 'forged' }, csrf, issuedAt],
    [{ ...link, signature: '0xbad' }, csrf, issuedAt], [{ ...link, issuedAt: NaN }, csrf, issuedAt],
  ] as const) assert.throws(() => verifyWorldProfileLink(body, session, now), error => error instanceof ApiError);
});

test('Play uses authoritative World profiles, keeps save and identity, and revokes chat on unlink', async () => {
  const store = new SqliteStore(':memory:'), wallet = Wallet.createRandom();
  let world: WorldProfile | null = { username: 'World.Name-1234567890123', avatar: '' };
  let unavailable = false;
  const server = createApi(store, 'http://127.0.0.1', async address => {
    assert.equal(address, wallet.address);
    if (unavailable) throw new ApiError(503, 'World profile service is unavailable.');
    return world;
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('No test listener');
  const base = `http://127.0.0.1:${bound.port}`;
  const session = store.create(), owner = store.chatSession(session.token).owner;
  store.transaction(session.token, session => { session.account.game.stage = 0; });
  const before = store.read(session.token, state => structuredClone(state.account));
  const legacy = store.chat.rename(owner, 'OldPlayName', Date.now());
  const post = (body: unknown, selected = session, csrf = selected.csrf) => fetch(`${base}/api/chat/profile`, {
    method: 'POST', headers: { Origin: 'http://127.0.0.1', Cookie: `terra-dev=${selected.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
  const get = () => fetch(`${base}/api/chat/profile`, { headers: { Cookie: `terra-dev=${session.token}` } });
  const sign = async (csrf = session.csrf) => {
    const issuedAt = Date.now();
    return { address: wallet.address, issuedAt, signature: await wallet.signMessage(worldProfileLinkMessage(wallet.address, csrf, issuedAt)) };
  };
  try {
    assert.equal(await (await get()).json(), null);
    assert.equal((await post({ nickname: 'ImpersonatedWorld' })).status, 400);
    const link = await sign();
    assert.equal((await post(link, session, 'wrong-csrf')).status, 403);
    const response = await post(link);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: legacy.id, nickname: world.username, address: wallet.address });
    const directory = store.chatDirectory.directory(owner, Date.now());
    assert.equal(directory.settlements[0].name, world.username);
    const live = await fetch(`${base}/api/chat/events`, { headers: { Cookie: `terra-dev=${session.token}` } });
    assert.equal(live.status, 200);
    const stream = live.body!.getReader();
    const welcome = await stream.read();
    assert.match(new TextDecoder().decode(welcome.value), /World.Name-1234567890123/);
    const sent = await fetch(`${base}/api/chat/messages`, {
      method: 'POST', headers: { Origin: 'http://127.0.0.1', Cookie: `terra-dev=${session.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
      body: JSON.stringify({ id: randomUUID(), text: 'World identity message', createdAt: Date.now() }),
    });
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).nickname, world.username);
    const otherSession = store.create();
    assert.equal((await post(link, otherSession)).status, 401);
    assert.equal((await post(await sign(otherSession.csrf), otherSession)).status, 200);
    world = { username: 'Updated.World', avatar: '' };
    assert.equal((await (await get()).json()).nickname, world.username);
    assert.deepEqual(store.read(session.token, state => state.account), before);
    unavailable = true;
    assert.equal((await get()).status, 503);
    assert.equal((await post({})).status, 200, 'disconnect must still work during a World service outage');
    while (!(await stream.read()).done) {}
    assert.match(store.chat.history(directory.rooms[0].id), /World identity message/, 'unlink keeps historical messages');
    unavailable = false;
    assert.equal(await (await get()).json(), null);
    assert.equal(store.chat.profile(owner)?.id, legacy.id, 'unlink preserves the original chat identifier');
    assert.equal(store.chatDirectory.directory(owner, Date.now()).settlements[0].name, 'Unnamed settlement');
    const events = await fetch(`${base}/api/chat/events`, { headers: { Cookie: `terra-dev=${session.token}` } });
    assert.equal(events.status, 409);
    assert.equal((await events.json()).error, 'Use your World profile in the avatar menu to join chat.');
    assert.equal((await post(await sign())).status, 200);
    assert.equal(store.chat.profile(owner)?.id, legacy.id);
    world = null;
    assert.equal(await (await get()).json(), null);
    assert.equal((await post(await sign())).status, 409);
    assert.deepEqual(store.read(session.token, state => state.account), before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('World profile reads validate upstream responses instead of accepting unavailable or malformed profiles', async () => {
  let body = '{"profile":{"username":"World.Name","avatar":""}}', status = 200;
  const server = createServer((_request, response) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(body); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('No test listener');
  const read = worldProfileReader(`http://127.0.0.1:${bound.port}`);
  try {
    assert.deepEqual(await read(`0x${'1'.repeat(40)}`), { username: 'World.Name', avatar: '' });
    body = '{"profile":null}'; assert.equal(await read('test'), null);
    for (const invalid of ['{}', '{"profile":{"username":"<script>","avatar":""}}', 'not JSON']) {
      body = invalid; await assert.rejects(read('test'), error => error instanceof ApiError && error.status === 503);
    }
    status = 503; await assert.rejects(read('test'), error => error instanceof ApiError && error.status === 503);
    status = 404; assert.equal(await read('test'), null);
    assert.throws(() => worldProfileReader('https://world.example/path'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
