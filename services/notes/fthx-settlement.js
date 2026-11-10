"use strict";
const crypto = require("node:crypto");
const { canonical } = require("../fth-ledger/codec");
const { goldEntries } = require("../gold/reserve");
const { MAX_BALANCE } = require("./fthx");
const RATE = 100n;
const TREASURY = "fthx-settlement:treasury";
const fail = message => Object.assign(new Error(message), { status: 503 });
const backingAccount = account => `fthx-settlement:${account}`;
function deltas(ledger, tx) {
  const entries = tx.k === "GAME" ? tx.d.entries : tx.k === "GOLD" ? goldEntries(ledger, tx.d)
    : tx.k === "CREDIT" ? [{ account: tx.a, delta: tx.v }]
      : tx.k === "SETTLE" ? [{ account: tx.a, delta: `-${tx.v}` }]
        : tx.k === "TRANSFER" ? [{ account: tx.a, delta: `-${tx.v}` }, { account: tx.d.to, delta: tx.v }] : [];
  const result = new Map();
  for (const entry of entries) result.set(entry.account, (result.get(entry.account) || 0n) + BigInt(entry.delta));
  return [...result].filter(([, delta]) => delta !== 0n);
}
class FthxSettlement {
  constructor(ledger, token, privateKey) {
    this.ledger = ledger; this.token = token; this.db = token.db; this.privateKey = privateKey;
    if (ledger.mode !== "writer" || token.db.readOnlyReplica) throw fail("FTHX migration requires both authoritative writers.");
    const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    if (ledger.genesis.gamePublicKey !== publicKey) throw fail("FTHX migration requires the original authorized game signing key.");
    this.authority = publicKey;
    this.db.exec(`CREATE TABLE IF NOT EXISTS fthx_settlement_checkpoint(
      id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,snapshot_height INTEGER NOT NULL,
      snapshot_hash TEXT NOT NULL,height INTEGER NOT NULL,hash TEXT NOT NULL,dollars TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fthx_settlement_blocks(height INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL);`);
    if (ledger.pending.length) {
      while (ledger.pending.length) if (!ledger.seal()) throw fail("Seal pending Dollar transactions before FTHX migration.");
    }
    this.ensure();
    this.recover();
    this.reconcile();
    ledger.fthxSettlement = this;
  }
  checkpoint() { return this.db.prepare("SELECT * FROM fthx_settlement_checkpoint WHERE id=1").get(); }
  ensure() {
    const existing = this.checkpoint();
    const genesis = this.ledger.headers[0].H;
    if (existing) {
      const policy = this.token.issuance();
      const signed = this.db.prepare("SELECT policy,signature FROM fthx_issuance_policy WHERE id=1").get();
      if (existing.genesis !== genesis || this.ledger.headers[existing.snapshot_height]?.H !== existing.snapshot_hash
        || !policy.authorized || policy.genesisHash !== genesis || policy.treasury !== TREASURY
        || policy.snapshotHash !== existing.snapshot_hash || policy.snapshotHeight !== existing.snapshot_height
        || policy.settlement?.rate !== RATE.toString() || policy.settlement?.version !== 1
        || policy.settlement?.model !== "locked-denomination" || !signed
        || !crypto.verify(null, Buffer.from(signed.policy), this.authority, Buffer.from(signed.signature, "base64")))
        throw fail("FTHX migration belongs to a different source journal or policy. Restore the matching datasets.");
      return true;
    }
    const supply = this.ledger.supply, reserve = this.ledger.goldReserve;
    const goldBudget = reserve ? BigInt(reserve.cap) * 20000n : 0n;
    const cap = (supply + goldBudget) * RATE;
    if (!cap) return false;
    const policy = { version: 1, symbol: "FTHX", decimals: 18, cap: cap.toString(), treasury: TREASURY,
      genesisHash: genesis, snapshotHeight: this.ledger.height, snapshotHash: this.ledger.tipHash,
      settlement: { version: 1, model: "locked-denomination", rate: RATE.toString() } };
    const signature = crypto.sign(null, Buffer.from(canonical(policy)), this.privateKey).toString("base64");
    const previous = this.token.issuance();
    if (previous.authorized) {
      if (previous.genesisHash !== genesis || previous.snapshotHash !== policy.snapshotHash
        || previous.snapshotHeight !== policy.snapshotHeight || previous.cap !== policy.cap || previous.treasury !== TREASURY)
        throw fail("An incomplete FTHX migration policy requires its original journal snapshot.");
    }
    this.token.atomic(() => {
      this.token.authorizeIssuanceInTransaction(policy, signature, this.authority);
      let total = 0n;
      const at = Date.now();
      for (const [owner, balance] of this.ledger.balances) {
        if (balance.balance < 0n) throw fail("A negative Dollar balance cannot migrate.");
        if (!balance.balance) continue;
        const amount = balance.balance * RATE;
        if (amount > MAX_BALANCE) throw fail("Dollar migration exceeds the supported per-account FTHX limit.");
        this.token.issueInTransaction({ amount: amount.toString(),
          requestId: "initial-" + crypto.createHash("sha256").update(owner).digest("hex") });
        this.move(TREASURY, backingAccount(owner), amount, "migration_backing", at, "notes-migration");
        total += balance.balance;
      }
      if (total !== supply) throw fail("Dollar migration snapshot supply does not reconcile.");
      this.db.prepare("INSERT INTO fthx_settlement_checkpoint VALUES (1,?,?,?,?,?,?)")
        .run(genesis, policy.snapshotHeight, policy.snapshotHash, policy.snapshotHeight, policy.snapshotHash, supply.toString());
    });
    return true;
  }
  move(from, to, amount, kind, at, site) {
    if (amount <= 0n) return;
    this.token.post(from, -amount, `${kind}_out`, to, at, site);
    this.token.post(to, amount, `${kind}_in`, from, at, site);
  }
  validate(tx) {
    const entries = deltas(this.ledger, tx);
    if (!entries.length) return;
    if (!this.ensure()) throw fail("Initialize finite Gold backing before enabling FTHX settlement.");
    const checkpoint = this.checkpoint();
    if (checkpoint.height !== this.ledger.height || checkpoint.hash !== this.ledger.tipHash)
      throw fail("FTHX settlement needs recovery before another Dollar operation.");
    const change = entries.reduce((sum, [, delta]) => sum + delta, 0n);
    for (const [owner, delta] of entries)
      if (((this.ledger.balances.get(owner)?.balance || 0n) + delta) * RATE > MAX_BALANCE)
        throw fail("FTHX settlement exceeds the supported per-account backing limit.");
    const policy = this.token.issuance();
    const nextBacking = (this.ledger.supply + change) * RATE;
    let projectedIssued = BigInt(policy.issued), pendingBacking = BigInt(checkpoint.dollars) * RATE;
    for (const { tx: pending } of this.ledger.pending) {
      pendingBacking += deltas(this.ledger, pending).reduce((sum, [, delta]) => sum + delta, 0n) * RATE;
      if (pendingBacking > projectedIssued) projectedIssued = pendingBacking;
    }
    if (change * RATE > MAX_BALANCE || projectedIssued - nextBacking > MAX_BALANCE)
      throw fail("FTHX settlement exceeds the supported treasury account limit.");
    if (nextBacking > BigInt(policy.cap))
      throw fail("Finite FTHX migration capacity is exhausted. No additional unbacked Dollar issuance is allowed.");
    if (!this.ledger.pending.length) {
      for (const [owner] of entries) {
        const required = (this.ledger.balances.get(owner)?.balance || 0n) * RATE;
        if (this.token.balance(backingAccount(owner)) !== required)
          throw fail("FTHX backing differs from the authoritative Dollar balance; restore or reconcile before settlement.");
      }
    }
  }
  commitBlock(block) {
    const checkpoint = this.checkpoint();
    if (!checkpoint || block.h <= checkpoint.height) return;
    if (block.h !== checkpoint.height + 1 || block.p !== checkpoint.hash)
      throw fail("FTHX settlement cannot skip or replace a Dollar block.");
    this.token.atomic(() => {
      let supply = BigInt(checkpoint.dollars);
      for (const tx of block.x) {
        const entries = deltas(this.ledger, tx);
        if (!entries.length) continue;
        const change = entries.reduce((sum, [, delta]) => sum + delta, 0n);
        const site = tx.k === "GAME" ? tx.i.startsWith("exchange:") ? "notes-market" : "world"
          : tx.k === "GOLD" || tx.k === "CREDIT" || tx.k === "SETTLE" ? "gold" : "notes-wallet";
        const total = change * RATE;
        const available = this.token.balance(TREASURY);
        if (total > available) this.token.issueInTransaction({ amount: (total - available).toString(),
          requestId: "settlement-" + crypto.createHash("sha256").update(tx.i).digest("hex") });
        if (total) this.token.post(TREASURY, -total, "backing_settlement", tx.i, tx.t, site);
        for (const [owner, delta] of entries)
          this.token.post(backingAccount(owner), delta * RATE, "backing_settlement", tx.i, tx.t, site);
        supply += change;
      }
      this.db.prepare("INSERT INTO fthx_settlement_blocks VALUES (?,?)").run(block.h, block.H);
      this.db.prepare("UPDATE fthx_settlement_checkpoint SET height=?,hash=?,dollars=? WHERE id=1").run(block.h, block.H, supply.toString());
    });
  }
  recover() {
    const checkpoint = this.checkpoint();
    if (!checkpoint) return;
    if (this.ledger.headers[checkpoint.height]?.H !== checkpoint.hash)
      throw fail("FTHX settlement is ahead of or conflicts with the Dollar journal. Restore its matching sealed blocks.");
    if (checkpoint.height === this.ledger.height) return;
    for (const { block } of this.ledger.store.blocks(this.ledger.headers[checkpoint.height].file))
      if (block.h > checkpoint.height) this.commitBlock(block);
  }
  assertSynchronized() {
    const checkpoint = this.checkpoint();
    if (checkpoint && (checkpoint.height !== this.ledger.height || checkpoint.hash !== this.ledger.tipHash))
      throw fail("FTHX backing recovery is required before Dollar balances can be used.");
  }
  reconcile() {
    this.assertSynchronized();
    const checkpoint = this.checkpoint();
    if (!checkpoint) return;
    let required = 0n;
    for (const [owner, entry] of this.ledger.balances) {
      if (this.token.balance(backingAccount(owner)) !== entry.balance * RATE)
        throw fail("FTHX backing reconciliation failed. Do not serve gameplay until both journals recover.");
      required += entry.balance * RATE;
    }
    for (const { address } of this.db.prepare(`SELECT address FROM notes_entries WHERE address LIKE 'fthx-settlement:%'
      UNION SELECT address FROM fthx_remainders WHERE address LIKE 'fthx-settlement:%'`).iterate()) {
      if (address !== TREASURY && !this.ledger.balances.has(address.slice("fthx-settlement:".length)) && this.token.balance(address))
        throw fail("An orphan FTHX backing account requires administrator reconciliation.");
    }
    const policy = this.token.issuance();
    if (BigInt(checkpoint.dollars) * RATE !== required
      || this.token.balance(TREASURY) + required !== BigInt(policy.issued))
      throw fail("FTHX settlement treasury does not reconcile with issued backing.");
  }
  summary() {
    return settlementSummary(this.token, this.ledger);
  }
}
function settlementSummary(token, ledger) {
    const installed = token.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fthx_settlement_checkpoint'").get();
    const checkpoint = installed ? token.db.prepare("SELECT * FROM fthx_settlement_checkpoint WHERE id=1").get() : null;
    return { enabled: Boolean(checkpoint), synchronized: Boolean(checkpoint && checkpoint.height === ledger.height && checkpoint.hash === ledger.tipHash),
      version: 1, decimals: 18, denominationRate: RATE.toString(),
      model: "FTHX-backed FTH$ denomination; locked backing settlement, not an AMM execution or a redemption peg",
      sourceHeight: checkpoint?.height ?? null, sourceHash: checkpoint?.hash ?? null,
      backing: checkpoint ? (BigInt(checkpoint.dollars) * RATE).toString() : "0",
      treasury: token.balance(TREASURY).toString(), issuance: token.issuance() };
}
module.exports = { FthxSettlement, backingAccount, RATE, TREASURY, deltas, settlementSummary };
