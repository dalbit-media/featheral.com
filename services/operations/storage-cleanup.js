"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const DAY = 24 * 60 * 60 * 1000;
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const uuid = new RegExp(`^${UUID}$`);
const archive = new RegExp(`^${UUID}\\.zip(?:\\.sh)?$`);

function read(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function measure(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1)
    throw new Error(`Refusing linked cleanup entry: ${file}`);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported cleanup entry: ${file}`);
  const result = { bytes: stat.isFile() ? stat.size : 0, modified: stat.mtimeMs };
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) {
    const child = measure(path.join(file, name));
    result.bytes += child.bytes;
    result.modified = Math.max(result.modified, child.modified);
  }
  return result;
}

function managedShared(root) {
  if (path.basename(path.dirname(root)) !== "releases") return null;
  const base = path.dirname(path.dirname(root)), current = path.join(base, "current");
  if (!fs.existsSync(current) || fs.realpathSync(current) !== fs.realpathSync(root)) return null;
  return path.join(base, "shared");
}

function operationActive(root, command = spawnSync) {
  const shared = managedShared(root);
  if (!shared) return false;
  if (fs.existsSync(path.join(shared, "site-sync.lock"))) return true;
  for (const unit of ["featheral-deployment.service", "featheral-site-sync.service"]) {
    const result = command("systemctl", ["show", unit, "--property=ActiveState", "--value"], { encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0 || !["inactive", "failed", "active", "activating", "deactivating", "reloading"].includes(result.stdout.trim()))
      throw new Error(`Cannot verify ${unit}; storage maintenance refused.`);
    if (!["inactive", "failed"].includes(result.stdout.trim())) return true;
  }
  return false;
}

function cleanupStorage({ root, apply = false, now = Date.now(), minAgeMs = DAY,
  deployment, siteSync, busy = () => false, command } = {}) {
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) throw new Error("Invalid temporary-work retention");
  root = path.resolve(root);
  const report = { applied: apply, blocked: false, removedBytes: 0, candidates: [], skipped: [] };
  if (busy() || deployment?.running || siteSync?.running || operationActive(root, command)) {
    report.blocked = true;
    report.skipped.push({ reason: "A server operation is active" });
    return report;
  }
  const deploymentBase = deployment?.stateDirectory || path.join(root, "data", "deployment");
  const syncBase = siteSync?.directory || path.join(root, "data", "site-sync");
  const deploymentState = read(path.join(deploymentBase, "status.json"));
  const syncState = read(path.join(syncBase, "status.json"));
  for (const state of [deploymentState, syncState])
    if (state !== null && typeof state.running !== "boolean") throw new Error("Invalid saved operation status; cleanup refused");
  const protectedSync = new Set(siteSync?.plans?.keys() || []);
  const syncUnconfirmed = syncState && !["idle", "complete", "not-applied", "review-ready", "rolled-back"].includes(syncState.phase);
  if (syncUnconfirmed && syncState.id) protectedSync.add(syncState.id);

  const scan = (base, eligible) => {
    if (!fs.existsSync(base)) return;
    if (fs.lstatSync(base).isSymbolicLink()) throw new Error(`Refusing linked staging directory: ${base}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!eligible(entry)) continue;
      const file = path.join(base, entry.name);
      const size = measure(file);
      if (minAgeMs > 0 && now - size.modified < minAgeMs) continue;
      report.candidates.push({ path: file, bytes: size.bytes });
      if (apply) {
        fs.rmSync(file, { recursive: entry.isDirectory(), force: false });
        report.removedBytes += size.bytes;
      }
    }
  };
  if (deploymentState?.running) report.skipped.push({ path: deploymentBase, reason: "Saved deployment is still running" });
  else scan(deploymentBase, entry => entry.isDirectory() && uuid.test(entry.name) || entry.isFile() && archive.test(entry.name));
  if (syncState?.running || syncUnconfirmed && !syncState.id)
    report.skipped.push({ path: syncBase, reason: "Sync state requires review" });
  else scan(syncBase, entry => entry.isDirectory() && uuid.test(entry.name) && !protectedSync.has(entry.name));

  const shared = managedShared(root);
  if (shared) {
    if (fs.existsSync(path.join(shared, "site-sync.lock"))) {
      report.skipped.push({ path: shared, reason: "Target sync lock requires completion or recovery" });
      return report;
    }
    scan(path.join(shared, "deployment"), entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
      && read(path.join(shared, "deployment", entry.name, "cleanup-complete.json"))?.complete === true);
    scan(path.join(shared, "deployment"), entry => entry.isDirectory() && /^provision-release-\d+-[a-f0-9]{12}$/.test(entry.name));
    scan(path.join(shared, "site-sync"), entry => entry.isDirectory() && uuid.test(entry.name)
      && read(path.join(shared, "sync-backups", entry.name, "state.json"))?.phase === "complete");
    const self = path.join(shared, "self-deployment"), state = read(path.join(self, "status.json"));
    if (state?.running || state?.phase === "running") report.skipped.push({ path: self, reason: "Self deployment is active" });
    else scan(self, entry => entry.isDirectory() && uuid.test(entry.name));
  }
  return report;
}

function startStorageMaintenance(root) {
  const run = () => {
    try {
      const report = cleanupStorage({ root, apply: true });
      if (report.candidates.length) console.info(`Storage maintenance removed ${report.candidates.length} temporary entries (${report.removedBytes} bytes).`);
    } catch (error) { console.error("Storage maintenance failed:", error); }
  };
  const initial = setTimeout(run, 60000), timer = setInterval(run, 60 * 60 * 1000);
  initial.unref(); timer.unref();
  return { close() { clearTimeout(initial); clearInterval(timer); } };
}

module.exports = { cleanupStorage, managedShared, operationActive, startStorageMaintenance, DAY };
