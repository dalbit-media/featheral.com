"use strict";
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");
const { createHash, randomUUID } = require("node:crypto");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const express = require("express");
const { Notes } = require("../services/notes/ledger");
const { Creation } = require("../services/notes/creation");
const { workspaceApi } = require("../services/cms/lib/workspace-api");
const { configureServer } = require("../services/operations/http");

async function main() {
  const users = 1000, count = 1000, requestsPerSecond = 50, targetP95 = 500;
  const load = file => import(pathToFileURL(path.resolve(__dirname, "..", file)).href);
  const { SqliteStore } = await load("sites\\world.featheral.com\\play\\server\\store.ts");
  const { createApi } = await load("sites\\world.featheral.com\\play\\server\\http.ts");
  const { worldEpoch } = await load("sites\\world.featheral.com\\play\\src\\environment.ts");
  const { gameFundAccount } = await load("sites\\world.featheral.com\\play\\server\\funds.ts");
  const { marketAssets, isMarketResource, marketBasePrice, marketPriceFloor } = await load("sites\\world.featheral.com\\play\\src\\market.ts");
  const { monetaryPolicy } = await load("sites\\world.featheral.com\\play\\src\\monetary-policy.ts");
  const { dollarsUnits } = await load("sites\\world.featheral.com\\play\\src\\dollars.ts");
  const balances = new Map(), seeds = new Map(), committed = new Set();
  for (const asset of marketAssets) {
    const quantity = isMarketResource(asset) ? monetaryPolicy.rawInitialUnits : monetaryPolicy.itemInitialUnits;
    seeds.set(asset, { quantity });
    balances.set(gameFundAccount("pool", asset), BigInt(dollarsUnits(quantity * Math.max(marketBasePrice(asset), marketPriceFloor(asset)))) * 100000000000000n);
  }
  const supply = [...balances.values()].reduce((sum, amount) => sum + amount, 0n);
  const ledger = {
    available: account => (balances.get(account) || 0n).toString(),
    supply: () => supply.toString(), poolSeed: asset => seeds.get(asset),
    prepare: entries => {
      if (entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n) !== 0n)
        throw new Error("Read/action load fixture unexpectedly changed ledger supply.");
      return { i: randomUUID(), k: "GAME", a: "", v: "0", d: { entries, signature: "fixture" }, t: worldEpoch };
    },
    commit: transaction => {
      if (committed.has(transaction.i)) return;
      for (const entry of transaction.d.entries) {
        const next = (balances.get(entry.account) || 0n) + BigInt(entry.delta);
        if (next < 0n) throw new Error("Negative load fixture balance.");
        balances.set(entry.account, next);
      }
      committed.add(transaction.i);
    },
  };
  const store = new SqliteStore(":memory:", () => worldEpoch, 1, ledger);
  const notes = new Notes(":memory:"), creation = new Creation(notes, {});
  const { router, workspace } = workspaceApi({ notes, markets: creation.markets, env: {},
    profileReader: () => null, cmsAuth: (_req, res) => res.status(403).end() });
  const app = express(); app.use(express.json({ limit: "8mb" })); app.use("/api/intranet", router);
  const game = createApi(store, "http://world.localhost");
  const agents = [], actors = [], latencies = [], statuses = {}, loop = monitorEventLoopDelay({ resolution: 10 });
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); }
    else if (req.url.startsWith("/api/intranet/")) app(req, res);
    else game.emit("request", req, res);
  });
  configureServer(server, { value: { requestTimeoutSeconds: 90 }, listeners: new Set() });
  try {
    for (let index = 0; index < users; index++) {
      const identity = store.create(), owner = `0x${(index + 1).toString(16).padStart(40, "0")}`,
        appToken = createHash("sha256").update(`load-${index}`).digest("hex");
      store.transaction(identity.token, session => {
        session.account.game.stage = 0; session.account.game.population = 100;
        session.account.game.home = { ...session.account.game.position };
        session.account.game.stock = { water: 10000, wood: 10000, metal: 10000, oil: 0 };
      });
      notes.db.prepare("INSERT INTO work_members VALUES (?,'active','contributor','learning','engineering','engineering-general','Load fixture',?)").run(owner, Date.now());
      notes.db.prepare("INSERT INTO work_sessions VALUES (?,?,?)")
        .run(createHash("sha256").update(appToken).digest("hex"), owner, Date.now() + 600000);
      actors.push({ identity, owner, appToken });
      agents.push(new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }));
    }
    for (let channel = 0; channel < 100; channel++) {
      const key = `load-channel-${channel}`;
      notes.db.prepare("INSERT INTO work_channels VALUES (?,?,'foundation','')").run(key, key);
      for (let message = 0; message < 100; message++)
        notes.db.prepare("INSERT INTO work_messages(channel,author,request,body,at) VALUES (?,?,?,?,?)")
          .run(key, actors[message].owner, `${key}-${message}`, "Load fixture message", Date.now());
    }
    const insertMission = notes.db.prepare(`INSERT INTO work_missions(id,title,body,division,team,assignee,status,evidence,revision,at,todos)
      VALUES (?,?,'Load fixture mission','engineering','engineering-general',?,'assigned','',0,?,?)`);
    for (let index = 0; index < 100; index++)
      insertMission.run(`load-mission-${index}`, `Mission ${index}`, actors[index].owner, Date.now(),
        JSON.stringify([{ id: "task", text: "Submit completion evidence", done: false }]));
    const maker = store.chatSession(actors[0].identity.token).owner;
    const insertFill = store.db.prepare("INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES (?,1,?,?,?,'players',?,?)");
    const insertOrder = store.db.prepare("INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES (?,?,'sell',?,10,10,'open',?)");
    for (const asset of marketAssets) {
      const price = dollarsUnits(Math.max(marketBasePrice(asset), marketPriceFloor(asset)));
      for (let day = 0; day < 30; day++)
        insertFill.run(asset, price, price, worldEpoch - day * 24 * 60000, "fixture-buyer", maker);
      insertOrder.run(maker, asset, price, worldEpoch);
    }
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port;
    const request = (index, pathname, appRequest = false, body) => new Promise((resolve, reject) => {
      const actor = actors[index], start = performance.now();
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, agent: agents[index], method: body ? "POST" : "GET",
        headers: { Host: appRequest ? "app.localhost" : "world.localhost",
          Cookie: appRequest ? `featheral_app=${actor.appToken}` : `terra-dev=${actor.identity.token}`,
          ...(body ? { Origin: "http://world.localhost", "Content-Type": "application/json", "X-CSRF-Token": actor.identity.csrf } : {}) } }, res => {
        res.resume(); res.on("end", () => resolve({ ms: performance.now() - start, status: res.statusCode }));
        res.on("error", reject);
      });
      req.setTimeout(10000, () => req.destroy(new Error("Load request timed out.")));
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    // Separate per-user keep-alive agents establish real sockets, not a queued concurrency setting.
    for (let first = 0; first < users; first += 50)
      await Promise.all(actors.slice(first, first + 50).map((_actor, offset) => request(first + offset, "/healthz")));
    const connections = await new Promise((resolve, reject) => server.getConnections((error, total) => error ? reject(error) : resolve(total)));
    loop.enable();
    const start = performance.now(), jobs = [];
    for (let index = 0; index < count; index++) {
      const delay = start + index * 1000 / requestsPerSecond - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const choice = index % 20;
      const pathname = choice < 12 ? "/api/state" : choice < 16 ? "/api/market?asset=wood&quantity=1"
        : choice < 18 ? "/api/intranet/channels" : choice === 18 ? "/api/intranet/missions" : "/api/actions";
      const body = choice === 19 ? { id: randomUUID(),
        revision: store.read(actors[index].identity.token, session => session.account.revision), command: { type: "home" } } : undefined;
      jobs.push(request(index % users, pathname, choice >= 16 && choice < 19, body).then(result => {
        latencies.push(result.ms); statuses[result.status] = (statuses[result.status] || 0) + 1;
      }, error => { statuses[error.code || "NETWORK_ERROR"] = (statuses[error.code || "NETWORK_ERROR"] || 0) + 1; }));
    }
    await Promise.all(jobs);
    loop.disable(); latencies.sort((a, b) => a - b);
    const percentile = value => Number(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)].toFixed(2));
    const report = { fixture: "loopback gateway-style routing; in-memory SQLite and ledger adapter; full game-fund reconciliation; no disk/TLS/reverse proxy",
      users, establishedConnections: connections, requests: count, offeredRequestsPerSecond: requestsPerSecond,
      workload: "60% World state, 20% market, 10% App channels, 5% App missions, 5% World home actions",
      statuses, latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) },
      eventLoopP95Ms: Number((loop.percentile(95) / 1e6).toFixed(2)),
      rssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(2)), targetP95Ms: targetP95 };
    console.log(JSON.stringify(report, null, 2));
    if (connections < users || statuses[200] !== count || report.latencyMs.p95 >= targetP95)
      throw new Error("Concurrency smoke target failed. Inspect status counts, connection count and p95.");
  } finally {
    loop.disable(); for (const agent of agents) agent.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    game.close(); store.close(); notes.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
