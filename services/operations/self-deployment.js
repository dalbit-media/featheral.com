"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fail = (status, message) => Object.assign(new Error(message), { status });
const repository = "https://github.com/dalbit-media/featheral.com.git";
class SelfDeployment {
  constructor({ root, settings, deployment, busy = () => false, platform = process.platform, command = spawnSync,
    uid = process.getuid?.() }) {
    this.root = root; this.settings = settings; this.deployment = deployment; this.busy = busy;
    this.platform = platform; this.command = command; this.uid = uid;
  }
  layout() {
    if (this.platform !== "linux") throw fail(409, "Self-sync is available only on the deployed Linux Admin server.");
    const root = path.dirname(path.dirname(this.root));
    if (path.basename(path.dirname(this.root)) !== "releases" || !fs.existsSync(path.join(root, "current"))
      || fs.realpathSync(path.join(root, "current")) !== fs.realpathSync(this.root))
      throw fail(409, "Self-sync requires the active managed release layout.");
    const assignment = JSON.parse(fs.readFileSync(path.join(this.root, ".deployment-hosts.json"), "utf8"));
    if (!assignment.primary || !assignment.hosts?.includes("admin.featheral.com"))
      throw fail(403, "Self-sync can update only the server running Admin.");
    return { root, assignment, directory: path.join(root, "shared", "self-deployment") };
  }
  active() {
    if (this.platform !== "linux") return false;
    const result = this.command("systemctl", ["show", "featheral-deployment.service", "--property=ActiveState", "--value"], { encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) throw fail(503, "Cannot verify the deployment systemd job. Inspect the server.");
    return ["active", "activating", "deactivating", "reloading"].includes(result.stdout.trim());
  }
  status() {
    if (this.platform !== "linux") return { available: false, running: false, message: "Self-sync runs only on the deployed Linux Admin server.", logs: [] };
    let layout;
    try { layout = this.layout(); }
    catch (error) {
      if (!error.status) throw error;
      return { available: false, running: false, message: error.message, logs: [] };
    }
    const file = path.join(layout.directory, "status.json");
    const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { phase: "idle", logs: [] };
    const running = this.active();
    return { ...receipt, available: true, running,
      ...(receipt.phase === "running" && !running ? { phase: "uncertain", message: "Self-sync stopped without a completion receipt. Inspect journalctl -u featheral-deployment before retrying." } : {}) };
  }
  binding() {
    const layout = this.layout();
    if (this.deployment.running || this.busy() || this.active() || fs.existsSync(path.join(layout.root, "shared", "site-sync.lock")))
      throw fail(409, "Wait for the current deployment, site sync or Settings operation.");
    if (this.status().phase === "uncertain") throw fail(409, "Inspect the interrupted self-sync before retrying.");
    return { root: layout.root, release: path.basename(this.root), revision: this.settings.value.revision,
      repository, branch: "remote default branch" };
  }
  challenge(context) {
    const binding = this.binding();
    return this.settings.approvals.challenge("SELF SYNC ADMIN SERVER", binding, context,
      `${repository}: pull the default branch on this Admin server, build a fresh release, verify health and restart. Private data and published content are not copied or replaced. Git credentials must already be installed on this server.`);
  }
  start(input, context) {
    const binding = this.binding();
    this.settings.approvals.consume("SELF SYNC ADMIN SERVER", binding, context, input);
    const { directory } = this.layout();
    if (!Number.isInteger(this.uid)) throw fail(503, "Cannot identify the deployment service account.");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const receipt = { id: crypto.randomUUID(), phase: "running", running: true, startedAt: new Date().toISOString(),
      message: "Starting independent Git pull, rebuild and restart job.", logs: [] };
    const file = path.join(directory, "status.json");
    fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600, flush: true });
    const args = ["--collect", "--unit=featheral-deployment", "--property=Type=exec",
      `--uid=${this.uid}`, `--setenv=HOME=${process.env.HOME}`, `--setenv=PATH=${process.env.PATH}`,
      process.execPath, path.join(this.root, "scripts", "self-deploy.js"), binding.root, receipt.id];
    const result = this.uid === 0
      ? this.command("systemd-run", args, { encoding: "utf8", timeout: 15000 })
      : this.command("sudo", ["-n", "systemd-run", ...args], { encoding: "utf8", timeout: 15000 });
    if (result.error || result.status !== 0) {
      receipt.phase = "failed"; receipt.running = false;
      receipt.message = "Could not launch self-sync. Configure non-interactive sudo for the deployment job; inspect the server log.";
      fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600, flush: true });
      console.error("Self-sync launch failed:", result.error?.code || result.status);
      throw fail(503, receipt.message);
    }
    return { ...receipt, available: true };
  }
}
module.exports = { SelfDeployment, repository };
