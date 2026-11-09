"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync, execFileSync } = require("node:child_process");
const vm = require("node:vm");
const { readPolicy, verifyCompatibility } = require("../../../scripts/deployment-preflight");
const { liquidityTargets, authorizedLiquidityTargets, reserveLiquidityTargets, craftingLiquidityTargets, equipmentLiquidityTargets, bulkCraftingLiquidityTargets } = require("../../notes/game-funds");
const { approvedMarkets, approvedMarketExpansion } = require("../../gold/market-expansion");
const root = path.resolve(__dirname, "../../..");
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

test("squad vouchers preserve the running transport reserve policy and all historical catalogs", () => {
  const { transportLiquidityTargets } = require("../../notes/game-funds");
  const { marketAssets, isReserveMarketAsset, isLiquidAsset } = require("../../../sites/world.featheral.com/play/src/market.ts");
  const squads = ["squad-10", "squad-20", "squad-50", "squad-100"];
  const targets = transportLiquidityTargets();
  assert.equal(Object.keys(targets).length, 121);
  assert.deepEqual(marketAssets.filter(asset => !isReserveMarketAsset(asset)), squads);
  for (const asset of squads) {
    assert.equal(isLiquidAsset(asset), true, "player-funded pools remain available");
    for (const catalog of [liquidityTargets, authorizedLiquidityTargets, reserveLiquidityTargets,
      craftingLiquidityTargets, equipmentLiquidityTargets, bulkCraftingLiquidityTargets, transportLiquidityTargets])
      assert.equal(Object.hasOwn(catalog(), asset), false);
    assert.equal(Object.hasOwn(approvedMarkets, asset), false, "no new reserve authorization");
  }
  const policy = { monetaryPolicy: { scale: 10000 }, collectionPolicy: { version: 1 }, markets: targets };
  assert.deepEqual(verifyCompatibility("candidate", "running", { policy: () => policy }), { marketExpansion: false });
  assert.throws(() => verifyCompatibility("candidate", "running", { policy: name => name === "candidate"
    ? { ...policy, markets: { ...targets, "squad-10": { quantity: 10000, pricePerLot: "10000000000000000000" } } } : policy }), /Activation refused/);
});

test("live reserve seed prices stay genesis-compatible when market floors change", () => {
  const { marketPriceFloor, marketBasePrice } = require("../../../sites/world.featheral.com/play/src/market.ts");
  const targets = liquidityTargets();
  for (const [asset, price] of Object.entries({ wood: 4, water: 2, metal: 2, oil: 24 })) {
    assert.equal(targets[asset].pricePerLot, (BigInt(price) * 10n ** 18n).toString());
    assert.equal(marketBasePrice(asset), price);
  }
  assert.equal(marketPriceFloor("oil"), .0001, "only accounting precision limits prices; reserve seeds stay unchanged");
  for (const [asset, price] of Object.entries({
    fire: 112, torch: 192, lamp: 512, lantern: 412,
    planter: 80, bench: 96, banner: 80, fountain: 208, boardwalk: 144, canopy: 184,
  })) assert.equal(marketBasePrice(asset), price);
});
test("relic-release self-sync retains all 81 targets while crafting expansion only adds 24 decorations", () => {
  const previous = reserveLiquidityTargets(), next = craftingLiquidityTargets();
  assert.equal(Object.keys(previous).length, 81);
  assert.equal(Object.keys(next).length, 105);
  for (const [asset, target] of Object.entries(previous)) assert.deepEqual(next[asset], target);
  assert.equal(approvedMarketExpansion(previous, next), true);
  assert.equal(Object.keys(next).filter(asset => !Object.hasOwn(previous, asset)).length, 24);
});
test("crafting-release self-sync retains all 105 targets while equipment adds only nine approved markets", () => {
  const previous = craftingLiquidityTargets(), next = equipmentLiquidityTargets();
  assert.equal(Object.keys(previous).length, 105);
  assert.equal(Object.keys(next).length, 114);
  for (const [asset, target] of Object.entries(previous)) assert.deepEqual(next[asset], target);
  assert.equal(approvedMarketExpansion(previous, next), true);
  for (const asset of Object.keys(next).filter(asset => !Object.hasOwn(previous, asset))) assert.deepEqual(next[asset], approvedMarkets[asset]);
});
test("equipment-release catalog stays at 114 targets while bulk crafting adds exactly four approved markets", () => {
  const previous = equipmentLiquidityTargets(), next = bulkCraftingLiquidityTargets();
  assert.equal(Object.keys(previous).length, 114);
  assert.equal(Object.keys(next).length, 118);
  for (const [asset, target] of Object.entries(previous)) assert.deepEqual(next[asset], target);
  const additions = Object.keys(next).filter(asset => !Object.hasOwn(previous, asset));
  assert.deepEqual(additions, ["craft-batch-10", "craft-batch-20", "craft-batch-50", "craft-batch-100"]);
  assert.equal(approvedMarketExpansion(previous, next), true);
});
test("legacy running self-sync accepts the original catalog while the new installer verifies all approved additions", t => {
  const original = liquidityTargets(), expanded = bulkCraftingLiquidityTargets();
  assert.equal(Object.keys(original).length, 32);
  assert.equal(Object.keys(expanded).length, 118);
  for (const asset of Object.keys(approvedMarkets)) assert.equal(Object.hasOwn(original, asset), false);
  assert.deepEqual(Object.fromEntries(Object.entries(expanded).filter(([asset]) => !Object.hasOwn(approvedMarkets, asset))), original);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-bootstrap-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = (name, funds) => {
    const base = path.join(directory, name);
    for (const dir of ["services/operations", "services/notes", "sites/world.featheral.com/play/src"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
    fs.writeFileSync(path.join(base, "services/operations/settings.js"), 'exports.OperationsSettings=class{environment(){return {GOLD_RESERVE_MODE:"live"}}}');
    fs.writeFileSync(path.join(base, "services/notes/game-funds.js"), funds);
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/monetary-policy.ts"), 'export const monetaryPolicy={scale:10000};');
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/collection.ts"), 'export const collectionPolicy={version:1};');
    return base;
  };
  const previous = fixture("running", `exports.liquidityTargets=()=>(${JSON.stringify(original)});`);
  const candidate = fixture("fetched", `module.exports=require(${JSON.stringify(path.join(root, "services/notes/game-funds.js"))});`);
  // The already running worker's first check invokes only the historical export.
  const legacyPolicy = source => ({ monetaryPolicy: { scale: 10000 }, collectionPolicy: { version: 1 },
    markets: JSON.parse(execFileSync(process.execPath, ["-e", 'process.stdout.write(JSON.stringify(require("./services/notes/game-funds").liquidityTargets()))'], { cwd: source, encoding: "utf8" })) });
  assert.deepEqual(legacyPolicy(candidate), legacyPolicy(previous));
  assert.deepEqual(readPolicy(candidate, previous).markets, expanded);
  assert.equal(verifyCompatibility(candidate, previous, { policy: source => readPolicy(source, previous) }).marketExpansion, true);
  fs.writeFileSync(path.join(candidate, "services/notes/game-funds.js"), `exports.liquidityTargets=()=>(${JSON.stringify(original)});exports.authorizedLiquidityTargets=()=>(${JSON.stringify({ ...expanded, wood: { ...original.wood, quantity: 9999 } })});`);
  assert.deepEqual(legacyPolicy(candidate), legacyPolicy(previous));
  assert.throws(() => verifyCompatibility(candidate, previous, { policy: source => readPolicy(source, previous) }), /Activation refused/);
});
test("preflight permits only explicitly approved additive markets without changing any existing target", () => {
  const markets = { oil: { quantity: 10000, pricePerLot: "24000000000000000000" } };
  const original = { monetaryPolicy: { scale: 10000 }, collectionPolicy: { version: 1 }, markets };
  const candidate = { ...original, markets: { ...markets, ...approvedMarkets } };
  const verify = next => verifyCompatibility("new", "old", { policy: name => name === "new" ? next : original });
  assert.equal(Object.keys(approvedMarkets).length, 86);
  const actual = bulkCraftingLiquidityTargets();
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
test("identity/collector self-sync sees its unchanged catalog while the installer validates relic authorization", t => {
  const original = authorizedLiquidityTargets(), full = bulkCraftingLiquidityTargets();
  assert.equal(Object.keys(original).length, 60);
  assert.equal(Object.keys(full).length, 118);
  assert.equal(approvedMarketExpansion(original, full), true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-relic-bootstrap-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = (name, funds) => {
    const base = path.join(directory, name);
    for (const dir of ["services/operations", "services/notes", "sites/world.featheral.com/play/src"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
    fs.writeFileSync(path.join(base, "services/operations/settings.js"), 'exports.OperationsSettings=class{environment(){return {GOLD_RESERVE_MODE:"live"}}}');
    fs.writeFileSync(path.join(base, "services/notes/game-funds.js"), funds);
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/monetary-policy.ts"), 'export const monetaryPolicy={scale:10000};');
    fs.writeFileSync(path.join(base, "sites/world.featheral.com/play/src/collection.ts"), 'export const collectionPolicy={version:1};');
    return base;
  };
  const previous = fixture("running", `exports.authorizedLiquidityTargets=()=>(${JSON.stringify(original)});`);
  const candidate = fixture("fetched", `module.exports=require(${JSON.stringify(path.join(root, "services/notes/game-funds.js"))});`);
  const legacyPolicy = source => ({
    monetaryPolicy: { scale: 10000 }, collectionPolicy: { version: 1 },
    markets: JSON.parse(execFileSync(process.execPath, ["-e",
      'const funds=require("./services/notes/game-funds");process.stdout.write(JSON.stringify((funds.authorizedLiquidityTargets||funds.liquidityTargets)()))'],
    { cwd: source, encoding: "utf8" })),
  });
  const legacyModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "scripts/deployment-preflight.js"), "utf8"), {
    module: legacyModule, require: Object.assign(name => name === "../services/gold/market-expansion" ? {
      approvedMarketExpansion: (before, after) => {
        const additions = Object.keys(after).filter(asset => !Object.hasOwn(before, asset));
        return approvedMarketExpansion(before, after) && additions.every(asset => !asset.startsWith("relic-"));
      },
    } : require(name), { main: null }), process,
  });
  // An already running worker has the old allowlist and reads only the historical exports.
  // It must still reject a full relic expansion if exposed through those exports.
  assert.throws(() => legacyModule.exports.verifyCompatibility(candidate, previous, {
    policy: source => source === candidate ? { ...legacyPolicy(source), markets: full } : legacyPolicy(source),
  }), /Live reserve.*Activation refused/);
  assert.equal(legacyModule.exports.verifyCompatibility(candidate, previous, { policy: legacyPolicy }).marketExpansion, false);
  assert.equal(verifyCompatibility(candidate, previous, { policy: source => readPolicy(source, previous) }).marketExpansion, true);
  assert.deepEqual(readPolicy(candidate, previous).markets, full);
  for (const markets of [
    { ...full, wood: { ...original.wood, quantity: 9999 } },
    { ...full, "relic-forest": { ...full["relic-forest"], quantity: 101 } },
    { ...full, "relic-forest": { ...full["relic-forest"], pricePerLot: "1" } },
    { ...full, "relic-forged": full["relic-forest"] },
    Object.fromEntries(Object.entries(full).filter(([asset]) => asset !== "wood")),
  ]) {
    fs.writeFileSync(path.join(candidate, "services/notes/game-funds.js"),
      `exports.authorizedLiquidityTargets=()=>(${JSON.stringify(original)});exports.reserveLiquidityTargets=()=>(${JSON.stringify(markets)});`);
    assert.equal(legacyModule.exports.verifyCompatibility(candidate, previous, { policy: legacyPolicy }).marketExpansion, false);
    assert.throws(() => verifyCompatibility(candidate, previous, { policy: source => readPolicy(source, previous) }), /Activation refused/);
  }
  assert.equal(fs.existsSync(path.join(candidate, "data")), false);
  assert.equal(fs.existsSync(path.join(previous, "data")), false);
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
      goldKeys: { publicKey: "gold-public", privateKey: "gold-private" }, reserveLiquidityTargets: () => approvedMarkets,
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
