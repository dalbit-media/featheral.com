"use strict";

const crypto = require("node:crypto");
const { ethers } = require("ethers");

const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/;
const MAX_AVATAR_BYTES = 40 * 1024;
const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;
const AVATAR_TYPES = {
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

function profileError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function avatarDigest(avatar) {
  return avatar ? crypto.createHash("sha256").update(avatar, "utf8").digest("hex") : "none";
}

// The browser builds the identical text, so wallets show users exactly what they authorize.
function profileMessage({ address, username, avatar, issuedAt }) {
  return [
    "Featheral profile update",
    "",
    `Address: ${address}`,
    `Username: ${username}`,
    `Avatar: ${avatarDigest(avatar)}`,
    `Issued at: ${issuedAt}`,
    "Chain ID: 1",
    "",
    "Signing is free and does not send a transaction.",
  ].join("\n");
}

function validateAvatar(avatar) {
  if (avatar === "") return;
  if (typeof avatar !== "string") throw profileError("avatar must be a data URL string or empty.");
  const match = avatar.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw profileError("avatar must be a base64 PNG, JPEG, or WebP data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) throw profileError(`avatar must be at most ${MAX_AVATAR_BYTES / 1024} KiB.`);
  if (!AVATAR_TYPES[match[1]](bytes)) throw profileError("avatar content does not match its declared image type.");
}

// Verifies everything that must hold on every node, including replicas importing the event later.
function verifySignedProfile(input) {
  if (!input || typeof input !== "object") throw profileError("Profile body is required.");
  if (typeof input.address !== "string" || !ethers.isAddress(input.address)) throw profileError("address must be a valid Ethereum address.");
  const signedAddress = input.address;
  const address = ethers.getAddress(signedAddress);
  if (address === ethers.ZeroAddress) throw profileError("address cannot be the zero address.");
  if (typeof input.username !== "string" || !USERNAME_PATTERN.test(input.username)) {
    throw profileError("username must be 3-24 characters: letters, numbers, underscore, dot, or hyphen, starting with a letter, number, or underscore.");
  }
  const avatar = input.avatar ?? "";
  validateAvatar(avatar);
  const issuedAtMs = Date.parse(input.issuedAt);
  if (typeof input.issuedAt !== "string" || !Number.isFinite(issuedAtMs) || new Date(issuedAtMs).toISOString() !== input.issuedAt) {
    throw profileError("issuedAt must be an ISO-8601 UTC timestamp.");
  }
  if (typeof input.signature !== "string" || !ethers.isHexString(input.signature)) throw profileError("signature must be a hex string.");
  const profile = { address, username: input.username, avatar, issuedAt: input.issuedAt };
  let signer;
  try {
    signer = ethers.verifyMessage(profileMessage({ ...profile, address: signedAddress }), input.signature);
  } catch {
    throw profileError("Profile signature is malformed.", 401);
  }
  if (signer !== address) throw profileError("Profile signature was not made by this wallet.", 401);
  return { ...profile, signedAddress, issuedAtMs, signature: input.signature };
}

function assertFreshSignature(issuedAtMs, now = Date.now(), label = "Profile") {
  if (Math.abs(now - issuedAtMs) > SIGNATURE_WINDOW_MS) throw profileError(`${label} signature expired. Sign again.`, 401);
}

module.exports = { profileMessage, avatarDigest, verifySignedProfile, assertFreshSignature, USERNAME_PATTERN, MAX_AVATAR_BYTES };
