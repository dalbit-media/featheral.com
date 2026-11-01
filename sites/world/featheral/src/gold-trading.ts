import { readGold, sendGold } from './api.ts';
import type { ApiState } from './api-types.ts';
import type { GoldSnapshot } from './gold.ts';
import { dollarsSlippage, formatDollars } from './dollars.ts';
import { confirmConsumption, confirmationOpen } from './confirmation.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';

export class GoldTrading {
  private root = document.createElement('section');
  private quote: GoldSnapshot | null = null;
  private sequence = 0;
  private pending = false;
  private state: () => ApiState;
  private update: (state: ApiState) => void;
  private notify: (message: string, error?: boolean) => void;
  private language: Language;
  constructor(parent: HTMLElement, state: () => ApiState, update: (state: ApiState) => void, notify: (message: string, error?: boolean) => void, language: Language) {
    this.state = state; this.update = update; this.notify = notify; this.language = language;
    this.root.id = 'gold'; this.root.className = 'exchange-card gold-exchange';
    this.root.innerHTML = `<header><h2>Featheral Gold exchange</h2><p><span>1 Featheral Gold</span> = <strong data-gold-rate>—</strong> FTH$</p><p>Gold is the future Ethereum-linked token. Live token transfers and withdrawals are not available.</p></header>
      <form><label>Gold amount<input type="number" min="0.0001" max="10000" step="0.0001" required value="1" data-gold-quantity></label><label>Buy or sell<select data-gold-side><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <p><span>Total · FTH$</span> <strong data-gold-total>—</strong></p><p>Reserve prices move with purchases and sales. Quotes include a 1% spread; confirmation allows at most 2% price movement.</p>
      <p role="status" data-gold-status></p><button type="submit" class="button primary wide" disabled data-gold-submit>Review exchange</button><button type="button" class="button wide" data-gold-refresh>Refresh quote</button></form>`;
    parent.append(this.root); localize(this.root);
    this.root.querySelector('[data-gold-quantity]')!.addEventListener('input', () => { this.quote = null; this.paint(); void this.refresh(); });
    this.root.querySelector('[data-gold-side]')!.addEventListener('change', () => this.paint());
    this.root.querySelector('[data-gold-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    this.root.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.execute(); });
    void this.refresh();
    setInterval(() => { if (!this.pending && !confirmationOpen() && !document.hidden) void this.refresh(); }, 5000);
  }
  private quantity(): number { return Number(this.root.querySelector<HTMLInputElement>('[data-gold-quantity]')!.value); }
  private side(): 'buy' | 'sell' { return this.root.querySelector<HTMLSelectElement>('[data-gold-side]')!.value === 'buy' ? 'buy' : 'sell'; }
  private paint(): void {
    const quantity = this.quantity(), side = this.side(), quote = this.quote?.quantity === quantity ? this.quote.quotes[side] : null;
    const input = this.root.querySelector<HTMLInputElement>('[data-gold-quantity]')!;
    this.root.querySelector('[data-gold-rate]')!.textContent = this.quote ? formatDollars(this.quote.rate, locale(this.language)) : '—';
    this.root.querySelector('[data-gold-total]')!.textContent = quote ? formatDollars(quote.dollars, locale(this.language)) : '—';
    const affordable = !!quote?.available && (side === 'buy' ? this.state().dollars >= quote.dollars : this.state().fthg >= quantity);
    this.root.querySelector<HTMLButtonElement>('[data-gold-submit]')!.disabled = this.pending || !affordable || !input.validity.valid;
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,[data-gold-refresh]').forEach(element => element.disabled = this.pending);
    this.root.querySelector('[data-gold-status]')!.textContent = translate(this.pending ? 'Saving...' : !input.validity.valid
      ? input.validity.rangeUnderflow || input.validity.rangeOverflow ? 'Gold amount must be between 0.0001 and 10,000.' : 'Enter a Gold amount with up to four decimal places.'
      : quote && !quote.available ? 'Not enough reserve liquidity for this Gold amount.'
      : quote && !affordable ? side === 'buy' ? 'Not enough FTH$ for this order.' : 'Not enough Featheral Gold.' : '', this.language);
  }
  private async refresh(): Promise<void> {
    if (this.pending) return;
    const input = this.root.querySelector<HTMLInputElement>('[data-gold-quantity]')!;
    const sequence = ++this.sequence, quantity = this.quantity();
    if (!input.validity.valid) { this.quote = null; this.paint(); return; }
    try {
      const response = await readGold(quantity);
      if (sequence !== this.sequence || quantity !== this.quantity()) return;
      this.quote = response.gold; this.update(response); this.paint();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.quote = null; this.paint();
      this.root.querySelector('[data-gold-status]')!.textContent = translate(error instanceof Error ? error.message : 'Connection failed.', this.language);
    }
  }
  private async execute(): Promise<void> {
    if (this.pending || confirmationOpen() || !this.quote || this.quote.quantity !== this.quantity() || this.root.querySelector<HTMLButtonElement>('[data-gold-submit]')!.disabled) return;
    const side = this.side(), quantity = this.quantity(), limitDollars = dollarsSlippage(this.quote.quotes[side].dollars, side);
    this.pending = true; this.sequence++; this.paint();
    try {
      if (!await confirmConsumption({ title: 'Featheral Gold exchange', subject: 'Featheral Bank', weeks: 0, costs: [{ asset: side === 'buy' ? 'dollars' : 'fthg', amount: side === 'buy' ? limitDollars : quantity }],
        receives: [{ asset: side === 'buy' ? 'fthg' : 'dollars', amount: side === 'buy' ? quantity : limitDollars }], costLabel: side === 'buy' ? 'Maximum payment' : 'You spend', receiveLabel: side === 'buy' ? 'You receive' : 'Minimum received',
        notes: ['Gold is the future Ethereum-linked token. Live token transfers and withdrawals are not available.'] }, this.language)) return;
      this.update(await sendGold(this.state(), { type: 'gold', side, quantity, limitDollars }));
      this.notify('Featheral Gold exchange completed.');
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; this.quote = null; await this.refresh(); }
  }
}
