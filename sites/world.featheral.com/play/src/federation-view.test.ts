import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { federationPanel } from './federation-view.ts';
import { gameConsumption } from './consumption.ts';
import { diplomacyCosts } from './engine.ts';
import { translate } from './i18n.ts';

function fixture() {
  const account = createAccount(1000000);
  account.game.stage = 3; account.game.population = 250; account.game.relationship = 50;
  account.game.stock = { wood: 40, water: 30, metal: 5000, oil: 0 };
  return { ...snapshot(account), csrf: 'test', clockSpeed: 1 as const, population: { global: 250, federation: null } };
}
function disabled(html: string, action: string): boolean {
  return new RegExp(`data-action="${action}"[^>]*\\bdisabled`).test(html);
}
test('federation join and goodwill explain material shortages and exact Village/relationship requirements', () => {
  const state = fixture();
  assert.equal(disabled(federationPanel(state, 'en'), 'join'), false);
  assert.equal(disabled(federationPanel(state, 'en'), 'gift'), false);
  state.game.stage = 2;
  assert.equal(disabled(federationPanel(state, 'en'), 'join'), true);
  assert.match(federationPanel(state, 'en'), /Reach Village to join/);
  state.game.stage = 3; state.game.relationship = 49; state.game.stock.wood = 39;
  assert.equal(disabled(federationPanel(state, 'en'), 'join'), true);
  assert.equal(disabled(federationPanel(state, 'en'), 'gift'), true);
  assert.match(federationPanel(state, 'en'), /Not enough supplies for goodwill/);
  assert.deepEqual(gameConsumption(state, { type: 'diplomacy', action: 'gift' })!.costs,
    Object.entries(diplomacyCosts.gift).map(([asset, amount]) => ({ asset, amount })));
});
test('founding requires City, more than ten thousand residents, full Metal cost and no membership', () => {
  const state = fixture();
  state.game.stage = 6; state.game.population = 10001;
  assert.equal(disabled(federationPanel(state, 'en'), 'form'), false);
  state.game.population = 10000;
  assert.equal(disabled(federationPanel(state, 'en'), 'form'), true);
  state.game.population = 10001; state.game.stock.metal = 4999;
  assert.equal(disabled(federationPanel(state, 'en'), 'form'), true);
  state.game.stock.metal = 5000; state.game.federation = 'Evergreen Union';
  assert.equal(disabled(federationPanel(state, 'en'), 'form'), true);
  assert.match(federationPanel(state, 'en'), /communicate\/\?channel=federation/);
});
test('assembly gates Town, town hall, membership and recorded votes without claiming financial authority', () => {
  const state = fixture();
  state.game.stage = 4; state.game.townhall = true;
  assert.equal(disabled(federationPanel(state, 'en'), 'vote'), true);
  state.game.federation = 'Evergreen Union';
  assert.equal(disabled(federationPanel(state, 'en'), 'vote'), false);
  state.game.townhall = false;
  assert.equal(disabled(federationPanel(state, 'en'), 'vote'), true);
  assert.match(federationPanel(state, 'en'), /href="\/settlement\/#buildings"/);
  state.game.townhall = true; state.game.votes = ['watershed'];
  assert.equal(disabled(federationPanel(state, 'en'), 'vote'), true);
  assert.match(federationPanel(state, 'en'), /Your vote is recorded/);
  assert.match(federationPanel(state, 'en'), /Assembly is simulation only/);
  assert.doesNotMatch(federationPanel(state, 'en'), /EARNED|data-action="claim"/);
});
test('federation display escapes names, preserves balances and localizes actionable requirements', () => {
  const state = fixture();
  state.game.federation = '<img src=x onerror=alert(1)>';
  const before = structuredClone(state);
  const html = federationPanel(state, 'ko');
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.deepEqual(state, before);
  for (const label of ['Reach Village to join.', 'Not enough supplies for goodwill.', 'Member bonus: +20% Metal output for new weekly crews.',
    'Reach Town and build a town hall to vote.', 'Your vote is recorded.', 'Ready to join. No joining fee.'])
    assert.notEqual(translate(label, 'ko'), label);
});
test('common vault shows every asset, all-time and game-year shares with an explicit pending payout policy', () => {
  const state = fixture();
  state.game.federation = 'Evergreen Union';
  const stock = { wood: 3, water: 4, metal: 5, oil: 6, dollars: 12.3456 };
  const vault = { year: 12, stock, annualContributed: stock, totalValue: 100, annualValue: 50, taxStatus: 'pending' as const,
    contributors: [{ id: 'member', name: '<script>test</script>', yours: true, contributed: stock, annualContributed: stock,
      value: 50, annualValue: 25, allTimePercent: 50, annualPercent: 25 }] };
  const complete = { ...state, federationVault: vault };
  const html = federationPanel(complete, 'en');
  assert.match(html, /Common resources vault/);
  assert.match(html, /50%/); assert.match(html, /25%/);
  assert.match(html, /12\.35 FTH\$/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Tax collection, payout rate and eligibility are pending/);
  assert.match(html, /data-action="federation-contribute"/);
  assert.equal(gameConsumption(complete, { type: 'federation-contribute', asset: 'dollars', amount: .0001 })!.preciseDollars, true);
  for (const label of ['Common resources vault', 'Contribution share', 'This game year', 'Contribute',
    'Contributions are permanent. No withdrawal or payout is currently available.'])
    assert.notEqual(translate(label, 'ko'), label);
});
