import { randomInt, randomUUID } from 'node:crypto';
import { GameError, note, pay } from '../src/engine.ts';
import { enhancementQuote } from '../src/enhancement.ts';
import type { EquipmentActivity } from '../src/activity-equipment.ts';
import { activityEquipmentItems } from '../src/activity-equipment.ts';
import { inventory } from './inventory.ts';
import type { Account } from './economy.ts';

export function refineEquipment(account: Account, target: string, fingerprint: string,
  random: () => number = () => randomInt(1_000_000) / 1_000_000): string {
  const bag = inventory(account), quote = enhancementQuote(account.game, bag, target);
  if (quote.fingerprint !== fingerprint) throw new GameError('Refinement quote changed. Refresh and confirm again.');
  if (!quote.eligible || !quote.item) throw new GameError(quote.reason ?? 'Invalid refinement target.');
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new GameError('Invalid refinement randomness.');
  pay(account.game, quote.cost);
  bag.items.splice(bag.items.indexOf('refinement-core'), 1);
  const copies = bag.enhancedEquipment ??= [];
  let copy = copies.find(copy => copy.id === target);
  if (!copy) {
    bag.items.splice(bag.items.indexOf(quote.item), 1);
    copy = { id: randomUUID(), item: quote.item, level: 0 };
    copies.push(copy);
  }
  const success = roll * 100 < quote.chance;
  if (success) copy.level++;
  inventory(account);
  return note(account.game, success
    ? `Refinement succeeded. ${activityEquipmentItems[copy.item].name} is now +${copy.level}.`
    : `Refinement failed. ${activityEquipmentItems[copy.item].name} remains +${copy.level}; your equipment is safe.`);
}
export function equipEnhanced(account: Account, activity: EquipmentActivity, id: string | null): string {
  const bag = inventory(account);
  const copy = bag.enhancedEquipment?.find(copy => copy.id === id);
  if (id !== null && (!copy || activityEquipmentItems[copy.item].activity !== activity))
    throw new GameError('Own matching enhanced equipment before equipping it.');
  if (id === null && !bag.enhancedEquipped?.[activity]) throw new GameError('Enhanced equipment selection is unchanged.');
  if (id !== null && bag.enhancedEquipped?.[activity] === id) throw new GameError('Enhanced equipment selection is unchanged.');
  const equipped = bag.enhancedEquipped ??= {};
  if (id === null) delete equipped[activity];
  else {
    equipped[activity] = id;
    if (bag.activityEquipment) delete bag.activityEquipment[activity];
  }
  inventory(account);
  return note(account.game, id === null ? `Removed ${activity} equipment.` : 'Enhanced equipment equipped. Discounts apply to new activity only.');
}
