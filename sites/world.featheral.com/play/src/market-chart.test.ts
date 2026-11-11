import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { candleAverage, chartBounds, constrainChartWindow, marketCandles, priceHistoryChart, zoomChartWindow } from './market-chart.ts';
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
test('fine intervals and moving averages use only recorded candles with a complete period', () => {
  const candles = marketCandles([fill(1, 0, 1), fill(2, 300000, 3), fill(3, 900000, 5)], '5m').candles;
  assert.equal(marketCandles([], '15m').duration, 900000);
  assert.deepEqual(candles.map(candle => candle.time), [0, 300000, 900000]);
  assert.deepEqual(candleAverage(candles, 2), [null, 2, 4]);
  assert.deepEqual(candleAverage(candles, 5), [null, null, null]);
});
test('zoom respects its pointer anchor and pan is bounded without collapsing sparse or single-candle windows', () => {
  const bounds = { start: 0, end: 100 };
  assert.deepEqual(zoomChartWindow(bounds, bounds, .5, .25, 5), { start: 12.5, end: 62.5 });
  assert.deepEqual(zoomChartWindow(bounds, bounds, .0001, 1, 5), { start: 95, end: 100 });
  assert.deepEqual(zoomChartWindow(bounds, bounds, 1000, 0, 5), bounds);
  assert.deepEqual(constrainChartWindow({ start: -10, end: 10 }, bounds, 5), { start: 0, end: 20 });
  assert.deepEqual(constrainChartWindow({ start: 90, end: 110 }, bounds, 5), { start: 80, end: 100 });
  const one = marketCandles([fill(1, 0, 1)], '1h');
  const window = chartBounds(one.candles, one.duration);
  assert.ok(window.end - window.start >= one.duration * 6);
});
test('responsive chart geometry keeps pixel-sized axes, visible OHLC, volume toggles and honest gap data', () => {
  const history = Array.from({ length: 30 }, (_, index) => fill(index, index * 3600000, index + 1));
  for (const width of [244, 360, 1400]) {
    const markup = priceHistoryChart(history, 'en', '1h', 'candles', { width, height: 460, averages: true });
    assert.match(markup, new RegExp(`viewBox="0 0 ${width} 460"`));
    assert.match(markup, /chart-crosshair/);
    assert.match(markup, /average-0/);
    assert.match(markup, /data-chart-x=/);
    assert.doesNotMatch(markup, /NaN|Infinity/);
  }
  const options = { window: { start: 25 * 3600000, end: 30 * 3600000 }, volume: false, averages: true };
  const markup = priceHistoryChart(history, 'en', '1h', 'candles', options);
  assert.equal((markup.match(/data-chart-candle=/g) ?? []).length, 5);
  assert.doesNotMatch(markup, /class="chart-volume"/);
  assert.match(markup, /Lowest price <strong>2,600<\/strong>/);
  const gap = priceHistoryChart([fill(1, 0, 1), fill(2, 20 * 3600000, 2)], 'en', '1h', 'candles', { window: { start: 5 * 3600000, end: 10 * 3600000 } });
  assert.doesNotMatch(gap, /data-chart-candle=/);
  assert.match(gap, /Opening price <strong>—<\/strong>/);
  assert.match(gap, /No trades in this range/);
});
test('chart styles override narrow grid placement and remove the late 140px layout cap', () => {
  const shell = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./market-chart.css', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../../../../shared/trading-chart.css', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /#app \.market-chart\{[^}]*max-height:140px/);
  assert.match(css, /#app \.exchange-layout \.exchange-chart-card\{grid-column:1\/-1\}/);
  assert.match(shared, /\.chart-canvas\{height:clamp\(280px,42vh,480px\)/);
  assert.match(css, /#app \.exchange-layout \.exchange-order-entry\{grid-row:1\/3;position:static\}/);
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
test('shared line engine renders separate area segments across gaps and a point for isolated trades', () => {
  const history = [fill(1, 0, 2), fill(2, 3600000, 3), fill(3, 10 * 3600000, 1)];
  const markup = priceHistoryChart(history, 'en', '1h', 'line');
  assert.equal((markup.match(/class="chart-area"/g) ?? []).length, 2);
  assert.equal((markup.match(/class="chart-line"/g) ?? []).length, 2);
  assert.match(markup, /data-chart-direction="down"/);
  assert.match(markup, /class="chart-sample"[^>]+r="3"/);
  assert.match(markup, /clip-path="url\(#world-market-clip\)"/);
  assert.match(markup, /chart-price-tag/);
  assert.match(markup, /tabindex="-1" data-chart-candle/);
  assert.match(markup, /role="group" tabindex="0"/);
  assert.doesNotMatch(markup, /NaN|Infinity/);
});
test('shared chart validates data, escapes labels and uses unique gradient ids', () => {
  const engine = FeatheralTradingChart;
  const candle = { time: 0, open: 1, high: 2, low: 1, close: 2, volume: 5, trades: 1 };
  const options = { duration: 3600000, formatPrice: String, formatVolume: String, formatTime: String, unit: '<img onerror="bad">' };
  const first = engine.render([candle], options), second = engine.render([candle], options);
  assert.match(first, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.notEqual(first.match(/id="([^"]+)-area"/)?.[1], second.match(/id="([^"]+)-area"/)?.[1]);
  assert.throws(() => engine.render([{ ...candle, close: Infinity }], options), /invalid/);
  assert.throws(() => engine.render([{ ...candle, volume: -1 }], options), /invalid/);
  assert.throws(() => engine.render([candle, candle], options), /unordered/);
  assert.throws(() => engine.render([candle], { ...options, duration: 0 }), /positive/);
  assert.match(engine.render([{ ...candle, open: 1e-12, high: 1e-12, low: 1e-12, close: 1e-12 }], options), /chart-endpoint/);
  assert.doesNotMatch(engine.render([{ ...candle, open: 0, high: 0, low: 0, close: 0 }], options), /NaN|Infinity/);
});
test('both trading surfaces load the same renderer and reduced-motion visual system', () => {
  const game = readFileSync(new URL('./market-chart-view.ts', import.meta.url), 'utf8');
  const exchange = readFileSync(new URL('../../../ex.featheral.com/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../../../shared/trading-chart.css', import.meta.url), 'utf8');
  assert.match(game, /style: ChartStyle = 'line'/);
  assert.match(game, /shared\/trading-chart.css/);
  assert.match(exchange, /shared\/trading-chart.js/);
  assert.match(exchange, /shared\/trading-chart.css/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});
