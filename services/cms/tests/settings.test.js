"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Wallet } = require("ethers");
const { OriginApprovals } = require("../../database/approvals");
const { OperationsSettings, parseCredential } = require("../../operations/settings");
const { Deployment } = require("../lib/deployment");
const { settingsApi } = require("../../operations/api");
const { requestPolicy, configureServer } = require("../../operations/http");
const express = require("express");
const http = require("node:http");
const { EventEmitter, once } = require("node:events");
const { initialize, initializeNewInstallation, migrateEnvironment } = require("../../../scripts/init-settings");
const context = { origin: "http://admin.localhost", session: "fixture-admin" };
const password = "fixture-server-password:with:colons";
const adminPassword = "fixture-admin-password-long";
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repository"), keyFile = path.join(directory, "key"), bootstrapFile = path.join(directory, "bootstrap.json");
  fs.mkdirSync(root);
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  fs.writeFileSync(bootstrapFile, JSON.stringify({ keyFile }), { mode: 0o600 });
  const wallet = Wallet.createRandom(), verified = [], clock = { now: Date.now() };
  const approvals = new OriginApprovals({ wallet: wallet.address, now: () => clock.now });
  const settings = new OperationsSettings({ root, bootstrapFile, approvals,
    verifyCredential: async config => { verified.push({ ...config }); if (options.failVerification) throw Object.assign(new Error("SSH verification failed"), { status: 502 }); } });
  const input = { revision: 0, settings: { host: "server.example", fingerprint: "SHA256:" + "a".repeat(43), credential: `deploy:${password}`, adminPassword, tlsEmail: "ops@example.com" } };
  const sign = async (input, ctx = context) => {
    const challenge = settings.challenge(input, ctx);
    return { ...input, challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) };
  };
  const save = async input => settings.save(await sign(input), context);
  return { settings, root, keyFile, bootstrapFile, directory, wallet, clock, input, sign, save, verified };
}
test("new installation initializes encrypted empty Settings without copying credentials or replacing any data", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-first-install-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "release"), file = path.join(directory, "shared", "bootstrap", "bootstrap.json");
  fs.mkdirSync(path.join(repository, "data"), { recursive: true });
  fs.mkdirSync(path.join(repository, "services", "cms", "data"), { recursive: true });
  const settings = initializeNewInstallation(repository, file, { uploadLimitMiB: 32, requestTimeoutSeconds: 120 });
  assert.equal(settings.value.revision, 1);
  assert.equal(settings.value.credential, null);
  assert.equal(settings.value.enabled, false);
  assert.equal(settings.value.uploadLimitMiB, 32);
  assert.equal(settings.environment().GOLD_RESERVE_MODE, "disabled");
  assert.equal(settings.environment().FTH_LEDGER_MODE, "unconfigured");
  assert.equal(settings.environment().WORLD_LEDGER_MODE, "unconfigured");
  assert.equal(JSON.parse(settings.environment().ADMIN_CONFIG_JSON).siteManagement, true);
  const key = fs.readFileSync(path.join(path.dirname(file), "operations.key"), "utf8");
  const envelope = JSON.stringify(settings.database.settings());
  assert.throws(() => initializeNewInstallation(repository, file), /empty private data/);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), "operations.key"), "utf8"), key);
  assert.equal(JSON.stringify(settings.database.settings()), envelope);
  assert.deepEqual(new OperationsSettings({ root: repository, bootstrapFile: file }).value, settings.value);
});
test("new installation refuses existing CMS content before writing a bootstrap", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-first-install-refusal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "release"), file = path.join(directory, "bootstrap.json");
  fs.mkdirSync(path.join(repository, "data"), { recursive: true });
  const cms = path.join(repository, "services", "cms", "data");
  fs.mkdirSync(cms, { recursive: true });
  fs.writeFileSync(path.join(cms, "existing.txt"), "preserve");
  assert.throws(() => initializeNewInstallation(repository, file), /empty private data/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(cms, "existing.txt"), "utf8"), "preserve");
});
test("automatic installation is wallet-bound and separate DB deploys before the shared server", async t => {
  const f = fixture(t);
  await f.save({ ...f.input, settings: { ...f.input.settings, enabled: true } });
  const site = "db.featheral.com";
  const siteInput = { revision: 1, settings: { useShared: false, url: "https://db.featheral.com/", host: "db.example",
    port: 22, fingerprint: "SHA256:" + "b".repeat(43), credential: "root:db-fixture-password" } };
  const siteProof = f.settings.siteChallenge(site, siteInput, context, site);
  await f.settings.saveSite(site, { ...siteInput, challengeId: siteProof.challengeId, signature: await f.wallet.signMessage(siteProof.message) }, context, site);
  const deployment = new Deployment({ root: path.resolve(__dirname, "../../.."), settings: f.settings,
    stateDirectory: path.join(f.directory, "deploy"), hostnames: () => ["featheral.com", "admin.featheral.com", site] });
  assert.throws(() => deployment.plan({ initialize: "true" }), { status: 400 });
  const plan = deployment.plan();
  assert.equal(plan.initialize, undefined);
  assert.ok(plan.steps.some(step => step.includes("Automatically reuse")));
  const normalApproval = `DEPLOY ${plan.digest} ${plan.contentDigest}`;
  const input = { planId: plan.id, approval: normalApproval };
  const challenge = deployment.approvalChallenge(input, context);
  assert.match(challenge.message, /Automatically detect installation/);
  assert.match(challenge.message, /Stream redacted server output/);
  const modes = [];
  deployment.deployTarget = async (target, ...args) => { modes.push({ id: target.id, arguments: args.length }); };
  deployment.launch({ ...input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) }, context);
  while (deployment.running) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(modes, [{ id: site, arguments: 4 }, { id: "shared", arguments: 4 }]);
  assert.equal(deployment.result.success, true);
});
test("automatic managed-site review binds published content and rejects retired manual installation controls", async t => {
  const f = fixture(t);
  await f.save({ ...f.input, settings: { ...f.input.settings, enabled: true } });
  const source = { integrated: [], managed: [{ key: "legacy-site", hostname: "x.featheral.com",
    theme: "editorial", settings: {}, owner: "private-owner", rewards: { enabled: true },
    pages: [{ id: 100, type: "page", title: "Public", slug: "home", body: "<p>Public</p>", excerpt: "", updatedAt: "private-history" }] }] };
  const deployment = new Deployment({ root: path.resolve(__dirname, "../../.."), settings: f.settings,
    snapshot: () => source, stateDirectory: path.join(f.directory, "deploy") });
  assert.throws(() => deployment.plan({ freshManagedSites: "yes" }), { status: 400 });
  assert.throws(() => deployment.plan({ freshManagedSites: true }), { status: 400 });
  const plan = deployment.plan();
  const stored = deployment.plans.get(plan.id);
  assert.equal(stored.content, JSON.stringify(source));
  const normal = `DEPLOY ${plan.digest} ${plan.contentDigest}`;
  const input = { planId: plan.id, approval: normal };
  const challenge = deployment.approvalChallenge(input, context);
  assert.match(challenge.message, /create published-only sites/);
  let received;
  deployment.deployTarget = async (_target, _credential, _archive, _bootstrap, _release, initialize, fresh) => { received = { initialize, fresh }; };
  deployment.launch({ ...input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) }, context);
  while (deployment.running) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received, { initialize: undefined, fresh: undefined });
  assert.equal(deployment.result.success, true);
});
test("a fresh encrypted installation boots the gateway and wallet-only Admin without a copied backup", { timeout: 30000 }, async t => {
  const { spawn } = require("node:child_process");
  const source = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-fresh-boot-"));
  const repository = path.join(directory, "release"), file = path.join(directory, "bootstrap", "bootstrap.json");
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const releaseFiles = [...new Set([...require("../lib/deployment").releaseFiles(source),
    "services/operations/replica.js", "services/operations/site-sync-snapshot.js", "services/cms/lib/site-sync.js",
    "scripts/restore-site-sync.js", "shared/gold-pricing.js"])];
  for (const relative of releaseFiles) {
    const target = path.join(repository, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
  fs.symlinkSync(path.join(source, "node_modules"), path.join(repository, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const sharedData = path.join(directory, "shared", "data"), sharedCms = path.join(directory, "shared", "cms-data");
  fs.mkdirSync(sharedData, { recursive: true });
  fs.mkdirSync(sharedCms, { recursive: true });
  fs.symlinkSync(sharedData, path.join(repository, "data"), process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(sharedCms, path.join(repository, "services", "cms", "data"), process.platform === "win32" ? "junction" : "dir");
  const settings = initializeNewInstallation(repository, file);
  const { SiteManager } = require("../lib/sites");
  const managed = new SiteManager({ dataDir: fs.realpathSync(sharedCms), cmsHost: "admin.featheral.com" })
    .create({ hostname: "x.featheral.com", template: false, name: "Published X" });
  const CmsStore = require("../lib/cms"), cms = new CmsStore(path.join(sharedCms, managed.key, "cms.sqlite"));
  cms.save({ type: "page", status: "publish", slug: "home", title: "Imported homepage", body: "<p>Preserved shared site content</p>" });
  cms.setSiteSettings({ ...cms.siteSettings(), homepage: "content", homeSlug: "home" });
  cms.close();
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  settings.persist({ ...settings.value, revision: 2, runtime: { ...settings.value.runtime, PORT: String(port) } });
  child = spawn(process.execPath, [path.join(repository, "scripts", "serve.js")],
    { cwd: repository, env: { ...process.env, FEATHERAL_BOOTSTRAP_FILE: file }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const request = (pathname, host, forwardedProtocol = "https") => new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, headers: { Host: host, "X-Forwarded-Proto": forwardedProtocol } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail("Fresh gateway failed to start: " + output);
    try { health = await request("/healthz", "featheral.com"); if (health.status === 200) break; }
    catch (error) { if (error.code !== "ECONNREFUSED") throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, output);
  const admin = await request("/", "admin.featheral.com");
  assert.equal(admin.status, 200);
  assert.match(admin.body, /wallet/i);
  const insecureAdmin = await request("/", "admin.featheral.com", "http");
  assert.equal(insecureAdmin.status, 403);
  assert.match(insecureAdmin.body, /HTTPS/);
  const privateApi = await request("/api/settings", "admin.featheral.com");
  assert.equal(privateApi.status, 401);
  const publicSite = await request("/", "x.featheral.com");
  assert.equal(publicSite.status, 200);
  const importedPage = await request("/api/public/texts/by-slug/home", "x.featheral.com");
  assert.equal(importedPage.status, 200);
  assert.match(importedPage.body, /Preserved shared site content/);
  const sourceExit = once(child, "exit"); child.kill(); await sourceExit;
  const replica = path.join(directory, "replica"), replicaBootstrap = path.join(directory, "replica-bootstrap", "bootstrap.json");
  for (const relative of releaseFiles) {
    const target = path.join(replica, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
  fs.symlinkSync(path.join(source, "node_modules"), path.join(replica, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.mkdirSync(path.join(replica, "services", "cms", "data"), { recursive: true });
  fs.mkdirSync(path.join(replica, "data"), { recursive: true });
  const replicaSettings = initializeNewInstallation(replica, replicaBootstrap);
  replicaSettings.persist({ ...replicaSettings.value, revision: 2, runtime: { ...replicaSettings.value.runtime, PORT: String(port) } });
  const snapshotDirectory = path.join(directory, "snapshot");
  require("../../operations/site-sync-snapshot").snapshot(repository, snapshotDirectory, settings.environment());
  require("../../../scripts/restore-site-sync").installSnapshot(replica, snapshotDirectory, path.join(directory, "replica-backup"));
  const replicaProfile = path.join(replica, "data", "wallet-profiles.sqlite");
  const originalProfileHash = require("../../operations/site-sync-snapshot").hash(replicaProfile);
  output = "";
  child = spawn(process.execPath, [path.join(replica, "scripts", "serve.js")],
    { cwd: replica, env: { ...process.env, FEATHERAL_BOOTSTRAP_FILE: replicaBootstrap }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  health = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail("Read-only replica failed to start: " + output);
    try { health = await request("/healthz", "featheral.com"); if (health.status === 200) break; }
    catch (error) { if (error.code !== "ECONNREFUSED") throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, output);
  const replicaPage = await request("/api/public/texts/by-slug/home", "x.featheral.com");
  assert.equal(replicaPage.status, 200, replicaPage.body);
  assert.match(replicaPage.body, /Preserved shared site content/);
  const writeResult = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "POST", headers: { Host: "admin.localhost" } });
  assert.equal(writeResult.status, 403);
  assert.match(await writeResult.text(), /read-only/);
  assert.equal(require("../../operations/site-sync-snapshot").hash(replicaProfile), originalProfileHash);
});
test("credential syntax supports username:password, root fallback and colon-containing passwords", () => {
  assert.deepEqual(parseCredential("secret"), { username: "root", password: "secret" });
  assert.deepEqual(parseCredential(":secret"), { username: "root", password: "secret" });
  assert.deepEqual(parseCredential("deploy:a:b"), { username: "deploy", password: "a:b" });
  for (const value of ["", "root:", "user;id:secret", "root:bad\npassword"]) assert.throws(() => parseCredential(value), { status: 400 });
});
test("settings verify SSH, encrypt credentials, hash Admin access and survive restart without revealing secrets", async t => {
  const f = fixture(t);
  const result = await f.save(f.input);
  assert.equal(result.revision, 1); assert.equal(result.username, "deploy");
  assert.equal(result.adminConfigured, true); assert.equal(f.verified[0].password, password);
  const file = JSON.stringify(f.settings.database.settings());
  assert.equal(fs.existsSync(f.settings.file), false);
  for (const secret of [password, adminPassword, f.settings.value.adminHash]) {
    assert.ok(!file.includes(secret)); assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(f.settings.configuration()).includes(secret));
  }
  const restored = new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile });
  assert.equal(restored.authenticate(adminPassword), true);
  assert.equal(restored.authenticate("wrong-password"), false);
  assert.equal(restored.value.credential.password, password);
  assert.equal(restored.value.uploadLimitMiB, 16);
  assert.equal(restored.value.enabled, false);
  assert.equal(restored.authenticate("x".repeat(2000)), false);
});
test("settings approvals bind exact values, revision, origin, session and origin wallet, and cannot be replayed", async t => {
  const f = fixture(t);
  for (const scenario of ["credential", "settings", "origin", "session", "wrong-wallet", "expired"]) {
    const signed = await f.sign(f.input), ctx = { ...context };
    if (scenario === "credential") signed.settings = { ...signed.settings, credential: "deploy:changed" };
    if (scenario === "settings") signed.settings = { ...signed.settings, uploadLimitMiB: 32 };
    if (scenario === "origin") ctx.origin = "https://evil.example";
    if (scenario === "session") ctx.session = "other";
    if (scenario === "wrong-wallet") signed.signature = await Wallet.createRandom().signMessage("other");
    if (scenario === "expired") f.clock.now += 300001;
    await assert.rejects(f.settings.save(signed, ctx), { status: 403 }, scenario);
  }
  assert.equal(f.verified.length, 0);
  const signed = await f.sign(f.input);
  await f.settings.save(signed, context);
  await assert.rejects(f.settings.save(signed, context), { status: 409 });
  const binding = { operation: "fixture" }, challenge = f.settings.challengeUse("TEST SSH", binding, context);
  const proof = { challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) };
  assert.equal(f.settings.use("TEST SSH", binding, context, proof).password, password);
  assert.throws(() => f.settings.use("TEST SSH", binding, context, proof), { status: 403 });
});
test("credential verification failures do not persist or overwrite settings", async t => {
  const f = fixture(t, { failVerification: true });
  await assert.rejects(f.save(f.input), { status: 502 });
  assert.equal(f.settings.value.revision, 0); assert.equal(fs.existsSync(f.settings.file), false);
});
test("wallet-authorized settings need no Admin password or fingerprint and pin each SSH target only after successful verification", async t => {
  const f = fixture(t), key = Buffer.from("first-server-key");
  let actualKey = key, rejectLogin = false;
  const deployment = new Deployment({ root: f.root, clientFactory: () => {
    const client = new EventEmitter();
    client.connect = config => {
      const trusted = config.hostVerifier(actualKey);
      process.nextTick(() => trusted && !rejectLogin ? client.emit("ready") : client.emit("error", new Error("SSH authentication or host key rejected")));
    };
    client.end = () => {};
    return client;
  } });
  f.settings.verifyCredential = async config => {
    const client = await deployment.connect(config); client.end(); return config.fingerprint;
  };
  const settings = { host: "server.example", credential: password, enabled: true, tlsEmail: "ops@example.com" };
  rejectLogin = true;
  await assert.rejects(f.save({ revision: 0, settings }), /SSH/);
  assert.equal(f.settings.value.revision, 0); assert.equal(f.settings.value.fingerprint, "");
  rejectLogin = false;
  await f.save({ revision: 0, settings });
  const pinned = "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  assert.equal(f.settings.value.fingerprint, pinned);
  assert.equal(f.settings.value.adminHash, null);
  assert.equal(new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile }).value.fingerprint, pinned);
  actualKey = Buffer.from("unexpected-key-change");
  await assert.rejects(f.save({ revision: 1, settings: { credential: password } }), /SSH/);
  assert.equal(f.settings.value.fingerprint, pinned); assert.equal(f.settings.value.revision, 1);
  const site = "db.featheral.com", input = { revision: 1, settings: { useShared: false,
    url: "https://db.example/", host: "db.example", port: 22, credential: "root:different-password" } };
  const proof = f.settings.siteChallenge(site, input, context, site);
  await f.settings.saveSite(site, { ...input, challengeId: proof.challengeId, signature: await f.wallet.signMessage(proof.message) }, context, site);
  assert.notEqual(f.settings.value.siteServers[site].fingerprint, pinned);
  assert.equal(f.settings.value.fingerprint, pinned);
  actualKey = Buffer.from("new-target-key");
  await f.save({ revision: 2, settings: { host: "new-server.example", credential: password } });
  assert.notEqual(f.settings.value.fingerprint, pinned);
  const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/settings.js"), "utf8");
  assert.doesNotMatch(source, /name="(?:adminPassword|fingerprint)"/);
});
test("per-site server profiles verify independent credentials, stay encrypted and never change shared deployment", async t => {
  const f = fixture(t); await f.save(f.input);
  const site = "db.featheral.com", sitePassword = "fixture-database-ssh-password";
  const initial = f.settings.siteStatus(site, site);
  assert.equal(initial.useShared, true); assert.equal(initial.sharedHost, "server.example");
  assert.equal(initial.enrolled, false);
  const input = { revision: 1, settings: { useShared: false, url: "https://database.example/db/",
    host: "database.example", port: 2222, fingerprint: "SHA256:" + "b".repeat(43), credential: `database:${sitePassword}` } };
  const challenge = f.settings.siteChallenge(site, input, context, site);
  const result = await f.settings.saveSite(site, { ...input, challengeId: challenge.challengeId,
    signature: await f.wallet.signMessage(challenge.message) }, context, site);
  assert.equal(result.revision, 2); assert.equal(result.enrolled, true); assert.equal(result.username, "database");
  assert.equal(f.verified[1].host, "database.example"); assert.equal(f.verified[1].port, 2222);
  assert.equal(f.verified[1].password, sitePassword);
  assert.equal(f.settings.configuration().host, "server.example");
  assert.equal(f.settings.value.credential.password, password);
  assert.equal(f.settings.siteStatus("app.featheral.com", "app.featheral.com").useShared, true);
  for (const publicValue of [result, f.settings.status(), f.settings.database.settings()]) {
    assert.ok(!JSON.stringify(publicValue).includes(sitePassword));
    assert.ok(!JSON.stringify(publicValue).includes(password));
  }
  const restored = new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile });
  assert.equal(restored.value.siteServers[site].credential.password, sitePassword);
  assert.equal(restored.siteStatus(site, site).url, input.settings.url);
  assert.throws(() => f.settings.prepareSite(site, { revision: 2, settings: { host: "changed.example" } }, site), { status: 400 });
  const retainedInput = { revision: 2, settings: { url: "https://database.example/updated/" } };
  const retainedChallenge = f.settings.siteChallenge(site, retainedInput, context, site);
  await f.settings.saveSite(site, { ...retainedInput, challengeId: retainedChallenge.challengeId,
    signature: await f.wallet.signMessage(retainedChallenge.message) }, context, site);
  assert.equal(f.settings.value.siteServers[site].credential.password, sitePassword);
  assert.equal(f.verified.length, 2);
  const sharedInput = { revision: 3, settings: { useShared: true } };
  const sharedChallenge = f.settings.siteChallenge(site, sharedInput, context, site);
  await f.settings.saveSite(site, { ...sharedInput, challengeId: sharedChallenge.challengeId,
    signature: await f.wallet.signMessage(sharedChallenge.message) }, context, site);
  assert.equal(f.settings.siteStatus(site, site).useShared, true);
  assert.equal(f.settings.value.siteServers[site].credential.password, sitePassword);
  assert.equal(f.verified.length, 2);
  const reenableInput = { revision: 4, settings: { useShared: false } };
  const reenableChallenge = f.settings.siteChallenge(site, reenableInput, context, site);
  await f.settings.saveSite(site, { ...reenableInput, challengeId: reenableChallenge.challengeId,
    signature: await f.wallet.signMessage(reenableChallenge.message) }, context, site);
  assert.equal(f.verified.length, 3);
});
test("compact settings controls use readable labels and submit only changed values without clearing saved secrets", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/settings.js"), "utf8");
  const { fields, settingsControls } = require("../../operations/configuration");
  assert.ok(settingsControls.length < fields.length / 2);
  assert.ok(settingsControls.every(field => field.label && field.type));
  assert.equal(new Set(settingsControls.map(field => field.name)).size, settingsControls.length);
  const context = vm.createContext({ esc: String });
  vm.runInContext(source.slice(0, source.indexOf("VIEWS.settings")), context);
  const controls = [
    { name: "APP_TURN_SECRET", label: "Call server secret", type: "text", secret: true, configured: true, value: "" },
    { name: "APP_ICE_URLS", label: "Call STUN / TURN servers", type: "ice", configured: true, value: "stun:example.com" },
  ];
  const html = context.settingsControlsHtml(controls);
  assert.match(html, /Call server secret/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, />APP_TURN_SECRET</);
  const form = { elements: { "runtime-APP_TURN_SECRET": { value: "" }, "runtime-APP_ICE_URLS": { value: "stun:example.com" } } };
  assert.deepEqual(Object.keys(context.changedServiceSettings(form, controls)), []);
  form.elements["runtime-APP_ICE_URLS"].value = "stun:changed.example";
  assert.equal(context.changedServiceSettings(form, controls).APP_ICE_URLS, "stun:changed.example");
  assert.equal(Object.hasOwn(context.changedServiceSettings(form, controls), "APP_TURN_SECRET"), false);
  form.elements["clear-APP_TURN_SECRET"] = { checked: true };
  assert.equal(context.changedServiceSettings(form, controls).APP_TURN_SECRET, null);
});
test("site saves are bound to site, revision and exact settings, with failed SSH verification leaving state intact", async t => {
  const f = fixture(t); await f.save(f.input);
  const site = "db.featheral.com";
  const input = { revision: 1, settings: { useShared: false, url: "https://db.example/", host: "db.example",
    port: 22, fingerprint: "SHA256:" + "b".repeat(43), credential: "db:site-secret" } };
  const challenge = f.settings.siteChallenge(site, input, context, site);
  const signed = { ...input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) };
  await assert.rejects(f.settings.saveSite("app.featheral.com", signed, context, "app.featheral.com"), { status: 403 });
  await assert.rejects(f.settings.saveSite(site, { ...signed, settings: { ...input.settings, host: "other.example" } }, context, site), { status: 403 });
  const failingChallenge = f.settings.siteChallenge(site, input, context, site);
  f.settings.verifyCredential = async () => { throw Object.assign(new Error("SSH verification failed"), { status: 502 }); };
  await assert.rejects(f.settings.saveSite(site, { ...input, challengeId: failingChallenge.challengeId,
    signature: await f.wallet.signMessage(failingChallenge.message) }, context, site), { status: 502 });
  assert.equal(f.settings.value.revision, 1); assert.equal(f.settings.siteStatus(site, site).useShared, true);
});
test("site server validation and compact controls preserve low-level runtime values and isolate service changes", async t => {
  const f = fixture(t);
  await f.save({ ...f.input, settings: { ...f.input.settings, runtime: { FTH_LEDGER_MODE: "reader", APP_TURN_SECRET: "existing-turn" },
    runtimeConfirmation: "APPLY RUNTIME SETTINGS" } });
  f.settings.markStarted();
  const site = "db.featheral.com";
  for (const settings of [
    { useShared: false }, { port: 0 }, { fingerprint: "unknown" }, { host: "host;id" }, { useShared: "false" },
    { url: "http://public.example/" }, { url: "https://user:password@db.example/" }, { url: "file:///private" },
    { url: "https://db.example/?token=secret" }, { url: "https://db.example/#key" }, { url: "https://db.example/\n" },
    { enabled: true }, { runtime: { APP_TURN_SECRET: "cross-site" }, runtimeConfirmation: "APPLY RUNTIME SETTINGS" },
    { runtime: { DB_LEDGER_DIR: "/new/path" } },
  ]) assert.throws(() => f.settings.prepareSite(site, { revision: 1, settings }, site), { status: 400 });
  assert.throws(() => f.settings.prepareSite(site, { revision: 0, settings: {} }, site), { status: 409 });
  const input = { revision: 1, settings: { runtime: { DB_LEDGER_DIR: "/verified/db" }, runtimeConfirmation: "APPLY RUNTIME SETTINGS" } };
  const challenge = f.settings.siteChallenge(site, input, context, site);
  const result = await f.settings.saveSite(site, { ...input, challengeId: challenge.challengeId,
    signature: await f.wallet.signMessage(challenge.message) }, context, site);
  assert.equal(result.restartRequired, true);
  assert.equal(f.settings.environment().DB_LEDGER_DIR, "/verified/db");
  assert.equal(f.settings.environment().APP_TURN_SECRET, "existing-turn");
  assert.equal(f.settings.environment().FTH_LEDGER_MODE, "reader");
  assert.deepEqual(f.settings.status().controls.map(field => field.name), ["HOST", "PORT", "FEATHERAL_ADMIN_WALLETS"]);
  assert.equal(result.controls.length, 2);
  assert.ok(result.controls.every(field => field.site === site && field.label && !field.label.includes("DB_")));
  const app = f.settings.siteStatus("app.featheral.com", "app.featheral.com");
  assert.equal(app.controls.find(field => field.name === "APP_TURN_SECRET").value, "");
  assert.equal(app.controls.find(field => field.name === "APP_TURN_SECRET").configured, true);
});
test("settings enforce bounded limits, target reenrollment and operation locking", async t => {
  const f = fixture(t);
  for (const settings of [{ port: 0 }, { uploadLimitMiB: 1025 }, { requestTimeoutSeconds: 4 }, { sshTimeoutSeconds: 121 },
    { deploymentTimeoutSeconds: 59 }, { networkLimitBytesPerSecond: -1 }, { enabled: "true" }, { host: "x;id" },
    { directory: "/opt/../etc" }, { fingerprint: "untrusted" }, { tlsEmail: "bad" }, { arbitrarySecret: "unsupported" }]) {
    assert.throws(() => f.settings.prepare({ ...f.input, settings: { ...f.input.settings, ...settings } }), { status: 400 });
  }
  await f.save(f.input);
  assert.throws(() => f.settings.prepare({ revision: 1, settings: { host: "other.example" } }), { status: 400 });
  await f.save({ revision: 1, settings: { uploadLimitMiB: 32, requestTimeoutSeconds: 120 } });
  assert.equal(f.settings.value.credential.password, password);
  assert.equal(f.settings.value.uploadLimitMiB, 32);
  assert.equal(f.verified.length, 1);
  f.settings.isBusy = () => true;
  assert.throws(() => f.settings.challenge({ revision: 2, settings: {} }, context), { status: 409 });
});
test("settings changes invalidate approved credential use and reviewed deployment plans", async t => {
  const f = fixture(t); await f.save({ ...f.input, settings: { ...f.input.settings, enabled: true } });
  const deployment = new Deployment({ root: path.resolve(__dirname, "..", "..", ".."), settings: f.settings, stateDirectory: path.join(f.directory, "deploy") });
  deployment.vault = f.settings;
  const plan = deployment.plan(), input = { planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` };
  assert.equal(plan.enabled, true); assert.equal(plan.walletApprovalRequired, true);
  assert.throws(() => deployment.launch(input, context), { status: 403 });
  const challenge = f.settings.challengeUse("TEST SSH", {}, context);
  const signed = { challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) };
  await f.save({ revision: 1, settings: { uploadLimitMiB: 24 } });
  assert.throws(() => f.settings.use("TEST SSH", {}, context, signed), { status: 403 });
  assert.throws(() => deployment.validate(input), { status: 409 });
});
test("bootstrap refuses in-repository keys and corrupted encrypted settings fail closed", async t => {
  const f = fixture(t); await f.save(f.input);
  fs.writeFileSync(f.keyFile, crypto.randomBytes(32).toString("hex"));
  assert.throws(() => new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile }), { status: 503 });
  const keyFile = path.join(f.root, "key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  fs.writeFileSync(f.bootstrapFile, JSON.stringify({ keyFile }));
  assert.throws(() => f.settings.key(), { status: 503 });
});

test("encrypted Settings support the deployment's shared-data directory link", async t => {
  const f = fixture(t), shared = path.join(f.directory, "shared-data");
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, path.join(f.root, "data"), process.platform === "win32" ? "junction" : "dir");
  await f.save(f.input);
  const restored = new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile });
  assert.equal(restored.authenticate(adminPassword), true);
  assert.equal(restored.value.credential.password, password);
});
test("offline migration imports runtime and financial configuration into the database and removes the environment file", t => {
  const f = fixture(t), envFile = path.join(f.directory, "legacy.env");
  fs.writeFileSync(envFile, `CMS_PASSWORD=${adminPassword}\nDEPLOY_TARGET=deploy@server.example:/opt/featheral\nDEPLOY_PASSWORD=${password}\nDEPLOY_HOST_KEY_SHA256=SHA256:${"a".repeat(43)}\nDEPLOY_TLS_EMAIL=ops@example.com\nDEPLOY_ENABLED=true\nFTH_LEDGER_MODE=writer\nAPP_TURN_SECRET=preserved-fixture\n`, { mode: 0o600 });
  migrateEnvironment(f.settings, envFile);
  assert.equal(f.settings.authenticate(adminPassword), true);
  assert.equal(f.settings.value.credential.password, password);
  assert.equal(f.settings.value.enabled, false);
  assert.equal(fs.existsSync(envFile), false);
  assert.equal(f.settings.environment().FTH_LEDGER_MODE, "writer");
  assert.equal(f.settings.environment().APP_TURN_SECRET, "preserved-fixture");
  assert.ok(!JSON.stringify(f.settings.database.settings()).includes("preserved-fixture"));
  const newBootstrap = path.join(f.directory, "new", "bootstrap.json");
  const repository = path.join(f.directory, "fresh-repository");
  fs.mkdirSync(repository);
  const initialized = initialize(newBootstrap, { repository }), originalKey = initialized.key().toString("hex");
  assert.equal(initialize(newBootstrap, { repository }).key().toString("hex"), originalKey);
});

test("offline migration imports the existing encrypted root vault without discarding its journal or key", t => {
  const f = fixture(t), { FileJournals } = require("../../database/journal"), { CredentialVault } = require("../../database/vault");
  const oldKey = path.join(f.directory, "legacy.key"), oldDirectory = path.join(f.directory, "legacy-ledger");
  fs.writeFileSync(oldKey, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const env = { DB_VAULT_KEY_FILE: oldKey, DEPLOY_TARGET: "root@server.example:/opt/featheral", DEPLOY_HOST_KEY_SHA256: "SHA256:" + "a".repeat(43) };
  const journals = new FileJournals(oldDirectory), vault = new CredentialVault({ journals, repository: f.root, env });
  vault.save(password, vault.target());
  const envFile = path.join(f.directory, "legacy.env");
  fs.writeFileSync(envFile, Object.entries({ ...env, DB_LEDGER_DIR: oldDirectory, CMS_PASSWORD: adminPassword }).map(([name, value]) => `${name}='${value}'`).join("\n"), { mode: 0o600 });
  migrateEnvironment(f.settings, envFile);
  assert.equal(f.settings.value.credential.username, "root");
  assert.equal(f.settings.value.credential.password, password);
  assert.equal(fs.existsSync(oldKey), true);
  assert.equal(journals.get("internal/vault", "ssh-root").deleted, false);
  assert.equal(fs.existsSync(envFile), false);
  assert.equal(f.settings.environment().DB_LEDGER_DIR, oldDirectory);
});

test("Settings HTTP API enforces host, TLS, authentication, origin, bounded bodies and signed saves", async t => {
  const f = fixture(t), app = express();
  const authModule = require("../lib/admin-auth").createAdminAuth({ wallets: [f.wallet.address] });
  app.use("/api/admin-auth", authModule.router);
  f.input.settings.runtime = { APP_TURN_SECRET: "fixture-private-turn" };
  f.input.settings.runtimeConfirmation = "APPLY RUNTIME SETTINGS";
  app.use("/api/settings", settingsApi({ settings: f.settings, sites: () => [
    { key: "db.featheral.com", hostname: "db.featheral.com", status: "ready" },
    { key: "hosted-one", hostname: "sites.featheral.com", path: "/one", status: "ready" },
  ], cmsAuth: authModule.authenticate }));
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let cookies = "";
  const request = (url = "", body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: url.startsWith("/api/") ? url : "/api/settings" + url,
      method: body === undefined ? "GET" : "POST", headers: { Host: "admin.localhost", Origin: "http://admin.localhost", "Content-Type": "application/json", Cookie: cookies, ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request("", undefined, { Host: "app.localhost" })).status, 404);
  assert.equal((await request("", undefined, { Host: "admin.featheral.com" })).status, 403);
  assert.equal((await request("", undefined, { Host: "admin.featheral.com", "X-Forwarded-Proto": "https" })).status, 401);
  const loginChallenge = await request("/api/admin-auth/challenge", { address: f.wallet.address });
  cookies = loginChallenge.headers["set-cookie"][0].split(";")[0];
  const login = await request("/api/admin-auth/verify", { signature: await f.wallet.signMessage(loginChallenge.json().message) });
  cookies = login.headers["set-cookie"].find(value => value.startsWith("featheral_admin=")).split(";")[0];
  const auth = cookies;
  assert.equal((await request("/challenge", f.input, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("/challenge", { settings: { credential: "x".repeat(400000) } })).status, 413);
  assert.equal((await request("", f.input)).status, 403);
  const challenge = (await request("/challenge", f.input)).json();
  for (const secret of [password, adminPassword]) assert.ok(!JSON.stringify(challenge).includes(secret));
  const saved = await request("", { ...f.input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) });
  assert.equal(saved.status, 200);
  assert.equal(saved.json().revision, 1);
  assert.equal((await request("", undefined, { Cookie: "" })).status, 401);
  const publicValues = await request("", undefined, { Cookie: auth });
  assert.equal(publicValues.status, 200); assert.equal(publicValues.headers["cache-control"], "no-store");
  assert.doesNotMatch(publicValues.text, /adminHash|fixture-server-password|fixture-admin-password|fixture-private-turn/);
  assert.equal((await request("/sites/db.featheral.com", undefined, { Cookie: "" })).status, 401);
  const siteValues = await request("/sites/db.featheral.com", undefined, { Authorization: auth });
  assert.equal(siteValues.status, 200); assert.equal(siteValues.json().controls.length, 2);
  assert.equal((await request("/sites/missing.example", undefined, { Authorization: auth })).status, 404);
  assert.equal((await request("/sites/hosted-one", undefined, { Authorization: auth })).json().controls.length, 0);
  const siteInput = { revision: 1, settings: { useShared: false, url: "https://db.example/", host: "db.example", port: 2222,
    fingerprint: "SHA256:" + "b".repeat(43), credential: "db:fixture-site-private" } };
  assert.equal((await request("/sites/db.featheral.com/challenge", siteInput, { Authorization: auth, Origin: "https://evil.example" })).status, 403);
  const siteChallenge = (await request("/sites/db.featheral.com/challenge", siteInput, { Authorization: auth })).json();
  const siteSaved = await request("/sites/db.featheral.com", { ...siteInput, challengeId: siteChallenge.challengeId,
    signature: await f.wallet.signMessage(siteChallenge.message) }, { Authorization: auth });
  assert.equal(siteSaved.status, 200); assert.equal(siteSaved.json().revision, 2);
  assert.doesNotMatch(siteSaved.text, /fixture-site-private/);
});

test("Settings-backed deployment sends credentials only over stdin, uses SFTP, and applies the reviewed limits", async t => {
  const f = fixture(t); await f.save({ ...f.input, settings: { ...f.input.settings, enabled: true, uploadLimitMiB: 32, requestTimeoutSeconds: 120 } });
  const commands = [], sent = [], uploads = [];
  class Client extends EventEmitter {
    connect(config) {
      assert.equal(config.password, password); assert.equal(config.username, "deploy");
      process.nextTick(() => this.emit("ready"));
    }
    exec(command, callback) {
      commands.push(command);
      const stream = new EventEmitter(); stream.stderr = new EventEmitter();
      stream.end = input => { sent.push(input); process.nextTick(() => {
        if (command.includes("systemd-run")) {
          stream.emit("data", Buffer.from("Installing packages\n" + password.slice(0, 10)));
          stream.emit("data", Buffer.from(password.slice(10) + "\n"));
          stream.stderr.emit("data", Buffer.from("Installer warning\n"));
        }
        stream.emit("close", 0);
      }); };
      callback(null, stream);
    }
    sftp(callback) { callback(null, { fastPut(source, target, done) { uploads.push(target); done(); }, end() {} }); }
    end() {}
  }
  const deployment = new Deployment({ root: path.resolve(__dirname, "..", "..", ".."), settings: f.settings,
    clientFactory: () => new Client(), stateDirectory: path.join(f.directory, "deploy") });
  const plan = deployment.plan(), input = { planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` };
  assert.equal(plan.uploadLimitMiB, 32); assert.equal(plan.requestTimeoutSeconds, 120);
  const challenge = deployment.approvalChallenge(input, context);
  const credential = f.settings.useDeployment({ planId: plan.id, digest: plan.digest, contentDigest: plan.contentDigest, targetDigest: plan.targetDigest, installation: "auto" }, context,
    { challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) }, deployment.sites());
  const result = await deployment.start(input, credential);
  assert.equal(result.success, true);
  assert.ok(credential.every(target => target.password === ""));
  assert.equal(uploads.length, 2);
  assert.match(commands.at(-1), /systemd-run --wait --pipe --collect/);
  assert.match(commands.at(-1), /sudo -S -p '' -v/);
  assert.match(commands.at(-1), /'32' '120'/);
  assert.equal(sent.at(-1), password + "\n");
  assert.ok(commands.every(command => !command.includes(password)));
  assert.ok(!JSON.stringify(deployment.status()).includes(password));
  assert.match(JSON.stringify(deployment.status().logs), /Installing packages/);
  assert.match(JSON.stringify(deployment.status().logs), /Installer warning/);
  assert.match(JSON.stringify(deployment.status().logs), /REDACTED/);
});
test("one reviewed Git-tracked archive deploys to shared and DB servers with independent root passwords", async t => {
  const f = fixture(t);
  await f.save({ ...f.input, settings: { ...f.input.settings, host: "featheral.com", credential: `root:${password}`, enabled: true } });
  const site = "db.featheral.com", dbPassword = "fixture-separate-db-root-password";
  const siteInput = { revision: 1, settings: { useShared: false, url: "https://db.featheral.com/", host: "db.featheral.com",
    port: 22, fingerprint: "SHA256:" + "b".repeat(43), credential: `root:${dbPassword}` } };
  const proof = f.settings.siteChallenge(site, siteInput, context, site);
  await f.settings.saveSite(site, { ...siteInput, challengeId: proof.challengeId, signature: await f.wallet.signMessage(proof.message) }, context, site);
  const connections = [], uploads = [], commands = [], sent = [];
  class Client extends EventEmitter {
    connect(config) {
      this.host = config.host; connections.push({ host: config.host, password: config.password, username: config.username });
      assert.equal(config.password, config.host === "db.featheral.com" ? dbPassword : password);
      process.nextTick(() => this.emit("ready"));
    }
    exec(command, callback) {
      commands.push({ host: this.host, command });
      const stream = new EventEmitter(); stream.stderr = new EventEmitter();
      stream.end = input => { sent.push({ host: this.host, input }); process.nextTick(() => stream.emit("close", 0)); };
      callback(null, stream);
    }
    sftp(callback) { callback(null, { fastPut: (source, target, done) => {
      uploads.push({ host: this.host, target, bytes: fs.readFileSync(source) }); done();
    }, end() {} }); }
    end() {}
  }
  const deployment = new Deployment({ root: path.resolve(__dirname, "../../.."), settings: f.settings, clientFactory: () => new Client(),
    stateDirectory: path.join(f.directory, "deploy"), hostnames: () => ["featheral.com", "admin.featheral.com", site] });
  const plan = deployment.plan();
  assert.equal(plan.targets.length, 2);
  assert.deepEqual(plan.targets.find(target => target.id === "shared").hosts, ["featheral.com", "admin.featheral.com"]);
  assert.deepEqual(plan.targets.find(target => target.id === site).hosts, [site]);
  assert.ok(!JSON.stringify(plan).includes(dbPassword)); assert.ok(!JSON.stringify(plan).includes(password));
  const input = { planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` };
  const challenge = deployment.approvalChallenge(input, context);
  const credentials = f.settings.useDeployment({ planId: plan.id, digest: plan.digest, contentDigest: plan.contentDigest, targetDigest: plan.targetDigest, installation: "auto" }, context,
    { challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) }, deployment.sites());
  const result = await deployment.start(input, credentials);
  assert.equal(result.success, true);
  assert.deepEqual(connections.map(connection => connection.host), [site, "featheral.com"]);
  assert.ok(connections.every(connection => connection.username === "root"));
  const archives = uploads.filter(upload => upload.target.endsWith(".zip"));
  assert.equal(archives.length, 2); assert.deepEqual(archives[0].bytes, archives[1].bytes);
  assert.ok(uploads.filter(upload => upload.target.endsWith(".sh")).every(upload => !upload.bytes.includes(13)), "Linux shell uploads normalize Windows CRLF");
  const zip = archives[0].bytes, entry = zip.lastIndexOf(Buffer.from("scripts/deploy-release.sh")) - 46;
  assert.equal(zip.readUInt32LE(entry), 0x02014b50);
  assert.equal(zip.readUInt16LE(entry + 10), 8);
  const local = zip.readUInt32LE(entry + 42), size = zip.readUInt32LE(entry + 20);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const archivedScript = require("node:zlib").inflateRawSync(zip.subarray(start, start + size));
  assert.deepEqual(archivedScript, uploads.find(upload => upload.target.endsWith(".sh")).bytes, "Archive and bootstrap contain the exact same Linux shell bytes");
  assert.ok(archives[0].bytes.includes(Buffer.from("sites/db.featheral.com/index.html")));
  const dbCommand = commands.find(entry => entry.host === site && entry.command.includes("systemd-run")).command;
  const sharedCommand = commands.find(entry => entry.host === "featheral.com" && entry.command.includes("systemd-run")).command;
  assert.match(dbCommand, /'db.featheral.com'/); assert.match(dbCommand, /'false'/);
  assert.match(sharedCommand, /'featheral.com admin.featheral.com'/); assert.match(sharedCommand, /'true'/);
  assert.ok(commands.every(entry => !entry.command.includes(password) && !entry.command.includes(dbPassword)));
  assert.equal(sent.find(entry => entry.host === site && entry.input).input, dbPassword + "\n");
  assert.equal(sent.find(entry => entry.host === "featheral.com" && entry.input).input, password + "\n");
  assert.ok(credentials.every(target => target.password === ""));
  assert.equal(result.targets.length, 2);
  assert.ok(!JSON.stringify(deployment.status()).includes(dbPassword));
  assert.ok(!JSON.stringify(deployment.status()).includes(password));
  assert.ok(deployment.status().logs.some(entry => entry.message.includes("uploading")));
  assert.match(deployment.status().logs.at(-1).message, /All deployment targets verified/);
});
test("multi-target failures preserve per-server results and reject changed assignments before any SSH use", async t => {
  const f = fixture(t);
  await f.save({ ...f.input, settings: { ...f.input.settings, enabled: true } });
  const site = "db.featheral.com";
  const input = { revision: 1, settings: { useShared: false, url: "https://db.featheral.com/", host: "db.example",
    port: 22, fingerprint: "SHA256:" + "b".repeat(43), credential: "root:db-password" } };
  const proof = f.settings.siteChallenge(site, input, context, site);
  await f.settings.saveSite(site, { ...input, challengeId: proof.challengeId, signature: await f.wallet.signMessage(proof.message) }, context, site);
  const deployment = new Deployment({ root: path.resolve(__dirname, "../../.."), settings: f.settings, stateDirectory: path.join(f.directory, "deploy"),
    hostnames: () => ["featheral.com", site] });
  const old = deployment.plan(), approval = { planId: old.id, approval: `DEPLOY ${old.digest} ${old.contentDigest}` };
  f.settings.value.siteServers[site].url = "https://changed.example/";
  assert.throws(() => deployment.validate(approval), { status: 409 });
  const plan = deployment.plan(), nextInput = { planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` };
  const seen = [];
  deployment.deployTarget = async config => { seen.push(config.id); if (config.id === "shared") throw Object.assign(new Error("SSH failed"), { status: 502 }); };
  const credentials = f.settings.deploymentTargets(deployment.sites(), true);
  await assert.rejects(deployment.start(nextInput, credentials), { status: 502 });
  assert.deepEqual(seen, [site, "shared"]);
  assert.deepEqual(deployment.result.targets.map(target => target.success), [true, false]);
  assert.ok(credentials.every(target => target.password === ""));
  assert.deepEqual(new Deployment({ root: path.resolve(__dirname, "../../.."), settings: f.settings,
    stateDirectory: path.join(f.directory, "deploy") }).status().result.targets.map(target => target.success), [true, false]);
});

test("SSH execution and SFTP timeout failures are explicit", async t => {
  const f = fixture(t), deployment = new Deployment({ root: f.root, stateDirectory: path.join(f.directory, "deploy") });
  let closed = 0;
  const client = { end() { closed++; }, exec(_command, callback) {
    const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.end = () => {};
    callback(null, stream);
  } };
  await assert.rejects(deployment.execute(client, "true", "", 0.005), { status: 504 });
  await assert.rejects(deployment.transfer(client, () => {}, 0.005), { status: 504 });
  assert.equal(closed, 2);
});

test("saved HTTP limits enforce exact byte boundaries and live timeout updates without duplicate listeners", () => {
  const settings = { value: { uploadLimitMiB: 1, requestTimeoutSeconds: 30 }, listeners: new Set() };
  let requestTimeout, responseTimeout, installed = 0, rejected;
  const req = { headers: { "content-length": 1024 ** 2 }, setTimeout(value) { requestTimeout = value; } };
  const res = { setTimeout(value) { responseTimeout = value; installed++; }, writeHead(status) { rejected = status; }, end() {} };
  assert.equal(requestPolicy(req, res, settings), true);
  assert.equal(requestPolicy(req, res, settings), true);
  assert.equal(installed, 1);
  assert.equal(requestTimeout, 30000); assert.equal(responseTimeout, 30000);
  const overLimit = { headers: { "content-length": 1024 ** 2 + 1 }, setTimeout() {} };
  assert.equal(requestPolicy(overLimit, res, settings), false);
  assert.equal(rejected, 413);
  const server = new EventEmitter();
  configureServer(server, settings);
  assert.equal(server.requestTimeout, 30000); assert.equal(server.headersTimeout, 30000);
  settings.value.requestTimeoutSeconds = 120;
  for (const listener of settings.listeners) listener();
  assert.equal(server.requestTimeout, 120000); assert.equal(server.headersTimeout, 60000);
  server.emit("close");
  assert.equal(settings.listeners.size, 0);
});

test("remote setup provisions Node/PM2/Nginx, applies limits and enables SSL certificate renewal", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/deploy-release.sh"), "utf8");
  assert.match(script, /node_24\.x/);
  assert.match(script, /npm install --prefix "\$shared\/tools" --no-save pm2@6/);
  assert.match(script, /client_max_body_size DEPLOY_UPLOAD_MIBm/);
  assert.match(script, /proxy_read_timeout DEPLOY_TIMEOUTs/);
  assert.match(script, /proxy_send_timeout DEPLOY_TIMEOUTs/);
  assert.match(script, /certbot --nginx/);
  assert.match(script, /systemctl enable --now certbot\.timer/);
  assert.match(script, /systemctl is-active --quiet certbot\.timer/);
  assert.match(script, /renewal-hooks\/deploy\/featheral-nginx/);
  assert.match(script, /exec <\/dev\/null/);
  assert.ok(script.indexOf("npm ci\n") < script.indexOf('require("./services/operations/runtime")'));
  assert.match(script, /shared\/data\/system-database/);
  assert.doesNotMatch(script, /ln -s "\$shared\/\.env"/);
  assert.match(script, /proxy_pass http:\/\/DEPLOY_GATEWAY/);
  assert.match(script, /env\.PORT\|\|"8080"/);
  assert.match(script, /http:\/\/\$gateway\/healthz/);
});

test("runtime settings are encrypted, redacted, revision-bound and marked for restart without environment overrides", async t => {
  const f = fixture(t);
  f.settings.markStarted();
  const runtime = { APP_TURN_SECRET: "fixture-turn-secret", HOST: "127.0.0.1", PORT: "9091",
    FEATHERAL_ADMIN_WALLETS: f.wallet.address, GOLD_RESERVE_MODE: "disabled" };
  await f.save({ ...f.input, settings: { ...f.input.settings, runtime, runtimeConfirmation: "APPLY RUNTIME SETTINGS" } });
  const status = f.settings.status();
  assert.equal(status.restartRequired, true);
  assert.equal(status.runtimeFields.find(field => field.name === "APP_TURN_SECRET").configured, true);
  assert.equal(status.runtimeFields.find(field => field.name === "APP_TURN_SECRET").value, "");
  assert.equal(status.runtimeFields.find(field => field.name === "PORT").value, "9091");
  assert.ok(!JSON.stringify(status).includes("fixture-turn-secret"));
  const { FileJournals } = require("../../database/journal");
  const journals = new FileJournals(fs.realpathSync(f.settings.database.directory));
  const records = journals.replay("databases/system").records;
  for (const secret of [password, adminPassword, "fixture-turn-secret", f.settings.value.adminHash])
    assert.ok(!JSON.stringify(records).includes(secret));
  const restored = new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile });
  assert.deepEqual(restored.environment(), runtime);
  restored.markStarted(); assert.equal(restored.status().restartRequired, false);
  const snapshot = restored.environment(); snapshot.PORT = "1";
  assert.equal(restored.environment().PORT, "9091");
  const stale = new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile });
  await f.save({ revision: 1, settings: { uploadLimitMiB: 24 } });
  assert.throws(() => stale.persist({ ...stale.value, revision: 2 }), { status: 409 });
  await f.save({ revision: 2, settings: { runtime: { APP_TURN_SECRET: null }, runtimeConfirmation: "APPLY RUNTIME SETTINGS" } });
  assert.equal(f.settings.environment().APP_TURN_SECRET, undefined);
  assert.equal(f.settings.environment().PORT, "9091");
});

test("runtime schema rejects unsupported keys, unsafe values and missing explicit confirmation", t => {
  const f = fixture(t), { normalizeConfiguration } = require("../../operations/configuration");
  for (const runtime of [{ UNKNOWN: "x" }, { PORT: "65536" }, { PORT: 80 }, { GOLD_RESERVE_MODE: "automatic" },
    { FTH_LEDGER_MODE: "another-writer" }, { TOKEN_API_CONFIRMATIONS: "0" }, { APP_ORIGIN: "file:///private" },
    { WORLD_MODERATORS: "not-an-address" }, { SILVER_CODE_KEY: "bad" }, { FTH_LEDGER_SIGNING_PRIVATE_KEY: "bad" },
    { FTH_LEDGER_WRITER_PUBLIC_KEY: "bad" }, { TOKEN_API_SERVICES_JSON: "[]" },
    { TOKEN_API_SERVICES_JSON: '{"bad":{"role":"root","publicKey":"x"}}' },
    { ADMIN_CONFIG_JSON: '{"adminPassword":"not-allowed"}' }, { ADMIN_CONFIG_JSON: '{"siteManagement":"false"}' },
    { APP_VAPID_PRIVATE_KEY: "unpaired" }, { APP_ICE_URLS: "http://invalid" }])
    assert.throws(() => normalizeConfiguration(runtime), { status: 400 });
  assert.throws(() => f.settings.prepare({ ...f.input, settings: { ...f.input.settings, runtime: { PORT: "9091" } } }), { status: 400 });
  const signing = crypto.generateKeyPairSync("ed25519");
  assert.ok(normalizeConfiguration({ FTH_LEDGER_SIGNING_PRIVATE_KEY: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }));
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  assert.ok(normalizeConfiguration({ APP_VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"), APP_VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString("base64url") }));
});

test("legacy encrypted JSON upgrade retains credentials and revision and verifies persistence before deleting the source", async t => {
  const f = fixture(t); await f.save(f.input);
  const envelope = f.settings.database.settings().value;
  const root = path.join(f.directory, "legacy-repository"), file = path.join(root, "data", "operations", "settings.enc.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  assert.throws(() => new OperationsSettings({ root, bootstrapFile: f.bootstrapFile }), { status: 503 });
  const legacy = new OperationsSettings({ root, bootstrapFile: f.bootstrapFile, allowLegacy: true });
  assert.equal(legacy.migrateLegacy(), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(legacy.value.revision, 1);
  assert.equal(legacy.value.credential.password, password);
  assert.equal(new OperationsSettings({ root, bootstrapFile: f.bootstrapFile }).authenticate(adminPassword), true);
  await legacy.save(await (async () => {
    legacy.approvals = new OriginApprovals({ wallet: f.wallet.address });
    const input = { revision: 1, settings: { uploadLimitMiB: 24 } }, challenge = legacy.challenge(input, context);
    return { ...input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) };
  })(), context);
  assert.equal(legacy.databaseRevision, 2);
});

test("offline migration refuses unknown and conflicting values without deleting or changing source data", async t => {
  const f = fixture(t), file = path.join(f.directory, "legacy.env");
  for (const text of [`CMS_PASSWORD=${adminPassword}\nUNRECOGNIZED_SECRET=private`,
    `CMS_PASSWORD=${adminPassword}\nFTH_LEDGER_MODE=writer\nTOKEN_LEDGER_MODE=reader`]) {
    fs.writeFileSync(file, text, { mode: 0o600 });
    assert.throws(() => migrateEnvironment(f.settings, file));
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.equal(f.settings.value.revision, 0);
  }
  await f.save({ ...f.input, settings: { ...f.input.settings, runtime: { PORT: "9091" }, runtimeConfirmation: "APPLY RUNTIME SETTINGS" } });
  fs.writeFileSync(file, "PORT=8080", { mode: 0o600 });
  assert.throws(() => migrateEnvironment(f.settings, file), /disagree on PORT/);
  assert.equal(f.settings.value.revision, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "PORT=8080");
});

test("offline migration preserves existing operations and imports multiline signing keys, aliases and Admin configuration", async t => {
  const f = fixture(t); await f.save(f.input);
  const signing = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const adminFile = path.join(f.directory, "admin.json"), file = path.join(f.directory, "legacy.env");
  fs.writeFileSync(adminFile, JSON.stringify({ siteManagement: false, brand: "Fixture" }));
  fs.writeFileSync(file, `TOKEN_LEDGER_MODE=writer\nTOKEN_LEDGER_SIGNING_PRIVATE_KEY='${signing}'\nADMIN_CONFIG='${adminFile}'`, { mode: 0o600 });
  migrateEnvironment(f.settings, file);
  assert.equal(f.settings.value.revision, 2);
  assert.equal(f.settings.value.credential.password, password);
  assert.equal(f.settings.environment().FTH_LEDGER_SIGNING_PRIVATE_KEY, signing);
  assert.equal(f.settings.environment().FTH_LEDGER_MODE, "writer");
  assert.equal(JSON.parse(f.settings.environment().ADMIN_CONFIG_JSON).brand, "Fixture");
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(adminFile), false);
  assert.ok(!JSON.stringify(f.settings.status()).includes("PRIVATE KEY"));
});

test("startup refuses leftover environment sources rather than silently selecting new financial defaults", t => {
  const f = fixture(t), { assertDatabaseConfiguration } = require("../../operations/configuration");
  assert.doesNotThrow(() => assertDatabaseConfiguration(f.root, { PATH: "platform", NODE_ENV: "production" }));
  for (const name of ["PORT", "GOLD_RESERVE_MODE", "TOKEN_LEDGER_DIR", "CMS_PASSWORD", "DEPLOY_PASSWORD"]) {
    assert.throws(() => assertDatabaseConfiguration(f.root, { [name]: "private-not-in-error" }), error =>
      error.message.includes(name) && !error.message.includes("private-not-in-error"));
  }
  fs.writeFileSync(path.join(f.root, ".env"), "# leftover");
  assert.throws(() => assertDatabaseConfiguration(f.root, {}), /migrate/);
});

test("offline migration keeps the source configuration when database read-back cannot decrypt", t => {
  const f = fixture(t), file = path.join(f.directory, "legacy.env"), text = `CMS_PASSWORD=${adminPassword}`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  const persist = f.settings.persist.bind(f.settings);
  f.settings.persist = value => { persist(value); fs.writeFileSync(f.keyFile, crypto.randomBytes(32).toString("hex")); };
  assert.throws(() => migrateEnvironment(f.settings, file), { status: 503 });
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("explicit setup migration archives SSH-key configuration encrypted and allows signed localhost Admin enrollment", async t => {
  const f = fixture(t), file = path.join(f.directory, "legacy.env"), sshKey = path.join(f.directory, "original-ssh-key");
  fs.writeFileSync(sshKey, "fixture-key-unchanged", { mode: 0o600 });
  const text = `GOLD_RESERVE_MODE=disabled\nDEPLOY_TARGET=deploy@server.example:/opt/featheral\nDEPLOY_KEY_FILE='${sshKey}'\nDEPLOY_HOST_KEY_SHA256=SHA256:${"a".repeat(43)}\nDEPLOY_ENABLED=true\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  assert.throws(() => migrateEnvironment(f.settings, file), /--setup/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  const result = migrateEnvironment(f.settings, file, { setup: true });
  assert.equal(result.setupRequired, true);
  assert.equal(result.credentialEnrollmentRequired, true);
  assert.equal(f.settings.value.enabled, false);
  assert.equal(f.settings.value.credential, null);
  assert.equal(f.settings.value.adminHash, null);
  assert.equal(f.settings.value.host, "server.example");
  assert.equal(f.settings.environment().GOLD_RESERVE_MODE, "disabled");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(sshKey, "utf8"), "fixture-key-unchanged");
  const backup = fs.readFileSync(result.backupFile, "utf8");
  assert.ok(!backup.includes("DEPLOY_KEY_FILE"));
  const envelope = JSON.parse(backup), key = f.settings.key();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
    decipher.setAAD(Buffer.from("featheral-legacy-migration-v1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    const restored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "hex")), decipher.final()]).toString("utf8"));
    assert.equal(restored.environment, text);
    assert.equal(restored.envFile, file);
  } finally { key.fill(0); }
  assert.throws(() => f.settings.prepare({ revision: 1, settings: { allowUnconfiguredAdmin: true } }), { status: 400 });
  assert.doesNotThrow(() => f.settings.prepare({ revision: 1, settings: {} }));
  await f.save({ revision: 1, settings: { adminPassword } });
  assert.equal(f.settings.authenticate(adminPassword), true);
  assert.equal(f.settings.value.enabled, false);
  assert.equal(new OperationsSettings({ root: f.root, bootstrapFile: f.bootstrapFile }).authenticate(adminPassword), true);
});

test("migration preserves an external binding without requiring an obsolete Admin password", t => {
  const f = fixture(t), file = path.join(f.directory, "legacy.env"), text = "HOST=0.0.0.0\nGOLD_RESERVE_MODE=disabled";
  fs.writeFileSync(file, text, { mode: 0o600 });
  migrateEnvironment(f.settings, file);
  assert.equal(fs.existsSync(file), false);
  assert.equal(f.settings.value.revision, 1);
  assert.equal(f.settings.value.adminHash, null);
  assert.equal(f.settings.environment().HOST, "0.0.0.0");
  assert.equal(f.settings.value.enabled, false);
});

test("setup migration archives an invalid SSH fingerprint without authorizing it for server operations", t => {
  const f = fixture(t), file = path.join(f.directory, "legacy.env");
  fs.writeFileSync(file, "DEPLOY_TARGET=deploy@server.example:/opt/featheral\nDEPLOY_KEY_FILE=legacy.key\nDEPLOY_HOST_KEY_SHA256=replace-me", { mode: 0o600 });
  const result = migrateEnvironment(f.settings, file, { setup: true });
  assert.equal(result.fingerprintEnrollmentRequired, true);
  assert.equal(f.settings.value.fingerprint, "");
  assert.equal(f.settings.value.host, "server.example");
  assert.equal(f.settings.value.enabled, false);
  assert.throws(() => f.settings.configuration(), { status: 503 });
  assert.throws(() => require("../../database/ssh-target").sshTarget({ DEPLOY_TARGET: "deploy@server.example:/opt/featheral", DEPLOY_HOST_KEY_SHA256: "replace-me" }), { status: 400 });
});
