import type { Resource } from './engine.ts';
import { environmentAt, weatherMs, worldDayMs, worldEpoch, worldWeekMs } from './environment.ts';
import type { Environment } from './environment.ts';

const seasonal = {
  Spring: { wood: 1.15, water: 1.15, metal: 1, oil: 1 },
  Summer: { wood: 1, water: .85, metal: 1, oil: 1.05 },
  Autumn: { wood: 1.05, water: 1, metal: 1.05, oil: 1 },
  Winter: { wood: .65, water: .7, metal: .85, oil: .85 },
};
const weather = {
  'Clear skies': { wood: 1, water: .95, metal: 1, oil: 1 },
  Overcast: { wood: .95, water: 1, metal: .95, oil: .95 },
  Rain: { wood: .85, water: 1.3, metal: .85, oil: .9 },
  Snow: { wood: .6, water: .65, metal: .7, oil: .75 },
  Storm: { wood: .55, water: 1.1, metal: .6, oil: .65 },
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export function temperatureEfficiency(temperature: number): number {
  return clamp(1 - Math.max(0, 5 - temperature, temperature - 28) * .025, .55, 1);
}
export function productionClimate(resource: Resource, environment: Environment): number {
  const waterTemperature = resource === 'water' ? environment.temperature < 0 ? .8 : environment.temperature > 28 ? .9 : 1 : 1;
  return seasonal[environment.season][resource] * weather[environment.weather][resource]
    * temperatureEfficiency(environment.temperature) * waterTemperature;
}
export function recruitmentClimate(environment: Environment): number {
  const season = { Spring: 1.2, Summer: 1, Autumn: 1.1, Winter: .7 }[environment.season];
  return season * weather[environment.weather].wood * temperatureEfficiency(environment.temperature);
}
export function waterDemandClimate(environment: Environment): number {
  return 1 + clamp((environment.temperature - 20) * .015, 0, .3)
    + (environment.season === 'Summer' ? .1 : 0)
    + (environment.weather === 'Clear skies' && environment.temperature > 25 ? .05 : 0);
}
export function heatingDemandClimate(environment: Environment): number {
  const season = { Spring: 1, Summer: .8, Autumn: 1.1, Winter: 1.2 }[environment.season];
  const exposure = { 'Clear skies': 1, Overcast: 1.05, Rain: 1.15, Snow: 1.2, Storm: 1.3 }[environment.weather];
  return clamp((18 - environment.temperature) / 18, .05, 2) * season * exposure;
}
export function maintenanceDemandClimate(environment: Environment): number {
  const season = { Spring: 1.05, Summer: 1, Autumn: 1.1, Winter: 1.2 }[environment.season];
  const wear = { 'Clear skies': 1, Overcast: 1.05, Rain: 1.25, Snow: 1.35, Storm: 1.6 }[environment.weather];
  return season * wear * (1 + Math.max(0, -environment.temperature, environment.temperature - 30) * .015);
}
export function dailyClimate(time: number, effect: (environment: Environment) => number): number {
  environmentAt(time);
  const start = worldEpoch + Math.floor((time - worldEpoch) / worldDayMs) * worldDayMs;
  let total = 0;
  for (let offset = weatherMs / 2; offset < worldDayMs; offset += weatherMs) total += effect(environmentAt(start + offset));
  return total / (worldDayMs / weatherMs);
}
export function weeklyClimate(time: number, effect: (environment: Environment) => number): number {
  let total = 0;
  for (let day = 0; day < 7; day++) total += dailyClimate(time + day * worldDayMs, effect);
  return total / 7;
}
export function expeditionFindPlan(seed: number, x: number, y: number, startedAt: number, weeks: number, squad = false) {
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
    || !Number.isInteger(weeks) || weeks < 1 || weeks > 3) throw new RangeError('Invalid expedition find plan.');
  let suitability = 0;
  for (let week = 0; week < weeks; week++) suitability += weeklyClimate(startedAt + week * worldWeekMs, recruitmentClimate);
  suitability /= weeks;
  let state = (seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.floor(startedAt / worldDayMs)) >>> 0;
  const roll = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return {
    collectible: roll() < (squad ? clamp(.95 * suitability, .65, 1) : clamp(.8 * suitability, .35, .95)),
    collection: 1 + Number(roll() < clamp(.85 * suitability, .35, .95)),
    activity: Number(roll() < clamp(suitability, .45, 1)) + Number(roll() < clamp(.45 * suitability, .15, .65)),
  };
}
