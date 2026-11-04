"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { hash, safeName, excludedName } = require("../services/operations/site-sync-snapshot");
const { MARKER, readReplica } = require("../services/operations/replica");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function within(base, name) {
  assert(safeName(name), "Invalid snapshot path.");
  let current = base;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), "Linked target storage is not supported.");
  }
  return current;
}
function targetRoots(root) {
  return Object.fromEntries([["data", path.join(root, "data")], ["cms", path.join(root, "services", "cms", "data")]]
    .map(([key, directory]) => { assert(fs.existsSync(directory), "Deploy the target installation first."); return [key, fs.realpathSync(directory)]; }));
}
function destination(roots, name) {
  const [kind, ...parts] = name.split("/");
  assert(roots[kind] && parts.length, "Invalid storage root.");
  return within(roots[kind], parts.join("/"));
}
function verifySnapshot(directory, { retainedRoot } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert(manifest.version === 1 && Array.isArray(manifest.entries) && manifest.entries.length, "Invalid snapshot manifest.");
  const names = new Set();
  for (const entry of manifest.entries) {
    assert(safeName(entry.name) && /^(?:data|cms)\//.test(entry.name) && !names.has(entry.name)
      && !excludedName(entry.name) && !/(?:-wal|-shm|-journal)$/i.test(entry.name),
    "Unsupported or secret snapshot entry.");
    let file;
    if (entry.retained === true) {
      assert(retainedRoot && readReplica(retainedRoot), "Retained snapshot files require an explicitly selected read-only target.");
      file = destination(targetRoots(retainedRoot), entry.name);
    } else {
      assert(entry.retained === undefined, "Invalid retained snapshot entry.");
      file = within(directory, entry.name);
    }
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.nlink === 1 && stat.size === entry.bytes && hash(file) === entry.hash, "Snapshot checksum mismatch.");
    if (/\.(?:sqlite3?|db)$/i.test(entry.name)) {
      const database = new DatabaseSync(file, { readOnly: true });
      try { assert(database.prepare("PRAGMA quick_check").get().quick_check === "ok", "Snapshot database integrity check failed."); }
      finally { database.close(); }
    }
    names.add(entry.name);
  }
  assert(manifest.sourceCMS && ["\\", "/"].includes(manifest.sourceCMS.separator)
    && typeof manifest.sourceCMS.directory === "string", "Missing CMS namespace identity.");
  assert(manifest.runtime && Object.values(manifest.runtime).every(value => safeName(value) && value.startsWith("data/")), "Invalid replica storage configuration.");
  return manifest;
}
function copyVerified(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  assert(hash(source) === hash(target), "Storage copy verification failed.");
  const fd = fs.openSync(target, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function sameDevice(file, directory) {
  let current = directory;
  while (!fs.existsSync(current)) current = path.dirname(current);
  return fs.statSync(file).dev === fs.statSync(current).dev;
}
// Same-filesystem moves need no extra space; a cross-device move copies, verifies and then removes the source.
function moveVerified(source, target, digest) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try { fs.renameSync(source, target); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    const temporary = `${target}.sync-${process.pid}`;
    copyVerified(source, temporary);
    fs.renameSync(temporary, target);
    fs.unlinkSync(source);
  }
  fs.chmodSync(target, 0o600);
  if (digest) assert(hash(target) === digest, "Storage move verification failed.");
}
// Backups hard-link the old inode when possible; installs replace targets by rename, so the backup is never modified.
function linkBackup(source, backup) {
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  try { fs.linkSync(source, backup); }
  catch (error) { if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error; copyVerified(source, backup); }
}
function writeReplace(file, content) {
  const temporary = `${file}.sync-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flush: true });
  fs.renameSync(temporary, file);
}
function journalFiles(directory, relative = "") {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (excludedName(name) || /(?:^|\/)(?:internal|system)(?:\/|$)/i.test(name)) continue;
    assert(!entry.isSymbolicLink(), "Linked journal storage is not supported.");
    if (entry.isDirectory()) files.push(...journalFiles(path.join(directory, entry.name), name));
    else if (/\/\d{4}-\d{2}-\d{2}\.jsonl$|\/\d{16}\.json$/.test(name)) files.push(name);
  }
  return files;
}
function prepareBackup(root, snapshotDirectory, backupDirectory) {
  const manifest = verifySnapshot(snapshotDirectory, { retainedRoot: root }), roots = targetRoots(root), touched = new Set(manifest.entries.map(entry => entry.name));
  for (const key of ["FTH_LEDGER_DIR", "WORLD_LEDGER_DIR", "DB_LEDGER_DIR"]) {
    const name = manifest.runtime[key];
    assert(name && name.startsWith("data/"), "Missing journal root.");
    for (const file of journalFiles(destination(roots, name))) touched.add(`${name}/${file}`);
  }
  const cmsDaily = new Set(manifest.entries.map(entry => /^(cms\/.*?\/daily-files)\//.exec(entry.name)?.[1]).filter(Boolean));
  for (const directory of cmsDaily) for (const file of journalFiles(destination(roots, directory))) touched.add(`${directory}/${file}`);
  for (const entry of manifest.entries) if (/\.(?:db|sqlite3?)$/i.test(entry.name))
    for (const suffix of ["-wal", "-shm", "-journal"]) touched.add(entry.name + suffix);
  touched.add(`data/${MARKER}`);
  const entries = new Map(manifest.entries.map(entry => [entry.name, entry]));
  const backupParent = path.dirname(backupDirectory), unchanged = new Set(), required = new Map();
  const reserve = (directory, bytes) => {
    const device = fs.statSync(directory).dev;
    const current = required.get(device) || { directory, bytes: 64 * 1024 * 1024 };
    current.bytes += bytes; required.set(device, current);
  };
  reserve(backupParent, 0);
  for (const name of touched) {
    const file = destination(roots, name), entry = entries.get(name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.nlink === 1, "Target storage contains an unsupported file.");
    if (entry && stat.size === entry.bytes && hash(file) === entry.hash) { unchanged.add(name); continue; }
    if (!sameDevice(file, backupParent)) reserve(backupParent, stat.size);
  }
  let largest = 0;
  for (const entry of manifest.entries) {
    if (unchanged.has(entry.name)) continue;
    const target = destination(roots, entry.name), staged = within(snapshotDirectory, entry.name);
    let parent = path.dirname(target);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!sameDevice(staged, parent)) reserve(parent, entry.bytes);
    largest = Math.max(largest, entry.bytes);
  }
  // A rollback restores one file at a time through a temporary copy.
  for (const directory of Object.values(roots)) reserve(directory, 0);
  for (const { directory, bytes } of required.values()) {
    const disk = fs.statfsSync(directory, { bigint: true });
    assert(disk.bavail * disk.bsize >= BigInt(bytes + largest),
      "Insufficient target space for the measured rollback backup and installation. No target records were replaced.");
  }
  fs.mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
  const records = [];
  for (const name of touched) {
    if (unchanged.has(name)) { records.push({ name, unchanged: true }); continue; }
    const file = destination(roots, name);
    if (fs.existsSync(file)) {
      const backup = path.join(backupDirectory, ...name.split("/"));
      linkBackup(file, backup);
      records.push({ name, existed: true, hash: hash(backup) });
    } else records.push({ name, existed: false });
  }
  const state = { version: 1, phase: "backed-up", records };
  fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(state), { flag: "wx", mode: 0o600, flush: true });
  return { manifest, roots, state };
}
function restoreBackup(roots, backupDirectory, state) {
  for (const record of state.records) if (record.existed)
    assert(hash(within(backupDirectory, record.name)) === record.hash, "Backup checksum mismatch. Keep the target stopped.");
  for (const record of state.records) {
    if (record.unchanged) continue;
    const target = destination(roots, record.name);
    if (record.existed) {
      const temporary = `${target}.sync-${process.pid}`;
      copyVerified(within(backupDirectory, record.name), temporary);
      fs.renameSync(temporary, target);
    } else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}
// Move installed files back into staging before rollback so a retry reuses the uploaded bytes.
function returnStaged(prepared, snapshotDirectory) {
  const unchanged = new Set(prepared.state.records.filter(record => record.unchanged).map(record => record.name));
  for (const entry of prepared.manifest.entries) {
    if (unchanged.has(entry.name)) continue;
    const staged = within(snapshotDirectory, entry.name), target = destination(prepared.roots, entry.name);
    if (fs.existsSync(staged) || !fs.existsSync(target) || hash(target) !== entry.hash) continue;
    try { moveVerified(target, staged, entry.hash); } catch (error) { console.error("Could not return staged file:", entry.name, error.message); }
  }
}
function installSnapshot(root, snapshotDirectory, backupDirectory, prepared) {
  const { manifest, roots, state } = prepared || prepareBackup(root, snapshotDirectory, backupDirectory);
  const unchanged = new Set(state.records.filter(record => record.unchanged).map(record => record.name));
  const changed = manifest.entries.filter(entry => !unchanged.has(entry.name));
  for (const entry of changed) assert(hash(within(snapshotDirectory, entry.name)) === entry.hash, "Snapshot changed after backup; target was not changed.");
  state.phase = "installing";
  fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(state), { mode: 0o600, flush: true });
  const names = new Set(manifest.entries.map(entry => entry.name));
  for (const record of state.records) {
    if (record.unchanged || record.name === `data/${MARKER}` || names.has(record.name)) continue;
    const target = destination(roots, record.name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  for (const entry of changed) moveVerified(within(snapshotDirectory, entry.name), destination(roots, entry.name), entry.hash);
  const marker = { version: 1, readOnly: true, syncedAt: manifest.createdAt, runtime: manifest.runtime,
    publicKeys: manifest.publicKeys, sourceCMS: manifest.sourceCMS };
  writeReplace(path.join(roots.data, MARKER), JSON.stringify(marker));
  return { manifest, roots, state };
}
function replicaHealthURL(environment) {
  const host = environment.HOST || "127.0.0.1", port = Number(environment.PORT || 8080);
  assert(["127.0.0.1", "localhost", "0.0.0.0", "::", "::1"].includes(host), "Sync requires a local or wildcard HTTP host.");
  assert(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid target HTTP port.");
  return `http://${host.includes(":") ? "[::1]" : host === "localhost" ? "localhost" : "127.0.0.1"}:${port}/healthz`;
}
function probeReplica(url) {
  return new Promise((resolve, reject) => {
    // Use server-side HTTP, without fetch's browser-only restricted-port rules.
    const request = http.get(url, { agent: false }, response => {
      response.once("error", reject);
      response.resume();
      const replica = response.headers["x-featheral-replica"];
      if (response.statusCode === 200 && replica === "read-only") resolve();
      else reject(new Error(`HTTP ${response.statusCode}; X-Featheral-Replica: ${replica || "missing"}`));
    });
    const timer = setTimeout(() => request.destroy(new Error("Health request timed out after 3000 ms.")), 3000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
  });
}
async function waitForReplica(url, { probe = probeReplica, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  let failure;
  for (let attempt = 1; attempt <= 60; attempt++) {
    log(`Read-only health check ${attempt}/60: ${url}`);
    try { await probe(url); return; }
    catch (error) {
      failure = error;
      log(`Replica health probe failed: ${error.code ? `${error.code}: ` : ""}${error.message}`);
    }
    if (attempt < 60) await wait(2000);
  }
  throw new Error(`Read-only replica did not pass health verification at ${url}: ${failure.message}`, { cause: failure });
}
function logApplicationOutput(root) {
  const directory = path.join(root, "shared", "logs");
  const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^(?:error|app)(?:-\d+)?\.log$/.test(name)) : [];
  if (!names.length) console.error("Application logs are unavailable.");
  for (const name of names) {
    const file = path.join(root, "shared", "logs", name);
    if (!fs.existsSync(file)) { console.error(`--- ${name} is unavailable ---`); continue; }
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 65536));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      console.error(`--- ${name} (last 64 KiB, up to 80 lines) ---`);
      console.error(buffer.subarray(0, bytes).toString("utf8").split("\n").slice(-80).join("\n"));
    } finally { fs.closeSync(fd); }
  }
}
async function run(root, snapshotDirectory, backupDirectory, sourceId) {
  assert(process.platform === "linux", "The sync receiver requires the Linux deployment layout.");
  const release = fs.realpathSync(path.join(root, "current"));
  const roots = targetRoots(release);
  const identity = path.join(roots.data, "site-sync", "source-id");
  assert(!fs.existsSync(identity) || fs.readFileSync(identity, "utf8") !== sourceId, "Refusing to overwrite the running source installation.");
  const pm2 = path.join(root, "shared", "tools", "node_modules", ".bin", "pm2");
  const command = (...args) => {
    const result = spawnSync(pm2, args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    assert(!result.error && result.status === 0, "PM2 operation failed. Inspect the target before retrying.");
    return result.stdout;
  };
  for (const file of ["services/operations/replica.js", "services/database/sqlite.js", "services/database/journal.js"])
    assert(fs.readFileSync(path.join(release, file), "utf8").includes("replica"), "Deploy the sync-capable release to the target first.");
  verifySnapshot(snapshotDirectory, { retainedRoot: release });
  console.log("Snapshot checksums and database integrity verified.");
  const apps = JSON.parse(command("jlist")).filter(app => app.name === "featheral");
  assert(apps.length === 1 && apps[0].pm2_env.status === "online", "The target Featheral application must be online before sync.");
  assert(fs.realpathSync(apps[0].pm2_env.pm_cwd) === release, "PM2 is not running this target's current release. Deploy or repair it before syncing.");
  process.env.FEATHERAL_BOOTSTRAP_FILE = path.join(root, "shared", "bootstrap", "bootstrap.json");
  const { OperationsSettings } = require(path.join(release, "services", "operations", "settings"));
  const healthURL = replicaHealthURL(new OperationsSettings({ root: release }).environment());
  const lock = path.join(root, "shared", "site-sync.lock");
  fs.writeFileSync(lock, backupDirectory, { flag: "wx", mode: 0o600 });
  let prepared, stopped = false, started = false, rollbackConfirmed = false;
  try {
    console.log("FEATHERAL_SYNC:stop");
    command("stop", "featheral"); stopped = true;
    console.log("FEATHERAL_SYNC:backup");
    prepared = prepareBackup(release, snapshotDirectory, backupDirectory);
    console.log(`Verified backup ready: ${prepared.state.records.length} affected files.`);
    console.log("FEATHERAL_SYNC:install");
    installSnapshot(release, snapshotDirectory, backupDirectory, prepared);
    console.log("FEATHERAL_SYNC:restart");
    command("restart", "featheral"); started = true;
    console.log("FEATHERAL_SYNC:health");
    await waitForReplica(healthURL);
    prepared.state.phase = "complete";
    fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(prepared.state), { mode: 0o600, flush: true });
    console.log("Snapshot installed; read-only health confirmed. Verified backup:", backupDirectory);
  } catch (error) {
    console.error("Sync failed:", error.message);
    if (started) {
      try { logApplicationOutput(root); }
      catch (diagnosticError) { console.error("Could not read application diagnostics:", diagnosticError.message); }
    }
    if (stopped) {
      console.log("FEATHERAL_SYNC:rollback");
      if (started) command("stop", "featheral");
      if (prepared) { returnStaged(prepared, snapshotDirectory); restoreBackup(prepared.roots, backupDirectory, prepared.state); }
      command("restart", "featheral");
      rollbackConfirmed = true;
      console.log("Previous target state restored and application restarted.");
      if (prepared) {
        prepared.state.phase = "rolled-back";
        fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(prepared.state), { mode: 0o600, flush: true });
        console.log("FEATHERAL_SYNC:rollback-complete");
      }
    }
    throw error;
  } finally {
    if (!stopped || prepared?.state.phase === "complete" || rollbackConfirmed) fs.unlinkSync(lock);
  }
}
async function recover(root, backupDirectory) {
  assert(process.platform === "linux", "The sync receiver requires the Linux deployment layout.");
  const release = fs.realpathSync(path.join(root, "current")), roots = targetRoots(release);
  const expected = path.join(root, "shared", "sync-backups");
  assert(path.dirname(path.resolve(backupDirectory)) === path.resolve(expected), "Choose a specific backup under shared/sync-backups.");
  const state = JSON.parse(fs.readFileSync(path.join(backupDirectory, "state.json"), "utf8"));
  assert(state.version === 1 && Array.isArray(state.records), "Invalid backup state.");
  const active = spawnSync("systemctl", ["is-active", "--quiet", "featheral-site-sync.service"]);
  assert(!active.error && active.status !== 0, "Wait for or stop the active sync job before offline recovery.");
  const lock = path.join(root, "shared", "site-sync.lock");
  assert(!fs.existsSync(lock) || fs.readFileSync(lock, "utf8") === backupDirectory, "A different sync owns the target lock.");
  const pm2 = path.join(root, "shared", "tools", "node_modules", ".bin", "pm2");
  const command = (...args) => {
    const result = spawnSync(pm2, args, { stdio: "inherit", timeout: 60000 });
    assert(!result.error && result.status === 0, "PM2 recovery operation failed. Keep the target stopped.");
  };
  command("stop", "featheral");
  restoreBackup(roots, backupDirectory, state);
  command("restart", "featheral");
  state.phase = "rolled-back";
  fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(state), { mode: 0o600, flush: true });
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  console.log("Verified backup restored. Check application health before enabling writes.");
}
if (require.main === module) {
  const operation = process.argv[2] === "--recover" ? recover(...process.argv.slice(3)) : run(...process.argv.slice(2));
  operation.catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifySnapshot, prepareBackup, installSnapshot, restoreBackup, returnStaged, targetRoots,
  replicaHealthURL, probeReplica, waitForReplica, run };
