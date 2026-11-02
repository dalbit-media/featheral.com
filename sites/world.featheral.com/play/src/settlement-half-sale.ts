import { readHalfSale, sendMarket } from './api.ts';
import type { ApiState } from './api-types.ts';
import { confirmationOpen, confirmConsumption } from './confirmation.ts';
import { marketConsumption } from './consumption.ts';
import { dollarsSlippage, formatDollars } from './dollars.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';
import { marketAssetName, marketResources } from './market.ts';
import type { HalfSaleQuote } from './market.ts';
import { formatResourceAmount } from './resource-units.ts';

export class SettlementHalfSale {
  private root = document.createElement('section');
  private quote: HalfSaleQuote | null = null;
  private pending = false;
  private loading = false;
  private error = '';
  private state: () => ApiState;
  private update: (state: ApiState) => void;
  private notify: (message: string, error?: boolean) => void;
  private language: Language;
  constructor(state: () => ApiState, update: (state: ApiState) => void,
    notify: (message: string, error?: boolean) => void, language: Language) {
    this.state = state; this.update = update; this.notify = notify; this.language = language;
    this.root.className = 'settlement-section settlement-sale settlement-half-sale';
    this.root.innerHTML = `<h3>Sell half of all resources</h3>
      <p>Exchange half of each owned resource for existing marketplace FTH$. Quantities round down; pending resources and escrow are excluded.</p>
      <div class="half-sale-resources" data-half-resources></div>
      <p><span>You get · FTH$</span> <strong data-half-total>—</strong></p>
      <p role="status" data-half-status></p>
      <div class="half-sale-actions"><button type="button" class="button primary" data-half-submit disabled>Review half sale</button>
      <button type="button" class="button" data-half-refresh>Refresh quote</button></div>
      <a href="/market/">Open marketplace</a>`;
    localize(this.root);
    this.root.querySelector('[data-half-submit]')!.addEventListener('click', () => { void this.execute(); });
    this.root.querySelector('[data-half-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    setInterval(() => {
      if (this.root.isConnected && !document.hidden && !confirmationOpen()) void this.refresh();
    }, 5000);
  }
  mount(parent: Element): void {
    if (this.state().game.stage < 0) {
      parent.textContent = translate('Establish a settlement before trading.', this.language);
      return;
    }
    parent.replaceChildren(this.root);
    if (this.quote && !this.matches()) this.quote = null;
    this.paint();
    if (!this.quote && !this.pending && !this.loading && !this.error) void this.refresh();
  }
  private matches(): boolean {
    return !!this.quote && marketResources.every(resource =>
      (this.quote!.sales.find(sale => sale.asset === resource)?.quantity ?? 0) === Math.floor(this.state().game.stock[resource] / 2));
  }
  private paint(): void {
    this.root.querySelector('[data-half-resources]')!.innerHTML = marketResources.map(resource => {
      const sale = this.quote?.sales.find(sale => sale.asset === resource);
      return `<div><span>${translate(marketAssetName(resource), this.language)}</span>
        <strong>${formatResourceAmount(resource, sale?.quantity ?? 0, locale(this.language))}</strong>
        <small>FTH$ ${sale ? formatDollars(sale.dollars, locale(this.language)) : '0'}</small></div>`;
    }).join('');
    this.root.querySelector('[data-half-total]')!.textContent = this.quote ? formatDollars(this.quote.dollars, locale(this.language)) : '—';
    this.root.querySelector('[data-half-status]')!.textContent = this.error || (this.loading ? translate('Loading prices...', this.language)
      : this.quote && !this.quote.sales.length ? translate('Own at least two of a resource to sell half.', this.language)
      : this.quote && !this.quote.available ? translate('Quote changed or liquidity is insufficient. Refresh the quote.', this.language) : '');
    this.root.querySelector<HTMLButtonElement>('[data-half-submit]')!.disabled = this.pending || this.loading || !!this.error || !this.quote?.available || !this.matches();
    this.root.querySelector<HTMLButtonElement>('[data-half-refresh]')!.disabled = this.pending || this.loading;
  }
  private async refresh(): Promise<void> {
    if (this.pending || this.loading || !this.root.isConnected) return;
    this.loading = true; this.paint();
    try {
      const response = await readHalfSale();
      this.quote = response.halfSale; this.error = ''; this.update(response);
    } catch (error) {
      this.quote = null;
      this.error = translate(error instanceof Error ? error.message : 'Connection failed.', this.language);
    } finally { this.loading = false; this.paint(); }
  }
  private async execute(): Promise<void> {
    if (this.pending || confirmationOpen() || this.root.querySelector<HTMLButtonElement>('[data-half-submit]')!.disabled || !this.quote) return;
    this.pending = true; this.paint();
    try {
      const command = { type: 'sell-half', sales: this.quote.sales.map(sale =>
        ({ asset: sale.asset, quantity: sale.quantity, limitDollars: dollarsSlippage(sale.dollars, 'sell') })) } as const;
      if (!await confirmConsumption(marketConsumption(command)!, this.language)) return;
      const response = await sendMarket(this.state(), command);
      this.update(response); this.notify(response.message ?? 'Half of your owned resources sold for FTH$.');
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; this.quote = null; await this.refresh(); }
  }
}
