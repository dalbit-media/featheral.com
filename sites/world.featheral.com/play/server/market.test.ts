import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import sqlite from '../../../../services/database/sqlite.js';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';
import { apply, execute } from './economy.ts';
import { inventory, craft, findCollectible, collectFinds } from './inventory.ts';
import { Exchange, parseMarketCommand } from './market.ts';
import { isLiquidAsset, isMarketResource, marketAssets, marketPriceFloor, marketResources } from '../src/market.ts';
import { createFundedFixtureAccount } from './test-support.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { terrainDetails } from '../src/engine.ts';
import type { MarketAsset, MarketCommand, MarketResponse } from '../src/market.ts';
import { fundFixtureFromReserves, seedFixturePools } from './test-support.ts';

function setup(path = ':memory:', seeded = true) {
  let time = 1000000;
  const store = new SqliteStore(path, () => time);
  if (seeded) seedFixturePools(store);
  const create = () => {
    const identity = store.create();
    store.transaction(identity.token, session => {
      session.account.game.stage = 0;
      session.account.game.home = { ...session.account.game.position };
      session.account.game.stock = { wood: 10000, water: 10000, metal: 100000, oil: 10000, lithium: 10000 };
      session.account.game.dollars = 100000 * dollarsScale;
      inventory(session.account);
    });
    if (path !== ':memory:') fundFixtureFromReserves(path, 100000);
    return identity;
  };
  const read = (token: string, asset: MarketAsset = 'wood', quantity = 1) => store.transaction(token,
    (session, now, realTime, exchange, owner) => exchange.read(owner, session.account, now, realTime, asset, quantity));
  const request = (token: string, command: MarketCommand) => ({ id: randomUUID(), revision: store.read(token, s => s.account.revision), command });
  const post = (token: string, body: unknown) => {
    time += 1000;
    return store.transaction(token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, body, now, realTime));
  };
  const act = (token: string, command: MarketCommand) => post(token, request(token, command));
  return { store, create, read, request, post, act, advance: (amount: number) => { time += amount; } };
}
test('owner fill history uses buyer and seller indexes after repeated schema initialization', () => {
  const db = sqlite.open(':memory:');
  try {
    new Exchange(db);
    new Exchange(db);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM market_fills WHERE buyer = ? OR seller = ? ORDER BY id DESC LIMIT 30')
      .all('owner', 'owner').map(row => String(row.detail)).join('\n');
    assert.match(plan, /USING INDEX market_fills_buyer\b/);
    assert.match(plan, /USING INDEX market_fills_seller\b/);
  } finally { db.close(); }
});
test('resource prices have only the accounting minimum and reject zero-price orders without spending', () => {
  const h = setup();
  try {
    const player = h.create();
    for (const asset of marketResources) {
      const floor = marketPriceFloor(asset);
      for (const side of ['buy', 'sell'] as const) {
        const before = h.store.read(player.token, session => structuredClone(session.account));
        assert.throws(() => h.act(player.token, { type: 'limit', asset, side, quantity: 1, price: 0 }), /Invalid market/);
        assert.equal(h.read(player.token).dollars, before.game.dollars / dollarsScale);
        assert.equal(h.read(player.token).game.stock[asset], before.game.stock[asset]);
      }
      assert.equal(floor, .0001);
      assert.throws(() => h.act(player.token, { type: 'fund-pool', asset, quantity: 1, dollars: 0 }), /Invalid market/);
      const offer = h.act(player.token, { type: 'limit', asset, side: 'buy', quantity: 1, price: floor });
      assert.ok(offer.market.orders.some(order => order.asset === asset && order.price >= floor));
    }
  } finally { h.store.close(); }
});
test('resource pricing depth survives exchange reinitialization and never grows with reserves', () => {
  const db = sqlite.open(':memory:');
  try {
    const exchange = new Exchange(db), account = createFundedFixtureAccount(1000000);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER, data TEXT)');
    db.prepare("UPDATE market_pools SET units=10000,dollars=400000000 WHERE asset='wood'").run();
    const first = exchange.read('buyer', account, 1000000, 1000000, 'wood', 1).market.quotes.sell;
    const depth = db.prepare("SELECT units,dollars FROM market_resource_depth WHERE asset='wood'").get()!;
    assert.equal(String(depth.units), '90000'); assert.equal(String(depth.dollars), '3600000000');
    db.prepare("UPDATE market_pools SET units=11000,dollars=360792080 WHERE asset='wood'").run();
    const next = new Exchange(db).read('buyer', account, 1000000, 1000000, 'wood', 1).market.quotes.sell;
    assert.ok(next.dollars < first.dollars);
    assert.deepEqual(db.prepare("SELECT units,dollars FROM market_resource_depth WHERE asset='wood'").get(), depth);
  } finally { db.close(); }
});
test('Wood sale funding covers accounting precision as well as payout for 85,400 kg', () => {
  const db = sqlite.open(':memory:');
  try {
    const exchange = new Exchange(db), account = createFundedFixtureAccount(1000000);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER, data TEXT)');
    account.game.stage = 0; account.game.stock.wood = 1708;
    db.prepare("UPDATE market_pools SET units=1000000,dollars=10000 WHERE asset='wood'").run();
    const before = exchange.read('seller', account, 1000000, 1000000, 'wood', 1708).market.quotes.sell;
    assert.equal(before.available, false); assert.equal(before.dollars, 0);
    const target = exchange.resourceFundingRequired('wood', 1708)!;
    assert.ok(target > 10000n);
    db.prepare("UPDATE market_pools SET dollars=? WHERE asset='wood'").run(Number(target));
    const quote = exchange.read('seller', account, 1000000, 1000000, 'wood', 1708).market.quotes.sell;
    assert.equal(quote.available, true);
    assert.ok(quote.dollars >= 1708 / dollarsScale);
    assert.ok(quote.dollars * dollarsScale <= Number(target));
  } finally { db.close(); }
});
test('large item quotes narrow to safe accounting capacity rather than overflowing intermediate payments', () => {
  const db = sqlite.open(':memory:');
  try {
    const exchange = new Exchange(db), account = createFundedFixtureAccount(1000000);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER, data TEXT)');
    db.prepare("UPDATE market_pools SET units=10000,dollars=? WHERE asset='torch'").run(Math.floor(Number.MAX_SAFE_INTEGER / 2));
    const quote = exchange.read('buyer', account, 1000000, 1000000, 'torch', 9999).market.quotes.buy;
    assert.equal(quote.available, false);
    assert.ok(quote.dollars > 0 && quote.dollars < Number.MAX_SAFE_INTEGER / dollarsScale);
  } finally { db.close(); }
});
test('resource quotes retain valid offers below old floors without repricing balances or history', () => {
  const db = sqlite.open(':memory:');
  try {
    const exchange = new Exchange(db);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, expires INTEGER, data TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('legacy', 9999999, '{}');
    const account = createFundedFixtureAccount(1000000);
    account.game.stage = 0; account.game.home = { ...account.game.position };
    for (const asset of marketResources) {
      const floor = 100;
      const reserveDollars = floor * 10000;
      db.prepare('UPDATE market_pools SET units = ?, dollars = ? WHERE asset = ?').run(10000, reserveDollars, asset);
      for (const side of ['buy', 'sell']) db.prepare('INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES(?,?,?,?,?,?,?,?)')
        .run('legacy', asset, side, floor - 1, 5, 5, 'open', 1000000);
      db.prepare('INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES(?,?,?,?,?,?,?,?)')
        .run(asset, 1, floor - 1, floor - 1, 900000, 'system', 'legacy', '');
      const view = exchange.read('buyer', account, 1000000, 1000000, asset, 1).market;
      assert.equal(view.bids.length, 1); assert.equal(view.asks.length, 1);
      assert.equal(view.quotes.sell.available, true);
      assert.equal(view.quotes.buy.available, true);
      assert.ok(view.quotes.sell.dollars > 0);
      assert.ok(view.quotes.buy.dollars > 0);
      assert.equal(view.history.at(-1)!.price, (floor - 1) / dollarsScale);
      assert.ok(exchange.read('legacy', account, 1000000, 1000000, asset, 1).market.orders.some(order => order.asset === asset && order.status === 'open'));
      account.game.stock[asset] = 20000;
      const large = exchange.read('legacy', account, 1000000, 1000000, asset, 10000).market.quotes.sell;
      assert.equal(large.available, true);
      assert.ok(large.dollars * dollarsScale <= reserveDollars);
      const unchanged = db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get(asset)!;
      assert.equal(Number(unchanged.units), 10000);
      assert.equal(Number(unchanged.dollars), reserveDollars);
      account.game.dollars = 1000 * dollarsScale;
      exchange.fundPool(account, asset, 1, floor);
      const funded = db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get(asset)!;
      assert.equal(Number(funded.units), 10001);
      assert.equal(Number(funded.dollars), reserveDollars + floor);
    }
  } finally { db.close(); }
});
test('every resource uses gently falling funded quotes, retries once and has no profitable round trip', () => {
  for (const asset of marketResources) {
    const h = setup(':memory:', false);
    try {
      const player = h.create();
      h.act(player.token, { type: 'fund-pool', asset, quantity: 10, dollars: 30 });
      const before = h.read(player.token, asset);
      const quote = h.read(player.token, asset, 3).market.quotes.sell;
      assert.equal(quote.available, true);
      const price = quote.dollars;
      const request = h.request(player.token, { type: 'spot', asset, side: 'sell', quantity: 3, limitDollars: price });
      const sold = h.post(player.token, request);
      assert.ok(Math.abs(sold.dollars - before.dollars - price) < .00001);
      assert.equal(sold.game.stock[asset], before.game.stock[asset] - 3);
      const retry = h.post(player.token, request);
      assert.equal(retry.dollars, sold.dollars); assert.equal(retry.game.stock[asset], sold.game.stock[asset]);
      assert.equal(retry.market.history.length, 1);
      const next = h.read(player.token, asset, 3).market.quotes.sell;
      assert.ok(next.dollars < price && next.dollars > price * .9, 'decline stays below 10% for this trade');
      const buy = h.read(player.token, asset, 3).market.quotes.buy;
      assert.equal(buy.available, true);
      h.act(player.token, { type: 'spot', asset, side: 'buy', quantity: 3, limitDollars: buy.dollars });
      assert.ok(h.read(player.token, asset).dollars <= before.dollars, 'round trip cannot create FTH$');
      assert.equal(h.read(player.token, asset).game.stock[asset], before.game.stock[asset]);
    } finally { h.store.close(); }
  }
});
test('insufficient real liquidity never spends virtual dollars or partially spends inventory', () => {
  const h = setup(':memory:', false);
  try {
    const player = h.create();
    h.act(player.token, { type: 'fund-pool', asset: 'wood', quantity: 1, dollars: 5 });
    const before = h.read(player.token, 'wood');
    const quote = h.read(player.token, 'wood', 3).market.quotes.sell;
    assert.equal(quote.available, false);
    assert.throws(() => h.act(player.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 3, limitDollars: 7.5 }), /Backing is unavailable/);
    assert.equal(h.read(player.token).dollars, before.dollars);
    assert.equal(h.read(player.token).game.stock.wood, before.game.stock.wood);
    assert.equal(h.read(player.token).market.history.length, 0);
    assert.ok(h.read(player.token, 'wood', 2).market.quotes.sell.dollars < 5);
  } finally { h.store.close(); }
});
test('weekly market receipts return daily Water metadata without replaying trades or billing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-daily-market-')), path = join(directory, 'test.sqlite');
  const h = setup(path), identity = h.create(), db = sqlite.open(path);
  try {
    h.store.transaction(identity.token, session => {
      session.account.game.population = 12;
      session.account.game.stock.water = 180;
    });
    const request = h.request(identity.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 1, limitDollars: 1 });
    const original = h.post(identity.token, request);
    db.exec("UPDATE market_receipts SET result=json_remove(json_set(result,'$.waterUpkeep.shortage',1080,'$.waterUpkeep.populationLoss',1),'$.waterUpkeep.dailyConsumption')");
    const before = h.store.read(identity.token, session => structuredClone(session.account));
    const retry = h.post(identity.token, request);
    assert.deepEqual(h.store.read(identity.token, session => session.account), before);
    assert.deepEqual(retry.game, original.game);
    assert.equal(retry.dollars, original.dollars);
    assert.equal(retry.waterUpkeep!.dailyConsumption, original.waterUpkeep!.dailyConsumption);
    assert.equal(retry.waterUpkeep!.weeklyConsumption, original.waterUpkeep!.weeklyConsumption);
    assert.equal(retry.waterUpkeep!.shortage, 0);
    assert.equal(retry.waterUpkeep!.populationLoss, 0);
    assert.equal(retry.waterUpkeep!.readyAt, before.waterUpkeep!.readyAt);
  } finally { db.close(); h.store.close(); rmSync(directory, { recursive: true }); }
});
test('player orders escrow, match by price and time, partially fill and cancel without creating money', () => {
  const h = setup(':memory:', false), buyer = h.create(), seller = h.create();
  try {
    const bid = h.act(buyer.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 10, price: 4 });
    assert.equal(bid.dollars, 99960);
    assert.equal(bid.market.orders[0].remaining, 10);
    const fill = h.act(seller.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 6, limitDollars: 24 });
    assert.equal(fill.dollars, 100024);
    assert.equal(fill.market.trades[0].venue, 'players');
    assert.equal(h.read(buyer.token).game.stock.wood, 10006);
    assert.equal(h.read(buyer.token).market.orders[0].remaining, 4);
    assert.equal(h.store.publicTotals().metal, 200000);
    h.act(buyer.token, { type: 'cancel', orderId: bid.market.orders[0].id });
    assert.equal(h.store.publicTotals().metal, 200000);
    assert.throws(() => h.act(seller.token, { type: 'cancel', orderId: bid.market.orders[0].id }), /Open order/);
    assert.equal(h.read(buyer.token).dollars, 99976);
    assert.equal(h.read(buyer.token).market.history.length, 1);
    const first = h.act(seller.token, { type: 'limit', asset: 'wood', side: 'sell', quantity: 2, price: 4 });
    h.act(seller.token, { type: 'limit', asset: 'wood', side: 'sell', quantity: 3, price: 4 });
    h.act(buyer.token, { type: 'spot', asset: 'wood', side: 'buy', quantity: 1, limitDollars: 4 });
    assert.equal(h.read(seller.token).market.orders.find(o => o.id === first.market.orders[0].id)!.remaining, 1);
  } finally { h.store.close(); }
});
test('system liquidity covers every catalog item and raw resource, records real history and cannot profit from a round trip', () => {
  const h = setup(), user = h.create();
  try {
    assert.equal(h.read(user.token).market.tickers.length, marketAssets.length);
    assert.equal(h.read(user.token).market.history.length, 0);
    for (const asset of marketAssets.filter(isLiquidAsset)) {
      const quote = h.read(user.token, asset);
      assert.ok(quote.market.quotes.buy.available, asset);
      if (quote.market.quotes.sell.available) {
        assert.ok(quote.market.quotes.sell.dollars >= marketPriceFloor(asset), asset);
        assert.ok(quote.market.quotes.buy.dollars > quote.market.quotes.sell.dollars, asset);
      } else assert.fail(`${asset} fixture should have funded liquidity`);
    }
    const before = h.read(user.token);
    const buyQuote = h.read(user.token, 'wood', 100).market.quotes.buy;
    const buy = h.act(user.token, { type: 'spot', asset: 'wood', side: 'buy', quantity: 100, limitDollars: buyQuote.dollars });
    assert.equal(buy.market.history[0].dollars, buyQuote.dollars);
    const sellQuote = h.read(user.token, 'wood', 100).market.quotes.sell;
    const sold = h.act(user.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 100, limitDollars: sellQuote.dollars });
    assert.ok(sold.dollars < before.dollars);
    assert.equal(sold.game.stock.wood, before.game.stock.wood);
    assert.equal(sold.market.history.length, 2);
    assert.ok(sold.market.history.every(fill => fill.venue === 'system'));
    h.act(user.token, { type: 'spot', asset: 'oil', side: 'buy', quantity: 1, limitDollars: 100 });
    assert.equal(h.read(user.token, 'oil').game.bank, false);
  } finally { h.store.close(); }
});
test('best execution prefers cheaper pools over expensive asks and better player prices over pools', () => {
  const h = setup(':memory:', false), a = h.create(), b = h.create();
  try {
    h.act(a.token, { type: 'fund-pool', asset: 'wood', quantity: 10, dollars: 30 });
    h.act(a.token, { type: 'limit', asset: 'wood', side: 'sell', quantity: 20, price: 5 });
    const q = h.read(b.token, 'wood', 10).market.quotes.buy;
    assert.ok(q.dollars < 50);
    h.act(b.token, { type: 'spot', asset: 'wood', side: 'buy', quantity: 10, limitDollars: q.dollars });
    assert.equal(h.read(a.token).market.orders[0].remaining, 20);
    h.act(b.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 4, price: 3.7 });
    const sell = h.read(a.token, 'wood', 7).market.quotes.sell;
    const fill = h.act(a.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 7, limitDollars: sell.dollars });
    assert.ok(fill.market.trades.some(trade => trade.venue === 'players'));
    assert.ok(fill.market.trades.some(trade => trade.venue === 'system'));
    assert.equal(h.read(b.token).market.orders.find(o => o.price === 3.7)!.status, 'filled');
  } finally { h.store.close(); }
});
test('crafted item and collectible trading reserves unique slots, protects equipment and survives cancellation', () => {
  const h = setup(), a = h.create(), b = h.create();
  try {
    h.store.transaction(a.token, s => {
      inventory(s.account).items.push('bench', 'torch', 'relic-forest'); inventory(s.account).equipped = 'torch';
      for (const terrain of (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).filter(terrain => !['forest', 'meadow', 'water'].includes(terrain)).slice(0, 16))
        findCollectible(s.account, terrain);
    });
    assert.throws(() => h.act(a.token, { type: 'spot', asset: 'torch', side: 'sell', quantity: 1, limitDollars: 1 }), /Unequip/);
    h.store.transaction(a.token, s => { inventory(s.account).layout!.positions.bench = { x: 0, y: 2 }; });
    assert.throws(() => h.act(a.token, { type: 'spot', asset: 'bench', side: 'sell', quantity: 1, limitDollars: 1 }), /return this item/);
    h.store.transaction(a.token, s => { delete inventory(s.account).layout!.positions.bench; });
    const ask = h.act(a.token, { type: 'limit', asset: 'bench', side: 'sell', quantity: 1, price: 1000 });
    assert.ok(!ask.inventory.items.includes('bench'));
    assert.deepEqual(ask.inventory.marketReserved, ['bench']);
    h.store.transaction(a.token, s => {
      craft(s.account, 'bench');
      findCollectible(s.account, 'meadow');
      findCollectible(s.account, 'water');
    });
    assert.equal(h.read(a.token).inventory.pending.length, 2);
    h.act(a.token, { type: 'cancel', orderId: ask.market.orders[0].id });
    assert.ok(h.read(a.token).inventory.items.includes('bench'));
    const bid = h.act(b.token, { type: 'limit', asset: 'bench', side: 'buy', quantity: 1, price: 95 });
    assert.deepEqual(bid.inventory.marketReserved, ['bench']);
    h.act(a.token, { type: 'limit', asset: 'bench', side: 'sell', quantity: 1, price: 95 });
    const received = h.read(b.token);
    assert.ok(received.inventory.items.includes('bench'));
    assert.deepEqual(received.inventory.marketReserved, []);
    assert.equal(received.market.orders[0].status, 'filled');
    h.act(a.token, { type: 'limit', asset: 'relic-forest', side: 'sell', quantity: 1, price: 90 });
    h.act(b.token, { type: 'spot', asset: 'relic-forest', side: 'buy', quantity: 1, limitDollars: 1000 });
    assert.ok(h.read(b.token).inventory.items.includes('relic-forest'));
    assert.throws(() => h.act(b.token, { type: 'limit', asset: 'relic-forest', side: 'buy', quantity: 1, price: 90 }), /already/);
  } finally { h.store.close(); }
});
test('bad quotes, insufficient balances, self orders and malformed payloads cannot mutate the exchange', () => {
  const h = setup(':memory:', false), a = h.create();
  try {
    const bid = h.act(a.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 5, price: 4 });
    h.act(a.token, { type: 'fund-pool', asset: 'wood', quantity: 1, dollars: 5 });
    const before = h.store.read(a.token, s => structuredClone(s.account));
    assert.throws(() => h.act(a.token, { type: 'spot', asset: 'wood', side: 'buy', quantity: 1, limitDollars: 1 }), /Quote changed/);
    assert.deepEqual(h.store.read(a.token, s => s.account), before);
    assert.throws(() => h.act(a.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 10000, price: 1000000 }), /Not enough FTH\$/);
    assert.equal(h.read(a.token).market.history.length, 0);
    const self = h.act(a.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 1, limitDollars: 1 });
    assert.equal(self.market.orders.find(o => o.id === bid.market.orders[0].id)!.remaining, 5);
    assert.equal(self.market.trades[0].venue, 'system');
    for (const command of [
      { type: 'limit', asset: 'dollars', side: 'buy', quantity: 1, price: 1 },
      { type: 'limit', asset: '__proto__', side: 'buy', quantity: 1, price: 1 },
      { type: 'limit', asset: 'relic-forest', side: 'buy', quantity: 2, price: 1 },
      { type: 'spot', asset: 'wood', side: 'buy', quantity: 0, limitDollars: 1 },
      { type: 'limit', asset: 'wood', side: 'buy', quantity: 1.5, price: 1 },
      { type: 'limit', asset: 'wood', side: 'buy', quantity: 1, price: 1, owner: 'forged' },
    ]) assert.throws(() => parseMarketCommand(command), /Invalid market/);
    h.store.transaction(a.token, s => assert.throws(() => execute(s.account, { type: 'trade', resource: 'wood', direction: 'buy', amount: 1 }), /marketplace/));
  } finally { h.store.close(); }
});
test('liquid item quantities fill and cancel independently without losing reserved slots', () => {
  const h = setup(), buyer = h.create(), seller = h.create();
  try {
    h.store.transaction(seller.token, session => { inventory(session.account).items.push('torch', 'torch', 'torch'); });
    const price = (Math.round(h.read(buyer.token, 'torch').market.quotes.sell.dollars * dollarsScale) + 1) / dollarsScale;
    const first = h.act(buyer.token, { type: 'limit', asset: 'torch', side: 'buy', quantity: 5, price });
    const second = h.act(buyer.token, { type: 'limit', asset: 'torch', side: 'buy', quantity: 3, price });
    assert.equal(h.read(buyer.token).inventory.marketReserved!.length, 8);
    h.act(seller.token, { type: 'limit', asset: 'torch', side: 'sell', quantity: 3, price });
    let bought = h.read(buyer.token);
    assert.equal(bought.inventory.items.filter(item => item === 'torch').length, 3);
    assert.equal(bought.inventory.marketReserved!.length, 5);
    assert.equal(bought.market.orders.find(order => order.id === first.market.orders[0].id)!.remaining, 2);
    h.act(buyer.token, { type: 'cancel', orderId: first.market.orders[0].id });
    assert.equal(h.read(buyer.token).inventory.marketReserved!.length, 3);
    h.act(buyer.token, { type: 'cancel', orderId: second.market.orders[0].id });
    bought = h.read(buyer.token);
    assert.equal(bought.inventory.marketReserved!.length, 0);
    assert.equal(bought.inventory.items.filter(item => item === 'torch').length, 3);
    h.store.transaction(buyer.token, session => { inventory(session.account).equipped = 'torch'; });
    assert.throws(() => h.act(buyer.token, { type: 'spot', asset: 'torch', side: 'sell', quantity: 3, limitDollars: .0001 }), /Unequip/);
    h.act(buyer.token, { type: 'spot', asset: 'torch', side: 'sell', quantity: 2, limitDollars: .0001 });
    assert.equal(h.read(buyer.token).inventory.items.filter(item => item === 'torch').length, 1);
    assert.equal(h.read(buyer.token).inventory.equipped, 'torch');
    assert.throws(() => h.act(buyer.token, { type: 'limit', asset: 'activity-exploration-1', side: 'buy', quantity: 20, price: .0001 }), /inventory is full/);
  } finally { h.store.close(); }
});
test('collectibles have player-only prices while all automation and equipment have demand-driven liquidity', () => {
  const h = setup(), user = h.create();
  try {
    const collective = h.read(user.token, 'relic-forest').market;
    assert.equal(collective.quotes.buy.available, false);
    assert.equal(collective.quotes.sell.available, false);
    assert.equal(collective.tickers.find(ticker => ticker.asset === 'relic-forest')!.bid, 0);
    for (const asset of ['activity-exploration-1', 'activity-attraction-4', 'collection-wood-12', 'torch'] as const) {
      const before = h.read(user.token, asset, 3).market.quotes.buy.dollars;
      h.act(user.token, { type: 'spot', asset, side: 'buy', quantity: 3, limitDollars: before });
      const after = h.read(user.token, asset, 3).market.quotes.buy.dollars;
      assert.ok(after > before, asset);
      assert.equal(h.read(user.token).inventory.items.filter(item => item === asset).length, 3);
    }
  } finally { h.store.close(); }
});
test('matching an offline automated maker persists recruitment arrivals and census exactly once', () => {
  const h = setup(':memory:', false), buyer = h.create(), seller = h.create();
  try {
    h.store.transaction(buyer.token, session => { inventory(session.account).items.push('activity-attraction-1'); });
    h.store.transaction(buyer.token, (session, now) => apply(session.account,
      { id: randomUUID(), revision: session.account.revision, command: { type: 'activate-activity', item: 'activity-attraction-1' } }, now));
    h.act(buyer.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 10, price: 4 });
    const before = h.store.population(null).global;
    const arrivals = h.read(buyer.token).recruitment!.population;
    h.advance(worldWeekMs);
    h.act(seller.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 5, limitDollars: 20 });
    assert.equal(h.store.population(null).global, before + arrivals);
    assert.equal(h.read(buyer.token).recruitment, null);
    h.act(seller.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 5, limitDollars: 20 });
    assert.equal(h.store.population(null).global, before + arrivals);
  } finally { h.store.close(); }
});
test('reserved item bids cannot overflow inventory or discard a paid expedition find', () => {
  const h = setup(), a = h.create(), b = h.create();
  try {
    h.store.transaction(a.token, s => {
      inventory(s.account).items.push('torch', 'lamp', 'bench');
      for (const terrain of (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).filter(terrain => terrain !== 'forest' && terrain !== 'water').slice(0, 16))
        findCollectible(s.account, terrain);
    });
    const bid = h.act(a.token, { type: 'limit', asset: 'relic-forest', side: 'buy', quantity: 1, price: 89 });
    h.store.transaction(a.token, s => {
      assert.throws(() => craft(s.account, 'planter'), /full/);
      findCollectible(s.account, 'forest');
      assert.deepEqual(inventory(s.account).pending, ['relic-forest']);
      assert.throws(() => collectFinds(s.account), /full/);
    });
    h.act(a.token, { type: 'cancel', orderId: bid.market.orders[0].id });
    h.store.transaction(a.token, s => { collectFinds(s.account); });
    assert.ok(h.read(a.token).inventory.items.includes('relic-forest'));
    assert.throws(() => h.act(a.token, { type: 'spot', asset: 'banner', side: 'buy', quantity: 1, limitDollars: 1000 }), /full/);
    const otherBid = h.act(b.token, { type: 'limit', asset: 'relic-water', side: 'buy', quantity: 1, price: 89 });
    h.store.transaction(b.token, s => { findCollectible(s.account, 'water'); assert.throws(() => collectFinds(s.account), /reserved/); });
    h.store.transaction(a.token, s => { inventory(s.account).items = ['relic-water']; });
    h.act(a.token, { type: 'limit', asset: 'relic-water', side: 'sell', quantity: 1, price: 89 });
    assert.equal(h.read(b.token).market.orders.find(o => o.id === otherBid.market.orders[0].id)!.status, 'filled');
    assert.deepEqual(h.read(b.token).inventory.items, ['relic-water']);
    assert.deepEqual(h.read(b.token).inventory.pending, []);
  } finally { h.store.close(); }
});
test('open order limits and expired makers protect capacity without changing pool history', () => {
  const h = setup(':memory:', false), a = h.create();
  try {
    for (let i = 0; i < 50; i++) h.act(a.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 1, price: marketPriceFloor('wood') });
    assert.throws(() => h.act(a.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 1, price: marketPriceFloor('wood') }), /Maximum 50/);
    assert.equal(h.read(a.token).dollars, 100000 - 50 * marketPriceFloor('wood'));
    h.act(a.token, { type: 'fund-pool', asset: 'wood', quantity: 1, dollars: 5 });
    h.advance(4 * 86400000);
    const b = h.create();
    h.advance(4 * 86400000);
    const before = h.read(b.token);
    assert.deepEqual(before.market.bids, []);
    assert.equal(before.market.history.length, 0);
    h.act(b.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 1, limitDollars: 1 });
    assert.equal(h.read(b.token).market.trades[0].venue, 'system');
  } finally { h.store.close(); }
});
test('orders, pool reserves, history and exact retry receipts persist through restart with atomic public totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featheral-market-')), path = join(dir, 'game.sqlite');
  const h = setup(path), a = h.create(), b = h.create();
  let reopened: SqliteStore | undefined;
  try {
    const body = h.request(a.token, { type: 'limit', asset: 'wood', side: 'buy', quantity: 5, price: 4 });
    const first = h.post(a.token, body);
    assert.deepEqual(h.post(a.token, body), first);
    assert.throws(() => h.post(a.token, { ...body, command: { ...body.command, quantity: 6 } }), /Idempotency/);
    h.act(b.token, { type: 'spot', asset: 'wood', side: 'sell', quantity: 2, limitDollars: 8 });
    const db = sqlite.open(path);
    const total = () => Number(db.prepare('SELECT SUM(dollars) AS n FROM market_pools').get()!.n)
      + Number(db.prepare("SELECT COALESCE(SUM(price*remaining),0) AS n FROM market_orders WHERE side='buy' AND status='open'").get()!.n)
      + Number(db.prepare("SELECT SUM(json_extract(data, '$.account.game.dollars')) AS n FROM sessions").get()!.n);
    const metal = total();
    h.act(a.token, { type: 'spot', asset: 'water', side: 'buy', quantity: 10, limitDollars: 100 });
    assert.equal(total(), metal);
    db.close();
    const before = h.read(a.token);
    h.store.close();
    reopened = new SqliteStore(path, () => 1010000);
    const after = reopened.transaction(a.token, (s, now, realTime, exchange, owner) => exchange.read(owner, s.account, now, realTime, 'wood', 1));
    assert.deepEqual(after.market, before.market);
    assert.equal(reopened.publicTotals().metal, [a.token, b.token].reduce((sum, token) => sum + reopened!.read(token, s => s.account.game.stock.metal), 0));
    assert.deepEqual(reopened.transaction(a.token, (s, now, realTime, exchange, owner) => exchange.action(owner, s, body, now, realTime)), first);
  } finally { if (reopened) reopened.close(); else h.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('market HTTP routes require session, exact origin, CSRF, strict commands and authoritative revisions', async () => {
  const h = setup(), a = h.create(), server = createApi(h.store, 'http://127.0.0.1:5173');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`, cookie = `terra-dev=${a.token}`;
  const post = (body: unknown, csrf = a.csrf) => fetch(`${base}/market/actions`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/market`)).status, 401);
    assert.equal((await fetch(`${base}/market?asset=dollars`, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(`${base}/market?asset=metal`, { headers: { Cookie: cookie } })).status, 200);
    const state = await (await fetch(`${base}/market?asset=wood&quantity=2`, { headers: { Cookie: cookie } })).json() as MarketResponse;
    const body = { id: randomUUID(), revision: state.revision, command: { type: 'spot', asset: 'wood', side: 'buy', quantity: 2, limitDollars: state.market.quotes.buy.dollars } };
    assert.equal((await post(body, 'bad')).status, 403);
    const first = await post(body); assert.equal(first.status, 200);
    const result = await first.json() as MarketResponse;
    assert.equal(result.game.stock.wood, state.game.stock.wood + 2);
    assert.deepEqual(await (await post(body)).json(), result);
    assert.equal((await post({ ...body, id: randomUUID() })).status, 409);
    assert.equal((await post({ ...body, id: randomUUID(), revision: result.revision, command: { ...body.command, asset: 'unknown' } })).status, 400);
    assert.equal((await fetch(`${base}/market/actions`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    h.advance(1000);
    h.store.transaction(a.token, (s, now) => assert.throws(() => apply(s.account, { id: randomUUID(), revision: s.account.revision,
      command: { type: 'trade', resource: 'wood', direction: 'buy', amount: 1 } }, now), /marketplace/));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); h.store.close(); }
});
