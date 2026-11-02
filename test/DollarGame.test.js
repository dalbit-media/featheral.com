const { expect } = require("chai");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");
const { FthLedger, walletAccountId } = require("../services/fth-ledger/ledger");
const { gameSigningKey, ledgerFunds, SYSTEM_TREASURY_ACCOUNT } = require("../services/notes/game-funds");
const { SqliteStore } = require("../sites/world.featheral.com/play/server/store.ts");
const { apply } = require("../sites/world.featheral.com/play/server/economy.ts");
const { gameFundAccount } = require("../sites/world.featheral.com/play/server/funds.ts");
const { createApi } = require("../sites/world.featheral.com/play/server/http.ts");
const { walletLinkMessage } = require("../sites/world.featheral.com/play/src/funds.ts");
const { createDollarApi } = require("../services/notes/dollar");
const { Readable } = require("node:stream");
const { transferMessage } = require("../services/fth-ledger/transfer");
const http = require("node:http");
const { createGoldApi } = require("../services/gold/server");

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
  it("looks up linked World balances without creating accounts or double-counting legacy wallets", async () => {
    const person = await player("100"), address = person.wallet.address.toLowerCase();
    expect(store.walletWorldView(ethers.Wallet.createRandom().address)).to.equal(null);
    store.linkWallet(person.token, address, false);
    const legacy = store.walletWorldView(address);
    expect(legacy.accountId).to.equal(walletAccountId(address)); expect(legacy.mode).to.equal("legacy-direct");
    store.linkWallet(person.token, address, false, true);
    const separate = store.walletWorldView(address);
    expect(separate.mode).to.equal("separate"); expect(separate.accountId).not.to.equal(walletAccountId(address));
    expect(separate.available).to.equal("0");
    expect(ledger.balance(walletAccountId(address)).available).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("refreshes conflicting deposit nonces and discards unsigned requests without losing balances", async () => {
      const person = await player("100"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const input = { id: "nonce-world-deposit-0001", direction: "deposit", amount: ethers.parseUnits("10", 18).toString() };
      const original = store.prepareFund(person.token, input, origin);
      const competing = { wallet: person.wallet.address, to: walletAccountId(ethers.Wallet.createRandom().address),
        amount: "1", nonce: 1, memo: "different payment", issuedAt: new Date().toISOString() };
      await adapter.transfer({ ...competing, signature: await person.wallet.signMessage(transferMessage(competing)) });
      await expect(store.completeFund(person.token, original.id, await person.wallet.signMessage(original.message))).to.be.rejectedWith("nonce changed");
      expect(store.fundView(person.token).requests.find(request => request.id === original.id).status).to.equal("prepared");
      const updated = store.prepareFund(person.token, input, origin);
      expect(updated.payment.nonce).to.equal(2);
      expect(updated.message).not.to.equal(original.message);
      await expect(store.completeFund(person.token, updated.id, await person.wallet.signMessage(original.message))).to.be.rejectedWith("authorized wallet");
      await store.completeFund(person.token, updated.id, await person.wallet.signMessage(updated.message));
      expect(store.fundView(person.token).available).to.equal(input.amount);
      const cancel = store.prepareFund(person.token, { id: "discard-world-withdraw-0001", direction: "withdraw", amount: "1" }, origin);
      store.cancelFund(person.token, cancel.id);
      store.cancelFund(person.token, cancel.id);
      await expect(store.completeFund(person.token, cancel.id, await person.wallet.signMessage(cancel.message))).to.be.rejectedWith("discarded");
      expect(() => store.cancelFund(person.token, updated.id)).to.throw("unsigned");
      expect(store.fundView(person.token).available).to.equal(input.amount);
    });
    it("serves canonical separate authorization and fund transfers only to the same-origin authenticated session", async () => {
      const person = await player("100"), identity = store.chatSession(person.token), origin = "http://world.localhost:8080";
      const server = createApi(store, origin, undefined, "dollar");
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${server.address().port}/api/dollar/game/wallet`;
      const headers = { origin, cookie: `terra-dev=${person.token}`, "content-type": "application/json", "x-csrf-token": identity.csrf };
      const post = (path, body, extra = {}) => fetch(url + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      try {
        expect((await fetch(url + "/funds")).status).to.equal(401);
        expect((await post("/funds/authorization", { address: person.wallet.address }, { origin: "http://evil.test" })).status).to.equal(403);
        expect((await post("/funds/authorization", { address: person.wallet.address }, { "x-csrf-token": "" })).status).to.equal(403);
        expect((await post("/funds/authorization", { address: person.wallet.address, amount: "1" })).status).to.equal(400);
        const approval = await (await post("/funds/authorization", { address: person.wallet.address })).json();
        expect(approval.message).to.equal(walletLinkMessage(person.wallet.address, identity.csrf, approval.issuedAt, origin, false, true));
        expect((await post("/link", { address: person.wallet.address, issuedAt: approval.issuedAt, signature: await person.wallet.signMessage(approval.message),
          moveGuestFunds: false, separateWorldFunds: false })).status).to.equal(401);
        expect((await post("/link", { address: person.wallet.address, issuedAt: approval.issuedAt, signature: await person.wallet.signMessage(approval.message),
          moveGuestFunds: false, separateWorldFunds: true })).status).to.equal(200);
        const funds = await (await fetch(url + "/funds", { headers })).json();
        expect(funds.mode).to.equal("separate"); expect(funds.csrf).to.equal(identity.csrf);
        const prep = await (await post("/funds/prepare", { id: "http-world-deposit-0001", direction: "deposit", amount: "1000000000000000000" })).json();
        const signed = { id: prep.id, signature: await person.wallet.signMessage(prep.message) };
        expect((await post("/funds/complete", signed, { origin: "http://evil.test" })).status).to.equal(403);
        expect((await post("/funds/complete", signed, { "x-csrf-token": "" })).status).to.equal(403);
        const foreign = store.create();
        expect((await post("/funds/complete", signed, { cookie: `terra-dev=${foreign.token}`, "x-csrf-token": foreign.csrf })).status).to.equal(404);
        expect((await post("/funds/complete", { ...signed, amount: "2" })).status).to.equal(400);
        expect((await post("/funds/cancel", { id: prep.id }, { "x-csrf-token": "" })).status).to.equal(403);
        const result = await post("/funds/complete", signed);
        expect(result.status).to.equal(200);
        expect((await result.json()).available).to.equal("1000000000000000000");
        const retry = await post("/funds/complete", signed);
        expect(retry.status).to.equal(200);
        expect((await retry.json()).available).to.equal("1000000000000000000");
      } finally { await new Promise(resolve => server.close(resolve)); }
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
  it("checks the exact World accounting ceiling again when retrying an unaccepted signed deposit", async () => {
      const person = await player("100"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const prepared = store.prepareFund(person.token, { id: "ceiling-deposit-0001", direction: "deposit", amount: "1" }, origin);
      const transfer = adapter.transfer;
      adapter.transfer = async () => { throw new Error("offline before acceptance"); };
      await expect(store.completeFund(person.token, prepared.id, await person.wallet.signMessage(prepared.message))).to.be.rejectedWith("offline");
      adapter.transfer = transfer;
      const account = store.fundView(person.token).accountId;
      const ceiling = ((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 10n ** 14n - 1n).toString();
      await ledger.submit({ id: "fixture-accounting-ceiling", kind: "CREDIT", account, amount: ceiling,
        data: { src: "FthgConverted", tx: `0x${"dc".repeat(32)}` } });
      await expect(store.completeFund(person.token, prepared.id, "")).to.be.rejectedWith("World fund limit");
      expect(store.fundView(person.token).available).to.equal(ceiling);
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("100", 18).toString());
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
  it("moves explicitly approved guest funds into the same wallet once, including 18-decimal dust", async () => {
    const person = await player("100"), guest = store.create();
    const owner = store.chatSession(guest.token).owner, guestAccount = gameFundAccount("guest", owner);
    const amount = ethers.parseUnits("1104.172000000000000001", 18).toString();
    await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account: guestAccount, amount,
      data: { src: "FthgConverted", tx: `0x${"ce".repeat(32)}` } });
    const supply = ledger.summary().supply;
    store.linkWallet(guest.token, person.wallet.address.toLowerCase(), true);
    expect(ledger.balance(guestAccount).available).to.equal("0");
    expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("1204.172000000000000001", 18).toString());
    expect(store.read(guest.token, s => s.account.game.dollars)).to.equal(12041720);
    expect(store.wallet(guest.token)).to.equal(person.wallet.address.toLowerCase());
    store.linkWallet(guest.token, person.wallet.address.toLowerCase(), true);
    expect(ledger.summary().supply).to.equal(supply);
    expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("1204.172000000000000001", 18).toString());
  });
  it("recovers interrupted guest-to-wallet settlement without a second transfer", async () => {
    const guest = store.create(), wallet = ethers.Wallet.createRandom();
    const guestAccount = gameFundAccount("guest", store.chatSession(guest.token).owner);
    await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account: guestAccount, amount: ethers.parseUnits("20", 18).toString(),
      data: { src: "FthgConverted", tx: `0x${"cf".repeat(32)}` } });
    const commit = adapter.commit;
    adapter.commit = tx => { commit(tx); throw new Error("lost settlement receipt"); };
    expect(() => store.linkWallet(guest.token, wallet.address.toLowerCase(), true)).to.throw("unavailable");
    expect(ledger.balance(guestAccount).available).to.equal("0");
    adapter.commit = commit;
    store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
    expect(store.read(guest.token, s => s.account.game.dollars)).to.equal(200000);
    expect(ledger.balance(walletAccountId(wallet.address)).available).to.equal(ethers.parseUnits("20", 18).toString());
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
      expect((await post(identity, { ...body, moveGuestFunds: true })).status).to.equal(401);
      expect((await post(identity, { ...body, moveGuestFunds: "true" })).status).to.equal(400);
      expect((await fetch(`${base}/api/dollar/game/wallet/link`)).status).to.equal(405);
      expect((await fetch(`${base}/api/session`)).status).to.equal(404);
      const claimSignature = await wallet.signMessage(walletLinkMessage(wallet.address, identity.csrf, issuedAt, origin, true));
      const linked = await post(identity, { ...body, signature: claimSignature, moveGuestFunds: true });
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
  it("keeps the standalone Dollar wallet and World balance identical after sends and gameplay spending", async () => {
    const person = await player("100"), recipient = ethers.Wallet.createRandom();
    const api = createDollarApi({ ledger, env: {}, logger: { error() {}, warn() {} }, gold: { confirmations: 12 },
      beforeLedgerMutation: () => store.recoverFunds() });
    const assertBalance = expected => {
      expect(api.walletAccount(person.wallet.address).balance.available).to.equal(ethers.parseUnits(expected, 18).toString());
      expect(store.read(person.token, s => s.account.game.dollars / 10000)).to.equal(Number(expected));
    };
    assertBalance("100");
    const transfer = { wallet: person.wallet.address, to: walletAccountId(recipient.address), amount: ethers.parseUnits("12.3456", 18).toString(),
      nonce: 1, memo: "", issuedAt: new Date().toISOString() };
    transfer.signature = await person.wallet.signMessage(transferMessage(transfer));
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(transfer))]), {
      method: "POST", url: "/api/v1/dollar/fth/transfers", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    });
    const res = { status: 0, setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    await api.handle(req, res);
    expect(res.status).to.equal(200);
    assertBalance("87.6544");
    action(person, { type: "fund-pool", asset: "wood", quantity: 20, dollars: 10 });
    assertBalance("77.6544");
    expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
  });
  it("exports only the current authenticated World ledger account for read-only Dollar display", async () => {
      const identity = store.create(), account = gameFundAccount("guest", store.chatSession(identity.token).owner);
      const amount = ethers.parseUnits("1448.208100000000000001", 18).toString();
      await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account, amount,
        data: { src: "FthgConverted", tx: `0x${"da".repeat(32)}` } });
      const supply = ledger.summary().supply, origin = "http://world.localhost:8080";
      const server = createApi(store, origin, undefined, "dollar");
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${server.address().port}/api/dollar/game/wallet/balance`;
      const headers = { origin, cookie: `terra-dev=${identity.token}` };
      try {
        expect((await fetch(url)).status).to.equal(401);
        expect((await fetch(url, { headers: { ...headers, origin: "http://evil.test" } })).status).to.equal(403);
        expect((await fetch(url, { method: "POST", headers })).status).to.equal(405);
        const response = await fetch(url, { headers });
        expect(response.status).to.equal(200);
        expect(response.headers.get("cache-control")).to.equal("no-store");
        expect(await response.json()).to.deep.equal({ accountId: account, wallet: null, available: amount });
        expect(store.read(identity.token, s => s.account.game.dollars)).to.equal(14482081);
        expect(ledger.summary().supply).to.equal(supply);
        expect(store.wallet(identity.token)).to.equal(null);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    it("opts legacy wallets into separate World budgets without moving funds, then deposits and withdraws exactly once", async () => {
      const person = await player("100"), wrong = ethers.Wallet.createRandom();
      const walletAccount = walletAccountId(person.wallet.address), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      let view = store.fundView(person.token);
      expect(view.mode).to.equal("separate");
      expect(view.available).to.equal("0");
      expect(view.walletAvailable).to.equal(ethers.parseUnits("100", 18).toString());
      const supply = ledger.summary().supply;
      const deposit = { id: "separate-deposit-0001", direction: "deposit", amount: ethers.parseUnits("20.123400000000000001", 18).toString() };
      const prepared = store.prepareFund(person.token, deposit, origin);
      expect(store.prepareFund(person.token, deposit, origin)).to.deep.equal(prepared);
      expect(() => store.prepareFund(person.token, { ...deposit, amount: "1" }, origin)).to.throw("already bound");
      await expect(store.completeFund(person.token, deposit.id, await wrong.signMessage(prepared.message))).to.be.rejectedWith("authorized wallet");
      const signed = await person.wallet.signMessage(prepared.message);
      await store.completeFund(person.token, deposit.id, signed);
      await store.completeFund(person.token, deposit.id, signed);
      expect(store.fundView(person.token).available).to.equal(deposit.amount);
      expect(store.read(person.token, s => s.account.game.dollars)).to.equal(201234);
      expect(ledger.balance(walletAccount).available).to.equal(ethers.parseUnits("79.876599999999999999", 18).toString());
      const withdrawal = store.prepareFund(person.token, { id: "separate-withdraw-0001", direction: "withdraw", amount: deposit.amount }, origin);
      expect(withdrawal.message).to.include(person.wallet.address.toLowerCase());
      await store.completeFund(person.token, withdrawal.id, await person.wallet.signMessage(withdrawal.message));
      await store.completeFund(person.token, withdrawal.id, "");
      expect(store.fundView(person.token).available).to.equal("0");
      expect(ledger.balance(walletAccount).available).to.equal(ethers.parseUnits("100", 18).toString());
      expect(ledger.summary().supply).to.equal(supply);
      expect(() => store.prepareFund(person.token, { id: "empty-withdraw-0001", direction: "withdraw", amount: "1" }, origin)).to.throw("Insufficient");
    });
    it("recovers lost deposit and withdrawal receipts without issuing funds or replaying settlement", async () => {
      const person = await player("100"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const deposit = store.prepareFund(person.token, { id: "recover-world-deposit-0001", direction: "deposit", amount: ethers.parseUnits("30", 18).toString() }, origin);
      const transfer = adapter.transfer;
      adapter.transfer = async input => { await transfer(input); throw new Error("lost deposit receipt"); };
      const signed = await person.wallet.signMessage(deposit.message);
      await expect(store.completeFund(person.token, deposit.id, signed)).to.be.rejectedWith("lost deposit");
      adapter.transfer = transfer;
      await store.completeFund(person.token, deposit.id, signed);
      expect(store.fundView(person.token).available).to.equal(ethers.parseUnits("30", 18).toString());
      const withdrawal = store.prepareFund(person.token, { id: "recover-world-withdraw-0001", direction: "withdraw", amount: ethers.parseUnits("10", 18).toString() }, origin);
      const commit = adapter.commit;
      adapter.commit = tx => { commit(tx); throw new Error("lost withdrawal receipt"); };
      await expect(store.completeFund(person.token, withdrawal.id, await person.wallet.signMessage(withdrawal.message))).to.be.rejectedWith("unavailable");
      adapter.commit = commit;
      store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
      await store.completeFund(person.token, withdrawal.id, "");
      expect(store.fundView(person.token).available).to.equal(ethers.parseUnits("20", 18).toString());
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("80", 18).toString());
      expect(ledger.summary().supply).to.equal(ethers.parseUnits("100", 18).toString());
    });
    it("resumes a persisted signed deposit after restart and replays its ledger exactly once", async () => {
      const person = await player("10"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const input = { id: "restart-signed-deposit-01", direction: "deposit", amount: ethers.parseUnits("3", 18).toString() };
      const prepared = store.prepareFund(person.token, input, origin);
      const transfer = adapter.transfer;
      adapter.transfer = async () => { throw new Error("offline before acceptance"); };
      await expect(store.completeFund(person.token, input.id, await person.wallet.signMessage(prepared.message))).to.be.rejectedWith("offline");
      expect(store.fundView(person.token).requests[0]).not.to.have.property("signature");
      adapter.transfer = transfer;
      store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
      await store.completeFund(person.token, input.id, "");
      await store.completeFund(person.token, input.id, "invalid replay is only a receipt lookup");
      expect(() => store.prepareFund(person.token, input, "http://evil.test")).to.throw("already bound");
      const worldAccount = store.fundView(person.token).accountId;
      expect(store.read(person.token, s => s.account.game.dollars)).to.equal(30000);
      store.close(); ledger.close();
      const keys = gameSigningKey(directory);
      ledger = new FthLedger({ directory: path.join(directory, "ledger"), blockIntervalMs: 0 }).open();
      adapter = ledgerFunds(ledger, keys.privateKey);
      store = new SqliteStore(database, Date.now, 1, adapter);
      await store.completeFund(person.token, input.id, "");
      expect(ledger.balance(worldAccount).available).to.equal(input.amount);
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("7", 18).toString());
      expect(ledger.summary().supply).to.equal(ethers.parseUnits("10", 18).toString());
    });
    it("does not expose failed or unsealed native deposits to gameplay and retries the persisted signature", async () => {
      const person = await player("10"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const prepared = store.prepareFund(person.token, { id: "deposit-storage-failure-01", direction: "deposit", amount: ethers.parseUnits("2", 18).toString() }, origin);
      const signature = await person.wallet.signMessage(prepared.message), writeBlock = ledger.writeBlock;
      ledger.blockIntervalMs = 60000;
      ledger.writeBlock = () => { throw new Error("injected deposit disk failure"); };
      try {
        await expect(store.completeFund(person.token, prepared.id, signature)).to.be.rejectedWith("Block write failed");
      } finally { ledger.writeBlock = writeBlock; }
      expect(store.read(person.token, s => s.account.game.dollars)).to.equal(0);
      expect(ledger.pending).to.have.length(0);
      const retry = store.completeFund(person.token, prepared.id, "");
      expect(ledger.pending).to.have.length(0);
      await retry;
      expect(store.read(person.token, s => s.account.game.dollars)).to.equal(20000);
      expect(ledger.summary().supply).to.equal(ethers.parseUnits("10", 18).toString());
    });
    it("rejects malformed, excessive and cross-request withdrawals and recovers a pre-commit failure", async () => {
      const person = await player("10"), wrong = ethers.Wallet.createRandom(), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const account = store.fundView(person.token).accountId;
      await ledger.submit({ id: "fixture-withdrawal-tests", kind: "CREDIT", account, amount: "10",
        data: { src: "FthgConverted", tx: `0x${"da".repeat(32)}` } });
      const input = { id: "bounded-world-withdraw-01", direction: "withdraw", amount: "10" };
      for (const amount of ["0", "-1", "01", "1.5", "1e2", "9".repeat(79)])
        expect(() => store.prepareFund(person.token, { ...input, amount }, origin)).to.throw("Invalid");
      expect(() => store.prepareFund(person.token, { ...input, destination: wrong.address }, origin)).to.throw("Invalid");
      expect(() => store.prepareFund(person.token, { ...input, amount: "11" }, origin)).to.throw("Insufficient");
      const first = store.prepareFund(person.token, input, origin);
      const second = store.prepareFund(person.token, { ...input, id: "bounded-world-withdraw-02" }, origin);
      expect(first.message).to.include(origin).and.to.include(store.chatSession(person.token).csrf).and.to.include(account);
      await expect(store.completeFund(person.token, first.id, "0x")).to.be.rejectedWith("authorized wallet");
      await expect(store.completeFund(person.token, first.id, await wrong.signMessage(first.message))).to.be.rejectedWith("authorized wallet");
      await expect(store.completeFund(person.token, second.id, await person.wallet.signMessage(first.message))).to.be.rejectedWith("authorized wallet");
      const commit = adapter.commit;
      adapter.commit = () => { throw new Error("offline before withdrawal acceptance"); };
      await expect(store.completeFund(person.token, first.id, await person.wallet.signMessage(first.message))).to.be.rejectedWith("unavailable");
      expect(ledger.balance(account).available).to.equal("10");
      expect(() => store.read(person.token, s => s.account)).to.throw("unavailable");
      adapter.commit = commit;
      store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
      await store.completeFund(person.token, first.id, "");
      await expect(store.completeFund(person.token, second.id, await person.wallet.signMessage(second.message))).to.be.rejectedWith("Insufficient");
      expect(store.fundView(person.token).available).to.equal("0");
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal((ethers.parseUnits("10", 18) + 10n).toString());
      store.cancelFund(person.token, second.id);
      expect(store.fundView(person.token).requests.find(r => r.id === second.id).status).to.equal("cancelled");
    });
    it("deduplicates concurrent signed deposits without oversubscribing the World ceiling", async () => {
      const person = await player("10"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const account = store.fundView(person.token).accountId;
      const ceiling = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 10n ** 14n - 1n;
      await ledger.submit({ id: "fixture-concurrent-ceiling", kind: "CREDIT", account, amount: (ceiling - 1n).toString(),
        data: { src: "FthgConverted", tx: `0x${"db".repeat(32)}` } });
      const one = store.prepareFund(person.token, { id: "concurrent-deposit-01", direction: "deposit", amount: "1" }, origin);
      const two = store.prepareFund(person.token, { id: "concurrent-deposit-02", direction: "deposit", amount: "1" }, origin);
      const signature = await person.wallet.signMessage(one.message), otherSignature = await person.wallet.signMessage(two.message);
      const transfer = adapter.transfer;
      let release, calls = 0;
      const gate = new Promise(resolve => { release = resolve; });
      adapter.transfer = async payment => { calls++; await gate; return transfer(payment); };
      const first = store.completeFund(person.token, one.id, signature), retry = store.completeFund(person.token, one.id, signature);
      try {
        await expect(store.completeFund(person.token, two.id, otherSignature)).to.be.rejectedWith("World fund limit");
        expect(calls).to.equal(1);
      } finally { release(); adapter.transfer = transfer; }
      await Promise.all([first, retry]);
      expect(store.fundView(person.token).available).to.equal(ceiling.toString());
    });
    it("never replays a guest move against later credits or silently restores direct-wallet spending", async () => {
      const guest = store.create(), wallet = ethers.Wallet.createRandom();
      const account = gameFundAccount("guest", store.chatSession(guest.token).owner);
      await ledger.submit({ id: "fixture-guest-first", kind: "CREDIT", account, amount: "10",
        data: { src: "FthgConverted", tx: `0x${"dc".repeat(32)}` } });
      expect(() => store.linkWallet(guest.token, wallet.address.toLowerCase())).to.throw("explicit approval");
      expect(() => store.linkWallet(guest.token, wallet.address.toLowerCase(), true, true)).to.throw("cannot move");
      store.linkWallet(guest.token, wallet.address.toLowerCase(), true);
      await ledger.submit({ id: "fixture-guest-later", kind: "CREDIT", account, amount: "7",
        data: { src: "FthgConverted", tx: `0x${"dd".repeat(32)}` } });
      store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
      store.linkWallet(guest.token, wallet.address.toLowerCase(), true);
      expect(ledger.balance(account).available).to.equal("7");
      expect(ledger.balance(walletAccountId(wallet.address)).available).to.equal("10");
      store.linkWallet(guest.token, wallet.address.toLowerCase(), false, true);
      store.linkWallet(guest.token, wallet.address.toLowerCase(), false, false);
      expect(store.fundView(guest.token).mode).to.equal("separate");
      expect(store.fundView(guest.token).available).to.equal("7");
      expect(() => store.linkWallet(guest.token, wallet.address.toLowerCase(), true)).to.throw("explicit withdrawal");
    });
    it("fails closed when the signed native transfer primitive is unavailable", async () => {
      const person = await player("10");
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const transfer = adapter.transfer;
      adapter.transfer = undefined;
      try {
        expect(() => store.prepareFund(person.token, { id: "missing-native-primitive", direction: "deposit", amount: "1" },
          "http://world.localhost:8080")).to.throw("not configured");
        expect(store.fundView(person.token).available).to.equal("0");
      } finally { adapter.transfer = transfer; }
    });
    it("requires a durable deposit receipt rather than trusting a successful transport response", async () => {
      const person = await player("10"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const prepared = store.prepareFund(person.token, { id: "missing-durable-receipt", direction: "deposit", amount: "1" }, origin);
      const transfer = adapter.transfer;
      adapter.transfer = async () => ({ status: "accepted" });
      try {
        await expect(store.completeFund(person.token, prepared.id, await person.wallet.signMessage(prepared.message))).to.be.rejectedWith("no durable receipt");
        const view = store.fundView(person.token);
        expect(view.available).to.equal("0");
        expect(view.requests[0].status).to.equal("paying");
      } finally { adapter.transfer = transfer; }
      await store.completeFund(person.token, prepared.id, "");
      expect(store.fundView(person.token).available).to.equal("1");
    });
    it("bounds displayed history without forgetting replay receipts or limiting future transfers", async () => {
      const person = await player("10"), origin = "http://world.localhost:8080";
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      const first = store.prepareFund(person.token, { id: "history-first-deposit", direction: "deposit", amount: "1" }, origin);
      await store.completeFund(person.token, first.id, await person.wallet.signMessage(first.message));
      for (let index = 0; index < 110; index++) {
        const request = store.prepareFund(person.token, { id: `history-discarded-${index}`, direction: "withdraw", amount: "1" }, origin);
        store.cancelFund(person.token, request.id);
      }
      const view = store.fundView(person.token);
      expect(view.requests).to.have.length(100);
      expect(view.requests.some(request => request.id === first.id)).to.equal(false);
      await store.completeFund(person.token, first.id, "");
      expect(store.fundView(person.token).available).to.equal("1");
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal((ethers.parseUnits("10", 18) - 1n).toString());
    });
    it("keeps existing guest funds in World on separate authorization and never debits the wallet for gameplay", async () => {
      const person = await player("100"), guest = store.create();
      const account = gameFundAccount("guest", store.chatSession(guest.token).owner);
      await ledger.submit({ id: crypto.randomUUID(), kind: "CREDIT", account, amount: ethers.parseUnits("12", 18).toString(),
        data: { src: "FthgConverted", tx: `0x${"db".repeat(32)}` } });
      const wallet = ethers.Wallet.createRandom();
      store.linkWallet(guest.token, wallet.address.toLowerCase(), false, true);
      expect(store.fundView(guest.token).available).to.equal(ethers.parseUnits("12", 18).toString());
      expect(ledger.balance(walletAccountId(wallet.address)).available).to.equal("0");
      store.linkWallet(person.token, person.wallet.address.toLowerCase(), false, true);
      expect(() => action(person, { type: "fund-pool", asset: "wood", quantity: 20, dollars: 10 })).to.throw();
      expect(ledger.balance(walletAccountId(person.wallet.address)).available).to.equal(ethers.parseUnits("100", 18).toString());
      await expect(store.completeFund(person.token, "foreign-id-00000001", "0x")).to.be.rejectedWith("not found");
    });
});
