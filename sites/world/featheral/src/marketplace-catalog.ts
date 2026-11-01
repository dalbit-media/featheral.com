import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { itemArt } from './item-art.ts';
import { isDecorationItem, isVisibilityItem } from './items.ts';
import { isMarketResource, marketAssetName, marketPriceAvailable } from './market.ts';
import type { MarketAsset, MarketSnapshot } from './market.ts';
import { formatDollars } from './dollars.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { isAutomationItem } from './automation.ts';
import { displayPrice, displayQuantity, formatResourceAmount, tradingUnit } from './resource-units.ts';

export type CatalogView = 'grid' | 'table';
export type CatalogSort = 'name' | 'buy-low' | 'sell-high' | 'owned';
type Ticker = MarketSnapshot['tickers'][number];

export function marketOwned(state: ApiState, asset: MarketAsset): number {
  return isMarketResource(asset) ? state.game.stock[asset] : state.inventory.items.filter(item => item === asset).length;
}
export function filterMarketCatalog(tickers: Ticker[], state: ApiState, language: Language,
  category: string, query: string, sort: CatalogSort, ownedOnly: boolean): Ticker[] {
  const name = (asset: MarketAsset) => translate(marketAssetName(asset), language);
  return tickers.filter(({ asset }) => {
    const group = isMarketResource(asset) ? 'resources' : isAutomationItem(asset) ? 'automation' : isVisibilityItem(asset) ? 'equipment' : isDecorationItem(asset) ? 'decorations' : 'collectibles';
    return (category === 'all' || category === group) && name(asset).toLocaleLowerCase(locale(language)).includes(query.toLocaleLowerCase(locale(language)).trim())
      && (!ownedOnly || marketOwned(state, asset) > 0);
  }).sort((a, b) => {
    const difference = sort === 'buy-low' ? displayPrice(a.asset, a.ask) - displayPrice(b.asset, b.ask)
      : sort === 'sell-high' ? displayPrice(b.asset, b.bid) - displayPrice(a.asset, a.bid)
      : sort === 'owned' ? displayQuantity(b.asset, marketOwned(state, b.asset)) - displayQuantity(a.asset, marketOwned(state, a.asset)) : 0;
    return difference || name(a.asset).localeCompare(name(b.asset), locale(language));
  });
}
export function renderMarketCatalog(tickers: Ticker[], state: ApiState, selected: MarketAsset, view: CatalogView, language: Language, pending: boolean): string {
  const text = (label: string) => translate(label, language);
  const money = (value: number) => formatDollars(value, locale(language));
  const rows = tickers.map(ticker => {
    const name = text(marketAssetName(ticker.asset)), owned = formatResourceAmount(ticker.asset, marketOwned(state, ticker.asset), locale(language));
    const unit = tradingUnit(ticker.asset, locale(language));
    const art = isMarketResource(ticker.asset) ? icon(ticker.asset) : itemArt(ticker.asset);
    const identity = `<button type="button" class="catalog-identity" data-market-asset="${ticker.asset}" aria-pressed="${ticker.asset === selected}" ${pending ? 'disabled' : ''}>${art}<span><strong>${name}</strong><small class="catalog-owned-inline">${text('Owned')} ${owned}</small></span></button>`;
    const trade = (side: 'buy' | 'sell') => {
      const value = side === 'buy' ? ticker.ask : ticker.bid, available = marketPriceAvailable(value);
      const price = available ? money(displayPrice(ticker.asset, value)) : text('No offers yet.');
      return `<button type="button" class="catalog-price catalog-${side}" data-market-asset="${ticker.asset}" data-market-quick-side="${side}" data-quoted="${available}" aria-label="${text(side === 'buy' ? 'Buy' : 'Sell')} ${name}, ${price}${available ? ` FTH$/${unit}` : ''}" ${pending || (side === 'sell' && marketOwned(state, ticker.asset) === 0) ? 'disabled' : ''}><small>${text(side === 'buy' ? 'Buy' : 'Sell')}</small><strong>${available || view === 'table' ? price : text('No quote')}</strong>${available ? `<span class="catalog-currency">FTH$/${unit}</span>` : ''}</button>`;
    };
    const last = ticker.last === null ? '—' : money(displayPrice(ticker.asset, ticker.last));
    const category = isMarketResource(ticker.asset) ? 'Resources' : isAutomationItem(ticker.asset) ? 'Automation'
      : isVisibilityItem(ticker.asset) ? 'Equipment' : isDecorationItem(ticker.asset) ? 'Decorations' : 'Collectibles';
    return view === 'grid'
      ? `<div class="catalog-tile" data-selected="${ticker.asset === selected}"><div class="catalog-card-meta"><span>${text(category)}</span><span class="catalog-holdings" data-owned="${marketOwned(state, ticker.asset) > 0}">${text('Owned')} ${owned}</span></div>${identity}<div class="catalog-tile-prices">${trade('buy')}${trade('sell')}</div><small class="catalog-last">${text('Last sale')} <strong>${last}${ticker.last === null ? '' : ` FTH$/${unit}`}</strong></small></div>`
      : `<tr class="catalog-row" data-selected="${ticker.asset === selected}"><td class="catalog-name-cell">${identity}</td><td>${trade('buy')}</td><td>${trade('sell')}</td><td class="catalog-owned-column">${owned}</td><td class="catalog-last-column">${last}</td></tr>`;
  }).join('');
  if (!rows) return `<p class="fineprint">${text('No matching items.')}</p>`;
  return view === 'grid' ? `<div class="market-catalog-grid">${rows}</div>`
    : `<table class="market-catalog-table"><thead><tr><th>${text('Item')}</th><th>${text('Buy')}</th><th>${text('Sell')}</th><th class="catalog-owned-column">${text('Owned')}</th><th class="catalog-last-column">${text('Last sale')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}
