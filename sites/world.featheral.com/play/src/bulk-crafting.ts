import type { Cost, Game } from './engine.ts';
import type { CollectionItem } from './collection.ts';
import type { CraftableItem, DecorationItem, ItemInventory } from './items.ts';
import { craftingCost, craftingFits, craftingInputs, craftingStage, recipeDiscovered, sellableItemCount } from './items.ts';
import { canAfford } from './engine.ts';

interface BulkRecipe {
  name: string;
  quantity: number;
  stage: number;
  cost: Cost;
  ingredients: Partial<Record<DecorationItem | CollectionItem, number>>;
}
export const bulkCraftingItems = {
  'craft-batch-10': { name: 'Crafting permit · 10 copies', quantity: 10, stage: 0, cost: { wood: 8, metal: 2 },
    ingredients: { bench: 1, banner: 1, 'collection-wood-1': 1 } },
  'craft-batch-20': { name: 'Crafting permit · 20 copies', quantity: 20, stage: 2, cost: { wood: 16, metal: 6 },
    ingredients: { canopy: 1, picnic: 1, 'collection-wood-4': 1, 'collection-metal-1': 1 } },
  'craft-batch-50': { name: 'Crafting permit · 50 copies', quantity: 50, stage: 4, cost: { metal: 24, oil: 2 },
    ingredients: { kiosk: 1, pavilion: 1, 'collection-metal-4': 2, 'collection-wood-4': 1 } },
  'craft-batch-100': { name: 'Crafting permit · 100 copies', quantity: 100, stage: 6, cost: { metal: 60, oil: 6 },
    ingredients: { tramstop: 1, solar: 1, 'collection-metal-12': 2, 'collection-oil-4': 1 } },
} as const satisfies Record<string, BulkRecipe>;
export type BulkCraftingItem = keyof typeof bulkCraftingItems;
export const bulkCraftingKeys = Object.keys(bulkCraftingItems) as BulkCraftingItem[];
export function isBulkCraftingItem(value: unknown): value is BulkCraftingItem {
  return typeof value === 'string' && Object.hasOwn(bulkCraftingItems, value);
}
export function bulkCraftingPermit(quantity: number): BulkCraftingItem | undefined {
  return bulkCraftingKeys.find(item => bulkCraftingItems[item].quantity === quantity);
}
export function validCraftingQuantity(quantity: number): boolean {
  return quantity === 1 || bulkCraftingPermit(quantity) !== undefined;
}
export interface CraftBatchOption {
  quantity: number;
  permit?: BulkCraftingItem;
  owned: number;
  reason: string | null;
}
export function craftBatchOptions(game: Game, bag: ItemInventory, item: CraftableItem): CraftBatchOption[] {
  const options: CraftBatchOption[] = [{ quantity: 1, owned: 0, reason: null },
    ...bulkCraftingKeys.map(permit => ({ quantity: bulkCraftingItems[permit].quantity, permit, owned: sellableItemCount(bag, permit), reason: null }))
      .filter(option => option.owned > 0)];
  return options.map(option => {
    const ingredients = craftingInputs(item, option.quantity);
    const reason = game.stage < craftingStage(item) ? 'Civilization level required'
      : !recipeDiscovered(game, item) ? 'Discover ingredients first'
      : !canAfford(game, craftingCost(item, option.quantity)) ? 'Not enough resources'
      : Object.entries(ingredients).some(([id, count]) => sellableItemCount(bag, id as keyof typeof ingredients) < count) ? 'Not enough unused ingredients'
      : !craftingFits(bag, item, option.quantity) ? 'Item inventory full' : null;
    return { ...option, reason };
  });
}
