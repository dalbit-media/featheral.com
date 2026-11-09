import { icon } from './icons.ts';
import { createCountUp } from './count-up.ts';
import { formatPublicTotal, resolvePublicSite } from './site.ts';
import type { PublicStats } from './api-types.ts';
import { language, languageLocale, localize, wireLanguageControls } from './i18n-dom.ts';
import { translate } from './i18n.ts';
import { dollarsUnits, dollarsScale, formatDollars } from './dollars.ts';
import { localizePublicCopy } from './public-feature-i18n.ts';
import { drawPublicPreview } from './public-feature-preview.ts';

localize(document);
localizePublicCopy(document);
wireLanguageControls();
document.querySelectorAll<HTMLCanvasElement>('[data-public-map]').forEach(canvas => {
  const context = canvas.getContext('2d');
  if (context) drawPublicPreview(context, canvas.dataset.publicMap!);
});
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(element => {
  element.innerHTML = icon(element.dataset.icon!);
});

for (const [channel, url] of Object.entries(resolvePublicSite().channels)) {
  if (!url) continue;
  document.querySelectorAll<HTMLAnchorElement>(`[data-community="${channel}"]`).forEach(link => {
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
    link.querySelector('.channel-state')!.textContent = translate(channel === 'github' ? 'View project \u2197' : channel === 'discord' ? 'Join \u2197' : 'Follow \u2197', language);
  });
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-step]')];
function selectStep(selected: HTMLButtonElement): void {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')!)!.hidden = !active;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectStep(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selectStep(tabs[next]);
    tabs[next].focus();
  });
}

const statsStatus = document.querySelector<HTMLElement>('#stats-status')!;
const statsPanel = document.querySelector<HTMLElement>('.world-stats')!;
const totalElements = document.querySelectorAll<HTMLElement>('[data-total]');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const counters = [...totalElements].map(element => {
  element.setAttribute('aria-hidden', 'true');
  element.parentElement!.setAttribute('aria-label', translate('Live total unavailable', language));
  return { element, counter: createCountUp(value => {
    const amount = element.dataset.total === 'dollars' ? value / dollarsScale : value;
    const text = element.dataset.total === 'dollars' ? formatDollars(value / dollarsScale, languageLocale) : value.toLocaleString(languageLocale);
    element.textContent = formatPublicTotal(amount, languageLocale, text);
  }) };
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) counters.forEach(({ counter }) => counter.finish());
});
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function validStats(value: unknown): value is PublicStats {
  return value !== null && typeof value === 'object'
    && 'settlements' in value && whole(value.settlements)
    && 'metal' in value && whole(value.metal)
    && 'dollars' in value && typeof value.dollars === 'number' && Number.isFinite(value.dollars) && value.dollars >= 0
    && 'population' in value && whole(value.population)
    && 'updatedAt' in value && whole(value.updatedAt);
}
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let nextStatsRefresh = 0;
let statsLoading = false;
let hasStats = false;
function scheduleStats(): void {
  clearTimeout(statsTimer);
  if (!document.hidden) statsTimer = setTimeout(() => { void refreshStats(); }, Math.max(0, nextStatsRefresh - performance.now()));
}
async function refreshStats(): Promise<void> {
  if (document.hidden || statsLoading) return;
  statsLoading = true;
  void refreshGoldStats();
  try {
    const response = await fetch('/api/dollar/game/stats', { credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Public statistics failed (${response.status}).`);
    const data: unknown = await response.json();
    if (!validStats(data)) throw new Error('Public statistics returned invalid totals.');
    if (Date.now() - data.updatedAt > 90000 || data.updatedAt > Date.now() + 10000) throw new Error('Public statistics are out of date.');
    for (const { element, counter } of counters) {
      const key = element.dataset.total;
      if (key !== 'settlements' && key !== 'metal' && key !== 'population' && key !== 'dollars') throw new Error('Unknown public statistic.');
      const target = key === 'dollars' ? dollarsUnits(data[key]) : data[key];
      const text = key === 'dollars' ? formatDollars(data.dollars, languageLocale) : target.toLocaleString(languageLocale);
      element.parentElement!.setAttribute('aria-label', text);
      element.title = text;
      counter.set(target, !document.hidden && !reducedMotion.matches && document.documentElement.classList.contains('fth-ready'));
    }
    hasStats = true;
    const message = translate('Live snapshot \u00b7 updates about every 30s', language);
    if (statsStatus.textContent !== message) statsStatus.textContent = message;
    statsStatus.dataset.state = 'live';
    statsPanel.dataset.state = 'live';
    statsStatus.title = translate(`Server snapshot: ${new Date(data.updatedAt).toLocaleString(languageLocale)}`, language);
  } catch (error) {
    console.error('Unable to refresh public statistics', error);
    counters.forEach(({ counter }) => counter.finish());
    const message = translate(hasStats ? 'Last known totals \u00b7 updates paused, retrying shortly' : 'Live totals unavailable \u00b7 retrying shortly', language);
    if (statsStatus.textContent !== message) statsStatus.textContent = message;
    statsStatus.dataset.state = 'stale';
    statsPanel.dataset.state = 'stale';
  } finally {
    statsLoading = false;
    nextStatsRefresh = performance.now() + 30000 + Math.random() * 5000;
    scheduleStats();
  }
  async function refreshGoldStats(): Promise<void> {
    try {
      const response = await fetch('/api/v1/gold/stats', { credentials: 'omit', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || data.chain?.id !== 1 || !/^\d+$/.test(data.chain?.totalSupply)) throw new Error(data.error || 'Gold API returned invalid Ethereum statistics.');
      const supply = Number(BigInt(data.chain.totalSupply) / 10n ** 18n);
      document.querySelectorAll<HTMLElement>('[data-gold-supply]').forEach(element => { element.textContent = formatPublicTotal(supply, languageLocale); element.title = supply.toLocaleString(languageLocale); });
      const dynamic = data.goldReserve?.pricingPolicy === 'origin-linear-v1';
      const rate = dynamic ? data.goldReserve.spotRateFthDollarPerFthg : data.bridge?.spotRateFthDollarPerFthg;
      document.querySelectorAll<HTMLElement>('[data-public-gold-rate]').forEach(element => {
        element.textContent = (dynamic || data.bridge?.initialized) && typeof rate === 'string' && /^\d+$/.test(rate)
          ? formatDollars(Number(BigInt(rate) / 10n ** 12n) / 1e6, languageLocale) : translate('Pool not initialized', language);
      });
    } catch (error) {
      console.error('Gold statistics unavailable:', error);
      document.querySelectorAll<HTMLElement>('[data-gold-supply], [data-public-gold-rate]').forEach(element => { element.textContent = '—'; element.title = translate('Gold API unavailable', language); });
    }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(statsTimer);
    counters.forEach(({ counter }) => counter.finish());
  }
  else scheduleStats();
});
statsStatus.textContent = translate('Connecting to the world...', language);
void refreshStats();
