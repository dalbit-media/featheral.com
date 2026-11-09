import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAccount, snapshot } from '../server/economy.ts';
import { inventory } from '../server/inventory.ts';
import type { ApiState } from './api-types.ts';
import { marketAssets, isMarketResource } from './market.ts';
import { itemArt } from './item-art.ts';
import { itemDescription, itemDetailRows } from './item-details.ts';
import { buildingArt } from './building-art.ts';
import { settlementLayoutPanel, settlementObjectDescription, settlementScene } from './settlement-scene.ts';
import { settlementBuildings } from './settlement-layout.ts';
import { settlementSectionNavigation, settlementTasks } from './settlement-ui.ts';
import { icon } from './icons.ts';
import { translate } from './i18n.ts';

test('every item renders one self-contained illustrated SVG and translated category/effect/use details without changing state', () => {
  const account = createAccount(0), before = structuredClone(account);
  for (const id of marketAssets) {
    if (isMarketResource(id)) continue;
    const art = itemArt(id), details = itemDescription(id);
    assert.equal((art.match(/<svg/g) ?? []).length, 1, id);
    assert.match(art, /aria-hidden="true"/);
    assert.match(art, /data-item-art=/);
    assert.doesNotMatch(art, /undefined|NaN|<script|<image|url\(/);
    for (const text of Object.values(details)) {
      assert.ok(text.length > 0, id);
      assert.notEqual(translate(text, 'ko'), text, `${id}: ${text}`);
    }
    const html = itemDetailRows(id, 'en', 2, 1);
    assert.match(html, /How to use/);
    assert.match(html, /Available copies/);
  }
  assert.deepEqual(account, before);
  assert.equal(icon('tools'), icon('tool'));
  assert.match(icon('water'), /icon-tone/);
  assert.equal(new Set(['bank', 'home', 'water', 'market', 'tool'].map(buildingArt)).size, 5);
});
test('settlement object inspectors explain every active building and deduplicate stacked decorations', () => {
  const account = createAccount(0);
  account.game.stage = 8;
  account.game.bank = true; account.game.townhall = true;
  account.game.waterFacilities = { well: true, rainCollector: true, pumpingStation: true };
  account.game.incomeFacilities = { 'market-stall': true, 'trade-hub': true };
  account.game.constructionLevels = { housing: 1, cistern: 1, workshop: 1, logistics: 1 };
  inventory(account).items.push('bench', 'bench');
  const state: ApiState = { ...snapshot(account), csrf: 'test', clockSpeed: 1, population: { global: 0, federation: null } };
  const before = structuredClone(state);
  for (const building of settlementBuildings(state.game)) {
    const description = settlementObjectDescription(building.id);
    assert.ok(description, building.id);
    assert.notEqual(translate(description, 'ko'), description);
    assert.match(settlementLayoutPanel(state, building.id, 'en'), /layout-inspector-description/);
  }
  assert.equal((settlementLayoutPanel(state, 'bench', 'en').match(/data-action="select-building" data-entity="bench"/g) ?? []).length, 1);
  assert.match(settlementScene(state, 'en'), /No active upkeep shortage/);
  state.waterUpkeep = { ...state.waterUpkeep!, paused: true };
  assert.match(settlementScene(state, 'en'), /Supplies need attention/);
  state.waterUpkeep = before.waterUpkeep;
  assert.deepEqual(state, before);
  for (const task of Object.values(settlementTasks)) assert.notEqual(translate(task.description, 'ko'), task.description);
});
test('settlement section navigation exposes all tasks, current selection and translated labels', () => {
  for (const task of Object.keys(settlementTasks) as (keyof typeof settlementTasks)[]) {
    const markup = settlementSectionNavigation(task, 'en');
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(markup, new RegExp(`data-settlement-panel="${task}"[^>]*aria-pressed="true"`));
    assert.equal((markup.match(/aria-controls="settlement-task-panel"/g) ?? []).length, 8);
  }
  const korean = settlementSectionNavigation('inventory', 'ko');
  assert.ok(korean.includes(translate('Settlement sections', 'ko')));
  assert.ok(korean.includes(translate('Inventory', 'ko')));
});
