"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { prepareRelease, releaseFiles, redactServerLog } = require("../services/cms/lib/deployment");
const { repository } = require("../services/operations/self-deployment");
async function updateCheckout(checkout, command, source = repository) {
  const directory = path.dirname(checkout);
  if (!fs.existsSync(checkout)) await command("git", ["clone", "--no-checkout", "--origin", "origin", source, checkout], directory);
  if (fs.lstatSync(checkout).isSymbolicLink()) throw new Error("Linked self-sync checkout is not supported.");
  if (await command("git", ["remote", "get-url", "origin"], checkout, true) !== source) throw new Error("Checkout origin does not match the approved repository.");
  if (await command("git", ["status", "--porcelain"], checkout, true)
    && fs.existsSync(path.join(checkout, ".git", "index")))
    throw new Error("Self-sync checkout has local changes. Preserve and resolve them before retrying.");
  const head = await command("git", ["ls-remote", "--symref", "origin", "HEAD"], checkout, true);
  const branch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(head)?.[1];
  if (!branch) throw new Error("Cannot determine the repository default branch.");
  await command("git", ["check-ref-format", "--branch", branch], checkout);
  await command("git", ["fetch", "origin", branch], checkout);
  const localBranch = await command("git", ["branch", "--list", branch], checkout, true);
  await command("git", localBranch ? ["checkout", branch] : ["checkout", "-b", branch, `origin/${branch}`], checkout);
  await command("git", ["pull", "--ff-only", "origin", branch], checkout);
  const commit = await command("git", ["rev-parse", "HEAD"], checkout, true);
  if (commit !== await command("git", ["rev-parse", `refs/remotes/origin/${branch}`], checkout, true))
    throw new Error("Checkout contains unpushed commits. Refusing to deploy code outside the remote default branch.");
  return { branch, commit };
}
async function run(root, id) {
  if (process.platform !== "linux" || !/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid self-sync invocation.");
  const directory = path.join(root, "shared", "self-deployment"), file = path.join(directory, "status.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  if (receipt.id !== id || receipt.phase !== "running") throw new Error("Self-sync receipt changed.");
  const persist = () => {
    fs.writeFileSync(file + ".tmp", JSON.stringify(receipt), { mode: 0o600, flush: true });
    fs.renameSync(file + ".tmp", file);
  };
  const log = line => {
    const message = redactServerLog(line);
    console.log(message);
    receipt.logs.push({ at: Date.now(), message: message.slice(0, 4096) });
    receipt.logs = receipt.logs.slice(-200); persist();
  };
  const command = (program, args, cwd, capture = false) => new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
    const read = stream => {
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", chunk => {
        if (capture && stream === child.stdout) {
          output += chunk;
          if (output.length > 1024 * 1024) child.kill("SIGTERM");
        }
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) if (line && (!capture || stream === child.stderr)) log(line);
        if (pending.length > 65536) { if (!capture || stream === child.stderr) log(pending.slice(0, 4096)); pending = ""; }
      });
      stream.on("end", () => { if (pending && (!capture || stream === child.stderr)) log(pending); });
    };
    read(child.stdout); read(child.stderr);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${program} failed (exit ${code}). Inspect the self-sync log and server Git/sudo access.`));
    });
  });
  const prepared = path.join(directory, id);
  try {
    if (fs.existsSync(path.join(root, "shared", "site-sync.lock"))) throw new Error("Site sync is locked; finish recovery first.");
    const current = fs.realpathSync(path.join(root, "current"));
    const assignment = JSON.parse(fs.readFileSync(path.join(current, ".deployment-hosts.json"), "utf8"));
    if (!assignment.primary || !assignment.hosts.includes("admin.featheral.com")) throw new Error("This is not the Admin server.");
    const checkout = path.join(directory, "checkout");
    log("Fetching the repository default branch. Server Git credentials must already be configured.");
    const { branch, commit } = await updateCheckout(checkout, command);
    receipt.commit = commit; receipt.branch = branch; persist();
    fs.mkdirSync(prepared, { mode: 0o700 });
    log(`Building fresh release from ${branch} at ${commit}. Existing private data and published pages are preserved.`);
    const archive = await prepareRelease(checkout, releaseFiles(checkout), JSON.stringify({ integrated: [], managed: [] }), prepared);
    const releaseId = `release-${Date.now()}-${commit.slice(0, 12)}`;
    process.env.FEATHERAL_BOOTSTRAP_FILE = path.join(root, "shared", "bootstrap", "bootstrap.json");
    const { OperationsSettings } = require("../services/operations/settings");
    const settings = new OperationsSettings({ root: current });
    await command("/bin/bash", [archive.installer.file, root, releaseId, settings.value.tlsEmail,
      assignment.hosts.join(" "), String(settings.value.uploadLimitMiB), String(settings.value.requestTimeoutSeconds),
      "true", archive.file, archive.hash, "self"], current);
    receipt.phase = "complete"; receipt.running = false; receipt.release = releaseId;
    receipt.message = "Default branch pulled, fresh release built and restarted; deployment health verified.";
    log(receipt.message);
  } catch (error) {
    receipt.phase = "failed"; receipt.running = false; receipt.message = error.message;
    log(`Self-sync failed: ${error.message}`); throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString(); persist();
    if (fs.existsSync(prepared)) fs.rmSync(prepared, { recursive: true });
  }
}
if (require.main === module) run(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, updateCheckout };
