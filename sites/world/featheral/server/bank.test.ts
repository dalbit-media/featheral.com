import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';
import { fundFixtureFromReserves } from './test-support.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldYearMs } from '../src/environment.ts';
import { stakingInterest } from './bank.ts';
import { stakingRealMs, stakingYears } from '../src/bank.ts';
import type { BankCommand, StakingYears } from '../src/bank.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'featheral-bank-')), path = join(directory, 'bank.sqlite');
  let time = 1000000;
  const store = new SqliteStore(path, () => time);
  const people = Array.from({ length: 4 }, () => store.create());
  const owners = people.map(person => store.transaction(person.token, (_s, _n, _r, _e, owner) => owner));
  fundFixtureFromReserves(path, 100000);
  const db = new DatabaseSync(path);
  const previous = store.read(people[0].token, s => s.account.fthg);
  db.prepare('UPDATE gold_pool SET gold=gold-? WHERE id=1').run(200 * dollarsScale - previous);
  db.close();
  store.transaction(people[0].token, session => {
    session.account.game.dollars = 100000 * dollarsScale;
    session.account.fthg = 200 * dollarsScale;
  });
  for (const person of people) store.transaction(person.token, s => { s.account.game.stage = 0; s.account.game.population = 0; });
  const read = (index = 0, quantity = 10, years: StakingYears = 1) =>
    store.transaction(people[index].token, (s, _n, _r, _e, owner, bank) => bank.read(owner, s.account, quantity, years));
  const perform = (index: number, command: BankCommand, id = randomUUID()) => {
    time += 1000;
    return store.transaction(people[index].token, (s, n, r, _e, owner, bank) =>
      bank.apply(owner, s.account, { id, revision: s.account.revision, command }, n, r));
  };
  const council = (indices: number[]) => store.transaction(people[0].token, (_s, _n, _r, _e, _o, bank) => bank.configureCouncil(indices.map(i => owners[i])));
  const stake = (years: StakingYears) => {
    const q = read(0, 10, years).quote;
    return perform(0, { type: 'stake', quantity: 10, years, rateRevision: q.rateRevision,
      valuationDollars: Math.round(q.valuationDollars * dollarsScale), interestDollars: Math.round(q.interestDollars * dollarsScale) });
  };
  return { store, path, people, read, perform, council, stake,
    setTime: (next: number) => { time = next; },
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('all six lock periods use exact simple interest and the production/development real clock', () => {
  assert.deepEqual(stakingYears, [1, 2, 5, 10, 20, 30]);
  for (const years of stakingYears) {
    assert.equal(stakingRealMs(years, 1), years * 52 * 7 * 24 * 60000);
    assert.equal(stakingRealMs(years, 20), stakingRealMs(years, 1) / 20);
    assert.equal(stakingRealMs(years, 10), stakingRealMs(years, 1) / 10);
    const result = stakingInterest(12345, { gold: 70000, dollars: 9123456 }, 525, years);
    assert.equal(result.valuation, Number(12345n * 9123456n / 70000n));
    assert.equal(result.interest, Number(BigInt(result.valuation) * 525n * BigInt(years) / 10000n));
  }
});
test('appointed council votes need a strict majority, cannot be duplicated and never let outsiders change rates', () => {
  const f = fixture();
  try {
    f.council([0, 1, 2]);
    assert.throws(() => f.perform(3, { type: 'propose-rate', aprBps: 500 }), /Only appointed/);
    const pending = f.perform(0, { type: 'propose-rate', aprBps: 525 }).bank;
    assert.equal(pending.council.aprBps, null);
    assert.equal(pending.proposal?.approvals, 1);
    assert.throws(() => f.perform(0, { type: 'vote-rate', proposalId: pending.proposal!.id, approve: true }), /already recorded/);
    f.perform(1, { type: 'vote-rate', proposalId: pending.proposal!.id, approve: true });
    assert.equal(f.read().council.aprBps, 525);
    assert.equal(f.read().proposal, null);
    const next = f.perform(0, { type: 'propose-rate', aprBps: 900 }).bank.proposal!;
    f.perform(1, { type: 'vote-rate', proposalId: next.id, approve: false });
    f.perform(2, { type: 'vote-rate', proposalId: next.id, approve: false });
    assert.equal(f.read().council.aprBps, 525);
    assert.equal(f.read().proposal, null);
    f.perform(0, { type: 'propose-rate', aprBps: 800 });
    f.council([0]);
    assert.equal(f.read().proposal, null);
    assert.equal(f.read().council.aprBps, 525);
  } finally { f.close(); }
});
test('staking reserves every term up front, preserves both supplies, returns principal only at maturity and fixes old rates', () => {
  const f = fixture();
  try {
    f.council([0]);
    f.perform(0, { type: 'propose-rate', aprBps: 525 });
    const before = f.store.publicTotals();
    assert.equal(f.read().quote.available, false);
    assert.match(f.read().quote.reason!, /treasury/);
    const unfunded = f.read();
    assert.throws(() => f.stake(1), /treasury/);
    assert.deepEqual(f.read(), unfunded);
    f.perform(0, { type: 'fund', dollars: 100000 });
    assert.equal(f.store.publicTotals().dollars, before.dollars);
    const positions = stakingYears.map(years => f.stake(years).bank.positions[0]);
    assert.equal(f.store.publicTotals().fthg, before.fthg);
    assert.equal(f.store.publicTotals().dollars, before.dollars);
    assert.equal(f.read().positions.length, 6);
    assert.equal(f.read().treasury.reserved, positions.reduce((sum, p) => sum + Math.round(p.interestDollars * dollarsScale), 0) / dollarsScale);
    f.perform(0, { type: 'propose-rate', aprBps: 1000 });
    assert.ok(f.read().positions.every(position => position.aprBps === 525));
    const position = positions[0], wallet = f.store.read(f.people[0].token, s => ({ gold: s.account.fthg, dollars: s.account.game.dollars }));
    f.setTime(position.readyAt - 1001);
    assert.throws(() => f.perform(0, { type: 'claim-stake', positionId: position.id }), /before maturity/);
    f.setTime(position.readyAt - 1000);
    const result = f.perform(0, { type: 'claim-stake', positionId: position.id });
    assert.equal(result.fthg * dollarsScale, wallet.gold + 10 * dollarsScale);
    assert.equal(Math.round(result.dollars * dollarsScale), wallet.dollars + Math.round(position.interestDollars * dollarsScale));
    assert.throws(() => f.perform(0, { type: 'claim-stake', positionId: position.id }), /not available/);
    assert.equal(f.store.publicTotals().fthg, before.fthg);
    assert.equal(f.store.publicTotals().dollars, before.dollars);
    const reopened = new SqliteStore(f.path, () => position.readyAt + 10000);
    try { assert.equal(reopened.publicTotals().dollars, before.dollars); assert.equal(reopened.publicTotals().fthg, before.fthg); }
    finally { reopened.close(); }
  } finally { f.close(); }
});
test('stale quotes, insufficient treasury and foreign claims roll back; action receipts replay without another payment', () => {
  const f = fixture();
  try {
    f.council([0]); f.perform(0, { type: 'propose-rate', aprBps: 500 });
    f.perform(0, { type: 'fund', dollars: 100000 });
    const q = f.read().quote, revision = f.store.read(f.people[0].token, s => s.account.revision);
    const command: BankCommand = { type: 'stake', quantity: 10, years: 1, rateRevision: q.rateRevision,
      valuationDollars: Math.round(q.valuationDollars * dollarsScale), interestDollars: Math.round(q.interestDollars * dollarsScale) };
    const before = f.read();
    assert.throws(() => f.perform(0, { ...command, interestDollars: command.interestDollars + 1 }), /quote changed/);
    assert.deepEqual(f.read(), before);
    assert.equal(f.store.read(f.people[0].token, s => s.account.revision), revision);
    const id = randomUUID(), saved = f.perform(0, command, id), balances = f.store.publicTotals();
    const replay = f.store.transaction(f.people[0].token, (s, n, r, _e, owner, bank) =>
      bank.apply(owner, s.account, { id, revision, command }, n, r));
    assert.deepEqual(replay, saved);
    assert.deepEqual(f.store.publicTotals(), balances);
    assert.throws(() => f.perform(3, { type: 'claim-stake', positionId: saved.bank.positions[0].id }), /not available/);
    f.perform(0, { type: 'propose-rate', aprBps: 10000 });
    const expensive = f.read(0, 10, 30).quote;
    assert.equal(expensive.available, false);
    assert.match(expensive.reason!, /treasury/);
    assert.throws(() => f.perform(0, { ...command, rateRevision: q.rateRevision }), /quote changed/);
  } finally { f.close(); }
});
test('long-lived bank positions and councils survive normal expired-session cleanup and server reopen', () => {
  const f = fixture();
  try {
    f.council([0]); f.perform(0, { type: 'propose-rate', aprBps: 100 });
    f.perform(0, { type: 'fund', dollars: 100000 });
    const position = f.stake(30).bank.positions[0];
    assert.ok(f.store.read(f.people[0].token, s => s.expires) > position.readyAt);
    f.setTime(1000000 + 40 * 86400000);
    f.store.create();
    assert.equal(f.read().positions[0].id, position.id);
    const reopened = new SqliteStore(f.path, () => 1000000 + 40 * 86400000);
    try {
      assert.equal(reopened.read(f.people[0].token, s => s.account.fthg), 190 * dollarsScale);
      assert.equal(reopened.transaction(f.people[0].token, (s, _n, _r, _e, owner, bank) => bank.read(owner, s.account, 1, 1)).positions[0].id, position.id);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
test('a changed Gold exchange valuation cannot silently change a reviewed stake', () => {
  const f = fixture();
  try {
    f.council([0]); f.perform(0, { type: 'propose-rate', aprBps: 500 });
    f.perform(0, { type: 'fund', dollars: 100000 });
    const q = f.read().quote;
    f.setTime(1010000);
    f.store.transaction(f.people[0].token, (s, n, r, exchange, owner) => exchange.gold.apply(owner, s.account, {
      id: randomUUID(), revision: s.account.revision, command: { type: 'gold', side: 'sell', quantity: 1, limitDollars: 1 },
    }, n, r));
    assert.notEqual(f.read().quote.valuationDollars, q.valuationDollars);
    assert.throws(() => f.perform(0, { type: 'stake', quantity: 10, years: 1, rateRevision: q.rateRevision,
      valuationDollars: Math.round(q.valuationDollars * dollarsScale), interestDollars: Math.round(q.interestDollars * dollarsScale) }), /quote changed/);
    assert.equal(f.read().positions.length, 0);
  } finally { f.close(); }
});
test('bank HTTP endpoints validate identity, CSRF, origin, query and command fields and renew only bank cookies', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:5173';
  const server = createApi(f.store, origin); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, cookie = `terra-dev=${f.people[0].token}`;
  try {
    assert.equal((await fetch(`${base}/api/bank`)).status, 401);
    for (const query of ['years=3', 'years=0', 'quantity=0', 'quantity=NaN', 'years=1&years=2', 'extra=1']) {
      assert.equal((await fetch(`${base}/api/bank?${query}`, { headers: { Cookie: cookie } })).status, 400, query);
    }
    f.council([0]);
    const response = await fetch(`${base}/api/bank?quantity=10&years=30`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000/);
    const state = await response.json();
    const post = (command: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/bank/actions`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...headers },
      body: JSON.stringify({ id: randomUUID(), revision: state.revision, command }),
    });
    assert.equal((await post({ type: 'fund', dollars: 1 }, { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post({ type: 'fund', dollars: 1 }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ type: 'fund', dollars: 1, extra: true })).status, 400);
    f.setTime(1005000);
    const funded = await post({ type: 'fund', dollars: 1 });
    assert.equal(funded.status, 200);
    assert.equal((await funded.json()).bank.treasury.available, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
