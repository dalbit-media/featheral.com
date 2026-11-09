import { salePercentages } from './resource-sale-quantity.ts';

export type MarketPercentage = typeof salePercentages[number];
export interface BuyQuantityRequest { percent: MarketPercentage; price?: number }
export interface BuyQuantityBudget extends BuyQuantityRequest { dollars: number; quantity: number }
export function isMarketPercentage(value: number): value is MarketPercentage {
  return salePercentages.some(percent => percent === value);
}
export function buyingBudgetUnits(available: number, percent: MarketPercentage): number {
  if (!Number.isSafeInteger(available) || available < 0) throw new RangeError('Invalid buying balance.');
  return Number(BigInt(available) * BigInt(percent) / 100n);
}
export function affordableBuyingQuantity(maximum: number, budget: number, cost: (quantity: number) => bigint | null): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(budget) || budget < 0)
    throw new RangeError('Invalid buying quantity limits.');
  let low = 0, high = maximum;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2), payment = cost(middle);
    if (payment !== null && payment > 0n && payment <= BigInt(budget)) low = middle;
    else high = middle - 1;
  }
  return low;
}
