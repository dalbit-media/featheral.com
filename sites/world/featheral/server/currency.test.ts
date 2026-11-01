import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccount, snapshot } from './economy.ts';
import { inventory } from './inventory.ts';
import { SqliteStore } from './store.ts';
import { worldWeekMs } from '../src/environment.ts';
import type { MarketCommand } from '../src/market.ts';
import { marketAssets } from '../src/market.ts';
import { dollarsScale } from '../src/dollars.ts';
import { fthgScale } from '../src/fthg.ts';

const now = 1800000000000, token = 'a'.repeat(64), owner = createHash('sha256').update(token).digest('hex');
function legacyDatabase(path: string): void {
  const db = new DatabaseSync(path), account = createAccount(now);
  account.game.stage = 0; account.game.population = 12; account.game.home = { ...account.game.position };
  account.game.stock.metal = 71; account.game.stock.wood = 170;
  account.pending.metal = 23 * 60000; account.revision = 7; account.inviteReadyAt = now + 60000;
  const bag = inventory(account);
  bag.items = ['torch']; bag.equipped = 'torch'; bag.pending = ['relic-forest'];
  bag.marketReserved = ['bench', 'relic-forest']; bag.marketSelling = ['bench'];
  account.workforce = { ...snapshot(account).workforce, automatic: false,
    allocation: { wood: 0, water: 0, metal: 2, oil: 0, lithium: 0 },
    crews: { metal: { workers: 2, readyAt: now + worldWeekMs, weeklyYield: 20, weeklyMetalCost: 5 } } };
  account.receipt = { id: randomUUID(), request: '{}', result: { ...snapshot(account), message: 'Old action.' } };
  const { currencyVersion: _version, fthg: _fthg, ...legacy } = account;
  const data = JSON.stringify({ csrf: 'legacy-csrf', expires: now + 7 * 86400000, account: legacy })
    .replace(/"metal"/g, '"gold"').replace(/Metal/g, 'Gold').replace(/metalPerWorker/g, 'goldPerWorker');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE public_totals (id INTEGER PRIMARY KEY, settlements INTEGER, gold INTEGER);
    INSERT INTO public_totals VALUES(1,1,71);
    CREATE TABLE market_pools (asset TEXT PRIMARY KEY, units INTEGER, gold INTEGER);
    INSERT INTO market_pools VALUES('wood',100000,400000);
    CREATE TABLE market_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, asset TEXT, side TEXT,
      price INTEGER, quantity INTEGER, remaining INTEGER, status TEXT, createdAt INTEGER);
    CREATE INDEX market_book ON market_orders(asset,status,side,price,id);
    CREATE INDEX market_owner ON market_orders(owner,status,id);
    CREATE TABLE market_fills (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, quantity INTEGER, gold INTEGER,
      price REAL, time INTEGER, venue TEXT, buyer TEXT, seller TEXT);
    CREATE INDEX market_history ON market_fills(asset,id);
    INSERT INTO market_fills VALUES(1,'wood',2,10,5,${now},'system','','');
    CREATE TABLE market_receipts (owner TEXT, id TEXT, request TEXT, result TEXT, PRIMARY KEY(owner,id));`);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(owner, now + 7 * 86400000, data);
  const order = db.prepare("INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES(?,?,?,?,?,?,'open',?)");
  for (const [asset, side, price, quantity] of [['wood', 'buy', 4, 10], ['relic-forest', 'buy', 89, 1],
    ['wood', 'sell', 5, 10], ['bench', 'sell', 1000, 1]] as const) order.run(owner, asset, side, price, quantity, quantity, now);
  db.prepare('INSERT INTO market_receipts VALUES(?,?,?,?)').run(owner, 'legacy-request', '{}', '{"old":true}');
  db.close();
}
test('legacy balances, pending production and escrow migrate exactly once; FTHG starts at zero and old markets are archived', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-currency-')), path = join(dir, 'currency.sqlite');
  legacyDatabase(path);
  let time = now, store = new SqliteStore(path, () => time);
  try {
    const account = store.read(token, session => session.account);
    assert.equal(account.currencyVersion, 4); assert.equal(account.fthg, 0);
    assert.equal(account.game.stock.metal, 200); assert.equal(account.game.stock.wood, 180);
    assert.ok(!Object.hasOwn(account.game.stock, 'gold'));
    assert.equal(account.pending.metal, 23 * 60000);
    assert.equal(account.workforce?.crews.metal?.readyAt, now + worldWeekMs);
    assert.equal('weeklyMetalCost' in account.workforce!.crews.metal!, true);
    assert.equal(account.inviteReadyAt, now + 60000); assert.equal(account.revision, 9);
    assert.equal(account.receipt, null);
    assert.deepEqual(account.inventory!.items, ['torch', 'bench']);
    assert.deepEqual(account.inventory!.pending, ['relic-forest']);
    assert.deepEqual(account.inventory!.marketReserved, []); assert.deepEqual(account.inventory!.marketSelling, []);
    assert.equal(store.publicTotals().metal, 200);
    const market = store.transaction(token, (s, n, real, exchange, id) => exchange.read(id, s.account, n, real, 'metal', 20));
    assert.equal(market.market.tickers.length, marketAssets.length); assert.deepEqual(market.market.orders, []); assert.deepEqual(market.market.history, []);
    assert.throws(() => store.transaction(token, (s, n, real, exchange, id) => exchange.action(id, s,
      { id: randomUUID(), revision: 7, command: { type: 'spot', asset: 'metal', side: 'sell', quantity: 20, limitDollars: 1 } }, n, real)), /World changed/);
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM legacy_metal_market_orders WHERE status='cancelled'").get()!.n, 4);
    assert.equal(db.prepare('SELECT gold FROM legacy_metal_market_fills').get()!.gold, 10);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_metal_market_receipts').get()!.n, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='market_book' AND tbl_name='market_orders'").get());
    db.close(); time += 1000;
    const traded = store.transaction(token, (s, n, real, exchange, id) => exchange.action(id, s,
      { id: randomUUID(), revision: s.account.revision, command: { type: 'spot', asset: 'metal', side: 'sell', quantity: 20, limitDollars: 1 } }, n, real));
    assert.equal(traded.game.stock.metal, 180); assert.ok(traded.dollars > 0);
    store.close(); store = new SqliteStore(path, () => time);
    assert.equal(store.read(token, s => s.account.game.dollars) / fthgScale, traded.dollars);
    assert.equal(store.read(token, s => s.account.game.stock.metal), 180);
    assert.equal(store.publicTotals().metal, 180);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('public currency migration retains already-purged inactive balances and adds only settled escrow refunds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-currency-totals-')), path = join(dir, 'currency.sqlite');
  legacyDatabase(path);
  const db = new DatabaseSync(path);
  db.exec('UPDATE public_totals SET gold = gold + 500'); db.close();
  const store = new SqliteStore(path, () => now);
  try { assert.equal(store.publicTotals().metal, 700); assert.equal(store.publicTotals().settlements, 1); }
  finally { store.close(); rmSync(dir, { recursive: true }); }
});
for (const [name, corrupt, error] of [
  ['invalid escrow', "UPDATE market_orders SET remaining=-1 WHERE asset='bench'", /Invalid escrow/],
  ['orphan escrow', "UPDATE market_orders SET owner='missing' WHERE asset='bench'", /no matching legacy account/],
  ['conflicting resources', "UPDATE sessions SET data=json_set(data,'$.account.game.stock.metal',1)", /Conflicting legacy resource keys/],
  ['unknown version', "UPDATE sessions SET data=json_set(data,'$.account.currencyVersion',9)", /Unsupported currency version/],
] as const) test(`a failed currency migration (${name}) rolls back refunds, archive DDL and stored account changes`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-currency-rollback-')), path = join(dir, 'currency.sqlite');
  legacyDatabase(path);
  const db = new DatabaseSync(path);
  db.exec(corrupt);
  const before = db.prepare('SELECT data FROM sessions').get()!.data; db.close();
  try {
    assert.throws(() => new SqliteStore(path, () => now), error);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT data FROM sessions').get()!.data, before);
      assert.equal(reopened.prepare('SELECT gold FROM public_totals').get()!.gold, 71);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'legacy_metal_%'").get()!.n, 0);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true }); }
});
test('zero-start FTH$ is earned by selling Metal; floating conversions conserve both assets and retry exactly once', () => {
  let time = now;
  const dir = mkdtempSync(join(tmpdir(), 'featheral-currency-conservation-')), path = join(dir, 'currency.sqlite');
  const store = new SqliteStore(path, () => time), identity = store.create(), db = new DatabaseSync(path);
  const totals = () => ({
    dollars: db.prepare(`SELECT SUM(json_extract(data,'$.account.game.dollars'))
      + (SELECT SUM(dollars) FROM market_pools)
      + (SELECT COALESCE(SUM(price*remaining),0) FROM market_orders WHERE side='buy' AND status='open') AS total FROM sessions`).get()!.total,
    metal: db.prepare(`SELECT SUM(json_extract(data,'$.account.game.stock.metal'))
      + (SELECT units FROM market_pools WHERE asset='metal')
      + (SELECT COALESCE(SUM(remaining),0) FROM market_orders WHERE asset='metal' AND side='sell' AND status='open') AS total FROM sessions`).get()!.total,
  });
  const read = (quantity = 20) => store.transaction(identity.token, (s, n, real, exchange, id) => exchange.read(id, s.account, n, real, 'metal', quantity));
  const body = (command: MarketCommand) => ({ id: randomUUID(), revision: read().revision, command });
  const post = (value: unknown) => { time += 1000; return store.transaction(identity.token, (s, n, real, exchange, id) => exchange.action(id, s, value, n, real)); };
  try {
    store.transaction(identity.token, s => { s.account.game.stage = 0; s.account.game.population = 0; });
    const conserved = totals();
    const initial = read(); assert.equal(initial.dollars, 0); assert.equal(initial.game.stock.metal, 80);
    assert.throws(() => post(body({ type: 'spot', asset: 'wood', side: 'buy', quantity: 1, limitDollars: 100 })), /Not enough FTH\$/);
    const request = body({ type: 'spot', asset: 'metal', side: 'sell', quantity: 20, limitDollars: initial.market.quotes.sell.dollars });
    const sold = post(request); assert.equal(sold.game.stock.metal, 60); assert.equal(sold.dollars, 39.592);
    assert.deepEqual(post(request), sold);
    assert.throws(() => post({ ...request, command: { ...request.command, quantity: 21 } }), /Idempotency/);
    const buyQuote = read(10).market.quotes.buy.dollars;
    const bought = post(body({ type: 'spot', asset: 'metal', side: 'buy', quantity: 10, limitDollars: buyQuote }));
    assert.equal(bought.game.stock.metal, 70); assert.equal(bought.dollars, (Math.round(sold.dollars * dollarsScale) - Math.round(buyQuote * dollarsScale)) / dollarsScale);
    assert.equal(bought.market.history.length, 2);
    assert.ok(bought.market.history[1].price > bought.market.history[0].price);
    const final = post(body({ type: 'spot', asset: 'metal', side: 'sell', quantity: 10, limitDollars: 1 }));
    assert.equal(final.game.stock.metal, 60); assert.ok(final.dollars < sold.dollars);
    assert.equal(store.publicTotals().metal, final.game.stock.metal);
    assert.deepEqual(totals(), conserved);
    for (const side of ['buy', 'sell'] as const) {
      const placed = post(body({ type: 'limit', asset: 'metal', side, quantity: 5, price: side === 'buy' ? 1 : 10 }));
      const order = placed.market.orders.find(order => order.status === 'open')!;
      assert.deepEqual(totals(), conserved);
      post(body({ type: 'cancel', orderId: order.id })); assert.deepEqual(totals(), conserved);
    }
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true }); }
});
test('player Metal/FTH$ trades conserve wallets and update the maker public Metal delta, not its FTH$ delta', () => {
  let time = now;
  const store = new SqliteStore(':memory:', () => time), seller = store.create(), buyer = store.create();
  const post = (identity: typeof buyer, command: MarketCommand) => {
    time += 1000;
    return store.transaction(identity.token, (s, n, real, exchange, id) => exchange.action(id, s,
      { id: randomUUID(), revision: s.account.revision, command }, n, real));
  };
  try {
    for (const identity of [seller, buyer]) store.transaction(identity.token, s => {
      s.account.game.stage = 0; s.account.game.population = 0;
      if (identity === buyer) s.account.game.dollars = 1000 * dollarsScale;
    });
    post(buyer, { type: 'limit', asset: 'metal', side: 'buy', quantity: 10, price: 2 });
    assert.equal(store.publicTotals().metal, 160);
    const sold = post(seller, { type: 'spot', asset: 'metal', side: 'sell', quantity: 10, limitDollars: 20 });
    const bought = store.read(buyer.token, s => snapshot(s.account));
    assert.equal(sold.game.stock.metal, 70); assert.equal(bought.game.stock.metal, 90);
    assert.equal(sold.dollars, 20); assert.equal(bought.dollars, 980);
    assert.equal(store.publicTotals().metal, 160); assert.equal(sold.market.trades[0].venue, 'players');
  } finally { store.close(); }
});
test('large liquidity quotes use exact integer rounding without unsafe floating-point products', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-currency-precision-')), path = join(dir, 'currency.sqlite');
  const store = new SqliteStore(path, () => now), identity = store.create(), db = new DatabaseSync(path);
  try {
    const quantity = 9999;
    db.prepare("UPDATE market_pools SET dollars=? WHERE asset='metal'").run(9000000000000001);
    assert.throws(() => store.transaction(identity.token, (s, n, real, exchange, id) =>
      exchange.read(id, s.account, n, real, 'metal', quantity)), /Market pool limit reached/);
    const reserve = 7000000000000001n;
    db.prepare("UPDATE market_pools SET dollars=? WHERE asset='metal'").run(Number(reserve));
    const result = store.transaction(identity.token, (s, n, real, exchange, id) => exchange.read(id, s.account, n, real, 'metal', quantity));
    const buyDenominator = BigInt(100000 - quantity) * 100n;
    assert.equal(result.market.quotes.buy.dollars, Number((reserve * BigInt(quantity) * 101n + buyDenominator - 1n) / buyDenominator) / dollarsScale);
    assert.equal(result.market.quotes.sell.dollars, Number(reserve * BigInt(quantity) * 99n / (BigInt(100000 + quantity) * 100n)) / dollarsScale);
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true }); }
});
