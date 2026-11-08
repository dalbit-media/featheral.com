import { terrainAt, terrainDetails, terrainResources } from './engine.ts';
import type { Cost, Game, Resource, Terrain } from './engine.ts';
import type { SettlementLayout } from './settlement-layout.ts';
import { withDollarFee } from './costs.ts';
import { monetaryPolicy } from './monetary-policy.ts';
import { collectionItemName, isCollectionItem } from './collection.ts';
import type { CollectionItem } from './collection.ts';
import { activityItemName, isActivityItem } from './automation.ts';
import type { ActivityItem } from './automation.ts';
import { customizationItems, isCustomizationItem } from './customization.ts';
import type { CustomizationItem } from './customization.ts';
import { collectorRecipes } from './collector-recipes.ts';
import type { CollectorBundle } from './collector-recipes.ts';

export const visibilityItems = {
  fire: { name: 'Campfire kit', radius: 5, cost: withDollarFee({ wood: 15, water: 5 }), symbol: 'sun' },
  torch: { name: 'Torch', radius: 6, cost: withDollarFee({ wood: 30 }), symbol: 'sun' },
  lamp: { name: 'Lamp', radius: 8, cost: withDollarFee({ wood: 60, metal: 40 }), symbol: 'sun' },
  lantern: { name: 'Explorer lantern', radius: 10, cost: { wood: 80, oil: 8, dollars: 4 }, symbol: 'spark' },
} satisfies Record<string, { name: string; radius: number; cost: Cost; symbol: string }>;
export type VisibilityItem = keyof typeof visibilityItems;
export const decorationItems = {
  planter: { name: 'Flower planter', cost: { wood: 20, water: 10 } },
  bench: { name: 'Wooden bench', cost: { wood: 30 } },
  banner: { name: 'Pioneer banner', cost: { wood: 20, metal: 10 } },
  fountain: { name: 'Courtyard fountain', cost: { wood: 30, water: 40, metal: 30 } },
  boardwalk: { name: 'Garden boardwalk', cost: { wood: 45 } },
  canopy: { name: 'Market canopy', cost: { wood: 50, metal: 15 } },
} satisfies Record<string, { name: string; cost: Cost }>;
export type DecorationItem = keyof typeof decorationItems;
export const craftableItems = { ...visibilityItems, ...decorationItems, ...customizationItems, ...collectorRecipes };
export type CraftableItem = keyof typeof craftableItems;
export const craftableKeys = Object.keys(craftableItems) as CraftableItem[];
export const decorationSpaces = {
  square: { name: 'Central square', x: 51, y: 58 },
  garden: { name: 'Community garden', x: 25, y: 77 },
  gate: { name: 'Welcome gate', x: 15, y: 52 },
  courtyard: { name: 'Residential courtyard', x: 70, y: 35 },
  lane: { name: 'Market lane', x: 69, y: 76 },
  riverside: { name: 'Waterside retreat', x: 88, y: 82 },
} as const;
export type DecorationSlot = keyof typeof decorationSpaces;
export const decorationSlots = Object.keys(decorationSpaces) as DecorationSlot[];
export type Collectible = `relic-${Terrain}`;
export type ExplorationFind = Collectible | CollectionItem | ActivityItem | CustomizationItem;
export type ItemId = CraftableItem | ExplorationFind;
export interface ItemInventory {
  version: 1;
  storage: number;
  items: ItemId[];
  pending: ExplorationFind[];
  equipped: VisibilityItem | null;
  placements?: Partial<Record<DecorationSlot, DecorationItem>>;
  layout?: SettlementLayout;
  marketReserved?: ItemId[];
  marketSelling?: ItemId[];
}
export const inventoryPageSize = 20;
export const itemStorage = [
  { name: 'Bag', capacity: inventoryPageSize, metal: 0, dollars: 0 },
  { name: 'Carrier', capacity: inventoryPageSize * 2, metal: 50, dollars: monetaryPolicy.itemStoragePerLevel },
  { name: 'Crate', capacity: inventoryPageSize * 3, metal: 150, dollars: monetaryPolicy.itemStoragePerLevel * 2 },
  { name: 'Container', capacity: inventoryPageSize * 4, metal: 400, dollars: monetaryPolicy.itemStoragePerLevel * 3 },
  { name: 'Item warehouse', capacity: inventoryPageSize * 5, metal: 1000, dollars: monetaryPolicy.itemStoragePerLevel * 4 },
] as const;
export const visibilityKeys = Object.keys(visibilityItems) as VisibilityItem[];
export function inventoryUsed(bag: ItemInventory): number {
  return bag.items.length + (bag.marketReserved?.length ?? 0);
}
export function itemStacks(items: readonly ItemId[]): { id: ItemId; quantity: number }[] {
  const quantities = new Map<ItemId, number>();
  for (const id of items) quantities.set(id, (quantities.get(id) ?? 0) + 1);
  return [...quantities].map(([id, quantity]) => ({ id, quantity }));
}
export function isVisibilityItem(value: unknown): value is VisibilityItem {
  return typeof value === 'string' && Object.hasOwn(visibilityItems, value);
}
export function isDecorationItem(value: unknown): value is DecorationItem {
  return typeof value === 'string' && Object.hasOwn(decorationItems, value);
}
export function isCraftableItem(value: unknown): value is CraftableItem {
  return typeof value === 'string' && Object.hasOwn(craftableItems, value);
}
export function isCollectible(value: unknown): value is Collectible {
  return typeof value === 'string' && value.startsWith('relic-') && Object.hasOwn(terrainDetails, value.slice(6));
}
export function sellableItemCount(bag: ItemInventory, item: ItemId): number {
  const protectedCopy = bag.equipped === item || (isDecorationItem(item)
    && (bag.layout?.positions[item] || Object.values(bag.placements ?? {}).includes(item))) ? 1 : 0;
  return Math.max(0, bag.items.filter(id => id === item).length - protectedCopy);
}
export function isDecorationSlot(value: unknown): value is DecorationSlot {
  return typeof value === 'string' && Object.hasOwn(decorationSpaces, value);
}
export function placedSlot(bag: ItemInventory, item: DecorationItem): DecorationSlot | undefined {
  return decorationSlots.find(slot => bag.placements?.[slot] === item);
}
export function itemName(id: ItemId): string {
  if (isCustomizationItem(id)) return customizationItems[id].name;
  if (isCollectionItem(id)) return collectionItemName(id);
  if (isActivityItem(id)) return activityItemName(id);
  return isCraftableItem(id) ? craftableItems[id].name : `${terrainDetails[id.slice(6) as Terrain].name} keepsake`;
}
export function recipeDiscovered(game: Game, item: CraftableItem): boolean {
  const resources = Object.keys(craftableItems[item].cost).filter(resource => resource !== 'dollars');
  if (!resources.length) return true;
  const found = new Set<Resource>(game.explored.map(key => {
    const [x, y] = key.split(',').map(Number);
    return terrainResources[terrainAt(x, y, game.seed)];
  }));
  return resources.every(resource => found.has(resource as Resource));
}
export function craftingCost(item: CraftableItem, quantity = 1): Cost {
  return Object.fromEntries(Object.entries(craftableItems[item].cost).map(([resource, amount]) => [resource, amount * quantity]));
}
export function craftingIngredients(item: CraftableItem, quantity = 1): Partial<Record<CollectionItem, number>> {
  if (!Object.hasOwn(collectorRecipes, item)) return {};
  return Object.fromEntries(Object.entries(collectorRecipes[item as CollectorBundle].ingredients).map(([id, count]) => [id, count * quantity]));
}
export function craftingMaximum(game: Game, bag: ItemInventory, item: CraftableItem): number {
  const ingredients = craftingIngredients(item);
  const count = Object.values(ingredients).reduce((sum, amount) => sum + amount, 0);
  const room = itemStorage[bag.storage].capacity - inventoryUsed(bag);
  return Math.max(0, Math.min(100, ...(count ? [] : [room]),
    ...Object.entries(craftableItems[item].cost).filter(([, amount]) => amount > 0).map(([resource, amount]) =>
      Math.floor((resource === 'dollars' ? game.dollars / 10000 : game.stock[resource as Resource]) / amount)),
    ...Object.entries(ingredients).map(([id, amount]) => Math.floor(bag.items.filter(owned => owned === id).length / amount))));
}
export function craftingFits(bag: ItemInventory, item: CraftableItem, quantity: number): boolean {
  return inventoryUsed(bag) - Object.values(craftingIngredients(item, quantity)).reduce((sum, amount) => sum + amount, 0) + quantity <= itemStorage[bag.storage].capacity;
}
