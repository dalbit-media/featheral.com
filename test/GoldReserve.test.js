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
const { gameSigningKey, ledgerFunds, liquidityTargets } = require("../services/notes/game-funds");
const { createReserveEngine, conversionMessage, RATE, TREASURY, REDEMPTION_ESCROW } = require("../services/gold/reserve");
const pricing = require("../shared/gold-pricing");
const { createGoldApi, reconciliationMessage, TOKEN_ADDRESS } = require("../services/gold/server");
const { createDollarApi } = require("../services/notes/dollar");
const { activateLiveReserve } = require("../services/gold/activation");
const { approvedMarkets } = require("../services/gold/market-expansion");
const { SqliteStore } = require("../sites/world.featheral.com/play/server/store.ts");
const { createApi } = require("../sites/world.featheral.com/play/server/http.ts");

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
    const tx = { i: id, k: "GOLD", a: "", v: "0", d: { ...data }, t: Date.now() };
    tx.d.signature = crypto.sign(null, Buffer.from(canonical(tx)), keys.privateKey).toString("base64");
    return tx;
  }
  it("authorizes additive markets with both original keys, preserves funds and replays without rewriting genesis", async () => {
    ledger.close();
    const originalTargets = Object.fromEntries(Object.entries(targets).filter(([asset]) => !Object.hasOwn(approvedMarkets, asset)));
    const folder = path.join(directory, "market-expansion");
    ledger = new FthLedger({ directory: folder, blockIntervalMs: 0, genesis: {
      goldPublicKey: goldKeys.publicKey, gamePublicKey: gameKeys.publicKey, reserveMode: "live",
      sourceWallet: source.address, reserveWallet: reserve.address, goldMarkets: originalTargets,
    } }).open();
    engine = createReserveEngine({ ledger, privateKey: goldKeys.privateKey, provider });
    await engine.initialize(); await fund("wood");
    const originalGenesis = ledger.headers[0].H, reserveState = structuredClone(ledger.goldReserve);
    const supply = ledger.summary().supply, balances = structuredClone([...ledger.balances]);
    const before = ledger.height;
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets), /approved additive/);
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, {
      ...targets, wood: { ...targets.wood, quantity: 9999 },
    }, goldKeys.privateKey), /approved additive/);
    assert.throws(() => activateLiveReserve(ledger, goldKeys.privateKey, goldKeys.publicKey, targets, goldKeys.privateKey), /both original/);
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets, gameKeys.privateKey), /both original/);
    assert.equal(ledger.height, before);
    const expansion = (data, sign = true) => {
      const tx = { i: `expansion:${crypto.randomUUID()}`, k: "GOLD_MARKETS", a: "", v: "0", d: data, t: Date.now() };
      if (sign) {
        const message = Buffer.from(canonical(tx));
        tx.d.gameSignature = crypto.sign(null, message, gameKeys.privateKey).toString("base64");
        tx.d.goldSignature = crypto.sign(null, message, goldKeys.privateKey).toString("base64");
      }
      return tx;
    };
    assert.throws(() => ledger.commitAuthorized(expansion({ goldMarkets: targets, previousTip: blockHash(1) })), /both original/);
    assert.throws(() => ledger.commitAuthorized(expansion({ goldMarkets: targets, previousTip: ledger.tipHash }, false)), /both original/);
    assert.throws(() => ledger.commitAuthorized(expansion({ goldMarkets: targets, previousTip: ledger.tipHash, cap: "999" })), /both original/);
    const altered = expansion({ goldMarkets: { ...targets }, previousTip: ledger.tipHash });
    altered.d.goldMarkets["title-pioneer"] = { quantity: 10000, pricePerLot: "1000000000000000000" };
    assert.throws(() => ledger.commitAuthorized(altered), /both original/);
    activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets, goldKeys.privateKey, { deferExpansion: true });
    assert.equal(ledger.height, before, "deployment health checks must precede any durable authorization");
    assert.deepEqual(ledger.genesis.goldMarkets, originalTargets);
    assert.deepEqual(ledger.goldReserve, reserveState);
    activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets, goldKeys.privateKey);
    assert.equal(ledger.height, before + 1);
    assert.equal(ledger.headers[0].H, originalGenesis);
    assert.deepEqual(ledger.genesis.goldMarkets, targets);
    assert.equal(ledger.summary().supply, supply);
    assert.deepEqual([...ledger.balances], balances);
    assert.deepEqual(ledger.goldReserve, reserveState);
    activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, targets, goldKeys.privateKey);
    assert.equal(ledger.height, before + 1, "retry must not authorize twice");
    assert.throws(() => activateLiveReserve(ledger, gameKeys.privateKey, goldKeys.publicKey, originalTargets, goldKeys.privateKey), /approved additive/);
    ledger.close();
    ledger = new FthLedger({ directory: folder, blockIntervalMs: 0 }).open();
    assert.equal(ledger.headers[0].H, originalGenesis);
    assert.deepEqual(ledger.genesis.goldMarkets, targets);
    assert.deepEqual(ledger.goldReserve, reserveState);
    engine = createReserveEngine({ ledger, privateKey: goldKeys.privateKey, provider });
    const result = await fund("collector-all-52");
    assert.equal(result.quantity, 10000);
    assert.equal(ledger.goldReserve.cap, reserveState.cap);
    assert.deepEqual(ledger.goldReserve.pools.wood, reserveState.pools.wood);
    assert.equal(ledger.balance(REDEMPTION_ESCROW).available, "0");
    conserved();
    const reader = new FthLedger({ directory: folder, mode: "reader" }).open();
    try { assert.deepEqual(reader.genesis.goldMarkets, targets); assert.equal(reader.summary().supply, ledger.summary().supply); }
    finally { reader.close(); }
  });
  it("rejects stale, unsigned or unauthorized market expansion transactions atomically", () => {
    const original = ledger.genesis.goldMarkets;
    const tx = { i: "invalid-market-expansion", k: "GOLD_MARKETS", a: "", v: "0",
      d: { goldMarkets: { ...original, "title-admin": { quantity: 10000, pricePerLot: "1000000000000000000" } }, previousTip: ledger.tipHash }, t: Date.now() };
    const message = Buffer.from(canonical(tx));
    tx.d.gameSignature = crypto.sign(null, message, gameKeys.privateKey).toString("base64");
    tx.d.goldSignature = crypto.sign(null, message, goldKeys.privateKey).toString("base64");
    const height = ledger.height, supply = ledger.summary().supply;
    assert.throws(() => ledger.commitAuthorized(tx), /both original/);
    assert.equal(ledger.height, height); assert.equal(ledger.summary().supply, supply);
    assert.deepEqual(ledger.genesis.goldMarkets, original);
  });
  it("replays historical treasury-only refills without changing prior supply or balances", async () => {
    await engine.initialize();
    await fund("wood");
    const amount = total("wood") * 9n / 10n;
    adapter.commit(adapter.prepare([{ account: pool("wood"), delta: (-amount).toString() }]));
    const supply = ledger.summary().supply, allocated = engine.status().allocated;
    const escrow = ledger.balance(REDEMPTION_ESCROW);
    const pending = { op: "refill-market", asset: "wood", account: pool("wood"), dollars: amount.toString() };
    assert.throws(() => ledger.commitAuthorized(signedGold("wrong-key", pending, gameKeys)), /signature/);
    assert.throws(() => ledger.commitAuthorized(signedGold("wrong-pool", { ...pending, account: walletAccountId(source.address) })), /initialized resource/);
    assert.throws(() => ledger.commitAuthorized(signedGold("over-budget", { ...pending, dollars: (amount + 10n ** 14n).toString() })), /limit/);
    assert.throws(() => adapter.prepare([{ account: TREASURY, delta: (-amount).toString() },
      { account: pool("wood"), delta: amount.toString() }]), /treasury/);
    const refill = signedGold("historical-refill", pending);
    ledger.commitAuthorized(refill);
    assert.equal(ledger.balance(pool("wood")).available, total("wood").toString());
    assert.equal(ledger.balance(TREASURY).available, "0");
    assert.equal(ledger.summary().supply, supply);
    assert.equal(engine.status().allocated, allocated);
    assert.deepEqual(ledger.balance(REDEMPTION_ESCROW), escrow);
    const entry = engine.activity({ limit: 1 }).items[0];
    assert.equal(entry.operation, "refill-market");
    assert.equal(entry.recordType, "treasury-circulation");
    assert.equal(entry.treasuryDollars, amount.toString());
    const tip = ledger.tipHash;
    ledger.commitAuthorized(refill);
    assert.equal(ledger.tipHash, tip, "repeated reads do not spend more treasury dollars");
    assert.throws(() => ledger.commitAuthorized(signedGold("already-funded", pending)), /low market funds/);
    ledger.close(); open();
    assert.equal(ledger.tipHash, tip);
    move(pool("wood"), walletAccountId(source.address), total("wood"));
    assert.equal(ledger.summary().supply, supply);
    assert.equal(engine.status().allocated, allocated);
    conserved();
  });
  it("rejects unsupported resource targets and unavailable writers without changing the journal", async () => {
    await engine.initialize(); await fund("wood");
    const one = 10n ** 14n;
    adapter.commit(adapter.prepare([{ account: pool("wood"), delta: (-one).toString() }]));
    move(pool("wood"), walletAccountId(source.address), total("wood") - one);
    await assert.rejects(engine.resourceLiquidity("scanner"), /Invalid resource/);
    const blocked = createReserveEngine({ ledger, privateKey: goldKeys.privateKey, provider,
      beforeMutation: () => { throw Object.assign(new Error("Writer is unavailable."), { status: 503 }); } });
    const tip = ledger.tipHash;
    await assert.rejects(blocked.resourceLiquidity("wood"), /Writer is unavailable/);
    assert.equal(ledger.tipHash, tip);
    conserved();
  });
  it("uses origin before treasury and repeatedly funds resources at the active conversion rate", async () => {
    await engine.initialize(); await engine.activatePricing();
    await fund("water");
    const treasury = total("water") / 2n;
    adapter.commit(adapter.prepare([{ account: pool("water"), delta: (-treasury).toString() }]));
    const treasuryBefore = ledger.balance(TREASURY).available;
    const stateBefore = structuredClone(ledger.goldReserve);
    await engine.resourceLiquidity("wood");
    const seeded = ledger.findTx(ledger.ids.get(engine.activity({ limit: 1 }).items[0].id)).tx;
    assert.equal(seeded.d.op, "resource-liquidity");
    assert.equal(BigInt(seeded.d.dollars), pricing.quote(stateBefore, "fthg-to-fthdollar", seeded.d.fthg) / 10n ** 14n * 10n ** 14n);
    assert.equal(ledger.balance(TREASURY).available, treasuryBefore, "origin funding never spends existing treasury");
    assert.equal(ledger.goldReserve.pools.wood.quantity, targets.wood.quantity);
    const seed = structuredClone(ledger.goldReserve.pools.wood);
    const spot = engine.status().spotRateFthDollarPerFthg;
    const beforeSupply = BigInt(ledger.summary().supply);
    move(pool("wood"), walletAccountId(source.address), total("wood"));
    const previousState = structuredClone(ledger.goldReserve);
    await engine.resourceLiquidity("wood");
    const entry = engine.activity({ limit: 1 }).items[0];
    assert.equal(entry.quantity, null, "refills never add resource inventory");
    assert.equal(entry.treasuryDollars, "0");
    assert.equal(BigInt(entry.dollars), pricing.quote(previousState, "fthg-to-fthdollar", entry.fthg) / 10n ** 14n * 10n ** 14n);
    assert.equal(BigInt(ledger.summary().supply), beforeSupply + BigInt(entry.dollars));
    assert.ok(BigInt(engine.status().spotRateFthDollarPerFthg) > BigInt(spot));
    assert.deepEqual(ledger.goldReserve.pools.wood, seed);
    const tip = ledger.tipHash;
    await engine.resourceLiquidity("wood");
    assert.equal(ledger.tipHash, tip);
    ledger.close(); open();
    assert.equal(ledger.tipHash, tip); assert.deepEqual(ledger.goldReserve.pools.wood, seed);
    assert.equal(ledger.balance(TREASURY).available, treasuryBefore);
    conserved();
  });
  it("concurrent origin refills and persistence recovery allocate once without duplicating inventory", async () => {
    await engine.initialize(); await engine.activatePricing();
    await engine.resourceLiquidity("wood");
    const seed = structuredClone(ledger.goldReserve.pools.wood);
    move(pool("wood"), walletAccountId(source.address), total("wood"));
    const append = ledger.store.append;
    ledger.store.append = () => { throw new Error("isolated disk failure"); };
    await assert.rejects(engine.resourceLiquidity("wood"), /could not be persisted/);
    ledger.store.append = append;
    const before = BigInt(ledger.summary().supply);
    await Promise.all([engine.resourceLiquidity("wood"), engine.resourceLiquidity("wood"), engine.resourceLiquidity("wood")]);
    assert.equal(BigInt(ledger.summary().supply), before + total("wood"));
    assert.deepEqual(ledger.goldReserve.pools.wood, seed);
    const tip = ledger.tipHash;
    ledger.close(); open();
    assert.equal(ledger.tipHash, tip);
    assert.deepEqual(ledger.goldReserve.pools.wood, seed);
    conserved();
  });
  it("blocks treasury until actual origin is zero and all outgoing origin obligations are reconciled", async () => {
    ledger.close();
    fs.rmSync(path.join(directory, "ledger"), { recursive: true, force: true });
    provider.origin = ethers.parseEther("40");
    open(); await engine.initialize(); await engine.resourceLiquidity("wood");
    const issued = BigInt(ledger.summary().supply);
    assert.equal(ledger.goldReserve.allocated, ledger.goldReserve.cap);
    adapter.commit(adapter.prepare([{ account: pool("wood"), delta: (-issued).toString() }]));
    const tip = ledger.tipHash;
    await assert.rejects(engine.resourceLiquidity("wood"), /wallet is not zero/);
    assert.equal(ledger.tipHash, tip); assert.equal(BigInt(ledger.balance(TREASURY).available), issued);
    provider.origin = 0n;
    await assert.rejects(engine.resourceLiquidity("wood"), /Reconcile/);
    provider.origin = ethers.parseEther("40");
    await reconcile(ethers.parseEther("40"));
    assert.equal(provider.origin, 0n);
    const allocated = engine.status().allocated;
    await engine.resourceLiquidity("wood");
    const entry = engine.activity({ limit: 1 }).items[0];
    assert.equal(entry.direction, "treasury-to-market"); assert.equal(entry.fthg, "0");
    assert.equal(BigInt(ledger.balance(TREASURY).available), 0n);
    assert.equal(BigInt(ledger.summary().supply), issued); assert.equal(engine.status().allocated, allocated);
    move(pool("wood"), walletAccountId(source.address), issued);
    await assert.rejects(engine.resourceLiquidity("wood"), /cannot fund/);
    conserved();
  });
  it("funds large resource sales through World while preserving one-time inventory and signed liquidity limits", async () => {
    await engine.initialize(); await engine.activatePricing();
    store = new SqliteStore(":memory:", Date.now, 1, adapter);
    const identity = store.create();
    store.transaction(identity.token, session => {
      session.account.game.stage = 0; session.account.game.stock.wood = 2000000;
    });
    await store.ensureLiquidity(identity.token, "wood");
    const seedUnits = store.transaction(identity.token, (_session, _time, _real, exchange, owner) =>
      exchange.read(owner, _session.account, _time, _real, "wood", 1)).market.quotes.sell;
    assert.ok(seedUnits.available);
    const beforeSupply = BigInt(ledger.summary().supply);
    await store.ensureLiquidity(identity.token, "wood", 1000000);
    assert.ok(BigInt(ledger.summary().supply) > beforeSupply, "large sales fund more than the old seed target");
    const read = quantity => store.transaction(identity.token, (session, time, real, exchange, owner) =>
      exchange.read(owner, session.account, time, real, "wood", quantity));
    // Normal spot orders cap at 10,000; the half-sale API supports larger holdings.
    const half = store.transaction(identity.token, (session, _time, real, exchange, owner) => exchange.halfQuote(owner, session.account, real));
    assert.equal(half.halfSale.available, true);
    assert.equal(half.halfSale.sales[0].quantity, 1000000);
    const tip = ledger.tipHash;
    await store.ensureLiquidity(identity.token, "wood", 1000000);
    assert.equal(ledger.tipHash, tip);
    assert.equal(read(1).market.quotes.sell.available, true);
    const request = { id: crypto.randomUUID(), revision: half.revision, command: { type: "sell-half",
      sales: half.halfSale.sales.map(sale => ({ asset: sale.asset, quantity: sale.quantity, limitDollars: sale.dollars })) } };
    const sold = store.transaction(identity.token, (session, time, real, exchange, owner) =>
      exchange.action(owner, session, request, time, real));
    assert.equal(sold.game.stock.wood, 1000000);
    assert.equal(sold.dollars, half.halfSale.dollars);
    const retry = store.transaction(identity.token, (session, time, real, exchange, owner) =>
      exchange.action(owner, session, request, time, real));
    assert.deepEqual(retry, sold);
    const escrow = ledger.balance(REDEMPTION_ESCROW);
    const tx = ledger.findTx(ledger.ids.get(engine.activity({ limit: 1 }).items[0].id)).tx;
    const { signature, ...data } = tx.d;
    assert.throws(() => ledger.commitAuthorized(signedGold("bad-conversion", { ...data, dollars: (BigInt(data.dollars) + 10n ** 14n).toString() })), /quote/);
    assert.throws(() => ledger.commitAuthorized(signedGold("bad-fallback", { ...data, fthg: "0" })), /fallback/);
    assert.deepEqual(ledger.balance(REDEMPTION_ESCROW), escrow);
    conserved();
  });
  it("funds and executes 85,400 kg of Wood when its historical price is below accounting precision", async () => {
      await engine.initialize(); await engine.activatePricing();
      store = new SqliteStore(":memory:", Date.now, 1, adapter);
      const identity = store.create();
      store.transaction(identity.token, session => {
        session.account.game.stage = 0; session.account.game.stock.wood = 1708;
      });
      await store.ensureLiquidity(identity.token, "wood");
      const seed = structuredClone(ledger.goldReserve.pools.wood);
      store.db.prepare("UPDATE market_pools SET units=10000000000 WHERE asset='wood'").run();
      store.db.prepare("INSERT OR REPLACE INTO market_resource_depth VALUES('wood','90000000000','90000')").run();
      const read = () => store.transaction(identity.token, (session, time, real, exchange, owner) =>
        exchange.read(owner, session.account, time, real, "wood", 1708));
      assert.equal(read().market.quotes.sell.available, false);
      const supply = BigInt(ledger.summary().supply);
      await store.ensureLiquidity(identity.token, "wood", 1708);
      assert.ok(BigInt(ledger.summary().supply) > supply);
      assert.deepEqual(ledger.goldReserve.pools.wood, seed);
      const quote = read();
      assert.equal(quote.market.quotes.sell.available, true);
      assert.ok(quote.market.quotes.sell.dollars > 0);
      const tip = ledger.tipHash;
      await store.ensureLiquidity(identity.token, "wood", 1708);
      assert.equal(ledger.tipHash, tip);
      const request = { id: crypto.randomUUID(), revision: quote.revision,
        command: { type: "spot", side: "sell", asset: "wood", quantity: 1708, limitDollars: quote.market.quotes.sell.dollars } };
      const result = store.transaction(identity.token, (session, time, real, exchange, owner) =>
        exchange.action(owner, session, request, time, real));
      assert.equal(result.game.stock.wood, 0);
      assert.equal(result.dollars, quote.market.quotes.sell.dollars);
      conserved();
  });
  it("HTTP sale quotes fund origin conversions and retries or rejected large orders do not allocate again", async () => {
    await engine.initialize(); await engine.activatePricing();
    store = new SqliteStore(":memory:", Date.now, 1, adapter);
    const identity = store.create(), origin = "http://127.0.0.1";
    store.transaction(identity.token, session => {
      session.account.game.stage = 0; session.account.game.stock.wood = 2000000;
      session.account.game.stock.water = 0; session.account.game.stock.metal = 0;
    });
    const server = createApi(store, origin);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { cookie: `terra-dev=${identity.token}`, origin, "content-type": "application/json", "x-csrf-token": identity.csrf };
      const quoteResponse = await fetch(`${base}/api/market/half`, { headers });
      assert.equal(quoteResponse.status, 200);
      const quote = await quoteResponse.json();
      assert.equal(quote.halfSale.available, true);
      const body = JSON.stringify({ id: crypto.randomUUID(), revision: quote.revision, command: { type: "sell-half",
        sales: quote.halfSale.sales.map(sale => ({ asset: sale.asset, quantity: sale.quantity, limitDollars: sale.dollars })) } });
      const sale = await fetch(`${base}/api/market/actions`, { method: "POST", headers, body });
      assert.equal(sale.status, 200, await sale.clone().text());
      const result = await sale.json();
      assert.equal(result.game.stock.wood, 1000000);
      const tip = ledger.tipHash;
      const retry = await fetch(`${base}/api/market/actions`, { method: "POST", headers, body });
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).dollars, result.dollars);
      assert.equal(ledger.tipHash, tip, "receipt retries never replenish again");
      const invalid = JSON.stringify({ id: crypto.randomUUID(), revision: result.revision, command: { type: "sell-half",
        sales: [{ asset: "wood", quantity: 100000000, limitDollars: 1 }] } });
      assert.equal((await fetch(`${base}/api/market/actions`, { method: "POST", headers, body: invalid })).status, 409);
      assert.equal(ledger.tipHash, tip);
      conserved();
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  it("sufficient market funds still permit sale quotes when origin is exhausted or Ethereum is unavailable", async () => {
    await engine.initialize(); await engine.resourceLiquidity("wood");
    const tip = ledger.tipHash, treasury = ledger.balance(TREASURY).available;
    provider.getNetwork = async () => { throw new Error("Ethereum is unavailable."); };
    await engine.resourceLiquidity("wood", 10n ** 18n);
    assert.equal(ledger.tipHash, tip); assert.equal(ledger.balance(TREASURY).available, treasury);
    move(pool("wood"), walletAccountId(source.address), total("wood"));
    const emptyTip = ledger.tipHash;
    await assert.rejects(engine.resourceLiquidity("wood", 10n ** 18n), /Ethereum is unavailable/);
    assert.equal(ledger.tipHash, emptyTip);
    conserved();
  });
  it("uses the exact gradual origin curve, including trade-size movement and conservative rounding", () => {
    const cap = ethers.parseEther("100");
    const state = net => ({ cap: cap.toString(), allocated: ethers.parseEther(String(net)).toString(),
      recycledIn: "0", released: "0", pricingPolicy: pricing.POLICY });
    for (const [net, expected] of [[0, "10000"], [10, "11000"], [50, "15000"], [90, "19000"], [100, "20000"]])
      assert.equal(pricing.spot(state(net)), ethers.parseEther(expected));
    const dollars = pricing.quote(state(0), "fthg-to-fthdollar", ethers.parseEther("10"));
    assert.equal(dollars, ethers.parseEther("105000"));
    assert.equal(pricing.quote(state(10), "fthdollar-to-fthg", dollars), ethers.parseEther("10"));
    const split = pricing.quote(state(0), "fthg-to-fthdollar", ethers.parseEther("5"))
      + pricing.quote(state(5), "fthg-to-fthdollar", ethers.parseEther("5"));
    assert.equal(split, dollars, "splitting a trade cannot bypass curve movement");
    assert.throws(() => pricing.quote(state(90), "fthg-to-fthdollar", ethers.parseEther("11")), /remaining origin/);
    assert.throws(() => pricing.quote(state(0), "fthdollar-to-fthg", 1n), /net allocated/);
    assert.throws(() => pricing.position({ ...state(0), cap: "0" }), /positive origin cap/);
    assert.throws(() => pricing.quote({ ...state(50), recycledIn: "1" }, "fthdollar-to-fthg",
      pricing.quote(state(50), "fthg-to-fthdollar", 1n)), /too small/);
    for (const amount of [123456789n, ethers.parseEther("0.001")]) {
      const start = state(50), output = pricing.quote(start, "fthg-to-fthdollar", amount);
      const end = { ...start, recycledIn: amount.toString() };
      assert.ok(pricing.quote(end, "fthdollar-to-fthg", output) <= amount, "rounding never creates Gold");
    }
  });
  it("activates dynamic quotes without rewriting old entries, rejects stale authorizations and replays after restart", async () => {
    await engine.initialize();
    await fund("wood");
    const oldTip = ledger.tipHash, oldHistory = engine.activity().items;
    const dollars = total("wood"), allocated = dollars / RATE;
    move(pool("wood"), walletAccountId(source.address), dollars);
    await reconcile(allocated);
    const supply = ledger.summary().supply;
    await engine.activatePricing();
    assert.notEqual(ledger.tipHash, oldTip);
    assert.equal(ledger.summary().supply, supply);
    const policyTip = ledger.tipHash;
    await engine.activatePricing();
    assert.equal(ledger.tipHash, policyTip, "policy activation is idempotent");
    assert.ok(BigInt(engine.status().spotRateFthDollarPerFthg) >= ethers.parseEther("10000"));
    assert.equal(engine.activity().items.at(-1).dollars, oldHistory[0].dollars);
    const quote = engine.quote("fthdollar-to-fthg", dollars);
    const transfer = await redemption(dollars);
    await assert.rejects(engine.redeem(transfer), /restricted/);
    transfer.memo = quote.authorization;
    transfer.signature = await source.signMessage(transferMessage(transfer));
    const previousSpot = BigInt(engine.status().spotRateFthDollarPerFthg);
    await engine.redeem(transfer);
    assert.ok(BigInt(engine.status().spotRateFthDollarPerFthg) < previousSpot);
    await engine.redeem(transfer);
    const returned = BigInt(quote.amountOut);
    await reconcile(returned, false);
    const reconversion = engine.quote("fthg-to-fthdollar", returned);
    const request = { amount: returned.toString(), nonce: 1, issuedAt: new Date().toISOString(), pricing: reconversion.authorization };
    request.signature = await source.signMessage(conversionMessage(request, ledger.headers[0].H, source.address, reserve.address));
    const stale = { ...request, pricing: "G2:stale" };
    stale.signature = await source.signMessage(conversionMessage(stale, ledger.headers[0].H, source.address, reserve.address));
    await assert.rejects(engine.convert(stale), /quote changed/);
    await engine.convert(request);
    await engine.convert(request);
    assert.ok(BigInt(engine.status().spotRateFthDollarPerFthg) > ethers.parseEther("10000"));
    const snapshot = engine.status(), history = engine.activity().items;
    ledger.close(); open();
    assert.deepEqual(engine.status(), snapshot);
    assert.deepEqual(engine.activity().items, history);
    assert.equal(history[0].dollars, reconversion.amountOut);
    assert.equal([...ledger.balances.values()].reduce((sum, entry) => sum + entry.balance, 0n), BigInt(ledger.summary().supply));
  });
  it("serves executable committed quotes and uses the same verified spot for wallet estimates", async () => {
    const gold = createGoldApi({ provider, logger: { error() {} } });
    const reserveApi = gold.enableReserve(ledger, goldKeys.privateKey);
    await reserveApi.initialize();
    await fund("wood");
    const dollars = total("wood");
    move(pool("wood"), walletAccountId(source.address), dollars);
    await reconcile(dollars / RATE);
    await reserveApi.activatePricing();
    const server = http.createServer((req, res) => gold.handle(req, res));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/v1/gold/reserve`;
      const response = await fetch(`${base}/quote?direction=fthdollar-to-fthg&amount=${dollars}`);
      assert.equal(response.status, 200);
      const quote = await response.json();
      assert.equal(quote.amountOut, (await gold.quote("fthdollar-to-fthg", dollars.toString())).toString());
      const transfer = await redemption(dollars);
      transfer.memo = quote.authorization;
      transfer.signature = await source.signMessage(transferMessage(transfer));
      const executed = await fetch(`${base}/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(transfer) });
      assert.equal(executed.status, 200, await executed.text());
      const bad = await fetch(`${base}/quote?direction=fthg-to-fthdollar&amount=-1`);
      assert.equal(bad.status, 400);
      const state = reserveApi.status();
      const snapshot = { goldReserve: state, chain: { id: 1, tokenAddress: TOKEN_ADDRESS }, checkedAt: new Date().toISOString() };
      const { goldReference } = require("../services/notes/exchange-price");
      assert.equal(goldReference(snapshot).dollars.toString(), state.spotRateFthDollarPerFthg);
      assert.equal(goldReference({ ...snapshot, goldReserve: { ...state, spotRateFthDollarPerFthg: "1" } }), null);
      const browser = {};
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/gold-pricing.js"), "utf8"), browser);
      assert.equal(browser.FeatheralGoldPricing.spot(state), pricing.spot(state));
      assert.equal(browser.FeatheralGoldPricing.quote(state, "fthg-to-fthdollar", 123456n), pricing.quote(state, "fthg-to-fthdollar", 123456n));
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
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
  it("requires a fresh ledger-bound origin or backing signature before HTTP reconciliation", async () => {
    const gold = createGoldApi({ provider, logger: { error() {} } });
    const reserveApi = gold.enableReserve(ledger, goldKeys.privateKey);
    await reserveApi.initialize();
    const server = http.createServer((req, res) => gold.handle(req, res));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/v1/gold/reserve/reconcile`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let receiptReads = 0;
    provider.getTransactionReceipt = async () => { receiptReads++; return null; };
    const request = { txHash: blockHash(100), logIndex: 0, issuedAt: new Date().toISOString() };
    const signed = async (wallet, body = request, genesis = reserveApi.status().genesisHash) =>
      ({ ...body, signature: await wallet.signMessage(reconciliationMessage(body, genesis)) });
    try {
      assert.equal((await post({ txHash: request.txHash, logIndex: 0 })).status, 400);
      assert.equal((await post({ ...request, signature: "invalid" })).status, 401);
      assert.equal((await post(await signed(ethers.Wallet.createRandom()))).status, 403);
      assert.equal((await post(await signed(source, request, ethers.ZeroHash))).status, 403);
      const stale = { ...request, issuedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
      assert.equal((await post(await signed(source, stale))).status, 401);
      const authorization = await signed(source);
      assert.equal((await post({ ...authorization, logIndex: 1 })).status, 403);
      assert.equal(receiptReads, 0, "unauthorized requests never read receipts or mutate the ledger");
      for (const wallet of [source, reserve]) {
        const result = await post(await signed(wallet));
        assert.equal(result.status, 409);
        assert.match((await result.json()).error, /missing or reverted/);
      }
      assert.equal(receiptReads, 2);
      assert.deepEqual(reserveApi.status().receipts, {});
      await reserveApi.fundMarket("wood", targets.wood.quantity, total("wood"));
      const amount = BigInt(reserveApi.status().pendingIn);
      provider.head = 200;
      provider.origin -= amount; provider.reserve += amount;
      const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
      const log = iface.encodeEventLog(iface.getEvent("Transfer"), [source.address, reserve.address, amount]);
      provider.getTransactionReceipt = async () => ({ status: 1, blockNumber: 150, blockHash: blockHash(150),
        logs: [{ index: 0, address: TOKEN_ADDRESS, ...log }] });
      const signedReceipt = await signed(source);
      assert.equal((await post(signedReceipt)).status, 200);
      const height = ledger.height;
      assert.equal((await post(signedReceipt)).status, 200);
      assert.equal((await post(await signed(reserve))).status, 200);
      assert.equal(ledger.height, height, "authorized receipt retries are idempotent");
      assert.equal(reserveApi.status().settledIn, amount.toString());
      conserved();
    } finally { await new Promise(resolve => server.close(resolve)); gold.close(); }
  });
  it("signs exactly the Gold API reconciliation authorization from the reserve UI", async () => {
    await engine.initialize();
    const script = fs.readFileSync(path.join(__dirname, "..", "sites", "gold.featheral.com", "conversion", "reserve.js"), "utf8");
    const nodes = new Map(), posts = [], signatures = [];
    const element = id => {
      if (!nodes.has(id)) nodes.set(id, { value: "", dataset: {}, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; } });
      return nodes.get(id);
    };
    const wallet = { getNetwork: async () => ({ chainId: 1n }), getSigner: async () => ({
      getAddress: async () => source.address,
      signMessage: async message => { signatures.push(message); return source.signMessage(message); },
    }) };
    const state = engine.status();
    vm.runInNewContext(script, {
      document: { getElementById: element }, confirm: () => true,
      AbortSignal, ethers: { ...ethers, BrowserProvider: function () { return wallet; } },
      fetch: async (url, options) => {
        if (options.body) posts.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => state };
      },
      window: { FeatheralReserveView: { units: String, dollars: String, render() {}, history: () => async () => {} },
        FeatheralProfile: { snapshot: () => ({ account: source.address }), getProvider: () => ({}), mount() {} },
        FeatheralSites: { url: () => "" }, addEventListener() {} },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts.length, 0, "automatic refresh never reconciles or submits transfers");
    element("hash").value = blockHash(100); element("log").value = "0";
    await element("reconcile").listeners.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/v1/gold/reserve/reconcile");
    assert.equal(signatures[0], reconciliationMessage(posts[0].body, state.genesisHash));
    assert.equal(ethers.verifyMessage(signatures[0], posts[0].body.signature), source.address);
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
    const repository = path.join(directory, "system-fixture"), bootstrapFile = path.join(directory, "bootstrap.json"), keyFile = path.join(directory, "system.key");
    fs.mkdirSync(repository);
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    fs.writeFileSync(bootstrapFile, JSON.stringify({ keyFile }), { mode: 0o600 });
    const settings = new (require("../services/operations/settings").OperationsSettings)({ root: repository, bootstrapFile });
    const runtime = { HOST: "127.0.0.1", PORT: "18088", APP_ORIGIN: "http://world.localhost:18088",
      GOLD_RESERVE_MODE: "isolated", GOLD_API_RPC_URL: "http://127.0.0.1:1" };
    const preload = path.join(directory, "system-fixture.cjs");
    fs.writeFileSync(preload, `
      const { OperationsSettings } = require(${JSON.stringify(path.join(root, "services", "operations", "settings.js"))});
      const filename = ${JSON.stringify(path.join(root, "services", "operations", "runtime.js"))};
      require.cache[require.resolve(filename)] = { id: filename, filename, loaded: true,
        exports: new OperationsSettings(${JSON.stringify({ root: repository, bootstrapFile })}) };
      const configuration = require(${JSON.stringify(path.join(root, "services", "operations", "configuration.js"))});
      const check = configuration.assertDatabaseConfiguration;
      configuration.assertDatabaseConfiguration = () => check(${JSON.stringify(repository)}, {});
    `);
    const start = target => {
      settings.persist({ ...settings.value, revision: settings.value.revision + 1, runtime: { ...runtime, GOLD_RESERVE_TEST_DIR: target } });
      return spawnSync(process.execPath, ["--require", preload, path.join(root, "scripts", "serve.js")], { encoding: "utf8", timeout: 10000 });
    };
    const unsafe = start(path.join(root, "data"));
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /named directory/);
    try {
      const failed = start(isolated);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /Server initialization failed/);
      assert.equal(fs.readFileSync(path.join(isolated, "isolated-reserve.json"), "utf8"), '{"isolatedReserve":true}\n');
      const junction = path.join(isolated, "external");
      fs.symlinkSync(directory, junction, process.platform === "win32" ? "junction" : "dir");
      try {
        const linked = start(isolated);
        assert.notEqual(linked.status, 0);
        assert.match(linked.stderr, /cannot contain links/);
      } finally { fs.unlinkSync(junction); }
    } finally {
      if (fs.existsSync(isolated)) fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
  it("shares exact wallet signing text and never submits Ethereum writes from the isolated UI", () => {
    const context = { window: {}, ethers };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "shared", "dollar-transfer.js"), "utf8"), context);
    for (const to of [REDEMPTION_ESCROW, walletAccountId(reserve.address), reserve.address]) {
      const transfer = { wallet: source.address.toLowerCase(), to, amount: "1000000000000000000", nonce: 1, memo: "", issuedAt: new Date().toISOString() };
      assert.equal(context.window.FeatheralDollarTransferMessage(transfer), transferMessage({ ...transfer, wallet: source.address, to: ethers.isAddress(to) ? walletAccountId(to) : to }));
    }
    const ui = fs.readFileSync(path.join(__dirname, "..", "sites", "gold.featheral.com", "conversion", "reserve.js"), "utf8");
    assert.match(ui, /WARNING: this is an isolated test journal/);
    assert.doesNotMatch(ui, /sendTransaction|eth_sendTransaction|eth_sendRawTransaction/);
    assert.match(ui, /chainId\) !== 1/);
  });
  it("formats reserve FTH$ amounts at most two decimals and wires both focused Gold pages", () => {
    const context = { window: {}, ethers };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "sites", "gold.featheral.com", "reserve-view.js"), "utf8"), context);
    assert.equal(context.window.FeatheralReserveView.units(ethers.parseUnits("216265000.123456789123456789", 18)), "216,265,000.123456789123456789");
    for (const [value, expected] of [["0", "0"], ["1.9999", "2"], ["3.9596", "3.96"], ["1000.1", "1,000.1"], ["0.009", "0.01"]]) {
      assert.equal(context.window.FeatheralReserveView.dollars(ethers.parseUnits(value, 18)), expected);
    }
    for (const page of ["admin", "conversion"]) {
      const html = fs.readFileSync(page === "admin"
        ? path.join(__dirname, "..", "sites", "admin.featheral.com", "pages", "gold.html")
        : path.join(__dirname, "..", "sites", "gold.featheral.com", page, "index.html"), "utf8");
      for (const id of ["sync-state", "origin-flow", "reserve-flow", "reserve-metrics", "reserve-mode", "reserve-transactions", "history-more", "history-status"]) {
        assert.ok(html.includes(`id="${id}"`), `${page}: ${id}`);
      }
      if (page === "conversion") {
        assert.match(html, /class="top gold-header"/);
        assert.match(html, /src="\/reserve-view.js"/);
        assert.match(html, /href="\/reserve.css"/);
      } else {
        assert.doesNotMatch(html, /<script|<iframe|<header/);
      }
    }
    const admin = fs.readFileSync(path.join(__dirname, "..", "sites", "admin.featheral.com", "js", "operations", "gold.js"), "utf8");
    assert.doesNotMatch(admin, /setRate|setTreasury|addLiquidity|swapExact|localStorage|setExchangeEnabled/);
    assert.match(admin, /staticCall/);
    assert.match(admin, /token\.hasRole\(roles\[role\], account\)/);
  });
  it("enforces actual roles, Mainnet, simulation and wallet revalidation before token safety writes", async () => {
    await engine.initialize();
    const script = fs.readFileSync(path.join(__dirname, "..", "sites", "admin.featheral.com", "js", "operations", "gold.js"), "utf8");
    for (const scenario of ["success", "no-role", "wrong-chain", "simulation-fails", "chain-changed", "view-changed", "cancelled"]) {
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
        window: { FeatheralAdminControllers: {}, FeatheralReserveView: { scope: () => ({ api: async () => engine.status(), render() {}, history: () => async () => {} }) },
          FeatheralSites: { url: () => "http://dollar.localhost/wallet/" },
          FeatheralProfile: { mount() {}, snapshot: () => ({ account: source.address, chainId: 1 }), getProvider: () => wallet },
          addEventListener() {} },
      };
      vm.runInNewContext(script, context);
      context.window.FeatheralAdminControllers.gold({ querySelector: selector => element(selector.slice(1)) }, {
        listen() {}, assertActive() { if (scenario === "view-changed") throw new Error("Administration view changed."); },
      });
      await new Promise(resolve => setImmediate(resolve));
      await element("token-pause").listeners.click();
      assert.deepEqual(calls, scenario === "success" ? ["simulate", "write"]
        : ["simulation-fails", "chain-changed", "view-changed"].includes(scenario) ? ["simulate"] : [], scenario);
      if (!["success", "cancelled"].includes(scenario)) {
        assert.equal(element("safety-status").dataset.error, "true", scenario);
        assert.ok(element("safety-status").textContent, scenario);
      }
    }
  });
});
