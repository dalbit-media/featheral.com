import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import sqlite from '../../../../services/database/sqlite.js';
import { GameFunds } from './funds.ts';
import { formatDollars, dollarsUnits, dollarsSlippage } from '../src/dollars.ts';
import { formatFthg } from '../src/fthg.ts';
import { walletLinkMessage } from '../src/funds.ts';

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
