import './wallet-view.css';
import { localize } from './i18n-dom.ts';

export class WalletPage {
  constructor(root: HTMLElement) {
    root.innerHTML = `<header class="bank-heading"><div><small>FEATHERAL WALLET</small><h1>World funds &amp; wallet</h1><p>Keep a separate gameplay budget. FTHG and staking principal remain on Ethereum Mainnet.</p></div><a class="button" href="/market/">Open marketplace</a></header>
      <p><a class="button" href="/world-funds.html" target="_blank" rel="noopener">Manage World deposits &amp; withdrawals</a></p>
      <p>Authorize a separate World budget, then approve each deposit or withdrawal. Existing legacy direct-wallet sessions remain unchanged until you explicitly switch.</p>
      <div class="world-dollar-wallet" data-dollar-wallet></div>`;
    const target = new URL(location.href);
    target.hostname = location.hostname.endsWith('.localhost') ? 'wallet.localhost' : 'wallet.featheral.com';
    const frame = document.createElement('iframe');
    target.pathname = '/'; target.hash = '';
    target.search = new URLSearchParams({ embedded: '1', parentOrigin: location.origin, primary: 'FTH$', view: 'assets' }).toString();
    frame.src = target.href; frame.title = 'Featheral central wallet';
    frame.style.cssText = 'width:100%;height:800px;border:0';
    frame.referrerPolicy = 'origin';
    root.querySelector('[data-dollar-wallet]')!.append(frame);
    localize(root);
  }
}
