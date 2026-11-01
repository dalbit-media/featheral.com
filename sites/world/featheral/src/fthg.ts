import { monetaryPolicy } from './monetary-policy.ts';
export const fthgScale = monetaryPolicy.scale;

export function fthgUnits(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Invalid FTHG amount.');
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
  if (!match) throw new RangeError('FTHG amounts allow up to four decimal places.');
  const units = BigInt(match[1]) * BigInt(fthgScale) + BigInt((match[2] ?? '').padEnd(4, '0'));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('FTHG amount exceeds the safe limit.');
  return Number(units);
}
export function formatFthg(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 4 });
}
export function fthgSlippage(value: number, side: 'buy' | 'sell'): number {
  const numerator = BigInt(fthgUnits(value)) * BigInt(100 + (side === 'buy' ? monetaryPolicy.slippagePercent : -monetaryPolicy.slippagePercent));
  return Number(side === 'buy' ? numerator / 100n : (numerator + 99n) / 100n) / fthgScale;
}
