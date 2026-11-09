import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import type { Session } from './store.ts';
import { atlasSize, generatedFederation, identityHash, settlementDistance, startingFederations } from '../src/atlas.ts';
import type { AtlasEntry, AtlasSnapshot, Location } from '../src/atlas.ts';
import { dollarsScale } from '../src/dollars.ts';
import { isMarketAsset, marketBasePrice, marketResources } from '../src/market.ts';
import { inventory } from './inventory.ts';

export class WorldAtlas {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS settlement_locations (
      owner TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL, UNIQUE(x,y))`);
  }
  private location(owner: string): Location {
    const saved = this.db.prepare('SELECT x,y FROM settlement_locations WHERE owner=?').get(owner);
    if (saved) return { x: Number(saved.x), y: Number(saved.y) };
    const start = identityHash(owner) % (atlasSize * atlasSize);
    for (let offset = 0; offset < atlasSize * atlasSize; offset++) {
      const index = (start + offset) % (atlasSize * atlasSize), x = index % atlasSize, y = Math.floor(index / atlasSize);
      if (this.db.prepare('SELECT 1 FROM settlement_locations WHERE x=? AND y=?').get(x, y)) continue;
      this.db.prepare('INSERT INTO settlement_locations VALUES(?,?,?)').run(owner, x, y);
      return { x, y };
    }
    throw new Error('Settlement atlas is full.');
  }
  view(owner: string, now: number): AtlasSnapshot {
    const escrow = new Map<string, number>();
    for (const order of this.db.prepare("SELECT owner,asset,side,price,remaining FROM market_orders WHERE status='open'").all()) {
      const asset = String(order.asset);
      if (!isMarketAsset(asset)) throw new Error('Invalid atlas escrow asset.');
      const value = Number(order.remaining) * (order.side === 'buy' ? Number(order.price) / dollarsScale : marketBasePrice(asset));
      const id = String(order.owner);
      escrow.set(id, (escrow.get(id) ?? 0) + value);
    }
    const entries: AtlasEntry[] = [];
    for (const row of this.db.prepare(`SELECT s.id,s.data,p.nickname FROM sessions s
      LEFT JOIN chat_profiles p ON p.owner=s.id ORDER BY s.id`).all()) {
      const id = String(row.id), account = (JSON.parse(String(row.data)) as Session).account, game = account.game;
      const publicId = createHash('sha256').update(`atlas:${id}`).digest('hex').slice(0, 20);
      const dollars = game.dollars / dollarsScale;
      let netWorth = dollars + (escrow.get(id) ?? 0);
      for (const resource of marketResources) netWorth += game.stock[resource] * marketBasePrice(resource);
      for (const item of inventory(account).items) {
        if (!isMarketAsset(item)) throw new Error('Invalid atlas inventory asset.');
        netWorth += marketBasePrice(item);
      }
      if (!Number.isFinite(netWorth) || netWorth < 0) throw new Error('Invalid atlas net worth.');
      entries.push({ id: publicId, player: row.nickname ? String(row.nickname) : `Builder ${publicId.slice(0, 6).toUpperCase()}`,
        settlement: game.stage >= 0 ? account.customization?.settlementName || `Haven ${publicId.slice(0, 6).toUpperCase()}` : null,
        yours: id === owner, location: game.stage >= 0 ? this.location(id) : null, distance: null,
        federation: game.federation, population: game.population, netWorth, dollars,
        stage: game.stage, explored: game.explored.length, contribution: game.contribution });
    }
    const origin = entries.find(entry => entry.yours)?.location;
    for (const entry of entries) if (origin && entry.location) entry.distance = settlementDistance(origin, entry.location);
    const federations = new Map(startingFederations.map(identity => [identity.name, { ...identity, members: 0, population: 0 }]));
    for (const entry of entries) {
      if (!entry.federation) continue;
      let federation = federations.get(entry.federation);
      if (!federation) {
        federation = { ...generatedFederation(entry.federation), members: 0, population: 0 };
        federations.set(entry.federation, federation);
      }
      federation.members++; federation.population += entry.population;
    }
    return { entries, federations: [...federations.values()], updatedAt: now };
  }
}
