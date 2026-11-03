"use strict";

window.FeatheralAdminControllers.gold = (root, kit) => {
  const $ = id => root.querySelector("#" + id);
  const view = window.FeatheralReserveView.scope(root);
  const tokenAddress = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const provider = new ethers.JsonRpcProvider(`${location.origin}/api/v1/gold/rpc`, 1);
  const abi = [
    "function hasRole(bytes32,address) view returns(bool)", "function paused() view returns(bool)",
    "function metadataURI() view returns(string)", "function blacklisted(address) view returns(bool)",
    "function pause()", "function unpause()", "function setMetadataURI(string)",
    "function setBlacklisted(address,bool)",
    "function grantRole(bytes32,address)", "function revokeRole(bytes32,address)",
  ];
  const token = new ethers.Contract(tokenAddress, abi, provider);
  const roles = { metadata: ethers.ZeroHash, pause: ethers.id("PAUSER_ROLE"), compliance: ethers.id("COMPLIANCE_ROLE") };
  let reserve = null, actual = null, busy = false, safetyBusy = false, generation = 0, permissions = {};
  const reloadHistory = view.history();
  function status(id, text, failed = false) { $(id).textContent = text; $(id).dataset.error = String(failed); }
  async function valuation() {
    try {
      const response = await fetch("/api/v1/gold/valuation", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Valuation HTTP ${response.status}`);
      const { pool, market } = data;
      const card = (label, value, note) => {
        const item = document.createElement("div"), parts = [["span", label], ["strong", value], ["small", note]];
        item.className = "reserve-metric";
        item.append(...parts.map(([tag, text]) => Object.assign(document.createElement(tag), { textContent: text })));
        return item;
      };
      const usd = Number(ethers.formatUnits(market.usdPerFthg, 18));
      $("valuation-link").href = pool.url;
      $("valuation-metrics").replaceChildren(
        card("FTHG value", `$${usd.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`, market.fallback ? "Temporary $0.01 reference" : "Pool spot × ETH/USD"),
        card("Pool price", market.fthgPerEth ? `${Number(ethers.formatUnits(market.fthgPerEth, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} FTHG / ETH` : "No price data", market.block ? `Mainnet block ${market.block.toLocaleString("en-US")}` : market.marketError || ""),
        card("Pair", `${pool.symbol0} / ${pool.symbol1}`, `${pool.protocol} · ${pool.fee / 10000}% fee · tick spacing ${pool.tickSpacing}`),
        card("Pool ID", `${pool.poolId.slice(0, 10)}…${pool.poolId.slice(-8)}`, pool.poolId));
      status("valuation-status", market.fallback ? `Using the $0.01 reference: ${market.marketError}` : `Live pool estimate checked ${new Date(market.updatedAt).toLocaleTimeString()}.`, market.fallback);
    } catch (error) { status("valuation-status", error.message, true); }
  }
  async function refresh(verify = false) {
    if (busy) return;
    busy = true; $("refresh").disabled = true; $("verify-balances").disabled = true;
    try {
      reserve = await view.api("");
      actual = null;
      if (!reserve.initialized) throw new Error(reserve.warning || "Reserve is not initialized.");
      view.render(reserve);
      if (verify) { actual = await view.api("/sync-plan"); view.render(actual, actual); }
      await reloadHistory();
      status("admin-status", verify ? "Actual wallet holdings verified at one finalized Ethereum block." : "Dollar reserve journal loaded. Actual Ethereum balances require separate verification.");
    } catch (error) { status("admin-status", error.message, true); }
    finally { busy = false; $("refresh").disabled = false; $("verify-balances").disabled = false; }
  }
  function controls(paused) {
    $("metadata-save").disabled = safetyBusy || !permissions.metadata;
    $("token-pause").disabled = safetyBusy || !permissions.pause || paused !== false;
    $("token-unpause").disabled = safetyBusy || !permissions.pause || paused !== true;
    $("compliance-submit").disabled = safetyBusy || ($("compliance-action").value !== "check" && !permissions.compliance);
    $("role-submit").disabled = safetyBusy || ($("role-action").value !== "check" && !permissions.metadata);
    $("safety-refresh").disabled = safetyBusy;
  }
  let paused;
  async function safety(preserveMessage = false) {
    const request = ++generation, account = window.FeatheralProfile.snapshot().account;
    permissions = {}; controls();
    try {
      const blockTag = await provider.getBlockNumber();
      const [isPaused, uri, ...allowed] = await Promise.all([
        token.paused({ blockTag }), token.metadataURI({ blockTag }),
        ...Object.values(roles).map(role => account ? token.hasRole(role, account, { blockTag }) : false),
      ]);
      if (request !== generation) return;
      paused = isPaused;
      const mainnet = window.FeatheralProfile.snapshot().chainId === 1;
      permissions = Object.fromEntries(Object.keys(roles).map((role, index) => [role, mainnet && allowed[index]]));
      $("token-paused").textContent = `Token transfers: ${paused ? "PAUSED" : "active"}`;
      if (document.activeElement !== $("metadata-uri")) $("metadata-uri").value = uri;
      if (!preserveMessage) status("safety-status", account ? "Permissions checked against actual Mainnet roles. Disabled controls require the corresponding role." : "Token safety checked. Connect an authorized Mainnet wallet to make changes.");
    } catch (error) { if (request === generation) { permissions = {}; status("safety-status", error.message, true); } }
    finally { if (request === generation) controls(paused); }
  }
  async function write(method, args, role, description) {
    if (safetyBusy) return;
    safetyBusy = true; controls();
    try {
      const wallet = window.FeatheralProfile.getProvider();
      if (!wallet) throw new Error("Connect an authorized Mainnet wallet.");
      const signerProvider = new ethers.BrowserProvider(wallet);
      if (Number((await signerProvider.getNetwork()).chainId) !== 1) throw new Error("Token safety writes require Ethereum Mainnet.");
      const signer = await signerProvider.getSigner(), account = await signer.getAddress();
      if (!await token.hasRole(roles[role], account)) throw new Error("The connected wallet does not hold the required on-chain role.");
      if (!confirm(`MAINNET TOKEN CHANGE: ${description}\nThis costs gas and changes the deployed contract. It does not synchronize reserve obligations. Continue?`)) return;
      const contract = token.connect(signer);
      await contract[method].staticCall(...args);
      if (Number(await wallet.request({ method: "eth_chainId" })) !== 1
        || window.FeatheralProfile.snapshot().account.toLowerCase() !== account.toLowerCase()
        || window.FeatheralProfile.getProvider() !== wallet) throw new Error("Wallet or network changed. Review the action again.");
      kit.assertActive();
      const tx = await contract[method](...args);
      status("safety-status", `Waiting for Ethereum confirmation: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || Number(receipt.status) !== 1) throw new Error("Token safety transaction was not confirmed successfully.");
      const link = document.createElement("a"); link.href = `https://etherscan.io/tx/${tx.hash}`; link.textContent = "View confirmed Ethereum receipt ↗"; link.target = "_blank"; link.rel = "noopener noreferrer";
      $("safety-status").replaceChildren(link);
    } catch (error) { status("safety-status", error.shortMessage || error.message, true); }
    finally { safetyBusy = false; await safety(true); }
  }
  $("refresh").addEventListener("click", () => { refresh(); valuation(); });
  $("verify-balances").addEventListener("click", () => refresh(true));
  $("safety-refresh").addEventListener("click", () => safety());
  $("token-pause").addEventListener("click", () => write("pause", [], "pause", "Pause all FTHG transfers."));
  $("token-unpause").addEventListener("click", () => write("unpause", [], "pause", "Resume FTHG transfers."));
  $("metadata-form").addEventListener("submit", event => {
    event.preventDefault();
    const uri = $("metadata-uri").value.trim();
    if (!/^(https:\/\/|ipfs:\/\/)\S+$/.test(uri)) { status("safety-status", "Use a public HTTPS or IPFS metadata URI.", true); return; }
    write("setMetadataURI", [uri], "metadata", `Set metadata URI to ${uri}.`);
  });
  $("compliance-action").addEventListener("change", () => controls(paused));
  $("role-action").addEventListener("change", () => controls(paused));
  $("role-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const address = ethers.getAddress($("role-address").value.trim()), role = $("role-name").value, action = $("role-action").value;
      if (address === ethers.ZeroAddress) throw new Error("Use a nonzero wallet address.");
      if (action === "check") { status("safety-status", `${address}: ${await token.hasRole(roles[role], address) ? "holds" : "does not hold"} ${$("role-name").selectedOptions[0].textContent} role.`); return; }
      await write(action === "grant" ? "grantRole" : "revokeRole", [roles[role], address], "metadata",
        `${action === "grant" ? "Grant" : "Revoke"} ${$("role-name").selectedOptions[0].textContent} for ${address}.${action === "revoke" && role === "metadata" ? " Removing the last administrator permanently disables administration." : ""}`);
    } catch (error) { status("safety-status", error.message, true); }
  });
  $("compliance-form").addEventListener("submit", async event => {
    event.preventDefault();
    let address;
    try { address = ethers.getAddress($("compliance-address").value.trim()); if (address === ethers.ZeroAddress) throw new Error("Use a nonzero wallet address."); }
    catch (error) { status("safety-status", error.message, true); return; }
    const action = $("compliance-action").value;
    if (action !== "check") { write("setBlacklisted", [address, action === "restrict"], "compliance", `${action === "restrict" ? "Restrict" : "Restore"} transfers for ${address}.`); return; }
    try { status("safety-status", `${address}: ${await token.blacklisted(address) ? "restricted" : "not restricted"}.`); }
    catch (error) { status("safety-status", error.message, true); }
  });
  kit.listen("featheral:wallet", () => safety());
  refresh();
  safety();
  valuation();
};
