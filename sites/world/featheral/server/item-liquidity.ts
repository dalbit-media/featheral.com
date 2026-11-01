import type { DatabaseSync } from 'node:sqlite';
import { isLiquidAsset, isMarketResource, marketAssets, marketBasePrice } from '../src/market.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import { dollarsScale } from '../src/dollars.ts';

export function migrateItemLiquidity(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS item_liquidity (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
  if (db.prepare('SELECT 1 FROM item_liquidity WHERE id=1').get()) return;
  const before = Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total);
  const rows = marketAssets.map(asset => {
    const row = db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get(asset)!;
    return { asset, units: Number(row.units), dollars: Number(row.dollars) };
  });
  const targets = rows.filter(row => isLiquidAsset(row.asset) && !isMarketResource(row.asset) && (!row.units || !row.dollars));
  const retired = rows.filter(row => !isLiquidAsset(row.asset));
  let budget = [...targets, ...retired].reduce((sum, row) => sum + row.dollars, 0);
  const update = db.prepare('UPDATE market_pools SET units=?,dollars=? WHERE asset=?');
  for (const row of retired) update.run(0, 0, row.asset);
  const weights = targets.map(row => monetaryPolicy.itemInitialUnits * marketBasePrice(row.asset) * dollarsScale);
  const required = weights.reduce((sum, weight) => sum + weight, 0);
  const donors = rows.filter(row => isLiquidAsset(row.asset) && !targets.includes(row) && row.dollars > 1);
  const available = donors.reduce((sum, row) => sum + row.dollars - 1, 0);
  const transfer = Math.min(Math.max(0, required - budget), available);
  let moved = 0;
  for (const row of donors) {
    const share = available ? Number(BigInt(transfer) * BigInt(row.dollars - 1) / BigInt(available)) : 0;
    row.dollars -= share; moved += share;
  }
  for (const row of donors) if (moved < transfer && row.dollars > 1) { row.dollars--; moved++; }
  for (const row of donors) update.run(row.units, row.dollars, row.asset);
  budget += moved;
  let distributed = 0;
  targets.forEach((row, index) => {
    row.units = monetaryPolicy.itemInitialUnits;
    row.dollars = Number(BigInt(budget) * BigInt(weights[index]) / BigInt(required));
    distributed += row.dollars;
  });
  for (const row of targets) if (distributed < budget) { row.dollars++; distributed++; }
  for (const row of targets) update.run(row.units, row.dollars, row.asset);
  if (!targets.length && budget) {
    const wood = rows.find(row => row.asset === 'wood')!;
    update.run(wood.units, wood.dollars + budget, wood.asset);
  }
  const after = Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total);
  if (!Number.isSafeInteger(before) || before !== after) throw new Error('Item liquidity migration changed FTH$ reserves.');
  if (targets.some(row => row.dollars === 0)) console.warn('Item liquidity has insufficient existing FTH$ reserves; unfunded pools show no quote.');
  db.exec('INSERT INTO item_liquidity VALUES(1,1)');
}
