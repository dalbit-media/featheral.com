"use strict";
(() => {
  const local = location.hostname === "localhost" || location.hostname.endsWith(".localhost");
  const worldOrigin = `${local ? "http://world.localhost" : "https://world.featheral.com"}${local && location.port ? ":" + location.port : ""}`;
  const onWorld = location.hostname === "world.featheral.com" || location.hostname === "world.localhost" || location.hostname === "localhost";
  const endpoint = (onWorld ? "" : worldOrigin) + "/api/world-account";
  let current = null, signer = null, refreshing = null;
  async function request(path, input) {
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
    if (current?.account !== next.account) signer = null;
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
    const destination = new URL("/account/", onWorld ? location.origin : worldOrigin);
    destination.searchParams.set("returnTo", returnTo);
    return destination.href;
  }
  function review(message, passwordRequired) {
    return new Promise((resolve, reject) => {
      const dialog = document.createElement("dialog"); dialog.className = "world-sign-dialog";
      const heading = document.createElement("h2"); heading.textContent = "Approve World signature";
      const explanation = document.createElement("p"); explanation.textContent = "Read the exact request. Approving signs this message; it does not send an Ethereum transaction.";
      const pre = document.createElement("pre"); pre.textContent = message; pre.setAttribute("data-no-localize", "");
      const form = document.createElement("form");
      const label = document.createElement("label"); label.textContent = "World password";
      const password = document.createElement("input"); password.type = "password"; password.autocomplete = "current-password"; password.required = passwordRequired;
      label.append(password); label.hidden = !passwordRequired;
      const approve = document.createElement("button"); approve.type = "submit"; approve.textContent = "Approve";
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
      const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
      cancel.onclick = () => { dialog.close(); dialog.remove(); reject(new Error("Signature cancelled.")); };
      dialog.addEventListener("cancel", event => { event.preventDefault(); cancel.click(); });
      form.onsubmit = event => { event.preventDefault(); finish(password.value); };
      form.append(label, approve, cancel); dialog.append(heading, explanation, pre, form); document.body.append(dialog); dialog.showModal();
    });
  }
  function remoteSign(message, account) {
    return new Promise((resolve, reject) => {
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
      const popupUrl = new URL("/account/", worldOrigin);
      popupUrl.searchParams.set("approve", nonce); popupUrl.searchParams.set("parentOrigin", location.origin);
      const popup = window.open(popupUrl.href, "featheral-world-sign", "popup,width=540,height=740");
      if (!popup) { reject(new Error("Allow the World sign-in popup to approve this action.")); return; }
      let timer, closedTimer, settled = false;
      const finish = (error, signature) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearInterval(closedTimer); window.removeEventListener("message", receive); popup.close();
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
      timer = setTimeout(() => finish(new Error("World signature timed out. Retry.")), 180000);
      closedTimer = setInterval(() => { if (popup.closed) finish(new Error("World signature window was closed.")); }, 500);
    });
  }
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return current?.account ? [current.account] : [];
      if (method !== "personal_sign") throw new Error("World accounts support message signing only. Use the wallet for transfers.");
      const [hex, account] = params;
      if (!current?.account || account.toLowerCase() !== current.account.toLowerCase()) throw new Error("World account changed. Sign in again.");
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > 128000) throw new Error("Invalid signature request.");
      const message = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(hex.slice(2).match(/../g), byte => parseInt(byte, 16)));
      if (!onWorld) {
        const signature = await remoteSign(message, account);
        if (current?.account?.toLowerCase() !== account.toLowerCase()) throw new Error("World account changed while signing.");
        return signature;
      }
      const sessionAccount = current.account;
      const password = await review(message, current.walletType === "built-in" && !signer);
      if (current.walletType === "built-in") {
        if (!signer) {
          const backup = await request("/backup", {});
          signer = await ethers.Wallet.fromEncryptedJson(backup.keystore, password);
        }
        if (signer.address.toLowerCase() !== sessionAccount.toLowerCase()) throw new Error("Wallet backup does not match your World account.");
        const signature = await signer.signMessage(message);
        if (current?.account !== sessionAccount) throw new Error("World account changed while signing.");
        return signature;
      }
      const wallets = window.ethereum?.providers || [window.ethereum];
      for (const external of wallets) {
        if (!external) continue;
        const accounts = await external.request({ method: "eth_requestAccounts" });
        if (accounts[0]?.toLowerCase() === account.toLowerCase()) return external.request({ method, params });
      }
      throw new Error("Connect the external wallet used to sign in to World.");
    },
  };
  window.FeatheralWorldAccount = {
    refresh, request, url, provider, snapshot: () => current,
    setSigner: value => { signer = value; },
    async requireProfile() {
      const session = await refresh();
      if (!session.complete) { location.replace(url()); return false; }
      return true;
    },
  };
  window.addEventListener("focus", () => { refresh().catch(error => console.error("World sign-in refresh:", error)); });
})();
