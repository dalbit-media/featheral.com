"use strict";

const path = require("node:path");
const { ethers } = require("ethers");
const { SocialDatabase, MAX_TEXT } = require("./social");

const ROOT = path.resolve(__dirname, "..", "..");
const BODY_LIMIT = 16 * 1024;
const PREFIX = "/api/v1/world";

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
  return true;
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > limit) {
        reject(Object.assign(new Error(`Request body exceeds ${limit / 1024} KiB.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseAddress(value) {
  if (typeof value !== "string" || !ethers.isAddress(value)) return "";
  return ethers.getAddress(value.toLowerCase());
}

function addressList(raw) {
  return String(raw || "").split(",").map((item) => item.trim()).filter((item) => ethers.isAddress(item)).map((item) => ethers.getAddress(item.toLowerCase()));
}

// Profiles remain an independent service; this database owns only social actions.
function createWorldApi({ env = require("../operations/runtime").environment(), sqlite, profiles = null, profileHandler = null, authorizeMedia = null, logger = console } = {}) {
  if (!sqlite || typeof sqlite.open !== "function") throw new Error("World Feed Database requires an injected managed sqlite opener from services/database/sqlite.js.");
  const admins = addressList(env.FEATHERAL_ADMIN_WALLETS);
  const moderators = [...new Set([...addressList(env.WORLD_MODERATORS), ...admins])];
  const database = new SocialDatabase({
    sqlite,
    file: path.resolve(env.WORLD_DB_FILE || path.join(ROOT, "data", "world-feed.sqlite")),
    moderators,
  });
  const buckets = new Map();

  function rateLimit(req, bucket, perMinute) {
    const key = `${bucket}:${req.socket?.remoteAddress || "local"}`;
    const now = Date.now();
    const recent = (buckets.get(key) || []).filter((time) => now - time < 60_000);
    if (recent.length >= perMinute) throw Object.assign(new Error("Too many requests. Try again in a minute."), { status: 429 });
    recent.push(now);
    buckets.set(key, recent);
    if (buckets.size > 20_000) buckets.delete(buckets.keys().next().value);
  }

  function profileOf(address) {
    const profile = profiles?.get(address);
    return profile ? { address: profile.address, username: profile.username, avatar: profile.avatar, bio: profile.bio || "" } : { address, username: "", avatar: "", bio: "" };
  }

  function withProfiles(posts) {
    const cache = new Map();
    const lookup = (address) => {
      if (!cache.has(address)) cache.set(address, profileOf(address));
      return cache.get(address);
    };
    return posts.map((post) => ({ ...post, authorProfile: lookup(post.author), repostedByProfile: post.repostedBy ? lookup(post.repostedBy) : null }));
  }

  function viewerFrom(url) {
    return parseAddress(url.searchParams.get("viewer") || "");
  }

  async function body(req, limit) {
    req.rawBody = await readBody(req, limit);
    if (!req.rawBody) return {};
    try { return JSON.parse(req.rawBody); } catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  }

  async function submitAction(req, res) {
    const input = await body(req);
    rateLimit(req, "social", 60);
    const kind = String(input.kind || "").toUpperCase();
    if (new URL(`http://${req.headers.host || "localhost"}`).hostname.startsWith("media.")) {
      if (!authorizeMedia) throw Object.assign(new Error("World sign-in is unavailable."), { status: 503 });
      authorizeMedia(input.worldSession, input.data?.w);
    }
    if (!["SESSION", "POST", "DELETE", "LIKE", "UNLIKE", "REPOST", "UNREPOST", "FOLLOW", "UNFOLLOW", "MOD"].includes(kind)) {
      throw Object.assign(new Error("Unknown action kind."), { status: 400 });
    }
    const receipt = database.submit({ kind, data: input.data });
    const result = { status: "committed", receipt };
    if (kind === "POST") {
      const post = database.postRow(receipt.id, input.data.w);
      result.post = withProfiles([{ ...post, at: post.timeMs, repostedBy: "" }])[0];
    }
    return json(res, 200, result);
  }

  async function handleWorld(req, res, url) {
    const route = url.pathname.slice(PREFIX.length);
    const q = url.searchParams;
    if (req.method === "GET" && route === "/profile/ui") return json(res, 200, require("../identity/profile-ui").profileUi());
    if (req.method === "POST" && route === "/profile/prepare") {
      if (new URL(`http://${req.headers.host || ""}`).hostname.startsWith("media."))
        return json(res, 410, { error: "Profile setup has moved to World. Open /account/ on World." });
      rateLimit(req, "profile-prepare", 20);
      return json(res, 200, require("../identity/profile-ui").prepareProfile(await body(req, 64 * 1024)));
    }
    if (req.method === "POST" && route === "/profile") {
      if (new URL(`http://${req.headers.host || ""}`).hostname.startsWith("media."))
        return json(res, 410, { error: "Profile setup has moved to World. Open /account/ on World." });
      if (!profileHandler) return json(res, 503, { error: "World profile updates require the configured DB API profile service." });
      return profileHandler(req, res);
    }
    const profileMatch = route.match(/^\/profile\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && profileMatch) {
      const profile = profiles?.get(parseAddress(profileMatch[1]));
      return json(res, 200, { profile: profile ? { ...profileOf(profile.address), issuedAt: profile.issuedAt } : null });
    }
    if (req.method === "POST" && route === "/actions") return submitAction(req, res);
    if (req.method === "POST" && route === "/sql") {
      rateLimit(req, "sql", 60);
      const input = await body(req);
      return json(res, 200, database.sqlQuery(input.query));
    }
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
    if (route === "/stats") return json(res, 200, { database: database.summary(), maxTextLength: MAX_TEXT, checkedAt: new Date().toISOString() });
    if (route === "/timeline") {
      const author = parseAddress(q.get("author") || "");
      const result = database.timeline({ viewer: viewerFrom(url), scope: q.get("scope") === "following" ? "following" : "all", before: q.get("before"), limit: q.get("limit"), author, tab: q.get("tab") || "posts" });
      return json(res, 200, { posts: withProfiles(result.posts), next: result.next });
    }
    const postMatch = route.match(/^\/posts\/(0x[0-9a-f]{64})$/);
    if (postMatch) {
      const thread = database.thread(postMatch[1], viewerFrom(url));
      if (!thread) return json(res, 404, { error: "Post not found." });
      return json(res, 200, { post: withProfiles([thread.post])[0], ancestors: withProfiles(thread.ancestors), replies: withProfiles(thread.replies) });
    }
    const userMatch = route.match(/^\/users\/(0x[0-9a-fA-F]{40})$/);
    if (userMatch) {
      const address = parseAddress(userMatch[1]);
      return json(res, 200, { profile: profileOf(address), stats: database.userStats(address, viewerFrom(url)), moderator: database.isModerator(address) });
    }
    if (route === "/search") {
      const query = String(q.get("q") || "").trim();
      if (!query) return json(res, 200, { posts: [], users: [] });
      const name = query.replace(/^@/, "").toLowerCase();
      const owner = profiles?.owner(name) || "";
      const users = owner ? [profileOf(ethers.getAddress(owner))] : [];
      if (ethers.isAddress(query)) users.push(profileOf(parseAddress(query)));
      return json(res, 200, { posts: withProfiles(database.search(query, viewerFrom(url))), users });
    }
    if (route === "/suggestions") {
      const viewer = viewerFrom(url);
      return json(res, 200, { users: database.suggestions(viewer).map((row) => ({ ...row, profile: profileOf(row.address) })) });
    }
    if (route === "/session") {
      const address = parseAddress(q.get("address") || "");
      const session = address ? database.session(address) : null;
      return json(res, 200, { session: session ? { key: session.key, expiresAt: session.exp } : null, suspended: address ? database.isSuspended(address) : false });
    }
    if (route === "/sql/schema") return json(res, 200, { tables: database.sqlSchema() });
    if (route === "/sql") {
      rateLimit(req, "sql", 60);
      return json(res, 200, database.sqlQuery(q.get("q")));
    }
    if (route === "/moderation") {
      return json(res, 200, { moderators: [...database.moderators], suspended: database.suspendedWallets(), posts: database.recentPosts({ before: q.get("before"), limit: q.get("limit") }).map((post) => ({ ...post, deleted: Boolean(post.deleted), hidden: Boolean(post.hidden) })) });
    }
    return json(res, 404, { error: "World feed route not found." });
  }

  async function handle(req, res) {
    if (!req.url) return false;
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/v1/media" || url.pathname.startsWith("/api/v1/media/"))
      url.pathname = PREFIX + url.pathname.slice("/api/v1/media".length);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      await handleWorld(req, res, url);
    } catch (error) {
      const status = Number(error.status) || (/signature|Signature/.test(error.message) ? 401 : /already|Already/.test(error.message) ? 409 : 400);
      if (status >= 500) logger.error("World API request failed:", error);
      if (res.headersSent) res.end();
      else json(res, status, { error: error.message || "Request failed." });
    }
    return true;
  }

  return { handle, start() {}, close: () => database.close(), database, admins, moderators };
}

module.exports = { createWorldApi };
