"use strict";
const fs = require("node:fs");
const path = require("node:path");
const MARKER = "site-sync-replica.json";
const CMS_ORIGIN = "site-sync-origin.json";
function validCMSOrigin(value) {
  return value && typeof value.directory === "string" && value.directory.length <= 4096
    && !/[\x00-\x1f]/.test(value.directory) && ["\\", "/"].includes(value.separator)
    && (value.separator === "\\" ? /^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/.test(value.directory)
      : path.posix.isAbsolute(value.directory));
}
function readReplica(root) {
  const file = path.join(root, "data", MARKER);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.version !== 1 || value.readOnly !== true || !value.runtime || typeof value.runtime !== "object"
    || Object.entries(value.runtime).some(([key, item]) => !["FTH_LEDGER_DIR", "WORLD_LEDGER_DIR", "DOLLAR_GAME_DIR", "WORLD_DB_FILE", "DB_LEDGER_DIR", "DB_WALLET_PROFILES_FILE"].includes(key)
      || typeof item !== "string" || !/^data\/[a-zA-Z0-9._/-]+$/.test(item) || item.split("/").includes("..")))
    throw new Error("Invalid read-only replica marker. Refusing startup.");
  return value;
}
function readCMSOrigin(root) {
  const file = path.join(root, "data", CMS_ORIGIN);
  const replica = readReplica(root);
  if (!fs.existsSync(file)) {
    if (replica?.sourceCMS && !validCMSOrigin(replica.sourceCMS)) throw new Error("Invalid CMS storage origin.");
    return replica?.sourceCMS || null;
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.version !== 1 || !validCMSOrigin(value.sourceCMS)
    || replica?.sourceCMS && (value.sourceCMS.directory !== replica.sourceCMS.directory
      || value.sourceCMS.separator !== replica.sourceCMS.separator))
    throw new Error("Invalid or conflicting CMS storage origin. Refusing to change content namespaces.");
  return value.sourceCMS;
}
function replicaEnvironment(root, environment) {
  const replica = readReplica(root);
  if (!replica) return environment;
  const output = { ...environment, FTH_LEDGER_MODE: "reader", WORLD_LEDGER_MODE: "reader",
    GOLD_RESERVE_MODE: "disabled", FTH_LEDGER_UPSTREAM_URL: "", WORLD_LEDGER_UPSTREAM_URL: "" };
  for (const [key, value] of Object.entries(replica.runtime)) output[key] = path.join(root, ...value.split("/"));
  for (const prefix of ["FTH_LEDGER", "WORLD_LEDGER"]) output[`${prefix}_WRITER_PUBLIC_KEY`] = replica.publicKeys?.[prefix] || "";
  for (const key of ["FTH_LEDGER_SIGNING_PRIVATE_KEY", "WORLD_LEDGER_SIGNING_PRIVATE_KEY", "BRIDGE_DEPLOYER_PRIVATE_KEY"])
    delete output[key];
  for (const key of Object.keys(output)) if (key.startsWith("TOKEN_LEDGER_")) delete output[key];
  return output;
}
function allowReplicaRequest(req, res, settings) {
  if (!settings.replica) return true;
  res.setHeader("X-Featheral-Replica", "read-only");
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) && !/^\/(?:api\/(?:session|chat|connect|sync)|wallet-sync)(?:\/|$)/.test(pathname)) return true;
  // Loopback Admin can orchestrate signed remote deployment, never ledger writes.
  if (req.method === "POST" && (/^\/api\/admin-auth\/(?:challenge|verify|logout)$/.test(pathname)
    || ["/api/deployment/plan", "/api/database/deployment/challenge", "/api/database/deployment/start"].includes(pathname))
    && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress)) {
    let hostname;
    try { hostname = new URL(`http://${req.headers?.host || ""}`).hostname; }
    catch { hostname = ""; }
    if (hostname === "admin.localhost") return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/pay/requests") {
    let hostname;
    try { hostname = new URL(`http://${req.headers?.host || ""}`).hostname; }
    catch { hostname = ""; }
    if (["pay.featheral.com", "pay.localhost"].includes(hostname)) return true;
  }
  res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "This server is a read-only snapshot replica. Send writes to the source server." }));
  return false;
}
module.exports = { MARKER, CMS_ORIGIN, readReplica, readCMSOrigin, replicaEnvironment, allowReplicaRequest };
