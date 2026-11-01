import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { maximumWithdrawal, walletAddress, walletChain, withdrawalError } from './account-model.ts';
import { journalEntries } from './journal.ts';
import { guideContent } from './guide.ts';
import { translate } from './i18n.ts';

test('World profile actions retain English defaults and localized Korean guidance', () => {
  assert.equal(translate('Use World profile in Play'), 'Use World profile in Play');
  assert.equal(translate('World profile', 'ko'), '월드 프로필');
  assert.equal(translate('Use World profile in Play', 'ko'), '플레이에서 월드 프로필 사용');
  assert.notEqual(translate('Use your World profile in the avatar menu to join chat.', 'ko'), 'Use your World profile in the avatar menu to join chat.');
});

test('eligible withdrawals floor available four-decimal FTHG to exact 1,000 multiples', () => {
  for (const [balance, expected] of [[0, 0], [.0001, 0], [999.9999, 0], [1000, 1000], [1000.0001, 1000], [1999.9999, 1000], [2000, 2000], [12345.6789, 12000]]) {
    assert.equal(maximumWithdrawal(balance), expected);
  }
  assert.equal(withdrawalError('1000', 1000), null);
  assert.equal(withdrawalError('1000.0000', 1000), null);
  assert.equal(withdrawalError('2000', 2000.0001), null);
  assert.equal(withdrawalError('2000', 1999.9999), 'Not enough available FTHG.');
  assert.equal(withdrawalError('1000', 999.9999), 'Not enough available FTHG.');
  for (const value of ['', ' ', '0', '-1000', '999', '1001', '1500', '1000.0001', '1000.00000000000001', '1e3', 'NaN', 'Infinity', '9007199254740992']) {
    assert.equal(withdrawalError(value, 100000), 'Enter a positive multiple of 1,000 FTHG.', value);
  }
});
test('browser wallet responses and network changes are validated, including disconnects', () => {
  const address = `0x${'1'.repeat(40)}`;
  assert.equal(walletAddress([address]), address);
  assert.equal(walletAddress([]), null);
  for (const bad of [null, {}, address, ['0x123'], [address, 42]]) assert.throws(() => walletAddress(bad), /invalid address/);
  assert.equal(walletChain('0x1'), '0x1');
  assert.equal(walletChain('0x2105'), '0x2105');
  for (const bad of [null, 1, '1', '0x0', '0x', '0xzz', '0x-1']) assert.throws(() => walletChain(bad), /invalid network/);
});
test('the account pane has accessible modal controls, settings and explicitly unavailable payouts', () => {
  const pane = readFileSync(new URL('./account.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const market = readFileSync(new URL('./marketplace.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./account.css', import.meta.url), 'utf8');
  assert.match(pane, /this\.dialog\.showModal\(\)/);
  assert.match(pane, /event\.key === 'Escape'/);
  assert.match(pane, /this\.trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(pane, /wireLanguageControls\(this\.dialog\)/);
  assert.doesNotMatch(pane, /data-account-nickname|Save nickname|connectWallet\(/);
  assert.match(pane, /window\.FeatheralProfile\.mount/);
  assert.match(pane, /panelRoot: this\.dialog/);
  assert.match(pane, /worldProfileLinkMessage\(world\.account, csrf, issuedAt\)/);
  assert.match(pane, /linkWorldProfile\(csrf, \{ address: world\.account, issuedAt, signature \}\)/);
  assert.match(pane, /window\.dispatchEvent\(new Event\(chatProfileChangedEvent\)\)/);
  assert.match(pane, /querySelector\('\[data-withdrawal-form\]'\)/);
  assert.match(pane, /data-withdrawal-amount aria-describedby="withdrawal-rule withdrawal-error"/);
  assert.match(pane, /type="submit" class="button wide" disabled>Withdrawals unavailable/);
  assert.match(pane, /personal_sign/);
  assert.doesNotMatch(pane, /eth_sendTransaction|eth_sign|fetch\(|send\(/);
  assert.match(main, /account\.updateBalance\(state\.fthg, languageLocale\)/);
  assert.match(main, /if \(account\.isOpen\) return;/);
  assert.doesNotMatch(main, /reward-total|reward-top|profile-avatar/);
  assert.doesNotMatch(main, /class="map-guide"/);
  assert.doesNotMatch(market, /data-market-wallet/);
  assert.match(css, /grid-template-rows:48px 64px 48px/);
  assert.match(css, /\.topbar \.population-bar\.resource-bar\{position:static;grid-column:1\/3;grid-row:3/);
  assert.match(css, /\.resource-summary\{min-height:44px/);
});
test('Activity and Help are account subviews using shared content without changing game routes', () => {
  const pane = readFileSync(new URL('./account.ts', import.meta.url), 'utf8');
  assert.match(pane, /type="button" data-account-view="\$\{key\}"/);
  assert.match(pane, /class="button account-back" aria-label="Back to account"/);
  assert.match(pane, /guideContent\(this\.language, true\)/);
  assert.match(pane, /wireGuide\(help, this\.language, true\)/);
  assert.match(pane, /renderJournalEntries\(/);
  assert.match(pane, /downloadSnapshot\(this\.snapshot\(\)/);
  assert.doesNotMatch(pane, /href="\$\{gamePages\[key\]\.path\}"/);
  const embedded = guideContent('ko', true);
  assert.match(embedded, /id="account-guide-search"/);
  assert.match(embedded, /href="#account-guide-explore"/);
  assert.doesNotMatch(embedded, /id="guide-/);
  assert.deepEqual(journalEntries(['Explore', 'Recruiting'], ' 탐험 ', 'ko'), ['Explore']);
  assert.deepEqual(journalEntries(['Explore', 'Recruiting'], 'RECRUIT', 'en'), ['Recruiting']);
  assert.deepEqual(journalEntries(['Explore'], 'missing', 'en'), []);
});
test('bank conversion lives on its dedicated route and the account FTHG card links to it', () => {
  const account = readFileSync(new URL('./account.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const bank = readFileSync(new URL('./bank-view.ts', import.meta.url), 'utf8');
  assert.match(account, /class="account-balance account-gold"/);
  assert.match(account, /href="\/play\/bank\/" data-account-bank/);
  assert.doesNotMatch(account, /\/play\/market\/#gold/);
  assert.match(account, /section class="account-section account-wallet-section"[^>]*aria-labelledby="account-wallet-title"/);
  assert.match(account, /data-world-profile-button/);
  assert.doesNotMatch(account, /details class="account-section account-wallet-section"/);
  assert.ok(account.indexOf('class="account-wallet-section"') < account.indexOf('class="account-balances"'));
  assert.match(main, /if \(bankPage\) new BankPage/);
  assert.doesNotMatch(main, /if \(marketPage\) new GoldTrading/);
  assert.match(bank, /new GoldTrading/);
  assert.match(bank, /quoteFresh/);
});
