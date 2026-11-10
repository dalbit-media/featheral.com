import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import type { Session } from './store.ts';
import type { Account } from './economy.ts';
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
  captureRelics(owner: string, captor: Account, discovered: readonly string[], now: number): string[] {
    if (!discovered.length || captor.game.stage < 0 || !captor.game.home) return [];
    const origin = this.location(owner), home = captor.game.home, discoveredTiles = new Set(discovered);
    const messages: string[] = [];
    const relics = this.db.prepare(`SELECT id,data FROM sessions
      WHERE id!=? AND json_extract(data,'$.account.game.stage')>=0
        AND json_extract(data,'$.account.game.population')=0
        AND COALESCE(json_extract(data,'$.account.relicCaptured'),0)=0
      ORDER BY id`).all(owner);
    for (const row of relics) {
      const relicOwner = String(row.id), session = JSON.parse(String(row.data)) as Session;
      const relicLocation = this.location(relicOwner);
      const localX = home.x + relicLocation.x - origin.x, localY = home.y + relicLocation.y - origin.y;
      if (!discoveredTiles.has(`${localX},${localY}`)) continue;
      const source = session.account, sourceGame = source.game, stock = sourceGame.stock;
      const amounts = Object.keys(captor.game.stock) as (keyof typeof captor.game.stock)[];
      if (!amounts.every(resource => Number.isSafeInteger(stock[resource]) && stock[resource] >= 0
        && Number.isSafeInteger(captor.game.stock[resource] + stock[resource]))
        || !Number.isSafeInteger(sourceGame.dollars) || sourceGame.dollars < 0
        || !Number.isSafeInteger(captor.game.dollars + sourceGame.dollars)) {
        throw new Error('Relic capture exceeds the safe balance limit.');
      }
      const stolen = { ...stock }, dollars = sourceGame.dollars;
      for (const resource of amounts) {
        captor.game.stock[resource] += stolen[resource];
        stock[resource] = 0;
      }
      captor.game.dollars += dollars;
      sourceGame.dollars = 0;
      source.relicCaptured = true;
      source.revision++;
      source.updatedAt = now;
      source.receipt = null;
      sourceGame.log = ['An explorer claimed the remaining resources from this relic.', ...sourceGame.log].slice(0, 40);
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), relicOwner);
      this.db.prepare('UPDATE public_totals SET metal=metal-?,dollars=dollars-? WHERE id=1')
        .run(stolen.metal, dollars);
      const summary = [
        ...amounts.map(resource => {
          const value = stolen[resource];
          return value ? `${value.toLocaleString()} ${resource}` : '';
        }).filter(Boolean),
        dollars ? `FTH$ ${(dollars / dollarsScale).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '',
      ].filter(Boolean).join(', ');
      messages.push(summary
        ? `Relic discovered at Atlas coordinates (${relicLocation.x}, ${relicLocation.y}). Captured ${summary}.`
        : `Relic discovered at Atlas coordinates (${relicLocation.x}, ${relicLocation.y}); it held no remaining resources or FTH$.`);
    }
    return messages;
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
    const rows = this.db.prepare(`SELECT s.id,s.data,p.nickname FROM sessions s
      LEFT JOIN chat_profiles p ON p.owner=s.id ORDER BY s.id`).all();
    const accounts = new Map<string, Account>(), locations = new Map<string, Location>();
    for (const row of rows) {
      const id = String(row.id), account = (JSON.parse(String(row.data)) as Session).account;
      accounts.set(id, account);
      if (account.game.stage >= 0) locations.set(id, this.location(id));
    }
    const viewer = accounts.get(owner), viewerLocation = locations.get(owner), exploredAtlas = new Set<string>();
    if (viewer?.game.home && viewerLocation) for (const tile of viewer.game.explored) {
      const match = /^(-?\d+),(-?\d+)$/.exec(tile);
      if (!match) continue;
      exploredAtlas.add(`${viewerLocation.x + Number(match[1]) - viewer.game.home.x},${viewerLocation.y + Number(match[2]) - viewer.game.home.y}`);
    }
    const entries: AtlasEntry[] = [];
    for (const row of rows) {
      const id = String(row.id), account = accounts.get(id)!;
      const game = account.game, relicLocation = locations.get(id) ?? null;
      const isRelic = game.stage >= 0 && game.population === 0;
      const visible = !isRelic || id === owner || Boolean(relicLocation && exploredAtlas.has(`${relicLocation.x},${relicLocation.y}`));
      const publicId = createHash('sha256').update(`atlas:${id}`).digest('hex').slice(0, 20);
      const dollars = isRelic && !visible ? 0 : game.dollars / dollarsScale;
      let netWorth = dollars + (escrow.get(id) ?? 0);
      for (const resource of marketResources) netWorth += game.stock[resource] * marketBasePrice(resource);
      for (const item of inventory(account).items) {
        if (!isMarketAsset(item)) throw new Error('Invalid atlas inventory asset.');
        netWorth += marketBasePrice(item);
      }
      if (!Number.isFinite(netWorth) || netWorth < 0) throw new Error('Invalid atlas net worth.');
      entries.push({ id: publicId, player: row.nickname ? String(row.nickname) : `Builder ${publicId.slice(0, 6).toUpperCase()}`,
        settlement: game.stage >= 0 && visible ? account.customization?.settlementName || `Haven ${publicId.slice(0, 6).toUpperCase()}` : null,
        yours: id === owner, location: game.stage >= 0 && visible ? relicLocation : null, distance: null,
        federation: game.federation, population: game.population, netWorth: isRelic && !visible ? 0 : netWorth, dollars,
        stage: game.stage >= 0 && visible ? game.stage : -1, explored: game.explored.length, contribution: game.contribution,
        relic: isRelic && visible });
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
