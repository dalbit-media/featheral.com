"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const express = require("express");
const { once } = require("node:events");
const { ServerProfile, serverProfileApi, percentile, formatRate } = require("../lib/server-profile");

test("storage inventory classifies databases, ledgers, uploads, trash and code while caching scans", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    ["data/wallet.sqlite", 11], ["data/wallet.sqlite-wal", 5], ["data/fth-ledger/2026/01.jsonl", 17],
    ["services/cms/data/site/uploads/photo.jpg", 23], ["services/cms/data/site/trash/old.jpg", 29],
    ["sites/samples/uploads/cache/preview.dat", 13],
    ["data/other/cache.json", 31], ["data/custom-store/record.json", 7], ["services/cms/server.js", 37], ["dist/app.js", 41],
    ["node_modules/pkg/index.js", 43], [".git/objects/pack", 47],
  ];
  for (const [relative, size] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size));
  }
  const profile = new ServerProfile({ root, dataDirectory: path.join(root, "services", "cms", "data"),
    externalDirectories: [{ directory: path.join(root, "data", "custom-store"), category: "ledgers" }], autoStart: false });
  t.after(() => profile.close());
  await profile.refreshStorage();
  const first = profile.snapshot().storage;
  assert.equal(first.complete, true);
  assert.deepEqual(Object.fromEntries(Object.entries(first.categories).map(([key, value]) => [key, value.bytes])), {
    databases: 16, ledgers: 24, uploads: 36, trash: 29, codebase: 37, otherData: 31,
  });
  assert.equal(first.totalBytes, 173);
  fs.writeFileSync(path.join(root, "services", "cms", "server.js"), Buffer.alloc(100));
  assert.equal(profile.snapshot().storage.categories.codebase.bytes, 37);
  await profile.refreshStorage();
  assert.equal(profile.snapshot().storage.categories.codebase.bytes, 100);
  assert.equal(profile.snapshot().storage.categories.codebase.files, 1);
});

test("HTTP instrumentation bounds history and measures declared ingress, response bytes, latency and errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-profile-"));
  const profile = new ServerProfile({ root, autoStart: false });
  try {
    const res = new (require("node:events").EventEmitter)();
    res.statusCode = 503;
    res.write = function () { return true; };
    res.end = function () { return this; };
    profile.recordRequest({ headers: { "content-length": "12" } }, res);
    res.write(Buffer.from("abc"));
    res.end("de");
    res.emit("finish");
    profile.sample();
    const metrics = profile.snapshot().metrics;
    assert.equal(metrics.requestCount60s, 1);
    assert.equal(metrics.requestBytes60s, 12);
    assert.equal(metrics.responseBytes60s, 5);
    assert.equal(metrics.latencySampleCount, 1);
    assert.ok(metrics.latencyP95Ms >= 0);
    assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
    assert.equal(formatRate(1024), "1.0 KB/s");
    for (let i = 0; i < 65; i++) profile.sample();
    assert.equal(profile.snapshot().history.length, 60);
  } finally {
    profile.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disk samples expose capacity, net growth and time to full through the profile API payload", async t => {
  let now = 1000000, available = 80;
  const profile = new ServerProfile({ root: __dirname, autoStart: false, now: () => now,
    statfs: async () => ({ blocks: 100, bsize: 1024 ** 3, bavail: available }) });
  t.after(() => profile.close());
  await profile.refreshStorage();
  let disk = profile.snapshot().disk;
  assert.equal(disk.totalBytes, 100 * 1024 ** 3);
  assert.equal(disk.usedBytes, 20 * 1024 ** 3);
  assert.equal(disk.freeBytes, 80 * 1024 ** 3);
  assert.equal(disk.usedPct, 20);
  assert.equal(disk.freePct, 80);
  assert.equal(disk.sampledAt, now);
  assert.equal(disk.growthBytesPerDay, null);
  assert.equal(disk.daysUntilFull, null);
  assert.equal(disk.severity, "unknown");
  assert.match(profile.snapshot().risks.find(risk => risk.key === "disk").message, /collecting/);
  now += 300000;
  available = 79;
  await profile.refreshStorage();
  disk = profile.snapshot().disk;
  assert.equal(disk.growthBytesPerDay, 288 * 1024 ** 3);
  assert.equal(disk.growthObservedSeconds, 300);
  assert.equal(disk.daysUntilFull, 79 / 288);
  assert.equal(disk.severity, "critical");
  assert.equal(profile.snapshot().risks.find(risk => risk.key === "disk").severity, "critical");
});

test("disk risk honors exact growth and utilization thresholds without inventing forecasts", t => {
  let now = 0;
  const profile = new ServerProfile({ root: __dirname, autoStart: false, now: () => now });
  t.after(() => profile.close());
  const forecast = days => {
    profile.diskSamples = [];
    now = 0;
    profile.diskSample(1000, days * 10 + 10);
    now = 86400000;
    return profile.diskSample(1000, days * 10);
  };
  assert.equal(forecast(7).severity, "critical");
  assert.equal(forecast(7.01).severity, "warning");
  assert.equal(forecast(30).severity, "warning");
  assert.equal(forecast(30.01).severity, "healthy");
  profile.diskSamples = [];
  now = 0;
  profile.diskSample(1000, 501);
  now = 86400000;
  assert.equal(profile.diskSample(1000, 500).severity, "healthy");
  for (const [free, severity] of [[5, "critical"], [15, "warning"], [15.01, "unknown"]]) {
    profile.diskSamples = [];
    assert.equal(profile.diskSample(100, free).severity, severity);
  }
  profile.diskSamples = [];
  now = 0;
  profile.diskSample(100, 50);
  now = 299999;
  assert.equal(profile.diskSample(100, 49).growthBytesPerDay, null);
  now = 300000;
  const flat = profile.diskSample(100, 50);
  assert.equal(flat.growthBytesPerDay, 0);
  assert.equal(flat.daysUntilFull, null);
  assert.equal(flat.severity, "healthy");
  now = 600000;
  const declining = profile.diskSample(100, 60);
  assert.ok(declining.growthBytesPerDay < 0);
  assert.equal(declining.daysUntilFull, null);
  assert.equal(declining.severity, "healthy");
  assert.equal(profile.diskSample(200, 150).growthBytesPerDay, null);
  profile.diskSamples = [];
  assert.equal(profile.diskSample(100, 0).severity, "critical");
});

test("disk growth history is bounded to 24 hours and resets after gaps, clock changes and capacity failures", async t => {
  let now = 0, fail = false, blocks = 100;
  const profile = new ServerProfile({ root: __dirname, autoStart: false, now: () => now,
    statfs: async () => {
      if (fail) throw new Error("unavailable");
      return { blocks, bsize: 1024, bavail: 50 };
    } });
  t.after(() => profile.close());
  for (let index = 0; index <= 400; index++) {
    now = index * 300000;
    profile.diskSample(100, 50);
  }
  assert.equal(profile.diskSamples.length, 289);
  now += 86400001;
  assert.equal(profile.diskSample(100, 40).growthBytesPerDay, null);
  now -= 1000;
  assert.equal(profile.diskSample(100, 30).growthBytesPerDay, null);
  fail = true;
  await profile.refreshStorage();
  assert.equal(profile.snapshot().disk.available, false);
  assert.equal(profile.diskSamples.length, 0);
  assert.equal(profile.snapshot().risks.find(risk => risk.key === "disk").severity, "unknown");
  fail = false;
  now += 300000;
  await profile.refreshStorage();
  assert.equal(profile.snapshot().disk.growthBytesPerDay, null);
  blocks = 0;
  await profile.refreshStorage();
  assert.equal(profile.snapshot().disk.available, false);
});

test("profile API requires an authenticated Admin host and protects storage refresh with same-origin checks", async t => {
  const app = express(), service = { snapshot: () => ({ protected: true }), refreshes: 0, refreshStorage() { this.refreshes++; } };
  const cmsAuth = (req, res, next) => req.get("authorization") === "Basic YWRtaW46cGFzcw==" ? next() : res.sendStatus(401);
  app.use("/api/server-profile", serverProfileApi({ service, cmsAuth, passwordConfigured: true }));
  app.use("/api/local-server-profile", serverProfileApi({
    service,
    cmsAuth: (req, res, next) => req.hostname === "admin.localhost" ? next() : cmsAuth(req, res, next),
    passwordConfigured: false,
  }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method: options.method || "GET",
      headers: { Host: options.host || `admin.localhost:${port}`, Authorization: options.authorization === undefined ? "Basic YWRtaW46cGFzcw==" : options.authorization,
        ...options.headers } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: () => JSON.parse(body) }));
    });
    req.once("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  const denied = await request("/api/server-profile", { host: `other.localhost:${port}` });
  assert.equal(denied.status, 404);
  assert.equal((await request("/api/server-profile", { authorization: "" })).status, 401);
  assert.deepEqual((await request("/api/server-profile")).json(), { protected: true });
  assert.deepEqual((await request("/api/local-server-profile")).json(), { protected: true });
  assert.equal((await request("/api/local-server-profile", { host: `admin.featheral.com:${port}`,
    headers: { "X-Forwarded-Proto": "https" } })).status, 503);
  const badOrigin = await request("/api/server-profile/refresh", { method: "POST", headers: { Origin: "http://attacker.localhost", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(badOrigin.status, 403);
  const refresh = await request("/api/server-profile/refresh", { method: "POST",
    headers: { Origin: `http://admin.localhost:${port}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(refresh.status, 202);
  const repeatedRefresh = await request("/api/server-profile/refresh", { method: "POST",
    headers: { Origin: `http://admin.localhost:${port}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(repeatedRefresh.status, 429);
  assert.equal(service.refreshes, 1);
});
