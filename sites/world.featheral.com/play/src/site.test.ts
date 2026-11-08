import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { formatPublicTotal, publicSite, resolvePublicSite } from './site.ts';
import { landingSeo, whitepaperPage, worldProfileAssets } from '../vite.config.ts';
import { newGame, stages, terrainDetails } from './engine.ts';
import { settlementLayoutPanel, settlementProfile, settlementScene } from './settlement-scene.ts';
import { cellKey, legacySpaceCells, positionEntries, settlementBuildings, settlementPositions, validSettlementCell } from './settlement-layout.ts';
import { explorationFringe, project, unproject, tileWidth, tileHeight } from './map-art.ts';
import { dayPhaseIcon, environmentDetails, environmentEffects, overallWeatherImpact } from './environment-view.ts';
import { environmentAt, seasonMs, worldEpoch } from './environment.ts';
import { icon } from './icons.ts';
import type { ItemInventory } from './items.ts';
import { craftableKeys, inventoryUsed, itemStacks, itemStorage } from './items.ts';
import { inventoryPanel, craftingPanel } from './inventory-view.ts';
import { isSettlementTask, settlementDockTasks, settlementTaskFromHash } from './settlement-ui.ts';
import { createAccount, snapshot } from '../server/economy.ts';
import type { ApiState } from './api-types.ts';
import { isMarketAsset, marketAssets, marketBasePrice } from './market.ts';
import { waterFacilityKeys, waterFacilities } from './water-facilities.ts';
import { filterMarketCatalog, marketOwned, renderMarketCatalog } from './marketplace-catalog.ts';
import { translate } from './i18n.ts';
import { mediaMatchesWidth } from './screen-preview.ts';

test('compact social controls preserve accessible labels, search feedback, per-room drafts and safe send retries', () => {
  const inbox = readFileSync(new URL('./inbox.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./communicate.ts', import.meta.url), 'utf8');
  assert.match(inbox, /data-inbox-search[^>]*aria-label="Search channels"/);
  assert.match(inbox, /this\.drafts\.set\(this\.selected/);
  assert.match(inbox, /this\.drafts\.get\(room\.id\)/);
  assert.match(inbox, /this\.query\.trim\(\) && !matchesCount \? 'No matching channels\.'/);
  assert.match(inbox, /channel === 'federation' && value\.kind === 'federation'/);
  assert.match(chat, /chat-message-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(chat, /summary title="Chat rules" aria-label="Chat rules"/);
  assert.match(chat, /!event\.shiftKey && !event\.isComposing/);
  assert.match(chat, /this\.submission \?\?= \{ id: crypto\.randomUUID\(\)/);
  assert.match(chat, /chatSend\(this\.csrf\(\), this\.submission, this\.room\)/);
  assert.match(chat, /this\.sendFailed \? 'Retry send'/);
  assert.match(chat, /this\.visible\(\) && this\.atBottom\(\)/);
});

test('2D maps start closer, repaint on interaction and stop painting unchanged scenes', () => {
  for (const name of ['World', 'SettlementMap']) {
    const file = name === 'World' ? './world.ts' : './settlement-map.ts';
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = stripTypeScriptTypes(source.slice(source.indexOf(`export class ${name}`)).replace('export class', 'class'));
    let paints = 0;
    const calls: Record<string, (event: Record<string, number>) => void> = {};
    const drawing = new Proxy({ clearRect: () => { paints++; }, createRadialGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 20 }) }, {
      get(target, key) { return Reflect.get(target, key) ?? (() => {}); },
    });
    const canvas = { isConnected: true, width: 0, height: 0, getContext: () => drawing,
      getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      addEventListener: (event: string, callback: typeof calls[string]) => { calls[event] = callback; },
      setPointerCapture() {}, focus() {}, setAttribute() {} };
    const context = {
      document: { hidden: false, createElement: () => canvas }, devicePixelRatio: 1, requestAnimationFrame: () => 1,
      ResizeObserver: class { observe() {} }, Image: class { complete = false; src = ''; },
      decorationItems: {}, isDecorationItem: () => false, isWaterFacility: () => false,
      hash: () => .2, radius: () => 3, terrainAt: () => 'grassland', terrainColors: {},
      explorationFringe: () => new Map(), project, unproject, tileWidth, tileHeight,
      drawDiamond() {}, drawHouse() {}, drawTree() {}, drawEnvironment() {}, tileColor: () => '#123456',
      settlementPositions: () => ({}), positionEntries: () => [], settlementTerrain: () => 'grassland',
      settlementRadius: 8, cellKey,
    };
    const Renderer = runInNewContext(`${code}; ${name};`, context);
    const state = { ...snapshot(createAccount(0)), csrf: 'test', population: { global: 0, federation: null }, clockSpeed: 1 };
    const environment = environmentAt(worldEpoch);
    const renderer = name === 'World'
      ? new Renderer(canvas, canvas, () => state.game, () => {}, () => environment)
      : new Renderer(canvas, () => ({ state, environment, editing: false, selected: null, pending: null }), () => {}, () => {}, 'en', () => {});
    renderer.resize();
    assert.equal(renderer.zoom, name === 'World' ? 1.55 : 2.1);
    renderer.frame(16);
    const initialPaints = paints;
    assert.ok(initialPaints > 0);
    for (let frame = 32; frame <= 1000; frame += 16) renderer.frame(frame);
    assert.equal(paints, initialPaints, 'unchanged scenes must not redraw terrain or fog');
    renderer.scale(.15); renderer.frame(1024);
    assert.ok(paints > initialPaints, 'zoom must repaint on the next frame');
    const zoomPaints = paints;
    calls.pointerdown({ clientX: 400, clientY: 300, pointerId: 1, button: 0 });
    calls.pointermove({ clientX: 460, clientY: 350, pointerId: 1 });
    renderer.frame(1040);
    assert.ok(paints > zoomPaints, 'panning must repaint without a low-frame-rate throttle');
    context.document.hidden = true;
    const hiddenPaints = paints;
    renderer.scale(.15); renderer.frame(1056);
    assert.equal(paints, hiddenPaints);
    context.document.hidden = false; renderer.frame(1072);
    assert.ok(paints > hiddenPaints);
  }
});

test('collection readiness uses a visible text badge and game/header controls stay static and borderless', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../../../../shared/site-links.css', import.meta.url), 'utf8');
  assert.match(main, /collection-ready'\)!\.textContent = ready \? translate\('Collect', language\)/);
  assert.match(css, /\.collection-ready\{[^}]*background:var\(--mint\);color:#102016/);
  assert.match(css, /#app \*,#app \*::before,#app \*::after\{animation:none!important;transition:none!important/);
  assert.match(css, /#app \.topbar button[^}]*border:0;box-shadow:none/);
  assert.match(shared, /body>header button,#app>header button,header\.topbar button\{border:0!important/);
  assert.doesNotMatch(main.slice(main.indexOf('function showClaimFeedback'), main.indexOf('function wireResourceTooltips')), /claim-ring|claim-spark/);
});

test('calendar animation bounds updates to ten per second and pauses when hidden or reduced-motion', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(main.slice(main.indexOf('let clockFrame:'), main.indexOf('function scheduleClockAnimation()')));
  let timestamp = 0, updates = 0;
  const context = {
    document: { hidden: false }, clockMotion: { matches: false }, state: { serverTime: 0, clockSpeed: 33.6 },
    performance: { now: () => timestamp }, synchronizedAt: 0, clockCalendar: {},
    displayServerTime: () => timestamp, updateClockTime: () => { updates++; }, requestAnimationFrame: () => 1,
  };
  const tick = runInNewContext(`${code}; animateClock;`, context);
  for (timestamp = 0; timestamp < 1000; timestamp += 10) tick(timestamp);
  assert.equal(updates, 10);
  context.document.hidden = true; timestamp = 1000; tick(timestamp); assert.equal(updates, 10);
  context.document.hidden = false; context.clockMotion.matches = true; tick(timestamp); assert.equal(updates, 10);
});

test('deadline refresh includes off-cycle crews and retries without polling hidden or busy views', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const timer = main.slice(main.indexOf('let nextDeadlineSyncAt = 0;'), main.indexOf('settlementResourceSale = new SettlementSale'));
  const crews: Record<string, { readyAt: number }> = { wood: { readyAt: 1000 } };
  let tick = () => { throw new Error('Deadline timer was not registered.'); };
  let timestamp = 999, realTime = 0, requests = 0, confirming = false;
  const context = {
    state: { workforce: { cycleAt: 60000, crews, expeditions: [{ readyAt: 2000 }] }, recruitment: { readyAt: 3000 }, serverTime: 0, clockSpeed: 168 },
    game: { stage: 0 }, document: { hidden: false }, busy: false, synchronizedAt: 0,
    performance: { now: () => realTime }, renderEnvironment: () => {},
    displayServerTime: () => timestamp, confirmationOpen: () => confirming,
    syncProduction: () => { requests++; },
    setInterval: (callback: () => void, interval: number) => { assert.equal(interval, 1000); tick = callback; },
  };
  runInNewContext(timer, context);
  tick(); assert.equal(requests, 0);
  timestamp = 1000; tick(); assert.equal(requests, 1);
  realTime = 4999; tick(); assert.equal(requests, 1);
  realTime = 5000; tick(); assert.equal(requests, 2);
  delete crews.wood; tick(); assert.equal(requests, 2);
  timestamp = 2000; realTime = 10000;
  context.document.hidden = true; tick(); assert.equal(requests, 2);
  context.document.hidden = false; context.busy = true; tick(); assert.equal(requests, 2);
  context.busy = false; confirming = true; tick(); assert.equal(requests, 2);
  confirming = false; tick(); assert.equal(requests, 3);
  context.state.workforce.expeditions = []; timestamp = 3000; realTime = 15000;
  tick(); assert.equal(requests, 4);
});

test('every Play game entry loads the canonical World wallet/profile assets', () => {
  const plugin = worldProfileAssets();
  const transform = typeof plugin.transformIndexHtml === 'object' ? plugin.transformIndexHtml.handler : plugin.transformIndexHtml;
  assert.equal(typeof transform, 'function');
  if (typeof transform !== 'function') throw new Error('Missing profile asset transform');
  for (const file of ['explore/index.html', ...['settlement', 'market', 'communicate', 'federation', 'contacts', 'journal', 'help', 'bank'].map(route => `${route}/index.html`)]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const tags = transform(html, { path: file, filename: file });
    assert.ok(Array.isArray(tags));
    assert.deepEqual(tags.map(tag => tag.attrs?.href ?? tag.attrs?.src), ['/shared/wallet-profile.css', '/shared/wallet-profile.js', '/shared/featheral.css', '/shared/site-links.js']);
    assert.ok(tags.every(tag => tag.attrs?.['vite-ignore'] === true));
    assert.ok(tags.filter(tag => tag.tag === 'script').every(tag => !tag.attrs?.type));
  }
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const asset of ['featheral.css', 'wallet-profile.css', 'site-links.js', 'wallet-profile.js']) {
    assert.ok(landing.includes(`/shared/${asset}" vite-ignore`));
  }
  assert.equal(transform('<script src="/src/landing.ts"></script>', { path: '/about/', filename: 'about/index.html' }), undefined);
});

test('unexplored terrain fades smoothly within four tiles of any explored boundary without discovery', () => {
  const known = new Set(['0,0', '1,0', '0,1', '1,1', '12,-7']);
  const before = [...known], fringe = explorationFringe(known);
  assert.deepEqual([...known], before);
  assert.equal(explorationFringe(new Set()).size, 0);
  for (const key of known) assert.equal(fringe.has(key), false);
  for (const [key, clarity] of fringe) {
    const [x, y] = key.split(',').map(Number);
    const distance = Math.min(...before.map(cell => {
      const [kx, ky] = cell.split(',').map(Number);
      return Math.hypot(x - kx, y - ky);
    }));
    assert.ok(distance < 4);
    const t = distance / 4;
    assert.ok(Math.abs(clarity - .7 * (1 - t * t * (3 - 2 * t))) < 1e-12);
  }
  assert.ok(fringe.get('-1,0')! > fringe.get('-2,0')!);
  assert.ok(fringe.get('-2,0')! > fringe.get('-3,0')!);
  assert.equal(fringe.has('-4,0'), false);
  assert.equal(fringe.get('12,-8'), fringe.get('-1,0'));
  const expanded = explorationFringe(new Set([...known, '-1,0']));
  assert.equal(expanded.has('-1,0'), false);
  assert.ok(expanded.get('-3,0')! > fringe.get('-3,0')!);
});
test('white paper is built as its own HTML page with complete Korean and English documents', async () => {
  const template = readFileSync(new URL('../whitepaper/index.html', import.meta.url), 'utf8');
  const transform = whitepaperPage().transformIndexHtml;
  assert.ok(typeof transform === 'function');
  for (const path of ['/whitepaper/', '/whitepaper/index.html']) {
    const html = await transform(template, { path, filename: 'whitepaper/index.html' });
    assert.ok(typeof html === 'string');
    assert.doesNotMatch(html, /<!-- WHITEPAPER_/);
    assert.match(html, /우리가 만들고 싶은 경험/);
    assert.match(html, /What is playable today/);
    assert.match(html, /<template id="whitepaper-english">/);
  }
  assert.equal(await transform(template, { path: '/', filename: 'index.html' }), undefined);
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /'whitepaper\/index': resolve\('whitepaper', 'index.html'\)/);
});

test('owned Water facilities appear on the shared settlement grid with stable collision-free positions', () => {
  const account = createAccount(1000000);
  account.game.stage = 8; account.game.population = 100;
  const before = snapshot(account), positions = settlementPositions(before.game, before.inventory);
  for (const key of waterFacilityKeys) account.game.waterFacilities = { ...account.game.waterFacilities, [key]: true };
  const state = snapshot(account), buildings = settlementBuildings(state.game);
  for (const key of waterFacilityKeys) {
    assert.ok(buildings.some(building => building.id === key && building.name === waterFacilities[key].name && building.task === 'buildings'));
    assert.ok(icon(key).includes('<svg'));
  }
  state.inventory.layout.positions = positions;
  const next = settlementPositions(state.game, state.inventory);
  for (const [id, cell] of positionEntries(positions)) assert.deepEqual(next[id], cell);
  assert.equal(new Set(Object.values(next).map(cell => cellKey(cell!))).size, Object.keys(next).length);
  const panel = settlementLayoutPanel(state, 'well', 'ko');
  assert.match(panel, /우물/);
  for (const key of waterFacilityKeys) assert.match(panel, new RegExp(`data-entity="${key}"`));
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /waterUpgradeCards\(state, language\)/);
  assert.match(readFileSync(new URL('./upgrade-view.ts', import.meta.url), 'utf8'), /action: 'water-facility'/);
  assert.match(main, /case 'water-facility':/);
  assert.match(main, /isWaterFacility\(target.dataset.facility\)/);
});
test('public entry points, simulator exports and white paper use the Featheral brand', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const landing = read('../index.html');
  assert.match(landing, /<title>Getting started · Featheral World/);
  assert.match(landing, /class="top world-header"/);
  assert.match(landing, /class="eco-bar" aria-label="Featheral sites"/);
  assert.match(landing, /href="\/shared\/featheral\.css"/);
  assert.match(landing, /src="\/shared\/wallet-profile\.js"/);
  assert.match(landing, /src="\/shared\/site-links\.js"/);
  assert.doesNotMatch(landing, /class="site-header"|class="mobile-menu"/);
  assert.match(landing, /<html lang="ko">/);
  assert.match(landing, /src="\/images\/featheral-world\.svg"/);
  assert.match(read('../public/images/featheral-world.svg'), /^<svg/);
  assert.match(read('../explore/index.html'), /<title>Featheral 플레이 \|/);
  assert.match(read('../explore/index.html'), /<html lang="ko">/);
  const simulator = read('./main.ts');
  assert.doesNotMatch(simulator, /class="wordmark play-brand"/);
  assert.match(read('./journal.ts'), /'featheral-recovery\.json' : 'featheral-world\.json'/);
  assert.match(read('../public/WHITEPAPER.md'), /^# Featheral\r?\n/);
  assert.match(read('../public/WHITEPAPER.ko.md'), /^# Featheral\r?\n/);
  const preview = readFileSync(new URL('../public/images/social-preview-ko.png', import.meta.url));
  assert.equal(preview.readUInt32BE(16), 1200);
  assert.equal(preview.readUInt32BE(20), 630);
  assert.match(landing, /href="\/whitepaper\/"/);
  assert.match(landing, /href="\/"/);
  assert.doesNotMatch(landing, /WHITEPAPER.*\.md|백서[^<]*\(\.md\)/);
  assert.match(landing, /property="og:locale" content="ko_KR"/);
  assert.doesNotMatch(landing, /\bTerra\b|>\s*terra(?=<)/);
});

test('language selection is available only in the landing footer, not the header or game', () => {
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const header = landing.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  const footer = landing.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
  assert.ok(header);
  assert.ok(footer);
  assert.equal(landing.match(/<select\b[^>]*data-language/g)?.length, 1);
  assert.doesNotMatch(header, /data-language|language-picker/);
  assert.match(footer, /<select data-language aria-label="언어">/);
  assert.match(footer, /<option value="ko">한국어<\/option><option value="en">English<\/option>/);
  const simulator = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(simulator, /languageControl|language-picker|data-language|wireLanguageControls/);
  assert.match(simulator, /import \{ language, languageLocale, localize \}/);
  assert.doesNotMatch(readFileSync(new URL('../explore/index.html', import.meta.url), 'utf8'), /data-language|language-picker/);
});
test('World roadmap identifies the active phase and keeps revenue, synergy and governance planned in both languages', () => {
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const roadmap = landing.match(/<section id="roadmap"[\s\S]*?<\/section>/)?.[0];
  assert.ok(roadmap);
  for (const text of [
    'Current phase: World building', 'World roadmap', 'Full ecosystem roadmap',
    'Now: Perfect the world', 'Next: A sustainable standalone business',
    'Then: Connected business synergy', 'Future: Web3 governance for future innovators',
  ]) {
    assert.ok(roadmap.includes(text), text);
    assert.notEqual(translate(text, 'ko'), text);
    assert.equal(translate(translate(text, 'ko'), 'en'), text);
  }
  assert.match(roadmap, /data-site="foundation" data-path="\/#roadmap"/);
  assert.match(roadmap, /relic pools start with 100 units, other assets with 10,000/);
  assert.match(roadmap, /not Foundation governance/);
  assert.match(roadmap, /World building is active; revenue experiments, deeper integrations and decentralized governance are planned/);
});
test('settlement has a dedicated production entry and the header has individual resource controls without aggregate claim', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../settlement/index.html', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(page, /<html lang="ko">/);
  assert.match(page, /noindex,follow/);
  assert.match(page, /src="\/src\/main.ts"/);
  assert.match(vite, /'settlement\/index': resolve\('settlement', 'index.html'\)/);
  assert.match(main, /href="\/settlement\/#inventory"/);
  assert.doesNotMatch(main, /claim-all/);
  assert.match(main, /data-action="resource-management"/);
  assert.match(main, /data-action="funds-management"/);
  assert.doesNotMatch(main, /claim-resource|data-action="light"|<h3>Lighting/);
  assert.match(main, /if \(!explorePage \|\| event.target instanceof HTMLInputElement/);
  assert.match(main, /event.target instanceof HTMLTextAreaElement/);
  assert.doesNotMatch(page, /data-language|language-picker/);
});
test('shared population header labels active and idle residents from authoritative workforce counts', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /class="population-health" data-action="population-management"/);
  assert.doesNotMatch(main, /population-label/);
  assert.match(main, /const idle = state\.availableWorkers, active = game\.population - idle/);
  assert.match(main, /data-population-active/);
  assert.match(main, /data-population-idle/);
  assert.match(main, /data-population-total/);
  assert.match(main, /management === 'population'/);
  assert.match(main, /populationManagement\(\)/);
  assert.match(main, /`Population: \$\{fmt\(game\.population\)\} residents/);
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.population-label/);
  assert.match(css, /grid-template-rows:28px 11px/);
  assert.match(css, /\.population-count\{height:32px;align-items:center\}/);
  assert.match(css, /\.population-count>\.icon\{width:18px;height:18px;align-self:center\}/);
});
test('manual population allocation pairs sliders and exact counts with shared draft restoration', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /id="crew-slider-\$\{resource\}"[^>]*type="range"[^>]*step="1"/);
  assert.match(main, /id="crew-\$\{resource\}" type="number"/);
  assert.match(main, /if \(event.target.type === 'range'\) number.value = event.target.value/);
  assert.match(main, /crewDrafts.set\(number.id, number.value\)/);
  assert.match(main, /querySelectorAll<HTMLElement>\('\.crew-controls'\)\.forEach\(syncCrewControls\)/);
  assert.match(main, /if \(valid\) slider.value = number.value/);
  assert.match(main, /error.hidden = valid \|\| number.disabled/);
  assert.doesNotMatch(main, /data-action="assign"/);
  assert.match(main, /app.addEventListener\('change'/);
  assert.match(main, /app.addEventListener\('focusout'/);
  assert.match(main, /event.key === 'Enter'[\s\S]*?requestCrewAssignment/);
  assert.match(main, /pendingCrewAssignments.set\(resource, input.value\)/);
  assert.match(main, /const \[resource, draft\] = pendingCrewAssignments.entries/);
  assert.match(main, /workers > maximum/);
  assert.match(main, /const saved = await act\(\{ type: 'assign', resource, workers \}\)/);
  assert.match(main, /if \(!saved\) failedCrewAssignments.add\(resource\)/);
  assert.match(main, /data-action="retry-assign"/);
  assert.match(main, /data-action="crew-step" data-step="-1"/);
  assert.match(main, /data-action="crew-step" data-step="1"/);
  assert.doesNotMatch(main, /work\.automatic \|\| !access\.available \? 'disabled'/);
  assert.match(main, /Math\.max\(2, explorers\)/);
});
test('direct claims skip review while other gameplay and market payments retain cancellable confirmation', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const market = readFileSync(new URL('./marketplace.ts', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('./confirmation.ts', import.meta.url), 'utf8');
  assert.match(main, /const quote = gameConsumption\(state, command\)/);
  assert.match(main, /if \(quote && command.type !== 'claim'\)/);
  assert.match(main, /if \(!await confirmConsumption\(quote, language\)\) return false/);
  assert.match(main, /JSON\.stringify\(gameConsumption\(state, command\)\) !== JSON\.stringify\(quote\)/);
  assert.match(main, /if \(confirmationOpen\(\)\) return;/);
  assert.doesNotMatch(main, /\bconfirm\(/);
  assert.match(market, /const quote = marketConsumption\(command\)/);
  assert.match(market, /if \(quote && !await confirmConsumption\(quote, this\.language\)\) return/);
  assert.match(dialog, /dialog\.showModal\(\)/);
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.match(dialog, /cancel\.autofocus = true/);
  assert.match(dialog, /trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(dialog, /confirm\.disabled = true/);
});
test('resource tooltips distinguish weekly collection and transport from daily population Water', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const resources = main.slice(main.indexOf('function renderResources()'), main.indexOf('function gearCard()'));
  assert.match(resources, /dailyUse = key === 'water' \? state\.waterUpkeep\?\.dailyConsumption \?\? 0/);
  assert.match(resources, /state\.settlementUpkeep\?\.resources\[key\]\.dailyConsumption/);
  assert.match(resources, /consumption = key === 'water' \? dailyUse : state\.workforce\.crews\[key\]\?\.weeklyDollarsCost \?\? 0/);
  assert.match(resources, /rate = state\.rates\[key\]/);
  assert.match(resources, /'Resource flow' : '1 game week'/);
  assert.match(resources, /'Collection \/ week' : 'Collection'/);
  assert.match(resources, /'Consumption \/ day' : 'FTH\$ transport \/ week'/);
  assert.match(resources, /rate \? '\+' : ''/);
  assert.match(resources, /consumption \? '&minus;' : ''/);
  assert.match(resources, /resource-flow-zero/);
  assert.doesNotMatch(resources, /Server update:|Refreshes every|<dt>Warehouse<\/dt>|Allocation balances automatically/);
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.resource-tooltip dd\.resource-inflow\{color:#9edb9f\}/);
  assert.match(css, /\.resource-tooltip dd\.resource-outflow\{color:#ffaaa3\}/);
});
test('marketplace has its own entry, complete tradable catalog and FTH$ quote currency', () => {
  const page = readFileSync(new URL('../market/index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(page, /<html lang="ko">/);
  assert.match(page, /noindex,follow/);
  assert.match(vite, /'market\/index': resolve\('market', 'index.html'\)/);
  assert.match(main, /href=.*\/market\//);
  assert.match(main, /new Marketplace/);
  assert.doesNotMatch(main, /function marketPanel|Simulated market · Fixed prices|type: 'trade'/);
  assert.equal(marketAssets.length, 81);
  assert.equal(new Set(marketAssets).size, marketAssets.length);
  for (const asset of marketAssets) { assert.ok(isMarketAsset(asset)); assert.ok(marketBasePrice(asset) > 0); }
  assert.equal(isMarketAsset('metal'), true);
  for (const asset of ['fthg', 'dollars', 'lithium', 'gold', '__proto__', 'relic-unknown', 'home-0', null]) assert.equal(isMarketAsset(asset), false);
});
test('marketplace removes banners and uses plain buying and selling labels without removing either pricing mode', () => {
  const source = readFileSync(new URL('./marketplace.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /exchange-conversion|exchange-disclaimer|data-market-convert|data-market-metal|IN-GAME EXCHANGE/);
  assert.match(source, /data-market-mode="spot"[^>]*>Now</);
  assert.match(source, /data-market-mode="limit"[^>]*>Choose price</);
  assert.match(source, /data-market-side="buy"/);
  assert.match(source, /data-market-side="sell"/);
  assert.match(source, /renderMarketCatalog/);
  assert.match(source, /data-market-view="grid"/);
  assert.match(source, /data-market-view="table"/);
  assert.match(source, /<details class="exchange-help">/);
  assert.doesNotMatch(source, />Spot<|>Limit order<|>Bids<|>Asks<|>Order book<|System liquidity|escrow|executions/);
});
test('Inbox menu is shared by game pages and retains a bounded, text-only chat view across state refreshes', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./communicate.ts', import.meta.url), 'utf8');
  assert.match(main, /primaryGamePageKeys\.map\(key => `<a class="nav-button/);
  assert.match(main, /navigationPage === 'communicate'[\s\S]*if \(!root\.childElementCount\)/);
  assert.match(main, /addEventListener\('pagehide'/);
  assert.match(main, /event\.persisted && \(navigationPage === 'communicate'/);
  assert.doesNotMatch(main, /activePanel|openPanel|modal-root|modal-backdrop/);
  assert.match(main, /inbox\?\.close\(\)/);
  assert.match(chat, /new EventSource\(`\/api\/chat\/events/);
  assert.match(chat, /slice\(-chatHistoryLimit\)/);
  assert.match(chat, /text\.textContent = message\.text/);
  assert.match(chat, /node\.dataset\.noLocalize = ''/);
  assert.match(chat, /!event\.isComposing/);
  assert.match(main, /event\.target\.closest\('\.world-chat'\)/);
  assert.match(main, /aria-labelledby="world-chat-title"/);
  assert.doesNotMatch(main, /socialDialog|social-toggle|social-dialog/);
  assert.match(main, /new Inbox\(root, \(\) => state\.csrf, language, false, true\)/);
  assert.match(main, /mountWorldChat\(\)/);
  const inbox = readFileSync(new URL('./inbox.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./communicate.css', import.meta.url), 'utf8');
  assert.match(inbox, /value\.kind === 'explore' && value\.settlement === directory\.ownSettlement/);
  assert.match(inbox, /if \(room\.id === this\.selected && this\.chat\)/);
  assert.doesNotMatch(css, /\.inbox-page\{min-height:600px/);
  assert.doesNotMatch(chat, /data-chat-nickname|data-chat-rename|chatProfile\(/);
  assert.match(chat, /window\.removeEventListener\(chatProfileChangedEvent/);
  const layout = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  assert.match(shell, /#app \.inbox-layout\{gap:20px;grid-template-columns:280px minmax\(0,1fr\)\}/);
  assert.match(layout, /backdrop-filter:blur\(12px\)/);
});
test('Explore tile information and weather share one bounded inspector apart from map controls', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(main, /id="explore-sidebar"[^]*?id="sidebar-content"[^]*?class="location-card"[^]*?data-map-environment/);
  assert.match(main, /aria-labelledby="current-tile-title"/);
  assert.match(main, /class="tile-coordinates" aria-label="Tile coordinates"><span data-no-localize/);
  assert.match(main, /resourceFmt\(resource, state\.pending\[resource\]\)/);
  assert.match(main, /if \(explorePage\) \{\s*const terrain[^]*?document\.querySelector\('#location-card'\)/);
  assert.doesNotMatch(main, /resources\.reduce\(\(sum, r\) => sum \+ state\.pending\[r\]/);
  assert.match(layout, /\.has-world-chat \.sidebar\{[^}]*top:var\(--scene-top\)[^}]*max-height:calc/);
  assert.match(layout, /\.has-world-chat \.location-card\{position:static;display:grid;grid-template-columns:minmax\(0,1fr\);[^}]*width:100%;[^}]*max-width:100%/);
  assert.match(layout, /\.has-world-chat \.location-card \.gather-button\{[^}]*min-width:44px;min-height:44px/);
  assert.match(layout, /#app\.has-world-chat \.map-environment\{position:static;display:flex;flex-wrap:wrap/);
  assert.match(layout, /\.has-world-chat \.map-toolbar\{left:var\(--scene-left\);right:auto;top:auto/);
  assert.match(layout, /\.has-world-chat\.chat-expanded \.sidebar/);
});
test('settlement visuals grow through every tier with distinct town and city architecture', () => {
  const game = newGame(), bag: ItemInventory = { version: 1, items: [], pending: [], equipped: null, storage: 0 };
  let previous = 0;
  for (let stage = 0; stage < stages.length; stage++) {
    game.stage = stage;
    const profile = settlementProfile(stage), buildings = settlementBuildings(game), positions = settlementPositions(game, bag);
    assert.equal(profile.name, stages[stage].name);
    assert.ok(profile.homes > previous);
    previous = profile.homes;
    assert.equal(buildings.filter(building => building.id.startsWith('home-')).length, profile.homes);
    assert.ok(buildings.some(building => building.id === 'workshop'));
    assert.ok(buildings.some(building => building.id === 'supplies'));
    const cells = positionEntries(positions).map(([, cell]) => { assert.ok(validSettlementCell(cell)); return cellKey(cell); });
    assert.equal(new Set(cells).size, cells.length);
    assert.equal(profile.style, stage >= 6 ? 'city' : stage >= 4 ? 'town' : stage >= 3 ? 'village' : 'camp');
  }
  game.stage = -1;
  assert.deepEqual(settlementBuildings(game), []);
});
test('both maps share season, day phase and weather indicators with distinct icons', () => {
  for (const [index, seasonIcon] of ['flower', 'sun', 'leaf', 'snowflake'].entries()) {
    const environment = environmentAt(worldEpoch + index * seasonMs);
    const overlay = environmentDetails(environment);
    assert.ok(overlay.includes(icon(seasonIcon, 'season-icon')));
    assert.ok(overlay.includes(`<span>${environment.season}</span>`));
    assert.ok(overlay.includes(`<span>${environment.phase}</span>`));
    assert.match(overlay, /class="map-environment-weather"/);
    assert.ok(overlay.includes(`${environment.temperature}°C`));
  }
  for (const [hour, expected] of [[0, 'moon'], [5, 'sunrise'], [7, 'sun'], [18, 'sunset'], [20, 'moon']] as const) {
    const environment = environmentAt(worldEpoch + hour * 60000);
    assert.equal(dayPhaseIcon(environment.phase), icon(expected, 'phase-icon'));
    assert.ok(environmentDetails(environment).includes(dayPhaseIcon(environment.phase)));
  }
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'ui-test', population: { global: 0, federation: null }, clockSpeed: 1 };
  assert.doesNotMatch(settlementScene(state, 'en'), /data-map-environment/);
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /class="weather-overlay" aria-label="World conditions"><div data-map-environment/);
  assert.doesNotMatch(main.match(/calendar\.innerHTML = [^\n]+/)?.[0] ?? '', /environment\.season/);
  assert.match(main, /class="resource-accrual"><div class="resource-progress"[^]*?<span class="resource-pending"><\/span><\/div>/);
});
test('legacy named spaces project onto unique grid cells without changing saved state', () => {
  const game = newGame(), bag: ItemInventory = { version: 1, storage: 2, items: ['bench', 'planter'], pending: [], equipped: null,
    placements: { square: 'bench', garden: 'planter' } };
  const before = structuredClone({ game, bag }), positions = settlementPositions(game, bag);
  assert.equal(Object.keys(legacySpaceCells).length, 6);
  for (const cell of Object.values(legacySpaceCells)) assert.ok(validSettlementCell(cell));
  assert.equal(new Set(Object.values(legacySpaceCells).map(cellKey)).size, 6);
  assert.deepEqual(positions.bench, legacySpaceCells.square);
  assert.deepEqual(positions.planter, legacySpaceCells.garden);
  assert.deepEqual({ game, bag }, before);
});
test('exploration and settlement share exact isometric projection and inverse selection geometry', () => {
  assert.equal(tileWidth, 78);
  assert.equal(tileHeight, 40);
  assert.deepEqual(project(1, 0), { x: 39, y: 20 });
  assert.deepEqual(project(0, 1), { x: -39, y: 20 });
  for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) {
    const screen = project(x, y), cell = unproject(screen.x, screen.y);
    assert.ok(Math.abs(cell.x - x) < 1e-10 && Math.abs(cell.y - y) < 1e-10);
  }
});
test('settlement omits the map sidebar and supports cosmetic placement through its own full-width scene', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(main, /!explorePage \? '' : `<aside class="sidebar"/);
  assert.match(main, /if \(explorePage\) renderSidebar/);
  assert.match(main, /settlementScene\(state, language,/);
  assert.match(main, /type: 'arrange', entity, position/);
  assert.match(main, /replaceWith\(canvas\)/);
  assert.match(css, /#app\.settlement-page\{grid-template-columns:78px minmax\(0,1fr\)/);
  assert.match(css, /#settlement-world\{[^}]*touch-action:none/);
  assert.match(css, /\.settlement-task-body\{[^}]*overflow:auto/);
  assert.match(css, /\.settlement-view\{[^}]*overflow:hidden/);
});
test('settlement tasks support direct and legacy links with safe typed navigation', () => {
  assert.equal(settlementTaskFromHash(''), null);
  assert.equal(settlementTaskFromHash('#settlement-scene'), null);
  assert.equal(settlementTaskFromHash('#management'), 'overview');
  for (const task of ['overview', ...settlementDockTasks]) {
    assert.ok(isSettlementTask(task));
    assert.equal(settlementTaskFromHash(`#${task}`), task);
  }
  for (const invalid of ['constructor', '__proto__', 'toString', '', null, undefined]) assert.equal(isSettlementTask(invalid), false);
  assert.equal(settlementTaskFromHash('#constructor'), 'overview');
  assert.deepEqual(settlementDockTasks, ['inventory', 'crafting', 'decorate']);
});
test('settlement scene stays separate from focused tasks and buildings open task controls', () => {
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'ui-test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.game.stage = 0;
  const scene = settlementScene(state, 'en', true), inspector = settlementLayoutPanel(state, 'workshop', 'en');
  assert.match(scene, /decoration-mode/);
  assert.match(scene, /canvas id="settlement-world"/);
  assert.match(scene, /data-settlement-panel="decorate"/);
  assert.match(scene, /class="settlement-command-card"/);
  assert.match(scene, /data-settlement-panel="residents"/);
  assert.match(scene, /data-settlement-panel="production"/);
  assert.match(scene, /data-settlement-panel="sell"/);
  assert.match(scene, /data-settlement-panel="buildings"/);
  assert.doesNotMatch(scene, /district-customization|href="#(?:crafting|inventory|management)"/);
  assert.doesNotMatch(scene, /data-action="select-plot"|district-art/);
  assert.match(inspector, /Crafting workshop/);
  assert.match(inspector, /data-settlement-panel="crafting"/);
  assert.doesNotMatch(inspector, /settlement-panorama/);
  assert.match(inspector, /data-action="prepare-layout" data-entity="workshop"/);
  assert.match(inspector, /id="layout-x"/);
});
test('inventory and crafting are independent tasks with actionable owned equipment and decorations', () => {
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'ui-test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.game.stage = 0;
  state.inventory.items = ['bench', 'torch', 'lamp'];
  state.inventory.equipped = 'torch';
  const inventory = inventoryPanel(state, () => '', 'decoration', 'en');
  assert.match(inventory, /id="inventory"/);
  assert.doesNotMatch(inventory, /id="crafting"|recipe-card/);
  assert.match(inventory, /data-action="prepare-decoration" data-item="bench"/);
  assert.doesNotMatch(inventory, /data-action="equip" data-item="lamp"/);
  const decorations = craftingPanel(state, () => '', 'decoration');
  assert.equal((decorations.match(/class="item-card recipe-card"/g) ?? []).length, 6);
  assert.match(decorations, /data-action="craft" data-item="bench"/);
  assert.doesNotMatch(decorations, /id="inventory"|data-item="torch"/);
  const gear = craftingPanel(state, () => '', 'utility');
  assert.equal((gear.match(/class="item-card recipe-card"/g) ?? []).length, 4);
  assert.match(gear, /data-action="craft" data-item="torch"/);
  assert.match(gear, /data-action="craft" data-item="lamp"/);
  assert.doesNotMatch(gear, /data-item="bench"/);
  state.inventory.items.push('fire');
  for (const terrain of (Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).slice(0, 16)) state.inventory.items.push(`relic-${terrain}`);
  assert.match(craftingPanel(state, () => '', 'all'), /Item inventory full[\s\S]*data-settlement-panel="inventory"/);
  const sidebarInventory = inventoryPanel(state, () => '', 'all', 'en', 'explore');
  const sidebarCrafting = craftingPanel(state, () => '', 'all', 'explore');
  assert.match(sidebarInventory, /href="\/settlement\/#decorate">Manage layout/);
  for (const panel of [sidebarInventory, sidebarCrafting]) {
    assert.doesNotMatch(panel, /data-action="prepare-decoration"/);
    assert.match(panel, /data-action="inventory-filter"|data-action="crafting-filter"/);
  }
  assert.match(inventoryPanel(state, () => '', 'all', 'en', 'explore', 0, 'lamp'), /data-action="equip" data-item="lamp"/);
  assert.match(sidebarCrafting, /data-action="craft" data-item="lamp"/);
});
test('inventory renders 20 compact stack slots per distinct-item page, including empty and reserved slots', () => {
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'ui-test', population: { global: 0, federation: null }, clockSpeed: 1 };
  const items = [...craftableKeys, ...(Object.keys(terrainDetails) as (keyof typeof terrainDetails)[]).map(terrain => `relic-${terrain}` as const)];
  for (let tier = 0; tier < itemStorage.length; tier++) {
    state.inventory.storage = tier;
    state.inventory.items = items.slice(0, Math.min(21, itemStorage[tier].capacity));
    const before = structuredClone(state);
    const pages = Math.ceil(state.inventory.items.length / 20);
    for (let page = 0; page < pages; page++) {
      const html = inventoryPanel(state, () => '', 'all', 'en', 'settlement', page);
      assert.equal((html.match(/class="inventory-slot(?: empty| reserved)?"/g) ?? []).length, 20);
      assert.equal((html.match(/data-action="inventory-page"/g) ?? []).length, pages);
      assert.match(html, new RegExp(`data-page="${page}"[^>]+aria-current="page"`));
      const rendered = [...html.matchAll(/data-action="inventory-select" data-item="([^"]+)"/g)].map(match => match[1]);
      assert.deepEqual(rendered, state.inventory.items.slice(page * 20, (page + 1) * 20));
      assert.equal((html.match(/class="inventory-slot empty"[^>]*><\/div>/g) ?? []).length, 20 - rendered.length);
    }
    assert.deepEqual(state, before);
  }
  state.inventory.storage = 1; state.inventory.items = ['torch']; state.inventory.marketReserved = ['bench'];
  const reserved = inventoryPanel(state, () => '', 'all', 'en');
  assert.match(reserved, /inventory-slot reserved[^>]+data-item="bench"[^>]+disabled/);
  assert.equal((reserved.match(/inventory-slot empty/g) ?? []).length, 18);
  assert.match(inventoryPanel(state, () => '', 'all', 'en', 'settlement', 999), /data-page="0"[^>]+aria-current="page"/);
  assert.match(inventoryPanel(state, () => '', 'all', 'en', 'settlement', -1), /data-page="0"[^>]+aria-current="page"/);
  const filtered = inventoryPanel(state, () => '', 'decoration', 'en');
  assert.doesNotMatch(filtered, /data-action="inventory-select" data-item="torch"/);
  assert.equal((filtered.match(/inventory-slot empty/g) ?? []).length, 19);
  assert.doesNotMatch(filtered, /No items on this page yet/);
  state.inventory.equipped = 'torch';
  assert.match(inventoryPanel(state, () => '', 'all', 'en'), /aria-label="Torch · Quantity: 1 · Equipped"/);
});
test('inventory stacks owned and reserved copies without changing capacity, one-copy actions or pending finds', () => {
  const state: ApiState = { ...snapshot(createAccount(0)), csrf: 'ui-test', population: { global: 0, federation: null }, clockSpeed: 1 };
  state.inventory.items = ['torch', 'torch', 'bench', 'collection-wood-1', 'collection-wood-1'];
  state.inventory.marketReserved = ['torch', 'bench', 'bench', 'lamp'];
  state.inventory.equipped = 'torch';
  state.inventory.pending = ['collection-water-1', 'collection-water-1', 'activity-exploration-1'];
  const before = structuredClone(state), html = inventoryPanel(state, () => '', 'all', 'en', 'settlement', 0, 'torch');
  assert.deepEqual(itemStacks(state.inventory.items), [
    { id: 'torch', quantity: 2 }, { id: 'bench', quantity: 1 }, { id: 'collection-wood-1', quantity: 2 },
  ]);
  assert.equal((html.match(/data-action="inventory-select"/g) ?? []).length, 4);
  assert.match(html, /aria-label="Torch · Quantity: 3 · Reserved in market: 1 · Equipped"/);
  assert.match(html, /data-item="torch"[^>]+aria-pressed="true"[^>]*>/);
  assert.doesNotMatch(html, /data-action="inventory-select" data-item="torch"[^>]+disabled/);
  assert.match(html, /inventory-slot reserved[^>]+data-item="lamp"[^>]+disabled/);
  assert.match(html, /<span>Owned<\/span>: 2 · <span>Reserved in market<\/span>: 1/);
  const pending = html.slice(html.indexOf('class="pending-finds"'), html.indexOf('data-detail="inventory-help"'));
  assert.equal((pending.match(/<li>/g) ?? []).length, 2);
  assert.match(pending, /<span>Quantity<\/span>: 2/);
  assert.equal(inventoryUsed(state.inventory), 9);
  assert.deepEqual(state, before);
  const automation = inventoryPanel(state, () => '', 'collectors', 'en');
  assert.equal((automation.match(/data-action="inventory-select"/g) ?? []).length, 1);
  assert.match(automation, /data-action="activate-collection" data-item="collection-wood-1"/);
  assert.match(automation, /class="inventory-quantity" aria-hidden="true">2/);
  assert.match(inventoryPanel(state, () => '', 'all', 'ko'), /수량: 3 · 거래 주문 예약 중: 1/);
  for (const storage of [0, 4]) {
    const full = structuredClone(state);
    full.inventory.storage = storage;
    full.inventory.items = Array.from({ length: itemStorage[storage].capacity }, () => 'torch');
    full.inventory.marketReserved = [];
    const panel = inventoryPanel(full, () => '', 'all', 'en');
    assert.equal((panel.match(/data-action="inventory-select"/g) ?? []).length, 1);
    assert.equal((panel.match(/data-action="inventory-page"/g) ?? []).length, 1);
    assert.equal(inventoryUsed(full.inventory), itemStorage[storage].capacity);
    assert.match(panel, new RegExp(`<strong aria-label="Inventory capacity">${itemStorage[storage].capacity} / ${itemStorage[storage].capacity}</strong>`));
  }
});
test('Explore sidebar prioritizes recurring actions and links to detailed settlement management', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const sidebar = main.slice(main.indexOf('function renderSidebar()'), main.indexOf('function renderCommunityPage()'));
  for (const action of ['explore', 'collect-items']) assert.match(sidebar, new RegExp(`class="button primary wide[^"]*" data-action="${action}"`));
  assert.doesNotMatch(sidebar, /data-action="claim"/);
  assert.match(sidebar, /class="sidebar-action-row"/);
  assert.match(sidebar, /investigationButton\(true\)[\s\S]*data-action="explore"/);
  assert.match(sidebar, /completionMeter\(expeditionStartedAt\(nextReturn\), nextReturn\.readyAt, 'Next return'\)/);
  const css = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(css, /\.sidebar-action-row\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8'), /\.sidebar-action-row\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(sidebar, /recruitmentButton\(true\)/);
  assert.match(sidebar, /class="button sidebar-upgrade"/);
  for (const task of ['residents', 'production', 'crafting']) assert.match(sidebar, new RegExp(`href="/settlement/#${task}"`));
  assert.doesNotMatch(sidebar, /workforcePanel\(|storagePanel\(|inventoryPanel\(|craftingPanel\(|buildingsPanel\(|data-sidebar-task/);
  assert.match(sidebar, /bag\.pending\.some\(item => !bag\.marketReserved\?\.includes\(item\)\)/);
  assert.doesNotMatch(main, /toggle-sidebar|close-sidebar|sidebar-open/);
  assert.match(main, /event\.target\.closest\('\.sidebar'\)/);
});
test('mobile Explore exposes primary settlement actions immediately and links to advanced management', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(main, /class="sidebar-mobile-heading"/);
  assert.match(main, /href="\/settlement\/#residents" aria-label="Residents"/);
  assert.match(css, /#app\.explore-page\{grid-template-rows:var\(--game-header-height,170px\) minmax\(0,1fr\) auto 65px;min-height:0\}/);
  assert.match(css, /\.explore-page \.sidebar\{display:flex;grid-column:1;grid-row:3/);
  assert.match(css, /\.explore-page \.rail\{grid-row:4\}/);
  assert.match(css, /#sidebar-content>:not\(\.sidebar-primary-actions\)/);
  assert.match(css, /\.sidebar-mobile-heading \.button\{min-width:44px;min-height:44px/);
});
test('phone chrome keeps exact resource details while simplifying navigation and using safe-area spacing', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
  assert.ok(main.indexOf("import './mobile.css'") > main.indexOf("import { AccountPane }"));
  assert.match(main, /class="resource-total-compact" aria-hidden="true"/);
  assert.match(css.slice(0, css.indexOf('@media')), /\.topbar #resource-bar \.resource-total-compact\{display:none\}/);
  assert.match(main, /resourceFmt\(key, game\.stock\[key\], true\)/);
  assert.match(main, /translate\('Owned', language\).*resourceFmt\(resource, game.stock\[resource\]\)/);
  assert.doesNotMatch(main, /mobile-resource-hidden/);
  const collectionCss = readFileSync(new URL('./collection.css', import.meta.url), 'utf8');
  assert.match(collectionCss, /\.topbar #resource-bar\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /--game-footer-height:calc\(64px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.topbar #resource-bar \.resource-summary\{min-height:44px/);
  assert.match(css, /\.topbar #resource-bar \.resource\{display:flex;flex:1;gap:0;min-width:44px\}/);
  assert.match(css, /\.explore-page \.map-toolbar button\{width:44px;height:44px/);
  assert.match(css, /max-height:500px/);
  assert.match(css, /min-height:0;height:100dvh/);
  assert.match(main, /<span>\$\{gamePages\[key\]\.label\}<\/span>/);
  assert.match(css, /\.server-clock\.sync-paused #clock-sync-status\{display:inline\}/);
  assert.match(css, /\.explore-page \.sidebar-action-row \[data-invite-cost\]\[hidden\]\{display:none\}/);
  assert.match(css, /\.resource \.resource-tooltip\{display:none;font-size:13px\}/);
  assert.match(css, /\.resource:not\(\.tooltip-dismissed\):is\(:hover,:focus-within\) \.resource-tooltip\{display:block\}/);
});
test('resource acquisition shares one header manager while preserving direct claims and individual panel settings', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /class="resource-summary" data-action="collect-resource"/);
  assert.match(main, /class="resource-settings" data-action="resource-management"/);
  assert.match(main, /class="resource-manager-button" data-action="acquisition-management"/);
  assert.match(main, /case 'acquisition-management': openManagement\(lastResourceManagement\)/);
  assert.match(main, /class="management-resource-switcher" hidden/);
  assert.match(main, /if \(view === 'funds' \|\| isResource\(view\)\) openManagement\(view\)/);
  const headerResources = main.slice(main.indexOf('function renderResources()'), main.indexOf('function populationManagement()'));
  assert.doesNotMatch(headerResources, /resourceSettingsButton|class="resource-settings"/);
  assert.match(main, /resources.map\(resource => crewManagementCard\(resource\)\)/);
  assert.match(main, /resources.map\(resourceStockCard\)/);
  assert.match(main, /queueClaim\(resource, target\)/);
  assert.match(main, /nextClaimAt = performance.now\(\) \+ claimCooldownMs \+ 50/);
  assert.match(main, /if \(success\)[\s\S]*collectionReceiptQuantity\(state.message, resource\)/);
  assert.match(main, /crewManagementCard\(resource, false\)/);
  const sale = readFileSync(new URL('./settlement-sale.ts', import.meta.url), 'utf8');
  assert.match(sale, /resource \? \[resource\] : marketResources/);
  assert.match(sale, /new ResourceSaleQuantity\(language/);
  assert.match(sale, /confirmConsumption\(consumption, this.language\)/);
  assert.match(sale, /marketConsumption\(spot\)/);
});
test('desktop Play header presents a readable world clock and keeps resource inventory alongside it', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./collection.css', import.meta.url), 'utf8');
  const header = main.slice(main.indexOf('<header class="topbar"'), main.indexOf('</header>'));
  assert.match(header, /^<header class="topbar" data-no-central-wallet>/);
  assert.doesNotMatch(header, /play-brand|logo-world/);
  assert.doesNotMatch(header, /clock-symbol|icon\('clock'/);
  assert.match(header, /class="server-clock"/);
  assert.match(header, /id="resource-bar" class="resource-bar"/);
  assert.match(css, /@media\(min-width:1200px\)\{[\s\S]*?#app \.topbar #resource-bar\{grid-column:2;grid-row:1\}/);
  assert.match(css, /@media\(min-width:1200px\)\{[\s\S]*?#app \.topbar\{grid-template-columns:minmax\(170px,\.8fr\) minmax\(330px,2\.2fr\) auto auto auto;grid-template-rows:minmax\(0,1fr\)/);
  assert.match(css, /--game-header-height:88px/);
  assert.match(css, /#app \.clock-seasons\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /--season-size:clamp\(40px,calc\(var\(--game-header-height\) - 32px\),64px\)/);
  assert.match(css, /#app \.clock-season>\.icon\{width:clamp\(9px,calc\(var\(--season-size\) \* \.3\),20px\)/);
  assert.match(css, /#app \.clock-week\{[^}]*grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:900px\)\{[\s\S]*?#app \.clock-calendar\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)/);
  assert.match(header, /class="header-wallet" data-action="funds-management"[^>]*><strong data-header-dollars>0<\/strong><small>FTH\$<\/small><\/button>/);
  assert.ok(header.indexOf('id="resource-bar"') < header.indexOf('class="resource-manager-button"') && header.indexOf('class="resource-manager-button"') < header.indexOf('class="population-health"'));
  assert.doesNotMatch(main, /resource-dollars|data-dollar-income/);
  assert.match(css, /@media\(min-width:1200px\)\{[\s\S]*?#app \.resource-manager-button\{grid-column:3;grid-row:1/);
  assert.match(main, /data-header-dollars/);
  assert.match(main, /data-screen-mode="mobile"[\s\S]*?data-screen-mode="tablet"[\s\S]*?data-screen-mode="fullscreen"/);
  assert.match(main, /<nav class="rail"[\s\S]*?<div class="rail-bottom screen-mode-controls"[\s\S]*?<\/nav>/);
  assert.match(main, /data-screen-mode="mobile"[^>]*>\$\{icon\('mobile'\)\}/);
  assert.doesNotMatch(main, /document\.body\.append\(screenModeControls\)|createElement\('iframe'\)|screen-preview-frame/);
  assert.match(main, /screenPreview\.set\(mode \? screenPreviewWidths\[mode\] : null\)/);
  assert.match(css, /@media\(max-width:900px\)\{\s*\.rail \.screen-mode-controls\{display:none\}/);
  assert.match(css, /html\[data-screen-preview\] #app\{width:var\(--screen-preview-width\)/);
  assert.match(css, /\.rail \.screen-mode-controls\{[^}]*margin-top:auto/);
  assert.match(main, /window\.self !== window\.top/);
  assert.match(main, /requestFullscreen\(\)/);
  assert.match(css, /#app \.clock-season>\.icon\{width:clamp\(9px,calc\(var\(--season-size\) \* \.3\),20px\);height:clamp/);
});
test('mobile resource settings are compact while claim targets and small-screen map access remain usable', () => {
  const collection = readFileSync(new URL('./collection.css', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(collection, /grid-template-rows:56px 62px minmax\(0,1fr\)/);
  assert.match(collection, /\.resource-settings\{width:28px;height:28px;min-width:28px;min-height:28px/);
  assert.match(collection, /\.topbar #resource-bar \.resource-summary\{[^}]*min-height:44px/);
  assert.match(collection, /#app \.topbar #resource-bar \.resource-summary strong\{font-size:12px;line-height:1\.15;white-space:normal\}/);
  assert.match(collection, /\.topbar #resource-bar \.collection-ready\{right:0;top:0\}/);
  assert.match(collection, /@media\(min-width:651px\) and \(max-width:900px\) and \(max-height:500px\)/);
  assert.match(collection, /#app \.clock-week\{[^}]*height:4px/);
  assert.match(collection, /#app \.clock-seasons\{[^}]*height:var\(--season-size\)/);
  assert.match(collection, /@media\(max-width:900px\)\{[\s\S]*?#app \.clock-seasons\{grid-column:1;grid-row:1\/-1;align-self:end/);
  assert.match(collection, /#app \.clock-seasons\{grid-column:1;grid-row:1\/-1;align-self:end/);
  assert.match(collection, /#app \.clock-game-time>\.icon\{width:18px;height:18px\}/);
  assert.match(collection, /@media\(max-width:900px\)\{[\s\S]*?#app \.clock-week\{grid-column:2;grid-row:2\}/);
  assert.match(collection, /--season-size:clamp\(28px,5vh,40px\)/);
  assert.match(collection, /@media\(max-width:650px\)\{[\s\S]*?--season-size:clamp\(22px,7vw,34px\)/);
  assert.match(collection, /#app \.resource-manager-button\{[^}]*min-height:44px/);
  assert.match(collection, /\.management-dialog\[open\]\{display:flex;flex-direction:column\}/);
  assert.match(collection, /\.management-resource-switcher\[hidden\]\{display:none\}/);
  assert.match(layout, /min-height:0;height:100dvh;isolation:isolate/);
  assert.doesNotMatch(layout, /--world-chat-height|width:calc\(100% - var\(--world-chat-width\)\)/);
  assert.match(layout, /--canvas-rail:var\(--game-rail-width\)/);
  assert.match(layout, /--canvas-footer:var\(--game-footer-height\)/);
  assert.match(layout, /bottom:var\(--scene-bottom\);left:auto;width:min/);
});
test('Explore and Settlement canvases fill the viewport while chat collapses without resizing them', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(layout, /\.has-world-chat \.map,\.has-world-chat \.settlement-view\{position:absolute;inset:0;grid-column:1\/-1;grid-row:1\/-1/);
  assert.doesNotMatch(layout, /\.has-world-chat \.settlement-view\{[^}]*grid-column:2/);
  assert.match(layout, /\.has-world-chat \.map canvas#world\{width:100%;height:100%\}/);
  assert.match(layout, /#app\.has-world-chat \.settlement-view \.settlement-panorama\{inset:0;visibility:visible\}/);
  assert.match(layout, /\.world-chat\{position:absolute;right:var\(--layout-gap\);bottom:calc\(var\(--canvas-footer\) \+ var\(--layout-gap\)\)/);
  assert.doesNotMatch(layout, /\.world-chat:has\(\[aria-expanded="true"\]\)\{[^}]*bottom:/);
  assert.match(layout, /\.has-world-chat\.chat-expanded \.settlement-dock/);
  assert.doesNotMatch(layout, /\.world-chat>header \.button[^{}]*\{display:none\}/);
  const shell = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  assert.match(shell, /html:has\(#app\),body:has\(#app\)\{height:100%;overflow:hidden\}/);
  assert.match(layout, /\.world-chat #world-chat-content\[hidden\]\{display:none\}/);
  assert.match(main, /data-chat-toggle aria-expanded="false" aria-controls="world-chat-content"/);
  assert.match(main, /id="world-chat-content" hidden/);
  assert.match(main, /setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(main, /function focusWorldChat\(\): void \{ setChatExpanded\(true\)/);
  assert.match(main, /event\.key === 'Escape'/);
  assert.doesNotMatch(main, /chatOverlay\.innerHTML/);
  assert.match(main, /if \(expanded && settlementTask\) showSettlementTask\(null, false\)/);
  assert.match(main, /function showSettlementTask[^]*?if \(task\) setChatExpanded\(false\)/);
  assert.match(main, /app\.classList\.toggle\('chat-expanded', expanded\)/);
});
test('Explore retains a responsive minimap and collapsed chat has only one icon', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const explore = readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(explore, /#app\.explore-page \.minimap\{display:block;left:auto;right:var\(--layout-gap\);bottom:calc\(var\(--canvas-footer\) \+ 84px\)/);
  assert.match(explore, /#app\.explore-page \.minimap canvas\{height:auto;aspect-ratio:30\/19\}/);
  assert.match(explore, /#app\.explore-page\.chat-expanded \.minimap\{display:none\}/);
  assert.match(explore, /@media\(min-width:901px\) and \(min-height:501px\)\{[^]*?#app\.explore-page \.minimap\{display:block;bottom:calc\(var\(--canvas-footer\) \+ var\(--layout-gap\)\)/);
  assert.match(explore, /#app\.explore-page \.world-chat\{left:auto;bottom:calc\(var\(--canvas-footer\) \+ var\(--layout-gap\)\*2 \+ var\(--desktop-minimap-height\)\)/);
  assert.match(explore, /\.world-chat:has\(\[aria-expanded="false"\]\)\{right:calc\(var\(--layout-gap\) \+ 4px\);bottom:calc\(var\(--canvas-footer\) \+ var\(--layout-gap\) \+ var\(--desktop-minimap-height\) - 48px\)/);
  assert.match(chat, /\.world-chat:has\(\[aria-expanded="false"\]\)\{[^}]*border:0;[^}]*background:transparent;backdrop-filter:none;box-shadow:none/);
  assert.match(chat, /\.world-chat:has\(\[aria-expanded="false"\]\) h2\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)\}/);
  const header = main.match(/<h2 id="world-chat-title">([^]*?)<\/h2>/)?.[1];
  assert.ok(header);
  assert.doesNotMatch(header, /icon\(/);
  assert.match(main, /chatToggle\.innerHTML = icon\(expanded \? 'close' : 'communicate'\)/);
});
test('World game pages share responsive chrome, readable surfaces, and independently scrolling workspaces', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./game-layout.css', import.meta.url), 'utf8');
  assert.match(main, /import '\.\/game-layout\.css';\s*import '\.\/world-chat\.css'/);
  assert.match(main, /class="game-brand"[^>]*><img src="\/shared\/logo\.svg" alt="" width="34" height="34">/);
  assert.match(shell, /--game-rail-width:88px;--game-header-height:96px/);
  assert.match(shell, /--game-header-height:124px;--game-footer-height:calc\(68px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(shell, /#app \.rail\{position:absolute;inset:auto 0 0/);
  assert.match(shell, /#app :is\(\.community-view,\.marketplace-view\)\{grid-column:1;grid-row:2/);
  assert.match(shell, /#app :is\(\.page-card,\.exchange-card,\.exchange-catalog,\.inbox-directory,\.chat-page\)/);
  assert.match(shell, /#app \.exchange-order-entry\{grid-column:1;grid-row:2;position:static\}/);
  assert.doesNotMatch(shell.replace('animation:none!important;transition:none!important', ''), /!important|url\(/);
});
test('Weather overlay explains real climate modifiers with signed and color-coded estimates', () => {
  const mild = { ...environmentAt(worldEpoch), season: 'Spring' as const, weather: 'Clear skies' as const, temperature: 18 };
  const effects = environmentEffects(mild);
  assert.match(effects, /Wood production<\/dt><dd><strong class="climate-benefit" data-no-localize>\+15%/);
  assert.match(effects, /Recruitment suitability<\/dt><dd><strong class="climate-benefit" data-no-localize>\+20%/);
  assert.match(effects, /Water demand<\/dt><dd><strong class="climate-neutral" data-no-localize>0%/);
  const hot = environmentEffects({ ...mild, season: 'Summer', temperature: 35 });
  assert.match(hot, /Water demand<\/dt><dd><strong class="climate-penalty" data-no-localize>\+38%/);
  assert.match(hot, /Actual production and recruitment use daily averages/);
  assert.match(environmentDetails(mild, true), /<details class="weather-effects">/);
  assert.doesNotMatch(effects, /weather-effect-preview/);
  assert.match(effects, /<summary class="weather-impact weather-impact-best" aria-label="Best overall conditions"/);
  assert.equal((effects.match(/<summary[^]*?<\/summary>/)?.[0].match(/<svg/g) || []).length, 1);
  assert.doesNotMatch(effects.match(/<summary[^]*?<\/summary>/)?.[0] || '', /%/);
  assert.equal(overallWeatherImpact(mild), 'best');
  assert.equal(overallWeatherImpact({ ...mild, season: 'Autumn' }), 'best');
  assert.equal(overallWeatherImpact({ ...mild, season: 'Summer', temperature: 35 }), 'bad');
  assert.equal(overallWeatherImpact({ ...mild, season: 'Winter', weather: 'Snow', temperature: -10 }), 'worst');
  assert.doesNotMatch(environmentDetails(mild), /weather-effects/);
  const css = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(css, /\.weather-overlay\{position:absolute;right:var\(--layout-gap\);top:var\(--scene-top\)/);
  assert.match(css, /\.weather-effects:not\(\[open\]\)>:not\(summary\)\{display:none\}/);
});
test('Explore menu uses compact responsive action grids rather than scrolling or clipping controls', () => {
  const css = readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8');
  assert.match(css, /#app\.explore-page #sidebar-content\{display:grid;gap:8px;overflow:visible/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /#app\.explore-page \.sidebar-action-row\{display:contents\}/);
  assert.match(css, /\.quick-action-cost,#app\.explore-page \[data-invite-cost\]\{display:flex/);
  assert.doesNotMatch(css, /\[data-invite-label\]\{display:none\}/);
  assert.match(css, /\.quick-action-duration\{display:flex/);
  assert.doesNotMatch(css, /overflow:(auto|scroll|hidden)/);
});
test('Chat uses a speech bubble and reports unread messages while collapsed without counting history or own messages', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./communicate.ts', import.meta.url), 'utf8');
  assert.match(icon('communicate'), /M5 4h14/);
  assert.match(main, /data-chat-unread data-no-localize hidden aria-live="polite"/);
  const layout = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(layout, /#app \.world-chat>header \.button\{border:0;background:transparent;box-shadow:none\}/);
  assert.match(layout, /#app \.world-chat \.chat-page\{border:0;border-radius:0;background:transparent;box-shadow:none;padding:0\}/);
  assert.doesNotMatch(main, /id="world-chat-content" hidden><a/);
  assert.match(main, /event\.detail > 99 \? '99\+'/);
  assert.match(main, /event\.detail \? `world-chat-users \$\{badge\.id\}` : 'world-chat-users'/);
  assert.match(main, /dispatchEvent\(new Event\(chatVisibilityChangedEvent\)\)/);
  assert.match(chat, /!document\.hidden && this\.list\.getClientRects\(\)\.length > 0/);
  assert.match(chat, /message\.author !== this\.info\?\.profile\?\.id && \(!reset \|\| hadHistory\)/);
  assert.match(chat, /known\.add\(message\.id\)/);
  assert.match(chat, /this\.visible\(\) && this\.atBottom\(\)/);
  assert.match(chat, /CustomEvent<number>\(chatUnreadChangedEvent, \{ bubbles: true, detail: this\.unread \}\)/);
  assert.match(chat, /document\.removeEventListener\('visibilitychange', this\.visibilityChanged\)/);
});
test('chat launcher shows room presence including connected self, independently of unread counts', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./communicate.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(main, /id="world-chat-users" data-chat-users data-no-localize aria-live="polite"/);
  assert.match(main, /chatOverlay\?\.addEventListener\(chatPresenceChangedEvent/);
  assert.match(main, /badge\.textContent = online === null \? '—' : String\(online\)/);
  assert.match(chat, /CustomEvent<number>\(chatPresenceChangedEvent, \{ bubbles: true, detail: online \}\)/);
  assert.match(chat, /CustomEvent<null>\(chatPresenceChangedEvent, \{ bubbles: true, detail: null \}\)/);
  assert.match(css, /\.chat-user-badge\{[^}]*right:4px;bottom:5px/);
});
test('mobile settlement tasks share a larger workspace and Water upkeep cannot inherit notice flex layout', () => {
  const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
  const settlement = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(css, /\.settlement-task-panel,\.settlement-task-panel:has\(\.inventory-panel\)\{position:absolute;inset:0 0 132px/);
  assert.match(css, /\.settlement-dock\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /\.settlement-dock>button\{[^}]*min-height:48px/);
  assert.match(css, /\.settlement-view:has\(\.settlement-task-panel:not\(\[hidden\]\)\) \.settlement-panorama\{bottom:132px;visibility:hidden\}/);
  assert.match(settlement, /\.settlement-task-body \.notice:not\(\.water-upkeep\)\{display:flex/);
  assert.match(css, /\.notice\.water-upkeep\{height:164px;min-height:164px;grid-template-rows:20px 24px 32px 44px/);
});
test('mobile marketplace prioritizes trading and retains searchable selection and scrolling across refreshes', () => {
  const market = readFileSync(new URL('./marketplace.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
  assert.match(market, /data-market-catalog><summary>[\s\S]*data-market-search[\s\S]*data-market-category/);
  assert.match(market, /querySelector<HTMLDetailsElement>\('\[data-market-catalog\]'\)!\.open = true/);
  assert.match(market, /if \(button\.dataset\.marketQuickSide && matchMedia\(compactMarketQuery\)\.matches\) \{[\s\S]*?open = false;[\s\S]*?focus\(\{ preventScroll: true \}\)/);
  assert.match(market, /list\.scrollTo\(scrollLeft, scrollTop\)/);
  assert.match(css, /\.exchange-order-entry\{grid-column:1;grid-row:2/);
  assert.match(css, /\.exchange-chart-card\{grid-column:1;grid-row:3/);
  assert.match(css, /\.exchange-book td\[colspan\]\{white-space:normal\}/);
  assert.match(css, /\.exchange-tabs button\{flex:1 1 0;min-width:44px;min-height:44px/);
});
test('market grid and table retain all assets, real prices, holdings and safe draft-only actions', () => {
  const state = snapshot(createAccount(1000000));
  state.game.stock.wood = 22; state.game.stock.metal = 0;
  state.inventory.items = [craftableKeys[0]];
  const tickers = marketAssets.map((asset, index) => ({ asset, bid: index + 1.0001, ask: index + 2.0002, last: null }));
  assert.equal(marketOwned(state, 'wood'), 22);
  assert.equal(marketOwned(state, craftableKeys[0]), 1);
  assert.equal(marketOwned(state, 'metal'), 0);
  for (const language of ['ko', 'en'] as const) for (const view of ['grid', 'table'] as const) {
    const html = renderMarketCatalog(tickers, state, 'wood', view, language, false);
    assert.equal(html.match(/data-selected="true"/g)?.length, 1);
    for (const asset of marketAssets) {
      assert.equal(html.match(new RegExp(`data-market-asset="${asset}"`, 'g'))?.length, 3);
    }
    assert.ok(html.includes('2'));
    assert.match(html, /data-market-quick-side="buy"/);
    assert.match(html, /data-market-quick-side="sell"/);
    assert.match(html, /catalog-last/);
    const withoutChanges = html.replace(/<span class="catalog-change"[\s\S]*?<\/span>/g, '').replace(/<button[^>]*data-catalog-column="change(?:24h|7d)-low"[^>]*>[^<]*<\/button>/g, '');
    assert.doesNotMatch(withoutChanges, /type="submit"|data-market-submit|>[^<]*\b(?:daily|24h)\b/);
    assert.equal(html.match(/data-change-window="24h" data-direction="none"/g)?.length, marketAssets.length);
    const locked = renderMarketCatalog(tickers, state, 'wood', view, language, true);
    assert.equal(locked.match(/\bdisabled/g)?.length, marketAssets.length * 3);
  }
});
test('empty collection markets show localized missing offers rather than sentinel prices', () => {
  const state = snapshot(createAccount(1000000));
  const tickers = [{ asset: 'collection-wood-1' as const, bid: 0, ask: Number.MAX_SAFE_INTEGER / 10000, last: null }];
  for (const language of ['ko', 'en'] as const) for (const view of ['grid', 'table'] as const) {
    const html = renderMarketCatalog(tickers, state, 'collection-wood-1', view, language, false);
    assert.ok(html.includes(translate('No offers yet.', language)));
    assert.doesNotMatch(html, /900[\s,.]*719/);
    assert.match(html, /data-market-quick-side="buy"/);
  }
});
test('market search, sorting and owned filtering use current holdings without mutating tickers', () => {
  const state = snapshot(createAccount(1000000));
  state.game.stock.wood = 22; state.game.stock.water = 0; state.game.stock.metal = 0;
  state.inventory.items = [craftableKeys[0]];
  const tickers = marketAssets.map((asset, index) => ({ asset, bid: index + 1, ask: index + 2, last: null }));
  const before = JSON.stringify(tickers);
  assert.deepEqual(filterMarketCatalog(tickers, state, 'en', 'resources', 'WATER', 'name', false).map(t => t.asset), ['water']);
  assert.deepEqual(filterMarketCatalog(tickers, state, 'ko', 'resources', '목재', 'name', false).map(t => t.asset), ['wood']);
  assert.deepEqual(filterMarketCatalog(tickers, state, 'ko', 'resources', '  목재  ', 'name', false).map(t => t.asset), ['wood']);
  assert.deepEqual(new Set(filterMarketCatalog(tickers, state, 'en', 'all', '', 'owned', true).map(t => t.asset)), new Set(['wood', craftableKeys[0]]));
  assert.equal(filterMarketCatalog(tickers, state, 'en', 'resources', '', 'buy-low', false)[0].asset, 'wood');
  assert.equal(filterMarketCatalog(tickers, state, 'en', 'all', '', 'sell-high', false)[0].asset, 'metal');
  assert.equal(filterMarketCatalog(tickers, state, 'en', 'all', 'no-such-market', 'name', false).length, 0);
  assert.equal(JSON.stringify(tickers), before);
});
test('order tickets keep four-decimal limits, quote freshness and confirmation while adding quick controls', () => {
  const source = readFileSync(new URL('./marketplace.ts', import.meta.url), 'utf8');
  assert.match(source, /data-market-step="-1"/);
  assert.match(source, /data-market-max/);
  assert.match(source, /if \(reset \|\| !input\.validity\.valid\) input\.value = input\.min/);
  assert.match(source, /fundingQuantity\.min = fundingQuantity\.step = input\.step/);
  assert.match(source, /maximum\.hidden = this\.side !== 'sell'/);
  assert.match(source, /Math\.min\(marketQuantityLimit\(this\.asset\)/);
  assert.match(source, /sellableItemCount\(this\.state\(\)\.inventory, this\.asset\)/);
  assert.match(source, /quote\?\.available \? quote\.dollars : undefined/);
  assert.match(source, /private priceEdited = false/);
  assert.match(source, /if \(!this\.priceEdited && ticker\)/);
  assert.match(source, /this\.mode = 'limit'; this\.priceEdited = true/);
  assert.match(source, /market\.history\.slice\(-this\.historyCount\)/);
  assert.match(source, /Review buy/);
  assert.match(source, /if \(quote && !await confirmConsumption/);
  assert.match(source, /dollarsSlippage\(quote\.dollars, this\.side\)/);
  assert.match(source, /!amount\.validity\.valid/);
  assert.match(source, /this\.pending = true; this\.sequence\+\+; this\.catalog\(\); this\.preview\(\)/);
  for (const stylesheet of ['./marketplace.css', './mobile.css']) {
    const css = readFileSync(new URL(stylesheet, import.meta.url), 'utf8');
    assert.match(css, /\.exchange-order-entry form\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  }
});
test('mobile chat and spending sheets retain safety information and reachable controls', () => {
  const chat = readFileSync(new URL('./communicate.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
  assert.match(chat, /<details class="chat-guidelines"><summary title="Chat rules" aria-label="Chat rules">[\s\S]*?<\/summary>[\s\S]*?Do not share personal information\.[\s\S]*?<\/details>/);
  assert.match(css, /\.chat-page \.chat-composer\{position:sticky;bottom:0/);
  assert.match(css, /\.consumption-dialog\{position:fixed;inset:auto 0 0/);
  assert.match(css, /\.consumption-actions\{position:sticky;bottom:0/);
  assert.match(css, /\.consumption-actions \.button\{min-height:48px/);
  for (const label of ['Chat', 'Chat rules', 'Trading item']) {
    assert.ok(readFileSync(new URL('./translations.ts', import.meta.url), 'utf8').includes(`'${label}':`));
  }
});
test('Play clock omits server-time and UTC labels while preserving a paused-sync notice', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./collection.css', import.meta.url), 'utf8');
  assert.match(main, /class="clock-heading">.*id="clock-sync-status" hidden>SYNC PAUSED/);
  assert.doesNotMatch(main, /SERVER TIME|id="server-time"| UTC/);
  assert.match(main, /#clock-sync-status'\)!\.hidden = !syncPaused/);
  assert.match(css, /#app #clock-sync-status\,#app #clock-speed/);
});
test('desktop modals use wider workspaces while retaining scroll access for constrained screens', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const management = readFileSync(new URL('./collection.css', import.meta.url), 'utf8');
  const account = readFileSync(new URL('./account.css', import.meta.url), 'utf8');
  const confirmation = readFileSync(new URL('./confirmation.css', import.meta.url), 'utf8');
  assert.match(main, /class="resource-workspace"/);
  assert.match(main, /class="population-workspace"/);
  assert.match(main, /class="crew-list resource-crews"/);
  assert.match(main, /data-detail="workforce-expeditions"/);
  assert.match(management, /\.resource-workspace\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(management, /\.management-content\{[^}]*overflow:auto/);
  assert.match(account, /grid-template-areas:"profile profile" "balances wallet" "links wallet" "settings wallet"/);
  assert.match(account, /\.account-profile\{grid-area:profile/);
  assert.match(account, /\.account-content\{overflow:auto/);
  assert.match(confirmation, /\.consumption-dialog\[open\]\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(confirmation, /\.consumption-dialog\{[^}]*overflow:auto/);
});
test('Water and server-clock cards have stable heights with compact, accessible upkeep timing', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const panel = main.slice(main.indexOf('function waterUpkeepPanel('), main.indexOf('function workforcePanel()'));
  assert.match(panel, /class="water-upkeep-heading"/);
  assert.match(panel, /class="water-upkeep-impact"/);
  assert.match(panel, /data-ready-at="\$\{upkeep\.readyAt\}" data-compact-time/);
  assert.match(main, /remaining \? compactServerCountdown\(remaining\) : 'Confirming'/);
  assert.match(main, /el\.setAttribute\('aria-label', detailed\)/);
  assert.match(css, /\.notice\.water-upkeep\{[^}]*height:140px;min-height:140px;flex-shrink:0/);
  assert.match(css, /\.server-clock\{[^}]*height:42px/);
});
test('Explore Water upkeep uses a compact daily row with server-timed animated progress', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8');
  assert.match(main, /class="explore-upkeep">\$\{waterUpkeepPanel\(true\)\}/);
  assert.match(main, /completionMeter\(upkeep\.readyAt - worldDayMs, upkeep\.readyAt, 'Next consumption', true\)/);
  assert.match(main, /class="water-upkeep-use"/);
  assert.match(main, /translate\('Buy Water', language\)/);
  assert.match(main, /translate\('Water facilities', language\)/);
  assert.match(main, /class="water-shortage-text" role="status"/);
  assert.match(css, /\.water-upkeep-row\{[^}]*min-height:44px/);
  assert.match(css, /\.completion-meter::after\{[^}]*transform:scaleX\(var\(--completion-scale,0\)\)[^}]*transition:transform 1s linear/);
  assert.match(main, /el\.style\.setProperty\('--completion-progress', `\$\{progress\.percent\}%`\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});
test('shared recruitment controls show a one-week queue and wait for server-confirmed arrivals', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const timer = main.slice(main.indexOf('function renderRecruitment()'), main.indexOf('function renderWorkTimers()'));
  assert.match(timer, /const recruitment = state\.recruitment/);
  assert.match(timer, /button\.disabled = .*!!recruitment/);
  assert.match(timer, /Awaiting server confirmation/);
  assert.match(main, /meter\.value = progress\.percent/);
  assert.match(main, /progress\.percent === 100/);
  assert.match(main, /data-invite-duration>\$\{primary \? `1 \$\{translate\('wk', language\)\}` : '1 game week'\}/);
  assert.match(main, /completionMeter\(recruitment\.startedAt, recruitment\.readyAt, 'Recruitment progress', true\)/);
  assert.doesNotMatch(main, /10 server min|ten-server-minute/);
});

test('sidebar spending is labeled with resource names and remains readable on disabled actions', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./settlement.css', import.meta.url), 'utf8');
  assert.match(main, /<span class="quick-action-cost">\$\{costChips\(\{ dollars: quote\.dollars \}, true\)\}/);
  assert.match(main, /costChips\(\{ dollars: state\.recruitmentDollars \}, primary\)/);
  assert.match(main, /function costChips\(cost: Cost, showNames = false\)/);
  assert.match(main, /<span>\$\{name\}<\/span><strong>\$\{amount\}<\/strong>/);
  assert.match(css, /\.sidebar-action-row \.cost>strong\{[^}]*font-size:14px/);
  assert.match(css, /\.sidebar-action-row>\.button:disabled:not\(:has\(\.completion-meter\)\)\{opacity:1/);
  assert.match(css, /\.sidebar-action-row \.cost\.insufficient\{color:#ffb7a7\}/);
  assert.match(css, /\.sidebar-action-row \[data-invite-cost\]\[hidden\]\{display:none\}/);
});

test('compact field cards preserve price, duration and accessible requirements without explanatory rows', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./explore-layout.css', import.meta.url), 'utf8');
  assert.match(main, /state\.availableWorkers < 2 \? 'Needs 2 idle residents'/);
  assert.match(main, /fieldActionReason\(quote, 'No known destination available'\)/);
  assert.match(main, /fieldActionReason\(quote, 'No nearby destination'\)/);
  assert.match(main, /Next field team fee multiplier/);
  assert.match(main, /2 \*\* explorationCount\(state\.workforce\.expeditions\)/);
  assert.match(main, /button\.setAttribute\('aria-description', translate/);
  assert.match(main, /function fieldDuration\(weeks: number\)/);
  assert.match(main, /fieldDuration\(1\)/);
  assert.match(main, /fieldDuration\(quote\.weeks\)/);
  const sidebar = main.slice(main.indexOf('function renderSidebar()'), main.indexOf('function renderCommunityPage()'));
  assert.doesNotMatch(sidebar, /quick-action-status|Known land · 10% item chance/);
  assert.match(sidebar, /aria-description=/);
  assert.match(main, /expedition\.startedAt \?\? expedition\.readyAt/);
  assert.match(main, /icon\('search'\)/);
  assert.notEqual(icon('search'), icon('compass'));
  const compact = css.slice(css.indexOf('@media(max-width:650px) and (max-height:740px),'));
  assert.doesNotMatch(compact, /quick-action-cost[^}]*display:none/);
  assert.doesNotMatch(compact, /quick-action-duration[^}]*display:none/);
  assert.match(compact, /min-height:68px/);
  assert.match(css, /\.sidebar progress\{height:3px/);
  assert.match(css, /\.explore-upkeep \.upkeep-meters\{height:48px/);
  assert.match(css, /\.vertical-consumption \.completion-meter\{[^}]*transform:none/);
  assert.match(css, /\[data-invite-duration\]\[hidden\]\{display:none\}/);
  assert.match(css, /\.sidebar \.completion-meter::after\{height:3px/);
  assert.match(css, /\.sidebar-secondary-actions>\.button\{[^}]*min-height:36px/);
  assert.match(compact, /\.sidebar-secondary-actions>\.button\{padding:4px;min-height:44px/);
  for (const label of ['Needs 2 idle residents', 'Discover new land', 'Grow population', 'Next field team fee multiplier'])
    assert.notEqual(translate(label, 'ko'), label);
});

test('four live counters lead the hero without duplicate statistics in the World header', () => {
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(landing, /<section class="hero section-shell"[^>]*>\s*<section class="world-stats"/);
  const header = landing.match(/<header class="top world-header"[^>]*>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.doesNotMatch(header, /world-live-card|data-total|data-gold-supply/);
  assert.equal((landing.match(/data-total=/g) ?? []).length, 3);
  assert.doesNotMatch(landing, /data-total="metal"|유통 중인 게임 금속/);
  for (const [metric, symbol] of [['settlements', 'home'], ['dollars', 'dollars'], ['population', 'people']]) {
    assert.equal(landing.split(`data-total="${metric}"`).length - 1, 1);
    assert.ok(landing.includes(`<dd><span class="stat-icon" data-icon="${symbol}" aria-hidden="true"></span><span data-total="${metric}">`));
  }
  assert.equal((landing.match(/data-gold-supply/g) ?? []).length, 1);
  assert.doesNotMatch(landing, /fthgTransactions/);
  const landingScript = readFileSync(new URL('./landing.ts', import.meta.url), 'utf8');
  assert.match(landingScript, /statsPanel\.dataset\.state = 'live'/);
  assert.match(landingScript, /statsPanel\.dataset\.state = 'stale'/);
});
test('homepage totals abbreviate at 10,000 using Korean and English units while small totals stay exact', () => {
  for (const locale of ['ko-KR', 'en-US']) {
    for (const value of [0, 8, 999, 1000, 6141, 9999]) {
      assert.equal(formatPublicTotal(value, locale), value.toLocaleString(locale));
    }
    assert.equal(formatPublicTotal(9999.9999, locale, '9,999.9999'), '9,999.9999');
  }
  for (const [value, korean, english] of [
    [10000, '1만', '10K'],
    [12345, '1.2만', '12.3K'],
    [1000000, '100만', '1M'],
    [100000000, '1억', '100M'],
    [10838853843.3, '108.4억', '10.8B'],
    [1000000000000, '1조', '1T'],
  ] as const) {
    assert.equal(formatPublicTotal(value, 'ko-KR'), korean);
    assert.equal(formatPublicTotal(value, 'en-US'), english);
  }
});
test('homepage count-up abbreviates visually while exact accessible totals and Gold rates retain precision', () => {
  const landing = readFileSync(new URL('./landing.ts', import.meta.url), 'utf8');
  assert.match(landing, /key === 'dollars' \? dollarsUnits\(data\[key\]\)/);
  assert.match(landing, /formatDollars\(value \/ dollarsScale, languageLocale\)/);
  assert.match(landing, /element\.textContent = formatPublicTotal\(amount, languageLocale, text\)/);
  assert.match(landing, /formatDollars\(data\.dollars, languageLocale\)/);
  assert.match(landing, /setAttribute\('aria-label', text\)/);
  assert.match(landing, /element\.title = text/);
  assert.match(landing, /fetch\('\/api\/v1\/gold\/stats'/);
});

test('landing copy leads with playable goals and immediate play links without hiding limits', () => {
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const hero = landing.match(/<div class="hero-copy">([\s\S]*?)<div class="hero-world">/)?.[1];
  assert.ok(hero);
  assert.match(hero, /무료 싱글플레이 탐험·건설 게임/);
  assert.match(hero, /Explore a world/);
  assert.match(hero, /Build a settlement/);
  assert.match(hero, /Shape a federation/);
  assert.match(hero, /주민을 배치해 자원을 모으고/);
  assert.ok(hero.includes(`${Object.keys(terrainDetails).length}가지 지형`));
  assert.match(hero, /수도까지 키워/);
  assert.match(hero, /Start exploring/);
  assert.match(hero, /설치·지갑 연결·결제 없이/);
  assert.match(hero, /초기 프로토타입/);
  const playCalls = [...landing.matchAll(/<a class="(?:btn [^"]*|preview-cta)" href="([^"]+)">/g)];
  assert.equal(playCalls.length, 4);
  assert.match(landing, /class="play-launch" href="\/explore\/"/);
  for (const [, href] of playCalls) assert.ok(['/explore/', '/settlement/'].includes(href), href);
  assert.match(landing, /게임 시간 7일마다/);
  assert.match(landing, /게임 시간 1~3주 후 복귀하면/);
  assert.match(landing, /미배치 주민은 자원을 생산하지 않으며/);
  assert.match(landing, /실제 DAO나 온체인 게임 경제가 아니며, 금전적 보상을 제공하지 않습니다/);
  assert.match(landing, /FTHG is an actual Ethereum Mainnet token/);
  assert.match(landing, /FTH\$ redemption requires an authorized service/);
  assert.match(landing, /공식 링크는 준비 중/);
});

test('unpublished public links stay empty rather than pointing to invented accounts', () => {
  const pending = { url: '', channels: { github: '', discord: '', x: '', telegram: '' } };
  assert.deepEqual(resolvePublicSite(pending), pending);
});
test('resource allocation removes tile selection and discloses advanced FTH$ costs in both languages', () => {
  const simulator = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(simulator, /id="site-|crew-controls select|data-locked-until/);
  assert.match(simulator, /data-action="automatic"/);
  assert.match(simulator, /dollars: state\.recruitmentDollars/);
  assert.match(simulator, /requestMove\(destination\.x, destination\.y\)/);
  assert.match(simulator, /work\.expeditions\.map/);
  assert.match(simulator, /nextExploration\(game, state\.workforce\.expeditions\)/);
  const landing = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(landing, /자원별로 자동 배치/);
  assert.match(landing, /주간 운송비/);
  for (const [file, patterns] of [
    ['../public/WHITEPAPER.md', [/automatic/i, /FTH\$50 per arriving resident/, /No payment is taken at dispatch/, /including Wood and Water/]],
    ['../public/WHITEPAPER.ko.md', [/자동 배치/, /합류 인원 1명당 FTH\$50/, /운송비/]],
  ] as const) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const pattern of patterns) assert.match(text, pattern);
  }
});
test('SEO metadata does not invent a canonical domain and is never applied to the game', async () => {
  const plugin = landingSeo(resolvePublicSite({ url: '', channels: { github: '', discord: '', x: '', telegram: '' } }));
  const transform = plugin.transformIndexHtml;
  assert.ok(typeof transform === 'function');
  const tags = await transform('', { path: '/index.html', filename: 'index.html' });
  assert.ok(Array.isArray(tags));
  assert.equal(tags.some(tag => tag.attrs?.rel === 'canonical'), false);
  const structured = tags.find(tag => tag.tag === 'script')!;
  const schema = JSON.parse(String(structured.children));
  assert.equal(schema['@type'], 'WebApplication');
  assert.equal(schema.name, 'Featheral');
  assert.deepEqual(schema.inLanguage, ['ko', 'en']);
  assert.equal('url' in schema, false);
  assert.equal(await transform('', { path: '/explore/index.html', filename: 'explore/index.html' }), undefined);
});
test('configured SEO produces absolute sharing URLs, a public-page sitemap and API crawl exclusions', async () => {
  const plugin = landingSeo(resolvePublicSite({
    url: 'https://example.test', channels: { github: 'https://github.com/example/project', discord: '', x: '', telegram: '' },
  }));
  const transform = plugin.transformIndexHtml;
  assert.ok(typeof transform === 'function');
  const tags = await transform('', { path: '/index.html', filename: 'index.html' });
  assert.ok(Array.isArray(tags));
  assert.equal(tags.find(tag => tag.attrs?.rel === 'canonical')?.attrs?.href, 'https://example.test/');
  assert.equal(tags.find(tag => tag.attrs?.property === 'og:image')?.attrs?.content, 'https://example.test/images/social-preview-ko.png');
  const structured = JSON.parse(String(tags.find(tag => tag.tag === 'script')!.children));
  assert.deepEqual(structured.sameAs, ['https://github.com/example/project']);
  const files: { fileName: string; source: string }[] = [];
  assert.ok(typeof plugin.generateBundle === 'function');
  Reflect.apply(plugin.generateBundle, { emitFile: (file: { fileName: string; source: string }) => files.push(file) }, []);
  assert.match(files.find(file => file.fileName === 'robots.txt')!.source, /Disallow: \/api\//);
  const sitemap = files.find(file => file.fileName === 'sitemap.xml')!.source;
  assert.match(sitemap, /<loc>https:\/\/example.test\/<\/loc>/);
  assert.equal((sitemap.match(/<loc>https:\/\/example.test\/<\/loc>/g) ?? []).length, 1);
  assert.match(sitemap, /<loc>https:\/\/example.test\/whitepaper\/<\/loc>/);
  const paperTags = await transform('', { path: '/whitepaper/index.html', filename: 'whitepaper/index.html' });
  assert.ok(Array.isArray(paperTags));
  assert.equal(paperTags.find(tag => tag.attrs?.rel === 'canonical')?.attrs?.href, 'https://example.test/whitepaper/');
  assert.equal(sitemap.includes('/'), true);
});
test('configured links use HTTPS and a normalized canonical root origin', () => {
  const configured = resolvePublicSite({
    url: 'https://example.test/',
    channels: { github: 'https://github.com/example/project', discord: '', x: '', telegram: '' },
  });
  assert.equal(configured.url, 'https://example.test');
  assert.equal(configured.channels.github, 'https://github.com/example/project');
});
test('unsafe links, embedded credentials and non-root canonical URLs are rejected explicitly', () => {
  for (const url of ['not a URL', 'javascript:alert(1)', 'http://example.test', 'https://user:password@example.test']) {
    assert.throws(() => resolvePublicSite({ ...publicSite, url }), /HTTPS|credentials/);
    assert.throws(() => resolvePublicSite({ ...publicSite, channels: { ...publicSite.channels, github: url } }), /HTTPS|credentials/);
  }
  for (const url of ['https://example.test/path', 'https://example.test/?tracking=yes', 'https://example.test/#home']) {
    assert.throws(() => resolvePublicSite({ ...publicSite, url }), /root origin/);
  }
});
test('screen preview resizes the running game by simulating width media queries', () => {
  const none = () => false, all = () => true;
  assert.equal(mediaMatchesWidth('(max-width: 650px)', 390, none), true);
  assert.equal(mediaMatchesWidth('(max-width: 650px)', 768, none), false);
  assert.equal(mediaMatchesWidth('(min-width: 901px)', 768, none), false);
  assert.equal(mediaMatchesWidth('(min-width: 651px) and (max-width: 900px) and (max-height: 500px)', 768, all), true);
  assert.equal(mediaMatchesWidth('(min-width: 651px) and (max-width: 900px) and (max-height: 500px)', 768, none), false);
  assert.equal(mediaMatchesWidth('(max-width: 360px), (min-width: 700px)', 768, none), true);
  assert.equal(mediaMatchesWidth('(prefers-reduced-motion: reduce)', 390, all), null);
  assert.equal(mediaMatchesWidth('not all and (max-width: 650px)', 390, none), null);
  assert.equal(mediaMatchesWidth('(width <= 650px)', 390, none), null);
});