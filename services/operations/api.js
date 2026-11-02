"use strict";
const express = require("express");
const crypto = require("node:crypto");
function settingsApi({ settings, siteSync, cmsAuth, adminHost = "admin.featheral.com", sites = () => [] }) {
  const router = express.Router(), limits = new Map();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
    const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    if (!secure && !local) return res.status(403).json({ error: "Settings requires HTTPS." });
    cmsAuth(req, res, next);
  });
  router.get("/", (_req, res) => res.json(settings.status()));
  router.param("site", (req, res, next, key) => {
    const site = sites().find(site => site.key === key && site.status === "ready");
    if (!site) return res.status(404).json({ error: "Unknown managed site." });
    req.settingsSite = site;
    next();
  });
  router.get("/sites/:site", (req, res) => res.json(settings.siteStatus(req.params.site, req.settingsSite.path ? "" : req.settingsSite.hostname)));
  if (siteSync) router.get("/sites/:site/sync", (_req, res) => res.json(siteSync.status()));
  router.use((req, res, next) => {
    const protocol = req.secure || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    if (req.get("origin") !== `${protocol}://${req.get("host")}`) return res.status(403).json({ error: "Same-origin Settings requests are required." });
    const key = req.socket.remoteAddress, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 900000);
    if (records.length >= 30) return res.status(429).json({ error: "Too many Settings requests. Wait 15 minutes." });
    limits.set(key, [...records, now]);
    if (limits.size > 20000) limits.delete(limits.keys().next().value);
    next();
  }, express.json({ limit: "384kb" }));
  const context = req => ({ origin: req.get("origin"), wallet: req.adminWallet,
    session: req.adminSession || crypto.createHash("sha256").update(req.get("authorization") || "local-bootstrap").digest("hex") });
  const run = fn => async (req, res) => {
    try { res.json(await fn(req.body, context(req), req)); }
    catch (error) {
      console.error("Operations settings rejected:", error.status || error.code || 500);
      res.status(error.status || 500).json({ error: error.status ? error.message : "Settings could not be saved. Check the private server log." });
    } finally { if (req.body?.settings) { delete req.body.settings.credential; delete req.body.settings.adminPassword; } }
  };
  router.post("/challenge", run((input, ctx) => settings.challenge(input, ctx)));
  router.post("/", run((input, ctx) => settings.save(input, ctx)));
  router.post("/sites/:site/challenge", run((input, ctx, req) => settings.siteChallenge(req.params.site, input, ctx, req.settingsSite.path ? "" : req.settingsSite.hostname)));
  router.post("/sites/:site", run((input, ctx, req) => settings.saveSite(req.params.site, input, ctx, req.settingsSite.path ? "" : req.settingsSite.hostname)));
  if (siteSync) {
    router.post("/sites/:site/sync/plan", run((_input, ctx, req) => siteSync.plan({ site: req.params.site }, ctx)));
    router.post("/sites/:site/sync/challenge", run((input, ctx, req) => siteSync.challenge({ ...input, site: req.params.site }, ctx)));
    router.post("/sites/:site/sync/start", run((input, ctx, req) => siteSync.start({ ...input, site: req.params.site }, ctx)));
    router.post("/sites/:site/sync/check/challenge", run((_input, ctx, req) => siteSync.recoveryChallenge({ site: req.params.site }, ctx)));
    router.post("/sites/:site/sync/check", run((input, ctx, req) => siteSync.reconcile({ ...input, site: req.params.site }, ctx)));
  }
  router.use((error, _req, res, _next) => {
    console.error("Settings request rejected:", error.status || 400);
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid Settings request." });
  });
  return router;
}
module.exports = { settingsApi };
