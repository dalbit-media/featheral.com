import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../../../../services/database/sqlite.js';
import { ApiError } from './economy.ts';
import { chatCapacity, chatHistoryLimit, chatMessageLimit } from '../src/chat.ts';
import type { ChatMessage, ChatProfile, ChatSubmission } from '../src/chat.ts';

function fields(body: unknown, keys: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length
    || keys.some(key => !Object.hasOwn(body, key))) throw new ApiError(400, 'Invalid chat payload.');
  return body as Record<string, unknown>;
}
export function chatNickname(body: unknown): string {
  const { nickname } = fields(body, ['nickname']);
  if (typeof nickname !== 'string') throw new ApiError(400, 'Nickname must contain 2-20 letters, numbers, spaces, underscores or hyphens.');
  const name = nickname.normalize('NFC').trim().replace(/ +/g, ' ');
  if ([...name].length < 2 || [...name].length > 20 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name))
    throw new ApiError(400, 'Nickname must contain 2-20 letters, numbers, spaces, underscores or hyphens.');
  return name;
}
export function chatSubmission(body: unknown): ChatSubmission {
  const { id, text, createdAt } = fields(body, ['id', 'text', 'createdAt']);
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new ApiError(400, 'Invalid chat request ID.');
  if (typeof text !== 'string' || [...text].length > chatMessageLimit || Buffer.byteLength(text) > 1200
    || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) || text.split('\n').length > 5)
    throw new ApiError(400, 'Messages allow 1-300 characters and at most five lines. Control characters are not allowed.');
  const normalized = text.normalize('NFC').trim();
  if (!normalized) throw new ApiError(400, 'Messages allow 1-300 characters and at most five lines. Control characters are not allowed.');
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new ApiError(400, 'Invalid chat timestamp.');
  return { id, text: normalized, createdAt };
}
const frame = (event: string, value: unknown): string => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
export class ChatArchive {
  private readonly db: SqliteDatabase;
  private messages: ChatMessage[];
  historyFrame: string;
  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS chat_profiles (
      owner TEXT PRIMARY KEY, publicId TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, nameKey TEXT NOT NULL UNIQUE, updatedAt INTEGER NOT NULL, lastMessageAt INTEGER);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, nickname TEXT NOT NULL, text TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, requestId TEXT NOT NULL, request TEXT NOT NULL,
        message TEXT NOT NULL, time INTEGER NOT NULL, UNIQUE(owner, requestId));`);
    if (!db.prepare('PRAGMA table_info(chat_messages)').all().some(row => row.name === 'room'))
      db.exec("ALTER TABLE chat_messages ADD COLUMN room TEXT NOT NULL DEFAULT 'global'");
    db.exec('CREATE INDEX IF NOT EXISTS chat_message_room ON chat_messages(room,id)');
    if (!db.prepare('PRAGMA table_info(chat_profiles)').all().some(row => row.name === 'worldAddress'))
      db.exec('ALTER TABLE chat_profiles ADD COLUMN worldAddress TEXT');
    this.messages = db.prepare("SELECT * FROM (SELECT * FROM chat_messages WHERE room='global' ORDER BY id DESC LIMIT ?) ORDER BY id").all(chatHistoryLimit)
      .map(row => ({ id: Number(row.id), author: String(row.author), nickname: String(row.nickname), text: String(row.text), time: Number(row.time) }));
    this.historyFrame = frame('history', this.messages);
  }
  profile(owner: string): ChatProfile | null {
    const row = this.db.prepare('SELECT publicId, nickname, worldAddress FROM chat_profiles WHERE owner = ?').get(owner);
    return row ? { id: String(row.publicId), nickname: String(row.nickname), ...(row.worldAddress ? { address: String(row.worldAddress) } : {}) } : null;
  }
  worldAddress(owner: string): string | null {
    const row = this.db.prepare('SELECT worldAddress FROM chat_profiles WHERE owner=?').get(owner);
    return row?.worldAddress ? String(row.worldAddress) : null;
  }
  syncWorldProfile(owner: string, address: string, username: string, now: number): ChatProfile {
    const previous = this.profile(owner);
    const id = previous?.id ?? randomUUID();
    this.db.prepare(`INSERT INTO chat_profiles(owner,publicId,nickname,nameKey,updatedAt,worldAddress) VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner) DO UPDATE SET nickname=excluded.nickname,nameKey=excluded.nameKey,updatedAt=excluded.updatedAt,worldAddress=excluded.worldAddress`)
      .run(owner, id, username, `world:${address.toLowerCase()}:${owner}`, now, address);
    return { id, nickname: username, address };
  }
  unlinkWorldProfile(owner: string): void {
    this.db.prepare('UPDATE chat_profiles SET worldAddress=NULL WHERE owner=?').run(owner);
  }
  history(room = 'global'): string {
    if (room === 'global') return this.historyFrame;
    const messages = this.db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(room, chatHistoryLimit).map(row => ({ id: Number(row.id), author: String(row.author), nickname: String(row.nickname), text: String(row.text), time: Number(row.time) }));
    return frame('history', messages);
  }
  rename(owner: string, nickname: string, now: number): ChatProfile {
    const previous = this.db.prepare('SELECT * FROM chat_profiles WHERE owner = ?').get(owner);
    if (previous?.nickname === nickname) return { id: String(previous.publicId), nickname };
    if (previous && now - Number(previous.updatedAt) < 60000) throw new ApiError(429, 'Wait one minute before changing your nickname.');
    const key = nickname.toLowerCase(), taken = this.db.prepare('SELECT owner FROM chat_profiles WHERE nameKey = ?').get(key);
    if (taken && taken.owner !== owner) throw new ApiError(409, 'That nickname is already in use.');
    const id = previous ? String(previous.publicId) : randomUUID();
    this.db.prepare(`INSERT INTO chat_profiles (owner,publicId,nickname,nameKey,updatedAt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET nickname=excluded.nickname, nameKey=excluded.nameKey, updatedAt=excluded.updatedAt`)
      .run(owner, id, nickname, key, now);
    return { id, nickname };
  }
  lastSent(owner: string): number | null {
    const row = this.db.prepare('SELECT lastMessageAt FROM chat_profiles WHERE owner = ?').get(owner);
    return row?.lastMessageAt == null ? null : Number(row.lastMessageAt);
  }
  receipt(owner: string, request: ChatSubmission, room = 'global'): ChatMessage | null {
    const row = this.db.prepare('SELECT request, message FROM chat_receipts WHERE owner = ? AND requestId = ?').get(owner, request.id);
    if (!row) return null;
    const serialized = JSON.stringify(room === 'global' ? request : { ...request, room });
    if (row.request !== serialized) throw new ApiError(409, 'Chat request ID was already used for a different message.');
    return JSON.parse(String(row.message)) as ChatMessage;
  }
  append(owner: string, profile: ChatProfile, request: ChatSubmission, now: number, room = 'global'): ChatMessage {
    this.db.exec('BEGIN IMMEDIATE');
    let message: ChatMessage;
    try {
      const result = this.db.prepare('INSERT INTO chat_messages (author,nickname,text,time,room) VALUES (?,?,?,?,?)')
        .run(profile.id, profile.nickname, request.text, now, room);
      message = { id: Number(result.lastInsertRowid), author: profile.id, nickname: profile.nickname, text: request.text, time: now };
      this.db.prepare('INSERT INTO chat_receipts (owner,requestId,request,message,time) VALUES (?,?,?,?,?)')
        .run(owner, request.id, JSON.stringify(room === 'global' ? request : { ...request, room }), JSON.stringify(message), now);
      this.db.prepare('UPDATE chat_profiles SET lastMessageAt = ? WHERE owner = ?').run(now, owner);
      this.db.prepare('DELETE FROM chat_messages WHERE room=? AND id NOT IN (SELECT id FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?)').run(room, room, chatHistoryLimit);
      this.db.prepare('DELETE FROM chat_receipts WHERE time < ? OR sequence NOT IN (SELECT sequence FROM chat_receipts ORDER BY sequence DESC LIMIT 4096)').run(now - 300000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (room === 'global') {
      this.messages = [...this.messages, message].slice(-chatHistoryLimit);
      this.historyFrame = frame('history', this.messages);
    }
    return message;
  }
  cleanup(now: number): void {
    this.db.prepare('DELETE FROM chat_profiles WHERE owner NOT IN (SELECT id FROM sessions WHERE expires > ?)').run(now);
    this.db.prepare('DELETE FROM chat_receipts WHERE time < ?').run(now - 300000);
  }
}
export interface ChatSink {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength: number;
  readonly destroyed: boolean;
  once(event: 'close' | 'drain', listener: () => void): unknown;
}
interface Participant { sink: ChatSink; expires: number; seen: number; lastMessage: number | null; blocked: boolean; room: string }
export class ChatHub {
  private readonly authorize?: (owner: string, room: string) => void;
  private readonly archive: ChatArchive;
  private readonly clock: () => number;
  private participants = new Map<string, Participant>();
  private pending: { room: string; message: ChatMessage }[] = [];
  private presenceDirty = false;
  private tokens = 10;
  private refilled: number;
  private heartbeat: number;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  constructor(archive: ChatArchive, clock = Date.now, authorize?: (owner: string, room: string) => void) {
    this.authorize = authorize;
    this.archive = archive; this.clock = clock; this.refilled = clock(); this.heartbeat = clock();
    this.flushTimer = setInterval(() => this.flush(), 100); this.flushTimer.unref();
    this.sweepTimer = setInterval(() => this.sweep(), 5000); this.sweepTimer.unref();
  }
  get online(): number { return this.participants.size; }
  connected(owner: string): boolean { return this.participants.has(owner); }
  room(owner: string): string | null { return this.participants.get(owner)?.room ?? null; }
  admit(owner: string): void {
    if (!this.archive.profile(owner)) throw new ApiError(409, 'Choose a nickname before joining global chat.');
    if (!this.participants.has(owner) && this.online >= chatCapacity) throw new ApiError(503, 'Global chat is full (1,000 users). Gameplay is still available. Try again later.');
  }
  join(owner: string, expires: number, sink: ChatSink, room = 'global'): void {
    this.authorize?.(owner, room);
    this.admit(owner);
    if (expires <= this.clock()) throw new ApiError(401, 'Session expired.');
    const previous = this.participants.get(owner);
    if (previous) { this.write(owner, previous, frame('replaced', {})); this.leave(owner, previous); }
    const participant: Participant = { sink, expires, seen: this.clock(), lastMessage: this.archive.lastSent(owner), blocked: false, room };
    this.participants.set(owner, participant); this.presenceDirty = true;
    sink.once('close', () => this.leave(owner, participant));
    this.write(owner, participant, frame('welcome', { profile: this.archive.profile(owner), online: this.online, capacity: chatCapacity, connected: true, serverTime: this.clock() }));
    this.write(owner, participant, this.archive.history(room));
  }
  ping(owner: string): void {
    const participant = this.participants.get(owner);
    if (!participant) throw new ApiError(409, 'Chat disconnected. Reconnect before sending messages.');
    this.authorize?.(owner, participant.room);
    participant.seen = this.clock();
  }
  send(owner: string, request: ChatSubmission, room?: string): ChatMessage {
    const now = this.clock(), participant = this.participants.get(owner);
    if (!participant || participant.expires <= now || now - participant.seen >= 60000) throw new ApiError(409, 'Chat disconnected. Reconnect before sending messages.');
    if (room !== undefined && participant.room !== room) throw new ApiError(409, 'Chat room changed. Reconnect before sending.');
    this.authorize?.(owner, participant.room);
    const replay = this.archive.receipt(owner, request, participant.room);
    if (replay) return replay;
    if (request.createdAt < now - 120000 || request.createdAt > now + 5000) throw new ApiError(409, 'Message request expired. Edit the message and send it again.');
    if (participant.lastMessage !== null && now - participant.lastMessage < 3000) throw new ApiError(429, 'Wait three seconds between messages.');
    this.tokens = Math.min(10, this.tokens + Math.max(0, now - this.refilled) / 100);
    this.refilled = Math.max(this.refilled, now);
    if (this.tokens < 1 || this.pending.length >= 100) throw new ApiError(429, 'Global chat is busy. Wait a moment before sending.');
    const profile = this.archive.profile(owner);
    if (!profile) throw new ApiError(409, 'Choose a nickname before joining global chat.');
    const message = this.archive.append(owner, profile, request, now, participant.room);
    this.tokens--; participant.lastMessage = now; participant.seen = now;
    this.pending.push({ room: participant.room, message });
    return message;
  }
  flush(): void {
    if (!this.pending.length && !this.presenceDirty) return;
    const messages = this.pending; this.pending = [];
    const presence = this.presenceDirty ? frame('presence', { online: this.online, capacity: chatCapacity }) : '';
    this.presenceDirty = false;
    for (const [owner, participant] of this.participants) {
      if (!this.allowed(owner, participant)) continue;
      const batch = messages.filter(message => message.room === participant.room).map(value => value.message);
      const data = (batch.length ? frame('messages', batch) : '') + presence;
      if (data) this.write(owner, participant, data);
    }
  }
  sweep(): void {
    const now = this.clock(), heartbeat = now - this.heartbeat >= 15000;
    if (heartbeat) this.heartbeat = now;
    for (const [owner, participant] of this.participants) {
      if (!this.allowed(owner, participant)) continue;
      if (participant.expires <= now || now - participant.seen >= 60000) {
        this.write(owner, participant, frame('expired', {})); this.leave(owner, participant);
      } else if (heartbeat) this.write(owner, participant, ': heartbeat\n\n');
    }
  }
  private allowed(owner: string, participant: Participant): boolean {
    try { this.authorize?.(owner, participant.room); return true; }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.write(owner, participant, frame('expired', {})); this.leave(owner, participant);
      return false;
    }
  }
  private write(owner: string, participant: Participant, data: string): void {
    if (participant.sink.destroyed || participant.blocked || participant.sink.writableLength + Buffer.byteLength(data) > 262144) {
      this.leave(owner, participant); return;
    }
    if (!participant.sink.write(data)) {
      participant.blocked = true;
      participant.sink.once('drain', () => { participant.blocked = false; });
    }
  }
  private leave(owner: string, participant: Participant): void {
    if (this.participants.get(owner) !== participant) return;
    this.participants.delete(owner); this.presenceDirty = true; participant.sink.end();
  }
  disconnect(owner: string): void {
    const participant = this.participants.get(owner);
    if (participant) this.leave(owner, participant);
  }
  close(): void {
    clearInterval(this.flushTimer); clearInterval(this.sweepTimer);
    for (const [owner, participant] of this.participants) this.leave(owner, participant);
    this.pending = [];
  }
}
