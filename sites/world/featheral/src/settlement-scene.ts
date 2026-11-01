import { stages } from './engine.ts';
import type { ApiState } from './api-types.ts';
import { icon } from './icons.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { environmentDetails } from './environment-view.ts';
import { itemArt } from './item-art.ts';
import { isDecorationItem } from './items.ts';
import { homeCount, settlementBuildings, settlementEntityName, settlementPositions, settlementRadius } from './settlement-layout.ts';
import type { SettlementEntity } from './settlement-layout.ts';
import { isWaterFacility } from './water-facilities.ts';

export function settlementProfile(stage: number): { name: string; homes: number; style: string; description: string } {
  return {
    name: stage < 0 ? 'Unsettled' : stages[stage].name, homes: homeCount(stage),
    style: stage >= 6 ? 'city' : stage >= 4 ? 'town' : stage >= 3 ? 'village' : 'camp',
    description: stage >= 6 ? 'A city of busy streets and little places to call your own.'
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
  return `<section class="settlement-district ${editing ? 'decoration-mode' : ''}" id="settlement-scene" aria-labelledby="district-title">
    <h1 class="visually-hidden" id="district-title">${profile.name} settlement</h1>
    <aside class="settlement-command-card" aria-label="${translate('Your settlement', language)}">
      <header class="settlement-command-heading"><div><span class="eyebrow">${translate('Your settlement', language)}</span><h2>${translate(profile.name, language)}</h2></div><span class="settlement-stage-tag">${translate(profile.style, language)}</span></header>
      <div class="settlement-command-stats">
        <div><small>${translate('Residents', language)}</small><strong>${game.population.toLocaleString(locale(language))}</strong><span>${state.availableWorkers.toLocaleString(locale(language))} available</span></div>
        <div><small>${translate('Buildings', language)}</small><strong>${buildings.toLocaleString(locale(language))}</strong><span>${decorations.toLocaleString(locale(language))} ${translate('decorations', language)}</span></div>
      </div>
      ${next?.population ? `<div class="settlement-tier-progress"><div><small>${translate('NEXT TIER', language)}</small><strong>${translate(next.name, language)}</strong><span>${game.population.toLocaleString(locale(language))} / ${next.population.toLocaleString(locale(language))}</span></div><progress value="${Math.min(game.population, next.population)}" max="${next.population}" aria-label="${translate('Residents', language)}: ${game.population} / ${next.population}"></progress></div>` : `<div class="settlement-tier-progress settlement-complete"><strong>${translate('Capital complete', language)}</strong></div>`}
      <nav class="settlement-command-actions" aria-label="${translate('Settlement actions', language)}">
        <button class="button" data-settlement-panel="residents">${icon('people')}<span>${translate('Residents', language)}</span></button>
        <button class="button" data-settlement-panel="production">${icon('water')}<span>${translate('Production', language)}</span>${readyResources ? `<b class="task-badge">${readyResources}</b>` : ''}</button>
        <button class="button" data-settlement-panel="sell">${icon('market')}<span>${translate('Market', language)}</span></button>
        <button class="button" data-settlement-panel="buildings">${icon('warehouse')}<span>${translate('Buildings', language)}</span></button>
      </nav>
    </aside>
    <div class="settlement-panorama" data-season="${environment.season}" data-phase="${environment.phase}">
      <canvas id="settlement-world" tabindex="0" aria-label="Settlement grid. Drag to pan, scroll to zoom. Select a building to manage it. In Layout, drag buildings or choose a land cell to move them. Arrow keys move the cursor; Enter selects.">Open Layout to manage buildings and decorations.</canvas>
      <div class="map-environment" data-map-environment aria-label="World conditions">${environmentDetails(environment)}</div>
      <span class="panorama-hint">${icon('compass')} Drag to pan · Scroll to zoom</span>
      <div class="settlement-camera-controls" aria-label="Settlement map controls"><button class="button" data-action="settlement-zoom-out" aria-label="Zoom out">${icon('minus')}</button><button class="button" data-action="settlement-centre" aria-label="Center settlement">${icon('home')}</button><button class="button" data-action="settlement-zoom-in" aria-label="Zoom in">${icon('plus')}</button><button class="button" data-settlement-panel="decorate">Arrange buildings</button></div>
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
    <section class="layout-inspector" aria-labelledby="layout-selection-title"><h3 id="layout-selection-title">${name(selected)}</h3><p>${position ? translate(`Placed at ${position.x}, ${position.y}`, language) : 'Not placed'}</p>
      <div class="layout-selection-actions"><button class="button primary wide" data-action="prepare-layout" data-entity="${selected}">Move on map ${icon('compass')}</button>
      ${building ? `<button class="button wide" data-settlement-panel="${building.task}">Manage building ${icon('arrow')}</button>` : position ? `<button class="button wide" data-action="remove-layout" data-entity="${selected}">Return to inventory ${icon('minus')}</button>` : ''}</div>
      <details class="disclosure" data-detail="layout-coordinates"><summary>Place by coordinates ${icon('chevron')}</summary><div class="layout-coordinates" role="group" aria-label="Placement coordinates">
        ${(['x', 'y'] as const).map(axis => `<label>${axis.toUpperCase()}<input id="layout-${axis}" data-layout-coordinate="${axis}" type="number" step="1" min="${-settlementRadius}" max="${settlementRadius}" required value="${position?.[axis] ?? (axis === 'y' ? 2 : 0)}" aria-label="${axis.toUpperCase()} coordinate"></label>`).join('')}
        <button class="button" data-action="arrange-coordinates" data-entity="${selected}">Save position</button></div></details>
    </section>
    <h3 class="panel-section-heading">Your buildings and decorations</h3>
    <div class="layout-entities" role="group" aria-label="Settlement buildings and decorations">${ids.map(id => `<button class="layout-entity ${id === selected ? 'selected' : ''}" data-action="select-building" data-entity="${id}" aria-pressed="${id === selected}">${isDecorationItem(id) ? itemArt(id) : icon(isWaterFacility(id) ? id : id === 'bank' ? 'bank' : 'home')}<span><strong>${name(id)}</strong><small>${positions[id] ? translate(`Placed at ${positions[id]!.x}, ${positions[id]!.y}`, language) : 'Not placed'}</small></span>${icon('chevron')}</button>`).join('')}</div>
    <details class="disclosure" data-detail="layout-help"><summary>Layout controls ${icon('chevron')}</summary><p>In Layout, drag a building onto an empty land cell, or select Move on map and tap a destination. Drag empty ground to pan. Use coordinates for precise placement. Buildings cannot be demolished; decorations can return to inventory.</p><p>This is your settlement parcel, not unexplored world territory. Rearranging never discovers resources or changes exploration.</p></details>`;
}
