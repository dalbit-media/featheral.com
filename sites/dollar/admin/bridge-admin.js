"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const { json, stat, el } = window.AdminKit;
  const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const ONE = 10n ** 18n;
  const readProvider = new ethers.JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1);
  const tokenAbi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
  const readToken = new ethers.Contract(TOKEN, tokenAbi, readProvider);
  const buttons = ["depositButton", "initializeButton", "syncButton", "budgetButton", "pauseButton", "resumeButton", "aprButton", "gameYearButton", "serviceButton"];
  let bridge;
  let snapshot;
  let busy = false;
  let generation = 0;
  let abi;
  const units = (value) => ethers.formatUnits(value, 18);
  const errorText = (error) => error.shortMessage || error.message || String(error);

  function amount(id) {
    const value = $(id).value.trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error("Enter a positive amount with at most 18 decimal places.");
    const parsed = ethers.parseUnits(value, 18);
    if (parsed <= 0n || parsed > ethers.MaxUint256) throw new Error("Amount is outside the positive uint256 range.");
    return parsed;
  }
  function integer(id, allowZero = false) {
    const value = $(id).value.trim();
    if (!/^\d+$/.test(value)) throw new Error("Enter a whole non-negative number.");
    const parsed = BigInt(value);
    if ((!allowZero && parsed === 0n) || parsed > ethers.MaxUint256) throw new Error("Number is outside the allowed uint256 range.");
    return parsed;
  }
  function aprBps() {
    const value = $("baseApr").value.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter an APR from 0 to 100 with at most two decimal places.");
    const bps = ethers.parseUnits(value, 2);
    if (bps > 10000n) throw new Error("Base APR cannot exceed 100%.");
    return bps;
  }
  function status(message, failed = false) {
    $("bridgeStatus").className = `status${failed ? " err" : ""}`;
    $("bridgeStatus").replaceChildren(message);
  }
  function controls() {
    for (const id of buttons) $(id).disabled = true;
    $("refreshBridge").disabled = busy;
    if (busy || !snapshot) return;
    const { connected, treasury, admin, pauser, service, initialized, paused, x, pending } = snapshot;
    $("depositButton").disabled = !connected;
    $("initializeButton").disabled = !treasury || initialized;
    $("syncButton").disabled = !treasury || !initialized || pending <= 0n;
    $("budgetButton").disabled = !treasury || !initialized || x === 0n;
    $("aprButton").disabled = !treasury;
    $("gameYearButton").disabled = !service;
    $("serviceButton").disabled = !admin;
    $("pauseButton").disabled = !pauser || paused;
    $("resumeButton").disabled = !pauser || !paused;
  }
  async function refresh() {
    const request = ++generation;
    snapshot = null;
    bridge = null;
    controls();
    $("bridgeAccess").textContent = "Reading bridge and wallet roles...";
    try {
      const data = await json("/api/v1/stats");
      const address = data.bridge?.address;
      if (!data.bridge?.deployed || !ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error("Bridge is not deployed/configured. Deploy the existing FthgGameBridge and configure TOKEN_API_BRIDGE_ADDRESS before using these controls.");
      if (!abi) {
        const artifact = await json("/shared/abi/FthgGameBridge.json");
        if (!Array.isArray(artifact.abi)) throw new Error("Bridge ABI is invalid.");
        abi = artifact.abi;
      }
      const contract = new ethers.Contract(address, abi, readProvider);
      const blockTag = await readProvider.getBlockNumber();
      if ((await contract.fthg({ blockTag })).toLowerCase() !== TOKEN.toLowerCase()) throw new Error("Configured bridge does not use the canonical FTHG token.");
      const account = window.FeatheralProfile.snapshot().account;
      const wallet = window.FeatheralProfile.getProvider();
      const connected = Boolean(account && wallet && Number(await wallet.request({ method: "eth_chainId" })) === 1);
      const [initialized, x, y, staked, custody, apr, year, clock, paused, nextStakeId, roles] = await Promise.all([
        contract.poolInitialized({ blockTag }), contract.reserveFthg({ blockTag }), contract.reserveFthDollar({ blockTag }),
        contract.totalStakedFthg({ blockTag }), readToken.balanceOf(address, { blockTag }), contract.baseAprBps({ blockTag }),
        contract.currentGameYear({ blockTag }), contract.gameClockInitialized({ blockTag }), contract.paused({ blockTag }),
        contract.nextStakeId({ blockTag }),
        connected ? Promise.all([ethers.id("TREASURY_ROLE"), ethers.ZeroHash, ethers.id("PAUSER_ROLE"), ethers.id("GAME_SERVICE_ROLE")].map((role) => contract.hasRole(role, account, { blockTag }))) : [false, false, false, false],
      ]);
      if (request !== generation || account !== window.FeatheralProfile.snapshot().account || wallet !== window.FeatheralProfile.getProvider()) return;
      bridge = contract;
      snapshot = { address, account, wallet, connected, initialized, x, y, staked, custody, apr, year, clock, paused, pending: custody - x - staked, treasury: roles[0], admin: roles[1], pauser: roles[2], service: roles[3] };
      const roleNames = ["Treasury", "Admin", "Pauser", "Game service"].filter((_, index) => roles[index]);
      $("bridgeAccess").replaceChildren("Bridge ", el("code", { textContent: address }), ` | block ${blockTag} | ${paused ? "Paused" : "Active"} | ${connected ? roleNames.join(", ") || "Connected: no management roles (staking only)" : "Read-only: connect a wallet on Mainnet"}`);
      $("bridgeStats").replaceChildren(stat("Curve FTHG", `${units(x)} FTHG`), stat("Available FTH$ budget", `${units(y)} FTH$`), stat("Custody (including stakes)", `${units(custody)} FTHG`), stat("Spot FTH$ / FTHG", initialized && x > 0n && y > 0n ? units(y * ONE / x) : "Pool unavailable"));
      $("stakingStats").replaceChildren(stat("Locked principal", `${units(staked)} FTHG`), stat("Base APR for new stakes", `${ethers.formatUnits(apr, 2)}%`), stat("Game clock", clock ? year.toString() : "Not initialized"), stat("Stakes created", (nextStakeId - 1n).toString()));
      $("pendingDeposit").textContent = snapshot.pending < 0n ? "WARNING: custody is below accounted curve + stake balances. Do not fund or initialize until investigated." : `${units(snapshot.pending)} FTHG deposited but not yet in the curve.`;
      if (document.activeElement !== $("baseApr")) $("baseApr").value = ethers.formatUnits(apr, 2);
      controls();
    } catch (error) {
      if (request !== generation) return;
      $("bridgeAccess").textContent = errorText(error);
      $("bridgeStats").replaceChildren();
      $("stakingStats").replaceChildren();
      status(`Bridge refresh failed: ${errorText(error)}`, true);
      controls();
    }
  }
  async function transaction(label, action) {
    if (busy) return;
    busy = true;
    controls();
    try {
      const current = snapshot;
      if (!bridge || !current?.connected) throw new Error("Connect a wallet on Ethereum Mainnet and refresh the bridge.");
      if (current.wallet !== window.FeatheralProfile.getProvider() || current.account !== window.FeatheralProfile.snapshot().account) throw new Error("Wallet changed; refresh before submitting.");
      const provider = new ethers.BrowserProvider(current.wallet);
      if (Number((await provider.getNetwork()).chainId) !== 1) throw new Error("Switch to Ethereum Mainnet.");
      const signer = await provider.getSigner(current.account);
      const signedBridge = bridge.connect(signer);
      const token = readToken.connect(signer);
      const send = async (contract, method, args = []) => {
        if (current.wallet !== window.FeatheralProfile.getProvider() || current.account !== window.FeatheralProfile.snapshot().account) throw new Error("Wallet changed before transaction submission.");
        if (Number(await current.wallet.request({ method: "eth_chainId" })) !== 1) throw new Error("Wallet left Ethereum Mainnet before transaction submission.");
        await contract[method].staticCall(...args);
        status(`${label}: confirm in your wallet...`);
        const tx = await contract[method](...args);
        $("bridgeStatus").replaceChildren("Submitted: ", el("a", { href: `https://etherscan.io/tx/${tx.hash}`, target: "_blank", rel: "noopener noreferrer", title: tx.hash, textContent: `${tx.hash.slice(0, 10)}...${tx.hash.slice(-6)}` }), " | waiting for confirmation...");
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("Transaction was not successfully confirmed.");
        $("bridgeStatus").replaceChildren(`${label} confirmed on Ethereum. Ledger indexing and configured confirmations are separate. `, el("a", { href: `https://etherscan.io/tx/${tx.hash}`, target: "_blank", rel: "noopener noreferrer", textContent: "View transaction" }));
        return receipt;
      };
      await action({ bridge: signedBridge, token, current, send });
    } catch (error) {
      status(error.code === 4001 || error.code === "ACTION_REJECTED" ? "Request cancelled in the wallet." : `${label} failed: ${errorText(error)}`, true);
    } finally {
      busy = false;
      await refresh();
    }
  }
  function form(id, label, action) {
    $(id).addEventListener("submit", (event) => { event.preventDefault(); transaction(label, action); });
  }
  form("depositForm", "Deposit FTHG", async ({ token, current, send }) => {
    const value = amount("depositAmount");
    if (value > await token.balanceOf(current.account)) throw new Error("Deposit exceeds your FTHG balance.");
    if (confirm(`Transfer ${units(value)} FTHG from ${current.account} to ${current.address}? This cannot be withdrawn through the existing treasury contract. It must later be initialized/synced into the curve.`)) await send(token, "transfer", [current.address, value]);
  });
  form("initializeForm", "Initialize pool", async ({ bridge, token, current, send }) => {
    const custody = await token.balanceOf(current.address);
    const budget = amount("initialBudget");
    if (custody === 0n || budget !== custody * 1000n) throw new Error(`Initial budget must be exactly ${units(custody * 1000n)} FTH$ for the actual deposited FTHG.`);
    if (confirm(`Initialize with ${units(custody)} FTHG and ${units(budget)} FTH$ budget? Confirm the budget is approved. This is a one-time operation.`)) await send(bridge, "initializePool", [budget]);
  });
  $("syncButton").addEventListener("click", () => transaction("Sync FTHG", async ({ bridge, token, current, send }) => {
    const [custody, x, staked] = await Promise.all([token.balanceOf(current.address), bridge.reserveFthg(), bridge.totalStakedFthg()]);
    if (custody <= x + staked) throw new Error("No unaccounted deposit is available.");
    if (confirm(`Add ${units(custody - x - staked)} FTHG to the curve? This changes the spot rate and excludes staking principal.`)) await send(bridge, "syncDepositedFthg");
  }));
  form("budgetForm", "Add FTH$ budget", async ({ bridge, send }) => {
    const value = amount("additionalBudget");
    if (confirm(`Add ${units(value)} FTH$ to the reward/curve budget? Confirm this budget is approved by the game ledger. This changes the spot rate and does not credit a wallet.`)) await send(bridge, "addFthDollarBudget", [value]);
  });
  form("aprForm", "Set staking APR", async ({ bridge, send }) => {
    const bps = aprBps();
    if (confirm(`Set base APR to ${ethers.formatUnits(bps, 2)}% for new stakes? Existing rewards are unchanged.`)) await send(bridge, "setBaseAprBps", [bps]);
  });
  form("gameYearForm", "Set game year", async ({ bridge, send }) => {
    const year = integer("gameYear", true);
    if (year < await bridge.currentGameYear()) throw new Error("Game year cannot decrease.");
    if (confirm(`Set authoritative game year to ${year}? This cannot be reversed and may unlock stake claims immediately.`)) await send(bridge, "setGameYear", [year]);
  });
  form("serviceForm", "Grant game-service role", async ({ bridge, send }) => {
    const address = $("gameService").value.trim();
    if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error("Enter a valid nonzero game-service address.");
    if (confirm(`Grant GAME_SERVICE_ROLE to ${ethers.getAddress(address)}? It can advance the clock and submit redemptions.`)) await send(bridge, "grantRole", [ethers.id("GAME_SERVICE_ROLE"), ethers.getAddress(address)]);
  });
  for (const [id, method] of [["pauseButton", "pause"], ["resumeButton", "unpause"]]) {
    $(id).addEventListener("click", () => transaction(method, async ({ bridge, send }) => {
      if (confirm(`${method === "pause" ? "Pause" : "Resume"} new conversions, redemptions and stakes? Mature claims remain available.`)) await send(bridge, method);
    }));
  }
  $("refreshBridge").addEventListener("click", refresh);
  let lastWallet = "";
  let lastProvider;
  window.addEventListener("featheral:wallet", () => {
    const account = window.FeatheralProfile.snapshot().account;
    const provider = window.FeatheralProfile.getProvider();
    const chain = window.FeatheralProfile.snapshot().chainId;
    const key = `${account}:${chain}`;
    if (key === lastWallet && provider === lastProvider) return;
    lastWallet = key;
    lastProvider = provider;
    refresh();
  });
  refresh();
})();
