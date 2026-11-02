"use strict";
const express = require("express");
const { SilverStore } = require("../../notes-api/silver-store");
function silverApi({ notes, markets, cmsAuth, env = process.env }) {
  const store = new SilverStore(notes, markets, env), router = express.Router(), limits = new Map();
  const secure = req => req.secure || req.get("x-forwarded-proto") === "https";
  const origin = req => `${secure(req) ? "https" : "http"}://${req.get("host")}`;
  const cookie = req => String(req.get("cookie") || "").split(/;\s*/).find(value => value.startsWith("featheral_silver="))?.slice(17) || "";
  const owner = req => store.owner(cookie(req));
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    console.error("Silver marketplace:", error.message);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : "Silver marketplace operation failed. Contact the administrator." });
  });
  router.use((req, res, next) => {
    if (!["silver.featheral.com", "silver.localhost", "admin.featheral.com", "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Unknown Silver host." });
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!["GET", "HEAD"].includes(req.method)) {
      if (req.get("origin") !== origin(req)) return res.status(403).json({ error: "Same-origin Silver requests are required." });
      const key = req.socket.remoteAddress, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 60000);
      if (records.length >= 100) return res.status(429).json({ error: "Too many Silver requests. Wait a minute." });
      records.push(now); limits.set(key, records); if (limits.size > 20000) limits.delete(limits.keys().next().value);
    }
    next();
  });
  router.use("/admin", (req, res, next) => {
    if (!req.hostname.startsWith("admin.")) return res.status(404).json({ error: "Use the administration site." });
    cmsAuth(req, res, next);
  });
  router.get("/admin", run((req, res) => res.json(store.admin())));
  router.put("/admin/settings", run((req, res) => res.json(store.configure(req.body))));
  router.post("/admin/products", run((req, res) => res.json(store.saveProduct(req.body))));
  router.put("/admin/products/:id", run((req, res) => res.json(store.saveProduct(req.body, req.params.id))));
  router.post("/admin/products/:id/stock", run((req, res) => res.json(store.addStock(req.params.id, req.body))));
  router.get("/admin/products/:id/stock", run((req, res) => res.json({ inventory: store.inventory(req.params.id) })));
  router.post("/admin/products/:id/stock/:code/retire", run((req, res) => res.json(store.retireStock(req.params.id, req.params.code))));
  router.post("/admin/orders/:id/deliver", run((req, res) => res.json(store.fulfill(req.params.id))));
  router.post("/admin/orders/:id/refund", run((req, res) => res.json(store.refund(req.params.id))));
  router.use((req, res, next) => {
    if (!req.hostname.startsWith("silver.")) return res.status(404).json({ error: "Use the Silver storefront." });
    next();
  });
  router.get("/catalog", run((req, res) => res.json({ settings: store.settings(), products: store.catalog() })));
  router.post("/challenge", run((req, res) => res.json(store.challenge(req.body?.address, origin(req)))));
  router.post("/login", run((req, res) => {
    const token = store.login(req.body, origin(req));
    res.cookie("featheral_silver", token, { httpOnly: true, secure: secure(req), sameSite: "strict", path: "/api/silver", maxAge: 86400000 });
    res.json({ connected: true });
  }));
  router.post("/logout", run((req, res) => {
    store.logout(cookie(req)); res.clearCookie("featheral_silver", { path: "/api/silver", sameSite: "strict", secure: secure(req) }); res.json({ connected: false });
  }));
  router.get("/me", run((req, res) => { const address = owner(req); res.json({ address, balance: notes.balance(address, "FTHS"), orders: store.orders(address) }); }));
  router.post("/orders", run((req, res) => res.json(store.prepare(owner(req), req.body, origin(req)))));
  router.post("/orders/:id/pay", run((req, res) => res.json(store.pay(owner(req), req.params.id, req.body?.signature, origin(req)))));
  router.get("/orders/:id/code", run((req, res) => res.json(store.reveal(owner(req), req.params.id))));
  return { router, store };
}
module.exports = { silverApi };
