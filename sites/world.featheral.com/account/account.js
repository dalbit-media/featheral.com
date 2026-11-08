"use strict";
(() => {
  const $ = id => document.getElementById(id), world = window.FeatheralWorldAccount;
  const query = new URLSearchParams(location.search);
  const authPage = /^\/(?:login|register)(?:\/|$)/.test(location.pathname);
  let mode = location.pathname.startsWith("/login") ? "login" : "register", pending = null, editor = null, busy = false, approvalRequest = null, displayedAccount = null;
  function navigate(path) {
    const destination = new URL(path, location.origin);
    destination.search = query.toString();
    if (path !== "/login/") destination.searchParams.delete("switch");
    location.assign(destination.href);
  }
  const vault = new FeatheralVault.Vault({ getItem: key => localStorage.getItem(key) });
  const passwordNote = $("password-note").textContent;
  function connectedBuiltInWallet() {
    const record = vault.read();
    const address = world.snapshot()?.account || localStorage.getItem("featheral-wallet-public-account") || localStorage.getItem("featheral-wallet-active-account");
    return record && typeof address === "string" && record.address.toLowerCase() === address.toLowerCase() ? record : null;
  }
  function updateCredentials() {
    const existing = mode === "register" && connectedBuiltInWallet();
    $("confirmation").hidden = mode === "login" || !!existing;
    $("credentials").elements.confirmation.required = mode === "register" && !existing;
    $("credentials").elements.password.autocomplete = mode === "login" || existing ? "current-password" : "new-password";
    $("credentials-submit").textContent = mode === "login" ? "Sign in" : existing ? "Enable username login" : "Create built-in wallet";
    $("password-note").textContent = mode === "login"
      ? "Use your existing World password to unlock your encrypted wallet. No new wallet is created. There is no password reset."
      : existing
      ? "Use your existing built-in wallet password. Your username and password will sign in to this same wallet on any device. No new wallet is created and no funds move."
      : passwordNote;
  }
  window.addEventListener("beforeunload", event => { if (pending) { event.preventDefault(); event.returnValue = ""; } });
  function report(error) {
    console.error("World account:", error);
    $("status").textContent = error.message; $("status").classList.add("error");
  }
  function status(text) { $("status").textContent = text; $("status").classList.remove("error"); }
  const hex = message => ethers.hexlify(ethers.toUtf8Bytes(message));
  async function sign(message, address) {
    if (pending) return pending.signer.signMessage(message);
    return world.provider.request({ method: "personal_sign", params: [hex(message), address] });
  }
  function allowedReturn(raw) {
    try {
      const url = new URL(raw || "/explore/", location.origin);
      const local = location.hostname.endsWith(".localhost") || location.hostname === "localhost";
      const allowed = local ? url.protocol === "http:" && (url.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(url.hostname))
        : url.protocol === "https:" && (url.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(url.hostname));
      return allowed && !url.username && !url.password ? url.href : new URL("/explore/", location.origin).href;
    } catch { return new URL("/explore/", location.origin).href; }
  }
  async function loadEditor(address) {
    $("profile").hidden = false; $("sign-in").hidden = true;
    editor = await FeatheralWorldProfile.mount($("profile-editor"), {
      address, sign, onSaved: async profile => {
        if (pending) {
          $("finish-registration").hidden = false;
          status("Profile saved. Finish registration to enable cross-device sign-in.");
        } else {
          await world.refresh(); await showSession();
          status("Your World profile is ready.");
        }
      },
    });
    if (pending) {
      const username = $("credentials").elements.username.value.trim();
      $("profile-editor").querySelector('[name="username"]').value = username;
      $("profile-editor").querySelector('[name="username"]').readOnly = true;
      $("backup").hidden = false;
    }
  }
  async function showSession() {
    const session = world.snapshot();
    if (!session?.account) return;
    if (authPage && query.has("switch") && !busy && !query.get("approve")) {
      displayedAccount = session.account;
      $("account-name").hidden = false;
      $("account-name").textContent = session.profile?.username || session.account;
      $("account-description").textContent = "Sign in with another username or connect another wallet. Each wallet keeps its own settlement and funds. Your current account stays connected until the new sign-in succeeds.";
      $("profile").hidden = true; $("sign-in").hidden = false;
      $("continue").hidden = true; $("backup").hidden = true;
      return;
    }
    if (authPage && !query.get("approve") && (!query.has("switch") || busy) && (session.loginUsername || !connectedBuiltInWallet() || mode === "login")) {
      navigate("/account/"); return;
    }
    displayedAccount = session.account;
    $("sign-out").hidden = false;
    $("switch-account").hidden = !!query.get("approve");
    $("account-name").hidden = false; $("account-name").textContent = session.profile?.username || session.account;
    $("account-title").textContent = "Your World account";
    $("account-description").textContent = "Manage your shared World profile, avatar and encrypted wallet backup.";
    if (!session.loginUsername && connectedBuiltInWallet() && !query.get("approve")) {
      if (!authPage) { navigate("/register/"); return; }
      mode = "register";
      document.querySelectorAll("[data-mode]").forEach(option => option.setAttribute("aria-pressed", String(option.dataset.mode === mode)));
      $("profile").hidden = true; $("sign-in").hidden = false;
      $("continue").hidden = true; $("backup").hidden = true;
      if (!$("credentials").elements.username.value) $("credentials").elements.username.value = session.profile?.username || "";
      updateCredentials();
      status("Your built-in wallet is connected. Set a username and use its existing password to enable World login.");
      return;
    }
    $("sign-in").hidden = true;
    if (!editor) await loadEditor(session.account);
    else await editor.load(session.account, true);
    if (!session.profile?.username && session.loginUsername)
      $("profile-editor").querySelector('[name="username"]').value = session.loginUsername;
    $("continue").hidden = !session.complete || !!query.get("approve");
    const destination = new URL(allowedReturn(query.get("returnTo")));
    $("continue").textContent = destination.hostname.startsWith("admin.") ? "Continue to Admin" : destination.hostname.startsWith("app.") ? "Continue to App" : destination.hostname.startsWith("media.") ? "Continue to Media"
      : destination.pathname.startsWith("/community/") ? "Continue to Community" : "Continue to World";
    $("backup").hidden = session.walletType !== "built-in";
    status(session.complete ? "Signed in to World. World, Media and App share this profile." : "Choose an avatar and write your public profile description to continue.");
    $("profile").hidden = !!query.get("approve") && session.complete;
  }
  async function perform(work) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll("#sign-in input,#sign-in button")];
    controls.forEach(control => { control.disabled = true; });
    try { await work(); } catch (error) { report(error); }
    finally { busy = false; controls.forEach(control => { control.disabled = false; }); }
  }
  document.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => {
    if (busy) return;
    if (!query.get("approve")) { navigate(button.dataset.mode === "login" ? "/login/" : "/register/"); return; }
    mode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
    updateCredentials();
  });
  $("credentials").onsubmit = event => {
    event.preventDefault();
    void perform(async () => {
      const form = $("credentials"), username = form.elements.username.value.trim(), password = form.elements.password.value;
      if (mode === "login") {
        status("Signing in and unlocking your encrypted World wallet…");
        const session = await world.request("/login", { username, password });
        const signer = await ethers.Wallet.fromEncryptedJson(session.keystore, password);
        if (signer.address.toLowerCase() !== session.account.toLowerCase()) throw new Error("Encrypted wallet does not match the signed-in account.");
        await world.refresh(); world.setSigner(signer);
        form.reset(); await showSession();
      } else {
        const existing = connectedBuiltInWallet();
        if (!existing && password !== form.elements.confirmation.value) throw new Error("Passwords do not match.");
        if (password.length < 12) throw new Error("Use a password of at least 12 characters.");
        if (existing) {
          status("Unlocking your existing built-in wallet for World login…");
          try {
            await vault.unlock(password);
            const selected = connectedBuiltInWallet();
            if (!selected || selected.address !== existing.address || selected.keystore !== existing.keystore
              || vault.signer.address.toLowerCase() !== existing.address.toLowerCase())
              throw new Error("Wallet changed during signup. Retry with the selected wallet.");
            await register({ signer: vault.signer, keystore: existing.keystore, password, username });
            form.reset();
          } finally { vault.lock(); form.elements.password.value = ""; }
          return;
        }
        status("Creating and encrypting your built-in wallet…");
        const signer = ethers.Wallet.createRandom(), keystore = await signer.encrypt(password);
        pending = { signer, keystore, password, username };
        await register(pending);
        form.reset();
      }
    });
  };
  async function register(record) {
    status("Finishing World registration…");
    const challenge = await world.request("/challenge", { action: "register", address: record.signer.address, username: record.username, keystore: record.keystore });
    const signature = await record.signer.signMessage(challenge.message);
    await world.request("/register", { id: challenge.id, signature, password: record.password, keystore: record.keystore });
    await world.refresh(); world.setSigner(record.signer);
    pending = null; $("finish-registration").hidden = true; await showSession();
  }
  $("finish-registration").onclick = () => void perform(async () => {
    if (!pending) throw new Error("Create a built-in wallet first.");
    await register(pending);
  });
  $("external").onclick = () => void perform(async () => {
    const wallets = window.ethereum?.providers || [window.ethereum];
    const provider = wallets.find(wallet => typeof wallet?.request === "function");
    if (!provider) throw new Error("Install or enable an Ethereum wallet, or register with a username and password.");
    const address = (await provider.request({ method: "eth_requestAccounts" }))[0];
    await world.signInWallet(address, message => provider.request({ method: "personal_sign", params: [hex(message), address] }));
    await showSession();
  });
  $("switch-account").onclick = () => {
    if (busy) return;
    if (!query.get("approve")) { query.set("switch", "1"); navigate("/login/"); return; }
    pending = null; editor = null;
    $("profile-editor").replaceChildren(); $("profile").hidden = true; $("sign-in").hidden = false;
    $("finish-registration").hidden = true; $("switch-account").hidden = true;
    $("continue").hidden = true; $("backup").hidden = true;
    document.querySelector('[data-mode="login"]').click();
    status("Sign in with another World account or connect its wallet. Existing settlements and funds stay separate.");
  };
  window.addEventListener("featheral:world-session", event => {
    if (!busy && !pending && event.detail?.account
      && (!displayedAccount || event.detail.account.toLowerCase() !== displayedAccount.toLowerCase())) void showSession().catch(report);
  });
  window.addEventListener("focus", () => { if (!busy && !pending) { try { updateCredentials(); } catch (error) { report(error); } } });
  $("sign-out").onclick = () => void perform(async () => {
    await world.request("/logout", {}); pending = null; location.replace("/login/");
  });
  $("backup").onclick = () => void perform(async () => {
    const backup = pending ? { keystore: pending.keystore } : await world.request("/backup", {});
    const blob = new Blob([JSON.stringify({ version: 1, keystore: backup.keystore, links: [] })], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "featheral-world-encrypted-wallet.json"; link.click(); URL.revokeObjectURL(url);
    status("Encrypted backup downloaded. Keep it and your password safe.");
  });
  $("continue").onclick = () => void perform(async () => {
    const session = await world.refresh();
    if (!session.complete) throw new Error("Complete your World username, avatar and description first.");
    const target = new URL(allowedReturn(query.get("returnTo")));
    if (target.hostname.startsWith("admin.")) {
      status("Requesting your explicitly assigned App administration access. No funds move…");
      const handoff = await world.request("/admin-handoff", { origin: target.origin });
      target.searchParams.set("worldAdminSignIn", handoff.code);
    } else if (target.hostname.startsWith("app.")) {
      status("Connecting your World profile to App. No funds move…");
      const handoff = await world.request("/app-handoff", { origin: target.origin });
      target.searchParams.set("worldAppSignIn", handoff.code);
    } else if (target.hostname.startsWith("media.")) {
      status("Connecting your World account to Media…");
      const handoff = await world.request("/media-handoff", { origin: target.origin });
      target.searchParams.set("worldSignIn", handoff.code);
    } else if (target.origin === location.origin && /^\/(?:explore|settlement|market|federation|bank|communicate|contacts|journal|help|play)(?:\/|$)/.test(target.pathname)) {
      status("Connecting your existing World settlement. No funds move…");
      await world.request("/game", {});
    }
    location.assign(target.href);
  });
  function reply(value) {
    window.opener.postMessage({ type: "featheral:world-sign-result", nonce: approvalRequest?.nonce || query.get("approve"), ...value }, query.get("parentOrigin"));
  }
  $("reject").onclick = () => { reply({ error: "World signature rejected." }); window.close(); };
  $("approve").onclick = () => void perform(async () => {
    if (!approvalRequest || !world.snapshot()?.complete) throw new Error("Sign in and complete your World profile before approving.");
    if (approvalRequest.account.toLowerCase() !== world.snapshot().account.toLowerCase()) throw new Error("World account does not match the Media request.");
    try { reply({ signature: await sign(approvalRequest.message, approvalRequest.account) }); window.close(); }
    catch (error) { reply({ error: error.message }); throw error; }
  });
  window.addEventListener("message", event => {
    const mediaOrigin = location.hostname === "world.featheral.com" ? "https://media.featheral.com"
      : `http://media.localhost${location.port ? ":" + location.port : ""}`;
    if (!query.get("approve") || event.source !== window.opener || event.origin !== query.get("parentOrigin")
      || event.origin !== mediaOrigin
      || !/^[a-f0-9]{32}$/.test(event.data?.nonce || "")) return;
    if (event.data.type === "featheral:world-sign-ping") {
      window.opener.postMessage({ type: "featheral:world-sign-ready", nonce: event.data.nonce }, event.origin); return;
    }
    if (event.data.type === "featheral:world-sign-cancel" && approvalRequest?.nonce === event.data.nonce) {
      world.lock(); document.getElementById("featheral-central-wallet")?.close(); return;
    }
    if (event.data.type !== "featheral:world-sign") return;
    const input = event.data;
    const pattern = /^Featheral World social action\n\nAction: SESSION\nAuthor: (0x[0-9a-fA-F]{40})\nSession key: (0x[0-9a-fA-F]{40})\nExpires: ([^\n]+)\nNonce: ([0-9a-f]{24})\nIssued at: ([^\n]+)\nLedger: Featheral World communication ledger\n\nSigning is free and only authorizes this action on the World ledger\.$/;
    const match = typeof input.message === "string" && input.message.match(pattern);
    const expires = match && Date.parse(match[3]), issued = match && Date.parse(match[5]);
    if (!match || !ethers.isAddress(input.account) || ethers.getAddress(match[1]) !== ethers.getAddress(input.account)
      || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 7 * 86400000
      || !Number.isFinite(issued) || Math.abs(Date.now() - issued) > 300000)
      { window.opener.postMessage({ type: "featheral:world-sign-result", nonce: input.nonce, error: "Only Media session authorization is supported here." }, event.origin); return; }
    if (approvalRequest) return;
    approvalRequest = input;
    void perform(async () => {
      try {
        await world.refresh();
        if (!world.snapshot()?.complete || world.snapshot().account.toLowerCase() !== input.account.toLowerCase())
          throw new Error("Sign in to the requesting World account and complete your profile before approving.");
        reply({ signature: await sign(input.message, input.account) });
        status("Signature approved. You can keep this wallet open for your next request.");
      } catch (error) { reply({ error: error.message }); throw error; }
      finally { approvalRequest = null; }
    });
  });
  void (async () => {
    await world.refresh(); await showSession();
    if (!authPage && !world.snapshot()?.account && !query.get("approve")) { navigate("/login/"); return; }
    if (!authPage && query.has("switch") && world.snapshot()?.account && !query.get("approve")) $("switch-account").click();
    if (!world.snapshot()?.account || authPage && query.has("switch")) {
      document.querySelectorAll("[data-mode]").forEach(option => option.setAttribute("aria-pressed", String(option.dataset.mode === mode)));
      $("account-title").textContent = query.has("switch") ? "Switch World account" : mode === "login" ? "Welcome back to World" : "Create your World identity";
      updateCredentials(); status(query.has("switch") ? "Choose a different World account below. No funds move when switching accounts." : mode === "login" ? "Sign in with your World username and password." : "Register to set up your World profile.");
    }
    if (query.get("approve")) {
      const parent = new URL(query.get("parentOrigin"));
      if (!/^[a-f0-9]{32}$/.test(query.get("approve")) || !window.opener
        || !["https://media.featheral.com", `http://media.localhost${location.port ? ":" + location.port : ""}`].includes(parent.origin))
        throw new Error("Unsupported signature requester.");
      window.opener.postMessage({ type: "featheral:world-sign-ready", nonce: query.get("approve") }, parent.origin);
    }
  })().catch(report);
})();
