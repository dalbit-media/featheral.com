"use strict";
(() => {
  const local = location.hostname === "world.localhost";
  if (!local && location.hostname !== "world.featheral.com") {
    document.getElementById("sync-status").textContent = "World account sync requires the canonical World host.";
    return;
  }
  const params = new URLSearchParams(location.search), returnOrigin = params.get("returnOrigin"), nonce = params.get("syncNonce");
  const contextual = params.has("returnOrigin") || params.has("syncNonce");
  if (contextual && (!/^[0-9a-f]{32}$/.test(nonce || "") || !window.opener || !document.referrer
    || new URL(document.referrer).origin !== returnOrigin || !(() => {
      try {
        const url = new URL(returnOrigin);
        return url.origin === returnOrigin && !url.username && !url.password
          && (url.protocol === "https:" && (url.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(url.hostname))
            || url.protocol === "http:" && (url.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(url.hostname)));
      } catch { return false; }
    })())) {
    document.getElementById("sync-status").textContent = "World sync requesting site is invalid. Close this window and retry from your wallet.";
    return;
  }
  const target = new URL(`${location.protocol}//${local ? "wallet.localhost" : "wallet.featheral.com"}${location.port ? ":" + location.port : ""}/?primary=FTH%24`);
  if (contextual) {
    const link = document.getElementById("return-link");
    link.removeAttribute("href"); link.textContent = "Close this window to return to your site wallet.";
  } else document.getElementById("return-link").href = target.href;
  async function sync() {
    const response = await fetch("/api/dollar/game/wallet/balance", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Open World Play first to restore your existing guest account." : data.error || "World account unavailable.");
    if (!/^0x[0-9a-f]{64}$/.test(data.accountId)) throw new Error("World returned an invalid account.");
    // Only the public ledger account is shared, never the session cookie or spending authority.
    if (contextual) {
      window.opener.postMessage({ type: "featheral:world-account", nonce, accountId: data.accountId }, returnOrigin);
      document.getElementById("sync-status").textContent = "World account linked. You can close this window.";
      return;
    }
    target.hash = new URLSearchParams({ worldAccount: data.accountId }).toString();
    location.replace(target.href);
  }
  sync().catch(error => {
    console.error("World wallet sync failed:", error);
    document.getElementById("sync-status").textContent = error.message;
    if (contextual) {
      window.opener.postMessage({ type: "featheral:world-account", nonce, error: error.message }, returnOrigin);
      return;
    }
    target.hash = new URLSearchParams({ worldSyncError: error.message }).toString();
    document.getElementById("return-link").href = target.href;
    document.getElementById("return-link").textContent = "Return to Featheral wallet";
    location.replace(target.href);
  });
})();
