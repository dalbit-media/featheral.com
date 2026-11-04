"use strict";
window.FeatheralAdminControllers = {};
async function approveAdminAction(challenge, active) {
  if (!active()) throw new Error("Admin view changed. No operation was submitted.");
  const { provider, account } = await window.FeatheralProfile.ensureSigner(challenge.wallet);
  const sameWallet = () => provider === window.FeatheralProfile.getProvider()
    && window.FeatheralProfile.snapshot().account?.toLowerCase() === account?.toLowerCase();
  if (!active()) throw new Error("Admin view changed. No operation was submitted.");
  if (!sameWallet() || account.toLowerCase() !== challenge.wallet.toLowerCase()) throw new Error("Wallet changed. No operation was submitted.");
  const signature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(challenge.message)), account] });
  const accounts = await provider.request({ method: "eth_accounts" });
  if (accounts?.[0]?.toLowerCase() !== account.toLowerCase()) throw new Error("Wallet changed. No operation was submitted.");
  if (!active() || !sameWallet()) throw new Error("View or wallet changed. No operation was submitted.");
  if (ethers.verifyMessage(challenge.message, signature).toLowerCase() !== challenge.wallet.toLowerCase()) throw new Error("Invalid Admin-wallet signature.");
  return { challengeId: challenge.challengeId, signature };
}
async function mountOperation(key, q, token) {
  const config = OPERATION_VIEWS.find(entry => entry.key === key);
  if (!config) throw new Error("Unknown administration workspace.");
  const response = await fetch(`/pages/${key}.html`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Administration view HTTP ${response.status}`);
  const template = await response.text();
  if (token !== state.seq) return;
  setCrumbs(`<a href="#/operations">Service operations</a> <span class="muted">/</span> <b>${esc(config.label)}</b>`);
  setView(`<section class="native-operation" data-operation="${key}">${template}</section>`, token);
  const root = $(".native-operation"), controller = new AbortController();
  const kit = window.AdminKit.scope(root, controller.signal);
  viewCleanup = () => controller.abort();
  for (const link of $$("a[href],a[data-site]", root)) {
    const path = link.dataset.path || link.getAttribute("href") || "/";
    if (path.startsWith("#/")) continue;
    if (link.dataset.site || path.startsWith("/") && !path.startsWith("//")) {
      const product = link.dataset.site || (/^\/(?:wallet|explorer)(?:\/|$)/.test(path) ? "dollar" : key);
      link.href = window.FeatheralSites.url(product, path);
    }
  }
  window.AdminKit.tabs(root, q.tab, tab => history.replaceState(null, "", hrefFor(["operations", key], { tab })));
  window.FeatheralAdminControllers[key](root, kit);
  if (key === "dollar") window.FeatheralAdminControllers.bridge(root, kit);
}
window.addEventListener("DOMContentLoaded", async () => {
  $("#admin-sign-out").addEventListener("click", async () => {
    try { await api("/api/admin-auth/logout", { json: {} }); location.reload(); }
    catch (error) { console.error("Admin sign-out failed:", error); toast(error.message); }
  });
  try {
    const session = await api("/api/admin-auth/session");
    if (!session.authenticated) { location.reload(); return; }
    window.addEventListener("featheral:wallet", async event => {
      if (event.detail.account?.toLowerCase() === session.wallet.toLowerCase()) return;
      try { await api("/api/admin-auth/logout", { json: {} }); location.reload(); }
      catch (error) { console.error("Admin wallet session could not be closed:", error); toast(error.message); }
    });
    await window.FeatheralProfile.mount($("#admin-wallet"), { ethereumProvider: true });
  } catch (error) {
    console.error("Admin signing wallet:", error); toast(error.message);
  }
});
