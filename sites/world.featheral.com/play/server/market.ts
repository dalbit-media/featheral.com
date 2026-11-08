import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { accrue, ApiError, parseActionEnvelope, restoreSnapshotUpkeep, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import { inventory } from './inventory.ts';
import { note } from '../src/engine.ts';
import { inventoryUsed, isCollectible, itemStorage, sellableItemCount } from '../src/items.ts';
import { isLiquidAsset, isMarketAsset, isMarketResource, marketAssets, marketPriceFloor, marketQuantityLimit, marketSaleQuantityLimit, marketResources } from '../src/market.ts';
import type { HalfSaleQuote, MarketAsset, MarketCommand, MarketFill, MarketOrder, MarketResource, MarketSide, MarketSnapshot } from '../src/market.ts';
import type { Snapshot } from '../src/api-types.ts';
import type { Session } from './store.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { poolPayment, poolPaymentUnits } from '../src/pool-pricing.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import type { CollectionQuote, Command } from '../src/api-types.ts';

interface Pool { units: number; dollars: number; depthUnits?: bigint; depthDollars?: bigint }
interface Order extends MarketOrder { owner: string }
interface Step { quantity: number; dollars: number; maker: Order | null }
export interface ExchangeResult extends Snapshot { market: MarketSnapshot; message?: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
const positive = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
function orderRow(row: Record<string, unknown>): Order {
  if (!isMarketAsset(row.asset) || (row.side !== 'buy' && row.side !== 'sell')
    || !['open', 'filled', 'cancelled'].includes(String(row.status))) throw new Error('Invalid stored market order.');
  return { id: Number(row.id), owner: String(row.owner), asset: row.asset, side: row.side, price: Number(row.price),
    quantity: Number(row.quantity), remaining: Number(row.remaining), status: row.status as MarketOrder['status'], createdAt: Number(row.createdAt) };
}
export function parseMarketCommand(value: unknown): MarketCommand {
  const c = object(value);
  if (c.type === 'fund-pool') {
    if (Object.keys(c).sort().join() !== 'asset,dollars,quantity,type' || !isMarketAsset(c.asset) || !isLiquidAsset(c.asset)
      || !positive(c.quantity, marketQuantityLimit(c.asset))) throw new ApiError(400, 'Invalid pool funding command.');
    return { type: 'fund-pool', asset: c.asset, quantity: c.quantity, dollars: paymentUnits(c.dollars, 10000000000) };
  }
  if (c.type === 'sell-half') {
    if (Object.keys(c).sort().join() !== 'sales,type' || !Array.isArray(c.sales) || !c.sales.length || c.sales.length > 4)
      throw new ApiError(400, 'Invalid half-sale command.');
    const assets = new Set<MarketAsset>();
    const sales = c.sales.map(value => {
      const sale = object(value);
      if (Object.keys(sale).sort().join() !== 'asset,limitDollars,quantity' || !isMarketAsset(sale.asset) || !isMarketResource(sale.asset)
        || assets.has(sale.asset) || !positive(sale.quantity, Number.MAX_SAFE_INTEGER))
        throw new ApiError(400, 'Invalid half-sale command.');
      assets.add(sale.asset);
      return { asset: sale.asset, quantity: sale.quantity, limitDollars: paymentUnits(sale.limitDollars, Number.MAX_SAFE_INTEGER / dollarsScale) };
    });
    return { type: 'sell-half', sales };
  }
  const fields = c.type === 'cancel' ? ['type', 'orderId']
    : c.type === 'spot' ? ['type', 'asset', 'side', 'quantity', 'limitDollars']
      : c.type === 'limit' ? ['type', 'asset', 'side', 'quantity', 'price'] : [];
  if (!fields.length || Object.keys(c).sort().join() !== fields.sort().join()) throw new ApiError(400, 'Invalid market command fields.');
  if (c.type === 'cancel') {
    if (!positive(c.orderId, Number.MAX_SAFE_INTEGER)) throw new ApiError(400, 'Invalid market command values.');
  } else if (!isMarketAsset(c.asset) || !['buy', 'sell'].includes(String(c.side)) || !positive(c.quantity, c.side === 'sell' ? marketSaleQuantityLimit(c.asset) : marketQuantityLimit(c.asset))) {
    throw new ApiError(400, 'Invalid market command values.');
  }
  if (c.type === 'cancel') return c as MarketCommand;
  const units = paymentUnits(c.type === 'spot' ? c.limitDollars : c.price, c.type === 'spot'
    ? c.side === 'sell' && isMarketAsset(c.asset) && isMarketResource(c.asset) ? Number.MAX_SAFE_INTEGER / dollarsScale : 10000000000 : 1000000);
  return { ...c, ...(c.type === 'spot' ? { limitDollars: units } : { price: units }) } as MarketCommand;
}
function paymentUnits(value: unknown, maximum: number): number {
  let units: number;
  try { units = dollarsUnits(value); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ApiError(400, 'FTH$ prices must have at most four decimal places.');
  }
  if (!positive(units, maximum * dollarsScale))
    throw new ApiError(400, 'Invalid market command values.');
  return units;
}
function poolCost(pool: Pool, side: MarketSide, quantity: number): number {
  try { return poolPayment(pool, side, quantity); }
  catch (error) { if (!(error instanceof RangeError)) throw error; throw new ApiError(409, 'Market pool limit reached.'); }
}
function poolSideAvailable(pool: Pool, side: MarketSide, floor: number): boolean {
  if (pool.units < (side === 'buy' ? pool.depthUnits ? 1 : 2 : 0) || pool.dollars <= 0) return false;
  const cost = poolPaymentUnits(pool, side, 1);
  return cost >= BigInt(floor) && cost <= BigInt(side === 'buy' ? Number.MAX_SAFE_INTEGER - pool.dollars : pool.dollars)
    && (side === 'buy' || compareMarginal(pool, side, 1, floor) >= 0);
}
function compareMarginal(pool: Pool, side: MarketSide, quantity: number, price: number): number {
  const units = BigInt(pool.units) + (pool.depthUnits ?? 0n) + (side === 'buy' ? -BigInt(quantity) : BigInt(quantity));
  if (units <= 0n) return 1;
  if (price === Infinity) return -1;
  const numerator = (BigInt(pool.dollars) + (pool.depthDollars ?? 0n)) * (BigInt(pool.units) + (pool.depthUnits ?? 0n))
    * BigInt(100 + (side === 'buy' ? monetaryPolicy.poolSpreadPercent : -monetaryPolicy.poolSpreadPercent));
  const boundary = BigInt(price) * 100n * units ** 2n;
  return numerator < boundary ? -1 : numerator > boundary ? 1 : 0;
}
function movePool(pool: Pool, side: MarketSide, quantity: number, dollars: number): void {
  pool.units += side === 'buy' ? -quantity : quantity;
  pool.dollars += side === 'buy' ? dollars : -dollars;
  if (![pool.units, pool.dollars].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new ApiError(409, 'Market pool limit reached.');
}
export class Exchange {
  private db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS market_pools (asset TEXT PRIMARY KEY, units INTEGER NOT NULL, dollars INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, asset TEXT NOT NULL,
      side TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL, remaining INTEGER NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS market_book ON market_orders(asset, status, side, price, id);
      CREATE INDEX IF NOT EXISTS market_owner ON market_orders(owner, status, id);
      CREATE INDEX IF NOT EXISTS market_buy_escrow ON market_orders(price,remaining) WHERE side='buy' AND status='open';
      CREATE TABLE IF NOT EXISTS market_fills (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, quantity INTEGER NOT NULL,
      dollars INTEGER NOT NULL, price REAL NOT NULL, time INTEGER NOT NULL, venue TEXT NOT NULL, buyer TEXT NOT NULL, seller TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS market_history ON market_fills(asset, id);
      CREATE INDEX IF NOT EXISTS market_fills_buyer ON market_fills(buyer, id);
      CREATE INDEX IF NOT EXISTS market_fills_seller ON market_fills(seller, id);
      CREATE TABLE IF NOT EXISTS market_receipts (owner TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,id));`);
    db.exec('CREATE TABLE IF NOT EXISTS market_resource_depth (asset TEXT PRIMARY KEY, units TEXT NOT NULL, dollars TEXT NOT NULL)');
    const insert = db.prepare('INSERT OR IGNORE INTO market_pools VALUES (?, ?, ?)');
    for (const asset of marketAssets) {
      insert.run(asset, 0, 0);
    }
  }
  private pool(asset: MarketAsset): Pool {
    const row = this.db.prepare('SELECT units, dollars FROM market_pools WHERE asset = ?').get(asset)!;
    const pool: Pool = { units: Number(row.units), dollars: Number(row.dollars) };
    if (isLiquidAsset(asset)) {
      // Retain the historical table name. Depth is not spendable; pin once for every asset.
      if (pool.units > 0 && pool.dollars > 0)
        this.db.prepare('INSERT OR IGNORE INTO market_resource_depth VALUES(?,?,?)')
          .run(asset, (BigInt(pool.units) * 9n).toString(), (BigInt(pool.dollars) * 9n).toString());
      const depth = this.db.prepare('SELECT units,dollars FROM market_resource_depth WHERE asset=?').get(asset);
      if (depth) { pool.depthUnits = BigInt(String(depth.units)); pool.depthDollars = BigInt(String(depth.dollars)); }
    }
    return pool;
  }
  private orders(asset: MarketAsset, side: MarketSide, owner: string, realTime: number): Order[] {
    return this.db.prepare(`SELECT o.* FROM market_orders o JOIN sessions s ON s.id = o.owner
      WHERE o.asset = ? AND o.side = ? AND o.status = 'open' AND o.owner != ? AND s.expires > ?
      ORDER BY o.price ${side === 'sell' ? 'ASC' : 'DESC'}, o.id ASC`).all(asset, side, owner, realTime).map(orderRow)
      .filter(order => order.price >= dollarsUnits(marketPriceFloor(asset)));
  }
  resourceFundingRequired(asset: MarketAsset, quantity: number): bigint | null {
    if (!isLiquidAsset(asset) || quantity === 0) return 0n;
    const pool = this.pool(asset);
    if (pool.depthUnits === undefined || pool.depthDollars === undefined) return null;
    const q = BigInt(quantity), spread = BigInt(monetaryPolicy.poolSpreadPercent);
    // Solve payment(q) <= real dollars; virtual pricing depth is never spendable.
    const numerator = (100n - spread) * q * pool.depthDollars;
    const denominator = 100n * (BigInt(pool.units) + pool.depthUnits) + spread * q;
    const funded = (numerator + denominator - 1n) / denominator;
    // Matching also requires the final marginal price to reach one accounting unit.
    const units = BigInt(pool.units) + pool.depthUnits;
    const floor = BigInt(dollarsUnits(marketPriceFloor(asset)));
    const marginalNumerator = floor * 100n * (units + q) ** 2n;
    const marginalDenominator = (100n - spread) * units;
    const dollarsAtMinimum = (marginalNumerator + marginalDenominator - 1n) / marginalDenominator;
    const precision = dollarsAtMinimum > pool.depthDollars ? dollarsAtMinimum - pool.depthDollars : 0n;
    return funded > precision ? funded : precision;
  }
  private plan(owner: string, asset: MarketAsset, side: MarketSide, quantity: number, realTime: number, limit?: number): Step[] {
    const makers = this.orders(asset, side === 'buy' ? 'sell' : 'buy', owner, realTime)
      .filter(order => limit === undefined || (side === 'buy' ? order.price <= limit : order.price >= limit));
    const pool = this.pool(asset), steps: Step[] = [], floor = dollarsUnits(marketPriceFloor(asset));
    let remaining = quantity, index = 0;
    while (remaining > 0) {
      const pooled = isLiquidAsset(asset) && poolSideAvailable(pool, side, floor);
      const maker = makers[index], comparison = maker && pooled ? compareMarginal(pool, side, 1, maker.price) : 0;
      if (maker && (!pooled || (side === 'buy' ? comparison >= 0 : comparison <= 0))) {
        const quantity = Math.min(remaining, maker.remaining);
        steps.push({ quantity, dollars: quantity * maker.price, maker });
        remaining -= quantity;
        if (quantity === maker.remaining) index++;
        continue;
      }
      if (!pooled) break;
      const boundary = side === 'buy' ? Math.min(maker?.price ?? Infinity, limit ?? Infinity)
        : Math.max(maker?.price ?? 0, limit ?? 0, floor);
      let low = 0, high = Math.min(remaining, side === 'buy' ? pool.units - (pool.depthUnits ? 0 : 1) : Number.MAX_SAFE_INTEGER - pool.units);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2), comparison = compareMarginal(pool, side, middle, boundary);
        const cost = poolPaymentUnits(pool, side, middle);
        const funded = cost <= BigInt(side === 'buy' ? Number.MAX_SAFE_INTEGER - pool.dollars : pool.dollars);
        if (funded && (side === 'buy' ? comparison <= 0 : comparison >= 0)) low = middle; else high = middle - 1;
      }
      if (low) {
        const dollars = poolCost(pool, side, low);
        if (BigInt(dollars) < BigInt(low) * BigInt(floor)) break;
        steps.push({ quantity: low, dollars, maker: null }); movePool(pool, side, low, dollars); remaining -= low;
      } else if (maker) {
        const quantity = Math.min(remaining, maker.remaining);
        steps.push({ quantity, dollars: quantity * maker.price, maker }); remaining -= quantity;
        if (quantity === maker.remaining) index++;
      } else break;
    }
    return steps;
  }
  read(owner: string, account: Account, _now: number, realTime: number, asset: MarketAsset, quantity: number): ExchangeResult {
    const level = (side: MarketSide) => this.db.prepare(`SELECT price, SUM(remaining) AS quantity FROM market_orders o
      JOIN sessions s ON s.id = o.owner WHERE asset = ? AND side = ? AND status = 'open' AND s.expires > ? AND price >= ?
      GROUP BY price ORDER BY price ${side === 'buy' ? 'DESC' : 'ASC'} LIMIT 12`).all(asset, side, realTime, dollarsUnits(marketPriceFloor(asset)))
      .map(row => ({ price: Number(row.price) / dollarsScale, quantity: Number(row.quantity) }));
    const quote = (side: MarketSide) => {
      const steps = this.plan(owner, asset, side, quantity, realTime), filled = steps.reduce((sum, step) => sum + step.quantity, 0);
      return { quantity, dollars: steps.reduce((sum, step) => sum + step.dollars, 0) / dollarsScale, available: filled === quantity };
    };
    const fills = (rows: Record<string, unknown>[]): MarketFill[] =>
      rows.map(row => ({ id: Number(row.id), asset: String(row.asset) as MarketAsset, quantity: Number(row.quantity),
        dollars: Number(row.dollars) / dollarsScale, price: Number(row.price) / dollarsScale, time: Number(row.time),
        venue: row.venue === 'players' ? 'players' : 'system', ...(row.buyer !== undefined ? { side: row.buyer === owner ? 'buy' as const : 'sell' as const } : {}) }));
    const market: MarketSnapshot = {
      asset, quantity, bids: level('buy'), asks: level('sell'), quotes: { buy: quote('buy'), sell: quote('sell') },
      tickers: marketAssets.map(asset => {
        const pool = this.pool(asset), last = this.db.prepare('SELECT price FROM market_fills WHERE asset = ? ORDER BY id DESC LIMIT 1').get(asset);
        const pooled = isLiquidAsset(asset) && pool.dollars > 0;
        const floor = dollarsUnits(marketPriceFloor(asset));
        const bid = this.db.prepare(`SELECT MAX(price) AS price FROM market_orders o JOIN sessions s ON s.id = o.owner WHERE asset = ? AND side = 'buy' AND status = 'open' AND s.expires > ? AND price >= ?`).get(asset, realTime, floor);
        const ask = this.db.prepare(`SELECT MIN(price) AS price FROM market_orders o JOIN sessions s ON s.id = o.owner WHERE asset = ? AND side = 'sell' AND status = 'open' AND s.expires > ? AND price >= ?`).get(asset, realTime, floor);
        const poolBid = pooled && poolSideAvailable(pool, 'sell', floor) ? poolCost(pool, 'sell', 1) : 0;
        const poolAsk = pooled && poolSideAvailable(pool, 'buy', floor) ? poolCost(pool, 'buy', 1) : 0;
        return { asset, bid: Math.max(poolBid >= floor ? poolBid : 0, Number(bid?.price ?? 0)) / dollarsScale,
          ask: Math.min(poolAsk >= floor ? poolAsk : Number.MAX_SAFE_INTEGER, Number(ask?.price ?? Number.MAX_SAFE_INTEGER)) / dollarsScale,
          last: last ? Number(last.price) / dollarsScale : null };
      }),
      history: fills(this.db.prepare('SELECT id, asset, quantity, dollars, price, time, venue FROM market_fills WHERE asset = ? ORDER BY id DESC LIMIT 120').all(asset)).reverse(),
      trades: fills(this.db.prepare('SELECT * FROM market_fills WHERE buyer = ? OR seller = ? ORDER BY id DESC LIMIT 30').all(owner, owner)),
      orders: this.db.prepare(`SELECT * FROM market_orders
        WHERE owner = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 100`).all(owner)
        .map(row => { const { owner: _owner, ...order } = orderRow(row); return { ...order, price: order.price / dollarsScale }; }),
    };
    return { ...snapshot(account), market };
  }
  halfQuote(owner: string, account: Account, realTime: number): Snapshot & { halfSale: HalfSaleQuote } {
    const sales = marketResources.flatMap(asset => {
      const quantity = Math.floor(account.game.stock[asset] / 2);
      if (!quantity) return [];
      const steps = this.plan(owner, asset, 'sell', quantity, realTime);
      const units = steps.reduce((sum, step) => sum + step.dollars, 0);
      return [{ asset, quantity, dollars: units / dollarsScale,
        available: units > 0 && Number.isSafeInteger(units) && steps.reduce((sum, step) => sum + step.quantity, 0) === quantity }];
    });
    const units = sales.reduce((sum, sale) => sum + dollarsUnits(sale.dollars), 0);
    if (!Number.isSafeInteger(units)) throw new ApiError(409, 'Market pool limit reached.');
    return { ...snapshot(account), halfSale: { sales, dollars: units / dollarsScale,
      available: account.game.stage >= 0 && sales.length > 0 && sales.every(sale => sale.available) } };
  }
  collectionQuote(owner: string, account: Account, resource: MarketResource, realTime: number, requested?: number): Snapshot & { collectionQuote: CollectionQuote } {
    const completed = Math.floor(account.pending[resource] / 60000);
    const quantity = requested ?? completed;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > completed) throw new ApiError(409, 'Resources changed. Refresh the collection quote.');
    const steps = quantity ? this.plan(owner, resource, 'sell', quantity, realTime) : [];
    const total = steps.reduce((sum, step) => sum + step.dollars, 0);
    const fee = account.pickupFees?.[resource] ?? 0;
    if (!Number.isSafeInteger(total)) throw new ApiError(409, 'Market pool limit reached.');
    return { ...snapshot(account), collectionQuote: { resource, quantity, transport: fee / dollarsScale,
      proceeds: total / dollarsScale, net: (total - fee) / dollarsScale,
      available: quantity > 0 && total > fee && steps.reduce((sum, step) => sum + step.quantity, 0) === quantity } };
  }
  collectSell(owner: string, account: Account, command: Extract<Command, { type: 'collect-sell' }>, now: number, realTime: number): string {
    const completed = Math.floor(account.pending[command.resource] / 60000), quantity = command.quantity;
    if (quantity > completed) throw new ApiError(409, 'Resources changed. Refresh the collection quote.');
    const fee = account.pickupFees?.[command.resource] ?? 0;
    if (!Number.isSafeInteger(command.minimumDollars + fee)) throw new ApiError(409, 'Account limit reached.');
    if (!Number.isSafeInteger(account.game.stock[command.resource] + completed)) throw new ApiError(409, 'Account limit reached.');
    account.game.stock[command.resource] += completed;
    this.processOrder(owner, account, { type: 'spot', asset: command.resource, side: 'sell', quantity, limitDollars: command.minimumDollars + fee }, now, realTime);
    account.game.dollars -= fee;
    account.pending[command.resource] -= completed * 60000;
    if (account.pickupFees) account.pickupFees[command.resource] = 0;
    this.check(account);
    return note(account.game, 'Completed resources sold. FTH$ transport deducted from proceeds.');
  }
  action(owner: string, session: Session, value: unknown, now: number, realTime: number): ExchangeResult {
    const body = parseActionEnvelope(value), account = session.account;
    const request = JSON.stringify({ revision: body.revision, command: body.command });
    const receipt = this.db.prepare('SELECT request, result FROM market_receipts WHERE owner = ? AND id = ?').get(owner, body.id);
    if (receipt) {
      if (receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
      const saved = JSON.parse(String(receipt.result)) as ExchangeResult;
      return { ...saved, waterUpkeep: restoreSnapshotUpkeep(saved, account, now) };
    }
    const command = parseMarketCommand(body.command);
    if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    if (realTime - account.lastActionAt < 250) throw new ApiError(429, 'Actions are limited to four per second.');
    if (account.game.stage < 0) throw new ApiError(409, 'Establish a settlement before trading.');
    accrue(account, now);
    if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    let asset: MarketAsset;
    if (command.type === 'cancel') {
      const row = this.db.prepare("SELECT * FROM market_orders WHERE id = ? AND owner = ? AND status = 'open'").get(command.orderId, owner);
      if (!row) throw new ApiError(409, 'Open order not found.');
      const order = orderRow(row);
      asset = order.asset;
      if (order.side === 'buy') account.game.dollars += order.remaining * order.price;
      else this.credit(account, asset, order.remaining);
      this.release(account, asset, order.remaining, order.side);
      this.db.prepare("UPDATE market_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    } else if (command.type === 'sell-half') {
      const expected = marketResources.filter(resource => Math.floor(account.game.stock[resource] / 2) > 0);
      if (command.sales.length !== expected.length || expected.some(resource =>
        command.sales.find(sale => sale.asset === resource)?.quantity !== Math.floor(account.game.stock[resource] / 2)))
        throw new ApiError(409, 'Resources changed. Refresh the half-sale quote.');
      asset = command.sales[0].asset;
      for (const sale of command.sales) this.processOrder(owner, account, { type: 'spot', side: 'sell', ...sale }, now, realTime);
    } else if (command.type === 'fund-pool') {
      asset = command.asset;
      this.fundPool(account, asset, command.quantity, command.dollars);
    } else {
      asset = command.asset;
      this.processOrder(owner, account, command, now, realTime);
    }
    this.check(account);
    account.revision++; account.lastActionAt = realTime;
    const message = note(account.game, command.type === 'cancel' ? 'Market order cancelled. Escrow returned.'
      : command.type === 'fund-pool' ? 'Existing FTH$ and owned assets donated to market liquidity.'
        : command.type === 'sell-half' ? 'Half of your owned resources sold for FTH$.' : 'Market order processed.');
    const result = { ...this.read(owner, account, now, realTime, asset, 1), message };
    this.db.prepare('INSERT INTO market_receipts VALUES (?,?,?,?)').run(owner, body.id, request, JSON.stringify(result));
    return result;
  }
  fundPool(account: Account, asset: MarketAsset, quantity: number, dollars: number): void {
    if (!isLiquidAsset(asset) || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(dollars) || dollars <= 0) throw new ApiError(400, 'Pool funding requires positive owned assets and FTH$.');
    if (account.game.dollars < dollars) throw new ApiError(409, 'Not enough FTH$ to fund this pool.');
    const pool = this.pool(asset);
    if (!Number.isSafeInteger(pool.units + quantity) || !Number.isSafeInteger(pool.dollars + dollars)) throw new ApiError(409, 'Market pool limit reached.');
    const floor = BigInt(dollarsUnits(marketPriceFloor(asset)));
    if (BigInt(dollars) < floor * BigInt(quantity)
      || !isMarketResource(asset) && BigInt(pool.dollars + dollars) < floor * BigInt(pool.units + quantity))
      throw new ApiError(409, 'Pool funding must meet the resource price floor.');
    this.reserve(account, { type: 'spot', asset, side: 'sell', quantity, limitDollars: 0 }, 0);
    this.release(account, asset, quantity, 'sell');
    account.game.dollars -= dollars;
    this.check(account);
    this.db.prepare('UPDATE market_pools SET units=units+?,dollars=dollars+? WHERE asset=?').run(quantity, dollars, asset);
  }
  private processOrder(owner: string, account: Account, command: Extract<MarketCommand, { type: 'spot' | 'limit' }>, now: number, realTime: number): void {
      const asset = command.asset;
      if (command.type === 'limit' && command.price < dollarsUnits(marketPriceFloor(asset))) throw new ApiError(409, 'Price is below the resource price floor.');
      if (command.type === 'limit' && Number(this.db.prepare("SELECT COUNT(*) AS count FROM market_orders WHERE owner = ? AND status = 'open'").get(owner)!.count) >= 50) throw new ApiError(409, 'Cancel an open order before placing more. Maximum 50.');
      const steps = this.plan(owner, asset, command.side, command.quantity, realTime, command.type === 'limit' ? command.price : undefined);
      const filled = steps.reduce((sum, step) => sum + step.quantity, 0), total = steps.reduce((sum, step) => sum + step.dollars, 0);
      if (command.type === 'spot' && filled !== command.quantity)
        throw new ApiError(409, command.side === 'sell'
          ? 'Backing is unavailable for this sale. Settle pending Gold transfers or wait for player-funded liquidity.'
          : 'Not enough assets in the market. Buy less or try again after players sell.');
      if (command.type === 'spot' && (filled !== command.quantity || (command.side === 'buy' ? total > command.limitDollars : total < command.limitDollars))) throw new ApiError(409, 'Quote changed or liquidity is insufficient. Refresh the quote.');
      const reservedDollars = command.side === 'buy' ? command.type === 'limit' ? command.price * command.quantity : total : 0;
      this.reserve(account, command, reservedDollars);
      const makers = new Map<string, { session: Session; metal: number; dollars: number; population: number }>(), pool = this.pool(asset);
      for (const step of steps) {
        if (step.maker) {
          let record = makers.get(step.maker.owner);
          if (!record) {
            const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(step.maker.owner)!;
            const session = JSON.parse(String(row.data)) as Session;
            record = { session, metal: session.account.game.stock.metal, dollars: session.account.game.dollars, population: session.account.game.population }; makers.set(step.maker.owner, record);
            accrue(session.account, now);
          }
          const maker = record.session.account;
          if (step.maker.side === 'buy') this.credit(maker, asset, step.quantity); else maker.game.dollars += step.dollars;
          this.release(maker, asset, step.quantity, step.maker.side);
          this.db.prepare("UPDATE market_orders SET remaining = remaining - ?, status = CASE WHEN remaining = ? THEN 'filled' ELSE 'open' END WHERE id = ?").run(step.quantity, step.quantity, step.maker.id);
          maker.revision++;
          note(maker.game, 'Marketplace trade completed.');
        } else movePool(pool, command.side, step.quantity, step.dollars);
        if (command.side === 'buy') this.credit(account, asset, step.quantity); else account.game.dollars += step.dollars;
        this.release(account, asset, step.quantity, command.side);
        this.db.prepare('INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES (?,?,?,?,?,?,?,?)')
          .run(asset, step.quantity, step.dollars, step.dollars / step.quantity, now, step.maker ? 'players' : 'system',
            command.side === 'buy' ? owner : step.maker?.owner ?? '', command.side === 'sell' ? owner : step.maker?.owner ?? '');
      }
      for (const [id, record] of makers) {
        this.check(record.session.account);
        this.db.prepare('UPDATE public_totals SET metal = metal + ? WHERE id = 1').run(record.session.account.game.stock.metal - record.metal);
        this.db.prepare('UPDATE public_totals SET dollars=dollars+? WHERE id=1').run(record.session.account.game.dollars - record.dollars);
        const populationChange = record.session.account.game.population - record.population;
        if (populationChange) {
          this.db.prepare("UPDATE population_totals SET total=total+? WHERE scope='global'").run(populationChange);
          const federation = record.session.account.game.federation;
          if (federation) this.db.prepare('UPDATE population_totals SET total=total+? WHERE scope=?').run(populationChange, `federation:${federation}`);
        }
        this.db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(record.session), id);
      }
      this.db.prepare('UPDATE market_pools SET units = ?, dollars = ? WHERE asset = ?').run(pool.units, pool.dollars, asset);
      const remaining = command.quantity - filled;
      if (command.side === 'buy') account.game.dollars += reservedDollars - total - (command.type === 'limit' ? remaining * command.price : 0);
      if (command.type === 'limit') this.db.prepare(`INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt)
        VALUES (?,?,?,?,?,?,?,?)`).run(owner, asset, command.side, command.price, command.quantity, remaining, remaining ? 'open' : 'filled', now);
  }
  private credit(account: Account, asset: MarketAsset, quantity: number): void {
    if (isMarketResource(asset)) account.game.stock[asset] += quantity;
    else {
      const bag = inventory(account);
      if (isCollectible(asset) && bag.items.includes(asset)) throw new ApiError(409, 'This item is already owned or reserved.');
      if (isCollectible(asset)) bag.pending = bag.pending.filter(item => item !== asset);
      for (let i = 0; i < quantity; i++) bag.items.push(asset);
    }
  }
  private release(account: Account, asset: MarketAsset, quantity: number, side: MarketSide): void {
    if (!isMarketResource(asset)) {
      const bag = inventory(account);
      this.removeCopies(bag.marketReserved ?? [], asset, quantity);
      if (side === 'sell') this.removeCopies(bag.marketSelling ?? [], asset, quantity);
    }
  }
  private removeCopies(items: import('../src/items.ts').ItemId[], asset: MarketAsset, quantity: number): void {
    for (let i = 0; i < quantity; i++) {
      const index = items.findIndex(item => item === asset);
      if (index < 0) throw new ApiError(409, 'Invalid item reservation.');
      items.splice(index, 1);
    }
  }
  private reserve(account: Account, command: Extract<MarketCommand, { type: 'spot' | 'limit' }>, dollars: number): void {
    const { asset, quantity, side } = command, bag = inventory(account);
    if (side === 'buy' && account.game.dollars < dollars) throw new ApiError(409, 'Not enough FTH$ for this order.');
    if (isMarketResource(asset)) {
      if (side === 'sell' && account.game.stock[asset] < quantity) throw new ApiError(409, 'Not enough owned resources for this order.');
      if (side === 'sell') account.game.stock[asset] -= quantity;
    } else {
      if (isCollectible(asset) && (bag.marketReserved?.includes(asset) || (side === 'buy' && (bag.items.includes(asset) || bag.pending.some(item => item === asset))))) throw new ApiError(409, 'This item is already owned or reserved.');
      if (side === 'buy' && inventoryUsed(bag) + quantity > itemStorage[bag.storage].capacity) throw new ApiError(409, 'Item inventory is full. Upgrade item storage first.');
      if (side === 'sell') {
        if (bag.items.filter(item => item === asset).length < quantity) throw new ApiError(409, 'This item is not in your inventory.');
        if (sellableItemCount(bag, asset) < quantity) throw new ApiError(409, 'Unequip or return this item from the map before selling.');
        this.removeCopies(bag.items, asset, quantity);
        for (let i = 0; i < quantity; i++) (bag.marketSelling ??= []).push(asset);
      }
      for (let i = 0; i < quantity; i++) (bag.marketReserved ??= []).push(asset);
    }
    if (side === 'buy') account.game.dollars -= dollars;
  }
  private check(account: Account): void {
    if (!Number.isSafeInteger(account.game.dollars) || account.game.dollars < 0
      || !Object.values(account.game.stock).every(value => Number.isSafeInteger(value) && value >= 0)
      || inventoryUsed(inventory(account)) > itemStorage[inventory(account).storage].capacity) throw new ApiError(409, 'Account limit reached.');
  }
}
