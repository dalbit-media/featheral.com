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
  deployment, siteSync, busy = () => false, command, discardCompletedBackups = false, discardOldReleases = false, operationCleanup = false } = {}) {
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) throw new Error("Invalid temporary-work retention");
  root = path.resolve(root);
  const report = { applied: apply, blocked: false, removedBytes: 0, candidates: [], skipped: [] };
  if (busy() || deployment?.running || siteSync?.running || !operationCleanup && operationActive(root, command)) {
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
    if (discardCompletedBackups) {
      const backups = path.join(shared, "sync-backups");
      if (fs.existsSync(backups)) {
        if (fs.lstatSync(backups).isSymbolicLink()) throw new Error("Refusing linked backup directory");
        for (const id of fs.readdirSync(backups)) {
          if (!uuid.test(id)) continue;
          const directory = path.join(backups, id);
          if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing linked backup entry");
          const state = read(path.join(directory, "state.json"));
          if (!["complete", "rolled-back"].includes(state?.phase)) continue;
          // Backup files can be hard links to live data: unlink only the backup names.
          const inspect = file => {
            const info = fs.lstatSync(file);
            if (info.isSymbolicLink()) throw new Error("Refusing linked backup payload");
            if (info.isDirectory()) return fs.readdirSync(file).reduce((sum, name) => sum + inspect(path.join(file, name)), 0);
            if (!info.isFile()) throw new Error("Unsupported backup payload");
            return info.nlink === 1 ? info.size : 0;
          };
          for (const name of fs.readdirSync(directory)) {
            if (name === "state.json") continue;
            const file = path.join(directory, name), bytes = inspect(file);
            report.candidates.push({ path: file, bytes });
            if (apply) {
              fs.rmSync(file, { recursive: fs.lstatSync(file).isDirectory(), force: false });
              report.removedBytes += bytes;
            }
          }
        }
      }
    }
    const self = path.join(shared, "self-deployment"), state = read(path.join(self, "status.json"));
    if (state?.running || state?.phase === "running") report.skipped.push({ path: self, reason: "Self deployment is active" });
    else scan(self, entry => entry.isDirectory() && uuid.test(entry.name));
    if (discardOldReleases && !state?.running && state?.phase !== "running") {
      const releases = path.dirname(root);
      if (fs.lstatSync(releases).isSymbolicLink()) throw new Error("Refusing linked release directory");
      const referenced = [], pm2 = path.join(shared, "tools", "node_modules", ".bin", "pm2");
      if (fs.existsSync(pm2)) {
        const processes = (command || spawnSync)(pm2, ["jlist"], { encoding: "utf8", timeout: 10000 });
        if (processes.error || processes.status !== 0) throw new Error("Cannot verify running release references; cleanup refused");
        const apps = JSON.parse(processes.stdout);
        if (!Array.isArray(apps)) throw new Error("Invalid running release references");
        for (const app of apps) for (const key of ["pm_cwd", "pm_exec_path"])
          if (typeof app.pm2_env?.[key] === "string") referenced.push(path.resolve(app.pm2_env[key]));
      }
      for (const name of fs.readdirSync(releases)) {
        if (!/^release-\d+-[a-f0-9]{12}$/.test(name)) continue;
        const file = path.join(releases, name);
        if (fs.realpathSync(root) === file || fs.lstatSync(file).isSymbolicLink()) continue;
        if (referenced.some(entry => entry === file || entry.startsWith(file + path.sep))) continue;
        if (!fs.existsSync(path.join(file, ".deployment-hosts.json"))) continue;
        const assignment = read(path.join(file, ".deployment-hosts.json"));
        if (!Array.isArray(assignment?.hosts) || typeof assignment.primary !== "boolean")
          throw new Error("Invalid release assignment; cleanup refused");
        // Remove only an obsolete release tree. Its data links are unlinked,
        // never followed; shared databases/uploads remain outside this tree.
        const size = entry => {
          const info = fs.lstatSync(entry);
          if (info.isSymbolicLink()) return 0;
          if (info.isDirectory()) return fs.readdirSync(entry).reduce((total, child) => total + size(path.join(entry, child)), 0);
          if (!info.isFile()) throw new Error("Unsupported old release entry");
          return info.nlink === 1 ? info.size : 0;
        };
        const bytes = size(file);
        report.candidates.push({ path: file, bytes });
        if (apply) {
          fs.rmSync(file, { recursive: true, force: false });
          report.removedBytes += bytes;
        }
      }
    }
  }
  return report;
}

function startStorageMaintenance(root) {
  const run = () => {
    try {
      const report = cleanupStorage({ root, apply: true, discardCompletedBackups: true, discardOldReleases: true });
      if (report.candidates.length) console.info(`Storage maintenance removed ${report.candidates.length} temporary entries (${report.removedBytes} bytes).`);
    } catch (error) { console.error("Storage maintenance failed:", error); }
  };
  const initial = setTimeout(run, 60000), timer = setInterval(run, 60 * 60 * 1000);
  initial.unref(); timer.unref();
  return { close() { clearTimeout(initial); clearInterval(timer); } };
}
function remoteCleanupCode(directory, discardOldReleases = false) {
  return fs.readFileSync(__filename, "utf8") + `
const current=path.join(${JSON.stringify(directory)},'current');
if(fs.existsSync(current)){
  const root=fs.realpathSync(current),before=fs.statfsSync(root);
  const report=cleanupStorage({root,apply:true,minAgeMs:0,discardCompletedBackups:true,discardOldReleases:${discardOldReleases}});
  const after=fs.statfsSync(root);
  console.log(JSON.stringify({cleanup:report,freeBefore:before.bavail*before.bsize,freeAfter:after.bavail*after.bsize}));
}`;
}

module.exports = { cleanupStorage, managedShared, operationActive, startStorageMaintenance, remoteCleanupCode, DAY };
