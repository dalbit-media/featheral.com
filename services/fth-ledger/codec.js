"use strict";

const crypto = require("node:crypto");

const ZERO_HASH = "0x" + "0".repeat(64);

// Minified canonical JSON: object keys sorted recursively, no whitespace. Every node derives the
// same bytes (and therefore the same hashes) from the same block regardless of key insertion order.
function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Ledger numbers must be safe integers.");
    if (typeof value === "bigint") throw new Error("Ledger amounts must be decimal strings.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(text) {
  return "0x" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function txHash(tx) {
  return sha256(canonical(tx));
}

function blockHash(block) {
  return sha256(canonical({ h: block.h, t: block.t, p: block.p, x: block.x }));
}

module.exports = { ZERO_HASH, canonical, sha256, txHash, blockHash };
