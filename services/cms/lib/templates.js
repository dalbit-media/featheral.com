const path = require('node:path');
const CmsStore = require('./cms');
const STORIES = {
  magazine: [
    'Independent publishing starts with a simple question: who gets to decide what is worth reading?\n\nSmall publications can take the time to follow a story rather than a trend. A clear editorial purpose, accessible writing, and transparent corrections build trust more reliably than a busy publishing calendar.\n\nAn open internet needs room for different perspectives. Credit your sources, link to the original work, and explain what remains uncertain. Readers should be able to follow the evidence for themselves.',
    'Good design makes curiosity feel welcome. It gives readers a clear starting point and leaves enough space for them to explore.\n\nTypography, contrast, and navigation do practical work. A descriptive link is more useful than a clever label that hides its destination. A quiet page can be more expressive than a wall of competing effects.\n\nBegin by watching someone use the page on a small screen. The moments where they hesitate are often the best guide to what needs attention.',
    'A slower digital routine is not a rejection of technology. It is a choice about where attention goes.\n\nKeep a short reading list, save useful sources, and revisit ideas after the immediate reaction has passed. An archive becomes valuable when it helps us remember context, not merely collect more links.\n\nMake room for disagreement and revision. Thoughtful culture grows when changing your mind is treated as learning rather than failure.',
  ],
  portfolio: [
    'A concept identity for an independent cultural publication.\n\nThe challenge: create a recognizable voice without making the content feel secondary. Our approach pairs strong editorial typography with a restrained color system and flexible layouts.\n\nDeliverables: a wordmark concept, a modular type scale, sample covers, and a responsive editorial homepage. This is an illustrative portfolio project, not a commissioned client claim.',
    'A concept workspace designed around how small creative teams actually work.\n\nThe challenge: reduce the friction between finding a useful idea and sharing it with someone else. We explored clear navigation, readable project summaries, and an accessible pattern for review states.\n\nDeliverables: journey sketches, a responsive interface concept, and a reusable card system. Outcomes described here are design intentions, not measured customer results.',
    'A motion-led storytelling concept for a digital exhibition.\n\nThe challenge: bring energy to a visual narrative while keeping text and controls usable. The concept uses a consistent rhythm, a limited graphic vocabulary, and reduced-motion alternatives.\n\nDeliverables: storyboard directions, frame compositions, and a still-image presentation. Replace this sample project with your own approved work and credits.',
  ],
  startup: [
    'A product concept should make the next action obvious.\n\nThis sample workspace brings project context, notes, and decisions into one readable place. The goal is less time looking for the latest update and more time doing useful work.\n\nThese are concept features, not an active subscription service. Before launch, define permissions, data export, support expectations, and how customer data will be protected.',
    'Independent teams need tools that respect their working habits.\n\nStart with a clear project owner, a shared record of decisions, and lightweight review checkpoints. Offer accessible interfaces and predictable navigation rather than assuming every team needs the same process.\n\nThis is a sample product story. No integrations, service-level commitments, or customer counts are asserted.',
    'Clear pricing begins with clear limits.\n\nExplain what a plan includes, what happens when usage grows, and how a customer can leave. Avoid hiding important terms behind a checkout button.\n\nThis sample site has no paid plans or billing service. Replace this page with reviewed pricing and cancellation terms only when a real service is ready.',
  ],
  store: [
    'A small sample collection for people who keep notes, make things, and share ideas.\n\nArchive Field Notes represents a digital notebook concept. The Studio Kit represents a creative resource bundle. The Independent Internet Print represents a limited-edition visual piece.\n\nAll three are demonstration products. Checkout records a local order and adjusts sample stock; it does not deliver a file or ship a physical item.',
    'A thoughtful product page tells the reader what is known and what still needs to be decided.\n\nFor a real collection, document the material, maker, dimensions, care requirements, and source. Give customers useful details instead of relying on vague sustainability claims.\n\nThis is a sample store and has no verified material sourcing or manufacturing program. Replace these notes with actual product information before selling anything.',
    'There is no shipping or fulfillment in this demo.\n\nLocal FTHX credits are used to exercise the catalog, cart, stock checks, and order history. They are not money, a cryptocurrency payment, or a claim on goods.\n\nA real shop would need reviewed shipping regions, delivery estimates, refund procedures, and customer support details. Do not use these sample terms for real transactions.',
  ],
  exchange: [
    'A constant-product pool holds two assets and quotes swaps using their reserves.\n\nIn this demo every market includes FTH$. An input increases one reserve and an output reduces the other. A pool fee stays in reserves, while integer rounding ensures outputs do not exceed the calculated amount.\n\nUse the quote panel to review the output, minimum received, and price impact before executing. This is local accounting, not blockchain settlement.',
    'Liquidity providers contribute both sides of a pair and receive LP units representing a share of its reserves.\n\nDeposits use proportional amounts. Withdrawals burn LP units and return a proportional amount of each reserve, subject to your minimum outputs and rounding. Pool fees remain in the reserves.\n\nIf market prices change, a liquidity position can be worth less than simply holding the original assets. This is commonly called impermanent loss. Demo positions have no monetary value.',
    'Every balance and pool shown here is a local simulation controlled by the operator.\n\nFTH$, USD$, BTC$, ETH$, and SOL$ are demo assets, not claims on coins, dollars, or reserves. FTHX is the local native credit of Featheral X and is not transferable between sites.\n\nThere is no deployed Layer 3 network, bridge, audited settlement contract, or real exchange listing. Never send funds or rely on demo credits for savings or income.',
  ],
};
const TEMPLATES = {
  notes: {
    name: 'Featheral Notes', hostname: 'notes.featheral.com', theme: 'ocean', homepage: 'content',
    title: 'Featheral Notes', excerpt: 'Currencies, global credits and content rewards for the Featheral ecosystem.',
    body: 'See circulating system-native notes and discover trending community notes. Create your own reward currency for 1,000 FTHX.\n\nFTH$ (Featheral Dollar) and FTHX (Featheral Exchange Token) cannot be earned through regular rewards. Community reward programs use community-created notes only. Create wallet-owned websites through Featheral Sites for 500 FTH$.',
    footer: 'Featheral Notes · currency and rewards service.',
    stories: [],
  },
  sites: {
    name: 'Featheral Sites', hostname: 'sites.featheral.com', theme: 'ocean', homepage: 'content',
    title: 'A home for your website', excerpt: 'Wallet-owned websites with editable pages, themes and community rewards.',
    body: 'Create your website for a one-time fee of 500 FTH$.\n\nEach website has its own address at sites.featheral.com/site-name, editable pages and theme.\n\nConnect your wallet above to create and manage your website. Fees transfer to the existing treasury; no Ethereum transaction is sent.',
    footer: 'Featheral Sites. Created and managed by your wallet.',
    stories: [],
  },
  website: {
    name: 'Your website', theme: 'ocean', homepage: 'content',
    title: 'Welcome to your website', excerpt: 'Your own place to publish on the web.',
    body: 'This is your homepage.\n\nEdit this page, add more pages and choose a theme from your wallet-owned website dashboard on Featheral Sites.',
    footer: 'Hosted by Featheral Sites.',
    stories: [],
  },
  stats: {
    name: 'Featheral Stats', hostname: 'stats.featheral.com', theme: 'ocean', homepage: 'content', stats: true,
    title: 'Featheral ecosystem statistics', excerpt: 'Aggregate page views across Featheral sites, updated hourly and daily.',
    body: 'Explore aggregate traffic across the Featheral ecosystem.\n\nCharts show the last 24 hourly buckets and 30 daily buckets in UTC. Counts start when telemetry is enabled; historical traffic is not invented.\n\nNo wallet identity, IP address, visitor identifier, page content or URL query is collected by ecosystem telemetry. Do Not Track and Global Privacy Control are respected.',
    stories: [],
  },
  magazine: {
    name: 'Featheral Journal', hostname: 'journal.featheral.com', theme: 'journal', homepage: 'content',
    title: 'Independent minds. Fresh perspectives.', excerpt: 'A contemporary journal of culture, design and the open internet.',
    body: 'Welcome to Featheral Journal. A sample editorial publication for curious minds.\n\nExplore original perspectives on thoughtful design, independent publishing, and digital culture. This sample content is yours to replace in Featheral CMS.',
    stories: ['The new independent internet', 'Designing for everyday curiosity', 'A slower approach to digital culture'],
  },
  portfolio: {
    name: 'Featheral Studio', hostname: 'studio.featheral.com', theme: 'studio', homepage: 'content',
    title: 'Make something that matters.', excerpt: 'An expressive portfolio for independent creatives and ambitious brands.',
    body: 'Featheral Studio is a sample creative portfolio. We bring clear thinking and bold craft to identity, digital products, and storytelling.\n\nExplore our sample projects below. Edit every project and this introduction through the CMS.',
    stories: ['Project 01: A new visual language', 'Project 02: Digital spaces for humans', 'Project 03: Stories in motion'],
  },
  startup: {
    name: 'Featheral Launch', hostname: 'launch.featheral.com', theme: 'launch', homepage: 'content',
    title: 'Your next idea, ready to launch.', excerpt: 'A polished SaaS concept for teams building a more connected internet.',
    body: 'Featheral Launch is a sample SaaS landing site, not a live subscription service. Bring your content, team, and workflow into one thoughtful workspace.\n\nStart with a clear product story. Replace these sample features with your own roadmap and service details in the CMS.',
    stories: ['One workspace, fewer distractions', 'Built for independent teams', 'Simple plans, transparent choices'],
  },
  store: {
    name: 'Featheral Supply', hostname: 'shop.featheral.com', theme: 'boutique', homepage: 'shop', commerce: true,
    title: 'Objects for a thoughtful internet.', excerpt: 'A curated boutique. Explore local FTHX-credit demo shopping.',
    body: 'Featheral Supply is a sample boutique featuring creative tools and independent ideas.\n\nAll products, credits, orders, and stock are demonstrations. No real payments, shipment, or fulfillment occur.',
    stories: ['Meet the collection', 'Our sample materials story', 'Demo shipping and returns policy'],
  },
  exchange: {
    name: 'Featheral Exchange', hostname: 'ex.featheral.com', theme: 'terminal', homepage: 'exchange', exchange: true,
    title: 'Featheral Exchange', excerpt: 'A Layer 3-inspired exchange simulation. Every pair is based in FTH$. No real funds.',
    body: 'Explore FTH$ base pairs, constant-product swaps, and liquidity positions in the Featheral Exchange local demo.\n\nThis is not a deployed Layer 3 blockchain, bridge, or production exchange. Demo assets have no monetary value. FTHX remains the native currency of Featheral X Media.',
    stories: ['How constant-product pools work', 'Understanding liquidity and impermanent loss', 'Demo assets and risk disclosure'],
  },
};
function install(cms, key) {
  const template = TEMPLATES[key];
  if (!template) throw Object.assign(new Error('Unknown sample template'), { status: 400 });
  cms.setTheme(template.theme);
  cms.save({ title: template.title, slug: 'home', excerpt: template.excerpt, body: template.body, type: 'page', status: 'publish' });
  cms.setSiteSettings({
    homepage: template.homepage, homeSlug: 'home', commerce: !!template.commerce, exchange: !!template.exchange, stats: !!template.stats,
    ageGate: false, nativeCurrency: key === 'exchange' ? 'FTH$' : 'FTHX',
    displayName: template.name, description: template.excerpt, footer: template.footer || (template.stats
      ? 'Aggregate telemetry only. UTC buckets; no visitor identities. Respecting Do Not Track and Global Privacy Control.'
      : 'An independent Featheral concept site. Demo content; no real payments or service commitments.'),
  });
  for (const [i, title] of template.stories.entries()) cms.save({
    title, excerpt: STORIES[key][i].split('\n')[0], body: STORIES[key][i],
    type: 'post', status: 'publish',
  });
}
function provision(manager) {
  return Object.entries(TEMPLATES).filter(([template]) => !['stats', 'sites', 'website', 'notes'].includes(template)).map(([template, config]) => {
    const existing = manager.records.find((s) => s.hostname === config.hostname);
    if (!existing) return manager.create({ hostname: config.hostname, name: config.name, template });
    const cms = new CmsStore(path.join(manager.dataDir, existing.key, 'cms.sqlite'));
    try {
      for (const [i, title] of config.stories.entries()) {
        const original = `${title}\n\nThis is editable sample content for ${config.name}. Replace it with your own story, project details, or policy through Featheral CMS.`;
        const post = cms.list().find((p) => p.title === title && p.type === 'post' && p.status === 'publish' && p.body === original &&
          p.excerpt === `Sample content from ${config.name}.`);
        if (post) cms.save({ ...post, body: STORIES[template][i], excerpt: STORIES[template][i].split('\n')[0] }, post.id);
      }
    } finally { cms.close(); }
    return existing;
  });
}
function upgradeSitesCreation(cms) {
  const oldBody = 'Featheral Sites is the home for free websites.\n\nEach website has its own address at sites.featheral.com/site-name, editable pages and theme.\n\nWebsites are currently created and managed by the administrator. Public self-service registration is not enabled.';
  const home = cms.list().find(page => page.slug === 'home');
  if (home?.body === oldBody) cms.save({ ...home, body: TEMPLATES.sites.body,
    excerpt: home.excerpt === 'Free websites, published and managed through Featheral Admin.' ? TEMPLATES.sites.excerpt : home.excerpt }, home.id);
  const settings = cms.siteSettings(), update = { ...settings };
  if (settings.description === 'Free websites, published and managed through Featheral Admin.') update.description = TEMPLATES.sites.excerpt;
  if (settings.footer === 'Free websites on Featheral. Created and managed by the administrator.') update.footer = TEMPLATES.sites.footer;
  if (update.description !== settings.description || update.footer !== settings.footer) cms.setSiteSettings(update);
}
module.exports = { TEMPLATES, install, provision, upgradeSitesCreation };
