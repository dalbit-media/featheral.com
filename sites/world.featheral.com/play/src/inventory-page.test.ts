import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { inventoryPageFrame, inventoryTabFromHash, inventoryTabs } from './inventory-page.ts';
import { gamePage, primaryGamePageKeys } from './game-pages.ts';
import { settlementDockTasks, settlementSectionNavigation } from './settlement-ui.ts';
import { translate } from './i18n.ts';
import { createAccount, snapshot } from '../server/economy.ts';
import { inventoryPanel, craftingPanel, inventorySlotsPerPage } from './inventory-view.ts';
import { marketAssets, isMarketResource } from './market.ts';
import type { ApiState } from './api-types.ts';

test('inventory is a dedicated primary game destination with safe direct tab links', () => {
  assert.equal(gamePage('/inventory/'), 'inventory');
  assert.equal(gamePage('/inventory/index.html'), 'inventory');
  assert.ok(primaryGamePageKeys.includes('inventory'));
  assert.equal(inventoryTabFromHash('#crafting'), 'craft');
  for (const tab of inventoryTabs) {
    assert.equal(inventoryTabFromHash(`#${tab}`), tab);
    for (const language of ['en', 'ko'] as const) {
      const html = inventoryPageFrame(tab, '<section>content</section>', language);
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
      assert.match(html, new RegExp(`href="#${tab}" aria-current="page"`));
      assert.match(html, /<section>content<\/section>/);
      assert.ok(html.includes(translate('Inventory sections', language)));
    }
  }
  for (const invalid of ['', '#constructor', '#__proto__', '#anything']) assert.equal(inventoryTabFromHash(invalid), 'inventory');
  assert.equal(settlementDockTasks.includes('inventory'), false);
  assert.equal(settlementDockTasks.includes('crafting'), false);
  assert.doesNotMatch(settlementSectionNavigation('overview', 'en'), /data-settlement-panel="(?:inventory|crafting)"/);
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /'inventory\/index': resolve\('inventory', 'index.html'\)/);
});

test('upkeep cards size naturally and population explanations are progressively disclosed', () => {
  const style = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(style, /\.notice\.water-upkeep\{[^}]*height:auto;min-height:0/);
  assert.match(mobile, /\.notice\.water-upkeep\{height:auto;min-height:0/);
  assert.match(main, /data-detail="population-growth"/);
  assert.match(main, /data-detail="upkeep-\$\{resource\}"/);
  assert.match(main, /location\.replace\(`\/inventory\//);
});

test('full-page item and recipe searches match localized names without injecting input HTML', () => {
  const account = createAccount(0);
  const state: ApiState = { ...snapshot(account), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.inventory.items = ['survey-satchel', 'torch'];
  const inventory = inventoryPanel(state, () => '', 'all', 'en', 'explore', 0, null, '  SURVEY  ');
  assert.match(inventory, /data-action="inventory-select" data-item="survey-satchel"/);
  assert.doesNotMatch(inventory, /data-action="inventory-select" data-item="torch"/);
  const korean = inventoryPanel(state, () => '', 'all', 'ko', 'explore', 0, null, translate('Survey satchel', 'ko'));
  assert.match(korean, /data-action="inventory-select" data-item="survey-satchel"/);
  const crafting = craftingPanel(state, () => '', 'all', 'explore', 1, 'en', [], null, 0, false, false, 'survey-satchel');
  assert.equal((crafting.match(/class="item-card recipe-card"/g) ?? []).length, 1);
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(inventoryPanel(state, () => '', 'all', 'en', 'explore', 0, null, hostile).includes(hostile), false);
});

test('refinement cores remain visible in inventory and crafting tool filters', () => {
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.inventory.items = ['refinement-core'];
  assert.match(inventoryPanel(state, () => '', 'utility', 'en'), /data-item="refinement-core"/);
  assert.match(craftingPanel(state, () => '', 'utility', 'explore', 1, 'en'), /data-item="refinement-core"/);
});

test('responsive inventory shows 60 desktop, 40 tablet and 20 phone slots without granting storage', () => {
  for (const [width, slots] of [[320, 20], [699, 20], [700, 40], [1199, 40], [1200, 60], [2560, 60]]) {
    assert.equal(inventorySlotsPerPage(width), slots);
  }
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.inventory.storage = 9;
  state.inventory.items = marketAssets.filter(asset => !isMarketResource(asset));
  state.inventory.equipped = 'torch';
  const before = structuredClone(state);
  for (const pageSize of [20, 40, 60]) {
    const seen: string[] = [];
    for (let page = 0; page < Math.ceil(200 / pageSize); page++) {
      const html = inventoryPanel(state, () => '', 'all', 'en', 'explore', page, null, '', pageSize);
      assert.equal((html.match(/class="inventory-slot\b/g) ?? []).length, Math.min(pageSize, 200 - page * pageSize));
      const items = [...html.matchAll(/data-action="inventory-select" data-item="([^"]+)"/g)].map(match => match[1]);
      if (page === 0) assert.equal(items[0], 'torch');
      seen.push(...items);
    }
    assert.equal(new Set(seen).size, state.inventory.items.length);
    assert.equal(seen.length, state.inventory.items.length);
  }
  state.inventory.storage = 0;
  const small = inventoryPanel(state, () => '', 'all', 'en', 'explore', 0, null, '', 60);
  assert.equal((small.match(/class="inventory-slot\b/g) ?? []).length, 20);
  state.inventory.storage = 9;
  assert.deepEqual(state, before);
});

test('inventory breakpoint changes retain the current slot range and rerender only when density changes', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = main.indexOf("for (const breakpoint of ['(min-width: 700px)'");
  const source = main.slice(start, main.indexOf("window.addEventListener('pagehide'", start));
  const callbacks: (() => void)[] = [];
  let renders = 0;
  const context = vm.createContext({
    innerWidth: 1440, inventorySlotsPerPage, inventoryPage: 2, inventoryVisibleSlots: 60,
    inventoryMenuPage: true, renderInventoryPage: () => { renders++; },
    matchMedia: () => ({ addEventListener: (_: string, handler: () => void) => callbacks.push(handler) }),
  });
  vm.runInContext(source, context);
  for (const [width, page, size] of [[768, 3, 40], [375, 6, 20], [1440, 2, 60]]) {
    context.innerWidth = width;
    callbacks.forEach(callback => callback());
    assert.equal(context.inventoryPage, page);
    assert.equal(context.inventoryVisibleSlots, size);
  }
  assert.equal(renders, 3);
});

test('background refreshes restore inventory controls after clearing pending state', async () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const focus = main.slice(main.indexOf("window.addEventListener('focus', async"), main.indexOf("window.addEventListener('pageshow'"));
  const production = main.slice(main.indexOf('async function syncProduction()'), main.indexOf("window.addEventListener('storage'")).replace(': Promise<void>', '');
  for (const fail of [false, true]) {
    let focusHandler: () => Promise<void> = async () => {};
    const restored: boolean[] = [];
    const context = vm.createContext({
      busy: false, inventoryMenuPage: true, document: { hidden: false },
      window: { addEventListener: (_: string, handler: () => Promise<void>) => { focusHandler = handler; } },
      confirmationOpen: () => false,
      refresh: async () => { if (fail) throw new Error('offline'); return {}; },
      synchronize: () => {}, render: () => {}, toast: () => {}, saveCrewAssignments: () => {},
      renderInventoryPage: () => restored.push(context.busy),
    });
    vm.runInContext(focus + production, context);
    await focusHandler();
    await vm.runInContext('syncProduction()', context);
    assert.deepEqual(restored, [false, false]);
    assert.equal(context.busy, false);
  }
});
