import { collectionItemName } from './collection.ts';
import type { CollectionItem } from './collection.ts';
import type { Cost, Resource } from './engine.ts';

export const bundleDurations = [4, 12, 26, 52] as const;
export type CollectorBundle = `collector-${Resource | 'all'}-${typeof bundleDurations[number]}`;
const resources: Resource[] = ['wood', 'water', 'metal', 'oil'];
function ingredients(resource: Resource, weeks: typeof bundleDurations[number]): Partial<Record<CollectionItem, number>> {
  if (weeks === 4) return { [`collection-${resource}-1`]: 4 };
  if (weeks === 12) return { [`collection-${resource}-4`]: 3 };
  if (weeks === 26) return { [`collection-${resource}-12`]: 2, [`collection-${resource}-1`]: 2 };
  return { [`collection-${resource}-12`]: 4, [`collection-${resource}-4`]: 1 };
}
export const collectorRecipes: Record<CollectorBundle, { name: string; cost: Cost; ingredients: Partial<Record<CollectionItem, number>> }> =
  Object.fromEntries([...resources, 'all' as const].flatMap(resource => bundleDurations.map(weeks => {
    const id: CollectorBundle = `collector-${resource}-${weeks}`;
    return [id, { name: collectionItemName(id), cost: {},
      ingredients: Object.assign({}, ...(resource === 'all' ? resources : [resource]).map(asset => ingredients(asset, weeks))) }];
  }))) as Record<CollectorBundle, { name: string; cost: Cost; ingredients: Partial<Record<CollectionItem, number>> }>;
