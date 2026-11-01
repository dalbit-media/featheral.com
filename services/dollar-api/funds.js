"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonical } = require("../fth-ledger/codec");
const SYSTEM_TREASURY_ACCOUNT = `0x${crypto.createHash("sha256").update("featheral:dollar:system:treasury").digest("hex")}`;
const { REDEMPTION_ESCROW } = require("../gold-api/reserve");

function liquidityTargets() {
  const { marketAssets, isLiquidAsset, marketBasePrice, marketQuantityLimit } = require("../../sites/world/featheral/src/market.ts");
  const { dollarsUnits } = require("../../sites/world/featheral/src/dollars.ts");
  return Object.fromEntries(marketAssets.filter(isLiquidAsset).map(asset => [asset, {
    quantity: marketQuantityLimit(asset), pricePerLot: (BigInt(dollarsUnits(marketBasePrice(asset))) * 10n ** 14n).toString(),
  }]));
}

function gameSigningKey(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "game-signing-key.pem");
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  return { privateKey, publicKey: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() };
}

function ledgerFunds(ledger, privateKey, reserveEngine = null) {
  const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (ledger.genesis.gamePublicKey !== publicKey) throw new Error("Dollar ledger genesis does not authorize this game key. Use the zero-start economy or restore its original key.");
  return {
    available: (account) => ledger.balance(account).available,
    supply: () => ledger.summary().supply,
    ...(reserveEngine ? {
      ensureLiquidity: (asset, quantity, dollars) => reserveEngine.fundMarket(asset, quantity, BigInt(dollars)),
      poolSeed: asset => ledger.goldReserve?.pools[asset] || null,
    } : {}),
    prepare(entries) {
      let total = 0n;
      for (const entry of entries) total += BigInt(entry.delta);
      if (total > 0n) throw new Error("Gameplay attempted to issue FTH$.");
      const balanced = entries.map(entry => ({ ...entry }));
      if (balanced.some(entry => entry.account === SYSTEM_TREASURY_ACCOUNT || entry.account === REDEMPTION_ESCROW)) throw new Error("Gameplay cannot directly spend system treasury funds.");
      if (total < 0n) balanced.push({ account: SYSTEM_TREASURY_ACCOUNT, delta: (-total).toString() });
      const tx = { i: `game:${crypto.randomUUID()}`, k: "GAME", a: "", v: "0", d: { entries: balanced }, t: Date.now() };
      const payload = canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, entries: balanced, t: tx.t });
      tx.d.signature = crypto.sign(null, Buffer.from(payload), privateKey).toString("base64");
      ledger.applyTx(tx, { validateOnly: true });
      return tx;
    },
    commit: (tx) => ledger.commitGame(tx),
  };
}

module.exports = { gameSigningKey, ledgerFunds, SYSTEM_TREASURY_ACCOUNT, liquidityTargets };
