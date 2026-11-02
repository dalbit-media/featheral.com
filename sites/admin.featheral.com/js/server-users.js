"use strict";
VIEWS["server-profile"] = async (q, token) => {
  renderSidebar("server-profile"); setCrumbs("<b>Server profile</b>");
  setView(`<div class="server-profile-dashboard"><section class="server-profile-heading"><div><h1>Server profile</h1><span id="server-profile-status" class="muted small" role="status">Connecting...</span></div>
    <div class="row"><a href="#/settings" class="btn sm">Settings</a><button id="server-profile-refresh" type="button" class="btn sm">Refresh metrics</button><button id="server-storage-refresh" type="button" class="btn sm">Rescan storage</button></div></section>
    <div id="server-profile-stats" class="stats server-profile-overview"></div>
    <section class="server-profile-grid">
    <div class="card"><h2>Disk capacity</h2><div id="server-disk-chart"><p class="muted">Waiting for capacity...</p></div><p id="server-disk-sampled" class="muted small"></p>
    <details class="server-info"><summary>Capacity &amp; forecast info</summary><p>Service filesystem, including other applications and reserved space. Refreshed every five minutes. Net growth uses up to 24 hours since restart; forecasts are estimates. Warning: 85% used or full within 30 days. Critical: 95% or 7 days.</p></details></div>
    <div class="card"><h2>Resource risks</h2><div id="server-profile-risks" class="server-profile-risks"></div>
    <details class="server-info"><summary>Risk thresholds</summary><p>Disk: 85% / 95% used or full in 30 / 7 days. CPU: 80% / 95% of one core. Event-loop p95: 100 / 250 ms. Memory: 80% heap or 85% host / 95% either. HTTP errors: 5% / 20%. Network: 80% / 95% of the capacity configured in Settings.</p></details></div>
    <div class="card"><h2>Application storage</h2><div id="server-profile-storage" class="server-profile-storage"></div><p id="server-storage-status" class="muted small">Waiting for inventory...</p>
    <details class="server-info"><summary>Inventory info</summary><p>Cached scan every five minutes. Excludes dependency and build folders outside managed data; symlinks are not followed. Application totals differ from filesystem capacity.</p></details></div></section>
    <section class="card server-profile-chart-card"><div class="card-head"><h2>Live metrics <span class="muted small">Last minute</span></h2>
    <details class="server-info"><summary>Chart info</summary><p>Each row has its own scale. Process CPU is per core and can exceed 100%. Ingress uses declared Content-Length; response bytes exclude headers.</p></details></div>
    <div id="server-profile-chart" class="server-profile-chart" role="img" aria-label="Recent CPU, memory, event-loop, request, and network metrics"></div></section>
    <section class="card"><div class="card-head"><h2>Server accounts</h2><details class="server-info"><summary>Account info</summary><p>Read-only Linux accounts on the deployment server, not Featheral profiles. Uses the SSH credential in Settings with origin-wallet approval.</p></details></div>
    <form id="server-user-search" class="row"><label>Search accounts<input name="q" value="${esc(q.q || "")}" maxlength="100" type="search" placeholder="Username, UID, home or shell"></label><button class="btn">Sign &amp; search</button><button type="button" class="btn" id="server-users-refresh">Sign &amp; browse</button></form>
    <p id="server-users-status" role="status">Sign to browse server accounts. <a href="#/settings">Manage credentials in Settings</a>.</p>
    <div class="table-wrap"><table><thead><tr><th>Username</th><th>UID</th><th>GID</th><th>Home</th><th>Shell</th></tr></thead><tbody id="server-users-rows"></tbody></table></div>
    <div class="row"><button id="server-users-prev" class="btn" disabled>Previous</button><span id="server-users-page"></span><button id="server-users-next" class="btn" disabled>Next</button></div></section></div>`, token);
  const controller = new AbortController(), viewHash = location.hash;
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === viewHash;
  let page = 1, loading = false, profileLoading = false;
  const status = $("#server-users-status"), rows = $("#server-users-rows"), pageLabel = $("#server-users-page");
  const previous = $("#server-users-prev"), next = $("#server-users-next"), search = $("#server-user-search");
  function renderProfile(data) {
    const m = data.metrics, history = data.history || [], disk = data.disk;
    const averageCpu = history.length ? history.reduce((sum, point) => sum + point.processCpuPct, 0) / history.length : m.processCpuPct;
    $("#server-disk-chart").innerHTML = ServerProfileCharts.renderServerDiskChart(disk);
    $("#server-disk-sampled").textContent = disk.available ? `Capacity sampled ${new Date(disk.sampledAt).toLocaleString()}` : "";
    $("#server-profile-stats").innerHTML = [
      ["CPU average", `${averageCpu.toFixed(1)}%`, `Process, one core; host ${m.hostCpuPct === null ? "unavailable" : `${m.hostCpuPct}%`}`],
      ["Memory", fmtBytes(m.rssBytes), `Heap ${fmtBytes(m.heapUsedBytes)} / ${fmtBytes(m.heapLimitBytes)}`],
      ["Disk free", disk.available ? fmtBytes(disk.freeBytes) : "Unavailable", disk.available ? `${disk.freePct}% available` : disk.error],
      ["Disk growth", !disk.available ? "Unavailable" : disk.growthBytesPerDay === null ? "Collecting" : `${disk.growthBytesPerDay < 0 ? "-" : ""}${fmtBytes(Math.abs(disk.growthBytesPerDay))}/day`, disk.available ? disk.daysUntilFull === null ? "No exhaustion estimate" : `Full in ~${disk.daysUntilFull.toFixed(1)} days` : disk.error],
      ["Requests / min", fmtNum(m.requestCount60s), `${fmtNum(m.requestsPerSecond)} / sec now`],
      ["Latency p95", `${m.latencyP95Ms.toFixed(1)} ms`, `${fmtNum(m.latencySampleCount)} responses`],
      ["HTTP out / min", fmtBytes(m.responseBytes60s), `${fmtBytes(m.responseBytesPerSecond)} / sec now`],
      ["HTTP in / min", fmtBytes(m.requestBytes60s), "Declared request bytes"],
      ["Event loop p95", `${m.eventLoopP95Ms.toFixed(1)} ms`, `Max ${m.eventLoopMaxMs.toFixed(1)} ms`],
      ["Host memory", `${((m.memoryTotalBytes - m.memoryFreeBytes) / m.memoryTotalBytes * 100).toFixed(1)}%`, `${fmtBytes(m.memoryFreeBytes)} free`],
    ].map(([label, value, note]) => `<div class="stat"><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(note)}</div></div>`).join("");
    const riskLabels = { disk: "Disk", memory: "Memory", compute: "Compute", usage: "HTTP errors", network: "Network" };
    const expanded = new Set([...$("#server-profile-risks").querySelectorAll("details[open]")].map(item => item.dataset.risk));
    $("#server-profile-risks").innerHTML = data.risks.map(risk => `<details data-risk="${esc(risk.key)}" class="server-risk-detail ${esc(risk.severity)}"${expanded.has(risk.key) || ["warning", "critical"].includes(risk.severity) ? " open" : ""}><summary><b>${esc(riskLabels[risk.key] || risk.key)}</b><span>${esc(risk.severity.toUpperCase())}</span></summary><p>${esc(risk.message)}</p></details>`).join("");
    const categories = data.storage.categories;
    $("#server-profile-storage").innerHTML = [
      ["Databases", categories.databases], ["Currency & other ledgers", categories.ledgers], ["Uploads", categories.uploads],
      ["Trash", categories.trash], ["Codebase", categories.codebase], ["Other data", categories.otherData],
    ].map(([label, item]) => `<div class="server-storage-item"><span>${esc(label)}</span><b>${fmtBytes(item.bytes)}</b><small>${fmtNum(item.files)} files</small></div>`).join("");
    const stored = data.storage.updatedAt ? `Inventory ${new Date(data.storage.updatedAt).toLocaleTimeString()}; ${fmtNum(data.storage.totalFiles)} files; ${fmtBytes(data.storage.totalBytes)}` : "Inventory has not completed yet.";
    $("#server-storage-status").textContent = stored + (data.storage.scanning ? "; scanning" : data.storage.scanError ? `; ${data.storage.scanError}` : "");
    $("#server-profile-status").textContent = `Sampled ${new Date(data.sampledAt).toLocaleTimeString()}; ${fmtNum(m.uptimeSeconds)} sec uptime`;
    $("#server-profile-chart").innerHTML = ServerProfileCharts.renderServerProfileChart(history);
  }
  async function loadProfile() {
    if (profileLoading || !active()) return;
    profileLoading = true;
    try { const data = await api("/api/server-profile", { signal: controller.signal, cache: "no-store" }); if (active()) renderProfile(data); }
    catch (error) { if (active()) $("#server-profile-status").textContent = `Server profile unavailable: ${error.message}`; }
    finally { profileLoading = false; }
  }
  const stopProfilePolling = ServerProfileCharts.startServerProfilePolling(loadProfile);
  viewCleanup = () => { controller.abort(); stopProfilePolling(); };
  $("#server-profile-refresh").addEventListener("click", loadProfile);
  $("#server-storage-refresh").addEventListener("click", async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await api("/api/server-profile/refresh", { json: {} }); await loadProfile(); }
    catch (error) { if (active()) $("#server-storage-status").textContent = `Rescan failed: ${error.message}`; }
    finally { if (active()) button.disabled = false; }
  });
  async function load() {
    if (loading || !active()) return;
    loading = true; previous.disabled = next.disabled = true;
    status.textContent = "Waiting for wallet approval...";
    try {
      const payload = { page, query: search.elements.q.value };
      const challenge = await api("/api/database/accounts/challenge", { json: payload, signal: controller.signal });
      Object.assign(payload, await approveAdminAction(challenge, active));
      if (!active()) throw new Error("View changed. Account access was not submitted.");
      const data = await api("/api/database/accounts/browse", { json: payload, signal: controller.signal });
      if (!active()) return;
      rows.innerHTML = data.users.map(user => `<tr><td>${esc(user.username)}${user.uid === 0 ? ' <span class="chip warn">Root</span>' : ""}</td><td>${esc(user.uid)}</td><td>${esc(user.gid)}</td><td class="mono">${esc(user.home)}</td><td class="mono">${esc(user.shell)}</td></tr>`).join("");
      status.textContent = `${data.target}: ${data.total} matching / ${data.accounts} accounts.`;
      pageLabel.textContent = `Page ${page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
      previous.disabled = page <= 1; next.disabled = page * data.pageSize >= data.total;
    } catch (error) { if (active()) { status.textContent = error.message; pageLabel.textContent = ""; } }
    finally { loading = false; }
  }
  search.addEventListener("submit", event => { event.preventDefault(); if (!loading) { page = 1; load(); } });
  $("#server-users-refresh").addEventListener("click", load);
  previous.addEventListener("click", () => { page--; load(); });
  next.addEventListener("click", () => { page++; load(); });
  await loadProfile();
};
VIEWS["server-users"] = VIEWS["server-profile"];
