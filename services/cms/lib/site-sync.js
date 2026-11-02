"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yazl = require("yazl");
const { pipeline } = require("node:stream/promises");
const { snapshot, hash, exclusions, safeName } = require("../../operations/site-sync-snapshot");
const { readReplica } = require("../../operations/replica");
const fail = (status, message) => Object.assign(new Error(message), { status });
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const action = "SYNC REVIEWED DATABASES AND UPLOADS";
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
      else this.finish("uncertain", "Source restarted during sync. Inspect the target job and backup before retrying.");
    }
  }
  status() { return { ...(this.result || { phase: "idle" }), running: this.running }; }
  persist() {
    const temp = this.statusFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.result), { mode: 0o600 });
    fs.renameSync(temp, this.statusFile);
  }
  finish(phase, message) {
    this.running = false; this.result = { ...this.result, running: false, phase, message, finishedAt: new Date(this.now()).toISOString() };
    this.persist();
  }
  available() {
    if (readReplica(this.root)) throw fail(403, "A read-only replica cannot be used as a sync source.");
    if (this.running || this.deployment.running || this.busy()) throw fail(409, "Wait for the current server operation.");
    if (this.result?.phase === "uncertain") throw fail(409, "The previous sync is unconfirmed. Verify the target job and recover it before starting another sync.");
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
    this.available(); this.prune();
    if (this.plans.size >= 2) throw fail(429, "Two snapshots are already awaiting approval. Wait for them to expire.");
    const target = this.target(input.site), revision = this.settings.value.revision;
    const id = crypto.randomUUID(), directory = path.join(this.directory, id);
    this.running = true;
    this.result = { running: true, phase: "preparing", site: input.site, host: target.host,
      message: "Preparing a fixed source snapshot. No target transfer has started." };
    this.persist();
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      const manifest = snapshot(this.root, path.join(directory, "snapshot"), this.settings.environment());
      const archive = path.join(directory, "snapshot.zip"), zip = new yazl.ZipFile();
      const writing = pipeline(zip.outputStream, fs.createWriteStream(archive, { mode: 0o600 }));
      for (const entry of manifest.entries) zip.addFile(path.join(directory, "snapshot", ...entry.name.split("/")), entry.name);
      zip.addFile(path.join(directory, "snapshot", "manifest.json"), "manifest.json");
      zip.end(); await writing;
      const binding = { id, site: input.site, target: target.id, host: target.host, port: target.port,
        directory: target.directory, fingerprint: target.fingerprint, revision, digest: hash(archive) };
      const plan = { directory, archive, binding, context, expires: this.now() + 10 * 60000,
        review: { ...binding, expiresAt: new Date(this.now() + 10 * 60000).toISOString(),
          files: manifest.entries.length, bytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
          createdAt: manifest.createdAt, hosts: target.hosts, exclusions, readOnly: true } };
      this.plans.set(id, plan);
      const expiry = setTimeout(() => {
        try { this.prune(); } catch (error) { console.error("Expired sync snapshot cleanup failed:", error.code || 500); }
      }, 10 * 60000 + 100);
      expiry.unref();
      this.finish("review-ready", "Source snapshot is ready for wallet approval. No target transfer has started.");
      return plan.review;
    } catch (error) {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true });
      this.finish("not-applied", "Snapshot preparation failed. No target transfer was started.");
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
      || target.directory !== plan.binding.directory || target.fingerprint !== plan.binding.fingerprint)
      throw fail(409, "Target Settings changed. Review a new snapshot.");
    return plan;
  }
  challenge(input, context) {
    const plan = this.reviewed(input, context);
    return this.settings.approvals.challenge(action, plan.binding, context,
      `${plan.binding.host}: ALL installation databases and uploads, not just this site. Verified backup first; source databases replace target databases. Keep target-only uploads and target server credentials. Restart target as a read-only replica. Snapshot ${plan.review.createdAt}; SHA256 ${plan.binding.digest}.`);
  }
  start(input, context) {
    const plan = this.reviewed(input, context);
    this.settings.approvals.consume(action, plan.binding, context, input);
    const target = this.target(plan.binding.site, true);
    this.plans.delete(plan.binding.id); this.running = true;
    this.result = { running: true, phase: "transferring", site: plan.binding.site, host: target.host, id: plan.binding.id,
      binding: plan.binding,
      startedAt: new Date(this.now()).toISOString(), message: "Transferring the approved snapshot; target data is not changed until verification and backup." };
    this.persist();
    this.execute(plan, target).catch(error => {
      console.error("Site sync failed:", error.status || error.code || 500);
      this.finish("uncertain", "Sync was not confirmed. Inspect the target's featheral-site-sync systemd job and shared/sync-backups before retrying. No success is assumed.");
    }).finally(() => {
      target.password = "";
      try { fs.rmSync(plan.directory, { recursive: true }); }
      catch (error) {
        console.error("Site sync snapshot cleanup failed:", error.code || 500);
        this.result.message += " Local snapshot cleanup failed; an operator must remove the retained staging directory.";
        this.persist();
      }
    });
    return this.status();
  }
  async execute(plan, target) {
    let client;
    try {
      client = await this.deployment.connect(target);
      const remote = `${target.directory}/shared/site-sync/${plan.binding.id}`;
      await this.deployment.execute(client, `umask 077; test -f ${quote(target.directory + "/current/scripts/restore-site-sync.js")} && mkdir -p ${quote(remote)} ${quote(target.directory + "/shared/sync-backups")}`, "", target.sshTimeoutSeconds);
      const sftp = await this.deployment.transfer(client, callback => client.sftp(callback), target.sshTimeoutSeconds);
      try { await this.deployment.transfer(client, callback => sftp.fastPut(plan.archive, `${remote}/snapshot.zip`, callback), target.deploymentTimeoutSeconds); }
      finally { sftp.end(); }
      if (!safeName(plan.binding.id)) throw fail(500, "Invalid sync identifier.");
      const script = [
        "set -euo pipefail", "umask 077",
        `cd ${quote(remote)}`,
        `printf '%s\\n' ${quote(plan.binding.digest + "  snapshot.zip")} | sha256sum --check`,
        `node -e ${quote(`const {execFileSync}=require('node:child_process');const {safeName}=require(${JSON.stringify(target.directory + "/current/services/operations/site-sync-snapshot.js")});const names=execFileSync('unzip',['-Z1','snapshot.zip'],{encoding:'utf8',maxBuffer:16777216}).trim().split('\\n');if(names.some(n=>!safeName(n)||!(/^(?:manifest\\.json|(?:data|cms)\\/)/.test(n))))process.exit(1);`)}`,
        "mkdir snapshot", "unzip -qq snapshot.zip -d snapshot",
        `node ${quote(target.directory + "/current/scripts/restore-site-sync.js")} ${quote(target.directory)} ${quote(remote + "/snapshot")} ${quote(target.directory + "/shared/sync-backups/" + plan.binding.id)} ${quote(this.sourceId)}`,
        "rm snapshot.zip",
      ].join("\n");
      const launcher = `systemd-run --wait --pipe --collect --unit=featheral-site-sync --uid="$(id -u)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" /bin/bash -c ${quote(script)}`;
      const command = `IFS= read -r password; if [ "$(id -u)" = 0 ]; then ${launcher}; else printf '%s\\n' "$password" | sudo -S -p '' -v && sudo -n ${launcher}; fi`;
      this.result.phase = "applying"; this.result.message = "Target verifies checksums, stops the app, backs up affected data, installs and checks read-only health."; this.persist();
      await this.deployment.execute(client, command, target.password + "\n", target.deploymentTimeoutSeconds);
      this.finish("complete", "Snapshot synchronized. Target read-only health was confirmed; verified backup retained on the target.");
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
      return this.status();
    } finally { client?.end(); target.password = ""; this.running = false; }
  }
}
module.exports = { SiteSync };
