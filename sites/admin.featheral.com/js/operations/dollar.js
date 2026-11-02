"use strict";

window.FeatheralAdminControllers.dollar = (root, kit) => {
  const { el, json, stat, gate } = kit;
  const fmt = wei => ethers.formatUnits(wei, 18);
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  gate(root.querySelector("#gate"), "any");

  async function load() {
    const [{ ledger, node }, files] = await Promise.all([json("/api/v1/fth/stats?blocks=1&transactions=1&holders=1"), json("/api/v1/fth/files")]);
    root.querySelector("#stats").replaceChildren(
      stat("Height", `#${num(ledger.height)}`), stat("Supply FTH$", fmt(ledger.supply)), stat("Reserved", fmt(ledger.reserved)), stat("Circulating", fmt(ledger.circulating)),
      stat("Holders", num(ledger.holders)), stat("Accounts", num(ledger.accounts)), stat("Transactions", num(ledger.transactions)), stat("Pending redemptions", num(ledger.pendingRedemptions)));
    root.querySelector("#node").replaceChildren(el("pre", { className: "hash", textContent: JSON.stringify({ node, tipHash: ledger.tipHash, tipTime: ledger.tipTime, writerPublicKey: ledger.writerPublicKey }, null, 2) }));
    const host = root.querySelector("#files");
    if (files?.files) host.replaceChildren(el("p", { textContent: `${files.files.length} file(s), tip ${String(files.tipHash).slice(0, 18)}...` }), ...files.files.slice(-10).reverse().map((f) => el("div", {}, el("a", { href: `/api/v1/fth/files/${f.path || f.file}`, textContent: f.path || f.file }))));
    else host.textContent = "File manifest unavailable.";
  }
  load().catch((error) => { root.querySelector("#node").textContent = error.message; });
  window.LedgerSql.mount(root.querySelector("#sqlHost"), {
    base: "/api/v1/fth",
    title: "FTH$ ledger SQL",
    examples: [
      { title: "Transaction kinds", sql: "SELECT kind, count(*) AS n FROM transactions GROUP BY kind ORDER BY n DESC" },
      { title: "Open redemptions", sql: "SELECT * FROM redemptions WHERE status='reserved' LIMIT 50" },
      { title: "Top accounts", sql: "SELECT * FROM accounts ORDER BY balance_fth DESC LIMIT 25" },
    ],
  });
};
