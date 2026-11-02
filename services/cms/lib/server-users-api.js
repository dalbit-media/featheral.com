"use strict";
const express = require("express");
const crypto = require("node:crypto");
function serverUsersApi({ service, cmsAuth, passwordConfigured, adminHost = "admin.featheral.com" }) {
  const router = express.Router(), limits = new Map();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (!secure && !local) return res.status(403).json({ error: "Server account management requires HTTPS." });
    if (!passwordConfigured) return res.status(503).json({ error: "Set CMS_PASSWORD before using server account management. Local bypass access is not sufficient." });
    cmsAuth(req, res, next);
  });
  router.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const protocol = req.secure || req.get("x-forwarded-proto") === "https" ? "https" : "http";
      if (req.get("origin") !== `${protocol}://${req.get("host")}`) return res.status(403).json({ error: "Same-origin server account requests are required." });
      const challenge = req.path === "/root-password/challenge";
      const key = `${req.socket.remoteAddress}:${challenge ? "challenge" : "change"}`, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 900000);
      if (records.length >= (challenge ? 10 : 5)) return res.status(429).json({ error: "Too many password-change attempts. Wait 15 minutes." });
      records.push(now); limits.set(key, records);
      if (limits.size > 20000) limits.delete(limits.keys().next().value);
    }
    next();
  });
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    console.error("Server account operation failed:", error.status || 500);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : "Server account management failed. Check the private server audit." });
  });
  router.get("/", run(async (req, res) => res.json(await service.list({ page: req.query.page, query: req.query.q || "" }))));
  router.get("/root-password/status", run((req, res) => res.json(service.rootStatus())));
  const context = req => ({ origin: req.get("origin"),
    session: crypto.createHash("sha256").update(req.get("authorization") || "").digest("hex") });
  router.post("/root-password/challenge", express.json({ limit: "4kb" }), run(async (req, res) => {
    try { res.json(service.challengeRoot(req.body, context(req))); }
    finally { if (req.body) { delete req.body.currentPassword; delete req.body.newPassword; } }
  }));
  router.post("/root-password", express.json({ limit: "4kb" }), run(async (req, res) => {
    try { res.json(await service.changeRoot(req.body, context(req))); }
    finally { if (req.body) { delete req.body.currentPassword; delete req.body.newPassword; } }
  }));
  router.use((error, _req, res, _next) => {
    console.error("Server account request rejected:", error.status || 400);
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid server account request." });
  });
  return router;
}
module.exports = { serverUsersApi };
