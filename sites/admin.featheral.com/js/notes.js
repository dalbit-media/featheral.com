"use strict";
VIEWS.notes = async (_q, token) => {
  const [summary, sites, market] = await Promise.all([api("/api/notes"), api("/api/notes/sites"), api("/api/notes/markets")]);
  if (token !== state.seq) return;
  const eligible = market.markets.filter(row => !row.funded && !row.reserved);
  const canFund = eligible.some(row => market.treasuryFthx >= row.targetFthx);
  renderSidebar("notes"); setCrumbs("<b>Native Notes / currencies & markets</b>");
  setView(`<div class="card"><h2>Native Notes &amp; rewards</h2><p>FTH$, FTHX and FTHS remain system-native currencies. Regular community rewards cannot mint them. Ethereum operations stay with Gold.</p><p>${fmtNum(summary.reactions.attempts)} reaction attempts / ${fmtNum(summary.reactions.awarded)} awarded</p>
    <div class="table-wrap"><table><thead><tr><th>Site</th><th>Reward note</th><th>Chance %</th><th>Amount</th><th>Enabled</th><th></th></tr></thead><tbody>${sites.map(site => `<tr data-reward="${esc(site.key)}"><td>${esc(site.hostname + (site.path || ""))}</td><td><input name="symbol" value="${esc(site.program.symbol)}" maxlength="16" aria-label="Reward note"></td><td><input name="chance" type="number" min="1" max="99" value="${site.program.chance}" aria-label="Reward chance"></td><td><input name="amount" type="number" min="1" max="1000" value="${site.program.amount}" aria-label="Reward amount"></td><td><input name="enabled" type="checkbox" ${site.program.enabled ? "checked" : ""} aria-label="Enable rewards"></td><td><button class="btn sm" data-save-reward>Save</button></td></tr>`).join("")}</tbody></table></div><p id="notes-status" role="status"></p></div>
    <div class="card"><h2>Exchange liquidity</h2><p>System treasury: <b>${fmtNum(market.treasuryFthx)} FTHX</b>. Funding is an explicit financial action, not startup behavior. It consumes existing treasury FTHX and creates the approved native note liquidity through the unchanged Notes API.</p>
    <div class="table-wrap"><table><thead><tr><th>Pair</th><th>FTHX reserve</th><th>Note reserve</th><th>State</th></tr></thead><tbody>${market.markets.map(row => `<tr><td>${esc(row.symbol)} / FTHX</td><td>${fmtNum(row.baseReserve)}</td><td>${fmtNum(row.noteReserve)}</td><td>${row.reserved ? "Reserved; not tradable" : row.funded ? "Funded" : "Unfunded"}</td></tr>`).join("")}</tbody></table></div>
    <form id="notes-funding"><label>Unfunded eligible note<select name="symbol" required>${options(eligible.map(row => row.symbol), _q.market || "", "Choose note")}</select></label><p>Exact approval is <code>FUND &lt;symbol&gt; 1000000 FTHX 1000000 NOTES</code>. Review the selected note before confirming.</p><label>Approval<input name="approval" required autocomplete="off"></label><button class="btn" ${canFund ? "" : "disabled"}>Review pool funding</button><p role="status">${canFund ? "" : eligible.length ? "Insufficient treasury FTHX. No funding was performed." : "No eligible unfunded notes."}</p></form></div>
    <div class="card"><h2>Wallet balances</h2><form id="notes-wallet" class="row"><label>Wallet address<input name="address" pattern="0x[0-9a-fA-F]{40}" required></label><button class="btn">Look up</button></form><pre id="notes-balances"></pre></div>`, token);
  const rewardStatus = $("#notes-status"), balances = $("#notes-balances");
  const assertActive = () => { if (token !== state.seq) throw new Error("Administration view changed. Review the action again."); };
  for (const row of $$("[data-reward]")) $("[data-save-reward]", row).addEventListener("click", async event => {
    event.target.disabled = true;
    try {
      const value = name => $(`[name="${name}"]`, row);
      assertActive();
      await api(`/api/notes/sites/${encodeURIComponent(row.dataset.reward)}/rewards`, { method: "PUT", json: {
        symbol: value("symbol").value.trim(), chance: Number(value("chance").value), amount: Number(value("amount").value), enabled: value("enabled").checked,
      } });
      toast("Reward program saved");
    } catch (error) { console.error(error); rewardStatus.textContent = error.message; }
    finally { event.target.disabled = false; }
  });
  $("#notes-funding").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, button = $("button", form); button.disabled = true;
    try {
      const symbol = form.elements.symbol.value;
      assertActive();
      const selected = eligible.find(row => row.symbol === symbol);
      if (!selected) throw new Error("Choose an eligible unfunded note.");
      if (market.treasuryFthx < selected.targetFthx) throw new Error("Insufficient treasury FTHX.");
      if (form.elements.approval.value !== `FUND ${symbol} 1000000 FTHX 1000000 NOTES`) throw new Error("Enter the exact approval phrase for the selected note.");
      if (!confirm(`Fund ${symbol} using 1,000,000 existing treasury FTHX and 1,000,000 native notes? This financial action is irreversible here.`)) return;
      assertActive();
      await api(`/api/notes/markets/${encodeURIComponent(symbol)}/fund`, { json: { approval: form.elements.approval.value } });
      toast("Pool funding recorded"); if (token === state.seq) await VIEWS.notes(_q, token);
    } catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; }
    finally { button.disabled = !canFund; }
  });
  $("#notes-wallet").addEventListener("submit", async event => {
    event.preventDefault(); const address = event.target.elements.address.value.trim();
    try { balances.textContent = JSON.stringify(await api(`/api/notes/wallets/${encodeURIComponent(address)}`), null, 2); }
    catch (error) { console.error(error); balances.textContent = error.message; }
  });
};
