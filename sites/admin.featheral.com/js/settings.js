"use strict";
function settingsControlsHtml(fields) {
  return fields.map(field => {
    const name = esc(field.name), value = esc(field.value);
    const placeholder = field.secret ? field.configured ? "Saved; blank keeps it" : "Not configured" : "Use default";
    const control = field.type === "enum"
      ? `<select name="runtime-${name}"><option value="">Use default</option>${field.options.map(option => `<option${field.value === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>`
      : `<input name="runtime-${name}" type="${field.secret ? "password" : field.type === "integer" ? "number" : "text"}"${field.type === "integer" ? ` min="${field.min}" max="${field.max}"` : ""} value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">`;
    return `<label>${esc(field.label)}${control}</label>${field.configured ? `<label class="small"><input type="checkbox" name="clear-${name}"> Reset ${esc(field.label.toLowerCase())}</label>` : ""}`;
  }).join("");
}
function changedServiceSettings(form, fields) {
  const runtime = {};
  for (const field of fields) {
    const value = form.elements[`runtime-${field.name}`].value;
    if (form.elements[`clear-${field.name}`]?.checked) runtime[field.name] = null;
    else if (field.secret ? value !== "" : value !== field.value) runtime[field.name] = value;
  }
  return runtime;
}

VIEWS.settings = async (_q, token) => {
  renderSidebar("settings"); setCrumbs("<b>Settings</b>");
  setView(`<div class="server-profile-dashboard"><section class="server-profile-heading"><h1>Settings</h1><span id="settings-status" role="status">Loading...</span></section>
    <section class="card form-grid settings-deployment"><h2>Deployment</h2>
    <form id="operations-settings" class="form-grid" autocomplete="off">
        <h3>1. Connection</h3>
        <label>Server host<input name="host" placeholder="featheral.com" required></label>
        <label>SSH port<input name="port" type="number" min="1" max="65535" required></label>
        <label>Root password or user:password<input name="credential" type="password" placeholder="Root password or user:password" maxlength="2048" autocomplete="new-password" required></label>
        <span id="settings-credential" class="muted small"></span>
        <label>Deployment directory<input name="directory" required placeholder="/opt/featheral"></label>
        <label>Certificate email<input name="tlsEmail" type="email" required></label>
        <p class="muted small">A password alone uses root. Blank keeps a verified saved credential. SSH/sudo are checked before saving; the server key is automatically pinned on first use. Enroll over a trusted network. Site-specific connections stay in each site's menu.</p>
        <div class="row"><button id="settings-save" class="btn primary" type="submit">Sign &amp; save connection</button><button id="settings-reload" class="btn" type="button">Reload</button><span id="settings-feedback" role="status" aria-live="polite"></span></div>
    </form>
    ${deploymentControlsHtml()}
    </section></div>`, token);
  const controller = new AbortController(), hash = location.hash, form = $("#operations-settings");
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === hash;
  const feedback = $("#settings-feedback"), button = $("#settings-save");
  let revision = 0, saving = false, loaded = false, saved = "", savedHost = "", savedPort = 22, enrolled = false;
  const snapshot = () => JSON.stringify(Object.fromEntries(new FormData(form)));
  button.disabled = true;
  const names = ["host", "port", "directory", "tlsEmail"];
  const numbers = new Set(["port"]);
  viewCleanup = () => { controller.abort(); form.reset(); };
  leaveView = () => !saving && (!loaded || snapshot() === saved || confirm("Discard unsaved deployment settings?"));
  async function load() {
    loaded = false; button.disabled = true;
    try {
      const data = await api("/api/settings", { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      revision = data.revision;
      loaded = true;
      for (const name of names) form.elements[name].value = data[name];
      form.elements.credential.value = "";
      form.elements.credential.required = !data.enrolled;
      enrolled = data.enrolled;
      savedHost = data.host; savedPort = data.port;
      $("#settings-status").textContent = data.configured ? `Revision ${revision}` : "External bootstrap required";
      $("#settings-credential").textContent = data.enrolled ? `Stored: ${data.username} (encrypted)` : "No credential stored";
      saved = snapshot();
      button.disabled = !data.configured;
    } catch (error) { if (active()) feedback.textContent = `Settings unavailable: ${error.message}`; }
  }
  $("#settings-reload").addEventListener("click", () => { if (!saving) load(); });
  form.addEventListener("input", () => {
    form.elements.credential.required = !enrolled || form.elements.host.value.trim() !== savedHost || Number(form.elements.port.value) !== savedPort;
    $("#deployment-start").disabled = true;
    $("#deployment-approval").disabled = true;
    $("#deployment-phrase").value = "";
    $("#deployment-summary").textContent = "Connection changed. Save and review again.";
    $("#deployment-details").textContent = "Connection changed. Save and review a new deployment plan.";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || saving || !loaded) return;
    saving = true; button.disabled = true;
    const settings = Object.fromEntries(names.map(name => [name, numbers.has(name) ? Number(form.elements[name].value) : form.elements[name].value.trim()]));
    settings.enabled = true;
    if (form.elements.credential.value) settings.credential = form.elements.credential.value;
    for (const element of form.querySelectorAll("input, button, textarea, select")) element.disabled = true;
    const payload = { revision, settings };
    let submitted = false;
    try {
      feedback.textContent = "Review the Admin-wallet approval...";
      const challenge = await api("/api/settings/challenge", { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Settings not submitted.");
      feedback.textContent = "Verifying credentials and saving...";
      submitted = true;
      const result = await api("/api/settings", { json: payload });
      if (result.revision !== revision + 1) throw new Error("Settings save was not confirmed.");
      if (active()) {
        feedback.textContent = "Settings saved.";
        revision = result.revision;
        form.elements.credential.value = "";
        savedHost = result.host; savedPort = result.port;
        form.elements.credential.required = !result.enrolled;
        enrolled = result.enrolled;
        $("#settings-status").textContent = `Revision ${result.revision}`;
        $("#settings-credential").textContent = result.enrolled ? `Stored: ${result.username} (encrypted)` : "No credential stored";
      } else toast("Settings saved.");
    } catch (error) {
      const text = `${submitted ? "Save not confirmed; reload before retrying." : "Not saved."} ${error.message}`;
      if (active()) feedback.textContent = text; else toast(text);
    } finally {
      delete settings.credential;
      saving = false;
      if (active()) {
        for (const element of form.querySelectorAll("input, button, textarea, select")) element.disabled = false;
        if (submitted && revision === payload.revision + 1) saved = snapshot();
      }
    }
  });
  await load();
  if (active()) await mountDeploymentControls(token, () => loaded && !saving && snapshot() === saved);
};

VIEWS["site-server"] = async (key, _q, token) => {
  const catalog = await api("/api/sites");
  if (token !== state.seq) return;
  const site = catalog.find(site => site.key === key);
  if (!site) throw new Error("Unknown managed site.");
  state.integratedSites = catalog;
  renderSidebar("site-server");
  setCrumbs(`<b>${esc(site.hostname + (site.path || ""))}</b> <span class="muted">/ Server &amp; settings</span>`);
  setView(`<section class="card form-grid">
    <div class="card-head"><h1>Server &amp; settings</h1><span id="site-server-status" class="muted small" role="status">Loading...</span></div>
    <form id="site-server-form" class="form-grid" autocomplete="off">
      <label>Server<select name="useShared"><option value="true">Shared server</option><option value="false">Separate server</option></select></label>
      <p id="site-shared-server" class="muted small"></p>
      <div id="site-server-connection" class="form-grid" hidden>
        <label>Server URL<input name="url" type="url" placeholder="https://db.example.com/" maxlength="2048"></label>
        <div class="grid g2"><label>SSH host<input name="host" placeholder="db.example.com"></label>
          <label>SSH port<input name="port" type="number" min="1" max="65535"></label></div>
        <label>SSH / sudo credential<input name="credential" type="password" placeholder="username:password; blank keeps saved" maxlength="2048" autocomplete="new-password"></label>
        <span id="site-server-credential" class="muted small"></span>
        <p class="muted small">SSH and sudo are checked before saving. The server key is automatically pinned on first successful connection; later key changes are blocked. Enroll over a trusted network. Blank credentials retain the saved value.</p>
      </div>
      <p class="note">All sites use the shared server by default. Save the target connection, point DNS to it, then review and run Deployment. Deployment copies code, not private data. Use the separate one-time data sync below to create a read-only replica.</p>
      <details id="site-service-settings" class="server-info" hidden><summary>Service settings</summary>
        <div id="site-service-controls" class="form-grid"></div>
        <p class="muted small">Applies to this installation after restart, not automatically to the remote server. Back up storage and keys together. Storage paths, encryption keys and reserve mode require a planned restart; live reserve mode can allocate reserves. Other low-level settings are preserved.</p>
        <label class="small"><input name="applyRuntime" type="checkbox"> I have reviewed these service changes and the backup/restart requirements.</label>
      </details>
      <div class="row"><button id="site-server-save" class="btn primary" type="submit" disabled>Sign &amp; save</button><button id="site-server-reload" class="btn" type="button">Reload</button></div>
      <p id="site-server-feedback" role="status" aria-live="polite"></p>
    </form>
  </section>
  <section class="card form-grid">
    <div class="card-head"><h2>Sync databases &amp; uploads</h2><span class="muted small">One-time source &rarr; target</span></div>
    <p>Selecting this site chooses its saved server, but sync includes the <b>entire installation's databases, journals and uploads</b>. Deploy the current sync-capable release to the target first.</p>
    <p class="note">The target is stopped briefly. A checksum-verified backup is required before replacing its databases and journal history. Source files overwrite matching uploads; target-only uploads and unrelated data remain. Server Settings, Admin/SSH credentials and signing keys are not copied. The target restarts as a read-only snapshot; the source remains the writer.</p>
    <p class="muted small">Preparing a consistent snapshot can briefly pause source requests. No transfer starts until you review the snapshot and approve it with the Admin wallet. Custom storage outside this installation's data directories is not supported.</p>
    <div class="row"><button id="site-sync-review" type="button" class="btn">Prepare sync review</button><button id="site-sync-refresh" type="button" class="btn">Refresh status</button><button id="site-sync-check" type="button" class="btn" hidden>Sign &amp; recheck target status</button></div>
    <div id="site-sync-plan" class="form-grid" hidden></div>
    <label><input id="site-sync-confirm" type="checkbox" disabled> Replace target databases after backup and make the target read-only.</label>
    <button id="site-sync-start" type="button" class="btn primary" disabled>Sign &amp; sync to target</button>
    <p id="site-sync-status" role="status" aria-live="polite"></p>
  </section>`, token);
  const form = $("#site-server-form"), button = $("#site-server-save"), feedback = $("#site-server-feedback");
  const controller = new AbortController(), hash = location.hash, endpoint = `/api/settings/sites/${encodeURIComponent(key)}`;
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === hash;
  let revision = 0, saving = false, syncing = false, syncBlocked = false, syncPlan = null, syncTimer, loaded = false, fields = [], saved = "";
  const snapshot = () => JSON.stringify(Object.fromEntries(new FormData(form)));
  const dirty = () => loaded && snapshot() !== saved;
  const beforeUnload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  viewCleanup = () => { controller.abort(); clearTimeout(syncTimer); window.removeEventListener("beforeunload", beforeUnload); form.reset(); };
  leaveView = () => !saving && !syncing && (!dirty() || confirm("Discard unsaved site settings?"));
  const syncStatus = $("#site-sync-status"), syncReview = $("#site-sync-review"), syncStart = $("#site-sync-start"), syncConfirm = $("#site-sync-confirm");
  function clearSyncPlan() {
    syncPlan = null; $("#site-sync-plan").hidden = true; syncConfirm.checked = false; syncConfirm.disabled = true; syncStart.disabled = true;
  }
  form.addEventListener("input", clearSyncPlan);
  syncConfirm.addEventListener("change", () => { syncStart.disabled = !syncPlan || !syncConfirm.checked || syncing; });
  async function refreshSync() {
    clearTimeout(syncTimer);
    try {
      const result = await api(`${endpoint}/sync`, { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      syncStatus.textContent = `${result.host ? `${result.host}: ` : ""}${result.phase}${result.message ? ` - ${result.message}` : ""}`;
      syncBlocked = result.running || result.phase === "uncertain";
      syncReview.disabled = syncBlocked || syncing;
      $("#site-sync-check").hidden = result.phase !== "uncertain" || result.site !== key;
      if (result.running) syncTimer = setTimeout(refreshSync, 2000);
    } catch (error) { if (active()) syncStatus.textContent = `Sync status unavailable: ${error.message}`; }
  }
  $("#site-sync-refresh").addEventListener("click", refreshSync);
  $("#site-sync-check").addEventListener("click", async () => {
    if (!active() || syncing || saving || dirty()) return;
    syncing = true;
    try {
      syncStatus.textContent = "Approve a read-only check of the previous target job and backup receipt...";
      const challenge = await api(`${endpoint}/sync/check/challenge`, { json: {}, signal: controller.signal });
      const approval = await approveAdminAction(challenge, active);
      if (!active()) throw new Error("View changed. Status check not submitted.");
      await api(`${endpoint}/sync/check`, { json: approval });
      if (active()) await refreshSync();
    } catch (error) { if (active()) syncStatus.textContent = `Target status not confirmed: ${error.message}`; }
    finally { syncing = false; if (active()) syncReview.disabled = syncBlocked; }
  });
  syncReview.addEventListener("click", async () => {
    if (!active() || saving || syncing) return;
    if (!loaded || dirty()) { syncStatus.textContent = "Save or reload the site Settings before reviewing sync."; return; }
    syncing = true; syncReview.disabled = true; form.inert = true; clearSyncPlan();
    try {
      syncStatus.textContent = "Preparing and verifying the source snapshot. No target transfer has started...";
      const review = await api(`${endpoint}/sync/plan`, { json: {}, signal: controller.signal });
      if (!active()) return;
      syncPlan = review;
      const panel = $("#site-sync-plan");
      panel.innerHTML = `<b>Target: ${esc(review.host)}:${esc(review.port)}</b><span>${esc(review.directory)}</span>
        <span>${esc(review.files)} files &middot; ${esc((review.bytes / 1024 ** 2).toFixed(2))} MiB &middot; snapshot ${esc(review.createdAt)}</span>
        <span class="small">Assigned sites: ${esc(review.hosts.join(", "))}</span>
        <span class="small">Review expires ${esc(review.expiresAt)}. This is a fixed snapshot, not continuous replication.</span>
        <ul>${review.exclusions.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
      panel.hidden = false; syncConfirm.disabled = false;
      syncStatus.textContent = "Review the target and replacement scope, then confirm and sign.";
    } catch (error) { if (active()) syncStatus.textContent = `Sync review failed: ${error.message}`; }
    finally { syncing = false; if (active()) { syncReview.disabled = syncBlocked; form.inert = false; } }
  });
  syncStart.addEventListener("click", async () => {
    if (!active() || syncing || saving || !syncPlan || !syncConfirm.checked) return;
    if (dirty()) { clearSyncPlan(); syncStatus.textContent = "Settings changed. Save them and prepare a new review."; return; }
    syncing = true; syncStart.disabled = true; syncReview.disabled = true; form.inert = true;
    let submitted = false;
    try {
      const payload = { plan: syncPlan.id };
      syncStatus.textContent = "Review the Admin-wallet sync approval...";
      const challenge = await api(`${endpoint}/sync/challenge`, { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Sync not submitted.");
      submitted = true;
      await api(`${endpoint}/sync/start`, { json: payload });
      if (active()) { clearSyncPlan(); await refreshSync(); }
      else toast("Sync submitted. Check Settings for confirmed status.");
    } catch (error) {
      if (active()) syncStatus.textContent = `${submitted ? "Sync submission not confirmed; refresh status before retrying." : "Sync not started."} ${error.message}`;
      else toast(error.message);
    } finally { syncing = false; if (active()) { form.inert = false; syncReview.disabled = syncBlocked; syncStart.disabled = !syncPlan || !syncConfirm.checked; } }
  });
  function showConnection() {
    const shared = form.elements.useShared.value === "true";
    $("#site-server-connection").hidden = shared;
    $("#site-shared-server").hidden = !shared;
    for (const name of ["url", "host", "port"]) form.elements[name].required = !shared;
    for (const name of ["url", "host", "port", "credential"]) form.elements[name].disabled = shared;
  }
  function display(data) {
    revision = data.revision;
    for (const name of ["url", "host", "port"]) form.elements[name].value = data[name];
    form.elements.useShared.value = String(data.useShared);
    form.elements.credential.value = "";
    form.elements.applyRuntime.checked = false;
    fields = data.controls;
    $("#site-service-controls").innerHTML = settingsControlsHtml(fields);
    $("#site-service-settings").hidden = !fields.length;
    $("#site-server-credential").textContent = data.enrolled ? `Saved: ${data.username} (encrypted)` : "No site credential saved.";
    $("#site-shared-server").textContent = data.sharedEnrolled ? `Shared SSH: ${data.sharedHost}:${data.sharedPort}` : "Shared SSH is not configured. Configure it in All sites > Settings.";
    $("#site-server-status").textContent = `Revision ${revision}${data.restartRequired ? " - restart required" : ""}`;
    loaded = true;
    showConnection();
    saved = snapshot();
  }
  async function load() {
    loaded = false;
    button.disabled = true;
    try {
      const data = await api(endpoint, { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      display(data); button.disabled = false;
      feedback.textContent = "";
    } catch (error) { if (active()) feedback.textContent = `Site settings unavailable: ${error.message}`; }
  }
  form.elements.useShared.addEventListener("change", showConnection);
  $("#site-server-reload").addEventListener("click", () => { if (!saving && (!dirty() || confirm("Discard unsaved site settings?"))) load(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || saving || !loaded) return;
    const settings = { useShared: form.elements.useShared.value === "true" };
    if (!settings.useShared) {
      for (const name of ["url", "host"]) settings[name] = form.elements[name].value.trim();
      settings.port = Number(form.elements.port.value);
      if (form.elements.credential.value) settings.credential = form.elements.credential.value;
    }
    const runtime = changedServiceSettings(form, fields);
    if (Object.keys(runtime).length) {
      if (!form.elements.applyRuntime.checked) { feedback.textContent = "Review and confirm the service backup/restart requirements."; return; }
      settings.runtime = runtime;
      settings.runtimeConfirmation = "APPLY RUNTIME SETTINGS";
    }
    const payload = { revision, settings };
    saving = true; form.inert = true;
    let submitted = false;
    try {
      feedback.textContent = "Review the Admin-wallet approval...";
      const challenge = await api(`${endpoint}/challenge`, { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Site settings not submitted.");
      feedback.textContent = "Verifying and saving...";
      submitted = true;
      const result = await api(endpoint, { json: payload });
      if (result.revision !== revision + 1) throw new Error("Site settings save was not confirmed.");
      if (active()) { display(result); feedback.textContent = "Site settings saved. Review Deployment to apply this server assignment."; }
      else toast("Site settings saved.");
    } catch (error) {
      if (active()) feedback.textContent = `${submitted ? "Save not confirmed; reload before retrying." : "Not saved."} ${error.message}`;
      else toast(error.message);
    } finally {
      delete settings.credential;
      for (const name of Object.keys(runtime)) delete runtime[name];
      saving = false;
      if (active()) form.inert = false;
    }
  });
  await Promise.all([load(), refreshSync()]);
};
