import { buildingCosts, diplomacyCosts, recruitmentAmount, stages } from './engine.ts';
import type { Cost, Resource } from './engine.ts';
import type { CollectionQuote, Command, Snapshot } from './api-types.ts';
import { craftingCost, craftingIngredients, craftingInputs, itemName, itemStorage } from './items.ts';
import { isTitleItem } from './customization.ts';
import { explorationCount, explorationQuote, investigationQuote } from './workforce.ts';
import { activityItemDetails, activityName } from './automation.ts';
import { isWaterFacility, waterFacilities } from './water-facilities.ts';
import type { MarketAsset, MarketCommand, MarketSnapshot } from './market.ts';
import { marketAssetName } from './market.ts';
import { fthgScale, fthgUnits } from './fthg.ts';
import { incomeFacilities, isIncomeFacility } from './income.ts';
import { constructionCost, constructionLevel, constructions } from './constructions.ts';
import { collectionItemDetails } from './collection.ts';
import { dollarsScale } from './dollars.ts';
import { maxUpgradePlan } from './max-upgrades.ts';
import { builderCharter } from './builder-items.ts';
import { enhancementQuote } from './enhancement.ts';
import { activityEquipmentBenefit, activityEquipmentDiscount, isActivityEquipment } from './activity-equipment.ts';
import { bulkCraftingPermit, isBulkCraftingItem } from './bulk-crafting.ts';
import { isTransportItem, transportBenefit } from './transport-items.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { formatDollars } from './dollars.ts';
import { marketAnalysisFee } from './market-analysis.ts';
import { planSquad, squadItems } from './exploration-squads.ts';
import type { AutoCraftQuote } from './auto-crafting.ts';

export interface ConsumptionAmount { asset: MarketAsset | 'fthg' | 'dollars'; amount: number }
export interface ConsumptionQuote {
  title: string;
  subject: string;
  literalSubject?: boolean;
  costs: ConsumptionAmount[];
  weeks: number | null;
  days?: number;
  residents?: number;
  arrivals?: number;
  receives?: ConsumptionAmount[];
  receiveLabel?: string;
  costLabel?: string;
  notes: string[];
  preciseDollars?: boolean;
  warning?: string;
  recommendations?: { label: string; href: string }[];
  details?: { label: string; value: string }[];
}
export function autoCraftConsumption(quote: AutoCraftQuote, language: Language): ConsumptionQuote {
  const fmt = (value: number) => `FTH$ ${formatDollars(value, locale(language))}`;
  const outputs = new Map<MarketAsset, number>();
  for (const batch of quote.batches) outputs.set(batch.item, (outputs.get(batch.item) ?? 0) + batch.quantity);
  return { title: 'Automatic craft and sell', subject: 'Master Merchant Charter', costs: quote.costs, weeks: 0,
    receives: [{ asset: 'dollars', amount: quote.proceeds }], receiveLabel: 'Immediate sale proceeds',
    details: [
      { label: 'Estimated total profit', value: fmt(quote.estimatedProfit) },
      { label: 'Cash balance increase', value: fmt(quote.cashChange) },
      { label: 'Starting spending ceiling', value: fmt(quote.spendingCeiling) },
      { label: 'Bulk permits consumed', value: quote.consumedPermits.toLocaleString(locale(language)) },
      { label: 'Unused bulk permits', value: quote.remainingPermits.toLocaleString(locale(language)) },
      ...[...outputs].map(([item, count]) => ({ label: translate(marketAssetName(item), language), value: `${count.toLocaleString(locale(language))} × ${translate('Craft and sell', language)}` })),
    ],
    notes: ['Highest estimated profit per copy first. Only complete, profitable batches with executable sales are included.',
      'Uses owned materials and only the starting FTH$ balance. Sale proceeds are not reinvested.',
      'Crafting fees are capped at FTH$1,000,000 per merchant run, or your starting balance if lower. Unused funds and permits remain available.',
      'Estimated profit deducts crafting fees and current purchase values of consumed materials and bulk permits. The already-owned charter acquisition cost is excluded.',
      'One charter is consumed. Unused bulk permits stay in inventory. The included analysis applies only to this operation.',
      'Changed quotes cancel the entire operation without consuming anything.'],
  };
}
export const transportRecommendations = [
  { label: 'Upgrade Trade hub routes', href: '/settlement/#buildings' },
  { label: 'Craft transport vouchers', href: '/inventory/#craft' },
  { label: 'Buy transport vouchers', href: '/market/?asset=transport-convoy&side=buy' },
];
export function claimConsumption(state: Snapshot, resource: Resource, quote: CollectionQuote, language: Language): ConsumptionQuote {
  const consumption = gameConsumption(state, { type: 'claim', resource })!;
  consumption.costs = [{ asset: 'dollars', amount: quote.transport }, ...(quote.voucher ? [{ asset: quote.voucher, amount: 1 }] : [])];
  consumption.preciseDollars = true;
  const t = (text: string) => translate(text, language);
  const money = (value: number) => formatDollars(value, locale(language));
  consumption.notes.push(quote.sellAvailable
    ? `${t('Current market sell value')}: FTH$ ${money(quote.proceeds)} · ${t('After transport')}: FTH$ ${money(quote.net)}`
    : t('Market sale quote unavailable. Profit after transport cannot be verified.'));
  if (quote.sellAvailable && quote.net < 0) consumption.warning = 'Selling this pickup now would lose FTH$ after transport.';
  if (quote.voucher) consumption.notes.push(transportBenefit(quote.voucher));
  consumption.notes.push('Sale estimate only. Claim stores resources and does not sell them. Voucher purchase or crafting cost is excluded.');
  if (consumption.warning || !quote.sellAvailable) {
    consumption.notes.push('Upgrade Trade hub routes for future deliveries, or craft/buy single-use transport vouchers for up to 50% off pickup fees.');
    consumption.recommendations = transportRecommendations;
  }
  return consumption;
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
    case 'federation-contribute':
      return { ...quote('Contribute to common vault', game.federation ?? 'Federation',
        { [command.asset]: command.amount }, ['Contributions are permanent. No withdrawal or payout is currently available.',
          'Resource contributions use fixed base FTH$ prices. Annual shares are recorded by game year.']),
        preciseDollars: true };
    case 'use-customization':
      return { ...quote(isTitleItem(command.item) ? 'Set player title' : 'Edit settlement identity', command.value, {},
        ['Consumes one permit. Names and titles are cosmetic and do not change ownership or permissions.']),
        literalSubject: !isTitleItem(command.item), costs: [{ asset: command.item, amount: 1 }] };
    case 'claim':
      return command.resource ? { ...quote('Collect resources', itemNameForResource(command.resource), { dollars: state.collection?.fees[command.resource] ?? 0 }),
        costs: [...amounts({ dollars: state.collection?.fees[command.resource] ?? 0 }),
          ...(state.collection?.vouchers?.[command.resource] ? [{ asset: state.collection.vouchers[command.resource]!, amount: 1 }] : [])],
        receives: [{ asset: command.resource, amount: state.pending[command.resource] }], notes: ['Transport is paid in FTH$ when completed resources are collected.'] } : null;
    case 'collect-sell':
      return { ...quote('Collect and sell', itemNameForResource(command.resource), {}, ['Completed output is sold at marketplace prices. Transport is deducted from the proceeds.',
        'Collect all completed output, sell the selected amount, and store the rest. Full transport is deducted from proceeds.',
        ...(command.resource === 'water' ? ['Selling Water can cause daily shortages. Keep enough Water for your residents.'] : [])]),
        costs: [{ asset: command.resource, amount: command.quantity }, ...(state.collection?.vouchers?.[command.resource]
          ? [{ asset: state.collection.vouchers[command.resource]!, amount: 1 }] : [])],
        receives: [{ asset: 'dollars', amount: command.minimumDollars / dollarsScale }], receiveLabel: 'Minimum received' };
    case 'activate-collection':
      return { ...quote('Activate auto-collection', itemName(command.item), {}, ['Consumes one item. Remaining automation time stacks. FTH$ transport is still required.',
        ...(collectionItemDetails(command.item).resource === 'all' ? ['Applies the duration to Wood, Water, Metal and Oil independently. Oil still requires its normal unlock.'] : [])]),
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
      const cost = explorationQuote(game, command.x, command.y, explorationCount(state.workforce.expeditions));
      return { ...quote('Explore', `${command.x}, ${command.y}`, { dollars: cost.dollars },
        ['Assigned residents return when the expedition finishes.',
          'Investigate and Explore share a 1x, 2x, 4x, 8x... route fee multiplier. Each active field team doubles the next fee at departure.',
          ...(activityEquipmentDiscount(game, 'exploration') ? [`Equipped gear reduces exploration fees by ${activityEquipmentDiscount(game, 'exploration')}%. Paid jobs stay unchanged.`] : [])]), weeks: cost.weeks, residents: 2 };
    }
    case 'investigate': {
      const cost = investigationQuote(game, command.x, command.y, explorationCount(state.workforce.expeditions));
      return { ...quote('Investigate', `${command.x}, ${command.y}`, { dollars: cost.dollars },
        ['Two idle residents return after one game week. Known terrain is not expanded.',
          '10% chance of one permit: 90% one-week tier, 10% four-week tier. No keepsakes or high-tier items.',
          'Costs 10% of the undiscounted concurrent Explore route fee, minimum FTH$0.10 before equipment discounts.',
          ...(activityEquipmentDiscount(game, 'investigation') ? [`Equipped gear reduces investigation fees by ${activityEquipmentDiscount(game, 'investigation')}%. Paid jobs stay unchanged.`] : []),
          'Investigate and Explore share a 1x, 2x, 4x, 8x... route fee multiplier. Each active field team doubles the next fee at departure.']),
        weeks: cost.weeks, residents: 2 };
    }
    case 'dispatch-squad': {
      const plan = planSquad(game, state.workforce, command.activity, command.quantity);
      return { ...quote('Dispatch squad', squadItems[command.item].name, {},
        ['Consumes one voucher for the displayed missions only. Cancellation or failure consumes nothing.',
          'Targets are chosen automatically within your current reach. Two available residents are assigned per mission.',
          'Investigate and Explore share a 1x, 2x, 4x, 8x... route fee multiplier. Each active field team doubles the next fee at departure.',
          'Exploration avoids destinations already covered by active or selected surveys. Terrain is revealed only on return.',
          ...(command.activity === 'investigation' ? ['Two idle residents return after one game week. Known terrain is not expanded.',
            '10% chance of one permit: 90% one-week tier, 10% four-week tier. No keepsakes or high-tier items.'] : []),
          'Squad size is a maximum. Available residents, funds and destinations can reduce the dispatched count.']),
        costs: [{ asset: command.item, amount: 1 }, { asset: 'dollars', amount: plan.dollarsUnits / dollarsScale }],
        subject: `${plan.missions.length} / ${squadItems[command.item].quantity} ${command.activity === 'exploration' ? 'exploration' : 'investigation'} missions`,
        weeks: Math.max(1, ...plan.missions.map(mission => mission.weeks)), residents: plan.workers,
        preciseDollars: true,
        ...(plan.missions.length !== command.quantity ? { warning: 'Squad requirements changed. Review the squad and try again.' } : {}) };
    }
    case 'invite':
      return { ...quote('Recruit residents', 'Residents', { dollars: state.recruitmentDollars },
        ['Payment is made now. Residents arrive after one full game week.',
          'Season, daily weather and temperature affect new recruitment. The paid arrival count is locked at departure.',
          ...(activityEquipmentDiscount(game, 'attraction') ? [`Equipped gear reduces attraction fees by ${activityEquipmentDiscount(game, 'attraction')}%. Paid jobs stay unchanged.`] : [])]), weeks: 1,
        arrivals: recruitmentAmount(game.population, constructionLevel(game, 'housing'), state.physicalVersion ? state.serverTime : undefined) };
    case 'max-upgrade': {
      const plan = maxUpgradePlan(state, command.target);
      return { title: 'Max upgrade', subject: gameConsumption(state, command.target)?.subject ?? 'Master Builder Charter',
        costs: [...amounts(plan.costs), { asset: builderCharter, amount: 1 }], weeks: 0,
        notes: [`${plan.count} upgrades · Final level: ${plan.finalLevel}`,
          ...(command.target.type === 'upgrade' && plan.count ? [`Final tier: ${stages[plan.finalLevel].name}`] : []),
          'Max upgrades the selected target using current materials and dollars. Population requirements and level caps still apply. One charter is consumed only after confirmation.'],
        ...(plan.fingerprint !== command.fingerprint ? { warning: 'Upgrade requirements changed. Review the maximum upgrade again.' } : {}) };
    }
    case 'refine-equipment': {
      const refinement = enhancementQuote(game, state.inventory, command.target);
      return { title: 'Review enhancement', subject: refinement.item ? itemName(refinement.item) : 'Enhanced equipment', weeks: 0,
        costs: [...amounts(refinement.cost), { asset: 'refinement-core', amount: refinement.cores }],
        details: [
          { label: 'Current level', value: String(refinement.level) },
          { label: 'Success chance', value: `${refinement.chance}%` },
          { label: 'Current savings', value: `${refinement.discount.toFixed(2)}%` },
          { label: 'On success', value: `${refinement.nextDiscount.toFixed(2)}%` },
          ...(refinement.target !== refinement.item ? [{ label: 'Equipment ID', value: refinement.target }] : []),
        ],
        warning: refinement.fingerprint !== command.fingerprint ? 'Enhancement requirements changed. Review again.' : refinement.reason ?? 'Failure consumes all listed costs. Equipment and level are retained.',
        notes: ['One attempt only. The server determines the result after confirmation.',
          'Each successful level adds 0.1% of the original discount, not 0.1 percentage points. Savings are capped at 99%.',
          'Enhanced copies keep their identity and level when traded. New actions only; paid jobs stay unchanged.'] };
    }
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
    case 'craft':
      return { ...quote('Craft', `${command.quantity ?? 1} × ${itemName(command.item)}`, craftingCost(command.item, command.quantity)),
        costs: [...amounts(craftingCost(command.item, command.quantity)),
          ...Object.entries(craftingInputs(command.item, command.quantity)).map(([asset, amount]) => ({ asset: asset as MarketAsset, amount }))],
        receives: [{ asset: command.item, amount: command.quantity ?? 1 }],
        notes: [...(bulkCraftingPermit(command.quantity ?? 1) ? ['Consumes one matching bulk crafting permit for this exact batch. Cancellation or failure consumes nothing.'] : []),
          ...(isTransportItem(command.item) ? [transportBenefit(command.item)]
          : isBulkCraftingItem(command.item) ? ['Consumes unused decorations and collector permits permanently. Use this permit when choosing an exact bulk batch after clicking Craft.']
          : isActivityEquipment(command.item) ? [
          'Consumes unused decorations and collector permits permanently. Placed decorations, active timers, pending finds and market escrow cannot be used.',
          `${activityEquipmentBenefit(command.item)}. Equip one item per activity; discounts do not stack.`,
          'Equipment is permanent and affects new manual and automatic jobs only. Crafting does not equip it automatically.',
        ] : Object.keys(craftingIngredients(command.item)).length ? ['Collector recipes consume owned permits, not active automation time or market escrow. Total collection time is preserved.'] : [])] };
    case 'diplomacy':
      if (command.action === 'gift') return quote('Send goodwill shipment', 'Evergreen Union', diplomacyCosts.gift);
      if (command.action === 'form') return quote('Found federation', 'Verdant Federation', diplomacyCosts.form);
      return null;
    default: return null;
  }
}
export function marketConsumption(command: MarketCommand, state?: Snapshot, market?: MarketSnapshot): ConsumptionQuote | null {
  if (command.type === 'enhancement-list' || command.type === 'enhancement-buy' || command.type === 'enhancement-cancel') {
    const equipment = command.type === 'enhancement-list' ? state?.inventory.enhancedEquipment?.find(copy => copy.id === command.equipmentId)
      : market?.enhancedListings?.find(listing => listing.id === command.listingId)?.equipment;
    return { title: command.type === 'enhancement-list' ? 'List enhanced equipment' : command.type === 'enhancement-buy' ? 'Buy enhanced equipment' : 'Cancel equipment listing',
      subject: equipment ? itemName(equipment.item) : 'Enhanced equipment', weeks: 0,
      costs: command.type === 'enhancement-buy' ? [{ asset: 'dollars', amount: command.price }] : [],
      details: [...(equipment ? [{ label: 'Level', value: String(equipment.level) }] : []),
        ...(equipment ? [{ label: 'Equipment ID', value: equipment.id }] : []),
        ...(command.type === 'enhancement-list' ? [{ label: 'Asking price', value: `FTH$ ${formatDollars(command.price, 'en-US')}` }] : [])],
      notes: [command.type === 'enhancement-list' ? 'The exact copy is reserved until sold or cancelled. No system-funded purchases.'
        : command.type === 'enhancement-buy' ? 'Transfers this exact copy and its level. The seller receives existing FTH$.'
          : 'Returns the reserved equipment with its identity and level unchanged.'] };
  }
  if (command.type === 'auto-craft') return null;
  if (command.type === 'profit-analysis') return {
    title: 'Latest profit analysis', subject: 'Crafting', weeks: 0, costs: [{ asset: 'dollars', amount: marketAnalysisFee }],
    notes: ['Purchases a full-market snapshot for one output copy of each craftable item. Access expires after one game day.',
      'Includes crafting fees and executable purchase quotes for every ingredient. The FTH$100 report fee is separate from per-item profit.',
      'Each explicit refresh costs FTH$100. Quotes are not reserved; prices and liquidity can change. No guaranteed profit.'],
  };
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
