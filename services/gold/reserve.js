"use strict";

const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { canonical } = require("../fth-ledger/codec");
const { verifyTransfer, walletAccountId } = require("../fth-ledger/transfer");
const { assertFreshSignature } = require("../identity/profile");
const pricing = require("../../shared/gold-pricing");

const TOKEN_ADDRESS = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_ADDRESS = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_ADDRESS = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const TREASURY = `0x${crypto.createHash("sha256").update("featheral:dollar:system:treasury").digest("hex")}`;
const REDEMPTION_ESCROW = `0x${crypto.createHash("sha256").update("featheral:dollar:gold:redemption-escrow").digest("hex")}`;
const RATE = 1000n;
const GAME_UNIT = 10n ** 14n;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function integer(value, positive = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) throw fail("Invalid reserve base-unit amount.");
  const number = BigInt(value);
  if (positive && !number) throw fail("Reserve amount must be positive.");
  return number;
}
function payload(tx) {
  const { signature: _signature, ...data } = tx.d;
  return canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, d: data, t: tx.t });
}
function evidence(value) {
  if (!value || !Number.isSafeInteger(value.block) || value.block < 0 || !ethers.isHexString(value.hash, 32)) {
    throw fail("Reserve operation requires confirmed block evidence.");
  }
}
function conversionMessage({ amount, nonce, issuedAt, pricing: authorization }, genesisHash, sourceWallet = SOURCE_ADDRESS, reserveWallet = RESERVE_ADDRESS) {
  return ["Featheral Gold off-chain reserve conversion", `Ledger: ${genesisHash}`, "Chain ID: 1",
    `From: ${sourceWallet}`, `To: ${reserveWallet}`, `FTHG base units: ${amount}`,
    ...(authorization ? [`Pricing: ${pricing.POLICY}`, `Quote commitment: ${authorization}`] : [`Rate: ${RATE} FTH$ per FTHG`]),
    `Nonce: ${nonce}`, `Issued at: ${issuedAt}`,
    "This reserves an off-chain obligation. It does not transfer Ethereum tokens."].join("\n");
}
function goldEntries(ledger, data) {
  if (data.op === "resource-liquidity") return [
    { account: data.account, delta: data.dollars },
    ...(data.fthg === "0" ? [{ account: TREASURY, delta: (-BigInt(data.dollars)).toString() }] : []),
  ];
  if (data.op === "refill-market") return [
    { account: data.account, delta: data.dollars },
    { account: TREASURY, delta: (-BigInt(data.dollars)).toString() },
  ];
  if (data.op === "fund-market") return [
    { account: data.account, delta: data.dollars },
    { account: TREASURY, delta: (BigInt(data.fthg) * RATE - BigInt(data.dollars)).toString() },
  ];
  if (data.op === "redeem") return [
    { account: walletAccountId(data.transfer.wallet), delta: (-BigInt(data.transfer.amount)).toString() },
    { account: REDEMPTION_ESCROW, delta: data.transfer.amount },
  ];
  if (data.op === "convert") {
    const dollars = data.dollars === undefined ? BigInt(data.request.amount) * RATE : BigInt(data.dollars);
    return [
      { account: walletAccountId(ledger.genesis.sourceWallet || SOURCE_ADDRESS), delta: dollars.toString() },
      { account: REDEMPTION_ESCROW, delta: (-dollars).toString() },
    ];
  }
  return [];
}

// Gold authorization and Dollar balance changes replay together in the same signed journal.
function validateGoldTransaction(ledger, tx, fresh, now) {
  const key = ledger.genesis?.goldPublicKey;
  if (!key || tx.a !== "" || tx.v !== "0" || typeof tx.d.signature !== "string"
    || !crypto.verify(null, Buffer.from(payload(tx)), key, Buffer.from(tx.d.signature, "base64"))) {
    throw fail("Gold reserve signature does not verify.");
  }
  const data = tx.d, state = ledger.goldReserve;
  const sourceWallet = ledger.genesis.sourceWallet || SOURCE_ADDRESS;
  const reserveWallet = ledger.genesis.reserveWallet || RESERVE_ADDRESS;
  if (data.op === "initialize") {
    if (state) throw fail("Origin reserve cap is already initialized and cannot be increased.");
    const cap = integer(data.cap);
    evidence(data.evidence);
    if (data.rate !== RATE.toString() || cap * RATE > ethers.MaxUint256) throw fail("Invalid finite reserve rate or cap.");
    return () => { ledger.goldReserve = {
      cap: data.cap, rate: data.rate, evidence: data.evidence, allocated: "0", settledIn: "0",
      released: "0", settledOut: "0", recycledIn: "0", conversionNonce: 0, pools: {}, receipts: {},
    }; };
  }
  if (!state) throw fail("Finite Gold reserve is not initialized.");
  if (data.op === "resource-liquidity") {
    const target = Object.hasOwn(ledger.genesis.goldMarkets || {}, data.asset) ? ledger.genesis.goldMarkets[data.asset] : null;
    const expected = `0x${crypto.createHash("sha256").update(`featheral:dollar:game:pool:${data.asset}`).digest("hex")}`;
    if (!["wood", "water", "metal", "oil"].includes(data.asset) || !target || data.account !== expected)
      throw fail("Origin liquidity requires a genesis resource market.");
    const seed = state.pools[data.asset], dollars = integer(data.dollars, true), fthg = integer(data.fthg);
    const origin = integer(data.origin), reserve = integer(data.reserve);
    evidence(data.evidence);
    if (dollars % GAME_UNIT || BigInt(ledger.balance(expected).available) + dollars > BigInt(Number.MAX_SAFE_INTEGER) * GAME_UNIT)
      throw fail("Resource liquidity exceeds its accounting funding limit.");
    if (seed ? data.quantity !== 0 : !Number.isSafeInteger(data.quantity) || data.quantity < 2 || data.quantity > target.quantity)
      throw fail("Resource seed quantity is invalid or already applied.");
    if (!seed) {
      const lots = dollars / BigInt(target.pricePerLot);
      if (BigInt(data.quantity) !== (lots < BigInt(target.quantity) ? lots : BigInt(target.quantity)))
        throw fail("Resource seed quantity exceeds its funded whole lots.");
    }
    if (reserve < BigInt(state.settledIn) - BigInt(state.settledOut)) throw fail("Confirmed backing is not covered.");
    if (fthg) {
      if (!origin || fthg > BigInt(state.cap) - BigInt(state.allocated)
        || origin < BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn) + fthg)
        throw fail("Origin cannot cover further allocations; settle pending Ethereum obligations.");
      const quoted = pricing.quote(state, "fthg-to-fthdollar", fthg);
      if (dollars !== quoted / GAME_UNIT * GAME_UNIT) throw fail("Resource conversion differs from the active Gold quote.");
    } else if (origin !== 0n || BigInt(state.allocated) + BigInt(state.recycledIn) !== BigInt(state.settledIn)
      || dollars > BigInt(ledger.balance(TREASURY).available)) {
      throw fail("Dollar treasury fallback requires zero verified origin and sufficient existing funds.");
    }
    return () => {
      ledger.account(expected).balance += dollars;
      if (fthg) {
        ledger.supply += dollars;
        state.allocated = (BigInt(state.allocated) + fthg).toString();
      } else ledger.account(TREASURY).balance -= dollars;
      if (!seed) state.pools[data.asset] = { quantity: data.quantity, dollars: data.dollars, account: expected };
    };
  }
  if (data.op === "refill-market") {
    const target = Object.hasOwn(ledger.genesis.goldMarkets || {}, data.asset) ? ledger.genesis.goldMarkets[data.asset] : null;
    const pool = state.pools[data.asset];
    if (!["wood", "water", "metal", "oil"].includes(data.asset) || !target || !pool || data.account !== pool.account)
      throw fail("Treasury refill requires an initialized resource market.");
    const dollars = integer(data.dollars, true);
    const balance = BigInt(ledger.balance(pool.account).available);
    const ceiling = BigInt(target.pricePerLot) * BigInt(target.quantity);
    if (balance >= ceiling / 4n) throw fail("Resource refill requires low market funds.");
    if (dollars % GAME_UNIT || balance + dollars > ceiling || balance + dollars > BigInt(Number.MAX_SAFE_INTEGER) * GAME_UNIT
      || dollars > BigInt(ledger.balance(TREASURY).available))
      throw fail("Resource refill exceeds existing treasury funds or the market funding limit.");
    return () => {
      ledger.account(TREASURY).balance -= dollars;
      ledger.account(pool.account).balance += dollars;
    };
  }
  if (data.op === "pricing-policy") {
    if (state.pricingPolicy || data.policy !== pricing.POLICY || BigInt(state.cap) <= 0n) throw fail("Invalid or already activated Gold pricing policy.");
    pricing.position(state);
    return () => { state.pricingPolicy = data.policy; };
  }
  if (data.op === "fund-market") {
    const target = Object.hasOwn(ledger.genesis.goldMarkets || {}, data.asset) ? ledger.genesis.goldMarkets[data.asset] : null;
    if (!target || state.pools[data.asset] || !Number.isSafeInteger(data.quantity) || data.quantity < 2 || data.quantity > target.quantity) {
      throw fail("Market bootstrap is invalid or already completed.");
    }
    const expected = `0x${crypto.createHash("sha256").update(`featheral:dollar:game:pool:${data.asset}`).digest("hex")}`;
    if (data.account !== expected) throw fail("Market fund account does not match its asset.");
    const dollars = integer(data.dollars, true), fthg = integer(data.fthg);
    if (dollars !== integer(target.pricePerLot, true) * BigInt(data.quantity)) throw fail("Market funding differs from its immutable base-price target.");
    if (dollars % GAME_UNIT || dollars > BigInt(Number.MAX_SAFE_INTEGER) * GAME_UNIT) throw fail("Liquidity exceeds game accounting limits.");
    const treasury = BigInt(ledger.balance(TREASURY).available);
    const deficit = dollars > treasury ? dollars - treasury : 0n;
    if (fthg * RATE !== deficit || BigInt(state.allocated) + fthg > BigInt(state.cap)) {
      throw fail("Allocation exceeds the finite origin cap or does not exactly fund the deficit.");
    }
    evidence(data.evidence);
    return () => {
      ledger.account(TREASURY).balance += deficit - dollars;
      ledger.account(expected).balance += dollars;
      ledger.supply += deficit;
      state.allocated = (BigInt(state.allocated) + fthg).toString();
      state.pools[data.asset] = { quantity: data.quantity, dollars: data.dollars, account: expected };
    };
  }
  if (data.op === "redeem") {
    const transfer = verifyTransfer(data.transfer);
    if (![sourceWallet.toLowerCase(), reserveWallet.toLowerCase()].includes(transfer.wallet.toLowerCase())
      || transfer.to !== REDEMPTION_ESCROW || transfer.from !== walletAccountId(transfer.wallet)
      || transfer.memo !== (state.pricingPolicy
        ? quoteMemo(ledger.headers[0].H, state, "fthdollar-to-fthg", transfer.amount)
        : `Gold:${ledger.headers[0].H.slice(2, 58)}`)) {
      throw fail("Reserve conversion is restricted to the two configured wallets and redemption escrow.");
    }
    if (fresh) assertFreshSignature(transfer.issuedAtMs, now, "Reserve conversion");
    const fthg = integer(data.fthg, true), dollars = BigInt(transfer.amount);
    if (fthg !== pricing.quote(state, "fthdollar-to-fthg", dollars) || fthg > BigInt(state.settledIn) - BigInt(state.released)) {
      throw fail("Redemption requires sufficient confirmed, uncommitted FTHG backing.");
    }
    if (transfer.nonce !== ledger.nonce(transfer.from) + 1 || BigInt(ledger.balance(transfer.from).available) < dollars) {
      throw fail("Reserve conversion nonce or available FTH$ balance is invalid.");
    }
    return () => {
      ledger.account(transfer.from).balance -= dollars;
      ledger.account(REDEMPTION_ESCROW).balance += dollars;
      ledger.nonces.set(transfer.from, transfer.nonce);
      state.released = (BigInt(state.released) + fthg).toString();
    };
  }
  if (data.op === "convert") {
    const amount = integer(data.request?.amount, true), request = data.request;
    const dollars = pricing.quote(state, "fthg-to-fthdollar", amount);
    if (state.pricingPolicy ? request.pricing !== quoteMemo(ledger.headers[0].H, state, "fthg-to-fthdollar", amount)
      || data.dollars !== dollars.toString() : request.pricing !== undefined || data.dollars !== undefined) {
      throw fail("Gold quote changed. Refresh and authorize a new conversion.");
    }
    const issuedAt = Date.parse(request.issuedAt);
    if (!Number.isSafeInteger(request.nonce) || request.nonce !== state.conversionNonce + 1
      || typeof request.issuedAt !== "string" || !Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== request.issuedAt
      || !ethers.isHexString(request.signature)) {
      throw fail("Invalid or replayed origin conversion authorization.");
    }
    let signer;
    try { signer = ethers.verifyMessage(conversionMessage(request, ledger.headers[0].H, sourceWallet, reserveWallet), request.signature); }
    catch { throw fail("Origin conversion signature is malformed."); }
    if (signer.toLowerCase() !== sourceWallet.toLowerCase()) throw fail("Origin conversion signature does not match the configured wallet.");
    if (fresh) assertFreshSignature(issuedAt, now, "Origin conversion");
    if (BigInt(state.recycledIn) + amount > BigInt(state.settledOut)
      || BigInt(ledger.balance(REDEMPTION_ESCROW).available) < dollars) {
      throw fail("Conversion requires returned FTHG and locked redemption FTH$; no new supply is permitted.");
    }
    return () => {
      ledger.account(REDEMPTION_ESCROW).balance -= dollars;
      ledger.account(walletAccountId(sourceWallet)).balance += dollars;
      state.recycledIn = (BigInt(state.recycledIn) + amount).toString();
      state.conversionNonce = request.nonce;
    };
  }
  if (data.op === "sync") {
    evidence(data.evidence);
    const amount = integer(data.fthg, true);
    if (!["origin-to-reserve", "reserve-to-origin"].includes(data.direction)
      || !ethers.isHexString(data.txHash, 32) || !Number.isSafeInteger(data.logIndex) || data.logIndex < 0) {
      throw fail("Invalid reserve settlement receipt.");
    }
    const id = `${data.txHash.toLowerCase()}:${data.logIndex}`;
    if (state.receipts[id]) throw fail("Ethereum transfer was already reconciled.");
    const incoming = data.direction === "origin-to-reserve";
    const limit = incoming ? BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn) : BigInt(state.released) - BigInt(state.settledOut);
    if (amount > limit) throw fail("Ethereum receipt exceeds the outstanding settlement obligation.");
    return () => {
      const field = incoming ? "settledIn" : "settledOut";
      state[field] = (BigInt(state[field]) + amount).toString();
      state.receipts[id] = { direction: data.direction, fthg: data.fthg, evidence: data.evidence };
    };
  }
  throw fail("Unknown Gold reserve operation.");
}

function createReserveEngine({ ledger, privateKey, provider, confirmations = 12, beforeMutation = () => {} }) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw fail("Gold confirmations must be a positive integer.");
  const key = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (ledger.genesis.goldPublicKey !== key) throw fail("Gold key is not authorized by this isolated ledger genesis.");
  const token = new ethers.Contract(TOKEN_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
  const sourceWallet = ledger.genesis.sourceWallet || SOURCE_ADDRESS;
  const reserveWallet = ledger.genesis.reserveWallet || RESERVE_ADDRESS;
  const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  let queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  function commit(id, data, fresh = false) {
    beforeMutation();
    if (recover(id, data)) return;
    const tx = { i: id, k: "GOLD", a: "", v: "0", d: data, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(payload(tx)), privateKey).toString("base64");
    ledger.commitAuthorized(tx, { fresh });
  }
  function recover(id, data) {
    const hash = ledger.ids.get(id);
    if (!hash) return false;
    const existing = ledger.findTx(hash);
    const { signature: _signature, ...original } = existing.tx.d;
    if (canonical(original) !== canonical(data)) throw fail("Reserve request conflicts with an existing transaction.");
    ledger.commitAuthorized(existing.tx);
    return true;
  }
  async function holdings() {
    if (Number((await provider.getNetwork()).chainId) !== 1) throw fail("Gold reserve requires Ethereum Mainnet.");
    const [head, finalized] = await Promise.all([provider.getBlockNumber(), provider.getBlock("finalized")]);
    if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < 0) throw fail("Ethereum finalized block is unavailable.");
    const block = Math.min(head - confirmations + 1, finalized.number);
    if (block < 0) throw fail("Ethereum finality is not available.");
    const header = await provider.getBlock(block);
    if (!header || !ethers.isHexString(header.hash, 32)) throw fail("Confirmed Ethereum block is unavailable.");
    const [origin, reserve] = await Promise.all([
      token.balanceOf(sourceWallet, { blockTag: block }), token.balanceOf(reserveWallet, { blockTag: block }),
    ]);
    const canonicalBlock = await provider.getBlock(block);
    if (canonicalBlock?.hash !== header.hash) throw fail("Ethereum block changed during reserve verification.");
    return { origin, reserve, evidence: { block, hash: header.hash } };
  }
  function status() {
    const state = ledger.goldReserve;
    return { enabled: true, initialized: Boolean(state), rate: RATE.toString(), tokenAddress: TOKEN_ADDRESS,
      sourceWallet, reserveWallet, treasuryAccount: TREASURY, redemptionEscrow: REDEMPTION_ESCROW,
      lockedRedemptionDollars: ledger.balance(REDEMPTION_ESCROW).balance,
      genesisHash: ledger.headers[0].H, mode: ledger.genesis.reserveMode || "isolated", ethereumSyncEnabled: false,
      marketFundingPolicy: "origin-first-finalized-zero-treasury-v1",
      ...(state ? { ...state, ...(state.pricingPolicy ? {
        spotRateFthDollarPerFthg: pricing.spot(state).toString(),
        netAllocated: pricing.position(state).net.toString(), baseTradingRate: "10000",
      } : {}), remaining: (BigInt(state.cap) - BigInt(state.allocated)).toString(),
        pendingIn: (BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn)).toString(),
        pendingOut: (BigInt(state.released) - BigInt(state.settledOut)).toString(),
        redeemableBacking: (BigInt(state.settledIn) - BigInt(state.released)).toString(),
        exhausted: state.allocated === state.cap } : {}),
      warning: "Off-chain allocations are pending obligations, not Ethereum transfers. Only confirmed incoming backing is redeemable.",
    };
  }
  return {
    status,
    activatePricing: () => serialize(async () => {
      if (!ledger.goldReserve) throw fail("Initialize the origin reserve before activating pricing.");
      if (!ledger.goldReserve.pricingPolicy) commit("gold:pricing:origin-linear-v1", { op: "pricing-policy", policy: pricing.POLICY });
      return status();
    }),
    quote(direction, amount) {
      const state = ledger.goldReserve;
      if (!state) throw fail("Finite Gold reserve is not initialized.", 503);
      const output = pricing.quote(state, direction, amount);
      if (output > ethers.MaxUint256) throw fail("Conversion exceeds uint256 accounting limits.");
      return { direction, amountIn: String(amount), amountOut: output.toString(),
        pricingPolicy: state.pricingPolicy || "fixed-v1",
        authorization: state.pricingPolicy ? quoteMemo(ledger.headers[0].H, state, direction, amount) : null };
    },
    activity({ limit = 20, cursor } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || cursor !== undefined && (typeof cursor !== "string" || !/^\d+:\d+$/.test(cursor))) throw fail("Invalid reserve history query.", 400);
      let height = ledger.height, index = ledger.rawBlock(height).x.length - 1;
      if (cursor !== undefined) {
        [height, index] = cursor.split(":").map(Number);
        if (!Number.isSafeInteger(height) || height < 0 || height > ledger.height || !Number.isSafeInteger(index)
          || index < 0 || index >= ledger.rawBlock(height).x.length) throw fail("Invalid reserve history cursor.", 400);
      }
      const items = [];
      let scanned = 0;
      while (height >= 0 && items.length < limit && scanned < 2000) {
        if (index < 0) {
          height--;
          if (height >= 0) index = ledger.rawBlock(height).x.length - 1;
          scanned++;
          continue;
        }
        const tx = ledger.rawBlock(height).x[index], data = tx.d;
        if (tx.k === "GOLD" && ["fund-market", "refill-market", "resource-liquidity", "redeem", "convert", "sync"].includes(data.op)) {
          const incoming = data.op === "fund-market" || data.op === "resource-liquidity" || data.op === "convert" || data.direction === "origin-to-reserve";
          const fthg = data.op === "refill-market" ? "0" : data.op === "convert" ? data.request.amount : data.fthg;
          const treasury = data.op === "refill-market" || ["fund-market", "resource-liquidity"].includes(data.op) && BigInt(fthg) === 0n;
          items.push({ id: tx.i, hash: ledger.ids.get(tx.i), height, time: new Date(tx.t).toISOString(),
            operation: data.op, direction: treasury ? "treasury-to-market" : incoming ? "origin-to-reserve" : "reserve-to-origin",
            from: treasury ? TREASURY : incoming ? sourceWallet : reserveWallet,
            to: treasury ? data.account : incoming ? reserveWallet : sourceWallet,
            fthg, dollars: data.op === "sync" ? "0" : data.op === "redeem" ? data.transfer.amount
              : data.op === "convert" ? data.dollars ?? (BigInt(fthg) * RATE).toString() : data.dollars,
            treasuryDollars: treasury ? data.dollars : data.op === "fund-market" ? (BigInt(data.dollars) - BigInt(fthg) * RATE).toString() : "0",
            asset: data.asset || null, quantity: data.quantity || null,
            recordType: data.op === "sync" ? "ethereum-confirmed" : BigInt(fthg) ? "off-chain-obligation" : "treasury-circulation",
            ethereumTx: data.txHash || null, logIndex: data.logIndex ?? null });
        }
        while (height >= 0 && index < 0) { height--; if (height >= 0) index = ledger.rawBlock(height).x.length - 1; }
        scanned++;
        index--;
        if (index < 0) { height--; if (height >= 0) index = ledger.rawBlock(height).x.length - 1; }
      }
      return { items, nextCursor: height >= 0 ? `${height}:${index}` : null, ledgerHeight: ledger.height,
        note: "Off-chain entries record obligations, not Ethereum transfers. Settlement receipts are separate; pending totals are pooled." };
    },
    initialize: () => serialize(async () => {
      if (!ledger.goldReserve) {
        const balance = await holdings();
        commit("gold:initialize", { op: "initialize", cap: balance.origin.toString(), rate: RATE.toString(), evidence: balance.evidence });
      }
      return status();
    }),
    resourceLiquidity: (asset, required = null) => serialize(async () => {
      if (!["wood", "water", "metal", "oil"].includes(asset) || required !== null && (typeof required !== "bigint" || required < 0n))
        throw fail("Invalid resource funding request.");
      beforeMutation();
      const target = ledger.genesis.goldMarkets?.[asset], initial = ledger.goldReserve;
      if (!target || !initial) throw fail("Initialize the finite resource reserve first.", 503);
      const account = `0x${crypto.createHash("sha256").update(`featheral:dollar:game:pool:${asset}`).digest("hex")}`;
      const base = BigInt(target.pricePerLot) * BigInt(target.quantity);
      const minimum = required ?? base, desired = minimum > base ? minimum : base;
      if (desired > BigInt(Number.MAX_SAFE_INTEGER) * GAME_UNIT) throw fail("Resource sale exceeds supported funding.");
      if (initial.pools[asset] && BigInt(ledger.balance(account).available) >= minimum) return initial.pools[asset];
      const balance = await holdings();
      beforeMutation();
      const state = ledger.goldReserve, current = BigInt(ledger.balance(account).available);
      const deficit = desired > current ? desired - current : 0n;
      if (!deficit) return state.pools[asset];
      const pending = BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn);
      if (balance.origin < pending) throw fail("Origin holdings cannot cover pending obligations. Reconcile authorized Ethereum settlement first.");
      let dollars, fthg = 0n;
      if (balance.origin === 0n) {
        const treasury = BigInt(ledger.balance(TREASURY).available);
        dollars = (deficit < treasury ? deficit : treasury) / GAME_UNIT * GAME_UNIT;
      } else {
        const remaining = BigInt(state.cap) - BigInt(state.allocated);
        const held = balance.origin > pending ? balance.origin - pending : 0n;
        const priced = state.pricingPolicy ? pricing.position(state).cap - pricing.position(state).net : remaining;
        let high = [remaining, held, priced].reduce((a, b) => a < b ? a : b);
        if (!high) throw fail("Origin allocations are exhausted but the wallet is not zero. Settle pending Ethereum transfers before treasury fallback.");
        if (pricing.quote(state, "fthg-to-fthdollar", high) < deficit) fthg = high;
        else {
          let low = 1n;
          while (low < high) {
            const middle = (low + high) / 2n;
            if (pricing.quote(state, "fthg-to-fthdollar", middle) >= deficit) high = middle;
            else low = middle + 1n;
          }
          fthg = low;
        }
        dollars = pricing.quote(state, "fthg-to-fthdollar", fthg) / GAME_UNIT * GAME_UNIT;
      }
      if (!dollars) throw fail("Origin and available Dollar treasury cannot fund resource sales.");
      const quantity = state.pools[asset] ? 0 : Number(dollars / BigInt(target.pricePerLot) < BigInt(target.quantity)
        ? dollars / BigInt(target.pricePerLot) : BigInt(target.quantity));
      if (!state.pools[asset] && quantity < 2) throw fail("Available backing cannot initialize a two-lot resource market.");
      commit(`gold:resource:${crypto.randomUUID()}`, { op: "resource-liquidity", asset, account,
        quantity, dollars: dollars.toString(), fthg: fthg.toString(),
        origin: balance.origin.toString(), reserve: balance.reserve.toString(), evidence: balance.evidence });
      return ledger.goldReserve.pools[asset];
    }),
    fundMarket: (asset, quantity, dollars) => serialize(async () => {
      if (typeof asset !== "string" || !Number.isSafeInteger(quantity) || quantity < 2 || quantity > 10000
        || typeof dollars !== "bigint" || dollars <= 0n || dollars % BigInt(quantity)) throw fail("Invalid system liquidity target.");
      const target = Object.hasOwn(ledger.genesis.goldMarkets || {}, asset) ? ledger.genesis.goldMarkets[asset] : null;
      if (!target || quantity !== target.quantity || dollars !== BigInt(target.pricePerLot) * BigInt(quantity)) throw fail("Market is not eligible for its requested liquidity target.");
      if (ledger.goldReserve?.pools[asset]) return ledger.goldReserve.pools[asset];
      beforeMutation();
      const initial = ledger.goldReserve;
      if (!initial) throw fail("Finite reserve must be explicitly initialized first.");
      if (BigInt(ledger.balance(TREASURY).available) + (BigInt(initial.cap) - BigInt(initial.allocated)) * RATE < 2n * BigInt(target.pricePerLot)) return null;
      const balance = await holdings();
      beforeMutation();
      const state = ledger.goldReserve;
      if (!state) throw fail("Finite reserve must be explicitly initialized first.");
      if (balance.reserve < BigInt(state.settledIn) - BigInt(state.settledOut)) throw fail("Actual reserve holdings no longer cover confirmed obligations.");
      const available = BigInt(ledger.balance(TREASURY).available);
      const remaining = (BigInt(state.cap) - BigInt(state.allocated)) * RATE;
      // Fund a smaller whole-lot pool if the remaining finite budget cannot meet the target.
      const affordable = available + remaining;
      const perLot = dollars / BigInt(quantity);
      const lots = Number(affordable / perLot < BigInt(quantity) ? affordable / perLot : BigInt(quantity));
      if (lots < 2) return null;
      dollars = perLot * BigInt(lots);
      const needed = dollars > available ? dollars - available : 0n;
      if (needed % RATE) throw fail("Liquidity deficit does not map exactly to FTHG base units.");
      if (needed && balance.origin < BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn) + needed / RATE) {
        throw fail("Origin holdings no longer cover pending allocations; automatic funding is blocked.");
      }
      commit(`gold:pool:${asset}`, { op: "fund-market", asset, quantity: lots, dollars: dollars.toString(),
        fthg: (needed / RATE).toString(), account: `0x${crypto.createHash("sha256").update(`featheral:dollar:game:pool:${asset}`).digest("hex")}`,
        evidence: balance.evidence });
      return ledger.goldReserve.pools[asset];
    }),
    syncPlan: () => serialize(async () => {
      const state = status();
      if (!state.initialized) throw fail("Finite reserve is not initialized.");
      const balance = await holdings();
      const incoming = BigInt(state.pendingIn), outgoing = BigInt(state.pendingOut);
      if (balance.origin < incoming || balance.reserve < outgoing) throw fail("Actual wallet holdings cannot cover pending settlement.");
      return { ...state, actualOrigin: balance.origin.toString(), actualReserve: balance.reserve.toString(), evidence: balance.evidence,
        transfers: [
          ...(incoming ? [{ direction: "origin-to-reserve", from: sourceWallet, to: reserveWallet, amount: incoming.toString() }] : []),
          ...(outgoing ? [{ direction: "reserve-to-origin", from: reserveWallet, to: sourceWallet, amount: outgoing.toString() }] : []),
        ] };
    }),
    redeem: transfer => serialize(async () => {
      const amount = integer(transfer?.amount, true);
      const id = `gold:redeem:${String(transfer.wallet).toLowerCase()}:${transfer.nonce}`;
      const prior = ledger.ids.get(id);
      if (prior) {
        const data = ledger.findTx(prior).tx.d;
        if (canonical(data.transfer) !== canonical(transfer)) throw fail("Reserve request conflicts with an existing transaction.");
        ledger.commitAuthorized(ledger.findTx(prior).tx);
        return status();
      }
      const data = { op: "redeem", transfer, fthg: pricing.quote(ledger.goldReserve, "fthdollar-to-fthg", amount).toString() };
      if (recover(id, data)) return status();
      const balance = await holdings();
      const state = ledger.goldReserve;
      if (!state || balance.reserve < BigInt(state.settledIn) - BigInt(state.settledOut)) {
        throw fail("Actual reserve holdings no longer cover confirmed obligations.");
      }
      commit(id, data, true);
      return status();
    }),
    convert: request => serialize(async () => {
      const amount = integer(request?.amount, true);
      const id = `gold:convert:${request.nonce}`;
      const prior = ledger.ids.get(id);
      if (prior) {
        if (canonical(ledger.findTx(prior).tx.d.request) !== canonical(request)) throw fail("Reserve request conflicts with an existing transaction.");
        ledger.commitAuthorized(ledger.findTx(prior).tx);
        return status();
      }
      const data = { op: "convert", request, ...(ledger.goldReserve?.pricingPolicy
        ? { dollars: pricing.quote(ledger.goldReserve, "fthg-to-fthdollar", amount).toString() } : {}) };
      if (recover(id, data)) return status();
      const balance = await holdings(), state = ledger.goldReserve;
      if (!state || balance.origin < BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.settledIn) + amount) {
        throw fail("Actual origin holdings cannot cover this conversion.");
      }
      commit(id, data, true);
      return status();
    }),
    reconcile: (txHash, logIndex) => serialize(async () => {
      if (!ethers.isHexString(txHash, 32) || !Number.isSafeInteger(logIndex) || logIndex < 0) throw fail("Invalid sync transaction or log index.");
      const existing = ledger.goldReserve?.receipts[`${txHash.toLowerCase()}:${logIndex}`];
      if (existing) return status();
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || Number(receipt.status) !== 1) throw fail("Sync transfer is missing or reverted.");
      const balance = await holdings();
      if (receipt.blockNumber > balance.evidence.block) throw fail("Sync transfer is not yet finalized.");
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.hash !== receipt.blockHash) throw fail("Sync receipt is not on the canonical Ethereum chain.");
      const log = receipt.logs.find(log => log.index === logIndex);
      if (!log || log.address.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) throw fail("Sync receipt must be a canonical FTHG Transfer.");
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== "Transfer") throw fail("Sync receipt is not a token transfer.");
      const incoming = parsed.args.from.toLowerCase() === sourceWallet.toLowerCase() && parsed.args.to.toLowerCase() === reserveWallet.toLowerCase();
      const outgoing = parsed.args.from.toLowerCase() === reserveWallet.toLowerCase() && parsed.args.to.toLowerCase() === sourceWallet.toLowerCase();
      if (!incoming && !outgoing) throw fail("Sync is restricted to the two configured wallets.");
      if (receipt.blockNumber <= ledger.goldReserve.evidence.block) throw fail("Sync receipt predates reserve initialization.");
      const state = ledger.goldReserve;
      const required = BigInt(state.settledIn) + (incoming ? parsed.args.value : 0n)
        - BigInt(state.settledOut) - (outgoing ? parsed.args.value : 0n);
      if (balance.reserve < required) throw fail("Reserve wallet does not hold the confirmed backing being reconciled.");
      commit(`gold:sync:${txHash.toLowerCase()}:${logIndex}`, { op: "sync", direction: incoming ? "origin-to-reserve" : "reserve-to-origin",
        txHash: txHash.toLowerCase(), logIndex, fthg: parsed.args.value.toString(), evidence: { block: receipt.blockNumber, hash: block.hash } });
      return status();
    }),
  };
}

function quoteMemo(genesis, state, direction, amount) {
  return `G2:${ethers.id(pricing.commitment(genesis, state, direction, amount, pricing.quote(state, direction, amount))).slice(2, 62)}`;
}

module.exports = { createReserveEngine, validateGoldTransaction, conversionMessage, goldEntries, RATE, TREASURY, REDEMPTION_ESCROW, SOURCE_ADDRESS, RESERVE_ADDRESS };
