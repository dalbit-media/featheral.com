import { radius, stages, terrainAt, terrainDetails, terrainResources } from './engine.ts';
import { dollarsScale } from './dollars.ts';
import { maximumUpgradeLevel } from './costs.ts';
import type { Game, Resource, Stock, Terrain } from './engine.ts';
import type { AllocationWeights, Expedition, ResourceAccess, Workforce } from './api-types.ts';
import { dailyWaterPerResident, maximumSettlementWeeklyConsumption, settlementUpkeepResources, waterRequirement } from './upkeep.ts';
import { waterFacilities, waterFacilityKeys, waterProductionMultiplier } from './water-facilities.ts';
import { constructionLevel, productionMultiplier } from './constructions.ts';
import { monetaryPolicy } from './monetary-policy.ts';
import { productionClimate, weeklyClimate } from './climate.ts';
import { worldDayMs } from './environment.ts';
import { resourceBasePrice, resourceEconomy } from './resource-units.ts';
import { discountedActivityCost } from './activity-equipment.ts';

export const resourceKeys: Resource[] = ['wood', 'water', 'metal', 'oil'];
export const emptyAllocation = (): Stock => ({ wood: 0, water: 0, metal: 0, oil: 0 });
export function warehouseCapacity(game: Game, warehouse: number): number {
  if (game.stage < 0) return 0;
  const tier = stages[game.stage + 1] ?? stages[game.stage];
  const requirement = Math.max(...resourceKeys.map(resource => tier.cost[resource] ?? 0));
  const reserve = Math.max(...settlementUpkeepResources.map(resource =>
    maximumSettlementWeeklyConsumption(resource, game.population, game.stage))) * 2;
  return Math.max(100 + game.stage * 100 + warehouse * 500, requirement * (warehouse + 1), reserve);
}
export function expeditionSurveyRadius(game: Game): number { return Math.min(2, radius(game)); }
export function emergencyCollection(pending: Stock, fees: Stock, dollars: number): Stock {
  return { wood: pending.wood >= 1 && fees.wood > dollars ? pending.wood : 0,
    water: pending.water >= 1 && fees.water > dollars ? pending.water : 0,
    metal: pending.metal >= 1 && fees.metal > dollars ? pending.metal : 0,
    oil: pending.oil >= 1 && fees.oil > dollars ? pending.oil : 0 };
}
export function workforceCounts(population: number, work: Pick<Workforce, 'crews' | 'expeditions'>) {
  const gathering = Object.values(work.crews).reduce((sum, crew) => sum + crew.workers, 0);
  const exploring = work.expeditions.reduce((sum, expedition) => sum + expedition.workers, 0);
  return { gathering, exploring, available: Math.max(0, population - gathering - exploring),
    assignmentCapacity: Math.max(0, population - Math.max(2, exploring)) };
}
export const allocationWeightKeys = ['wood', 'water', 'metal', 'oil', 'idle'] as const;
export const maximumAllocationWeight = 10;
export const defaultAllocationWeights = (): AllocationWeights => ({ wood: 3, water: 3, metal: 2, oil: 2, idle: 0 });
export function isAllocationWeights(value: unknown): value is AllocationWeights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allocationWeightKeys.length && allocationWeightKeys.every(key => {
    const weight = (value as Record<string, unknown>)[key];
    return typeof weight === 'number' && Number.isSafeInteger(weight) && weight >= 0 && weight <= maximumAllocationWeight;
  });
}
export function allocationWeights(work: Pick<Workforce, 'automatic' | 'crews' | 'allocation' | 'weights'>, assignmentCapacity: number): AllocationWeights {
  if (work.weights) return { ...work.weights };
  const base = editableAllocation(work);
  const assigned = resourceKeys.reduce((sum, resource) => sum + base[resource], 0);
  if (!assigned || !assignmentCapacity) return defaultAllocationWeights();
  const scale = (workers: number) => Math.round(workers / Math.max(assigned, assignmentCapacity) * maximumAllocationWeight);
  return { wood: scale(base.wood), water: scale(base.water), metal: scale(base.metal), oil: scale(base.oil),
    idle: scale(Math.max(0, assignmentCapacity - assigned)) };
}
/** Splits assignable residents by weight in O(resources); full storage or unexplored sites pass their share on. */
export function weightedAllocation(game: Game, pending: Stock, capacity: number, weights: AllocationWeights,
  access: Record<Resource, ResourceAccess>, exploringWorkers = 0): Stock {
  const allocation = emptyAllocation(), limits = emptyAllocation();
  const assignable = Math.max(0, game.population - Math.max(2, exploringWorkers));
  const totalWeight = allocationWeightKeys.reduce((sum, key) => sum + weights[key], 0);
  if (!assignable || !totalWeight) return allocation;
  for (const resource of resourceKeys) {
    const site = access[resource];
    limits[resource] = site.available && site.perWorker > 0 && weights[resource] > 0
      ? Math.ceil(resourceWorkRoom(capacity, resource, game, pending[resource], site) / site.perWorker) : 0;
  }
  let workers = Math.floor(assignable * (totalWeight - weights.idle) / totalWeight);
  let open = resourceKeys.filter(resource => limits[resource] > 0);
  while (workers > 0 && open.length) {
    const weight = open.reduce((sum, resource) => sum + weights[resource], 0);
    const full = open.filter(resource => limits[resource] <= workers * weights[resource] / weight);
    if (full.length) {
      for (const resource of full) { allocation[resource] = limits[resource]; workers -= limits[resource]; }
      open = open.filter(resource => !full.includes(resource));
      continue;
    }
    let remaining = workers;
    const shares = open.map(resource => {
      const share = workers * weights[resource] / weight, whole = Math.floor(share);
      allocation[resource] = whole; remaining -= whole;
      return { resource, fraction: share - whole };
    }).sort((a, b) => b.fraction - a.fraction);
    for (const { resource } of shares) if (remaining > 0) { allocation[resource]++; remaining--; }
    break;
  }
  return allocation;
}
export function editableAllocation(work: Pick<Workforce, 'automatic' | 'crews' | 'allocation'> & { weights?: AllocationWeights }): Stock {
  return work.automatic || work.weights ? {
    wood: work.crews.wood?.workers ?? 0, water: work.crews.water?.workers ?? 0,
    metal: work.crews.metal?.workers ?? 0, oil: work.crews.oil?.workers ?? 0,
  } : { ...work.allocation };
}
const base: Stock = { wood: resourceEconomy.wood.weeklyProduction, water: resourceEconomy.water.weeklyProduction,
  metal: resourceEconomy.metal.weeklyProduction, oil: resourceEconomy.oil.weeklyProduction };
const legacyBase: Stock = { wood: 30, water: 300, metal: 10, oil: 6 };
const fundingOrder: Resource[] = ['metal', 'wood', 'water', 'oil'];
export function resourceCapacity(capacity: number, resource: Resource, game?: Game): number {
  if (capacity <= 0 || resource !== 'water') return capacity;
  // Legacy migration has no Game context and retains its historical storage allowance.
  if (!game) return capacity + 2900;
  return Math.max(capacity, Math.ceil(waterRequirement(game.population) * 1.5) * (2 + constructionLevel(game, 'cistern')));
}
export function basicWorkers(resource: Resource): number {
  return resource === 'wood' || resource === 'water' ? monetaryPolicy.basicWorkersPerResource : 0;
}
export function resourceWorkRoom(capacity: number, resource: Resource, game: Game, pending: number, access: ResourceAccess): number {
  const demand = resource === 'water' ? access.weeklyConsumption ?? Math.ceil(waterRequirement(game.population) * 1.5) : 0;
  return Math.floor(Math.max(0, resourceCapacity(capacity, resource, game) - game.stock[resource] - pending
    + Math.min(game.stock[resource], demand)));
}
export function transportCost(resource: Resource, workers: number, perWorker: number): number {
  return Math.max(0, workers - basicWorkers(resource)) * perWorker;
}
export interface AllocationPlan {
  allocation: Stock;
  crews: Stock;
  dollars: number;
  unfundedWorkers: number;
}

export function fundAllocation(game: Game, pending: Stock, capacity: number, allocation: Stock,
  access: Record<Resource, ResourceAccess>, exploringWorkers: number, reserve: number, waterPriority = false, payOnPickup = false): AllocationPlan {
  const plan: AllocationPlan = { allocation: { ...allocation }, crews: emptyAllocation(), dollars: game.dollars, unfundedWorkers: 0 };
  let available = Math.max(0, game.population - Math.max(2, exploringWorkers));
  for (const resource of waterPriority ? ['water', 'metal', 'wood', 'oil'] as const : fundingOrder) {
    const site = access[resource];
    if (!site.available || site.perWorker <= 0) continue;
    const requested = Math.min(available, allocation[resource],
      Math.ceil(resourceWorkRoom(capacity, resource, game, pending[resource], site) / site.perWorker));
    const paused = game.stock.water < game.population * dailyWaterPerResident;
    const affordable = paused && resource !== 'water' ? basicWorkers(resource)
      : payOnPickup ? requested : basicWorkers(resource) + Math.floor(Math.max(0, plan.dollars - reserve * dollarsScale) / (site.dollarsPerWorker * dollarsScale));
    const workers = Math.min(requested, affordable);
    plan.unfundedWorkers += requested - workers;
    plan.crews[resource] = workers;
    if (!payOnPickup) plan.dollars -= transportCost(resource, workers, site.dollarsPerWorker) * dollarsScale;
    available -= workers;
  }
  return plan;
}

function routeQuote(game: Game, x: number, y: number, concurrent = 0): { dollars: number; weeks: number; reward: number } {
  if (!Number.isSafeInteger(concurrent) || concurrent < 0) throw new RangeError('Invalid concurrent expedition count.');
  const home = game.home ?? game.position;
  const weeks = terrainDetails[terrainAt(x, y, game.seed)].weeks;
  const dollars = monetaryPolicy.explorationBase + Math.ceil(Math.hypot(x - home.x, y - home.y)) * monetaryPolicy.explorationPerTile
    + (weeks - 1) * monetaryPolicy.explorationPerExtraWeek;
  return { dollars: dollars * 1.5 ** concurrent, weeks, reward: 0 };
}
export function explorationQuote(game: Game, x: number, y: number, concurrent = 0): { dollars: number; weeks: number; reward: number } {
  const quote = routeQuote(game, x, y, concurrent);
  return { ...quote, dollars: discountedActivityCost(game, 'exploration', quote.dollars) };
}
export function explorationCount(expeditions: readonly Expedition[]): number {
  return expeditions.length;
}
export function investigationQuote(game: Game, x: number, y: number, concurrent = 0): { dollars: number; weeks: 1 } {
  const cost = Math.max(.1, Math.ceil(routeQuote(game, x, y, concurrent).dollars * dollarsScale / 10) / dollarsScale);
  return { dollars: discountedActivityCost(game, 'investigation', cost), weeks: 1 };
}
export function nextInvestigation(game: Game, expeditions: readonly Expedition[] = []): { x: number; y: number; dollars: number; weeks: 1 } | null {
  const active = new Set(expeditions.map(expedition => `${expedition.x},${expedition.y}`));
  let best: ReturnType<typeof nextInvestigation> = null;
  for (const key of game.explored) {
    const [x, y] = key.split(',').map(Number);
    if (active.has(key) || Math.hypot(x - game.position.x, y - game.position.y) > radius(game) + 1) continue;
    const quote = { x, y, ...investigationQuote(game, x, y, explorationCount(expeditions)) };
    if (!best || quote.dollars < best.dollars) best = quote;
  }
  return best;
}
export function nextExploration(game: Game, expeditions: readonly Expedition[] = []): { x: number; y: number; dollars: number; weeks: number; reward: number } | null {
  const known = new Set(game.explored), reach = radius(game) + 1;
  for (const expedition of expeditions) known.add(`${expedition.x},${expedition.y}`);
  let best: ReturnType<typeof nextExploration> = null;
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
    const x = game.position.x + dx, y = game.position.y + dy;
    if (Math.hypot(dx, dy) > reach || known.has(`${x},${y}`)) continue;
    const quote = { x, y, ...explorationQuote(game, x, y, explorationCount(expeditions)) };
    if (!best || quote.dollars < best.dollars) best = quote;
  }
  return best;
}
export function resourceAccess(game: Game, time?: number, legacy = false): Record<Resource, ResourceAccess> {
  const result = Object.fromEntries(resourceKeys.map(resource => [resource, {
    available: false, distance: 0, efficiency: 0, perWorker: 0, dollarsPerWorker: 0,
  }])) as Record<Resource, ResourceAccess>;
  const home = game.home ?? game.position;
  const nearest = new Map<Terrain, number>();
  for (const key of game.explored) {
    const [x, y] = key.split(',').map(Number);
    const terrain = terrainAt(x, y, game.seed);
    const distance = Math.ceil(Math.hypot(x - home.x, y - home.y));
    if (distance < (nearest.get(terrain) ?? Infinity)) nearest.set(terrain, distance);
  }
  for (const [terrain, distance] of nearest) {
    const resource = terrainResources[terrain];
    if (game.stage < 0 || (resource === 'oil' && !game.bank)) continue;
    const efficiency = terrainDetails[terrain].yield;
    const perWorker = Math.floor((legacy ? legacyBase[resource] * (game.stage + 1) : base[resource]) * efficiency
      * (resource === 'metal' && game.federation ? 1.2 : 1)
      * (resource === 'water' ? waterProductionMultiplier(game) : productionMultiplier(game, resource))
      * (time === undefined || legacy ? 1 : weeklyClimate(time, environment => productionClimate(resource, environment))));
    const effectiveDistance = Math.max(0, distance - constructionLevel(game, 'logistics') * 2);
    const dollarsPerWorker = monetaryPolicy.transportPerWorker
      + Math.max(0, Math.ceil((effectiveDistance - monetaryPolicy.transportFreeDistance) / monetaryPolicy.transportDistanceBand));
    const previous = result[resource];
    const value = perWorker * resourceBasePrice(resource) - dollarsPerWorker;
    const previousValue = previous.perWorker * resourceBasePrice(resource) - previous.dollarsPerWorker;
    if (!previous.available || value > previousValue
      || (value === previousValue && distance < previous.distance)) {
      result[resource] = { available: true, distance, efficiency, perWorker, dollarsPerWorker };
    }
  }
  result.water.weeklyConsumption = waterRequirement(game.population, time === undefined ? undefined : time + worldDayMs, legacy);
  return result;
}
export function balancedAllocation(game: Game, pending: Stock, capacity: number, warehouse: number,
  access: Record<Resource, ResourceAccess>, exploringWorkers = 0,
  reserve = 0, payOnPickup = false): AllocationPlan {
  const goals = emptyAllocation(), desired = emptyAllocation(), allocation = emptyAllocation();
  const next = stages[game.stage + 1];
  for (const resource of resourceKeys) goals[resource] = next?.cost[resource] ?? 0;
  for (const resource of settlementUpkeepResources)
    goals[resource] = Math.max(goals[resource], maximumSettlementWeeklyConsumption(resource, game.population, game.stage) * 2);
  goals.water = Math.max(goals.water, resourceCapacity(capacity, 'water', game));
  const nextFacility = waterFacilityKeys.find(key => !game.waterFacilities?.[key]);
  if (nextFacility) {
    goals.wood += waterFacilities[nextFacility].cost.wood;
    goals.metal += waterFacilities[nextFacility].cost.metal;
  }
  if (warehouse < maximumUpgradeLevel) {
    goals.wood += 80 * (warehouse + 1);
    goals.metal += 20 * (warehouse + 1);
  }
  if (game.stage >= 6 && !game.bank) { goals.wood += 600; goals.metal += 400; }
  if (game.stage >= 4 && !game.townhall) { goals.wood += 300; goals.metal += 150; }
  for (const resource of resourceKeys) {
    const site = access[resource];
    if (!site.available || (resource !== 'water' && site.perWorker * resourceBasePrice(resource) <= site.dollarsPerWorker)) continue;
    const cap = resourceCapacity(capacity, resource, game);
    const deficit = Math.max(resource === 'water' ? site.weeklyConsumption ?? Math.ceil(waterRequirement(game.population) * 1.5) : 0,
      Math.max(goals[resource], cap / 2) - game.stock[resource] - pending[resource]);
    desired[resource] = Math.ceil(Math.min(resourceWorkRoom(capacity, resource, game, pending[resource], site), deficit) / site.perWorker);
  }
  const available = Math.max(0, Math.min(Math.floor(game.population / 2) - exploringWorkers,
    game.population - Math.max(2, exploringWorkers)));
  const weeklyWater = access.water.weeklyConsumption ?? Math.ceil(waterRequirement(game.population) * 1.5);
  allocation.water = Math.min(available, desired.water,
    access.water.perWorker > 0 ? Math.ceil(weeklyWater / access.water.perWorker) : 0);
  const total = resourceKeys.reduce((sum, resource) => sum + (resource === 'water' ? 0 : desired[resource]), 0);
  const budget = Math.min(available - allocation.water, total);
  if (total && budget) {
    const shares = resourceKeys.filter(resource => resource !== 'water').map(resource => {
      const share = desired[resource] * budget / total;
      allocation[resource] = Math.floor(share);
      return { resource, fraction: share - allocation[resource] };
    }).sort((a, b) => b.fraction - a.fraction || (a.resource === 'metal' ? -1 : b.resource === 'metal' ? 1 : 0));
    let remaining = budget - resourceKeys.reduce((sum, resource) => sum + (resource === 'water' ? 0 : allocation[resource]), 0);
    for (const { resource } of shares) if (remaining > 0 && allocation[resource] < desired[resource]) {
      allocation[resource]++; remaining--;
    }
  }
  const plan = fundAllocation(game, pending, capacity, allocation, access, exploringWorkers, reserve, true, payOnPickup);
  const assigned = resourceKeys.reduce((sum, resource) => sum + plan.crews[resource], 0);
  let extra = Math.max(0, available - assigned);
  while (extra > 0) {
    let best: Resource | undefined, bestValue = 0, bestCost = Infinity, bestCount = 0;
    for (const resource of resourceKeys) {
      const site = access[resource];
      if (!site.available || site.perWorker <= 0) continue;
      const room = Math.max(0, resourceWorkRoom(capacity, resource, game, pending[resource], site) - plan.crews[resource] * site.perWorker);
      const cost = transportCost(resource, plan.crews[resource] + 1, site.dollarsPerWorker) - transportCost(resource, plan.crews[resource], site.dollarsPerWorker);
      const value = Math.min(room, site.perWorker) * resourceBasePrice(resource) - cost;
      if (room <= 0 || value < 0 || (game.stock.water < game.population * dailyWaterPerResident && resource !== 'water')
        || (!payOnPickup && cost * dollarsScale > Math.max(0, plan.dollars - reserve * dollarsScale))) continue;
      if (value > bestValue || (value === bestValue && cost < bestCost)) {
        // Marginal value stays constant while whole workers fit and the basic-worker threshold is not crossed,
        // so assign that whole block at once instead of one resident per iteration.
        const basic = basicWorkers(resource) - plan.crews[resource];
        const affordable = payOnPickup || cost <= 0 ? Infinity : Math.floor(Math.max(0, plan.dollars - reserve * dollarsScale) / (cost * dollarsScale));
        best = resource; bestValue = value; bestCost = cost;
        bestCount = Math.max(1, Math.min(extra, Math.floor(room / site.perWorker), basic > 0 ? basic : Infinity, affordable));
      }
    }
    if (!best) break;
    plan.allocation[best] += bestCount;
    plan.crews[best] += bestCount;
    if (!payOnPickup) plan.dollars -= bestCost * bestCount * dollarsScale;
    extra -= bestCount;
  }
  let waiting = Math.max(0, available - resourceKeys.reduce((sum, resource) => sum + plan.crews[resource], 0));
  plan.unfundedWorkers = 0;
  for (const resource of fundingOrder) {
    const unfunded = Math.min(plan.allocation[resource] - plan.crews[resource], waiting);
    plan.allocation[resource] = plan.crews[resource] + unfunded;
    plan.unfundedWorkers += unfunded;
    waiting -= unfunded;
  }
  return plan;
}
