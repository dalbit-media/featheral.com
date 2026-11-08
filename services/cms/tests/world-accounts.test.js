"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { Wallet } = require("ethers");
const sqlite = require("../../database/sqlite");
const { createWorldAccounts } = require("../../identity/world-accounts");
const { completeProfile } = require("../../identity/profile-ui");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=";

test("World password registration stores only hashed credentials and encrypted wallets, supports a new client and preserves sessions", async t => {
  const db = sqlite.open(":memory:"), profiles = new Map(), bootstraps = [];
  const options = {
    sqlite: { open: () => db }, file: ":memory:", forwardedOrigin: "http://world.localhost", profiles: { get: address => profiles.get(address.toLowerCase()) || null },
    bootstrapGame: async (_req, _res, address) => { bootstraps.push(address); return { connected: true }; },
  };
  let accounts = createWorldAccounts(options);
  const server = http.createServer(async (req, res) => {
    if (!await accounts.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); accounts.close(); });
  async function call(route, body, cookie = "", headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/world-account/" + route,
        method: body === undefined ? "GET" : "POST",
        headers: { Host: "world.localhost", Origin: "http://world.localhost", "Content-Type": "application/json", Cookie: cookie, ...headers } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers,
          cookie: res.headers["set-cookie"]?.[0].split(";")[0] || cookie }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const wallet = Wallet.createRandom(), password = "test-password-world-42", username = "WorldBuilder";
  assert.equal((await call("nested/login", { username, password })).status, 404);
  assert.equal((await call("nested/challenge", { action: "sign-in", address: wallet.address })).status, 404);
  const keystore = await wallet.encrypt(password);
  profiles.set(wallet.address.toLowerCase(), { address: wallet.address, username, avatar, bio: "Building a shared world." });
  const challenge = await call("challenge", { action: "register", address: wallet.address, username, keystore });
  assert.equal(challenge.status, 200);
  assert.match(challenge.data.message, /no funds move/);
  const signature = await wallet.signMessage(challenge.data.message);
  const registered = await call("register", { id: challenge.data.id, signature, password, keystore });
  assert.equal(registered.status, 200, registered.data.error); assert.equal(registered.data.complete, true);
  assert.equal(registered.data.walletType, "built-in");
  assert.match(registered.headers["set-cookie"][0], /HttpOnly; SameSite=Strict; Path=\//);
  assert.doesNotMatch(registered.headers["set-cookie"][0], /Domain=/);
  const stored = db.prepare("SELECT * FROM world_password_accounts").get();
  assert.notEqual(stored.password_hash, password); assert.equal(stored.keystore, keystore);
  assert.equal(stored.keystore.includes(wallet.privateKey.slice(2)), false);
  assert.equal((await call("register", { id: challenge.data.id, signature, password, keystore })).status, 401);
  assert.equal((await call("login", { username, password: "wrong-password" })).status, 401);
  assert.equal((await call("login", { username: "NoSuchUser", password })).data.error, "Username or password is incorrect.");
  const crossDevice = await call("login", { username: username.toLowerCase(), password });
  assert.equal(crossDevice.status, 200);
  assert.equal(crossDevice.data.account, wallet.address); assert.equal(crossDevice.data.keystore, keystore);
  assert.equal((await Wallet.fromEncryptedJson(crossDevice.data.keystore, password)).address, wallet.address);

  accounts = createWorldAccounts(options);
  const session = await call("session", undefined, crossDevice.cookie);
  assert.equal(session.data.account, wallet.address); assert.equal(session.data.keystore, undefined);
  const csrf = { "X-CSRF-Token": session.data.csrf };
  assert.doesNotThrow(() => accounts.authorizeMedia(session.data.csrf, wallet.address));
  assert.throws(() => accounts.authorizeMedia(null, wallet.address), /Sign in/);
  assert.throws(() => accounts.authorizeMedia(session.data.csrf, Wallet.createRandom().address), /another wallet/);
  const handoff = await call("media-handoff", { origin: "http://media.localhost" }, crossDevice.cookie, csrf);
  assert.equal(handoff.status, 200);
  const handedOff = await call("session?handoff=" + handoff.data.code, undefined, "", { Origin: "http://media.localhost" });
  assert.equal(handedOff.data.account, wallet.address);
  assert.equal((await call("session?handoff=" + handoff.data.code, undefined, "", { Origin: "http://media.localhost" })).status, 401);
  const mediaRestored = await call("media-session", { token: session.data.csrf, account: wallet.address }, "", { Origin: "http://media.localhost" });
  assert.equal(mediaRestored.status, 200); assert.equal(mediaRestored.data.account, wallet.address);
  assert.equal((await call("backup", {}, crossDevice.cookie)).status, 403);
  assert.equal((await call("backup", {}, crossDevice.cookie, csrf)).data.keystore, keystore);
  assert.equal((await call("game", {}, crossDevice.cookie, csrf)).status, 200);
  assert.deepEqual(bootstraps, [wallet.address]);
  const profile = profiles.get(wallet.address.toLowerCase());
  profiles.set(wallet.address.toLowerCase(), { ...profile, avatar: "" });
  assert.equal((await call("game", {}, crossDevice.cookie, csrf)).status, 403);
  profiles.set(wallet.address.toLowerCase(), profile);
  assert.equal((await call("logout", {}, crossDevice.cookie, csrf)).status, 200);
  assert.equal((await call("session", undefined, crossDevice.cookie)).data.account, null);
  assert.throws(() => accounts.authorizeMedia(session.data.csrf, wallet.address), /expired/);
  assert.equal((await call("session", undefined, registered.cookie)).data.account, wallet.address);
  assert.equal((await call("challenge", { action: "sign-in", address: wallet.address }, "", { Origin: "https://evil.example" })).status, 403);
  const media = await call("session", undefined, registered.cookie, { Origin: "http://media.localhost" });
  assert.equal(media.headers["access-control-allow-origin"], "http://media.localhost");
  assert.equal(media.headers["access-control-allow-credentials"], "true");
  assert.equal((await call("session", undefined, registered.cookie, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call("session", undefined, "", { Host: "media.localhost" })).status, 404);
  assert.equal((await call("session", undefined, registered.cookie, { Host: "dollar.localhost" })).status, 404);
  const forwarded = { Host: "dollar.localhost", "X-Featheral-World-Origin": "http://world.localhost" };
  assert.equal((await call("session", undefined, registered.cookie, forwarded)).data.account, wallet.address);
  assert.equal((await call("login", { username, password }, "", forwarded)).status, 200);
  assert.equal((await call("login", { username, password }, "", { ...forwarded, Origin: "http://dollar.localhost" })).status, 403);
  const external = Wallet.createRandom();
  const externalChallenge = await call("challenge", { action: "sign-in", address: external.address });
  const externalLogin = await call("wallet-login", { id: externalChallenge.data.id, signature: await external.signMessage(externalChallenge.data.message) });
  assert.equal(externalLogin.status, 200); assert.equal(externalLogin.data.walletType, "external");
  assert.equal(externalLogin.data.complete, false);
  assert.equal((await call("game", {}, externalLogin.cookie, { "X-CSRF-Token": externalLogin.data.csrf })).status, 403);
  assert.equal((await call("wallet-login", { id: externalChallenge.data.id, signature: await external.signMessage(externalChallenge.data.message) })).status, 401);
});

test("an existing wallet enables password login before profile setup and restores the same key on another device", async t => {
  const accounts = createWorldAccounts({ sqlite, file: ":memory:", profiles: { get: () => null },
    bootstrapGame() { throw new Error("Incomplete profile must not start gameplay"); } });
  const server = http.createServer(async (req, res) => { if (!await accounts.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); accounts.close(); });
  const call = (route, body, cookie = "", csrf = "") => new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/world-account/" + route,
      method: "POST", headers: { Host: "world.localhost", Origin: "http://world.localhost", Cookie: cookie,
        "Content-Type": "application/json", "X-CSRF-Token": csrf } }, response => {
      let text = ""; response.on("data", chunk => text += chunk);
      response.on("end", () => resolve({ status: response.statusCode, data: JSON.parse(text),
        cookie: response.headers["set-cookie"]?.[0].split(";")[0] || cookie }));
    });
    request.on("error", reject); request.end(JSON.stringify(body));
  });
  const wallet = Wallet.createRandom(), password = "existing-wallet-password-42", username = "ExistingWallet";
  const keystore = await wallet.encrypt(password);
  const walletChallenge = await call("challenge", { action: "sign-in", address: wallet.address });
  const connected = await call("wallet-login", { id: walletChallenge.data.id, signature: await wallet.signMessage(walletChallenge.data.message) });
  assert.equal(connected.data.walletType, "external");
  const challenge = await call("challenge", { action: "register", address: wallet.address, username, keystore }, connected.cookie);
  const registered = await call("register", { id: challenge.data.id, signature: await wallet.signMessage(challenge.data.message), password, keystore }, connected.cookie);
  assert.equal(registered.status, 200, registered.data.error);
  assert.equal(registered.data.account, wallet.address);
  assert.equal(registered.data.loginUsername, username);
  assert.equal(registered.data.walletType, "built-in");
  assert.equal(registered.data.complete, false);
  assert.equal((await call("game", {}, registered.cookie, registered.data.csrf)).status, 403);
  assert.throws(() => accounts.authorizeMedia(registered.data.csrf, wallet.address), /profile/);
  const otherDevice = await call("login", { username, password });
  assert.equal(otherDevice.status, 200);
  assert.equal(otherDevice.data.account, wallet.address);
  assert.equal(otherDevice.data.keystore, keystore);
  assert.equal((await Wallet.fromEncryptedJson(otherDevice.data.keystore, password)).address, wallet.address);
  assert.equal((await call("login", { username, password: "incorrect password" })).status, 401);
  const duplicate = await call("challenge", { action: "register", address: wallet.address, username, keystore });
  assert.equal((await call("register", { id: duplicate.data.id, signature: await wallet.signMessage(duplicate.data.message), password, keystore })).status, 409);
});

test("World settlement bootstrap restores wallet-owned settlements without changing legacy funds or moving guest money", async () => {
  const { SqliteStore } = require("../../../sites/world.featheral.com/play/server/store.ts");
  const vm = require("node:vm");
  const balances = new Map();
  const store = new SqliteStore(":memory:", Date.now, 1, {
    available: id => balances.get(id) || "0", supply: () => "0",
    prepare() { throw new Error("Bootstrap must not prepare a money transfer."); },
    commit() { throw new Error("Bootstrap must not commit a money transfer."); },
  });
  const source = fs.readFileSync(path.join(root, "scripts/serve.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("bootstrapGame: async (req, res, address, secure) => {") + "bootstrapGame: ".length;
  const end = source.indexOf("\n  },\n});", start) + "\n  }".length;
  const profiles = { get: address => ({ address, username: "WorldBuilder" }) };
  const bootstrap = vm.runInNewContext("(" + source.slice(start, end) + ")", { store, cms: { database: { profiles } }, Date });
  const owner = Wallet.createRandom().address.toLowerCase(), other = Wallet.createRandom().address.toLowerCase();
  async function run(token, address) {
    const headers = new Map();
    const result = await bootstrap({ headers: { cookie: token ? "terra-dev=" + token : "" } },
      { getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value) }, address, false);
    const next = headers.get("Set-Cookie")[0].split(";")[0].split("=")[1];
    return { next, result };
  }
  try {
    const original = store.create().token;
    const first = await run(original, owner);
    assert.equal(first.next, original);
    assert.equal(store.walletContext(first.next).fundMode, "separate");
    store.transaction(first.next, session => { session.account.customization = { settlementName: "Wallet A settlement" }; session.account.game.stock.wood = 11; });
    const restored = await run(null, owner);
    assert.equal(store.walletContext(restored.next).fundAccountId, first.result.accountId);
    assert.equal(store.chatSession(restored.next).owner, store.chatSession(first.next).owner);
    const legacyToken = store.create().token;
    store.linkWallet(legacyToken, other);
    store.transaction(legacyToken, session => { session.account.customization = { settlementName: "Wallet B settlement" }; session.account.game.stock.wood = 29; });
    await run(legacyToken, other);
    assert.equal(store.walletContext(legacyToken).fundMode, "legacy-direct");
    const switched = await run(legacyToken, owner);
    assert.equal(store.walletContext(switched.next).fundAccountId, first.result.accountId);
    assert.equal(store.walletContext(legacyToken).fundWallet, other);
    assert.equal(store.read(switched.next, session => session.account.customization.settlementName), "Wallet A settlement");
    assert.equal(store.read(switched.next, session => session.account.game.stock.wood), 11);
    const switchedBack = await run(switched.next, other);
    assert.equal(store.read(switchedBack.next, session => session.account.customization.settlementName), "Wallet B settlement");
    assert.equal(store.read(switchedBack.next, session => session.account.game.stock.wood), 29);
    assert.equal(store.walletContext(switchedBack.next).fundMode, "legacy-direct");
    assert.equal(store.walletContext(legacyToken).fundMode, "legacy-direct");
    const backToA = await run(switchedBack.next, owner);
    assert.equal(store.read(backToA.next, session => session.account.customization.settlementName), "Wallet A settlement");
    assert.equal(store.read(backToA.next, session => session.account.game.stock.wood), 11);
    const newWallet = Wallet.createRandom().address.toLowerCase(), fresh = await run(backToA.next, newWallet);
    assert.equal(store.walletContext(fresh.next).fundWallet, newWallet);
    assert.equal(store.read(fresh.next, session => session.account.customization?.settlementName), undefined);
    assert.equal(store.read((await run(fresh.next, owner)).next, session => session.account.customization.settlementName), "Wallet A settlement");
    const guest = store.create().token, guestAccount = store.walletContext(guest).fundAccountId;
    balances.set(guestAccount, "1000000000000000000");
    await assert.rejects(run(guest, owner), /guest has World funds/);
    assert.equal(balances.get(guestAccount), "1000000000000000000");
    assert.equal(store.walletContext(guest).fundWallet, null);
    const guardStart = source.indexOf("function authorizeWorldGame(");
    const guardEnd = source.indexOf("\n\nconst server =", guardStart);
    const guard = vm.runInNewContext("(" + source.slice(guardStart, guardEnd) + ")", {
      store, worldAccounts: { authorizeGame: () => owner },
    });
    assert.doesNotThrow(() => guard({ headers: { cookie: "terra-dev=" + first.next } }, "world.localhost"));
    assert.throws(() => guard({ headers: { cookie: "terra-dev=" + legacyToken } }, "world.localhost"), /Reconnect your World settlement/);
  } finally { store.close(); }
});

test("World profile completeness and World-owned setup are enforced without modifying legacy signed profiles", () => {
  assert.equal(completeProfile(null), false);
  for (const profile of [{ username: "WorldBuilder", avatar: "", bio: "Hello" }, { username: "WorldBuilder", avatar, bio: "   " }, { username: "x", avatar, bio: "Hello" }])
    assert.equal(completeProfile(profile), false);
  assert.equal(completeProfile({ username: "WorldBuilder", avatar, bio: "Hello" }), true);
  const media = fs.readFileSync(path.join(root, "sites/media.featheral.com/app.js"), "utf8");
  assert.doesNotMatch(media, /FeatheralWorldProfile\.mount/);
  assert.match(media, /if \(name === "setup"\).*FeatheralWorldAccount\.url/);
  assert.match(media, /FeatheralWorldAccount\.refresh\(\)/);
  const profile = fs.readFileSync(path.join(root, "sites/wallet.featheral.com/wallet-profile.js"), "utf8");
  assert.match(profile, /replace\("\/\/wallet\.", "\/\/world\."\).*\/account\//);
  const { worldResource } = require("../../../scripts/site-routing");
  assert.deepEqual(worldResource("world", "/account/"), { directory: path.join("world.featheral.com", "play", "dist"), pathname: "/account/" });
  const game = fs.readFileSync(path.join(root, "sites/world.featheral.com/play/src/main.ts"), "utf8");
  assert.match(game, /requireProfile\(\)/);
  assert.match(game, /request\('\/game', \{\}\)/);
});

test("World wallet switching requires the selected wallet's signature and publishes the new identity rather than a public wallet selection", async () => {
  const vm = require("node:vm"), { ethers } = require("ethers");
  const first = Wallet.createRandom(), second = Wallet.createRandom();
  let signedIn = first.address, challengeAddress = "", loginCount = 0;
  const events = [], requests = [];
  const window = {
    addEventListener() {},
    dispatchEvent: event => events.push(event.detail),
    FeatheralProfile: { setWorldSession() {} },
  };
  const context = vm.createContext({
    window, location: { hostname: "world.localhost", origin: "http://world.localhost:8080", port: "8080", href: "http://world.localhost:8080/" },
    URL, AbortSignal, CustomEvent, ethers, console,
    fetch: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      if (url.endsWith("/challenge")) {
        challengeAddress = JSON.parse(options.body).address;
        return Response.json({ id: "challenge", message: "Sign in to World as " + challengeAddress });
      }
      if (url.endsWith("/wallet-login")) {
        assert.equal(ethers.verifyMessage("Sign in to World as " + challengeAddress, JSON.parse(options.body).signature), challengeAddress);
        signedIn = challengeAddress; loginCount++;
        return Response.json({ account: signedIn });
      }
      assert.ok(url.endsWith("/session"));
      return Response.json({ account: signedIn, complete: true, csrf: "ab".repeat(32) });
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "shared/world-account.js"), "utf8"), context);
  const world = window.FeatheralWorldAccount;
  await world.refresh();
  assert.equal(world.snapshot().account, first.address);
  await assert.rejects(world.signInWallet(second.address, () => first.signMessage("Sign in to World as " + second.address)), /does not match/);
  assert.equal(loginCount, 0); assert.equal(world.snapshot().account, first.address);
  await world.signInWallet(second.address, message => second.signMessage(message));
  assert.equal(world.snapshot().account, second.address);
  assert.equal(events.at(-1).account, second.address); assert.equal(loginCount, 1);
  await world.signInWallet(first.address, message => first.signMessage(message));
  assert.equal(world.snapshot().account, first.address); assert.equal(loginCount, 2);
  assert.equal(requests.filter(request => request.url.endsWith("/wallet-login")).length, 2);
});

test("Media keeps public browsing but requires a complete World session for writes and refuses profile setup", async t => {
  const { createWorldApi } = require("../../media/api"), { socialMessage } = require("../../media/social");
  const wallet = Wallet.createRandom(), delegate = Wallet.createRandom();
  let complete = true, authorizations = 0;
  const world = createWorldApi({
    sqlite: { open: () => sqlite.open(":memory:") }, env: { WORLD_DB_FILE: path.join(root, "world-test.sqlite") },
    authorizeMedia(token, address) {
      authorizations++;
      if (token !== "world-session" || address?.toLowerCase() !== wallet.address.toLowerCase())
        throw Object.assign(new Error("Sign in to World before using Media."), { status: 401 });
      if (!complete) throw Object.assign(new Error("Complete your World profile before using Media."), { status: 403 });
    },
  });
  const server = http.createServer((req, res) => world.handle(req, res));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); world.close(); });
  async function call(route, input) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/v1/media/" + route,
        method: input === undefined ? "GET" : "POST", headers: { Host: "media.localhost", "Content-Type": "application/json" } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject); req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  assert.equal((await call("timeline")).status, 200);
  assert.equal((await call("profile/prepare", {})).status, 410);
  assert.equal((await call("profile", {})).status, 410);
  const data = { w: wallet.address, by: wallet.address, k: delegate.address, exp: Date.now() + 86400000,
    n: "ab".repeat(12), ts: new Date().toISOString() };
  data.sig = await wallet.signMessage(socialMessage("SESSION", data));
  assert.equal((await call("actions", { kind: "SESSION", data })).status, 401);
  complete = false;
  assert.equal((await call("actions", { kind: "SESSION", data, worldSession: "world-session" })).status, 403);
  complete = true;
  const accepted = await call("actions", { kind: "SESSION", data, worldSession: "world-session" });
  assert.equal(accepted.status, 200, accepted.data.error);
  assert.equal(authorizations, 3);
});

test("Media signing bridge binds the World popup, origin, nonce, message and signer and rejects closure", async () => {
  const vm = require("node:vm"), { ethers } = require("ethers");
  const wallet = Wallet.createRandom(), key = Wallet.createRandom();
  const { socialMessage } = require("../../media/social");
  const message = socialMessage("SESSION", { w: wallet.address, k: key.address, exp: Date.now() + 86400000,
    n: "ab".repeat(12), ts: new Date().toISOString() });
  const listeners = new Map(), timers = new Map(), posts = [];
  let popupUrl = "", timerId = 0, selectedProvider = null;
  const popup = { closed: false, close() { this.closed = true; }, postMessage: (data, origin) => posts.push({ data, origin }) };
  const window = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
    open: url => { popupUrl = url; return popup; },
    dispatchEvent() {},
    FeatheralProfile: { setWorldSession: (_session, provider) => { selectedProvider = provider; } },
  };
  const context = vm.createContext({
    window, location: { hostname: "media.localhost", origin: "http://media.localhost:8080", port: "8080", href: "http://media.localhost:8080/" },
    URL, Uint8Array, TextDecoder, AbortSignal, ethers, crypto: globalThis.crypto, CustomEvent, console,
    sessionStorage: { getItem: () => null }, history: { replaceState() {} },
    fetch: async () => Response.json({ account: wallet.address, complete: true, csrf: "ab".repeat(32) }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: callback => { timers.set(++timerId, callback); return timerId; }, clearInterval: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(root, "shared/world-account.js"), "utf8"), context);
  const world = window.FeatheralWorldAccount;
  await world.refresh(); assert.equal(selectedProvider, world.provider);
  const pending = world.provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(message)), wallet.address] });
  const nonce = new URL(popupUrl).searchParams.get("approve"), listener = listeners.get("message");
  const reply = { type: "featheral:world-sign-ready", nonce };
  listener({ origin: "https://evil.example", source: popup, data: reply });
  listener({ origin: "http://world.localhost:8080", source: {}, data: reply });
  listener({ origin: "http://world.localhost:8080", source: popup, data: { ...reply, nonce: "bad" } });
  assert.equal(posts.length, 0);
  listener({ origin: "http://world.localhost:8080", source: popup, data: reply });
  assert.equal(posts[0].origin, "http://world.localhost:8080");
  assert.equal(posts[0].data.message, message); assert.equal(posts[0].data.account, wallet.address);
  const signature = await wallet.signMessage(message);
  listener({ origin: "http://world.localhost:8080", source: popup, data: { type: "featheral:world-sign-result", nonce, signature } });
  assert.equal(await pending, signature); assert.equal(timers.size, 0);
  popup.closed = false;
  const closed = world.provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(message)), wallet.address] });
  const rejection = assert.rejects(closed, /window was closed/);
  popup.closed = true; [...timers.values()][1]();
  await rejection; assert.equal(timers.size, 0);
});
