"use strict";
function portfolio(holdings, dollarPool, markets, gold = null, extra = {}) {
  const prices = new Map(markets.map(market => [market.symbol, market]));
  const rate = require("./exchange-price").dollarReference(dollarPool), routeReady = !!rate;
  let total = 0n;
  const assets = holdings.map(asset => {
    let value = null;
    if (BigInt(asset.balance) === 0n) value = 0n;
    else if (asset.symbol === "FTH$") value = BigInt(asset.balance);
    else if (routeReady) {
      const market = prices.get(asset.symbol);
      if (asset.symbol === "FTHX") value = BigInt(asset.balance) * rate.dollars / rate.fthx;
      else if (market?.funded && !market.reserved && market.price) value = BigInt(asset.balance) * BigInt(market.price.numerator)
        * rate.dollars / (BigInt(market.price.denominator) * rate.fthx);
    }
    if (value !== null) total += value;
    return { ...asset, fthDollarValue: value?.toString() ?? null,
      unpricedReason: value !== null ? null : !routeReady ? "FTH$/FTHX market is unfunded." : "No funded public FTHX pair." };
  });
  const world = extra.world && !extra.world.duplicate ? BigInt(extra.world.available) : 0n;
  total += world;
  const now = Date.now(), usdTime = Date.parse(gold?.usdMarket?.updatedAt);
  const goldRate = require("./exchange-price").goldReference(gold, now), goldReady = !!goldRate;
  const ethereumTime = Date.parse(extra.ethereum?.checkedAt);
  const ethereumReady = extra.ethereum?.chainId === 1
    && extra.ethereum.token?.toLowerCase() === "0xba658127d93b17e577e1b8e8995cab3ae7d7c665"
    && ethereumTime >= now - 60000 && ethereumTime <= now + 30000 && /^\d+$/.test(extra.ethereum.balance);
  const ethereum = ethereumReady ? BigInt(extra.ethereum.balance) : null;
  const internalFthg = goldReady ? total * goldRate.fthg / goldRate.dollars : total === 0n ? 0n : null;
  let fthg = internalFthg !== null ? internalFthg + (ethereum || 0n) : ethereum;
  const usdPrice = !gold?.error && !gold?.usdMarket?.error && usdTime >= now - 300000 && usdTime <= now + 30000
    && typeof gold?.usdMarket?.usdPerFthg === "string" && /^[1-9]\d{0,77}$/.test(gold.usdMarket.usdPerFthg)
    && (gold.usdMarket.token === undefined || typeof gold.usdMarket.token === "string"
      && gold.usdMarket.token.toLowerCase() === "0xba658127d93b17e577e1b8e8995cab3ae7d7c665")
    ? gold.usdMarket.usdPerFthg : null;
  let usdValue = fthg !== null && usdPrice ? fthg * BigInt(usdPrice) / 10n ** 18n : null;
  const usdUnpriced = [];
  if (total > 0n && (internalFthg === null || !usdPrice)) usdUnpriced.push("Internal assets USD unavailable");
  if (ethereum > 0n && !usdPrice) usdUnpriced.push("Ethereum FTHG USD unavailable");
  const unpriced = assets.filter(asset => asset.fthDollarValue === null).map(asset => asset.symbol);
  if (internalFthg === null && ethereum !== null) unpriced.push("Internal assets in FTHG");
  if (extra.ethereumError || extra.ethereum && !ethereumReady) unpriced.push("Ethereum FTHG balance unavailable");
  if (extra.worldError) unpriced.push("World funds unavailable");
  const unit = 10n ** 18n;
  const convertDollar = (amount, symbol) => symbol === "FTH$" ? amount
    : symbol === "FTHX" ? routeReady ? amount * rate.fthx * unit / rate.dollars : amount === 0n ? 0n : null
    : goldReady ? amount * goldRate.fthg / goldRate.dollars : amount === 0n ? 0n : null;
  const nativePriceTime = Date.parse(extra.native?.market?.updatedAt);
  const nativePrice = nativePriceTime >= now - 300000 && nativePriceTime <= now + 30000
    && /^[1-9]\d*$/.test(extra.native?.market?.usdPerEth) ? BigInt(extra.native.market.usdPerEth) : null;
  const nativeAssets = [], seenChains = new Set();
  for (const asset of extra.native?.balances || []) {
    if (![1, 8453, 42161, 10, 324, 59144].includes(asset.chainId) || seenChains.has(asset.chainId)) continue;
    seenChains.add(asset.chainId);
    const time = Date.parse(asset.checkedAt), valid = !asset.error && /^\d{1,78}$/.test(asset.balance) && BigInt(asset.balance) < 2n ** 256n
      && time >= now - 60000 && time <= now + 30000;
    if (!valid) { unpriced.push(`${asset.name} ETH unavailable`); nativeAssets.push({ ...asset, balance: null, estimates: {} }); continue; }
    const raw = BigInt(asset.balance), usd = nativePrice ? raw * nativePrice / (10n ** 18n) : raw === 0n ? 0n : null;
    const nativeGold = usd !== null && usdPrice && BigInt(usdPrice) > 0n ? usd * 10n ** 18n / BigInt(usdPrice) : raw === 0n ? 0n : null;
    const nativeDollar = nativeGold !== null && goldReady ? nativeGold * goldRate.dollars / goldRate.fthg : raw === 0n ? 0n : null;
    const estimates = { FTHG: nativeGold?.toString() ?? null, "FTH$": nativeDollar?.toString() ?? null,
      FTHX: nativeDollar !== null ? convertDollar(nativeDollar, "FTHX")?.toString() ?? null : null };
    if (raw > 0n) {
      if (usd === null) unpriced.push(`${asset.name} ETH price unavailable`);
      else usdValue = (usdValue || 0n) + usd;
      if (nativeGold !== null) fthg = (fthg || 0n) + nativeGold;
      else unpriced.push(`${asset.name} ETH in FTHG`);
    }
    nativeAssets.push({ ...asset, estimates, usdValue: usd?.toString() ?? null,
      usd: usd !== null ? `${usd / 10n ** 18n}.${(usd % 10n ** 18n).toString().padStart(18, "0").slice(0, 2)}` : null });
  }
  if (extra.native) {
    for (const [chainId, name] of [[1, "Ethereum"], [8453, "Base"], [42161, "Arbitrum One"], [10, "Optimism"], [324, "zkSync Era"], [59144, "Linea"]]) {
      if (!seenChains.has(chainId)) {
        unpriced.push(`${name} ETH unavailable`);
        nativeAssets.push({ chainId, name, symbol: "ETH", decimals: 18, balance: null, estimates: {} });
      }
    }
  }
  const estimates = (asset, symbol) => {
    if (BigInt(asset.balance) === 0n) return 0n;
    if (asset.symbol === "FTHG" || prices.get(asset.symbol)?.reserved) return null;
    if (asset.symbol === symbol) return BigInt(asset.balance) * (symbol === "FTHX" ? unit : 1n);
    if (symbol === "FTHX") {
      const market = prices.get(asset.symbol);
      if (market?.funded && !market.reserved && market.price)
        return BigInt(asset.balance) * BigInt(market.price.numerator) * unit / BigInt(market.price.denominator);
    }
    return asset.fthDollarValue === null ? null : convertDollar(BigInt(asset.fthDollarValue), symbol);
  };
  const totals = {}, ethereumEstimates = {}, worldEstimates = {};
  for (const symbol of ["FTHG", "FTH$", "FTHX"]) {
    let value = 0n;
    const missing = [];
    for (const asset of assets) {
      const estimate = estimates(asset, symbol);
      if (estimate === null) missing.push(asset.symbol); else value += estimate;
      (asset.estimates ||= {})[symbol] = estimate?.toString() ?? null;
    }
    const worldValue = convertDollar(world, symbol);
    worldEstimates[symbol] = worldValue?.toString() ?? null;
    if (worldValue === null) missing.push("World funds"); else value += worldValue;
    if (ethereum !== null) {
      const ethereumValue = symbol === "FTHG" ? ethereum : goldReady
        ? convertDollar(ethereum * goldRate.dollars / goldRate.fthg, symbol) : ethereum === 0n ? 0n : null;
      ethereumEstimates[symbol] = ethereumValue?.toString() ?? null;
      if (ethereumValue === null) missing.push("Ethereum FTHG"); else value += ethereumValue;
    }
    if (extra.ethereumError || extra.ethereum && !ethereumReady) missing.push("Ethereum FTHG unavailable");
    if (extra.worldError) missing.push("World funds unavailable");
    for (const asset of nativeAssets) {
      if (asset.balance === null) missing.push(`${asset.name} ETH unavailable`);
      else if (BigInt(asset.balance) > 0n) {
        const estimate = asset.estimates[symbol];
        if (estimate === null) missing.push(`${asset.name} ETH`); else value += BigInt(estimate);
      }
    }
    totals[symbol] = { value: value.toString(), decimals: 18, partial: missing.length > 0, unpriced: missing };
  }
  const usdEstimate = value => value === 0n ? "0" : value !== null && usdPrice ? (value * BigInt(usdPrice) / unit).toString() : null;
  for (const asset of assets) asset.usdValue = usdEstimate(asset.estimates.FTHG === null ? null : BigInt(asset.estimates.FTHG));
  return { assets, pricedFthDollar: total.toString(), unpriced,
    ethereumUsdValue: usdEstimate(ethereum),
    dollarReference: require("./exchange-price").publicReference(dollarPool),
    goldReference: require("./exchange-price").publicGoldReference(goldRate),
    totals, ethereumEstimates, worldEstimates, nativeAssets,
    worldFthDollar: world.toString(), ethereumFthg: ethereum?.toString() ?? null,
    partial: unpriced.length > 0 || usdUnpriced.length > 0, usdUnpriced,
    fthg: fthg?.toString() ?? null,
    fthgUnavailableReason: goldReady || total === 0n ? null : "No verified FTHG/FTH$ reserve or initial opening reference is available; internal assets cannot be estimated in FTHG.",
    usd: usdValue !== null ? `${usdValue / 10n ** 18n}.${(usdValue / 10n ** 16n % 100n).toString().padStart(2, "0")}` : null,
    usdValue: usdValue?.toString() ?? null,
    worldUsdValue: goldReady && usdPrice ? (world * goldRate.fthg / goldRate.dollars * BigInt(usdPrice) / unit).toString() : world === 0n ? "0" : null,
    usdUnavailableReason: usdValue !== null ? null : "USD unavailable: fresh ETH/USD or FTHG/USD pricing is required; internal funds also need verified FTHG/FTH$ reserves or the initial opening reference. FTH$ is not USD.",
    usdMarket: gold?.usdMarket || null,
    source: `${rate?.source === "opening" ? "Opening indicative rate: 1 FTH$ = 100 FTHX; switches to the Exchange reserve price when funded. No executable liquidity is implied." : "Current funded Exchange pool spot ratios."}${goldRate?.source === "opening" ? " Opening indicative Gold rate: 1 FTHG = 10000 FTH$; switches to verified bridge reserves when funded. No executable liquidity is implied." : goldRate?.source === "native-reserve" ? ` Native Gold reserve valuation: 1 FTHG = ${goldRate.dollars / unit} FTH$. Allocations are obligations, not confirmed Ethereum backing or executable liquidity.` : ""}${usdPrice && gold.usdMarket.source ? ` USD: ${gold.usdMarket.source}.` : ""} Estimates exclude fees, slippage and unpriced assets. FTH$ is not USD. Not a redemption guarantee.`,
    goldCheckedAt: goldReady ? gold.checkedAt : null, checkedAt: new Date().toISOString() };
}
module.exports = { portfolio };
