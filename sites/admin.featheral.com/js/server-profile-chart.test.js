"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderServerProfileChart, renderServerDiskChart, startServerProfilePolling, renderCleanupInventory } = require("./server-profile-chart");

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

test("cleanup inventory distinguishes reclaimable paths, protected reasons, unavailable and blocked checks safely", () => {
  const markup = renderCleanupInventory({ blocked: false, candidateCount: 1, reclaimableBytes: 1048576,
    protectedCount: 1, candidates: [{ path: "/staging/<script>", bytes: 1048576, kind: "sync transfer" }],
    protected: [{ path: "/recovery", reason: 'Awaiting "approval"', kind: "snapshot" }] });
  assert.match(markup, /1 eligible entries; 1.00 MiB reclaimable/);
  assert.match(markup, /Eligible for removal/);
  assert.match(markup, /Awaiting &quot;approval&quot;/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(renderCleanupInventory(), /not been scanned/);
  assert.match(renderCleanupInventory({ error: "Cannot verify <state>" }), /role="alert".*Cannot verify &lt;state&gt;/);
  assert.match(renderCleanupInventory({ blocked: true, protectedCount: 1, protected: [{ reason: "Active job" }] }), /blocked by an active operation/);
});

test("profile cleanup controls submit distinct confirmations and cancellation never deletes files", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const controls = new Map(), calls = [], confirmations = [];
  let approve = true;
  const node = selector => {
    if (!controls.has(selector)) controls.set(selector, { id: selector.slice(1), elements: { q: { value: "" } },
      listeners: {}, querySelectorAll: () => [], addEventListener(type, callback) { this.listeners[type] = callback; } });
    return controls.get(selector);
  };
  const metrics = Object.fromEntries(["processCpuPct", "rssBytes", "heapUsedBytes", "heapLimitBytes", "requestCount60s",
    "requestsPerSecond", "latencyP95Ms", "latencySampleCount", "responseBytes60s", "responseBytesPerSecond", "requestBytes60s",
    "eventLoopP95Ms", "eventLoopMaxMs", "uptimeSeconds"].map(key => [key, 0]));
  Object.assign(metrics, { hostCpuPct: null, memoryTotalBytes: 100, memoryFreeBytes: 50 });
  const disk = { available: false, error: "Unavailable" };
  const profile = { metrics, disk, history: [], risks: [], storage: { categories: {} }, sampledAt: Date.now() };
  const context = { VIEWS: {}, state: { seq: 1 }, location: { hash: "#/server-profile" }, AbortController, leaveView: null, viewCleanup: null,
    ServerProfileCharts: { renderServerDiskChart, renderServerProfileChart, renderCleanupInventory, startServerProfilePolling: () => () => {} },
    renderSidebar() {}, setCrumbs() {}, setView() {}, $: node, esc: String, fmtBytes: String, fmtNum: String,
    toast() {}, confirm(text) { confirmations.push(text); return approve; },
    async api(url, options) {
      if (url === "/api/server-profile") return profile;
      calls.push({ url, confirmation: options.json.confirmation });
      return { sites: [], errors: [], temporary: { candidates: [], skipped: [], removedBytes: 0 }, disk };
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "server-users.js"), "utf8"), context);
  await context.VIEWS["server-profile"]({}, 1);
  const click = selector => node(selector).listeners.click({ currentTarget: node(selector) });
  approve = false;
  await click("#server-storage-cleanup");
  assert.deepEqual(calls, []);
  approve = true;
  await click("#server-storage-cleanup");
  assert.deepEqual(calls, [{ url: "/api/settings/cleanup", confirmation: "CLEAN TEMPORARY FILES" }]);
  assert.match(confirmations.at(-1), /CMS trash.*will not be deleted/);
  assert.equal(node("#server-storage-cleanup").disabled, false);
  assert.equal(node("#server-storage-trash-cleanup").disabled, false);
  await click("#server-storage-trash-cleanup");
  assert.equal(calls.at(-1).confirmation, "EMPTY ALL CMS TRASH");
  assert.match(confirmations.at(-1), /cannot be undone/);
});
