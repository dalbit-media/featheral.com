"use strict";
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const fail = message => Object.assign(new Error(message), { status: 400 });
const fields = [];
const add = (group, names, type = "text", secret = false, extra = {}) => {
  for (const name of names.split(" ")) fields.push({ name, group, type, secret, ...extra });
};
add("Server & storage", "HOST");
add("Server & storage", "PORT", "integer", false, { min: 1, max: 65535 });
add("Server & storage", "APP_ORIGIN", "url");
add("Server & storage", "DB_LEDGER_DIR DB_WALLET_PROFILES_FILE DOLLAR_GAME_DIR WORLD_DB_FILE", "path");
add("Admin & users", "FEATHERAL_ADMIN_WALLETS WORLD_MODERATORS", "addresses");
add("Admin & users", "ADMIN_CONFIG_JSON", "json");
add("App push & calls", "APP_VAPID_PUBLIC_KEY");
add("App push & calls", "APP_VAPID_PRIVATE_KEY APP_TURN_SECRET", "text", true);
add("App push & calls", "APP_ICE_URLS", "ice");
add("Silver", "SILVER_CODE_KEY", "hex32", true);
add("Gold & Ethereum", "GOLD_API_RPC_URL TOKEN_API_RPC_URL", "url", true);
add("Gold & Ethereum", "GOLD_API_BRIDGE_ADDRESS TOKEN_API_BRIDGE_ADDRESS TOKEN_API_GAME_SERVICE_ADDRESS", "address");
add("Gold & Ethereum", "GOLD_API_CORS_ORIGINS TOKEN_API_CORS_ORIGINS", "origins");
add("Gold & Ethereum", "TOKEN_API_CONFIRMATIONS", "integer", false, { min: 1, max: 256 });
add("Gold & Ethereum", "TOKEN_API_REDEMPTION_CANCEL_GRACE_MS", "integer", false, { min: 0, max: 2147483647 });
add("Gold & Ethereum", "TOKEN_API_SERVICES_JSON", "json", true);
add("Gold & Ethereum", "BRIDGE_DEPLOYER_PRIVATE_KEY", "hex32", true);
add("Gold reserve", "GOLD_RESERVE_MODE", "enum", false, { options: ["disabled", "isolated", "live"] });
add("Gold reserve", "GOLD_RESERVE_TEST_DIR", "path");
for (const prefix of ["FTH_LEDGER", "WORLD_LEDGER"]) {
  const group = prefix === "FTH_LEDGER" ? "Dollar ledger" : "World ledger";
  add(group, `${prefix}_MODE`, "enum", false, { options: ["unconfigured", "writer", "reader"] });
  add(group, `${prefix}_NODE_ID`);
  add(group, `${prefix}_DIR`, "path");
  add(group, `${prefix}_BLOCK_INTERVAL_MS`, "integer", false, { min: 0, max: 2147483647 });
  add(group, `${prefix}_SYNC_INTERVAL_MS`, "integer", false, { min: 100, max: 2147483647 });
  add(group, `${prefix}_UPSTREAM_URL`, "url", true);
  add(group, `${prefix}_SIGNING_PRIVATE_KEY`, "privatePem", true);
  add(group, `${prefix}_WRITER_PUBLIC_KEY`, "publicPem");
}
for (const chain of [1, 8453, 42161, 10, 324, 59144]) add("Wallet RPC", `WALLET_RPC_${chain}`, "url", true);
const byName = new Map(fields.map(field => [field.name, field]));
const settingsControls = [
  ["HOST", null, "Listen address"], ["PORT", null, "HTTP port"],
  ["FEATHERAL_ADMIN_WALLETS", null, "Administrator wallets"],
  ["APP_ORIGIN", "world.featheral.com", "Public World origin"],
  ["APP_ICE_URLS", "app.featheral.com", "Call STUN / TURN servers"],
  ["APP_TURN_SECRET", "app.featheral.com", "Call server secret"],
  ["APP_VAPID_PUBLIC_KEY", "app.featheral.com", "Push public key"],
  ["APP_VAPID_PRIVATE_KEY", "app.featheral.com", "Push private key"],
  ["SILVER_CODE_KEY", "silver.featheral.com", "Product code encryption key"],
  ["GOLD_API_RPC_URL", "gold.featheral.com", "Ethereum RPC URL"],
  ["GOLD_API_BRIDGE_ADDRESS", "gold.featheral.com", "Bridge contract"],
  ["GOLD_RESERVE_MODE", "gold.featheral.com", "Reserve mode"],
  ["WORLD_MODERATORS", "media.featheral.com", "Moderator wallets"],
  ["DB_LEDGER_DIR", "db.featheral.com", "Journal storage directory"],
  ["DB_WALLET_PROFILES_FILE", "db.featheral.com", "Wallet profile database"],
  ...[1, 8453, 42161, 10, 324, 59144].map((chain, index) =>
    [`WALLET_RPC_${chain}`, "wallet.featheral.com", `${["Ethereum", "Base", "Arbitrum", "Optimism", "ZKsync", "Linea"][index]} RPC URL`]),
].map(([name, site, label]) => ({ ...byName.get(name), site, label }));
function normalizeConfiguration(input, existing = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Runtime configuration must be an object.");
  const output = { ...existing };
  for (const [name, value] of Object.entries(input)) {
    const field = byName.get(name);
    if (!field) throw fail(`Unsupported runtime setting: ${name}`);
    if (value === null || value === "") { delete output[name]; continue; }
    if (typeof value !== "string" || Buffer.byteLength(value) > 65536 || value.includes("\0")) throw fail(`Invalid ${name}.`);
    const invalid = () => { throw fail(`Invalid ${name}; expected ${field.type}.`); };
    try {
      if (field.type !== "privatePem" && field.type !== "publicPem" && field.type !== "json" && /[\r\n]/.test(value)) invalid();
      if (field.type === "integer" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < field.min || Number(value) > field.max)) invalid();
      if (field.type === "enum" && !field.options.includes(value)) invalid();
      if (field.type === "url") {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) invalid();
        if (name === "APP_ORIGIN" && url.origin !== value) invalid();
      }
      if (name.endsWith("_NODE_ID") && !/^[a-zA-Z0-9._-]{1,100}$/.test(value)) invalid();
      if (field.type === "hex32" && !(name === "SILVER_CODE_KEY" ? /^[a-fA-F0-9]{64}$/ : /^(?:0x)?[a-fA-F0-9]{64}$/).test(value)) invalid();
      if (field.type === "address" && !ethers.isAddress(value)) invalid();
      if (field.type === "addresses" && value.split(",").some(item => !ethers.isAddress(item.trim()))) invalid();
      if (field.type === "origins" && value.split(",").some(item => new URL(item.trim()).origin !== item.trim())) invalid();
      if (field.type === "ice" && value.split(",").some(item => !/^(?:stun|stuns|turn|turns):[^\s]+$/.test(item.trim()))) invalid();
      if (field.type === "json") {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
        if (name === "TOKEN_API_SERVICES_JSON") require("../identity/auth").readTrustedServices(value);
        if (name === "ADMIN_CONFIG_JSON") {
          const allowed = new Set(["brand", "siteKey", "allowSync", "publicBrand", "publicTagline", "cmsHost", "publicHost", "ageGate", "siteManagement", "sampleSites"]);
          if (Object.keys(parsed).some(key => !allowed.has(key))) invalid();
          for (const [key, item] of Object.entries(parsed)) {
            if (["allowSync", "ageGate", "siteManagement", "sampleSites"].includes(key)) {
              if (typeof item !== "boolean") invalid();
            } else if (item !== null && typeof item !== "string") invalid();
          }
        }
      }
      if (field.type === "privatePem" && crypto.createPrivateKey(value).asymmetricKeyType !== "ed25519") invalid();
      if (field.type === "publicPem" && crypto.createPublicKey(value).asymmetricKeyType !== "ed25519") invalid();
    } catch { invalid(); }
    output[name] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 350000) throw fail("Runtime configuration exceeds the 350 KB storage limit.");
  if (Object.hasOwn(input, "APP_VAPID_PUBLIC_KEY") || Object.hasOwn(input, "APP_VAPID_PRIVATE_KEY")) {
    if (Boolean(output.APP_VAPID_PUBLIC_KEY) !== Boolean(output.APP_VAPID_PRIVATE_KEY)) throw fail("Set or clear both VAPID keys together.");
    if (output.APP_VAPID_PUBLIC_KEY) {
      const ecdh = crypto.createECDH("prime256v1");
      try {
        ecdh.setPrivateKey(Buffer.from(output.APP_VAPID_PRIVATE_KEY, "base64url"));
        if (ecdh.getPublicKey().toString("base64url") !== output.APP_VAPID_PUBLIC_KEY) throw new Error("Mismatch");
      } catch { throw fail("VAPID public and private keys must be a matching P-256 key pair."); }
    }
  }
  return output;
}
function environmentConfiguration(env) {
  const values = {};
  for (const field of fields) if (env[field.name]) values[field.name] = env[field.name];
  for (const suffix of ["MODE", "NODE_ID", "DIR", "BLOCK_INTERVAL_MS", "SYNC_INTERVAL_MS", "UPSTREAM_URL", "SIGNING_PRIVATE_KEY", "WRITER_PUBLIC_KEY"])
    if (!values[`FTH_LEDGER_${suffix}`] && env[`TOKEN_LEDGER_${suffix}`]) values[`FTH_LEDGER_${suffix}`] = env[`TOKEN_LEDGER_${suffix}`];
  return normalizeConfiguration(values);
}
function assertDatabaseConfiguration(root, env = process.env) {
  const legacy = Object.keys(env).filter(name => byName.has(name)
    || name === "CMS_PASSWORD" || name === "ADMIN_CONFIG" || name === "DB_VAULT_KEY_FILE"
    || name === "SERVER_PROFILE_NETWORK_LIMIT_BPS" || name.startsWith("DEPLOY_") || name.startsWith("TOKEN_LEDGER_"));
  if (require("node:fs").existsSync(require("node:path").join(root, ".env")) || legacy.length)
    throw new Error(`Legacy application configuration found${legacy.length ? ` (${legacy.join(", ")})` : ""}. Stop the service, migrate a private .env with scripts/init-settings.js --migrate-env (add --setup for first-run Admin enrollment or legacy SSH-key configuration), and remove application environment overrides before restarting.`);
}
module.exports = { fields: Object.freeze(fields), settingsControls: Object.freeze(settingsControls), normalizeConfiguration, environmentConfiguration, assertDatabaseConfiguration };
