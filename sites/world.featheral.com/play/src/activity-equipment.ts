import type { Cost, Game } from './engine.ts';
import type { DecorationItem } from './items.ts';
import type { CollectionItem } from './collection.ts';
import { dollarsScale } from './dollars.ts';
import { enhancedDiscount, validEnhancedEquipment } from './enhancement.ts';

export const equipmentActivities = ['investigation', 'exploration', 'attraction'] as const;
export type EquipmentActivity = typeof equipmentActivities[number];
interface ActivityEquipmentRecipe {
  name: string;
  activity: EquipmentActivity;
  discount: number;
  stage: number;
  cost: Cost;
  ingredients: Partial<Record<DecorationItem | CollectionItem, number>>;
}
export const activityEquipmentItems = {
  'survey-satchel': { name: 'Survey satchel', activity: 'investigation', discount: 10, stage: 0, cost: { wood: 6, metal: 2 },
    ingredients: { banner: 1, logseat: 1, 'collection-wood-1': 2 } },
  'survey-station': { name: 'Field survey station', activity: 'investigation', discount: 25, stage: 3, cost: { metal: 18, water: 8 },
    ingredients: { gazebo: 1, barrel: 1, 'collection-metal-4': 2, 'collection-water-4': 1 } },
  'survey-array': { name: 'Precision survey array', activity: 'investigation', discount: 50, stage: 6, cost: { metal: 80, oil: 10 },
    ingredients: { solar: 1, sculpture: 1, 'collection-metal-12': 2, 'collection-oil-12': 1 } },
  'trail-kit': { name: 'Trail supply kit', activity: 'exploration', discount: 10, stage: 0, cost: { wood: 8, water: 6 },
    ingredients: { boardwalk: 1, bench: 1, 'collection-wood-1': 1, 'collection-water-1': 1 } },
  'trail-outpost': { name: 'Expedition outpost kit', activity: 'exploration', discount: 25, stage: 3, cost: { wood: 20, metal: 12 },
    ingredients: { canopy: 2, picnic: 1, 'collection-wood-4': 2, 'collection-water-4': 2 } },
  'trail-network': { name: 'Expedition logistics network', activity: 'exploration', discount: 50, stage: 6, cost: { metal: 90, oil: 12 },
    ingredients: { tramstop: 1, solar: 1, 'collection-metal-12': 2, 'collection-oil-12': 2 } },
  'welcome-kit': { name: 'Settler welcome kit', activity: 'attraction', discount: 10, stage: 0, cost: { wood: 6, water: 10 },
    ingredients: { planter: 1, banner: 1, 'collection-wood-1': 1, 'collection-water-1': 2 } },
  'welcome-pavilion': { name: 'Community welcome pavilion', activity: 'attraction', discount: 25, stage: 4, cost: { wood: 30, water: 25 },
    ingredients: { pavilion: 1, fountain: 1, 'collection-wood-4': 2, 'collection-water-4': 2 } },
  'welcome-network': { name: 'Settler hospitality network', activity: 'attraction', discount: 50, stage: 6, cost: { metal: 70, water: 50, oil: 8 },
    ingredients: { verticalgarden: 1, greenhouse: 1, 'collection-water-12': 2, 'collection-metal-12': 1 } },
} as const satisfies Record<string, ActivityEquipmentRecipe>;
export type ActivityEquipment = keyof typeof activityEquipmentItems;
export type EquippedActivities = Partial<Record<EquipmentActivity, ActivityEquipment>>;
export function isActivityEquipment(value: unknown): value is ActivityEquipment {
  return typeof value === 'string' && Object.hasOwn(activityEquipmentItems, value);
}
export function isEquipmentActivity(value: unknown): value is EquipmentActivity {
  return equipmentActivities.some(activity => activity === value);
}
export function activityEquipmentDiscount(game: Pick<Game, 'activityEquipment' | 'enhancedEquipment' | 'enhancedEquipped'>, activity: EquipmentActivity): number {
  const copy = game.enhancedEquipment?.find(copy => copy.id === game.enhancedEquipped?.[activity]);
  if (copy && validEnhancedEquipment(copy) && activityEquipmentItems[copy.item].activity === activity)
    return enhancedDiscount(copy.item, copy.level);
  const item = game.activityEquipment?.[activity];
  return isActivityEquipment(item) && activityEquipmentItems[item].activity === activity
    ? Math.min(50, activityEquipmentItems[item].discount) : 0;
}
export function discountedActivityCost(game: Pick<Game, 'activityEquipment' | 'enhancedEquipment' | 'enhancedEquipped'>, activity: EquipmentActivity, dollars: number): number {
  const percent = activityEquipmentDiscount(game, activity);
  if (!percent) return dollars;
  return Math.ceil(Math.round(dollars * dollarsScale) * (100 - percent) / 100) / dollarsScale;
}
export function activityEquipmentBenefit(item: ActivityEquipment): string {
  const recipe = activityEquipmentItems[item];
  return `${recipe.discount}% lower ${recipe.activity} fees`;
}
