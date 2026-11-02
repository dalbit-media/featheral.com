const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { ethers } = require("ethers");
const { createDollarApi: createTokenApi } = require("../services/notes/dollar");
const { FthLedger } = require("../services/fth-ledger/ledger");
const { transferMessage } = require("../services/fth-ledger/transfer");
const { blockHash } = require("../services/fth-ledger/codec");
const { profileMessage } = require("../services/identity/profile");
const vm = require("node:vm");

describe("Token API routing", () => {
  let directory;
  let api;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fthg-api-"));
    api = createTokenApi({
      env: {
        FTH_LEDGER_MODE: "unconfigured",
        FTH_LEDGER_DIR: directory,
        FTH_LEDGER_BLOCK_INTERVAL_MS: "0",
      },
    });
  });

  afterEach(() => {
    api?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function response() {
    return {
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body = "") {
        this.body = body;
        this.writableEnded = true;
      },
    };
  }

  it("claims handled API routes so the static server does not write a second response", async () => {
    const res = response();
    const handled = await api.handle({ method: "GET", url: "/api/v1/health", headers: {} }, res);

    expect(handled).to.equal(true);
    expect(res.statusCode).to.equal(200);
    expect(JSON.parse(res.body)).to.include({ status: "ok", mode: "unconfigured" });
  });

  it("claims unknown API routes after returning a JSON 404", async () => {
    const res = response();
    const handled = await api.handle({ method: "GET", url: "/api/v1/unknown", headers: {} }, res);

    expect(handled).to.equal(true);
    expect(res.statusCode).to.equal(404);
    expect(JSON.parse(res.body).error).to.equal("API route not found.");
  });
  it("serves canonical Note chain reads identically to Dollar aliases without accessing Ethereum", async () => {
    for (const route of ["health", "stats", "fth/stats", `wallets/0x${"11".repeat(20)}`]) {
      const read = async prefix => {
        const res = response();
        await api.handle({ method: "GET", url: `/api/v1/${prefix}/${route}`, headers: {} }, res);
        return { status: res.statusCode, body: JSON.parse(res.body) };
      };
      const notes = await read("notes"), dollar = await read("dollar");
      delete notes.body.checkedAt; delete dollar.body.checkedAt;
      expect(notes).to.deep.equal(dollar);
      expect(notes.status).to.equal(200);
    }
  });
  it("does not claim Gold-owned Ethereum routes", async () => {
    const res = response();
    expect(await api.handle({ method: "POST", url: "/api/v1/gold/rpc", headers: {} }, res)).to.equal(false);
    expect(res.headersSent).to.equal(false);
  });
  it("blocks wallet issuance operations when Dollar policy is closed or unavailable", async () => {
    let failed = false;
    const sandbox = { window: {}, fetch: async () => {
      if (failed) throw new Error("Dollar unavailable");
      return { ok: true, json: async () => ({ monetaryPolicy: { issuanceEnabled: false } }) };
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../sites/dollar.featheral.com/fth.js"), "utf8"), sandbox);
    await expect(sandbox.window.FTH.requireIssuance()).to.be.rejectedWith("issuance is closed");
    failed = true;
    await expect(sandbox.window.FTH.requireIssuance()).to.be.rejectedWith("Dollar unavailable");
    for (const file of ["wallet.js", "staking.js"]) {
      const source = fs.readFileSync(path.join(__dirname, "../sites/wallet.featheral.com/ethereum", file), "utf8");
      expect(source).to.include("await ").and.include("requireIssuance()");
    }
  });

  it("returns an explicit authorization error for protected account reads", async () => {
    const res = response();
    const accountId = `0x${"ab".repeat(32)}`;
    const handled = await api.handle({ method: "GET", url: `/api/v1/accounts/${accountId}`, headers: {} }, res);

    expect(handled).to.equal(true);
    expect(res.statusCode).to.equal(401);
    expect(JSON.parse(res.body).error).to.equal("Unauthorized service.");
  });

  it("serves a public FTH$ wallet view keyed by the address-derived game account", async () => {
    const wallet = ethers.Wallet.createRandom();
    const gameAccountId = ethers.zeroPadValue(wallet.address, 32).toLowerCase();
    await api.ledger.submit({ id: "eth:1:0xabc:0", kind: "CREDIT", account: gameAccountId, amount: ethers.parseUnits("2500", 18).toString(), data: { src: "FthgConverted", tx: `0x${"cd".repeat(32)}` } });
    await api.ledger.submit({ id: "eth:1:0xdef:0", kind: "CREDIT", account: `0x${"11".repeat(32)}`, amount: "5", data: { src: "FthgConverted", tx: `0x${"ef".repeat(32)}` } });

    const res = response();
    const handled = await api.handle({ method: "GET", url: `/api/v1/wallets/${wallet.address.toLowerCase()}`, headers: {} }, res);
    const body = JSON.parse(res.body);

    expect(handled).to.equal(true);
    expect(res.statusCode).to.equal(200);
    expect(body).to.include({ address: wallet.address, gameAccountId, accountId: gameAccountId, nonce: 0, ledgerHeight: 2 });
    expect(body.fthDollar).to.deep.equal({ balance: ethers.parseUnits("2500", 18).toString(), reserved: "0", available: ethers.parseUnits("2500", 18).toString() });
    expect(body.history).to.have.length(1);
    expect(body.history[0]).to.include({ kind: "CREDIT", source: "FthgConverted", ethTx: `0x${"cd".repeat(32)}`, toWallet: wallet.address, status: "sealed", height: 1 });
    expect(body.profile).to.equal(null);
  });

  describe("wallet profiles", () => {
    const PNG_AVATAR = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64")}`;

    async function signedProfile(wallet, overrides = {}) {
      const profile = {
        address: wallet.address.toLowerCase(),
        username: "feather_fan",
        avatar: PNG_AVATAR,
        issuedAt: new Date().toISOString(),
        ...overrides,
      };
      profile.signature = await wallet.signMessage(profileMessage(profile));
      return profile;
    }

    async function post(body) {
      const raw = JSON.stringify(body);
      const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: "POST", url: "/api/v1/profiles", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
      const res = response();
      await api.handle(req, res);
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    async function get(address) {
      const res = response();
      await api.handle({ method: "GET", url: `/api/v1/profiles/${address}`, headers: {} }, res);
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    it("saves a wallet-signed username and avatar through the database and serves it publicly", async () => {
      const wallet = ethers.Wallet.createRandom();
      expect((await get(wallet.address)).body.profile).to.equal(null);

      const saved = await post(await signedProfile(wallet));
      expect(saved.status).to.equal(200);
      expect(saved.body.profile).to.include({ address: wallet.address, username: "feather_fan", avatar: PNG_AVATAR });

      const fetched = await get(wallet.address.toLowerCase());
      expect(fetched.status).to.equal(200);
      expect(fetched.body.profile.username).to.equal("feather_fan");
      expect(api.ledger.blocksFrom(0).flatMap((block) => block.x.map((tx) => tx.k))).to.deep.equal(["GENESIS"]);
      expect(saved.body).not.to.have.property("ledgerHeight");
      let ledgerProfileError;
      try {
        await api.ledger.submit({ id: "new-ledger-profile", kind: "PROFILE", account: ethers.zeroPadValue(wallet.address, 32).toLowerCase(), data: {} });
      } catch (error) {
        ledgerProfileError = error;
      }
      expect(ledgerProfileError).to.have.property("status", 410);
      expect(ledgerProfileError.message).to.include("managed by the database service");
    });

    it("rejects signatures from another wallet, stale updates, and duplicate usernames", async () => {
      const owner = ethers.Wallet.createRandom();
      const other = ethers.Wallet.createRandom();
      const forged = await signedProfile(other);
      forged.address = owner.address;
      expect((await post(forged)).status).to.equal(401);

      const first = await signedProfile(owner, { issuedAt: new Date(Date.now() - 1000).toISOString() });
      expect((await post(first)).status).to.equal(200);
      const older = await signedProfile(owner, { username: "older_name", issuedAt: new Date(Date.now() - 5000).toISOString() });
      expect((await post(older)).status).to.equal(409);
      expect((await get(owner.address)).body.profile.username).to.equal("feather_fan");

      const taken = await post(await signedProfile(other, { username: "FEATHER_FAN" }));
      expect(taken.status).to.equal(409);

      const expired = await post(await signedProfile(owner, { username: "late_name", issuedAt: new Date(Date.now() - 3_600_000).toISOString() }));
      expect(expired.status).to.equal(401);
    });

    it("rejects avatars that are not small raster images", async () => {
      const wallet = ethers.Wallet.createRandom();
      const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;
      expect((await post(await signedProfile(wallet, { avatar: svg }))).status).to.equal(400);
      const fakePng = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
      expect((await post(await signedProfile(wallet, { avatar: fakePng }))).status).to.equal(400);
      expect((await post(await signedProfile(wallet, { avatar: "" }))).status).to.equal(200);
    });

    it("legacy ledger replicas re-verify profile signatures when importing blocks", async () => {
      const wallet = ethers.Wallet.createRandom();
      const profile = await signedProfile(wallet);
      const replicaDir = fs.mkdtempSync(path.join(os.tmpdir(), "fth-replica-"));
      const replica = new FthLedger({ directory: replicaDir, mode: "reader" }).open();
      try {
        const [genesis] = api.ledger.blocksFrom(0);
        const tx = { i: "legacy-profile", k: "PROFILE", a: ethers.zeroPadValue(wallet.address, 32).toLowerCase(), v: "0",
          d: { address: wallet.address.toLowerCase(), username: profile.username, avatar: profile.avatar, issuedAt: profile.issuedAt, signature: profile.signature }, t: Date.now() };
        const profileBlock = { h: 1, t: Math.max(Date.now(), genesis.t), p: genesis.H, x: [tx] };
        profileBlock.H = blockHash(profileBlock);
        replica.importBlock(genesis);
        const forged = structuredClone(profileBlock);
        forged.x[0].d.username = "someone_else";
        forged.H = blockHash(forged);
        expect(() => replica.importBlock(forged)).to.throw();
        replica.importBlock(profileBlock);
        expect(replica.profile(wallet.address).username).to.equal("feather_fan");
      } finally {
        replica.close();
        fs.rmSync(replicaDir, { recursive: true, force: true });
      }
    });
  });

  describe("FTH$ ledger endpoints", () => {
    async function call(method, url, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url, headers: {}, socket: { remoteAddress: "127.0.0.1" } });
      const res = response();
      await api.handle(req, res);
      return { status: res.statusCode, headers: res.headers, body: res.headers?.["Content-Type"]?.startsWith("application/json") ? JSON.parse(res.body) : String(res.body) };
    }

    async function fund(wallet, amount) {
      await api.ledger.submit({ id: `fund:${wallet.address}`, kind: "CREDIT", account: ethers.zeroPadValue(wallet.address, 32).toLowerCase(), amount: ethers.parseUnits(amount, 18).toString(), data: { src: "FthgConverted", tx: `0x${"aa".repeat(32)}` } });
    }

    async function signedTransfer(wallet, overrides = {}) {
      const transfer = { wallet: wallet.address, to: "", amount: ethers.parseUnits("10", 18).toString(), nonce: 1, memo: "", issuedAt: new Date().toISOString(), ...overrides };
      const to = ethers.isAddress(transfer.to) ? ethers.zeroPadValue(transfer.to, 32).toLowerCase() : transfer.to;
      transfer.signature = await wallet.signMessage(transferMessage({ ...transfer, to }));
      return transfer;
    }

    it("shares signed transfers and supply across canonical Note and legacy Dollar namespaces", async () => {
      const alice = ethers.Wallet.createRandom(), bob = ethers.Wallet.createRandom();
      await fund(alice, "100");
      const supply = api.ledger.summary().supply;
      const sent = await call("POST", "/api/v1/notes/fth/transfers", await signedTransfer(alice, { to: bob.address }));
      expect(sent.status).to.equal(200);
      expect(sent.body.balance.available).to.equal(ethers.parseUnits("90", 18).toString());
      const legacy = await call("GET", `/api/v1/dollar/wallets/${bob.address}`);
      expect(legacy.body.fthDollar.available).to.equal(ethers.parseUnits("10", 18).toString());
      const second = await call("POST", "/api/v1/dollar/fth/transfers", await signedTransfer(alice, { to: bob.address, nonce: 2 }));
      expect(second.status).to.equal(200);
      const canonical = await call("GET", `/api/v1/notes/wallets/${bob.address}`);
      expect(canonical.body.fthDollar.available).to.equal(ethers.parseUnits("20", 18).toString());
      expect(api.ledger.summary().supply).to.equal(supply);
    });

    it("accepts a wallet-signed transfer and exposes it through stats, tx, account, and search routes", async () => {
      const alice = ethers.Wallet.createRandom();
      const bob = ethers.Wallet.createRandom();
      await fund(alice, "100");

      const sent = await call("POST", "/api/v1/fth/transfers", await signedTransfer(alice, { to: bob.address, memo: "gg" }));
      expect(sent.status).to.equal(200);
      expect(sent.body).to.include({ status: "sealed", nonce: 1 });
      expect(sent.body.balance.available).to.equal(ethers.parseUnits("90", 18).toString());
      const { hash, height } = sent.body.receipt;

      const replay = await call("POST", "/api/v1/fth/transfers", await signedTransfer(alice, { to: bob.address }));
      expect(replay.status).to.equal(409);
      const forged = await signedTransfer(bob, { to: ethers.Wallet.createRandom().address, nonce: 2 });
      forged.wallet = alice.address;
      expect((await call("POST", "/api/v1/fth/transfers", forged)).status).to.equal(401);

      const stats = await call("GET", "/api/v1/fth/stats");
      expect(stats.body.ledger).to.include({ symbol: "FTH$", layer: 3, height, transfers: 1, holders: 2 });
      expect(stats.body.latestTransactions[0]).to.include({ hash, kind: "TRANSFER", memo: "gg" });
      expect(stats.body.richList.map((holder) => holder.wallet)).to.deep.equal([alice.address, bob.address]);

      expect((await call("GET", `/api/v1/fth/tx/${hash}`)).body).to.include({ fromWallet: alice.address, toWallet: bob.address, height });
      expect((await call("GET", `/api/v1/fth/blocks/${height}`)).body.transactions[0].hash).to.equal(hash);
      const account = await call("GET", `/api/v1/fth/accounts/${bob.address}`);
      expect(account.body.fthDollar.balance).to.equal(ethers.parseUnits("10", 18).toString());
      expect((await call("GET", `/api/v1/fth/search?q=${hash}`)).body).to.deep.equal({ type: "tx", hash });
      expect((await call("GET", `/api/v1/fth/search?q=${height}`)).body).to.deep.equal({ type: "block", height });
      expect((await call("GET", "/api/v1/fth/search?q=nobody_here")).status).to.equal(404);
    });

    it("publishes the daily block files and a sync feed for replicas", async () => {
      await fund(ethers.Wallet.createRandom(), "1");
      const files = await call("GET", "/api/v1/fth/files");
      expect(files.status).to.equal(200);
      expect(files.body.files).to.have.length(1);
      const [entry] = files.body.files;
      expect(entry.file).to.match(/^\d{4}\/\d{4}-\d{2}-\d{2}\.jsonl$/);

      const raw = await call("GET", `/api/v1/fth/files/${entry.file}`);
      expect(raw.status).to.equal(200);
      expect(raw.headers["Cache-Control"]).to.equal("no-store");
      expect(raw.body.trim().split("\n").map((line) => JSON.parse(line).h)).to.deep.equal([0, 1]);
      expect((await call("GET", "/api/v1/fth/files/2020/2021-01-01.jsonl")).status).to.equal(404);

      const sync = await call("GET", "/api/v1/fth/sync?from=1");
      expect(sync.body).to.include({ height: 1 });
      expect(sync.body.blocks.map((block) => block.h)).to.deep.equal([1]);
    });
  });
});
