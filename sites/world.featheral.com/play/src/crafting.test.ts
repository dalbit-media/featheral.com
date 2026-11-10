import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, parseCommand, snapshot } from '../server/economy.ts';
import { craft, inventory } from '../server/inventory.ts';
import { craftingPanel } from './inventory-view.ts';
import { craftableKeys, craftableItems, craftingCost, craftingIngredients, craftingMaximum, decorationItems, craftingStage, craftingStageName, isCraftableItem, isDecorationItem, itemName } from './items.ts';
import type { DecorationItem } from './items.ts';
import type { ApiState } from './api-types.ts';
import { decorationDrawing, itemArt } from './item-art.ts';
import { isMarketAsset, marketBasePrice } from './market.ts';
import type { MarketSnapshot } from './market.ts';
import { renderPriceChange } from './marketplace-catalog.ts';
import { gameConsumption } from './consumption.ts';
import { withDollarFee } from './costs.ts';
import { dollarsScale, dollarsUnits } from './dollars.ts';
import { translate } from './i18n.ts';
import { marketAnalysisDuration } from './market-analysis.ts';
import type { MarketAnalysis } from './market-analysis.ts';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

function fixture(): ApiState {
  const account = createAccount(1000000);
  account.game.stage = 8;
  account.game.population = 12;
  account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
  account.game.dollars = 100000000;
  account.game.explored = Array.from({ length: 61 }, (_, x) => Array.from({ length: 61 }, (_, y) => `${x - 30},${y - 30}`)).flat();
  return { ...snapshot(account), csrf: 'test', clockSpeed: 1, population: { global: 12, federation: null } };
}
test('30 decorations cover all nine civilization levels with distinct artwork, recipes, translations and market support', () => {
  const ids = Object.keys(decorationItems) as DecorationItem[];
  assert.equal(ids.length, 30);
  assert.deepEqual([...new Set(ids.map(craftingStage))].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(ids.map(decorationDrawing)).size, 30);
  for (const id of ids) {
    assert.ok(isCraftableItem(id) && isDecorationItem(id) && isMarketAsset(id));
    assert.ok(marketBasePrice(id) > 0);
    assert.match(itemArt(id), /<svg viewBox="0 0 64 64"/);
    assert.doesNotMatch(decorationDrawing(id), /undefined|NaN/);
    assert.notEqual(translate(itemName(id), 'ko'), itemName(id));
    assert.ok(Object.entries(decorationItems[id].cost).every(([resource, amount]) => Number.isSafeInteger(amount) && (resource === 'dollars' ? amount >= 0 : amount > 0)));
    assert.deepEqual(parseCommand({ type: 'craft', item: id, quantity: 10 }), { type: 'craft', item: id, quantity: 10 });
  }
  assert.equal(Object.hasOwn(decorationItems.fountain.cost, 'wood'), false);
  assert.equal(decorationItems.logseat.cost.wood, 6);
  assert.equal(decorationItems.biodome.cost.water, 160);
});
test('civilization-level crafting checks are authoritative and leave existing owned cosmetics usable', () => {
  for (const id of Object.keys(decorationItems) as DecorationItem[]) {
    if (!craftingStage(id)) continue;
    const account = createAccount(1000000);
    account.game.stage = craftingStage(id) - 1;
    const bag = inventory(account);
    bag.items = [id];
    const before = structuredClone(account);
    assert.equal(craftingMaximum(account.game, bag, id), 0);
    assert.throws(() => craft(account, id), new RegExp(`Requires ${craftingStageName(id)}`));
    assert.deepEqual(account, before);
    assert.ok(bag.items.includes(id));
  }
});
test('recipe disclosure counts sufficient ingredient types and shows physical owned/needed amounts for the batch', () => {
  const state = fixture();
  state.game.stock.metal = 1;
  state.game.stock.wood = 1;
  const html = craftingPanel(state, () => '', 'decoration', 'settlement', 2);
  const bench = html.split('data-detail="recipe-bench"')[1].split('</article>')[0];
  assert.doesNotMatch(bench, /<span>Ingredients<\/span> <strong>/);
  assert.match(bench, /No item ingredients required/);
  assert.match(bench, /50 kg \/ 300 kg/);
  assert.match(bench, /0.01 t \/ 0.02 t/);
  assert.equal((bench.match(/class="missing"/g) ?? []).length, 2);
  assert.match(bench, /data-action-eligible="false"/);
  const logseat = html.split('data-detail="recipe-logseat"')[1].split('</article>')[0];
  assert.doesNotMatch(logseat, /<span>Ingredients<\/span> <strong>/);
  state.game.stock.wood = 10;
  const affordable = craftingPanel(state, () => '', 'affordable');
  assert.match(affordable, /recipe-bench/);
  assert.doesNotMatch(affordable, /recipe-skybeacon/);
});
test('collector recipe 4/8 discloses usable copies only, excluding market escrow and pending finds', () => {
  const state = fixture();
  state.inventory.items = ['collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-12', 'collection-wood-4',
    'collection-water-12', 'collection-water-12', 'collection-water-12', 'collection-water-12', 'collection-water-4'];
  state.inventory.marketReserved = ['collection-metal-4'];
  state.inventory.pending = ['collection-oil-4'];
  const html = craftingPanel(state, () => '', 'collectors');
  const recipe = html.split('data-detail="recipe-collector-all-52"')[1].split('</article>')[0];
  assert.match(recipe, /<span>Ingredients<\/span> <strong>4\/8<\/strong>/);
  assert.equal((recipe.match(/class="available"/g) ?? []).length, 5);
  assert.equal((recipe.match(/class="missing"/g) ?? []).length, 4);
  assert.match(recipe, /Metal auto-collection · 4 game weeks<\/span><strong>0 \/ 1/);
  assert.match(recipe, /Oil auto-collection · 4 game weeks<\/span><strong>0 \/ 1/);
});
test('only four starter recipes waive FTH$ per copy without mutating recipes or reserve seed prices', () => {
  const recipes = structuredClone(craftableItems);
  const prices = craftableKeys.map(marketBasePrice);
  const state = fixture();
  state.inventory.items = ['craft-batch-10', 'craft-batch-20', 'craft-batch-50', 'craft-batch-100'];
  assert.doesNotThrow(() => craftingPanel(state, () => '', 'all'));
  for (const item of craftableKeys) {
    const cost = craftingCost(item);
    const starter = ['fire', 'torch', 'logseat', 'flowerbed'].includes(item);
    assert.ok(starter ? cost.dollars === 0 : cost.dollars! >= 1, item);
    assert.equal(cost.dollars, starter ? 0 : Math.max(1, withDollarFee(craftableItems[item].cost).dollars / 10), item);
    for (const quantity of [1, 10, 20, 50, 100]) {
      const expectedDollars = dollarsUnits(cost.dollars!) * quantity / dollarsScale;
      assert.equal(craftingCost(item, quantity).dollars, expectedDollars);
      assert.equal(dollarsUnits(craftingCost(item, quantity).dollars!), dollarsUnits(cost.dollars!) * quantity);
      for (const resource of ['wood', 'water', 'metal', 'oil'] as const)
        if (cost[resource] !== undefined) assert.equal(craftingCost(item, quantity)[resource], cost[resource]! * quantity);
      const quote = gameConsumption(state, { type: 'craft', item, quantity })!;
      assert.ok(quote.costs.some(row => row.asset === 'dollars' && row.amount === expectedDollars));
    }
    for (const [resource, amount] of Object.entries(craftableItems[item].cost))
      if (resource !== 'dollars') {
        assert.equal(cost[resource as keyof typeof cost], Math.ceil(amount / 10));
        assert.ok(Number.isSafeInteger(cost[resource as keyof typeof cost]));
      }
  }
  assert.equal(craftingCost('logseat').dollars, 0);
  assert.equal(craftingCost('bench').dollars, 10);
  assert.equal(craftingCost('collector-wood-4').dollars, 1);
  assert.equal(craftingCost('lantern').dollars, 1);
  assert.deepEqual(craftableItems, recipes);
  assert.deepEqual(craftableKeys.map(marketBasePrice), prices);
});
test('server requires the shared crafting fee for every recipe and spends nothing on insufficient funds', () => {
  for (const item of craftableKeys) {
    const account = createAccount(1000000);
    account.game.stage = 8;
    account.game.stock = { wood: 10000, water: 10000, metal: 10000, oil: 10000 };
    account.game.explored = fixture().game.explored;
    const bag = inventory(account);
    bag.storage = 4;
    bag.items = Object.entries(craftingIngredients(item)).flatMap(([id, count]) => Array.from({ length: count }, () => id as typeof bag.items[number]));
    inventory(account);
    const fee = craftingCost(item).dollars!;
    if (fee === 0) {
      account.game.dollars = 0;
      assert.ok(craftingMaximum(account.game, bag, item) > 0, item);
      craft(account, item);
      assert.equal(account.game.dollars, 0, item);
      continue;
    }
    account.game.dollars = fee * 10000 - 1;
    assert.equal(craftingMaximum(account.game, bag, item), 0, item);
    const before = structuredClone(account);
    assert.throws(() => craft(account, item), /Not enough resources/, item);
    assert.deepEqual(account, before, item);
    account.game.dollars++;
    craft(account, item);
    assert.equal(account.game.dollars, 0, item);
    assert.deepEqual(bag.items, [item]);
  }
});
test('craft cards reuse Marketplace sell quotes and seven-day trends, without synthetic prices or trends', () => {
  const state = fixture();
  for (const change7d of [12.34, -4.56, 0, null]) {
    const ticker: MarketSnapshot['tickers'][number] = { asset: 'bench', bid: 123.4567, ask: 125, last: null, change7d };
    const html = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'en', [ticker]);
    const bench = html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
    assert.ok(bench.includes(renderPriceChange(ticker, '7d', 'en', true)));
    assert.match(bench, /Sell price <strong>123.4567 FTH\$/);
    assert.doesNotMatch(bench, /data-change-window="24h"/);
  }
  const absent = craftingPanel(state, () => '', 'decoration');
  assert.match(absent, /Sell price <strong>—<\/strong>/);
  assert.match(absent, /Prices unavailable/);
  const korean = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'ko',
    [{ asset: 'bench', bid: 123, ask: 125, last: null, change7d: -5 }]);
  assert.match(korean, /▼ 5.0%/);
  assert.match(korean, /data-direction="down"/);
});
test('craft keeps missing valuations concise without blocking owned-material crafting', () => {
  const state = fixture();
  for (const language of ['en', 'ko'] as const) {
    const report: MarketAnalysis = {
      generatedAt: state.serverTime, expiresAt: state.serverTime + marketAnalysisDuration, fee: 100,
      items: [{ item: 'bench', craftingFee: 10, ingredients: [
        { asset: 'wood', quantity: 6, dollars: null }, { asset: 'metal', quantity: 1, dollars: 2 },
      ], cost: null, revenue: 160, profit: null }],
    };
    const render = (bid: number) => craftingPanel(state, () => '', 'decoration', 'settlement', 1, language,
      [{ asset: 'bench', bid, ask: 170, last: null }], report, state.serverTime);
    const card = (html: string) => html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
    let bench = card(render(160));
    assert.ok(bench.includes(translate('Missing ingredient prices', language)));
    assert.doesNotMatch(bench, /recipe-quote-help|Why no quote|snapshot, not a connection error/);
    assert.match(bench, /data-action="craft"[^>]*data-action-eligible="true"/);
    report.items[0].revenue = null;
    bench = card(render(0));
    assert.ok(bench.includes(translate('No buyers', language)));
    assert.ok(bench.includes(translate('No sale quote', language)));
    report.items[0].ingredients[0].dollars = 12;
    report.items[0].cost = 24; report.items[0].revenue = 160; report.items[0].profit = 136;
    bench = card(render(160));
    assert.doesNotMatch(bench, /recipe-quote-help/);
    assert.ok(bench.includes('+136 FTH$'));
  }
});

test('craft uses the latest traded sell price only when no live bid is available', () => {
  for (const language of ['en', 'ko'] as const) {
    const render = (bid: number, last: number | null) => craftingPanel(fixture(), () => '', 'decoration', 'settlement', 1, language,
      [{ asset: 'bench', bid, ask: 170, last }]).split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
    const historical = render(0, 123.4567);
    assert.ok(historical.includes(translate('Latest trade', language)));
    assert.match(historical, /123.4567 FTH\$/);
    const live = render(160, 123.4567);
    assert.ok(live.includes(translate('Sell price', language)));
    assert.match(live, /160 FTH\$/);
    assert.doesNotMatch(live, /123.4567 FTH\$/);
    for (const last of [null, 0, -1, NaN, Infinity])
      assert.ok(render(0, last).includes(translate('No buyers', language)));
  }
});
test('compact craft cards show batch consumption before collapsed recipe details and name their icon action', () => {
  const html = craftingPanel(fixture(), () => '<span class="cost">batch resources</span>', 'decoration', 'settlement', 2);
  const bench = html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
  assert.ok(bench.indexOf('batch resources') < bench.indexOf('<details'));
  assert.match(bench, /class="recipe-details" data-detail="recipe-bench"/);
  assert.doesNotMatch(bench, /<details[^>]* open/);
  assert.match(bench, /compact-item-action[^>]*data-item="bench"[^>]*aria-label="Craft: Wooden bench × 2"/);
  assert.doesNotMatch(bench, /<span>Craft<\/span>/);
});
test('crafting loads one shared market catalog, throttles requests and surfaces failures without stale prices', async () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function refreshCraftingPrices'), source.indexOf('async function purchaseCraftingAnalysis')));
  let calls = 0, renders = 0, errors = 0, now = 0, fail = false;
  const tickers = [{ asset: 'bench', bid: 100, ask: 101, last: null, change7d: 5 }];
  const context = {
    Error,
    craftingPricesLoading: false, craftingPricesAttemptAt: -Infinity, craftingPricesError: '', craftingTickers: [],
    document: { hidden: false }, inventoryMenuPage: true, inventoryTab: 'craft', busy: false, confirmationOpen: () => false,
    performance: { now: () => now }, serverSyncIntervalMs: 30000,
    readMarket: async (asset: string, quantity: number, buying: unknown, catalog: boolean) => {
      calls++; assert.equal(asset, 'torch'); assert.equal(quantity, 1);
      assert.equal(buying, undefined); assert.equal(catalog, true);
      if (fail) throw new Error('Market connection unavailable.');
      return { market: { tickers } };
    },
    renderInventoryPage: () => { renders++; }, console: { error: () => { errors++; } },
  };
  const refreshPrices = runInNewContext(`${code}; refreshCraftingPrices;`, context);
  await refreshPrices();
  assert.equal(calls, 1); assert.equal(context.craftingTickers, tickers);
  await refreshPrices(); assert.equal(calls, 1);
  context.document.hidden = true; now = 30000; await refreshPrices(); assert.equal(calls, 1);
  context.document.hidden = false; context.inventoryTab = 'inventory'; await refreshPrices(); assert.equal(calls, 1);
  context.inventoryTab = 'craft'; fail = true; await refreshPrices();
  assert.equal(calls, 2); assert.equal(context.craftingTickers.length, 0);
  assert.equal(context.craftingPricesError, 'Market connection unavailable.');
  assert.equal(errors, 1); assert.equal(context.craftingPricesLoading, false);
  fail = false; await refreshPrices(true); assert.equal(calls, 3); assert.equal(context.craftingPricesError, '');
  context.craftingPricesLoading = true; await refreshPrices(true); assert.equal(calls, 3);
  assert.equal(renders, 3);
  assert.match(source, /craftingPanel\(state, costChips, craftingFilter, 'explore', 1, language, craftingTickers,/);
  assert.match(source, /data-action="crafting-prices"/);
});
test('profit estimates stay hidden without an active paid analysis while sell prices remain visible', () => {
  const tickers: MarketSnapshot['tickers'] = [
    { asset: 'bench', bid: 160, ask: 170, last: null },
    { asset: 'wood', bid: 2, ask: 3, last: null },
    { asset: 'metal', bid: 1, ask: 2, last: null },
  ];
  for (const language of ['en', 'ko'] as const) {
    const html = craftingPanel(fixture(), () => '<span class="cost">fees</span>', 'decoration', 'settlement', 1, language, tickers);
    const bench = html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
    assert.match(bench, /class="recipe-market"/);
    assert.match(bench, /160 FTH\$/);
    assert.doesNotMatch(html, /recipe-estimate|recipe-snapshot-estimate|data-profit=|Estimated profit|Estimated loss|Estimate unavailable|예상 이익/);
    assert.match(html, /data-analysis-state="locked"/);
  }
  const html = craftingPanel(fixture(), () => '', 'decoration', 'settlement', 1, 'en', tickers);
  const filters = html.split('class="inventory-filters crafting-filters"')[1].split('</div>')[0];
  assert.equal((filters.match(/data-action="crafting-filter"/g) ?? []).length, 8);
  assert.match(filters, /data-filter="efficiency" aria-pressed="false" aria-label="Cost-saving equipment" title="Cost-saving equipment"><svg class="icon /);
  assert.doesNotMatch(filters, />[A-Za-z][^<]*<\/button>/);
  const ko = craftingPanel(fixture(), () => '', 'decoration', 'settlement', 1, 'ko', tickers);
  assert.match(ko, /aria-label="비용 절감 장비"/);
  const css = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(css, /#crafting \.consumption-costs \.cost\{font-size:9px;font-weight:400/);
  assert.match(css, /#crafting \.crafting-analysis-access\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto auto/);
  assert.doesNotMatch(css, /#crafting \.recipe-estimate\{/);
});test('paid market analysis is purchased in crafting and displays active per-copy profit breakdowns', () => {
  const state = fixture();
  const report: MarketAnalysis = {
    generatedAt: state.serverTime,
    expiresAt: state.serverTime + marketAnalysisDuration,
    fee: 100,
    items: [{ item: 'bench', craftingFee: 10, ingredients: [{ asset: 'wood', quantity: 6, dollars: 12 }],
      cost: 22, revenue: 160, profit: 138 }],
  };
  const html = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'en', [], report, state.serverTime);
  assert.match(html, /class="crafting-analysis-access" data-analysis-state="active"/);
  assert.match(html, /data-action="crafting-analysis" aria-label="Refresh analysis · FTH\$100"/);
  assert.match(html, /data-crafting-analysis-status role="status">\d+ game hours left</);
  assert.match(html, /Profit per copy/);
  const bench = html.split('<h3>Wooden bench</h3>')[1].split('</article>')[0];
  assert.match(bench, /data-snapshot-profit="profit"/);
  assert.match(bench, /\+138 FTH\$/);
  assert.match(bench, /class="recipe-analysis-cost"/);
  assert.match(bench, /FTH\$ 22/);
  assert.doesNotMatch(html, /recipe-estimate-details|crafting-analysis-rules|crafting-help/);
  const lastMinute = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'en', [], report, report.expiresAt - 1);
  assert.match(lastMinute, /recipe-snapshot-estimate/);
  const expired = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'en', [], report, report.expiresAt);
  assert.match(expired, /data-analysis-state="expired"/);
  assert.match(expired, /role="status">Expired</);
  assert.doesNotMatch(expired, /recipe-snapshot-estimate|Profit per copy/);
  const locked = craftingPanel(state, () => '', 'decoration', 'settlement', 1, 'en', [], null, state.serverTime, false, true);
  assert.match(locked, /aria-label="Get profit analysis · FTH\$100"/);
  assert.match(locked, /data-action="crafting-analysis"[^>]* disabled/);
});
