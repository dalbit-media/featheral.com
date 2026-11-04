"use strict";
(() => {
  const script = document.currentScript;
  const walletOrigin = new URL(script.src).origin;
  const site = location.hostname.split(".")[0];
  const defaultPrimary = ["gold", "foundation", "featheral", "localhost"].includes(site) ? "FTHG" : site === "silver" ? "FTHS" : ["world", "dollar"].includes(site) ? "FTH$" : "FTHX";
  const frames = new Set();
  const frameStates = new WeakMap();
  const rootFrames = new WeakMap();
  const headerButtons = new Map();
  let avatarAccount, avatarUrl, avatarError = "";
  let authorization, selectedPublicAddress;
  const selectionKey = "featheral-wallet-public-account";
  try {
    const saved = window.localStorage?.getItem(selectionKey);
    if (/^0x[0-9a-f]{40}$/i.test(saved || "")) selectedPublicAddress = saved;
  } catch (error) { console.error("Site wallet selection unavailable:", error); }
  function renderHeaderButton(button, primary) {
    const icon = document.createElement("span");
    icon.className = "central-wallet-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h5M7 5V3h10v2"/></svg>';
    const label = document.createElement("span");
    label.className = "central-wallet-label";
    label.textContent = selectedPublicAddress ? `..${selectedPublicAddress.slice(-5)}` : "Wallet";
    const children = [icon];
    if (selectedPublicAddress) {
      const avatar = document.createElement("span");
      avatar.className = "central-wallet-avatar";
      avatar.setAttribute("aria-hidden", "true");
      if (avatarUrl) {
        const image = document.createElement("img");
        image.src = avatarUrl; image.alt = ""; image.width = image.height = 20;
        avatar.append(image);
      } else {
        avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
      }
      children.push(avatar);
    }
    button.replaceChildren(...children, label);
    const description = `Open ${primary} wallet${selectedPublicAddress ? ` · ${selectedPublicAddress}` : ""}${avatarError ? " · Avatar unavailable" : ""}`;
    button.setAttribute("aria-label", description);
    button.title = description;
    button.dataset.walletState = selectedPublicAddress ? "selected" : "disconnected";
  }
  function renderHeaderButtons() {
    for (const [button, primary] of headerButtons) renderHeaderButton(button, primary);
  }
  async function loadPublicAvatar() {
    const address = selectedPublicAddress;
    if (!headerButtons.size || !address || avatarAccount?.toLowerCase() === address.toLowerCase()) return;
    avatarAccount = address; avatarUrl = null; avatarError = "";
    renderHeaderButtons();
    try {
      const response = await fetch(`/api/v1/notes/profiles/${address}`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Wallet avatar HTTP ${response.status}`);
      const { profile } = await response.json();
      const avatar = profile?.avatar;
      if (avatar && (typeof avatar !== "string" || avatar.length > 56000
        || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)))
        throw new Error("Invalid wallet avatar.");
      if (selectedPublicAddress?.toLowerCase() !== address.toLowerCase()) return;
      avatarUrl = avatar || null;
    } catch (error) {
      console.error("Site wallet avatar unavailable:", error);
      if (selectedPublicAddress?.toLowerCase() !== address.toLowerCase()) return;
      avatarError = error.message;
    }
    renderHeaderButtons();
  }
  function selectPublicAccount(address) {
    if (selectedPublicAddress?.toLowerCase() === address.toLowerCase()) return;
    selectedPublicAddress = address;
    loadPublicAvatar();
    try { window.localStorage?.setItem(selectionKey, address); }
    catch (error) { console.error("Site wallet selection could not be saved:", error); }
    for (const frame of frames) {
      if (!frame.isConnected || frame.dataset.walletFollowActive !== "true") continue;
      frame.contentWindow?.postMessage({ type: "featheral:wallet-selection", address }, walletOrigin);
    }
  }
  function connect(options = {}) {
    open({ ...options, view: "account" });
  }
  function authenticate(challenge) {
    return authorize(challenge, false);
  }
  function account() {
    return authorize(null, true);
  }
  function authorize(challenge, selectOnly) {
    if (authorization) return Promise.reject(new Error("Finish the existing wallet connection first."));
    if (!selectOnly && typeof challenge !== "function") return Promise.reject(new Error("A site sign-in challenge is required."));
    const nonce = [...window.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    open({ view: "account" });
    const frame = document.getElementById("featheral-central-wallet").querySelector("iframe");
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearInterval(pending.timer); window.removeEventListener("message", receive);
        authorization = null;
        if (error) frame.contentWindow?.postMessage({ type: "featheral:wallet-auth-cancel", nonce }, walletOrigin);
        if (error) reject(error);
        else {
          selectPublicAccount(result.address);
          resolve(result);
        }
      };
      const pending = { frame, nonce, address: null, started: Date.now(),
        cancel: () => finish(new Error("Wallet was reloaded or could not start. Retry the connection.")) };
      authorization = pending;
      async function receive(event) {
        if (event.origin !== walletOrigin || event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
        try {
          if (event.data.type === "featheral:wallet-auth-ready") {
            if (pending.address) return;
            if (event.data.error) throw new Error(event.data.error);
            const address = event.data.address;
            if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) throw new Error("Invalid central wallet account.");
            pending.address = address;
            if (selectOnly) {
              frame.contentWindow.postMessage({ type: "featheral:wallet-auth-cancel", nonce }, walletOrigin);
              finish(null, { address });
              return;
            }
            const request = await challenge(address);
            if (authorization !== pending) return;
            if (typeof request?.message !== "string") throw new Error("Site sign-in challenge unavailable.");
            frame.contentWindow.postMessage({ type: "featheral:wallet-auth", nonce, address, message: request.message }, walletOrigin);
          } else if (event.data.type === "featheral:wallet-signature") {
            if (event.data.error) throw new Error(event.data.error);
            if (!pending.address || event.data.address?.toLowerCase() !== pending.address.toLowerCase()
              || !/^0x[0-9a-fA-F]{130}$/.test(event.data.signature || "")) throw new Error("Invalid wallet sign-in response.");
            finish(null, { address: pending.address, signature: event.data.signature });
          }
        } catch (error) { if (authorization === pending) finish(error); }
      }
      window.addEventListener("message", receive);
      frame.contentWindow?.postMessage({ type: "featheral:wallet-auth-start", nonce }, walletOrigin);
      pending.timer = setInterval(() => {
        if (!document.getElementById("featheral-central-wallet")?.open || Date.now() - pending.started > 600000)
          finish(new Error("Wallet connection cancelled or expired. Try again."));
      }, 500);
    });
  }
  function hostTheme() {
    if (!window.getComputedStyle) return null;
    const style = window.getComputedStyle(document.body);
    const variable = (...names) => names.map(name => style.getPropertyValue(name).trim()).find(Boolean);
    // Some light sites paint only <html>, leaving <body> transparent.
    const opaque = color => color && !/^(?:transparent|rgba\([^)]*,\s*0\))$/i.test(color.trim()) ? color : "";
    const surface = opaque(style.backgroundColor)
      || (document.documentElement ? opaque(window.getComputedStyle(document.documentElement).backgroundColor) : "");
    const light = /light/.test(style.colorScheme || "") && !/dark/.test(style.colorScheme || "");
    return { accent: variable("--brand", "--gold"), background: variable("--bg") || surface,
      panel: variable("--panel") || surface, text: variable("--text", "--txt") || style.color,
      muted: variable("--muted", "--mut") || (light ? "#5f6475" : undefined), line: variable("--line") || (light ? "#0000001f" : undefined),
      button: variable("--btn", "--panel") || (light ? surface : undefined),
      onAccent: variable("--on-accent"), scheme: style.colorScheme };
  }
  function sendTheme(frame) {
    const theme = hostTheme();
    frame.contentWindow?.postMessage({ type: "featheral:wallet-theme", theme: theme || {} }, walletOrigin);
  }
  const boundProviders = new WeakSet();
  const announcedProviders = new Map();
  let chosenProvider;
  function providerChoices() {
    if (announcedProviders.size) return [...announcedProviders].map(([provider, name]) => ({ provider, name }));
    return [...new Set(window.ethereum?.providers || [window.ethereum])].filter(provider => typeof provider?.request === "function")
      .map(provider => ({ provider, name: provider.isMetaMask ? "MetaMask" : provider.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet" }));
  }
  function browserProvider() {
    const choices = providerChoices();
    const provider = chosenProvider || window.FeatheralProfile?.getProvider?.() || (choices.length === 1 ? choices[0].provider : null);
    if (provider && !boundProviders.has(provider)) {
      boundProviders.add(provider);
      provider.on?.("accountsChanged", accounts => {
        if (browserProvider() !== provider) return;
        for (const frame of frames) if (frame.isConnected && frame.dataset.walletFollowActive === "true")
          frame.contentWindow?.postMessage({ type: "featheral:wallet-provider-event", name: "accountsChanged", accounts }, walletOrigin);
      });
    }
    return provider;
  }
  function updateProviderChoices(notify = true) {
    const choices = providerChoices(), selected = browserProvider();
    const picker = document.getElementById("featheral-wallet-provider");
    if (picker) {
      picker.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose browser wallet";
      picker.append(placeholder);
      choices.forEach((choice, index) => {
        const option = document.createElement("option"); option.value = String(index); option.textContent = choice.name;
        picker.append(option);
      });
      picker.value = String(choices.findIndex(choice => choice.provider === selected));
      picker.hidden = choices.length < 2;
    }
    if (notify) for (const frame of frames) if (frame.isConnected)
      frame.contentWindow?.postMessage({ type: "featheral:wallet-provider-status", available: choices.length > 0 || !!selected }, walletOrigin);
  }
  window.addEventListener?.("eip6963:announceProvider", event => {
    if (typeof event.detail?.provider?.request !== "function") return;
    announcedProviders.set(event.detail.provider, String(event.detail.info?.name || "Browser wallet").slice(0, 80));
    updateProviderChoices();
  });
  window.addEventListener?.("ethereum#initialized", updateProviderChoices);
  if (window.dispatchEvent && typeof Event !== "undefined") window.dispatchEvent(new Event("eip6963:requestProvider"));
  function frameFailed(frame, message) {
    const state = frameStates.get(frame);
    if (!state) return;
    clearTimeout(state.timer);
    frame.style.visibility = "hidden";
    frame.setAttribute("aria-hidden", "true");
    state.root.setAttribute("aria-busy", "false");
    state.status.hidden = false;
    state.message.textContent = message;
    state.retry.hidden = false;
    if (authorization?.frame === frame) authorization.cancel();
  }
  const providerBusy = new Set();
  window.addEventListener?.("message", async event => {
    if (event.origin !== walletOrigin) return;
    const frame = [...frames].find(frame => frame.isConnected && frame.contentWindow === event.source);
    if (!frame) return;
    if (event.data?.type === "featheral:wallet-error") {
      frameFailed(frame, "Wallet could not load. Retry or open the full wallet in a new tab.");
      return;
    }
    if (event.data?.type === "featheral:wallet-themed") {
      const state = frameStates.get(frame);
      if (!state) return;
      clearTimeout(state.timer);
      frame.style.visibility = "visible";
      frame.setAttribute("aria-hidden", "false");
      state.status.hidden = true;
      state.root.setAttribute("aria-busy", "false");
      return;
    }
    if (event.data?.type === "featheral:wallet-provider") {
      if (frame.dataset.walletFollowActive !== "true" || typeof event.data.id !== "string" || event.data.id.length > 100) return;
      const id = event.data.id, request = event.data.request;
      if (providerBusy.has(frame)) {
        event.source.postMessage({ type: "featheral:wallet-provider-result", id, error: "Finish the pending wallet approval first." }, walletOrigin);
        return;
      }
      providerBusy.add(frame);
      try {
        const provider = browserProvider();
        if (!request || !["eth_accounts", "eth_requestAccounts", "personal_sign"].includes(request.method))
          throw new Error("Unsupported site wallet provider method.");
        if (!provider?.request) {
          if (providerChoices().length > 1 && request.method === "eth_accounts" && request.params === undefined) {
            event.source.postMessage({ type: "featheral:wallet-provider-result", id, result: [] }, walletOrigin);
            return;
          }
          throw new Error(providerChoices().length > 1 ? "Choose your browser wallet at the top of this panel, then retry."
            : "No browser wallet is available. Create or restore a built-in wallet in Account, or open the full wallet.");
        }
        if (request.method === "personal_sign") {
          if (!Array.isArray(request.params) || request.params.length !== 2
            || !/^0x[0-9a-f]{1,32768}$/i.test(request.params[0] || "")
            || !/^0x[0-9a-f]{40}$/i.test(request.params[1] || ""))
            throw new Error("Invalid wallet signature request.");
          const accounts = await provider.request({ method: "eth_accounts" });
          if (accounts[0]?.toLowerCase() !== request.params[1].toLowerCase())
            throw new Error("Wallet account changed. Reconnect in the site panel.");
        } else if (request.params !== undefined) throw new Error("Unexpected account request parameters.");
        const result = await provider.request({ method: request.method, ...(request.method === "personal_sign" ? { params: request.params } : {}) });
        if (provider !== browserProvider()) throw new Error("Wallet provider changed. Reconnect in the site panel.");
        if (request.method === "personal_sign") {
          const accounts = await provider.request({ method: "eth_accounts" });
          if (accounts[0]?.toLowerCase() !== request.params[1].toLowerCase())
            throw new Error("Wallet account changed. Reconnect in the site panel.");
        }
        event.source.postMessage({ type: "featheral:wallet-provider-result", id, result }, walletOrigin);
      } catch (error) {
        console.error("Site wallet provider:", error);
        event.source.postMessage({ type: "featheral:wallet-provider-result", id, error: error.message,
          ...(Number.isInteger(error.code) ? { code: error.code } : {}) }, walletOrigin);
      } finally { providerBusy.delete(frame); }
      return;
    }
    if (event.data?.type === "featheral:wallet-selected") {
      if (frame.dataset.walletFollowActive !== "true") return;
      if (!/^0x[0-9a-fA-F]{40}$/.test(event.data.address || "")) return;
      selectPublicAccount(event.data.address);
      return;
    }
    if (event.data?.type !== "featheral:wallet-ready") return;
    for (const frame of frames) {
      if (!frame.isConnected) frames.delete(frame);
      else if (frame.contentWindow === event.source) {
        sendTheme(frame);
        frame.contentWindow.postMessage({ type: "featheral:wallet-provider-status", available: providerChoices().length > 0 || !!browserProvider()?.request }, walletOrigin);
        if (authorization?.frame === frame)
          frame.contentWindow.postMessage({ type: "featheral:wallet-auth-start", nonce: authorization.nonce }, walletOrigin);
        if (selectedPublicAddress && frame.dataset.walletFollowActive === "true")
          frame.contentWindow.postMessage({ type: "featheral:wallet-selection", address: selectedPublicAddress }, walletOrigin);
        frame.contentWindow.postMessage({ type: "featheral:wallet-updated" }, walletOrigin);
      }
    }
  });
  function mount(root, options = {}) {
    if (root.dataset.walletMounted) return;
    const previous = rootFrames.get(root);
    if (previous) {
      clearTimeout(frameStates.get(previous)?.timer); frames.delete(previous);
      if (authorization?.frame === previous) authorization.cancel();
    }
    root.dataset.walletMounted = "true";
    const primary = options.primary || defaultPrimary, view = options.view || "assets";
    if (!["FTHG", "FTH$", "FTHX", "FTHS"].includes(primary) || !["assets", "send", "receive", "swap", "tip", "activity", "account"].includes(view))
      throw new Error("Unsupported wallet embed options.");
    const url = new URL("/", walletOrigin);
    const followActive = options.followActive || !options.address;
    url.search = new URLSearchParams({ embedded: "1", parentOrigin: location.origin, primary, view,
      compact: options.compact ? "1" : "0", followActive: followActive ? "1" : "0" });
    const address = followActive && selectedPublicAddress || options.address;
    if (address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid public wallet address.");
      url.searchParams.set("address", address);
    }
    const frame = document.createElement("iframe");
    rootFrames.set(root, frame);
    frame.dataset.walletFollowActive = String(!!followActive);
    frames.add(frame);
    frame.src = url.href; frame.title = `Featheral ${primary} wallet`;
    frame.referrerPolicy = "origin"; frame.loading = "eager";
    frame.style.cssText = "display:block;width:calc(100% + 36px);max-width:none;margin-left:-18px;height:100%;min-height:0;flex:1;border:0;background:var(--panel,#16161f);visibility:hidden";
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation");
    frame.setAttribute("allow", "clipboard-write");
    const link = document.createElement("a");
    url.searchParams.delete("embedded");
    if (followActive) {
      url.searchParams.delete("address");
      url.searchParams.set("followActive", "1");
    }
    link.href = url.href; link.target = "_blank"; link.rel = "noopener";
    link.textContent = "Open full wallet ↗";
    link.setAttribute("aria-label", "Open full wallet in a new tab");
    link.style.cssText = "align-self:center;color:inherit;opacity:.6;font:10px/1.6 system-ui,sans-serif;margin-top:4px";
    const status = document.createElement("div"), message = document.createElement("span"), retry = document.createElement("button");
    status.setAttribute("role", "status");
    status.style.cssText = "position:absolute;inset:40px 18px auto;padding:24px 12px;text-align:center;font:13px/1.6 system-ui,sans-serif;color:inherit";
    message.textContent = "Loading wallet...";
    retry.type = "button"; retry.textContent = "Retry wallet"; retry.hidden = true;
    retry.style.cssText = "margin:12px auto;padding:8px 12px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;cursor:pointer";
    retry.addEventListener("click", () => {
      clearTimeout(frameStates.get(frame)?.timer);
      frames.delete(frame); delete root.dataset.walletMounted; mount(root, options);
    });
    status.append(message, retry);
    root.style.position = "relative";
    root.setAttribute("aria-busy", "true");
    const timer = setTimeout(() => frameFailed(frame, "Wallet is taking longer than expected. Retry or open the full wallet."), 20000);
    frameStates.set(frame, { root, status, message, retry, timer });
    frame.addEventListener("error", () => frameFailed(frame, "Wallet could not load. Retry or open the full wallet."));
    root.replaceChildren(frame, status, link);
  }
  function open(options = {}) {
    options = { ...options, followActive: options.followActive !== false };
    const primary = options.primary || defaultPrimary;
    let dialog = document.getElementById("featheral-central-wallet");
    if (!dialog) {
      dialog = document.createElement("dialog"); dialog.id = "featheral-central-wallet";
      dialog.setAttribute("aria-label", "Featheral wallet");
      const heading = document.createElement("div"); heading.dataset.walletHeading = "true";
      const title = document.createElement("b");
      const picker = document.createElement("select"); picker.id = "featheral-wallet-provider";
      picker.setAttribute("aria-label", "Browser wallet provider");
      picker.style.cssText = "max-width:180px;min-width:0;font:12px system-ui;padding:5px;border:1px solid var(--line,#262633);border-radius:6px;background:inherit;color:inherit";
      picker.addEventListener("change", () => {
        const choices = providerChoices();
        if (!/^\d+$/.test(picker.value) || !choices[+picker.value]) return;
        chosenProvider = choices[+picker.value].provider;
        browserProvider();
        for (const frame of frames) if (frame.isConnected && frame.dataset.walletFollowActive === "true")
          frame.contentWindow?.postMessage({ type: "featheral:wallet-provider-event", name: "accountsChanged", accounts: [] }, walletOrigin);
        updateProviderChoices();
      });
      const close = document.createElement("button"); close.type = "button"; close.textContent = "\u00d7";
      close.setAttribute("aria-label", "Close wallet");
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); dialog.close(); }
      });
      dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
      });
      heading.append(title, picker, close);
      const root = document.createElement("div"); mount(root, options);
      root.dataset.walletRoot = "true";
      dialog.append(heading, root); document.body.append(dialog);
    } else {
      const root = dialog.querySelector("[data-wallet-root]");
      const frame = root.querySelector("iframe"), target = new URL(frame.src);
      if (target.searchParams.get("primary") !== primary || options.address && !options.followActive
        && target.searchParams.get("address") !== options.address) {
        delete root.dataset.walletMounted; mount(root, options);
      } else frame.contentWindow?.postMessage({ type: "featheral:wallet-view", view: options.view || "assets" }, walletOrigin);
    }
    dialog.dataset.walletPrimary = primary;
    dialog.style.cssText = "position:fixed;inset:64px 12px auto auto;margin:0;width:min(380px,calc(100% - 24px));max-width:none;height:min(800px,calc(100dvh - 80px));max-height:calc(100dvh - 80px);box-sizing:border-box;padding:12px 18px;border:1px solid var(--line,#262633);border-radius:14px;background:var(--panel,#16161f);color:var(--text,var(--txt,#f4f4f7));box-shadow:0 18px 50px #0008;overflow:hidden";
    {
      // Hosts without --panel/--line variables (e.g. light Notes) still get a shell matching their page.
      const theme = hostTheme();
      if (theme?.panel) dialog.style.background = theme.panel;
      if (theme?.text) dialog.style.color = theme.text;
      if (theme?.scheme === "light") {
        dialog.style.boxShadow = "0 18px 50px #0002";
        if (!theme.line) dialog.style.borderColor = "#0000001f";
      }
      const frame = dialog.querySelector("iframe");
      if (frame && theme?.panel) frame.style.background = theme.panel;
    }
    const heading = dialog.querySelector("[data-wallet-heading]"), root = dialog.querySelector("[data-wallet-root]");
    heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;font:14px/1.5 system-ui,sans-serif";
    heading.querySelector("b").textContent = "Wallet";
    heading.querySelector("button").title = "Close wallet";
    heading.querySelector("button").style.cssText = "display:grid;place-items:center;box-sizing:border-box;width:28px;height:28px;min-width:28px;min-height:28px;padding:0;border:1px solid var(--line,#262633);border-radius:5px;background:transparent;color:inherit;font:18px/1 system-ui,sans-serif;cursor:pointer";
    root.style.cssText = "position:relative;display:flex;flex-direction:column;height:calc(100% - 28px);min-height:0";
    {
      const trigger = document.querySelector("header .central-wallet-button");
      if (trigger) {
        const top = Math.max(64, Math.ceil(trigger.getBoundingClientRect().bottom + 8));
        dialog.style.top = `${top}px`;
        dialog.style.height = `min(800px,calc(100dvh - ${top + 16}px))`;
        dialog.style.maxHeight = `calc(100dvh - ${top + 16}px)`;
      }
    }
    if (!dialog.open) dialog.showModal();
    updateProviderChoices(false);
  }
  function apply() {
    for (const root of document.querySelectorAll("[data-wallet-embed]")) mount(root, {
      primary: root.dataset.walletPrimary, view: root.dataset.walletView, compact: root.dataset.walletCompact === "true",
      address: root.dataset.walletAddress,
    });
    const header = document.querySelector("body > header, #app > header, header.topbar");
    if (header && !["x.featheral.com", "x.localhost"].includes(location.hostname) && !location.hostname.startsWith("admin.") && !header.hasAttribute("data-no-central-wallet")) {
      let button = header.querySelector("[data-central-wallet]") || header.querySelector(".wallet-icon, #wallet");
      if (!button) {
        button = document.createElement("button"); button.type = "button"; button.dataset.centralWallet = "true";
        button.textContent = "Wallet"; header.append(button);
      }
      const primary = ["FTHG", "FTH$", "FTHX", "FTHS"].includes(button.dataset.walletPrimary) ? button.dataset.walletPrimary : defaultPrimary;
      if (button.dataset.walletSigner !== "true") {
        header.dataset.walletHeader = primary;
        button.classList.add("central-wallet-button");
        headerButtons.set(button, primary);
        renderHeaderButton(button, primary);
        loadPublicAvatar();
      }
      if (button.dataset.walletSigner !== "true" && !button.dataset.walletBound) {
        button.dataset.walletBound = "true";
        button.addEventListener("click", event => {
          if (button.dataset.walletSigner === "true") return;
          event.preventDefault(); event.stopImmediatePropagation();
          open({ primary, compact: true });
        }, true);
      }
      for (const link of header.querySelectorAll("[data-wallet-view]")) {
        if (link.dataset.walletBound) continue;
        link.dataset.walletBound = "true";
        link.addEventListener("click", event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); open({ primary, view: link.dataset.walletView, compact: true, address: button.dataset.walletAddress });
        });
      }
    }
  }
  window.FeatheralWallet = { mount, open, apply, authenticate, account, connect };
  browserProvider();
  if (window.MutationObserver) {
    const observer = new window.MutationObserver(() => {
      for (const frame of frames) { if (frame.isConnected) sendTheme(frame); else frames.delete(frame); }
    });
    const observe = () => {
      for (const target of [document.documentElement, document.body]) observer.observe(target, {
        attributes: true, attributeFilter: ["class", "style", "data-theme", "data-site-brand"],
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe); else observe();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
