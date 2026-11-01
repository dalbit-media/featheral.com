"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { ethers } = require("ethers");
const { createDollarApi: createTokenApi } = require("../services/dollar-api/server");
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

describe("World communication ledger", () => {
  let dir;
  let fth;
  let world;
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();
  const admin = ethers.Wallet.createRandom();
  let counter = 0;

  async function act(wallet, kind, fields, signer = wallet) {
    counter += 1;
    const data = { w: wallet.address, by: signer.address, n: (counter.toString(16) + "a".repeat(20)).slice(0, 20), ts: new Date().toISOString(), ...fields };
    data.sig = await signer.signMessage(socialMessage(kind, data));
    return call(world.handle, "POST", "/api/v1/world/actions", { kind, data });
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-ledger-"));
    fth = createTokenApi({ env: { FTH_LEDGER_MODE: "unconfigured", FTH_LEDGER_DIR: path.join(dir, "fth"), FTH_LEDGER_BLOCK_INTERVAL_MS: "0" } });
    world = createWorldApi({ fthLedger: fth.ledger, env: { WORLD_LEDGER_DIR: path.join(dir, "world"), WORLD_LEDGER_BLOCK_INTERVAL_MS: "0", FEATHERAL_ADMIN_WALLETS: admin.address }, logger: { error() {} } });
  });

  after(() => {
    world.close();
    fth.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records signed posts, replies, likes, reposts and follows and serves timelines", async () => {
    const post = await act(alice, "POST", { text: "hello featheral", rp: "" });
    assert.equal(post.status, 200, post.raw);
    const id = post.body.receipt.hash;
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
    const stolen = await act(bob, "DELETE", { p: post.body.receipt.hash });
    assert.equal(stolen.status, 403);
    assert.equal((await act(alice, "DELETE", { p: post.body.receipt.hash })).status, 200);
    const gone = await call(world.handle, "GET", `/api/v1/world/posts/${post.body.receipt.hash}`);
    assert.equal(gone.body.post.deleted, true);
  });

  it("lets a wallet delegate a session key and rejects unauthorized keys", async () => {
    const session = ethers.Wallet.createRandom();
    assert.equal((await act(alice, "POST", { text: "no session yet", rp: "" }, session)).status, 401);
    assert.equal((await act(alice, "SESSION", { k: session.address, exp: Date.now() + 3_600_000 })).status, 200);
    assert.equal((await act(alice, "POST", { text: "signed by session key", rp: "" }, session)).status, 200);
    assert.equal((await act(alice, "SESSION", { k: bob.address, exp: Date.now() + 3_600_000 }, session)).status, 401);
  });

  it("applies moderation only from configured admin wallets", async () => {
    const post = await act(bob, "POST", { text: "spam", rp: "" });
    const id = post.body.receipt.hash;
    assert.equal((await act(alice, "MOD", { act: "HIDE", tg: id })).status, 403);
    assert.equal((await act(admin, "MOD", { act: "HIDE", tg: id })).status, 200);
    const feed = await call(world.handle, "GET", "/api/v1/world/timeline");
    assert.ok(!feed.body.posts.some((item) => item.id === id));
    assert.equal((await act(admin, "MOD", { act: "SUSPEND", tg: bob.address })).status, 200);
    assert.equal((await act(bob, "POST", { text: "still here?", rp: "" })).status, 403);
  });

  it("exposes a read-only SQL console over both ledgers", async () => {
    const posts = await call(world.handle, "GET", `/api/v1/world/sql?q=${encodeURIComponent("SELECT author, count(*) AS n FROM posts GROUP BY author ORDER BY n DESC")}`);
    assert.equal(posts.status, 200, posts.raw);
    assert.deepEqual(posts.body.columns, ["author", "n"]);
    for (const bad of ["DELETE FROM posts", "SELECT 1; DROP TABLE posts", "PRAGMA table_info(posts)", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT * FROM c"]) {
      const result = await call(world.handle, "POST", "/api/v1/world/sql", { query: bad });
      assert.equal(result.status, 400, bad);
    }
    assert.ok((await call(world.handle, "GET", "/api/v1/world/sql/schema")).body.tables.some((table) => table.name === "posts"));
    const fthRows = await call(fth.handle, "GET", `/api/v1/fth/sql?q=${encodeURIComponent("SELECT kind, count(*) AS n FROM transactions GROUP BY kind")}`);
    assert.equal(fthRows.status, 200, fthRows.raw);
    assert.ok(fthRows.body.rows.some((row) => row[0] === "GENESIS"));
    const blocked = await call(fth.handle, "POST", "/api/v1/fth/sql", { query: "UPDATE accounts SET balance = '1'" });
    assert.equal(blocked.status, 400);
  });

  it("rebuilds identical state from its block files", async () => {
    const before = await call(world.handle, "GET", "/api/v1/world/stats");
    const replica = createWorldApi({ fthLedger: fth.ledger, env: { WORLD_LEDGER_MODE: "reader", WORLD_LEDGER_DIR: path.join(dir, "world"), FEATHERAL_ADMIN_WALLETS: admin.address }, logger: { error() {} } });
    try {
      assert.equal(replica.ledger.tipHash, world.ledger.tipHash);
      const after = await call(replica.handle, "GET", "/api/v1/world/stats");
      assert.equal(after.body.ledger.posts, before.body.ledger.posts);
    } finally {
      replica.ledger.sql.close();
    }
  });
});
