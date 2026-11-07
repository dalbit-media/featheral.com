"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { readPolicy, verifyCompatibility } = require("../../../scripts/deployment-preflight");
const { liquidityTargets } = require("../../notes/game-funds");
const { approvedMarkets, approvedMarketExpansion } = require("../../gold/market-expansion");
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
test("preflight permits only explicitly approved additive markets without changing any existing target", () => {
  const markets = { oil: { quantity: 10000, pricePerLot: "24000000000000000000" } };
  const original = { monetaryPolicy: { scale: 10000 }, collectionPolicy: { version: 1 }, markets };
  const candidate = { ...original, markets: { ...markets, ...approvedMarkets } };
  const verify = next => verifyCompatibility("new", "old", { policy: name => name === "new" ? next : original });
  assert.equal(Object.keys(approvedMarkets).length, 28);
  const actual = liquidityTargets();
  for (const [asset, target] of Object.entries(approvedMarkets)) assert.deepEqual(actual[asset], target, asset);
  assert.doesNotThrow(() => verify(candidate));
  for (const next of [
    { ...candidate, markets: { ...candidate.markets, oil: { ...markets.oil, quantity: 9999 } } },
    { ...candidate, markets: { ...candidate.markets, "title-admin": approvedMarkets["title-pioneer"] } },
    { ...candidate, markets: { ...candidate.markets, "collector-all-52": { ...approvedMarkets["collector-all-52"], pricePerLot: "1" } } },
    { ...candidate, markets: { ...approvedMarkets } },
    { ...candidate, monetaryPolicy: { scale: 1 } },
    { ...candidate, collectionPolicy: { version: 2 } },
  ]) assert.throws(() => verify(next), /Activation refused/);
  assert.equal(approvedMarketExpansion(candidate.markets, markets), false);
  assert.equal(approvedMarketExpansion(null, candidate.markets), false);
  assert.equal(approvedMarketExpansion(markets, { ...markets, "title-pioneer": { ...approvedMarkets["title-pioneer"], extra: true } }), false);
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
test("installer defers irreversible market authorization until all HTTPS checks pass and never rolls back its journal", () => {
  const script = fs.readFileSync(path.join(root, "scripts/deploy-release.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = script.indexOf('if [[ -f "$release/.deployment-market-authorization.pending" ]]');
  assert(start > script.indexOf('echo "HTTPS health:'));
  assert(start > script.lastIndexOf('"$pm2" save'));
  assert(script.indexOf("kill -USR2", start) > script.indexOf("market_authorization_started=true", start));
  const protectedStart = script.indexOf('if [[ "$market_authorization_started" == true ]]');
  const protectedEnd = script.indexOf('if [[ "$had_nginx" == true ]]', protectedStart);
  assert(protectedStart > 0 && protectedEnd > protectedStart);
  const result = spawnSync(bash, ["-c", `market_authorization_started=true\ncode=1\n${script.slice(protectedStart, protectedEnd)}\necho "would restore incompatible release"`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Keeping the HTTPS-verified candidate online/);
  assert.doesNotMatch(result.stdout, /would restore incompatible release/);
  const runtime = fs.readFileSync(path.join(root, "scripts/serve.js"), "utf8");
  assert.match(runtime, /deferExpansion: deferred/);
  assert.match(runtime, /process\.once\("SIGUSR2"/);
});
test("gateway validates pending authorization at startup and persists it only after the installer signal", () => {
  const source = fs.readFileSync(path.join(root, "scripts/serve.js"), "utf8");
  const start = source.indexOf("const marketAuthorizationFile =");
  const end = source.indexOf("if (api.ledger.genesis.goldPublicKey", start);
  assert(start > 0 && end > start);
  for (const fails of [false, true]) {
    let handler, pending = true;
    const calls = [], logs = [];
    vm.runInNewContext(source.slice(start, end), {
      root: "/candidate", path, reserveMode: "live", api: { ledger: {} }, keys: { privateKey: "game" },
      goldKeys: { publicKey: "gold-public", privateKey: "gold-private" }, liquidityTargets: () => approvedMarkets,
      fs: { existsSync: () => pending, unlinkSync: () => { pending = false; } },
      process: { once: (signal, callback) => { assert.equal(signal, "SIGUSR2"); handler = callback; } },
      console: { log: line => logs.push(line), error: line => logs.push(line) },
      activateLiveReserve: (...args) => {
        calls.push(args);
        if (!args[5]?.deferExpansion && fails) throw new Error("Disk persistence unavailable");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][5].deferExpansion, true);
    assert.equal(pending, true);
    handler();
    assert.equal(calls.length, 2);
    assert.equal(pending, fails);
    assert.match(logs[0], fails ? /could not be confirmed/ : /persisted after deployment health/);
  }
});
