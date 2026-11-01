import type { Game } from './engine.ts';
import { withDollarFee } from './costs.ts';

export const waterFacilities = {
  well: { name: 'Well', bonus: 1, cost: withDollarFee({ wood: 60, metal: 20 }), x: -5, y: -1 },
  rainCollector: { name: 'Rain collector', bonus: 2, cost: withDollarFee({ wood: 120, metal: 45 }), x: 4, y: -1 },
  pumpingStation: { name: 'Pumping station', bonus: 4, cost: withDollarFee({ wood: 240, metal: 90 }), x: 6, y: 4 },
} as const;
export type WaterFacility = keyof typeof waterFacilities;
export const waterFacilityKeys = Object.keys(waterFacilities) as WaterFacility[];
export function isWaterFacility(value: unknown): value is WaterFacility {
  return typeof value === 'string' && Object.hasOwn(waterFacilities, value);
}
export function waterProductionMultiplier(game: Game): number {
  return 1 + waterFacilityKeys.reduce((sum, key) => sum + (game.waterFacilities?.[key] ? waterFacilities[key].bonus : 0), 0);
}
