import { radius } from './engine.ts';
import type { Cost, Game } from './engine.ts';
import type { Workforce } from './api-types.ts';
import { dollarsScale, dollarsUnits } from './dollars.ts';
import { expeditionSurveyRadius, explorationQuote, investigationQuote, workforceCounts } from './workforce.ts';

export const squadItems = {
  'squad-10': { name: 'Squad dispatch voucher · 10 missions', quantity: 10, cost: { wood: 20, metal: 10, water: 10 } },
  'squad-20': { name: 'Squad dispatch voucher · 20 missions', quantity: 20, cost: { wood: 40, metal: 20, water: 20 } },
  'squad-50': { name: 'Squad dispatch voucher · 50 missions', quantity: 50, cost: { wood: 100, metal: 50, water: 50 } },
  'squad-100': { name: 'Squad dispatch voucher · 100 missions', quantity: 100, cost: { wood: 200, metal: 100, water: 100 } },
} as const satisfies Record<string, { name: string; quantity: number; cost: Cost }>;
export type SquadItem = keyof typeof squadItems;
export type SquadActivity = 'exploration' | 'investigation';
export const squadKeys = Object.keys(squadItems) as SquadItem[];
export function isSquadItem(value: unknown): value is SquadItem {
  return typeof value === 'string' && Object.hasOwn(squadItems, value);
}
export function isSquadActivity(value: unknown): value is SquadActivity {
  return value === 'exploration' || value === 'investigation';
}
export interface SquadMission { x: number; y: number; dollars: number; weeks: number }
export interface SquadPlan { missions: SquadMission[]; dollarsUnits: number; workers: number }
export function planSquad(game: Game, work: Pick<Workforce, 'expeditions' | 'crews'>,
  activity: SquadActivity, maximum: number): SquadPlan {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new RangeError('Invalid squad mission limit.');
  const plan: SquadPlan = { missions: [], dollarsUnits: 0, workers: 0 };
  const limit = Math.min(maximum, 100, Math.floor(workforceCounts(game.population, work).available / 2));
  if (game.stage < 0 || limit < 1) return plan;
  const reach = radius(game) + 1, known = new Set(game.explored);
  const active = new Set(work.expeditions.map(mission => `${mission.x},${mission.y}`));
  const coverage = new Set<string>();
  const cover = (x: number, y: number, r: number): void => {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++)
      if (Math.hypot(dx, dy) <= r) coverage.add(`${x + dx},${y + dy}`);
  };
  for (const mission of work.expeditions) if (mission.kind !== 'investigate') cover(mission.x, mission.y, mission.surveyRadius);
  const candidates: SquadMission[] = [];
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
    const x = game.position.x + dx, y = game.position.y + dy, key = `${x},${y}`;
    if (Math.hypot(dx, dy) > reach || active.has(key) || known.has(key) !== (activity === 'investigation')) continue;
    const quote = activity === 'exploration' ? explorationQuote(game, x, y) : investigationQuote(game, x, y);
    candidates.push({ x, y, ...quote });
  }
  candidates.sort((a, b) => a.dollars - b.dollars || a.x - b.x || a.y - b.y);
  for (const candidate of candidates) {
    if (plan.missions.length >= limit) break;
    if (activity === 'exploration' && coverage.has(`${candidate.x},${candidate.y}`)) continue;
    const concurrent = work.expeditions.length + plan.missions.length;
    const quote = activity === 'exploration' ? explorationQuote(game, candidate.x, candidate.y, concurrent)
      : investigationQuote(game, candidate.x, candidate.y, concurrent);
    const units = Math.round(quote.dollars * dollarsScale);
    if (!Number.isSafeInteger(units) || units > game.dollars - plan.dollarsUnits) break;
    plan.missions.push({ x: candidate.x, y: candidate.y, ...quote });
    plan.dollarsUnits += dollarsUnits(quote.dollars); plan.workers += 2;
    if (activity === 'exploration') cover(candidate.x, candidate.y, expeditionSurveyRadius(game));
  }
  return plan;
}
