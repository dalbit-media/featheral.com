"use strict";

const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { BlockStore } = require("./store");
const { ZERO_HASH, canonical, txHash, blockHash } = require("./codec");
const { walletAccountId, accountWallet, verifyTransfer } = require("./transfer");
const { verifySignedProfile, assertFreshSignature } = require("../token-api/profile");
const { createFthDb, ingestFthBlock } = require("./sql");
const { validateGoldTransaction, goldEntries, TREASURY, REDEMPTION_ESCROW } = require("../gold-api/reserve");

const KINDS = new Set(["GENESIS", "CREDIT", "RESERVE", "SETTLE", "RELEASE", "TRANSFER", "PROFILE", "GAME", "GOLD", "GOLD_POLICY"]);
const VALUE_KINDS = new Set(["CREDIT", "RESERVE", "SETTLE", "RELEASE", "TRANSFER", "GAME", "GOLD"]);
const CREDIT_SOURCES = new Set(["FthgConverted", "StakeClaimed"]);
const MAX_TX_PER_BLOCK = 1000;
const MAX_PAGE = 500;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d{0,77})$/;

function ledgerError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function toKey(key) {
  if (!key) return null;
  return key instanceof crypto.KeyObject ? key : String(key).includes("PRIVATE KEY") ? crypto.createPrivateKey(key) : crypto.createPublicKey(key);
}

function clampLimit(limit, fallback, max = MAX_PAGE) {
  return Math.max(1, Math.min(max, Number(limit) || fallback));
}

// Featheral Dollar (FTH$) native L3 ledger. One writer validates and seals transactions into
// hash-chained (optionally Ed25519-signed) blocks stored as daily minified JSON files; any number of
// readers rebuild identical state by re-validating those blocks from the writer API or a file copy.
class FthLedger {
  constructor({ directory, nodeId = "local", mode = "writer", signingKey = null, writerPublicKey = null, blockIntervalMs = 1000, cacheBlocks = 4096, genesis = {} } = {}) {
    if (!directory) throw new Error("FTH$ ledger directory is required.");
    this.store = new BlockStore(directory);
    this.nodeId = nodeId;
    this.mode = mode;
    this.signingKey = toKey(signingKey);
    this.publicKey = toKey(writerPublicKey) || (this.signingKey ? crypto.createPublicKey(this.signingKey) : null);
    this.requireSignatures = mode === "reader" && Boolean(this.publicKey);
    this.blockIntervalMs = Math.max(0, Number(blockIntervalMs) || 0);
    this.cacheBlocks = Math.max(16, Number(cacheBlocks) || 4096);
    this.genesisData = genesis;
    this.timer = null;
    this.sql = this.buildSql();
    this.reset();
  }

  // Subclasses (such as the World communication ledger) supply their own SQL index.
  buildSql() {
    return createFthDb();
  }

  indexSql(block, file) {
    ingestFthBlock(this, block, file);
  }

  sqlQuery(text) {
    return this.sql.query(text);
  }

  sqlSchema() {
    return this.sql.schema();
  }

  reset() {
    this.height = -1;
    this.tipHash = ZERO_HASH;
    this.headers = [];
    this.cache = new Map();
    this.balances = new Map();
    this.nonces = new Map();
    this.redemptions = new Map();
    this.profiles = new Map();
    this.usernames = new Map();
    this.ids = new Map();
    this.txIndex = new Map();
    this.accountTxs = new Map();
    this.pending = [];
    this.waiters = new Map();
    this.supply = 0n;
    this.txCount = 0;
    this.kindCounts = {};
    this.transferVolume = 0n;
    this.genesis = null;
    this.goldReserve = null;
    this.sql?.reset();
  }

  open() {
    if (this.mode !== "reader") this.store.repairTail();
    for (const { block, file } of this.store.blocks()) this.importBlock(block, { persist: false, file, rebuildOnError: false });
    if (this.mode === "writer" && this.height < 0) this.createGenesis();
    return this;
  }

  createGenesis() {
    const t = Date.now();
    const tx = {
      i: "genesis",
      k: "GENESIS",
      a: "",
      v: "0",
      d: { name: "Featheral Dollar", symbol: "FTH$", decimals: 18, layer: 3, settlement: "Ethereum Mainnet (chain 1)", ...this.genesisData },
      t,
    };
    this.applyTx(tx, { height: 0 });
    this.writeBlock([tx], t);
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length) this.seal();
    this.sql?.close();
  }

  /* ------------------------------ validation ------------------------------ */

  account(accountId) {
    let entry = this.balances.get(accountId);
    if (!entry) {
      entry = { balance: 0n, reserved: 0n };
      this.balances.set(accountId, entry);
    }
    return entry;
  }

  // Validates completely before mutating, so a rejected transaction never leaves partial state.
  applyTx(tx, { height = null, fresh = false, now = Date.now(), validateOnly = false } = {}) {
    if (!tx || typeof tx !== "object") throw ledgerError("Transaction must be an object.");
    if (typeof tx.i !== "string" || !tx.i || tx.i.length > 200) throw ledgerError("Transaction id must be 1-200 characters.");
    if (!KINDS.has(tx.k)) throw ledgerError(`Unknown transaction kind ${tx.k}.`);
    if (typeof tx.a !== "string" || (tx.a !== "" && !BYTES32.test(tx.a))) throw ledgerError("Transaction account must be a lowercase bytes32 id.");
    if (typeof tx.v !== "string" || !DECIMAL.test(tx.v)) throw ledgerError("Transaction amount must be a base-unit integer string.");
    if (!tx.d || typeof tx.d !== "object" || Array.isArray(tx.d)) throw ledgerError("Transaction data must be an object.");
    if (!Number.isSafeInteger(tx.t) || tx.t <= 0) throw ledgerError("Transaction time must be epoch milliseconds.");
    if (this.ids.has(tx.i)) throw ledgerError("Transaction id was already used.", 409);
    const amount = BigInt(tx.v);
    const d = tx.d;
    const hash = txHash(tx);
    const valueCheck = () => {
      if (amount <= 0n) throw ledgerError("Amount must be positive.");
      if (!BYTES32.test(tx.a) || tx.a === ethers.ZeroHash) throw ledgerError("A non-zero account is required.");
    };
    if (this.genesis?.goldPublicKey && ["RESERVE", "SETTLE", "RELEASE"].includes(tx.k)) {
      throw ledgerError("Finite-reserve withdrawals must use Gold conversion, not the legacy bridge.", 409);
    }
    let commit;
    switch (tx.k) {
      case "GOLD_POLICY": {
        const { signature, ...policy } = d;
        if (this.genesis?.goldPublicKey || !this.genesis?.gamePublicKey || tx.a !== "" || tx.v !== "0"
          || this.supply !== 0n || this.balances.size || this.redemptions.size
          || Object.keys(this.kindCounts).some(kind => !["GENESIS", "PROFILE"].includes(kind))
          || policy.previousTip !== this.tipHash || policy.mode !== "live"
          || typeof signature !== "string"
          || !crypto.verify(null, Buffer.from(canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, d: policy, t: tx.t })), this.genesis.gamePublicKey, Buffer.from(signature, "base64"))) {
          throw ledgerError("Live reserve activation requires an authorized, unused zero-supply Dollar ledger.", 409);
        }
        const key = crypto.createPublicKey(policy.goldPublicKey);
        if (key.asymmetricKeyType !== "ed25519" || !policy.goldMarkets || typeof policy.goldMarkets !== "object"
          || !Object.keys(policy.goldMarkets).length || Object.entries(policy.goldMarkets).some(([asset, target]) =>
            !/^[a-z0-9-]{1,64}$/.test(asset) || !target || !Number.isSafeInteger(target.quantity) || target.quantity < 2 || target.quantity > 10000
            || typeof target.pricePerLot !== "string" || !/^[1-9]\d{0,77}$/.test(target.pricePerLot)
            || BigInt(target.pricePerLot) % 10n ** 14n)) throw ledgerError("Invalid live reserve policy.");
        commit = () => { Object.assign(this.genesis, { goldPublicKey: policy.goldPublicKey, goldMarkets: policy.goldMarkets, reserveMode: "live" }); };
        break;
      }
      case "GENESIS": {
        if (height !== 0 || this.height !== -1) throw ledgerError("Genesis is only valid as the first transaction of block 0.", 409);
        commit = () => { this.genesis = { ...d, createdAt: new Date(tx.t).toISOString() }; };
        break;
      }
      case "CREDIT": {
        valueCheck();
        if (this.genesis?.goldPublicKey) throw ledgerError("Finite-reserve ledgers cannot accept bridge or staking issuance.", 409);
        if (!CREDIT_SOURCES.has(d.src)) throw ledgerError("Credits must reference a verified bridge event.");
        if (!/^0x[0-9a-f]{64}$/.test(d.tx || "")) throw ledgerError("Credits must reference an Ethereum transaction hash.");
        commit = () => {
          this.account(tx.a).balance += amount;
          this.supply += amount;
        };
        break;
      }
      case "RESERVE": {
        valueCheck();
        const redemptionId = String(d.r || "");
        if (!BYTES32.test(redemptionId)) throw ledgerError("redemptionId must be bytes32.");
        if (this.redemptions.has(redemptionId)) throw ledgerError("Redemption id was already used.", 409);
        if (typeof d.to !== "string" || !ethers.isAddress(d.to) || ethers.getAddress(d.to) !== d.to) throw ledgerError("Redemption recipient must be a checksummed address.");
        if (!Number.isSafeInteger(d.exp)) throw ledgerError("Redemption expiry is required.");
        const entry = this.balances.get(tx.a) || { balance: 0n, reserved: 0n };
        if (entry.balance - entry.reserved < amount) throw ledgerError("Insufficient available FTH$ for redemption.", 409);
        commit = () => {
          this.account(tx.a).reserved += amount;
          this.redemptions.set(redemptionId, { redemptionId, accountId: tx.a, amount: tx.v, recipient: d.to, expiresAt: d.exp, status: "reserved", txHash: "" });
        };
        break;
      }
      case "SETTLE":
      case "RELEASE": {
        valueCheck();
        const redemption = this.redemptions.get(String(d.r || ""));
        if (!redemption || redemption.status !== "reserved") throw ledgerError("Redemption is not reserved.", 409);
        if (redemption.accountId !== tx.a || redemption.amount !== tx.v) throw ledgerError("Redemption account or amount mismatch.", 409);
        if (tx.k === "SETTLE" && !/^0x[0-9a-f]{64}$/.test(d.tx || "")) throw ledgerError("Settlement must reference an Ethereum transaction hash.");
        commit = () => {
          const entry = this.account(tx.a);
          entry.reserved -= amount;
          if (tx.k === "SETTLE") {
            entry.balance -= amount;
            this.supply -= amount;
            redemption.status = "settled";
            redemption.txHash = d.tx;
          } else {
            redemption.status = "released";
          }
        };
        break;
      }
      case "TRANSFER": {
        valueCheck();
        const transfer = verifyTransfer({ wallet: d.w, to: d.to, amount: tx.v, nonce: d.n, memo: d.m, issuedAt: d.ts, signature: d.sig });
        if (this.genesis?.goldPublicKey && transfer.to === REDEMPTION_ESCROW) throw ledgerError("Redemption escrow accepts Gold-authorized conversions only.", 409);
        if (transfer.from !== tx.a || transfer.to !== d.to || transfer.wallet !== d.w) throw ledgerError("Transfer fields are not normalized.");
        if (fresh) assertFreshSignature(transfer.issuedAtMs, now, "Transfer");
        const expected = (this.nonces.get(tx.a) || 0) + 1;
        if (transfer.nonce !== expected) throw ledgerError(`Transfer nonce must be ${expected}.`, 409);
        const entry = this.balances.get(tx.a) || { balance: 0n, reserved: 0n };
        if (entry.balance - entry.reserved < amount) throw ledgerError("Insufficient available FTH$ for transfer.", 409);
        commit = () => {
          this.account(tx.a).balance -= amount;
          this.account(transfer.to).balance += amount;
          this.nonces.set(tx.a, transfer.nonce);
        };
        break;
      }
      case "PROFILE": {
        if (height === null) throw ledgerError("Wallet profiles are managed by the database service.", 410);
        if (amount !== 0n) throw ledgerError("Profile updates carry no amount.");
        const profile = verifySignedProfile(d);
        if (tx.a !== walletAccountId(profile.address)) throw ledgerError("Profile account does not match its wallet.");
        if (fresh) assertFreshSignature(profile.issuedAtMs, now);
        const key = profile.address.toLowerCase();
        const previous = this.profiles.get(key);
        if (previous && Date.parse(previous.issuedAt) >= profile.issuedAtMs) throw ledgerError("A newer profile update is already recorded.", 409);
        const nameKey = profile.username.toLowerCase();
        const owner = this.usernames.get(nameKey);
        if (owner && owner !== key) throw ledgerError("Username is already taken.", 409);
        commit = () => {
          if (previous) this.usernames.delete(previous.username.toLowerCase());
          this.usernames.set(nameKey, key);
          this.profiles.set(key, { address: profile.address, username: profile.username, avatar: profile.avatar,
            ...(profile.bio === undefined && previous?.bio === undefined ? {} : { bio: profile.bio ?? previous.bio }), issuedAt: profile.issuedAt });
        };
        break;
      }
      case "GAME": {
        if (tx.a !== "" || !Array.isArray(d.entries) || !d.entries.length || d.entries.length > 1000) throw ledgerError("Invalid game fund entries.");
        const publicKey = this.genesis?.gamePublicKey;
        const payload = canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, entries: d.entries, t: tx.t });
        if (!publicKey || typeof d.signature !== "string" || !crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(d.signature, "base64"))) {
          throw ledgerError("Game fund transaction signature does not verify.");
        }
        const accounts = new Set();
        let total = 0n;
        const entries = d.entries.map((entry) => {
          if (!entry || !BYTES32.test(entry.account) || entry.account === ethers.ZeroHash || accounts.has(entry.account)
            || typeof entry.delta !== "string" || !/^-?[1-9]\d{0,77}$/.test(entry.delta)) throw ledgerError("Invalid or duplicate game fund entry.");
          accounts.add(entry.account);
          const delta = BigInt(entry.delta);
          if (this.genesis?.goldPublicKey && (entry.account === REDEMPTION_ESCROW || entry.account === TREASURY && delta < 0n)) {
            throw ledgerError("Only Gold can spend treasury or change redemption escrow funds.", 409);
          }
          const current = this.balances.get(entry.account) || { balance: 0n, reserved: 0n };
          if (current.balance + delta < current.reserved) throw ledgerError("Insufficient available FTH$ for gameplay.", 409);
          total += delta;
          return { account: entry.account, delta };
        });
        if (total > 0n || -total !== amount) throw ledgerError("Gameplay cannot issue FTH$; debits must equal credits plus the recorded burn.");
        if (this.genesis?.goldPublicKey && total !== 0n) throw ledgerError("Finite-reserve gameplay cannot burn FTH$.", 409);
        commit = () => {
          for (const entry of entries) this.account(entry.account).balance += entry.delta;
          this.supply -= amount;
        };
        break;
      }
      case "GOLD": {
        commit = validateGoldTransaction(this, tx, fresh, now);
        break;
      }
      default:
        throw ledgerError("Unsupported transaction kind.");
    }
    if (!validateOnly) {
      commit();
      this.ids.set(tx.i, hash);
    }
    return hash;
  }

  commitGame(tx) {
    return this.commitAuthorized(tx);
  }

  commitAuthorized(tx, { fresh = false } = {}) {
    this.requireWriter();
    if (!["GAME", "GOLD", "GOLD_POLICY"].includes(tx.k)) throw ledgerError("Only signed gameplay or Gold transactions can use synchronous settlement.");
    const previous = this.ids.get(tx.i);
    if (previous) {
      const existing = this.findTx(previous);
      if (!existing || canonical(existing.tx) !== canonical(tx)) throw ledgerError("Game commit conflicts with an existing transaction.", 409);
      if (!existing.location && !this.seal()) throw ledgerError("Game commit could not be sealed.", 503);
      return;
    }
    const hash = this.applyTx(tx, { fresh });
    this.pending.push({ tx, hash });
    if (!this.seal() || !this.ids.has(tx.i)) throw ledgerError("Game commit could not be persisted.", 503);
  }

  /* -------------------------------- writes -------------------------------- */

  requireWriter() {
    if (this.mode !== "writer") throw ledgerError("This node is a read-only FTH$ ledger replica.", 503);
  }

  submit({ id, kind, account = "", amount = "0", data = {} }, { fresh = false } = {}) {
    try {
      this.requireWriter();
      const existingHash = this.ids.get(id);
      if (existingHash) {
        const existing = this.findTx(existingHash);
        const same = existing && canonical({ k: existing.tx.k, a: existing.tx.a, v: existing.tx.v, d: existing.tx.d }) === canonical({ k: kind, a: account, v: String(amount), d: data });
        if (!same) throw ledgerError("Idempotency key was already used with different transaction data.", 409);
        return existing.location ? Promise.resolve(this.receipt(existingHash, existing.location)) : this.waitFor(existingHash);
      }
      const tx = { i: id, k: kind, a: account, v: String(amount), d: data, t: Date.now() };
      const hash = this.applyTx(tx, { fresh });
      this.pending.push({ tx, hash });
      const promise = this.waitFor(hash);
      this.scheduleSeal();
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  waitFor(hash) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(hash) || [];
      list.push({ resolve, reject });
      this.waiters.set(hash, list);
    });
  }

  scheduleSeal() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.seal(), this.blockIntervalMs);
  }

  seal() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return null;
    const items = this.pending.splice(0, MAX_TX_PER_BLOCK);
    if (this.pending.length) this.scheduleSeal();
    let block;
    try {
      block = this.writeBlock(items.map((item) => item.tx), Date.now());
    } catch (error) {
      // State already includes the unsealed transactions; reload the durable state and fail them all.
      const failed = [...items, ...this.pending];
      this.pending = [];
      for (const item of failed) for (const waiter of this.waiters.get(item.hash) || []) waiter.reject(ledgerError(`Block write failed: ${error.message}`, 503));
      for (const item of failed) this.waiters.delete(item.hash);
      this.rebuild();
      return null;
    }
    block.x.forEach((tx, index) => {
      const hash = items[index].hash;
      const receipt = this.receipt(hash, { h: block.h, i: index });
      for (const waiter of this.waiters.get(hash) || []) waiter.resolve(receipt);
      this.waiters.delete(hash);
    });
    return block;
  }

  writeBlock(txs, now) {
    const previous = this.headers[this.height];
    const block = { h: this.height + 1, t: Math.max(now, previous?.t || 0), p: this.tipHash, x: txs };
    block.H = blockHash(block);
    if (this.signingKey) block.S = crypto.sign(null, Buffer.from(block.H), this.signingKey).toString("base64");
    const file = this.store.append(block);
    this.indexBlock(block, file);
    return block;
  }

  /* ------------------------------ replication ----------------------------- */

  verifyBlockEnvelope(block) {
    if (!block || typeof block !== "object" || !Array.isArray(block.x) || !block.x.length) throw ledgerError("Malformed block.");
    if (block.h !== this.height + 1) throw ledgerError(`Block gap: expected height ${this.height + 1}, received ${block.h}.`, 409);
    if (block.p !== this.tipHash) throw ledgerError(`Block ${block.h} does not extend tip ${this.tipHash}.`, 409);
    if (!Number.isSafeInteger(block.t) || block.t < (this.headers[this.height]?.t || 0)) throw ledgerError(`Block ${block.h} time is invalid.`);
    if (blockHash(block) !== block.H) throw ledgerError(`Block ${block.h} hash does not verify.`);
    if (block.S !== undefined || this.requireSignatures) {
      if (!this.publicKey) return;
      if (typeof block.S !== "string" || !crypto.verify(null, Buffer.from(block.H), this.publicKey, Buffer.from(block.S, "base64"))) {
        throw ledgerError(`Block ${block.h} writer signature does not verify.`);
      }
    }
  }

  importBlock(block, { persist = true, file = null, rebuildOnError = true } = {}) {
    this.verifyBlockEnvelope(block);
    try {
      for (const tx of block.x) this.applyTx(tx, { height: block.h });
    } catch (error) {
      if (rebuildOnError) this.rebuild();
      throw ledgerError(`Block ${block.h} rejected: ${error.message}`, 409);
    }
    const relative = persist ? this.store.append(block) : file || BlockStore.fileFor(block.t);
    this.indexBlock(block, relative);
    return true;
  }

  // Readers fed by file copies (rsync, object storage sync) pick up appended blocks from disk.
  syncFromDisk() {
    let imported = 0;
    const startFile = this.headers[this.height]?.file || "";
    for (const { block, file } of this.store.blocks(startFile)) {
      if (block.h <= this.height) continue;
      this.importBlock(block, { persist: false, file });
      imported += 1;
    }
    return imported;
  }

  rebuild() {
    this.reset();
    for (const { block, file } of this.store.blocks()) this.importBlock(block, { persist: false, file, rebuildOnError: false });
  }

  indexBlock(block, file) {
    this.height = block.h;
    this.tipHash = block.H;
    this.headers[block.h] = { h: block.h, t: block.t, H: block.H, p: block.p, n: block.x.length, file, signed: typeof block.S === "string" };
    this.cache.set(block.h, block);
    if (this.cache.size > this.cacheBlocks) this.cache.delete(this.cache.keys().next().value);
    block.x.forEach((tx, index) => {
      const hash = txHash(tx);
      this.txIndex.set(hash, { h: block.h, i: index });
      this.txCount += 1;
      this.kindCounts[tx.k] = (this.kindCounts[tx.k] || 0) + 1;
      if (tx.k === "TRANSFER") this.transferVolume += BigInt(tx.v);
      if (!VALUE_KINDS.has(tx.k)) return;
      const accounts = tx.k === "GAME" ? tx.d.entries.map(entry => entry.account)
        : tx.k === "GOLD" ? goldEntries(this, tx.d).map(entry => entry.account)
          : [tx.a, tx.k === "TRANSFER" ? tx.d.to : ""];
      for (const accountId of new Set(accounts.filter(Boolean))) {
        const list = this.accountTxs.get(accountId) || [];
        list.push(hash);
        this.accountTxs.set(accountId, list);
      }
    });
    this.indexSql(block, file);
  }

  /* -------------------------------- queries ------------------------------- */

  rawBlock(height) {
    const header = this.headers[height];
    if (!header) return null;
    return this.cache.get(height) || this.store.readBlock(header.file, height);
  }

  blocksFrom(height, limit = MAX_PAGE) {
    const start = Math.max(0, Number(height) || 0);
    const end = Math.min(this.height, start + clampLimit(limit, MAX_PAGE) - 1);
    const blocks = [];
    for (let h = start; h <= end; h += 1) blocks.push(this.rawBlock(h));
    return blocks;
  }

  findTx(hash) {
    const pending = this.pending.find((item) => item.hash === hash);
    if (pending) return { tx: pending.tx, location: null };
    const location = this.txIndex.get(hash);
    if (!location) return null;
    return { tx: this.rawBlock(location.h).x[location.i], location };
  }

  receipt(hash, location) {
    return { hash, height: location.h, index: location.i, blockHash: this.headers[location.h].H, file: this.headers[location.h].file };
  }

  describeTx(tx, location) {
    const hash = txHash(tx);
    const base = {
      hash,
      id: tx.i,
      kind: tx.k,
      amount: tx.v,
      time: new Date(tx.t).toISOString(),
      status: location ? "sealed" : "pending",
      height: location ? location.h : null,
      index: location ? location.i : null,
      from: "",
      to: "",
    };
    const d = tx.d;
    switch (tx.k) {
      case "TRANSFER": return { ...base, from: tx.a, to: d.to, nonce: d.n, memo: d.m || "" };
      case "CREDIT": return { ...base, to: tx.a, source: d.src, ethTx: d.tx };
      case "RESERVE": return { ...base, from: tx.a, redemptionId: d.r, recipient: d.to };
      case "SETTLE": return { ...base, from: tx.a, redemptionId: d.r, ethTx: d.tx };
      case "RELEASE": return { ...base, to: tx.a, redemptionId: d.r };
      case "PROFILE": return { ...base, from: tx.a, username: d.username };
      case "GENESIS": return { ...base, data: d };
      case "GAME": return { ...base, data: d };
      case "GOLD": return { ...base, data: d };
      case "GOLD_POLICY": return { ...base, data: d };
      default: return base;
    }
  }

  withWallets(entry) {
    return { ...entry, fromWallet: entry.from ? accountWallet(entry.from) : "", toWallet: entry.to ? accountWallet(entry.to) : "" };
  }

  tx(hash) {
    const found = this.findTx(String(hash).toLowerCase());
    if (!found) return null;
    const entry = this.withWallets(this.describeTx(found.tx, found.location));
    if (found.location) entry.blockHash = this.headers[found.location.h].H;
    return entry;
  }

  block(height) {
    const raw = this.rawBlock(Number(height));
    if (!raw) return null;
    const header = this.headers[raw.h];
    return {
      height: raw.h,
      hash: raw.H,
      previousHash: raw.p,
      time: new Date(raw.t).toISOString(),
      file: header.file,
      signed: header.signed,
      transactions: raw.x.map((tx, index) => this.withWallets(this.describeTx(tx, { h: raw.h, i: index }))),
    };
  }

  latestBlocks({ before = null, limit = 20 } = {}) {
    const top = before === null || before === undefined || before === "" ? this.height : Math.min(this.height, Number(before) - 1);
    const size = clampLimit(limit, 20, 100);
    const result = [];
    for (let h = top; h >= 0 && result.length < size; h -= 1) {
      const header = this.headers[h];
      result.push({ height: h, hash: header.H, time: new Date(header.t).toISOString(), transactions: header.n, file: header.file, signed: header.signed });
    }
    return result;
  }

  latestTransactions(limit = 20) {
    const size = clampLimit(limit, 20, 100);
    const result = this.pending.slice(-size).reverse().map((item) => this.withWallets(this.describeTx(item.tx, null)));
    for (let h = this.height; h >= 0 && result.length < size; h -= 1) {
      const raw = this.rawBlock(h);
      for (let i = raw.x.length - 1; i >= 0 && result.length < size; i -= 1) {
        if (raw.x[i].k !== "GENESIS") result.push(this.withWallets(this.describeTx(raw.x[i], { h, i })));
      }
    }
    return result;
  }

  accountHistory(accountId, limit = 50) {
    accountId = String(accountId).toLowerCase();
    const hashes = this.accountTxs.get(String(accountId).toLowerCase()) || [];
    const size = clampLimit(limit, 50, 200);
    const pending = this.pending
      .filter((item) => VALUE_KINDS.has(item.tx.k) && (item.tx.a === accountId || item.tx.d.to === accountId
        || (item.tx.k === "GAME" && item.tx.d.entries.some((entry) => entry.account === accountId))
        || (item.tx.k === "GOLD" && goldEntries(this, item.tx.d).some(entry => entry.account === accountId))))
      .reverse()
      .map((item) => this.withWallets(this.describeTx(item.tx, null)));
    const sealed = hashes.slice(-size).reverse().map((hash) => this.tx(hash));
    return [...pending, ...sealed].slice(0, size).map((tx) => {
      if (!["GAME", "GOLD"].includes(tx.kind)) return tx;
      const entries = tx.kind === "GAME" ? tx.data.entries : goldEntries(this, tx.data);
      const entry = entries.find((entry) => entry.account === accountId);
      const delta = BigInt(entry.delta);
      return { ...tx, amount: (delta < 0n ? -delta : delta).toString(), from: delta < 0n ? accountId : "", to: delta > 0n ? accountId : "",
        ...(tx.kind === "GAME" ? { gameDelta: entry.delta } : { goldDelta: entry.delta }) };
    });
  }

  balance(accountId) {
    const entry = this.balances.get(String(accountId).toLowerCase()) || { balance: 0n, reserved: 0n };
    return { balance: entry.balance.toString(), reserved: entry.reserved.toString(), available: (entry.balance - entry.reserved).toString() };
  }

  nonce(accountId) {
    return this.nonces.get(String(accountId).toLowerCase()) || 0;
  }

  redemption(redemptionId) {
    const entry = this.redemptions.get(String(redemptionId).toLowerCase());
    return entry ? { ...entry } : null;
  }

  profile(address) {
    const entry = this.profiles.get(String(address).toLowerCase());
    return entry ? { ...entry } : null;
  }

  usernameOwner(username) {
    return this.usernames.get(String(username).toLowerCase()) || "";
  }

  hasId(id) {
    return this.ids.has(id);
  }

  richList(limit = 50) {
    const size = clampLimit(limit, 50, 200);
    const holders = [...this.balances.entries()].filter(([, entry]) => entry.balance > 0n);
    holders.sort((a, b) => (a[1].balance === b[1].balance ? (a[0] < b[0] ? -1 : 1) : a[1].balance > b[1].balance ? -1 : 1));
    return holders.slice(0, size).map(([accountId, entry], index) => ({
      rank: index + 1,
      accountId,
      wallet: accountWallet(accountId),
      balance: entry.balance.toString(),
      reserved: entry.reserved.toString(),
      shareBps: this.supply > 0n ? Number((entry.balance * 10000n) / this.supply) : 0,
    }));
  }

  summary() {
    let reserved = 0n;
    let holders = 0;
    for (const entry of this.balances.values()) {
      reserved += entry.reserved;
      if (entry.balance > 0n) holders += 1;
    }
    let pendingRedemptions = 0;
    for (const entry of this.redemptions.values()) if (entry.status === "reserved") pendingRedemptions += 1;
    const tip = this.headers[this.height];
    return {
      name: "Featheral Dollar",
      symbol: "FTH$",
      decimals: 18,
      layer: 3,
      height: this.height,
      tipHash: this.tipHash,
      tipTime: tip ? new Date(tip.t).toISOString() : null,
      genesisTime: this.genesis?.createdAt || null,
      supply: this.supply.toString(),
      reserved: reserved.toString(),
      circulating: (this.supply - reserved).toString(),
      holders,
      accounts: this.balances.size,
      transactions: this.txCount,
      pendingTransactions: this.pending.length,
      transfers: this.kindCounts.TRANSFER || 0,
      transferVolume: this.transferVolume.toString(),
      credits: this.kindCounts.CREDIT || 0,
      settlements: this.kindCounts.SETTLE || 0,
      pendingRedemptions,
      profiles: this.profiles.size,
      kinds: { ...this.kindCounts },
      signedBlocks: Boolean(this.publicKey),
      writerPublicKey: this.publicKey ? this.publicKey.export({ type: "spki", format: "pem" }) : null,
    };
  }
}

module.exports = { FthLedger, BlockStore, walletAccountId, accountWallet, MAX_PAGE };
