import { readMarket, sendMarket } from './api.ts';
import type { ApiState } from './api-types.ts';
import { marketAssetName, marketResources } from './market.ts';
import type { MarketQuote, MarketResource } from './market.ts';
import { marketConsumption } from './consumption.ts';
import { confirmConsumption, confirmationOpen } from './confirmation.ts';
import { dollarsSlippage, formatDollars } from './dollars.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';
import { accountingQuantity, displayQuantity, tradingUnit } from './resource-units.ts';

export function settlementSalesAvailable(state: ApiState): boolean {
  return state.game.stage >= 0 && !!(state.game.bank || state.game.incomeFacilities?.['market-stall'] || state.game.incomeFacilities?.['trade-hub']);
}
export class SettlementSale {
  private root = document.createElement('section');
  private quote: MarketQuote | null = null;
  private sequence = 0;
  private pending = false;
  constructor(privateState: () => ApiState, privateUpdate: (state: ApiState) => void,
    privateNotify: (message: string, error?: boolean) => void, privateLanguage: Language, resource?: MarketResource) {
    this.state = privateState; this.update = privateUpdate; this.notify = privateNotify; this.language = privateLanguage;
    const prefix = resource ? `settlement-sale-${resource}` : 'settlement-sale';
    this.root.className = 'settlement-section settlement-sale';
    this.root.innerHTML = `<h3>Sell resources for FTH$</h3><p>Sell owned resources at current market prices, or better player bids. Existing treasury funds replenish the market while available. Claim pending resources first.</p>
      <form><label for="${prefix}-resource" ${resource ? 'hidden' : ''}>Resource</label><select id="${prefix}-resource" ${resource ? 'hidden' : ''}>${(resource ? [resource] : marketResources).map(asset => `<option value="${asset}">${marketAssetName(asset)}</option>`).join('')}</select>
      <label for="${prefix}-quantity">Amount</label><div class="settlement-sale-amount"><input id="${prefix}-quantity" type="number" min="1" max="10000" step="1" value="1" required><button type="button" data-sale-max>Max</button></div>
      <p><span>You get · FTH$</span> <strong data-sale-total>—</strong></p><p role="status" data-sale-status></p>
      <button class="button primary" type="submit" data-sale-submit disabled>Review sell</button><button class="button" type="button" data-sale-refresh>Refresh quote</button></form>`;
    localize(this.root);
    this.configure();
    this.root.querySelector('select')!.addEventListener('change', () => { this.configure(); this.quote = null; void this.refresh(); });
    this.root.querySelector('input')!.addEventListener('input', () => { this.quote = null; void this.refresh(); });
    this.root.querySelector('[data-sale-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    this.root.querySelector('[data-sale-max]')!.addEventListener('click', () => {
      this.input.value = String(displayQuantity(this.asset, Math.min(10000, this.state().game.stock[this.asset])));
      this.quote = null; void this.refresh();
    });
    this.root.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.execute(); });
    setInterval(() => { if (this.root.isConnected && !document.hidden && !confirmationOpen()) void this.refresh(); }, 5000);
  }
  private state: () => ApiState;
  private update: (state: ApiState) => void;
  private notify: (message: string, error?: boolean) => void;
  private language: Language;
  private get input(): HTMLInputElement { return this.root.querySelector('input')!; }
  private get asset(): MarketResource { return marketResources.find(resource => resource === this.root.querySelector('select')!.value)!; }
  private quantity(): number { return accountingQuantity(this.asset, Number(this.input.value)); }
  private configure(): void {
    this.input.min = this.input.step = String(displayQuantity(this.asset, 1));
    this.input.max = String(displayQuantity(this.asset, 10000));
    this.input.value = this.input.min;
    this.root.querySelector(`label[for="${this.input.id}"]`)!.textContent = `${translate('Amount', this.language)} (${tradingUnit(this.asset)})`;
  }
  mount(parent: Element): void {
    if (!settlementSalesAvailable(this.state())) {
      parent.innerHTML = `<p>${translate('Build a market stall, trade hub or city bank to sell here.', this.language)} <a href="/market/">${translate('Open marketplace', this.language)}</a></p>`;
      return;
    }
    parent.replaceChildren(this.root); this.paint();
    if (!this.quote && !this.pending) void this.refresh();
  }
  private paint(message = ''): void {
    const quantity = this.quantity();
    const reason = message || (!this.input.validity.valid || !Number.isSafeInteger(quantity)
      ? translate(`Enter an amount from ${this.input.min} to ${this.input.max} ${tradingUnit(this.asset)} in steps of ${this.input.step}.`, this.language)
      : quantity > this.state().game.stock[this.asset] ? translate('Not enough owned resources for this order.', this.language)
      : this.quote && !this.quote.available ? translate('Not enough market funds for this sale. Treasury funds are finite. Sell less or try again after funds are replenished.', this.language) : '');
    this.root.querySelector('[data-sale-total]')!.textContent = this.quote?.available ? formatDollars(this.quote.dollars, locale(this.language)) : '—';
    this.root.querySelector('[data-sale-status]')!.textContent = reason;
    this.root.querySelector<HTMLButtonElement>('[data-sale-submit]')!.disabled = this.pending || !!reason || !this.quote?.available || !this.quote.dollars;
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,[data-sale-max],[data-sale-refresh]').forEach(control => control.disabled = this.pending);
  }
  private async refresh(): Promise<void> {
    if (this.pending) return;
    const sequence = ++this.sequence, asset = this.asset, quantity = this.quantity();
    this.paint();
    if (!this.input.validity.valid || !Number.isSafeInteger(quantity)) return;
    try {
      const response = await readMarket(asset, quantity);
      if (sequence !== this.sequence || this.asset !== asset || this.quantity() !== quantity) return;
      this.quote = response.market.quotes.sell; this.update(response); this.paint();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.quote = null; this.paint(translate(error instanceof Error ? error.message : 'Connection failed.', this.language));
    }
  }
  private async execute(): Promise<void> {
    if (this.pending || confirmationOpen() || this.root.querySelector<HTMLButtonElement>('[data-sale-submit]')!.disabled || !this.quote) return;
    const command = { type: 'spot', side: 'sell', asset: this.asset, quantity: this.quantity(), limitDollars: dollarsSlippage(this.quote.dollars, 'sell') } as const;
    this.pending = true; this.sequence++; this.paint();
    try {
      if (!await confirmConsumption(marketConsumption(command)!, this.language)) return;
      if (!settlementSalesAvailable(this.state())) throw new Error('Build a market stall, trade hub or city bank to sell here.');
      const response = await sendMarket(this.state(), command);
      this.update(response); this.notify(response.message ?? 'Resources sold for FTH$.');
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; this.quote = null; await this.refresh(); }
  }
}
