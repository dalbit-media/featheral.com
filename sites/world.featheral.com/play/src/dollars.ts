export { fthgScale as dollarsScale, fthgUnits as dollarsUnits, fthgSlippage as dollarsSlippage } from './fthg.ts';

export function formatDollars(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}
