"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search), origin = params.get("origin"), nonce = params.get("nonce");
  const shared = params.get("mode") === "site";
  const prefix = shared ? "wallet" : "exchange";
  const opener = window.opener;
  const local = location.hostname === "wallet.localhost";
  const expected = local ? `${location.protocol}//ex.localhost${location.port ? ":" + location.port : ""}` : "https://ex.featheral.com";
  let vault, request, publicAddress, busy = false, done = false, external = false;
  function reply(result) {
    if (done) return;
    done = true; vault?.lock(); $("auth-password").value = ""; $("auth-submit").disabled = true;
    opener.postMessage({ type: `featheral:${prefix}-signature`, nonce, address: request?.address, ...result }, origin);
  }
  function validate(address, message) {
    if (typeof address !== "string" || !ethers.isAddress(address) || typeof message !== "string")
      throw new Error("Invalid sign-in request.");
    const record = vault.read();
    if (!external && (!record || record.address.toLowerCase() !== address.toLowerCase()))
      throw new Error("The requested account is not this device's built-in wallet. Open the full wallet to select your account.");
    if (shared && address.toLowerCase() !== publicAddress?.toLowerCase()) throw new Error("Selected wallet changed. Start again.");
    window.FeatheralSignIn.validate(address, message, shared);
  }
  const sharedOrigin = shared && (local
    ? new RegExp(`^${location.protocol}//(?:[a-z0-9-]+\\.)?localhost${location.port ? ":" + location.port : ""}$`).test(origin || "")
    : /^https:\/\/(?:[a-z0-9-]+\.)?featheral\.com$/.test(origin || ""));
  if (!opener || window.parent !== window || !(shared ? sharedOrigin : origin === expected) || !/^[0-9a-f]{32}$/.test(nonce || "")
    || !local && location.hostname !== "wallet.featheral.com") {
    $("auth-status").textContent = "Open this authorization window from the supported Exchange site.";
    $("auth-cancel").addEventListener("click", () => window.close());
    return;
  }
  try {
    vault = new window.FeatheralVault.Vault({ getItem: key => localStorage.getItem(key) });
    const record = vault.read();
    if (record && ethers.isAddress(record.address)) publicAddress = ethers.getAddress(record.address);
    else if (!shared) throw new Error("No built-in wallet is available. Open the full wallet to create or restore one first.");
  } catch (error) {
    console.error(error);
    const message = error.message || "Built-in wallet unavailable. Open the full wallet first.";
    $("auth-status").textContent = message;
    opener.postMessage({ type: "featheral:exchange-auth-ready", nonce, address: null, error: message }, origin);
    $("auth-cancel").addEventListener("click", () => window.close());
    vault?.lock(); return;
  }
  if (shared) {
    document.title = "Connect · Featheral Wallet";
    $("auth-title").textContent = "Connect Featheral wallet";
    $("auth-description").textContent = "Use an existing built-in wallet or browser extension. Without an extension, create or restore a wallet here. Approval signs in to the requesting site only; it cannot transfer funds. Keys, passwords and wallet sessions stay here.";
    $("auth-choice").hidden = false;
    $("auth-method").value = publicAddress ? "builtin" : window.ethereum ? "external" : "builtin";
    $("auth-select").addEventListener("click", async () => {
      if (busy || request || done) return;
      busy = true; $("auth-select").disabled = true;
      try {
        external = $("auth-method").value === "external";
        const address = external ? (await window.ethereum?.request({ method: "eth_requestAccounts" }))?.[0] : vault.read()?.address;
        if (!address || !ethers.isAddress(address)) throw new Error(external
          ? "No browser wallet is available. Create or restore a built-in wallet on the wallet site."
          : "Create or restore a wallet on the wallet site, then connect it here.");
        publicAddress = ethers.getAddress(address);
        $("auth-password-label").hidden = external; $("auth-password").required = !external;
        $("auth-submit").textContent = external ? "Approve sign-in with extension" : "Unlock & approve sign-in";
        $("auth-status").textContent = "Waiting for the requesting site's sign-in message.";
        opener.postMessage({ type: "featheral:wallet-auth-ready", nonce, address: publicAddress }, origin);
      } catch (error) { console.error(error); $("auth-status").textContent = error.message; }
      finally { busy = false; if (!request) $("auth-select").disabled = false; }
    });
  }
  $("auth-origin").textContent = `Requesting site: ${origin}`;
  window.addEventListener("message", event => {
    if (done || request || event.origin !== origin || event.source !== opener || event.data?.type !== `featheral:${prefix}-auth`
      || event.data.nonce !== nonce) return;
    request = { address: event.data.address, message: event.data.message };
    try {
      validate(request.address, request.message);
      $("auth-address").textContent = request.address; $("auth-message").textContent = request.message;
      $("auth-status").textContent = external ? "Review the account and message, then approve with your extension."
        : "Review the account and message, then enter your password to approve.";
      $("auth-submit").disabled = false;
    } catch (error) { $("auth-status").textContent = error.message; reply({ error: error.message }); }
  });
  $("auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || done || !request) return;
    busy = true; $("auth-submit").disabled = true;
    try {
      validate(request.address, request.message);
      const password = $("auth-password").value; $("auth-password").value = "";
      if (!external) await vault.unlock(password);
      if (done) return;
      validate(request.address, request.message);
      let signature;
      if (external) {
        const provider = window.ethereum;
        if ((await provider.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== request.address.toLowerCase())
          throw new Error("Extension account changed. Start again.");
        signature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(request.message)), request.address] });
        if ((await provider.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== request.address.toLowerCase())
          throw new Error("Extension account changed while signing. Start again.");
      } else signature = await vault.sign(request.message, request.address);
      if (done) return;
      if (shared) localStorage.setItem("featheral-wallet-active-account", request.address.toLowerCase());
      reply({ signature }); $("auth-status").textContent = "Sign-in approved. Return to the requesting site. The wallet is locked.";
    } catch (error) {
      console.error(error);
      $("auth-status").textContent = error.message || "Sign-in could not be approved. Check the password or start again on Exchange.";
      if (!done) $("auth-submit").disabled = false;
    } finally { vault.lock(); $("auth-password").value = ""; busy = false; }
  });
  $("auth-cancel").addEventListener("click", () => { reply({ error: "Sign-in cancelled." }); window.close(); });
  window.addEventListener("pagehide", () => { reply({ error: "Authorization window closed." }); vault.lock(); });
  window.addEventListener("storage", () => {
    if (shared && !request && !done) {
      publicAddress = vault.read()?.address;
      $("auth-status").textContent = "Wallet updated. Select and connect your wallet to continue.";
      return;
    }
    reply({ error: "Wallet storage changed. Start sign-in again." });
  });
  if (!shared) opener.postMessage({ type: "featheral:exchange-auth-ready", nonce, address: publicAddress }, origin);
})();
