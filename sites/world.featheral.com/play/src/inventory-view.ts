import { canAfford, radius } from './engine.ts';
import type { Cost } from './engine.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { craftableItems, craftableKeys, inventoryPageSize, inventoryUsed, isDecorationItem, isVisibilityItem, itemName, itemStorage, recipeDiscovered, visibilityItems } from './items.ts';
import { settlementPositions } from './settlement-layout.ts';
import type { ItemId } from './items.ts';
import { itemArt } from './item-art.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, activityName, isActivityItem, isAutomationItem } from './automation.ts';

export type InventoryFilter = 'all' | 'utility' | 'decoration' | 'collectible';
export type CraftingFilter = Exclude<InventoryFilter, 'collectible'>;
export function inventoryPanel(state: ApiState, costChips: (cost: Cost) => string, filter: InventoryFilter, language: Language, context: 'settlement' | 'explore' = 'settlement', page = 0, selection: ItemId | null = null): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage], next = itemStorage[bag.storage + 1];
  const fmt = (n: number) => n.toLocaleString(locale(language));
  const name = (id: ItemId) => translate(itemName(id), language);
  const filtered = [...bag.items.map((id, index) => ({ id, reserved: false, equipped: bag.equipped === id && bag.items.indexOf(id) === index })), ...(bag.marketReserved ?? []).map(id => ({ id, reserved: true, equipped: false }))]
    .filter(({ id }) => filter === 'all' || (filter === 'utility' ? isVisibilityItem(id) || isAutomationItem(id) : filter === 'decoration' ? isDecorationItem(id) : id.startsWith('relic-')));
  const pages = tier.capacity / inventoryPageSize, current = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
  const visible = filtered.slice(current * inventoryPageSize, (current + 1) * inventoryPageSize);
  const selected = visible.find(slot => !slot.reserved && slot.id === selection)?.id ?? visible.find(slot => !slot.reserved)?.id;
  const position = selected && isDecorationItem(selected) ? settlementPositions(game, bag)[selected] : undefined;
  return `<section class="settlement-section inventory-panel" id="inventory" aria-labelledby="inventory-title">
    <div class="settlement-section-title"><h3 id="inventory-title">${tier.name}</h3><strong aria-label="Inventory capacity">${fmt(inventoryUsed(bag))} / ${tier.capacity}</strong></div>
    <div class="inventory-expansion">${next ? `<span>${translate(`${next.name} · ${next.capacity} item slots`, language)}</span><button class="button" data-action="item-storage" aria-label="Expand item storage" ${game.stage < 0 || !canAfford(game, { metal: next.metal, dollars: next.dollars }) ? 'disabled' : ''}>${icon('plus')}<span>Add page</span>${costChips({ metal: next.metal, dollars: next.dollars })}</button>` : '<span>Maximum item storage</span>'}</div>
    <div class="inventory-filters" role="group" aria-label="Inventory filters">${([['all', 'All items'], ['utility', 'Equipment & automation'], ['decoration', 'Decorations'], ['collectible', 'Collectibles']] as const).map(([key, label]) => `<button class="button" data-action="inventory-filter" data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join('')}</div>
    <div class="inventory-slots" role="group" aria-label="Item slots">${Array.from({ length: inventoryPageSize }, (_, index) => {
      const slot = visible[index], number = current * inventoryPageSize + index + 1;
      if (!slot) return `<div class="inventory-slot empty" role="img" aria-label="${translate('Empty slot', language)} ${number}"></div>`;
      const status = slot.reserved ? 'Reserved in market' : slot.equipped ? 'Equipped' : null;
      const label = `${name(slot.id)}${status ? ` · ${translate(status, language)}` : ''}`;
      return `<button class="inventory-slot${slot.reserved ? ' reserved' : ''}" data-action="inventory-select" data-item="${slot.id}" aria-label="${label}" title="${label}" aria-pressed="${slot.id === selected}" ${slot.reserved ? 'disabled' : ''}>${itemArt(slot.id)}${slot.reserved || slot.equipped ? `<i>${icon(slot.reserved ? 'lock' : 'check')}</i>` : ''}</button>`;
    }).join('')}</div>
    <nav class="inventory-pages" aria-label="Inventory pages">${Array.from({ length: pages }, (_, index) => `<button class="button" data-action="inventory-page" data-page="${index}" aria-label="${translate(`Inventory page ${index + 1} of ${pages}`, language)}" aria-current="${index === current ? 'page' : 'false'}">${index + 1}</button>`).join('')}<span>${translate(`Page ${current + 1} of ${pages}`, language)}</span></nav>
    ${selected ? `<article class="inventory-item-detail">${itemArt(selected)}<div><h3>${name(selected)}</h3><p>${isActivityItem(selected) ? translate(activityName(activityItemDetails(selected).activity), language) : isCollectionItem(selected) ? translate(`Auto-collection for ${collectionItemDetails(selected).weeks} game weeks`, language) : isVisibilityItem(selected) ? `${visibilityItems[selected].radius}-tile view` : isDecorationItem(selected) ? position ? translate(`Placed at ${position.x}, ${position.y}`, language) : 'Not placed' : 'Exploration keepsake'}</p></div>${isAutomationItem(selected) ? `<button class="button" data-action="${isActivityItem(selected) ? 'activate-activity' : 'activate-collection'}" data-item="${selected}">Activate</button>` : isVisibilityItem(selected) ? `<button class="button" data-action="${bag.equipped === selected ? 'unequip' : 'equip'}" data-item="${selected}">${bag.equipped === selected ? 'Unequip' : 'Equip'}</button>` : isDecorationItem(selected) ? context === 'explore' ? '<a class="button" href="/settlement/#decorate">Manage layout ' + icon('home') + '</a>' : `<button class="button" data-action="prepare-decoration" data-item="${selected}">Place in settlement ${icon('home')}</button>` : ''}</article>` : visible.length ? '' : `<p class="inventory-page-empty">${filtered.length ? 'No items on this page yet.' : 'No items in this category yet. Craft equipment or send an expedition.'}</p>`}
    ${bag.marketReserved?.length ? '<p class="notice">Open market orders reserve item slots. Cancel the order to release them.</p>' : ''}
    ${bag.pending.length ? `<div class="pending-finds"><div><h3>Pending exploration finds</h3><p>Finds stay safe here when item inventory is full. Expand storage, then collect them.</p><ul>${bag.pending.map(id => `<li>${name(id)}</li>`).join('')}</ul></div><button class="button primary" data-action="collect-items" ${inventoryUsed(bag) >= tier.capacity || bag.pending.every(id => !isAutomationItem(id) && bag.marketReserved?.includes(id)) ? 'disabled' : ''}>Collect finds ${icon('download')}</button></div>` : ''}
    <details class="disclosure" data-detail="inventory-help"><summary>Inventory rules ${icon('chevron')}</summary><p>Each page holds 20 slots. Storage upgrades add one page.</p><p>Equipment, decorations and collectibles use item slots. Raw resources stay separate. Equipped and placed items still use one slot each.</p><p><span>Equipped visibility item</span>: <span>${bag.equipped ? name(bag.equipped) : 'No item equipped'}</span> · <span>${radius(game)}-tile view</span></p><p>Permanent equipment never burns out. Equip one item. Better gear affects new expeditions only; teams already exploring keep their launch visibility.</p></details>
    </section>`;
}
export function craftingPanel(state: ApiState, costChips: (cost: Cost) => string, filter: CraftingFilter, _context: 'settlement' | 'explore' = 'settlement'): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage];
  const keys = craftableKeys.filter(id => filter === 'all' || (filter === 'utility' ? isVisibilityItem(id) : isDecorationItem(id)));
  return `<section class="settlement-section" id="crafting" aria-labelledby="crafting-title"><div class="settlement-section-title"><h3 id="crafting-title">Recipes</h3><span>${inventoryUsed(bag)} / ${tier.capacity}</span></div>
    <div class="inventory-filters" role="group" aria-label="Crafting filters">${([['all', 'All items'], ['utility', 'Visibility equipment'], ['decoration', 'Decorations']] as const).map(([key, label]) => `<button class="button" data-action="crafting-filter" data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join('')}</div>
    ${inventoryUsed(bag) >= tier.capacity ? '<div class="notice"><span>Item inventory full</span><button class="button" data-settlement-panel="inventory">Expand item storage</button></div>' : ''}
    <div class="item-grid">${keys.map(id => {
      const recipe = craftableItems[id], discovered = recipeDiscovered(game, id);
      const reason = game.stage < 0 ? 'Settlement required.' : !discovered ? 'Discover ingredients first' : inventoryUsed(bag) >= tier.capacity ? 'Item inventory full' : !canAfford(game, recipe.cost) ? 'Not enough resources' : 'Craft';
      return `<article class="item-card recipe-card">${itemArt(id)}<h3>${recipe.name}</h3><p>${isVisibilityItem(id) ? `${visibilityItems[id].radius}-tile view` : 'Cosmetic decoration'}</p><div class="upgrade-cost">${costChips(recipe.cost)}</div><button class="button wide ${reason === 'Craft' ? 'primary' : ''}" data-action="craft" data-item="${id}" ${reason !== 'Craft' ? 'disabled' : ''}>${reason} ${icon(reason === 'Craft' ? 'plus' : 'lock')}</button></article>`;
    }).join('')}</div><details class="disclosure" data-detail="crafting-help"><summary>Crafting rules ${icon('chevron')}</summary><p>Discover each ingredient resource through exploration before crafting. Recipes spend owned raw resources. Newly crafted gear equips automatically only when it improves your view.</p></details></section>`;
}
