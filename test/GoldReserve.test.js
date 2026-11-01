const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { ethers } = require("ethers");
const { FthLedger, walletAccountId } = require("../services/fth-ledger/ledger");
const { canonical } = require("../services/fth-ledger/codec");
const { transferMessage } = require("../services/fth-ledger/transfer");
const { gameSigningKey, ledgerFunds, liquidityTargets } = require("../services/dollar-api/funds");
const { createReserveEngine, conversionMessage, RATE, TREASURY, REDEMPTION_ESCROW } = require("../services/gold-api/reserve");
const { createGoldApi, TOKEN_ADDRESS } = require("../services/gold-api/server");
const { createDollarApi } = require("../services/dollar-api/server");
const { activateLiveReserve } = require("../services/gold-api/activation");
const { SqliteStore } = require("../sites/world/featheral/server/store.ts");
const { createApi } = require("../sites/world/featheral/server/http.ts");

describe("Isolated finite Gold reserve", () => {
  let directory, ledger, engine, adapter, provider, goldKeys, gameKeys, source, reserve, store;
  const targets = liquidityTargets();
  const total = asset => BigInt(targets[asset].pricePerLot) * BigInt(targets[asset].quantity);
  const blockHash = height => ethers.zeroPadValue(ethers.toBeHex(height + 1), 32);
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "gold-reserve-"));
    goldKeys = gameSigningKey(path.join(directory, "gold"));
    gameKeys = gameSigningKey(path.join(directory, "game"));
    source = ethers.Wallet.createRandom(); reserve = ethers.Wallet.createRandom();
    const abi = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
    provider = {
      origin: ethers.parseUnits("1000000", 18), reserve: 0n, head: 100, chain: 1n, receipts: new Map(),
      async getNetwork() { return { chainId: this.chain }; },
      async getBlockNumber() { return this.head; },
      async getBlock(height) {
        const number = height === "finalized" ? this.head - 20 : height;
        return { number, hash: blockHash(number) };
      },
      async call(tx) {
        const [address] = abi.decodeFunctionData("balanceOf", tx.data);
        return abi.encodeFunctionResult("balanceOf", [address === source.address ? this.origin : this.reserve]);
      },
      async getTransactionReceipt(hash) { return this.receipts.get(hash); },
    };
    open();
  });
  function open() {
    ledger = new FthLedger({ directory: path.join(directory, "ledger"), blockIntervalMs: 0, genesis: {
      goldPublicKey: goldKeys.publicKey, gamePublicKey: gameKeys.publicKey,
      sourceWallet: source.address, reserveWallet: reserve.address, goldMarkets: targets,
    } }).open();
    engine = createReserveEngine({ ledger, privateKey: goldKeys.privateKey, provider, beforeMutation: () => store?.recoverFunds() });
    adapter = ledgerFunds(ledger, gameKeys.privateKey, engine);
  }
  afterEach(() => { store?.close(); store = undefined; ledger.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const fund = asset => engine.fundMarket(asset, targets[asset].quantity, total(asset));
  const pool = asset => `0x${crypto.createHash("sha256").update(`featheral:dollar:game:pool:${asset}`).digest("hex")}`;
  const move = (from, to, amount) => adapter.commit(adapter.prepare([
    { account: from, delta: (-amount).toString() }, { account: to, delta: amount.toString() },
  ]));
  function conserved() {
    assert.equal([...ledger.balances.values()].reduce((sum, entry) => sum + entry.balance, 0n), BigInt(ledger.summary().supply));
    const state = engine.status();
    assert.equal(BigInt(state.lockedRedemptionDollars), (BigInt(state.released) - BigInt(state.recycledIn)) * RATE);
  }
  async function reconcile(amount, incoming = true, overrides = {}) {
    provider.head = 200;
    if (incoming) { provider.origin -= amount; provider.reserve += amount; }
    else { provider.origin += amount; provider.reserve -= amount; }
    const hash = ethers.hexlify(crypto.randomBytes(32));
    const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const log = iface.encodeEventLog(iface.getEvent("Transfer"), incoming ? [source.address, reserve.address, amount] : [reserve.address, source.address, amount]);
    provider.receipts.set(hash, { status: 1, blockNumber: 150, blockHash: blockHash(150),
      logs: [{ index: 0, address: TOKEN_ADDRESS, ...log }], ...overrides });
    return { hash, result: await engine.reconcile(hash, 0) };
  }
  async function redemption(amount, wallet = source) {
    const transfer = { wallet: wallet.address, to: REDEMPTION_ESCROW, amount: amount.toString(),
      nonce: ledger.nonce(walletAccountId(wallet.address)) + 1, memo: `Gold:${ledger.headers[0].H.slice(2, 58)}`, issuedAt: new Date().toISOString() };
    transfer.signature = await wallet.signMessage(transferMessage(transfer));
    return transfer;
  }
  function signedGold(id, data, keys = goldKeys) {
    const tx = { i: id, k: "GOLD", a: "", v: "0", d: data, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(canonical(tx)), keys.privateKey).toString("base64");
    return tx;
  }
  it("freezes finalized origin holdings once, including zero; rejects wrong chains and forged authority", async () => {
    provider.chain = 2n;
    await assert.rejects(engine.initialize(), /Mainnet/);
    provider.chain = 1n;
    provider.origin = 0n;
    await engine.initialize();
    provider.origin = 1000n;
    assert.equal((await engine.initialize()).cap, "0");
    assert.equal(engine.status().exhausted, true);
    const attacker = gameSigningKey(path.join(directory, "attacker"));
    assert.throws(() => ledger.commitAuthorized(signedGold("bad", { op: "initialize", cap: "1000", rate: "1000", evidence: { block: 1, hash: blockHash(1) } }, attacker)), /signature/);
    await assert.rejects(ledger.submit({ id: "credit", kind: "CREDIT", account: pool("wood"), amount: "1", data: { src: "FthgConverted", tx: blockHash(1) } }), /issuance/);
    assert.equal(await fund("wood"), null);
  });
  it("pages reserve history without confusing obligations, receipts or treasury-only funding", async () => {
    assert.deepEqual(engine.activity().items, []);
    assert.equal(engine.activity().nextCursor, null);
    await engine.initialize();
    assert.equal(engine.activity().items.length, 0);
    await fund("wood");
    const dollars = total("wood"), fthg = dollars / RATE;
    move(pool("wood"), walletAccountId(source.address), dollars);
    const incoming = await reconcile(fthg);
    await engine.redeem(await redemption(dollars));
    const outgoing = await reconcile(fthg, false);
    const request = { amount: fthg.toString(), nonce: 1, issuedAt: new Date().toISOString() };
    request.signature = await source.signMessage(conversionMessage(request, ledger.headers[0].H, source.address, reserve.address));
    await engine.convert(request);
    const full = engine.activity();
    assert.deepEqual(full.items.map(item => item.operation), ["convert", "sync", "redeem", "sync", "fund-market"]);
    assert.equal(full.nextCursor, null);
    assert.equal(full.items[0].fthg, fthg.toString());
    assert.equal(full.items[0].dollars, dollars.toString());
    assert.equal(full.items[0].recordType, "off-chain-obligation");
    assert.equal(full.items[1].ethereumTx, outgoing.hash);
    assert.equal(full.items[1].direction, "reserve-to-origin");
    assert.equal(full.items[1].dollars, "0");
    assert.equal(full.items[2].direction, "reserve-to-origin");
    assert.equal(full.items[2].recordType, "off-chain-obligation");
    assert.equal(full.items[3].ethereumTx, incoming.hash);
    assert.equal(full.items[3].recordType, "ethereum-confirmed");
    assert.equal(full.items[4].ethereumTx, null);
    assert.equal(full.items[4].from, source.address);
    assert.equal(full.items[4].to, reserve.address);
    assert.ok(full.items.every(item => ethers.isHexString(item.hash, 32) && Number.isFinite(Date.parse(item.time))));
    const pages = [];
    let cursor;
    do {
      const page = engine.activity({ limit: 1, cursor });
      pages.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pages, full.items);
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "-1:0" }, { cursor: "999999:0" }, { cursor: "0:999999" }]) {
      assert.throws(() => engine.activity(query), error => error.status === 400);
    }
    adapter.commit(adapter.prepare([{ account: walletAccountId(source.address), delta: (-dollars).toString() }]));
    await fund("water");
    const treasury = engine.activity({ limit: 1 }).items[0];
    assert.equal(treasury.fthg, "0");
    assert.equal(treasury.treasuryDollars, treasury.dollars);
    assert.equal(treasury.recordType, "treasury-circulation");
    assert.equal(treasury.direction, "treasury-to-market");
    assert.equal(treasury.from, TREASURY);
    assert.equal(treasury.to, pool("water"));
  });
  it("bounds history scans and advances through pages containing no reserve transactions", async function () {
    this.timeout(15000);
    await engine.initialize(); await fund("wood");
    for (let i = 0; i < 2001; i++) adapter.commit(adapter.prepare([{ account: pool("wood"), delta: "-1" }]));
    const empty = engine.activity();
    assert.equal(empty.items.length, 0);
    assert.ok(empty.nextCursor);
    const older = engine.activity({ cursor: empty.nextCursor });
    assert.equal(older.items.length, 1);
    assert.equal(older.items[0].operation, "fund-market");
    assert.equal(older.nextCursor, null);
  });
  it("activates an existing unused live ledger without rewriting its genesis or losing history", async () => {
    ledger.close();
    ledger = new FthLedger({ directory: path.join(directory, "existing-live"), blockIntervalMs: 0,
      genesis: { gamePublicKey: gameKeys.publicKey, sourceWallet: source.address, reserveWallet: reserve.address } }).open();
    const genesis = ledger.tipHash;
    activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets);
    assert.equal(ledger.headers[0].H, genesis);
    assert.equal(ledger.height, 1);
    engine = createReserveEngine({ ledger, privateKey: goldKeys.privateKey, provider });
    await engine.initialize(); await fund("wood");
    assert.equal(engine.status().mode, "live");
    const supply = ledger.summary().supply;
    activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets);
    ledger.close();
    ledger = new FthLedger({ directory: path.join(directory, "existing-live"), blockIntervalMs: 0 }).open();
    assert.equal(ledger.genesis.reserveMode, "live");
    assert.equal(ledger.summary().supply, supply);
    assert.equal(ledger.headers[0].H, genesis);
  });
  it("refuses live activation of a previously issued ledger or a different authority", async () => {
    ledger.close();
    ledger = new FthLedger({ directory: path.join(directory, "used-live"), blockIntervalMs: 0,
      genesis: { gamePublicKey: gameKeys.publicKey } }).open();
    await ledger.submit({ id: "existing-credit", kind: "CREDIT", account: pool("wood"), amount: "1", data: { src: "FthgConverted", tx: blockHash(1) } });
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets), /unused zero-supply/);
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets), /unused zero-supply/);
  });
  it("caps bootstrap at exactly 10,000 lots, is concurrent/idempotent, and replays after restart", async () => {
    await engine.initialize();
    const initial = engine.status().cap;
    const seeds = await Promise.all([fund("wood"), fund("wood"), fund("wood")]);
    assert.equal(seeds[0].quantity, 10000);
    assert.equal(ledger.summary().supply, total("wood").toString());
    assert.equal(engine.status().allocated, (total("wood") / RATE).toString());
    assert.equal(ledger.accountHistory(pool("wood"))[0].goldDelta, total("wood").toString());
    await assert.rejects(engine.fundMarket("wood", 10001, total("wood")), /target/);
    await assert.rejects(engine.fundMarket("unknown", 10000, total("wood")), /eligible/);
    await assert.rejects(engine.fundMarket("water", 0, 0n), /target/);
    await assert.rejects(engine.fundMarket("water", 10000, 10000n), /eligible/);
    const before = engine.status();
    ledger.close(); open();
    assert.deepEqual(engine.status(), before);
    provider.origin *= 2n;
    await engine.initialize(); await fund("wood");
    assert.equal(engine.status().cap, initial);
    conserved();
  });
  it("uses treasury before origin, then makes only affordable whole lots without automatic refills", async () => {
    provider.origin = total("wood") / RATE;
    await engine.initialize(); await fund("wood");
    const available = total("wood") / 4n;
    adapter.commit(adapter.prepare([{ account: pool("wood"), delta: (-available).toString() }]));
    const seed = await fund("water");
    assert.equal(seed.quantity, Number(available / BigInt(targets.water.pricePerLot)));
    assert.equal(ledger.summary().supply, total("wood").toString());
    assert.equal(engine.status().exhausted, true);
    assert.equal(await fund("metal"), null);
    assert.deepEqual(await fund("water"), seed);
    conserved();
  });
  it("recovers persistence failures without duplicate allocations", async () => {
    await engine.initialize();
    const append = ledger.store.append;
    ledger.store.append = () => { throw new Error("isolated disk failure"); };
    await assert.rejects(fund("wood"), /persisted/);
    assert.equal(ledger.summary().supply, "0");
    ledger.store.append = append;
    await fund("wood"); await fund("wood");
    conserved();
  });
  it("uses the exact finite budget for a partial seed, never exceeding the minimum or cap", async () => {
    provider.origin = BigInt(targets.wood.pricePerLot) * 3n / RATE;
    await engine.initialize();
    assert.equal((await fund("wood")).quantity, 3);
    assert.equal(engine.status().remaining, "0");
    assert.equal(ledger.summary().supply, (3n * BigInt(targets.wood.pricePerLot)).toString());
    assert.equal(await fund("water"), null);
    conserved();
  });
  it("rejects alternate issuance, legacy withdrawals, burns and direct redemption escrow transfers", async () => {
    await engine.initialize(); await fund("wood");
    await assert.rejects(ledger.submit({ id: "legacy-reserve", kind: "RESERVE", account: pool("wood"), amount: "1", data: {} }), /legacy bridge/);
    const amount = ethers.parseUnits("1", 18);
    move(pool("wood"), walletAccountId(source.address), amount);
    const transfer = await redemption(amount);
    await assert.rejects(ledger.submit({ id: "direct-escrow", kind: "TRANSFER", account: walletAccountId(source.address), amount: amount.toString(),
      data: { w: source.address, to: transfer.to, n: transfer.nonce, m: transfer.memo, ts: transfer.issuedAt, sig: transfer.signature } }), /Gold-authorized/);
    const entries = [{ account: pool("wood"), delta: "-1" }];
    const tx = { i: "burn", k: "GAME", a: "", v: "1", d: { entries }, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(canonical({ i: tx.i, k: tx.k, a: tx.a, v: tx.v, entries, t: tx.t })), gameKeys.privateKey).toString("base64");
    assert.throws(() => ledger.commitGame(tx), /cannot burn/);
    assert.throws(() => ledger.commitAuthorized(signedGold("increase-cap", { op: "initialize", cap: (provider.origin * 2n).toString(), rate: "1000", evidence: { block: 150, hash: blockHash(150) } })), /cannot be increased/);
    const attacker = ethers.Wallet.createRandom();
    await assert.rejects(engine.redeem(await redemption(amount, attacker)), /two configured wallets/);
    conserved();
  });
  it("blocks unsynced redemption and locks returned Dollars until confirmed FTHG is reconverted", async () => {
    provider.origin = total("wood") / RATE;
    await engine.initialize(); await fund("wood");
    const amount = total("wood"), fthg = amount / RATE;
    move(pool("wood"), walletAccountId(source.address), amount);
    const transfer = await redemption(amount);
    await assert.rejects(engine.redeem(transfer), /confirmed/);
    const incoming = await reconcile(BigInt(engine.status().pendingIn));
    await engine.reconcile(incoming.hash, 0);
    await engine.redeem(transfer); await engine.redeem(transfer);
    assert.equal(ledger.balance(REDEMPTION_ESCROW).available, amount.toString());
    assert.equal(ledger.balance(TREASURY).available, "0");
    assert.equal(await fund("water"), null);
    assert.throws(() => adapter.prepare([{ account: REDEMPTION_ESCROW, delta: "-1" }]), /treasury/);
    const request = { amount: fthg.toString(), nonce: 1, issuedAt: new Date().toISOString() };
    request.signature = await source.signMessage(conversionMessage(request, ledger.headers[0].H, source.address, reserve.address));
    await assert.rejects(engine.convert(request), /origin holdings/);
    await reconcile(fthg, false);
    await engine.convert(request); await engine.convert(request);
    await assert.rejects(engine.convert({ ...request, amount: "1" }), /conflicts/);
    assert.equal(ledger.balance(REDEMPTION_ESCROW).available, "0");
    assert.equal(ledger.balance(walletAccountId(source.address)).available, amount.toString());
    assert.equal(ledger.summary().supply, total("wood").toString());
    assert.equal(engine.status().pendingIn, fthg.toString());
    await assert.rejects(engine.redeem(await redemption(amount)), /confirmed/);
    await reconcile(fthg);
    await engine.redeem(await redemption(amount));
    conserved();
    const state = engine.status(); ledger.close(); open(); assert.deepEqual(engine.status(), state);
  });
  it("rejects missing, unfinalized, wrong-token and noncanonical receipts without settlement", async () => {
    await engine.initialize(); await fund("wood");
    const hash = ethers.hexlify(crypto.randomBytes(32)), amount = BigInt(engine.status().pendingIn);
    await assert.rejects(engine.reconcile(hash, 0), /missing/);
    const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const log = iface.encodeEventLog(iface.getEvent("Transfer"), [source.address, reserve.address, amount]);
    const receipt = { status: 1, blockNumber: 99, blockHash: blockHash(99), logs: [{ index: 0, address: TOKEN_ADDRESS, ...log }] };
    provider.receipts.set(hash, receipt);
    await assert.rejects(engine.reconcile(hash, 0), /finalized/);
    provider.head = 200; receipt.blockHash = ethers.ZeroHash;
    await assert.rejects(engine.reconcile(hash, 0), /canonical/);
    receipt.blockHash = blockHash(99); receipt.logs[0].address = source.address;
    await assert.rejects(engine.reconcile(hash, 0), /canonical FTHG/);
    receipt.logs[0].address = TOKEN_ADDRESS;
    await assert.rejects(engine.reconcile(hash, 0), /does not hold/);
    assert.equal(engine.status().settledIn, "0");
    conserved();
  });
  it("rejects old, wrong-wallet and oversized transfer evidence", async () => {
    await engine.initialize(); await fund("wood");
    const amount = BigInt(engine.status().pendingIn);
    await assert.rejects(reconcile(amount, true, { blockNumber: 70, blockHash: blockHash(70) }), /predates/);
    provider.origin += amount; provider.reserve -= amount;
    await assert.rejects(reconcile(amount + 1n), /exceeds/);
    assert.equal(engine.status().settledIn, "0");
    const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const log = iface.encodeEventLog(iface.getEvent("Transfer"), [source.address, ethers.Wallet.createRandom().address, amount]);
    const hash = ethers.hexlify(crypto.randomBytes(32));
    provider.receipts.set(hash, { status: 1, blockNumber: 150, blockHash: blockHash(150), logs: [{ index: 0, address: TOKEN_ADDRESS, ...log }] });
    await assert.rejects(engine.reconcile(hash, 0), /configured wallets/);
    conserved();
  });
  it("composes Gold, Dollar funding and World HTTP with zero personal grants and one seed across SQLite restarts", async () => {
    const gold = createGoldApi({ provider, logger: { error() {} } });
    const reserveApi = gold.enableReserve(ledger, goldKeys.privateKey);
    const dollar = createDollarApi({ ledger, gold, env: { FTH_LEDGER_MODE: "writer" }, logger: { error() {} }, beforeLedgerMutation: () => store?.recoverFunds() });
    await reserveApi.initialize();
    adapter = ledgerFunds(ledger, gameKeys.privateKey, reserveApi);
    const database = path.join(directory, "game.sqlite");
    store = new SqliteStore(database, Date.now, 1, adapter);
    const identity = store.create();
    store.transaction(identity.token, s => { s.account.game.stage = 0; s.account.game.home = { ...s.account.game.position }; });
    const origin = "http://127.0.0.1";
    const game = createApi(store, origin, undefined, "dollar");
    const server = http.createServer(async (req, res) => {
      if (!await gold.handle(req, res) && !await dollar.handle(req, res)) game.emit("request", req, res);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { cookie: `terra-dev=${identity.token}` };
      const first = await fetch(`${base}/api/dollar/game/market?asset=wood&quantity=1`, { headers });
      assert.equal(first.status, 200, await first.text());
      assert.equal(store.read(identity.token, s => s.account.game.dollars), 0);
      const balance = ledger.summary().supply;
      const stats = await (await fetch(`${base}/api/v1/dollar/stats`)).json();
      assert.equal(stats.fthDollar.supply, balance);
      assert.equal(stats.monetaryPolicy.finiteInitialAllocationEnabled, true);
      assert.equal(stats.monetaryPolicy.issuanceEnabled, false);
      assert.equal((await fetch(`${base}/api/dollar/game/market?asset=wood&quantity=1`, { headers })).status, 200);
      assert.equal(ledger.summary().supply, balance);
      const body = JSON.stringify({ id: crypto.randomUUID(), revision: store.read(identity.token, s => s.account.revision),
        command: { type: "limit", asset: "water", side: "sell", quantity: 1, price: 2 } });
      const postHeaders = { ...headers, origin, "content-type": "application/json", "x-csrf-token": "incorrect" };
      assert.equal((await fetch(`${base}/api/dollar/game/market/actions`, { method: "POST", headers: postHeaders, body })).status, 403);
      assert.equal(reserveApi.status().pools.water, undefined);
      postHeaders["x-csrf-token"] = identity.csrf;
      const trade = await fetch(`${base}/api/dollar/game/market/actions`, { method: "POST", headers: postHeaders, body });
      assert.equal(trade.status, 200, await trade.text());
      assert.equal(reserveApi.status().pools.water.quantity, 10000);
      assert.equal(store.read(identity.token, s => s.account.game.dollars), 0);
      assert.equal((await fetch(`${base}/api/dollar/game/market/half`, { headers })).status, 200);
      assert.equal(Object.keys(reserveApi.status().pools).length, 4);
      const units = store.db.prepare("SELECT units FROM market_pools WHERE asset='wood'").get().units;
      store.close(); store = new SqliteStore(database, Date.now, 1, adapter);
      assert.equal(store.db.prepare("SELECT units FROM market_pools WHERE asset='wood'").get().units, units);
      const plan = await (await fetch(`${base}/api/v1/gold/reserve/sync-plan`)).json();
      assert.equal(plan.ethereumSyncEnabled, false);
      assert.equal(plan.transfers.length, 1);
      const activity = await (await fetch(`${base}/api/v1/gold/reserve/activity?limit=1`)).json();
      assert.equal(activity.items.length, 1);
      assert.ok(activity.nextCursor);
      const older = await (await fetch(`${base}/api/v1/gold/reserve/activity?cursor=${activity.nextCursor}`)).json();
      assert.equal(older.items.length, 3);
      for (const query of ["limit=0", "limit=101", "cursor=bad", "cursor=999999:0", "limit=1&limit=2", "extra=1"]) {
        assert.equal((await fetch(`${base}/api/v1/gold/reserve/activity?${query}`)).status, 400, query);
      }
      const bad = await fetch(`${base}/api/v1/gold/reserve/convert`, { method: "POST", body: "null" });
      assert.equal(bad.status, 400);
    } finally { await new Promise(resolve => server.close(resolve)); game.emit("close"); gold.close(); }
  });
  it("rejects unsafe isolation paths and exits nonzero when reserve initialization fails", function () {
    this.timeout(15000);
    const root = path.join(__dirname, ".."), isolated = path.join(root, "data", "reserve-tests", `automated-${crypto.randomUUID()}`);
    const env = { ...process.env, HOST: "127.0.0.1", PORT: "18088", APP_ORIGIN: "http://world.localhost:18088",
      GOLD_RESERVE_MODE: "isolated", GOLD_API_RPC_URL: "http://127.0.0.1:1" };
    const unsafe = spawnSync(process.execPath, [path.join(root, "scripts", "serve.js")], { env: { ...env, GOLD_RESERVE_TEST_DIR: path.join(root, "data") }, encoding: "utf8", timeout: 10000 });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /named directory/);
    try {
      const failed = spawnSync(process.execPath, [path.join(root, "scripts", "serve.js")], { env: { ...env, GOLD_RESERVE_TEST_DIR: isolated }, encoding: "utf8", timeout: 10000 });
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /Server initialization failed/);
      assert.equal(fs.readFileSync(path.join(isolated, "isolated-reserve.json"), "utf8"), '{"isolatedReserve":true}\n');
      const junction = path.join(isolated, "external");
      fs.symlinkSync(directory, junction, process.platform === "win32" ? "junction" : "dir");
      try {
        const linked = spawnSync(process.execPath, [path.join(root, "scripts", "serve.js")], { env: { ...env, GOLD_RESERVE_TEST_DIR: isolated }, encoding: "utf8", timeout: 10000 });
        assert.notEqual(linked.status, 0);
        assert.match(linked.stderr, /cannot contain links/);
      } finally { fs.unlinkSync(junction); }
    } finally {
      if (fs.existsSync(isolated)) fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
  it("shares exact wallet signing text and never submits Ethereum writes from the isolated UI", () => {
    const context = { window: {}, ethers };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "sites", "shared", "dollar-transfer.js"), "utf8"), context);
    for (const to of [REDEMPTION_ESCROW, walletAccountId(reserve.address), reserve.address]) {
      const transfer = { wallet: source.address.toLowerCase(), to, amount: "1000000000000000000", nonce: 1, memo: "", issuedAt: new Date().toISOString() };
      assert.equal(context.window.FeatheralDollarTransferMessage(transfer), transferMessage({ ...transfer, wallet: source.address, to: ethers.isAddress(to) ? walletAccountId(to) : to }));
    }
    const ui = fs.readFileSync(path.join(__dirname, "..", "sites", "gold", "conversion", "reserve.js"), "utf8");
    assert.match(ui, /WARNING: this is an isolated test journal/);
    assert.doesNotMatch(ui, /sendTransaction|eth_sendTransaction|eth_sendRawTransaction/);
    assert.match(ui, /chainId\) !== 1/);
  });
  it("formats reserve FTH$ amounts at most two decimals and wires both focused Gold pages", () => {
    const context = { window: {}, ethers };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "sites", "gold", "reserve-view.js"), "utf8"), context);
    assert.equal(context.window.FeatheralReserveView.units(ethers.parseUnits("216265000.123456789123456789", 18)), "216,265,000.123456789123456789");
    for (const [value, expected] of [["0", "0"], ["1.9999", "2"], ["3.9596", "3.96"], ["1000.1", "1,000.1"], ["0.009", "0.01"]]) {
      assert.equal(context.window.FeatheralReserveView.dollars(ethers.parseUnits(value, 18)), expected);
    }
    for (const page of ["admin", "conversion"]) {
      const html = fs.readFileSync(path.join(__dirname, "..", "sites", "gold", page, "index.html"), "utf8");
      for (const id of ["sync-state", "origin-flow", "reserve-flow", "reserve-metrics", "reserve-mode", "reserve-transactions", "history-more", "history-status"]) {
        assert.ok(html.includes(`id="${id}"`), `${page}: ${id}`);
      }
      assert.match(html, /class="top gold-header"/);
      assert.match(html, /src="\/reserve-view.js"/);
      assert.match(html, /href="\/reserve.css"/);
    }
    const admin = fs.readFileSync(path.join(__dirname, "..", "sites", "gold", "admin", "app.js"), "utf8");
    assert.doesNotMatch(admin, /setRate|setTreasury|addLiquidity|swapExact|localStorage|setExchangeEnabled/);
    assert.match(admin, /staticCall/);
    assert.match(admin, /token\.hasRole\(roles\[role\], account\)/);
  });
  it("enforces actual roles, Mainnet, simulation and wallet revalidation before token safety writes", async () => {
    await engine.initialize();
    const script = fs.readFileSync(path.join(__dirname, "..", "sites", "gold", "admin", "app.js"), "utf8");
    for (const scenario of ["success", "no-role", "wrong-chain", "simulation-fails", "chain-changed", "cancelled"]) {
      const elements = new Map(), calls = [];
      const element = id => {
        if (!elements.has(id)) elements.set(id, { value: id.endsWith("-action") ? "check" : "", dataset: {}, listeners: {},
          addEventListener(name, listener) { this.listeners[name] = listener; }, replaceChildren() {} });
        return elements.get(id);
      };
      const pause = async () => { calls.push("write"); return { hash: blockHash(1), wait: async () => ({ status: 1 }) }; };
      pause.staticCall = async () => { calls.push("simulate"); if (scenario === "simulation-fails") throw new Error("Simulation rejected."); };
      const token = { paused: async () => false, metadataURI: async () => "https://example.test/metadata",
        hasRole: async () => scenario !== "no-role", connect() { return this; }, pause };
      const wallet = { request: async () => scenario === "chain-changed" ? "0x2" : "0x1" };
      const context = {
        location: { origin: "http://gold.localhost" },
        document: { getElementById: element, createElement: () => ({}) },
        confirm: () => scenario !== "cancelled",
        ethers: { ...ethers, Contract: function () { return token; },
          JsonRpcProvider: function () { return { getBlockNumber: async () => 100 }; },
          BrowserProvider: function () { return { getNetwork: async () => ({ chainId: scenario === "wrong-chain" ? 2n : 1n }),
            getSigner: async () => ({ getAddress: async () => source.address }) }; } },
        window: { FeatheralReserveView: { api: async () => engine.status(), render() {}, history: () => async () => {} },
          FeatheralSites: { url: () => "http://dollar.localhost/wallet/" },
          FeatheralProfile: { mount() {}, snapshot: () => ({ account: source.address, chainId: 1 }), getProvider: () => wallet },
          addEventListener() {} },
      };
      vm.runInNewContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      await element("token-pause").listeners.click();
      assert.deepEqual(calls, scenario === "success" ? ["simulate", "write"]
        : ["simulation-fails", "chain-changed"].includes(scenario) ? ["simulate"] : [], scenario);
      if (!["success", "cancelled"].includes(scenario)) {
        assert.equal(element("safety-status").dataset.error, "true", scenario);
        assert.ok(element("safety-status").textContent, scenario);
      }
    }
  });
});
