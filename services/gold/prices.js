"use strict";
const { ethers } = require("ethers");

const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const REFERENCE_USD_PER_FTHG = "10000000000000000";
const Q192 = 2n ** 192n;
// Read-only valuation source. Changing it requires a code release, not an admin action.
const VALUATION_POOL = Object.freeze({
  protocol: "Uniswap v4", chainId: 1,
  poolId: "0x3f1f8a9867d8f4a59f206b9644fafe05e9546323c0219dd1352187bbb5738fdd",
  poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
  currency0: ethers.ZeroAddress, symbol0: "ETH", currency1: TOKEN, symbol1: "FTHG",
  fee: 2500, tickSpacing: 25, hooks: ethers.ZeroAddress,
  url: "https://app.uniswap.org/explore/pools/ethereum/0x3f1f8a9867d8f4a59f206b9644fafe05e9546323c0219dd1352187bbb5738fdd",
});
const derivedId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"],
  [VALUATION_POOL.currency0, VALUATION_POOL.currency1, VALUATION_POOL.fee, VALUATION_POOL.tickSpacing, VALUATION_POOL.hooks]));
if (derivedId !== VALUATION_POOL.poolId) throw new Error("FTHG valuation pool key does not match its pool ID.");

function createMarketPriceReader({ provider, ethUsd, clock = Date.now, logger = console } = {}) {
  const stateView = provider && new ethers.Contract(VALUATION_POOL.stateView, [
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ], provider);
  let cached, at = 0, pending;
  return async () => {
    if (cached && clock() - at < 60000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (!stateView || typeof ethUsd !== "function") throw new Error("FTHG valuation pool reader is not configured.");
        const block = await provider.getBlockNumber();
        const [slot0, liquidity, eth] = await Promise.all([
          stateView.getSlot0(VALUATION_POOL.poolId, { blockTag: block }),
          stateView.getLiquidity(VALUATION_POOL.poolId, { blockTag: block }), ethUsd()]);
        const sqrtPriceX96 = BigInt(slot0[0]);
        if (sqrtPriceX96 === 0n) throw new Error("Uniswap FTHG valuation pool is not initialized.");
        if (BigInt(liquidity) === 0n) throw new Error("Uniswap FTHG valuation pool has no in-range liquidity.");
        if (typeof eth?.usdPerEth !== "string" || !/^[1-9]\d{0,77}$/.test(eth.usdPerEth)) throw new Error(eth?.error || "ETH/USD price is unavailable.");
        // ETH is currency0 and both currencies use 18 decimals, so FTHG per ETH = sqrtPriceX96² / 2¹⁹².
        const squared = sqrtPriceX96 * sqrtPriceX96;
        const usdPerFthg = BigInt(eth.usdPerEth) * Q192 / squared;
        if (usdPerFthg <= 0n) throw new Error("FTHG pool price is below supported precision.");
        return { usdPerFthg: usdPerFthg.toString(), decimals: 18,
          source: "Uniswap v4 ETH/FTHG pool spot × ETH/USD estimate", indicative: true, fallback: false,
          pool: VALUATION_POOL.poolId, poolUrl: VALUATION_POOL.url, block, tick: Number(slot0[1]),
          liquidity: BigInt(liquidity).toString(), fthgPerEth: (squared * 10n ** 18n / Q192).toString(),
          usdPerEth: eth.usdPerEth, token: TOKEN.toLowerCase(), updatedAt: new Date(clock()).toISOString(), error: null };
      } catch (error) {
        logger.error("FTHG valuation pool unavailable; using indicative reference:", error.shortMessage || error.message);
        return { usdPerFthg: REFERENCE_USD_PER_FTHG, decimals: 18,
          source: "Temporary indicative reference: 1 FTHG = $0.01 until the Uniswap valuation pool has price data",
          indicative: true, fallback: true, marketError: error.shortMessage || error.message, pool: VALUATION_POOL.poolId,
          poolUrl: VALUATION_POOL.url, token: TOKEN.toLowerCase(), updatedAt: new Date(clock()).toISOString(), error: null };
      }
    })();
    try { cached = await pending; at = clock(); return cached; }
    finally { pending = null; }
  };
}
module.exports = { createMarketPriceReader, VALUATION_POOL, REFERENCE_USD_PER_FTHG };
