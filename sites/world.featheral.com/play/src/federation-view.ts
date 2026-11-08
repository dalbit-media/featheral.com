import type { ApiState } from './api-types.ts';
import { canAfford, diplomacyCosts } from './engine.ts';
import type { Cost } from './engine.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount } from './resource-units.ts';

export function federationPanel(state: ApiState, language: Language): string {
  const game = state.game, member = !!game.federation, voted = game.votes.includes('watershed');
  const t = (text: string) => translate(text, language);
  const escape = (text: string) => text.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const fmt = (number: number) => number.toLocaleString(locale(language));
  const costs = (cost: Cost) => Object.entries(cost).map(([resource, amount]) =>
    `<span>${icon(resource)}${formatResourceAmount(resource, amount, locale(language))}</span>`).join('');
  const joinReason = game.stage < 3 ? 'Reach Village to join.' : game.relationship < 50 ? 'Build relations to 50 to join.' : '';
  const formReason = member ? 'Already a federation member.' : game.stage < 6 ? 'Reach City to found a federation.'
    : game.population <= 10000 ? 'Requires more than 10,000 residents.' : !canAfford(game, diplomacyCosts.form) ? 'Not enough Metal to found a federation.' : '';
  const voteReason = voted ? 'Your vote is recorded.' : !member ? 'Join a federation to vote.'
    : !game.townhall || game.stage < 4 ? 'Reach Town and build a town hall to vote.' : '';
  const action = (id: string, label: string, reason: string, primary = false) =>
    `<button class="button${primary ? ' primary' : ''}" data-action="${id}" aria-describedby="federation-${id}-reason" ${reason ? 'disabled' : ''}>${t(label)}</button>`;
  return `<div class="federation-banner">${icon('federation')}<div><span class="eyebrow">${t(member ? 'MEMBER' : 'NEARBY')}</span><h2>${escape(game.federation ?? t('Evergreen Union'))}</h2></div>${member ? `<a class="button" href="/communicate/?channel=federation">${icon('communicate')}${t('Federation chat')}</a>` : ''}</div>
    <div class="federation-metrics"><div><small>${t('Relationship')}</small><strong>${game.relationship}<small>/100</small></strong><progress value="${game.relationship}" max="100" aria-label="${t('Relationship')}"></progress></div><div><small>${t('CONTRIBUTION')}</small><strong>${fmt(game.contribution)}</strong><small>${t('Simulation points')}</small></div><div><small>${t('Assembly')}</small><strong>${voted ? '1 / 1' : '0 / 1'}</strong><small>${t(voted ? 'Voted' : 'Not voted')}</small></div></div>
    <div class="federation-actions-grid">
      <section class="federation-action-card"><h3>${t(member ? 'Membership' : 'Join Evergreen Union')}</h3><p>${t('Member bonus: +20% Metal output for new weekly crews.')}</p>
      ${member ? `<span class="federation-state">${icon('check')}${t('Member')}</span>` : `<div class="federation-cost">${costs(diplomacyCosts.gift)}</div><small>${t('Goodwill adds 25 relationship points.')}</small><div class="panel-actions">${action('gift', 'Send goodwill', canAfford(game, diplomacyCosts.gift) ? '' : 'Not enough supplies for goodwill.')}${action('join', 'Join', joinReason, true)}</div><p id="federation-gift-reason" class="fineprint">${t(canAfford(game, diplomacyCosts.gift) ? '' : 'Not enough supplies for goodwill.')}</p><p id="federation-join-reason" class="fineprint">${t(joinReason || 'Ready to join. No joining fee.')}</p>`}</section>
      <section class="federation-action-card"><h3>${t('Found federation')}</h3><div class="federation-cost">${costs(diplomacyCosts.form)}</div><p>${t('City · more than 10,000 residents')}</p>${action('form', 'Found', formReason)}<p id="federation-form-reason" class="fineprint">${t(formReason || 'Ready to found. Review the material cost first.')}</p></section>
      <section class="federation-action-card"><h3>${t('Restore watershed')}</h3><p>${t('Assembly proposal · simulation only')}</p>${action('vote', voted ? 'Voted' : 'Vote', voteReason, true)}<p id="federation-vote-reason" class="fineprint">${t(voteReason || 'Record your support. No payment required.')}</p>${!game.townhall ? `<a href="/settlement/#buildings">${t('Build town hall')}</a>` : ''}</section>
    </div><p class="fineprint federation-disclaimer">${icon('lock')}${t('Simulation only · Game metal is not FTHG · No monetary rewards or real authority')}</p>`;
}
