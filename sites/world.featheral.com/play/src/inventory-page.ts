import { icon } from './icons.ts';
import { translate } from './i18n.ts';
import type { Language } from './i18n.ts';

export const inventoryTabs = ['inventory', 'craft', 'enhance'] as const;
export type InventoryTab = typeof inventoryTabs[number];
export function inventoryTabFromHash(hash: string): InventoryTab {
  return hash === '#craft' || hash === '#crafting' ? 'craft' : hash === '#enhance' ? 'enhance' : 'inventory';
}
export function inventoryPageFrame(tab: InventoryTab, content: string, language: Language): string {
  const t = (text: string) => translate(text, language);
  const tabs = [['inventory', 'Inventory', 'inventory'], ['craft', 'Craft', 'tool'], ['enhance', 'Enhance', 'spark']] as const;
  return `<header class="inventory-page-heading"><h1>${icon('inventory')}${t('Inventory')}</h1>
    <nav class="inventory-tabs" aria-label="${t('Inventory sections')}">${tabs.map(([key, label, glyph]) =>
      `<a class="button" href="#${key}" ${key === tab ? 'aria-current="page"' : ''}>${icon(glyph)}${t(label)}</a>`).join('')}</nav>
    <a class="button inventory-market-link" href="/market/">${icon('market')}<span>${t('Market')}</span></a></header>
    <div class="inventory-page-body" data-inventory-tab="${tab}">${content}</div>`;
}
