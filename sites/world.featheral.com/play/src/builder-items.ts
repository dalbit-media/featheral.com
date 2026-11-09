export const builderCharter = 'builder-charter';
export const builderItems = {
  'builder-charter': { name: 'Master Builder Charter', stage: 0, cost: { wood: 200, metal: 100, dollars: 1000 } },
} as const;
export function isBuilderItem(value: unknown): value is typeof builderCharter { return value === builderCharter; }
