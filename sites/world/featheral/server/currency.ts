import type { DatabaseSync } from 'node:sqlite';
import { note } from '../src/engine.ts';
import { isMarketAsset, isMarketResource } from '../src/market.ts';
import { resources } from './economy.ts';
import type { Session } from './store.ts';
import { fthgScale } from '../src/fthg.ts';

function renameLegacyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameLegacyKeys);
  if (!value || typeof value !== 'object') return value === 'gold' ? 'metal' : value;
  const entries = new Map<string, unknown>();
  for (const [key, child] of Object.entries(value)) {
    const renamed = key.replace(/^gold/, 'metal').replace(/Gold/g, 'Metal');
    if (entries.has(renamed)) throw new Error('Conflicting legacy resource keys during currency migration.');
    entries.set(renamed, renameLegacyKeys(child));
  }
  return Object.fromEntries(entries);
}
export function migrateCurrencies(db: DatabaseSync): void {
  if (db.prepare("SELECT id FROM sessions WHERE json_extract(data,'$.account.currencyVersion') NOT IN (2,3,4) LIMIT 1").get())
    throw new Error('Unsupported currency version during migration.');
  const legacyMarket = db.prepare('PRAGMA table_info(market_pools)').all().some(column => column.name === 'gold');
  const orders = legacyMarket ? db.prepare("SELECT owner, asset, side, price, remaining FROM market_orders WHERE status = 'open'").all() : [];
  const owners = new Set(orders.map(order => String(order.owner)));
  const rows = db.prepare("SELECT id, data FROM sessions WHERE json_extract(data, '$.account.currencyVersion') IS NULL").all();
  let publicRefund = 0;
  for (const row of rows) {
    const session = renameLegacyKeys(JSON.parse(String(row.data))) as Session, account = session.account;
    if (account.currencyVersion !== undefined) throw new Error('Unsupported currency version during migration.');
    if (!resources.every(resource => Number.isSafeInteger(account.game.stock[resource]) && account.game.stock[resource] >= 0))
      throw new Error('Invalid legacy resource balance during currency migration.');
    const beforeMetal = account.game.stock.metal;
    for (const order of orders.filter(order => order.owner === row.id)) {
      const quantity = Number(order.remaining), price = Number(order.price);
      if ((!isMarketAsset(order.asset) && order.asset !== 'lithium') || !Number.isSafeInteger(quantity) || quantity <= 0
        || !Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(price * quantity))
        throw new Error('Invalid escrow during currency migration.');
      if (order.side === 'buy') account.game.stock.metal += quantity * price;
      else if (order.side === 'sell') {
        if (order.asset === 'lithium') {
          const stock = account.game.stock as typeof account.game.stock & { lithium?: number };
          if (!Number.isSafeInteger(stock.lithium) || stock.lithium! < 0)
            throw new Error('Invalid legacy Lithium balance during currency migration.');
          stock.lithium = stock.lithium! + quantity;
        } else if (isMarketResource(order.asset)) account.game.stock[order.asset] += quantity;
        else {
          if (!account.inventory || quantity !== 1 || account.inventory.items.includes(order.asset))
            throw new Error('Invalid item escrow during currency migration.');
          account.inventory.items.push(order.asset);
        }
      } else throw new Error('Invalid order side during currency migration.');
    }
    if (!resources.every(resource => Number.isSafeInteger(account.game.stock[resource]) && account.game.stock[resource] >= 0))
      throw new Error('Currency migration refund exceeds the account limit.');
    if (account.game.stage >= 0) publicRefund += account.game.stock.metal - beforeMetal;
    if (!Number.isSafeInteger(publicRefund)) throw new Error('Currency migration refunds exceed the public counter limit.');
    if (account.inventory) { account.inventory.marketReserved = []; account.inventory.marketSelling = []; }
    account.currencyVersion = 3; account.fthg = 0; account.receipt = null; account.revision++;
    account.game.log = account.game.log.map(entry => entry.replace(/\bgold\b/g, 'metal').replace(/\bGold\b/g, 'Metal').replace(/금화/g, '금속'));
    note(account.game, 'Currency update: existing balances and escrow returned as Metal. FTHG starts at zero.');
    db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session), row.id!);
    owners.delete(String(row.id));
  }
  if (owners.size) throw new Error('Legacy marketplace escrow has no matching legacy account.');
  if (legacyMarket) {
    db.exec("UPDATE market_orders SET status = 'cancelled' WHERE status = 'open'");
    for (const name of ['market_pools', 'market_orders', 'market_fills', 'market_receipts'])
      db.exec(`ALTER TABLE ${name} RENAME TO legacy_metal_${name}`);
    for (const name of ['market_book', 'market_owner', 'market_history']) db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  const totals = db.prepare('PRAGMA table_info(public_totals)').all();
  if (totals.some(column => column.name === 'gold')) db.exec('ALTER TABLE public_totals RENAME COLUMN gold TO metal');
  if (totals.length && publicRefund) db.prepare('UPDATE public_totals SET metal = metal + ? WHERE id = 1').run(publicRefund);
}

export function migrateFthgPrecision(db: DatabaseSync): void {
  if (db.prepare("SELECT id FROM sessions WHERE json_extract(data,'$.account.currencyVersion') NOT IN (2,3,4) LIMIT 1").get())
    throw new Error('Unsupported currency version during migration.');
  db.exec('CREATE TABLE IF NOT EXISTS market_currency (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
  const version = db.prepare('SELECT version FROM market_currency WHERE id=1').get();
  if (version && version.version !== 3) throw new Error('Unsupported marketplace currency version.');
  const scale = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * fthgScale))
      throw new Error('Invalid or overflowing FTHG balance during precision migration.');
    return value * fthgScale;
  };
  for (const row of db.prepare("SELECT id,data FROM sessions WHERE json_extract(data,'$.account.currencyVersion')=2").all()) {
    if (version) throw new Error('Unmigrated FTHG account in a migrated marketplace.');
    const session = JSON.parse(String(row.data)) as Session;
    session.account.fthg = scale(session.account.fthg);
    session.account.currencyVersion = 3;
    session.account.revision++;
    session.account.receipt = null;
    db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), row.id!);
  }
  if (!version) {
    if (db.prepare('PRAGMA table_info(market_pools)').all().some(column => column.name === 'fthg')) {
      for (const row of db.prepare('SELECT asset,fthg FROM market_pools').all())
        db.prepare('UPDATE market_pools SET fthg=? WHERE asset=?').run(scale(row.fthg), row.asset!);
      for (const row of db.prepare('SELECT id,price,quantity FROM market_orders').all()) {
        const price = scale(row.price);
        if (!Number.isSafeInteger(price * Number(row.quantity))) throw new Error('FTHG offer exceeds the safe limit during precision migration.');
        db.prepare('UPDATE market_orders SET price=? WHERE id=?').run(price, row.id!);
      }
      for (const row of db.prepare('SELECT id,fthg,price FROM market_fills').all()) {
        const price = Number(row.price) * fthgScale;
        if (!Number.isFinite(price) || price < 0 || price > Number.MAX_SAFE_INTEGER) throw new Error('Invalid FTHG history during precision migration.');
        db.prepare('UPDATE market_fills SET fthg=?,price=? WHERE id=?').run(scale(row.fthg), price, row.id!);
      }
    }
    db.exec('INSERT INTO market_currency VALUES(1,3)');
  }
}
