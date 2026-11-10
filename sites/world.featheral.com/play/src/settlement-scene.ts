import { stages } from './engine.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { itemArt } from './item-art.ts';
import { isDecorationItem } from './items.ts';
import { homeCount, settlementBuildings, settlementEntityName, settlementPositions, settlementRadius } from './settlement-layout.ts';
import type { SettlementEntity } from './settlement-layout.ts';
import { isWaterFacility } from './water-facilities.ts';
import { buildingArt } from './building-art.ts';
import { itemDescription } from './item-details.ts';

export function settlementObjectDescription(id: SettlementEntity): string {
  if (isDecorationItem(id)) return itemDescription(id).use;
  if (id.startsWith('home-') || id === 'housing') return 'A home for your residents. Manage recruitment and crew assignments in Residents.';
  const descriptions = {
    centre: 'The heart of your settlement. Review tier requirements and resource reserves.',
    workshop: 'Craft tools, vouchers and decorations using discovered resources. Review every recipe before spending.',
    supplies: 'Stored items, equipped tools and pending finds. Identical copies share one slot.',
    bank: 'A civic building, not a source of free FTH$. Manage your balance and staking in Wallet.',
    townhall: 'A civic landmark. Building ownership does not grant automatic FTH$ income.',
    well: 'Increases Water output from assigned crews. Applies to the next work week.',
    rainCollector: 'Collects rain to increase Water output. Bonuses add to other Water facilities.',
    pumpingStation: 'Supports higher Water output. Assign crews and keep enough storage for deliveries.',
    'market-stall': 'Supports settlement trade. Sell owned resources in Marketplace; no automatic FTH$ income.',
    'trade-hub': 'Improves collection routes through logistics upgrades. Transport remains a paid service.',
    cistern: 'Expands Water reserves through upgrades. Capacity is separate from Water production.',
  };
  return descriptions[id as keyof typeof descriptions];
}
function settlementObjectSymbol(id: SettlementEntity): string {
  return isWaterFacility(id) ? id : id.startsWith('home-') || id === 'housing' ? 'home'
    : id === 'workshop' ? 'tool' : id === 'supplies' ? 'warehouse' : id === 'bank' ? 'bank'
      : id === 'townhall' ? 'hall' : id === 'cistern' ? 'water' : id === 'centre' ? 'flag' : 'market';
}

export function settlementProfile(stage: number): { name: string; homes: number; style: string; description: string } {
  return {
    name: stage < 0 ? 'Unsettled' : stages[stage].name, homes: homeCount(stage),
    style: stage >= 14 ? 'megacity' : stage >= 12 ? 'global-city' : stage >= 6 ? 'city' : stage >= 4 ? 'town' : stage >= 3 ? 'village' : 'camp',
    description: stage >= 9 ? 'A growing skyline of connected districts, green rooftops and millions of residents.'
      : stage >= 6 ? 'A city of busy streets and little places to call your own.'
      : stage >= 3 ? 'Gather around the square. Make every corner feel like home.'
        : 'A quiet clearing today. A place full of life tomorrow.',
  };
}
export function settlementScene(state: ApiState, language: Language, editing = false): string {
  const { game, inventory: bag, environment } = state, profile = settlementProfile(game.stage);
  const decorations = Object.keys(settlementPositions(game, bag)).filter(isDecorationItem).length;
  const buildings = settlementBuildings(game).length;
  const readyResources = Object.values(state.pending).filter(amount => amount > 0).length;
  const next = stages[game.stage + 1];
  const customName = state.customization?.settlementName;
  const displayName = customName ? customName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : translate(profile.name, language);
  const region = state.customization?.regionName?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const shortage = Boolean(state.waterUpkeep?.paused || state.settlementUpkeep?.paused);
  return `<section class="settlement-district ${editing ? 'decoration-mode' : ''}" id="settlement-scene" aria-labelledby="district-title">
    <h1 class="visually-hidden" id="district-title" data-no-localize>${displayName}</h1>
    <aside class="settlement-command-card" aria-label="${translate('Your settlement', language)}">
      <header class="settlement-command-heading"><div><span class="eyebrow">${translate('Your settlement', language)}</span><h2 data-no-localize>${displayName}</h2>${region ? `<small data-no-localize>${region}</small>` : ''}</div><span class="settlement-stage-tag">${translate(profile.name, language)}</span></header>
      <p class="settlement-command-description">${translate(profile.description, language)}</p>
      <div class="settlement-command-stats">
        <div><small>${translate('Residents', language)}</small><strong>${game.population.toLocaleString(locale(language))}</strong><span>${state.availableWorkers.toLocaleString(locale(language))} ${translate('Available now', language)}</span></div>
        <div><small>${translate('Buildings', language)}</small><strong>${buildings.toLocaleString(locale(language))}</strong><span>${decorations.toLocaleString(locale(language))} ${translate('decorations', language)}</span></div>
      </div>
      <div class="settlement-command-health" data-shortage="${shortage}">${icon(shortage ? 'help' : 'check')}<span>${translate(game.stage < 0 ? 'Establish your settlement to begin production.' : shortage ? 'Supplies need attention. Check Production before dispatching crews.' : 'No active upkeep shortage.', language)}</span></div>
      ${next?.population ? `<div class="settlement-tier-progress"><div><small>${translate('NEXT TIER', language)}</small><strong>${translate(next.name, language)}</strong><span>${game.population.toLocaleString(locale(language))} / ${next.population.toLocaleString(locale(language))}</span></div><progress value="${Math.min(game.population, next.population)}" max="${next.population}" aria-label="${translate('Residents', language)}: ${game.population} / ${next.population}"></progress></div>` : `<div class="settlement-tier-progress settlement-complete"><strong>${translate('Great Megacity complete', language)}</strong></div>`}
      <nav class="settlement-command-actions" aria-label="${translate('Settlement actions', language)}">
        <button class="button" data-settlement-panel="residents">${icon('people')}<span>${translate('Residents', language)}</span></button>
        <button class="button" data-settlement-panel="production">${icon('water')}<span>${translate('Production', language)}</span>${readyResources ? `<b class="task-badge">${readyResources}</b>` : ''}</button>
        <button class="button" data-settlement-panel="sell">${icon('market')}<span>${translate('Market', language)}</span></button>
        <button class="button" data-settlement-panel="buildings">${icon('warehouse')}<span>${translate('Buildings', language)}</span></button>
      </nav>
    </aside>
    <div class="settlement-panorama" data-season="${environment.season}" data-phase="${environment.phase}">
      <canvas id="settlement-world" tabindex="0" aria-label="Settlement grid. Drag to pan, scroll to zoom. Select a building to manage it. In Layout, drag buildings or choose a land cell to move them. Arrow keys move the cursor; Enter selects.">Open Layout to manage buildings and decorations.</canvas>
      <span class="panorama-hint">${icon('compass')} Drag to pan · Scroll to zoom</span>
      <div class="settlement-camera-controls" aria-label="Settlement map controls"><button class="button" data-action="settlement-zoom-out" aria-label="Zoom out">${icon('minus')}</button><button class="button" data-action="settlement-centre" aria-label="Center settlement">${icon('home')}</button><button class="button" data-action="settlement-zoom-in" aria-label="Zoom in">${icon('plus')}</button><button class="button ambient-audio-toggle" data-action="toggle-ambience" aria-label="Enable ambient audio" title="Enable ambient audio" aria-pressed="false">${icon('volume-off')}</button><button class="button" data-settlement-panel="decorate">Arrange buildings</button></div>
    </div>
  </section>`;
}
export function settlementLayoutPanel(state: ApiState, selected: SettlementEntity, language: Language): string {
  const { game, inventory: bag } = state, buildings = settlementBuildings(game), positions = settlementPositions(game, bag);
  if (game.stage < 0) return '<div class="notice">Establish a settlement before arranging buildings.</div><button class="button wide" data-settlement-panel="buildings">Buildings</button>';
  const ids = [...buildings.map(building => building.id), ...bag.items.filter(isDecorationItem)];
  const position = positions[selected], building = buildings.find(building => building.id === selected);
  const name = (id: SettlementEntity) => translate(settlementEntityName(id), language);
  return `<p class="fineprint layout-intro">Move any owned building or decoration to an empty land cell. Moving is free and does not change production or building effects.</p>
    <section class="layout-inspector" aria-labelledby="layout-selection-title"><div class="layout-inspector-art">${isDecorationItem(selected) ? itemArt(selected) : buildingArt(settlementObjectSymbol(selected), game.stage)}<div><h3 id="layout-selection-title">${name(selected)}</h3><p>${position ? translate(`Placed at ${position.x}, ${position.y}`, language) : translate('Not placed', language)}</p></div></div>
      <p class="layout-inspector-description">${translate(settlementObjectDescription(selected), language)}</p>
      <div class="layout-selection-actions"><button class="button primary wide" data-action="prepare-layout" data-entity="${selected}">Move on map ${icon('compass')}</button>
      ${building ? `<button class="button wide" data-settlement-panel="${building.task}">Manage building ${icon('arrow')}</button>` : position ? `<button class="button wide" data-action="remove-layout" data-entity="${selected}">Return to inventory ${icon('minus')}</button>` : ''}</div>
      <details class="disclosure" data-detail="layout-coordinates"><summary>Place by coordinates ${icon('chevron')}</summary><div class="layout-coordinates" role="group" aria-label="Placement coordinates">
        ${(['x', 'y'] as const).map(axis => `<label>${axis.toUpperCase()}<input id="layout-${axis}" data-layout-coordinate="${axis}" type="number" step="1" min="${-settlementRadius}" max="${settlementRadius}" required value="${position?.[axis] ?? (axis === 'y' ? 2 : 0)}" aria-label="${axis.toUpperCase()} coordinate"></label>`).join('')}
        <button class="button" data-action="arrange-coordinates" data-entity="${selected}">Save position</button></div></details>
    </section>
    <h3 class="panel-section-heading">Your buildings and decorations</h3>
    <div class="layout-entities" role="group" aria-label="Settlement buildings and decorations">${[...new Set(ids)].map(id => `<button class="layout-entity ${id === selected ? 'selected' : ''}" data-action="select-building" data-entity="${id}" aria-pressed="${id === selected}">${isDecorationItem(id) ? itemArt(id) : buildingArt(settlementObjectSymbol(id), game.stage)}<span><strong>${name(id)}</strong><small>${positions[id] ? translate(`Placed at ${positions[id]!.x}, ${positions[id]!.y}`, language) : translate('Not placed', language)}</small></span>${icon('chevron')}</button>`).join('')}</div>
    <details class="disclosure" data-detail="layout-help"><summary>Layout controls ${icon('chevron')}</summary><p>In Layout, drag a building onto an empty land cell, or select Move on map and tap a destination. Drag empty ground to pan. Use coordinates for precise placement. Buildings cannot be demolished; decorations can return to inventory.</p><p>This is your settlement parcel, not unexplored world territory. Rearranging never discovers resources or changes exploration.</p></details>`;
}
