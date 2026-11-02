import type { Cost, Game, Resource } from './engine.ts';
import { withDollarFee } from './costs.ts';
import { monetaryPolicy } from './monetary-policy.ts';

export const constructions = {
  housing: { name: 'Residential quarter', stage: 0, maxLevel: 8, cost: withDollarFee({ wood: 60, water: 20, metal: 10 }), benefit: 'Recruitment batch +25% per level' },
  cistern: { name: 'Water reservoir', stage: 0, maxLevel: 8, cost: withDollarFee({ wood: 80, metal: 30 }), benefit: 'One extra week of Water capacity per level' },
  workshop: { name: 'Commercial workshop', stage: 2, maxLevel: 8, cost: { wood: 200, metal: 100, dollars: monetaryPolicy.constructionFees.workshop }, benefit: 'Wood, Metal and Oil output +25% per level' },
  logistics: { name: 'Trade hub', stage: 4, maxLevel: 8, cost: { wood: 500, metal: 300, dollars: monetaryPolicy.constructionFees.logistics }, benefit: 'Collection routes shortened by two tiles per level' },
} satisfies Record<string, { name: string; stage: number; maxLevel: number; cost: Cost; benefit: string }>;
export type Construction = keyof typeof constructions;
export const constructionKeys = Object.keys(constructions) as Construction[];
export function isConstruction(value: unknown): value is Construction {
  return typeof value === 'string' && Object.hasOwn(constructions, value);
}
export function constructionLevel(game: Game, kind: Construction): number {
  return Math.max(game.constructionLevels?.[kind] ?? 0,
    kind === 'workshop' && game.incomeFacilities?.workshop || kind === 'logistics' && game.incomeFacilities?.['trade-hub'] ? 1 : 0);
}
export function constructionCost(game: Game, kind: Construction): Cost | null {
  const level = constructionLevel(game, kind) + 1;
  if (level > constructions[kind].maxLevel) return null;
  return Object.fromEntries(Object.entries(constructions[kind].cost).map(([resource, amount]) => [resource, amount * level]));
}
export function productionMultiplier(game: Game, resource: Resource): number {
  return resource === 'water' ? 1 : 1 + constructionLevel(game, 'workshop') / 4;
}
