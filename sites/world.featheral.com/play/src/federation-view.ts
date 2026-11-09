import type { ApiState, FederationVault } from './api-types.ts';
import { canAfford, diplomacyCosts } from './engine.ts';
import type { Cost } from './engine.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatResourceAmount } from './resource-units.ts';
import { marketResources as resources, marketBasePrice } from './market.ts';
import type { Resource } from './engine.ts';

export function federationPanel(state: ApiState, language: Language): string {
  const game = state.game, member = !!game.federation, voted = game.votes.includes('watershed');
  const t = (text: string) => translate(text, language);
  const escape = (text: string) => text.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const fmt = (number: number) => number.toLocaleString(locale(language));
  const costs = (cost: Cost) => Object.entries(cost).map(([resource, amount]) =>
    `<span>${icon(resource)}${formatResourceAmount(resource, amount, locale(language))}</span>`).join('');
  const vault = state.federationVault;
  const amounts = (stock: FederationVault['stock']) => [...resources, 'dollars'].map(asset =>
    `<span>${icon(asset)}${asset === 'dollars' ? `${stock.dollars.toLocaleString(locale(language), { maximumFractionDigits: 2 })} FTH$`
      : formatResourceAmount(asset, stock[asset as Resource], locale(language))}</span>`).join('');
  const percent = (value: number) => `${value.toLocaleString(locale(language), { maximumFractionDigits: 2 })}%`;
  const vaultPanel = !member ? '' : `<section class="federation-vault" aria-labelledby="federation-vault-title">
    <header><h3 id="federation-vault-title">${t('Common resources vault')}</h3><span>${t('Game year')} ${fmt(vault?.year ?? state.environment.year)}</span></header>
    ${vault ? `<div class="federation-vault-totals"><div><small>${t('All-time contributions / vault balance')}</small><div class="federation-cost">${amounts(vault.stock)}</div></div>
      <div><small>${t('This game year')}</small><div class="federation-cost">${amounts(vault.annualContributed)}</div></div></div>
      <div class="federation-deposit"><label>${t('Asset')}<select id="federation-asset">${[...resources, 'dollars'].map(asset =>
        `<option value="${asset}">${asset === 'dollars' ? 'FTH$' : `${t(asset[0].toUpperCase() + asset.slice(1))} · ${formatResourceAmount(asset, 1, locale(language))}`}</option>`).join('')}</select></label>
        <label>${t('Amount (lots / FTH$)')}<input id="federation-amount" type="number" min="0.0001" max="100000000" step="any" inputmode="decimal" placeholder="0"></label>
        <button class="button primary" data-action="federation-contribute">${t('Contribute')}</button></div>
      <p class="fineprint">${t('Available to contribute')} · <span class="federation-cost">${amounts({ ...game.stock, dollars: state.dollars })}</span></p>
      <p class="fineprint">${t('Fixed base valuation')} · ${resources.map(asset => `${formatResourceAmount(asset, 1, locale(language))} ${t(asset[0].toUpperCase() + asset.slice(1))}: ${marketBasePrice(asset)} FTH$`).join(' · ')}</p>
      <div class="federation-contributions-scroll"><table class="federation-contributions"><thead><tr><th>${t('Settlement')}</th><th>${t('All-time contributions')}</th><th>${t('This game year')}</th><th>${t('Contribution share')}</th></tr></thead>
      <tbody>${vault.contributors.length ? vault.contributors.map(member => `<tr><th scope="row" title="${escape(member.id)}">${escape(member.name)}${member.yours ? ` <small>(${t('You')})</small>` : ''}</th>
        <td><div class="federation-cost">${amounts(member.contributed)}</div></td><td><div class="federation-cost">${amounts(member.annualContributed)}</div></td>
        <td><strong>${percent(member.allTimePercent)}</strong> <small>${t('All time')}</small><br><strong>${percent(member.annualPercent)}</strong> <small>${t('This game year')}</small></td></tr>`).join('')
        : `<tr><td colspan="4">${t('No contributions yet.')}</td></tr>`}</tbody></table></div>
      <p class="fineprint">${t('Annual contribution shares are reserved for future federation tax payouts. Tax collection, payout rate and eligibility are pending.')}</p>
      <p class="fineprint">${t('Contributions are permanent. No withdrawal or payout is currently available.')}</p>`
      : `<p role="status">${t('Federation vault is unavailable.')}</p>`}</section>`;
  const joinReason = game.stage < 3 ? 'Reach Village to join.' : game.relationship < 50 ? 'Build relations to 50 to join.' : '';
  const formReason = member ? 'Already a federation member.' : game.stage < 6 ? 'Reach City to found a federation.'
    : game.population <= 10000 ? 'Requires more than 10,000 residents.' : !canAfford(game, diplomacyCosts.form) ? 'Not enough Metal to found a federation.' : '';
  const voteReason = voted ? 'Your vote is recorded.' : !member ? 'Join a federation to vote.'
    : !game.townhall || game.stage < 4 ? 'Reach Town and build a town hall to vote.' : '';
  const action = (id: string, label: string, reason: string, primary = false) =>
    `<button class="button${primary ? ' primary' : ''}" data-action="${id}" aria-describedby="federation-${id}-reason" ${reason ? 'disabled' : ''}>${t(label)}</button>`;
  return `<div class="federation-banner">${icon('federation')}<div><span class="eyebrow">${t(member ? 'MEMBER' : 'NEARBY')}</span><h2>${escape(game.federation ?? t('Evergreen Union'))}</h2></div>${member ? `<a class="button" href="/communicate/?channel=federation">${icon('communicate')}${t('Federation chat')}</a>` : ''}</div>
    <div class="federation-metrics"><div><small>${t('Relationship')}</small><strong>${game.relationship}<small>/100</small></strong><progress value="${game.relationship}" max="100" aria-label="${t('Relationship')}"></progress></div><div><small>${t('Simulation points')}</small><strong>${fmt(game.contribution)}</strong><small>${t('Separate from vault contributions')}</small></div><div><small>${t('Assembly')}</small><strong>${voted ? '1 / 1' : '0 / 1'}</strong><small>${t(voted ? 'Voted' : 'Not voted')}</small></div></div>
    <div class="federation-actions-grid">
      <section class="federation-action-card"><h3>${t(member ? 'Membership' : 'Join Evergreen Union')}</h3><p>${t('Member bonus: +20% Metal output for new weekly crews.')}</p>
      ${member ? `<span class="federation-state">${icon('check')}${t('Member')}</span>` : `<div class="federation-cost">${costs(diplomacyCosts.gift)}</div><small>${t('Goodwill adds 25 relationship points.')}</small><div class="panel-actions">${action('gift', 'Send goodwill', canAfford(game, diplomacyCosts.gift) ? '' : 'Not enough supplies for goodwill.')}${action('join', 'Join', joinReason, true)}</div><p id="federation-gift-reason" class="fineprint">${t(canAfford(game, diplomacyCosts.gift) ? '' : 'Not enough supplies for goodwill.')}</p><p id="federation-join-reason" class="fineprint">${t(joinReason || 'Ready to join. No joining fee.')}</p>`}</section>
      <section class="federation-action-card"><h3>${t('Found federation')}</h3><div class="federation-cost">${costs(diplomacyCosts.form)}</div><p>${t('City · more than 10,000 residents')}</p>${action('form', 'Found', formReason)}<p id="federation-form-reason" class="fineprint">${t(formReason || 'Ready to found. Review the material cost first.')}</p></section>
      <section class="federation-action-card"><h3>${t('Restore watershed')}</h3><p>${t('Assembly proposal · simulation only')}</p>${action('vote', voted ? 'Voted' : 'Vote', voteReason, true)}<p id="federation-vote-reason" class="fineprint">${t(voteReason || 'Record your support. No payment required.')}</p>${!game.townhall ? `<a href="/settlement/#buildings">${t('Build town hall')}</a>` : ''}</section>
    </div>${vaultPanel}<p class="fineprint federation-disclaimer">${icon('lock')}${t('Assembly is simulation only. Game resources are not FTHG. Vault FTH$ uses the existing World budget; no new currency is issued.')}</p>`;
}
