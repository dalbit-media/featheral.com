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
    databases: 16, ledgers: 24, uploads: 36, trash: 29, temporary: 0, backups: 0, releases: 0, codebase: 37, generated: 84, logs: 0, otherData: 31,
  });
  assert.equal(first.totalBytes, 257);
  fs.writeFileSync(path.join(root, "services", "cms", "server.js"), Buffer.alloc(100));
  assert.equal(profile.snapshot().storage.categories.codebase.bytes, 37);
  await profile.refreshStorage();
  assert.equal(profile.snapshot().storage.categories.codebase.bytes, 100);
  assert.equal(profile.snapshot().storage.categories.codebase.files, 1);
});

test("managed release inventory resolves live data links and measures staging, all-site trash and backups exactly once", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-managed-profile-"));
  const root = path.join(base, "releases", "current-release"), shared = path.join(base, "shared");
  const put = (relative, bytes) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
  };
  for (const [file, bytes] of [
    ["releases/current-release/server.js", 2], ["releases/old-release/server.js", 3],
    ["shared/data/wallet.sqlite", 5], ["shared/data/fth-ledger/entry.json", 7],
    ["shared/cms-data/site-a/db.sqlite", 11], ["shared/cms-data/site-b/db.sqlite", 13],
    ["shared/cms-data/site-a/uploads/photo.jpg", 17],
    ["shared/cms-data/site-a/trash/old.jpg", 19], ["shared/cms-data/site-b/trash/old.sqlite", 23],
    ["shared/deployment/digest/release.zip", 29], ["shared/site-sync/snapshot/uploads/photo.jpg", 31],
    ["shared/data/deployment/job/release.zip", 37], ["shared/data/site-sync/job/db.sqlite", 41],
    ["shared/self-deployment/job/source.zip", 43],
    ["shared/sync-backups/job/uploads/photo.jpg", 47], ["shared/data/backups/saved.sqlite", 53],
    ["unrelated/secret.bin", 59],
  ]) put(file, bytes);
  fs.mkdirSync(path.join(root, "services", "cms"), { recursive: true });
  fs.symlinkSync(root, path.join(base, "current"), "junction");
  fs.symlinkSync(path.join(shared, "data"), path.join(root, "data"), "junction");
  fs.symlinkSync(path.join(shared, "cms-data"), path.join(root, "services", "cms", "data"), "junction");
  fs.symlinkSync(path.join(base, "unrelated"), path.join(shared, "untrusted"), "junction");
  fs.linkSync(path.join(shared, "data", "wallet.sqlite"), path.join(shared, "data", "wallet-copy.sqlite"));
  const profile = new ServerProfile({ root, dataDirectory: path.join(root, "services", "cms", "data"),
    externalDirectories: [{ directory: path.join(shared, "data", "fth-ledger"), category: "ledgers" }], autoStart: false });
  t.after(() => {
    profile.close();
    for (const link of [path.join(base, "current"), path.join(root, "data"), path.join(root, "services", "cms", "data"), path.join(shared, "untrusted")])
      if (process.platform === "win32") fs.rmdirSync(link); else fs.unlinkSync(link);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const firstScan = profile.refreshStorage();
  assert.equal(profile.refreshStorage(), firstScan, "concurrent callers await the same scan");
  await firstScan;
  assert.equal(profile.storage.complete, true);
  assert.deepEqual(Object.fromEntries(Object.entries(profile.storage.categories).map(([key, value]) => [key, value.bytes])), {
    databases: 29, ledgers: 7, uploads: 17, trash: 42, temporary: 181, backups: 100, releases: 3, codebase: 2, generated: 0, logs: 0, otherData: 0,
  });
  assert.equal(profile.storage.totalBytes, 381);
  fs.unlinkSync(path.join(shared, "deployment", "digest", "release.zip"));
  await profile.refreshStorage();
  assert.equal(profile.storage.categories.temporary.bytes, 152);
  assert.equal(profile.storage.totalBytes, 352);
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

test("profile cleanup inventory uses the same eligibility as removal and reports preview failures explicitly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-profile-cleanup-"));
  const { cleanupStorage } = require("../../operations/storage-cleanup");
  const id = "11111111-1111-4111-8111-111111111111";
  const staging = path.join(root, "data", "deployment", id);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "release.zip"), Buffer.alloc(23));
  fs.writeFileSync(path.join(root, "data", "deployment", "status.json"), JSON.stringify({ running: false }));
  const profile = new ServerProfile({ root, autoStart: false,
    cleanupPreview: () => cleanupStorage({ root, minAgeMs: 0, discardCompletedBackups: true, discardOldReleases: true }) });
  t.after(() => { profile.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await profile.refreshStorage();
  const preview = profile.storage.cleanup;
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.reclaimableBytes, 23);
  assert.equal(profile.storage.categories.temporary.bytes, 23);
  assert.equal(preview.candidates[0].path, staging);
  const applied = cleanupStorage({ root, minAgeMs: 0, apply: true, discardCompletedBackups: true, discardOldReleases: true });
  assert.equal(applied.removedBytes, preview.reclaimableBytes);
  await profile.refreshStorage();
  assert.equal(profile.storage.cleanup.candidateCount, 0);
  profile.cleanupPreview = () => { throw new Error("Invalid saved operation status"); };
  await profile.refreshStorage();
  assert.equal(profile.storage.cleanup.blocked, true);
  assert.match(profile.storage.cleanup.error, /could not be verified/);
  assert.equal(profile.storage.cleanup.reclaimableBytes, undefined);
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

test("capacity refresh reflects cleanup immediately even while the storage inventory is scanning", async t => {
  let free = 2, now = 1000;
  const profile = new ServerProfile({ root: os.tmpdir(), autoStart: false, now: () => now,
    statfs: async () => ({ blocks: 50, bsize: 1024 ** 3, bavail: free }) });
  t.after(() => profile.close());
  await profile.refreshDisk();
  assert.equal(profile.snapshot().disk.freeBytes, 2 * 1024 ** 3);
  profile.storage.scanning = true;
  free = 12; now += 1000;
  await profile.refreshDisk();
  assert.equal(profile.snapshot().disk.freeBytes, 12 * 1024 ** 3);
  assert.equal(profile.snapshot().disk.sampledAt, now);
  assert.equal(profile.storage.scanning, true);
  assert.equal(profile.storage.updatedAt, null);
});

test("profile API requires an authenticated Admin host and protects storage refresh with same-origin checks", async t => {
  const app = express(), service = { snapshot: () => ({ protected: true }), refreshes: 0, diskRefreshes: 0,
    async refreshDisk() { this.diskRefreshes++; }, refreshStorage() { this.refreshes++; } };
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
  assert.equal(service.diskRefreshes, 2, "each authenticated read refreshes capacity without scanning storage");
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
