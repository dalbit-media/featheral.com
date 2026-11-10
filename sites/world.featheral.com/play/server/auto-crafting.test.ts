import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SqliteStore } from './store.ts';
import { craft, inventory } from './inventory.ts';
import { seedFixturePools } from './test-support.ts';
import { craftableItems, craftableKeys, craftingCost, craftingMaximum, isCollectible, itemName } from '../src/items.ts';
import { autoCraftableOutput, merchantCharter, merchantCharterFee, merchantSpendingLimit } from '../src/auto-crafting.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { isReserveMarketAsset, isLiquidAsset, marketAssets } from '../src/market.ts';
import { itemArt } from '../src/item-art.ts';
import { translate } from '../src/i18n.ts';
import { autoCraftConsumption } from '../src/consumption.ts';
import { parseMarketCommand } from './market.ts';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createApi } from './http.ts';
import type { AutoCraftResponse } from '../src/auto-crafting.ts';
import { craftingIngredients } from '../src/items.ts';
import { craftingPanel, inventoryPanel } from '../src/inventory-view.ts';
import { terrainDetails } from '../src/engine.ts';
import { snapshot } from './economy.ts';
import { itemDetailRows } from '../src/item-details.ts';

function setup(path = ':memory:') {
  let time = 1000000;
  const store = new SqliteStore(path, () => time);
  seedFixturePools(store, [merchantCharter]);
  const user = store.create();
  store.transaction(user.token, session => {
    const account = session.account, game = account.game;
    game.stage = 8; game.home = { ...game.position }; game.population = 200;
    game.dollars = 100000 * dollarsScale;
    game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
    game.explored = Array.from({ length: 441 }, (_, index) => `${index % 21 - 10},${Math.floor(index / 21) - 10}`);
    const bag = inventory(account);
    bag.storage = 9; bag.items = [merchantCharter, 'craft-batch-100', 'craft-batch-50', 'craft-batch-20', 'craft-batch-10'];
  });
  const quote = () => store.transaction(user.token, (session, now, realTime, exchange, owner) =>
    exchange.autoCraftQuote(owner, session.account, now, realTime).autoCraft);
  const request = (fingerprint: string) => ({ id: randomUUID(), revision: store.read(user.token, session => session.account.revision), command: { type: 'auto-craft', fingerprint } });
  const post = (body: unknown) => {
    time += 1000;
    return store.transaction(user.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, body, now, realTime));
  };
  const saved = () => store.read(user.token, session => structuredClone(session.account));
  return { store, user, quote, request, post, saved };
}
test('charter is the most expensive recipe, has localized art, and never expands automatic reserve targets', () => {
  assert.equal(craftingCost(merchantCharter).dollars, merchantCharterFee);
  for (const item of craftableKeys.filter(item => item !== merchantCharter)) assert.ok(craftingCost(item).dollars! < merchantCharterFee, item);
  assert.ok(isLiquidAsset(merchantCharter));
  assert.equal(isReserveMarketAsset(merchantCharter), false);
  assert.deepEqual(marketAssets.filter(isReserveMarketAsset), marketAssets.filter(item => item !== merchantCharter && item !== 'builder-charter' && item !== 'refinement-core'));
  assert.notEqual(translate(itemName(merchantCharter), 'ko'), itemName(merchantCharter));
  assert.equal((itemArt(merchantCharter).match(/<svg/g) ?? []).length, 1);
  const h = setup();
  try {
    h.store.transaction(h.user.token, session => {
      const before = session.account.game.dollars;
      inventory(session.account).items.push(...marketAssets.filter(isCollectible));
      craft(session.account, merchantCharter);
      assert.equal(before - session.account.game.dollars, dollarsUnits(merchantCharterFee));
    });
  } finally { h.store.close(); }
});
test('charter crafting consumes one of every terrain collectible and rejects missing, reserved or pending keepsakes without spending', () => {
  const h = setup(), keepsakes = marketAssets.filter(isCollectible);
  try {
    assert.equal(keepsakes.length, Object.keys(terrainDetails).length);
    assert.deepEqual(craftingIngredients(merchantCharter), Object.fromEntries(keepsakes.map(id => [id, 1])));
    assert.deepEqual(craftingIngredients(merchantCharter, 10), Object.fromEntries(keepsakes.map(id => [id, 10])));
    for (const missing of keepsakes) {
      h.store.transaction(h.user.token, session => {
        const bag = inventory(session.account);
        bag.items = keepsakes.filter(id => id !== missing);
        bag.pending = [missing];
        bag.marketReserved = [missing];
        const before = structuredClone(session.account);
        assert.equal(craftingMaximum(session.account.game, bag, merchantCharter), 0);
        assert.throws(() => craft(session.account, merchantCharter), /one unused keepsake from every terrain/);
        assert.deepEqual(session.account, before);
      });
    }
    h.store.transaction(h.user.token, session => {
      const bag = inventory(session.account);
      bag.items = [...keepsakes]; bag.pending = []; bag.marketReserved = [];
      const state = { ...snapshot(session.account), csrf: 'test', clockSpeed: 1, population: { global: 0, federation: null } };
      const markup = craftingPanel(state, () => '', 'all');
      for (const id of keepsakes) assert.ok(markup.includes(itemName(id)), id);
      for (const language of ['en', 'ko'] as const) {
        const details = itemDetailRows(merchantCharter, language);
        assert.ok(details.includes(translate('One of every terrain keepsake, consumed when crafting.', language)));
        assert.ok(details.includes(translate('Live player offers and pool liquidity; crafting fee is not the market price.', language)));
      }
      assert.equal(craftingMaximum(session.account.game, bag, merchantCharter), 1);
      const dollars = session.account.game.dollars;
      craft(session.account, merchantCharter);
      assert.deepEqual(bag.items, [merchantCharter]);
      assert.equal(dollars - session.account.game.dollars, dollarsUnits(merchantCharterFee));
    });
  } finally { h.store.close(); }
});
test('charter uses live dynamic pool pricing, player matching and real history without automatic reserve funding', () => {
  const h = setup(), buyer = h.store.create();
  try {
    h.store.transaction(h.user.token, (session, now, realTime, exchange) => {
      const bag = inventory(session.account);
      bag.items = Array.from({ length: 20 }, () => merchantCharter);
      exchange.fundPool(session.account, merchantCharter, 10, dollarsUnits(20000));
    });
    h.store.transaction(buyer.token, session => {
      session.account.game.stage = 0; session.account.game.population = 0;
      session.account.game.dollars = dollarsUnits(100000);
    });
    const read = () => h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) =>
      exchange.read(owner, session.account, now, realTime, merchantCharter, 1));
    const before = read(), total = h.store.publicTotals().dollars;
    assert.ok(before.market.quotes.buy.available);
    const buy = h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, {
      id: randomUUID(), revision: before.revision, command: { type: 'spot', side: 'buy', asset: merchantCharter, quantity: 1, limitDollars: before.market.quotes.buy.dollars },
    }, now, realTime));
    assert.ok(buy.market.quotes.buy.dollars > before.market.quotes.buy.dollars);
    assert.equal(buy.market.history.length, 1);
    assert.equal(buy.market.history[0].asset, merchantCharter);
    assert.equal(h.store.publicTotals().dollars, total);
    const ask = buy.market.quotes.buy.dollars - .1;
    h.store.transaction(h.user.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, {
      id: randomUUID(), revision: session.account.revision, command: { type: 'limit', side: 'sell', asset: merchantCharter, quantity: 1, price: ask },
    }, now, realTime));
    const offered = read();
    assert.equal(offered.market.quotes.buy.dollars, ask);
    h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, {
      id: randomUUID(), revision: session.account.revision, command: { type: 'spot', side: 'buy', asset: merchantCharter, quantity: 1, limitDollars: ask },
    }, now, realTime + 1000));
    const final = read();
    assert.equal(final.market.history.at(-1)!.venue, 'players');
    assert.equal(final.inventory.items.filter(id => id === merchantCharter).length, 2);
    assert.equal(h.store.publicTotals().dollars, total);
  } finally { h.store.close(); }
});
test('quote is side-effect free; one atomic action crafts, sells, consumes original permits and has an idempotent receipt', () => {
  const h = setup();
  try {
    const before = h.saved(), quote = h.quote();
    assert.deepEqual(h.saved(), before);
    assert.ok(quote.batches.length > 0);
    assert.ok(quote.batches.every(batch => batch.proceeds > batch.valuedCost));
    assert.ok(quote.estimatedProfit > 0);
    assert.ok(quote.craftingFees <= quote.startingBalance);
    assert.equal(h.quote().fingerprint, quote.fingerprint);
    h.store.transaction(h.user.token, (session, now, realTime, exchange, owner) => {
      assert.equal(exchange.read(owner, session.account, now, realTime, 'wood', 1).market.analysis, null);
      const response = { ...exchange.read(owner, session.account, now, realTime, 'wood', 1), csrf: 'fixture', clockSpeed: 1, population: { global: 200, federation: null } };
      assert.match(inventoryPanel(response, () => '', 'bulk', 'en', 'settlement', 0, merchantCharter), /data-action="auto-craft"/);
    });
    const popup = autoCraftConsumption(quote, 'en');
    assert.ok(popup.details?.some(row => row.label === 'Estimated total profit'));
    assert.ok(popup.costs.some(cost => cost.asset === merchantCharter && cost.amount === 1));
    const body = h.request(quote.fingerprint), result = h.post(body), after = h.saved();
    assert.equal(result.autoCraft!.fingerprint, quote.fingerprint);
    assert.equal(after.inventory!.items.includes(merchantCharter), false);
    assert.equal(after.game.dollars, before.game.dollars + dollarsUnits(quote.cashChange));
    assert.equal(after.inventory!.items.filter(item => item.startsWith('craft-batch-')).length, quote.remainingPermits);
    assert.equal(after.inventory!.items.filter(item => !item.startsWith('craft-batch-')).length, 0);
    assert.equal(h.post(body).autoCraft!.fingerprint, quote.fingerprint);
    assert.deepEqual(h.saved(), after);
    assert.equal(result.market.trades.reduce((sum, fill) => sum + fill.quantity, 0), quote.batches.reduce((sum, batch) => sum + batch.quantity, 0));
  } finally { h.store.close(); }
});
test('zero FTH$ still permits profitable zero-fee starter batches without reinvesting sales', () => {
  const h = setup();
  try {
    h.store.transaction(h.user.token, session => {
      session.account.game.dollars = 0;
      inventory(session.account).items = [merchantCharter, 'craft-batch-10', 'craft-batch-10'];
    });
    const before = h.saved(), quote = h.quote();
    assert.deepEqual(h.saved(), before);
    assert.equal(quote.spendingCeiling, 0);
    assert.equal(quote.craftingFees, 0);
    assert.ok(quote.batches.length > 0);
    assert.ok(quote.batches.every(batch => craftingCost(batch.item, batch.quantity).dollars === 0));
    const result = h.post(h.request(quote.fingerprint));
    assert.equal(result.autoCraft!.fingerprint, quote.fingerprint);
    assert.equal(h.saved().game.dollars, dollarsUnits(quote.proceeds));
  } finally { h.store.close(); }
});

test('merchant failures distinguish missing buyers, ingredient quotes and actual losses without consuming inventory', t => {
  let db!: DatabaseSync;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    db = this;
    return prepare.call(this, sql);
  });
  const h = setup();
  try {
    const permitPool = db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get('craft-batch-10')!;
    db.prepare('UPDATE market_pools SET units=0,dollars=0 WHERE asset=?').run('craft-batch-10');
    h.store.transaction(h.user.token, session => {
      inventory(session.account).items = [merchantCharter, 'craft-batch-10'];
    });
    const before = h.saved();
    assert.throws(() => h.quote(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /No live quote or latest trade/);
      const localized = translate(error.message, 'ko');
      assert.notEqual(localized, error.message);
      assert.doesNotMatch(localized, /No live quote|No profitable batch/);
      return true;
    });
    assert.deepEqual(h.saved(), before);
    db.prepare('UPDATE market_pools SET units=?,dollars=? WHERE asset=?').run(permitPool.units, permitPool.dollars, 'craft-batch-10');
    for (const asset of ['wood', 'water', 'metal', 'oil']) {
      db.prepare('UPDATE market_pools SET dollars=dollars*100 WHERE asset=?').run(asset);
    }
    assert.throws(() => h.quote(), /Sale proceeds do not cover crafting fees/);
    assert.deepEqual(h.saved(), before);
    for (const item of craftableKeys.filter(autoCraftableOutput)) {
      db.prepare('UPDATE market_pools SET dollars=0 WHERE asset=?').run(item);
    }
    assert.throws(() => h.quote(), /No funded buyer or pool can buy the complete batch/);
    assert.deepEqual(h.saved(), before);
  } finally { h.store.close(); }
});

test('merchant values owned materials and permits at the latest trade when live purchase quotes are missing', () => {
  const h = setup();
  try {
    h.store.transaction(h.user.token, session => {
      inventory(session.account).items = [merchantCharter, 'craft-batch-10'];
      session.account.game.stock = { wood: 100, water: 0, metal: 0, oil: 0 };
    });
    const fill = h.store.db.prepare("INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES (?,1,?,?,1,'players','fixture-buyer','fixture-seller')");
    fill.run('wood', 2, 2);
    fill.run('craft-batch-10', 3, 3);
    h.store.db.prepare("UPDATE market_pools SET dollars=0 WHERE asset IN ('wood','craft-batch-10')").run();
    for (const item of craftableKeys.filter(autoCraftableOutput))
      if (item !== 'torch') h.store.db.prepare('UPDATE market_pools SET dollars=0 WHERE asset=?').run(item);
    const before = h.saved(), quote = h.quote();
    assert.deepEqual(h.saved(), before);
    assert.deepEqual(quote.batches.map(batch => [batch.item, batch.quantity]), [['torch', 10]]);
    assert.equal(quote.batches[0].valuedCost, 23 / dollarsScale);
    const result = h.post(h.request(quote.fingerprint));
    assert.equal(result.autoCraft!.fingerprint, quote.fingerprint);
    assert.equal(h.saved().game.stock.wood, before.game.stock.wood - 10);
    assert.equal(h.saved().game.dollars, before.game.dollars + dollarsUnits(quote.proceeds));
    assert.equal(h.saved().inventory!.items.includes(merchantCharter), false);
  } finally { h.store.close(); }
});
test('historical output prices never authorize merchant sales without funded buyers', () => {
  const h = setup();
  try {
    const fill = h.store.db.prepare("INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES (?,1,?,?,1,'players','fixture-buyer','fixture-seller')");
    for (const item of craftableKeys.filter(autoCraftableOutput)) {
      fill.run(item, dollarsUnits(10000), dollarsUnits(10000));
      h.store.db.prepare('UPDATE market_pools SET dollars=0 WHERE asset=?').run(item);
    }
    const before = h.saved(), fills = h.store.db.prepare('SELECT COUNT(*) AS n FROM market_fills').get()!.n;
    assert.throws(() => h.quote(), /No funded buyer or pool can buy the complete batch/);
    assert.deepEqual(h.saved(), before);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM market_fills').get()!.n, fills);
  } finally { h.store.close(); }
});

test('merchant failures remain visible in inventory after the temporary toast disappears', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const operation = main.slice(main.indexOf('async function automaticCraftAndSell'), main.indexOf('function renderInventoryPage'));
  assert.match(operation, /merchantReviewError = ''/);
  assert.match(operation, /merchantReviewError = error instanceof Error/);
  const rendering = main.slice(main.indexOf('function renderInventoryPage'), main.indexOf('const inventorySearchInput'));
  assert.match(rendering, /role="alert"/);
  assert.match(rendering, /escape\(translate\(merchantReviewError, language\)\)/);
});

test('ranks highest-profit eligible recipes first and reuses every feasible original permit', () => {
  const h = setup();
  try {
    const report = h.store.transaction(h.user.token, (session, now, realTime, exchange, owner) =>
      exchange.action(owner, session, { id: randomUUID(), revision: session.account.revision, command: { type: 'profit-analysis' } }, now, realTime).market.analysis!);
    const eligible = report.items.filter(row => row.profit !== null && row.profit > 0 && row.item !== merchantCharter && !row.item.startsWith('craft-batch-')
      && Object.keys(craftingIngredients(row.item)).length === 0).sort((a, b) => b.profit! - a.profit! || a.item.localeCompare(b.item));
    const quote = h.quote();
    assert.equal(quote.batches[0].item, eligible[0].item);
    assert.equal(quote.batches[0].quantity, 100);
    assert.equal(quote.consumedPermits, 4);
    assert.equal(quote.remainingPermits, 0);
  } finally { h.store.close(); }
});
test('live liquidity changes invalidate confirmation and receipt failures roll back crafts, fills and balances', t => {
  const prepare = DatabaseSync.prototype.prepare;
  let connection: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) { connection = this; return prepare.call(this, sql); });
  const h = setup(), db = connection;
  assert.ok(db);
  try {
    const quote = h.quote();
    const first = quote.batches[0].item;
    db.prepare('UPDATE market_pools SET dollars=dollars-10000 WHERE asset=?').run(first);
    const before = h.saved(), pools = db.prepare('SELECT * FROM market_pools ORDER BY asset').all();
    assert.throws(() => h.post(h.request(quote.fingerprint)), /quote changed/);
    assert.deepEqual(h.saved(), before);
    assert.deepEqual(db.prepare('SELECT * FROM market_pools ORDER BY asset').all(), pools);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_fills').get()!.count, 0);
    const fresh = h.quote();
    db.exec("CREATE TRIGGER fail_charter_receipt BEFORE INSERT ON market_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
    assert.throws(() => h.post(h.request(fresh.fingerprint)), /fixture receipt failure/);
    assert.deepEqual(h.saved(), before);
    assert.deepEqual(db.prepare('SELECT * FROM market_pools ORDER BY asset').all(), pools);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_fills').get()!.count, 0);
    db.exec('DROP TRIGGER fail_charter_receipt;');
    for (const item of craftableKeys) if (item !== merchantCharter && !item.startsWith('craft-batch-')) db.prepare('UPDATE market_pools SET dollars=0 WHERE asset=?').run(item);
    assert.throws(() => h.quote(), /No profitable batch/);
    assert.deepEqual(h.saved(), before);
    const buyer = h.store.create();
    h.store.transaction(buyer.token, session => {
      const game = session.account.game;
      game.stage = 0; game.home = { ...game.position }; game.dollars = 500000 * dollarsScale;
    });
    h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, {
      id: randomUUID(), revision: session.account.revision, command: { type: 'limit', side: 'buy', asset: first, quantity: 50, price: 5000 },
    }, now, realTime));
    const limited = h.quote();
    assert.deepEqual(limited.batches.map(batch => batch.quantity), [50]);
    assert.equal(limited.remainingPermits, 3);
    const result = h.post(h.request(limited.fingerprint));
    assert.equal(result.autoCraft!.consumedPermits, 1);
    assert.equal(h.saved().inventory!.items.includes('craft-batch-100'), true);
    assert.equal(h.store.read(buyer.token, session => session.account.inventory!.items.filter(item => item === first).length), 50);
  } finally { h.store.close(); }
});
test('starting balance is a hard fee ceiling even when sales create more funds; reserved permits never qualify', () => {
  const h = setup();
  try {
    h.store.transaction(h.user.token, session => {
      session.account.game.dollars = 15 * dollarsScale;
      session.account.game.stock.wood = 0;
      session.account.game.stock.water = 0;
      const bag = inventory(session.account);
      bag.items = [merchantCharter, 'craft-batch-10', 'craft-batch-10', 'craft-batch-10'];
      bag.marketReserved = ['craft-batch-100'];
    });
    const quote = h.quote();
    assert.ok(quote.craftingFees <= 15);
    assert.equal(quote.spendingCeiling, 15);
    assert.equal(quote.batches.length, 1);
    assert.equal(quote.remainingPermits, 2);
    assert.ok(quote.proceeds > 15);
    h.post(h.request(quote.fingerprint));
    const after = h.saved();
    assert.equal(after.inventory!.marketReserved!.length, 1);
    assert.equal(after.inventory!.items.filter(item => item === 'craft-batch-10').length, 2);
  } finally { h.store.close(); }
});
test('million-dollar ceiling stops a funded profitable run exactly at the cap and preserves unused permits', t => {
  let db!: DatabaseSync;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    db = this;
    return prepare.call(this, sql);
  });
  const h = setup(), buyer = h.store.create();
  const originalFee = craftableItems.torch.cost.dollars;
  try {
    // A high-fee fixture reaches the production cap in one batch, without thousands of test crafts.
    craftableItems.torch.cost.dollars = 100000;
    for (const item of craftableKeys) if (item !== merchantCharter && !item.startsWith('craft-batch-'))
      db.prepare('UPDATE market_pools SET dollars=0,units=0 WHERE asset=?').run(item);
    h.store.transaction(h.user.token, session => {
      session.account.game.dollars = dollarsUnits(2000000);
      inventory(session.account).items = [merchantCharter, 'craft-batch-100', 'craft-batch-100'];
    });
    h.store.transaction(buyer.token, session => {
      session.account.game.stage = 0;
      session.account.game.dollars = dollarsUnits(10000000);
    });
    h.store.transaction(buyer.token, (session, now, realTime, exchange, owner) => exchange.action(owner, session, {
      id: randomUUID(), revision: session.account.revision,
      command: { type: 'limit', side: 'buy', asset: 'torch', quantity: 200, price: 20000 },
    }, now, realTime));
    h.store.transaction(h.user.token, session => { session.account.game.dollars = dollarsUnits(merchantSpendingLimit - .0001); });
    const insufficient = h.saved();
    assert.throws(() => h.quote(), /No profitable batch/);
    assert.deepEqual(h.saved(), insufficient);
    h.store.transaction(h.user.token, session => { session.account.game.dollars = dollarsUnits(2000000); });
    const before = h.saved(), quote = h.quote();
    assert.deepEqual(h.saved(), before);
    assert.equal(quote.startingBalance, 2000000);
    assert.equal(quote.spendingCeiling, merchantSpendingLimit);
    assert.equal(quote.craftingFees, merchantSpendingLimit);
    assert.equal(quote.batches.length, 1);
    assert.equal(quote.consumedPermits, 1);
    assert.equal(quote.remainingPermits, 1);
    for (const language of ['en', 'ko'] as const) {
      const popup = autoCraftConsumption(quote, language);
      assert.equal(popup.details!.find(row => row.label === 'Starting spending ceiling')!.value, 'FTH$ 1,000,000');
      assert.ok(popup.notes.includes('Crafting fees are capped at FTH$1,000,000 per merchant run, or your starting balance if lower. Unused funds and permits remain available.'));
    }
    const capNote = 'Crafting fees are capped at FTH$1,000,000 per merchant run, or your starting balance if lower. Unused funds and permits remain available.';
    assert.notEqual(translate(capNote, 'ko'), capNote);
    const body = h.request(quote.fingerprint), result = h.post(body);
    assert.equal(result.autoCraft!.craftingFees, merchantSpendingLimit);
    assert.equal(result.autoCraft!.spendingCeiling, merchantSpendingLimit);
    const after = h.saved();
    assert.equal(after.game.dollars, before.game.dollars + dollarsUnits(quote.cashChange));
    assert.deepEqual(after.inventory!.items, ['craft-batch-100']);
    h.post(body);
    assert.deepEqual(h.saved(), after);
  } finally {
    craftableItems.torch.cost.dollars = originalFee;
    h.store.close();
  }
});
test('missing charter, supplies, permits, changed revision and forged totals never consume on failure', () => {
  const h = setup();
  try {
    assert.throws(() => parseMarketCommand({ type: 'auto-craft', fingerprint: 'x' }), /Invalid automatic/);
    assert.throws(() => parseMarketCommand({ type: 'auto-craft', fingerprint: 'a'.repeat(64), profit: 999 }), /Invalid automatic/);
    const quote = h.quote(), before = h.saved();
    assert.throws(() => h.post(h.request('a'.repeat(64))), /quote changed/);
    assert.deepEqual(h.saved(), before);
    h.store.transaction(h.user.token, session => { session.account.game.stock = { wood: 0, water: 0, metal: 0, oil: 0 }; });
    const noSupplies = h.saved();
    assert.throws(() => h.quote(), /No profitable batch/);
    assert.deepEqual(h.saved(), noSupplies);
    assert.throws(() => h.post({ ...h.request(quote.fingerprint), revision: -1 }), /Invalid|World changed/);
    h.store.transaction(h.user.token, session => { session.account.inventory!.items = [merchantCharter]; });
    assert.throws(() => h.quote(), /bulk crafting permits/);
    h.store.transaction(h.user.token, session => { session.account.inventory!.items = ['craft-batch-10']; });
    assert.throws(() => h.quote(), /unused Master Merchant/);
  } finally { h.store.close(); }
});
test('catalog prices, paid analysis and merchant preview initialize approved markets before quoting', async () => {
  const h = setup(), origin = 'http://127.0.0.1:5173', server = createApi(h.store, origin);
  const pools = h.store.db.prepare('SELECT * FROM market_pools').all();
  const requested: string[] = [];
  Object.defineProperty(h.store, 'liquidityEnabled', { value: true });
  h.store.ensureLiquidity = async (_token, asset) => {
    requested.push(asset);
    const pool = pools.find(pool => pool.asset === asset)!;
    h.store.db.prepare('UPDATE market_pools SET units=?,dollars=? WHERE asset=?').run(pool.units, pool.dollars, asset);
  };
  const clear = () => {
    requested.length = 0;
    h.store.db.exec('UPDATE market_pools SET units=0,dollars=0');
  };
  const approved = marketAssets.filter(isReserveMarketAsset);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/dollar/game`;
    const headers = { Cookie: `terra-dev=${h.user.token}` };
    clear();
    assert.equal((await fetch(`${base}/market?catalog=1`)).status, 401);
    assert.equal(requested.length, 0);
    assert.equal((await fetch(`${base}/market?catalog=2`, { headers })).status, 400);
    const live = await fetch(`${base}/market?asset=torch&quantity=1&catalog=1`, { headers });
    assert.equal(live.status, 200);
    const liveBody = await live.json();
    assert.ok(liveBody.market.tickers.filter((ticker: { asset: string }) => approved.includes(ticker.asset as typeof approved[number]))
      .every((ticker: { bid: number }) => ticker.bid > 0));
    assert.deepEqual([...new Set(requested)], approved);
    clear();
    const body = JSON.stringify({ id: randomUUID(), revision: h.saved().revision, command: { type: 'profit-analysis' } });
    const post = (csrf: string) => fetch(`${base}/market/actions`, { method: 'POST',
      headers: { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
    assert.equal((await post('invalid')).status, 403);
    assert.equal(requested.length, 0);
    const paid = await post(h.user.csrf);
    assert.equal(paid.status, 200);
    assert.deepEqual(requested, approved);
    const paidBody = await paid.json();
    assert.ok(paidBody.market.analysis.items.some((row: { profit: number | null }) => row.profit !== null));
    clear();
    const merchant = await fetch(`${base}/market/auto-craft`, { headers });
    assert.equal(merchant.status, 200);
    assert.deepEqual(requested, approved);
    assert.ok((await merchant.json()).autoCraft.batches.length > 0);
    assert.ok(h.saved().inventory!.items.includes(merchantCharter));
  } finally { server.close(); h.store.close(); }
});

test('HTTP preview is authenticated and confirmation requires CSRF and the authoritative fingerprint', async () => {
  const h = setup(), origin = 'http://127.0.0.1:5173', server = createApi(h.store, origin);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/dollar/game`, headers = { Cookie: `terra-dev=${h.user.token}` };
    assert.equal((await fetch(`${base}/market/auto-craft`)).status, 401);
    assert.equal((await fetch(`${base}/market/auto-craft?extra=1`, { headers })).status, 400);
    const response = await fetch(`${base}/market/auto-craft`, { headers }); assert.equal(response.status, 200);
    const preview = await response.json() as AutoCraftResponse;
    assert.ok(preview.autoCraft.estimatedProfit > 0);
    assert.ok(preview.inventory.items.includes(merchantCharter));
    const body = { id: randomUUID(), revision: preview.revision, command: { type: 'auto-craft', fingerprint: preview.autoCraft.fingerprint } };
    const post = (csrf: string) => fetch(`${base}/market/actions`, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    assert.equal((await post('invalid')).status, 403);
    assert.ok(h.saved().inventory!.items.includes(merchantCharter));
    assert.equal((await post(preview.csrf)).status, 200);
    assert.equal(h.saved().inventory!.items.includes(merchantCharter), false);
  } finally { server.close(); h.store.close(); }
});
