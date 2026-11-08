"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { snapshot, hash, exclusions, safeName } = require("../../operations/site-sync-snapshot");
const { readReplica } = require("../../operations/replica");
const { redactServerLog, uploadFile, checkSpace, fileHash } = require("./deployment");
const fail = (status, message) => Object.assign(new Error(message), { status });
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const action = "SYNC REVIEWED DATABASES AND UPLOADS";
const syncSteps = [
  ["capture", "Capture source snapshot", 2], ["compress", "Prepare file manifest (no compression)", 15],
  ["digest", "Verify source digest", 25], ["connect", "Connect and check target", 30],
  ["https", "Prepare HTTPS and verify assigned sites", 32],
  ["upload", "Transfer databases first, then uploads", 35], ["verify", "Verify target files", 72],
  ["stop", "Stop target", 78], ["backup", "Back up target", 80],
  ["install", "Install snapshot", 85], ["restart", "Restart target", 92],
  ["health", "Verify read-only health", 95],
];
class SiteSync {
  constructor({ root, settings, deployment, command, busy = () => false, now = Date.now }) {
    this.root = root; this.settings = settings; this.deployment = deployment; this.command = command; this.busy = busy; this.now = now;
    this.directory = path.join(root, "data", "site-sync");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const identity = path.join(this.directory, "source-id");
    if (!fs.existsSync(identity)) fs.writeFileSync(identity, crypto.randomUUID(), { flag: "wx", mode: 0o600 });
    this.sourceId = fs.readFileSync(identity, "utf8");
    this.plans = new Map(); this.running = false;
    this.statusFile = path.join(this.directory, "status.json");
    this.result = fs.existsSync(this.statusFile) ? JSON.parse(fs.readFileSync(this.statusFile, "utf8")) : null;
    if (this.result?.running) {
      if (this.result.phase === "preparing") this.finish("not-applied", "Snapshot preparation was interrupted. No target transfer was started.");
      else if (this.result.phase === "transferring" && this.result.resumable)
        this.finish("paused", "Upload interrupted by source restart. Continue transfer to resume the retained snapshot.");
      else this.finish("uncertain", "Source restarted during sync. Inspect the target job and backup before retrying.");
    }
  }
  status() {
    const result = this.result || { phase: "idle", logs: [], progress: { percent: 0, stage: "Idle" } };
    const steps = (result.steps || []).map(step => {
      const elapsedSeconds = ((step.elapsedMs || 0) + (step.startedAt !== null && step.startedAt !== undefined
        ? Math.max(0, this.now() - step.startedAt) : 0)) / 1000;
      let remainingSeconds = null, percent = step.status === "complete" ? 100 : null, estimate = null;
      if (step.status === "running") {
        const sample = result.uploadSample;
        if (step.id === "upload" && sample && this.now() - sample.at <= 10000) {
          percent = sample.totalBytes ? Math.floor(100 * sample.transferredBytes / sample.totalBytes) : 100;
          if (sample.bytesPerSecond > 0) {
            remainingSeconds = Math.ceil((sample.totalBytes - sample.transferredBytes) / sample.bytesPerSecond);
            estimate = "measured";
          }
        } else if (step.id !== "upload" && step.expectedSeconds > elapsedSeconds) {
          remainingSeconds = Math.ceil(step.expectedSeconds - elapsedSeconds);
          percent = Math.min(99, Math.floor(100 * elapsedSeconds / step.expectedSeconds));
          estimate = "historical";
        }
      } else if (step.status === "pending" && step.expectedSeconds > 0) {
        remainingSeconds = Math.ceil(step.expectedSeconds); estimate = "historical";
      } else if (step.status === "complete") remainingSeconds = 0;
      return { ...step, elapsedSeconds: Math.floor(elapsedSeconds), remainingSeconds, percent, estimate };
    });
    return { ...result, steps, running: this.running };
  }
  completeStep(id) {
    const step = this.result.steps?.find(step => id ? step.id === id && step.status !== "complete" : step.status === "running");
    if (!step) return;
    step.elapsedMs = (step.elapsedMs || 0) + (step.startedAt != null ? Math.max(0, this.now() - step.startedAt) : 0);
    step.startedAt = null; step.status = "complete";
    if (step.id !== "upload" && step.elapsedMs > 0) {
      this.result.timings ||= {};
      this.result.timings[this.result.host] ||= {};
      this.result.timings[this.result.host][step.id] = step.elapsedMs / 1000;
    }
  }
  beginStep(id) {
    const steps = this.result.steps;
    if (!steps) return;
    let step = steps.find(step => step.id === id);
    if (!step && ["rollback", "resume-check"].includes(id)) {
      step = { id, label: id === "rollback" ? "Restore target backup" : "Verify retained files and target prefixes",
        status: "pending", elapsedMs: 0 };
      steps.push(step);
    }
    if (!step || step.status === "running" || step.status === "complete") return;
    if (id === "rollback") {
      const previous = steps.find(step => step.status === "running");
      if (previous) {
        previous.elapsedMs = (previous.elapsedMs || 0) + Math.max(0, this.now() - previous.startedAt);
        previous.startedAt = null; previous.status = "interrupted";
      }
    } else this.completeStep();
    step.status = "running"; step.startedAt = this.now();
  }
  log(message, secrets = []) {
    const logs = this.result.logs || [];
    logs.push({ at: this.now(), message: redactServerLog(String(message), secrets).slice(0, 4096) });
    this.result.logs = logs.slice(-200);
    this.persist();
  }
  progress(percent, stage, details = {}) {
    const id = details.step || [...syncSteps].reverse().find(step => percent >= step[2])?.[0];
    if (id) this.beginStep(id);
    this.result.progress = { percent, stage, ...details };
    this.log(stage);
  }
  persist() {
    const temp = this.statusFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.result), { mode: 0o600 });
    fs.renameSync(temp, this.statusFile);
  }
  finish(phase, message) {
    if (["complete", "review-ready"].includes(phase)) this.completeStep();
    else if (phase === "rolled-back") this.completeStep("rollback");
    else {
      const step = this.result?.steps?.find(step => step.status === "running");
      if (step) {
        step.elapsedMs = (step.elapsedMs || 0) + Math.max(0, this.now() - step.startedAt);
        step.startedAt = null; step.status = phase === "paused" ? "paused" : "interrupted";
      }
    }
    this.running = false; this.result = { ...this.result, running: false, phase, message, finishedAt: new Date(this.now()).toISOString() };
    if (["complete", "rolled-back", "not-applied", "uncertain"].includes(phase)) this.result.resumable = false;
    if (phase === "complete") this.result.progress = { percent: 100, stage: "Complete" };
    this.log(message);
  }
  available({ replaceLegacyPaused = false } = {}) {
    if (readReplica(this.root)) throw fail(403, "A read-only replica cannot be used as a sync source.");
    if (this.running || this.deployment.running || this.busy()) throw fail(409, "Wait for the current server operation.");
    if (this.result?.phase === "uncertain") throw fail(409, "The previous sync is unconfirmed. Verify the target job and recover it before starting another sync.");
    if (this.result?.phase === "paused" && !(replaceLegacyPaused && this.result.binding?.transport !== "files-v1"))
      throw fail(409, "A frozen snapshot is waiting to continue. Resume that transfer before starting a new sync.");
  }
  target(siteKey, passwords = false) {
    const sites = this.deployment.sites(), site = sites.find(site => site.key === siteKey && (!site.status || site.status === "ready"));
    if (!site || site.path) throw fail(400, "Choose a whole managed site with a saved server assignment.");
    const profile = this.settings.value.siteServers?.[siteKey];
    const id = profile && !profile.useShared ? siteKey : "shared";
    const target = this.settings.deploymentTargets(sites, passwords).find(target => target.id === id);
    if (!target) throw fail(400, "Configure and deploy this site's target server first.");
    if (/^(?:localhost|127\.|::1$)/i.test(target.host)) throw fail(400, "The target must be a different server, not loopback.");
    return target;
  }
  prune() {
    for (const [id, plan] of this.plans) if (plan.expires <= this.now()) {
      fs.rmSync(plan.directory, { recursive: true }); this.plans.delete(id);
    }
  }
  async plan(input, context) {
    this.available({ replaceLegacyPaused: true }); this.prune();
    const legacyPaused = this.result?.phase === "paused" && this.result.binding?.transport !== "files-v1" ? this.result.id : null;
    if (this.plans.size >= 2) throw fail(429, "Two snapshots are already awaiting approval. Wait for them to expire.");
    const target = this.target(input.site), revision = this.settings.value.revision;
    const id = crypto.randomUUID(), directory = path.join(this.directory, id);
    this.running = true;
    const timings = this.result?.timings || {};
    this.result = { running: true, phase: "preparing", site: input.site, host: target.host, logs: [], timings,
      steps: syncSteps.map(([id, label]) => ({ id, label, status: "pending", startedAt: null, elapsedMs: 0,
        expectedSeconds: timings[target.host]?.[id] ?? null })),
      message: "Preparing a fixed source snapshot. No target transfer has started." };
    this.progress(2, "Capturing consistent source databases, journals and uploads.");
    if (legacyPaused) this.log(`Previous ZIP transfer ${legacyPaused} was paused before apply. Its staging files are retained, not deleted. This is a fresh file-transfer snapshot requiring review.`);
    try {
      await new Promise(resolve => setImmediate(resolve));
      fs.mkdirSync(directory, { mode: 0o700 });
      const manifest = snapshot(this.root, path.join(directory, "snapshot"), this.settings.environment());
      this.progress(15, `Verified source snapshot: ${manifest.entries.length} files. No compression or archive is created.`);
      const archive = path.join(directory, "snapshot", "manifest.json");
      this.progress(25, "Computing the manifest SHA256. Database entries transfer before uploaded files.");
      const binding = { id, site: input.site, target: target.id, host: target.host, port: target.port,
        directory: target.directory, fingerprint: target.fingerprint, hosts: [...target.hosts], revision, digest: hash(archive), transport: "files-v1" };
      const plan = { directory, archive, binding, context, expires: this.now() + 10 * 60000,
        review: { ...binding, expiresAt: new Date(this.now() + 10 * 60000).toISOString(),
          files: manifest.entries.length, bytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
          createdAt: manifest.createdAt, hosts: target.hosts, exclusions, readOnly: true,
          httpsSetup: "Provision missing or invalid HTTPS certificates for deployed, reviewed target hostnames before transferring data. Uses the saved certificate email and SSH/sudo credential; existing valid certificates are preserved." } };
      this.plans.set(id, plan);
      const expiry = setTimeout(() => {
        try { this.prune(); } catch (error) { console.error("Expired sync snapshot cleanup failed:", error.code || 500); }
      }, 10 * 60000 + 100);
      expiry.unref();
      this.finish("review-ready", "Source snapshot is ready for wallet approval. No target transfer has started.");
      return plan.review;
    } catch (error) {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true });
      this.finish("not-applied", `Snapshot preparation failed (${error.code || error.name}). No target transfer was started.`);
      throw error;
    } finally { this.running = false; }
  }
  reviewed(input, context) {
    this.available(); this.prune();
    const plan = this.plans.get(input.plan);
    if (!plan || plan.context.session !== context.session || plan.context.wallet !== context.wallet || plan.context.origin !== context.origin)
      throw fail(409, "The reviewed snapshot expired or belongs to another session. Review a new snapshot.");
    if (input.site && input.site !== plan.binding.site) throw fail(400, "The reviewed snapshot belongs to another site.");
    const target = this.target(plan.binding.site);
    if (plan.binding.revision !== this.settings.value.revision || target.host !== plan.binding.host
      || target.directory !== plan.binding.directory || target.fingerprint !== plan.binding.fingerprint
      || JSON.stringify(target.hosts) !== JSON.stringify(plan.binding.hosts))
      throw fail(409, "Target Settings changed. Review a new snapshot.");
    return plan;
  }
  challenge(input, context) {
    const plan = this.reviewed(input, context);
    return this.settings.approvals.challenge(action, plan.binding, context,
      `${plan.binding.host}: Provision missing HTTPS certificates for reviewed deployed hostnames using saved Settings. ALL installation databases and uploads, not just this site. Verified backup first; source databases replace target databases. Keep target-only uploads and target server credentials. Restart target as a read-only replica. Snapshot ${plan.review.createdAt}; SHA256 ${plan.binding.digest}.`);
  }
  start(input, context) {
    const plan = this.reviewed(input, context);
    this.settings.approvals.consume(action, plan.binding, context, input);
    return this.launch(plan);
  }
  async startShared(input, context) {
    this.available({ replaceLegacyPaused: true });
    if (input.revision !== this.settings.value.revision) throw fail(409, "Settings changed. Reload before starting sync.");
    if (this.target(input.site).id !== "shared") throw fail(400, "Separate server sync requires snapshot review and wallet approval.");
    const review = await this.plan(input, context);
    const plan = this.reviewed({ site: input.site, plan: review.id }, context);
    return this.launch(plan);
  }
  launch(plan) {
    const target = this.target(plan.binding.site, true);
    this.plans.delete(plan.binding.id); this.running = true;
    this.result = { running: true, phase: "transferring", site: plan.binding.site, host: target.host, id: plan.binding.id,
      steps: this.result?.steps, timings: this.result?.timings,
      logs: this.result?.logs || [], progress: { percent: 30, stage: "Connecting to the saved pinned SSH target." },
      binding: plan.binding, resumable: true,
      startedAt: new Date(this.now()).toISOString(), message: "Transferring the snapshot; target data is not changed until verification and backup." };
    this.progress(30, `Connecting to ${target.host}:${target.port} with pinned host-key verification.`);
    return this.runTransfer(plan, target);
  }
  runTransfer(plan, target) {
    this.pauseController = new AbortController();
    this.transferTask = this.execute(plan, target).catch(error => {
      const paused = this.pauseController.signal.aborted && this.result.phase === "transferring";
      console.error("Site sync failed:", paused ? "paused" : error.status || error.code || 500);
      if (paused) this.finish("paused", "Paused by Admin. Verified files and the partial file's prefix are retained. Continue transfer to resume where it stopped.");
      else this.log(`ERROR: ${error.message}`, [target.password]);
      if (paused) return;
      if (this.result.phase === "transferring") {
        this.finish("paused", error.siteSetup
          ? "Target site setup is not ready. No snapshot data was transferred in this attempt. Review the detail log, deploy the current release from Admin Settings and fix HTTPS, then continue this retained snapshot or reset for a fresh capture."
          : "Upload paused. Frozen files and verified target prefixes are retained. Continue transfer to skip completed files and resume the interrupted file.");
      } else {
        this.result.resumable = false;
        this.finish("uncertain", "Sync was not confirmed. Inspect the target's featheral-site-sync systemd job and shared/sync-backups before retrying. No success is assumed.");
      }
    }).finally(() => {
      target.password = "";
      if (this.result.phase === "paused" || this.result.phase === "uncertain") return;
      this.result.resumable = false;
      this.cleanupSnapshot(plan.binding.id);
    });
    return this.status();
  }
  cleanupSnapshot(id) {
    if (!safeName(id) || id.includes("/")) throw fail(500, "Invalid retained snapshot identifier.");
    try { fs.rmSync(path.join(this.directory, id), { recursive: true, force: true }); }
    catch (error) {
      console.error("Site sync snapshot cleanup failed:", error.code || 500);
      this.result.message += " Local snapshot cleanup failed; an operator must remove the retained staging directory.";
      this.persist();
    }
  }
  // Receiver updates travel with the snapshot; application code and site setup still require deployment.
  receiverBundle() {
    const names = ["scripts/restore-site-sync.js", "scripts/setup-site-https.js", "services/operations/site-sync-snapshot.js", "services/operations/replica.js", "services/operations/storage-cleanup.js"];
    const files = names.map(name => {
      const file = path.join(__dirname, "..", "..", "..", ...name.split("/"));
      return { name, path: file, bytes: fs.statSync(file).size, hash: hash(file) };
    });
    return { files, digest: crypto.createHash("sha256").update(files.map(file => `${file.name}:${file.hash}`).join("\n")).digest("hex") };
  }
  pause(input) {
    if (!this.running || this.result?.phase !== "transferring" || this.result.site !== input.site || !this.pauseController)
      throw fail(409, "Only an uploading transfer can be paused. Target verification and install cannot be interrupted.");
    if (!this.pauseController.signal.aborted) {
      this.pauseController.abort(fail(409, "Paused by Admin."));
      this.log("Pause requested. Stopping after the current block; uploaded bytes are kept.");
    }
    return this.status();
  }
  async reset(input) {
    if (readReplica(this.root)) throw fail(403, "A read-only replica cannot be used as a sync source.");
    if (this.running || this.deployment.running || this.busy()) throw fail(409, "Pause the current transfer or wait for the server operation first.");
    if (this.result?.phase === "uncertain") throw fail(409, "The previous sync is unconfirmed. Recheck the target status before resetting.");
    if (!this.command) throw fail(503, "Target command transport is unavailable.");
    const target = this.target(input.site, true);
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(target.directory) || target.directory === "/" || target.directory.split("/").includes(".."))
      throw fail(400, "Invalid saved target directory.");
    this.running = true;
    let client;
    try {
      client = await this.deployment.connect(target);
      const code = `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const root=${JSON.stringify(target.directory)},base=root+'/shared/site-sync',backups=root+'/shared/sync-backups';
const active=cp.spawnSync('systemctl',['is-active','--quiet','featheral-site-sync.service']);
if(!active.error&&active.status===0)throw new Error('A target sync job is still running.');
if(fs.existsSync(root+'/shared/site-sync.lock'))throw new Error('The target sync lock requires backup recovery.');
const size=p=>{const s=fs.lstatSync(p);return s.isDirectory()&&!s.isSymbolicLink()?fs.readdirSync(p).reduce((n,e)=>n+size(path.join(p,e)),0):s.size;};
let removedBytes=0,removed=0;
if(fs.existsSync(base)){if(fs.lstatSync(base).isSymbolicLink())throw new Error('Linked staging path.');
for(const id of fs.readdirSync(base)){const state=backups+'/'+id+'/state.json';
if(fs.existsSync(state)&&!['complete','rolled-back'].includes(JSON.parse(fs.readFileSync(state,'utf8')).phase))throw new Error('Sync '+id+' has an unfinished install receipt. Recover its backup first.');}
for(const id of fs.readdirSync(base)){const dir=path.join(base,id);removedBytes+=size(dir);fs.rmSync(dir,{recursive:true,force:true});removed++;}}
console.log(JSON.stringify({removed,removedBytes,remaining:fs.existsSync(base)?fs.readdirSync(base).length:0}));`;
      const receipt = JSON.parse((await this.command(client, `node -e ${quote(code)}`)).trim().split("\n").pop());
      if (receipt.remaining !== 0) throw fail(502, "Target staging cleanup could not be verified.");
      let localRemoved = 0;
      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true }))
        if (entry.isDirectory() && !this.plans.has(entry.name)) { this.cleanupSnapshot(entry.name); localRemoved++; }
      this.result = { running: false, phase: "not-applied", site: input.site, host: target.host, timings: this.result?.timings,
        logs: this.result?.logs || [], steps: [], resumable: false, progress: { percent: 0, stage: "Reset — ready for a new snapshot" } };
      this.finish("not-applied", `Transfer reset. Removed ${receipt.removed} target staging folder(s) (${receipt.removedBytes} bytes) and ${localRemoved} local snapshot(s). Target databases and uploads were not changed.`);
      return this.status();
    } finally { this.running = false; client?.end(); target.password = ""; }
  }
  resume(input) {
    if (readReplica(this.root)) throw fail(403, "A read-only replica cannot be used as a sync source.");
    if (this.running || this.deployment.running || this.busy()) throw fail(409, "Wait for the current server operation.");
    if (this.result?.phase !== "paused" || !this.result.resumable || this.result.site !== input.site)
      throw fail(409, "There is no paused upload for this site. Unconfirmed target jobs require a status check, not upload resume.");
    const binding = this.result.binding;
    if (binding?.transport !== "files-v1") throw fail(409, "The previous paused transfer used a ZIP. Prepare a new file-transfer snapshot; old staging is retained. Unconfirmed target jobs still require a receipt check.");
    if (!binding || !safeName(binding.id) || binding.id.includes("/")) throw fail(500, "Invalid retained snapshot identifier.");
    const target = this.target(input.site, true);
    for (const key of ["host", "port", "directory", "fingerprint"])
      if (target[key] !== binding[key]) throw fail(409, "Restore the original target connection before continuing this snapshot.");
    if (target.id !== binding.target) throw fail(409, "Restore the original server assignment before continuing this snapshot.");
    if (binding.hosts && JSON.stringify(target.hosts) !== JSON.stringify(binding.hosts))
      throw fail(409, "Site assignments changed. Restore the original assigned hostnames before continuing this snapshot.");
    const directory = path.join(this.directory, binding.id), archive = path.join(directory, "snapshot", "manifest.json");
    if (!fs.existsSync(archive)) throw fail(409, "The frozen source manifest is missing. Legacy ZIP transfers cannot be continued by this uploader.");
    this.running = true;
    this.result.running = true; this.result.phase = "transferring"; delete this.result.finishedAt;
    this.result.message = "Continuing the retained snapshot. Verifying its digest and the target prefix before uploading remaining bytes.";
    delete this.result.uploadSample;
    this.beginStep("resume-check");
    this.log(this.result.message);
    return this.runTransfer({ binding, directory, archive, resume: true }, target);
  }
  async upload(client, sftp, plan, remote, target) {
    const fileBytes = fs.statSync(plan.archive).size, totalBytes = plan.totalBytes ?? fileBytes, base = plan.completedBytes || 0;
    let sampleAt = this.now(), sampleBytes = null, updated = 0;
    const report = fileTransferred => {
      const transferredBytes = base + fileTransferred;
      const now = this.now(), elapsed = (now - sampleAt) / 1000;
      this.result.uploadSample = { at: now, transferredBytes, totalBytes,
        bytesPerSecond: elapsed > 0 && sampleBytes !== null ? (transferredBytes - sampleBytes) / elapsed : null };
      sampleAt = now; sampleBytes = transferredBytes;
      this.progress(35 + Math.floor(35 * transferredBytes / Math.max(1, totalBytes)),
        `Transferring ${plan.name || "file"}: ${transferredBytes} / ${totalBytes} bytes.`, { transferredBytes, totalBytes });
    };
    await uploadFile({ deployment: this.deployment, client, sftp, file: plan.archive, remote, bytes: fileBytes,
      digest: plan.binding.digest, target, signal: this.pauseController?.signal, report: bytes => {
        if (sampleBytes === null || this.now() - updated >= 500 || bytes === fileBytes) { updated = this.now(); report(bytes); }
      } });
  }
  async execute(plan, target) {
    let client;
    try {
      client = await this.deployment.connect(target);
      const onLog = line => {
        const stages = { verify: [75, "Verifying target files and databases."], stop: [78, "Stopping target application."],
          backup: [80, "Creating checksum-verified target backup."], install: [85, "Installing databases and overlaying uploads."],
          restart: [92, "Restarting target as a read-only replica."], health: [95, "Waiting for read-only health verification."],
          rollback: [95, "Restoring the verified backup after failure.", { step: "rollback" }] };
        const marker = /^FEATHERAL_SYNC:([a-z-]+)$/.exec(line);
        if (marker?.[1] === "rollback-complete") { this.completeStep("rollback"); this.persist(); }
        else if (marker && stages[marker[1]]) this.progress(...stages[marker[1]]);
        else this.log(line, [target.password]);
      };
      const remote = `${target.directory}/shared/site-sync/${plan.binding.id}`;
      this.progress(32, "SSH connected. Checking target release and staging directories.");
      await this.deployment.execute(client, `node -e ${quote(require("../../operations/storage-cleanup").remoteCleanupCode(target.directory))}`, "", target.deploymentTimeoutSeconds, undefined, onLog);
      await this.deployment.execute(client, `umask 077; test -f ${quote(target.directory + "/current/services/operations/settings.js")} && mkdir -p ${quote(remote + "/snapshot")} ${quote(target.directory + "/shared/sync-backups")}`, "", target.sshTimeoutSeconds, undefined, onLog);
      if (await fileHash(plan.archive) !== plan.binding.digest) throw fail(409, "Retained source manifest checksum changed. Refusing to resume.");
      const manifest = JSON.parse(fs.readFileSync(plan.archive, "utf8"));
      const total = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      // One listing replaces a per-file round trip: sizes identify complete, partial and missing staged files.
      const remoteSizes = new Map();
      await this.deployment.execute(client, `cd ${quote(remote + "/snapshot")} && find . -type f -printf '%s\\t%P\\n'`, "", target.deploymentTimeoutSeconds, undefined,
        line => { const match = /^(\d+)\t(.+)$/.exec(line); if (match) remoteSizes.set(match[2], Number(match[1])); });
      const sizes = new Map(manifest.entries.map(entry => [entry.name, entry.bytes]));
      const staged = [...remoteSizes].reduce((sum, [name, bytes]) => sum + Math.min(bytes, sizes.get(name) ?? 0), 0);
      // Staging is the only full copy: the receiver renames staged files into place and hard-links rollback backups,
      // then measures any cross-filesystem bytes itself before replacing anything.
      await checkSpace(this.deployment, client, remote, Math.max(0, total - staged) + 512 * 1024 * 1024, target.sshTimeoutSeconds);
      const receiver = this.receiverBundle(), receiverDirectory = `${remote}/receiver-${receiver.digest.slice(0, 16)}`;
      const journal = path.join(plan.directory, "uploaded.txt");
      const verified = new Set(fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean) : []);
      const isUpload = entry => /(?:^|\/)(?:uploads|media)\//i.test(entry.name);
      const entries = [...manifest.entries].sort((a, b) => Number(isUpload(a)) - Number(isUpload(b)) || a.name.localeCompare(b.name));
      for (const entry of entries) if (!safeName(entry.name)) throw fail(409, "Invalid manifest file path.");
      const directories = new Set([...entries.map(entry => `snapshot/${entry.name}`), ...receiver.files.map(file => `${path.posix.basename(receiverDirectory)}/${file.name}`)]
        .map(name => path.posix.dirname(name)));
      await this.deployment.execute(client, `umask 077; cd ${quote(remote)} && xargs -0 mkdir -p --`, [...directories].join("\0"), target.deploymentTimeoutSeconds);
      const sftp = await this.deployment.transfer(client, callback => client.sftp(callback), target.sshTimeoutSeconds);
      try {
        for (const file of receiver.files)
          await uploadFile({ deployment: this.deployment, client, sftp, file: file.path, remote: `${receiverDirectory}/${file.name}`,
            bytes: file.bytes, digest: file.hash, target, signal: this.pauseController.signal });
        this.progress(32, "Preparing reviewed HTTPS certificates and checking assigned application routes.");
        this.log("Checking assigned sites, HTTPS certificates and application routes before transferring databases or uploads.");
        try {
          const setup = `node ${quote(receiverDirectory + "/scripts/setup-site-https.js")} ${quote(target.directory)} ${quote(JSON.stringify(target.hosts))} ${quote(target.email || "")}`;
          await this.deployment.execute(client, [
            "set -eu",
            "IFS= read -r password",
            `cd ${quote(remote)} && printf '%s\\n' ${quote(receiver.files.map(file => `${file.hash}  ${path.posix.basename(receiverDirectory)}/${file.name}`).join("\n"))} | sha256sum --check --quiet`,
            `if [ "$(id -u)" = 0 ]; then ${setup}; else printf '%s\\n' "$password" | sudo -S -p '' -- ${setup}; fi`,
          ].join("; "), `${target.password || ""}\n`, target.deploymentTimeoutSeconds, undefined, onLog);
          await this.deployment.execute(client, [
            `cd ${quote(remote)}`,
            `printf '%s\\n' ${quote(receiver.files.map(file => `${file.hash}  ${path.posix.basename(receiverDirectory)}/${file.name}`).join("\n"))} | sha256sum --check --quiet`,
            `node ${quote(receiverDirectory + "/scripts/restore-site-sync.js")} --check-sites ${quote(target.directory)} ${quote(JSON.stringify(target.hosts))}`,
          ].join(" && "), "", target.deploymentTimeoutSeconds, undefined, onLog);
        } catch (error) { error.siteSetup = true; throw error; }
        let completed = 0, completedBytes = 0, skipped = 0;
        for (const entry of entries) {
          if (this.pauseController.signal.aborted) throw this.pauseController.signal.reason;
          if (verified.has(entry.name) && remoteSizes.get(entry.name) === entry.bytes) {
            completed++; completedBytes += entry.bytes; skipped++;
            continue;
          }
          if (skipped) { this.log(`Skipped ${skipped} files already verified on the target.`); skipped = 0; }
          this.log(`${isUpload(entry) ? "Upload" : "Database/metadata"} ${completed + 1}/${entries.length}: ${entry.name}`);
          await this.upload(client, sftp, { archive: path.join(plan.directory, "snapshot", ...entry.name.split("/")), binding: { digest: entry.hash },
            totalBytes: total, completedBytes, name: entry.name }, `${remote}/snapshot/${entry.name}`, target);
          fs.appendFileSync(journal, entry.name + "\n", { mode: 0o600 });
          completed++;
          completedBytes += entry.bytes;
        }
        if (skipped) this.log(`Skipped ${skipped} files already verified on the target.`);
        await this.upload(client, sftp, plan, `${remote}/snapshot/manifest.json`, target);
      }
      finally { sftp.end(); }
      if (!safeName(plan.binding.id)) throw fail(500, "Invalid sync identifier.");
      const script = [
        "set -euo pipefail", "umask 077",
        `cd ${quote(remote)}`, "echo FEATHERAL_SYNC:verify",
        `printf '%s\\n' ${quote([`${plan.binding.digest}  snapshot/manifest.json`,
          ...receiver.files.map(file => `${file.hash}  ${path.posix.basename(receiverDirectory)}/${file.name}`)].join("\n"))} | sha256sum --check --quiet`,
        `node ${quote(receiverDirectory + "/scripts/restore-site-sync.js")} ${quote(target.directory)} ${quote(remote + "/snapshot")} ${quote(target.directory + "/shared/sync-backups/" + plan.binding.id)} ${quote(this.sourceId)} ${quote(JSON.stringify(target.hosts))}`,
      ].join("\n");
      const launcher = `systemd-run --wait --pipe --collect --unit=featheral-site-sync --uid="$(id -u)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" /bin/bash -c ${quote(script)}`;
      const command = `IFS= read -r password; if [ "$(id -u)" = 0 ]; then ${launcher}; else printf '%s\\n' "$password" | sudo -S -p '' -v && sudo -n ${launcher}; fi`;
      this.result.phase = "applying"; this.result.resumable = false; this.result.message = "Target verifies checksums, stops the app, backs up affected data, installs and checks read-only health."; this.persist();
      this.progress(72, "Upload complete. Starting independent target verification and restore job.");
      await this.deployment.execute(client, command, target.password + "\n", target.deploymentTimeoutSeconds, undefined, onLog);
      this.finish("complete", "Snapshot synchronized. Target read-only health was confirmed.");
      try {
        const cleanup = require("../../operations/storage-cleanup").remoteCleanupCode(target.directory, true);
        await this.deployment.execute(client, `node -e ${quote(cleanup)}`, "", target.deploymentTimeoutSeconds, undefined, onLog);
        this.result.message += " Completed temporary files and backup payloads cleaned.";
        this.persist();
      } catch (error) {
        this.log(`Verified sync cleanup failed: ${error.message}`, [target.password]);
        this.result.message += " Cleanup failed; retained files need operator review.";
        this.persist();
      }
    } finally { client?.end(); }
  }
  recoveryBinding(site) {
    if (this.running || this.deployment.running || this.busy()) throw fail(409, "Wait for the current server operation.");
    if (this.result?.phase !== "uncertain" || this.result.site !== site || !this.result.binding)
      throw fail(409, "There is no unconfirmed sync for this site.");
    const target = this.target(site);
    for (const key of ["host", "port", "directory", "fingerprint"])
      if (target[key] !== this.result.binding[key]) throw fail(409, "Restore the reviewed target connection before checking its sync receipt.");
    return { id: this.result.id, site, host: target.host, directory: target.directory,
      fingerprint: target.fingerprint, revision: this.settings.value.revision };
  }
  recoveryChallenge(input, context) {
    const binding = this.recoveryBinding(input.site);
    return this.settings.approvals.challenge("CHECK UNCONFIRMED SITE SYNC", binding, context,
      `${binding.host}: read the previous sync receipt and process status only. Do not copy or replace data.`);
  }
  async reconcile(input, context) {
    const binding = this.recoveryBinding(input.site);
    this.settings.approvals.consume("CHECK UNCONFIRMED SITE SYNC", binding, context, input);
    const target = this.target(input.site, true);
    if (!this.command) throw fail(503, "Target status transport is unavailable.");
    this.running = true;
    let client;
    try {
      client = await this.deployment.connect(target);
      const code = `const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=${JSON.stringify(target.directory)};const file=root+'/shared/sync-backups/${binding.id}/state.json';const apps=JSON.parse(require('node:child_process').execFileSync(root+'/shared/tools/node_modules/.bin/pm2',['jlist'],{encoding:'utf8'}));console.log(JSON.stringify({active:spawnSync('systemctl',['is-active','--quiet','featheral-site-sync.service']).status===0,locked:fs.existsSync(root+'/shared/site-sync.lock'),online:apps.some(a=>a.name==='featheral'&&a.pm2_env.status==='online'),phase:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).phase:null}));`;
      const receipt = JSON.parse((await this.command(client, `node -e ${quote(code)}`)).trim());
      if (receipt.active || receipt.locked || !receipt.online) throw fail(409, "The target is still running the job, is stopped, or needs backup recovery. Inspect its systemd log; no data was changed by this check.");
      if (receipt.phase === "complete") this.finish("complete", "Target receipt confirms the previous sync completed and passed read-only health verification.");
      else if (receipt.phase === "rolled-back") this.finish("rolled-back", "Target receipt confirms the previous sync failed and its verified backup was restored.");
      else if (receipt.phase === null) this.finish("not-applied", "Target is online with no active sync, lock or install receipt. The previous sync did not apply data.");
      else throw fail(409, "The target receipt requires manual backup recovery. No new sync is allowed.");
      this.cleanupSnapshot(binding.id);
      return this.status();
    } finally { client?.end(); target.password = ""; this.running = false; }
  }
}
module.exports = { SiteSync };
