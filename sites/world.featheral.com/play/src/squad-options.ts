import type { Command, Snapshot } from './api-types.ts';
import { dollarsUnits } from './dollars.ts';
import { planSquad, squadItems, squadKeys } from './exploration-squads.ts';
import type { SquadActivity, SquadItem } from './exploration-squads.ts';
import { sellableItemCount } from './items.ts';

export function fieldMissionActivity(command: Command, game: Snapshot['game']): SquadActivity | null {
  return command.type === 'investigate' ? 'investigation'
    : command.type === 'move' && game.stage >= 0 && !game.explored.includes(`${command.x},${command.y}`) ? 'exploration' : null;
}
export interface SquadOption {
  item: SquadItem;
  owned: number;
  command: Extract<Command, { type: 'dispatch-squad' }>;
  reason: string | null;
}
export function squadOptions(state: Snapshot, activity: SquadActivity): SquadOption[] {
  const owned = squadKeys.filter(item => sellableItemCount(state.inventory, item) > 0);
  if (!owned.length) return [];
  const plan = planSquad(state.game, state.workforce, activity, Math.max(...owned.map(item => squadItems[item].quantity)));
  const blocked = state.game.stage < 0 || state.waterUpkeep?.paused || state.settlementUpkeep?.paused;
  return owned.map(item => {
    const missions = plan.missions.slice(0, squadItems[item].quantity);
    return {
      item, owned: sellableItemCount(state.inventory, item),
      command: { type: 'dispatch-squad', item, activity, quantity: missions.length,
        maximumDollars: missions.reduce((sum, mission) => sum + dollarsUnits(mission.dollars), 0) },
      reason: blocked ? 'Settlement and adequate supplies are required for squad dispatch.'
        : !missions.length ? 'No missions can launch. Check available residents, funds and reachable destinations.' : null,
    };
  });
}
