"use strict";
(() => {
  const scale = 10n ** 18n;
  const exact = raw => {
    const value = BigInt(raw), fraction = (value % scale).toString().padStart(18, "0").replace(/0+$/, "");
    return `${value / scale}${fraction ? "." + fraction : ""}`;
  };
  const display = raw => {
    const value = BigInt(raw), rounded = (value + 5n * 10n ** 15n) / 10n ** 16n;
    if (value > 0n && rounded === 0n) return "<0.01";
    const fraction = (rounded % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    return `${(rounded / 100n).toLocaleString()}${fraction ? "." + fraction : ""}`;
  };
  const amountUnits = text => {
    if (typeof text !== "string" || !/^\d{1,60}(?:\.\d{1,18})?$/.test(text.trim())) throw new Error("Enter a positive FTH$ amount with up to 18 decimals.");
    const [whole, fraction = ""] = text.trim().split(".");
    const value = BigInt(whole) * scale + BigInt(fraction.padEnd(18, "0"));
    if (value <= 0n) throw new Error("Amount must be positive.");
    return value;
  };
  function mount(root, options = {}) {
    if (root.worldFunds) return root.worldFunds;
    root.classList.add("world-funds-panel");
    root.innerHTML = `<div class="wf-heading"><h3>World funds</h3><button type="button" data-wf="refresh">Refresh balances</button></div>
      <div class="wf-balances"><div><small>Game budget</small><strong data-wf="world">Loading...</strong></div><div><small>Dollar wallet</small><strong data-wf="wallet">Loading...</strong></div></div>
      <p data-wf="mode" class="wf-note"></p><p data-wf="address" class="wf-address" data-no-localize></p>
      <a href="/account/" data-wf="signin" hidden>Sign in to World</a><button type="button" data-wf="authorize" hidden>Enable separate game budget</button>
      <form data-wf="form"><div class="wf-directions" role="group" aria-label="Transfer direction"><button type="button" data-wf="deposit" aria-pressed="true">Deposit to game</button><button type="button" data-wf="withdraw" aria-pressed="false">Withdraw to wallet</button></div>
      <label>FTH$ amount<span class="wf-amount"><input data-wf="amount" inputmode="decimal" required placeholder="0.00" aria-label="FTH$ transfer amount" autocomplete="off"><button type="button" data-wf="max">Max</button></span></label>
      <p data-wf="preview" class="wf-note" data-no-localize></p><button type="submit" data-wf="submit">Review deposit</button></form>
      <section data-wf="review" class="wf-review" hidden aria-label="Review transfer"><h4>Review transfer</h4><p data-wf="summary" data-no-localize></p><p class="wf-note">Only this amount moves to your linked account. No gas, minting or Ethereum transaction.</p><button type="button" data-wf="approve">Approve and transfer</button><button type="button" data-wf="back">Back</button></section>
      <p data-wf="status" role="status" aria-live="polite"></p><div data-wf="pending"></div><details><summary>Recent transfers</summary><div data-wf="activity"></div></details>`;
    const $ = name => root.querySelector(`[data-wf="${name}"]`);
    let view, direction = "deposit", prepared = null, busy = false, submitting = false, refreshing = null, disposed = false, controller;
    const report = error => {
      console.error("World funds:", error);
      $("status").textContent = error.message || "World transfer failed. Refresh balances and retry.";
      $("status").setAttribute("role", "alert");
    };
    async function api(path, body) {
      const activeController = new AbortController(); controller = activeController;
      const timer = setTimeout(() => activeController.abort(), 15000), signal = activeController.signal;
      try {
        const response = await fetch("/api/dollar/game/wallet/" + path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", ...(view ? { "X-CSRF-Token": view.csrf } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.headers.get("content-type")?.includes("json")) throw new Error("World funds service is unavailable. Retry shortly.");
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || `World funds HTTP ${response.status}`), { status: response.status });
        return data;
      } finally { clearTimeout(timer); }
    }
    function controls() {
      const enabled = view?.mode === "separate" && !busy;
      for (const name of ["amount", "deposit", "withdraw", "max", "submit"]) $(name).disabled = !enabled;
      for (const name of ["refresh", "authorize", "approve", "back"]) $(name).disabled = busy;
      root.setAttribute("aria-busy", String(busy));
      $("submit").textContent = direction === "deposit" ? "Review deposit" : "Review withdrawal";
      $("deposit").setAttribute("aria-pressed", String(direction === "deposit"));
      $("withdraw").setAttribute("aria-pressed", String(direction === "withdraw"));
    }
    function preview() {
      $("preview").textContent = "";
      if (!view || view.mode !== "separate" || !$("amount").value.trim()) return;
      try {
        const amount = amountUnits($("amount").value), game = BigInt(view.available), wallet = BigInt(view.walletAvailable);
        const source = direction === "deposit" ? wallet : game;
        $("preview").textContent = amount > source ? `Available: ${display(source)} FTH$. Enter a smaller amount.`
          : `After transfer: Game ${display(direction === "deposit" ? game + amount : game - amount)} · Wallet ${display(direction === "deposit" ? wallet - amount : wallet + amount)} FTH$`;
      } catch (error) { $("preview").textContent = error.message; }
    }
    const button = (label, run) => {
      const control = document.createElement("button"); control.type = "button"; control.textContent = label; control.disabled = busy;
      control.onclick = () => void run().catch(report); return control;
    };
    function paint() {
      $("world").textContent = `${display(view.available)} FTH$`;
      $("wallet").textContent = view.walletAvailable === null ? "Not linked" : `${display(view.walletAvailable)} FTH$`;
      $("address").textContent = view.wallet ? `Linked wallet: ${view.wallet}` : "Your existing guest funds remain in World.";
      $("mode").textContent = view.mode === "separate" ? "Balances sync automatically; moving funds requires your approval. Gameplay spends only the game budget."
        : view.mode === "legacy-direct" ? "Game and wallet already use the same balance. Do not count it twice. Keep this mode, or explicitly enable a separate budget."
        : "Sign in to your World account to connect its settlement and funds.";
      $("authorize").hidden = view.mode !== "legacy-direct";
      $("signin").hidden = view.mode !== "guest";
      $("form").hidden = view.mode !== "separate";
      $("pending").replaceChildren(); $("activity").replaceChildren();
      for (const item of view.requests) {
        if (item.status === "complete") {
          const row = document.createElement("p");
          row.textContent = `${item.parameters.direction === "deposit" ? "Deposited" : "Withdrew"} ${display(item.parameters.amount)} FTH$ · ${new Date(item.at).toLocaleString()}`;
          $("activity").append(row);
        } else if (item.status !== "cancelled") {
          $("pending").append(button(`${item.status === "paying" ? "Check settlement" : "Review pending"} · ${display(item.parameters.amount)} FTH$ ${item.parameters.direction}`, async () => {
            if (busy) return;
            await review(item);
          }));
          if (item.status === "prepared") $("pending").append(button("Discard unsigned preparation", async () => {
            if (busy) return; busy = true; controls();
            try { await api("funds/cancel", { id: item.id }); prepared = null; $("review").hidden = true; }
            finally { busy = false; controls(); await refresh(); }
          }));
          if (item.error) { const row = document.createElement("p"); row.textContent = item.error; $("pending").append(row); }
        }
      }
      if (!$("activity").children.length) $("activity").textContent = "No deposits or withdrawals yet.";
      controls(); preview(); options.onRender?.();
    }
    async function refresh() {
      if (disposed || busy) return;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const next = await api("funds");
        if (disposed) return;
        if (!/^0x[0-9a-f]{64}$/i.test(next.accountId) || !Array.isArray(next.requests)) throw new Error("World returned an invalid fund account.");
        if (view && (view.wallet !== next.wallet || view.accountId !== next.accountId || view.csrf !== next.csrf)) {
          prepared = null; $("review").hidden = true; $("amount").value = "";
        }
        const changed = view?.accountId !== next.accountId;
        view = next; paint();
        if (changed) {
          try { localStorage.setItem("featheral-world-account", next.accountId); }
          catch (error) { console.warn("World public account display could not be stored.", error); }
          window.dispatchEvent(new CustomEvent("featheral:world-account", { detail: next.accountId }));
        }
      })().finally(() => { refreshing = null; });
      return refreshing;
    }
    async function sign(message, address) {
      const world = window.FeatheralWorldAccount;
      if (world) {
        const session = await world.refresh();
        if (!session?.account || session.account.toLowerCase() !== address.toLowerCase()) throw new Error("Sign in to the World account linked to this settlement.");
        const hex = "0x" + Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, "0")).join("");
        const signature = await world.provider.request({ method: "personal_sign", params: [hex, address] });
        if (world.snapshot()?.account?.toLowerCase() !== address.toLowerCase()) throw new Error("World account changed. Refresh balances before transferring.");
        return signature;
      }
      if (!window.FeatheralWallet) throw new Error("Wallet is still loading. Retry shortly.");
      const result = await window.FeatheralWallet.authenticate(async selected => {
        if (selected.toLowerCase() !== address.toLowerCase()) throw new Error("Select the wallet linked to this settlement.");
        return { message };
      });
      return result.signature;
    }
    async function review(item) {
      if (refreshing) await refreshing;
      busy = true; controls();
      try {
        prepared = item.status === "prepared" ? await api("funds/prepare", { id: item.id, ...item.parameters }) : item;
        $("summary").textContent = `${prepared.parameters.direction === "deposit" ? "Dollar wallet → Game budget" : "Game budget → Dollar wallet"}: ${display(prepared.parameters.amount)} FTH$\nWallet: ${prepared.wallet}`;
        $("approve").textContent = prepared.status === "paying" ? "Check and finish settlement" : "Approve and transfer";
        $("review").hidden = false;
      } finally { busy = false; controls(); }
      $("approve").focus();
    }
    $("form").onsubmit = event => {
      event.preventDefault();
      void (async () => {
        if (busy || submitting) return;
        submitting = true;
        try {
          await refresh();
          const amount = amountUnits($("amount").value);
          if (amount > BigInt(direction === "deposit" ? view.walletAvailable : view.available)) throw new Error("Insufficient available funds.");
          if (!prepared || prepared.parameters.amount !== amount.toString() || prepared.parameters.direction !== direction)
            prepared = { id: crypto.randomUUID(), parameters: { direction, amount: amount.toString() }, status: "prepared" };
          await review(prepared);
        } catch (error) { report(error); }
        finally { submitting = false; }
      })();
    };
    $("approve").onclick = () => void (async () => {
      if (busy || !prepared) return;
      busy = true; controls();
      const item = prepared;
      try {
        $("status").setAttribute("role", "status");
        $("status").textContent = item.status === "paying" ? "Checking durable settlement..." : "Approve the exact transfer with your World wallet...";
        const signature = item.status === "paying" ? "" : await sign(item.message, item.wallet);
        const result = await api("funds/complete", { id: item.id, signature });
        if (!result.requests?.some(row => row.id === item.id && row.status === "complete")) throw new Error("Transfer has no completed receipt. Check pending transfers before retrying.");
        prepared = null; $("review").hidden = true; $("amount").value = "";
        $("status").textContent = "Transfer settled. Game and wallet balances are updated.";
        try { localStorage.setItem("featheral-wallet-updated", String(Date.now())); }
        catch (error) { console.warn("Wallet refresh notification could not be stored.", error); }
        window.dispatchEvent(new Event("featheral:wallet-updated"));
        await options.onSettled?.();
      } catch (error) { report(error); }
      finally { busy = false; controls(); await refresh().catch(report); }
    })();
    for (const name of ["deposit", "withdraw"]) $(name).onclick = () => {
      if (busy) return; direction = name; prepared = null; $("review").hidden = true; controls(); preview();
    };
    $("amount").oninput = () => { prepared = null; $("review").hidden = true; preview(); };
    $("max").onclick = () => { $("amount").value = exact(direction === "deposit" ? view.walletAvailable : view.available); prepared = null; $("review").hidden = true; preview(); };
    $("back").onclick = () => { $("review").hidden = true; };
    $("refresh").onclick = () => void refresh().catch(report);
    $("authorize").onclick = () => void (async () => {
      if (busy) return;
      busy = true; controls();
      try {
        const authorization = await api("funds/authorization", { address: view.wallet });
        const signature = await sign(authorization.message, view.wallet);
        await api("link", { address: view.wallet, issuedAt: authorization.issuedAt, signature, moveGuestFunds: false, separateWorldFunds: true });
        await options.onSettled?.();
      } catch (error) { report(error); }
      finally { busy = false; controls(); await refresh().catch(report); }
    })();
    const onFocus = () => { if (!document.hidden && root.isConnected && root.getClientRects().length && !root.closest("dialog:not([open])")) void refresh().catch(report); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("featheral:wallet-updated", onFocus);
    const onStorage = event => { if (event.key === "featheral-wallet-updated") onFocus(); };
    window.addEventListener("storage", onStorage);
    const interval = setInterval(onFocus, 30000);
    root.worldFunds = { refresh, dispose() {
      disposed = true; controller?.abort(); clearInterval(interval);
      window.removeEventListener("focus", onFocus); window.removeEventListener("featheral:wallet-updated", onFocus); window.removeEventListener("storage", onStorage);
    } };
    void refresh().catch(error => {
      report(error);
      if (error.status === 401) { $("signin").hidden = false; $("signin").href = "/login/?returnTo=" + encodeURIComponent(location.href); }
    });
    return root.worldFunds;
  }
  window.FeatheralWorldFunds = { mount, exact, amountUnits };
  const root = document.querySelector("[data-world-funds]");
  if (root) void (async () => {
    try {
      if (window.FeatheralWorldAccount) {
        if (!await window.FeatheralWorldAccount.requireProfile()) return;
        await window.FeatheralWorldAccount.request("/game", {});
      }
      mount(root);
    } catch (error) { console.error("World funds unavailable:", error); root.textContent = error.message; }
  })();
})();
