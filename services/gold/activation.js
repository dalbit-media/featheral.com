"use strict";

const crypto = require("node:crypto");
const { canonical } = require("../fth-ledger/codec");

function activateLiveReserve(ledger, gamePrivateKey, goldPublicKey, goldMarkets) {
  if (ledger.genesis.goldPublicKey) {
    if (ledger.genesis.goldPublicKey !== goldPublicKey || ledger.genesis.reserveMode !== "live"
      || canonical(ledger.genesis.goldMarkets) !== canonical(goldMarkets)) {
      throw new Error("Existing live reserve authority or market policy differs. Restore the original keys and policy.");
    }
    return;
  }
  const tx = { i: "gold:live-policy", k: "GOLD_POLICY", a: "", v: "0",
    d: { goldPublicKey, goldMarkets, mode: "live", previousTip: ledger.tipHash }, t: Date.now() };
  tx.d.signature = crypto.sign(null, Buffer.from(canonical(tx)), gamePrivateKey).toString("base64");
  ledger.commitAuthorized(tx);
}

module.exports = { activateLiveReserve };
