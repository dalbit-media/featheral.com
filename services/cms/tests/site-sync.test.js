"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { snapshot, hash, runtimePaths } = require("../../operations/site-sync-snapshot");
const { MARKER, CMS_ORIGIN, readReplica, readCMSOrigin, replicaEnvironment, allowReplicaRequest } = require("../../operations/replica");
const { prepareBackup, installSnapshot, restoreBackup, returnStaged, verifySnapshot,
  replicaHealthURL, probeReplica, waitForReplica, checkTargetSites, probeTargetSite } = require("../../../scripts/restore-site-sync");
const { SiteSync } = require("../lib/site-sync");
test("replica health uses the configured local listener including IPv6", () => {
  for (const host of ["127.0.0.1", "0.0.0.0"])
    assert.equal(replicaHealthURL({ HOST: host, PORT: "6000" }), "http://127.0.0.1:6000/healthz");
  for (const host of ["::", "::1"])
    assert.equal(replicaHealthURL({ HOST: host, PORT: "9000" }), "http://[::1]:9000/healthz");
  assert.equal(replicaHealthURL({ HOST: "localhost" }), "http://localhost:8080/healthz");
  assert.equal(replicaHealthURL({}), "http://127.0.0.1:8080/healthz");
  assert.throws(() => replicaHealthURL({ HOST: "remote.example" }), /local or wildcard/);
  for (const port of ["invalid", "0", "65536", "1.5"])
    assert.throws(() => replicaHealthURL({ PORT: port }), /Invalid target HTTP port/);
});
test("sync site readiness requires deployed assignments, valid HTTPS routes and the actual Pay API", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-site-readiness-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const release = path.join(directory, "current"), file = path.join(release, ".deployment-hosts.json");
  fs.mkdirSync(release);
  const hosts = ["admin.featheral.com", "pay.featheral.com"], calls = [], logs = [];
  let response = {}, payBody = { schema: "featheral.pay", version: 1, currency: "FTH$", paymentUrl: "https://pay.featheral.com/?to=public" };
  const probe = async (host, pathname, options) => {
    calls.push({ host, pathname, options });
    if (response.error) throw response.error;
    return { status: host === "admin.featheral.com" ? 401 : 200, replica: "read-only",
      body: JSON.stringify(payBody), ...response };
  };
  const check = (options = {}) => checkTargetSites(directory, hosts, { probe, log: line => logs.push(line), ...options });
  await assert.rejects(check(), /no deployment host assignment/);
  fs.writeFileSync(file, JSON.stringify({ hosts: ["admin.featheral.com"] }));
  await assert.rejects(check(), /missing assigned sites: pay.featheral.com/);
  assert.equal(calls.length, 0, "missing code/host setup is rejected before probing");
  fs.writeFileSync(file, JSON.stringify({ hosts }));
  await check(); assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).host, "pay.featheral.com");
  assert.match(calls.at(-2).pathname, /^\/api\/v1\/pay\/requests\?to=0x/);
  assert.equal(calls.at(-1).options.method, "POST");
  assert.match(JSON.parse(calls.at(-1).options.body).to, /^0x0+1$/);
  await check({ requireReplica: true });
  assert.ok(logs.some(line => line.includes("pay.featheral.com") && line.includes("read-only")));
  await assert.rejects(check({ probe: (host, pathname, options) => options?.method === "POST"
    ? Promise.resolve({ status: 403 }) : probe(host, pathname, options) }), /POST returned HTTP 403/);
  for (const invalid of [{ status: 404 }, { status: 302 }, { error: new Error("certificate does not match hostname") }]) {
    response = invalid;
    await assert.rejects(check(), /Site setup is not ready.*Review and deploy/);
  }
  response = { replica: undefined };
  await assert.rejects(check({ requireReplica: true }), /read-only replica mode/);
  response = {};
  for (const invalid of [{}, { ...payBody, schema: "unrelated" }, { ...payBody, currency: "USD" },
    { ...payBody, paymentUrl: "http://pay.featheral.com/" }, { ...payBody, paymentUrl: "https://other.featheral.com/" }]) {
    const saved = payBody; payBody = invalid;
    await assert.rejects(check(), /expected Featheral Pay API/); payBody = saved;
  }
  await assert.rejects(checkTargetSites(directory, [], { probe }), /Invalid sync target/);
  await assert.rejects(checkTargetSites(directory, ["host;command"], { probe }), /Invalid sync target/);
});
test("target HTTPS probe retains certificate verification and routes only to loopback with correct SNI", async t => {
  const { EventEmitter } = require("node:events"), https = require("node:https");
  const { PassThrough } = require("node:stream");
  let options;
  t.mock.method(https, "request", (input, callback) => {
    options = input;
    const request = new EventEmitter();
    request.destroy = error => { request.emit("error", error); request.emit("close"); };
    request.end = body => queueMicrotask(() => {
      assert.equal(body, '{"to":"public"}');
      const response = new PassThrough(); response.statusCode = 200;
      response.headers = { "x-featheral-replica": "read-only" }; callback(response);
      response.end('{"schema":"featheral.pay"}');
      response.once("end", () => request.emit("close"));
    });
    return request;
  });
  const result = await probeTargetSite("pay.featheral.com", "/api/v1/pay/requests", { method: "POST", body: '{"to":"public"}' });
  assert.equal(options.hostname, "pay.featheral.com");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["Content-Length"], 15);
  assert.equal(options.rejectUnauthorized, undefined, "TLS verification is never disabled");
  options.lookup("pay.featheral.com", {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, "127.0.0.1"); assert.equal(family, 4);
  });
  options.lookup("pay.featheral.com", { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: "127.0.0.1", family: 4 }]);
  });
  assert.equal(result.replica, "read-only");
  assert.equal(JSON.parse(result.body).schema, "featheral.pay");
});
test("target HTTPS probes reject oversized API responses and stalled connections", async t => {
  const { EventEmitter } = require("node:events"), https = require("node:https");
  const { PassThrough } = require("node:stream");
  let stall = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(https, "request", (_options, callback) => {
    const request = new EventEmitter();
    request.destroy = error => { request.emit("error", error); request.emit("close"); };
    request.end = () => {
      if (stall) return;
      const response = new PassThrough(); response.statusCode = 200; response.headers = {};
      callback(response); response.end("x".repeat(16385));
    };
    return request;
  });
  await assert.rejects(probeTargetSite("pay.featheral.com", "/api/v1/pay/requests"), /exceeds 16 KiB/);
  stall = true;
  const rejected = assert.rejects(probeTargetSite("pay.featheral.com", "/"), /timed out after 5000 ms/);
  t.mock.timers.tick(5000); await rejected;
});
test("Pay replicas allow only stateless request construction, not wallet, ledger or unrelated writes", () => {
  const settings = { replica: { readOnly: true } };
  const res = { setHeader() {}, writeHead(code) { this.status = code; }, end(text) { this.body = text; } };
  for (const host of ["pay.featheral.com", "pay.localhost:8080"]) {
    assert.equal(allowReplicaRequest({ method: "POST", url: "/api/v1/pay/requests", headers: { host } }, res, settings), true);
    for (const url of ["/api/v1/notes/fth/transfers", "/api/creation/login", "/api/v1/pay/qr", "/api/v1/pay/requests/"])
      assert.equal(allowReplicaRequest({ method: "POST", url, headers: { host } }, res, settings), false);
  }
  for (const host of ["wallet.featheral.com", "admin.featheral.com", "evil.example", "pay.featheral.com.evil.example", "bad host", ""])
    assert.equal(allowReplicaRequest({ method: "POST", url: "/api/v1/pay/requests", headers: { host } }, res, settings), false);
  assert.equal(allowReplicaRequest({ method: "PUT", url: "/api/v1/pay/requests", headers: { host: "pay.featheral.com" } }, res, settings), false);
  assert.equal(res.status, 403); assert.match(res.body, /read-only/);
});
test("replica HTTP probe requires a healthy read-only response and exposes connection errors", async t => {
  const http = require("node:http");
  let status = 200, replica = "read-only";
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/healthz");
    if (replica) res.setHeader("X-Featheral-Replica", replica);
    res.writeHead(status); res.end("{}");
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  await probeReplica(url);
  replica = "";
  await assert.rejects(probeReplica(url), /HTTP 200; X-Featheral-Replica: missing/);
  replica = "read-only"; status = 503;
  await assert.rejects(probeReplica(url), /HTTP 503/);
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(probeReplica(url), error => error.code === "ECONNREFUSED");
});
test("replica health allows slow startup and retains actionable failures after all 60 attempts", async () => {
  const url = "http://[::1]:9000/healthz", logs = [], waits = [];
  let attempts = 0;
  const failure = Object.assign(new Error("connect ECONNREFUSED ::1:9000"), { code: "ECONNREFUSED" });
  const options = { log: line => logs.push(line), wait: async ms => waits.push(ms),
    probe: async endpoint => { assert.equal(endpoint, url); if (++attempts < 60) throw failure; } };
  await waitForReplica(url, options);
  assert.equal(attempts, 60); assert.equal(waits.length, 59);
  assert(waits.every(ms => ms === 2000));
  assert(logs.some(line => line.includes("ECONNREFUSED")));
  assert(logs.at(-1).includes("60/60"));
  attempts = 0; waits.length = 0; logs.length = 0;
  await assert.rejects(waitForReplica(url, { ...options, probe: async () => { attempts++; throw failure; } }),
    error => error.cause === failure && error.message.includes(url) && error.message.includes("ECONNREFUSED"));
  assert.equal(attempts, 60); assert.equal(waits.length, 59);
});
test("replica HTTP probe enforces a three-second deadline even when the server never responds", async t => {
  const server = require("node:http").createServer();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const received = require("node:events").once(server, "request");
  const probe = probeReplica(`http://127.0.0.1:${server.address().port}/healthz`);
  const rejected = assert.rejects(probe, /timed out after 3000 ms/);
  await received;
  t.mock.timers.tick(3000);
  await rejected;
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-site-sync-"));
  const root = path.join(directory, "source"), target = path.join(directory, "target");
  function write(base, relative, contents) {
    const file = path.join(base, ...relative.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file;
  }
  for (const base of [root, target]) fs.mkdirSync(path.join(base, "services", "cms", "data"), { recursive: true });
  write(root, "data/fth-ledger/local-node/2026/2026-01-01.jsonl", '{"source":true}\n');
  write(root, "data/file-ledgers/databases/content/2026/2026-01-01/0000000000000001.json", '{"content":true}');
  write(root, "services/cms/data/site/uploads/photo.txt", "source upload");
  write(root, "services/cms/data/site/uploads/private-photo.txt", "ordinary upload with a private filename");
  write(root, "services/cms/data/site/manifest.json", '{"site":"source"}');
  const database = new DatabaseSync(write(root, "data/wallet-profiles.sqlite", ""));
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE wallets (name TEXT); INSERT INTO wallets VALUES ('source wallet');");
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  write(root, "data/dollar-game/game-signing-key.pem", "private-source-key");
  write(root, "data/system-database/databases/system/record.json", "source-server-credentials");
  write(root, "data/file-ledgers/internal/vault/record.json", "source-vault");
  write(root, "data/backups/saved.sqlite", "backup-not-a-database");
  write(root, "services/cms/data/site/.env", "source-environment");
  write(target, "data/keep-unrelated.txt", "unrelated");
  write(target, "data/system-database/databases/system/record.json", "target-server-credentials");
  write(target, "data/file-ledgers/internal/vault/record.json", "target-vault");
  write(target, "data/fth-ledger/local-node/2026/2026-01-02.jsonl", "target-stale-history");
  write(target, "data/fth-ledger/local-node/key.pem", "target-private-key");
  write(target, "services/cms/data/site/uploads/photo.txt", "target overlapping upload");
  write(target, "services/cms/data/site/uploads/extra.txt", "target-only upload");
  return { directory, root, target, write, database };
}
test("snapshot includes live SQLite WAL contents and excludes operational secrets, keys and backups", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot");
  const manifest = snapshot(f.root, output, {});
  const names = manifest.entries.map(entry => entry.name);
  assert(names.includes("data/wallet-profiles.sqlite"));
  assert(!names.some(name => /pem|system-database|internal\/vault|backups|\.env|-wal|-shm/.test(name)));
  const copy = new DatabaseSync(path.join(output, "data", "wallet-profiles.sqlite"), { readOnly: true });
  try { assert.equal(copy.prepare("SELECT name FROM wallets").get().name, "source wallet"); } finally { copy.close(); }
  assert.equal(verifySnapshot(output).entries.length, manifest.entries.length);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM wallets").get().n, 1);
});
test("new-site CMS data participates in sync while Pay code and target setup are never overwritten", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot");
  f.write(f.root, "sites/pay.featheral.com/index.html", "source application code");
  const targetCode = f.write(f.target, "sites/pay.featheral.com/index.html", "installed target application");
  const cmsFile = f.write(f.root, "services/cms/data/site-pages/pay.featheral.com.sqlite", "");
  const database = new DatabaseSync(cmsFile);
  database.exec("CREATE TABLE content(value TEXT); INSERT INTO content VALUES ('Pay content');"); database.close();
  const manifest = snapshot(f.root, output, {});
  assert.ok(manifest.entries.some(entry => entry.name === "cms/site-pages/pay.featheral.com.sqlite"));
  assert.ok(!manifest.entries.some(entry => entry.name.startsWith("sites/")));
  const backup = path.join(f.directory, "backup"), prepared = prepareBackup(f.target, output, backup);
  installSnapshot(f.target, output, backup, prepared);
  assert.equal(fs.readFileSync(targetCode, "utf8"), "installed target application");
  const installed = new DatabaseSync(path.join(f.target, "services", "cms", "data", "site-pages", "pay.featheral.com.sqlite"), { readOnly: true });
  try { assert.equal(installed.prepare("SELECT value FROM content").get().value, "Pay content"); }
  finally { installed.close(); }
});
for (const fails of [false, true]) test(`receiver ${fails ? "rolls back a broken Pay route after restart" : "completes only after every Pay route reports read-only"}`, async t => {
  const f = fixture(t), vm = require("node:vm"), { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream"), { createRequire } = require("node:module");
  const script = path.resolve(__dirname, "../../../scripts/restore-site-sync.js"), actualRequire = createRequire(script);
  const root = path.join(f.directory, "deployment"), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  f.write(f.target, ".deployment-hosts.json", JSON.stringify({ hosts: ["pay.featheral.com"] }));
  for (const name of ["services/operations/replica.js", "services/database/sqlite.js", "services/database/journal.js"])
    f.write(f.target, name, "// replica support");
  snapshot(f.root, output, {});
  const commands = [], probes = [], logs = [];
  let restarted = false;
  const response = (callback, status, body = "") => {
    const stream = new PassThrough(); stream.statusCode = status;
    stream.headers = restarted ? { "x-featheral-replica": "read-only" } : {};
    callback(stream); stream.end(body);
  };
  const request = send => {
    const req = new EventEmitter(); req.destroy = error => { req.emit("error", error); req.emit("close"); };
    req.end = () => queueMicrotask(() => { send(); req.emit("close"); });
    return req;
  };
  const moduleObject = { exports: {} };
  vm.runInNewContext(fs.readFileSync(script, "utf8"), {
    module: moduleObject, Buffer, URL, setTimeout, clearTimeout, process: { platform: "linux", env: {} },
    console: { log: line => logs.push(line), error: line => logs.push(line) },
    require(name) {
      if (name === "node:fs") return { ...fs, realpathSync: file => file === path.join(root, "current") ? f.target : fs.realpathSync(file) };
      if (name === "node:child_process") return { spawnSync: (_program, args) => {
        commands.push(args[0]); if (args[0] === "restart") restarted = true;
        return { status: 0, stdout: args[0] === "jlist"
          ? JSON.stringify([{ name: "featheral", pm2_env: { status: "online", pm_cwd: f.target } }]) : "" };
      } };
      if (name === "node:http") return { get: (_url, _options, callback) => {
        const req = request(() => response(callback, 200)); req.end(); return req;
      } };
      if (name === "node:https") return { request: (options, callback) => request(() => {
        probes.push({ ...options, restarted });
        response(callback, fails && restarted && options.method === "POST" ? 403 : 200,
          JSON.stringify({ schema: "featheral.pay", version: 1, currency: "FTH$", paymentUrl: "https://pay.featheral.com/?to=public" }));
      }) };
      if (name === path.join(f.target, "services", "operations", "settings"))
        return { OperationsSettings: class { environment() { return {}; } } };
      return actualRequire(name);
    },
  }, { filename: script });
  const operation = moduleObject.exports.run(root, output, backup, "another-source", ["pay.featheral.com"]);
  if (fails) await assert.rejects(operation, /POST returned HTTP 403/);
  else await operation;
  const state = JSON.parse(fs.readFileSync(path.join(backup, "state.json"), "utf8"));
  assert.equal(state.phase, fails ? "rolled-back" : "complete");
  assert.equal(commands.filter(command => command === "stop").length, fails ? 2 : 1);
  assert.equal(fs.existsSync(path.join(root, "shared", "site-sync.lock")), false);
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt"), "utf8"),
    fails ? "target overlapping upload" : "source upload");
  assert.equal(Boolean(readReplica(f.target)), !fails);
  assert.ok(probes.some(probe => probe.restarted && probe.method === "POST"));
  assert.ok(logs.some(line => line.includes(fails ? "Previous target state restored" : "Snapshot installed")));
});
test("promoted CMS storage retains its source identity without retaining the replica role", t => {
  const f = fixture(t), marker = path.join(f.root, "data", MARKER), origin = path.join(f.root, "data", CMS_ORIGIN);
  const sourceCMS = { directory: "C:\\original\\services\\cms\\data", separator: "\\" };
  assert.equal(readCMSOrigin(f.root), null);
  fs.writeFileSync(marker, JSON.stringify({ version: 1, readOnly: true, runtime: {}, sourceCMS }));
  assert.deepEqual(readCMSOrigin(f.root), sourceCMS);
  fs.writeFileSync(origin, JSON.stringify({ version: 1, sourceCMS }));
  assert.deepEqual(readCMSOrigin(f.root), sourceCMS);
  fs.unlinkSync(marker);
  assert.equal(readReplica(f.root), null);
  assert.deepEqual(readCMSOrigin(f.root), sourceCMS);
  assert.deepEqual(snapshot(f.root, path.join(f.directory, "promoted-snapshot"), {}).sourceCMS, sourceCMS);
  fs.writeFileSync(marker, JSON.stringify({ version: 1, readOnly: true, runtime: {},
    sourceCMS: { directory: "/different/cms", separator: "/" } }));
  assert.throws(() => readCMSOrigin(f.root), /conflicting CMS storage origin/);
});
test("malformed CMS storage origins fail closed rather than select empty namespaces", t => {
  const f = fixture(t), file = path.join(f.root, "data", CMS_ORIGIN);
  for (const value of [{}, { version: 2, sourceCMS: { directory: "/cms", separator: "/" } },
    ...["relative", "", "/cms\nbad"].map(directory => ({ version: 1, sourceCMS: { directory, separator: "/" } })),
    { version: 1, sourceCMS: { directory: "/cms", separator: "\\" } }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readCMSOrigin(f.root), /CMS storage origin/);
  }
});
test("final frozen sync reuses checksum-verified replica files without staging another full copy", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  const manifest = snapshot(f.root, output, {});
  const entry = manifest.entries.find(entry => entry.name.endsWith("/photo.txt"));
  fs.copyFileSync(path.join(output, ...entry.name.split("/")), path.join(f.target, "services", "cms", "data", ...entry.name.split("/").slice(1)));
  fs.unlinkSync(path.join(output, ...entry.name.split("/")));
  entry.retained = true;
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => verifySnapshot(output), /explicitly selected read-only target/);
  assert.throws(() => verifySnapshot(output, { retainedRoot: f.target }), /read-only target/);
  f.write(f.target, `data/${MARKER}`, JSON.stringify({ version: 1, readOnly: true, runtime: {} }));
  assert.equal(verifySnapshot(output, { retainedRoot: f.target }).entries.length, manifest.entries.length);
  const prepared = prepareBackup(f.target, output, backup);
  assert(prepared.state.records.find(record => record.name === entry.name).unchanged);
  installSnapshot(f.target, output, backup, prepared);
  assert.equal(hash(path.join(f.target, "services", "cms", "data", ...entry.name.split("/").slice(1))), entry.hash);
});
test("retained replica files must still match the frozen source when backup starts", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  const manifest = snapshot(f.root, output, {});
  const entry = manifest.entries.find(entry => entry.name.endsWith("/photo.txt"));
  entry.retained = true;
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  f.write(f.target, `data/${MARKER}`, JSON.stringify({ version: 1, readOnly: true, runtime: {} }));
  assert.throws(() => prepareBackup(f.target, output, backup), /Snapshot checksum mismatch/);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", ...entry.name.split("/").slice(1)), "utf8"), "target overlapping upload");
});
test("verified backup precedes replacement; upload overlay and target credentials survive; rollback is exact", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  snapshot(f.root, output, {});
  const old = new DatabaseSync(f.write(f.target, "data/wallet-profiles.sqlite", ""));
  old.exec("CREATE TABLE wallets (name TEXT); INSERT INTO wallets VALUES ('old target');"); old.close();
  const oldHash = hash(path.join(f.target, "data", "wallet-profiles.sqlite"));
  f.write(f.target, "data/wallet-profiles.sqlite-wal", "stale WAL");
  const prepared = prepareBackup(f.target, output, backup);
  assert.equal(hash(path.join(backup, "data", "wallet-profiles.sqlite")), oldHash);
  installSnapshot(f.target, output, backup, prepared);
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt"), "utf8"), "source upload");
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "extra.txt"), "utf8"), "target-only upload");
  assert(!fs.existsSync(path.join(f.target, "data", "wallet-profiles.sqlite-wal")));
  assert(!fs.existsSync(path.join(f.target, "data", "fth-ledger", "local-node", "2026", "2026-01-02.jsonl")));
  assert.equal(fs.readFileSync(path.join(f.target, "data", "fth-ledger", "local-node", "key.pem"), "utf8"), "target-private-key");
  assert.equal(fs.readFileSync(path.join(f.target, "data", "file-ledgers", "internal", "vault", "record.json"), "utf8"), "target-vault");
  assert.equal(fs.readFileSync(path.join(f.target, "data", "system-database", "databases", "system", "record.json"), "utf8"), "target-server-credentials");
  assert.equal(readReplica(f.target).readOnly, true);
  restoreBackup(prepared.roots, backup, prepared.state);
  assert.equal(hash(path.join(f.target, "data", "wallet-profiles.sqlite")), oldHash);
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt"), "utf8"), "target overlapping upload");
  assert.equal(fs.readFileSync(path.join(f.target, "data", "wallet-profiles.sqlite-wal"), "utf8"), "stale WAL");
  assert(!fs.existsSync(path.join(f.target, "data", MARKER)));
});
test("tampered snapshot and backup fail before changing target files", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  snapshot(f.root, output, {});
  const prepared = prepareBackup(f.target, output, backup);
  const upload = path.join(output, "cms", "site", "uploads", "photo.txt");
  fs.appendFileSync(upload, "tampered");
  assert.throws(() => prepareBackup(f.target, output, path.join(f.directory, "bad-backup")), /checksum/);
  assert(!fs.existsSync(path.join(f.directory, "bad-backup")));
  fs.writeFileSync(upload, "source upload");
  installSnapshot(f.target, output, backup, prepared);
  fs.appendFileSync(path.join(backup, "cms", "site", "uploads", "photo.txt"), "tampered");
  assert.throws(() => restoreBackup(prepared.roots, backup, prepared.state), /Backup checksum/);
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt"), "utf8"), "source upload");
});
test("install moves staged files without extra copies, skips identical targets and returns staging on rollback", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  const manifest = snapshot(f.root, output, {});
  const same = manifest.entries.find(entry => entry.name !== "cms/site/uploads/photo.txt" && /\/uploads\//.test(entry.name))
    || manifest.entries.find(entry => entry.name.startsWith("data/") && !/\.sqlite$/.test(entry.name));
  const [kind, ...parts] = same.name.split("/");
  const sameTarget = path.join(f.target, ...(kind === "cms" ? ["services", "cms", "data"] : ["data"]), ...parts);
  fs.mkdirSync(path.dirname(sameTarget), { recursive: true });
  fs.copyFileSync(path.join(output, ...same.name.split("/")), sameTarget);
  const targetUpload = path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt");
  const oldInode = fs.statSync(targetUpload).ino;
  const prepared = prepareBackup(f.target, output, backup);
  assert(prepared.state.records.some(record => record.name === same.name && record.unchanged));
  assert(!fs.existsSync(path.join(backup, ...same.name.split("/"))));
  const stagedUpload = path.join(output, "cms", "site", "uploads", "photo.txt");
  const stagedInode = fs.statSync(stagedUpload).ino;
  installSnapshot(f.target, output, backup, prepared);
  assert(!fs.existsSync(stagedUpload));
  assert.equal(fs.statSync(targetUpload).ino, stagedInode);
  assert.equal(fs.statSync(path.join(backup, "cms", "site", "uploads", "photo.txt")).ino, oldInode);
  assert(fs.existsSync(path.join(output, ...same.name.split("/"))));
  returnStaged(prepared, output);
  restoreBackup(prepared.roots, backup, prepared.state);
  assert.equal(fs.readFileSync(stagedUpload, "utf8"), "source upload");
  assert.equal(fs.readFileSync(targetUpload, "utf8"), "target overlapping upload");
  assert.equal(fs.statSync(targetUpload).nlink, 1);
  verifySnapshot(output);
});
test("receiver refuses insufficient measured backup/install space before creating a backup or replacing records", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "low-space-backup");
  snapshot(f.root, output, {});
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1n, bsize: 4096n });
  try { assert.throws(() => prepareBackup(f.target, output, backup), /Insufficient target space/); }
  finally { fs.statfsSync = original; }
  assert(!fs.existsSync(backup));
  assert.equal(fs.readFileSync(path.join(f.target, "services", "cms", "data", "site", "uploads", "photo.txt"), "utf8"), "target overlapping upload");
});
test("unsupported external storage and traversal are explicitly rejected", t => {
  const f = fixture(t);
  assert.throws(() => runtimePaths(f.root, { DB_LEDGER_DIR: f.directory }), /outside/);
  const output = path.join(f.directory, "snapshot");
  const manifest = snapshot(f.root, output, {});
  manifest.entries[0].name = "data/../../escape";
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => verifySnapshot(output), /Unsupported/);
});
test("replica disables all financial writers and mutation requests while preserving target Settings", t => {
  const f = fixture(t), output = path.join(f.directory, "snapshot"), backup = path.join(f.directory, "backup");
  snapshot(f.root, output, {}); installSnapshot(f.target, output, backup);
  const env = replicaEnvironment(f.target, { PORT: "9000", FTH_LEDGER_MODE: "writer", WORLD_LEDGER_MODE: "writer",
    GOLD_RESERVE_MODE: "live", FTH_LEDGER_SIGNING_PRIVATE_KEY: "target-secret", BRIDGE_DEPLOYER_PRIVATE_KEY: "target-bridge" });
  assert.equal(env.PORT, "9000");
  assert.equal(env.FTH_LEDGER_MODE, "reader"); assert.equal(env.WORLD_LEDGER_MODE, "reader");
  assert.equal(env.GOLD_RESERVE_MODE, "disabled"); assert.equal(env.FTH_LEDGER_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(env.BRIDGE_DEPLOYER_PRIVATE_KEY, undefined);
  const res = { setHeader() {}, writeHead(code) { this.statusCode = code; }, end(body) { this.body = body; } };
  const settings = { replica: readReplica(f.target) };
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(allowReplicaRequest({ method, url: "/api/public/write" }, res, settings), false);
    assert.equal(res.statusCode, 403); assert.match(res.body, /read-only/);
  }
  assert(allowReplicaRequest({ method: "GET", url: "/healthz" }, res, settings));
  assert(allowReplicaRequest({ method: "GET", url: "/api/notes" }, res, settings));
  fs.writeFileSync(path.join(f.target, "data", MARKER), '{"readOnly":false}');
  assert.throws(() => readReplica(f.target), /Refusing startup/);
});
test("review binds a frozen snapshot to site target, session, revision and wallet approval", async t => {
  const f = fixture(t), calls = [];
  const target = { id: "gold", host: "replica.example.com", port: 22, directory: "/srv/featheral",
    fingerprint: "SHA256:fixture", hosts: ["gold.featheral.com"], password: "ssh-secret" };
  const settings = { value: { revision: 3, siteServers: { gold: { useShared: false } } }, environment: () => ({}),
    deploymentTargets: (_sites, passwords) => [{ ...target, password: passwords ? target.password : "" }],
    approvals: { challenge: (...args) => { calls.push(args); return { message: "approval" }; },
      consume: (_action, binding, _context, input) => { assert.equal(binding.target, "gold"); assert.equal(input.signature, "signed"); } } };
  const deployment = { running: false, sites: () => [{ key: "gold", hostname: "gold.featheral.com", status: "ready" }] };
  let now = Date.now();
  const service = new SiteSync({ root: f.root, settings, deployment, now: () => now });
  const context = { session: "admin", origin: "https://admin.example", wallet: "wallet" };
  const review = await service.plan({ site: "gold" }, context);
  assert.equal(review.target, "gold"); assert.equal(review.readOnly, true);
  assert.deepEqual(review.hosts, target.hosts);
  assert(!JSON.stringify(review).includes("ssh-secret")); assert.equal(calls.length, 0);
  assert.throws(() => service.challenge({ plan: review.id }, { ...context, session: "other" }), /another session/);
  service.challenge({ plan: review.id }, context);
  assert.equal(calls[0][1].digest, review.digest); assert.match(calls[0][3], /ALL installation/);
  settings.value.revision++;
  assert.throws(() => service.start({ plan: review.id, signature: "signed" }, context), /Settings changed/);
  settings.value.revision--;
  target.hosts.push("pay.featheral.com");
  assert.throws(() => service.start({ plan: review.id, signature: "signed" }, context), /Settings changed/);
  target.hosts.pop();
  now += 11 * 60000;
  assert.throws(() => service.challenge({ plan: review.id }, context), /expired/);
  assert(!fs.existsSync(path.join(f.root, "data", "site-sync", review.id)));
});
test("sync transport uses the pinned saved target, SFTP and signed stdin-only credentials; no transfer during review", async t => {
  const f = fixture(t), commands = [], transfers = [];
  const target = { id: "gold", host: "replica.example.com", port: 22, directory: "/srv/featheral",
    fingerprint: "SHA256:fixture", hosts: ["gold.featheral.com"], password: "ssh-secret", sshTimeoutSeconds: 20, deploymentTimeoutSeconds: 900 };
  let consumed = 0, ended = false;
  const settings = { value: { revision: 1, siteServers: { gold: { useShared: false } } }, environment: () => ({}),
    deploymentTargets: (_sites, passwords) => [{ ...target, password: passwords ? target.password : "" }],
    approvals: { consume: (_action, binding, _context, input) => { assert.equal(input.signature, "signed"); assert.equal(binding.host, target.host); consumed++; } } };
  let uploaded = Buffer.alloc(0);
  const client = { end() { ended = true; }, sftp(callback) { callback(null, {
    lstat(_remote, callback) { callback(Object.assign(new Error("Missing"), { code: 2 })); },
    open(remote, flags, mode, callback) { assert.equal(flags, "wx"); assert.equal(mode, 0o600); uploaded = Buffer.alloc(0); transfers.push({ remote }); callback(null, Buffer.from("handle")); },
    write(_handle, chunk, offset, length, position, callback) {
      assert.equal(position, uploaded.length); uploaded = Buffer.concat([uploaded, chunk.subarray(offset, offset + length)]); callback();
    },
    close(_handle, callback) { callback(); }, end() {},
  }); } };
  const deployment = { running: false, sites: () => [{ key: "gold", hostname: "gold.featheral.com" }],
    async connect(config) { assert.equal(config.password, target.password); assert.equal(config.fingerprint, target.fingerprint); return client; },
    async execute(_client, command, input, _timeout, _onPhase, onLog) {
      commands.push({ command, input });
      if (command.startsWith("df -Pk")) onLog("999999999");
      if (command.includes("sha256sum <")) onLog(require("node:crypto").createHash("sha256").update(uploaded).digest("hex") + "  -");
      if (command.includes("systemd-run")) {
        onLog("FEATHERAL_SYNC:backup"); assert.equal(service.status().progress.percent, 80);
        onLog("FEATHERAL_SYNC:health"); assert.equal(service.status().progress.percent, 95);
        onLog("password=ssh-secret"); onLog("Private value ssh-secret");
        onLog("Read-only health check 1/30.");
      }
    },
    transfer: (_client, operation) => new Promise((resolve, reject) => operation((error, result) => error ? reject(error) : resolve(result))) };
  const service = new SiteSync({ root: f.root, settings, deployment });
  const context = { session: "admin", origin: "https://admin.example" };
  const review = await service.plan({ site: "gold" }, context);
  assert.equal(commands.length, 0); assert.equal(transfers.length, 0);
  const result = service.start({ plan: review.id, signature: "signed" }, context);
  assert.equal(result.running, true); assert.equal(consumed, 1);
  await service.transferTask;
  assert.equal(service.status().phase, "complete"); assert(ended);
  assert.equal(require("node:crypto").createHash("sha256").update(uploaded).digest("hex"), review.digest);
  assert.equal(service.status().progress.percent, 100);
  assert(service.status().logs.some(entry => entry.message.includes("health check 1/30")));
  assert(!JSON.stringify(service.status().logs).includes("ssh-secret"));
  const restored = new SiteSync({ root: f.root, settings, deployment });
  assert.deepEqual(restored.status().logs, service.status().logs);
  assert.equal(restored.status().progress.percent, 100);
  assert.equal(transfers.at(-1).remote.endsWith("/manifest.json"), true);
  const names = transfers.map(entry => entry.remote);
  assert(names.findIndex(name => name.includes("/uploads/")) > names.findIndex(name => name.endsWith("wallet-profiles.sqlite")));
  assert(!names.some(name => name.endsWith(".zip")));
  assert(!commands.some(item => item.command.includes("ssh-secret")));
  const apply = commands.find(item => item.command.includes("systemd-run"));
  assert.equal(apply.input, "ssh-secret\n");
  assert.match(apply.command, /sha256sum --check/); assert.match(apply.command, /restore-site-sync/);
  const preflight = commands.findIndex(item => item.command.includes("--check-sites"));
  assert.ok(preflight >= 0);
  assert.match(commands[preflight].command, /gold\.featheral\.com/);
  assert.ok(preflight < commands.findIndex(item => item.command.includes("systemd-run")));
});
test("shared sync captures and launches in one request without separate wallet approval", async t => {
  const f = fixture(t);
  const target = { id: "shared", host: "shared.example.com", port: 22, directory: "/srv/featheral",
    fingerprint: "SHA256:shared", hosts: ["gold.featheral.com"], password: "ssh-secret" };
  const settings = { value: { revision: 1 }, environment: () => ({}),
    deploymentTargets: (_sites, passwords) => [{ ...target, password: passwords ? target.password : "" }],
    approvals: { consume() { assert.fail("Shared sync must not request separate approval"); } } };
  const deployment = { running: false, sites: () => [{ key: "gold", status: "ready" }] };
  const service = new SiteSync({ root: f.root, settings, deployment });
  let launched = 0;
  service.execute = async (plan, connection) => {
    launched++;
    assert.equal(plan.binding.target, "shared");
    assert.equal(hash(plan.archive), plan.binding.digest);
    assert.equal(connection.password, "ssh-secret");
    service.finish("complete", "Shared target confirmed.");
  };
  const context = { session: "admin", origin: "https://admin.example" };
  await assert.rejects(service.startShared({ site: "gold", revision: 0 }, context), /Settings changed/);
  assert.equal(launched, 0); assert.equal(service.plans.size, 0);
  await service.startShared({ site: "gold", revision: 1 }, context);
  assert.equal(launched, 1); assert.equal(service.status().phase, "complete");
  assert.equal(service.plans.size, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.readdirSync(service.directory).filter(name => fs.statSync(path.join(service.directory, name)).isDirectory()).length, 0);
  settings.value.siteServers = { gold: { useShared: false } };
  target.id = "gold";
  await assert.rejects(service.startShared({ site: "gold", revision: 1 }, context), /requires snapshot review/);
  assert.equal(launched, 1);
});
test("shared sync preserves operation locks and rejects Settings changes during capture", async t => {
  const f = fixture(t);
  const settings = { value: { revision: 1 }, environment: () => { settings.value.revision++; return {}; },
    deploymentTargets: () => [{ id: "shared", host: "shared.example.com", port: 22, directory: "/srv/featheral", hosts: ["gold.featheral.com"], fingerprint: "SHA256:shared" }] };
  const deployment = { running: true, sites: () => [{ key: "gold", status: "ready" }] };
  const service = new SiteSync({ root: f.root, settings, deployment });
  service.execute = async () => assert.fail("Changed or busy target must not receive data");
  const context = { session: "admin", origin: "https://admin.example" };
  await assert.rejects(service.startShared({ site: "gold", revision: 1 }, context), /current server operation/);
  deployment.running = false;
  await assert.rejects(service.startShared({ site: "gold", revision: 1 }, context), /Settings changed/);
  service.finish("uncertain", "Previous transfer unconfirmed.");
  await assert.rejects(service.startShared({ site: "gold", revision: 2 }, context), /previous sync is unconfirmed/);
});
test("sync failures retain redacted details and never report completed progress", async t => {
  const f = fixture(t);
  const settings = { value: { revision: 1 }, environment: () => ({}),
    deploymentTargets: () => [{ id: "shared", host: "shared.example.com", port: 22,
      directory: "/srv/featheral", hosts: ["gold.featheral.com"], fingerprint: "SHA256:shared", password: "fixture-secret" }] };
  const deployment = { running: false, sites: () => [{ key: "gold", status: "ready" }] };
  const service = new SiteSync({ root: f.root, settings, deployment });
  service.execute = async () => { service.result.phase = "applying"; throw new Error("SSH rejected fixture-secret"); };
  await service.startShared({ site: "gold", revision: 1 }, { session: "admin", origin: "https://admin.example" });
  for (let attempt = 0; attempt < 20 && service.running; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().phase, "uncertain");
  assert(service.status().progress.percent < 100);
  assert(service.status().logs.some(entry => entry.message.includes("SSH rejected [REDACTED]")));
  assert(!JSON.stringify(service.status()).includes("fixture-secret"));
  await new Promise(resolve => setImmediate(resolve));
  for (let line = 0; line < 205; line++) service.log(`Detail line ${line}`);
  assert.equal(service.status().logs.length, 200);
  assert.equal(service.status().logs[0].message, "Detail line 5");
  const restored = new SiteSync({ root: f.root, settings, deployment });
  assert.equal(restored.status().phase, "uncertain");
  assert.deepEqual(restored.status().logs, service.status().logs);
});
test("Settings sync API requires the Admin host, authentication, same origin and a managed site", async t => {
  const express = require("express"), http = require("node:http"), { once } = require("node:events");
  const calls = [];
  const service = { status: () => ({ phase: "idle", running: false }),
    plan: async (input, context) => { calls.push({ input, context }); return { id: "snapshot" }; },
    startShared: async (input, context) => { calls.push({ input, context }); return { phase: "transferring", running: true }; },
    resume: async input => { calls.push({ input }); return { phase: "transferring", running: true }; } };
  const app = express();
  app.use("/api/settings", require("../../operations/api").settingsApi({
    settings: {}, siteSync: service, sites: () => [{ key: "gold", status: "ready" }],
    cmsAuth: (req, res, next) => req.get("authorization") === "fixture-admin" ? next() : res.sendStatus(401),
  }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (pathname, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: `/api/settings${pathname}`,
      method: options.method || "GET", headers: { Host: options.host || "admin.localhost", Authorization: "fixture-admin", "Content-Type": "application/json", ...options.headers } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(body) }));
    });
    req.on("error", reject); req.end(options.json ? JSON.stringify(options.json) : undefined);
  });
  assert.equal((await request("/sites/gold/sync")).status, 200); assert.equal(calls.length, 0);
  assert.equal((await request("/sites/gold/sync", { headers: { Authorization: "" } })).status, 401);
  assert.equal((await request("/sites/gold/sync", { host: "gold.localhost" })).status, 404);
  assert.equal((await request("/sites/gold/sync/plan", { method: "POST" })).status, 403);
  assert.equal((await request("/sites/unknown/sync/plan", { method: "POST", headers: { Origin: "http://admin.localhost" } })).status, 404);
  const reviewed = await request("/sites/gold/sync/plan", { method: "POST", headers: { Origin: "http://admin.localhost" } });
  assert.equal(reviewed.status, 200); assert.equal((await reviewed.json()).id, "snapshot");
  assert.equal(calls.length, 1); assert.equal(calls[0].input.site, "gold");
  assert.equal(calls[0].context.origin, "http://admin.localhost");
  const sharedPath = "/sites/gold/sync/shared/start";
  assert.equal((await request(sharedPath, { method: "POST" })).status, 403);
  assert.equal((await request(sharedPath, { method: "POST", headers: { Authorization: "" } })).status, 401);
  assert.equal((await request(sharedPath, { method: "POST", host: "gold.localhost" })).status, 404);
  assert.equal((await request("/sites/unknown/sync/shared/start", { method: "POST", headers: { Origin: "http://admin.localhost" } })).status, 404);
  assert.equal(calls.length, 1);
  const shared = await request(sharedPath, { method: "POST", headers: { Origin: "http://admin.localhost" }, json: { revision: 7, site: "other" } });
  assert.equal(shared.status, 200); assert.equal((await shared.json()).phase, "transferring");
  assert.equal(calls[1].input.site, "gold"); assert.equal(calls[1].input.revision, 7);
  assert.equal(calls[1].context.origin, "http://admin.localhost");
  const resumePath = "/sites/gold/sync/resume";
  assert.equal((await request(resumePath, { method: "POST" })).status, 403);
  assert.equal((await request(resumePath, { method: "POST", headers: { Authorization: "" } })).status, 401);
  assert.equal((await request(resumePath, { method: "POST", host: "gold.localhost" })).status, 404);
  assert.equal((await request("/sites/unknown/sync/resume", { method: "POST", headers: { Origin: "http://admin.localhost" } })).status, 404);
  const resumed = await request(resumePath, { method: "POST", headers: { Origin: "http://admin.localhost" }, json: { site: "other" } });
  assert.equal(resumed.status, 200); assert.equal(calls[2].input.site, "gold");
});
async function uiFixture({ shared = false, initialStatus = { phase: "idle", running: false } } = {}) {
  const vm = require("node:vm"), elements = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: "", checked: false, hidden: false, disabled: false, textContent: "", listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; }, reset() {} });
    return elements.get(selector);
  };
  const form = element("#site-server-form");
  form.elements = Object.fromEntries(["url", "host", "port", "useShared", "credential", "applyRuntime"].map(name => [name, element(name)]));
  let signs = 0, failure, pendingStart, status = initialStatus, html = "";
  const context = vm.createContext({
    VIEWS: {}, state: { seq: 1 }, location: { hash: "#/site-server/gold" }, viewCleanup: null, leaveView: null,
    AbortController, setTimeout, clearTimeout, esc: value => String(value), $: element, renderSidebar() {}, setCrumbs() {}, setView(value) { html = value; }, toast() {},
    window: { addEventListener() {}, removeEventListener() {} }, confirm: () => true,
    FormData: class { constructor(value) { this.entries = Object.entries(value.elements).map(([key, item]) => [key, item.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } },
    approveAdminAction: async () => { signs++; return { signature: "signed" }; },
    api: async (url, options) => {
      calls.push({ url, input: options?.json });
      if (url === "/api/sites") return [{ key: "gold", hostname: "gold.featheral.com" }];
      if (url.endsWith("/sites/gold")) return { revision: 1, useShared: shared, host: "replica.example", url: "https://gold.example", port: 22, controls: [] };
      if (url.endsWith("/sync")) return status;
      if (url.endsWith("/plan")) {
        if (failure) throw failure;
        return { id: "review", host: "replica.example", port: 22, directory: "/srv/featheral", files: 10, bytes: 1024,
          createdAt: "snapshot-time", expiresAt: "expiry-time", hosts: ["gold.example"], exclusions: ["Keep target credentials"] };
      }
      if (url.endsWith("/challenge")) return { message: "review" };
      if (url.endsWith("/start") || url.endsWith("/resume")) {
        if (failure) throw failure;
        if (pendingStart) await pendingStart;
        status = { running: false, phase: "complete", message: "confirmed" }; return status;
      }
      throw new Error("Unexpected UI request: " + url);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/settings.js"), "utf8"), context);
  await context.VIEWS["site-server"]("gold", {}, 1);
  return { calls, element, context, form, get html() { return html; }, get signs() { return signs; }, fail(error) { failure = error; },
    holdStart() {
      status = { running: true, phase: "preparing", progress: { percent: 15, stage: "Compressing archive." },
        logs: [{ at: 1, message: "Verified source snapshot." }] };
      let release;
      pendingStart = new Promise(resolve => { release = resolve; });
      return release;
    },
    click: selector => element(selector).listeners.click() };
}
test("site Settings waits for review, explicit confirmation and wallet approval before syncing", async () => {
  const f = await uiFixture();
  assert.match(f.html, /Adding a site such as Pay/);
  assert.match(f.html, /href="#\/settings"/);
  assert.match(f.html, /does not copy application code or configure DNS\/TLS/);
  assert(!f.calls.some(call => call.url.endsWith("/plan")));
  await f.click("#site-sync-start");
  assert.equal(f.signs, 0);
  await f.click("#site-sync-review");
  assert.equal(f.element("#site-sync-plan").hidden, false); assert.equal(f.element("#site-sync-start").disabled, true);
  f.element("#site-sync-confirm").checked = true; f.element("#site-sync-confirm").listeners.change();
  assert.equal(f.element("#site-sync-start").disabled, false);
  await f.click("#site-sync-start");
  assert.equal(f.signs, 1);
  const started = f.calls.find(call => call.url.endsWith("/start"));
  assert.equal(started.input.plan, "review"); assert.equal(started.input.signature, "signed");
  assert.match(f.element("#site-sync-status").textContent, /confirmed/);
  f.context.viewCleanup();
});
test("unsaved Settings and snapshot failures cannot start sync; errors remain visible", async () => {
  const f = await uiFixture();
  f.form.elements.host.value = "unsaved";
  await f.click("#site-sync-review");
  assert.match(f.element("#site-sync-status").textContent, /Save or reload/);
  assert(!f.calls.some(call => call.url.endsWith("/plan")));
  f.form.elements.host.value = "replica.example";
  f.fail(new Error("Snapshot source changed"));
  await f.click("#site-sync-review");
  assert.match(f.element("#site-sync-status").textContent, /Snapshot source changed/);
  assert.equal(f.element("#site-sync-start").disabled, true);
  assert.equal(f.signs, 0); f.context.viewCleanup();
});
test("shared site Settings starts in one click with no review, confirmation or wallet prompt", async () => {
  const f = await uiFixture({ shared: true });
  assert.equal(f.element("#site-sync-review").hidden, true);
  assert.equal(f.element("#site-sync-confirmation").hidden, true);
  assert.equal(f.element("#site-sync-start").disabled, false);
  assert(!f.calls.some(call => call.input));
  await f.click("#site-sync-start");
  assert.equal(f.signs, 0);
  const mutations = f.calls.filter(call => call.input);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, "/api/settings/sites/gold/sync/shared/start");
  assert.equal(mutations[0].input.revision, 1);
  assert.match(f.element("#site-sync-status").textContent, /confirmed/);
  f.context.viewCleanup();
});
test("sync panel restores progress and renders detail logs as text without jumping away from older output", async () => {
  const f = await uiFixture({ shared: true, initialStatus: { phase: "applying", running: false,
    progress: { percent: 80, stage: "Creating verified backup." },
    logs: [{ at: 1, message: "<script>unsafe()</script>" }, { at: 2, message: "Backup file verified." }] } });
  assert.equal(f.element("#site-sync-progress").value, 80);
  assert.match(f.element("#site-sync-progress-label").textContent, /80%.*verified backup/);
  assert.match(f.element("#site-sync-log").textContent, /<script>unsafe\(\)<\/script>/);
  assert.equal(f.element("#site-sync-log").innerHTML, undefined);
  const console = f.element("#site-sync-log");
  console.scrollHeight = 1000; console.scrollTop = 100; console.clientHeight = 200;
  console.textContent = "";
  await f.click("#site-sync-refresh");
  assert.equal(console.scrollTop, 100);
  console.scrollTop = 800; console.textContent = "";
  await f.click("#site-sync-refresh");
  assert.equal(console.scrollTop, 1000);
  f.context.viewCleanup();
});
test("shared sync polls and displays progress while the start request is still pending", async () => {
  const f = await uiFixture({ shared: true });
  const release = f.holdStart();
  const request = f.click("#site-sync-start");
  try {
    assert.match(f.element("#site-sync-log").textContent, /Sync requested/);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert(f.calls.filter(call => call.url.endsWith("/sync")).length >= 2);
    assert.equal(f.element("#site-sync-progress").value, 15);
    assert.match(f.element("#site-sync-log").textContent, /Verified source snapshot/);
    assert.equal(f.element("#site-sync-start").disabled, true);
  } finally { release(); await request; f.context.viewCleanup(); }
});
test("shared sync blocks unsaved or uncertain state and displays start failures", async () => {
  const f = await uiFixture({ shared: true });
  f.form.elements.useShared.value = "false";
  f.form.listeners.input();
  assert.equal(f.element("#site-sync-start").disabled, true);
  await f.click("#site-sync-start");
  assert(!f.calls.some(call => call.input));
  f.form.elements.useShared.value = "true";
  f.form.listeners.input();
  assert.equal(f.element("#site-sync-start").disabled, false);
  f.fail(new Error("Shared target unavailable"));
  await f.click("#site-sync-start");
  assert.match(f.element("#site-sync-status").textContent, /Shared target unavailable/);
  assert.equal(f.signs, 0); f.context.viewCleanup();
  const blocked = await uiFixture({ shared: true, initialStatus: { phase: "uncertain", running: false } });
  assert.equal(blocked.element("#site-sync-start").disabled, true);
  await blocked.click("#site-sync-start");
  assert(!blocked.calls.some(call => call.input));
  blocked.context.viewCleanup();
});
test("paused upload offers Continue transfer without requesting another snapshot or approval", async () => {
  const f = await uiFixture({ shared: true, initialStatus: { phase: "paused", site: "gold", resumable: true, running: false } });
  assert.equal(f.element("#site-sync-resume").hidden, false);
  assert.equal(f.element("#site-sync-start").disabled, true);
  f.form.elements.host.value = "unsaved"; f.form.listeners.input();
  assert.equal(f.element("#site-sync-resume").disabled, true);
  await f.click("#site-sync-resume"); assert(!f.calls.some(call => call.input));
  f.form.elements.host.value = "replica.example"; f.form.listeners.input();
  assert.equal(f.element("#site-sync-resume").disabled, false);
  await f.click("#site-sync-resume");
  assert.equal(f.signs, 0);
  const mutations = f.calls.filter(call => call.input);
  assert.equal(mutations.length, 1); assert.equal(mutations[0].url, "/api/settings/sites/gold/sync/resume");
  assert.match(f.element("#site-sync-status").textContent, /confirmed/);
  f.context.viewCleanup();
  const other = await uiFixture({ initialStatus: { phase: "paused", site: "other", resumable: true, running: false } });
  assert.equal(other.element("#site-sync-resume").hidden, true);
  await other.click("#site-sync-resume"); assert(!other.calls.some(call => call.input));
  other.context.viewCleanup();
});
function resumableFixture(t) {
  const f = fixture(t), crypto = require("node:crypto");
  const data = crypto.randomBytes(1024 * 1024 + 71), id = crypto.randomUUID();
  const directory = path.join(f.root, "data", "site-sync", id), archive = path.join(directory, "snapshot", "manifest.json");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(path.join(directory, "snapshot", "payload.bin"), data);
  fs.writeFileSync(archive, JSON.stringify({ entries: [{ name: "payload.bin", bytes: data.length, hash: crypto.createHash("sha256").update(data).digest("hex") }] }));
  const target = { id: "shared", host: "shared.example.com", port: 22, directory: "/srv/featheral",
    fingerprint: "SHA256:fixture", password: "ssh-secret", hosts: ["gold.featheral.com"], sshTimeoutSeconds: 1, deploymentTimeoutSeconds: 1 };
  const binding = { id, site: "gold", target: target.id, host: target.host, port: target.port,
    directory: target.directory, fingerprint: target.fingerprint, hosts: [...target.hosts], digest: hash(archive), revision: 1, transport: "files-v1" };
  const state = { remote: null, manifest: null, writes: [], commands: [], delay: 0, failAt: null, stall: false, ended: 0, applied: 0 };
  const settings = { value: { revision: 1 }, deploymentTargets: () => [{ ...target }] };
  const sftp = {
    lstat(remote, callback) {
      const value = remote.endsWith("/manifest.json") ? state.manifest : state.remote;
      if (value === null) callback(Object.assign(new Error("Missing"), { code: 2 }));
      else callback(null, { size: value.length, isFile: () => true });
    },
    open(remote, flags, mode, callback) {
      assert.equal(mode, 0o600);
      if (remote.endsWith("/manifest.json")) { state.manifest = Buffer.alloc(0); callback(null, Buffer.from("manifest")); return; }
      if (flags === "wx") { assert.equal(state.remote, null); state.remote = Buffer.alloc(0); }
      else assert.equal(flags, "r+");
      callback(null, Buffer.from("handle"));
    },
    write(_handle, buffer, offset, length, position, callback) {
      if (_handle.toString() === "manifest") { state.manifest = Buffer.concat([state.manifest, buffer.subarray(offset, offset + length)]); callback(); return; }
      assert(length <= 256 * 1024);
      state.writes.push({ position, length });
      if (state.stall) return;
      setTimeout(() => {
        const partial = state.failAt === position;
        const bytes = partial ? Math.floor(length / 2) : length;
        assert.equal(position, state.remote.length);
        state.remote = Buffer.concat([state.remote, buffer.subarray(offset, offset + bytes)]);
        callback(partial ? new Error("Connection lost after a partial block") : null);
      }, state.delay);
    },
    close(_handle, callback) { callback(); }, end() {},
  };
  const client = { end() { state.ended++; }, sftp(callback) { callback(null, sftp); } };
  const deployment = { running: false, sites: () => [{ key: "gold", status: "ready" }],
    transfer: require("../lib/deployment").Deployment.prototype.transfer,
    connect: async () => client,
    execute: async (_client, command, _input, _timeout, _onPhase, onLog) => {
      state.commands.push(command);
      if (command.startsWith("df -Pk")) onLog("999999999");
      if (command.includes("find . -type f") && state.remote) onLog(`${state.remote.length}\tpayload.bin`);
      if (command.includes("sha256sum <")) onLog(crypto.createHash("sha256").update(command.includes("/manifest.json") ? state.manifest : state.remote).digest("hex") + "  -");
      if (command.includes("systemd-run")) {
        assert.deepEqual(state.remote, data);
        state.applied++; onLog("FEATHERAL_SYNC:health");
      }
    } };
  const service = new SiteSync({ root: f.root, settings, deployment });
  // Receiver upload is exercised end to end in site-sync-sftp.test.js; this fixture models one payload file.
  service.receiverBundle = () => ({ files: [], digest: "0".repeat(64) });
  return { ...f, data, archive, directory, target, binding, state, settings, deployment, service, sftp,
    plan: { directory, archive, binding } };
}
test("interrupted transfer resumes exact acknowledged and partial bytes after restart and completes without a new snapshot", async t => {
  const f = resumableFixture(t);
  f.state.failAt = 256 * 1024;
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.service.status().phase, "paused");
  assert.equal(f.service.status().resumable, true);
  const offset = f.state.remote.length;
  assert.equal(offset, 384 * 1024);
  assert(fs.existsSync(f.archive));
  assert.throws(() => f.service.available(), /waiting to continue/);
  assert.equal(f.state.applied, 0);
  f.service.result.phase = "transferring"; f.service.result.running = true; f.service.persist();
  const restarted = Object.assign(new SiteSync({ root: f.root, settings: f.settings, deployment: f.deployment }), { receiverBundle: f.service.receiverBundle });
  assert.equal(restarted.status().phase, "paused");
  f.settings.value.revision++; f.target.deploymentTimeoutSeconds = 2;
  f.state.failAt = null; f.state.writes = [];
  assert.equal(restarted.resume({ site: "gold" }).running, true);
  await restarted.transferTask;
  assert.equal(f.state.writes[0].position, offset);
  assert.equal(f.state.writes.reduce((sum, entry) => sum + entry.length, 0), f.data.length - offset);
  assert.deepEqual(f.state.remote, f.data);
  assert.equal(f.state.applied, 1); assert.equal(restarted.status().phase, "complete");
  assert.equal(restarted.status().progress.percent, 100);
  assert(!fs.existsSync(f.directory));
});
test("site setup failure pauses before snapshot uploads or target apply and can resume after deployment", async t => {
  const f = resumableFixture(t), execute = f.deployment.execute;
  f.deployment.execute = async (...args) => {
    if (args[1].includes("--check-sites")) {
      args[5]("Target deployment is missing assigned sites: pay.featheral.com. Deploy the current release.");
      throw new Error("Target site setup check failed");
    }
    return execute(...args);
  };
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.state.remote, null); assert.equal(f.state.manifest, null);
  assert.equal(f.state.applied, 0); assert.equal(f.state.writes.length, 0);
  assert.equal(f.service.status().phase, "paused");
  assert.match(f.service.status().message, /deploy the current release from Admin Settings/);
  assert.ok(f.service.status().logs.some(entry => entry.message.includes("missing assigned sites")));
  assert.ok(fs.existsSync(f.archive), "the reviewed snapshot is retained for retry");
  f.deployment.execute = execute;
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.service.status().phase, "complete"); assert.equal(f.state.applied, 1);
});
test("paused snapshots cannot resume against a changed assigned hostname set", async t => {
  const f = resumableFixture(t);
  f.state.failAt = 0;
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.service.status().phase, "paused");
  f.target.hosts.push("pay.featheral.com");
  assert.throws(() => f.service.resume({ site: "gold" }), /Site assignments changed/);
  assert.equal(f.state.applied, 0);
});
test("insufficient target space stops before opening any upload and preserves the frozen snapshot for recovery", async t => {
  const f = resumableFixture(t), execute = f.deployment.execute;
  f.deployment.execute = async (...args) => {
    if (args[1].startsWith("df -Pk")) args[5]("1");
    else await execute(...args);
  };
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.state.remote, null); assert.equal(f.state.writes.length, 0); assert.equal(f.state.applied, 0);
  assert.equal(f.service.status().phase, "paused");
  assert(fs.existsSync(f.archive));
  assert(f.service.status().logs.some(entry => entry.message.includes("Insufficient target disk space")));
});
test("a legacy paused ZIP can be replaced by a newly reviewed file snapshot without deleting old staging or running target commands", async t => {
  const f = resumableFixture(t);
  delete f.binding.transport;
  f.settings.environment = () => ({});
  f.service.result = { phase: "paused", id: f.binding.id, binding: f.binding, resumable: true, site: "gold", logs: [] };
  assert.throws(() => f.service.resume({ site: "gold" }), /previous paused transfer used a ZIP/);
  const review = await f.service.plan({ site: "gold" }, { session: "admin", origin: "https://admin.example" });
  assert.equal(review.transport, "files-v1");
  assert(fs.existsSync(f.directory));
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.service.plans.get(review.id).directory, "snapshot.zip")), false);
});
test("active upload outlives the timeout while acknowledged blocks keep resetting its stall timer", async t => {
  const f = resumableFixture(t);
  f.state.delay = 40; f.target.deploymentTimeoutSeconds = 0.15;
  const start = Date.now();
  f.service.launch(f.plan); await f.service.transferTask;
  assert(Date.now() - start > 150);
  assert.equal(f.service.status().phase, "complete");
  assert.equal(f.state.applied, 1); assert.deepEqual(f.state.remote, f.data);
});
test("stalled upload pauses promptly, retains the archive, and can resume to completion", async t => {
  const f = resumableFixture(t);
  f.state.stall = true; f.target.deploymentTimeoutSeconds = 0.05;
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.service.status().phase, "paused");
  assert(f.service.status().logs.some(entry => entry.message.includes("upload stalled")));
  assert(fs.existsSync(f.archive)); assert.equal(f.state.applied, 0);
  f.state.stall = false; f.target.deploymentTimeoutSeconds = 1;
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.service.status().phase, "complete"); assert.deepEqual(f.state.remote, f.data);
});
test("resume refuses changed targets, missing or changed archives, corrupt prefixes and unconfirmed apply jobs", async t => {
  const f = resumableFixture(t);
  f.state.failAt = 0; f.service.launch(f.plan); await f.service.transferTask;
  assert.throws(() => f.service.resume({ site: "other" }), /no paused upload/);
  f.target.host = "other.example.com";
  assert.throws(() => f.service.resume({ site: "gold" }), /original target connection/);
  f.target.host = f.binding.host;
  f.target.id = "gold";
  f.settings.value.siteServers = { gold: { useShared: false } };
  assert.throws(() => f.service.resume({ site: "gold" }), /original server assignment/);
  f.target.id = "shared";
  delete f.settings.value.siteServers;
  fs.renameSync(f.archive, f.archive + ".saved");
  assert.throws(() => f.service.resume({ site: "gold" }), /manifest is missing/);
  fs.renameSync(f.archive + ".saved", f.archive);
  f.state.writes = []; f.state.remote[0] ^= 1;
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.service.status().phase, "paused"); assert.equal(f.state.writes.length, 0);
  assert(f.service.status().logs.some(entry => entry.message.includes("prefix differs")));
  fs.writeFileSync(f.archive, Buffer.alloc(f.data.length));
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.state.writes.length, 0);
  assert(f.service.status().logs.some(entry => entry.message.includes("source manifest checksum changed")));
  f.service.result.phase = "applying"; f.service.result.running = true; f.service.result.resumable = false; f.service.persist();
  const restarted = Object.assign(new SiteSync({ root: f.root, settings: f.settings, deployment: f.deployment }), { receiverBundle: f.service.receiverBundle });
  assert.equal(restarted.status().phase, "uncertain");
  assert.throws(() => restarted.resume({ site: "gold" }), /Unconfirmed target jobs/);
  assert.equal(f.state.applied, 0);
});
test("a fully uploaded retained archive skips retransmission and proceeds to target verification", async t => {
  const f = resumableFixture(t);
  f.state.remote = Buffer.from(f.data);
  f.service.result = { phase: "paused", running: false, resumable: true, site: "gold", id: f.binding.id,
    binding: f.binding, logs: [] };
  f.service.persist();
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.applied, 1); assert.equal(f.service.status().phase, "complete");
});
test("resume refuses oversized, linked or unreadable target partial files without overwriting bytes", async t => {
  const f = resumableFixture(t);
  f.state.failAt = 0; f.service.launch(f.plan); await f.service.transferTask;
  f.state.writes = [];
  f.sftp.lstat = (_remote, callback) => callback(null, { size: f.data.length + 1, isFile: () => true });
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.service.status().phase, "paused"); assert.equal(f.state.writes.length, 0);
  f.sftp.lstat = (_remote, callback) => callback(null, { size: 0, isFile: () => false });
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.state.writes.length, 0);
  f.sftp.lstat = (_remote, callback) => callback(Object.assign(new Error("Permission denied"), { code: 3 }));
  f.service.resume({ site: "gold" }); await f.service.transferTask;
  assert.equal(f.state.writes.length, 0);
  assert(f.service.status().logs.some(entry => entry.message.includes("Permission denied")));
});
test("unconfirmed target apply retains the archive until a signed receipt check confirms completion", async t => {
  const f = resumableFixture(t), execute = f.deployment.execute;
  f.deployment.execute = async (...args) => {
    if (args[1].includes("systemd-run")) throw new Error("Target job connection lost");
    return execute(...args);
  };
  f.service.launch(f.plan); await f.service.transferTask;
  assert.equal(f.service.status().phase, "uncertain");
  assert.equal(f.service.status().resumable, false);
  assert(fs.existsSync(f.archive));
  let approvals = 0;
  f.settings.approvals = { consume() { approvals++; } };
  f.service.command = async () => JSON.stringify({ active: false, locked: false, online: true, phase: "complete" });
  await f.service.reconcile({ site: "gold" }, { session: "admin" });
  assert.equal(approvals, 1); assert.equal(f.service.status().phase, "complete");
  assert(!fs.existsSync(f.directory));
});
test("confirmed rollback completes its step without reporting a successful sync", async t => {
  const f = resumableFixture(t), execute = f.deployment.execute;
  let now = 1000;
  f.service.now = () => now;
  f.service.result = { logs: [], host: f.target.host, steps: [
    { id: "health", status: "pending", elapsedMs: 0, startedAt: null },
  ] };
  f.deployment.execute = async (...args) => {
    if (args[1].includes("systemd-run")) {
      const onLog = args[5];
      onLog("FEATHERAL_SYNC:health"); now += 30000;
      onLog("FEATHERAL_SYNC:rollback"); now += 264000;
      onLog("FEATHERAL_SYNC:rollback-complete");
      throw new Error("Target job exited with status 1");
    }
    return execute(...args);
  };
  f.service.launch(f.plan); await f.service.transferTask;
  let status = f.service.status();
  assert.equal(status.phase, "uncertain");
  assert.equal(status.steps.find(step => step.id === "health").status, "interrupted");
  const rollback = status.steps.find(step => step.id === "rollback");
  assert.equal(rollback.status, "complete"); assert.equal(rollback.percent, 100);
  assert.equal(rollback.elapsedSeconds, 264); assert.equal(rollback.remainingSeconds, 0);
  assert(fs.existsSync(f.archive));
  f.settings.approvals = { consume() {} };
  f.service.command = async () => JSON.stringify({ active: false, locked: false, online: true, phase: "rolled-back" });
  await f.service.reconcile({ site: "gold" }, {});
  status = f.service.status();
  assert.equal(status.phase, "rolled-back");
  assert.equal(status.steps.find(step => step.id === "rollback").elapsedSeconds, 264);
});
test("rollback receipt corrects an interrupted step from an older receiver without adding idle time", async t => {
  const f = resumableFixture(t);
  f.service.result = { phase: "uncertain", site: "gold", id: f.binding.id, binding: f.binding, logs: [],
    steps: [{ id: "rollback", status: "interrupted", elapsedMs: 264000, startedAt: null }] };
  f.settings.approvals = { consume() {} };
  f.service.command = async () => JSON.stringify({ active: false, locked: false, online: true, phase: "rolled-back" });
  await f.service.reconcile({ site: "gold" }, {});
  const rollback = f.service.status().steps[0];
  assert.equal(rollback.status, "complete"); assert.equal(rollback.elapsedSeconds, 264);
});
test("step timing reports measured upload ETA, freezes paused time and preserves historical estimates", async t => {
  const f = resumableFixture(t);
  let now = 1000;
  f.service.now = () => now;
  f.service.result = { host: f.target.host, phase: "preparing", logs: [],
    steps: [{ id: "capture", label: "Capture", status: "pending", startedAt: null, elapsedMs: 0, expectedSeconds: 20 },
      { id: "upload", label: "Upload", status: "pending", startedAt: null, elapsedMs: 0 }] };
  f.service.running = true;
  f.service.progress(2, "Capture");
  now += 5000;
  let step = f.service.status().steps[0];
  assert.equal(step.elapsedSeconds, 5); assert.equal(step.remainingSeconds, 15);
  assert.equal(step.percent, 25); assert.equal(step.estimate, "historical");
  now += 16000;
  step = f.service.status().steps[0];
  assert.equal(step.remainingSeconds, null); assert.equal(step.percent, null);
  f.service.progress(35, "Upload");
  assert.equal(f.service.status().steps[0].percent, 100);
  assert.equal(f.service.result.timings[f.target.host].capture, 21);
  f.service.result.uploadSample = { at: now, transferredBytes: 400, totalBytes: 1000, bytesPerSecond: 100 };
  step = f.service.status().steps[1];
  assert.equal(step.percent, 40); assert.equal(step.remainingSeconds, 6); assert.equal(step.estimate, "measured");
  now += 11000;
  assert.equal(f.service.status().steps[1].remainingSeconds, null);
  f.service.finish("paused", "Paused");
  const elapsed = f.service.status().steps[1].elapsedSeconds;
  now += 60000;
  assert.equal(f.service.status().steps[1].elapsedSeconds, elapsed);
  assert.equal(f.service.status().steps[1].remainingSeconds, null);
  const restored = Object.assign(new SiteSync({ root: f.root, settings: f.settings, deployment: f.deployment, now: () => now }), { receiverBundle: f.service.receiverBundle });
  assert.equal(restored.result.timings[f.target.host].capture, 21);
  assert.equal(restored.status().steps[1].status, "paused");
});
test("upload ETA samples only bytes sent during this resumed attempt", async t => {
  const f = resumableFixture(t);
  f.state.remote = Buffer.from(f.data.subarray(0, 512 * 1024));
  f.service.result = { host: f.target.host, logs: [],
    steps: [{ id: "upload", label: "Upload", status: "pending", elapsedMs: 0, startedAt: null }] };
  let now = 1000;
  f.service.now = () => now;
  const write = f.sftp.write;
  f.sftp.write = (...args) => { now += 1000; write(...args); };
  await f.service.upload({ end() {} }, f.sftp, { archive: path.join(f.directory, "snapshot", "payload.bin"),
    binding: { digest: require("node:crypto").createHash("sha256").update(f.data).digest("hex") } }, "payload.bin", f.target);
  assert.equal(f.service.result.uploadSample.transferredBytes, f.data.length);
  assert(f.service.result.uploadSample.bytesPerSecond <= 256 * 1024);
  assert.equal(f.service.status().steps[0].remainingSeconds, 0);
  assert.equal(f.service.status().steps[0].percent, 100);
});
test("per-step UI shows progress and ETA on compact text lines without individual bars", async () => {
  const f = await uiFixture({ initialStatus: { phase: "transferring", running: false, steps: [
    { id: "capture", label: "<Capture>", status: "complete", percent: 100, elapsedSeconds: 7, remainingSeconds: 0 },
    { id: "upload", label: "Upload", status: "running", percent: 40, elapsedSeconds: 80, remainingSeconds: 120, estimate: "measured" },
    { id: "backup", label: "Backup", status: "pending", percent: null, elapsedSeconds: 0, remainingSeconds: 65, estimate: "historical" },
    { id: "health", label: "Health", status: "pending", percent: null, elapsedSeconds: 0, remainingSeconds: null },
  ] } });
  const html = f.element("#site-sync-steps").innerHTML;
  assert.match(html, /40%/); assert.match(html, /remaining 2m 0s/);
  assert.match(html, /elapsed 1m 20s/); assert.match(html, /recent speed/);
  assert.match(html, /estimate from previous run/); assert.match(html, /remaining Estimating/);
  assert.equal((html.match(/<li>/g) || []).length, 4);
  assert(!html.includes("<progress"));
  assert(!html.includes("<div"));
  assert(!html.includes("\n"));
  f.context.viewCleanup();
});

test("reset clears verified target staging and every retained local snapshot without touching target data", async t => {
  const f = fixture(t);
  const target = { id: "shared", host: "shared.example.com", port: 22, directory: "/srv/featheral", fingerprint: "SHA256:shared", password: "ssh-secret" };
  const settings = { value: { revision: 1 }, environment: () => ({}), deploymentTargets: () => [{ ...target }] };
  let ended = 0, commands = [];
  const deployment = { running: false, sites: () => [{ key: "gold", status: "ready" }], connect: async () => ({ end() { ended++; } }) };
  const service = new SiteSync({ root: f.root, settings, deployment,
    command: async (_client, command) => { commands.push(command); return '{"removed":2,"removedBytes":96,"remaining":0}\n'; } });
  assert.throws(() => service.pause({ site: "gold" }), /Only an uploading transfer can be paused/);
  for (const id of ["956b8f51-ca5e-446d-a8a9-e7f188f56ecd", "0ae2ca02-0000-4000-8000-000000000000"])
    fs.mkdirSync(path.join(service.directory, id, "snapshot"), { recursive: true });
  service.result = { running: false, phase: "paused", site: "gold", resumable: true, logs: [], binding: { id: "956b8f51-ca5e-446d-a8a9-e7f188f56ecd" } };
  service.running = true;
  await assert.rejects(service.reset({ site: "gold" }), /Pause the current transfer/);
  service.running = false;
  const status = await service.reset({ site: "gold" });
  assert.equal(status.phase, "not-applied"); assert.equal(status.resumable, false); assert.equal(status.running, false);
  assert.match(status.message, /Removed 2 target staging folder\(s\) \(96 bytes\) and 2 local snapshot\(s\)/);
  assert.equal(commands.length, 1); assert.match(commands[0], /^node -e /); assert.match(commands[0], /\/srv\/featheral/);
  assert.equal(ended, 1);
  assert.deepEqual(fs.readdirSync(service.directory).filter(name => fs.statSync(path.join(service.directory, name)).isDirectory()), []);
  assert.ok(fs.existsSync(path.join(service.directory, "source-id")));
  assert.throws(() => service.resume({ site: "gold" }), /no paused upload/);
  service.command = async () => '{"removed":0,"removedBytes":0,"remaining":1}';
  await assert.rejects(service.reset({ site: "gold" }), /could not be verified/);
});
