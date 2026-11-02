"use strict";
const express = require("express");
const crypto = require("node:crypto");
const { Workspace } = require("../../notes/workspace");
const fail = (status, message) => Object.assign(new Error(message), { status });
function workspaceApi({ notes, markets, cmsAuth, profileReader, env = require("../../operations/runtime").environment(), pushTransport }) {
  const workspace = new Workspace(notes, markets, profileReader), router = express.Router(), limits = new Map();
  const webPush = pushTransport || require("web-push");
  const pushEnabled = !!(env.APP_VAPID_PUBLIC_KEY && env.APP_VAPID_PRIVATE_KEY);
  if (pushEnabled) webPush.setVapidDetails("https://featheral.com", env.APP_VAPID_PUBLIC_KEY, env.APP_VAPID_PRIVATE_KEY);
  const cookie = req => String(req.get("cookie") || "").split(/;\s*/).find(value => value.startsWith("featheral_app="))?.slice(14) || "";
  const owner = req => workspace.owner(cookie(req));
  const secure = req => req.get("x-forwarded-proto") === "https" || req.secure;
  const origin = req => `${secure(req) ? "https" : "http"}://${req.get("host")}`;
  const adminHost = req => ["admin.featheral.com", "admin.localhost"].includes(req.hostname);
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    console.error("Featheral App:", error);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.message });
  });
  const limit = (req, max) => {
    const key = req.socket.remoteAddress, now = Date.now(), records = (limits.get(key) || []).filter(at => now - at < 60000);
    if (records.length >= max) throw fail(429, "Too many App requests. Wait a minute.");
    records.push(now); limits.set(key, records);
    if (limits.size > 20000) limits.delete(limits.keys().next().value);
  };
  router.use((req, res, next) => {
    if (!["app.featheral.com", "app.localhost", "silver.featheral.com", "silver.localhost", "admin.featheral.com", "admin.localhost"].includes(req.hostname))
      return res.status(404).json({ error: "Unknown App host." });
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!["GET", "HEAD"].includes(req.method) && req.get("origin") !== origin(req))
      return res.status(403).json({ error: "Same-origin App requests are required." });
    if (req.hostname.startsWith("silver.") && req.path !== "/silver")
      return res.status(404).json({ error: "Only the public Silver summary is available on this host." });
    next();
  });
  async function notify(addresses, title, body, url = "/") {
    if (!pushEnabled) return;
    for (const address of addresses) {
      if (workspace.member(address)?.status !== "active") continue;
      for (const row of notes.db.prepare("SELECT * FROM work_push WHERE address=?").all(address)) {
        try {
          await webPush.sendNotification(JSON.parse(row.subscription), JSON.stringify({ title, body, url }), { TTL: 120, timeout: 5000 });
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) notes.db.prepare("DELETE FROM work_push WHERE endpoint=?").run(row.endpoint);
          else console.error("App push delivery failed:", error.message);
        }
      }
    }
  }
  router.get("/silver", run((req, res) => res.json(workspace.silver())));
  router.post("/challenge", run((req, res) => { limit(req, 30); res.json(workspace.challenge(req.body?.address, origin(req))); }));
  router.post("/login", run((req, res) => {
    limit(req, 30); const token = workspace.login(req.body, origin(req));
    res.cookie("featheral_app", token, { httpOnly: true, secure: secure(req), sameSite: "strict", path: "/api/intranet", maxAge: 86400000 });
    res.json({ connected: true });
  }));
  router.post("/logout", run((req, res) => {
    workspace.logout(cookie(req));
    res.clearCookie("featheral_app", { path: "/api/intranet", sameSite: "strict", secure: secure(req) });
    res.json({ connected: false });
  }));
  router.get("/me", run(async (req, res) => res.json(await workspace.me(owner(req)))));
  router.post("/apply", run(async (req, res) => res.json(await workspace.apply(owner(req), req.body))));
  router.use("/admin", (req, res, next) => {
    if (!adminHost(req)) return res.status(404).json({ error: "Use the administration site." });
    cmsAuth(req, res, next);
  });
  router.get("/admin", run((req, res) => res.json(workspace.admin())));
  router.put("/admin/members/:address", run((req, res) => res.json(workspace.setMember("admin", req.params.address, req.body))));
  router.post("/admin/teams", run((req, res) => res.json(workspace.addTeam("admin", req.body))));
  router.post("/admin/missions", run((req, res) => res.json(workspace.saveMission("admin", req.body, null, true))));
  router.put("/admin/missions/:id", run((req, res) => res.json(workspace.saveMission("admin", req.body, req.params.id, true))));
  router.post("/admin/grants", run((req, res) => res.json(workspace.grant("admin", req.body))));
  router.use((req, res, next) => {
    try { workspace.active(owner(req)); next(); } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
  router.get("/directory", run(async (req, res) => {
    const members = notes.db.prepare("SELECT address,role,level,division,team FROM work_members WHERE status='active' ORDER BY division,team,address LIMIT 1000").all();
    res.json({ members: await Promise.all(members.map(async member => ({ ...member, username: (await profileReader(member.address))?.username || null }))) });
  }));
  router.get("/channels", run((req, res) => res.json({ channels: workspace.channels(owner(req)) })));
  router.post("/direct", run((req, res) => { limit(req, 60); res.json(workspace.direct(owner(req), req.body?.address)); }));
  router.get("/channels/:id/messages", run((req, res) => res.json({ messages: workspace.messages(owner(req), req.params.id, Number(req.query.after || 0)) })));
  router.post("/channels/:id/messages", run((req, res) => {
    limit(req, 100);
    const address = owner(req), message = workspace.send(address, req.params.id, req.body);
    res.json(message);
    void notify(workspace.recipients(req.params.id).filter(value => value !== address),
      "Featheral App", "New workspace message", `/#inbox/${req.params.id}`).catch(error => console.error("App notification failed:", error));
  }));
  router.post("/channels/:id/read", run((req, res) => res.json(workspace.read(owner(req), req.params.id, req.body?.message))));
  router.get("/files/:id", run((req, res) => {
    const file = workspace.file(owner(req), req.params.id);
    res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
      "Content-Security-Policy": "default-src 'none'", "Content-Length": file.size });
    res.end(Buffer.from(file.bytes));
  }));
  router.get("/channels/:id/document", run((req, res) => res.json(workspace.document(owner(req), req.params.id))));
  router.put("/channels/:id/document", run((req, res) => res.json(workspace.document(owner(req), req.params.id, req.body))));
  router.get("/missions", run((req, res) => res.json({ missions: workspace.missions(owner(req)) })));
  router.post("/missions", run((req, res) => res.json(workspace.saveMission(owner(req), req.body))));
  router.put("/missions/:id", run((req, res) => res.json(workspace.saveMission(owner(req), req.body, req.params.id))));
  router.get("/calls", run((req, res) => res.json({ calls: workspace.calls(owner(req)) })));
  router.post("/calls", run((req, res) => {
    limit(req, 60); const call = workspace.startCall(owner(req), req.body);
    res.json(call);
    void notify([call.callee], "Featheral App call", "An insider is calling. Open App to answer.", "/#inbox").catch(error => console.error("App call notification failed:", error));
  }));
  router.get("/calls/:id/signals", run((req, res) => res.json(workspace.signals(owner(req), req.params.id, Number(req.query.after || 0)))));
  router.post("/calls/:id/signals", run((req, res) => res.json(workspace.signal(owner(req), req.params.id, req.body))));
  router.get("/config", run((req, res) => {
    const urls = (env.APP_ICE_URLS || "").split(",").map(value => value.trim()).filter(Boolean);
    if (urls.some(url => !/^(?:stun|turn|turns):[a-zA-Z0-9.:[\]-]+(?:\?transport=(?:udp|tcp))?$/.test(url)))
      throw fail(503, "Administrator must correct APP_ICE_URLS.");
    const iceServers = urls.filter(url => url.startsWith("stun:")).map(url => ({ urls: url }));
    const turns = urls.filter(url => !url.startsWith("stun:"));
    if (turns.length) {
      if (!env.APP_TURN_SECRET) throw fail(503, "TURN credentials are not configured.");
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${owner(req)}`;
      iceServers.push({ urls: turns, username, credential: crypto.createHmac("sha1", env.APP_TURN_SECRET).update(username).digest("base64") });
    }
    res.json({ iceServers, turnConfigured: !!turns.length, pushPublicKey: pushEnabled ? env.APP_VAPID_PUBLIC_KEY : null });
  }));
  router.post("/push", run((req, res) => {
    if (!pushEnabled) throw fail(503, "Browser push requires administrator-configured VAPID keys.");
    const subscription = req.body, endpoint = subscription?.endpoint;
    let url;
    try { url = new URL(endpoint); } catch { throw fail(400, "Invalid push endpoint."); }
    // Restrict server-side delivery to public browser push services, never arbitrary URLs.
    if (url.href.length > 2048 || url.protocol !== "https:" || url.port || url.username || url.password
      || !["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns2-*.notify.windows.com"].some(host =>
        host.includes("*") ? /^wns2-[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname) : host === url.hostname)
      || typeof subscription.keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(subscription.keys.p256dh)
      || typeof subscription.keys?.auth !== "string" || !/^[A-Za-z0-9_-]{20,30}$/.test(subscription.keys.auth))
      throw fail(400, "Unsupported browser push subscription.");
    const address = owner(req);
    if (notes.db.prepare("SELECT COUNT(*) AS n FROM work_push WHERE address=?").get(address).n >= 5
      && !notes.db.prepare("SELECT 1 FROM work_push WHERE endpoint=? AND address=?").get(endpoint, address))
      throw fail(409, "Five devices are already registered. Disable notifications on an old device.");
    notes.db.prepare("INSERT INTO work_push VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET address=excluded.address,subscription=excluded.subscription,at=excluded.at")
      .run(endpoint, address, JSON.stringify({ endpoint, keys: subscription.keys }), Date.now());
    res.json({ subscribed: true });
  }));
  router.delete("/push", run((req, res) => {
    notes.db.prepare("DELETE FROM work_push WHERE endpoint=? AND address=?").run(String(req.body?.endpoint || ""), owner(req));
    res.json({ subscribed: false });
  }));
  router.use((req, res) => res.status(404).json({ error: "Unknown App API route." }));
  return { router, workspace };
}
module.exports = { workspaceApi };
