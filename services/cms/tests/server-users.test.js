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
