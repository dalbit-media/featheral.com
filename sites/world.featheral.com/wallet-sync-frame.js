"use strict";
// Hidden same-site frame: answers Featheral wallets with the public World ledger account only.
(() => {
  const canonical = location.hostname === "world.featheral.com" || location.hostname === "world.localhost";
  const allowed = origin => {
    try {
      const url = new URL(origin);
      return url.origin === origin && !url.username && !url.password
        && (url.protocol === "https:" && (url.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(url.hostname))
          || url.protocol === "http:" && (url.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(url.hostname)));
    } catch { return false; }
  };
  window.addEventListener("message", async event => {
    if (window.parent === window || event.source !== window.parent || !allowed(event.origin)
      || event.data?.type !== "featheral:world-account-request" || !/^[0-9a-f]{32}$/.test(event.data.nonce || "")) return;
    const reply = data => event.source.postMessage({ type: "featheral:world-account", nonce: event.data.nonce, ...data }, event.origin);
    if (!canonical) { reply({ error: "World account sync requires the canonical World host." }); return; }
    try {
      const response = await fetch("/api/dollar/game/wallet/balance", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { reply({ accountId: null, signedOut: true }); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "World account unavailable.");
      if (!/^0x[0-9a-f]{64}$/.test(data.accountId || "")) throw new Error("World returned an invalid account.");
      reply({ accountId: data.accountId });
    } catch (error) {
      console.error("World account frame:", error);
      reply({ error: error.message });
    }
  });
})();
