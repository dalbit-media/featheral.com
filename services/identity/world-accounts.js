"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const { ethers } = require("ethers");
const { USERNAME_PATTERN } = require("./profile");
const { completeProfile } = require("./profile-ui");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const cookieName = secure => secure ? "__Host-featheral-world" : "featheral-world-dev";
const sessionLifetime = 7 * 86400000;

function createWorldAccounts({ sqlite, file, profiles, bootstrapGame, forwardedOrigin = null, logger = console }) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = sqlite.open(file);
  if (!db.readOnlyReplica) db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS world_password_accounts (
      username TEXT PRIMARY KEY COLLATE NOCASE, address TEXT NOT NULL UNIQUE COLLATE NOCASE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, keystore TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_account_sessions (
      token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS world_account_session_csrf ON world_account_sessions(csrf);
  `);
  if (!db.readOnlyReplica && file !== ":memory:") fs.chmodSync(file, 0o600);
  const challenges = new Map(), handoffs = new Map(), limits = new Map();
  let passwordOperations = 0;
  async function derive(password, salt) {
    if (passwordOperations >= 4) throw fail(503, "Sign-in is busy. Retry shortly.");
    passwordOperations++;
    try { return await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    finally { passwordOperations--; }
  }
  function context(req) {
    const host = new URL(`http://${req.headers.host}`).hostname;
    const forwarded = forwardedOrigin && ["dollar.featheral.com", "dollar.localhost"].includes(host)
      && req.headers["x-featheral-world-origin"] === forwardedOrigin;
    const accountHost = forwarded ? new URL(forwardedOrigin).hostname : host;
    const local = accountHost === "world.localhost" || accountHost === "localhost";
    if (accountHost !== "world.featheral.com" && !local) throw fail(404, "Use World to manage your account.");
    const secure = !local;
    if (secure && !req.socket.encrypted && req.headers["x-forwarded-proto"] !== "https")
      throw fail(403, "World sign-in requires HTTPS.");
    const origin = forwarded ? forwardedOrigin : `${secure ? "https" : "http"}://${req.headers.host}`;
    return { origin, secure };
  }
  function session(req, secure) {
    const token = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(cookieName(secure) + "="))?.split("=")[1];
    if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
    const row = db.prepare("SELECT address, csrf, expires FROM world_account_sessions WHERE token_hash=?").get(hash(token));
    return row && Number(row.expires) > Date.now() ? row : null;
  }
  function view(row) {
    if (!row) return { account: null, profile: null, complete: false };
    const profile = profiles.get(row.address);
    const password = db.prepare("SELECT username FROM world_password_accounts WHERE address=?").get(row.address);
    return { account: row.address, profile, complete: completeProfile(profile), csrf: row.csrf, expires: Number(row.expires),
      loginUsername: password?.username || null, walletType: password ? "built-in" : "external" };
  }
  function rateLimit(req) {
    const now = Date.now(), key = req.socket.remoteAddress || "local";
    for (const [ip, entries] of limits) if (now - entries[entries.length - 1] > 900000) limits.delete(ip);
    const recent = (limits.get(key) || []).filter(time => now - time < 900000);
    if (recent.length >= 30 || limits.size >= 10000 && !limits.has(key)) throw fail(429, "Too many sign-in attempts. Wait 15 minutes.");
    recent.push(now); limits.set(key, recent);
  }
  function issueSession(req, res, address, secure) {
    const previous = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(cookieName(secure) + "="))?.split("=")[1];
    const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(32).toString("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM world_account_sessions WHERE expires<=?").run(Date.now());
      if (/^[a-f0-9]{64}$/.test(previous || "")) db.prepare("DELETE FROM world_account_sessions WHERE token_hash=?").run(hash(previous));
      db.prepare("INSERT INTO world_account_sessions VALUES(?,?,?,?)").run(hash(token), address, csrf, Date.now() + sessionLifetime);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    res.setHeader("Set-Cookie", `${cookieName(secure)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure ? "; Secure" : ""}`);
    return view({ address, csrf, expires: Date.now() + sessionLifetime });
  }
  function challenge(input, origin) {
    if (!ethers.isAddress(input.address) || /^0x0{40}$/i.test(input.address)) throw fail(400, "Choose a valid wallet.");
    if (!["register", "sign-in"].includes(input.action)) throw fail(400, "Invalid sign-in action.");
    if (input.action === "register" && !USERNAME_PATTERN.test(input.username || "")) throw fail(400, "Choose a valid 3-24 character username.");
    const now = Date.now();
    for (const [id, record] of challenges) if (record.expires <= now) challenges.delete(id);
    if (challenges.size >= 10000) throw fail(503, "Sign-in is busy. Retry shortly.");
    const id = crypto.randomBytes(32).toString("hex"), address = ethers.getAddress(input.address);
    const message = ["Featheral World account", "", `Action: ${input.action}`, `Address: ${address}`,
      `Username: ${input.action === "register" ? input.username : "(wallet sign-in)"}`,
      `Encrypted backup: ${input.action === "register" ? hash(String(input.keystore || "")) : "none"}`,
      `Origin: ${origin}`, `Challenge: ${id}`, `Expires: ${new Date(now + 300000).toISOString()}`, "",
      "Sign in to World and use this public profile on Media.",
      "Link this browser to your World settlement. New budgets are separate; no funds move.",
      "Existing wallet balances and gameplay funds are not transferred."].join("\n");
    challenges.set(id, { message, address, origin, username: input.username, action: input.action,
      backupHash: hash(String(input.keystore || "")), expires: now + 300000 });
    return { id, message };
  }
  function proof(input, action, origin) {
    const record = challenges.get(input.id);
    if (!record || record.expires <= Date.now() || record.action !== action || record.origin !== origin) throw fail(401, "Sign-in challenge expired. Retry.");
    challenges.delete(input.id);
    let signer;
    try { signer = ethers.verifyMessage(record.message, input.signature); }
    catch { throw fail(401, "Invalid account signature."); }
    if (signer !== record.address) throw fail(401, "Account signature does not match.");
    return record;
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw fail(413, "Account request is too large.");
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw fail(400, "Invalid account request."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(400, "Invalid account request.");
    return value;
  }
  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost"), pathname = url.pathname;
    if (!pathname.startsWith("/api/world-account/")) return false;
    const path = pathname.slice("/api/world-account".length);
    try {
      if (!["/session", "/media-session", "/challenge", "/register", "/login", "/wallet-login", "/logout", "/backup", "/media-handoff", "/game"].includes(path))
        throw fail(404, "Unknown World account operation.");
      const { origin, secure } = context(req);
      const mediaOrigin = secure ? "https://media.featheral.com" : `http://media.localhost${new URL(origin).port ? ":" + new URL(origin).port : ""}`;
      if (path === "/media-session") {
        if (req.headers.origin !== mediaOrigin) throw fail(403, "Media origin required.");
        res.setHeader("Access-Control-Allow-Origin", mediaOrigin); res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "POST");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          json(res, 204, null); return true;
        }
        if (req.method !== "POST") throw fail(405, "Use POST for Media sign-in.");
        const input = await body(req);
        json(res, 200, view(mediaSession(input.token, input.account))); return true;
      }
      if (path === "/session" && req.method === "GET") {
        if (req.headers.origin && req.headers.origin !== origin) {
          const parent = new URL(req.headers.origin);
          const allowed = secure ? parent.protocol === "https:" && (parent.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(parent.hostname))
            : parent.protocol === "http:" && (parent.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(parent.hostname));
          if (!allowed) throw fail(403, "Unsupported World sign-in origin.");
          res.setHeader("Access-Control-Allow-Origin", parent.origin);
          res.setHeader("Access-Control-Allow-Credentials", "true"); res.setHeader("Vary", "Origin");
        }
        let row = session(req, secure);
        if (url.searchParams.has("handoff")) {
          const id = url.searchParams.get("handoff"), handoff = handoffs.get(id);
          handoffs.delete(id);
          if (!handoff || handoff.expires <= Date.now() || req.headers.origin !== handoff.origin)
            throw fail(401, "World sign-in handoff expired. Return to World and retry.");
          row = mediaSession(handoff.token, handoff.address);
        }
        json(res, 200, view(row)); return true;
      }
      if (db.readOnlyReplica) throw fail(503, "World account changes require the writer server.");
      if (req.method !== "POST") throw fail(405, "Use POST for this account operation.");
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
        throw fail(403, "Same-origin World account requests are required.");
      if (["/challenge", "/register", "/login", "/wallet-login"].includes(path)) rateLimit(req);
      const input = await body(req);
      const row = session(req, secure);
      let result;
      if (path === "/challenge") result = challenge(input, origin);
      else if (path === "/register") {
        if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 256)
          throw fail(400, "Use a password of 12-256 characters.");
        const record = proof(input, "register", origin);
        if (typeof input.keystore !== "string" || !ethers.isKeystoreJson(input.keystore) || hash(input.keystore) !== record.backupHash)
          throw fail(400, "Invalid encrypted wallet backup.");
        const keystore = JSON.parse(input.keystore);
        const encrypted = keystore.Crypto || keystore.crypto, params = encrypted?.kdfparams;
        if (typeof keystore.address !== "string" || !/^[a-f0-9]{40}$/i.test(keystore.address)
          || ethers.getAddress("0x" + keystore.address) !== record.address || encrypted?.kdf !== "scrypt"
          || encrypted.cipher !== "aes-128-ctr" || !params || !Number.isSafeInteger(params.n) || params.n < 131072 || params.n > 1048576
          || !Number.isInteger(Math.log2(params.n)) || params.r !== 8 || params.p !== 1 || params.dklen !== 32)
          throw fail(400, "Encrypted wallet backup does not match this account.");
        const profile = profiles.get(record.address);
        if (!completeProfile(profile) || profile.username.toLowerCase() !== record.username.toLowerCase())
          throw fail(409, "Save your username, avatar and description in World before registering.");
        const salt = crypto.randomBytes(32).toString("hex"), passwordHash = await derive(input.password, salt);
        try {
          db.prepare("INSERT INTO world_password_accounts VALUES(?,?,?,?,?)").run(record.username, record.address, salt, passwordHash.toString("hex"), input.keystore);
        } catch (error) {
          if (/UNIQUE constraint/.test(error.message)) throw fail(409, "This username or wallet already has a World account. Sign in instead.");
          throw error;
        }
        result = issueSession(req, res, record.address, secure);
      } else if (path === "/login") {
        if (typeof input.username !== "string" || !USERNAME_PATTERN.test(input.username) || typeof input.password !== "string" || input.password.length > 256)
          throw fail(401, "Username or password is incorrect.");
        const account = db.prepare("SELECT * FROM world_password_accounts WHERE username=?").get(input.username);
        const supplied = await derive(input.password, account?.salt || "0".repeat(64));
        if (!account || !crypto.timingSafeEqual(supplied, Buffer.from(account.password_hash, "hex")))
          throw fail(401, "Username or password is incorrect.");
        result = { ...issueSession(req, res, account.address, secure), keystore: account.keystore };
      } else if (path === "/wallet-login") result = issueSession(req, res, proof(input, "sign-in", origin).address, secure);
      else {
        if (!row || req.headers["x-csrf-token"] !== row.csrf) throw fail(403, "World sign-in or CSRF token is missing.");
        if (path === "/logout") {
          const token = req.headers.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(cookieName(secure) + "=")).split("=")[1];
          db.prepare("DELETE FROM world_account_sessions WHERE token_hash=?").run(hash(token));
          res.setHeader("Set-Cookie", `${cookieName(secure)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
          result = { signedOut: true };
        } else if (path === "/backup") {
          const account = db.prepare("SELECT keystore FROM world_password_accounts WHERE address=?").get(row.address);
          if (!account) throw fail(404, "This account uses an external wallet.");
          result = { keystore: account.keystore };
        } else if (path === "/media-handoff") {
          if (input.origin !== mediaOrigin) throw fail(403, "Unsupported Media return origin.");
          for (const [id, record] of handoffs) if (record.expires <= Date.now()) handoffs.delete(id);
          if (handoffs.size >= 10000) throw fail(503, "World sign-in is busy. Retry shortly.");
          const code = crypto.randomBytes(32).toString("hex");
          handoffs.set(code, { token: row.csrf, address: row.address, origin: mediaOrigin, expires: Date.now() + 60000 });
          result = { code };
        } else if (path === "/game") {
          if (!completeProfile(profiles.get(row.address))) throw fail(403, "Complete your World username, avatar and description first.");
          result = await bootstrapGame(req, res, row.address, secure);
        } else throw fail(404, "Unknown World account operation.");
      }
      if (input.password) delete input.password;
      json(res, 200, result);
    } catch (error) {
      if (!error.status) logger.error("World account operation failed:", error);
      json(res, error.status || 500, { error: error.status ? error.message : "World account operation failed. Retry or contact the operator." });
    }
    return true;
  }
  function authorizeGame(req) {
    const row = session(req, context(req).secure);
    if (!row) throw fail(401, "Sign in to World before playing.");
    if (!completeProfile(profiles.get(row.address))) throw fail(403, "Complete your World username, avatar and description first.");
    return row.address;
  }
  function mediaSession(token, address) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !ethers.isAddress(address))
      throw fail(401, "Sign in to World before using Media.");
    const row = db.prepare("SELECT address, csrf, expires FROM world_account_sessions WHERE csrf=?").get(token);
    if (!row || Number(row.expires) <= Date.now() || row.address.toLowerCase() !== address.toLowerCase())
      throw fail(401, "World sign-in expired or belongs to another wallet.");
    return row;
  }
  function authorizeMedia(token, address) {
    mediaSession(token, address);
    if (!completeProfile(profiles.get(address))) throw fail(403, "Complete your World profile before using Media.");
  }
  return { handle, authorizeGame, authorizeMedia, session: req => session(req, context(req).secure), view, close: () => db.close() };
}
module.exports = { createWorldAccounts };
