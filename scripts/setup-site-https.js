"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { probeTargetSite } = require("./restore-site-sync");

const certificateErrors = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ECONNREFUSED"]);
function command(program, args) {
  const result = spawnSync(program, args, { stdio: "inherit", timeout: 300000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.signal || result.status}). Check the target Nginx/Certbot logs.`);
}
async function setupSiteHTTPS(root, hosts, email, {
  probe = probeTargetSite, run = command, log = console.log,
  nginxFile = "/etc/nginx/sites-available/featheral",
} = {}) {
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length
    || hosts.some(host => typeof host !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)))
    throw new Error("Invalid reviewed HTTPS hostnames.");
  const release = fs.realpathSync(path.join(root, "current"));
  const assignment = JSON.parse(fs.readFileSync(path.join(release, ".deployment-hosts.json"), "utf8"));
  if (!Array.isArray(assignment.hosts) || hosts.some(host => !assignment.hosts.includes(host)))
    throw new Error("Deploy the current release before syncing. Target deployment is missing assigned sites; HTTPS setup cannot enable undeployed hosts.");
  const missing = [];
  for (const host of hosts) {
    try { await probe(host, "/"); }
    catch (error) {
      if (!certificateErrors.has(error.code)) throw new Error(`HTTPS check failed for ${host}: ${error.message}`, { cause: error });
      missing.push(host);
      log(`HTTPS setup needed for ${host}: ${error.code}.`);
    }
  }
  if (!missing.length) { log("Assigned site certificates are valid; preserving existing HTTPS configuration."); return; }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Set a certificate registration email in Admin Settings before syncing a site without HTTPS.");
  const original = fs.readFileSync(nginxFile, "utf8");
  const configured = [...original.matchAll(/^\s*server_name\s+([^;]+);/gm)].flatMap(match => match[1].trim().split(/\s+/));
  if (!original.startsWith("# Featheral managed gateway") || hosts.some(host => !configured.includes(host)))
    throw new Error("Reviewed hosts are missing from the managed Nginx gateway. Deploy the current release before syncing.");
  run("nginx", ["-t"]);
  try {
    log(`Provisioning HTTPS for reviewed target hosts: ${hosts.join(", ")}. DNS must point to this server and port 80 must be reachable.`);
    run("certbot", ["--nginx", "--non-interactive", "--agree-tos", "--keep-until-expiring", "--expand",
      "--email", email, "--redirect", ...hosts.flatMap(host => ["-d", host])]);
    run("nginx", ["-t"]);
    run("systemctl", ["reload", "nginx"]);
    run("systemctl", ["enable", "--now", "certbot.timer"]);
    run("systemctl", ["is-active", "--quiet", "certbot.timer"]);
    for (const host of hosts) await probe(host, "/");
    log("Reviewed HTTPS certificates and automatic renewal verified. Checking application routes next.");
  } catch (error) {
    fs.writeFileSync(nginxFile, original);
    try { run("nginx", ["-t"]); run("systemctl", ["reload", "nginx"]); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], "HTTPS setup failed and Nginx restoration could not be verified. Inspect target logs before retrying."); }
    throw new Error(`HTTPS setup failed; previous managed Nginx configuration restored. ${error.message}`, { cause: error });
  }
}
if (require.main === module) {
  if (process.getuid?.() !== 0) { console.error("HTTPS setup requires the saved target sudo/root credential."); process.exitCode = 1; }
  else setupSiteHTTPS(process.argv[2], JSON.parse(process.argv[3]), process.argv[4])
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { setupSiteHTTPS };
