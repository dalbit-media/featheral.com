import './style.css';
import './settlement.css';
import './marketplace.css';
import './communicate.css';
import './pages.css';
import { canAfford, isWater, radius, stages, terrainAt, terrainDetails, terrainResources } from './engine.ts';
import type { Cost, Game, Resource } from './engine.ts';
import type { ApiState, Command, Expedition } from './api-types.ts';
import { connect, refresh, send } from './api.ts';
import { icon } from './icons.ts';
import { ScreenPreview } from './screen-preview.ts';
import { World } from './world.ts';
import { claimCooldownMs, defaultClockSpeed, displayServerTime, environmentAt, serverClockStaleMs, serverSyncIntervalMs, worldDayMs, worldWeekMs } from './environment.ts';
import { compactServerCountdown, completionProgress, environmentDetails, updateClockTime, updateWeekCalendar } from './environment-view.ts';
import { translate } from './i18n.ts';
import { language, languageLocale, localize } from './i18n-dom.ts';
import { editableAllocation, emergencyCollection, explorationCount, nextExploration, nextInvestigation, resourceCapacity, workforceCounts } from './workforce.ts';
import { inventoryPageSize, inventoryUsed, isCraftableItem, isDecorationItem, isVisibilityItem, itemName, itemStorage } from './items.ts';
import type { ItemId } from './items.ts';
import { craftingPanel, inventoryPanel } from './inventory-view.ts';
import type { CraftingFilter, InventoryFilter } from './inventory-view.ts';
import { settlementLayoutPanel, settlementScene } from './settlement-scene.ts';
import { arrangementError, isSettlementEntity, settlementBuildings, settlementEntityName, settlementPositions } from './settlement-layout.ts';
import type { GridPosition, SettlementEntity } from './settlement-layout.ts';
import { SettlementMap } from './settlement-map.ts';
import { isSettlementTask, settlementDockTasks, settlementTaskFromHash, settlementTasks } from './settlement-ui.ts';
import type { SettlementTask } from './settlement-ui.ts';
import { Marketplace } from './marketplace.ts';
import { federationPanel } from './federation-view.ts';
import { SettlementSale } from './settlement-sale.ts';
import { Inbox, SettlementChat } from './inbox.ts';
import { isWaterFacility, waterProductionMultiplier } from './water-facilities.ts';
import { isIncomeFacility } from './income.ts';
import { formatDollars } from './dollars.ts';
import { WalletPage } from './wallet-view.ts';
import { gamePage, primaryGamePageKeys, gamePages } from './game-pages.ts';
import { isConstruction } from './constructions.ts';
import { civicUpgradeCards, commercialUpgradeCards, constructionUpgradeCards, warehouseUpgradeCard, waterUpgradeCards } from './upgrade-view.ts';
import { guideContent, wireGuide } from './guide.ts';
import { gameConsumption } from './consumption.ts';
import { confirmationOpen, confirmConsumption } from './confirmation.ts';
import { AccountPane } from './account.ts';
import { activityKinds, activityName, isActivityItem, isActivityKind } from './automation.ts';
import type { ActivityKind } from './automation.ts';
import { downloadSnapshot, renderJournalEntries } from './journal.ts';
import './mobile.css';
import './collection.css';
import './game-layout.css';
import './world-chat.css';
import './explore-layout.css';
import { collectionClaimReason, collectionDurations, collectionItemDetails, collectionReceiptQuantity, isCollectionItem } from './collection.ts';
import { formatResourceAmount, isResource } from './resource-units.ts';
import { chatUnreadChangedEvent, chatPresenceChangedEvent, chatVisibilityChangedEvent } from './chat.ts';
import { customizationName, isCustomizationItem, isTitleItem, titleItems } from './customization.ts';

const navigationPage = gamePage(location.pathname);
const settlementPage = navigationPage === 'home', marketPage = navigationPage === 'market';
const bankPage = navigationPage === 'bank';
const explorePage = navigationPage === 'world';
const communityPage = !explorePage && !settlementPage && !marketPage && !bankPage;
let marketplace: Marketplace | null = null;
let settlementSale: SettlementSale | null = null;
let settlementResourceSale: SettlementSale | null = null;
let inbox: Inbox | null = null;
let settlementChat: SettlementChat | null = null;
const visitingSettlement = settlementPage ? new URL(location.href).searchParams.get('visit') : null;
let inventoryFilter: InventoryFilter = 'all';
let inventoryPage = 0;
let inventorySelection: ItemId | null = null;
let selectedBuilding: SettlementEntity = 'centre';
let settlementTask = settlementTaskFromHash(location.hash);
let craftingFilter: CraftingFilter = 'all';
let craftingQuantity = 1;
let pendingPlacement: { entity: SettlementEntity; origin: SettlementTask } | null = null;
let settlementMap: SettlementMap | null = null;
const crewDrafts = new Map<string, string>();
const pendingCrewAssignments = new Map<Resource, string>();
const failedCrewAssignments = new Set<Resource>();
let processingCrewAssignments = false;
let savingCrew: Resource | null = null;
const layoutDrafts = new Map<string, string>();
const taskScroll = new Map<SettlementTask, number>();
const disclosedDetails = new Set<string>();
const resources: Resource[] = ['wood', 'water', 'metal', 'oil'];
const names: Record<Resource, string> = { wood: 'Wood', water: 'Water', metal: 'Metal', oil: 'Oil' };
const resourceFmt = (resource: Resource, amount: number, compact = false) => formatResourceAmount(resource, amount, languageLocale, compact);
const resourceSales = new Map<Resource, SettlementSale>();
type ClaimOrigin = 'header' | 'settlement' | 'dialog';
const pendingClaims = new Map<Resource, ClaimOrigin>();
let processingClaims = false;
let currentClaim: Resource | null = null;
let nextClaimAt = 0;
const fmt = (n: number): string => n.toLocaleString(languageLocale);
const escape = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
let state: ApiState;
try {
  state = await connect();
} catch (error) {
  document.querySelector('#app')!.textContent = `Cannot connect to the authoritative API. Start the backend and reload. ${error instanceof Error ? error.message : 'Connection failed.'}`;
  localize(document);
  throw error;
}
let game: Game = state.game;
let synchronizedAt = performance.now();
let environment = state.environment;
let busy = false;
let journalQuery = '';
let management: Resource | 'population' | 'funds' | null = null;
let lastResourceManagement: Resource | 'funds' = 'wood';
const app = document.querySelector<HTMLDivElement>('#app')!;
app.classList.toggle('settlement-page', settlementPage);
app.classList.toggle('marketplace-page', marketPage || bankPage);
app.classList.toggle('explore-page', explorePage);
app.classList.toggle('community-page', communityPage);
app.classList.toggle('guide-page', navigationPage === 'help');
app.classList.toggle('has-world-chat', explorePage || settlementPage);
app.classList.toggle('inbox-full-page', navigationPage === 'communicate');
app.innerHTML = `
  <nav class="rail" aria-label="Main navigation">
    <a class="game-brand" href="/" aria-label="Featheral World"><img src="/shared/logo.svg" alt="" width="34" height="34"><span>WORLD</span></a>
    <div class="rail-links">
      ${primaryGamePageKeys.map(key => `<a class="nav-button ${key === navigationPage ? 'active' : ''}" href="${gamePages[key].path}" ${key === navigationPage ? 'aria-current="page"' : ''} aria-label="${gamePages[key].label}" title="${gamePages[key].label}">${icon(key)}<span>${gamePages[key].label}</span></a>`).join('')}
    </div>
    <div class="rail-bottom screen-mode-controls" role="group" aria-label="${translate('Screen preview', language)}">
      <button type="button" data-screen-mode="mobile" title="${translate('Preview mobile layout', language)}" aria-label="${translate('Preview mobile layout', language)}" aria-pressed="false">${icon('mobile')}</button>
      <button type="button" data-screen-mode="tablet" title="${translate('Preview tablet layout', language)}" aria-label="${translate('Preview tablet layout', language)}" aria-pressed="false">${icon('tablet')}</button>
      <button type="button" data-screen-mode="fullscreen" title="${translate('Toggle fullscreen', language)}" aria-label="${translate('Toggle fullscreen', language)}" aria-pressed="false">${icon('fullscreen')}</button>
      <span data-screen-mode-status role="status" aria-live="polite"></span>
    </div>
  </nav>
  <header class="topbar" data-no-central-wallet>
    <div class="server-clock" aria-label="World calendar" title="Game calendar · 7 days per week · 52 weeks per year · 13 weeks per season">
      <div class="clock-heading"><small id="clock-sync-status" hidden>SYNC PAUSED</small><small id="clock-speed" hidden>20x DEV</small></div>
      <strong id="world-time"></strong>
    </div>
    <div id="resource-bar" class="resource-bar" aria-label="Resource inventory"></div>
    <button type="button" class="resource-manager-button" data-action="acquisition-management" aria-label="Resource settings" title="Resource settings" aria-haspopup="dialog" aria-controls="management-dialog">${icon('settings')}<span>Resource settings</span></button>
    <button class="population-health" data-action="population-management" aria-controls="management-dialog" aria-haspopup="dialog">
      ${icon('people')}<span class="population-health-total"><small>Population</small><strong data-population-total>0</strong></span>
      <span class="population-health-work"><span><i class="population-status active"></i><small>Busy now</small><strong data-population-active>0</strong></span><span><i class="population-status idle"></i><small>Available now</small><strong data-population-idle>0</strong></span><span class="population-health-meter"><i></i></span></span>
      <span class="population-health-status">${icon('check')}</span>
    </button>
    <div class="topbar-account">
      <button type="button" class="header-wallet" data-action="funds-management" aria-label="Available FTH$ balance" aria-haspopup="dialog" aria-controls="management-dialog"><strong data-header-dollars>0</strong><small>FTH$</small></button>
      <button type="button" class="account-avatar" data-account-toggle aria-label="Account" title="Account" aria-controls="account-pane" aria-expanded="false">${icon('account')}</button>
    </div>
  </header>
  ${!explorePage ? '' : `<aside class="sidebar" id="explore-sidebar" aria-label="Territory overview"><div class="sidebar-mobile-heading"><strong>Explore</strong><div><a class="button" href="/settlement/#residents" aria-label="Residents" title="Residents">${icon('people')}</a><a class="button" href="/settlement/">${icon('home')} Settlement ${icon('chevron')}</a></div></div><div id="sidebar-content"></div><section class="location-card" id="location-card" aria-labelledby="current-tile-title"></section></aside>`}
  ${explorePage || settlementPage ? '<aside class="weather-overlay" aria-label="World conditions"><div data-map-environment></div></aside>' : ''}
  <main class="map" aria-label="Exploration map" ${!explorePage ? 'hidden' : ''}>
    <canvas id="world" tabindex="0" aria-label="Procedural world. Click unknown nearby terrain to send a week-long expedition with two residents. Travel on known terrain with arrow keys. Drag to pan and scroll to zoom."></canvas>
    <div class="map-heading"><div class="eyebrow"><span class="status-dot"></span> SECTOR 01</div><h1>Verdant Reach.</h1><p>Explore. Settle. Grow.</p></div>
    <div class="map-coordinate">${icon('compass')}<span id="coordinates">0° N &nbsp; 0° E</span><span class="coordinate-divider"></span><span class="live-label">LIVE WORLD</span></div>
    <div class="map-label" aria-hidden="true">T H E &nbsp; V E R D A N T &nbsp; R E A C H</div>
    <div class="map-toolbar" aria-label="Map controls">
      <button data-action="zoom-in" aria-label="Zoom in" title="Zoom in">${icon('plus')}</button>
      <button data-action="zoom-out" aria-label="Zoom out" title="Zoom out">${icon('minus')}</button>
      <span></span><button data-action="recenter" aria-label="Center on explorer" title="Center on explorer">${icon('locate')}</button>
      <button data-action="home" aria-label="Return to settlement" title="Return to settlement">${icon('home')}</button>
    </div>
    <div class="compass-rose" aria-hidden="true"><span>N</span>${icon('compass')}</div>
    <div class="minimap"><div class="minimap-title">${icon('world')}<span>Your known world</span><span id="known-count"></span></div><canvas id="minimap" aria-label="Minimap showing explored terrain and nearby silhouettes fading into fog. Fogged previews are not explored."></canvas><div class="minimap-bottom"><span><i></i> Explored</span><span>THE REST IS YOURS TO DISCOVER</span></div></div>
    <div class="map-bottom"><span>${icon('compass')} Drag to look around <b>·</b> Click to explore <b>·</b> WASD to move</span><span>PROCEDURAL WORLD <i></i> ENDLESS POSSIBILITIES</span></div>
  </main>
  ${settlementPage ? '<main class="settlement-view" id="settlement-content" aria-label="Settlement"></main>' : ''}
  ${marketPage ? '<main class="marketplace-view" id="marketplace-content" aria-label="Marketplace"></main>' : ''}
  ${bankPage ? '<main class="marketplace-view featheral-bank-view" id="bank-content" aria-label="Wallet and staking"></main>' : ''}
  ${communityPage ? '<main class="community-view" id="community-content" tabindex="-1"></main>' : ''}
  ${explorePage || settlementPage ? `<aside class="world-chat" aria-labelledby="world-chat-title" tabindex="-1"><header><h2 id="world-chat-title">${settlementPage ? 'Settlement visitor chat' : 'Public nearby chats'}</h2><button type="button" class="button" data-chat-toggle aria-expanded="false" aria-controls="world-chat-content" aria-describedby="world-chat-users" aria-label="Expand chat">${icon('communicate')}</button><span class="chat-user-badge" id="world-chat-users" data-chat-users data-no-localize aria-live="polite">—</span><span class="chat-unread-badge" data-chat-unread data-no-localize hidden aria-live="polite"></span></header><div id="world-chat-content" hidden><div data-social-content></div></div></aside>` : ''}
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <dialog id="management-dialog" class="management-dialog" aria-labelledby="management-title">
    <header><h2 id="management-title"></h2><button class="button" data-action="close-management" aria-label="Close">${icon('close')}</button></header>
    <div class="management-resource-switcher" hidden><label for="management-resource">Resource settings</label><select id="management-resource" data-management-resource>${resources.map(resource => `<option value="${resource}">${names[resource]}</option>`).join('')}<option value="funds">FTH$ treasury</option></select></div>
    <div class="management-content"></div>
  </dialog>
`;
const screenModeControls = app.querySelector<HTMLElement>('.screen-mode-controls')!;
const screenModeStatus = screenModeControls.querySelector<HTMLElement>('[data-screen-mode-status]')!;
const screenPreviewBar = document.createElement('div');
screenPreviewBar.className = 'screen-preview-bar';
screenPreviewBar.setAttribute('role', 'group');
screenPreviewBar.setAttribute('aria-label', translate('Screen preview', language));
screenPreviewBar.hidden = true;
screenPreviewBar.innerHTML = `<button type="button" data-screen-mode="mobile" title="${translate('Preview mobile layout', language)}" aria-label="${translate('Preview mobile layout', language)}" aria-pressed="false">${icon('mobile')}</button><button type="button" data-screen-mode="tablet" title="${translate('Preview tablet layout', language)}" aria-label="${translate('Preview tablet layout', language)}" aria-pressed="false">${icon('tablet')}</button><button type="button" data-screen-preview-exit title="${translate('Exit preview', language)}" aria-label="${translate('Exit preview', language)}">${icon('close')}</button>`;
const screenModeButtons = [...screenModeControls.querySelectorAll<HTMLButtonElement>('[data-screen-mode]'), ...screenPreviewBar.querySelectorAll<HTMLButtonElement>('[data-screen-mode]')];
const screenPreview = new ScreenPreview();
const screenPreviewWidths = { mobile: 390, tablet: 768 } as const;
let screenPreviewMode: keyof typeof screenPreviewWidths | null = null;
function updateScreenMode(mode: 'mobile' | 'tablet' | 'fullscreen' | null): void {
  for (const button of screenModeButtons) button.setAttribute('aria-pressed', String(button.dataset.screenMode === mode));
}
function setScreenPreview(mode: keyof typeof screenPreviewWidths | null): void {
  screenPreviewMode = mode;
  screenPreview.set(mode ? screenPreviewWidths[mode] : null);
  screenPreviewBar.hidden = !mode;
  screenModeStatus.textContent = '';
  updateScreenMode(mode ?? (document.fullscreenElement ? 'fullscreen' : null));
}
function handleScreenModeClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
  if (!target) return;
  if (target.hasAttribute('data-screen-preview-exit')) {
    setScreenPreview(null);
    return;
  }
  const mode = target.dataset.screenMode;
  if (mode === 'mobile' || mode === 'tablet') {
    setScreenPreview(screenPreviewMode === mode ? null : mode);
    return;
  }
  if (mode === 'fullscreen') {
    screenModeStatus.textContent = '';
    if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen !== 'function') {
      screenModeStatus.textContent = translate('Fullscreen is not supported by this browser.', language);
      return;
    }
    if (screenPreviewMode) setScreenPreview(null);
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void request.catch(error => {
      screenModeStatus.textContent = `${translate('Fullscreen unavailable', language)}: ${error instanceof Error ? error.message : 'Browser request failed.'}`;
    });
  }
}
if (window.self !== window.top) screenModeControls.hidden = true;
else {
  document.body.append(screenPreviewBar);
  screenModeControls.addEventListener('click', handleScreenModeClick);
  screenPreviewBar.addEventListener('click', handleScreenModeClick);
  document.addEventListener('fullscreenchange', () => {
    updateScreenMode(document.fullscreenElement ? 'fullscreen' : screenPreviewMode);
  });
}const account = new AccountPane(document.querySelector<HTMLButtonElement>('[data-account-toggle]')!, language, () => state,
  next => { synchronize(next); render(); });
document.dispatchEvent(new Event('featheral:site-ready'));
localize(document);
function mountWorldChat(): void {
  const root = document.querySelector<HTMLElement>('[data-social-content]');
  if (!root) return;
  if (settlementPage && !settlementChat) settlementChat = new SettlementChat(root, () => state.csrf, language, visitingSettlement ?? undefined);
  else if (explorePage && !inbox) inbox = new Inbox(root, () => state.csrf, language, false, true);
}
const chatOverlay = document.querySelector<HTMLElement>('.world-chat');
const chatToggle = chatOverlay?.querySelector<HTMLButtonElement>('[data-chat-toggle]');
function setChatExpanded(expanded: boolean): void {
  if (!chatOverlay || !chatToggle) return;
  if (expanded && settlementTask) showSettlementTask(null, false);
  app.classList.toggle('chat-expanded', expanded);
  chatOverlay.querySelector<HTMLElement>('#world-chat-content')!.hidden = !expanded;
  chatToggle.setAttribute('aria-expanded', String(expanded));
  chatToggle.setAttribute('aria-label', translate(expanded ? 'Collapse chat' : 'Expand chat', language));
  chatToggle.innerHTML = icon(expanded ? 'close' : 'communicate');
  chatOverlay.querySelector<HTMLElement>('[data-communicate]')?.dispatchEvent(new Event(chatVisibilityChangedEvent));
}
function updateChatUsers(online: number | null): void {
  const badge = chatOverlay?.querySelector<HTMLElement>('[data-chat-users]');
  if (!badge) return;
  badge.textContent = online === null ? '—' : String(online);
  const description = online === null ? translate('Chat user count unavailable', language)
    : `${translate('Users in this chat (including you when connected)', language)}: ${online}`;
  badge.setAttribute('aria-label', description);
  badge.title = description;
}
updateChatUsers(null);
chatOverlay?.addEventListener(chatPresenceChangedEvent, event => {
  if (!(event instanceof CustomEvent)) return;
  if (event.detail === null || (Number.isSafeInteger(event.detail) && event.detail >= 0)) updateChatUsers(event.detail);
});
chatOverlay?.addEventListener(chatUnreadChangedEvent, event => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'number' || !Number.isSafeInteger(event.detail) || event.detail < 0) return;
  const badge = chatOverlay.querySelector<HTMLElement>('[data-chat-unread]')!;
  badge.id = 'world-chat-unread';
  badge.hidden = event.detail === 0;
  badge.textContent = event.detail > 99 ? '99+' : String(event.detail);
  badge.setAttribute('aria-label', `${translate('Unread messages', language)}: ${event.detail}`);
  chatToggle?.setAttribute('aria-describedby', event.detail ? `world-chat-users ${badge.id}` : 'world-chat-users');
});
chatToggle?.addEventListener('click', () => setChatExpanded(chatToggle.getAttribute('aria-expanded') !== 'true'));
chatOverlay?.addEventListener('keydown', event => {
  if (event.key === 'Escape' && chatToggle?.getAttribute('aria-expanded') === 'true') {
    event.stopPropagation();
    setChatExpanded(false);
    chatToggle.focus();
  }
});
function focusWorldChat(): void { setChatExpanded(true); chatOverlay?.focus(); }
const managementDialog = document.querySelector<HTMLDialogElement>('#management-dialog')!;
managementDialog.addEventListener('close', () => { management = null; render(); });
const world = !explorePage ? null : new World(document.querySelector<HTMLCanvasElement>('#world')!, document.querySelector<HTMLCanvasElement>('#minimap')!, () => game, (x, y, collect) => {
  const resource = terrainResources[terrainAt(x, y, game.seed)];
  if (collect && resource && game.explored.includes(`${x},${y}`) && state.resourceAccess[resource].available
    && emergencyCollection(state.pending, state.collection?.fees ?? { wood: 0, water: 0, metal: 0, oil: 0 }, state.dollars)[resource] >= 1) {
    void act({ type: 'map-collect', x, y });
  } else requestMove(x, y);
}, () => environment, () => emergencyCollection(state.pending, state.collection?.fees ?? { wood: 0, water: 0, metal: 0, oil: 0 }, state.dollars), () => translate('Collect', language));
function requestMove(x: number, y: number): void {
  if (!game.explored.includes(`${x},${y}`)) {
    const reason = upkeepPauseReason();
    if (reason) {
      toast(reason, true);
      return;
    }
    if (state.workforce.expeditions.some(expedition => expedition.x === x && expedition.y === y)) {
      toast('An expedition is already exploring this destination. Choose another location.', true);
      return;
    }
  }
  void act({ type: 'move', x, y }, true);
}
function upkeepPauseReason(): string | null {
  if (state.waterUpkeep?.paused) return 'Restore Water supplies before starting advanced activity.';
  if (state.settlementUpkeep?.resources.wood.shortage) return 'Restore Wood heating supplies before starting advanced activity.';
  if (state.settlementUpkeep?.resources.metal.shortage) return 'Restore Metal repair supplies before starting advanced activity.';
  return null;
}
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, error = false): void {
  for (const resource of resources) {
    const quantity = collectionReceiptQuantity(message, resource);
    if (quantity !== null) {
      message = translate(`${names[resource]} collected: ${resourceFmt(resource, quantity)}. ${message.endsWith('No transport fee.') ? 'No transport fee.' : 'FTH$ transport paid.'}`, language);
      break;
    }
  }
  const el = document.querySelector<HTMLDivElement>('#toast')!;
  el.innerHTML = `${icon(error ? 'help' : 'check')}<span>${escape(message)}</span>`;
  localize(el);
  el.className = `toast visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), error ? 7000 : 4500);
}
async function act(command: Command, recenter = false): Promise<boolean> {
  if (busy || confirmationOpen()) { toast('Please wait for the current server request.', true); return false; }
  const assignmentDraft = command.type === 'assign' ? crewDrafts.get(`crew-${command.resource}`) : undefined;
  const submittedDraft = command.type === 'assign' && assignmentDraft !== undefined && Number(assignmentDraft) === command.workers ? assignmentDraft : undefined;
  busy = true;
  try {
    const quote = gameConsumption(state, command);
    if (quote && command.type !== 'claim') {
      if (!await confirmConsumption(quote, language)) return false;
      synchronize(await refresh());
      render();
      if (JSON.stringify(gameConsumption(state, command)) !== JSON.stringify(quote)) {
        toast('Requirements changed. Review the updated costs and try again.', true);
        return false;
      }
    }
    app.classList.add('action-pending');
    synchronize(await send(state, command));
    if (command.type === 'assign' && submittedDraft !== undefined && crewDrafts.get(`crew-${command.resource}`) === submittedDraft) crewDrafts.delete(`crew-${command.resource}`);
    if (command.type === 'automatic') {
      crewDrafts.clear();
      pendingCrewAssignments.clear();
      failedCrewAssignments.clear();
    }
    render();
    if (recenter) world?.center();
    if (state.message) toast(state.message);
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : 'The action could not be completed.', true);
    try { synchronize(await refresh()); render(); }
    catch (refreshError) { toast(`Server state unavailable; reconnect before retrying. ${refreshError instanceof Error ? refreshError.message : ''}`, true); }
    return false;
  } finally {
    busy = false;
    app.classList.remove('action-pending');
    void saveCrewAssignments();
  }
}
function costChips(cost: Cost, showNames = false): string {
  return Object.entries(cost).map(([key, value]) => {
    const insufficient = key === 'dollars' ? state.dollars < value : game.stock[key as Resource] < value;
    const name = key === 'dollars' ? 'FTH$' : names[key as Resource];
    const amount = isResource(key) ? resourceFmt(key, value) : fmt(value);
    return `<span class="cost ${insufficient ? 'insufficient' : ''}" role="img" aria-label="${amount} ${name}${insufficient ? ', insufficient' : ''}" title="${amount} ${name}">${icon(key)}${showNames ? `<span>${name}</span><strong>${amount}</strong>` : amount}</span>`;
  }).join('');
}
function requirement(symbol: string, label: string, met: boolean): string {
  return `<span class="requirement ${met ? 'met' : ''}" aria-label="${escape(label)}: ${met ? 'met' : 'required'}">${icon(symbol)}${escape(label)}${icon(met ? 'check' : 'lock', 'requirement-status')}</span>`;
}
function meter(value: number, max: number, label: string, resource?: Resource): string {
  return `<progress value="${Math.min(value, max)}" max="${Math.max(1, max)}" aria-label="${escape(label)}: ${resource ? resourceFmt(resource, value) : fmt(value)} / ${resource ? resourceFmt(resource, max) : fmt(max)}"></progress>`;
}
function render(): void {
  renderEnvironment();
  renderResources();
  account.updateBalance(state.fthg, languageLocale);
  const headerDollars = document.querySelector<HTMLElement>('[data-header-dollars]')!;
  headerDollars.textContent = formatDollars(state.dollars, languageLocale);
  const walletLabel = `${translate('Available FTH$ balance', language)}: FTH$ ${headerDollars.textContent}`;
  headerDollars.parentElement!.setAttribute('aria-label', walletLabel);
  headerDollars.parentElement!.setAttribute('title', walletLabel);
  document.querySelector('#coordinates')!.textContent = `${Math.abs(game.position.y)}° ${game.position.y >= 0 ? 'N' : 'S'}   ${Math.abs(game.position.x)}° ${game.position.x >= 0 ? 'E' : 'W'}`;
  document.querySelector('#known-count')!.textContent = `${fmt(game.explored.length)} tiles`;
  if (explorePage) renderSidebar();
  renderPopulation();
  if (settlementPage) renderSettlement();
  renderManagement();
  renderClaimControls();
  if (marketPage) marketplace?.balances();
  if (explorePage) {
    const terrain = terrainAt(game.position.x, game.position.y, game.seed), resource = terrainResources[terrain];
    const founding = game.stage < 0;
    document.querySelector('#location-card')!.innerHTML = `<header class="tile-heading"><div class="location-icon resource-${resource}">${icon(resource)}</div><div class="location-description"><span class="eyebrow">YOUR LOCATION</span><h3 id="current-tile-title">${terrainDetails[terrain].name}</h3></div><span class="tile-coordinates" aria-label="Tile coordinates"><span data-no-localize>${game.position.x}, ${game.position.y}</span></span></header><div class="tile-resource"><div><span class="tile-resource-name">${names[resource]}</span><span class="tile-pending"><span>${founding ? 'Owned' : 'Ready to collect'}</span><strong>${resourceFmt(resource, founding ? game.stock[resource] : state.pending[resource])}</strong></span></div>${founding ? '' : `<button class="button gather-button" data-settlement-panel="residents">Crews ${icon('people')}</button>`}</div>`;
  }
  if (communityPage) renderCommunityPage();
  renderRecruitment();
  renderWorkTimers();
  localize(app);
}
function synchronize(next: ApiState): void {
  state = next;
  game = state.game;
  synchronizedAt = performance.now();
}
function renderEnvironment(): void {
  const elapsed = performance.now() - synchronizedAt;
  const timestamp = displayServerTime(state.serverTime, elapsed, state.clockSpeed);
  environment = environmentAt(timestamp);
  const syncPaused = elapsed > serverClockStaleMs;
  document.querySelector<HTMLElement>('#clock-sync-status')!.hidden = !syncPaused;
  document.querySelector('.server-clock')!.classList.toggle('sync-paused', syncPaused);
  const calendar = document.querySelector<HTMLElement>('#world-time')!;
  updateWeekCalendar(calendar, environment, timestamp);
  const speed = document.querySelector<HTMLElement>('#clock-speed')!;
  speed.hidden = state.clockSpeed === 1;
  speed.textContent = state.clockSpeed === defaultClockSpeed ? translate('5 MIN / WEEK', language) : `${state.clockSpeed}x`;
  speed.title = translate('The game clock runs continuously. A game week takes five real minutes at the default speed.', language);
  document.querySelectorAll<HTMLElement>('[data-map-environment]').forEach(overlay => {
    const expanded = overlay.querySelector<HTMLDetailsElement>('details')?.open ?? false;
    const content = environmentDetails(environment, true);
    if (overlay.dataset.conditions !== content) {
      overlay.innerHTML = content;
      overlay.dataset.conditions = content;
      overlay.querySelector<HTMLDetailsElement>('details')!.open = expanded;
    }
    localize(overlay);
  });
  const map = document.querySelector<HTMLElement>('.map')!;
  map.dataset.season = environment.season;
  map.dataset.phase = environment.phase;
  map.dataset.weather = environment.weather;
  const district = document.querySelector<HTMLElement>('.settlement-panorama');
  if (district) {
    district.dataset.season = environment.season; district.dataset.phase = environment.phase;
  }
  document.querySelector('#world')!.setAttribute('aria-description', `${environment.season}, ${environment.phase}, ${environment.weather}, ${environment.temperature} degrees Celsius.`);
  renderRecruitment();
  renderWorkTimers();
  localize(document.querySelector('.server-clock')!);
  localize(document.querySelector('#world')!);
}
function renderPopulation(): void {
  const compact = new Intl.NumberFormat(languageLocale, { notation: 'compact', maximumFractionDigits: 1, maximumSignificantDigits: 3 });
  const counts = workforceCounts(game.population, state.workforce);
  const idle = counts.available, active = counts.gathering + counts.exploring;
  document.querySelector('[data-population-active]')!.textContent = compact.format(active);
  document.querySelector('[data-population-idle]')!.textContent = compact.format(idle);
  document.querySelector('[data-population-total]')!.textContent = compact.format(game.population);
  const button = document.querySelector<HTMLButtonElement>('.population-health')!;
  const status = !game.population ? 'Recruit residents' : state.waterUpkeep?.paused ? 'Water shortage'
    : state.settlementUpkeep?.resources.wood.shortage ? 'Wood heating shortage'
    : state.settlementUpkeep?.resources.metal.shortage ? 'Metal repair shortage'
    : game.stock.water < (state.waterUpkeep?.weeklyConsumption ?? 0) ? 'Low Water reserve' : idle < 2 ? 'No explorer crew' : 'Healthy';
  button.dataset.health = !game.population || upkeepPauseReason() ? 'critical' : status === 'Healthy' ? 'healthy' : 'warning';
  button.title = `${translate('Gathering now', language)}: ${fmt(counts.gathering)} · ${translate('Exploring now', language)}: ${fmt(counts.exploring)} · ${translate('Available now', language)}: ${fmt(idle)} · ${translate(status, language)}`;
  button.setAttribute('aria-label', `${translate('Population', language)}: ${fmt(game.population)} · ${button.title}`);
  button.querySelector<HTMLElement>('.population-health-meter i')!.style.width = `${game.population ? active / game.population * 100 : 0}%`;
  button.querySelector('.population-health-status')!.innerHTML = icon(status === 'Healthy' ? 'check' : status.includes('Water') ? 'water' : 'people');
}
function renderRecruitment(): void {
  const elapsed = performance.now() - synchronizedAt;
  const remaining = Math.max(0, Math.ceil((state.inviteReadyAt - displayServerTime(state.serverTime, elapsed, state.clockSpeed)) / 1000));
  const stale = elapsed > serverClockStaleMs;
  const recruitment = state.recruitment;
  document.querySelectorAll<HTMLButtonElement>('[data-action="invite"]').forEach(button => {
    button.disabled = game.stage < 0 || !!recruitment || remaining > 0 || stale || !!upkeepPauseReason() || state.dollars < state.recruitmentDollars;
    button.title = upkeepPauseReason() || 'Pay FTH$ upfront. Residents arrive after one game week. One batch at a time; no automatic repeat.';
    const compact = button.classList.contains('sidebar-recruitment');
    button.querySelector('[data-invite-label]')!.textContent = stale ? 'Sync paused' : recruitment && !remaining ? compact ? 'Confirming' : 'Awaiting server confirmation'
      : recruitment ? 'Recruiting' : remaining ? compact ? 'Cooldown' : 'Recruitment cooldown' : 'Invite';
    button.setAttribute('aria-label', stale ? 'Invite residents, server sync required' : recruitment
      ? `Recruiting ${recruitment.population} residents, ready in ${remaining} server seconds`
      : remaining ? `Invite residents, ready in ${remaining} server seconds` : 'Invite residents');
    button.title = `${button.getAttribute('aria-label')}. ${button.title}`;
    button.querySelector<HTMLElement>('[data-invite-cost]')!.hidden = !!recruitment;
    button.querySelector<HTMLElement>('[data-invite-duration]')!.hidden = !!recruitment;
    if (!recruitment) button.querySelector<HTMLElement>('[data-invite-duration]')!.textContent = remaining
      ? completionProgress(state.inviteReadyAt - worldWeekMs, state.inviteReadyAt, displayServerTime(state.serverTime, elapsed, state.clockSpeed)).countdown : compact ? `1 ${translate('wk', language)}` : '1 game week';
    button.setAttribute('aria-description', translate(stale ? 'Sync paused' : upkeepPauseReason() || (recruitment ? 'Recruiting'
      : remaining ? 'Recruitment cooldown' : state.dollars < state.recruitmentDollars ? 'Not enough FTH$' : 'Grow population'), language));
    localize(button);
  });
}
function renderWorkTimers(): void {
  const elapsed = performance.now() - synchronizedAt;
  const timestamp = displayServerTime(state.serverTime, elapsed, state.clockSpeed);
  const stale = elapsed > serverClockStaleMs;
  document.querySelectorAll<HTMLElement>('[data-completion-start][data-completion-end]').forEach(el => {
    const progress = completionProgress(Number(el.dataset.completionStart), Number(el.dataset.completionEnd), timestamp);
    const countdown = translate(stale ? 'Sync paused' : progress.countdown, language);
    const meter = el.querySelector<HTMLProgressElement>('progress')!;
    meter.value = progress.percent;
    el.style.setProperty('--completion-progress', `${progress.percent}%`);
    el.style.setProperty('--completion-scale', String(progress.percent / 100));
    meter.setAttribute('aria-valuetext', `${Math.floor(progress.percent)}% · ${countdown}`);
    el.querySelector<HTMLElement>('[data-completion-time]')!.textContent = countdown;
    el.querySelector<HTMLElement>('[data-completion-percent]')!.textContent = `${Math.floor(progress.percent)}%`;
    el.classList.toggle('sync-paused', stale);
    el.classList.toggle('awaiting-confirmation', progress.percent === 100);
  });
  document.querySelectorAll<HTMLElement>('[data-ready-at]').forEach(el => {
    const remaining = Math.max(0, Math.ceil((Number(el.dataset.readyAt) - timestamp) / 1000));
    const detailed = translate(stale ? 'Sync paused' : remaining ? `${Math.floor(remaining / 3600)}h ${Math.floor(remaining % 3600 / 60)}m ${remaining % 60}s server time` : 'Awaiting server confirmation', language);
    const compact = el.hasAttribute('data-compact-time');
    el.textContent = compact ? translate(stale ? 'Sync paused' : remaining ? compactServerCountdown(remaining) : 'Confirming', language) : detailed;
    if (compact) {
      el.title = detailed;
      el.setAttribute('aria-label', detailed);
    }
  });
  for (const resource of resources) {
    const disabled = stale || game.stage < 0 || !state.resourceAccess[resource].available;
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(`#crew-${resource}, #crew-slider-${resource}, [data-action="retry-assign"][data-resource="${resource}"]`).forEach(control => { control.disabled = disabled; });
  }
  document.querySelectorAll<HTMLElement>('.crew-controls').forEach(syncCrewControls);
}
function canClaim(resource: Resource): boolean {
  return state.capacity > 0 && state.pending[resource] >= 1;
}
function resourceSettingsButton(resource: Resource): string {
  const label = `${translate('Resource settings', language)} · ${translate(names[resource], language)}`;
  return `<button class="resource-settings" data-action="resource-management" data-resource="${resource}" aria-label="${label}" title="${label}" aria-haspopup="dialog" aria-controls="management-dialog">${icon('settings')}</button>`;
}
function resourceClaimButton(resource: Resource): string {
  const fee = state.collection?.fees[resource] ?? 0;
  return `<button class="button primary resource-collect" data-action="collect-resource" data-resource="${resource}" ${collectionClaimReason(state, resource) || pendingClaims.has(resource) ? 'disabled' : ''}>${icon('download')}Collect${costChips({ dollars: fee })}</button>`;
}
function resourceAcquisitionActions(resource: Resource, showOwned = false): string {
  return `<div class="resource-acquisition">${showOwned ? `<span><small>Owned</small><strong>${resourceFmt(resource, game.stock[resource])}</strong></span>` : ''}<span><small>Ready to collect</small><strong>${resourceFmt(resource, state.pending[resource])}</strong></span>${resourceClaimButton(resource)}</div>`;
}
function renderClaimControls(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-action="collect-resource"]').forEach(button => {
    const resource = resources.find(key => key === button.dataset.resource)!;
    const reason = collectionClaimReason(state, resource), pending = pendingClaims.has(resource);
    button.disabled = !!reason || pending;
    button.setAttribute('aria-busy', String(pending));
    const description = `${translate('Collect', language)} · ${translate(names[resource], language)} · ${translate('Owned', language)}: ${resourceFmt(resource, game.stock[resource])} · ${translate('Ready to collect', language)}: ${resourceFmt(resource, state.pending[resource])} · ${translate('Transport', language)}: FTH$ ${formatDollars(state.collection?.fees[resource] ?? 0, languageLocale)}`;
    button.setAttribute('aria-label', description);
    button.title = pending ? translate('Collecting', language) : reason ? translate(reason, language) : description;
    button.classList.toggle('claim-pending', pending);
  });
}
function queueClaim(resource: Resource, target: HTMLElement): void {
  if (pendingClaims.has(resource)) return;
  if ((busy && currentClaim === null) || confirmationOpen()) { toast('Please wait for the current server request.', true); return; }
  const reason = collectionClaimReason(state, resource);
  if (reason) { toast(reason, true); return; }
  pendingClaims.set(resource, target.closest('#management-dialog') ? 'dialog' : target.closest('#resource-bar') ? 'header' : 'settlement');
  renderClaimControls();
  void processClaims();
}
async function processClaims(): Promise<void> {
  if (processingClaims) return;
  processingClaims = true;
  try {
    while (pendingClaims.size) {
      const [resource, origin] = pendingClaims.entries().next().value!;
      const delay = nextClaimAt - performance.now();
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      if (busy || confirmationOpen()) {
        toast('Please wait for the current server request.', true);
        pendingClaims.clear();
        break;
      }
      const reason = collectionClaimReason(state, resource);
      if (reason) toast(reason, true);
      else {
        currentClaim = resource;
        const success = await act({ type: 'claim', resource });
        currentClaim = null;
        nextClaimAt = performance.now() + claimCooldownMs + 50;
        if (success) {
          const quantity = collectionReceiptQuantity(state.message, resource);
          if (quantity !== null) showClaimFeedback(resource, quantity, origin);
        }
      }
      pendingClaims.delete(resource);
      renderClaimControls();
    }
  } finally {
    currentClaim = null;
    processingClaims = false;
    renderClaimControls();
  }
}
function showClaimFeedback(resource: Resource, quantity: number, origin: ClaimOrigin): void {
  const selector = `[data-action="collect-resource"][data-resource="${resource}"]`;
  const scope = origin === 'dialog' && managementDialog.open ? managementDialog
    : origin === 'settlement' ? app.querySelector('#settlement-content') : null;
  const target = scope?.querySelector<HTMLElement>(selector) ?? app.querySelector<HTMLElement>(`#resource-bar ${selector}`)!;
  const bounds = target.getBoundingClientRect();
  const effect = document.createElement('div');
  effect.className = `claim-feedback resource-${resource}`;
  effect.setAttribute('aria-hidden', 'true');
  effect.style.left = `${bounds.left + bounds.width / 2}px`;
  effect.style.top = `${bounds.top + bounds.height / 2}px`;
  effect.innerHTML = `<span class="claim-gain">${icon(resource)}<b>+${resourceFmt(resource, quantity)}</b></span>`;
  (scope === managementDialog ? managementDialog : document.body).append(effect);
  const cards = app.querySelectorAll<HTMLElement>(`[data-resource-card="${resource}"]`);
  cards.forEach(card => card.classList.add('resource-claimed'));
  setTimeout(() => { effect.remove(); cards.forEach(card => card.classList.remove('resource-claimed')); }, 1100);
}
function wireResourceTooltips(root: Element): void {
  root.querySelectorAll<HTMLElement>('.resource').forEach(el => {
    el.addEventListener('pointerenter', () => el.classList.remove('tooltip-dismissed'));
    el.addEventListener('focusin', () => el.classList.remove('tooltip-dismissed'));
  });
}
function renderResources(): void {
  const bar = document.querySelector('#resource-bar')!;
  if (!bar.childElementCount) {
    bar.innerHTML = resources.map(key => `<div class="resource resource-${key}" data-resource="${key}" data-resource-card="${key}">
      <button class="resource-summary" data-action="collect-resource" data-resource="${key}">${icon(key)}<span><small>${names[key]}</small><strong><span class="resource-total-full"></span><span class="resource-total-compact" aria-hidden="true"></span></strong></span><b class="collection-ready"></b></button>
      <div class="resource-accrual"><div class="resource-progress" aria-hidden="true"><div></div></div><span class="resource-pending"></span></div>
      <div class="resource-tooltip" id="resource-tooltip-${key}" role="tooltip"></div>
    </div>`).join('');
    wireResourceTooltips(bar);
  }
  for (const key of resources) {
    const card = bar.querySelector<HTMLElement>(`[data-resource="${key}"]`)!;
    const pending = state.pending[key], rate = state.rates[key];
    const capacity = resourceCapacity(state.capacity, key, game);
    const full = capacity > 0 && game.stock[key] >= capacity;
    card.querySelector('.resource-total-full')!.textContent = resourceFmt(key, game.stock[key]);
    card.querySelector('.resource-total-compact')!.textContent = resourceFmt(key, game.stock[key], true);
    const ready = canClaim(key);
    card.classList.toggle('collection-available', ready);
    card.querySelector<HTMLElement>('.collection-ready')!.textContent = ready ? translate('Collect', language) : '';
    const pendingLabel = card.querySelector<HTMLElement>('.resource-pending')!;
    const automation = (state.collection?.automationUntil[key] ?? 0) > state.serverTime;
    pendingLabel.textContent = ready ? `+${resourceFmt(key, pending, true)}` : automation ? translate('Auto', language) : rate ? `+${resourceFmt(key, rate, true)}/w` : '\u2014';
    pendingLabel.setAttribute('aria-label', translate(pending > 0 ? 'Ready to collect' : automation ? 'Auto-collection active' : 'Manual collection', language));
    card.classList.toggle('storage-full', full);
    card.querySelector<HTMLElement>('.resource-progress > div')!.style.width = `${capacity ? Math.min(100, game.stock[key] / capacity * 100) : 0}%`;
    const dailyUse = key === 'water' ? state.waterUpkeep?.dailyConsumption ?? 0
      : key === 'wood' || key === 'metal' ? state.settlementUpkeep?.resources[key].dailyConsumption ?? 0 : 0;
    const consumption = key === 'water' ? dailyUse : state.workforce.crews[key]?.weeklyDollarsCost ?? 0;
    const waterRisk = key === 'water' && !!state.waterUpkeep?.paused;
    card.classList.toggle('water-shortage', waterRisk);
    const supplyRisk = (key === 'wood' || key === 'metal') && !!state.settlementUpkeep?.resources[key].shortage;
    card.classList.toggle('supply-shortage', supplyRisk);
    const status = game.stage < 0 ? 'Settlement required.' : supplyRisk ? key === 'wood' ? 'Wood heating shortage' : 'Metal repair shortage' : full ? 'Storage full' : rate === 0 ? 'No crew' : '';
    card.querySelector('.resource-tooltip')!.innerHTML = `<h3>${names[key]}</h3>
      <dl><div><dt>Owned</dt><dd>${resourceFmt(key, game.stock[key])}</dd></div><div><dt>Storage capacity</dt><dd>${resourceFmt(key, capacity)}</dd></div><div><dt>Delivery</dt><dd>${automation ? 'Auto-collection active' : 'Manual collection'}</dd></div>${key !== 'oil' ? `<div><dt>Daily consumption</dt><dd>${resourceFmt(key, dailyUse)}</dd></div>` : ''}</dl>
      <section class="resource-weekly"><h4>${key === 'water' ? 'Resource flow' : '1 game week'}</h4><dl>
        <div><dt>${key === 'water' ? 'Collection / week' : 'Collection'}</dt><dd class="${rate ? 'resource-inflow' : 'resource-flow-zero'}">${rate ? '+' : ''}${resourceFmt(key, rate)}</dd></div>
        <div><dt>${key === 'water' ? 'Consumption / day' : 'FTH$ transport / week'}</dt><dd class="${consumption ? 'resource-outflow' : 'resource-flow-zero'}">${consumption ? '&minus;' : ''}${key === 'water' ? resourceFmt(key, consumption) : `${fmt(consumption)} FTH$`}</dd></div>
      </dl></section>${waterRisk ? '<p class="water-shortage-text">Water shortage pauses advanced activity, not residents.</p>' : ''}${status ? `<p>${status}</p>` : ''}`;
  }
}
function populationManagement(): string {
  return workforcePanel();
}
function renderManagement(): void {
  if (!management) return;
  const root = managementDialog.querySelector('.management-content')!;
  const title = management === 'population' ? 'Population management' : management === 'funds' ? 'FTH$ treasury' : names[management];
  managementDialog.dataset.view = management === 'population' || management === 'funds' ? management : 'resource';
  managementDialog.querySelector('#management-title')!.textContent = translate(title, language);
  managementDialog.querySelector<HTMLElement>('.management-resource-switcher')!.hidden = management === 'population';
  if (management !== 'population') managementDialog.querySelector<HTMLSelectElement>('#management-resource')!.value = management;
  if (management === 'population') {
    replaceContent(root, populationManagement());
  } else if (management === 'funds') {
    replaceContent(root, `<div class="treasury-balance">${icon('dollars')}<strong>${formatDollars(state.dollars, languageLocale)}</strong><small>FTH$</small></div>
      <p class="fineprint">Sell resources regularly to fund transport, recruitment and upgrades.</p>
      <a class="button wide" href="/bank/">Open wallet, conversion and staking</a><div data-settlement-resource-sale></div><a class="button wide" href="/market/">Open marketplace ${icon('arrow')}</a>`);
  } else {
    const resource = management, crew = state.workforce.crews[resource];
    const fee = state.collection?.fees[resource] ?? 0, expiry = state.collection?.automationUntil[resource] ?? 0;
    const ready = canClaim(resource), automated = expiry > state.serverTime;
    replaceContent(root, `<div class="resource-workspace"><section class="resource-pickup"><div class="management-metrics resource-${resource}"><div>${icon(resource)}<small>Owned</small><strong>${resourceFmt(resource, game.stock[resource])}</strong></div><div><small>Ready to collect</small><strong>${resourceFmt(resource, state.pending[resource])}</strong></div><div>${icon('dollars')}<small>Transport</small><strong>${formatDollars(fee, languageLocale)}</strong></div></div>
      ${crew ? completionMeter(crew.readyAt - worldWeekMs, crew.readyAt, 'Next collection') : '<p class="fineprint">No active work. New assignments take a full game week.</p>'}
      ${resource === 'wood' || resource === 'metal' ? settlementUpkeepPanel(false, resource) : ''}
      <div class="collection-actions">${resourceClaimButton(resource)}<button class="button" data-action="collect-sell" data-resource="${resource}" ${!ready ? 'disabled' : ''}>${icon('dollars')}Collect and sell</button></div>
      ${ready && state.dollars < fee ? '<p class="notice">Not enough FTH$ for pickup. Collect and sell pays transport from the proceeds.</p>' : ''}
      <div class="automation-heading"><h3>Auto-collection</h3>${automated ? `<span data-ready-at="${expiry}" data-compact-time></span>` : '<span>Inactive</span>'}</div>
      <div class="automation-items">${[...collectionDurations, 26, 52].map(weeks => {
        const matches = (id: ItemId, target: Resource | 'all') => isCollectionItem(id) && collectionItemDetails(id).resource === target && collectionItemDetails(id).weeks === weeks;
        const item = state.inventory.items.find(id => matches(id, resource)) ?? state.inventory.items.find(id => matches(id, 'all'));
        const all = item && isCollectionItem(item) && collectionItemDetails(item).resource === 'all';
        return `<button class="button automation-item" data-action="activate-collection" ${item ? `data-item="${item}"` : 'disabled'}>${icon('warehouse')}<strong>${weeks}w</strong><small>${all ? 'All resources' : item ? 'Activate' : 'Find or craft'}</small></button>`;
      }).join('')}</div><a class="button" href="/settlement/#inventory">Manage collector items</a><p class="fineprint">Find, craft or trade collection items for up to 52 game weeks. All-resource bundles cover all four resources. Transport always costs FTH$.</p></section>
      <section class="resource-allocation"><h3>Crew allocation</h3><p class="fineprint">${fmt(state.availableWorkers)} ${translate('Available now', language)} · ${fmt(game.population)} ${translate('Population', language)}</p>
      <button class="button wide" data-action="automatic" aria-pressed="${state.workforce.automatic}" ${game.stage < 0 ? 'disabled' : ''}>${state.workforce.automatic ? 'Automatic allocation: ON' : 'Automatic allocation: OFF'}</button>
      ${crewManagementCard(resource, false)}</section><section class="resource-trading"><div data-resource-sale="${resource}"></div>
      <div class="collection-links"><button class="button" data-action="population-management">${icon('people')}Manage crews</button><a class="button" href="/market/?asset=collection-${resource}-1">Marketplace ${icon('arrow')}</a></div></section></div>`);
  }
  renderRecruitment(); renderWorkTimers(); localize(managementDialog);
}
function openManagement(view: NonNullable<typeof management>): void {
  management = view;
  if (view !== 'population') lastResourceManagement = view;
  render();
  if (!managementDialog.open) managementDialog.showModal();
}
async function collectAndSell(resource: Resource): Promise<void> {
  if (busy || confirmationOpen()) { toast('Please wait for the current server request.', true); return; }
  openManagement(resource);
  resourceSales.get(resource)?.setSource('completed');
  render();
  managementDialog.querySelector<HTMLElement>('.resource-sale')?.scrollIntoView({ block: 'nearest' });
}
function gearCard(): string {
  return `<a class="sidebar-gear" href="/settlement/#inventory">${icon('layers')}<span><strong>Item inventory</strong><small><span>${state.inventory.equipped ? translate(itemName(state.inventory.equipped), language) : 'No item equipped'}</span> · <span>${radius(game)}-tile view</span></small></span>${icon('chevron')}</a>`;
}
function renderSidebar(): void {
  const next = stages[game.stage + 1], quote = nextExploration(game, state.workforce.expeditions);
  const exploreReason = fieldActionReason(quote, 'No nearby destination');
  const root = document.querySelector('#sidebar-content')!;
  const bag = state.inventory;
  const nextReturn = state.workforce.expeditions.reduce<Expedition | null>((next, team) => !next || team.readyAt < next.readyAt ? team : next, null);
  const upgradeReady = next && canAfford(game, next.cost) && game.population >= next.population
    && (game.stage >= 0 || !isWater(terrainAt(game.position.x, game.position.y, game.seed)));
  const room = inventoryUsed(bag) < itemStorage[bag.storage].capacity;
  const collectable = room && bag.pending.some(item => !bag.marketReserved?.includes(item));
  replaceContent(root, `
    <div class="explore-summary"><div class="settlement-card"><div class="settlement-card-body"><span class="mini-tag">${game.stage < 0 ? 'UNSETTLED' : stages[game.stage].name.toUpperCase()}</span>
    <div class="sidebar-stats"><span role="img" aria-label="${fmt(game.population)} residents">${icon('people')}<strong>${fmt(game.population)}</strong></span><span role="img" aria-label="${fmt(game.explored.length)} explored tiles">${icon('compass')}<strong>${fmt(game.explored.length)}</strong></span></div>
    ${next ? `<div class="next-stage"><span>${icon('arrow')} ${next.name}</span>${next.population ? `<span>${fmt(game.population)} / ${fmt(next.population)} ${icon('people')}</span>` : ''}</div>${next.population ? meter(game.population, next.population, `Residents for ${next.name}`) : requirement('home', 'Dry land', !isWater(terrainAt(game.position.x, game.position.y, game.seed)))}` : '<div class="complete-label">Capital complete</div>'}</div></div>
    </div><div class="explore-upkeep">${waterUpkeepPanel(true)}</div>
    <div class="sidebar-primary-actions" role="group" aria-label="Frequent actions">
      ${game.stage < 0 ? foundingPanel() : `
      <div class="sidebar-action-row">
      ${investigationButton(true)}
      <button class="button primary wide sidebar-expedition" data-action="explore" title="${escape(translate(exploreReason || 'Discover new land', language))}" aria-description="${escape(translate(exploreReason || 'Discover new land', language))}" ${exploreReason ? 'disabled' : ''}><span class="quick-action-heading">${icon('compass')}<span>Explore</span></span>${quote ? `<span class="quick-action-cost">${costChips({ dollars: quote.dollars }, true)}</span>${fieldDuration(quote.weeks)}` : ''}</button>
      ${recruitmentButton(true)}
      </div>
      <small class="field-fee-note" title="${escape(translate('Next field team fee multiplier', language))}">${translate('Investigate + Explore', language)} <b>${2 ** explorationCount(state.workforce.expeditions)}x</b></small>
      ${state.dollars === 0 ? `<a class="button primary wide" href="/settlement/#production">${icon('warehouse')} Collect and sell</a>` : ''}
      ${bag.pending.length ? `<button class="button primary wide" data-action="collect-items" ${collectable ? '' : 'disabled'}>${icon('layers')} Collect finds <b>${bag.pending.length}</b></button>${!collectable ? `<p class="fineprint">${room ? 'Reserved in market' : 'Item inventory full'}</p>` : ''}` : ''}`}
    </div>
    <div class="sidebar-status"><span>${state.availableWorkers} ${translate('Available now', language)}</span><small>${state.workforce.automatic ? 'Automatic allocation: ON' : 'Automatic allocation: OFF'}</small></div>
    ${nextReturn ? `<div class="sidebar-expeditions"><a href="/settlement/#residents">${translate(`${state.workforce.expeditions.length} field teams active`, language)}</a>${completionMeter(expeditionStartedAt(nextReturn), nextReturn.readyAt, 'Next return')}</div>` : ''}
    <div class="sidebar-secondary-actions" role="group" aria-label="Additional actions">
      ${game.stage >= 0 && next ? `<button class="button sidebar-upgrade" data-action="upgrade" ${upgradeReady ? '' : 'disabled'}>${icon('plus')} Upgrade ${costChips(next.cost)}</button>` : ''}
      <a class="button" href="/settlement/#residents">${icon('people')} Residents</a>
      <a class="button" href="/settlement/#production">${icon('warehouse')} Storage</a>
      <a class="button" href="/settlement/#crafting">${icon('spark')} Crafting</a>
    </div>
    ${gearCard()}`);
  renderRecruitment(); renderWorkTimers(); localize(root);
}
function fieldActionReason(quote: { dollars: number } | null, noDestination: string): string | null {
  return game.stage < 0 ? 'Establish a settlement first' : upkeepPauseReason() || (!quote ? noDestination
    : state.availableWorkers < 2 ? 'Needs 2 idle residents' : state.dollars < quote.dollars ? 'Not enough FTH$' : null);
}
function fieldDuration(weeks: number): string {
  return `<small class="quick-action-duration" aria-label="${escape(translate('residents', language))}: 2 · ${escape(translate(`${weeks} game week${weeks === 1 ? '' : 's'}`, language))}">${icon('people')} 2 · ${weeks} ${translate('wk', language)}</small>`;
}
function investigationButton(compact = false): string {
  const quote = nextInvestigation(game, state.workforce.expeditions);
  const reason = fieldActionReason(quote, 'No known destination available');
  const details = compact
    ? `<span class="quick-action-heading">${icon('search')}<span>Investigate</span></span>${quote ? `<span class="quick-action-cost">${costChips({ dollars: quote.dollars }, true)}</span>${fieldDuration(1)}` : ''}`
    : `${icon('search')} <span>Investigate</span> · 2 ${translate('residents', language)} · ${translate('1 game week', language)} ${quote ? costChips({ dollars: quote.dollars }) : ''}`;
  return `<button class="button${compact ? ' wide sidebar-investigation' : ''}" data-action="investigate" title="${escape(translate(reason || 'Investigate known land: two residents, one game week, 10% item chance.', language))}" aria-description="${escape(translate(reason || 'Investigate known land: two residents, one game week, 10% item chance.', language))}" ${reason ? 'disabled' : ''}>${details}</button>`;
}
function renderCommunityPage(): void {
  const root = document.querySelector<HTMLElement>('#community-content')!;
  if (navigationPage === 'help') {
    if (!root.childElementCount) { root.innerHTML = guideContent(language); localize(root); wireGuide(root, language); }
    return;
  }
  const title = gamePages[navigationPage].label;
  const description = navigationPage === 'communicate' || navigationPage === 'contacts' ? 'Public nearby settlement and federation conversations.'
    : navigationPage === 'federation' ? 'Build relationships. Shape your community. Grow together.'
      : 'The latest discoveries, milestones and everyday life in your settlement.';
  const heading = `<header class="page-heading"><span class="page-emblem">${icon(navigationPage)}</span><div><span class="eyebrow">YOUR WORLD, CONNECTED</span><h1>${title}</h1><p>${description}</p></div><a class="button" href="/help/#guide-community">${icon('help')} Field guide</a></header>`;
  if (navigationPage === 'communicate' || navigationPage === 'contacts') {
    if (!root.childElementCount) {
      const inboxHeading = navigationPage === 'communicate'
        ? `<header class="inbox-heading"><h1>${title}</h1><a class="button" href="/contacts/">${icon('people')} Contacts</a><a class="button" href="/help/#guide-community">${icon('help')} Field guide</a></header>` : heading;
      const appHost = location.hostname.endsWith('.localhost') || location.hostname === 'localhost' ? 'app.localhost' : 'app.featheral.com';
      const appUrl = `${location.protocol}//${appHost}${location.port ? ':' + location.port : ''}/`;
      root.innerHTML = `${inboxHeading}<p class="fineprint">Foundation work, team inbox, calls and shared files now live in <a href="${appUrl}">Featheral App</a>. Gameplay conversations and existing messages stay here.</p><div class="inbox-page" data-inbox></div>`;
      localize(root);
      inbox = new Inbox(root.querySelector<HTMLElement>('[data-inbox]')!, () => state.csrf, language, navigationPage === 'contacts');
    }
    return;
  }
  if (navigationPage === 'federation') {
    replaceContent(root, `${heading}<div class="federation-page-content"><div class="page-card federation-census"><h2>Community census</h2><div class="page-census"><span><small>Your settlement</small><strong>${fmt(game.population)}</strong></span><span><small>Your federation</small><strong>${state.population.federation === null ? '\u2014' : fmt(state.population.federation)}</strong></span><span><small>Global settlements</small><strong>${fmt(state.population.global)}</strong></span></div></div><section class="page-card">${federationPanel(state, language)}</section></div>`);
  } else {
    if (!root.childElementCount) root.innerHTML = `${heading}<section class="page-card journal-tools"><label for="journal-search">Search your journal</label><input id="journal-search" type="search" placeholder="Find a discovery or milestone" autocomplete="off"><span data-journal-count role="status"></span><div class="panel-actions"><button class="button" data-action="export">${icon('download')} Export snapshot</button><button class="button" data-action="legacy-export">${icon('journal')} Old browser save</button></div><p class="fineprint">Recent events are shown newest first. Exports are records, not importable balances.</p></section><section class="page-card journal-page-list" data-journal-list aria-label="Recent events"></section>`;
    renderJournal();
  }
  localize(root);
}
function renderJournal(): void {
  const root = document.querySelector<HTMLElement>('#community-content [data-journal-list]');
  if (!root) return;
  renderJournalEntries(root, document.querySelector('#community-content [data-journal-count]')!, game.log, journalQuery, language);
}
function replaceContent(root: Element, content: string): void {
  const oldTaskBody = root.querySelector<HTMLElement>('.settlement-task-body');
  if (isSettlementTask(oldTaskBody?.dataset.task)) taskScroll.set(oldTaskBody.dataset.task, oldTaskBody.scrollTop);
  const previous = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const focusAction = previous?.dataset.action;
  const focusResource = previous?.dataset.resource;
  const focusItem = previous?.dataset.item;
  const focusFilter = previous?.dataset.filter;
  const focusPage = previous?.dataset.page;
  const focusEntity = previous?.dataset.entity;
  const focusDetail = previous?.matches('summary') ? previous.parentElement?.dataset.detail : undefined;
  const focusTask = previous?.dataset.settlementPanel;
  root.querySelectorAll<HTMLDetailsElement>('details[data-detail]').forEach(el => {
    if (el.open) disclosedDetails.add(el.dataset.detail!); else disclosedDetails.delete(el.dataset.detail!);
  });
  const drafts = new Map([...crewDrafts, ...layoutDrafts]);
  root.querySelectorAll<HTMLInputElement>('[data-customization-name]').forEach(input => drafts.set(input.id, input.value));
  const scrollTop = root.scrollTop;
  const canvas = root.querySelector<HTMLCanvasElement>('#settlement-world');
  root.innerHTML = content;
  const sale = root.querySelector('[data-settlement-sale]');
  if (sale) settlementSale?.mount(sale);
  const resourceSale = root.querySelector<HTMLElement>('[data-resource-sale]');
  const saleResource = resources.find(resource => resource === resourceSale?.dataset.resourceSale);
  if (resourceSale && saleResource) {
    let sale = resourceSales.get(saleResource);
    if (!sale) {
      sale = new SettlementSale(() => state, next => { if (next.revision >= state.revision) { synchronize(next); render(); } }, toast, language, saleResource);
      resourceSales.set(saleResource, sale);
    }
    sale.mount(resourceSale);
  }
  const resourceSeller = root.querySelector('[data-settlement-resource-sale]');
  if (resourceSeller) settlementResourceSale?.mount(resourceSeller);
  if (canvas) root.querySelector('#settlement-world')?.replaceWith(canvas);
  for (const [id, value] of drafts) {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    if (el && !el.disabled) el.value = value;
  }
  root.querySelectorAll<HTMLElement>('.crew-controls').forEach(syncCrewControls);
  updateCrewSaveStatus();
  root.querySelectorAll<HTMLDetailsElement>('details').forEach(el => { el.open = disclosedDetails.has(el.dataset.detail ?? ''); });
  if (previous?.id) root.querySelector<HTMLElement>(`#${previous.id}`)?.focus({ preventScroll: true });
  if (focusAction && !previous?.id) root.querySelector<HTMLElement>(`[data-action="${focusAction}"]${focusResource ? `[data-resource="${focusResource}"]` : ''}${focusItem ? `[data-item="${focusItem}"]` : ''}${focusFilter ? `[data-filter="${focusFilter}"]` : ''}${focusPage !== undefined ? `[data-page="${focusPage}"]` : ''}${focusEntity ? `[data-entity="${focusEntity}"]` : ''}`)?.focus({ preventScroll: true });
  if (focusDetail) root.querySelector<HTMLElement>(`[data-detail="${focusDetail}"] > summary`)?.focus({ preventScroll: true });
  if (focusTask) root.querySelector<HTMLElement>(`[data-settlement-panel="${focusTask}"]`)?.focus({ preventScroll: true });
  if (focusAction === 'remove-layout' && !root.contains(document.activeElement)) root.querySelector<HTMLElement>('[data-action="prepare-layout"]')?.focus({ preventScroll: true });
  root.scrollTop = scrollTop;
  const taskBody = root.querySelector<HTMLElement>('.settlement-task-body');
  if (taskBody && isSettlementTask(taskBody.dataset.task)) taskBody.scrollTop = taskScroll.get(taskBody.dataset.task) ?? 0;
}
function showSettlementTask(task: SettlementTask | null, focus = true): void {
  if (task) setChatExpanded(false);
  const previous = settlementTask;
  settlementTask = task;
  if (task !== null) pendingPlacement = null;
  history.replaceState(null, '', `${location.pathname}${location.search}#${task ?? 'settlement-scene'}`);
  renderSettlement();
  if (focus) {
    const target = task ? '#settlement-task-title' : previous && previous !== 'overview' ? `#task-${previous}` : '#settlement-overview';
    document.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  }
}
function beginPlacement(entity: SettlementEntity): void {
  if (busy) { toast('Please wait for the current server request.', true); return; }
  if (game.stage < 0) { toast('Establish a settlement before arranging buildings.', true); return; }
  if (selectedBuilding !== entity) layoutDrafts.clear();
  selectedBuilding = entity;
  pendingPlacement = { entity, origin: settlementTask ?? 'decorate' };
  showSettlementTask(null, false);
  settlementMap?.center(settlementPositions(game, state.inventory)[entity] ?? { x: 0, y: 2 });
  document.querySelector<HTMLElement>('#settlement-world')?.focus({ preventScroll: true });
}
async function savePlacement(entity: SettlementEntity, position: GridPosition | null): Promise<void> {
  const error = arrangementError(game, state.inventory, entity, position);
  if (error) { toast(error, true); return; }
  const pending = pendingPlacement, drafts = [...layoutDrafts];
  if (await act({ type: 'arrange', entity, position })) {
    if (pendingPlacement === pending) pendingPlacement = null;
    if (selectedBuilding === entity && drafts.every(([key, value]) => layoutDrafts.get(key) === value)) layoutDrafts.clear();
    renderSettlement();
  }
}
function selectSettlementCell(entity: SettlementEntity | null, position: GridPosition): void {
  if (pendingPlacement) { void savePlacement(pendingPlacement.entity, position); return; }
  if (!entity) return;
  if (selectedBuilding !== entity) layoutDrafts.clear();
  selectedBuilding = entity;
  const building = settlementBuildings(game).find(building => building.id === entity);
  showSettlementTask(settlementTask === 'decorate' || !building ? 'decorate' : building.task);
}
function renderSettlement(): void {
  const root = document.querySelector('#settlement-content')!;
  if (visitingSettlement) {
    if (!root.childElementCount) {
      root.innerHTML = `<section class="page-card visitor-settlement"><h1>Visiting a settlement</h1><p>Visitor group chat is separate from public Explore and federation channels. Visiting does not grant access to another player's resources or controls.</p><button class="button" data-open-visitor-chat>Settlement visitor chat</button><a class="button" href="/contacts/">Contacts</a><a class="button" href="/settlement/">Your settlement</a></section>`;
      localize(root);
      root.querySelector('[data-open-visitor-chat]')!.addEventListener('click', focusWorldChat);
    }
    return;
  }
  const next = stages[game.stage + 1], quote = nextExploration(game, state.workforce.expeditions);
  let content = '';
  if (settlementTask === 'overview') content = `${progressionPanel()}<div class="settlement-resource-grid">${resources.map(resource => resourceStockCard(resource)).join('')}</div><div class="settlement-quick-actions">${recruitmentButton()}${investigationButton()}<button class="button" data-action="explore" ${upkeepPauseReason() || !quote || game.stage < 0 || state.availableWorkers < 2 || state.dollars < quote.dollars ? 'disabled' : ''}>${icon('compass')} Send expedition ${quote ? costChips({ dollars: quote.dollars }) : ''}</button></div>
    <div class="settlement-activity"><button data-settlement-panel="residents">${icon('people')}<span><strong>${state.availableWorkers} ${translate('Available now', language)}</strong><small>${state.workforce.automatic ? 'Automatic allocation: ON' : 'Automatic allocation: OFF'}</small></span>${icon('chevron')}</button>
    <button data-settlement-panel="residents">${icon('compass')}<span><strong>${translate(`${state.workforce.expeditions.length} field teams active`, language)}</strong><small>${state.workforce.expeditions.length ? `<span>Next return</span>: <span data-ready-at="${Math.min(...state.workforce.expeditions.map(team => team.readyAt))}"></span>` : 'No expeditions exploring.'}</small></span>${icon('chevron')}</button>
    ${state.inventory.pending.length ? `<button data-settlement-panel="inventory">${icon('layers')}<span><strong>Pending exploration finds</strong><small>${state.inventory.pending.length}</small></span>${icon('chevron')}</button>` : ''}</div>`;
  else if (settlementTask === 'residents') content = management && management !== 'funds' ? '<button class="button" data-action="population-management">Population management</button>' : populationManagement();
  else if (settlementTask === 'production') content = storagePanel();
  else if (settlementTask === 'sell') content = '<div data-settlement-resource-sale></div>';
  else if (settlementTask === 'inventory') content = inventoryPanel(state, costChips, inventoryFilter, language, 'settlement', inventoryPage, inventorySelection);
  else if (settlementTask === 'crafting') content = craftingPanel(state, costChips, craftingFilter, 'settlement', craftingQuantity);
  else if (settlementTask === 'decorate') content = settlementLayoutPanel(state, selectedBuilding, language);
  else if (settlementTask === 'buildings') content = `${progressionPanel()}${buildingsPanel()}`;
  if (settlementTask === 'buildings' || settlementTask === 'production') content += '<div data-settlement-sale></div>';
  const goal = next ? game.stage < 0 || game.population >= next.population
    ? `<button class="button primary" data-settlement-panel="buildings">${icon('layers')} ${next.name} ${icon('arrow')}</button>`
    : recruitmentButton() : '<strong>Capital complete</strong>';
  replaceContent(root, `
    ${settlementScene(state, language, settlementTask === 'decorate' || pendingPlacement !== null)}
    <div class="settlement-goal"><small>NEXT TIER</small><strong>${next?.name ?? 'Capital'}</strong>${next?.population ? meter(game.population, next.population, `Residents for ${next.name}`) : ''}${next?.population ? `<span>${fmt(game.population)} / ${fmt(next.population)} residents</span>` : ''}${goal}</div>
    ${pendingPlacement ? `<div class="placement-prompt" role="status"><span>${translate(`Choose an empty land cell for ${settlementEntityName(pendingPlacement.entity)}.`, language)}</span><button class="button" data-action="cancel-placement">Cancel placement</button></div>` : ''}
    <section class="settlement-task-panel" id="settlement-task-panel" role="region" aria-labelledby="settlement-task-title" ${settlementTask ? '' : 'hidden'}>
      <header class="settlement-task-heading"><h2 id="settlement-task-title" tabindex="-1">${icon(settlementTasks[settlementTask ?? 'overview'].icon)}${settlementTasks[settlementTask ?? 'overview'].label}</h2><button class="task-close" data-action="close-settlement-task" aria-label="Close settlement panel">${icon('close')}</button></header>
      <div class="settlement-task-body" data-task="${settlementTask ?? 'overview'}">${content}</div>
    </section>
    <nav class="settlement-dock" aria-label="Settlement actions">${settlementDockTasks.map(task => {
      const badge = task === 'inventory' ? state.inventory.pending.length : 0;
      return `<button id="task-${task}" data-settlement-panel="${task}" aria-controls="settlement-task-panel" aria-expanded="${task === settlementTask}" aria-pressed="${task === settlementTask}">${icon(settlementTasks[task].icon)}<span>${settlementTasks[task].label}</span>${badge ? `<b class="task-badge">${badge}</b>` : ''}</button>`;
    }).join('')}</nav><div class="settlement-saving" role="status">Saving...</div>`);
  if (!settlementMap) settlementMap = new SettlementMap(root.querySelector<HTMLCanvasElement>('#settlement-world')!,
    () => ({ state, environment, editing: settlementTask === 'decorate' || pendingPlacement !== null, selected: selectedBuilding, pending: pendingPlacement?.entity ?? null }),
    selectSettlementCell, (entity, position) => { if (selectedBuilding !== entity) layoutDrafts.clear(); selectedBuilding = entity; void savePlacement(entity, position); },
    language, message => toast(message, true));
  renderRecruitment(); renderWorkTimers(); localize(root);
}
function waterUpkeepPanel(compact = false): string {
  const upkeep = state.waterUpkeep;
  if (!upkeep) return '';
  if (compact) return `<div class="upkeep-meters" aria-label="${escape(translate('Next consumption', language))}">${(['water', 'wood', 'metal'] as const).map(resource => {
    const use = resource === 'water' ? { dailyConsumption: upkeep.dailyConsumption, shortage: upkeep.paused } : state.settlementUpkeep?.resources[resource];
    if (!use) return '';
    const readyAt = resource === 'water' ? upkeep.readyAt : state.settlementUpkeep!.readyAt;
    const label = `${translate(resource === 'water' ? 'Daily Water' : resource === 'wood' ? 'Wood heating' : 'Metal repairs', language)}: ${resourceFmt(resource, use.dailyConsumption)}/${translate('game day', language)}`;
    const detail = use.shortage ? `${label}. ${translate('Supply shortage pauses advanced activity, not residents or buildings.', language)}` : label;
    return `<a class="upkeep-meter${use.shortage ? ' shortage' : ''}" href="/market/?asset=${resource}&amp;side=buy" title="${escape(detail)}" aria-label="${escape(detail)}">${icon(resource)}<span class="vertical-consumption">${completionMeter(readyAt - worldDayMs, readyAt, label, true)}</span><strong>${resourceFmt(resource, use.dailyConsumption)}</strong><small>/${translate('game day', language)}${use.shortage ? ' !' : ''}</small></a>`;
  }).join('')}<a class="upkeep-manage" href="/settlement/#production" aria-label="${escape(translate('Manage production', language))}">${icon('settings')}</a></div>`;
  return `<div class="notice water-upkeep" role="status"><div class="water-upkeep-heading"><strong>Daily Water</strong>${costChips({ water: upkeep.dailyConsumption })}</div>
    <div class="water-upkeep-countdown"><span>Next consumption</span><strong data-ready-at="${upkeep.readyAt}" data-compact-time></strong></div>
    <div class="water-upkeep-impact"><p class="fineprint">50 L per resident / day before climate adjustments.</p>${upkeep.paused ? '<p class="water-shortage-text">Water shortage pauses advanced activity, not residents.</p>' : ''}</div>
    <div class="water-upkeep-links"><a href="/market/?asset=water&amp;side=buy">Buy Water</a><a href="/settlement/#buildings">Water facilities</a></div></div>${settlementUpkeepPanel()}`;
}
function settlementUpkeepPanel(compact = false, only?: 'wood' | 'metal'): string {
  const upkeep = state.settlementUpkeep;
  if (!upkeep) return '';
  return (only ? [only] : ['wood', 'metal'] as const).map(resource => {
    const use = upkeep.resources[resource];
    const label = resource === 'wood' ? 'Wood heating' : 'Metal repairs';
    const explanation = resource === 'wood'
      ? 'Heating baseline: 2 kg of Wood per resident per day at the reference heating demand. Cold, wet and stormy conditions increase use.'
      : 'Repair baseline: 0.2 kg of Metal per resident per day. Rain, snow, storms and extreme temperatures increase maintenance.';
    return `<div class="${compact ? 'water-upkeep-row' : 'notice water-upkeep'}${use.shortage ? ' supply-shortage' : ''}">
      <span class="water-upkeep-use" title="${escape(translate(explanation, language))}">${icon(resource)}<strong>${translate(label, language)} · ${resourceFmt(resource, use.dailyConsumption)}<small>/${translate('day', language)}</small></strong></span>
      ${compact ? completionMeter(upkeep.readyAt - worldDayMs, upkeep.readyAt, 'Next consumption', true)
        : `<p class="fineprint">${translate(explanation, language)}</p><div class="water-upkeep-countdown"><span>Next consumption</span><strong data-ready-at="${upkeep.readyAt}" data-compact-time></strong></div>`}
      <a href="/market/?asset=${resource}&amp;side=buy">${icon('plus')}${translate(resource === 'wood' ? 'Buy Wood' : 'Buy Metal', language)}</a>
      ${use.shortage ? `<small role="status">${translate('Supply shortage pauses advanced activity, not residents or buildings.', language)}</small>` : ''}</div>`;
  }).join('');
}
function crewAllocationLimit(resource: Resource): number {
  const allocation = editableAllocation(state.workforce);
  const others = resources.reduce((sum, key) => sum + (key === resource ? 0 : allocation[key]), 0);
  return Math.max(0, workforceCounts(game.population, state.workforce).assignmentCapacity - others);
}
function crewManagementCard(resource: Resource, acquisition = true): string {
  const work = state.workforce, crew = work.crews[resource], access = state.resourceAccess[resource];
  const limit = crewAllocationLimit(resource);
  const assigned = editableAllocation(work)[resource];
  return `<div class="crew-card" data-resource-card="${resource}"><header class="resource-card-heading"><div class="stock-label resource-${resource}">${icon(resource)}<strong>${names[resource]}</strong><span>${crew ? `${crew.workers} ${translate('residents', language)} · +${resourceFmt(resource, crew.weeklyYield)}/${translate('week', language)}` : 'No crew'}</span></div>${acquisition ? resourceSettingsButton(resource) : ''}</header>
    ${acquisition ? `${resourceAcquisitionActions(resource, true)}<small>${(state.collection?.automationUntil[resource] ?? 0) > state.serverTime ? 'Auto-collection active' : 'Manual collection'}</small>` : ''}
    <p class="fineprint">${access.available ? `<span>Distance from settlement</span>: ${access.distance} · <span>Weekly FTH$ per additional resident</span>: ${access.dollarsPerWorker}` : 'Explore a matching resource first. Oil also requires a city bank.'}</p>
    <p class="fineprint">${translate('Gathering now', language)}: ${crew?.workers ?? 0} · ${work.automatic ? translate('Auto recalculates next week', language) : `${translate('Next-week assignment', language)}: ${assigned}`}</p>
    <div class="crew-controls"><div class="crew-allocation"><div class="crew-allocation-heading"><label for="crew-slider-${resource}">Next-week assignment</label><div class="crew-stepper"><button class="button" data-action="crew-step" data-step="-1" aria-label="Decrease allocation" ${!access.available ? 'disabled' : ''}>${icon('minus')}</button><input id="crew-${resource}" type="number" min="0" max="${limit}" step="1" value="${assigned}" required ${!access.available ? 'disabled' : ''} aria-label="${names[resource]} crew residents" aria-describedby="crew-error-${resource}"><button class="button" data-action="crew-step" data-step="1" aria-label="Increase allocation" ${!access.available ? 'disabled' : ''}>${icon('plus')}</button></div></div>
    <input id="crew-slider-${resource}" data-crew-slider="${resource}" type="range" min="0" max="${limit}" step="1" value="${assigned}" ${!access.available ? 'disabled' : ''} aria-label="${names[resource]} allocation slider" aria-describedby="crew-error-${resource}">
    <small class="crew-input-error" id="crew-error-${resource}" role="status" hidden></small>
    <div class="crew-save-state" data-crew-save="${resource}" hidden><small role="status"></small><button class="button" data-action="retry-assign" data-resource="${resource}" hidden>Retry</button></div></div></div>
    ${crew ? completionMeter(crew.readyAt - worldWeekMs, crew.readyAt, 'Next delivery') : '<small>No active work. New assignments take a full game week.</small>'}</div>`;
}
function workforcePanel(): string {
  const work = state.workforce;
  const counts = workforceCounts(game.population, work);
  const planned = editableAllocation(work);
  const plannedTotal = resources.reduce((sum, resource) => sum + planned[resource], 0);
  const next = nextExploration(game, work.expeditions);
  const transport = Object.values(work.crews).reduce((sum, crew) => sum + (crew.weeklyDollarsCost ?? 0), 0);
  const exploreReason = upkeepPauseReason() || (game.stage < 0 ? 'Establish a settlement before sending an expedition.'
    : counts.available < 2 ? 'Exploration requires two available residents.'
      : !next ? 'No nearby destination' : state.dollars < next.dollars ? 'Not enough FTH$.' : '');
  return `<div class="population-workspace"><section class="population-overview"><div class="management-metrics"><div>${icon('people')}<small>Population</small><strong>${fmt(game.population)}</strong></div><div><small>Gathering now</small><strong>${fmt(counts.gathering)}</strong></div><div><small>Exploring now</small><strong>${fmt(counts.exploring)}</strong></div><div><small>Available now</small><strong>${fmt(counts.available)}</strong></div></div>
    <p class="fineprint">Available residents are not inactive or lost. They can join a two-person expedition now; gathering assignments start at the next work-week boundary.</p>
    <div class="management-supply"><span>Water reserve</span>${meter(game.stock.water, state.waterUpkeep?.weeklyConsumption ?? 0, 'Weekly Water reserve', 'water')}</div>
    ${recruitmentButton()}
    <h3 class="panel-section-heading">${translate(work.automatic ? 'Gathering now' : 'Next-week assignment', language)} <span>${plannedTotal} / ${counts.assignmentCapacity}</span></h3>
    ${waterUpkeepPanel()}
    <button class="button wide" data-action="automatic" aria-pressed="${work.automatic}" ${game.stage < 0 ? 'disabled' : ''}>${work.automatic ? 'Automatic allocation: ON' : 'Automatic allocation: OFF'}${work.automatic ? '<span class="allocation-target">50%</span>' : ''}</button>
    ${work.automatic ? '<p class="fineprint">Auto uses up to half the population, including explorers. The rest stay available. Auto recalculates next week.</p>' : ''}
    <p class="fineprint">Edits save automatically and switch to manual. Current gathering and expeditions finish unchanged; reducing next-week assignments does not free residents immediately.</p>
    <p class="fineprint">Gathering leaves room for at least two explorers in total. Residents already exploring count toward that reserve, not in addition to it.</p>
    <details class="disclosure" data-detail="workforce-help"><summary>Allocation & automation ${icon('chevron')}</summary>${activityKinds.map(activityAutomationPanel).join('')}
    <p class="fineprint">Automation consumes a timed item and pays normal FTH$ fees. Blocked jobs retry each game day. Pausing does not stop the expiry clock.</p>
    <details class="disclosure" data-detail="workforce-rules"><summary>Allocation rules ${icon('chevron')}</summary><p class="fineprint">Auto targets 50% total utilization, including explorers, rounded down. Water and growth needs come first within that budget, then net-value gathering. Full storage or supply shortages may lower utilization. Explorers at or above the target pause new gathering. Active paid jobs finish unchanged.</p>
    <p class="fineprint">Every crew needs active residents and a full game week. Collect each resource to pay FTH$ transport for all workers. Auto-collection requires an active resource-specific item. Full storage pauses new work.</p>
    <p class="fineprint">Residents consume Water, Wood for heating and Metal for repairs each game day. Climate changes demand. Shortages pause new exploration and recruitment without deleting residents or paid jobs.</p>
    </details></details>
    <p class="fineprint"><span>Transport on next pickup</span>: ${costChips({ dollars: transport })} · <span>Next allocation</span>: <span data-ready-at="${work.cycleAt}"></span></p>
    ${work.unfundedWorkers ? `<p class="notice">${state.waterUpkeep?.paused ? 'Water shortage. Additional workers are waiting.' : 'Not enough FTH$ for transport. Some workers are waiting.'}</p>` : ''}
    <div class="panel-actions">${investigationButton()}<button class="button" data-action="explore" ${exploreReason ? 'disabled' : ''}>${icon('compass')} Send expedition · 2 ${translate('residents', language)}</button>${next ? `<small>${translate(`Next expedition: ${next.dollars} FTH$ · ${next.weeks} game weeks`, language)} · <span title="Concurrency multiplier">${2 ** explorationCount(work.expeditions)}x</span></small>` : ''}</div>
    ${exploreReason ? `<p class="fineprint" role="status">${escape(translate(exploreReason, language))}</p>` : ''}
    <details class="disclosure" data-detail="workforce-expeditions"><summary>Active expeditions <span>${work.expeditions.length}</span>${icon('chevron')}</summary>
    <p class="fineprint">Each field team needs two idle residents. Investigate and Explore share exponential route fees: 1x, 2x, 4x, 8x... Investigations take one game week; explorers return after 1–3 game weeks. Known-terrain travel remains free.</p>
    <p class="fineprint">Investigations use two idle residents for one game week on known land. They cost 10% of the concurrent Explore route fee and have a 10% chance of a low-tier permit.</p>
    <div class="crew-list expedition-list">${work.expeditions.map(expedition => `<div class="expedition-card">${icon(expedition.kind === 'investigate' ? 'search' : 'compass')}<div><strong>${expedition.kind === 'investigate' ? `<span>Investigating</span> · ${expedition.workers} ${translate('residents', language)} (${expedition.x}, ${expedition.y})` : `${expedition.workers} residents exploring (${expedition.x}, ${expedition.y})`}</strong>${completionMeter(expeditionStartedAt(expedition), expedition.readyAt, 'Next return')}</div></div>`).join('') || '<p class="fineprint">No expeditions exploring.</p>'}</div></details></section>
    <section class="population-crews"><div class="crew-list resource-crews">${resources.map(resource => crewManagementCard(resource)).join('')}</div></section></div>`;
}
function activityAutomationPanel(activity: ActivityKind): string {
  const automation = state.activityAutomation?.[activity], active = (automation?.until ?? 0) > state.serverTime;
  return `<section class="activity-automation"><div class="automation-heading"><h3>${icon(activity === 'exploration' ? 'compass' : 'people')}${activityName(activity)}</h3>${active ? `<span data-ready-at="${automation!.until}" data-compact-time></span>` : '<span>Inactive</span>'}</div>
    ${active ? `<div class="activity-automation-status"><p class="fineprint">${automation?.reason ?? 'Automation ready'}</p><button class="button" data-action="activity-automation" data-activity="${activity}">${automation?.enabled ? 'Pause automation' : 'Resume automation'}</button></div>` : ''}
    <div class="automation-items">${collectionDurations.map(weeks => {
      const item = `activity-${activity}-${weeks}` as const, owned = state.inventory.items.includes(item);
      return `<button class="button automation-item" data-action="activate-activity" data-item="${item}" ${owned ? '' : 'disabled'}><strong>${weeks}w</strong><small>${owned ? 'Activate' : 'Find or buy'}</small></button>`;
    }).join('')}</div><a href="/market/?asset=activity-${activity}-1">Marketplace</a>
    </section>`;
}
function expeditionStartedAt(expedition: Expedition): number {
  return expedition.startedAt ?? expedition.readyAt - (expedition.kind === 'investigate' ? worldDayMs : terrainDetails[terrainAt(expedition.x, expedition.y, game.seed)].weeks * worldWeekMs);
}
function completionMeter(startedAt: number, readyAt: number, label: string, compact = false): string {
  return `<span class="completion-meter${compact ? ' compact' : ''}" data-completion-start="${startedAt}" data-completion-end="${readyAt}">
    <span class="completion-caption"><span>${label}</span><strong data-completion-time></strong><small data-completion-percent></small></span>
    <progress max="100" value="0" aria-label="${escape(label)}"></progress></span>`;
}
function recruitmentButton(primary = false): string {
  const recruitment = state.recruitment;
  return `<button class="button${primary ? ' primary wide sidebar-recruitment' : ''}" data-action="invite" ${game.stage < 0 ? 'disabled' : ''}><span class="quick-action-heading">${icon('people')}<span data-invite-label>Invite</span></span><span data-invite-cost>${costChips({ dollars: state.recruitmentDollars }, primary)}</span><small data-invite-duration>${primary ? `1 ${translate('wk', language)}` : '1 game week'}</small>${recruitment ? `<span class="quick-action-batch">+${fmt(recruitment.population)} ${icon('people')}</span>${completionMeter(recruitment.startedAt, recruitment.readyAt, 'Recruitment progress', true)}` : ''}</button>`;
}
function progressionPanel(): string {
  const next = stages[game.stage + 1];
  const ready = next && canAfford(game, next.cost) && game.population >= next.population
    && (game.stage >= 0 || !isWater(terrainAt(game.position.x, game.position.y, game.seed)));
  return `
    ${next ? `<div class="upgrade-card"><div class="upgrade-target">${icon('layers')}<div><small>NEXT TIER</small><h3>${next.name}</h3></div>${icon('arrow')}</div><div class="requirement-list">${requirement('people', `${fmt(next.population)} residents`, game.population >= next.population)}${game.stage < 0 ? requirement('home', 'Dry land', !isWater(terrainAt(game.position.x, game.position.y, game.seed))) : ''}</div><div class="upgrade-cost">${costChips(next.cost)}</div>    <button class="button primary wide" data-action="upgrade" ${ready ? '' : 'disabled'}>${icon('plus')}${game.stage < 0 ? 'Settle' : 'Upgrade'}</button></div>` : `<div class="notice">${icon('check')} Capital complete</div>`}
    ${game.stage < 0 ? `<a class="button wide" href="/explore/">Gather founding supplies ${icon('arrow')}</a>` : next && !ready ? `<p class="upgrade-guidance">Meet the highlighted requirements to upgrade.</p><button class="button wide" data-settlement-panel="${game.population < next.population ? 'residents' : 'production'}">${game.population < next.population ? 'Manage residents' : 'Manage production'} ${icon('arrow')}</button>` : ''}`;
}
function buildingsPanel(): string {
  return `${warehouseUpgradeCard(state, language)}<h3 class="panel-section-heading">Settlement upgrades</h3>
    <p class="fineprint">Season, weather and temperature affect new weekly output. Dispatched crews keep their confirmed yield.</p>
    <p class="fineprint">Expand housing, Water reserves, production and collection routes. Upgrade costs grow linearly by target level. Benefits never mint FTH$.</p>
    ${constructionUpgradeCards(state, language)}<h3 class="panel-section-heading">Commercial buildings</h3>
    <p class="fineprint">FTH$ is never granted for founding, residents, buildings or exploration. Sell owned resources at marketplace spot prices to fund your settlement.</p>
    ${commercialUpgradeCards(state, language)}<h3 class="panel-section-heading">Water facilities <span>${waterProductionMultiplier(game)}&times;</span></h3>
    <p class="fineprint">Facility bonuses add together and increase Water collected per resident. They require assigned Water crews and apply from the next work week, without changing paid deliveries. Expand storage to keep the extra output. No extra weekly upkeep.</p>
    <p class="fineprint"><span>Water per resident / week</span>: <strong>${resourceFmt('water', state.resourceAccess.water.perWorker)}</strong> · <span>Next work week</span></p>
    ${waterUpgradeCards(state, language)}
    <h3 class="panel-section-heading">Buildings</h3>${civicUpgradeCards(state, language)}
    <details class="disclosure" data-detail="tiers"><summary>All tiers <span>${Math.max(0, game.stage + 1)} / ${stages.length}</span>${icon('chevron')}</summary>
    <div class="progression-list">${stages.map((s, i) => `<div class="tier-row ${i === game.stage ? 'current' : ''} ${i <= game.stage ? 'completed' : ''}"><span class="tier-number">${i <= game.stage ? icon('check') : icon('lock')}</span><div><strong>${s.name}</strong><small>${fmt(s.population)} residents</small></div><div class="tier-cost">${costChips(s.cost)}</div></div>`).join('')}</div></details>`;
}
function foundingPanel(): string {
  const resource = terrainResources[terrainAt(game.position.x, game.position.y, game.seed)];
  const canGather = (resource === 'wood' || resource === 'water') && game.stock[resource] < (stages[0].cost[resource] ?? 0);
  return `<section class="founding-guide"><h3>Start from zero</h3><p>Gather Wood here, then visit the lake at 3, 0 for Water. Only the materials needed for founding can be gathered by hand. No starting FTH$ or Metal is granted.</p>
    <div class="founding-actions"><button class="button" data-action="founding-wood">${icon('wood')} Wood</button><button class="button" data-action="founding-water">${icon('water')} Water</button>
    <button class="button primary" data-action="gather" ${canGather ? '' : 'disabled'}>${icon(resource)} Gather</button></div><div class="upgrade-cost">${costChips(stages[0].cost)}</div>
    <button class="button primary wide" data-action="upgrade" ${canAfford(game, stages[0].cost) && !isWater(terrainAt(game.position.x, game.position.y, game.seed)) ? '' : 'disabled'}>${icon('home')} Settle</button></section>`;
}
function resourceStockCard(resource: Resource): string {
  return `<div class="stock-card" data-resource-card="${resource}"><header class="resource-card-heading"><div class="stock-label resource-${resource}">${icon(resource)}<span>${names[resource]}</span></div>${resourceSettingsButton(resource)}</header><strong>${fmt(game.stock[resource])}<small> / ${fmt(resourceCapacity(state.capacity, resource, game))}</small></strong><div class="storage-meter">${meter(game.stock[resource], resourceCapacity(state.capacity, resource, game), `${names[resource]} storage`)}</div>${resourceAcquisitionActions(resource)}<span class="stock-rate">+${state.rates[resource]}/week</span>${state.workforce.crews[resource] ? completionMeter(state.workforce.crews[resource]!.readyAt - worldWeekMs, state.workforce.crews[resource]!.readyAt, 'Next delivery') : ''}</div>`;
}
function storagePanel(): string {
  return `<h3 class="panel-section-heading">Production <span>Resource flow</span></h3>
    ${warehouseUpgradeCard(state, language)}
    <div class="storage-grid">${resources.map(resourceStockCard).join('')}</div>
    ${game.stage < 0 ? `<div class="requirement-list">${requirement('home', 'Settlement', false)}</div>` : ''}`;
}
function syncCrewControls(root: HTMLElement): void {
  const number = root.querySelector<HTMLInputElement>('input[type="number"]')!;
  const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!;
  const error = root.querySelector<HTMLElement>('.crew-input-error')!;
  const valid = number.checkValidity();
  if (valid) slider.value = number.value;
  root.querySelectorAll<HTMLButtonElement>('[data-action="crew-step"]').forEach(button => {
    const next = Number(number.value) + Number(button.dataset.step);
    button.disabled = number.disabled || !valid || next < Number(number.min) || next > Number(number.max);
  });
  slider.style.setProperty('--allocation-progress', `${Number(slider.max) ? Number(slider.value) / Number(slider.max) * 100 : 0}%`);
  error.hidden = valid || number.disabled;
  error.textContent = valid ? '' : translate(`Enter a whole number between 0 and ${number.max}.`, language);
  if (!valid && !number.disabled) number.setAttribute('aria-invalid', 'true');
  else number.removeAttribute('aria-invalid');
}
function updateCrewSaveStatus(): void {
  for (const resource of resources) {
    const root = document.querySelector<HTMLElement>(`[data-crew-save="${resource}"]`);
    if (!root) continue;
    const pending = savingCrew === resource || pendingCrewAssignments.has(resource);
    const failed = failedCrewAssignments.has(resource);
    root.hidden = !pending && !failed && !crewDrafts.has(`crew-${resource}`);
    root.dataset.failed = String(failed && !pending);
    root.querySelector('small')!.textContent = translate(pending ? 'Saving...' : failed ? 'Not saved. Try again.' : 'Finish editing to save.', language);
    root.querySelector<HTMLButtonElement>('button')!.hidden = !failed || pending;
  }
}
function requestCrewAssignment(input: HTMLInputElement): void {
  const resource = resources.find(key => input.id === `crew-${key}`);
  if (!resource || input.disabled) return;
  input.setCustomValidity('');
  syncCrewControls(input.closest<HTMLElement>('.crew-controls')!);
  if (!input.checkValidity()) { input.reportValidity(); return; }
  crewDrafts.set(input.id, input.value);
  pendingCrewAssignments.set(resource, input.value);
  updateCrewSaveStatus();
  void saveCrewAssignments();
}
async function saveCrewAssignments(): Promise<void> {
  if (processingCrewAssignments || busy || confirmationOpen() || performance.now() - synchronizedAt > serverClockStaleMs) return;
  processingCrewAssignments = true;
  try {
    while (pendingCrewAssignments.size && !busy && !confirmationOpen()) {
      const [resource, draft] = pendingCrewAssignments.entries().next().value!;
      pendingCrewAssignments.delete(resource);
      const id = `crew-${resource}`;
      const workers = Number(draft), maximum = crewAllocationLimit(resource);
      if (!state.resourceAccess[resource].available) {
        failedCrewAssignments.add(resource);
        toast('Requirements changed. Review the updated costs and try again.', true);
        updateCrewSaveStatus();
        continue;
      }
      if (!draft.trim() || !Number.isSafeInteger(workers) || workers < 0 || workers > maximum) {
        failedCrewAssignments.add(resource);
        toast(`Enter a whole number between 0 and ${maximum}.`, true);
        updateCrewSaveStatus();
        continue;
      }
      if (!state.workforce.automatic && workers === state.workforce.allocation[resource]) {
        if (crewDrafts.get(id) === draft) crewDrafts.delete(id);
        failedCrewAssignments.delete(resource);
        updateCrewSaveStatus();
        continue;
      }
      savingCrew = resource;
      failedCrewAssignments.delete(resource);
      updateCrewSaveStatus();
      const saved = await act({ type: 'assign', resource, workers });
      savingCrew = null;
      if (!saved) failedCrewAssignments.add(resource);
      updateCrewSaveStatus();
    }
  } finally { processingCrewAssignments = false; }
}
app.addEventListener('change', event => {
  if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-crafting-quantity')) {
    const quantity = event.target.valueAsNumber;
    if (!event.target.validity.valid || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      toast('Invalid crafting quantity.', true); event.target.value = String(craftingQuantity); return;
    }
    craftingQuantity = quantity;
    if (settlementPage) renderSettlement(); else renderSidebar();
    return;
  }
  if (event.target instanceof HTMLSelectElement && event.target.hasAttribute('data-management-resource')) {
    const view = event.target.value;
    if (view === 'funds' || isResource(view)) openManagement(view);
    else toast('Invalid resource selection.', true);
    return;
  }
  if (event.target instanceof HTMLInputElement && event.target.closest('.crew-controls')) {
    const input = event.target.closest('.crew-controls')!.querySelector<HTMLInputElement>('input[type="number"]')!;
    requestCrewAssignment(input);
  }
});
app.addEventListener('focusout', event => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'number' && crewDrafts.has(event.target.id)) requestCrewAssignment(event.target);
});
app.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.closest('.crew-controls')) {
    event.preventDefault();
    requestCrewAssignment(event.target.closest('.crew-controls')!.querySelector<HTMLInputElement>('input[type="number"]')!);
  }
});
app.addEventListener('input', event => {
  if (event.target instanceof HTMLInputElement && event.target.id === 'journal-search') {
    journalQuery = event.target.value.trim().toLocaleLowerCase(languageLocale);
    renderJournal();
  }
  if (event.target instanceof HTMLInputElement && event.target.dataset.layoutCoordinate) layoutDrafts.set(event.target.id, event.target.value);
  if (event.target instanceof HTMLInputElement && event.target.closest('.crew-controls')) {
    const root = event.target.closest<HTMLElement>('.crew-controls')!;
    const number = root.querySelector<HTMLInputElement>('input[type="number"]')!;
    if (event.target.type === 'range') number.value = event.target.value;
    number.setCustomValidity('');
    crewDrafts.set(number.id, number.value);
    syncCrewControls(root);
    updateCrewSaveStatus();
  }
});
app.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a') : null;
  if (!target) return;
  if (isSettlementTask(target.dataset.settlementPanel)) {
    const task = target.dataset.settlementPanel;
    if (settlementPage) showSettlementTask(target.closest('.settlement-dock') && task === settlementTask ? null : task);
    else location.assign(`/settlement/?lang=${language}#${task}`);
    return;
  }
  const action = target.dataset.action;
  switch (action) {
    case 'crew-step': {
      const input = target.closest('.crew-controls')!.querySelector<HTMLInputElement>('input[type="number"]')!;
      if (target instanceof HTMLButtonElement && !target.disabled && input.checkValidity()) {
        const workers = Number(input.value) + Number(target.dataset.step);
        if (workers >= Number(input.min) && workers <= Number(input.max)) {
          input.value = String(workers);
          requestCrewAssignment(input);
        }
      }
      break;
    }
    case 'population-management': openManagement('population'); break;
    case 'funds-management': openManagement('funds'); break;
    case 'acquisition-management': openManagement(lastResourceManagement); break;
    case 'resource-management': {
      const resource = resources.find(key => key === target.dataset.resource);
      if (resource) openManagement(resource);
      break;
    }
    case 'close-management': managementDialog.close(); break;
    case 'activate-collection':
      if (isCollectionItem(target.dataset.item)) void act({ type: 'activate-collection', item: target.dataset.item });
      break;
    case 'use-customization': {
      const item = target.dataset.item;
      if (!isCustomizationItem(item)) { toast('This customization item is not available in your inventory.', true); break; }
      const input = target.closest('.inventory-item-detail')?.querySelector<HTMLInputElement>('[data-customization-name]');
      const value = isTitleItem(item) ? titleItems[item].title : customizationName(input?.value);
      if (!value) { toast('Names must contain 2-40 letters, numbers, spaces, apostrophes, periods or hyphens.', true); input?.focus(); break; }
      void act({ type: 'use-customization', item, value });
      break;
    }
    case 'activate-activity':
      if (isActivityItem(target.dataset.item)) void act({ type: 'activate-activity', item: target.dataset.item });
      break;
    case 'activity-automation':
      if (isActivityKind(target.dataset.activity)) void act({ type: 'activity-automation', activity: target.dataset.activity,
        enabled: !state.activityAutomation?.[target.dataset.activity]?.enabled });
      break;
    case 'collect-resource': {
      const resource = resources.find(key => key === target.dataset.resource);
      if (resource) queueClaim(resource, target);
      break;
    }
    case 'collect-sell': {
      const resource = resources.find(key => key === target.dataset.resource);
      if (resource) void collectAndSell(resource);
      break;
    }
    case 'resource-details': target.focus(); break;
    case 'zoom-in': world?.scale(0.15); break;
    case 'zoom-out': world?.scale(-0.15); break;
    case 'recenter': world?.center(); break;
    case 'settlement-zoom-in': settlementMap?.scale(.15); break;
    case 'settlement-zoom-out': settlementMap?.scale(-.15); break;
    case 'settlement-centre': settlementMap?.center(); break;
    case 'home':
      if (!game.home) toast('Establish a settlement to create your home location.', true);
      else void act({ type: 'home' }, true);
      break;
    case 'upgrade': case 'invite': case 'warehouse': void act({ type: action }); break;
    case 'bank': case 'townhall': void act({ type: 'build', kind: action }); break;
    case 'water-facility':
      if (isWaterFacility(target.dataset.facility)) void act({ type: 'build', kind: target.dataset.facility });
      break;
    case 'income-facility':
      if (isIncomeFacility(target.dataset.facility)) void act({ type: 'build', kind: target.dataset.facility });
      break;
    case 'construction':
      if (isConstruction(target.dataset.construction)) void act({ type: 'construction', kind: target.dataset.construction });
      break;
    case 'craft':
      if (isCraftableItem(target.dataset.item)) void act({ type: 'craft', item: target.dataset.item, quantity: craftingQuantity });
      break;
    case 'equip':
      if (isVisibilityItem(target.dataset.item)) void act({ type: 'equip', item: target.dataset.item });
      break;
    case 'close-settlement-task': showSettlementTask(null); break;
    case 'prepare-decoration':
      if (isDecorationItem(target.dataset.item)) beginPlacement(target.dataset.item);
      break;
    case 'prepare-layout':
      if (isSettlementEntity(target.dataset.entity)) beginPlacement(target.dataset.entity);
      break;
    case 'cancel-placement': {
      const origin = pendingPlacement?.origin ?? 'decorate';
      pendingPlacement = null;
      showSettlementTask(origin);
      break;
    }
    case 'select-building': {
      const entity = target.dataset.entity;
      if (isSettlementEntity(entity)) {
        if (selectedBuilding !== entity) layoutDrafts.clear();
        selectedBuilding = entity;
        renderSettlement();
        settlementMap?.center(settlementPositions(game, state.inventory)[entity]);
      }
      break;
    }
    case 'arrange-coordinates': {
      const entity = target.dataset.entity;
      if (!isSettlementEntity(entity)) break;
      const x = document.querySelector<HTMLInputElement>('#layout-x')!, y = document.querySelector<HTMLInputElement>('#layout-y')!;
      if (!x.reportValidity() || !y.reportValidity()) break;
      void savePlacement(entity, { x: Number(x.value), y: Number(y.value) });
      break;
    }
    case 'remove-layout':
      if (isDecorationItem(target.dataset.entity)) void savePlacement(target.dataset.entity, null);
      break;
    case 'unequip': void act({ type: 'equip', item: null }); break;
    case 'item-storage': case 'collect-items': void act({ type: action }); break;
    case 'inventory-filter': {
      const filter = target.dataset.filter;
      if (filter === 'all' || filter === 'utility' || filter === 'decoration' || filter === 'collectible' || filter === 'collectors' || filter === 'customization') {
        inventoryFilter = filter; inventoryPage = 0; inventorySelection = null;
        if (settlementPage) renderSettlement(); else renderSidebar();
      }
      break;
    }
    case 'inventory-page': {
      const page = Number(target.dataset.page);
      if (Number.isSafeInteger(page) && page >= 0 && page < itemStorage[state.inventory.storage].capacity / inventoryPageSize) {
        inventoryPage = page; inventorySelection = null;
        renderSettlement();
      }
      break;
    }
    case 'inventory-select': {
      const item = state.inventory.items.find(id => id === target.dataset.item);
      if (item) { inventorySelection = item; renderSettlement(); }
      break;
    }
    case 'crafting-filter': {
      const filter = target.dataset.filter;
      if (filter === 'all' || filter === 'utility' || filter === 'decoration' || filter === 'affordable' || filter === 'collectors' || filter === 'customization') {
        craftingFilter = filter;
        if (settlementPage) renderSettlement(); else renderSidebar();
      }
      break;
    }
    case 'explore': {
      const destination = nextExploration(game, state.workforce.expeditions);
      if (destination) requestMove(destination.x, destination.y);
      else toast('Travel toward the edge of known territory to start a new expedition.');
      break;
    }
    case 'investigate': {
      const destination = nextInvestigation(game, state.workforce.expeditions);
      if (destination) void act({ type: 'investigate', x: destination.x, y: destination.y }, true);
      else toast('No known destination available', true);
      break;
    }
    case 'gather': void act({ type: 'gather' }); break;
    case 'founding-wood': requestMove(0, 0); break;
    case 'founding-water': requestMove(3, 0); break;
    case 'retry-assign': {
      const resource = resources.find(key => key === target.dataset.resource);
      if (resource) requestCrewAssignment(document.querySelector<HTMLInputElement>(`#crew-${resource}`)!);
      break;
    }
    case 'automatic': void act({ type: 'automatic', enabled: !state.workforce.automatic }); break;
    case 'gift': case 'join': case 'form': case 'vote': void act({ type: 'diplomacy', action }); break;
    case 'claim': void act({ type: 'claim' }); break;
    case 'export': case 'legacy-export': {
      try {
        downloadSnapshot(state, action === 'legacy-export');
        toast('World save exported. Keep it somewhere safe.');
      } catch (error) { toast(`Export failed: ${error instanceof Error ? error.message : 'Storage is unavailable.'}`, true); }
      break;
    }
  }
});
document.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('.world-chat')) return;
  if (managementDialog.open) return;
  if (confirmationOpen()) return;
  if (account.isOpen) return;
  if (event.key === 'Escape') document.querySelectorAll('.resource').forEach(el => el.classList.add('tooltip-dismissed'));
  if (event.target instanceof Element && event.target.closest('.resource')) return;
  if (settlementPage && !visitingSettlement && event.key === 'Escape') {
    event.preventDefault();
    if (pendingPlacement) {
      const origin = pendingPlacement.origin;
      pendingPlacement = null;
      showSettlementTask(origin);
    } else showSettlementTask(null);
    return;
  }
  if (event.target instanceof Element && event.target.closest('.sidebar')) return;
  if (!explorePage || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const keys: Record<string, [number, number]> = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const delta = keys[event.key];
  if (delta) { event.preventDefault(); void act({ type: 'move', x: game.position.x + delta[0], y: game.position.y + delta[1] }, true); }
});
window.addEventListener('hashchange', () => {
  if (settlementPage) showSettlementTask(settlementTaskFromHash(location.hash));
});
window.addEventListener('pagehide', () => { inbox?.close(); settlementChat?.close(); });
window.addEventListener('focus', async () => {
  if (busy || confirmationOpen() || document.hidden) return;
  busy = true;
  try { synchronize(await refresh()); render(); }
  catch (error) { toast(`Could not sync wallet balance: ${error instanceof Error ? error.message : 'Connection failed.'}`, true); }
  finally { busy = false; }
});
window.addEventListener('pageshow', event => {
  if (event.persisted && (navigationPage === 'communicate' || navigationPage === 'contacts' || explorePage)) {
    inbox?.resume();
  } else if (event.persisted && settlementPage) {
    settlementChat = null; mountWorldChat();
  }
});
async function syncProduction(): Promise<void> {
  if (busy || confirmationOpen() || document.hidden) return;
  busy = true;
  try { synchronize(await refresh()); render(); }
  catch (error) { toast(`Could not sync server production: ${error instanceof Error ? error.message : 'Connection failed.'}`, true); }
  finally { busy = false; void saveCrewAssignments(); }
}
window.addEventListener('storage', event => {
  if (event.key === 'featheral-wallet-updated' || event.key === 'featheral-world-account') void syncProduction();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncProduction(); });
setInterval(() => void syncProduction(), serverSyncIntervalMs + Math.random() * 5000);
let nextDeadlineSyncAt = 0;
setInterval(() => {
  if (document.hidden) return;
  renderEnvironment();
  const deadlines = [state.workforce.cycleAt, state.recruitment?.readyAt ?? Infinity,
    state.waterUpkeep?.readyAt ?? Infinity, state.settlementUpkeep?.readyAt ?? Infinity,
    ...Object.values(state.workforce.crews).map(crew => crew.readyAt),
    ...state.workforce.expeditions.map(expedition => expedition.readyAt)];
  const due = Math.min(...deadlines);
  const timestamp = displayServerTime(state.serverTime, performance.now() - synchronizedAt, state.clockSpeed);
  if (game.stage >= 0 && due <= timestamp && performance.now() >= nextDeadlineSyncAt && !busy && !confirmationOpen()) {
    nextDeadlineSyncAt = performance.now() + 5000;
    void syncProduction();
  }
}, 1000);
settlementResourceSale = new SettlementSale(() => state,
  next => { if (next.revision >= state.revision) { synchronize(next); render(); } }, toast, language, undefined, 'market');
if (settlementPage && !visitingSettlement) settlementSale = new SettlementSale(() => state,
  next => { if (next.revision >= state.revision) { synchronize(next); render(); } }, toast, language);
render();
mountWorldChat();
const clockCalendar = document.querySelector<HTMLElement>('#world-time')!;
const clockMotion = matchMedia('(prefers-reduced-motion: reduce)');
let clockFrame: number | undefined;
let clockDrawnAt = -1;
let clockUpdatedAt = -Infinity;
function animateClock(frameTime: number): void {
  clockFrame = undefined;
  if (document.hidden || clockMotion.matches) return;
  const timestamp = displayServerTime(state.serverTime, performance.now() - synchronizedAt, state.clockSpeed);
  if (frameTime - clockUpdatedAt >= 100 && timestamp !== clockDrawnAt) {
    updateClockTime(clockCalendar, timestamp);
    clockDrawnAt = timestamp;
    clockUpdatedAt = frameTime;
  }
  clockFrame = requestAnimationFrame(animateClock);
}
function scheduleClockAnimation(): void {
  if (clockFrame !== undefined) cancelAnimationFrame(clockFrame);
  clockFrame = undefined;
  clockDrawnAt = -1;
  clockUpdatedAt = -Infinity;
  if (!document.hidden && !clockMotion.matches) clockFrame = requestAnimationFrame(animateClock);
}
clockMotion.addEventListener('change', scheduleClockAnimation);
document.addEventListener('visibilitychange', scheduleClockAnimation);
window.addEventListener('pageshow', scheduleClockAnimation);
window.addEventListener('pagehide', () => {
  if (clockFrame !== undefined) cancelAnimationFrame(clockFrame);
  clockFrame = undefined;
});
scheduleClockAnimation();
if (marketPage) marketplace = new Marketplace(document.querySelector<HTMLElement>('#marketplace-content')!, () => state,
  next => { if (next.revision >= state.revision) { synchronize(next); render(); } }, toast, language);
if (bankPage) new WalletPage(document.querySelector<HTMLElement>('#bank-content')!);
