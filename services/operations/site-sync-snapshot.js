"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fail = message => Object.assign(new Error(message), { status: 409 });
const exclusions = [
  "Server Settings, Admin/SSH credentials, external bootstrap and encryption keys",
  "Financial signing keys, Gold authority keys, backups, logs, test data and sync staging",
  "Target-only uploads and unrelated data are retained; target databases and selected journal directories are replaced after backup",
];
const dataDirectories = new Set(["dollar-game", "fth-ledger", "world-ledger", "file-ledgers"]);
const secret = /(?:^|\/)(?:[^/]*\.(?:pem|key|p12|pfx)|\.env(?:\.[^/]*)?|(?:game-|gold-|writer-)?signing-key(?:\.[^/]*)?|(?:private-key|secrets?|credentials?)(?:\.[^/]*)?|settings(?:\.enc)?\.json)$/i;
const excludedName = name => secret.test(name) || /^(?:data\/)?(?:operations|system-database)(?:\/|$)/i.test(name)
  || /(?:^|\/)(?:file-ledgers|daily-files)\/internal\/vault(?:\/|$)/i.test(name);
function safeName(name) {
  return typeof name === "string" && name.length <= 2048 && !name.includes("\\") && !/[\x00-\x1f:*?"<>|]/.test(name)
    && !name.startsWith("/") && !name.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" "));
}
function hash(file) {
  const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest("hex");
}
function roots(root) {
  return [["data", path.join(root, "data")], ["cms", path.join(root, "services", "cms", "data")]];
}
function inventory(root) {
  const files = [];
  for (const [kind, base] of roots(root)) {
    if (!fs.existsSync(base)) continue;
    const real = fs.realpathSync(base);
    function walk(directory, relative = "") {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!safeName(name)) throw fail("Storage contains an unsupported file name; sync was not started.");
        if (!relative && kind === "data" && !dataDirectories.has(entry.name) && !/\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(entry.name)) continue;
        if (/^(?:cms-api-test-|reserve-tests|backups|deployment|site-sync)(?:[^/]*)(?:\/|$)/.test(name)
          || excludedName(name) || /(?:\.tmp|\.part|\.lock|-shm)$/i.test(name) || /(?:^|\/)\.pending-/.test(name)) continue;
        const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw fail("Linked storage entries cannot be synced.");
        if (stat.isDirectory()) walk(file, name);
        else if (stat.isFile()) {
          files.push({ name: `${kind}/${name}`, file, bytes: stat.size, hash: hash(file) });
        } else throw fail("Unsupported storage entry; sync was not started.");
      }
    }
    walk(real);
  }
  return files;
}
function runtimePaths(root, env) {
  const defaults = {
    FTH_LEDGER_DIR: path.join(root, "data", "fth-ledger", env.FTH_LEDGER_NODE_ID || env.TOKEN_LEDGER_NODE_ID || "local-node"),
    WORLD_LEDGER_DIR: path.join(root, "data", "world-ledger", env.WORLD_LEDGER_NODE_ID || "local-world-node"),
    DOLLAR_GAME_DIR: path.join(root, "data", "dollar-game"), WORLD_DB_FILE: path.join(root, "data", "world-feed.sqlite"),
    DB_LEDGER_DIR: path.join(root, "data", "file-ledgers"), DB_WALLET_PROFILES_FILE: path.join(root, "data", "wallet-profiles.sqlite"),
  };
  const output = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const file = path.resolve(env[key] || (key === "FTH_LEDGER_DIR" ? env.TOKEN_LEDGER_DIR : "") || fallback);
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!safeName(relative) || !relative.startsWith("data/")) throw fail(`${key} is outside supported installation storage. Move it into data before syncing.`);
    const top = relative.split("/")[1];
    if (relative.split("/").length > 2 && !dataDirectories.has(top)) throw fail(`${key} uses an unsupported custom directory.`);
    output[key] = relative;
  }
  return output;
}
function snapshot(root, destination, env) {
  const runtime = runtimePaths(root, env), before = inventory(root), entries = [];
  if (!before.length) throw fail("There is no database or upload data to sync.");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const entry of before) {
    if (/-wal$|-journal$/i.test(entry.name)) continue;
    const output = path.join(destination, ...entry.name.split("/"));
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(entry.file, "r"), header = Buffer.alloc(16);
    try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (header.equals(Buffer.from("SQLite format 3\0"))) {
      const database = new DatabaseSync(entry.file, { readOnly: true });
      try {
        database.exec(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
      } finally { database.close(); }
      const check = new DatabaseSync(output, { readOnly: true });
      try { if (check.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw fail("SQLite snapshot integrity check failed."); }
      finally { check.close(); }
    } else {
      if (/\.(?:db|sqlite3?)$/i.test(entry.name)) throw fail("A database has an invalid SQLite header.");
      fs.copyFileSync(entry.file, output);
    }
    fs.chmodSync(output, 0o600);
    entries.push({ name: entry.name, bytes: fs.statSync(output).size, hash: hash(output) });
  }
  const after = inventory(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw fail("Source storage changed while taking the snapshot. No target data was changed; retry during a quiet period.");
  const journals = [runtime.FTH_LEDGER_DIR, runtime.WORLD_LEDGER_DIR, runtime.DB_LEDGER_DIR];
  const publicKeys = {};
  for (const prefix of ["FTH_LEDGER", "WORLD_LEDGER"]) {
    const privateKey = env[`${prefix}_SIGNING_PRIVATE_KEY`];
    publicKeys[prefix] = env[`${prefix}_WRITER_PUBLIC_KEY`] || (privateKey
      ? crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() : "");
  }
  const cmsDirectory = path.join(root, "services", "cms", "data");
  const manifest = { version: 1, createdAt: new Date().toISOString(), runtime, publicKeys, journals, entries,
    sourceCMS: { directory: fs.existsSync(cmsDirectory) ? fs.realpathSync(cmsDirectory) : cmsDirectory, separator: path.sep } };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}
module.exports = { snapshot, inventory, runtimePaths, hash, safeName, excludedName, exclusions };
