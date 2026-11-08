import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { depletionForecast, resourceForecastPanel } from './resource-forecast.ts';
import { createAccount, snapshot } from '../server/economy.ts';
import { newGame } from './engine.ts';

test('depletion forecasts show weekly reserve drawdown and warn at one week or less', () => {
  assert.deepEqual(depletionForecast(250, 100), { weeks: 2.5, status: 'healthy', reserves: [250, 150, 50, 0, 0] });
  assert.equal(depletionForecast(100, 100).status, 'warning');
  assert.equal(depletionForecast(10, 100).status, 'critical');
  assert.equal(depletionForecast(0, 100).weeks, 0);
  assert.deepEqual(depletionForecast(50, 0), { weeks: null, status: 'healthy', reserves: [50, 50, 50, 50, 50] });
  assert.equal(depletionForecast(1000, 100, true).status, 'critical');
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => depletionForecast(value, 100), RangeError);
    assert.throws(() => depletionForecast(100, value), RangeError);
  }
});

test('sidebar charts use owned reserves and authoritative weekly demand with clear localized warnings', () => {
  const account = createAccount(0);
  account.game = { ...newGame(), stage: 0, population: 12 };
  const state = snapshot(account);
  state.waterUpkeep = { readyAt: 1, dailyConsumption: 10, weeklyConsumption: 70, shortage: 0, populationLoss: 0, lastPopulationLoss: 0, paused: false };
  state.settlementUpkeep = { readyAt: 1, paused: false, resources: {
    wood: { dailyConsumption: 1, weeklyConsumption: 7, shortage: 0 },
    metal: { dailyConsumption: 1, weeklyConsumption: 7, shortage: 0 },
  } };
  state.game.stock.water = 35;
  state.pending.water = 100000;
  const html = resourceForecastPanel(state, 'en');
  assert.equal((html.match(/class="reserve-chart"/g) ?? []).length, 3);
  assert.match(html, /~0.5 wk left/);
  assert.match(html, /Depletes within one week/);
  assert.match(html, /700 L \/ game week/);
  assert.match(html, /excludes future collections, crafting and trades/);
  assert.match(html, /href="\/market\/\?asset=water&amp;side=buy"/);
  assert.match(resourceForecastPanel(state, 'ko'), /자원 고갈 예측/);
  assert.match(resourceForecastPanel(state, 'ko'), /1주 이내 고갈/);
  state.waterUpkeep = null;
  assert.equal(resourceForecastPanel(state, 'en'), '');
});

test('reserve charts remain reachable on small screens and progress transitions override static UI rules', () => {
  const layout = readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8');
  const game = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  assert.match(layout, /#app\.explore-page #sidebar-content>\.explore-upkeep\{display:block;grid-column:1\/-1\}/);
  assert.match(layout, /max-height:min\(45dvh,/);
  assert.match(layout, /#app\.explore-page #sidebar-content>\.explore-upkeep\{order:3\}/);
  const motion = game.slice(game.indexOf('@media(prefers-reduced-motion:no-preference)'), game.indexOf('#app .topbar button'));
  assert.match(motion, /\.completion-meter::after\{transition:transform 1s linear!important/);
  assert.match(motion, /\.clock-day-fill,#app \.clock-season::before\{transition:transform 5s linear!important/);
  assert.match(motion, /progress::-webkit-progress-value\{transition:width \.6s ease!important/);
  assert.match(motion, /progress::-moz-progress-bar\{transition:width \.6s ease!important/);
});
