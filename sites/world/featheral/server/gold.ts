import type { DatabaseSync } from 'node:sqlite';
import { accrue, ApiError, restoreSnapshotUpkeep, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import type { GoldCommand, GoldSnapshot } from '../src/gold.ts';
import { note } from '../src/engine.ts';
import { poolPayment } from '../src/pool-pricing.ts';

export class GoldExchange {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS gold_receipts (owner TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id))');
  }
  private pool(): { gold: number; dollars: number } {
    const row = this.db.prepare('SELECT gold,dollars FROM gold_pool WHERE id=1').get()!;
    return { gold: Number(row.gold), dollars: Number(row.dollars) };
  }
  rate(): number { const pool = this.pool(); return pool.dollars / pool.gold; }
  private cost(side: 'buy' | 'sell', quantity: number): number | null {
    const pool = this.pool();
    if (side === 'buy' && quantity >= pool.gold) return null;
    let cost: number;
    try { cost = poolPayment({ units: pool.gold, dollars: pool.dollars }, side, quantity); }
    catch (error) { if (!(error instanceof RangeError)) throw error; return null; }
    return cost > 0 ? cost : null;
  }
  read(quantity: number): GoldSnapshot {
    let units: number;
    try { units = dollarsUnits(quantity); } catch (error) { if (!(error instanceof RangeError)) throw error; throw new ApiError(400, 'Enter a Gold amount with up to four decimal places.'); }
    if (units < 1 || units > 10000 * dollarsScale) throw new ApiError(400, 'Gold amount must be between 0.0001 and 10,000.');
    const buy = this.cost('buy', units), sell = this.cost('sell', units);
    return { quantity, rate: this.rate(), quotes: { buy: { dollars: (buy ?? 0) / dollarsScale, available: buy !== null }, sell: { dollars: (sell ?? 0) / dollarsScale, available: sell !== null } } };
  }
  apply(owner: string, account: Account, value: unknown, now: number, realTime: number): ReturnType<typeof snapshot> & { gold: GoldSnapshot; message: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid Gold action.');
    const body = value as Record<string, unknown>, raw = body.command;
    if (Object.keys(body).sort().join() !== 'command,id,revision' || typeof body.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
      || !Number.isSafeInteger(body.revision)) throw new ApiError(400, 'Invalid Gold action envelope.');
    const request = JSON.stringify({ revision: body.revision, command: raw });
    const receipt = this.db.prepare('SELECT request,result FROM gold_receipts WHERE owner=? AND id=?').get(owner, body.id);
    if (receipt) {
      if (receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
      const saved = JSON.parse(String(receipt.result)) as ReturnType<GoldExchange['apply']>;
      return { ...saved, waterUpkeep: restoreSnapshotUpkeep(saved, account, now) };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'Invalid Gold command.');
    const c = raw as Record<string, unknown>;
    if (Object.keys(c).sort().join() !== 'limitDollars,quantity,side,type' || c.type !== 'gold' || (c.side !== 'buy' && c.side !== 'sell')
      || typeof c.quantity !== 'number' || typeof c.limitDollars !== 'number') throw new ApiError(400, 'Invalid Gold command fields.');
    const command: GoldCommand = { type: 'gold', side: c.side, quantity: c.quantity, limitDollars: c.limitDollars };
    const quote = this.read(command.quantity);
    let limit: number;
    try { limit = dollarsUnits(command.limitDollars); } catch (error) { if (!(error instanceof RangeError)) throw error; throw new ApiError(400, 'Invalid FTH$ payment limit.'); }
    if (limit < 1 || body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    if (realTime - account.lastActionAt < 250) throw new ApiError(429, 'Actions are limited to four per second.');
    if (account.game.stage < 0) throw new ApiError(409, 'Establish a settlement before trading.');
    accrue(account, now);
    if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    const quantity = dollarsUnits(command.quantity), cost = this.cost(command.side, quantity);
    if (cost === null || (command.side === 'buy' ? cost > limit : cost < limit)) throw new ApiError(409, 'Gold quote changed. Refresh and retry.');
    const pool = this.pool();
    if (command.side === 'buy') {
      if (account.game.dollars < cost) throw new ApiError(409, 'Not enough FTH$ for this order.');
      account.game.dollars -= cost; account.fthg += quantity; pool.dollars += cost; pool.gold -= quantity;
    } else {
      if (account.fthg < quantity) throw new ApiError(409, 'Not enough Featheral Gold.');
      account.fthg -= quantity; account.game.dollars += cost; pool.dollars -= cost; pool.gold += quantity;
    }
    if (![account.fthg, account.game.dollars, pool.gold, pool.dollars].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new ApiError(409, 'Currency balance limit reached.');
    this.db.prepare('UPDATE gold_pool SET gold=?,dollars=? WHERE id=1').run(pool.gold, pool.dollars);
    account.revision++; account.lastActionAt = realTime;
    const result = { ...snapshot(account), gold: this.read(quote.quantity), message: note(account.game, 'Featheral Gold exchange completed.') };
    this.db.prepare('INSERT INTO gold_receipts VALUES(?,?,?,?)').run(owner, body.id, request, JSON.stringify(result));
    return result;
  }
}
