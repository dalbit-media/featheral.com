import type { DecorationItem } from './items.ts';

export const builderCharter = 'builder-charter';
export const builderItems = {
  'builder-charter': { name: 'Master Builder Charter', stage: 0, cost: { wood: 200, metal: 100, dollars: 1000 },
    ingredients: {
      planter: 1, bench: 1, banner: 1, fountain: 1, boardwalk: 1, canopy: 1, logseat: 1, flowerbed: 1,
      fence: 1, birdhouse: 1, trellis: 1, barrel: 1, picnic: 1, arch: 1, swing: 1, gazebo: 1,
      clocktower: 1, monument: 1, streetlamp: 1, kiosk: 1, pavilion: 1, greenhouse: 1, sculpture: 1,
      tramstop: 1, solar: 1, verticalgarden: 1, observatory: 1, lightspire: 1, biodome: 1, skybeacon: 1,
    } satisfies Partial<Record<DecorationItem, number>> },
} as const;
export function isBuilderItem(value: unknown): value is typeof builderCharter { return value === builderCharter; }
