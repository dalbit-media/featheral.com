import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import sqlite from '../../../../services/database/sqlite.js';
import { test } from 'node:test';
import { accrue, apply, capacity, collectResource, execute, migrateEconomy, snapshot } from './economy.ts';
import { createFundedFixtureAccount as createAccount } from './test-support.ts';
import { collectFinds, findCollectionItem, inventory } from './inventory.ts';
import { Exchange } from './market.ts';
import { enforceMonetaryPolicy } from './monetary-policy.ts';
import { collectionDurations, collectionItemDetails, collectionItems, isCollectionItem } from '../src/collection.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { emptyAllocation, resourceAccess, resourceCapacity } from '../src/workforce.ts';
import { terrainAt, terrainResources } from '../src/engine.ts';
import { marketAssets } from '../src/market.ts';
import type { Account } from './economy.ts';
import type { Resource } from '../src/engine.ts';
import { SqliteStore } from './store.ts';
import { seedFixturePools } from './test-support.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApi } from './http.ts';
import type { CollectionResponse } from '../src/api-types.ts';

const start = 1000000;
test('map pickup collects completed output at zero funds, preserves currency and is retry-safe', () => {
  const account = colony();
  const tile = account.game.explored.find(key => {
    const [x, y] = key.split(',').map(Number);
    return terrainResources[terrainAt(x, y, account.game.seed)] === 'wood';
  })!;
  const [x, y] = tile.split(',').map(Number);
  account.game.dollars = 0;
  account.pending.wood = 7 * 60000;
  account.pickupFees!.wood = 3 * dollarsScale;
  account.workforce!.crews = {};
  const body = { id: randomUUID(), revision: account.revision, command: { type: 'map-collect', x, y } };
  const before = account.game.stock.wood;
  const result = apply(account, body, account.updatedAt, start + 2000);
  assert.equal(account.game.stock.wood, before + 7);
  assert.equal(account.game.dollars, 0);
  assert.equal(account.pending.wood, 0);
  assert.equal(account.pickupFees!.wood, 0);
  assert.deepEqual(apply(account, body, account.updatedAt, start + 2000), result);
  assert.equal(account.game.stock.wood, before + 7);
  assert.throws(() => execute(account, { type: 'map-collect', x, y }, start + 2100), /half a second/);
  assert.throws(() => execute(account, { type: 'map-collect', x, y }, start + 3000), /No completed/);
});
test('map pickup rejects undiscovered tiles and invalid coordinate commands without clearing output', () => {
  const account = colony();
  account.pending.wood = 60000;
  const before = structuredClone(account);
  assert.throws(() => execute(account, { type: 'map-collect', x: 90000, y: 90000 }), /Discover/);
  assert.deepEqual(account, before);
  assert.throws(() => apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'map-collect', x: .5, y: 0 } }, account.updatedAt), /Invalid command/);
  assert.deepEqual(account, before);
});
test('map pickup handles all resource types but keeps the Oil bank unlock', () => {
  const account = colony();
  account.game.dollars = 0;
  for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) account.game.explored.push(`${x},${y}`);
  for (const resource of ['wood', 'water', 'metal', 'oil'] as const) {
    const tile = account.game.explored.find(key => {
      const [x, y] = key.split(',').map(Number);
      return terrainResources[terrainAt(x, y, account.game.seed)] === resource;
    })!;
    const [x, y] = tile.split(',').map(Number);
    account.pending[resource] = 5 * 60000; account.pickupFees![resource] = dollarsScale;
    account.lastClaimAt = 0;
    const before = account.game.stock[resource];
    if (resource === 'oil') {
      account.game.bank = false;
      assert.throws(() => execute(account, { type: 'map-collect', x, y }, start + 5000), /Discover/);
      assert.equal(account.pending[resource], 5 * 60000);
      account.game.bank = true;
    }
    execute(account, { type: 'map-collect', x, y }, start + 5000);
    assert.equal(account.game.stock[resource], before + 5);
    assert.equal(account.game.dollars, 0);
    assert.equal(account.pickupFees![resource], 0);
  }
});
function colony(): Account {
  const account = createAccount(start);
  account.game.seed = 1542;
  apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'upgrade' } }, start);
  account.game.dollars = 100 * dollarsScale;
  account.game.stock.wood = 0;
  account.workforce!.crews = {};
  account.workforce!.automatic = false;
  account.workforce!.allocation = { ...emptyAllocation(), wood: 1 };
  apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'home' } }, start + 1000);
  return account;
}
test('a full week produces pending output, with no dispatch payment and no half-storage pickup gate', () => {
  const account = colony(), before = snapshot(account), due = before.workforce.crews.wood!.readyAt;
  assert.equal(account.game.dollars, 100 * dollarsScale);
  accrue(account, due - 1);
  assert.equal(snapshot(account).pending.wood, 0);
  accrue(account, due);
  assert.equal(account.game.stock.wood, 0);
  assert.equal(snapshot(account).pending.wood, before.rates.wood);
  const fee = account.pickupFees!.wood;
  assert.equal(fee, resourceAccess(account.game).wood.dollarsPerWorker * dollarsScale);
  collectResource(account, 'wood');
  assert.equal(account.game.stock.wood, before.rates.wood);
  assert.equal(account.game.dollars, 100 * dollarsScale - fee);
  assert.equal(account.pickupFees!.wood, 0);
  assert.throws(() => collectResource(account, 'wood'), /No completed/);
});
test('all four resources pay transport for every worker, including the basic Water and Wood crews', () => {
  for (const resource of ['wood', 'water', 'metal', 'oil'] as Resource[]) {
    const account = colony();
    account.game.bank = true;
    account.game.explored = [];
    for(let x=-10;x<=10;x++)for(let y=-10;y<=10;y++)account.game.explored.push(`${x},${y}`);
    account.game.stock[resource] = resource === 'water' ? 1260 : 0;
    account.workforce!.crews = {};
    account.workforce!.allocation = { ...emptyAllocation(), [resource]: 1 };
    apply(account, { id: randomUUID(), revision: account.revision, command: { type: 'home' } }, account.updatedAt + 1000);
    const crew = snapshot(account).workforce.crews[resource]!;
    assert.ok(crew);
    assert.equal(crew.weeklyDollarsCost, resourceAccess(account.game)[resource].dollarsPerWorker);
    accrue(account, crew.readyAt);
    assert.equal(account.pickupFees![resource], crew.weeklyDollarsCost! * dollarsScale);
  }
});
test('zero-FTH$ crews can work, but pickup cannot silently waive transport or lose output', () => {
  const account = colony(), due = snapshot(account).workforce.crews.wood!.readyAt;
  account.game.dollars = 0;
  accrue(account, due);
  const before = structuredClone(account);
  assert.throws(() => collectResource(account, 'wood'), /FTH|resources|afford/i);
  assert.deepEqual(account, before);
  assert.ok(account.pending.wood > 0);
});
test('1/4/12-week consumables stack time, are resource-specific and pay normal pickup fees', () => {
  assert.equal(collectionItems.filter(item => item.startsWith('collection-')).length, 12);
  assert.equal(collectionItems.length, 32);
  for(const weeks of collectionDurations) {
    const account = colony(), bag = inventory(account), item = `collection-wood-${weeks}` as const;
    bag.items.push(item, item);
    execute(account, { type: 'activate-collection', item });
    assert.equal(account.automationUntil!.wood, account.updatedAt + weeks * worldWeekMs);
    execute(account, { type: 'activate-collection', item });
    assert.equal(account.automationUntil!.wood, account.updatedAt + 2 * weeks * worldWeekMs);
    assert.equal(account.automationUntil!.water, 0);
    assert.equal(bag.items.filter(id=>id===item).length, 0);
    const due=snapshot(account).workforce.crews.wood!.readyAt, before=account.game.dollars;
    accrue(account,due);
    assert.ok(account.game.stock.wood>0);
    assert.equal(account.pending.wood,0);
    assert.ok(account.game.dollars<before);
    assert.throws(()=>execute(account,{type:'activate-collection',item}),/not available/);
  }
});
test('automation includes the exact expiry boundary, then returns to manual pickup', () => {
  const account=colony(), due=snapshot(account).workforce.crews.wood!.readyAt;
  account.automationUntil!.wood=due;
  accrue(account,due);
  assert.ok(account.game.stock.wood>0);
  account.game.stock.wood=0;
  accrue(account,due+worldWeekMs);
  assert.equal(account.game.stock.wood,0);
  assert.ok(account.pending.wood>0);
});
test('automation with insufficient FTH$ keeps completed resources and fees pending', () => {
  const account=colony(),due=snapshot(account).workforce.crews.wood!.readyAt;
  account.automationUntil!.wood=due+worldWeekMs;
  account.game.dollars=0;
  accrue(account,due);
  assert.equal(account.game.stock.wood,0);
  assert.ok(account.pending.wood>0);
  assert.ok(account.pickupFees!.wood>0);
});
test('full pending storage bounds offline processing and never charges overflow or removes residents', () => {
  const account=colony(); account.game.dollars=0;
  const population=account.game.population;
  accrue(account,start+1000000*worldWeekMs);
  assert.equal(account.game.population,population);
  assert.equal(account.game.dollars,0);
  assert.ok(snapshot(account).pending.wood<=resourceCapacity(capacity(account),'wood',account.game));
  assert.equal(Object.keys(snapshot(account).workforce.crews).length,0);
});
test('old paid deliveries, balances, receipts and deadlines survive the pickup migration', () => {
  const account=colony();
  delete account.pickupVersion;delete account.pickupFees;delete account.automationUntil;
  const crew=account.workforce!.crews.wood!; delete crew.payOnPickup;crew.automaticDelivery=true;
  const before=structuredClone(account);
  migrateEconomy(account,account.updatedAt);
  assert.equal(account.game.dollars,before.game.dollars);
  assert.deepEqual(account.workforce,before.workforce);
  assert.deepEqual(account.receipt,before.receipt);
  assert.equal(account.revision,before.revision+1);
  accrue(account,crew.readyAt);
  assert.equal(account.game.stock.wood,crew.weeklyYield);
  assert.equal(account.pickupFees!.wood,0);
  assert.ok(snapshot(account).workforce.crews.wood?.payOnPickup);
});
test('exploration gives tradable consumables and overflow collection preserves duplicate quantities', () => {
  const account=colony(),bag=inventory(account);
  for(let i=0;i<23;i++)findCollectionItem(account,'forest');
  const count=bag.items.filter(isCollectionItem).length+bag.pending.filter(isCollectionItem).length;
  assert.equal(count,23);
  const item=bag.items.find(isCollectionItem)!;
  assert.ok(marketAssets.includes(item));
  assert.equal(collectionItemDetails(item).resource,'wood');
  bag.items.splice(0,3);
  const pending=bag.pending.length;
  collectFinds(account);
  assert.equal(bag.pending.length,Math.max(0,pending-3));
});
test('new automation markets never bootstrap extra currency and collection policy is startup-guarded', () => {
  const db=sqlite.open(':memory:');
  try {
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER,data TEXT)');
    new Exchange(db);enforceMonetaryPolicy(db);
    const before=db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total;
    db.prepare('DELETE FROM market_pools WHERE asset=?').run('collection-wood-1');
    new Exchange(db);
    assert.deepEqual({...db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get('collection-wood-1')},{units:0,dollars:0});
    assert.equal(Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total),Number(before));
    enforceMonetaryPolicy(db);
    db.exec("UPDATE collection_policy SET fingerprint='changed'");
    assert.throws(()=>enforceMonetaryPolicy(db),/Collection policy changed/);
  }finally{db.close();}
});
test('cashless collect-and-sell burns only transport, rolls back bad quotes and replays exactly once', () => {
  const directory=mkdtempSync(join(tmpdir(),'featheral-pickup-')),path=join(directory,'save.sqlite');
  let now=start+1000;
  const store=new SqliteStore(path,()=>now),identity=store.create();
  seedFixturePools(store);
  const db=sqlite.open(path,{readOnly:true});
  try {
    store.transaction(identity.token,s=>{s.account=colony();s.account.game.dollars=0;});
    now+=worldWeekMs;
    const preview=store.transaction(identity.token,(s,time,real,exchange,owner)=>{
      accrue(s.account,time);return exchange.collectionQuote(owner,s.account,'wood',real);
    });
    assert.ok(preview.collectionQuote.available);
    assert.equal(preview.dollars,0);
    const before=store.read(identity.token,s=>structuredClone(s.account));
    const reserves=Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total);
    const run=(body:unknown)=>store.transaction(identity.token,(s,time,real,exchange,owner)=>
      apply(s.account,body,time,real,command=>exchange.collectSell(owner,s.account,command,time,real)));
    const command={type:'collect-sell',resource:'wood',quantity:preview.collectionQuote.quantity,minimumDollars:1000000000};
    assert.throws(()=>run({id:randomUUID(),revision:before.revision,command}),/Quote changed/);
    assert.deepEqual(store.read(identity.token,s=>s.account),before);
    assert.equal(Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total),reserves);
    const body={id:randomUUID(),revision:before.revision,command:{...command,minimumDollars:1}};
    const result=run(body);
    assert.equal(result.pending.wood,0);
    assert.equal(result.game.stock.wood,before.game.stock.wood);
    assert.equal(result.collection!.fees.wood,0);
    const debit=reserves-Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total);
    assert.equal(result.game.dollars,debit-before.pickupFees!.wood);
    assert.ok(result.dollars>0);
    const after=store.read(identity.token,s=>structuredClone(s.account));
    assert.deepEqual(run(body),result);
    assert.deepEqual(store.read(identity.token,s=>s.account),after);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM market_fills').get()!.total),1);
  }finally{db.close();store.close();rmSync(directory,{recursive:true});}
});
test('collection percentage sales collect all output, retain unsold stock, pay full fees and replay once', () => {
  for (const quantity of [5, 10, 15, 20]) {
    const store = new SqliteStore(':memory:', () => start + 1000), identity = store.create();
    seedFixturePools(store);
    try {
      store.transaction(identity.token, session => {
        session.account.game.stage = 0; session.account.game.population = 0; session.account.game.dollars = 0;
        session.account.game.stock.wood = 3; session.account.pending.wood = 20 * 60000 + 30000;
        session.account.pickupFees = { wood: dollarsScale, water: 0, metal: 0, oil: 0 };
      });
      const quote = store.transaction(identity.token, (session, _, real, exchange, owner) => {
        assert.equal(exchange.collectionQuote(owner, session.account, 'wood', real).collectionQuote.quantity, 20);
        assert.throws(() => exchange.collectionQuote(owner, session.account, 'wood', real, 21), /Resources changed/);
        return exchange.collectionQuote(owner, session.account, 'wood', real, quantity).collectionQuote;
      });
      assert.equal(quote.quantity, quantity); assert.equal(quote.transport, 1); assert.ok(quote.available);
      const body = { id: randomUUID(), revision: store.read(identity.token, session => session.account.revision),
        command: { type: 'collect-sell', resource: 'wood', quantity, minimumDollars: Math.round(quote.net * dollarsScale) } };
      const run = (request: unknown) => store.transaction(identity.token, (session, time, real, exchange, owner) =>
        apply(session.account, request, time, real, command => exchange.collectSell(owner, session.account, command, time, real)));
      const before = store.read(identity.token, session => structuredClone(session.account));
      assert.throws(() => run({ ...body, id: randomUUID(), command: { ...body.command, minimumDollars: 99999999999 } }), /Quote changed/);
      assert.deepEqual(store.read(identity.token, session => session.account), before);
      const result = run(body);
      assert.equal(result.pending.wood, 0);
      assert.equal(store.read(identity.token, session => session.account.pending.wood), 30000);
      assert.equal(result.game.stock.wood, 3 + 20 - quantity);
      assert.equal(result.collection!.fees.wood, 0);
      assert.equal(result.dollars, quote.net);
      assert.deepEqual(run(body), result);
      assert.equal(store.read(identity.token, session => session.account.game.stock.wood), 3 + 20 - quantity);
    } finally { store.close(); }
  }
});
test('HTTP collection quantity quotes validate input and fund only the selected sale', async () => {
  const store = new SqliteStore(':memory:', () => start + 1000), identity = store.create();
  seedFixturePools(store);
  store.transaction(identity.token, session => {
    session.account.game.stage = 0; session.account.game.population = 0; session.account.pending.wood = 20 * 60000;
  });
  const origin = 'http://127.0.0.1:5173', server = createApi(store, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/collection`;
  const headers = { Cookie: `terra-dev=${identity.token}` };
  const funded: number[] = [];
  store.ensureLiquidity = async (_, __, quantity) => { funded.push(quantity ?? 0); };
  try {
    assert.equal((await fetch(`${base}?asset=wood&quantity=10`)).status, 401);
    for (const query of ['asset=wood&quantity=0', 'asset=wood&quantity=1.5', 'asset=wood&quantity=NaN',
      'asset=wood&quantity=10&quantity=20', 'asset=wood&asset=water', 'asset=torch&quantity=1', 'asset=wood&other=1']) {
      assert.equal((await fetch(`${base}?${query}`, { headers })).status, 400, query);
    }
    assert.deepEqual(funded, []);
    const response = await fetch(`${base}?asset=wood&quantity=10`, { headers });
    assert.equal(response.status, 200);
    const state = await response.json() as CollectionResponse;
    assert.equal(state.collectionQuote.quantity, 10);
    assert.deepEqual(funded, [10]);
    assert.equal((await fetch(`${base}?asset=wood&quantity=21`, { headers })).status, 409);
    assert.deepEqual(funded, [10]);
    assert.equal(store.read(identity.token, session => session.account.pending.wood), 20 * 60000);
  } finally { server.close(); await once(server, 'close'); store.close(); }
});
