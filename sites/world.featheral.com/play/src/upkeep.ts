import { dailyClimate, heatingDemandClimate, maintenanceDemandClimate, waterDemandClimate } from './climate.ts';
import { climateCycleDays, worldDayMs, worldEpoch } from './environment.ts';
import { resourceEconomy } from './resource-units.ts';

export const dailyWaterPerResident = resourceEconomy.water.dailyConsumption;
export const weeklyWaterPerResident = dailyWaterPerResident * 7;
// Allocation plans whole work weeks; upkeep bills one day at a time.
export function waterRequirement(population: number, time?: number, legacy = false): number {
  if (time === undefined) return population * (legacy ? 105 : weeklyWaterPerResident);
  let required = 0;
  for (let day = 0; day < 7; day++) required += waterUpkeep(population, 0, time + day * worldDayMs, legacy).required;
  return required;
}
export function waterUpkeep(population: number, ownedWater: number, time?: number, legacy = false) {
  const required = Math.ceil(population * (legacy ? 15 : dailyWaterPerResident)
    * (time === undefined || legacy ? 1 : dailyClimate(time, waterDemandClimate)));
  const consumed = Math.min(ownedWater, required);
  return { required, consumed, shortage: required - consumed, populationLoss: 0 };
}

const demand = Array.from({ length: climateCycleDays }, (_, day) => dailyClimate(worldEpoch + day * worldDayMs, waterDemandClimate));
const prefixes = new Map<number, number[]>();
export type SettlementUpkeepResource = 'wood' | 'metal';
export const dailyUpkeepPerResident = { wood: resourceEconomy.wood.dailyConsumption, metal: resourceEconomy.metal.dailyConsumption } as const;
const upkeepDemand = {
  wood: Array.from({ length: climateCycleDays }, (_, day) => dailyClimate(worldEpoch + day * worldDayMs, heatingDemandClimate)),
  metal: Array.from({ length: climateCycleDays }, (_, day) => dailyClimate(worldEpoch + day * worldDayMs, maintenanceDemandClimate)),
};
const upkeepPrefixes = new Map<string, number[]>();
const maximumUpkeepDemand = { wood: Math.max(...upkeepDemand.wood), metal: Math.max(...upkeepDemand.metal) };
export function maximumSettlementWeeklyConsumption(resource: SettlementUpkeepResource, population: number): number {
  return Math.ceil(population * dailyUpkeepPerResident[resource] * maximumUpkeepDemand[resource] * 7) + 1;
}
const upkeepScale = 10000;
export function settlementConsumptionForDays(resource: SettlementUpkeepResource, population: number, firstDay: number, days: number): number {
  if (!Number.isSafeInteger(population) || population < 0 || !Number.isSafeInteger(firstDay) || firstDay < 0
    || !Number.isSafeInteger(days) || days < 0) throw new RangeError('Invalid settlement consumption interval.');
  const key = `${resource}:${population}`;
  let prefix = upkeepPrefixes.get(key);
  if (!prefix) {
    prefix = [0];
    for (const factor of upkeepDemand[resource]) prefix.push(prefix.at(-1)! + Math.round(population * dailyUpkeepPerResident[resource] * factor * upkeepScale));
    if (upkeepPrefixes.size >= 64) upkeepPrefixes.delete(upkeepPrefixes.keys().next().value!);
    upkeepPrefixes.set(key, prefix);
  }
  const start = ((Math.floor((firstDay - worldEpoch) / worldDayMs) % climateCycleDays) + climateCycleDays) % climateCycleDays;
  const first = Math.min(days, climateCycleDays - start), remaining = days - first;
  const total = prefix[start + first] - prefix[start] + Math.floor(remaining / climateCycleDays) * prefix[climateCycleDays] + prefix[remaining % climateCycleDays];
  if (!Number.isSafeInteger(total)) throw new RangeError('Settlement consumption exceeds account limits.');
  return total / upkeepScale;
}
export function settlementUpkeep(resource: SettlementUpkeepResource, population: number, owned: number, time: number) {
  const required = settlementConsumptionForDays(resource, population, time, 1), consumed = Math.min(owned, required);
  return { required, consumed, shortage: Math.max(0, Math.round((required - consumed) * upkeepScale) / upkeepScale) };
}
function floorSum(n: bigint, m: bigint, a: bigint, b: bigint): bigint {
  let total = 0n;
  while (true) {
    if (a >= m) { total += (n - 1n) * n * (a / m) / 2n; a %= m; }
    if (b >= m) { total += n * (b / m); b %= m; }
    const maximum = a * n + b;
    if (maximum < m) return total;
    n = maximum / m; b = maximum % m;
    [m, a] = [a, m];
  }
}
export function suppliedWorkWeeks(resource: SettlementUpkeepResource, population: number, firstDay: number, weeks: number, remainder: number): number {
  if (!Number.isSafeInteger(weeks) || weeks < 0 || !Number.isSafeInteger(remainder) || remainder < 0 || remainder >= upkeepScale)
    throw new RangeError('Invalid supplied work interval.');
  const cycleWeeks = climateCycleDays / 7;
  const cycle = Math.round(settlementConsumptionForDays(resource, population, firstDay, climateCycleDays) * upkeepScale);
  let before = remainder, charged = 0;
  for (let week = 0; week < Math.min(weeks, cycleWeeks); week++) {
    const count = 1 + Math.floor((weeks - week - 1) / cycleWeeks);
    const width = Math.round(settlementConsumptionForDays(resource, population, firstDay + week * 7 * worldDayMs, 7) * upkeepScale);
    // A short bill crosses a lot boundary only on some climate cycles.
    charged += width >= upkeepScale ? count : Number(
      floorSum(BigInt(count), 10000n, BigInt(cycle % upkeepScale), BigInt(before % upkeepScale + width))
      - floorSum(BigInt(count), 10000n, BigInt(cycle % upkeepScale), BigInt(before % upkeepScale)));
    before += width;
  }
  return charged;
}
export function waterConsumptionForDays(population: number, firstDay: number, days: number, legacy = false): number {
  if (!Number.isSafeInteger(population) || population < 0 || !Number.isSafeInteger(firstDay) || firstDay < 0
    || !Number.isSafeInteger(days) || days < 0) throw new RangeError('Invalid Water consumption interval.');
  if (legacy) return population * 15 * days;
  let prefix = prefixes.get(population);
  if (!prefix) {
    prefix = [0];
    for (const factor of demand) prefix.push(prefix.at(-1)! + Math.ceil(population * dailyWaterPerResident * factor));
    if (prefixes.size >= 64) prefixes.delete(prefixes.keys().next().value!);
    prefixes.set(population, prefix);
  }
  const start = ((Math.floor((firstDay - worldEpoch) / worldDayMs) % climateCycleDays) + climateCycleDays) % climateCycleDays;
  const first = Math.min(days, climateCycleDays - start);
  const remaining = days - first, cycles = Math.floor(remaining / climateCycleDays), last = remaining % climateCycleDays;
  return prefix[start + first] - prefix[start] + cycles * prefix[climateCycleDays] + prefix[last];
}
