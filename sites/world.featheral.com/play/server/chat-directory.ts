import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { radius } from '../src/engine.ts';
import type { Game } from '../src/engine.ts';
import type { ChatDirectory, ChatRoom, ChatSettlement } from '../src/chat.ts';
import { ApiError } from './economy.ts';

export class ChatDirectoryStore {
  private readonly db: SqliteDatabase;
  private profileFilter = '';
  useWorldProfiles(): void { this.profileFilter = ' AND p.worldAddress IS NOT NULL'; }
  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS chat_rooms (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, UNIQUE(kind,target));
      CREATE TABLE IF NOT EXISTS chat_visitors (
      owner TEXT NOT NULL, settlement TEXT NOT NULL, PRIMARY KEY(owner,settlement));`);
  }
  private room(kind: ChatRoom['kind'], target: string, name: string, settlement?: string): ChatRoom {
    this.db.prepare('INSERT OR IGNORE INTO chat_rooms (id,kind,target) VALUES (?,?,?)').run(randomUUID(), kind, target);
    const row = this.db.prepare('SELECT id FROM chat_rooms WHERE kind=? AND target=?').get(kind, target)!;
    return { id: String(row.id), kind, name, ...(settlement ? { settlement } : {}) };
  }
  directory(owner: string, now: number): ChatDirectory {
    const current = this.db.prepare('SELECT data FROM sessions WHERE id=? AND expires>?').get(owner, now);
    if (!current) throw new ApiError(401, 'Session expired.');
    const game = (JSON.parse(String(current.data)) as { account: { game: Game } }).account.game;
    const settlements: ChatSettlement[] = [], rooms: ChatRoom[] = [], federations = new Set<string>();
    let ownSettlement: string | null = null;
    const reach = radius(game);
    for (const row of this.db.prepare(`SELECT s.id, json_extract(s.data,'$.account.game.home.x') AS x,
      json_extract(s.data,'$.account.game.home.y') AS y, json_extract(s.data,'$.account.game.population') AS population,
      json_extract(s.data,'$.account.game.federation') AS federation, p.nickname FROM sessions s
      LEFT JOIN chat_profiles p ON p.owner=s.id${this.profileFilter} WHERE s.expires>? AND json_extract(s.data,'$.account.game.stage')>=0
      AND (s.id=? OR (json_extract(s.data,'$.account.game.home.x') BETWEEN ? AND ?
        AND json_extract(s.data,'$.account.game.home.y') BETWEEN ? AND ?)) ORDER BY s.id`)
      .all(now, owner, game.position.x - reach, game.position.x + reach, game.position.y - reach, game.position.y + reach)) {
      const own = row.id === owner;
      if (!own && Math.hypot(Number(row.x) - game.position.x, Number(row.y) - game.position.y) > radius(game)) continue;
      const name = row.nickname == null ? 'Unnamed settlement' : String(row.nickname);
      const publicRoom = this.room('explore', String(row.id), name);
      const privateRoom = this.room('settlement', String(row.id), name);
      publicRoom.settlement = privateRoom.id;
      settlements.push({ id: privateRoom.id, name, x: Number(row.x), y: Number(row.y), population: Number(row.population),
        federation: row.federation == null ? null : String(row.federation), own });
      if (own) ownSettlement = privateRoom.id;
      // Own public channel remains available even while exploring away from home.
      rooms.push(publicRoom);
      if (row.federation != null) federations.add(String(row.federation));
    }
    for (const federation of federations) rooms.push(this.room('federation', federation, federation));
    return { rooms, settlements, ownSettlement };
  }
  authorize(owner: string, roomId: string | null, now: number): ChatRoom {
    if (!roomId) {
      const directory = this.directory(owner, now);
      const room = directory.rooms.find(room => room.kind === 'explore' && room.settlement === directory.ownSettlement) ?? directory.rooms[0];
      if (!room) throw new ApiError(409, 'No nearby public chat. Establish a settlement to open your channel.');
      return room;
    }
    const viewer = this.db.prepare('SELECT data FROM sessions WHERE id=? AND expires>?').get(owner, now);
    if (!viewer) throw new ApiError(401, 'Session expired.');
    const game = (JSON.parse(String(viewer.data)) as { account: { game: Game } }).account.game;
    const room = this.db.prepare('SELECT kind,target FROM chat_rooms WHERE id=?').get(roomId);
    if (!room) throw new ApiError(403, 'This chat is not available here.');
    if (room.kind === 'federation') {
      const nearby = this.db.prepare(`SELECT id, json_extract(data,'$.account.game.home.x') AS x,
        json_extract(data,'$.account.game.home.y') AS y FROM sessions
        WHERE expires>? AND json_extract(data,'$.account.game.stage')>=0
        AND json_extract(data,'$.account.game.federation')=?`).all(now, room.target!);
      if (!nearby.some(value => value.id === owner || Math.hypot(Number(value.x) - game.position.x, Number(value.y) - game.position.y) <= radius(game)))
        throw new ApiError(403, 'This chat is not available here.');
      return { id: roomId, kind: 'federation', name: String(room.target) };
    }
    const row = this.db.prepare(`SELECT r.target, p.nickname FROM chat_rooms r
      JOIN sessions s ON s.id=r.target AND s.expires>? AND json_extract(s.data,'$.account.game.stage')>=0
      LEFT JOIN chat_profiles p ON p.owner=r.target${this.profileFilter} WHERE r.id=?`).get(now, roomId);
    if (!row) throw new ApiError(403, 'This chat is not available here.');
    const name = row.nickname == null ? 'Unnamed settlement' : String(row.nickname);
    if (room.kind === 'explore') {
      const target = this.db.prepare(`SELECT json_extract(data,'$.account.game.home.x') AS x,
        json_extract(data,'$.account.game.home.y') AS y FROM sessions WHERE id=?`).get(room.target!)!;
      if (room.target !== owner && Math.hypot(Number(target.x) - game.position.x, Number(target.y) - game.position.y) > radius(game))
        throw new ApiError(403, 'This chat is not available here.');
      const settlement = this.db.prepare("SELECT id FROM chat_rooms WHERE kind='settlement' AND target=?").get(room.target!)!;
      return { id: roomId, kind: 'explore', name, settlement: String(settlement.id) };
    }
    if (row.target !== owner && !this.db.prepare('SELECT 1 FROM chat_visitors WHERE owner=? AND settlement=?').get(owner, roomId))
      throw new ApiError(403, 'This chat is not available here.');
    return { id: roomId, kind: 'settlement', name, settlement: roomId };
  }
  visit(owner: string, settlement: string, now: number): ChatSettlement {
    if (this.db.prepare('SELECT 1 FROM chat_visitors WHERE owner=? AND settlement=?').get(owner, settlement))
      return this.visitor(owner, settlement, now);
    const target = this.directory(owner, now).settlements.find(value => value.id === settlement);
    if (!target) throw new ApiError(403, 'This settlement is outside your exploration radius.');
    this.db.prepare('INSERT OR IGNORE INTO chat_visitors VALUES (?,?)').run(owner, settlement);
    return target;
  }
  visitor(owner: string, settlement: string, now: number): ChatSettlement {
    if (this.authorize(owner, settlement, now).kind !== 'settlement') throw new ApiError(403, 'This chat is not available here.');
    const row = this.db.prepare(`SELECT s.id, json_extract(s.data,'$.account.game.home.x') AS x,
      json_extract(s.data,'$.account.game.home.y') AS y, json_extract(s.data,'$.account.game.population') AS population,
      json_extract(s.data,'$.account.game.federation') AS federation, p.nickname FROM chat_rooms r JOIN sessions s ON s.id=r.target
      LEFT JOIN chat_profiles p ON p.owner=s.id${this.profileFilter} WHERE r.id=?`).get(settlement)!;
    return { id: settlement, name: row.nickname == null ? 'Unnamed settlement' : String(row.nickname), x: Number(row.x), y: Number(row.y),
      population: Number(row.population), federation: row.federation == null ? null : String(row.federation), own: row.id === owner };
  }
}
