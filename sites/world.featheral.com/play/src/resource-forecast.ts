import type { Snapshot } from './api-types.ts';
import { icon } from './icons.ts';
import { translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount } from './resource-units.ts';

export function depletionForecast(owned: number, weeklyConsumption: number, shortage = false) {
  if (![owned, weeklyConsumption].every(value => Number.isFinite(value) && value >= 0))
    throw new RangeError('Invalid resource forecast.');
  const weeks = weeklyConsumption > 0 ? owned / weeklyConsumption : null;
  const status = shortage || weeks !== null && weeks < 1 / 7 ? 'critical'
    : weeks !== null && weeks <= 1 ? 'warning' : 'healthy';
  const reserves = Array.from({ length: 5 }, (_, week) => Math.max(0, owned - weeklyConsumption * week));
  return { weeks, status, reserves };
}

export function resourceForecastPanel(state: Snapshot, language: Language): string {
  if (!state.waterUpkeep) return '';
  const t = (text: string) => translate(text, language);
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const rows = (['water', 'wood', 'metal', 'oil'] as const).map(resource => {
    const upkeep = resource === 'water' ? state.waterUpkeep! : state.settlementUpkeep?.resources[resource];
    if (!upkeep || resource === 'oil' && !upkeep.weeklyConsumption) return '';
    const shortage = resource === 'water' ? state.waterUpkeep!.paused : state.settlementUpkeep!.resources[resource].shortage > 0;
    const forecast = depletionForecast(state.game.stock[resource], upkeep.weeklyConsumption, shortage);
    const amount = formatResourceAmount(resource, upkeep.weeklyConsumption, locale, true);
    const remaining = forecast.weeks === null ? t('No upkeep demand')
      : forecast.weeks === 0 ? t('Depleted') : `~${forecast.weeks.toLocaleString(locale, { maximumFractionDigits: 1 })} ${t('wk left')}`;
    const warning = forecast.status === 'critical' ? t('Supply shortage')
      : forecast.status === 'warning' ? t('Depletes within one week') : '';
    const name = t(resource[0].toUpperCase() + resource.slice(1));
    const maximum = Math.max(1, state.game.stock[resource], upkeep.weeklyConsumption);
    const points = forecast.reserves.map((value, week) => `${week * 25},${30 - value / maximum * 28}`).join(' ');
    return `<a class="reserve-forecast-row" data-risk="${forecast.status}" href="/market/?asset=${resource}&amp;side=buy" aria-label="${name}: ${amount} / ${t('game week')} · ${remaining}${warning ? ` · ${warning}` : ''}">
      <span class="reserve-forecast-name">${icon(resource)}${name}<strong>${remaining}</strong></span>
      <svg class="reserve-chart" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path class="reserve-grid" d="M0 30H100 M25 0V32 M50 0V32 M75 0V32"/><polygon points="0,30 ${points} 100,30"/><polyline points="${points}"/></svg>
      <span class="reserve-forecast-use">${amount} / ${t('game week')}${warning ? `<strong>${warning}</strong>` : ''}</span>
    </a>`;
  }).join('');
  return `<section class="reserve-forecast"><header><strong>${t('Reserve forecast')}</strong><a href="/settlement/#production">${t('Manage production')}</a></header>${rows}
    <div class="reserve-chart-axis" aria-hidden="true"><span>${t('Now')}</span><span>1 ${t('wk')}</span><span>2</span><span>3</span><span>4 ${t('wk')}</span></div>
    <p>${t('Current weekly demand; excludes future collections, crafting and trades. Climate and population can change demand.')}</p></section>`;
}
