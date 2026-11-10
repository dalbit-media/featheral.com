import type { ApiState, CollectionResponse, Command } from './api-types.ts';
import type { Resource } from './engine.ts';
import type { HalfSaleResponse, MarketAsset, MarketCommand, MarketResponse } from './market.ts';
import type { ChatDirectory, ChatMessage, ChatProfile, ChatSettlement, ChatSubmission, RoomChatInfo } from './chat.ts';
import type { WorldProfileLink } from './world-profile.ts';
import { needsWalletSigner, publishWorldAccount } from './funds.ts';
import type { AtlasSnapshot } from './atlas.ts';
import type { BuyQuantityRequest } from './market-buy-quantity.ts';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const autoCraftTimeoutMs = 60000;
async function request<T = ApiState>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const world = path === 'session' || path.startsWith('chat');
  const response = await fetch(`${world ? '/api/' : '/api/dollar/game/'}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API returned a non-JSON response. Start the backend and restart Vite to load its API proxy.');
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, body?.error ?? `API failed (${response.status}).`);
  if (typeof body?.fundAccountId === 'string') publishWorldAccount(body.fundAccountId);
  return body;
}
export async function connect(): Promise<ApiState> {
  try { return await request('state'); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    await request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return request('state');
  }
}
export const refresh = (): Promise<ApiState> => request('state');
export const readAtlas = (): Promise<AtlasSnapshot> => request('atlas');
export const readCollection = (resource: Resource, quantity?: number): Promise<CollectionResponse> => request(`collection?asset=${resource}${quantity === undefined ? '' : `&quantity=${quantity}`}`);
async function submit<T>(state: ApiState, command: Command | MarketCommand, path: string): Promise<T> {
  if (needsWalletSigner(state) && window.FeatheralProfile.snapshot().account.toLowerCase() !== state.fundWallet) throw new Error('Connect the authorized gameplay wallet before spending FTH$.');
  const body = JSON.stringify({ id: crypto.randomUUID(), revision: state.revision, command });
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body };
  const timeoutMs = command.type === 'auto-craft' || command.type === 'profit-analysis' ? autoCraftTimeoutMs : 10000;
  try { return await request<T>(path, init, timeoutMs); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    // A lost response must retry the same operation, never create another claim.
    try { return await request<T>(path, init, timeoutMs); }
    catch (retryError) {
      if (command.type === 'auto-craft' && retryError instanceof Error && retryError.name === 'TimeoutError')
        throw new Error('Automatic crafting response timed out. It may have completed. Refresh inventory before trying again.');
      throw retryError;
    }
  }
}
export const send = (state: ApiState, command: Command): Promise<ApiState> => submit(state, command, 'actions');
export const readMarket = (asset: MarketAsset, quantity: number, buying?: BuyQuantityRequest, catalog = false): Promise<MarketResponse> =>
  request(`market?asset=${encodeURIComponent(asset)}&quantity=${quantity}${catalog ? '&catalog=1' : ''}${buying ? `&budgetPercent=${buying.percent}${buying.price === undefined ? '' : `&price=${buying.price}`}` : ''}`, undefined, catalog ? autoCraftTimeoutMs : 10000);
export const readHalfSale = (): Promise<HalfSaleResponse> => request('market/half');
export const sendMarket = (state: ApiState, command: MarketCommand): Promise<MarketResponse> => submit(state, command, 'market/actions');
export async function readAutoCraft(): Promise<import('./auto-crafting.ts').AutoCraftResponse> {
  try { return await request('market/auto-craft', undefined, autoCraftTimeoutMs); }
  catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Profit review took too long. Nothing was consumed. Please try again.');
    throw error;
  }
}
export const linkFundWallet = (csrf: string, address: string, issuedAt: string, signature: string, moveGuestFunds = false, separateWorldFunds = false): Promise<ApiState> => request('wallet/link', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ address, issuedAt, signature, moveGuestFunds, separateWorldFunds }),
});
export const readChat = (room?: string): Promise<RoomChatInfo> => request(`chat${room ? `?room=${encodeURIComponent(room)}` : ''}`);
export const revokeFundWallet = (csrf: string): Promise<ApiState> => request('wallet/revoke', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}',
});
export const readChatDirectory = (): Promise<ChatDirectory> => request('chat/directory');
export const readChatProfile = (): Promise<ChatProfile | null> => request('chat/profile');
export const linkWorldProfile = (csrf: string, link: WorldProfileLink | null): Promise<ChatProfile | null> => request('chat/profile', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(link ?? {}),
});
export const visitSettlement = (csrf: string, settlement: string): Promise<ChatSettlement> => request('chat/visit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ settlement }),
});
export const readVisitedSettlement = (settlement: string): Promise<ChatSettlement> => request(`chat/visit?settlement=${encodeURIComponent(settlement)}`);
export const chatPing = (csrf: string): Promise<{ online: number; capacity: number }> => request('chat/ping', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}',
});
export async function chatSend(csrf: string, message: ChatSubmission, room?: string): Promise<ChatMessage> {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(message) };
  const path = `chat/messages${room ? `?room=${encodeURIComponent(room)}` : ''}`;
  try { return await request<ChatMessage>(path, init); }
  catch (error) { if (error instanceof HttpError) throw error; return request<ChatMessage>(path, init); }
}
