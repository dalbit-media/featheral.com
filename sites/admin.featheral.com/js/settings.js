"use strict";
VIEWS.settings = async (_q, token) => {
  renderSidebar("settings"); setCrumbs("<b>Settings</b>");
  setView(`<div class="server-profile-dashboard"><section class="server-profile-heading"><h1>Settings</h1><span id="settings-status" role="status">Loading...</span></section>
    <form id="operations-settings" autocomplete="off">
    <div class="server-profile-grid">
      <section class="card form-grid"><h2>SSH &amp; sudo</h2>
        <label>Server host<input name="host" placeholder="server.example.com"></label>
        <label>SSH port<input name="port" type="number" min="1" max="65535" required></label>
        <label>Host key fingerprint<input name="fingerprint" placeholder="SHA256:..." spellcheck="false"></label>
        <label>SSH / sudo credential<input name="credential" type="password" placeholder="username:password" maxlength="2048" autocomplete="new-password"></label>
        <span id="settings-credential" class="muted small"></span>
        <details class="server-info"><summary>Credential info</summary><p>Password-only or :password uses root. Blank retains the saved credential. The same password authenticates SSH and sudo. A new credential is verified with SSH and sudo before saving. Verify the host fingerprint independently. No server password is changed.</p></details>
      </section>
      <section class="card form-grid"><h2>Deployment &amp; SSL</h2>
        <label>Deployment directory<input name="directory" required placeholder="/opt/featheral"></label>
        <label>Certificate email<input name="tlsEmail" type="email"></label>
        <label><input name="enabled" type="checkbox"> Enable reviewed deployment</label>
        <p class="muted small">SFTP upload; SSH script execution; Node.js 24, PM2, Nginx and Let's Encrypt.</p>
        <details class="server-info"><summary>SSL renewal &amp; deployment info</summary><p>Deployment configures Certbot's systemd renewal timer and an Nginx reload hook. Renewal runs on the target server, not in this browser. Public DNS and ports 80/443 must reach it. Deployments still require a fresh reviewed plan and origin-wallet signature. Existing financial data and bootstrap must be restored before the first deployment.</p></details>
      </section>
      <section class="card form-grid"><h2>Limits &amp; access</h2>
        <label>Upload limit (MiB)<input name="uploadLimitMiB" type="number" min="1" max="1024" required></label>
        <label>HTTP timeout (seconds)<input name="requestTimeoutSeconds" type="number" min="5" max="3600" required></label>
        <label>SSH timeout (seconds)<input name="sshTimeoutSeconds" type="number" min="5" max="120" required></label>
        <label>Deployment timeout (seconds)<input name="deploymentTimeoutSeconds" type="number" min="60" max="7200" required></label>
        <label>Network capacity (bytes/sec; 0 = unknown)<input name="networkLimitBytesPerSecond" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" required></label>
        <label>Admin password<input name="adminPassword" type="password" minlength="16" maxlength="1024" autocomplete="new-password" placeholder="Blank keeps current password"></label>
        <details class="server-info"><summary>Settings &amp; limits info</summary><p>Settings are encrypted in the private system database. Admin passwords are scrypt hashes. Recoverable service secrets are encrypted and never returned. HTTP limits apply after save; Nginx limits apply on deployment. Runtime changes require restart. Existing profiles, balances and financial identities are not moved or regenerated.</p></details>
      </section>
    </div>
    <section class="card"><h2>Runtime &amp; services</h2>
      <p class="muted small">Database managed. Expand a group to edit. Changes require a service restart.</p>
      <details class="server-info"><summary>Storage &amp; financial safety</summary><p>Back up data and the external bootstrap/key together before changing storage paths, signing keys, writer mode or wallet authorities. Keep exactly one writer. Never point a live service at an empty replacement ledger. Changing reserve mode to live can allocate reserves on restart. Review the exact values before signing. Existing user and domain data stays in its current stores.</p></details>
      <div id="settings-runtime" class="server-profile-grid"></div>
      <label>To apply runtime changes, type APPLY RUNTIME SETTINGS<input name="runtimeConfirmation" autocomplete="off"></label>
    </section>
    <div class="row"><button id="settings-save" class="btn primary" type="submit">Sign &amp; save settings</button><button id="settings-reload" class="btn" type="button">Reload</button><span id="settings-feedback" role="status" aria-live="polite"></span></div></form></div>`, token);
  const controller = new AbortController(), hash = location.hash, form = $("#operations-settings");
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === hash;
  const feedback = $("#settings-feedback"), button = $("#settings-save");
  let revision = 0, saving = false, runtimeFields = [];
  const names = ["host", "port", "fingerprint", "directory", "tlsEmail", "uploadLimitMiB", "requestTimeoutSeconds", "sshTimeoutSeconds", "deploymentTimeoutSeconds", "networkLimitBytesPerSecond"];
  const numbers = new Set(["port", "uploadLimitMiB", "requestTimeoutSeconds", "sshTimeoutSeconds", "deploymentTimeoutSeconds", "networkLimitBytesPerSecond"]);
  viewCleanup = () => { controller.abort(); form.reset(); };
  leaveView = () => !saving || confirm("A Settings save may still be running. Verify its status before retrying. Leave?");
  function showRuntime(data) {
    runtimeFields = data.runtimeFields;
    const groups = [...new Set(runtimeFields.map(field => field.group))];
    $("#settings-runtime").innerHTML = groups.map(group => `<details class="server-info"><summary>${esc(group)} <span class="muted small">${runtimeFields.filter(field => field.group === group && field.configured).length} set</span></summary><div class="form-grid">${runtimeFields.filter(field => field.group === group).map(field => {
      const name = esc(field.name), value = esc(field.value), placeholder = field.secret ? field.configured ? "Stored encrypted; blank keeps it" : "Not configured" : "Default";
      const control = ["privatePem", "publicPem", "json"].includes(field.type)
        ? `<textarea name="runtime-${name}" rows="3" spellcheck="false" placeholder="${placeholder}">${value}</textarea>`
        : field.type === "enum" ? `<select name="runtime-${name}"><option value="">Default</option>${field.options.map(option => `<option${field.value === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>`
        : `<input name="runtime-${name}" type="${field.secret ? "password" : field.type === "integer" ? "number" : "text"}"${field.type === "integer" ? ` min="${field.min}" max="${field.max}"` : ""} value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">`;
      return `<label><span class="small">${name}</span>${control}</label>${field.configured ? `<label class="small"><input type="checkbox" name="clear-${name}"> Clear stored value</label>` : ""}`;
    }).join("")}</div></details>`).join("");
    form.elements.runtimeConfirmation.value = "";
    $("#settings-status").textContent = `Revision ${data.revision}${data.restartRequired ? " - restart required" : ""}`;
  }
  async function load() {
    try {
      const data = await api("/api/settings", { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      revision = data.revision;
      for (const name of names) form.elements[name].value = data[name];
      form.elements.enabled.checked = data.enabled;
      form.elements.credential.value = form.elements.adminPassword.value = "";
      form.elements.adminPassword.required = !data.adminConfigured;
      $("#settings-status").textContent = data.configured ? `Revision ${revision}` : "External bootstrap required";
      $("#settings-credential").textContent = data.enrolled ? `Stored: ${data.username} (encrypted)` : "No credential stored";
      showRuntime(data);
      button.disabled = !data.configured;
    } catch (error) { if (active()) feedback.textContent = `Settings unavailable: ${error.message}`; }
  }
  $("#settings-reload").addEventListener("click", () => { if (!saving) load(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || saving) return;
    saving = true; button.disabled = true;
    const settings = Object.fromEntries(names.map(name => [name, numbers.has(name) ? Number(form.elements[name].value) : form.elements[name].value.trim()]));
    settings.enabled = form.elements.enabled.checked;
    if (form.elements.credential.value) settings.credential = form.elements.credential.value;
    if (form.elements.adminPassword.value) settings.adminPassword = form.elements.adminPassword.value;
    const runtime = {};
    for (const field of runtimeFields) {
      const value = form.elements[`runtime-${field.name}`].value;
      if (form.elements[`clear-${field.name}`]?.checked) runtime[field.name] = null;
      else if (field.secret ? value !== "" : value !== field.value) runtime[field.name] = value;
    }
    if (Object.keys(runtime).length) {
      settings.runtime = runtime;
      settings.runtimeConfirmation = form.elements.runtimeConfirmation.value;
    }
    for (const element of form.querySelectorAll("input, button, textarea, select")) element.disabled = true;
    const payload = { revision, settings };
    let submitted = false;
    try {
      feedback.textContent = "Review the origin-wallet approval...";
      const challenge = await api("/api/settings/challenge", { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Settings not submitted.");
      feedback.textContent = "Verifying credentials and saving...";
      submitted = true;
      const result = await api("/api/settings", { json: payload });
      if (result.revision !== revision + 1) throw new Error("Settings save was not confirmed.");
      if (active()) {
        feedback.textContent = settings.adminPassword ? "Saved. Reauthenticate with the new Admin password." : "Settings saved.";
        revision = result.revision;
        form.elements.credential.value = form.elements.adminPassword.value = "";
        showRuntime(result);
        $("#settings-credential").textContent = result.enrolled ? `Stored: ${result.username} (encrypted)` : "No credential stored";
        form.elements.adminPassword.required = false;
      } else toast("Settings saved.");
    } catch (error) {
      const text = `${submitted ? "Save not confirmed; reload before retrying." : "Not saved."} ${error.message}`;
      if (active()) feedback.textContent = text; else toast(text);
    } finally {
      delete settings.credential; delete settings.adminPassword;
      for (const name of Object.keys(runtime)) delete runtime[name];
      saving = false;
      if (active()) for (const element of form.querySelectorAll("input, button, textarea, select")) element.disabled = false;
    }
  });
  await load();
};
