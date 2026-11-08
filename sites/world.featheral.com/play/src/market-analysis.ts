import type { CraftableItem } from './items.ts';
import type { MarketAsset } from './market.ts';
import { worldDayMs } from './environment.ts';

export const marketAnalysisFee = 100;
export const marketAnalysisDuration = worldDayMs;
export interface CraftProfitAnalysis {
  item: CraftableItem;
  craftingFee: number;
  ingredients: { asset: MarketAsset; quantity: number; dollars: number | null }[];
  cost: number | null;
  revenue: number | null;
  profit: number | null;
}
export interface MarketAnalysis {
  generatedAt: number;
  expiresAt: number;
  fee: number;
  items: CraftProfitAnalysis[];
}
export function activeMarketAnalysis(report: MarketAnalysis | null | undefined, now: number): MarketAnalysis | null {
  return report && Number.isSafeInteger(now) && now >= report.generatedAt && now < report.expiresAt ? report : null;
}
export const marketRarities = ['unavailable', 'legendary', 'epic', 'rare', 'uncommon', 'common'] as const;
export type MarketRarity = typeof marketRarities[number] | 'unknown';
export function marketRarity(quantity: number | undefined): MarketRarity {
  if (quantity === undefined || !Number.isSafeInteger(quantity) || quantity < 0) return 'unknown';
  return quantity === 0 ? 'unavailable' : quantity < 10 ? 'legendary' : quantity < 50 ? 'epic'
    : quantity < 200 ? 'rare' : quantity < 1000 ? 'uncommon' : 'common';
}
export function rarityLabel(rarity: MarketRarity): string {
  return ({ unavailable: 'Unavailable', legendary: 'Legendary', epic: 'Epic', rare: 'Rare', uncommon: 'Uncommon', common: 'Common', unknown: 'Unknown supply' })[rarity];
}
