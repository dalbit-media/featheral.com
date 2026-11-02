"use strict";
const express = require("express");
const crypto = require("node:crypto");
const { FileJournals, TOKENS, namespace, fail } = require("./journal");
const { CredentialVault } = require("./vault");
const { createDomainApi } = require("./domain");
const sqlite = require("./sqlite");
const { createWalletProfiles } = require("./wallet-profiles");
const path = require("node:path");
function createDatabase({ directory, repository, env = process.env, sites = () => [], verifyCredential, approvals }) {
  const journals = new FileJournals(directory);
  const profiles = createWalletProfiles(sqlite, env.DB_WALLET_PROFILES_FILE || path.join(path.dirname(directory), "wallet-profiles.sqlite"));
  const domain = createDomainApi({ journals, sites });
  const vault = new CredentialVault({ journals, repository, env, verifyCredential, approvals });
  const streams = () => [...Object.values(TOKENS).map(token => `tokens/${token}`), ...new Set(sites().map(site => `sites/${site}`))];
  const summary = () => ({ phase: "staged", authority: "Existing site stores remain authoritative until verified cutover.",
    crossNamespaceTransactions: false, resetPerformed: false, streams: streams().map(name => journals.summary(name)) });
  const allowed = name => {
    namespace(name);
    if (!streams().includes(name)) throw fail(404, "Unknown public ledger namespace.");
    return name;
  };
  const context = req => ({ origin: req.get("origin"),
    session: crypto.createHash("sha256").update(req.get("authorization") || "").digest("hex") });
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    console.error("Database operation failed:", error.status || error.code || 500);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : "Database operation failed. Check the private server log." });
  });
  function adminRouter({ cmsAuth, passwordConfigured, deployment, serverUsers, adminHost = "admin.featheral.com" }) {
    const router = express.Router(), limits = new Map();
    router.use((req, res, next) => {
      res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
      cmsAuth(req, res, next);
    });
    router.get("/", run((_req, res) => res.json(summary())));
    router.get("/records", run((req, res) => {
      const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
      if (!Number.isSafeInteger(before) || before < 1) throw fail(400, "Invalid ledger cursor.");
      res.json({ records: journals.records(allowed(req.query.namespace), before) });
    }));
    router.use((req, res, next) => {
      const secure = req.secure || req.get("x-forwarded-proto") === "https";
      const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      if (!secure && !local) return res.status(403).json({ error: "Credential operations require HTTPS." });
      if (!passwordConfigured) return res.status(503).json({ error: "Set CMS_PASSWORD before managing credentials. Local bypass access is not sufficient." });
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.get("origin") !== `${secure ? "https" : "http"}://${req.get("host")}`) return res.status(403).json({ error: "Same-origin credential requests are required." });
        const key = req.socket.remoteAddress, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 900000);
        if (records.length >= 30) return res.status(429).json({ error: "Too many credential requests. Wait 15 minutes." });
        records.push(now); limits.set(key, records);
        if (limits.size > 20000) limits.delete(limits.keys().next().value);
      }
      next();
    });
    router.get("/vault", run((_req, res) => res.json(vault.status())));
    router.use(express.json({ limit: "8kb" }));
    router.post("/vault/challenge", run((req, res) => {
      try { res.json(vault.challengeEnrollment(req.body, context(req))); }
      finally { if (req.body) delete req.body.password; }
    }));
    router.post("/vault/enroll", run(async (req, res) => {
      try {
        if (serverUsers.changing || deployment.running) throw fail(409, "Wait for the current password change or deployment.");
        res.json(await vault.enroll(req.body, context(req)));
      } finally { if (req.body) delete req.body.password; }
    }));
    router.post("/deployment/challenge", run((req, res) => res.json(deployment.approvalChallenge(req.body, context(req)))));
    router.post("/deployment/start", run((req, res) => {
      if (serverUsers.changing || vault.busy) throw fail(409, "Wait for the credential operation.");
      res.status(202).json(deployment.launch(req.body, context(req)));
    }));
    router.post("/accounts/challenge", run((req, res) => res.json(serverUsers.challengeList(req.body, context(req)))));
    router.post("/accounts/browse", run(async (req, res) => res.json(await serverUsers.list(req.body, context(req)))));
    router.use((error, _req, res, _next) => {
      console.error("Database request rejected:", error.status || 400);
      res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid database request." });
    });
    return router;
  }
  const publicRouter = express.Router();
  publicRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  publicRouter.get("/status", (_req, res) => res.json({
    service: "Featheral database service",
    phase: "staged",
    nativeFileJournals: true,
    sqlite: "built-in-node-managed-in-process",
    thirdPartyDatabaseDrivers: false,
    siteCutoverComplete: false,
  }));
  publicRouter.use((_req, res) => res.status(404).json({ error: "No public ledger writes. Manage databases through Admin." }));
  return { journals, domain, profiles, sqlite, vault, summary, adminRouter, publicRouter, close: () => profiles.close() };
}
module.exports = { createDatabase };
