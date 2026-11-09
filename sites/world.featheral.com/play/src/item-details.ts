import { isDecorationItem, isVisibilityItem, visibilityItems } from './items.ts';
import type { ItemId } from './items.ts';
import { activityEquipmentBenefit, isActivityEquipment } from './activity-equipment.ts';
import { isSquadItem } from './exploration-squads.ts';
import { isTransportItem, transportBenefit } from './transport-items.ts';
import { bulkCraftingItems, isBulkCraftingItem } from './bulk-crafting.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, isActivityItem } from './automation.ts';
import { isCustomizationItem } from './customization.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { escapeAtlas } from './atlas.ts';

export function itemDescription(id: ItemId): { category: string; effect: string; use: string } {
  if (isSquadItem(id)) return { category: 'Squad vouchers', effect: 'Automatic targets. Two residents per mission. Existing concurrency fees apply.',
    use: 'Click Explore or Investigate to choose an owned squad voucher. One voucher is consumed only after confirmation.' };
  if (isTransportItem(id)) return { category: 'Transport vouchers', effect: transportBenefit(id),
    use: 'Used on resource pickup. One voucher is consumed per discounted delivery.' };
  if (isBulkCraftingItem(id)) return { category: 'Bulk crafting',
    effect: `Allows one exact batch of ${bulkCraftingItems[id].quantity} copies. Select a recipe and click Craft to use it.`,
    use: 'Consumes one matching permit plus all batch ingredients.' };
  if (isActivityEquipment(id)) return { category: 'Cost-saving equipment', effect: activityEquipmentBenefit(id),
    use: 'Equip in inventory. One item per activity. New missions only.' };
  if (isVisibilityItem(id)) return { category: 'Lighting', effect: `${visibilityItems[id].radius}-tile view`,
    use: 'Permanent visibility equipment. Equip one item; new expeditions use its reach.' };
  if (isCollectionItem(id)) return { category: 'Collectors', effect: `Auto-collection for ${collectionItemDetails(id).weeks} game weeks`,
    use: 'Activate in inventory. Collection still requires residents, storage and transport fees.' };
  if (isActivityItem(id)) return { category: 'Automation', effect: `Automation for ${activityItemDetails(id).weeks} game weeks`,
    use: 'Activate in inventory. Normal mission costs and resident requirements still apply.' };
  if (isCustomizationItem(id)) return { category: 'Names & titles', effect: 'Consumes one permit. Cosmetic only.',
    use: 'Review customization in inventory. Does not change production or progression.' };
  if (isDecorationItem(id)) return { category: 'Decorations', effect: 'Cosmetic decoration',
    use: 'Place in Layout. Move freely or return to inventory. No production bonus.' };
  return { category: 'Collectibles', effect: 'Exploration keepsake', use: 'Keep or trade this find. Collectibles trade one at a time.' };
}
export function itemDetailRows(id: ItemId, language: Language, owned?: number, reserved = 0): string {
  const description = itemDescription(id), t = (text: string) => escapeAtlas(translate(text, language));
  return `<dl class="item-facts"><div><dt>${t('Category')}</dt><dd>${t(description.category)}</dd></div>
    <div><dt>${t('Effect')}</dt><dd>${t(description.effect)}</dd></div><div><dt>${t('How to use')}</dt><dd>${t(description.use)}</dd></div>
    ${owned === undefined ? '' : `<div><dt>${t('Available copies')}</dt><dd>${owned.toLocaleString(locale(language))}${reserved ? ` · ${reserved.toLocaleString(locale(language))} ${t('Reserved in market')}` : ''}</dd></div>`}</dl>`;
}
