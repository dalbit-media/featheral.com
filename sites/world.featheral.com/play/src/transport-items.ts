import type { Cost } from './engine.ts';
import type { CollectionItem } from './collection.ts';
import type { DecorationItem, ItemInventory } from './items.ts';

export const transportItems = {
  'transport-cart': { name: 'Handcart voucher', discount: 10, stage: 0, cost: { wood: 8, metal: 2 },
    ingredients: { logseat: 1, 'collection-wood-1': 1 } },
  'transport-wagon': { name: 'Freight wagon voucher', discount: 25, stage: 2, cost: { wood: 16, metal: 6 },
    ingredients: { bench: 1, canopy: 1, 'collection-metal-1': 1 } },
  'transport-convoy': { name: 'Shared convoy voucher', discount: 50, stage: 4, cost: { metal: 20, oil: 2 },
    ingredients: { kiosk: 1, boardwalk: 1, 'collection-wood-4': 1 } },
} as const satisfies Record<string, { name: string; discount: number; stage: number; cost: Cost;
  ingredients: Partial<Record<DecorationItem | CollectionItem, number>> }>;
export type TransportItem = keyof typeof transportItems;
export const transportItemKeys = Object.keys(transportItems) as TransportItem[];
export function isTransportItem(item: unknown): item is TransportItem {
  return typeof item === 'string' && Object.hasOwn(transportItems, item);
}
export function transportBenefit(item: TransportItem): string {
  return `Reduces one resource pickup fee by ${transportItems[item].discount}%. Automatically consumes the strongest owned voucher. Includes auto-collection. No stacking.`;
}
export function transportQuote(fee: number, bag: ItemInventory): { fee: number; discount: number; item?: TransportItem } {
  if (!Number.isSafeInteger(fee) || fee < 0) throw new RangeError('Invalid transport fee.');
  const item = fee > 0 ? [...transportItemKeys].reverse().find(id => bag.items.includes(id)) : undefined;
  const discount = item ? Math.min(50, transportItems[item].discount) : 0;
  return { fee: item ? Number((BigInt(fee) * BigInt(100 - discount) + 99n) / 100n) : fee, discount, ...(item ? { item } : {}) };
}
export function consumeTransportVoucher(bag: ItemInventory, item: TransportItem | undefined): void {
  if (!item) return;
  const index = bag.items.indexOf(item);
  if (index < 0) throw new Error('Transport voucher is no longer available.');
  bag.items.splice(index, 1);
}
