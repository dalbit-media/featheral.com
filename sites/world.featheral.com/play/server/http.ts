import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { GameError } from '../src/engine.ts';
import { accrue, ApiError, apply, parseActionEnvelope, parseCommand, snapshot } from './economy.ts';
import type { Store } from './store.ts';
import { isMarketAsset, isMarketResource, marketSaleQuantityLimit, marketResources } from '../src/market.ts';
import type { MarketAsset } from '../src/market.ts';
import { parseMarketCommand } from './market.ts';
import { inventory } from './inventory.ts';
import { sellableItemCount } from '../src/items.ts';
import { ChatHub, chatNickname, chatSubmission } from './chat.ts';
import { chatCapacity } from '../src/chat.ts';
import { isAddress, verifyMessage } from 'ethers';
import { walletLinkMessage } from '../src/funds.ts';
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
export function createApi(store: Store, origin: string, readWorldProfile?: (address: string) => Promise<WorldProfile | null>, scope: 'world' | 'dollar' | 'all' = 'all') {
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
  let nextLimitCleanup = 0;
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
      if (request.url?.startsWith('/api/dollar/game/')) request.url = request.url.replace('/api/dollar/game/', '/api/');
      const path = new URL(request.url ?? '/', origin).pathname;
      const worldRoute = path === '/api/session' || path.startsWith('/api/chat');
      if ((scope === 'world' && !worldRoute) || (scope === 'dollar' && worldRoute)) throw new ApiError(404, 'This API does not own that operation.');
      const address = request.socket.remoteAddress ?? 'unknown', now = Date.now();
      if (now >= nextLimitCleanup) {
        for (const [key, value] of limits) if (now - value.start >= 60000) limits.delete(key);
        nextLimitCleanup = now + 1000;
      }
      const token = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookie}=`))?.slice(cookie.length + 1) ?? '';
      if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' && request.headers['sec-fetch-site'] !== 'none') throw new ApiError(403, 'Cross-site requests are not allowed.');
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw new ApiError(403, 'Origin rejected.');
      if (request.method === 'POST' && !allowedOrigins.has(request.headers.origin ?? '')) throw new ApiError(403, 'Exact Origin required.');
      // Only verified canonical owners get independent quotas; forged cookies cannot create buckets.
      const key = token && path !== '/api/session' && path !== '/api/stats' ? `owner:${store.chatSession(token).owner}` : `ip:${address}`;
      let limit = limits.get(key);
      if (limit && now - limit.start >= 60000) { limits.delete(key); limit = undefined; }
      if (!limit) {
        if (limits.size >= 10000) throw new ApiError(503, 'Request capacity reached.');
        limit = { start: now, count: 0, sessions: 0, chat: 0 }; limits.set(key, limit);
      }
      const chatUrl = new URL(request.url ?? '/', origin);
      const chatPath = chatUrl.pathname;
      const chatRoute = ['/api/chat', '/api/chat/events', '/api/chat/profile', '/api/chat/messages', '/api/chat/ping', '/api/chat/directory', '/api/chat/visit'].includes(chatPath);
      if (chatRoute ? ++limit.chat > 10000 : ++limit.count > 240) throw new ApiError(429, 'Too many requests. Wait one minute.');
      if (request.url === '/api/stats') {
        if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed.');
        reply(response, 200, { ...store.publicTotals(), updatedAt: now }, true);
        return;
      }
      if (['/api/wallet/funds', '/api/wallet/funds/prepare', '/api/wallet/funds/complete', '/api/wallet/funds/authorization', '/api/wallet/funds/cancel'].includes(path)) {
        if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
        if (path === '/api/wallet/funds') {
          if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed.');
          reply(response, 200, { ...store.fundView(token), csrf: store.chatSession(token).csrf });
          return;
        }
        if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed.');
        const identity = store.chatSession(token);
        if (typeof request.headers['x-csrf-token'] !== 'string' || !equal(request.headers['x-csrf-token'], identity.csrf)) throw new ApiError(403, 'CSRF token rejected.');
        const body = await json(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Invalid World transfer.');
        if (path.endsWith('/authorization')) {
          if (Object.keys(body).join() !== 'address') throw new ApiError(400, 'Invalid wallet authorization.');
          const { address } = body as { address: unknown };
          if (typeof address !== 'string' || !isAddress(address) || /^0x0{40}$/i.test(address)) throw new ApiError(400, 'Valid wallet required.');
          const issuedAt = new Date().toISOString();
          reply(response, 200, { issuedAt, message: walletLinkMessage(address, identity.csrf, issuedAt, origin, false, true) });
        } else if (path.endsWith('/cancel')) {
          if (Object.keys(body).join() !== 'id') throw new ApiError(400, 'Invalid World transfer.');
          const { id } = body as { id: unknown };
          if (typeof id !== 'string') throw new ApiError(400, 'Invalid World transfer.');
          reply(response, 200, store.cancelFund(token, id));
        } else if (path.endsWith('/prepare')) {
          const input = body as { id: string; direction: string; amount: string };
          reply(response, 200, store.prepareFund(token, input, origin));
        } else {
          if (Object.keys(body).sort().join() !== 'id,signature') throw new ApiError(400, 'Invalid World transfer.');
          const input = body as { id: string; signature: string };
          if (typeof input.id !== 'string' || typeof input.signature !== 'string') throw new ApiError(400, 'Signed World transfer required.');
          reply(response, 200, await store.completeFund(token, input.id, input.signature));
        }
        return;
      }
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
      if (path === '/api/wallet/balance') {
        if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed.');
        if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
        reply(response, 200, store.walletView(token));
        return;
      }
      if (path === '/api/wallet/link' || path === '/api/wallet/revoke') {
        if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed.');
        if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
        const identity = store.chatSession(token);
        if (typeof request.headers['x-csrf-token'] !== 'string' || !equal(request.headers['x-csrf-token'], identity.csrf)) throw new ApiError(403, 'CSRF token rejected.');
        const body = await json(request);
        let activeToken = token, lifetime = 400 * 86400;
        if (path === '/api/wallet/revoke') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError(400, 'Invalid wallet link.');
          activeToken = store.revokeWallet(token).token;
          lifetime = 7 * 86400;
        } else {
          if (!body || typeof body !== 'object' || Array.isArray(body)
            || !['address,issuedAt,signature', 'address,issuedAt,moveGuestFunds,signature', 'address,issuedAt,moveGuestFunds,separateWorldFunds,signature'].includes(Object.keys(body).sort().join())) throw new ApiError(400, 'Invalid wallet link.');
          const { address, issuedAt, signature, moveGuestFunds = false, separateWorldFunds = false } = body as Record<string, unknown>;
          if (typeof address !== 'string' || !isAddress(address) || /^0x0{40}$/i.test(address)
            || typeof issuedAt !== 'string' || !Number.isFinite(Date.parse(issuedAt)) || Math.abs(now - Date.parse(issuedAt)) > 300000
            || typeof signature !== 'string' || typeof moveGuestFunds !== 'boolean' || typeof separateWorldFunds !== 'boolean') throw new ApiError(400, 'Invalid or expired wallet authorization.');
          let signer: string;
          try { signer = verifyMessage(walletLinkMessage(address, identity.csrf, issuedAt, origin, moveGuestFunds, separateWorldFunds), signature); }
          catch { throw new ApiError(401, 'Wallet signature could not be verified.'); }
          if (signer.toLowerCase() !== address.toLowerCase()) throw new ApiError(401, 'Wallet signature does not match.');
          store.linkWallet(token, address.toLowerCase(), moveGuestFunds, separateWorldFunds);
        }
        const result = store.read(activeToken, session => ({ ...snapshot(session.account), csrf: session.csrf }));
        response.setHeader('Set-Cookie', `${cookie}=${activeToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}${secure ? '; Secure' : ''}`);
        reply(response, 200, { ...result, ...store.walletContext(activeToken), clockSpeed: store.clockSpeed, population: store.population(result.game.federation) });
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
      if (request.url !== '/api/state' && request.url !== '/api/actions' && !marketRead && !marketAction && !halfRead && !collectionRead) throw new ApiError(404, 'API route not found.');
      if (((request.url === '/api/state' || marketRead || halfRead || collectionRead) && request.method !== 'GET') || ((request.url === '/api/actions' || marketAction) && request.method !== 'POST')) throw new ApiError(405, 'Method not allowed.');
      if (halfRead && [...marketUrl.searchParams].length) throw new ApiError(400, 'Invalid half-sale query.');
      const asset = marketUrl.searchParams.get('asset') ?? 'wood', quantity = Number(marketUrl.searchParams.get('quantity') ?? '1');
      if (collectionRead && ([...marketUrl.searchParams.keys()].some(key => key !== 'asset' && key !== 'quantity') || marketUrl.searchParams.getAll('asset').length !== 1
        || marketUrl.searchParams.getAll('quantity').length > 1 || !isMarketAsset(asset) || !isMarketResource(asset)
        || marketUrl.searchParams.has('quantity') && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > marketSaleQuantityLimit(asset)))) throw new ApiError(400, 'Invalid collection query.');
      if (marketRead && ([...marketUrl.searchParams.keys()].some(key => key !== 'asset' && key !== 'quantity') || !isMarketAsset(asset)
        || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > marketSaleQuantityLimit(asset))) throw new ApiError(400, 'Invalid market query.');
      if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'Session required.');
      if (collectionRead && isMarketAsset(asset) && isMarketResource(asset) && marketUrl.searchParams.has('quantity')) {
        store.read(token, session => {
          if (quantity > Math.floor(session.account.pending[asset] / 60000)) throw new ApiError(409, 'Resources changed. Refresh the collection quote.');
        });
      }
      if (request.method === 'GET' && (marketRead || collectionRead) && isMarketAsset(asset)) {
        const saleQuantity = isMarketResource(asset) ? store.read(token, session => collectionRead
          ? Math.min(marketUrl.searchParams.has('quantity') ? quantity : Number.MAX_SAFE_INTEGER, Math.floor(session.account.pending[asset] / 60000)) : Math.min(quantity, session.account.game.stock[asset]))
          : store.read(token, session => Math.min(quantity, sellableItemCount(inventory(session.account), asset)));
        await store.ensureLiquidity?.(token, asset, saleQuantity);
      }
      if (request.method === 'GET' && halfRead) {
        for (const resource of marketResources) await store.ensureLiquidity?.(token, resource,
          store.read(token, session => Math.floor(session.account.game.stock[resource] / 2)));
      }
      const body = request.method === 'POST' ? await json(request) : null;
      if (request.method === 'POST' && store.liquidityEnabled) {
        store.read(token, session => {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError(403, 'CSRF token rejected.');
        });
        const envelope = parseActionEnvelope(body);
        const assets = new Map<MarketAsset, number>();
        if (marketAction) {
          const command = parseMarketCommand(envelope.command);
          if (command.type === 'spot' || command.type === 'limit') assets.set(command.asset, command.side === 'sell' ? command.quantity : 0);
          else if (command.type === 'sell-half') for (const sale of command.sales) assets.set(sale.asset, sale.quantity);
        } else {
          const command = parseCommand(envelope.command);
          if (command.type === 'collect-sell') assets.set(command.resource, command.quantity);
        }
        const fresh = store.read(token, session => envelope.revision === session.account.revision);
        if (fresh) for (const [asset, saleQuantity] of assets) await store.ensureLiquidity?.(token, asset, saleQuantity);
      }
      const result = request.method === 'POST'
        ? store.transaction(token, (session, time, realTime, exchange, owner) => {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError(403, 'CSRF token rejected.');
          return { ...(marketAction ? exchange.action(owner, session, body, time, realTime) : apply(session.account, body, time, realTime,
            command => exchange.collectSell(owner, session.account, command, time, realTime),
            command => {
              if (!store.contributeFederation) throw new ApiError(503, 'Federation vault is unavailable.');
              return store.contributeFederation(session.account, owner, command, time);
            })), csrf: session.csrf };
        })
        : store.transaction(token, (session, time, realTime, exchange, owner) => {
          accrue(session.account, time);
          return { ...(collectionRead && isMarketAsset(asset) && isMarketResource(asset) ? exchange.collectionQuote(owner, session.account, asset, realTime, marketUrl.searchParams.has('quantity') ? quantity : undefined) : halfRead ? exchange.halfQuote(owner, session.account, realTime) : marketRead && isMarketAsset(asset) ? exchange.read(owner, session.account, time, realTime, asset, quantity) : snapshot(session.account)),
            csrf: session.csrf };
        });
      const lifetime = store.read(token, (session, _time, realTime) => session.expires - realTime);
      if (lifetime > 7 * 86400000) response.setHeader('Set-Cookie', `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.min(400 * 86400, Math.floor(lifetime / 1000))}${secure ? '; Secure' : ''}`);
      reply(response, 200, { ...result, ...store.walletContext(token), clockSpeed: store.clockSpeed, population: store.population(result.game.federation),
        federationVault: store.federationView?.(token) ?? null });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error instanceof GameError ? 409 : 500;
      if (status === 500) console.error('API request failed', error);
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      if (status === 429) response.setHeader('Retry-After', error instanceof ApiError && error.message === 'Wait three seconds between messages.' ? '3'
        : error instanceof ApiError && ['Global chat is busy. Wait a moment before sending.', 'Wait half a second between claims.', 'Actions are limited to four per second.'].includes(error.message) ? '1' : '60');
      if (status === 401 && request.url === '/api/state') response.setHeader('Set-Cookie', `${cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
      reply(response, status, { error: status === 500 ? 'Internal server error.' : (error as Error).message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.on('close', () => chat.close());
  return server;
}
