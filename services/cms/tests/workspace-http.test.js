"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");
const { Wallet } = require("ethers");
const { Notes } = require("../../notes-api/ledger");
const { Creation } = require("../../notes-api/creation");
const { workspaceApi } = require("../lib/workspace-api");

async function fixture(t, env = {}) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {}), profiles = new Map(), deliveries = [];
  const { router, workspace } = workspaceApi({ notes, markets: creation.markets, profileReader: address => profiles.get(address),
    env, cmsAuth: (req, res, next) => req.get("authorization") === "Basic fixture-admin" ? next() : res.status(401).json({ error: "Admin authorization required" }),
    pushTransport: { setVapidDetails() {}, async sendNotification(subscription, payload) { deliveries.push({ subscription, payload: JSON.parse(payload) }); } } });
  const app = express(); app.use(express.json({ limit: "8mb" })); app.use("/api/intranet", router);
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); notes.close(); });
  async function call(path, body, options = {}) {
    const host = options.host || "app.localhost", method = options.method || (body === undefined ? "GET" : "POST");
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/intranet" + path, method,
        headers: { Host: host, Origin: options.origin || `http://${host}`, "Content-Type": "application/json",
          ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.admin ? { Authorization: "Basic fixture-admin" } : {}) } }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk)); response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: response.statusCode, headers: response.headers,
            body: response.headers["content-type"]?.includes("json") ? JSON.parse(bytes.toString()) : bytes });
        });
      });
      request.on("error", reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login(wallet = Wallet.createRandom(), role, division = "engineering") {
    const owner = wallet.address.toLowerCase();
    const challenge = await call("/challenge", { address: wallet.address });
    const result = await call("/login", { address: wallet.address, signature: await wallet.signMessage(challenge.body.message) });
    assert.equal(result.status, 200);
    const cookie = result.headers["set-cookie"][0].split(";")[0];
    if (role) {
      profiles.set(owner, { username: role, avatar: "" });
      assert.equal((await call("/apply", { motivation: "Build together" }, { cookie })).status, 200);
      assert.equal((await call(`/admin/members/${owner}`, { status: "active", role, level: "learning", division, team: `${division}-general` },
        { host: "admin.localhost", admin: true, method: "PUT" })).status, 200);
    }
    return { cookie, owner, wallet, result };
  }
  return { notes, creation, workspace, call, login, profiles, deliveries };
}
test("App HTTP access is wallet-authenticated, approval-gated, host-bound, same-origin and controlled only through Admin", async t => {
  const ui = await fixture(t);
  assert.equal((await ui.call("/silver", undefined, { host: "silver.localhost" })).body.supply, 0);
  assert.equal((await ui.call("/me", undefined, { host: "silver.localhost" })).status, 404);
  assert.equal((await ui.call("/silver", undefined, { host: "x.localhost" })).status, 404);
  assert.equal((await ui.call("/challenge", { address: Wallet.createRandom().address }, { origin: "http://evil.localhost" })).status, 403);
  assert.equal((await ui.call("/directory")).status, 401);
  const pending = await ui.login();
  assert.match(pending.result.headers["set-cookie"][0], /HttpOnly/);
  assert.match(pending.result.headers["set-cookie"][0], /SameSite=Strict/);
  assert.equal(pending.result.body.token, undefined);
  assert.equal((await ui.call("/apply", { motivation: "Help" }, pending)).status, 409);
  ui.profiles.set(pending.owner, { username: "NewInsider", avatar: "" });
  assert.equal((await ui.call("/apply", { motivation: "Help", status: "active", role: "director" }, pending)).status, 200);
  assert.equal((await ui.call("/directory", undefined, pending)).status, 403);
  assert.equal((await ui.call("/admin", undefined, { ...pending, admin: true })).status, 404);
  assert.equal((await ui.call("/admin", undefined, { host: "admin.localhost" })).status, 401);
  const lead = await ui.login(undefined, "lead"), intern = await ui.login(undefined, "intern"), other = await ui.login(undefined, "volunteer", "community");
  assert.equal((await ui.call("/directory", undefined, lead)).body.members.length, 3);
  assert.equal((await ui.call("/channels/division-engineering/messages", undefined, other)).status, 404);
  const input = { body: "A private Foundation brief", request: "http-message-1", attachment: { name: "brief.html", base64: Buffer.from("<b>download only</b>").toString("base64") } };
  const sent = await ui.call("/channels/team-engineering-general/messages", input, lead);
  assert.equal(sent.status, 200);
  assert.equal((await ui.call("/channels/team-engineering-general/messages", input, lead)).body.id, sent.body.id);
  const file = await ui.call(`/files/${sent.body.file}`, undefined, intern);
  assert.equal(file.body.toString(), "<b>download only</b>");
  assert.equal(file.headers["content-type"], "application/octet-stream");
  assert.match(file.headers["content-disposition"], /attachment/);
  assert.equal(file.headers["x-content-type-options"], "nosniff");
  assert.equal((await ui.call(`/files/${sent.body.file}`, undefined, other)).status, 404);
  assert.equal((await ui.call("/channels/team-engineering-general/document", { body: "Work plan", revision: 0 }, { ...lead, method: "PUT" })).status, 200);
  assert.equal((await ui.call("/channels/team-engineering-general/document", { body: "Old plan", revision: 0 }, { ...intern, method: "PUT" })).status, 409);
  const mission = await ui.call("/missions", { title: "Test", body: "Deliver evidence", division: "engineering", team: "engineering-general", assignee: intern.owner, status: "ready" }, lead);
  assert.equal(mission.status, 200);
  assert.equal((await ui.call("/admin/grants", { address: intern.owner, amount: 10, reason: "Approved", request: "http-grant-1", approval: "ISSUE 10 FTHS" }, lead)).status, 404);
  assert.equal((await ui.call("/admin/grants", { address: intern.owner, amount: 10, reason: "Approved", request: "http-grant-1", approval: "ISSUE 10 FTHS" },
    { host: "admin.localhost", admin: true })).status, 200);
  assert.equal((await ui.call("/me", undefined, intern)).body.silver, 10);
  const call = await ui.call("/calls", { channel: "foundation", callee: intern.owner }, lead);
  assert.equal(call.status, 200);
  assert.equal((await ui.call(`/calls/${call.body.id}/signals`, undefined, other)).status, 404);
  assert.equal((await ui.call(`/calls/${call.body.id}/signals`, { type: "accept" }, intern)).status, 200);
  assert.equal((await ui.call(`/calls/${call.body.id}/signals`, { type: "offer", sdp: "v=0" }, lead)).status, 200);
  assert.equal((await ui.call(`/calls/${call.body.id}/signals`, undefined, intern)).body.signals[0].body.type, "offer");
  assert.equal((await ui.call("/push", { endpoint: "https://fcm.googleapis.com/a" }, lead)).status, 503);
  assert.equal((await ui.call("/config", undefined, lead)).body.turnConfigured, false);
  await ui.call("/logout", {}, lead);
  assert.equal((await ui.call("/me", undefined, lead)).status, 401);
});
test("browser push opt-in rejects arbitrary delivery URLs, excludes message contents and stops after membership revocation", async t => {
  const ui = await fixture(t, { APP_VAPID_PUBLIC_KEY: "test-public-key", APP_VAPID_PRIVATE_KEY: "test-private-key" });
  const alice = await ui.login(undefined, "volunteer"), bob = await ui.login(undefined, "intern");
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/fixture", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } };
  for (const endpoint of ["http://localhost/private", "https://localhost/private", "https://fcm.googleapis.com.evil.example/a", "https://fcm.googleapis.com:444/a", "https://user:pass@fcm.googleapis.com/a"])
    assert.equal((await ui.call("/push", { ...subscription, endpoint }, bob)).status, 400);
  assert.equal((await ui.call("/push", subscription, bob)).status, 200);
  assert.equal((await ui.call("/config", undefined, bob)).body.pushPublicKey, "test-public-key");
  assert.equal((await ui.call("/channels/foundation/messages", { request: "push-msg-1", body: "Confidential mission details" }, alice)).status, 200);
  await new Promise(setImmediate);
  assert.equal(ui.deliveries.length, 1);
  assert.equal(ui.deliveries[0].payload.body, "New workspace message");
  assert.doesNotMatch(JSON.stringify(ui.deliveries), /Confidential/);
  await ui.call(`/admin/members/${bob.owner}`, { ...ui.workspace.member(bob.owner), status: "suspended" }, { host: "admin.localhost", admin: true, method: "PUT" });
  assert.equal(ui.notes.db.prepare("SELECT COUNT(*) AS n FROM work_push").get().n, 0);
  assert.equal((await ui.call("/channels", undefined, bob)).status, 403);
});
