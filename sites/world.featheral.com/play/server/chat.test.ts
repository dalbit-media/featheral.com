import { strict as assert } from 'node:assert';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import sqlite from '../../../../services/database/sqlite.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatArchive, ChatHub, chatNickname, chatSubmission } from './chat.ts';
import type { ChatSink } from './chat.ts';
import { ApiError } from './economy.ts';
import { createApi } from './http.ts';
import { SqliteStore } from './store.ts';
import type { ChatMessage } from '../src/chat.ts';

class Sink extends EventEmitter implements ChatSink {
  frames: string[] = [];
  writableLength = 0;
  destroyed = false;
  block = false;
  write(value: string): boolean { this.frames.push(value); return !this.block; }
  end(): void { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
const request = (text: string, createdAt: number) => ({ id: randomUUID(), text, createdAt });
test('chat payloads support Korean names, canonical uniqueness and strict bounded Unicode messages', () => {
  assert.equal(chatNickname({ nickname: '  한글   닉네임  ' }), '한글 닉네임');
  for (const nickname of ['', 'a', 'x'.repeat(21), '<script>', ' bad\nname', '이름\u202e'])
    assert.throws(() => chatNickname({ nickname }), status(400));
  assert.throws(() => chatNickname({ nickname: '닉네임', owner: 'forged' }), status(400));
  const body = request('안녕하세요 😀\n반갑습니다', 1);
  assert.deepEqual(chatSubmission(body), body);
  assert.equal(chatSubmission(request('😀'.repeat(300), 0)).text.length, 600);
  for (const text of ['', ' \n ', 'x'.repeat(301), '\u0000hello', 'hello\tworld', 'hello\u0085world', 'name\u202e', 'a\nb\nc\nd\ne\nf'])
    assert.throws(() => chatSubmission(request(text, 0)), status(400));
  assert.throws(() => chatSubmission({ ...body, createdAt: -1 }), status(400));
  assert.throws(() => chatSubmission({ ...body, id: 'invalid' }), status(400));
  assert.throws(() => chatSubmission({ ...body, author: 'forged' }), status(400));
});
test('chat names and latest 100 messages persist; retry receipts survive restart without changing game state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-chat-')), path = join(dir, 'chat.sqlite');
  let time = Date.now(), store = new SqliteStore(path), identity = store.create(), owner = store.chatSession(identity.token).owner;
  let hub = new ChatHub(store.chat, () => time);
  const before = store.read(identity.token, session => structuredClone(session.account));
  let last = request('hello', time), message: ChatMessage | null = null;
  try {
    const profile = store.chat.rename(owner, chatNickname({ nickname: 'Pioneer' }), time);
    assert.throws(() => store.chat.rename('other', 'PIONEER', time), status(409));
    assert.deepEqual(store.chat.rename(owner, 'Pioneer', time), profile);
    assert.throws(() => store.chat.rename(owner, 'Another', time + 1), status(429));
    hub.join(owner, time + 86400000, new Sink());
    for (let i = 0; i < 105; i++) {
      time += 3000; last = request(`메시지 ${i}`, time);
      message = hub.send(owner, last); hub.flush();
    }
    assert.equal(JSON.parse(store.chat.historyFrame.split('data: ')[1]).length, 100);
    assert.deepEqual(hub.send(owner, last), message);
    assert.throws(() => hub.send(owner, { ...last, text: 'changed' }), status(409));
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    hub.close(); store.close(); store = new SqliteStore(path); hub = new ChatHub(store.chat, () => time);
    assert.deepEqual(store.chat.profile(owner), profile);
    const sink = new Sink(); hub.join(owner, time + 86400000, sink);
    assert.equal(JSON.parse(sink.frames[1].split('data: ')[1]).length, 100);
    assert.deepEqual(hub.send(owner, last), message);
    assert.throws(() => hub.send(owner, request('too fast after reconnect', time)), status(429));
    time += 3000;
    assert.throws(() => hub.send(owner, request('too old', time - 120001)), status(409));
    assert.throws(() => hub.send(owner, request('future', time + 5001)), status(409));
  } finally { hub.close(); store.close(); rmSync(dir, { recursive: true }); }
});
test('exactly 1,000 users receive one shared batched broadcast; user 1,001 is rejected and duplicate tabs replace, not add users', t => {
  const db = sqlite.open(':memory:'), archive = new ChatArchive(db);
  let time = 0;
  const hub = new ChatHub(archive, () => time), sinks: Sink[] = [], start = performance.now();
  try {
    for (let i = 0; i < 1001; i++) archive.rename(`owner-${i}`, `Player-${i}`, time);
    for (let i = 0; i < 1000; i++) { const sink = new Sink(); sinks.push(sink); hub.join(`owner-${i}`, 1000000, sink); }
    assert.equal(hub.online, 1000);
    assert.throws(() => hub.join('owner-1000', 1000000, new Sink()), status(503));
    assert.equal(hub.online, 1000);
    const replacement = new Sink(); hub.join('owner-0', 1000000, replacement);
    assert.ok(sinks[0].destroyed);
    assert.match(sinks[0].frames.at(-1)!, /event: replaced/);
    assert.equal(hub.online, 1000); sinks[0] = replacement;
    for (let i = 0; i < 10; i++) hub.send(`owner-${i}`, request(`broadcast ${i}`, time));
    assert.throws(() => hub.send('owner-10', request('global throttle', time)), status(429));
    hub.flush();
    const broadcast = sinks[0].frames.at(-1)!;
    for (const sink of sinks) assert.equal(sink.frames.at(-1), broadcast);
    assert.equal(JSON.parse(broadcast.split('\n')[1].slice(6)).length, 10);
    assert.throws(() => hub.send('owner-0', request('personal throttle', time)), status(429));
    time = 59000; hub.ping('owner-0'); time = 60000; hub.sweep();
    assert.equal(hub.online, 1);
    hub.join('owner-1000', 1000000, new Sink()); assert.equal(hub.online, 2);
    t.diagnostic(`1,000 subscribers + 10-message fan-out: ${(performance.now() - start).toFixed(1)} ms; ${Buffer.byteLength(broadcast)} encoded bytes per subscriber.`);
  } finally { hub.close(); db.close(); }
});
test('slow consumers are disconnected with bounded buffering; drain, expiry and shutdown release capacity', () => {
  const db = sqlite.open(':memory:'), archive = new ChatArchive(db);
  let time = 0; const hub = new ChatHub(archive, () => time);
  try {
    for (const owner of ['sender', 'slow', 'healthy', 'expired']) archive.rename(owner, owner, time);
    const slow = new Sink(), healthy = new Sink();
    hub.join('sender', 1000000, new Sink()); hub.join('slow', 1000000, slow); hub.join('healthy', 1000000, healthy);
    hub.flush(); slow.block = true;
    hub.send('sender', request('first', time)); hub.flush();
    assert.equal(hub.online, 3);
    time += 3000; hub.send('sender', request('second', time)); hub.flush();
    assert.ok(slow.destroyed); assert.equal(hub.online, 2);
    healthy.block = true; time += 3000; hub.send('sender', request('third', time)); hub.flush();
    healthy.block = false; healthy.emit('drain');
    time += 3000; hub.send('sender', request('fourth', time)); hub.flush();
    assert.equal(hub.online, 2);
    healthy.writableLength = 262145; hub.sweep();
    time += 15000; hub.sweep(); assert.ok(healthy.destroyed);
    const expired = new Sink(); hub.join('expired', time + 1, expired); time++; hub.sweep();
    assert.ok(expired.destroyed);
    hub.close(); assert.equal(hub.online, 0);
    assert.throws(() => hub.ping('sender'), status(409));
  } finally { hub.close(); db.close(); }
});
test('pending batches and receipt retention stay bounded under sustained traffic', () => {
  const db = sqlite.open(':memory:'), archive = new ChatArchive(db);
  let time = 0; const hub = new ChatHub(archive, () => time);
  try {
    archive.rename('sender', 'Sender', 0); hub.join('sender', 10000000, new Sink());
    for (let i = 0; i < 100; i++) { time += 3000; hub.send('sender', request(`message ${i}`, time)); }
    time += 3000; assert.throws(() => hub.send('sender', request('overflow', time)), status(429));
    hub.flush(); hub.send('sender', request('after flush', time));
    assert.equal(Number(db.prepare('SELECT count(*) AS total FROM chat_messages').get()!.total), 100);
    assert.ok(Number(db.prepare('SELECT count(*) AS total FROM chat_receipts').get()!.total) <= 101);
  } finally { hub.close(); db.close(); }
});
test('global chat is available before settlement but never bypasses session expiry or private-room permissions', () => {
  const store = new SqliteStore(':memory:'), identity = store.create();
  try {
    const session = store.chatSession(identity.token), now = Date.now();
    assert.deepEqual(store.chatDirectory.authorize(session.owner, 'global', now),
      { id: 'global', kind: 'global', name: 'Global chat' });
    assert.throws(() => store.chatDirectory.authorize('missing', 'global', now), status(401));
    assert.throws(() => store.chatDirectory.authorize(session.owner, 'global', session.expires + 1), status(401));
    assert.throws(() => store.chatDirectory.authorize(session.owner, 'forged-private-room', now), status(403));
  } finally { store.close(); }
});
for (const channel of ['nearby', 'global']) test(`HTTP ${channel} chat uses session, Origin and CSRF protections; real SSE delivers and replaces connections without game writes`, async () => {
  const store = new SqliteStore(':memory:'), a = store.create(), b = store.create();
  for (const identity of [a, b]) store.transaction(identity.token, session => {
    session.account.game.stage = 0; session.account.game.population = 12; session.account.game.home = { x: 0, y: 0 };
    if (channel === 'global' && identity === b) session.account.game.home = { x: 9000, y: 9000 };
  });
  const room = channel === 'global' ? 'global' : store.chatDirectory.directory(store.chatSession(a.token).owner, Date.now()).rooms.find(room => room.settlement ===
    store.chatDirectory.directory(store.chatSession(a.token).owner, Date.now()).ownSettlement)!.id;
  const server = createApi(store, 'http://127.0.0.1:5173');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/chat`, origin = 'http://127.0.0.1:5173';
  const controllers: AbortController[] = [];
  const headers = (identity = a) => ({ Cookie: `terra-dev=${identity.token}`, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrf });
  const post = (path: string, body: unknown, identity = a) => fetch(base + path, { method: 'POST', headers: headers(identity), body: JSON.stringify(body) });
  const stream = async (identity = a) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(base + `/events?room=${room}`, { headers: headers(identity), signal: controller.signal });
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body!.getReader(), decoder = new TextDecoder(), queue: string[] = [];
    let buffer = '';
    return async (event: string): Promise<unknown> => {
      for (;;) {
        const index = queue.findIndex(value => value.startsWith(`event: ${event}\n`));
        if (index >= 0) return JSON.parse(queue.splice(index, 1)[0].split('\ndata: ')[1]);
        const next = await reader.read(); assert.equal(next.done, false);
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split('\n\n'); buffer = frames.pop()!; queue.push(...frames);
      }
    };
  };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}?room=${room}`)).status, 401);
    assert.equal((await fetch(`${base}/events?room=${room}`, { headers: headers() })).status, 409);
    assert.equal((await fetch(base + '/events', { headers: headers() })).status, 409);
    assert.equal((await fetch(base + '/profile', { method: 'POST', headers: { ...headers(), Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/profile', { method: 'POST', headers: { ...headers(), 'X-CSRF-Token': 'bad' }, body: '{}' })).status, 403);
    assert.equal((await post('/profile', { nickname: '플레이어', owner: 'forged' })).status, 400);
    const profile = await (await post('/profile', { nickname: '플레이어' })).json();
    assert.equal((await post('/profile', { nickname: '플레이어' }, b)).status, 409);
    assert.equal((await post('/profile', { nickname: '이웃' }, b)).status, 200);
    const before = store.read(a.token, session => structuredClone(session.account));
    const first = await stream(); assert.deepEqual(await first('history'), []);
    const welcome = await first('welcome') as { online: number; connected: boolean }; assert.equal(welcome.online, 1); assert.equal(welcome.connected, true);
    const second = await stream(b); await second('welcome');
    const body = request('<img src=x onerror=alert(1)> 안녕', Date.now()), sent = await post('/messages', body);
    assert.equal(sent.status, 200); const message = await sent.json();
    assert.equal(message.author, profile.id); assert.equal(message.text, body.text);
    const batch = await second('messages') as ChatMessage[]; assert.deepEqual(batch, [message]);
    assert.deepEqual(await (await post('/messages', body)).json(), message);
    assert.equal((await post('/messages', { ...body, text: 'different' })).status, 409);
    const limited = await post('/messages', request('too fast', Date.now()));
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '3');
    assert.equal((await post('/ping', {})).status, 200);
    const replacement = await stream(); assert.deepEqual(await first('replaced'), {});
    assert.equal((await replacement('welcome') as { online: number }).online, 2);
    const info = await (await fetch(base, { headers: headers() })).json();
    assert.deepEqual(Object.keys(info).sort(), ['capacity', 'connected', 'online', 'ownSettlement', 'profile', 'room', 'rooms', 'serverTime', 'settlements']);
    assert.equal(info.capacity, 1000); assert.equal(info.connected, true);
    const selected = await (await fetch(`${base}?room=${room}`, { headers: headers() })).json();
    assert.equal(selected.room.id, room);
    assert.equal(selected.room.kind, channel === 'global' ? 'global' : 'explore');
    assert.ok(!JSON.stringify(info).includes(a.token));
    assert.deepEqual(store.read(a.token, session => session.account), before);
  } finally {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});
