"use strict";
// Buy FTHG widget: Uniswap v4 ETH/FTHG pool reserves, an on-site estimate, and wallet shortcuts.
(() => {
  const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const ONE = 1e18;
  const GAS_RESERVE = 0.003;
  const PRESETS = ["0.0005", "0.001", "0.002"];
  const ICONS = {
    swap: '<path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    pool: '<path d="M3 12c3-3 6 3 9 0s6 3 9 0"/><path d="M3 17c3-3 6 3 9 0s6 3 9 0"/><path d="M12 3v6"/>',
    chain: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
    wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3"/><path d="M3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 12h-4a2 2 0 0 0 0 4h4z"/>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }
  function icon(name) {
    const span = el("span", { className: "buy-icon" });
    span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }
  function action(tag, name, label, tip, props = {}) {
    const node = el(tag, { className: "btn buy-action", title: tip, ...props }, icon(name), label ? el("span", { textContent: label }) : null);
    node.setAttribute("aria-label", tip);
    return node;
  }
  const units = (raw) => Number(BigInt(raw || "0")) / ONE;
  const number = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
  const compact = (value) => Number.isFinite(value) ? value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : "—";
  function dollars(value) {
    if (!Number.isFinite(value)) return "—";
    if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  const swapUrl = (eth) => {
    const query = new URLSearchParams({ chain: "mainnet", inputCurrency: "NATIVE", outputCurrency: TOKEN });
    if (Number(eth) > 0) { query.set("exactField", "input"); query.set("exactAmount", eth); query.set("field", "input"); query.set("value", eth); }
    return `https://app.uniswap.org/swap?${query}`;
  };

  const wallets = [];
  window.addEventListener("eip6963:announceProvider", (event) => {
    const provider = event.detail?.provider;
    if (provider?.request && !wallets.some((wallet) => wallet.provider === provider)) wallets.push({ provider, name: event.detail.info?.name || "" });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  function injected() {
    const profile = window.FeatheralProfile?.getProvider?.();
    if (profile) return profile;
    return (wallets.find((wallet) => /metamask/i.test(wallet.name)) || wallets[0])?.provider || window.ethereum || null;
  }

  let rpcId = 0;
  async function rpc(method, params) {
    const response = await fetch("/api/v1/gold/rpc", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || `RPC HTTP ${response.status}`);
    return body.result;
  }

  function mountBuy(root) {
    const state = { market: null, account: "", chainId: 0, eth: null, fthg: null, provider: null };
    const status = el("p", { className: "buy-status muted", role: "status" });
    // Pages with the live statistics grid show pool figures there; elsewhere the widget brings its own.
    const standalone = !document.getElementById("primaryStats");
    const metrics = el("div", { className: "stat-grid buy-metrics" });
    const input = el("input", { type: "number", min: "0", step: "any", value: "0.001", inputMode: "decimal", id: `${root.id}-eth` });
    input.setAttribute("aria-label", "ETH to spend");
    const presets = el("div", { className: "buy-presets" }, ...PRESETS.map((value) => {
      const chip = el("button", { type: "button", className: "btn small", textContent: `${value} ETH`, title: `Spend ${value} ETH` });
      chip.onclick = () => { input.value = value; update(); };
      return chip;
    }));
    const max = el("button", { type: "button", className: "btn small", textContent: "Max", title: `Wallet ETH balance minus ${GAS_RESERVE} ETH for gas`, hidden: true });
    max.onclick = () => { input.value = String(Math.max(0, Math.floor((state.eth - GAS_RESERVE) * 1e6) / 1e6)); update(); };
    presets.append(max);
    const receive = el("b", { className: "buy-receive", textContent: "—" });
    const receiveNote = el("small", { className: "muted" });
    const impact = el("small", { className: "buy-impact" });
    const buy = action("a", "swap", "Buy FTHG now", "Buy FTHG with ETH on Uniswap. This order is prefilled; you confirm it in your wallet.", { target: "_blank", rel: "noopener noreferrer" });
    buy.classList.add("primary", "buy-now");
    const connect = action("button", "wallet", "Connect wallet", "Connect your Ethereum wallet to see your address and balances", { type: "button" });
    const network = action("button", "chain", "Ethereum", "Switch your wallet to Ethereum Mainnet", { type: "button", hidden: true });
    const watch = action("button", "plus", "", "Add FTHG to your wallet's token list", { type: "button" });
    const copy = action("button", "copy", "", "Copy the FTHG token address", { type: "button" });
    const pool = action("a", "pool", "", "View the ETH/FTHG pool on Uniswap", { target: "_blank", rel: "noopener noreferrer",
      href: "https://app.uniswap.org/explore/pools/ethereum/0x3f1f8a9867d8f4a59f206b9644fafe05e9546323c0219dd1352187bbb5738fdd" });
    const address = el("code", { className: "buy-address" });
    const ethBalance = el("b", { textContent: "—" }), fthgBalance = el("b", { textContent: "—" });
    const account = el("div", { className: "buy-wallet", hidden: true },
      el("div", { className: "buy-wallet-head" }, icon("wallet"), address),
      el("div", { className: "buy-balances" },
        el("div", {}, el("span", { textContent: "ETH" }), ethBalance),
        el("div", {}, el("span", { textContent: "FTHG" }), fthgBalance)));
    const priceValue = el("b", { className: "buy-price-value", textContent: "—" });
    const priceNote = el("span", { className: "buy-price-note" });
    const perDollar = el("b", { className: "buy-per-dollar", textContent: "—" });

    root.replaceChildren(
      el("div", { className: "buy-card" },
        el("div", { className: "buy-hero" },
          el("div", {},
            el("span", { className: "buy-badge", textContent: "Early pool price" }),
            el("div", { className: "buy-price" }, el("span", { textContent: "1 FTHG =" }), priceValue),
            priceNote),
          el("div", { className: "buy-per" }, el("span", { textContent: "$1 buys about" }), perDollar, el("span", { textContent: "FTHG" }))),
        el("div", { className: "buy-body" },
          el("div", { className: "buy-form" },
            el("label", { htmlFor: input.id, className: "buy-label" }, el("span", { textContent: "You pay" }), el("span", { className: "buy-unit", textContent: "ETH" })),
            input, presets,
            el("div", { className: "buy-label buy-get" }, el("span", { textContent: "You get ≈" }), el("span", { className: "buy-unit", textContent: "FTHG" })),
            receive, receiveNote, impact),
          el("div", { className: "buy-side" },
            buy,
            account,
            el("div", { className: "buy-actions" }, connect, network, watch, copy, pool))),
        el("div", { className: "buy-foot" }, status,
          el("small", { className: "buy-risk", textContent: "Early, small pool: the price can move quickly either way. Not investment advice." }))),
      ...(standalone ? [metrics] : []));

    function quote(eth) {
      const market = state.market;
      if (!market || market.fallback || !market.liquidity || !market.fthgPerEth || !(eth > 0)) return null;
      // Virtual in-range reserves of a concentrated-liquidity pool: x = L/√P, y = L·√P (both tokens use 18 decimals).
      const price = units(market.fthgPerEth), liquidity = Number(market.liquidity);
      const sqrt = Math.sqrt(price), x = liquidity / sqrt / ONE, y = liquidity * sqrt / ONE;
      const spent = eth * (1 - 0.0025);
      const out = y * spent / (x + spent);
      return { out, impact: 1 - out / (spent * price), usd: out * units(market.usdPerFthg) };
    }
    function update() {
      const eth = Number(input.value);
      const amount = eth > 0 ? String(input.value) : "";
      buy.href = swapUrl(amount);
      const result = quote(eth);
      receive.textContent = result ? number(result.out, 0) : "—";
      receiveNote.textContent = result ? `≈ ${dollars(result.usd)} · 0.25% pool fee included` : state.market ? "Enter an ETH amount" : "Loading pool…";
      impact.textContent = result ? `Price impact ${number(result.impact * 100, 2)}%` : "";
      impact.dataset.level = !result ? "" : result.impact > 0.05 ? "high" : result.impact > 0.01 ? "medium" : "low";
      if (result?.impact > 0.05) impact.textContent += " · pool is small, consider a smaller swap";
      if (state.eth !== null && eth > state.eth) impact.textContent = "Amount exceeds your ETH balance";
    }
    function renderMetrics() {
      const market = state.market;
      if (!market) return;
      const reserves = market.reserves;
      const stat = (label, value, note) => el("div", { className: "stat" }, el("span", { textContent: label }), el("b", { textContent: value }), el("small", { textContent: note }));
      metrics.replaceChildren(
        stat("Pool ETH", reserves ? `${number(units(reserves.eth), 4)} ETH` : "—", reserves ? dollars(units(reserves.eth) * units(market.usdPerEth)) : "Reading pool…"),
        stat("Pool FTHG", reserves ? `${compact(units(reserves.fthg))} FTHG` : "—", reserves ? `${number(units(reserves.fthg), 0)} FTHG` : "Reading pool…"),
        stat("Pool value", reserves ? dollars(units(reserves.tvlUsd)) : "—", reserves ? `${reserves.positions} liquidity position${reserves.positions === 1 ? "" : "s"}` : "ETH + FTHG at spot"),
        stat("FTHG per ETH", market.fallback ? "—" : compact(units(market.fthgPerEth)), "Uniswap v4 spot"));
      const price = market.fallback ? 0.01 : units(market.usdPerFthg);
      priceValue.textContent = dollars(price);
      perDollar.textContent = number(1 / price, 0);
      priceNote.textContent = market.fallback ? "Reference price until the pool has data" : `All 216M FTHG valued at just $${compact(units(market.usdPerFthg) * 216265000)} at today's pool price`;
      status.textContent = market.fallback ? "Pool price is unavailable right now; showing the $0.01 reference." : `Uniswap v4 · ETH/FTHG · 0.25% fee · block #${Number(market.block).toLocaleString("en-US")}`;
    }
    async function loadMarket() {
      try {
        const response = await fetch("/api/v1/gold/valuation", { headers: { accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.market = (await response.json()).market;
        renderMetrics();
      } catch (error) {
        status.textContent = `Pool data unavailable (${error.message}). You can still swap on Uniswap.`;
      }
      update();
    }
    async function loadBalances() {
      if (!state.account) return;
      const padded = state.account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const [eth, fthg] = await Promise.all([rpc("eth_getBalance", [state.account, "latest"]),
        rpc("eth_call", [{ to: TOKEN, data: `0x70a08231${padded}` }, "latest"])]);
      state.eth = units(BigInt(eth)); state.fthg = units(BigInt(fthg));
      ethBalance.textContent = number(state.eth, 4);
      fthgBalance.textContent = number(state.fthg, 0);
      max.hidden = false;
      update();
    }
    async function useAccounts(accounts) {
      state.account = accounts?.[0] || "";
      connect.hidden = Boolean(state.account);
      try { state.chainId = Number(await state.provider.request({ method: "eth_chainId" })); } catch { state.chainId = 0; }
      network.hidden = !state.account || state.chainId === 1;
      account.hidden = !state.account;
      address.textContent = state.account ? `${state.account.slice(0, 6)}…${state.account.slice(-4)}` : "";
      address.title = state.account;
      ethBalance.textContent = fthgBalance.textContent = "…";
      if (!state.account) { max.hidden = true; state.eth = null; update(); return; }
      await loadBalances().catch((error) => { ethBalance.textContent = fthgBalance.textContent = "—"; status.textContent = `Balance unavailable: ${error.message}`; });
    }
    async function withWallet(task) {
      state.provider = state.provider || injected();
      if (!state.provider) {
        status.textContent = "No browser wallet found. Install MetaMask or open this page in your wallet's browser.";
        return;
      }
      if (state.market) renderMetrics();
      try { await task(state.provider); } catch (error) {
        if (error?.code !== 4001) status.textContent = error?.message || String(error);
      }
    }
    const ensureMainnet = (provider) => provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });

    connect.onclick = () => withWallet(async (provider) => {
      provider.on?.("accountsChanged", useAccounts);
      provider.on?.("chainChanged", () => useAccounts([state.account]));
      await useAccounts(await provider.request({ method: "eth_requestAccounts" }));
    });
    network.onclick = () => withWallet(async (provider) => { await ensureMainnet(provider); await useAccounts([state.account]); });
    watch.onclick = () => withWallet(async (provider) => {
      if (state.chainId !== 1) await ensureMainnet(provider);
      const added = await provider.request({ method: "wallet_watchAsset", params: { type: "ERC20",
        options: { address: TOKEN, symbol: "FTHG", decimals: 18, image: new URL("/shared/logo-gold.svg", location.origin).href } } });
      status.textContent = added ? "FTHG added to your wallet." : "FTHG was not added.";
    });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(TOKEN); status.textContent = "FTHG token address copied."; }
      catch { window.prompt("FTHG token address:", TOKEN); }
    };
    input.addEventListener("input", update);
    state.provider = injected();
    if (state.provider) {
      state.provider.request({ method: "eth_accounts" }).then((accounts) => {
        if (accounts?.length) {
          state.provider.on?.("accountsChanged", useAccounts);
          return useAccounts(accounts);
        }
      }).catch(() => {});
    }
    update();
    loadMarket();
    setInterval(loadMarket, 60000);
  }

  for (const [index, root] of document.querySelectorAll("[data-buy-fthg], #buyFthg").entries()) {
    root.id ||= `buy-fthg-${index}`;
    mountBuy(root);
  }
})();
