"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderServerProfileChart, startServerProfilePolling } = require("./server-profile-chart");

test("the unified chart renders five bounded resource series and reflects newer samples", () => {
  const history = Array.from({ length: 60 }, (_, index) => ({
    processCpuPct: index, rssBytes: 1024 ** 2 * 64, eventLoopP95Ms: 12,
    requestsPerSecond: 4, responseBytesPerSecond: 2048,
  }));
  const first = renderServerProfileChart(history);
  assert.equal((first.match(/class="server-chart-line"/g) || []).length, 5);
  assert.match(first, /Process CPU/);
  assert.match(first, /Process memory/);
  assert.match(first, /HTTP response/);
  history[59].processCpuPct = 90;
  assert.notEqual(renderServerProfileChart(history), first);
  assert.doesNotMatch(renderServerProfileChart([{ processCpuPct: Infinity }]), /NaN|Infinity/);
});

test("profile polling can be disposed without scheduling further updates", async () => {
  let calls = 0;
  const stop = startServerProfilePolling(() => { calls++; }, 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  const stoppedAt = calls;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(stoppedAt > 0);
  assert.equal(calls, stoppedAt);
  assert.throws(() => startServerProfilePolling(null), TypeError);
});
