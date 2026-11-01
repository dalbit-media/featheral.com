import './bank.css';
import { readBank, sendBank } from './api.ts';
import type { ApiState } from './api-types.ts';
import { isStakingYears, stakingRealMs, stakingYears } from './bank.ts';
import type { BankCommand, BankResponse, StakingYears } from './bank.ts';
import { dollarsUnits, formatDollars } from './dollars.ts';
import { confirmConsumption, confirmationOpen } from './confirmation.ts';
import type { ConsumptionQuote } from './consumption.ts';
import { GoldTrading } from './gold-trading.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';
import { icon } from './icons.ts';

export class BankPage {
  private data: BankResponse | null = null;
  private years: StakingYears = 1;
  private pending = false;
  private quoteFresh = false;
  private sequence = 0;
  private readonly t: (text: string) => string;
  private readonly root: HTMLElement;
  private readonly state: () => ApiState;
  private readonly update: (state: ApiState) => void;
  private readonly notify: (text: string, error?: boolean) => void;
  private readonly language: Language;
  constructor(root: HTMLElement, state: () => ApiState,
    update: (state: ApiState) => void, notify: (text: string, error?: boolean) => void,
    language: Language) {
    this.root = root; this.state = state; this.update = update; this.notify = notify; this.language = language;
    this.t = text => translate(text, language);
    root.innerHTML = `<header class="bank-heading"><div><small>FEATHERAL BANK</small><h1>Featheral Bank</h1><p>Exchange FTHG, lock a long-term stake and follow council rates.</p></div><a class="button" href="/play/market/">Open marketplace ${icon('chevron')}</a></header>
      <nav class="bank-nav" aria-label="Bank services"><a href="#bank-staking">Staking</a><a href="#gold">Exchange</a><a href="#bank-council">Bank council</a></nav>
      <div class="bank-summary" data-bank-summary></div>
      <div class="bank-layout"><section class="exchange-card bank-staking" id="bank-staking"><h2>Long-term FTHG staking</h2><p>Stake FTHG and earn FTH$. Simple interest uses the exchange value at deposit. No compounding.</p>
        <form data-bank-stake><label>Stake amount · FTHG<input type="number" min="0.0001" step="0.0001" value="1" inputmode="decimal" required data-bank-quantity></label>
          <fieldset class="bank-terms"><legend>Lock period</legend><div data-bank-terms></div></fieldset>
          <dl class="bank-quote" data-bank-quote></dl><p>Annual rate applies per game year (52 weeks).</p><p class="bank-notice">Principal cannot be withdrawn early. The entire interest payment is reserved before your stake is accepted.</p>
          <p data-bank-status role="status"></p><button class="button primary wide" type="submit" disabled data-bank-submit>Review staking</button><button class="button wide" type="button" data-bank-refresh>Refresh quote</button></form></section>
        <section class="exchange-card bank-positions"><h2>Your staking positions</h2><div data-bank-positions></div><p>In-game balances only. Staking is not an Ethereum transaction or a promise of real-money returns.</p><p>Keep this browser identity. Unclaimed stakes and council roles renew a 400-day cookie; exports cannot restore account access.</p></section>
        <section class="exchange-card bank-council" id="bank-council"><h2>Featheral Bank council</h2><div data-bank-council></div><form data-bank-rate hidden><label>Proposed annual rate · %<input type="number" min="0" max="100" step="0.01" value="5" required data-bank-apr></label><button class="button wide" type="submit">Propose annual rate</button></form><p>Server-appointed councillors approve rates by strict majority. New rates affect new stakes only.</p></section>
        <section class="exchange-card bank-funding"><h2>Reward treasury</h2><p>Interest comes only from donated existing FTH$. No currency is issued and principal is never used to pay rewards.</p><form data-bank-fund><label>Donation · FTH$<input type="number" min="0.0001" step="0.0001" inputmode="decimal" required data-bank-funding></label><button class="button wide" type="submit">Fund rewards</button></form><p>Donations cannot be withdrawn. They fund future staking rewards.</p></section>
        <div class="bank-conversion" data-bank-conversion></div></div>`;
    localize(root);
    new GoldTrading(root.querySelector<HTMLElement>('[data-bank-conversion]')!, state, update, notify, language);
    root.querySelector('[data-bank-quantity]')!.addEventListener('input', () => { this.quoteFresh = false; this.paint(); void this.refresh(); });
    root.querySelector('[data-bank-refresh]')!.addEventListener('click', () => { void this.refresh(); });
    root.querySelector('[data-bank-stake]')!.addEventListener('submit', event => {
      event.preventDefault();
      const quote = this.data?.bank.quote;
      if (!quote?.available || !this.quoteFresh || this.pending) return;
      void this.execute({ type: 'stake', quantity: quote.principal, years: quote.years, rateRevision: quote.rateRevision,
        valuationDollars: dollarsUnits(quote.valuationDollars), interestDollars: dollarsUnits(quote.interestDollars) },
      { title: 'Review staking', subject: 'Featheral Bank', costs: [{ asset: 'fthg', amount: quote.principal }],
        receives: [{ asset: 'fthg', amount: quote.principal }, { asset: 'dollars', amount: quote.interestDollars }],
        weeks: quote.years * 52, receiveLabel: 'At maturity', notes: [
          `${this.t('Council annual rate')}: ${this.money(this.data!.bank.council.aprBps! / 100)}%`,
          'Annual rate applies per game year (52 weeks).',
          `${this.t('Deposit valuation')}: FTH$ ${this.money(quote.valuationDollars)}`,
          `${this.t('Real-time lock duration')}: ${this.realDuration(stakingRealMs(quote.years, this.state().clockSpeed))}`,
          'Principal cannot be withdrawn early. The entire interest payment is reserved before your stake is accepted.',
          'Simple interest uses the exchange value at deposit. No compounding.'] });
    });
    root.querySelector('[data-bank-fund]')!.addEventListener('submit', event => {
      event.preventDefault();
      const amount = Number(root.querySelector<HTMLInputElement>('[data-bank-funding]')!.value);
      void this.execute({ type: 'fund', dollars: amount }, { title: 'Fund rewards', subject: 'Featheral Bank',
        costs: [{ asset: 'dollars', amount }], weeks: 0, notes: ['Donations cannot be withdrawn. They fund future staking rewards.'] });
    });
    root.querySelector('[data-bank-rate]')!.addEventListener('submit', event => {
      event.preventDefault();
      const aprBps = Math.round(Number(root.querySelector<HTMLInputElement>('[data-bank-apr]')!.value) * 100);
      void this.execute({ type: 'propose-rate', aprBps }, { title: 'Propose annual rate', subject: `${this.money(aprBps / 100)}%`,
        costs: [], weeks: 0, notes: ['Server-appointed councillors approve rates by strict majority. New rates affect new stakes only.'] });
    });
    root.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || button.disabled) return;
      const years = Number(button.dataset.bankYears);
      if (isStakingYears(years)) { this.years = years; this.quoteFresh = false; this.paint(); void this.refresh(); }
      if (button.dataset.bankClaim) {
        const position = this.data?.bank.positions.find(p => p.id === Number(button.dataset.bankClaim));
        if (position) void this.execute({ type: 'claim-stake', positionId: position.id }, { title: 'Receive staking payout', subject: 'Featheral Bank', costs: [], weeks: 0, notes: [],
          receives: [{ asset: 'fthg', amount: position.principal }, { asset: 'dollars', amount: position.interestDollars }] });
      }
      if (button.dataset.bankVote && this.data?.bank.proposal) void this.execute(
        { type: 'vote-rate', proposalId: this.data.bank.proposal.id, approve: button.dataset.bankVote === 'approve' },
        { title: button.dataset.bankVote === 'approve' ? 'Approve rate' : 'Reject rate', subject: `${this.money(this.data.bank.proposal.aprBps / 100)}%`, costs: [], weeks: 0, notes: [] });
    });
    this.paint(); void this.refresh();
    setInterval(() => { if (!document.hidden && !this.pending && !confirmationOpen()) void this.refresh(); }, 5000);
  }
  private money(amount: number): string { return formatDollars(amount, locale(this.language)); }
  private realDuration(milliseconds: number): string {
    const minutes = Math.ceil(Math.max(0, milliseconds) / 60000);
    const parts: [number, 'day' | 'hour' | 'minute'][] = [[Math.floor(minutes / 1440), 'day'], [Math.floor(minutes % 1440 / 60), 'hour'], [minutes % 60, 'minute']];
    return parts.filter(([amount]) => amount > 0 || minutes === 0).map(([amount, unit]) =>
      new Intl.NumberFormat(locale(this.language), { style: 'unit', unit, unitDisplay: 'narrow' }).format(amount)).join(' ');
  }
  private quantity(): number { return Number(this.root.querySelector<HTMLInputElement>('[data-bank-quantity]')!.value); }
  private paint(): void {
    const bank = this.data?.bank, speed = this.state().clockSpeed;
    this.root.querySelector('[data-bank-terms]')!.innerHTML = stakingYears.map(years =>
      `<button class="button" type="button" data-bank-years="${years}" aria-pressed="${years === this.years}" ${this.pending ? 'disabled' : ''}><strong>${this.t(`${years} game ${years === 1 ? 'year' : 'years'}`)}</strong><small>${this.t('Real-time lock duration')}: ${this.realDuration(stakingRealMs(years, speed))}</small></button>`).join('');
    this.root.querySelector('[data-bank-summary]')!.innerHTML = [
      ['Available FTHG', this.money(this.state().fthg)], ['Featheral Dollar', `FTH$ ${this.money(this.state().dollars)}`],
      ['Council annual rate', bank?.council.aprBps == null ? this.t('Not approved') : `${this.money(bank.council.aprBps / 100)}%`],
      ['Unreserved rewards', bank ? `FTH$ ${this.money(bank.treasury.available)}` : '—'],
    ].map(([label, value]) => `<div><small>${this.t(label)}</small><strong>${value}</strong></div>`).join('');
    const quote = this.quoteFresh ? bank?.quote : null;
    this.root.querySelector('[data-bank-quote]')!.innerHTML = [
      ['Deposit valuation', quote ? `FTH$ ${this.money(quote.valuationDollars)}` : '—'],
      ['Fixed interest at maturity', quote ? `FTH$ ${this.money(quote.interestDollars)}` : '—'],
      ['Real-time lock duration', this.realDuration(stakingRealMs(this.years, speed))],
    ].map(([label, value]) => `<div><dt>${this.t(label)}</dt><dd>${value}</dd></div>`).join('');
    this.root.querySelector<HTMLButtonElement>('[data-bank-submit]')!.disabled = this.pending || !quote?.available;
    this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.bank-staking input,.bank-funding input,.bank-council input,[data-bank-refresh],.bank-funding button,.bank-council form button').forEach(e => { e.disabled = this.pending; });
    this.root.querySelector('[data-bank-status]')!.textContent = this.t(this.pending ? 'Saving...' : quote?.reason ?? (!this.quoteFresh ? 'Loading bank...' : ''));
    this.root.querySelector('[data-bank-positions]')!.innerHTML = !bank ? '' : !bank.positions.length ? `<p>${this.t('No staking positions yet.')}</p>` : bank.positions.map(p => {
      const ready = p.readyAt <= this.data!.serverTime, remaining = Math.max(0, p.readyAt - this.data!.serverTime) / speed;
      const date = new Date(Date.now() + remaining).toLocaleString(locale(this.language), { dateStyle: 'medium', timeStyle: 'short' });
      return `<article class="bank-position"><header><strong>${this.money(p.principal)} FTHG</strong><span>${this.money(p.aprBps / 100)}% · ${this.t(`${p.years} game ${p.years === 1 ? 'year' : 'years'}`)}</span></header>
        <p>${this.t('Reserved interest')}: FTH$ ${this.money(p.interestDollars)}</p>
        ${p.status === 'claimed' ? `<small>${this.t('Paid out')}</small>` : `<p>${this.t(ready ? 'Ready to receive' : 'Estimated real-time maturity')}${ready ? '' : `: ${date}`}</p>
          ${ready ? '' : `<small>${this.realDuration(remaining)} ${this.t('remaining')}</small>`}
          <button class="button wide" type="button" data-bank-claim="${p.id}" ${this.pending || !ready ? 'disabled' : ''}>${this.t('Receive staking payout')}</button>`}</article>`;
    }).join('');
    this.root.querySelector<HTMLFormElement>('[data-bank-rate]')!.hidden = !bank?.council.member || !!bank.proposal;
    const council = this.root.querySelector('[data-bank-council]')!;
    council.innerHTML = bank ? `<p>${this.t('Appointed councillors')}: ${bank.council.members} · ${this.t(bank.council.member ? 'You are a councillor.' : 'You are not a councillor.')}</p>
      <p>${this.t('Reserved rewards')}: FTH$ ${this.money(bank.treasury.reserved)}</p>
      ${bank.proposal ? `<div class="bank-proposal"><strong>${this.money(bank.proposal.aprBps / 100)}%</strong><p>${this.t('Approvals')}: ${bank.proposal.approvals} / ${Math.floor(bank.council.members / 2) + 1} · ${this.t('Rejections')}: ${bank.proposal.rejections}</p>
        ${bank.council.member && !bank.proposal.vote ? `<div class="bank-votes"><button class="button" data-bank-vote="approve" ${this.pending ? 'disabled' : ''}>${this.t('Approve rate')}</button><button class="button" data-bank-vote="reject" ${this.pending ? 'disabled' : ''}>${this.t('Reject rate')}</button></div>` : ''}</div>` : `<p>${this.t('No pending rate proposal.')}</p>`}` : '';
  }
  private async refresh(): Promise<void> {
    if (this.pending) return;
    const sequence = ++this.sequence, quantity = this.quantity(), years = this.years;
    const input = this.root.querySelector<HTMLInputElement>('[data-bank-quantity]')!;
    if (!input.validity.valid) { this.quoteFresh = false; this.paint(); this.root.querySelector('[data-bank-status]')!.textContent = this.t('Enter an amount with up to four decimal places.'); return; }
    try {
      const data = await readBank(quantity, years);
      if (sequence !== this.sequence || quantity !== this.quantity() || years !== this.years) return;
      if (data.revision < this.state().revision) throw new Error('World changed. Refresh and retry.');
      this.data = data; this.quoteFresh = true; this.update(data); this.paint();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.quoteFresh = false; this.paint();
      this.root.querySelector('[data-bank-status]')!.textContent = this.t(error instanceof Error ? error.message : 'Connection failed.');
    }
  }
  private async execute(command: BankCommand, quote: ConsumptionQuote): Promise<void> {
    if (this.pending || confirmationOpen()) return;
    this.pending = true; this.sequence++; this.paint();
    try {
      if (!await confirmConsumption(quote, this.language)) return;
      const next = await sendBank(this.state(), command);
      this.data = next; this.update(next); this.notify(next.message);
    } catch (error) { this.notify(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.pending = false; this.quoteFresh = false; this.paint(); await this.refresh(); }
  }
}
