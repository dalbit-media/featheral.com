"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { FthLedger, walletAccountId, accountWallet } = require("../fth-ledger/ledger");
const { normalizeAccount, verifyTransfer } = require("../fth-ledger/transfer");
const { ServiceAuthenticator, canonicalRequest, readTrustedServices } = require("./auth");
const { verifySignedProfile } = require("./profile");

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN_ADDRESS = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_ADDRESS = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_ADDRESS = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const CHAIN_ID = 1;
const TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const BODY_LIMIT = 64 * 1024;
const SYNC_PAGE = 500;
const STORAGE_LAYOUT = "Daily minified JSON block files: <dir>/YYYY/YYYY-MM-DD.jsonl (one block per line)";

// Kept for game services: every wallet's FTH$ account is its address left-padded to bytes32.
const walletGameAccountId = walletAccountId;

function bridgeAbi() {
  const artifactPaths = [
    path.join(ROOT, "sites", "shared", "abi", "FthgGameBridge.json"),
    path.join(ROOT, "artifacts", "contracts", "FthgGameBridge.sol", "FthgGameBridge.json"),
  ];
  for (const artifactPath of artifactPaths) {
    if (fs.existsSync(artifactPath)) return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
  }
  throw new Error("FthgGameBridge ABI is missing. Run `npm run abi` before starting the API.");
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        reject(Object.assign(new Error("Request body exceeds 64 KiB."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function asBytes32(value, name) {
  if (!ethers.isHexString(value, 32)) throw Object.assign(new Error(`${name} must be a 32-byte hex value.`), { status: 400 });
  return value.toLowerCase();
}

function asPositiveInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a positive integer string in base units.`), { status: 400 });
  }
  return BigInt(value);
}

function serviceRequestHeaders(serviceId, privateKey, method, requestPath, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(canonicalRequest(method, requestPath, timestamp, nonce, body)), privateKey).toString("base64");
  return {
    "content-type": "application/json",
    "x-service-id": serviceId,
    "x-service-timestamp": timestamp,
    "x-service-nonce": nonce,
    "x-service-signature": signature,
  };
}

function createTokenApi({ env = process.env, ledger: suppliedLedger, provider: suppliedProvider, logger = console } = {}) {
  // FTH_LEDGER_* names are canonical; TOKEN_LEDGER_* names are still accepted for existing deployments.
  const setting = (name) => env[`FTH_LEDGER_${name}`] ?? env[`TOKEN_LEDGER_${name}`] ?? "";
  const nodeId = setting("NODE_ID") || "local-node";
  const mode = setting("MODE") || "unconfigured";
  if (!["writer", "reader", "unconfigured"].includes(mode)) throw new Error("FTH_LEDGER_MODE must be writer, reader, or unconfigured.");
  const upstream = setting("UPSTREAM_URL").replace(/\/+$/, "");
  const ledger = suppliedLedger || new FthLedger({
    directory: path.resolve(setting("DIR") || path.join(ROOT, "data", "fth-ledger", nodeId)),
    nodeId,
    // Unconfigured nodes run a standalone local ledger so profiles and transfers work in development.
    mode: mode === "reader" ? "reader" : "writer",
    signingKey: setting("SIGNING_PRIVATE_KEY") || null,
    writerPublicKey: setting("WRITER_PUBLIC_KEY") || null,
    blockIntervalMs: setting("BLOCK_INTERVAL_MS") === "" ? 1000 : Number(setting("BLOCK_INTERVAL_MS")),
    genesis: { fthg: TOKEN_ADDRESS, sourceWallet: SOURCE_ADDRESS, reserveWallet: RESERVE_ADDRESS, openingRate: "1 FTHG = 1000 FTH$" },
  }).open();
  const trustedServices = readTrustedServices(env.TOKEN_API_SERVICES_JSON || "");
  const authenticator = new ServiceAuthenticator(trustedServices);
  const rpcUrl = env.TOKEN_API_RPC_URL || "https://ethereum-rpc.publicnode.com";
  if (env.TOKEN_API_BRIDGE_ADDRESS && !ethers.isAddress(env.TOKEN_API_BRIDGE_ADDRESS)) throw new Error("TOKEN_API_BRIDGE_ADDRESS is not a valid Ethereum address.");
  const bridgeAddress = env.TOKEN_API_BRIDGE_ADDRESS ? ethers.getAddress(env.TOKEN_API_BRIDGE_ADDRESS) : "";
  if (env.TOKEN_API_GAME_SERVICE_ADDRESS && !ethers.isAddress(env.TOKEN_API_GAME_SERVICE_ADDRESS)) throw new Error("TOKEN_API_GAME_SERVICE_ADDRESS is not a valid Ethereum address.");
  const gameServiceAddress = env.TOKEN_API_GAME_SERVICE_ADDRESS ? ethers.getAddress(env.TOKEN_API_GAME_SERVICE_ADDRESS) : "";
  const bridgeInterface = new ethers.Interface(bridgeAbi());
  const readProvider = suppliedProvider || new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const tokenContract = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, readProvider);
  const bridgeContract = bridgeAddress ? new ethers.Contract(bridgeAddress, bridgeAbi(), readProvider) : null;
  const confirmations = Math.max(1, Math.min(256, Number(env.TOKEN_API_CONFIRMATIONS) || 12));
  const redemptionCancelGraceMs = Math.max(60_000, Number(env.TOKEN_API_REDEMPTION_CANCEL_GRACE_MS) || 1_800_000);
  const corsOrigins = new Set((env.TOKEN_API_CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
  let syncing = false;
  let syncTimer;
  const counters = { syncErrors: 0, lastSyncAt: "", lastSyncError: "", lastSettlementAt: "" };
  const writeBuckets = new Map();

  function rateLimit(req, bucket, perMinute) {
    const key = `${bucket}:${req.socket?.remoteAddress || "local"}`;
    const now = Date.now();
    const recent = (writeBuckets.get(key) || []).filter((time) => now - time < 60_000);
    if (recent.length >= perMinute) throw Object.assign(new Error("Too many requests. Try again in a minute."), { status: 429 });
    recent.push(now);
    writeBuckets.set(key, recent);
    if (writeBuckets.size > 20_000) writeBuckets.delete(writeBuckets.keys().next().value);
  }

  function publicProfile(profile) {
    return profile ? { address: profile.address, username: profile.username, avatar: profile.avatar, issuedAt: profile.issuedAt } : null;
  }

  function requireLedgerWriter() {
    if (mode === "reader") throw Object.assign(new Error("This node is a read-only FTH$ replica."), { status: 503 });
  }

  // Readers forward wallet-signed writes to the writer, then pull the new block.
  async function forwardToWriter(req, res, pathname) {
    if (!upstream) throw Object.assign(new Error("This read node has no writer configured for ledger writes."), { status: 503 });
    const response = await fetch(`${upstream}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: req.rawBody, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
    if (response.ok) syncFromUpstream();
    return true;
  }

  async function updateProfile(req, res) {
    const body = await readJsonBody(req);
    if (mode === "reader") return forwardToWriter(req, res, "/api/v1/profiles");
    rateLimit(req, "profile", 10);
    const profile = verifySignedProfile(body);
    const address = profile.address.toLowerCase();
    const receipt = await ledger.submit({
      id: `profile:${address}:${profile.issuedAt}`,
      kind: "PROFILE",
      account: walletAccountId(profile.address),
      data: { address: profile.signedAddress, username: profile.username, avatar: profile.avatar, issuedAt: profile.issuedAt, signature: profile.signature },
    }, { fresh: true });
    return json(res, 200, { status: "saved", profile: publicProfile(ledger.profile(address)), ledgerHeight: receipt.height, transaction: receipt.hash });
  }

  async function submitTransfer(req, res) {
    const body = await readJsonBody(req);
    if (mode === "reader") return forwardToWriter(req, res, "/api/v1/fth/transfers");
    rateLimit(req, "transfer", 30);
    const transfer = verifyTransfer(body);
    const receipt = await ledger.submit({
      id: `transfer:${transfer.from}:${transfer.nonce}`,
      kind: "TRANSFER",
      account: transfer.from,
      amount: transfer.amount,
      data: { w: transfer.wallet, to: transfer.to, n: transfer.nonce, m: transfer.memo, ts: transfer.issuedAt, sig: transfer.signature },
    }, { fresh: true });
    return json(res, 200, {
      status: "sealed",
      receipt,
      transaction: ledger.tx(receipt.hash),
      balance: ledger.balance(transfer.from),
      nonce: ledger.nonce(transfer.from),
    });
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type,x-service-id,x-service-timestamp,x-service-nonce,x-service-signature");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
  }

  function requireWriter() {
    if (mode !== "writer") throw Object.assign(new Error("This node is read-only or not configured as the ledger writer."), { status: 503 });
  }

  function authenticate(req, expectedRole) {
    return authenticator.verify(req.headers, req.method, new URL(req.url, "http://localhost").pathname + new URL(req.url, "http://localhost").search, req.rawBody || "", expectedRole);
  }

  function requireBridge() {
    if (!bridgeContract) throw Object.assign(new Error("Dynamic bridge is not configured. Set TOKEN_API_BRIDGE_ADDRESS after deployment."), { status: 503 });
  }

  async function getPoolState() {
    if (!bridgeContract) return { configured: false, deployed: false, initialized: false };
    const code = await readProvider.getCode(bridgeAddress);
    if (code === "0x") return { configured: true, deployed: false, address: bridgeAddress, initialized: false };
    const initialized = await bridgeContract.poolInitialized();
    const [poolFthg, poolFthDollar, apr, gameYear, gameClockInitialized, staked, paused, actualFthgBalance] = await Promise.all([
      bridgeContract.reserveFthg(),
      bridgeContract.reserveFthDollar(),
      bridgeContract.baseAprBps(),
      bridgeContract.currentGameYear(),
      bridgeContract.gameClockInitialized(),
      bridgeContract.totalStakedFthg(),
      bridgeContract.paused(),
      tokenContract.balanceOf(bridgeAddress),
    ]);
    const [sourceAdmin, reserveAdmin, gameServiceAuthorized] = await Promise.all([
      bridgeContract.hasRole(ethers.ZeroHash, SOURCE_ADDRESS),
      bridgeContract.hasRole(ethers.ZeroHash, RESERVE_ADDRESS),
      gameServiceAddress ? bridgeContract.hasRole(ethers.id("GAME_SERVICE_ROLE"), gameServiceAddress) : Promise.resolve(false),
    ]);
    return {
      configured: true,
      deployed: true,
      address: bridgeAddress,
      initialized,
      reserveFthg: poolFthg.toString(),
      actualFthgBalance: actualFthgBalance.toString(),
      reserveFthDollar: poolFthDollar.toString(),
      spotRateFthDollarPerFthg: initialized && poolFthg > 0n ? (poolFthDollar * 10n ** 18n / poolFthg).toString() : "0",
      baseAprBps: Number(apr),
      currentGameYear: Number(gameYear),
      gameClockInitialized,
      totalStakedFthg: staked.toString(),
      paused,
      sourceAdmin,
      reserveAdmin,
      gameServiceAddress,
      gameServiceAuthorized,
    };
  }

  function nodeInfo() {
    return {
      id: nodeId,
      mode,
      storage: STORAGE_LAYOUT,
      upstream: mode === "reader" ? upstream || "file copy (rsync/object sync)" : "",
      lastSyncAt: counters.lastSyncAt || null,
      syncErrors: counters.syncErrors,
      lastSyncError: counters.lastSyncError || null,
    };
  }

  async function getPublicStats() {
    let network, totalSupply, sourceBalance, reserveBalance, pool, latestBlock;
    try {
      [network, totalSupply, sourceBalance, reserveBalance, pool, latestBlock] = await Promise.all([
        readProvider.getNetwork(),
        tokenContract.totalSupply(),
        tokenContract.balanceOf(SOURCE_ADDRESS),
        tokenContract.balanceOf(RESERVE_ADDRESS),
        getPoolState(),
        readProvider.getBlockNumber(),
      ]);
    } catch (error) {
      throw Object.assign(new Error(`Public Mainnet data is unavailable: ${error.message}`), { status: 503 });
    }
    const chainMatches = Number(network.chainId) === CHAIN_ID;
    const fthDollar = ledger.summary();
    const hasGameService = Object.values(trustedServices).some((service) => service.role === "game");
    const ready = [
      { key: "writer", ready: mode === "writer", detail: mode === "writer" ? "This node accepts service-verified FTH$ ledger writes." : `Node mode is ${mode}; only the writer seals bridge credits and redemptions.` },
      { key: "bridge", ready: pool.deployed, detail: pool.deployed ? `Bridge deployed at ${pool.address}.` : "Dynamic bridge is not configured or deployed." },
      { key: "pool", ready: Boolean(pool.initialized && pool.reserveFthg !== "0" && pool.reserveFthDollar !== "0" && !pool.paused), detail: pool.initialized ? `${pool.paused ? "Pool is paused. " : ""}FTHG is from actual deposits; FTH$ is the configured L3 budget.` : "Pool disabled until actual FTHG is deposited and matching FTH$ budget is configured." },
      { key: "game-clock", ready: Boolean(pool.gameClockInitialized), detail: pool.gameClockInitialized ? `Game clock is at year ${pool.currentGameYear}.` : "Staking remains unavailable until a signed game-service year update is confirmed on-chain." },
      { key: "chain", ready: chainMatches, detail: chainMatches ? `Connected to Ethereum Mainnet at block ${latestBlock}.` : `Configured RPC returned chain ${network.chainId}, expected 1.` },
      { key: "game-service-auth", ready: hasGameService, detail: hasGameService ? "At least one game service signing key is registered." : "No game-service signing keys are configured." },
      { key: "admin-roles", ready: Boolean(pool.sourceAdmin && pool.reserveAdmin), detail: pool.deployed ? `Source admin: ${pool.sourceAdmin ? "confirmed" : "missing"}; reserve admin: ${pool.reserveAdmin ? "confirmed" : "missing"}.` : "Bridge admin roles will be checked after deployment." },
      { key: "game-service-role", ready: Boolean(pool.gameServiceAuthorized), detail: pool.gameServiceAuthorized ? `Game-service wallet ${pool.gameServiceAddress} is authorized on-chain.` : "Configure TOKEN_API_GAME_SERVICE_ADDRESS and grant GAME_SERVICE_ROLE on the bridge." },
      { key: "block-signing", ready: fthDollar.signedBlocks, detail: fthDollar.signedBlocks ? "FTH$ blocks carry an Ed25519 writer signature that replicas verify." : "Set FTH_LEDGER_SIGNING_PRIVATE_KEY on the writer so replicas and file copies can verify blocks." },
      { key: "replication", ready: mode === "writer" || (mode === "reader" && Boolean(counters.lastSyncAt)), detail: mode === "reader" ? (counters.lastSyncAt ? `Replica synchronized at ${counters.lastSyncAt}.` : "Reader has not synchronized yet.") : mode === "writer" ? "This node is the single configured writer." : "No writer/reader topology is configured." },
    ];
    return {
      node: nodeInfo(),
      chain: { id: Number(network.chainId), latestBlock, tokenAddress: TOKEN_ADDRESS, totalSupply: totalSupply.toString(), sourceWallet: SOURCE_ADDRESS, sourceBalance: sourceBalance.toString(), reserveWallet: RESERVE_ADDRESS, reserveWalletBalance: reserveBalance.toString() },
      bridge: pool,
      staking: { baseAprBps: pool.baseAprBps ?? 600, termsGameYears: [1, 2, 5, 10, 20, 30], interest: "simple", priceLock: "spot quote at stake time" },
      fthDollar,
      ready: ready.map((item) => ({ ...item, ready: Boolean(item.ready) })),
      checkedAt: new Date().toISOString(),
    };
  }

  async function verifiedEvents(txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) throw Object.assign(new Error("txHash must be a 32-byte transaction hash."), { status: 400 });
    requireBridge();
    const receipt = await readProvider.getTransactionReceipt(txHash);
    if (!receipt) return { pending: true, events: [] };
    if (Number(receipt.status) !== 1) throw Object.assign(new Error("Transaction reverted; no ledger entry was created."), { status: 409 });
    const [latest, network] = await Promise.all([readProvider.getBlockNumber(), readProvider.getNetwork()]);
    if (Number(network.chainId) !== CHAIN_ID) throw Object.assign(new Error("RPC is not connected to Ethereum Mainnet."), { status: 503 });
    if (latest - receipt.blockNumber + 1 < confirmations) return { pending: true, confirmations: latest - receipt.blockNumber + 1, events: [] };
    const events = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== bridgeAddress.toLowerCase()) continue;
      let parsed;
      try { parsed = bridgeInterface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      if (!parsed) continue;
      events.push({ parsed, logIndex: log.index, txHash: receipt.hash, blockNumber: receipt.blockNumber });
    }
    return { pending: false, events };
  }

  // Only FTH$ effects are recorded on the L3 ledger. FTHG custody, staking principal, and the game
  // clock stay on Ethereum, which is their single source of truth.
  async function settleEvent(event) {
    const { parsed, logIndex, blockNumber } = event;
    const txHash = event.txHash.toLowerCase();
    const id = `eth:${CHAIN_ID}:${txHash}:${logIndex}`;
    if (parsed.name === "FthgConverted" || parsed.name === "StakeClaimed") {
      const account = String(parsed.args.gameAccountId).toLowerCase();
      const amount = (parsed.name === "FthgConverted" ? parsed.args.fthDollarOut : parsed.args.rewardFthDollar).toString();
      const data = { src: parsed.name, tx: txHash, log: logIndex, blk: blockNumber };
      if (parsed.name === "FthgConverted") data.w = ethers.getAddress(String(parsed.args.account));
      const receipt = await ledger.submit({ id, kind: "CREDIT", account, amount, data });
      return { ...receipt, id, kind: "CREDIT", accountId: account, amount };
    }
    if (parsed.name === "FthDollarRedeemed") {
      const redemptionId = String(parsed.args.redemptionId).toLowerCase();
      const redemption = ledger.redemption(redemptionId);
      if (!redemption || (redemption.status !== "reserved" && !(redemption.status === "settled" && ledger.hasId(id)))) {
        throw Object.assign(new Error("Confirmed FTH$ redemption has no matching ledger reservation; manual reconciliation required."), { status: 409 });
      }
      if (redemption.accountId !== String(parsed.args.gameAccountId).toLowerCase()
        || redemption.recipient.toLowerCase() !== String(parsed.args.recipient).toLowerCase()
        || redemption.amount !== parsed.args.fthDollarIn.toString()) {
        throw Object.assign(new Error("Confirmed redemption does not match the reserved account, amount, or recipient."), { status: 409 });
      }
      const receipt = await ledger.submit({ id, kind: "SETTLE", account: redemption.accountId, amount: redemption.amount, data: { r: redemptionId, tx: txHash } });
      return { ...receipt, id, kind: "SETTLE", accountId: redemption.accountId, amount: redemption.amount };
    }
    return null;
  }

  async function readJsonBody(req) {
    req.rawBody = await readBody(req);
    if (!req.rawBody) return {};
    try { return JSON.parse(req.rawBody); } catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  }

  async function settleTransaction(req, res) {
    const body = await readJsonBody(req);
    authenticate(req, "game");
    requireWriter();
    const result = await verifiedEvents(body.txHash);
    if (result.pending) return json(res, 202, { status: "confirming", confirmations: result.confirmations || 0, requiredConfirmations: confirmations });
    if (!result.events.length) return json(res, 422, { error: "No recognized bridge event was found in the confirmed transaction." });
    const settled = [];
    for (const event of result.events) {
      const entry = await settleEvent(event);
      if (entry) settled.push(entry);
    }
    counters.lastSettlementAt = new Date().toISOString();
    return json(res, 200, {
      status: settled.length ? "settled" : "no-ledger-change",
      transactionHash: body.txHash,
      events: settled.map((entry) => ({ hash: entry.hash, height: entry.height, id: entry.id, kind: entry.kind, accountId: entry.accountId, amount: entry.amount })),
      ignored: result.events.map((event) => event.parsed.name).filter((name) => !["FthgConverted", "StakeClaimed", "FthDollarRedeemed"].includes(name)),
    });
  }

  async function reserveRedemption(req, res) {
    const body = await readJsonBody(req);
    authenticate(req, "game");
    requireWriter();
    requireBridge();
    const accountId = asBytes32(body.gameAccountId, "gameAccountId");
    const redemptionId = asBytes32(body.redemptionId, "redemptionId");
    const amount = asPositiveInteger(body.amount, "amount");
    if (!ethers.isAddress(body.recipient)) throw Object.assign(new Error("recipient must be a valid Ethereum address."), { status: 400 });
    const recipient = ethers.getAddress(body.recipient);
    if (recipient === ethers.ZeroAddress) throw Object.assign(new Error("recipient cannot be the zero address."), { status: 400 });
    const fthgOut = await bridgeContract.quoteFthgOut(amount);
    if (fthgOut === 0n) throw Object.assign(new Error("Redemption amount is too small to return any FTHG at the current quote."), { status: 400 });
    const minFthgOut = body.minFthgOut === undefined ? fthgOut : asPositiveInteger(body.minFthgOut, "minFthgOut");
    const previous = ledger.redemption(redemptionId);
    if (previous && (previous.accountId !== accountId || previous.amount !== amount.toString() || previous.recipient !== recipient)) {
      throw Object.assign(new Error("Redemption ID conflicts with a previous reservation."), { status: 409 });
    }
    if (previous && previous.status !== "reserved") throw Object.assign(new Error(`Redemption is already ${previous.status}.`), { status: 409 });
    if (previous && previous.expiresAt <= Date.now()) {
      throw Object.assign(new Error("Redemption quote has expired; cancel it before creating a new redemption ID."), { status: 409 });
    }
    const expiresAt = previous ? previous.expiresAt : Date.now() + 120_000;
    const receipt = await ledger.submit({
      id: `redemption:reserve:${redemptionId}`,
      kind: "RESERVE",
      account: accountId,
      amount: amount.toString(),
      data: { r: redemptionId, to: recipient, exp: expiresAt },
    });
    return json(res, 200, {
      status: "reserved",
      redemptionId,
      gameAccountId: accountId,
      fthDollarIn: amount.toString(),
      quoteFthgOut: fthgOut.toString(),
      minFthgOut: minFthgOut.toString(),
      deadline: Math.floor(expiresAt / 1000),
      expiresAt,
      ledgerHeight: receipt.height,
      transaction: receipt.hash,
    });
  }

  async function cancelRedemption(req, res, rawId) {
    authenticate(req, "game");
    requireWriter();
    const redemptionId = asBytes32(rawId, "redemptionId");
    const current = ledger.redemption(redemptionId);
    if (!current) return json(res, 404, { error: "Redemption reservation was not found." });
    if (current.status !== "reserved") return json(res, 409, { error: `Redemption is already ${current.status}.` });
    if (Date.now() < current.expiresAt + redemptionCancelGraceMs) {
      return json(res, 409, { error: "Redemption cannot be released until its on-chain deadline and confirmation grace period have passed." });
    }
    const receipt = await ledger.submit({
      id: `redemption:release:${redemptionId}`,
      kind: "RELEASE",
      account: current.accountId,
      amount: current.amount,
      data: { r: redemptionId, why: "service_cancelled" },
    });
    return json(res, 200, { status: "released", ledgerHeight: receipt.height, transaction: receipt.hash });
  }

  function accountView(accountId, limit) {
    const wallet = accountWallet(accountId);
    return {
      accountId,
      wallet,
      fthDollar: ledger.balance(accountId),
      nonce: ledger.nonce(accountId),
      history: ledger.accountHistory(accountId, limit),
      profile: wallet ? publicProfile(ledger.profile(wallet)) : null,
      ledgerHeight: ledger.height,
    };
  }

  function search(query) {
    const q = String(query || "").trim();
    if (/^\d+$/.test(q)) return ledger.block(Number(q)) ? { type: "block", height: Number(q) } : null;
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      if (ledger.tx(q)) return { type: "tx", hash: q.toLowerCase() };
      return { type: "account", accountId: q.toLowerCase() };
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { type: "account", accountId: walletAccountId(q) };
    const owner = ledger.usernameOwner(q.replace(/^@/, ""));
    if (owner) return { type: "account", accountId: walletAccountId(owner) };
    return null;
  }

  async function handleFth(req, res, url) {
    const route = url.pathname.slice("/api/v1/fth".length);
    if (req.method === "POST" && route === "/transfers") return submitTransfer(req, res);
    if (req.method === "POST" && route === "/sql") {
      rateLimit(req, "sql", 60);
      const input = await readJsonBody(req);
      return json(res, 200, ledger.sqlQuery(input.query));
    }
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
    if (route === "/stats") {
      return json(res, 200, {
        ledger: ledger.summary(),
        node: nodeInfo(),
        latestBlocks: ledger.latestBlocks({ limit: Number(url.searchParams.get("blocks") || 8) }),
        latestTransactions: ledger.latestTransactions(Number(url.searchParams.get("transactions") || 10)),
        richList: ledger.richList(Number(url.searchParams.get("holders") || 10)),
        checkedAt: new Date().toISOString(),
      });
    }
    if (route === "/blocks") {
      return json(res, 200, { height: ledger.height, blocks: ledger.latestBlocks({ before: url.searchParams.get("before"), limit: url.searchParams.get("limit") }) });
    }
    const blockMatch = route.match(/^\/blocks\/(\d+)$/);
    if (blockMatch) {
      const block = ledger.block(Number(blockMatch[1]));
      return block ? json(res, 200, block) : json(res, 404, { error: "Block not found." });
    }
    const txMatch = route.match(/^\/tx\/(0x[0-9a-fA-F]{64})$/);
    if (txMatch) {
      const tx = ledger.tx(txMatch[1]);
      return tx ? json(res, 200, tx) : json(res, 404, { error: "Transaction not found." });
    }
    if (route === "/transactions") return json(res, 200, { transactions: ledger.latestTransactions(Number(url.searchParams.get("limit") || 25)) });
    const accountMatch = route.match(/^\/accounts\/(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/);
    if (accountMatch) return json(res, 200, accountView(normalizeAccount(accountMatch[1]), url.searchParams.get("limit")));
    if (route === "/rich-list") return json(res, 200, { supply: ledger.summary().supply, holders: ledger.richList(Number(url.searchParams.get("limit") || 50)) });
    if (route === "/sql/schema") return json(res, 200, { tables: ledger.sqlSchema() });
    if (route === "/sql") {
      rateLimit(req, "sql", 60);
      return json(res, 200, ledger.sqlQuery(url.searchParams.get("q")));
    }
    if (route === "/search") {
      const result = search(url.searchParams.get("q"));
      return result ? json(res, 200, result) : json(res, 404, { error: "Nothing matched that block, transaction, account, wallet, or username." });
    }
    if (route === "/sync") {
      const from = Math.max(0, Number(url.searchParams.get("from") || 0));
      return json(res, 200, { height: ledger.height, tipHash: ledger.tipHash, blocks: ledger.blocksFrom(from, Number(url.searchParams.get("limit") || SYNC_PAGE)) });
    }
    if (route === "/files") {
      return json(res, 200, { layout: STORAGE_LAYOUT, height: ledger.height, tipHash: ledger.tipHash, writerPublicKey: ledger.summary().writerPublicKey, files: ledger.store.manifest() });
    }
    const fileMatch = route.match(/^\/files\/(\d{4}\/\d{4}-\d{2}-\d{2}\.jsonl)$/);
    if (fileMatch) {
      let content;
      try { content = ledger.store.rawFile(fileMatch[1]); } catch { return json(res, 404, { error: "Ledger file not found." }); }
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // Past days are immutable; today's file is still growing.
        "Cache-Control": fileMatch[1].includes(today) ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="fth-${path.basename(fileMatch[1])}"`,
      });
      res.end(content);
      return true;
    }
    return json(res, 404, { error: "FTH$ ledger route not found." });
  }

  async function handle(req, res) {
    if (!req.url || !req.url.startsWith("/api/v1/")) return false;
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/v1/fth" || url.pathname.startsWith("/api/v1/fth/")) {
        await handleFth(req, res, url);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/admin/config") {
        const wallets = String(env.FEATHERAL_ADMIN_WALLETS || "").split(",").map((item) => item.trim()).filter((item) => ethers.isAddress(item)).map((item) => ethers.getAddress(item.toLowerCase()));
        return json(res, 200, { adminWallets: wallets, fthgAdminWallets: [SOURCE_ADDRESS, RESERVE_ADDRESS] });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health") {
        return json(res, 200, {
          status: "ok",
          nodeId,
          mode,
          storage: STORAGE_LAYOUT,
          height: ledger.height,
          tipHash: ledger.tipHash,
          configured: mode !== "unconfigured",
          checkedAt: new Date().toISOString(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/stats") {
        const stats = await getPublicStats();
        return json(res, stats.ready.find((item) => item.key === "chain" && !item.ready) ? 503 : 200, stats);
      }
      if (req.method === "GET" && url.pathname === "/api/v1/quote") {
        requireBridge();
        const amount = asPositiveInteger(url.searchParams.get("amount"), "amount");
        const direction = url.searchParams.get("direction");
        let output;
        if (direction === "fthg-to-fthdollar") output = await bridgeContract.quoteFthDollarOut(amount);
        else if (direction === "fthdollar-to-fthg") output = await bridgeContract.quoteFthgOut(amount);
        else throw Object.assign(new Error("direction must be fthg-to-fthdollar or fthdollar-to-fthg."), { status: 400 });
        return json(res, 200, { direction, amountIn: amount.toString(), amountOut: output.toString(), unit: "18-decimal base units", quoteIsIndicative: true });
      }
      const walletMatch = url.pathname.match(/^\/api\/v1\/wallets\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === "GET" && walletMatch) {
        const address = ethers.getAddress(walletMatch[1].toLowerCase());
        const view = accountView(walletAccountId(address), url.searchParams.get("limit"));
        return json(res, 200, { address, gameAccountId: view.accountId, ...view });
      }
      const profileMatch = url.pathname.match(/^\/api\/v1\/profiles\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === "GET" && profileMatch) return json(res, 200, { profile: publicProfile(ledger.profile(profileMatch[1])) });
      if (req.method === "POST" && url.pathname === "/api/v1/profiles") {
        await updateProfile(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/settlements") {
        await settleTransaction(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/redemptions/reserve") {
        await reserveRedemption(req, res);
        return true;
      }
      const cancelMatch = url.pathname.match(/^\/api\/v1\/redemptions\/([0-9a-fA-Fx]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        await readJsonBody(req);
        await cancelRedemption(req, res, cancelMatch[1]);
        return true;
      }
      const accountMatch = url.pathname.match(/^\/api\/v1\/accounts\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === "GET" && accountMatch) {
        authenticate(req, "game");
        const accountId = accountMatch[1].toLowerCase();
        return json(res, 200, { gameAccountId: accountId, ...ledger.balance(accountId), nonce: ledger.nonce(accountId), ledgerHeight: ledger.height });
      }
      return json(res, 404, { error: "API route not found." });
    } catch (error) {
      const status = Number(error.status)
        || (error.message.includes("Unauthorized") || error.message.includes("signature") || error.message.includes("nonce") ? 401
          : error.message.includes("Insufficient") || error.message.includes("conflict") || error.message.includes("already") ? 409
            : 400);
      if (status >= 500) logger.error("Token API request failed:", error);
      if (res.headersSent) {
        res.end();
        return true;
      }
      return json(res, status, { error: error.message || "Request failed." });
    }
  }

  // Readers pull blocks from the writer API (or re-scan a file copy) and re-validate every block.
  async function syncFromUpstream() {
    if (syncing || mode !== "reader") return;
    syncing = true;
    try {
      if (!upstream) {
        ledger.syncFromDisk();
      } else {
        let more = true;
        while (more) {
          const response = await fetch(`${upstream}/api/v1/fth/sync?from=${ledger.height + 1}&limit=${SYNC_PAGE}`, { signal: AbortSignal.timeout(15_000) });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`Writer returned HTTP ${response.status}: ${body.error || ""}`);
          if (!Array.isArray(body.blocks)) throw new Error("Writer returned an invalid sync page.");
          for (const block of body.blocks) ledger.importBlock(block);
          more = body.blocks.length > 0 && ledger.height < Number(body.height);
        }
      }
      counters.lastSyncAt = new Date().toISOString();
      counters.lastSyncError = "";
    } catch (error) {
      counters.syncErrors += 1;
      counters.lastSyncError = error.message;
      logger.error(`[${nodeId}] FTH$ ledger sync failed: ${error.message}`);
    } finally {
      syncing = false;
    }
  }

  function start() {
    if (mode === "reader") {
      syncFromUpstream();
      syncTimer = setInterval(syncFromUpstream, Math.max(1000, Number(setting("SYNC_INTERVAL_MS")) || 5000));
      syncTimer.unref?.();
    }
  }

  function close() {
    clearInterval(syncTimer);
    ledger.close();
  }

  return { handle, start, close, ledger, mode, nodeId, syncFromUpstream };
}

module.exports = { createTokenApi, serviceRequestHeaders, walletGameAccountId };
