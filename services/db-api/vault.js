"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { canonical } = require("../fth-ledger/codec");
const { OriginApprovals } = require("./approvals");
const { fail } = require("./journal");
const { sshTarget } = require("./ssh-target");
const STREAM = "internal/vault", KEY = "ssh-root";
class CredentialVault {
  constructor({ journals, env = process.env, repository, verifyCredential, approvals = new OriginApprovals() }) {
    this.journals = journals; this.env = env; this.repository = path.resolve(repository);
    this.verifyCredential = verifyCredential; this.approvals = approvals; this.busy = false;
  }
  key() {
    const file = this.env.DB_VAULT_KEY_FILE;
    if (!file || !path.isAbsolute(file)) throw fail(503, "Configure DB_VAULT_KEY_FILE with an external server-side vault key file. No root password environment variable is needed.");
    for (const root of [this.repository, this.journals.directory]) {
      const relative = path.relative(root, path.resolve(file));
      if (!relative || !relative.startsWith("..") && !path.isAbsolute(relative)) throw fail(503, "The vault encryption key must be outside the repository and ledger.");
    }
    if (fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw fail(503, "The vault key path cannot contain symbolic links.");
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 66 || process.platform !== "win32" && (stat.mode & 0o077))
      throw fail(503, "The vault key must be a private, unlinked server file (0600 on Unix).");
    const text = fs.readFileSync(file, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(text)) throw fail(503, "Invalid vault encryption key file.");
    return Buffer.from(text, "hex");
  }
  target() {
    const target = sshTarget(this.env);
    if (target.username !== "root") throw fail(400, "The root credential vault requires DEPLOY_TARGET=root@host:/directory.");
    return target;
  }
  stored() { return this.journals.get(STREAM, KEY); }
  status() {
    const entry = this.stored();
    return { configured: Boolean(this.env.DB_VAULT_KEY_FILE), enrolled: !entry.deleted, revision: entry.revision,
      updatedAt: entry.deleted ? null : entry.value.at, busy: this.busy, wallet: this.approvals.wallet };
  }
  configuration() {
    this.key().fill(0);
    const target = this.target(), entry = this.stored();
    if (entry.deleted) throw fail(503, "Enroll and verify the root SSH credential in Admin → Database. No root password is required in .env.");
    if (canonical(entry.value.target) !== canonical(target)) throw fail(409, "The vault credential belongs to a different server or host key. Verify and enroll this target separately.");
    return { ...target, keyFile: "", password: "", vault: true };
  }
  enrollment(password) {
    if (this.busy) throw fail(409, "Credential enrollment is already running.");
    if (typeof password !== "string" || password.length < 1 || Buffer.byteLength(password) > 1024 || /[\0\r\n]/.test(password))
      throw fail(400, "Supply the current root SSH password without line breaks.");
    this.key().fill(0);
    return { password, target: this.target(), revision: this.stored().revision };
  }
  label(target) { return `root@${target.host}:${target.port}${target.directory} · ${target.fingerprint}`; }
  challengeEnrollment(input, context) {
    const value = this.enrollment(input?.password);
    return this.approvals.challenge("VERIFY AND STORE ROOT SSH CREDENTIAL", value, context, this.label(value.target));
  }
  async enroll(input, context) {
    const value = this.enrollment(input?.password);
    this.approvals.consume("VERIFY AND STORE ROOT SSH CREDENTIAL", value, context, input);
    if (typeof this.verifyCredential !== "function") throw fail(503, "SSH credential verification is unavailable.");
    this.busy = true;
    try {
      await this.verifyCredential({ ...value.target, password: value.password, keyFile: "" });
      this.save(value.password, value.target, value.revision);
      return { enrolled: true, verified: true, message: "Stored encrypted credential after a fresh root SSH login. No password is returned or written to .env." };
    } finally { this.busy = false; }
  }
  save(password, target, revision = this.stored().revision) {
    const key = this.key(), iv = crypto.randomBytes(12);
    try {
      const aad = canonical({ version: 1, target, revision: revision + 1 });
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      this.journals.transact(STREAM, { requestId: crypto.randomUUID(), changes: [{ key: KEY, op: "put", expectedRevision: revision,
        value: { version: 1, target, at: Date.now(), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") } }] });
    } finally { key.fill(0); }
  }
  challengeUse(action, binding, context) {
    const target = this.configuration();
    const value = { binding, target: this.target(), revision: this.stored().revision };
    return this.approvals.challenge(action, value, context, this.label(target));
  }
  use(action, binding, context, input) {
    this.configuration();
    const entry = this.stored(), target = this.target();
    this.approvals.consume(action, { binding, target, revision: entry.revision }, context, input);
    const value = entry.value, key = this.key();
    try {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "hex"));
      cipher.setAAD(Buffer.from(canonical({ version: 1, target, revision: entry.revision })));
      cipher.setAuthTag(Buffer.from(value.tag, "hex"));
      const bytes = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, "hex")), cipher.final()]);
      try { return { ...target, keyFile: "", password: bytes.toString("utf8") }; }
      finally { bytes.fill(0); }
    } catch { throw fail(503, "Stored credential could not be decrypted. Check the private vault key and ledger integrity."); }
    finally { key.fill(0); }
  }
}
module.exports = { CredentialVault };
