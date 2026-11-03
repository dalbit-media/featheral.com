"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { createReserveEngine } = require("./reserve");
const { assertFreshSignature } = require("../identity/profile");
const { createMarketPriceReader, VALUATION_POOL } = require("./prices");

function reconciliationMessage({ txHash, logIndex, issuedAt }, genesisHash) {
  return ["Featheral Gold reserve reconciliation", `Ledger: ${genesisHash}`, "Chain ID: 1",
    `Transaction: ${txHash}`, `Log index: ${logIndex}`, `Issued at: ${issuedAt}`,
    "Verify an existing finalized FTHG transfer only. No Ethereum transaction is submitted."].join("\n");
}

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN_ADDRESS = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_ADDRESS = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_ADDRESS = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const CHAIN_ID = 1;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function bridgeAbi() {
  for (const file of [
    path.join(ROOT, "shared", "abi", "FthgGameBridge.json"),
    path.join(ROOT, "artifacts", "contracts", "FthgGameBridge.sol", "FthgGameBridge.json"),
  ]) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).abi;
  }
  throw new Error("FthgGameBridge ABI is missing. Run `npm run abi`.");
}

function createGoldApi({ env = require("../operations/runtime").environment(), provider, nativeReader, logger = console } = {}) {
  let reserveEngine = null;
  const nativeBalance = nativeReader || require("./native").createNativeReader({ env, logger });
  const rpcUrl = env.GOLD_API_RPC_URL || env.TOKEN_API_RPC_URL || "https://ethereum-rpc.publicnode.com";
  const rpcRequest = new ethers.FetchRequest(rpcUrl);
  rpcRequest.timeout = 8000;
  const readProvider = provider || new ethers.JsonRpcProvider(rpcRequest, CHAIN_ID);
  const marketPrice = createMarketPriceReader({ provider: readProvider, logger,
    ethUsd: typeof nativeBalance.ethPrice === "function" ? nativeBalance.ethPrice
      : require("./native").createNativeReader({ env, logger }).ethPrice });
  const configuredBridge = env.GOLD_API_BRIDGE_ADDRESS || env.TOKEN_API_BRIDGE_ADDRESS || "";
  const configuredService = env.TOKEN_API_GAME_SERVICE_ADDRESS || "";
  if (configuredBridge && !ethers.isAddress(configuredBridge)) throw new Error("Gold bridge address is invalid.");
  if (configuredService && !ethers.isAddress(configuredService)) throw new Error("Game-service Ethereum address is invalid.");
  const bridgeAddress = configuredBridge ? ethers.getAddress(configuredBridge) : "";
  const gameServiceAddress = configuredService ? ethers.getAddress(configuredService) : "";
  const abi = bridgeAbi();
  const bridgeInterface = new ethers.Interface(abi);
  const bridge = bridgeAddress ? new ethers.Contract(bridgeAddress, abi, readProvider) : null;
  const token = new ethers.Contract(TOKEN_ADDRESS, [
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ], readProvider);
  const confirmations = Math.max(1, Math.min(256, Number(env.TOKEN_API_CONFIRMATIONS) || 12));
  const origins = new Set((env.GOLD_API_CORS_ORIGINS || env.TOKEN_API_CORS_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean));
  const requests = new Map();
  function rateLimit(req, weight) {
    const now = Date.now(), address = req.socket.remoteAddress || "local";
    for (const [key, value] of requests) if (now - value.start >= 60000) requests.delete(key);
    if (!requests.has(address)) {
      if (requests.size >= 10000) throw fail("Gold API request capacity reached.", 503);
      requests.set(address, { start: now, count: 0 });
    }
    const bucket = requests.get(address);
    bucket.count += weight;
    if (bucket.count > 240) throw fail("Too many Ethereum reads. Retry in one minute.", 429);
  }

  function requireBridge() {
    if (!bridge) throw fail("Dynamic bridge is not configured. Set GOLD_API_BRIDGE_ADDRESS after deployment.", 503);
  }
  async function poolState() {
    if (!bridge) return { configured: false, deployed: false, initialized: false };
    if (await readProvider.getCode(bridgeAddress) === "0x") return { configured: true, deployed: false, address: bridgeAddress, initialized: false };
    const [initialized, x, y, apr, year, clock, staked, paused, custody, sourceAdmin, reserveAdmin, authorized] = await Promise.all([
      bridge.poolInitialized(), bridge.reserveFthg(), bridge.reserveFthDollar(), bridge.baseAprBps(),
      bridge.currentGameYear(), bridge.gameClockInitialized(), bridge.totalStakedFthg(), bridge.paused(),
      token.balanceOf(bridgeAddress), bridge.hasRole(ethers.ZeroHash, SOURCE_ADDRESS),
      bridge.hasRole(ethers.ZeroHash, RESERVE_ADDRESS),
      gameServiceAddress ? bridge.hasRole(ethers.id("GAME_SERVICE_ROLE"), gameServiceAddress) : false,
    ]);
    return {
      configured: true, deployed: true, address: bridgeAddress, initialized,
      reserveFthg: x.toString(), actualFthgBalance: custody.toString(), reserveFthDollar: y.toString(),
      spotRateFthDollarPerFthg: initialized && x > 0n ? (y * 10n ** 18n / x).toString() : "0",
      baseAprBps: Number(apr), currentGameYear: Number(year), gameClockInitialized: clock,
      totalStakedFthg: staked.toString(), paused, sourceAdmin, reserveAdmin,
      gameServiceAddress, gameServiceAuthorized: authorized,
    };
  }
  async function walletBalance(address) {
    if (!ethers.isAddress(address)) throw fail("Enter a valid Ethereum wallet address.");
    const [network, balance, block] = await Promise.all([readProvider.getNetwork(), token.balanceOf(address), readProvider.getBlockNumber()]);
    if (Number(network.chainId) !== CHAIN_ID) throw fail("FTHG balance requires Ethereum Mainnet.", 503);
    return { balance: balance.toString(), chainId: CHAIN_ID, token: TOKEN_ADDRESS, block, checkedAt: new Date().toISOString() };
  }
  async function stats() {
    try {
      const [network, supply, source, reserve, pool, latestBlock] = await Promise.all([
        readProvider.getNetwork(), token.totalSupply(), token.balanceOf(SOURCE_ADDRESS),
        token.balanceOf(RESERVE_ADDRESS), poolState(), readProvider.getBlockNumber(),
      ]);
      if (Number(network.chainId) !== CHAIN_ID) throw new Error("RPC is not connected to Ethereum Mainnet.");
      return {
        chain: { id: CHAIN_ID, latestBlock, tokenAddress: TOKEN_ADDRESS, totalSupply: supply.toString(),
          sourceWallet: SOURCE_ADDRESS, sourceBalance: source.toString(), reserveWallet: RESERVE_ADDRESS, reserveWalletBalance: reserve.toString() },
        goldReserve: reserveEngine?.status() || { enabled: false },
        bridge: pool, staking: { baseAprBps: pool.baseAprBps ?? 600, termsGameYears: [1, 2, 5, 10, 20, 30], interest: "simple", priceLock: "spot quote at stake time" },
        ready: [
          { key: "chain", ready: true, detail: `Ethereum Mainnet at block ${latestBlock}.` },
          { key: "bridge", ready: Boolean(pool.deployed), detail: pool.deployed ? `Bridge at ${pool.address}.` : "Bridge is not configured or deployed." },
          { key: "pool", ready: Boolean(pool.initialized && pool.reserveFthg !== "0" && pool.reserveFthDollar !== "0" && !pool.paused), detail: "Conversion requires initialized, funded and unpaused reserves." },
          { key: "game-clock", ready: Boolean(pool.gameClockInitialized), detail: "Staking maturity uses the authorized on-chain game clock." },
          { key: "game-service-role", ready: Boolean(pool.gameServiceAuthorized), detail: "Redemption and game-year updates require GAME_SERVICE_ROLE." },
        ],
        checkedAt: new Date().toISOString(),
      };
    } catch (error) { throw fail(`Public Mainnet data is unavailable: ${error.message}`, 503); }
  }
  async function quote(direction, rawAmount) {
    if (typeof rawAmount !== "string" || !/^[1-9]\d*$/.test(rawAmount) || BigInt(rawAmount) > ethers.MaxUint256) throw fail("amount must be a positive uint256 base-unit string.");
    const amount = BigInt(rawAmount);
    if (reserveEngine) {
      return BigInt(reserveEngine.quote(direction, amount).amountOut);
    }
    requireBridge();
    if (direction === "fthg-to-fthdollar") return bridge.quoteFthDollarOut(amount);
    if (direction === "fthdollar-to-fthg") return bridge.quoteFthgOut(amount);
    throw fail("direction must be fthg-to-fthdollar or fthdollar-to-fthg.");
  }
  async function verifiedEvents(txHash) {
    if (!ethers.isHexString(txHash, 32)) throw fail("txHash must be a 32-byte transaction hash.");
    requireBridge();
    const receipt = await readProvider.getTransactionReceipt(txHash);
    if (!receipt) return { pending: true, events: [] };
    if (Number(receipt.status) !== 1) throw fail("Transaction reverted; no ledger entry was created.", 409);
    const [latest, network] = await Promise.all([readProvider.getBlockNumber(), readProvider.getNetwork()]);
    if (Number(network.chainId) !== CHAIN_ID) throw fail("RPC is not connected to Ethereum Mainnet.", 503);
    if (latest - receipt.blockNumber + 1 < confirmations) return { pending: true, confirmations: latest - receipt.blockNumber + 1, events: [] };
    const block = await readProvider.getBlock(receipt.blockNumber);
    if (!block) throw fail("Confirmed Ethereum block is unavailable.", 503);
    if (block.hash !== receipt.blockHash) throw fail("Receipt is not in the canonical Ethereum block.", 409);
    const events = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== bridgeAddress.toLowerCase()) continue;
      let parsed;
      try { parsed = bridgeInterface.parseLog({ topics: log.topics, data: log.data }); }
      catch (error) { logger.warn("Ignoring an unrecognized bridge log:", error.message); continue; }
      if (parsed) events.push({ parsed, logIndex: log.index, txHash: receipt.hash, blockNumber: receipt.blockNumber, blockTime: block.timestamp * 1000 });
    }
    return { pending: false, events };
  }
  function validateRpc(call) {
    if (!call || call.jsonrpc !== "2.0" || !Array.isArray(call.params)
      || !(call.id === null || (typeof call.id === "string" && call.id.length <= 128) || Number.isSafeInteger(call.id))) throw fail("Invalid JSON-RPC request.");
    const simple = new Set(["eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]);
    const arity = { eth_chainId: 0, eth_blockNumber: 0, eth_getTransactionReceipt: 1, eth_getTransactionByHash: 1,
      eth_getBlockByNumber: 2, eth_getBlockByHash: 2, eth_getBalance: 2, eth_getTransactionCount: 2,
      eth_gasPrice: 0, eth_maxPriorityFeePerGas: 0, eth_feeHistory: 3, eth_call: 2, eth_getCode: 2, eth_getLogs: 1 };
    if (!Object.hasOwn(arity, call.method)) throw fail("Gold RPC permits read-only Ethereum calls only.", 403);
    if (call.params.length !== arity[call.method]) throw fail("Invalid Ethereum read parameters.");
    if (call.method === "eth_feeHistory" && (!/^0x[0-9a-f]+$/i.test(call.params[0]) || BigInt(call.params[0]) > 1024n)) throw fail("Fee history is limited to 1,024 blocks.");
    if (simple.has(call.method)) return;
    const target = call.method === "eth_call" ? call.params[0]?.to : call.method === "eth_getCode" ? call.params[0] : call.method === "eth_getLogs" ? call.params[0]?.address : "";
    if (typeof target !== "string" || !ethers.isAddress(target)) throw fail("Ethereum read requires a valid contract address.");
    if (call.method === "eth_getLogs") {
      const filter = call.params[0];
      if (!filter.blockHash) {
        if (!/^0x[0-9a-f]+$/i.test(filter.fromBlock) || !/^0x[0-9a-f]+$/i.test(filter.toBlock)
          || BigInt(filter.toBlock) < BigInt(filter.fromBlock) || BigInt(filter.toBlock) - BigInt(filter.fromBlock) > 2000n) throw fail("Log scans require an explicit range of at most 2,001 blocks.");
      } else if (!ethers.isHexString(filter.blockHash, 32)) throw fail("Invalid log block hash.");
    }
  }
  async function handle(req, res) {
    if (!req.url?.startsWith("/api/v1/gold/")) return false;
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
      return true;
    };
    try {
      rateLimit(req, 1);
      if (req.method === "OPTIONS") return reply(204, null);
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname.slice("/api/v1/gold".length);
      if (route === "/reserve/quote" && req.method === "GET") {
        if (!reserveEngine) throw fail("Finite-reserve engine is not enabled.", 503);
        const amount = url.searchParams.get("amount");
        if (typeof amount !== "string" || !/^[1-9]\d{0,77}$/.test(amount) || BigInt(amount) > ethers.MaxUint256) throw fail("Invalid Gold quote amount.", 400);
        return reply(200, reserveEngine.quote(url.searchParams.get("direction"), amount));
      }
      if (route === "/reserve" && req.method === "GET") return reply(200, reserveEngine?.status() || {
        enabled: false, initialized: false, warning: "Finite-reserve testing is disabled on this ledger.",
      });
      if (route === "/reserve/sync-plan" && req.method === "GET") {
        if (!reserveEngine) throw fail("Finite-reserve engine is not enabled.", 503);
        return reply(200, await reserveEngine.syncPlan());
      }
      if (route === "/reserve/activity" && req.method === "GET") {
        if (!reserveEngine) throw fail("Finite-reserve engine is not enabled.", 503);
        if ([...url.searchParams.keys()].some(key => !["limit", "cursor"].includes(key))
          || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) throw fail("Invalid reserve history query.");
        return reply(200, reserveEngine.activity({ limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20,
          cursor: url.searchParams.has("cursor") ? url.searchParams.get("cursor") : undefined }));
      }
      if (["/reserve/reconcile", "/reserve/redeem", "/reserve/convert"].includes(route) && req.method === "POST") {
        if (!reserveEngine) throw fail("Finite-reserve engine is not enabled.", 503);
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 4096) throw fail("Reserve request exceeds 4 KiB.", 413);
        }
        let body;
        try { body = JSON.parse(text); } catch { throw fail("Reserve request must be JSON."); }
        const fields = route === "/reserve/reconcile" ? "issuedAt,logIndex,signature,txHash" : route === "/reserve/convert"
          ? (body?.pricing === undefined ? "amount,issuedAt,nonce,signature" : "amount,issuedAt,nonce,pricing,signature") : "amount,issuedAt,memo,nonce,signature,to,wallet";
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== fields) throw fail("Invalid reserve request fields.");
        if (route === "/reserve/reconcile") {
          if (!ethers.isHexString(body.txHash, 32) || !Number.isSafeInteger(body.logIndex) || body.logIndex < 0
            || typeof body.issuedAt !== "string" || !Number.isFinite(Date.parse(body.issuedAt))
            || new Date(body.issuedAt).toISOString() !== body.issuedAt) throw fail("Invalid reconciliation authorization.");
          assertFreshSignature(Date.parse(body.issuedAt), Date.now(), "Reconciliation");
          const state = reserveEngine.status();
          let signer;
          try { signer = ethers.verifyMessage(reconciliationMessage(body, state.genesisHash), body.signature); }
          catch { throw fail("Invalid reconciliation signature.", 401); }
          if (![state.sourceWallet, state.reserveWallet].some(wallet => wallet.toLowerCase() === signer.toLowerCase()))
            throw fail("Reserve reconciliation requires an authorized origin or backing wallet.", 403);
          return reply(200, await reserveEngine.reconcile(body.txHash, body.logIndex));
        }
        if (route === "/reserve/convert") return reply(200, await reserveEngine.convert(body));
        return reply(200, await reserveEngine.redeem(body));
      }
      if (req.method === "GET" && route === "/health") return reply(200, {
        status: "ok", chainId: CHAIN_ID, tokenAddress: TOKEN_ADDRESS, bridgeConfigured: Boolean(bridgeAddress),
        ethereumStatus: "not-checked", checkedAt: new Date().toISOString(),
      });
      if (req.method === "GET" && route === "/stats") return reply(200, await stats());
      if (req.method === "GET" && route === "/valuation") return reply(200, { pool: VALUATION_POOL, market: await marketPrice() });
      const wallet = route.match(/^\/wallets\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === "GET" && wallet) return reply(200, { address: ethers.getAddress(wallet[1]), fthg: (await token.balanceOf(wallet[1])).toString(), chainId: CHAIN_ID });
      const nativeWallet = route.match(/^\/native\/wallets\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === "GET" && nativeWallet) return reply(200, await nativeBalance(nativeWallet[1]));
      if (req.method === "GET" && route === "/quote") {
        const direction = url.searchParams.get("direction"), amount = url.searchParams.get("amount");
        return reply(200, { direction, amountIn: amount, amountOut: (await quote(direction, amount)).toString(), quoteIsIndicative: true });
      }
      if (req.method === "POST" && route === "/rpc") {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 65536) throw fail("RPC body exceeds 64 KiB.", 413);
        }
        let body;
        try { body = JSON.parse(text); } catch { throw fail("RPC body must be JSON."); }
        const calls = Array.isArray(body) ? body : [body];
        if (!calls.length || calls.length > 50) throw fail("RPC batch must contain 1–50 calls.");
        rateLimit(req, calls.length);
        calls.forEach(validateRpc);
        const result = await Promise.all(calls.map(async (call) => {
          try { return { jsonrpc: "2.0", id: call.id, result: await readProvider.send(call.method, call.params) }; }
          catch (error) { logger.error("Gold RPC call failed:", error); return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "Ethereum read failed." } }; }
        }));
        return reply(200, Array.isArray(body) ? result : result[0]);
      }
      return reply(404, { error: "Gold API route not found." });
    } catch (error) {
      logger.error("Gold API request failed:", error);
      return reply(error.status || 503, { error: error.message });
    }
  }
  return { handle, stats, quote, verifiedEvents, poolState, marketPrice, walletBalance, nativeBalance, confirmations, bridgeAddress,
    enableReserve(ledger, privateKey, beforeMutation) {
      if (reserveEngine) throw new Error("Gold reserve engine is already enabled.");
      reserveEngine = createReserveEngine({ ledger, privateKey, provider: readProvider, confirmations, beforeMutation });
      return reserveEngine;
    },
    reserveStatus: () => reserveEngine?.status() || { enabled: false },
    close: () => { if (!provider) readProvider.destroy(); } };
}

module.exports = { createGoldApi, reconciliationMessage, TOKEN_ADDRESS, SOURCE_ADDRESS, RESERVE_ADDRESS, CHAIN_ID };
