import { hash } from './engine.ts';
import type { Game, Terrain } from './engine.ts';
import { decorationSlots, isDecorationItem, itemName } from './items.ts';
import type { DecorationItem, DecorationSlot, ItemInventory } from './items.ts';
import { waterFacilities, waterFacilityKeys } from './water-facilities.ts';
import { constructionLevel } from './constructions.ts';

export interface GridPosition { x: number; y: number }
export const settlementRadius = 10;
const homePositions: GridPosition[] = [
  { x: -3, y: -2 }, { x: -1, y: -4 }, { x: 3, y: -2 }, { x: 5, y: 0 },
  { x: -5, y: 2 }, { x: -1, y: 5 }, { x: 2, y: 5 }, { x: -5, y: -4 },
  { x: -7, y: 1 }, { x: 1, y: -7 }, { x: 6, y: -4 }, { x: 6, y: 2 },
  { x: -3, y: 6 }, { x: 4, y: 6 }, { x: -7, y: -3 }, { x: -7, y: 5 },
  { x: 4, y: -6 }, { x: -2, y: -7 }, { x: 7, y: -1 }, { x: 6, y: 5 },
  { x: -8, y: -5 }, { x: -6, y: -7 }, { x: 8, y: -4 }, { x: 2, y: 8 },
  { x: -8, y: 3 }, { x: -4, y: 8 }, { x: 5, y: -8 }, { x: 7, y: -6 },
  { x: -9, y: -1 }, { x: -8, y: 7 }, { x: -1, y: 9 }, { x: 5, y: 8 },
  { x: -5, y: -9 }, { x: 0, y: -9 }, { x: 9, y: -1 }, { x: 7, y: 8 },
  { x: -9, y: -7 }, { x: -3, y: -9 }, { x: 3, y: -9 }, { x: 9, y: -7 },
  { x: -9, y: 5 }, { x: -6, y: 9 }, { x: 1, y: 9 }, { x: 6, y: 9 },
  { x: -9, y: 9 }, { x: -7, y: -9 }, { x: 7, y: -9 }, { x: 9, y: 1 },
];
const services = {
  centre: { name: 'Settlement centre', x: 0, y: 0, task: 'overview' },
  workshop: { name: 'Crafting workshop', x: -3, y: 1, task: 'crafting' },
  supplies: { name: 'Item inventory', x: 3, y: 1, task: 'inventory' },
  bank: { name: 'City bank', x: -2, y: -3, task: 'buildings' },
  townhall: { name: 'Town hall', x: 2, y: -3, task: 'buildings' },
  well: { ...waterFacilities.well, task: 'buildings' },
  rainCollector: { ...waterFacilities.rainCollector, task: 'buildings' },
  pumpingStation: { ...waterFacilities.pumpingStation, task: 'buildings' },
  'market-stall': { name: 'Market stall', x: -4, y: -1, task: 'buildings' },
  'trade-hub': { name: 'Trade hub', x: 4, y: -1, task: 'buildings' },
  housing: { name: 'Residential quarter', x: -6, y: -2, task: 'buildings' },
  cistern: { name: 'Water reservoir', x: 6, y: -2, task: 'buildings' },
} as const;
export type SettlementBuilding = keyof typeof services | `home-${number}`;
export type SettlementEntity = SettlementBuilding | DecorationItem;
export interface SettlementLayout { version: 1; positions: Partial<Record<SettlementEntity, GridPosition>> }
export interface SettlementBuildingInfo {
  id: SettlementBuilding; name: string; position: GridPosition;
  task: 'overview' | 'crafting' | 'inventory' | 'buildings' | 'residents';
}
export const legacySpaceCells: Record<DecorationSlot, GridPosition> = {
  square: { x: 0, y: 2 }, garden: { x: -4, y: 4 }, gate: { x: -6, y: 0 },
  courtyard: { x: 3, y: -4 }, lane: { x: 4, y: 3 }, riverside: { x: 7, y: 6 },
};
export function homeCount(stage: number): number {
  return stage < 0 ? 0 : [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48][stage];
}
export function settlementBuildings(game: Game): SettlementBuildingInfo[] {
  if (game.stage < 0) return [];
  const buildings: SettlementBuildingInfo[] = [
    { id: 'centre', ...services.centre, position: { x: 0, y: 0 } },
    ...(['workshop', 'supplies', ...(game.bank ? ['bank' as const] : []), ...(game.townhall ? ['townhall' as const] : [])] as const)
      .map(id => ({ id, name: services[id].name, position: { x: services[id].x, y: services[id].y }, task: services[id].task })),
  ];
  const facilities: SettlementBuildingInfo[] = waterFacilityKeys.filter(key => game.waterFacilities?.[key]).map(id => ({
    id, name: waterFacilities[id].name, position: { x: waterFacilities[id].x, y: waterFacilities[id].y }, task: 'buildings',
  }));
  const income: SettlementBuildingInfo[] = (['market-stall', 'trade-hub'] as const).filter(id => game.incomeFacilities?.[id]).map(id => ({
    id, name: services[id].name, position: { x: services[id].x, y: services[id].y }, task: 'buildings',
  }));
  const upgrades: SettlementBuildingInfo[] = (['housing', 'cistern'] as const).filter(id => constructionLevel(game, id) > 0).map(id => ({
    id, name: services[id].name, position: { x: services[id].x, y: services[id].y }, task: 'buildings',
  }));
  return [...buildings, ...facilities, ...income, ...upgrades, ...homePositions.slice(0, homeCount(game.stage)).map((position, i) => ({
    id: `home-${i}` as const, name: `Residence ${i + 1}`, position, task: 'residents' as const,
  }))];
}
export function isSettlementEntity(value: unknown): value is SettlementEntity {
  return typeof value === 'string' && (isDecorationItem(value) || Object.hasOwn(services, value)
    || homePositions.some((_, i) => value === `home-${i}`));
}
export function settlementEntityName(id: SettlementEntity): string {
  if (isDecorationItem(id)) return itemName(id);
  if (id.startsWith('home-')) return `Residence ${Number(id.slice(5)) + 1}`;
  return services[id as keyof typeof services].name;
}
export function settlementTerrain(x: number, y: number, seed: number): Terrain {
  if (x >= 8 && y >= 2) return 'river';
  return Math.max(Math.abs(x), Math.abs(y)) >= 7 && hash(x, y, seed) > .35 ? 'forest' : 'meadow';
}
export function validSettlementCell(position: GridPosition): boolean {
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y)
    && Math.abs(position.x) <= settlementRadius && Math.abs(position.y) <= settlementRadius
    && !(position.x >= 8 && position.y >= 2);
}
export const cellKey = ({ x, y }: GridPosition): string => `${x},${y}`;
export function positionEntries(positions: SettlementLayout['positions']): [SettlementEntity, GridPosition][] {
  return Object.entries(positions).filter((entry): entry is [SettlementEntity, GridPosition] => isSettlementEntity(entry[0]) && entry[1] !== undefined);
}
export function settlementPositions(game: Game, bag: ItemInventory): SettlementLayout['positions'] {
  const buildings = settlementBuildings(game), saved: SettlementLayout['positions'] = { ...bag.layout?.positions };
  if (!bag.layout) for (const slot of decorationSlots) {
    const item = bag.placements?.[slot];
    if (item) saved[item] = { ...legacySpaceCells[slot] };
  }
  const active = new Set([...buildings.map(building => building.id), ...bag.items.filter(isDecorationItem)]);
  const positions: SettlementLayout['positions'] = {}, occupied = new Set<string>();
  for (const id of active) {
    const position = saved[id];
    if (!position) continue;
    if (!validSettlementCell(position) || occupied.has(cellKey(position))) throw new Error('Stored settlement layout contains an invalid or overlapping cell.');
    positions[id] = { ...position };
    occupied.add(cellKey(position));
  }
  for (const building of buildings) {
    if (positions[building.id]) continue;
    const choices: GridPosition[] = [];
    for (let y = -settlementRadius; y <= settlementRadius; y++) for (let x = -settlementRadius; x <= settlementRadius; x++) {
      const position = { x, y };
      if (validSettlementCell(position) && !occupied.has(cellKey(position))) choices.push(position);
    }
    choices.sort((a, b) => Math.abs(a.x - building.position.x) + Math.abs(a.y - building.position.y)
      - Math.abs(b.x - building.position.x) - Math.abs(b.y - building.position.y));
    const position = choices[0];
    if (!position) throw new Error('No empty settlement cell is available.');
    positions[building.id] = position;
    occupied.add(cellKey(position));
  }
  return positions;
}
export function arrangementError(game: Game, bag: ItemInventory, entity: SettlementEntity, position: GridPosition | null): string | null {
  if (game.stage < 0) return 'Establish a settlement before arranging buildings.';
  if (isDecorationItem(entity) ? !bag.items.includes(entity) : !settlementBuildings(game).some(building => building.id === entity)) return 'You do not own this settlement building or decoration.';
  if (position === null) return isDecorationItem(entity) ? null : 'Buildings cannot be removed. Move them to another cell.';
  if (!validSettlementCell(position)) return 'Choose a land cell inside the settlement boundary.';
  if (positionEntries(settlementPositions(game, bag)).some(([id, cell]) => id !== entity && cellKey(cell) === cellKey(position))) return 'That cell is occupied. Choose an empty cell.';
  return null;
}
