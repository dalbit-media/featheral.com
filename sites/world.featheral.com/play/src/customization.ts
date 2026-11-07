import type { Cost } from './engine.ts';

export const titleItems = {
  'title-pioneer': { name: 'Pioneer title badge', title: 'Pioneer', cost: { wood: 20, metal: 5 } },
  'title-explorer': { name: 'Explorer title badge', title: 'Explorer', cost: { wood: 15, oil: 2 } },
  'title-steward': { name: 'Steward title badge', title: 'Steward', cost: { wood: 15, water: 30 } },
  'title-artisan': { name: 'Artisan title badge', title: 'Artisan', cost: { wood: 30, metal: 15 } },
  'title-trader': { name: 'Trader title badge', title: 'Trader', cost: { metal: 20, oil: 3 } },
  'title-naturalist': { name: 'Naturalist title badge', title: 'Naturalist', cost: { wood: 20, water: 40 } },
} satisfies Record<string, { name: string; title: string; cost: Cost }>;
export const namingItems = {
  'permit-settlement-name': { name: 'Settlement naming permit', target: 'settlementName', cost: { wood: 30, metal: 10 } },
  'permit-region-name': { name: 'Region naming permit', target: 'regionName', cost: { wood: 40, metal: 15, water: 20 } },
} as const;
export const customizationItems = { ...namingItems, ...titleItems };
export type TitleItem = keyof typeof titleItems;
export type NamingItem = keyof typeof namingItems;
export type CustomizationItem = NamingItem | TitleItem;
export interface Customization { settlementName?: string; regionName?: string; title?: TitleItem }
export const customizationKeys = Object.keys(customizationItems) as CustomizationItem[];
export function isCustomizationItem(value: unknown): value is CustomizationItem {
  return typeof value === 'string' && Object.hasOwn(customizationItems, value);
}
export function isTitleItem(value: unknown): value is TitleItem {
  return typeof value === 'string' && Object.hasOwn(titleItems, value);
}
export function customizationName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
  return [...name].length >= 2 && [...name].length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(name) ? name : null;
}
