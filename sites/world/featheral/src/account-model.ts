import { fthgScale, fthgUnits } from './fthg.ts';

export const withdrawalIncrement = 1000;
export function maximumWithdrawal(balance: number): number {
  return Math.floor(fthgUnits(balance) / (withdrawalIncrement * fthgScale)) * withdrawalIncrement;
}
export function withdrawalError(value: string, balance: number): string | null {
  const text = value.trim(), amount = Number(text);
  if (!/^\d+(?:\.0+)?$/.test(text) || !Number.isSafeInteger(amount) || amount <= 0 || amount % withdrawalIncrement !== 0) {
    return 'Enter a positive multiple of 1,000 FTHG.';
  }
  return amount > maximumWithdrawal(balance) ? 'Not enough available FTHG.' : null;
}
export function walletAddress(value: unknown): string | null {
  if (!Array.isArray(value) || !value.every((address: unknown): address is string => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address))) {
    throw new Error('The wallet returned an invalid address.');
  }
  return value[0] ?? null;
}
export function walletChain(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error('The wallet returned an invalid network.');
  }
  return value;
}
