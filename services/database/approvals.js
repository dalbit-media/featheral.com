"use strict";
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { SOURCE_ADDRESS } = require("../gold/reserve");
const { canonical } = require("../fth-ledger/codec");
const { fail } = require("./journal");
class OriginApprovals {
  constructor({ wallet = SOURCE_ADDRESS, now = Date.now } = {}) {
    this.wallet = ethers.getAddress(wallet); this.now = now;
    this.key = crypto.randomBytes(32); this.pending = new Map();
  }
  binding(action, value, context) {
    if (!context?.origin || !context.session) throw fail(403, "An authenticated Admin session is required.");
    return crypto.createHmac("sha256", this.key).update(canonical({ action, value, origin: context.origin, session: context.session })).digest("hex");
  }
  challenge(action, value, context, target) {
    const binding = this.binding(action, value, context), now = this.now(), expiresAt = now + 300000;
    for (const [id, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(id);
    if (this.pending.size >= 1000) throw fail(429, "Too many pending approvals. Wait five minutes.");
    const challengeId = crypto.randomUUID();
    const message = ["Featheral database credential authorization", "", `Action: ${action}`, `Origin: ${context.origin}`,
      `Target: ${target}`, `Wallet: ${this.wallet}`, `Nonce: ${challengeId}`,
      `Issued at: ${new Date(now).toISOString()}`, `Expires at: ${new Date(expiresAt).toISOString()}`,
      "Approve only the operation prepared in this Admin session.",
      "No Ethereum transaction. Never disclose your wallet private key."].join("\n");
    this.pending.set(challengeId, { binding, message, expiresAt });
    return { challengeId, message, wallet: this.wallet, expiresAt, target };
  }
  consume(action, value, context, input) {
    const item = this.pending.get(input?.challengeId);
    this.pending.delete(input?.challengeId);
    if (!item || item.expiresAt <= this.now() || item.binding !== this.binding(action, value, context))
      throw fail(403, "Approval expired or does not match the exact action, credential, target and Admin session.");
    let signer;
    try { signer = ethers.verifyMessage(item.message, input.signature); } catch { throw fail(403, "Invalid wallet signature."); }
    if (signer !== this.wallet) throw fail(403, "Only the FTHG origin wallet may authorize server credentials.");
  }
}
module.exports = { OriginApprovals };
