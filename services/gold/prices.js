"use strict";
const TOKEN = require("./server").TOKEN_ADDRESS.toLowerCase();
function createMarketPriceReader({ fetchPrice = fetch, clock = Date.now, logger = console } = {}) {
  let cached, at = 0, pending;
  return async () => {
    if (cached && clock() - at < 60000 && (!cached.updatedAt || clock() - Date.parse(cached.updatedAt) <= 300000)) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchPrice(`https://api.dexscreener.com/token-pairs/v1/ethereum/${TOKEN}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
        if (!response.ok) throw new Error(`FTHG market feed HTTP ${response.status}`);
        const pairs = await response.json();
        if (!Array.isArray(pairs)) throw new Error("Invalid FTHG DEX market response.");
        const candidates = pairs.filter(pair => pair?.chainId === "ethereum" && pair.dexId === "uniswap"
          && typeof pair.baseToken?.address === "string" && pair.baseToken.address.toLowerCase() === TOKEN
          && /^0x[0-9a-f]{40}$/i.test(pair.pairAddress || "")
          && typeof pair.priceUsd === "string" && /^\d{1,60}(?:\.\d{1,18})?$/.test(pair.priceUsd)
          && typeof pair.liquidity?.usd === "number" && Number.isFinite(pair.liquidity.usd) && pair.liquidity.usd > 0)
          .sort((a, b) => b.liquidity.usd - a.liquidity.usd);
        for (const pair of candidates) {
          const [whole, fraction = ""] = pair.priceUsd.split(".");
          const usdPerFthg = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
          if (usdPerFthg <= 0n) continue;
          return { usdPerFthg: usdPerFthg.toString(), decimals: 18, source: "Uniswap spot estimate via DEX Screener",
            indicative: true, fallback: false, pairAddress: pair.pairAddress, token: TOKEN,
            updatedAt: new Date(clock()).toISOString(), error: null };
        }
        throw new Error("No positive, liquid Ethereum Uniswap FTHG/USD estimate is available.");
      } catch (error) {
        logger.error("FTHG/USD DEX estimate unavailable; using indicative reference:", error.message);
        return { usdPerFthg: "10000000000000000", decimals: 18,
          source: "Temporary indicative reference: 1 FTHG = $0.01 until a Uniswap DEX estimate is available",
          indicative: true, fallback: true, marketError: error.message, token: TOKEN,
          updatedAt: new Date(clock()).toISOString(), error: null };
      }
    })();
    try { cached = await pending; at = clock(); return cached; }
    finally { pending = null; }
  };
}
module.exports = { createMarketPriceReader };
