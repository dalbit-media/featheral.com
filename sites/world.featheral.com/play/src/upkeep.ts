import { dailyClimate, waterDemandClimate } from './climate.ts';
import { climateCycleDays, worldDayMs, worldEpoch } from './environment.ts';

export const dailyWaterPerResident = 5;
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
