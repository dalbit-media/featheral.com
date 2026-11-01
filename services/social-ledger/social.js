"use strict";

const { ethers } = require("ethers");
const { FthLedger, walletAccountId } = require("../fth-ledger/ledger");
const { txHash, canonical } = require("../fth-ledger/codec");
const { assertFreshSignature } = require("../token-api/profile");
const { LedgerDb } = require("../ledger-sql/ledgerDb");

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

// Structure and signature checks that hold on every node, including replicas re-validating blocks.
function verifyAction(kind, d) {
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
CREATE TABLE blocks (
  height INTEGER PRIMARY KEY, hash TEXT NOT NULL, prev_hash TEXT NOT NULL,
  time TEXT NOT NULL, time_ms INTEGER NOT NULL, tx_count INTEGER NOT NULL, file TEXT NOT NULL, signed INTEGER NOT NULL
);
CREATE TABLE transactions (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL, kind TEXT NOT NULL, height INTEGER NOT NULL, idx INTEGER NOT NULL,
  time TEXT NOT NULL, time_ms INTEGER NOT NULL, author TEXT NOT NULL, signer TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX transactions_height ON transactions(height, idx);
CREATE INDEX transactions_author ON transactions(author);
CREATE INDEX transactions_kind ON transactions(kind);
CREATE TABLE posts (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT NOT NULL,
  height INTEGER NOT NULL, time TEXT NOT NULL, time_ms INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_author ON posts(author, time_ms);
CREATE INDEX posts_reply ON posts(reply_to);
CREATE INDEX posts_time ON posts(time_ms);
CREATE TABLE likes (post_id TEXT NOT NULL, author TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (post_id, author));
CREATE INDEX likes_author ON likes(author, time_ms);
CREATE TABLE reposts (post_id TEXT NOT NULL, author TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (post_id, author));
CREATE INDEX reposts_author ON reposts(author, time_ms);
CREATE TABLE follows (follower TEXT NOT NULL, followee TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (follower, followee));
CREATE INDEX follows_followee ON follows(followee);
CREATE TABLE sessions (wallet TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE moderation (tx_hash TEXT PRIMARY KEY, moderator TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, time_ms INTEGER NOT NULL, applied INTEGER NOT NULL);
CREATE TABLE suspended (wallet TEXT PRIMARY KEY);
`;

const COMMENTS = {
  blocks: "One row per sealed block of the World communication ledger.",
  transactions: "Every signed social action. author is the wallet; signer is the wallet or its delegated session key; data is the canonical action JSON.",
  posts: "Posts and replies. id is the transaction hash. deleted is set by the author; hidden by a configured moderator.",
  likes: "Current likes (an UNLIKE removes the row).",
  reposts: "Current reposts.",
  follows: "Current follow edges, wallet to wallet.",
  sessions: "Latest session-key delegation per wallet (lets the browser sign without a wallet popup).",
  moderation: "Moderator actions; applied is 1 only when the signer is a moderator configured on this node.",
  suspended: "Wallets currently suspended by a configured moderator.",
};

// Featheral World communication ledger. It reuses the FTH$ ledger engine unchanged (hash-chained daily
// block files, writer signatures, replication, receipts) but records signed social actions instead of
// balances, and indexes them into a SQLite database that serves the timelines.
class SocialLedger extends FthLedger {
  constructor(options = {}) {
    super({ ...options, genesis: { ...options.genesis } });
    this.moderators = new Set((options.moderators || []).map((address) => String(address).toLowerCase()));
  }

  buildSql() {
    return new LedgerDb({ schema: SCHEMA, comments: COMMENTS });
  }

  reset() {
    super.reset();
    this.posts = new Map();
    this.likes = new Set();
    this.reposts = new Set();
    this.follows = new Set();
    this.sessions = new Map();
  }

  createGenesis() {
    const t = Date.now();
    const tx = { i: "genesis", k: "GENESIS", a: "", v: "0", d: { name: "Featheral World Ledger", kind: "communication", layer: 3, ...this.genesisData }, t };
    this.applyTx(tx, { height: 0 });
    this.writeBlock([tx], t);
  }

  applyTx(tx, { height = null, fresh = false, now = Date.now() } = {}) {
    if (!tx || typeof tx !== "object") throw socialError("Transaction must be an object.");
    if (typeof tx.i !== "string" || !tx.i || tx.i.length > 200) throw socialError("Transaction id must be 1-200 characters.");
    if (tx.k !== "GENESIS" && !ACTION_FIELDS[tx.k]) throw socialError(`Unknown transaction kind ${tx.k}.`);
    if (typeof tx.a !== "string" || (tx.a !== "" && !BYTES32.test(tx.a))) throw socialError("Transaction account must be a lowercase bytes32 id.");
    if (tx.v !== "0") throw socialError("Social transactions carry no amount.");
    if (!tx.d || typeof tx.d !== "object" || Array.isArray(tx.d)) throw socialError("Transaction data must be an object.");
    if (!Number.isSafeInteger(tx.t) || tx.t <= 0) throw socialError("Transaction time must be epoch milliseconds.");
    if (this.ids.has(tx.i)) throw socialError("Transaction id was already used.", 409);
    const hash = txHash(tx);
    let commit;
    if (tx.k === "GENESIS") {
      if (height !== 0 || this.height !== -1) throw socialError("Genesis is only valid as the first transaction of block 0.", 409);
      commit = () => { this.genesis = { ...tx.d, createdAt: new Date(tx.t).toISOString() }; };
    } else {
      const d = tx.d;
      const { author, signer, issuedAtMs } = verifyAction(tx.k, d);
      const who = author.toLowerCase();
      if (tx.a !== walletAccountId(author)) throw socialError("Action account does not match its author.");
      if (tx.i !== `soc:${who}:${d.n}`) throw socialError("Transaction id must be soc:<author>:<nonce>.");
      if (fresh) assertFreshSignature(issuedAtMs, now, "Action");
      if (signer !== author) {
        if (tx.k === "SESSION" || tx.k === "MOD") throw socialError("This action must be signed by the wallet itself.", 401);
        const session = this.sessions.get(who);
        if (!session || session.key !== signer.toLowerCase() || tx.t > session.exp) throw socialError("Session key is missing, replaced, or expired. Sign in again.", 401);
      }
      const live = (id) => {
        const post = this.posts.get(id);
        if (!post || post.deleted) throw socialError("Post was not found.", 404);
        return post;
      };
      switch (tx.k) {
        case "SESSION":
          if (d.exp <= tx.t || d.exp > tx.t + MAX_SESSION_MS) throw socialError("Session must expire within 7 days.");
          commit = () => this.sessions.set(who, { key: d.k.toLowerCase(), exp: d.exp });
          break;
        case "POST":
          if (d.rp) live(d.rp);
          commit = () => this.posts.set(hash, { author: who, deleted: false });
          break;
        case "DELETE": {
          const post = live(d.p);
          if (post.author !== who) throw socialError("Only the author can delete a post.", 403);
          commit = () => { post.deleted = true; };
          break;
        }
        case "LIKE":
        case "UNLIKE":
        case "REPOST":
        case "UNREPOST": {
          live(d.p);
          const set = tx.k.endsWith("LIKE") ? this.likes : this.reposts;
          const key = `${who}|${d.p}`;
          const adding = tx.k === "LIKE" || tx.k === "REPOST";
          if (adding === set.has(key)) throw socialError(adding ? "Already done." : "Nothing to undo.", 409);
          commit = () => (adding ? set.add(key) : set.delete(key));
          break;
        }
        case "FOLLOW":
        case "UNFOLLOW": {
          if (d.u === author) throw socialError("You cannot follow yourself.");
          const key = `${who}|${d.u.toLowerCase()}`;
          const adding = tx.k === "FOLLOW";
          if (adding === this.follows.has(key)) throw socialError(adding ? "Already following." : "Not following.", 409);
          commit = () => (adding ? this.follows.add(key) : this.follows.delete(key));
          break;
        }
        case "MOD":
          if (d.act === "HIDE" || d.act === "UNHIDE") {
            if (!this.posts.has(d.tg)) throw socialError("Post was not found.", 404);
          }
          commit = () => {};
          break;
        default:
          throw socialError("Unsupported transaction kind.");
      }
    }
    commit();
    this.ids.set(tx.i, hash);
    return hash;
  }

  describeTx(tx, location) {
    const d = tx.d;
    const base = {
      hash: txHash(tx),
      id: tx.i,
      kind: tx.k,
      amount: "0",
      time: new Date(tx.t).toISOString(),
      status: location ? "sealed" : "pending",
      height: location ? location.h : null,
      index: location ? location.i : null,
      from: tx.a,
      to: "",
    };
    if (tx.k === "GENESIS") return { ...base, from: "", data: d };
    const target = d.p || d.u || d.tg || d.rp || d.k || "";
    return { ...base, signer: d.by, text: d.text, target };
  }

  indexSql(block, file) {
    const db = this.sql;
    db.transaction(() => {
      db.run("INSERT OR REPLACE INTO blocks VALUES (?,?,?,?,?,?,?,?)", block.h, block.H, block.p, new Date(block.t).toISOString(), block.t, block.x.length, file, typeof block.S === "string" ? 1 : 0);
      block.x.forEach((tx, index) => {
        const d = tx.d;
        const hash = txHash(tx);
        const iso = new Date(tx.t).toISOString();
        db.run("INSERT OR REPLACE INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?)", hash, tx.i, tx.k, block.h, index, iso, tx.t, d.w || "", d.by || "", d.p || d.u || d.tg || d.rp || d.k || "", canonical(d));
        switch (tx.k) {
          case "POST": db.run("INSERT OR REPLACE INTO posts (id, author, text, reply_to, height, time, time_ms) VALUES (?,?,?,?,?,?,?)", hash, d.w, d.text, d.rp, block.h, iso, tx.t); break;
          case "DELETE": db.run("UPDATE posts SET deleted = 1 WHERE id = ?", d.p); break;
          case "LIKE": db.run("INSERT OR IGNORE INTO likes VALUES (?,?,?)", d.p, d.w, tx.t); break;
          case "UNLIKE": db.run("DELETE FROM likes WHERE post_id = ? AND author = ?", d.p, d.w); break;
          case "REPOST": db.run("INSERT OR IGNORE INTO reposts VALUES (?,?,?)", d.p, d.w, tx.t); break;
          case "UNREPOST": db.run("DELETE FROM reposts WHERE post_id = ? AND author = ?", d.p, d.w); break;
          case "FOLLOW": db.run("INSERT OR IGNORE INTO follows VALUES (?,?,?)", d.w, d.u, tx.t); break;
          case "UNFOLLOW": db.run("DELETE FROM follows WHERE follower = ? AND followee = ?", d.w, d.u); break;
          case "SESSION": db.run("INSERT OR REPLACE INTO sessions VALUES (?,?,?)", d.w, d.k, d.exp); break;
          case "MOD": {
            const applied = this.moderators.has(d.w.toLowerCase());
            db.run("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?,?)", hash, d.w, d.act, d.tg, tx.t, applied ? 1 : 0);
            if (!applied) break;
            if (d.act === "HIDE" || d.act === "UNHIDE") db.run("UPDATE posts SET hidden = ? WHERE id = ?", d.act === "HIDE" ? 1 : 0, d.tg);
            else if (d.act === "SUSPEND") db.run("INSERT OR IGNORE INTO suspended VALUES (?)", d.tg);
            else db.run("DELETE FROM suspended WHERE wallet = ?", d.tg);
            break;
          }
          default:
        }
      });
    });
  }

  isModerator(address) {
    return this.moderators.has(String(address).toLowerCase());
  }

  isSuspended(address) {
    return Boolean(this.sql.get("SELECT 1 AS yes FROM suspended WHERE wallet = ?", ethers.getAddress(address)));
  }

  /* ------------------------------ timelines ------------------------------ */

  postRow(id, viewer = "") {
    const row = this.sql.get(
      `SELECT p.id, p.author, p.text, p.reply_to AS replyTo, p.time, p.time_ms AS timeMs, p.height, p.deleted, p.hidden,
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
    if (!post || post.hidden) return null;
    const ancestors = [];
    let parent = post.replyTo;
    while (parent && ancestors.length < 25) {
      const row = this.postRow(parent, viewer);
      if (!row || row.deleted || row.hidden) break;
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
      firstSeen: this.sql.get("SELECT min(time) AS t FROM transactions WHERE author = ?", address)?.t || null,
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
    const tip = this.headers[this.height];
    return {
      name: "Featheral World Ledger",
      kind: "communication",
      layer: 3,
      height: this.height,
      tipHash: this.tipHash,
      tipTime: tip ? new Date(tip.t).toISOString() : null,
      genesisTime: this.genesis?.createdAt || null,
      transactions: this.txCount,
      pendingTransactions: this.pending.length,
      posts: this.sql.get("SELECT count(*) AS n FROM posts WHERE deleted = 0").n,
      authors: this.sql.get("SELECT count(DISTINCT author) AS n FROM posts").n,
      likes: count("likes"),
      reposts: count("reposts"),
      follows: count("follows"),
      kinds: { ...this.kindCounts },
      moderators: [...this.moderators],
      signedBlocks: Boolean(this.publicKey),
      writerPublicKey: this.publicKey ? this.publicKey.export({ type: "spki", format: "pem" }) : null,
    };
  }
}

module.exports = { SocialLedger, socialMessage, verifyAction, MAX_TEXT, MAX_SESSION_MS };
