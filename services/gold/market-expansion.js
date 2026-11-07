"use strict";
const { canonical } = require("../fth-ledger/codec");

// This release authorizes only these identity items and time-conserving bundles.
const approvedMarkets = Object.fromEntries([
  ...Object.entries({
    "permit-settlement-name": 112, "permit-region-name": 184,
    "title-pioneer": 72, "title-explorer": 86, "title-steward": 96,
    "title-artisan": 120, "title-trader": 89, "title-naturalist": 128,
  }),
  ...["wood", "water", "metal", "oil", "all"].flatMap(resource =>
    Object.entries({ 4: 180, 12: 420, 26: 840, 52: 1620 }).map(([weeks, price]) =>
      [`collector-${resource}-${weeks}`, price * (resource === "all" ? 4 : 1)])),
].map(([asset, price]) => [asset, Object.freeze({ quantity: 10000, pricePerLot: (BigInt(price) * 10n ** 18n).toString() })]));
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
module.exports = { approvedMarkets, approvedMarketExpansion };
