import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from './store.ts';
import { WorldAtlas } from './atlas.ts';
import { accrue, createAccount } from './economy.ts';
import { inventory } from './inventory.ts';
import { createApi } from './http.ts';
import { dollarsScale } from '../src/dollars.ts';
import { marketBasePrice } from '../src/market.ts';
import { settlementDistance } from '../src/atlas.ts';
import { worldWeekMs } from '../src/environment.ts';
import type { AtlasSnapshot } from '../src/atlas.ts';

test('atlas includes all saved players, migrates unique persistent locations and never changes gameplay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'world-atlas-')), path = join(directory, 'game.sqlite');
  let db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE chat_profiles(owner TEXT PRIMARY KEY,nickname TEXT);
      CREATE TABLE market_orders(owner TEXT,asset TEXT,side TEXT,price INTEGER,remaining INTEGER,status TEXT)`);
    for (const id of ['first', 'second', 'unsettled']) {
      const account = createAccount(1000000);
      if (id !== 'unsettled') {
        account.game.stage = 3; account.game.home = { x: 0, y: 0 };
        account.game.population = 100; account.game.federation = 'Aurora Concord';
      }
      db.prepare('INSERT INTO sessions VALUES(?,?)').run(id, JSON.stringify({ account, csrf: 'private-csrf' }));
    }
    db.prepare('INSERT INTO chat_profiles VALUES(?,?)').run('first', 'AtlasBuilder');
    const before = db.prepare('SELECT data FROM sessions WHERE id=?').get('first')!.data;
    let atlas = new WorldAtlas(db).view('first', 1000000);
    assert.equal(atlas.entries.length, 3);
    const own = atlas.entries.find(entry => entry.yours)!;
    assert.equal(own.player, 'AtlasBuilder'); assert.equal(own.distance, 0);
    const other = atlas.entries.find(entry => entry.id !== own.id && entry.location)!;
    assert.notDeepEqual(own.location, other.location);
    assert.equal(other.distance, settlementDistance(own.location!, other.location!));
    assert.equal(atlas.federations.find(federation => federation.name === 'Aurora Concord')!.members, 2);
    assert.equal(atlas.federations.find(federation => federation.name === 'Aurora Concord')!.population, 200);
    assert.equal(atlas.entries.find(entry => !entry.location)!.settlement, null);
    assert.equal(db.prepare('SELECT data FROM sessions WHERE id=?').get('first')!.data, before);
    assert.ok(!JSON.stringify(atlas).includes('private-csrf'));
    const location = own.location, publicId = own.id;
    db.close(); db = new DatabaseSync(path);
    atlas = new WorldAtlas(db).view('first', 1000000);
    assert.deepEqual(atlas.entries.find(entry => entry.yours)!.location, location);
    assert.equal(atlas.entries.find(entry => entry.yours)!.id, publicId);
    assert.equal(new WorldAtlas(db).view('unsettled', 1000000).entries.every(entry => entry.distance === null), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('net worth preserves owned value across resource, item and FTH$ market escrow', () => {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now), identity = store.create();
  try {
    store.transaction(identity.token, session => {
      session.account.game.stage = 3; session.account.game.population = 0;
      session.account.game.stock = { wood: 10, water: 0, metal: 0, oil: 0 };
      session.account.game.dollars = 100 * dollarsScale;
      inventory(session.account).items = ['bench'];
      session.account.workforce!.automatic = false;
    });
    const expected = 100 + 10 * marketBasePrice('wood') + marketBasePrice('bench');
    assert.equal(store.atlasView(identity.token).entries[0].netWorth, expected);
    for (const command of [
      { type: 'limit', asset: 'wood', side: 'sell', quantity: 4, price: 1000 },
      { type: 'limit', asset: 'bench', side: 'sell', quantity: 1, price: 1000 },
      { type: 'limit', asset: 'oil', side: 'buy', quantity: 1, price: .0001 },
    ] as const) {
      now += 300;
      store.transaction(identity.token, (session, time, realTime, exchange, owner) =>
        exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision, command }, time, realTime));
      assert.equal(store.atlasView(identity.token).entries[0].netWorth, expected);
    }
  } finally { store.close(); }
});
test('zero-population relics stay hidden until exploration captures their stored resources and dollars once', () => {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now), explorer = store.create(), abandoned = store.create();
  try {
    store.transaction(explorer.token, (session, time) => {
      const account = session.account, game = account.game;
      game.stage = 0; game.population = 50; game.home = { x: 0, y: 0 };
      game.explored = ['0,0'];
      account.workforce!.automatic = false;
      account.workforce!.cycleAt = time + worldWeekMs;
    });
    store.transaction(abandoned.token, session => {
      const account = session.account, game = account.game;
      game.stage = 0; game.population = 0; game.home = { x: 0, y: 0 };
      game.stock = { wood: 11, water: 22, metal: 33, oil: 44 };
      game.dollars = 12 * dollarsScale + 3456;
    });

    const explorerAtlas = store.atlasView(explorer.token), relicAtlas = store.atlasView(abandoned.token);
    const explorerEntry = explorerAtlas.entries.find(entry => entry.yours)!;
    const hiddenRelic = explorerAtlas.entries.find(entry => !entry.yours)!;
    const relicEntry = relicAtlas.entries.find(entry => entry.yours)!;
    assert.equal(hiddenRelic.relic, false);
    assert.equal(hiddenRelic.location, null);
    assert.equal(hiddenRelic.settlement, null);
    assert.equal(hiddenRelic.netWorth, 0);
    assert.ok(explorerEntry.location && relicEntry.location);
    const target = { x: relicEntry.location.x - explorerEntry.location.x, y: relicEntry.location.y - explorerEntry.location.y };

    store.transaction(explorer.token, (session, time) => {
      const account = session.account, game = account.game;
      account.workforce!.expeditions = [{ ...target, workers: 2, startedAt: time, readyAt: time + 1, surveyRadius: 0 }];
    });
    const publicTotalsBefore = store.publicTotals();
    now += 2;
    store.transaction(explorer.token, (session, time, _realTime, _exchange, owner) => {
      accrue(session.account, time, (account, tiles, at) => store.captureRelics(owner, account, tiles, at));
    });

    const captured = store.read(explorer.token, session => session.account);
    const remaining = store.read(abandoned.token, session => session.account);
    assert.deepEqual(captured.game.stock, { wood: 11, water: 22, metal: 33, oil: 44 });
    assert.equal(captured.game.dollars, 12 * dollarsScale + 3456);
    assert.deepEqual(remaining.game.stock, { wood: 0, water: 0, metal: 0, oil: 0 });
    assert.equal(remaining.game.dollars, 0);
    assert.equal(remaining.relicCaptured, true);
    assert.ok(captured.game.log.some(message => message.includes('Relic discovered at Atlas coordinates')));
    assert.deepEqual(store.publicTotals(), publicTotalsBefore);

    const revealedRelic = store.atlasView(explorer.token).entries.find(entry => !entry.yours)!;
    assert.equal(revealedRelic.relic, true);
    assert.deepEqual(revealedRelic.location, relicEntry.location);
    assert.deepEqual(store.captureRelics(store.chatSession(explorer.token).owner, captured, [`${target.x},${target.y}`], now), []);
  } finally { store.close(); }
});
test('atlas HTTP route requires a session, rejects mutations and queries, and returns the complete directory', async () => {
  const store = new SqliteStore(':memory:'), identity = store.create();
  const server = createApi(store, 'http://127.0.0.1:5173', undefined, 'dollar');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/dollar/game/atlas`;
    const headers = { Cookie: `terra-dev=${identity.token}` };
    let response = await fetch(base);
    assert.equal(response.status, 401);
    response = await fetch(base, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as AtlasSnapshot).entries.length, 1);
    response = await fetch(`${base}?metric=bad`, { headers });
    assert.equal(response.status, 400);
    response = await fetch(base, { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:5173' } });
    assert.equal(response.status, 405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});
