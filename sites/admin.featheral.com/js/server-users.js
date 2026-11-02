"use strict";
VIEWS["server-profile"] = async (q, token) => {
  renderSidebar("server-profile"); setCrumbs("<b>Server profile</b>");
  setView(`<section class="card server-profile-heading"><div><h1>Server profile</h1><p class="muted">Live process and host health with a cached inventory of application storage. Inventory scans exclude dependency and build-artifact folders.</p></div>
    <div class="row"><button id="server-profile-refresh" type="button" class="btn">Refresh metrics</button><button id="server-storage-refresh" type="button" class="btn">Rescan storage</button><span id="server-profile-status" role="status">Connecting…</span></div></section>
    <section class="grid g2 server-profile-grid"><div class="card"><h2>Server resource risks</h2><p class="muted">Disk warns at 85% used / critical at 95%; compute warns at 80% CPU or 100 ms event-loop p95 and turns critical at 95% CPU or 250 ms; memory warns at 80% heap or 85% host use and turns critical at 95%. HTTP errors warn at 5% and turn critical at 20%. Set SERVER_PROFILE_NETWORK_LIMIT_BPS to assess network-capacity risk.</p><div id="server-profile-risks" class="server-profile-risks"><p class="muted">Waiting for the first sample…</p></div></div>
    <div class="card"><h2>Application storage</h2><p id="server-storage-status" class="muted">Waiting for storage inventory…</p><div id="server-profile-storage" class="server-profile-storage"></div></div></section>
    <section class="card server-profile-chart-card">    <div class="card-head"><div><h2>Live server metrics</h2><p class="muted">One-minute history. Each row has its own scale; ingress uses declared Content-Length and response counts exclude headers.</p></div></div>
    <div id="server-profile-stats" class="stats"></div><div id="server-profile-chart" class="server-profile-chart" role="img" aria-label="Recent CPU, memory, event-loop, request, and network metrics"></div></section>
    <section class="card"><h2>Server accounts</h2><p class="muted">Linux accounts on the configured deployment server, including system accounts. These are not Featheral profiles. Account creation, deletion and permission changes are not enabled here.</p>
    <form id="server-user-search" class="row"><label>Search accounts<input name="q" value="${esc(q.q || "")}" maxlength="100" type="search" placeholder="Username, UID, home or shell"></label><button class="btn">Search</button><button type="button" class="btn" id="server-users-refresh">Refresh</button><button type="button" class="btn" id="server-users-vault">Sign &amp; browse stored credential</button></form>
    <p id="server-users-status" role="status">Loading server accounts…</p>
    <div class="table-wrap"><table><thead><tr><th>Username</th><th>UID</th><th>GID</th><th>Home</th><th>Shell</th></tr></thead><tbody id="server-users-rows"></tbody></table></div>
    <div class="row"><button id="server-users-prev" class="btn" disabled>Previous</button><span id="server-users-page"></span><button id="server-users-next" class="btn" disabled>Next</button></div></section>
    <section class="card form-grid"><h2>Change server root password</h2><p class="note">Admin login, current root password and FTHG origin-wallet signature are required. Connect the origin wallet with the signing control in the header. Keep an independent recovery session open. Your root password must stay separate from your wallet private key. No automatic retry is performed.</p>
    <div id="server-root-status" class="root-password-feedback" role="status" aria-live="assertive" aria-atomic="true" tabindex="-1">No password change submitted from this view.</div>
    <div class="row"><button type="button" class="btn" id="server-root-refresh">Refresh last recorded result</button><span id="server-root-record" role="status" class="muted">Checking server record…</span></div>
    <form id="server-root-password" class="form-grid" autocomplete="off">
      <label>Current root password<input type="password" name="currentPassword" autocomplete="current-password" required maxlength="1024"></label>
      <label>New root password<input type="password" name="newPassword" autocomplete="new-password" required minlength="16" maxlength="256"></label>
      <label>Repeat new password<input type="password" name="repeat" autocomplete="new-password" required minlength="16" maxlength="256"></label>
      <label>Type CHANGE ROOT PASSWORD<input name="confirmation" autocomplete="off" required></label>
      <button class="btn danger" type="submit">Sign &amp; change root password</button>
    </form><p class="muted">With an external vault key configured, a verified new password is saved encrypted in the internal ledger. No root password is needed in .env. Check the credential vault status below. Root SSH password login must already be permitted by server policy.</p></section>
    <section class="card form-grid"><h2>Server credential vault</h2><p class="muted">Verify and store the current root SSH password, not your wallet private key. AES-256-GCM ciphertext stays in the internal ledger; its independent key stays outside the repository and ledger backups. Only an authenticated Admin with an origin-wallet signature can enroll or use it. Passwords cannot be viewed or exported.</p>
    <p id="server-vault-status" role="status">Checking vault…</p>
    <form id="server-vault-form" class="form-grid" autocomplete="off"><label>Current root SSH password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>
    <button class="btn primary" type="submit">Sign, verify &amp; store encrypted</button></form>
    <div id="server-vault-feedback" class="root-password-feedback" role="status" aria-live="assertive">No credential submitted.</div>
    <p class="muted">One-time server setup: create the external vault key with the bundled init-db-vault command, set DB_VAULT_KEY_FILE to its absolute path, and independently verify DEPLOY_HOST_KEY_SHA256. No root password is needed in .env. Keep a separate key backup and SSH recovery access.</p></section>`, token);
  const status = $("#server-users-status"), rows = $("#server-users-rows"), pageLabel = $("#server-users-page");
  const previous = $("#server-users-prev"), next = $("#server-users-next"), search = $("#server-user-search");
  const form = $("#server-root-password"), result = $("#server-root-status"), submit = $("button", form);
  const record = $("#server-root-record"), refreshResult = $("#server-root-refresh");
  const vaultForm = $("#server-vault-form"), vaultFeedback = $("#server-vault-feedback");
  const vaultStatus = $("#server-vault-status"), vaultButton = $("button", vaultForm);
  function feedback(kind, text, focus = false) {
    result.className = `root-password-feedback ${kind}`;
    result.textContent = text;
    if (focus) { result.focus?.({ preventScroll: true }); result.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }
  }
  const controller = new AbortController();
  const viewHash = location.hash;
  let page = 1, total = 0, loading = false, changing = false, enrolling = false, useVault = false, profileLoading = false;
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === viewHash;
  viewCleanup = () => { controller.abort(); form.reset(); vaultForm.reset(); stopProfilePolling(); };
  leaveView = () => (!changing && !enrolling) || confirm("A server credential operation is in progress. Leaving will not cancel it. Verify the result before retrying. Leave this view?");
  function renderProfile(data) {
    const m = data.metrics, history = data.history || [];
    const averageCpu = history.length ? history.reduce((sum, point) => sum + point.processCpuPct, 0) / history.length : m.processCpuPct;
    const disk = data.disk;
    $("#server-profile-stats").innerHTML = [
      ["CPU average", `${averageCpu.toFixed(1)}%`, `Process, one core · host ${m.hostCpuPct === null ? "unavailable" : `${m.hostCpuPct}%`}`],
      ["Memory", fmtBytes(m.rssBytes), `Heap ${fmtBytes(m.heapUsedBytes)} / ${fmtBytes(m.heapLimitBytes)}`],
      ["Disk", disk.available ? `${disk.usedPct}% used` : "Unavailable", disk.available ? `${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.totalBytes)} · ${fmtBytes(disk.freeBytes)} free` : disk.error],
      ["Requests", fmtNum(m.requestCount60s), "Observed in the last minute"],
      ["Latency p95", `${m.latencyP95Ms.toFixed(1)} ms`, `${fmtNum(m.latencySampleCount)} sampled responses`],
      ["HTTP response", fmtBytes(m.responseBytes60s), `Last minute · ${fmtBytes(m.requestBytes60s)} declared incoming`],
    ].map(([label, value, note]) => `<div class="stat"><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(note)}</div></div>`).join("");
    $("#server-profile-chart").innerHTML = ServerProfileCharts.renderServerProfileChart(history);
    $("#server-profile-risks").innerHTML = data.risks.map(risk => `<div class="server-risk ${esc(risk.severity)}"><span>${esc(risk.severity.toUpperCase())}</span><p>${esc(risk.message)}</p></div>`).join("");
    const categories = data.storage.categories;
    $("#server-profile-storage").innerHTML = [
      ["Databases", categories.databases], ["Currency & other ledgers", categories.ledgers],
      ["Uploads", categories.uploads], ["Trash", categories.trash],
      ["Codebase", categories.codebase], ["Other data", categories.otherData],
    ].map(([label, item]) => `<div class="server-storage-item"><span>${esc(label)}</span><b>${fmtBytes(item.bytes)}</b><small>${fmtNum(item.files)} files</small></div>`).join("");
    const stored = data.storage.updatedAt ? `Inventory ${new Date(data.storage.updatedAt).toLocaleTimeString()} · ${fmtNum(data.storage.totalFiles)} files · ${fmtBytes(data.storage.totalBytes)} counted` : "Storage inventory has not completed yet.";
    const scan = data.storage.scanning ? " · scan in progress" : data.storage.complete ? "" : data.storage.scanError ? ` · ${data.storage.scanError}` : "";
    $("#server-storage-status").textContent = stored + scan;
    $("#server-profile-status").textContent = `Sampled ${new Date(data.sampledAt).toLocaleTimeString()} · ${fmtNum(m.uptimeSeconds)} sec uptime`;
  }
  async function loadProfile() {
    if (profileLoading || !active()) return;
    profileLoading = true;
    try { const data = await api("/api/server-profile", { signal: controller.signal, cache: "no-store" }); if (active()) renderProfile(data); }
    catch (error) { if (active()) $("#server-profile-status").textContent = `Server profile unavailable: ${error.message}`; }
    finally { profileLoading = false; }
  }
  const stopProfilePolling = ServerProfileCharts.startServerProfilePolling(loadProfile);
  $("#server-profile-refresh").addEventListener("click", loadProfile);
  $("#server-storage-refresh").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await api("/api/server-profile/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); await loadProfile(); }
    catch (error) { $("#server-storage-status").textContent = `Storage rescan failed: ${error.message}`; }
    finally { if (active()) button.disabled = false; }
  });
  async function loadResult() {
    refreshResult.disabled = true;
    try {
      const data = await api("/api/server-users/root-password/status", { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      if (!data.last) { record.textContent = "No server-side password-change attempt recorded."; return; }
      const labels = {
        verified: "SUCCESS — password changed and a fresh SSH login with the new password was verified.",
        "not-submitted": "FAILED — password change was not submitted to the server.",
        "unverified-check-server": "UNVERIFIED — password may have changed. Check a fresh SSH login before retrying.",
        requested: data.running ? "IN PROGRESS — no confirmed result yet." : "UNVERIFIED — operation ended or restarted without a confirmed result. Check server access.",
      };
      if (!labels[data.last.outcome]) throw new Error("Invalid password-change status response.");
      record.textContent = `Last server record (${new Date(data.last.at).toLocaleString()}, ${data.last.host}): ${labels[data.last.outcome]}${data.last.credentialStored === true ? " Encrypted vault updated." : data.last.credentialStored === false ? " WARNING: new credential was not stored in the vault." : ""} This is historical, not proof of any newer attempt.`;
    } catch (error) { if (active()) record.textContent = `Cannot retrieve last result: ${error.message}`; }
    finally { refreshResult.disabled = false; }
  }
  refreshResult.addEventListener("click", loadResult);
  form.addEventListener("invalid", event => {
    feedback("error", `NOT SUBMITTED — ${event.target.validationMessage || "Complete all required fields."}`, true);
  }, true);
  async function load() {
    if (loading || !active()) return;
    loading = true; previous.disabled = next.disabled = true;
    status.textContent = "Loading server accounts…"; rows.replaceChildren();
    try {
      let data;
      if (useVault) {
        const payload = { page, query: search.elements.q.value };
        const challenge = await api("/api/database/accounts/challenge", { json: payload, signal: controller.signal });
        Object.assign(payload, await approveAdminAction(challenge, active));
        if (!active()) throw new Error("View changed. Account access was not submitted.");
        data = await api("/api/database/accounts/browse", { json: payload, signal: controller.signal });
      } else data = await api(`/api/server-users?${new URLSearchParams({ page, q: search.elements.q.value })}`, { signal: controller.signal });
      if (!active()) return;
      total = data.total;
      rows.innerHTML = data.users.map(user => `<tr><td>${esc(user.username)}${user.uid === 0 ? ' <span class="chip warn">Root privileges</span>' : ""}</td><td>${esc(user.uid)}</td><td>${esc(user.gid)}</td><td class="mono">${esc(user.home)}</td><td class="mono">${esc(user.shell)}</td></tr>`).join("");
      status.textContent = `${data.target}: ${data.total} matching / ${data.accounts} accounts.`;
      pageLabel.textContent = `Page ${page} of ${Math.max(1, Math.ceil(total / data.pageSize))}`;
      previous.disabled = page <= 1; next.disabled = page * data.pageSize >= total;
    } catch (error) { if (active()) { console.error("Server account listing failed"); status.textContent = error.message; pageLabel.textContent = ""; } }
    finally { loading = false; }
  }
  search.addEventListener("submit", event => { event.preventDefault(); if (!loading) { page = 1; load(); } });
  $("#server-users-refresh").addEventListener("click", () => load());
  $("#server-users-vault")?.addEventListener("click", () => { useVault = true; load(); });
  previous.addEventListener("click", () => { page--; load(); });
  next.addEventListener("click", () => { page++; load(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || changing) return;
    if (form.elements.newPassword.value !== form.elements.repeat.value) { feedback("error", "NOT SUBMITTED — the new passwords do not match.", true); return; }
    if (form.elements.confirmation.value !== "CHANGE ROOT PASSWORD") { feedback("error", "NOT SUBMITTED — type CHANGE ROOT PASSWORD exactly.", true); return; }
    if (!confirm("Change the Linux root password on the configured server? Keep a recovery session open. The encrypted vault will be updated if its external key is configured.")) {
      feedback("error", "CANCELLED — no password change was submitted.", true); return;
    }
    changing = true; submit.disabled = true;
    feedback("pending", "WAITING FOR WALLET — review and sign the one-time approval. No password change submitted yet.", true);
    const payload = { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value, confirmation: form.elements.confirmation.value };
    let submitted = false;
    form.reset();
    try {
      const provider = window.FeatheralProfile.getProvider(), account = window.FeatheralProfile.snapshot().account;
      if (!provider || !account) throw new Error("Connect the FTHG origin wallet using the header signing control.");
      const challenge = await api("/api/server-users/root-password/challenge", { json: payload, signal: controller.signal });
      if (!active()) throw new Error("Admin view changed. No password change was submitted.");
      if (account.toLowerCase() !== challenge.wallet.toLowerCase()) throw new Error(`Use the FTHG origin wallet ${challenge.wallet}.`);
      if (provider !== window.FeatheralProfile.getProvider() || window.FeatheralProfile.snapshot().account.toLowerCase() !== account.toLowerCase())
        throw new Error("Wallet changed. Review the password change again.");
      const signature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(challenge.message)), account] });
      if (!active() || provider !== window.FeatheralProfile.getProvider() || window.FeatheralProfile.snapshot().account.toLowerCase() !== account.toLowerCase())
        throw new Error("View or wallet changed. No password change was submitted.");
      if (ethers.verifyMessage(challenge.message, signature).toLowerCase() !== challenge.wallet.toLowerCase())
        throw new Error("The signature does not match the FTHG origin wallet.");
      payload.challengeId = challenge.challengeId; payload.signature = signature;
      feedback("pending", "IN PROGRESS — wallet approved. Verifying root access, changing password, then testing a fresh SSH login. Keep your recovery session open.", true);
      // Do not abort a password write on navigation: its remote outcome must still be checked.
      submitted = true;
      const response = await api("/api/server-users/root-password", { json: payload });
      if (response?.changed !== true || response?.verified !== true) throw new Error("The server did not confirm both the password change and a fresh SSH login.");
      if (active()) feedback("success", `SUCCESS — root password changed; a fresh SSH login with the new password was verified. ${response.message || "Check the credential vault status below."}`, true);
      else toast("SUCCESS — root password changed and new SSH login verified. Refresh Server Profile for the recorded result.");
    } catch (error) {
      if (active()) feedback("error", `${submitted ? "NOT VERIFIED — the password may have changed. Check a fresh SSH login before retrying." : "NOT SUBMITTED — password change was not sent."} ${error.message}`, true);
      else toast(submitted ? "Root-password result unverified. Check server access before retrying." : "Wallet approval cancelled. No password change was submitted.");
    } finally { payload.currentPassword = payload.newPassword = ""; changing = false; submit.disabled = false; if (active()) await loadResult(); }
  });
  vaultForm.addEventListener("invalid", () => { vaultFeedback.textContent = "NOT SUBMITTED — enter the current root SSH password."; }, true);
  vaultForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || enrolling) return;
    const payload = { password: vaultForm.elements.password.value };
    vaultForm.reset(); enrolling = true; vaultButton.disabled = true;
    let submitted = false;
    vaultFeedback.className = "root-password-feedback pending";
    vaultFeedback.textContent = "Review the one-time origin-wallet approval. No credential stored yet.";
    try {
      const challenge = await api("/api/database/vault/challenge", { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Credential enrollment was not submitted.");
      vaultFeedback.textContent = "Verifying a fresh root SSH login before encrypting…"; submitted = true;
      const response = await api("/api/database/vault/enroll", { json: payload });
      if (response.enrolled !== true || response.verified !== true) throw new Error("The server did not confirm both SSH verification and encrypted storage.");
      if (active()) { vaultFeedback.className = "root-password-feedback success"; vaultFeedback.textContent = response.message; await loadVault(); }
      else toast("Credential verified and stored encrypted.");
    } catch (error) {
      const text = `${submitted ? "NOT CONFIRMED — refresh vault status before retrying." : "NOT SUBMITTED."} ${error.message}`;
      if (active()) { vaultFeedback.className = "root-password-feedback error"; vaultFeedback.textContent = text; } else toast(text);
    } finally { payload.password = ""; enrolling = false; vaultButton.disabled = false; }
  });
  async function loadVault() {
    try {
      const data = await api("/api/database/vault", { signal: controller.signal, cache: "no-store" });
      if (active()) vaultStatus.textContent = `${data.configured ? "Key path configured" : "External encryption key not configured"} · ${data.enrolled ? `Credential enrolled, revision ${data.revision}, ${new Date(data.updatedAt).toLocaleString()}` : "No credential enrolled"}.`;
    } catch (error) { if (active()) vaultStatus.textContent = error.message; }
  }
  await Promise.all([load(), loadResult(), loadVault(), loadProfile()]);
};
VIEWS["server-users"] = VIEWS["server-profile"];
