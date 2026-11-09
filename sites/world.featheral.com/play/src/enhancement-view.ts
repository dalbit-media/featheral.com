import type { ApiState } from './api-types.ts';
import type { Cost } from './engine.ts';
import type { Language } from './i18n.ts';
import { locale, translate } from './i18n.ts';
import { enhancementQuote } from './enhancement.ts';
import type { EnhancedEquipment } from './enhancement.ts';
import { activityEquipmentItems, isActivityEquipment } from './activity-equipment.ts';
import { itemName, itemStacks } from './items.ts';
import { itemArt } from './item-art.ts';
import { icon } from './icons.ts';
import type { MarketSnapshot } from './market.ts';
import { formatDollars } from './dollars.ts';

const escape = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function equipped(state: ApiState, copy: EnhancedEquipment): boolean {
  return state.inventory.enhancedEquipped?.[activityEquipmentItems[copy.item].activity] === copy.id;
}
export function enhancedInventoryPanel(state: ApiState, language: Language): string {
  const t = (text: string) => translate(text, language);
  const copies = [...(state.inventory.enhancedEquipment ?? [])].sort((a, b) => Number(equipped(state, b)) - Number(equipped(state, a)));
  if (!copies.length) return '';
  return `<section class="enhanced-owned" aria-label="${t('Enhanced equipment')}"><h2>${t('Enhanced equipment')}</h2><div class="enhancement-items">${copies.map(copy => {
    const active = equipped(state, copy), quote = enhancementQuote(state.game, state.inventory, copy.id);
    return `<article class="enhanced-owned-card"><header>${itemArt(copy.item)}<div><h3>${t(itemName(copy.item))} +${copy.level}</h3><small>${active ? `${t('Equipped')} · ` : ''}${quote.discount.toFixed(2)}% ${t('Fee savings')}</small></div>${active ? icon('check') : ''}</header>
      <small class="enhanced-copy-id">${copy.id}</small><div class="panel-actions"><button class="button" data-action="enhanced-gear" data-copy="${copy.id}" data-activity="${activityEquipmentItems[copy.item].activity}" ${active ? 'data-unequip' : ''}>${t(active ? 'Unequip' : 'Equip')}</button><button class="button" data-action="enhance-select" data-copy="${copy.id}">${icon('spark')}${t('Enhance')}</button></div></article>`;
  }).join('')}</div></section>`;
}
export function enhancementPanel(state: ApiState, selection: string | null, market: MarketSnapshot | null, loading: boolean, error: string,
  pending: boolean, language: Language, costChips: (cost: Cost) => string): string {
  const t = (text: string) => translate(text, language);
  const copies = [...(state.inventory.enhancedEquipment ?? [])].sort((a, b) => Number(equipped(state, b)) - Number(equipped(state, a)));
  const ordinary = itemStacks(state.inventory.items).filter(stack => isActivityEquipment(stack.id));
  const targets = [...copies.map(copy => ({ target: copy.id, item: copy.item, level: copy.level, active: equipped(state, copy), quantity: 1 })),
    ...ordinary.flatMap(stack => isActivityEquipment(stack.id) ? [{ target: stack.id, item: stack.id, level: 0, active: false, quantity: stack.quantity }] : [])];
  const selected = targets.find(target => target.target === selection) ?? targets[0];
  const quote = selected ? enhancementQuote(state.game, state.inventory, selected.target) : null;
  const copy = copies.find(copy => copy.id === selected?.target);
  const listings = market?.enhancedListings ?? [];
  return `<div class="enhancement-intro"><p>${t('Refine permanent fee-saving equipment. Every attempt has a cost, even on failure.')}</p><a class="button" href="#craft">${itemArt('refinement-core')}${t('Craft cores')}</a></div>
    <div class="enhancement-layout"><section class="enhancement-picker"><h2>${t('Choose equipment')}</h2><div class="enhancement-items">${targets.map(target => `<button class="enhancement-item" data-action="enhance-select" data-copy="${target.target}" aria-pressed="${target.target === selected?.target}">${itemArt(target.item)}<span><strong>${t(itemName(target.item))}</strong><small>${target.active ? `${t('Equipped')} · ` : ''}${target.target === target.item ? `${t('Ordinary copies')}: ${target.quantity}` : `${t('Level')} ${target.level}`}</small></span></button>`).join('')}</div>
    ${!targets.length ? `<p class="fineprint">${t('Craft or buy fee-saving equipment to begin.')}</p><a class="button" href="#craft">${t('Craft')}</a>` : ''}
    <details class="disclosure" data-detail="enhancement-rules"><summary>${t('Enhancement rules')} ${icon('chevron')}</summary>
    <p>${t('Each successful level adds 0.1% of the original discount, not 0.1 percentage points. Savings are capped at 99%.')}</p>
    <p>${t('Up to 1,000 levels. Success starts at 90% and falls to a 10% floor. Costs grow with the current level.')}</p>
    <p>${t('One attempt only. The server determines the result after confirmation.')}</p>
    <p>${t('Enhanced copies keep their identity and level when traded. New actions only; paid jobs stay unchanged.')}</p></details></section>
    <section class="enhancement-detail" aria-label="${t('Enhancement preview')}">${selected && quote ? `<header>${itemArt(selected.item)}<div><h2>${t(itemName(selected.item))}</h2><small>${t('Level')} ${quote.level} / 1,000</small></div></header>
      ${copy ? `<p class="enhanced-copy-id">${copy.id}</p>` : `<p class="fineprint">${t('The first attempt converts one unused ordinary copy into individual equipment.')}</p>`}
      <dl class="enhancement-benefits"><div><dt>${t('Current savings')}</dt><dd>${quote.discount.toFixed(2)}%</dd></div><div><dt>${t('On success')}</dt><dd>${quote.nextDiscount.toFixed(2)}%</dd></div><div><dt>${t('Success chance')}</dt><dd>${quote.chance}%</dd></div></dl>
      <h3>${t('Attempt cost')}</h3>${costChips(quote.cost)}<p class="fineprint">${t('Refinement Core')}: ${quote.cores}</p>
      <p class="enhancement-warning">${t('Failure consumes all listed costs. Equipment and level are retained.')}</p>
      ${quote.reason ? `<p class="notice" role="status">${escape(t(quote.reason))}</p>` : ''}
      <button class="button primary" data-action="refine-equipment" data-copy="${selected.target}" ${pending || !quote.eligible ? 'disabled' : ''}>${icon('spark')}${t('Review enhancement')}</button>
      ${copy ? `<button class="button" data-action="enhanced-gear" data-copy="${copy.id}" data-activity="${activityEquipmentItems[copy.item].activity}" ${equipped(state, copy) ? 'data-unequip' : ''} ${pending ? 'disabled' : ''}>${t(equipped(state, copy) ? 'Unequip' : 'Equip')}</button>
      <div class="enhanced-list-form"><label for="equipment-price-${copy.id}">${t('Asking price')} · FTH$<input id="equipment-price-${copy.id}" data-preserve-draft type="number" min="0.0001" max="10000000000" step="0.0001" inputmode="decimal" required ${equipped(state, copy) ? 'disabled' : ''}></label><button class="button" data-action="enhancement-list" data-copy="${copy.id}" ${pending || equipped(state, copy) ? 'disabled' : ''}>${t('List for sale')}</button></div>
      ${equipped(state, copy) ? `<p class="fineprint">${t('Unequip enhanced equipment before listing it.')}</p>` : ''}` : ''}
      ` : `<p class="fineprint">${t('Choose equipment to preview its next level.')}</p>`}</section></div>
    <section class="enhancement-market" aria-labelledby="enhancement-market-title"><header><h2 id="enhancement-market-title">${t('Enhanced equipment market')}</h2><button class="button" data-action="enhancement-refresh" ${loading || pending ? 'disabled' : ''}>${icon('refresh')}${t('Refresh')}</button></header>
    <p class="fineprint">${t('Player listings only. Each price buys one exact copy and its level.')}</p>
    ${error ? `<p class="notice" role="alert">${escape(t(error))}</p>` : loading && !market ? `<p role="status">${t('Loading listings...')}</p>` : !listings.length ? `<p class="fineprint">${t('No enhanced equipment listed.')}</p>` : ''}
    <div class="enhanced-listings">${listings.map(listing => `<article class="enhancement-listing"><header>${itemArt(listing.equipment.item)}<div><h3>${t(itemName(listing.equipment.item))} +${listing.equipment.level}</h3><small>${listing.yours ? t('Your listing') : t('Player listing')}</small></div></header><small class="enhanced-copy-id">${listing.equipment.id}</small><strong>FTH$ ${formatDollars(listing.price, locale(language))}</strong><button class="button ${listing.yours ? '' : 'primary'}" data-action="${listing.yours ? 'enhancement-cancel' : 'enhancement-buy'}" data-listing="${listing.id}" ${pending || !listing.yours && state.dollars < listing.price ? 'disabled' : ''}>${t(listing.yours ? 'Cancel listing' : 'Review purchase')}</button></article>`).join('')}</div></section>`;
}
