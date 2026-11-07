"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");
const { Wallet } = require("ethers");
const { createAdminAuth, adminWallets } = require("../lib/admin-auth");
async function fixture(t, replica = false) {
  const wallets = [Wallet.createRandom(), Wallet.createRandom()], clock = { now: Date.now() };
  const auth = createAdminAuth({ wallets: wallets.map(wallet => wallet.address), now: () => clock.now });
  const app = express();
  if (replica) app.use((req, res, next) => {
    if (require("../../operations/replica").allowReplicaRequest(req, res, { replica: { readOnly: true } })) next();
  });
  app.use("/api/admin-auth", auth.router);
  app.use(auth.gate);
  app.get("/private", auth.authenticate, (req, res) => res.json({ wallet: req.adminWallet, session: req.adminSession }));
  app.post("/private", auth.authenticate, (_req, res) => res.json({ saved: true }));
  app.post("/api/deployment/plan", auth.authenticate, (_req, res) => res.json({ reviewed: true }));
  app.post("/api/database/deployment/challenge", auth.authenticate, (_req, res) => res.json({ challenge: true }));
  app.post("/api/database/deployment/start", auth.authenticate, (_req, res) => res.status(403).json({ error: "Signed deployment proof required." }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function call(path, body, options = {}) {
    const { host = "admin.localhost", origin = `http://${host}`, cookie } = options;
    const headers = options.status ? {} : options.headers || {};
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path,
        method: body === undefined ? "GET" : "POST", headers: { Host: host, Origin: origin,
          "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
        let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text,
          body: response.headers["content-type"]?.includes("json") ? JSON.parse(text) : null,
          cookie: response.headers["set-cookie"]?.map(value => value.split(";")[0]).join("; ") }));
      });
      request.on("error", reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login(wallet = wallets[0], options = {}) {
    const challenge = await call("/api/admin-auth/challenge", { address: wallet.address }, options);
    assert.equal(challenge.status, 200);
    const signature = await wallet.signMessage(challenge.body.message);
    const verified = await call("/api/admin-auth/verify", { signature }, { ...options, cookie: challenge.cookie });
    assert.equal(verified.status, 200);
    return { ...verified, challenge, signature };
  }
  return { call, wallets, clock, login };
}
test("Admin accepts exactly the project origin and Dollar reserve wallet by default", () => {
  assert.deepEqual(adminWallets, ["0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c", "0x706CCb6109046a6a4A08dbAD4444A46408703ccb"]);
});
test("loopback replica Admin can sign in and read without permitting persistent writes", async t => {
  const f = await fixture(t, true);
  assert.equal((await f.call("/private")).status, 401);
  assert.equal((await f.call("/api/admin-auth/challenge", { address: Wallet.createRandom().address })).status, 403);
  const signedIn = await f.login();
  const access = await f.call("/private", undefined, signedIn);
  assert.equal(access.status, 200);
  assert.equal(access.headers["x-featheral-replica"], "read-only");
  assert.equal((await f.call("/api/deployment/plan", {}, signedIn)).body.reviewed, true);
  assert.equal((await f.call("/api/deployment/plan", {})).status, 401);
  assert.equal((await f.call("/api/deployment/plan", {}, { ...signedIn, origin: "http://evil.localhost" })).status, 403);
  assert.equal((await f.call("/api/deployment/start", {}, signedIn)).status, 403);
  assert.equal((await f.call("/api/database/deployment/challenge", {}, signedIn)).body.challenge, true);
  assert.equal((await f.call("/api/database/deployment/challenge", {})).status, 401);
  assert.equal((await f.call("/api/database/deployment/start", {}, signedIn)).body.error, "Signed deployment proof required.");
  const write = await f.call("/private", {}, signedIn);
  assert.equal(write.status, 403);
  assert.match(write.body.error, /read-only snapshot replica/);
  assert.equal((await f.call("/api/admin-auth/logout", {}, signedIn)).status, 200);
  assert.equal((await f.call("/private", undefined, signedIn)).status, 401);
});
test("replica sign-in exception is exact-route and loopback Admin only", () => {
  const { allowReplicaRequest } = require("../../operations/replica");
  const settings = { replica: { readOnly: true } };
  for (const [host, remoteAddress, url, method] of [
    ["admin.localhost", "192.0.2.1", "/api/admin-auth/challenge", "POST"],
    ["admin.featheral.com", "127.0.0.1", "/api/admin-auth/challenge", "POST"],
    ["app.localhost", "127.0.0.1", "/api/admin-auth/verify", "POST"],
    ["admin.localhost", "127.0.0.1", "/api/admin-auth/settings", "POST"],
    ["admin.localhost", "127.0.0.1", "/api/admin-auth/challenge", "PUT"],
    ["admin.featheral.com", "127.0.0.1", "/api/deployment/plan", "POST"],
    ["admin.localhost", "192.0.2.1", "/api/deployment/plan", "POST"],
    ["admin.localhost", "127.0.0.1", "/api/deployment/plan/extra", "POST"],
  ]) {
    const res = { setHeader() {}, writeHead() {}, end() {} };
    assert.equal(allowReplicaRequest({ method, url, headers: { host }, socket: { remoteAddress } }, res, settings), false);
  }
});
test("privileged approvals follow the signed-in origin or Dollar wallet and stay bound to that wallet and session", async () => {
  const { OriginApprovals } = require("../../database/approvals");
  const wallets = [Wallet.createRandom(), Wallet.createRandom()];
  const approvals = new OriginApprovals({ wallet: wallets[0].address, wallets: wallets.map(wallet => wallet.address) });
  for (const wallet of wallets) {
    const context = { origin: "https://admin.featheral.com", session: "test-session", wallet: wallet.address };
    const proof = approvals.challenge("SAVE SETTINGS", { revision: 1 }, context, "server.example");
    assert.equal(proof.wallet, wallet.address);
    const input = { challengeId: proof.challengeId, signature: await wallet.signMessage(proof.message) };
    assert.doesNotThrow(() => approvals.consume("SAVE SETTINGS", { revision: 1 }, context, input));
    assert.throws(() => approvals.consume("SAVE SETTINGS", { revision: 1 }, context, input), { status: 403 });
  }
  assert.throws(() => approvals.challenge("SAVE SETTINGS", {}, {
    origin: "https://admin.featheral.com", session: "test-session", wallet: Wallet.createRandom().address,
  }, "server.example"), { status: 403 });
  const context = { origin: "https://admin.featheral.com", session: "test-session", wallet: wallets[1].address };
  const proof = approvals.challenge("SAVE SETTINGS", {}, context, "server.example");
  const signature = await wallets[1].signMessage(proof.message);
  assert.throws(() => approvals.consume("SAVE SETTINGS", {}, { ...context, wallet: wallets[0].address }, {
    challengeId: proof.challengeId, signature,
  }), { status: 403 });
});
test("only signed allowed wallets open Admin; Basic credentials and localhost never bypass access", async t => {
  const f = await fixture(t);
  const root = await f.call("/");
  assert.equal(root.status, 200); assert.match(root.text, /Connect and sign in/); assert.doesNotMatch(root.text, /id="sidebar"/);
  assert.equal((await f.call("/js/login.js")).status, 200);
  assert.equal((await f.call("/js/core.js")).status, 401);
  assert.equal((await f.call("/private")).status, 401);
  const basic = await f.call("/private", undefined, { headers: { Authorization: "Basic " + Buffer.from("admin:any-password").toString("base64") } });
  assert.equal(basic.status, 401); assert.equal(basic.headers["www-authenticate"], undefined);
  assert.equal((await f.call("/api/admin-auth/challenge", { address: Wallet.createRandom().address })).status, 403);
  for (const wallet of f.wallets) {
    const login = await f.login(wallet), access = await f.call("/private", undefined, login);
    assert.equal(access.status, 200); assert.equal(access.body.wallet, wallet.address);
    assert.match(access.body.session, /^[a-f0-9]{64}$/);
    assert.match(login.headers["set-cookie"].join(" "), /HttpOnly/);
    assert.match(login.headers["set-cookie"].join(" "), /SameSite=Strict/);
    assert.equal(login.body.token, undefined);
    assert.equal((await f.call("/private", {}, login)).status, 200);
  }
});
test("Admin sign-in is browser/origin-bound, single-use, expiring and revocable", async t => {
  const f = await fixture(t), wallet = f.wallets[0];
  const challenge = await f.call("/api/admin-auth/challenge", { address: wallet.address });
  const signature = await wallet.signMessage(challenge.body.message);
  assert.match(challenge.body.message, /Origin: http:\/\/admin.localhost/);
  assert.equal((await f.call("/api/admin-auth/verify", { signature })).status, 403);
  assert.equal((await f.call("/api/admin-auth/verify", { signature }, { cookie: challenge.cookie, origin: "http://evil.localhost" })).status, 403);
  const verified = await f.call("/api/admin-auth/verify", { signature }, { cookie: challenge.cookie });
  assert.equal(verified.status, 200);
  assert.equal((await f.call("/api/admin-auth/verify", { signature }, { cookie: challenge.cookie })).status, 403);
  assert.equal((await f.call("/private", {}, { cookie: verified.cookie, origin: "http://evil.localhost" })).status, 403);
  assert.equal((await f.call("/private", undefined, { cookie: verified.cookie, host: "admin.featheral.com", headers: { "X-Forwarded-Proto": "https" } })).status, 401);
  assert.equal((await f.call("/api/admin-auth/logout", {}, verified)).status, 200);
  assert.equal((await f.call("/private", undefined, verified)).status, 401);
  const expired = await f.call("/api/admin-auth/challenge", { address: wallet.address });
  f.clock.now += 300001;
  assert.equal((await f.call("/api/admin-auth/verify", { signature: await wallet.signMessage(expired.body.message) }, expired)).status, 403);
  const signedIn = await f.login();
  f.clock.now += 8 * 3600000;
  assert.equal((await f.call("/private", undefined, signedIn)).status, 401);
});
test("Admin rejects forged signatures, wrong hosts, HTTP production and oversized or excessive sign-ins", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/", undefined, { host: "admin.featheral.com" })).status, 403);
  assert.equal((await f.call("/api/admin-auth/session", undefined, { host: "app.localhost" })).status, 403);
  const login = await f.login(f.wallets[0], { host: "admin.featheral.com", origin: "https://admin.featheral.com", headers: { "X-Forwarded-Proto": "https" } });
  assert.match(login.headers["set-cookie"].join(" "), /Secure/);
  const challenge = await f.call("/api/admin-auth/challenge", { address: f.wallets[0].address });
  assert.equal((await f.call("/api/admin-auth/verify", { signature: await f.wallets[1].signMessage(challenge.body.message) }, challenge)).status, 403);
  assert.equal((await f.call("/api/admin-auth/challenge", { address: "x".repeat(5000) })).status, 413);
  let response;
  for (let i = 0; i < 30; i++) response = await f.call("/api/admin-auth/challenge", { address: f.wallets[0].address });
  assert.equal(response.status, 429);
});
