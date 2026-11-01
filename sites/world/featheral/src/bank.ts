import type { ApiState } from './api-types.ts';
import { worldYearMs } from './environment.ts';
import type { ClockSpeed } from './environment.ts';

export const stakingYears = Object.freeze([1, 2, 5, 10, 20, 30] as const);
export type StakingYears = typeof stakingYears[number];
export function isStakingYears(value: unknown): value is StakingYears {
  return typeof value === 'number' && stakingYears.some(years => years === value);
}
export function stakingRealMs(years: StakingYears, clockSpeed: ClockSpeed): number {
  return years * worldYearMs / clockSpeed;
}
export interface BankPosition {
  id: number;
  principal: number;
  valuationDollars: number;
  interestDollars: number;
  aprBps: number;
  years: StakingYears;
  startedAt: number;
  readyAt: number;
  status: 'locked' | 'claimed';
}
export interface BankQuote {
  principal: number;
  years: StakingYears;
  valuationDollars: number;
  interestDollars: number;
  rateRevision: number;
  available: boolean;
  reason: string | null;
}
export interface BankSnapshot {
  accountId: string;
  treasury: { available: number; reserved: number };
  council: { members: number; member: boolean; aprBps: number | null; revision: number };
  proposal: { id: number; aprBps: number; approvals: number; rejections: number; vote: 'approve' | 'reject' | null } | null;
  positions: BankPosition[];
  quote: BankQuote;
}
export type BankCommand =
  | { type: 'stake'; quantity: number; years: StakingYears; rateRevision: number; valuationDollars: number; interestDollars: number }
  | { type: 'fund'; dollars: number }
  | { type: 'claim-stake'; positionId: number }
  | { type: 'propose-rate'; aprBps: number }
  | { type: 'vote-rate'; proposalId: number; approve: boolean };
export interface BankResponse extends ApiState { bank: BankSnapshot }
export interface BankActionResponse extends BankResponse { message: string }
