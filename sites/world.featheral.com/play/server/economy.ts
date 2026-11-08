import { build, diplomacy, discover, invite, newGame, note, pay, radius, recruitmentAmount, recruitmentDollars, stages, survey, terrainAt, terrainDetails, terrainResources, upgrade } from '../src/engine.ts';
import { randomInt } from 'node:crypto';
import type { Resource, Stock } from '../src/engine.ts';
import type { Command, Expedition, Snapshot, Workforce } from '../src/api-types.ts';
import { claimCooldownMs, environmentAt, worldDayMs, worldWeekMs } from '../src/environment.ts';
import { balancedAllocation, editableAllocation, emptyAllocation, expeditionSurveyRadius, explorationCount, explorationQuote, investigationQuote, fundAllocation, nextExploration, resourceAccess, resourceCapacity, resourceWorkRoom, warehouseCapacity, workforceCounts } from '../src/workforce.ts';
import { isCraftableItem, isDecorationItem, isDecorationSlot, isVisibilityItem } from '../src/items.ts';
import type { ItemInventory } from '../src/items.ts';
import { addPermitFind, arrange, collectFinds, craft, decorate, equip, expandInventory, findCollectible, findCollectionItem, investigationItem, inventory } from './inventory.ts';
import { isSettlementEntity } from '../src/settlement-layout.ts';
import { fthgScale } from '../src/fthg.ts';
import { dailyWaterPerResident, maximumSettlementWeeklyConsumption, settlementConsumptionForDays, settlementUpkeep, suppliedWorkWeeks, waterConsumptionForDays, waterRequirement, waterUpkeep } from '../src/upkeep.ts';
import { isWaterFacility } from '../src/water-facilities.ts';
import { isIncomeFacility, weeklyIncome } from '../src/income.ts';
import { maximumUpgradeLevel, warehouseCost } from '../src/costs.ts';
import { dollarsScale } from '../src/dollars.ts';
import { resourceBasePrice } from '../src/resource-units.ts';
import { constructionCost, constructionLevel, constructions, isConstruction } from '../src/constructions.ts';
import { collectionItemDetails, isCollectionItem } from '../src/collection.ts';
import { activityItemDetails, activityKinds, isActivityItem, isActivityKind } from '../src/automation.ts';
import type { ActivityKind } from '../src/automation.ts';
import { findActivityItem, findCustomizationItem, useCustomization } from './inventory.ts';
import { customizationName, isCustomizationItem, isTitleItem, titleItems } from '../src/customization.ts';
import type { Customization } from '../src/customization.ts';
import { expeditionFindPlan } from '../src/climate.ts';

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
  settlementUpkeep?: { version: 1; readyAt: number; remainder: { wood: number; metal: number } };
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
}
function settlementSupplyReason(account: Account): string | null {
  if (hydration(account).shortage) return 'Restore Water supplies before starting advanced activity.';
  if (!account.settlementUpkeep || account.updatedAt < account.settlementUpkeep.readyAt - worldDayMs) return null;
  for (const resource of ['wood', 'metal'] as const) {
    if (settlementUpkeep(resource, account.game.population, Math.max(0, account.game.stock[resource] - account.settlementUpkeep.remainder[resource] / 10000), account.settlementUpkeep.readyAt).shortage)
      return resource === 'wood' ? 'Restore Wood heating supplies before starting advanced activity.' : 'Restore Metal repair supplies before starting advanced activity.';
  }
  return null;
}
function consumeSettlementDays(account: Account, until: number): void {
  const upkeep = account.settlementUpkeep!;
  const days = 1 + Math.floor((until - upkeep.readyAt) / worldDayMs);
  if (days <= 0) return;
  for (const resource of ['wood', 'metal'] as const) {
    const required = settlementConsumptionForDays(resource, account.game.population, upkeep.readyAt, days);
    const units = Math.round(required * 10000) + upkeep.remainder[resource];
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
  const quantity = Math.floor(account.pending[resource] / minute), fee = account.pickupFees?.[resource] ?? 0;
  if (quantity < 1) throw new ApiError(409, 'No completed resources to collect.');
  if (!Number.isSafeInteger(account.game.stock[resource] + quantity)) throw new ApiError(409, 'Account limit reached.');
  if (!manual) pay(account.game, { dollars: fee / dollarsScale });
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
    const cost = recruitmentDollars(account.game.population, constructionLevel(account.game, 'housing'), climateTime(account));
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
  const now = Math.max(account.updatedAt, time);
  initializeUpkeep(account, now);
  const cap = capacity(account);
  const work = workforce(account);
  let completed = 0, exploringWorkers = expeditionWorkers(work);
  while (true) {
    const event = Math.min(work.cycleAt, work.expeditions[completed]?.readyAt ?? Infinity, account.recruitment?.readyAt ?? Infinity, account.waterUpkeep?.readyAt ?? Infinity, account.settlementUpkeep?.readyAt ?? Infinity,
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
      const storage = resourceCapacity(cap, resource, account.game);
      const room = crew.automaticDelivery || crew.payOnPickup ? Math.max(0, storage - account.game.stock[resource] - account.pending[resource] / minute) : storage;
      const delivery = Math.min(Math.floor(room), crew.weeklyYield);
      if (crew.payOnPickup && delivery > 0) {
        if (!Number.isSafeInteger(account.pending[resource] + delivery * minute)) throw new ApiError(409, 'Account limit reached.');
        account.pending[resource] += delivery * minute;
        const fees = account.pickupFees ??= empty();
        fees[resource] += (crew.weeklyDollarsCost ?? 0) * dollarsScale;
        if (!Number.isSafeInteger(fees[resource])) throw new ApiError(409, 'Account limit reached.');
        if ((account.automationUntil?.[resource] ?? 0) >= event && account.game.dollars >= fees[resource]) collectResource(account, resource);
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
      skipSuppliedCycles(account, now, event);
      // Productive iterations are bounded by finite storage, not elapsed offline time.
      if (!Object.keys(work.crews).length) {
        let until = Math.min(now, (work.expeditions[completed]?.readyAt ?? Infinity) - 1, (account.recruitment?.readyAt ?? Infinity) - 1,
          ...Object.values(account.activityAutomation ?? {}).filter(automation => automation.enabled && automation.nextAt < automation.until).map(automation => automation.nextAt - 1));
        const upkeep = account.waterUpkeep;
        for (const resource of ['water', 'wood', 'metal'] as const) {
          const supplyUpkeep = resource === 'water' ? upkeep : account.settlementUpkeep;
          if (!supplyUpkeep) continue;
          const consumption = (days: number) => resource === 'water' ? waterForDays(account, days)
            : settlementConsumptionForDays(resource, account.game.population, supplyUpkeep!.readyAt, days);
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
        const idleUntil = Math.min(until, (upkeep?.readyAt ?? Infinity) - 1, (account.settlementUpkeep?.readyAt ?? Infinity) - 1);
        if (work.cycleAt <= idleUntil) work.cycleAt += (1 + Math.floor((idleUntil - work.cycleAt) / worldWeekMs)) * worldWeekMs;
      }
    }
  }
  if (completed) work.expeditions.splice(0, completed);
  account.updatedAt = now;
}
function skipSuppliedCycles(account: Account, now: number, event: number): void {
  // Fully replenished, auto-collected one-worker crews can be settled in bulk:
  // each pickup restores capacity, then the last week's bill determines stock.
  // Stop before water recovery, permit expiry, insufficient fees or other jobs.
  const work = workforce(account), upkeep = account.settlementUpkeep, water = account.waterUpkeep;
  if (!upkeep || !water || !physicalAt(account, event) || !work.automatic || account.game.population < 4
    || work.expeditions.length || account.recruitment || Object.values(account.activityAutomation ?? {}).some(value => value.enabled)
    || work.crews.water || work.crews.oil || water.readyAt !== event + worldDayMs || upkeep.readyAt !== water.readyAt) return;
  const access = resourceAccess(account.game), cap = capacity(account);
  let weeks = Math.floor((now - event) / worldWeekMs);
  for (const resource of ['wood', 'metal'] as const) {
    const crew = work.crews[resource], site = access[resource];
    const maximum = maximumSettlementWeeklyConsumption(resource, account.game.population);
    const minimumOutput = Math.floor(site.perWorker * (resource === 'wood' ? .65 * .55 * .55 : .85 * .6 * .55));
    if (!site.available || maximum >= Math.min(cap, minimumOutput)
      || site.dollarsPerWorker > resourceBasePrice(resource) || account.pending[resource] !== 0 || account.pickupFees?.[resource]
      || (crew && (!crew.payOnPickup || crew.workers !== 1 || crew.readyAt !== work.cycleAt))
      || account.game.stock[resource] + (crew?.weeklyYield ?? 0) !== cap) return;
    weeks = Math.min(weeks, Math.floor(((account.automationUntil?.[resource] ?? 0) - event) / worldWeekMs));
  }
  if (weeks < 2) return;
  const reserve = resourceCapacity(cap, 'water', account.game) + Math.ceil(waterRequirement(account.game.population) * 1.5);
  const affordable = (count: number) => waterForDays(account, count * 7) <= account.game.stock.water - reserve
    && (['wood', 'metal'] as const).reduce((cost, key) => cost
      + ((work.crews[key] ? 1 : 0) + suppliedWorkWeeks(key, account.game.population, upkeep.readyAt, count - 1, upkeep.remainder[key]))
      * access[key].dollarsPerWorker * dollarsScale, 0) <= account.game.dollars;
  let low = 0, high = weeks;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (affordable(middle)) low = middle; else high = middle - 1;
  }
  weeks = low;
  if (weeks < 2) return;
  const end = event + weeks * worldWeekMs;
  for (const resource of ['wood', 'metal'] as const) {
    const initial = upkeep.remainder[resource];
    const previous = Math.round(settlementConsumptionForDays(resource, account.game.population, upkeep.readyAt, (weeks - 1) * 7) * 10000) + initial;
    const total = Math.round(settlementConsumptionForDays(resource, account.game.population, upkeep.readyAt, weeks * 7) * 10000) + initial;
    const lastBill = Math.floor(total / 10000) - Math.floor(previous / 10000);
    const count = (work.crews[resource] ? 1 : 0) + suppliedWorkWeeks(resource, account.game.population, upkeep.readyAt, weeks - 1, initial);
    account.game.dollars -= count * access[resource].dollarsPerWorker * dollarsScale;
    account.game.stock[resource] = cap - lastBill;
    upkeep.remainder[resource] = total % 10000;
    delete work.crews[resource];
  }
  upkeep.readyAt = end + worldDayMs;
  skipWaterDays(account, end);
  beginCycle(account, end);
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
  const supplyResources = Object.fromEntries((['wood', 'metal'] as const).map(resource => {
    const use = settlementUpkeep(resource, account.game.population, Math.max(0, account.game.stock[resource] - (account.settlementUpkeep?.remainder[resource] ?? 0) / 10000), supplyTime);
    return [resource, { dailyConsumption: use.required, weeklyConsumption: settlementConsumptionForDays(resource, account.game.population, supplyTime, 7), shortage: use.shortage }];
  })) as NonNullable<Snapshot['settlementUpkeep']>['resources'];
  return { ...(account.customization ? { customization: structuredClone(account.customization) } : {}), physicalVersion: account.physicalVersion, fthg: account.fthg / fthgScale, dollars: account.game.dollars / dollarsScale, income: { weekly: weeklyIncome(account.game) / dollarsScale, readyAt: 0 }, inventory: structuredClone(bag), game: structuredClone(account.game), pending, rates: rates(account), capacity: cap, claimThreshold: Math.ceil(cap / 2),
    ...(account.activityAutomation ? { activityAutomation: {
      exploration: { ...account.activityAutomation.exploration, reason: activityReason(account, 'exploration') },
      attraction: { ...account.activityAutomation.attraction, reason: activityReason(account, 'attraction') },
    } } : {}),
    warehouse: account.warehouse, warehouseCost: account.warehouse >= maximumUpgradeLevel ? null : warehouseCost(account.warehouse + 1),
    revision: account.revision, serverTime: account.updatedAt, environment: environmentAt(account.updatedAt),
    inviteReadyAt: account.inviteReadyAt, recruitment: structuredClone(account.recruitment ?? null),
    waterUpkeep: account.waterUpkeep ? { ...account.waterUpkeep, paused: water.shortage > 0, dailyConsumption: water.required, weeklyConsumption: waterRequirement(account.game.population, climateTime(account, waterTime), !physicalAt(account, waterTime)),
      shortage: water.shortage, populationLoss: water.populationLoss } : null,
    settlementUpkeep: account.settlementUpkeep ? { readyAt: supplyTime, paused: Object.values(supplyResources).some(resource => resource.shortage > 0), resources: supplyResources } : null,
    workforce: structuredClone(work), availableWorkers: availableWorkers(account),
    collection: { fees: Object.fromEntries(resources.map(resource => [resource, (account.pickupFees?.[resource] ?? 0) / dollarsScale])) as Stock,
      automationUntil: { ...(account.automationUntil ?? empty()) } },
    resourceAccess: resourceAccess(account.game, climateTime(account), !physicalAt(account, account.updatedAt)),
    recruitmentDollars: recruitmentDollars(account.game.population, constructionLevel(account.game, 'housing'), climateTime(account)) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function parseCommand(value: unknown): Command {
  const c = object(value);
  const resourceClaim = c.type === 'claim' && Object.hasOwn(c, 'resource');
  const fields: Record<string, string[]> = {
    move: ['x', 'y'], investigate: ['x', 'y'], trade: ['resource', 'direction', 'amount'], build: ['kind'], construction: ['kind'], diplomacy: ['action'],
    upgrade: [], invite: [], home: [], gather: [], claim: resourceClaim ? ['resource'] : [], warehouse: [],
    assign: ['resource', 'workers'], automatic: ['enabled'],
    craft: Object.hasOwn(c, 'quantity') ? ['item', 'quantity'] : ['item'], 'map-collect': ['x', 'y'], equip: ['item'], decorate: ['slot', 'item'], 'item-storage': [], 'collect-items': [],
    arrange: ['entity', 'position'],
    'activate-collection': ['item'], 'collect-sell': ['resource', 'quantity', 'minimumDollars'],
    'use-customization': ['item', 'value'],
    'activate-activity': ['item'], 'activity-automation': ['activity', 'enabled'],
  };
  if (typeof c.type !== 'string' || !Object.hasOwn(fields, c.type)
    || Object.keys(c).sort().join() !== ['type', ...fields[c.type]].sort().join()) throw new ApiError(400, 'Invalid command fields.');
  const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
  if (c.type === 'arrange' && c.position !== null) {
    const position = object(c.position);
    if (Object.keys(position).sort().join() !== 'x,y' || ![position.x, position.y].every(n => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 1000000)) throw new ApiError(400, 'Invalid command values.');
  }
  if (((c.type === 'move' || c.type === 'map-collect' || c.type === 'investigate') && ![c.x, c.y].every(n => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 1000000))
    || (c.type === 'trade' && (!oneOf(c.resource, resources) || !oneOf(c.direction, ['buy', 'sell']) || typeof c.amount !== 'number' || !Number.isSafeInteger(c.amount) || c.amount < 1 || c.amount > 10000))
    || (c.type === 'build' && !oneOf(c.kind, ['bank', 'townhall']) && !isWaterFacility(c.kind) && !isIncomeFacility(c.kind))
    || (c.type === 'construction' && !isConstruction(c.kind))
    || (c.type === 'craft' && (!isCraftableItem(c.item) || (Object.hasOwn(c, 'quantity') && (typeof c.quantity !== 'number' || !Number.isSafeInteger(c.quantity) || c.quantity < 1 || c.quantity > 100))))
    || (c.type === 'equip' && c.item !== null && !isVisibilityItem(c.item))
    || (c.type === 'decorate' && (!isDecorationSlot(c.slot) || (c.item !== null && !isDecorationItem(c.item))))
    || (c.type === 'arrange' && !isSettlementEntity(c.entity))
    || (c.type === 'diplomacy' && !oneOf(c.action, ['gift', 'join', 'form', 'vote']))
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
export function execute(account: Account, command: Command, realTime = account.updatedAt,
  sellPickup?: (command: Extract<Command, { type: 'collect-sell' }>) => string): string {
  const game = account.game;
  switch (command.type) {
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
      const expedition: Expedition = { x: command.x, y: command.y, workers: 2,
        readyAt: account.updatedAt + terrain.weeks * worldWeekMs, surveyRadius: expeditionSurveyRadius(game), dollarReward: quote.reward,
        ...(physicalAt(account, account.updatedAt) ? { finds: expeditionFindPlan(game.seed, command.x, command.y, account.updatedAt, terrain.weeks) } : {}) };
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
      const quote = investigationQuote(game, command.x, command.y, explorationCount(work.expeditions));
      pay(game, { dollars: quote.dollars });
      const itemFind = investigationItem(terrainAt(command.x, command.y, game.seed), randomInt(100), randomInt(100), randomInt(100));
      const expedition: Expedition = { kind: 'investigate', x: command.x, y: command.y, workers: 2, startedAt: account.updatedAt,
        readyAt: account.updatedAt + worldWeekMs, surveyRadius: 0, ...(itemFind ? { itemFind } : {}) };
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
    case 'diplomacy': return diplomacy(game, command.action);
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
        .filter(resource => pending[resource] >= Math.ceil(resourceCapacity(cap, resource) / 2));
      if (!selected.length) {
        const message = command.resource
          ? `Pending storage must be at least 50% full (${Math.ceil(resourceCapacity(cap, command.resource) / 2)} units per resource) to claim.`
          : 'Pending storage must be at least 50% full to claim.';
        throw new ApiError(409, message);
      }
      const fee = selected.reduce((sum, resource) => sum + (account.pickupFees?.[resource] ?? 0), 0);
      if (!Number.isSafeInteger(fee)) throw new ApiError(409, 'Account limit reached.');
      pay(game, { dollars: fee / dollarsScale });
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
  sellPickup?: (command: Extract<Command, { type: 'collect-sell' }>) => string): Snapshot & { message: string } {
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
  const message = execute(account, command, realTime, sellPickup);
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
