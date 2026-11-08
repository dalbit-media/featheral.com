import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { ApiError } from './economy.ts';
import type { Session } from './store.ts';
import { dollarsScale } from '../src/dollars.ts';
import { getAddress, verifyMessage } from 'ethers';

const BASE_UNITS_PER_GAME_UNIT = 10n ** 14n;
const MAX_WORLD_FUNDS = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * BASE_UNITS_PER_GAME_UNIT - 1n;
export interface FundPayment {
  wallet: string; to: string; amount: string; nonce: number; memo: string; issuedAt: string;
}
export interface FundParameters { direction: 'deposit' | 'withdraw'; amount: string }
export interface FundRequest {
  id: string; parameters: FundParameters; origin: string; accountId: string; wallet: string;
  message: string; payment?: FundPayment; status: 'prepared' | 'paying' | 'complete' | 'cancelled';
  at: number; error?: string;
}
interface StoredFundRequest extends FundRequest { signature?: string; commitId?: number }
export interface WalletView { accountId: string; wallet: string | null; available: string }
export interface FundView extends WalletView {
  mode: 'guest' | 'legacy-direct' | 'separate'; walletAvailable: string | null; requests: FundRequest[];
}
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
  ensureLiquidity?(asset: string, quantity: number, dollars: string, required?: string): Promise<unknown>;
  poolSeed?(asset: string): { quantity: number } | null;
  nonce?(account: string): number;
  depositMessage?(payment: FundPayment): string;
  depositState?(payment: FundPayment): 'missing' | 'conflict' | 'accepted';
  transfer?(payment: FundPayment & { signature: string }): Promise<unknown>;
}
export const gameFundAccount = (kind: 'pool' | 'escrow' | 'guest', name: string): string =>
  `0x${createHash('sha256').update(`featheral:dollar:game:${kind}:${name}`).digest('hex')}`;
export const walletFundAccount = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

export class GameFunds {
  private readonly db: SqliteDatabase;
  private readonly ledger: DollarFunds;
  private readonly pending = new Map<string, Promise<FundView>>();
  constructor(db: SqliteDatabase, ledger: DollarFunds) {
    this.db = db; this.ledger = ledger;
    db.exec(`CREATE TABLE IF NOT EXISTS fund_wallets (owner TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS session_aliases (token TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revoked_fund_sessions (token TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS fund_commits (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_data TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`);
    db.exec('CREATE TABLE IF NOT EXISTS fund_pool_seeds (asset TEXT PRIMARY KEY, quantity INTEGER NOT NULL)');
    if (!db.prepare('PRAGMA table_info(fund_wallets)').all().some(column => column.name === 'mode'))
      db.exec("ALTER TABLE fund_wallets ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy-direct' CHECK(mode IN ('legacy-direct','separate'))");
    this.migrateLegacyRequests();
    db.exec('CREATE TABLE IF NOT EXISTS world_fund_requests (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))');
    db.exec('CREATE TABLE IF NOT EXISTS fund_guest_moves (token TEXT PRIMARY KEY)');
    this.recover();
  }
  private migrateLegacyRequests(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='world_fund_requests'").get();
    if (!table) return;
    const columns = this.db.prepare('PRAGMA table_info(world_fund_requests)').all().map(column => String(column.name));
    if (columns.includes('data')) return;
    const expected = ['owner', 'id', 'payload', 'payment', 'message', 'status', 'error', 'at', 'signature'];
    if (expected.some(column => !columns.includes(column)))
      throw new ApiError(503, 'Legacy World transfer records use an unsupported schema. Preserve the database and migrate it before starting the service.');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_fund_requests_migration_v1'").get())
      throw new ApiError(503, 'World transfer migration is incomplete. Preserve the database and inspect its migration tables.');
    const rows = this.db.prepare('SELECT owner,id,payload,payment,message,status,error,at,signature FROM world_fund_requests').all();
    const parseMessageField = (message: string, field: string): string => message.split(/\r?\n/)
      .find(line => line.startsWith(`${field}: `))?.slice(field.length + 2) ?? '';
    const migrated = rows.map(row => {
      const owner = String(row.owner), id = String(row.id), message = String(row.message);
      const payload = JSON.parse(String(row.payload)) as { direction?: unknown; amount?: unknown };
      const status = String(row.status);
      if (status === 'paying') throw new ApiError(503, 'A legacy World transfer is still in progress and cannot be safely resumed automatically.');
      if (!['prepared', 'complete', 'cancelled'].includes(status)
        || !['deposit', 'withdraw'].includes(String(payload.direction))
        || typeof payload.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(payload.amount))
        throw new ApiError(503, 'A legacy World transfer record is invalid. Preserve the database and inspect it before starting the service.');
      const wallet = parseMessageField(message, 'Wallet') || this.address(owner) || '';
      const accountId = parseMessageField(message, 'World account') || this.account(owner);
      const origin = parseMessageField(message, 'Origin');
      if (!/^0x[0-9a-f]{40}$/i.test(wallet) || !accountId || !origin)
        throw new ApiError(503, 'A legacy World transfer is missing authorization metadata. Preserve the database and inspect it before starting the service.');
      const request: StoredFundRequest = {
        id, parameters: { direction: payload.direction as FundParameters['direction'], amount: payload.amount },
        origin, accountId, wallet, message, status: status as StoredFundRequest['status'], at: Number(row.at),
      };
      if (row.payment) request.payment = JSON.parse(String(row.payment)) as FundPayment;
      if (row.error) request.error = String(row.error);
      if (row.signature) request.signature = String(row.signature);
      return { owner, id, data: JSON.stringify(request) };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`ALTER TABLE world_fund_requests RENAME TO world_fund_requests_migration_v1;
        CREATE TABLE world_fund_requests (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))`);
      const insert = this.db.prepare('INSERT INTO world_fund_requests(owner,id,data) VALUES(?,?,?)');
      for (const row of migrated) insert.run(row.owner, row.id, row.data);
      this.db.exec('DROP TABLE world_fund_requests_migration_v1');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    for (const row of this.db.prepare("SELECT owner,id,data FROM world_fund_requests WHERE json_extract(data,'$.status')='paying' AND json_extract(data,'$.commitId') IS NOT NULL").all()) {
      const request = JSON.parse(String(row.data)) as StoredFundRequest;
      if (request.status === 'paying' && request.commitId !== undefined
        && this.db.prepare('SELECT 1 FROM fund_commits WHERE id=? AND settled=1').get(request.commitId)) {
        request.status = 'complete';
        delete request.error;
        this.saveRequest(String(row.owner), request);
      }
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
  mode(owner: string): FundView['mode'] {
    const row = this.db.prepare('SELECT mode FROM fund_wallets WHERE owner=?').get(owner);
    return row ? row.mode as 'legacy-direct' | 'separate' : 'guest';
  }
  private account(owner: string): string {
    const address = this.address(owner);
    return address && this.mode(owner) === 'legacy-direct' ? walletFundAccount(address) : gameFundAccount('guest', owner);
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
  async ensureLiquidity(asset: string, quantity: number, pricePerLot: number, required = 0n): Promise<void> {
    if (!this.ledger.ensureLiquidity) return;
    this.recover();
    try {
      await this.ledger.ensureLiquidity(asset, quantity, (BigInt(quantity) * BigInt(pricePerLot) * BASE_UNITS_PER_GAME_UNIT).toString(),
        (required * BASE_UNITS_PER_GAME_UNIT).toString());
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
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_vaults'").get())
      for (const row of this.db.prepare('SELECT federation,dollars FROM federation_vaults').all())
        result.set(gameFundAccount('escrow', `federation:${row.federation}`), Number(row.dollars));
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
  link(tokenHash: string, address: string, now: number, moveGuestFunds = false, separateWorldFunds = false): void {
    if (moveGuestFunds && separateWorldFunds) throw new ApiError(400, 'Separate World authorization cannot move guest funds.');
    const source = this.owner(tokenHash);
    const existing = this.db.prepare('SELECT owner FROM fund_wallets WHERE address=?').get(address);
    const target = existing ? String(existing.owner) : source;
    const linked = this.address(source);
    if (linked && linked !== address) throw new ApiError(409, 'This settlement is linked to another wallet.');
    if (moveGuestFunds && (this.mode(source) === 'separate' || this.mode(target) === 'separate'))
      throw new ApiError(409, 'Separate World funds require an explicit withdrawal.');
    const guestAccount = gameFundAccount('guest', source), guestAmount = BigInt(this.ledger.available(guestAccount));
    if (source !== target && guestAmount > 0n && !moveGuestFunds)
      throw new ApiError(409, 'This guest has World funds. Explicitly move them before restoring another settlement.');
    if (!separateWorldFunds && this.mode(target) === 'guest' && guestAmount > 0n && !moveGuestFunds)
      throw new ApiError(409, 'Guest funds require explicit approval to move or a separate World budget.');
    if (!existing) this.db.prepare('INSERT INTO fund_wallets(owner,address,mode) VALUES(?,?,?)').run(source, address, separateWorldFunds ? 'separate' : 'legacy-direct');
    if (separateWorldFunds) this.db.prepare("UPDATE fund_wallets SET mode='separate' WHERE owner=?").run(target);
    if (moveGuestFunds && !this.db.prepare('SELECT 1 FROM fund_guest_moves WHERE token=?').get(tokenHash)) {
      if (guestAmount > 0n) {
        const destination = walletFundAccount(address);
        if (BigInt(this.ledger.available(destination)) + guestAmount > MAX_WORLD_FUNDS) throw new ApiError(409, 'World fund limit exceeded.');
        const transaction = this.ledger.prepare([{ account: guestAccount, delta: `-${guestAmount}` }, { account: destination, delta: guestAmount.toString() }]);
        this.db.prepare('INSERT INTO fund_commits(transaction_data) VALUES(?)').run(JSON.stringify(transaction));
      }
      this.db.prepare('INSERT INTO fund_guest_moves VALUES(?)').run(tokenHash);
    }
    this.db.prepare('INSERT OR REPLACE INTO session_aliases VALUES(?,?)').run(tokenHash, target);
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(target)!;
    const session = JSON.parse(String(row.data)) as Session;
    session.expires = now + 400 * 86400000;
    session.account.game.dollars = this.units(this.account(target));
    session.account.revision++;
    this.db.prepare('UPDATE sessions SET expires=?,data=? WHERE id=?').run(session.expires, JSON.stringify(session), target);
  }
  walletView(owner: string): WalletView {
    this.recover();
    const accountId = this.account(owner);
    return { accountId, wallet: this.address(owner), available: this.ledger.available(accountId) };
  }
  walletWorldView(address: string): (WalletView & { mode: FundView['mode'] }) | null {
    const row = this.db.prepare('SELECT owner FROM fund_wallets WHERE address=?').get(address.toLowerCase());
    return row ? { ...this.walletView(String(row.owner)), mode: this.mode(String(row.owner)) } : null;
  }
  private requests(owner: string): StoredFundRequest[] {
    return this.db.prepare("SELECT data FROM world_fund_requests WHERE owner=? AND json_extract(data,'$.status') IN ('prepared','paying') ORDER BY rowid DESC").all(owner)
      .map(row => JSON.parse(String(row.data)) as StoredFundRequest);
  }
  private publicRequest(request: StoredFundRequest): FundRequest {
    const { signature: _signature, commitId: _commitId, ...view } = request;
    return view;
  }
  fundView(owner: string): FundView {
    const view = this.walletView(owner);
    const history = this.db.prepare("SELECT data FROM world_fund_requests WHERE owner=? AND json_extract(data,'$.status') IN ('complete','cancelled') ORDER BY rowid DESC LIMIT 100")
      .all(owner).map(row => JSON.parse(String(row.data)) as StoredFundRequest);
    return { ...view, mode: this.mode(owner), walletAvailable: view.wallet ? this.ledger.available(walletFundAccount(view.wallet)) : null,
      requests: [...this.requests(owner), ...history].map(request => this.publicRequest(request)) };
  }
  private saveRequest(owner: string, request: StoredFundRequest): void {
    this.db.prepare('INSERT OR REPLACE INTO world_fund_requests VALUES(?,?,?)').run(owner, request.id, JSON.stringify(request));
  }
  private request(owner: string, id: string): StoredFundRequest {
    const row = this.db.prepare('SELECT data FROM world_fund_requests WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new ApiError(404, 'World transfer not found.');
    return JSON.parse(String(row.data)) as StoredFundRequest;
  }
  private depositAdapter(): void {
    if (!this.ledger.nonce || !this.ledger.depositState || !this.ledger.depositMessage || !this.ledger.transfer)
      throw new ApiError(503, 'Signed Dollar transfers are not configured.');
  }
  private checkDeposit(owner: string, accountId: string, amount: string, id: string): void {
    const pending = this.requests(owner).filter(request => request.id !== id && request.status === 'paying'
      && request.parameters.direction === 'deposit' && this.ledger.depositState!(request.payment!) !== 'accepted')
      .reduce((sum, request) => sum + BigInt(request.parameters.amount), 0n);
    if (BigInt(this.ledger.available(accountId)) + pending + BigInt(amount) > MAX_WORLD_FUNDS)
      throw new ApiError(409, 'World fund limit exceeded.');
  }
  prepareFund(owner: string, input: { id: string; direction: string; amount: string }, origin: string, csrf: string, now: number): FundRequest {
    this.recover();
    if (!input || Object.keys(input).sort().join() !== 'amount,direction,id'
      || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.id)
      || !['deposit', 'withdraw'].includes(input.direction) || typeof input.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(input.amount)
      || BigInt(input.amount) > MAX_WORLD_FUNDS) throw new ApiError(400, 'Invalid or excessive World transfer.');
    const address = this.address(owner), accountId = this.account(owner);
    if (!address || this.mode(owner) !== 'separate') throw new ApiError(409, 'Authorize a separate World budget first.');
    const previousRow = this.db.prepare('SELECT data FROM world_fund_requests WHERE owner=? AND id=?').get(owner, input.id);
    const previous = previousRow ? JSON.parse(String(previousRow.data)) as StoredFundRequest : null;
    if (previous) {
      if (previous.parameters.direction !== input.direction || previous.parameters.amount !== input.amount || previous.origin !== origin)
        throw new ApiError(409, 'World transfer ID is already bound to different parameters.');
      if (previous.status === 'cancelled') throw new ApiError(409, 'World transfer was discarded.');
      if (previous.parameters.direction !== 'deposit' || previous.status === 'complete') return this.publicRequest(previous);
      this.depositAdapter();
      if (this.ledger.depositState!(previous.payment!) !== 'conflict') return this.publicRequest(previous);
      if (this.pending.has(`${owner}:${input.id}`)) throw new ApiError(409, 'World transfer is in progress.');
    } else if (this.requests(owner).length >= 1000) throw new ApiError(409, 'World transfer request capacity reached.');
    const parameters = { direction: input.direction as FundParameters['direction'], amount: input.amount };
    const request: StoredFundRequest = { id: input.id, parameters, origin, accountId, wallet: address, message: '', status: 'prepared', at: now };
    if (parameters.direction === 'deposit') {
      this.depositAdapter();
      this.checkDeposit(owner, accountId, input.amount, input.id);
      if (BigInt(this.ledger.available(walletFundAccount(address))) < BigInt(input.amount)) throw new ApiError(409, 'Insufficient wallet funds.');
      const nonce = this.ledger.nonce!(walletFundAccount(address)) + 1;
      if (!Number.isSafeInteger(nonce)) throw new ApiError(409, 'Dollar nonce limit reached.');
      request.payment = { wallet: getAddress(address), to: accountId, amount: input.amount, nonce,
        memo: createHash('sha256').update(JSON.stringify([owner, input.id, origin, csrf])).digest('hex'), issuedAt: new Date(now).toISOString() };
      request.message = this.ledger.depositMessage!(request.payment);
    } else {
      if (BigInt(this.ledger.available(accountId)) < BigInt(input.amount)) throw new ApiError(409, 'Insufficient World funds.');
      request.message = ['Featheral World fund withdrawal', '', `World account: ${accountId}`, `Wallet: ${address}`,
        `Base units: ${input.amount}`, `Request: ${input.id}`, `Origin: ${origin}`, `Session: ${csrf}`, `Issued at: ${new Date(now).toISOString()}`,
        '', 'Move only this exact amount of existing World FTH$ to the authorized wallet. No Ethereum transaction is sent.'].join('\n');
    }
    this.saveRequest(owner, request);
    return this.publicRequest(request);
  }
  cancelFund(owner: string, id: string): FundView {
    this.recover();
    const request = this.request(owner, id);
    if (request.status === 'cancelled') return this.fundView(owner);
    if (request.status !== 'prepared') throw new ApiError(409, 'Only unsigned preparations can be discarded.');
    if (request.payment && this.ledger.depositState!(request.payment) === 'accepted') throw new ApiError(409, 'Payment already accepted.');
    request.status = 'cancelled';
    this.saveRequest(owner, request);
    return this.fundView(owner);
  }
  completeFund(owner: string, id: string, signature: string): Promise<FundView> {
    const key = `${owner}:${id}`;
    const active = this.pending.get(key);
    if (active) return active;
    const operation = this.settleFund(owner, id, signature);
    this.pending.set(key, operation);
    return operation.finally(() => { this.pending.delete(key); });
  }
  private async settleFund(owner: string, id: string, signature: string): Promise<FundView> {
    this.recover();
    const request = this.request(owner, id);
    if (request.status === 'cancelled') throw new ApiError(409, 'World transfer was discarded.');
    if (request.status === 'complete') return this.fundView(owner);
    if (this.mode(owner) !== 'separate' || this.address(owner) !== request.wallet || this.account(owner) !== request.accountId)
      throw new ApiError(409, 'World transfer authorization changed.');
    if (request.status === 'prepared') {
      let signer: string;
      try { signer = verifyMessage(request.message, signature).toLowerCase(); }
      catch { throw new ApiError(401, 'Signature must be from the authorized wallet.'); }
      if (signer !== request.wallet) throw new ApiError(401, 'Signature must be from the authorized wallet.');
      request.signature = signature;
    }
    if (request.parameters.direction === 'deposit') {
      this.depositAdapter();
      const payment = request.payment!, state = this.ledger.depositState!(payment);
      if (state === 'conflict') {
        request.status = 'prepared';
        delete request.signature;
        request.error = 'Dollar nonce changed. Refresh preparation and sign again.';
        this.saveRequest(owner, request);
        throw new ApiError(409, request.error);
      }
      if (state !== 'accepted') {
        this.checkDeposit(owner, request.accountId, request.parameters.amount, request.id);
        request.status = 'paying';
        this.saveRequest(owner, request);
        try {
          await this.ledger.transfer!({ ...payment, signature: request.signature! });
          if (this.ledger.depositState!(payment) !== 'accepted') throw new ApiError(503, 'Dollar payment has no durable receipt. Retry later.');
        }
        catch (error) {
          if (this.ledger.depositState!(payment) === 'conflict') {
            request.status = 'prepared';
            delete request.signature;
          }
          request.error = error instanceof Error ? error.message : 'Dollar payment failed.';
          this.saveRequest(owner, request);
          throw error;
        }
      }
      request.status = 'complete';
      delete request.error;
      this.saveRequest(owner, request);
    } else {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (BigInt(this.ledger.available(request.accountId)) < BigInt(request.parameters.amount)) throw new ApiError(409, 'Insufficient World funds.');
        const transaction = this.ledger.prepare([{ account: request.accountId, delta: `-${request.parameters.amount}` },
          { account: walletFundAccount(request.wallet), delta: request.parameters.amount }]);
        request.commitId = Number(this.db.prepare('INSERT INTO fund_commits(transaction_data) VALUES(?)').run(JSON.stringify(transaction)).lastInsertRowid);
        request.status = 'paying';
        this.saveRequest(owner, request);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.recover();
    }
    return this.fundView(owner);
  }
  total(): number {
    return Number(BigInt(this.ledger.supply()) / BASE_UNITS_PER_GAME_UNIT) / dollarsScale;
  }
}
