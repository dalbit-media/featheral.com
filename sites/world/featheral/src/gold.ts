import type { ApiState } from './api-types.ts';
export interface GoldCommand { type: 'gold'; side: 'buy' | 'sell'; quantity: number; limitDollars: number }
export interface GoldSnapshot {
  quantity: number;
  rate: number;
  quotes: Record<'buy' | 'sell', { dollars: number; available: boolean }>;
}
export interface GoldResponse extends ApiState { gold: GoldSnapshot }
