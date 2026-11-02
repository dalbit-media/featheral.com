"use strict";

window.FeatheralAdminControllers.foundation = (root, kit) => {
  const { el, json, stat, gate } = kit;
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  gate(root.querySelector("#gate"), "any");

  const consoles = [["gold", "Gold reserve & token"], ["dollar", "Dollar ledger & funds"], ["world", "World moderation"]];
  root.querySelector("#consoles").replaceChildren(...consoles.map(([site, label]) => el("li", {}, el("a", { href: `#/operations/${site}`, textContent: label }))));

  async function load() {
    const [dollar, world, config] = await Promise.all([
      json("/api/v1/fth/stats?blocks=1&transactions=1&holders=1"),
      json("/api/v1/world/stats"),
      json("/api/v1/admin/config"),
    ]);
    root.querySelector("#status").replaceChildren(
      stat("FTH$ ledger height", `#${num(dollar.ledger.height)}`), stat("FTH$ holders", num(dollar.ledger.holders)),
      stat("World ledger height", `#${num(world.ledger.height)}`), stat("World posts", num(world.ledger.posts)), stat("World authors", num(world.ledger.authors)));
    const host = root.querySelector("#wallets");
    const list = (title, wallets) => el("div", {}, el("h3", { textContent: title }), wallets.length ? el("ul", {}, ...wallets.map((w) => el("li", {}, el("code", { textContent: w })))) : el("p", { textContent: "None configured." }));
    host.replaceChildren(list("Configured project wallets (FEATHERAL_ADMIN_WALLETS)", config.adminWallets), list("Fixed bridge project wallets (check roles in product consoles)", config.fthgAdminWallets));
  }
  load().catch((error) => {
    root.querySelector("#status").textContent = `Ecosystem status unavailable: ${error.message}`;
    root.querySelector("#wallets").textContent = `Wallet configuration unavailable: ${error.message}`;
  });
};
