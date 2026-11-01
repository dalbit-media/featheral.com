import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { GameError } from '../src/engine.ts';
import { accrue, ApiError, apply, snapshot } from './economy.ts';
import type { Store } from './store.ts';
import { isMarketAsset, isMarketResource, marketQuantityLimit } from '../src/market.ts';
import { ChatHub, chatNickname, chatSubmission } from './chat.ts';
import { chatCapacity } from '../src/chat.ts';
import { isStakingYears } from '../src/bank.ts';
import { verifyWorldProfileLink } from './world-profile.ts';
import type { WorldProfile } from '../src/world-profile.ts';

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function json(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new ApiError(415, 'Use application/json.');
  if (Number(request.headers['content-length'] ?? 0) > 2048) throw new ApiError(413, 'Request body too large.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw new ApiError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
}
export function createApi(store: Store, origin: string, readWorldProfile?: (address: string) => Promise<WorldProfile | null>) {
  if (readWorldProfile) store.chatDirectory.useWorldProfiles();
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin.');
  const localHostname = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !localHostname) throw new Error('HTTPS is required outside loopback.');
  const secure = url.protocol === 'https:';
  const allowedOrigins = secure ? new Set([origin]) : new Set(
    [origin, ...['localhost', '127.0.0.1', '[::1]'].map(host => `http://${host}${url.port ? `:${url.port}` : ''}`)],
  );
  const cookie = secure ? '__Host-terra' : 'terra-dev';
  const limits = new Map<string, { start: number; count: number; sessions: number; chat: number }>();
  const chat = new ChatHub(store.chat, Date.now, (owner, room) => { store.chatDirectory.authorize(owner, room, Date.now()); });
  const reply = (response: ServerResponse, status: number, body: unknown, publicStats = false): void => {
    response.writeHead(status, { 'Content-Type': 'application/json',
      'Cache-Control': publicStats ? 'public, max-age=15, s-maxage=15' : 'no-store',
      ...(publicStats ? { Vary: 'Origin, Sec-Fetch-Site' } : {}),
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    try {
      const address = request.socket.remoteAddress ?? 'unknown', now = Date.now();
      for (const [key, value] of limits) if (now - value.start >= 60000) limits.delete(key);
      let limit = limits.get(address);
      if (!limit) {
        if (limits.size >= 10000) throw new ApiError(503, 'Request capacity reached.');
        limit = { start: now, count: 0, sessions: 0, chat: 0 }; limits.set(address, limit);
      }
      const chatUrl = new URL(request.url ?? '/', origin);
      const chatPath = chatUrl.pathname;
      const chatRoute = ['/api/chat', '/api/chat/events', '/api/chat/profile', '/api/chat/messages', '/api/chat/ping', '/api/chat/directory', '/api/chat/visit'].includes(chatPath);
      if (chatRoute ? ++limit.chat > 10000 : ++limit.count > 240) throw new ApiError(429, 'Too many requests. Wait one minute.');
      if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' && request.headers['sec-fetch-site'] !== 'none') throw new ApiError(403, 'Cross-site requests are not allowed.');
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw new ApiError(403, 'Origin rejected.');
      if (request.method === 'POST' && !allowedOrigins.has(request.headers.origin ?? '')) throw new ApiError(403, 'Exact Origin required.');
      if (request.url === '/api/stats') {
        if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed.');
        reply(response, 200, { ...store.publicTotals(), updatedAt: now }, true);
        return;
      }
      const token = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookie}=`))?.slice(cookie.length + 1) ?? '';
      if (request.url === '/api/session' && request.method === 'POST') {
        const body = await json(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError(400, 'Session body must be empty.');
        if (token) throw new ApiError(409, 'A session cookie already exists. Do not reset identities to retry actions.');
        if (++limit.sessions > 5) throw new ApiError(429, 'Too many new sessions. Wait one minute.');
        const session = store.create();
        response.setHeader('Set-Cookie', `${cookie}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
        reply(response, 201, { csrf: session.csrf });
        return;
      }
      if (chatRoute) {
        const read = ['/api/chat', '/api/chat/events', '/api/chat/directory'].includes(chatPath)
          || (['/api/chat/visit', '/api/chat/profile'].includes(chatPath) && request.method === 'GET');
        if (request.method !== (read ? 'GET' : 'POST')) throw new ApiError(405, 'Method not allowed.');
        if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
        const identity = store.chatSession(token);
        if (readWorldProfile && !(chatPath === '/api/chat/profile' && request.method === 'POST')) {
          const address = store.chat.worldAddress(identity.owner);
          if (address) {
            const profile = await readWorldProfile(address);
            if (store.chat.worldAddress(identity.owner) === address) {
              if (profile) store.chat.syncWorldProfile(identity.owner, address, profile.username, now);
              else { chat.disconnect(identity.owner); store.chat.unlinkWorldProfile(identity.owner); }
            }
          }
        }
        if ([...chatUrl.searchParams.keys()].some(key => key !== (chatPath === '/api/chat/visit' ? 'settlement' : 'room'))
          || [...chatUrl.searchParams.keys()].length > 1) throw new ApiError(400, 'Invalid chat query.');
        if (chatPath === '/api/chat/profile' && chatUrl.searchParams.size) throw new ApiError(400, 'Invalid chat query.');
        if (read) {
          if (chatPath === '/api/chat/profile') {
            const profile = store.chat.profile(identity.owner);
            reply(response, 200, readWorldProfile && !profile?.address ? null : profile);
            return;
          }
          if (chatPath === '/api/chat/directory') {
            reply(response, 200, store.chatDirectory.directory(identity.owner, now));
            return;
          }
          if (chatPath === '/api/chat/visit') {
            reply(response, 200, store.chatDirectory.visitor(identity.owner, chatUrl.searchParams.get('settlement') ?? '', now));
            return;
          }
          const room = store.chatDirectory.authorize(identity.owner, chatUrl.searchParams.get('room'), now);
          if (chatPath === '/api/chat') {
            const profile = store.chat.profile(identity.owner);
            reply(response, 200, { profile: readWorldProfile && !profile?.address ? null : profile, online: chat.online, capacity: chatCapacity,
              connected: chat.connected(identity.owner), serverTime: now, room, ...store.chatDirectory.directory(identity.owner, now) });
          } else {
            if (readWorldProfile && !store.chat.worldAddress(identity.owner)) throw new ApiError(409, 'Use your World profile in the avatar menu to join chat.');
            chat.admit(identity.owner);
            response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
              'Cross-Origin-Resource-Policy': 'same-origin', ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) });
            response.flushHeaders(); request.socket.setKeepAlive(true, 30000);
            chat.join(identity.owner, identity.expires, response, room.id);
          }
        } else {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !equal(csrf, identity.csrf)) throw new ApiError(403, 'CSRF token rejected.');
          const body = await json(request);
          if (chatPath === '/api/chat/profile') {
            if (!readWorldProfile) reply(response, 200, store.chat.rename(identity.owner, chatNickname(body), now));
            else if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
              chat.disconnect(identity.owner);
              store.chat.unlinkWorldProfile(identity.owner);
              reply(response, 200, null);
            } else {
              const address = verifyWorldProfileLink(body, identity.csrf, now);
              const profile = await readWorldProfile(address);
              if (!profile) throw new ApiError(409, 'Create your World profile before using it in Play.');
              chat.disconnect(identity.owner);
              reply(response, 200, store.chat.syncWorldProfile(identity.owner, address, profile.username, now));
            }
          }
          else if (chatPath === '/api/chat/visit') {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'settlement'
              || !('settlement' in body) || typeof body.settlement !== 'string') throw new ApiError(400, 'Invalid chat payload.');
            reply(response, 200, store.chatDirectory.visit(identity.owner, body.settlement, now));
          }
          else if (chatPath === '/api/chat/messages') {
            if (readWorldProfile && !store.chat.worldAddress(identity.owner)) throw new ApiError(409, 'Use your World profile in the avatar menu to join chat.');
            const room = store.chatDirectory.authorize(identity.owner, chatUrl.searchParams.get('room') ?? chat.room(identity.owner), now);
            reply(response, 200, chat.send(identity.owner, chatSubmission(body), room.id));
          }
          else {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError(400, 'Invalid chat payload.');
            chat.ping(identity.owner); reply(response, 200, { online: chat.online, capacity: chatCapacity });
          }
        }
        return;
      }
      const marketUrl = new URL(request.url ?? '/', origin), marketRead = marketUrl.pathname === '/api/market', marketAction = request.url === '/api/market/actions';
      const halfRead = marketUrl.pathname === '/api/market/half';
      const collectionRead = marketUrl.pathname === '/api/collection';
      const goldRead = marketUrl.pathname === '/api/gold', goldAction = request.url === '/api/gold/actions';
      const bankRead = marketUrl.pathname === '/api/bank', bankAction = request.url === '/api/bank/actions';
      if (request.url !== '/api/state' && request.url !== '/api/actions' && !marketRead && !marketAction && !goldRead && !goldAction && !halfRead && !collectionRead && !bankRead && !bankAction) throw new ApiError(404, 'API route not found.');
      if (((request.url === '/api/state' || marketRead || goldRead || halfRead || collectionRead || bankRead) && request.method !== 'GET') || ((request.url === '/api/actions' || marketAction || goldAction || bankAction) && request.method !== 'POST')) throw new ApiError(405, 'Method not allowed.');
      if (halfRead && [...marketUrl.searchParams].length) throw new ApiError(400, 'Invalid half-sale query.');
      const asset = marketUrl.searchParams.get('asset') ?? 'wood', quantity = Number(marketUrl.searchParams.get('quantity') ?? '1');
      if (collectionRead && ([...marketUrl.searchParams.keys()].length !== 1 || !marketUrl.searchParams.has('asset') || !isMarketAsset(asset) || !isMarketResource(asset))) throw new ApiError(400, 'Invalid collection query.');
      if (marketRead && ([...marketUrl.searchParams.keys()].some(key => key !== 'asset' && key !== 'quantity') || !isMarketAsset(asset)
        || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > marketQuantityLimit(asset))) throw new ApiError(400, 'Invalid market query.');
      if (goldRead && [...marketUrl.searchParams.keys()].some(key => key !== 'quantity')) throw new ApiError(400, 'Invalid Gold query.');
      const bankYears = Number(marketUrl.searchParams.get('years') ?? 1);
      if (bankRead && ([...marketUrl.searchParams.keys()].some(key => key !== 'quantity' && key !== 'years')
        || [...marketUrl.searchParams.keys()].length !== new Set(marketUrl.searchParams.keys()).size || !isStakingYears(bankYears))) throw new ApiError(400, 'Invalid bank query.');
      if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
      const body = request.method === 'POST' ? await json(request) : null;
      const result = request.method === 'POST'
        ? store.transaction(token, (session, time, realTime, exchange, owner, bank) => {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError(403, 'CSRF token rejected.');
          return { ...(bankAction ? bank.apply(owner, session.account, body, time, realTime) : goldAction ? exchange.gold.apply(owner, session.account, body, time, realTime) : marketAction ? exchange.action(owner, session, body, time, realTime) : apply(session.account, body, time, realTime,
            command => exchange.collectSell(owner, session.account, command, time, realTime))), csrf: session.csrf };
        })
        : store.transaction(token, (session, time, realTime, exchange, owner, bank) => {
          accrue(session.account, time);
          return { ...(collectionRead && isMarketAsset(asset) && isMarketResource(asset) ? exchange.collectionQuote(owner, session.account, asset, realTime) : halfRead ? exchange.halfQuote(owner, session.account, realTime) : marketRead && isMarketAsset(asset) ? exchange.read(owner, session.account, time, realTime, asset, quantity) : snapshot(session.account)),
            ...(goldRead ? { gold: exchange.gold.read(quantity) } : {}),
            ...(bankRead && isStakingYears(bankYears) ? { bank: bank.read(owner, session.account, quantity, bankYears) } : {}), csrf: session.csrf };
        });
      const lifetime = store.read(token, (session, _time, realTime) => session.expires - realTime);
      if (lifetime > 7 * 86400000) response.setHeader('Set-Cookie', `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.min(400 * 86400, Math.floor(lifetime / 1000))}${secure ? '; Secure' : ''}`);
      reply(response, 200, { ...result, clockSpeed: store.clockSpeed, population: store.population(result.game.federation) });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error instanceof GameError ? 409 : 500;
      if (status === 500) console.error('API request failed', error);
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      if (status === 429) response.setHeader('Retry-After', error instanceof ApiError && error.message === 'Wait three seconds between messages.' ? '3'
        : error instanceof ApiError && error.message === 'Global chat is busy. Wait a moment before sending.' ? '1' : '60');
      reply(response, status, { error: status === 500 ? 'Internal server error.' : (error as Error).message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.on('close', () => chat.close());
  return server;
}
