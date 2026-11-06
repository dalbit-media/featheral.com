import sqlite from '../../../../services/database/sqlite.js';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { ChatDirectoryStore } from './chat-directory.ts';
import { randomBytes, createHash } from 'node:crypto';
import { ApiError, createAccount, initializeUpkeep, migrateClock, migrateEconomy, migratePhysicalEconomy } from './economy.ts';
import { inventory } from './inventory.ts';
import type { Account } from './economy.ts';
import type { PopulationTotals, PublicTotals } from '../src/api-types.ts';
import { Exchange } from './market.ts';
import { ChatArchive } from './chat.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { GameFunds } from './funds.ts';
import type { DollarFunds, FundRequest, FundView, WalletView } from './funds.ts';
import type { ClockSpeed } from '../src/environment.ts';
import { enforceMonetaryPolicy } from './monetary-policy.ts';
import { isLiquidAsset, marketBasePrice, marketQuantityLimit } from '../src/market.ts';
import type { MarketAsset } from '../src/market.ts';

export interface Session { csrf: string; expires: number; account: Account }
export interface Store {
  readonly clockSpeed: ClockSpeed;
  readonly liquidityEnabled?: boolean;
  readonly chat: ChatArchive;
  readonly chatDirectory: ChatDirectoryStore;
  chatSession(token: string): { owner: string; csrf: string; expires: number };
  create(): { token: string; csrf: string; expires: number };
  read<T>(token: string, operation: (session: Session, now: number, realTime: number) => T): T;
  transaction<T>(token: string, operation: (session: Session, now: number, realTime: number, exchange: Exchange, owner: string) => T): T;
  linkWallet(token: string, address: string, moveGuestFunds?: boolean, separateWorldFunds?: boolean): void;
  walletView(token: string): WalletView;
  fundView(token: string): FundView;
  prepareFund(token: string, input: { id: string; direction: string; amount: string }, origin: string): FundRequest;
  completeFund(token: string, id: string, signature: string): Promise<FundView>;
  cancelFund(token: string, id: string): FundView;
  revokeWallet(token: string): { token: string; csrf: string; expires: number };
  wallet(token: string): string | null;
  population(federation: string | null): PopulationTotals;
  publicTotals(): PublicTotals;
  ensureLiquidity?(token: string, asset: MarketAsset): Promise<void>;
  close(): void;
}
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
export class SqliteStore implements Store {
  private readonly db: SqliteDatabase;
  private readonly exchange: Exchange;
  private readonly funds: GameFunds | null;
  readonly chat: ChatArchive;
  readonly chatDirectory: ChatDirectoryStore;
  private readonly clock: () => number;
  readonly clockSpeed: ClockSpeed;
  private readonly realAnchor: number;
  private readonly serverAnchor: number;
  private lastServerTime: number;
  constructor(path: string, clock = Date.now, clockSpeed: ClockSpeed = 1, dollarFunds?: DollarFunds) {
    this.clock = clock;
    this.clockSpeed = clockSpeed;
    this.db = sqlite.open(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL)');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('gold_pool','bank_positions')").get()) {
      this.db.close();
      throw new Error('Legacy simulated fund database detected. Back it up and start the new zero-funded economy.');
    }
    this.funds = dollarFunds ? new GameFunds(this.db, dollarFunds) : null;
    this.chat = new ChatArchive(this.db);
    this.chatDirectory = new ChatDirectoryStore(this.db);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.exchange = new Exchange(this.db);
      enforceMonetaryPolicy(this.db);
      this.db.exec('CREATE TABLE IF NOT EXISTS population_totals (scope TEXT PRIMARY KEY, total INTEGER NOT NULL CHECK (total >= 0))');
      if (!this.db.prepare("SELECT 1 FROM population_totals WHERE scope = 'global'").get()) {
        this.db.exec(`INSERT INTO population_totals
          SELECT 'global', COALESCE(SUM(json_extract(data, '$.account.game.population')), 0) FROM sessions;
          INSERT INTO population_totals
          SELECT 'federation:' || json_extract(data, '$.account.game.federation'),
            SUM(json_extract(data, '$.account.game.population')) FROM sessions
          WHERE json_extract(data, '$.account.game.federation') IS NOT NULL
          GROUP BY json_extract(data, '$.account.game.federation')`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS public_totals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settlements INTEGER NOT NULL CHECK (settlements >= 0),
        metal INTEGER NOT NULL CHECK (metal >= 0))`);
      if (!this.db.prepare('SELECT 1 FROM public_totals WHERE id = 1').get()) {
        this.db.exec(`INSERT INTO public_totals
          SELECT 1, COUNT(*), COALESCE(SUM(json_extract(data, '$.account.game.stock.metal')), 0)
          FROM sessions WHERE json_extract(data, '$.account.game.stage') >= 0`);
      }
      if (!this.db.prepare('PRAGMA table_info(public_totals)').all().some(column => column.name === 'dollars')) {
        this.db.exec("ALTER TABLE public_totals ADD COLUMN dollars INTEGER NOT NULL DEFAULT 0 CHECK(dollars>=0); UPDATE public_totals SET dollars=(SELECT COALESCE(SUM(json_extract(data,'$.account.game.dollars')),0) FROM sessions) WHERE id=1");
      }
      const clockTable = 'CREATE TABLE IF NOT EXISTS server_clock (id INTEGER PRIMARY KEY CHECK (id = 1), realTime INTEGER NOT NULL, serverTime INTEGER NOT NULL, speed INTEGER NOT NULL CHECK (speed IN (1, 10, 20, 168)))';
      this.db.exec(clockTable);
      const clockSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'server_clock'").get()!;
      if (!/\b168\b/.test(String(clockSchema.sql))) {
        this.db.exec('ALTER TABLE server_clock RENAME TO legacy_server_clock');
        this.db.exec(clockTable);
        this.db.exec('INSERT INTO server_clock SELECT * FROM legacy_server_clock; DROP TABLE legacy_server_clock');
      }
      const previous = this.db.prepare('SELECT realTime, serverTime, speed FROM server_clock WHERE id = 1').get();
      this.realAnchor = this.clock();
      const latest = this.db.prepare("SELECT COALESCE(MAX(json_extract(data, '$.account.updatedAt')), 0) AS time FROM sessions").get()!;
      this.serverAnchor = Math.max(Number(latest.time), previous
        ? Number(previous.serverTime) + Math.max(0, this.realAnchor - Number(previous.realTime)) * Number(previous.speed)
        : this.realAnchor);
      this.lastServerTime = this.serverAnchor;
      this.serverNow(this.realAnchor);
      this.db.prepare('INSERT OR REPLACE INTO server_clock VALUES (1, ?, ?, ?)').run(this.realAnchor, this.serverAnchor, clockSpeed);
      if (!previous) {
        for (const row of this.db.prepare('SELECT id, data FROM sessions').all()) {
          const session = JSON.parse(String(row.data)) as Session;
          const previousMetal = session.account.game.stage >= 0 ? session.account.game.stock.metal : 0;
          const previousDollars = session.account.game.dollars;
          migrateClock(session.account, this.realAnchor, this.serverAnchor);
          this.db.prepare('UPDATE public_totals SET metal=metal+?,dollars=dollars+? WHERE id=1')
            .run((session.account.game.stage >= 0 ? session.account.game.stock.metal : 0) - previousMetal, session.account.game.dollars - previousDollars);
          this.db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session), row.id!);
        }
      }
      for (const row of this.db.prepare("SELECT id, data FROM sessions WHERE COALESCE(json_extract(data, '$.account.physicalVersion'), 0) != 1").all()) {
        const session = JSON.parse(String(row.data)) as Session;
        migratePhysicalEconomy(session.account, this.serverAnchor);
        this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), row.id!);
      }
      for (const row of this.db.prepare("SELECT id, data FROM sessions WHERE COALESCE(json_extract(data, '$.account.pickupVersion'), 0) != 1 OR COALESCE(json_extract(data, '$.account.playabilityVersion'), 0) != 1 OR COALESCE(json_extract(data, '$.account.noMintVersion'), 0) != 1 OR COALESCE(json_extract(data, '$.account.workforce.version'), 0) != 3 OR json_extract(data, '$.account.inventory.version') IS NULL OR json_extract(data, '$.account.inventory.placements') IS NULL OR json_extract(data, '$.account.inventory.layout.version') IS NULL OR (json_extract(data, '$.account.game.stage') >= 0 AND COALESCE(json_extract(data, '$.account.waterUpkeep.version'), 0) != 2)").all()) {
        const session = JSON.parse(String(row.data)) as Session;
        const previousMetal = session.account.game.stock.metal;
        migrateEconomy(session.account, this.serverAnchor);
        initializeUpkeep(session.account, this.serverAnchor);
        inventory(session.account);
        if (session.account.game.stage >= 0) {
          this.db.prepare('UPDATE public_totals SET metal=metal+? WHERE id=1').run(session.account.game.stock.metal - previousMetal);
        }
        this.db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session), row.id!);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  create(): { token: string; csrf: string; expires: number } {
    const realTime = this.clock(), expires = realTime + 7 * 86400000;
    this.funds?.recover();
    this.chat.cleanup(realTime);
    const count = this.db.prepare('SELECT count(*) AS total FROM sessions').get()!;
    if (Number(count.total) >= 10000) throw new ApiError(503, 'Session capacity reached.');
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    const session: Session = { csrf, expires, account: createAccount(this.serverNow(realTime)) };
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), expires, JSON.stringify(session));
    return { token, csrf, expires };
  }
  transaction<T>(token: string, operation: (session: Session, now: number, realTime: number, exchange: Exchange, owner: string) => T): T {
    this.funds?.sync();
    const before = this.funds?.balances();
    let committed = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { session, now, realTime, id } = this.load(token);
      const previousPopulation = session.account.game.population, previousFederation = session.account.game.federation;
      const previousSettled = session.account.game.stage >= 0;
      const previousMetal = previousSettled ? session.account.game.stock.metal : 0;
      const previousDollars = session.account.game.dollars;
      const result = operation(session, now, realTime, this.exchange, id);
      if (this.funds?.address(id)) session.expires = Math.max(session.expires, realTime + 400 * 86400000);
      const game = session.account.game;
      const settled = game.stage >= 0;
      const settlementChange = Number(settled) - Number(previousSettled);
      const metalChange = (settled ? game.stock.metal : 0) - previousMetal;
      if (settlementChange || metalChange) this.db.prepare(
        'UPDATE public_totals SET settlements = settlements + ?, metal = metal + ? WHERE id = 1',
      ).run(settlementChange, metalChange);
      if (game.dollars !== previousDollars) this.db.prepare('UPDATE public_totals SET dollars=dollars+? WHERE id=1').run(game.dollars - previousDollars);
      this.addPopulation('global', game.population - previousPopulation);
      if (previousFederation === game.federation) {
        if (game.federation) this.addPopulation(`federation:${game.federation}`, game.population - previousPopulation);
      } else {
        if (previousFederation) this.addPopulation(`federation:${previousFederation}`, -previousPopulation);
        if (game.federation) this.addPopulation(`federation:${game.federation}`, game.population);
      }
      this.db.prepare('UPDATE sessions SET expires=?,data = ? WHERE id = ?').run(session.expires, JSON.stringify(session), id);
      const commitId = before ? this.funds!.stage(before) : null;
      this.db.exec('COMMIT');
      committed = true;
      this.funds?.settle(commitId);
      return result;
    } catch (error) {
      if (!committed) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async ensureLiquidity(token: string, asset: MarketAsset): Promise<void> {
    if (!this.funds || !isLiquidAsset(asset)) return;
    const settled = this.read(token, session => session.account.game.stage >= 0);
    if (!settled) return;
    await this.funds.ensureLiquidity(asset, marketQuantityLimit(asset), dollarsUnits(marketBasePrice(asset)));
  }
  get liquidityEnabled(): boolean { return Boolean(this.funds?.liquidityEnabled); }
  read<T>(token: string, operation: (session: Session, now: number, realTime: number) => T): T {
    this.funds?.sync();
    const { session, now, realTime } = this.load(token);
    return operation(session, now, realTime);
  }
  chatSession(token: string): { owner: string; csrf: string; expires: number } {
    const owner = this.funds?.owner(hash(token)) ?? hash(token);
    const row = this.db.prepare("SELECT expires, json_extract(data, '$.csrf') AS csrf FROM sessions WHERE id = ?").get(owner);
    if (!row) throw new ApiError(401, 'Session required.');
    if (Number(row.expires) <= this.clock()) throw new ApiError(401, 'Session expired.');
    return { owner, csrf: String(row.csrf), expires: Number(row.expires) };
  }
  population(federation: string | null): PopulationTotals {
    const total = (scope: string): number => {
      const row = this.db.prepare('SELECT total FROM population_totals WHERE scope = ?').get(scope);
      return row ? Number(row.total) : 0;
    };
    return { global: total('global'), federation: federation ? total(`federation:${federation}`) : null };
  }
  publicTotals(): PublicTotals {
    this.funds?.recover();
    const row = this.db.prepare(`SELECT settlements, metal,
      dollars+(SELECT COALESCE(SUM(dollars),0) FROM market_pools)+(SELECT COALESCE(SUM(price*remaining),0) FROM market_orders WHERE side='buy' AND status='open') AS supply,
      (SELECT total FROM population_totals WHERE scope = 'global') AS population
      FROM public_totals WHERE id = 1`).get()!;
    if (!Number.isSafeInteger(row.supply) || Number(row.supply) < 0) throw new Error('Public currency total exceeds the safe limit.');
    return { settlements: Number(row.settlements), metal: Number(row.metal), population: Number(row.population),
      dollars: this.funds ? this.funds.total() : Number(row.supply) / dollarsScale };
  }
  private addPopulation(scope: string, amount: number): void {
    if (!amount) return;
    const updated = this.db.prepare('UPDATE population_totals SET total = total + ? WHERE scope = ?').run(amount, scope);
    if (!updated.changes) this.db.prepare('INSERT INTO population_totals VALUES (?, ?)').run(scope, amount);
  }
  private serverNow(realTime: number): number {
    this.lastServerTime = Math.max(this.lastServerTime, this.serverAnchor + Math.max(0, realTime - this.realAnchor) * this.clockSpeed);
    if (!Number.isSafeInteger(this.lastServerTime) || this.lastServerTime < 0) throw new Error('Server clock out of range.');
    return this.lastServerTime;
  }
  private load(token: string): { session: Session; now: number; realTime: number; id: string } {
    const id = this.funds?.owner(hash(token)) ?? hash(token);
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id);
    const realTime = this.clock();
    if (!row) throw new ApiError(401, 'Session required.');
    const session = JSON.parse(String(row.data)) as Session;
    const now = this.serverNow(realTime);
    if (session.expires <= realTime) throw new ApiError(401, 'Session expired.');
    return { session, now, realTime, id };
  }
  linkWallet(token: string, address: string, moveGuestFunds = false, separateWorldFunds = false): void {
    if (!this.funds) throw new ApiError(503, 'Dollar ledger integration is not configured.');
    this.funds.recover();
    this.load(token);
    this.db.exec('BEGIN IMMEDIATE');
    try { this.funds.link(hash(token), address.toLowerCase(), this.clock(), moveGuestFunds, separateWorldFunds); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.funds.recover();
  }
  private configuredFunds(): GameFunds {
    if (!this.funds) throw new ApiError(503, 'Dollar ledger integration is not configured.');
    return this.funds;
  }
  walletView(token: string): WalletView {
    return this.configuredFunds().walletView(this.load(token).id);
  }
  walletWorldView(address: string): (WalletView & { mode: FundView['mode'] }) | null {
    return this.configuredFunds().walletWorldView(address);
  }
  fundView(token: string): FundView {
    return this.configuredFunds().fundView(this.load(token).id);
  }
  prepareFund(token: string, input: { id: string; direction: string; amount: string }, origin: string): FundRequest {
    const funds = this.configuredFunds(), { id, session, realTime } = this.load(token);
    return funds.prepareFund(id, input, origin, session.csrf, realTime);
  }
  completeFund(token: string, id: string, signature: string): Promise<FundView> {
    return this.configuredFunds().completeFund(this.load(token).id, id, signature);
  }
  cancelFund(token: string, id: string): FundView {
    return this.configuredFunds().cancelFund(this.load(token).id, id);
  }
  wallet(token: string): string | null {
    const { id } = this.load(token);
    return this.funds?.address(id) ?? null;
  }
  revokeWallet(token: string): { token: string; csrf: string; expires: number } {
    if (!this.funds) throw new ApiError(503, 'Dollar ledger integration is not configured.');
    this.load(token);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const identity = this.create();
      this.funds.revoke(hash(token));
      this.db.exec('COMMIT');
      return identity;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoverFunds(): void { this.funds?.recover(); }
  close(): void { this.db.close(); }
}
