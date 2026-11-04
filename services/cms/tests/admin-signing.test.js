const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { ethers } = require("ethers");
const { OriginApprovals } = require("../../database/approvals");
const source = fs.readFileSync(path.resolve(__dirname, "../../../sites/admin.featheral.com/js/operations.js"), "utf8");

function fixture(wallet) {
  const state = { account: "", active: true, requests: [], restores: [] };
  const provider = { async request({ method, params }) {
    state.requests.push(method);
    if (method === "eth_accounts") return [state.account];
    if (method === "personal_sign") {
      const signature = await wallet.signMessage(ethers.getBytes(params[0]));
      state.afterSign?.();
      return signature;
    }
    throw new Error("Unexpected wallet request");
  } };
  const profile = {
    getProvider: () => state.account ? provider : null,
    snapshot: () => ({ account: state.account }),
    async ensureSigner(address) {
      state.restores.push(address);
      if (state.restoreError) throw state.restoreError;
      state.account = wallet.address;
      return { provider, account: state.account };
    },
  };
  const context = vm.createContext({ window: { FeatheralProfile: profile, addEventListener() {} }, ethers });
  vm.runInContext(source, context);
  return { state, approve: challenge => context.approveAdminAction(challenge, () => state.active) };
}

for (const role of ["origin", "reserve"]) test(`${role} Admin signer is restored before a real approval signature is requested and consumed`, async () => {
  const origin = ethers.Wallet.createRandom(), reserve = ethers.Wallet.createRandom();
  const wallet = role === "origin" ? origin : reserve;
  const approvals = new OriginApprovals({ wallet: origin.address, wallets: [origin.address, reserve.address] });
  const context = { origin: "https://admin.featheral.com", session: "test", wallet: wallet.address };
  const binding = { release: "current" }, challenge = approvals.challenge("SELF SYNC ADMIN SERVER", binding, context, "test");
  const f = fixture(wallet);
  const proof = await f.approve(challenge);
  assert.deepEqual(f.state.restores, [wallet.address]);
  assert.deepEqual(f.state.requests, ["personal_sign", "eth_accounts"]);
  approvals.consume("SELF SYNC ADMIN SERVER", binding, context, proof);
});

test("wallet restoration rejection never requests a signature", async () => {
  const wallet = ethers.Wallet.createRandom(), f = fixture(wallet);
  f.state.restoreError = new Error("Wallet permission rejected");
  await assert.rejects(f.approve({ wallet: wallet.address }), /permission rejected/);
  assert.deepEqual(f.state.requests, []);
});

test("an account change during signing prevents submission even when cached profile state was connected", async () => {
  const wallet = ethers.Wallet.createRandom(), f = fixture(wallet);
  f.state.afterSign = () => { f.state.account = ethers.Wallet.createRandom().address; };
  await assert.rejects(f.approve({ wallet: wallet.address, message: "test" }), /Wallet changed/);
});

test("a view change during signing prevents submission", async () => {
  const wallet = ethers.Wallet.createRandom(), f = fixture(wallet);
  f.state.afterSign = () => { f.state.active = false; };
  await assert.rejects(f.approve({ wallet: wallet.address, message: "test" }), /View or wallet changed/);
});
