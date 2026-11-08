import { canAfford, radius } from './engine.ts';
import type { Cost } from './engine.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { craftingCost, craftingFits, craftingIngredients, craftingInputs, craftingMaximum, craftingStage, craftingStageName, craftableItems, craftableKeys, inventoryPageSize, inventoryUsed, isDecorationItem, isVisibilityItem, itemName, itemStacks, itemStorage, recipeDiscovered, sellableItemCount, visibilityItems } from './items.ts';
import { settlementPositions } from './settlement-layout.ts';
import type { CraftableItem, ItemId } from './items.ts';
import { itemArt } from './item-art.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, activityName, isActivityItem, isAutomationItem } from './automation.ts';
import { isCustomizationItem, isTitleItem, titleItems } from './customization.ts';
import { formatResourceAmount } from './resource-units.ts';
import { activityEquipmentBenefit, activityEquipmentItems, equipmentActivities, isActivityEquipment } from './activity-equipment.ts';
import { bulkCraftingItems, craftBatchOptions, isBulkCraftingItem } from './bulk-crafting.ts';
import { marketPriceAvailable } from './market.ts';
import type { MarketSnapshot } from './market.ts';
import { renderPriceChange } from './marketplace-catalog.ts';
import { formatResourcePrice } from './resource-units.ts';
import { isTransportItem, transportBenefit } from './transport-items.ts';

export function craftingEstimate(item: CraftableItem, quantity: number, tickers: MarketSnapshot['tickers']): { revenue: number; cost: number; net: number } | null {
  const output = tickers.find(ticker => ticker.asset === item);
  if (!output || !marketPriceAvailable(output.bid)) return null;
  const cost = craftingCost(item, quantity);
  let inputs = cost.dollars ?? 0;
  for (const [asset, amount] of [...Object.entries(cost).filter(([asset, amount]) => asset !== 'dollars' && amount > 0), ...Object.entries(craftingInputs(item, quantity))]) {
    const ticker = tickers.find(ticker => ticker.asset === asset);
    if (!ticker || !marketPriceAvailable(ticker.bid)) return null;
    inputs += ticker.bid * amount;
  }
  const revenue = Math.round(output.bid * quantity * 10000) / 10000;
  const total = Math.round(inputs * 10000) / 10000;
  if (!Number.isFinite(revenue) || !Number.isFinite(total)) return null;
  return { revenue, cost: total, net: Math.round((revenue - total) * 10000) / 10000 };
}

export type InventoryFilter = 'all' | 'utility' | 'efficiency' | 'bulk' | 'decoration' | 'collectible' | 'collectors' | 'customization';
export type CraftingFilter = Exclude<InventoryFilter, 'collectible'> | 'affordable';
export function activityEquipmentSlots(state: ApiState, language: Language): string {
  const equipped = state.inventory.activityEquipment ?? {};
  return `<section class="activity-equipment-slots" aria-label="${translate('Cost-saving equipment', language)}"><p class="fineprint">One item per activity. No stacking. Maximum discount: 50%.</p>${equipmentActivities.map(activity => {
    const item = equipped[activity];
    return `<div class="activity-equipment-slot">${item ? itemArt(item) : icon(activity === 'attraction' ? 'people' : 'compass')}<span><strong>${translate(activity === 'investigation' ? 'Investigation' : activity === 'exploration' ? 'Exploration' : 'Attraction', language)}</strong><small>${item ? `${translate(itemName(item), language)} · −${activityEquipmentItems[item].discount}%` : translate('No equipment', language)}</small></span>${item ? `<button class="button" data-action="activity-gear" data-activity="${activity}" aria-label="${translate('Unequip', language)} ${translate(itemName(item), language)}">${translate('Unequip', language)}</button>` : ''}</div>`;
  }).join('')}</section>`;
}
export function inventoryPanel(state: ApiState, costChips: (cost: Cost) => string, filter: InventoryFilter, language: Language, context: 'settlement' | 'explore' = 'settlement', page = 0, selection: ItemId | null = null): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage], next = itemStorage[bag.storage + 1];
  const fmt = (n: number) => n.toLocaleString(locale(language));
  const name = (id: ItemId) => translate(itemName(id), language);
  const reserved = new Map(itemStacks(bag.marketReserved ?? []).map(stack => [stack.id, stack.quantity]));
  const filtered = itemStacks([...bag.items, ...(bag.marketReserved ?? [])])
    .map(stack => ({ ...stack, reserved: reserved.get(stack.id) ?? 0, owned: stack.quantity - (reserved.get(stack.id) ?? 0), equipped: bag.equipped === stack.id || Object.values(bag.activityEquipment ?? {}).some(equipped => equipped === stack.id) }))
    .filter(({ id }) => filter === 'all' || (filter === 'utility' ? isVisibilityItem(id) || isAutomationItem(id) || isActivityEquipment(id) || isBulkCraftingItem(id) || isTransportItem(id) : filter === 'bulk' ? isBulkCraftingItem(id) : filter === 'efficiency' ? isActivityEquipment(id) || isTransportItem(id) : filter === 'decoration' ? isDecorationItem(id)
      : filter === 'collectors' ? isCollectionItem(id) : filter === 'customization' ? isCustomizationItem(id) : id.startsWith('relic-')));
  const pages = Math.max(1, Math.ceil(filtered.length / inventoryPageSize)), current = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
  const visible = filtered.slice(current * inventoryPageSize, (current + 1) * inventoryPageSize);
  const selectedStack = visible.find(slot => slot.owned > 0 && slot.id === selection) ?? visible.find(slot => slot.owned > 0);
  const selected = selectedStack?.id;
  const position = selected && isDecorationItem(selected) ? settlementPositions(game, bag)[selected] : undefined;
  return `<section class="settlement-section inventory-panel" id="inventory" aria-labelledby="inventory-title">
    <div class="settlement-section-title"><h3 id="inventory-title">${tier.name}</h3><strong aria-label="Inventory capacity">${fmt(inventoryUsed(bag))} / ${tier.capacity}</strong></div>
    <div class="inventory-expansion">${next ? `<span>${translate(`${next.name} · ${next.capacity} item slots`, language)}</span><button class="button" data-action="item-storage" aria-label="Expand item storage" ${game.stage < 0 || !canAfford(game, { metal: next.metal, dollars: next.dollars }) ? 'disabled' : ''}>${icon('plus')}<span>Expand storage</span>${costChips({ metal: next.metal, dollars: next.dollars })}</button>` : '<span>Maximum item storage</span>'}</div>
    ${activityEquipmentSlots(state, language)}
    <div class="inventory-filters" role="group" aria-label="Inventory filters">${([['all', 'All items'], ['utility', 'Equipment & automation'], ['efficiency', 'Cost-saving equipment'], ['bulk', 'Bulk crafting'], ['decoration', 'Decorations'], ['collectible', 'Collectibles'], ['collectors', 'Collectors'], ['customization', 'Names & titles']] as const).map(([key, label]) => `<button class="button" data-action="inventory-filter" data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join('')}</div>
    <div class="inventory-slots" role="group" aria-label="Item slots">${Array.from({ length: inventoryPageSize }, (_, index) => {
      const slot = visible[index], number = current * inventoryPageSize + index + 1;
      if (!slot) return `<div class="inventory-slot empty" role="img" aria-label="${translate('Empty slot', language)} ${number}"></div>`;
      const label = `${name(slot.id)} · ${translate('Quantity', language)}: ${fmt(slot.quantity)}${slot.reserved ? ` · ${translate('Reserved in market', language)}: ${fmt(slot.reserved)}` : ''}${slot.equipped ? ` · ${translate('Equipped', language)}` : ''}`;
      return `<button class="inventory-slot${slot.owned === 0 ? ' reserved' : ''}" data-action="inventory-select" data-item="${slot.id}" aria-label="${label}" title="${label}" aria-pressed="${slot.id === selected}" ${slot.owned === 0 ? 'disabled' : ''}>${itemArt(slot.id)}<b class="inventory-quantity" aria-hidden="true">${fmt(slot.quantity)}</b>${slot.reserved || slot.equipped ? `<i>${icon(slot.equipped ? 'check' : 'lock')}</i>` : ''}</button>`;
    }).join('')}</div>
    <nav class="inventory-pages" aria-label="Inventory pages">${Array.from({ length: pages }, (_, index) => `<button class="button" data-action="inventory-page" data-page="${index}" aria-label="${translate(`Inventory page ${index + 1} of ${pages}`, language)}" aria-current="${index === current ? 'page' : 'false'}">${index + 1}</button>`).join('')}<span>${translate(`Page ${current + 1} of ${pages}`, language)}</span></nav>
    ${selectedStack && selected ? `<article class="inventory-item-detail${isCustomizationItem(selected) ? ' customization-detail' : ''}">${itemArt(selected)}<div><h3>${name(selected)}</h3><p><span>Owned</span>: ${fmt(selectedStack.owned)}${selectedStack.reserved ? ` · <span>Reserved in market</span>: ${fmt(selectedStack.reserved)}` : ''}</p><p>${isTransportItem(selected) || isBulkCraftingItem(selected) ? translate('Consumes one permit', language) : isActivityEquipment(selected) ? translate(activityEquipmentBenefit(selected), language) : isCustomizationItem(selected) ? 'Consumes one permit. Cosmetic only.' : isActivityItem(selected) ? translate(activityName(activityItemDetails(selected).activity), language) : isCollectionItem(selected) ? translate(`Auto-collection for ${collectionItemDetails(selected).weeks} game weeks`, language) : isVisibilityItem(selected) ? `${visibilityItems[selected].radius}-tile view` : isDecorationItem(selected) ? position ? translate(`Placed at ${position.x}, ${position.y}`, language) : 'Not placed' : 'Exploration keepsake'}</p>
      ${isTransportItem(selected) ? `<p>${translate(transportBenefit(selected), language)}</p>` : ''}
      ${isBulkCraftingItem(selected) ? `<p>${translate(`Allows one exact batch of ${bulkCraftingItems[selected].quantity} copies. Select a recipe and click Craft to use it.`, language)}</p>` : ''}
      ${isCustomizationItem(selected) ? isTitleItem(selected) ? `<p>${translate('Player title', language)}: ${translate(titleItems[selected].title, language)}</p>` : `<label>${selected === 'permit-region-name' ? 'Region name' : 'Settlement name'}<input id="customization-${selected}" data-customization-name type="text" minlength="2" maxlength="40" autocomplete="off" required></label>` : ''}</div>
      ${isActivityEquipment(selected) ? `<button class="button" data-action="activity-gear" data-activity="${activityEquipmentItems[selected].activity}" ${selectedStack.equipped ? '' : `data-item="${selected}"`}>${selectedStack.equipped ? 'Unequip' : 'Equip'}</button>` : isCustomizationItem(selected) ? `<button class="button" data-action="use-customization" data-item="${selected}">Review customization</button>` : isAutomationItem(selected) ? `<button class="button" data-action="${isActivityItem(selected) ? 'activate-activity' : 'activate-collection'}" data-item="${selected}">Activate</button>` : isVisibilityItem(selected) ? `<button class="button" data-action="${bag.equipped === selected ? 'unequip' : 'equip'}" data-item="${selected}">${bag.equipped === selected ? 'Unequip' : 'Equip'}</button>` : isDecorationItem(selected) ? context === 'explore' ? '<a class="button" href="/settlement/#decorate">Manage layout ' + icon('home') + '</a>' : `<button class="button" data-action="prepare-decoration" data-item="${selected}">Place in settlement ${icon('home')}</button>` : ''}<a class="button" href="/market/?asset=${selected}&side=sell">Trade item</a></article>` : visible.length ? '' : `<p class="inventory-page-empty">${filtered.length ? 'No items on this page yet.' : 'No items in this category yet. Craft equipment or send an expedition.'}</p>`}
    ${bag.marketReserved?.length ? '<p class="notice">Open market orders reserve item slots. Cancel the order to release them.</p>' : ''}
    ${bag.pending.length ? `<div class="pending-finds"><div><h3>Pending exploration finds</h3><p>Finds stay safe here when item inventory is full. Expand storage, then collect them.</p><ul>${itemStacks(bag.pending).map(({ id, quantity }) => `<li>${name(id)} · <span>Quantity</span>: ${fmt(quantity)}</li>`).join('')}</ul></div><button class="button primary" data-action="collect-items" ${inventoryUsed(bag) >= tier.capacity || bag.pending.every(id => !isAutomationItem(id) && !isCustomizationItem(id) && bag.marketReserved?.includes(id)) ? 'disabled' : ''}>Collect finds ${icon('download')}</button></div>` : ''}
    <details class="disclosure" data-detail="inventory-help"><summary>Inventory rules ${icon('chevron')}</summary><p>Identical items share a displayed stack with a quantity. Each copy still uses one storage slot, including equipped, placed and market-reserved copies.</p><p>Pages show up to 20 item stacks. Storage upgrades add capacity for 20 copies, not unlimited stacks.</p><p>Equipment, decorations and collectibles use item slots. Raw resources stay separate. Equipped and placed items still use one slot each.</p><p><span>Equipped visibility item</span>: <span>${bag.equipped ? name(bag.equipped) : 'No item equipped'}</span> · <span>${radius(game)}-tile view</span></p><p>Permanent equipment never burns out. Equip one item. Better gear affects new expeditions only; teams already exploring keep their launch visibility.</p></details>
    </section>`;
}
export function craftingPanel(state: ApiState, costChips: (cost: Cost) => string, filter: CraftingFilter, _context: 'settlement' | 'explore' = 'settlement', quantity = 1, language: Language = 'en', tickers: MarketSnapshot['tickers'] = []): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage];
  const keys = craftableKeys.filter(id => filter === 'all' || (filter === 'affordable'
    ? game.stage >= 0 && recipeDiscovered(game, id) && craftingFits(bag, id, quantity) && quantity <= craftingMaximum(game, bag, id) && canAfford(game, craftingCost(id, quantity))
    : filter === 'utility' ? isVisibilityItem(id) || isActivityEquipment(id) || isBulkCraftingItem(id) || isTransportItem(id) : filter === 'bulk' ? isBulkCraftingItem(id) : filter === 'efficiency' ? isActivityEquipment(id) || isTransportItem(id) : filter === 'collectors' ? isCollectionItem(id) : filter === 'customization' ? isCustomizationItem(id) : isDecorationItem(id)));
  return `<section class="settlement-section" id="crafting" aria-labelledby="crafting-title"><div class="settlement-section-title"><h3 id="crafting-title">Recipes</h3><span>${inventoryUsed(bag)} / ${tier.capacity}</span></div>
    <div class="inventory-filters" role="group" aria-label="Crafting filters">${([['all', 'All items'], ['affordable', 'Affordable'], ['utility', 'Equipment'], ['efficiency', 'Cost-saving equipment'], ['bulk', 'Bulk crafting'], ['decoration', 'Decorations'], ['collectors', 'Collectors'], ['customization', 'Names & titles']] as const).map(([key, label]) => `<button class="button" data-action="crafting-filter" data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join('')}</div>
    <p class="fineprint">Click Craft to choose a batch. Owned permits allow exact batches of 10, 20, 50 or 100 copies.</p>
    <p class="fineprint">Total batch cost shown below. Nothing is spent until you confirm.</p>
    ${inventoryUsed(bag) >= tier.capacity ? '<div class="notice"><span>Item inventory full</span><span>Combining collectors can free item slots.</span><button class="button" data-settlement-panel="inventory">Expand item storage</button></div>' : ''}
    <div class="item-grid craft-grid">${keys.map(id => {
      const recipe = craftableItems[id], discovered = recipeDiscovered(game, id), cost = craftingCost(id, quantity);
      const maximum = craftingMaximum(game, bag, id), ingredients = craftingIngredients(id, quantity);
      const options = craftBatchOptions(game, bag, id), availableBatch = Math.max(0, ...options.filter(option => !option.reason).map(option => option.quantity));
      const reason = game.stage < 0 ? 'Settlement required.' : game.stage < craftingStage(id) ? `Requires ${craftingStageName(id)} civilization level.` : !discovered ? 'Discover ingredients first' : !craftingFits(bag, id, quantity) ? 'Item inventory full'
        : !canAfford(game, cost) ? 'Not enough resources' : quantity > maximum ? isActivityEquipment(id) || isBulkCraftingItem(id) || isTransportItem(id) ? 'Not enough unused ingredients' : 'Not enough collector items' : 'Craft';
      const costs = Object.entries(cost).filter(([, needed]) => needed > 0).map(([resource, needed]) => ({
          name: resource === 'dollars' ? 'FTH$' : resource[0].toUpperCase() + resource.slice(1),
          asset: resource,
          owned: resource === 'dollars' ? state.dollars : game.stock[resource as keyof typeof game.stock], needed,
        }));
      const requirements = Object.entries(ingredients).map(([item, needed]) => ({ name: itemName(item as ItemId), asset: item, owned: sellableItemCount(bag, item as ItemId), needed }));
      const ready = requirements.filter(row => row.owned >= row.needed).length;
      const ticker = tickers.find(ticker => ticker.asset === id);
      const estimate = craftingEstimate(id, quantity, tickers);
      const money = (value: number) => Math.abs(value).toLocaleString(locale(language), { maximumFractionDigits: 4 });
      const estimateLabel = estimate ? estimate.net > 0 ? 'Estimated profit' : estimate.net < 0 ? 'Estimated loss' : 'Estimated break-even' : 'Estimate unavailable';
      const estimateExplanation = translate('Uses current sell quotes for output and all consumed resources/items, plus FTH$ fees. Includes any batch permit. Prices can change; liquidity and execution are not guaranteed.', language);
      const amount = (asset: string, value: number) => asset === 'dollars' || Object.hasOwn(ingredients, asset)
        ? value.toLocaleString(locale(language), { maximumFractionDigits: 4 }) : formatResourceAmount(asset, value, locale(language));
      return `<article class="item-card recipe-card"><div class="recipe-heading">${itemArt(id)}<div><h3>${recipe.name}</h3><small class="recipe-level">${craftingStageName(id)}</small></div></div>
      <div class="recipe-market" aria-label="${translate('Market price', language)}"><span>${translate('Sell price', language)} <strong>${ticker && marketPriceAvailable(ticker.bid) ? `${formatResourcePrice(id, ticker.bid, locale(language))} FTH$` : '—'}</strong></span>${ticker ? renderPriceChange(ticker, '7d', language, true) : `<small>${translate('Prices unavailable', language)}</small>`}</div>
      <div class="recipe-estimate" data-profit="${estimate ? estimate.net > 0 ? 'profit' : estimate.net < 0 ? 'loss' : 'even' : 'unavailable'}" title="${estimateExplanation}"><span>${translate(estimateLabel, language)}</span><strong>${estimate ? `${estimate.net > 0 ? '+' : estimate.net < 0 ? '−' : ''}${money(estimate.net)} FTH$` : '—'}</strong></div>
      <div class="consumption-costs" aria-label="${translate('Batch cost', language)}">${costChips(cost)}${!Object.keys(cost).length ? `<small>${translate('Collector ingredients', language)} · ${Object.values(ingredients).reduce((sum, count) => sum + count, 0)}</small>` : ''}</div>
      ${availableBatch > 1 ? `<small class="recipe-bulk-hint">${translate('Maximum available batch', language)}: ${availableBatch}</small>` : ''}
      <details class="recipe-details" data-detail="recipe-${id}"><summary><span>Recipe</span>${requirements.length ? ` <strong>${ready}/${requirements.length}</strong>` : ''}${icon('chevron')}</summary>
      <p class="fineprint recipe-estimate-details">${estimateExplanation}${estimate ? ` ${translate('Estimated revenue', language)}: ${money(estimate.revenue)} FTH$ · ${translate('Estimated input value and fees', language)}: ${money(estimate.cost)} FTH$ · ${translate('Batch', language)}: ${quantity}` : ` ${translate('A sell quote is required for the output and every consumed input.', language)}`}</p>
      ${reason !== 'Craft' ? `<p class="notice">${reason}</p>` : ''}
      <p>${isTransportItem(id) ? translate(transportBenefit(id), language) : isBulkCraftingItem(id) ? translate(`Allows one exact batch of ${bulkCraftingItems[id].quantity} copies. Select a recipe and click Craft to use it.`, language) : isActivityEquipment(id) ? translate(activityEquipmentBenefit(id), language) : isCollectionItem(id) ? 'Combines collector permits without increasing total collection time.' : isCustomizationItem(id) ? 'Consumes one permit. Cosmetic only.' : isVisibilityItem(id) ? `${visibilityItems[id].radius}-tile view` : 'Cosmetic decoration'}</p>${isActivityEquipment(id) || isBulkCraftingItem(id) || isTransportItem(id) ? '<p class="fineprint">Consumes unused decorations and collector permits. Return placed decorations to inventory first.</p>' : ''}<small><span>Batch</span>: ${quantity} · <span>Maximum available batch</span>: ${availableBatch}</small>
      ${requirements.length ? '<p class="fineprint">Ingredients: owned / required</p>' : `<p class="fineprint">${translate('No item ingredients required.', language)}</p>`}<ul class="recipe-resources">${requirements.map(row => `<li class="${row.owned >= row.needed ? 'available' : 'missing'}">${icon(row.owned >= row.needed ? 'check' : 'lock')}<span>${row.name}</span><strong>${amount(row.asset, row.owned)} / ${amount(row.asset, row.needed)}</strong><span class="recipe-resource-state">${row.owned >= row.needed ? 'Available' : 'Missing'}</span></li>`).join('')}</ul>
      <p class="fineprint">${translate('Resource costs: owned / required', language)}</p><ul class="recipe-resources recipe-cost-resources">${costs.map(row => `<li class="${row.owned >= row.needed ? 'available' : 'missing'}">${icon(row.owned >= row.needed ? 'check' : 'lock')}<span>${row.name}</span><strong>${amount(row.asset, row.owned)} / ${amount(row.asset, row.needed)}</strong><span class="recipe-resource-state">${row.owned >= row.needed ? 'Available' : 'Missing'}</span></li>`).join('')}</ul>
      </details>
      <button class="button compact-item-action ${reason === 'Craft' ? 'primary' : ''}" data-action="craft" data-item="${id}" data-action-eligible="${reason === 'Craft'}" aria-label="${translate('Craft', language)}: ${translate(recipe.name, language)} × ${quantity}${reason !== 'Craft' ? ` · ${translate(reason, language)}` : ''}" title="${reason === 'Craft' ? `${translate('Craft', language)}: ${translate(recipe.name, language)} × ${quantity}` : translate(reason, language)}" ${reason !== 'Craft' ? 'disabled' : ''}>${icon(reason === 'Craft' ? 'plus' : 'lock')}<span class="action-feedback" role="status"></span></button></article>`;
    }).join('')}</div>${!keys.length ? '<p class="notice">No affordable recipes for this quantity.</p>' : ''}<details class="disclosure" data-detail="crafting-help"><summary>Crafting rules ${icon('chevron')}</summary><p>Discover each ingredient resource through exploration before crafting. Recipes spend owned raw resources. Newly crafted visibility gear equips automatically only when it improves your view. Cost-saving equipment must be equipped in inventory.</p><p>${translate('Every crafted copy costs FTH$. Raw resources and FTH$ are costs, not counted item ingredients. Market sell prices are per item; seven-day changes use the same sales history as Marketplace.', language)}</p></details></section>`;
}
