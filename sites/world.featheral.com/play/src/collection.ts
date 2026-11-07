import type { Resource } from './engine.ts';
import type { Snapshot } from './api-types.ts';

export const collectionDurations = Object.freeze([1, 4, 12] as const);
export const collectionPolicy = Object.freeze({ version: 1, payOnPickup: true, allWorkersPay: true,
  automationDurations: Object.freeze([...collectionDurations]) });
export type CollectionItem = `collection-${Resource}-${typeof collectionDurations[number]}` | `collector-${Resource | 'all'}-${4 | 12 | 26 | 52}`;
const resourceKeys: Resource[] = ['wood', 'water', 'metal', 'oil'];
export const collectionItems: CollectionItem[] = [...resourceKeys.flatMap(resource =>
  collectionDurations.map(weeks => `collection-${resource}-${weeks}` as const)),
  ...[...resourceKeys, 'all' as const].flatMap(resource => ([4, 12, 26, 52] as const).map(weeks => `collector-${resource}-${weeks}` as const))];
export function isCollectionItem(value: unknown): value is CollectionItem {
  return typeof value === 'string' && collectionItems.some(item => item === value);
}
export function collectionItemDetails(item: CollectionItem): { resource: Resource | 'all'; weeks: number } {
  const [, resource, weeks] = item.split('-');
  return { resource: resource as Resource | 'all', weeks: Number(weeks) };
}
export function collectionItemName(item: CollectionItem): string {
  const { resource, weeks } = collectionItemDetails(item);
  return `${resource === 'all' ? 'All resources' : resource[0].toUpperCase() + resource.slice(1)} auto-collection · ${weeks} game ${weeks === 1 ? 'week' : 'weeks'}`;
}
export function collectionClaimReason(state: Snapshot, resource: Resource): string | null {
  if (state.game.stage < 0) return 'Settlement required.';
  if (state.pending[resource] < 1) return 'No completed resources to collect.';
  if (state.dollars < (state.collection?.fees[resource] ?? 0))
    return 'Not enough FTH$ for pickup. Collect and sell pays transport from the proceeds.';
  return null;
}
export function collectionReceiptQuantity(message: string | undefined, resource: Resource): number | null {
  const receipt = message?.match(/^Collected (\d+) (wood|water|metal|oil)(?:\. FTH\$ transport paid\.| from the map\. No transport fee\.)$/);
  if (!receipt || receipt[2] !== resource) return null;
  const quantity = Number(receipt[1]);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}
