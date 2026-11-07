"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { approvedMarketExpansion } = require("../services/gold/market-expansion");

function readPolicy(root, runtimeRoot = root) {
  const script = `
    const path = require("node:path");
    const root = process.cwd();
    const runtimeRoot = process.argv[1];
    const { OperationsSettings } = require(path.join(runtimeRoot, "services/operations/settings"));
    const settings = new OperationsSettings({ root: runtimeRoot });
    const env = settings.environment();
    const { monetaryPolicy } = require(path.join(root, "sites/world.featheral.com/play/src/monetary-policy.ts"));
    const { collectionPolicy } = require(path.join(root, "sites/world.featheral.com/play/src/collection.ts"));
    const funds = env.GOLD_RESERVE_MODE === "live" ? require(path.join(root, "services/notes/game-funds")) : null;
    const markets = funds ? (funds.authorizedLiquidityTargets || funds.liquidityTargets)() : null;
    process.stdout.write(JSON.stringify({ monetaryPolicy, collectionPolicy, markets }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script, runtimeRoot], {
    cwd: root, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_PATH: [path.join(runtimeRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
  }));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function verifyCompatibility(candidate, previous, { policy = readPolicy } = {}) {
  const next = policy(candidate);
  const original = previous ? policy(previous) : null;
  for (const value of previous ? [next, original] : [next]) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid deployment policy preflight response; activation refused before gateway cutover.");
    for (const field of ["monetaryPolicy", "collectionPolicy", "markets"]) {
      if (!Object.hasOwn(value, field) || (field !== "markets" || value[field] !== null)
        && (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])))
        throw new Error(`Invalid or missing ${field} in deployment policy preflight. Activation refused before gateway cutover.`);
    }
  }
  if (!previous) return;
  for (const [field, label] of [["monetaryPolicy", "Permanent monetary policy"], ["collectionPolicy", "Permanent collection policy"], ["markets", "Live reserve authority market policy"]]) {
    if (JSON.stringify(canonical(next[field])) !== JSON.stringify(canonical(original[field]))
      && !(field === "markets" && approvedMarketExpansion(original.markets, next.markets)))
      throw new Error(`${label} differs from the running release. Activation refused; the working gateway has not been stopped. Preserve the original policy; do not reset ledger data or keys.`);
  }
  return { marketExpansion: approvedMarketExpansion(original.markets, next.markets) };
}
function preflight(candidate, previous) {
  candidate = fs.realpathSync(candidate);
  if (previous) previous = fs.realpathSync(previous);
  for (const file of ["scripts/serve.js", "ecosystem.config.cjs"]) {
    execFileSync(process.execPath, ["--check", path.join(candidate, file)], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  }
  const assignment = JSON.parse(fs.readFileSync(path.join(candidate, ".deployment-hosts.json"), "utf8"));
  if (!Array.isArray(assignment.hosts) || !assignment.hosts.length || assignment.hosts.some(host => typeof host !== "string"
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)))
    throw new Error("Invalid deployment hostname assignment; activation refused before gateway cutover.");
  const result = !(assignment.hosts.length === 1 && assignment.hosts[0] === "db.featheral.com") && verifyCompatibility(candidate, previous);
  if (result?.marketExpansion) fs.writeFileSync(path.join(candidate, ".deployment-market-authorization.pending"), "approved-identity-collectors-v1\n", { mode: 0o600 });
  console.log("Candidate syntax, runtime Settings and pinned financial policies verified before gateway cutover.");
}
if (require.main === module) {
  try { preflight(...process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    // Runtime-load diagnostics are useful, but must not print the child environment.
    if (error.stderr) console.error(require("../services/cms/lib/deployment").redactServerLog(String(error.stderr)));
    process.exitCode = 1;
  }
}
module.exports = { readPolicy, verifyCompatibility, preflight };
