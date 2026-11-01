import { canAfford, GameError, note, pay, radius } from '../src/engine.ts';
import { terrainDetails, terrainResources } from '../src/engine.ts';
import type { Resource, Terrain } from '../src/engine.ts';
import { craftableItems, decorationItems, decorationSpaces, inventoryUsed, isVisibilityItem, itemStorage, placedSlot, recipeDiscovered, visibilityItems } from '../src/items.ts';
import type { Collectible, CraftableItem, DecorationItem, DecorationSlot, ItemInventory, VisibilityItem } from '../src/items.ts';
import type { Account } from './economy.ts';
import { arrangementError, cellKey, legacySpaceCells, positionEntries, settlementEntityName, settlementPositions } from '../src/settlement-layout.ts';
import type { GridPosition, SettlementEntity } from '../src/settlement-layout.ts';
import { collectionDurations } from '../src/collection.ts';
import { activityKinds, isAutomationItem } from '../src/automation.ts';
import type { ExplorationFind } from '../src/items.ts';

export function inventory(account: Account): ItemInventory {
  if (!account.inventory) {
    const items: VisibilityItem[] = account.game.light >= 2 ? ['torch', 'lamp'] : account.game.light ? ['torch'] : [];
    account.inventory = { version: 1, storage: 0, items, pending: [], equipped: items.at(-1) ?? null };
  }
  account.inventory.placements ??= {};
  const positions = settlementPositions(account.game, account.inventory);
  account.inventory.layout ??= { version: 1, positions: {} };
  Object.assign(account.inventory.layout.positions, positions);
  account.game.visibilityRadius = account.inventory.equipped ? visibilityItems[account.inventory.equipped].radius : 4;
  return account.inventory;
}
export function craft(account: Account, item: CraftableItem): string {
  const bag = inventory(account), game = account.game;
  if (game.stage < 0) throw new GameError('Establish a settlement before crafting.');
  if (inventoryUsed(bag) >= itemStorage[bag.storage].capacity) throw new GameError('Item inventory is full. Upgrade item storage first.');
  if (!recipeDiscovered(game, item)) throw new GameError('Explore the ingredient resources before crafting this item.');
  const recipe = craftableItems[item];
  if (!canAfford(game, recipe.cost)) throw new GameError('Not enough resources to craft this item.');
  pay(game, recipe.cost);
  bag.items.push(item);
  if (isVisibilityItem(item) && visibilityItems[item].radius > radius(game)) bag.equipped = item;
  inventory(account);
  return note(game, `Crafted ${recipe.name}. It is now in your item inventory.`);
}
export function decorate(account: Account, slot: DecorationSlot, item: DecorationItem | null): string {
  const bag = inventory(account), placements = bag.placements ??= {};
  if (account.game.stage < 0) throw new GameError('Establish a settlement before decorating.');
  if (item === null) {
    if (!placements[slot]) throw new GameError('No decoration is placed in this space.');
    delete bag.layout!.positions[placements[slot]];
    delete placements[slot];
    return note(account.game, `Cleared ${decorationSpaces[slot].name}. Your decoration stays in inventory.`);
  }
  if (!bag.items.includes(item)) throw new GameError('Craft this decoration before placing it.');
  if (placements[slot] === item) throw new GameError('This decoration is already placed here.');
  const cell = legacySpaceCells[slot], replaced = placements[slot];
  if (positionEntries(bag.layout!.positions).some(([id, position]) => id !== item && id !== replaced && cellKey(position) === cellKey(cell))) throw new GameError('That cell is occupied. Choose an empty cell.');
  if (replaced) delete bag.layout!.positions[replaced];
  const previous = placedSlot(bag, item);
  if (previous) delete placements[previous];
  placements[slot] = item;
  bag.layout!.positions[item] = { ...cell };
  return note(account.game, `Placed ${decorationItems[item].name} in ${decorationSpaces[slot].name}.`);
}
export function arrange(account: Account, entity: SettlementEntity, position: GridPosition | null): string {
  const bag = inventory(account), error = arrangementError(account.game, bag, entity, position);
  if (error) throw new GameError(error);
  if (position) bag.layout!.positions[entity] = { ...position };
  else delete bag.layout!.positions[entity];
  for (const slot of Object.keys(bag.placements!) as DecorationSlot[]) if (bag.placements![slot] === entity) delete bag.placements![slot];
  return note(account.game, position
    ? `Moved ${settlementEntityName(entity)} to ${position.x}, ${position.y}.`
    : `Returned ${settlementEntityName(entity)} to inventory.`);
}
export function equip(account: Account, item: VisibilityItem | null): string {
  const bag = inventory(account);
  if (item !== null && !bag.items.includes(item)) throw new GameError('Craft or collect this item before equipping it.');
  bag.equipped = item;
  inventory(account);
  return note(account.game, item ? `Equipped ${visibilityItems[item].name}. Visibility applies to future expeditions.` : 'Visibility equipment removed.');
}
export function expandInventory(account: Account): string {
  const bag = inventory(account), next = itemStorage[bag.storage + 1];
  if (account.game.stage < 0) throw new GameError('Establish a settlement before expanding item storage.');
  if (!next) throw new GameError('Item storage is already at maximum capacity.');
  if (account.game.stock.metal < next.metal) throw new GameError('Not enough metal to expand item storage.');
  pay(account.game, { metal: next.metal, dollars: next.dollars });
  bag.storage++;
  return note(account.game, `Item storage upgraded to ${next.name}.`);
}
export function findCollectible(account: Account, terrain: Terrain): void {
  const bag = inventory(account), id: Collectible = `relic-${terrain}`;
  if (bag.items.includes(id) || bag.pending.includes(id) || bag.marketSelling?.includes(id)) return;
  if (!bag.marketReserved?.includes(id) && inventoryUsed(bag) < itemStorage[bag.storage].capacity) bag.items.push(id);
  else bag.pending.push(id);
}
export function findCollectionItem(account: Account, terrain: Terrain): void {
  const bag = inventory(account);
  const resource = terrainResources[terrain];
  const weeks = collectionDurations[terrainDetails[terrain].weeks - 1] ?? 1;
  const item: ExplorationFind = `collection-${resource}-${weeks}`;
  if (inventoryUsed(bag) < itemStorage[bag.storage].capacity) bag.items.push(item);
  else bag.pending.push(item);
}
export function findActivityItem(account: Account, terrain: Terrain): void {
  const bag = inventory(account);
  const activity = activityKinds[Object.keys(terrainDetails).indexOf(terrain) % activityKinds.length];
  const weeks = collectionDurations[terrainDetails[terrain].weeks - 1]!;
  const item: ExplorationFind = `activity-${activity}-${weeks}`;
  if (inventoryUsed(bag) < itemStorage[bag.storage].capacity) bag.items.push(item);
  else bag.pending.push(item);
}
export function collectFinds(account: Account): string {
  const bag = inventory(account), room = itemStorage[bag.storage].capacity - inventoryUsed(bag);
  if (!bag.pending.length) throw new GameError('No pending finds to collect.');
  if (room <= 0) throw new GameError('Item inventory is full. Upgrade item storage first.');
  const collected = bag.pending.filter(id => isAutomationItem(id) || !bag.marketReserved?.includes(id)).slice(0, room);
  if (!collected.length) throw new GameError('Pending finds are reserved by open market orders. Cancel the order first.');
  for (const id of collected) bag.pending.splice(bag.pending.indexOf(id), 1);
  bag.items.push(...collected);
  return note(account.game, `Collected ${collected.length} exploration finds into item inventory.`);
}
