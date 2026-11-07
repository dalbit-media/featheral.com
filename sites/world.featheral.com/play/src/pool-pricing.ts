import { monetaryPolicy } from './monetary-policy.ts';

interface PricingPool { units: number; dollars: number; depthUnits?: bigint; depthDollars?: bigint }
export function poolPaymentUnits(pool: PricingPool, side: 'buy' | 'sell', quantity: number): bigint {
  if (![pool.units, pool.dollars, quantity].every(Number.isSafeInteger)
    || pool.units < 0 || pool.dollars < 0 || quantity < 1) throw new RangeError('Invalid pool values.');
  const units = BigInt(pool.units) + (pool.depthUnits ?? 0n) + (side === 'buy' ? -BigInt(quantity) : BigInt(quantity));
  if (units <= 0n) throw new RangeError('Insufficient pool inventory.');
  const spread = BigInt(100 + (side === 'buy' ? monetaryPolicy.poolSpreadPercent : -monetaryPolicy.poolSpreadPercent));
  const numerator = (BigInt(pool.dollars) + (pool.depthDollars ?? 0n)) * BigInt(quantity) * spread;
  const denominator = units * 100n;
  return side === 'buy' ? (numerator + denominator - 1n) / denominator : numerator / denominator;
}
export function poolPayment(pool: PricingPool, side: 'buy' | 'sell', quantity: number): number {
  const value = poolPaymentUnits(pool, side, quantity);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Pool payment exceeds the safe limit.');
  return Number(value);
}
