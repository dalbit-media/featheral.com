"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Wallet } = require("ethers");
const { createDatabase } = require("../server");
const { OriginApprovals } = require("../approvals");
const { spawnSync } = require("node:child_process");
test("the database service loads without third-party SQL drivers", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const Module = require("node:module"), load = Module._load;
    Module._load = function(name, ...args) {
      if (/^(?:sqlite3|pg|mysql|mysql2|better-sqlite3|sql\.js)$/.test(name)) throw new Error("SQL dependency: " + name);
      return load.call(this, name, ...args);
    };
    require(${JSON.stringify(path.resolve(__dirname, "..", "server.js"))});
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
async function fixture(t, passwordConfigured = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-db-http-"));
  const wallet = Wallet.createRandom();
  const db = createDatabase({ directory: path.join(directory, "ledger"), repository: path.resolve(__dirname, "..", "..", ".."),
    env: {}, sites: () => ["app.featheral.com", "admin.featheral.com"], approvals: new OriginApprovals({ wallet: wallet.address }) });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.journals.transact("sites/app.featheral.com", { requestId: "private-message", changes: [{ key: "message:1", op: "put", expectedRevision: 0, value: "private text" }] });
  db.journals.transact("internal/vault", { requestId: "private-vault", changes: [{ key: "ssh-root", op: "put", expectedRevision: 0, value: { ciphertext: "private ciphertext", at: 1 } }] });
  const app = express();
  const deployment = { running: false }, serverUsers = { changing: false };
  app.use("/api/database", db.adminRouter({ passwordConfigured, deployment, serverUsers,
    cmsAuth: (req, res, next) => req.get("authorization") === "Basic fixture" ? next() : res.status(401).end() }));
  app.use("/api/v1/db", db.publicRouter);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: url, method: options.method || "GET",
      headers: { Host: "admin.localhost", Authorization: "Basic fixture", ...options.headers } }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: { get: key => response.headers[key.toLowerCase()] },
        json: async () => JSON.parse(body), text: async () => body }));
    });
    req.on("error", reject); req.end(options.body);
  });
  return { db, request, directory, wallet };
}
test("the database factory exposes the domain document API to in-process services", async t => {
  const { db } = await fixture(t);
  const site = db.domain.site("app.featheral.com");
  site.transact({ requestId: "api-document-write", changes: [
    { collection: "settings", id: "theme", op: "put", expectedRevision: 0, value: "dark" },
  ] });
  assert.deepEqual(site.get("settings", "theme"), { revision: 1, deleted: false, value: "dark" });
});
test("Admin journal browsing authenticates, restricts hosts and excludes private values and the vault namespace", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/database", { headers: { Authorization: "" } })).status, 401);
  assert.equal((await request("/api/database", { headers: { Host: "world.localhost" } })).status, 404);
  const response = await request("/api/database");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const summary = await response.json();
  assert.equal(summary.phase, "staged"); assert.equal(summary.resetPerformed, false);
  assert.ok(!JSON.stringify(summary).includes("vault"));
  const records = await (await request("/api/database/records?namespace=sites%2Fapp.featheral.com")).json();
  assert.equal(records.records.length, 1);
  assert.ok(!JSON.stringify(records).includes("private text"));
  assert.equal((await request("/api/database/records?namespace=internal%2Fvault")).status, 404);
  assert.equal((await request("/api/database/records?namespace=tokens%2Ffths&before=nope")).status, 400);
});
test("credential operations require real password configuration, HTTPS except loopback and exact same origin", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/database/vault", { headers: { Host: "admin.featheral.com" } })).status, 403);
  assert.equal((await request("/api/database/vault/challenge", { method: "POST" })).status, 403);
  assert.equal((await request("/api/database/vault/challenge", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  const result = await request("/api/database/vault");
  assert.equal(result.status, 200);
  assert.ok(!(await result.text()).includes("private ciphertext"));
  const unconfigured = await fixture(t, false);
  assert.equal((await unconfigured.request("/api/database/vault")).status, 503);
});
test("public DB API reports staged status but cannot query, export or mutate any ledger", async t => {
  const { request } = await fixture(t);
  const response = await request("/api/v1/db/status", { headers: { Authorization: "" } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.siteCutoverComplete, false);
  assert.equal(status.thirdPartyDatabaseDrivers, false);
  assert.equal(status.sqlite, "built-in-node-managed-in-process");
  for (const url of ["/api/v1/db/records", "/api/v1/db/sql", "/api/v1/db/vault"])
    assert.equal((await request(url)).status, 404);
  assert.equal((await request("/api/v1/db/status", { method: "POST" })).status, 404);
});
test("credential request parsing is bounded and rate limited without silently accepting invalid JSON", async t => {
  const { request } = await fixture(t);
  const headers = { Origin: "http://admin.localhost", "Content-Type": "application/json" };
  assert.equal((await request("/api/database/vault/enroll", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await request("/api/database/vault/enroll", { method: "POST", headers, body: JSON.stringify({ password: "x".repeat(9000) }) })).status, 413);
  for (let i = 0; i < 28; i++) await request("/api/database/unknown", { method: "POST", headers, body: "{}" });
  assert.equal((await request("/api/database/unknown", { method: "POST", headers, body: "{}" })).status, 429);
});
test("HTTP credential enrollment verifies origin proof and SSH before writing ciphertext, with no reveal endpoint", async t => {
  const { db, request, directory, wallet } = await fixture(t);
  const file = path.join(directory, "key");
  fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  Object.assign(db.vault.env, { DB_VAULT_KEY_FILE: file, DEPLOY_TARGET: "root@server.example:/opt/featheral",
    DEPLOY_HOST_KEY_SHA256: "SHA256:" + "a".repeat(43) });
  let verified = 0;
  db.vault.verifyCredential = async () => { verified++; };
  const headers = { Origin: "http://admin.localhost", "Content-Type": "application/json" };
  const payload = { password: "http-fixture-root-secret" };
  const challengeResponse = await request("/api/database/vault/challenge", { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  assert.ok(!JSON.stringify(challenge).includes(payload.password));
  const body = JSON.stringify({ ...payload, challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) });
  const enrolled = await request("/api/database/vault/enroll", { method: "POST", headers, body });
  assert.equal(enrolled.status, 200); assert.equal((await enrolled.json()).verified, true); assert.equal(verified, 1);
  assert.equal((await request("/api/database/vault/enroll", { method: "POST", headers, body })).status, 403);
  assert.equal((await request("/api/database/vault/reveal")).status, 404);
  const stored = JSON.stringify(db.vault.stored());
  assert.ok(!stored.includes(payload.password)); assert.ok(stored.includes("ciphertext"));
});
