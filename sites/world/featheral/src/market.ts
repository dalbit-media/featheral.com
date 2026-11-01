import { prices, terrainDetails } from './engine.ts';
import type { Resource, Terrain } from './engine.ts';
import { craftableItems, craftableKeys, isCollectible, isCraftableItem, itemName } from './items.ts';
import type { ItemId } from './items.ts';
import type { ApiState } from './api-types.ts';
import { monetaryPolicy } from './monetary-policy.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, automationItems, isActivityItem } from './automation.ts';
import { dollarsScale } from './dollars.ts';

export type MarketResource = Resource;
export type MarketAsset = MarketResource | ItemId;
export type MarketSide = 'buy' | 'sell';
export function marketPriceAvailable(price: number): boolean {
  return price > 0 && price < Number.MAX_SAFE_INTEGER / dollarsScale;
}
export const marketResources: MarketResource[] = ['wood', 'water', 'metal', 'oil'];
export const marketAssets: MarketAsset[] = [...marketResources, ...craftableKeys, ...automationItems,
  ...(Object.keys(terrainDetails) as Terrain[]).map(terrain => `relic-${terrain}` as const)];
export function isMarketAsset(value: unknown): value is MarketAsset {
  return typeof value === 'string' && marketAssets.some(asset => asset === value);
}
export function isMarketResource(asset: MarketAsset): asset is MarketResource {
  return marketResources.some(resource => resource === asset);
}
export function isLiquidAsset(asset: MarketAsset): boolean { return !isCollectible(asset); }
export function marketQuantityLimit(asset: MarketAsset): number { return isLiquidAsset(asset) ? 10000 : 1; }
export function marketAssetName(asset: MarketAsset): string {
  return isMarketResource(asset) ? ({ wood: 'Wood', water: 'Water', metal: 'Metal', oil: 'Oil' })[asset] : itemName(asset);
}
export function marketBasePrice(asset: MarketAsset): number {
  if (isMarketResource(asset)) return prices[asset] * 2;
  if (isCollectionItem(asset)) return monetaryPolicy.collectibleBase + collectionItemDetails(asset).weeks * monetaryPolicy.collectiblePerWeek;
  if (isActivityItem(asset)) return monetaryPolicy.collectibleBase + activityItemDetails(asset).weeks * monetaryPolicy.collectiblePerWeek;
  if (!isCraftableItem(asset)) return monetaryPolicy.collectibleBase + terrainDetails[asset.slice(6) as Terrain].weeks * monetaryPolicy.collectiblePerWeek;
  return Math.max(10, Math.floor(Object.entries(craftableItems[asset].cost).reduce((sum, [resource, count]) =>
    sum + (resource === 'dollars' ? count : count * prices[resource as Resource] * monetaryPolicy.materialFeeMultiplier), 0) * monetaryPolicy.craftedPricePercent / 100));
}
export interface HalfSaleOrder { asset: MarketResource; quantity: number; limitDollars: number }
export interface HalfSaleQuote {
  sales: { asset: MarketResource; quantity: number; dollars: number; available: boolean }[];
  dollars: number;
  available: boolean;
}
export interface HalfSaleResponse extends ApiState { halfSale: HalfSaleQuote }
export type MarketCommand =
  | { type: 'sell-half'; sales: HalfSaleOrder[] }
  | { type: 'spot'; asset: MarketAsset; side: MarketSide; quantity: number; limitDollars: number }
  | { type: 'limit'; asset: MarketAsset; side: MarketSide; quantity: number; price: number }
  | { type: 'cancel'; orderId: number };
export interface MarketOrder {
  id: number; asset: MarketAsset; side: MarketSide; price: number; quantity: number; remaining: number;
  status: 'open' | 'filled' | 'cancelled'; createdAt: number;
}
export interface MarketFill {
  id: number; asset: MarketAsset; quantity: number; dollars: number; price: number; time: number;
  venue: 'players' | 'system'; side?: MarketSide;
}
export interface MarketQuote { quantity: number; dollars: number; available: boolean }
export interface MarketSnapshot {
  asset: MarketAsset; quantity: number;
  tickers: { asset: MarketAsset; bid: number; ask: number; last: number | null }[];
  bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[];
  quotes: { buy: MarketQuote; sell: MarketQuote };
  history: MarketFill[]; trades: MarketFill[]; orders: MarketOrder[];
}
export interface MarketResponse extends ApiState { market: MarketSnapshot }
