import sqlite from '../../../../services/database/sqlite.js';
import { dollarsUnits } from '../src/dollars.ts';
import type { Account } from './economy.ts';
import { worldWeekMs } from '../src/environment.ts';
import { isLiquidAsset, isMarketResource, marketAssets, marketBasePrice } from '../src/market.ts';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import { inventory } from './inventory.ts';
import type { SqliteStore } from './store.ts';

export function seedFixturePools(store: SqliteStore): void {
  const treasury = store.create();
  store.transaction(treasury.token, (session, _time, _realTime, exchange) => {
    for (const asset of marketAssets.filter(isLiquidAsset)) {
      const quantity = isMarketResource(asset) ? monetaryPolicy.rawInitialUnits : monetaryPolicy.itemInitialUnits;
      const dollars = dollarsUnits(quantity * marketBasePrice(asset));
      session.account.game.dollars = dollars;
      if (isMarketResource(asset)) session.account.game.stock[asset] = quantity;
      else inventory(session.account).items.push(...Array.from({ length: quantity }, () => asset));
      exchange.fundPool(session.account, asset, quantity, dollars);
    }
  });
}

export function automateFixtureCollections(account: Account): void {
  const expiry = account.updatedAt + 1000000 * worldWeekMs;
  account.automationUntil = { wood: expiry, water: expiry, metal: expiry, oil: expiry };
}

export function fundFixtureFromReserves(path: string, dollars: number): void {
  const db = sqlite.open(path);
  try {
    if (Number(db.prepare('SELECT SUM(dollars) AS dollars FROM market_pools').get()!.dollars) === 0) {
      for (const asset of marketAssets.filter(isLiquidAsset)) {
        const quantity = isMarketResource(asset) ? monetaryPolicy.rawInitialUnits : monetaryPolicy.itemInitialUnits;
        db.prepare('UPDATE market_pools SET units=?,dollars=? WHERE asset=?').run(quantity, dollarsUnits(quantity * marketBasePrice(asset)), asset);
      }
    }
    const units = dollarsUnits(dollars);
    const result = db.prepare("UPDATE market_pools SET dollars=dollars-? WHERE asset='oil' AND dollars>?").run(units, units);
    if (result.changes !== 1) throw new Error('Insufficient fixture reserve funding.');
  } finally { db.close(); }
}
