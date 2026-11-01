export function walletLinkMessage(address: string, csrf: string, issuedAt: string, origin: string): string {
  return [
    'Featheral World Dollar wallet session', '',
    `Wallet: ${address.toLowerCase()}`, `Session: ${csrf}`, `Issued at: ${issuedAt}`, `Origin: ${origin}`, '',
    'Authorize this browser session to spend this wallet\'s FTH$ on World gameplay.',
    'No Ethereum transaction is sent. Never share your recovery phrase or private key.',
  ].join('\n');
}
