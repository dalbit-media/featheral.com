"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { readPolicy, verifyCompatibility } = require("../../../scripts/deployment-preflight");
const { liquidityTargets } = require("../../notes/game-funds");
const root = path.resolve(__dirname, "../../..");
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

test("live reserve seed prices stay genesis-compatible when market floors change", () => {
  const { marketPriceFloor, marketBasePrice } = require("../../../sites/world.featheral.com/play/src/market.ts");
  const targets = liquidityTargets();
  for (const [asset, price] of Object.entries({ wood: 4, water: 2, metal: 2, oil: 24 })) {
    assert.equal(targets[asset].pricePerLot, (BigInt(price) * 10n ** 18n).toString());
    assert.equal(marketBasePrice(asset), price);
  }
  assert.equal(marketPriceFloor("oil"), .0001, "only accounting precision limits prices; reserve seeds stay unchanged");
});
test("candidate preflight compares actual module policies without starting a gateway or creating ledger keys", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = name => {
    const base = path.join(directory, name);
    for (const dir of ["services/operations", "services/notes", "sites/world.featheral.com/play/src"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
    fs.writeFileSync(path.join(base, "services/operations/settings.js"), 'exports.OperationsSettings=class{environment(){return {GOLD_RESERVE_MODE:"live"}}}');
    fs.writeFileSync(path.join(base, "services/notes/game-funds.js"), 'exports.liquidityTargets=()=>({oil:{quantity:10000,pricePerLot:"24000000000000000000"}});');
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/monetary-policy.ts"), 'export const monetaryPolicy={scale:10000};');
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/collection.ts"), 'export const collectionPolicy={version:1};');
    return base;
  };
  const previous = fixture("previous"), candidate = fixture("candidate");
  assert.deepEqual(readPolicy(previous).markets, { oil: { quantity: 10000, pricePerLot: "24000000000000000000" } });
  assert.doesNotThrow(() => verifyCompatibility(candidate, previous));
  fs.writeFileSync(path.join(candidate, "services/notes/game-funds.js"), 'exports.liquidityTargets=()=>({oil:{quantity:10000,pricePerLot:"30000000000000000000"}});');
  assert.throws(() => verifyCompatibility(candidate, previous), /Live reserve.*working gateway has not been stopped/);
  fs.unlinkSync(path.join(candidate, "services/operations/settings.js"));
  assert.throws(() => verifyCompatibility(candidate, previous, { policy: source => readPolicy(source, previous) }), /Live reserve/);
  assert.equal(fs.existsSync(path.join(candidate, "data")), false);
  assert.equal(fs.existsSync(path.join(previous, "data")), false);
});
test("preflight rejects immutable monetary and collection changes and tolerates key ordering", () => {
  const original = { monetaryPolicy: { scale: 10000, version: 1 }, collectionPolicy: { version: 1 }, markets: null };
  for (const field of ["monetaryPolicy", "collectionPolicy", "markets"]) {
    const changed = { ...original, [field]: { incompatible: true } };
    assert.throws(() => verifyCompatibility("new", "old", { policy: name => name === "new" ? changed : original }), /Activation refused/);
  }
  assert.doesNotThrow(() => verifyCompatibility("new", "old", { policy: name => name === "new"
    ? { ...original, monetaryPolicy: { version: 1, scale: 10000 } } : original }));
  for (const value of [null, {}, { ...original, monetaryPolicy: null }, { ...original, markets: undefined }])
    assert.throws(() => verifyCompatibility("new", "old", { policy: () => value }), /Invalid or missing|Invalid deployment/);
});
test("installer runs preflight before Nginx changes, PM2 or release activation", () => {
  const script = fs.readFileSync(path.join(root, "scripts/deploy-release.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = script.indexOf("step=preflight"), end = script.indexOf("step=pm2-install", start);
  assert(start > 0 && end > start);
  assert(start < script.indexOf('candidate="$release/nginx-featheral.conf"'));
  assert(start < script.indexOf('mv -Tf "$root/current.next" "$root/current"', script.indexOf("trap rollback ERR")));
  const result = spawnSync(bash, ["-c", `set -Eeuo pipefail\nrelease=/candidate\nprevious_release=/working\nphase(){ :; }\nnode(){ echo "policy mismatch" >&2; return 1; }\n${script.slice(start, end)}\necho "would stop gateway"`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /would stop gateway/);
});
