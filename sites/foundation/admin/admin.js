"use strict";

(() => {
  const { el, json, stat, gate, mountWallet } = window.AdminKit;
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  window.AdminKit.tabs();

  mountWallet(document.getElementById("walletButton"));
  gate(document.getElementById("gate"), "any");

  const consoles = [["gold", "/admin/", "FTHG token management"], ["dollar", "/admin/", "FTH$ liquidity and reward policy"], ["world", "/admin/", "World moderation"]];
  document.getElementById("consoles").replaceChildren(...consoles.map(([site, path, label]) => el("li", {}, el("a", { href: window.FeatheralSites.url(site, path), textContent: label }))));

  async function load() {
    const [dollar, world, config] = await Promise.all([
      json("/api/v1/fth/stats?blocks=1&transactions=1&holders=1"),
      json("/api/v1/world/stats"),
      json("/api/v1/admin/config"),
    ]);
    document.getElementById("status").replaceChildren(
      stat("FTH$ ledger height", `#${num(dollar.ledger.height)}`), stat("FTH$ holders", num(dollar.ledger.holders)),
      stat("World ledger height", `#${num(world.ledger.height)}`), stat("World posts", num(world.ledger.posts)), stat("World authors", num(world.ledger.authors)));
    const host = document.getElementById("wallets");
    const list = (title, wallets) => el("div", {}, el("h3", { textContent: title }), wallets.length ? el("ul", {}, ...wallets.map((w) => el("li", {}, el("code", { textContent: w })))) : el("p", { textContent: "None configured." }));
    host.replaceChildren(list("Configured project wallets (FEATHERAL_ADMIN_WALLETS)", config.adminWallets), list("Fixed bridge project wallets (check roles in product consoles)", config.fthgAdminWallets));
  }
  load().catch((error) => {
    document.getElementById("status").textContent = `Ecosystem status unavailable: ${error.message}`;
    document.getElementById("wallets").textContent = `Wallet configuration unavailable: ${error.message}`;
  });
})();
