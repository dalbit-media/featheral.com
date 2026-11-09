import type { Game, Resource, Stock } from './engine.ts';
import type { ClockSpeed, Environment } from './environment.ts';
import type { CraftableItem, DecorationItem, DecorationSlot, ItemInventory, VisibilityItem } from './items.ts';
import type { GridPosition, SettlementEntity } from './settlement-layout.ts';
import type { WaterFacility } from './water-facilities.ts';
import type { IncomeFacility } from './income.ts';
import type { Construction } from './constructions.ts';
import type { CollectionItem } from './collection.ts';
import type { ActivityItem, ActivityKind } from './automation.ts';
import type { Customization, CustomizationItem } from './customization.ts';
import type { ActionReadyAt } from './action-timing.ts';
import type { ActivityEquipment, EquipmentActivity } from './activity-equipment.ts';
import type { TransportItem } from './transport-items.ts';

export type Command =
  | { type: 'move'; x: number; y: number }
  | { type: 'investigate'; x: number; y: number }
  | { type: 'assign'; resource: Resource; workers: number }
  | { type: 'automatic'; enabled: boolean }
  | { type: 'trade'; resource: Resource; direction: 'buy' | 'sell'; amount: number }
  | { type: 'build'; kind: 'bank' | 'townhall' | WaterFacility | IncomeFacility }
  | { type: 'construction'; kind: Construction }
  | { type: 'craft'; item: CraftableItem; quantity?: number }
  | { type: 'map-collect'; x: number; y: number }
  | { type: 'equip'; item: VisibilityItem | null }
  | { type: 'activity-gear'; activity: EquipmentActivity; item: ActivityEquipment | null }
  | { type: 'decorate'; slot: DecorationSlot; item: DecorationItem | null }
  | { type: 'arrange'; entity: SettlementEntity; position: GridPosition | null }
  | { type: 'diplomacy'; action: 'gift' | 'join' | 'form' | 'vote'; federation?: string }
  | { type: 'federation-contribute'; asset: Resource | 'dollars'; amount: number }
  | { type: 'claim'; resource?: Resource }
  | { type: 'collect-sell'; resource: Resource; quantity: number; minimumDollars: number }
  | { type: 'activate-collection'; item: CollectionItem }
  | { type: 'use-customization'; item: CustomizationItem; value: string }
  | { type: 'activate-activity'; item: ActivityItem }
  | { type: 'activity-automation'; activity: ActivityKind; enabled: boolean }
  | { type: 'upgrade' | 'invite' | 'home' | 'warehouse' | 'item-storage' | 'collect-items' | 'gather' };

export interface ResourceCrew {
  workers: number;
  readyAt: number;
  weeklyYield: number;
  weeklyMetalCost: number;
  weeklyDollarsCost?: number;
  automaticDelivery?: true;
  payOnPickup?: true;
}
export interface Expedition {
  kind?: 'investigate';
  itemFind?: CollectionItem | ActivityItem;
  x: number;
  y: number;
  workers: number;
  startedAt?: number;
  readyAt: number;
  surveyRadius: number;
  dollarReward?: number;
  finds?: { collectible: boolean; collection: number; activity: number };
}
export interface Workforce {
  version: 3;
  transportVersion?: 1;
  automatic: boolean;
  allocation: Stock;
  cycleAt: number;
  unfundedWorkers: number;
  crews: Partial<Record<Resource, ResourceCrew>>;
  expeditions: Expedition[];
}
export interface Snapshot {
  actionReadyAt?: ActionReadyAt;
  customization?: Customization;
  physicalVersion?: 1;
  collection?: { fees: Stock; automationUntil: Stock; vouchers?: Partial<Record<Resource, TransportItem>> };
  activityAutomation?: Record<ActivityKind, { until: number; enabled: boolean; nextAt: number; reason: string | null }>;
  fthg: number;
  dollars: number;
  income: { weekly: number; readyAt: number };
  inventory: ItemInventory;
  game: Game;
  pending: Stock;
  rates: Stock;
  capacity: number;
  claimThreshold: number;
  warehouse: number;
  warehouseCost: { wood: number; metal: number; dollars: number } | null;
  revision: number;
  serverTime: number;
  environment: Environment;
  inviteReadyAt: number;
  recruitment: { population: number; startedAt: number; readyAt: number } | null;
  waterUpkeep: { readyAt: number; dailyConsumption: number; weeklyConsumption: number; shortage: number; populationLoss: number; lastPopulationLoss: number; paused: boolean } | null;
  settlementUpkeep?: { readyAt: number; paused: boolean; resources: Record<'wood' | 'metal', { dailyConsumption: number; weeklyConsumption: number; shortage: number }> } | null;
  populationCycle?: { readyAt: number; lastChange: number } | null;
  workforce: Workforce;
  availableWorkers: number;
  resourceAccess: Record<Resource, ResourceAccess>;
  recruitmentDollars: number;
}
export interface CollectionQuote {
  resource: Resource; quantity: number; transport: number; proceeds: number; net: number; available: boolean;
  sellAvailable?: boolean; voucher?: TransportItem; discount?: number;
}
export interface CollectionResponse extends ApiState { collectionQuote: CollectionQuote }
export interface ResourceAccess {
  weeklyConsumption?: number;
  available: boolean;
  distance: number;
  efficiency: number;
  perWorker: number;
  dollarsPerWorker: number;
}
export interface PopulationTotals { global: number; federation: number | null }
export interface PublicTotals { settlements: number; metal: number; population: number; dollars: number }
export interface PublicStats extends PublicTotals { updatedAt: number }
export interface ApiState extends Snapshot {
  federationVault?: FederationVault | null;
  csrf: string; population: PopulationTotals; clockSpeed: ClockSpeed; message?: string;
  fundWallet?: string | null; fundMode?: 'guest' | 'legacy-direct' | 'separate'; fundAccountId?: string | null;
}
export interface FederationVault {
  year: number;
  stock: Stock & { dollars: number };
  annualContributed: Stock & { dollars: number };
  totalValue: number;
  annualValue: number;
  contributors: {
    id: string; name: string; yours: boolean;
    contributed: Stock & { dollars: number }; annualContributed: Stock & { dollars: number };
    value: number; annualValue: number; allTimePercent: number; annualPercent: number;
  }[];
  taxStatus: 'pending';
}
