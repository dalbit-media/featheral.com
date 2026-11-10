"use strict";
(() => {
  const $ = id => document.getElementById(id), unit = 10n ** 18n;
  const hostUrl = name => `${location.protocol}//${location.hostname.endsWith(".localhost") ? name + ".localhost" : name + ".featheral.com"}${location.port ? ":" + location.port : ""}`;
  $("notes-link").href = hostUrl("notes") + "/";
  $("gold-channel").href = "/gold-channel/";
  let token = "", owner = "", markets = [], selected = new URLSearchParams(location.search).get("market") || "FTH$", account, preview, quoteGeneration = 0, refreshing = false, busy = false;
  const chart = window.FeatheralCandleChart.mount($("candle-chart"));
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
    const places = symbol === "FTH$" ? 2 : 0, factor = 10n ** BigInt(precision - places);
    const rounded = (value + factor / 2n) / factor, whole = rounded / 10n ** BigInt(places);
    const fraction = (rounded % 10n ** BigInt(places)).toString().padStart(places, "0").replace(/0+$/, "");
    return `${value > 0n && rounded === 0n ? "<0.01" : whole.toLocaleString() + (fraction ? "." + fraction : "")} ${symbol}`;
  }
  function ratio(price) {
    const n = BigInt(price.numerator), d = BigInt(price.denominator), rounded = (n * 100n + d / 2n) / d;
    const fraction = (rounded % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    if (n > 0n && rounded === 0n) return "<0.01";
    return `${rounded / 100n}${fraction ? "." + fraction : ""}`;
  }
  async function api(path, method = "GET", body) {
    const response = await fetch("/api/creation" + path, { method, cache: "no-store",
      headers: { "Content-Type": "application/json", ...(token ? { "x-creation-token": token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
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
    finally { busy = false; controls.forEach(button => { button.disabled = false; }); $("execute-order").disabled = !preview; renderPendingMovements(); }
  }
  function rows(root, entries, empty, render, columns = 5) {
    root.replaceChildren();
    if (!entries.length) { const row = text("tr", ""); const cell = text("td", empty); cell.colSpan = columns; row.append(cell); root.append(row); }
    for (const entry of entries) root.append(render(entry));
  }
  function row(values) { const tr = document.createElement("tr"); values.forEach(value => tr.append(text("td", value))); return tr; }
  function renderPendingMovements() {
    $("pending-movements").replaceChildren();
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
  }
  async function refreshAccount() {
    $("disconnect").hidden = !token;
    $("trading-owner").textContent = owner ? `Trading owner: ${owner}` : "Trading account not connected";
    renderPendingMovements();
    if (!token) {
      account = null; $("trading-total").textContent = "";
      rows($("positions"), [], "Connect to view trading balances.", undefined, 2);
      rows($("trade-history"), [], "Connect to view your executed trades.");
      rows($("movement-history"), [], "Connect to view deposits and withdrawals.", undefined, 4);
      $("legacy-requests").replaceChildren();
      return;
    }
    const currentOwner = owner, current = await api("/trading/account");
    if (owner !== currentOwner) return;
    account = current;
    const pending = sessionStorage.getItem(`featheral-exchange-pending:${owner}:trade`);
    if (pending && !preview) {
      preview = JSON.parse(pending);
      $("order-preview").textContent = `Previously submitted order: ${format(preview.amount, preview.side === "buy" ? "FTHX" : preview.symbol)}. Resume the same request to retrieve or complete its result; do not create a replacement.`;
      $("execute-order").disabled = false;
    }
    const usd = current.portfolio.usd;
    $("trading-total").textContent = usd === null ? "USD unavailable" : `${current.portfolio.partial ? "Partial " : ""}$${usd} estimated trading assets`;
    rows($("positions"), current.holdings, "No trading assets. Deposit FTHX to start.", asset => {
      const tr = row([asset.symbol, format(asset.balance, asset.symbol)]); tr.title = format(asset.balance, asset.symbol); return tr;
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
  function renderMarkets() {
    const filter = $("market-search").value.toUpperCase();
    $("market-list").replaceChildren();
    for (const market of markets.filter(m => m.symbol.includes(filter))) {
      const button = text("button", market.symbol); button.type = "button"; button.setAttribute("aria-pressed", String(market.symbol === selected));
      button.append(text("small", market.pendingSettlement ? "Recovery required" : market.funded ? "Live pool" : "Unfunded"));
      button.addEventListener("click", () => { selected = market.symbol; invalidate(); refresh().catch(error => { console.error(error); $("terminal-status").textContent = error.message; }); });
      $("market-list").append(button);
    }
  }
  async function refresh() {
    const generation = ++quoteGeneration;
    const marketSymbol = selected;
    const data = await api("/trading/markets?interval=" + $("chart-interval").value);
    if (generation !== quoteGeneration) return;
    const recovering = data.pair.notes.some(item => item.pendingSettlement);
    markets = data.markets.map(item => recovering ? { ...item, pendingSettlement: true } : item); renderMarkets();
    $("overview-markets").textContent = String(markets.length);
    $("overview-funded").textContent = String(markets.filter(item => item.funded && !item.pendingSettlement).length);
    const volumes = markets.map(item => item.symbol === "FTH$" ? data.pair.volumeFthx : item.volume);
    $("overview-volume").textContent = volumes.every(value => /^\d+$/.test(String(value)))
      ? `${volumes.reduce((sum, value) => sum + BigInt(value), 0n).toLocaleString()} FTHX` : "Unavailable";
    const market = markets.find(m => m.symbol === marketSymbol);
    if (!market) throw Error("Requested market is unavailable. Select an available market.");
    $("market-title").textContent = marketSymbol + " / FTHX";
    $("spot-price").textContent = market?.pendingSettlement ? "Settlement recovery required" : market?.price ? `${ratio(market.price)} FTHX` : "Pool not available";
    const usdPerDollar = data.reference.usdValue, rate = data.reference.dollarReference;
    if (market?.price && usdPerDollar !== null && rate) {
      const usdPerFthx = BigInt(usdPerDollar) * BigInt(rate.denominator) / BigInt(rate.numerator);
      const usd = usdPerFthx * BigInt(market.price.numerator) / BigInt(market.price.denominator);
      const fractional = (usd % unit).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
      $("usd-price").textContent = `~ $${usd > 0n && usd < 10000000000n ? "<0.00000001" : `${usd / unit}${fractional ? "." + fractional : ""}`} USD / ${marketSymbol}`;
    } else $("usd-price").textContent = "USD unavailable — live FTHG/USD and verified reference rates required";
    $("market-detail").textContent = market?.pendingSettlement ? "A Dollar settlement requires recovery. Resume the original request before trading; do not fund a replacement pool."
      : market?.funded ? `0.3% fee • ${marketSymbol === "FTH$" ? data.pair.volumeFthx : market.volume} FTHX executed volume / 24h`
      : "Unfunded. Opening reference prices do not enable trading or guarantee redemption.";
    $("reference-detail").textContent = data.reference.source;
    $("order-amount-label").firstChild.textContent = `Input (${ $("order-side").value === "buy" ? "FTHX" : marketSymbol })`;
    const history = marketSymbol === "FTH$" ? data.pair.notes[0].history : await api(`/markets/${encodeURIComponent(marketSymbol)}/history?interval=${$("chart-interval").value}`);
    if (generation !== quoteGeneration) return;
    chart.update(history);
    const lastLiquidity = $("liquidity-symbol").value;
    $("liquidity-symbol").replaceChildren(...markets.filter(m => m.symbol !== "FTH$" && m.funded).map(m => { const option = text("option", m.symbol); option.value = m.symbol; return option; }));
    if (markets.some(m => m.symbol === lastLiquidity)) $("liquidity-symbol").value = lastLiquidity;
    await refreshAccount();
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
  $("order-side").addEventListener("change", () => { $("order-amount-label").firstChild.textContent = `Input (${$("order-side").value === "buy" ? "FTHX" : selected})`; });
  $("order-form").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      requireOwner(); invalidate();
      if (preview?.submitted) throw Error("Resolve the submitted trade before requesting another order.");
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
      $("order-preview").textContent = `Spend ${format(raw, quote.from)} → estimated ${format(quote.output, quote.to)}. Minimum ${format(minOutput, quote.to)}. Fee 0.3%.`;
    });
  });
  $("execute-order").addEventListener("click", () => run(async () => {
    requireOwner();
    if (!preview || !preview.submitted && preview.expires < Date.now()) { invalidate(); throw Error("Quote expired. Request a new preview."); }
    const order = preview;
    if (order.owner !== owner) throw Error("Trading owner changed. Reconnect and review this owner's order.");
    if (!confirm(`Execute spot trade? Minimum output: ${format(order.minOutput, order.side === "buy" ? order.symbol : "FTHX")}`)) return;
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
    if (revoke && token) await api("/logout", "POST", {});
    token = ""; owner = ""; preview = null; invalidate();
    $("liquidity-positions").textContent = "";
    $("legacy-requests").replaceChildren();
    $("withdraw-symbol").replaceChildren();
    await refreshAccount();
  }
  $("disconnect").addEventListener("click", () => run(() => disconnect(true)));
  window.ethereum?.on?.("accountsChanged", () => { disconnect(true).catch(error => { console.error(error); $("terminal-status").textContent = error.message; }); });
  $("market-search").addEventListener("input", renderMarkets);
  $("chart-interval").addEventListener("change", () => { invalidate(); run(refresh); });
  $("refresh-market").addEventListener("click", () => { invalidate(); run(refresh); });
  $("chart-reset").addEventListener("click", () => chart.reset());
  $("chart-sma").addEventListener("change", () => chart.sma($("chart-sma").checked));
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
