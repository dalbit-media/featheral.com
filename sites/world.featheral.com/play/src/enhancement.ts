import { activityEquipmentItems, isActivityEquipment } from './activity-equipment.ts';
import type { ActivityEquipment, EquipmentActivity } from './activity-equipment.ts';
import type { Cost, Game } from './engine.ts';
import type { ItemInventory } from './items.ts';
import { dollarsScale } from './dollars.ts';

export const enhancementMaximumLevel = 1000;
export const refinementCore = 'refinement-core';
export const refinementItems = {
  'refinement-core': { name: 'Refinement Core', stage: 0, cost: { wood: 1000, metal: 500, oil: 100, dollars: 250 } },
} as const;
export interface EnhancedEquipment { id: string; item: ActivityEquipment; level: number }
export type EnhancedEquipped = Partial<Record<EquipmentActivity, string>>;
export interface EnhancementListing {
  id: number; equipment: EnhancedEquipment; price: number; createdAt: number; yours: boolean;
}
export type EnhancementMarketCommand =
  | { type: 'enhancement-list'; equipmentId: string; price: number }
  | { type: 'enhancement-cancel'; listingId: number }
  | { type: 'enhancement-buy'; listingId: number; price: number };
export interface EnhancementQuote {
  target: string; item: ActivityEquipment | null; level: number; cost: Cost; cores: 1;
  chance: number; discount: number; nextDiscount: number; eligible: boolean; reason: string | null; fingerprint: string;
}
export function isEquipmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function validEnhancedEquipment(value: EnhancedEquipment): boolean {
  return !!value && isEquipmentId(value.id) && isActivityEquipment(value.item)
    && Number.isSafeInteger(value.level) && value.level >= 0 && value.level <= enhancementMaximumLevel;
}
export function enhancementChance(level: number): number {
  return Math.max(40, 80 - level * 2);
}
export function enhancedDiscount(item: ActivityEquipment, level: number): number {
  return Math.min(75, activityEquipmentItems[item].discount + level * 2);
}
export function enhancementCost(level: number): Cost {
  const tenths = 10 + level;
  const cost = (base: number) => Math.floor((base * tenths + 9) / 10);
  return { wood: cost(100), water: cost(50), metal: cost(50), oil: cost(10), dollars: cost(25) };
}
export function enhancementQuote(game: Game, bag: ItemInventory, target: string): EnhancementQuote {
  const copy = bag.enhancedEquipment?.find(copy => copy.id === target);
  const item = copy?.item ?? (isActivityEquipment(target) ? target : null), level = copy?.level ?? 0;
  const cost = enhancementCost(level);
  const discount = item ? enhancedDiscount(item, level) : 0;
  const available = !!copy || !!item && bag.items.filter(owned => owned === item).length
    > Number(bag.activityEquipment?.[activityEquipmentItems[item].activity] === item);
  const reason = !item || !available ? 'Own an unequipped copy before refining.'
    : game.stage < 0 ? 'Establish a settlement before refining.'
      : level >= enhancementMaximumLevel ? 'Maximum refinement level reached.'
        : discount >= 75 ? 'Maximum equipment discount reached.'
        : !bag.items.includes(refinementCore) ? 'A Refinement Core is required.'
          : Object.entries(cost).some(([resource, amount]) => resource === 'dollars'
            ? game.dollars < amount * dollarsScale : game.stock[resource as keyof Game['stock']] < amount)
            ? 'Not enough resources or FTH$ to refine.' : null;
  const nextDiscount = item ? enhancedDiscount(item, Math.min(enhancementMaximumLevel, level + 1)) : 0;
  const chance = enhancementChance(level);
  const fingerprint = JSON.stringify({ target, item, level, cost, cores: 1, chance, discount, nextDiscount });
  return { target, item, level, cost, cores: 1, chance, discount, nextDiscount, eligible: reason === null, reason, fingerprint };
}
