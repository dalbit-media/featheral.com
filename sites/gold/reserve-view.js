"use strict";

(() => {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const units = raw => {
    const [whole, fraction] = ethers.formatUnits(raw || "0", 18).split(".");
    return `${BigInt(whole).toLocaleString("en-US")}${fraction === "0" ? "" : `.${fraction}`}`;
  };
  const dollars = raw => {
    const cents = (BigInt(raw || "0") + 5n * 10n ** 15n) / 10n ** 16n;
    return `${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  };
  async function api(path) {
    const response = await fetch(`/api/v1/gold/reserve${path}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Reserve HTTP ${response.status}`);
    return data;
  }
  function metric(label, value, note) {
    const card = node("div", undefined, "reserve-metric");
    card.append(node("span", label), node("strong", value), node("small", note));
    return card;
  }
  function render(state, actual) {
    const pending = BigInt(state.pendingIn) + BigInt(state.pendingOut);
    document.getElementById("sync-state").textContent = pending ? "OFF-SYNC · Ethereum transfers pending" : "No pending Ethereum transfers";
    document.getElementById("sync-state").className = pending ? "reserve-badge pending" : "reserve-badge confirmed";
    const origin = document.getElementById("origin-flow"), reserve = document.getElementById("reserve-flow");
    function wallet(target, title, address, incoming, outgoing, pendingIn, pendingOut, actualAmount) {
      target.replaceChildren(node("h3", title), node("code", address));
      target.append(metric("Actual Ethereum holdings", actual ? `${units(actualAmount)} FTHG` : "Not checked", actual ? `Finalized block ${actual.evidence.block.toLocaleString("en-US")}` : "Use Verify actual balances; an allocation is not a balance."));
      const flows = node("dl", undefined, "flow-totals");
      for (const [label, value] of [["Confirmed in", incoming], ["Confirmed out", outgoing], ["OFF-SYNC incoming", pendingIn], ["OFF-SYNC outgoing", pendingOut]]) {
        flows.append(node("dt", label), node("dd", `${units(value)} FTHG`, label.includes("OFF-SYNC") ? "pending-text" : ""));
      }
      target.append(flows);
    }
    wallet(origin, "Origin wallet", state.sourceWallet, state.settledOut, state.settledIn, state.pendingOut, state.pendingIn, actual?.actualOrigin);
    wallet(reserve, "FTH$ backing wallet · FTHG on Ethereum", state.reserveWallet, state.settledIn, state.settledOut, state.pendingIn, state.pendingOut, actual?.actualReserve);
    document.getElementById("reserve-metrics").replaceChildren(
      metric("Initial reserve allocated", `${units(state.allocated)} FTHG`, `Immutable cap: ${units(state.cap)} FTHG`),
      metric("Unallocated initial reserve", `${units(state.remaining)} FTHG`, state.exhausted ? "Exhausted — initial issuance has stopped." : "One-time market bootstrap only; treasury first."),
      metric("Confirmed redeemable backing", `${units(state.redeemableBacking)} FTHG`, "Unconfirmed allocations cannot be redeemed."),
      metric("Locked redeemed currency", `${dollars(state.lockedRedemptionDollars)} FTH$`, "Cannot be spent on markets; reconversion unlocks the same currency."),
    );
    document.getElementById("reserve-mode").textContent = `${state.mode === "live" ? "Live off-chain economy" : "Isolated test economy"} · 1 FTHG = ${Number(state.rate).toLocaleString("en-US")} FTH$`;
  }
  function row(item) {
    const tr = node("tr");
    const labels = { "fund-market": "Market funding", redeem: "Redemption", convert: "Reconversion", sync: "Ethereum settlement" };
    const cell = (text, cls) => { const td = node("td", text, cls); tr.append(td); return td; };
    cell(new Date(item.time).toLocaleString());
    const operation = cell(labels[item.operation]);
    operation.append(node("small", item.asset ? `${item.asset} · ${item.quantity.toLocaleString("en-US")} lots` : `Block ${item.height}`));
    cell(item.direction === "treasury-to-market" ? "No FTHG transfer · treasury funding" : item.direction === "origin-to-reserve" ? "Origin → FTH$ backing" : "FTH$ backing → Origin");
    const amount = cell(`${units(item.fthg)} FTHG`, "numeric");
    amount.title = `Exact FTHG base units: ${item.fthg}`;
    const currency = cell(item.operation === "sync" ? "No currency movement" : `${dollars(item.dollars)} FTH$`, "numeric");
    currency.title = `Exact FTH$ base units: ${item.dollars}`;
    if (BigInt(item.treasuryDollars)) currency.append(node("small", `${dollars(item.treasuryDollars)} FTH$ from treasury`));
    if (item.operation === "fund-market") currency.append(node("small", `Into ${item.asset} market`));
    if (item.operation === "redeem") currency.append(node("small", "Into locked redemption escrow"));
    if (item.operation === "convert") currency.append(node("small", "Escrow → origin FTH$ account"));
    const status = cell();
    status.append(node("span", item.recordType === "ethereum-confirmed" ? "ETH CONFIRMED"
      : item.recordType === "treasury-circulation" ? "CIRCULATION" : "OFF-CHAIN", `reserve-badge ${item.recordType === "ethereum-confirmed" ? "confirmed" : "pending"}`));
    const receipt = cell();
    const link = node("a", item.ethereumTx ? "Ethereum receipt ↗" : "Dollar journal ↗");
    link.href = item.ethereumTx ? `https://etherscan.io/tx/${item.ethereumTx}` : window.FeatheralSites.url("dollar", `/explorer/#/tx/${item.hash}`);
    link.target = "_blank"; link.rel = "noopener noreferrer"; receipt.append(link);
    return tr;
  }
  function history() {
    let cursor = null, loading = false;
    const tbody = document.getElementById("reserve-transactions"), more = document.getElementById("history-more");
    const message = document.getElementById("history-status");
    async function load(reset = false) {
      if (loading) return;
      loading = true; more.disabled = true;
      if (reset) { cursor = null; tbody.replaceChildren(); }
      try {
        message.dataset.error = "false";
        const data = await api(`/activity?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        tbody.append(...data.items.map(row));
        cursor = data.nextCursor;
        message.textContent = tbody.children.length ? data.note : cursor ? "No reserve transactions on this page. Load older transactions to continue."
          : "No reserve transactions yet. Markets are funded once on first eligible use.";
        more.hidden = !cursor;
      } catch (error) { message.textContent = error.message; message.dataset.error = "true"; more.hidden = true; }
      finally { loading = false; more.disabled = false; }
    }
    more.addEventListener("click", () => load());
    return () => load(true);
  }
  window.FeatheralReserveView = { api, render, history, units, dollars };
})();
