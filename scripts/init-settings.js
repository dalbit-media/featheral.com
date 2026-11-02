"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { OperationsSettings, bootstrapPath, passwordHash, privateFile } = require("../services/operations/settings");
const { sshTarget } = require("../services/database/ssh-target");
const { fields, environmentConfiguration, normalizeConfiguration } = require("../services/operations/configuration");
const { SystemDatabase } = require("../services/database/system");
const root = path.resolve(__dirname, "..");
function restrictWindowsFile(file) {
  if (process.platform !== "win32") return;
  const { execFileSync } = require("node:child_process");
  const account = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
  execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${account}:F`], { stdio: "pipe", windowsHide: true });
}
function initialize(file = bootstrapPath(), { repository = root } = {}) {
  if (!path.isAbsolute(file)) throw new Error("Bootstrap path must be absolute.");
  const relative = path.relative(repository, file);
  if (!relative || !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("Bootstrap must be outside the repository.");
  const keyFile = path.join(path.dirname(file), "operations.key");
  if (!fs.existsSync(file) && (fs.existsSync(path.join(repository, "data", "operations", "settings.enc.json")) || !new SystemDatabase(repository).settings().deleted))
    throw new Error("Encrypted Settings already exist. Restore their original bootstrap and encryption key.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    if (fs.existsSync(keyFile)) throw new Error("An operations key already exists without bootstrap. Restore its bootstrap; never replace the key.");
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    restrictWindowsFile(keyFile);
    fs.writeFileSync(file, JSON.stringify({ keyFile }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    restrictWindowsFile(file);
  }
  const settings = new OperationsSettings({ root: repository, bootstrapFile: file, allowLegacy: true });
  settings.key().fill(0);
  return settings;
}
function migrateEnvironment(settings, envFile = path.join(root, ".env"), { setup = false } = {}) {
  privateFile(envFile, true);
  const text = fs.readFileSync(envFile, "utf8"), env = require("node:util").parseEnv(text);
  const migrated = new Set([...fields.map(field => field.name), "ADMIN_CONFIG", "NODE_ENV", "CMS_PASSWORD", "DEPLOY_TARGET",
    "DEPLOY_PASSWORD", "DEPLOY_KEY_FILE", "DEPLOY_HOST_KEY_SHA256", "DEPLOY_TLS_EMAIL", "DEPLOY_ENABLED", "DEPLOY_PORT",
    "DB_VAULT_KEY_FILE", "SERVER_PROFILE_NETWORK_LIMIT_BPS"]);
  for (const suffix of ["MODE", "NODE_ID", "DIR", "BLOCK_INTERVAL_MS", "SYNC_INTERVAL_MS", "UPSTREAM_URL", "SIGNING_PRIVATE_KEY", "WRITER_PUBLIC_KEY"]) {
    const alias = `TOKEN_LEDGER_${suffix}`, name = `FTH_LEDGER_${suffix}`;
    migrated.add(alias);
    if (env[alias] && env[name] && env[alias] !== env[name]) throw new Error(`Conflicting ${alias} and ${name}; resolve before migration.`);
  }
  const unknown = Object.keys(env).filter(name => !migrated.has(name));
  if (unknown.length) throw new Error(`Unrecognized environment setting names: ${unknown.join(", ")}. Nothing migrated; review these before retrying.`);
  const incoming = environmentConfiguration(env);
  const adminFile = env.ADMIN_CONFIG || path.join(settings.root, "services", "cms", "admin.config.json");
  if (fs.existsSync(adminFile)) {
    if (incoming.ADMIN_CONFIG_JSON) throw new Error("Choose either ADMIN_CONFIG or ADMIN_CONFIG_JSON before migration.");
    incoming.ADMIN_CONFIG_JSON = JSON.stringify(JSON.parse(fs.readFileSync(adminFile, "utf8")));
  } else if (env.ADMIN_CONFIG) throw new Error("The existing ADMIN_CONFIG file is missing; restore it before migration.");
  if ((env.DEPLOY_PASSWORD || env.DB_VAULT_KEY_FILE) && !env.DEPLOY_TARGET && !settings.value.credential)
    throw new Error("Existing SSH credentials have no target. Restore DEPLOY_TARGET before migration.");
  for (const [name, value] of Object.entries(incoming))
    if (settings.value.runtime[name] && settings.value.runtime[name] !== value) throw new Error(`Database and environment disagree on ${name}. Resolve the conflict before migration.`);
  const next = { ...settings.value, revision: settings.value.revision + 1, runtime: normalizeConfiguration(incoming, settings.value.runtime) };
  if (!next.adminHash && !env.CMS_PASSWORD && !setup) throw new Error("Migration requires the existing CMS_PASSWORD. Use --setup for a disabled-deployment migration followed by localhost Admin enrollment.");
  if (env.CMS_PASSWORD) {
    if (next.adminHash && !settings.authenticate(env.CMS_PASSWORD)) throw new Error("Admin passwords disagree. Resolve the conflict before migration.");
    next.adminHash = passwordHash(env.CMS_PASSWORD);
  }
  if (env.DEPLOY_KEY_FILE && !setup) throw new Error("SSH key authentication is not migrated to a password. Use --setup to archive legacy configuration and enroll a replacement credential from localhost; the environment file was not changed.");
  if (env.DEPLOY_TARGET) {
    const target = sshTarget(env, { allowUnpinned: setup && !env.DEPLOY_PASSWORD && !env.DB_VAULT_KEY_FILE && !settings.value.credential });
    if (settings.value.credential && (settings.value.host !== target.host || settings.value.port !== target.port
      || settings.value.directory !== target.directory || settings.value.fingerprint !== target.fingerprint
      || settings.value.credential.username !== target.username || env.DEPLOY_PASSWORD && settings.value.credential.password !== env.DEPLOY_PASSWORD))
      throw new Error("Database and environment SSH targets disagree. Resolve the conflict before migration.");
    Object.assign(next, { host: target.host, port: target.port, directory: target.directory, fingerprint: target.fingerprint });
    if (env.DEPLOY_PASSWORD) next.credential = { username: target.username, password: env.DEPLOY_PASSWORD };
    else if (env.DB_VAULT_KEY_FILE) {
      const { FileJournals } = require("../services/database/journal");
      const { CredentialVault } = require("../services/database/vault");
      const journals = new FileJournals(fs.realpathSync(path.resolve(env.DB_LEDGER_DIR || path.join(settings.root, "data", "file-ledgers"))));
      const vault = new CredentialVault({ journals, env, repository: settings.root });
      vault.configuration();
      const entry = vault.stored(), key = vault.key();
      try {
        const cipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.value.iv, "hex"));
        cipher.setAAD(Buffer.from(require("../services/fth-ledger/codec").canonical({ version: 1, target: vault.target(), revision: entry.revision })));
        cipher.setAuthTag(Buffer.from(entry.value.tag, "hex"));
        const bytes = Buffer.concat([cipher.update(Buffer.from(entry.value.ciphertext, "hex")), cipher.final()]);
        try { next.credential = { username: target.username, password: bytes.toString("utf8") }; } finally { bytes.fill(0); }
      } finally { key.fill(0); }
    }
  }
  next.tlsEmail = env.DEPLOY_TLS_EMAIL || next.tlsEmail;
  next.networkLimitBytesPerSecond = Number(env.SERVER_PROFILE_NETWORK_LIMIT_BPS || next.networkLimitBytesPerSecond);
  next.enabled = false;
  if (setup && !next.adminHash && !["127.0.0.1", "::1", "localhost"].includes(next.runtime.HOST || "127.0.0.1"))
    throw new Error("First-run setup requires a loopback HOST. Change the legacy HOST to 127.0.0.1 before migration.");
  const settingsInput = Object.fromEntries(Object.keys(require("../services/operations/settings").defaults).map(name => [name, next[name]]));
  if (env.CMS_PASSWORD) settingsInput.adminPassword = env.CMS_PASSWORD;
  if (next.credential) settingsInput.credential = `${next.credential.username}:${next.credential.password}`;
  settings.prepare({ revision: settings.value.revision, settings: settingsInput }, { allowUnconfiguredAdmin: setup });
  const backupDirectory = path.join(path.dirname(settings.bootstrapFile), "migration-backups");
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const backupFile = path.join(backupDirectory, `legacy-${crypto.randomUUID()}.enc.json`);
  const key = settings.key(), iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("featheral-legacy-migration-v1"));
    const plain = Buffer.from(JSON.stringify({ envFile, environment: text,
      adminFile: fs.existsSync(adminFile) ? { path: adminFile, content: fs.readFileSync(adminFile, "utf8") } : null }));
    let ciphertext;
    try { ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]); } finally { plain.fill(0); }
    const fd = fs.openSync(backupFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    restrictWindowsFile(backupFile);
  } finally { key.fill(0); }
  settings.persist(next);
  const restored = new OperationsSettings({ root: settings.root, bootstrapFile: settings.bootstrapFile });
  if (JSON.stringify(restored.value) !== JSON.stringify(next)) throw new Error("System database read-back failed; original configuration files were kept.");
  try {
    fs.rmSync(envFile);
    if (fs.existsSync(adminFile)) fs.rmSync(adminFile);
  } catch {
    throw new Error("Settings were verified in the database, but legacy file cleanup failed. Remove the migrated .env/admin config before restarting.");
  }
  return { backupFile, setupRequired: !next.adminHash, credentialEnrollmentRequired: Boolean(env.DEPLOY_KEY_FILE && !next.credential),
    fingerprintEnrollmentRequired: Boolean(env.DEPLOY_TARGET && !next.fingerprint) };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let file = bootstrapPath(), envFile = path.join(root, ".env");
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--bootstrap-file" || arg === "--env-file") {
        const value = args[++index];
        if (!value || !path.isAbsolute(value)) throw new Error(`${arg} requires an absolute path.`);
        if (arg === "--bootstrap-file") file = value; else envFile = value;
      } else if (!arg.startsWith("--")) file = arg;
      else if (!["--migrate-settings", "--migrate-env", "--setup"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    }
    if (args.includes("--setup") && !args.includes("--migrate-env")) throw new Error("--setup requires --migrate-env.");
    const settings = initialize(file);
    if (args.includes("--migrate-settings")) settings.migrateLegacy();
    else if (fs.existsSync(settings.file)) throw new Error("Use --migrate-settings to move existing encrypted Settings to the system database.");
    const migration = args.includes("--migrate-env") ? migrateEnvironment(settings, envFile, { setup: args.includes("--setup") }) : null;
    console.log("External bootstrap initialized. Keep the key separately backed up. Newly created Windows bootstrap/key files are restricted to the current account; existing files must also have service-account-only ACLs.");
    console.log(args.includes("--migrate-env") ? "Runtime settings verified in the system database; legacy files removed. Deployment remains disabled pending review." : "Open Admin Settings on localhost, set Admin access, and sign with the origin wallet.");
    if (migration) {
      console.log("Encrypted legacy configuration backup:", migration.backupFile);
      if (migration.setupRequired) console.log(`Start the service on loopback, then open http://admin.localhost:${settings.environment().PORT || "8080"}/#/settings and enroll an Admin password with origin-wallet approval.`);
      if (migration.credentialEnrollmentRequired) console.log("Legacy SSH key authentication was archived, not converted. Set and verify username:password in Settings before enabling deployment. The original SSH key file is unchanged.");
      if (migration.fingerprintEnrollmentRequired) console.log("The legacy SSH fingerprint was missing or invalid and is only in the encrypted backup. Set an independently verified SHA256 host fingerprint in Settings; deployment remains disabled.");
    }
  } catch (error) { console.error("Settings initialization failed:", error.message); process.exitCode = 1; }
}
module.exports = { initialize, migrateEnvironment };
