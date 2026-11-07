import type { MarketResource } from './market.ts';
import { accountingQuantity, displayQuantity, formatResourceAmount, tradingUnit } from './resource-units.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';

export const salePercentages = [25, 50, 75, 100] as const;
export function saleQuantity(available: number, percent: number): number {
  const maximum = Math.max(0, Math.floor(available));
  return maximum ? Math.max(1, Number(BigInt(maximum) * BigInt(percent) / 100n)) : 0;
}

export class ResourceSaleQuantity {
  readonly root = document.createElement('div');
  private input: HTMLInputElement;
  private slider: HTMLInputElement;
  private asset: MarketResource = 'wood';
  private maximum = 0;
  private percent: number | null = 50;
  private language: Language;
  private changed: () => void;
  constructor(language: Language, changed: () => void) {
    this.language = language; this.changed = changed;
    this.root.className = 'resource-sale-quantity';
    this.root.innerHTML = `<div class="resource-sale-percentages" role="group" aria-label="Sale percentage">${salePercentages.map(percent =>
      `<button type="button" data-sale-percent="${percent}" aria-pressed="${percent === 50}">${percent}%</button>`).join('')}</div>
      <label><span data-sale-amount-label></span><input data-sale-number type="number" inputmode="decimal" min="1" step="1" value="0" required></label>
      <label><span class="resource-sale-sr-only">${translate('Sale quantity slider', language)}</span><input data-sale-slider type="range" min="0" max="0" step="1" value="0"></label>
      <small data-sale-available></small>`;
    this.input = this.root.querySelector<HTMLInputElement>('[data-sale-number]')!;
    this.slider = this.root.querySelector<HTMLInputElement>('[data-sale-slider]')!;
    this.root.querySelectorAll<HTMLButtonElement>('[data-sale-percent]').forEach(button => {
      button.addEventListener('click', () => {
        this.percent = Number(button.dataset.salePercent);
        this.write(saleQuantity(this.maximum, this.percent)); this.changed();
      });
    });
    this.slider.addEventListener('input', () => {
      this.percent = null; this.write(Number(this.slider.value)); this.changed();
    });
    this.input.addEventListener('input', () => {
      this.percent = null;
      this.slider.value = String(Number.isSafeInteger(this.quantity) ? this.quantity : 0);
      this.slider.setAttribute('aria-valuetext', formatResourceAmount(this.asset, Number(this.slider.value), locale(this.language)));
      this.presets(); this.changed();
    });
  }
  get quantity(): number { return accountingQuantity(this.asset, Number(this.input.value)); }
  get valid(): boolean { return this.input.validity.valid && Number.isSafeInteger(this.quantity) && this.quantity > 0 && this.quantity <= this.maximum; }
  configure(asset: MarketResource, available: number, reset = false): boolean {
    const before = this.quantity;
    const previous = this.maximum;
    const previousAsset = this.asset;
    this.asset = asset; this.maximum = Math.max(0, Math.floor(available));
    if (reset || previousAsset !== asset) this.percent = 50;
    this.input.min = this.input.step = String(displayQuantity(asset, 1));
    this.input.max = String(displayQuantity(asset, this.maximum));
    this.input.inputMode = asset === 'metal' ? 'decimal' : 'numeric';
    this.slider.min = this.maximum ? '1' : '0'; this.slider.max = String(this.maximum);
    this.root.querySelector('[data-sale-amount-label]')!.textContent = `${translate('Amount', this.language)} (${tradingUnit(asset, locale(this.language))})`;
    this.root.querySelector('[data-sale-available]')!.textContent = `${translate('Available this sale', this.language)}: ${formatResourceAmount(asset, this.maximum, locale(this.language))}`;
    if (reset || previousAsset !== asset || previous !== this.maximum) {
      this.write(this.percent === null ? Math.min(this.maximum, Math.max(1, before)) : saleQuantity(this.maximum, this.percent));
    }
    return before !== this.quantity;
  }
  disable(pending: boolean): void {
    this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => { control.disabled = pending || !this.maximum; });
  }
  private write(quantity: number): void {
    this.input.value = String(displayQuantity(this.asset, quantity));
    this.slider.value = String(quantity);
    this.slider.setAttribute('aria-valuetext', formatResourceAmount(this.asset, quantity, locale(this.language)));
    this.presets();
  }
  private presets(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-sale-percent]').forEach(button => {
      button.setAttribute('aria-pressed', String(this.percent === Number(button.dataset.salePercent)));
    });
  }
}
