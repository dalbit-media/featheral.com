"use strict";
const { canonical } = require("../fth-ledger/codec");

// Additions are pinned independently of gameplay tuning; existing genesis targets never change.
const decorationPrices = Object.freeze({
  logseat: 19, flowerbed: 32, fence: 60, birdhouse: 33, trellis: 83, barrel: 118,
  picnic: 140, arch: 131, swing: 144, gazebo: 358, clocktower: 358, monument: 155,
  streetlamp: 264, kiosk: 224, pavilion: 544, greenhouse: 470, sculpture: 361,
  tramstop: 678, solar: 864, verticalgarden: 448, observatory: 1344, lightspire: 1568,
  biodome: 2272, skybeacon: 2528,
});
const equipmentPrices = Object.freeze({
  "survey-satchel": 350, "survey-station": 1500, "survey-array": 4500,
  "trail-kit": 500, "trail-outpost": 1800, "trail-network": 5500,
  "welcome-kit": 450, "welcome-pavilion": 2200, "welcome-network": 4800,
});
const bulkCraftingPrices = Object.freeze({
  "craft-batch-10": 350, "craft-batch-20": 850, "craft-batch-50": 1800, "craft-batch-100": 3500,
});
const approvedMarkets = Object.fromEntries([
  ...Object.entries({
    "permit-settlement-name": 112, "permit-region-name": 184,
    "title-pioneer": 72, "title-explorer": 86, "title-steward": 96,
    "title-artisan": 120, "title-trader": 89, "title-naturalist": 128,
    ...decorationPrices,
    ...equipmentPrices,
    ...bulkCraftingPrices,
  }),
  ...["wood", "water", "metal", "oil", "all"].flatMap(resource =>
    Object.entries({ 4: 180, 12: 420, 26: 840, 52: 1620 }).map(([weeks, price]) =>
      [`collector-${resource}-${weeks}`, price * (resource === "all" ? 4 : 1)])),
].map(([asset, price]) => [asset, Object.freeze({ quantity: 10000, pricePerLot: (BigInt(price) * 10n ** 18n).toString() })]));
for (const [price, terrains] of [
  [90, ["forest", "meadow", "water", "oil", "grassland", "savanna", "river", "coast", "hills"]],
  [120, ["mountain", "lithium", "rainforest", "pineforest", "mangrove", "desert", "dunes", "wetland", "canyon", "tundra"]],
  [150, ["volcano", "glacier"]],
]) for (const terrain of terrains)
  approvedMarkets[`relic-${terrain}`] = Object.freeze({ quantity: 100, pricePerLot: (BigInt(price) * 10n ** 18n).toString() });
Object.freeze(approvedMarkets);

function approvedMarketExpansion(previous, next) {
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object"
    || Array.isArray(previous) || Array.isArray(next) || !Object.keys(previous).length) return false;
  if (Object.entries(previous).some(([asset, target]) =>
    !Object.hasOwn(next, asset) || canonical(target) !== canonical(next[asset]))) return false;
  const additions = Object.keys(next).filter(asset => !Object.hasOwn(previous, asset));
  return additions.length > 0 && additions.every(asset =>
    Object.hasOwn(approvedMarkets, asset) && canonical(next[asset]) === canonical(approvedMarkets[asset]));
}
module.exports = { approvedMarkets, approvedMarketExpansion, decorationPrices, equipmentPrices, bulkCraftingPrices };
