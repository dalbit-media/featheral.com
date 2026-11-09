import { chartBounds, chartIntervals, constrainChartWindow, marketCandles, priceHistoryChart, zoomChartWindow } from './market-chart.ts';
import type { ChartInterval, ChartStyle, ChartWindow } from './market-chart.ts';
import type { MarketAsset, MarketFill } from './market.ts';
import { formatResourcePrice } from './resource-units.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';

const ranges = { '1D': 86400000, '1W': 604800000, '1M': 2592000000, All: Infinity };

export class MarketChartView {
  private history: MarketFill[] = [];
  private asset: MarketAsset = 'metal';
  private interval: ChartInterval = 'auto';
  private style: ChartStyle = 'candles';
  private range: keyof typeof ranges = 'All';
  private window: ChartWindow | undefined;
  private averages = false;
  private volume = true;
  private markup = '';
  private frame = 0;
  private observer: ResizeObserver;
  private observedCanvas: HTMLElement | undefined;
  private dialog: HTMLDialogElement | undefined;
  private placeholder: Comment | undefined;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { window: ChartWindow; x: number; distance: number } | undefined;
  private content: HTMLElement;
  private card: HTMLElement;
  private language: Language;

  constructor(card: HTMLElement, language: Language) {
    this.card = card; this.language = language;
    const t = (value: string) => translate(value, language);
    this.content = card.querySelector<HTMLElement>('[data-market-chart]')!;
    card.querySelector('.exchange-section-title')!.insertAdjacentHTML('beforeend', `<button type="button" class="button chart-expand" data-chart-expand aria-haspopup="dialog">${t('Expand chart')}</button>`);
    this.content.insertAdjacentHTML('beforebegin', `<div class="chart-toolbar">
      <div class="catalog-view-switch" role="group" aria-label="${t('Time range')}">${Object.keys(ranges).map(range => `<button type="button" data-chart-range="${range}" aria-pressed="${range === 'All'}">${t(range)}</button>`).join('')}</div>
      <label class="chart-interval-label">${t('Candle interval')}<select data-chart-interval>${chartIntervals.map(interval => `<option value="${interval}">${t(interval === 'auto' ? 'Auto' : interval)}</option>`).join('')}</select></label>
      <div class="catalog-view-switch" role="group" aria-label="${t('Chart style')}"><button type="button" data-chart-style="candles" aria-pressed="true">${t('Candles')}</button><button type="button" data-chart-style="line" aria-pressed="false">${t('Line')}</button></div>
      <button type="button" class="button" data-chart-averages aria-pressed="false">MA 5 / 20</button><button type="button" class="button" data-chart-volume aria-pressed="true">${t('Volume')}</button>
      <div class="chart-navigation" role="group" aria-label="${t('Chart navigation')}">${[['older', 'Earlier candles'], ['in', 'Zoom in'], ['out', 'Zoom out'], ['newer', 'Later candles'], ['reset', 'Reset chart']].map(([key, label]) => `<button type="button" class="button" data-chart-navigation="${key}" aria-label="${t(label)}" title="${t(label)}">${key === 'older' ? '&larr;' : key === 'newer' ? '&rarr;' : key === 'in' ? '+' : key === 'out' ? '-' : t('Reset')}</button>`).join('')}</div>
    </div><p class="chart-gesture-help">${t('Drag to pan. Pinch or Ctrl + scroll to zoom. Arrow keys inspect; + / - zoom.')}</p>`);
    card.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button) return;
      const range = Object.keys(ranges).find(range => range === button.dataset.chartRange) as keyof typeof ranges | undefined;
      if (range) { this.range = range; this.window = undefined; }
      if (button.dataset.chartStyle === 'candles' || button.dataset.chartStyle === 'line') this.style = button.dataset.chartStyle;
      if (button.hasAttribute('data-chart-averages')) this.averages = !this.averages;
      if (button.hasAttribute('data-chart-volume')) this.volume = !this.volume;
      if (button.hasAttribute('data-chart-expand')) { this.expand(); return; }
      const navigation = button.dataset.chartNavigation;
      if (navigation === 'reset') { this.window = undefined; this.range = 'All'; }
      else if (navigation) this.navigate(navigation);
      this.render();
    });
    card.addEventListener('change', event => {
      if (!(event.target instanceof HTMLSelectElement) || !event.target.hasAttribute('data-chart-interval')) return;
      const selected = event.target.value;
      const interval = chartIntervals.find(value => value === selected);
      if (interval) { this.interval = interval; this.window = undefined; this.render(); }
    });
    this.content.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.chart-canvas')) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.content.setPointerCapture(event.pointerId);
      this.beginGesture(); this.inspect(event.clientX, event.clientY);
    });
    this.content.addEventListener('pointermove', event => {
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const geometry = this.geometry(), gesture = this.gesture;
        if (!geometry || !gesture) return;
        const points = [...this.pointers.values()], centre = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const { bounds, duration } = this.series()!;
        if (points.length > 1 && gesture.distance > 0) {
          const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
          this.window = zoomChartWindow(gesture.window, bounds, gesture.distance / Math.max(1, distance), (gesture.x - geometry.rect.left - geometry.left) / geometry.plotWidth, duration * 3);
        } else {
          const delta = (gesture.x - centre) / geometry.plotWidth * (gesture.window.end - gesture.window.start);
          this.window = constrainChartWindow({ start: gesture.window.start + delta, end: gesture.window.end + delta }, bounds, duration * 3);
        }
        this.schedule();
      } else this.inspect(event.clientX, event.clientY);
    });
    const end = (event: PointerEvent) => { this.pointers.delete(event.pointerId); this.beginGesture(); };
    this.content.addEventListener('pointerup', end); this.content.addEventListener('pointercancel', end);
    this.content.addEventListener('lostpointercapture', end);
    this.content.addEventListener('pointerleave', () => { if (!this.pointers.size) this.clearInspection(); });
    this.content.addEventListener('wheel', event => {
      if (!(event.ctrlKey || event.metaKey) || !(event.target instanceof Element) || !event.target.closest('.chart-canvas')) return;
      const geometry = this.geometry();
      if (!geometry) return;
      event.preventDefault();
      this.zoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY * .003))), (event.clientX - geometry.rect.left - geometry.left) / geometry.plotWidth);
      this.schedule();
    }, { passive: false });
    this.content.addEventListener('focusin', event => {
      const candle = event.target instanceof Element ? event.target.closest<SVGElement>('[data-chart-candle]') : null;
      if (candle) this.showCandle(candle);
    });
    this.content.addEventListener('keydown', event => {
      if (!(event.target instanceof Element) || !event.target.closest('.chart-canvas')) return;
      if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault(); this.navigate(event.key === '-' ? 'out' : 'in'); this.render(); return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const candles = [...this.content.querySelectorAll<SVGElement>('[data-chart-candle]')];
      const index = candles.indexOf(document.activeElement as SVGElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? candles.length - 1 : Math.max(0, Math.min(candles.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      candles[next]?.focus({ preventScroll: true });
    });
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(card);
    this.observer.observe(this.content);
    window.addEventListener('pagehide', () => { this.observer.disconnect(); cancelAnimationFrame(this.frame); this.dialog?.close(); }, { once: true });
    this.render();
  }
  update(history: MarketFill[], asset: MarketAsset): void {
    if (asset !== this.asset) { this.window = undefined; this.range = 'All'; this.pointers.clear(); this.gesture = undefined; }
    this.asset = asset; this.history = history; this.render();
  }
  private series() {
    if (!this.history.length) return null;
    const { candles, duration } = marketCandles(this.history, this.interval), bounds = chartBounds(candles, duration);
    const end = bounds.end, start = Math.max(bounds.start, candles.at(-1)!.time - ranges[this.range]);
    const window = constrainChartWindow(this.window ?? { start, end }, bounds, duration * 3);
    return { bounds, duration, window };
  }
  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }
  private render(): void {
    const canvas = this.content.querySelector<HTMLElement>('.chart-canvas');
    const focus = document.activeElement instanceof Element ? document.activeElement.getAttribute('data-chart-candle') : null;
    const chartFocused = document.activeElement?.matches('.trading-chart');
    const history = this.content.querySelector<HTMLDetailsElement>('.market-chart-data');
    const historyFocused = document.activeElement?.matches('.market-chart-data summary');
    const historyOpen = history?.open ?? false;
    const table = history?.querySelector('.market-table-scroll'), scroll = table?.scrollTop ?? 0;
    const markup = priceHistoryChart(this.history, this.language, this.interval, this.style, {
      width: this.content.clientWidth, height: canvas?.clientHeight ?? 400, window: this.series()?.window, averages: this.averages, volume: this.volume,
    });
    if (markup !== this.markup) {
      this.content.innerHTML = markup; this.markup = markup;
      if (this.observedCanvas) this.observer.unobserve(this.observedCanvas);
      this.observedCanvas = this.content.querySelector<HTMLElement>('.chart-canvas') ?? undefined;
      if (this.observedCanvas) this.observer.observe(this.observedCanvas);
      const details = this.content.querySelector<HTMLDetailsElement>('.market-chart-data');
      if (details) { details.open = historyOpen; details.querySelector('.market-table-scroll')?.scrollTo(0, scroll); }
      if (focus) this.content.querySelector<SVGElement>(`[data-chart-candle="${focus}"]`)?.focus({ preventScroll: true });
      if (chartFocused) this.content.querySelector<SVGElement>('.trading-chart')?.focus({ preventScroll: true });
      if (historyFocused) details?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    }
    this.card.querySelectorAll('[data-chart-range]').forEach(button => button.setAttribute('aria-pressed', String(!this.window && button.getAttribute('data-chart-range') === this.range)));
    this.card.querySelectorAll('[data-chart-style]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-chart-style') === this.style)));
    this.card.querySelector('[data-chart-averages]')!.setAttribute('aria-pressed', String(this.averages));
    this.card.querySelector('[data-chart-volume]')!.setAttribute('aria-pressed', String(this.volume));
    this.card.querySelectorAll<HTMLButtonElement>('[data-chart-navigation]').forEach(button => { button.disabled = !this.history.length; });
  }
  private zoom(factor: number, anchor = .5): void {
    const series = this.series();
    if (series) this.window = zoomChartWindow(series.window, series.bounds, factor, anchor, series.duration * 3);
  }
  private navigate(action: string): void {
    const series = this.series();
    if (!series) return;
    if (action === 'in' || action === 'out') this.zoom(action === 'in' ? .7 : 1 / .7);
    else {
      const shift = (series.window.end - series.window.start) * (action === 'older' ? -.25 : .25);
      this.window = constrainChartWindow({ start: series.window.start + shift, end: series.window.end + shift }, series.bounds, series.duration * 3);
    }
  }
  private geometry() {
    const svg = this.content.querySelector<SVGSVGElement>('.trading-chart');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect(), left = Number(svg.dataset.chartLeft), right = Number(svg.dataset.chartRight);
    return { svg, rect, left, right, plotWidth: right - left };
  }
  private beginGesture(): void {
    const series = this.series(), points = [...this.pointers.values()];
    this.gesture = series && points.length ? { window: series.window, x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 } : undefined;
  }
  private inspect(clientX: number, clientY: number): void {
    const geometry = this.geometry();
    if (!geometry) return;
    const x = (clientX - geometry.rect.left) * geometry.svg.viewBox.baseVal.width / geometry.rect.width;
    const y = (clientY - geometry.rect.top) * geometry.svg.viewBox.baseVal.height / geometry.rect.height;
    if (x < geometry.left || x > geometry.right || y < Number(geometry.svg.dataset.chartTop) || y > Number(geometry.svg.dataset.chartBottom)) { this.clearInspection(); return; }
    const candles = [...this.content.querySelectorAll<SVGElement>('[data-chart-candle]')];
    const nearest = candles.reduce<SVGElement | null>((best, candle) => !best || Math.abs(Number(candle.dataset.chartX) - x) < Math.abs(Number(best.dataset.chartX) - x) ? candle : best, null);
    if (nearest) this.showCandle(nearest, y);
  }
  private showCandle(candle: SVGElement, pointerY?: number): void {
    const geometry = this.geometry();
    if (!geometry) return;
    const { svg, left, right } = geometry, x = Number(candle.dataset.chartX), y = pointerY ?? Number(candle.dataset.chartY);
    const crosshair = svg.querySelector('.chart-crosshair')!;
    crosshair.setAttribute('visibility', 'visible');
    crosshair.querySelector('[data-crosshair-x]')!.setAttribute('d', `M${x} ${svg.dataset.chartTop}V${svg.viewBox.baseVal.height - 30}`);
    crosshair.querySelector('[data-crosshair-y]')!.setAttribute('d', `M${left} ${y}H${right}`);
    const dot = crosshair.querySelector('circle')!; dot.setAttribute('cx', String(x)); dot.setAttribute('cy', candle.dataset.chartY!);
    const price = Number(svg.dataset.chartMax) - (y - Number(svg.dataset.chartTop)) / (Number(svg.dataset.chartBottom) - Number(svg.dataset.chartTop)) * (Number(svg.dataset.chartMax) - Number(svg.dataset.chartMin));
    const label = crosshair.querySelector('text')!; label.setAttribute('y', String(y - 7)); label.textContent = formatResourcePrice(this.asset, price, locale(this.language));
    this.content.querySelector('[data-chart-inspection]')!.textContent = candle.getAttribute('aria-label');
  }
  private clearInspection(): void {
    this.content.querySelector('.chart-crosshair')?.setAttribute('visibility', 'hidden');
    const inspection = this.content.querySelector('[data-chart-inspection]');
    if (inspection) inspection.textContent = translate('Hover or focus a candle for OHLC and volume.', this.language);
  }
  private expand(): void {
    if (this.dialog?.open) { this.dialog.close(); return; }
    const button = this.card.querySelector<HTMLButtonElement>('[data-chart-expand]')!;
    this.placeholder = document.createComment('price chart');
    this.card.before(this.placeholder);
    const dialog = document.createElement('dialog'); dialog.className = 'market-chart-dialog';
    dialog.setAttribute('aria-label', translate('Price history', this.language));
    this.card.parentElement!.append(dialog); dialog.append(this.card); this.dialog = dialog;
    button.textContent = translate('Close chart', this.language);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('close', () => {
      this.placeholder?.replaceWith(this.card); dialog.remove(); this.dialog = undefined;
      button.textContent = translate('Expand chart', this.language); button.focus({ preventScroll: true }); this.schedule();
    }, { once: true });
    dialog.showModal(); this.schedule();
  }
}
