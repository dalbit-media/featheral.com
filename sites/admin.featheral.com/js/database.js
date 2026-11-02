"use strict";
VIEWS.database = async (_q, token) => {
  renderSidebar("database"); setCrumbs("<b>Database journals</b>");
  setView(`<section class="card form-grid"><h1>File ledgers</h1><p class="note">Staged migration: existing site databases remain authoritative. Cross-ledger transactions and site-storage cutover are not enabled. Uploads and all existing data are untouched.</p>
    <div class="row"><button id="database-refresh" class="btn">Verify &amp; refresh</button><span id="database-status" role="status">Loading…</span></div>
    <div class="table-wrap"><table><thead><tr><th>Namespace</th><th>Transactions</th><th>Documents</th><th>Last write</th><th></th></tr></thead><tbody id="database-streams"></tbody></table></div>
    <div id="database-records" role="status"></div></section>`, token);
  const controller = new AbortController(), hash = location.hash;
  const active = () => token === state.seq && !controller.signal.aborted && location.hash === hash;
  const status = $("#database-status"), rows = $("#database-streams"), records = $("#database-records");
  let browseSequence = 0;
  viewCleanup = () => { controller.abort(); };
  async function load() {
    $("#database-refresh").disabled = true;
    try {
      const data = await api("/api/database", { signal: controller.signal, cache: "no-store" });
      if (!active()) return;
      rows.innerHTML = data.streams.map(stream => `<tr><td class="mono">${esc(stream.namespace)}</td><td>${stream.sequence}</td><td>${stream.documents}</td><td>${stream.lastAt ? esc(new Date(stream.lastAt).toLocaleString()) : "Empty"}</td><td><button class="btn" data-ledger="${esc(stream.namespace)}">Inspect</button></td></tr>`).join("");
      status.textContent = "Hash chains and document revisions verified. Empty journals are not migrated balances.";
    } catch (error) { if (active()) status.textContent = `Verification failed: ${error.message}`; }
    finally { if (active()) $("#database-refresh").disabled = false; }
  }
  rows.addEventListener("click", async event => {
    const target = event.target.closest("[data-ledger]");
    if (!target || !active()) return;
    const sequence = ++browseSequence;
    records.textContent = "Verifying journal…";
    try {
      const data = await api(`/api/database/records?${new URLSearchParams({ namespace: target.dataset.ledger })}`, { signal: controller.signal });
      if (!active() || sequence !== browseSequence) return;
      records.innerHTML = `<h3>${esc(target.dataset.ledger)}</h3><p class="muted">Newest 50 transactions. Metadata only; no private document or vault contents.</p>${data.records.length
        ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Time</th><th>Changes</th><th>SHA-256</th></tr></thead><tbody>${data.records.map(record => `<tr><td>${record.sequence}</td><td>${esc(new Date(record.at).toLocaleString())}</td><td>${record.changes}</td><td class="mono">${esc(record.hash)}</td></tr>`).join("")}</tbody></table></div>` : "<p>Empty journal.</p>"}`;
    } catch (error) { if (active() && sequence === browseSequence) records.textContent = error.message; }
  });
  $("#database-refresh").addEventListener("click", () => load());
  await load();
};
