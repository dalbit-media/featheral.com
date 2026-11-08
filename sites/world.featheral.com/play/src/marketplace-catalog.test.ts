import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { filterMarketCatalog, formatPriceChange, renderMarketCatalog } from './marketplace-catalog.ts';
import type { CatalogSort } from './marketplace-catalog.ts';
import { marketAssets } from './market.ts';
import { activeMarketAnalysis, marketAnalysisDuration, marketRarity } from './market-analysis.ts';
import type { MarketAnalysis } from './market-analysis.ts';

const state = snapshot(createAccount(1000000));
const tickers = [
  { asset: 'lamp' as const, bid: 30, ask: 35, last: null },
  { asset: 'torch' as const, bid: 10, ask: 15, last: null },
  { asset: 'collection-wood-1' as const, bid: 0, ask: Number.MAX_SAFE_INTEGER / 10000, last: null },
];
test('price sorting supports both directions and always places missing offers last without mutating quotes', () => {
  const before = structuredClone(tickers);
  for (const sort of ['buy-low', 'sell-low'] as const)
    assert.deepEqual(filterMarketCatalog(tickers, state, 'en', 'all', '', sort, false).map(ticker => ticker.asset), ['torch', 'lamp', 'collection-wood-1']);
  for (const sort of ['buy-high', 'sell-high'] as const)
    assert.deepEqual(filterMarketCatalog(tickers, state, 'en', 'all', '', sort, false).map(ticker => ticker.asset), ['lamp', 'torch', 'collection-wood-1']);
  assert.deepEqual(tickers, before);
});
test('all-item browsing retains all 121 markets and item category never hides resources from the all filter', () => {
  const all = marketAssets.map(asset => ({ asset, bid: 1, ask: 2, last: null }));
  assert.equal(filterMarketCatalog(all, state, 'en', 'all', '', 'name', false).length, 121);
  assert.equal(filterMarketCatalog(all, state, 'en', 'resources', '', 'name', false).length, 4);
  assert.equal(filterMarketCatalog(all, state, 'en', 'items', '', 'name', false).length, 117);
  assert.ok(filterMarketCatalog(all, state, 'en', 'automation', '', 'name', false).some(({ asset }) => asset === 'transport-convoy'));
  const equipment = filterMarketCatalog(all, state, 'en', 'equipment', '', 'name', false);
  assert.equal(equipment.length, 13);
  assert.ok(equipment.some(({ asset }) => asset === 'survey-array'));
  const forward = filterMarketCatalog(all, state, 'en', 'all', '', 'name', false).map(ticker => ticker.asset);
  assert.deepEqual(filterMarketCatalog(all, state, 'en', 'all', '', 'name-desc', false).map(ticker => ticker.asset), forward.toReversed());
});
test('table sorting exposes direction and keeps every trade button draft-only', () => {
  const html = renderMarketCatalog(tickers, state, 'lamp', 'table', 'en', false, 'buy-high');
  assert.match(html, /aria-sort="descending"><button[^>]*data-catalog-column="buy-low"[^>]*data-catalog-sort="buy-low"/);
  assert.match(html, /data-catalog-sort="name"/);
  assert.match(html, /data-catalog-sort="owned"/);
  assert.equal(html.match(/data-market-quick-side=/g)!.length, 6);
  assert.doesNotMatch(html, /type="submit"/);
});
const changing = [
  { asset: 'lamp' as const, bid: 30, ask: 35, last: 35, change24h: 3.24, change7d: -12.5 },
  { asset: 'torch' as const, bid: 10, ask: 15, last: 15, change24h: -0.04, change7d: 40 },
  { asset: 'wood' as const, bid: 1, ask: 2, last: null, change24h: null, change7d: null },
];
test('price changes render colored arrows for 24 hours and 7 days in grid and table views', () => {
  assert.deepEqual(formatPriceChange(3.24, 'en'), { direction: 'up', text: '▲ 3.2%' });
  assert.deepEqual(formatPriceChange(-12.5, 'en'), { direction: 'down', text: '▼ 12.5%' });
  assert.deepEqual(formatPriceChange(-0.04, 'en'), { direction: 'flat', text: '0.0%' });
  assert.deepEqual(formatPriceChange(null, 'en'), { direction: 'none', text: '—' });
  for (const view of ['grid', 'table'] as const) {
    const html = renderMarketCatalog(changing, state, 'lamp', view, 'en', false);
    assert.equal(html.match(/class="catalog-change"/g)!.length, 6);
    assert.match(html, /data-change-window="24h" data-direction="up"[^>]*aria-label="Price change 24 hours: Up 3\.2%"/);
    assert.match(html, /data-change-window="7d" data-direction="down"[^>]*aria-label="Price change 7 days: Down 12\.5%"/);
    assert.match(html, /data-direction="none"[^>]*aria-label="Price change 24 hours: No sales yet"/);
  }
  const table = renderMarketCatalog(changing, state, 'lamp', 'table', 'en', false);
  assert.match(table, /data-catalog-column="change24h-low" data-catalog-sort="change24h-high"/);
  assert.match(table, /data-catalog-column="change7d-low" data-catalog-sort="change7d-high"/);
  assert.match(renderMarketCatalog(changing, state, 'lamp', 'grid', 'ko', false), /가격 변동 7일: 하락 12\.5%/);
});
test('change sorting ranks gainers and losers and always keeps markets without sales last', () => {
  const order = (sort: CatalogSort) => filterMarketCatalog(changing, state, 'en', 'all', '', sort, false).map(ticker => ticker.asset);
  assert.deepEqual(order('change24h-high'), ['lamp', 'torch', 'wood']);
  assert.deepEqual(order('change24h-low'), ['torch', 'lamp', 'wood']);
  assert.deepEqual(order('change7d-high'), ['torch', 'lamp', 'wood']);
  assert.deepEqual(order('change7d-low'), ['lamp', 'torch', 'wood']);
});
const report: MarketAnalysis = { generatedAt: state.serverTime, expiresAt: state.serverTime + marketAnalysisDuration, fee: 100,
  items: [{ item: 'lamp', craftingFee: 1, ingredients: [], cost: 80, revenue: 90, profit: 10 },
    { item: 'torch', craftingFee: 1, ingredients: [], cost: 5, revenue: 3, profit: -2 }] };
test('paid profit and full-cost sorts use report values, keep unavailable items last and never expose expired analysis', () => {
  const order = (sort: CatalogSort) => filterMarketCatalog(tickers, state, 'en', 'all', '', sort, false, report).map(ticker => ticker.asset);
  assert.deepEqual(order('profit-high'), ['lamp', 'torch', 'collection-wood-1']);
  assert.deepEqual(order('profit-low'), ['torch', 'lamp', 'collection-wood-1']);
  assert.deepEqual(order('craft-cost-low'), ['torch', 'lamp', 'collection-wood-1']);
  assert.deepEqual(order('craft-cost-high'), ['lamp', 'torch', 'collection-wood-1']);
  for (const view of ['grid', 'table'] as const) {
    const paid = renderMarketCatalog(tickers, state, 'lamp', view, 'en', false, 'profit-high', report);
    assert.match(paid, /Total craft cost/); assert.match(paid, /data-profit="positive"/); assert.match(paid, /data-profit="negative"/);
    const expired = renderMarketCatalog(tickers, state, 'lamp', view, 'en', false, 'name', report, report.expiresAt);
    assert.doesNotMatch(expired, /catalog-analysis|Estimated profit|Total craft cost/);
    assert.doesNotMatch(renderMarketCatalog(tickers, state, 'lamp', view, 'en', false), /catalog-analysis/);
  }
  assert.equal(activeMarketAnalysis(report, report.generatedAt - 1), null);
  assert.ok(activeMarketAnalysis(report, report.expiresAt - 1));
  assert.equal(activeMarketAnalysis(report, report.expiresAt), null);
});
test('dynamic rarity uses exact quantity boundaries, labels zero unavailable and sorts scarcity with unknowns last', () => {
  for (const [quantity, rarity] of [[0, 'unavailable'], [1, 'legendary'], [9, 'legendary'], [10, 'epic'], [49, 'epic'],
    [50, 'rare'], [199, 'rare'], [200, 'uncommon'], [999, 'uncommon'], [1000, 'common']] as const)
    assert.equal(marketRarity(quantity), rarity);
  for (const quantity of [undefined, -1, 0.1, NaN, Infinity]) assert.equal(marketRarity(quantity), 'unknown');
  const quantities = tickers.map((ticker, i) => ({ ...ticker, availableQuantity: [1000, 9, 50][i] }));
  assert.deepEqual(filterMarketCatalog(quantities, state, 'en', 'all', '', 'rarity-high', false).map(row => row.asset), ['torch', 'collection-wood-1', 'lamp']);
  assert.deepEqual(filterMarketCatalog(quantities, state, 'en', 'all', '', 'quantity-high', false).map(row => row.asset), ['lamp', 'collection-wood-1', 'torch']);
  const unavailable = quantities.map(ticker => ticker.asset === 'torch' ? { ...ticker, availableQuantity: 0 } : ticker);
  assert.deepEqual(filterMarketCatalog(unavailable, state, 'en', 'all', '', 'rarity-high', false).map(row => row.asset), ['collection-wood-1', 'lamp', 'torch']);
  for (const view of ['grid', 'table'] as const) {
    const html = renderMarketCatalog(quantities, state, 'lamp', view, 'en', false);
    assert.match(html, /data-rarity="legendary"/); assert.match(html, /Legendary · Available 9/);
    assert.match(renderMarketCatalog(quantities, state, 'lamp', view, 'ko', false), /전설/);
  }
});
