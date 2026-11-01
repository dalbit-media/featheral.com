import { DatabaseSync } from 'node:sqlite';
import { dollarsUnits } from '../src/dollars.ts';
import type { Account } from './economy.ts';
import { worldWeekMs } from '../src/environment.ts';

export function automateFixtureCollections(account: Account): void {
  const expiry = account.updatedAt + 1000000 * worldWeekMs;
  account.automationUntil = { wood: expiry, water: expiry, metal: expiry, oil: expiry };
}

export function fundFixtureFromReserves(path: string, dollars: number): void {
  const db = new DatabaseSync(path);
  try {
    const units = dollarsUnits(dollars);
    const result = db.prepare("UPDATE market_pools SET dollars=dollars-? WHERE asset='oil' AND dollars>?").run(units, units);
    if (result.changes !== 1) throw new Error('Insufficient fixture reserve funding.');
  } finally { db.close(); }
}
