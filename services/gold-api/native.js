"use strict";
const NETWORKS = [
  { name: "Ethereum", chainId: 1, rpc: "https://ethereum-rpc.publicnode.com" },
  { name: "Base", chainId: 8453, rpc: "https://mainnet.base.org" },
  { name: "Arbitrum One", chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
  { name: "Optimism", chainId: 10, rpc: "https://mainnet.optimism.io" },
  { name: "zkSync Era", chainId: 324, rpc: "https://mainnet.era.zksync.io" },
  { name: "Linea", chainId: 59144, rpc: "https://rpc.linea.build" },
];
function createNativeReader({ fetchRpc = fetch, env = require("../operations/runtime").environment(), clock = Date.now, logger = console } = {}) {
  const cache = new Map(), pending = new Map();
  let price, priceAt = 0, pricePending;
  async function ethPrice() {
    if (price && clock() - priceAt < 60000) return price;
    if (pricePending) return pricePending;
    pricePending = (async () => {
      try {
        const response = await fetchRpc("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`ETH/USD HTTP ${response.status}`);
        const item = (await response.json()).ethereum;
        if (!item || !Number.isFinite(item.usd) || item.usd <= 0 || !Number.isSafeInteger(item.last_updated_at)
          || item.last_updated_at * 1000 < clock() - 300000 || item.last_updated_at * 1000 > clock() + 30000)
          throw new Error("No fresh ETH/USD price is available.");
        const usdPerEth = require("ethers").parseUnits(String(item.usd), 18);
        if (usdPerEth <= 0n) throw new Error("ETH price is below supported precision.");
        return { usdPerEth: usdPerEth.toString(), updatedAt: new Date(item.last_updated_at * 1000).toISOString(),
          source: "CoinGecko Ethereum native ETH" };
      } catch (error) { logger.error("Native ETH price unavailable:", error.message); return { usdPerEth: null, error: error.message }; }
    })();
    try { price = await pricePending; priceAt = clock(); return price; } finally { pricePending = null; }
  }
  async function rpc(network, method, params) {
    const url = env[`WALLET_RPC_${network.chainId}`] || network.rpc;
    const response = await fetchRpc(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`${network.name} RPC HTTP ${response.status}`);
    const result = await response.json();
    if (result.error || typeof result.result !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(result.result)) throw new Error(`${network.name}: ${result.error?.message || "Invalid RPC result"}`);
    return result.result;
  }
  return async address => {
    if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Invalid native ETH wallet address.");
    address = address.toLowerCase();
    if (cache.has(address) && clock() - cache.get(address).at < 30000) return cache.get(address).value;
    if (pending.has(address)) return pending.get(address);
    const read = (async () => {
      const [market, balances] = await Promise.all([ethPrice(), Promise.all(NETWORKS.map(async network => {
        try {
          if (BigInt(await rpc(network, "eth_chainId", [])) !== BigInt(network.chainId)) throw new Error(`${network.name} RPC chain mismatch.`);
          const block = await rpc(network, "eth_blockNumber", []);
          const balance = BigInt(await rpc(network, "eth_getBalance", [address, block])).toString();
          return { name: network.name, chainId: network.chainId, symbol: "ETH", decimals: 18, balance, block,
            checkedAt: new Date(clock()).toISOString(), error: null };
        } catch (error) {
          logger.error("Native ETH balance unavailable:", error.message);
          return { name: network.name, chainId: network.chainId, symbol: "ETH", decimals: 18, balance: null, error: error.message };
        }
      }))]);
      return { balances, market };
    })();
    pending.set(address, read);
    try {
      const value = await read;
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(address, { value, at: clock() });
      return value;
    } finally { pending.delete(address); }
  };
}
module.exports = { createNativeReader, NETWORKS };
