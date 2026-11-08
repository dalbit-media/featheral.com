"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../../sites/wallet.featheral.com/wallet-app.js"), "utf8");
const { resetWalletLocalData } = vm.runInNewContext(source.slice(0, source.indexOf("async function mountFeatheralWallet")) + "\n({ resetWalletLocalData })");
function storage(entries) {
  const data = new Map(entries);
  return { data, get length() { return data.size; }, key: index => [...data.keys()][index] || null,
    getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
test("local reset revokes both wallet sessions and active built-in session, preserves recovery data and unrelated storage", async () => {
  const local = storage([["featheral-creation-token", "standalone"], ["featheral-context-wallet-token", "context"],
    ["featheral-wallet-public-account", "address"], ["featheral-world-account", "game-account"],
    ["featheral.world.session.address", "delegated-key"], ["featheral-encrypted-wallet-v1", "encrypted-backup"],
    ["terra-world-v1", "legacy-save"], ["unrelated-app", "keep"]]);
  const session = storage([["featheral-world-media-session", "media-token"], ["other-app", "keep"]]);
  const revoked = []; let signedOut = false;
  await resetWalletLocalData(local, session, async token => revoked.push(token), async () => { signedOut = true; }, "active-built-in");
  assert.deepEqual(revoked, ["active-built-in", "standalone", "context"]);
  assert.equal(signedOut, true);
  assert.deepEqual([...local.data], [["featheral-encrypted-wallet-v1", "encrypted-backup"], ["terra-world-v1", "legacy-save"],
    ["unrelated-app", "keep"], ["featheral-wallet-reset", "1"]]);
  assert.deepEqual([...session.data], [["other-app", "keep"]]);
});
test("failed logout does not silently clear local credentials or report a successful reset", async () => {
  for (const failAt of ["wallet", "world"]) {
    const local = storage([["featheral-context-wallet-token", "token"], ["featheral-wallet-public-account", "address"]]);
    const before = [...local.data];
    await assert.rejects(resetWalletLocalData(local, storage([]), async () => { if (failAt === "wallet") throw new Error("Wallet logout unavailable"); },
      async () => { if (failAt === "world") throw new Error("World logout unavailable"); }), /logout unavailable/);
    assert.deepEqual([...local.data], before);
  }
});
test("reset de-duplicates active and stored sessions and exposes storage failures", async () => {
  const local = storage([["featheral-context-wallet-token", "same"]]), revoked = [];
  await resetWalletLocalData(local, storage([]), async token => revoked.push(token), async () => {}, "same");
  assert.deepEqual(revoked, ["same"]);
  local.removeItem = () => { throw new Error("Storage denied"); };
  await assert.rejects(resetWalletLocalData(local, storage([]), async () => {}, async () => {}), /Storage denied/);
});
