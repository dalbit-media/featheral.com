"use strict";
(() => {
  const local = location.hostname === "world.localhost";
  if (!local && location.hostname !== "world.featheral.com") {
    document.getElementById("sync-status").textContent = "World account sync requires the canonical World host.";
    return;
  }
  const target = new URL(`${location.protocol}//${local ? "wallet.localhost" : "wallet.featheral.com"}${location.port ? ":" + location.port : ""}/?primary=FTH%24`);
  document.getElementById("return-link").href = target.href;
  async function sync() {
    const response = await fetch("/api/dollar/game/wallet/balance", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Open World Play first to restore your existing guest account." : data.error || "World account unavailable.");
    if (!/^0x[0-9a-f]{64}$/.test(data.accountId)) throw new Error("World returned an invalid account.");
    // Only the public ledger account is shared, never the session cookie or spending authority.
    target.hash = new URLSearchParams({ worldAccount: data.accountId }).toString();
    location.replace(target.href);
  }
  sync().catch(error => {
    console.error("World wallet sync failed:", error);
    document.getElementById("sync-status").textContent = error.message;
    target.hash = new URLSearchParams({ worldSyncError: error.message }).toString();
    document.getElementById("return-link").href = target.href;
    document.getElementById("return-link").textContent = "Return to Featheral wallet";
    location.replace(target.href);
  });
})();
