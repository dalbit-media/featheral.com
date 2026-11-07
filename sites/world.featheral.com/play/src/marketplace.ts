import { readMarket, sendMarket } from './api.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { itemArt } from './item-art.ts';
import { inventoryUsed, isCollectible, itemStorage, sellableItemCount } from './items.ts';
import { isLiquidAsset, isMarketAsset, isMarketResource, marketAssetName, marketPriceAvailable, marketPriceFloor, marketQuantityLimit } from './market.ts';
import type { MarketAsset, MarketCommand, MarketFill, MarketResponse, MarketSide } from './market.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';
import { formatDollars, dollarsScale, dollarsSlippage, dollarsUnits } from './dollars.ts';
import { marketConsumption } from './consumption.ts';
import { confirmationOpen, confirmConsumption } from './confirmation.ts';
import { filterMarketCatalog, marketOwned, renderMarketCatalog } from './marketplace-catalog.ts';
import type { CatalogSort, CatalogView } from './marketplace-catalog.ts';
import { accountingPrice, accountingQuantity, displayPrice, displayQuantity, formatResourceAmount, formatResourcePrice, resourceEconomy, tradingUnit } from './resource-units.ts';

const compactMarketQuery = '(max-width:650px), (max-width:900px) and (max-height:500px)';

export function priceHistoryChart(history: MarketFill[], language: Language): string {
  if (!history.length) return '<div class="market-chart-empty">No sales yet. Prices will appear here after someone buys or sells.</div>';
  const prices = history.map(fill => fill.price), min = Math.min(...prices), max = Math.max(...prices), span = max - min || Math.max(1, max * .1);
  const first = history[0].time, last = history.at(-1)!.time;
  const points = history.map((fill, index) => {
    const fraction = history.length === 1 ? .5 : last > first ? (fill.time - first) / (last - first) : index / (history.length - 1);
    return `${(40 + fraction * 720).toFixed(2)},${(175 - (fill.price - min + span * .1) / (span * 1.2) * 145).toFixed(2)}`;
  });
  const fmt = (value: number) => `${formatResourcePrice(history[0].asset, value, locale(language))} FTH$/${tradingUnit(history[0].asset, locale(language))}`;
  const date = (time: number) => new Date(time).toLocaleString(locale(language), { timeZone: 'UTC', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<svg class="market-chart" viewBox="0 0 800 215" role="img" aria-label="Past sale prices"><title>Past sale prices</title><path d="M40 20V185H760" class="chart-axis"/><polyline points="${points.join(' ')}" class="chart-line"/><circle cx="${points.at(-1)!.split(',')[0]}" cy="${points.at(-1)!.split(',')[1]}" r="4" class="chart-last"/><text x="40" y="15">${fmt(max)}</text><text x="40" y="180">${fmt(min)}</text><text x="40" y="207">${date(first)}</text><text x="760" y="207" text-anchor="end">${date(last)}</text></svg>
    <details class="market-chart-data"><summary>See past sales</summary><div class="market-table-scroll"><table><thead><tr><th>Server time</th><th>Price each</th><th>Amount</th></tr></thead><tbody>${history.map(fill => `<tr><td>${date(fill.time)}</td><td>${fmt(fill.price)}</td><td>${formatResourceAmount(fill.asset, fill.quantity, locale(language))}</td></tr>`).join('')}</tbody></table></div></details>`;
}
export class Marketplace {
  private root: HTMLElement;
  private state: () => ApiState;
  private update: (state: ApiState) => void;
  private notify: (message: string, error?: boolean) => void;
  private language: Language;
  private data: MarketResponse | null = null;
  private asset: MarketAsset = 'metal';
  private side: MarketSide = 'sell';
  private mode: 'spot' | 'limit' = 'spot';
  private category = 'all';
  private query = '';
  private catalogView: CatalogView = matchMedia(compactMarketQuery).matches ? 'grid' : 'table';
  private sort: CatalogSort = 'name';
  private ownedOnly = false;
  private priceEdited = false;
  private historyCount = 120;
  private pending = false;
  private fresh = false;
  private sequence = 0;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  constructor(root: HTMLElement, state: () => ApiState, update: Marketplace['update'], notify: Marketplace['notify'], language: Language) {
    this.root = root; this.state = state; this.update = update; this.notify = notify; this.language = language;
    const params = new URLSearchParams(location.search), asset = params.get('asset');
    if (isMarketAsset(asset)) this.asset = asset;
    if (params.get('side') === 'buy') this.side = 'buy';
    root.innerHTML = `<header class="exchange-heading"><h1>Marketplace</h1><div class="exchange-wallet" role="group" aria-label="Available FTH$ balance">${icon('dollars')}<strong data-market-balance></strong><span>Available balance</span></div></header>
      <a class="market-bank-link" id="gold" href="/bank/">Wallet and staking ${icon('chevron')}</a>
      <div class="exchange-layout"><aside class="exchange-catalog"><details class="exchange-catalog-choice" data-market-catalog><summary><span class="catalog-current"><span>Trading item</span><strong data-market-selected>${this.name(this.asset)}</strong></span><span class="catalog-current-price" data-market-selected-price></span>${icon('chevron')}</summary><div class="exchange-catalog-body"><div class="catalog-filters"><label class="exchange-search">Search items<input type="search" data-market-search placeholder="Search items"></label><label>Category<select data-market-category><option value="all">All items</option><option value="resources">Resources</option><option value="equipment">Lighting</option><option value="decorations">Decorations</option><option value="collectibles">Collectibles</option></select></label><label>Sort by<select data-market-sort><option value="name">Name</option><option value="buy-low">Lowest buy price</option><option value="sell-high">Highest sell price</option><option value="owned">Most owned</option></select></label></div><div class="catalog-toolbar"><label class="catalog-owned-filter"><input type="checkbox" data-market-owned>Owned only</label><span class="catalog-count"><strong data-market-count>0</strong> <span>Markets</span> · <span>Prices in FTH$</span></span><div class="catalog-view-switch" role="group" aria-label="Market view"><button type="button" data-market-view="grid" aria-pressed="${this.catalogView === 'grid'}">Grid</button><button type="button" data-market-view="table" aria-pressed="${this.catalogView === 'table'}">Table</button></div></div><div class="exchange-assets" data-market-assets tabindex="0" role="region" aria-label="Tradable markets"></div></div></details><div class="catalog-status-row"><p class="exchange-catalog-status" data-market-status role="status">Loading prices...</p><button class="button" type="button" data-market-refresh hidden>Retry</button></div></aside>
      <div class="exchange-main"><section class="exchange-card exchange-instrument"><div data-market-instrument></div></section>
      <section class="exchange-card exchange-chart-card"><div class="exchange-section-title"><h2>Price history</h2><span>FTH$ each · UTC</span><div class="catalog-view-switch" role="group" aria-label="Sale history range"><button type="button" data-market-history="20" aria-pressed="false">20</button><button type="button" data-market-history="60" aria-pressed="false">60</button><button type="button" data-market-history="120" aria-pressed="true">120</button></div></div><div data-market-chart></div></section>
      <div class="exchange-trading"><section class="exchange-card exchange-order-book"><h2>Player offers</h2><div data-market-book></div></section>
      <section class="exchange-card exchange-order-entry"><h2 data-market-order-title tabindex="-1"><span data-market-order-side>Sell</span> <span data-market-order-asset></span></h2><form data-market-form><div class="exchange-tabs"><button type="button" data-market-mode="spot" aria-pressed="true">Now</button><button type="button" data-market-mode="limit" aria-pressed="false">Choose price</button></div><div class="exchange-tabs exchange-sides"><button type="button" data-market-side="buy" aria-pressed="false">Buy</button><button type="button" data-market-side="sell" aria-pressed="true">Sell</button></div><label class="ticket-quantity">Amount<span class="ticket-stepper"><button type="button" data-market-step="-1" aria-label="Decrease amount">-</button><input data-market-quantity type="number" min="1" max="10000" step="1" required value="1"><button type="button" data-market-step="1" aria-label="Increase amount">+</button></span></label><label data-market-limit hidden>Price each · FTH$<input data-market-price type="number" min="0.0001" max="1000000" step="0.0001" required value="1"></label><div class="ticket-amounts" data-market-amounts role="group" aria-label="Quick amount"><button type="button" data-market-amount="10">10</button><button type="button" data-market-amount="100">100</button><button type="button" data-market-amount="1000">1,000</button><button type="button" data-market-max>Max</button></div><div class="exchange-preview" data-market-preview></div><p data-market-requirement class="fineprint" role="status"></p><button class="button primary wide" data-market-submit disabled>Review sell</button><details class="exchange-help"><summary>How buying and selling works</summary><p>Now uses the current price, allowing up to 2% price change. Choose price buys at your price or less, or sells at your price or more. Unused FTH$ and unsold items stay held until the offer completes or you cancel.</p><p>Non-collectible items trade in multiples at demand-driven prices. One equipped or placed copy is protected; spare copies can be sold. Each waiting item reserves one bag slot. Collectibles trade one at a time through player offers only.</p><p>The best price is used first. If prices match, the oldest offer goes first. You can buy from players or the game shop.</p><p>Trading uses your Dollar ledger wallet. FTH$ is not USD. Ethereum conversion and staking are available through the configured bridge; redemption requires an authorized service.</p></details></form></section></div>
      <section class="exchange-card exchange-history-card"><h2>My offers</h2><div data-market-orders></div></section><section class="exchange-card exchange-history-card"><h2>Recent purchases and sales</h2><div data-market-trades></div></section></div></div>`;
    const funding = document.createElement('section');
    funding.className = 'exchange-card';
    funding.innerHTML = `<h2>Fund market liquidity</h2><p>Markets start empty. Donate owned assets and existing FTH$ to the selected market. Donations are permanent and do not issue currency.</p><strong data-pool-funding-asset></strong><form data-pool-funding><label>Owned asset amount<input type="number" min="0.01" step="0.01" required data-pool-quantity></label><label>FTH$ donation<input type="number" min="0.0001" step="0.0001" required data-pool-dollars></label><button class="button" type="submit" data-pool-submit>Review donation</button></form>`;
    root.append(funding);
    funding.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      const quantity = accountingQuantity(this.asset, Number(funding.querySelector<HTMLInputElement>('[data-pool-quantity]')!.value));
      const dollars = Number(funding.querySelector<HTMLInputElement>('[data-pool-dollars]')!.value);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isFinite(dollars) || dollars < quantity * marketPriceFloor(this.asset)) {
        this.notify(translate('Pool funding must meet the resource price floor.', this.language), true);
        return;
      }
      void this.execute({ type: 'fund-pool', asset: this.asset, quantity, dollars });
    });
    localize(root);
    root.querySelector<HTMLSelectElement>('[data-market-category]')!.add(new Option(translate('Automation', this.language), 'automation'));
    root.querySelector<HTMLDetailsElement>('[data-market-catalog]')!.open = !matchMedia(compactMarketQuery).matches;
    this.configureQuantity();
    root.querySelectorAll<HTMLButtonElement>('[data-market-side]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.marketSide === this.side)));
    root.addEventListener('input', event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.hasAttribute('data-market-search')) { this.query = target.value.toLocaleLowerCase(); this.catalog(); return; }
      if (target.hasAttribute('data-market-price')) this.priceEdited = true;
      if (target.hasAttribute('data-market-quantity')) {
        this.fresh = false; clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.refresh(); }, 250);
      }
      this.preview();
    });
    root.addEventListener('change', event => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.hasAttribute('data-market-category')) this.category = target.value;
      if (target instanceof HTMLSelectElement && target.hasAttribute('data-market-sort')) {
        const sort = (['name', 'buy-low', 'sell-high', 'owned'] as const).find(value => value === target.value);
        if (sort) this.sort = sort;
      }
      if (target instanceof HTMLInputElement && target.hasAttribute('data-market-owned')) this.ownedOnly = target.checked;
      this.catalog();
    });
    root.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button) return;
      if (button.dataset.marketView === 'grid' || button.dataset.marketView === 'table') { this.catalogView = button.dataset.marketView; this.catalog(); }
      if (button.dataset.marketHistory) {
        const count = Number(button.dataset.marketHistory);
        if ([20, 60, 120].includes(count)) { this.historyCount = count; this.paint(); }
      }
      if (button.hasAttribute('data-market-refresh')) void this.refresh();
      if (this.pending || confirmationOpen()) return;
      if (isMarketAsset(button.dataset.marketAsset)) {
        this.asset = button.dataset.marketAsset; this.fresh = false; this.priceEdited = false;
        if (button.dataset.marketQuickSide === 'buy' || button.dataset.marketQuickSide === 'sell') this.side = button.dataset.marketQuickSide;
        this.configureQuantity(true);
        this.catalog(); this.preview();
        this.root.querySelector('[data-market-chart]')!.innerHTML = '<p class="fineprint">Loading prices...</p>';
        this.root.querySelector('[data-market-book]')!.innerHTML = '<p class="fineprint">Loading prices...</p>';
        localize(this.root);
        this.rememberSelection(); void this.refresh();
        if (matchMedia(compactMarketQuery).matches) {
          this.root.querySelector<HTMLDetailsElement>('[data-market-catalog]')!.open = false;
          this.root.querySelector<HTMLElement>('[data-market-catalog] summary')!.focus({ preventScroll: true });
        }
        if (button.dataset.marketQuickSide) {
          this.root.querySelector<HTMLElement>('.exchange-order-entry')!.scrollIntoView({ block: 'start' });
          this.root.querySelector<HTMLElement>('[data-market-order-title]')!.focus({ preventScroll: true });
        }
      }
      if (button.dataset.marketSide === 'buy' || button.dataset.marketSide === 'sell') { this.side = button.dataset.marketSide; this.preview(); this.rememberSelection(); }
      if (button.dataset.marketMode === 'spot' || button.dataset.marketMode === 'limit') { this.mode = button.dataset.marketMode; this.preview(); }
      if (button.dataset.marketStep) this.setQuantity(Math.max(1, Math.min(marketQuantityLimit(this.asset), (Number.isSafeInteger(this.quantity()) ? this.quantity() : 1) + Number(button.dataset.marketStep))));
      if (button.dataset.marketAmount) this.setQuantity(Number(button.dataset.marketAmount));
      if (button.hasAttribute('data-market-max')) this.setQuantity(Math.min(marketQuantityLimit(this.asset), isMarketResource(this.asset)
        ? marketOwned(this.state(), this.asset) : sellableItemCount(this.state().inventory, this.asset)));
      if (button.dataset.marketLevel === 'buy' || button.dataset.marketLevel === 'sell') {
        this.side = button.dataset.marketLevel; this.mode = 'limit'; this.priceEdited = true;
        this.root.querySelector<HTMLInputElement>('[data-market-price]')!.value = String(displayPrice(this.asset, Number(button.dataset.marketLevelPrice)));
        this.preview(); this.rememberSelection();
        this.root.querySelector<HTMLElement>('.exchange-order-entry')!.scrollIntoView({ block: 'start' });
        this.root.querySelector<HTMLElement>('[data-market-order-title]')!.focus({ preventScroll: true });
      }
      if (button.dataset.marketCancel) void this.execute({ type: 'cancel', orderId: Number(button.dataset.marketCancel) });
    });
    root.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (this.pending || !this.fresh || !this.root.querySelector<HTMLFormElement>('form')!.reportValidity() || !this.data) return;
      const quantity = this.quantity(), price = accountingPrice(this.asset, Number(this.root.querySelector<HTMLInputElement>('[data-market-price]')!.value));
      const quote = this.data.market.quotes[this.side];
      if (this.mode === 'limit') void this.execute({ type: 'limit', asset: this.asset, side: this.side, quantity, price });
      else if (quote.available && quote.quantity === quantity) void this.execute({ type: 'spot', asset: this.asset, side: this.side, quantity,
        limitDollars: dollarsSlippage(quote.dollars, this.side) });
    });
    this.balances();
    void this.refresh();
    setInterval(() => { if (!this.pending && !confirmationOpen()) void this.refresh(); }, 5000);
  }
  private fmt(value: number, asset = this.asset): string { return formatResourceAmount(asset, value, locale(this.language)); }
  private money(value: number): string { return formatDollars(value, locale(this.language)); }
  private price(value: number, asset = this.asset): string { return `${formatResourcePrice(asset, value, locale(this.language))} FTH$/${tradingUnit(asset, locale(this.language))}`; }
  private name(asset: MarketAsset): string { return translate(marketAssetName(asset), this.language); }
  private art(asset: MarketAsset): string { return isMarketResource(asset) ? icon(asset) : itemArt(asset); }
  private quantity(): number { return accountingQuantity(this.asset, Number(this.root.querySelector<HTMLInputElement>('[data-market-quantity]')!.value)); }
  private configureQuantity(reset = false): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-market-quantity]')!;
    input.min = input.step = String(displayQuantity(this.asset, 1));
    input.max = String(displayQuantity(this.asset, marketQuantityLimit(this.asset)));
    if (reset || !input.validity.valid) input.value = input.min;
    input.setAttribute('aria-label', `${translate('Amount', this.language)} (${tradingUnit(this.asset, locale(this.language))})`);
    input.closest('label')!.firstChild!.textContent = `${translate('Amount', this.language)} (${tradingUnit(this.asset, locale(this.language))})`;
    const price = this.root.querySelector<HTMLInputElement>('[data-market-price]')!;
    price.step = String(displayPrice(this.asset, .0001));
    price.min = String(displayPrice(this.asset, marketPriceFloor(this.asset)));
    price.title = `${translate('Minimum price', this.language)}: ${price.min} FTH$/${tradingUnit(this.asset, locale(this.language))}`;
    const floorLabel = price.closest('label')!.querySelector('small') ?? document.createElement('small');
    floorLabel.textContent = price.title;
    price.closest('label')!.append(floorLabel);
    price.max = String(displayPrice(this.asset, 1000000));
    price.closest('label')!.firstChild!.textContent = `${translate('Price each', this.language)} · FTH$/${tradingUnit(this.asset, locale(this.language))}`;
    this.root.querySelector('.exchange-chart-card .exchange-section-title > span')!.textContent = `FTH$/${tradingUnit(this.asset, locale(this.language))} · UTC`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-amount]').forEach(button => {
      button.textContent = this.fmt(Number(button.dataset.marketAmount));
    });
    const fundingQuantity = this.root.querySelector<HTMLInputElement>('[data-pool-quantity]')!;
    fundingQuantity.min = fundingQuantity.step = input.step;
    fundingQuantity.setAttribute('aria-label', `${translate('Owned asset amount', this.language)} (${tradingUnit(this.asset, locale(this.language))})`);
  }
  private rememberSelection(): void {
    const url = new URL(location.href); url.searchParams.set('asset', this.asset); url.searchParams.set('side', this.side);
    history.replaceState(history.state, '', url);
  }
  private setQuantity(value: number): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-market-quantity]')!;
    if (!Number.isSafeInteger(value) || value < 1 || value > marketQuantityLimit(this.asset)) {
      this.notify(this.amountError(), true);
      return;
    }
    input.value = String(displayQuantity(this.asset, value)); this.fresh = false; clearTimeout(this.debounce);
    this.preview(); void this.refresh();
  }
  private amountError(): string {
    const input = this.root.querySelector<HTMLInputElement>('[data-market-quantity]')!;
    return translate(`Enter an amount from ${input.min} to ${input.max} ${tradingUnit(this.asset, locale(this.language))} in steps of ${input.step}.`, this.language);
  }
  private instrument(): void {
    const economyOpen = this.root.querySelector<HTMLDetailsElement>('[data-resource-economy]')?.open ?? false;
    const ticker = this.data?.market.tickers.find(ticker => ticker.asset === this.asset);
    this.root.querySelector('[data-market-selected]')!.textContent = this.name(this.asset);
    const price = ticker ? this.side === 'buy' ? ticker.ask : ticker.bid : 0;
    this.root.querySelector('[data-market-selected-price]')!.textContent = ticker
      ? marketPriceAvailable(price) ? this.price(price) : translate('No offers yet.', this.language) : '';
    const economy = isMarketResource(this.asset) ? resourceEconomy[this.asset] : null;
    const reference = economy ? `<p>${translate('Current market price', this.language)} <strong>${marketPriceAvailable(price) ? this.price(price) : '—'}</strong></p>
      <details data-resource-economy ${economyOpen ? 'open' : ''}><summary>${translate('Production and upkeep value', this.language)}</summary>
      <p>${translate('Baseline output per worker/week', this.language)}: ${this.fmt(economy.weeklyProduction)} · ${this.money(economy.weeklyProduction * price)} FTH$</p>
      <p>${translate('Baseline upkeep per resident/week', this.language)}: ${this.fmt(economy.dailyConsumption * 7)} · ${this.money(economy.dailyConsumption * 7 * price)} FTH$</p>
      <small>${translate('Actual output and upkeep vary with climate, terrain and upgrades. Oil is used by construction and crafting, not daily resident upkeep.', this.language)}</small></details>` : '';
    this.root.querySelector('[data-market-instrument]')!.innerHTML = `${this.art(this.asset)}<div><h2>${this.name(this.asset)}</h2>${reference}<p>${translate('Last sale', this.language)} <strong>${ticker?.last == null ? '—' : this.price(ticker.last)}</strong></p></div><span class="exchange-venue">Players + game shop</span>`;
    if (!this.priceEdited && ticker) {
      const value = marketPriceAvailable(price) ? price : marketPriceFloor(this.asset);
      if (value >= .0001 && value <= 1000000) this.root.querySelector<HTMLInputElement>('[data-market-price]')!.value = displayPrice(this.asset, value).toFixed(4);
    }
  }
  balances(): void {
    this.root.querySelector('[data-market-balance]')!.textContent = `FTH$ ${this.money(this.state().dollars)}`;
    this.catalog();
    this.preview();
  }
  private catalog(): void {
    if (!this.data) return;
    const focusedAsset = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.marketAsset : undefined;
    const focusedSide = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.marketQuickSide : undefined;
    const list = this.root.querySelector<HTMLElement>('[data-market-assets]')!;
    const scrollTop = list.scrollTop, scrollLeft = list.scrollLeft;
    this.root.querySelector('[data-market-selected]')!.textContent = this.name(this.asset);
    const tickers = filterMarketCatalog(this.data.market.tickers, this.state(), this.language, this.category, this.query, this.sort, this.ownedOnly);
    list.innerHTML = renderMarketCatalog(tickers, this.state(), this.asset, this.catalogView, this.language, this.pending);
    this.root.querySelector('[data-market-count]')!.textContent = String(tickers.length);
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.marketView === this.catalogView)));
    localize(list);
    list.scrollTo(scrollLeft, scrollTop);
    if (focusedAsset) this.root.querySelector<HTMLButtonElement>(`[data-market-asset="${focusedAsset}"]${focusedSide ? `[data-market-quick-side="${focusedSide}"]` : ':not([data-market-quick-side])'}`)?.focus({ preventScroll: true });
  }
  private preview(): void {
    this.root.querySelector('[data-pool-funding-asset]')!.textContent = this.name(this.asset);
    this.root.querySelector<HTMLButtonElement>('[data-pool-submit]')!.disabled = this.pending || !isLiquidAsset(this.asset);
    this.root.dataset.tradeSide = this.side;
    this.instrument();
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.marketMode === this.mode)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-side]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.marketSide === this.side)));
    this.root.querySelector<HTMLElement>('[data-market-limit]')!.hidden = this.mode !== 'limit';
    const price = this.root.querySelector<HTMLInputElement>('[data-market-price]')!; price.disabled = this.mode !== 'limit' || this.pending;
    const amount = this.root.querySelector<HTMLInputElement>('[data-market-quantity]')!;
    amount.disabled = this.pending;
    const quantity = this.quantity(), bag = this.state().inventory, owned = marketOwned(this.state(), this.asset);
    this.root.querySelector('[data-market-order-side]')!.textContent = translate(this.side === 'buy' ? 'Buy' : 'Sell', this.language);
    this.root.querySelector('[data-market-order-asset]')!.textContent = this.name(this.asset);
    this.root.querySelector<HTMLElement>('[data-market-amounts]')!.hidden = !isLiquidAsset(this.asset);
    const maximum = this.root.querySelector<HTMLButtonElement>('[data-market-max]')!;
    maximum.hidden = this.side !== 'sell'; maximum.disabled = this.pending || (isMarketResource(this.asset) ? owned : sellableItemCount(bag, this.asset)) < 1;
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-mode], [data-market-side], [data-market-amount]').forEach(button => button.disabled = this.pending);
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-step]').forEach(button => button.disabled = this.pending || (button.dataset.marketStep === '-1' ? quantity <= 1 : quantity >= marketQuantityLimit(this.asset)));
    const quote = this.data?.market.asset === this.asset && this.data.market.quantity === quantity ? this.data.market.quotes[this.side] : null;
    const dollars = this.mode === 'limit' && price.validity.valid && Number.isSafeInteger(quantity) && quantity > 0
      ? quantity * dollarsUnits(accountingPrice(this.asset, Number(price.value))) / dollarsScale : this.mode === 'spot' && quote?.available ? quote.dollars : undefined;
    let reason = this.state().game.stage < 0 ? 'Establish a settlement before trading.' : '';
    if (!amount.validity.valid || !Number.isSafeInteger(quantity)) reason = this.amountError();
    if (this.mode === 'limit' && !price.validity.valid) reason = translate('Enter a price in the displayed trading-unit increments.', this.language);
    if (!isMarketResource(this.asset)) {
      if (this.side === 'buy') {
        if (isCollectible(this.asset) && (bag.marketReserved?.includes(this.asset) || bag.items.includes(this.asset) || bag.pending.some(item => item === this.asset))) reason = 'This item is already owned or reserved.';
        else if (inventoryUsed(bag) + quantity > itemStorage[bag.storage].capacity) reason = 'Item inventory is full. Upgrade item storage first.';
      } else if (owned >= quantity && sellableItemCount(bag, this.asset) < quantity) reason = 'Unequip or return this item from the map before selling.';
    }
    if (this.side === 'sell' && owned < quantity) reason = isMarketResource(this.asset) ? 'Not enough owned resources for this order.' : 'This item is not in your inventory.';
    if (this.side === 'buy' && dollars !== undefined && dollars > this.state().dollars) reason = 'Not enough FTH$ for this order.';
    if (this.fresh && this.mode === 'spot' && quote && (!quote.available || !quote.dollars)) reason = isMarketResource(this.asset)
      ? this.side === 'sell' ? 'Backing is unavailable for this sale. Settle pending Gold transfers or replenish the exhausted Dollar treasury.'
        : 'Not enough resources in the market. Buy less or try again after players sell.'
      : 'The price changed or not enough items are available. Please try again.';
    this.root.querySelector('[data-market-requirement]')!.textContent = translate(reason, this.language);
    this.root.querySelector('[data-market-preview]')!.innerHTML = `<span class="ticket-total-label">${this.side === 'buy' ? 'You pay · FTH$' : 'You get · FTH$'}</span><strong class="ticket-total">${dollars === undefined || !this.fresh ? '—' : this.money(dollars)}</strong><span>${this.mode === 'spot' ? 'Average price' : 'Price each'}</span><strong>${dollars === undefined || !this.fresh || quantity < 1 ? '—' : this.price(dollars / quantity)}</strong><span>You own</span><strong>${this.fmt(owned)}</strong>${isMarketResource(this.asset) ? '' : `<span>Bag space used</span><strong>${inventoryUsed(bag)} / ${itemStorage[bag.storage].capacity}</strong>`}`;
    const button = this.root.querySelector<HTMLButtonElement>('[data-market-submit]')!;
    button.textContent = translate(this.pending ? 'Saving...' : this.side === 'buy' ? 'Review buy' : 'Review sell', this.language);
    button.disabled = this.pending || !this.fresh || !!reason || !Number.isSafeInteger(quantity) || quantity < 1
      || !amount.validity.valid || (this.mode === 'limit' && !price.validity.valid)
      || (this.mode === 'spot' && (!quote?.available || !quote.dollars));
    localize(this.root.querySelector('[data-market-preview]')!);
  }
  private paint(): void {
    if (!this.data || this.data.market.asset !== this.asset) return;
    const historyOpen = this.root.querySelector<HTMLDetailsElement>('.market-chart-data')?.open ?? false;
    const historyFocused = document.activeElement?.matches('.market-chart-data summary') ?? false;
    const focusedOrder = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.marketCancel : undefined;
    const focusedLevel = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.marketLevel : undefined;
    const focusedPrice = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.marketLevelPrice : undefined;
    const bookScroll = ['bids', 'asks'].map(side => {
      const scroller = this.root.querySelector<HTMLElement>(`.exchange-book .${side}`);
      return { side, left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
    });
    const scrollPositions = ['chart', 'orders', 'trades'].map(section => {
      const scroller = this.root.querySelector<HTMLElement>(`[data-market-${section}] .market-table-scroll`);
      return { section, left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
    });
    const market = this.data.market;
    this.balances();
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-history]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.marketHistory) === this.historyCount)));
    this.root.querySelector('[data-market-chart]')!.innerHTML = priceHistoryChart(market.history.slice(-this.historyCount), this.language);
    const historyDetails = this.root.querySelector<HTMLDetailsElement>('.market-chart-data');
    if (historyDetails) historyDetails.open = historyOpen;
    const levels = (side: 'bids' | 'asks') => `<div class="${side}"><h3>${side === 'bids' ? 'Buying' : 'Selling'}</h3><table><thead><tr><th>Price each</th><th>Amount</th></tr></thead><tbody>${market[side].map(level => `<tr><td><button type="button" class="book-price" data-market-level="${side === 'bids' ? 'sell' : 'buy'}" data-market-level-price="${level.price}" ${this.pending ? 'disabled' : ''}>${this.price(level.price)}</button></td><td>${this.fmt(level.quantity)}</td></tr>`).join('') || '<tr><td colspan="2">No offers yet.</td></tr>'}</tbody></table></div>`;
    const quotedAmount = this.fresh && market.quantity === this.quantity();
    const pricing = isMarketResource(this.asset)
      ? 'Resource prices move gently with trades and a 1% spread. Insufficient sale liquidity converts origin FTHG at the active Gold rate. Dollar treasury funds are used only after confirmed origin exhaustion and Ethereum settlement.'
      : 'Pool prices include a 1% spread. FTH$ displays two decimals and retains four-place game accounting.';
    this.root.querySelector('[data-market-book]')!.innerHTML = `<div class="exchange-book">${levels('bids')}${levels('asks')}</div><div class="exchange-pool"><span>Prices for this amount</span><strong><span>Buy</span> ${quotedAmount && market.quotes.buy.available ? this.money(market.quotes.buy.dollars) : '—'} / <span>Sell</span> ${quotedAmount && market.quotes.sell.available ? this.money(market.quotes.sell.dollars) : '—'} FTH$</strong><small>${translate(pricing, this.language)}</small></div>`;
    this.root.querySelector('[data-market-orders]')!.innerHTML = this.table(['Item', 'Type', 'Price each', 'Completed / total', 'Status', 'Action'], market.orders.map(order =>
      `<tr><td>${this.name(order.asset)}</td><td>${translate(order.side === 'buy' ? 'Buy' : 'Sell', this.language)}</td><td>${this.price(order.price, order.asset)}</td><td>${this.fmt(order.quantity - order.remaining, order.asset)} / ${this.fmt(order.quantity, order.asset)}</td><td>${translate(order.status === 'open' && order.price < marketPriceFloor(order.asset) ? 'Below floor — cancel for refund' : ({ open: 'Waiting', filled: 'Done', cancelled: 'Cancelled' })[order.status], this.language)}</td><td>${order.status === 'open' ? `<button class="button" data-market-cancel="${order.id}" ${this.pending ? 'disabled' : ''}>Cancel</button>` : '—'}</td></tr>`).join(''), 'No offers yet.');
    this.root.querySelector('[data-market-trades]')!.innerHTML = this.table(['Item', 'Type', 'Amount', 'FTH$', 'With'], market.trades.map(fill =>
      `<tr><td>${this.name(fill.asset)}</td><td>${translate(fill.side === 'buy' ? 'Buy' : 'Sell', this.language)}</td><td>${this.fmt(fill.quantity, fill.asset)}</td><td>${this.money(fill.dollars)}</td><td>${translate(fill.venue === 'players' ? 'Player' : 'Game shop', this.language)}</td></tr>`).join(''), 'No purchases or sales yet.');
    localize(this.root);
    for (const { section, left, top } of scrollPositions) {
      this.root.querySelector(`[data-market-${section}] .market-table-scroll`)?.scrollTo(left, top);
    }
    if (historyFocused) this.root.querySelector<HTMLElement>('.market-chart-data summary')?.focus({ preventScroll: true });
    if (focusedOrder) this.root.querySelector<HTMLButtonElement>(`[data-market-cancel="${focusedOrder}"]`)?.focus({ preventScroll: true });
    for (const { side, left, top } of bookScroll) this.root.querySelector(`.exchange-book .${side}`)?.scrollTo(left, top);
    if (focusedLevel && focusedPrice) this.root.querySelector<HTMLButtonElement>(`[data-market-level="${focusedLevel}"][data-market-level-price="${focusedPrice}"]`)?.focus({ preventScroll: true });
  }
  private table(headers: string[], rows: string, empty: string): string {
    return rows ? `<div class="market-table-scroll"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="fineprint">${empty}</p>`;
  }
  private async refresh(): Promise<void> {
    const quantity = this.quantity();
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > marketQuantityLimit(this.asset)) { this.fresh = false; this.preview(); return; }
    const sequence = ++this.sequence, asset = this.asset;
    try {
      const data = await readMarket(asset, quantity);
      if (sequence !== this.sequence || asset !== this.asset || quantity !== this.quantity()) return;
      this.data = data; this.fresh = true; this.update(data); this.paint();
      this.root.querySelector('[data-market-status]')!.textContent = translate('Prices update every 5 seconds.', this.language);
      this.root.querySelector<HTMLButtonElement>('[data-market-refresh]')!.hidden = true;
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.fresh = false; this.preview();
      this.root.querySelector('[data-market-status]')!.textContent = translate(error instanceof Error ? error.message : 'Connection failed.', this.language);
      this.root.querySelector<HTMLButtonElement>('[data-market-refresh]')!.hidden = false;
    }
  }
  private async execute(command: MarketCommand): Promise<void> {
    if (this.pending) return;
    if (confirmationOpen()) { this.notify('Please wait for the current server request.', true); return; }
    this.pending = true; this.sequence++; this.catalog(); this.preview();
    this.root.querySelectorAll<HTMLButtonElement>('[data-market-cancel], [data-market-level]').forEach(button => button.disabled = true);
    try {
      const quote = marketConsumption(command);
      if (quote && !await confirmConsumption(quote, this.language)) return;
      const response = await sendMarket(this.state(), command);
      this.update(response);
      this.notify(command.type === 'cancel' ? 'Offer cancelled. Unused items or FTH$ returned.'
        : command.type === 'fund-pool' ? 'Market liquidity funded from existing assets and FTH$.'
        : command.type === 'limit' ? 'Offer placed. Check My offers for updates.'
          : command.type !== 'sell-half' && command.side === 'buy' ? 'Purchase complete.' : 'Sale complete.');
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; await this.refresh(); }
  }
}
