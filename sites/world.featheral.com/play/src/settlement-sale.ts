import './resource-sale.css';
import { readCollection, readMarket, send, sendMarket } from './api.ts';
import type { ApiState, CollectionQuote } from './api-types.ts';
import { marketAssetName, marketResources } from './market.ts';
import type { MarketQuote, MarketResource } from './market.ts';
import { gameConsumption, marketConsumption, transportRecommendations } from './consumption.ts';
import { confirmConsumption, confirmationOpen } from './confirmation.ts';
import { dollarsSlippage, dollarsUnits, formatDollars } from './dollars.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';
import { formatResourceAmount } from './resource-units.ts';
import { ResourceSaleQuantity } from './resource-sale-quantity.ts';

export function settlementSalesAvailable(state: ApiState): boolean {
  return state.game.stage >= 0 && !!(state.game.bank || state.game.incomeFacilities?.['market-stall'] || state.game.incomeFacilities?.['trade-hub']);
}
export class SettlementSale {
  private root = document.createElement('section');
  private quote: MarketQuote | null = null;
  private collection: CollectionQuote | null = null;
  private sequence = 0;
  private pending = false;
  private loading = false;
  private error = '';
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private controls: ResourceSaleQuantity;
  private source: 'owned' | 'completed' = 'owned';
  private state: () => ApiState;
  private update: (state: ApiState) => void;
  private notify: (message: string, error?: boolean) => void;
  private language: Language;
  private access: 'settlement' | 'market';
  constructor(state: () => ApiState, update: (state: ApiState) => void,
    notify: (message: string, error?: boolean) => void, language: Language,
    resource?: MarketResource, access: 'settlement' | 'market' = 'settlement') {
    this.state = state; this.update = update; this.notify = notify; this.language = language; this.access = access;
    this.root.className = 'settlement-section resource-sale';
    this.root.innerHTML = `<h3>Sell resources</h3>
      <form><label ${resource ? 'hidden' : ''}>Resource<select data-sale-resource>${(resource ? [resource] : marketResources).map(asset =>
        `<option value="${asset}">${marketAssetName(asset)}</option>`).join('')}</select></label>
      <div class="resource-sale-sources" role="group" aria-label="Resource source"><button type="button" data-sale-source="owned" aria-pressed="true">Owned</button><button type="button" data-sale-source="completed" aria-pressed="false">Ready to collect</button></div>
      <p data-sale-stock></p><div data-sale-controls></div><small data-sale-note></small>
      <p class="resource-sale-total"><span>You get · FTH$</span><strong data-sale-total>—</strong></p>
      <p role="status" data-sale-status></p><div class="resource-sale-actions">
      <button class="button primary" type="submit" data-sale-submit disabled>Review sell</button>
      <button class="button" type="button" data-sale-refresh>Refresh quote</button></div>
      <nav class="transport-recommendations" data-transport-help hidden>${transportRecommendations.map(link => `<a class="button" href="${link.href}">${translate(link.label, language)}</a>`).join('')}</nav></form>`;
    this.controls = new ResourceSaleQuantity(language, () => this.changed());
    this.root.querySelector('[data-sale-controls]')!.append(this.controls.root);
    localize(this.root); this.configure(true);
    this.root.querySelector('select')!.addEventListener('change', () => { this.configure(true); this.changed(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-sale-source]').forEach(button => button.addEventListener('click', () => {
      this.setSource(button.dataset.saleSource === 'completed' ? 'completed' : 'owned');
    }));
    this.root.querySelector('[data-sale-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    this.root.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.execute(); });
    setInterval(() => {
      if (this.root.isConnected && !document.hidden && !confirmationOpen() && document.activeElement?.closest('.resource-sale') !== this.root) void this.refresh();
    }, 5000);
  }
  private get asset(): MarketResource { return marketResources.find(resource => resource === this.root.querySelector('select')!.value)!; }
  private available(): number {
    return this.source === 'owned' ? this.state().game.stock[this.asset] : Math.floor(this.state().pending[this.asset]);
  }
  select(resource: MarketResource): void {
    if (this.pending || this.asset === resource) return;
    this.root.querySelector('select')!.value = resource; this.configure(true); this.changed();
  }
  setSource(source: 'owned' | 'completed'): void {
    if (this.pending) return;
    this.source = source; this.configure(true); this.changed();
  }
  private configure(reset = false): void {
    if (this.controls.configure(this.asset, this.available(), reset)) this.quote = null;
  }
  private changed(): void {
    this.sequence++; this.quote = null; this.collection = null; this.error = ''; this.paint();
    clearTimeout(this.debounce); this.debounce = setTimeout(() => { void this.refresh(); }, 250);
  }
  mount(parent: Element): void {
    if (this.state().game.stage < 0 || this.access === 'settlement' && !settlementSalesAvailable(this.state()) && this.source === 'owned') {
      parent.innerHTML = `<p>${translate('Build a market stall, trade hub or city bank to sell here.', this.language)} <a href="/market/?side=sell">${translate('Open marketplace', this.language)}</a></p>`;
      return;
    }
    parent.replaceChildren(this.root); this.configure(); this.paint();
    if (!this.quote && !this.pending && !this.loading && !this.error) void this.refresh();
  }
  private paint(message = ''): void {
    const t = (text: string) => translate(text, this.language);
    const amount = formatResourceAmount(this.asset, this.available(), locale(this.language));
    this.root.querySelector('[data-sale-stock]')!.textContent = `${t(this.source === 'owned' ? 'Owned' : 'Ready to collect')}: ${amount}`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-sale-source]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.saleSource === this.source)); button.disabled = this.pending;
    });
    this.root.querySelector('[data-sale-note]')!.textContent = this.source === 'completed'
      ? `${t('Collect all completed output, sell the selected amount, and store the rest. Full transport is deducted from proceeds.')} ${t('Transport')}: FTH$ ${this.collection ? formatDollars(this.collection.transport, locale(this.language)) : '—'}`
      : t('Only owned resources are sold. Pending resources and escrow are excluded.');
    const reason = message || this.error || (!this.controls.valid
      ? t(this.available() < 1 ? 'No resources available to sell.' : 'Enter a whole trading lot within the available amount.')
      : this.collection?.sellAvailable && this.collection.net < 0 ? t('Selling this pickup now would lose FTH$ after transport.')
      : this.collection?.sellAvailable && this.collection.net === 0 ? t('Sale proceeds only cover transport. No FTH$ profit remains.')
      : this.quote && !this.quote.available ? t('Backing is unavailable for this sale. Settle pending Gold transfers or wait for player-funded liquidity.') : '');
    this.root.querySelector<HTMLElement>('[data-transport-help]')!.hidden = this.source !== 'completed' || !this.collection || this.collection.net > 0;
    this.root.querySelector('[data-sale-total]')!.textContent = this.quote?.available ? formatDollars(this.quote.dollars, locale(this.language)) : '—';
    this.root.querySelector('[data-sale-status]')!.textContent = reason;
    const submit = this.root.querySelector<HTMLButtonElement>('[data-sale-submit]')!;
    submit.textContent = t(this.pending ? 'Saving...' : this.source === 'completed' ? 'Review collect and sell' : 'Review sell');
    submit.disabled = this.pending || !!reason || !this.quote?.available || !this.quote.dollars;
    this.controls.disable(this.pending);
    this.root.querySelector<HTMLSelectElement>('select')!.disabled = this.pending;
    this.root.querySelector<HTMLButtonElement>('[data-sale-refresh]')!.disabled = this.pending;
  }
  private async refresh(): Promise<void> {
    if (this.pending || !this.root.isConnected) return;
    clearTimeout(this.debounce); this.configure();
    const sequence = ++this.sequence, asset = this.asset, quantity = this.controls.quantity, source = this.source;
    this.loading = true; this.error = ''; this.quote = null; this.paint();
    if (!this.controls.valid) { this.loading = false; return; }
    try {
      const response = source === 'completed' ? await readCollection(asset, quantity) : await readMarket(asset, quantity);
      if (sequence !== this.sequence || this.asset !== asset || this.controls.quantity !== quantity || this.source !== source) return;
      if ('collectionQuote' in response) {
        this.collection = response.collectionQuote;
        this.quote = { quantity, dollars: this.collection.net, available: this.collection.available
          && dollarsUnits(dollarsSlippage(this.collection.proceeds, 'sell')) - dollarsUnits(this.collection.transport) >= 1 };
      } else this.quote = response.market.quotes.sell;
      this.update(response); this.configure(); this.paint();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.quote = null; this.error = translate(error instanceof Error ? error.message : 'Connection failed.', this.language); this.paint();
    } finally { if (sequence === this.sequence) { this.loading = false; this.paint(); } }
  }
  private async execute(): Promise<void> {
    if (this.pending || confirmationOpen() || this.root.querySelector<HTMLButtonElement>('[data-sale-submit]')!.disabled || !this.quote) return;
    const state = this.state(), source = this.source;
    const spot = { type: 'spot', side: 'sell', asset: this.asset, quantity: this.controls.quantity, limitDollars: dollarsSlippage(this.quote.dollars, 'sell') } as const;
    const collect = { type: 'collect-sell', resource: this.asset, quantity: this.controls.quantity,
      minimumDollars: this.collection ? dollarsUnits(dollarsSlippage(this.collection.proceeds, 'sell')) - dollarsUnits(this.collection.transport) : 0 } as const;
    const consumption = source === 'completed' ? gameConsumption(state, collect) : marketConsumption(spot);
    if (!consumption) { this.notify('The action could not be completed.', true); return; }
    this.pending = true; this.sequence++; this.paint();
    try {
      if (!await confirmConsumption(consumption, this.language)) return;
      if (source === 'owned' && this.access === 'settlement' && !settlementSalesAvailable(this.state())) throw new Error('Build a market stall, trade hub or city bank to sell here.');
      const response = source === 'completed' ? await send(this.state(), collect) : await sendMarket(this.state(), spot);
      this.update(response); this.notify(response.message ?? 'Resources sold for FTH$.');
      this.configure(true);
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; this.quote = null; await this.refresh(); }
  }
}
