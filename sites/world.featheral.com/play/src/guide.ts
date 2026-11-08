import { icon } from './icons.ts';
import { waterFacilities, waterFacilityKeys } from './water-facilities.ts';
import { locale } from './i18n.ts';
import type { Language } from './i18n.ts';

export const guideTopics = [
  { id: 'explore', title: 'A small clearing. A big adventure.', icon: 'compass', tag: 'Start here',
    intro: 'Your first home starts on dry land. Beyond the fog, every journey has a story.',
    paragraphs: ['Gather Wood here, then visit the lake at 3, 0 for Water. Only the materials needed for founding can be gathered by hand. No starting FTH$ or Metal is granted.',
      'Settle on dry land to welcome your first 12 residents. Move across known tiles for free; click unknown terrain to send an expedition.',
      'Each field team needs two idle residents. Investigate and Explore share exponential route fees: 1x, 2x, 4x, 8x... Investigations take one game week; explorers return after 1–3 game weeks. Known-terrain travel remains free.',
      'Investigate discovered land with two idle residents for one game week. Pay 10% of the concurrent Explore route fee (minimum FTH$0.10) for a 10% item chance; finds are 90% one-week and 10% four-week permits. Investigations do not reveal tiles. Each active Investigate or Explore team doubles the next field fee.'],
    tip: 'Try this: settle, check your Water supply, then send your first explorers.', image: 'explore', alt: 'Exploration screen with fog, terrain and resident controls.', path: '/', action: 'Explore' },
  { id: 'water', title: 'Water first. Every day.', icon: 'water', tag: 'Survival',
    intro: 'Keep a Water reserve. Collect completed resources from the header.',
    paragraphs: ['Household Water demand starts at 50 L per resident per game day and increases in hot, sunny summer conditions. Water is traded in liters (L). Weekly output still requires paid pickup.',
      'Founding consumes your gathered supplies. Free basic Water crews restore your reserve; collect completed Water before funding advanced work. Collect and sell completed Wood output to pay transport from the proceeds.',
      'Water shortages pause new advanced gathering, exploration and recruitment, never remove residents or cancel paid jobs. Keep gathering Water; basic Wood crews can help you trade for supplies.',
      'Build a Well, Rain collector and Pumping station with Wood and Metal. Their bonuses add up to eightfold Water output for assigned crews, starting with their next full work week. Upgrade warehouses too: extra production still needs room.'],
    tip: 'Check daily Water consumption and the supply-pause warning.', image: 'facilities', alt: 'Water facility construction cards with Wood and Metal prices.', path: '/settlement/#buildings', action: 'Water facilities' },
  { id: 'maintenance', title: 'Heating and repairs. Every day.', icon: 'wood', tag: 'Survival',
    intro: 'Reserve Wood for heating and Metal for settlement repairs.',
    paragraphs: ['Reference demand is 2 kg of Wood and 0.2 kg of Metal per resident per game day. Season, temperature and weather change the daily average. Cold and wet weather increases heating; storms and extreme temperatures increase repairs.',
      'Small usage carries forward until a whole accounting lot is consumed. Only owned stock is used, never unclaimed output. Existing settlements start with a fresh daily deadline and no retroactive bill.',
      'Supply shortages pause new exploration and recruitment, including automation. Residents, buildings and paid jobs remain. Basic gathering, collection and trading can restore supplies. Oil keeps its existing activity costs.'],
    tip: 'Check the Wood heating and Metal repairs timers.', image: 'facilities', alt: 'Water facility construction cards with Wood and Metal prices.', path: '/settlement/#residents', action: 'Manage residents' },
  { id: 'crews', title: 'Give every resident a purpose.', icon: 'people', tag: 'Production',
    intro: 'Residents do the work. You choose the balance between supplies, growth and discovery.',
    paragraphs: ['Auto targets 50% total utilization, including explorers, rounded down. Water and growth needs come first within that budget, then net-value gathering. Full storage or supply shortages may lower utilization. Explorers at or above the target pause new gathering. Active paid jobs finish unchanged.',
      'Auto prioritizes one week of Water replacement before sharing remaining workers across materials. A Well or manual allocation may be needed in winter; filling the entire Water reserve does not take priority over materials.',
      'When transport is unaffordable, tap the Collect marker to pick up completed output for free. Only one visible tile per resource shows a marker. Header and automatic collection still pay transport.',
      'Crews finish after seven game days. Collect each resource from the header and pay FTH$1 per worker plus distance fees. Already-paid old deliveries finish without paying twice.',
      'Weekly baseline per worker: 500 kg Wood, 1,500 L Water, 100 kg Metal or 2 bbl Oil. Population adds workers, not a tier multiplier. Terrain, climate and facilities still affect new jobs.',
      'Use +/-, drag a slider or enter a count to switch to manual allocation and save. Active deliveries finish before changes apply.',
      'Auto-collection needs a resource-specific consumable found on expeditions or bought in the marketplace. Items last 1, 4 or 12 game weeks; activating another adds to the remaining time. Automation still pays transport. Owned and pending stock share storage room.',
      'Exploration and recruitment permits also last 1, 4 or 12 game weeks. Activate in inventory or Allocation & automation. Keep one expedition travelling or start the next recruitment after arrival; normal FTH$ fees and Water requirements apply. Blocked activity retries daily. Pausing stops new jobs, not paid jobs or the expiry clock.',
      'Use the top-right resource settings button to activate timed auto-collection, sell an exact owned quantity, collect-and-sell pending output or adjust that crew. Settlement production and population management share the same collection and settings controls. Tap the population-health bar to recruit or send expeditions.',
      'Desktop management uses side-by-side panels; small screens and long histories scroll when needed.',
      'Season, weather and temperature affect weekly resource yields, recruitment and expedition finds. All eight weather periods each day contribute. New jobs lock their output or arrival count at departure; refreshing cannot reroll outcomes. Water planning includes consumption during the work week.'],
    tip: 'Recruitment also takes a full game week. Arriving residents never receive early production.', image: 'settlement', alt: 'Resident allocation screen with weekly crews and Water upkeep.', path: '/settlement/#residents', action: 'Manage residents' },
  { id: 'home', title: 'Make room for a home.', icon: 'home', tag: 'Building & crafting',
    intro: 'Build useful things. Add little touches. Make this clearing yours.',
    paragraphs: ['Open Buildings for Water facilities and commercial buildings. No building grants FTH$. A city bank unlocks Oil production and resource trading.',
      'Resource storage scales with population reserves, tier requirements and warehouse level. Existing stock and locked deliveries remain even above smaller limits; new gathering waits for room.',
      'Warehouse, housing, reservoir, workshop and trade hub upgrades reach level 99 with linear next-level costs. Housing adds 25% recruitment, reservoirs add a week of Water capacity, workshops add 25% raw output and trade hubs shorten routes by two tiles per level. Item storage stays separate.',
      'Choose a crafting quantity from 1 to 100 and filter affordable recipes. Cards show total batch cost and the material/storage maximum. Confirmation spends the full cost atomically; unaffordable batches spend nothing.',
      'Identical items share a displayed stack with a quantity. Each copy still uses one storage slot, including equipped, placed and market-reserved copies.',
      'Every settlement upgrade, storage expansion, building and equipment upgrade requires FTH$ as well as its materials. Founding is free of FTH$ fees; already-owned upgrades stay built.',
      'Craft and equip better exploration gear to expand map visibility and destination reach. New expeditions survey a radius of two tiles, at most 13 tiles. Equipment never reveals land instantly or changes a travelling team. Place buildings and decorations freely in Layout.'],
    tip: 'Moving a facility changes its position, not its production bonus.', path: '/settlement/', action: 'Settlement' },
  { id: 'market', title: 'Trade what you have. Find what you need.', icon: 'market', tag: 'Buy & sell',
    intro: 'Short on Water? Your spare supplies might be someone else’s next big idea.',
    paragraphs: ['Wood trades in kilograms (kg), Water in liters (L), Metal in metric tonnes (t), and Oil in barrels (bbl). Wood uses a fixed game conversion of 500 kg per former cubic meter, not a universal timber density. Quantities and FTH$ prices use the same displayed unit. One barrel is approximately 158.987 L. Items trade in pieces.',
      'All assets use cost/effect-based starting prices, scarcity-sized pools and a 1% spread. Sale liquidity converts available origin FTHG at the active Gold rate. After origin exhaustion, only remaining pool funds and player bids pay for sales.',
      'Trades and gameplay fees transfer existing balances. Only the Gold engine can issue finite origin-backed liquidity. Off-chain conversions update Gold allocations and rates but require authorized Ethereum settlement; they do not transfer tokens automatically.',
      'Open Settlement → Sell resources to sell half of every owned resource together at live spot prices. Quantities round down, pending resources and escrow are excluded, and one confirmation protects the whole sale. No market building is needed.',
      'Compare prices in the grid or table, filter your holdings, and choose Buy or Sell to prepare an order. Review the amount and total before confirming; selecting a price never places an order.',
      'Build a market stall, trade hub or city bank to sell owned resources directly in Settlement. Quick sales use the same live marketplace spot quotes, order matching and price protection, not fixed bank prices.',
      'Buy or sell now at the current price, or choose a price and leave an offer. Reserved funds and items return when you cancel an unfilled offer. Prices move; check the quote before confirming.',
      'All items use demand-priced spot liquidity and player offers. Each copy uses one bag slot; one equipped or placed copy is protected. Collectibles trade one at a time. Existing reserves fund item pools without issuing FTH$.',
      'Open Wallet and staking for the real Ethereum FTHG bridge and staking contract. Authorize your Dollar wallet in Account before spending its FTH$ on gameplay. FTH$ displays at most two decimals; gameplay retains four-place accounting precision.'],
    tip: 'Water bought in the market enters owned stock, ready for the next daily bill.', image: 'market', alt: 'Marketplace showing Water, buy and sell controls and price history.', path: '/market/?asset=water&side=buy', action: 'Buy Water' },
  { id: 'community', title: 'Better together.', icon: 'communicate', tag: 'Community',
    intro: 'Swap ideas in chat. Build relationships. Give your settlement a wider world.',
    paragraphs: ['Inbox lists public Explore chats within your current exploration radius and public chats for the federations represented there. Contacts is under the avatar menu. Visit a settlement to join its separate visitor group chat; these rooms are not listed in Inbox. Chat keeps the latest 100 messages per room with one message every three seconds. Choose a unique nickname and never share secrets.',
      'Reach Village and 50 relations to join Evergreen Union. Goodwill gifts improve relations. Members gain 20% Metal crew yield from the next work week.',
      'A town hall lets members vote. Cities with more than 10,000 residents can found a federation for 5,000 Metal. These are simulation features, not real governing authority.'],
    tip: 'Open Federation for membership, population, gifts and assembly actions.', path: '/communicate/', action: 'Inbox' },
  { id: 'clock', title: 'Your world keeps moving.', icon: 'sun', tag: 'Time & offline play',
    intro: 'Daily needs. Weekly deliveries. A year of changing seasons.',
    paragraphs: ['A game week takes five real minutes at the default 33.6x clock speed. Work completes continuously; harder expeditions take ten or fifteen minutes. Existing saves and earned balances are preserved.',
      'Gathering and Water consumption continue offline. Active collection items automate paid pickups until expiry; shortages never delete residents.',
      'The calendar has 52 weeks per year and 13 weeks per season. A compact clock shows game time and four square season indicators fill from bottom to top as the year passes. Seven weekday segments track progress through the week. The current season is highlighted. Server updates arrive every 30–35 real seconds; a stale clock pauses its display and shows a sync warning rather than inventing progress.'],
    tip: 'Before leaving: check daily Water demand, weekly deliveries and transport funding.', path: '/settlement/#production', action: 'Storage' },
  { id: 'journal', title: 'Your story, safely kept.', icon: 'journal', tag: 'Journal & saves',
    intro: 'New discoveries, finished buildings and hard lessons: your journal keeps the latest chapter.',
    paragraphs: ['Search Journal for construction and returning expeditions. The Water card shows current shortages. Export a server snapshot for your records, or download an old browser save for recovery reference.',
      'Keep your session cookie to return to this settlement. Balances live on the server. Exports are records, not importable balances, and snapshots omit your CSRF token.',
      'Featheral is a game simulation. It does not promise monetary rewards or real authority. The white paper explains its rules and limitations.'],
    tip: 'If supplies run out, your residents stay. Use basic gathering and existing market liquidity to recover. Permanent accounts and large-scale social infrastructure are a later phase.', path: '/journal/', action: 'Journal' },
] as const;

export function guideContent(language: Language, embedded = false): string {
  const prefix = embedded ? 'account-guide' : 'guide';
  return `<header class="guide-hero"><span class="eyebrow">THE FEATHERAL FIELD GUIDE</span><h1>Small steps. A thriving settlement.</h1><p>A visual handbook for curious pioneers. Start at the top, follow your curiosity, and keep scrolling.</p><a class="button primary" href="#${prefix}-explore">Start exploring ${icon('arrow')}</a></header>
    <div class="guide-layout"><aside class="guide-index" aria-label="Guide topics">
      <label for="${prefix}-search">Find a topic</label><input id="${prefix}-search" data-guide-search type="search" placeholder="Water, crews, crafting…" autocomplete="off">
      <p class="guide-results" data-guide-results role="status"></p><button class="text-button" data-guide-reset hidden>Show all topics</button>
      <nav aria-label="On this page">${guideTopics.map((topic, i) => `<a href="#${prefix}-${topic.id}" data-guide-link="${topic.id}"><span>${String(i + 1).padStart(2, '0')}</span>${topic.title}</a>`).join('')}</nav>
      <label for="${prefix}-progress">Reading progress</label><progress id="${prefix}-progress" data-guide-progress max="100" value="0"></progress>
    </aside><div class="guide-articles">${guideTopics.map((topic, i) => `<article class="guide-article" id="${prefix}-${topic.id}" data-guide-topic="${topic.id}">
      <header><span class="guide-chapter">${String(i + 1).padStart(2, '0')} ${icon(topic.icon)}</span><span class="eyebrow">${topic.tag}</span><h2>${topic.title}</h2><p class="guide-lead">${topic.intro}</p></header>
      ${'image' in topic ? `<figure><a href="/images/guide/${language}/${topic.image}.jpg" target="_blank" rel="noopener" aria-label="Open full-size screenshot"><img src="/images/guide/${language}/${topic.image}.jpg" width="1280" height="800" loading="lazy" decoding="async" alt="${topic.alt}"></a><figcaption><span>Example settlement; values are illustrative.</span> · <span>Tap the image to enlarge.</span></figcaption></figure>` : ''}
      ${topic.paragraphs.map(p => `<p>${p}</p>`).join('')}
      ${topic.id === 'water' ? `<div class="guide-facilities">${waterFacilityKeys.map(key => `<div>${icon(key)}<strong>${waterFacilities[key].name}</strong><b>+${waterFacilities[key].bonus * 100}%</b><small>${waterFacilities[key].cost.wood} <span>Wood</span> · ${waterFacilities[key].cost.metal} <span>Metal</span></small></div>`).join('')}</div>` : ''}
      ${topic.id === 'clock' ? `<div class="guide-week" aria-label="Seven days in a game week">${Array.from({ length: 7 }, (_, day) => `<span>${icon(day < 3 ? 'check' : 'sun')}<small>${day + 1}</small></span>`).join('')}</div>` : ''}
      <aside class="guide-tip">${icon('spark')}<p>${topic.tip}</p></aside><a class="button" href="${topic.path}">${topic.action} ${icon('arrow')}</a></article>`).join('')}
      <p class="guide-empty" data-guide-empty hidden>No topics found. Try Water, crews or market.</p>
      <footer class="guide-footer"><h2>Ready for your next chapter?</h2><a class="button primary" href="/">Back to exploration ${icon('compass')}</a><a class="button" href="${language === 'ko' ? '/whitepaper/' : '/whitepaper/?lang=en'}">White paper</a><a class="button" href="#${prefix}-explore">Back to top</a></footer>
    </div></div>`;
}
export function wireGuide(root: HTMLElement, language: Language, inPane = false): void {
  const search = root.querySelector<HTMLInputElement>('[data-guide-search]')!;
  const articles = [...root.querySelectorAll<HTMLElement>('[data-guide-topic]')];
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-guide-link]')];
  const reset = root.querySelector<HTMLButtonElement>('[data-guide-reset]')!;
  const filter = () => {
    const query = search.value.trim().toLocaleLowerCase(locale(language));
    let visible = 0;
    for (const article of articles) {
      article.hidden = !article.textContent!.toLocaleLowerCase(locale(language)).includes(query);
      links.find(link => link.dataset.guideLink === article.dataset.guideTopic)!.hidden = article.hidden;
      if (!article.hidden) visible++;
    }
    root.querySelector('[data-guide-results]')!.textContent = `${visible} / ${articles.length}`;
    root.querySelector<HTMLElement>('[data-guide-empty]')!.hidden = visible > 0;
    reset.hidden = !query;
    progress();
  };
  const progress = () => {
    const range = root.scrollHeight - root.clientHeight;
    root.querySelector<HTMLProgressElement>('[data-guide-progress]')!.value = range > 0 ? Math.min(100, root.scrollTop / range * 100) : 100;
    const top = root.getBoundingClientRect().top + 140;
    const active = articles.filter(article => !article.hidden && article.getBoundingClientRect().top <= top).at(-1)
      ?? articles.find(article => !article.hidden);
    for (const link of links) {
      if (link.dataset.guideLink === active?.dataset.guideTopic) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  search.addEventListener('input', filter);
  reset.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  root.addEventListener('scroll', progress, { passive: true });
  if (inPane) root.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    const target = articles.find(article => `#${article.id}` === link?.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    root.scrollTo({ top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top });
    progress();
  });
  filter();
  requestAnimationFrame(() => {
    const target = inPane ? undefined : articles.find(article => `#${article.id}` === location.hash);
    target?.scrollIntoView({ block: 'start' });
    progress();
  });
}
