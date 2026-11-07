const deploymentManifestFile = require("node:path").join(__dirname, "..", ".deployment-hosts.json");
const deploymentManifest = require("node:fs").existsSync(deploymentManifestFile)
  ? JSON.parse(require("node:fs").readFileSync(deploymentManifestFile, "utf8")) : null;
if (deploymentManifest && (!Array.isArray(deploymentManifest.hosts) || !deploymentManifest.hosts.length
  || typeof deploymentManifest.primary !== "boolean" || deploymentManifest.hosts.some(host => typeof host !== "string"
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))
  || [["uploadLimitMiB", 1, 1024], ["requestTimeoutSeconds", 5, 3600]].some(([key, min, max]) =>
    deploymentManifest[key] !== undefined && (!Number.isInteger(deploymentManifest[key])
      || deploymentManifest[key] < min || deploymentManifest[key] > max)))) throw new Error("Invalid deployment hostname or HTTP limit assignment.");
if (deploymentManifest?.hosts.length === 1 && deploymentManifest.hosts[0] === "db.featheral.com") {
  const root = require("node:path").resolve(__dirname, "..");
  const settings = require("node:fs").existsSync(require("node:path").join(root, "data", "system-database"))
    ? require("../services/operations/runtime") : {
      value: { uploadLimitMiB: deploymentManifest.uploadLimitMiB || 16, requestTimeoutSeconds: deploymentManifest.requestTimeoutSeconds || 90 },
      replica: require("../services/operations/replica").readReplica(root),
      listeners: new Set(), environment: () => require("../services/operations/replica").replicaEnvironment(root, { HOST: "127.0.0.1", PORT: "8080" }),
    };
  const env = settings.environment();
  require("../services/operations/configuration").assertDatabaseConfiguration(root);
  const databaseServer = require("../services/database/server").createSiteServer({
    root, settings, hosts: deploymentManifest.hosts,
  });
  const maintenance = require("../services/operations/storage-cleanup").startStorageMaintenance(root);
  databaseServer.listen(Number(env.PORT) || 8080, env.HOST || "127.0.0.1", () => console.log("Featheral database site/API ready (no financial writers)."));
  const stop = () => { maintenance.close(); databaseServer.close(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
} else {
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable, pipeline } = require("node:stream");
const { createGoldApi } = require("../services/gold/server");
const { createDollarApi } = require("../services/notes/dollar");
const { gameSigningKey, ledgerFunds, liquidityTargets } = require("../services/notes/game-funds");
const { activateLiveReserve } = require("../services/gold/activation");
const { createWorldApi } = require("../services/media/api");
const { SqliteStore } = require("../sites/world.featheral.com/play/server/store.ts");
const { defaultClockSpeed } = require("../sites/world.featheral.com/play/src/environment.ts");
const { createApi } = require("../sites/world.featheral.com/play/server/http.ts");
const { worldProfileReader } = require("../sites/world.featheral.com/play/server/world-profile.ts");
const { requestPolicy, configureServer } = require("../services/operations/http");
const runtimeSettings = require("../services/operations/runtime");
const env = runtimeSettings.environment();
if (deploymentManifest && !deploymentManifest.primary
  && (env.FTH_LEDGER_MODE !== "reader" || env.WORLD_LEDGER_MODE !== "reader" || (env.GOLD_RESERVE_MODE || "disabled") !== "disabled"))
  throw new Error("A separate non-DB server requires preconfigured Dollar/World readers and disabled Gold reserves. Never start a second financial writer.");

const root = path.resolve(__dirname, "..");
require("../services/operations/configuration").assertDatabaseConfiguration(root);
const port = Number(env.PORT) || 8080;
const host = env.HOST || "127.0.0.1";
const reserveMode = env.GOLD_RESERVE_MODE || "disabled";
if (!["disabled", "isolated", "live"].includes(reserveMode)) throw new Error("GOLD_RESERVE_MODE supports disabled, isolated or live.");
let reserveDirectory;
if (reserveMode === "isolated") {
  if (!env.GOLD_RESERVE_TEST_DIR || host !== "127.0.0.1") throw new Error("Isolated reserves require GOLD_RESERVE_TEST_DIR and loopback binding.");
  if (!env.PORT || !Number.isInteger(port) || port < 1 || port > 65535 || port === 8080) throw new Error("Reserve tests require an explicit separate port, not live port 8080.");
  reserveDirectory = path.resolve(env.GOLD_RESERVE_TEST_DIR);
  const testRoot = path.join(root, "data", "reserve-tests");
  const relative = path.relative(testRoot, reserveDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Reserve tests require a named directory under data/reserve-tests.");
  }
  fs.mkdirSync(reserveDirectory, { recursive: true });
  if (fs.realpathSync(reserveDirectory).toLowerCase() !== reserveDirectory.toLowerCase()) throw new Error("Reserve test directories cannot contain junctions or symlinks.");
  const marker = path.join(reserveDirectory, "isolated-reserve.json");
  if (fs.existsSync(marker)) {
    if (fs.readFileSync(marker, "utf8") !== '{"isolatedReserve":true}\n') throw new Error("Invalid isolated reserve directory marker.");
  } else {
    if (fs.readdirSync(reserveDirectory).length) throw new Error("A new reserve test directory must be empty.");
    fs.writeFileSync(marker, '{"isolatedReserve":true}\n', { flag: "wx" });
  }
  const directories = [reserveDirectory];
  for (const directory of directories) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), info = fs.lstatSync(file);
      if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error("Isolated reserve contents cannot contain links to other files or directories.");
      if (info.isDirectory()) directories.push(file);
      else if (!info.isFile()) throw new Error("Unexpected isolated reserve directory entry.");
    }
  }
  const origin = new URL(env.APP_ORIGIN || `http://world.localhost:${port}`);
  if ((!["localhost", "127.0.0.1"].includes(origin.hostname) && !origin.hostname.endsWith(".localhost"))
    || origin.protocol !== "http:" || origin.port !== String(port) || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password) throw new Error("Reserve tests require a local HTTP APP_ORIGIN matching the isolated port.");
  env.DOLLAR_GAME_DIR = path.join(reserveDirectory, "game");
  env.FTH_LEDGER_DIR = path.join(reserveDirectory, "dollar");
  env.WORLD_LEDGER_DIR = path.join(reserveDirectory, "world");
  env.FTH_LEDGER_MODE = "writer";
  env.WORLD_LEDGER_MODE = "writer";
  for (const [prefix, directory] of [["FTH_LEDGER", "dollar-writer"], ["WORLD_LEDGER", "world-writer"]]) {
    const signing = gameSigningKey(path.join(reserveDirectory, directory));
    env[`${prefix}_SIGNING_PRIVATE_KEY`] = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    env[`${prefix}_WRITER_PUBLIC_KEY`] = signing.publicKey;
    env[`${prefix}_NODE_ID`] = "isolated-reserve-test";
  }
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json" };
const sitesRoot = path.join(root, "sites");
// Static sites and the private-data-backed CMS share one hostname gateway.
const SITES = ["foundation", "gold", "silver", "app", "db", "dollar", "world", "media", "ledger", "admin", "cms", "x", "ex", "notes", "wallet", "sites", "stats", "pay"];
const cms = require("../services/cms/server");
const { injectTelemetry } = require("../services/cms/lib/telemetry");
const gameDirectory = path.resolve(env.DOLLAR_GAME_DIR || path.join(root, "data", "dollar-game"));
const reader = env.FTH_LEDGER_MODE === "reader";
const keys = reader ? null : gameSigningKey(gameDirectory);
if (reserveMode === "live" && reader) throw new Error("Live reserve allocation requires the Dollar writer.");
const goldKeys = reserveMode === "live" ? gameSigningKey(path.join(root, "data", "gold-reserve"))
  : reserveDirectory ? gameSigningKey(path.join(reserveDirectory, "gold")) : null;
let store;
const gold = createGoldApi({ env });
const api = createDollarApi({ gold, profiles: cms.database.profiles, env: { ...env, FTH_GAME_PUBLIC_KEY: keys?.publicKey,
  FTH_GOLD_PUBLIC_KEY: reserveMode === "isolated" ? goldKeys?.publicKey : undefined }, beforeLedgerMutation: () => store?.recoverFunds(), exchangeSigningKey: keys?.privateKey });
if (reserveMode === "live") activateLiveReserve(api.ledger, keys.privateKey, goldKeys.publicKey, liquidityTargets());
if (api.ledger.genesis.goldPublicKey && !goldKeys && !runtimeSettings.replica) throw new Error("This ledger requires its Gold reserve engine. Restore GOLD_RESERVE_MODE and the original Gold key.");
const reserveEngine = goldKeys ? gold.enableReserve(api.ledger, goldKeys.privateKey, () => store?.recoverFunds()) : null;
const world = createWorldApi({ env, fthLedger: api.ledger, sqlite: cms.database.sqlite, profiles: cms.database.profiles, profileHandler: async (req, res) => {
  const original = req.url;
  try { req.url = "/api/v1/notes/profiles"; return await api.handle(req, res); }
  finally { req.url = original; }
} });
cms.setOperationsHandler(async (req, res) => {
  if (await gold.handle(req, res)) return;
  if (await world.handle(req, res)) return;
  if (await api.handle(req, res)) return;
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown administration API route" }));
});
const gameApiOrigin = require("../services/operations/origin").worldOrigin(env, deploymentManifest, port);
if (!reader) store = new SqliteStore(path.join(gameDirectory, "game.sqlite"), Date.now, defaultClockSpeed, ledgerFunds(api.ledger, keys.privateKey, reserveEngine));
const gameApi = store ? createApi(store, gameApiOrigin, worldProfileReader(`http://127.0.0.1:${port}`), "world") : null;
const dollarGameApi = store ? createApi(store, gameApiOrigin, undefined, "dollar") : null;
cms.setCreationPayments(api.creationPayments);
cms.setWorkspaceProfiles(address => cms.database.profiles.get(address));
cms.setNoteSupply(api.noteSupply);
cms.setDollarWallet(api.walletAccount, api.exchangeSettlement);
const ethereumWalletCache = new Map();
cms.setWalletSources(async (owner, publicWorldAccount) => {
  let ethereum = null, ethereumError = null, worldFunds = null, worldError = null;
  const readEthereum = async () => {
    try {
      const cached = ethereumWalletCache.get(owner);
      if (cached && Date.now() - cached.at < 30000) ethereum = cached.value;
      else {
        ethereum = await gold.walletBalance(owner);
        if (ethereumWalletCache.size >= 1000) ethereumWalletCache.delete(ethereumWalletCache.keys().next().value);
        ethereumWalletCache.set(owner, { at: Date.now(), value: ethereum });
      }
    } catch (error) { console.error("Wallet Ethereum FTHG unavailable:", error); ethereumError = error.message; }
  };
  const readWorld = async () => {
    if (!store) {
      worldError = "World gameplay balances are unavailable on this read-only server. Use the World writer to view gameplay funds.";
      return;
    }
    try {
      worldFunds = store.walletWorldView(owner);
      if (!worldFunds && publicWorldAccount) worldFunds = { accountId: publicWorldAccount, wallet: null,
        available: api.walletAccount(publicWorldAccount).balance.available, mode: "guest", source: "explicit-public-account" };
      if (worldFunds) worldFunds.duplicate = worldFunds.accountId === require("../services/fth-ledger/ledger").walletAccountId(owner);
    } catch (error) { console.error("Wallet World funds unavailable:", error); worldError = error.message; }
  };
  const [native] = await Promise.all([gold.nativeBalance(owner), readEthereum(), readWorld()]);
  return { ethereum, ethereumError, native, world: worldFunds, worldError };
});
let portfolioGoldCache, portfolioGoldAt = 0;
cms.setPortfolioGold(async () => {
  if (Date.now() - portfolioGoldAt < 30000) return portfolioGoldCache;
  const [bridge, market] = await Promise.allSettled([
    gold.stats(), gold.marketPrice(),
  ]);
  if (bridge.status === "rejected") console.error("Portfolio Gold bridge unavailable:", bridge.reason);
  if (market.status === "rejected") console.error("Portfolio FTHG/USD feed unavailable:", market.reason);
  portfolioGoldCache = { ...(bridge.status === "fulfilled" ? bridge.value : {}),
    usdMarket: market.status === "fulfilled" ? market.value : null,
    error: [bridge, market].filter(result => result.status === "rejected").map(result => result.reason.message).join("; ") || null };
  portfolioGoldAt = Date.now();
  return portfolioGoldCache;
});

function siteFor(hostname) {
  const label = hostname.split(".")[0];
  return SITES.includes(label) && label !== "foundation" ? label : "foundation";
}

// gold.featheral.com -> featheral.com, gold.localhost -> localhost; IP hosts map to localhost.
function baseHost(hostname) {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return "localhost";
  const labels = hostname.split(".");
  return SITES.includes(labels[0]) && labels.length > 1 ? labels.slice(1).join(".") : hostname;
}

function siteUrl(req, site, pathname) {
  const requestHost = new URL(`http://${req.headers.host || `localhost:${port}`}`);
  const base = baseHost(requestHost.hostname);
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const portPart = requestHost.port ? `:${requestHost.port}` : "";
  return `${proto}://${site === "foundation" ? base : `${site}.${base}`}${portPart}${pathname}`;
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, "Cache-Control": "no-store" });
  res.end();
}
async function forwardGame(req, res) {
  const upstream = env.FTH_LEDGER_UPSTREAM_URL;
  if (!upstream) throw new Error("Reader game requests require the Dollar writer upstream URL.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  res.on("close", () => controller.abort());
  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Request body too large." })); return; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const headers = { host: new URL(gameApiOrigin).host };
    for (const name of ["origin", "cookie", "content-type", "x-csrf-token", "sec-fetch-site", "accept"]) if (req.headers[name]) headers[name] = req.headers[name];
    const response = await fetch(new URL(req.url, upstream), { method: req.method, headers, body, redirect: "manual", signal: controller.signal });
    clearTimeout(timer);
    for (const [name, value] of response.headers) if (!["set-cookie", "content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) res.setHeader(name, value);
    if (response.headers.getSetCookie().length) res.setHeader("Set-Cookie", response.headers.getSetCookie());
    res.writeHead(response.status);
    if (!response.body) { res.end(); return; }
    pipeline(Readable.fromWeb(response.body), res, error => { if (error && !controller.signal.aborted) console.error("Dollar writer game stream failed:", error); });
  } catch (error) {
    console.error("Dollar writer game forwarding failed:", error);
    if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Dollar writer is unavailable." })); }
    else res.destroy(error);
  } finally { clearTimeout(timer); }
}

const pay = require("../services/pay/server").createPayApi({ siteUrl });
const server = http.createServer(async (req, res) => {
  if (!requestPolicy(req, res, cms.operationsSettings)) return;
  cms.serverProfile?.recordRequest(req, res);
  try {
    const url = new URL(req.url, "http://x");
    const hostname = new URL(`http://${req.headers.host || "localhost"}`).hostname;
    const site = siteFor(hostname);
    if (site !== "admin") injectTelemetry(res);
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ status: "ok", release: path.basename(root) }));
    }
    const internalProfileRead = req.method === "GET" && /^\/api\/v1\/profiles\/0x[0-9a-f]{40}$/i.test(url.pathname)
      && ["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname)
      && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (deploymentManifest && !deploymentManifest.hosts.includes(hostname)
      && !(site === "cms" && deploymentManifest.hosts.includes("admin.featheral.com")) && !internalProfileRead) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Site is assigned to another server." }));
    }
    if (url.pathname.startsWith("/api/telemetry/")) return cms.telemetryRequest(req, res);
    if (site === "cms") return redirect(res, siteUrl(req, "admin", url.pathname + url.search), 301);
    if (site === "db" && url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/v1/db/")) return cms(req, res);
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unknown database service endpoint." }));
    }
    if (site === "pay" && url.pathname.startsWith("/api/")) {
      if (await pay.handle(req, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unknown payment service endpoint." }));
    }
    if (url.pathname.startsWith("/api/intranet/") || url.pathname.startsWith("/api/silver/")) return cms(req, res);
    if (site === "ledger" && url.pathname.startsWith("/api/notes/ledger/")) return cms(req, res);
    if (site === "ledger" && url.pathname === "/explorer")
      return redirect(res, siteUrl(req, "ledger", "/explorer/" + url.search), 301);
    if (site !== "admin" && /^\/api\/v1\/(?:world|media)\/profile/.test(url.pathname) && await world.handle(req, res)) return;
    if (["app", "silver", "db", "ledger", "pay"].includes(site) && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/shared/")) {
      const directory = site === "ledger" && (url.pathname === "/fth.js" || url.pathname.startsWith("/explorer/"))
        ? path.join(sitesRoot, "dollar.featheral.com")
        : path.join(sitesRoot, `${site}.featheral.com`);
      let pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.resolve(directory, "." + pathname);
      if (!file.startsWith(directory + path.sep)) {
        res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Site resource not found.");
      }
      let fileStat;
      try { fileStat = await fs.promises.stat(file); }
      catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Site resource not found.");
        }
        throw error;
      }
      if (!fileStat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Site resource not found.");
      }
      const content = await fs.promises.readFile(file);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      return res.end(content);
    }
    if (site !== "admin" && url.pathname.startsWith("/api/v1/gold/") && await gold.handle(req, res)) return;
    if (site !== "admin" && (url.pathname.startsWith("/api/v1/notes/") || site === "notes"
      && (url.pathname === "/api/v1/fth" || url.pathname.startsWith("/api/v1/fth/")))
      && await api.handle(req, res)) return;
    const walletRoot = path.join(sitesRoot, "wallet.featheral.com");
    if (site === "gold" && ["/conversion", "/conversion/", "/conversion/index.html"].includes(url.pathname))
      return redirect(res, siteUrl(req, "ex", "/gold-channel/") + url.search, 302);
    if (site === "wallet" && url.pathname === "/ethereum/")
      return redirect(res, siteUrl(req, "ex", "/ethereum/") + url.search, 302);
    if (site === "ex") {
      if (url.pathname.startsWith("/api/v1/gold/") && await gold.handle(req, res)) return;
      const channels = {
        "/ethereum/": path.join(walletRoot, "ethereum", "index.html"),
        "/ethereum/wallet.js": path.join(walletRoot, "ethereum", "wallet.js"),
        "/ethereum/staking.js": path.join(walletRoot, "ethereum", "staking.js"),
        "/gold-channel/": path.join(sitesRoot, "gold.featheral.com", "conversion", "index.html"),
        "/gold-channel/reserve.js": path.join(sitesRoot, "gold.featheral.com", "conversion", "reserve.js"),
        "/reserve.css": path.join(sitesRoot, "gold.featheral.com", "reserve.css"),
        "/reserve-view.js": path.join(sitesRoot, "gold.featheral.com", "reserve-view.js"),
        "/buy.js": path.join(sitesRoot, "gold.featheral.com", "buy.js"),
        "/fth.js": path.join(sitesRoot, "dollar.featheral.com", "fth.js"),
        "/ethers.js": path.join(root, "node_modules", "ethers", "dist", "ethers.umd.min.js"),
      };
      if (Object.hasOwn(channels, url.pathname)) {
        const file = channels[url.pathname];
        if (file.endsWith(".html")) res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        res.writeHead(200, { "Content-Type": types[path.extname(file)], "Cache-Control": "no-store" });
        const content = fs.readFileSync(file);
        return res.end(file.endsWith(".html") ? content.toString().replace('href="/conversion/"', 'href="/gold-channel/"') : content);
      }
    }
    if (["/shared/wallet-profile.js", "/shared/wallet-profile.css"].includes(url.pathname)) {
      if (site !== "wallet") return redirect(res, siteUrl(req, "wallet", url.pathname), 302);
      res.writeHead(200, { "Content-Type": types[path.extname(url.pathname)], "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(walletRoot, path.basename(url.pathname))));
    }
    if (url.pathname.startsWith("/shared/wallet/")) {
      const name = url.pathname.slice("/shared/wallet/".length);
      const assets = ["wallet-app.html", "wallet-app.css", "wallet-app.js", "embed.js", "vault.js", "portfolio-view.js", "site-sign-in.js", "ethers.js"];
      if (!assets.includes(name)) { res.writeHead(404); return res.end("Not found"); }
      const file = name === "ethers.js" ? path.join(root, "node_modules", "ethers", "dist", "ethers.umd.min.js") : path.join(walletRoot, name);
      if (name.endsWith(".html")) res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.writeHead(200, { "Content-Type": types[path.extname(file)], "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(file));
    }
    if (url.pathname.startsWith("/api/creation/")) return cms(req, res);
    if (site === "wallet" || url.pathname.startsWith("/api/wallet/accounts/") || url.pathname === "/api/wallet/ui") {
      const summary = url.pathname.match(/^\/api\/wallet\/accounts\/(0x[0-9a-fA-F]{40})$/);
      if (url.pathname.startsWith("/api/wallet/accounts/")) {
        const origin = req.headers.origin;
        if (origin && !require("../services/wallet/ui").allowedOrigin(origin)) {
          res.writeHead(403, { "Content-Type": types[".json"] });
          return res.end(JSON.stringify({ error: "Unsupported wallet reader origin." }));
        }
        if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
        if (req.method !== "GET" || !summary) {
          res.writeHead(400, { "Content-Type": types[".json"] });
          return res.end(JSON.stringify({ error: "Use GET with a valid Ethereum wallet address." }));
        }
        const result = await cms.walletSummary(summary[1], url.searchParams.get("worldAccount"));
        res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
        return res.end(JSON.stringify(result));
      }
      if (url.pathname === "/api/wallet/ui") {
        const config = require("../services/wallet/ui").walletUi(url.searchParams);
        res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
        return res.end(JSON.stringify(config));
      }
      if (url.pathname.startsWith("/api/creation/")) return cms(req, res);
      if (url.pathname.startsWith("/api/v1/dollar/") && await api.handle(req, res)) return;
      if (url.pathname.startsWith("/api/v1/gold/") && await gold.handle(req, res)) return;
      const assets = { "/": "wallet-app.html", "/wallet/": "wallet-app.html", "/wallet": "wallet-app.html",
        "/wallet-app.js": "wallet-app.js", "/wallet-app.css": "wallet-app.css", "/embed.js": "embed.js",
        "/vault.js": "vault.js", "/portfolio-view.js": "portfolio-view.js", "/site-sign-in.js": "site-sign-in.js",
        "/exchange-auth.html": "exchange-auth.html", "/exchange-auth.js": "exchange-auth.js",
        "/ethereum/": path.join("ethereum", "index.html"), "/ethereum/wallet.js": path.join("ethereum", "wallet.js"),
        "/ethereum/staking.js": path.join("ethereum", "staking.js") };
      if (Object.hasOwn(assets, url.pathname)) {
        if (assets[url.pathname].endsWith(".html")) {
          require("../services/wallet/ui").walletUi(url.searchParams);
          res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        }
        res.writeHead(200, { "Content-Type": types[path.extname(assets[url.pathname])], "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(path.join(walletRoot, assets[url.pathname])));
      }
      if (site === "wallet" && url.pathname === "/fth.js") {
        res.writeHead(200, { "Content-Type": types[".js"], "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(path.join(sitesRoot, "dollar.featheral.com", "fth.js")));
      }
      if (site === "wallet" && url.pathname === "/ethers.js") {
        res.writeHead(200, { "Content-Type": types[".js"], "Cache-Control": "public, max-age=86400" });
        return res.end(fs.readFileSync(path.join(root, "node_modules", "ethers", "dist", "ethers.umd.min.js")));
      }
      if (site === "wallet" && url.pathname.startsWith("/shared/")) {
        const file = path.resolve(root, "." + url.pathname);
        if (!file.startsWith(path.join(root, "shared") + path.sep)) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
        return res.end(fs.readFileSync(file));
      }
      if (["/wallet/wallet.js", "/wallet/staking.js"].includes(url.pathname))
        return redirect(res, siteUrl(req, "wallet", url.pathname.replace("/wallet/", "/ethereum/")), 301);
    }
    if (!["wallet", "admin"].includes(site)) {
      if (["/wallet", "/wallet/"].includes(url.pathname)) {
        res.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(path.join(walletRoot, "host.html"), "utf8"));
      }
      if (url.pathname === "/wallet-host.js") {
        res.writeHead(200, { "Content-Type": types[path.extname(url.pathname)], "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(path.join(walletRoot, "wallet-host.js")));
      }
      if (["/wallet-app.js", "/wallet-app.css"].includes(url.pathname)) {
        return redirect(res, siteUrl(req, "wallet", url.pathname), 301);
      }
    }
    if (["dollar", "ex", "notes"].includes(site)) {
      if (url.pathname.startsWith("/api/v1/dollar/") && await api.handle(req, res)) return;
    }
    if (site === "dollar" && url.pathname.startsWith("/api/creation/")) return cms(req, res);
    if (["foundation", "gold", "dollar", "world", "media"].includes(site)
        && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
      return redirect(res, siteUrl(req, "admin", `/#/operations/${site === "media" ? "world" : site}`), 301);
    }
    if (!["foundation", "gold", "dollar", "world", "media", "ledger"].includes(site) ||
        (site === "foundation" && cms.resolveHostname(hostname))) {
      cms(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/dollar/game/")) {
      if (dollarGameApi) dollarGameApi.emit("request", req, res);
      else await forwardGame(req, res);
      return;
    }
    if (await gold.handle(req, res)) return;
    if (await world.handle(req, res)) return;
    if (await api.handle(req, res)) return;
    if (url.pathname === "/api/session" || url.pathname.startsWith("/api/chat") || (site === "world" && url.pathname.startsWith("/api/"))) {
      if (gameApi) gameApi.emit("request", req, res);
      else await forwardGame(req, res);
      return;
    }
    if (site === "dollar" && url.pathname.startsWith("/explorer/"))
      return redirect(res, siteUrl(req, "ledger", url.pathname + url.search), 301);
    let p = decodeURIComponent(url.pathname);
    if (!["dollar", "world", "media"].includes(site) && (p === "/wallet" || p.startsWith("/wallet/"))) return redirect(res, siteUrl(req, "world", "/bank/") + url.search);
    if (["/wallet", "/admin", "/explorer", "/ledger", "/play"].includes(p)) return redirect(res, p + "/" + url.search, 301);
    let base = path.join(sitesRoot, site === "foundation" ? "featheral.com" : `${site}.featheral.com`);
    if (site === "world" && (p.startsWith("/wallet/") || p === "/fth.js")) base = path.join(sitesRoot, "dollar.featheral.com");
    if (!p.startsWith("/shared/") && !p.startsWith("/wallet/") && p !== "/fth.js") {
      const resource = require("./site-routing").worldResource(site, p);
      if (resource?.redirect) {
        const target = new URL(siteUrl(req, resource.redirect, resource.pathname));
        target.search = url.search;
        return redirect(res, target.href, 301);
      }
      if (resource) { base = path.join(sitesRoot, resource.directory); p = resource.pathname; }
    }
    if (p.startsWith("/shared/")) {
      base = path.join(root, "shared");
      p = p.slice("/shared".length);
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.resolve(base, "." + p);
    if (!file.startsWith(base + path.sep)) { res.writeHead(404); return res.end("Not found"); }
    const contentHost = site === "foundation" ? "featheral.com" : `${site}.featheral.com`;
    if (path.extname(file) === ".html" && base === path.join(sitesRoot, contentHost)
        && (p === "/index.html" || /^\/(docs|governance)\/index\.html$/.test(p))) {
      if (!cms.hasSitePage(contentHost, p.slice(1))) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      const html = cms.renderSitePage(contentHost, p.slice(1));
      res.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-store" });
      return res.end(html);
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  } catch (error) {
    console.error("Request handler failed:", error);
    if (res.writableEnded) return;
    if (!res.headersSent) {
      if (error.status === 400) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: error.message }));
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
      return;
    }
    res.end();
  }
});


async function start() {
  if (reserveEngine) {
    await reserveEngine.initialize();
    if (BigInt(reserveEngine.status().cap) > 0n) await reserveEngine.activatePricing();
  }
  api.start();
  world.start();
  cms.startMaintenance();
  configureServer(server, cms.operationsSettings);
  server.listen(port, host, () => {
  const local = (site) => `http://${site === "foundation" ? "" : `${site}.`}localhost:${port}/`;
  console.log(`Featheral sites (${api.mode} FTH$ ledger node ${api.nodeId}):`);
  console.log(`  Foundation  ${local("foundation")}  ·  admin ${local("foundation")}admin/`);
  console.log(`  Gold        ${local("gold")}  ·  admin ${local("gold")}admin/`);
  console.log(`  Dollar      ${local("dollar")}  ·  wallet ${local("dollar")}wallet/  ·  explorer redirect ${local("dollar")}explorer/  ·  admin ${local("dollar")}admin/`);
  console.log(`  Ledger      ${local("ledger")}  ·  FTH$ explorer ${local("ledger")}explorer/`);
  console.log(`  World       ${local("world")}  ·  ledger ${local("world")}ledger/  ·  admin ${local("world")}admin/`);
  console.log(`  Admin       ${local("admin")}`);
  console.log(`  X           ${local("x")}`);
  console.log(`  Exchange    ${local("ex")}  (local demo; no real funds)`);
  if (reserveEngine) console.warn(`${reserveMode === "live" ? "LIVE OFF-CHAIN RESERVE" : "ISOLATED RESERVE TEST"}: pending allocations are not Ethereum transfers. Ethereum submission remains disabled.`);
  });
}
start().catch(error => { console.error("Server initialization failed:", error); shutdown(1); });

function shutdown(exitCode = 0) {
  cms.close();
  gameApi?.emit("close");
  dollarGameApi?.emit("close");
  store?.close();
  world.close();
  api.close();
  gold.close();
  cms.database?.sqlite.closeAll();
  server.close(() => process.exit(exitCode));
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
}
