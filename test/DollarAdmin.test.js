const { expect } = require("chai");
const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sites", "admin.featheral.com", "js", "operations", "bridge.js"), "utf8");
const stakingSource = fs.readFileSync(path.join(__dirname, "..", "sites", "wallet.featheral.com", "ethereum", "staking.js"), "utf8");
const account = "0x1111111111111111111111111111111111111111";
const address = "0x2222222222222222222222222222222222222222";
const tokenAddress = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const E = (value) => ethers.parseUnits(String(value), 18);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function app(options = {}) {
  const nodes = {};
  const listeners = {};
  const sent = [];
  const simulated = [];
  const confirmations = [];
  const state = {
    connected: true, chainId: 1, deployed: true, initialized: true, paused: false, clock: true, issuanceEnabled: false,
    x: E(100), y: E(100000), staked: E(10), custody: E(115), apr: 600n, year: 5n,
    roles: [true, true, true, true], allowance: 0n, walletBalance: E(100),
    position: { account, fthgAmount: E(10), rewardFthDollar: E(600), maturityGameYear: 6n, claimed: false },
    ...options,
  };
  function node(id) {
    if (!nodes[id]) nodes[id] = {
      value: id === "stakeTerm" ? "1" : "",
      disabled: false, textContent: "", children: [],
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.textContent = children.filter((child) => typeof child === "string").join(""); },
      addEventListener(event, callback) { this[event] = callback; },
    };
    return nodes[id];
  }
  const wallet = { async request() { return `0x${state.chainId.toString(16)}`; } };
  for (const id of ["depositAmount", "initialBudget", "additionalBudget", "baseApr", "gameYear", "gameService", "stakeAmount", "stakeTerm", "stakeId"]) node(id);
  const profile = {
    snapshot: () => ({ account: state.connected ? account : "", chainId: state.chainId }),
    getProvider: () => state.connected ? wallet : null,
  };
  const readValues = {
    fthg: () => tokenAddress,
    poolInitialized: () => state.initialized,
    reserveFthg: () => state.x,
    reserveFthDollar: () => state.y,
    totalStakedFthg: () => state.staked,
    baseAprBps: () => state.apr,
    currentGameYear: () => state.year,
    gameClockInitialized: () => state.clock,
    paused: () => state.paused,
    nextStakeId: () => 2n,
    spotRate: () => state.y * E(1) / state.x,
    allowance: () => state.allowance,
    balanceOf: (owner) => owner === address ? state.custody : state.walletBalance,
    hasRole: (role) => state.roles[[ethers.id("TREASURY_ROLE"), ethers.ZeroHash, ethers.id("PAUSER_ROLE"), ethers.id("GAME_SERVICE_ROLE")].indexOf(role)],
    stakes: () => state.position,
  };
  class Contract {
    constructor(contractAddress) {
      this.address = contractAddress;
      for (const [method, read] of Object.entries(readValues)) this[method] = async (...args) => read(...args);
      for (const method of ["transfer", "initializePool", "syncDepositedFthg", "addFthDollarBudget", "setBaseAprBps", "setGameYear", "grantRole", "pause", "unpause", "approve", "stake", "claimStake"]) {
        this[method] = async (...args) => {
          sent.push({ method, args });
          if (method === "approve") state.allowance = args[1];
          return { hash: "0xabc", async wait() { return { status: 1, logs: [] }; } };
        };
        this[method].staticCall = async (...args) => {
          simulated.push({ method, args });
          if (state.simulationFailure) throw new Error("Simulation reverted");
        };
      }
    }
    connect() { return this; }
  }
  const helpers = {
    assertActive() {},
    listen(event, listener) { listeners[event] = listener; },
    el: (tag, props) => props,
    fth: (value) => `${Number(ethers.formatUnits(value, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} FTH$`,
    stat: (label, value) => ({ label, value }),
    async settleBridge() { return { status: "settled" }; },
    async api(url) {
      if (url !== "/stats") throw new Error(`Unexpected Dollar API path ${url}`);
      return { monetaryPolicy: { issuanceEnabled: state.issuanceEnabled } };
    },
    async requireIssuance() {
      if (!state.issuanceEnabled) throw new Error("FTH$ issuance is closed.");
    },
    async json(url) {
      return url === "/api/v1/gold/stats" ? { bridge: { address, deployed: state.deployed } } : { abi: [] };
    },
    async goldApi(url) {
      if (url !== "/stats") throw new Error(`Unexpected API path ${url}`);
      return { bridge: { address, deployed: state.deployed } };
    },
  };
  const controllers = {};
  vm.runInNewContext(options.wallet ? stakingSource : source, {
    location: { origin: "http://dollar.localhost:8080" },
    document: { getElementById: node },
    window: {
      FeatheralAdminControllers: controllers,
      FeatheralProfile: profile,
      FTH: helpers,
      addEventListener(event, listener) { listeners[event] = listener; },
      AdminKit: helpers,
    },
    FeatheralProfile: profile,
    async fetch(url) {
      if (url !== "/shared/abi/FthgGameBridge.json") throw new Error(`Unexpected artifact path ${url}`);
      return { ok: true, async json() { return { abi: [] }; } };
    },
    ethers: {
      ...ethers, Contract,
      JsonRpcProvider: class { async getBlockNumber() { return 100; } },
      BrowserProvider: class {
        async getNetwork() { return { chainId: BigInt(state.chainId) }; }
        async getSigner() { return {}; }
      },
    },
    confirm(message) { confirmations.push(message); return state.confirm !== false; },
  });
  if (!options.wallet) controllers.bridge({ querySelector: selector => node(selector.slice(1)) }, helpers);
  if (options.wallet) nodes.bridgeStatus = node("stakingStatus");
  return {
    state, nodes, sent, simulated, confirmations,
    async submit(id) { await node(id).submit({ preventDefault() {} }); await settle(); },
    async click(id) { await node(id).click(); await settle(); },
    async refresh() { await node(options.wallet ? "refreshStaking" : "refreshBridge").click(); },
    async walletChanged() { listeners["featheral:wallet"](); await settle(); },
  };
}

describe("Dollar bridge admin", () => {
  it("reports reserves separately from staking custody and gates each contract role", async () => {
    const ui = app({ roles: [true, false, false, false] });
    await settle();
    expect(ui.nodes.pendingDeposit.textContent).to.include("5.0 FTHG");
    expect(ui.nodes.syncButton.disabled).to.equal(false);
    expect(ui.nodes.budgetButton.disabled).to.equal(false);
    expect(ui.nodes.serviceButton.disabled).to.equal(true);
    expect(ui.nodes.gameYearButton.disabled).to.equal(true);
    expect(ui.nodes.pauseButton.disabled).to.equal(true);
  });

  it("disables writes when no bridge is deployed", async () => {
    const ui = app({ deployed: false });
    await settle();
    expect(ui.nodes.bridgeAccess.textContent).to.include("not deployed/configured");
    expect(ui.nodes.depositButton.disabled).to.equal(true);
  });

  it("keeps legacy mature claims available while paused only when Dollar permits issuance", async () => {
    const ui = app({ wallet: true, paused: true, year: 6n, issuanceEnabled: true });
    await settle();
    ui.nodes.stakeId.value = "1";
    await ui.submit("claimForm");
    expect(ui.nodes.stakeButton.disabled).to.equal(true);
    expect(ui.nodes.claimButton.disabled).to.equal(false);
  });

  it("previews the exact contract simple-interest formula and supported term", async () => {
    const ui = app({ wallet: true, y: E("100001.2345") });
    await settle();
    ui.nodes.stakeAmount.value = "10";
    ui.nodes.stakeTerm.value = "2";
    ui.nodes.stakeAmount.input();
    expect(ui.nodes.stakeQuote.textContent).to.include("1,200.01 FTH$");
    expect(ui.nodes.stakeQuote.textContent).to.include("game year 7");
  });

  it("deposits only the selected wallet's FTHG after simulation and confirmation", async () => {
    const ui = app();
    await settle();
    ui.nodes.depositAmount.value = "5";
    await ui.submit("depositForm");
    expect(ui.sent[0]).to.deep.equal({ method: "transfer", args: [address, E(5)] });
    expect(ui.simulated[0]).to.deep.equal(ui.sent[0]);
  });

  it("requires an exact opening budget before initializing", async () => {
    const ui = app({ initialized: false, staked: 0n, custody: E(100) });
    await settle();
    ui.nodes.initialBudget.value = "99999";
    await ui.submit("initializeForm");
    expect(ui.sent).to.deep.equal([]);
    expect(ui.nodes.bridgeStatus.textContent).to.include("exactly 100,000 FTH$");
    ui.nodes.initialBudget.value = "100000";
    await ui.submit("initializeForm");
    expect(ui.sent[0]).to.deep.equal({ method: "initializePool", args: [E(100000)] });
  });

  it("syncs only actual deposits excluding locked principal", async () => {
    const ui = app();
    await settle();
    await ui.click("syncButton");
    expect(ui.confirmations[0]).to.include("5.0 FTHG");
    expect(ui.sent[0].method).to.equal("syncDepositedFthg");
    ui.state.custody = ui.state.x + ui.state.staked;
    await ui.refresh();
    expect(ui.nodes.syncButton.disabled).to.equal(true);
  });

  it("sets APR in exact basis points without floating point rounding", async () => {
    const ui = app();
    await settle();
    ui.nodes.baseApr.value = "6.01";
    await ui.submit("aprForm");
    expect(ui.sent[0]).to.deep.equal({ method: "setBaseAprBps", args: [601n] });
    ui.nodes.baseApr.value = "100.01";
    await ui.submit("aprForm");
    expect(ui.sent).to.have.length(1);
    expect(ui.nodes.bridgeStatus.textContent).to.include("cannot exceed 100%");
  });

  it("rejects negative, zero and over-precision budget amounts", async () => {
    const ui = app();
    await settle();
    for (const value of ["-1", "0", "1.0000000000000000001"]) {
      ui.nodes.additionalBudget.value = value;
      await ui.submit("budgetForm");
    }
    expect(ui.sent).to.deep.equal([]);
  });

  it("adds a positive approved budget without crediting a wallet locally", async () => {
    const ui = app();
    await settle();
    ui.nodes.additionalBudget.value = "1000";
    await ui.submit("budgetForm");
    expect(ui.sent[0]).to.deep.equal({ method: "addFthDollarBudget", args: [E(1000)] });
    expect(ui.confirmations[0]).to.include("does not credit a wallet");
  });

  it("grants the game-service role only to a valid nonzero address", async () => {
    const ui = app();
    await settle();
    ui.nodes.gameService.value = ethers.ZeroAddress;
    await ui.submit("serviceForm");
    expect(ui.sent).to.deep.equal([]);
    ui.nodes.gameService.value = account;
    await ui.submit("serviceForm");
    expect(ui.sent[0]).to.deep.equal({ method: "grantRole", args: [ethers.id("GAME_SERVICE_ROLE"), account] });
  });

  it("sends the existing pause and unpause methods", async () => {
    const ui = app();
    await settle();
    await ui.click("pauseButton");
    ui.state.paused = true;
    await ui.refresh();
    await ui.click("resumeButton");
    expect(ui.sent.map((tx) => tx.method)).to.deep.equal(["pause", "unpause"]);
  });

  it("never decreases the authoritative game clock", async () => {
    const ui = app();
    await settle();
    ui.nodes.gameYear.value = "4";
    await ui.submit("gameYearForm");
    expect(ui.sent).to.deep.equal([]);
    ui.nodes.gameYear.value = "6";
    await ui.submit("gameYearForm");
    expect(ui.sent[0]).to.deep.equal({ method: "setGameYear", args: [6n] });
  });

  it("stakes with exact approval and a wallet-derived game account when Dollar permits issuance", async () => {
    const ui = app({ wallet: true, issuanceEnabled: true });
    await settle();
    ui.nodes.stakeAmount.value = "10";
    await ui.submit("stakeForm");
    expect(ui.sent.map((tx) => tx.method)).to.deep.equal(["approve", "stake"]);
    expect(ui.sent[0].args).to.deep.equal([address, E(10)]);
    expect(ui.sent[1].args).to.deep.equal([E(10), 1n, ethers.zeroPadValue(account, 32)]);
  });

  it("does not stake when reward budget is exhausted or clock is unavailable", async () => {
    const ui = app({ wallet: true, y: 0n });
    await settle();
    ui.nodes.stakeAmount.value = "10";
    await ui.submit("stakeForm");
    expect(ui.sent).to.deep.equal([]);
    ui.state.y = E(100000);
    ui.state.clock = false;
    await ui.refresh();
    expect(ui.nodes.stakeButton.disabled).to.equal(true);
  });

  it("rejects unsupported staking terms before approval", async () => {
    const ui = app({ wallet: true, issuanceEnabled: true });
    await settle();
    ui.nodes.stakeAmount.value = "10";
    ui.nodes.stakeTerm.value = "3";
    await ui.submit("stakeForm");
    expect(ui.sent).to.deep.equal([]);
    expect(ui.nodes.bridgeStatus.textContent).to.include("Unsupported staking term");
  });

  it("claims only a mature unclaimed stake when Dollar permits issuance", async () => {
    const ui = app({ wallet: true, year: 6n, issuanceEnabled: true });
    await settle();
    ui.nodes.stakeId.value = "1";
    await ui.submit("claimForm");
    await ui.click("claimButton");
    expect(ui.sent[0]).to.deep.equal({ method: "claimStake", args: [1n] });
    ui.state.position.claimed = true;
    await ui.submit("claimForm");
    expect(ui.nodes.claimButton.disabled).to.equal(true);
  });
  it("blocks stakes and mature reward claims under the closed Dollar policy while allowing inspection", async () => {
    const ui = app({ wallet: true, year: 6n });
    await settle();
    expect(ui.nodes.stakeButton.disabled).to.equal(true);
    ui.nodes.stakeId.value = "1";
    await ui.submit("claimForm");
    expect(ui.nodes.claimButton.disabled).to.equal(true);
    ui.nodes.stakeAmount.value = "10";
    await ui.submit("stakeForm");
    await ui.click("claimButton");
    expect(ui.sent).to.deep.equal([]);
    expect(ui.nodes.bridgeStatus.textContent).to.include("issuance is closed");
  });

  it("does not submit after cancellation or a failed simulation", async () => {
    const ui = app({ confirm: false });
    await settle();
    ui.nodes.depositAmount.value = "1";
    await ui.submit("depositForm");
    expect(ui.sent).to.deep.equal([]);
    ui.state.confirm = true;
    ui.state.simulationFailure = true;
    await ui.submit("depositForm");
    expect(ui.sent).to.deep.equal([]);
    expect(ui.nodes.bridgeStatus.textContent).to.include("Simulation reverted");
  });

  it("disables management when the wallet changes network or disconnects", async () => {
    const ui = app();
    await settle();
    ui.state.chainId = 5;
    await ui.walletChanged();
    expect(ui.nodes.depositButton.disabled).to.equal(true);
    ui.state.connected = false;
    await ui.walletChanged();
    expect(ui.nodes.budgetButton.disabled).to.equal(true);
  });
});
