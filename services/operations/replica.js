"use strict";
const fs = require("node:fs");
const path = require("node:path");
const MARKER = "site-sync-replica.json";
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
  res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "This server is a read-only snapshot replica. Send writes to the source server." }));
  return false;
}
module.exports = { MARKER, readReplica, replicaEnvironment, allowReplicaRequest };
