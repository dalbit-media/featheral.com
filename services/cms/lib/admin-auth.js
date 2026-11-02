"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { ethers } = require("ethers");
const { SOURCE_ADDRESS, RESERVE_ADDRESS } = require("../../gold/reserve");

const adminWallets = [SOURCE_ADDRESS, RESERVE_ADDRESS];
const cookie = (req, name) => String(req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(name + "="))?.slice(name.length + 1);
function createAdminAuth({ adminHost = "admin.featheral.com", wallets = adminWallets, now = Date.now } = {}) {
  const allowed = wallets.map(address => ethers.getAddress(address));
  const pending = new Map(), sessions = new Map(), limits = new Map();
  const router = express.Router();
  const frontend = path.resolve(__dirname, "../../..", "sites", "admin.featheral.com");
  const local = req => req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const secure = req => req.secure || req.get("x-forwarded-proto") === "https";
  const origin = req => `${secure(req) ? "https" : "http"}://${req.get("host")}`;
  const trusted = req => [adminHost, "admin.localhost"].includes(req.hostname) && (secure(req) || local(req));
  const options = req => ({ httpOnly: true, secure: !local(req), sameSite: "strict", path: "/" });
  function prune() {
    for (const map of [pending, sessions]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  }
  function session(req) {
    prune();
    const token = cookie(req, "featheral_admin");
    const value = sessions.get(token);
    if (!trusted(req) || !value || value.origin !== origin(req)) return null;
    return { ...value, token };
  }
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" });
    if (!trusted(req)) return res.status(403).json({ error: "Use the Admin site over HTTPS." });
    next();
  });
  router.get("/session", (req, res) => {
    const value = session(req);
    res.json({ authenticated: Boolean(value), wallet: value?.wallet || null, wallets: allowed });
  });
  router.use((req, res, next) => {
    if (req.get("origin") !== origin(req)) return res.status(403).json({ error: "Same-origin Admin sign-in is required." });
    prune();
    const key = req.socket.remoteAddress, records = (limits.get(key) || []).filter(at => now() - at < 900000);
    if (records.length >= 30) return res.status(429).json({ error: "Too many Admin sign-in requests. Wait 15 minutes." });
    limits.set(key, [...records, now()]);
    if (limits.size > 20000) limits.delete(limits.keys().next().value);
    next();
  }, express.json({ limit: "4kb" }));
  router.post("/challenge", (req, res) => {
    const wallet = allowed.find(address => address.toLowerCase() === String(req.body?.address || "").toLowerCase());
    if (!wallet) return res.status(403).json({ error: "Only the origin or Dollar reserve wallet may sign in to Admin." });
    if (pending.size >= 1000) return res.status(429).json({ error: "Too many pending sign-ins. Wait five minutes." });
    pending.delete(cookie(req, "featheral_admin_nonce"));
    const nonce = crypto.randomBytes(24).toString("hex"), issuedAt = now(), expiresAt = issuedAt + 300000;
    const message = `Sign in to Featheral Admin.\n\nOrigin: ${origin(req)}\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date(issuedAt).toISOString()}\n\nAccess private site administration. No transaction or transfer approval.`;
    pending.set(nonce, { wallet, message, origin: origin(req), expiresAt });
    res.cookie("featheral_admin_nonce", nonce, { ...options(req), maxAge: 300000 });
    res.json({ message, expiresAt, wallet });
  });
  router.post("/verify", (req, res) => {
    const nonce = cookie(req, "featheral_admin_nonce"), value = pending.get(nonce);
    pending.delete(nonce);
    res.clearCookie("featheral_admin_nonce", options(req));
    if (!value || value.origin !== origin(req)) return res.status(403).json({ error: "Sign-in expired. Start again." });
    let signer;
    try { signer = ethers.verifyMessage(value.message, req.body?.signature); }
    catch { return res.status(403).json({ error: "Invalid Admin wallet signature." }); }
    if (signer !== value.wallet) return res.status(403).json({ error: "Sign with the selected authorized Admin wallet." });
    if (sessions.size >= 10000) return res.status(503).json({ error: "Admin session capacity reached. Try later." });
    sessions.delete(cookie(req, "featheral_admin"));
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { wallet: signer, origin: origin(req), expiresAt: now() + 8 * 3600000 });
    res.cookie("featheral_admin", token, { ...options(req), maxAge: 8 * 3600000 });
    res.json({ authenticated: true, wallet: signer });
  });
  router.post("/logout", (req, res) => {
    sessions.delete(cookie(req, "featheral_admin"));
    res.clearCookie("featheral_admin", options(req));
    res.json({ authenticated: false });
  });
  router.use((error, _req, res, _next) => {
    console.error("Admin sign-in rejected:", error.status || error.name);
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid Admin sign-in request." });
  });
  function authenticate(req, res, next) {
    const value = session(req);
    if (!value) return res.status(401).json({ error: "Sign in with the origin or Dollar reserve wallet on the Admin site." });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin") !== value.origin)
      return res.status(403).json({ error: "Same-origin administration requests are required." });
    req.cmsAuthorized = true;
    req.adminSession = crypto.createHash("sha256").update(value.token).digest("hex");
    req.adminWallet = value.wallet;
    next();
  }
  function gate(req, res, next) {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" });
    if (!trusted(req)) return res.status(403).json({ error: "Use the Admin site over HTTPS." });
    if (session(req)) return authenticate(req, res, next);
    if (["GET", "HEAD"].includes(req.method) && ["/", "/index.html"].includes(req.path)) return res.sendFile(path.join(frontend, "login.html"));
    const assets = { "/js/login.js": path.join(frontend, "js", "login.js"),
      "/shared/wallet-profile.js": path.resolve(frontend, "..", "wallet.featheral.com", "wallet-profile.js"),
      "/shared/wallet-profile.css": path.resolve(frontend, "..", "wallet.featheral.com", "wallet-profile.css"),
      "/js/vendor/ethers.js": path.resolve(path.dirname(require.resolve("ethers")), "..", "dist", "ethers.umd.min.js") };
    if (req.method === "GET" && assets[req.path] && trusted(req)) return res.sendFile(assets[req.path]);
    return authenticate(req, res, next);
  }
  return { router, authenticate, gate };
}
module.exports = { createAdminAuth, adminWallets };
