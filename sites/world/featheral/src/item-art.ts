import { terrainResources } from './engine.ts';
import type { Terrain } from './engine.ts';
import { icon } from './icons.ts';
import { isDecorationItem, isVisibilityItem } from './items.ts';
import type { DecorationItem, ItemId } from './items.ts';
import { collectionItemDetails, isCollectionItem } from './collection.ts';
import { activityItemDetails, isActivityItem } from './automation.ts';

const equipmentDrawings = {
  fire: '<path d="m19 51 27 9m-29 0 29-9" stroke="#ad8053" stroke-width="6"/><path d="M32 13c4 11 15 13 12 26-2 12-23 13-25 0-1-8 9-14 13-26Z" fill="#e9b86c"/><path d="M32 32c8 10 5 15 0 15s-8-5 0-15" fill="#f3e4a0"/>',
  torch: '<path d="m30 30-7 30h8l6-30" fill="#ab8158"/><path d="M35 5c1 10 10 13 7 22s-19 10-20 1c-1-9 10-13 13-23" fill="#e9b86c"/><path d="m25 33 12 3" stroke="#e7d3a0" stroke-width="4"/>',
  lamp: '<path d="M13 44h35c0 12-10 15-18 15S13 54 13 44" fill="#c6a567"/><path d="M47 46c13-2 13-14 4-14" fill="none" stroke="#c6a567" stroke-width="4"/><path d="M24 43V31" stroke="#e5d6b1" stroke-width="3"/><path d="M27 13c7 12 10 22-2 22-10 0-4-13 2-22" fill="#f3c779"/>',
  lantern: '<path d="M24 15V9a8 8 0 0 1 16 0v6" fill="none" stroke="#c8b27b" stroke-width="3"/><path d="m19 19 6-7h14l6 7-3 7 3 28H19l3-28Z" fill="#496056" stroke="#c8b27b" stroke-width="3"/><path d="M26 27h12v22H26z" fill="#eed78e"/><path d="M17 58h30" stroke="#c8b27b" stroke-width="4"/>',
};
const decorationDrawings: Record<DecorationItem, string> = {
  planter: '<ellipse cx="32" cy="55" rx="26" ry="7" fill="#102c2030"/><path d="m8 36 24 11 25-12-2 15-23 11L10 50Z" fill="#a96c49"/><path d="m8 36 25-11 24 10-25 12Z" fill="#4a6040"/><path d="m18 35 1-15m13 19V17m14 18-2-17" stroke="#72a35c" stroke-width="3"/><g fill="#f0bd83"><circle cx="18" cy="20" r="6"/><circle cx="44" cy="19" r="6"/></g><g fill="#e9939c"><circle cx="32" cy="16" r="7"/><circle cx="24" cy="28" r="5"/></g><circle cx="40" cy="30" r="5" fill="#ede5a5"/>',
  bench: '<ellipse cx="32" cy="56" rx="28" ry="6" fill="#102c2030"/><path d="M13 32v22m34-22v22" stroke="#4b6252" stroke-width="5"/><path d="m8 34 24 10 26-12-26-9Z" fill="#d1a26d"/><path d="m10 33 23 10m0-16v14m13-9 11 4" stroke="#946c47" stroke-width="2"/><path d="M12 12v23m39-23v23" stroke="#4b6252" stroke-width="4"/><path d="m10 11 24 9 20-9v17l-20 9-24-9Z" fill="#bf8e5e"/><path d="m12 18 22 9 18-8" fill="none" stroke="#e3b67d" stroke-width="2"/>',
  banner: '<ellipse cx="32" cy="58" rx="14" ry="5" fill="#102c2030"/><path d="M25 57V7" stroke="#ddba78" stroke-width="4"/><path d="M27 9h26l-6 13 6 13H27Z" fill="#689b83"/><path d="m33 15 11 7-11 6Z" fill="#eed8a0"/><path d="m15 57 10-5 12 5-12 5Z" fill="#9ba98c"/><circle cx="25" cy="6" r="3" fill="#e9cf89"/>',
  fountain: '<ellipse cx="32" cy="54" rx="29" ry="9" fill="#102c2030"/><path d="M5 43c0 21 54 21 54 0" fill="#9fae9c"/><ellipse cx="32" cy="43" rx="27" ry="11" fill="#c8cfb4"/><ellipse cx="32" cy="43" rx="22" ry="8" fill="#7ab5b1"/><path d="M28 42V24h8v18" fill="#bac5b0"/><ellipse cx="32" cy="24" rx="15" ry="5" fill="#d2d7bd"/><path d="M21 28c-6 5-6 10-7 15m29-15c6 5 6 10 7 15M32 23V10m0 1c-8 0-8 9-8 9m8-9c8 0 8 9 8 9" stroke="#bce6d6" stroke-width="2" fill="none"/>',
  boardwalk: '<ellipse cx="32" cy="52" rx="30" ry="9" fill="#102c2030"/><path d="m2 38 29-17 31 16-29 19Z" fill="#c8a373"/><path d="m7 39 29-15m-22 19 29-15m-22 19 29-15m-22 19 29-15" stroke="#8a6c4b" stroke-width="2"/><path d="M8 40v9m48-10v9" stroke="#715e45" stroke-width="4"/>',
  canopy: '<ellipse cx="32" cy="57" rx="29" ry="6" fill="#102c2030"/><path d="M12 26v28m39-28v28" stroke="#9c754e" stroke-width="4"/><path d="m8 47 25 10 24-11v8l-24 10L8 54Z" fill="#b28b5b"/><path d="m6 22 25-13 28 12v14L31 47 6 35Z" fill="#daaa74"/><path d="m15 17 9-5 28 12-9 5Zm-8 7 27 12 8-4v11l-9 4L6 35V24Zm44 1 8-4v14l-8 4Z" fill="#e7d8ac"/><path d="m6 22 27 12 26-13" fill="none" stroke="#a98158" stroke-width="2"/>',
};
export function decorationDrawing(id: DecorationItem): string { return decorationDrawings[id]; }
export function itemArt(id: ItemId): string {
  if (isCollectionItem(id)) return `<div class="item-art collection-item-art">${icon(collectionItemDetails(id).resource)}<b>${collectionItemDetails(id).weeks}w</b></div>`;
  if (isActivityItem(id)) {
    const { activity, weeks } = activityItemDetails(id);
    return `<div class="item-art collection-item-art">${icon(activity === 'exploration' ? 'compass' : 'people')}<b>${weeks}w</b></div>`;
  }
  if (!isVisibilityItem(id) && !isDecorationItem(id)) return `<div class="item-art collectible-art">${icon(terrainResources[id.slice(6) as Terrain])}</div>`;
  const drawing = isDecorationItem(id) ? decorationDrawing(id) : equipmentDrawings[id];
  return `<div class="item-art"><svg viewBox="0 0 64 64" aria-hidden="true">${drawing}</svg></div>`;
}
