import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from './store.ts';
import { activityItems } from '../src/automation.ts';
import { collectionItems } from '../src/collection.ts';

test('liquidity migration retires collectible pools, funds automation from existing reserves and runs once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-liquidity-')), path = join(directory, 'test.sqlite');
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path, () => 1000000);
    const originalSupply = store.publicTotals().dollars;
    store.close(); store = undefined;
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`DELETE FROM item_liquidity;
        UPDATE market_pools SET dollars=(SELECT SUM(dollars) FROM market_pools WHERE asset LIKE 'collection-%' OR asset LIKE 'activity-%') WHERE asset='relic-forest';
        UPDATE market_pools SET units=0,dollars=0 WHERE asset LIKE 'collection-%';
        DELETE FROM market_pools WHERE asset LIKE 'activity-%'`);
    } finally { legacy.close(); }
    store = new SqliteStore(path, () => 1000000);
    assert.equal(store.publicTotals().dollars, originalSupply);
    store.close(); store = undefined;
    const check = new DatabaseSync(path);
    let pools;
    try {
      for (const asset of [...collectionItems, ...activityItems]) {
        const row = check.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get(asset)!;
        assert.equal(row.units, 1000);
        assert.ok(Number(row.dollars) > 0);
      }
      assert.equal(check.prepare("SELECT SUM(dollars) AS total FROM market_pools WHERE asset LIKE 'relic-%'").get()!.total, 0);
      pools = check.prepare('SELECT * FROM market_pools ORDER BY asset').all();
    } finally { check.close(); }
    store = new SqliteStore(path, () => 1000000);
    assert.equal(store.publicTotals().dollars, originalSupply);
    store.close(); store = undefined;
    const again = new DatabaseSync(path);
    try { assert.deepEqual(again.prepare('SELECT * FROM market_pools ORDER BY asset').all(), pools); }
    finally { again.close(); }
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
