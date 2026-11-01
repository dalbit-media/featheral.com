import './wallet-view.css';
import { localize } from './i18n-dom.ts';

export class WalletPage {
  constructor(root: HTMLElement) {
    root.innerHTML = `<header class="bank-heading"><div><small>FEATHERAL WALLET</small><h1>Wallet and staking</h1><p>FTH$ is your Dollar ledger balance. FTHG and staking principal remain on Ethereum Mainnet.</p></div><a class="button" href="/play/market/">Open marketplace</a></header>
      <p>Authorize your wallet in Account to use its FTH$ for gameplay. Transfers, conversion and staking below use the same wallet balance. No simulated Gold or staking rewards are created.</p>
      <iframe class="world-dollar-wallet" data-dollar-wallet src="/wallet/?embedded=1" title="Featheral Dollar wallet"></iframe>`;
    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    frame.addEventListener('load', () => {
      frame.contentWindow!.addEventListener('featheral:wallet', () => {
        const account = frame.contentWindow!.FeatheralProfile.snapshot().account;
        window.dispatchEvent(new CustomEvent('featheral:embedded-wallet', { detail: account }));
      });
    });
    localize(root);
  }
}
