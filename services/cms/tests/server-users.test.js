"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const express = require("express");
const ethers = require("ethers");
const ServerProfileCharts = require("../../../sites/admin.featheral.com/js/server-profile-chart");
const { Wallet } = ethers;
const { ServerUsers } = require("../lib/server-users");
const { serverUsersApi } = require("../lib/server-users-api");
const env = { DEPLOY_TARGET: "root@featheral.com:/opt/featheral", DEPLOY_PASSWORD: "stored-fixture-password",
  DEPLOY_HOST_KEY_SHA256: "SHA256:" + "a".repeat(43) };
const input = { currentPassword: "old-fixture-password", newPassword: "new-fixture-password-123", confirmation: "CHANGE ROOT PASSWORD" };
const context = { origin: "http://admin.localhost", session: "authenticated-fixture-session" };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-server-users-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const connections = [], commands = [], sent = [], clients = [];
  const deployment = {
    running: false,
    async connect(config) {
      connections.push(config);
      if (options.authFailure || options.verificationFailure && connections.length === 2) throw new Error("private diagnostic " + config.password);
      const client = {
        ended: false,
        end() { this.ended = true; },
        exec(command, callback) {
          commands.push(command);
          const stream = new EventEmitter(); stream.stderr = new EventEmitter();
          stream.close = () => {};
          stream.end = data => {
            sent.push(data);
            process.nextTick(() => {
              if (command === "id -u") stream.emit("data", Buffer.from(options.notRoot ? "1000\n" : "0\n"));
              if (command === "getent passwd") stream.emit("data", Buffer.from(options.passwd || "root:x:0:0:private real name:/root:/bin/bash\nservice:x:100:100::/srv/service:/usr/sbin/nologin\nalice:x:1000:1000:private name:/home/alice:/bin/bash\n"));
              if (options.commandFailure && command === "/usr/sbin/chpasswd") stream.stderr.emit("data", Buffer.from(input.newPassword));
              stream.emit("close", options.commandFailure && command === "/usr/sbin/chpasswd" ? 1 : 0);
            });
          };
          callback(null, stream);
        },
      };
      clients.push(client); return client;
    },
  };
  const auditFile = path.join(directory, "audit.jsonl");
  const wallet = Wallet.createRandom(), clock = { now: Date.now() };
  const service = new ServerUsers({ deployment, env: { ...env }, auditFile, originWallet: wallet.address, now: () => clock.now });
  const approve = async (body = input, ctx = context) => {
    const challenge = service.challengeRoot(body, ctx);
    return { ...body, challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) };
  };
  return { service, connections, commands, sent, clients, auditFile, deployment, wallet, clock, approve,
    changeRoot: async (body = input) => service.changeRoot(await approve(body), context) };
}
test("server account browser searches and pages all NSS accounts without password or GECOS fields", async t => {
  const f = fixture(t);
  const all = await f.service.list();
  assert.equal(all.target, "featheral.com"); assert.equal(all.total, 3);
  assert.equal(all.users[0].username, "root");
  assert.deepEqual(Object.keys(all.users[0]), ["username", "uid", "gid", "home", "shell"]);
  assert.ok(!JSON.stringify(all).includes("private"));
  assert.deepEqual(f.commands, ["getent passwd"]);
  assert.equal((await f.service.list({ query: "ALICE" })).total, 1);
  assert.equal((await f.service.list({ query: "nologin" })).users[0].username, "service");
  assert.equal((await f.service.list({ page: "2" })).users.length, 0);
  for (const page of ["0", "-1", "x", "1;id"]) await assert.rejects(f.service.list({ page }), { status: 400 });
  assert.ok(f.clients.every(client => client.ended));
});
test("server account pagination includes every account and rejects malformed output", async t => {
  const passwd = Array.from({ length: 121 }, (_, i) => `user${i}:x:${i}:${i}::/home/user${i}:/bin/sh`).join("\n");
  const f = fixture(t, { passwd });
  const pages = await Promise.all(["1", "2", "3"].map(page => f.service.list({ page })));
  assert.deepEqual(pages.map(page => page.users.length), [50, 50, 21]);
  assert.equal(new Set(pages.flatMap(page => page.users.map(user => user.username))).size, 121);
  await assert.rejects(fixture(t, { passwd: "invalid" }).service.list(), { status: 502 });
});
test("root rotation freshly authenticates current password, sends only fixed commands and verifies the new login", async t => {
  const f = fixture(t);
  const result = await f.changeRoot(input);
  assert.deepEqual(f.commands, ["id -u", "/usr/sbin/chpasswd"]);
  assert.equal(f.connections[0].password, input.currentPassword);
  assert.equal(f.connections[0].username, "root"); assert.equal(f.connections[0].keyFile, "");
  assert.equal(f.connections[1].password, input.newPassword);
  assert.equal(f.sent[1], `root:${input.newPassword}\n`);
  assert.equal(result.verified, true); assert.equal(result.deploymentCredentialUpdateRequired, true);
  assert.equal(f.service.env.DEPLOY_PASSWORD, env.DEPLOY_PASSWORD);
  assert.ok(f.clients.every(client => client.ended));
  const audit = fs.readFileSync(f.auditFile, "utf8");
  assert.match(audit, /"outcome":"verified"/);
  for (const secret of [input.currentPassword, input.newPassword, env.DEPLOY_PASSWORD]) assert.ok(!audit.includes(secret));
});
test("shell metacharacters in a password remain stdin data, and stale stored deployment credentials are not used", async t => {
  const f = fixture(t);
  f.service.env.DEPLOY_PASSWORD = "";
  const newPassword = "fixture-'\"$();`-password";
  await f.changeRoot({ ...input, newPassword });
  assert.deepEqual(f.commands, ["id -u", "/usr/sbin/chpasswd"]);
  assert.equal(f.sent[1], `root:${newPassword}\n`);
  assert.equal(f.connections[0].password, input.currentPassword);
  assert.equal(f.connections[1].password, newPassword);
});
test("verified root rotation stores the new credential without any password environment update", async t => {
  const f = fixture(t), saved = [];
  f.service.env.DEPLOY_PASSWORD = "";
  const { password: ignored, keyFile: ignoredKey, ...target } = require("../lib/deployment").sshConfiguration(env);
  f.service.vault = { env: { DB_VAULT_KEY_FILE: "fixture-external-key" }, key: () => Buffer.alloc(32),
    target: () => target, save: (...args) => saved.push(args) };
  const result = await f.changeRoot();
  assert.equal(result.verified, true); assert.equal(result.credentialStored, true);
  assert.equal(result.deploymentCredentialUpdateRequired, false);
  assert.equal(saved[0][0], input.newPassword); assert.equal(saved[0][1].host, "featheral.com");
  assert.equal(f.service.env.DEPLOY_PASSWORD, "");
  assert.equal(f.service.rootStatus().last.credentialStored, true);
});
test("a vault write failure reports a verified remote password separately from unconfirmed credential storage", async t => {
  const f = fixture(t);
  const { password: ignored, keyFile: ignoredKey, ...target } = require("../lib/deployment").sshConfiguration(env);
  f.service.vault = { env: { DB_VAULT_KEY_FILE: "fixture-external-key" }, key: () => Buffer.alloc(32), target: () => target,
    save: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  const result = await f.changeRoot();
  assert.equal(result.verified, true); assert.equal(result.credentialStored, false);
  assert.match(result.message, /NOT stored/);
  assert.equal(f.service.rootStatus().last.credentialStored, false);
  assert.ok(!fs.readFileSync(f.auditFile, "utf8").includes(input.newPassword));
});
test("invalid inputs, concurrency and deployments block root rotation before SSH", async t => {
  const f = fixture(t);
  for (const change of [{ newPassword: "short" }, { newPassword: "password-with:newline" }, { newPassword: "password-with-\n-newline" },
    { newPassword: input.currentPassword }, { confirmation: "yes" }, { currentPassword: "" }]) {
    await assert.rejects(f.service.changeRoot({ ...input, ...change }), { status: 400 });
  }
  f.deployment.running = true;
  await assert.rejects(f.service.changeRoot(input), { status: 409 });
  f.deployment.running = false; f.service.changing = true;
  await assert.rejects(f.service.changeRoot(input), { status: 409 });
  assert.equal(f.connections.length, 0);
});
test("failed root authentication or identity verification never submits a password change", async t => {
  for (const options of [{ authFailure: true }, { notRoot: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.changeRoot(input), error => {
      assert.ok(!error.message.includes(input.currentPassword));
      return error.status === (options.notRoot ? 403 : 502);
    });
    assert.ok(!f.commands.includes("/usr/sbin/chpasswd"));
    assert.equal(f.service.changing, false);
    assert.match(fs.readFileSync(f.auditFile, "utf8"), /not-submitted/);
  }
});
test("unconfirmed changes never report success, leak passwords or automatically retry", async t => {
  for (const options of [{ commandFailure: true }, { verificationFailure: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.changeRoot(input), error => error.status === 502 && /may already have taken effect/.test(error.message));
    assert.equal(f.commands.filter(command => command === "/usr/sbin/chpasswd").length, 1);
    assert.equal(f.service.changing, false);
    assert.ok(f.clients.every(client => client.ended));
    const audit = fs.readFileSync(f.auditFile, "utf8");
    assert.match(audit, /unverified-check-server/);
    assert.ok(!audit.includes(input.newPassword));
  }
});
test("root password writes require a fresh single-use signature from the exact origin wallet", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.changeRoot(input, context), { status: 403 });
  await assert.rejects(f.service.changeRoot(input), { status: 403 });
  const signed = await f.approve();
  await assert.rejects(f.service.changeRoot({ ...signed, signature: await Wallet.createRandom().signMessage("other") }, context), { status: 403 });
  await assert.rejects(f.service.changeRoot(signed, context), { status: 403 });
  assert.equal(f.commands.length, 0);
  const valid = await f.approve();
  await f.service.changeRoot(valid, context);
  await assert.rejects(f.service.changeRoot(valid, context), { status: 403 });
  assert.equal(f.commands.filter(command => command === "/usr/sbin/chpasswd").length, 1);
});
test("wallet approval binds exact passwords, Admin session, origin and SSH destination and expires in five minutes", async t => {
  for (const scenario of ["current", "new", "origin", "session", "target", "fingerprint", "expired"]) {
    const f = fixture(t);
    const signed = await f.approve();
    const ctx = { ...context };
    if (scenario === "current") signed.currentPassword += "-changed";
    if (scenario === "new") signed.newPassword += "-changed";
    if (scenario === "origin") ctx.origin = "https://other.example";
    if (scenario === "session") ctx.session = "different-admin-login";
    if (scenario === "target") f.service.env.DEPLOY_TARGET = "root@other.example:/opt/featheral";
    if (scenario === "fingerprint") f.service.env.DEPLOY_HOST_KEY_SHA256 = "SHA256:" + "b".repeat(43);
    if (scenario === "expired") f.clock.now += 300000;
    await assert.rejects(f.service.changeRoot(signed, ctx), { status: 403 }, scenario);
    assert.equal(f.connections.length, 0, scenario);
  }
});
test("wallet challenge contains no passwords, password hashes, private keys or Ethereum spending approval", async t => {
  const f = fixture(t);
  const challenge = f.service.challengeRoot(input, context);
  assert.equal(challenge.wallet, f.wallet.address);
  assert.match(challenge.message, /Action: CHANGE ROOT PASSWORD/);
  assert.match(challenge.message, /Origin: http:\/\/admin.localhost/);
  assert.match(challenge.message, /Server: root@featheral.com:22\/opt\/featheral/);
  assert.equal(challenge.expiresAt, f.clock.now + 300000);
  for (const secret of [input.currentPassword, input.newPassword, f.wallet.privateKey]) assert.ok(!JSON.stringify(challenge).includes(secret));
  assert.equal(f.connections.length, 0);
});
async function httpFixture(t, configured = true, actualService) {
  const calls = [];
  const service = actualService || { list: async query => { calls.push(query); return { users: [] }; },
    rootStatus: () => ({ running: false, last: null }),
    challengeRoot: (body, ctx) => { calls.push({ challenge: true, context: ctx }); return { challengeId: "fixture" }; },
    changeRoot: async (body, ctx) => { calls.push({ ...body, context: ctx }); return { verified: true }; } };
  const app = express();
  app.use("/api/server-users", serverUsersApi({ service, passwordConfigured: configured,
    cmsAuth: (req, res, next) => req.get("authorization") === "Basic fixture" ? next() : res.status(401).json({ error: "Admin login required" }) }));
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (pathname = "", body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/server-users" + pathname,
      method: body === undefined ? "GET" : "POST", headers: { Host: "admin.localhost", Origin: "http://admin.localhost",
        "Content-Type": "application/json", ...headers } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { call, calls };
}
test("server account HTTP routes enforce actual Admin login, host, HTTPS and same origin", async t => {
  const f = await httpFixture(t), auth = { Authorization: "Basic fixture" };
  assert.equal((await f.call()).status, 401);
  assert.equal((await f.call("/root-password/status")).status, 401);
  assert.equal((await f.call("", undefined, { ...auth, Host: "app.localhost" })).status, 404);
  assert.equal((await f.call("", undefined, { ...auth, Host: "admin.featheral.com" })).status, 403);
  assert.equal((await f.call("/root-password", input)).status, 401);
  assert.equal((await f.call("/root-password/challenge", input)).status, 401);
  assert.equal((await f.call("/root-password", input, { ...auth, Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.call("/root-password/challenge", input, { ...auth, Origin: "https://evil.example" })).status, 403);
  assert.equal(f.calls.length, 0);
  const response = await f.call("?q=root&page=2", undefined, auth);
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(f.calls[0], { page: "2", query: "root" });
  assert.equal((await f.call("/root-password/challenge", input, auth)).body.challengeId, "fixture");
  assert.equal(f.calls[1].context.origin, "http://admin.localhost");
  assert.notEqual(f.calls[1].context.session, auth.Authorization);
  assert.equal((await f.call("/root-password", input, auth)).body.verified, true);
  assert.equal(f.calls[2].context.session, f.calls[1].context.session);
  const locked = await httpFixture(t, false);
  assert.equal((await locked.call("", undefined, auth)).status, 503);
  assert.equal((await locked.call("/root-password", input, auth)).status, 503);
  assert.equal((await locked.call("/root-password/challenge", input, auth)).status, 503);
  assert.equal((await locked.call("/root-password/status", undefined, auth)).status, 503);
  assert.equal(locked.calls.length, 0);
});
test("root-password HTTP endpoint rate limits attempts and bounds request bodies", async t => {
  const f = await httpFixture(t), auth = { Authorization: "Basic fixture" };
  for (let i = 0; i < 5; i++) assert.equal((await f.call("/root-password", input, auth)).status, 200);
  assert.equal((await f.call("/root-password", input, auth)).status, 429);
  assert.equal(f.calls.length, 5);
  const fresh = await httpFixture(t);
  assert.equal((await fresh.call("/root-password", { newPassword: "a".repeat(5000) }, auth)).status, 413);
  assert.equal(fresh.calls.length, 0);
});
test("HTTP password rotation cannot bypass origin-wallet proof and consumes its approval exactly once", async t => {
  const f = fixture(t), http = await httpFixture(t, true, f.service), auth = { Authorization: "Basic fixture" };
  assert.equal((await http.call("/root-password", input, auth)).status, 403);
  assert.equal(f.connections.length, 0);
  const challenge = await http.call("/root-password/challenge", input, auth);
  assert.equal(challenge.status, 200);
  assert.equal(f.connections.length, 0);
  const approved = { ...input, challengeId: challenge.body.challengeId, signature: await f.wallet.signMessage(challenge.body.message) };
  const response = await http.call("/root-password", approved, auth);
  assert.equal(response.status, 200);
  assert.equal(response.body.verified, true);
  assert.equal((await http.call("/root-password", approved, auth)).status, 403);
  assert.equal(f.commands.filter(command => command === "/usr/sbin/chpasswd").length, 1);
});
test("Admin signing flow blocks cancellation, wallet changes and navigation before hashchange is processed", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/server-users.js"), "utf8");
  for (const scenario of ["success", "wrong-wallet", "cancel", "wallet-change", "navigate", "unconfirmed", "network-error"]) {
    const wallet = Wallet.createRandom(), other = Wallet.createRandom(), nodes = new Map();
    let posts = 0, signs = 0, account = wallet.address;
    const node = selector => {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: "", handlers: {}, replaceChildren() {}, reset() {},
        addEventListener(type, handler) { this.handlers[type] = handler; } });
      return nodes.get(selector);
    };
    const form = node("#server-root-password"), button = {};
    form.elements = Object.fromEntries(["currentPassword", "newPassword", "repeat", "confirmation"].map(key => [key, { value: "" }]));
    form.reset = () => { for (const field of Object.values(form.elements)) field.value = ""; };
    node("#server-user-search").elements = { q: { value: "" } };
    const location = { hash: "#/server-users" };
    const message = "Fixture root-password authorization";
    const provider = { async request() {
      signs++;
      if (scenario === "cancel") throw new Error("Signature cancelled");
      if (scenario === "navigate") location.hash = "#/operations/foundation";
      if (scenario === "wallet-change") account = other.address;
      return wallet.signMessage(message);
    } };
    const ctx = vm.createContext({
      VIEWS: {}, state: { seq: 1 }, viewCleanup: null, leaveView: null, location, ethers,
      ServerProfileCharts,
      window: { FeatheralProfile: { getProvider: () => provider, snapshot: () => ({ account }) } },
      AbortController, URLSearchParams, console, esc: String, confirm: () => true,
      renderSidebar() {}, setCrumbs() {}, setView() {}, toast() {},
      $: selector => selector === "button" ? button : node(selector),
      api: async (url, opts) => {
        if (url.endsWith("/challenge")) return { message, challengeId: "fixture", wallet: scenario === "wrong-wallet" ? other.address : wallet.address };
        if (url.endsWith("/status")) return { running: false, last: null };
        if (opts?.json) {
          posts++;
          if (scenario === "network-error") throw new Error("Connection interrupted");
          return scenario === "unconfirmed" ? { message: "OK" } : { changed: true, verified: true, message: "Fixture verified" };
        }
        return { users: [], total: 0, accounts: 0, pageSize: 50, target: "fixture" };
      },
    });
    vm.runInContext(source, ctx);
    await ctx.VIEWS["server-users"]({}, 1);
    form.elements.currentPassword.value = input.currentPassword;
    form.elements.newPassword.value = form.elements.repeat.value = input.newPassword;
    form.elements.confirmation.value = input.confirmation;
    await form.handlers.submit({ preventDefault() {} });
    assert.equal(posts, ["success", "unconfirmed", "network-error"].includes(scenario) ? 1 : 0, scenario);
    assert.equal(signs, scenario === "wrong-wallet" ? 0 : 1, scenario);
    assert.ok(Object.values(form.elements).every(field => field.value === ""), scenario);
    assert.equal(button.disabled, false);
    const feedback = node("#server-root-status");
    if (scenario === "success") { assert.match(feedback.textContent, /^SUCCESS/); assert.match(feedback.className, /success/); }
    if (["unconfirmed", "network-error"].includes(scenario)) { assert.match(feedback.textContent, /^NOT VERIFIED/); assert.match(feedback.className, /error/); }
    if (scenario === "wrong-wallet") assert.match(feedback.textContent, /^NOT SUBMITTED/);
    await form.handlers.invalid({ target: { validationMessage: "Please fill out this field." } });
    assert.match(feedback.textContent, /NOT SUBMITTED.*Please fill out/);
    ctx.viewCleanup();
  }
});
test("last root-password outcome survives reopening and never exposes audit extras or credentials", async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.rootStatus(), { running: false, last: null });
  await f.changeRoot();
  const reopened = new ServerUsers({ deployment: f.deployment, env, auditFile: f.auditFile });
  const status = reopened.rootStatus();
  assert.equal(status.last.outcome, "verified");
  assert.equal(status.last.host, "featheral.com");
  assert.ok(Number.isFinite(Date.parse(status.last.at)));
  assert.deepEqual(Object.keys(status.last), ["at", "host", "outcome", "credentialStored"]);
  for (const secret of [input.currentPassword, input.newPassword]) assert.ok(!JSON.stringify(status).includes(secret));
  f.service.audit("root-password-change", "requested", "featheral.com");
  assert.equal(reopened.rootStatus().last.outcome, "requested");
  assert.equal(reopened.rootStatus().running, false);
  fs.appendFileSync(f.auditFile, '{"invalid":true}\n');
  assert.throws(() => reopened.rootStatus(), /Invalid root-password/);
});
test("password result HTTP endpoint returns recorded verification, protected and without caching", async t => {
  const f = fixture(t), server = await httpFixture(t, true, f.service), auth = { Authorization: "Basic fixture" };
  assert.equal((await server.call("/root-password/status")).status, 401);
  await f.changeRoot();
  const response = await server.call("/root-password/status", undefined, auth);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.last.outcome, "verified");
});
