"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const { el, goldApi, stat, fth } = window.FTH;
  const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const ONE = 10n ** 18n;
  const terms = [1n, 2n, 5n, 10n, 20n, 30n];
  const readProvider = new ethers.JsonRpcProvider(`${location.origin}/api/v1/gold/rpc`, 1);
  const readToken = new ethers.Contract(TOKEN, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], readProvider);
  let bridge;
  let snapshot;
  let inspected;
  let abi;
  let busy = false;
  let generation = 0;
  let inspectionGeneration = 0;
  let issuanceEnabled = false;
  const units = (value) => ethers.formatUnits(value, 18);
  const errorText = (error) => error.shortMessage || error.message || String(error);

  function integer(id) {
    const value = $(id).value.trim();
    if (!/^\d+$/.test(value) || BigInt(value) === 0n || BigInt(value) > ethers.MaxUint256) throw new Error("Enter a positive whole number within uint256 range.");
    return BigInt(value);
  }
  function principal() {
    const value = $("stakeAmount").value.trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error("Enter a positive FTHG amount with at most 18 decimal places.");
    const amount = ethers.parseUnits(value, 18);
    if (amount === 0n || amount > ethers.MaxUint256) throw new Error("Principal is outside the positive uint256 range.");
    return amount;
  }
  function status(message, failed = false) {
    $("stakingStatus").className = `status${failed ? " err" : ""}`;
    $("stakingStatus").replaceChildren(message);
  }
  function controls() {
    $("refreshStaking").disabled = busy;
    $("inspectButton").disabled = busy || !bridge;
    $("stakeButton").disabled = !issuanceEnabled || busy || !snapshot?.connected || !snapshot.initialized || snapshot.paused || !snapshot.clock || snapshot.x === 0n || snapshot.y === 0n;
    $("claimButton").disabled = !issuanceEnabled || busy || !snapshot?.connected || !inspected || inspected.claimed || inspected.maturityGameYear > snapshot.year;
  }
  function preview() {
    try {
      if (!snapshot?.initialized || snapshot.x === 0n || snapshot.y === 0n) {
        $("stakeQuote").textContent = "An initialized pool with both reserves is required.";
        return;
      }
      if (!$("stakeAmount").value.trim()) {
        $("stakeQuote").textContent = "Enter a principal amount to preview rewards.";
        return;
      }
      const amount = principal();
      const term = integer("stakeTerm");
      if (!terms.includes(term)) throw new Error("Unsupported staking term.");
      const rate = snapshot.y * ONE / snapshot.x;
      const reward = (amount * snapshot.apr * term / 10000n) * rate / ONE;
      $("stakeQuote").textContent = `Estimated reward: ${fth(reward)}; maturity: game year ${snapshot.year + term}. ${reward === 0n || reward > snapshot.y ? "Insufficient reward budget." : "Rechecked before submission; credit requires a confirmed mature claim."}`;
    } catch (error) {
      $("stakeQuote").textContent = errorText(error);
    }
  }
  async function refresh() {
    const request = ++generation;
    bridge = null;
    snapshot = null;
    issuanceEnabled = false;
    inspected = null;
    ++inspectionGeneration;
    controls();
    $("stakingAccess").textContent = "Reading staking pool...";
    try {
      const dollarStats = await window.FTH.api("/stats");
      issuanceEnabled = dollarStats.monetaryPolicy?.issuanceEnabled === true;
      if (!issuanceEnabled) status("FTH$ issuance is closed. New stakes and reward claims are disabled; existing principal remains on Ethereum.");
      const data = await goldApi("/stats");
      const address = data.bridge?.address;
      if (!data.bridge?.deployed || !ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error("Staking bridge is not deployed/configured.");
      if (!abi) {
        const response = await fetch("/shared/abi/FthgGameBridge.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`Bridge ABI HTTP ${response.status}`);
        const artifact = await response.json();
        if (!Array.isArray(artifact.abi)) throw new Error("Bridge ABI is invalid.");
        abi = artifact.abi;
      }
      const contract = new ethers.Contract(address, abi, readProvider);
      const blockTag = await readProvider.getBlockNumber();
      if ((await contract.fthg({ blockTag })).toLowerCase() !== TOKEN.toLowerCase()) throw new Error("Configured bridge does not use canonical FTHG.");
      const account = FeatheralProfile.snapshot().account;
      const wallet = FeatheralProfile.getProvider();
      const connected = Boolean(account && wallet && Number(await wallet.request({ method: "eth_chainId" })) === 1);
      const [initialized, x, y, apr, year, clock, paused, staked] = await Promise.all([
        contract.poolInitialized({ blockTag }), contract.reserveFthg({ blockTag }), contract.reserveFthDollar({ blockTag }),
        contract.baseAprBps({ blockTag }), contract.currentGameYear({ blockTag }), contract.gameClockInitialized({ blockTag }),
        contract.paused({ blockTag }), contract.totalStakedFthg({ blockTag }),
      ]);
      if (request !== generation || account !== FeatheralProfile.snapshot().account || wallet !== FeatheralProfile.getProvider()) return;
      bridge = contract;
      snapshot = { address, account, wallet, connected, initialized, x, y, apr, year, clock, paused };
      $("stakingAccess").replaceChildren("Bridge ", el("code", { textContent: address }), ` | ${paused ? "New stakes paused" : "Active"} | ${clock ? `Game year ${year}` : "Game clock not initialized"} | ${connected ? "Wallet connected on Mainnet" : "Connect a wallet on Mainnet to stake or claim"}`);
      $("stakingStats").replaceChildren(stat("Locked FTHG", `${units(staked)} FTHG`), stat("New-stake APR", `${ethers.formatUnits(apr, 2)}%`), stat("Available reward budget", fth(y)));
      controls();
      preview();
    } catch (error) {
      if (request !== generation) return;
      $("stakingAccess").textContent = `Staking unavailable: ${errorText(error)}`;
      $("stakingStats").replaceChildren();
      controls();
    }
  }
  async function inspect() {
    const id = integer("stakeId");
    const request = ++inspectionGeneration;
    inspected = null;
    controls();
    if (!bridge) throw new Error("Staking bridge is unavailable.");
    const position = await bridge.stakes(id);
    if (request !== inspectionGeneration) return;
    if (position.account === ethers.ZeroAddress) throw new Error("Stake not found.");
    inspected = position;
    $("stakeDetails").replaceChildren("Owner ", el("code", { textContent: position.account }), ` | ${units(position.fthgAmount)} FTHG principal | ${fth(position.rewardFthDollar)} reward | maturity game year ${position.maturityGameYear} | ${position.claimed ? "Claimed; ledger settlement is separate" : position.maturityGameYear <= snapshot.year ? "Mature" : "Locked"}`);
    controls();
  }
  async function transaction(label, action) {
    if (busy) return;
    busy = true;
    controls();
    try {
      await window.FTH.requireIssuance();
      const current = snapshot;
      if (!bridge || !current?.connected) throw new Error("Connect a wallet on Ethereum Mainnet and refresh staking.");
      const provider = new ethers.BrowserProvider(current.wallet);
      if (Number((await provider.getNetwork()).chainId) !== 1) throw new Error("Switch to Ethereum Mainnet.");
      const signer = await provider.getSigner(current.account);
      const send = async (contract, method, args) => {
        await window.FTH.requireIssuance();
        if (current.wallet !== FeatheralProfile.getProvider() || current.account !== FeatheralProfile.snapshot().account) throw new Error("Wallet changed before submission.");
        if (Number(await current.wallet.request({ method: "eth_chainId" })) !== 1) throw new Error("Wallet left Ethereum Mainnet.");
        await contract[method].staticCall(...args);
        status(`${label}: confirm in your wallet...`);
        const tx = await contract[method](...args);
        $("stakingStatus").replaceChildren("Submitted: ", el("a", { href: `https://etherscan.io/tx/${tx.hash}`, target: "_blank", rel: "noopener noreferrer", textContent: "View transaction" }), " | waiting for confirmation...");
        const receipt = await tx.wait();
        if (method === "claimStake") await window.FTH.settleBridge(tx.hash, (message) => status(message));
        if (!receipt || receipt.status !== 1) throw new Error("Transaction was not successfully confirmed.");
        $("stakingStatus").replaceChildren(`${label} confirmed on Ethereum. Ledger confirmation/indexing is separate. `, el("a", { href: `https://etherscan.io/tx/${tx.hash}`, target: "_blank", rel: "noopener noreferrer", textContent: "View receipt" }));
        return receipt;
      };
      await action({ bridge: bridge.connect(signer), token: readToken.connect(signer), current, send });
    } catch (error) {
      status(error.code === 4001 || error.code === "ACTION_REJECTED" ? "Request cancelled in the wallet." : `${label} failed: ${errorText(error)}`, true);
    } finally {
      busy = false;
      await refresh();
    }
  }
  $("stakeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    transaction("Stake FTHG", async ({ bridge, token, current, send }) => {
      const amount = principal();
      const term = integer("stakeTerm");
      if (!terms.includes(term)) throw new Error("Unsupported staking term.");
      const [rate, apr, year, budget, clock, balance] = await Promise.all([bridge.spotRate(), bridge.baseAprBps(), bridge.currentGameYear(), bridge.reserveFthDollar(), bridge.gameClockInitialized(), token.balanceOf(current.account)]);
      if (!clock) throw new Error("Game clock is not initialized.");
      if (amount > balance) throw new Error("Stake exceeds your FTHG balance.");
      const reward = (amount * apr * term / 10000n) * rate / ONE;
      if (reward === 0n || reward > budget) throw new Error("Insufficient FTH$ reward budget.");
      if (!confirm(`Lock ${units(amount)} FTHG for ${term} game-years, until year ${year + term}? Current estimate: ${units(reward)} FTH$ reward, credited only after mature claim. Rates may change before mining. Approval and staking may require two transactions.`)) return;
      if (await token.allowance(current.account, current.address) < amount) await send(token, "approve", [current.address, amount]);
      const receipt = await send(bridge, "stake", [amount, term, ethers.zeroPadValue(current.account, 32)]);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== current.address.toLowerCase()) continue;
        const parsed = bridge.interface.parseLog(log);
        if (parsed?.name === "FthgStaked") {
          $("stakeId").value = parsed.args.stakeId.toString();
          $("stakingStatus").append(` Stake ID ${parsed.args.stakeId}; locked reward ${fth(parsed.args.rewardFthDollar)}.`);
        }
      }
    });
  });
  $("claimForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await inspect(); } catch (error) { $("stakeDetails").textContent = `Stake lookup failed: ${errorText(error)}`; }
  });
  $("claimButton").addEventListener("click", () => transaction("Claim stake", async ({ bridge, send }) => {
    const id = integer("stakeId");
    const position = await bridge.stakes(id);
    if (position.account === ethers.ZeroAddress || position.claimed) throw new Error("Stake does not exist or was already claimed.");
    if (position.maturityGameYear > await bridge.currentGameYear()) throw new Error("Stake has not matured.");
    if (confirm(`Return ${units(position.fthgAmount)} FTHG to ${position.account} and emit the ${fth(position.rewardFthDollar)} reward claim for ledger indexing?`)) await send(bridge, "claimStake", [id]);
  }));
  $("stakeId").addEventListener("input", () => { inspected = null; ++inspectionGeneration; controls(); });
  $("stakeAmount").addEventListener("input", preview);
  $("stakeTerm").addEventListener("change", preview);
  $("refreshStaking").addEventListener("click", refresh);
  let lastWallet = "";
  let lastProvider;
  window.addEventListener("featheral:wallet", () => {
    const key = `${FeatheralProfile.snapshot().account}:${FeatheralProfile.snapshot().chainId}`;
    const provider = FeatheralProfile.getProvider();
    if (key === lastWallet && provider === lastProvider) return;
    lastWallet = key;
    lastProvider = provider;
    refresh();
  });
  refresh();
})();
