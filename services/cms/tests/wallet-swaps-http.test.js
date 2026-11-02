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
  const load = vm.runInThisContext(`(function(require,__dirname,module){${fs.readFileSync(serverFile, "utf8")}\nreturn {app,creation,dollarExchange};})`, { filename: serverFile });
  const { app, creation, dollarExchange } = load(name => {
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
  for (const [address, amount] of [[owner, 1000], [require("../../notes/game-funds").SYSTEM_TREASURY_ACCOUNT, 1000000]])
    creation.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',0,'test')").run(address, amount);
  creation.markets.fund("FTHA", "FUND FTHA 1000000 FTHX 1000000 NOTES");
  const challenge = (await call("/challenge", { address: owner })).body;
  const token = (await call("/login", { address: owner, signature: await wallet.signMessage(challenge.message) })).body.token;
  const input = { from: "FTHX", to: "FTHA", amount: "100" };
  assert.equal((await call("/wallet/swaps/quote", input, { origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await call("/wallet/swaps/quote", input, { host: "notes.featheral.com" })).status, 403);
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
  assert.equal(creation.notes.balance(owner), 900);
  assert.equal(creation.notes.balance(owner, "FTHA"), 99);
  assert.equal(dollarExchange.account(owner).requests.length, 0);
  assert.equal((await call(`/wallet/swaps/${id}/cancel`, {}, { token })).status, 409);
  const history = await call("/markets/FTHA/history");
  assert.equal(history.body.candles[0].quoteVolume, "100");
  const stats = await call("/trending", undefined, { host: "stats.featheral.com" });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.notes.find(note => note.symbol === "FTHS").circulating, "0");
  assert.equal((await call("/challenge", { address: owner }, { host: "stats.featheral.com" })).status, 404);
  const appHost = { host: "app.localhost", prefix: "/api/intranet" };
  app.setWorkspaceProfiles(address => ({ address, username: "GatewayProfile", avatar: "" }));
  const appChallenge = (await call("/challenge", { address: owner }, appHost)).body;
  const appLogin = await call("/login", { address: owner, signature: await wallet.signMessage(appChallenge.message) }, appHost);
  assert.equal(appLogin.status, 200);
  const cookie = appLogin.headers["set-cookie"][0].split(";")[0];
  assert.equal((await call("/me", undefined, { ...appHost, cookie })).body.profile.username, "GatewayProfile");
  assert.equal((await call("/silver", undefined, { host: "silver.localhost", prefix: "/api/intranet" })).body.supply, 0);
});
