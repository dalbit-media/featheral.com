import { readAtlas } from './api.ts';
import { atlasSize, escapeAtlas as escape, federationArt, generatedAvatar, isRankingMetric, nearbyDistance, rankEntries, rankingMetrics, territoryAt } from './atlas.ts';
import type { AtlasEntry, AtlasSnapshot, RankingMetric } from './atlas.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { stages } from './engine.ts';

const metricLabels: Record<RankingMetric, string> = {
  population: 'Population', netWorth: 'Net worth', dollars: 'FTH$ balance',
  stage: 'Settlement tier', explored: 'Explored tiles', contribution: 'Simulation points',
};
export function atlasMap(snapshot: AtlasSnapshot, language: Language): string {
  const settlements = snapshot.entries.filter(entry => entry.location);
  const colors = new Map(snapshot.federations.map(federation => [federation.name, federation.color]));
  const cells: (string | null)[][] = [];
  const resolution = 40, step = atlasSize / resolution;
  for (let y = 0; y < resolution; y++) {
    cells[y] = [];
    for (let x = 0; x < resolution; x++) cells[y][x] = territoryAt({ x: (x + .5) * step, y: (y + .5) * step }, settlements);
  }
  let territories = '', borders = '';
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const federation = cells[y][x];
    if (federation) territories += `<rect x="${x * step}" y="${y * step}" width="${step}" height="${step}" fill="${colors.get(federation)}" opacity=".6"/>`;
    if (x && federation !== cells[y][x - 1]) borders += `M${x * step} ${y * step}v${step}`;
    if (y && federation !== cells[y - 1][x]) borders += `M${x * step} ${y * step}h${step}`;
  }
  return `<svg class="atlas-map" viewBox="-20 -20 ${atlasSize + 40} ${atlasSize + 40}" role="img" aria-label="${escape(translate('Settlement atlas and federation territories', language))}">
    <rect width="${atlasSize}" height="${atlasSize}" fill="#14251f"/>${territories}
    <path d="${borders}" stroke="#e0ebd5" stroke-width="2" fill="none" opacity=".7"/>
    ${settlements.map(entry => `<g><title>${escape(entry.settlement!)} (${entry.location!.x}, ${entry.location!.y}) - ${escape(entry.federation ?? translate('Independent', language))}</title>
      <circle cx="${entry.location!.x}" cy="${entry.location!.y}" r="${entry.yours ? 9 : 4}" fill="${entry.yours ? '#ffdf81' : '#fff'}" stroke="#101d17" stroke-width="2"/>
      ${entry.yours ? `<circle cx="${entry.location!.x}" cy="${entry.location!.y}" r="16" fill="none" stroke="#ffdf81" stroke-width="3"/>` : ''}</g>`).join('')}
  </svg>`;
}
export class AtlasPage {
  private readonly root: HTMLElement;
  private readonly language: Language;
  private readonly geography: boolean;
  private snapshot: AtlasSnapshot | null = null;
  private metric: RankingMetric = 'population';
  private scope: 'players' | 'settlements' = 'settlements';
  private query = '';
  private nearby = false;
  private page = 0;
  private loading = false;
  private error = '';
  private map = '';
  constructor(root: HTMLElement, language: Language, geography: boolean) {
    this.root = root; this.language = language; this.geography = geography;
    root.addEventListener('change', event => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) return;
      if (target.dataset.atlasControl === 'metric' && isRankingMetric(target.value)) this.metric = target.value;
      if (target.dataset.atlasControl === 'scope' && (target.value === 'players' || target.value === 'settlements')) this.scope = target.value;
      if (target.dataset.atlasControl === 'nearby' && target instanceof HTMLInputElement) this.nearby = target.checked;
      this.page = 0; this.render();
    });
    root.addEventListener('input', event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.dataset.atlasControl !== 'search') return;
      this.query = event.target.value; this.page = 0; this.renderTable();
    });
    root.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('[data-atlas-action]');
      if (!button || button.disabled) return;
      if (button.dataset.atlasAction === 'refresh') void this.load();
      else { this.page += button.dataset.atlasAction === 'next' ? 1 : -1; this.renderTable(); }
    });
    void this.load();
  }
  private t(text: string): string { return translate(text, this.language); }
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true; this.error = ''; this.render();
    try {
      this.snapshot = await readAtlas();
      this.map = this.geography ? atlasMap(this.snapshot, this.language) : '';
    } catch (error) {
      console.error('World atlas:', error);
      this.error = error instanceof Error ? error.message : 'World atlas is unavailable.';
    } finally { this.loading = false; this.render(); }
  }
  private rows(): AtlasEntry[] {
    const query = this.query.toLocaleLowerCase();
    const entries = (this.snapshot?.entries ?? []).filter(entry =>
      (this.scope === 'players' || entry.settlement !== null)
      && (!this.nearby || entry.distance !== null && entry.distance <= nearbyDistance)
      && `${entry.player} ${entry.settlement ?? ''} ${entry.federation ?? ''}`.toLocaleLowerCase().includes(query));
    return this.geography ? entries.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.id.localeCompare(b.id)) : rankEntries(entries, this.metric);
  }
  private render(): void {
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)
      ? document.activeElement.dataset.atlasControl : undefined;
    const t = (text: string) => this.t(text), snapshot = this.snapshot;
    const own = snapshot?.entries.find(entry => entry.yours);
    this.root.innerHTML = `<header class="page-heading"><span class="page-emblem">${icon(this.geography ? 'atlas' : 'hall')}</span><div><span class="eyebrow">${t('YOUR WORLD, CONNECTED')}</span><h1>${t(this.geography ? 'Settlement atlas' : 'Hall of Fame')}</h1><p>${t(this.geography ? 'Find your neighbors and discover federation territories.' : 'Every player. Every settlement. A shared history of growth.')}</p></div>
      <a class="button" href="${this.geography ? '/hall-of-fame/' : '/atlas/'}">${icon(this.geography ? 'hall' : 'atlas')}${t(this.geography ? 'Hall of Fame' : 'Settlement atlas')}</a></header>
      <section class="page-card atlas-controls"><label>${t('Rankings')}<select data-atlas-control="scope"><option value="settlements" ${this.scope === 'settlements' ? 'selected' : ''}>${t('Settlements')}</option><option value="players" ${this.scope === 'players' ? 'selected' : ''}>${t('Players')}</option></select></label>
      ${!this.geography ? `<label>${t('Rank by')}<select data-atlas-control="metric">${rankingMetrics.map(metric => `<option value="${metric}" ${metric === this.metric ? 'selected' : ''}>${t(metricLabels[metric])}</option>`).join('')}</select></label>` : ''}
      <label>${t('Search')}<input type="search" data-atlas-control="search" value="${escape(this.query)}" placeholder="${t('Player, settlement or federation')}"></label>
      <label class="atlas-nearby"><input type="checkbox" data-atlas-control="nearby" ${this.nearby ? 'checked' : ''} ${own?.location ? '' : 'disabled'}>${t('Nearby (100 km)')}</label>
      <button class="button" data-atlas-action="refresh" ${this.loading ? 'disabled' : ''}>${icon('refresh')}${t('Refresh')}</button></section>
      <p role="status" class="${this.error ? 'notice' : 'fineprint'}">${this.error ? escape(this.error) : this.loading ? t('Loading world rankings...') : snapshot ? `${t('Last updated')}: ${new Date(snapshot.updatedAt).toLocaleString(locale(this.language))}` : ''}</p>
      ${own?.location ? `<p class="fineprint">${t('Your settlement location')}: (${own.location.x}, ${own.location.y}) km</p>` : `<p class="fineprint">${t('Establish a settlement to see distances and nearby neighbors.')}</p>`}
      ${this.geography && snapshot ? `<section class="page-card atlas-geography">${this.map}<div class="atlas-legend"><h2>${t('Federation territories')}</h2><p>${t('Automatic nearest-settlement territories, shown on a 25 km grid. Independent settlements leave neutral territory. Borders are informational, not land claims.')}</p>
      ${snapshot.federations.map(federation => `<div class="atlas-legend-row">${federationArt(federation.name, 'shield')}<span data-no-localize><strong>${escape(federation.name)}</strong><small>${escape(federation.motto)}</small></span><span>${federation.members} ${t('Settlements')}</span></div>`).join('')}
      <p>${t('Coordinates and straight-line distances use game kilometers, not real-world locations. Local exploration maps are unchanged.')}</p></div></section>` : ''}
      <section class="page-card atlas-results" data-atlas-table></section>
      <p class="fineprint">${t('Net worth = FTH$ balance + owned resources and items + open market escrow, valued at fixed base prices. Uncollected production, buildings, federation donations and external wallets are excluded. Rankings use the latest saved state, not live offline projections.')}</p>`;
    this.renderTable();
    if (focused) this.root.querySelector<HTMLElement>(`[data-atlas-control="${focused}"]`)?.focus({ preventScroll: true });
  }
  private renderTable(): void {
    const root = this.root.querySelector<HTMLElement>('[data-atlas-table]');
    if (!root) return;
    const entries = this.rows(), t = (text: string) => this.t(text);
    const pages = Math.max(1, Math.ceil(entries.length / 25));
    const showLocation = !this.geography && (this.metric === 'population' || this.metric === 'netWorth');
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const format = (value: number) => value.toLocaleString(locale(this.language), { maximumFractionDigits: 2 });
    root.innerHTML = `<div class="atlas-table-scroll"><table><thead><tr><th>${t('Rank')}</th><th>${t(this.scope === 'players' ? 'Player' : 'Settlement')}</th><th>${t('Federation')}</th><th>${t('Population')}</th><th>${t('Net worth')}</th><th>${t(this.geography ? 'Distance' : showLocation ? 'Settlement location' : metricLabels[this.metric])}</th></tr></thead><tbody>
      ${entries.slice(this.page * 25, (this.page + 1) * 25).map((entry, index) => `<tr class="${entry.yours ? 'atlas-yours' : ''}"><td>${this.page * 25 + index + 1}</td>
      <th scope="row"><div class="atlas-name">${generatedAvatar(entry.id)}<span data-no-localize><strong>${escape(this.scope === 'players' ? entry.player : entry.settlement!)}</strong><small>${escape(this.scope === 'players' ? entry.settlement ?? t('Unsettled') : entry.player)}${entry.yours ? ` (${t('You')})` : ''}</small>${this.geography && entry.location ? `<small>(${entry.location.x}, ${entry.location.y}) km</small>` : ''}</span></div></th>
      <td>${entry.federation ? `<div class="atlas-name">${federationArt(entry.federation, 'shield')}<span data-no-localize>${escape(entry.federation)}</span></div>` : t('Independent')}</td><td>${format(entry.population)}</td><td>${format(entry.netWorth)} FTH$</td>
      <td>${this.geography ? entry.distance === null ? '-' : `${format(entry.distance)} km` : showLocation ? entry.location ? `(${entry.location.x}, ${entry.location.y}) km` : '-' : this.metric === 'stage' ? t(stages[entry.stage]?.name ?? 'Unsettled') : `${format(entry[this.metric])}${this.metric === 'dollars' ? ' FTH$' : ''}`}</td></tr>`).join('') || `<tr><td colspan="6">${t('No matching players or settlements.')}</td></tr>`}
      </tbody></table></div><div class="atlas-pagination"><span>${format(entries.length)} ${t('Results')} - ${this.page + 1} / ${pages}</span><button class="button" data-atlas-action="previous" ${this.page === 0 ? 'disabled' : ''}>${t('Previous')}</button><button class="button" data-atlas-action="next" ${this.page + 1 >= pages ? 'disabled' : ''}>${t('Next')}</button></div>`;
  }
}
