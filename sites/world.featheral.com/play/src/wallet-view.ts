import './wallet-view.css';
import { localize } from './i18n-dom.ts';

declare global {
  interface Window {
    FeatheralWorldFunds?: {
      mount(root: HTMLElement, options?: { onSettled?: () => Promise<void>; onRender?: () => void }): { refresh(): Promise<void>; dispose(): void };
    };
    FeatheralWallet?: {
      apply(): void;
      authenticate(challenge: (address: string) => Promise<{ message: string }>): Promise<{ address: string; signature: string }>;
    };
  }
}

let walletReady: Promise<void> | undefined;
let fundsReady: Promise<void> | undefined;
export function loadWorldFunds(): Promise<void> {
  if (window.FeatheralWorldFunds) return Promise.resolve();
  return fundsReady ??= new Promise<void>((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/world-funds.css';
    document.head.append(css);
    const script = document.createElement('script'); script.src = '/world-funds.js';
    script.onload = () => {
      if (window.FeatheralWorldFunds) resolve();
      else { fundsReady = undefined; reject(new Error('World funds panel unavailable. Retry shortly.')); }
    };
    script.onerror = () => { fundsReady = undefined; script.remove(); css.remove(); reject(new Error('World funds panel unavailable. Retry shortly.')); };
    document.head.append(script);
  });
}
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
  constructor(root: HTMLElement, onSettled?: () => Promise<void>) {
    root.innerHTML = `<header class="bank-heading"><div><small>FEATHERAL WALLET</small><h1>World funds &amp; wallet</h1><p>One World budget across your FTH$ wallets. Wallet balances remain separate; deposits and withdrawals require approval.</p></div><a class="button" href="/market/">Open marketplace</a></header>
      <div id="funds" data-game-funds></div>
      <p>FTHG and staking principal remain on Ethereum Mainnet.</p>
      <div class="world-dollar-wallet" data-wallet-embed data-wallet-primary="FTH$" data-wallet-view="assets"></div><p data-wallet-error role="status" hidden></p>`;
    localize(root);
    void loadWorldFunds().then(() => {
      const funds = root.querySelector<HTMLElement>('[data-game-funds]')!;
      window.FeatheralWorldFunds!.mount(funds, { onSettled, onRender: () => localize(funds) });
      localize(root);
    }).catch(error => {
      console.error('World funds unavailable.', error);
      root.querySelector<HTMLElement>('[data-game-funds]')!.textContent = error instanceof Error ? error.message : 'World funds unavailable.';
    });
    void loadWorldWallet().then(() => window.FeatheralWallet!.apply()).catch(error => {
      console.error('World wallet unavailable.', error);
      const status = root.querySelector<HTMLElement>('[data-wallet-error]')!;
      status.textContent = error instanceof Error ? error.message : 'Wallet app unavailable. Reload to retry.';
      status.hidden = false; localize(root);
    });
  }
}
