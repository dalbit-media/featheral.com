import { build, diplomacy, discover, invite, newGame, note, pay, radius, recruitmentAmount, recruitmentDollars, stages, survey, terrainAt, terrainDetails, terrainResources, upgrade } from '../src/engine.ts';
import { randomInt } from 'node:crypto';
import type { Resource, Stock } from '../src/engine.ts';
import type { Command, Expedition, Snapshot, Workforce } from '../src/api-types.ts';
import { claimCooldownMs, environmentAt, worldDayMs, worldWeekMs } from '../src/environment.ts';
import { balancedAllocation, editableAllocation, emptyAllocation, expeditionSurveyRadius, explorationCount, explorationQuote, investigationQuote, fundAllocation, nextExploration, resourceAccess, resourceCapacity, resourceWorkRoom, warehouseCapacity, workforceCounts } from '../src/workforce.ts';
import { isCraftableItem, isDecorationItem, isDecorationSlot, isVisibilityItem, sellableItemCount } from '../src/items.ts';
import type { ItemInventory } from '../src/items.ts';
import { addPermitFind, arrange, collectFinds, craft, decorate, equip, equipActivity, expandInventory, findCollectible, findCollectionItem, investigationItem, inventory } from './inventory.ts';
import { isSettlementEntity } from '../src/settlement-layout.ts';
import { fthgScale } from '../src/fthg.ts';
import { dailyWaterPerResident, settlementConsumptionForDays, settlementUpkeep, settlementUpkeepResources, waterConsumptionForDays, waterRequirement, waterUpkeep } from '../src/upkeep.ts';
import { isWaterFacility } from '../src/water-facilities.ts';
import { isIncomeFacility, weeklyIncome } from '../src/income.ts';
import { maximumUpgradeLevel, warehouseCost } from '../src/costs.ts';
import { dollarsScale } from '../src/dollars.ts';
import { constructionCost, constructionLevel, constructions, isConstruction } from '../src/constructions.ts';
import { collectionItemDetails, isCollectionItem } from '../src/collection.ts';
import { activityItemDetails, activityKinds, isActivityItem, isActivityKind } from '../src/automation.ts';
import type { ActivityKind } from '../src/automation.ts';
import { findActivityItem, findCustomizationItem, useCustomization } from './inventory.ts';
import { customizationName, isCustomizationItem, isTitleItem, titleItems } from '../src/customization.ts';
import type { Customization } from '../src/customization.ts';
import { startingFederations } from '../src/atlas.ts';
import { expeditionFindPlan } from '../src/climate.ts';
import { actionRemaining, actionThrottleMs, timedActionKey } from '../src/action-timing.ts';
import type { TimedAction } from '../src/action-timing.ts';
import { activityEquipmentItems, isActivityEquipment, isEquipmentActivity } from '../src/activity-equipment.ts';
import { validCraftingQuantity } from '../src/bulk-crafting.ts';
import { consumeTransportVoucher, transportQuote } from '../src/transport-items.ts';
import { isSquadActivity, isSquadItem, planSquad, squadItems } from '../src/exploration-squads.ts';
import type { SquadActivity, SquadMission } from '../src/exploration-squads.ts';

interface LegacyWorkforce {
  crews: Partial<Record<Resource, { workers: number; readyAt: number; weeklyYield: number;
    x: number; y: number; lockedUntil: number }>>;
  expedition: Expedition | null;
}
type SingleWorkforce = Omit<Workforce, 'version' | 'expeditions'> & { version: 2; expedition: Expedition | null };
type StoredWorkforce = Workforce | SingleWorkforce | LegacyWorkforce;
type StoredSnapshotUpkeep = Omit<NonNullable<Snapshot['waterUpkeep']>, 'dailyConsumption'> & { dailyConsumption?: number };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface Account {
  actionReadyAt?: Snapshot['actionReadyAt'];
  customization?: Customization;
  physicalVersion?: 1;
  physicalStartedAt?: number;
  currencyVersion: 2 | 3 | 4;
  noMintVersion?: 1;
  playabilityVersion?: 1;
  pickupVersion?: 1;
  pickupFees?: Stock;
  automationUntil?: Stock;
  activityAutomation?: Record<ActivityKind, { until: number; enabled: boolean; nextAt: number }>;
  fthg: number;
  game: Snapshot['game'];
  pending: Stock;
  warehouse: number;
  revision: number;
  updatedAt: number;
  lastActionAt: number;
  lastClaimAt: number;
  inviteReadyAt: number;
  incomeReadyAt: number;
  recruitment?: Snapshot['recruitment'];
  waterUpkeep?: { version?: 2; readyAt: number; lastPopulationLoss: number; paused?: boolean };
  settlementUpkeep?: { version: 1; readyAt: number; oilStartedAt?: number; remainder: { wood: number; metal: number; oil?: number } };
  populationCycle?: { readyAt: number; required: Record<'water' | 'wood' | 'metal', number> & { oil?: number }; shortage: Record<'water' | 'wood' | 'metal', number> & { oil?: number }; lossRemainder: number; lastChange: number };
  workforce?: StoredWorkforce;
  inventory?: ItemInventory;
  receipt: { id: string; request: string; result: Omit<Snapshot, 'workforce' | 'inventory' | 'waterUpkeep'> & { workforce?: StoredWorkforce; inventory?: ItemInventory; waterUpkeep?: StoredSnapshotUpkeep | null; message: string } } | null;
}
export const resources: Resource[] = ['wood', 'water', 'metal', 'oil'];
const empty = (): Stock => ({ wood: 0, water: 0, metal: 0, oil: 0 });
const minute = 60000;
export function createAccount(now: number): Account {
  const game = newGame();
  discover(game);
  return { physicalVersion: 1, physicalStartedAt: now, currencyVersion: 4, noMintVersion: 1, playabilityVersion: 1, pickupVersion: 1, pickupFees: empty(), automationUntil: empty(), fthg: 0, game, pending: empty(), warehouse: 0, revision: 0, updatedAt: now, lastActionAt: 0, lastClaimAt: 0, incomeReadyAt: now + worldWeekMs,
    inviteReadyAt: 0, recruitment: null, workforce: newWorkforce(now), receipt: null };
}
export function migrateClock(account: Account, realTime: number, serverTime: number): void {
  const speed = 'growthMultiplier' in account && account.growthMultiplier === 10 ? 10 : 1;
  const readyAt = account.inviteReadyAt ?? 0;
  // Preserve pending balances and express remaining work in server-time units.
  const elapsedTime = account.updatedAt + Math.max(0, realTime - account.updatedAt) * speed;
  migrateEconomy(account, elapsedTime);
  accrue(account, elapsedTime);
  const work = workforce(account), shift = serverTime - elapsedTime;
  work.cycleAt += shift;
  for (const crew of Object.values(work.crews)) crew.readyAt += shift;
  for (const expedition of work.expeditions) expedition.readyAt += shift;
  if (account.recruitment) {
    account.recruitment.startedAt += shift;
    account.recruitment.readyAt += shift;
  }
  if (account.waterUpkeep) account.waterUpkeep.readyAt += shift;
  if (account.settlementUpkeep) account.settlementUpkeep.readyAt += shift;
  if (account.settlementUpkeep?.oilStartedAt !== undefined) account.settlementUpkeep.oilStartedAt += shift;
  if (account.populationCycle) account.populationCycle.readyAt += shift;
  if (account.physicalStartedAt !== undefined) account.physicalStartedAt += shift;
  if (account.activityAutomation) for (const automation of Object.values(account.activityAutomation)) {
    automation.until += shift; automation.nextAt += shift;
  }
  account.incomeReadyAt += shift;
  account.updatedAt = serverTime;
  account.inviteReadyAt = account.recruitment?.readyAt ?? (readyAt ? serverTime + Math.max(0, readyAt - realTime) * speed : 0);
  if ('growthMultiplier' in account) delete account.growthMultiplier;
  if (account.receipt) {
    const result = account.receipt.result;
    result.rates = rates({ ...account, game: result.game });
    result.inviteReadyAt = account.inviteReadyAt;
    if ('growthMultiplier' in result) delete result.growthMultiplier;
  }
}
export function capacity(account: Account): number {
  return warehouseCapacity(account.game, account.warehouse);
}
export function rates(account: Account): Stock {
  const production = empty();
  for (const resource of resources) production[resource] = account.workforce?.crews[resource]?.weeklyYield ?? 0;
  return production;
}
function workforce(account: Account): Workforce {
  migrateEconomy(account, account.updatedAt);
  return account.workforce as Workforce;
}
function newWorkforce(now: number): Workforce {
  return { version: 3, transportVersion: 1, automatic: true, allocation: empty(), cycleAt: now + worldWeekMs,
    unfundedWorkers: 0, crews: {}, expeditions: [] };
}
export function migratePhysicalEconomy(account: Account, now: number): void {
  if (account.physicalVersion === 1) return;
  account.physicalVersion = 1;
  account.physicalStartedAt = now;
  account.revision++;
}
function physicalAt(account: Account, time: number): boolean {
  return account.physicalVersion === 1 && time >= (account.physicalStartedAt ?? 0);
}
function climateTime(account: Account, time = account.updatedAt): number | undefined {
  return physicalAt(account, time) ? time : undefined;
}
function hydration(account: Account, time = account.updatedAt) {
  return waterUpkeep(account.game.population, account.game.stock.water, climateTime(account, time), !physicalAt(account, time));
}
export function migrateEconomy(account: Account, now: number): void {
  migratePhysicalEconomy(account, now);
  const upgradingPlayability = !account.playabilityVersion;
  if (!account.noMintVersion) {
    account.noMintVersion = 1;
    account.revision++;
  }
  if (!account.playabilityVersion) {
    account.playabilityVersion = 1;
    for (const resource of resources) {
      const units = Math.floor(account.pending[resource] / minute);
      if (!Number.isSafeInteger(account.game.stock[resource] + units)) throw new ApiError(409, 'Account limit reached.');
      account.game.stock[resource] += units;
      account.pending[resource] -= units * minute;
    }
    if (account.waterUpkeep) account.waterUpkeep.lastPopulationLoss = 0;
    account.revision++;
  }
  if (!account.pickupVersion) {
    account.pickupVersion = 1;
    account.pickupFees = empty();
    account.automationUntil = empty();
    account.revision++;
  }
  const previous = account.workforce;
  if (previous && 'version' in previous) {
    if (previous.version === 3) {
      if (!previous.transportVersion) {
        previous.transportVersion = 1;
        account.revision++;
      }
      return;
    }
    const { expedition, ...saved } = previous;
    account.workforce = { ...saved, version: 3, transportVersion: 1, expeditions: expedition ? [expedition] : [] };
    if (!saved.transportVersion) account.revision++;
    return;
  }
  const work = newWorkforce(now);
  if (previous) {
    work.expeditions = previous.expedition ? [previous.expedition] : [];
    for (const resource of resources) {
      const crew = previous.crews[resource];
      if (!crew) continue;
      const elapsed = now < crew.readyAt ? 0 : 1 + Math.floor((now - crew.readyAt) / worldWeekMs);
      const room = Math.max(0, resourceCapacity(capacity(account), resource) * minute - account.pending[resource]);
      const completed = Math.min(room, Math.min(elapsed, Math.ceil(room / (crew.weeklyYield * minute))) * crew.weeklyYield * minute);
      if (upgradingPlayability) {
        const units = Math.floor(completed / minute);
        if (!Number.isSafeInteger(account.game.stock[resource] + units)) throw new ApiError(409, 'Account limit reached.');
        account.game.stock[resource] += units;
      } else account.pending[resource] += completed;
      const readyAt = crew.readyAt + elapsed * worldWeekMs;
      work.crews[resource] = { workers: crew.workers, readyAt, weeklyYield: crew.weeklyYield, weeklyMetalCost: 0 };
    }
    const deadlines = Object.values(work.crews).map(crew => crew.readyAt);
    work.cycleAt = deadlines.length ? Math.max(...deadlines) : now;
  } else {
    work.cycleAt = now;
  }
  account.workforce = work;
}
function expeditionWorkers(work: Workforce): number {
  return work.expeditions.reduce((sum, expedition) => sum + expedition.workers, 0);
}
export function initializeUpkeep(account: Account, now: number): void {
  if (account.game.stage >= 0 && account.waterUpkeep?.version !== 2) {
    account.waterUpkeep = { version: 2, readyAt: now + worldDayMs, lastPopulationLoss: 0 };
  }
  if (account.game.stage >= 0 && !account.settlementUpkeep) {
    account.settlementUpkeep = { version: 1, readyAt: now + worldDayMs, remainder: { wood: 0, metal: 0 } };
  }
  if (account.settlementUpkeep && account.settlementUpkeep.oilStartedAt === undefined) {
    account.settlementUpkeep.oilStartedAt = now + worldDayMs;
    account.settlementUpkeep.remainder.oil = 0;
  }
  if (account.game.stage >= 0 && !account.populationCycle) {
    account.populationCycle = { readyAt: now + worldWeekMs, required: { water: 0, wood: 0, metal: 0 },
      shortage: { water: 0, wood: 0, metal: 0 }, lossRemainder: 0, lastChange: 0 };
  }
}
function recordPopulationSupply(account: Account, resource: Resource, required: number, shortage: number, firstDay: number, days: number): void {
  const cycle = account.populationCycle;
  if (!cycle || !account.game.population) return;
  const ignoredDays = Math.min(days, Math.max(0, 1 + Math.floor((cycle.readyAt - worldWeekMs - firstDay) / worldDayMs)));
  if (ignoredDays === days) return;
  if (ignoredDays) {
    required -= resource === 'water' ? waterForDays(account, ignoredDays)
      : settlementConsumptionForDays(resource, account.game.population, firstDay, ignoredDays, account.game.stage);
    shortage = Math.min(required, shortage);
  }
  cycle.required[resource] = (cycle.required[resource] ?? 0) + required;
  cycle.shortage[resource] = (cycle.shortage[resource] ?? 0) + shortage;
}
function updatePopulation(account: Account): void {
  const cycle = account.populationCycle!, population = account.game.population;
  const shortage = Math.max(...resources.map(resource => {
    const required = cycle.required[resource] ?? 0;
    return required > 0 ? (cycle.shortage[resource] ?? 0) / required : 0;
  }));
  let change = 0;
  if (population > 0 && shortage > 0) {
    const loss = population * .05 * Math.min(1, shortage) + cycle.lossRemainder;
    change = -Math.min(population, Math.floor(loss));
    cycle.lossRemainder = loss - Math.floor(loss);
  } else if (population > 0 && (['water', 'wood', 'metal'] as const).every(resource => cycle.required[resource] > 0)) {
    change = Math.max(1, Math.floor(population * .01));
    cycle.lossRemainder = 0;
  }
  if (!Number.isSafeInteger(population + change)) throw new ApiError(409, 'Population limit reached.');
  account.game.population += change;
  cycle.lastChange = change;
  cycle.readyAt += worldWeekMs;
  cycle.required = { water: 0, wood: 0, metal: 0 };
  cycle.shortage = { water: 0, wood: 0, metal: 0 };
  if (change) note(account.game, change > 0
    ? `${change.toLocaleString()} residents joined through natural weekly growth.`
    : `${(-change).toLocaleString()} residents left because consumption supplies were insufficient.`);
  const previous = account.game.stage;
  while (account.game.stage > 0 && account.game.population * 2 < stages[account.game.stage].population) account.game.stage--;
  if (account.game.stage !== previous) note(account.game, `Settlement downgraded to ${stages[account.game.stage].name}. Population fell below half the required residents. Buildings and items are retained.`);
  if (change || account.game.stage !== previous) account.revision++;
}
function settlementSupplyReason(account: Account): string | null {
  if (hydration(account).shortage) return 'Restore Water supplies before starting advanced activity.';
  if (!account.settlementUpkeep || account.updatedAt < account.settlementUpkeep.readyAt - worldDayMs) return null;
  for (const resource of settlementUpkeepResources) {
    if (settlementUpkeep(resource, account.game.population, Math.max(0, account.game.stock[resource] - (account.settlementUpkeep.remainder[resource] ?? 0) / 10000), account.settlementUpkeep.readyAt, account.game.stage).shortage)
      return resource === 'wood' ? 'Restore Wood heating supplies before starting advanced activity.' : resource === 'metal' ? 'Restore Metal repair supplies before starting advanced activity.' : 'Restore Oil fuel supplies before starting advanced activity.';
  }
  return null;
}
function consumeSettlementDays(account: Account, until: number): void {
  const upkeep = account.settlementUpkeep!;
  const days = 1 + Math.floor((until - upkeep.readyAt) / worldDayMs);
  if (days <= 0) return;
  for (const resource of settlementUpkeepResources) {
    const skipped = resource === 'oil' ? Math.min(days, Math.max(0, Math.ceil((upkeep.oilStartedAt! - upkeep.readyAt) / worldDayMs))) : 0;
    const firstDay = upkeep.readyAt + skipped * worldDayMs;
    const required = settlementConsumptionForDays(resource, account.game.population, firstDay, days - skipped, account.game.stage);
    const remainder = upkeep.remainder[resource] ?? 0;
    const available = Math.max(0, account.game.stock[resource] - remainder / 10000);
    recordPopulationSupply(account, resource, required, Math.max(0, required - available), firstDay, days - skipped);
    const units = Math.round(required * 10000) + remainder;
    if (!Number.isSafeInteger(units)) throw new ApiError(409, 'Account limit reached.');
    const consumed = Math.floor(units / 10000);
    upkeep.remainder[resource] = units % 10000;
    account.game.stock[resource] -= Math.min(account.game.stock[resource], consumed);
  }
  upkeep.readyAt += days * worldDayMs;
}
function consumeWater(account: Account): void {
  const upkeep = account.waterUpkeep!;
  const result = hydration(account, upkeep.readyAt);
  recordPopulationSupply(account, 'water', result.required, result.shortage, upkeep.readyAt, 1);
  account.game.stock.water -= result.consumed;
  upkeep.paused = result.shortage > 0;
  upkeep.lastPopulationLoss = 0;
  upkeep.readyAt += worldDayMs;
}
function waterForDays(account: Account, days: number): number {
  const first = account.waterUpkeep!.readyAt;
  const legacyDays = Math.min(days, Math.max(0, Math.ceil(((account.physicalStartedAt ?? first) - first) / worldDayMs)));
  return waterConsumptionForDays(account.game.population, first, legacyDays, true)
    + waterConsumptionForDays(account.game.population, first + legacyDays * worldDayMs, days - legacyDays);
}
function skipWaterDays(account: Account, until: number): void {
  const upkeep = account.waterUpkeep!;
  const days = 1 + Math.floor((until - upkeep.readyAt) / worldDayMs);
  if (days <= 0) return;
  const required = waterForDays(account, days);
  recordPopulationSupply(account, 'water', required, Math.max(0, required - account.game.stock.water), upkeep.readyAt, days);
  upkeep.paused = required > account.game.stock.water;
  account.game.stock.water -= Math.min(account.game.stock.water, required);
  upkeep.readyAt += days * worldDayMs;
  upkeep.lastPopulationLoss = 0;
}
function beginCycle(account: Account, now: number, access = resourceAccess(account.game, climateTime(account, now), !physicalAt(account, now)),
  exploringWorkers = expeditionWorkers(workforce(account))): void {
  const work = workforce(account);
  work.cycleAt = now + worldWeekMs;
  work.crews = {};
  work.unfundedWorkers = 0;
  if (account.game.stage < 0) return;
  initializeUpkeep(account, now);
  const pending = emptyAllocation();
  for (const resource of resources) pending[resource] = account.pending[resource] / minute;
  const reserve = 0;
  const plan = work.automatic
    ? balancedAllocation(account.game, pending, capacity(account), account.warehouse, access, exploringWorkers, reserve, true)
    : fundAllocation(account.game, pending, capacity(account), work.allocation, access, exploringWorkers, reserve, false, true);
  work.allocation = plan.allocation;
  work.unfundedWorkers = plan.unfundedWorkers;
  account.game.dollars = plan.dollars;
  for (const resource of resources) {
    const site = access[resource], workers = plan.crews[resource];
    if (!workers) continue;
    const weeklyDollarsCost = workers * site.dollarsPerWorker;
    const room = resourceWorkRoom(capacity(account), resource, account.game, pending[resource], site);
    work.crews[resource] = { workers, readyAt: work.cycleAt, weeklyYield: Math.min(workers * site.perWorker, room), weeklyMetalCost: 0, weeklyDollarsCost, payOnPickup: true };
  }
}
export function collectResource(account: Account, resource: Resource, manual = false): number {
  const quantity = Math.floor(account.pending[resource] / minute);
  const bag = inventory(account), quote = transportQuote(account.pickupFees?.[resource] ?? 0, bag);
  if (quantity < 1) throw new ApiError(409, 'No completed resources to collect.');
  if (!Number.isSafeInteger(account.game.stock[resource] + quantity)) throw new ApiError(409, 'Account limit reached.');
  if (!manual) {
    pay(account.game, { dollars: quote.fee / dollarsScale });
    consumeTransportVoucher(bag, quote.item);
  }
  account.game.stock[resource] += quantity;
  account.pending[resource] -= quantity * minute;
  if (account.pickupFees) account.pickupFees[resource] = 0;
  return quantity;
}
export function availableWorkers(account: Account): number {
  return workforceCounts(account.game.population, workforce(account)).available;
}
function activityReason(account: Account, activity: ActivityKind): string | null {
  const automation = account.activityAutomation?.[activity];
  if (!automation || automation.until <= account.updatedAt) return 'Inactive';
  if (!automation.enabled) return 'Automation paused';
  if (account.game.stage < 0) return 'Settlement required.';
  const supplyReason = settlementSupplyReason(account);
  if (supplyReason) return supplyReason;
  if (activity === 'exploration') {
    const work = workforce(account);
    if (work.expeditions.some(expedition => expedition.kind !== 'investigate')) return 'Waiting for expedition return';
    if (availableWorkers(account) < 2) return 'Waiting for idle residents';
    const next = nextExploration(account.game, work.expeditions);
    if (!next) return 'No reachable unexplored terrain';
    if (account.game.dollars < next.dollars * dollarsScale) return 'Not enough FTH$ for this expedition.';
  } else {
    if (account.recruitment) return 'Waiting for recruitment arrival';
    const amount = recruitmentAmount(account.game.population, constructionLevel(account.game, 'housing'), climateTime(account));
    const cost = recruitmentDollars(account.game.population, constructionLevel(account.game, 'housing'), climateTime(account), account.game);
    if (!Number.isSafeInteger(account.game.population + amount) || !Number.isSafeInteger(cost * dollarsScale)) return 'Population limit reached';
    if (account.game.dollars < cost * dollarsScale) return 'Not enough FTH$ for recruitment.';
  }
  return null;
}
function runActivityAutomation(account: Account, event: number): void {
  if (!account.activityAutomation) return;
  for (const activity of activityKinds) {
    const automation = account.activityAutomation[activity];
    if (!automation.enabled || automation.nextAt > event || event >= automation.until) continue;
    account.updatedAt = event;
    const reason = activityReason(account, activity);
    if (reason) {
      automation.nextAt = activity === 'exploration' && workforce(account).expeditions.some(expedition => expedition.kind !== 'investigate')
        ? Math.max(...workforce(account).expeditions.filter(expedition => expedition.kind !== 'investigate').map(expedition => expedition.readyAt))
        : activity === 'attraction' && account.recruitment ? account.recruitment.readyAt : event + worldDayMs;
      continue;
    }
    if (activity === 'exploration') {
      const next = nextExploration(account.game, workforce(account).expeditions)!;
      execute(account, { type: 'move', x: next.x, y: next.y }, event);
      automation.nextAt = workforce(account).expeditions.find(expedition => expedition.kind !== 'investigate')!.readyAt;
    } else {
      execute(account, { type: 'invite' }, event);
      automation.nextAt = account.recruitment!.readyAt;
    }
    account.revision++;
  }
}
export function accrue(account: Account, time: number): void {
  inventory(account);
  const now = Math.max(account.updatedAt, time);
  initializeUpkeep(account, now);
  const cap = capacity(account);
  const work = workforce(account);
  let completed = 0, exploringWorkers = expeditionWorkers(work);
  while (true) {
    const event = Math.min(work.cycleAt, work.expeditions[completed]?.readyAt ?? Infinity, account.recruitment?.readyAt ?? Infinity, account.waterUpkeep?.readyAt ?? Infinity, account.settlementUpkeep?.readyAt ?? Infinity,
      account.game.population > 0 ? account.populationCycle?.readyAt ?? Infinity : Infinity,
      ...Object.values(account.activityAutomation ?? {}).filter(automation => automation.enabled && automation.nextAt < automation.until).map(automation => automation.nextAt),
      ...Object.values(work.crews).map(crew => crew.readyAt));
    if (event > now) break;
    while (work.expeditions[completed] && work.expeditions[completed].readyAt <= event) {
      const expedition = work.expeditions[completed++];
      if (expedition.kind === 'investigate') {
        if (expedition.itemFind) addPermitFind(account, expedition.itemFind);
        exploringWorkers -= expedition.workers;
        note(account.game, expedition.workers === 1
          ? expedition.itemFind ? 'Investigation returned with a permit. One resident is available.' : 'Investigation returned without an item. One resident is available.'
          : expedition.itemFind ? 'Investigation returned with a permit. 2 residents are available.' : 'Investigation returned without an item. 2 residents are available.');
        continue;
      }
      const before = account.game.explored.length;
      survey(account.game, expedition, expedition.surveyRadius);
      const discovered = account.game.explored.length - before;
      if (discovered > 0) {
        const terrain = terrainAt(expedition.x, expedition.y, account.game.seed);
        if (expedition.finds?.collectible ?? true) findCollectible(account, terrain);
        for (let i = 0; i < (expedition.finds?.collection ?? 1); i++) findCollectionItem(account, terrain);
        for (let i = 0; i < (expedition.finds?.activity ?? 1); i++) findActivityItem(account, terrain);
        if (expedition.finds?.collectible ?? true) findCustomizationItem(account, terrain);
      }
      account.game.contribution += discovered;
      exploringWorkers -= expedition.workers;
      note(account.game, `Expedition returned from ${terrainDetails[terrainAt(expedition.x, expedition.y, account.game.seed)].name}. Charted ${discovered} new tiles; ${expedition.workers} residents are available.`);
    }
    for (const resource of resources) {
      const crew = work.crews[resource];
      if (!crew || crew.readyAt > event) continue;
      // Storage is reserved at dispatch; smaller limits must not discard locked work.
      const delivery = crew.weeklyYield;
      if (crew.payOnPickup && delivery > 0) {
        if (!Number.isSafeInteger(account.pending[resource] + delivery * minute)) throw new ApiError(409, 'Account limit reached.');
        account.pending[resource] += delivery * minute;
        const fees = account.pickupFees ??= empty();
        fees[resource] += (crew.weeklyDollarsCost ?? 0) * dollarsScale;
        if (!Number.isSafeInteger(fees[resource])) throw new ApiError(409, 'Account limit reached.');
        if ((account.automationUntil?.[resource] ?? 0) >= event && account.game.dollars >= transportQuote(fees[resource], inventory(account)).fee) collectResource(account, resource);
      } else if (!crew.payOnPickup) {
        if (!Number.isSafeInteger(account.game.stock[resource] + delivery)) throw new ApiError(409, 'Account limit reached.');
        account.game.stock[resource] += delivery;
      }
      delete work.crews[resource];
    }
    if (account.waterUpkeep && account.waterUpkeep.readyAt <= event) {
      if (completed) { work.expeditions.splice(0, completed); completed = 0; }
      consumeWater(account);
      exploringWorkers = expeditionWorkers(work);
    }
    if (account.settlementUpkeep && account.settlementUpkeep.readyAt <= event) consumeSettlementDays(account, event);
    if (account.populationCycle && account.populationCycle.readyAt <= event) {
      if (account.game.population > 0 || account.game.stage > 0) updatePopulation(account);
      if (account.populationCycle.readyAt <= event) account.populationCycle.readyAt += (1 + Math.floor((event - account.populationCycle.readyAt) / worldWeekMs)) * worldWeekMs;
    }
    if (account.recruitment && account.recruitment.readyAt <= event) {
      const amount = account.recruitment.population;
      if (!Number.isSafeInteger(account.game.population + amount)) throw new ApiError(409, 'Account limit reached.');
      account.game.population += amount;
      account.recruitment = null;
      account.inviteReadyAt = 0;
      note(account.game, `${amount.toLocaleString()} new residents joined your community.`);
    }
    if (completed) { work.expeditions.splice(0, completed); completed = 0; }
    runActivityAutomation(account, event);
    exploringWorkers = expeditionWorkers(work);
    if (work.cycleAt <= event) {
      beginCycle(account, event, undefined, exploringWorkers);
      // Productive iterations are bounded by finite storage, not elapsed offline time.
      if (!Object.keys(work.crews).length) {
        let until = Math.min(now, (work.expeditions[completed]?.readyAt ?? Infinity) - 1, (account.recruitment?.readyAt ?? Infinity) - 1,
          account.game.population > 0 ? (account.populationCycle?.readyAt ?? Infinity) - 1 : Infinity,
          ...Object.values(account.activityAutomation ?? {}).filter(automation => automation.enabled && automation.nextAt < automation.until).map(automation => automation.nextAt - 1));
        const upkeep = account.waterUpkeep;
        for (const resource of resources) {
          const supplyUpkeep = resource === 'water' ? upkeep : account.settlementUpkeep;
          if (!supplyUpkeep) continue;
          const consumption = (days: number) => resource === 'water' ? waterForDays(account, days)
            : settlementConsumptionForDays(resource, account.game.population, supplyUpkeep!.readyAt, days, account.game.stage);
          const refillBelow = resourceCapacity(cap, resource, account.game) - account.pending[resource] / minute
            + (resource === 'water' ? Math.ceil(waterRequirement(account.game.population) * 1.5) : -1);
          const mayRefill = supplyUpkeep && account.game.population > 0
            && Math.floor(resourceCapacity(cap, resource, account.game) - account.pending[resource] / minute) > 0
            && (resource !== 'metal' || account.game.stock.water >= account.game.population * dailyWaterPerResident)
            && (work.automatic || work.allocation[resource] > 0) && resourceAccess(account.game)[resource].available;
          if (!mayRefill) continue;
          const surplus = account.game.stock[resource] - refillBelow;
          if (surplus <= 0) until = Math.min(until, work.cycleAt - 1);
          else if (supplyUpkeep.readyAt <= until) {
            let low = 1, high = 1 + Math.floor((until - supplyUpkeep.readyAt) / worldDayMs);
            if (consumption(high) > surplus) {
              while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (consumption(middle) > surplus) high = middle;
                else low = middle + 1;
              }
              until = Math.min(until, supplyUpkeep.readyAt + (low - 1) * worldDayMs);
            }
          }
        }
        if (work.cycleAt <= until)
          until = work.cycleAt + Math.floor((until - work.cycleAt) / worldWeekMs) * worldWeekMs - 1;
        if (upkeep && upkeep.readyAt <= until) {
          skipWaterDays(account, until);
        }
        if (account.settlementUpkeep && account.settlementUpkeep.readyAt <= until) consumeSettlementDays(account, until);
        if (account.populationCycle && !account.game.population && account.populationCycle.readyAt <= until)
          account.populationCycle.readyAt += (1 + Math.floor((until - account.populationCycle.readyAt) / worldWeekMs)) * worldWeekMs;
        const idleUntil = Math.min(until, (upkeep?.readyAt ?? Infinity) - 1, (account.settlementUpkeep?.readyAt ?? Infinity) - 1);
        if (work.cycleAt <= idleUntil) work.cycleAt += (1 + Math.floor((idleUntil - work.cycleAt) / worldWeekMs)) * worldWeekMs;
      }
    }
  }
  if (completed) work.expeditions.splice(0, completed);
  account.updatedAt = now;
}
export function snapshot(account: Account): Snapshot {
  const work = workforce(account);
  initializeUpkeep(account, account.updatedAt);
  const bag = inventory(account);
  const pending = empty();
  for (const resource of resources) pending[resource] = Math.floor(account.pending[resource] / minute);
  const cap = capacity(account);
  const waterTime = account.waterUpkeep?.readyAt ?? account.updatedAt;
  const water = hydration(account, waterTime);
  const supplyTime = account.settlementUpkeep?.readyAt ?? account.updatedAt;
  const supplyResources = Object.fromEntries(settlementUpkeepResources.map(resource => {
    const readyAt = resource === 'oil' ? supplyTime + Math.max(0, Math.ceil(((account.settlementUpkeep?.oilStartedAt ?? supplyTime) - supplyTime) / worldDayMs)) * worldDayMs : supplyTime;
    const use = settlementUpkeep(resource, account.game.population, Math.max(0, account.game.stock[resource] - (account.settlementUpkeep?.remainder[resource] ?? 0) / 10000), readyAt, account.game.stage);
    return [resource, { readyAt, dailyConsumption: use.required, weeklyConsumption: settlementConsumptionForDays(resource, account.game.population, readyAt, 7, account.game.stage), shortage: use.shortage }];
  })) as NonNullable<Snapshot['settlementUpkeep']>['resources'];
  return { ...(account.customization ? { customization: structuredClone(account.customization) } : {}), physicalVersion: account.physicalVersion, fthg: account.fthg / fthgScale, dollars: account.game.dollars / dollarsScale, income: { weekly: weeklyIncome(account.game) / dollarsScale, readyAt: 0 }, inventory: structuredClone(bag), game: structuredClone(account.game), pending, rates: rates(account), capacity: cap, claimThreshold: Math.ceil(cap / 2),
    ...(account.activityAutomation ? { activityAutomation: {
      exploration: { ...account.activityAutomation.exploration, reason: activityReason(account, 'exploration') },
      attraction: { ...account.activityAutomation.attraction, reason: activityReason(account, 'attraction') },
    } } : {}),
    warehouse: account.warehouse, warehouseCost: account.warehouse >= maximumUpgradeLevel ? null : warehouseCost(account.warehouse + 1),
    revision: account.revision, serverTime: account.updatedAt, environment: environmentAt(account.updatedAt),
    populationCycle: account.populationCycle ? { readyAt: account.populationCycle.readyAt, lastChange: account.populationCycle.lastChange } : null,
    actionReadyAt: { ...account.actionReadyAt },
    inviteReadyAt: account.inviteReadyAt, recruitment: structuredClone(account.recruitment ?? null),
    waterUpkeep: account.waterUpkeep ? { ...account.waterUpkeep, paused: water.shortage > 0, dailyConsumption: water.required, weeklyConsumption: waterRequirement(account.game.population, climateTime(account, waterTime), !physicalAt(account, waterTime)),
      shortage: water.shortage, populationLoss: water.populationLoss } : null,
    settlementUpkeep: account.settlementUpkeep ? { readyAt: supplyTime, paused: Object.values(supplyResources).some(resource => resource.shortage > 0), resources: supplyResources } : null,
    workforce: structuredClone(work), availableWorkers: availableWorkers(account),
    collection: { fees: Object.fromEntries(resources.map(resource => [resource, transportQuote(account.pickupFees?.[resource] ?? 0, bag).fee / dollarsScale])) as Stock,
      vouchers: Object.fromEntries(resources.flatMap(resource => {
        const quote = pending[resource] > 0 ? transportQuote(account.pickupFees?.[resource] ?? 0, bag) : null;
        return quote?.item ? [[resource, quote.item]] : [];
      })),
      automationUntil: { ...(account.automationUntil ?? empty()) } },
    resourceAccess: resourceAccess(account.game, climateTime(account), !physicalAt(account, account.updatedAt)),
    recruitmentDollars: recruitmentDollars(account.game.population, constructionLevel(account.game, 'housing'), climateTime(account), account.game) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function parseCommand(value: unknown): Command {
  const c = object(value);
  const resourceClaim = c.type === 'claim' && Object.hasOwn(c, 'resource');
  const fields: Record<string, string[]> = {
    move: ['x', 'y'], investigate: ['x', 'y'], trade: ['resource', 'direction', 'amount'], build: ['kind'], construction: ['kind'], diplomacy: Object.hasOwn(c, 'federation') ? ['action', 'federation'] : ['action'],
    upgrade: [], invite: [], home: [], gather: [], claim: resourceClaim ? ['resource'] : [], warehouse: [],
    assign: ['resource', 'workers'], automatic: ['enabled'],
    craft: Object.hasOwn(c, 'quantity') ? ['item', 'quantity'] : ['item'], 'map-collect': ['x', 'y'], equip: ['item'], decorate: ['slot', 'item'], 'item-storage': [], 'collect-items': [],
    arrange: ['entity', 'position'],
    'activate-collection': ['item'], 'collect-sell': ['resource', 'quantity', 'minimumDollars'],
    'use-customization': ['item', 'value'],
    'activate-activity': ['item'], 'activity-automation': ['activity', 'enabled'],
    'activity-gear': ['activity', 'item'],
    'dispatch-squad': ['item', 'activity', 'quantity', 'maximumDollars'],
    'federation-contribute': ['asset', 'amount'],
  };
  if (typeof c.type !== 'string' || !Object.hasOwn(fields, c.type)
    || Object.keys(c).sort().join() !== ['type', ...fields[c.type]].sort().join()) throw new ApiError(400, 'Invalid command fields.');
  const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
  if (c.type === 'arrange' && c.position !== null) {
    const position = object(c.position);
    if (Object.keys(position).sort().join() !== 'x,y' || ![position.x, position.y].every(n => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 1000000)) throw new ApiError(400, 'Invalid command values.');
  }
  if (((c.type === 'move' || c.type === 'map-collect' || c.type === 'investigate') && ![c.x, c.y].every(n => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 1000000))
    || (c.type === 'federation-contribute' && (!oneOf(c.asset, [...resources, 'dollars']) || typeof c.amount !== 'number'
      || !Number.isFinite(c.amount) || c.amount <= 0 || c.amount > 100000000
      || (c.asset === 'dollars' ? !/^\d+(?:\.\d{1,4})?$/.test(String(c.amount)) : !Number.isSafeInteger(c.amount))))
    || (c.type === 'trade' && (!oneOf(c.resource, resources) || !oneOf(c.direction, ['buy', 'sell']) || typeof c.amount !== 'number' || !Number.isSafeInteger(c.amount) || c.amount < 1 || c.amount > 10000))
    || (c.type === 'build' && !oneOf(c.kind, ['bank', 'townhall']) && !isWaterFacility(c.kind) && !isIncomeFacility(c.kind))
    || (c.type === 'construction' && !isConstruction(c.kind))
    || (c.type === 'craft' && (!isCraftableItem(c.item) || (Object.hasOwn(c, 'quantity') && (typeof c.quantity !== 'number' || !validCraftingQuantity(c.quantity)))))
    || (c.type === 'equip' && c.item !== null && !isVisibilityItem(c.item))
    || (c.type === 'activity-gear' && (!isEquipmentActivity(c.activity) || (c.item !== null && (!isActivityEquipment(c.item) || activityEquipmentItems[c.item].activity !== c.activity))))
    || (c.type === 'dispatch-squad' && (!isSquadItem(c.item) || !isSquadActivity(c.activity)
      || typeof c.quantity !== 'number' || !Number.isSafeInteger(c.quantity) || c.quantity < 1 || c.quantity > squadItems[c.item].quantity
      || typeof c.maximumDollars !== 'number' || !Number.isSafeInteger(c.maximumDollars) || c.maximumDollars < 1))
    || (c.type === 'decorate' && (!isDecorationSlot(c.slot) || (c.item !== null && !isDecorationItem(c.item))))
    || (c.type === 'arrange' && !isSettlementEntity(c.entity))
    || (c.type === 'diplomacy' && (!oneOf(c.action, ['gift', 'join', 'form', 'vote'])
      || Object.hasOwn(c, 'federation') && (c.action !== 'join' || !startingFederations.some(identity => identity.name === c.federation))))
    || (c.type === 'assign' && (!oneOf(c.resource, resources)
      || typeof c.workers !== 'number' || !Number.isSafeInteger(c.workers) || c.workers < 0 || c.workers > 1000000))
    || (c.type === 'automatic' && typeof c.enabled !== 'boolean')
    || (c.type === 'activate-collection' && !isCollectionItem(c.item))
    || (c.type === 'use-customization' && (!isCustomizationItem(c.item) || typeof c.value !== 'string'
      || (isTitleItem(c.item) ? c.value !== titleItems[c.item].title : !customizationName(c.value))))
    || (c.type === 'activate-activity' && !isActivityItem(c.item))
    || (c.type === 'activity-automation' && (!isActivityKind(c.activity) || typeof c.enabled !== 'boolean'))
    || (c.type === 'collect-sell' && (!oneOf(c.resource, resources) || typeof c.quantity !== 'number' || !Number.isSafeInteger(c.quantity) || c.quantity < 1
      || typeof c.minimumDollars !== 'number' || !Number.isSafeInteger(c.minimumDollars) || c.minimumDollars < 1))
    || (resourceClaim && !oneOf(c.resource, resources))) throw new ApiError(400, 'Invalid command values.');
  return c as Command;
}
function enforceActionThrottle(account: Account, action: TimedAction, realTime: number): void {
  const remaining = actionRemaining(account.actionReadyAt, action, realTime);
  if (remaining) throw new ApiError(429, `Action cooling down. Try again in ${Math.ceil(remaining / 1000)} seconds.`);
}
export function execute(account: Account, command: Command, realTime = account.updatedAt,
  sellPickup?: (command: Extract<Command, { type: 'collect-sell' }>) => string,
  contribute?: (command: Extract<Command, { type: 'federation-contribute' }>) => string): string {
  const key = timedActionKey(command);
  inventory(account);
  if (key && key !== 'investigate') enforceActionThrottle(account, key, realTime);
  const message = executeCommand(account, command, realTime, sellPickup, contribute);
  if (key) (account.actionReadyAt ??= {})[key] = realTime + actionThrottleMs;
  return message;
}
function fieldExpedition(account: Account, activity: SquadActivity, mission: SquadMission): Expedition {
  const { x, y, weeks } = mission;
  if (activity === 'investigation') {
    const itemFind = investigationItem(terrainAt(x, y, account.game.seed), randomInt(100), randomInt(100), randomInt(100));
    return { kind: 'investigate', x, y, workers: 2, startedAt: account.updatedAt,
      readyAt: account.updatedAt + worldWeekMs, surveyRadius: 0, ...(itemFind ? { itemFind } : {}) };
  }
  return { x, y, workers: 2, readyAt: account.updatedAt + weeks * worldWeekMs,
    surveyRadius: expeditionSurveyRadius(account.game), dollarReward: 0,
    ...(physicalAt(account, account.updatedAt) ? { finds: expeditionFindPlan(account.game.seed, x, y, account.updatedAt, weeks) } : {}) };
}
function executeCommand(account: Account, command: Command, realTime: number,
  sellPickup?: (command: Extract<Command, { type: 'collect-sell' }>) => string,
  contribute?: (command: Extract<Command, { type: 'federation-contribute' }>) => string): string {
  const game = account.game;
  switch (command.type) {
    case 'dispatch-squad': {
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement before sending a squad.');
      const supplyReason = settlementSupplyReason(account);
      if (supplyReason) throw new ApiError(409, supplyReason);
      const bag = inventory(account);
      if (sellableItemCount(bag, command.item) < 1) throw new ApiError(409, 'A squad dispatch voucher is required.');
      enforceActionThrottle(account, 'investigate', realTime);
      const work = workforce(account), plan = planSquad(game, work, command.activity, command.quantity);
      if (plan.missions.length !== command.quantity || plan.dollarsUnits > command.maximumDollars)
        throw new ApiError(409, 'Squad requirements changed. Review the squad and try again.');
      const missions = plan.missions.map(mission => fieldExpedition(account, command.activity, mission));
      pay(game, { dollars: plan.dollarsUnits / dollarsScale });
      bag.items.splice(bag.items.indexOf(command.item), 1);
      work.expeditions.push(...missions);
      work.expeditions.sort((a, b) => a.readyAt - b.readyAt);
      return note(game, `Squad dispatched: ${missions.length} ${command.activity} missions, ${plan.workers} residents. One voucher consumed.`);
    }
    case 'federation-contribute':
      if (!contribute) throw new ApiError(503, 'Federation vault is unavailable.');
      return note(game, contribute(command));
    case 'gather': {
      if (game.stage >= 0) throw new ApiError(409, 'Use resident crews after founding your settlement.');
      const terrain = terrainAt(game.position.x, game.position.y, game.seed);
      const resource = terrainResources[terrain];
      if (!['wood', 'water'].includes(resource) || !game.explored.includes(`${game.position.x},${game.position.y}`)) throw new ApiError(409, 'Choose known Wood or Water terrain for founding supplies.');
      const required = stages[0].cost[resource]!;
      const quantity = Math.min(35, Math.max(0, required - game.stock[resource]));
      if (!quantity) throw new ApiError(409, 'You have enough of this resource to found a settlement.');
      game.stock[resource] += quantity;
      return note(game, 'Founding supplies gathered. No FTH$ was issued.');
    }
    case 'move': {
      if (Math.hypot(command.x - game.position.x, command.y - game.position.y) > radius(game) + 1) throw new ApiError(409, 'That location is beyond your reach. Explore a little closer first.');
      if (game.explored.includes(`${command.x},${command.y}`)) {
        game.position = { x: command.x, y: command.y };
        return note(game, `Travelled to known terrain at ${command.x}, ${command.y}.`);
      }
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement before sending an expedition.');
      const supplyReason = settlementSupplyReason(account);
      if (supplyReason) throw new ApiError(409, supplyReason);
      const work = workforce(account);
      if (work.expeditions.some(expedition => expedition.x === command.x && expedition.y === command.y)) {
        throw new ApiError(409, 'An expedition is already exploring this destination. Choose another location.');
      }
      if (availableWorkers(account) < 2) throw new ApiError(409, 'Exploration requires two available residents.');
      const terrain = terrainDetails[terrainAt(command.x, command.y, game.seed)];
      const quote = explorationQuote(game, command.x, command.y, explorationCount(work.expeditions));
      pay(game, { dollars: quote.dollars });
      const expedition = fieldExpedition(account, 'exploration', { x: command.x, y: command.y, ...quote });
      const index = work.expeditions.findIndex(active => active.readyAt > expedition.readyAt);
      work.expeditions.splice(index < 0 ? work.expeditions.length : index, 0, expedition);
      return note(game, `Two residents departed on a ${terrain.weeks}-week expedition. Territory is revealed only on return.`);
    }
    case 'investigate': {
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement before investigating.');
      const supplyReason = settlementSupplyReason(account);
      if (supplyReason) throw new ApiError(409, supplyReason);
      if (!game.explored.includes(`${command.x},${command.y}`))
        throw new ApiError(409, 'Investigation requires discovered terrain.');
      if (Math.hypot(command.x - game.position.x, command.y - game.position.y) > radius(game) + 1)
        throw new ApiError(409, 'That location is beyond your reach. Explore a little closer first.');
      const work = workforce(account);
      if (work.expeditions.some(expedition => expedition.x === command.x && expedition.y === command.y))
        throw new ApiError(409, 'An expedition is already exploring this destination. Choose another location.');
      if (availableWorkers(account) < 2) throw new ApiError(409, 'Investigation requires two available residents.');
      enforceActionThrottle(account, 'investigate', realTime);
      const quote = investigationQuote(game, command.x, command.y, explorationCount(work.expeditions));
      pay(game, { dollars: quote.dollars });
      const expedition = fieldExpedition(account, 'investigation', { x: command.x, y: command.y, ...quote });
      const index = work.expeditions.findIndex(active => active.readyAt > expedition.readyAt);
      work.expeditions.splice(index < 0 ? work.expeditions.length : index, 0, expedition);
      return note(game, 'Two residents departed to investigate known terrain for one game week.');
    }
    case 'assign': {
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement before assigning residents.');
      const work = workforce(account);
      const allocation = editableAllocation(work);
      allocation[command.resource] = command.workers;
      if (resources.reduce((sum, resource) => sum + allocation[resource], 0) > workforceCounts(game.population, work).assignmentCapacity) throw new ApiError(409, 'Keep two residents available for exploration and retain active explorers.');
      if (command.workers && !resourceAccess(game)[command.resource].available) throw new ApiError(409, 'Explore a matching resource first. Oil also requires a city bank.');
      work.automatic = false;
      work.allocation = allocation;
      return note(game, 'Manual allocation saved. Active deliveries finish before the next allocation starts.');
    }
    case 'automatic':
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement before assigning residents.');
      {
        const work = workforce(account);
        if (!command.enabled && work.automatic) work.allocation = editableAllocation(work);
        work.automatic = command.enabled;
        return note(game, command.enabled ? 'Automatic balancing enabled for the next work week.' : 'Manual allocation enabled for the next work week.');
      }
    case 'trade': throw new ApiError(409, 'Use the marketplace page for trading.');
    case 'build': return build(game, command.kind);
    case 'construction': {
      const facility = constructions[command.kind], cost = constructionCost(game, command.kind);
      if (game.stage < facility.stage) throw new ApiError(409, 'Upgrade your settlement to unlock this construction.');
      if (!cost) throw new ApiError(409, 'Construction is at its maximum level.');
      pay(game, cost);
      const level = constructionLevel(game, command.kind) + 1;
      game.constructionLevels = { ...game.constructionLevels, [command.kind]: level };
      if (command.kind === 'workshop' || command.kind === 'logistics') game.incomeFacilities = {
        ...game.incomeFacilities, [command.kind === 'workshop' ? 'workshop' : 'trade-hub']: true };
      return note(game, `${facility.name} upgraded to level ${level}. Benefits apply to new activity.`);
    }
    case 'craft': return craft(account, command.item, command.quantity);
    case 'equip': return equip(account, command.item);
    case 'activity-gear': return equipActivity(account, command.activity, command.item);
    case 'decorate': return decorate(account, command.slot, command.item);
    case 'arrange': return arrange(account, command.entity, command.position);
    case 'item-storage': return expandInventory(account);
    case 'collect-items': return collectFinds(account);
    case 'collect-sell':
      if (!sellPickup) throw new ApiError(409, 'Collection sale requires the marketplace.');
      return sellPickup(command);
    case 'use-customization': return useCustomization(account, command.item, command.value);
    case 'activate-collection': {
      const bag = inventory(account), index = bag.items.indexOf(command.item);
      if (index < 0) throw new ApiError(409, 'This collection item is not available in your inventory.');
      const { resource, weeks } = collectionItemDetails(command.item);
      if (game.stage < 0) throw new ApiError(409, 'Settlement required.');
      const automation = account.automationUntil ??= empty();
      const targets = resource === 'all' ? resources : [resource];
      const expiries = targets.map(asset => Math.max(account.updatedAt, automation[asset]) + weeks * worldWeekMs);
      if (expiries.some(expiry => !Number.isSafeInteger(expiry))) throw new ApiError(409, 'Account limit reached.');
      bag.items.splice(index, 1);
      targets.forEach((asset, index) => { automation[asset] = expiries[index]; });
      return note(game, 'Auto-collection activated. Transport is still paid in FTH$.');
    }
    case 'activate-activity': {
      const bag = inventory(account), index = bag.items.indexOf(command.item);
      if (game.stage < 0) throw new ApiError(409, 'Settlement required.');
      if (index < 0) throw new ApiError(409, 'This automation item is not available in your inventory.');
      const { activity, weeks } = activityItemDetails(command.item);
      const automation = account.activityAutomation ??= {
        exploration: { until: 0, enabled: false, nextAt: 0 },
        attraction: { until: 0, enabled: false, nextAt: 0 },
      };
      const until = Math.max(account.updatedAt, automation[activity].until) + weeks * worldWeekMs;
      if (!Number.isSafeInteger(until)) throw new ApiError(409, 'Account limit reached.');
      bag.items.splice(index, 1);
      automation[activity] = { until, enabled: true, nextAt: account.updatedAt };
      return note(game, 'Activity automation activated. Normal FTH$ fees still apply.');
    }
    case 'activity-automation': {
      const automation = account.activityAutomation?.[command.activity];
      if (!automation || automation.until <= account.updatedAt) throw new ApiError(409, 'No active automation time. Activate an item first.');
      automation.enabled = command.enabled;
      automation.nextAt = account.updatedAt;
      return note(game, command.enabled ? 'Activity automation resumed. Normal FTH$ fees still apply.' : 'Activity automation paused. Remaining time continues to expire.');
    }
    case 'diplomacy': return diplomacy(game, command.action, command.federation);
    case 'upgrade': {
      const establishing = game.stage < 0;
      const message = upgrade(game);
      if (establishing) account.incomeReadyAt = account.updatedAt + worldWeekMs;
      return message;
    }
    case 'invite': {
      const population = recruitmentAmount(game.population, constructionLevel(game, 'housing'), climateTime(account));
      if (!Number.isSafeInteger(game.population + population)) throw new ApiError(409, 'Account limit reached.');
      const supplyReason = settlementSupplyReason(account);
      if (supplyReason) throw new ApiError(409, supplyReason);
      const readyAt = account.recruitment?.readyAt ?? account.inviteReadyAt;
      if (account.recruitment || account.updatedAt < readyAt) throw new ApiError(409,
        `Recruitment ready in ${Math.ceil((readyAt - account.updatedAt) / 1000)} seconds.`);
      const message = invite(game, climateTime(account));
      account.inviteReadyAt = account.updatedAt + worldWeekMs;
      account.recruitment = { population, startedAt: account.updatedAt, readyAt: account.inviteReadyAt };
      return message;
    }
    case 'home':
      if (!game.home) throw new ApiError(409, 'Establish a settlement first.');
      game.position = { ...game.home };
      return note(game, 'Returned to your settlement.');
    case 'warehouse': {
      if (game.stage < 0) throw new ApiError(409, 'Establish a settlement first.');
      const cost = snapshot(account).warehouseCost;
      if (!cost) throw new ApiError(409, 'Warehouse is at its maximum level.');
      if (game.stock.wood < cost.wood || game.stock.metal < cost.metal) throw new ApiError(409, 'Not enough resources for the warehouse.');
      pay(game, cost);
      account.warehouse++;
      return note(game, `Warehouse upgraded to level ${account.warehouse}.`);
    }
    case 'map-collect': {
      const resource = terrainResources[terrainAt(command.x, command.y, game.seed)];
      if (game.stage < 0 || !game.explored.includes(`${command.x},${command.y}`) || !resource
        || !resourceAccess(game)[resource].available) throw new ApiError(409, 'Discover an accessible resource tile before collecting.');
      if (account.lastClaimAt && realTime - account.lastClaimAt < claimCooldownMs) throw new ApiError(429, 'Wait half a second between claims.');
      const quantity = collectResource(account, resource, true);
      account.lastClaimAt = realTime;
      return note(game, `Collected ${quantity} ${resource} from the map. No transport fee.`);
    }
    case 'claim': {
      if (command.resource) {
        if (account.lastClaimAt && realTime - account.lastClaimAt < claimCooldownMs) throw new ApiError(429, 'Wait half a second between claims.');
        const quantity = collectResource(account, command.resource);
        account.lastClaimAt = realTime;
        return note(game, `Collected ${quantity} ${command.resource}. FTH$ transport paid.`);
      }
      if (account.lastClaimAt && realTime - account.lastClaimAt < claimCooldownMs) throw new ApiError(429, 'Wait half a second between claims.');
      const { pending, claimThreshold, capacity: cap } = snapshot(account);
      if (claimThreshold === 0) throw new ApiError(409, 'Establish a settlement before claiming resources.');
      const selected = (command.resource ? [command.resource] : resources)
        .filter(resource => pending[resource] >= Math.ceil(resourceCapacity(cap, resource, game) / 2));
      if (!selected.length) {
        const message = command.resource
          ? `Pending storage must be at least 50% full (${Math.ceil(resourceCapacity(cap, command.resource, game) / 2)} units per resource) to claim.`
          : 'Pending storage must be at least 50% full to claim.';
        throw new ApiError(409, message);
      }
      const bag = inventory(account), previewBag = { ...bag, items: [...bag.items] };
      const fees = selected.map(resource => {
        const quote = transportQuote(account.pickupFees?.[resource] ?? 0, previewBag);
        consumeTransportVoucher(previewBag, quote.item);
        return quote;
      });
      const fee = fees.reduce((sum, quote) => sum + quote.fee, 0);
      if (!Number.isSafeInteger(fee)) throw new ApiError(409, 'Account limit reached.');
      pay(game, { dollars: fee / dollarsScale });
      for (const quote of fees) consumeTransportVoucher(bag, quote.item);
      for (const resource of selected) {
        game.stock[resource] += pending[resource];
        account.pending[resource] -= pending[resource] * minute;
        if (account.pickupFees) account.pickupFees[resource] = 0;
      }
      game.rewards += game.federation && selected.includes('metal') ? pending.metal : 0;
      account.lastClaimAt = realTime;
      return note(game, command.resource ? `Claimed ${pending[command.resource]} ${command.resource} into your inventory.` : 'Eligible resources claimed into your inventory. Resources below 50% remain pending.');
    }
  }
}
export function restoreSnapshotUpkeep(saved: { game: Snapshot['game']; waterUpkeep?: StoredSnapshotUpkeep | null }, account: Account, now: number): Snapshot['waterUpkeep'] {
  const upkeep = saved.waterUpkeep;
  if (!upkeep) return null;
  const legacy = upkeep.dailyConsumption === undefined;
  const readyAt = legacy ? account.waterUpkeep?.version === 2 ? account.waterUpkeep.readyAt : now + worldDayMs : upkeep.readyAt;
  const dailyConsumption = upkeep.dailyConsumption ?? waterUpkeep(saved.game.population, 0, climateTime(account, readyAt), !physicalAt(account, readyAt)).required;
  const shortage = Math.max(0, dailyConsumption - saved.game.stock.water);
  return { ...upkeep, paused: shortage > 0, dailyConsumption, weeklyConsumption: upkeep.weeklyConsumption,
    shortage, populationLoss: 0, readyAt,
    lastPopulationLoss: legacy ? 0 : upkeep.lastPopulationLoss };
}
export function parseActionEnvelope(value: unknown): { id: string; revision: number; command: unknown } {
  const body = object(value);
  if (Object.keys(body).sort().join() !== 'command,id,revision' || typeof body.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
    || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new ApiError(400, 'Invalid action envelope.');
  return { id: body.id, revision: body.revision, command: body.command };
}
export function apply(account: Account, value: unknown, time: number, realTime = time,
  sellPickup?: (command: Extract<Command, { type: 'collect-sell' }>) => string,
  contribute?: (command: Extract<Command, { type: 'federation-contribute' }>) => string): Snapshot & { message: string } {
  const body = parseActionEnvelope(value);
  const request = JSON.stringify({ revision: body.revision, command: body.command });
  if (account.receipt?.id === body.id) {
    if (account.receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
    const saved = account.receipt.result;
    const original: Account = { ...account, game: structuredClone(saved.game), inventory: saved.inventory ? structuredClone(saved.inventory) : undefined,
      workforce: saved.workforce, updatedAt: saved.serverTime,
      pending: Object.fromEntries(resources.map(resource => [resource, saved.pending[resource] * minute])) as Stock, receipt: null };
    const bag = inventory(original);
    return structuredClone({ ...saved, recruitment: saved.recruitment ?? null, inventory: bag, game: original.game, workforce: workforce(original),
      waterUpkeep: restoreSnapshotUpkeep(saved, account, time),
      warehouseCost: saved.warehouseCost && saved.warehouseCost.dollars === undefined ? warehouseCost(saved.warehouse + 1) : saved.warehouseCost,
      availableWorkers: saved.availableWorkers ?? availableWorkers(original),
      resourceAccess: saved.resourceAccess?.wood.dollarsPerWorker === undefined
        ? resourceAccess(saved.game, saved.physicalVersion === 1 ? saved.serverTime : undefined, saved.physicalVersion !== 1) : saved.resourceAccess,
      recruitmentDollars: saved.recruitmentDollars ?? recruitmentDollars(saved.game.population) });
  }
  const command = parseCommand(body.command);
  if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
  accrue(account, time);
  if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
  if (realTime - account.lastActionAt < 250) throw new ApiError(429, 'Actions are limited to four per second.');
  const message = execute(account, command, realTime, sellPickup, contribute);
  if (command.type === 'activate-activity' || command.type === 'activity-automation') accrue(account, account.updatedAt);
  if (!Object.keys(workforce(account).crews).length) beginCycle(account, account.updatedAt);
  if (!resources.every(r => Number.isSafeInteger(account.game.stock[r]) && account.game.stock[r] >= 0)
    || !Number.isSafeInteger(account.game.population)) throw new ApiError(409, 'Account limit reached.');
  account.revision++;
  account.lastActionAt = realTime;
  const result = { ...snapshot(account), message };
  account.receipt = { id: body.id, request, result };
  return result;
}
