"use strict";

const { ethers } = require("ethers");

const MAX_MEMO_LENGTH = 64;
const ADDRESS_ACCOUNT_PREFIX = "0x000000000000000000000000";

function transferError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Every wallet owns exactly one FTH$ account: its address left-padded to 32 bytes. Game-only
// accounts use any other bytes32 id, and the bridge credits the same ids on-chain.
function walletAccountId(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();
}

function accountWallet(accountId) {
  const id = String(accountId).toLowerCase();
  if (!id.startsWith(ADDRESS_ACCOUNT_PREFIX) || id === ethers.ZeroHash) return "";
  return ethers.getAddress("0x" + id.slice(ADDRESS_ACCOUNT_PREFIX.length));
}

function normalizeAccount(value, name = "account") {
  if (typeof value === "string" && ethers.isAddress(value) && value.length === 42) return walletAccountId(value);
  if (typeof value === "string" && ethers.isHexString(value, 32)) return value.toLowerCase();
  throw transferError(`${name} must be a wallet address or a 32-byte FTH$ account id.`);
}

// The dollar wallet page builds the identical text; wallets show users exactly what they authorize.
function transferMessage({ wallet, to, amount, nonce, memo, issuedAt }) {
  const recipientWallet = accountWallet(to);
  return [
    "Featheral Dollar (FTH$) transfer",
    "",
    `From: ${wallet}`,
    recipientWallet ? `To: ${recipientWallet}` : `To account: ${to}`,
    `Amount: ${ethers.formatUnits(BigInt(amount), 18)} FTH$`,
    `Base units: ${amount}`,
    `Nonce: ${nonce}`,
    `Memo: ${memo || "(none)"}`,
    `Issued at: ${issuedAt}`,
    "Ledger: Featheral Dollar L3 (settles to Ethereum Mainnet)",
    "",
    "Signing is free and only authorizes this FTH$ ledger transfer.",
  ].join("\n");
}

// Checks that hold on every node, including replicas re-validating sealed blocks.
function verifyTransfer(input) {
  if (!input || typeof input !== "object") throw transferError("Transfer body is required.");
  if (typeof input.wallet !== "string" || !ethers.isAddress(input.wallet)) throw transferError("wallet must be a valid Ethereum address.");
  const wallet = ethers.getAddress(input.wallet);
  const to = normalizeAccount(input.to, "to");
  if (to === ethers.ZeroHash) throw transferError("Cannot transfer to the zero account.");
  const from = walletAccountId(wallet);
  if (to === from) throw transferError("Sender and recipient are the same account.");
  if (typeof input.amount !== "string" || !/^[1-9]\d{0,77}$/.test(input.amount)) throw transferError("amount must be a positive integer string in 18-decimal base units.");
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 1) throw transferError("nonce must be a positive integer.");
  const memo = input.memo ?? "";
  if (typeof memo !== "string" || memo.length > MAX_MEMO_LENGTH || /[\u0000-\u001f\u007f]/.test(memo)) {
    throw transferError(`memo must be at most ${MAX_MEMO_LENGTH} printable characters.`);
  }
  const issuedAtMs = Date.parse(input.issuedAt);
  if (typeof input.issuedAt !== "string" || !Number.isFinite(issuedAtMs) || new Date(issuedAtMs).toISOString() !== input.issuedAt) {
    throw transferError("issuedAt must be an ISO-8601 UTC timestamp.");
  }
  if (typeof input.signature !== "string" || !ethers.isHexString(input.signature)) throw transferError("signature must be a hex string.");
  const transfer = { wallet, from, to, amount: input.amount, nonce: input.nonce, memo, issuedAt: input.issuedAt };
  let signer;
  try {
    signer = ethers.verifyMessage(transferMessage(transfer), input.signature);
  } catch {
    throw transferError("Transfer signature is malformed.", 401);
  }
  if (signer !== wallet) throw transferError("Transfer signature was not made by the sending wallet.", 401);
  return { ...transfer, issuedAtMs, signature: input.signature };
}

module.exports = { MAX_MEMO_LENGTH, walletAccountId, accountWallet, normalizeAccount, transferMessage, verifyTransfer };
