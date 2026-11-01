import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatDollars, dollarsUnits, dollarsSlippage } from '../src/dollars.ts';
import { formatFthg } from '../src/fthg.ts';
import { walletLinkMessage } from '../src/funds.ts';

test('FTH$ displays at most two decimals without reducing input or slippage precision', () => {
  for (const language of ['en-US', 'ko-KR']) {
    for (const [amount, text] of [[0, '0'], [1000, '1,000'], [1.2, '1.2'], [1.2345, '1.23'], [1.2356, '1.24'], [.0001, '0']] as const)
      assert.equal(formatDollars(amount, language), text);
    assert.equal(formatFthg(1.2345, language), '1.2345');
  }
  assert.equal(dollarsUnits(1.2345), 12345);
  assert.equal(dollarsSlippage(1.2345, 'buy'), 1.2591);
});
test('gameplay wallet authorization binds the wallet, browser session and exact origin', () => {
  const message = walletLinkMessage('0xABC', 'nonce', '2026-01-01T00:00:00.000Z', 'https://world.example.com');
  assert.match(message, /Wallet: 0xabc/);
  assert.match(message, /Session: nonce/);
  assert.match(message, /Origin: https:\/\/world.example.com/);
  assert.match(message, /spend this wallet's FTH\$/);
});
