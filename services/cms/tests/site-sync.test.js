"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { snapshot, hash, runtimePaths } = require("../../operations/site-sync-snapshot");
const { MARKER, readReplica, replicaEnvironment, allowReplicaRequest } = require("../../operations/replica");
const { prepareBackup, installSnapshot, restoreBackup, verifySnapshot } = require("../../../scripts/restore-site-sync");
const { SiteSync } = require("../lib/site-sync");
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
  fs.appendFileSync(path.join(backup, "cms", "site", "uploads", "photo.txt"), "tampered");
  assert.throws(() => restoreBackup(prepared.roots, backup, prepared.state), /Backup checksum/);
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
  assert(!JSON.stringify(review).includes("ssh-secret")); assert.equal(calls.length, 0);
  assert.throws(() => service.challenge({ plan: review.id }, { ...context, session: "other" }), /another session/);
  service.challenge({ plan: review.id }, context);
  assert.equal(calls[0][1].digest, review.digest); assert.match(calls[0][3], /ALL installation/);
  settings.value.revision++;
  assert.throws(() => service.start({ plan: review.id, signature: "signed" }, context), /Settings changed/);
  settings.value.revision--;
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
  const client = { end() { ended = true; }, sftp(callback) { callback(null, { fastPut(file, remote, callback) { transfers.push({ file, remote }); callback(); }, end() {} }); } };
  const deployment = { running: false, sites: () => [{ key: "gold", hostname: "gold.featheral.com" }],
    async connect(config) { assert.equal(config.password, target.password); assert.equal(config.fingerprint, target.fingerprint); return client; },
    async execute(_client, command, input) { commands.push({ command, input }); },
    transfer: (_client, operation) => new Promise((resolve, reject) => operation((error, result) => error ? reject(error) : resolve(result))) };
  const service = new SiteSync({ root: f.root, settings, deployment });
  const context = { session: "admin", origin: "https://admin.example" };
  const review = await service.plan({ site: "gold" }, context);
  assert.equal(commands.length, 0); assert.equal(transfers.length, 0);
  const result = service.start({ plan: review.id, signature: "signed" }, context);
  assert.equal(result.running, true); assert.equal(consumed, 1);
  for (let attempt = 0; attempt < 20 && service.running; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().phase, "complete"); assert(ended);
  assert.equal(transfers.length, 1);
  assert(!commands.some(item => item.command.includes("ssh-secret")));
  assert.equal(commands[1].input, "ssh-secret\n");
  assert.match(commands[1].command, /sha256sum --check/); assert.match(commands[1].command, /systemd-run/);
  assert.match(commands[1].command, /restore-site-sync/);
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
    deploymentTargets: () => [{ id: "shared", host: "shared.example.com", port: 22, directory: "/srv/featheral", fingerprint: "SHA256:shared" }] };
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
test("Settings sync API requires the Admin host, authentication, same origin and a managed site", async t => {
  const express = require("express"), http = require("node:http"), { once } = require("node:events");
  const calls = [];
  const service = { status: () => ({ phase: "idle", running: false }),
    plan: async (input, context) => { calls.push({ input, context }); return { id: "snapshot" }; },
    startShared: async (input, context) => { calls.push({ input, context }); return { phase: "transferring", running: true }; } };
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
  let signs = 0, failure, status = initialStatus;
  const context = vm.createContext({
    VIEWS: {}, state: { seq: 1 }, location: { hash: "#/site-server/gold" }, viewCleanup: null, leaveView: null,
    AbortController, setTimeout, clearTimeout, esc: value => String(value), $: element, renderSidebar() {}, setCrumbs() {}, setView() {}, toast() {},
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
      if (url.endsWith("/start")) {
        if (failure) throw failure;
        status = { running: false, phase: "complete", message: "confirmed" }; return status;
      }
      throw new Error("Unexpected UI request: " + url);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/settings.js"), "utf8"), context);
  await context.VIEWS["site-server"]("gold", {}, 1);
  return { calls, element, context, form, get signs() { return signs; }, fail(error) { failure = error; },
    click: selector => element(selector).listeners.click() };
}
test("site Settings waits for review, explicit confirmation and wallet approval before syncing", async () => {
  const f = await uiFixture();
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
