"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("../sqlite");
const { createWalletProfiles } = require("../wallet-profiles");

test("wallet profiles persist independently with unique usernames and monotonic updates", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-wallet-profiles-"));
  const file = path.join(directory, "profiles.sqlite");
  let profiles = createWalletProfiles(sqlite, file);
  t.after(() => {
    profiles.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = { address: "0x0000000000000000000000000000000000000001", username: "wallet_one", avatar: "", bio: "bio", issuedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(profiles.save(first).duplicate, false);
  assert.equal(profiles.save(first).duplicate, true);
  assert.equal(profiles.get(first.address.toUpperCase().replace("0X", "0x")).bio, "bio");
  assert.equal(profiles.owner("@WALLET_ONE"), first.address);
  assert.throws(() => profiles.save({ ...first, username: "new_name", issuedAt: "2025-12-31T23:59:59.000Z" }), /newer or conflicting wallet profile/i);
  assert.throws(() => profiles.save({ ...first, address: "0x0000000000000000000000000000000000000002", username: "WALLET_ONE" }), /username is already taken/i);
  const legacy = { ...first, username: "old_name", issuedAt: "2025-12-30T00:00:00.000Z" };
  assert.equal(profiles.importLegacy(legacy).duplicate, true);
  assert.equal(profiles.owner("old_name"), "");
  assert.throws(() => profiles.importLegacy({ ...first, username: "conflicting_name" }), /conflicting wallet profile/i);
  profiles.close();
  profiles = createWalletProfiles(sqlite, file);
  assert.equal(profiles.get(first.address).username, "wallet_one");
});
