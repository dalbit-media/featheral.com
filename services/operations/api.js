"use strict";
const express = require("express");
const crypto = require("node:crypto");
function settingsApi({ settings, cmsAuth, adminHost = "admin.featheral.com" }) {
  const router = express.Router(), limits = new Map();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
    const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    if (!secure && !local) return res.status(403).json({ error: "Settings requires HTTPS." });
    if (!settings.adminConfigured() && !local) return res.status(503).json({ error: "Initialize Admin access from localhost before exposing Settings." });
    cmsAuth(req, res, next);
  });
  router.get("/", (_req, res) => res.json(settings.status()));
  router.use((req, res, next) => {
    const protocol = req.secure || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    if (req.get("origin") !== `${protocol}://${req.get("host")}`) return res.status(403).json({ error: "Same-origin Settings requests are required." });
    const key = req.socket.remoteAddress, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 900000);
    if (records.length >= 30) return res.status(429).json({ error: "Too many Settings requests. Wait 15 minutes." });
    limits.set(key, [...records, now]);
    if (limits.size > 20000) limits.delete(limits.keys().next().value);
    next();
  }, express.json({ limit: "384kb" }));
  const context = req => ({ origin: req.get("origin"), session: crypto.createHash("sha256").update(req.get("authorization") || "local-bootstrap").digest("hex") });
  const run = fn => async (req, res) => {
    try { res.json(await fn(req.body, context(req))); }
    catch (error) {
      console.error("Operations settings rejected:", error.status || error.code || 500);
      res.status(error.status || 500).json({ error: error.status ? error.message : "Settings could not be saved. Check the private server log." });
    } finally { if (req.body?.settings) { delete req.body.settings.credential; delete req.body.settings.adminPassword; } }
  };
  router.post("/challenge", run((input, ctx) => settings.challenge(input, ctx)));
  router.post("/", run((input, ctx) => settings.save(input, ctx)));
  router.use((error, _req, res, _next) => {
    console.error("Settings request rejected:", error.status || 400);
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid Settings request." });
  });
  return router;
}
module.exports = { settingsApi };
