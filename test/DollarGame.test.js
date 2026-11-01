const { expect } = require("chai");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");
const { FthLedger, walletAccountId } = require("../services/fth-ledger/ledger");
const { gameSigningKey, ledgerFunds, SYSTEM_TREASURY_ACCOUNT } = require("../services/dollar-api/funds");
const { SqliteStore } = require("../sites/world/featheral/server/store.ts");
const { apply } = require("../sites/world/featheral/server/economy.ts");
const { gameFundAccount } = require("../sites/world/featheral/server/funds.ts");
const { createApi } = require("../sites/world/featheral/server/http.ts");
const { walletLinkMessage } = require("../sites/world/featheral/src/funds.ts");
const { createDollarApi } = require("../services/dollar-api/server");
const { Readable } = require("node:stream");
const { transferMessage } = require("../services/fth-ledger/transfer");
const http = require("node:http");
const { createGoldApi } = require("../services/gold-api/server");

describe("Dollar-owned World funds", () => {
  let directory, ledger, store, adapter, database;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dollar-game-"));
    const keys = gameSigningKey(directory);
    ledger = new FthLedger({ directory: path.join(directory, "ledger"), blockIntervalMs: 0, genesis: { gamePublicKey: keys.publicKey } }).open();
    adapter = ledgerFunds(ledger, keys.privateKey);
    database = path.join(directory, "game.sqlite");
    store = new SqliteStore(database, Date.now, 1, adapter);
  });
  afterEach(() => { store.close(); ledger.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function player(amount = "100") {
    const wallet = ethers.Wallet.createRandom(), identity = store.create();
    if (amount !== "0") await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account: walletAccountId(wallet.address), amount: ethers.parseUnits(amount, 18).toString(), data: { src: "FthgConverted", tx: `0x${"ab".repeat(32)}` } });
    store.linkWallet(identity.token, wallet.address.toLowerCase());
    store.transaction(identity.token, (s) => {
      s.account.game.stage = 0;
      s.account.game.home = { ...s.account.game.position };
      s.account.game.stock = { wood: 1000, water: 1000, metal: 1000, oil: 1000 };
    });
    return { ...identity, wallet, owner: store.chatSession(identity.token).owner };
  }
  const action = (person, command) => store.transaction(person.token, (s, now, realTime, exchange, owner) =>
    exchange.action(owner, s, { id: crypto.randomUUID(), revision: s.account.revision, command }, now, realTime));

  it("starts with zero currency and empty pools, without simulated Gold or staking", () => {
    const identity = store.create();
    expect(store.publicTotals().dollars).to.equal(0);
    expect(ledger.summary().supply).to.equal("0");
    store.transaction(identity.token, (s, now, realTime, exchange, owner) => {
      expect(exchange.read(owner, s.account, now, realTime, "wood", 1).market.quotes.sell.available).to.equal(false);
    });
  });
  it("recycles gameplay payments into the system treasury while retaining 18-decimal wallet dust", async () => {
    const person = await player("100.000000000000000001");
    store.transaction(person.token, (s, now, realTime) => apply(s.account, { id: crypto.randomUUID(), revision: s.account.revision, command: { type: "warehouse" } }, now, realTime));
    expect(ledger.balance(walletAccountId(person.wallet.address)).balance).to.equal(ethers.parseUnits("50.000000000000000001", 18).toString());
    expect(store.read(person.token, s => s.account.game.dollars)).to.equal(500000);
    expect(ledger.accountHistory(walletAccountId(person.wallet.address))[0]).to.include({ kind: "GAME", gameDelta: `-${ethers.parseUnits("50", 18)}` });
    expect(ledger.balance(SYSTEM_TREASURY_ACCOUNT).available).to.equal(ethers.parseUnits("50", 18).toString());
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100.000000000000000001", 18).toString());
    await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account: walletAccountId(person.wallet.address), amount: ethers.parseUnits("10", 18).toString(), data: { src: "StakeClaimed", tx: `0x${"cd".repeat(32)}` } });
    expect(store.read(person.token, s => s.account.game.dollars)).to.equal(600000);
  });
  it("funds market liquidity only by donating owned assets and existing wallet funds", async () => {
    const person = await player();
    action(person, { type: "fund-pool", asset: "wood", quantity: 20, dollars: 10 });
    expect(ledger.balance(gameFundAccount("pool", "wood")).balance).to.equal(ethers.parseUnits("10", 18).toString());
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
    expect(store.read(person.token, s => s.account.game.stock.wood)).to.equal(980);
  });
  it("funds through the exact 10,000-lot limit without exceeding the donor balance or creating supply", async () => {
    const person = await player();
    store.transaction(person.token, s => { s.account.game.stock.wood = 10000; });
    expect(() => action(person, { type: "fund-pool", asset: "wood", quantity: 10001, dollars: 100 })).to.throw("Invalid pool funding");
    expect(() => action(person, { type: "fund-pool", asset: "wood", quantity: 10000, dollars: 101 })).to.throw();
    action(person, { type: "fund-pool", asset: "wood", quantity: 10000, dollars: 100 });
    expect(store.read(person.token, s => s.account.game.stock.wood)).to.equal(0);
    expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal("0");
    expect(ledger.balance(gameFundAccount("pool", "wood")).available).to.equal(ethers.parseUnits("100", 18).toString());
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("settles player trades through ledger escrow and returns cancellations without issuance", async () => {
    const buyer = await player(), seller = await player("0");
    const order = action(buyer, { type: "limit", asset: "wood", side: "buy", quantity: 10, price: 2 }).market.orders[0];
    expect(ledger.balance(gameFundAccount("escrow", buyer.owner)).balance).to.equal(ethers.parseUnits("20", 18).toString());
    action(seller, { type: "spot", asset: "wood", side: "sell", quantity: 3, limitDollars: 6 });
    expect(ledger.balance(walletAccountId(seller.wallet.address)).balance).to.equal(ethers.parseUnits("6", 18).toString());
    store.transaction(buyer.token, s => { s.account.lastActionAt = 0; });
    action(buyer, { type: "cancel", orderId: order.id });
    expect(ledger.balance(walletAccountId(buyer.wallet.address)).balance).to.equal(ethers.parseUnits("94", 18).toString());
    expect(ledger.balance(gameFundAccount("escrow", buyer.owner)).balance).to.equal("0");
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("rejects unbacked mutations atomically", async () => {
    const person = await player();
    expect(() => store.transaction(person.token, s => { s.account.game.dollars++; })).to.throw("issue FTH$");
    expect(store.read(person.token, s => s.account.game.dollars)).to.equal(1000000);
  });
  it("recovers an interrupted ledger commit exactly once after restart", async () => {
    const person = await player();
    const commit = adapter.commit;
    adapter.commit = () => { throw new Error("Injected ledger storage failure"); };
    expect(() => store.transaction(person.token, (s, now, realTime) => apply(s.account, { id: crypto.randomUUID(), revision: s.account.revision, command: { type: "warehouse" } }, now, realTime))).to.throw("unavailable");
    expect(ledger.balance(walletAccountId(person.wallet.address)).balance).to.equal(ethers.parseUnits("100", 18).toString());
    store.close();
    adapter.commit = commit;
    store = new SqliteStore(database, Date.now, 1, adapter);
    expect(store.read(person.token, s => s.account.warehouse)).to.equal(1);
    expect(ledger.balance(walletAccountId(person.wallet.address)).balance).to.equal(ethers.parseUnits("50", 18).toString());
    store.read(person.token, s => s.account);
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
    expect(ledger.balance(SYSTEM_TREASURY_ACCOUNT).available).to.equal(ethers.parseUnits("50", 18).toString());
  });
  it("restores a wallet's settlement in another signed browser session rather than duplicating funds", async () => {
    const person = await player(), next = store.create();
    store.linkWallet(next.token, person.wallet.address.toLowerCase());
    expect(store.chatSession(next.token).owner).to.equal(person.owner);
    expect(store.read(next.token, s => s.account.game.stock.wood)).to.equal(1000);
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("revokes original and restored browser capabilities without losing wallet funds or the settlement", async () => {
    const person = await player(), alias = store.create();
    store.linkWallet(alias.token, person.wallet.address.toLowerCase());
    const guest = store.revokeWallet(person.token);
    expect(() => store.read(person.token, s => s.account)).to.throw("Session expired");
    expect(store.wallet(guest.token)).to.equal(null);
    expect(store.read(guest.token, s => s.account.game.dollars)).to.equal(0);
    store.revokeWallet(alias.token);
    expect(() => store.read(alias.token, s => s.account)).to.throw("Session expired");
    const restored = store.create();
    store.linkWallet(restored.token, person.wallet.address.toLowerCase());
    expect(store.read(restored.token, s => s.account.game.stock.wood)).to.equal(1000);
    expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("routes signed wallet authorization through Dollar, rejecting forged, stale and cross-session signatures", async () => {
    const origin = "http://world.localhost:8080", identity = store.create(), other = store.create();
    const wallet = ethers.Wallet.createRandom(), wrong = ethers.Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const signature = await wallet.signMessage(walletLinkMessage(wallet.address, identity.csrf, issuedAt, origin));
    const server = createApi(store, origin, undefined, "dollar");
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (person, body, csrf = person.csrf, route = "link") => fetch(`${base}/api/dollar/game/wallet/${route}`, {
      method: "POST", headers: { Origin: origin, Cookie: `terra-dev=${person.token}`, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body),
    });
    try {
      const body = { address: wallet.address, issuedAt, signature };
      expect((await post(identity, body, "wrong")).status).to.equal(403);
      expect((await post(other, body)).status).to.equal(401);
      expect((await post(identity, { ...body, issuedAt: new Date(Date.now() - 600000).toISOString() })).status).to.equal(400);
      expect((await post(identity, { ...body, address: wrong.address })).status).to.equal(401);
      expect((await fetch(`${base}/api/dollar/game/wallet/link`)).status).to.equal(405);
      expect((await fetch(`${base}/api/session`)).status).to.equal(404);
      const linked = await post(identity, body);
      expect(linked.status).to.equal(200);
      expect((await linked.json()).fundWallet).to.equal(wallet.address.toLowerCase());
      const revoked = await post(identity, {}, identity.csrf, "revoke");
      expect(revoked.status).to.equal(200);
      expect((await revoked.json()).fundWallet).to.equal(null);
      expect(() => store.read(identity.token, s => s.account)).to.throw("Session expired");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  it("replays signed gameplay entries and rejects forged authority signatures", async () => {
    const person = await player();
    action(person, { type: "fund-pool", asset: "wood", quantity: 20, dollars: 10 });
    const forged = adapter.prepare([{ account: walletAccountId(person.wallet.address), delta: `-${10n ** 14n}` }]);
    forged.d.signature = crypto.sign(null, Buffer.from("wrong"), crypto.generateKeyPairSync("ed25519").privateKey).toString("base64");
    expect(() => ledger.applyTx(forged, { validateOnly: true })).to.throw("signature");
    ledger.close();
    ledger = new FthLedger({ directory: path.join(directory, "ledger"), blockIntervalMs: 0 }).open();
    expect(ledger.balance(gameFundAccount("pool", "wood")).balance).to.equal(ethers.parseUnits("10", 18).toString());
    expect(ledger.balance(walletAccountId(person.wallet.address)).balance).to.equal(ethers.parseUnits("90", 18).toString());
  });
  it("blocks new conversion and reward credits but preserves idempotent historical settlements", async () => {
    const wallet = ethers.Wallet.createRandom(), txHash = `0x${"ef".repeat(32)}`;
    let result = { pending: true, confirmations: 1, events: [] };
    const api = createDollarApi({ ledger, env: {}, logger: { error() {}, warn() {} }, gold: { confirmations: 12, async verifiedEvents() { return result; } } });
    const settle = async (url = "/api/v1/dollar/settlements") => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ txHash }))]), { method: "POST", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } });
      const res = { status: 0, text: "", setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.text = text; } };
      await api.handle(req, res);
      return { status: res.status, body: JSON.parse(res.text) };
    };
    expect((await settle()).status).to.equal(202);
    const event = { txHash, logIndex: 0, blockNumber: 100, blockTime: Date.now(),
      parsed: { name: "FthgConverted", args: { account: wallet.address, gameAccountId: walletAccountId(wallet.address), fthDollarOut: ethers.parseUnits("100", 18) } } };
    result = { pending: false, events: [event] };
    const blocked = await settle();
    expect(blocked.status).to.equal(409);
    expect(blocked.body.error).to.include("issuance is closed");
    expect(ledger.summary().supply).to.equal("0");
    await ledger.submit({ id: `eth:1:${txHash}:0`, kind: "CREDIT", account: walletAccountId(wallet.address),
      amount: ethers.parseUnits("100", 18).toString(),
      data: { src: "FthgConverted", tx: txHash, log: 0, blk: 100, w: wallet.address } });
    expect((await settle()).status).to.equal(200);
    expect(ledger.balance(walletAccountId(wallet.address)).available).to.equal(ethers.parseUnits("100", 18).toString());
    result = { pending: false, events: [{ ...event, blockTime: Date.now() - 3600000 }] };
    expect((await settle()).status).to.equal(409);
    result = { pending: false, events: [{ ...event, logIndex: 1, parsed: { name: "StakeClaimed", args: { gameAccountId: walletAccountId(wallet.address), rewardFthDollar: 0n } } }] };
    expect((await settle()).body.status).to.equal("no-ledger-change");
    result = { pending: false, events: [{ ...event, logIndex: 2, parsed: { name: "StakeClaimed", args: {
      gameAccountId: walletAccountId(wallet.address), rewardFthDollar: 10n } } }] };
    expect((await settle()).status).to.equal(409);
    expect((await settle("/api/v1/settlements")).status).to.equal(401);
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("exposes the closed circulation policy independently of Gold RPC availability", async () => {
    const api = createDollarApi({ ledger, env: {}, gold: { confirmations: 12, async stats() { throw new Error("RPC unavailable"); } } });
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await api.handle({ method: "GET", url: "/api/v1/dollar/stats", headers: {} }, res);
    expect(res.status).to.equal(200);
    expect(res.body.monetaryPolicy).to.include({ issuanceEnabled: false, stakingRewardsEnabled: false,
      gameplayPayments: "system-treasury", treasuryAccount: SYSTEM_TREASURY_ACCOUNT, treasuryAvailable: "0" });
    await api.handle({ method: "GET", url: "/api/v1/dollar/quote?direction=fthg-to-fthdollar&amount=1", headers: {} }, res);
    expect(res.status).to.equal(409);
  });
  it("does not let ordinary gameplay entries spend the system treasury", async () => {
    await player();
    expect(() => adapter.prepare([{ account: SYSTEM_TREASURY_ACCOUNT, delta: "-1" }])).to.throw("cannot directly spend");
  });
  it("composes World sessions, Dollar gameplay and Gold reads over HTTP with demand-priced conserved liquidity", async () => {
    const person = await player();
    const gold = createGoldApi({ env: {}, provider: {
      async getNetwork() { return { chainId: 1n }; },
      async getBlockNumber() { return 123; },
      async call() { return ethers.zeroPadValue("0x01", 32); },
      async send() { return "0x1"; },
    } });
    const dollar = createDollarApi({ ledger, env: {}, gold, beforeLedgerMutation: () => store.recoverFunds() });
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const worldGame = createApi(store, origin, undefined, "world"), dollarGame = createApi(store, origin, undefined, "dollar");
    server.on("request", async (req, res) => {
      if (req.url.startsWith("/api/dollar/game/")) return dollarGame.emit("request", req, res);
      if (await gold.handle(req, res) || await dollar.handle(req, res)) return;
      worldGame.emit("request", req, res);
    });
    const headers = { cookie: `terra-dev=${person.token}`, origin, "content-type": "application/json", "x-csrf-token": person.csrf };
    const read = async path => {
      const response = await fetch(origin + path, { headers });
      expect(response.status).to.equal(200);
      return response.json();
    };
    const command = async command => {
      const state = await read("/api/dollar/game/state");
      const response = await fetch(origin + "/api/dollar/game/market/actions", { method: "POST", headers,
        body: JSON.stringify({ id: crypto.randomUUID(), revision: state.revision, command }) });
      expect(response.status).to.equal(200);
      return response.json();
    };
    try {
      const session = await fetch(origin + "/api/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
      expect(session.status).to.equal(201);
      expect((await read("/api/v1/gold/health")).status).to.equal("ok");
      expect((await read("/api/v1/gold/stats")).chain.latestBlock).to.equal(123);
      expect((await read("/api/v1/dollar/stats")).monetaryPolicy.issuanceEnabled).to.equal(false);
      await command({ type: "fund-pool", asset: "wood", quantity: 20, dollars: 10 });
      const before = await read("/api/dollar/game/market?asset=wood&quantity=1");
      store.transaction(person.token, s => { s.account.lastActionAt = 0; });
      await command({ type: "spot", asset: "wood", side: "buy", quantity: 1, limitDollars: before.market.quotes.buy.dollars });
      const after = await read("/api/dollar/game/market?asset=wood&quantity=1");
      expect(after.market.quotes.buy.dollars).to.be.greaterThan(before.market.quotes.buy.dollars);
      expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
      expect((await read(`/api/v1/dollar/wallets/${person.wallet.address}`)).fthDollar.available)
        .to.equal(ledger.balance(walletAccountId(person.wallet.address)).available);
    } finally {
      await new Promise(resolve => server.close(resolve));
      worldGame.emit("close"); dollarGame.emit("close"); gold.close();
    }
  });
  it("blocks external wallet transfers behind pending gameplay settlement and resumes after recovery", async () => {
    const person = await player(), recipient = ethers.Wallet.createRandom();
    const commit = adapter.commit;
    adapter.commit = () => { throw new Error("Injected storage failure"); };
    const transfer = { wallet: person.wallet.address, to: walletAccountId(recipient.address), amount: ethers.parseUnits("50", 18).toString(), nonce: 1, memo: "", issuedAt: new Date().toISOString() };
    transfer.signature = await person.wallet.signMessage(transferMessage(transfer));
    const api = createDollarApi({ ledger, env: {}, logger: { error() {}, warn() {} }, gold: { confirmations: 12 }, beforeLedgerMutation: () => store.recoverFunds() });
    const send = async () => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(transfer))]), { method: "POST", url: "/api/v1/dollar/fth/transfers", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
      const res = { status: 0, setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
      await api.handle(req, res);
      return res.status;
    };
    try {
      expect(() => store.transaction(person.token, (s, now, realTime) => apply(s.account, { id: crypto.randomUUID(), revision: s.account.revision, command: { type: "warehouse" } }, now, realTime))).to.throw("unavailable");
      expect(await send()).to.equal(503);
      expect(ledger.nonce(walletAccountId(person.wallet.address))).to.equal(0);
      adapter.commit = commit;
      expect(await send()).to.equal(200);
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal("0");
      expect(ledger.balance(walletAccountId(recipient.address)).available).to.equal(ethers.parseUnits("50", 18).toString());
    } finally { adapter.commit = commit; }
  });
});
