"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
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
function probeReplica(url, { requireReplica = true, expectedRelease } = {}) {
  return new Promise((resolve, reject) => {
    // Use server-side HTTP, without fetch's browser-only restricted-port rules.
    const request = http.get(url, { agent: false }, response => {
      response.once("error", reject);
      let data = "";
      response.on("data", chunk => {
        if (Buffer.byteLength(data) + chunk.length > 16384) return request.destroy(new Error("Gateway health response exceeds 16 KiB."));
        data += chunk.toString("utf8");
      });
      const replica = response.headers["x-featheral-replica"];
      response.once("end", () => {
        if (response.statusCode !== 200 || requireReplica && replica !== "read-only")
          return reject(new Error(`HTTP ${response.statusCode}; X-Featheral-Replica: ${replica || "missing"}`));
        if (expectedRelease) {
          let health;
          try { health = JSON.parse(data); }
          catch (error) { return reject(new Error("Gateway health returned invalid JSON.", { cause: error })); }
          if (!health || health.status !== "ok" || health.release !== expectedRelease) return reject(new Error("Gateway health release identity does not match the restored release."));
          if (!requireReplica && replica === "read-only") return reject(new Error("Restored writer gateway unexpectedly reports read-only replica mode."));
        }
        resolve();
      });
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
function probeTargetSite(hostname, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname, path: pathname, method, agent: false,
      headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4) }, response => {
      let body = "";
      response.once("error", reject);
      response.on("data", chunk => {
        if (pathname === "/") return;
        if (Buffer.byteLength(body) + chunk.length > 16384) {
          request.destroy(new Error("Site API health response exceeds 16 KiB.")); return;
        }
        body += chunk.toString("utf8");
      });
      response.once("end", () => resolve({ status: response.statusCode,
        replica: response.headers["x-featheral-replica"], body }));
    });
    const timer = setTimeout(() => request.destroy(new Error("Site HTTPS check timed out after 5000 ms.")), 5000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
    request.end(body);
  });
}
async function checkTargetSites(root, hosts, { probe = probeTargetSite, requireReplica = false, log = console.log } = {}) {
  assert(Array.isArray(hosts) && hosts.length && hosts.every(host => typeof host === "string"
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)), "Invalid sync target hostnames.");
  const release = fs.realpathSync(path.join(root, "current"));
  const manifestFile = path.join(release, ".deployment-hosts.json");
  assert(fs.existsSync(manifestFile), "Deploy the current release from Admin Settings before syncing; the target has no deployment host assignment.");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert(Array.isArray(manifest.hosts), "Invalid target deployment host assignment. Review and deploy the current release before syncing.");
  const missing = hosts.filter(host => !manifest.hosts.includes(host));
  assert(!missing.length, `Deploy the current release before syncing. Target deployment is missing assigned sites: ${missing.join(", ")}. Save server assignments, point DNS to the target, then run Review release in Admin Settings.`);
  for (const host of hosts) {
    try {
      const result = await probe(host, "/");
      assert(result.status === 200 || host === "admin.featheral.com" && result.status === 401,
        `HTTP ${result.status}; expected 200${host === "admin.featheral.com" ? " or 401" : ""}.`);
      if (requireReplica) assert(result.replica === "read-only", "Site did not report read-only replica mode.");
      if (host === "pay.featheral.com") {
        const to = "0x0000000000000000000000000000000000000001";
        for (const method of ["GET", "POST"]) {
          const payment = await probe(host, `/api/v1/pay/requests${method === "GET" ? `?to=${to}` : ""}`,
            { method, ...(method === "POST" ? { body: JSON.stringify({ to }) } : {}) });
          assert(payment.status === 200, `Payment request API ${method} returned HTTP ${payment.status}.`);
          if (requireReplica) assert(payment.replica === "read-only", "Payment API did not report read-only replica mode.");
          const data = JSON.parse(payment.body);
          assert(data?.schema === "featheral.pay" && data.version === 1 && data.currency === "FTH$"
            && new URL(data.paymentUrl).origin === `https://${host}`, "Target does not serve the expected Featheral Pay API.");
        }
      }
      log(`Site sync readiness: ${host} HTTPS and application routes verified${requireReplica ? " (read-only)" : ""}.`);
    } catch (error) {
      throw new Error(`Site setup is not ready for ${host}: ${error.message} Review and deploy the current release in Admin Settings; check DNS, Nginx and TLS before retrying sync.`, { cause: error });
    }
  }
}
async function run(root, snapshotDirectory, backupDirectory, sourceId, hosts) {
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
  await checkTargetSites(root, hosts);
  verifySnapshot(snapshotDirectory, { retainedRoot: release });
  console.log("Snapshot checksums and database integrity verified.");
  const apps = JSON.parse(command("jlist")).filter(app => app.name === "featheral");
  assert(apps.length === 1 && apps[0].pm2_env.status === "online", "The target Featheral application must be online before sync.");
  assert(fs.realpathSync(apps[0].pm2_env.pm_cwd) === release, "PM2 is not running this target's current release. Deploy or repair it before syncing.");
  process.env.FEATHERAL_BOOTSTRAP_FILE = path.join(root, "shared", "bootstrap", "bootstrap.json");
  const { OperationsSettings } = require(path.join(release, "services", "operations", "settings"));
  const healthURL = replicaHealthURL(new OperationsSettings({ root: release }).environment());
  const wasReplica = Boolean(readReplica(release));
  const verifyRestored = async () => {
    await waitForReplica(healthURL, { probe: url => probeReplica(url, { requireReplica: wasReplica, expectedRelease: path.basename(release) }) });
    await checkTargetSites(root, hosts, { requireReplica: wasReplica });
  };
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
    await checkTargetSites(root, hosts, { requireReplica: true });
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
      await verifyRestored();
      rollbackConfirmed = true;
      console.log("Previous target state restored; gateway identity and assigned HTTPS health confirmed.");
      if (prepared) {
        prepared.state.phase = "rolled-back";
        fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(prepared.state), { mode: 0o600, flush: true });
        console.log("FEATHERAL_SYNC:rollback-complete");
      }
    }
    throw error;
  } finally {
    if (!stopped || prepared?.state.phase === "complete" || rollbackConfirmed) fs.unlinkSync(lock);
    if (prepared?.state.phase === "complete" || rollbackConfirmed) {
      try {
        const { cleanupStorage } = require("../services/operations/storage-cleanup");
        const report = cleanupStorage({ root: release, apply: true, minAgeMs: 0,
          discardCompletedBackups: true, operationCleanup: true });
        console.log("Verified target sync cleanup:", JSON.stringify(report));
        if (report.blocked) throw new Error("Target cleanup was blocked by another operation.");
      } catch (error) {
        console.error("Verified sync cleanup failed; installation/recovery remains confirmed:", error.message);
      }
    }
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
  process.env.FEATHERAL_BOOTSTRAP_FILE = path.join(root, "shared", "bootstrap", "bootstrap.json");
  const { OperationsSettings } = require(path.join(release, "services", "operations", "settings"));
  const url = replicaHealthURL(new OperationsSettings({ root: release }).environment());
  await waitForReplica(url, { probe: url => probeReplica(url, { requireReplica: Boolean(readReplica(release)), expectedRelease: path.basename(release) }) });
  const assignment = JSON.parse(fs.readFileSync(path.join(release, ".deployment-hosts.json"), "utf8"));
  await checkTargetSites(root, assignment.hosts, { requireReplica: Boolean(readReplica(release)) });
  state.phase = "rolled-back";
  fs.writeFileSync(path.join(backupDirectory, "state.json"), JSON.stringify(state), { mode: 0o600, flush: true });
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  console.log("Verified backup restored; gateway identity and assigned HTTPS health confirmed.");
}
if (require.main === module) {
  const operation = (async () => {
    if (process.argv[2] === "--recover") return recover(...process.argv.slice(3));
    if (process.argv[2] === "--check-sites") return checkTargetSites(process.argv[3], JSON.parse(process.argv[4]));
    return run(...process.argv.slice(2, 6), JSON.parse(process.argv[6]));
  })();
  operation.catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifySnapshot, prepareBackup, installSnapshot, restoreBackup, returnStaged, targetRoots,
  replicaHealthURL, probeReplica, waitForReplica, probeTargetSite, checkTargetSites, run };
