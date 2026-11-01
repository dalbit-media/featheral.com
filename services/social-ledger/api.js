"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { SocialLedger, verifyAction, MAX_TEXT } = require("./social");
const { walletAccountId } = require("../fth-ledger/ledger");

const ROOT = path.resolve(__dirname, "..", "..");
const BODY_LIMIT = 16 * 1024;
const SYNC_PAGE = 500;
const PREFIX = "/api/v1/world";
const STORAGE_LAYOUT = "Daily minified JSON block files: <dir>/YYYY/YYYY-MM-DD.jsonl (one block per line)";

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        reject(Object.assign(new Error("Request body exceeds 16 KiB."), { status: 413 }));
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

// HTTP surface of the World communication ledger (a second, independent ledger beside FTH$).
// Profiles (usernames, avatars) are read from the FTH$ ledger so identity stays single-sourced.
function createWorldApi({ env = process.env, fthLedger = null, logger = console } = {}) {
  const setting = (name) => env[`WORLD_LEDGER_${name}`] ?? "";
  const nodeId = setting("NODE_ID") || "local-world-node";
  const mode = setting("MODE") === "reader" ? "reader" : "writer";
  const upstream = setting("UPSTREAM_URL").replace(/\/+$/, "");
  const admins = addressList(env.FEATHERAL_ADMIN_WALLETS);
  const moderators = [...new Set([...addressList(env.WORLD_MODERATORS), ...admins])];
  const ledger = new SocialLedger({
    directory: path.resolve(setting("DIR") || path.join(ROOT, "data", "world-ledger", nodeId)),
    nodeId,
    mode,
    signingKey: setting("SIGNING_PRIVATE_KEY") || null,
    writerPublicKey: setting("WRITER_PUBLIC_KEY") || null,
    blockIntervalMs: setting("BLOCK_INTERVAL_MS") === "" ? 1000 : Number(setting("BLOCK_INTERVAL_MS")),
    moderators,
  }).open();
  const buckets = new Map();
  let syncing = false;
  let syncTimer;
  const counters = { syncErrors: 0, lastSyncAt: "", lastSyncError: "" };

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
    const profile = fthLedger?.profile(address);
    return profile ? { address: profile.address, username: profile.username, avatar: profile.avatar } : { address, username: "", avatar: "" };
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

  async function body(req) {
    req.rawBody = await readBody(req);
    if (!req.rawBody) return {};
    try { return JSON.parse(req.rawBody); } catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  }

  async function forwardToWriter(req, res) {
    if (!upstream) throw Object.assign(new Error("This read node has no writer configured."), { status: 503 });
    const response = await fetch(`${upstream}${PREFIX}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: req.rawBody, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
    if (response.ok) syncFromUpstream();
    return true;
  }

  async function submitAction(req, res) {
    const input = await body(req);
    if (mode === "reader") return forwardToWriter(req, res);
    rateLimit(req, "social", 60);
    const kind = String(input.kind || "").toUpperCase();
    if (!["SESSION", "POST", "DELETE", "LIKE", "UNLIKE", "REPOST", "UNREPOST", "FOLLOW", "UNFOLLOW", "MOD"].includes(kind)) {
      throw Object.assign(new Error("Unknown action kind."), { status: 400 });
    }
    const { author } = verifyAction(kind, input.data);
    if (ledger.isSuspended(author) && kind !== "MOD") throw Object.assign(new Error("This wallet is suspended from Featheral World."), { status: 403 });
    if (kind === "MOD" && !ledger.isModerator(author)) throw Object.assign(new Error("Only configured Featheral admin wallets can moderate."), { status: 403 });
    const receipt = await ledger.submit({ id: `soc:${author.toLowerCase()}:${input.data.n}`, kind, account: walletAccountId(author), data: input.data }, { fresh: true });
    const result = { status: "sealed", receipt };
    if (kind === "POST") result.post = withProfiles([{ ...ledger.postRow(receipt.hash, author), at: Date.now(), repostedBy: "" }])[0];
    return json(res, 200, result);
  }

  function nodeInfo() {
    return { id: nodeId, mode, storage: STORAGE_LAYOUT, upstream: mode === "reader" ? upstream || "file copy (rsync/object sync)" : "", lastSyncAt: counters.lastSyncAt || null, syncErrors: counters.syncErrors, lastSyncError: counters.lastSyncError || null };
  }

  async function handleWorld(req, res, url) {
    const route = url.pathname.slice(PREFIX.length);
    const q = url.searchParams;
    if (req.method === "POST" && route === "/actions") return submitAction(req, res);
    if (req.method === "POST" && route === "/sql") {
      rateLimit(req, "sql", 60);
      const input = await body(req);
      return json(res, 200, ledger.sqlQuery(input.query));
    }
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
    if (route === "/stats") return json(res, 200, { ledger: ledger.summary(), node: nodeInfo(), maxTextLength: MAX_TEXT, checkedAt: new Date().toISOString() });
    if (route === "/timeline") {
      const author = parseAddress(q.get("author") || "");
      const result = ledger.timeline({ viewer: viewerFrom(url), scope: q.get("scope") === "following" ? "following" : "all", before: q.get("before"), limit: q.get("limit"), author, tab: q.get("tab") || "posts" });
      return json(res, 200, { posts: withProfiles(result.posts), next: result.next });
    }
    const postMatch = route.match(/^\/posts\/(0x[0-9a-f]{64})$/);
    if (postMatch) {
      const thread = ledger.thread(postMatch[1], viewerFrom(url));
      if (!thread) return json(res, 404, { error: "Post not found." });
      return json(res, 200, { post: withProfiles([thread.post])[0], ancestors: withProfiles(thread.ancestors), replies: withProfiles(thread.replies) });
    }
    const userMatch = route.match(/^\/users\/(0x[0-9a-fA-F]{40})$/);
    if (userMatch) {
      const address = parseAddress(userMatch[1]);
      return json(res, 200, { profile: profileOf(address), stats: ledger.userStats(address, viewerFrom(url)), moderator: ledger.isModerator(address) });
    }
    if (route === "/search") {
      const query = String(q.get("q") || "").trim();
      if (!query) return json(res, 200, { posts: [], users: [] });
      const name = query.replace(/^@/, "").toLowerCase();
      const owner = fthLedger?.usernameOwner(name) || "";
      const users = owner ? [profileOf(ethers.getAddress(owner))] : [];
      if (ethers.isAddress(query)) users.push(profileOf(parseAddress(query)));
      return json(res, 200, { posts: withProfiles(ledger.search(query, viewerFrom(url))), users });
    }
    if (route === "/suggestions") {
      const viewer = viewerFrom(url);
      return json(res, 200, { users: ledger.suggestions(viewer).map((row) => ({ ...row, profile: profileOf(row.address) })) });
    }
    if (route === "/session") {
      const address = parseAddress(q.get("address") || "");
      const session = address ? ledger.sessions.get(address.toLowerCase()) : null;
      return json(res, 200, { session: session ? { key: session.key, expiresAt: session.exp } : null, suspended: address ? ledger.isSuspended(address) : false });
    }
    if (route === "/blocks") return json(res, 200, { height: ledger.height, blocks: ledger.latestBlocks({ before: q.get("before"), limit: q.get("limit") }) });
    const blockMatch = route.match(/^\/blocks\/(\d+)$/);
    if (blockMatch) {
      const block = ledger.block(Number(blockMatch[1]));
      return block ? json(res, 200, block) : json(res, 404, { error: "Block not found." });
    }
    const txMatch = route.match(/^\/tx\/(0x[0-9a-fA-F]{64})$/);
    if (txMatch) {
      const tx = ledger.tx(txMatch[1]);
      return tx ? json(res, 200, tx) : json(res, 404, { error: "Transaction not found." });
    }
    if (route === "/transactions") return json(res, 200, { transactions: ledger.latestTransactions(Number(q.get("limit") || 25)) });
    if (route === "/sql/schema") return json(res, 200, { tables: ledger.sqlSchema() });
    if (route === "/sql") {
      rateLimit(req, "sql", 60);
      return json(res, 200, ledger.sqlQuery(q.get("q")));
    }
    if (route === "/moderation") {
      return json(res, 200, { moderators: [...ledger.moderators], suspended: ledger.suspendedWallets(), posts: ledger.recentPosts({ before: q.get("before"), limit: q.get("limit") }).map((post) => ({ ...post, deleted: Boolean(post.deleted), hidden: Boolean(post.hidden) })) });
    }
    if (route === "/sync") {
      const from = Math.max(0, Number(q.get("from") || 0));
      return json(res, 200, { height: ledger.height, tipHash: ledger.tipHash, blocks: ledger.blocksFrom(from, Number(q.get("limit") || SYNC_PAGE)) });
    }
    if (route === "/files") return json(res, 200, { layout: STORAGE_LAYOUT, height: ledger.height, tipHash: ledger.tipHash, writerPublicKey: ledger.summary().writerPublicKey, files: ledger.store.manifest() });
    const fileMatch = route.match(/^\/files\/(\d{4}\/\d{4}-\d{2}-\d{2}\.jsonl)$/);
    if (fileMatch) {
      let content;
      try { content = ledger.store.rawFile(fileMatch[1]); } catch { return json(res, 404, { error: "Ledger file not found." }); }
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": fileMatch[1].includes(today) ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="world-${path.basename(fileMatch[1])}"`,
      });
      res.end(content);
      return true;
    }
    return json(res, 404, { error: "World ledger route not found." });
  }

  async function handle(req, res) {
    if (!req.url || !(req.url === PREFIX || req.url.startsWith(`${PREFIX}/`) || req.url.startsWith(`${PREFIX}?`))) return false;
    const url = new URL(req.url, "http://localhost");
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

  async function syncFromUpstream() {
    if (syncing || mode !== "reader") return;
    syncing = true;
    try {
      if (!upstream) ledger.syncFromDisk();
      else {
        let more = true;
        while (more) {
          const response = await fetch(`${upstream}${PREFIX}/sync?from=${ledger.height + 1}&limit=${SYNC_PAGE}`, { signal: AbortSignal.timeout(15_000) });
          const page = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`Writer returned HTTP ${response.status}: ${page.error || ""}`);
          if (!Array.isArray(page.blocks)) throw new Error("Writer returned an invalid sync page.");
          for (const block of page.blocks) ledger.importBlock(block);
          more = page.blocks.length > 0 && ledger.height < Number(page.height);
        }
      }
      counters.lastSyncAt = new Date().toISOString();
      counters.lastSyncError = "";
    } catch (error) {
      counters.syncErrors += 1;
      counters.lastSyncError = error.message;
      logger.error(`[${nodeId}] World ledger sync failed: ${error.message}`);
    } finally {
      syncing = false;
    }
  }

  function start() {
    if (mode !== "reader") return;
    syncFromUpstream();
    syncTimer = setInterval(syncFromUpstream, Math.max(1000, Number(setting("SYNC_INTERVAL_MS")) || 5000));
    syncTimer.unref?.();
  }

  function close() {
    clearInterval(syncTimer);
    ledger.close();
  }

  return { handle, start, close, ledger, mode, nodeId, admins, moderators };
}

module.exports = { createWorldApi };
