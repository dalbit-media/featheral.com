import { buildingCosts, diplomacyCosts, recruitmentAmount, stages } from './engine.ts';
import type { Cost, Resource } from './engine.ts';
import type { Command, Snapshot } from './api-types.ts';
import { craftingCost, itemName, itemStorage } from './items.ts';
import { explorationQuote } from './workforce.ts';
import { activityItemDetails, activityName } from './automation.ts';
import { isWaterFacility, waterFacilities } from './water-facilities.ts';
import type { MarketAsset, MarketCommand } from './market.ts';
import { fthgScale, fthgUnits } from './fthg.ts';
import { incomeFacilities, isIncomeFacility } from './income.ts';
import { constructionCost, constructionLevel, constructions } from './constructions.ts';
import { collectionItemDetails } from './collection.ts';
import { dollarsScale } from './dollars.ts';

export interface ConsumptionAmount { asset: MarketAsset | 'fthg' | 'dollars'; amount: number }
export interface ConsumptionQuote {
  title: string;
  subject: string;
  costs: ConsumptionAmount[];
  weeks: number | null;
  residents?: number;
  arrivals?: number;
  receives?: ConsumptionAmount[];
  receiveLabel?: string;
  costLabel?: string;
  notes: string[];
}
function amounts(cost: Cost): ConsumptionAmount[] {
  return Object.entries(cost).map(([asset, amount]) => ({ asset: asset as Resource | 'dollars', amount }));
}
function itemNameForResource(resource: Resource): string {
  return resource[0].toUpperCase() + resource.slice(1);
}
export function gameConsumption(state: Snapshot, command: Command): ConsumptionQuote | null {
  const { game } = state;
  const quote = (title: string, subject: string, cost: Cost, notes: string[] = []): ConsumptionQuote =>
    ({ title, subject, costs: amounts(cost), weeks: 0, notes });
  switch (command.type) {
    case 'claim':
      return command.resource ? { ...quote('Collect resources', itemNameForResource(command.resource), { dollars: state.collection?.fees[command.resource] ?? 0 }),
        receives: [{ asset: command.resource, amount: state.pending[command.resource] }], notes: ['Transport is paid in FTH$ when completed resources are collected.'] } : null;
    case 'collect-sell':
      return { ...quote('Collect and sell', itemNameForResource(command.resource), {}, ['Completed output is sold at marketplace prices. Transport is deducted from the proceeds.',
        ...(command.resource === 'water' ? ['Selling Water can cause daily shortages. Keep enough Water for your residents.'] : [])]),
        costs: [{ asset: command.resource, amount: command.quantity }],
        receives: [{ asset: 'dollars', amount: command.minimumDollars / dollarsScale }], receiveLabel: 'Minimum received' };
    case 'activate-collection':
      return { ...quote('Activate auto-collection', itemName(command.item), {}, ['Consumes one item. Remaining automation time stacks. FTH$ transport is still required.']),
        costs: [{ asset: command.item, amount: 1 }], weeks: collectionItemDetails(command.item).weeks };
    case 'activate-activity':
      return { ...quote('Activate activity automation', itemName(command.item), {},
        ['Consumes one item. Remaining automation time stacks. Normal FTH$ fees are paid automatically. Insufficient funds, Water or idle residents pause new activity.',
          'Auto-exploration keeps one expedition travelling. Auto-recruitment starts the next batch after arrival. Paid jobs still finish after automation expires.']),
        costs: [{ asset: command.item, amount: 1 }], weeks: activityItemDetails(command.item).weeks };
    case 'activity-automation':
      return command.enabled ? quote('Resume activity automation', activityName(command.activity), {},
        ['Normal FTH$ fees are paid automatically while automation time remains.']) : null;
    case 'move': {
      if (game.stage < 0 || game.explored.includes(`${command.x},${command.y}`)) return null;
      const cost = explorationQuote(game, command.x, command.y, state.workforce.expeditions.length);
      return { ...quote('Explore', `${command.x}, ${command.y}`, { dollars: cost.dollars },
        ['Assigned residents return when the expedition finishes.',
          'Concurrent expedition fees use 1x, 2x, 3x... of the route cost. The multiplier is based on expeditions still travelling at departure.']), weeks: cost.weeks, residents: 2 };
    }
    case 'invite':
      return { ...quote('Recruit residents', 'Residents', { dollars: state.recruitmentDollars },
        ['Payment is made now. Residents arrive after one full game week.',
          'Season, daily weather and temperature affect new recruitment. The paid arrival count is locked at departure.']), weeks: 1,
        arrivals: recruitmentAmount(game.population, constructionLevel(game, 'housing'), state.physicalVersion ? state.serverTime : undefined) };
    case 'construction': {
      const cost = constructionCost(game, command.kind);
      return cost ? quote('Upgrade construction', constructions[command.kind].name, cost,
        ['Benefits apply to new activity. Paid deliveries and expeditions stay unchanged.']) : null;
    }
    case 'upgrade': {
      const next = stages[game.stage + 1];
      return next ? quote(game.stage < 0 ? 'Establish settlement' : 'Upgrade settlement', next.name, next.cost) : null;
    }
    case 'build': {
      if (isIncomeFacility(command.kind)) return quote('Construct', incomeFacilities[command.kind].name, incomeFacilities[command.kind].cost);
      if (isWaterFacility(command.kind)) {
        const facility = waterFacilities[command.kind];
        return quote('Construct', facility.name, facility.cost, ['Water output increases for new crews next work week.']);
      }
      return quote('Construct', command.kind === 'bank' ? 'Bank' : 'Town hall', buildingCosts[command.kind]);
    }
    case 'warehouse':
      return state.warehouseCost ? quote('Expand storage', 'Resource warehouse', state.warehouseCost) : null;
    case 'item-storage': {
      const next = itemStorage[state.inventory.storage + 1];
      return next ? quote('Expand storage', next.name, { metal: next.metal, dollars: next.dollars }) : null;
    }
    case 'craft': return quote('Craft', `${command.quantity ?? 1} × ${itemName(command.item)}`, craftingCost(command.item, command.quantity));
    case 'diplomacy':
      if (command.action === 'gift') return quote('Send goodwill shipment', 'Evergreen Union', diplomacyCosts.gift);
      if (command.action === 'form') return quote('Found federation', 'Verdant Federation', diplomacyCosts.form);
      return null;
    default: return null;
  }
}
export function marketConsumption(command: MarketCommand): ConsumptionQuote | null {
  if (command.type === 'cancel') return null;
  if (command.type === 'fund-pool') return {
    title: 'Fund market liquidity', subject: 'Marketplace', weeks: 0,
    costs: [{ asset: command.asset, amount: command.quantity }, { asset: 'dollars', amount: command.dollars }],
    notes: ['This permanently donates owned assets and existing FTH$ to the selected market. Donations cannot be withdrawn. No currency is issued.'],
  };
  if (command.type === 'sell-half') return {
    title: 'Sell half of all resources', subject: 'Settlement', weeks: 0,
    costs: command.sales.map(sale => ({ asset: sale.asset, amount: sale.quantity })),
    receives: [{ asset: 'dollars', amount: command.sales.reduce((sum, sale) => sum + fthgUnits(sale.limitDollars), 0) / fthgScale }],
    receiveLabel: 'Minimum received',
    notes: ['Sells half of each owned resource, rounded down. Pending resources and escrow are excluded.',
      'All resources sell together or nothing is sold. Prices may move by up to 2%.',
      'Selling Water can cause daily shortages. Keep enough Water for your residents.'],
  };
  const total = command.type === 'spot' ? command.limitDollars : fthgUnits(command.price) * command.quantity / fthgScale;
  const asset = { asset: command.asset, amount: command.quantity };
  const currency: ConsumptionAmount = { asset: 'dollars', amount: total };
  const buy = command.side === 'buy';
  return {
    title: buy ? 'Buy' : 'Sell', subject: 'Marketplace', weeks: command.type === 'limit' ? null : 0,
    costs: [buy ? currency : asset], receives: [buy ? asset : currency],
    costLabel: buy && command.type === 'spot' ? 'Maximum payment' : 'You spend',
    receiveLabel: !buy ? command.type === 'spot' ? 'Minimum received' : 'If fully sold' : command.type === 'limit' ? 'If fully bought' : 'You receive',
    notes: command.type === 'limit'
      ? ['An offer may fill gradually. Unused FTH$ or unsold items stay held until completion or cancellation.']
      : ['The price can change within the displayed payment limit. The server checks availability before completing the trade.'],
  };
}
