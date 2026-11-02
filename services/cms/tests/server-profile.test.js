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
