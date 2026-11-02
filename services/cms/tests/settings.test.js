"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Wallet } = require("ethers");
const { OriginApprovals } = require("../../db-api/approvals");
const { OperationsSettings, parseCredential } = require("../../operations/settings");
const { Deployment } = require("../lib/deployment");
const { settingsApi } = require("../../operations/api");
const { requestPolicy, configureServer } = require("../../operations/http");
const express = require("express");
const http = require("node:http");
const { EventEmitter, once } = require("node:events");
const { initialize, migrateEnvironment } = require("../../../scripts/init-settings");
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
  const initialized = initialize(newBootstrap), originalKey = initialized.key().toString("hex");
  assert.equal(initialize(newBootstrap).key().toString("hex"), originalKey);
});

test("offline migration imports the existing encrypted root vault without discarding its journal or key", t => {
  const f = fixture(t), { FileJournals } = require("../../db-api/journal"), { CredentialVault } = require("../../db-api/vault");
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
  f.input.settings.runtime = { APP_TURN_SECRET: "fixture-private-turn" };
  f.input.settings.runtimeConfirmation = "APPLY RUNTIME SETTINGS";
  app.use("/api/settings", settingsApi({ settings: f.settings, cmsAuth: (req, res, next) => {
    if (!f.settings.adminConfigured()) return next();
    const supplied = Buffer.from((req.get("authorization") || "").slice(6), "base64").toString("utf8").slice(6);
    return f.settings.authenticate(supplied) ? next() : res.sendStatus(401);
  } }));
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const auth = "Basic " + Buffer.from("admin:" + adminPassword).toString("base64");
  const request = (url = "", body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/settings" + url,
      method: body === undefined ? "GET" : "POST", headers: { Host: "admin.localhost", Origin: "http://admin.localhost", "Content-Type": "application/json", ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request("", undefined, { Host: "app.localhost" })).status, 404);
  assert.equal((await request("", undefined, { Host: "admin.featheral.com" })).status, 403);
  assert.equal((await request("", undefined, { Host: "admin.featheral.com", "X-Forwarded-Proto": "https" })).status, 503);
  assert.equal((await request("/challenge", f.input, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("/challenge", { settings: { credential: "x".repeat(400000) } })).status, 413);
  assert.equal((await request("", f.input)).status, 403);
  const challenge = (await request("/challenge", f.input)).json();
  for (const secret of [password, adminPassword]) assert.ok(!JSON.stringify(challenge).includes(secret));
  const saved = await request("", { ...f.input, challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) });
  assert.equal(saved.status, 200);
  assert.equal(saved.json().revision, 1);
  assert.equal((await request()).status, 401);
  const publicValues = await request("", undefined, { Authorization: auth });
  assert.equal(publicValues.status, 200); assert.equal(publicValues.headers["cache-control"], "no-store");
  assert.doesNotMatch(publicValues.text, /adminHash|fixture-server-password|fixture-admin-password|fixture-private-turn/);
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
      stream.end = input => { sent.push(input); process.nextTick(() => stream.emit("close", 0)); };
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
  const credential = f.settings.use("DEPLOY REVIEWED RELEASE", { planId: plan.id, digest: plan.digest, contentDigest: plan.contentDigest }, context,
    { challengeId: challenge.challengeId, signature: await f.wallet.signMessage(challenge.message) });
  const result = await deployment.start(input, credential);
  assert.equal(result.success, true);
  assert.equal(credential.password, "");
  assert.equal(uploads.length, 2);
  assert.match(commands.at(-1), /systemd-run --wait --pipe --collect/);
  assert.match(commands.at(-1), /sudo -S -p '' -v/);
  assert.match(commands.at(-1), /'32' '120'/);
  assert.equal(sent.at(-1), password + "\n");
  assert.ok(commands.every(command => !command.includes(password)));
  assert.ok(!JSON.stringify(deployment.status()).includes(password));
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
  const { FileJournals } = require("../../db-api/journal");
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
