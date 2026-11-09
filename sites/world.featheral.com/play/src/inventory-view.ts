import { canAfford, radius } from './engine.ts';
import type { Cost } from './engine.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { canCollectFinds, craftingCost, craftingFits, craftingIngredients, craftingMaximum, craftingStage, craftingStageName, craftableItems, craftableKeys, inventoryPageSize, inventoryUsed, isDecorationItem, isVisibilityItem, itemName, itemStacks, itemStorage, recipeDiscovered, sellableItemCount, visibilityItems } from './items.ts';
import { settlementPositions } from './settlement-layout.ts';
import type { ItemId } from './items.ts';
import { itemArt } from './item-art.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, activityName, isActivityItem, isAutomationItem } from './automation.ts';
import { isCustomizationItem, isTitleItem, titleItems } from './customization.ts';
import { formatResourceAmount } from './resource-units.ts';
import { activityEquipmentBenefit, activityEquipmentItems, isActivityEquipment } from './activity-equipment.ts';
import { bulkCraftingItems, craftBatchOptions, isBulkCraftingItem } from './bulk-crafting.ts';
import { marketAssetName, marketPriceAvailable } from './market.ts';
import type { MarketSnapshot } from './market.ts';
import { renderPriceChange } from './marketplace-catalog.ts';
import { formatResourcePrice } from './resource-units.ts';
import { activeMarketAnalysis, marketAnalysisFee } from './market-analysis.ts';
import type { MarketAnalysis } from './market-analysis.ts';
import { isTransportItem, transportBenefit } from './transport-items.ts';
import { isSquadItem } from './exploration-squads.ts';
import { itemDetailRows } from './item-details.ts';
import { isAutoCraftingItem } from './auto-crafting.ts';

export type InventoryFilter = 'all' | 'utility' | 'efficiency' | 'bulk' | 'decoration' | 'collectible' | 'collectors' | 'customization';
export type CraftingFilter = Exclude<InventoryFilter, 'collectible'> | 'affordable';
export function wireInventoryDetails(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-inventory-preview]')) {
    const preview = root.querySelector<HTMLElement>(`#${button.dataset.inventoryPreview}`);
    if (!preview) continue;
    const show = () => {
      if (!preview.matches(':popover-open')) preview.showPopover();
      const anchor = button.getBoundingClientRect();
      const above = Math.max(0, anchor.top - 16), below = Math.max(0, innerHeight - anchor.bottom - 16);
      const placeAbove = above > below;
      preview.style.maxHeight = `${Math.min(220, placeAbove ? above : below)}px`;
      const bounds = preview.getBoundingClientRect();
      const top = placeAbove ? anchor.top - bounds.height - 8 : anchor.bottom + 8;
      preview.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, innerWidth - bounds.width - 8))}px`;
      preview.style.top = `${Math.max(8, Math.min(top, innerHeight - bounds.height - 8))}px`;
    };
    const hide = () => { if (preview.matches(':popover-open')) preview.hidePopover(); };
    button.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') show(); });
    button.addEventListener('pointerleave', () => { if (document.activeElement !== button) hide(); });
    button.addEventListener('focus', show);
    button.addEventListener('blur', hide);
    button.addEventListener('click', show);
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape' && preview.matches(':popover-open')) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    });
  }
}
export function inventoryPanel(state: ApiState, costChips: (cost: Cost) => string, filter: InventoryFilter, language: Language, context: 'settlement' | 'explore' = 'settlement', page = 0, selection: ItemId | null = null): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage], next = itemStorage[bag.storage + 1];
  const fmt = (n: number) => n.toLocaleString(locale(language));
  const name = (id: ItemId) => translate(itemName(id), language);
  const reserved = new Map(itemStacks(bag.marketReserved ?? []).map(stack => [stack.id, stack.quantity]));
  const filtered = itemStacks([...bag.items, ...(bag.marketReserved ?? [])])
    .map(stack => ({ ...stack, reserved: reserved.get(stack.id) ?? 0, owned: stack.quantity - (reserved.get(stack.id) ?? 0), equipped: bag.equipped === stack.id || Object.values(bag.activityEquipment ?? {}).some(equipped => equipped === stack.id) }))
    .filter(({ id }) => filter === 'all' || (filter === 'utility' ? isVisibilityItem(id) || isAutomationItem(id) || isActivityEquipment(id) || isBulkCraftingItem(id) || isAutoCraftingItem(id) || isTransportItem(id) || isSquadItem(id) : filter === 'bulk' ? isBulkCraftingItem(id) || isAutoCraftingItem(id) || isSquadItem(id) : filter === 'efficiency' ? isActivityEquipment(id) || isTransportItem(id) : filter === 'decoration' ? isDecorationItem(id)
      : filter === 'collectors' ? isCollectionItem(id) : filter === 'customization' ? isCustomizationItem(id) : id.startsWith('relic-')))
    .sort((a, b) => Number(b.equipped) - Number(a.equipped));
  const pages = tier.capacity / inventoryPageSize, current = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
  const visible = filtered.slice(current * inventoryPageSize, (current + 1) * inventoryPageSize);
  const selectedStack = visible.find(slot => slot.owned > 0 && slot.id === selection) ?? visible.find(slot => slot.owned > 0);
  const selected = selectedStack?.id;
  const position = selected && isDecorationItem(selected) ? settlementPositions(game, bag)[selected] : undefined;
  return `<section class="settlement-section inventory-panel" id="inventory" aria-labelledby="inventory-title">
    <div class="settlement-section-title"><h3 id="inventory-title">${translate(tier.name, language)}</h3><strong aria-label="Inventory capacity">${fmt(inventoryUsed(bag))} / ${tier.capacity}</strong></div>
    <div class="inventory-expansion">${next ? `<span>${translate(`${next.name} · ${next.capacity} item slots`, language)}</span><button class="button" data-action="item-storage" aria-label="Expand item storage" ${game.stage < 0 || !canAfford(game, { metal: next.metal, dollars: next.dollars }) ? 'disabled' : ''}>${icon('plus')}<span>Expand storage</span>${costChips({ metal: next.metal, dollars: next.dollars })}</button>` : '<span>Maximum item storage</span>'}</div>
    <div class="inventory-filters" role="group" aria-label="Inventory filters">${([['all', 'All', 'layers', 'All items'], ['utility', 'Tools', 'tool', 'Equipment & automation'], ['efficiency', 'Savings', 'dollars', 'Cost-saving equipment'], ['bulk', 'Bulk', 'people', 'Bulk actions'], ['decoration', 'Decorations', 'home', 'Decorations'], ['collectible', 'Collectibles', 'spark', 'Collectibles'], ['collectors', 'Collectors', 'download', 'Collectors'], ['customization', 'Names', 'flag', 'Names & titles']] as const).map(([key, label, glyph, description]) => `<button class="button" data-action="inventory-filter" data-filter="${key}" aria-pressed="${key === filter}" aria-label="${translate(description, language)}" title="${translate(description, language)}">${icon(glyph)}<span>${translate(label, language)}</span></button>`).join('')}</div>
    <div class="inventory-slots" role="group" aria-label="Item slots">${Array.from({ length: inventoryPageSize }, (_, index) => {
      const slot = visible[index], number = current * inventoryPageSize + index + 1;
      if (!slot) return `<div class="inventory-slot empty" role="img" aria-label="${translate('Empty slot', language)} ${number}"></div>`;
      const label = `${name(slot.id)} · ${translate('Quantity', language)}: ${fmt(slot.quantity)}${slot.reserved ? ` · ${translate('Reserved in market', language)}: ${fmt(slot.reserved)}` : ''}${slot.equipped ? ` · ${translate('Equipped', language)}` : ''}`;
      const previewId = `inventory-preview-${slot.id}`;
      return `<button class="inventory-slot${slot.owned === 0 ? ' reserved' : ''}" data-action="${slot.owned === 0 ? 'inventory-preview' : 'inventory-select'}" data-item="${slot.id}" data-inventory-preview="${previewId}" aria-controls="${previewId}" aria-label="${label}" aria-pressed="${slot.id === selected}" ${slot.equipped ? 'data-equipped="true"' : ''}>${itemArt(slot.id)}<b class="inventory-quantity" aria-hidden="true">${fmt(slot.quantity)}</b>${slot.reserved || slot.equipped ? `<i>${icon(slot.equipped ? 'check' : 'lock')}</i>` : ''}${slot.equipped ? `<span class="inventory-equipped-label">${translate('Equipped', language)}</span>` : ''}</button>
        <aside class="inventory-preview" id="${previewId}" popover="auto" aria-label="${name(slot.id)}"><header>${itemArt(slot.id)}<div><h4>${name(slot.id)}</h4>${slot.equipped ? `<span>${icon('check')} ${translate('Equipped', language)}</span>` : ''}</div></header>${itemDetailRows(slot.id, language, sellableItemCount(bag, slot.id), slot.reserved)}</aside>`;
    }).join('')}</div>
    <nav class="inventory-pages" aria-label="Inventory pages">${Array.from({ length: pages }, (_, index) => `<button class="button" data-action="inventory-page" data-page="${index}" aria-label="${translate(`Inventory page ${index + 1} of ${pages}`, language)}" aria-current="${index === current ? 'page' : 'false'}">${index + 1}</button>`).join('')}<span>${translate(`Page ${current + 1} of ${pages}`, language)}</span></nav>
    ${selectedStack && selected ? `<article class="inventory-item-detail${isCustomizationItem(selected) ? ' customization-detail' : ''}">${itemArt(selected)}<div><h3>${name(selected)}</h3><p><span>Owned</span>: ${fmt(selectedStack.owned)}${selectedStack.reserved ? ` · <span>Reserved in market</span>: ${fmt(selectedStack.reserved)}` : ''}</p><p>${isTransportItem(selected) || isBulkCraftingItem(selected) || isAutoCraftingItem(selected) || isSquadItem(selected) ? translate('Consumes one permit', language) : isActivityEquipment(selected) ? translate(activityEquipmentBenefit(selected), language) : isCustomizationItem(selected) ? 'Consumes one permit. Cosmetic only.' : isActivityItem(selected) ? translate(activityName(activityItemDetails(selected).activity), language) : isCollectionItem(selected) ? translate(`Auto-collection for ${collectionItemDetails(selected).weeks} game weeks`, language) : isVisibilityItem(selected) ? `${visibilityItems[selected].radius}-tile view` : isDecorationItem(selected) ? position ? translate(`Placed at ${position.x}, ${position.y}`, language) : 'Not placed' : 'Exploration keepsake'}</p>
      ${isTransportItem(selected) ? `<p>${translate(transportBenefit(selected), language)}</p>` : ''}
      ${isBulkCraftingItem(selected) ? `<p>${translate(`Allows one exact batch of ${bulkCraftingItems[selected].quantity} copies. Select a recipe and click Craft to use it.`, language)}</p>` : ''}
      ${isCustomizationItem(selected) ? isTitleItem(selected) ? `<p>${translate('Player title', language)}: ${translate(titleItems[selected].title, language)}</p>` : `<label>${selected === 'permit-region-name' ? 'Region name' : 'Settlement name'}<input id="customization-${selected}" data-customization-name type="text" minlength="2" maxlength="40" autocomplete="off" required></label>` : ''}</div>
      ${isAutoCraftingItem(selected) ? '<button class="button primary" data-action="auto-craft">Review craft and sell</button>' : isActivityEquipment(selected) ? `<button class="button" data-action="activity-gear" data-activity="${activityEquipmentItems[selected].activity}" ${selectedStack.equipped ? '' : `data-item="${selected}"`}>${selectedStack.equipped ? 'Unequip' : 'Equip'}</button>` : isCustomizationItem(selected) ? `<button class="button" data-action="use-customization" data-item="${selected}">Review customization</button>` : isAutomationItem(selected) ? `<button class="button" data-action="${isActivityItem(selected) ? 'activate-activity' : 'activate-collection'}" data-item="${selected}">Activate</button>` : isVisibilityItem(selected) ? `<button class="button" data-action="${bag.equipped === selected ? 'unequip' : 'equip'}" data-item="${selected}">${bag.equipped === selected ? 'Unequip' : 'Equip'}</button>` : isDecorationItem(selected) ? context === 'explore' ? '<a class="button" href="/settlement/#decorate">Manage layout ' + icon('home') + '</a>' : `<button class="button" data-action="prepare-decoration" data-item="${selected}">Place in settlement ${icon('home')}</button>` : ''}<a class="button" href="/market/?asset=${selected}&side=sell">Trade item</a></article>` : visible.length ? '' : `<p class="inventory-page-empty">${filtered.length ? 'No items on this page yet.' : 'No items in this category yet. Craft equipment or send an expedition.'}</p>`}
    ${selectedStack && selected ? itemDetailRows(selected, language, sellableItemCount(bag, selected), selectedStack.reserved) : ''}
    ${bag.marketReserved?.length ? '<p class="notice">Open market orders reserve item slots. Cancel the order to release them.</p>' : ''}
    ${bag.pending.length ? `<div class="pending-finds"><div><h3>Pending exploration finds</h3><p>Finds stay safe here when item inventory is full. Expand storage, then collect them.</p><ul>${itemStacks(bag.pending).map(({ id, quantity }) => `<li>${name(id)} · <span>Quantity</span>: ${fmt(quantity)}</li>`).join('')}</ul></div><button class="button primary" data-action="collect-items" ${canCollectFinds(bag) ? '' : 'disabled'}>Collect finds ${icon('download')}</button></div>` : ''}
    <details class="disclosure" data-detail="inventory-help"><summary>Inventory rules ${icon('chevron')}</summary><p>Identical items share one storage slot regardless of quantity, including equipped, placed and market-reserved copies.</p><p>Each upgrade unlocks 20 item slots and one page, up to 200 slots across 10 pages.</p><p>Equipment, decorations and collectibles use item slots. Raw resources stay separate. Equipped and placed items still use one slot each.</p><p><span>Equipped visibility item</span>: <span>${bag.equipped ? name(bag.equipped) : 'No item equipped'}</span> · <span>${radius(game)}-tile view</span></p><p>Permanent equipment never burns out. Equip one item. Better gear affects new expeditions only; teams already exploring keep their launch visibility.</p></details>
    </section>`;
}
export function craftingPanel(state: ApiState, costChips: (cost: Cost) => string, filter: CraftingFilter, _context: 'settlement' | 'explore' = 'settlement', quantity = 1, language: Language = 'en', tickers: MarketSnapshot['tickers'] = [], marketReport: MarketAnalysis | null = null, now = state.serverTime, pending = false, loading = false): string {
  const { game, inventory: bag } = state, tier = itemStorage[bag.storage];
  const report = activeMarketAnalysis(marketReport, now);
  const reportItems = new Map(report?.items.map(item => [item.item, item]));
  const hoursLeft = report ? Math.max(1, Math.ceil((report.expiresAt - now) / 60000)) : 0;
  const analysisState = report ? 'active' : loading ? 'loading' : marketReport ? 'expired' : 'locked';
  const reportStatus = report ? `${hoursLeft} ${translate('game hours left', language)}`
    : loading ? translate('Loading prices...', language)
    : translate(marketReport ? 'Expired' : 'Locked', language);
  const reportDetail = report ? `${translate('Snapshot time', language)}: ${new Date(report.generatedAt).toLocaleString(locale(language), { timeZone: 'UTC' })} UTC`
    : translate(marketReport ? 'Analysis expired. Purchase a new latest-quote report.' : 'Profit analysis is locked. FTH$100 grants one game day of access.', language);
  const analysisValue = (value: number | null) => value === null ? translate('Quote unavailable', language)
    : `FTH$ ${value.toLocaleString(locale(language), { maximumFractionDigits: 2 })}`;
  const signedValue = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString(locale(language), { maximumFractionDigits: 2 })} FTH$`;
  const analysisLabel = `${translate(report ? 'Refresh analysis' : 'Get profit analysis', language)} · FTH$${marketAnalysisFee}`;
  const analysisAccess = `<section class="crafting-analysis-access" data-analysis-state="${analysisState}" aria-labelledby="crafting-analysis-title">${icon('spark')}<div class="crafting-analysis-summary" title="${reportDetail}"><strong id="crafting-analysis-title">${translate('Profit analysis', language)}</strong><span data-crafting-analysis-status role="status">${reportStatus}</span></div><button type="button" class="button" data-action="crafting-analysis" aria-label="${analysisLabel}" title="${analysisLabel}" ${pending || loading || state.dollars < marketAnalysisFee || game.stage < 0 ? 'disabled' : ''}>${icon(report ? 'refresh' : 'dollars')}<span>FTH$${marketAnalysisFee}</span></button><details class="crafting-analysis-rules"><summary aria-label="${translate('Analysis rules', language)}" title="${translate('Analysis rules', language)}">${icon('help')}</summary><p>${reportDetail}</p><p>${translate('One full-market snapshot costs FTH$100 and expires after one game day. Each refresh is charged. Profit is one-copy sale proceeds minus the crafting fee and executable purchase costs of every ingredient. The report fee is separate; prices are not reserved. Unavailable quotes are not estimated.', language)}</p></details></section>`;
  const filters = [['all', 'All items', 'grid'], ['affordable', 'Affordable', 'dollars'], ['utility', 'Equipment', 'tool'], ['efficiency', 'Cost-saving equipment', 'percent'], ['bulk', 'Bulk actions', 'layers'], ['decoration', 'Decorations', 'flower'], ['collectors', 'Collectors', 'gem'], ['customization', 'Names & titles', 'tag']] as const;
  const keys = craftableKeys.filter(id => filter === 'all' || (filter === 'affordable'
    ? game.stage >= 0 && recipeDiscovered(game, id) && craftingFits(bag, id, quantity) && quantity <= craftingMaximum(game, bag, id) && canAfford(game, craftingCost(id, quantity))
    : filter === 'utility' ? isVisibilityItem(id) || isActivityEquipment(id) || isBulkCraftingItem(id) || isAutoCraftingItem(id) || isTransportItem(id) || isSquadItem(id) : filter === 'bulk' ? isBulkCraftingItem(id) || isAutoCraftingItem(id) || isSquadItem(id) : filter === 'efficiency' ? isActivityEquipment(id) || isTransportItem(id) : filter === 'collectors' ? isCollectionItem(id) : filter === 'customization' ? isCustomizationItem(id) : isDecorationItem(id)));
  return `<section class="settlement-section" id="crafting" aria-labelledby="crafting-title"><div class="settlement-section-title"><h3 id="crafting-title">Recipes</h3><span>${inventoryUsed(bag)} / ${tier.capacity}</span></div>
    <div class="inventory-filters crafting-filters" role="group" aria-label="${translate('Crafting filters', language)}">${filters.map(([key, label, symbol]) => `<button class="button" data-action="crafting-filter" data-filter="${key}" aria-pressed="${key === filter}" aria-label="${translate(label, language)}" title="${translate(label, language)}">${icon(symbol)}</button>`).join('')}</div>
    <p class="fineprint">Click Craft to choose a batch. Owned permits allow exact batches of 10, 20, 50 or 100 copies.</p>
    <p class="fineprint">Total batch cost shown below. Nothing is spent until you confirm.</p>${analysisAccess}
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
      const snapshot = reportItems.get(id);
      const snapshotEstimate = snapshot ? `<div class="recipe-snapshot-estimate" data-snapshot-profit="${snapshot.profit === null ? 'unavailable' : snapshot.profit > 0 ? 'profit' : snapshot.profit < 0 ? 'loss' : 'even'}"><span>${translate('Profit per copy', language)}</span><strong>${snapshot.profit === null ? translate('Quote unavailable', language) : signedValue(snapshot.profit)}</strong></div>` : '';
      const snapshotDetails = snapshot ? `<p class="fineprint recipe-estimate-details">${translate('Latest snapshot · one copy', language)} · ${translate('Crafting fee', language)}: ${analysisValue(snapshot.craftingFee)} · ${translate('Total craft cost', language)}: ${analysisValue(snapshot.cost)} · ${translate('Sale proceeds', language)}: ${analysisValue(snapshot.revenue)} · ${translate('Estimated profit', language)}: ${analysisValue(snapshot.profit)}${snapshot.ingredients.map(input => ` · ${translate(marketAssetName(input.asset), language)} × ${formatResourceAmount(input.asset, input.quantity, locale(language))}: ${analysisValue(input.dollars)}`).join('')}</p>` : '';
      const amount = (asset: string, value: number) => asset === 'dollars' || Object.hasOwn(ingredients, asset)
        ? value.toLocaleString(locale(language), { maximumFractionDigits: asset === 'dollars' ? 2 : 4 }) : formatResourceAmount(asset, value, locale(language));
      return `<article class="item-card recipe-card"><div class="recipe-heading">${itemArt(id)}<div><h3>${recipe.name}</h3><small class="recipe-level">${craftingStageName(id)}</small></div></div>
      <div class="recipe-market" aria-label="${translate('Market price', language)}"><span>${translate('Sell price', language)} <strong>${ticker && marketPriceAvailable(ticker.bid) ? `${formatResourcePrice(id, ticker.bid, locale(language))} FTH$` : '—'}</strong></span>      ${ticker ? renderPriceChange(ticker, '7d', language, true) : `<small>${translate('Prices unavailable', language)}</small>`}</div>${snapshotEstimate}
      <div class="consumption-costs" aria-label="${translate('Batch cost', language)}">${costChips(cost)}${!Object.keys(cost).length ? `<small>${translate('Collector ingredients', language)} · ${Object.values(ingredients).reduce((sum, count) => sum + count, 0)}</small>` : ''}</div>
      ${availableBatch > 1 ? `<small class="recipe-bulk-hint">${translate('Maximum available batch', language)}: ${availableBatch}</small>` : ''}
      <details class="recipe-details" data-detail="recipe-${id}"><summary><span>Recipe</span>${requirements.length ? ` <strong>${ready}/${requirements.length}</strong>` : ''}${icon('chevron')}</summary>
      ${snapshotDetails}
      ${reason !== 'Craft' ? `<p class="notice">${reason}</p>` : ''}
      ${itemDetailRows(id, language)}${isActivityEquipment(id) || isBulkCraftingItem(id) || isTransportItem(id) ? '<p class="fineprint">Consumes unused decorations and collector permits. Return placed decorations to inventory first.</p>' : ''}<small><span>Batch</span>: ${quantity} · <span>Maximum available batch</span>: ${availableBatch}</small>
      ${requirements.length ? '<p class="fineprint">Ingredients: owned / required</p>' : `<p class="fineprint">${translate('No item ingredients required.', language)}</p>`}<ul class="recipe-resources">${requirements.map(row => `<li class="${row.owned >= row.needed ? 'available' : 'missing'}">${icon(row.owned >= row.needed ? 'check' : 'lock')}<span>${row.name}</span><strong>${amount(row.asset, row.owned)} / ${amount(row.asset, row.needed)}</strong><span class="recipe-resource-state">${row.owned >= row.needed ? 'Available' : 'Missing'}</span></li>`).join('')}</ul>
      <p class="fineprint">${translate('Resource costs: owned / required', language)}</p><ul class="recipe-resources recipe-cost-resources">${costs.map(row => `<li class="${row.owned >= row.needed ? 'available' : 'missing'}">${icon(row.owned >= row.needed ? 'check' : 'lock')}<span>${row.name}</span><strong>${amount(row.asset, row.owned)} / ${amount(row.asset, row.needed)}</strong><span class="recipe-resource-state">${row.owned >= row.needed ? 'Available' : 'Missing'}</span></li>`).join('')}</ul>
      </details>
      <button class="button compact-item-action ${reason === 'Craft' ? 'primary' : ''}" data-action="craft" data-item="${id}" data-action-eligible="${reason === 'Craft'}" aria-label="${translate('Craft', language)}: ${translate(recipe.name, language)} × ${quantity}${reason !== 'Craft' ? ` · ${translate(reason, language)}` : ''}" title="${reason === 'Craft' ? `${translate('Craft', language)}: ${translate(recipe.name, language)} × ${quantity}` : translate(reason, language)}" ${reason !== 'Craft' ? 'disabled' : ''}>${icon(reason === 'Craft' ? 'plus' : 'lock')}<span class="item-action-label">${translate('Craft', language)}</span><span class="action-feedback" role="status"></span></button></article>`;
    }).join('')}</div>${!keys.length ? '<p class="notice">No affordable recipes for this quantity.</p>' : ''}<details class="disclosure" data-detail="crafting-help"><summary>Crafting rules ${icon('chevron')}</summary><p>Discover each ingredient resource through exploration before crafting. Recipes spend owned raw resources. Newly crafted visibility gear equips automatically only when it improves your view. Cost-saving equipment must be equipped in inventory.</p><p>${translate('Campfire kit, Torch, Log seat and Wildflower bed require materials but no FTH$. Other recipes charge FTH$ per copy. Raw resources and FTH$ are costs, not counted item ingredients. Market sell prices are per item; seven-day changes use the same sales history as Marketplace.', language)}</p></details></section>`;
}
