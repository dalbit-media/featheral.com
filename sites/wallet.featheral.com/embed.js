"use strict";
(() => {
  const walletOrigin = new URL(document.currentScript.src).origin;
  const site = location.hostname.split(".")[0];
  const defaultPrimary = ["gold", "foundation", "featheral", "localhost"].includes(site) ? "FTHG" : site === "silver" ? "FTHS" : ["world", "dollar", "pay"].includes(site) ? "FTH$" : "FTHX";
  const headerButtons = new Map(), previews = new Map(), walletWindows = new Map();
  const selectionKey = "featheral-wallet-public-account";
  let authorization, selectedPublicAddress, avatarAccount, avatarUrl, avatarError = "";
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
    button.setAttribute("aria-label", description); button.title = description;
    button.dataset.walletState = selectedPublicAddress ? "selected" : "disconnected";
  }
  function renderHeaderButtons() {
    for (const [button, primary] of headerButtons) renderHeaderButton(button, primary);
  }
  async function loadPublicAvatar() {
    const address = selectedPublicAddress;
    if (!headerButtons.size || !address || avatarAccount?.toLowerCase() === address.toLowerCase()) return;
    avatarAccount = address; avatarUrl = null; avatarError = ""; renderHeaderButtons();
    try {
      const response = await fetch(`/api/v1/notes/profiles/${address}`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Wallet avatar HTTP ${response.status}`);
      const { profile } = await response.json(), avatar = profile?.avatar;
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
    try { window.localStorage?.setItem(selectionKey, address); }
    catch (error) { console.error("Site wallet selection could not be saved:", error); }
    renderHeaderButtons(); loadPublicAvatar();
    for (const [root, preview] of previews) if (root.isConnected && preview.followActive) preview.refresh();
  }
  function walletUrl(options = {}) {
    const primary = options.primary || defaultPrimary, view = options.view || "assets";
    if (!["FTHG", "FTH$", "FTHX", "FTHS"].includes(primary) || !["assets", "send", "receive", "swap", "tip", "activity", "account"].includes(view))
      throw new Error("Unsupported wallet options.");
    const followActive = options.followActive !== false && !options.address || options.followActive === true;
    const url = new URL("/", walletOrigin);
    url.search = new URLSearchParams({ parentOrigin: location.origin, primary, view, followActive: followActive ? "1" : "0" });
    if (options.mode) url.searchParams.set("mode", options.mode);
    if (!followActive && options.address) {
      if (!/^0x[0-9a-f]{40}$/i.test(options.address)) throw new Error("Invalid public wallet address.");
      url.searchParams.set("address", options.address);
    }
    if (options.payment) for (const [key, value] of new URLSearchParams(options.payment)) {
      if (!["to", "amount", "name", "currency"].includes(key)) throw new Error("Unsupported payment request field.");
      url.searchParams.append(key, value);
    }
    return url;
  }
  function launch(options = {}) {
    const url = walletUrl(options);
    const followActive = url.searchParams.get("followActive") === "1";
    const nonce = [...window.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (followActive) url.searchParams.set("selectionNonce", nonce);
    const popup = window.open(url.href, "_blank");
    if (!popup) throw new Error("Allow wallet popups, or use the Open full wallet link.");
    if (followActive) walletWindows.set(popup, nonce);
    else popup.opener = null;
    return popup;
  }
  function authorize(challenge, selectOnly) {
    if (authorization) return Promise.reject(new Error("Finish the existing wallet connection first."));
    if (!selectOnly && typeof challenge !== "function") return Promise.reject(new Error("A site sign-in challenge is required."));
    const nonce = [...window.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const url = walletUrl({ view: "account", followActive: true });
    url.searchParams.set("authNonce", nonce);
    // This window retains its opener only for the bounded, public-address/signature handoff.
    const popup = window.open(url.href, "_blank", "popup,width=560,height=820");
    if (!popup) return Promise.reject(new Error("Wallet popup blocked. Allow popups for this site and retry connecting."));
    return new Promise((resolve, reject) => {
      const pending = { popup, nonce, address: null, started: Date.now(), finished: false };
      authorization = pending;
      function finish(error, result) {
        if (pending.finished) return;
        pending.finished = true; clearInterval(pending.timer);
        window.removeEventListener("message", receive); authorization = null;
        popup.postMessage({ type: "featheral:wallet-auth-cancel", nonce }, walletOrigin);
        if (error) { console.error("Wallet connection:", error); reject(error); }
        else { selectPublicAccount(result.address); popup.close(); resolve(result); }
      }
      async function receive(event) {
        if (event.origin !== walletOrigin || event.source !== popup) return;
        try {
          if (event.data?.type === "featheral:wallet-ready") {
            popup.postMessage({ type: "featheral:wallet-auth-start", nonce }, walletOrigin);
            return;
          }
          if (event.data?.nonce !== nonce) return;
          if (event.data.type === "featheral:wallet-signature" && event.data.error) throw new Error(event.data.error);
          if (event.data.type === "featheral:wallet-auth-ready") {
            if (pending.address) return;
            if (event.data.error) throw new Error(event.data.error);
            const address = event.data.address;
            if (!/^0x[0-9a-f]{40}$/i.test(address || "")) throw new Error("Invalid central wallet account.");
            pending.address = address;
            if (selectOnly) { finish(null, { address }); return; }
            const request = await challenge(address);
            if (authorization !== pending) return;
            if (typeof request?.message !== "string") throw new Error("Site sign-in challenge unavailable.");
            popup.postMessage({ type: "featheral:wallet-auth", nonce, address, message: request.message }, walletOrigin);
          } else if (event.data.type === "featheral:wallet-signature") {
            if (!pending.address || event.data.address?.toLowerCase() !== pending.address.toLowerCase()
              || !/^0x[0-9a-f]{130}$/i.test(event.data.signature || "")) throw new Error("Invalid wallet sign-in response.");
            finish(null, { address: pending.address, signature: event.data.signature });
          }
        } catch (error) { if (authorization === pending) finish(error); }
      }
      window.addEventListener("message", receive);
      pending.timer = setInterval(() => {
        if (popup.closed || Date.now() - pending.started > 600000) finish(new Error("Wallet connection cancelled or expired. Try again."));
      }, 500);
    });
  }
  function authenticate(challenge) { return authorize(challenge, false); }
  function account() { return authorize(null, true); }
  function connect(options = {}) { return open({ ...options, view: "account" }); }
  function mount(root, options = {}) {
    const url = walletUrl(options), primary = url.searchParams.get("primary");
    const followActive = url.searchParams.get("followActive") === "1";
    const heading = document.createElement("h2"), balance = document.createElement("p");
    const addressLabel = document.createElement("p"), message = document.createElement("p");
    const link = document.createElement("a");
    heading.textContent = `${primary} wallet`;
    link.href = url.href; link.target = "_blank"; link.rel = "noopener";
    link.textContent = "Open full wallet";
    link.style.cssText = "display:inline-block;padding:12px 18px;border:1px solid currentColor;border-radius:12px;font-weight:650";
    message.setAttribute("role", "status");
    root.style.cssText = "padding:20px;overflow:auto;overflow-wrap:anywhere";
    root.dataset.walletMounted = "true";
    root.replaceChildren(heading, balance, addressLabel, message, link);
    let revision = 0;
    async function refresh() {
      const current = ++revision, address = followActive ? selectedPublicAddress : options.address;
      addressLabel.textContent = address || "Not connected";
      balance.textContent = "Balance unavailable";
      message.textContent = address ? "Loading public balances..." : "Connect in the full wallet. Keys and signing stay on the wallet site.";
      if (!address) return;
      try {
        const response = await fetch(`${walletOrigin}/api/wallet/accounts/${address}`, { credentials: "omit", cache: "no-store" });
        if (!response.ok) throw new Error(`Wallet balances unavailable (HTTP ${response.status}).`);
        const summary = await response.json();
        if (summary.address?.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet summary account mismatch.");
        if (current !== revision) return;
        balance.textContent = summary.portfolio?.usd ? `Estimated total: $${summary.portfolio.usd} USD` : "USD estimate unavailable";
        message.textContent = summary.portfolio?.partial ? "Partial estimate. Open the full wallet for source details." : "Public preview only. Transfers and approvals open the full wallet.";
      } catch (error) {
        console.error("Public wallet preview:", error);
        if (current === revision) message.textContent = error.message;
      }
    }
    previews.set(root, { followActive, refresh }); refresh();
  }
  function open(options = {}) {
    options = { ...options, followActive: options.followActive !== false };
    let dialog = document.getElementById("featheral-central-wallet");
    if (!dialog) {
      dialog = document.createElement("dialog"); dialog.id = "featheral-central-wallet";
      dialog.setAttribute("aria-label", "Wallet connection");
      document.body.append(dialog);
    }
    dialog.style.cssText = "margin:auto;width:min(460px,calc(100% - 24px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--line,#8886);border-radius:20px;background:var(--panel,Canvas);color:var(--text,var(--txt,CanvasText));box-shadow:0 18px 60px #0004;overflow:auto;font:14px/1.6 system-ui";
    const close = document.createElement("button"), title = document.createElement("h2");
    close.type = "button"; close.textContent = "Close"; close.setAttribute("aria-label", "Close wallet");
    close.addEventListener("click", () => dialog.close());
    title.textContent = "Your wallet, your choice";
    const description = document.createElement("p");
    description.textContent = "Use your browser extension, or a password-encrypted Featheral wallet. Signing opens the wallet site directly, never a frame.";
    const launchButton = document.createElement("button"), message = document.createElement("p");
    launchButton.type = "button";
    launchButton.textContent = "Open wallet";
    launchButton.style.cssText = "display:block;width:100%;min-height:48px;border-radius:12px;padding:12px;font:inherit;font-weight:650;cursor:pointer";
    launchButton.addEventListener("click", () => {
      try { launch(options); dialog.close(); }
      catch (error) { console.error("Open wallet:", error); message.textContent = error.message; }
    });
    message.setAttribute("role", "status");
    const previous = dialog.querySelector("[data-wallet-root]");
    if (previous) previews.delete(previous);
    const root = document.createElement("div"); root.dataset.walletRoot = "true";
    mount(root, options);
    dialog.replaceChildren(close, title, description, launchButton, message, root);
    if (!dialog.open) dialog.showModal();
    return dialog;
  }
  function apply() {
    for (const root of document.querySelectorAll("[data-wallet-embed]")) if (!root.dataset.walletMounted) mount(root, {
      primary: root.dataset.walletPrimary, view: root.dataset.walletView, compact: root.dataset.walletCompact === "true",
      address: root.dataset.walletAddress, payment: root.dataset.walletPayment,
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
        header.dataset.walletHeader = primary; button.classList.add("central-wallet-button");
        headerButtons.set(button, primary); renderHeaderButton(button, primary); loadPublicAvatar();
      }
      if (button.dataset.walletSigner !== "true" && !button.dataset.walletBound) {
        button.dataset.walletBound = "true";
        button.addEventListener("click", event => {
          if (button.dataset.walletSigner === "true") return;
          event.preventDefault(); event.stopImmediatePropagation(); open({ primary, compact: true });
        }, true);
      }
      for (const link of header.querySelectorAll("[data-wallet-view]")) {
        if (link.dataset.walletBound) continue;
        link.dataset.walletBound = "true";
        link.addEventListener("click", event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); open({ primary, view: link.dataset.walletView, compact: true });
        });
      }
    }
  }
  window.addEventListener("focus", () => {
    for (const popup of walletWindows.keys()) if (popup.closed) walletWindows.delete(popup);
    for (const [root, preview] of previews) {
      if (root.isConnected) preview.refresh(); else previews.delete(root);
    }
  });
  window.addEventListener("message", event => {
    if (event.origin !== walletOrigin || !walletWindows.has(event.source)
      || event.data?.nonce !== walletWindows.get(event.source) || event.data?.type !== "featheral:wallet-selected"
      || !/^0x[0-9a-f]{40}$/i.test(event.data.address || "")) return;
    selectPublicAccount(event.data.address);
  });
  window.addEventListener("storage", event => {
    if (event.key !== selectionKey && event.key !== null) return;
    try {
      const address = window.localStorage?.getItem(selectionKey);
      if (address && !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Invalid saved public wallet selection.");
      selectedPublicAddress = address || null; avatarAccount = null; avatarUrl = null;
      renderHeaderButtons(); loadPublicAvatar();
      for (const [root, preview] of previews) if (root.isConnected && preview.followActive) preview.refresh();
    } catch (error) { console.error("Public wallet selection:", error); }
  });
  window.FeatheralWallet = { mount, open, apply, authenticate, account, connect };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
