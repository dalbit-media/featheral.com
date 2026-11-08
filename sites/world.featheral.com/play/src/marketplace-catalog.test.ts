import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { filterMarketCatalog, renderMarketCatalog } from './marketplace-catalog.ts';
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
