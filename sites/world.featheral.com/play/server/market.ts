import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { accrue, ApiError, apply, parseActionEnvelope, restoreSnapshotUpkeep, snapshot } from './economy.ts';
import type { Account } from './economy.ts';
import { craft, inventory } from './inventory.ts';
import { canAfford, note } from '../src/engine.ts';
import { craftableKeys, craftingCost, craftingFits, craftingInputs, craftingStage, inventoryFits, inventoryUsed, isCollectible, itemStorage, recipeDiscovered, sellableItemCount } from '../src/items.ts';
import { isLiquidAsset, isMarketAsset, isMarketResource, marketAssets, marketPriceFloor, marketQuantityLimit, marketSaleQuantityLimit, marketStartingQuantity, marketResources } from '../src/market.ts';
import type { HalfSaleQuote, MarketAsset, MarketCommand, MarketFill, MarketOrder, MarketResource, MarketSide, MarketSnapshot } from '../src/market.ts';
import type { Snapshot } from '../src/api-types.ts';
import type { Session } from './store.ts';
import { dollarsScale, dollarsUnits } from '../src/dollars.ts';
import { poolPayment, poolPaymentUnits } from '../src/pool-pricing.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import type { CollectionQuote, Command } from '../src/api-types.ts';
import { consumeTransportVoucher, transportQuote } from '../src/transport-items.ts';
import { activeMarketAnalysis, marketAnalysisDuration, marketAnalysisFee } from '../src/market-analysis.ts';
import type { MarketAnalysis } from '../src/market-analysis.ts';
import { affordableBuyingQuantity, buyingBudgetUnits } from '../src/market-buy-quantity.ts';
import type { BuyQuantityBudget, BuyQuantityRequest } from '../src/market-buy-quantity.ts';
import { createHash } from 'node:crypto';
import { autoCraftableOutput, merchantCharter, merchantSpendingLimit } from '../src/auto-crafting.ts';
import type { AutoCraftQuote } from '../src/auto-crafting.ts';
import { bulkCraftingItems, bulkCraftingKeys } from '../src/bulk-crafting.ts';
import { isEquipmentId, validEnhancedEquipment } from '../src/enhancement.ts';
import type { EnhancedEquipment, EnhancementMarketCommand } from '../src/enhancement.ts';

interface Pool { units: number; dollars: number; depthUnits?: bigint; depthDollars?: bigint }
interface Order extends MarketOrder { owner: string }
interface Step { quantity: number; dollars: number; maker: Order | null }
export interface ExchangeResult extends Snapshot { market: MarketSnapshot; message?: string; autoCraft?: AutoCraftQuote }
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
  if (c.type === 'enhancement-list' || c.type === 'enhancement-cancel' || c.type === 'enhancement-buy') {
    const fields = c.type === 'enhancement-list' ? 'equipmentId,price,type'
      : c.type === 'enhancement-buy' ? 'listingId,price,type' : 'listingId,type';
    if (Object.keys(c).sort().join() !== fields
      || (c.type === 'enhancement-list' ? !isEquipmentId(c.equipmentId) : !positive(c.listingId, Number.MAX_SAFE_INTEGER)))
      throw new ApiError(400, 'Invalid enhanced equipment market command.');
    return { ...c, ...(c.type === 'enhancement-cancel' ? {} : { price: paymentUnits(c.price, 10000000000) }) } as EnhancementMarketCommand;
  }
  if (c.type === 'auto-craft') {
    if (Object.keys(c).sort().join() !== 'fingerprint,type' || typeof c.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(c.fingerprint))
      throw new ApiError(400, 'Invalid automatic crafting command.');
    return { type: 'auto-craft', fingerprint: c.fingerprint };
  }
  if (c.type === 'profit-analysis') {
    if (Object.keys(c).join() !== 'type') throw new ApiError(400, 'Invalid profit analysis command.');
    return { type: 'profit-analysis' };
  }
  if (c.type === 'fund-pool') {
    if (Object.keys(c).sort().join() !== 'asset,dollars,quantity,type' || !isMarketAsset(c.asset) || !isLiquidAsset(c.asset)
      || !positive(c.quantity, Math.min(marketQuantityLimit(c.asset), marketStartingQuantity(c.asset)))) throw new ApiError(400, 'Invalid pool funding command.');
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
    ? isMarketAsset(c.asset) && isMarketResource(c.asset) ? Number.MAX_SAFE_INTEGER / dollarsScale : 10000000000 : 1000000);
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
  private clockSpeed: number;
  constructor(db: SqliteDatabase, clockSpeed = 1) {
    this.db = db;
    this.clockSpeed = clockSpeed;
    db.exec(`CREATE TABLE IF NOT EXISTS market_analysis (owner TEXT PRIMARY KEY, generatedAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL, data TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS market_pools (asset TEXT PRIMARY KEY, units INTEGER NOT NULL, dollars INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, asset TEXT NOT NULL,
      side TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL, remaining INTEGER NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS market_book ON market_orders(asset, status, side, price, id);
      CREATE INDEX IF NOT EXISTS market_owner ON market_orders(owner, status, id);
      CREATE INDEX IF NOT EXISTS market_buy_escrow ON market_orders(price,remaining) WHERE side='buy' AND status='open';
      CREATE TABLE IF NOT EXISTS market_fills (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, quantity INTEGER NOT NULL,
      dollars INTEGER NOT NULL, price REAL NOT NULL, time INTEGER NOT NULL, venue TEXT NOT NULL, buyer TEXT NOT NULL, seller TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS market_history ON market_fills(asset, id);
      CREATE INDEX IF NOT EXISTS market_fills_time ON market_fills(asset, time, id);
      CREATE INDEX IF NOT EXISTS market_fills_buyer ON market_fills(buyer, id);
      CREATE INDEX IF NOT EXISTS market_fills_seller ON market_fills(seller, id);
      CREATE TABLE IF NOT EXISTS market_receipts (owner TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS enhancement_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, equipmentId TEXT NOT NULL,
      equipment TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), createdAt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','filled','cancelled')));
      CREATE UNIQUE INDEX IF NOT EXISTS enhancement_escrow_identity ON enhancement_listings(equipmentId) WHERE status='open';
      CREATE INDEX IF NOT EXISTS enhancement_listing_book ON enhancement_listings(status,id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS enhancement_receipts (
      owner TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS enhancement_sales (
      listingId INTEGER PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL, dollars INTEGER NOT NULL, time INTEGER NOT NULL);`);
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
        const middle = low + Math.ceil((high - low) / 2), comparison = compareMarginal(pool, side, middle, boundary);
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
  private priceChange(asset: MarketAsset, now: number, realDays: number, last: number,
    before: ReturnType<SqliteDatabase['prepare']>, after: ReturnType<SqliteDatabase['prepare']>): number | null {
    // Fill times use the accelerated server clock; convert the real-day window into server time.
    const cutoff = now - realDays * 86400000 * this.clockSpeed;
    const reference = before.get(asset, cutoff) ?? after.get(asset, cutoff);
    const base = Number(reference?.price);
    return Number.isFinite(base) && base > 0 ? (last - base) / base * 100 : null;
  }
  read(owner: string, account: Account, now: number, realTime: number, asset: MarketAsset, quantity: number, buying?: BuyQuantityRequest): ExchangeResult {
    let buyBudget: BuyQuantityBudget | undefined;
    if (buying) {
      const budget = buyingBudgetUnits(account.game.dollars, buying.percent), bag = inventory(account);
      const blocked = !isMarketResource(asset) && (!inventoryFits(bag, asset)
        || isCollectible(asset) && (bag.items.includes(asset) || bag.marketReserved?.includes(asset) || bag.pending.some(item => item === asset)));
      const price = buying.price === undefined ? undefined : dollarsUnits(buying.price);
      const maximum = Math.min(marketQuantityLimit(asset), Math.floor(budget / (price ?? dollarsUnits(marketPriceFloor(asset)))),
        isMarketResource(asset) ? Number.MAX_SAFE_INTEGER - account.game.stock[asset] : marketQuantityLimit(asset));
      const selected = affordableBuyingQuantity(blocked ? 0 : maximum, budget, amount => {
        if (price !== undefined) return BigInt(price) * BigInt(amount);
        const steps = this.plan(owner, asset, 'buy', amount, realTime);
        if (steps.reduce((sum, step) => sum + step.quantity, 0) !== amount) return null;
        if (steps.some(step => !Number.isSafeInteger(step.dollars))) return null;
        return steps.reduce((sum, step) => sum + BigInt(step.dollars), 0n);
      });
      buyBudget = { ...buying, dollars: budget / dollarsScale, quantity: selected };
      quantity = Math.max(1, selected);
    }
    const pools = new Map(this.db.prepare('SELECT * FROM market_pools').all().map(row => [String(row.asset), row]));
    const depths = new Map(this.db.prepare('SELECT * FROM market_resource_depth').all().map(row => [String(row.asset), row]));
    const pinDepth = this.db.prepare('INSERT OR IGNORE INTO market_resource_depth VALUES(?,?,?)');
    const floors = marketAssets.map(asset => `('${asset}',${dollarsUnits(marketPriceFloor(asset))})`).join(',');
    const offers = new Map(this.db.prepare(`WITH floors(asset,floor) AS (VALUES ${floors})
      SELECT o.asset,MAX(CASE WHEN side='buy' THEN price END) AS bid,MIN(CASE WHEN side='sell' THEN price END) AS ask,
        SUM(CASE WHEN side='sell' AND owner!=? THEN remaining ELSE 0 END) AS quantity
      FROM market_orders o JOIN sessions s ON s.id=o.owner JOIN floors f ON f.asset=o.asset
      WHERE status='open' AND s.expires>? AND price>=f.floor GROUP BY o.asset`)
      .all(owner, realTime).map(row => [String(row.asset), row]));
    const latest = new Map(this.db.prepare(`SELECT p.asset,f.price FROM market_pools p LEFT JOIN market_fills f ON
      f.id=(SELECT id FROM market_fills WHERE asset=p.asset ORDER BY id DESC LIMIT 1)`).all().map(row => [String(row.asset), row.price]));
    const before = this.db.prepare('SELECT price FROM market_fills WHERE asset = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1');
    const after = this.db.prepare('SELECT price FROM market_fills WHERE asset = ? AND time > ? ORDER BY time ASC, id ASC LIMIT 1');
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
      enhancedListings: this.db.prepare("SELECT * FROM enhancement_listings WHERE status='open' ORDER BY (owner=?) DESC,id DESC LIMIT 200").all(owner)
        .map(row => ({ id: Number(row.id), equipment: JSON.parse(String(row.equipment)) as EnhancedEquipment,
          price: Number(row.price) / dollarsScale, createdAt: Number(row.createdAt), yours: row.owner === owner })),
      ...(buyBudget ? { buyBudget } : {}),
      asset, quantity, bids: level('buy'), asks: level('sell'), quotes: { buy: quote('buy'), sell: quote('sell') },
      analysis: this.analysis(owner, now),
      tickers: marketAssets.map(asset => {
        const row = pools.get(asset)!;
        const pool: Pool = { units: Number(row.units), dollars: Number(row.dollars) };
        const depth = depths.get(asset);
        if (depth) { pool.depthUnits = BigInt(String(depth.units)); pool.depthDollars = BigInt(String(depth.dollars)); }
        else if (isLiquidAsset(asset) && pool.units > 0 && pool.dollars > 0) {
          pool.depthUnits = BigInt(pool.units) * 9n; pool.depthDollars = BigInt(pool.dollars) * 9n;
          pinDepth.run(asset, pool.depthUnits.toString(), pool.depthDollars.toString());
        }
        const last = latest.get(asset), offer = offers.get(asset);
        const pooled = isLiquidAsset(asset) && pool.dollars > 0;
        const floor = dollarsUnits(marketPriceFloor(asset));
        const poolBid = pooled && poolSideAvailable(pool, 'sell', floor) ? poolCost(pool, 'sell', 1) : 0;
        const poolAsk = pooled && poolSideAvailable(pool, 'buy', floor) ? poolCost(pool, 'buy', 1) : 0;
        const availableQuantity = Number(offer?.quantity ?? 0) + (poolAsk >= floor ? Math.max(0, pool.units - (pool.depthUnits ? 0 : 1)) : 0);
        if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0) throw new ApiError(409, 'Market quantity exceeds safe limits.');
        return { asset, bid: Math.max(poolBid >= floor ? poolBid : 0, Number(offer?.bid ?? 0)) / dollarsScale,
          ask: Math.min(poolAsk >= floor ? poolAsk : Number.MAX_SAFE_INTEGER, Number(offer?.ask ?? Number.MAX_SAFE_INTEGER)) / dollarsScale,
          availableQuantity, last: last == null ? null : Number(last) / dollarsScale,
          change24h: last == null ? null : this.priceChange(asset, now, 1, Number(last), before, after),
          change7d: last == null ? null : this.priceChange(asset, now, 7, Number(last), before, after) };
      }),
      history: fills(this.db.prepare('SELECT id, asset, quantity, dollars, price, time, venue FROM market_fills WHERE asset = ? ORDER BY id DESC LIMIT 120').all(asset)).reverse(),
      trades: fills(this.db.prepare('SELECT * FROM market_fills WHERE buyer = ? OR seller = ? ORDER BY id DESC LIMIT 30').all(owner, owner)),
      orders: this.db.prepare(`SELECT * FROM market_orders
        WHERE owner = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 100`).all(owner)
        .map(row => { const { owner: _owner, ...order } = orderRow(row); return { ...order, price: order.price / dollarsScale }; }),
    };
    return { ...snapshot(account), market };
  }
  private analysis(owner: string, now: number): MarketAnalysis | null {
    const row = this.db.prepare('SELECT data FROM market_analysis WHERE owner=? AND generatedAt<=? AND expiresAt>?').get(owner, now, now);
    return row ? activeMarketAnalysis(JSON.parse(String(row.data)) as MarketAnalysis, now) : null;
  }
  private generateAnalysis(owner: string, now: number, realTime: number): MarketAnalysis {
    const quote = (asset: MarketAsset, side: MarketSide, quantity: number): number | null => {
      const steps = this.plan(owner, asset, side, quantity, realTime);
      const units = steps.reduce((sum, step) => sum + step.dollars, 0);
      return steps.reduce((sum, step) => sum + step.quantity, 0) === quantity && units > 0 && Number.isSafeInteger(units) ? units : null;
    };
    const report: MarketAnalysis = { generatedAt: now, expiresAt: now + marketAnalysisDuration, fee: marketAnalysisFee,
      items: craftableKeys.map(item => {
        const recipe = craftingCost(item), craftingFee = dollarsUnits(recipe.dollars ?? 0);
        const inputs = new Map<MarketAsset, number>();
        for (const [asset, quantity] of [...Object.entries(recipe).filter(([asset]) => asset !== 'dollars'), ...Object.entries(craftingInputs(item))]) {
          if (!isMarketAsset(asset)) throw new ApiError(409, 'Crafting ingredient has no market.');
          if (quantity && quantity > 0) inputs.set(asset, (inputs.get(asset) ?? 0) + quantity);
        }
        const ingredients = [...inputs].map(([asset, quantity]) => ({ asset, quantity, units: quote(asset, 'buy', quantity) }));
        const total = craftingFee + ingredients.reduce((sum, input) => sum + (input.units ?? 0), 0);
        const cost = ingredients.every(input => input.units !== null) && Number.isSafeInteger(total) ? total : null;
        const revenue = quote(item, 'sell', 1);
        return { item, craftingFee: craftingFee / dollarsScale,
          ingredients: ingredients.map(({ asset, quantity, units }) => ({ asset, quantity, dollars: units === null ? null : units / dollarsScale })),
          cost: cost === null ? null : cost / dollarsScale, revenue: revenue === null ? null : revenue / dollarsScale,
          profit: cost === null || revenue === null ? null : (revenue - cost) / dollarsScale };
      }) };
    if (!Number.isSafeInteger(report.expiresAt)) throw new ApiError(409, 'Server clock out of range.');
    return report;
  }
  private purchaseAnalysis(owner: string, account: Account, now: number, realTime: number): void {
    const fee = dollarsUnits(marketAnalysisFee);
    if (account.game.dollars < fee) throw new ApiError(409, 'Not enough FTH$ for profit analysis.');
    const report = this.generateAnalysis(owner, now, realTime);
    if (!report.items.some(item => item.profit !== null)) throw new ApiError(409, 'Profit analysis is unavailable because ingredient or sale liquidity is missing. No fee was charged.');
    this.db.prepare(`INSERT INTO market_analysis VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET
      generatedAt=excluded.generatedAt,expiresAt=excluded.expiresAt,data=excluded.data`).run(owner, report.generatedAt, report.expiresAt, JSON.stringify(report));
    account.game.dollars -= fee;
  }
  autoCraftQuote(owner: string, account: Account, now: number, realTime: number): Snapshot & { autoCraft: AutoCraftQuote } {
    this.db.exec('SAVEPOINT auto_craft_preview');
    try {
      const copy = structuredClone(account);
      const state = snapshot(copy);
      return { ...state, autoCraft: this.planAutoCraft(owner, copy, now, realTime) };
    } finally {
      this.db.exec('ROLLBACK TO auto_craft_preview; RELEASE auto_craft_preview');
    }
  }
  private planAutoCraft(owner: string, account: Account, now: number, realTime: number): AutoCraftQuote {
    const bag = inventory(account);
    if (account.game.stage < 0) throw new ApiError(409, 'Establish a settlement before crafting.');
    if (sellableItemCount(bag, merchantCharter) < 1) throw new ApiError(409, 'An unused Master Merchant Charter is required.');
    const permits = new Map(bulkCraftingKeys.map(permit => [permit, sellableItemCount(bag, permit)]));
    const startingBalance = account.game.dollars;
    const spendingCeiling = Math.min(startingBalance, dollarsUnits(merchantSpendingLimit));
    const totalPermits = [...permits.values()].reduce((sum, count) => sum + count, 0);
    if (!totalPermits) throw new ApiError(409, 'Own unused bulk crafting permits before using the charter.');
    const ranked = this.generateAnalysis(owner, now, realTime).items
      .filter(row => autoCraftableOutput(row.item) && row.profit !== null && row.profit > 0)
      .sort((a, b) => b.profit! - a.profit! || a.item.localeCompare(b.item));
    bag.items.splice(bag.items.indexOf(merchantCharter), 1);
    const costs = new Map<MarketAsset | 'dollars', number>([[merchantCharter, 1]]);
    const batches: AutoCraftQuote['batches'] = [];
    let fees = 0, proceeds = 0, valuedCost = 0;
    const fullQuote = (asset: MarketAsset, side: MarketSide, quantity: number): number | null => {
      const steps = this.plan(owner, asset, side, quantity, realTime);
      const dollars = steps.reduce((sum, step) => sum + step.dollars, 0);
      return Number.isSafeInteger(dollars) && dollars > 0 && steps.reduce((sum, step) => sum + step.quantity, 0) === quantity ? dollars : null;
    };
    // Only permits owned at confirmation are eligible; crafted permits cannot extend the run.
    const order = [...bulkCraftingKeys].sort((a, b) => bulkCraftingItems[b].quantity - bulkCraftingItems[a].quantity);
    let progress = true;
    while (progress && fees < spendingCeiling) {
      progress = false;
      for (const row of ranked) {
        const item = row.item;
        if (account.game.stage < craftingStage(item) || !recipeDiscovered(account.game, item)) continue;
        for (const permit of order) {
          if (!permits.get(permit) || sellableItemCount(bag, permit) < 1) continue;
          const quantity = bulkCraftingItems[permit].quantity, cost = craftingCost(item, quantity), inputs = craftingInputs(item, quantity);
          if (dollarsUnits(cost.dollars ?? 0) > spendingCeiling - fees || !canAfford(account.game, cost) || !craftingFits(bag, item, quantity)
            || !Object.entries(inputs).every(([asset, count]) => isMarketAsset(asset) && !isMarketResource(asset) && sellableItemCount(bag, asset) >= count)) continue;
          const fee = dollarsUnits(cost.dollars ?? 0), revenue = fullQuote(item, 'sell', quantity);
          if (revenue === null) continue;
          const materialCosts = [...Object.entries(cost).filter(([asset]) => asset !== 'dollars'), ...Object.entries(inputs)]
            .map(([asset, count]) => isMarketAsset(asset) ? fullQuote(asset, 'buy', count) : null);
          if (materialCosts.some(cost => cost === null)) continue;
          const estimatedCost = fee + materialCosts.reduce<number>((sum, cost) => sum + cost!, 0);
          if (!Number.isSafeInteger(estimatedCost) || revenue <= estimatedCost) continue;
          this.craftAndSell(owner, account, item, quantity, revenue, now, realTime);
          permits.set(permit, permits.get(permit)! - 1);
          fees += fee; proceeds += revenue; valuedCost += estimatedCost;
          if (![fees, proceeds, valuedCost].every(Number.isSafeInteger)) throw new ApiError(409, 'Account limit reached.');
          for (const [asset, count] of [...Object.entries(cost), ...Object.entries(inputs)]) {
            if (asset !== 'dollars' && !isMarketAsset(asset)) throw new ApiError(409, 'Crafting ingredient has no market.');
            if (asset === 'dollars' || isMarketAsset(asset)) costs.set(asset, (costs.get(asset) ?? 0) + count);
          }
          batches.push({ item, permit, quantity, fee: fee / dollarsScale, proceeds: revenue / dollarsScale, valuedCost: estimatedCost / dollarsScale });
          progress = true;
          break;
        }
        if (progress) break;
      }
    }
    if (!batches.length) throw new ApiError(409, 'No profitable batch fits your permits, balance, supplies and sale liquidity. Nothing was consumed.');
    const result = { batches, costs: [...costs].map(([asset, amount]) => ({ asset, amount })), startingBalance: startingBalance / dollarsScale, spendingCeiling: spendingCeiling / dollarsScale,
      craftingFees: fees / dollarsScale, proceeds: proceeds / dollarsScale, cashChange: (proceeds - fees) / dollarsScale,
      estimatedProfit: (proceeds - valuedCost) / dollarsScale, remainingPermits: [...permits.values()].reduce((sum, count) => sum + count, 0),
      consumedPermits: batches.length };
    const fingerprint = createHash('sha256').update(JSON.stringify({ revision: account.revision, ...result })).digest('hex');
    return { fingerprint, ...result };
  }
  private craftAndSell(owner: string, account: Account, item: import('../src/items.ts').CraftableItem, quantity: number, proceeds: number, now: number, realTime: number): void {
    const equipped = inventory(account).equipped;
    craft(account, item, quantity);
    // Ordinary crafting equips better lamps; immediate resale must preserve the player's equipment.
    inventory(account).equipped = equipped;
    inventory(account);
    this.processOrder(owner, account, { type: 'spot', asset: item, side: 'sell', quantity, limitDollars: proceeds }, now, realTime);
    this.check(account);
  }
  private executeAutoCraft(owner: string, account: Account, fingerprint: string, now: number, realTime: number): AutoCraftQuote {
    const quote = this.autoCraftQuote(owner, account, now, realTime).autoCraft;
    if (quote.fingerprint !== fingerprint) throw new ApiError(409, 'Automatic crafting quote changed. Review the totals again.');
    const bag = inventory(account);
    bag.items.splice(bag.items.indexOf(merchantCharter), 1);
    for (const batch of quote.batches) this.craftAndSell(owner, account, batch.item, batch.quantity, dollarsUnits(batch.proceeds), now, realTime);
    return quote;
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
    const transport = transportQuote(account.pickupFees?.[resource] ?? 0, inventory(account)), fee = transport.fee;
    if (!Number.isSafeInteger(total)) throw new ApiError(409, 'Market pool limit reached.');
    return { ...snapshot(account), collectionQuote: { resource, quantity, transport: fee / dollarsScale,
      proceeds: total / dollarsScale, net: (total - fee) / dollarsScale,
      sellAvailable: quantity > 0 && total > 0 && steps.reduce((sum, step) => sum + step.quantity, 0) === quantity,
      ...(transport.item ? { voucher: transport.item, discount: transport.discount } : {}),
      available: quantity > 0 && total > fee && steps.reduce((sum, step) => sum + step.quantity, 0) === quantity } };
  }
  collectSell(owner: string, account: Account, command: Extract<Command, { type: 'collect-sell' }>, now: number, realTime: number): string {
    const completed = Math.floor(account.pending[command.resource] / 60000), quantity = command.quantity;
    if (quantity > completed) throw new ApiError(409, 'Resources changed. Refresh the collection quote.');
    const bag = inventory(account), transport = transportQuote(account.pickupFees?.[command.resource] ?? 0, bag), fee = transport.fee;
    if (!Number.isSafeInteger(command.minimumDollars + fee)) throw new ApiError(409, 'Account limit reached.');
    if (!Number.isSafeInteger(account.game.stock[command.resource] + completed)) throw new ApiError(409, 'Account limit reached.');
    account.game.stock[command.resource] += completed;
    this.processOrder(owner, account, { type: 'spot', asset: command.resource, side: 'sell', quantity, limitDollars: command.minimumDollars + fee }, now, realTime);
    account.game.dollars -= fee;
    consumeTransportVoucher(bag, transport.item);
    account.pending[command.resource] -= completed * 60000;
    if (account.pickupFees) account.pickupFees[command.resource] = 0;
    this.check(account);
    return note(account.game, 'Completed resources sold. FTH$ transport deducted from proceeds.');
  }
  enhancementAction(owner: string, account: Account, value: unknown, now: number, realTime: number): Snapshot & { message: string } {
    const body = parseActionEnvelope(value);
    const request = JSON.stringify({ revision: body.revision, command: body.command });
    const receipt = this.db.prepare('SELECT request,result FROM enhancement_receipts WHERE owner=? AND id=?').get(owner, body.id);
    if (receipt) {
      if (receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
      return JSON.parse(String(receipt.result)) as Snapshot & { message: string };
    }
    const command = object(body.command);
    if (command.type !== 'refine-equipment' && command.type !== 'enhanced-gear') throw new ApiError(400, 'Invalid enhancement command.');
    const result = apply(account, value, now, realTime);
    this.db.prepare('INSERT INTO enhancement_receipts VALUES(?,?,?,?)').run(owner, body.id, request, JSON.stringify(result));
    return result;
  }
  action(owner: string, session: Session, value: unknown, now: number, realTime: number): ExchangeResult {
    const body = parseActionEnvelope(value), account = session.account;
    const request = JSON.stringify({ revision: body.revision, command: body.command });
    const receipt = this.db.prepare('SELECT request, result FROM market_receipts WHERE owner = ? AND id = ?').get(owner, body.id);
    if (receipt) {
      if (receipt.request !== request) throw new ApiError(409, 'Idempotency key already used for a different request.');
      const saved = JSON.parse(String(receipt.result)) as ExchangeResult;
      return { ...saved, market: { ...saved.market, analysis: activeMarketAnalysis(saved.market.analysis, now) },
        waterUpkeep: restoreSnapshotUpkeep(saved, account, now) };
    }
    const command = parseMarketCommand(body.command);
    if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    if (realTime - account.lastActionAt < 250) throw new ApiError(429, 'Actions are limited to four per second.');
    if (account.game.stage < 0) throw new ApiError(409, 'Establish a settlement before trading.');
    accrue(account, now);
    if (body.revision !== account.revision) throw new ApiError(409, 'World changed. Refresh and retry.');
    let asset: MarketAsset;
    let autoCraft: AutoCraftQuote | undefined;
    if (command.type === 'enhancement-list' || command.type === 'enhancement-cancel' || command.type === 'enhancement-buy') {
      asset = this.equipmentTrade(owner, account, command, now);
    } else if (command.type === 'auto-craft') {
      asset = merchantCharter;
      autoCraft = this.executeAutoCraft(owner, account, command.fingerprint, now, realTime);
    } else if (command.type === 'profit-analysis') {
      asset = 'wood';
      this.purchaseAnalysis(owner, account, now, realTime);
    } else if (command.type === 'cancel') {
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
    const message = note(account.game, command.type === 'enhancement-list' ? 'Enhanced equipment listed at a fixed player price.'
      : command.type === 'enhancement-cancel' ? 'Enhanced equipment listing cancelled. Your equipment was returned.'
      : command.type === 'enhancement-buy' ? 'Enhanced equipment purchased from another player.'
      : command.type === 'auto-craft' ? 'Automatic crafting and immediate sales completed.'
      : command.type === 'profit-analysis' ? 'Latest profit analysis purchased. Access expires after one game day.'
      : command.type === 'cancel' ? 'Market order cancelled. Escrow returned.'
      : command.type === 'fund-pool' ? 'Existing FTH$ and owned assets donated to market liquidity.'
        : command.type === 'sell-half' ? 'Half of your owned resources sold for FTH$.' : 'Market order processed.');
    const result = { ...this.read(owner, account, now, realTime, asset, 1), message, ...(autoCraft ? { autoCraft } : {}) };
    this.db.prepare('INSERT INTO market_receipts VALUES (?,?,?,?)').run(owner, body.id, request, JSON.stringify(result));
    return result;
  }
  private equipmentTrade(owner: string, account: Account, command: EnhancementMarketCommand, now: number): MarketAsset {
    const bag = inventory(account), copies = bag.enhancedEquipment ??= [];
    if (command.type === 'enhancement-list') {
      const copy = copies.find(copy => copy.id === command.equipmentId);
      if (!copy) throw new ApiError(409, 'Enhanced equipment is not owned or is already listed.');
      if (Object.values(bag.enhancedEquipped ?? {}).includes(copy.id)) throw new ApiError(409, 'Unequip enhanced equipment before listing it.');
      if (Number(this.db.prepare("SELECT COUNT(*) AS count FROM enhancement_listings WHERE owner=? AND status='open'").get(owner)!.count) >= 50)
        throw new ApiError(409, 'Cancel an enhanced equipment listing before placing more. Maximum 50.');
      this.db.prepare("INSERT INTO enhancement_listings(owner,equipmentId,equipment,price,createdAt,status) VALUES(?,?,?,?,?,'open')")
        .run(owner, copy.id, JSON.stringify(copy), command.price, now);
      copies.splice(copies.indexOf(copy), 1);
      inventory(account);
      return copy.item;
    }
    const row = this.db.prepare("SELECT * FROM enhancement_listings WHERE id=? AND status='open'").get(command.listingId);
    if (!row) throw new ApiError(409, 'Open enhanced equipment listing not found.');
    const copy = JSON.parse(String(row.equipment)) as EnhancedEquipment;
    if (!validEnhancedEquipment(copy) || copy.id !== row.equipmentId) throw new ApiError(409, 'Invalid equipment listing.');
    if (copies.some(owned => owned.id === copy.id)) throw new ApiError(409, 'Equipment identity is already owned.');
    if (command.type === 'enhancement-cancel') {
      if (row.owner !== owner) throw new ApiError(409, 'Only the seller may cancel this listing.');
    } else {
      if (row.owner === owner) throw new ApiError(409, 'You cannot buy your own equipment.');
      const price = Number(row.price);
      if (command.price !== price) throw new ApiError(409, 'Equipment price changed. Refresh and confirm again.');
      if (account.game.dollars < price) throw new ApiError(409, 'Not enough FTH$ to buy this equipment.');
      const sellerRow = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(row.owner!);
      if (!sellerRow) throw new ApiError(409, 'Equipment seller is unavailable.');
      const seller = JSON.parse(String(sellerRow.data)) as Session;
      if (!Number.isSafeInteger(seller.account.game.dollars + price)) throw new ApiError(409, 'Seller account limit reached.');
      seller.account.game.dollars += price;
      seller.account.revision++;
      note(seller.account.game, 'Enhanced equipment sold to another player.');
      this.check(seller.account);
      this.db.prepare('UPDATE public_totals SET dollars=dollars+? WHERE id=1').run(price);
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(seller), row.owner!);
      account.game.dollars -= price;
      this.db.prepare('INSERT INTO enhancement_sales VALUES(?,?,?,?,?)').run(command.listingId, owner, row.owner!, price, now);
    }
    copies.push(copy);
    this.db.prepare('UPDATE enhancement_listings SET status=? WHERE id=? AND status=\'open\'')
      .run(command.type === 'enhancement-cancel' ? 'cancelled' : 'filled', command.listingId);
    inventory(account);
    return copy.item;
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
    if (!Number.isSafeInteger(dollars) || dollars < 0) throw new ApiError(409, 'Account limit reached.');
    if (side === 'buy' && account.game.dollars < dollars) throw new ApiError(409, 'Not enough FTH$ for this order.');
    if (isMarketResource(asset)) {
      if (side === 'sell' && account.game.stock[asset] < quantity) throw new ApiError(409, 'Not enough owned resources for this order.');
      if (side === 'sell') account.game.stock[asset] -= quantity;
    } else {
      if (isCollectible(asset) && (bag.marketReserved?.includes(asset) || (side === 'buy' && (bag.items.includes(asset) || bag.pending.some(item => item === asset))))) throw new ApiError(409, 'This item is already owned or reserved.');
      if (side === 'buy' && !inventoryFits(bag, asset)) throw new ApiError(409, 'Item inventory is full. Upgrade item storage first.');
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
