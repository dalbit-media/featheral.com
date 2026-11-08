"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");
const { settingsApi } = require("../../operations/api");

test("cleanup API requires Admin authentication, origin and explicit mode without silently purging trash", async t => {
  const calls = [], app = express();
  app.use("/api/settings", settingsApi({ settings: { status: () => ({}) },
    cmsAuth(req, res, next) { if (req.get("authorization") !== "fixture-admin") return res.status(401).json({ error: "Unauthorized" }); next(); },
    cleanup(options) { calls.push(options); return { temporary: { removedBytes: 23 }, sites: [] }; } }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (confirmation, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/settings/cleanup", method: "POST",
      headers: { Host: "admin.localhost", Origin: "http://admin.localhost", Authorization: "fixture-admin", "Content-Type": "application/json", ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(JSON.stringify({ confirmation }));
  });
  assert.equal((await request("CLEAN TEMPORARY FILES", { Authorization: "" })).status, 401);
  assert.equal((await request("CLEAN TEMPORARY FILES", { Host: "world.localhost" })).status, 404);
  assert.equal((await request("CLEAN TEMPORARY FILES", { Origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await request("yes")).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await request("CLEAN TEMPORARY FILES")).data.temporary.removedBytes, 23);
  assert.deepEqual(calls, [{ temporaryOnly: true }]);
  assert.equal((await request("EMPTY ALL CMS TRASH")).status, 200);
  assert.deepEqual(calls, [{ temporaryOnly: true }, { temporaryOnly: false }]);
});
