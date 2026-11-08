import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import type { Account } from './economy.ts';
import { ApiError } from './economy.ts';
import type { Command, FederationVault } from '../src/api-types.ts';
import { marketResources as resources, marketBasePrice } from '../src/market.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { environmentAt } from '../src/environment.ts';

export class FederationTreasury {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS federation_vaults (
      federation TEXT PRIMARY KEY, wood INTEGER NOT NULL DEFAULT 0, water INTEGER NOT NULL DEFAULT 0,
      metal INTEGER NOT NULL DEFAULT 0, oil INTEGER NOT NULL DEFAULT 0, dollars INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS federation_contributions (
      id INTEGER PRIMARY KEY, federation TEXT NOT NULL, owner TEXT NOT NULL, year INTEGER NOT NULL,
      asset TEXT NOT NULL, quantity INTEGER NOT NULL, value INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS federation_contribution_scope ON federation_contributions(federation,year,owner);`);
  }
  contribute(account: Account, owner: string, command: Extract<Command, { type: 'federation-contribute' }>, now: number): string {
    const federation = account.game.federation;
    if (!federation) throw new ApiError(409, 'Join a federation before contributing.');
    const asset = command.asset;
    if (![...resources, 'dollars'].includes(asset) || !Number.isFinite(command.amount) || command.amount <= 0
      || command.amount > 100000000 || (asset === 'dollars'
        ? !/^\d+(?:\.\d{1,4})?$/.test(String(command.amount)) : !Number.isSafeInteger(command.amount)))
      throw new ApiError(400, 'Invalid command values.');
    const quantity = asset === 'dollars' ? dollarsUnits(command.amount) : command.amount;
    const value = asset === 'dollars' ? quantity : command.amount * dollarsUnits(marketBasePrice(asset));
    const balance = asset === 'dollars' ? account.game.dollars : account.game.stock[asset];
    if (balance < quantity) throw new ApiError(409, 'Not enough supplies for this contribution.');
    const row = this.db.prepare('SELECT * FROM federation_vaults WHERE federation=?').get(federation);
    const total = Number(this.db.prepare('SELECT COALESCE(SUM(value),0) AS value FROM federation_contributions WHERE federation=?').get(federation)!.value);
    if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(total + value)
      || !Number.isSafeInteger(Number(row?.[asset] ?? 0) + quantity)) throw new ApiError(409, 'Federation vault limit reached.');
    this.db.prepare('INSERT OR IGNORE INTO federation_vaults(federation) VALUES(?)').run(federation);
    this.db.prepare(`UPDATE federation_vaults SET ${asset}=${asset}+? WHERE federation=?`).run(quantity, federation);
    this.db.prepare('INSERT INTO federation_contributions(federation,owner,year,asset,quantity,value,at) VALUES(?,?,?,?,?,?,?)')
      .run(federation, owner, environmentAt(now).year, asset, quantity, value, now);
    if (asset === 'dollars') account.game.dollars -= quantity;
    else account.game.stock[asset] -= quantity;
    return 'Contribution deposited in the common vault.';
  }
  view(federation: string, owner: string, now: number): FederationVault {
    const year = environmentAt(now).year;
    const empty = () => ({ wood: 0, water: 0, metal: 0, oil: 0, dollars: 0 });
    const row = this.db.prepare('SELECT * FROM federation_vaults WHERE federation=?').get(federation);
    const stock = empty();
    for (const asset of [...resources, 'dollars'] as const) stock[asset] = Number(row?.[asset] ?? 0);
    const entries = this.db.prepare(`SELECT owner,asset,SUM(quantity) AS quantity,SUM(value) AS value,
      SUM(CASE WHEN year=? THEN value ELSE 0 END) AS annualValue,
      SUM(CASE WHEN year=? THEN quantity ELSE 0 END) AS annualQuantity
      FROM federation_contributions WHERE federation=? GROUP BY owner,asset`).all(year, year, federation);
    const members = new Map<string, FederationVault['contributors'][number]>();
    for (const identity of this.db.prepare(`SELECT sessions.id,COALESCE(json_extract(data,'$.account.customization.settlementName'),chat_profiles.nickname) AS name
      FROM sessions LEFT JOIN chat_profiles ON chat_profiles.owner=sessions.id
      WHERE json_extract(data,'$.account.game.federation')=?`).all(federation)) {
      const id = String(identity.id);
      members.set(id, { id, name: identity.name ? String(identity.name) : id.slice(0, 12), yours: id === owner,
        contributed: empty(), annualContributed: empty(), value: 0, annualValue: 0, allTimePercent: 0, annualPercent: 0 });
    }
    let totalValue = 0, annualValue = 0;
    const annualContributed = empty();
    for (const entry of entries) {
      const id = String(entry.owner), asset = String(entry.asset);
      if (![...resources, 'dollars'].includes(asset)) throw new Error('Invalid federation contribution asset.');
      let member = members.get(id);
      if (!member) {
        const identity = this.db.prepare(`SELECT COALESCE(json_extract(data,'$.account.customization.settlementName'),chat_profiles.nickname) AS name
          FROM sessions LEFT JOIN chat_profiles ON chat_profiles.owner=sessions.id WHERE sessions.id=?`).get(id);
        member = { id, name: identity?.name ? String(identity.name) : id.slice(0, 12), yours: id === owner,
          contributed: empty(), annualContributed: empty(), value: 0, annualValue: 0, allTimePercent: 0, annualPercent: 0 };
        members.set(id, member);
      }
      const key = asset as keyof typeof stock;
      member.contributed[key] = Number(entry.quantity);
      member.annualContributed[key] = Number(entry.annualQuantity);
      annualContributed[key] += Number(entry.annualQuantity);
      member.value += Number(entry.value); member.annualValue += Number(entry.annualValue);
      totalValue += Number(entry.value); annualValue += Number(entry.annualValue);
    }
    for (const member of members.values()) {
      member.allTimePercent = totalValue ? member.value / totalValue * 100 : 0;
      member.annualPercent = annualValue ? member.annualValue / annualValue * 100 : 0;
      member.value /= dollarsScale; member.annualValue /= dollarsScale;
      member.contributed.dollars /= dollarsScale; member.annualContributed.dollars /= dollarsScale;
    }
    stock.dollars /= dollarsScale; annualContributed.dollars /= dollarsScale;
    return { year, stock, annualContributed, totalValue: totalValue / dollarsScale, annualValue: annualValue / dollarsScale,
      contributors: [...members.values()].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)),
      taxStatus: 'pending' };
  }
}
