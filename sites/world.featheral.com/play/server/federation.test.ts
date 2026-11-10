import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './store.ts';
import { apply, parseCommand } from './economy.ts';
import { createApi } from './http.ts';
import { gameFundAccount } from './funds.ts';
import type { DollarFunds, FundTransaction } from './funds.ts';
import type { ApiState, Command } from '../src/api-types.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldEpoch, worldYearMs } from '../src/environment.ts';
import { marketBasePrice } from '../src/market.ts';
import { startingFederations } from '../src/atlas.ts';

type Contribution = Extract<Command, { type: 'federation-contribute' }>;
function setup(store: SqliteStore, federation: string | null = 'Evergreen Union') {
  const identity = store.create();
  store.transaction(identity.token, session => {
    session.account.game.stage = 3;
    session.account.game.population = 0;
    session.account.game.federation = federation;
    session.account.game.stock = { wood: 100, water: 100, metal: 100, oil: 100 };
    session.account.game.dollars = 100 * dollarsScale;
    session.account.workforce!.automatic = false;
  });
  return identity;
}
function contribute(store: SqliteStore, token: string, command: Contribution, id = randomUUID()) {
  const revision = store.read(token, session => session.account.revision);
  const body = { id, revision, command };
  const run = () => store.transaction(token, (session, now, realTime, _exchange, owner) =>
    apply(session.account, body, now, realTime, undefined,
      contribution => store.contributeFederation(session.account, owner, contribution, now)));
  return { run, body };
}

test('every default federation accepts qualified joins and member contributions into its own persisted vault', () => {
  let now = worldEpoch + 1000;
  const store = new SqliteStore(':memory:', () => now);
  try {
    for (const federation of startingFederations) {
      const identity = setup(store, null);
      store.transaction(identity.token, session => {
        session.account.game.relationship = 50;
      });
      const join = () => {
        const revision = store.read(identity.token, session => session.account.revision);
        return store.transaction(identity.token, (session, time, realTime) =>
          apply(session.account, { id: randomUUID(), revision,
            command: { type: 'diplomacy', action: 'join', federation: federation.name } }, time, realTime));
      };
      join();
      assert.equal(store.read(identity.token, session => session.account.game.federation), federation.name);
      assert.equal(store.federationView(identity.token)!.totalValue, 0);
      now += 2000;
      const request = contribute(store, identity.token, { type: 'federation-contribute', asset: 'wood', amount: 10 });
      const result = request.run();
      assert.deepEqual(request.run(), result, 'replay must not debit another contribution');
      now += 2000;
      contribute(store, identity.token, { type: 'federation-contribute', asset: 'dollars', amount: 5 }).run();
      const vault = store.federationView(identity.token)!;
      assert.equal(vault.stock.wood, 10);
      assert.equal(vault.stock.dollars, 5);
      assert.equal(vault.contributors.find(member => member.yours)!.allTimePercent, 100);
      assert.equal(store.read(identity.token, session => session.account.game.stock.wood), 90);
      assert.equal(store.read(identity.token, session => session.account.game.dollars), 95 * dollarsScale);
      now += 2000;
      assert.throws(join, /already belongs/);
    }
  } finally { store.close(); }
});

test('common vault conserves resources and dollars, combines fixed base values, isolates federations and records game-year shares', () => {
  let now = worldEpoch + 1000;
  const store = new SqliteStore(':memory:', () => now);
  try {
    const first = setup(store), second = setup(store), zero = setup(store), other = setup(store, 'Verdant Federation');
    store.chat.syncWorldProfile(store.chatSession(first.token).owner, '0x1111111111111111111111111111111111111111', 'WorldBuilder', now);
    const supply = store.publicTotals();
    contribute(store, first.token, { type: 'federation-contribute', asset: 'wood', amount: 10 }).run();
    contribute(store, second.token, { type: 'federation-contribute', asset: 'dollars', amount: 40 }).run();
    let vault = store.federationView(first.token)!;
    assert.equal(vault.stock.wood, 10); assert.equal(vault.stock.dollars, 40);
    assert.equal(vault.totalValue, 10 * marketBasePrice('wood') + 40);
    assert.equal(vault.contributors.find(member => member.yours)!.allTimePercent, 50);
    assert.equal(vault.contributors.find(member => member.yours)!.annualPercent, 50);
    assert.equal(vault.contributors.find(member => member.yours)!.name, 'WorldBuilder');
    assert.equal(store.federationView(zero.token)!.contributors.find(member => member.yours)!.annualPercent, 0);
    assert.equal(store.federationView(other.token)!.totalValue, 0);
    assert.equal(store.read(first.token, session => session.account.game.stock.wood), 90);
    assert.equal(store.read(second.token, session => session.account.game.dollars), 60 * dollarsScale);
    assert.equal(store.publicTotals().dollars, supply.dollars);
    now = worldEpoch + worldYearMs + 1000;
    vault = store.federationView(first.token)!;
    assert.equal(vault.year, 2); assert.equal(vault.annualValue, 0);
    assert.equal(vault.contributors.find(member => member.yours)!.annualPercent, 0);
    contribute(store, second.token, { type: 'federation-contribute', asset: 'metal', amount: 10 }).run();
    vault = store.federationView(first.token)!;
    assert.equal(vault.contributors.find(member => member.yours)!.allTimePercent, 40);
    assert.equal(vault.contributors.find(member => !member.yours && member.value > 0)!.annualPercent, 100);
    assert.equal(vault.stock.wood, 10); assert.equal(vault.annualContributed.wood, 0);
    assert.equal(vault.annualContributed.metal, 10);
    assert.equal(store.publicTotals().metal, supply.metal);
    assert.equal(vault.taxStatus, 'pending');
    now += 1000;
    contribute(store, first.token, { type: 'federation-contribute', asset: 'water', amount: 2 }).run();
    now += 1000;
    contribute(store, first.token, { type: 'federation-contribute', asset: 'oil', amount: 3 }).run();
    vault = store.federationView(first.token)!;
    assert.equal(vault.stock.water, 2); assert.equal(vault.stock.oil, 3);
    assert.equal(vault.totalValue, 100 + 2 * marketBasePrice('water') + 3 * marketBasePrice('oil'));
  } finally { store.close(); }
});

test('contribution receipts debit once; invalid, unfunded, nonmember and rolled-back contributions leave no vault credit', () => {
  let now = worldEpoch + 1000;
  const store = new SqliteStore(':memory:', () => now);
  try {
    const member = setup(store), guest = setup(store, null);
    const retry = contribute(store, member.token, { type: 'federation-contribute', asset: 'dollars', amount: .0001 });
    const result = retry.run();
    assert.deepEqual(retry.run(), result);
    assert.equal(store.federationView(member.token)!.stock.dollars, .0001);
    now += 1000;
    assert.throws(() => contribute(store, guest.token, { type: 'federation-contribute', asset: 'wood', amount: 1 }).run(), /Join a federation/);
    const before = store.federationView(member.token);
    assert.throws(() => contribute(store, member.token, { type: 'federation-contribute', asset: 'oil', amount: 101 }).run(), /Not enough supplies/);
    for (const command of [
      { asset: 'wood', amount: 1.5 }, { asset: 'dollars', amount: .00001 }, { asset: 'wood', amount: -1 },
      { asset: 'wood', amount: 0 }, { asset: '__proto__', amount: 1 }, { asset: 'dollars', amount: Infinity },
      { asset: 'wood', amount: 100000001 }, { asset: 'metal', amount: NaN },
    ]) assert.throws(() => parseCommand({ type: 'federation-contribute', ...command }), /Invalid command/);
    assert.throws(() => parseCommand({ type: 'federation-contribute', asset: 'wood', amount: 1, federation: 'forged' }), /Invalid command/);
    assert.throws(() => store.transaction(member.token, (session, time, _real, _exchange, owner) => {
      store.contributeFederation(session.account, owner, { type: 'federation-contribute', asset: 'water', amount: 2 }, time);
      throw new Error('abort contribution');
    }), /abort contribution/);
    assert.deepEqual(store.federationView(member.token), before);
    assert.equal(store.read(member.token, session => session.account.game.stock.water), 100);
  } finally { store.close(); }
});

test('FTH$ vault deposits use balanced native fund journals and recover an interrupted commit without a second debit', () => {
  let now = worldEpoch + 1000, unavailable = false, commits = 0;
  const balances = new Map<string, bigint>(), applied = new Set<string>();
  const ledger: DollarFunds = {
    available: id => (balances.get(id) ?? 0n).toString(),
    supply: () => [...balances.values()].reduce((sum, value) => sum + value, 0n).toString(),
    prepare(entries) {
      assert.equal(entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n), 0n);
      return { i: randomUUID(), k: 'game', a: '', v: '', d: { entries, signature: 'test' }, t: now };
    },
    commit(transaction: FundTransaction) {
      if (unavailable) throw new Error('test interruption');
      if (applied.has(transaction.i)) return;
      for (const entry of transaction.d.entries) {
        const value = (balances.get(entry.account) ?? 0n) + BigInt(entry.delta);
        assert.ok(value >= 0n); balances.set(entry.account, value);
      }
      applied.add(transaction.i); commits++;
    },
  };
  const store = new SqliteStore(':memory:', () => now, 1, ledger);
  try {
    const member = store.create(), accountId = store.walletContext(member.token).fundAccountId!;
    balances.set(accountId, 100n * 10n ** 18n);
    store.transaction(member.token, session => {
      session.account.game.stage = 3; session.account.game.population = 0;
      session.account.game.federation = 'Evergreen Union'; session.account.workforce!.automatic = false;
    });
    const retry = contribute(store, member.token, { type: 'federation-contribute', asset: 'dollars', amount: 25 });
    unavailable = true;
    const originalError = console.error; console.error = () => {};
    try { assert.throws(retry.run, /settlement is unavailable/); }
    finally { console.error = originalError; }
    unavailable = false;
    retry.run();
    assert.equal(commits, 1);
    assert.equal(balances.get(accountId), 75n * 10n ** 18n);
    assert.equal(balances.get(gameFundAccount('escrow', 'federation:Evergreen Union')), 25n * 10n ** 18n);
    assert.equal(store.federationView(member.token)!.stock.dollars, 25);
    assert.equal(store.publicTotals().dollars, 100);
    now += 1000;
    const alias = store.create();
    store.linkWallet(member.token, '0x1111111111111111111111111111111111111111', false, true);
    store.linkWallet(alias.token, '0x1111111111111111111111111111111111111111', false, true);
    assert.deepEqual(store.federationView(alias.token), store.federationView(member.token));
  } finally { store.close(); }
});

test('vault API is session and CSRF protected, returns shared contributions and replays a deposit safely', async t => {
  const now = worldEpoch + 1000, store = new SqliteStore(':memory:', () => now);
  const member = setup(store), origin = 'http://127.0.0.1:5173';
  const server = createApi(store, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { Origin: origin, Cookie: `terra-dev=${member.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': member.csrf };
  const state = await (await fetch(`${base}/state`, { headers })).json() as ApiState;
  assert.equal(state.federationVault!.totalValue, 0);
  const body = JSON.stringify({ id: randomUUID(), revision: state.revision,
    command: { type: 'federation-contribute', asset: 'wood', amount: 3 } });
  assert.equal((await fetch(`${base}/actions`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'bad' }, body })).status, 403);
  const response = await fetch(`${base}/actions`, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const deposited = await response.json() as ApiState;
  assert.equal(deposited.federationVault!.stock.wood, 3);
  assert.equal(deposited.federationVault!.contributors.find(member => member.yours)!.annualPercent, 100);
  assert.deepEqual(await (await fetch(`${base}/actions`, { method: 'POST', headers, body })).json(), deposited);
});
