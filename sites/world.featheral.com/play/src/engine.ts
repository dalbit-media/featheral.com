import { isWaterFacility, waterFacilities } from './water-facilities.ts';
import type { WaterFacility } from './water-facilities.ts';
import { incomeFacilities, isIncomeFacility } from './income.ts';
import type { IncomeFacility } from './income.ts';
import { dollarsUnits } from './dollars.ts';
import { resourcePrices, withDollarFee } from './costs.ts';
import { monetaryPolicy } from './monetary-policy.ts';
import { constructionLevel, constructions, isConstruction } from './constructions.ts';
import type { Construction } from './constructions.ts';
import { recruitmentClimate, weeklyClimate } from './climate.ts';
import { discountedActivityCost } from './activity-equipment.ts';
import type { EquippedActivities } from './activity-equipment.ts';
import type { EnhancedEquipment, EnhancedEquipped } from './enhancement.ts';
import { foundedFederationName, startingFederations } from './atlas.ts';

export type Resource = 'wood' | 'water' | 'metal' | 'oil';
export type Terrain = 'forest' | 'meadow' | 'water' | 'mountain' | 'oil' | 'lithium'
  | 'rainforest' | 'pineforest' | 'mangrove' | 'grassland' | 'savanna' | 'desert'
  | 'dunes' | 'wetland' | 'river' | 'coast' | 'hills' | 'canyon' | 'volcano' | 'tundra' | 'glacier';
export type Stock = Record<Resource, number>;
export type Cost = Partial<Stock> & { dollars?: number };
export class GameError extends Error {}
export interface Stage { name: string; population: number; cost: Cost }
export const stages: Stage[] = [
  { name: 'Settlement', population: 0, cost: { wood: 60, water: 40 } },
  { name: 'Camp', population: 25, cost: { wood: 100, water: 80, dollars: monetaryPolicy.stageFees[1] } },
  { name: 'Neighborhood', population: 80, cost: { wood: 220, water: 180, metal: 30, dollars: monetaryPolicy.stageFees[2] } },
  { name: 'Village', population: 250, cost: { wood: 450, water: 350, metal: 100, dollars: monetaryPolicy.stageFees[3] } },
  { name: 'Town', population: 800, cost: { wood: 900, water: 700, metal: 250, dollars: monetaryPolicy.stageFees[4] } },
  { name: 'District', population: 2500, cost: { wood: 1800, water: 1400, metal: 600, dollars: monetaryPolicy.stageFees[5] } },
  { name: 'City', population: 10000, cost: { wood: 3500, water: 2800, metal: 1500, dollars: monetaryPolicy.stageFees[6] } },
  { name: 'Metropolis', population: 25000, cost: { wood: 7000, water: 5500, metal: 4000, oil: 300, dollars: monetaryPolicy.stageFees[7] } },
  { name: 'Capital', population: 100000, cost: { wood: 15000, water: 12000, metal: 10000, dollars: monetaryPolicy.stageFees[8] } },
  { name: 'Regional Hub', population: 250000, cost: { wood: 25000, water: 20000, metal: 18000, oil: 750, dollars: 1000 } },
  { name: 'Urban Center', population: 500000, cost: { wood: 40000, water: 35000, metal: 30000, oil: 1500, dollars: 2000 } },
  { name: 'Metropolitan Region', population: 1000000, cost: { wood: 60000, water: 50000, metal: 45000, oil: 2500, dollars: 3000 } },
  { name: 'World City', population: 2000000, cost: { wood: 80000, water: 65000, metal: 60000, oil: 3500, dollars: 4000 } },
  { name: 'Global City', population: 5000000, cost: { wood: 100000, water: 80000, metal: 75000, oil: 5000, dollars: 5000 } },
  { name: 'Megacity', population: 10000000, cost: { wood: 300000, water: 250000, metal: 250000, oil: 20000, dollars: 15000 } },
  { name: 'Great Megacity', population: 20000000, cost: { wood: 750000, water: 600000, metal: 650000, oil: 60000, dollars: 40000 } },
];
export const prices = resourcePrices;
export const buildingCosts = { bank: withDollarFee({ wood: 600, metal: 400 }), townhall: withDollarFee({ wood: 300, metal: 150 }) };
export const diplomacyCosts = { gift: { wood: 40, water: 30 }, form: { metal: 5000 } } satisfies Record<string, Cost>;
export const terrainResources: Record<Terrain, Resource> = {
  forest: 'wood', meadow: 'wood', water: 'water', mountain: 'metal', oil: 'oil', lithium: 'metal',
  rainforest: 'wood', pineforest: 'wood', mangrove: 'wood', grassland: 'wood', savanna: 'wood',
  desert: 'metal', dunes: 'metal', wetland: 'water', river: 'water', coast: 'water',
  hills: 'metal', canyon: 'metal', volcano: 'oil', tundra: 'metal', glacier: 'water',
};
export const terrainDetails: Record<Terrain, { name: string; weeks: number; yield: number }> = {
  forest: { name: 'Whispering woodland', weeks: 1, yield: 1 },
  meadow: { name: 'Sunlit meadow', weeks: 1, yield: 0.8 },
  water: { name: 'Stillwater lake', weeks: 1, yield: 1 },
  mountain: { name: 'Golden highlands', weeks: 2, yield: 1.4 },
  oil: { name: 'Ancient oil seep', weeks: 1, yield: 1 },
  lithium: { name: 'Crystal outcrop', weeks: 2, yield: 1.4 },
  rainforest: { name: 'Emerald rainforest', weeks: 2, yield: 1.5 },
  pineforest: { name: 'Boreal pine forest', weeks: 2, yield: 1.3 },
  mangrove: { name: 'Tidal mangroves', weeks: 2, yield: 1.4 },
  grassland: { name: 'Wildflower grassland', weeks: 1, yield: 0.9 },
  savanna: { name: 'Amber savanna', weeks: 1, yield: 1 },
  desert: { name: 'Copper desert', weeks: 2, yield: 1.2 },
  dunes: { name: 'Singing dunes', weeks: 2, yield: 1.3 },
  wetland: { name: 'Silver reed marsh', weeks: 2, yield: 1.5 },
  river: { name: 'Winding river', weeks: 1, yield: 1.4 },
  coast: { name: 'Turquoise coast', weeks: 1, yield: 1.2 },
  hills: { name: 'Ore-rich hills', weeks: 1, yield: 1 },
  canyon: { name: 'Ochre canyon', weeks: 2, yield: 1.6 },
  volcano: { name: 'Obsidian caldera', weeks: 3, yield: 1.8 },
  tundra: { name: 'Aurora tundra', weeks: 2, yield: 1 },
  glacier: { name: 'Blue ice glacier', weeks: 3, yield: 1.8 },
};
export function isWater(terrain: Terrain): boolean {
  return terrain === 'water' || terrain === 'river' || terrain === 'coast' || terrain === 'glacier';
}
export interface Game {
  version: 1;
  seed: number;
  stock: Stock;
  dollars: number;
  stage: number;
  population: number;
  position: { x: number; y: number };
  home: { x: number; y: number } | null;
  explored: string[];
  harvested: Record<string, number>;
  light: number;
  visibilityRadius?: number;
  activityEquipment?: EquippedActivities;
  enhancedEquipment?: EnhancedEquipment[];
  enhancedEquipped?: EnhancedEquipped;
  bank: boolean;
  townhall: boolean;
  waterFacilities?: Partial<Record<WaterFacility, boolean>>;
  incomeFacilities?: Partial<Record<IncomeFacility, boolean>>;
  constructionLevels?: Partial<Record<Construction, number>>;
  relationship: number;
  federation: string | null;
  votes: string[];
  rewardAt: number;
  contribution: number;
  rewards: number;
  log: string[];
}
export function newGame(): Game {
  return {
    version: 1, seed: Math.floor(Math.random() * 1000000), stock: { wood: 0, water: 0, metal: 0, oil: 0 }, dollars: 0,
    stage: -1, population: 0, position: { x: 0, y: 0 }, home: null, explored: [],
    harvested: {}, light: 0, bank: false, townhall: false, relationship: 25, federation: null,
    votes: [], rewardAt: 0, contribution: 0, rewards: 0, log: ['Your expedition has arrived in the Verdant Reach.'],
  };
}
export function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 0.13) * 43758.5453;
  return n - Math.floor(n);
}
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return (hash(ix, iy, seed) * (1 - u) + hash(ix + 1, iy, seed) * u) * (1 - v)
    + (hash(ix, iy + 1, seed) * (1 - u) + hash(ix + 1, iy + 1, seed) * u) * v;
}
export function terrainAt(x: number, y: number, seed: number): Terrain {
  if (Math.abs(x) < 2 && Math.abs(y) < 2) return 'meadow';
  if (x === 3 && y === 0) return 'water';
  if (x === -3 && y === 0) return 'forest';
  if (x === 0 && y === 3) return 'hills';
  const elevation = noise(x / 8, y / 8, seed);
  const heat = noise(x / 18, y / 18, seed + 41);
  const moisture = noise(x / 12, y / 12, seed + 73);
  if (elevation < 0.23) return heat < 0.3 ? 'glacier' : 'water';
  if (elevation < 0.31) return moisture > 0.6 ? 'mangrove' : 'coast';
  if (elevation > 0.77) return heat > 0.65 ? 'volcano' : moisture < 0.4 ? 'canyon' : 'mountain';
  const deposit = hash(x, y, seed + 8);
  if (deposit > 0.986) return 'lithium';
  if (deposit < 0.016) return 'oil';
  if (heat < 0.28) return moisture > 0.5 ? 'pineforest' : 'tundra';
  if (heat > 0.65 && moisture < 0.46) return elevation > 0.6 ? 'desert' : 'dunes';
  if (moisture > 0.68) return elevation < 0.42 ? 'wetland' : 'rainforest';
  const channel = noise(x / 6, y / 6, seed + 101);
  if (Math.abs(channel - 0.5) < 0.025 && elevation < 0.55) return 'river';
  if (elevation > 0.68) return 'hills';
  if (heat > 0.59) return 'savanna';
  return noise(x / 4, y / 4, seed + 19) > 0.5 ? 'forest' : moisture < 0.43 ? 'grassland' : 'meadow';
}
export function radius(game: Game): number { return game.visibilityRadius ?? 4 + game.light * 2; }
export function discover(game: Game): void {
  survey(game, game.position, radius(game));
}
export function survey(game: Game, position: Game['position'], r: number): void {
  const known = new Set(game.explored);
  for (let x = -Math.floor(r); x <= r; x++) for (let y = -Math.floor(r); y <= r; y++) {
    if (x * x + y * y <= r * r) known.add(`${position.x + x},${position.y + y}`);
  }
  game.explored = [...known];
}
export function canAfford(game: Game, cost: Cost): boolean {
  return Object.entries(cost).every(([key, amount]) => key === 'dollars' ? game.dollars >= dollarsUnits(amount) : game.stock[key as Resource] >= amount);
}
export function pay(game: Game, cost: Cost): void {
  if (cost.dollars !== undefined && game.dollars < dollarsUnits(cost.dollars)) throw new GameError('Not enough FTH$ for this action.');
  if (!canAfford(game, cost)) throw new GameError('Not enough resources. Claim production or visit the market.');
  for (const [key, amount] of Object.entries(cost)) {
    if (key === 'dollars') game.dollars -= dollarsUnits(amount);
    else game.stock[key as Resource] -= amount;
  }
}
export function note(game: Game, message: string): string {
  game.log = [message, ...game.log].slice(0, 40);
  return message;
}
export function move(game: Game, x: number, y: number): string {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('Choose a valid map location.');
  if (Math.hypot(x - game.position.x, y - game.position.y) > radius(game) + 1) throw new GameError('That location is beyond your reach. Explore a little closer first.');
  game.position = { x, y };
  const before = game.explored.length;
  discover(game);
  game.contribution += game.explored.length - before;
  return note(game, `Explored ${terrainAt(x, y, game.seed)} at ${x}, ${y}.`);
}
export function gather(game: Game): string {
  const key = `${game.position.x},${game.position.y}`;
  const count = game.harvested[key] ?? 0;
  if (count >= 5) throw new Error('This location is depleted. Explore another tile for fresh resources.');
  const resource = terrainResources[terrainAt(game.position.x, game.position.y, game.seed)];
  const amount = resource === 'wood' || resource === 'water' ? 35 + Math.max(0, game.stage) * 10 : resource === 'metal' ? 20 : 8;
  game.stock[resource] += amount;
  game.harvested[key] = count + 1;
  game.contribution += 5;
  return note(game, `Collected ${amount} ${resource}. A little more possibility.`);
}
export function upgrade(game: Game): string {
  const next = stages[game.stage + 1];
  if (!next) throw new GameError('Your settlement has reached the highest settlement tier.');
  if (game.population < next.population) throw new GameError(`${next.population.toLocaleString()} residents are required for a ${next.name.toLowerCase()}.`);
  if (game.stage === -1 && isWater(terrainAt(game.position.x, game.position.y, game.seed))) throw new GameError('Choose dry land to establish your settlement.');
  pay(game, next.cost);
  game.stage++;
  if (!game.home) { game.home = { ...game.position }; game.population = 12; }
  return note(game, `Welcome to your ${next.name.toLowerCase()}. Your next chapter starts here.`);
}
export function invite(game: Game, time?: number): string {
  if (game.stage < 0) throw new GameError('Establish your first settlement before inviting residents.');
  pay(game, { dollars: recruitmentDollars(game.population, constructionLevel(game, 'housing'), time, game) });
  return note(game, `Recruiting ${recruitmentAmount(game.population, constructionLevel(game, 'housing'), time).toLocaleString()} residents. Arrival in one game week.`);
}
export function recruitmentAmount(population: number, housingLevel = 0, time?: number): number {
  const amount = Math.max(1, Math.floor(Math.max(1, Math.floor(population / 20)) * (1 + housingLevel / 4)
    * (time === undefined ? 1 : weeklyClimate(time, recruitmentClimate))));
  return Math.min(amount, Math.max(1, Math.ceil(population / 5)));
}
export function recruitmentMetal(population: number): number {
  return 10 + Math.ceil(population / 10);
}
export function recruitmentDollars(population: number, housingLevel = 0, time?: number, game?: Pick<Game, 'activityEquipment' | 'enhancedEquipment' | 'enhancedEquipped'>): number {
  const cost = recruitmentAmount(population, housingLevel, time) * monetaryPolicy.recruitmentPerResident;
  return game ? discountedActivityCost(game, 'attraction', cost) : cost;
}
export function build(game: Game, kind: 'bank' | 'townhall' | 'light' | WaterFacility | IncomeFacility): string {
  if (isIncomeFacility(kind)) {
    const facility = incomeFacilities[kind];
    if (game.stage < facility.stage) throw new GameError('Upgrade your settlement to unlock this commercial building.');
    if (game.incomeFacilities?.[kind]) throw new GameError('This building is already constructed.');
    pay(game, facility.cost);
    game.incomeFacilities = { ...game.incomeFacilities, [kind]: true };
    return note(game, `${facility.name} constructed. No automatic FTH$ income.`);
  }
  if (isWaterFacility(kind)) {
    if (game.stage < 0) throw new GameError('Establish a settlement before constructing Water facilities.');
    if (game.waterFacilities?.[kind]) throw new GameError('This building is already constructed.');
    pay(game, waterFacilities[kind].cost);
    game.waterFacilities = { ...game.waterFacilities, [kind]: true };
    return note(game, `${waterFacilities[kind].name} constructed. Water production increases next work week.`);
  }
  if (kind === 'light') {
    if (game.light >= 2) throw new GameError('Your expedition already has the best available lantern.');
    pay(game, withDollarFee(game.light === 0 ? { wood: 30, metal: 10 } : { wood: 60, metal: 40 }));
    game.light++;
    discover(game);
    return note(game, `${game.light === 1 ? 'Torch' : 'Lantern'} equipped. The world opens a little wider.`);
  }
  if (game[kind]) throw new GameError('This building is already constructed.');
  if (game.stage < (kind === 'bank' ? 6 : 4)) throw new GameError(kind === 'bank' ? 'Upgrade to a city to build a bank.' : 'Upgrade to a town to build a town hall.');
  pay(game, buildingCosts[kind]);
  game[kind] = true;
  return note(game, `${kind === 'bank' ? 'Bank' : 'Town hall'} constructed. New opportunities unlocked.`);
}
export function trade(_game: Game, _resource: Resource, _direction: 'buy' | 'sell', _amount: number): string {
  throw new GameError('Use the marketplace to buy or sell resources.');
}
export function diplomacy(game: Game, action: 'gift' | 'join' | 'form' | 'vote', federation = 'Evergreen Union'): string {
  if (action === 'gift') {
    if (!startingFederations.some(identity => identity.name === federation)) throw new GameError('Choose a starting federation.');
    pay(game, diplomacyCosts.gift);
    game.relationship = Math.min(100, game.relationship + 25);
    return note(game, `A goodwill shipment reached ${federation}. Relations improved.`);
  }
  if (action === 'join') {
    if (!startingFederations.some(identity => identity.name === federation)) throw new GameError('Choose a starting federation.');
    if (game.federation) throw new GameError('Your community already belongs to a federation.');
    if (game.stage < 3 || game.relationship < 50) throw new GameError('A village and at least 50 relationship points are required to join.');
    game.federation = federation;
    return note(game, `Your community joined ${federation}. Together, we grow.`);
  }
  if (action === 'form') {
    if (game.federation) throw new GameError('Your community already belongs to a federation.');
    if (game.stage < 6 || game.population <= 10000) throw new GameError('Founding requires a city with more than 10,000 residents.');
    pay(game, diplomacyCosts.form);
    game.federation = foundedFederationName(game.seed);
    return note(game, `${game.federation} founded. A new chapter in shared governance.`);
  }
  if (!game.federation || !game.townhall || game.stage < 4) throw new GameError('Join a federation and construct a town hall to vote.');
  if (game.votes.includes('watershed')) throw new GameError('Your community has already voted on this proposal.');
  game.votes.push('watershed');
  game.contribution += 50;
  return note(game, 'Vote recorded: support the shared watershed restoration proposal.');
}
export function claim(_game: Game, _now = Date.now()): string {
  throw new GameError('FTH$ rewards are disabled. Sell owned resources in the marketplace.');
}
export function parseSave(raw: string): Game {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Save data is not an object.');
  const g = value as Record<string, unknown>;
  const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const coordinate = (p: unknown): boolean => !!p && typeof p === 'object' && ['x', 'y'].every(k => Number.isSafeInteger((p as Record<string, unknown>)[k]));
  const resources: Resource[] = ['wood', 'water', 'metal', 'oil'];
  if (g.version !== 1 || !integer(g.seed) || !g.stock || typeof g.stock !== 'object'
    || !resources.every(k => integer((g.stock as Record<string, unknown>)[k])) || !integer(g.dollars)
    || !Number.isInteger(g.stage) || (g.stage as number) < -1 || (g.stage as number) >= stages.length
    || !integer(g.population) || !coordinate(g.position) || !(g.home === null || coordinate(g.home))
    || !Array.isArray(g.explored) || !g.explored.every(k => typeof k === 'string' && /^-?\d+,-?\d+$/.test(k))
    || !g.harvested || typeof g.harvested !== 'object' || !Object.values(g.harvested).every(n => integer(n) && n <= 5)
    || !integer(g.light) || g.light > 2
    || (g.visibilityRadius !== undefined && (typeof g.visibilityRadius !== 'number' || ![4, 5, 6, 8, 10].includes(g.visibilityRadius)))
    || typeof g.bank !== 'boolean' || typeof g.townhall !== 'boolean'
    || (g.waterFacilities !== undefined && (!g.waterFacilities || typeof g.waterFacilities !== 'object' || Array.isArray(g.waterFacilities)
      || !Object.entries(g.waterFacilities).every(([key, built]) => isWaterFacility(key) && typeof built === 'boolean')))
    || (g.incomeFacilities !== undefined && (!g.incomeFacilities || typeof g.incomeFacilities !== 'object' || Array.isArray(g.incomeFacilities)
      || !Object.entries(g.incomeFacilities).every(([key, built]) => isIncomeFacility(key) && typeof built === 'boolean')))
    || (g.constructionLevels !== undefined && (!g.constructionLevels || typeof g.constructionLevels !== 'object' || Array.isArray(g.constructionLevels)
      || !Object.entries(g.constructionLevels).every(([key, level]) => isConstruction(key) && integer(level) && level <= constructions[key].maxLevel)))
    || !integer(g.relationship) || g.relationship > 100 || !(g.federation === null || typeof g.federation === 'string')
    || !Array.isArray(g.votes) || !g.votes.every(v => typeof v === 'string')
    || !integer(g.rewardAt) || !integer(g.contribution) || !integer(g.rewards)
    || !Array.isArray(g.log) || !g.log.every(l => typeof l === 'string')) throw new Error('Save data is incomplete or invalid.');
  return value as Game;
}
