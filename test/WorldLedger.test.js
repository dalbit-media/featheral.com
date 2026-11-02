"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const vm = require("node:vm");
const { Worker } = require("node:worker_threads");
const { ethers } = require("ethers");
const sqlite = require("../services/db-api/sqlite");
const { createWorldApi } = require("../services/social-ledger/api");
const { socialMessage } = require("../services/social-ledger/social");

function call(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: "test" } });
  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      setHeader() {},
      end(text) { resolve({ status: this.status, body: text ? JSON.parse(text) : null, raw: text }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

describe("World Feed Database", () => {
  let dir;
  let world;
  let env;
  const profiles = {
    get(address) { return address === alice.address ? { address, username: "alice", avatar: "", bio: "Hello" } : null; },
    owner(name) { return name === "alice" ? alice.address : ""; },
  };
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();
  const admin = ethers.Wallet.createRandom();
  let counter = 0;

  async function act(wallet, kind, fields, signer = wallet) {
    counter += 1;
    const data = { w: wallet.address, by: signer.address, n: counter.toString(16).padStart(20, "0"), ts: new Date().toISOString(), ...fields };
    data.sig = await signer.signMessage(socialMessage(kind, data));
    return call(world.handle, "POST", "/api/v1/world/actions", { kind, data });
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(__dirname, ".world-feed-"));
    env = { WORLD_DB_FILE: path.join(dir, "feed.sqlite"), FEATHERAL_ADMIN_WALLETS: admin.address };
    world = createWorldApi({ sqlite, profiles, env, logger: { error() {} } });
  });

  after(() => {
    world.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records signed posts, replies, likes, reposts and follows and serves timelines", async () => {
    const post = await act(alice, "POST", { text: "hello featheral", rp: "" });
    assert.equal(post.status, 200, post.raw);
    const id = post.body.receipt.id;
    assert.equal(post.body.status, "committed");
    assert.equal(post.body.post.authorProfile.username, "alice");
    assert.equal((await act(bob, "POST", { text: "welcome!", rp: id })).status, 200);
    assert.equal((await act(bob, "LIKE", { p: id })).status, 200);
    assert.equal((await act(bob, "REPOST", { p: id })).status, 200);
    assert.equal((await act(bob, "FOLLOW", { u: alice.address })).status, 200);
    assert.equal((await act(bob, "LIKE", { p: id })).status, 409);

    const thread = await call(world.handle, "GET", `/api/v1/world/posts/${id}?viewer=${bob.address}`);
    assert.equal(thread.body.post.likes, 1);
    assert.equal(thread.body.post.liked, true);
    assert.equal(thread.body.replies.length, 1);

    const home = await call(world.handle, "GET", `/api/v1/world/timeline?scope=following&viewer=${bob.address}`);
    assert.ok(home.body.posts.some((item) => item.id === id));
    const profile = await call(world.handle, "GET", `/api/v1/world/users/${alice.address}`);
    assert.equal(profile.body.stats.followers, 1);
  });

  it("rejects forged signatures, wrong signers, and deleting someone else's post", async () => {
    const forged = await act(alice, "POST", { text: "forged", rp: "" }, bob);
    assert.equal(forged.status, 401);
    const post = await act(alice, "POST", { text: "mine", rp: "" });
    const stolen = await act(bob, "DELETE", { p: post.body.receipt.id });
    assert.equal(stolen.status, 403);
    assert.equal((await act(alice, "DELETE", { p: post.body.receipt.id })).status, 200);
    const gone = await call(world.handle, "GET", `/api/v1/world/posts/${post.body.receipt.id}`);
    assert.equal(gone.body.post.deleted, true);
  });

  it("lets a wallet delegate a session key and rejects unauthorized keys", async () => {
    const session = ethers.Wallet.createRandom();
    assert.equal((await act(alice, "POST", { text: "no session yet", rp: "" }, session)).status, 401);
    assert.equal((await act(alice, "SESSION", { k: session.address, exp: Date.now() + 3_600_000 })).status, 200);
    assert.equal((await act(alice, "POST", { text: "signed by session key", rp: "" }, session)).status, 200);
    assert.equal((await act(alice, "SESSION", { k: bob.address, exp: Date.now() + 3_600_000 }, session)).status, 401);
    const active = await call(world.handle, "GET", `/api/v1/world/session?address=${alice.address}`);
    assert.equal(active.body.session.key, session.address);
  });

  it("persists relationship removals and refuses duplicate undo actions", async () => {
    const wallet = ethers.Wallet.createRandom();
    const post = await act(alice, "POST", { text: "toggle relationships", rp: "" });
    const p = post.body.receipt.id;
    for (const [add, undo, fields] of [["LIKE", "UNLIKE", { p }], ["REPOST", "UNREPOST", { p }], ["FOLLOW", "UNFOLLOW", { u: alice.address }]]) {
      assert.equal((await act(wallet, add, fields)).status, 200);
      assert.equal((await act(wallet, undo, fields)).status, 200);
      assert.equal((await act(wallet, undo, fields)).status, 409);
    }
    const thread = await call(world.handle, "GET", `/api/v1/world/posts/${p}?viewer=${wallet.address}`);
    assert.equal(thread.body.post.likes, 0);
    assert.equal(thread.body.post.reposts, 0);
    assert.equal(thread.body.post.liked, false);
    assert.equal(world.database.userStats(wallet.address).following, 0);
  });

  it("applies moderation only from configured admin wallets", async () => {
    const post = await act(bob, "POST", { text: "spam", rp: "" });
    const id = post.body.receipt.id;
    assert.equal((await act(alice, "MOD", { act: "HIDE", tg: id })).status, 403);
    assert.equal((await act(admin, "MOD", { act: "HIDE", tg: id })).status, 200);
    const feed = await call(world.handle, "GET", "/api/v1/world/timeline");
    assert.ok(!feed.body.posts.some((item) => item.id === id));
    assert.equal((await act(admin, "MOD", { act: "SUSPEND", tg: bob.address })).status, 200);
    assert.equal((await act(bob, "POST", { text: "still here?", rp: "" })).status, 403);
    assert.equal((await call(world.handle, "GET", `/api/v1/world/posts/${id}`)).status, 404);
    assert.equal((await act(admin, "MOD", { act: "RESTORE", tg: bob.address })).status, 200);
    assert.equal((await act(admin, "MOD", { act: "UNHIDE", tg: id })).status, 200);
  });

  it("exposes read-only SQL with existing query limits and security", async () => {
    const posts = await call(world.handle, "GET", `/api/v1/world/sql?q=${encodeURIComponent("SELECT author, count(*) AS n FROM posts GROUP BY author ORDER BY n DESC")}`);
    assert.equal(posts.status, 200, posts.raw);
    assert.deepEqual(posts.body.columns, ["author", "n"]);
    for (const bad of ["DELETE FROM posts", "SELECT 1; DROP TABLE posts", "PRAGMA table_info(posts)", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT * FROM c", "SELECT load_extension('bad')", "SELECT randomblob(10000000)", "SELECT zeroblob(10000000)", `SELECT '${"x".repeat(4000)}'`, "WITH c AS (SELECT 1) DELETE FROM posts"]) {
      const result = await call(world.handle, "POST", "/api/v1/world/sql", { query: bad });
      assert.equal(result.status, 400, bad);
    }
    assert.ok((await call(world.handle, "GET", "/api/v1/world/sql/schema")).body.tables.some((table) => table.name === "posts"));
    const capped = await call(world.handle, "POST", "/api/v1/world/sql", { query: "WITH digits(n) AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) SELECT a.n FROM digits a, digits b, digits c" });
    assert.equal(capped.body.rowCount, 500);
    assert.equal(capped.body.truncated, true);
    assert.equal((await act(alice, "POST", { text: "writes still work after query_only failure", rp: "" })).status, 200);
  });

  it("fails explicitly without the managed opener", () => {
    assert.throws(() => createWorldApi({ env }), /injected managed sqlite opener/);
  });

  it("reopens committed signed data without resetting it or writing file journals", async () => {
    const before = await call(world.handle, "GET", "/api/v1/world/stats");
    world.close();
    world = createWorldApi({ sqlite, profiles, env });
    const replica = createWorldApi({ sqlite, profiles, env });
    try {
      const after = await call(replica.handle, "GET", "/api/v1/world/stats");
      assert.deepEqual(after.body.database, before.body.database);
      const saved = world.database.sql.get("SELECT kind, data FROM actions WHERE kind = 'POST' LIMIT 1");
      const signed = JSON.parse(saved.data);
      assert.equal(ethers.verifyMessage(socialMessage(saved.kind, signed), signed.sig), signed.by);
      assert.deepEqual(fs.readdirSync(dir).filter((name) => !/^feed\.sqlite(?:-wal|-shm)?$/.test(name)), []);
      assert.ok(world.database.session(alice.address));
      assert.equal(world.database.userStats(alice.address).followers, 1);
    } finally {
      replica.close();
    }
  });

  it("makes exact retries idempotent and rejects nonce reuse across payloads and kinds", async () => {
    const fields = { n: "0123456789abcdef", text: "retry me", rp: "" };
    const first = await act(alice, "POST", fields);
    const saved = JSON.parse(world.database.sql.get("SELECT data FROM actions WHERE id = ?", first.body.receipt.id).data);
    const replay = await call(world.handle, "POST", "/api/v1/world/actions", { kind: "POST", data: saved });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.receipt.id, first.body.receipt.id);
    assert.equal(replay.body.receipt.replayed, true);
    assert.equal((await act(alice, "POST", { ...fields, text: "different payload" })).status, 409);
    assert.equal((await act(alice, "FOLLOW", { n: fields.n, u: bob.address })).status, 409);
    assert.equal(world.database.sql.get("SELECT count(*) AS n FROM actions WHERE author = ? AND nonce = ?", alice.address, fields.n).n, 1);
  });

  it("rejects stale/future actions, malformed fields and rolls back failed writes", async () => {
    const count = () => world.database.summary().actions;
    const before = count();
    for (const ts of [new Date(Date.now() - 11 * 60_000).toISOString(), new Date(Date.now() + 11 * 60_000).toISOString()]) {
      assert.equal((await act(alice, "POST", { ts, text: "expired", rp: "" })).status, 401);
    }
    assert.equal((await act(alice, "POST", { text: "a".repeat(281), rp: "" })).status, 400);
    assert.equal((await act(alice, "POST", { text: "missing parent", rp: `0x${"ff".repeat(32)}` })).status, 404);
    assert.equal((await act(alice, "SESSION", { k: bob.address, exp: Date.now() + 8 * 86400_000 })).status, 400);
    assert.equal(count(), before);
    const retryNonce = "aaaaaaaaaaaaaaaa";
    assert.equal((await act(alice, "POST", { n: retryNonce, text: "bad parent", rp: `0x${"ff".repeat(32)}` })).status, 404);
    assert.equal((await act(alice, "POST", { n: retryNonce, text: "fixed", rp: "" })).status, 200);
  });

  it("checks replaced and expired delegations and requires wallet moderation", async () => {
    const one = ethers.Wallet.createRandom();
    const two = ethers.Wallet.createRandom();
    assert.equal((await act(alice, "SESSION", { k: one.address, exp: Date.now() + 60_000 })).status, 200);
    assert.equal((await act(alice, "SESSION", { k: two.address, exp: Date.now() + 60_000 })).status, 200);
    assert.equal((await act(alice, "POST", { text: "replaced key", rp: "" }, one)).status, 401);
    world.database.sql.run("UPDATE sessions SET expires_at = ? WHERE wallet = ?", Date.now() - 1, alice.address);
    assert.equal((await act(alice, "POST", { text: "expired key", rp: "" }, two)).status, 401);
    assert.equal((await act(admin, "SESSION", { k: two.address, exp: Date.now() + 60_000 })).status, 200);
    assert.equal((await act(admin, "MOD", { act: "SUSPEND", tg: bob.address }, two)).status, 401);
  });

  it("serializes writes and nonce checks across API instances", async () => {
    const other = createWorldApi({ sqlite, profiles, env });
    try {
      const post = await act(alice, "POST", { text: "one shared source of truth", rp: "" });
      const signed = JSON.parse(world.database.sql.get("SELECT data FROM actions WHERE id = ?", post.body.receipt.id).data);
      const results = await Promise.all([world, other].map((api) => call(api.handle, "POST", "/api/v1/world/actions", { kind: "POST", data: signed })));
      assert.ok(results.every((result) => result.status === 200 && result.body.receipt.id === post.body.receipt.id));
      const like = await act(bob, "LIKE", { p: post.body.receipt.id });
      assert.equal(like.status, 200);
      const data = { w: bob.address, by: bob.address, n: "bbbbbbbbbbbbbbbb", ts: new Date().toISOString(), p: post.body.receipt.id };
      data.sig = await bob.signMessage(socialMessage("LIKE", data));
      assert.equal((await call(other.handle, "POST", "/api/v1/world/actions", { kind: "LIKE", data })).status, 409);
      assert.equal(other.database.postRow(post.body.receipt.id).likes, 1);
    } finally { other.close(); }
  });

  it("serializes simultaneous writer threads without duplicate actions", async () => {
    const data = { w: alice.address, by: alice.address, n: "cccccccccccccccc", ts: new Date().toISOString(), text: "concurrent retry", rp: "" };
    data.sig = await alice.signMessage(socialMessage("POST", data));
    const gate = new SharedArrayBuffer(4);
    const workers = [];
    try {
      const tasks = [0, 1].map(() => {
        const worker = new Worker(`
          const { parentPort, workerData } = require("node:worker_threads");
          const { createWorldApi } = require(workerData.api);
          const sqlite = require(workerData.sqlite);
          const world = createWorldApi({ sqlite, env: workerData.env });
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          try { parentPort.postMessage({ receipt: world.database.submit({ kind: "POST", data: workerData.data }) }); }
          catch (error) { parentPort.postMessage({ error: error.message }); }
          finally { world.close(); }
        `, { eval: true, workerData: { gate, data, env, api: require.resolve("../services/social-ledger/api"), sqlite: require.resolve("../services/db-api/sqlite") } });
        workers.push(worker);
        let ready;
        const started = new Promise((resolve) => { ready = resolve; });
        const result = new Promise((resolve, reject) => {
          worker.on("message", (message) => message.ready ? ready() : message.error ? reject(new Error(message.error)) : resolve(message.receipt));
          worker.on("error", reject);
          worker.on("exit", (code) => { if (code) reject(new Error(`Worker exited ${code}`)); });
        });
        return { started, result };
      });
      await Promise.all(tasks.map((task) => task.started));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 2);
      const receipts = await Promise.all(tasks.map((task) => task.result));
      assert.equal(receipts[0].id, receipts[1].id);
      assert.equal(receipts.filter((receipt) => receipt.replayed).length, 1);
      assert.equal(world.database.sql.get("SELECT count(*) AS n FROM actions WHERE author = ? AND nonce = ?", alice.address, data.n).n, 1);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  });

  it("preserves pre-existing SQLite user data during feed initialization", () => {
    const file = path.join(dir, "existing.sqlite");
    const existing = sqlite.open(file);
    existing.exec("CREATE TABLE user_data (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO user_data VALUES ('wallet', 'preserve me')");
    existing.close();
    const feed = createWorldApi({ sqlite, profiles, env: { ...env, WORLD_DB_FILE: file } });
    try {
      assert.deepEqual(feed.database.sql.get("SELECT * FROM user_data"), { id: "wallet", value: "preserve me" });
      assert.equal(feed.database.summary().actions, 0);
    } finally {
      feed.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    }
  });

  it("reads profile metadata through the injected profile store", async () => {
    const profile = await call(world.handle, "GET", `/api/v1/world/profile/${alice.address}`);
    assert.equal(profile.body.profile.username, "alice");
    const search = await call(world.handle, "GET", "/api/v1/world/search?q=%40alice");
    assert.equal(search.body.users[0].address, alice.address);
  });

  it("removes all World block, hash, replication and file endpoints", async () => {
    for (const route of ["/blocks", "/blocks/0", "/transactions", `/tx/0x${"ab".repeat(32)}`, "/sync", "/files", "/files/2026/2026-01-01.jsonl"]) {
      assert.equal((await call(world.handle, "GET", `/api/v1/world${route}`)).status, 404, route);
    }
    const stats = (await call(world.handle, "GET", "/api/v1/world/stats")).body;
    assert.ok(stats.database.actions > 0);
    assert.equal(stats.ledger, undefined);
    assert.equal(stats.database.height, undefined);
    assert.equal(stats.database.tipHash, undefined);
    const tables = world.database.sqlSchema().map((table) => table.name);
    assert.ok(tables.includes("actions"));
    assert.ok(!tables.includes("blocks") && !tables.includes("transactions"));
  });

  it("renders database status and read-only SQL, with direct post links", async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sites", "world.featheral.com", "ledger", "ledger.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "..", "sites", "world.featheral.com", "ledger", "index.html"), "utf8");
    assert.ok(html.includes("World Feed Database"));
    assert.ok(!/data-route="(?:blocks|transactions|files)"/.test(html));
    const nodes = new Map();
    class Node {
      constructor() { this.children = []; this.listeners = {}; }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      addEventListener(name, work) { this.listeners[name] = work; }
      setAttribute() {}
    }
    const node = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
    const routes = [];
    const calls = [];
    const mounted = [];
    const location = { hash: "", assign: (route) => routes.push(route) };
    const events = {};
    vm.runInNewContext(source, {
      document: { getElementById: node, createElement: () => new Node(), querySelectorAll: () => [] },
      location, FeatheralProfile: { mount() {} }, FeatheralSites: { url() {} },
      window: { addEventListener: (name, work) => { events[name] = work; }, LedgerSql: { mount: (_view, options) => mounted.push(options) } },
      fetch: async (url) => {
        calls.push(url);
        const result = await call(world.handle, "GET", url);
        return { ok: result.status === 200, json: async () => result.body };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(node("view").children.some((item) => item.textContent === "Database status"));
    location.hash = "#/sql";
    await events.hashchange();
    assert.equal(mounted[0].title, "World Feed Database SQL");
    assert.ok(mounted[0].examples.some((item) => /FROM actions/.test(item.sql)));
    node("searchInput").value = `0x${"ab".repeat(32)}`;
    node("searchForm").listeners.submit({ preventDefault() {} });
    assert.equal(routes[0], `/post/0x${"ab".repeat(32)}`);
    assert.ok(calls.every((url) => url.endsWith("/stats")));
  });
});
