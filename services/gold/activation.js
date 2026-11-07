"use strict";

const crypto = require("node:crypto");
const { canonical } = require("../fth-ledger/codec");
const { approvedMarketExpansion } = require("./market-expansion");

function activateLiveReserve(ledger, gamePrivateKey, goldPublicKey, goldMarkets, goldPrivateKey, { deferExpansion = false } = {}) {
  if (ledger.genesis.goldPublicKey) {
    if (ledger.genesis.goldPublicKey !== goldPublicKey || ledger.genesis.reserveMode !== "live") {
      throw new Error("Existing live reserve authority or market policy differs. Restore the original keys and policy.");
    }
    if (canonical(ledger.genesis.goldMarkets) !== canonical(goldMarkets)) {
      if (!goldPrivateKey || !approvedMarketExpansion(ledger.genesis.goldMarkets, goldMarkets))
        throw new Error("Existing live reserve market policy differs without an approved additive authorization. Restore the original policy.");
      const tx = { i: `gold:markets:${crypto.createHash("sha256").update(canonical(goldMarkets)).digest("hex")}`,
        k: "GOLD_MARKETS", a: "", v: "0", d: { goldMarkets, previousTip: ledger.tipHash }, t: Date.now() };
      const message = Buffer.from(canonical(tx));
      tx.d.gameSignature = crypto.sign(null, message, gamePrivateKey).toString("base64");
      tx.d.goldSignature = crypto.sign(null, message, goldPrivateKey).toString("base64");
      if (deferExpansion) ledger.applyTx(tx, { validateOnly: true });
      else ledger.commitAuthorized(tx);
    }
    return;
  }
  const tx = { i: "gold:live-policy", k: "GOLD_POLICY", a: "", v: "0",
    d: { goldPublicKey, goldMarkets, mode: "live", previousTip: ledger.tipHash }, t: Date.now() };
  tx.d.signature = crypto.sign(null, Buffer.from(canonical(tx)), gamePrivateKey).toString("base64");
  ledger.commitAuthorized(tx);
}

module.exports = { activateLiveReserve };
