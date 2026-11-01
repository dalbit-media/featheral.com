import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { accrue, ApiError, restoreSnapshotUpkeep, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { isStakingYears } from '../src/bank.ts';
import type { BankCommand, BankPosition, BankSnapshot, StakingYears } from '../src/bank.ts';
import { worldYearMs } from '../src/environment.ts';
import { note } from '../src/engine.ts';

const day = 86400000;
function units(value: unknown): number {
  if (typeof value !== 'number') throw new ApiError(400, 'Enter an amount with up to four decimal places.');
  let result: number;
  try { result = dollarsUnits(value); }
  catch (error) { if (!(error instanceof RangeError)) throw error; throw new ApiError(400, 'Enter an amount with up to four decimal places.'); }
  if (result < 1) throw new ApiError(400, 'Enter a positive amount.');
  return result;
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(409, 'Currency balance limit reached.');
  return Number(value);
}
export function stakingInterest(principal: number, pool: { gold: number; dollars: number }, aprBps: number, years: StakingYears) {
  const valuation = safe(BigInt(principal) * BigInt(pool.dollars) / BigInt(pool.gold));
  return { valuation, interest: safe(BigInt(valuation) * BigInt(aprBps) * BigInt(years) / 10000n) };
}
function parseCommand(value: unknown): BankCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid bank command.');
  const c = value as Record<string, unknown>, keys = Object.keys(c).sort().join();
  const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  if (c.type === 'stake' && keys === 'interestDollars,quantity,rateRevision,type,valuationDollars,years'
    && typeof c.quantity === 'number' && isStakingYears(c.years) && integer(c.rateRevision) && integer(c.valuationDollars) && integer(c.interestDollars)) {
    units(c.quantity);
    return { type: 'stake', quantity: c.quantity, years: c.years, rateRevision: c.rateRevision, valuationDollars: c.valuationDollars, interestDollars: c.interestDollars };
  }
  if (c.type === 'fund' && keys === 'dollars,type' && typeof c.dollars === 'number') { units(c.dollars); return { type: 'fund', dollars: c.dollars }; }
  if (c.type === 'claim-stake' && keys === 'positionId,type' && integer(c.positionId) && c.positionId > 0) return { type: 'claim-stake', positionId: c.positionId };
  if (c.type === 'propose-rate' && keys === 'aprBps,type' && integer(c.aprBps) && c.aprBps <= 10000) return { type: 'propose-rate', aprBps: c.aprBps };
  if (c.type === 'vote-rate' && keys === 'approve,proposalId,type' && integer(c.proposalId) && c.proposalId > 0 && typeof c.approve === 'boolean') return { type: 'vote-rate', proposalId: c.proposalId, approve: c.approve };
  throw new ApiError(400, 'Invalid bank command fields.');
}
export class FeatheralBank {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, councilMembers?: readonly string[]) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS bank_treasury(id INTEGER PRIMARY KEY CHECK(id=1),available INTEGER NOT NULL CHECK(available>=0),reserved INTEGER NOT NULL CHECK(reserved>=0));
      INSERT OR IGNORE INTO bank_treasury VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS bank_policy(id INTEGER PRIMARY KEY CHECK(id=1),aprBps INTEGER CHECK(aprBps BETWEEN 0 AND 10000),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO bank_policy VALUES(1,NULL,0);
      CREATE TABLE IF NOT EXISTS bank_council(owner TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bank_proposals(id INTEGER PRIMARY KEY,aprBps INTEGER NOT NULL CHECK(aprBps BETWEEN 0 AND 10000),status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')));
      CREATE UNIQUE INDEX IF NOT EXISTS bank_pending_proposal ON bank_proposals(status) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS bank_votes(proposal INTEGER NOT NULL,owner TEXT NOT NULL,approve INTEGER NOT NULL CHECK(approve IN (0,1)),PRIMARY KEY(proposal,owner));
      CREATE TABLE IF NOT EXISTS bank_positions(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,principal INTEGER NOT NULL CHECK(principal>0),valuation INTEGER NOT NULL CHECK(valuation>=0),interest INTEGER NOT NULL CHECK(interest>=0),aprBps INTEGER NOT NULL,years INTEGER NOT NULL,startedAt INTEGER NOT NULL,readyAt INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('locked','claimed')));
      CREATE INDEX IF NOT EXISTS bank_positions_owner ON bank_positions(owner,status);
      CREATE TABLE IF NOT EXISTS bank_receipts(owner TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));`);
    if (councilMembers !== undefined) this.configureCouncil(councilMembers);
  }
  configureCouncil(members: readonly string[]): void {
    if (new Set(members).size !== members.length || members.some(owner => !/^[0-9a-f]{64}$/.test(owner)
      || !this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(owner))) throw new Error('BANK_COUNCIL_IDS must contain unique existing account IDs.');
    const current = this.db.prepare('SELECT owner FROM bank_council ORDER BY owner').all().map(row => String(row.owner));
    if (JSON.stringify(current) === JSON.stringify([...members].sort())) return;
    this.db.exec("DELETE FROM bank_council; UPDATE bank_proposals SET status='cancelled' WHERE status='pending'; UPDATE bank_policy SET revision=revision+1 WHERE id=1");
    for (const owner of members) this.db.prepare('INSERT INTO bank_council VALUES(?)').run(owner);
  }
  retentionUntil(owner: string, now: number, realTime: number): number {
    const position = this.db.prepare("SELECT 1 FROM bank_positions WHERE owner=? AND status='locked' LIMIT 1").get(owner);
    const council = !!this.db.prepare('SELECT 1 FROM bank_council WHERE owner=?').get(owner);
    return council || position ? realTime + 400 * day : 0;
  }
  read(owner: string, account: Account, quantity: number, years: StakingYears): BankSnapshot {
    const principal = units(quantity), row = this.db.prepare('SELECT * FROM bank_policy WHERE id=1').get()!;
    const pool = this.db.prepare('SELECT gold,dollars FROM gold_pool WHERE id=1').get()!;
    const treasury = this.db.prepare('SELECT available,reserved FROM bank_treasury WHERE id=1').get()!;
    const council = { members: Number(this.db.prepare('SELECT COUNT(*) AS n FROM bank_council').get()!.n),
      member: !!this.db.prepare('SELECT 1 FROM bank_council WHERE owner=?').get(owner), aprBps: row.aprBps === null ? null : Number(row.aprBps), revision: Number(row.revision) };
    const { valuation, interest } = stakingInterest(principal, { gold: Number(pool.gold), dollars: Number(pool.dollars) }, council.aprBps ?? 0, years);
    const pending = this.db.prepare("SELECT id,aprBps FROM bank_proposals WHERE status='pending'").get();
    let proposal: BankSnapshot['proposal'] = null;
    if (pending) {
      const votes = this.db.prepare('SELECT COALESCE(SUM(approve),0) AS yes,COUNT(*)-COALESCE(SUM(approve),0) AS no FROM bank_votes WHERE proposal=?').get(pending.id!)!;
      const own = this.db.prepare('SELECT approve FROM bank_votes WHERE proposal=? AND owner=?').get(pending.id!, owner);
      proposal = { id: Number(pending.id), aprBps: Number(pending.aprBps), approvals: Number(votes.yes), rejections: Number(votes.no), vote: own ? own.approve ? 'approve' : 'reject' : null };
    }
    const positions = this.db.prepare('SELECT * FROM bank_positions WHERE owner=? ORDER BY id DESC').all(owner).map(p => ({
      id: Number(p.id), principal: Number(p.principal) / dollarsScale, valuationDollars: Number(p.valuation) / dollarsScale,
      interestDollars: Number(p.interest) / dollarsScale, aprBps: Number(p.aprBps), years: Number(p.years) as StakingYears,
      startedAt: Number(p.startedAt), readyAt: Number(p.readyAt), status: String(p.status) as BankPosition['status'],
    }));
    const reason = account.game.stage < 0 ? 'Establish a settlement before using the bank.'
      : !council.members ? 'Bank council is not configured.' : council.aprBps === null ? 'The council has not approved an interest rate.'
      : council.aprBps === 0 || interest === 0 ? 'This amount earns no interest at the approved rate.'
      : principal > account.fthg ? 'Not enough available FTHG.' : interest > Number(treasury.available) ? 'The reward treasury cannot fund this entire term.' : null;
    return { accountId: owner, treasury: { available: Number(treasury.available) / dollarsScale, reserved: Number(treasury.reserved) / dollarsScale }, council, proposal, positions,
      quote: { principal: quantity, years, valuationDollars: valuation / dollarsScale, interestDollars: interest / dollarsScale, rateRevision: council.revision, available: !reason, reason } };
  }
  apply(owner: string, account: Account, value: unknown, now: number, realTime: number): ReturnType<typeof snapshot> & { bank: BankSnapshot; message: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid bank action.');
    const b = value as Record<string, unknown>;
    if (Object.keys(b).sort().join() !== 'command,id,revision' || typeof b.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) || !Number.isSafeInteger(b.revision)) throw new ApiError(400, 'Invalid bank action envelope.');
    const request = JSON.stringify({ revision: b.revision, command: b.command });
    const receipt = this.db.prepare('SELECT request,result FROM bank_receipts WHERE owner=? AND id=?').get(owner, b.id);
    if (receipt) {
      if (receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
      const saved = JSON.parse(String(receipt.result)) as ReturnType<FeatheralBank['apply']>;
      return { ...saved, waterUpkeep: restoreSnapshotUpkeep(saved, account, now) };
    }
    const command = parseCommand(b.command);
    if (b.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    if (realTime - account.lastActionAt < 250) throw new ApiError(429, 'Actions are limited to four per second.');
    if (account.game.stage < 0) throw new ApiError(409, 'Establish a settlement before using the bank.');
    accrue(account, now);
    if (b.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    let message = 'Bank action completed.';
    if (command.type === 'fund') {
      const amount = units(command.dollars), treasury = this.db.prepare('SELECT available,reserved FROM bank_treasury WHERE id=1').get()!;
      if (account.game.dollars < amount) throw new ApiError(409, 'Not enough FTH$ to fund rewards.');
      const available = safe(BigInt(Number(treasury.available)) + BigInt(amount));
      safe(BigInt(available) + BigInt(Number(treasury.reserved)));
      account.game.dollars -= amount;
      this.db.prepare('UPDATE bank_treasury SET available=? WHERE id=1').run(available);
      message = 'Reward treasury funded.';
    } else if (command.type === 'stake') {
      const quote = this.read(owner, account, command.quantity, command.years).quote;
      if (!quote.available) throw new ApiError(409, quote.reason!);
      const valuation = dollarsUnits(quote.valuationDollars), interest = dollarsUnits(quote.interestDollars);
      if (command.rateRevision !== quote.rateRevision || command.valuationDollars !== valuation || command.interestDollars !== interest) throw new ApiError(409, 'Bank quote changed. Review the new terms.');
      const principal = units(command.quantity), readyAt = now + command.years * worldYearMs;
      if (!Number.isSafeInteger(readyAt)) throw new ApiError(409, 'Bank maturity exceeds the time limit.');
      const treasury = this.db.prepare('SELECT available,reserved FROM bank_treasury WHERE id=1').get()!;
      const reserved = safe(BigInt(Number(treasury.reserved)) + BigInt(interest));
      this.db.prepare('UPDATE bank_treasury SET available=available-?,reserved=? WHERE id=1').run(interest, reserved);
      account.fthg -= principal;
      this.db.prepare("INSERT INTO bank_positions(owner,principal,valuation,interest,aprBps,years,startedAt,readyAt,status) VALUES(?,?,?,?,?,?,?,?,'locked')")
        .run(owner, principal, valuation, interest, this.db.prepare('SELECT aprBps FROM bank_policy WHERE id=1').get()!.aprBps!, command.years, now, readyAt);
      message = 'FTHG staked. Principal is locked until maturity.';
    } else if (command.type === 'claim-stake') {
      const position = this.db.prepare("SELECT * FROM bank_positions WHERE id=? AND owner=? AND status='locked'").get(command.positionId, owner);
      if (!position) throw new ApiError(409, 'This staking position is not available.');
      if (now < Number(position.readyAt)) throw new ApiError(409, 'Staked FTHG cannot be withdrawn before maturity.');
      account.fthg = safe(BigInt(account.fthg) + BigInt(Number(position.principal)));
      account.game.dollars = safe(BigInt(account.game.dollars) + BigInt(Number(position.interest)));
      this.db.prepare('UPDATE bank_treasury SET reserved=reserved-? WHERE id=1').run(position.interest!);
      this.db.prepare("UPDATE bank_positions SET status='claimed' WHERE id=?").run(command.positionId);
      message = 'Staking principal and interest received.';
    } else {
      if (!this.db.prepare('SELECT 1 FROM bank_council WHERE owner=?').get(owner)) throw new ApiError(403, 'Only appointed bank councillors may vote.');
      let proposalId: SQLInputValue;
      if (command.type === 'propose-rate') {
        if (this.db.prepare("SELECT 1 FROM bank_proposals WHERE status='pending'").get()) throw new ApiError(409, 'Vote on the pending rate proposal first.');
        proposalId = this.db.prepare("INSERT INTO bank_proposals(aprBps,status) VALUES(?,'pending')").run(command.aprBps).lastInsertRowid;
        this.db.prepare('INSERT INTO bank_votes VALUES(?,?,1)').run(proposalId, owner);
      } else {
        proposalId = command.proposalId;
        if (!this.db.prepare("SELECT 1 FROM bank_proposals WHERE id=? AND status='pending'").get(proposalId)) throw new ApiError(409, 'This rate proposal is no longer pending.');
        if (this.db.prepare('SELECT 1 FROM bank_votes WHERE proposal=? AND owner=?').get(proposalId, owner)) throw new ApiError(409, 'Your council vote is already recorded.');
        this.db.prepare('INSERT INTO bank_votes VALUES(?,?,?)').run(proposalId, owner, Number(command.approve));
      }
      const tally = this.db.prepare('SELECT SUM(approve) AS yes,COUNT(*)-SUM(approve) AS no FROM bank_votes WHERE proposal=?').get(proposalId)!;
      const majority = Math.floor(Number(this.db.prepare('SELECT COUNT(*) AS n FROM bank_council').get()!.n) / 2) + 1;
      if (Number(tally.yes) >= majority) {
        this.db.prepare('UPDATE bank_policy SET aprBps=(SELECT aprBps FROM bank_proposals WHERE id=?),revision=revision+1 WHERE id=1').run(proposalId);
        this.db.prepare("UPDATE bank_proposals SET status='approved' WHERE id=?").run(proposalId);
        message = 'Council interest rate approved. Existing stakes are unchanged.';
      } else if (Number(tally.no) >= majority) {
        this.db.prepare("UPDATE bank_proposals SET status='rejected' WHERE id=?").run(proposalId);
        message = 'Council rate proposal rejected.';
      } else message = 'Council vote recorded.';
    }
    account.revision++; account.lastActionAt = realTime;
    const result = { ...snapshot(account), bank: this.read(owner, account, 1, 1), message: note(account.game, message) };
    this.db.prepare('INSERT INTO bank_receipts VALUES(?,?,?,?)').run(owner, b.id, request, JSON.stringify(result));
    return result;
  }
}
