"use strict";
(() => {
  const status = document.querySelector("#login-status"), sign = document.querySelector("#login-sign");
  const chooser = document.querySelector("#login-provider"), choices = document.querySelector("#login-provider-field");
  const wallets = [];
  let busy = false;
  function show(message, error = false) {
    status.textContent = message;
    status.setAttribute("role", error ? "alert" : "status");
  }
  function renderWallets() {
    const selected = chooser.value;
    chooser.replaceChildren(new Option("Choose a wallet", ""));
    wallets.forEach((wallet, index) => chooser.add(new Option(wallet.name, String(index))));
    chooser.value = wallets.length === 1 ? "0" : wallets.length === 2 ? "" : selected;
    choices.hidden = wallets.length < 2;
  }
  function addWallet(provider, name) {
    if (!provider || typeof provider.request !== "function" || wallets.some(wallet => wallet.provider === provider)) return;
    wallets.push({ provider, name: name || `Wallet ${wallets.length + 1}` });
    renderWallets();
  }
  window.addEventListener("eip6963:announceProvider", event => {
    addWallet(event.detail?.provider, event.detail?.info?.name);
  });
  function discover() {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (!wallets.length) {
      for (const provider of window.ethereum?.providers || [window.ethereum])
        addWallet(provider, provider?.isMetaMask ? "MetaMask" : provider?.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet");
    }
  }
  async function authRequest(path, body) {
    const response = await fetch("/api/admin-auth/" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("Admin sign-in service is unavailable. Reload the page and try again.");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Admin sign-in failed (HTTP ${response.status}).`);
    return result;
  }
  document.querySelector("#login-world").addEventListener("click", () => {
    const target = new URL("/login/", location.origin.replace("//admin.", "//world."));
    target.searchParams.set("returnTo", new URL("/", location.origin).href);
    location.assign(target.href);
  });
  const returnUrl = new URL(location.href), code = returnUrl.searchParams.get("worldAdminSignIn");
  if (code) {
    returnUrl.searchParams.delete("worldAdminSignIn"); history.replaceState(null, "", returnUrl.href);
    busy = true; sign.disabled = true;
    void authRequest("world-login", { code }).then(() => { location.reload(); })
      .catch(error => { console.error("World Admin sign-in failed:", error); show(error.message, true); busy = false; sign.disabled = false; });
  }
  sign.addEventListener("click", async () => {
    if (busy) return;
    discover();
    if (!wallets.length) {
      show("No Ethereum signing wallet was found. Enable your wallet extension, or open this Admin page in your wallet's browser, then retry. Connecting a funds wallet on another site does not connect it here.", true);
      return;
    }
    if (chooser.value === "") {
      show("Choose your explicitly authorized Admin wallet, then continue.");
      chooser.focus();
      return;
    }
    const provider = wallets[Number(chooser.value)]?.provider;
    if (!provider) { show("Choose an available wallet and retry.", true); return; }
    busy = true; sign.disabled = true; chooser.disabled = true;
    let changed = false;
    const accountChanged = () => { changed = true; };
    try {
      show("Checking Admin access...");
      const session = await authRequest("session");
      if (session.authenticated) { location.reload(); return; }
      show("Unlock your wallet and approve connecting to this Admin site.");
      sign.textContent = "Connecting...";
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const account = accounts?.[0];
      if (!ethers.isAddress(account)) throw new Error("The wallet did not return an Ethereum account. Unlock it, select an account and retry.");
      provider.on?.("accountsChanged", accountChanged);
      const challenge = await authRequest("challenge", { address: account });
      if (changed) throw new Error("Wallet account changed. Retry with the authorized Admin account.");
      show("Sign the Admin sign-in message in your wallet. No network switch, gas, transaction or transfer is required.");
      sign.textContent = "Waiting for signature...";
      const signature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(challenge.message)), account] });
      const current = await provider.request({ method: "eth_accounts" });
      if (changed || current?.[0]?.toLowerCase() !== account.toLowerCase())
        throw new Error("Wallet account changed. Retry with the authorized Admin account.");
      show("Verifying your signature...");
      sign.textContent = "Signing in...";
      const verified = await authRequest("verify", { signature });
      if (changed || !verified.authenticated || verified.wallet?.toLowerCase() !== account.toLowerCase())
        throw new Error("Admin sign-in was not confirmed. Retry with the authorized Admin account.");
      location.reload();
    } catch (error) {
      console.error("Admin sign-in failed:", error.code || error.name);
      const code = error.code ?? error.error?.code;
      show(code === 4001 || code === "ACTION_REJECTED" ? "Sign-in cancelled in your wallet. You can try again."
        : code === -32002 ? "A wallet request is already open. Open your wallet extension and finish or cancel that request, then retry."
        : error.message || "Admin sign-in failed. Unlock your wallet and retry.", true);
    } finally {
      provider.removeListener?.("accountsChanged", accountChanged);
      busy = false; sign.disabled = false; chooser.disabled = false; sign.textContent = "Connect and sign in";
    }
  });
  discover();
  show(wallets.length ? "Ready. Sign in with a root wallet or an App wallet with assigned Admin permissions." : "Use an Ethereum signing wallet extension or your wallet's browser to sign in.");
})();
