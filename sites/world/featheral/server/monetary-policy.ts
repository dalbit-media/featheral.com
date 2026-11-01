import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { monetaryPolicy } from '../src/monetary-policy.ts';
import { collectionPolicy } from '../src/collection.ts';

export function enforceMonetaryPolicy(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS monetary_policy (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, initialSupply INTEGER NOT NULL)');
  const fingerprint = createHash('sha256').update(JSON.stringify(monetaryPolicy)).digest('hex');
  const supply = Number(db.prepare(`SELECT
    (SELECT COALESCE(SUM(json_extract(data,'$.account.game.dollars')),0) FROM sessions)
    +(SELECT COALESCE(SUM(dollars),0) FROM market_pools)
    +(SELECT dollars FROM gold_pool WHERE id=1)
    +(SELECT COALESCE(SUM(price*remaining),0) FROM market_orders WHERE side='buy' AND status='open') AS total`).get()!.total)
    + Number(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bank_treasury'").get()
      ? db.prepare('SELECT available+reserved AS total FROM bank_treasury WHERE id=1').get()!.total : 0);
  if (!Number.isSafeInteger(supply) || supply < 0) throw new Error('Invalid monetary supply.');
  const saved = db.prepare('SELECT fingerprint,initialSupply FROM monetary_policy WHERE id=1').get();
  if (!saved) db.prepare('INSERT INTO monetary_policy VALUES(1,?,?)').run(fingerprint, supply);
  else {
    if (saved.fingerprint !== fingerprint) throw new Error('Permanent monetary policy changed. Startup refused.');
    if (supply > Number(saved.initialSupply)) throw new Error('FTH$ issuance exceeds the permanent supply ceiling.');
  }
  db.exec('CREATE TABLE IF NOT EXISTS collection_policy (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL)');
  const collectionFingerprint = createHash('sha256').update(JSON.stringify(collectionPolicy)).digest('hex');
  const savedCollection = db.prepare('SELECT fingerprint FROM collection_policy WHERE id=1').get();
  if (!savedCollection) db.prepare('INSERT INTO collection_policy VALUES(1,?)').run(collectionFingerprint);
  else if (savedCollection.fingerprint !== collectionFingerprint) throw new Error('Collection policy changed. Startup refused.');
}
