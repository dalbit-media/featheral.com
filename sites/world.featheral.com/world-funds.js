"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let state, view, request, working = false, generation = 0;
  const local = location.hostname.endsWith(".localhost");
  $("dollar-link").href = `${location.protocol}//${local ? "dollar.localhost" : "dollar.featheral.com"}${location.port ? ":" + location.port : ""}/wallet/`;
  $("dollar-link").addEventListener("click", event => { event.preventDefault(); location.assign("/wallet-sync.html"); });
  const format = raw => {
    const cents = (BigInt(raw) + 5n * 10n ** 15n) / 10n ** 16n;
    return `${(cents / 100n).toLocaleString()}${cents % 100n ? "." + (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "") : ""} FTH$`;
  };
  const fail = error => { console.error("World funds:", error); $("status").textContent = error.message; };
  async function api(path, body) {
    const response = await fetch("/api/dollar/game/" + path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(state ? { "X-CSRF-Token": state.csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Open World Play first in this browser, then return to World funds. " + (data.error || "") : data.error || `World API ${response.status}`);
    return data;
  }
  async function sign(message, address) {
    const result = await FeatheralWallet.authenticate(async selected => {
      if (selected.toLowerCase() !== address.toLowerCase()) throw new Error("Select the authorized wallet to transfer World funds.");
      return { message };
    });
    return result.signature;
  }
  async function refresh() {
    const current = ++generation;
    const nextView = await api("wallet/funds"), nextState = { csrf: nextView.csrf };
    if (current !== generation) return;
    state = nextState; view = nextView;
    if (!/^0x[0-9a-f]{64}$/.test(view.accountId)) throw new Error("World returned an invalid account.");
    localStorage.setItem("featheral-world-account", view.accountId);
    window.dispatchEvent(new CustomEvent("featheral:world-account", { detail: view.accountId }));
    $("world-balance").textContent = format(view.available);
    $("wallet-balance").textContent = view.walletAvailable === null ? "Connect & authorize" : format(view.walletAvailable);
    $("fund-wallet").textContent = view.wallet || "Guest account — existing funds remain in World.";
    $("fund-mode").textContent = view.mode === "separate" ? "Separate World budget. Gameplay cannot spend your wallet balance."
      : view.mode === "legacy-direct" ? "Legacy direct-wallet spending is active. Authorize a separate budget to stop direct spending; no funds move on authorization."
      : "Authorize your wallet to deposit into or withdraw from this World budget.";
    $("authorize").hidden = view.mode === "separate";
    $("authorize").disabled = working;
    $("review").disabled = view.mode !== "separate" || working;
    $("max").disabled = view.mode !== "separate" || working;
    $("pending").replaceChildren(); $("activity").replaceChildren();
    for (const item of view.requests) {
      if (item.status === "complete") {
        const row = document.createElement("p");
        row.textContent = `${item.parameters.direction === "deposit" ? "Deposited" : "Withdrew"} ${format(item.parameters.amount)} · ${new Date(item.at).toLocaleString()}`;
        $("activity").append(row);
      } else if (item.status !== "cancelled") {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = `Resume ${item.parameters.direction} ${format(item.parameters.amount)}`;
        button.disabled = working; button.onclick = () => execute(item).catch(fail); $("pending").append(button);
        if (item.status === "prepared") {
          const discard = document.createElement("button");
          discard.type = "button"; discard.textContent = "Discard preparation"; discard.disabled = working;
          discard.onclick = async () => {
            if (working || !confirm("Discard this unsigned preparation? An already signed native payment cannot be revoked.")) return;
            lock(true);
            try { await api("wallet/funds/cancel", { id: item.id }); if (request?.id === item.id) request = null; }
            catch (error) { fail(error); }
            finally { lock(false); refresh().catch(fail); }
          };
          $("pending").append(discard);
        }
        if (item.error) { const row = document.createElement("p"); row.textContent = item.error; $("pending").append(row); }
      }
    }
    if (!$("activity").children.length) $("activity").textContent = "No World deposits or withdrawals yet.";
  }
  function lock(value) {
    working = value;
    for (const element of [$("amount"), $("direction")]) element.disabled = value;
    $("authorize").disabled = value || !view;
    $("review").disabled = value || view?.mode !== "separate";
    $("max").disabled = value || view?.mode !== "separate";
  }
  $("max").onclick = () => {
    if (working || view?.mode !== "separate") return;
    const raw = BigInt($("direction").value === "deposit" ? view.walletAvailable : view.available);
    const fraction = (raw % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    $("amount").value = `${raw / 10n ** 18n}${fraction ? "." + fraction : ""}`;
    request = null;
  };
  async function execute(item) {
    if (working) return;
    lock(true);
    try {
      if (item.status === "prepared") item = await api("wallet/funds/prepare", { id: item.id, ...item.parameters });
      if (!confirm(`${item.parameters.direction === "deposit" ? "Deposit wallet → World" : "Withdraw World → wallet"}: ${format(item.parameters.amount)}.\nExact amount: ${item.parameters.amount} base units.\nWallet: ${view.wallet}\nNo funds are minted. Continue?`)) return;
      const signature = item.status === "paying" ? "" : await sign(item.message, view.wallet);
      await api("wallet/funds/complete", { id: item.id, signature });
      request = null;
      localStorage.setItem("featheral-wallet-updated", String(Date.now()));
      window.dispatchEvent(new Event("featheral:wallet-updated"));
      $("status").textContent = "Transfer settled. Both balances are updated.";
    } finally { lock(false); await refresh(); }
  }
  $("fund-form").oninput = () => { request = null; };
  $("fund-form").onsubmit = async event => {
    event.preventDefault();
    if (working) return;
    lock(true);
    try {
      if (!view || view.mode !== "separate") throw new Error("Authorize a separate World fund first.");
      const text = $("amount").value.trim();
      if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error("Enter a positive FTH$ amount with up to 18 decimals.");
      const [whole, fraction = ""] = text.split(".");
      const amount = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
      if (amount < 1n) throw new Error("Amount must be positive.");
      request ||= await api("wallet/funds/prepare", { id: crypto.randomUUID(), direction: $("direction").value, amount: amount.toString() });
      lock(false);
      await execute(request);
    } catch (error) { fail(error); }
    finally { lock(false); }
  };
  $("authorize").onclick = async () => {
    if (working) return;
    lock(true);
    try {
      if (!confirm("Enable a separate World budget for this wallet? No funds move now. Legacy direct-wallet spending stops. Deposits and withdrawals require separate approval.")) return;
      let issuedAt;
      const { address, signature } = await FeatheralWallet.authenticate(async address => {
        const authorization = await api("wallet/funds/authorization", { address });
        issuedAt = authorization.issuedAt;
        return { message: authorization.message };
      });
      await api("wallet/link", { address, issuedAt, signature, moveGuestFunds: false, separateWorldFunds: true });
      await refresh(); $("status").textContent = "Separate World budget authorized. Existing funds were not moved.";
    } catch (error) { fail(error); }
    finally { lock(false); }
  };
  $("walletButton").onclick = () => FeatheralWallet.open({ primary: "FTH$", view: "account", compact: true });
  refresh().catch(fail);
  window.addEventListener("focus", () => { if (!working) refresh().catch(fail); });
  setInterval(() => { if (!working && !document.hidden) refresh().catch(fail); }, 15000);
})();
