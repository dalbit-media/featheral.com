"use strict";
(() => {
  const site = location.hostname.split(".")[0];
  const defaultPrimary = ["gold", "foundation", "featheral", "localhost"].includes(site) ? "FTHG" : site === "silver" ? "FTHS" : ["world", "dollar", "pay"].includes(site) ? "FTH$" : "FTHX";
  const selectionKey = "featheral-wallet-public-account", headerButtons = new Map(), mounts = new Map();
  let assets, authorization, selectedPublicAddress, avatarUrl, avatarAccount, connectionState = "disconnected", anchorButton;
  try { selectedPublicAddress = localStorage.getItem(selectionKey); }
  catch (error) { console.error("Wallet selection unavailable:", error); }
  if (!/^0x[0-9a-f]{40}$/i.test(selectedPublicAddress || "")) selectedPublicAddress = null;
  if (selectedPublicAddress) connectionState = "selected";
  function paint() {
    for (const [button, primary] of headerButtons) {
      if (!button.isConnected) { headerButtons.delete(button); continue; }
      button.innerHTML = '<span class="central-wallet-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h5M7 5V3h10v2"/></svg></span>';
      if (selectedPublicAddress) {
        const avatar = document.createElement("span"); avatar.className = "central-wallet-avatar";
        avatar.setAttribute("aria-hidden", "true");
        if (avatarUrl) { const image = document.createElement("img"); image.src = avatarUrl; image.alt = ""; avatar.append(image); }
        else avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
        button.append(avatar);
      }
      const label = document.createElement("span"); label.className = "central-wallet-label";
      label.textContent = selectedPublicAddress ? `..${selectedPublicAddress.slice(-5)}` : "Wallet"; button.append(label);
      const status = connectionState === "authorized" ? "connected" : connectionState === "selected" ? "public account · approval or unlock required" : "not connected";
      button.setAttribute("aria-label", `Open ${primary} wallet${selectedPublicAddress ? ` · ${selectedPublicAddress}` : ""} · ${status}`);
      button.title = button.getAttribute("aria-label");
      button.dataset.walletState = connectionState;
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "featheral-central-wallet");
      button.setAttribute("aria-expanded", String(!!document.getElementById("featheral-central-wallet")?.open));
    }
  }
  async function select(address) {
    if (!/^0x[0-9a-f]{40}$/i.test(address || "")) throw new Error("Invalid wallet account.");
    selectedPublicAddress = address;
    if (connectionState === "disconnected") connectionState = "selected";
    try { localStorage.setItem(selectionKey, address); }
    catch (error) { console.error("Wallet selection could not be saved:", error); }
    paint();
    if (avatarAccount === address) return;
    avatarAccount = address; avatarUrl = null;
    try {
      const response = await fetch(`/api/v1/notes/profiles/${address}`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Wallet avatar HTTP ${response.status}`);
      const { profile } = await response.json(), avatar = profile?.avatar;
      if (avatar && (typeof avatar !== "string" || avatar.length > 56000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)))
        throw new Error("Invalid wallet avatar.");
      if (avatarAccount === address) avatarUrl = avatar || null;
    } catch (error) { console.error("Wallet avatar unavailable:", error); }
    paint();
  }
  function settings(options = {}) {
    const primary = options.primary || defaultPrimary, view = options.view || "assets";
    if (!["FTHG", "FTH$", "FTHX", "FTHS"].includes(primary) || !["assets", "send", "receive", "swap", "tip", "activity", "account"].includes(view))
      throw new Error("Unsupported wallet options.");
    const followActive = options.followActive === true || options.followActive !== false && !options.address;
    const params = new URLSearchParams({ parentOrigin: location.origin, primary, view, compact: options.compact ? "1" : "0",
      followActive: followActive ? "1" : "0" });
    if (options.mode) params.set("mode", options.mode);
    if (!followActive && options.address) {
      if (!/^0x[0-9a-f]{40}$/i.test(options.address)) throw new Error("Invalid public wallet address.");
      params.set("address", options.address);
    }
    if (options.payment) for (const [key, value] of new URLSearchParams(options.payment)) {
      if (!["to", "amount", "name", "currency"].includes(key)) throw new Error("Unsupported payment request field.");
      params.append(key, value);
    }
    return params;
  }
  function position(dialog) {
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    const offsetTop = viewport?.offsetTop || 0, offsetLeft = viewport?.offsetLeft || 0;
    const anchor = anchorButton?.isConnected ? anchorButton : [...headerButtons.keys()].find(button => button.isConnected);
    const rect = anchor?.getBoundingClientRect();
    const top = Math.max(8, Math.min((rect?.bottom || 48) + 8 - offsetTop, Math.max(8, height - 200)));
    dialog.style.top = `${offsetTop + top}px`;
    dialog.style.left = "auto";
    const panelWidth = Math.min(460, width - 16);
    dialog.style.right = `${Math.max(8, Math.min(width - panelWidth - 8, width + offsetLeft - (rect?.right || width - 8)))}px`;
    dialog.style.width = `${panelWidth}px`;
    dialog.style.maxHeight = `${height - top - 8}px`;
  }
  function loadScript(file, available) {
    if (available()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = "/shared/wallet/" + file;
      script.dataset.contextWallet = "true";
      const deadline = setTimeout(() => { script.remove(); reject(new Error(`Wallet module ${file} timed out. Retry opening the wallet.`)); }, 20000);
      script.onload = () => { clearTimeout(deadline); available() ? resolve() : reject(new Error(`Wallet module ${file} did not initialize.`)); };
      script.onerror = () => { clearTimeout(deadline); script.remove(); reject(new Error(`Wallet module ${file} unavailable. Retry opening the wallet.`)); };
      document.head.append(script);
    });
  }
  function loadAssets() {
    if (!assets) assets = (async () => {
      const read = async file => {
        const response = await fetch("/shared/wallet/" + file, { cache: "no-store", signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Wallet ${file} HTTP ${response.status}`);
        return response.text();
      };
      const [html, css] = await Promise.all([read("wallet-app.html"), read("wallet-app.css")]);
      await loadScript("ethers.js", () => !!window.ethers);
      await Promise.all([
        loadScript("vault.js", () => !!window.FeatheralVault),
        loadScript("portfolio-view.js", () => !!window.FeatheralPortfolio),
        loadScript("site-sign-in.js", () => !!window.FeatheralSignIn),
      ]);
      await loadScript("wallet-app.js", () => !!window.FeatheralWalletApp);
      return { html, css };
    })().catch(error => { assets = null; throw error; });
    return assets;
  }
  function applyTheme(body) {
    const style = getComputedStyle(document.body);
    const pick = (names, fallback) => names.map(name => style.getPropertyValue(name).trim()).find(Boolean) || fallback;
    const properties = {
      "--brand": pick(["--brand", "--accent", "--gold"], "#e2b13c"),
      "--wallet-bg": pick(["--bg", "--background"], style.backgroundColor),
      "--panel": pick(["--panel", "--card", "--surface"], "Canvas"),
      "--txt": pick(["--txt", "--text"], style.color),
      "--muted": pick(["--muted", "--mut"], style.color),
      "--line": pick(["--line", "--border"], "#8886"),
      "--btn": pick(["--btn", "--panel", "--card"], "Canvas"),
      "--on-accent": pick(["--on-accent", "--on-brand"], "#111"),
    };
    for (const [key, value] of Object.entries(properties)) body.style.setProperty(key, value);
    body.style.fontFamily = style.fontFamily; body.style.colorScheme = style.colorScheme;
  }
  function onMessage(entry, data) {
    const pending = authorization;
    if (!pending || pending.entry !== entry || data.nonce !== entry.nonce) return;
    if (data.type === "featheral:wallet-signature") {
      if (data.error) { pending.finish(new Error(data.error)); return; }
      if (data.address?.toLowerCase() !== pending.address?.toLowerCase() || !/^0x[0-9a-f]{130}$/i.test(data.signature || "")) {
        pending.finish(new Error("Invalid wallet sign-in response.")); return;
      }
      pending.finish(null, { address: data.address, signature: data.signature });
    } else if (data.type === "featheral:wallet-auth-ready" && !pending.address) {
      if (!/^0x[0-9a-f]{40}$/i.test(data.address || "")) { pending.finish(new Error("Invalid wallet account.")); return; }
      pending.address = data.address;
      if (pending.selectOnly) { pending.finish(null, { address: data.address }); return; }
      Promise.resolve().then(() => pending.challenge(data.address)).then(request => {
        if (authorization !== pending) return;
        if (typeof request?.message !== "string") throw new Error("Site sign-in challenge unavailable.");
        entry.context.receive({ type: "featheral:wallet-auth", nonce: entry.nonce, address: data.address, message: request.message });
      }).catch(error => { if (authorization === pending) pending.finish(error); });
    }
  }
  function mount(root, options = {}) {
    const params = settings(options), key = params.toString(), previous = mounts.get(root);
    if (previous?.key === key) return previous.ready;
    if (previous) {
      previous.closed = true;
      if (authorization?.entry === previous) authorization.finish(new Error("Wallet context changed. Retry connecting."));
      previous.ready.then(app => app.suspend().catch(error => console.error("Wallet lock:", error)).finally(() => app.dispose())).catch(error => console.error("Wallet cleanup:", error));
    }
    root.replaceChildren(); root.dataset.walletMounted = "true";
    const host = document.createElement("div"); root.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Loading wallet..."; shadow.append(status);
    const entry = { key, root, closed: false, nonce: [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("") };
    if (!params.has("address")) params.set("authNonce", entry.nonce);
    const context = { root: shadow, search: "?" + params, visible: () => !entry.closed && root.isConnected && (!root.closest("dialog") || root.closest("dialog").open),
      onSelected: address => { if (!entry.closed) select(address).catch(error => console.error("Wallet selection:", error)); },
      onConnectionState: ({ address, state }) => {
        if (entry.closed || mounts.get(root) !== entry || params.get("followActive") !== "1") return;
        connectionState = state;
        if (address) select(address).catch(error => console.error("Wallet selection:", error));
        else {
          selectedPublicAddress = null; avatarAccount = null; avatarUrl = null;
          try { localStorage.removeItem(selectionKey); } catch (error) { console.error("Wallet selection:", error); }
          paint();
        }
      },
      onMessage: data => onMessage(entry, data) };
    entry.context = context;
    entry.ready = loadAssets().then(async ({ html, css }) => {
      if (entry.closed) throw new Error("Wallet context replaced.");
      const template = new DOMParser().parseFromString(html, "text/html");
      template.querySelectorAll("script").forEach(script => script.remove());
      const body = document.createElement("div"); body.className = "wallet-body"; body.innerHTML = template.body.innerHTML;
      const styles = document.createElement("style");
      styles.textContent = css.replace(/:root/g, ":host").replace(/\bbody\b/g, ".wallet-body") + `
        :host{display:block;background:transparent;color:inherit}
        .wallet-body[data-primary]{min-height:0!important;background:var(--wallet-bg);color:var(--txt)}
        .wallet-body header,.eco-bar,footer{display:none!important}
        .wallet-body[data-primary] main{margin:0!important;padding:12px!important;max-width:none!important}
        .wallet-body[data-primary]:not([data-embedded=true]) .wallet-intro{display:none}
        .wallet-body[data-primary] input,.wallet-body[data-primary] select,.wallet-body[data-primary] code{background:var(--wallet-bg)}
        .wallet-body[data-primary] button:hover{background:var(--btn)}
        .wallet-body[data-primary] .tabs [role=tab][aria-selected=true]{background:var(--brand);color:var(--on-accent)}
        .wallet-body[data-primary] form button[type=submit]{color:var(--on-accent)}
      `;
      shadow.replaceChildren(styles, body); context.body = body;
      body.querySelector(".connection-option:nth-child(2) p").textContent = `Encrypted wallet stored only on ${location.hostname}. Import your encrypted recovery backup to reuse an existing wallet; nothing is copied from the wallet site automatically.`;
      const app = await window.FeatheralWalletApp.mount(context);
      applyTheme(body);
      return app;
    }).catch(error => {
      context.dispose?.();
      console.error("Context wallet:", error); status.textContent = error.message; shadow.replaceChildren(status);
      if (mounts.get(root) === entry) { root.dataset.walletMounted = ""; mounts.delete(root); }
      throw error;
    });
    entry.ready.catch(error => { if (authorization?.entry === entry) authorization.finish(error); });
    mounts.set(root, entry);
    return entry.ready;
  }
  function open(options = {}) {
    if (authorization) {
      const dialog = authorization.entry.root.closest("dialog");
      if (dialog?.open) { dialog.focus(); return dialog; }
    }
    options = { ...options, followActive: options.followActive !== false };
    let dialog = document.getElementById("featheral-central-wallet");
    if (!dialog) {
      dialog = document.createElement("dialog"); dialog.id = "featheral-central-wallet"; dialog.setAttribute("aria-label", "Wallet");
      dialog.style.cssText = "position:fixed;box-sizing:border-box;margin:0;bottom:auto;width:min(460px,calc(100% - 16px));padding:8px;border:1px solid var(--line,#8886);border-radius:18px;background:var(--panel,Canvas);color:var(--text,var(--txt,CanvasText));overflow:auto;overscroll-behavior:contain;transform-origin:top right";
      const close = document.createElement("button"); close.type = "button"; close.textContent = "Close wallet";
      close.style.cssText = "position:sticky;top:0;z-index:2;display:block;margin-left:auto;min-height:44px;padding:8px 16px;font:inherit;color:inherit;background:var(--panel,Canvas);border:1px solid var(--line,#8886);border-radius:10px";
      close.addEventListener("click", () => dialog.close());
      const root = document.createElement("div"); root.dataset.walletRoot = "true"; dialog.append(close, root);
      dialog.addEventListener("close", () => {
        if (dialog.open) return;
        paint();
        const entry = mounts.get(root);
        if (authorization?.entry === entry) authorization.finish(new Error("Wallet connection cancelled."));
        entry?.ready.then(app => app.suspend()).catch(error => console.error("Wallet close:", error));
      });
      document.body.append(dialog);
    }
    position(dialog);
    if (!dialog.open) dialog.showModal();
    paint();
    const root = dialog.querySelector("[data-wallet-root]");
    const ready = mount(root, options), entry = mounts.get(root);
    ready.then(async app => {
      if (mounts.get(root) !== entry || entry.closed) return;
      applyTheme(entry.context.body);
      app.tab(options.view || "assets");
      if (entry.opened) await app.resume();
      entry.opened = true;
    }).catch(error => console.error("Open wallet:", error));
    return dialog;
  }
  function authorize(challenge, selectOnly) {
    if (authorization) return Promise.reject(new Error("Finish the existing wallet connection first."));
    if (!selectOnly && typeof challenge !== "function") return Promise.reject(new Error("A site sign-in challenge is required."));
    const dialog = open({ view: "account" }), entry = mounts.get(dialog.querySelector("[data-wallet-root]"));
    return new Promise((resolve, reject) => {
      const pending = { entry, challenge, selectOnly, address: null, finish(error, result) {
        if (authorization !== pending) return;
        clearTimeout(pending.timer); authorization = null;
        entry.context.receive?.({ type: "featheral:wallet-auth-cancel", nonce: entry.nonce });
        if (error) { console.error("Wallet connection:", error); reject(error); }
        else { select(result.address).catch(error => console.error("Wallet selection:", error)); dialog.close(); resolve(result); }
      } };
      authorization = pending;
      pending.timer = setTimeout(() => pending.finish(new Error("Wallet connection expired. Try again.")), 600000);
      entry.ready.then(() => {
        if (authorization === pending) entry.context.receive({ type: "featheral:wallet-auth-start", nonce: entry.nonce });
      }).catch(error => pending.finish(error));
    });
  }
  function apply() {
    for (const [root, entry] of mounts) if (!root.isConnected) {
      entry.closed = true; mounts.delete(root);
      if (authorization?.entry === entry) authorization.finish(new Error("Wallet context closed."));
      entry.ready.then(app => app.suspend().catch(error => console.error("Wallet lock:", error)).finally(() => app.dispose())).catch(error => console.error("Wallet cleanup:", error));
    }
    for (const root of document.querySelectorAll("[data-wallet-embed]")) if (!root.dataset.walletMounted) mount(root, {
      primary: root.dataset.walletPrimary, view: root.dataset.walletView, compact: root.dataset.walletCompact === "true",
      address: root.dataset.walletAddress, followActive: root.dataset.walletAddress ? false : true, payment: root.dataset.walletPayment,
    }).catch(error => console.error("Wallet mount:", error));
    const header = document.querySelector("body > header, #app > header, header.topbar");
    if (!header || site === "wallet" || site === "admin" || header.hasAttribute("data-no-central-wallet")) return;
    let buttons = [...header.querySelectorAll("[data-central-wallet], .wallet-icon, #wallet")];
    if (!buttons.length) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.centralWallet = "true"; header.append(button); buttons = [button];
    }
    for (const button of buttons) {
      const primary = button.dataset.walletPrimary || defaultPrimary;
      if (button.dataset.walletSigner === "true") continue;
      header.dataset.walletHeader = primary; button.classList.add("central-wallet-button"); headerButtons.set(button, primary); paint();
      if (selectedPublicAddress) select(selectedPublicAddress).catch(error => console.error("Wallet selection:", error));
      if (!button.dataset.walletBound && site !== "x") {
        button.dataset.walletBound = "true";
        button.addEventListener("click", event => { event.preventDefault(); event.stopImmediatePropagation(); anchorButton = button; open({ primary, compact: true }); }, true);
      }
      if (!button.dataset.walletAnchorBound) {
        button.dataset.walletAnchorBound = "true";
        button.addEventListener("pointerdown", () => { anchorButton = button; });
      }
    }
    for (const link of header.querySelectorAll("[data-wallet-view]")) if (!link.dataset.walletBound) {
      link.dataset.walletBound = "true";
      link.addEventListener("click", event => { event.preventDefault(); open({ primary, view: link.dataset.walletView, compact: true }); });
    }
  }
  window.addEventListener("storage", event => {
    if (![selectionKey, null].includes(event.key)) return;
    try {
      const address = localStorage.getItem(selectionKey);
      if (address && !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Invalid saved wallet selection.");
      selectedPublicAddress = address; connectionState = address ? "selected" : "disconnected"; avatarAccount = null; avatarUrl = null; paint();
    }
    catch (error) { console.error("Wallet selection:", error); }
  });
  const reposition = () => {
    const dialog = document.getElementById("featheral-central-wallet");
    if (dialog?.open) position(dialog);
  };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, { passive: true });
  window.visualViewport?.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("scroll", reposition);
  window.addEventListener("focus", apply);
  document.addEventListener("featheral:site-ready", apply);
  window.FeatheralWallet = { mount, open, apply, authenticate: challenge => authorize(challenge, false),
    account: () => authorize(null, true), connect: options => open({ ...options, view: "account" }) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
