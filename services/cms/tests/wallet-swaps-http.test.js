"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm"), http = require("node:http");
const { createRequire } = require("node:module");
const { once } = require("node:events");
const { Wallet } = require("ethers");
test("wallet swap HTTP routes enforce host, origin and ownership and expose real pair executions on Exchange", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-swap-http-"));
  const serverFile = path.join(__dirname, "..", "server.js"), realRequire = createRequire(serverFile);
  const load = vm.runInThisContext(`(function(require,__dirname,module){${fs.readFileSync(serverFile, "utf8")}\nreturn {app,creation,dollarExchange,siteManager};})`, { filename: serverFile });
  const { app, creation, dollarExchange, siteManager } = load(name => {
    const dependency = realRequire(name);
    if (name === "../operations/configuration") return { ...dependency, assertDatabaseConfiguration() {} };
    if (name === "../operations/runtime") return Object.assign(Object.create(dependency), { environment: () => ({ ADMIN_CONFIG_JSON: '{"siteManagement":true}' }) });
    if (name === "./lib/store") return { ...dependency, DATA_DIR: root, listLibrary: () => [],
      readJson: (file, fallback) => file.endsWith("admin.config.json") ? { siteManagement: true } : dependency.readJson(file, fallback) };
    if (name === "./lib/sites") return { ...dependency, SiteManager: class extends dependency.SiteManager {
      constructor(options) { super({ ...options, dataDir: root, registryFile: path.join(root, "sites.json") }); }
    } };
    if (name === "./lib/deployment") return { ...dependency, Deployment: class extends dependency.Deployment {
      constructor(options) { super({ ...options, stateDirectory: path.join(root, "deployment") }); }
    } };
    return dependency;
  }, path.dirname(serverFile), { exports: {} });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, body, { host = "wallet.featheral.com", token = "", origin = `http://${host}`, prefix = "/api/creation", cookie = "" } = {}) => new Promise((resolve, reject) => {
    const request = http.request(base + prefix + route, { method: body ? "POST" : "GET",
      headers: { Host: host, Origin: origin, "Content-Type": "application/json", "x-creation-token": token, Cookie: cookie } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers, body: response.headers["content-type"]?.includes("json") ? JSON.parse(text) : text });
      });
    });
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
  const wallet = Wallet.createRandom(), owner = wallet.address.toLowerCase();
  app.setPortfolioGold(async () => ({
    chain: { id: 1 }, checkedAt: new Date().toISOString(),
    bridge: { address: "0x" + "12".repeat(20), deployed: false, initialized: false,
      reserveFthg: "0", reserveFthDollar: "0", actualFthgBalance: "0", privateField: "not-public" },
    goldReserve: { enabled: false, initialized: false, cap: "1000000000000000000000000", privateField: "not-public" },
  }));
  siteManager.create({ hostname: "ex.featheral.com" });
  const exchangePage = await call("/", undefined, { host: "ex.featheral.com", prefix: "" });
  assert.equal(exchangePage.status, 200);
  assert.equal(exchangePage.headers["cache-control"], "no-store");
  assert.equal(exchangePage.headers["last-modified"], undefined);
  assert.equal(exchangePage.headers.etag, undefined);
  for (const id of ["overview-markets", "pending-movements", "initial-dollar-funding"])
    assert.ok(exchangePage.body.includes(`id="${id}"`), `Exchange HTML includes ${id}`);
  for (const host of ["ex.featheral.com", "notes.featheral.com"]) {
    for (const asset of ["asset-icons.js", "asset-icons.css", "market-icons.svg", "trading-chart.js", "trading-chart.css"])
      assert.equal((await call(`/shared/${asset}`, undefined, { host, prefix: "" })).status, 200, `${host} serves ${asset}`);
  }
  for (const host of ["ex.featheral.com", "notes.featheral.com"]) {
    const activityResponse = await call("/activity", undefined, { host });
    assert.equal(activityResponse.status, 200);
    assert.equal(activityResponse.headers["cache-control"], "no-store");
    assert.equal(activityResponse.body.partial, true);
    assert.equal((await call("/liquidity", undefined, { host })).body.automaticFunding, false);
    assert.equal((await call("/market-tape", undefined, { host })).status, 200);
  }
  assert.equal((await call("/activity?limit=999", undefined, { host: "ex.featheral.com" })).status, 400);
  assert.equal((await call("/activity", undefined, { host: "untrusted.invalid" })).status, 404);
  for (const [address, amount] of [[owner, 1000], [require("../../notes/game-funds").SYSTEM_TREASURY_ACCOUNT, 1000000]])
    creation.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',0,'test')").run(address, amount);
  creation.markets.fund("FTHA", "FUND FTHA 1000000 FTHX 1000000 NOTES");
  const catalog = (await call("/markets", undefined, { host: "ex.featheral.com" })).body.markets;
  const terminalMarkets = (await call("/trading/markets", undefined, { host: "ex.featheral.com" })).body;
  const pools = (await call("/liquidity", undefined, { host: "ex.featheral.com" })).body.markets;
  for (const market of catalog) {
    assert.ok(terminalMarkets.markets.some(row => row.symbol === market.symbol), `Swap note ${market.symbol} is listed in Exchange`);
    const pool = pools.find(row => row.symbol === market.symbol);
    assert.ok(pool, `Swap pool ${market.symbol} is public`);
    assert.equal(pool.baseReserve, String(market.baseReserve));
    assert.equal(pool.tokenReserve, String(market.noteReserve));
  }
  assert.ok(terminalMarkets.markets.some(row => row.symbol === "FTHS"));
  assert.equal(terminalMarkets.reference.goldPools.bridge.reserveFthg, "0");
  assert.equal(terminalMarkets.reference.goldPools.nativeReserve.cap, "1000000000000000000000000");
  assert.doesNotMatch(JSON.stringify(terminalMarkets.reference.goldPools), /not-public|privateField/);
  const challenge = (await call("/challenge", { address: owner })).body;
  const token = (await call("/login", { address: owner, signature: await wallet.signMessage(challenge.message) })).body.token;
  const input = { from: "FTHX", to: "FTHA", amount: "100" };
  assert.equal((await call("/wallet/swaps/quote", input, { origin: "https://untrusted.invalid" })).status, 403);
  for (const host of ["notes.featheral.com", "featheral.com", "gold.featheral.com", "world.featheral.com", "pay.featheral.com",
    "x.featheral.com", "app.localhost", "silver.localhost", "media.localhost"])
    assert.equal((await call("/wallet/swaps/quote", input, { host })).status, 200, `${host} has same-origin contextual swaps`);
  assert.equal((await call("/wallet/swaps/quote", input, { host: "untrusted.invalid" })).status, 404);
  assert.equal((await call("/owned", undefined, { host: "app.localhost" })).status, 404);
  const quoted = await call("/wallet/swaps/quote", input);
  assert.equal(quoted.status, 200); assert.equal(quoted.body.output, "99");
  const parameters = { ...input, minOutput: quoted.body.output, requestId: "wallet-http-swap-0001" };
  assert.equal((await call("/wallet/swaps/prepare", parameters)).status, 401);
  const prepared = await call("/wallet/swaps/prepare", parameters, { token });
  assert.equal(prepared.status, 200);
  const id = prepared.body.id;
  assert.equal((await call(`/wallet/swaps/${id}/complete`, {})).status, 401);
  const complete = await call(`/wallet/swaps/${id}/complete`, {}, { token });
  assert.equal(complete.status, 200); assert.equal(complete.body.status, "complete");
  assert.deepEqual((await call(`/wallet/swaps/${id}/complete`, {}, { token })).body, complete.body);
  const account = await call("/trading/account", undefined, { token, host: "ex.featheral.com" });
  assert.equal(account.status, 200);
  assert.equal(account.body.walletTrades.length, 1);
  assert.equal(account.body.walletTrades[0].symbol, "FTHA");
  assert.equal(account.body.walletTrades[0].amount, 100);
  assert.equal(account.body.walletTrades[0].output, 99);
  const publicActivity = (await call("/activity", undefined, { host: "notes.featheral.com" })).body;
  assert.ok(publicActivity.rows.some(entry => entry.source === "exchange"));
  assert.doesNotMatch(JSON.stringify(publicActivity.rows), new RegExp(owner, "i"));
  const publicTape = (await call("/market-tape?symbol=FTHA", undefined, { host: "ex.featheral.com" })).body;
  assert.equal(publicTape.rows.length, 1);
  assert.equal(publicTape.rows[0].output, "99");
  const depositInput = { symbol: "FTHX", amount: "10", requestId: "http-trading-deposit-01" };
  assert.equal((await call("/trading/deposit", depositInput, { token, host: "ex.featheral.com" })).status, 200);
  const operationPath = `/trading/operations/${depositInput.requestId}`;
  const operation = await call(operationPath, undefined, { token, host: "ex.featheral.com" });
  assert.equal(operation.status, 200);
  assert.equal(operation.headers["cache-control"], "no-store");
  assert.equal(operation.body.status, "complete");
  assert.equal(operation.body.result.amount, "10");
  assert.equal((await call(operationPath, undefined, { host: "ex.featheral.com" })).status, 401);
  assert.equal((await call(operationPath, undefined, { token, host: "notes.featheral.com" })).status, 403);
  const other = Wallet.createRandom();
  const otherChallenge = (await call("/challenge", { address: other.address })).body;
  const otherToken = (await call("/login", { address: other.address, signature: await other.signMessage(otherChallenge.message) })).body.token;
  assert.equal((await call(operationPath, undefined, { token: otherToken, host: "ex.featheral.com" })).status, 404);
  assert.equal(creation.notes.balance(owner), 890);
  assert.equal(creation.notes.balance(owner, "FTHA"), 99);
  assert.equal(dollarExchange.account(owner).requests.length, 0);
  assert.equal((await call(`/wallet/swaps/${id}/cancel`, {}, { token })).status, 409);
  const history = await call("/markets/FTHA/history");
  assert.equal(history.body.candles[0].quoteVolume, "100");
  const stats = await call("/trending", undefined, { host: "stats.featheral.com" });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.notes.find(note => note.symbol === "FTHS").circulating, "0");
  assert.equal((await call("/challenge", { address: owner }, { host: "stats.featheral.com" })).status, 200);
  const appHost = { host: "app.localhost", prefix: "/api/intranet" };
  app.setWorkspaceProfiles(address => ({ address, username: "GatewayProfile", avatar: "" }));
  const appChallenge = (await call("/challenge", { address: owner }, appHost)).body;
  const appLogin = await call("/login", { address: owner, signature: await wallet.signMessage(appChallenge.message) }, appHost);
  assert.equal(appLogin.status, 200);
  const cookie = appLogin.headers["set-cookie"][0].split(";")[0];
  assert.equal((await call("/me", undefined, { ...appHost, cookie })).body.profile.username, "GatewayProfile");
  assert.equal((await call("/silver", undefined, { host: "silver.localhost", prefix: "/api/intranet" })).body.supply, 0);
  const exactSend = { to: other.address, amount: "1", requestId: "http-fractional-send-001" };
  assert.equal((await call("/wallet/fthx/send", exactSend)).status, 401);
  assert.equal((await call("/wallet/fthx/send", exactSend, { token, origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await call("/wallet/fthx/send", exactSend, { token, host: "untrusted.invalid" })).status, 404);
  for (const to of ["fthx-settlement:treasury", "0x" + "00".repeat(20)])
    assert.equal((await call("/wallet/fthx/send", { ...exactSend, to }, { token })).status, 400);
  assert.equal((await call("/wallet/fthx/send", { ...exactSend, amount: "0.1" }, { token })).status, 400);
  const sent = await call("/wallet/fthx/send", exactSend, { token });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.amount, "1");
  assert.equal(sent.body.decimals, 18);
  assert.deepEqual((await call("/wallet/fthx/send", exactSend, { token })).body, sent.body);
  assert.equal((await call("/wallet/fthx/send", { ...exactSend, amount: "2" }, { token })).status, 409);
  assert.equal((await call("/wallet/fthx", undefined, { token: otherToken })).body.balance, "1");
  app.setDollarWallet(() => ({ balance: { balance: "0", available: "0", reserved: "0" }, nonce: 0, transactions: [] }));
  const readOnly = await app.walletSummary(other.address);
  assert.equal(readOnly.fthxExact.balance, "1");
  assert.equal(readOnly.holdings.find(asset => asset.symbol === "FTHX").baseBalance, "1");
  assert.equal(readOnly.fthxTransfers[0].amount, "1");
  const exactEntries = await call(`/ledger/FTHX/entries?exact=1&address=${other.address}`, undefined, { prefix: "/api/notes" });
  assert.equal(exactEntries.status, 200);
  assert.equal(exactEntries.body.decimals, 18);
  assert.equal(exactEntries.body.entries[0].amount, "1");
  assert.equal((await call("/world-markets", undefined, { host: "ex.featheral.com" })).status, 503);
  const world = require("../../database/sqlite").open(":memory:");
  t.after(() => world.close());
  world.exec(`CREATE TABLE market_fills(id INTEGER PRIMARY KEY,asset TEXT,quantity INTEGER,dollars INTEGER,price REAL,time INTEGER,venue TEXT,buyer TEXT,seller TEXT)`);
  world.prepare("INSERT INTO market_fills VALUES(1,'wood',2,1,999999,?,'players','private-buyer','private-seller')").run(Date.now() - 86400000 * 40);
  app.setWorldMarketsSource(world);
  for (const host of ["ex.featheral.com", "notes.featheral.com"]) {
    const catalog = await call("/world-markets", undefined, { host });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers["cache-control"], "no-store");
    assert.equal(catalog.body.markets[0].symbol, "WORLD:wood");
    const history = await call("/world-markets/wood/history?interval=all", undefined, { host });
    assert.equal(history.body.candles[0].quoteVolume, "10000000000000000");
    const executions = await call("/world-trades?asset=wood&interval=all", undefined, { host });
    assert.equal(executions.body.rows[0].id, "world:market:1");
    assert.equal(executions.body.rows[0].settlement, "historical-recorded");
    assert.equal(executions.body.rows[0].price.numerator, "10000000000000000");
    const tape = await call("/market-tape?symbol=WORLD:wood&interval=all", undefined, { host });
    assert.equal(tape.body.rows[0].output, "10000000000000000");
    assert.equal(tape.body.rows[0].toDecimals, 18);
    const trending = await call("/trending", undefined, { host });
    assert.equal(trending.body.worldMarkets[0].history.candles.length, 1, "Legacy charts explicitly use all recorded history.");
    assert.equal(trending.body.worldMarkets[0].history.interval, "all");
    assert.doesNotMatch(JSON.stringify({ catalog, executions, history, tape, trending }), /private-buyer|private-seller|transaction_data/);
  }
  const terminal = await call("/trading/markets", undefined, { host: "ex.featheral.com" });
  assert.equal(terminal.body.markets.find(market => market.symbol === "WORLD:wood").inventoryOnly, true);
  assert.equal((await call("/world-markets", undefined, { host: "untrusted.invalid" })).status, 404);
  assert.equal((await call("/world-trades?asset=..", undefined, { host: "ex.featheral.com" })).status, 400);
  assert.equal((await call("/world-markets/wood/history?interval=never", undefined, { host: "ex.featheral.com" })).status, 400);
  assert.equal((await call("/trading/quote", { symbol: "WORLD:wood", side: "buy", amount: "1" }, { host: "ex.featheral.com" })).status, 409);
});
