"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../../sites/gold.featheral.com/landing.js"), "utf8");
function formatter(market) {
  return vm.runInNewContext(source.slice(source.indexOf("function usd("), source.indexOf("function share(")) + ";usd;", {
    usdMarket: market, ONE: 10n ** 18n,
  });
}
test("Gold landing estimates use live USD and preserve large and fractional balances exactly", () => {
  const usd = formatter({ usdPerFthg: "2000000000000000000", updatedAt: new Date().toISOString() });
  assert.equal(usd("1234567890123456789"), "$2.47");
  assert.equal(usd("9007199254740993000000000000000000"), "$18,014,398,509,481,986.00");
  assert.equal(usd("1"), "<$0.01");
  assert.doesNotMatch(source, /USD_PER_FTHG_ESTIMATE/);
});
test("Gold landing accepts the Gold API's temporary reference but never invents a client-side rate", () => {
  assert.equal(formatter({ usdPerFthg: '10000000000000000', updatedAt: new Date().toISOString(), fallback: true })('1000000000000000000'), '$0.01');
  for (const market of [null, { usdPerFthg: "0", updatedAt: new Date().toISOString() },
    { usdPerFthg: "1000000000000000000", updatedAt: new Date(Date.now() - 300001).toISOString() }])
    assert.equal(formatter(market)("1000000000000000000"), "USD unavailable");
});
