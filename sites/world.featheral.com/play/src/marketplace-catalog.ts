import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { itemArt } from './item-art.ts';
import { isDecorationItem, isVisibilityItem } from './items.ts';
import { isMarketResource, marketAssetName, marketPriceAvailable } from './market.ts';
import type { MarketAsset, MarketSnapshot } from './market.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { isAutomationItem } from './automation.ts';
import { displayPrice, displayQuantity, formatResourceAmount, formatResourcePrice, tradingUnit } from './resource-units.ts';
import { isCustomizationItem } from './customization.ts';
import { isActivityEquipment } from './activity-equipment.ts';
import { isBulkCraftingItem } from './bulk-crafting.ts';
import { isTransportItem } from './transport-items.ts';

export type CatalogView = 'grid' | 'table';
export const catalogSorts = ['name', 'name-desc', 'buy-low', 'buy-high', 'sell-high', 'sell-low', 'owned', 'change24h-high', 'change24h-low', 'change7d-high', 'change7d-low'] as const;
export type CatalogSort = typeof catalogSorts[number];
type Ticker = MarketSnapshot['tickers'][number];
export type ChangeWindow = '24h' | '7d';
export type ChangeDirection = 'up' | 'down' | 'flat' | 'none';

export function priceChange(ticker: Ticker, window: ChangeWindow): number | null {
  const value = window === '24h' ? ticker.change24h : ticker.change7d;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function formatPriceChange(value: number | null, language: Language): { direction: ChangeDirection; text: string } {
  if (value === null) return { direction: 'none', text: '—' };
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return { direction: 'flat', text: `${(0).toLocaleString(locale(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` };
  const amount = Math.abs(rounded).toLocaleString(locale(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return rounded > 0 ? { direction: 'up', text: `▲ ${amount}%` } : { direction: 'down', text: `▼ ${amount}%` };
}
export function renderPriceChange(ticker: Ticker, window: ChangeWindow, language: Language, labelled = false): string {
  const { direction, text } = formatPriceChange(priceChange(ticker, window), language);
  const period = translate(window === '24h' ? '24 hours' : '7 days', language);
  const spoken = direction === 'none' ? translate('No sales yet', language) : direction === 'up' ? `${translate('Up', language)} ${text.slice(2)}`
    : direction === 'down' ? `${translate('Down', language)} ${text.slice(2)}` : translate('Unchanged', language);
  const short = translate(window === '24h' ? '24h' : '7d', language);
  return `<span class="catalog-change" data-change-window="${window}" data-direction="${direction}" title="${translate('Price change', language)} · ${period}" aria-label="${translate('Price change', language)} ${period}: ${spoken}">${labelled ? `<small aria-hidden="true">${short}</small>` : ''}<strong aria-hidden="true">${text}</strong></span>`;
}

export function marketOwned(state: ApiState, asset: MarketAsset): number {
  return isMarketResource(asset) ? state.game.stock[asset] : state.inventory.items.filter(item => item === asset).length;
}
export function filterMarketCatalog(tickers: Ticker[], state: ApiState, language: Language,
  category: string, query: string, sort: CatalogSort, ownedOnly: boolean): Ticker[] {
  const name = (asset: MarketAsset) => translate(marketAssetName(asset), language);
  return tickers.filter(({ asset }) => {
    const group = isMarketResource(asset) ? 'resources' : isCustomizationItem(asset) ? 'customization' : isAutomationItem(asset) || isBulkCraftingItem(asset) || isTransportItem(asset) ? 'automation' : isVisibilityItem(asset) || isActivityEquipment(asset) ? 'equipment' : isDecorationItem(asset) ? 'decorations' : 'collectibles';
    return (category === 'all' || category === group || category === 'items' && group !== 'resources') && name(asset).toLocaleLowerCase(locale(language)).includes(query.toLocaleLowerCase(locale(language)).trim())
      && (!ownedOnly || marketOwned(state, asset) > 0);
  }).sort((a, b) => {
    const priceSide = sort.startsWith('buy-') ? 'ask' : sort.startsWith('sell-') ? 'bid' : null;
    if (priceSide) {
      const aAvailable = marketPriceAvailable(a[priceSide]), bAvailable = marketPriceAvailable(b[priceSide]);
      if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;
    }
    const changeWindow: ChangeWindow | null = sort.startsWith('change24h-') ? '24h' : sort.startsWith('change7d-') ? '7d' : null;
    if (changeWindow) {
      const aChange = priceChange(a, changeWindow), bChange = priceChange(b, changeWindow);
      if ((aChange === null) !== (bChange === null)) return aChange === null ? 1 : -1;
      const changeDifference = aChange === null || bChange === null ? 0 : sort.endsWith('-high') ? bChange - aChange : aChange - bChange;
      if (changeDifference) return changeDifference;
    }
    const difference = priceSide && !marketPriceAvailable(a[priceSide]) && !marketPriceAvailable(b[priceSide]) ? 0
      : sort === 'buy-low' ? displayPrice(a.asset, a.ask) - displayPrice(b.asset, b.ask)
      : sort === 'buy-high' ? displayPrice(b.asset, b.ask) - displayPrice(a.asset, a.ask)
      : sort === 'sell-high' ? displayPrice(b.asset, b.bid) - displayPrice(a.asset, a.bid)
      : sort === 'sell-low' ? displayPrice(a.asset, a.bid) - displayPrice(b.asset, b.bid)
      : sort === 'owned' ? displayQuantity(b.asset, marketOwned(state, b.asset)) - displayQuantity(a.asset, marketOwned(state, a.asset)) : 0;
    const alphabetical = name(a.asset).localeCompare(name(b.asset), locale(language)) || a.asset.localeCompare(b.asset);
    return difference || alphabetical * (sort === 'name-desc' ? -1 : 1);
  });
}
export function renderMarketCatalog(tickers: Ticker[], state: ApiState, selected: MarketAsset, view: CatalogView, language: Language, pending: boolean, sort: CatalogSort = 'name'): string {
  const text = (label: string) => translate(label, language);
  const rows = tickers.map(ticker => {
    const name = text(marketAssetName(ticker.asset)), owned = formatResourceAmount(ticker.asset, marketOwned(state, ticker.asset), locale(language));
    const unit = tradingUnit(ticker.asset, locale(language));
    const art = isMarketResource(ticker.asset) ? icon(ticker.asset) : itemArt(ticker.asset);
    const identity = `<button type="button" class="catalog-identity" title="${name}" data-market-asset="${ticker.asset}" aria-pressed="${ticker.asset === selected}" ${pending ? 'disabled' : ''}>${art}<span><strong>${name}</strong><small class="catalog-owned-inline">${text('Owned')} ${owned}</small></span></button>`;
    const trade = (side: 'buy' | 'sell') => {
      const value = side === 'buy' ? ticker.ask : ticker.bid, available = marketPriceAvailable(value);
      const price = available ? formatResourcePrice(ticker.asset, value, locale(language)) : text('No offers yet.');
      return `<button type="button" class="catalog-price catalog-${side}" data-market-asset="${ticker.asset}" data-market-quick-side="${side}" data-quoted="${available}" aria-label="${text(side === 'buy' ? 'Buy' : 'Sell')} ${name}, ${price}${available ? ` FTH$/${unit}` : ''}" ${pending || (side === 'sell' && marketOwned(state, ticker.asset) === 0) ? 'disabled' : ''}><small>${text(side === 'buy' ? 'Buy' : 'Sell')}</small><strong>${available || view === 'table' ? price : text('No quote')}</strong>${available ? `<span class="catalog-currency">FTH$/${unit}</span>` : ''}</button>`;
    };
    const last = ticker.last === null ? '—' : formatResourcePrice(ticker.asset, ticker.last, locale(language));
    const category = isMarketResource(ticker.asset) ? 'Resources' : isCustomizationItem(ticker.asset) ? 'Names & titles' : isTransportItem(ticker.asset) ? 'Transport vouchers' : isBulkCraftingItem(ticker.asset) ? 'Bulk crafting' : isAutomationItem(ticker.asset) ? 'Automation'
      : isVisibilityItem(ticker.asset) || isActivityEquipment(ticker.asset) ? 'Equipment' : isDecorationItem(ticker.asset) ? 'Decorations' : 'Collectibles';
    const changes = `<div class="catalog-changes">${renderPriceChange(ticker, '24h', language, true)}${renderPriceChange(ticker, '7d', language, true)}</div>`;
    return view === 'grid'
      ? `<div class="catalog-tile" data-selected="${ticker.asset === selected}"><div class="catalog-card-meta"><span>${text(category)}</span><span class="catalog-holdings" data-owned="${marketOwned(state, ticker.asset) > 0}">${text('Owned')} ${owned}</span></div>${identity}${changes}<div class="catalog-tile-prices">${trade('buy')}${trade('sell')}</div><small class="catalog-last">${text('Last sale')} <strong>${last}${ticker.last === null ? '' : ` FTH$/${unit}`}</strong></small></div>`
      : `<tr class="catalog-row" data-selected="${ticker.asset === selected}"><td class="catalog-name-cell">${identity}</td><td>${trade('buy')}</td><td>${trade('sell')}</td><td class="catalog-change-column">${renderPriceChange(ticker, '24h', language)}</td><td class="catalog-change-column">${renderPriceChange(ticker, '7d', language)}</td><td class="catalog-owned-column">${owned}</td><td class="catalog-last-column">${last}</td></tr>`;
  }).join('');
  if (!rows) return `<p class="fineprint">${text('No matching items.')}</p>`;
  const heading = (label: string, ascending: CatalogSort, descending: CatalogSort, className = '', initial = ascending) => {
    const active = sort === ascending || sort === descending;
    const direction = sort === ascending ? 'ascending' : 'descending';
    const next = active ? sort === ascending ? descending : ascending : initial;
    return `<th class="${className}" aria-sort="${active ? direction : 'none'}"><button type="button" data-catalog-column="${ascending}" data-catalog-sort="${next}" aria-label="${text('Sort by')} ${text(label)} · ${text(next === ascending ? 'Ascending' : 'Descending')}">${text(label)}${active ? sort === ascending ? ' ↑' : ' ↓' : ''}</button></th>`;
  };
  return view === 'grid' ? `<div class="market-catalog-grid">${rows}</div>`
    : `<table class="market-catalog-table"><thead><tr>${heading('Item', 'name', 'name-desc')}${heading('Buy', 'buy-low', 'buy-high')}${heading('Sell', 'sell-low', 'sell-high')}${heading('24h', 'change24h-low', 'change24h-high', 'catalog-change-column', 'change24h-high')}${heading('7d', 'change7d-low', 'change7d-high', 'catalog-change-column', 'change7d-high')}<th class="catalog-owned-column" aria-sort="${sort === 'owned' ? 'descending' : 'none'}"><button type="button" data-catalog-column="owned" data-catalog-sort="owned" aria-label="${text('Sort by')} ${text('Most owned')}">${text('Owned')}${sort === 'owned' ? ' ↓' : ''}</button></th><th class="catalog-last-column">${text('Last sale')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}
