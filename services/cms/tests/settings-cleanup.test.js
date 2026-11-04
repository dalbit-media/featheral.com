"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { settingsApi } = require("../../operations/api");

test("Settings cleanup requires Admin authentication, host, TLS, same origin and explicit confirmation", async t => {
  const app = express();
  let calls = 0, busy = false;
  app.use("/api/settings", settingsApi({
    settings: {}, cmsAuth: (req, res, next) => req.get("authorization") === "fixture-admin" ? next() : res.sendStatus(401),
    cleanup: () => {
      calls++;
      if (busy) throw Object.assign(new Error("Server busy"), { status: 409 });
      return { sites: [], errors: [], temporary: { removedBytes: 123 }, disk: { available: true, freeBytes: 456 } };
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const request = (headers = {}, body = { confirmation: "EMPTY ALL CMS TRASH" }) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/settings/cleanup", method: "POST",
      headers: { Host: `admin.localhost:${port}`, Origin: `http://admin.localhost:${port}`,
        Authorization: "fixture-admin", "Content-Type": "application/json", ...headers } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  assert.equal((await request({ Authorization: "" })).status, 401);
  assert.equal((await request({ Host: "x.featheral.com" })).status, 404);
  assert.equal((await request({ Host: "admin.featheral.com" })).status, 403);
  assert.equal((await request({ Origin: "https://attacker.test" })).status, 403);
  assert.equal((await request({}, {})).status, 400);
  assert.equal(calls, 0);
  const cleaned = await request();
  assert.equal(cleaned.status, 200);
  assert.equal(JSON.parse(cleaned.text).disk.freeBytes, 456);
  busy = true;
  assert.equal((await request()).status, 409);
});

test("Server profile cleanup confirms once, refreshes inventory, and reports partial failures without duplicate submissions", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/server-users.js"), "utf8");
  const settings = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/settings.js"), "utf8");
  assert.doesNotMatch(settings, /settings-cleanup|Storage cleanup/);
  assert.match(source, /Temporary & deployment files/);
  assert.match(source, /Trashed files · all sites/);
  const start = source.indexOf('  $("#server-storage-cleanup").addEventListener(');
  const code = source.slice(start, source.indexOf("  async function loadProfile()", start));
  let click, resolve, requests = 0, confirmed = false;
  const control = { addEventListener(_type, fn) { click = fn; } }, output = {};
  const context = vm.createContext({
    $: selector => selector === "#server-storage-cleanup" ? control : output,
    active: () => true, cleaning: false, confirm: () => confirmed, toast() {}, loadProfile: async () => { refreshes++; },
    api: async (url, options) => {
      assert.equal(url, "/api/settings/cleanup");
      assert.equal(options.json.confirmation, "EMPTY ALL CMS TRASH");
      requests++;
      return new Promise(done => { resolve = done; });
    },
  });
  let refreshes = 0;
  vm.runInContext(code, context);
  await click();
  assert.equal(requests, 0);
  confirmed = true;
  const pending = click();
  await click();
  assert.equal(requests, 1);
  assert.equal(control.disabled, true);
  resolve({ temporary: { candidates: [1], removedBytes: 1024 ** 3, skipped: [] },
    sites: [{ posts: 3, files: 2, bytes: 42 }], errors: [{ key: "blocked", message: "Choose another homepage" }],
    trashSkipped: "Replica trash preserved.", disk: { available: true, freeBytes: 6 * 1024 ** 3 } });
  await pending;
  assert.match(output.textContent, /1 temporary entries \(1.00 GiB\)/);
  assert.match(output.textContent, /3 trashed items and 2 files/);
  assert.match(output.textContent, /Cleanup failed for blocked: Choose another homepage/);
  assert.match(output.textContent, /Replica trash preserved/);
  assert.match(output.textContent, /Server free space: 6.00 GiB/);
  assert.equal(control.disabled, false);
  assert.equal(refreshes, 1);
  context.api = async () => { throw new Error("Connection interrupted"); };
  await click();
  assert.match(output.textContent, /Cleanup was not confirmed; some files may already have been removed/);
  assert.match(output.textContent, /Connection interrupted/);
  assert.equal(control.disabled, false);
  assert.equal(refreshes, 2);
});
