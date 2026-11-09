import type { Command, Snapshot } from './api-types.ts';
import { buildingCosts, canAfford, isWater, pay, stages, terrainAt } from './engine.ts';
import type { Cost } from './engine.ts';
import { constructionCost, constructionLevel, constructions } from './constructions.ts';
import { maximumUpgradeLevel, warehouseCost } from './costs.ts';
import { itemStorage, sellableItemCount } from './items.ts';
import { incomeFacilities, isIncomeFacility } from './income.ts';
import { isWaterFacility, waterFacilities } from './water-facilities.ts';
import { builderCharter } from './builder-items.ts';
import type { Construction } from './constructions.ts';
import type { WaterFacility } from './water-facilities.ts';
import type { IncomeFacility } from './income.ts';
import { dollarsScale, dollarsUnits } from './dollars.ts';

export type UpgradeTarget = { type: 'upgrade' | 'warehouse' | 'item-storage' }
  | { type: 'construction'; kind: Construction }
  | { type: 'build'; kind: 'bank' | 'townhall' | WaterFacility | IncomeFacility };
export function isUpgradeTarget(command: Command): command is UpgradeTarget {
  return command.type === 'upgrade' || command.type === 'warehouse' || command.type === 'item-storage'
    || command.type === 'construction' || command.type === 'build';
}
export interface MaxUpgradePlan { count: number; costs: Cost; finalLevel: number; fingerprint: string }
export function maxUpgradePlan(state: Pick<Snapshot, 'game' | 'inventory' | 'warehouse'>, target: UpgradeTarget): MaxUpgradePlan {
  const game = structuredClone(state.game), costs: Cost = {};
  let warehouse = state.warehouse, storage = state.inventory.storage, count = 0, finalLevel = 0;
  for (let step = 0; step < maximumUpgradeLevel; step++) {
    let cost: Cost | null = null;
    if (target.type === 'upgrade') {
      const next = stages[game.stage + 1];
      if (next && game.population >= next.population && (game.stage >= 0 || !isWater(terrainAt(game.position.x, game.position.y, game.seed)))) cost = next.cost;
    } else if (target.type === 'warehouse') {
      if (game.stage >= 0 && warehouse < maximumUpgradeLevel) cost = warehouseCost(warehouse + 1);
    } else if (target.type === 'item-storage') {
      const next = itemStorage[storage + 1];
      if (game.stage >= 0 && next) cost = { metal: next.metal, dollars: next.dollars };
    } else if (target.type === 'construction') {
      if (game.stage >= constructions[target.kind].stage) cost = constructionCost(game, target.kind);
    } else if (target.type === 'build' && !count) {
      const kind = target.kind;
      if (isIncomeFacility(kind)) {
        if (game.stage >= incomeFacilities[kind].stage && !game.incomeFacilities?.[kind]) cost = incomeFacilities[kind].cost;
      } else if (isWaterFacility(kind)) {
        if (game.stage >= 0 && !game.waterFacilities?.[kind]) cost = waterFacilities[kind].cost;
      } else if (!game[kind] && game.stage >= (kind === 'bank' ? 6 : 4)) cost = buildingCosts[kind];
    }
    if (!cost || !canAfford(game, cost)) break;
    pay(game, cost);
    for (const resource of ['wood', 'water', 'metal', 'oil', 'dollars'] as const)
      if (cost[resource]) costs[resource] = resource === 'dollars'
        ? (dollarsUnits(costs.dollars ?? 0) + dollarsUnits(cost.dollars!)) / dollarsScale
        : (costs[resource] ?? 0) + cost[resource]!;
    count++;
    if (target.type === 'upgrade') {
      game.stage++;
      if (!game.home) { game.home = { ...game.position }; game.population = 12; }
      finalLevel = game.stage;
    } else if (target.type === 'warehouse') finalLevel = ++warehouse;
    else if (target.type === 'item-storage') finalLevel = ++storage;
    else if (target.type === 'construction') {
      finalLevel = constructionLevel(game, target.kind) + 1;
      game.constructionLevels = { ...game.constructionLevels, [target.kind]: finalLevel };
    } else finalLevel = 1;
  }
  return { count, costs, finalLevel, fingerprint: JSON.stringify({ target, count, costs, finalLevel }) };
}
export function hasBuilderCharter(state: Pick<Snapshot, 'inventory'>): boolean {
  return sellableItemCount(state.inventory, builderCharter) > 0;
}
