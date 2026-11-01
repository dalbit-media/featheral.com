import { icon } from './icons.ts';
import { createCountUp } from './count-up.ts';
import { formatPublicTotal, resolvePublicSite } from './site.ts';
import type { PublicStats } from './api-types.ts';
import { language, languageLocale, localize, wireLanguageControls } from './i18n-dom.ts';
import { translate } from './i18n.ts';
import { fthgUnits, fthgScale } from './fthg.ts';
import { dollarsUnits, dollarsScale, formatDollars } from './dollars.ts';

localize(document);
wireLanguageControls();
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
const liveCards = document.querySelectorAll<HTMLElement>('.world-live-cards');
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
    && 'fthgTransactions' in value && whole(value.fthgTransactions)
    && 'metal' in value && whole(value.metal)
    && 'fthg' in value && typeof value.fthg === 'number' && Number.isFinite(value.fthg) && value.fthg >= 0
    && 'dollars' in value && typeof value.dollars === 'number' && Number.isFinite(value.dollars) && value.dollars >= 0
    && 'goldRate' in value && typeof value.goldRate === 'number' && Number.isFinite(value.goldRate) && value.goldRate > 0
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
  try {
    const response = await fetch('/api/stats', { credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Public statistics failed (${response.status}).`);
    const data: unknown = await response.json();
    if (!validStats(data)) throw new Error('Public statistics returned invalid totals.');
    if (Date.now() - data.updatedAt > 90000 || data.updatedAt > Date.now() + 10000) throw new Error('Public statistics are out of date.');
    for (const { element, counter } of counters) {
      const key = element.dataset.total;
      if (key !== 'settlements' && key !== 'fthgTransactions' && key !== 'metal' && key !== 'population' && key !== 'fthg' && key !== 'dollars') throw new Error('Unknown public statistic.');
      const target = key === 'dollars' ? dollarsUnits(data[key]) : key === 'fthg' ? Math.floor(fthgUnits(data[key]) / fthgScale) : data[key];
      const text = key === 'dollars' ? formatDollars(data.dollars, languageLocale) : target.toLocaleString(languageLocale);
      element.parentElement!.setAttribute('aria-label', text);
      element.title = text;
      counter.set(target, !document.hidden && !reducedMotion.matches);
    }
    document.querySelectorAll<HTMLElement>('[data-public-gold-rate]').forEach(element => {
      element.textContent = formatDollars(data.goldRate, languageLocale);
    });
    hasStats = true;
    const message = translate('Live snapshot \u00b7 updates about every 30s', language);
    if (statsStatus.textContent !== message) statsStatus.textContent = message;
    statsStatus.dataset.state = 'live';
    statsPanel.dataset.state = 'live';
    liveCards.forEach(cards => { cards.dataset.state = 'live'; });
    statsStatus.title = translate(`Server snapshot: ${new Date(data.updatedAt).toLocaleString(languageLocale)}`, language);
  } catch (error) {
    console.error('Unable to refresh public statistics', error);
    counters.forEach(({ counter }) => counter.finish());
    const message = translate(hasStats ? 'Last known totals \u00b7 updates paused, retrying shortly' : 'Live totals unavailable \u00b7 retrying shortly', language);
    if (statsStatus.textContent !== message) statsStatus.textContent = message;
    statsStatus.dataset.state = 'stale';
    statsPanel.dataset.state = 'stale';
    liveCards.forEach(cards => { cards.dataset.state = 'stale'; });
  } finally {
    statsLoading = false;
    nextStatsRefresh = performance.now() + 30000 + Math.random() * 5000;
    scheduleStats();
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
