"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "../../..", file), "utf8");

test("wallet estimates use per-currency display precision while retaining non-currency precision", () => {
  const source = read("sites/wallet.featheral.com/wallet-app.js");
  const code = source.slice(source.indexOf("const goldAmount ="), source.indexOf("let storageAvailable"));
  const h = vm.runInNewContext(code + ";({ goldAmount, equivalent, usdEstimate });");
  assert.equal(h.goldAmount("1234567890123456789"), "1.2346 FTHG");
  assert.equal(h.goldAmount("1"), "<0.0001 FTHG");
  assert.equal(h.goldAmount("1234567890123456789", 6), "1.234568 FTHG");
  assert.equal(h.equivalent("1234567890123456789", "FTH$"), "1.23 FTH$");
  assert.equal(h.equivalent("1234567890123456789", "FTHX"), "1.23 FTHX");
  assert.equal(h.equivalent("1234567890123456789", "FTHS"), "1.2346 FTHS");
  assert.equal(h.equivalent("1234567890123456789", "FTHG"), "1.2346 FTHG");
  assert.equal(h.usdEstimate("1234567890123456789"), "$1.2346");
});

test("gold reserve display rounds large token amounts without floating point loss", () => {
  const source = read("sites/gold.featheral.com/reserve-view.js");
  const h = vm.runInNewContext(source.slice(source.indexOf("const units ="), source.indexOf("async function api(")) + ";({ units, dollars });");
  assert.equal(h.units("123456789012345678901234567890"), "123,456,789,012.3457");
  assert.equal(h.dollars("123456789012345678901234567890"), "123,456,789,012.35");
});

test("demo FTH$ presentation rounds without changing exact input formatting", () => {
  const source = read("sites/ex.featheral.com/demos.js");
  const h = vm.runInNewContext(source.slice(source.indexOf("const assetDecimals ="), source.indexOf("async function templateHome()")) + ";({ displayAsset, rawAmount });");
  assert.equal(h.displayAsset(1234567, "FTH$"), "1.23");
  assert.equal(h.rawAmount(1234567, "FTH$"), "1.234567");
  assert.equal(h.displayAsset(1234567, "USD$"), "1.234567");
});
