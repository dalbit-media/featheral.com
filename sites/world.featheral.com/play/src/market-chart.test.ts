import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { marketCandles, priceHistoryChart } from './market-chart.ts';
import type { MarketFill } from './market.ts';

const fill = (id: number, time: number, price: number, quantity = 1): MarketFill =>
  ({ id, time, price, quantity, asset: 'metal', dollars: quantity * price, venue: 'players' });
test('OHLC uses chronological fills, sums volume, orders timestamp ties and preserves gaps without mutating history', () => {
  const history = [fill(3, 3000, 12, 3), fill(1, 1000, 10, 2), fill(2, 1000, 15, 1), fill(4, 10800000, 9)];
  const before = structuredClone(history);
  assert.deepEqual(marketCandles(history, '1h').candles, [
    { time: 0, open: 10, high: 15, low: 10, close: 12, volume: 6, trades: 3 },
    { time: 10800000, open: 9, high: 9, low: 9, close: 9, volume: 1, trades: 1 },
  ]);
  assert.deepEqual(history, before);
});
test('auto intervals bound density, fixed intervals use game clock and empty or flat prices render honestly', () => {
  assert.equal(marketCandles([], 'auto').candles.length, 0);
  assert.equal(marketCandles([fill(1, 0, 1)], '4h').duration, 14400000);
  assert.equal(marketCandles([fill(1, 0, 1)], '1d').duration, 86400000);
  const history = Array.from({ length: 120 }, (_, i) => fill(i, i * 86400000, 2));
  assert.ok(marketCandles(history, 'auto').candles.length <= 42);
  const html = priceHistoryChart([fill(1, 0, 2)], 'en');
  assert.match(html, /Candlestick price chart/);
  assert.match(html, /chart-body/);
  assert.match(html, /Latest 120 executed trades only/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(priceHistoryChart(history, 'en', '1d', 'line'), /class="chart-body"/);
  assert.match(priceHistoryChart([], 'en'), /No sales yet/);
  assert.match(priceHistoryChart(history, 'ko'), /시가/);
  assert.match(priceHistoryChart(history, 'ko'), /종가/);
  assert.match(priceHistoryChart(history, 'ko'), /거래량/);
});
