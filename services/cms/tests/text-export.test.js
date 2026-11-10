const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { open } = require('../../database/sqlite');
const { inflateRawSync } = require('node:zlib');
const { test } = require('node:test');
const express = require('express');
const { DATA_DIR, writeJson } = require('../lib/store');
const { dropSite } = require('../lib/wp');

// Node fetch does not preserve overridden Host headers; hostname routing needs raw HTTP.
function fetchWithHost(url, options = {}) {
  if (!options.headers?.Host) return globalThis.fetch(url, options);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { ...options, headers: { ...options.headers,
      ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body) } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject); request.end(options.body);
  });
}
const fetch = fetchWithHost;

function readZip(buffer) {
  let end = buffer.length - 22;
  while (buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const files = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    files.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function startServer(t, config, cmsPassword, registryFile) {
  const adminWallet = require("ethers").Wallet.createRandom();
  const pageData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cms-page-data-'));
  const configFile = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'admin-config-')), 'admin.config.json');
  writeJson(configFile, config);
  const previous = process.env.ADMIN_CONFIG;
  process.env.ADMIN_CONFIG = configFile;
  let app;
  let siteManager;
  const factory = Object.assign(() => {
    app = express();
    app.listen = () => {};
    return app;
  }, express);
  const serverFile = path.join(__dirname, '..', 'server.js');
  const realRequire = createRequire(serverFile);
  const loadServer = vm.runInThisContext(`(function(require, __dirname, module) {\n${fs.readFileSync(serverFile, 'utf8')}\nreturn app.close;\n})`, { filename: serverFile });
  let closeCaches;
  try {
    closeCaches = loadServer(Object.assign((name) => {
      if (name === 'express') return factory;
      if (name === './lib/admin-auth') return { createAdminAuth: options => realRequire(name).createAdminAuth({ ...options, wallets: [adminWallet.address] }) };
      if (name === '../operations/configuration') return { assertDatabaseConfiguration() {} };
      if (name === '../operations/runtime') return {
        environment: () => ({ ADMIN_CONFIG_JSON: JSON.stringify(config) }),
        value: { networkLimitBytesPerSecond: 0, uploadLimitMiB: 16, requestTimeoutSeconds: 90 },
        listeners: new Set(), adminConfigured: () => Boolean(cmsPassword),
        authenticate: password => Boolean(cmsPassword) && password === cmsPassword,
      };
      if (name === '../notes/ledger') {
        const module = realRequire(name);
        return { ...module, Notes: class extends module.Notes {
          constructor() { super(path.join(pageData, 'notes.sqlite')); }
        } };
      }
      if (name === './lib/telemetry') {
        const telemetry = realRequire(name);
        return { ...telemetry, Telemetry: class extends telemetry.Telemetry {
          constructor() { super(':memory:'); }
        } };
      }
      if (name === './lib/site-pages') {
        const pages = realRequire(name);
        return { ...pages, SitePages: class extends pages.SitePages {
          constructor(options) { super({ ...options, dataDir: pageData }); }
        } };
      }
      if (name === './lib/sites' && registryFile) {
        const sites = realRequire(name);
        return { ...sites, SiteManager: class extends sites.SiteManager {
          constructor(options) { super({ ...options, registryFile }); siteManager = this; }
        } };
      }
      return realRequire(name);
    }, { resolve: realRequire.resolve }), path.dirname(serverFile), { exports: {} });
  } finally {
    if (previous === undefined) delete process.env.ADMIN_CONFIG; else process.env.ADMIN_CONFIG = previous;
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeCaches();
    fs.rmSync(pageData, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function signIn(host) {
    const headers = { Host: host, ...(host === 'admin.featheral.com' ? { 'X-Forwarded-Proto': 'https' } : {}), 'Content-Type': 'application/json' };
    const call = (route, body, cookie) => new Promise((resolve, reject) => {
      const request = http.request(base + '/api/admin-auth/' + route, { method: 'POST',
        headers: { ...headers, Origin: `${host === 'admin.featheral.com' ? 'https' : 'http'}://${host}`, ...(cookie ? { Cookie: cookie } : {}) } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
      });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
    const challenge = await call('challenge', { address: adminWallet.address });
    const login = await call('verify', { signature: await adminWallet.signMessage(challenge.body.message) }, challenge.headers['set-cookie'][0].split(';')[0]);
    assert.equal(login.status, 200);
    return { ...headers, Cookie: login.headers['set-cookie'].find(value => value.startsWith('featheral_admin=')).split(';')[0] };
  }
  return { base, app, auth: await signIn('admin.featheral.com'), localAuth: await signIn('admin.localhost'),
    notesFile: path.join(pageData, 'notes.sqlite'), provision: input => siteManager.create(input) };
}

test('public Notes ledger API lists currencies and uses bounded keyset pagination', async t => {
  const { base, notesFile } = await startServer(t, { siteManagement: true }, 'notes-ledger-test');
  const owner = require('ethers').Wallet.createRandom().address.toLowerCase();
  const db = open(notesFile);
  const addActivity = db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES (?,?,'fixture',?,'test','ART')");
  addActivity.run(owner, 3, 3000); addActivity.run(owner, -2, 2000); addActivity.run(owner, 1, 1000);
  db.close();
  const request = route => new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { headers: { Host: 'notes.featheral.com' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on('error', reject); req.end();
  });
  const currencies = await request('/api/notes/ledger/currencies');
  assert.equal(currencies.status, 200);
  assert.equal(currencies.headers['cache-control'], 'no-store');
  assert.ok(currencies.body.currencies.some(currency => currency.symbol === 'FTHX'));
  assert.ok(currencies.body.currencies.some(currency => currency.symbol === 'FTHS'));
  assert.ok(currencies.body.currencies.some(currency => currency.symbol === 'FTHA' && currency.kind === 'reserved-placeholder'));
  assert.ok(currencies.body.currencies.some(currency => currency.symbol === 'ART'));
  assert.ok(!currencies.body.currencies.some(currency => currency.symbol === 'FTH$'));
  const first = await request('/api/notes/ledger/ART/entries?limit=2');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.entries.map(entry => entry.amount), [1, -2]);
  assert.equal(first.body.hasMore, true);
  const accountActivity = await request(`/api/notes/ledger/ART/entries?address=${owner}`);
  assert.equal(accountActivity.body.entries.length, 3);
  const older = await request(`/api/notes/ledger/ART/entries?limit=2&before=${first.body.nextBefore}`);
  assert.deepEqual(older.body.entries.map(entry => entry.amount), [3]);
  assert.equal(older.body.hasMore, false);
  assert.equal((await request('/api/notes/ledger/ART/entries?limit=101')).status, 400);
  assert.equal((await request('/api/notes/ledger/ART/entries?before=0')).status, 400);
  assert.equal((await request('/api/notes/ledger/ART/entries?address=invalid')).status, 400);
  assert.equal((await request('/api/notes/ledger/UNKNOWN/entries')).status, 404);
  assert.equal((await request('/api/notes/ledger/FTH%24/entries')).status, 404);
});

test('public creation APIs enforce wallet ownership, fee signatures, origin and safe owner editing', async t => {
  const { ethers } = require('ethers');
  const { createDollarApi } = require('../../notes/dollar');
  const { walletAccountId } = require('../../fth-ledger/transfer');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creation-http-'));
  const registryFile = path.join(root, 'sites.json'); writeJson(registryFile, []);
  const { base, app, notesFile } = await startServer(t, { siteManagement: true }, 'creation-test', registryFile);
  const dollar = createDollarApi({ env: { FTH_LEDGER_MODE: 'writer', FTH_LEDGER_DIR: path.join(root, 'dollar'), FTH_LEDGER_BLOCK_INTERVAL_MS: '0' } });
  app.setCreationPayments(dollar.creationPayments);
  app.setNoteSupply(dollar.noteSupply);
  app.setDollarWallet(dollar.walletAccount, dollar.exchangeSettlement);
  t.after(() => {
    dollar.close();
    for (const site of new (require('../lib/sites').SiteManager)({ registryFile }).list()) { dropSite(site.key); fs.rmSync(site.localDir, { recursive: true, force: true }); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (route, body, token = '', host = 'notes.featheral.com', method = body ? 'POST' : 'GET', origin = `http://${host}`) => new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/creation' + route, base), { method, headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', 'x-creation-token': token } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, data: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const wallet = ethers.Wallet.createRandom();
  assert.equal((await request('/trending')).status, 200);
  assert.equal((await request('/me')).status, 401);
  assert.equal((await request('/challenge', { address: wallet.address }, '', 'notes.featheral.com', 'POST', 'https://elsewhere.test')).status, 403);
  const challenge = (await request('/challenge', { address: wallet.address })).data;
  const login = (await request('/login', { address: wallet.address, signature: await wallet.signMessage(challenge.message) })).data;
  assert.ok(login.token);
  assert.equal((await request('/notes', { name: 'Art', symbol: 'ART' }, login.token)).status, 400);
  const siteHost = 'sites.featheral.com', slug = 'creation-' + require('node:crypto').randomBytes(5).toString('hex');
  const mint = { name: 'Art', symbol: 'ART', site: { slug, name: 'My Art' } };
  assert.equal((await request('/notes', mint, login.token)).status, 402);
  const source = open(notesFile);
  source.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1000,'fixture',0,'test')").run(wallet.address.toLowerCase()); source.close();
  assert.equal((await request('/notes', mint, login.token)).status, 402);
  assert.equal((await request('/sites/prepare', { slug: 'blocked', name: 'Blocked' }, login.token)).status, 402);
  await dollar.ledger.submit({ id: 'test-funds', kind: 'CREDIT', account: walletAccountId(wallet.address), amount: require('../../notes/creation').SITE_COST,
    data: { src: 'FthgConverted', tx: `0x${'ef'.repeat(32)}` } });
  const minted = await request('/notes', mint, login.token);
  assert.equal(minted.status, 201);
  const prepared = minted.data.request;
  assert.equal((await request('/notes', mint, login.token, siteHost)).data.request.id, prepared.id);
  assert.equal(prepared.noteSymbol, 'ART');
  const complete = await request(`/sites/${prepared.id}/complete`, { signature: await wallet.signMessage(prepared.message) }, login.token, siteHost);
  assert.equal(complete.status, 201);
  const key = complete.data.key;
  assert.deepEqual((await request('/me', undefined, login.token)).data.integrations, [{ site: key, symbol: 'ART' }]);
  assert.equal((await request(`/owned/${key}/rewards`, undefined, login.token, siteHost)).data.enabled, 0);
  assert.equal((await request(`/owned/${key}/pages`, undefined, '', siteHost)).status, 401);
  const other = ethers.Wallet.createRandom(), otherChallenge = (await request('/challenge', { address: other.address })).data;
  const otherLogin = (await request('/login', { address: other.address, signature: await other.signMessage(otherChallenge.message) })).data;
  assert.equal((await request(`/owned/${key}/pages`, undefined, otherLogin.token, siteHost)).status, 403);
  assert.equal((await request(`/owned/${key}/settings`, { displayName: 'My Art Studio', description: 'Art and design' }, otherLogin.token, siteHost, 'PUT')).status, 403);
  assert.equal((await request(`/owned/${key}/settings`, { displayName: 'My Art Studio', description: 'Art and design' }, login.token, siteHost, 'PUT')).status, 200);
  assert.equal((await request(`/owned/${key}/settings`, undefined, login.token, siteHost)).data.displayName, 'My Art Studio');
  const page = (await request(`/owned/${key}/pages`, undefined, login.token, siteHost)).data[0];
  assert.equal((await request(`/owned/${key}/pages/${page.id}`, { title: 'Edited', body: '<script>bad()</script>', revision: page.revision }, login.token, siteHost, 'PUT')).status, 400);
  assert.equal((await request(`/owned/${key}/pages/${page.id}`, { title: 'Edited', body: '<p>My community</p>', revision: page.revision }, login.token, siteHost, 'PUT')).status, 200);
  assert.equal((await request(`/owned/${key}/rewards`, { symbol: 'ART', chance: 10, amount: 1, enabled: true }, login.token, siteHost, 'PUT')).status, 200);
  assert.equal((await request(`/owned/${key}/note`, { symbol: 'ART' }, otherLogin.token, siteHost, 'PUT')).status, 403);
  assert.equal((await request(`/owned/${key}/note`, { symbol: 'FTHX' }, login.token, siteHost, 'PUT')).status, 403);
  assert.equal((await request(`/owned/${key}/note`, { symbol: 'ART' }, login.token, siteHost, 'PUT')).status, 200);
  assert.equal((await request(`/owned/${key}/rewards`, undefined, login.token, siteHost)).data.enabled, 1, 'same link retry preserves enabled rewards');
  assert.equal((await request(`/owned/${key}/rewards`, { symbol: 'FTH$', chance: 10, amount: 1, enabled: true }, login.token, siteHost, 'PUT')).status, 409);
  assert.equal((await request(`/owned/${key}/rewards`, { symbol: 'FTHX', chance: 10, amount: 1, enabled: true }, login.token, siteHost, 'PUT')).status, 409);
  const natives = (await request('/trending')).data.notes.filter(note => note.native);
  assert.equal(natives.find(note => note.symbol === 'FTH$').circulating, dollar.ledger.summary().circulating);
  assert.equal(natives.find(note => note.symbol === 'FTHX').circulating, (1000n * 10n ** 18n).toString());
  assert.equal((await request('/me', undefined, login.token)).data.fthx, 0);
  assert.equal((await request('/wallet', undefined, '', 'dollar.featheral.com')).status, 401);
  assert.equal((await request('/wallet', undefined, '', 'dollar.localhost')).status, 401);
  const walletView = await request('/wallet', undefined, login.token, 'dollar.featheral.com');
  assert.equal(walletView.status, 200);
  assert.equal(walletView.data.dollar.balance.available, '0');
  assert.equal(walletView.data.dollarPool.funded, false);
  assert.equal((await request('/wallet/notes/send', { symbol: 'FTHX', to: other.address, amount: 1, requestId: 'http-wallet-send-0001' }, login.token, 'dollar.featheral.com', 'POST', 'http://evil.test')).status, 403);
  assert.equal((await request('/dollar-pool/quote', { from: 'FTH$', to: 'FTHX', amount: '1' }, login.token, 'dollar.featheral.com')).status, 503);
  assert.equal((await request('/dollar-pool/fund', { dollars: '1', fthx: '1', approval: 'wrong', requestId: 'http-wallet-fund-0001' }, login.token, 'ex.featheral.com')).status, 401);
});

test('Notes admin APIs require auth and same-origin writes, and retired creation is blocked', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'notes-http-'));
  const registryFile = path.join(root, 'sites.json');
  writeJson(registryFile, []);
  const { base, notesFile, auth } = await startServer(t, { siteManagement: true }, 'notes-test', registryFile);
  t.after(() => {
    const { SiteManager } = require('../lib/sites');
    for (const site of new SiteManager({ registryFile }).list()) {
      dropSite(site.key); fs.rmSync(site.localDir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (route, body, authenticated = true, origin = 'http://notes.featheral.com', token = '', host = 'notes.featheral.com') => new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method: body ? 'POST' : 'GET', headers: {
      Host: host, Origin: origin, 'Content-Type': 'application/json',
      'x-creation-token': token,
      ...(authenticated && route.startsWith('/api/notes') ? { ...auth, Origin: origin === 'http://notes.featheral.com' ? 'https://admin.featheral.com' : origin } : {}),
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: res.headers['content-type']?.includes('json') ? JSON.parse(Buffer.concat(chunks)) : Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request('/api/notes', undefined, false)).status, 401);
  assert.equal((await request('/api/notes')).status, 200);
  const host = `notes-test-${require('node:crypto').randomBytes(5).toString('hex')}.example.test`;
  const input = { site: { hostname: host, template: 'website' }, program: { symbol: 'FTHX', chance: 10, amount: 1, enabled: true } };
  assert.equal((await request('/api/notes/sites', input, true, 'http://other.example')).status, 403);
  assert.equal((await request('/api/notes/sites', { ...input, program: { ...input.program, symbol: 'FTH$' } })).status, 410);
  assert.equal((await request('/api/notes/sites')).body.length, 0);
  const created = await request('/api/notes/sites', input);
  assert.equal(created.status, 410);
  assert.equal((await request('/api/notes/sites')).body.length, 0);
  assert.equal((await request('/api/notes/wallets/not-a-wallet')).status, 400);
  const market = '/api/notes/markets/' + encodeURIComponent('FTH#') + '/fund';
  const approval = { approval: 'FUND FTH# 1000000 FTHX 1000000 NOTES' };
  assert.equal((await request(market, approval, false)).status, 401);
  assert.equal((await request(market, approval, true, 'http://elsewhere.test')).status, 403);
  assert.equal((await request(market, approval)).status, 409);
  assert.equal((await request('/api/creation/markets')).body.markets.length, 34);
  assert.equal((await request('/api/notes/markets')).body.markets.filter(market => market.reserved).length, 19);
  assert.equal((await request('/api/creation/markets/trade', {}, false)).status, 401);
  const wallet = require('ethers').Wallet.createRandom(), owner = wallet.address.toLowerCase();
  const source = open(notesFile);
  const credit = source.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',0,'test')");
  credit.run(require('../../notes/game-funds').SYSTEM_TREASURY_ACCOUNT, 1000000);
  credit.run(owner, 1000); source.close();
  assert.equal((await request(market, approval)).status, 409, 'reserved funding stays disabled with sufficient treasury funds');
  assert.equal((await request('/api/notes/markets/FTHA/fund', { approval: 'FUND FTHA 1000000 FTHX 1000000 NOTES' })).status, 200);
  const challenge = (await request('/api/creation/challenge', { address: owner }, false)).body;
  const session = (await request('/api/creation/login', { address: owner, signature: await wallet.signMessage(challenge.message) }, false)).body;
  assert.equal((await request('/api/creation/markets/quote', { symbol: 'FTH#', side: 'buy', amount: 100 }, false)).status, 409);
  assert.equal((await request('/api/creation/markets/trade', { symbol: 'FTH#', side: 'buy', amount: 100, minOutput: 1, requestId: 'http-reserved-0001' }, false, 'http://notes.featheral.com', session.token)).status, 409);
  const quote = (await request('/api/creation/markets/quote', { symbol: 'FTHA', side: 'buy', amount: 100 }, false)).body;
  assert.equal(quote.output, 99);
  const trade = { symbol: 'FTHA', side: 'buy', amount: 100, minOutput: quote.output, requestId: 'http-note-trade-0001' };
  const paid = await request('/api/creation/markets/trade', trade, false, 'http://notes.featheral.com', session.token);
  assert.equal(paid.status, 200);
  assert.deepEqual((await request('/api/creation/markets/trade', trade, false, 'http://notes.featheral.com', session.token)).body, paid.body);
  const me = (await request('/api/creation/me', undefined, false, 'http://notes.featheral.com', session.token)).body;
  assert.equal(me.fthx, 900);
  assert.equal(me.holdings.find(holding => holding.symbol === 'FTHA').balance, 99);
  const trending = (await request('/api/creation/trending')).body.notes;
  assert.equal(trending.find(note => note.symbol === 'FTHA').volume, 100);
  assert.ok(!trending.some(note => note.symbol === 'FTH#'));
  const exchangeOrigin = 'http://ex.featheral.com';
  assert.equal((await request('/api/public/exchange/pools', undefined, false, exchangeOrigin, '', 'ex.featheral.com')).status, 410);
  assert.equal((await request('/api/public/demo/faucet', {}, false, exchangeOrigin, '', 'ex.featheral.com')).status, 410);
  assert.equal((await request('/api/creation/markets/quote', { symbol: 'FTHA', side: 'sell', amount: 10 }, false, exchangeOrigin, session.token, 'ex.featheral.com')).status, 200);
  const liquidityQuote = await request('/api/creation/markets/liquidity/quote', { symbol: 'FTHA', action: 'add', amount: 10 }, false, exchangeOrigin, session.token, 'ex.featheral.com');
  assert.equal(liquidityQuote.status, 200);
  const liquidityInput = { ...liquidityQuote.body, amount: 10, requestId: 'http-liquidity-0001' };
  assert.equal((await request('/api/creation/markets/liquidity', liquidityInput, false, 'http://elsewhere.test', session.token, 'ex.featheral.com')).status, 403);
  assert.equal((await request('/api/creation/markets/liquidity', liquidityInput, false, exchangeOrigin, '', 'ex.featheral.com')).status, 401);
  const liquidityPaid = await request('/api/creation/markets/liquidity', liquidityInput, false, exchangeOrigin, session.token, 'ex.featheral.com');
  assert.equal(liquidityPaid.status, 200);
  assert.deepEqual((await request('/api/creation/markets/liquidity', liquidityInput, false, exchangeOrigin, session.token, 'ex.featheral.com')).body, liquidityPaid.body);
  assert.equal((await request('/api/creation/markets/account', undefined, false, exchangeOrigin, session.token, 'ex.featheral.com')).body.positions[0].symbol, 'FTHA');
  const prices = (await request('/api/creation/trending?interval=1h', undefined, false, exchangeOrigin, '', 'ex.featheral.com')).body.notes;
  assert.equal(prices.find(note => note.symbol === 'FTHA').history.points.length, 1);
  assert.equal(prices.find(note => note.symbol === 'FTHA').price.currency, 'FTHX');
  assert.equal((await request('/api/creation/trending?interval=invalid', undefined, false)).status, 400);
});

test('free websites use path-scoped CMS datasets, public APIs, media, previews and telemetry', async t => {
  const { SiteManager } = require('../lib/sites');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'free-sites-registry-'));
  const registryFile = path.join(root, 'sites.json');
  const suffix = require('node:crypto').randomBytes(5).toString('hex');
  const manager = new SiteManager({ registryFile });
  const baseSite = manager.create({ hostname: `base-${suffix}.example.test`, template: 'sites' });
  manager.records[0].hostname = 'sites.featheral.com';
  manager.persist();
  const { base, provision, auth } = await startServer(t, { siteManagement: true, allowSync: false }, 'free-sites-test', registryFile);
  t.after(() => {
    for (const site of new SiteManager({ registryFile }).list()) {
      dropSite(site.key);
      fs.rmSync(site.localDir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (route, payload, admin = false, host = admin ? 'admin.featheral.com' : 'sites.localhost', options = {}) => new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method: options.method || (payload === undefined ? 'GET' : 'POST'), headers: {
      Host: host, Origin: options.origin || `http://${host}`, 'Content-Type': 'application/json',
      ...(options.token ? { 'X-Wallet-Token': options.token } : {}),
      ...(admin ? { ...auth, Origin: 'https://admin.featheral.com' } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, data: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  const input = slug => ({ hostname: 'sites.featheral.com', slug, name: slug });
  assert.equal((await request('/api/sites', input(`unauthorized-${suffix}`))).status, 401);
  assert.equal((await request('/api/sites', input(`one-${suffix}`), true)).status, 410);
  const first = { status: 201, data: provision(input(`one-${suffix}`)) };
  const second = { status: 201, data: provision(input(`two-${suffix}`)) };
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.data.key, second.data.key);
  assert.equal(first.data.path, `/one-${suffix}`);
  assert.equal(first.data.siteUrl, `https://sites.featheral.com/one-${suffix}/`);
  assert.throws(() => provision(input(`one-${suffix}`)), /already exists/);
  for (const slug of ['api', '../escape', 'Bad name', '', 'x'.repeat(64)]) {
    assert.throws(() => provision(input(slug)), /Free website names/);
  }
  const image = await require('sharp')({ create: { width: 800, height: 600, channels: 3, background: '#42697a' } }).png().toBuffer();
  fs.writeFileSync(path.join(first.data.localDir, 'uploads', 'neutral.png'), image);
  const post = { ID: 1, post_type: 'post', post_status: 'publish', post_title: 'Neutral landscape', post_content: '',
    post_excerpt: '', post_date: '2026-01-01', post_author: 0, post_parent: 0, post_mime_type: '', comment_count: 0 };
  new (require('../lib/sync').SyncRunner)().writeDb(path.join(first.data.localDir, 'db.sqlite'), first.data.key, {
    posts: new Map([[1, post], [2, { ...post, ID: 2, post_status: 'draft' }],
      [101, { ...post, ID: 101, post_type: 'attachment', post_status: 'inherit', post_parent: 1, post_mime_type: 'image/png' }]]),
    postmeta: [[101, '_wp_attached_file', 'neutral.png'], [101, '_wp_attachment_metadata',
      require('../lib/phpser').serialize({ file: 'neutral.png', filesize: image.length, width: 800, height: 600, sizes: {} })]],
    terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: first.data.siteUrl, requests: 0 }, manifest: { key: first.data.key } });
  writeJson(path.join(first.data.localDir, 'uploads-index.json'), [{ path: 'neutral.png', size: image.length, ext: 'png', image: true }]);
  const prefix = first.data.path;
  assert.equal((await request(prefix)).location, prefix + '/');
  const shell = await request(prefix + '/');
  assert.equal(shell.status, 200);
  assert.match(shell.data, new RegExp(`name="site-base" content="${prefix}"`));
  assert.match(shell.data, /site\/free-sites.css/);
  assert.equal((await request('/missing-website/')).status, 404);
  assert.equal((await request(prefix + '/api/sets/' + second.data.key + '/overview')).status, 404);
  const home = await request(prefix + '/api/public/texts/by-slug/home');
  assert.equal(home.status, 200);
  const save = await request(`/api/sets/${first.data.key}/cms/content`, {
    title: 'First only', slug: 'first-only', body: 'Private to the first public website', type: 'page', status: 'publish',
  }, true);
  assert.equal(save.status, 201);
  assert.equal((await request(prefix + '/api/public/texts/by-slug/first-only')).status, 200);
  assert.equal((await request(second.data.path + '/api/public/texts/by-slug/first-only')).status, 404);
  assert.equal((await request('/api/public/texts/by-slug/first-only')).status, 404);
  const info = await request(prefix + '/api/public/info');
  assert.equal(info.data.siteSettings.displayName, `one-${suffix}`);
  assert.equal(info.data.siteSettings.homepage, 'content');
  assert.equal(info.data.siteSettings.ageGate, false);
  const bootstrap = await request(prefix + '/api/public/info?bootstrap=1');
  const { types, mix, thumbs, texts, trash, ...metadata } = info.data;
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers['cache-control'], 'no-store');
  assert.deepEqual(bootstrap.data, metadata);
  assert(Object.hasOwn(info.data, 'mix'), 'ordinary API clients retain the full contract');
  const liked = await request(prefix + '/api/public/liked');
  assert.equal(liked.status, 200);
  assert.equal(liked.data.sort, 'recent');
  assert.equal(liked.data.limit, 24);
  assert.equal(liked.headers['cache-control'], 'no-store');
  const trashResponse = await request(prefix + '/api/public/trash');
  assert.equal(trashResponse.status, 200);
  assert.equal(trashResponse.data.limit, 24);
  assert.equal(trashResponse.data.total, 0);
  assert.equal(trashResponse.headers['cache-control'], 'no-store');
  assert.equal((await request(prefix + '/api/public/posts/999999/curation?type=jpeg')).status, 404);
  assert.equal((await request(prefix + '/api/public/posts/999999/media?type=jpeg')).status, 404);
  assert.equal((await request(prefix + '/api/public/posts/999999/preview?type=jpeg')).status, 404);
  assert.equal((await request(prefix + '/api/public/posts/1/curation?type=png')).data.round, 1);
  const thumbnail = await request(prefix + '/api/public/posts/1/preview?type=png');
  assert.equal(thumbnail.status, 200);
  assert.match(thumbnail.headers['content-type'], /image\/webp/);
  assert.equal((await request(second.data.path + '/api/public/posts/1/preview?type=png')).status, 404);
  assert.equal((await request(prefix + '/api/public/posts/2/curation?type=png')).status, 404);
  assert.equal((await request(prefix + '/api/public/vote', { id: 1, type: 'png', round: 1, vote: 'dislike' })).data.deleted, true);
  assert.equal((await request(prefix + '/api/public/trash')).data.items[0].id, 1);
  const movedMedia = await request(prefix + '/api/public/posts/1/media?type=png');
  assert.equal(movedMedia.status, 200);
  assert.match(movedMedia.headers['content-type'], /image\/png/);
  assert.equal((await request(prefix + '/api/public/posts/1/preview?type=png')).status, 200);
  assert.equal((await request(prefix + '/api/public/vote', { id: 1, type: 'png', round: 1, vote: 'none' })).data.deleted, false);
  assert.equal((await request(prefix + '/api/public/trash')).data.total, 0);
  const readingId = -save.data.id;
  const navigation = await request(prefix + '/api/public/reading-navigation');
  assert.equal(navigation.status, 200);
  assert.equal(navigation.headers['cache-control'], 'no-store');
  assert(navigation.data.pages.some(page => page.slug === 'first-only'));
  assert(!(await request(second.data.path + '/api/public/reading-navigation')).data.pages.some(page => page.slug === 'first-only'));
  assert.equal((await request(prefix + `/api/public/posts/${readingId}/curation?type=read`)).data.round, 1);
  assert.equal((await request(prefix + '/api/public/vote', { id: readingId, type: 'read', round: 1, vote: 'like' })).data.likes, 1);
  assert((await request(prefix + '/api/public/liked?kind=read')).data.items.some(item => item.id === readingId));
  assert(!(await request(prefix + '/api/public/liked')).data.items.some(item => item.id === readingId));
  assert.equal((await request(prefix + '/api/public/vote', { id: readingId, type: 'read', round: 1, vote: 'dislike' })).data.deleted, true);
  assert.equal((await request(prefix + `/api/public/texts/${readingId}`)).status, 404);
  assert.equal((await request(prefix + `/api/public/texts/${readingId}?trash=1`)).status, 200);
  assert((await request(prefix + '/api/public/trash')).data.items.some(item => item.id === readingId && item.reading));
  assert.equal((await request(prefix + '/api/public/vote', { id: readingId, type: 'read', round: 1, vote: 'none' })).data.deleted, false);
  assert.equal((await request(prefix + '/api/public/texts/by-slug/first-only')).status, 200);
  assert.equal((await request(prefix + '/api/public/texts?category=bad')).status, 400);
  assert.equal((await request(prefix + '/api/public/collections')).status, 410);
  const wallet = require('ethers').Wallet.createRandom();
  const nonce = await request(prefix + '/api/public/wallet/nonce', { address: wallet.address });
  const login = await request(prefix + '/api/public/wallet/login', {
    address: wallet.address, signature: await wallet.signMessage(nonce.data.message),
  });
  assert.equal(login.status, 200);
  const options = { token: login.data.token };
  const folderRoute = prefix + '/api/public/collections/removed-folder';
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const retired = await request(folderRoute, undefined, false, 'sites.localhost', { ...options, method });
    assert.equal(retired.status, 410);
    assert.equal(retired.headers['cache-control'], 'no-store');
    assert.match(retired.data.error, /removed/);
  }
  assert.equal((await request(prefix + '/api/public/collections', { name: 'HTTP folder' }, false, 'sites.localhost', options)).status, 410);
  assert.equal((await request(folderRoute + '/posts/999999', undefined, false, 'sites.localhost', { ...options, method: 'PUT' })).status, 410);
  assert.equal((await request(second.data.path + '/api/public/collections', undefined, false, 'sites.localhost', options)).status, 410);
  assert.equal((await request(prefix + '/api/public/liked?collection=removed-folder')).status, 410);
  assert.equal((await request(prefix + '/api/public/liked')).status, 200);
  const store = new (require('../lib/cms'))(path.join(first.data.localDir, 'cms.sqlite'));
  try { store.setTheme('editorial'); } finally { store.close(); }
  assert.equal((await request(prefix + '/api/public/info')).data.theme, 'editorial');
  assert.equal((await request(second.data.path + '/api/public/info')).data.theme, 'ocean');
  const directory = await request('/api/public/sites');
  assert.equal(directory.data.sites.length, 2);
  assert.equal((await request(prefix + '/api/public/sites')).status, 404);
  assert.equal((await request(prefix + '/api/telemetry/hit', {})).data.recorded, true);
  const report = await request('/api/telemetry/report', undefined, true);
  assert.equal(report.data.sites.find(site => site.hostname === 'sites.featheral.com' + prefix).hourly.at(-1).views, 1);
  assert.equal(report.data.sites.find(site => site.hostname === 'sites.featheral.com' + second.data.path).hourly.at(-1).views, 0);
  const preview = await request('/?site=' + first.data.key, undefined, true);
  assert.match(preview.data, /name="site-base" content=""/);
  assert.match(preview.data, new RegExp(`name="site-key" content="${first.data.key}"`));
  fs.writeFileSync(path.join(first.data.localDir, 'uploads', 'test.txt'), 'first asset');
  assert.equal((await request(prefix + `/media/${first.data.key}/test.txt`)).data, 'first asset');
  assert.equal((await request(second.data.path + `/media/${first.data.key}/test.txt`)).status, 404);
  const catalog = await request('/api/sites', undefined, true);
  assert.equal(catalog.data.filter(site => site.hostname === 'sites.featheral.com').length, 3);
  assert.ok(baseSite.key);
});

test('Stats is normally CMS-managed and aggregate telemetry enforces origin, privacy and public feature controls', async t => {
  const { SiteManager } = require('../lib/sites');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stats-registry-test-'));
  const registryFile = path.join(root, 'sites.json');
  const statsHost = `stats-${require('node:crypto').randomBytes(5).toString('hex')}.featheral.com`;
  const { base, provision, auth: admin } = await startServer(t, { siteManagement: true }, 'stats-test-password', registryFile);
  t.after(() => {
    for (const site of new SiteManager({ registryFile }).list()) {
      dropSite(site.key);
      fs.rmSync(site.localDir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (host, route, payload, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method: payload === undefined ? 'GET' : 'POST', headers: {
      Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', ...extra,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, data: res.headers['content-type']?.includes('json') ? JSON.parse(body) : body });
      });
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  const created = { status: 201, data: provision({ hostname: statsHost, template: 'stats', name: 'Stats test' }) };
  assert.equal(created.status, 201);
  const info = await request(statsHost, '/api/public/info');
  assert.equal(info.data.siteSettings.stats, true);
  assert.equal(info.data.siteSettings.ageGate, false);
  assert.equal(info.data.siteSettings.homepage, 'content');
  const home = await request(statsHost, '/');
  assert.equal(home.status, 200);
  assert.match(home.data, /shared\/telemetry\.js/);
  assert.match(home.data, /shared\/traffic-charts\.js/);
  for (const host of ['world.localhost', 'gold.featheral.com', statsHost]) {
    assert.equal((await request(host, '/api/telemetry/hit', {})).data.recorded, true);
  }
  assert.equal((await request('world.localhost', '/api/telemetry/hit', {}, { DNT: '1' })).data.recorded, false);
  assert.equal((await request('world.localhost', '/api/telemetry/hit', {}, { 'Sec-GPC': '1' })).data.recorded, false);
  assert.equal((await request('world.localhost', '/api/telemetry/hit', {}, { Origin: 'http://other.localhost' })).status, 403);
  assert.equal((await request('unknown.localhost', '/api/telemetry/hit', {})).status, 403);
  assert.equal((await request('world.localhost', '/api/telemetry/hit', { wallet: 'not-accepted' })).status, 400);
  assert.equal((await request(statsHost, '/api/telemetry/report')).status, 401);
  assert.equal((await request('gold.featheral.com', '/api/telemetry/public')).status, 404);
  const report = await request(statsHost, '/api/telemetry/public');
  assert.equal(report.status, 200);
  assert.equal(report.data.sites.find(site => site.hostname === 'world.featheral.com').hourly.at(-1).views, 1);
  assert.deepEqual(Object.keys(report.data.sites[0]).sort(), ['color', 'daily', 'favicon', 'hostname', 'hourly', 'minutely']);
  const world = report.data.sites.find(site => site.hostname === 'world.featheral.com');
  assert.equal(world.color, require('../../../shared/site-colors.json')['world.featheral.com'].color);
  assert.equal(world.favicon, '/shared/logo-world.svg');
  assert.equal((await request('admin.featheral.com', `/api/telemetry/public?site=${created.data.key}`, undefined, admin)).status, 200);
  const store = new (require('../lib/cms'))(path.join(created.data.localDir, 'cms.sqlite'));
  try {
    assert.ok(store.published().some(page => page.slug === 'home'));
    const settings = store.siteSettings();
    assert.throws(() => store.setSiteSettings({ ...settings, stats: 'yes' }), /boolean/);
    store.setSiteSettings({ ...settings, stats: false });
  } finally { store.close(); }
  assert.equal((await request(statsHost, '/api/telemetry/public')).status, 404);
});

test('unified admin protects every console and forwards authenticated raw API requests without weakening wallet authority', async t => {
  const { base, app, auth } = await startServer(t, { siteKey: 'test' }, 'admin-test-password');
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { method, headers: { 'X-Forwarded-Proto': 'https', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, location: res.headers.location, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  for (const key of ['foundation', 'gold', 'dollar', 'world']) {
    const url = `/operations/${key}/`;
    assert.equal((await request(url, { headers: { Host: 'admin.featheral.com' } })).status, 401);
    const response = await request(url, { headers: auth });
    assert.equal(response.status, 302);
    assert.equal(response.location, `/#/operations/${key}`);
    assert.equal((await request(url, { headers: { Host: 'x.featheral.com' } })).status, 404);
  }
  assert.equal((await request('/api/server-users', { headers: { Host: 'admin.featheral.com' } })).status, 401);
  assert.equal((await request('/api/server-users', { headers: { ...auth, 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await request('/api/server-users', { headers: { ...auth, Host: 'x.featheral.com' } })).status, 404);
  for (const url of ['/js/operations/gold.js', '/reserve.css', '/js/reserve-view.js',
    '/js/dollar-format.js', '/js/operations/world.js', '/shared/admin-kit.js', '/pages/gold.html', '/js/vendor/ethers.js']) {
    const response = await request(url, { headers: auth });
    assert.equal(response.status, 200, url);
    assert.ok(!(await response.text()).startsWith('<!doctype html>'));
  }
  for (const url of ['/operations/gold/app.js', '/operations/dollar/bridge-admin.js', '/shared/admin-console.js', '/shared/admin.css']) {
    assert.equal((await request(url, { headers: auth })).status, 404, url);
  }
  assert.equal((await request('/operations/unknown/', { headers: auth })).status, 404);
  assert.equal((await request('/api/v1/world/stats', { headers: auth })).status, 503);
  let calls = 0;
  app.setOperationsHandler(async (req, res) => {
    calls++;
    let body = '';
    for await (const chunk of req) body += chunk;
    res.json({ url: req.url, body });
  });
  const url = '/api/v1/gold/rpc';
  assert.equal((await request(url, { headers: { Host: 'admin.featheral.com' } })).status, 401);
  assert.equal((await request(url, { method: 'POST', headers: { ...auth, Origin: 'https://other.example' }, body: '{}' })).status, 403);
  assert.equal((await request(url, { method: 'POST', headers: auth, body: '{}' })).status, 403);
  assert.equal(calls, 0);
  const response = await request(url, { method: 'POST', headers: { ...auth, Origin: 'https://admin.featheral.com', 'Content-Type': 'application/json' }, body: '{"method":"eth_chainId"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url, body: '{"method":"eth_chainId"}' });
  assert.equal(calls, 1);
});

test('local mode serves only the configured data set and disables loading sites', async (t) => {
  const { base, auth } = await startServer(t, { brand: 'Test Admin', siteKey: 'only-this-site', allowSync: false });
  assert.deepEqual(await (await fetch(base + '/api/config', { headers: auth })).json(), {
    brand: 'Test Admin', siteKey: 'only-this-site', locked: true,
    cmsHost: 'admin.featheral.com', publicHost: 'x.featheral.com',
  });
  for (const [method, url] of [['POST', '/api/connect'], ['POST', '/api/sync'], ['POST', '/api/job/cancel'], ['DELETE', '/api/sets/only-this-site']]) {
    const response = await fetch(base + url, { method, headers: { ...auth, Origin: 'https://admin.featheral.com' }, body: '{"url":"https://example.test"}' });
    assert.equal(response.status, 403, `${method} ${url}`);
  }
  assert.equal((await fetch(base + '/api/sets/another-site/overview', { headers: auth })).status, 404);
  const serverUsers = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/server-users', { headers: { Host: 'admin.localhost' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
  assert.equal(serverUsers.status, 401);
  assert.match(serverUsers.body.error, /wallet/);
  assert.equal((await fetch(base + '/media/another-site/a.jpg')).status, 404);
  assert.equal((await fetch(base + '/media/only-this-site/missing.jpg', { redirect: 'manual' })).status, 404);
  assert.ok((await (await fetch(base + '/api/library', { headers: auth })).json()).every((m) => m.key === 'only-this-site'));
});

test('hostnames route the CMS and public site separately and protect CMS access', async (t) => {
  const { base, auth, localAuth } = await startServer(t, { brand: 'Featheral CMS', siteKey: 'test' }, 'test-password');
  const request = (pathname, host, headers = {}) => new Promise((resolve, reject) => {
    http.get(new URL(pathname, base), { headers: { ...(host === 'admin.featheral.com' ? { 'X-Forwarded-Proto': 'https' } : {}), ...headers, Host: host } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  const cmsDenied = await request('/', 'admin.featheral.com');
  assert.equal(cmsDenied.status, 200);
  assert.match(cmsDenied.body, /Sign in to Admin/);
  const cms = await request('/', 'admin.featheral.com', auth);
  assert.equal(cms.status, 200);
  assert.match(cms.body, /Featheral Admin/);
  const media = await request('/', 'x.featheral.com');
  assert.equal(media.status, 200);
  assert.match(media.body, /data-tab="swipe"/);
  for (const [pathname, host, headers, content] of [
    ['/styles.css', 'admin.featheral.com', auth, ''],
    ['/js/cms.js', 'admin.featheral.com', auth, 'VIEWS'],
    ['/site/site.js', 'x.featheral.com', {}, 'Public site'],
    ['/site/site.css', 'x.featheral.com', {}, ''],
    ['/site/demos.js', 'ex.featheral.com', {}, 'minimumAfterSlippage'],
    ['/site/demos.css', 'ex.featheral.com', {}, ''],
    ['/site/site.js', 'admin.featheral.com', auth, 'Public site'],
  ]) {
    const asset = await request(pathname, host, headers);
    assert.equal(asset.status, 200, pathname);
    assert.ok(asset.body.length > 0, pathname);
    assert.ok(!asset.body.startsWith('<!doctype html>'), `${pathname} must return the asset, not the page fallback`);
    assert.ok(asset.body.includes(content), pathname);
  }
  assert.equal((await request('/js/cms.js', 'admin.featheral.com')).status, 401);
  const legacyAdminDenied = await request('/api/sets/test/overview', 'x.featheral.com');
  assert.equal(legacyAdminDenied.status, 401);
  const configDenied = await request('/api/config', 'x.featheral.com');
  assert.equal(configDenied.status, 401);
  const apiDenied = await request('/api/sets/test/cms/content', 'x.featheral.com');
  assert.equal(apiDenied.status, 401);
  const apiAllowed = await request('/api/sets/test/cms/content', 'x.featheral.com', auth);
  assert.equal(apiAllowed.status, 401, 'Admin sessions cannot authorize another hostname');
  assert.equal((await request('/', 'admin.localhost')).status, 200);
  assert.match((await request('/', 'admin.localhost', localAuth)).body, /Featheral Admin/);
  assert.match((await request('/', 'x.localhost')).body, /data-tab="swipe"/);
  assert.match((await request('/?site=test', 'admin.localhost', localAuth)).body, /data-tab="swipe"/);
  assert.equal((await request('/api/public/info?site=test', 'admin.localhost')).status, 401);
});

test('CMS development requires signed wallet access even on the loopback local alias', async (t) => {
  const { base } = await startServer(t, { brand: 'Featheral CMS', siteKey: 'test', allowSync: false });
  const request = (host) => new Promise((resolve, reject) => {
    http.get(new URL('/api/config', base), { headers: { host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  test('integrated CMS pages are selectable, authenticated, revision checked and deployment cannot start implicitly', async t => {
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cms-integrated-registry-'));
    const registry = path.join(temp, 'sites.json');
    fs.writeFileSync(registry, '[]');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const { base, auth } = await startServer(t, { siteManagement: true }, 'page-test-password', registry);
    const headers = { ...auth, Origin: 'https://admin.featheral.com' };
    const catalog = await (await fetch(base + '/api/sites', { headers })).json();
    for (const hostname of require('../lib/site-pages').hosts) {
      assert.equal(catalog.filter(site => site.hostname === hostname && !site.path).length, 1, hostname);
    }
    const wallet = catalog.find(site => site.hostname === 'wallet.featheral.com');
    assert.equal(wallet.management, 'classic');
    assert.equal(wallet.cmsCompatible, false);
    assert.equal(wallet.contentEditable, false);
    assert.equal((await fetch(base + '/api/sites/media.featheral.com/pages', { headers: { Host: 'admin.featheral.com', 'X-Forwarded-Proto': 'https' } })).status, 401);
    const result = await (await fetch(base + '/api/sites/media.featheral.com/pages', { headers })).json();
    assert.ok(result.pages.length > 0);
    const page = result.pages[0];
    const publish = revision => fetch(base + `/api/sites/media.featheral.com/pages/${page.id}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Updated CMS copy', revision }),
    });
    assert.equal((await publish(page.revision)).status, 200);
    assert.equal((await publish(page.revision)).status, 409);
    const foundation = await (await fetch(base + '/api/sites/featheral.com/pages', { headers })).json();
    assert.equal(foundation.pages.length, 3);
    assert.ok(foundation.pages.every(page => page.format === 'document'));
    const document = foundation.pages.find(page => page.template === 'docs/index.html');
    const publishDocument = body => fetch(base + `/api/sites/featheral.com/pages/${document.id}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, title: 'CMS documentation', excerpt: 'Full-page description', revision: document.revision }),
    });
    assert.equal((await publishDocument('<script>bad()</script>')).status, 400);
    assert.equal((await publishDocument('<article><h1>Full CMS page</h1><p>Published documentation.</p></article>')).status, 200);
    assert.equal((await publishDocument('<h1>Stale editor</h1>')).status, 409);
    const updated = await (await fetch(base + '/api/sites/featheral.com/pages', { headers })).json();
    assert.equal(updated.pages.find(page => page.id === document.id).title, 'CMS documentation');
    assert.equal((await fetch(base + '/api/deployment/start', { method: 'POST', headers })).status, 403);
    const status = await (await fetch(base + '/api/deployment/status', { headers })).json();
    assert.deepEqual(status, { running: false, result: null });
  });
  assert.equal(await request('admin.localhost'), 401);
  assert.equal(await request('admin.featheral.com'), 403);
  assert.equal(await request('x.localhost'), 401);
  assert.equal(await request('admin.localhost.example.com'), 401);
});

test('site management creates selectable sites and isolates hostname routing, content, themes and media', async (t) => {
  const { SiteManager } = require('../lib/sites');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'site-registry-test-'));
  const registryFile = path.join(root, 'sites.json');
  const manager = new SiteManager({ registryFile, cmsHost: 'admin.featheral.com' });
  const suffix = require('node:crypto').randomBytes(5).toString('hex');
  const firstHost = `one-${suffix}.example.test`;
  const secondHost = `two-${suffix}.example.test`;
  const first = manager.create({ hostname: firstHost });
  const { base, provision, auth } = await startServer(t, {
    brand: 'CMS', siteKey: first.key, publicHost: firstHost, allowSync: false, siteManagement: true,
  }, 'test-password', registryFile);
  t.after(() => {
    for (const site of new SiteManager({ registryFile }).list()) {
      dropSite(site.key);
      fs.rmSync(site.localDir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (pathname, host, method = 'GET', payload, authenticated = false) => new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(new URL(pathname, base), {
      method, headers: {
        host, ...(authenticated ? { ...auth, Origin: 'https://admin.featheral.com' } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, data: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const cmsRequest = (url, method, body) => request(url, 'admin.featheral.com', method, body, true);
  assert.equal((await request('/api/sites', firstHost)).status, 401);
  assert.equal((await cmsRequest('/api/sites', 'POST', { hostname: secondHost, name: 'Second site' })).status, 410);
  const second = provision({ hostname: secondHost, name: 'Second site' });
  const library = await cmsRequest('/api/library');
  assert.ok(library.data.some((s) => s.key === first.key && s.hostname === firstHost));
  assert.ok(library.data.some((s) => s.key === second.key && s.name === 'Second site'));
  assert.equal((await cmsRequest(`/api/sets/${second.key}/overview`)).data.hostname, secondHost);
  assert.equal(fs.existsSync(path.join(second.localDir, 'public.sqlite')), true);
  for (const [site, title, theme] of [[first, 'First content', 'ocean'], [second, 'Second content', 'editorial']]) {
    const saved = await cmsRequest(`/api/sets/${site.key}/cms/content`, 'POST', {
      title, slug: 'shared-slug', body: title, type: 'page', status: 'publish',
    });
    assert.equal(saved.status, 201);
    assert.equal((await cmsRequest(`/api/sets/${site.key}/cms/theme`, 'PUT', { theme })).status, 200);
  }
  for (const [host, title, theme] of [[firstHost, 'First content', 'ocean'], [secondHost, 'Second content', 'editorial']]) {
    assert.equal((await request('/api/public/texts', host)).data.items[0].title, title);
    assert.equal((await request('/api/public/info', host)).data.theme, theme);
    assert.equal((await request('/api/public/texts/by-slug/shared-slug', host)).data.title, title);
  }
  const preview = await request(`/api/public/info?site=${second.key}`, '127.0.0.1', 'GET', undefined, true);
  assert.equal(preview.data.brand, secondHost);
  assert.equal((await request(`/api/public/info?site=${second.key}`, firstHost)).status, 401);
  assert.equal((await request('/api/public/info', 'unregistered.example.test')).status, 404);
  fs.writeFileSync(path.join(first.localDir, 'uploads', 'test.jpg'), 'first-site-media');
  assert.equal((await request(`/media/${first.key}/test.jpg`, firstHost)).status, 200);
  assert.equal((await request(`/media/${first.key}/test.jpg`, secondHost)).status, 404);
  assert.equal((await cmsRequest('/api/sites', 'POST', { hostname: secondHost })).status, 410);
  assert.equal((await cmsRequest('/api/sites', 'POST', { hostname: '../invalid' })).status, 410);
  assert.equal((await cmsRequest('/api/sync', 'POST', { url: 'https://example.test' })).status, 403);
  assert.equal(new SiteManager({ registryFile }).list().length, 2);
});

test('text exports include complete content and respect all/filtered scopes', async (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'text-export-test-'));
  const key = path.basename(dir);
  t.after(() => { dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  writeJson(path.join(dir, 'manifest.json'), { key, site: 'Test site', status: 'ready' });
  const db = open(path.join(dir, 'db.sqlite'));
  try {
    db.exec(`
      CREATE TABLE __meta (key TEXT, value TEXT);
      CREATE TABLE __tables (name TEXT);
      INSERT INTO __tables VALUES ('wp_posts'), ('wp_options');
      CREATE TABLE wp_options (option_name TEXT, option_value TEXT);
      CREATE TABLE wp_posts (
        ID INTEGER PRIMARY KEY, post_type TEXT, post_status TEXT, post_date TEXT,
        post_modified TEXT, post_title TEXT, post_name TEXT, post_author INTEGER,
        guid TEXT, post_parent INTEGER, post_excerpt TEXT, post_content TEXT
      );
    `);
    const insert = db.prepare('INSERT INTO wp_posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let id = 1; id <= 205; id++) {
      const type = id === 201 ? 'page' : id === 202 ? 'story' : id === 204 ? 'attachment' : id === 205 ? 'revision' : 'post';
      const status = id === 201 ? 'draft' : id === 202 ? 'private' : id === 203 ? 'trash' : 'publish';
      insert.run(id, type, status, '2026-01-01', '2026-01-01', `Title &amp; ${id}`, 'same-slug', 1, '', 0,
        `<p>Excerpt ${id}</p>`, `<p>Body ${id}</p><p>${'Full body '.repeat(400)}END-${id}</p>`);
    }
  } finally { db.close(); }

  const { base: root, auth } = await startServer(t, { brand: 'Test Admin', siteKey: key, allowSync: false });
  const fetch = url => fetchWithHost(url, { headers: auth });
  const base = `${root}/api/sets/${key}/export/`;

  const all = await fetch(base + 'posts.txt?status=all');
  assert.equal(all.status, 200);
  assert.match(all.headers.get('content-type'), /text\/plain; charset=utf-8/);
  assert.match(all.headers.get('content-disposition'), /attachment;.*posts\.txt/);
  const text = await all.text();
  assert.equal((text.match(/^ID: /gm) || []).length, 203);
  for (const id of [1, 200, 201, 202, 203]) {
    assert.ok(text.includes(`Title & ${id}\n`));
    assert.ok(text.includes(`Excerpt ${id}\n`));
    assert.ok(text.includes(`END-${id}\n`));
  }
  assert.ok(!text.includes('<p>'));
  assert.ok(!text.includes('ID: 204\n'));
  assert.ok(!text.includes('ID: 205\n'));

  const zipResponse = await fetch(base + 'posts-text.zip?status=all');
  assert.equal(zipResponse.status, 200);
  const files = readZip(Buffer.from(await zipResponse.arrayBuffer()));
  assert.equal(files.size, 203);
  assert.ok(files.get('posts/203.txt').includes('Status: trash\n'));
  assert.ok(files.get('posts/1.txt').includes('END-1\n'));

  const filtered = await (await fetch(base + 'posts.txt?type=page&status=draft')).text();
  assert.equal((filtered.match(/^ID: /gm) || []).length, 1);
  assert.ok(filtered.includes('ID: 201\n'));
  const filteredZip = readZip(Buffer.from(await (await fetch(base + 'posts-text.zip?type=page&status=draft')).arrayBuffer()));
  assert.deepEqual([...filteredZip.keys()], ['posts/201.txt']);
  const empty = await (await fetch(base + 'posts.txt?type=missing&status=all')).text();
  assert.equal(empty, '');
  const emptyZip = readZip(Buffer.from(await (await fetch(base + 'posts-text.zip?type=missing&status=all')).arrayBuffer()));
  assert.equal(emptyZip.size, 0);

  const existing = await (await fetch(base + 'posts.json')).json();
  assert.equal(existing.length, 200);
  assert.ok(existing.every((post) => post.status === 'publish'));
});

test('exchange and ecommerce APIs authenticate wallets and isolate demo funds, catalogs and CMS settings by hostname', async (t) => {
  const { SiteManager } = require('../lib/sites');
  const W = require('../lib/wallet');
  const { secp256k1 } = require('@noble/curves/secp256k1');
  const { keccak_256 } = require('@noble/hashes/sha3');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'demo-http-'));
  const registryFile = path.join(root, 'sites.json');
  const manager = new SiteManager({ registryFile });
  const suffix = crypto.randomBytes(5).toString('hex');
  const ex = manager.create({ hostname: `ex-${suffix}.example.test`, template: 'exchange' });
  const shop = manager.create({ hostname: `shop-${suffix}.example.test`, template: 'store' });
  const { base, auth } = await startServer(t, {
    siteKey: ex.key, publicHost: ex.hostname, siteManagement: true, allowSync: false,
  }, 'demo-http-password', registryFile);
  t.after(() => {
    for (const s of [ex, shop]) { dropSite(s.key); fs.rmSync(s.localDir, { recursive: true, force: true }); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (site, url, method = 'GET', payload, token, admin = false) => new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(new URL(url, base), { method, headers: {
      host: site.hostname, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      ...(token ? { 'x-wallet-token': token } : {}),
      ...(admin ? { ...auth, Origin: 'https://admin.featheral.com' } : {}),
    } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, data: res.headers['content-type']?.includes('json') ? JSON.parse(body) : body });
      });
    }); req.on('error', reject); req.end(body);
  });
  const priv = keccak_256(Buffer.from(`demo-wallet-${suffix}`));
  const address = W.checksum('0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1))).toString('hex').slice(-40));
  const login = async (s) => {
    const nonce = await call(s, '/api/public/wallet/nonce', 'POST', { address });
    const signed = secp256k1.sign(W.hashMessage(nonce.data.message), priv);
    const signature = '0x' + Buffer.from(signed.toCompactRawBytes()).toString('hex') + (27 + signed.recovery).toString(16);
    const response = await call(s, '/api/public/wallet/login', 'POST', { address, signature });
    assert.equal(response.status, 200);
    return response.data.token;
  };
  const exToken = await login(ex); const shopToken = await login(shop);
  const info = (await call(ex, '/api/public/info')).data;
  assert.equal(info.siteSettings.nativeCurrency, 'FTH$');
  assert.equal(info.ageGate, false);
  assert.equal((await call(ex, '/api/public/exchange/pools')).data.baseAsset, 'FTH$');
  assert.equal((await call(shop, '/api/public/exchange/pools')).status, 404);
  assert.equal((await call(ex, '/api/public/shop/products')).status, 404);
  assert.equal((await call(ex, '/api/public/demo/faucet', 'POST', { requestId: crypto.randomUUID() })).status, 401);
  assert.equal((await call(shop, '/api/public/demo/account', 'GET', undefined, exToken)).status, 401);
  const faucet = { requestId: crypto.randomUUID() };
  assert.equal((await call(ex, '/api/public/demo/faucet', 'POST', faucet, exToken)).status, 200);
  const before = (await call(shop, '/api/public/demo/account', 'GET', undefined, shopToken)).data;
  assert.ok(before.assets.filter(a => a.symbol !== 'FTHX').every((a) => a.balance === 0));
  const exBalance = (await call(ex, '/api/public/demo/account', 'GET', undefined, exToken)).data.assets.find(a => a.symbol === 'FTHX').balance;
  assert.equal(before.assets.find(a => a.symbol === 'FTHX').balance, exBalance);
  const quote = (await call(ex, '/api/public/exchange/quote', 'POST', { poolId: 1, from: 'FTH$', amount: '100' })).data;
  const swap = { poolId: 1, from: 'FTH$', amount: '100', minOutput: quote.output, deadline: Date.now() + 60000, requestId: crypto.randomUUID() };
  assert.equal((await call(ex, '/api/public/exchange/swap', 'POST', swap, exToken)).status, 200);
  assert.equal((await call(ex, '/api/public/exchange/swap', 'POST', swap, exToken)).status, 200);
  const after = (await call(ex, '/api/public/demo/account', 'GET', undefined, exToken)).data;
  assert.equal(after.assets.find((a) => a.symbol === 'FTH$').balance, 9900000000);
  const products = (await call(shop, '/api/public/shop/products')).data;
  assert.equal((await call(shop, `/api/sets/${shop.key}/shop/products`, 'POST', { title: 'Unauthorized' })).status, 401);
  assert.equal((await call(shop, '/api/public/demo/faucet', 'POST', { requestId: crypto.randomUUID() }, shopToken)).status, 200);
  const order = await call(shop, '/api/public/shop/checkout', 'POST', {
    requestId: crypto.randomUUID(), items: [{ id: products[0].id, quantity: 1 }], expectedTotal: products[0].price,
  }, shopToken);
  assert.equal(order.status, 201);
  assert.equal(order.data.demo, true);
  assert.equal((await call(shop, '/api/public/shop/orders', 'GET', undefined, shopToken)).data.length, 1);
  assert.equal((await call(shop, `/api/sets/${shop.key}/shop/orders`, 'GET', undefined, undefined, true)).data.length, 1);
  const settings = (await call(shop, `/api/sets/${shop.key}/cms/settings`, 'GET', undefined, undefined, true)).data;
  assert.equal((await call(shop, `/api/sets/${shop.key}/cms/settings`, 'PUT', { ...settings, homepage: 'content' }, undefined, true)).status, 200);
  assert.equal((await call(ex, '/api/public/info')).data.siteSettings.homepage, 'exchange');
  const saved = await call(shop, `/api/sets/${shop.key}/cms/content`, 'POST', { title: 'Revision test', body: 'Version one' }, undefined, true);
  const emptyPosts = await call(shop, `/api/sets/${shop.key}/posts`, 'GET', undefined, undefined, true);
  assert.equal(emptyPosts.status, 200);
  assert.equal(emptyPosts.data.total, 0);
  assert.equal(emptyPosts.data.page, 1);
  assert.equal(emptyPosts.data.groupBy, 'words');
  assert.ok(Array.isArray(emptyPosts.data.groups));
  assert.ok(emptyPosts.data.groups.every(group => group.count === 0));
  assert.equal(saved.status, 201);
  const id = saved.data.id;
  const update = await call(shop, `/api/sets/${shop.key}/cms/content/${id}`, 'PUT', { ...saved.data, body: 'Version two' }, undefined, true);
  assert.equal(update.data.revision, 2);
  assert.equal((await call(shop, `/api/sets/${shop.key}/cms/content/${id}`, 'PUT', saved.data, undefined, true)).status, 409);
  const revisions = await call(shop, `/api/sets/${shop.key}/cms/content/${id}/revisions`, 'GET', undefined, undefined, true);
  assert.equal(revisions.data[0].snapshot.body, 'Version one');
  assert.equal((await call(shop, `/api/sets/${shop.key}/cms/content/${id}/restore`, 'POST', {
    revisionId: revisions.data[0].id, revision: update.data.revision,
  }, undefined, true)).data.body, 'Version one');
  assert.equal((await call(shop, `/api/sets/${shop.key}/cms/content/${id}/duplicate`, 'POST', {}, undefined, true)).data.status, 'draft');
  assert.equal((await call(shop, `/api/sets/${shop.key}/cms/content/${id}/revisions`)).status, 401);
  const summaries = (await call(shop, `/api/sets/${shop.key}/cms/content?summary=1`, 'GET', undefined, undefined, true)).data;
  assert.ok(summaries.every((p) => p.body === undefined && Number.isSafeInteger(p.revision)));
});
