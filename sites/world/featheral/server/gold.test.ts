import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApi } from './http.ts';
import { SqliteStore } from './store.ts';
import { accrue, apply, createAccount, snapshot } from './economy.ts';
import { inventory } from './inventory.ts';
import { build, newGame, parseSave, upgrade } from '../src/engine.ts';
import { weeklyIncome } from '../src/income.ts';
import { dollarsScale, dollarsSlippage, dollarsUnits } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { fundFixtureFromReserves } from './test-support.ts';

test('save parsing validates income building keys and boolean ownership', () => {
  const game = newGame();
  game.incomeFacilities = { 'market-stall': true };
  assert.deepEqual(parseSave(JSON.stringify(game)).incomeFacilities, game.incomeFacilities);
  for (const incomeFacilities of [{ unknown: true }, { 'market-stall': 1 }, [], null])
    assert.throws(() => parseSave(JSON.stringify({ ...game, incomeFacilities })), /invalid/);
});

test('Gold HTTP quotes, exact fractional settlement, retries and rejected writes preserve the trust boundary', async () => {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now), identity = store.create();
  store.transaction(identity.token, session => { session.account.game.dollars = 500 * dollarsScale; upgrade(session.account.game); });
  const origin = 'http://127.0.0.1:5173', server = createApi(store, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`, cookie = `terra-dev=${identity.token}`;
  const read = (path: string, authenticated = true) => fetch(`${base}/${path}`, { headers: authenticated ? { Cookie: cookie } : {} });
  const post = (body: unknown, csrf: string, requestOrigin = origin) => fetch(`${base}/gold/actions`, {
    method: 'POST', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await read('gold?quantity=0.1', false)).status, 401);
    assert.equal((await read('gold?quantity=0.00001')).status, 400);
    assert.equal((await read('gold?quantity=1&extra=1')).status, 400);
    assert.equal((await read('gold/actions')).status, 405);
    const initial = await (await read('gold?quantity=0.1')).json();
    const totals = store.publicTotals();
    assert.equal(totals.fthgTransactions, 0);
    const body = { id: randomUUID(), revision: initial.revision, command: { type: 'gold', side: 'buy', quantity: .1, limitDollars: dollarsSlippage(initial.gold.quotes.buy.dollars, 'buy') } };
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.equal((await post(body, '')).status, 403);
    assert.equal((await post(body, initial.csrf, 'http://evil.invalid')).status, 403);
    assert.equal((await post({ ...body, extra: true }, initial.csrf)).status, 400);
    assert.equal((await post({ ...body, command: { ...body.command, limitDollars: .0001 } }, initial.csrf)).status, 409);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    assert.equal(store.publicTotals().fthgTransactions, 0);
    now += 1000;
    const response = await post(body, initial.csrf); assert.equal(response.status, 200);
    const bought = await response.json();
    assert.equal(bought.fthg, .1);
    assert.equal(dollarsUnits(bought.dollars), dollarsUnits(initial.dollars) - dollarsUnits(initial.gold.quotes.buy.dollars));
    assert.ok(bought.gold.rate > initial.gold.rate);
    assert.equal(dollarsUnits(store.publicTotals().dollars), dollarsUnits(totals.dollars));
    assert.equal(store.publicTotals().fthg, totals.fthg);
    assert.equal((await (await read('stats', false)).json()).fthgTransactions, 1);
    const paid = store.read(identity.token, session => structuredClone(session.account));
    assert.deepEqual(await (await post(body, initial.csrf)).json(), bought);
    assert.equal((await post({ ...body, id: randomUUID() }, initial.csrf)).status, 409);
    assert.equal((await post({ ...body, command: { ...body.command, quantity: .2 } }, initial.csrf)).status, 409);
    assert.deepEqual(store.read(identity.token, session => session.account), paid);
    assert.equal(store.publicTotals().fthgTransactions, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});

test('founding and commercial buildings never issue FTH$ or Gold', () => {
  const account = createAccount(1000000);
  apply(account, { id: randomUUID(), revision: 0, command: { type: 'upgrade' } }, 1000000);
  const initialTransport = Object.values(snapshot(account).workforce.crews).reduce((sum, crew) => sum + (crew.weeklyDollarsCost ?? 0), 0);
  assert.equal(snapshot(account).dollars, 0);
  assert.equal(snapshot(account).fthg, 0);
  assert.deepEqual(Object.keys(account.game.stock).sort(), ['metal', 'oil', 'water', 'wood']);
  account.game.stock.water = 10000000;
  const deadline = account.incomeReadyAt;
  accrue(account, deadline - 1);
  assert.equal(snapshot(account).dollars, 0);
  accrue(account, deadline);
  const renewedTransport = Object.values(snapshot(account).workforce.crews).reduce((sum, crew) => sum + (crew.weeklyDollarsCost ?? 0), 0);
  assert.equal(snapshot(account).dollars, 0);
  assert.ok(initialTransport > 0); assert.ok(renewedTransport >= 0);
  assert.ok(Object.values(snapshot(account).pending).some(quantity => quantity > 0));
  const completedFees = Object.values(account.pickupFees!).reduce((sum, fee) => sum + fee, 0);
  assert.ok(completedFees > 0 && completedFees <= initialTransport * dollarsScale);
  account.game.dollars = 200 * dollarsScale;
  account.game.stage = 1; account.game.stock.wood = 10000; account.game.stock.metal = 10000;
  build(account.game, 'market-stall');
  assert.equal(snapshot(account).dollars, 0);
  assert.equal(weeklyIncome(account.game), 0);
  assert.throws(() => build(account.game, 'market-stall'), /already/);
  account.game.bank = true;
  assert.equal(weeklyIncome(account.game), 0);
  account.game.population = 0;
  assert.equal(weeklyIncome(account.game), 0);
});

test('Gold reserve exchange moves its rate and conserves both currencies, including spread and retries', () => {
  let now = 1000000;
  const store = new SqliteStore(':memory:', () => now);
  try {
    const identity = store.create();
    store.transaction(identity.token, session => { session.account.game.dollars = 500 * dollarsScale; upgrade(session.account.game); inventory(session.account); });
    const totals = store.publicTotals();
    assert.equal(totals.goldRate, 1000);
    const quote = store.transaction(identity.token, (_, __, ___, exchange) => exchange.gold.read(.1));
    const revision = store.read(identity.token, session => session.account.revision);
    const body = { id: randomUUID(), revision, command: { type: 'gold', side: 'buy', quantity: .1, limitDollars: dollarsSlippage(quote.quotes.buy.dollars, 'buy') } };
    const execute = (value: unknown) => {
      now += 1000;
      return store.transaction(identity.token, (session, time, realTime, exchange, owner) => exchange.gold.apply(owner, session.account, value, time, realTime));
    };
    const bought = execute(body);
    assert.equal(store.publicTotals().fthgTransactions, 1);
    assert.equal(bought.fthg, .1);
    assert.ok(bought.gold.rate > 1000);
    assert.equal(dollarsUnits(store.publicTotals().dollars), dollarsUnits(totals.dollars));
    assert.equal(store.publicTotals().fthg, totals.fthg);
    const persisted = store.read(identity.token, session => structuredClone(session.account));
    assert.equal(execute(body).fthg, .1);
    assert.deepEqual(store.read(identity.token, session => session.account), persisted);
    assert.throws(() => execute({ ...body, command: { ...body.command, quantity: .2 } }), /Idempotency/);
    assert.equal(store.publicTotals().fthgTransactions, 1);
    const sell = store.transaction(identity.token, (_, __, ___, exchange) => exchange.gold.read(.1));
    const sold = execute({ id: randomUUID(), revision: bought.revision, command: { type: 'gold', side: 'sell', quantity: .1, limitDollars: dollarsSlippage(sell.quotes.sell.dollars, 'sell') } });
    assert.equal(sold.fthg, 0);
    assert.equal(store.publicTotals().fthgTransactions, 2);
    assert.ok(sold.dollars < 500);
    assert.equal(dollarsUnits(store.publicTotals().dollars), dollarsUnits(totals.dollars));
    assert.equal(store.publicTotals().fthg, totals.fthg);
    const before = store.read(identity.token, session => structuredClone(session.account));
    assert.throws(() => execute({ id: randomUUID(), revision: sold.revision, command: { type: 'gold', side: 'sell', quantity: 1, limitDollars: 1 } }), /Not enough Featheral Gold/);
    assert.deepEqual(store.read(identity.token, session => session.account), before);
    assert.equal(store.publicTotals().fthgTransactions, 2);
  } finally { store.close(); }
});

test('FTHG transaction count backfills once, survives cleanup and restart, and rolls back with the exchange', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-gold-count-')), path = join(directory, 'test.sqlite');
  let now = 1000000;
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path, () => now);
    const identity = store.create();
    store.transaction(identity.token, session => { session.account.game.dollars = 500 * dollarsScale; upgrade(session.account.game); });
    fundFixtureFromReserves(path, 500);
    const command = { type: 'gold', side: 'buy', quantity: .1, limitDollars: 200 } as const;
    const execute = (rollback = false) => {
      now += 1000;
      return store!.transaction(identity.token, (session, time, realTime, exchange, owner) => {
        const result = exchange.gold.apply(owner, session.account,
          { id: randomUUID(), revision: session.account.revision, command }, time, realTime);
        if (rollback) throw new Error('Rollback fixture');
        return result;
      });
    };
    execute();
    assert.equal(store.publicTotals().fthgTransactions, 1);
    assert.throws(() => execute(true), /Rollback fixture/);
    assert.equal(store.publicTotals().fthgTransactions, 1);
    store.close();
    store = undefined;
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec('DROP TRIGGER count_fthg_transactions; ALTER TABLE public_totals DROP COLUMN fthg_transactions');
    } finally { legacy.close(); }
    store = new SqliteStore(path, () => now);
    assert.equal(store.publicTotals().fthgTransactions, 1);
    execute();
    assert.equal(store.publicTotals().fthgTransactions, 2);
    now += 8 * 86400000;
    store.create();
    assert.equal(store.publicTotals().fthgTransactions, 2);
    store.close();
    store = undefined;
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('SELECT COUNT(*) AS total FROM gold_receipts').get()!.total, 0); }
    finally { db.close(); }
    store = new SqliteStore(path, () => now);
    assert.equal(store.publicTotals().fthgTransactions, 2);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Lithium migration refunds original Gold escrow, archives history and runs only once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-dollar-')), path = join(directory, 'test.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER,data TEXT);
      CREATE TABLE market_currency(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO market_currency VALUES(1,3);
      CREATE TABLE market_pools(asset TEXT PRIMARY KEY,units INTEGER,fthg INTEGER);
      CREATE TABLE market_orders(id INTEGER PRIMARY KEY,owner TEXT,asset TEXT,side TEXT,price INTEGER,quantity INTEGER,remaining INTEGER,status TEXT,createdAt INTEGER);
      CREATE TABLE market_fills(id INTEGER PRIMARY KEY,asset TEXT,quantity INTEGER,fthg INTEGER,price REAL,time INTEGER,venue TEXT,buyer TEXT,seller TEXT);
      CREATE TABLE market_receipts(owner TEXT,id TEXT,request TEXT,result TEXT);
      INSERT INTO market_pools VALUES('wood',100000,2000000000);
      INSERT INTO market_orders VALUES(1,'owner','wood','buy',20000,3,3,'open',1000000);
      INSERT INTO market_orders VALUES(2,'owner','lithium','sell',360000,2,2,'open',1000000);`);
    const account = createAccount(1000000);
    upgrade(account.game); inventory(account);
    const saved = JSON.parse(JSON.stringify(account));
    saved.currencyVersion = 3; saved.fthg = 100 * dollarsScale;
    delete saved.game.dollars; delete saved.incomeReadyAt;
    saved.game.stock.lithium = 12; saved.pending.lithium = 240006;
    saved.workforce.allocation.lithium = 2;
    saved.workforce.crews.lithium = { workers: 2, readyAt: 2000000, weeklyYield: 8, weeklyMetalCost: 0 };
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('owner', 1000000 + 604800000, JSON.stringify({ csrf: 'fixture', expires: 1000000 + 604800000, account: saved }));
    db.close();
    const migrated = new SqliteStore(path, () => 1000000);
    assert.equal(migrated.publicTotals().fthg, 200106);
    migrated.close();
    const check = new DatabaseSync(path);
    const result = JSON.parse(String(check.prepare('SELECT data FROM sessions').get()!.data)).account;
    assert.equal(result.game.dollars, 180001);
    assert.equal(result.fthg, 106 * dollarsScale);
    assert.equal(result.currencyVersion, 4);
    assert.equal(result.game.stock.lithium, undefined);
    assert.equal(result.workforce.crews.lithium, undefined);
    assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='legacy_gold_market_fills'").get());
    assert.equal(check.prepare("SELECT COUNT(*) AS total FROM market_orders WHERE status='open'").get()!.total, 0);
    check.close();
    const reopened = new SqliteStore(path, () => 1000000); reopened.close();
    const again = new DatabaseSync(path);
    assert.equal(JSON.parse(String(again.prepare('SELECT data FROM sessions').get()!.data)).account.game.dollars, 180001);
    again.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
