"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const terminal = fs.readFileSync(path.join(__dirname, "../../../sites/ex.featheral.com/terminal.js"), "utf8");
const helpers = vm.runInNewContext(terminal.slice(terminal.indexOf("const decimals ="), terminal.indexOf("async function api(")) + ";({amount,format,exact,ratio});");
test("Exchange terminal parses exact whole notes and 18-decimal dollars without Number balance arithmetic", () => {
  assert.equal(helpers.amount("1.234567890123456789", "FTH$"), "1234567890123456789");
  assert.equal(helpers.amount("9007199254740993", "FTHX"), "9007199254740993");
  for (const [value, symbol] of [["1.1", "FTHX"], ["1.0000000000000000001", "FTH$"], ["-1", "FTH$"], ["1e3", "FTHX"], ["0", "FTHX"]])
    assert.throws(() => helpers.amount(value, symbol));
  assert.equal(helpers.format("9999000000000000000", "FTH$"), "10 FTH$");
  assert.equal(helpers.format("1", "FTH$"), "<0.01 FTH$");
  assert.equal(helpers.exact("1234567890123456789", "FTH$"), "1.234567890123456789 FTH$");
  assert.equal(helpers.ratio({ numerator: "1", denominator: "1000000000" }), "<0.00000001");
});
test("Exchange terminal keeps signing sessions in memory and preserves submitted request IDs across uncertain retries", () => {
  assert.doesNotMatch(terminal, /localStorage|featheral-creation-token|markets\/trade/);
  assert.match(terminal, /sessionStorage\.setItem\(`featheral-exchange-pending:\$\{owner\}:trade`/);
  assert.match(terminal, /!preview\.submitted && preview\.expires/);
  assert.match(terminal, /FeatheralWallet\.authenticate\(address => api\("\/challenge"/);
  assert.doesNotMatch(terminal, /eth_requestAccounts|featheral:exchange-auth|builtin-connect/);
});
