export const worldEpoch = Date.UTC(2026, 0, 1);
export const worldDayMs = 24 * 60000;
export const worldWeekMs = 7 * worldDayMs;
export const defaultClockSpeed = 33.6;
export const claimCooldownMs = 500;
export const worldWeeksPerYear = 52;
export const seasonMs = 13 * worldWeekMs;
export const worldYearMs = worldWeeksPerYear * worldWeekMs;
export const climateCycleDays = worldWeeksPerYear * 7 * 16;
export const weatherMs = 3 * 60000;
export const serverSyncIntervalMs = 30000;
export const serverClockStaleMs = 90000;
export type ClockSpeed = 1 | 10 | 20 | 168 | typeof defaultClockSpeed;
export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';
export type DayPhase = 'Dawn' | 'Day' | 'Dusk' | 'Night';
export type Weather = 'Clear skies' | 'Overcast' | 'Rain' | 'Snow' | 'Storm';
export interface Environment {
  season: Season;
  phase: DayPhase;
  weather: Weather;
  temperature: number;
  day: number;
  year: number;
  dayOfYear: number;
  weekOfYear: number;
  dayOfWeek: number;
  minuteOfDay: number;
  daylight: number;
}
const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
function random(value: number): number {
  let n = Math.imul(value ^ 0x7f4a7c15, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export function environmentAt(serverTime: number): Environment {
  if (!Number.isSafeInteger(serverTime) || serverTime < 0) throw new RangeError('Invalid server timestamp.');
  const elapsed = serverTime - worldEpoch;
  const season = (['Spring', 'Summer', 'Autumn', 'Winter'] as const)[modulo(Math.floor(elapsed / seasonMs), 4)];
  const day = Math.floor(elapsed / worldDayMs) + 1;
  const year = Math.floor(elapsed / worldYearMs) + 1;
  const dayOfYear = Math.floor(modulo(elapsed, worldYearMs) / worldDayMs) + 1;
  const weekOfYear = Math.floor((dayOfYear - 1) / 7) + 1;
  const dayOfWeek = modulo(dayOfYear - 1, 7) + 1;
  const minute = modulo(elapsed, worldDayMs) / 1000, hour = minute / 60;
  const phase: DayPhase = hour < 5 || hour >= 20 ? 'Night' : hour < 7 ? 'Dawn' : hour < 18 ? 'Day' : 'Dusk';
  const daylight = phase === 'Day' ? 1 : phase === 'Night' ? 0 : phase === 'Dawn' ? (hour - 5) / 2 : (20 - hour) / 2;
  const roll = random(modulo(Math.floor(elapsed / weatherMs), climateCycleDays * worldDayMs / weatherMs));
  const base = { Spring: 14, Summer: 26, Autumn: 12, Winter: -2 }[season];
  const cooling = roll < 0.45 ? 0 : roll < 0.72 ? 2 : roll < 0.94 ? 4 : 6;
  const temperature = Math.round(base + Math.sin((hour - 6) / 24 * Math.PI * 2) * 6 + random(modulo(day - 1, climateCycleDays) + 1) * 4 - 2 - cooling);
  const weather: Weather = roll < 0.45 ? 'Clear skies' : roll < 0.72 ? 'Overcast' : temperature <= 1 ? 'Snow' : roll < 0.94 ? 'Rain' : 'Storm';
  return { season, phase, weather, temperature, day, year, dayOfYear, weekOfYear, dayOfWeek, minuteOfDay: Math.floor(minute), daylight };
}
export function displayServerTime(serverTime: number, elapsed: number, clockSpeed: ClockSpeed = 1): number {
  return serverTime + Math.floor(Math.max(0, Math.min(serverClockStaleMs, elapsed)) * clockSpeed);
}
