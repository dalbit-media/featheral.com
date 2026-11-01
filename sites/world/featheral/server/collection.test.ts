import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { accrue, apply, capacity, collectResource, createAccount, execute, migrateEconomy, snapshot } from './economy.ts';
import { collectFinds, findCollectionItem, inventory } from './inventory.ts';
import { Exchange } from './market.ts';
import { enforceMonetaryPolicy } from './monetary-policy.ts';
import { collectionDurations, collectionItemDetails, collectionItems, isCollectionItem } from '../src/collection.ts';
import { dollarsScale } from '../src/dollars.ts';
import { worldWeekMs } from '../src/environment.ts';
import { emptyAllocation, resourceAccess, resourceCapacity } from '../src/workforce.ts';
import { marketAssets } from '../src/market.ts';
import type { Account } from './economy.ts';
import type { Resource } from '../src/engine.ts';
import { SqliteStore } from './store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const start = 1000000;
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
  assert.equal(collectionItems.length, 12);
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
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER,data TEXT);CREATE TABLE gold_pool(id INTEGER PRIMARY KEY,dollars INTEGER);INSERT INTO gold_pool VALUES(1,0)');
    new Exchange(db);enforceMonetaryPolicy(db);
    const before=db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total;
    db.prepare('DELETE FROM market_pools WHERE asset=?').run('collection-wood-1');
    new Exchange(db);
    assert.deepEqual({...db.prepare('SELECT units,dollars FROM market_pools WHERE asset=?').get('collection-wood-1')},{units:0,dollars:0});
    assert.ok(Number(db.prepare('SELECT SUM(dollars) AS total FROM market_pools').get()!.total)<Number(before));
    enforceMonetaryPolicy(db);
    db.exec("UPDATE collection_policy SET fingerprint='changed'");
    assert.throws(()=>enforceMonetaryPolicy(db),/Collection policy changed/);
  }finally{db.close();}
});
test('cashless collect-and-sell burns only transport, rolls back bad quotes and replays exactly once', () => {
  const directory=mkdtempSync(join(tmpdir(),'featheral-pickup-')),path=join(directory,'save.sqlite');
  let now=start+1000;
  const store=new SqliteStore(path,()=>now),identity=store.create();
  const db=new DatabaseSync(path,{readOnly:true});
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
