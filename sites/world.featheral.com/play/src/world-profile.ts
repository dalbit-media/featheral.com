export interface WorldProfile { username: string; avatar: string }
export interface WorldProfileLink { address: string; issuedAt: number; signature: string }
export function worldProfileLinkMessage(address: string, csrf: string, issuedAt: number): string {
  return ['Featheral World profile for Play', '', `Wallet: ${address}`, `Play session: ${csrf}`,
    `Issued at: ${issuedAt}`, '', 'Use my World profile in this Play session. This does not transfer tokens or change my game save.'].join('\n');
}
