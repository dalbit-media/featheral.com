"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const view = window.FeatheralReserveView;
  const reloadHistory = view.history();
  let reserve = null, busy = false;
  const account = () => window.FeatheralProfile.snapshot().account;
  const fmt = view.units;
  const fmtDollars = view.dollars;
  function notice(text, error = false) {
    $("status").textContent = text;
    $("status").dataset.error = String(error);
  }
  async function api(path, body) {
    const response = await fetch(`/api/v1/gold/reserve${path}`, { cache: "no-store", signal: AbortSignal.timeout(15000),
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Gold reserve HTTP ${response.status}`);
    return result;
  }
  function controls() {
    const ready = reserve?.initialized && !busy;
    const selected = (account() || "").toLowerCase();
    const source = reserve?.sourceWallet?.toLowerCase(), target = reserve?.reserveWallet?.toLowerCase();
    $("convert-button").disabled = !ready || selected !== source || BigInt(reserve.settledOut) <= BigInt(reserve.recycledIn);
    $("redeem-button").disabled = !ready || ![source, target].includes(selected) || BigInt(reserve.redeemableBacking) === 0n;
    $("sync").disabled = !ready;
    $("reconcile-button").disabled = !ready || ![source, target].includes(selected);
    $("refresh").disabled = busy;
    $("convert-reason").textContent = !reserve?.initialized ? "Reserve is not initialized."
      : !selected ? "Connect the origin wallet to reconvert returned FTHG."
      : selected !== source ? "Only the configured origin wallet can reconvert returned FTHG."
      : BigInt(reserve.settledOut) <= BigInt(reserve.recycledIn) ? "No confirmed returned FTHG is available. Initial allocations fund World markets automatically."
      : `Available returned FTHG: ${fmt(BigInt(reserve.settledOut) - BigInt(reserve.recycledIn))}. Reconversion unlocks existing FTH$ only.`;
    $("redeem-reason").textContent = !reserve?.initialized ? "Reserve is not initialized."
      : !selected ? "Connect one of the two configured wallets to request redemption."
      : ![source, target].includes(selected) ? "Redemption is restricted to the configured origin and backing wallets."
      : BigInt(reserve.redeemableBacking) === 0n ? "Redemption is blocked: no confirmed, uncommitted Ethereum backing."
      : `Confirmed backing available: ${fmt(reserve.redeemableBacking)} FTHG. Your available FTH$ is rechecked before signing.`;
  }
  async function refresh() {
    reserve = await api("");
    $("mode-warning").textContent = reserve.mode === "live"
      ? "LIVE OFF-CHAIN ECONOMY — ETHEREUM SYNC NOT SUBMITTED"
      : "ISOLATED TEST ECONOMY — NOT REDEEMABLE LIVE FUNDS";
    if (!reserve.initialized) { notice(reserve.warning || "Reserve is not initialized."); controls(); return; }
    view.render(reserve);
    await reloadHistory();
    preview();
    notice(reserve.mode === "live" ? "Live off-chain reserve loaded. Pending allocations are not Ethereum transfers."
      : "Isolated off-chain journal loaded. Live balances are unchanged.");
    controls();
  }
  async function operation(action, refreshAfter = true) {
    if (busy) return;
    busy = true; controls();
    try { await action(); if (refreshAfter) await refresh(); }
    catch (error) { notice(error.message, true); }
    finally { busy = false; controls(); }
  }
  function amount(id) {
    const text = $(id).value.trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error("Enter a positive amount with at most 18 decimal places.");
    const value = ethers.parseUnits(text, 18);
    if (value <= 0n) throw new Error("Amount must be positive.");
    return value;
  }
  async function signer(expected) {
    const provider = new ethers.BrowserProvider(window.FeatheralProfile.getProvider());
    if (Number((await provider.getNetwork()).chainId) !== 1) throw new Error("Select Ethereum Mainnet before signing an off-chain obligation.");
    const selected = await provider.getSigner(account());
    if ((await selected.getAddress()).toLowerCase() !== expected.toLowerCase()) throw new Error("Wallet changed. Refresh before authorizing this obligation.");
    return selected;
  }
  function preview() {
    for (const [input, output, incoming] of [["fthg", "convert-preview", true], ["dollars", "redeem-preview", false]]) {
      if (!$(input).value.trim()) { $(output).textContent = "Enter an amount to preview."; continue; }
      try {
        const value = amount(input), rate = BigInt(reserve?.rate || "1000");
        if (!incoming && value % rate) throw new Error("Amount must map exactly to FTHG base units.");
        $(output).title = `Exact FTH$ base units: ${incoming ? value * rate : value}. Display rounds to at most two decimals.`;
        $(output).textContent = incoming ? `${fmt(value)} FTHG → ${fmtDollars(value * rate)} FTH$ (no new issuance)`
          : `${fmtDollars(value)} FTH$ → ${fmt(value / rate)} FTHG (pending manual sync)`;
      } catch (error) { $(output).textContent = error.message; }
    }
  }
  $("fthg").addEventListener("input", preview);
  $("dollars").addEventListener("input", preview);
  $("refresh").addEventListener("click", () => operation(async () => {}));
  $("sync").addEventListener("click", () => operation(async () => {
    if (!confirm(`${reserve.mode === "live" ? "WARNING: live off-chain reserve journal." : "WARNING: this is an isolated test journal."} Off-chain allocations are not Ethereum transfers. Mainnet settlement would spend gas and irreversibly move actual FTHG. Preview only; no transaction will be submitted.`)) return;
    const plan = await api("/sync-plan");
    reserve = plan;
    view.render(plan, plan);
    $("plan").hidden = false;
    $("plan").textContent = [
      `Finalized Ethereum block: ${plan.evidence.block.toLocaleString("en-US")}`,
      `Block hash: ${plan.evidence.hash}`,
      `Canonical token: ${plan.tokenAddress}`,
      `Origin holdings: ${fmt(plan.actualOrigin)} FTHG`,
      `Backing wallet holdings: ${fmt(plan.actualReserve)} FTHG`,
      ...plan.transfers.map(transfer => `\nPENDING ${transfer.direction === "origin-to-reserve" ? "Origin → FTH$ backing" : "FTH$ backing → Origin"}: ${fmt(transfer.amount)} FTHG\nFrom: ${transfer.from}\nTo: ${transfer.to}\nExact FTHG base units: ${transfer.amount}`),
      ...(plan.transfers.length ? [] : ["No pending Ethereum transfers."]),
      "\nPREVIEW ONLY — no Ethereum transaction submitted.",
      plan.warning,
    ].join("\n");
    notice("Actual balances verified at a finalized Ethereum block. Preview only; no Ethereum transaction submitted.");
  }, false));
  $("reconcile").addEventListener("submit", event => {
    event.preventDefault();
    operation(async () => {
      if (!confirm(`Verify an existing finalized transfer in the ${reserve.mode === "live" ? "live" : "isolated test"} journal? This does not submit or change any Ethereum transaction.`)) return;
      const request = { txHash: $("hash").value.trim(), logIndex: Number($("log").value), issuedAt: new Date().toISOString() };
      if (!ethers.isHexString(request.txHash, 32) || !Number.isSafeInteger(request.logIndex) || request.logIndex < 0)
        throw new Error("Enter a valid transaction hash and non-negative log index.");
      const selected = account();
      if (![reserve.sourceWallet, reserve.reserveWallet].some(wallet => wallet.toLowerCase() === selected?.toLowerCase()))
        throw new Error("Connect the authorized origin or backing wallet to reconcile reserves.");
      const message = ["Featheral Gold reserve reconciliation", `Ledger: ${reserve.genesisHash}`, "Chain ID: 1",
        `Transaction: ${request.txHash}`, `Log index: ${request.logIndex}`, `Issued at: ${request.issuedAt}`,
        "Verify an existing finalized FTHG transfer only. No Ethereum transaction is submitted."].join("\n");
      request.signature = await (await signer(selected)).signMessage(message);
      await api("/reconcile", request);
    });
  });
  $("convert").addEventListener("submit", event => {
    event.preventDefault();
    operation(async () => {
      const value = amount("fthg"), current = await api("");
      if (value > BigInt(current.settledOut) - BigInt(current.recycledIn)) throw new Error("Amount exceeds confirmed returned FTHG available for reconversion.");
      if (!confirm(`Record ${fmt(value)} returned FTHG → ${fmtDollars(value * BigInt(current.rate))} existing FTH$ in this ${current.mode === "live" ? "live" : "test"} ledger?\nExact FTH$ base units: ${value * BigInt(current.rate)}.\nReal FTHG stays in its wallet until manual sync.`)) return;
      const request = { amount: value.toString(), nonce: current.conversionNonce + 1, issuedAt: new Date().toISOString() };
      const message = ["Featheral Gold off-chain reserve conversion", `Ledger: ${current.genesisHash}`, "Chain ID: 1",
        `From: ${current.sourceWallet}`, `To: ${current.reserveWallet}`, `FTHG base units: ${request.amount}`,
        `Rate: ${current.rate} FTH$ per FTHG`, `Nonce: ${request.nonce}`, `Issued at: ${request.issuedAt}`,
        "This reserves an off-chain obligation. It does not transfer Ethereum tokens."].join("\n");
      request.signature = await (await signer(current.sourceWallet)).signMessage(message);
      await api("/convert", request);
    });
  });
  $("redeem").addEventListener("submit", event => {
    event.preventDefault();
    operation(async () => {
      const value = amount("dollars"), current = await api("");
      if (value % BigInt(current.rate)) throw new Error("Amount cannot be converted to exact FTHG base units.");
      const response = await fetch(`/api/v1/notes/wallets/${account()}`, { cache: "no-store" });
      const wallet = await response.json();
      if (!response.ok) throw new Error(wallet.error || "Dollar wallet read failed.");
      if (value > BigInt(wallet.fthDollar.available)) throw new Error("Amount exceeds the available FTH$ wallet balance.");
      if (value / BigInt(current.rate) > BigInt(current.redeemableBacking)) throw new Error("Amount exceeds confirmed, uncommitted backing.");
      if (!confirm(`Record ${fmtDollars(value)} FTH$ → ${fmt(value / BigInt(current.rate))} FTHG obligation from reserve to origin in this ${current.mode === "live" ? "live" : "test"} ledger?\nExact FTH$ base units: ${value}.\nNo Ethereum tokens will move yet.`)) return;
      const transfer = { wallet: account(), to: current.redemptionEscrow, amount: value.toString(),
        nonce: wallet.nonce + 1, memo: `Gold:${current.genesisHash.slice(2, 58)}`, issuedAt: new Date().toISOString() };
      const message = window.FeatheralDollarTransferMessage(transfer);
      transfer.signature = await (await signer(transfer.wallet)).signMessage(message);
      await api("/redeem", transfer);
    });
  });
  window.FeatheralProfile.mount($("wallet"), { walletUrl: window.FeatheralSites.url("dollar", "/wallet/"), ethereumProvider: true });
  window.addEventListener("featheral:wallet", controls);
  operation(async () => {});
})();
