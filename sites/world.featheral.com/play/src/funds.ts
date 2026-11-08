import type { ApiState } from './api-types.ts';

export function needsWalletSigner(state: Pick<ApiState, 'fundWallet' | 'fundMode'>): boolean {
  return !!state.fundWallet && state.fundMode !== 'separate';
}

export function publishWorldAccount(accountId: string): void {
  if (!/^0x[0-9a-f]{64}$/.test(accountId)) throw new Error('World returned an invalid account.');
  try { localStorage.setItem('featheral-world-account', accountId); }
  catch (error) { console.warn('World wallet display context could not be saved.', error); }
  window.dispatchEvent(new CustomEvent('featheral:world-account', { detail: accountId }));
}

export function walletLinkMessage(address: string, csrf: string, issuedAt: string, origin: string, moveGuestFunds = false, separateWorldFunds = false): string {
  return [
    'Featheral World Dollar wallet session', '',
    `Wallet: ${address.toLowerCase()}`, `Session: ${csrf}`, `Issued at: ${issuedAt}`, `Origin: ${origin}`, '',
    separateWorldFunds ? 'Authorize a separate World fund for this wallet. Gameplay spends only World funds, not wallet funds. No funds move on authorization.'
      : 'Authorize this browser session to spend this wallet\'s FTH$ on World gameplay.',
    ...(moveGuestFunds ? ['Move all existing FTH$ owned by this guest browser session into this wallet. No FTH$ is minted.'] : []),
    'No Ethereum transaction is sent. Never share your recovery phrase or private key.',
  ].join('\n');
}
