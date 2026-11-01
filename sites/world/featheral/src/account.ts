import './account.css';
import { maximumWithdrawal, withdrawalError } from './account-model.ts';
import { accountPageKeys, gamePages } from './game-pages.ts';
import { formatFthg } from './fthg.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize, wireLanguageControls } from './i18n-dom.ts';
import { icon } from './icons.ts';
import type { ApiState } from './api-types.ts';
import { guideContent, wireGuide } from './guide.ts';
import { downloadSnapshot, renderJournalEntries } from './journal.ts';
import { linkWorldProfile, readChatProfile } from './api.ts';
import { chatProfileChangedEvent, chatProfileSettingsEvent } from './chat.ts';
import { worldProfileLinkMessage } from './world-profile.ts';
import type { WorldProfile } from './world-profile.ts';

type AccountView = 'account' | typeof accountPageKeys[number];

declare global {
  interface Window {
    FeatheralProfile: {
      mount(button: HTMLButtonElement, options: { panelRoot: HTMLElement; walletUrl: string; primaryCurrency: string }): Promise<void>;
      snapshot(): { account: string; profile: WorldProfile | null };
      getProvider(): { request(args: { method: string; params: string[] }): Promise<unknown> } | null;
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
  private balance: number;
  private profileAttempt = 0;
  private profileSaving = false;
  private profileKey = '';
  private readonly walletReady: Promise<void>;
  private readonly t: (text: string) => string;

  constructor(trigger: HTMLButtonElement, language: Language, snapshot: () => ApiState) {
    this.trigger = trigger;
    this.snapshot = snapshot;
    this.language = language;
    const balance = snapshot().fthg;
    this.balance = balance;
    this.t = text => translate(text, language);
    this.dialog.id = 'account-pane';
    this.dialog.className = 'account-pane';
    this.dialog.setAttribute('aria-labelledby', 'account-title');
    this.dialog.innerHTML = `<header class="account-heading"><button type="button" class="button account-back" aria-label="Back to account" hidden>${icon('chevron')}</button><div><small>YOUR PIONEER</small><h2 id="account-title" tabindex="-1">Account</h2></div><button type="button" class="button account-close" aria-label="Close account">${icon('close')}</button></header>
      <div class="account-content">
        <section class="account-profile" aria-labelledby="account-profile-title"><h3 id="account-profile-title">World profile</h3><div class="account-world-profile"><button type="button" class="wallet-icon" data-world-profile-button aria-label="Connect wallet and edit World profile"></button><strong data-world-profile-name data-no-localize></strong><a class="button" href="/#/me">Open World profile</a></div><p>Your World username and avatar are shared with Play. Edit them in the wallet profile menu.</p><button type="button" class="button primary wide" data-world-profile-link>Use World profile in Play</button><p data-account-profile-status role="status"></p><button type="button" class="button" data-account-profile-retry hidden>Reconnect</button></section>
        <section class="account-section account-wallet-section" aria-labelledby="account-wallet-title"><h3 id="account-wallet-title">Wallet and withdrawals</h3><p>Wallet connection is optional. Never share your recovery phrase or private key.</p><p class="account-note">Using your World profile does not move or replace your game save.</p><p data-wallet-status role="status"></p>
        <section class="account-withdrawal"><h3>Withdraw FTHG</h3><p class="account-unavailable">Withdrawals are not available yet. No tokens are sent and no FTHG is deducted.</p><p>Withdrawals require multiples of 1,000 FTHG. A payout network, token and service must be configured first.</p><form data-withdrawal-form><label class="account-amount"><span>Withdrawal amount · FTHG</span><input type="number" min="1000" step="1000" inputmode="numeric" required data-withdrawal-amount aria-describedby="withdrawal-rule withdrawal-error"></label><small id="withdrawal-rule"><span>Maximum eligible amount</span>: <strong data-withdrawal-maximum></strong> FTHG</small><p id="withdrawal-error" role="status"></p><button type="submit" class="button wide" disabled>Withdrawals unavailable</button></form></section>
        </section>
        <div class="account-balances"><section class="account-balance"><span>${icon('dollars')}<span>Featheral Dollar</span></span><strong data-account-dollars></strong><a href="/play/market/">Open marketplace ${icon('chevron')}</a></section>
        <section class="account-balance account-gold"><span>${icon('fthg')}<span>Available FTHG</span></span><strong data-account-balance></strong><a href="/play/bank/" data-account-bank>Open Featheral Bank ${icon('chevron')}</a><small>Exchange · Staking · Council rates</small></section></div>
        <nav class="account-links" aria-label="Account resources"><a class="button" href="/play/contacts/">${icon('people')}<span>Contacts</span>${icon('chevron')}</a>${accountPageKeys.map(key => `<button type="button" data-account-view="${key}">${icon(key)}<span>${gamePages[key].label}</span>${icon('chevron')}</button>`).join('')}</nav>
        <details class="account-section" open><summary>Settings</summary><label class="account-setting"><span>Language</span><select data-language aria-label="Language"><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select></label><label class="account-setting"><span>Show world conditions</span><input type="checkbox" data-account-weather></label></details>
      </div><div class="account-subview" data-account-journal hidden></div><div class="account-subview" data-account-help hidden></div>`;
    document.body.append(this.dialog);
    this.walletReady = window.FeatheralProfile.mount(this.dialog.querySelector<HTMLButtonElement>('[data-world-profile-button]')!,
      { panelRoot: this.dialog, primaryCurrency: 'fthDollar', walletUrl: '/wallet/' });
    window.addEventListener('featheral:wallet', () => { void this.loadProfile(false); });
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
    this.dialog.querySelector('[data-withdrawal-amount]')!.addEventListener('input', () => this.validateWithdrawal());
    this.dialog.querySelector('[data-withdrawal-form]')!.addEventListener('submit', event => {
      event.preventDefault();
      this.validateWithdrawal();
      this.status('Withdrawals are not available yet. No tokens are sent and no FTHG is deducted.', true);
    });
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
  updateBalance(balance: number, numberLocale: string): void {
    this.balance = balance;
    this.dialog.querySelector('[data-account-dollars]')!.textContent = `FTH$${formatFthg(this.snapshot().dollars, numberLocale)}`;
    this.dialog.querySelector('[data-account-balance]')!.textContent = `${formatFthg(balance, numberLocale)} FTHG`;
    this.dialog.querySelector('[data-withdrawal-maximum]')!.textContent = formatFthg(maximumWithdrawal(balance), numberLocale);
    this.validateWithdrawal();
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
  private validateWithdrawal(): void {
    const input = this.dialog.querySelector<HTMLInputElement>('[data-withdrawal-amount]')!;
    const error = input.validity.badInput ? 'Enter a positive multiple of 1,000 FTHG.' : input.value ? withdrawalError(input.value, this.balance) : null;
    input.setCustomValidity(error ? this.t(error) : '');
    input.setAttribute('aria-invalid', String(!!error));
    this.dialog.querySelector('#withdrawal-error')!.textContent = error ? this.t(error) : '';
  }
  private status(message: string, error = false): void {
    const node = this.dialog.querySelector<HTMLElement>('[data-wallet-status]')!;
    node.textContent = this.t(message);
    node.setAttribute('role', error ? 'alert' : 'status');
    node.classList.toggle('account-error', error);
  }
}
