import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './store.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { isMarketAsset, isMarketResource } from '../src/market.ts';

export function migrateDollarEconomy(db: DatabaseSync, realTime: number): void {
  const rows = db.prepare("SELECT id,data FROM sessions WHERE COALESCE(json_extract(data,'$.account.currencyVersion'),0) != 4").all();
  const legacy = db.prepare('PRAGMA table_info(market_pools)').all().some(column => column.name === 'fthg');
  const orders = legacy ? db.prepare("SELECT owner,asset,side,price,remaining FROM market_orders WHERE status='open'").all() : [];
  const clockExists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='server_clock'").get();
  const clock = clockExists ? db.prepare('SELECT realTime,serverTime,speed FROM server_clock WHERE id=1').get() : undefined;
  const start = clock ? Number(clock.serverTime) + Math.max(0, realTime - Number(clock.realTime)) * Number(clock.speed) : realTime;
  const integer = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid balance in FTH$ migration.');
    return value;
  };
  const owners = new Set(orders.map(order => String(order.owner)));
  const byOwner = new Map<string, typeof orders>();
  for (const order of orders) {
    const owner = String(order.owner), entries = byOwner.get(owner) ?? [];
    entries.push(order); byOwner.set(owner, entries);
  }
  let metalRefund = 0, goldRefund = 0;
  for (const row of rows) {
    const session = JSON.parse(String(row.data)) as Session;
    const account = session.account;
    if (Number(account.currencyVersion) !== 3) throw new Error('Unsupported account currency in FTH$ migration.');
    const stock = account.game.stock as Record<string, number>;
    const beforeMetal = stock.metal, beforeGold = account.fthg;
    for (const order of byOwner.get(String(row.id)) ?? []) {
      const quantity = integer(order.remaining), price = integer(order.price), asset = String(order.asset);
      if (!quantity || !price) throw new Error('Invalid escrow in FTH$ migration.');
      if (order.side === 'buy') account.fthg = integer(account.fthg + integer(quantity * price));
      else if (order.side === 'sell' && ['wood', 'water', 'metal', 'oil', 'lithium'].includes(asset))
        stock[asset] = integer(integer(stock[asset]) + quantity);
      else if (order.side === 'sell' && account.inventory && isMarketAsset(asset) && !isMarketResource(asset) && quantity === 1 && !account.inventory.items.includes(asset)) {
        account.inventory.items.push(asset);
      } else throw new Error('Invalid reserved asset in FTH$ migration.');
    }
    const pending = account.pending as Record<string, number>;
    const converted = integer(integer(stock.lithium ?? 0) * dollarsScale)
      + Math.floor(integer(pending.lithium ?? 0) / 6);
    account.game.dollars = integer(converted);
    metalRefund = integer(metalRefund + (account.game.stage >= 0 ? stock.metal - beforeMetal : 0));
    goldRefund = integer(goldRefund + account.fthg - beforeGold);
    delete stock.lithium; delete pending.lithium;
    if (account.workforce) {
      delete (account.workforce.crews as Record<string, unknown>).lithium;
      if ('allocation' in account.workforce) delete (account.workforce.allocation as Record<string, unknown>).lithium;
    }
    if (account.inventory) { account.inventory.marketReserved = []; account.inventory.marketSelling = []; }
    account.currencyVersion = 4;
    account.incomeReadyAt = Math.max(start, account.updatedAt) + worldWeekMs;
    account.receipt = null;
    account.revision++;
    account.game.log = ['FTH$ update: Lithium converted 1:1; Gold offers refunded. Gold balances preserved.', ...account.game.log].slice(0, 40);
    db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), row.id!);
    owners.delete(String(row.id));
  }
  if (owners.size) throw new Error('Unmatched Gold escrow in FTH$ migration.');
  db.exec('CREATE TABLE IF NOT EXISTS gold_pool (id INTEGER PRIMARY KEY CHECK(id=1), gold INTEGER NOT NULL CHECK(gold>0), dollars INTEGER NOT NULL CHECK(dollars>0))');
  if (!db.prepare('SELECT id FROM gold_pool WHERE id=1').get()) {
    const gold = legacy ? integer(db.prepare('SELECT COALESCE(SUM(fthg),0) AS total FROM market_pools').get()!.total) : 1000 * dollarsScale;
    const reserve = Math.max(gold, dollarsScale);
    db.prepare('INSERT INTO gold_pool VALUES(1,?,?)').run(reserve, integer(reserve * 1000));
  }
  if (legacy) {
    db.exec("UPDATE market_orders SET status='cancelled' WHERE status='open'");
    for (const table of ['market_pools', 'market_orders', 'market_fills', 'market_receipts'])
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_gold_${table}`);
    for (const index of ['market_book', 'market_owner', 'market_history', 'market_buy_escrow']) db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  const columns = db.prepare('PRAGMA table_info(public_totals)').all();
  if (columns.length && metalRefund) db.prepare('UPDATE public_totals SET metal=metal+? WHERE id=1').run(metalRefund);
  if (columns.some(column => column.name === 'fthg') && goldRefund) db.prepare('UPDATE public_totals SET fthg=fthg+? WHERE id=1').run(goldRefund);
}
