import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './economy.ts';
import type { Session } from './store.ts';
import { dollarsScale } from '../src/dollars.ts';

const BASE_UNITS_PER_GAME_UNIT = 10n ** 14n;
export interface FundEntry { account: string; delta: string }
export interface FundTransaction {
  i: string; k: string; a: string; v: string;
  d: { entries: FundEntry[]; signature: string }; t: number;
}
export interface DollarFunds {
  available(account: string): string;
  supply(): string;
  prepare(entries: FundEntry[]): FundTransaction;
  commit(transaction: FundTransaction): void;
  ensureLiquidity?(asset: string, quantity: number, dollars: string): Promise<unknown>;
  poolSeed?(asset: string): { quantity: number } | null;
}
export const gameFundAccount = (kind: 'pool' | 'escrow' | 'guest', name: string): string =>
  `0x${createHash('sha256').update(`featheral:dollar:game:${kind}:${name}`).digest('hex')}`;
export const walletFundAccount = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

export class GameFunds {
  private readonly db: DatabaseSync;
  private readonly ledger: DollarFunds;
  constructor(db: DatabaseSync, ledger: DollarFunds) {
    this.db = db; this.ledger = ledger;
    db.exec(`CREATE TABLE IF NOT EXISTS fund_wallets (owner TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS session_aliases (token TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revoked_fund_sessions (token TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS fund_commits (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_data TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`);
    db.exec('CREATE TABLE IF NOT EXISTS fund_pool_seeds (asset TEXT PRIMARY KEY, quantity INTEGER NOT NULL)');
    this.recover();
  }
  recover(): void {
    for (const row of this.db.prepare('SELECT id,transaction_data FROM fund_commits WHERE settled=0 ORDER BY id').all()) {
      try { this.ledger.commit(JSON.parse(String(row.transaction_data)) as FundTransaction); }
      catch (error) {
        console.error('Dollar game fund settlement requires recovery:', error);
        throw new ApiError(503, 'Dollar fund settlement is unavailable. Retry after the ledger recovers.');
      }
      this.db.prepare('UPDATE fund_commits SET settled=1 WHERE id=?').run(row.id!);
    }
  }
  owner(tokenHash: string): string {
    if (this.db.prepare('SELECT 1 FROM revoked_fund_sessions WHERE token=?').get(tokenHash)) throw new ApiError(401, 'Session expired.');
    return String(this.db.prepare('SELECT owner FROM session_aliases WHERE token=?').get(tokenHash)?.owner ?? tokenHash);
  }
  revoke(tokenHash: string): void {
    this.db.prepare('INSERT INTO revoked_fund_sessions VALUES(?)').run(tokenHash);
    this.db.prepare('DELETE FROM session_aliases WHERE token=?').run(tokenHash);
  }
  address(owner: string): string | null {
    const row = this.db.prepare('SELECT address FROM fund_wallets WHERE owner=?').get(owner);
    return row ? String(row.address) : null;
  }
  private account(owner: string): string {
    const address = this.address(owner);
    return address ? walletFundAccount(address) : gameFundAccount('guest', owner);
  }
  private units(account: string): number {
    const value = BigInt(this.ledger.available(account)) / BASE_UNITS_PER_GAME_UNIT;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(409, 'Wallet exceeds the supported gameplay accounting limit.');
    return Number(value);
  }
  sync(): void {
    this.recover();
    for (const row of this.db.prepare('SELECT id,data FROM sessions').all()) {
      const session = JSON.parse(String(row.data)) as Session;
      const value = this.units(this.account(String(row.id)));
      if (session.account.game.dollars !== value || session.account.fthg !== 0) {
        session.account.game.dollars = value;
        session.account.fthg = 0;
        session.account.revision++;
        this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), row.id!);
      }
    }
    this.db.exec("UPDATE public_totals SET dollars=(SELECT COALESCE(SUM(json_extract(data,'$.account.game.dollars')),0) FROM sessions) WHERE id=1");
    for (const row of this.db.prepare('SELECT asset FROM market_pools').all()) {
      const asset = String(row.asset), seed = this.ledger.poolSeed?.(asset);
      if (seed && !this.db.prepare('SELECT 1 FROM fund_pool_seeds WHERE asset=?').get(asset)) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('UPDATE market_pools SET units=units+? WHERE asset=?').run(seed.quantity, asset);
          this.db.prepare('INSERT INTO fund_pool_seeds VALUES(?,?)').run(asset, seed.quantity);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      this.db.prepare('UPDATE market_pools SET dollars=? WHERE asset=?').run(this.units(gameFundAccount('pool', String(row.asset))), row.asset!);
    }
    for (const [account, amount] of this.balances()) {
      if (this.units(account) !== amount) throw new ApiError(503, 'Dollar gameplay escrow requires reconciliation.');
    }
  }
  get liquidityEnabled(): boolean { return Boolean(this.ledger.ensureLiquidity); }
  async ensureLiquidity(asset: string, quantity: number, pricePerLot: number): Promise<void> {
    if (!this.ledger.ensureLiquidity) return;
    this.recover();
    try {
      await this.ledger.ensureLiquidity(asset, quantity, (BigInt(quantity) * BigInt(pricePerLot) * BASE_UNITS_PER_GAME_UNIT).toString());
    } catch (error) {
      if (error instanceof Error && 'status' in error && typeof error.status === 'number'
        && [400, 401, 409, 503].includes(error.status)) throw new ApiError(error.status, error.message);
      console.error('Gold reserve verification failed', error);
      throw new ApiError(503, 'Gold reserve verification is unavailable. Retry later.');
    }
    this.sync();
  }
  balances(): Map<string, number> {
    const result = new Map<string, number>();
    for (const row of this.db.prepare("SELECT id,json_extract(data,'$.account.game.dollars') AS dollars FROM sessions").all())
      result.set(this.account(String(row.id)), Number(row.dollars));
    for (const row of this.db.prepare('SELECT asset,dollars FROM market_pools').all())
      result.set(gameFundAccount('pool', String(row.asset)), Number(row.dollars));
    for (const row of this.db.prepare("SELECT owner,SUM(price*remaining) AS dollars FROM market_orders WHERE side='buy' AND status='open' GROUP BY owner").all())
      result.set(gameFundAccount('escrow', String(row.owner)), Number(row.dollars));
    return result;
  }
  stage(before: Map<string, number>): number | null {
    const after = this.balances();
    const entries: FundEntry[] = [];
    for (const account of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(account) ?? 0, next = after.get(account) ?? 0;
      if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(next) || next < 0) throw new ApiError(409, 'Invalid game fund balance.');
      const delta = BigInt(next) - BigInt(previous);
      if (delta) entries.push({ account, delta: (delta * BASE_UNITS_PER_GAME_UNIT).toString() });
    }
    if (!entries.length) return null;
    const transaction = this.ledger.prepare(entries);
    return Number(this.db.prepare('INSERT INTO fund_commits(transaction_data) VALUES(?)').run(JSON.stringify(transaction)).lastInsertRowid);
  }
  settle(id: number | null): void {
    if (id !== null) this.recover();
  }
  link(tokenHash: string, address: string, now: number): void {
    const source = this.owner(tokenHash);
    const existing = this.db.prepare('SELECT owner FROM fund_wallets WHERE address=?').get(address);
    const target = existing ? String(existing.owner) : source;
    const linked = this.address(source);
    if (!existing && linked && linked !== address) {
      throw new ApiError(409, 'This settlement is linked to another wallet. Open a new browser session to create a different settlement.');
    }
    if (!existing) this.db.prepare('INSERT INTO fund_wallets VALUES(?,?)').run(source, address);
    this.db.prepare('INSERT OR REPLACE INTO session_aliases VALUES(?,?)').run(tokenHash, target);
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(target)!;
    const session = JSON.parse(String(row.data)) as Session;
    session.expires = now + 400 * 86400000;
    session.account.game.dollars = this.units(walletFundAccount(address));
    session.account.revision++;
    this.db.prepare('UPDATE sessions SET expires=?,data=? WHERE id=?').run(session.expires, JSON.stringify(session), target);
  }
  total(): number {
    return Number(BigInt(this.ledger.supply()) / BASE_UNITS_PER_GAME_UNIT) / dollarsScale;
  }
}
