"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const express = require("express");
const { ServerUsers } = require("../lib/server-users");
const { serverUsersApi } = require("../lib/server-users-api");
function fixture(passwd = "root:x:0:0:private real name:/root:/bin/bash\nservice:x:100:100::/srv/service:/usr/sbin/nologin\nalice:x:1000:1000:private name:/home/alice:/bin/bash\n") {
  const commands = [], connections = [];
  let ended = 0;
  const settings = { value: { sshTimeoutSeconds: 20 } };
  const service = new ServerUsers({ settings, deployment: { async connect(config) {
    connections.push({ ...config });
    return { end() { ended++; }, exec(command, callback) {
      commands.push(command);
      const stream = new EventEmitter(); stream.stderr = new EventEmitter();
      stream.end = () => process.nextTick(() => { stream.emit("data", Buffer.from(passwd)); stream.emit("close", 0); });
      callback(null, stream);
    } };
  } } });
  service.vault = { use(action, binding, ctx, input) {
    assert.equal(action, "BROWSE SERVER ACCOUNTS");
    if (input.challengeId !== "approved") throw Object.assign(new Error("Approval required"), { status: 403 });
    return { host: "server.example", username: "deploy", password: "fixture-password" };
  }, challengeUse: (action, binding) => ({ action, binding }) };
  const list = input => service.list({ ...input, challengeId: "approved" });
  return { service, commands, connections, list, ended: () => ended };
}
test("account browser uses Settings credentials with approval and returns no password or GECOS fields", async () => {
  const f = fixture(), all = await f.list();
  assert.equal(all.total, 3);
  assert.deepEqual(Object.keys(all.users[0]), ["username", "uid", "gid", "home", "shell"]);
  assert.doesNotMatch(JSON.stringify(all), /private|fixture-password/);
  assert.deepEqual(f.commands, ["getent passwd"]);
  assert.equal(f.connections[0].username, "deploy");
  assert.equal((await f.list({ query: "ALICE" })).total, 1);
  assert.equal((await f.list({ query: "nologin" })).users[0].username, "service");
  assert.equal((await f.list({ page: "2" })).users.length, 0);
  await assert.rejects(f.service.list(), { status: 403 });
  assert.equal(f.ended(), 4);
});
test("account pagination includes all NSS accounts and rejects invalid inputs/output", async () => {
  const f = fixture(Array.from({ length: 121 }, (_, i) => `user${i}:x:${i}:${i}::/home/user${i}:/bin/sh`).join("\n"));
  const pages = await Promise.all(["1", "2", "3"].map(page => f.list({ page })));
  assert.deepEqual(pages.map(page => page.users.length), [50, 50, 21]);
  assert.equal(new Set(pages.flatMap(page => page.users.map(user => user.username))).size, 121);
  for (const page of ["0", "-1", "x", "1;id"]) await assert.rejects(f.list({ page }), { status: 400 });
  await assert.rejects(fixture("invalid").list(), { status: 502 });
});
test("server logs use a fixed file catalog, bind approval to server/log/revision and redact credentials", async () => {
  const f = fixture();
  const settings = f.service.settings;
  settings.value = { revision: 7, sshTimeoutSeconds: 20, runtime: { APP_TURN_SECRET: "saved-runtime-secret" } };
  settings.deploymentTargets = () => [{ id: "shared", host: "server.example", directory: "/opt/featheral", password: "fixture-password" }];
  settings.approvals = {
    challenge(action, binding) { return { action, binding }; },
    consume(action, binding, _context, input) {
      assert.equal(action, "READ SERVER LOG");
      assert.deepEqual(binding, { target: "shared", log: "deployment", revision: 7 });
      if (input.challengeId !== "approved") throw Object.assign(new Error("Approval required"), { status: 403 });
    },
  };
  f.service.deployment.sites = () => [];
  assert.equal(f.service.logCatalog().logs.length, 7);
  assert.deepEqual(f.service.logCatalog().targets, [{ id: "shared", host: "server.example" }]);
  const input = { target: "shared", log: "deployment" };
  assert.equal(f.service.challengeLogs(input, {}).binding.revision, 7);
  for (const log of ["/etc/shadow", "../deployment", "deployment;id"])
    assert.throws(() => f.service.logBinding({ ...input, log }), { status: 400 });
  assert.throws(() => f.service.logBinding({ ...input, target: "unconfigured" }), { status: 400 });
  await assert.rejects(f.service.readLogs(input, {}), { status: 403 });
  f.service.command = async (_client, command, secret) => {
    assert.match(command, /tail -c 65536/);
    assert.match(command, /tail -n 400/);
    assert.match(command, /shared\/logs\/deployment.log/);
    assert.ok(!command.includes("fixture-password"));
    assert.equal(secret, "fixture-password\n");
    return "Error: missing managed-site registry\nfixture-password\nsaved-runtime-secret\nAuthorization: Bearer private-token\nhttps://user:pass@example.com\n";
  };
  const result = await f.service.readLogs({ ...input, challengeId: "approved" }, {});
  assert.match(result.text, /missing managed-site registry/);
  assert.doesNotMatch(result.text, /fixture-password|saved-runtime-secret|private-token|user:pass/);
  assert.equal(f.ended(), 1);
  f.service.command = async () => { throw Object.assign(new Error("SSH operation did not confirm success."), { status: 502 }); };
  await assert.rejects(f.service.readLogs({ ...input, challengeId: "approved" }, {}),
    { status: 502, message: /Check that the log file exists/ });
  assert.equal(f.ended(), 2);
});
test("combined logs use one approval and SSH connection, preserve source labels and report partial failures", async () => {
  const f = fixture(), settings = f.service.settings;
  settings.value = { revision: 3, sshTimeoutSeconds: 20, runtime: {} };
  settings.deploymentTargets = () => [{ id: "shared", host: "server.example", directory: "/opt/featheral", password: "fixture-password" }];
  let approvals = 0, reads = 0;
  settings.approvals = {
    challenge: (_action, binding, _context, message) => ({ binding, message }),
    consume(_action, binding, _context, input) {
      approvals++;
      assert.deepEqual(binding, { target: "shared", log: "all", revision: 3 });
      assert.equal(input.challengeId, "signed");
    },
  };
  f.service.deployment.sites = () => [];
  f.service.deployment.status = () => ({ logs: [{ at: 0, message: "Preparing release" }] });
  f.service.command = async (_client, command, secret) => {
    reads++;
    assert.equal(secret, "fixture-password\n");
    assert.doesNotMatch(command, /fixture-password/);
    if (command.includes("/var/log/nginx/access.log")) throw Object.assign(new Error("SSH operation did not confirm success."), { status: 502 });
    return "Build complete\nfixture-password\n";
  };
  const input = { target: "shared", log: "all", challengeId: "signed" };
  assert.match(f.service.challengeLogs(input, {}).message, /per file; includes CMS/);
  const result = await f.service.readLogs(input, {});
  assert.equal(approvals, 1);
  assert.equal(f.connections.length, 1);
  assert.equal(f.ended(), 1);
  assert.equal(reads, 6);
  assert.equal(result.sources.length, 7);
  assert.match(result.text, /Deployment progress \(CMS\)[\s\S]*Preparing release/);
  assert.match(result.text, /Nginx access ---\nERROR: Could not read/);
  assert.match(result.text, /Certificate setup \/ renewal/);
  assert.doesNotMatch(result.text, /fixture-password/);
  assert.equal(result.sources.filter(source => source.error).length, 1);
  reads = 0;
  f.service.command = async () => { reads++; throw Object.assign(new Error("Server operation timed out."), { status: 504 }); };
  const timeout = await f.service.readLogs(input, {});
  assert.equal(reads, 1);
  assert.equal(timeout.sources.filter(source => source.error).length, 6);
  assert.match(timeout.text, /Not read: SSH connection timed out/);
});
test("root-password change is removed from service, frontend and HTTP routes", async t => {
  const service = fixture().service;
  for (const method of ["changeRoot", "challengeRoot", "rootStatus", "rootConfig"]) assert.equal(service[method], undefined);
  const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/server-users.js"), "utf8");
  assert.doesNotMatch(source, /root-password|server-root|chpasswd|changeRoot|currentPassword|newPassword/);
  const app = express();
  app.use("/api/server-users", serverUsersApi({ service, passwordConfigured: () => true,
    cmsAuth: (req, res, next) => req.get("authorization") === "Basic fixture" ? next() : res.sendStatus(401) }));
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (url, method = "GET", headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/server-users" + url,
      method, headers: { Host: "admin.localhost", Authorization: "Basic fixture", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  for (const route of ["/root-password", "/root-password/challenge", "/root-password/status"]) {
    assert.equal(await request(route), 404);
    assert.equal(await request(route, "POST"), 404);
  }
  assert.equal(await request("", "GET", { Authorization: "" }), 401);
  assert.equal(await request("", "GET", { Host: "app.localhost" }), 404);
  assert.equal(await request("", "GET", { Host: "admin.featheral.com" }), 403);
  assert.equal(await request(""), 403);
});
