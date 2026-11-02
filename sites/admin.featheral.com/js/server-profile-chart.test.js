"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderServerProfileChart, renderServerDiskChart, startServerProfilePolling } = require("./server-profile-chart");

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

test("disk donut shows exact used and free segments, capacity, percentages and growth risk", () => {
  const disk = { available: true, totalBytes: 100 * 1024 ** 3, usedBytes: 75 * 1024 ** 3,
    freeBytes: 25 * 1024 ** 3, severity: "warning", growthBytesPerDay: 1024 ** 3,
    growthObservedSeconds: 86400, daysUntilFull: 25 };
  const markup = renderServerDiskChart(disk);
  assert.match(markup, /stroke-dasharray="75 25"/);
  assert.match(markup, /role="img" aria-label="In use 75.0 GiB \(75.0%\); free available 25.0 GiB \(25.0%\)/);
  assert.match(markup, /Total capacity: 100.0 GiB/);
  assert.match(markup, /WARNING/);
  assert.match(markup, /Net growth: 1.0 GiB\/day over 24.0 hours/);
  assert.match(markup, /Estimated full in 25.0 days/);
  const next = renderServerDiskChart({ ...disk, usedBytes: disk.totalBytes, freeBytes: 0 });
  assert.match(next, /stroke-dasharray="100 0"/);
  assert.doesNotMatch(next, /NaN|Infinity/);
  assert.match(renderServerDiskChart({ ...disk, usedBytes: 0, freeBytes: disk.totalBytes }), /stroke-dasharray="0 100"/);
});

test("disk donut distinguishes collecting, declining, stable and unavailable samples safely", () => {
  const disk = { available: true, totalBytes: 100, usedBytes: 25, freeBytes: 75,
    severity: "unknown", growthBytesPerDay: null, daysUntilFull: null };
  assert.match(renderServerDiskChart(disk), /Collecting history/);
  assert.match(renderServerDiskChart(disk), /UNKNOWN/);
  for (const growthBytesPerDay of [0, -10]) {
    const markup = renderServerDiskChart({ ...disk, growthBytesPerDay, growthObservedSeconds: 300, severity: "healthy" });
    assert.match(markup, /No net growth observed/);
    assert.doesNotMatch(markup, /Estimated full|NaN|Infinity/);
  }
  const unavailable = renderServerDiskChart({ available: false, error: 'Capacity <unavailable> & "offline"' });
  assert.match(unavailable, /Capacity &lt;unavailable&gt; &amp; &quot;offline&quot;/);
  assert.doesNotMatch(unavailable, /<svg/);
});
