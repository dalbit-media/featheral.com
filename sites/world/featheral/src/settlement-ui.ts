export const settlementTasks = {
  overview: { label: 'Settlement overview', icon: 'home' },
  residents: { label: 'Residents', icon: 'people' },
  production: { label: 'Production', icon: 'wood' },
  sell: { label: 'Sell resources', icon: 'market' },
  inventory: { label: 'Inventory', icon: 'layers' },
  crafting: { label: 'Crafting', icon: 'spark' },
  decorate: { label: 'Layout', icon: 'layers' },
  buildings: { label: 'Buildings', icon: 'warehouse' },
} as const;
export type SettlementTask = keyof typeof settlementTasks;
export const settlementDockTasks: SettlementTask[] = ['inventory', 'crafting', 'decorate'];
export function isSettlementTask(value: unknown): value is SettlementTask {
  return typeof value === 'string' && Object.hasOwn(settlementTasks, value);
}
export function settlementTaskFromHash(hash: string): SettlementTask | null {
  if (hash === '#settlement-scene' || hash === '') return null;
  if (hash === '#management') return 'overview';
  const task = hash.slice(1);
  return isSettlementTask(task) ? task : 'overview';
}
