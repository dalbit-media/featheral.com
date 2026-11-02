"use strict";
((root, factory) => {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FeatheralPortfolio = factory();
})(typeof window === "object" ? window : globalThis, () => {
  function combine(accounts) {
    const seen = new Set(), unique = accounts.filter(account => {
      const address = account.address.toLowerCase();
      if (seen.has(address)) return false;
      seen.add(address); return true;
    });
    const worlds = new Set(unique.map(account => "0x000000000000000000000000" + account.address.slice(2).toLowerCase()));
    const normalized = unique.map(account => {
      const worldId = account.world?.accountId?.toLowerCase();
      if (!worldId || account.world.duplicate) return account;
      if (!worlds.has(worldId)) { worlds.add(worldId); return account; }
      const portfolio = account.portfolio;
      const subtract = (value, world) => value === null ? null : (BigInt(value) - BigInt(world || "0")).toString();
      return { ...account, portfolio: { ...portfolio,
        totals: Object.fromEntries(Object.entries(portfolio.totals).map(([symbol, value]) => [symbol,
          { ...value, value: subtract(value.value, portfolio.worldEstimates[symbol]) }])),
        fthg: subtract(portfolio.fthg, portfolio.worldEstimates.FTHG),
        usdValue: subtract(portfolio.usdValue, portfolio.worldUsdValue),
        pricedFthDollar: subtract(portfolio.pricedFthDollar, portfolio.worldFthDollar) } };
    });
    const totals = {};
    for (const symbol of ["FTHG", "FTH$", "FTHX"]) {
      let sum = 0n; const unpriced = [];
      for (const account of normalized) {
        const value = account.portfolio.totals[symbol];
        sum += BigInt(value.value);
        unpriced.push(...value.unpriced.map(item => `${account.address.slice(0, 6)}: ${item}`));
      }
      totals[symbol] = { value: sum.toString(), decimals: 18, partial: !!unpriced.length, unpriced };
    }
    let usd = 0n, fthg = 0n, hasUsd = false, hasGold = false;
    for (const { portfolio } of normalized) {
      if (portfolio.usdValue != null || portfolio.usd !== null) {
        usd += portfolio.usdValue != null ? BigInt(portfolio.usdValue) : BigInt(portfolio.usd.replace(".", "")) * 10n ** 16n;
        hasUsd = true;
      }
      if (portfolio.fthg !== null) { fthg += BigInt(portfolio.fthg); hasGold = true; }
    }
    return { ...unique[0].portfolio, totals, usd: hasUsd ? `${usd / 10n ** 18n}.${(usd / 10n ** 16n % 100n).toString().padStart(2, "0")}` : null,
      usdValue: hasUsd ? usd.toString() : null,
      fthg: hasGold ? fthg.toString() : null, pricedFthDollar: normalized.reduce((sum, account) => sum + BigInt(account.portfolio.pricedFthDollar), 0n).toString(),
      partial: unique.some(account => account.portfolio.partial || account.portfolio.usd === null),
      unpriced: unique.flatMap(account => account.portfolio.unpriced),
      usdUnpriced: unique.flatMap(account => account.portfolio.usdUnpriced || []),
      source: "Combined linked accounts; funds remain separate. " + unique[0].portfolio.source };
  }
  return { combine };
});
