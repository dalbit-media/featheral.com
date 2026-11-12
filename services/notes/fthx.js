"use strict";
const crypto = require("node:crypto");
const { canonical } = require("../fth-ledger/codec");
const UNIT = 10n ** 18n;
const MAX_WHOLE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BALANCE = (MAX_WHOLE + 1n) * UNIT - 1n;
const fail = (status, message) => Object.assign(new Error(message), { status });
function integer(value, positive = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || positive && value === "0")
    throw fail(400, "FTHX base units must be an exact non-negative integer string.");
  return BigInt(value);
}
function format(raw) {
  const value = typeof raw === "bigint" ? raw : integer(raw);
  if (value < 0n) throw fail(400, "FTHX balance cannot be negative.");
  const fraction = (value % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / UNIT).toString() + (fraction ? "." + fraction : "");
}
function account(value) {
  if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x20]/.test(value))
    throw fail(400, "A valid FTHX account is required.");
  return value.toLowerCase();
}
function request(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(value))
    throw fail(400, "A unique FTHX request ID is required.");
  return value;
}
class Fthx {
  constructor(db) {
    this.db = db;
    if (!db.readOnlyReplica) db.exec(`
      CREATE TABLE IF NOT EXISTS fthx_precision(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,decimals INTEGER NOT NULL);
      INSERT OR IGNORE INTO fthx_precision VALUES (1,2,18);
      CREATE TABLE IF NOT EXISTS fthx_remainders(address TEXT PRIMARY KEY,units TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fthx_base_entries(id INTEGER PRIMARY KEY,address TEXT NOT NULL,amount TEXT NOT NULL,
        kind TEXT NOT NULL,other TEXT NOT NULL,at INTEGER NOT NULL,site TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fthx_base_address ON fthx_base_entries(address,id);
      CREATE INDEX IF NOT EXISTS fthx_base_time ON fthx_base_entries(at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS fthx_operations(owner TEXT NOT NULL,request TEXT NOT NULL,parameters TEXT NOT NULL,
        result TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner,request));
      CREATE TABLE IF NOT EXISTS fthx_issuance_policy(id INTEGER PRIMARY KEY CHECK(id=1),policy TEXT NOT NULL,
        signature TEXT NOT NULL,issued TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fthx_supply_policy(id INTEGER PRIMARY KEY CHECK(id=1),policy TEXT NOT NULL);
    `);
    const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fthx_precision'").get();
    this.installed = Boolean(installed);
    this.supplyPolicyInstalled = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fthx_supply_policy'").get());
    if (installed) {
      const precision = db.prepare("SELECT version,decimals FROM fthx_precision WHERE id=1").get();
      if (precision?.version !== 2 || precision.decimals !== 18)
        throw fail(503, "Unsupported FTHX precision migration. Preserve the database and restore its compatible writer.");
    }
  }
  atomic(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  whole(owner) {
    let result = 0n;
    for (const row of this.db.prepare("SELECT CAST(amount AS TEXT) AS amount FROM notes_entries WHERE address=? AND symbol='FTHX'").iterate(account(owner)))
      result += BigInt(row.amount);
    if (result < 0n || result > MAX_WHOLE) throw fail(409, "FTHX whole-token balance exceeds supported accounting limits.");
    return result;
  }
  balance(owner) {
    const whole = this.whole(owner);
    const remainder = this.installed ? integer(this.db.prepare("SELECT units FROM fthx_remainders WHERE address=?").get(account(owner))?.units || "0") : 0n;
    if (remainder >= UNIT) throw fail(409, "FTHX fractional balance requires administrator reconciliation.");
    return whole * UNIT + remainder;
  }
  supply() {
    let value = 0n;
    for (const row of this.db.prepare("SELECT CAST(amount AS TEXT) AS amount FROM notes_entries WHERE symbol='FTHX'").iterate())
      value += BigInt(row.amount) * UNIT;
    if (this.installed) for (const row of this.db.prepare("SELECT units FROM fthx_remainders").iterate()) {
      const remainder = integer(row.units);
      if (remainder >= UNIT) throw fail(409, "FTHX fractional supply requires administrator reconciliation.");
      value += remainder;
    }
    if (value < 0n) throw fail(409, "FTHX supply is invalid.");
    return value;
  }
  view(owner) {
    const balance = this.balance(owner);
    return { version: 2, symbol: "FTHX", decimals: 18, balance: balance.toString(), formatted: format(balance),
      whole: (balance / UNIT).toString(), fractional: (balance % UNIT).toString() };
  }
  summary() {
    const supply = this.supply(), issuance = this.issuance();
    const reserved = issuance.settlement?.model === "locked-denomination" ? integer(issuance.issued) : 0n;
    if (reserved > supply) throw fail(503, "Locked FTHX backing exceeds total supply; restore the matching Notes dataset.");
    const fixedSupply = this.fixedSupply();
    if (fixedSupply.initialized && supply - reserved !== integer(fixedSupply.supply))
      throw fail(503, "Circulating FTHX differs from its fixed supply policy. Administrator reconciliation is required.");
    return { version: 2, decimals: 18, supply: supply.toString(), circulating: (supply - reserved).toString(),
      reserved: reserved.toString(), issuance, fixedSupply };
  }
  fixedSupply() {
    const row = this.supplyPolicyInstalled ? this.db.prepare("SELECT policy FROM fthx_supply_policy WHERE id=1").get() : null;
    return row ? { initialized: true, ...JSON.parse(row.policy) } : { initialized: false };
  }
  initializeSupply(owner, input, actor) {
    owner = account(owner); actor = account(actor);
    if (![owner, actor].every(value => /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value)))
      throw fail(400, "Fixed FTHX supply requires an owner wallet and an administrator wallet.");
    const id = request(input?.requestId), whole = integer(input?.supply, true);
    if (whole > MAX_WHOLE) throw fail(400, "Fixed FTHX supply exceeds supported whole-token limits.");
    const approval = `INITIALIZE FTHX ${whole} TO ${owner}`;
    if (input?.approval !== approval) throw fail(400, `Exact approval required: ${approval}`);
    if (!this.supplyPolicyInstalled || this.db.readOnlyReplica) throw fail(503, "Fixed FTHX supply requires the authoritative upgraded Notes writer.");
    return this.atomic(() => {
      const previous = this.fixedSupply(), supply = whole * UNIT;
      if (previous.initialized) {
        if (previous.requestId !== id || previous.owner !== owner || previous.supply !== supply.toString())
          throw fail(409, "FTHX supply is already fixed. It cannot be reissued or increased.");
        this.summary();
        return previous;
      }
      const existing = integer(this.summary().circulating);
      if (supply < existing) throw fail(409, "Fixed FTHX supply cannot be below existing circulating balances.");
      const issued = supply - existing, at = Date.now();
      if (issued) this.post(owner, issued, "initial_supply", id, at, "notes-launch");
      const policy = { version: 1, symbol: "FTHX", decimals: 18, supply: supply.toString(),
        existing: existing.toString(), issued: issued.toString(), owner, actor, requestId: id, approval, at };
      this.db.prepare("INSERT INTO fthx_supply_policy VALUES (1,?)").run(canonical(policy));
      return this.fixedSupply();
    });
  }
  entries({ address, before, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail(400, "Choose an FTHX entry limit from 1 to 100.");
    address = address === undefined ? null : account(address);
    let cursor = null;
    if (before !== undefined) {
      try {
        if (typeof before !== "string" || before.length > 512 || !/^[A-Za-z0-9_-]+$/.test(before)) throw new Error();
        cursor = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
      } catch { throw fail(400, "Invalid exact FTHX entry cursor."); }
      if (!Array.isArray(cursor) || cursor.length !== 7 || cursor[0] !== 2 || cursor[6] !== address
        || ![cursor[1], cursor[2], cursor[3], cursor[5]].every(value => Number.isSafeInteger(value) && value >= 0)
        || !["l", "x"].includes(cursor[4]) || cursor[5] < 1 || cursor[5] > cursor[cursor[4] === "l" ? 1 : 2])
        throw fail(400, "Invalid exact FTHX entry cursor or changed address filter.");
    }
    const legacy = cursor?.[1] ?? this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM notes_entries").get().id;
    const exact = cursor?.[2] ?? (this.installed ? this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM fthx_base_entries").get().id : 0);
    const streams = [`SELECT id,address,CAST(amount AS TEXT) AS amount,kind,post_id,other,at,site,symbol,'l' AS stream
      FROM notes_entries WHERE symbol='FTHX' AND site!='fthx-base-units' AND id<=?`];
    const parameters = [legacy];
    if (this.installed) {
      streams.push(`SELECT id,address,amount,kind,NULL AS post_id,other,at,site,'FTHX' AS symbol,'x' AS stream
        FROM fthx_base_entries WHERE id<=?`);
      parameters.push(exact);
    }
    const clauses = [];
    if (address) { clauses.push("address=?"); parameters.push(address); }
    if (cursor) { clauses.push("(at,stream,id)<(?,?,?)"); parameters.push(cursor[3], cursor[4], cursor[5]); }
    parameters.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM (${streams.join(" UNION ALL ")})
      ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY at DESC,stream DESC,id DESC LIMIT ?`).all(...parameters);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return { version: 2, decimals: 18, entries: rows.map(({ stream, ...row }) => ({
      ...row, id: `${stream}:${row.id}`, amount: (BigInt(row.amount) * (stream === "l" ? UNIT : 1n)).toString(),
    })), hasMore, nextBefore: hasMore
      ? Buffer.from(JSON.stringify([2, legacy, exact, last.at, last.stream, last.id, address])).toString("base64url") : null };
  }
  post(owner, delta, kind, other, at = Date.now(), site = "notes-wallet") {
    if (!this.installed || this.db.readOnlyReplica) throw fail(503, "Fractional FTHX settlement requires the upgraded Notes writer.");
    if (!this.db.isTransaction) throw fail(503, "FTHX postings must be part of an atomic settlement.");
    owner = account(owner);
    if (typeof delta !== "bigint" || delta === 0n || !/^[a-z][a-z0-9_-]{0,63}$/.test(kind)
      || typeof other !== "string" || other.length > 200 || !Number.isSafeInteger(at) || at <= 0
      || typeof site !== "string" || !site || site.length > 100)
      throw fail(400, "Invalid exact FTHX posting.");
    const current = this.balance(owner), next = current + delta;
    if (next < 0n) throw fail(402, "Insufficient FTHX.");
    if (next > MAX_BALANCE) throw fail(409, "FTHX account exceeds supported accounting limits.");
    const wholeDelta = next / UNIT - current / UNIT;
    if (wholeDelta) this.db.prepare(`INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol)
      VALUES (?,?,?,?,?,'fthx-base-units','FTHX')`).run(owner, Number(wholeDelta), kind, other, at);
    this.db.prepare(`INSERT INTO fthx_remainders VALUES (?,?)
      ON CONFLICT(address) DO UPDATE SET units=excluded.units`).run(owner, (next % UNIT).toString());
    this.db.prepare("INSERT INTO fthx_base_entries(address,amount,kind,other,at,site) VALUES (?,?,?,?,?,?)")
      .run(owner, delta.toString(), kind, other, at, site);
  }
  transfer(owner, input) {
    owner = account(owner);
    const to = account(input?.to), amount = integer(input?.amount, true), id = request(input?.requestId);
    const kind = input?.purpose === "tip" ? "wallet_tip" : "wallet_transfer";
    if (input?.purpose !== undefined && input.purpose !== "tip") throw fail(400, "Choose a supported FTHX transfer purpose.");
    if (to === owner) throw fail(400, "Choose another FTHX account.");
    if (amount > 1000000000n * UNIT) throw fail(400, "FTHX transfers must not exceed 1,000,000,000 tokens.");
    const parameters = JSON.stringify({ to, amount: amount.toString(), kind });
    return this.atomic(() => {
      const previous = this.db.prepare("SELECT parameters,result FROM fthx_operations WHERE owner=? AND request=?").get(owner, id);
      if (previous) {
        if (previous.parameters !== parameters) throw fail(409, "FTHX request ID already has different parameters.");
        return JSON.parse(previous.result);
      }
      const at = Date.now();
      this.post(owner, -amount, `${kind}_out`, to, at);
      this.post(to, amount, `${kind}_in`, owner, at);
      const result = { version: 2, symbol: "FTHX", decimals: 18, to, amount: amount.toString(), requestId: id,
        ...(input.purpose ? { purpose: input.purpose } : {}), status: "complete", at };
      this.db.prepare("INSERT INTO fthx_operations VALUES (?,?,?,?,?)").run(owner, id, parameters, JSON.stringify(result), at);
      return result;
    });
  }
  authorizeIssuance(policy, signature, authority) {
    return this.atomic(() => this.authorizeIssuanceInTransaction(policy, signature, authority));
  }
  authorizeIssuanceInTransaction(policy, signature, authority) {
    if (!this.db.isTransaction) throw fail(503, "FTHX authorization must be part of an atomic settlement.");
    const { version, symbol, decimals, cap, treasury, genesisHash, snapshotHash, snapshotHeight } = policy || {};
    const settlement = policy?.settlement;
    if (settlement !== undefined && (!settlement || Object.keys(settlement).length !== 3
      || settlement.version !== 1 || settlement.model !== "locked-denomination" || integer(settlement.rate, true) < 1n))
      throw fail(400, "Invalid signed FTHX settlement denomination.");
    if (version !== 1 || symbol !== "FTHX" || decimals !== 18 || Object.keys(policy).length !== (settlement ? 9 : 8)
      || account(treasury) !== treasury || !/^0x[0-9a-f]{64}$/.test(genesisHash || "")
      || !/^0x[0-9a-f]{64}$/.test(snapshotHash || "") || !Number.isSafeInteger(snapshotHeight) || snapshotHeight < 0)
      throw fail(400, "Invalid finite FTHX migration policy.");
    const ceiling = integer(cap, true);
    if (ceiling >= 2n ** 256n) throw fail(409, "FTHX issuance cap exceeds supported accounting limits.");
    if (typeof signature !== "string" || !crypto.verify(null, Buffer.from(canonical(policy)), authority, Buffer.from(signature, "base64")))
      throw fail(403, "Finite FTHX issuance requires the original settlement authority.");
    const previous = this.db.prepare("SELECT policy,signature FROM fthx_issuance_policy WHERE id=1").get();
    if (previous) {
      if (previous.policy !== canonical(policy) || previous.signature !== signature)
        throw fail(409, "The finite FTHX migration issuance policy cannot be replaced or increased.");
      return this.issuance();
    }
    this.db.prepare("INSERT INTO fthx_issuance_policy VALUES (1,?,?,'0')").run(canonical(policy), signature);
    return this.issuance();
  }
  issue(input) {
    return this.atomic(() => this.issueInTransaction(input));
  }
  issueInTransaction(input) {
    if (!this.db.isTransaction) throw fail(503, "FTHX issuance must be part of an atomic settlement.");
    const id = request(input?.requestId), amount = integer(input?.amount, true);
    const saved = this.db.prepare("SELECT policy,issued FROM fthx_issuance_policy WHERE id=1").get();
    if (!saved) throw fail(503, "Finite FTHX migration issuance is not authorized.");
    const policy = JSON.parse(saved.policy), owner = policy.treasury;
    const parameters = JSON.stringify({ issuance: true, amount: amount.toString(), policy: saved.policy });
    const previous = this.db.prepare("SELECT parameters,result FROM fthx_operations WHERE owner=? AND request=?").get(owner, id);
    if (previous) {
      if (previous.parameters !== parameters) throw fail(409, "FTHX issuance request ID already has different parameters.");
      return JSON.parse(previous.result);
    }
    if (this.fixedSupply().initialized && policy.settlement?.model !== "locked-denomination")
      throw fail(409, "FTHX market supply is fixed. Further spendable issuance is disabled.");
    const issued = integer(saved.issued) + amount;
    if (issued > integer(policy.cap)) throw fail(409, "Finite FTHX migration issuance cap is exhausted.");
    const at = Date.now();
    this.post(owner, amount, "migration_issuance", policy.genesisHash, at, "notes-migration");
    this.db.prepare("UPDATE fthx_issuance_policy SET issued=? WHERE id=1").run(issued.toString());
    const result = { version: 2, symbol: "FTHX", decimals: 18, amount: amount.toString(), requestId: id, status: "complete", at };
    this.db.prepare("INSERT INTO fthx_operations VALUES (?,?,?,?,?)").run(owner, id, parameters, JSON.stringify(result), at);
    return result;
  }
  issuance() {
    const saved = this.installed ? this.db.prepare("SELECT policy,issued FROM fthx_issuance_policy WHERE id=1").get() : null;
    if (!saved) return { authorized: false, issued: "0" };
    const policy = JSON.parse(saved.policy);
    return { authorized: true, ...policy, issued: saved.issued, remaining: (integer(policy.cap) - integer(saved.issued)).toString() };
  }
}
module.exports = { Fthx, UNIT, MAX_BALANCE, integer, format };
