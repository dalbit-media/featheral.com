"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { once } = require("node:events");
const { Wallet } = require("ethers");
const { createDollarApi } = require("../../notes/dollar");
const { createWorldApi } = require("../../media/api");
const { createWalletProfiles } = require("../../database/wallet-profiles");
const sqlite = require("../../database/sqlite");
const { profileMessage, verifySignedProfile } = require("../../identity/profile");
const { profileUi, prepareProfile } = require("../../identity/profile-ui");
const { validate } = require("../../../sites/wallet.featheral.com/site-sign-in");

test("Dollar startup does not import ledger profiles into read-only replica storage", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dollar-replica-profile-"));
  const env = { FTH_LEDGER_DIR: path.join(directory, "notes"), FTH_LEDGER_MODE: "unconfigured", FTH_LEDGER_BLOCK_INTERVAL_MS: "0" };
  const writer = createDollarApi({ env });
  const profile = { address: "0x0000000000000000000000000000000000000001", username: "snapshot_user", avatar: "", bio: "retained", issuedAt: "2026-01-01T00:00:00.000Z" };
  writer.ledger.profiles.set(profile.address, profile);
  let imports = 0;
  const profiles = { readOnlyReplica: true, importLegacy() { imports++; throw new Error("Replica import attempted."); } };
  let replica;
  t.after(() => { replica?.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  replica = createDollarApi({ env: { ...env, FTH_LEDGER_MODE: "reader" }, ledger: writer.ledger, profiles });
  assert.equal(imports, 0);
  assert.equal(replica.ledger.profiles.get(profile.address).username, profile.username);
});

test("World JSON profile model and constrained wallet approval bind bio, avatar, wallet and timestamp", async () => {
  const wallet = Wallet.createRandom(), input = { address: wallet.address, username: "AppInsider", bio: "Volunteer\nMobile tools", avatar: "" };
  const model = profileUi();
  assert.equal(model.schema, "featheral.profile"); assert.equal(model.version, 1);
  assert.deepEqual(model.fields.map(field => field.name), ["username", "avatar", "bio"]);
  const browserPattern = new RegExp(model.fields[0].pattern, "v");
  assert.equal(browserPattern.test("App-Insider"), true);
  assert.equal(browserPattern.test("-invalid"), false);
  const prepared = prepareProfile(input), signed = { ...prepared.profile, signature: await wallet.signMessage(prepared.message) };
  assert.equal(verifySignedProfile(signed).bio, input.bio);
  for (const origin of ["http://app.localhost:8080", "http://world.localhost:8080", "https://app.featheral.com", "https://world.featheral.com", "https://media.featheral.com", "http://media.localhost:8080"])
    validate(wallet.address, prepared.message, true, origin);
  for (const origin of ["https://evil.example", "https://x.featheral.com", undefined])
    assert.throws(() => validate(wallet.address, prepared.message, true, origin), /standard/);
  assert.throws(() => validate(Wallet.createRandom().address, prepared.message, true, "https://app.featheral.com"), /standard/);
  assert.throws(() => validate(wallet.address, prepared.message + "\nPay salary", true, "https://app.featheral.com"), /standard/);
  assert.throws(() => validate(wallet.address, prepared.message.replace(/Issued at: [^\n]+/, "Issued at: 2000-01-01T00:00:00.000Z"), true, "https://app.featheral.com"), /expired/);
  assert.throws(() => verifySignedProfile({ ...signed, bio: "Changed introduction" }), /signature/i);
  for (const bio of ["x".repeat(1001), "bad\u0000bio", 1])
    assert.throws(() => prepareProfile({ ...input, bio }), /bio/);
  assert.throws(() => prepareProfile({ ...input, avatar: "https://example.com/image.png" }), /avatar/);
  assert.throws(() => prepareProfile({ ...input, username: "-invalid" }), /username/);
});

test("App uses the World profile API to persist signed bio in the DB API, including legacy updates and restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "world-profile-http-"));
  const env = { FTH_LEDGER_DIR: path.join(directory, "notes"), FTH_LEDGER_MODE: "unconfigured", FTH_LEDGER_BLOCK_INTERVAL_MS: "0" };
  const worldEnv = { WORLD_DB_FILE: path.join(directory, "world-feed.sqlite") };
  let profiles = createWalletProfiles(sqlite, path.join(directory, "wallet-profiles.sqlite"));
  let notes = createDollarApi({ env, profiles }), world = createWorldApi({ fthLedger: notes.ledger, sqlite, profiles,
    env: worldEnv,
    profileHandler: async (req, res) => {
      const original = req.url;
      try { req.url = "/api/v1/notes/profiles"; return await notes.handle(req, res); }
      finally { req.url = original; }
    } });
  const server = http.createServer(async (req, res) => {
    if (await world.handle(req, res)) return;
    if (await notes.handle(req, res)) return;
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); world.close(); notes.close(); profiles.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function call(route, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route,
        method: body === undefined ? "GET" : "POST", headers: { Host: "app.localhost", Origin: "http://app.localhost", "Content-Type": "application/json" } }, res => {
        const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const wallet = Wallet.createRandom();
  assert.equal((await call("/api/v1/world/profile/ui")).data.fields[2].name, "bio");
  assert.equal((await call(`/api/v1/world/profile/${wallet.address}`)).data.profile, null);
  const png = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=", "base64"), Buffer.alloc(20 * 1024)]);
  assert.equal((await call("/api/v1/world/profile/prepare", { address: wallet.address, username: "AvatarLimit", avatar: `data:image/png;base64,${png.toString("base64")}` })).status, 200,
    "profile preparation accepts permitted avatars above the unrelated 16 KiB social-action limit");
  const prepared = await call("/api/v1/world/profile/prepare", { address: wallet.address, username: "AppNative", avatar: "", bio: "Building tools with Featheral." });
  assert.equal(prepared.status, 200);
  const signed = { ...prepared.data.profile, signature: await wallet.signMessage(prepared.data.message) };
  assert.equal((await call("/api/v1/world/profile", { ...signed, bio: "Unauthorized edit" })).status, 401);
  const saved = await call("/api/v1/world/profile", signed);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.profile.bio, signed.bio);
  for (const route of [`/api/v1/world/profile/${wallet.address}`, `/api/v1/notes/profiles/${wallet.address}`, `/api/v1/world/users/${wallet.address}`])
    assert.equal((await call(route)).data.profile.bio, signed.bio);
  const other = Wallet.createRandom();
  const duplicate = prepareProfile({ address: other.address, username: "AppNative", bio: "", avatar: "" });
  assert.equal((await call("/api/v1/world/profile", { ...duplicate.profile, signature: await wallet.signMessage(duplicate.message) })).status, 401);
  assert.equal((await call("/api/v1/world/profile", { ...duplicate.profile, signature: await other.signMessage(duplicate.message) })).status, 409);
  const legacy = { address: wallet.address, username: "AppNative2", avatar: "", issuedAt: new Date(Date.parse(signed.issuedAt) + 10).toISOString() };
  legacy.signature = await wallet.signMessage(profileMessage(legacy));
  assert.equal((await call("/api/v1/notes/profiles", legacy)).status, 200);
  assert.equal((await call(`/api/v1/world/profile/${wallet.address}`)).data.profile.bio, signed.bio, "legacy avatar/name updates preserve an existing bio");
  world.close(); notes.close(); profiles.close();
  profiles = createWalletProfiles(sqlite, path.join(directory, "wallet-profiles.sqlite"));
  notes = createDollarApi({ env, profiles });
  world = createWorldApi({ fthLedger: notes.ledger, sqlite, profiles, env: worldEnv });
  assert.equal((await call(`/api/v1/world/profile/${wallet.address}`)).data.profile.bio, signed.bio);
  assert.equal((await call("/api/v1/world/profile", signed)).status, 503, "standalone World never claims a save without canonical writer");
});
