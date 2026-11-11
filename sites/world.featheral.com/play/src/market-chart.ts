import '../../../../shared/trading-chart.js';
import type { MarketFill } from './market.ts';
import { escapeAtlas } from './atlas.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount, formatResourcePrice, tradingUnit } from './resource-units.ts';
import type { TradingCandle, TradingWindow } from '../../../../shared/trading-chart.js';

export const chartIntervals = ['auto', '5m', '15m', '1h', '4h', '1d'] as const;
export type ChartInterval = typeof chartIntervals[number];
export type ChartStyle = 'candles' | 'line';
export type MarketCandle = TradingCandle;
export type ChartWindow = TradingWindow;
export interface ChartOptions { width?: number; height?: number; window?: ChartWindow; averages?: boolean; volume?: boolean }

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
export const chartBounds = FeatheralTradingChart.bounds;
export const constrainChartWindow = FeatheralTradingChart.constrain;
export const zoomChartWindow = FeatheralTradingChart.zoom;
export const candleAverage = FeatheralTradingChart.average;

export function priceHistoryChart(history: MarketFill[], language: Language, interval: ChartInterval = 'auto', style: ChartStyle = 'candles', options: ChartOptions = {}): string {
  const t = (text: string) => escapeAtlas(translate(text, language));
  const { candles, duration } = marketCandles(history, interval);
  const asset = history[0]?.asset ?? 'metal';
  const price = (value: number) => formatResourcePrice(asset, value, locale(language));
  const date = (time: number, short = false) => new Date(time).toLocaleString(locale(language), {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(!short || duration < 86400000 ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  });
  const chart = FeatheralTradingChart.render(candles, {
    ...options, id: 'world-market', duration, style, locale: locale(language),
    unit: `FTH$/${tradingUnit(asset, locale(language))}`, volumeUnit: tradingUnit(asset, locale(language)),
    translate: text => translate(text, language), formatPrice: price, formatTime: date,
    formatVolume: value => formatResourceAmount(asset, value, locale(language)),
    emptyTitle: 'No sales yet. Prices will appear here after someone buys or sells.',
    emptyMessage: 'Latest 120 executed trades only. Empty intervals are gaps, not estimated prices. Times use the game clock in UTC.',
    candleLabel: candle => `${date(candle.time)} UTC · ${translate('Opening price', language)} ${price(candle.open)} · ${translate('Highest price', language)} ${price(candle.high)} · ${translate('Lowest price', language)} ${price(candle.low)} · ${translate('Closing price', language)} ${price(candle.close)} · ${translate('Volume', language)} ${formatResourceAmount(asset, candle.volume, locale(language))} · ${candle.trades}`,
  });
  if (!history.length) return chart;
  return `${chart}<div class="chart-footnote"><p class="chart-disclosure">${t('Latest 120 executed trades only. Empty intervals are gaps, not estimated prices. Times use the game clock in UTC.')} ${t('Candle interval')}: ${duration / 60000} ${t('minutes')} · ${t('Ranges end at the latest recorded trade.')}</p>
    <details class="market-chart-data"><summary>${t('See past sales')}</summary><div class="market-table-scroll"><table><thead><tr><th>${t('Server time')}</th><th>${t('Price each')}</th><th>${t('Amount')}</th></tr></thead><tbody>${[...history].sort((a, b) => b.time - a.time || b.id - a.id).map(fill => `<tr><td>${date(fill.time)}</td><td>${price(fill.price)}</td><td>${formatResourceAmount(asset, fill.quantity, locale(language))}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}
