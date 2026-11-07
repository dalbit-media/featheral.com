import './account.css';
import { accountPageKeys, gamePages } from './game-pages.ts';
import { formatDollars } from './dollars.ts';
import { formatFthg } from './fthg.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize, wireLanguageControls } from './i18n-dom.ts';
import { icon } from './icons.ts';
import type { ApiState } from './api-types.ts';
import { guideContent, wireGuide } from './guide.ts';
import { downloadSnapshot, renderJournalEntries } from './journal.ts';
import { linkFundWallet, linkWorldProfile, readChatProfile, revokeFundWallet } from './api.ts';
import { walletLinkMessage } from './funds.ts';
import { formatUnits, hexlify, toUtf8Bytes } from 'ethers';
import { chatProfileChangedEvent, chatProfileSettingsEvent } from './chat.ts';
import { worldProfileLinkMessage } from './world-profile.ts';
import type { WorldProfile } from './world-profile.ts';
import { titleItems } from './customization.ts';

type AccountView = 'account' | typeof accountPageKeys[number];

declare global {
  interface Window {
    FeatheralProfile: {
      mount(button: HTMLButtonElement, options: { panelRoot: HTMLElement; walletUrl: string; primaryCurrency: string; profileUrl: string; ethereumProvider: boolean }): Promise<void>;
      snapshot(): { account: string; profile: WorldProfile | null; balances?: { fthg: bigint | null } };
      getProvider(): { request(args: { method: string; params: string[] }): Promise<unknown> } | null;
      refresh(): Promise<void>;
    };
  }
}

export class AccountPane {
  private readonly dialog = document.createElement('dialog');
  private readonly trigger: HTMLButtonElement;
  private readonly snapshot: () => ApiState;
  private readonly language: Language;
  private view: AccountView = 'account';
  private accountScroll = 0;
  private readonly update: (state: ApiState) => void;
  private profileAttempt = 0;
  private profileSaving = false;
  private revokingFunds = false;
  private profileKey = '';
  private readonly walletReady: Promise<void>;
  private readonly t: (text: string) => string;

  constructor(trigger: HTMLButtonElement, language: Language, snapshot: () => ApiState, update: (state: ApiState) => void) {
    this.trigger = trigger;
    this.snapshot = snapshot;
    this.language = language;
    const balance = snapshot().fthg;
    this.update = update;
    this.t = text => translate(text, language);
    this.dialog.id = 'account-pane';
    this.dialog.className = 'account-pane';
    this.dialog.setAttribute('aria-labelledby', 'account-title');
    this.dialog.innerHTML = `<header class="account-heading"><button type="button" class="button account-back" aria-label="Back to account" hidden>${icon('chevron')}</button><div><small>YOUR PIONEER</small><h2 id="account-title" tabindex="-1">Account</h2></div><button type="button" class="button account-close" aria-label="Close account">${icon('close')}</button></header>
      <div class="account-content">
        <section class="account-profile" aria-labelledby="account-profile-title"><h3 id="account-profile-title">World profile</h3><div class="account-world-profile"><button type="button" class="wallet-icon" data-world-profile-button aria-label="Connect wallet and view World profile"></button><strong data-world-profile-name data-no-localize></strong><a class="button" href="/#/setup" target="_blank" rel="noopener">Edit avatar &amp; profile</a></div><p>Your World username and avatar are shared with Play. Edit them on the World Getting started page.</p><button type="button" class="button primary wide" data-world-profile-link>Use World profile in Play</button><p data-account-profile-status role="status"></p><button type="button" class="button" data-account-profile-retry hidden>Reconnect</button></section>
        <section class="account-section account-wallet-section" aria-labelledby="account-wallet-title"><h3 id="account-wallet-title">Wallet and World budget</h3><p>Authorize a separate World fund, then deposit or withdraw existing FTH$. Gameplay spends the World budget only after you switch. Legacy direct-wallet sessions stay unchanged until you approve. Never share your recovery phrase or private key.</p><button type="button" class="button primary wide" data-fund-wallet-link>Authorize World budget</button><p data-wallet-status role="status"></p><a class="button wide" href="/world-funds.html" target="_blank" rel="noopener">Deposit / Withdraw World funds</a>
        <button type="button" class="button wide" data-fund-wallet-revoke>Stop wallet gameplay access</button>
        <a class="button wide" href="/bank/">Open wallet, conversion and staking</a>
        </section>
        <div class="account-balances"><section class="account-balance"><span>${icon('dollars')}<span>Featheral Dollar</span></span><strong data-account-dollars></strong><a href="/market/">Open marketplace ${icon('chevron')}</a></section>
        <section class="account-balance account-gold"><span>${icon('fthg')}<span>FTHG on Ethereum</span></span><strong data-account-balance></strong><a href="/bank/" data-account-bank>Open wallet and staking ${icon('chevron')}</a><small>Ethereum Mainnet · confirmed bridge credits only</small></section></div>
        <nav class="account-links" aria-label="Account resources"><a class="button" href="/contacts/">${icon('people')}<span>Contacts</span>${icon('chevron')}</a>${accountPageKeys.map(key => `<button type="button" data-account-view="${key}">${icon(key)}<span>${gamePages[key].label}</span>${icon('chevron')}</button>`).join('')}</nav>
        <details class="account-section" open><summary>Settings</summary><label class="account-setting"><span>Language</span><select data-language aria-label="Language"><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select></label><label class="account-setting"><span>Show world conditions</span><input type="checkbox" data-account-weather></label></details>
      </div><div class="account-subview" data-account-journal hidden></div><div class="account-subview" data-account-help hidden></div>`;
    document.body.append(this.dialog);
    const identity = document.createElement('section');
    identity.className = 'account-section';
    identity.innerHTML = '<h3>Settlement identity</h3><p data-custom-settlement data-no-localize></p><p data-custom-region data-no-localize></p><p data-custom-title></p><a class="button" href="/settlement/#inventory">Use naming permits and title badges</a>';
    this.dialog.querySelector('.account-profile')!.after(identity);
    this.walletReady = window.FeatheralProfile.mount(this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-button]')!,
      { panelRoot: this.dialog, primaryCurrency: 'fthDollar', walletUrl: '/wallet/', profileUrl: '/#/setup', ethereumProvider: true });
    window.addEventListener('featheral:wallet', () => {
      this.updateBalance(0, locale(language)); void this.loadProfile(false);
      const linked = this.snapshot().fundWallet;
      if (linked && window.FeatheralProfile.snapshot().account.toLowerCase() !== linked) void this.stopFundAccess();
    });
    window.addEventListener('featheral:embedded-wallet', event => {
      if (event instanceof CustomEvent && typeof event.detail === 'string'
        && this.snapshot().fundWallet && event.detail.toLowerCase() !== this.snapshot().fundWallet) void this.stopFundAccess();
    });
    this.dialog.querySelector('[data-fund-wallet-revoke]')!.addEventListener('click', () => { void this.stopFundAccess(); });
    localize(this.dialog);
    wireLanguageControls(this.dialog);
    const weather = this.dialog.querySelector<HTMLInputElement>('[data-account-weather]')!;
    weather.checked = true;
    try { weather.checked = localStorage.getItem('featheral-world-conditions') !== 'hidden'; }
    catch (error) {
      console.warn('Display preference could not be read.', error);
      this.status('Display preferences could not be read. Default settings are active.', true);
    }
    document.documentElement.classList.toggle('hide-world-conditions', !weather.checked);
    weather.addEventListener('change', () => {
      document.documentElement.classList.toggle('hide-world-conditions', !weather.checked);
      try { localStorage.setItem('featheral-world-conditions', weather.checked ? 'visible' : 'hidden'); }
      catch (error) {
        console.warn('Display preference could not be saved.', error);
        this.status('Display preference could not be saved. This change lasts until reload.', true);
      }
    });
    trigger.addEventListener('click', () => this.open());
    window.addEventListener(chatProfileSettingsEvent, () => this.open(true));
    this.dialog.querySelector('[data-world-profile-link]')!.addEventListener('click', () => { void this.useWorldProfile(); });
    this.dialog.querySelector('[data-account-profile-retry]')!.addEventListener('click', () => { void this.loadProfile(true); });
    this.dialog.querySelector('.account-back')!.addEventListener('click', () => this.showView('account'));
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-account-view]').forEach(button => {
      button.addEventListener('click', () => {
        const view = accountPageKeys.find(key => key === button.dataset.accountView);
        if (view) this.showView(view);
      });
    });
    this.dialog.querySelector('.account-close')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.dialog.close(); });
    this.dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.dialog.querySelector('.wp-panel:not([hidden])')) return;
        event.stopPropagation(); this.dialog.close();
      }
    });
    this.dialog.addEventListener('click', event => {
      const rect = this.dialog.getBoundingClientRect();
      if (event.target === this.dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => {
      const wallet = this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-button]')!;
      if (wallet.getAttribute('aria-expanded') === 'true') wallet.click();
      this.trigger.setAttribute('aria-expanded', 'false');
      if (this.trigger.isConnected) this.trigger.focus({ preventScroll: true });
    });
    this.dialog.querySelector('[data-fund-wallet-link]')!.addEventListener('click', () => { void this.useFundWallet(); });
    window.addEventListener('pagehide', () => {
      this.profileAttempt++;
      if (this.dialog.open) this.dialog.close();
    });
    this.updateBalance(balance, locale(language));
    void this.loadProfile(false);
  }
  get isOpen(): boolean { return this.dialog.open; }
  private open(profile = false): void {
    if (this.dialog.open) return;
    this.showView('account', false);
    this.dialog.showModal();
    this.trigger.setAttribute('aria-expanded', 'true');
    this.dialog.querySelector<HTMLButtonElement>('.account-close')!.focus();
    void this.loadProfile(profile);
  }
  private profileStatus(message: string, error = false): void {
    const status = this.dialog.querySelector<HTMLElement>('[data-account-profile-status]')!;
    status.textContent = this.t(message); status.classList.toggle('error', error);
  }
  private renderWorldProfile(): void {
    const world = window.FeatheralProfile.snapshot();
    this.dialog.querySelector('[data-world-profile-name]')!.textContent = world.profile?.username || world.account || this.t('Connect your World wallet');
    this.trigger.querySelector('img')?.remove();
    const avatar = world.account && (world.profile?.avatar || this.dialog.querySelector<HTMLImageElement>('[data-world-profile-button] img')?.src);
    if (avatar) {
      const img = document.createElement('img'); img.src = avatar; img.alt = '';
      this.trigger.append(img);
    }
  }
  private async loadProfile(focus: boolean): Promise<void> {
    this.renderWorldProfile();
    if (this.profileSaving) return;
    const attempt = ++this.profileAttempt;
    const button = this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-link]')!;
    const retry = this.dialog.querySelector<HTMLElement>('[data-account-profile-retry]')!;
    button.disabled = true; retry.hidden = true;
    this.profileStatus('Loading profile...');
    try {
      await this.walletReady;
      if (attempt !== this.profileAttempt) return;
      let profile = await readChatProfile();
      if (attempt !== this.profileAttempt) return;
      const world = window.FeatheralProfile.snapshot();
      if (profile?.address && profile.address.toLowerCase() !== world.account.toLowerCase()) {
        await linkWorldProfile(this.snapshot().csrf, null);
        if (attempt !== this.profileAttempt) return;
        profile = null;
      }
      this.renderWorldProfile();
      button.hidden = !!profile; button.disabled = !world.account || !world.profile;
      this.profileStatus(profile ? `${this.t('World profile synced')}: ${profile.nickname}` : 'Connect your wallet, create a World profile, then use it in Play.');
      const key = profile ? `${profile.id}:${profile.address}:${profile.nickname}` : '';
      if (key !== this.profileKey) {
        this.profileKey = key;
        window.dispatchEvent(new Event(chatProfileChangedEvent));
      }
      if (focus && this.dialog.open) this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-button]')!.focus();
    } catch (error) {
      if (attempt === this.profileAttempt) { this.profileStatus(error instanceof Error ? error.message : 'Connection failed.', true); retry.hidden = false; }
    }
  }
  private async stopFundAccess(): Promise<void> {
    if (this.revokingFunds || !this.snapshot().fundWallet) return;
    this.revokingFunds = true;
    const target = this.dialog.querySelector<HTMLElement>('[data-wallet-status]')!;
    try {
      this.update(await revokeFundWallet(this.snapshot().csrf));
      target.textContent = this.t('Wallet gameplay access revoked. Sign again to restore your settlement.');
    } catch (error) {
      console.error('Gameplay wallet revocation failed.', error);
      target.textContent = this.t('Wallet gameplay access could not be revoked. Retry before leaving this browser.');
      if (!this.dialog.open) this.dialog.showModal();
    } finally { this.revokingFunds = false; }
  }
  private async useWorldProfile(): Promise<void> {
    if (this.profileSaving) return;
    this.profileSaving = true;
    this.profileAttempt++;
    let failure = '';
    const button = this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-link]')!;
    button.disabled = true;
    this.profileStatus('Waiting for your World wallet signature...');
    try {
      const world = window.FeatheralProfile.snapshot(), provider = window.FeatheralProfile.getProvider();
      if (!world.account || !world.profile || !provider) throw new Error('Connect your wallet and create your World profile first.');
      const csrf = this.snapshot().csrf, issuedAt = Date.now();
      const message = worldProfileLinkMessage(world.account, csrf, issuedAt);
      const hex = `0x${[...new TextEncoder().encode(message)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const signature = await provider.request({ method: 'personal_sign', params: [hex, world.account] });
      if (typeof signature !== 'string') throw new Error('Invalid World profile signature.');
      if (window.FeatheralProfile.snapshot().account !== world.account) throw new Error('Wallet changed. Try again.');
      await linkWorldProfile(csrf, { address: world.account, issuedAt, signature });
      if (window.FeatheralProfile.snapshot().account.toLowerCase() !== world.account.toLowerCase()) {
        await linkWorldProfile(csrf, null);
        throw new Error('Wallet changed. Try again.');
      }
    } catch (error) { failure = error instanceof Error ? error.message : 'The action could not be completed.'; }
    finally {
      this.profileSaving = false;
      button.disabled = false;
      await this.loadProfile(false);
      if (failure) this.profileStatus(failure, true);
    }
  }
  updateBalance(_balance: number, numberLocale: string): void {
    const custom = this.snapshot().customization;
    this.dialog.querySelector('[data-custom-settlement]')!.textContent = `${this.t('Settlement name')}: ${custom?.settlementName ?? this.t('Unnamed settlement')}`;
    this.dialog.querySelector('[data-custom-region]')!.textContent = `${this.t('Region name')}: ${custom?.regionName ?? this.t('Unnamed region')}`;
    this.dialog.querySelector('[data-custom-title]')!.textContent = `${this.t('Player title')}: ${custom?.title ? this.t(titleItems[custom.title].title) : this.t('No player title')}`;
    this.dialog.querySelector('[data-account-dollars]')!.textContent = `FTH$${formatDollars(this.snapshot().dollars, numberLocale)}`;
    const raw = window.FeatheralProfile.snapshot().balances?.fthg;
    this.dialog.querySelector('[data-account-balance]')!.textContent = typeof raw === 'bigint' ? `${formatFthg(Number(formatUnits(raw, 18)), numberLocale)} FTHG` : 'Unavailable';
    this.dialog.querySelector<HTMLButtonElement>('[data-fund-wallet-link]')!.disabled = !window.FeatheralProfile.snapshot().account;
    const fundWallet = this.snapshot().fundWallet;
    const walletStatus = this.dialog.querySelector<HTMLElement>('[data-wallet-status]')!;
    if (!walletStatus.classList.contains('account-error')) walletStatus.textContent = fundWallet
      ? `Authorized wallet: ${fundWallet}. Open World funds to check budget mode and balances.` : this.t('Guest FTH$ stays in World until you explicitly approve a transfer.');
    if (this.dialog.querySelector('[data-account-journal]')!.childElementCount) this.renderActivity();
  }
  private showView(view: AccountView, focus = true): void {
    const previous = this.view;
    const content = this.dialog.querySelector<HTMLElement>('.account-content')!;
    if (previous === 'account') this.accountScroll = content.scrollTop;
    this.view = view;
    this.dialog.dataset.view = view;
    content.hidden = view !== 'account';
    this.dialog.querySelector<HTMLElement>('[data-account-journal]')!.hidden = view !== 'journal';
    const help = this.dialog.querySelector<HTMLElement>('[data-account-help]')!;
    help.hidden = view !== 'help';
    this.dialog.querySelector<HTMLElement>('.account-back')!.hidden = view === 'account';
    this.dialog.querySelector('#account-title')!.textContent = this.t(view === 'account' ? 'Account' : gamePages[view].label);
    if (view === 'journal') this.showActivity();
    if (view === 'help' && !help.childElementCount) {
      help.innerHTML = guideContent(this.language, true);
      localize(help);
      wireGuide(help, this.language, true);
    }
    if (view === 'account') content.scrollTop = this.accountScroll;
    if (focus) {
      const target = view === 'account' && previous !== 'account'
        ? this.dialog.querySelector<HTMLElement>(`[data-account-view="${previous}"]`)
        : this.dialog.querySelector<HTMLElement>('#account-title');
      target?.focus({ preventScroll: true });
    }
  }
  private showActivity(): void {
    const root = this.dialog.querySelector<HTMLElement>('[data-account-journal]')!;
    if (!root.childElementCount) {
      root.innerHTML = `<section class="page-card journal-tools"><label for="account-journal-search">Search your journal</label><input id="account-journal-search" type="search" placeholder="Find a discovery or milestone" autocomplete="off"><span data-journal-count role="status"></span><div class="panel-actions"><button class="button" data-account-export="snapshot">${icon('download')} Export snapshot</button><button class="button" data-account-export="legacy">${icon('journal')} Old browser save</button></div><p class="fineprint">Recent events are shown newest first. Exports are records, not importable balances.</p><p data-account-export-status role="status"></p></section><section class="page-card journal-page-list" data-journal-list aria-label="Recent events"></section>`;
      localize(root);
      root.querySelector('input')!.addEventListener('input', () => this.renderActivity());
      root.querySelectorAll<HTMLButtonElement>('[data-account-export]').forEach(button => {
        button.addEventListener('click', () => {
          const status = root.querySelector('[data-account-export-status]')!;
          try {
            downloadSnapshot(this.snapshot(), button.dataset.accountExport === 'legacy');
            status.textContent = this.t('World save exported. Keep it somewhere safe.');
            status.setAttribute('role', 'status');
          } catch (error) {
            status.textContent = this.t(`Export failed: ${error instanceof Error ? error.message : 'Storage is unavailable.'}`);
            status.setAttribute('role', 'alert');
          }
        });
      });
    }
    this.renderActivity();
  }
  private renderActivity(): void {
    const root = this.dialog.querySelector<HTMLElement>('[data-account-journal]')!;
    const query = root.querySelector<HTMLInputElement>('input')!.value;
    const scroll = root.scrollTop;
    renderJournalEntries(root.querySelector<HTMLElement>('[data-journal-list]')!, root.querySelector('[data-journal-count]')!, this.snapshot().game.log, query, this.language);
    root.scrollTop = scroll;
  }
  private async useFundWallet(): Promise<void> {
    const button = this.dialog.querySelector<HTMLButtonElement>('[data-fund-wallet-link]')!;
    button.disabled = true;
    try {
      await this.walletReady;
      const address = window.FeatheralProfile.snapshot().account;
      const provider = window.FeatheralProfile.getProvider();
      if (!address || !provider) throw new Error('Connect a wallet first.');
      const moveGuestFunds = false, separateWorldFunds = true;
      if (!confirm(`Authorize a separate World budget for ${address}? Existing funds stay where they are. Gameplay will spend only World funds, not your wallet. Deposit or withdraw from World funds when needed.`)) return;
      const csrf = this.snapshot().csrf, issuedAt = new Date().toISOString();
      const signature = await provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(walletLinkMessage(address, csrf, issuedAt, location.origin, moveGuestFunds, separateWorldFunds))), address] });
      if (typeof signature !== 'string') throw new Error('Wallet returned an invalid signature.');
      if (window.FeatheralProfile.snapshot().account !== address) throw new Error('Wallet changed. Try again.');
      this.update(await linkFundWallet(csrf, address, issuedAt, signature, moveGuestFunds, separateWorldFunds));
      await window.FeatheralProfile.refresh();
      this.status('Separate World budget authorized. Open World funds to deposit or withdraw.');
    } catch (error) { this.status(error instanceof Error ? error.message : 'Wallet authorization failed.', true); }
    finally { button.disabled = !window.FeatheralProfile.snapshot().account; }
  }
  private status(message: string, error = false): void {
    const node = this.dialog.querySelector<HTMLElement>('[data-wallet-status]')!;
    node.textContent = this.t(message);
    node.setAttribute('role', error ? 'alert' : 'status');
    node.classList.toggle('account-error', error);
  }
}
