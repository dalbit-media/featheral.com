import { stages, terrainAt, terrainDetails, terrainResources } from './engine.ts';
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
import { activityEquipmentItems, isActivityEquipment } from './activity-equipment.ts';
import type { EquippedActivities } from './activity-equipment.ts';
import { bulkCraftingItems, bulkCraftingPermit, isBulkCraftingItem } from './bulk-crafting.ts';
import { transportItems, isTransportItem } from './transport-items.ts';
import { squadItems } from './exploration-squads.ts';

export const visibilityItems = {
  fire: { name: 'Campfire kit', radius: 5, cost: withDollarFee({ wood: 15 }), symbol: 'sun' },
  torch: { name: 'Torch', radius: 6, cost: withDollarFee({ wood: 8 }), symbol: 'sun' },
  lamp: { name: 'Lamp', radius: 8, cost: withDollarFee({ metal: 12, oil: 3 }), symbol: 'sun' },
  lantern: { name: 'Explorer lantern', radius: 10, cost: { metal: 20, oil: 5, dollars: 4 }, symbol: 'spark' },
} satisfies Record<string, { name: string; radius: number; cost: Cost; symbol: string }>;
export type VisibilityItem = keyof typeof visibilityItems;
export const decorationItems = {
  planter: { name: 'Flower planter', stage: 0, cost: { wood: 12, water: 6 } },
  bench: { name: 'Wooden bench', stage: 0, cost: { wood: 24, metal: 2 } },
  banner: { name: 'Pioneer banner', stage: 0, cost: { wood: 12, metal: 4 } },
  fountain: { name: 'Courtyard fountain', stage: 0, cost: { metal: 60, water: 40 } },
  boardwalk: { name: 'Garden boardwalk', stage: 0, cost: { wood: 45, metal: 6 } },
  canopy: { name: 'Market canopy', stage: 0, cost: { wood: 36, metal: 8 } },
  logseat: { name: 'Log seat', stage: 0, cost: { wood: 6 } },
  flowerbed: { name: 'Wildflower bed', stage: 0, cost: { wood: 4, water: 12 } },
  fence: { name: 'Picket fence', stage: 1, cost: { wood: 18, metal: 2 } },
  birdhouse: { name: 'Birdhouse', stage: 1, cost: { wood: 10, metal: 1 } },
  trellis: { name: 'Vine trellis', stage: 1, cost: { wood: 22, water: 8 } },
  barrel: { name: 'Rain barrel', stage: 1, cost: { wood: 26, metal: 6, water: 16 } },
  picnic: { name: 'Picnic table', stage: 2, cost: { wood: 40, metal: 8 } },
  arch: { name: 'Garden arch', stage: 2, cost: { wood: 32, metal: 10, water: 8 } },
  swing: { name: 'Garden swing', stage: 2, cost: { wood: 36, metal: 18 } },
  gazebo: { name: 'Village gazebo', stage: 3, cost: { wood: 100, metal: 24 } },
  clocktower: { name: 'Village clock tower', stage: 3, cost: { wood: 70, metal: 60, oil: 2 } },
  monument: { name: 'Founders monument', stage: 3, cost: { metal: 85, water: 12 } },
  streetlamp: { name: 'Town streetlamp', stage: 4, cost: { metal: 45, oil: 10 } },
  kiosk: { name: 'Town information kiosk', stage: 4, cost: { wood: 55, metal: 30 } },
  pavilion: { name: 'Civic pavilion', stage: 4, cost: { wood: 140, metal: 60 } },
  greenhouse: { name: 'Glass garden', stage: 5, cost: { metal: 95, water: 55, oil: 12 } },
  sculpture: { name: 'Modern sculpture', stage: 5, cost: { metal: 130, oil: 8 } },
  tramstop: { name: 'Decorative tram shelter', stage: 6, cost: { metal: 160, wood: 24, oil: 18 } },
  solar: { name: 'Solar pergola', stage: 6, cost: { metal: 180, oil: 30 } },
  verticalgarden: { name: 'Living wall', stage: 6, cost: { metal: 100, wood: 45, water: 90 } },
  observatory: { name: 'Sky observatory', stage: 7, cost: { metal: 300, oil: 45 } },
  lightspire: { name: 'Metropolis light spire', stage: 7, cost: { metal: 260, oil: 60 } },
  biodome: { name: 'Capital biodome', stage: 8, cost: { metal: 420, water: 160, oil: 70 } },
  skybeacon: { name: 'Capital sky beacon', stage: 8, cost: { metal: 500, oil: 90 } },
} satisfies Record<string, { name: string; stage: number; cost: Cost }>;
export type DecorationItem = keyof typeof decorationItems;
export const craftableItems = { ...visibilityItems, ...decorationItems, ...customizationItems, ...collectorRecipes, ...activityEquipmentItems, ...bulkCraftingItems, ...transportItems, ...squadItems };
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
  activityEquipment?: EquippedActivities;
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
  { name: 'Item warehouse II', capacity: inventoryPageSize * 6, metal: 2000, dollars: monetaryPolicy.itemStoragePerLevel * 5 },
  { name: 'Item warehouse III', capacity: inventoryPageSize * 7, metal: 4000, dollars: monetaryPolicy.itemStoragePerLevel * 6 },
  { name: 'Item warehouse IV', capacity: inventoryPageSize * 8, metal: 8000, dollars: monetaryPolicy.itemStoragePerLevel * 7 },
  { name: 'Item warehouse V', capacity: inventoryPageSize * 9, metal: 16000, dollars: monetaryPolicy.itemStoragePerLevel * 8 },
  { name: 'Item warehouse VI', capacity: inventoryPageSize * 10, metal: 32000, dollars: monetaryPolicy.itemStoragePerLevel * 9 },
] as const;
export const visibilityKeys = Object.keys(visibilityItems) as VisibilityItem[];
export function inventoryUsed(bag: ItemInventory): number {
  return new Set([...bag.items, ...(bag.marketReserved ?? [])]).size;
}
export function inventoryFits(bag: ItemInventory, item: ItemId): boolean {
  return bag.items.includes(item) || Boolean(bag.marketReserved?.includes(item)) || inventoryUsed(bag) < itemStorage[bag.storage].capacity;
}
export function collectibleFindAvailable(bag: ItemInventory, item: ExplorationFind): boolean {
  return !isCollectible(item) || !bag.marketReserved?.includes(item);
}
export function canCollectFinds(bag: ItemInventory): boolean {
  return bag.pending.some(item => collectibleFindAvailable(bag, item) && inventoryFits(bag, item));
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
  const protectedCopy = bag.equipped === item || Object.values(bag.activityEquipment ?? {}).some(equipped => equipped === item) || (isDecorationItem(item)
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
export function craftingStage(item: CraftableItem): number {
  return isTransportItem(item) ? transportItems[item].stage : isBulkCraftingItem(item) ? bulkCraftingItems[item].stage : isActivityEquipment(item) ? activityEquipmentItems[item].stage : isDecorationItem(item) ? decorationItems[item].stage : 0;
}
export function craftingStageName(item: CraftableItem): string {
  return stages[craftingStage(item)].name;
}
export function craftingCost(item: CraftableItem, quantity = 1): Cost {
  const cost = withDollarFee(craftableItems[item].cost);
  return Object.fromEntries(Object.entries(cost).map(([resource, amount]) =>
    [resource, resource === 'dollars'
      ? Math.round(Math.max(1, amount / 10) * quantity * monetaryPolicy.scale) / monetaryPolicy.scale
      : Math.ceil(amount / 10) * quantity]));
}
export function craftingIngredients(item: CraftableItem, quantity = 1): Partial<Record<ItemId, number>> {
  const ingredients = isTransportItem(item) ? transportItems[item].ingredients : isBulkCraftingItem(item) ? bulkCraftingItems[item].ingredients : isActivityEquipment(item) ? activityEquipmentItems[item].ingredients
    : Object.hasOwn(collectorRecipes, item) ? collectorRecipes[item as CollectorBundle].ingredients : {};
  return Object.fromEntries(Object.entries(ingredients).map(([id, count]) => [id, count * quantity]));
}
export function craftingInputs(item: CraftableItem, quantity = 1): Partial<Record<ItemId, number>> {
  const ingredients = craftingIngredients(item, quantity), permit = bulkCraftingPermit(quantity);
  if (permit) ingredients[permit] = (ingredients[permit] ?? 0) + 1;
  return ingredients;
}
export function craftingMaximum(game: Game, bag: ItemInventory, item: CraftableItem): number {
  if (game.stage < craftingStage(item) || !recipeDiscovered(game, item)) return 0;
  const ingredients = craftingIngredients(item);
  const maximum = Math.max(0, Math.min(100,
    ...Object.entries(craftingCost(item)).filter(([, amount]) => amount > 0).map(([resource, amount]) =>
      Math.floor((resource === 'dollars' ? game.dollars / 10000 : game.stock[resource as Resource]) / amount)),
    ...Object.entries(ingredients).map(([id, amount]) => Math.floor(sellableItemCount(bag, id as ItemId) / amount))));
  for (let quantity = maximum; quantity > 0; quantity--) if (craftingFits(bag, item, quantity)) return quantity;
  return 0;
}
export function craftingFits(bag: ItemInventory, item: CraftableItem, quantity: number): boolean {
  const inputs = craftingInputs(item, quantity);
  const stacks = new Set(bag.marketReserved ?? []);
  for (const { id, quantity: owned } of itemStacks(bag.items)) if (owned > (inputs[id] ?? 0)) stacks.add(id);
  stacks.add(item);
  return stacks.size <= itemStorage[bag.storage].capacity;
}
