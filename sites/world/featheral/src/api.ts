import type { ApiState, CollectionResponse, Command } from './api-types.ts';
import type { Resource } from './engine.ts';
import type { HalfSaleResponse, MarketAsset, MarketCommand, MarketResponse } from './market.ts';
import type { ChatDirectory, ChatMessage, ChatProfile, ChatSettlement, ChatSubmission, RoomChatInfo } from './chat.ts';
import type { GoldCommand, GoldResponse } from './gold.ts';
import type { BankActionResponse, BankCommand, BankResponse, StakingYears } from './bank.ts';
import type { WorldProfileLink } from './world-profile.ts';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function request<T = ApiState>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API returned a non-JSON response. Start the backend and restart Vite to load its API proxy.');
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, body.error ?? `API failed (${response.status}).`);
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
export const readCollection = (resource: Resource): Promise<CollectionResponse> => request(`collection?asset=${resource}`);
async function submit<T>(state: ApiState, command: Command | MarketCommand | GoldCommand | BankCommand, path: string): Promise<T> {
  const body = JSON.stringify({ id: crypto.randomUUID(), revision: state.revision, command });
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body };
  try { return await request<T>(path, init); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    // A lost response must retry the same operation, never create another claim.
    return request<T>(path, init);
  }
}
export const send = (state: ApiState, command: Command): Promise<ApiState> => submit(state, command, 'actions');
export const readMarket = (asset: MarketAsset, quantity: number): Promise<MarketResponse> => request(`market?asset=${encodeURIComponent(asset)}&quantity=${quantity}`);
export const readHalfSale = (): Promise<HalfSaleResponse> => request('market/half');
export const sendMarket = (state: ApiState, command: MarketCommand): Promise<MarketResponse> => submit(state, command, 'market/actions');
export const readGold = (quantity: number): Promise<GoldResponse> => request(`gold?quantity=${quantity}`);
export const sendGold = (state: ApiState, command: GoldCommand): Promise<GoldResponse> => submit(state, command, 'gold/actions');
export const readBank = (quantity: number, years: StakingYears): Promise<BankResponse> => request(`bank?quantity=${quantity}&years=${years}`);
export const sendBank = (state: ApiState, command: BankCommand): Promise<BankActionResponse> => submit(state, command, 'bank/actions');
export const readChat = (room?: string): Promise<RoomChatInfo> => request(`chat${room ? `?room=${encodeURIComponent(room)}` : ''}`);
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
