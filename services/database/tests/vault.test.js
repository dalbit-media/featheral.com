"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Wallet } = require("ethers");
const { FileJournals } = require("../journal");
const { CredentialVault } = require("../vault");
const { OriginApprovals } = require("../approvals");
const context = { origin: "http://admin.localhost", session: "fixture-admin" };
const password = "fixture-secret-not-a-wallet-private-key";
function fixture(t, verifyCredential = async () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-vault-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "key");
  fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const wallet = Wallet.createRandom(), clock = { at: Date.now() };
  const env = { DB_VAULT_KEY_FILE: file, DEPLOY_TARGET: "root@server.example:/opt/featheral", DEPLOY_HOST_KEY_SHA256: "SHA256:" + "a".repeat(43) };
  const journals = new FileJournals(path.join(directory, "ledger"));
  const approvals = new OriginApprovals({ wallet: wallet.address, now: () => clock.at });
  const vault = new CredentialVault({ journals, env, repository: path.resolve(__dirname, "..", "..", ".."), verifyCredential, approvals });
  const sign = async challenge => ({ challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) });
  const enroll = async () => vault.enroll({ password, ...await sign(vault.challengeEnrollment({ password }, context)) }, context);
  const use = async (action = "TEST SSH", binding = { operation: "fixture" }) => vault.use(action, binding, context,
    await sign(vault.challengeUse(action, binding, context)));
  return { vault, journals, env, file, wallet, clock, sign, enroll, use };
}
test("enrollment verifies SSH, encrypts at rest and does not expose a credential in status or config", async t => {
  let verified;
  const f = fixture(t, async config => { verified = config; });
  assert.equal((await f.enroll()).verified, true);
  assert.equal(verified.password, password); assert.equal(verified.username, "root");
  assert.equal(f.vault.status().enrolled, true); assert.equal(f.vault.configuration().vault, true);
  assert.ok(!JSON.stringify(f.vault.status()).includes(password));
  assert.ok(!JSON.stringify(f.vault.configuration()).includes(password));
  for (const { file } of f.journals.files("internal/vault")) assert.ok(!fs.readFileSync(file, "utf8").includes(password));
  assert.equal((await f.use()).password, password);
});
test("invalid SSH credentials never enter the ledger", async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error("SSH login failed"), { status: 502 }); });
  await assert.rejects(f.enroll(), { status: 502 });
  assert.equal(f.vault.status().enrolled, false);
  assert.equal(f.journals.summary("internal/vault").sequence, 0);
});
test("wrong wallet, expired approvals and replay are rejected", async t => {
  const f = fixture(t);
  let challenge = f.vault.challengeEnrollment({ password }, context);
  await assert.rejects(f.vault.enroll({ password, challengeId: challenge.challengeId, signature: await Wallet.createRandom().signMessage(challenge.message) }, context), { status: 403 });
  challenge = f.vault.challengeEnrollment({ password }, context);
  const signed = await f.sign(challenge);
  f.clock.at += 300001;
  await assert.rejects(f.vault.enroll({ password, ...signed }, context), { status: 403 });
  await f.enroll();
  challenge = f.vault.challengeUse("TEST SSH", {}, context);
  const use = await f.sign(challenge);
  assert.equal(f.vault.use("TEST SSH", {}, context, use).password, password);
  assert.throws(() => f.vault.use("TEST SSH", {}, context, use), { status: 403 });
});
test("enrollment signatures bind exact password, target, revision and Admin context without a public password hash", async t => {
  const f = fixture(t);
  for (const mutation of ["password", "session", "origin", "target", "revision"]) {
    const challenge = f.vault.challengeEnrollment({ password }, context), signed = await f.sign(challenge);
    assert.ok(!challenge.message.includes(password));
    const ctx = { ...context }, input = { password, ...signed };
    if (mutation === "password") input.password += "different";
    if (mutation === "session") ctx.session = "other";
    if (mutation === "origin") ctx.origin = "https://other.example";
    const old = f.env.DEPLOY_PORT;
    if (mutation === "target") f.env.DEPLOY_PORT = "2222";
    if (mutation === "revision") f.vault.save(password, f.vault.target());
    await assert.rejects(f.vault.enroll(input, ctx), { status: 403 });
    if (old === undefined) delete f.env.DEPLOY_PORT; else f.env.DEPLOY_PORT = old;
  }
});
test("use signatures bind action and reviewed payload; enrollment rotation revokes outstanding use approvals", async t => {
  const f = fixture(t); await f.enroll();
  const action = "DEPLOY REVIEWED RELEASE", binding = { planId: "fixture", digest: "a" };
  let signed = await f.sign(f.vault.challengeUse(action, binding, context));
  assert.throws(() => f.vault.use(action, { ...binding, digest: "b" }, context, signed), { status: 403 });
  signed = await f.sign(f.vault.challengeUse(action, binding, context));
  assert.throws(() => f.vault.use("BROWSE SERVER ACCOUNTS", binding, context, signed), { status: 403 });
  signed = await f.sign(f.vault.challengeUse(action, binding, context));
  await f.enroll();
  assert.throws(() => f.vault.use(action, binding, context, signed), { status: 403 });
});
test("different host fingerprints require reenrollment and wrong encryption keys cannot decrypt", async t => {
  const f = fixture(t); await f.enroll();
  f.env.DEPLOY_HOST_KEY_SHA256 = "SHA256:" + "b".repeat(43);
  assert.throws(() => f.vault.configuration(), { status: 409 });
  f.env.DEPLOY_HOST_KEY_SHA256 = "SHA256:" + "a".repeat(43);
  fs.writeFileSync(f.file, crypto.randomBytes(32).toString("hex"));
  await assert.rejects(f.use(), { status: 503 });
});
test("missing and in-ledger encryption keys never trigger automatic key generation", t => {
  const f = fixture(t);
  f.env.DB_VAULT_KEY_FILE = path.join(f.journals.directory, "key");
  assert.throws(() => f.vault.key(), { status: 503 });
  f.env.DB_VAULT_KEY_FILE = "";
  assert.throws(() => f.vault.challengeEnrollment({ password }, context), { status: 503 });
  assert.equal(f.vault.status().enrolled, false);
});
