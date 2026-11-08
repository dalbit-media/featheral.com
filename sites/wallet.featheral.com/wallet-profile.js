"use strict";

// Compatibility profile control; fund management uses the contextual wallet.
// Uses raw EIP-1193 / JSON-RPC so it works with or without ethers on the page.
(() => {
  const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const RPC_URL = `${window.location.origin}/api/v1/gold/rpc`;
  const host = window.location.hostname;
  const centralOrigin = `${window.location.protocol}//${host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host)
    ? "wallet.localhost" : "wallet.featheral.com"}${window.location.port ? ":" + window.location.port : ""}`;
  const site = host.split(".")[0];
  const defaultPrimary = ["gold", "foundation", "featheral", "localhost"].includes(site) ? "FTHG" : site === "silver" ? "FTHS" : ["world", "dollar"].includes(site) ? "FTH$" : "FTHX";
  let primary = defaultPrimary;
  const worldProfileUrl = `${centralOrigin.replace("//wallet.", "//world.")}/account/`;
  const AVATAR_SIZE = 160;
  const MAX_AVATAR_BYTES = 40 * 1024;
  const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/;
  const ONE = 10n ** 18n;
  // Opening bridge rate; pages can pass the live spot rate via setRate().
  const OPENING_FTH_DOLLAR_PER_FTHG = 1000;

  const state = { account: "", chainId: 0, profile: null, balances: null, wallet: null, pendingAvatar: undefined, open: false, rate: OPENING_FTH_DOLLAR_PER_FTHG };
  let button;
  let panel;
  let options = {};
  let selectedProvider = null;
  const wallets = [];
  const boundProviders = new WeakSet();
  let picker;
  let connecting = false;
  let adminLink;
  let adminCheck = 0;
  let adminConfig;
  let moderators;
  let inlineProfileKey;
  let summary = null, summaryError = null;
  const getProvider = () => selectedProvider;

  function addWallet(provider, name) {
    if (!provider || typeof provider.request !== "function") return;
    const existing = wallets.find((wallet) => wallet.provider === provider);
    if (existing) existing.name = name || existing.name;
    else wallets.push({ provider, name: name || `Wallet ${wallets.length + 1}` });
  }
  window.addEventListener("eip6963:announceProvider", (event) => {
    addWallet(event.detail?.provider, event.detail?.info?.name);
    if (picker && !picker.hidden) renderPicker();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function discoverWallets() {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (!wallets.length) {
      for (const provider of window.ethereum?.providers || [window.ethereum]) {
        addWallet(provider, provider?.isMetaMask ? "MetaMask" : provider?.isCoinbaseWallet ? "Coinbase Wallet" : "");
      }
    }
    return wallets;
  }

  function useProvider(provider) {
    selectedProvider = provider;
    if (boundProviders.has(provider)) return;
    boundProviders.add(provider);
    provider.on?.("accountsChanged", (accounts) => {
      if (selectedProvider === provider && !isDisconnected()) {
        setAccount(accounts[0]).catch((error) => alert(error.message || String(error)));
      }
    });
    provider.on?.("chainChanged", (chainId) => {
      if (selectedProvider !== provider) return;
      state.chainId = Number(chainId);
      renderButton();
      if (state.open) renderPanel();
      emit();
    });
  }

  function closePicker() {
    if (!picker || picker.hidden) return;
    picker.hidden = true;
    button.setAttribute("aria-expanded", String(state.open));
    document.removeEventListener("keydown", onPickerKey);
    button.focus();
  }
  function onPickerKey(event) { if (event.key === "Escape") closePicker(); }
  function renderPicker() {
    const choices = wallets.map(({ provider, name }) => {
      const choice = el("button", { type: "button", className: "wp-wallet-choice", textContent: name });
      choice.addEventListener("click", async () => {
        closePicker();
        await connectProvider(provider);
      });
      return choice;
    });
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    cancel.addEventListener("click", closePicker);
    picker.replaceChildren(el("h4", { textContent: "Choose a wallet" }), ...choices, cancel);
  }

  async function connectProvider(provider) {
    if (connecting) return;
    connecting = true;
    button.disabled = true;
    try {
      useProvider(provider);
      await connectDefault();
      setDisconnected(false);
      await options.onConnect?.();
    } catch (error) {
      if (error?.code !== 4001) alert(error?.message || String(error));
    } finally {
      connecting = false;
      button.disabled = false;
    }
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }
  const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
  const displayName = () => state.profile?.username || (state.account ? short(state.account) : "");

  function formatUnits(raw, digits = 4) {
    const value = BigInt(raw);
    const whole = value / ONE;
    const fraction = Number(value % ONE) / 1e18;
    return (Number(whole) + fraction).toLocaleString("en-US", { maximumFractionDigits: digits });
  }
  const emit = () => window.dispatchEvent(new CustomEvent("featheral:wallet", { detail: snapshot() }));
  const snapshot = () => ({ account: state.account, chainId: state.chainId, profile: state.profile, balances: state.balances, wallet: state.wallet, rate: state.rate });

  let rpcId = 0;
  async function rpc(method, params) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || "RPC error");
    return body.result;
  }

  async function loadAdminConfig() {
    if (adminConfig) return adminConfig;
    const response = await fetch("/api/v1/admin/config", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Admin configuration HTTP ${response.status}`);
    const config = await response.json();
    if (!Array.isArray(config.adminWallets) || !Array.isArray(config.fthgAdminWallets)
      || [...config.adminWallets, ...config.fthgAdminWallets].some((address) => typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address))) {
      throw new Error("Invalid admin wallet configuration.");
    }
    adminConfig = config;
    return config;
  }

  async function updateAdminLink() {
    const check = ++adminCheck;
    if (!adminLink) return;
    adminLink.hidden = true;
    const account = state.account;
    if (!account) return;
    try {
      const site = ["gold", "dollar", "world"].find((name) => document.body.classList.contains(`site-${name}`)) || window.FeatheralSites?.current || "foundation";
      let list;
      if (site === "world") {
        if (!moderators) {
          const response = await fetch("/api/v1/world/moderation?limit=1", { headers: { accept: "application/json" }, cache: "no-store" });
          if (!response.ok) throw new Error(`Moderator configuration HTTP ${response.status}`);
          const config = await response.json();
          if (!Array.isArray(config.moderators) || config.moderators.some((address) => typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address))) throw new Error("Invalid moderator configuration.");
          moderators = config.moderators;
        }
        list = moderators;
      } else {
        const config = await loadAdminConfig();
        list = site === "gold" ? config.fthgAdminWallets : [...config.adminWallets, ...config.fthgAdminWallets];
      }
      let authorized = list.some((address) => address.toLowerCase() === account.toLowerCase());
      if (!authorized && site === "gold") {
        // hasRole(DEFAULT_ADMIN_ROLE, account), matching the Gold console's public role check.
        const data = `0x91d14854${"0".repeat(64)}${account.slice(2).toLowerCase().padStart(64, "0")}`;
        const result = await rpc("eth_call", [{ to: TOKEN, data }, "latest"]);
        if (!/^0x[0-9a-f]{64}$/i.test(result) || ![0n, 1n].includes(BigInt(result))) throw new Error("Invalid admin role response.");
        authorized = BigInt(result) === 1n;
      }
      if (check === adminCheck && account.toLowerCase() === state.account.toLowerCase()) adminLink.hidden = !authorized;
    } catch (error) {
      console.error("Admin navigation check failed:", error);
    }
  }

  // Deterministic 5x5 mirrored identicon so every wallet has a recognizable default avatar.
  function identicon(address) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 80;
    const ctx = canvas.getContext("2d");
    const hex = address.toLowerCase().replace(/^0x/, "");
    const hue = parseInt(hex.slice(0, 6), 16) % 360;
    ctx.fillStyle = `hsl(${(hue + 180) % 360} 30% 18%)`;
    ctx.fillRect(0, 0, 80, 80);
    ctx.fillStyle = `hsl(${hue} 65% 58%)`;
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        if (parseInt(hex[6 + y * 3 + x], 16) % 2 === 0) {
          ctx.fillRect(8 + x * 13, 8 + y * 13, 13, 13);
          ctx.fillRect(8 + (4 - x) * 13, 8 + y * 13, 13, 13);
        }
      }
    }
    return canvas.toDataURL("image/png");
  }
  const avatarFor = () => (state.pendingAvatar !== undefined ? state.pendingAvatar : state.profile?.avatar) || identicon(state.account);

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Must match services/identity/profile.js profileMessage().
  async function profileMessage({ address, username, avatar, issuedAt }) {
    return [
      "Featheral profile update",
      "",
      `Address: ${address}`,
      `Username: ${username}`,
      `Avatar: ${avatar ? await sha256Hex(avatar) : "none"}`,
      `Issued at: ${issuedAt}`,
      "Chain ID: 1",
      "",
      "Signing is free and does not send a transaction.",
    ].join("\n");
  }
  const toHexUtf8 = (text) => `0x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  async function loadProfile() {
    if (!state.account) return;
    const account = state.account;
    const response = await fetch(`/api/v1/notes/profiles/${account}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`World profile HTTP ${response.status}`);
    const body = await response.json();
    if (account.toLowerCase() !== state.account.toLowerCase()) return;
    state.profile = body.profile;
  }

  async function loadBalances() {
    if (!state.account) return;
    const account = state.account;
    const [eth, combined] = await Promise.allSettled([
      rpc("eth_getBalance", [account, "latest"]).then(BigInt),
      fetch(`${centralOrigin}/api/wallet/accounts/${account}`, { credentials: "omit", cache: "no-store" }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Central wallet HTTP ${response.status}`);
        return data;
      }),
    ]);
    if (account.toLowerCase() !== state.account.toLowerCase()) return;
    summary = combined.status === "fulfilled" ? combined.value : null;
    state.balances = {
      fthg: summary?.ethereum?.balance != null ? BigInt(summary.ethereum.balance) : null,
      eth: eth.status === "fulfilled" ? eth.value : null,
      checkedAt: new Date(),
    };
    state.wallet = summary ? { address: summary.address || account, gameAccountId: `0x${account.slice(2).toLowerCase().padStart(64, "0")}`,
      fthDollar: { balance: summary.dollar.balance.available, reserved: summary.dollar.balance.reserved || "0" } } : null;
    summaryError = combined.status === "rejected" ? combined.reason.message : null;
    if (summaryError) console.error("Central wallet portfolio unavailable:", combined.reason);
    // Wallets report lowercase addresses; adopt the API's checksummed form for display.
    if (state.wallet?.address && state.wallet.address.toLowerCase() === account.toLowerCase()) state.account = state.wallet.address;
    if (state.wallet?.profile !== undefined) state.profile = state.wallet.profile;
    emit();
  }

  function renderButton() {
    if (!button) return;
    if (!options.ethereumProvider) {
      button.title = "Open shared wallet";
      button.setAttribute("aria-label", `Open ${primary} wallet`);
      renderInlineProfile();
      return;
    }
    if (!button) return;
    button.classList.toggle("has-avatar", Boolean(state.account));
    if (!options.onConnect) {
      const onMainnet = state.chainId === 1;
      button.classList.toggle("connected", Boolean(state.account) && onMainnet);
      button.classList.toggle("wrong-network", Boolean(state.account) && !onMainnet);
      const label = options.ethereumProvider ? !state.account ? "Connect Ethereum signer"
        : onMainnet ? "Ethereum signer (connected)" : "Ethereum signer · not on Ethereum Mainnet. Click to switch."
        : !state.account ? "Connect wallet to see your balance and profile"
        : onMainnet ? `${displayName()} · open wallet and profile` : "Wallet is not on Ethereum Mainnet. Click to switch.";
      button.title = label;
      button.setAttribute("aria-label", label);
    }
    let img = button.querySelector("img.wp-avatar");
    if (state.account) {
      if (!img) {
        img = el("img", { className: "wp-avatar", alt: "" });
        button.prepend(img);
      }
      img.src = avatarFor();
    } else if (img) {
      img.remove();
    }
    renderInlineProfile();
  }

  function closePanel() {
    state.open = false;
    if (!options.profileRoot) state.pendingAvatar = undefined;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onOutside, true);
  }
  function onKey(event) { if (event.key === "Escape") { closePanel(); button.focus(); } }
  function onOutside(event) {
    if (!panel.contains(event.target) && !button.contains(event.target)) closePanel();
  }

  function setStatus(text, kind = "") {
    const status = (options.profileRoot || panel).querySelector(".wp-status");
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function profileEditor() {
    const editorAccount = state.account;
    const preview = el("img", { className: "wp-preview", src: avatarFor(), alt: "Avatar preview", width: 72, height: 72 });
    const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
    const usernameInput = el("input", {
      type: "text",
      value: state.profile?.username || "",
      placeholder: "username",
      maxLength: 24,
      autocomplete: "nickname",
      spellcheck: false,
    });
    usernameInput.setAttribute("aria-label", "Username");
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const avatar = await resizeAvatar(file);
        if (state.account !== editorAccount) throw new Error("Wallet changed. Select your avatar again.");
        state.pendingAvatar = avatar;
        preview.src = avatarFor();
        setStatus("New avatar ready. Save to publish it.");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    const saveButton = el("button", { type: "button", className: "wp-primary", textContent: "Save profile" });
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        if (state.account !== editorAccount) throw new Error("Wallet changed. Review your profile again.");
        await saveProfile(usernameInput.value.trim());
        preview.src = avatarFor();
      } catch (error) {
        setStatus(error.message || String(error), "error");
      } finally {
        saveButton.disabled = false;
      }
    });
    return [
      el("div", { className: "wp-avatar-row" },
        preview,
        el("div", { className: "wp-avatar-actions" },
          (() => { const b = el("button", { type: "button", textContent: "Upload avatar" }); b.addEventListener("click", () => fileInput.click()); return b; })(),
          (() => {
            const b = el("button", { type: "button", className: "wp-link", textContent: "Use default" });
            b.addEventListener("click", () => { state.pendingAvatar = ""; preview.src = identicon(state.account); setStatus("Default avatar selected. Save to publish it."); });
            return b;
          })(),
          el("small", { textContent: "PNG, JPEG, WebP, or GIF. Cropped to a square." }),
        ), fileInput),
      el("label", { className: "wp-field" }, el("span", { textContent: "Username" }), usernameInput),
      el("small", { className: "wp-hint", textContent: "3–24 letters, numbers, _ . or -. Usernames are unique." }),
      saveButton,
      el("p", { className: "wp-status", role: "status" }),
      el("p", { className: "wp-fine", textContent: "Saving asks for a free wallet signature, not an Ethereum transaction. Your profile and avatar are public and recorded on the shared Featheral Dollar ledger." }),
    ];
  }
  function renderInlineProfile() {
    const root = options.profileRoot;
    if (!root) return;
    const key = `${state.account.toLowerCase()}:${state.profile?.username || ""}:${state.profile?.avatar || ""}`;
    if (key === inlineProfileKey) return;
    inlineProfileKey = key;
    if (!state.account) {
      const connect = el("button", { type: "button", className: "wp-primary", textContent: "Connect wallet to set up profile" });
      connect.addEventListener("click", () => onButtonClick(true));
      root.replaceChildren(el("p", { textContent: "Choose a recognizable avatar and username for community posts and game chat. You can skip this and start exploring." }), connect);
      return;
    }
    root.replaceChildren(...profileEditor());
    if (!state.profile) setStatus("No profile yet. Pick a username and avatar.");
  }
  function renderPanel() {
    if (!state.open) return;
    if (options.ethereumProvider) {
      const disconnectButton = el("button", { type: "button", textContent: "Disconnect signer" });
      disconnectButton.addEventListener("click", () => disconnect().catch(error => alert(error.message)));
      panel.replaceChildren(el("h3", { textContent: "Ethereum approval signer" }),
        el("code", { textContent: state.account }),
        el("p", { textContent: state.chainId === 1 ? "Ethereum Mainnet" : "Not on Ethereum Mainnet" }),
        el("p", { textContent: "This control approves explicit operations only. Balances and wallet management use the central wallet." }),
        el("a", { href: `${centralOrigin}/?primary=${encodeURIComponent(primary)}&view=account`,
          target: "_blank", rel: "noopener", textContent: "Open central wallet" }), disconnectButton);
      return;
    }
    const fthg = state.balances?.fthg;
    const eth = state.balances?.eth;
    const value = (raw, fmt) => (raw === null || raw === undefined ? "—" : fmt(raw));
    const wrongNetwork = state.chainId && state.chainId !== 1;
    const copyButton = el("button", { type: "button", className: "wp-link", textContent: "Copy" });
    copyButton.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(state.account); copyButton.textContent = "Copied"; } catch { copyButton.textContent = "Copy failed"; }
      setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
    });
    const refreshButton = el("button", { type: "button", className: "wp-link", textContent: "Refresh" });
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      await loadBalances();
      renderButton();
      renderPanel();
    });

    panel.replaceChildren(...[
      el("div", { className: "wp-head" },
        el("img", { className: "wp-head-avatar", src: avatarFor(), alt: "", width: 44, height: 44 }),
        el("div", {},
          el("b", { textContent: displayName() }),
          el("div", { className: "wp-address" },
            el("code", { textContent: short(state.account), title: state.account }),
            copyButton,
            el("a", { href: `https://etherscan.io/address/${state.account}`, target: "_blank", rel: "noopener noreferrer", textContent: "Etherscan ↗" }),
          ),
        ),
      ),
      wrongNetwork ? el("p", { className: "wp-warning", textContent: "Your wallet is on another network. Balances below are read from Ethereum Mainnet." }) : null,
      el("div", { className: "wp-balances" },
        summary?.portfolio.totals?.[primary] ? el("div", { className: "wp-wallet-total" },
          el("span", { textContent: "All networks · estimated assets" }),
          el("b", {}, `${formatUnits(summary.portfolio.totals[primary].value, primary === "FTHG" ? 6 : 2)} `,
            el("span", { className: "wp-balance-currency", textContent: primary }))) : null,
        primary === "FTHX" || summary?.holdings.some(asset => asset.symbol === "FTHX" && BigInt(asset.balance) > 0n) ? el("div", { className: "wp-primary-balance" },
          el("span", { textContent: "FTHX balance" }),
          el("b", { textContent: summary ? `${BigInt(summary.holdings.find(asset => asset.symbol === "FTHX")?.balance || "0").toLocaleString()} FTHX` : "Unavailable" })) : null,
        ...(summary?.holdings.filter(asset => !["FTH$", "FTHG", "FTHX"].includes(asset.symbol) && BigInt(asset.balance) > 0n)
          .map(asset => el("div", {}, el("span", { textContent: asset.symbol }),
            el("b", { textContent: `${BigInt(asset.balance).toLocaleString()} ${asset.symbol}` }))) || []),
        primary === "FTHG" ? el("div", { className: "wp-primary-balance" }, el("span", { textContent: "FTHG balance" }),
          el("b", { textContent: summary?.ethereum?.balance != null ? `${formatUnits(summary.ethereum.balance, 6)} FTHG` : "Unavailable" })) : null,
        el("div", { className: "wp-primary-balance" },
          el("span", { textContent: "FTH$ balance" }),
          el("b", { textContent: !state.balances ? "—" : state.wallet ? `${formatUnits(state.wallet.fthDollar.balance, 2)} FTH$` : "Ledger unavailable" }),
          el("small", { textContent: state.wallet
            ? `${state.wallet.fthDollar.reserved !== "0" ? `${formatUnits(state.wallet.fthDollar.reserved, 2)} reserved for redemption` : "Available native FTH$"}`
            : "Featheral Dollar L3 balance" })),
        primary !== "FTHG" ? el("div", {}, el("span", { textContent: "FTHG balance" }), el("b", { textContent: value(fthg, (raw) => `${formatUnits(raw, 4)} FTHG`) })) : null,
        el("div", {}, el("span", { textContent: "Estimated assets" }),
          summary?.portfolio.totals?.FTHX ? el("b", { textContent: `${formatUnits(summary.portfolio.totals.FTHX.value, 2)} FTHX estimated total` }) : null,
          el("b", { textContent: summary?.portfolio.usd != null ? `$${summary.portfolio.usd}` : "USD unavailable" }),
          summary?.portfolio.dollarReference ? el("small", { textContent: `1 FTH$ ≈ ${formatUnits(BigInt(summary.portfolio.dollarReference.numerator) * ONE / BigInt(summary.portfolio.dollarReference.denominator), 2)} FTHX · ${summary.portfolio.dollarReference.source === "opening" ? "Opening estimate · not a swap quote" : "Exchange market rate"}` }) : null,
          el("small", { textContent: summary?.portfolio.fthg != null ? `${formatUnits(summary.portfolio.fthg, 6)} FTHG estimated` : "FTHG estimate unavailable" }),
          el("small", { textContent: summaryError || (summary?.portfolio.unpriced.length ? `Unpriced: ${summary.portfolio.unpriced.join(", ")}` : summary
            ? "Includes linked World funds; duplicate accounts counted once." : "Central wallet portfolio unavailable.") })),
        el("a", { href: `${centralOrigin}/?primary=${encodeURIComponent(primary)}`, target: "_blank", rel: "noopener", textContent: "Open central wallet · manage all assets" }),
        el("div", {}, el("span", { textContent: "ETH (gas)" }), el("b", { textContent: value(eth, (raw) => formatUnits(raw, 5)) })),
      ),
      el("div", { className: "wp-wallet-actions" }, ...["send", "receive", "swap", "activity"].map(view => {
        const action = el("a", { href: view === "swap" ? centralOrigin.replace("://wallet.", "://ex.") + "/" : `${centralOrigin}/?primary=${encodeURIComponent(primary)}&view=${view}${state.account ? "&address=" + encodeURIComponent(state.account) : ""}`,
          target: "_blank", rel: "noopener", textContent: { send: "↑ Send", receive: "↓ Receive", swap: "⇄ Swap", activity: "Activity" }[view] });
        action.addEventListener("click", event => {
          if (view === "swap" || !window.FeatheralWallet) return;
          event.preventDefault();
          window.FeatheralWallet.open({ primary, view, address: state.account, compact: true });
          closePanel();
        });
        return action;
      })),
      el("div", { className: "wp-recent" }, el("h4", { textContent: "Recent FTH$ transactions" }),
        ...(summary?.dollar.transactions?.length && summary.dollar.transactions.slice(0, 3).map(tx => el("p", { textContent: `${tx.kind} · ${formatUnits(tx.amount || "0", 2)} FTH$ · ${tx.time ? new Date(tx.time).toLocaleDateString() : "Pending"}` }))
          || [el("p", { textContent: "Open Activity for your transaction history." })])),
      state.wallet ? el("div", { className: "wp-account-id" },
        el("span", { textContent: "FTH$ account" }),
        el("code", { textContent: `${state.wallet.gameAccountId.slice(0, 10)}…${state.wallet.gameAccountId.slice(-6)}`, title: state.wallet.gameAccountId }),
        (() => {
          const b = el("button", { type: "button", className: "wp-link", textContent: "Copy" });
          b.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(state.wallet.gameAccountId); b.textContent = "Copied"; } catch { b.textContent = "Copy failed"; }
            setTimeout(() => { b.textContent = "Copy"; }, 1500);
          });
          return b;
        })(),
      ) : null,
      options.walletUrl ? el("a", { className: "wp-open-wallet", href: `${centralOrigin}/?primary=${encodeURIComponent(primary)}`, target: "_blank", rel: "noopener", textContent: "Open wallet →" }) : null,
      el("div", { className: "wp-meta" },
        el("small", { textContent: state.balances?.checkedAt ? `Balances read ${state.balances.checkedAt.toLocaleTimeString()} (Mainnet + FTH$ ledger)` : "Reading balances…" }),
        refreshButton,
      ),
      el("a", { className: "wp-open-wallet", href: worldProfileUrl, target: "_blank", rel: "noopener",
        textContent: "Edit World profile ↗", onclick: closePanel }),
      el("div", { className: "wp-footer" },
        el("p", { className: "wp-fine", textContent: "One wallet across Featheral. Profiles are edited in World. Transactions require your approval." }),
        (() => {
          const b = el("button", { type: "button", className: "wp-disconnect", title: "Disconnect wallet" });
          b.setAttribute("aria-label", "Disconnect wallet");
          b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';
          b.addEventListener("click", disconnect);
          return b;
        })(),
      ),
    ].filter(Boolean));
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
      image.src = url;
    });
  }
  async function resizeAvatar(file) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
    if (file.size > 15 * 1024 * 1024) throw new Error("Image is larger than 15 MB.");
    const image = await readImage(file);
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    for (const [type, quality] of [["image/webp", 0.86], ["image/webp", 0.7], ["image/jpeg", 0.82], ["image/jpeg", 0.6]]) {
      const dataUrl = canvas.toDataURL(type, quality);
      if (!dataUrl.startsWith(`data:${type};`)) continue;
      if (Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75) <= MAX_AVATAR_BYTES) return dataUrl;
    }
    throw new Error("Image could not be compressed below 40 KB.");
  }

  async function saveProfile(username) {
    if (!USERNAME_PATTERN.test(username)) throw new Error("Username must be 3–24 characters: letters, numbers, _ . or -, not starting with . or -.");
    const address = state.account;
    const avatar = state.pendingAvatar !== undefined ? state.pendingAvatar : state.profile?.avatar || "";
    const issuedAt = new Date().toISOString();
    setStatus("Waiting for your wallet signature…");
    const provider = getProvider();
    const message = await profileMessage({ address, username, avatar, issuedAt });
    if (state.account.toLowerCase() !== address.toLowerCase() || getProvider() !== provider) throw new Error("Wallet changed. Review your profile again.");
    const signature = await provider.request({ method: "personal_sign", params: [toHexUtf8(message), address] });
    if (state.account.toLowerCase() !== address.toLowerCase() || getProvider() !== provider) throw new Error("Wallet changed. Review your profile again.");
    setStatus("Saving to the shared ledger…");
    const response = await fetch("/api/v1/notes/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, username, avatar, issuedAt, signature }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Profile save failed (HTTP ${response.status}).`);
    if (state.account.toLowerCase() !== address.toLowerCase()) throw new Error("Profile was saved for the previous wallet. Refresh that wallet to view it.");
    state.profile = body.profile;
    state.pendingAvatar = undefined;
    emit();
    renderButton();
    renderPanel();
    setStatus(`Saved · FTH$ block #${Number(body.ledgerHeight).toLocaleString("en-US")}`, "ok");
    profileChannel?.postMessage({ type: "profile" });
  }

  function openPanel() {
    state.open = true;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    renderPanel();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside, true);
    loadBalances().then(() => { renderButton(); renderPanel(); });
  }

  async function connectDefault() {
    const provider = getProvider();
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.length) throw new Error("The wallet did not return an account.");
    const current = await provider.request({ method: "eth_chainId" });
    if (Number(current) !== 1) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    await setAccount(accounts[0]);
  }

  async function ensureSigner(address) {
    if (!options.ethereumProvider) throw new Error("Use the Admin Ethereum signing wallet, not the shared funds wallet.");
    const matches = accounts => accounts?.[0]?.toLowerCase() === address.toLowerCase();
    let provider = getProvider();
    if (!provider) {
      const available = discoverWallets();
      const results = await Promise.allSettled(available.map(async wallet => ({
        provider: wallet.provider, accounts: await wallet.provider.request({ method: "eth_accounts" }),
      })));
      for (const result of results) if (result.status === "rejected") console.error("Signing wallet discovery failed:", result.reason);
      const authorized = results.filter(result => result.status === "fulfilled" && matches(result.value.accounts));
      if (authorized.length === 1) provider = authorized[0].value.provider;
      else if (available.length === 1) provider = available[0].provider;
      else throw new Error(`Choose the Admin signing wallet ${address} in the header, then retry signing.`);
      if (getProvider() && getProvider() !== provider) throw new Error("Wallet changed. Review the action again.");
      useProvider(provider);
    }
    let accounts = await provider.request({ method: "eth_accounts" });
    if (!accounts?.length) accounts = await provider.request({ method: "eth_requestAccounts" });
    if (getProvider() !== provider) throw new Error("Wallet changed. Review the action again.");
    if (!matches(accounts)) throw new Error(`This Admin session requires ${address}. Select it in your wallet, or sign out and sign in with the other authorized origin or reserve wallet.`);
    setDisconnected(false);
    await setAccount(accounts[0]);
    if (getProvider() !== provider || state.account.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet changed. Review the action again.");
    return { provider, account: state.account };
  }

  async function onButtonClick(forProfile = false) {
    try {
      if (forProfile !== true && !options.ethereumProvider) {
        if (window.FeatheralWallet) window.FeatheralWallet.open({ primary, compact: true });
        else {
          button.title = "Wallet is still loading. Retry this button in a moment.";
          console.error("Site wallet is not available yet.");
        }
        return;
      }
      if (!state.account || (state.chainId && state.chainId !== 1)) {
        if (state.account && selectedProvider) {
          await connectProvider(selectedProvider);
          return;
        }
        const available = discoverWallets();
        if (!available.length) {
          throw new Error("No wallet extension detected. Open the site Wallet control to create or unlock a built-in wallet. This signing control requires an extension.");
          return;
        }
        if (available.length === 1) await connectProvider(available[0].provider);
        else {
          renderPicker();
          picker.hidden = false;
          button.setAttribute("aria-expanded", "true");
          document.addEventListener("keydown", onPickerKey);
          picker.querySelector("button")?.focus();
        }
        return;
      }
      if (state.open) closePanel(); else openPanel();
    } catch (error) {
      if (error?.code === 4001) return;
      alert(error?.message || String(error));
    }
  }

  // Sites cannot force a wallet to disconnect, so remember the choice and stop auto-reconnecting.
  const DISCONNECTED_KEY = "featheral.walletDisconnected";
  // The choice lives in a cookie scoped to the parent domain so every Featheral site shares it
  // (localStorage and wallet permissions are per-origin). Values: "1" disconnected, "0" connected.
  function cookieDomain() {
    const { hostname } = window.location;
    if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return "";
    const labels = hostname.split(".");
    const sites = ["foundation", "gold", "dollar", "world"];
    return sites.includes(labels[0]) && labels.length > 1 ? labels.slice(1).join(".") : hostname;
  }
  function readState() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${DISCONNECTED_KEY}=([01])`));
    if (match) return match[1];
    try { return localStorage.getItem(DISCONNECTED_KEY); } catch { return null; }
  }
  function writeState(value) {
    const domain = cookieDomain();
    const attrs = `; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    document.cookie = `${DISCONNECTED_KEY}=${value}${attrs}${domain ? `; Domain=${domain}` : ""}`;
    if (domain && !document.cookie.includes(`${DISCONNECTED_KEY}=${value}`)) document.cookie = `${DISCONNECTED_KEY}=${value}${attrs}`;
    try { localStorage.setItem(DISCONNECTED_KEY, value); } catch { /* storage unavailable */ }
  }
  function isDisconnected() {
    return readState() === "1";
  }
  function setDisconnected(value) {
    writeState(value ? "1" : "0");
  }
  async function disconnect(notify = true) {
    setDisconnected(true);
    closePicker();
    closePanel();
    await setAccount("");
    if (notify) profileChannel?.postMessage({ type: "disconnect" });
    options.onDisconnect?.();
    try {
      await getProvider()?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch { /* not supported by every wallet; local disconnect still applies */ }
  }

  async function setAccount(address) {
    const next = address ? String(address) : "";
    if (getProvider()) {
      try { state.chainId = Number(await getProvider().request({ method: "eth_chainId" })); } catch { state.chainId = 0; }
    }
    if (next.toLowerCase() === state.account.toLowerCase()) {
      renderButton();
      return;
    }
    state.account = next;
    state.profile = null;
    state.balances = null;
    state.wallet = null;
    summary = null; summaryError = null;
    state.pendingAvatar = undefined;
    updateAdminLink();
    if (state.open) closePanel();
    renderButton();
    emit();
    if (!next) return;
    await Promise.all([loadProfile(), loadBalances()]);
    renderButton();
    emit();
  }

  function mount(target, mountOptions = {}) {
    if (mountOptions.primary && !["FTHG", "FTH$", "FTHX", "FTHS"].includes(mountOptions.primary)) throw new Error("Unsupported wallet primary currency.");
    primary = mountOptions.primary || defaultPrimary;
    button = target;
    options = mountOptions;
    if (options.ethereumProvider) button.dataset.walletSigner = "true";
    else button.dataset.centralWallet = "true";
    if (options.profileRoot && !host.startsWith("world.")) options = { ...options, profileRoot: null };
    options = { ...options, profileUrl: worldProfileUrl };
    if (!options.ethereumProvider && !options.profileRoot) {
      button.title = "Open shared wallet";
      button.setAttribute("aria-label", `Open ${primary} wallet`);
      button.addEventListener("click", onButtonClick);
      return Promise.resolve();
    }
    button.innerHTML = '<svg class="wp-avatar-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    const headerNav = button.closest("header.top nav");
    if (window.FeatheralSites?.current === "admin" && headerNav && !headerNav.querySelector('a[href="/admin/"]')) {
      const site = ["gold", "dollar", "world"].find(name => document.body.classList.contains(`site-${name}`)) || "foundation";
      adminLink = el("a", { href: window.FeatheralSites?.url(site, "/admin/") || "/admin/", textContent: "Admin", className: "admin-nav", hidden: true });
      if (window.location.pathname === "/admin/" || window.location.pathname === "/admin/index.html") adminLink.setAttribute("aria-current", "page");
      headerNav.insertBefore(adminLink, headerNav.querySelector("[data-play-launch]") || button);
    }
    panel = el("div", { className: "wp-panel", hidden: true, role: "dialog" });
    panel.setAttribute("data-wallet-primary", primary);
    panel.setAttribute("aria-label", "Wallet and profile");
    (options.panelRoot || document.body).append(panel);
    picker = el("div", { className: "wp-panel wp-wallet-picker", hidden: true, role: "dialog" });
    picker.setAttribute("data-wallet-primary", primary);
    picker.setAttribute("aria-label", "Choose a wallet");
    (options.panelRoot || document.body).append(picker);
    button.addEventListener("click", onButtonClick);
    renderButton();
    if (!options.ethereumProvider) return Promise.resolve();
    if (window.FeatheralWorldAccount) {
      const account = window.FeatheralWorldAccount.snapshot()?.account;
      if (!account) return Promise.resolve();
      selectedProvider = window.FeatheralWorldAccount.provider;
      return setAccount(account).then(refreshProfile);
    }
    const available = discoverWallets();
    if (available.length !== 1) return Promise.resolve();
    useProvider(available[0].provider);
    if (!isDisconnected()) {
      // Restore this origin's authorized wallet silently; permission requests require a click.
      const provider = getProvider();
      return provider.request({ method: "eth_accounts" }).then(async (accounts) => {
        if (getProvider() !== provider || isDisconnected()) return;
        await setAccount(accounts[0]);
      }).catch((error) => console.error("Wallet restoration failed:", error));
    }
    return Promise.resolve();
  }

  function setRate(fthDollarPerFthg) {
    const next = Number(fthDollarPerFthg);
    if (!Number.isFinite(next) || next <= 0 || next === state.rate) return;
    state.rate = next;
    renderButton();
    if (state.open) renderPanel();
    emit();
  }

  async function refreshProfile() {
    if (!button || !state.account) return;
    if (isDisconnected() && !window.FeatheralWorldAccount?.snapshot()?.account) { await disconnect(false); return; }
    try {
      await Promise.all([loadProfile(), loadBalances()]);
      renderButton();
      if (state.open) renderPanel();
      emit();
    } catch (error) {
      console.error("World profile refresh failed:", error);
      if (state.open) setStatus(error.message || String(error), "error");
    }
  }
  const profileChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("featheral-world-profile") : null;
  if (profileChannel) profileChannel.onmessage = async (event) => {
    if (event.data?.type === "disconnect" && button && !window.FeatheralWorldAccount?.snapshot()?.account) await disconnect(false);
    else if (event.data?.type === "profile") await refreshProfile();
  };
  window.addEventListener("focus", refreshProfile);

  window.FeatheralProfile = {
    mount, setAccount, setRate, disconnect, isDisconnected, snapshot, getProvider, ensureSigner,
    refresh: refreshProfile,
    setWorldProvider(provider) { selectedProvider = provider; },
    setWorldSession(session, provider) {
      const changed = state.account.toLowerCase() !== (session.account || "").toLowerCase();
      selectedProvider = provider; state.account = session.account || ""; state.profile = session.profile; state.chainId = session.account ? 1 : 0;
      if (changed) { state.balances = null; state.wallet = null; summary = null; summaryError = null; state.pendingAvatar = undefined; }
      renderButton(); emit();
      if (changed && button) void refreshProfile();
    },
  };
})();
