"use strict";
(() => {
  try {
    if (window.parent !== window || !window.opener) throw new Error("Open wallet sync from a Featheral wallet button.");
    const params = new URLSearchParams(location.search), origin = params.get("origin"), nonce = params.get("nonce");
    const url = new URL(origin);
    if (url.origin !== origin || !/^[a-f0-9]{32}$/.test(nonce)
      || !(url.protocol === "https:" && (url.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(url.hostname))
        || url.protocol === "http:" && (url.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(url.hostname))))
      throw new Error("Unsupported wallet sync origin.");
    const vault = new FeatheralVault.Vault(localStorage), record = vault.read();
    const address = localStorage.getItem("featheral-wallet-active-account") || record?.address || null;
    if (address && !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Invalid selected wallet address.");
    const linked = record ? [record.address, ...vault.verifiedLinks(record).map(link => link.address)] : [];
    const addresses = address && linked.some(item => item.toLowerCase() === address.toLowerCase()) ? linked : address ? [address] : [];
    const worldAccount = localStorage.getItem("featheral-world-account");
    if (worldAccount && !/^0x[0-9a-f]{64}$/i.test(worldAccount)) throw new Error("Invalid synced World account.");
    window.opener.postMessage({ type: "featheral:wallet-context", nonce, context: { address, addresses, worldAccount } }, origin);
    window.close();
  } catch (error) {
    console.error("Wallet context sync failed:", error);
    document.getElementById("context-status").textContent = error.message;
  }
})();
