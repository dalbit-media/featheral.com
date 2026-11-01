const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("node:child_process");
const { createTokenApi } = require("../services/token-api/server");
const { createWorldApi } = require("../services/social-ledger/api");

const root = path.resolve(__dirname, "..");
const localEnvFile = path.join(root, ".env");
if (fs.existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json" };
const sitesRoot = path.join(root, "sites");
// One process serves all four sites by host name; only files under sites/ are ever served.
const SITES = ["foundation", "gold", "dollar", "world"];
const api = createTokenApi();
const world = createWorldApi({ fthLedger: api.ledger });
const gameApiPort = Number(process.env.FEATHERAL_API_PORT) || 3001;
const gameApiOrigin = process.env.APP_ORIGIN || `http://world.localhost:${port}`;
const gameApi = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
  cwd: path.join(sitesRoot, "world", "featheral"),
  env: { ...process.env, APP_ORIGIN: gameApiOrigin, PORT: String(gameApiPort), WORLD_PROFILE_API_ORIGIN: `http://127.0.0.1:${port}` },
  stdio: "inherit",
});
let shuttingDown = false;
gameApi.on("error", (error) => console.error("Could not start the Featheral game API:", error));
gameApi.on("exit", (code, signal) => {
  if (!shuttingDown) console.error(`Featheral game API exited unexpectedly (code ${code}, signal ${signal}).`);
});
api.start();
world.start();

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

const server = http.createServer(async (req, res) => {
  try {
    if (await world.handle(req, res)) return;
    if (await api.handle(req, res)) return;
    const url = new URL(req.url, "http://x");
    const hostname = new URL(`http://${req.headers.host || "localhost"}`).hostname;
    const site = siteFor(hostname);
    if (site === "world" && url.pathname.startsWith("/api/")) return proxyGameApi(req, res);
    let p = decodeURIComponent(url.pathname);
    // The FTH$ wallet lives on the Dollar site; every site serves its own /admin/ console.
    if (site !== "dollar" && (p === "/wallet" || p.startsWith("/wallet/"))) return redirect(res, siteUrl(req, "dollar", "/wallet/") + url.search);
    if (["/wallet", "/admin", "/explorer", "/ledger", "/play"].includes(p)) return redirect(res, p + "/" + url.search, 301);
    if (site === "world" && p === "/about") return redirect(res, "/about/" + url.search, 301);
    let base = path.join(sitesRoot, site);
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

function proxyGameApi(req, res) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: gameApiPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${gameApiPort}` },
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", (error) => {
    console.error("Featheral game API proxy failed:", error);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Featheral game API is unavailable." }));
      return;
    }
    res.end();
  });
  req.pipe(upstream);
}

server.listen(port, host, () => {
  const local = (site) => `http://${site === "foundation" ? "" : `${site}.`}localhost:${port}/`;
  console.log(`Featheral sites (${api.mode} FTH$ ledger node ${api.nodeId}):`);
  console.log(`  Foundation  ${local("foundation")}  ·  admin ${local("foundation")}admin/`);
  console.log(`  Gold        ${local("gold")}  ·  admin ${local("gold")}admin/`);
  console.log(`  Dollar      ${local("dollar")}  ·  wallet ${local("dollar")}wallet/  ·  explorer ${local("dollar")}explorer/  ·  admin ${local("dollar")}admin/`);
  console.log(`  World       ${local("world")}  ·  ledger ${local("world")}ledger/  ·  admin ${local("world")}admin/`);
});

function shutdown() {
  shuttingDown = true;
  world.close();
  api.close();
  gameApi.kill("SIGTERM");
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
