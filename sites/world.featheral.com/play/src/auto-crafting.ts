import type { CraftableItem, ItemId } from './items.ts';
import type { BulkCraftingItem } from './bulk-crafting.ts';
import type { ApiState } from './api-types.ts';
import type { MarketAsset } from './market.ts';

export const merchantCharter = 'merchant-charter';
export const merchantCharterFee = 10000;
export const autoCraftingItems = {
  'merchant-charter': { name: 'Master Merchant Charter', stage: 8, cost: { dollars: merchantCharterFee * 10 } },
} as const;
export function isAutoCraftingItem(value: unknown): value is typeof merchantCharter { return value === merchantCharter; }
export interface AutoCraftBatch {
  item: CraftableItem;
  permit: BulkCraftingItem;
  quantity: number;
  fee: number;
  proceeds: number;
  valuedCost: number;
}
export interface AutoCraftQuote {
  fingerprint: string;
  batches: AutoCraftBatch[];
  costs: { asset: MarketAsset | 'dollars'; amount: number }[];
  startingBalance: number;
  craftingFees: number;
  proceeds: number;
  cashChange: number;
  estimatedProfit: number;
  remainingPermits: number;
  consumedPermits: number;
}
export interface AutoCraftResponse extends ApiState { autoCraft: AutoCraftQuote }
export function autoCraftableOutput(item: ItemId): boolean {
  return !isAutoCraftingItem(item) && !item.startsWith('craft-batch-');
}
