import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import sqlite from '../../../../services/database/sqlite.js';
import { GameFunds } from './funds.ts';
import { formatDollars, dollarsUnits, dollarsSlippage } from '../src/dollars.ts';
import { formatFthg } from '../src/fthg.ts';
import { needsWalletSigner, walletLinkMessage } from '../src/funds.ts';
import { SqliteStore } from './store.ts';
import { gameFundAccount, walletFundAccount } from './funds.ts';
import type { DollarFunds, FundPayment, FundTransaction } from './funds.ts';
import { createHash } from 'node:crypto';
import { Wallet, parseUnits, verifyMessage } from 'ethers';
import { transferMessage } from '../../../../services/fth-ledger/transfer.js';

test('only legacy direct-wallet sessions require a connected signer for gameplay', () => {
  assert.equal(needsWalletSigner({ fundWallet: null }), false);
  assert.equal(needsWalletSigner({ fundWallet: '0xabc', fundMode: 'separate' }), false);
  assert.equal(needsWalletSigner({ fundWallet: '0xabc', fundMode: 'legacy-direct' }), true);
  assert.equal(needsWalletSigner({ fundWallet: '0xabc' }), true);
});

test('separate World and wallet views reconcile deposits, withdrawals and exact-once retries without moving funds on authorization', async () => {
  const wallet = Wallet.createRandom(), address = wallet.address.toLowerCase();
  const balances = new Map<string, bigint>([[walletFundAccount(address), parseUnits('100', 18)]]);
  const committed = new Set<string>(), paid = new Set<string>();
  let nonce = 0, nextId = 0;
  const available = (id: string) => balances.get(id) ?? 0n;
  const ledger: DollarFunds = {
    available: id => available(id).toString(), supply: () => parseUnits('100', 18).toString(),
    prepare: entries => ({ i: `fixture-${++nextId}`, k: 'GAME', a: '', v: '0', d: { entries, signature: 'test' }, t: Date.now() }),
    commit: (transaction: FundTransaction) => {
      if (committed.has(transaction.i)) return;
      assert.equal(transaction.d.entries.reduce((total, entry) => total + BigInt(entry.delta), 0n), 0n);
      for (const entry of transaction.d.entries) {
        const next = available(entry.account) + BigInt(entry.delta);
        assert.ok(next >= 0n); balances.set(entry.account, next);
      }
      committed.add(transaction.i);
    },
    nonce: () => nonce,
    depositMessage: (payment: FundPayment) => transferMessage(payment),
    depositState: payment => paid.has(payment.memo) ? 'accepted' : payment.nonce <= nonce ? 'conflict' : 'missing',
    transfer: async payment => {
      assert.equal(verifyMessage(transferMessage(payment), payment.signature).toLowerCase(), address);
      if (paid.has(payment.memo)) return;
      assert.equal(payment.nonce, nonce + 1);
      const amount = BigInt(payment.amount), source = walletFundAccount(payment.wallet);
      assert.ok(available(source) >= amount);
      balances.set(source, available(source) - amount); balances.set(payment.to, available(payment.to) + amount);
      paid.add(payment.memo); nonce = payment.nonce;
    },
  };
  const store = new SqliteStore(':memory:', Date.now, 1, ledger);
  try {
    const { token, csrf } = store.create();
    store.linkWallet(token, address, false, true);
    const accountId = gameFundAccount('guest', createHash('sha256').update(token).digest('hex'));
    assert.deepEqual(store.walletContext(token), { fundWallet: address, fundMode: 'separate', fundAccountId: accountId });
    assert.equal(store.fundView(token).available, '0');
    assert.equal(store.fundView(token).walletAvailable, parseUnits('100', 18).toString());
    const deposit = store.prepareFund(token, { id: 'deposit-shared-budget-1', direction: 'deposit', amount: parseUnits('25', 18).toString() }, 'https://world.featheral.com');
    const signature = await wallet.signMessage(deposit.message);
    await store.completeFund(token, deposit.id, signature);
    await store.completeFund(token, deposit.id, signature);
    assert.equal(store.walletView(token).available, parseUnits('25', 18).toString());
    assert.equal(store.walletWorldView(address)!.available, store.fundView(token).available);
    assert.equal(store.fundView(token).walletAvailable, parseUnits('75', 18).toString());
    assert.equal(store.read(token, session => session.account.game.dollars), 250000);
    const withdrawal = store.prepareFund(token, { id: 'withdraw-shared-budget-1', direction: 'withdraw', amount: parseUnits('10', 18).toString() }, 'https://world.featheral.com');
    assert.match(withdrawal.message, new RegExp(`Session: ${csrf}`));
    const wrong = Wallet.createRandom();
    await assert.rejects(store.completeFund(token, withdrawal.id, await wrong.signMessage(withdrawal.message)), /authorized wallet/);
    const approval = await wallet.signMessage(withdrawal.message);
    await store.completeFund(token, withdrawal.id, approval);
    await store.completeFund(token, withdrawal.id, approval);
    assert.equal(store.walletView(token).available, parseUnits('15', 18).toString());
    assert.equal(store.fundView(token).walletAvailable, parseUnits('85', 18).toString());
    assert.equal([...balances.values()].reduce((sum, value) => sum + value, 0n), parseUnits('100', 18));
  } finally { store.close(); }
});

function legacyFundDatabase() {
  const db = sqlite.open(':memory:');
  db.exec(`CREATE TABLE world_fund_requests (
    owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,payment TEXT,message TEXT NOT NULL,
    status TEXT NOT NULL,error TEXT,at INTEGER NOT NULL,signature TEXT,PRIMARY KEY(owner,id))`);
  return db;
}

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

test('legacy completed World fund history migrates without losing authorization metadata', () => {
  const db = legacyFundDatabase();
  try {
    const owner = 'a'.repeat(64), id = 'legacy-withdraw-identifier';
    const wallet = `0x${'1'.repeat(40)}`, account = `0x${'2'.repeat(64)}`, at = 123456789;
    const message = `Featheral World fund withdrawal\n\nWallet: ${wallet}\nWorld account: ${account}\nAmount: 100 FTH$ base units\nRequest: ${id}\nOrigin: https://world.example.com\n\nMove authorized funds.`;
    db.prepare('INSERT INTO world_fund_requests VALUES(?,?,?,?,?,?,?,?,?)')
      .run(owner, id, JSON.stringify({ direction: 'withdraw', amount: '100' }), null, message, 'complete', null, at, null);
    const ledger = { available: () => '0', supply: () => '0',
      prepare: () => ({ i: 'fixture', k: 'transfer', a: 'fixture', v: '0', d: { entries: [], signature: 'fixture' }, t: 0 }),
      commit: () => {} };
    new GameFunds(db, ledger);
    const columns = db.prepare('PRAGMA table_info(world_fund_requests)').all().map(row => row.name);
    assert.deepEqual(columns, ['owner', 'id', 'data']);
    const stored = JSON.parse(String(db.prepare('SELECT data FROM world_fund_requests WHERE owner=? AND id=?').get(owner, id)?.data));
    assert.deepEqual(stored, {
      id, parameters: { direction: 'withdraw', amount: '100' }, origin: 'https://world.example.com',
      accountId: account, wallet, message, status: 'complete', at,
    });
  } finally { db.close(); }
});

test('ambiguous paying legacy World fund requests block migration without changing their schema or rows', () => {
  const db = legacyFundDatabase();
  try {
    db.prepare('INSERT INTO world_fund_requests VALUES(?,?,?,?,?,?,?,?,?)')
      .run('b'.repeat(64), 'legacy-paying-identifier', JSON.stringify({ direction: 'withdraw', amount: '100' }),
        null, 'unfinished transfer', 'paying', null, 123, null);
    const ledger = { available: () => '0', supply: () => '0',
      prepare: () => ({ i: 'fixture', k: 'transfer', a: 'fixture', v: '0', d: { entries: [], signature: 'fixture' }, t: 0 }),
      commit: () => {} };
    assert.throws(() => new GameFunds(db, ledger),
      /cannot be safely resumed automatically/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM world_fund_requests').get()?.count, 1);
    assert.ok(db.prepare('PRAGMA table_info(world_fund_requests)').all().some(row => row.name === 'payload'));
  } finally { db.close(); }
});
