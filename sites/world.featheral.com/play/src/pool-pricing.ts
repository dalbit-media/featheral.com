import { monetaryPolicy } from './monetary-policy.ts';

export function poolPayment(pool: { units: number; dollars: number }, side: 'buy' | 'sell', quantity: number): number {
  if (![pool.units, pool.dollars, quantity].every(Number.isSafeInteger)
    || pool.units < 0 || pool.dollars < 0 || quantity < 1) throw new RangeError('Invalid pool values.');
  const units = BigInt(pool.units) + (side === 'buy' ? -BigInt(quantity) : BigInt(quantity));
  if (units <= 0n) throw new RangeError('Insufficient pool inventory.');
  const spread = BigInt(100 + (side === 'buy' ? monetaryPolicy.poolSpreadPercent : -monetaryPolicy.poolSpreadPercent));
  const numerator = BigInt(pool.dollars) * BigInt(quantity) * spread;
  const denominator = units * 100n;
  const value = side === 'buy' ? (numerator + denominator - 1n) / denominator : numerator / denominator;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Pool payment exceeds the safe limit.');
  return Number(value);
}
