const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable, pipeline } = require("node:stream");
const { createGoldApi } = require("../services/gold-api/server");
const { createDollarApi } = require("../services/dollar-api/server");
const { gameSigningKey, ledgerFunds, liquidityTargets } = require("../services/dollar-api/funds");
const { activateLiveReserve } = require("../services/gold-api/activation");
const { createWorldApi } = require("../services/social-ledger/api");
const { SqliteStore } = require("../sites/world/featheral/server/store.ts");
const { createApi } = require("../sites/world/featheral/server/http.ts");
const { worldProfileReader } = require("../sites/world/featheral/server/world-profile.ts");

const root = path.resolve(__dirname, "..");
const localEnvFile = path.join(root, ".env");
if (fs.existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "127.0.0.1";
const reserveMode = process.env.GOLD_RESERVE_MODE || "disabled";
if (!["disabled", "isolated", "live"].includes(reserveMode)) throw new Error("GOLD_RESERVE_MODE supports disabled, isolated or live.");
let reserveDirectory;
if (reserveMode === "isolated") {
  if (!process.env.GOLD_RESERVE_TEST_DIR || host !== "127.0.0.1") throw new Error("Isolated reserves require GOLD_RESERVE_TEST_DIR and loopback binding.");
  if (!process.env.PORT || !Number.isInteger(port) || port < 1 || port > 65535 || port === 8080) throw new Error("Reserve tests require an explicit separate port, not live port 8080.");
  reserveDirectory = path.resolve(process.env.GOLD_RESERVE_TEST_DIR);
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
  const origin = new URL(process.env.APP_ORIGIN || `http://world.localhost:${port}`);
  if ((!["localhost", "127.0.0.1"].includes(origin.hostname) && !origin.hostname.endsWith(".localhost"))
    || origin.protocol !== "http:" || origin.port !== String(port) || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password) throw new Error("Reserve tests require a local HTTP APP_ORIGIN matching the isolated port.");
  process.env.DOLLAR_GAME_DIR = path.join(reserveDirectory, "game");
  process.env.FTH_LEDGER_DIR = path.join(reserveDirectory, "dollar");
  process.env.WORLD_LEDGER_DIR = path.join(reserveDirectory, "world");
  process.env.FTH_LEDGER_MODE = "writer";
  process.env.WORLD_LEDGER_MODE = "writer";
  for (const [prefix, directory] of [["FTH_LEDGER", "dollar-writer"], ["WORLD_LEDGER", "world-writer"]]) {
    const signing = gameSigningKey(path.join(reserveDirectory, directory));
    process.env[`${prefix}_SIGNING_PRIVATE_KEY`] = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env[`${prefix}_WRITER_PUBLIC_KEY`] = signing.publicKey;
    process.env[`${prefix}_NODE_ID`] = "isolated-reserve-test";
  }
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json" };
const sitesRoot = path.join(root, "sites");
// One process serves all four sites by host name; only files under sites/ are ever served.
const SITES = ["foundation", "gold", "dollar", "world"];
const gameDirectory = path.resolve(process.env.DOLLAR_GAME_DIR || path.join(root, "data", "dollar-game"));
const reader = (process.env.FTH_LEDGER_MODE || process.env.TOKEN_LEDGER_MODE) === "reader";
const keys = reader ? null : gameSigningKey(gameDirectory);
if (reserveMode === "live" && reader) throw new Error("Live reserve allocation requires the Dollar writer.");
const goldKeys = reserveMode === "live" ? gameSigningKey(path.join(root, "data", "gold-reserve"))
  : reserveDirectory ? gameSigningKey(path.join(reserveDirectory, "gold")) : null;
let store;
const gold = createGoldApi();
const api = createDollarApi({ gold, env: { ...process.env, FTH_GAME_PUBLIC_KEY: keys?.publicKey,
  FTH_GOLD_PUBLIC_KEY: reserveMode === "isolated" ? goldKeys?.publicKey : undefined }, beforeLedgerMutation: () => store?.recoverFunds() });
if (reserveMode === "live") activateLiveReserve(api.ledger, keys.privateKey, goldKeys.publicKey, liquidityTargets());
if (api.ledger.genesis.goldPublicKey && !goldKeys) throw new Error("This ledger requires its Gold reserve engine. Restore GOLD_RESERVE_MODE and the original Gold key.");
const reserveEngine = goldKeys ? gold.enableReserve(api.ledger, goldKeys.privateKey, () => store?.recoverFunds()) : null;
const world = createWorldApi({ fthLedger: api.ledger });
const gameApiOrigin = process.env.APP_ORIGIN || `http://world.localhost:${port}`;
if (!reader) store = new SqliteStore(path.join(gameDirectory, "game.sqlite"), Date.now, process.argv.includes("--dev") ? 20 : 1, ledgerFunds(api.ledger, keys.privateKey, reserveEngine));
const gameApi = store ? createApi(store, gameApiOrigin, worldProfileReader(`http://127.0.0.1:${port}`), "world") : null;
const dollarGameApi = store ? createApi(store, gameApiOrigin, undefined, "dollar") : null;

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
  const upstream = process.env.FTH_LEDGER_UPSTREAM_URL || process.env.TOKEN_LEDGER_UPSTREAM_URL;
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const hostname = new URL(`http://${req.headers.host || "localhost"}`).hostname;
    const site = siteFor(hostname);
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
    let p = decodeURIComponent(url.pathname);
    if (!["dollar", "world"].includes(site) && (p === "/wallet" || p.startsWith("/wallet/"))) return redirect(res, siteUrl(req, "world", "/play/bank/") + url.search);
    if (["/wallet", "/admin", "/explorer", "/ledger", "/play"].includes(p)) return redirect(res, p + "/" + url.search, 301);
    if (site === "world" && p === "/about") return redirect(res, "/about/" + url.search, 301);
    let base = path.join(sitesRoot, site);
    if (site === "world" && (p.startsWith("/wallet/") || p === "/fth.js")) base = path.join(sitesRoot, "dollar");
    if (site === "world" && p === "/about/") {
      base = path.join(sitesRoot, "world", "featheral", "dist");
      p = "/about/";
    }
    if (site === "world" && p.startsWith("/play/")) {
      base = path.join(sitesRoot, "world", "featheral", "dist");
      p = p.slice("/play".length);
    }
    if (site === "world" && ["/robots.txt", "/sitemap.xml"].includes(p)) {
      base = path.join(sitesRoot, "world", "featheral", "dist");
    }
    if (p.startsWith("/shared/")) {
      base = path.join(sitesRoot, "shared");
      p = p.slice("/shared".length);
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.resolve(base, "." + p);
    if (!file.startsWith(base + path.sep)) { res.writeHead(404); return res.end("Not found"); }
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
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
      return;
    }
    res.end();
  }
});


async function start() {
  if (reserveEngine) await reserveEngine.initialize();
  api.start();
  world.start();
  server.listen(port, host, () => {
  const local = (site) => `http://${site === "foundation" ? "" : `${site}.`}localhost:${port}/`;
  console.log(`Featheral sites (${api.mode} FTH$ ledger node ${api.nodeId}):`);
  console.log(`  Foundation  ${local("foundation")}  ·  admin ${local("foundation")}admin/`);
  console.log(`  Gold        ${local("gold")}  ·  admin ${local("gold")}admin/`);
  console.log(`  Dollar      ${local("dollar")}  ·  wallet ${local("dollar")}wallet/  ·  explorer ${local("dollar")}explorer/  ·  admin ${local("dollar")}admin/`);
  console.log(`  World       ${local("world")}  ·  ledger ${local("world")}ledger/  ·  admin ${local("world")}admin/`);
  if (reserveEngine) console.warn(`${reserveMode === "live" ? "LIVE OFF-CHAIN RESERVE" : "ISOLATED RESERVE TEST"}: pending allocations are not Ethereum transfers. Ethereum submission remains disabled.`);
  });
}
start().catch(error => { console.error("Server initialization failed:", error); shutdown(1); });

function shutdown(exitCode = 0) {
  gameApi?.emit("close");
  dollarGameApi?.emit("close");
  store?.close();
  world.close();
  api.close();
  gold.close();
  server.close(() => process.exit(exitCode));
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
