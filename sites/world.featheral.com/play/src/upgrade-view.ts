import type { ApiState } from './api-types.ts';
import { buildingCosts, stages } from './engine.ts';
import type { Cost, Resource } from './engine.ts';
import { constructionCost, constructionKeys, constructionLevel, constructions } from './constructions.ts';
import { maximumUpgradeLevel } from './costs.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { incomeFacilities } from './income.ts';
import { formatResourceAmount } from './resource-units.ts';
import { resourceCapacity, resourceKeys, warehouseCapacity } from './workforce.ts';
import { waterFacilities, waterFacilityKeys } from './water-facilities.ts';

interface UpgradeCard {
  id: string;
  name: string;
  symbol: string;
  level: number;
  maximum: number;
  stage: number;
  cost: Cost | null;
  benefit: string;
  preview?: string;
  action: 'warehouse' | 'construction' | 'income-facility' | 'water-facility' | 'bank' | 'townhall';
  attributes?: string;
}
function upgradeCard(state: ApiState, card: UpgradeCard, language: Language): string {
  const t = (text: string) => translate(text, language), loc = locale(language);
  const complete = card.level >= card.maximum, locked = state.game.stage < card.stage;
  const entries = Object.entries(card.cost ?? {}).filter(([, amount]) => amount > 0);
  const owned = (asset: string) => asset === 'dollars' ? state.dollars : state.game.stock[asset as Resource];
  const missing = entries.some(([asset, amount]) => owned(asset) < amount);
  const amount = (asset: string, value: number) => asset === 'dollars' ? `${value.toLocaleString(loc, { maximumFractionDigits: 4 })} FTH$` : formatResourceAmount(asset, value, loc);
  const label = complete ? card.maximum === 1 ? 'Built' : 'Maximum level' : locked ? 'Locked' : missing ? 'Missing supplies' : card.level ? 'Ready to upgrade' : 'Ready to build';
  const button = card.level ? 'Review upgrade' : 'Review build';
  const eligible = !locked && !missing && Boolean(card.cost);
  const ready = entries.filter(([asset, required]) => owned(asset) >= required).length;
  return `<article class="upgrade-option${complete ? ' is-complete' : ''}" aria-labelledby="${card.id}-name">
    <header class="upgrade-option-heading"><span class="upgrade-option-icon">${icon(card.symbol)}</span><div><h3 id="${card.id}-name">${t(card.name)}</h3><small>${t('Level')} ${card.level} / ${card.maximum}</small></div><span class="upgrade-option-status">${t(label)}</span></header>
    <p class="upgrade-option-benefit">${t(card.benefit)}</p>
    ${complete ? '' : `<div class="consumption-costs" aria-label="${t('Upgrade cost')}">${entries.map(([asset, required]) => `<span class="cost${owned(asset) < required ? ' insufficient' : ''}" title="${t('Owned')}: ${amount(asset, owned(asset))}">${icon(asset)}<strong>${amount(asset, required)}</strong></span>`).join('')}</div>
      <details class="upgrade-details recipe-details" data-detail="${card.id}-recipe"><summary><span>${t('Recipe')}</span> <strong>${ready}/${entries.length}</strong>${icon('chevron')}</summary>
      <p class="upgrade-option-next">${t('Next level')}: <strong>${card.level + 1}</strong></p>
      ${card.preview ? `<div class="upgrade-option-preview">${card.preview}</div>` : ''}
      ${locked ? `<p class="upgrade-option-lock">${icon('lock')}<span>${t('Requires settlement tier')}: ${t(stages[card.stage].name)}</span></p>` : ''}
      <div class="upgrade-option-costs"><div class="upgrade-cost-head"><span>${t('Upgrade cost')}</span></div>${entries.map(([asset, required]) => {
        const shortage = Math.max(0, required - owned(asset));
        return `<div class="upgrade-cost-row${shortage ? ' insufficient' : ''}"><span>${icon(asset)}<span>${asset === 'dollars' ? 'FTH$' : t(asset[0].toUpperCase() + asset.slice(1))}</span></span><strong>${amount(asset, required)}</strong><small>${t('Owned')}: ${amount(asset, owned(asset))}</small>${shortage ? `<span class="upgrade-cost-shortfall">${t('Missing')}: ${amount(asset, shortage)}</span>` : ''}</div>`;
      }).join('')}</div>
      </details><button class="button primary compact-item-action" data-action="${card.action}" ${card.attributes ?? ''} data-action-eligible="${eligible}" aria-label="${t(button)}: ${t(card.name)}, ${t('Level')} ${card.level + 1}" title="${t(button)}: ${t(card.name)} · ${t(label)}" ${!eligible ? 'disabled' : ''}>${icon(eligible ? 'plus' : 'lock')}<span class="control-label">${t(button)}</span><span class="action-feedback" role="status"></span></button>`}
  </article>`;
}
export function warehouseUpgradeCard(state: ApiState, language: Language): string {
  const t = (text: string) => translate(text, language), next = warehouseCapacity(state.game, state.warehouse + 1);
  const preview = state.warehouse >= maximumUpgradeLevel ? '' : `<span>${t('Capacity after upgrade')}</span><ul class="upgrade-capacity">${resourceKeys.map(resource =>
    `<li><span>${icon(resource)}${t(resource[0].toUpperCase() + resource.slice(1))}</span><strong>${formatResourceAmount(resource, resourceCapacity(state.capacity, resource, state.game), locale(language))} → ${formatResourceAmount(resource, resourceCapacity(next, resource, state.game), locale(language))}</strong></li>`).join('')}</ul>`;
  return upgradeCard(state, { id: 'upgrade-warehouse', name: 'Resource warehouse', symbol: 'warehouse', level: state.warehouse,
    maximum: maximumUpgradeLevel, stage: 0, cost: state.warehouseCost, benefit: 'Storage scales with tier and warehouse level',
    action: 'warehouse', preview }, language);
}
export function constructionUpgradeCards(state: ApiState, language: Language): string {
  const t = (text: string) => translate(text, language);
  return `<div class="upgrade-options">${constructionKeys.map(kind => {
    const facility = constructions[kind], level = constructionLevel(state.game, kind);
    const change = (current: string, next: string) => `${t('Current')}: <strong>${current}</strong> → ${t('Next level')}: <strong>${next}</strong>`;
    const upgraded = { ...state.game, constructionLevels: { ...state.game.constructionLevels, [kind]: level + 1 } };
    const preview = level >= facility.maxLevel ? '' : kind === 'cistern'
      ? change(formatResourceAmount('water', resourceCapacity(state.capacity, 'water', state.game), locale(language)), formatResourceAmount('water', resourceCapacity(state.capacity, 'water', upgraded), locale(language)))
      : kind === 'logistics' ? change(t(`${level * 2} tiles`), t(`${(level + 1) * 2} tiles`))
        : change(`+${level * 25}%`, `+${(level + 1) * 25}%`);
    return upgradeCard(state, { id: `upgrade-${kind}`, name: facility.name, symbol: kind === 'housing' ? 'people' : kind === 'cistern' ? 'water' : kind === 'workshop' ? 'tools' : 'market',
      level, maximum: facility.maxLevel, stage: facility.stage, cost: constructionCost(state.game, kind), benefit: facility.benefit,
      preview, action: 'construction', attributes: `data-construction="${kind}"` }, language);
  }).join('')}</div>`;
}
export function commercialUpgradeCards(state: ApiState, language: Language): string {
  const facility = incomeFacilities['market-stall'];
  return `<div class="upgrade-options">${upgradeCard(state, { id: 'upgrade-market-stall', name: facility.name, symbol: 'market', level: state.game.incomeFacilities?.['market-stall'] ? 1 : 0,
    maximum: 1, stage: facility.stage, cost: facility.cost, benefit: 'No automatic FTH$ income', action: 'income-facility', attributes: 'data-facility="market-stall"' }, language)}</div>`;
}
export function waterUpgradeCards(state: ApiState, language: Language): string {
  return `<div class="upgrade-options">${waterFacilityKeys.map(key => {
    const facility = waterFacilities[key];
    return upgradeCard(state, { id: `water-facility-${key}`, name: facility.name, symbol: key, level: state.game.waterFacilities?.[key] ? 1 : 0,
      maximum: 1, stage: 0, cost: facility.cost, benefit: `${translate('Water output', language)} +${facility.bonus * 100}%`,
      action: 'water-facility', attributes: `data-facility="${key}"` }, language);
  }).join('')}</div>`;
}
export function civicUpgradeCards(state: ApiState, language: Language): string {
  return `<div class="upgrade-options">${upgradeCard(state, { id: 'upgrade-bank', name: 'City bank', symbol: 'bank', level: state.game.bank ? 1 : 0, maximum: 1, stage: 6,
    cost: buildingCosts.bank, benefit: 'Oil collection and resource trading', action: 'bank' }, language)}
    ${upgradeCard(state, { id: 'upgrade-townhall', name: 'Town hall', symbol: 'home', level: state.game.townhall ? 1 : 0, maximum: 1, stage: 4,
      cost: buildingCosts.townhall, benefit: 'Federation voting', action: 'townhall' }, language)}</div>`;
}
