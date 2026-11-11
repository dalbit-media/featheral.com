export interface TradingCandle { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export interface TradingWindow { start: number; end: number }
export interface TradingChartOptions {
  duration: number;
  width?: number;
  height?: number;
  window?: TradingWindow;
  averages?: boolean;
  volume?: boolean;
  style?: 'line' | 'candles';
  locale?: string;
  id?: string;
  unit?: string;
  volumeUnit?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  translate?: (text: string) => string;
  formatPrice: (value: number) => string;
  formatVolume: (value: number) => string;
  formatTime: (time: number, short?: boolean) => string;
  candleLabel?: (candle: TradingCandle) => string;
}
declare global {
  var FeatheralTradingChart: {
    render(candles: readonly TradingCandle[], options: TradingChartOptions): string;
    validate(candles: readonly TradingCandle[], duration: number): void;
    inspect(root: HTMLElement, candle: SVGElement): void;
    clearInspection(root: HTMLElement): void;
    average(candles: readonly TradingCandle[], period: number): (number | null)[];
    bounds(candles: readonly TradingCandle[], duration: number): TradingWindow;
    constrain(window: TradingWindow, bounds: TradingWindow, minimumSpan: number): TradingWindow;
    zoom(window: TradingWindow, bounds: TradingWindow, factor: number, anchor: number, minimumSpan: number): TradingWindow;
  };
}
