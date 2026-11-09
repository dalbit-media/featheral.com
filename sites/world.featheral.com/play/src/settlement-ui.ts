import { icon } from './icons.ts';
import { translate } from './i18n.ts';
import type { Language } from './i18n.ts';

export const settlementTasks = {
  overview: { label: 'Settlement overview', icon: 'home', description: 'Your next tier, resource reserves and active field teams.' },
  residents: { label: 'Residents', icon: 'people', description: 'Balance available residents, production crews and returning missions.' },
  production: { label: 'Production', icon: 'wood', description: 'Check storage, assign crews and collect completed deliveries.' },
  sell: { label: 'Sell resources', icon: 'market', description: 'Preview proceeds and keep enough supplies for daily upkeep.' },
  inventory: { label: 'Inventory', icon: 'layers', description: 'Inspect item effects, equip tools and manage available copies.' },
  crafting: { label: 'Crafting', icon: 'tool', description: 'Compare recipes and requirements before reviewing a craft.' },
  decorate: { label: 'Layout', icon: 'grid', description: 'Inspect and arrange owned objects. Moving is free.' },
  buildings: { label: 'Buildings', icon: 'warehouse', description: 'Compare current benefits, next-level effects and missing supplies.' },
} as const;
export type SettlementTask = keyof typeof settlementTasks;
export const settlementDockTasks: SettlementTask[] = ['inventory', 'crafting', 'decorate'];
export function isSettlementTask(value: unknown): value is SettlementTask {
  return typeof value === 'string' && Object.hasOwn(settlementTasks, value);
}
export function settlementSectionNavigation(current: SettlementTask | null, language: Language): string {
  return `<nav class="settlement-panel-navigation" aria-label="${translate('Settlement sections', language)}">${(Object.keys(settlementTasks) as SettlementTask[]).map(task => `<button type="button" data-settlement-panel="${task}" aria-controls="settlement-task-panel" aria-pressed="${task === current}">${icon(settlementTasks[task].icon)}<span>${translate(settlementTasks[task].label, language)}</span></button>`).join('')}</nav>`;
}
export function settlementTaskFromHash(hash: string): SettlementTask | null {
  if (hash === '#settlement-scene' || hash === '') return null;
  if (hash === '#management') return 'overview';
  const task = hash.slice(1);
  return isSettlementTask(task) ? task : 'overview';
}
