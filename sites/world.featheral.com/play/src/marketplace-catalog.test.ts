import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { filterMarketCatalog, formatPriceChange, renderMarketCatalog } from './marketplace-catalog.ts';
import type { CatalogSort } from './marketplace-catalog.ts';
import { marketAssets } from './market.ts';

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
test('all-item browsing retains all 81 markets and item category never hides resources from the all filter', () => {
  const all = marketAssets.map(asset => ({ asset, bid: 1, ask: 2, last: null }));
  assert.equal(filterMarketCatalog(all, state, 'en', 'all', '', 'name', false).length, 81);
  assert.equal(filterMarketCatalog(all, state, 'en', 'resources', '', 'name', false).length, 4);
  assert.equal(filterMarketCatalog(all, state, 'en', 'items', '', 'name', false).length, 77);
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
