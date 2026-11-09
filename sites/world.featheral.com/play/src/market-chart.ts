import type { MarketFill } from './market.ts';
import { escapeAtlas } from './atlas.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount, formatResourcePrice, tradingUnit } from './resource-units.ts';

export const chartIntervals = ['auto', '5m', '15m', '1h', '4h', '1d'] as const;
export type ChartInterval = typeof chartIntervals[number];
export type ChartStyle = 'candles' | 'line';
export interface MarketCandle { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export function marketCandles(history: readonly MarketFill[], interval: ChartInterval): { candles: MarketCandle[]; duration: number } {
  const sorted = [...history].sort((a, b) => a.time - b.time || a.id - b.id);
  const span = sorted.length ? sorted.at(-1)!.time - sorted[0].time : 0;
  const duration = interval === '5m' ? 300000 : interval === '15m' ? 900000 : interval === '1h' ? 3600000 : interval === '4h' ? 14400000 : interval === '1d' ? 86400000
    : Math.max(60000, Math.ceil(span / 40 / 60000) * 60000);
  const candles: MarketCandle[] = [];
  for (const fill of sorted) {
    const time = Math.floor(fill.time / duration) * duration;
    const last = candles.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, fill.price); last.low = Math.min(last.low, fill.price);
      last.close = fill.price; last.volume += fill.quantity; last.trades++;
    } else candles.push({ time, open: fill.price, high: fill.price, low: fill.price, close: fill.price, volume: fill.quantity, trades: 1 });
  }
  return { candles, duration };
}
export interface ChartWindow { start: number; end: number }
export interface ChartOptions { width?: number; height?: number; window?: ChartWindow; averages?: boolean; volume?: boolean }
export function chartBounds(candles: readonly MarketCandle[], duration: number): ChartWindow {
  return { start: candles[0].time - duration / 2, end: Math.max(candles.at(-1)!.time + duration / 2, candles[0].time + duration * 6) };
}
export function constrainChartWindow(window: ChartWindow, bounds: ChartWindow, minimumSpan: number): ChartWindow {
  const span = Math.min(bounds.end - bounds.start, Math.max(minimumSpan, window.end - window.start));
  const start = Math.max(bounds.start, Math.min(bounds.end - span, window.start));
  return { start, end: start + span };
}
export function zoomChartWindow(window: ChartWindow, bounds: ChartWindow, factor: number, anchor: number, minimumSpan: number): ChartWindow {
  const ratio = Math.max(0, Math.min(1, anchor));
  const time = window.start + (window.end - window.start) * ratio;
  const span = Math.max(minimumSpan, Math.min(bounds.end - bounds.start, (window.end - window.start) * factor));
  return constrainChartWindow({ start: time - span * ratio, end: time + span * (1 - ratio) }, bounds, minimumSpan);
}
export function candleAverage(candles: readonly MarketCandle[], period: number): (number | null)[] {
  let sum = 0;
  return candles.map((candle, index) => {
    sum += candle.close;
    if (index >= period) sum -= candles[index - period].close;
    return index + 1 >= period ? sum / period : null;
  });
}
export function priceHistoryChart(history: MarketFill[], language: Language, interval: ChartInterval = 'auto', style: ChartStyle = 'candles', options: ChartOptions = {}): string {
  const t = (text: string) => escapeAtlas(translate(text, language));
  if (!history.length) return `<div class="market-chart-empty">${t('No sales yet. Prices will appear here after someone buys or sells.')}</div>`;
  const { candles, duration } = marketCandles(history, interval);
  const asset = history[0].asset;
  const price = (value: number) => formatResourcePrice(asset, value, locale(language));
  const date = (time: number) => new Date(time).toLocaleString(locale(language), { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const bounds = chartBounds(candles, duration), window = options.window ?? bounds;
  const visible = candles.filter(candle => candle.time >= window.start && candle.time <= window.end);
  const width = Math.max(240, options.width ?? 800), height = Math.max(180, options.height ?? 400);
  const left = 12, right = width - Math.min(108, Math.max(76, width * .14)), top = 24;
  const bottom = height - (options.volume === false ? 36 : 104), volumeBottom = height - 34;
  const averages = options.averages ? [candleAverage(candles, 5), candleAverage(candles, 20)] : [];
  const averagePrices = averages.flatMap(values => values.filter((value, index): value is number => value !== null && candles[index].time >= window.start && candles[index].time <= window.end));
  const recordedLow = visible.length ? Math.min(...visible.map(candle => candle.low)) : candles.at(-1)!.close;
  const recordedHigh = visible.length ? Math.max(...visible.map(candle => candle.high)) : candles.at(-1)!.close;
  const low = Math.min(recordedLow, ...averagePrices), high = Math.max(recordedHigh, ...averagePrices);
  const padding = (high - low || high * .02 || .0001) * .12;
  const minimum = Math.max(0, low - padding), maximum = high + padding;
  const y = (value: number) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
  const last = candles.at(-1)!;
  const timeSpan = window.end - window.start;
  const x = (candle: MarketCandle) => left + (candle.time - window.start) / timeSpan * (right - left);
  const candleWidth = Math.max(1, Math.min(28, (right - left) * duration / timeSpan * .65));
  const volumeMax = Math.max(...visible.map(candle => candle.volume), 0) || 1;
  const candleTitle = (candle: MarketCandle) => escapeAtlas(`${date(candle.time)} UTC · ${translate('Opening price', language)} ${price(candle.open)} · ${translate('Highest price', language)} ${price(candle.high)} · ${translate('Lowest price', language)} ${price(candle.low)} · ${translate('Closing price', language)} ${price(candle.close)} · ${translate('Volume', language)} ${formatResourceAmount(asset, candle.volume, locale(language))}`);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = minimum + (maximum - minimum) * index / 4;
    return `<path d="M${left} ${y(value)}H${right}" class="chart-grid"/><text x="${right + 8}" y="${y(value) + 4}">${price(value)}</text>`;
  }).join('');
  const shapes = visible.map(candle => `<g class="chart-candle ${candle.close >= candle.open ? 'up' : 'down'}" tabindex="0" data-chart-candle="${candle.time}" data-chart-x="${x(candle)}" data-chart-y="${y(candle.close)}" aria-label="${candleTitle(candle)}"><title>${candleTitle(candle)}</title><rect class="chart-hit" x="${Math.max(left, x(candle) - Math.max(candleWidth, 10) / 2)}" y="${top}" width="${Math.max(candleWidth, 10)}" height="${volumeBottom - top}"/>
    ${style === 'candles' ? `<path class="chart-wick" d="M${x(candle)} ${y(candle.high)}V${y(candle.low)}"/><rect class="chart-body" x="${x(candle) - candleWidth / 2}" y="${Math.min(y(candle.open), y(candle.close))}" width="${candleWidth}" height="${Math.max(2, Math.abs(y(candle.open) - y(candle.close)))}"/>` : ''}
    ${options.volume === false ? '' : `<rect class="chart-volume" x="${x(candle) - candleWidth / 2}" y="${volumeBottom - candle.volume / volumeMax * 52}" width="${candleWidth}" height="${candle.volume / volumeMax * 52}"/>`}</g>`).join('');
  const movingAverages = averages.map((values, series) => `<polyline class="chart-average average-${series}" points="${candles.flatMap((candle, index) => values[index] !== null && candle.time >= window.start && candle.time <= window.end ? [`${x(candle)},${y(values[index]!)}`] : []).join(' ')}"/>`).join('');
  const timeLabels = Array.from({ length: width < 500 ? 2 : 4 }, (_, index) => index);
  const labels = timeLabels.map((_, index) => {
    const ratio = index / (timeLabels.length - 1);
    const time = window.start + ratio * timeSpan;
    const label = width < 500 ? new Date(time).toLocaleString(locale(language), { timeZone: 'UTC',
      ...(timeSpan < 86400000 ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }) }) : date(time);
    return `<text x="${left + ratio * (right - left)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === timeLabels.length - 1 ? 'end' : 'middle'}">${label}</text>`;
  }).join('');
  const closing = visible.at(-1) ?? last, opening = visible[0] ?? last;
  const change = opening.open ? (closing.close - opening.open) / opening.open * 100 : 0;
  return `<div class="chart-headline"><strong aria-label="${t('Latest recorded close')}">${price(last.close)} <small>FTH$/${tradingUnit(asset, locale(language))}</small></strong><span class="${change >= 0 ? 'up' : 'down'}">${visible.length ? `${change >= 0 ? '+' : ''}${change.toLocaleString(locale(language), { maximumFractionDigits: 2 })}%` : '—'} ${t('Visible range')}</span>${options.averages ? `<span class="chart-average-key">MA 5 / MA 20 · ${t('Recorded candles')}</span>` : ''}</div>
    <div class="chart-summary"><span>${t('Opening price')} <strong>${visible.length ? price(opening.open) : '—'}</strong></span><span>${t('Highest price')} <strong>${visible.length ? price(recordedHigh) : '—'}</strong></span><span>${t('Lowest price')} <strong>${visible.length ? price(recordedLow) : '—'}</strong></span><span>${t('Closing price')} <strong>${visible.length ? price(closing.close) : '—'}</strong></span><span>${t('Volume')} <strong>${formatResourceAmount(asset, visible.reduce((sum, candle) => sum + candle.volume, 0), locale(language))}</strong></span></div>
    <div class="chart-canvas"><svg class="market-chart trading-chart" viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-label="${t(style === 'candles' ? 'Candlestick price chart' : 'Closing price chart')}" data-chart-left="${left}" data-chart-right="${right}" data-chart-top="${top}" data-chart-bottom="${bottom}" data-chart-min="${minimum}" data-chart-max="${maximum}"><title>${t('Price history')}</title>${grid}
    ${y(last.close) >= top && y(last.close) <= bottom ? `<path d="M${left} ${y(last.close)}H${right}" class="chart-current"/><text x="${right + 8}" y="${y(last.close) - 7}" class="chart-current-label">${price(last.close)}</text>` : ''}${shapes}${movingAverages}
    ${style === 'line' ? `<polyline class="chart-line" points="${visible.map(candle => `${x(candle)},${y(candle.close)}`).join(' ')}"/>` : ''}
    ${visible.length ? '' : `<text x="${(left + right) / 2}" y="${(top + bottom) / 2}" text-anchor="middle">${t('No trades in this range')}</text>`}
    ${options.volume === false ? '' : `<text x="${left}" y="${bottom + 20}">${t('Volume')}</text>`}${labels}
    <g class="chart-crosshair" visibility="hidden" pointer-events="none"><path data-crosshair-x class="chart-crosshair-line"/><path data-crosshair-y class="chart-crosshair-line"/><circle data-crosshair-dot r="4"/><text data-crosshair-price x="${right + 8}"/></g></svg></div>
    <p class="chart-inspection" data-chart-inspection role="status">${t('Hover or focus a candle for OHLC and volume.')}</p>
    <div class="chart-footnote"><p class="chart-disclosure">${t('Latest 120 executed trades only. Empty intervals are gaps, not estimated prices. Times use the game clock in UTC.')} ${t('Candle interval')}: ${duration / 60000} ${t('minutes')} · ${t('Ranges end at the latest recorded trade.')}</p>
    <details class="market-chart-data"><summary>${t('See past sales')}</summary><div class="market-table-scroll"><table><thead><tr><th>${t('Server time')}</th><th>${t('Price each')}</th><th>${t('Amount')}</th></tr></thead><tbody>${[...history].sort((a, b) => b.time - a.time || b.id - a.id).map(fill => `<tr><td>${date(fill.time)}</td><td>${price(fill.price)}</td><td>${formatResourceAmount(asset, fill.quantity, locale(language))}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}
