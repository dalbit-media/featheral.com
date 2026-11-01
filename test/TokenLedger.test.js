const { expect } = require("chai");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");
const { FthLedger, BlockStore } = require("../services/fth-ledger/ledger");
const { canonical, blockHash } = require("../services/fth-ledger/codec");
const { transferMessage, walletAccountId } = require("../services/fth-ledger/transfer");
const { ServiceAuthenticator, canonicalRequest } = require("../services/token-api/auth");

const FTH = (value) => ethers.parseUnits(String(value), 18).toString();
async function rejects(promise, text) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  expect(error, `expected rejection containing "${text}"`).to.be.an("error");
  expect(error.message).to.include(text);
}
const ethTx = (n) => `0x${n.toString(16).padStart(64, "0")}`;

describe("FTH$ layer-3 ledger", () => {
  let directory;
  const open = [];

  function ledger(name, options = {}) {
    const instance = new FthLedger({ directory: path.join(directory, name), blockIntervalMs: 0, ...options }).open();
    open.push(instance);
    return instance;
  }

  const credit = (target, accountId, amount, n = 1) => target.submit({
    id: `eth:1:${ethTx(n)}:0`, kind: "CREDIT", account: accountId, amount: FTH(amount), data: { src: "FthgConverted", tx: ethTx(n) },
  });

  async function signedTransfer(wallet, { to, amount, nonce, memo = "", issuedAt = new Date().toISOString() }) {
    const transfer = { wallet: wallet.address, to, amount: FTH(amount), nonce, memo, issuedAt };
    const recipient = ethers.isAddress(to) ? walletAccountId(to) : to;
    const signature = await wallet.signMessage(transferMessage({ ...transfer, to: recipient }));
    return {
      id: `transfer:${walletAccountId(wallet.address)}:${nonce}`,
      kind: "TRANSFER",
      account: walletAccountId(wallet.address),
      amount: transfer.amount,
      data: { w: wallet.address, to: recipient, n: nonce, m: memo, ts: issuedAt, sig: signature },
    };
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fth-ledger-"));
  });

  afterEach(() => {
    while (open.length) open.pop().close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates a genesis block and seals idempotent bridge credits", async () => {
    const writer = ledger("writer");
    expect(writer.height).to.equal(0);
    expect(writer.block(0).transactions[0].kind).to.equal("GENESIS");

    const account = walletAccountId(ethers.Wallet.createRandom().address);
    const receipt = await credit(writer, account, 2500);
    expect(receipt.height).to.equal(1);
    expect(writer.balance(account)).to.deep.equal({ balance: FTH(2500), reserved: "0", available: FTH(2500) });

    const again = await credit(writer, account, 2500);
    expect(again.hash).to.equal(receipt.hash);
    expect(writer.summary()).to.include({ supply: FTH(2500), holders: 1, credits: 1, height: 1 });

    await rejects(writer.submit({ id: `eth:1:${ethTx(1)}:0`, kind: "CREDIT", account, amount: FTH(1), data: { src: "FthgConverted", tx: ethTx(1) } }), "Idempotency key");
    await rejects(writer.submit({ id: "bad-credit", kind: "CREDIT", account, amount: FTH(1), data: { src: "Manual", tx: ethTx(9) } }), "verified bridge event");
  });

  it("applies wallet-signed transfers with strict nonces and balance checks", async () => {
    const writer = ledger("writer");
    const alice = ethers.Wallet.createRandom();
    const bob = ethers.Wallet.createRandom();
    const aliceId = walletAccountId(alice.address);
    const bobId = walletAccountId(bob.address);
    await credit(writer, aliceId, 100);

    const first = await signedTransfer(alice, { to: bob.address, amount: 40, nonce: 1, memo: "lunch" });
    const receipt = await writer.submit(first, { fresh: true });
    expect(writer.balance(aliceId).balance).to.equal(FTH(60));
    expect(writer.balance(bobId).balance).to.equal(FTH(40));
    expect(writer.nonce(aliceId)).to.equal(1);
    expect(writer.tx(receipt.hash)).to.include({ kind: "TRANSFER", from: aliceId, to: bobId, memo: "lunch", fromWallet: alice.address, toWallet: bob.address, status: "sealed" });
    expect(writer.accountHistory(bobId).map((tx) => tx.hash)).to.deep.equal([receipt.hash]);

    const replay = await signedTransfer(alice, { to: bob.address, amount: 1, nonce: 1 });
    replay.id = "replayed-nonce";
    await rejects(writer.submit(replay, { fresh: true }), "nonce must be 2");
    await rejects(writer.submit(await signedTransfer(alice, { to: bob.address, amount: 61, nonce: 2 }), { fresh: true }), "Insufficient");

    const forged = await signedTransfer(bob, { to: bob.address, amount: 1, nonce: 2 });
    const stolen = await signedTransfer(alice, { to: bob.address, amount: 1, nonce: 2 });
    stolen.data.sig = forged.data.sig;
    await rejects(writer.submit(stolen, { fresh: true }), "not made by the sending wallet");

    const stale = await signedTransfer(alice, { to: bob.address, amount: 1, nonce: 2, issuedAt: new Date(Date.now() - 3_600_000).toISOString() });
    await rejects(writer.submit(stale, { fresh: true }), "Transfer signature expired");
    expect(writer.summary()).to.include({ transfers: 1, transferVolume: FTH(40) });
  });

  it("reserves, settles, and releases FTH$ redemptions without overdrawing", async () => {
    const writer = ledger("writer");
    const recipient = ethers.Wallet.createRandom().address;
    const account = walletAccountId(recipient);
    await credit(writer, account, 100);
    const reserve = (r, amount) => writer.submit({ id: `reserve:${r}`, kind: "RESERVE", account, amount: FTH(amount), data: { r, to: recipient, exp: Date.now() + 60_000 } });
    const first = `0x${"01".repeat(32)}`;
    const second = `0x${"02".repeat(32)}`;

    await reserve(first, 70);
    expect(writer.balance(account)).to.deep.equal({ balance: FTH(100), reserved: FTH(70), available: FTH(30) });
    await rejects(reserve(second, 31), "Insufficient available");
    await reserve(second, 30);

    await writer.submit({ id: `settle:${first}`, kind: "SETTLE", account, amount: FTH(70), data: { r: first, tx: ethTx(77) } });
    await writer.submit({ id: `release:${second}`, kind: "RELEASE", account, amount: FTH(30), data: { r: second } });
    expect(writer.balance(account)).to.deep.equal({ balance: FTH(30), reserved: "0", available: FTH(30) });
    expect(writer.summary()).to.include({ supply: FTH(30), settlements: 1, pendingRedemptions: 0 });
    await rejects(writer.submit({ id: "settle-again", kind: "SETTLE", account, amount: FTH(70), data: { r: first, tx: ethTx(78) } }), "not reserved");
  });

  it("stores canonical minified blocks in daily files under yearly folders", async () => {
    const writer = ledger("writer");
    await credit(writer, walletAccountId(ethers.Wallet.createRandom().address), 5);
    const today = new Date().toISOString().slice(0, 10);
    const relative = `${today.slice(0, 4)}/${today}.jsonl`;
    expect(writer.store.files()).to.deep.equal([relative]);

    const lines = fs.readFileSync(path.join(directory, "writer", today.slice(0, 4), `${today}.jsonl`), "utf8").trim().split("\n");
    expect(lines).to.have.length(2);
    for (const line of lines) expect(canonical(JSON.parse(line))).to.equal(line);

    const [manifest] = writer.store.manifest();
    expect(manifest).to.include({ file: relative, firstHeight: 0, lastHeight: 1, blocks: 2, transactions: 2 });
    expect(manifest.sha256).to.match(/^[0-9a-f]{64}$/);

    const store = new BlockStore(path.join(directory, "days"));
    store.append({ h: 0, t: Date.UTC(2025, 11, 31, 23, 59), x: [] });
    store.append({ h: 1, t: Date.UTC(2026, 0, 1, 0, 1), x: [] });
    expect(store.files()).to.deep.equal(["2025/2025-12-31.jsonl", "2026/2026-01-01.jsonl"]);
    expect(() => store.absolute("../escape.jsonl")).to.throw("Unknown ledger file");
  });

  it("rebuilds identical state from disk and drops a partially written tail line", async () => {
    const writer = ledger("writer");
    const alice = ethers.Wallet.createRandom();
    const bobId = walletAccountId(ethers.Wallet.createRandom().address);
    await credit(writer, walletAccountId(alice.address), 10);
    await writer.submit(await signedTransfer(alice, { to: bobId, amount: 4, nonce: 1 }), { fresh: true });
    const before = writer.summary();
    writer.close();
    open.length = 0;

    const file = writer.store.absolute(writer.store.files().at(-1));
    fs.appendFileSync(file, '{"h":99,"partial');
    const reopened = ledger("writer");
    expect(reopened.summary()).to.deep.equal(before);
    expect(reopened.nonce(walletAccountId(alice.address))).to.equal(1);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).to.equal(true);
    await credit(reopened, bobId, 1, 2);
    expect(reopened.height).to.equal(before.height + 1);
  });

  it("replicates writer-signed blocks and rejects tampered or unsigned blocks", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const writer = ledger("writer", { signingKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) });
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const account = walletAccountId(ethers.Wallet.createRandom().address);
    await credit(writer, account, 50);
    await credit(writer, account, 25, 2);
    const blocks = writer.blocksFrom(0);
    expect(blocks.every((block) => typeof block.S === "string")).to.equal(true);

    const replica = ledger("replica", { mode: "reader", writerPublicKey: publicKey });
    expect(replica.height).to.equal(-1);
    replica.importBlock(blocks[0]);

    const tampered = structuredClone(blocks[1]);
    tampered.x[0].v = FTH(5000);
    expect(() => replica.importBlock(tampered)).to.throw("hash does not verify");
    tampered.H = blockHash(tampered);
    expect(() => replica.importBlock(tampered)).to.throw("signature does not verify");
    const unsigned = structuredClone(blocks[1]);
    delete unsigned.S;
    expect(() => replica.importBlock(unsigned)).to.throw("signature");

    for (const block of blocks.slice(1)) replica.importBlock(block);
    expect(replica.summary()).to.deep.include({ height: writer.height, tipHash: writer.tipHash, supply: FTH(75) });
    expect(replica.store.files()).to.deep.equal(writer.store.files());
    await rejects(replica.submit({ id: "x", kind: "CREDIT", account, amount: "1", data: { src: "FthgConverted", tx: ethTx(3) } }), "read-only");
  });

  it("signs and verifies service requests while rejecting nonce replay and tampering", () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce_0123456789abcdef";
    const body = JSON.stringify({ txHash: "0xabc" });
    const message = canonicalRequest("POST", "/api/v1/settlements", timestamp, nonce, body);
    const signature = crypto.sign(null, Buffer.from(message), keys.privateKey).toString("base64");
    const auth = new ServiceAuthenticator({ "game-api": { role: "game", publicKey } });
    const headers = { "x-service-id": "game-api", "x-service-timestamp": timestamp, "x-service-nonce": nonce, "x-service-signature": signature };
    expect(auth.verify(headers, "POST", "/api/v1/settlements", body, "game").id).to.equal("game-api");
    expect(() => auth.verify(headers, "POST", "/api/v1/settlements", body, "game")).to.throw("nonce");
    const freshHeaders = { ...headers, "x-service-nonce": "nonce_abcdef0123456789" };
    expect(() => auth.verify(freshHeaders, "POST", "/api/v1/settlements", '{"txHash":"tampered"}', "game")).to.throw("signature");
  });
});
