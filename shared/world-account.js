"use strict";
(() => {
  const local = location.hostname === "localhost" || location.hostname.endsWith(".localhost");
  const worldOrigin = `${local ? "http://world.localhost" : "https://world.featheral.com"}${local && location.port ? ":" + location.port : ""}`;
  const onWorld = location.hostname === "world.featheral.com" || location.hostname === "world.localhost" || location.hostname === "localhost";
  const endpoint = (onWorld ? "" : worldOrigin) + "/api/world-account";
  let current = null, signer = null, refreshing = null, signerTimer, signerExpires = 0, signerGeneration = 0, remoteWindow, signing = false;
  const unlockWait = 30 * 60000;
  function lock() {
    signer = null; signerExpires = 0; signerGeneration++; clearTimeout(signerTimer);
  }
  function touchSigner() {
    if (signer && Date.now() >= signerExpires) lock();
    clearTimeout(signerTimer);
    if (signer) { signerExpires = Date.now() + unlockWait; signerTimer = setTimeout(lock, unlockWait); }
  }
  function setSigner(value) {
    lock(); signer = value; signerExpires = Date.now() + unlockWait; touchSigner();
  }
  async function request(path, input) {
    if (path === "/logout") lock();
    const response = await fetch(endpoint + path, { method: input === undefined ? "GET" : "POST",
      credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
      ...(input === undefined ? {} : { headers: { "Content-Type": "application/json", "X-CSRF-Token": current?.csrf || "" }, body: JSON.stringify(input) }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `World account HTTP ${response.status}`), { status: response.status });
    return data;
  }
  async function readSession() {
    const url = new URL(location.href), handoff = !onWorld && url.searchParams.get("worldSignIn");
    let next = await request("/session" + (handoff ? "?handoff=" + encodeURIComponent(handoff) : ""));
    if (!onWorld) {
      if (handoff) {
        url.searchParams.delete("worldSignIn"); history.replaceState(null, "", url.href);
        sessionStorage.setItem("featheral-world-media-session", JSON.stringify(next));
      } else if (!next.account) {
        const raw = sessionStorage.getItem("featheral-world-media-session");
        if (raw) {
          let saved;
          try { saved = JSON.parse(raw); }
          catch (error) { sessionStorage.removeItem("featheral-world-media-session"); throw new Error("Saved World sign-in is invalid. Sign in again."); }
          if (!saved || typeof saved.csrf !== "string" || !/^[a-f0-9]{64}$/.test(saved.csrf) || typeof saved.account !== "string") {
            sessionStorage.removeItem("featheral-world-media-session");
            throw new Error("Saved World sign-in is invalid. Sign in again.");
          }
          const response = await fetch(endpoint + "/media-session", { method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: saved.csrf, account: saved.account }), signal: AbortSignal.timeout(10000) });
          const data = await response.json();
          if (response.status === 401) sessionStorage.removeItem("featheral-world-media-session");
          else if (!response.ok) throw new Error(data.error || "World sign-in is unavailable.");
          else next = data;
        }
      }
    }
    if (current?.account !== next.account || current?.csrf !== next.csrf) lock();
    current = next;
    if (window.FeatheralProfile) {
      window.FeatheralProfile.setWorldSession(next, next.account ? provider : null);
    }
    window.dispatchEvent(new CustomEvent("featheral:world-session", { detail: next }));
    return next;
  }
  function refresh() {
    if (!refreshing) refreshing = readSession().finally(() => { refreshing = null; });
    return refreshing;
  }
  function url(returnTo = location.href) {
    const destination = new URL("/login/", onWorld ? location.origin : worldOrigin);
    destination.searchParams.set("returnTo", returnTo);
    return destination.href;
  }
  async function signInWallet(address, signMessage) {
    if (!onWorld) throw new Error("Switch your World account on World.");
    if (!ethers.isAddress(address) || typeof signMessage !== "function") throw new Error("Choose a valid wallet.");
    if (refreshing) await refreshing;
    const challenge = await request("/challenge", { action: "sign-in", address });
    const signature = await signMessage(challenge.message);
    if (ethers.verifyMessage(challenge.message, signature).toLowerCase() !== address.toLowerCase())
      throw new Error("World signature does not match the requesting account.");
    await request("/wallet-login", { id: challenge.id, signature });
    if (refreshing) await refreshing;
    return refresh();
  }
  function remoteSign(message, account) {
    return new Promise((resolve, reject) => {
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
      const popupUrl = new URL("/account/", worldOrigin);
      popupUrl.searchParams.set("approve", nonce); popupUrl.searchParams.set("parentOrigin", location.origin);
      const popup = remoteWindow && !remoteWindow.closed ? remoteWindow : window.open(popupUrl.href, "featheral-world-sign", "popup,width=480,height=760");
      remoteWindow = popup;
      if (!popup) { reject(new Error("Allow the World sign-in popup to approve this action.")); return; }
      let timer, closedTimer, settled = false;
      const finish = (error, signature) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearInterval(closedTimer); window.removeEventListener("message", receive);
        if (error && !popup.closed) popup.postMessage({ type: "featheral:world-sign-cancel", nonce }, worldOrigin);
        if (error) reject(error); else resolve(signature);
      };
      const receive = event => {
        if (event.origin !== worldOrigin || event.source !== popup || event.data?.nonce !== nonce) return;
        if (event.data.type === "featheral:world-sign-ready")
          popup.postMessage({ type: "featheral:world-sign", nonce, message, account }, worldOrigin);
        if (event.data.type === "featheral:world-sign-result") {
          if (event.data.error) { finish(new Error(event.data.error)); return; }
          try {
            if (ethers.verifyMessage(message, event.data.signature).toLowerCase() !== account.toLowerCase())
              throw new Error("World signature does not match the requesting account.");
            finish(null, event.data.signature);
          } catch (error) { finish(error); }
        }
      };
      window.addEventListener("message", receive);
      popup.focus();
      popup.postMessage({ type: "featheral:world-sign-ping", nonce }, worldOrigin);
      timer = setTimeout(() => finish(new Error("World signature timed out. Retry.")), 180000);
      closedTimer = setInterval(() => { if (popup.closed) finish(new Error("World signature window was closed.")); }, 500);
    });
  }
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return current?.account ? [current.account] : [];
      if (method !== "personal_sign") throw new Error("World accounts support message signing only. Use the wallet for transfers.");
      if (signing) throw new Error("Finish the pending World signature first.");
      const [hex, account] = params;
      if (!current?.account || account.toLowerCase() !== current.account.toLowerCase()) throw new Error("World account changed. Sign in again.");
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > 128000) throw new Error("Invalid signature request.");
      const message = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(hex.slice(2).match(/../g), byte => parseInt(byte, 16)));
      signing = true;
      try {
        if (!onWorld) {
          const signature = await remoteSign(message, account);
          if (current?.account?.toLowerCase() !== account.toLowerCase()) throw new Error("World account changed while signing.");
          return signature;
        }
        if (!window.FeatheralWallet?.approveSignature) throw new Error("Web wallet is still loading. Retry shortly.");
        const sessionAccount = current.account, sessionToken = current.csrf;
        return await window.FeatheralWallet.approveSignature({
          message, account, origin: location.origin,
          cancel: () => { signerGeneration++; },
          lock,
          passwordRequired: () => {
            if (signer && Date.now() >= signerExpires) lock();
            return current?.walletType === "built-in" && !signer;
          },
          async sign(password) {
            await refresh();
            if (signer && Date.now() >= signerExpires) lock();
            if (current?.account !== sessionAccount || current.csrf !== sessionToken) throw new Error("World account changed. Sign in again.");
            const generation = signerGeneration;
            if (current.walletType === "built-in") {
              if (!signer) {
                const backup = await request("/backup", {});
                const unlocked = await ethers.Wallet.fromEncryptedJson(backup.keystore, password);
                if (generation !== signerGeneration || current?.account !== sessionAccount) throw new Error("Wallet was locked or changed during unlock.");
                if (unlocked.address.toLowerCase() !== sessionAccount.toLowerCase()) throw new Error("Wallet backup does not match your World account.");
                signer = unlocked; signerExpires = Date.now() + unlockWait;
              }
              const active = signer;
              touchSigner();
              const signature = await active.signMessage(message);
              if (generation !== signerGeneration || signer !== active || current?.account !== sessionAccount) throw new Error("Wallet was locked or changed while signing.");
              return signature;
            }
            const wallets = window.ethereum?.providers || [window.ethereum];
            for (const external of wallets) {
              if (!external) continue;
              const accounts = await external.request({ method: "eth_requestAccounts" });
              if (accounts[0]?.toLowerCase() !== account.toLowerCase()) continue;
              const signature = await external.request({ method, params });
              if (generation !== signerGeneration || current?.account !== sessionAccount
                || (await external.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== account.toLowerCase())
                throw new Error("Wallet changed while signing.");
              return signature;
            }
            throw new Error("Connect the external wallet used to sign in to World.");
          },
        });
      } finally { signing = false; }
    },
  };
  window.FeatheralWorldAccount = {
    refresh, request, url, provider, snapshot: () => current, signInWallet,
    setSigner, lock,
    async requireProfile() {
      const session = await refresh();
      if (!session.complete) { location.replace(url()); return false; }
      return true;
    },
  };
  window.addEventListener("focus", () => { refresh().catch(error => console.error("World sign-in refresh:", error)); });
  window.addEventListener("pagehide", lock);
  window.addEventListener("featheral:wallet-lock", lock);
  window.addEventListener("storage", event => {
    if (["featheral-encrypted-wallet-v1", "featheral-wallet-active-account", "featheral-wallet-public-account", "featheral-wallet-reset", null].includes(event.key)) lock();
  });
  for (const name of ["pointerdown", "keydown"]) window.addEventListener(name, event => { if (event.isTrusted) touchSigner(); }, { passive: true });
})();
