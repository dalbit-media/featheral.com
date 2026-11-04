const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('node:events');
const express = require('express');
const yazl = require('yazl');
const { listLibrary, setDir, readJson, DATA_DIR } = require('./lib/store');
const { SyncRunner, probe } = require('./lib/sync');
const { getSite, dropSite } = require('./lib/wp');
const { PublicSite } = require('./lib/public');
const CmsStore = require('./lib/cms');
const FthxPages = require('./lib/fthx');
const Templates = require('./lib/templates');
const { SiteManager } = require('./lib/sites');
const T = require('./lib/text');
const { SitePages } = require('./lib/site-pages');
const { ServerProfile, serverProfileApi } = require('./lib/server-profile');
const sitePages = new SitePages({ root: path.resolve(__dirname, '..', '..'), dataDir: DATA_DIR });
const { Deployment } = require('./lib/deployment');
const operationsSettings = require('../operations/runtime');
const env = operationsSettings.environment();
require('../operations/configuration').assertDatabaseConfiguration(path.resolve(__dirname, '..', '..'));
const { requestPolicy, configureServer } = require('../operations/http');

const PORT = +env.PORT || 5178;
const HOST = env.HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });
// The stored dataset is the permanent local backbone; loading other sites is disabled unless allowSync is true.
const CONFIG = {
  brand: 'admin.featheral.com', siteKey: null, allowSync: false, publicBrand: 'x.featheral.com', publicTagline: null,
  cmsHost: 'admin.featheral.com', publicHost: 'x.featheral.com', ageGate: true, siteManagement: false,
  ...(env.ADMIN_CONFIG_JSON ? JSON.parse(env.ADMIN_CONFIG_JSON) : {
    siteKey: 'qporn-eurasiahosting-com', siteManagement: true, sampleSites: false,
    publicTagline: 'Featheral X Media Archiving and Streaming Platform. Share media, support free expression, and earn FTHX.',
  }),
};
const locked = !CONFIG.allowSync;
const { Telemetry, injectTelemetry } = require('./lib/telemetry');
const telemetry = new Telemetry(path.join(DATA_DIR, 'telemetry.sqlite'));
const { Notes } = require('../notes/ledger');
const notes = new Notes(path.join(DATA_DIR, 'notes.sqlite'));
const siteManager = CONFIG.siteManagement ? new SiteManager({
  cmsHost: CONFIG.cmsHost, defaultHost: CONFIG.publicHost, defaultKey: operationsSettings.replica ? null : CONFIG.siteKey,
}) : null;
const { Creation } = require('../notes/creation');
const creation = siteManager ? new Creation(notes, siteManager) : null;
const deployment = new Deployment({ root: path.resolve(__dirname, '..', '..'), settings: operationsSettings, snapshot: () => ({
  integrated: sitePages.snapshot(),
  managed: (siteManager?.records || []).map(record => {
    const store = new CmsStore(path.join(DATA_DIR, record.key, 'cms.sqlite'));
    try { return { hostname: record.hostname, ...(record.path ? { path: record.path } : {}), key: record.key, pages: store.published(), theme: store.theme(), settings: store.siteSettings(),
      rewards: { ...notes.program(record.key), enabled: !!notes.program(record.key).enabled } }; }
    finally { store.close(); }
  }),
}),
  hostnames: () => [...sitePages.catalog().map(site => site.hostname), ...(siteManager?.records.map(site => site.hostname) || [])],
  sites: () => {
    const managed = siteManager?.records || [];
    return [...sitePages.catalog().filter(site => !managed.some(record => record.hostname === site.hostname && !record.path)), ...managed];
  },
});
if (siteManager && CONFIG.sampleSites && !operationsSettings.replica) Templates.provision(siteManager);
const fthxSite = siteManager?.records.find((record) => record.hostname === 'x.featheral.com');
if (fthxSite && !operationsSettings.replica) {
  const cms = new CmsStore(path.join(DATA_DIR, fthxSite.key, 'cms.sqlite'));
  try { FthxPages.installNotes(cms); } finally { cms.close(); }
}
const sitesBase = siteManager?.records.find(record => record.hostname === 'sites.featheral.com' && !record.path);
if (sitesBase && !operationsSettings.replica) {
  const cms = new CmsStore(path.join(DATA_DIR, sitesBase.key, 'cms.sqlite'));
  try { Templates.upgradeSitesCreation(cms); } finally { cms.close(); }
}
const publicCache = new Map();
function invalidateSite(key) {
  const cached = publicCache.get(key);
  if (cached) { cached.close(); publicCache.delete(key); }
  dropSite(key);
}
const app = express();
app.use((req, res, next) => {
  if (requestPolicy(req, res, operationsSettings)) next();
});
app.use((req, res, next) => {
  if (![String(CONFIG.cmsHost).toLowerCase(), 'admin.localhost'].includes(req.hostname)) injectTelemetry(res);
  next();
});
app.use((req, res, next) => {
  if (!['sites.featheral.com', 'sites.localhost'].includes(req.hostname)) return next();
  const url = new URL(req.url, 'http://local');
  const segment = url.pathname.split('/')[1];
  if (!segment || ['api', 'site', 'shared', 'media', 'admin', 'operations', 'healthz'].includes(segment)) return next();
  const record = siteManager?.records.find(site => site.hostname === 'sites.featheral.com' && site.path === `/${segment}`);
  if (!record) return res.status(404).json({ error: 'Website not found' });
  if (url.pathname === record.path) return res.redirect(301, record.path + '/' + url.search);
  req.hostedSite = record;
  req.url = (url.pathname.slice(record.path.length) || '/') + url.search;
  if (req.url.startsWith('/api/') && !req.url.startsWith('/api/public/') && !req.url.startsWith('/api/telemetry/'))
    return res.status(404).json({ error: 'Website route not found' });
  next();
});
const telemetryRouter = express.Router();
const trafficHosts = () => [...new Set([...sitePages.catalog().map(site => site.hostname), ...(siteManager?.records.map(site => site.hostname + (site.path || '')) || [])])];
const trafficHost = req => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (req.hostedSite) return req.hostedSite.hostname + req.hostedSite.path;
  return trafficHosts().find(name => name === host || name.replace(/\.featheral\.com$/, '.localhost').replace(/^featheral\.com$/, 'localhost') === host);
};
telemetryRouter.post('/api/telemetry/hit', express.json({ limit: '1kb' }), (req, res) => {
  const host = trafficHost(req);
  const origin = req.get('origin');
  const protocol = req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
  if (!host || origin !== `${protocol}://${req.get('host')}`) return res.status(403).json({ error: 'A recognized same-origin site is required' });
  if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'Telemetry accepts only an empty JSON object' });
  if (req.get('DNT') === '1' || req.get('Sec-GPC') === '1') return res.json({ recorded: false });
  try { telemetry.hit(host); res.json({ recorded: true }); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Telemetry storage unavailable' }); }
});
telemetryRouter.get('/api/telemetry/report', cmsAuth, (req, res) => res.json(telemetry.report(trafficHosts())));
telemetryRouter.get('/api/telemetry/public', (req, res, next) => req.query.site ? cmsAuth(req, res, next) : next(), (req, res) => {
  const host = trafficHost(req);
  if (!req.query.site && host === 'stats.featheral.com')
    return res.json(telemetry.report(trafficHosts()));
  const record = siteManager?.records.find(site => req.cmsAuthorized && req.query.site ? site.key === req.query.site : site.hostname + (site.path || '') === host);
  if (!record) return res.sendStatus(404);
  const store = new CmsStore(path.join(DATA_DIR, record.key, 'cms.sqlite'));
  try {
    if (!store.siteSettings().stats) return res.sendStatus(404);
    res.json(telemetry.report(trafficHosts()));
  } finally { store.close(); }
});
telemetryRouter.use('/api/telemetry', (req, res) => res.sendStatus(404));
app.telemetryRequest = (req, res) => app(req, res);
app.use(telemetryRouter);
const jobs = new SyncRunner({ onBeforeSwap: invalidateSite });
function resolveHostname(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  const hosts = [CONFIG.cmsHost, 'dollar.featheral.com', 'wallet.featheral.com', ...(siteManager?.records.map((record) => record.hostname) || [CONFIG.publicHost])];
  return hosts.find((name) => host === name || (
    name.endsWith('.featheral.com') && host === name.replace(/\.featheral\.com$/, '.localhost')
  )) || null;
}
const hostName = (req) => resolveHostname(req.hostname) || String(req.hostname || '').toLowerCase().replace(/\.$/, '');
const localRequest = (req) => ['localhost', '127.0.0.1', '::1'].includes(hostName(req)) &&
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const adminAuth = require('./lib/admin-auth').createAdminAuth({ adminHost: String(CONFIG.cmsHost).toLowerCase() });
app.use('/api/admin-auth', adminAuth.router);
function cmsAuth(req, res, next) {
  adminAuth.authenticate(req, res, next);
}
app.use((req, res, next) => hostName(req) === String(CONFIG.cmsHost).toLowerCase()
  ? adminAuth.gate(req, res, () => { injectTelemetry(res); next(); }) : next());
const { ServerUsers } = require('./lib/server-users');
const serverUsers = new ServerUsers({ deployment, settings: operationsSettings });
const siteSync = new (require('./lib/site-sync').SiteSync)({
  root: path.resolve(__dirname, '..', '..'), settings: operationsSettings, deployment,
  command: serverUsers.command.bind(serverUsers),
  busy: () => serverUsers.changing || operationsSettings.busy || selfDeployment.active(),
});
const selfDeployment = new (require('../operations/self-deployment').SelfDeployment)({
  root: path.resolve(__dirname, '..', '..'), settings: operationsSettings, deployment,
  busy: () => siteSync.running || serverUsers.changing || operationsSettings.busy,
});
deployment.selfDeployment = selfDeployment;
const ledgerDirectory = path.resolve(env.DB_LEDGER_DIR || path.join(__dirname, '..', '..', 'data', 'file-ledgers'));
fs.mkdirSync(ledgerDirectory, { recursive: true });
const database = require('../database/server').createDatabase({
  directory: fs.realpathSync(ledgerDirectory),
  env,
  repository: path.resolve(__dirname, '..', '..'), sites: () => sitePages.hosts,
  credentialVault: operationsSettings,
});
operationsSettings.isBusy = () => deployment.running || siteSync.running || selfDeployment.active();
deployment.siteSync = siteSync;
operationsSettings.verifyCredential = async config => {
  const client = await serverUsers.connect(config);
  try {
    const uid = (await serverUsers.command(client, 'id -u')).trim();
    if (!/^\d+$/.test(uid)) throw Object.assign(new Error('SSH server returned an invalid user ID.'), { status: 502 });
    if (uid !== '0') await serverUsers.command(client, "sudo -S -p '' -- true", config.password + '\n');
    return config.fingerprint;
  } finally { client.end(); config.password = ''; }
};
serverUsers.vault = database.vault;
deployment.vault = database.vault;
app.database = database;
app.use('/api/database', database.adminRouter({
  cmsAuth, passwordConfigured: () => true, deployment, serverUsers, adminHost: String(CONFIG.cmsHost).toLowerCase(),
}));
app.use('/api/v1/db', (req, res, next) => ['db.featheral.com', 'db.localhost'].includes(req.hostname)
  ? database.publicRouter(req, res, next) : res.sendStatus(404));
app.use('/api/server-users', require('./lib/server-users-api').serverUsersApi({
  service: serverUsers, cmsAuth, passwordConfigured: () => true, adminHost: String(CONFIG.cmsHost).toLowerCase(),
}));
app.use('/api/settings', require('../operations/api').settingsApi({
  settings: operationsSettings, siteSync, selfDeployment, cmsAuth, adminHost: String(CONFIG.cmsHost).toLowerCase(),
  sites: () => [...sitePages.catalog(), ...(siteManager?.list() || [])],
}));
app.operationsSettings = operationsSettings;
const serverProfile = new ServerProfile({
  root: path.resolve(__dirname, '..', '..'),
  dataDirectory: DATA_DIR,
  externalDirectories: [
    { directory: env.DB_LEDGER_DIR, category: 'ledgers' },
    { directory: env.FTH_LEDGER_DIR, category: 'ledgers' },
    { directory: env.WORLD_LEDGER_DIR, category: 'ledgers' },
    { directory: env.DOLLAR_GAME_DIR, category: 'otherData' },
  ].filter(entry => entry.directory),
  networkLimitBytesPerSecond: operationsSettings.value.networkLimitBytesPerSecond,
});
operationsSettings.listeners.add(() => {
  serverProfile.networkLimitBytesPerSecond = operationsSettings.value.networkLimitBytesPerSecond || null;
});
app.serverProfile = serverProfile;
app.use('/api/server-profile', serverProfileApi({
  service: serverProfile, cmsAuth, passwordConfigured: () => true, adminHost: String(CONFIG.cmsHost).toLowerCase(),
}));
let operationsHandler;
app.setOperationsHandler = handler => { operationsHandler = handler; };
app.setCreationPayments = payment => { if (creation) { creation.payment = payment; if (payment) creation.recover().catch(console.error); } };
const dollarExchange = creation ? new (require('../notes/exchange').Exchange)(creation) : null;
const trading = creation ? new (require('../notes/trading').Trading)(creation, dollarExchange) : null;
let dollarWalletReader;
let portfolioGoldReader;
let walletSourceReader;
app.setPortfolioGold = reader => { portfolioGoldReader = reader; };
app.setWalletSources = reader => { walletSourceReader = reader; };
app.walletSummary = async (owner, publicWorldAccount) => {
  if (!creation || !dollarWalletReader) throw Object.assign(new Error('Wallet services are unavailable.'), { status: 503 });
  if (!require('ethers').isAddress(owner)) throw Object.assign(new Error('Invalid Ethereum wallet address.'), { status: 400 });
  if (publicWorldAccount && !/^0x[0-9a-f]{64}$/.test(publicWorldAccount))
    throw Object.assign(new Error('Invalid public World account.'), { status: 400 });
  owner = owner.toLowerCase();
  const account = creation.account(owner), dollar = dollarWalletReader(owner);
  const sources = walletSourceReader ? await walletSourceReader(owner, publicWorldAccount)
    : { ethereum: null, world: null, ethereumError: 'Ethereum balance reader unavailable.', worldError: 'World balance reader unavailable.' };
  const portfolio = await walletPortfolio(trading.portfolioHoldings(owner, [{ symbol: 'FTH$', balance: dollar.balance.available },
    ...account.holdings.filter(asset => asset.symbol !== 'FTH$')]), sources);
  return { address: account.address, holdings: account.holdings, trading: trading.account(owner), dollar, ...sources, portfolio,
    markets: { trades: creation.markets.account(owner).trades }, exchange: { trades: dollarExchange.account(owner).trades, requests: [] },
    silverActivity: creation.db.prepare("SELECT amount,kind,at,symbol FROM notes_entries WHERE address=? AND kind IN ('silver-purchase','silver-refund') ORDER BY id DESC LIMIT 50").all(owner),
    noteTransfers: creation.db.prepare("SELECT owner,payload,at FROM note_wallet_transfers WHERE owner=? OR json_extract(payload,'$.to')=? ORDER BY at DESC LIMIT 50")
      .all(owner, owner).map(row => ({ owner: row.owner, ...JSON.parse(row.payload), at: row.at })) };
};
async function walletPortfolio(holdings, extra) {
  let gold = null, goldError = null;
  if (portfolioGoldReader) {
    try { gold = await portfolioGoldReader(); goldError = gold?.error || null; }
    catch (error) { console.error('Portfolio Gold price unavailable:', error); goldError = error.message; }
  }
  let markets = [], pool = { funded: false, dollars: '0', fthx: 0 };
  let marketError = null;
  try {
    dollarExchange.assertReady();
    markets = creation.markets.catalog();
    for (const market of markets) {
      if (market.funded) {
        const pair = creation.markets.pool(market.symbol);
        const account = creation.markets.poolAccount(market.symbol);
        if (creation.notes.balance(account, 'FTHX') !== pair.base || creation.notes.balance(account, market.symbol) !== pair.quote)
          throw new Error('Note market reserves do not match authoritative balances.');
      }
    }
    pool = dollarExchange.pool();
    if (pool.funded) dollarExchange.validatePool(pool);
  } catch (error) {
    console.error('Portfolio market prices unavailable:', error); marketError = error.message;
    pool = { funded: false, dollars: '0', fthx: 0, priceError: marketError }; markets = [];
  }
  return { ...require('../notes/portfolio').portfolio(holdings, pool, markets, gold, extra), goldError, marketError };
}
app.setDollarWallet = (reader, settlement) => {
  dollarWalletReader = reader;
  if (dollarExchange) {
    dollarExchange.setDollar(settlement);
    if (settlement) {
      try { trading.recover(); } catch (error) { console.error('Exchange trading withdrawal recovery required:', error); }
      dollarExchange.recover().catch(console.error);
    }
  }
};
app.setNoteSupply = supply => { if (creation) creation.dollarSupply = supply; };
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/v1/')) return next();
  if (![String(CONFIG.cmsHost).toLowerCase(), 'notes.featheral.com'].includes(hostName(req)) && !localRequest(req)) return res.sendStatus(404);
  cmsAuth(req, res, () => {
    if (!operationsHandler) return res.status(503).json({ error: 'Administration APIs require the main Featheral server (npm start).' });
    const protocol = req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== `${protocol}://${req.get('host')}`)
      return res.status(403).json({ error: 'Same-origin administration requests are required' });
    Promise.resolve(operationsHandler(req, res)).catch(error => fail(res, error));
  });
});
app.use('/api/sets', cmsAuth);
app.use('/api/sites', cmsAuth);
app.use('/api/deployment', cmsAuth);
app.use('/api/notes', (req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/ledger/')) return next();
  cmsAuth(req, res, next);
});
app.use('/api/notes', (req, res, next) => {
  const protocol = req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== `${protocol}://${req.get('host')}`)
    return res.status(403).json({ error: 'Same-origin Notes requests are required' });
  next();
});
app.use('/api/public', (req, res, next) => req.query.site ? cmsAuth(req, res, next) : next());
app.use((req, res, next) => express.json({ limit: operationsSettings.value.uploadLimitMiB * 1024 ** 2 })(req, res, next));
const sitesRoot = path.resolve(__dirname, '..', '..', 'sites');
const cmsFrontend = path.join(sitesRoot, 'admin.featheral.com');
const publicFrontend = path.join(sitesRoot, 'x.featheral.com');
const exchangeFrontend = path.join(sitesRoot, 'ex.featheral.com');
app.use('/shared', express.static(path.resolve(sitesRoot, '..', 'shared'), { index: false }), (_req, res) => res.sendStatus(404));
app.use('/operations', (req, res, next) => {
  if (hostName(req) !== String(CONFIG.cmsHost).toLowerCase() && !localRequest(req)) return res.sendStatus(404);
  cmsAuth(req, res, next);
});
app.get(/^\/operations\/(foundation|gold|dollar|world)\/?$/, (req, res) => {
  res.redirect(302, `/#/operations/${req.params[0]}`);
});
app.get('/js/vendor/ethers.js', (req, res) => res.sendFile(path.resolve(path.dirname(require.resolve('ethers')), '..', 'dist', 'ethers.umd.min.js')));
app.get('/js/dollar-format.js', (req, res) => res.sendFile(path.join(sitesRoot, 'dollar.featheral.com', 'fth.js')));
app.get('/js/reserve-view.js', (req, res) => res.sendFile(path.join(sitesRoot, 'gold.featheral.com', 'reserve-view.js')));
app.get('/reserve.css', (req, res) => res.sendFile(path.join(sitesRoot, 'gold.featheral.com', 'reserve.css')));
app.use('/operations', (req, res) => res.sendStatus(404));
// Preserve /site asset URLs for public hosts and authenticated CMS previews.
app.get('/site/stats.js', (req, res) => res.sendFile(path.join(sitesRoot, 'stats.featheral.com', 'stats.js')));
app.use('/site', (req, res, next) => {
  if (!['notes.featheral.com', 'ex.featheral.com'].includes(hostName(req))) return next();
  express.static(path.join(sitesRoot, 'notes.featheral.com'), { index: false })(req, res, next);
});
app.use('/site', express.static(path.join(sitesRoot, 'sites.featheral.com'), { index: false }));
app.use('/site', express.static(publicFrontend, { index: false }));
app.use('/site', express.static(exchangeFrontend, { index: false }));
app.use((req, res, next) => {
  if (hostName(req) !== String(CONFIG.cmsHost).toLowerCase() && !localRequest(req)) return next();
  express.static(cmsFrontend, { index: false })(req, res, next);
});

const wrap = (fn) => (req, res) => {
  try {
    const r = fn(req, res);
    if (r && typeof r.then === 'function') r.catch((e) => fail(res, e));
  } catch (e) { fail(res, e); }
};
function fail(res, e) {
  console.error(e);
  if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  else res.end();
}
const notFound = (msg) => Object.assign(new Error(msg), { status: 404 });
let workspaceProfileReader = () => { throw Object.assign(new Error('World profile reader is unavailable. Use the main gateway.'), { status: 503 }); };
app.setWorkspaceProfiles = reader => { workspaceProfileReader = reader; };
if (creation) {
  const { router, workspace } = require('./lib/workspace-api').workspaceApi({
    notes, markets: creation.markets, cmsAuth, profileReader: address => workspaceProfileReader(address),
  });
  app.workspace = workspace;
  app.use('/api/intranet', router);
  const silver = require('./lib/silver-api').silverApi({ notes, markets: creation.markets, cmsAuth });
  app.silverStore = silver.store;
  app.use('/api/silver', silver.router);
}

// Public wallet-owned creation is deliberately separate from privileged CMS routes.
const creationRouter = express.Router();
const creationLimits = new Map();
creationRouter.use((req, res, next) => {
  if (!creation) return res.status(503).json({ error: 'Site creation is not configured.' });
  const statsRead = hostName(req) === 'stats.featheral.com' && req.method === 'GET' && req.path === '/trending';
  if (req.hostedSite || !statsRead && !['notes.featheral.com', 'sites.featheral.com', 'ex.featheral.com', 'dollar.featheral.com', 'wallet.featheral.com'].includes(hostName(req))) return res.sendStatus(404);
  if (!['GET', 'HEAD'].includes(req.method)) {
    const protocol = req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
    if (req.get('origin') !== `${protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Same-origin creation requests are required.' });
    const key = req.socket.remoteAddress, now = Date.now();
    const recent = (creationLimits.get(key) || []).filter(at => now - at < 60000);
    if (recent.length >= 30) return res.status(429).json({ error: 'Too many creation requests. Try again in a minute.' });
    recent.push(now); creationLimits.set(key, recent);
    if (creationLimits.size > 20000) creationLimits.delete(creationLimits.keys().next().value);
  }
  next();
});
const creationOwner = req => creation.owner(req.get('x-creation-token'));
creationRouter.get('/economy/reference', wrap(async (req, res) => {
  const origin = req.get('origin');
  if (origin && !require('../wallet/ui').allowedOrigin(origin))
    return res.status(403).json({ error: 'Unsupported valuation reader origin.' });
  if (origin) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  res.set('Cache-Control', 'no-store');
  res.json(await walletPortfolio([{ symbol: 'FTH$', balance: '1000000000000000000' }], {}));
}));
creationRouter.get('/trending', wrap((req, res) => {
  const interval = req.query.interval || '24h';
  if (!['1h', '24h', '7d', '30d'].includes(interval)) throw Object.assign(new Error('Choose a supported chart interval.'), { status: 400 });
  const symbols = new Set(creation.markets.catalog().map(market => market.symbol));
  const pair = dollarExchange.market(interval), pairVolume = Number(pair.volumeFthx);
  if (!Number.isSafeInteger(pairVolume)) throw Object.assign(new Error('FTHX trading volume exceeds safe unit limits.'), { status: 409 });
  const notes = creation.trending().map(note => {
    const native = pair.notes.find(asset => asset.symbol === note.symbol);
    const volume = note.symbol === 'FTHX' ? note.volume + pairVolume : note.symbol === 'FTH$' ? pairVolume : note.volume;
    if (!Number.isSafeInteger(volume)) throw Object.assign(new Error('FTHX trading volume exceeds safe unit limits.'), { status: 409 });
    return { ...note, ...native, volume,
      history: native?.history || (symbols.has(note.symbol) ? creation.markets.history(note.symbol, interval) : null) };
  }).sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol));
  res.json({ notes, dollarPair: pair, noteCost: 1000, siteCost: 500 });
}));
creationRouter.get('/markets', wrap((req, res) => res.json({ markets: creation.markets.catalog() })));
creationRouter.get('/markets/:symbol/history', wrap((req, res) => res.json(creation.markets.history(req.params.symbol, req.query.interval))));
creationRouter.get('/markets/account', wrap((req, res) => res.json(creation.markets.account(creationOwner(req)))));
creationRouter.use('/trading', (req, res, next) => {
  if (hostName(req) !== 'ex.featheral.com') return res.status(403).json({ error: 'Trading accounts are managed on Featheral Exchange only.' });
  res.set('Cache-Control', 'no-store');
  next();
});
creationRouter.get('/trading/account', wrap(async (req, res) => {
  const account = trading.account(creationOwner(req));
  const owner = creationOwner(req);
  res.json({ ...account, legacyRequests: dollarExchange.account(owner).requests.filter(request => request.parameters.funding !== undefined),
    walletTrades: dollarExchange.walletTrades(owner),
    portfolio: await walletPortfolio(account.holdings, {}) });
}));
creationRouter.get('/trading/markets', wrap(async (req, res) => {
  const pair = dollarExchange.market(req.query.interval || '24h');
  const reference = await walletPortfolio([{ symbol: 'FTH$', balance: '1000000000000000000' }], {});
  res.json({ markets: [pair.notes[0], ...creation.markets.catalog()], pair, reference });
}));
for (const method of ['deposit', 'withdraw', 'trade']) {
  creationRouter.post(`/trading/${method}`, wrap((req, res) => res.json(trading[method](creationOwner(req), req.body))));
}
creationRouter.post('/trading/quote', wrap((req, res) => res.json(trading.quote(req.body))));
creationRouter.post('/markets/liquidity/quote', wrap((req, res) => {
  if (hostName(req) !== 'ex.featheral.com') return res.status(410).json({ error: 'Manage liquidity on Featheral Exchange.' });
  res.json(creation.markets.liquidityQuote(req.body?.symbol, req.body?.action, req.body?.amount));
}));
creationRouter.post('/markets/liquidity', wrap((req, res) => {
  if (hostName(req) !== 'ex.featheral.com') return res.status(410).json({ error: 'Manage liquidity on Featheral Exchange.' });
  res.json(creation.markets.liquidity(creationOwner(req), req.body));
}));
creationRouter.post('/markets/quote', wrap((req, res) => {
  if (!['notes.featheral.com', 'ex.featheral.com', 'dollar.featheral.com', 'wallet.featheral.com'].includes(hostName(req))) return res.sendStatus(404);
  res.json(creation.markets.quote(req.body?.symbol, req.body?.side, req.body?.amount));
}));
creationRouter.post('/markets/trade', wrap((req, res) => {
  res.status(410).json({ error: 'Deposit FTHX to an Exchange trading account and use /api/creation/trading/trade.' });
}));
creationRouter.use('/wallet/swaps', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['wallet.featheral.com', 'ex.featheral.com'].includes(hostName(req))) return res.status(403).json({ error: 'Use the shared wallet or Exchange to swap.' });
  next();
});
creationRouter.post('/wallet/swaps/quote', wrap((req, res) => res.json(dollarExchange.swapQuote(req.body))));
creationRouter.post('/wallet/swaps/prepare', wrap((req, res) => res.json(dollarExchange.prepareSwap(creationOwner(req), req.body))));
creationRouter.post('/wallet/swaps/:id/refresh', wrap((req, res) => res.json(dollarExchange.refreshSwap(creationOwner(req), req.params.id))));
creationRouter.post('/wallet/swaps/:id/cancel', wrap((req, res) => res.json(dollarExchange.cancelSwap(creationOwner(req), req.params.id))));
creationRouter.post('/wallet/swaps/:id/complete', wrap(async (req, res) => res.json(await dollarExchange.completeSwap(creationOwner(req), req.params.id, req.body?.signature))));
creationRouter.post('/challenge', wrap((req, res) => res.json(creation.challenge(req.body?.address))));
creationRouter.post('/login', wrap((req, res) => res.json(creation.login(req.body?.address, req.body?.signature))));
creationRouter.post('/logout', wrap((req, res) => {
  creation.db.prepare('DELETE FROM creation_sessions WHERE token=?').run(String(req.get('x-creation-token') || ''));
  res.json({ ok: true });
}));
creationRouter.get('/me', wrap((req, res) => {
  const owner = creationOwner(req);
  res.json({ ...creation.account(owner), dollarExchange: dollarExchange?.account(owner) });
}));
creationRouter.get('/wallet', wrap(async (req, res) => {
  const owner = creationOwner(req);
  if (!dollarWalletReader) throw Object.assign(new Error('Dollar wallet service is unavailable.'), { status: 503 });
  const account = creation.account(owner), dollar = dollarWalletReader(owner);
  let worldAccount;
  if (req.query.worldAccount !== undefined) {
    if (typeof req.query.worldAccount !== 'string' || !/^0x[0-9a-f]{64}$/.test(req.query.worldAccount))
      throw Object.assign(new Error('Invalid public World account.'), { status: 400 });
    worldAccount = req.query.worldAccount;
  }
  const sources = walletSourceReader ? await walletSourceReader(owner, worldAccount)
    : { ethereum: null, world: null, ethereumError: 'Ethereum balance reader unavailable.', worldError: 'World balance reader unavailable.' };
  const portfolio = await walletPortfolio(trading.portfolioHoldings(owner, [{ symbol: 'FTH$', balance: dollar.balance.available }, ...account.holdings.filter(asset => asset.symbol !== 'FTH$')]), sources);
  res.json({ ...account, ...sources, dollar, portfolio, trading: trading.account(owner), markets: creation.markets.account(owner),
    exchange: dollarExchange.account(owner), dollarPool: dollarExchange.pool(),
    noteTransfers: creation.db.prepare("SELECT owner,payload,at FROM note_wallet_transfers WHERE owner=? OR json_extract(payload,'$.to')=? ORDER BY at DESC LIMIT 50")
      .all(owner, owner).map(row => ({ owner: row.owner, ...JSON.parse(row.payload), at: row.at })) });
}));
creationRouter.get('/wallet/portfolio/:account', wrap(async (req, res) => {
  const { normalizeAccount } = require('../fth-ledger/transfer');
  const account = normalizeAccount(req.params.account);
  if (!dollarWalletReader) throw Object.assign(new Error('Dollar wallet service is unavailable.'), { status: 503 });
  const wallet = dollarWalletReader(account);
  res.json(await walletPortfolio([{ symbol: 'FTH$', balance: wallet.balance.available }]));
}));
creationRouter.post('/wallet/send/prepare', wrap((req, res) => {
  const owner = creationOwner(req);
  if (!dollarWalletReader) throw Object.assign(new Error('Dollar wallet service unavailable.'), { status: 503 });
  const { normalizeAccount, transferMessage, walletAccountId } = require('../fth-ledger/transfer');
  const to = normalizeAccount(req.body?.to), amount = req.body?.amount;
  if (to === walletAccountId(owner) || to === require('ethers').ethers.ZeroHash
    || typeof amount !== 'string' || !/^[1-9]\d{0,77}$/.test(amount)) throw Object.assign(new Error('Choose another recipient and a positive FTH$ amount.'), { status: 400 });
  const wallet = dollarWalletReader(owner);
  if (BigInt(wallet.balance.available) < BigInt(amount)) throw Object.assign(new Error('Insufficient FTH$.'), { status: 402 });
  const payment = { wallet: creation.address(owner), to, amount, nonce: wallet.nonce + 1, memo: '', issuedAt: new Date().toISOString() };
  res.json({ payment, message: transferMessage(payment) });
}));
creationRouter.post('/wallet/notes/send', wrap((req, res) => res.json(creation.sendNote(creationOwner(req), req.body))));
creationRouter.get('/dollar-pool', wrap((req, res) => res.json(dollarExchange.pool())));
creationRouter.get('/dollar-pool/market', wrap((req, res) => res.json(dollarExchange.market(req.query.interval))));
creationRouter.use('/dollar-pool', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && hostName(req) !== 'ex.featheral.com')
    return res.status(410).json({ error: 'Manage Exchange settlements and liquidity on Featheral Exchange.' });
  next();
});
creationRouter.post('/dollar-pool/quote', wrap((req, res) => res.json(dollarExchange.quote(req.body))));
creationRouter.post('/dollar-pool/prepare', (req, res) => res.status(410).json({ error: 'New swaps require an Exchange trading account. Existing pending settlements can still be resumed.' }));
creationRouter.post('/dollar-pool/:id/complete', wrap(async (req, res) => res.json(await dollarExchange.complete(creationOwner(req), req.params.id, req.body?.signature))));
creationRouter.post('/dollar-pool/:id/refresh', wrap((req, res) => res.json(dollarExchange.refresh(creationOwner(req), req.params.id))));
creationRouter.post('/dollar-pool/fund', cmsAuth, wrap((req, res) => res.json(dollarExchange.prepare(creationOwner(req), req.body, true))));
creationRouter.post('/notes', wrap((req, res) => {
  if (hostName(req) === 'ex.featheral.com') return res.sendStatus(404);
  res.status(201).json(creation.mintNote(creationOwner(req), req.body));
}));
creationRouter.post('/sites/prepare', wrap((req, res) => {
  res.json(creation.prepareSite(creationOwner(req), req.body));
}));
creationRouter.post('/sites/:id/complete', wrap(async (req, res) => {
  res.status(201).json(await creation.completeSite(creationOwner(req), req.params.id, req.body?.signature));
}));
creationRouter.put('/owned/:key/note', wrap((req, res) => res.json(creation.integrate(creationOwner(req), req.params.key, req.body?.symbol))));
creationRouter.use('/owned/:key', (req, res, next) => {
  try { creation.requireSite(creationOwner(req), req.params.key); next(); }
  catch (error) { fail(res, error); }
});
creationRouter.get('/owned/:key/pages', wrap((req, res) => res.json(publicByKey(req.params.key).cms.list())));
const safeOwnerBody = body => require('./lib/documents').validateBody(body, {});
creationRouter.post('/owned/:key/pages', wrap((req, res) => {
  res.status(201).json(publicByKey(req.params.key).cms.save({ title: req.body?.title, body: safeOwnerBody(req.body?.body),
    type: 'page', status: 'publish' }));
}));
creationRouter.put('/owned/:key/pages/:id', wrap((req, res) => {
  const store = publicByKey(req.params.key).cms;
  const existing = store.get(req.params.id);
  if (!existing) throw notFound('Page not found.');
  if (!Number.isSafeInteger(req.body?.revision)) throw Object.assign(new Error('Current page revision is required.'), { status: 400 });
  res.json(store.save({ ...existing, title: req.body?.title, body: safeOwnerBody(req.body?.body), revision: req.body.revision }, req.params.id));
}));
creationRouter.get('/owned/:key/theme', wrap((req, res) => res.json({ theme: publicByKey(req.params.key).cms.theme(), themes: CmsStore.THEMES })));
creationRouter.get('/owned/:key/settings', wrap((req, res) => res.json(publicByKey(req.params.key).cms.siteSettings())));
creationRouter.put('/owned/:key/settings', wrap((req, res) => {
  const store = publicByKey(req.params.key).cms;
  res.json(store.setSiteSettings({ ...store.siteSettings(), displayName: req.body?.displayName, description: req.body?.description }));
}));
creationRouter.put('/owned/:key/theme', wrap((req, res) => res.json(publicByKey(req.params.key).cms.setTheme(req.body?.theme))));
creationRouter.put('/owned/:key/rewards', wrap((req, res) => {
  const owner = creationOwner(req), symbol = req.body?.symbol;
  if (!['FTHX', 'FTH$'].includes(symbol) && creation.db.prepare('SELECT owner FROM note_currencies WHERE symbol=?').get(symbol)?.owner !== owner)
    throw Object.assign(new Error('Choose one of your own community notes.'), { status: 403 });
  res.json(notes.setProgram(req.params.key, req.body));
}));
creationRouter.get('/owned/:key/rewards', wrap((req, res) => res.json(notes.program(req.params.key))));
app.use('/api/creation', creationRouter);

function site(req) {
  if (locked && !siteManager && CONFIG.siteKey && req.params.key !== CONFIG.siteKey) throw notFound('Site not available');
  if (locked && siteManager && !siteManager.list().some((s) => s.key === req.params.key)) throw notFound('Site not available');
  const s = getSite(req.params.key);
  if (!s) throw notFound('Site not synced');
  return s;
}

// ---------- public site ----------
function publicSite(req) {
  let key;
  if (siteManager) {
    const sites = siteManager.list();
    if (req.cmsAuthorized && req.query.site) key = sites.find((s) => s.key === req.query.site)?.key;
    else key = req.hostedSite?.key || sites.find((s) => !s.path && s.hostname === hostName(req))?.key ||
      (localRequest(req) || hostName(req) === CONFIG.cmsHost ? CONFIG.siteKey : null);
  } else {
    key = CONFIG.siteKey || listLibrary().find((m) => m.status === 'ready')?.key;
  }
  return publicByKey(key);
}
function publicByKey(key) {
  const s = key && getSite(key);
  if (!s || !s.hasDb) throw notFound('No public data available');
  let cached = publicCache.get(key);
  if (!cached || cached.site !== s) {
    if (cached) cached.close();
    const managed = siteManager?.list().find((record) => record.key === key);
    cached = new PublicSite(s, {
      brand: managed?.hostname || CONFIG.publicBrand,
      tagline: key === CONFIG.siteKey ? CONFIG.publicTagline : null,
      notesFile: notes.file,
    });
    publicCache.set(key, cached);
  }
  return cached;
}
// Analytics: page hits and on-site searches (the visitor id comes from the browser's localStorage).
const visitorOf = (req) => String(req.get('x-visitor') || '').slice(0, 64);
function logSearch(req, place, q, total) {
  try { publicSite(req).analytics.search(visitorOf(req), place, q, total); } catch (e) { console.error(e); }
}
app.post('/api/public/hit', wrap((req, res) => res.json(publicSite(req).analytics.hit(req.body || {}, { userAgent: req.get('user-agent'), host: req.get('host') }))));
app.get('/api/public/info', wrap((req, res) => {
  const info = publicSite(req).info({ counts: req.query.bootstrap !== '1' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...info, ageGate: info.siteSettings.ageGate ?? CONFIG.ageGate !== false });
}));
app.get('/api/public/sites', wrap((req, res) => {
  const selected = publicSite(req);
  const base = siteManager?.records.find(site => site.key === selected.site.key && site.hostname === 'sites.featheral.com' && !site.path);
  if (!base) throw notFound('Website directory not available');
  res.json({ sites: siteManager.records.filter(site => site.hostname === base.hostname && site.path).map(site => {
    const store = new CmsStore(path.join(DATA_DIR, site.key, 'cms.sqlite'));
    try {
      const settings = store.siteSettings();
      const home = store.publishedPage(settings.homeSlug);
      return home ? { name: settings.displayName || site.name, path: site.path + '/', description: settings.description,
        noteSymbol: creation?.db.prepare("SELECT symbol FROM note_sites WHERE site=?").get(site.key)?.symbol || null } : null;
    } finally { store.close(); }
  }).filter(Boolean) });
}));
app.get('/api/public/feed', wrap((req, res) => res.json(publicSite(req).feed(req.query))));
app.get('/api/public/texts', wrap((req, res) => {
  const r = publicSite(req).textList(req.query);
  if (req.query.q && r.page === 1) logSearch(req, 'read', req.query.q, r.total);
  res.json(r);
}));
app.get('/api/public/texts/by-slug/:slug', wrap((req, res) => {
  const t = publicSite(req).textBySlug(req.params.slug);
  if (!t) throw notFound('Page not found');
  res.json(t);
}));
app.get('/api/public/texts/:id', wrap((req, res) => {
  const t = publicSite(req).text(req.params.id);
  if (!t) throw notFound('Text not found');
  res.json(t);
}));
app.post('/api/public/vote', wrap((req, res) => {
  const { id, type, vote } = req.body || {};
  res.json(publicSite(req).vote(id, String(type || ''), vote, walletToken(req)));
}));
app.get('/api/public/round', wrap((req, res) => res.json(publicSite(req).status(String(req.query.type || '')))));
app.post('/api/public/round', wrap((req, res) => res.json(publicSite(req).nextRound(String(req.body?.type || '')))));
app.post('/api/public/import', wrap((req, res) => res.json(publicSite(req).importVotes(req.body?.votes))));
app.get('/api/public/liked', wrap((req, res) => res.json(publicSite(req).liked(req.query))));
app.get('/api/public/thumbs', wrap((req, res) => res.json(publicSite(req).thumbList(req.query))));
app.get('/api/public/trending', wrap((req, res) => {
  const r = publicSite(req).trending(req.query);
  if (r.q && !r.offset) logSearch(req, 'trending', r.q, r.total);
  res.json(r);
}));
app.get('/api/public/trending/tags', wrap((req, res) => res.json(publicSite(req).tagList(req.query))));
app.post('/api/public/thumbs/seen', wrap((req, res) => res.json(publicSite(req).thumbsSeen(req.body?.round))));
const walletToken = (req) => req.get('x-wallet-token') || '';
const demoAccount = (req) => {
  const p = publicSite(req);
  return { economy: p.economy, address: p.walletOf(walletToken(req), 'use this demo') };
};
app.use('/api/public/demo', (req, res, next) => {
  if (hostName(req) === 'ex.featheral.com' && !req.hostedSite)
    return res.status(410).json({ error: 'Exchange demo balances and faucet are retired. Connect to the real FTHX wallet instead.' });
  next();
});
app.get('/api/public/demo/account', wrap((req, res) => {
  const { economy, address } = demoAccount(req);
  res.json(economy.account(address));
}));
app.post('/api/public/demo/faucet', wrap((req, res) => {
  const { economy, address } = demoAccount(req);
  res.json(economy.faucet(address, req.body));
}));
app.use('/api/public/exchange', (req, res, next) => {
  if (hostName(req) === 'ex.featheral.com' && !req.hostedSite)
    return res.status(410).json({ error: 'Exchange demo endpoints are retired on Featheral Exchange. Use the real FTHX /api/creation/markets APIs.' });
  next();
});
app.get('/api/public/exchange/pools', wrap((req, res) => res.json(publicSite(req).economy.pools())));
app.post('/api/public/exchange/quote', wrap((req, res) => res.json(publicSite(req).economy.quote(req.body))));
for (const [route, method] of [['swap', 'swap'], ['pools', 'createPool'], ['liquidity/add', 'addLiquidity'], ['liquidity/remove', 'removeLiquidity']]) {
  app.post(`/api/public/exchange/${route}`, wrap((req, res) => {
    const { economy, address } = demoAccount(req);
    res.json(economy[method](address, req.body));
  }));
}
app.get('/api/public/shop/products', wrap((req, res) => res.json(publicSite(req).economy.products())));
app.post('/api/public/shop/checkout', wrap((req, res) => {
  const { economy, address } = demoAccount(req);
  res.status(201).json(economy.checkout(address, req.body));
}));
app.get('/api/public/shop/orders', wrap((req, res) => {
  const { economy, address } = demoAccount(req);
  res.json(economy.orders(address));
}));
app.post('/api/public/wallet/nonce', wrap((req, res) => res.json(publicSite(req).walletNonce(req.body?.address))));
app.post('/api/public/wallet/login', wrap((req, res) => res.json(publicSite(req).walletLogin(req.body?.address, req.body?.signature))));
app.get('/api/public/wallet/me', wrap((req, res) => res.json(publicSite(req).walletMe(walletToken(req)))));
app.post('/api/public/wallet/logout', wrap((req, res) => res.json(publicSite(req).walletLogout(walletToken(req)))));
app.get('/api/public/wallet/ledger', wrap((req, res) => res.json(publicSite(req).ledger(walletToken(req), req.query))));
app.post('/api/public/wallet/deposit/request', wrap((req, res) => res.json(publicSite(req).depositRequest(walletToken(req), req.body?.amount))));
app.post('/api/public/wallet/deposit', wrap((req, res) => res.json(publicSite(req).deposit(walletToken(req), req.body?.signature))));
app.post('/api/public/posts/:id/tip', wrap((req, res) => res.json(publicSite(req).tip(req.params.id, walletToken(req), req.body?.amount))));
// New member post: the body is the (browser-compressed) JPEG or GIF; text fields come in the query.
const rawImage = (req, res, next) => express.raw({ type: () => true, limit: operationsSettings.value.uploadLimitMiB * 1024 ** 2 })(req, res, next);
app.post('/api/public/posts', (req, res, next) => rawImage(req, res, (err) => {
  if (!err) return next();
  fail(res, Object.assign(new Error(err.type === 'entity.too.large' ? `Upload exceeds the configured ${operationsSettings.value.uploadLimitMiB} MiB limit.` : err.message), { status: err.status || 400 }));
}), wrap((req, res) => {
  const { title, description, source, video } = req.query;
  res.json(publicSite(req).createPost(walletToken(req), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { title, description, source, video }));
}));
// Downloads the image behind a link for the post form; the browser previews and compresses it.
app.post('/api/public/fetch-link', wrap(async (req, res) => {
  const r = await publicSite(req).fetchLink(walletToken(req), req.body?.url);
  res.set({ 'Content-Type': r.mime, 'Cache-Control': 'no-store', 'X-Image-Url': encodeURIComponent(r.imageUrl), 'X-Page-Url': encodeURIComponent(r.pageUrl), 'X-Page-Title': encodeURIComponent(r.title || ''), 'X-Video': r.video || '' });
  res.send(r.data);
}));
app.get('/api/public/posts/:id/comments', wrap((req, res) => res.json(publicSite(req).comments(req.params.id))));
app.post('/api/public/posts/:id/view', wrap((req, res) => res.json(publicSite(req).view(req.params.id, req.body?.visitor))));
app.post('/api/public/posts/:id/comments', wrap((req, res) => res.json(publicSite(req).addComment(req.params.id, walletToken(req), req.body?.content))));
app.delete('/api/public/comments/:id', wrap((req, res) => res.json(publicSite(req).deleteComment(req.params.id, walletToken(req)))));

// Curation trash, managed from the admin site.
function publicFor(req) {
  const selected = site(req);
  return publicByKey(selected.key);
}
app.get('/api/sets/:key/cms/settings', wrap((req, res) => res.json(publicFor(req).cms.siteSettings())));
app.put('/api/sets/:key/cms/settings', wrap((req, res) => res.json(publicFor(req).cms.setSiteSettings(req.body))));
app.get('/api/sets/:key/shop/products', wrap((req, res) => res.json(publicFor(req).economy.products(true))));
app.post('/api/sets/:key/shop/products', wrap((req, res) => res.status(201).json(publicFor(req).economy.saveProduct(req.body))));
app.put('/api/sets/:key/shop/products/:id', wrap((req, res) => res.json(publicFor(req).economy.saveProduct(req.body, Number(req.params.id)))));
app.get('/api/sets/:key/shop/orders', wrap((req, res) => res.json(publicFor(req).economy.orders())));
app.get('/api/sets/:key/analytics', wrap((req, res) => res.json(publicFor(req).analyticsReport(req.query))));
app.get('/api/sets/:key/trash', wrap((req, res) => res.json(publicFor(req).trashList(req.query))));
app.get('/api/sets/:key/duplicates', wrap(async (req, res) => res.json(await publicFor(req).dedupe())));
app.post('/api/sets/:key/duplicates', wrap(async (req, res) => res.json(await publicFor(req).dedupe({ apply: true }))));
app.post('/api/sets/:key/trash/:id/restore', wrap((req, res) => res.json(publicFor(req).restore(req.params.id))));
app.post('/api/sets/:key/trash/empty', wrap((req, res) => {
  const p = publicFor(req);
  const result = p.emptyTrash();
  // The database and uploads index changed on disk, so reload the site from scratch.
  invalidateSite(req.params.key);
  res.json(result);
}));

// CMS-managed content is stored separately so editing never mutates the imported WordPress snapshot.
app.get('/api/sets/:key/cms/content', cmsAuth, wrap((req, res) => res.json(publicFor(req).cms.list({
  q: String(req.query.q || '').slice(0, 200),
  status: ['draft', 'publish'].includes(String(req.query.status)) ? String(req.query.status) : '',
  summary: req.query.summary === '1',
}))));
app.post('/api/sets/:key/cms/content', cmsAuth, wrap((req, res) => res.status(201).json(publicFor(req).cms.save(req.body))));
app.post('/api/sets/:key/cms/content/:id/duplicate', wrap((req, res) => res.status(201).json(publicFor(req).cms.duplicate(req.params.id))));
app.get('/api/sets/:key/cms/content/:id/revisions', wrap((req, res) => res.json(publicFor(req).cms.revisions(req.params.id))));
app.post('/api/sets/:key/cms/content/:id/restore', wrap((req, res) => res.json(publicFor(req).cms.restore(req.params.id, req.body?.revisionId, req.body?.revision))));
app.get('/api/sets/:key/cms/content/:id', cmsAuth, wrap((req, res) => {
  const post = publicFor(req).cms.get(req.params.id);
  if (!post) throw notFound('CMS content not found');
  res.json(post);
}));
app.put('/api/sets/:key/cms/content/:id', cmsAuth, wrap((req, res) => res.json(publicFor(req).cms.save(req.body, req.params.id))));
app.delete('/api/sets/:key/cms/content/:id', cmsAuth, wrap((req, res) => res.json(publicFor(req).cms.delete(req.params.id))));
app.get('/api/sets/:key/cms/theme', cmsAuth, wrap((req, res) => res.json({ theme: publicFor(req).cms.theme(), themes: CmsStore.THEMES })));
app.put('/api/sets/:key/cms/theme', cmsAuth, wrap((req, res) => res.json(publicFor(req).cms.setTheme(req.body?.theme))));

// ---------- config, connect & sync ----------
app.get('/api/config', cmsAuth, (req, res) => res.json({
  brand: CONFIG.brand, siteKey: CONFIG.siteKey, locked, cmsHost: CONFIG.cmsHost, publicHost: CONFIG.publicHost,
  ...(siteManager ? { siteManagement: true } : {}),
}));
app.get('/api/library', cmsAuth, wrap((req, res) => {
  const managed = siteManager?.list() || [];
  if (siteManager && locked) return res.json(managed);
  const byKey = new Map(managed.map((s) => [s.key, s]));
  res.json(listLibrary().filter((m) => siteManager || !locked || !CONFIG.siteKey || m.key === CONFIG.siteKey)
    .map((m) => byKey.get(m.key) || m));
}));
app.get('/api/sites', wrap((req, res) => {
  if (!siteManager) return res.status(403).json({ error: 'Site management is disabled' });
  const managed = siteManager.list().map(site => {
    const store = new CmsStore(path.join(DATA_DIR, site.key, 'cms.sqlite'));
    try {
      const settings = store.siteSettings();
      const tagline = settings.description || (site.key === CONFIG.siteKey ? CONFIG.publicTagline : '')
        || T.decodeEntities(getSite(site.key).options(['blogdescription']).blogdescription || '')
        || store.publishedPage(settings.homeSlug)?.excerpt || '';
      const core = ['x', 'ex', 'stats', 'sites', 'notes'].find(name => site.hostname === `${name}.featheral.com`);
      return { ...site, cmsCompatible: true, contentEditable: true, management: 'cms',
        tagline, favicon: core ? `/shared/logo-${core}.svg` : '/site/logo.svg' };
    }
    finally { store.close(); }
  });
  res.json([...sitePages.catalog().filter((site) => !managed.some((record) => record.hostname === site.hostname && !record.path))
    .map(site => ({ ...site, ...sitePages.presentation(site.hostname) })), ...managed]
    .map(site => ({ ...site, managementLinks: require('./lib/site-management').managementFor(site) })));
}));
app.get('/api/notes', wrap((req, res) => res.json(notes.summary())));
function notesLedgerCurrencies() {
  const db = notes.db;
  const isNotesSymbol = symbol => symbol !== 'FTH$' && symbol !== 'FTHG' && !/^FTH[^A-Z0-9]$/.test(symbol);
  const names = new Map([['FTHX', 'Featheral Exchange Token'], ['FTHS', 'Featheral Silver']]);
  const placeholders = new Set();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_currencies','note_markets')").all().map(row => row.name));
  if (tables.has('note_currencies')) {
    for (const row of db.prepare('SELECT symbol,name FROM note_currencies').all()) names.set(row.symbol, row.name);
  }
  if (tables.has('note_markets')) {
    for (const row of db.prepare('SELECT symbol,placeholder FROM note_markets').all()) {
      if (!isNotesSymbol(row.symbol)) continue;
      if (row.placeholder) placeholders.add(row.symbol);
      if (!names.has(row.symbol)) names.set(row.symbol, row.symbol);
    }
  }
  for (const row of db.prepare("SELECT symbol FROM notes_currency_symbols WHERE symbol NOT IN ('FTH$','FTHG')").all()) {
    if (isNotesSymbol(row.symbol) && !names.has(row.symbol)) names.set(row.symbol, row.symbol);
  }
  for (const symbol of names.keys()) if (!isNotesSymbol(symbol)) names.delete(symbol);
  return [...names].map(([symbol, name]) => ({
    symbol, name, kind: placeholders.has(symbol) ? 'reserved-placeholder'
      : symbol === 'FTHX' ? 'global-credit' : symbol === 'FTHS' ? 'approved-work-credit' : 'community-note',
  })).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
app.get('/api/notes/ledger/currencies', wrap((req, res) => {
  res.set('Cache-Control', 'no-store').json({ currencies: notesLedgerCurrencies() });
}));
app.get('/api/notes/ledger/:symbol/entries', wrap((req, res) => {
  const symbol = req.params.symbol;
  const currency = notesLedgerCurrencies().find(item => item.symbol === symbol);
  if (!currency) throw Object.assign(new Error('Unknown Notes currency'), { status: 404 });
  const parseBoundedInteger = (value, name, fallback, maximum) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
      throw Object.assign(new Error(`${name} must be a whole number from 1 to ${maximum}`), { status: 400 });
    return Number(value);
  };
  const limit = parseBoundedInteger(req.query.limit, 'limit', 50, 100);
  const before = parseBoundedInteger(req.query.before, 'before', undefined, Number.MAX_SAFE_INTEGER);
  const address = req.query.address;
  if (address !== undefined && (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)))
    throw Object.assign(new Error('address must be a valid Ethereum wallet address'), { status: 400 });
  const clauses = ['symbol=?'], params = [currency.symbol];
  if (address !== undefined) { clauses.push('address=?'); params.push(address.toLowerCase()); }
  if (before !== undefined) { clauses.push('id<?'); params.push(before); }
  params.push(limit + 1);
  const rows = notes.db.prepare(`SELECT id,address,amount,kind,post_id,other,at,site,symbol FROM notes_entries
    WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  res.set('Cache-Control', 'no-store').json({
    currency, entries: rows, hasMore, nextBefore: hasMore ? rows[rows.length - 1].id : null,
  });
}));
app.get('/api/notes/sites', wrap((req, res) => {
  if (!siteManager) throw Object.assign(new Error('Site management is disabled'), { status: 403 });
  res.json(siteManager.list().map(site => ({ ...site, program: notes.program(site.key) })));
}));
app.put('/api/notes/sites/:key/rewards', wrap((req, res) => {
  if (!siteManager?.records.some(site => site.key === req.params.key)) throw notFound('Unknown reward site');
  res.json(notes.setProgram(req.params.key, req.body));
}));
app.post('/api/notes/sites', wrap((req, res) => {
  res.status(410).json({ error: 'Create websites on sites.featheral.com with your wallet. Creation costs 500 FTH$.' });
}));
app.get('/api/notes/wallets/:address', wrap((req, res) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) throw Object.assign(new Error('Invalid wallet address'), { status: 400 });
  res.json({ address: req.params.address, balances: notes.db.prepare('SELECT symbol,SUM(amount) AS amount FROM notes_entries WHERE address=? GROUP BY symbol')
    .all(req.params.address.toLowerCase()) });
}));
app.get('/api/notes/markets', wrap((req, res) => {
  if (!creation) throw Object.assign(new Error('Note markets require site management to be enabled.'), { status: 503 });
  res.json({ markets: creation.markets.catalog(Date.now(), true), treasuryFthx: notes.balance(require('../notes/game-funds').SYSTEM_TREASURY_ACCOUNT) });
}));
app.post('/api/notes/markets/:symbol/fund', wrap((req, res) => {
  if (!creation) throw Object.assign(new Error('Note markets require site management to be enabled.'), { status: 503 });
  res.json(creation.markets.fund(req.params.symbol, req.body?.approval));
}));
app.get('/api/deployment/status', wrap((req, res) => res.json(deployment.status())));
app.post('/api/deployment/plan', wrap((req, res) => {
  if (!req.get('origin') || new URL(req.get('origin')).host !== req.get('host')) throw Object.assign(new Error('Same-origin deployment requests are required'), { status: 403 });
  res.json(deployment.plan(req.body));
}));
app.post('/api/deployment/start', wrap((req, res) => {
  if (!req.get('origin') || new URL(req.get('origin')).host !== req.get('host')) throw Object.assign(new Error('Same-origin deployment requests are required'), { status: 403 });
  if (serverUsers.changing) throw Object.assign(new Error('A server password change is running. Wait before deploying.'), { status: 409 });
  res.status(202).json(deployment.launch(req.body));
}));
app.get('/api/sites/:hostname/pages', wrap((req, res) => res.json({ pages: sitePages.pages(req.params.hostname), ...sitePages.theme(req.params.hostname) })));
app.put('/api/sites/:hostname/pages/:id', wrap((req, res) => res.json(sitePages.save(req.params.hostname, req.params.id, req.body))));
app.put('/api/sites/:hostname/theme', wrap((req, res) => res.json(sitePages.theme(req.params.hostname, req.body?.theme))));
app.post('/api/sites', wrap((req, res) => {
  res.status(410).json({ error: 'New websites can only be created through sites.featheral.com for 500 FTH$.' });
}));
const syncDisabled = (req, res, next) => (locked
  ? res.status(403).json({ error: 'Loading sites is disabled: this is local software running on its stored data.' })
  : next());
app.post('/api/connect', syncDisabled, cmsAuth);
app.post('/api/sync', syncDisabled, cmsAuth);
app.post('/api/job/cancel', syncDisabled, cmsAuth);
app.delete('/api/sets/:key', syncDisabled);

app.post('/api/connect', wrap(async (req, res) => {
  const { url, username, appPassword } = req.body || {};
  const r = await probe({ url, username, appPassword });
  r.existing = listLibrary().find((m) => m.key === r.key) || null;
  res.json(r);
}));

app.post('/api/sync', wrap((req, res) => {
  const { url, username, appPassword, media, concurrency, limit } = req.body || {};
  if (!url) throw new Error('Site URL is required');
  res.json(jobs.start({ url, username, appPassword, media, concurrency, limit }));
}));

app.get('/api/job', cmsAuth, (req, res) => res.json(jobs.status()));
app.post('/api/job/cancel', cmsAuth, (req, res) => { jobs.cancel(); res.json(jobs.status()); });

app.delete('/api/sets/:key', wrap((req, res) => {
  if (jobs.status()?.state === 'running' && jobs.status().key === req.params.key) throw new Error('Sync in progress');
  if (siteManager?.list().some((s) => s.key === req.params.key)) {
    return res.status(403).json({ error: 'Deleting managed sites is not supported' });
  }
  invalidateSite(req.params.key);
  fs.rmSync(setDir(req.params.key), { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---------- explorer API ----------
app.get('/api/sets/:key/overview', wrap((req, res) => {
  const overview = site(req).overview();
  const managed = siteManager?.list().find((s) => s.key === req.params.key);
  res.json(managed ? { ...overview, site: managed.name, siteUrl: managed.siteUrl, hostname: managed.hostname, managed: true } : overview);
}));
app.get('/api/sets/:key/types', wrap((req, res) => res.json(site(req).contentTypes())));
app.get('/api/sets/:key/posts', wrap((req, res) => res.json(site(req).posts(req.query))));
app.get('/api/sets/:key/posts/:id', wrap((req, res) => {
  const p = site(req).post(req.params.id);
  if (!p) throw notFound('Post not found');
  res.json(p);
}));
app.get('/api/sets/:key/media', wrap((req, res) => res.json(site(req).media(req.query))));
app.get('/api/sets/:key/media/:id', wrap((req, res) => {
  const m = site(req).mediaItem(req.params.id);
  if (!m) throw notFound('Attachment not found');
  res.json(m);
}));
app.get('/api/sets/:key/taxonomies', wrap((req, res) => res.json(site(req).taxonomies())));
app.get('/api/sets/:key/menus', wrap((req, res) => res.json(site(req).menus())));
app.get('/api/sets/:key/comments', wrap((req, res) => res.json(site(req).comments(req.query))));
app.get('/api/sets/:key/users', wrap((req, res) => res.json(site(req).users())));
app.get('/api/sets/:key/stats', wrap((req, res) => res.json(site(req).stats())));
app.get('/api/sets/:key/addons', wrap((req, res) => {
  const s = site(req);
  const ov = s.hasDb ? s.options(['active_plugins', 'template', 'stylesheet']) : {};
  const active = new Set(Array.isArray(ov.active_plugins) ? ov.active_plugins : Object.values(ov.active_plugins || {}));
  res.json({
    plugins: s.addons.plugins.map((p) => ({ ...p, active: p.active ?? active.has(p.slug) })),
    themes: s.addons.themes.map((t) => ({ ...t, active: t.active ?? t.slug === ov.stylesheet, parentActive: t.slug === ov.template && ov.template !== ov.stylesheet })),
    muPlugins: s.addons.muPlugins,
  });
}));
app.get('/api/sets/:key/tables', wrap((req, res) => res.json({ prefix: site(req).prefix, tables: site(req).tables() })));
app.get('/api/sets/:key/tables/:name', wrap((req, res) => {
  const r = site(req).tableRows(req.params.name, req.query);
  if (!r) throw notFound('Table not found');
  r.schema = site(req).tableSchema(req.params.name);
  res.json(r);
}));
// ---------- exports ----------
function sendDownload(res, name, type, body) {
  res.attachment(name);
  res.type(type);
  res.send(body);
}

function postText(r) {
  return [
    r.title || '(no title)', `ID: ${r.id}`, `Type: ${r.type}`, `Status: ${r.status}`,
    `Date: ${r.date}`, `Author: ${r.author}`, `URL: ${r.url}`, '',
    ...(r.excerpt ? ['Excerpt:', r.excerpt, ''] : []),
    'Content:', r.text, '',
  ].join('\n');
}

app.get('/api/sets/:key/export/:name', wrap(async (req, res) => {
  const s = site(req);
  const slug = (s.manifest.site || 'site').replace(/[^\w-]+/g, '-').toLowerCase();
  const name = req.params.name;
  const base = `${slug}-${s.key}`;
  const q = req.query;
  switch (name) {
    case 'posts.txt': {
      res.attachment(`${base}-posts.txt`);
      res.type('text/plain; charset=utf-8');
      let first = true;
      for (const r of s.exportPosts(q)) {
        const separator = first ? '' : '\n' + '='.repeat(80) + '\n\n';
        if (!res.write(separator + postText(r))) await once(res, 'drain');
        first = false;
      }
      return res.end();
    }
    case 'posts-text.zip': {
      const zip = new yazl.ZipFile();
      res.attachment(`${base}-posts-text.zip`);
      res.type('application/zip');
      zip.outputStream.on('error', (e) => fail(res, e));
      zip.outputStream.pipe(res);
      for (const r of s.exportPosts(q)) {
        zip.addBuffer(Buffer.from(postText(r), 'utf8'), `posts/${r.id}.txt`);
      }
      return zip.end();
    }
    case 'posts.json': {
      const rows = [...s.exportPosts(q)];
      return sendDownload(res, `${base}-posts.json`, 'application/json', JSON.stringify(rows, null, 2));
    }
    case 'posts.csv': {
      const rows = [...s.exportPosts(q)].map((r) => ({ ...r, categories: r.categories.join('|'), tags: r.tags.join('|'), images: r.images.join('|'), taxonomies: JSON.stringify(r.taxonomies), html: undefined }));
      const cols = ['id', 'type', 'status', 'date', 'modified', 'title', 'slug', 'author', 'url', 'parent', 'categories', 'tags', 'taxonomies', 'excerpt', 'featured_image', 'images', 'word_count', 'text'];
      return sendDownload(res, `${base}-posts.csv`, 'text/csv', T.toCsv(rows, cols));
    }
    case 'corpus.jsonl': {
      res.attachment(`${base}-corpus.jsonl`);
      res.type('application/x-ndjson');
      for (const r of s.exportPosts(q)) {
        const { html, ...rest } = r;
        res.write(JSON.stringify(rest) + '\n');
      }
      return res.end();
    }
    case 'posts-markdown.zip': {
      const zip = new yazl.ZipFile();
      res.attachment(`${base}-markdown.zip`);
      res.type('application/zip');
      zip.outputStream.pipe(res);
      const used = new Set();
      for (const r of s.exportPosts(q)) {
        let fname = `${r.type}/${(r.date || '').slice(0, 10)}-${(r.slug || 'post-' + r.id).slice(0, 80)}.md`;
        if (used.has(fname)) fname = fname.replace(/\.md$/, `-${r.id}.md`);
        used.add(fname);
        const fm = ['---', `id: ${r.id}`, `title: ${JSON.stringify(r.title)}`, `type: ${r.type}`, `status: ${r.status}`, `date: ${r.date}`, `author: ${JSON.stringify(r.author)}`,
          `slug: ${r.slug}`, `categories: ${JSON.stringify(r.categories)}`, `tags: ${JSON.stringify(r.tags)}`, `featured_image: ${r.featured_image ? JSON.stringify('uploads/' + r.featured_image) : 'null'}`, `word_count: ${r.word_count}`, '---', ''];
        const md = T.htmlToMarkdown(s.autop(r.html)).replace(/(?:https?:)?\/\/[^\s"'()<>]+?\/wp-content\/uploads\//gi, '../uploads/');
        zip.addBuffer(Buffer.from(fm.join('\n') + `# ${r.title}\n\n` + md + '\n'), fname);
      }
      zip.addBuffer(Buffer.from(`Exported from ${s.manifest.siteUrl || s.manifest.site} via the WordPress REST API (synced ${s.manifest.syncedAt}).\nImage links point to ../uploads/ — combine with media-originals.zip.\n`), 'README.txt');
      return zip.end();
    }
    case 'media.json':
    case 'media.csv': {
      const atts = s.hasDb ? s.attachments() : [];
      const rows = atts.length
        ? atts.map((a) => ({ id: a.id, title: a.title, file: a.file, local_path: a.exists ? path.join(s.dir, 'uploads', a.file) : null, exists: a.exists, mime: a.mime, width: a.width, height: a.height, filesize: a.filesize, alt: a.alt, caption: a.caption, description: a.description, date: a.date, parent_id: a.parent || null, sizes: a.sizes.map((x) => x.name).join('|'), exif: a.exif }))
        : s.index.filter((x) => !x.variantOf).map((x) => ({ file: x.path, local_path: path.join(s.dir, 'uploads', x.path), ext: x.ext, width: x.width, height: x.height, filesize: x.size, mtime: x.mtime }));
      if (name === 'media.json') return sendDownload(res, `${base}-media.json`, 'application/json', JSON.stringify(rows, null, 2));
      return sendDownload(res, `${base}-media.csv`, 'text/csv', T.toCsv(rows));
    }
    case 'media-originals.zip': {
      const zip = new yazl.ZipFile();
      res.attachment(`${base}-media-originals.zip`);
      res.type('application/zip');
      zip.outputStream.pipe(res);
      const all = q.all === '1';
      for (const x of s.index) {
        if (!all && (x.variantOf || !x.image)) continue;
        zip.addFile(path.join(s.dir, 'uploads', x.path), 'uploads/' + x.path, { compress: !x.image });
      }
      return zip.end();
    }
    case 'taxonomies.json': return sendDownload(res, `${base}-taxonomies.json`, 'application/json', JSON.stringify(s.taxonomies(), null, 2));
    case 'menus.json': return sendDownload(res, `${base}-menus.json`, 'application/json', JSON.stringify(s.menus(), null, 2));
    case 'comments.csv': {
      const all = s.comments({ limit: 1e9 }).items;
      return sendDownload(res, `${base}-comments.csv`, 'text/csv', T.toCsv(all.map((c) => ({ ...c, text: T.htmlToText(c.content) }))));
    }
    case 'users.csv': return sendDownload(res, `${base}-users.csv`, 'text/csv', T.toCsv(s.users().map((u) => ({ ...u, roles: (u.roles || []).join('|') }))));
    case 'stats.json': return sendDownload(res, `${base}-stats.json`, 'application/json', JSON.stringify(s.stats(), null, 2));
    case 'uploads-index.csv': return sendDownload(res, `${base}-uploads-index.csv`, 'text/csv', T.toCsv(s.index));
    default: throw notFound('Unknown export');
  }
}));

// ---------- downloaded media (falls back to the live site for files not downloaded) ----------
app.use('/media/:key', (req, res, next) => {
  if (locked && !siteManager && CONFIG.siteKey && req.params.key !== CONFIG.siteKey) return res.sendStatus(404);
  if (siteManager && !req.cmsAuthorized && !localRequest(req)) {
    const selected = req.hostedSite || siteManager.list().find((s) => s.hostname === hostName(req) &&
      (hostName(req) === 'sites.featheral.com' ? s.key === req.params.key : !s.path));
    if (!selected || selected.key !== req.params.key) return res.sendStatus(404);
  }
  let dir;
  try { dir = path.join(setDir(req.params.key), 'uploads'); } catch { return res.sendStatus(400); }
  express.static(dir, {
    fallthrough: true, index: false, dotfiles: 'deny', maxAge: '7d',
    setHeaders: (r, p) => { if (/\.(svg|html?|xml)$/i.test(p)) r.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"); },
  })(req, res, () => {
    if (locked) return res.sendStatus(404);
    const s = getSite(req.params.key);
    const base = s && s.manifest.uploadsBase;
    if (!base || req.method !== 'GET' || req.path.includes('..')) return res.sendStatus(404);
    res.redirect(302, base.replace(/\/+$/, '') + req.path);
  });
});

app.get(/^\/admin(\/.*)?$/, (req, res) => {
  if (hostName(req) !== String(CONFIG.cmsHost).toLowerCase() && resolveHostname(req.hostname)) {
    const local = req.hostname.endsWith('.localhost');
    const port = new URL(`http://${req.get('host')}`).port;
    return res.redirect(302, local ? `http://admin.localhost${port ? `:${port}` : ''}/` : `https://${CONFIG.cmsHost}/`);
  }
  res.type('html').send(sitePages.render('admin.featheral.com', 'index.html'));
});
app.get(/^\/(?!api|media).*/, (req, res) => {
  if (siteManager && !localRequest(req) && hostName(req) !== CONFIG.cmsHost &&
      !siteManager.list().some((s) => s.hostname === hostName(req))) return res.sendStatus(404);
  if (hostName(req) === String(CONFIG.cmsHost).toLowerCase() && !req.query.site)
    return res.type('html').send(sitePages.render('admin.featheral.com', 'index.html'));
  if (hostName(req) === 'notes.featheral.com')
    return res.sendFile(path.join(sitesRoot, 'notes.featheral.com', 'index.html'));
  const preview = req.cmsAuthorized && req.query.site ? siteManager?.records.find(site => site.key === req.query.site) : null;
  if (['notes.featheral.com', 'ex.featheral.com'].includes(preview?.hostname)) {
    const port = new URL(`http://${req.get('host')}`).port;
    const label = preview.hostname.split('.')[0];
    return res.redirect(302, req.hostname.endsWith('.localhost') || localRequest(req)
      ? `http://${label}.localhost${port ? `:${port}` : ''}/` : `https://${preview.hostname}/`);
  }
  if (hostName(req) === 'sites.featheral.com' || preview?.hostname === 'sites.featheral.com') {
    const html = fs.readFileSync(path.join(sitesRoot, 'sites.featheral.com', 'index.html'), 'utf8');
    const selected = preview || req.hostedSite;
    const base = preview ? '' : selected?.path || '';
    return res.type('html').send(html.replace('<!-- SITE_CONTEXT -->',
      `<meta name="site-base" content="${base}"><meta name="site-key" content="${selected?.key || 'sites-featheral-com'}"><meta name="site-directory" content="${selected?.path ? 'false' : 'true'}">`));
  }
  const frontendHost = preview?.hostname || hostName(req);
  if (['ex.featheral.com', 'stats.featheral.com'].includes(frontendHost))
    return res.sendFile(path.join(sitesRoot, frontendHost, 'index.html'));
  res.sendFile(path.join(publicFrontend, 'index.html'));
});

app.resolveHostname = resolveHostname;
app.renderSitePage = (hostname, file) => sitePages.render(hostname, file);
app.hasSitePage = (hostname, file) => sitePages.templates(hostname).includes(file);
app.close = () => {
  app.serverProfile?.close();
  telemetry.close();
  sitePages.close();
  for (const cached of publicCache.values()) cached.close();
  publicCache.clear();
  notes.close();
  for (const site of listLibrary()) dropSite(site.key);
  database.sqlite.closeAll();
};
if (siteManager) for (const record of siteManager.records) publicByKey(record.key);
notes.validateBalances();
module.exports = app;
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => console.log(
    `CMS: https://${CONFIG.cmsHost}/ · Public media site: https://${CONFIG.publicHost}/ · Local: http://${HOST}:${PORT}/admin and http://${HOST}:${PORT}/`,
  ));
  configureServer(server, operationsSettings);
  const shutdown = () => server.close(() => { app.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
