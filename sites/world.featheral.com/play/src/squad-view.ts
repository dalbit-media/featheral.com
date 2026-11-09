import type { Snapshot } from './api-types.ts';
import { escapeAtlas as escape } from './atlas.ts';
import { formatDollars } from './dollars.ts';
import { isSquadItem, planSquad, squadItems, squadKeys } from './exploration-squads.ts';
import type { SquadItem } from './exploration-squads.ts';
import { itemArt } from './item-art.ts';
import { sellableItemCount } from './items.ts';
import { translate, locale } from './i18n.ts';
import type { Language } from './i18n.ts';

export function squadPanel(state: Snapshot, language: Language, selected?: SquadItem): string {
  const t = (text: string) => escape(translate(text, language));
  const plans = { exploration: planSquad(state.game, state.workforce, 'exploration', 100),
    investigation: planSquad(state.game, state.workforce, 'investigation', 100) };
  const blocked = state.game.stage < 0 || state.waterUpkeep?.paused || state.settlementUpkeep?.paused;
  return `<section class="squad-panel" aria-label="${t('Bulk field missions')}"><h3>${t('Bulk field missions')}</h3><p>${t('Choose a voucher and launch together. Targets are automatic; each mission needs two available residents.')}</p>
    <p>${t('Fees still double for every active team. The preview may launch fewer missions than the voucher maximum.')}</p>
    <div class="squad-options">${(selected && isSquadItem(selected) ? [selected] : squadKeys).map(item => {
      const recipe = squadItems[item], owned = sellableItemCount(state.inventory, item);
      return `<article class="squad-option">${itemArt(item)}<div><strong>${t(recipe.name)}</strong><small>${t('Owned')}: ${owned}</small></div>
        ${owned ? (['exploration', 'investigation'] as const).map(activity => {
          const missions = plans[activity].missions.slice(0, recipe.quantity);
          const cost = missions.reduce((sum, mission) => sum + mission.dollars, 0);
          return `<button class="button" data-action="dispatch-squad" data-item="${item}" data-activity="${activity}" ${blocked || !missions.length ? 'disabled' : ''}><span>${t(activity === 'exploration' ? 'Explore' : 'Investigate')} · ${missions.length} / ${recipe.quantity}</span><small>${formatDollars(cost, locale(language))} FTH$ · ${missions.length * 2} ${t('residents')}</small></button>`;
        }).join('') : `<a class="button" href="/market/?asset=${item}&side=buy">${t('Buy voucher')}</a>`}</article>`;
    }).join('')}</div>
    ${blocked ? `<p role="status">${t('Settlement and adequate supplies are required for squad dispatch.')}</p>` : ''}
    <p>${t('One voucher is consumed only after confirmation. Canceling or a failed dispatch consumes nothing.')}</p></section>`;
}
