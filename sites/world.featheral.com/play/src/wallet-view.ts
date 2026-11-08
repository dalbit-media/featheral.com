import './wallet-view.css';
import { localize } from './i18n-dom.ts';

declare global {
  interface Window {
    FeatheralWallet?: {
      apply(): void;
      authenticate(challenge: (address: string) => Promise<{ message: string }>): Promise<{ address: string; signature: string }>;
    };
  }
}

let walletReady: Promise<void> | undefined;
export function loadWorldWallet(): Promise<void> {
  if (window.FeatheralWallet) return Promise.resolve();
  return walletReady ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="/shared/wallet/embed.js"]:not([data-wallet-load-failed])');
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => window.FeatheralWallet ? resolve() : reject(new Error('Wallet app unavailable. Reload to retry.')), { once: true });
    script.addEventListener('error', () => {
      walletReady = undefined; script.dataset.walletLoadFailed = 'true';
      reject(new Error('Wallet app unavailable. Reload to retry.'));
    }, { once: true });
    if (!existing) {
      script.src = '/shared/wallet/embed.js'; script.dataset.centralWalletLoader = 'true';
      document.head.append(script);
    }
  });
}

export class WalletPage {
  constructor(root: HTMLElement) {
    root.innerHTML = `<header class="bank-heading"><div><small>FEATHERAL WALLET</small><h1>World funds &amp; wallet</h1><p>One World budget across your FTH$ wallets. Wallet balances remain separate; deposits and withdrawals require approval.</p></div><a class="button" href="/market/">Open marketplace</a></header>
      <p><a class="button" href="/world-funds.html">Deposit / Withdraw World funds</a></p>
      <p>FTHG and staking principal remain on Ethereum Mainnet.</p>
      <div class="world-dollar-wallet" data-wallet-embed data-wallet-primary="FTH$" data-wallet-view="assets"></div><p data-wallet-error role="status" hidden></p>`;
    localize(root);
    void loadWorldWallet().then(() => window.FeatheralWallet!.apply()).catch(error => {
      console.error('World wallet unavailable.', error);
      const status = root.querySelector<HTMLElement>('[data-wallet-error]')!;
      status.textContent = error instanceof Error ? error.message : 'Wallet app unavailable. Reload to retry.';
      status.hidden = false; localize(root);
    });
  }
}
