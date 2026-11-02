"use strict";
const fs = require("node:fs");
const path = require("node:path");

function profileError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

function createWalletProfiles(sqlite, file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = sqlite.open(file);
  db.exec(db.readOnlyReplica ? "PRAGMA busy_timeout = 5000;" : "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_profiles (
      address TEXT PRIMARY KEY COLLATE NOCASE,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      avatar TEXT NOT NULL,
      bio TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT ''
    );
  `);

  function get(address) {
    if (typeof address !== "string") return null;
    return db.prepare("SELECT address, username, avatar, bio, issued_at AS issuedAt FROM wallet_profiles WHERE address = ?").get(address.toLowerCase()) || null;
  }

  function owner(username) {
    if (typeof username !== "string") return "";
    return db.prepare("SELECT address FROM wallet_profiles WHERE username = ? COLLATE NOCASE").get(username.replace(/^@/, ""))?.address || "";
  }

  function write(profile, importing = false) {
    if (!profile || typeof profile.address !== "string" || typeof profile.username !== "string"
      || typeof profile.avatar !== "string" || typeof profile.issuedAt !== "string"
      || profile.bio !== undefined && typeof profile.bio !== "string"
      || profile.signature !== undefined && typeof profile.signature !== "string") {
      throw new TypeError("A validated wallet profile is required.");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const address = profile.address.toLowerCase();
      const previous = get(address);
      const issuedAt = Date.parse(profile.issuedAt);
      const previousAt = previous ? Date.parse(previous.issuedAt) : -1;
      if (!Number.isFinite(issuedAt)) throw new TypeError("Wallet profile issuedAt must be a valid timestamp.");
      if (previous && previousAt >= issuedAt) {
        const same = previousAt === issuedAt && previous.username === profile.username
          && previous.avatar === profile.avatar && previous.bio === (profile.bio ?? previous.bio);
        if (importing && (previousAt > issuedAt || same)) {
          db.exec("COMMIT");
          return { profile: previous, duplicate: true };
        }
        if (!importing && same) {
          db.exec("COMMIT");
          return { profile: previous, duplicate: true };
        }
        throw profileError("A newer or conflicting wallet profile already exists.");
      }
      const usernameOwner = owner(profile.username);
      if (usernameOwner && usernameOwner.toLowerCase() !== address) throw profileError("Username is already taken.");
      const saved = {
        address: profile.address,
        username: profile.username,
        avatar: profile.avatar,
        bio: profile.bio ?? previous?.bio ?? "",
        issuedAt: profile.issuedAt,
        signature: profile.signature || previous?.signature || "",
      };
      db.prepare(`INSERT INTO wallet_profiles(address, username, avatar, bio, issued_at, signature)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET username=excluded.username, avatar=excluded.avatar,
          bio=excluded.bio, issued_at=excluded.issued_at, signature=excluded.signature`)
        .run(saved.address, saved.username, saved.avatar, saved.bio, saved.issuedAt, saved.signature);
      db.exec("COMMIT");
      return { profile: saved, duplicate: false };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
      if (/UNIQUE constraint failed/i.test(error.message)) {
        throw profileError("Username is already taken.");
      }
      throw error;
    }
  }

  return Object.freeze({
    get,
    owner,
    save(profile) { return write(profile); },
    importLegacy(profile) { return write(profile, true); },
    close() { db.close(); },
  });
}

module.exports = { createWalletProfiles };
