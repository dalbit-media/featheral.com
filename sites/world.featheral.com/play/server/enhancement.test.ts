import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { once } from 'node:events';
import { accrue, apply, execute, parseCommand, snapshot } from './economy.ts';
import { createFundedFixtureAccount } from './test-support.ts';
import { inventory, equipActivity, craft } from './inventory.ts';
import { equipEnhanced, refineEquipment } from './enhancement.ts';
import { enhancedDiscount, enhancementChance, enhancementCost, enhancementQuote } from '../src/enhancement.ts';
import { activityEquipmentDiscount, activityEquipmentItems, discountedActivityCost } from '../src/activity-equipment.ts';
import { craftingCost, craftingStage, sellableItemCount } from '../src/items.ts';
import { dollarsScale } from '../src/dollars.ts';
import { recruitmentDollars } from '../src/engine.ts';
import { explorationQuote, investigationQuote, nextExploration } from '../src/workforce.ts';
import { planSquad } from '../src/exploration-squads.ts';
import { parseMarketCommand } from './market.ts';
import { SqliteStore } from './store.ts';
import type { MarketCommand } from '../src/market.ts';
import type { EnhancedEquipment } from '../src/enhancement.ts';
import type { DollarFunds, FundEntry } from './funds.ts';
import { gameFundAccount } from './funds.ts';
import { itemArt } from '../src/item-art.ts';
import { itemDescription } from '../src/item-details.ts';
import { createApi } from './http.ts';
import type { ApiState } from '../src/api-types.ts';
import type { MarketResponse } from '../src/market.ts';
import { renderActionControls, timedActionKey } from '../src/action-timing.ts';

const start = 1_000_000;
const replica = createRequire(import.meta.url)('../../../../services/operations/replica.js');
function fixture() {
  const account = createFundedFixtureAccount(start);
  account.game.stage = 0;
  account.game.home = { x: 0, y: 0 };
  account.game.explored = ['0,0'];
  account.game.population = 100;
  account.game.stock = { wood: 10_000_000, water: 10_000_000, metal: 10_000_000, oil: 10_000_000 };
  account.game.dollars = 1_000_000_000 * dollarsScale;
  inventory(account).items = ['survey-satchel', 'refinement-core', 'refinement-core'];
  return account;
}
function quote(account: ReturnType<typeof fixture>, target = 'survey-satchel') {
  return enhancementQuote(account.game, inventory(account), target);
}
test('refinement core uses actual stage-zero recipe costs and has dedicated art and details', () => {
  assert.equal(craftingStage('refinement-core'), 0);
  assert.deepEqual(craftingCost('refinement-core'), { wood: 100, metal: 50, oil: 10, dollars: 25 });
  assert.deepEqual(craftingCost('refinement-core', 10), { wood: 1000, metal: 500, oil: 100, dollars: 250 });
  assert.match(itemArt('refinement-core'), /refinement-core-art/);
  assert.doesNotMatch(itemArt('refinement-core'), /undefined|NaN/);
  assert.match(itemDescription('refinement-core').effect, /never destroys/);
  const account = fixture();
  for (let x = -15; x <= 15; x++) for (let y = -15; y <= 15; y++) account.game.explored.push(`${x},${y}`);
  const previous = account.game.dollars;
  craft(account, 'refinement-core');
  assert.equal(account.game.dollars, previous - 25 * dollarsScale);
});
test('chance declines from 90 to a floor of 10; each success adds 0.1 percent of base and caps at 99', () => {
  assert.equal(enhancementChance(0), 90);
  assert.equal(enhancementChance(1), 89.9);
  assert.equal(enhancementChance(500), 40);
  assert.equal(enhancementChance(800), 10);
  assert.equal(enhancementChance(1000), 10);
  assert.equal(enhancedDiscount('survey-satchel', 1), 10.01);
  assert.equal(enhancedDiscount('survey-satchel', 1000), 20);
  assert.equal(enhancedDiscount('survey-array', 1000), 99);
  assert.deepEqual(enhancementCost(1), { wood: 2000, water: 1000, metal: 1000, oil: 200, dollars: 200 });
  for (const [level, roll, success] of [[0, .899999, true], [0, .9, false], [1, .898999, true],
    [1, .899, false], [800, .099999, true], [800, .1, false], [999, 0, true]] as const) {
    const account = fixture(), bag = inventory(account), id = randomUUID();
    bag.items = ['refinement-core'];
    bag.enhancedEquipment = [{ id, item: 'survey-satchel', level }];
    refineEquipment(account, id, quote(account, id).fingerprint, () => roll);
    assert.equal(bag.enhancedEquipment[0].level, level + Number(success));
  }
});
test('first failure converts exactly one spare ordinary copy and keeps a stable level-zero identity', () => {
  const account = fixture(), bag = inventory(account);
  bag.items.push('survey-satchel');
  equipActivity(account, 'investigation', 'survey-satchel');
  const before = structuredClone(account.game), cost = quote(account).cost;
  refineEquipment(account, 'survey-satchel', quote(account).fingerprint, () => .99);
  assert.equal(bag.items.filter(item => item === 'survey-satchel').length, 1);
  assert.equal(bag.items.filter(item => item === 'refinement-core').length, 1);
  const copy = bag.enhancedEquipment![0], id = copy.id;
  assert.equal(copy.level, 0);
  assert.equal(bag.activityEquipment!.investigation, 'survey-satchel');
  for (const resource of ['wood', 'water', 'metal', 'oil'] as const)
    assert.equal(account.game.stock[resource], before.stock[resource] - cost[resource]!);
  assert.equal(account.game.dollars, before.dollars - cost.dollars! * dollarsScale);
  refineEquipment(account, id, quote(account, id).fingerprint, () => 0);
  assert.deepEqual(bag.enhancedEquipment, [{ id, item: 'survey-satchel', level: 1 }]);
  assert.equal(bag.items.filter(item => item === 'survey-satchel').length, 1);
  assert.equal(sellableItemCount(bag, 'survey-satchel'), 0);
});
test('affordability, cores, equipped ordinary copies and market escrow are validated without spending', () => {
  const changes = [
    (account: ReturnType<typeof fixture>) => { account.game.stock.wood = 999; },
    (account: ReturnType<typeof fixture>) => { account.game.stock.water = 499; },
    (account: ReturnType<typeof fixture>) => { account.game.stock.metal = 499; },
    (account: ReturnType<typeof fixture>) => { account.game.stock.oil = 99; },
    (account: ReturnType<typeof fixture>) => { account.game.dollars = 100 * dollarsScale - 1; },
    (account: ReturnType<typeof fixture>) => { inventory(account).items = ['survey-satchel']; },
    (account: ReturnType<typeof fixture>) => { equipActivity(account, 'investigation', 'survey-satchel'); },
    (account: ReturnType<typeof fixture>) => {
      inventory(account).items = ['refinement-core']; inventory(account).marketReserved = ['survey-satchel'];
    },
    (account: ReturnType<typeof fixture>) => { account.game.stage = -1; },
  ];
  for (const change of changes) {
    const account = fixture(); change(account);
    const estimate = quote(account), before = structuredClone(account);
    assert.equal(estimate.eligible, false);
    assert.throws(() => refineEquipment(account, estimate.target, estimate.fingerprint, () => 0));
    assert.deepEqual(account, before);
  }
});
test('stale quotes, cap and invalid random values do not charge, mutate identity or remove levels', () => {
  const account = fixture(), bag = inventory(account);
  const previous = quote(account);
  assert.throws(() => refineEquipment(account, previous.target, previous.fingerprint + ' ', () => 0), /quote changed/);
  refineEquipment(account, previous.target, previous.fingerprint, () => 0);
  const copy = bag.enhancedEquipment![0], stale = quote(account, copy.id);
  copy.level++;
  inventory(account);
  const saved = structuredClone(account);
  assert.throws(() => refineEquipment(account, copy.id, stale.fingerprint, () => 0), /quote changed/);
  assert.deepEqual(account, saved);
  copy.level = 1000;
  const capped = quote(account, copy.id), before = structuredClone(account);
  assert.equal(capped.eligible, false);
  assert.throws(() => refineEquipment(account, copy.id, capped.fingerprint, () => 0), /Maximum/);
  assert.deepEqual(account, before);
  copy.level = 3;
  const current = quote(account, copy.id), invalid = structuredClone(account);
  for (const roll of [-1, 1, NaN, Infinity]) {
    assert.throws(() => refineEquipment(account, copy.id, current.fingerprint, () => roll), /randomness/);
    assert.deepEqual(account, invalid);
  }
  copy.item = 'survey-array'; copy.level = 980;
  const discountCap = quote(account, copy.id), cappedCopy = structuredClone(account);
  assert.equal(discountCap.discount, 99);
  assert.equal(discountCap.nextDiscount, 99);
  assert.equal(discountCap.eligible, false);
  assert.match(discountCap.reason!, /Maximum equipment discount/);
  assert.throws(() => refineEquipment(account, copy.id, discountCap.fingerprint, () => 0), /Maximum equipment discount/);
  assert.deepEqual(account, cappedCopy);
});
test('individual identities and equipped IDs validate persistently and never enter pooled item counts', () => {
  const account = fixture(), bag = inventory(account);
  bag.enhancedEquipment = [{ id: randomUUID(), item: 'survey-array', level: 100 }];
  const copy = bag.enhancedEquipment[0];
  equipEnhanced(account, 'investigation', copy.id);
  assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 55);
  assert.equal(sellableItemCount(bag, copy.item), 0);
  assert.throws(() => equipActivity(account, 'investigation', copy.item), /Own matching/);
  assert.throws(() => equipEnhanced(account, 'exploration', copy.id), /Own matching/);
  equipActivity(account, 'investigation', 'survey-satchel');
  assert.equal(bag.enhancedEquipped!.investigation, undefined);
  assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 10);
  equipEnhanced(account, 'investigation', copy.id);
  assert.equal(bag.activityEquipment!.investigation, undefined);
  equipEnhanced(account, 'investigation', null);
  assert.equal(activityEquipmentDiscount(account.game, 'investigation'), 0);
  bag.enhancedEquipment.push({ ...copy });
  assert.throws(() => inventory(account), /Invalid enhanced/);
  bag.enhancedEquipment.pop();
  bag.enhancedEquipped!.investigation = randomUUID();
  assert.throws(() => inventory(account), /Invalid equipped/);
});
test('all enhanced tiers affect field previews, squad totals, recruitment and authoritative execution consistently', () => {
  for (const [item, recipe] of Object.entries(activityEquipmentItems)) {
    const account = fixture(), bag = inventory(account), id = randomUUID();
    bag.enhancedEquipment = [{ id, item: item as EnhancedEquipment['item'], level: 500 }];
    equipEnhanced(account, recipe.activity, id);
    const game = account.game, base = structuredClone(game);
    base.enhancedEquipped = {};
    const discount = enhancedDiscount(item as EnhancedEquipment['item'], 500);
    assert.equal(activityEquipmentDiscount(game, recipe.activity), discount);
    assert.equal(discountedActivityCost(game, recipe.activity, 100), 100 - discount);
    const work = snapshot(account).workforce;
    if (recipe.activity === 'attraction') {
      const expected = discountedActivityCost(game, 'attraction', recruitmentDollars(game.population, 0, start));
      assert.equal(recruitmentDollars(game.population, 0, start, game), expected);
      assert.equal(snapshot(account).recruitmentDollars, expected);
      const previous = game.dollars;
      execute(account, { type: 'invite' }, start + 2000);
      assert.equal(game.dollars, previous - expected * dollarsScale);
    } else {
      const activity = recipe.activity;
      if (activity === 'investigation') game.explored = ['0,0', '1,0', '0,1'];
      const calculate = activity === 'investigation' ? investigationQuote : explorationQuote;
      assert.equal(calculate(game, 1, 0).dollars, discountedActivityCost(game, activity, calculate(base, 1, 0).dollars));
      const plan = planSquad(game, work, activity, 3);
      assert.ok(plan.missions.length > 0);
      assert.equal(plan.dollarsUnits, plan.missions.reduce((sum, mission) => sum + Math.round(mission.dollars * dollarsScale), 0));
      for (const [index, mission] of plan.missions.entries())
        assert.equal(mission.dollars, discountedActivityCost(game, activity, calculate(base, mission.x, mission.y, index).dollars));
      bag.items.push('squad-10');
      const previous = game.dollars;
      execute(account, { type: 'dispatch-squad', item: 'squad-10', activity, quantity: plan.missions.length, maximumDollars: plan.dollarsUnits }, start + 2000);
      assert.equal(game.dollars, previous - plan.dollarsUnits);
    }
  }
});
test('strict enhancement parsers reject extra fields, forged chances and non-identities', () => {
  assert.deepEqual(parseCommand({ type: 'enhanced-gear', activity: 'exploration', id: null }),
    { type: 'enhanced-gear', activity: 'exploration', id: null });
  for (const command of [
    { type: 'refine-equipment', target: 'torch', fingerprint: '' },
    { type: 'refine-equipment', target: 'survey-satchel', fingerprint: '', chance: 100 },
    { type: 'refine-equipment', target: 'survey-satchel', fingerprint: 1 },
    { type: 'enhanced-gear', activity: 'wood', id: null },
    { type: 'enhanced-gear', activity: 'exploration', id: 'survey-satchel' },
    { type: 'enhanced-gear', activity: 'exploration', id: null, level: 1000 },
  ]) assert.throws(() => parseCommand(command));
  for (const command of [
    { type: 'enhancement-list', equipmentId: 'survey-satchel', price: 1 },
    { type: 'enhancement-list', equipmentId: randomUUID(), price: .00001 },
    { type: 'enhancement-list', equipmentId: randomUUID(), price: 0 },
    { type: 'enhancement-list', equipmentId: randomUUID(), price: 1, level: 1000 },
    { type: 'enhancement-buy', listingId: 1, price: Infinity },
    { type: 'enhancement-cancel', listingId: 0 },
    { type: 'enhancement-buy', listingId: 1, price: 1, buyer: 'system' },
  ]) assert.throws(() => parseMarketCommand(command));
});
test('refinement buttons share cooldown, pending state, aria busy and countdown across copy targets', () => {
  const command = { type: 'refine-equipment', target: 'survey-satchel', fingerprint: '' } as const;
  assert.equal(timedActionKey(command), 'refine-equipment');
  for (const target of ['survey-satchel', randomUUID()]) {
    const feedback = { textContent: '' }, attributes = new Map<string, string>();
    const classes = new Map<string, boolean>(), properties = new Map<string, string>();
    const button = {
      dataset: { action: 'refine-equipment', copy: target, actionEligible: 'true' },
      disabled: false,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      classList: { toggle: (key: string, value: boolean) => classes.set(key, value) },
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
      querySelector: () => feedback,
    };
    const root = { querySelectorAll: () => [button] } as unknown as ParentNode;
    renderActionControls(root, { 'refine-equipment': start + 2000 }, null, start + 500, 'Working');
    assert.equal(button.disabled, true);
    assert.equal(attributes.get('aria-busy'), 'true');
    assert.equal(classes.get('action-cooling'), true);
    assert.equal(feedback.textContent, '1.5s');
    assert.equal(properties.get('--action-progress'), '0.75');
    renderActionControls(root, undefined, 'refine-equipment', start + 2000, 'Working');
    assert.equal(button.disabled, true);
    assert.equal(feedback.textContent, 'Working');
    assert.equal(classes.get('action-working'), true);
    renderActionControls(root, { 'refine-equipment': start + 2000 }, null, start + 2000, 'Working');
    assert.equal(button.disabled, false);
    assert.equal(attributes.get('aria-busy'), 'false');
    assert.equal(feedback.textContent, '');
  }
});
test('enhanced automated exploration and recruitment use effective affordability and preserve offline outcomes', () => {
  for (const activity of ['exploration', 'attraction'] as const) {
    const account = fixture(), bag = inventory(account), id = randomUUID();
    const item = activity === 'exploration' ? 'trail-network' : 'welcome-network';
    const permit = activity === 'exploration' ? 'activity-exploration-4' : 'activity-attraction-4';
    bag.enhancedEquipment = [{ id, item, level: 777 }];
    bag.items.push(permit);
    equipEnhanced(account, activity, id);
    const now = start + 2000;
    const cost = activity === 'exploration' ? nextExploration(account.game, [])!.dollars
      : recruitmentDollars(account.game.population, 0, now, account.game);
    account.game.dollars = Math.round(cost * dollarsScale);
    const result = apply(account, { id: randomUUID(), revision: account.revision,
      command: { type: 'activate-activity', item: permit } }, now);
    assert.equal(account.game.dollars, 0);
    assert.equal(result.activityAutomation![activity].reason,
      activity === 'exploration' ? 'Waiting for expedition return' : 'Waiting for recruitment arrival');
    const once = structuredClone(account), frequent = structuredClone(account), end = now + 10000;
    accrue(once, end);
    for (let time = now + 1000; time <= end; time += 1000) accrue(frequent, time);
    assert.deepEqual(once, frequent);
  }
});

function setup(path = ':memory:', ledger?: DollarFunds) {
  let time = start;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let store = new SqliteStore(path, () => time, 1, ledger);
  const create = () => {
    const identity = store.create();
    store.transaction(identity.token, session => {
      session.account.game.stage = 0;
      session.account.game.home = { x: 0, y: 0 };
      session.account.game.stock = { wood: 100000, water: 100000, metal: 100000, oil: 100000 };
      if (!ledger) session.account.game.dollars = 1000000 * dollarsScale;
      inventory(session.account).items = ['survey-satchel', 'refinement-core', 'refinement-core'];
    });
    return identity.token;
  };
  const action = (token: string, command: MarketCommand, id = randomUUID(), revision?: number) => {
    time += 2000;
    return store.transaction(token, (session, now, realTime, exchange, owner) =>
      exchange.action(owner, session, { id, revision: revision ?? session.account.revision, command }, now, realTime));
  };
  const read = (token: string) => store.transaction(token, (session, now, realTime, exchange, owner) =>
    exchange.read(owner, session.account, now, realTime, 'wood', 1));
  const add = (token: string, level = 21) => {
    const copy: EnhancedEquipment = { id: randomUUID(), item: 'survey-satchel', level };
    store.transaction(token, session => {
      inventory(session.account).enhancedEquipment = [copy];
      inventory(session.account);
    });
    return copy;
  };
  return { get store() { return store; }, create, action, read, add,
    advance: () => { time += 2000; },
    restart: () => { store.close(); store = new SqliteStore(path, () => time, 1, ledger); },
    close: () => store.close() };
}
test('fixed player listings require unequip, escrow identity, return on cancel and preserve pools and history', () => {
  const world = setup();
  try {
    const seller = world.create(), buyer = world.create(), copy = world.add(seller);
    world.store.transaction(seller, session => equipEnhanced(session.account, 'investigation', copy.id));
    assert.throws(() => world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 123.4567 }), /Unequip/);
    world.store.transaction(seller, session => equipEnhanced(session.account, 'investigation', null));
    const pools = world.read(seller).market.tickers;
    const listed = world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 123.4567 });
    const listing = listed.market.enhancedListings![0];
    assert.deepEqual(listing.equipment, copy);
    assert.equal(listing.price, 123.4567);
    assert.equal(listing.yours, true);
    assert.equal(listed.inventory.enhancedEquipment!.length, 0);
    assert.throws(() => world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 1 }), /not owned/);
    assert.throws(() => world.action(buyer, { type: 'enhancement-cancel', listingId: listing.id }), /Only the seller/);
    assert.throws(() => world.store.transaction(seller, session => equipEnhanced(session.account, 'investigation', copy.id)), /Own matching/);
    assert.throws(() => world.store.transaction(seller, session => {
      const estimate = enhancementQuote(session.account.game, inventory(session.account), copy.id);
      refineEquipment(session.account, copy.id, estimate.fingerprint, () => 0);
    }), /Own an unequipped/);
    const cancelled = world.action(seller, { type: 'enhancement-cancel', listingId: listing.id });
    assert.deepEqual(cancelled.inventory.enhancedEquipment, [copy]);
    assert.equal(cancelled.market.enhancedListings!.length, 0);
    assert.deepEqual(cancelled.market.tickers, pools);
    assert.equal(cancelled.market.history.length, 0);
    assert.throws(() => world.action(seller, { type: 'enhancement-cancel', listingId: listing.id }), /not found/);
  } finally { world.close(); }
});
test('buy conserves exact dollars, level and identity, rejects stale prices and duplicates survive restart', t => {
  t.mock.method(replica, 'readReplica', () => null);
  const path = resolve('.data', `enhancement-${randomUUID()}.sqlite`), world = setup(path);
  try {
    const seller = world.create(), buyer = world.create(), copy = world.add(seller, 789);
    const listing = world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 123.4567 }).market.enhancedListings![0];
    const sellerBefore = world.read(seller), buyerBefore = world.read(buyer), totalBefore = world.store.publicTotals().dollars;
    assert.throws(() => world.action(seller, { type: 'enhancement-buy', listingId: listing.id, price: listing.price }), /own equipment/);
    assert.throws(() => world.action(buyer, { type: 'enhancement-buy', listingId: listing.id, price: listing.price + 1 }), /price changed/);
    world.restart();
    assert.deepEqual(world.read(buyer).market.enhancedListings![0].equipment, copy);
    const id = randomUUID(), revision = world.read(buyer).revision;
    const command: MarketCommand = { type: 'enhancement-buy', listingId: listing.id, price: listing.price };
    const bought = world.action(buyer, command, id, revision);
    assert.deepEqual(bought.inventory.enhancedEquipment, [copy]);
    assert.equal(bought.dollars, buyerBefore.dollars - listing.price);
    assert.equal(world.read(seller).dollars, sellerBefore.dollars + listing.price);
    assert.equal(world.store.publicTotals().dollars, totalBefore);
    assert.equal(world.read(seller).inventory.enhancedEquipment!.length, 0);
    world.restart();
    assert.deepEqual(world.action(buyer, command, id, revision), bought);
    assert.equal(world.read(seller).dollars, sellerBefore.dollars + listing.price);
    assert.throws(() => world.action(buyer, command), /not found/);
    assert.throws(() => world.action(buyer, { ...command, price: 1 }, id, revision), /Idempotency/);
    world.store.transaction(buyer, session => equipEnhanced(session.account, 'investigation', copy.id));
    assert.equal(activityEquipmentDiscount(world.read(buyer).game, 'investigation'), enhancedDiscount(copy.item, copy.level));
  } finally {
    world.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});
test('failed buy and transaction rollback cannot move escrow, dollars, sales or receipts', () => {
  const world = setup();
  try {
    const seller = world.create(), buyer = world.create(), copy = world.add(seller);
    const listing = world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 100 }).market.enhancedListings![0];
    world.store.transaction(buyer, session => { session.account.game.dollars = 0; });
    assert.throws(() => world.action(buyer, { type: 'enhancement-buy', listingId: listing.id, price: 100 }), /Not enough/);
    world.store.transaction(buyer, session => { session.account.game.dollars = 100 * dollarsScale; });
    const id = randomUUID(), revision = world.read(buyer).revision, sellerBefore = world.read(seller).dollars;
    const body = { id, revision, command: { type: 'enhancement-buy', listingId: listing.id, price: 100 } };
    world.advance();
    assert.throws(() => world.store.transaction(buyer, (session, now, realTime, exchange, owner) => {
      exchange.action(owner, session, body, now, realTime);
      throw new Error('forced rollback');
    }), /forced rollback/);
    assert.equal(world.read(seller).dollars, sellerBefore);
    assert.equal(world.read(buyer).inventory.enhancedEquipment?.length ?? 0, 0);
    assert.equal(world.read(buyer).market.enhancedListings!.length, 1);
    world.action(buyer, body.command as MarketCommand, id, revision);
    assert.equal(world.read(seller).dollars, sellerBefore + 100);
    assert.deepEqual(world.read(buyer).inventory.enhancedEquipment, [copy]);
  } finally { world.close(); }
});
test('refinement receipts, cooldown and equipped copy persist through restart and replay after other actions', t => {
  t.mock.method(replica, 'readReplica', () => null);
  const path = resolve('.data', `refinement-${randomUUID()}.sqlite`), world = setup(path);
  try {
    const token = world.create();
    let body: { id: string; revision: number; command: { type: 'refine-equipment'; target: string; fingerprint: string } };
    world.advance();
    const result = world.store.transaction(token, (session, now, realTime, exchange, owner) => {
      const estimate = enhancementQuote(session.account.game, inventory(session.account), 'survey-satchel');
      body = { id: randomUUID(), revision: session.account.revision, command: { type: 'refine-equipment', target: estimate.target, fingerprint: estimate.fingerprint } };
      return exchange.enhancementAction(owner, session.account, body, now, realTime);
    });
    const copy = result.inventory.enhancedEquipment![0];
    world.store.transaction(token, session => equipEnhanced(session.account, 'investigation', copy.id));
    assert.throws(() => world.store.transaction(token, (session, now, realTime) => {
      const estimate = enhancementQuote(session.account.game, inventory(session.account), copy.id);
      apply(session.account, { id: randomUUID(), revision: session.account.revision,
        command: { type: 'refine-equipment', target: copy.id, fingerprint: estimate.fingerprint } }, now, realTime + 250);
    }), /cooling down/);
    world.restart();
    world.advance();
    world.store.transaction(token, (session, now, realTime) =>
      apply(session.account, { id: randomUUID(), revision: session.account.revision, command: { type: 'enhanced-gear', activity: 'investigation', id: null } }, now, realTime));
    const before = world.read(token);
    const replay = world.store.transaction(token, (session, now, realTime, exchange, owner) =>
      exchange.enhancementAction(owner, session.account, body!, now, realTime));
    assert.deepEqual(replay, result);
    assert.equal(world.read(token).dollars, before.dollars);
    assert.deepEqual(world.read(token).inventory.enhancedEquipment, before.inventory.enhancedEquipment);
    assert.throws(() => world.store.transaction(token, (session, now, realTime, exchange, owner) =>
      exchange.enhancementAction(owner, session.account, { ...body!, revision: session.account.revision }, now, realTime)), /Idempotency/);
  } finally {
    world.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});
test('refinement receipt and resources roll back together when the outer transaction fails', () => {
  const world = setup();
  try {
    const token = world.create(), state = world.read(token), id = randomUUID();
    const estimate = enhancementQuote(state.game, state.inventory, 'survey-satchel');
    const body = { id, revision: state.revision, command: { type: 'refine-equipment', target: estimate.target, fingerprint: estimate.fingerprint } };
    world.advance();
    assert.throws(() => world.store.transaction(token, (session, now, realTime, exchange, owner) => {
      exchange.enhancementAction(owner, session.account, body, now, realTime);
      throw new Error('forced rollback');
    }), /forced rollback/);
    const after = world.read(token);
    assert.equal(after.dollars, state.dollars);
    assert.deepEqual(after.inventory.items, state.inventory.items);
    const result = world.store.transaction(token, (session, now, realTime, exchange, owner) =>
      exchange.enhancementAction(owner, session.account, body, now, realTime));
    assert.equal(result.inventory.enhancedEquipment!.length, 1);
    assert.equal(result.dollars, state.dollars - 100);
  } finally { world.close(); }
});
test('existing fiscal ledger stages refinement payments and exact player-to-player transfers without issuance or pool changes', () => {
  const balances = new Map<string, bigint>(), staged: FundEntry[][] = [];
  const ledger: DollarFunds = {
    available: account => (balances.get(account) ?? 0n).toString(), supply: () => '0',
    prepare: entries => {
      assert.ok(entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n) <= 0n);
      staged.push(entries);
      return { i: randomUUID(), k: 'GAME', a: '', v: '0', d: { entries, signature: '' }, t: start };
    },
    commit: transaction => {
      for (const entry of transaction.d.entries)
        balances.set(entry.account, (balances.get(entry.account) ?? 0n) + BigInt(entry.delta));
    },
  };
  const world = setup(':memory:', ledger);
  try {
    const seller = world.create(), buyer = world.create();
    for (const token of [seller, buyer]) {
      const owner = createHash('sha256').update(token).digest('hex');
      balances.set(gameFundAccount('guest', owner), 1000n * 10n ** 18n);
    }
    world.advance();
    const refined = world.store.transaction(seller, (session, now, realTime, exchange, owner) => {
      const estimate = enhancementQuote(session.account.game, inventory(session.account), 'survey-satchel');
      return exchange.enhancementAction(owner, session.account, { id: randomUUID(), revision: session.account.revision,
        command: { type: 'refine-equipment', target: estimate.target, fingerprint: estimate.fingerprint } }, now, realTime);
    });
    assert.equal(staged.length, 1);
    assert.equal(staged[0].reduce((sum, entry) => sum + BigInt(entry.delta), 0n), -100n * 10n ** 18n);
    const copy = refined.inventory.enhancedEquipment![0];
    const listed = world.action(seller, { type: 'enhancement-list', equipmentId: copy.id, price: 50 });
    assert.equal(staged.length, 1);
    const pools = world.read(buyer).market.tickers;
    world.action(buyer, { type: 'enhancement-buy', listingId: listed.market.enhancedListings![0].id, price: 50 });
    assert.equal(staged.length, 2);
    assert.equal(staged[1].length, 2);
    assert.equal(staged[1].reduce((sum, entry) => sum + BigInt(entry.delta), 0n), 0n);
    assert.deepEqual(world.read(buyer).market.tickers, pools);
    assert.equal(world.read(seller).dollars, 950);
    assert.equal(world.read(buyer).dollars, 950);
  } finally { world.close(); }
});
test('authenticated HTTP refinement and player listings require origin, CSRF, authoritative quotes and exact receipts', async () => {
  const world = setup(), seller = world.create(), buyer = world.create();
  const server = createApi(world.store, 'http://127.0.0.1:5173');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = (token: string) => ({ Cookie: `terra-dev=${token}`, Origin: 'http://127.0.0.1:5173',
    'Content-Type': 'application/json', 'X-CSRF-Token': world.store.read(token, session => session.csrf) });
  const post = (token: string, route: string, body: unknown, override = {}) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { ...headers(token), ...override }, body: JSON.stringify(body),
  });
  try {
    const state = world.read(seller), estimate = enhancementQuote(state.game, state.inventory, 'survey-satchel');
    const body = { id: randomUUID(), revision: state.revision,
      command: { type: 'refine-equipment', target: estimate.target, fingerprint: estimate.fingerprint } };
    assert.equal((await post(seller, 'actions', body, { 'X-CSRF-Token': 'bad' })).status, 403);
    assert.equal((await post(seller, 'actions', body, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await post(seller, 'actions', { ...body, command: { ...body.command, chance: 100 } })).status, 400);
    assert.equal((await post(seller, 'actions', { ...body, command: { ...body.command, fingerprint: 'stale' } })).status, 409);
    const response = await post(seller, 'actions', body);
    assert.equal(response.status, 200);
    const refined = await response.json() as ApiState;
    const copy = refined.inventory.enhancedEquipment![0];
    assert.deepEqual(await (await post(seller, 'actions', body)).json(), refined);
    assert.equal(refined.dollars, state.dollars - 100);
    world.advance();
    const listBody = { id: randomUUID(), revision: refined.revision,
      command: { type: 'enhancement-list', equipmentId: copy.id, price: 37.1234 } };
    const listedResponse = await post(seller, 'market/actions', listBody);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as MarketResponse, listing = listed.market.enhancedListings![0];
    assert.deepEqual(listing.equipment, copy);
    assert.equal((await fetch(`${base}/market`)).status, 401);
    const publicListing = await (await fetch(`${base}/market`, { headers: headers(buyer) })).json() as MarketResponse;
    assert.equal(publicListing.market.enhancedListings![0].yours, false);
    const boughtResponse = await post(buyer, 'market/actions', { id: randomUUID(), revision: publicListing.revision,
      command: { type: 'enhancement-buy', listingId: listing.id, price: listing.price } });
    assert.equal(boughtResponse.status, 200);
    const bought = await boughtResponse.json() as MarketResponse;
    assert.deepEqual(bought.inventory.enhancedEquipment, [copy]);
    world.advance();
    const equipResponse = await post(buyer, 'actions', { id: randomUUID(), revision: bought.revision,
      command: { type: 'enhanced-gear', activity: 'investigation', id: copy.id } });
    assert.equal(equipResponse.status, 200);
    const equipped = await equipResponse.json() as ApiState;
    assert.equal(activityEquipmentDiscount(equipped.game, 'investigation'), enhancedDiscount(copy.item, copy.level));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    world.close();
  }
});
