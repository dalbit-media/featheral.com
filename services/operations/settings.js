"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { OriginApprovals } = require("../database/approvals");
const { SystemDatabase } = require("../database/system");
const { fields, normalizeConfiguration } = require("./configuration");
const fail = (status, message) => Object.assign(new Error(message), { status });
const defaults = Object.freeze({
  host: "", port: 22, directory: "/opt/featheral", fingerprint: "", enabled: false,
  tlsEmail: "", uploadLimitMiB: 16, requestTimeoutSeconds: 90,
  sshTimeoutSeconds: 20, deploymentTimeoutSeconds: 900, networkLimitBytesPerSecond: 0,
});
const bootstrapPath = () => process.env.FEATHERAL_BOOTSTRAP_FILE || (process.platform === "win32"
  ? path.join(process.env.ProgramData || os.homedir(), "Featheral", "bootstrap.json") : "/etc/featheral/bootstrap.json");
function privateFile(file, allowLinkedParent = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !allowLinkedParent && fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()
    || process.platform !== "win32" && (stat.mode & 0o077)) throw fail(503, "Operations files must be private, regular files without links (0600 on Unix).");
}
function parseCredential(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 2048 || /[\0\r\n]/.test(value))
    throw fail(400, "Enter username:password, or password only for root, without line breaks.");
  const colon = value.indexOf(":");
  const username = colon < 0 ? "root" : value.slice(0, colon) || "root";
  const password = colon < 0 ? value : value.slice(colon + 1);
  if (!/^[a-z_][a-z0-9_-]*$/.test(username) || !password) throw fail(400, "A valid Linux username and nonempty password are required.");
  return { username, password };
}
function passwordHash(password) {
  if (typeof password !== "string" || Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024 || /[\0\r\n]/.test(password))
    throw fail(400, "Admin password must contain 16–1024 bytes without line breaks.");
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}
class OperationsSettings {
  constructor({ root, file = path.join(root, "data", "operations", "settings.enc.json"), bootstrapFile = bootstrapPath(),
    approvals = new OriginApprovals(), verifyCredential, isBusy = () => false, allowLegacy = false } = {}) {
    this.root = path.resolve(root); this.file = file; this.bootstrapFile = bootstrapFile;
    if (!path.isAbsolute(bootstrapFile)) throw fail(503, "Bootstrap path must be absolute.");
    this.approvals = approvals; this.verifyCredential = verifyCredential; this.isBusy = isBusy;
    this.busy = false; this.listeners = new Set();
    this.value = { ...defaults, revision: 0, credential: null, adminHash: null, runtime: {} };
    this.database = new SystemDatabase(this.root);
    this.databaseRevision = 0;
    const stored = this.database.settings();
    if (!stored.deleted) {
      this.databaseRevision = stored.revision;
      this.load(stored.value);
    } else if (fs.existsSync(file) && !allowLegacy) {
      throw fail(503, "Legacy encrypted Settings found. Stop the service and run scripts/init-settings.js --migrate-settings before restarting.");
    }
  }
  key() {
    if (!fs.existsSync(this.bootstrapFile)) throw fail(503, "Initialize the external bootstrap file with scripts/init-settings.js before saving Settings.");
    privateFile(this.bootstrapFile);
    const config = JSON.parse(fs.readFileSync(this.bootstrapFile, "utf8"));
    if (typeof config.keyFile !== "string" || !path.isAbsolute(config.keyFile)) throw fail(503, "Bootstrap requires an absolute external keyFile.");
    for (const file of [this.bootstrapFile, config.keyFile]) {
      const relative = path.relative(this.root, path.resolve(file));
      if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        throw fail(503, "Bootstrap and encryption key must be outside the repository.");
    }
    privateFile(config.keyFile);
    const key = fs.readFileSync(config.keyFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw fail(503, "Invalid operations encryption key.");
    return Buffer.from(key, "hex");
  }
  load(envelope) {
    const key = this.key();
    try {
      if (envelope.version !== 1) throw new Error("Unsupported settings version");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
      decipher.setAAD(Buffer.from("featheral-operations-v1"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "hex")), decipher.final()]);
      try { this.value = JSON.parse(plain.toString("utf8")); } finally { plain.fill(0); }
      if (!Number.isSafeInteger(this.value.revision) || this.value.revision < 1) throw new Error("Invalid settings revision");
      this.value.runtime = normalizeConfiguration(this.value.runtime || {});
    } catch { throw fail(503, "Operations settings could not be decrypted. Restore the original external key and settings backup."); }
    finally { key.fill(0); }
  }
  persist(value) {
    const key = this.key(), iv = crypto.randomBytes(12);
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("featheral-operations-v1"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      this.database.saveSettings({ version: 1, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") }, this.databaseRevision);
      this.databaseRevision++;
      this.value = value;
      for (const listener of this.listeners) listener();
    } finally { key.fill(0); }
  }
  migrateLegacy() {
    if (!fs.existsSync(this.file)) return false;
    if (this.databaseRevision) throw fail(409, "System database Settings already exist. Verify the old file before removing it manually.");
    privateFile(this.file, true);
    this.load(JSON.parse(fs.readFileSync(this.file, "utf8")));
    this.persist(this.value);
    const restored = new OperationsSettings({ root: this.root, bootstrapFile: this.bootstrapFile });
    if (JSON.stringify(restored.value) !== JSON.stringify(this.value)) throw fail(503, "Legacy Settings database read-back failed; original file retained.");
    fs.rmSync(this.file);
    return true;
  }
  status() {
    const { credential, adminHash, runtime, ...publicValue } = this.value;
    return { ...publicValue, configured: fs.existsSync(this.bootstrapFile), enrolled: Boolean(credential),
      username: credential?.username || "root", adminConfigured: Boolean(adminHash), busy: this.busy, wallet: this.approvals.wallet,
      runtimeFields: fields.map(field => ({ ...field, configured: Boolean(runtime[field.name]), value: field.secret ? "" : runtime[field.name] || "" })),
      restartRequired: this.startedRuntime !== undefined && JSON.stringify(runtime) !== this.startedRuntime };
  }
  environment() { return { ...this.value.runtime }; }
  markStarted() { this.startedRuntime = JSON.stringify(this.value.runtime); }
  adminConfigured() { return Boolean(this.value.adminHash); }
  authenticate(password) {
    if (!this.value.adminHash || typeof password !== "string" || Buffer.byteLength(password) > 1024) return false;
    const [salt, hash] = this.value.adminHash.split(":");
    const actual = crypto.scryptSync(password, salt, 32);
    return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
  }
  prepare(input, { allowUnconfiguredAdmin = false } = {}) {
    if (this.busy || this.isBusy()) throw fail(409, "Wait for the current settings or deployment operation.");
    if (!input || input.revision !== this.value.revision || !input.settings || Array.isArray(input.settings)) throw fail(409, "Reload Settings before saving.");
    const allowed = new Set([...Object.keys(defaults), "credential", "adminPassword", "runtime", "runtimeConfirmation"]);
    for (const name of Object.keys(input.settings)) if (!allowed.has(name)) throw fail(400, `Unknown operations setting: ${name}`);
    const next = { ...this.value, ...input.settings, revision: this.value.revision + 1 };
    delete next.adminPassword;
    delete next.runtimeConfirmation;
    if (input.settings.runtime !== undefined) {
      if (input.settings.runtimeConfirmation !== "APPLY RUNTIME SETTINGS")
        throw fail(400, "Confirm APPLY RUNTIME SETTINGS. Storage, signing and authority changes require a planned restart and consistent backup.");
      next.runtime = normalizeConfiguration(input.settings.runtime, this.value.runtime);
    }
    if (typeof next.enabled !== "boolean") throw fail(400, "Deployment enabled must be a boolean.");
    for (const name of ["host", "directory", "fingerprint", "tlsEmail"]) if (typeof next[name] !== "string") throw fail(400, `Invalid ${name}.`);
    if (next.host && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(next.host)) throw fail(400, "Invalid SSH hostname or IPv4 address.");
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(next.directory) || next.directory === "/" || next.directory.split("/").includes(".."))
      throw fail(400, "Use an absolute deployment directory other than /, without traversal.");
    if (next.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(next.fingerprint)) throw fail(400, "Enter an independently verified SHA256 SSH host fingerprint.");
    next.fingerprint = next.fingerprint.replace(/=+$/, "");
    if (next.tlsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.tlsEmail)) throw fail(400, "Invalid certificate registration email.");
    const bounds = { port: [1, 65535], uploadLimitMiB: [1, 1024], requestTimeoutSeconds: [5, 3600],
      sshTimeoutSeconds: [5, 120], deploymentTimeoutSeconds: [60, 7200], networkLimitBytesPerSecond: [0, Number.MAX_SAFE_INTEGER] };
    for (const [name, [min, max]] of Object.entries(bounds))
      if (!Number.isSafeInteger(next[name]) || next[name] < min || next[name] > max) throw fail(400, `${name} must be an integer from ${min} to ${max}.`);
    const supplied = input.settings.credential;
    if (supplied !== undefined) next.credential = parseCredential(supplied);
    const changedTarget = ["host", "port", "fingerprint"].some(name => next[name] !== this.value[name]);
    if (changedTarget && this.value.credential && supplied === undefined) throw fail(400, "Re-enter and verify the credential when changing the SSH host, port or host key.");
    if (input.settings.adminPassword) next.adminHash = passwordHash(input.settings.adminPassword);
    if (!next.adminHash && (!allowUnconfiguredAdmin || next.enabled)) throw fail(400, "Set an Admin password before saving operations settings.");
    if ((supplied !== undefined || next.enabled) && (!next.host || !next.fingerprint || !next.credential))
      throw fail(400, "SSH host, pinned fingerprint and credential are required.");
    if (next.enabled && !next.tlsEmail) throw fail(400, "Certificate email is required before enabling deployment.");
    this.key().fill(0);
    return next;
  }
  challenge(input, context) {
    this.prepare(input);
    return this.approvals.challenge("SAVE OPERATIONS SETTINGS", { revision: input.revision, settings: input.settings }, context, `${input.settings.host || this.value.host || "local settings"} · revision ${this.value.revision}`);
  }
  async save(input, context) {
    const next = this.prepare(input);
    this.approvals.consume("SAVE OPERATIONS SETTINGS", { revision: input.revision, settings: input.settings }, context, input);
    this.busy = true;
    try {
      if (input.settings.credential !== undefined) {
        if (!this.verifyCredential) throw fail(503, "SSH verification is unavailable.");
        await this.verifyCredential(this.connection(next));
      }
      this.persist(next);
      return this.status();
    } finally { this.busy = false; }
  }
  connection(value = this.value) {
    if (!value.host || !value.fingerprint || !value.credential) throw fail(503, "Set and verify SSH credentials in Admin Settings.");
    return { host: value.host, port: value.port, directory: value.directory, fingerprint: value.fingerprint,
      ...value.credential, keyFile: "", email: value.tlsEmail, vault: true,
      sshTimeoutSeconds: value.sshTimeoutSeconds, deploymentTimeoutSeconds: value.deploymentTimeoutSeconds,
      uploadLimitMiB: value.uploadLimitMiB, requestTimeoutSeconds: value.requestTimeoutSeconds, settingsRevision: value.revision };
  }
  configuration() { const { password, ...config } = this.connection(); return { ...config, password: "" }; }
  challengeUse(action, binding, context) {
    this.configuration();
    return this.approvals.challenge(action, { binding, revision: this.value.revision }, context, `${this.value.credential.username}@${this.value.host}`);
  }
  use(action, binding, context, input) {
    this.approvals.consume(action, { binding, revision: this.value.revision }, context, input);
    return this.connection();
  }
}
module.exports = { OperationsSettings, defaults, bootstrapPath, parseCredential, passwordHash, privateFile };
