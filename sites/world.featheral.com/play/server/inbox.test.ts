import { strict as assert } from 'node:assert';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatHub } from './chat.ts';
import type { ChatSink } from './chat.ts';
import { ApiError } from './economy.ts';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';

class Sink extends EventEmitter implements ChatSink {
  readonly frames: string[] = [];
  writableLength = 0;
  destroyed = false;
  write(frame: string): boolean { this.frames.push(frame); return true; }
  end(): void { this.destroyed = true; this.emit('close'); }
}
const denied = (error: unknown) => error instanceof ApiError && error.status === 403;
function fixture(store: SqliteStore, nickname: string, x: number, federation: string | null) {
  const identity = store.create();
  store.transaction(identity.token, session => {
    session.account.game.stage = 0; session.account.game.population = 12;
    session.account.game.home = { x, y: 0 }; session.account.game.position = { x: 0, y: 0 };
    session.account.game.federation = federation;
  });
  const owner = store.chatSession(identity.token).owner;
  store.chat.rename(owner, nickname, Date.now());
  return { ...identity, owner };
}
test('inbox lists only nearby public settlement/federation rooms, never visitor rooms or account identifiers', () => {
  const store = new SqliteStore(':memory:');
  try {
    const a = fixture(store, 'Owner', 0, null), b = fixture(store, 'Neighbor', 4, 'Nearby union');
    const far = fixture(store, 'Distant', 5, 'Distant union');
    const directory = store.chatDirectory.directory(a.owner, Date.now());
    assert.deepEqual(directory.settlements.map(value => value.name).sort(), ['Neighbor', 'Owner']);
    assert.equal(directory.rooms.some(value => value.kind === 'settlement'), false);
    assert.deepEqual(directory.rooms.filter(value => value.kind === 'federation').map(value => value.name), ['Nearby union']);
    for (const secret of [a.token, a.csrf, a.owner, b.owner, far.owner]) assert.equal(JSON.stringify(directory).includes(secret), false);
    const nearRoom = directory.rooms.find(value => value.name === 'Neighbor')!;
    assert.ok(store.chatDirectory.authorize(a.owner, nearRoom.id, Date.now()));
    const farRoom = store.chatDirectory.directory(far.owner, Date.now()).rooms.find(value => value.settlement ===
      store.chatDirectory.directory(far.owner, Date.now()).ownSettlement)!;
    assert.throws(() => store.chatDirectory.authorize(a.owner, farRoom.id, Date.now()), denied);
    assert.throws(() => store.chatDirectory.authorize(a.owner, nearRoom.settlement!, Date.now()), denied);
    store.chatDirectory.visit(a.owner, nearRoom.settlement!, Date.now());
    assert.equal(store.chatDirectory.authorize(a.owner, nearRoom.settlement!, Date.now()).kind, 'settlement');
    assert.equal(store.chatDirectory.directory(a.owner, Date.now()).rooms.some(value => value.kind === 'settlement'), false);
    assert.throws(() => store.chatDirectory.visit(a.owner, farRoom.settlement!, Date.now()), denied);
  } finally { store.close(); }
});
test('room history, live broadcasts and retries remain separate; movement revokes public access before delivery', () => {
  let now = Date.now();
  const store = new SqliteStore(':memory:'), a = fixture(store, 'Owner', 0, null), b = fixture(store, 'Neighbor', 2, 'Near union');
  const c = fixture(store, 'Visitor', 3, null);
  const hub = new ChatHub(store.chat, () => now, (owner, room) => { store.chatDirectory.authorize(owner, room, now); });
  try {
    const directory = store.chatDirectory.directory(a.owner, now), publicRoom = directory.rooms.find(value => value.name === 'Neighbor' && value.kind === 'explore')!;
    const privateRoom = publicRoom.settlement!, federation = directory.rooms.find(value => value.kind === 'federation')!;
    const before = store.read(a.token, session => structuredClone(session.account));
    const publicSink = new Sink(), privateSink = new Sink();
    hub.join(a.owner, a.expires, publicSink, publicRoom.id);
    hub.join(b.owner, b.expires, privateSink, privateRoom);
    const privateRequest = { id: randomUUID(), text: 'Visitor-only conversation', createdAt: now };
    const privateMessage = hub.send(b.owner, privateRequest, privateRoom);
    hub.flush();
    assert.equal(publicSink.frames.some(value => value.includes(privateRequest.text)), false);
    assert.ok(privateSink.frames.some(value => value.includes(privateRequest.text)));
    assert.throws(() => hub.join(c.owner, c.expires, new Sink(), privateRoom), denied);
    store.chatDirectory.visit(c.owner, privateRoom, now);
    const visitor = new Sink(); hub.join(c.owner, c.expires, visitor, privateRoom);
    assert.ok(visitor.frames.some(value => value.includes(privateRequest.text)));
    assert.deepEqual(hub.send(b.owner, privateRequest, privateRoom), privateMessage);
    assert.throws(() => hub.send(b.owner, privateRequest, publicRoom.id), error => error instanceof ApiError && error.status === 409);
    const publicRequest = { id: randomUUID(), text: 'Public exploration tip', createdAt: now };
    hub.send(a.owner, publicRequest, publicRoom.id); hub.flush();
    assert.ok(publicSink.frames.some(value => value.includes(publicRequest.text)));
    assert.equal(visitor.frames.some(value => value.includes(publicRequest.text)), false);
    assert.equal(store.chat.history(publicRoom.id).includes(privateRequest.text), false);
    assert.equal(store.chat.history(privateRoom).includes(publicRequest.text), false);
    assert.deepEqual(store.read(a.token, session => session.account), before);
    store.transaction(a.token, session => { session.account.game.position.x = 20; });
    assert.throws(() => store.chatDirectory.authorize(a.owner, publicRoom.id, now), denied);
    assert.throws(() => store.chatDirectory.authorize(a.owner, federation.id, now), denied);
    hub.sweep(); assert.ok(publicSink.destroyed);
    assert.equal(store.chatDirectory.directory(a.owner, now).rooms.some(value => value.id === publicRoom.id), false);
    now += 3000;
    hub.send(b.owner, { id: randomUUID(), text: 'Still private', createdAt: now }, privateRoom); hub.flush();
    assert.ok(visitor.frames.some(value => value.includes('Still private')));
  } finally { hub.close(); store.close(); }
});
test('visitor admission, room IDs and separate histories persist through restart without exposing private channels', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-inbox-')), path = join(directory, 'test.sqlite');
  let store = new SqliteStore(path);
  let hub: ChatHub | undefined;
  try {
    const a = fixture(store, 'Owner', 0, null), b = fixture(store, 'Neighbor', 2, null);
    const room = store.chatDirectory.directory(a.owner, Date.now()).rooms.find(value => value.name === 'Neighbor')!;
    store.chatDirectory.visit(a.owner, room.settlement!, Date.now());
    hub = new ChatHub(store.chat); hub.join(a.owner, a.expires, new Sink(), room.settlement);
    hub.send(a.owner, { id: randomUUID(), text: 'Saved visitor discussion', createdAt: Date.now() }, room.settlement);
    hub.close(); hub = undefined; store.close(); store = new SqliteStore(path);
    assert.equal(store.chatDirectory.authorize(a.owner, room.settlement!, Date.now()).id, room.settlement);
    assert.ok(store.chat.history(room.settlement).includes('Saved visitor discussion'));
    assert.equal(store.chat.history(room.id).includes('Saved visitor discussion'), false);
    assert.equal(store.chatDirectory.directory(b.owner, Date.now()).rooms.some(value => value.id === room.settlement), false);
  } finally { hub?.close(); store.close(); rmSync(directory, { recursive: true }); }
});
test('HTTP visitor access requires explicit CSRF admission and disallows distant or forged room queries', async () => {
  const store = new SqliteStore(':memory:'), a = fixture(store, 'Owner', 0, null), b = fixture(store, 'Neighbor', 2, null);
  const server = createApi(store, 'http://localhost:5173');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/chat`;
  const headers = { Cookie: `terra-dev=${a.token}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-CSRF-Token': a.csrf };
  try {
    const room = store.chatDirectory.directory(b.owner, Date.now()).ownSettlement!;
    assert.equal((await fetch(`${base}?room=${room}`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/visit?settlement=${room}`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/visit`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'bad' }, body: JSON.stringify({ settlement: room }) })).status, 403);
    assert.equal((await fetch(`${base}/visit`, { method: 'POST', headers, body: JSON.stringify({ settlement: room, owner: b.owner }) })).status, 400);
    assert.equal((await fetch(`${base}/visit`, { method: 'POST', headers, body: JSON.stringify({ settlement: room }) })).status, 200);
    const info = await (await fetch(`${base}?room=${room}`, { headers })).json();
    assert.equal(info.room.kind, 'settlement');
    assert.equal(info.rooms.some((value: { kind: string }) => value.kind === 'settlement'), false);
    const summary = await (await fetch(`${base}/visit?settlement=${room}`, { headers })).json();
    assert.deepEqual(Object.keys(summary).sort(), ['federation', 'id', 'name', 'own', 'population', 'x', 'y']);
    assert.equal((await fetch(`${base}?room=${room}&room=${room}`, { headers })).status, 400);
    assert.equal((await fetch(`${base}?room=${room}&owner=${a.owner}`, { headers })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('avatar profile reads and writes work before settling without exposing rooms or mutating gameplay', async () => {
  const store = new SqliteStore(':memory:'), identity = store.create();
  const server = createApi(store, 'http://localhost:5173');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/chat`;
  const headers = { Cookie: `terra-dev=${identity.token}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrf };
  const before = store.read(identity.token, session => structuredClone(session.account));
  try {
    assert.equal((await fetch(`${base}/profile`)).status, 401);
    assert.equal(await (await fetch(`${base}/profile`, { headers })).json(), null);
    assert.equal((await fetch(`${base}/profile?room=global`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/profile`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'bad' }, body: '{"nickname":"Pioneer"}' })).status, 403);
    const response = await fetch(`${base}/profile`, { method: 'POST', headers, body: '{"nickname":"Pioneer"}' });
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.nickname, 'Pioneer');
    assert.deepEqual(Object.keys(profile).sort(), ['id', 'nickname']);
    assert.deepEqual(await (await fetch(`${base}/profile`, { headers })).json(), profile);
    assert.deepEqual((await (await fetch(`${base}/directory`, { headers })).json()).rooms, []);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
