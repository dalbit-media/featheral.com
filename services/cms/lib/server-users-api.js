"use strict";
const express = require("express");
function serverUsersApi({ service, cmsAuth, passwordConfigured, adminHost = "admin.featheral.com" }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (!secure && !local) return res.status(403).json({ error: "Server account management requires HTTPS." });
    if (!(typeof passwordConfigured === "function" ? passwordConfigured() : passwordConfigured))
      return res.status(503).json({ error: "Configure Admin access in Settings first." });
    cmsAuth(req, res, next);
  });
  router.get("/", async (req, res) => {
    try { res.json(await service.list({ page: req.query.page, query: req.query.q || "" })); }
    catch (error) {
      console.error("Server account operation failed:", error.status || 500);
      res.status(error.status || 500).json({ error: error.status ? error.message : "Server account management failed." });
    }
  });
  router.use((_req, res) => res.status(404).json({ error: "Unknown server account route." }));
  return router;
}
module.exports = { serverUsersApi };
