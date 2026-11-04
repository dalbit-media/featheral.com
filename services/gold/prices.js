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
const POOL_START_BLOCK = 26337402;
const LOG_CHUNK = 5000, MAX_CHUNKS_PER_READ = 40;
const MODIFY_LIQUIDITY = new ethers.Interface(["event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"]);
const TICK_FACTORS = [0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n];
const Q96 = 2n ** 96n;

// Uniswap TickMath.getSqrtRatioAtTick in exact integer arithmetic.
function sqrtPriceAtTick(tick) {
  const abs = BigInt(Math.abs(tick));
  if (abs > 887272n) throw new Error("Tick is out of range.");
  let ratio = abs & 1n ? TICK_FACTORS[0] : 1n << 128n;
  for (let bit = 1; bit < TICK_FACTORS.length; bit += 1) if (abs & (1n << BigInt(bit))) ratio = ratio * TICK_FACTORS[bit] >> 128n;
  if (tick > 0) ratio = ethers.MaxUint256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) ? 1n : 0n);
}

function positionAmounts(liquidity, tickLower, tickUpper, sqrtPrice) {
  const lower = sqrtPriceAtTick(tickLower), upper = sqrtPriceAtTick(tickUpper);
  const amount0 = (from) => liquidity * (upper - from) * Q96 / upper / from;
  const amount1 = (to) => liquidity * (to - lower) / Q96;
  if (sqrtPrice <= lower) return [amount0(lower), 0n];
  if (sqrtPrice >= upper) return [0n, amount1(upper)];
  return [amount0(sqrtPrice), amount1(sqrtPrice)];
}

function createMarketPriceReader({ provider, ethUsd, clock = Date.now, logger = console } = {}) {
  const stateView = provider && new ethers.Contract(VALUATION_POOL.stateView, [
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ], provider);
  const ranges = new Map();
  let scanned = POOL_START_BLOCK - 1, cached, at = 0, pending;
  // Uniswap v4 keeps every pool's tokens in the PoolManager, so reserves are rebuilt from this pool's liquidity ranges.
  const reserves = async (block, sqrtPrice, usdPerEth, usdPerFthg) => {
    try {
      if (typeof provider.getLogs !== "function") return null;
      for (let chunks = 0; scanned < block && chunks < MAX_CHUNKS_PER_READ; chunks += 1) {
        const toBlock = Math.min(block, scanned + LOG_CHUNK);
        const logs = await provider.getLogs({ address: VALUATION_POOL.poolManager, fromBlock: scanned + 1, toBlock,
          topics: [MODIFY_LIQUIDITY.getEvent("ModifyLiquidity").topicHash, VALUATION_POOL.poolId] });
        for (const log of logs) {
          const { tickLower, tickUpper, liquidityDelta } = MODIFY_LIQUIDITY.parseLog(log).args;
          const key = `${tickLower}:${tickUpper}`;
          const next = (ranges.get(key)?.liquidity || 0n) + BigInt(liquidityDelta);
          if (next > 0n) ranges.set(key, { tickLower: Number(tickLower), tickUpper: Number(tickUpper), liquidity: next });
          else ranges.delete(key);
        }
        scanned = toBlock;
      }
      if (scanned < block) return null;
      let eth = 0n, fthg = 0n;
      for (const range of ranges.values()) {
        const [amount0, amount1] = positionAmounts(range.liquidity, range.tickLower, range.tickUpper, sqrtPrice);
        eth += amount0; fthg += amount1;
      }
      const tvlUsd = (eth * BigInt(usdPerEth) + fthg * usdPerFthg) / 10n ** 18n;
      return { eth: eth.toString(), fthg: fthg.toString(), tvlUsd: tvlUsd.toString(), positions: ranges.size, decimals: 18 };
    } catch (error) {
      logger.error("FTHG valuation pool reserves unavailable:", error.shortMessage || error.message);
      return null;
    }
  };
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
        const poolReserves = await reserves(block, sqrtPriceX96, eth.usdPerEth, usdPerFthg);
        return { reserves: poolReserves, usdPerFthg: usdPerFthg.toString(), decimals: 18,
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
module.exports = { createMarketPriceReader, sqrtPriceAtTick, positionAmounts, VALUATION_POOL, REFERENCE_USD_PER_FTHG };
