import type { Cost, Resource } from './engine.ts';
import { monetaryPolicy } from './monetary-policy.ts';

export const resourcePrices: Readonly<Record<Resource, number>> = monetaryPolicy.resourcePrices;
export const maximumUpgradeLevel = 99;
export function withDollarFee<T extends Cost>(cost: T): T & { dollars: number } {
  return { ...cost, dollars: cost.dollars ?? Object.entries(cost).reduce((sum, [resource, amount]) =>
    sum + amount * resourcePrices[resource as Resource] * monetaryPolicy.materialFeeMultiplier, 0) };
}
export function warehouseCost(level: number): { wood: number; metal: number; dollars: number } {
  return { wood: 80 * level, metal: 20 * level, dollars: monetaryPolicy.warehousePerLevel * level };
}
