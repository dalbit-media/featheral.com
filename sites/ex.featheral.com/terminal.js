"use strict";
(() => {
  const $ = id => document.getElementById(id), unit = 10n ** 18n;
  const requiredElements = [
    "notes-link", "gold-channel", "candle-chart", "initial-dollar-funding", "supply-admin-link", "market-selector", "market-toggle",
    "overview-markets", "overview-funded", "overview-volume", "pending-movements",
    "terminal-status", "provider-connect", "disconnect", "trading-owner", "trading-total",
    "positions", "trade-history", "movement-history", "legacy-requests",
    "market-list", "market-search", "market-filter", "market-list-status", "market-title", "spot-price", "usd-price",
    "market-detail", "reference-detail", "chart-interval", "chart-fullscreen", "refresh-market",
    "order-form", "order-side", "order-amount-label", "order-amount", "order-slippage", "order-preview", "execute-order",
    "deposit-form", "deposit-amount", "withdraw-form", "withdraw-symbol", "withdraw-amount",
    "liquidity-form", "liquidity-symbol", "liquidity-action", "liquidity-amount", "liquidity-positions",
    "funding-form", "funding-dollar", "funding-fthx", "funding-approval",
    "market-mode", "gold-pool-details", "recovery-notice", "world-executions", "world-trade-link", "world-trade-records",
    "data-status", "day-change", "day-high", "day-low", "pair-volume", "pair-reserve",
    "depth-asks", "depth-bids", "depth-midpoint", "depth-status", "recent-trades",
    "side-buy", "side-sell", "order-available", "size-25", "size-50", "size-75", "size-100",
    "show-balances", "show-trades", "show-movements", "balances-record", "trades-record", "movements-record",
  ];
  const missingElements = requiredElements.filter(id => !$(id));
  if (missingElements.length || !window.FeatheralMarketView) {
    const message = "Exchange page and script versions do not match. Trading is disabled. Reload this page (Ctrl+Shift+R). If this persists, update the Exchange HTML and scripts together.";
    console.error(message, { missingElements });
    const status = $("terminal-status") || document.createElement("p");
    status.textContent = message;
    status.setAttribute("role", "alert");
    if (!$("terminal-status")) document.body.prepend(status);
    document.querySelectorAll("form input, form select, form button, .signin button, #execute-order")
      .forEach(control => { control.disabled = true; });
    document.querySelectorAll("form").forEach(form => form.addEventListener("submit", event => event.preventDefault()));
    return;
  }
  const hostUrl = name => `${location.protocol}//${location.hostname.endsWith(".localhost") ? name + ".localhost" : name + ".featheral.com"}${location.port ? ":" + location.port : ""}`;
  $("notes-link").href = hostUrl("notes") + "/";
  $("gold-channel").href = "/gold-channel/";
  $("world-trade-link").href = hostUrl("world") + "/market/";
  $("supply-admin-link").href = hostUrl("admin") + "/#/notes";
  let autoSelect = !new URLSearchParams(location.search).has("market"), firstHistory = true, displayedMarket = "";
  let token = "", owner = "", markets = [], selected = new URLSearchParams(location.search).get("market") || "FTH$", account, preview, quoteGeneration = 0, refreshing = false, busy = false;
  const chart = window.FeatheralCandleChart.mount($("candle-chart"));
  const marketView = window.FeatheralMarketView;
  function orderBalance() {
    const side = $("order-side").value, symbol = side === "buy" ? "FTHX" : selected;
    const balance = account?.holdings.find(asset => asset.symbol === symbol)?.balance || "0";
    $("order-amount-label").firstChild.textContent = `Input (${symbol})`;
    $("order-available").textContent = account ? `Available: ${format(balance, symbol)}` : "Connect to view available balance.";
    $("side-buy").setAttribute("aria-pressed", String(side === "buy"));
    $("side-sell").setAttribute("aria-pressed", String(side === "sell"));
    $("execute-order").setAttribute("data-side", side);
    return { symbol, balance };
  }
  function applyMarketMode() {
    const reference = selected === "FTHG";
    const market = markets.find(market => market.symbol === selected), world = Boolean(market?.inventoryOnly);
    $("market-mode").textContent = world ? "Executed World inventory market. Trade these items in World; they are not wallet notes. FTHX prices use the internal denomination, not an AMM currency swap."
      : market?.tradingOnly ? market.description
      : reference ? "Reference / conversion only. No internal FTHG pool or direct Exchange order. Use the Gold reserve channel." : "";
    if (market?.tradingOnly && !market.funded) {
      const link = text("a", "Fund this trading-only note in Admin");
      link.href = hostUrl("admin") + "/#/notes?market=" + encodeURIComponent(market.symbol);
      $("market-mode").append(link);
    }
    $("order-form").querySelectorAll("input, select, button").forEach(control => { control.disabled = reference || world || Boolean(preview?.submitted); });
    $("execute-order").disabled = !preview || (!preview.submitted && (reference || world));
    $("execute-order").textContent = preview?.submitted ? "Resume submitted trade" : "Confirm spot trade";
  }
  function renderGoldPools(reference) {
    const root = $("gold-pool-details"); root.replaceChildren();
    const pools = reference.goldPools, market = reference.usdMarket;
    const heading = text("h3", "Gold / Ethereum transparency"); root.append(heading);
    const snapshotFresh = pools?.checkedAt && Date.parse(pools.checkedAt) >= Date.now() - 60000 && Date.parse(pools.checkedAt) <= Date.now() + 30000;
    root.append(text("p", pools?.checkedAt ? `Gold snapshot: ${pools.checkedAt} / chain ${pools.chainId} / ${snapshotFresh ? "recent" : "stale"}. ${reference.goldError || ""}`
      : `Gold reserve snapshot unavailable. ${reference.goldError || "The Gold reader is not connected."}`));
    const show = (raw, symbol) => raw === null || raw === undefined ? "Unavailable" : ["FTHG", "ETH", "FTH$"].includes(symbol)
      ? (() => { const n = BigInt(raw), fraction = (n % unit).toString().padStart(18, "0").replace(/0+$/, "");
        return `${(n / unit).toLocaleString()}${fraction ? "." + fraction : ""} ${symbol}`; })() : format(raw, symbol);
    const bridge = pools?.bridge;
    root.append(text("p", bridge ? `Ethereum Gold bridge: ${bridge.deployed ? "deployed" : "not deployed"} / ${bridge.initialized ? "initialized" : "uninitialized"} / ${bridge.paused ? "paused" : "unpaused"}. Conversion availability requires a fresh Gold quote.
      FTHG reserve: ${show(bridge.reserveFthg, "FTHG")}; FTH$ reserve: ${show(bridge.reserveFthDollar, "FTH$")}; actual Ethereum custody: ${show(bridge.actualFthgBalance, "FTHG")}.`
      : "Ethereum Gold bridge: unavailable."));
    const native = pools?.nativeReserve;
    root.append(text("p", native ? `Native Gold reserve: ${native.enabled && native.initialized ? "initialized" : "not initialized"}.
      Origin cap: ${show(native.cap, "FTHG")}; allocated obligations: ${show(native.allocated, "FTHG")}; remaining origin: ${show(native.remaining, "FTHG")}; confirmed redeemable backing: ${show(native.redeemableBacking, "FTHG")}. Allocations are not Ethereum custody.`
      : "Native Gold reserve: unavailable."));
    const fresh = market?.updatedAt && Date.parse(market.updatedAt) >= Date.now() - 300000 && Date.parse(market.updatedAt) <= Date.now() + 30000;
    root.append(text("p", market ? `ETH / FTHG valuation pool: ${!fresh ? "stale" : market.fallback ? "indicative fallback, not a live pool price" : "pool snapshot"}.
      ${market.source || ""} ${market.marketError || market.reservesError || market.error || ""}
      ${fresh && !market.fallback && market.reserves ? `FTHG: ${show(market.reserves.fthg, "FTHG")}; ETH: ${show(market.reserves.eth, "ETH")}. Block ${market.block}.` : "Pool reserves unavailable."}`
      : "ETH / FTHG valuation pool: unavailable."));
    const link = text("a", "Inspect Gold conversion and Ethereum pools"); link.href = hostUrl("gold") + "/"; root.append(link);
    if (pools?.chainId === 1 && /^0x[0-9a-f]{40}$/i.test(bridge?.address || "")) {
      const contract = text("a", `Ethereum bridge contract: ${bridge.address}`); contract.href = "https://etherscan.io/address/" + bridge.address;
      const line = text("p", ""); line.append(contract); root.append(line);
    }
    if (/^0x[0-9a-f]{64}$/i.test(market?.pool || "")) {
      const poolLink = text("a", `ETH / FTHG pool: ${market.pool}`);
      poolLink.href = "https://app.uniswap.org/explore/pools/ethereum/" + market.pool;
      const line = text("p", ""); line.append(poolLink); root.append(line);
    }
  }
  function openFundingTarget() {
    if (location.hash === "#initial-dollar-funding") $("initial-dollar-funding").open = true;
  }
  window.addEventListener("hashchange", openFundingTarget);
  openFundingTarget();
  const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
  const decimals = symbol => symbol === "FTH$" ? 18 : 0;
  function amount(value, symbol) {
    const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value.trim()), precision = decimals(symbol);
    if (!match || (match[2]?.length || 0) > precision) throw Error(`Enter a positive ${precision ? "decimal" : "whole"} ${symbol} amount.`);
    const raw = BigInt(match[1]) * 10n ** BigInt(precision) + BigInt((match[2] || "").padEnd(precision, "0") || "0");
    if (raw <= 0n) throw Error("Amount must be positive.");
    return raw.toString();
  }
  function format(raw, symbol) {
    const value = BigInt(raw), precision = decimals(symbol);
    const scale = 10n ** BigInt(precision), whole = value / scale;
    const fraction = precision ? (value % scale).toString().padStart(precision, "0").replace(/0+$/, "") : "";
    return `${whole.toLocaleString()}${fraction ? "." + fraction : ""} ${symbol}`;
  }
  function ratio(price, digits = 2) {
    const n = BigInt(price.numerator), d = BigInt(price.denominator), scale = 10n ** BigInt(digits), rounded = (n * scale + d / 2n) / d;
    const fraction = (rounded % scale).toString().padStart(digits, "0").replace(/0+$/, "");
    if (n > 0n && rounded === 0n) return `<${digits === 2 ? "0.01" : "0." + "0".repeat(digits - 1) + "1"}`;
    return `${rounded / scale}${fraction ? "." + fraction : ""}`;
  }
  function exactFthx(raw, symbol = "FTHX") {
    const value = BigInt(raw), fraction = (value % unit).toString().padStart(18, "0").replace(/0+$/, "");
    return `${(value / unit).toLocaleString()}${fraction ? "." + fraction : ""} ${symbol}`;
  }
  async function api(path, method = "GET", body) {
    const response = await fetch("/api/creation" + path, { method, cache: "no-store",
      headers: { "Content-Type": "application/json", ...(token ? { "x-creation-token": token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let result;
    try { result = await response.json(); }
    catch (error) {
      if (error.name !== "SyntaxError") throw error;
      throw Error(`Exchange returned an invalid response (HTTP ${response.status}). Please retry.`);
    }
    if (!response.ok) throw Object.assign(Error(result.error || `HTTP ${response.status}`), { status: response.status });
    return result;
  }
  function invalidate() {
    quoteGeneration++;
    if (preview?.submitted) return;
    preview = null; $("execute-order").disabled = true; $("order-preview").replaceChildren();
  }
  async function run(work) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll("form button, .signin button, #execute-order")];
    controls.forEach(button => { button.disabled = true; });
    try { $("terminal-status").textContent = ""; await work(); }
    catch (error) { console.error(error); $("terminal-status").textContent = error.message; }
    finally { busy = false; controls.forEach(button => { button.disabled = false; }); $("execute-order").disabled = !preview; applyMarketMode(); renderPendingMovements(); }
  }
  function rows(root, entries, empty, render, columns = 5) {
    root.replaceChildren();
    if (!entries.length) { const row = text("tr", ""); const cell = text("td", empty); cell.colSpan = columns; row.append(cell); root.append(row); }
    for (const entry of entries) root.append(render(entry));
  }
  function row(values) { const tr = document.createElement("tr"); values.forEach(value => tr.append(text("td", value))); return tr; }
  function marketDataState(message, state) {
    $("data-status").textContent = message;
    $("data-status").setAttribute("data-state", state);
  }
  function renderMarketFlow(market, pool, history, tape) {
    const stats = market.referenceOnly || market.inventoryOnly ? null : marketView.statistics(history);
    $("day-change").textContent = stats?.change || "--";
    $("day-change").setAttribute("data-direction", stats?.direction || "flat");
    $("day-change").title = "First recorded open to last recorded close in the past 24 hours; empty periods are not estimated.";
    $("day-high").textContent = stats ? ratio(stats.high, 8) : "--";
    $("day-low").textContent = stats ? ratio(stats.low, 8) : "--";
    $("pair-volume").textContent = market.referenceOnly || market.inventoryOnly ? "--"
      : /^\d+$/.test(String(market.volume)) ? BigInt(market.volume).toLocaleString() : "Unavailable";
    const reserve = market.symbol === "FTH$" ? pool?.fthx : market.baseReserve;
    $("pair-reserve").textContent = market.funded && reserve != null ? BigInt(reserve).toLocaleString() : "--";
    const levels = marketView.depth(market, pool);
    for (const [id, side] of [["depth-asks", "buy"], ["depth-bids", "sell"]]) {
      const entries = levels.filter(level => level.side === side);
      if (side === "buy") entries.reverse();
      $(id).replaceChildren(...entries.map(level => {
        const line = text("div", ""), bar = text("span", "");
        line.className = `depth-level ${side}`; bar.className = "depth-bar";
        bar.style.width = `${level.width}%`; bar.setAttribute("aria-hidden", "true");
        line.append(bar, text("span", ratio(level.price, 8)), text("span", format(level.quantity, market.symbol).replace(/ [^ ]+$/, "")),
          text("span", BigInt(level.total).toLocaleString()));
        line.title = `${side === "buy" ? "Buy" : "Sell"} ${format(level.quantity, market.symbol)}: ${format(level.total, "FTHX")} total. Each row is an independent cumulative estimate.`;
        return line;
      }));
    }
    $("depth-midpoint").textContent = market.funded && market.price && !market.pendingSettlement ? `${ratio(market.price, 8)} FTHX` : "--";
    $("depth-status").textContent = levels.length ? `Quantity in ${market.ticker || market.symbol}. Estimates use current reserves, not guaranteed executions.`
      : market.pendingSettlement ? "Depth paused: settlement recovery is required."
        : market.referenceOnly || market.inventoryOnly ? "Reference market: no internal AMM depth." : "No quotable depth. A funded, enabled pool is required.";
    const executions = marketView.executions(tape.rows, market.symbol).slice(0, 20);
    rows($("recent-trades"), executions, "No Exchange executions in the past 24h.", trade => {
      const line = row([ratio(trade.price, 8), format(trade.quantity, market.symbol).replace(/ [^ ]+$/, ""),
        new Date(trade.at).toISOString().slice(11, 19)]);
      line.setAttribute("data-side", trade.side);
      line.title = `${trade.side === "buy" ? "Buy" : "Sell"} ${format(trade.quantity, market.symbol)} / ${format(trade.total, "FTHX")} / ${trade.id}`;
      return line;
    }, 3);
  }
  function renderPendingMovements() {
    $("pending-movements").replaceChildren();
    $("recovery-notice").replaceChildren(); $("recovery-notice").hidden = true;
    if (!token) return;
    for (const kind of ["deposit", "withdraw", "liquidity", "funding"]) {
      const saved = sessionStorage.getItem(`featheral-exchange-pending:${owner}:${kind}`);
      if (!saved) continue;
      const input = JSON.parse(saved), detail = kind === "funding" ? `${format(input.dollars, "FTH$")} + ${format(input.fthx, "FTHX")}`
        : kind === "liquidity" ? `${input.action} ${input.symbol}` : format(input.amount, input.symbol);
      const box = text("p", `Unresolved ${kind}: ${detail}. `);
      const resume = text("button", "Review and resume"); resume.type = "button";
      resume.addEventListener("click", () => run(() => kind === "funding" ? funding()
        : kind === "liquidity" ? liquidity() : movement(kind, input.symbol, input.amount)));
      box.append(resume); $("pending-movements").append(box);
    }
    if ($("pending-movements").children.length || sessionStorage.getItem(`featheral-exchange-pending:${owner}:trade`)
      || account?.movements.some(movement => movement.status === "settling") || account?.legacyRequests?.length) {
      const link = text("a", "Review unresolved transactions in Portfolio");
      link.href = "#trading-account";
      const trade = text("a", " / Resume submitted trade"); trade.href = "#terminal";
      $("recovery-notice").append(link, trade); $("recovery-notice").hidden = false;
    }
  }
  async function refreshAccount() {
    $("disconnect").hidden = !token;
    $("trading-owner").textContent = owner ? `Trading owner: ${owner}` : "Trading account not connected";
    renderPendingMovements();
    if (!token) {
      account = null; $("trading-total").textContent = "";
      orderBalance();
      rows($("positions"), [], "Connect to view trading balances.", undefined, 2);
      rows($("trade-history"), [], "Connect to view your executed trades.");
      rows($("movement-history"), [], "Connect to view deposits and withdrawals.", undefined, 4);
      $("legacy-requests").replaceChildren();
      return;
    }
    const currentOwner = owner, current = await api("/trading/account");
    if (owner !== currentOwner) return;
    account = current;
    orderBalance();
    const pending = sessionStorage.getItem(`featheral-exchange-pending:${owner}:trade`);
    if (pending && !preview) {
      preview = JSON.parse(pending);
      $("order-preview").textContent = `Previously submitted ${preview.side} order for ${preview.symbol}/FTHX: spend ${format(preview.amount, preview.side === "buy" ? "FTHX" : preview.symbol)}, minimum ${format(preview.minOutput, preview.side === "buy" ? preview.symbol : "FTHX")}. Resume the same request to retrieve or complete its result; do not create a replacement.`;
      $("execute-order").disabled = false;
    }
    const usd = current.portfolio.usd;
    $("trading-total").textContent = usd === null ? "USD unavailable" : `${current.portfolio.partial ? "Partial " : ""}$${usd} estimated trading assets`;
    rows($("positions"), current.holdings, "No trading assets. Deposit FTHX to start.", asset => {
      const tr = row([asset.symbol, format(asset.balance, asset.symbol)]);
      tr.children[0].append(window.FeatheralAssetIcons.create(asset));
      tr.title = format(asset.balance, asset.symbol); return tr;
    }, 2);
    const previous = $("withdraw-symbol").value;
    $("withdraw-symbol").replaceChildren(...current.holdings.map(asset => { const option = text("option", asset.symbol); option.value = asset.symbol; return option; }));
    if (current.holdings.some(asset => asset.symbol === previous)) $("withdraw-symbol").value = previous;
    const trades = [...current.trades, ...(current.walletTrades || []).map(trade => ({ ...trade, wallet: true }))].sort((a, b) => b.at - a.at);
    rows($("trade-history"), trades, "No executed trades.", trade => {
      const from = trade.from || (trade.side === "buy" ? "FTHX" : trade.symbol), to = trade.to || (trade.side === "buy" ? trade.symbol : "FTHX");
      const tr = row([new Date(trade.at).toLocaleString(), trade.symbol ? trade.symbol + "/FTHX" : `${from}/${to}`, `${trade.wallet ? "Wallet · " : ""}${trade.side || "swap"}`, format(trade.amount, from), format(trade.output, to)]);
      tr.title = `${format(trade.amount, from)} → ${format(trade.output, to)}`; return tr;
    });
    rows($("movement-history"), current.movements, "No deposits or withdrawals.", movement => {
      const tr = row([new Date(movement.at).toLocaleString(), movement.kind, format(movement.amount, movement.symbol), movement.status]);
      if (movement.status === "settling") {
        const resume = text("button", "Resume withdrawal"); resume.type = "button";
        resume.addEventListener("click", () => run(async () => { await api("/trading/withdraw", "POST", { symbol: movement.symbol, amount: movement.amount, requestId: movement.request }); await refresh(); }));
        tr.lastChild.append(resume);
      }
      return tr;
    }, 4);
    $("legacy-requests").replaceChildren();
    for (const request of current.legacyRequests || []) {
      const box = text("p", `Previous wallet settlement ${request.id}: ${request.status}. `), resume = text("button", "Review and resume");
      resume.type = "button";
      resume.addEventListener("click", () => run(async () => {
        const fresh = await api(`/dollar-pool/${encodeURIComponent(request.id)}/refresh`, "POST", {});
        if (!confirm(`Resume existing settlement ${fresh.id}? ${fresh.from} → ${fresh.to}. No replacement request will be created.`)) return;
        const signature = fresh.message ? await providerSignature(fresh.message, owner) : undefined;
        await api(`/dollar-pool/${encodeURIComponent(request.id)}/complete`, "POST", { signature }); await refresh();
      }));
      box.append(resume); $("legacy-requests").append(box);
    }
    const lp = await api("/markets/account");
    $("liquidity-positions").textContent = lp.positions.length ? lp.positions.map(position => `${position.symbol}: ${position.shares.toLocaleString()} LP shares`).join(" / ") : "No wallet liquidity positions.";
  }
  function volumeOf(market) {
    return market.inventoryOnly ? BigInt(market.volumeBaseUnits || "0") : BigInt(market.volume || "0") * unit;
  }
  function renderMarkets() {
    const filter = $("market-search").value.trim().toUpperCase();
    const active = markets.filter(market => !market.referenceOnly && volumeOf(market) > 0n);
    const activeOnly = $("market-filter").value === "active" && !filter && active.length > 0;
    const visible = markets.filter(market => (!activeOnly || volumeOf(market) > 0n || market.symbol === selected)
      && `${market.symbol} ${market.name || ""} ${market.ticker || ""}`.toUpperCase().includes(filter));
    if (activeOnly) visible.sort((a, b) => volumeOf(a) > volumeOf(b) ? -1 : volumeOf(a) < volumeOf(b) ? 1 : a.symbol.localeCompare(b.symbol));
    $("market-list-status").textContent = !visible.length ? "No matching markets."
      : activeOnly ? `${active.length} active pairs / 24h. Selected market stays visible.`
        : !active.length ? "No active pairs reported / 24h. Showing all markets." : `${visible.length} markets. Volume is actual 24h FTHX.`;
    $("market-list").replaceChildren();
    for (const market of visible) {
      const button = text("button", market.ticker || market.symbol); button.type = "button"; button.setAttribute("aria-pressed", String(market.symbol === selected));
      button.append(text("small", market.inventoryOnly ? "World fills" : market.referenceOnly ? "Reference only" : market.pendingSettlement ? "Recovery required"
        : market.tradingOnly ? market.funded ? "Trading only · Live" : "Trading only · Unfunded" : market.funded ? "Live pool" : "Unfunded"));
      button.append(window.FeatheralAssetIcons.create(market));
      if (!market.referenceOnly) {
        const rawVolume = market.inventoryOnly ? market.volumeBaseUnits : market.volume;
        const volume = text("span", rawVolume == null ? "24h volume unavailable"
          : market.inventoryOnly ? exactFthx(rawVolume) : format(rawVolume, "FTHX"));
        volume.className = "market-volume"; volume.title = "Executed volume in the last 24 hours"; button.append(volume);
      }
      button.addEventListener("click", () => {
        selected = market.symbol;
        $("market-selector").open = false;
        if (market.inventoryOnly && !market.trades) $("chart-interval").value = "all";
        invalidate(); refresh().catch(error => { console.error(error); $("terminal-status").textContent = error.message; });
      });
      $("market-list").append(button);
    }
  }
  async function refresh() {
    const generation = ++quoteGeneration;
    marketDataState("Refreshing market data", "loading");
    $("depth-asks").replaceChildren(); $("depth-bids").replaceChildren();
    $("depth-midpoint").textContent = "--"; $("depth-status").textContent = "Reading pool reserves.";
    for (const id of ["day-change", "day-high", "day-low", "pair-volume", "pair-reserve"]) $(id).textContent = "--";
    rows($("recent-trades"), [], "Reading executions.", undefined, 3);
    try {
    $("world-executions").hidden = true; $("world-trade-records").replaceChildren();
    let marketSymbol = selected;
    const data = await api("/trading/markets?interval=" + $("chart-interval").value);
    if (generation !== quoteGeneration) return;
    const listed = data.markets.map(item => item.symbol === "FTH$" ? { ...item, volume: data.pair.volumeFthx } : item);
    if (autoSelect) {
      autoSelect = false;
      const active = listed.filter(market => volumeOf(market) > 0n)
        .sort((a, b) => volumeOf(a) > volumeOf(b) ? -1 : volumeOf(a) < volumeOf(b) ? 1 : a.symbol.localeCompare(b.symbol));
      const preferred = active.find(market => market.funded && !market.pendingSettlement) || active[0];
      const world = data.markets.find(market => market.inventoryOnly);
      if (preferred) selected = marketSymbol = preferred.symbol;
      else if (world && !data.markets.some(market => market.funded)) {
        selected = marketSymbol = world.symbol;
        if (!world.trades) $("chart-interval").value = "all";
      }
    }
    const recovering = data.pair.notes.some(item => item.pendingSettlement);
    const gold = data.reference.goldReference, dollar = data.reference.dollarReference;
    const goldPrice = gold && dollar ? { numerator: (BigInt(gold.numerator) * BigInt(dollar.numerator)).toString(),
      denominator: (BigInt(gold.denominator) * BigInt(dollar.denominator) * unit).toString() } : null;
    markets = [...listed.map(item => recovering && !item.inventoryOnly ? { ...item, pendingSettlement: true } : item),
      { symbol: "FTHG", funded: false, referenceOnly: true, price: goldPrice }];
    const priority = market => market.inventoryOnly || market.tradingOnly ? 3 : ["FTH$", "FTHG", "FTHS"].includes(market.symbol) ? ["FTH$", "FTHG", "FTHS"].indexOf(market.symbol) : 4;
    markets.sort((a, b) => priority(a) - priority(b)); renderMarkets(); renderGoldPools(data.reference); applyMarketMode();
    $("overview-markets").textContent = String(data.markets.length);
    $("overview-funded").textContent = String(data.markets.filter(item => item.funded && !recovering && !item.pendingSettlement).length);
    const volumes = data.markets.filter(item => !item.inventoryOnly).map(item => item.symbol === "FTH$" ? data.pair.volumeFthx : item.volume);
    $("overview-volume").textContent = volumes.every(value => /^\d+$/.test(String(value)))
      ? `${volumes.reduce((sum, value) => sum + BigInt(value), 0n).toLocaleString()} FTHX` : "Unavailable";
    const market = markets.find(m => m.symbol === marketSymbol);
    if (!market) throw Error("Requested market is unavailable. Select an available market.");
    if (firstHistory && market.inventoryOnly && !market.trades) $("chart-interval").value = "all";
    firstHistory = false;
    if (displayedMarket !== marketSymbol) {
      chart.update({ currency: "FTHX", candles: [] }); displayedMarket = marketSymbol;
    }
    $("market-title").textContent = (market.ticker || marketSymbol) + " / FTHX" + (market.inventoryOnly ? " · World" : market.tradingOnly ? " · Trading only" : "");
    $("market-title").append(window.FeatheralAssetIcons.create(market));
    $("spot-price").textContent = market.referenceOnly ? goldPrice ? `Indicative ${ratio(goldPrice)} FTHX` : "Reference unavailable"
      : market?.pendingSettlement ? "Settlement recovery required" : market?.price ? `${ratio(market.price, market.inventoryOnly ? 18 : 2)} FTHX${market.inventoryOnly ? " · last fill" : ""}` : "Pool not available";
    const usdPerDollar = data.reference.usdValue, rate = data.reference.dollarReference;
    if (market?.price && usdPerDollar !== null && rate) {
      const usdPerFthx = BigInt(usdPerDollar) * BigInt(rate.denominator) / BigInt(rate.numerator);
      const usd = usdPerFthx * BigInt(market.price.numerator) / BigInt(market.price.denominator);
      const fractional = (usd % unit).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
      $("usd-price").textContent = `~ $${usd > 0n && usd < 10000000000n ? "<0.00000001" : `${usd / unit}${fractional ? "." + fractional : ""}`} USD / ${marketSymbol}`;
    } else $("usd-price").textContent = "USD unavailable — live FTHG/USD and verified reference rates required";
    $("market-detail").textContent = market.inventoryOnly ? `${market.recordedTrades} recorded inventory trades · ${exactFthx(market.volumeBaseUnits)} World executed notional / 24h · ${exactFthx(market.recordedVolumeBaseUnits)} all recorded notional. ${market.description}`
      : market.referenceOnly ? `FTHG → FTH$ → FTHX reference (${gold?.source || "Gold unavailable"} / ${dollar?.source || "Dollar unavailable"}). No direct executions, candles or FTHX volume are implied.`
      : market?.pendingSettlement ? "A Dollar settlement requires recovery. Resume the original request before trading; do not fund a replacement pool."
      : market?.funded ? `0.3% fee • ${marketSymbol === "FTH$" ? data.pair.volumeFthx : market.volume} FTHX executed volume / 24h`
      : "Unfunded. Opening reference prices do not enable trading or guarantee redemption.";
    $("reference-detail").textContent = data.reference.source;
    $("order-amount-label").firstChild.textContent = `Input (${ $("order-side").value === "buy" ? "FTHX" : marketSymbol })`;
    const history = market.referenceOnly ? { currency: "FTHX", candles: [], referenceOnly: true }
      : market.inventoryOnly ? await api(`/world-markets/${encodeURIComponent(market.asset)}/history?interval=${$("chart-interval").value}`)
        : marketSymbol === "FTH$" ? data.pair.notes[0].history : await api(`/markets/${encodeURIComponent(marketSymbol)}/history?interval=${$("chart-interval").value}`);
    const [daily, tape] = await Promise.all([
      market.referenceOnly || market.inventoryOnly || $("chart-interval").value === "24h" ? history
        : marketSymbol === "FTH$" ? api("/trading/markets?interval=24h").then(result => result.pair.notes[0].history)
          : api(`/markets/${encodeURIComponent(marketSymbol)}/history?interval=24h`),
      market.referenceOnly || market.inventoryOnly ? { rows: [] }
        : api(`/market-tape?symbol=${encodeURIComponent(marketSymbol)}&interval=24h&venue=exchange`),
    ]);
    if (generation !== quoteGeneration) return;
    chart.update(history);
    renderMarketFlow(market, data.pool, daily, tape);
    if (market.inventoryOnly || market.tradingOnly && data.worldCoverage?.available) {
      const executions = await api(`/world-trades?asset=${encodeURIComponent(market.asset)}&interval=${$("chart-interval").value}`);
      if (generation !== quoteGeneration) return;
      rows($("world-trade-records"), executions.rows, "No inventory trades in this interval.", trade => row([
        `${new Date(trade.at).toLocaleString()} · ${trade.clock}`, trade.quantity, ratio(trade.price, 18),
        exactFthx(trade.quoteAmount), exactFthx(trade.dollars, "FTH$"), trade.venue,
        `${trade.id} · ${trade.settlement}${trade.settlementHash ? " · " + trade.settlementHash : ""}`,
      ]), 7);
      $("world-executions").hidden = false;
    }
    const lastLiquidity = $("liquidity-symbol").value;
    $("liquidity-symbol").replaceChildren(...markets.filter(m => m.symbol !== "FTH$" && m.funded).map(m => { const option = text("option", m.symbol); option.value = m.symbol; return option; }));
    if (markets.some(m => m.symbol === lastLiquidity)) $("liquidity-symbol").value = lastLiquidity;
    else if (!lastLiquidity && markets.some(m => m.symbol === selected && m.funded && m.symbol !== "FTH$")) $("liquidity-symbol").value = selected;
    await refreshAccount();
    if (generation === quoteGeneration) marketDataState(`Updated ${new Date().toISOString().slice(11, 19)} UTC`, "ready");
    } catch (error) {
      if (generation === quoteGeneration) {
        marketDataState("Market data unavailable / stale", "error");
        $("depth-asks").replaceChildren(); $("depth-bids").replaceChildren(); $("depth-midpoint").textContent = "--";
        $("depth-status").textContent = "Depth unavailable. Refresh before relying on market data.";
        rows($("recent-trades"), [], "Trade data unavailable. Refresh to retry.", undefined, 3);
      }
      throw error;
    }
  }
  function requireOwner() { if (!token || !owner) throw Error("Connect the owner wallet before managing trading funds."); }
  async function movement(kind, symbol, raw) {
    requireOwner();
    const key = `featheral-exchange-pending:${owner}:${kind}`, previous = sessionStorage.getItem(key);
    const saved = previous ? JSON.parse(previous) : null;
    const input = saved || { symbol, amount: raw, requestId: crypto.randomUUID() };
    if (!confirm(`${saved ? "Resume the previous request first. " : ""}${kind === "deposit" ? "Deposit into Exchange trading" : "Withdraw to your own wallet"}: ${format(input.amount, input.symbol)}? This moves existing funds only.`)) return;
    sessionStorage.setItem(key, JSON.stringify(input));
    try { await api("/trading/" + kind, "POST", input); }
    catch (error) {
      if (error.status) {
        try { await api(`/trading/operations/${encodeURIComponent(input.requestId)}`); }
        catch (lookupError) {
          if (lookupError.status === 404) sessionStorage.removeItem(key);
          else {
            console.error("Exchange operation recovery lookup failed:", lookupError);
            error.message += " Recovery status could not be verified; the original request is retained.";
          }
        }
      }
      throw error;
    }
    sessionStorage.removeItem(key);
    invalidate(); await refresh(); $("terminal-status").textContent = `${kind === "deposit" ? "Deposit" : "Withdrawal"} complete.`;
  }
  $("deposit-form").addEventListener("submit", event => { event.preventDefault(); run(() => movement("deposit", "FTHX", amount($("deposit-amount").value, "FTHX"))); });
  $("withdraw-form").addEventListener("submit", event => { event.preventDefault(); run(() => movement("withdraw", $("withdraw-symbol").value, amount($("withdraw-amount").value, $("withdraw-symbol").value))); });
  $("order-form").addEventListener("input", invalidate);
  $("order-side").addEventListener("change", orderBalance);
  for (const side of ["buy", "sell"]) $(`side-${side}`).addEventListener("click", () => {
    $("order-side").value = side; invalidate(); orderBalance();
  });
  for (const percent of [25, 50, 75, 100]) $(`size-${percent}`).addEventListener("click", () => run(async () => {
    requireOwner();
    if (preview?.submitted) throw Error("Resume the submitted trade before changing the order.");
    const { balance, symbol } = orderBalance();
    const value = marketView.size(balance, percent, symbol);
    invalidate(); $("order-amount").value = value;
  }));
  for (const view of ["balances", "trades", "movements"]) $(`show-${view}`).addEventListener("click", () => {
    for (const name of ["balances", "trades", "movements"]) {
      $(`${name}-record`).hidden = name !== view;
      $(`show-${name}`).setAttribute("aria-pressed", String(name === view));
    }
  });
  $("order-form").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      requireOwner(); invalidate();
      if (preview?.submitted) throw Error("Resolve the submitted trade before requesting another order.");
      if (markets.find(market => market.symbol === selected)?.inventoryOnly)
        throw Error("World inventory trades must be placed in World. These items are not wallet notes.");
      if (selected === "FTHG") throw Error("FTHG is reference-only. Use the Gold conversion channel; no internal FTHG order can be placed.");
      const generation = quoteGeneration, side = $("order-side").value, symbol = selected;
      const raw = amount($("order-amount").value, side === "buy" ? "FTHX" : symbol), tolerance = $("order-slippage").value;
      if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(tolerance)) throw Error("Slippage must be between 0 and 10 percent.");
      const [whole, fraction = ""] = tolerance.split("."), bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
      if (bps > 1000n) throw Error("Slippage must not exceed 10 percent.");
      const quote = await api("/trading/quote", "POST", { symbol, side, amount: raw });
      if (generation !== quoteGeneration) return;
      const minOutput = BigInt(quote.output) * (10000n - bps) / 10000n;
      if (minOutput < 1n) throw Error("Minimum output rounds to zero. Increase the amount or reduce slippage.");
      preview = { owner, symbol, side, amount: raw, minOutput: minOutput.toString(), requestId: crypto.randomUUID(), expires: Date.now() + 30000 };
      $("order-preview").textContent = `Spend ${format(raw, quote.from)} → estimated ${format(quote.output, quote.to)}. Minimum ${format(minOutput, quote.to)}. Fee 0.3%.${markets.find(market => market.symbol === symbol)?.tradingOnly ? " Trading-only note; no game inventory or redemption." : ""}`;
    });
  });
  $("execute-order").addEventListener("click", () => run(async () => {
    requireOwner();
    if (!preview || !preview.submitted && preview.expires < Date.now()) { invalidate(); throw Error("Quote expired. Request a new preview."); }
    const order = preview;
    if (order.owner !== owner) throw Error("Trading owner changed. Reconnect and review this owner's order.");
    if (!confirm(`${order.submitted ? "Resume submitted" : "Execute"} ${order.side} trade for ${order.symbol}/FTHX? Spend ${format(order.amount, order.side === "buy" ? "FTHX" : order.symbol)}; minimum output ${format(order.minOutput, order.side === "buy" ? order.symbol : "FTHX")}.${order.symbol.startsWith("WORLD:") ? " Trading-only note: cannot be used or redeemed in the game." : ""}`)) return;
    order.submitted = true;
    sessionStorage.setItem(`featheral-exchange-pending:${owner}:trade`, JSON.stringify(order));
    try { await api("/trading/trade", "POST", order); }
    catch (error) {
      if ([400, 402, 409].includes(error.status)) {
        sessionStorage.removeItem(`featheral-exchange-pending:${owner}:trade`); preview = null; invalidate();
      }
      throw error;
    }
    sessionStorage.removeItem(`featheral-exchange-pending:${owner}:trade`); preview = null; invalidate(); await refresh(); $("terminal-status").textContent = "Trade executed.";
  }));
  $("liquidity-form").addEventListener("submit", event => {
    event.preventDefault();
    run(liquidity);
  });
  async function completeLiquidity(key, input) {
    try { await api("/markets/liquidity", "POST", input); }
    catch (error) {
      if ([400, 402, 409].includes(error.status)) sessionStorage.removeItem(key);
      throw error;
    }
    sessionStorage.removeItem(key); await refresh();
  }
  async function liquidity() {
    requireOwner();
    const key = `featheral-exchange-pending:${owner}:liquidity`, pending = sessionStorage.getItem(key);
    if (pending) {
      const previous = JSON.parse(pending);
      if (!confirm(`Resolve the previous submitted liquidity request first: ${JSON.stringify(previous)}?`)) return;
      await completeLiquidity(key, previous); return;
    }
    const symbol = $("liquidity-symbol").value, action = $("liquidity-action").value, value = Number($("liquidity-amount").value);
    const quote = await api("/markets/liquidity/quote", "POST", { symbol, action, amount: value });
    if (!confirm(`Wallet liquidity ${action}: ${JSON.stringify(quote)}. Accept price and impermanent-loss risk?`)) return;
    const input = { symbol, action, amount: value, requestId: crypto.randomUUID(), base: quote.base, notes: quote.notes, shares: quote.shares };
    sessionStorage.setItem(key, JSON.stringify(input));
    await completeLiquidity(key, input);
  }
  $("funding-form").addEventListener("submit", event => {
    event.preventDefault();
    run(funding);
  });
  async function funding() {
    requireOwner();
    const key = `featheral-exchange-pending:${owner}:funding`, previous = sessionStorage.getItem(key);
    const saved = previous ? JSON.parse(previous) : null;
    const dollars = saved?.dollars || amount($("funding-dollar").value, "FTH$");
    const fthx = saved?.fthx || amount($("funding-fthx").value, "FTHX"), approval = saved?.approval || $("funding-approval").value;
    if (approval !== `FUND FTH$ ${dollars} BASE_UNITS ${fthx} FTHX`) throw Error(`Exact approval required: FUND FTH$ ${dollars} BASE_UNITS ${fthx} FTHX`);
    if (!confirm(`${saved ? "Resume the previous funding request first. " : ""}Commit ${format(dollars, "FTH$")} and ${format(fthx, "FTHX")} from your MAIN wallet to initial liquidity? No new supply is created. This capital has no LP withdrawal interface.`)) return;
    const input = saved || { dollars, fthx, approval, requestId: crypto.randomUUID() };
    sessionStorage.setItem(key, JSON.stringify(input));
    const request = await api("/dollar-pool/fund", "POST", input);
    if (request.status !== "complete") {
      const signature = request.message ? await providerSignature(request.message, owner) : undefined;
      await api(`/dollar-pool/${encodeURIComponent(request.id)}/complete`, "POST", { signature });
    }
    sessionStorage.removeItem(key); await refresh(); $("terminal-status").textContent = "Initial liquidity funded with existing balances.";
  }
  async function finishLogin(address, signature) {
    const session = await api("/login", "POST", { address, signature });
    token = session.token; owner = session.address.toLowerCase(); preview = null; invalidate(); await refresh();
  }
  async function providerSignature(message, address) {
    if (!window.ethereum) throw Error("This legacy wallet payment requires the owning external provider. New trading-account operations do not require a separate transfer signature.");
    if ((await window.ethereum.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== address.toLowerCase()) throw Error("Select the trading owner in your external wallet first.");
    const hex = "0x" + [...new TextEncoder().encode(message)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const signature = await window.ethereum.request({ method: "personal_sign", params: [hex, address] });
    if ((await window.ethereum.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== address.toLowerCase()) throw Error("External wallet changed while signing. Reconnect.");
    return signature;
  }
  $("provider-connect").addEventListener("click", () => run(async () => {
    if (!window.FeatheralWallet) throw Error("Central wallet is loading or unavailable. Reload and retry.");
    const authorization = await window.FeatheralWallet.authenticate(address => api("/challenge", "POST", { address }));
    await finishLogin(authorization.address, authorization.signature);
  }));
  async function disconnect(revoke) {
    const logout = revoke && token ? api("/logout", "POST", {}).catch(error => {
      throw Error(`Disconnected locally, but server session revocation failed and the session may remain active: ${error.message}`);
    }) : Promise.resolve();
    token = ""; owner = ""; preview = null; invalidate();
    $("liquidity-positions").textContent = "";
    $("legacy-requests").replaceChildren();
    $("withdraw-symbol").replaceChildren();
    await Promise.all([logout, refreshAccount()]);
  }
  $("disconnect").addEventListener("click", () => run(() => disconnect(true)));
  window.ethereum?.on?.("accountsChanged", () => { disconnect(true).catch(error => { console.error(error); $("terminal-status").textContent = error.message; }); });
  $("market-search").addEventListener("input", renderMarkets);
  $("market-filter").addEventListener("change", renderMarkets);
  $("market-selector").addEventListener("keydown", event => {
    if (event.key === "Escape") { $("market-selector").open = false; $("market-toggle").focus(); }
  });
  $("chart-interval").addEventListener("change", () => { invalidate(); run(refresh); });
  $("refresh-market").addEventListener("click", () => { invalidate(); run(refresh); });
  $("chart-fullscreen").addEventListener("click", () => run(async () => {
    if (!$("candle-chart").requestFullscreen) throw Error("Fullscreen is unavailable in this browser.");
    await $("candle-chart").requestFullscreen();
  }));
  setInterval(() => {
    if (preview && !preview.submitted && preview.expires < Date.now()) { invalidate(); $("order-preview").textContent = "Quote expired. Preview again."; }
    if (!busy && !refreshing && !document.hidden && !preview) {
      refreshing = true;
      refresh().catch(error => { console.error(error); $("terminal-status").textContent = error.message; }).finally(() => { refreshing = false; });
    }
  }, 30000);
  run(refresh);
})();
