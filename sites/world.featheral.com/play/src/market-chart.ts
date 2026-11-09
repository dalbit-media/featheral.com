import type { MarketFill } from './market.ts';
import { escapeAtlas } from './atlas.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount, formatResourcePrice, tradingUnit } from './resource-units.ts';

export const chartIntervals = ['auto', '1h', '4h', '1d'] as const;
export type ChartInterval = typeof chartIntervals[number];
export type ChartStyle = 'candles' | 'line';
export interface MarketCandle { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export function marketCandles(history: readonly MarketFill[], interval: ChartInterval): { candles: MarketCandle[]; duration: number } {
  const sorted = [...history].sort((a, b) => a.time - b.time || a.id - b.id);
  const span = sorted.length ? sorted.at(-1)!.time - sorted[0].time : 0;
  const duration = interval === '1h' ? 3600000 : interval === '4h' ? 14400000 : interval === '1d' ? 86400000
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
export function priceHistoryChart(history: MarketFill[], language: Language, interval: ChartInterval = 'auto', style: ChartStyle = 'candles'): string {
  const t = (text: string) => escapeAtlas(translate(text, language));
  if (!history.length) return `<div class="market-chart-empty">${t('No sales yet. Prices will appear here after someone buys or sells.')}</div>`;
  const { candles, duration } = marketCandles(history, interval);
  const asset = history[0].asset;
  const price = (value: number) => formatResourcePrice(asset, value, locale(language));
  const date = (time: number) => new Date(time).toLocaleString(locale(language), { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const low = Math.min(...candles.map(candle => candle.low)), high = Math.max(...candles.map(candle => candle.high));
  const padding = (high - low || high * .02 || .0001) * .12;
  const minimum = Math.max(0, low - padding), maximum = high + padding;
  const y = (value: number) => 220 - (value - minimum) / (maximum - minimum) * 192;
  const first = candles[0].time, last = candles.at(-1)!;
  const timeSpan = last.time - first;
  const x = (candle: MarketCandle) => timeSpan ? 40 + (candle.time - first) / timeSpan * 630 : 355;
  const width = Math.max(2, Math.min(16, timeSpan ? 630 * duration / timeSpan * .65 : 16));
  const volumeMax = Math.max(...candles.map(candle => candle.volume));
  const candleTitle = (candle: MarketCandle) => escapeAtlas(`${date(candle.time)} UTC · ${translate('Opening price', language)} ${price(candle.open)} · ${translate('Highest price', language)} ${price(candle.high)} · ${translate('Lowest price', language)} ${price(candle.low)} · ${translate('Closing price', language)} ${price(candle.close)} · ${translate('Volume', language)} ${formatResourceAmount(asset, candle.volume, locale(language))}`);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = minimum + (maximum - minimum) * index / 4;
    return `<path d="M24 ${y(value)}H700" class="chart-grid"/><text x="710" y="${y(value) + 4}">${price(value)}</text>`;
  }).join('');
  const shapes = candles.map(candle => `<g class="chart-candle ${candle.close >= candle.open ? 'up' : 'down'}" tabindex="0" data-chart-candle="${candle.time}" aria-label="${candleTitle(candle)}"><title>${candleTitle(candle)}</title><rect class="chart-hit" x="${x(candle) - Math.max(width, 10) / 2}" y="24" width="${Math.max(width, 10)}" height="258"/>
    ${style === 'candles' ? `<path class="chart-wick" d="M${x(candle)} ${y(candle.high)}V${y(candle.low)}"/><rect class="chart-body" x="${x(candle) - width / 2}" y="${Math.min(y(candle.open), y(candle.close))}" width="${width}" height="${Math.max(2, Math.abs(y(candle.open) - y(candle.close)))}"/>` : ''}
    <rect class="chart-volume" x="${x(candle) - width / 2}" y="${282 - candle.volume / volumeMax * 42}" width="${width}" height="${candle.volume / volumeMax * 42}"/></g>`).join('');
  return `<div class="chart-summary"><span>${t('Opening price')} <strong>${price(candles[0].open)}</strong></span><span>${t('Highest price')} <strong>${price(high)}</strong></span><span>${t('Lowest price')} <strong>${price(low)}</strong></span><span>${t('Closing price')} <strong>${price(last.close)}</strong></span><span>${t('Volume')} <strong>${formatResourceAmount(asset, candles.reduce((sum, candle) => sum + candle.volume, 0), locale(language))}</strong></span></div>
    <svg class="market-chart trading-chart" viewBox="0 0 800 320" role="img" aria-label="${t(style === 'candles' ? 'Candlestick price chart' : 'Closing price chart')}"><title>${t('Price history')}</title>${grid}
    <path d="M24 ${y(last.close)}H700" class="chart-current"/><text x="710" y="${y(last.close) - 7}" class="chart-current-label">${price(last.close)}</text>${shapes}
    ${style === 'line' ? `<polyline class="chart-line" points="${candles.map(candle => `${x(candle)},${y(candle.close)}`).join(' ')}"/><circle class="chart-last" cx="${x(last)}" cy="${y(last.close)}" r="3"/>` : ''}
    <text x="24" y="306">${date(first)}</text><text x="690" y="306" text-anchor="end">${date(last.time)}</text></svg>
    <p class="chart-inspection" data-chart-inspection role="status">${t('Hover or focus a candle for OHLC and volume.')}</p>
    <p class="chart-disclosure">${t('Latest 120 executed trades only. Empty intervals are gaps, not estimated prices. Times use the game clock in UTC.')} ${t('Candle interval')}: ${duration / 60000} ${t('minutes')} · FTH$/${tradingUnit(asset, locale(language))}</p>
    <details class="market-chart-data"><summary>${t('See past sales')}</summary><div class="market-table-scroll"><table><thead><tr><th>${t('Server time')}</th><th>${t('Price each')}</th><th>${t('Amount')}</th></tr></thead><tbody>${[...history].sort((a, b) => b.time - a.time || b.id - a.id).map(fill => `<tr><td>${date(fill.time)}</td><td>${price(fill.price)}</td><td>${formatResourceAmount(asset, fill.quantity, locale(language))}</td></tr>`).join('')}</tbody></table></div></details>`;
}
