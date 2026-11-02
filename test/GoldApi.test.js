const { expect } = require("chai");
const http = require("node:http");
const { ethers } = require("ethers");
const { createGoldApi, TOKEN_ADDRESS } = require("../services/gold/server");

describe("Gold-owned Ethereum RPC", () => {
  it("reads exact mainnet FTHG wallet balances and rejects other chains", async () => {
    let chainId = 1n;
    const reader = createGoldApi({ env: {}, provider: {
      async getNetwork() { return { chainId }; }, async getBlockNumber() { return 123; },
      async call(tx) { expect(tx.to.toLowerCase()).to.equal(TOKEN_ADDRESS.toLowerCase()); return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1234567890123456789n]); },
    } });
    try {
      const result = await reader.walletBalance(`0x${"11".repeat(20)}`);
      expect(result.balance).to.equal("1234567890123456789"); expect(result.block).to.equal(123); expect(result.chainId).to.equal(1);
      chainId = 5n;
      await expect(reader.walletBalance(`0x${"11".repeat(20)}`)).to.be.rejectedWith("Mainnet");
    } finally { reader.close(); }
  });
  it("owns native ETH wallet reads used by both the public Gold route and Note summaries", async () => {
    const address = `0x${"11".repeat(20)}`, requests = [];
    const snapshot = { balances: [{ chainId: 1, balance: "123", error: null }], market: { usdPerEth: null, error: "No feed" } };
    const gold = createGoldApi({ env: {}, provider: {}, nativeReader: async owner => { requests.push(owner); return snapshot; } });
    const server = http.createServer((req, res) => gold.handle(req, res));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(await gold.nativeBalance(address)).to.equal(snapshot);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/gold/native/wallets/${address}`);
      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal(snapshot);
      expect(requests).to.deep.equal([address, address]);
    } finally { await new Promise(resolve => server.close(resolve)); gold.close(); }
  });
  let api, server, base, calls;
  beforeEach(async () => {
    calls = [];
    api = createGoldApi({ env: {}, logger: { error() {}, warn() {} }, provider: {
      async send(method, params) { calls.push({ method, params }); return "0x1"; },
    } });
    server = http.createServer(async (req, res) => {
      if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); api.close(); });
  const rpc = body => fetch(`${base}/api/v1/gold/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("reports service health without claiming that Ethereum was checked or accessing upstream RPC", async () => {
    const response = await fetch(`${base}/api/v1/gold/health`);
    expect(response.status).to.equal(200);
    expect(await response.json()).to.include({ status: "ok", chainId: 1, bridgeConfigured: false, ethereumStatus: "not-checked" });
    expect(calls).to.have.length(0);
  });
  it("permits public token and DEX contract reads, but never wallet writes", async () => {
    const read = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TOKEN_ADDRESS, data: "0x18160ddd" }, "latest"] });
    expect(read.status).to.equal(200);
    expect(await read.json()).to.deep.equal({ jsonrpc: "2.0", id: 1, result: "0x1" });
    const write = await rpc({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x1234"] });
    expect(write.status).to.equal(403);
    expect(calls).to.have.length(1);
  });
  it("rejects malformed IDs, oversized batches, fee histories and unbounded log scans before upstream access", async () => {
    for (const body of [
      { jsonrpc: "2.0", id: {}, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: ["unexpected"] },
      { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: TOKEN_ADDRESS, fromBlock: "0x0", toBlock: "latest" }] },
      { jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: ["0x10000", "latest", []] },
      Array.from({ length: 51 }, (_, id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] })),
    ]) expect((await rpc(body)).status).to.equal(400);
    expect(calls).to.have.length(0);
  });
  it("bounds aggregate RPC work per caller", async () => {
    const batch = Array.from({ length: 50 }, (_, id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] }));
    for (let i = 0; i < 4; i++) expect((await rpc(batch)).status).to.equal(200);
    expect((await rpc(batch)).status).to.equal(429);
    expect(calls).to.have.length(200);
  });
  it("verifies finality, canonical blocks and the configured bridge emitter before exposing ledger events", async () => {
    const bridge = `0x${"11".repeat(20)}`, wallet = `0x${"22".repeat(20)}`, account = `0x${"00".repeat(12)}${wallet.slice(2)}`;
    const txHash = `0x${"ab".repeat(32)}`, blockHash = `0x${"cd".repeat(32)}`;
    const iface = new ethers.Interface(require("../shared/abi/FthgGameBridge.json").abi);
    const encoded = iface.encodeEventLog(iface.getEvent("FthgConverted"), [wallet, account, 1n, 1000n, 10n, 10000n]);
    const receipt = { hash: txHash, status: 1, blockNumber: 100, blockHash, logs: [{ ...encoded, address: bridge, index: 0 }] };
    let head = 100;
    const gold = createGoldApi({ env: { GOLD_API_BRIDGE_ADDRESS: bridge }, provider: {
      async getTransactionReceipt() { return receipt; }, async getBlockNumber() { return head; },
      async getNetwork() { return { chainId: 1n }; },
      async getBlock() { return { hash: blockHash, timestamp: Math.floor(Date.now() / 1000) }; },
    } });
    expect((await gold.verifiedEvents(txHash)).pending).to.equal(true);
    head = 111;
    const finalized = await gold.verifiedEvents(txHash);
    expect(finalized.pending).to.equal(false);
    expect(finalized.events).to.have.length(1);
    expect(finalized.events[0].parsed.args.gameAccountId).to.equal(account);
    receipt.logs[0].address = TOKEN_ADDRESS;
    expect((await gold.verifiedEvents(txHash)).events).to.have.length(0);
    receipt.blockHash = ethers.ZeroHash;
    await expect(gold.verifiedEvents(txHash)).to.be.rejectedWith("canonical");
    receipt.status = 0;
    await expect(gold.verifiedEvents(txHash)).to.be.rejectedWith("reverted");
    gold.close();
  });
});
