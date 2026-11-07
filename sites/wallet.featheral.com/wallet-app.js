"use strict";
async function mountFeatheralWallet(context) {
  const nativeDocument = globalThis.document, cleanup = [];
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    cleanup.push(() => target.removeEventListener(name, callback, options));
  };
  const document = context ? {
    body: context.body, documentElement: context.body,
    getElementById: id => context.root.getElementById(id),
    querySelectorAll: selector => context.root.querySelectorAll(selector),
    createElement: tag => nativeDocument.createElement(tag),
    get hidden() { return nativeDocument.hidden || !context.visible(); },
    addEventListener: (name, callback, options) => listen(nativeDocument, name, callback, options),
  } : nativeDocument;
  const setInterval = (callback, delay) => {
    const timer = globalThis.setInterval(callback, delay);
    cleanup.push(() => globalThis.clearInterval(timer));
    return timer;
  };
  if (context) context.dispose = () => { for (const release of cleanup.splice(0)) release(); };
  let contextEpoch = 0, operationRejected = false;
  function requireVisible() {
    if (operationRejected) throw new Error("Wallet operation rejected.");
    if (context && !context.visible()) throw new Error("Wallet popup closed. Open it again before approving.");
  }
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
  if (window.parent !== window) throw new Error("Open the wallet directly in a tab or window. Wallet frames are not supported.");
  const configResponse = await fetch("/api/wallet/ui" + (context ? context.search : location.search), {
    cache: "no-store", ...(context ? { signal: AbortSignal.timeout(20000) } : {}),
  });
  const config = await configResponse.json();
  if (!configResponse.ok) throw new Error(config.error || "Wallet configuration unavailable.");
  if (config.schema !== "featheral.wallet" || config.version !== 1) throw new Error("Unsupported wallet UI schema.");
  if (config.embedded) throw new Error("Wallet frames are no longer supported. Open the full wallet.");
  if (config.authNonce && !context && !window.opener) throw new Error("The requesting site is unavailable. Return to that site and reconnect.");
  document.body.dataset.embedded = String(config.embedded); document.body.dataset.compact = String(config.compact);
  document.body.dataset.primary = config.primary;
  let browserProvider, providerChosen = false, connectionReady = false, builtInPreferred = config.mode === "builtin";
  const announcedProviders = new Map(), boundProviders = new WeakSet();
  function providerChoices() {
    if (announcedProviders.size) return [...announcedProviders].map(([provider, name]) => ({ provider, name }));
    return [...new Set(window.ethereum?.providers || [window.ethereum])].filter(provider => typeof provider?.request === "function")
      .map(provider => ({ provider, name: provider.isMetaMask ? "MetaMask" : provider.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet" }));
  }
  function updateProviders() {
    const choices = providerChoices(), picker = $("extension-provider");
    if (!providerChosen || !choices.some(choice => choice.provider === browserProvider))
      browserProvider = choices.length === 1 ? choices[0].provider : null;
    picker.replaceChildren(el("option", "Choose extension"));
    picker.firstChild.value = "";
    choices.forEach((choice, index) => { const option = el("option", choice.name); option.value = String(index); picker.append(option); });
    picker.value = browserProvider ? String(choices.findIndex(choice => choice.provider === browserProvider)) : "";
    picker.hidden = choices.length < 2;
    $("extension-connect").disabled = !interactive || choices.length === 0;
    $("builtin-connect").disabled = !interactive;
    $("extension-connect").textContent = choices.length === 1 ? `Connect ${choices[0].name}` : "Connect extension";
    $("connection-help").textContent = choices.length ? "Extension detected. Approve in your wallet app. You can still choose the built-in wallet."
      : "No extension detected. Create or unlock your built-in wallet below. No extension installation needed.";
    if (browserProvider && connectionReady) bindProvider(browserProvider);
    if (connectionReady) connectionLabel();
  }
  listen(window, "eip6963:announceProvider", event => {
    if (typeof event.detail?.provider?.request !== "function") return;
    announcedProviders.set(event.detail.provider, String(event.detail.info?.name || "Browser wallet").slice(0, 80));
    updateProviders();
  });
  listen(window, "ethereum#initialized", updateProviders);
  const defaultStandaloneTheme = !config.embedded && !config.parentOrigin && !new URLSearchParams(location.search).has("theme");
  document.body.style.setProperty("--brand", defaultStandaloneTheme ? "#e2b13c" : config.theme.accent);
  const themeProperties = { accent: "--brand", background: "--wallet-bg", panel: "--panel", text: "--txt",
    muted: "--muted", line: "--line", button: "--btn", onAccent: "--on-accent" };
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) return;
    // Theme both roots so the page canvas outside <body> matches light host sites instead of staying dark.
    const roots = [document.documentElement, document.body].filter(root => root?.style);
    for (const [key, property] of Object.entries(themeProperties)) {
      const value = theme[key];
      if (typeof value === "string" && value.length <= 80 && /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%+/-]+\))$/i.test(value))
        for (const root of roots) root.style.setProperty(property, value);
    }
    if (["light", "dark"].includes(theme.scheme)) for (const root of roots) root.style.colorScheme = theme.scheme;
  }
  const primarySymbol = config.primary, fthxFirst = primarySymbol === "FTHX";
  const emptyBalance = `${["FTHG", "FTHS"].includes(primarySymbol) ? "0.000" : "0.00"} ${primarySymbol}`;
  function renderBalance(text) {
    if (text === `0 ${primarySymbol}`) text = emptyBalance;
    $("balance").replaceChildren(el("span", text.endsWith(` ${primarySymbol}`) ? text.slice(0, -primarySymbol.length - 1) : text), el("span", ` ${primarySymbol}`, "balance-currency"));
  }
  const goldAmount = raw => {
    const amount = BigInt(raw), fraction = (amount % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return amount > 0n && amount < 10n ** 12n ? "<0.000001 FTHG"
      : `${(amount / 10n ** 18n).toLocaleString()}${fraction ? "." + fraction : ""} FTHG`;
  };
  const estimateNumber = (raw, minimumDecimals = 0) => {
    const value = BigInt(raw);
    if (value > 0n && value < 10n ** 14n) return "<0.0001";
    const rounded = (value + 5n * 10n ** 13n) / 10n ** 14n;
    const fraction = (rounded % 10000n).toString().padStart(4, "0").replace(/0+$/, "").padEnd(minimumDecimals, "0");
    return `${(rounded / 10000n).toLocaleString()}${fraction ? "." + fraction : ""}`;
  };
  const equivalent = (raw, symbol) => `${estimateNumber(raw)} ${symbol}`;
  const usdEstimate = raw => {
    const value = estimateNumber(raw, 4);
    return value.startsWith("<") ? "<$" + value.slice(1) : "$" + value;
  };
  let storageAvailable = true;
  const storage = {
    getItem(key) { try { return localStorage.getItem(context && key === "featheral-creation-token" ? "featheral-context-wallet-token" : key); } catch (error) { storageAvailable = false; console.error("Wallet storage blocked:", error); return null; } },
    setItem(key, value) { try { localStorage.setItem(context && key === "featheral-creation-token" ? "featheral-context-wallet-token" : key, value); } catch (error) { storageAvailable = false; throw new Error("Wallet storage is blocked. Allow storage for this site and retry."); } },
    removeItem(key) { try { localStorage.removeItem(context && key === "featheral-creation-token" ? "featheral-context-wallet-token" : key); } catch (error) { storageAvailable = false; console.error("Wallet storage blocked:", error); } },
  };
  const interactive = config.interactive !== false;
  updateProviders();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  let token = interactive && !builtInPreferred ? storage.getItem("featheral-creation-token") || "" : "", owner = "", snapshot, epoch = 0, busy = false;
  const vaultReader = window.FeatheralVault ? new window.FeatheralVault.Vault(storage) : null;
  const vault = interactive ? vaultReader : null;
  const savedVault = vaultReader?.read();
  const ACTIVE_ACCOUNT = "featheral-wallet-active-account";
  function selectedAddress() {
    const address = storage.getItem(ACTIVE_ACCOUNT) || (context ? storage.getItem("featheral-wallet-public-account") : null);
    if (address && !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Stored active wallet address is invalid. Open the full wallet to select an account.");
    return address || vaultReader?.read()?.address || null;
  }
  let builtInActive = false, vaultDraft, idleAt = Date.now(), refreshQueued = false, returnedAddress, siteApproval;
  const sendSite = data => context ? context.onMessage(data) : window.opener.postMessage(data, config.parentOrigin);
  function announceSiteAccount() {
    if (!siteApproval || siteApproval.address || !owner || !token) return;
    siteApproval.address = owner;
    sendSite({ type: "featheral:wallet-auth-ready", nonce: siteApproval.nonce, address: owner });
  }
  if (savedVault && !browserProvider) token = "";
  const publicAddress = () => config.followActive ? returnedAddress !== undefined ? returnedAddress : selectedAddress() || config.address
    : config.address || returnedAddress || (!token ? selectedAddress() : null);
  if (!interactive) token = "";
  const units = (value, symbol) => {
    const decimals = symbol === "FTH$" ? 18 : 0, text = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("Enter a positive amount.");
    const [whole, fraction = ""] = text.split(".");
    if (fraction.length > decimals) throw new Error(symbol === "FTH$" ? "FTH$ supports 18 decimal places." : "Notes use whole units.");
    const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
    if (raw < 1n) throw new Error("Amount must be positive.");
    if (symbol !== "FTH$" && raw > 1000000000n) throw new Error("Note amounts must not exceed 1,000,000,000 whole units.");
    return raw.toString();
  };
  const format = (raw, symbol) => {
    const signed = BigInt(raw), absolute = signed < 0n ? -signed : signed, scale = symbol === "FTH$" ? 100n : 1n;
    const value = symbol === "FTH$" ? (absolute + 5n * 10n ** 15n) / 10n ** 16n : absolute;
    if (symbol === "FTH$" && absolute > 0n && value === 0n) return `${signed < 0n ? "-" : ""}<0.01 FTH$`;
    const fraction = symbol === "FTH$" ? (value % scale).toString().padStart(2, "0").replace(/0+$/, "") : "";
    return `${signed < 0n ? "-" : ""}${(value / scale).toLocaleString()}${fraction ? "." + fraction : ""} ${symbol}`;
  };
  const status = error => { console.error(error); $("status").textContent = error.message; };
  let reviewResult, reviewApproved = false;
  function review(message, title = "Review wallet operation") {
    requireVisible();
    if (reviewResult || $("site-approval").open) throw new Error("Finish the pending wallet approval first.");
    $("wallet-review-title").textContent = title;
    $("wallet-review-origin").textContent = config.parentOrigin || location.origin;
    $("wallet-review-account").textContent = owner || publicAddress() || "Not connected";
    $("wallet-review-message").textContent = message;
    $("wallet-review-status").textContent = "";
    $("wallet-review-confirm").disabled = false; $("wallet-review-confirm").textContent = "Approve";
    $("wallet-review-cancel").disabled = false;
    reviewApproved = false;
    $("wallet-review").removeAttribute("aria-busy");
    if ($("wallet-review").open) $("wallet-review").close();
    return new Promise((resolve, reject) => {
      reviewResult = resolve;
      try { $("wallet-review").showModal(); }
      catch (error) { reviewResult = null; reject(error); }
    });
  }
  function finishReview(approved) {
    const resolve = reviewResult; reviewResult = null;
    reviewApproved = approved;
    if (approved) {
      $("wallet-review-confirm").disabled = true; $("wallet-review-confirm").textContent = "Approving...";
      $("wallet-review").setAttribute("aria-busy", "true");
      $("wallet-review-status").textContent = "Processing your approval. If a signature is needed, confirm it in your wallet.";
    } else $("wallet-review").close();
    resolve?.(approved);
  }
  function rejectReview() {
    if (reviewApproved) { ++contextEpoch; operationRejected = true; status(new Error("Wallet operation rejected.")); }
    finishReview(false);
  }
  $("wallet-review-confirm").addEventListener("click", () => { if (reviewResult) finishReview(true); });
  $("wallet-review-cancel").addEventListener("click", rejectReview);
  $("wallet-review").addEventListener("cancel", event => {
    event.preventDefault();
    if (!$("wallet-review-cancel").disabled) rejectReview();
  });
  $("wallet-review").addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    if (!$("wallet-review-cancel").disabled) rejectReview();
  });
  $("wallet-review").addEventListener("close", () => {
    if (!$("wallet-review").open && (reviewResult || reviewApproved)) {
      if ($("wallet-review-cancel").disabled) finishReview(false); else rejectReview();
    }
  });
  function closeSiteApproval() {
    $("site-approval").close();
    $("site-connection").hidden = true;
    $("site-approval").removeAttribute("aria-busy");
  }
  function cancelSiteApproval(message = "Wallet request rejected.") {
    const approval = siteApproval;
    siteApproval = null;
    closeSiteApproval();
    if (approval) sendSite({ type: "featheral:wallet-signature", nonce: approval.nonce, error: message });
  }
  async function api(path, body, extraHeaders = {}) {
    if (!interactive && body) throw new Error("This address view is read-only. Open your site wallet to connect.");
    if (body && path !== "/logout") requireVisible();
    if (body && reviewApproved && (/\/(?:complete|send|login)$/.test(path))) {
      $("wallet-review-cancel").disabled = true;
      $("wallet-review-status").textContent = "Submitting the approved request. Closing the wallet cannot undo a submitted operation.";
    }
    const response = await fetch(`/api/creation${path}`, { method: body ? "POST" : "GET", cache: "no-store",
      headers: { "Content-Type": "application/json", "x-creation-token": token, ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`Wallet API unavailable (HTTP ${response.status}).`);
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { status: response.status });
    if (body) storage.setItem("featheral-wallet-updated", crypto.randomUUID());
    return result;
  }
  function tab(name) {
    if (name === "tip") name = "swap";
    if (!["assets", "send", "receive", "swap", "activity", "account"].includes(name)) name = "assets";
    for (const panel of document.querySelectorAll(".wallet-panel")) panel.hidden = panel.id !== name;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === name;
      if (button.getAttribute("role") === "tab") {
        button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
      } else button.setAttribute("aria-pressed", String(selected));
    }
  }
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => tab(button.dataset.tab));
    if (button.getAttribute("role") !== "tab") continue;
    button.addEventListener("keydown", event => {
      const tabs = [...document.querySelectorAll('[role="tab"]')], index = tabs.indexOf(button);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft"
        ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); tab(tabs[next].dataset.tab); tabs[next].focus();
    });
  }
  tab(config.payment ? "send" : context ? config.view : location.hash.slice(1) || config.view);
  if (!context) {
    listen(window, "hashchange", () => tab(location.hash.slice(1)));
    document.title = `Featheral Wallet · ${primarySymbol}`;
  }
  $("wallet-title").textContent = "Featheral Wallet";
  $("wallet-icon").src = `/shared/logo-${primarySymbol === "FTHG" ? "gold" : primarySymbol === "FTHS" ? "silver" : fthxFirst ? "ex" : "dollar"}.svg`;
  $("account-label").textContent = `${primarySymbol} balance`;
  renderBalance(emptyBalance);
  if (fthxFirst) {
    $("send-symbol").value = "FTHX";
  }
  if (primarySymbol === "FTHS") {
    for (const id of ["send-symbol", "swap-to"]) {
      const option = el("option", "FTHS"); option.value = "FTHS"; $(id).append(option); $(id).value = "FTHS";
    }
    $("swap-from").value = "FTH$";
  }
  if (config.payment) {
    $("send-symbol").value = "FTH$";
    $("recipient").value = config.payment.to;
    $("send-amount").value = config.payment.amount;
    $("payment-request").hidden = false;
    $("payment-request").textContent = `Payment request${config.payment.name ? " from " + config.payment.name : ""}. Display name is unverified. Check the recipient wallet ID and exact amount before approving.`;
  }
  const local = location.hostname.endsWith(".localhost");
  $("exchange-link").href = `${location.protocol}//${local ? "ex.localhost" : "ex.featheral.com"}${location.port ? ":" + location.port : ""}/`;
  const exchangeUrl = $("exchange-link").href;
  for (const link of document.querySelectorAll("[data-exchange-link]")) link.href = exchangeUrl;
  const worldOrigin = `${location.protocol}//${local ? "world.localhost" : "world.featheral.com"}${location.port ? ":" + location.port : ""}`;
  const dollarOrigin = `${location.protocol}//${local ? "dollar.localhost" : "dollar.featheral.com"}${location.port ? ":" + location.port : ""}`;
  $("explorer-link").href = dollarOrigin + "/explorer/";
  $("docs-link").href = dollarOrigin + "/docs/";
  $("gold-channel").href = exchangeUrl + "gold-channel/"; $("gold-channel").target = "_blank"; $("gold-channel").rel = "noopener";
  if (context) $("ethereum-swap").querySelector("a").href = exchangeUrl + "gold-channel/";
  $("ethereum-swap").hidden = primarySymbol !== "FTHG";
  $("world-sync").href = worldOrigin + "/wallet-sync.html";
  let cancelWorldSync = () => {};
  if (context) {
    let worldSync;
    $("world-sync").addEventListener("click", event => {
      event.preventDefault();
      try {
        requireVisible();
        if (worldSync && !worldSync.popup.closed) { worldSync.popup.focus(); return; }
        const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const url = new URL(worldOrigin + "/wallet-sync.html");
        url.search = new URLSearchParams({ returnOrigin: location.origin, syncNonce: nonce });
        const popup = window.open(url.href, "_blank", "popup,width=460,height=500");
        if (!popup) throw new Error("Allow the World account sync popup and retry. Your wallet stays on this site.");
        worldSync = { popup, nonce };
      } catch (error) { status(error); }
    });
    listen(window, "message", event => {
      if (!worldSync || event.origin !== worldOrigin || event.source !== worldSync.popup
        || event.data?.nonce !== worldSync.nonce || event.data?.type !== "featheral:world-account") return;
      try {
        requireVisible();
        if (event.data.error) throw new Error(event.data.error);
        if (!/^0x[0-9a-f]{64}$/.test(event.data.accountId || "")) throw new Error("World returned an invalid account.");
        worldAccount = event.data.accountId; storage.setItem("featheral-world-account", worldAccount);
        refresh().catch(status);
      } catch (error) { status(error); }
      finally { worldSync.popup.close(); worldSync = null; }
    });
    cancelWorldSync = () => { worldSync?.popup.close(); worldSync = null; };
    cleanup.push(cancelWorldSync);
  }
  $("world-play").href = worldOrigin + "/play/";
  $("world-funds").href = worldOrigin + "/world-funds.html";
  $("profile-link").href = worldOrigin + "/#/setup";
  $("activity-explorer").href = dollarOrigin + "/explorer/";
  function renderPortfolio(value) {
    const total = value.totals?.[primarySymbol];
    $("portfolio-primary").textContent = total
      ? `≈ ${equivalent(total.value, primarySymbol)}${total.partial ? " (partial)" : ""}` : `${primarySymbol} total unavailable`;
    const usdParts = typeof value.usd === "string" && /^\d+(?:\.\d{1,18})?$/.test(value.usd) ? value.usd.split(".") : null;
    const usdRaw = value.usdValue ?? (usdParts ? (BigInt(usdParts[0]) * 10n ** 18n + BigInt((usdParts[1] || "").padEnd(18, "0"))).toString() : null);
    const usd = usdRaw != null ? usdEstimate(usdRaw) : null;
    $("portfolio-usd").textContent = usd == null ? "USD unavailable" : `${usd}${value.partial ? " (partial)" : ""}`;
    $("portfolio-usd").title = `Estimated portfolio USD total. ${value.usdMarket?.source || "Prices are indicative, not guaranteed."}`;
    if (value.usdMarket?.fallback) $("portfolio-usd").textContent += " · reference";
    $("portfolio-primary").title = `Estimated portfolio total; linked, World and Exchange funds remain separate. ${value.source} ${value.fthgUnavailableReason || ""}${total?.unpriced.length ? ` Not valued in ${primarySymbol}: ${total.unpriced.join(", ")}.` : ""}`;
    $("portfolio-usd").title += ` ${value.usdUnavailableReason || ""} ${value.unpriced.length ? `Unpriced: ${value.unpriced.join(", ")}.` : ""} ${(value.usdUnpriced || []).join(". ")}`;
  }
  function clearPortfolio() {
    $("portfolio-usd").textContent = "USD unavailable";
    $("portfolio-primary").textContent = `${primarySymbol} total unavailable`;
    $("portfolio-primary").title = "Refresh or connect a wallet to obtain current portfolio estimates.";
    $("portfolio-usd").title = "Estimated portfolio USD total";
  }
  function connectionLabel() {
    const local = builtInPreferred || !providerChoices().length;
    const label = !interactive ? "Read-only wallet" : token ? "Disconnect wallet" : local ? vaultReader?.read() ? "Unlock built-in wallet" : "Create built-in wallet" : "Connect extension";
    const button = $("wallet-connect");
    button.title = label; button.setAttribute("aria-label", label); button.dataset.tooltip = label;
    button.dataset.state = token && owner ? "authorized" : publicAddress() ? "selected" : "disconnected";
    $("wallet-connect-label").textContent = label;
    $("connect").textContent = label;
    $("connect").disabled = !interactive || busy;
    button.disabled = !interactive;
    if (context && interactive) context.onConnectionState?.({
      address: token ? owner || publicAddress() : publicAddress(),
      state: button.dataset.state,
    });
  }
  let worldAccount = storage.getItem("featheral-world-account") || "";
  const publicWalletUrl = address => `/api/wallet/accounts/${address}`
    + (worldAccount && (!config.address || config.followActive) ? `?worldAccount=${encodeURIComponent(worldAccount)}` : "");
  const handoff = new URLSearchParams(context ? "" : location.hash.slice(1));
  if (handoff.has("worldAccount") || handoff.has("worldSyncError")) {
    const account = handoff.get("worldAccount");
    if (account && /^0x[0-9a-f]{64}$/.test(account)) {
      worldAccount = account; storage.setItem("featheral-world-account", account);
    } else if (handoff.has("worldSyncError")) $("world-status").textContent = handoff.get("worldSyncError");
    else $("world-status").textContent = "World account sync returned an invalid account.";
    history.replaceState(null, "", location.pathname + location.search);
  }
  async function refreshWorld(current) {
    if (!worldAccount || publicAddress()) return;
    try {
      const response = await fetch(`/api/v1/notes/fth/accounts/${worldAccount}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "World ledger balance unavailable.");
      if (current !== epoch) return;
      const balance = format(data.fthDollar.available, "FTH$");
      $("world-balance").textContent = balance;
      $("world-status").textContent = data.wallet
        ? `World wallet: ${data.wallet}. Connect this wallet for transfers and swaps.`
        : "World gameplay budget. Wallet and World are separate balances; deposits and withdrawals move existing FTH$ only.";
      if (!token) {
        $("account-label").textContent = data.wallet ? "World wallet · read only" : "World guest account";
        if (primarySymbol === "FTH$") renderBalance(balance); else renderBalance(`— ${primarySymbol}`);
        $("address").value = "";
        $("address").placeholder = "World budget · separate funds";
        $("address").title = "Manage deposits and withdrawals in World funds.";
        $("copy-wallet-address").disabled = true;
        $("holdings").replaceChildren(el("p", `World FTH$: ${balance}`));
        const valuation = await api(`/wallet/portfolio/${worldAccount}`);
        if (current === epoch && !token) renderPortfolio(valuation);
      }
    } catch (error) {
      if (current !== epoch) return;
      console.error("World balance refresh failed:", error);
      $("world-balance").textContent = "Unavailable";
      $("world-status").textContent = error.message;
      if (!token) { renderBalance(`— ${primarySymbol}`); clearPortfolio(); $("holdings").replaceChildren(); }
    }
  }
  async function sign(message) {
    requireVisible();
    const startingContext = contextEpoch;
    if (builtInActive) {
      if (expireVault()) throw new Error("Wallet locked after inactivity. Unlock again before signing.");
      const address = owner, current = epoch;
      idleAt = Date.now();
      const signature = await vault.sign(message, address);
      if (!builtInActive || owner !== address || epoch !== current || startingContext !== contextEpoch) throw new Error("Active wallet changed while signing.");
      return signature;
    }
    if (!browserProvider) throw new Error("Connect an Ethereum-compatible wallet.");
    const signer = owner, provider = browserProvider;
    const accounts = await provider.request({ method: "eth_accounts" });
    if (accounts[0]?.toLowerCase() !== signer.toLowerCase()) throw new Error("Wallet changed. Reconnect.");
    requireVisible();
    if (startingContext !== contextEpoch) throw new Error("Wallet changed while signing. Reconnect.");
    const hex = "0x" + [...new TextEncoder().encode(message)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const signature = await provider.request({ method: "personal_sign", params: [hex, signer] });
    if (provider !== browserProvider || owner !== signer || startingContext !== contextEpoch || (await provider.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== signer.toLowerCase())
      throw new Error("Wallet changed while signing. Reconnect.");
    return signature;
  }
  function lock(value) {
    busy = value;
    if (value) operationRejected = false;
    for (const element of document.querySelectorAll("form input, form select, form button, #connect, #refresh, #requests button, #extension-provider, #extension-connect, #builtin-connect"))
      element.disabled = value;
    if (!value) {
      if (!reviewResult) {
        reviewApproved = false; $("wallet-review").close();
        $("wallet-review").removeAttribute("aria-busy");
      }
      $("extension-connect").disabled = !interactive || !providerChoices().length;
      $("builtin-connect").disabled = !interactive;
      $("connect").disabled = !interactive;
    }
    if (!value && refreshQueued) { refreshQueued = false; refresh().catch(status); }
  }
  function reset(clearStoredSession = true) {
    if (siteApproval?.address) cancelSiteApproval("Wallet account or session changed. Start the request again.");
    ++epoch; token = ""; owner = ""; snapshot = null;
    sendRequest = null; swapRequest = null;
    if (reviewResult || reviewApproved) rejectReview();
    $("swap-status").textContent = "";
    clearPortfolio();
    if (clearStoredSession) storage.removeItem("featheral-creation-token");
    renderBalance(emptyBalance); $("address").value = ""; $("address").placeholder = "Not connected";
    $("address").title = ""; $("copy-wallet-address").disabled = true;
    connectionReady = true;
    if (browserProvider) bindProvider(browserProvider);
    connectionLabel();
    $("account-label").textContent = `Available ${primarySymbol}`;
    $("account-label").title = "Connect a wallet to view its available balance";
    $("available-balance").textContent = "Available to spend: connect wallet";
    $("receive-address").textContent = "Connect wallet first";
    for (const id of ["holdings", "trading-holdings", "history", "recent-history", "requests", "note-pairs"]) $(id).replaceChildren();
    $("trading-holdings").hidden = true;
    $("note-pairs").hidden = true;
    $("holdings").append(el("p", "Connect wallet to view your assets."));
    $("status").textContent = "";
  }
  let marketWarning = "";
  async function refreshMarkets(current, data) {
    let markets = [];
    try { ({ markets } = await api("/markets")); }
    catch (error) {
      if (current !== epoch) return;
      console.error(error);
      marketWarning = `Market list unavailable: ${error.message}. Held balances are shown independently.`;
      $("status").textContent = marketWarning;
    }
    if (current !== epoch) return;
    const selections = ["send-symbol"].map(id => [id, $(id).value]);
    for (const [id, previous] of selections) {
      $(id).replaceChildren();
      const symbols = ["FTH$", "FTHX", "FTHS", ...markets.map(market => market.symbol)];
      for (const symbol of [...new Set(symbols)]) { const option = el("option", symbol); option.value = symbol; $(id).append(option); }
      if (symbols.includes(previous)) $(id).value = previous;
    }
    for (const [id, fallback] of [["swap-from", "FTHX"], ["swap-to", "FTH$"]]) {
      const previous = $(id).value;
      const symbols = ["FTHX", "FTH$", ...markets.filter(market => market.funded && !market.reserved && market.symbol !== "FTHG").map(market => market.symbol)];
      $(id).replaceChildren();
      for (const symbol of [...new Set(symbols)]) { const option = el("option", symbol); option.value = symbol; $(id).append(option); }
      $(id).value = symbols.includes(previous) ? previous : fallback;
    }
    const hasFthx = data?.holdings.some(asset => asset.symbol === "FTHX" && BigInt(asset.balance) > 0n);
    const notePairs = markets.filter(market => market.funded && !market.reserved && !["FTH$", "FTHG", "FTHX"].includes(market.symbol)
      && (hasFthx || data?.holdings.some(asset => asset.symbol === market.symbol && BigInt(asset.balance) > 0n)));
    $("note-pairs").replaceChildren();
    $("note-pairs").hidden = !notePairs.length;
    if (notePairs.length) {
      $("note-pairs").append(el("h2", "FTHX note swaps"));
      for (const market of notePairs) {
        const button = el("button", `FTHX ↔ ${market.symbol}`); button.type = "button";
        button.title = "Quote this Exchange pair inside the wallet";
        button.addEventListener("click", () => {
          if (busy) return;
          swapRequest = null; $("swap-from").value = "FTHX"; $("swap-to").value = market.symbol;
          $("swap-status").textContent = ""; tab("swap"); $("swap-amount").focus();
        });
        $("note-pairs").append(button);
      }
    }
  }
  async function refresh() {
    const current = ++epoch;
    if (marketWarning && $("status").textContent === marketWarning) $("status").textContent = "";
    marketWarning = "";
    clearPortfolio();
    await refreshWorld(current);
    if (current !== epoch) return;
    if (!token && !publicAddress()) { await refreshMarkets(current); return; }
    let data;
    try {
      if (!token && publicAddress()) {
        const response = await fetch(publicWalletUrl(publicAddress()), { cache: "no-store" });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || "Public wallet view unavailable.");
      } else data = await api("/wallet" + (worldAccount ? `?worldAccount=${encodeURIComponent(worldAccount)}` : ""));
    }
    catch (error) {
      if (current !== epoch) return;
      if (error.status !== 401) throw error;
      reset();
      status(new Error("Wallet authorization expired. Your public balance stays connected; authorize again before spending."));
      await refresh(); return;
    }
    if (current !== epoch) return;
    const active = interactive && selectedAddress();
    if (token && active && active.toLowerCase() !== data.address.toLowerCase()) {
      await api("/logout", {}); reset(); await refresh(); return;
    }
    snapshot = data; owner = data.address;
    announceSiteAccount();
    if (context && interactive && owner) context.onSelected(owner);
    if (!context && config.selectionNonce && window.opener)
      window.opener.postMessage({ type: "featheral:wallet-selected", nonce: config.selectionNonce, address: owner }, config.parentOrigin);
    connectionLabel();
    if (token && interactive) storage.setItem(ACTIVE_ACCOUNT, owner);
    const linkedData = [];
    const record = vaultReader?.read();
    const addresses = record ? [record.address, ...vaultReader.verifiedLinks(record).map(link => link.address)] : [];
    if (addresses.length) {
      if (addresses.some(address => address.toLowerCase() === owner.toLowerCase())) {
        linkedData.push(...await Promise.all(addresses.filter(address => address.toLowerCase() !== owner.toLowerCase()).map(async address => {
          const response = await fetch(publicWalletUrl(address), { cache: "no-store" });
          const linked = await response.json();
          if (!response.ok) throw new Error(linked.error || `Linked wallet ${address} unavailable.`);
          return linked;
        })));
      }
    }
    if (current !== epoch) return;
    if (worldAccount === "0x000000000000000000000000" + owner.slice(2))
      $("world-status").textContent = "Legacy World account is the same wallet, not additional funds. Sync World account again after authorizing a separate budget.";
    $("account-label").textContent = `Available ${primarySymbol}`;
    $("account-label").title = token ? "Connected wallet · available to spend"
      : interactive ? "Connected wallet · approve or unlock before spending" : "Read-only wallet · available balance";
    const spendable = primarySymbol === "FTHG" ? data.ethereum?.balance == null ? "— FTHG"
      : goldAmount(data.ethereum.balance)
      : format(primarySymbol === "FTH$" ? data.dollar.balance.available : String(data.holdings.find(asset => asset.symbol === primarySymbol)?.balance || 0), primarySymbol);
    renderBalance(spendable);
    $("available-balance").textContent = primarySymbol === "FTHG" && data.ethereum?.balance == null
      ? "FTHG balance unavailable" : `Available to spend: ${spendable}`;
    if (data.portfolio) renderPortfolio(linkedData.length ? window.FeatheralPortfolio.combine([data, ...linkedData]) : data.portfolio);
    else clearPortfolio();
    if (linkedData.length) $("account-label").title += " · Linked accounts included only in estimates; funds separate";
    $("ethereum-activity").href = `https://etherscan.io/token/0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665?a=${owner}`;
    if (data.world) {
      const worldValue = data.portfolio?.worldEstimates?.[primarySymbol];
      $("world-balance").textContent = worldValue != null && !data.world.duplicate
        ? `≈ ${equivalent(worldValue, primarySymbol)}` : format(data.world.available, "FTH$");
      $("world-status").textContent = data.world.duplicate ? "Legacy World uses your wallet account; counted once in the portfolio."
        : "Included in the total portfolio. Gameplay funds stay separate; transfers require approval in World.";
      if (!data.world.duplicate) appendEstimates($("world-status"), worldValue, data.portfolio?.worldUsdValue, data.portfolio);
    } else if (data.worldError) { $("world-balance").textContent = "Unavailable"; $("world-status").textContent = data.worldError; }
    $("address").value = owner; $("address").placeholder = "Not connected";
    let addressStatus = !token ? interactive ? "Connected" : "Read-only" : "Authorized";
    if (vaultReader?.read()?.address.toLowerCase() === owner.toLowerCase())
      addressStatus = `Built-in · ${addressStatus}${vault?.signer ? "" : " · locked"}`;
    $("address").title = `${owner} · ${addressStatus}`; $("receive-address").textContent = owner;
    $("copy-wallet-address").disabled = false;
    $("holdings").replaceChildren(); $("history").replaceChildren(); $("requests").replaceChildren();
    const assets = [{ symbol: "FTH$", balance: data.dollar.balance.available }, ...data.holdings.filter(asset => asset.symbol !== "FTH$")];
    let ethereumRow;
    if (data.ethereum?.balance != null && BigInt(data.ethereum.balance) > 0n) {
      const row = el("div", "", "asset-row");
      const value = data.portfolio?.ethereumEstimates?.[primarySymbol], amounts = el("div", "");
      amounts.append(el("b", goldAmount(data.ethereum.balance)));
      appendEstimates(amounts, value, data.portfolio?.ethereumUsdValue, data.portfolio);
      const name = el("div", "", "asset-mark"), icon = document.createElement("img");
      icon.src = "/shared/logo-gold.svg"; icon.alt = "";
      const label = el("div", "FTHG"); label.append(el("small", "Ethereum Mainnet"));
      name.append(icon, label); row.append(name, amounts); ethereumRow = row;
      if (primarySymbol === "FTHG") $("holdings").append(row);
    }
    assets.sort((a, b) => Number(b.symbol === primarySymbol) - Number(a.symbol === primarySymbol));
    for (const asset of assets) {
      if (BigInt(asset.balance) === 0n) continue;
      const row = el("div", "", "asset-row"), name = el("div", "", "asset-mark");
      const icon = document.createElement("img"); icon.src = tokenIcon(asset.symbol); icon.alt = ""; name.append(icon);
      const label = el("div", asset.symbol); label.append(el("small", asset.symbol === "FTH$" ? "Featheral Dollar" : "Network note"));
      const amounts = el("div", ""), amount = el("b", format(String(asset.balance), asset.symbol));
      const estimate = walletEstimate(data.portfolio, asset);
      amounts.append(amount);
      appendEstimates(amounts, estimate, walletEstimate(data.portfolio, asset, "USD"), data.portfolio);
      name.append(label); row.append(name, amounts); $("holdings").append(row);
    }
    if (ethereumRow && primarySymbol !== "FTHG") $("holdings").append(ethereumRow);
    appendNative(data);
    for (const linked of linkedData) {
      $("holdings").append(el("p", `Linked · ${linked.address.slice(0, 6)}…${linked.address.slice(-4)} · separate funds`, "account-divider"));
      for (const asset of [{ symbol: "FTH$", balance: linked.dollar.balance.available }, ...linked.holdings.filter(asset => asset.symbol !== "FTH$")]) {
        if (BigInt(asset.balance) > 0n) appendToken(asset.symbol, format(String(asset.balance), asset.symbol), "Featheral L3",
          walletEstimate(linked.portfolio, asset), walletEstimate(linked.portfolio, asset, "USD"), linked.portfolio);
      }
      if (linked.ethereum?.balance != null && BigInt(linked.ethereum.balance) > 0n)
        appendToken("FTHG", goldAmount(linked.ethereum.balance), "Ethereum Mainnet", linked.portfolio.ethereumEstimates?.[primarySymbol],
          linked.portfolio.ethereumUsdValue, linked.portfolio);
      appendNative(linked);
    }
    if (!$("holdings").children.length) $("holdings").append(el("p", "No tokens with a balance yet."));
    const trading = $("trading-holdings");
    trading.replaceChildren();
    const tradingAccounts = [data, ...linkedData].filter(account => account.trading?.holdings?.some(asset => BigInt(asset.balance) > 0n));
    trading.hidden = !tradingAccounts.length;
    if (tradingAccounts.length) {
      trading.append(el("h2", "Exchange trading funds"), el("p", "Included in portfolio estimates, not available to send or swap from this wallet. Withdraw on Exchange first."));
      for (const account of tradingAccounts) {
        if (account !== data) trading.append(el("p", `Linked · ${account.address.slice(0, 6)}…${account.address.slice(-4)}`));
        for (const asset of account.trading.holdings) if (BigInt(asset.balance) > 0n) {
          const row = el("p", format(String(asset.balance), asset.symbol));
          appendEstimates(row, walletEstimate(account.portfolio, asset), walletEstimate(account.portfolio, asset, "USD"), account.portfolio);
          trading.append(row);
        }
      }
      const link = el("a", "Manage trading funds on Exchange ↗");
      link.href = exchangeUrl; link.target = "_blank"; link.rel = "noopener"; trading.append(link);
    }
    const transactions = [];
    for (const tx of data.dollar.transactions) {
      const account = "0x000000000000000000000000" + owner.slice(2);
      const delta = tx.gameDelta || tx.goldDelta || (tx.from === account ? "-" + tx.amount : tx.amount || "0");
      transactions.push({ label: `${tx.kind} · FTH$`, amount: format(delta, "FTH$"), at: Date.parse(tx.time) || 0 });
    }
    function tokenIcon(symbol) {
      if (["FTH$", "FTHX", "FTHG", "FTHS", "ETH"].includes(symbol))
        return `/shared/logo-${{ "FTH$": "dollar", FTHX: "ex", FTHG: "gold", FTHS: "silver", ETH: "eth" }[symbol]}.svg`;
      const label = symbol.replace(/[^A-Z0-9]/gi, "").slice(0, 4);
      return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#39304c"/><text x="20" y="24" text-anchor="middle" fill="#f3deff" font-family="sans-serif" font-size="11">${label}</text></svg>`);
    }
    function walletEstimate(portfolio, asset, currency = primarySymbol) {
      const total = portfolio?.assets?.find(value => value.symbol === asset.symbol);
      const value = currency === "USD" ? total?.usdValue : total?.estimates?.[currency];
      if (value == null || total.balance == null || BigInt(total.balance) === 0n) return null;
      return (BigInt(value) * BigInt(asset.balance) / BigInt(total.balance)).toString();
    }
    function appendEstimates(container, estimate, usd, portfolio, reference = portfolio?.usdMarket?.fallback) {
      const usdText = usd == null ? "USD unavailable" : usdEstimate(usd);
      const usdLine = el("small", `${usd == null ? "" : "≈ "}${usdText}${usd != null && reference ? " · reference" : ""}`, "asset-value");
      usdLine.title = usd == null ? portfolio?.usdUnavailableReason || "USD price unavailable"
        : reference ? portfolio.usdMarket.source : "Estimated USD value, not a guaranteed quote";
      container.append(usdLine, el("small", estimate != null ? `≈ ${equivalent(estimate, primarySymbol)}` : `${primarySymbol} estimate unavailable`, "asset-value"));
    }
    function appendToken(symbol, amount, network, estimate, usd, portfolio, reference = portfolio?.usdMarket?.fallback) {
      const row = el("div", "", "asset-row"), name = el("div", "", "asset-mark"), icon = document.createElement("img");
      icon.src = tokenIcon(symbol); icon.alt = "";
      const label = el("div", symbol); label.append(el("small", network)); name.append(icon, label);
      const amounts = el("div", "");
      amounts.append(el("b", amount));
      appendEstimates(amounts, estimate, usd, portfolio, reference);
      row.append(name, amounts); $("holdings").append(row);
    }
    function appendNative(data) {
      for (const asset of data.portfolio?.nativeAssets || []) {
        if (asset.balance === null) $("holdings").append(el("p", `${asset.name} ETH balance unavailable.`, "account-divider"));
        else if (BigInt(asset.balance) > 0n)
          appendToken("ETH", goldAmount(asset.balance).replace("FTHG", "ETH"), asset.name, asset.estimates[primarySymbol], asset.usdValue, data.portfolio, false);
      }
    }
    for (const tx of [...data.exchange.trades, ...data.markets.trades]) {
      transactions.push({ label: "Swap", amount: tx.from ? `${format(tx.amount, tx.from)} → ${format(tx.output, tx.to)}` : `${tx.side} ${tx.symbol}: ${tx.amount} → ${tx.output}`, at: Number(tx.at) || 0 });
    }
    for (const tx of data.noteTransfers) transactions.push({ label: `${tx.purpose === "tip" ? "Thanks · " : ""}${tx.owner === owner ? "Sent" : "Received"}`, amount: format(String(tx.amount), tx.symbol), at: Number(tx.at) || 0 });
    for (const tx of data.silverActivity || []) transactions.push({ label: tx.kind === "silver-refund" ? "Silver refund" : "Silver purchase", amount: format(String(tx.amount), tx.symbol), at: Number(tx.at) || 0 });
    transactions.sort((a, b) => b.at - a.at);
    for (const [id, limit] of [["history", 50], ["recent-history", 3]]) {
      $(id).replaceChildren();
      for (const tx of transactions.slice(0, limit)) {
        const row = el("div", "", "activity-row"), label = el("span", tx.label);
        label.append(el("small", tx.at ? new Date(tx.at).toLocaleString() : "Time unavailable"));
        row.append(label, el("span", tx.amount)); $(id).append(row);
      }
      if (!transactions.length) {
        const empty = el("p", "No transactions yet.");
        empty.title = "Ethereum FTHG activity is available from the explorer link in Activity.";
        $(id).append(empty);
      }
    }
    for (const request of data.exchange.requests) {
      if (request.parameters.funding) {
        const link = el("a", `Pool funding · ${request.status} on Exchange ↗`);
        link.href = exchangeUrl; link.target = "_blank"; link.rel = "noopener"; $("requests").append(link);
      } else {
        const button = el("button", `Resume ${request.from} → ${request.to}`);
        button.type = "button"; button.title = `Exchange settlement: ${request.status}`;
        button.addEventListener("click", () => resumeSwap(request.id));
        $("requests").append(button);
        if (request.status === "prepared") {
          const discard = el("button", "Discard"); discard.type = "button";
          discard.title = "Discard this unsubmitted quote without moving funds";
          discard.addEventListener("click", async () => {
            if (busy) return; lock(true);
            try {
              await api(`/wallet/swaps/${encodeURIComponent(request.id)}/cancel`, {});
              if (swapRequest?.requestId === request.requestId) swapRequest = null;
              await refresh();
            } catch (error) { status(error); }
            finally { lock(false); }
          });
          $("requests").append(discard);
        }
      }
      if (request.error) $("requests").append(el("p", request.error));
    }
    refreshMarkets(current, data).catch(status);
  }
  async function ensureSession() {
    if (token) return true;
    if (!interactive) throw new Error("This address view is read-only.");
    if (vault && (builtInPreferred || !providerChoices().length)) {
      if (vault.signer) { await loginWallet(vault.signer.address, true); return true; }
      tab("account"); $("local-wallet").open = true;
      $("vault-action").value = vault.read() ? "unlock" : "create"; updateVault();
      $("vault-password").focus(); return false;
    }
    if (!browserProvider) throw new Error(providerChoices().length > 1 ? "Choose an extension in Account, then connect." : "Create or restore a built-in wallet in Account, or enable your browser wallet.");
    providerChosen = true;
    const startingEpoch = epoch, startingContext = contextEpoch, provider = browserProvider;
    const accounts = await browserProvider.request({ method: "eth_requestAccounts" });
    requireVisible();
    if (startingEpoch !== epoch || startingContext !== contextEpoch || provider !== browserProvider)
      throw new Error("Wallet changed while connecting. Start again.");
    if (!/^0x[0-9a-f]{40}$/i.test(accounts?.[0] || "")) throw new Error("No wallet account was selected.");
    builtInActive = false; owner = accounts[0];
    await authorizeSession(owner);
    builtInActive = false; returnedAddress = owner;
    storage.setItem("featheral-creation-token", token); storage.setItem(ACTIVE_ACCOUNT, owner);
    return true;
  }
  $("connect").addEventListener("click", async () => {
    if (busy) return; lock(true);
    try {
      if (token) { await api("/logout", {}); vault?.lock(); builtInActive = false; reset(); updateVault(); await refresh(); return; }
      if (!await ensureSession()) return;
      await refresh(); $("status").textContent = "";
    } catch (error) { status(error); }
    finally { lock(false); }
  });
  $("wallet-connect").addEventListener("click", () => $("connect").click());
  $("extension-provider").addEventListener("change", () => {
    const picker = $("extension-provider"), choice = providerChoices()[Number(picker.value)];
    if (picker.value === "" || !choice) return;
    if (busy || token) { status(new Error("Disconnect before changing wallet providers.")); updateProviders(); return; }
    browserProvider = choice.provider; providerChosen = true; builtInPreferred = false;
    bindProvider(browserProvider); connectionLabel();
  });
  $("extension-connect").addEventListener("click", async () => {
    if (busy) return;
    if (token) { status(new Error("Disconnect before switching wallets.")); return; }
    builtInPreferred = false; connectionLabel(); $("connect").click();
  });
  $("builtin-connect").addEventListener("click", () => {
    if (busy) return;
    if (token && !builtInActive) { status(new Error("Disconnect before switching wallets.")); return; }
    builtInPreferred = true; connectionLabel(); tab("account"); $("local-wallet").open = true;
    $("vault-action").value = vault?.read() ? "unlock" : "create"; updateVault(); $("vault-password").focus();
  });
  $("refresh").addEventListener("click", () => refresh().catch(status));
  async function copyAddress() {
    try { if (!owner) throw new Error("Connect your wallet first."); await navigator.clipboard.writeText(owner); $("status").textContent = "Address copied."; }
    catch (error) { status(error); }
  }
  $("copy-address").addEventListener("click", copyAddress);
  $("copy-wallet-address").addEventListener("click", copyAddress);
  $("copy-wallet-address").disabled = !owner;
  let swapRequest;
  const exactAmount = (raw, symbol) => {
    if (symbol !== "FTH$") return `${raw} ${symbol}`;
    const digits = BigInt(raw).toString().padStart(19, "0"), fraction = digits.slice(-18).replace(/0+$/, "");
    return `${digits.slice(0, -18)}${fraction ? "." + fraction : ""} ${symbol}`;
  };
  function swapReview(quote, minimum = quote.output) {
    return `Swap ${exactAmount(quote.amount, quote.from)} → at least ${exactAmount(minimum, quote.to)}?\nRoute: ${quote.route.join(" → ")}\nLive Exchange pools · 0.3% fee per hop, including price impact.\nRecorded as Exchange trades. Ethereum FTHG conversion is separate.`;
  }
  async function finishSwap(request, account) {
    if (owner !== account) throw new Error("Wallet changed. Review the swap again.");
    const signature = request.message && ["prepared", "awaiting_signature"].includes(request.status) ? await sign(request.message) : undefined;
    if (owner !== account) throw new Error("Wallet changed. Review the swap again.");
    const result = await api(`/wallet/swaps/${encodeURIComponent(request.id)}/complete`, { signature });
    if (result.status !== "complete") throw new Error(`Swap settlement is ${result.status}. Resume the existing request; do not submit a replacement.`);
    await refresh();
    swapRequest = null;
    $("swap-amount").value = "";
    $("swap-status").textContent = `Swapped ${exactAmount(result.amount, result.from)} → ${exactAmount(result.output, result.to)} · recorded on Exchange.`;
  }
  async function resumeSwap(id) {
    if (busy) return; lock(true);
    try {
      if (!await ensureSession()) return;
      const account = owner, request = await api(`/wallet/swaps/${encodeURIComponent(id)}/refresh`, {});
      if (!await review(swapReview(request, request.parameters.minOutput), "Approve swap")) return;
      await finishSwap(request, account);
    } catch (error) { status(error); }
    finally { lock(false); }
  }
  $("swap-form").addEventListener("input", () => { swapRequest = null; $("swap-status").textContent = ""; });
  $("swap-form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; lock(true);
    try {
      if (!await ensureSession()) return;
      const account = owner;
      if (!swapRequest) {
        const from = $("swap-from").value, to = $("swap-to").value, amount = units($("swap-amount").value, from);
        const quote = await api("/wallet/swaps/quote", { from, to, amount });
        $("swap-status").textContent = `${exactAmount(quote.amount, from)} → ${exactAmount(quote.output, to)} · ${quote.route.join(" → ")}`;
        if (!await review(swapReview(quote), "Approve swap")) return;
        if (owner !== account) throw new Error("Wallet changed. Review the swap again.");
        swapRequest = { from, to, amount, minOutput: quote.output, requestId: crypto.randomUUID() };
      }
      const request = await api("/wallet/swaps/prepare", swapRequest);
      await finishSwap(request, account);
    } catch (error) {
      if (swapRequest) {
        try { await refresh(); }
        catch (refreshError) { status(new Error(`${error.message} Balance/request refresh failed: ${refreshError.message}`)); return; }
      }
      status(error);
    }
    finally { lock(false); }
  });
  let sendRequest;
  $("send-form").addEventListener("input", () => { sendRequest = null; });
  $("send-form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; lock(true);
    try {
      if (!await ensureSession()) return;
      const symbol = $("send-symbol").value, raw = units($("send-amount").value, symbol);
      const account = owner, startingEpoch = epoch, recipient = $("recipient").value;
      const reviewAmount = symbol === "FTH$" ? `${$("send-amount").value.trim()} FTH$` : format(raw, symbol);
      if (!await review(`Send ${reviewAmount} to ${recipient}?\nNetwork: native Featheral ledger. This moves existing funds.`, "Approve transfer")) return;
      if (owner !== account || epoch !== startingEpoch) throw new Error("Wallet changed. Review the transfer again.");
      if (symbol === "FTH$") {
        sendRequest ||= await api("/wallet/send/prepare", { to: recipient, amount: raw });
        const request = sendRequest, signature = await sign(request.message);
        requireVisible();
        if (owner !== account || epoch !== startingEpoch) throw new Error("Wallet changed. Review the transfer again.");
        $("wallet-review-cancel").disabled = true;
        $("wallet-review-status").textContent = "Submitting the approved transfer. Closing the wallet cannot undo it.";
        const response = await fetch("/api/v1/notes/fth/transfers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request.payment, signature }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "Dollar transfer failed.");
      } else {
        sendRequest ||= { to: recipient, symbol, amount: Number(raw), requestId: crypto.randomUUID() };
        await api("/wallet/notes/send", sendRequest);
      }
      sendRequest = null; $("status").textContent = "Transfer completed."; await refresh();
    } catch (error) { status(error); }
    finally { lock(false); }
  });
  function updateVault() {
    if (!vault) { $("local-wallet").hidden = true; return; }
    const record = vault.read(), action = $("vault-action").value;
    $("vault-state").textContent = record ? `${record.address.slice(0, 6)}…${record.address.slice(-4)} · ${vault.signer ? "Unlocked" : "Locked"}` : "Create without MetaMask";
    $("vault-confirm-label").hidden = action !== "create";
    $("vault-password").autocomplete = action === "create" ? "new-password" : "current-password";
    $("vault-password").minLength = action === "create" ? 12 : 1;
    $("vault-submit").textContent = action === "create" ? "Create encrypted wallet" : action === "restore" ? "Restore and unlock" : "Unlock wallet";
    $("vault-file-label").hidden = action !== "restore";
    $("vault-backup").disabled = !record; $("vault-lock").disabled = !vault.signer;
    $("vault-link").disabled = !vault.signer; $("vault-use").disabled = !vault.signer;
    $("linked-wallets").replaceChildren();
    for (const link of vault.verifiedLinks(record)) {
      const use = el("button", `Use external ${link.address.slice(0, 6)}…${link.address.slice(-4)}`);
      use.type = "button";
      use.addEventListener("click", () => vaultWork(async () => {
        if (!browserProvider) throw new Error("Open your linked Ethereum wallet to authorize spending from that account.");
        const selected = (await browserProvider.request({ method: "eth_requestAccounts" }))[0];
        if (selected?.toLowerCase() !== link.address.toLowerCase()) throw new Error("Select the linked account in your external wallet first.");
        await loginWallet(selected, false);
      }));
      $("linked-wallets").append(use);
    }
  }
  async function vaultWork(work) {
    if (busy) return; lock(true);
    try { await work(); $("vault-status").textContent = ""; }
    catch (error) { console.error("Built-in wallet:", error); $("vault-status").textContent = error.message; }
    finally { lock(false); updateVault(); }
  }
  async function loginWallet(address, local) {
    idleAt = Date.now();
    if (token) await api("/logout", {});
    reset(); owner = address; builtInActive = local; builtInPreferred = local;
    await authorizeSession(address);
    returnedAddress = address;
    storage.setItem(ACTIVE_ACCOUNT, address);
    if (!local) storage.setItem("featheral-creation-token", token);
    idleAt = Date.now(); await refresh();
  }
  async function authorizeSession(address) {
    const startingEpoch = epoch, startingContext = contextEpoch;
    const current = () => startingEpoch === epoch && startingContext === contextEpoch && owner === address;
    const challenge = await api("/challenge", { address });
    if (!current()) throw new Error("Wallet changed while connecting. Start again.");
    if (typeof challenge.message !== "string" || !challenge.message.length) throw new Error("Wallet sign-in challenge unavailable.");
    if (!await review(challenge.message, builtInActive ? "Connect built-in wallet" : "Connect wallet"))
      throw new Error("Wallet connection rejected.");
    if (!current()) throw new Error("Wallet changed while connecting. Start again.");
    const signature = await sign(challenge.message);
    const login = await api("/login", { address, signature });
    if (typeof login.token !== "string" || !login.token) throw new Error("Wallet sign-in returned an invalid session.");
    if (!current() || context && !context.visible()) {
      await endLocalSession(login.token);
      throw new Error("Wallet connection cancelled or changed. Start again.");
    }
    token = login.token;
  }
  function downloadBackup(record) {
    const blob = new Blob([typeof record === "string" ? record : JSON.stringify(record)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "featheral-wallet-encrypted-backup.json"; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function endLocalSession(session, keepalive = false) {
    const response = await fetch("/api/creation/logout", { method: "POST",
      headers: { "Content-Type": "application/json", "x-creation-token": session }, body: "{}", keepalive });
    if (!response.ok) throw new Error(`Wallet logout failed (HTTP ${response.status}).`);
  }
  function expireVault() {
    if (!vault?.signer || Date.now() - idleAt < 600000) return false;
    vault.lock();
    const localSession = builtInActive && token;
    builtInActive = false;
    if (localSession) { reset(); endLocalSession(localSession).catch(status); }
    updateVault();
    $("vault-status").textContent = "Wallet locked after ten minutes of inactivity. Unlock before spending.";
    return true;
  }
  if (vault) {
    if (savedVault) $("vault-action").value = "unlock";
    $("vault-action").addEventListener("change", updateVault);
    $("vault-form").addEventListener("submit", event => {
      event.preventDefault();
      vaultWork(async () => {
        if (!storageAvailable) throw new Error("Wallet storage is blocked. Enable local storage for this site before creating a wallet.");
        const password = $("vault-password").value, action = $("vault-action").value;
        if (action === "create") {
          if (vault.read()) throw new Error("A built-in wallet already exists. Unlock it rather than replacing it.");
          if (password !== $("vault-confirm").value) throw new Error("Passwords do not match.");
          $("vault-status").textContent = "Encrypting wallet. Keep this page open.";
          try { vaultDraft = await vault.prepare(password); }
          finally { $("vault-password").value = ""; $("vault-confirm").value = ""; }
          $("vault-backup-step").hidden = false; $("vault-form").hidden = true;
          $("vault-backup-confirm").checked = false;
        } else {
          try {
            if (action === "restore") {
              const file = $("vault-file").files[0];
              if (!file || file.size > 65536) throw new Error("Choose a wallet backup smaller than 64 KB.");
              await vault.restore(JSON.parse(await file.text()), password);
            } else {
              if (vault.signer) throw new Error("The built-in wallet is already unlocked. Use it or lock it first.");
              await vault.unlock(password);
            }
            await loginWallet(vault.signer.address, true);
          } finally { $("vault-password").value = ""; $("vault-file").value = ""; }
        }
      });
    });
    let downloaded = false;
    $("vault-download").addEventListener("click", () => {
      try { if (!vaultDraft) throw new Error("Create a wallet first."); downloadBackup(vaultDraft); downloaded = true; }
      catch (error) { $("vault-status").textContent = error.message; }
    });
    $("vault-activate").addEventListener("click", () => vaultWork(async () => {
      if (!vaultDraft || !downloaded || !$("vault-backup-confirm").checked) throw new Error("Download the encrypted backup and confirm you saved it first.");
      try {
        await vault.restore(vaultDraft, $("vault-activate-password").value);
        vaultDraft = null; downloaded = false; $("vault-backup-step").hidden = true; $("vault-form").hidden = false;
        $("vault-action").value = "unlock";
        await loginWallet(vault.signer.address, true);
      } finally { $("vault-activate-password").value = ""; }
    }));
    $("vault-cancel").addEventListener("click", () => {
      if (busy) return;
      vaultDraft = null; downloaded = false; $("vault-activate-password").value = "";
      $("vault-backup-step").hidden = true; $("vault-form").hidden = false; $("vault-status").textContent = "";
    });
    $("vault-backup").addEventListener("click", () => {
      try { downloadBackup(vault.backup()); } catch (error) { $("vault-status").textContent = error.message; }
    });
    $("vault-lock").addEventListener("click", () => vaultWork(async () => {
      vault.lock();
      for (const id of ["vault-password", "vault-confirm", "vault-activate-password"]) $(id).value = "";
      if (builtInActive) {
        builtInActive = false;
        try { if (token) await api("/logout", {}); } finally { reset(); }
      }
      await refresh();
    }));
    $("vault-use").addEventListener("click", () => vaultWork(async () => {
      if (!vault.signer) throw new Error("Unlock the built-in wallet first.");
      await loginWallet(vault.signer.address, true);
    }));
    $("vault-link").addEventListener("click", () => vaultWork(async () => {
      if (!browserProvider) throw new Error("Install or open an external Ethereum wallet first. Your built-in wallet already has its own Ethereum address.");
      if (!await review("Link this external wallet? Both accounts must sign. Balances stay separate and no transfers are authorized.", "Approve wallet link")) return;
      await vault.link(browserProvider); await refresh();
    }));
    for (const name of ["pointerdown", "keydown"]) document.addEventListener(name, () => { expireVault(); idleAt = Date.now(); }, true);
    setInterval(expireVault, 10000);
    document.addEventListener("visibilitychange", expireVault);
    listen(window, "pageshow", updateVault);
    listen(window, "pagehide", () => {
      vault.lock();
      for (const id of ["vault-password", "vault-confirm", "vault-activate-password"]) $(id).value = "";
      if (builtInActive && token) {
        endLocalSession(token, true).catch(error => console.error("Wallet logout on close failed:", error));
        token = ""; builtInActive = false;
      }
    });
    listen(window, "storage", event => {
      if (event.key !== "featheral-encrypted-wallet-v1" && event.key !== null) return;
      vault.lock();
      const localSession = builtInActive && token;
      builtInActive = false; reset();
      if (localSession) endLocalSession(localSession).catch(status);
      try { updateVault(); } catch (error) { status(error); }
      $("vault-status").textContent = "Wallet storage changed in another tab. Unlock again before spending.";
      refresh().catch(status);
    });
    updateVault();
  } else $("local-wallet").hidden = true;
  function bindProvider(provider) {
    if (boundProviders.has(provider)) return;
    boundProviders.add(provider);
    const accountsChanged = accounts => {
      if (provider !== browserProvider || builtInActive || !interactive) return;
      returnedAddress = accounts[0] || null;
      if (returnedAddress) storage.setItem(ACTIVE_ACCOUNT, returnedAddress); else storage.removeItem(ACTIVE_ACCOUNT);
      sendRequest = null; reset(); refresh().catch(status);
    };
    const disconnected = () => {
      if (provider !== browserProvider || builtInActive || !interactive) return;
      returnedAddress = null; storage.removeItem(ACTIVE_ACCOUNT);
      reset(); status(new Error("Extension disconnected. Reconnect before approving an action."));
      refresh().catch(status);
    };
    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("disconnect", disconnected);
    cleanup.push(() => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("disconnect", disconnected);
    });
  }
  listen(window, "storage", event => {
    if (![ACTIVE_ACCOUNT, "featheral-wallet-updated", "featheral-world-account", "featheral-encrypted-wallet-v1", null].includes(event.key)) return;
    if (vault && (event.key === "featheral-encrypted-wallet-v1" || event.key === null)) return;
    try {
      if (event.key === ACTIVE_ACCOUNT && !(config.address && !config.followActive)) {
        returnedAddress = selectedAddress();
        if (config.embedded && returnedAddress)
          window.parent.postMessage?.({ type: "featheral:wallet-selected", address: returnedAddress }, config.parentOrigin);
      }
      if (event.key === ACTIVE_ACCOUNT && !(config.address && !config.followActive)
        && owner && selectedAddress()?.toLowerCase() !== owner.toLowerCase()) {
        const localSession = builtInActive && token;
        vault?.lock(); builtInActive = false; reset(false);
        if (localSession) endLocalSession(localSession).catch(status);
        updateVault();
      }
      if (event.key === "featheral-world-account" || event.key === null) worldAccount = storage.getItem("featheral-world-account") || "";
      if (busy) refreshQueued = true;
      else refresh().catch(status);
    } catch (error) { status(error); }
  });
  listen(window, "focus", () => { if (!busy && !document.hidden) refresh().catch(status); });
  document.addEventListener("visibilitychange", () => { if (!busy && !document.hidden) refresh().catch(status); });
  let visibleRefreshPending = false;
  async function refreshVisible() {
    if (busy || visibleRefreshPending || document.hidden || !(token || worldAccount || publicAddress())) return;
    visibleRefreshPending = true;
    try { if (context && interactive) await resume(); else await refresh(); } catch (error) { status(error); }
    finally { visibleRefreshPending = false; }
  }
  async function resume() {
    if (!context || !interactive || !context.visible() || busy) return;
    const current = contextEpoch, provider = browserProvider;
    const record = vaultReader?.read(), selected = selectedAddress();
    if (!builtInActive && record?.address && selected && record.address.toLowerCase() === selected.toLowerCase()) builtInPreferred = true;
    if (!builtInActive) {
      const storedToken = builtInPreferred ? "" : storage.getItem("featheral-creation-token") || "";
      if (token !== storedToken) { reset(false); token = storedToken; }
    }
    if (provider && !builtInPreferred) {
      const startingEpoch = epoch;
      const accounts = await provider.request({ method: "eth_accounts" });
      if (current !== contextEpoch || startingEpoch !== epoch || provider !== browserProvider || !context.visible()) return;
      if (!Array.isArray(accounts) || accounts[0] && !/^0x[0-9a-f]{40}$/i.test(accounts[0]))
        throw new Error("Wallet extension returned an invalid account.");
      const address = accounts[0] || null;
      if (token && (!address || owner && owner.toLowerCase() !== address.toLowerCase())) {
        const staleToken = token;
        reset();
        const resetEpoch = epoch;
        await endLocalSession(staleToken);
        if (current !== contextEpoch || resetEpoch !== epoch || provider !== browserProvider || !context.visible()) return;
      } else if (owner && owner.toLowerCase() !== address?.toLowerCase()) reset(false);
      returnedAddress = address;
      if (address) storage.setItem(ACTIVE_ACCOUNT, address);
      else storage.removeItem(ACTIVE_ACCOUNT);
    }
    connectionLabel();
    await refresh();
  }
  setInterval(refreshVisible, 30000);
  if (config.authNonce) {
    const receive = event => {
      if ((!context && (event.source !== window.opener || event.origin !== config.parentOrigin)) || event.data?.nonce !== config.authNonce) return;
      if (event.data?.type === "featheral:wallet-auth-cancel" && event.data.nonce === siteApproval?.nonce) {
        siteApproval = null; closeSiteApproval();
      }
      if (interactive && event.data?.type === "featheral:wallet-auth-start" && /^[0-9a-f]{32}$/.test(event.data.nonce || "")) {
        if (siteApproval?.nonce === event.data.nonce) return;
        siteApproval = { nonce: event.data.nonce };
        $("site-connection").hidden = false; $("site-message").textContent = "";
        $("site-connection-status").textContent = "Connect or unlock your wallet to review the request.";
        $("site-origin").textContent = config.parentOrigin;
        $("site-approve").disabled = true;
        $("site-status").textContent = "Connect or unlock your wallet here to approve this sign-in.";
        tab("account"); announceSiteAccount();
      }
      if (interactive && siteApproval && event.data?.type === "featheral:wallet-auth" && event.data.nonce === siteApproval.nonce) {
        try {
          if (siteApproval.message || event.data.address?.toLowerCase() !== siteApproval.address?.toLowerCase())
            throw new Error("Sign-in account changed. Start again.");
          window.FeatheralSignIn.validate(event.data.address, event.data.message, true, config.parentOrigin);
          siteApproval.message = event.data.message;
          $("site-approve").textContent = event.data.message.startsWith("Pay Featheral Silver order.\n") ? "Approve FTHS payment"
            : event.data.message.startsWith("Featheral profile update\n") ? "Approve profile update" : "Approve sign-in";
          $("site-approval-title").textContent = $("site-approve").textContent;
          $("site-account").textContent = siteApproval.address;
          $("site-safety").textContent = event.data.message.startsWith("Pay Featheral Silver order.\n")
            ? "This authorizes an FTHS purchase. Verify the product, receiving account and exact amount."
            : event.data.message.startsWith("Featheral profile update\n") ? "This updates your public profile. It does not transfer funds."
              : "Sign-in does not transfer funds or cost gas. Review the exact message before approving.";
          $("site-message").textContent = event.data.message;
          $("site-approve").disabled = false;
          $("site-status").textContent = builtInActive ? "Approve using your unlocked built-in wallet."
            : "After approval, confirm the signature in your wallet extension.";
          if (reviewResult) throw new Error("Finish the pending wallet approval first.");
          reviewApproved = false; $("wallet-review").close();
          $("site-connection").hidden = true;
          $("site-approval").showModal();
        } catch (error) {
          status(error); $("site-status").textContent = error.message;
          cancelSiteApproval(error.message);
        }
      }
    };
    if (context) context.receive = data => receive({ data });
    else listen(window, "message", receive);
    $("site-approve").addEventListener("click", async () => {
      if (busy || !siteApproval?.message) return;
      const approval = siteApproval;
      lock(true); $("site-approve").disabled = true;
      $("site-approval").setAttribute("aria-busy", "true");
      $("site-approve").textContent = "Approving...";
      $("site-status").textContent = builtInActive ? "Signing with your built-in wallet..." : "Waiting for your wallet extension. Review its signature request.";
      try {
        window.FeatheralSignIn.validate(approval.address, approval.message, true, config.parentOrigin);
        if (owner?.toLowerCase() !== approval.address.toLowerCase()) throw new Error("Wallet changed. Start sign-in again.");
        const signature = await sign(approval.message);
        if (siteApproval !== approval || owner?.toLowerCase() !== approval.address.toLowerCase()) throw new Error("Sign-in cancelled or wallet changed.");
        siteApproval = null; closeSiteApproval();
        sendSite({ type: "featheral:wallet-signature", nonce: approval.nonce, address: owner, signature });
        $("status").textContent = approval.message.startsWith("Pay Featheral Silver order.\n") ? "FTHS payment authorized."
          : approval.message.startsWith("Featheral profile update\n") ? "Profile update approved." : "Site sign-in approved.";
      } catch (error) {
        status(error);
        if (siteApproval === approval) {
          $("site-status").textContent = `${error.message}\nRetry approval or reject this request.`;
          $("site-approve").disabled = false;
        }
      } finally {
        $("site-approval").removeAttribute("aria-busy");
        $("site-approve").textContent = $("site-approval-title").textContent;
        lock(false);
      }
    });
    $("site-cancel").addEventListener("click", () => cancelSiteApproval());
    $("site-connection-cancel").addEventListener("click", () => cancelSiteApproval());
    $("site-approval").addEventListener("cancel", event => { event.preventDefault(); cancelSiteApproval(); });
    $("site-approval").addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); cancelSiteApproval();
    });
    $("site-approval").addEventListener("close", () => {
      if (!$("site-approval").open && siteApproval?.message) cancelSiteApproval();
    });
    document.body.dataset.walletReady = "true";
    sendSite({ type: "featheral:wallet-ready" });
    $("wallet-connect-action").hidden = false;
    $("world-sync").target = "_blank"; $("world-funds").target = "_blank"; $("world-play").target = "_blank";
    for (const link of [$("world-sync"), $("world-funds"), $("world-play")]) link.rel = "noopener";
  }
  connectionReady = true;
  if (browserProvider) bindProvider(browserProvider);
  connectionLabel();
  if ((builtInPreferred || !providerChoices().length) && config.view === "account" && vault) {
    $("local-wallet").open = true;
    $("vault-action").value = vault.read() ? "unlock" : "create";
    updateVault();
  }
  if (!storageAvailable) $("status").textContent = "Browser wallet storage is blocked. Allow storage for this site's wallet to create or restore a built-in account.";
  if (interactive && !builtInPreferred && !token && !publicAddress() && browserProvider) {
    try {
      const accounts = await browserProvider.request({ method: "eth_accounts" });
      if (accounts[0] && /^0x[0-9a-fA-F]{40}$/.test(accounts[0])) storage.setItem(ACTIVE_ACCOUNT, accounts[0]);
    } catch (error) { status(error); }
  }
  try { if (context && interactive) await resume(); else await refresh(); } catch (error) { status(error); }
  return {
    tab,
    async resume() {
      try { await resume(); } catch (error) { status(error); throw error; }
    },
    async suspend() {
      ++contextEpoch;
      cancelWorldSync();
      siteApproval = null; closeSiteApproval();
      finishReview(false);
      vault?.lock();
      for (const id of ["vault-password", "vault-confirm", "vault-activate-password"]) $(id).value = "";
      const session = builtInActive && token;
      if (session) { builtInActive = false; reset(); await endLocalSession(session); }
      connectionLabel();
      updateVault();
    },
    dispose() { for (const release of cleanup.splice(0)) release(); },
  };
}
window.FeatheralWalletApp = { mount: mountFeatheralWallet };
if (!document.currentScript?.hasAttribute("data-context-wallet")) mountFeatheralWallet().catch(error => {
  console.error("Central wallet initialization failed:", error);
  const status = document.getElementById("status");
  if (status) status.textContent = error.message;
  const origin = new URLSearchParams(location.search).get("parentOrigin");
  const nonce = new URLSearchParams(location.search).get("authNonce");
  if (window.opener && origin && /^[0-9a-f]{32}$/.test(nonce || "") && document.referrer && new URL(document.referrer).origin === origin)
    window.opener.postMessage({ type: "featheral:wallet-signature", nonce, error: error.message }, origin);
});
