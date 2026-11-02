"use strict";

(() => {
  const { el, api, fth, usd, count, short, timeAgo, stat, emptyRow, kindBadge, txLink, blockLink, accountLink, state } = window.FTH;
  const $ = (id) => document.getElementById(id);

  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar", walletUrl: "/wallet/" });

  function renderRate() {
    $("rateValue").textContent = `1 FTHG = ${state.rate.toLocaleString("en-US", { maximumFractionDigits: 2 })} FTH$`;
    $("rateNote").textContent = state.rateLive
      ? "Live spot rate from the bridge's constant-product curve; each conversion moves the price."
      : "Opening rate. A constant-product bridge curve sets the price once the pool is funded.";
  }

  function renderStats(data) {
    const s = data.ledger;
    $("primaryStats").replaceChildren(
      stat("Supply", fth(s.supply, 0), `${usd(s.supply)} est. · ${fth(s.circulating, 0)} circulating`),
      stat("Holders", count(s.holders), `${count(s.accounts)} accounts · ${count(s.profiles)} profiles`),
      stat("Block height", `#${count(s.height)}`, s.tipTime ? `Last block ${timeAgo(s.tipTime)}` : "No blocks yet"),
      stat("Transactions", count(s.transactions), `${count(s.pendingTransactions)} pending`),
      stat("Transfer volume", fth(s.transferVolume, 0), `${count(s.transfers)} wallet-signed transfers`),
      stat("Bridge credits", count(s.credits), "FTHG → FTH$ conversions and staking rewards"),
      stat("Withdrawals", count(s.settlements), `${count(s.pendingRedemptions)} pending · ${fth(s.reserved, 0)} reserved`),
      stat("Price est.", usd(window.FTH.ONE), `1 FTH$ at ${state.rate.toLocaleString("en-US")} FTH$ / FTHG`),
    );
    $("heroTip").textContent = `Layer 3 · block #${count(s.height)} · ${short(s.tipHash, 10, 6)}`;
    $("signingInfo").textContent = s.signedBlocks ? "Ed25519 writer signature S over each block hash (enabled on this node)" : "Ed25519 writer signature S over each block hash (not configured on this node)";
    $("statsUpdated").textContent = `Node ${data.node?.id || "?"} · ${data.node?.mode || "?"} · updated ${new Date(data.checkedAt).toLocaleTimeString()}`;

    $("blockRows").replaceChildren(...(data.latestBlocks.length ? data.latestBlocks.map((block) => el("tr", {},
      el("td", {}, blockLink(block.height)),
      el("td", { className: "hash", textContent: short(block.hash, 10, 6), title: block.hash }),
      el("td", { className: "num", textContent: count(block.transactions) }),
      el("td", { className: "muted", textContent: timeAgo(block.time) }),
    )) : [emptyRow(4, "No blocks yet.")]));

    $("txRows").replaceChildren(...(data.latestTransactions.length ? data.latestTransactions.map((tx) => el("tr", {},
      el("td", {}, kindBadge(tx.kind)),
      el("td", {}, txLink(tx.hash)),
      el("td", { className: "num", textContent: tx.kind === "PROFILE" ? "—" : fth(tx.amount) }),
      el("td", { className: "muted", textContent: tx.status === "pending" ? "pending" : timeAgo(tx.time) }),
    )) : [emptyRow(4, "No transactions yet. FTH$ is credited when FTHG is converted on the bridge.")]));

    $("holderRows").replaceChildren(...(data.richList.length ? data.richList.map((holder) => el("tr", {},
      el("td", { textContent: String(holder.rank) }),
      el("td", {}, accountLink(holder.accountId, holder.wallet)),
      el("td", { className: "num", textContent: fth(holder.balance) }),
      el("td", { className: "num", textContent: usd(holder.balance) }),
      el("td", { className: "num", textContent: `${(holder.shareBps / 100).toFixed(2)}%` }),
    )) : [emptyRow(5, "No holders yet.")]));
  }

  async function loadFiles() {
    try {
      const data = await api("/fth/files");
      const bytes = data.files.reduce((sum, file) => sum + file.bytes, 0);
      const years = new Set(data.files.map((file) => file.file.slice(0, 4))).size;
      $("fileStats").replaceChildren(
        stat("Day files", count(data.files.length), `${count(years)} year folder${years === 1 ? "" : "s"}`),
        stat("Ledger size", bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`, "Minified JSON lines"),
      );
    } catch { /* optional panel */ }
  }

  async function load() {
    $("statsUpdated").textContent = "Reading the FTH$ ledger…";
    try {
      renderStats(await api("/fth/stats"));
    } catch (error) {
      $("statsUpdated").textContent = `FTH$ ledger unavailable: ${error.message}`;
    }
  }

  $("refreshStats").addEventListener("click", () => { load(); loadFiles(); });
  load();
  loadFiles();
  // The bridge rate needs Mainnet RPC; re-render once it resolves without blocking the ledger view.
  window.FTH.loadRate().then(() => { renderRate(); load(); });
})();
