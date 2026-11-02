"use strict";
const UNIT = 10n ** 18n;
const GOLD_TOKEN = "0xba658127d93b17e577e1b8e8995cab3ae7d7c665";
function dollarReference(pool) {
  if (!pool || pool.error || pool.priceError || pool.pendingSettlement || pool.paused) return null;
  if (pool.funded === true && typeof pool.dollars === "string" && /^\d+$/.test(pool.dollars)
    && BigInt(pool.dollars) > 0n && Number.isSafeInteger(pool.fthx) && pool.fthx > 0)
    return { dollars: BigInt(pool.dollars), fthx: BigInt(pool.fthx), source: "exchange" };
  if (pool.funded === false && pool.version === 0 && pool.dollars === "0" && pool.fthx === 0)
    return { dollars: UNIT, fthx: 100n, source: "opening" };
  return null;
}
function publicReference(pool) {
  const rate = dollarReference(pool);
  return rate ? { numerator: (rate.fthx * UNIT).toString(), denominator: rate.dollars.toString(),
    currency: "FTHX", source: rate.source, indicative: rate.source === "opening" } : null;
}
function goldReference(gold, now = Date.now()) {
  const bridge = gold?.bridge, time = Date.parse(gold?.checkedAt);
  const reserve = gold?.goldReserve;
  const amount = value => typeof value === "string" && /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** 256n;
  if (!gold?.error && !gold?.priceError && !gold?.pendingSettlement && gold?.chain?.id === 1
    && typeof gold.chain.tokenAddress === "string" && gold.chain.tokenAddress.toLowerCase() === GOLD_TOKEN && time >= now - 60000 && time <= now + 30000
    && reserve?.enabled === true && reserve.initialized === true && typeof reserve.tokenAddress === "string" && reserve.tokenAddress.toLowerCase() === GOLD_TOKEN
    && amount(reserve.rate) && BigInt(reserve.rate) > 0n && amount(reserve.cap) && BigInt(reserve.cap) > 0n
    && amount(reserve.allocated) && amount(reserve.remaining) && BigInt(reserve.cap) === BigInt(reserve.allocated) + BigInt(reserve.remaining)
    && /^0x[0-9a-f]{64}$/i.test(reserve.genesisHash || "")
    && Number.isSafeInteger(reserve.evidence?.block) && reserve.evidence.block >= 0 && /^0x[0-9a-f]{64}$/i.test(reserve.evidence?.hash || ""))
  {
    if (reserve.pricingPolicy !== undefined) {
      if (reserve.pricingPolicy !== "origin-linear-v1" || !amount(reserve.recycledIn) || !amount(reserve.released)
        || !amount(reserve.spotRateFthDollarPerFthg)) return null;
      const net = BigInt(reserve.allocated) + BigInt(reserve.recycledIn) - BigInt(reserve.released);
      if (net < 0n || net > BigInt(reserve.cap)) return null;
      const spot = require("../../shared/gold-pricing").spot(reserve);
      if (spot !== BigInt(reserve.spotRateFthDollarPerFthg)) return null;
      return { fthg: UNIT, dollars: spot, source: "native-reserve" };
    }
    return { fthg: UNIT, dollars: BigInt(reserve.rate) * UNIT, source: "native-reserve" };
  }
  if (gold?.error || gold?.priceError || gold?.pendingSettlement || bridge?.error || bridge?.priceError || bridge?.pendingSettlement
    || gold?.chain?.id !== 1 || !(time >= now - 60000 && time <= now + 30000)
    || bridge?.configured === false || bridge?.deployed !== true || bridge?.paused !== false
    || gold.chain.tokenAddress !== undefined && (typeof gold.chain.tokenAddress !== "string" || gold.chain.tokenAddress.toLowerCase() !== GOLD_TOKEN)) return null;
  if (![bridge.reserveFthg, bridge.reserveFthDollar, bridge.actualFthgBalance].every(amount)) return null;
  const fthg = BigInt(bridge.reserveFthg), dollars = BigInt(bridge.reserveFthDollar), custody = BigInt(bridge.actualFthgBalance);
  if (bridge.initialized === true && fthg > 0n && dollars > 0n && custody >= fthg)
    return { fthg, dollars, source: "bridge" };
  // poolInitialized cannot revert to false: explicit empty on-chain state is the only opening reference.
  if (bridge.configured === true && gold.chain.tokenAddress?.toLowerCase() === GOLD_TOKEN
    && bridge.initialized === false && fthg === 0n && dollars === 0n && custody === 0n
    && bridge.totalStakedFthg === "0" && bridge.spotRateFthDollarPerFthg === "0")
    return { fthg: UNIT, dollars: 10000n * UNIT, source: "opening" };
  return null;
}
function publicGoldReference(rate) {
  return rate ? { numerator: (rate.dollars * UNIT).toString(), denominator: rate.fthg.toString(),
    currency: "FTH$", decimals: 18, source: rate.source, indicative: rate.source === "opening" } : null;
}
module.exports = { dollarReference, publicReference, goldReference, publicGoldReference };
