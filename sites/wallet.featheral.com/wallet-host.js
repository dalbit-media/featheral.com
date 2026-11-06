"use strict";
(() => {
  const url = new URL(location.href), root = document.querySelector("[data-wallet-embed]");
  const view = url.hash.slice(1);
  if (["assets", "send", "receive", "swap", "tip", "activity", "account"].includes(view)) root.dataset.walletView = view;
  if (["to", "amount", "name", "currency"].some(key => url.searchParams.has(key))) {
    const payment = new URLSearchParams();
    for (const key of ["to", "amount", "name", "currency"])
      for (const value of url.searchParams.getAll(key)) payment.append(key, value);
    root.dataset.walletPayment = payment.toString();
    root.dataset.walletPrimary = "FTH$";
    root.dataset.walletView = "send";
  }
  const local = location.hostname === "localhost" || location.hostname.endsWith(".localhost");
  const script = document.createElement("script");
  script.src = `${location.protocol}//${local ? "wallet.localhost" : "wallet.featheral.com"}${location.port ? ":" + location.port : ""}/embed.js`;
  script.onerror = () => { root.textContent = "Wallet app unavailable. Reload this page to retry."; };
  document.head.append(script);
})();
