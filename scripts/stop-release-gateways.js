"use strict";
const fs = require("node:fs");
const path = require("node:path");

function processIdentity(pid, roots, { filesystem = fs, proc = "/proc", uid = typeof process.getuid === "function" ? process.getuid() : undefined } = {}) {
  const directory = path.join(proc, String(pid));
  try {
    if (uid !== undefined && filesystem.statSync(directory).uid !== uid) return null;
    const executable = filesystem.readlinkSync(path.join(directory, "exe"));
    if (!/^node(?:js)?$/.test(path.basename(executable))) return null;
    const cwd = filesystem.realpathSync(path.join(directory, "cwd"));
    if (!roots.includes(cwd)) return null;
    const args = filesystem.readFileSync(path.join(directory, "cmdline"), "utf8").split("\0").filter(Boolean);
    // Match only the gateway entrypoint, never arbitrary Node/npm processes or port owners.
    if (args.length !== 2 || path.resolve(cwd, args[1]) !== path.join(cwd, "scripts", "serve.js")) return null;
    const stat = filesystem.readFileSync(path.join(directory, "stat"), "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^\d+$/.test(start)) throw new Error(`Cannot verify gateway process identity for PID ${pid}.`);
    return { pid, cwd, start };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

async function stopReleaseGateways(releases, {
  filesystem = fs, proc = "/proc", signal = process.kill, timeoutMs = 30000,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log,
} = {}) {
  const roots = [...new Set(releases.filter(Boolean).map(root => filesystem.realpathSync(root)))];
  if (!roots.length) throw new Error("A managed release directory is required.");
  const options = { filesystem, proc };
  const gateways = filesystem.readdirSync(proc).filter(name => /^[1-9]\d*$/.test(name))
    .map(name => processIdentity(Number(name), roots, options)).filter(Boolean);
  for (const gateway of gateways) {
    const current = processIdentity(gateway.pid, roots, options);
    if (!current || current.start !== gateway.start || current.cwd !== gateway.cwd) continue;
    log(`Stopping verified prior release gateway PID ${gateway.pid}.`);
    try { signal(gateway.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = now() + timeoutMs;
  while (gateways.some(gateway => {
    const current = processIdentity(gateway.pid, roots, options);
    return current && current.start === gateway.start && current.cwd === gateway.cwd;
  })) {
    if (now() >= deadline) throw new Error("Prior release gateway did not exit after SIGTERM. Refusing to start a competing financial writer; inspect the verified process.");
    await wait(100);
  }
}

if (require.main === module) {
  if (process.platform !== "linux") throw new Error("Release gateway shutdown requires Linux /proc.");
  stopReleaseGateways(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { processIdentity, stopReleaseGateways };
