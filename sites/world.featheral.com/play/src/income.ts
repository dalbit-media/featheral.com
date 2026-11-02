import type { Cost, Game } from './engine.ts';

export const incomeFacilities = {
  'market-stall': { name: 'Market stall', stage: 1, weekly: 0, cost: { wood: 80, metal: 40, dollars: 200 } },
  workshop: { name: 'Commercial workshop', stage: 2, weekly: 0, cost: { wood: 200, metal: 100, dollars: 600 } },
  'trade-hub': { name: 'Trade hub', stage: 4, weekly: 0, cost: { wood: 500, metal: 300, dollars: 1800 } },
} satisfies Record<string, { name: string; stage: number; weekly: number; cost: Cost }>;
export type IncomeFacility = keyof typeof incomeFacilities;
export const incomeFacilityKeys = Object.keys(incomeFacilities) as IncomeFacility[];
export function isIncomeFacility(value: unknown): value is IncomeFacility {
  return typeof value === 'string' && incomeFacilityKeys.some(key => key === value);
}
export function weeklyIncome(_game: Game): number {
  return 0;
}
