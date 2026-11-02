"use strict";

const { ethers } = require("ethers");
const { randomBytes } = require("node:crypto");
const { assertFreshSignature } = require("../identity/profile");
const { FeedDatabase } = require("./database");

const MAX_TEXT = 280;
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{16,32}$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const MOD_ACTIONS = new Set(["HIDE", "UNHIDE", "SUSPEND", "RESTORE"]);
const ACTION_FIELDS = {
  SESSION: ["k", "exp"],
  POST: ["text", "rp"],
  DELETE: ["p"],
  LIKE: ["p"],
  UNLIKE: ["p"],
  REPOST: ["p"],
  UNREPOST: ["p"],
  FOLLOW: ["u"],
  UNFOLLOW: ["u"],
  MOD: ["act", "tg"],
};
const COMMON_FIELDS = ["w", "by", "n", "ts", "sig"];

function socialError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function clamp(value, fallback, max) {
  return Math.max(1, Math.min(max, Number(value) || fallback));
}

// The browser builds the identical text, so wallets (and session keys) sign exactly what is recorded.
function socialMessage(kind, d) {
  const lines = ["Featheral World social action", "", `Action: ${kind}`, `Author: ${d.w}`];
  if (kind === "POST") lines.push(`Reply to: ${d.rp || "(none)"}`, `Text: ${JSON.stringify(d.text)}`);
  else if (kind === "SESSION") lines.push(`Session key: ${d.k}`, `Expires: ${new Date(d.exp).toISOString()}`);
  else if (kind === "FOLLOW" || kind === "UNFOLLOW") lines.push(`Account: ${d.u}`);
  else if (kind === "MOD") lines.push(`Moderation: ${d.act}`, `Target: ${d.tg}`);
  else lines.push(`Post: ${d.p}`);
  lines.push(`Nonce: ${d.n}`, `Issued at: ${d.ts}`, "Ledger: Featheral World communication ledger", "", "Signing is free and only authorizes this action on the World ledger.");
  return lines.join("\n");
}

function checksummed(value, name) {
  if (typeof value !== "string" || !ethers.isAddress(value) || ethers.getAddress(value) !== value || value === ethers.ZeroAddress) {
    throw socialError(`${name} must be a checksummed Ethereum address.`);
  }
  return value;
}

// The legacy signing domain is retained for existing signed-in browser sessions.
function verifyAction(kind, d) {
  if (!Object.hasOwn(ACTION_FIELDS, kind)) throw socialError("Unknown action kind.");
  if (!d || typeof d !== "object" || Array.isArray(d)) throw socialError("Action data must be an object.");
  const allowed = new Set([...COMMON_FIELDS, ...ACTION_FIELDS[kind]]);
  for (const key of Object.keys(d)) if (!allowed.has(key)) throw socialError(`Unexpected field ${key}.`);
  for (const key of allowed) if (d[key] === undefined) throw socialError(`Missing field ${key}.`);
  const author = checksummed(d.w, "Author");
  const signer = checksummed(d.by, "Signer");
  if (typeof d.n !== "string" || !NONCE.test(d.n)) throw socialError("Nonce must be 16-32 lowercase hex characters.");
  const issuedAtMs = Date.parse(d.ts);
  if (typeof d.ts !== "string" || !Number.isFinite(issuedAtMs) || new Date(issuedAtMs).toISOString() !== d.ts) throw socialError("ts must be an ISO-8601 UTC timestamp.");
  if (typeof d.sig !== "string" || !ethers.isHexString(d.sig)) throw socialError("signature must be a hex string.");
  switch (kind) {
    case "POST": {
      if (typeof d.text !== "string" || d.text !== d.text.trim() || CONTROL.test(d.text)) throw socialError("Post text must be trimmed printable text.");
      const length = Array.from(d.text).length;
      if (length < 1 || length > MAX_TEXT) throw socialError(`Posts must be 1-${MAX_TEXT} characters.`);
      if (typeof d.rp !== "string" || (d.rp !== "" && !BYTES32.test(d.rp))) throw socialError("Reply target must be a post id or empty.");
      break;
    }
    case "SESSION":
      checksummed(d.k, "Session key");
      if (!Number.isSafeInteger(d.exp)) throw socialError("Session expiry must be epoch milliseconds.");
      break;
    case "FOLLOW":
    case "UNFOLLOW":
      checksummed(d.u, "Account");
      break;
    case "MOD":
      if (!MOD_ACTIONS.has(d.act)) throw socialError("Unknown moderation action.");
      if (typeof d.tg !== "string" || !(d.act === "HIDE" || d.act === "UNHIDE" ? BYTES32.test(d.tg) : ethers.isAddress(d.tg) && ethers.getAddress(d.tg) === d.tg)) throw socialError("Moderation target is invalid.");
      break;
    default:
      if (typeof d.p !== "string" || !BYTES32.test(d.p)) throw socialError("Post id must be bytes32.");
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(socialMessage(kind, d), d.sig);
  } catch {
    throw socialError("Signature is malformed.", 401);
  }
  if (recovered !== signer) throw socialError("Signature was not made by the declared signer.", 401);
  return { author, signer, issuedAtMs };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, author TEXT NOT NULL, signer TEXT NOT NULL,
  nonce TEXT NOT NULL, issued_at TEXT NOT NULL, time TEXT NOT NULL, time_ms INTEGER NOT NULL,
  target TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(author, nonce)
);
CREATE INDEX IF NOT EXISTS actions_author ON actions(author);
CREATE INDEX IF NOT EXISTS actions_kind ON actions(kind);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT NOT NULL,
  time TEXT NOT NULL, time_ms INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_author ON posts(author, time_ms);
CREATE INDEX IF NOT EXISTS posts_reply ON posts(reply_to);
CREATE INDEX IF NOT EXISTS posts_time ON posts(time_ms);
CREATE TABLE IF NOT EXISTS likes (post_id TEXT NOT NULL REFERENCES posts(id), author TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (post_id, author));
CREATE INDEX IF NOT EXISTS likes_author ON likes(author, time_ms);
CREATE TABLE IF NOT EXISTS reposts (post_id TEXT NOT NULL REFERENCES posts(id), author TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (post_id, author));
CREATE INDEX IF NOT EXISTS reposts_author ON reposts(author, time_ms);
CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (follower, followee));
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee);
CREATE TABLE IF NOT EXISTS sessions (wallet TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS moderation (action_id TEXT PRIMARY KEY REFERENCES actions(id), moderator TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, time_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS suspended (wallet TEXT PRIMARY KEY);
`;

const COMMENTS = {
  actions: "Persisted signed offchain database writes. Author/nonce is unique; data includes the original signature. IDs are opaque, not transaction hashes.",
  posts: "Posts and replies. id is an opaque post identifier. deleted is set by the author; hidden by a configured moderator.",
  likes: "Current likes (an UNLIKE removes the row).",
  reposts: "Current reposts.",
  follows: "Current follow edges, wallet to wallet.",
  sessions: "Latest session-key delegation per wallet (lets the browser sign without a wallet popup).",
  moderation: "Actions authorized by configured moderators.",
  suspended: "Wallets currently suspended by a configured moderator.",
};

class SocialDatabase {
  constructor(options = {}) {
    this.moderators = new Set((options.moderators || []).map((address) => String(address).toLowerCase()));
    this.sql = new FeedDatabase({ ...options, schema: SCHEMA, comments: COMMENTS });
  }

  submit({ kind, data: d }) {
    const { author, signer, issuedAtMs } = verifyAction(kind, d);
    // Lock before inspecting authorization, nonce and relationship state. No async work
    // occurs between BEGIN IMMEDIATE and COMMIT, including on separate API connections.
    return this.sql.transaction(() => {
      const now = Date.now();
      assertFreshSignature(issuedAtMs, now, "Action");
      const payload = JSON.stringify(Object.fromEntries(Object.keys(d).sort().map((key) => [key, d[key]])));
      const previous = this.sql.get("SELECT id, kind, data FROM actions WHERE author = ? AND nonce = ?", author, d.n);
      if (previous) {
        if (previous.kind !== kind || previous.data !== payload) throw socialError("Nonce was already used for a different action.", 409);
        return { id: previous.id, status: "committed", replayed: true };
      }
      if (this.isSuspended(author) && kind !== "MOD") throw socialError("This wallet is suspended from Featheral World.", 403);
      if (kind === "MOD" && !this.isModerator(author)) throw socialError("Only configured moderators can moderate.", 403);
      if (signer !== author) {
        if (kind === "SESSION" || kind === "MOD") throw socialError("This action must be signed by the wallet itself.", 401);
        const session = this.session(author);
        if (!session || session.key !== signer || now >= session.exp) throw socialError("Session key is missing, replaced, or expired. Sign in again.", 401);
      }
      const live = (id) => {
        const post = this.sql.get("SELECT author, deleted, hidden FROM posts WHERE id = ?", id);
        if (!post || post.deleted || post.hidden || this.isSuspended(post.author)) throw socialError("Post was not found.", 404);
        return post;
      };
      const id = `0x${randomBytes(32).toString("hex")}`;
      const time = new Date(now).toISOString();
      this.sql.run("INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,?)", id, kind, author, signer, d.n, d.ts, time, now, d.p || d.u || d.tg || d.rp || d.k || "", payload);
      switch (kind) {
        case "SESSION":
          if (d.exp <= now || d.exp > now + MAX_SESSION_MS) throw socialError("Session must expire within 7 days.");
          this.sql.run("INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(wallet) DO UPDATE SET session_key = excluded.session_key, expires_at = excluded.expires_at", author, d.k, d.exp);
          break;
        case "POST":
          if (d.rp) live(d.rp);
          this.sql.run("INSERT INTO posts (id, author, text, reply_to, time, time_ms) VALUES (?,?,?,?,?,?)", id, author, d.text, d.rp, time, now);
          break;
        case "DELETE": {
          const post = this.sql.get("SELECT author, deleted FROM posts WHERE id = ?", d.p);
          if (!post || post.deleted) throw socialError("Post was not found.", 404);
          if (post.author !== author) throw socialError("Only the author can delete a post.", 403);
          this.sql.run("UPDATE posts SET deleted = 1 WHERE id = ?", d.p);
          break;
        }
        case "LIKE":
        case "UNLIKE":
        case "REPOST":
        case "UNREPOST": {
          live(d.p);
          const table = kind.endsWith("LIKE") ? "likes" : "reposts";
          const exists = Boolean(this.sql.get(`SELECT 1 FROM ${table} WHERE post_id = ? AND author = ?`, d.p, author));
          const adding = kind === "LIKE" || kind === "REPOST";
          if (adding === exists) throw socialError(adding ? "Already done." : "Nothing to undo.", 409);
          if (adding) this.sql.run(`INSERT INTO ${table} VALUES (?,?,?)`, d.p, author, now);
          else this.sql.run(`DELETE FROM ${table} WHERE post_id = ? AND author = ?`, d.p, author);
          break;
        }
        case "FOLLOW":
        case "UNFOLLOW": {
          if (d.u === author) throw socialError("You cannot follow yourself.");
          const exists = Boolean(this.sql.get("SELECT 1 FROM follows WHERE follower = ? AND followee = ?", author, d.u));
          const adding = kind === "FOLLOW";
          if (adding === exists) throw socialError(adding ? "Already following." : "Not following.", 409);
          if (adding) this.sql.run("INSERT INTO follows VALUES (?,?,?)", author, d.u, now);
          else this.sql.run("DELETE FROM follows WHERE follower = ? AND followee = ?", author, d.u);
          break;
        }
        case "MOD":
          if (d.act === "HIDE" || d.act === "UNHIDE") {
            if (!this.sql.get("SELECT 1 FROM posts WHERE id = ?", d.tg)) throw socialError("Post was not found.", 404);
            this.sql.run("UPDATE posts SET hidden = ? WHERE id = ?", d.act === "HIDE" ? 1 : 0, d.tg);
          } else if (d.act === "SUSPEND") {
            this.sql.run("INSERT OR IGNORE INTO suspended VALUES (?)", d.tg);
          } else {
            this.sql.run("DELETE FROM suspended WHERE wallet = ?", d.tg);
          }
          this.sql.run("INSERT INTO moderation VALUES (?,?,?,?,?)", id, author, d.act, d.tg, now);
          break;
        default:
          throw socialError("Unsupported action kind.");
      }
      return { id, status: "committed", replayed: false };
    });
  }

  session(address) { return this.sql.get("SELECT session_key AS key, expires_at AS exp FROM sessions WHERE wallet = ?", address); }
  sqlQuery(query) { return this.sql.query(query); }
  sqlSchema() { return this.sql.schema(); }
  close() { this.sql.close(); }

  isModerator(address) {
    return this.moderators.has(String(address).toLowerCase());
  }

  isSuspended(address) {
    return Boolean(this.sql.get("SELECT 1 AS yes FROM suspended WHERE wallet = ?", ethers.getAddress(address)));
  }

  /* ------------------------------ timelines ------------------------------ */

  postRow(id, viewer = "") {
    const row = this.sql.get(
      `SELECT p.id, p.author, p.text, p.reply_to AS replyTo, p.time, p.time_ms AS timeMs, p.deleted, p.hidden,
        (SELECT count(*) FROM likes l WHERE l.post_id = p.id) AS likes,
        (SELECT count(*) FROM reposts r WHERE r.post_id = p.id) AS reposts,
        (SELECT count(*) FROM posts c WHERE c.reply_to = p.id AND c.deleted = 0 AND c.hidden = 0) AS replies,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.author = ?) AS liked,
        EXISTS(SELECT 1 FROM reposts r WHERE r.post_id = p.id AND r.author = ?) AS reposted
       FROM posts p WHERE p.id = ?`, viewer, viewer, id,
    );
    if (!row) return null;
    return { ...row, deleted: Boolean(row.deleted), hidden: Boolean(row.hidden), liked: Boolean(row.liked), reposted: Boolean(row.reposted) };
  }

  hydrate(rows, viewer) {
    return rows.map((row) => ({ ...this.postRow(row.post_id, viewer), at: row.at, repostedBy: row.reposter || "" })).filter((post) => post.id);
  }

  timeline({ viewer = "", scope = "all", before = 0, limit = 30, author = "", tab = "posts" } = {}) {
    const size = clamp(limit, 30, 100);
    const visible = "p.deleted = 0 AND p.hidden = 0 AND p.author NOT IN (SELECT wallet FROM suspended)";
    const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
    const params = [];
    let inner;
    if (tab === "replies") {
      inner = `SELECT p.id AS post_id, p.time_ms AS at, '' AS reposter FROM posts p WHERE ${visible} AND p.reply_to <> '' AND p.author = ?`;
      params.push(author);
    } else if (tab === "likes") {
      inner = `SELECT l.post_id AS post_id, l.time_ms AS at, '' AS reposter FROM likes l JOIN posts p ON p.id = l.post_id WHERE ${visible} AND l.author = ?`;
      params.push(author);
    } else {
      let postFilter = "";
      let repostFilter = "";
      const postParams = [];
      const repostParams = [];
      if (author) {
        postFilter = " AND p.author = ?";
        repostFilter = " AND r.author = ?";
        postParams.push(author);
        repostParams.push(author);
      } else if (scope === "following" && viewer) {
        postFilter = " AND (p.author IN (SELECT followee FROM follows WHERE follower = ?) OR p.author = ?)";
        repostFilter = " AND (r.author IN (SELECT followee FROM follows WHERE follower = ?) OR r.author = ?)";
        postParams.push(viewer, viewer);
        repostParams.push(viewer, viewer);
      }
      inner = `SELECT p.id AS post_id, p.time_ms AS at, '' AS reposter FROM posts p WHERE ${visible} AND p.reply_to = ''${postFilter}
        UNION ALL SELECT r.post_id AS post_id, r.time_ms AS at, r.author AS reposter FROM reposts r JOIN posts p ON p.id = r.post_id WHERE ${visible}${repostFilter}`;
      params.push(...postParams, ...repostParams);
    }
    const rows = this.sql.all(`SELECT post_id, at, reposter FROM (${inner}) WHERE at < ? ORDER BY at DESC LIMIT ?`, ...params, cursor, size);
    return { posts: this.hydrate(rows, viewer), next: rows.length === size ? rows[rows.length - 1].at : 0 };
  }

  thread(id, viewer = "") {
    const post = this.postRow(id, viewer);
    if (!post || post.hidden || this.isSuspended(post.author)) return null;
    const ancestors = [];
    let parent = post.replyTo;
    while (parent && ancestors.length < 25) {
      const row = this.postRow(parent, viewer);
      if (!row || row.deleted || row.hidden || this.isSuspended(row.author)) break;
      ancestors.unshift(row);
      parent = row.replyTo;
    }
    const replies = this.sql.all(
      "SELECT p.id AS post_id, p.time_ms AS at, '' AS reposter FROM posts p WHERE p.reply_to = ? AND p.deleted = 0 AND p.hidden = 0 AND p.author NOT IN (SELECT wallet FROM suspended) ORDER BY p.time_ms ASC LIMIT 200",
      id,
    );
    return { post, ancestors, replies: this.hydrate(replies, viewer) };
  }

  search(query, viewer = "", limit = 30) {
    const like = `%${String(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.sql.all(
      "SELECT p.id AS post_id, p.time_ms AS at, '' AS reposter FROM posts p WHERE p.deleted = 0 AND p.hidden = 0 AND p.author NOT IN (SELECT wallet FROM suspended) AND p.text LIKE ? ESCAPE '\\' ORDER BY p.time_ms DESC LIMIT ?",
      like, clamp(limit, 30, 100),
    );
    return this.hydrate(rows, viewer);
  }

  userStats(address, viewer = "") {
    const count = (sql, ...params) => this.sql.get(sql, ...params).n;
    return {
      address,
      posts: count("SELECT count(*) AS n FROM posts WHERE author = ? AND reply_to = '' AND deleted = 0 AND hidden = 0", address),
      replies: count("SELECT count(*) AS n FROM posts WHERE author = ? AND reply_to <> '' AND deleted = 0 AND hidden = 0", address),
      following: count("SELECT count(*) AS n FROM follows WHERE follower = ?", address),
      followers: count("SELECT count(*) AS n FROM follows WHERE followee = ?", address),
      firstSeen: this.sql.get("SELECT min(time) AS t FROM actions WHERE author = ?", address)?.t || null,
      viewerFollows: viewer ? Boolean(this.sql.get("SELECT 1 AS y FROM follows WHERE follower = ? AND followee = ?", viewer, address)) : false,
      suspended: this.isSuspended(address),
    };
  }

  suggestions(viewer = "", limit = 5) {
    return this.sql.all(
      `SELECT p.author AS address, count(*) AS posts, (SELECT count(*) FROM follows f WHERE f.followee = p.author) AS followers
       FROM posts p WHERE p.deleted = 0 AND p.hidden = 0 AND p.author <> ? AND p.author NOT IN (SELECT wallet FROM suspended)
       AND p.author NOT IN (SELECT followee FROM follows WHERE follower = ?)
       GROUP BY p.author ORDER BY followers DESC, posts DESC LIMIT ?`, viewer, viewer, clamp(limit, 5, 20),
    );
  }

  recentPosts({ before = 0, limit = 50 } = {}) {
    const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
    return this.sql.all(
      "SELECT id, author, text, reply_to AS replyTo, time, time_ms AS timeMs, deleted, hidden FROM posts WHERE time_ms < ? ORDER BY time_ms DESC LIMIT ?",
      cursor, clamp(limit, 50, 200),
    );
  }

  suspendedWallets() {
    return this.sql.all("SELECT wallet FROM suspended ORDER BY wallet").map((row) => row.wallet);
  }

  summary() {
    const count = (table) => this.sql.get(`SELECT count(*) AS n FROM ${table}`).n;
    return {
      name: "World Feed Database",
      storage: "SQLite",
      status: "ready",
      actions: count("actions"),
      lastWriteAt: this.sql.get("SELECT max(time) AS t FROM actions").t,
      posts: this.sql.get("SELECT count(*) AS n FROM posts WHERE deleted = 0").n,
      authors: this.sql.get("SELECT count(DISTINCT author) AS n FROM posts").n,
      likes: count("likes"),
      reposts: count("reposts"),
      follows: count("follows"),
      sessions: count("sessions"),
      moderation: count("moderation"),
      kinds: Object.fromEntries(this.sql.all("SELECT kind, count(*) AS n FROM actions GROUP BY kind").map((row) => [row.kind, row.n])),
      moderators: [...this.moderators],
    };
  }
}

module.exports = { SocialDatabase, socialMessage, verifyAction, MAX_TEXT, MAX_SESSION_MS };
