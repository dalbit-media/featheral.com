"use strict";
VIEWS.notes = async (_q, token) => {
  const [summary, sites, market, dollar] = await Promise.all([api("/api/notes"), api("/api/notes/sites"), api("/api/notes/markets"), api("/api/notes/dollar-pool")]);
  if (token !== state.seq) return;
  const eligible = market.markets.filter(row => !row.funded && !row.reserved);
  const canFund = eligible.some(row => market.treasuryFthx >= row.targetFthx);
  const fixed = summary.fthx.fixedSupply, unit = 10n ** 18n;
  const exact = raw => {
    const value = BigInt(raw), fraction = (value % unit).toString().padStart(18, "0").replace(/0+$/, "");
    return `${value / unit}${fraction ? "." + fraction : ""}`;
  };
  const dollarUnits = value => {
    if (!/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error("Enter an exact positive FTH$ amount with up to 18 decimals.");
    const [whole, fraction = ""] = value.split(".");
    const raw = BigInt(whole) * unit + BigInt(fraction.padEnd(18, "0"));
    if (raw <= 0n) throw new Error("FTH$ funding must be positive.");
    return raw;
  };
  renderSidebar("notes"); setCrumbs("<b>Native Notes / currencies & markets</b>");
  setView(`<div class="card"><h1>Fixed FTHX market supply</h1>
    <p>One-time issuance only. Existing circulating balances count toward the chosen total; the remaining initial supply goes to the owner wallet. No automatic top-ups or reward issuance. Locked FTH$ settlement backing is separate and cannot fund liquidity. FTHG/FTHS policies are unchanged; FTH$ remains subject to its own reserve rules, not this fixed market-supply policy.</p>
    <p>Circulating: <b>${esc(exact(summary.fthx.circulating))} FTHX</b> / locked backing: ${esc(exact(summary.fthx.reserved))} FTHX.</p>
    ${fixed.initialized ? `<p>Supply permanently fixed at <b>${esc(exact(fixed.supply))} FTHX</b>. Initial allocation wallet: <code>${esc(fixed.owner)}</code>. Issued once: ${esc(exact(fixed.issued))} FTHX. Request: <code>${esc(fixed.requestId)}</code>.</p>` : `
    <form id="fthx-supply" class="form-grid"><label>Final fixed market supply (whole FTHX)<input name="supply" inputmode="numeric" pattern="[1-9][0-9]*" required></label>
    <label>Initial allocation wallet<input name="owner" pattern="0x[0-9a-fA-F]{40}" value="${esc(dollar.owner)}" required></label>
    <p>Exact approval: <code id="fthx-supply-phrase">Enter the supply and wallet to review.</code></p>
    <label>Approval<input name="approval" required autocomplete="off"></label><button class="btn">Review one-time issuance</button><p role="status"></p></form>`}</div>
    <div class="card"><h2>Start FTH$ / FTHX trading</h2>
    <p>Opening liquidity is <b>1 FTH$ = 100 FTHX</b>, not a peg. Trades then set a dynamic price with a 0.3% fee. Funding spends existing main-wallet FTH$ and FTHX; it never creates FTH$. Initial capital has no LP withdrawal interface.</p>
    <p>Pool: ${dollar.pool.funded ? `${esc(exact(dollar.pool.dollars))} FTH$ / ${esc(String(dollar.pool.fthx))} FTHX` : "Unfunded"}.
    ${dollar.pool.settlementEnabled ? "Dollar writer connected." : "Dollar writer unavailable: use the authoritative combined server with its original signing key."}</p>
    ${dollar.requests.map(request => `<p>Funding ${esc(request.id)}: ${esc(request.status)} <button class="btn" type="button" data-resume-dollar="${esc(request.id)}">Review and resume</button></p>`).join("")}
    ${!dollar.pool.funded && fixed.initialized && !dollar.requests.length ? `<form id="dollar-funding" class="form-grid"><label>Funding wallet<input name="owner" value="${esc(dollar.owner)}" readonly></label>
    <label>Existing FTH$ to commit<input name="dollars" inputmode="decimal" required></label>
    <p id="dollar-funding-phrase">Enter FTH$ to review the matching FTHX and exact approval.</p><label>Approval<input name="approval" required autocomplete="off"></label>
    <button class="btn" ${dollar.pool.settlementEnabled ? "" : "disabled"}>Review initial pool funding</button></form>` : !fixed.initialized ? "<p>Initialize the fixed FTHX market supply first.</p>" : ""}
    <p id="dollar-funding-status" role="status"></p></div>
    <div class="card"><h2>Native Notes &amp; rewards</h2><p>FTH$, FTHX and FTHS remain system-native currencies. Regular community rewards cannot mint them. Ethereum operations stay with Gold.</p><p>${fmtNum(summary.reactions.attempts)} reaction attempts / ${fmtNum(summary.reactions.awarded)} awarded</p>
    <div class="table-wrap"><table><thead><tr><th>Site</th><th>Reward note</th><th>Chance %</th><th>Amount</th><th>Enabled</th><th></th></tr></thead><tbody>${sites.map(site => `<tr data-reward="${esc(site.key)}"><td>${esc(site.hostname + (site.path || ""))}</td><td><input name="symbol" value="${esc(site.program.symbol)}" maxlength="16" aria-label="Reward note"></td><td><input name="chance" type="number" min="1" max="99" value="${site.program.chance}" aria-label="Reward chance"></td><td><input name="amount" type="number" min="1" max="1000" value="${site.program.amount}" aria-label="Reward amount"></td><td><input name="enabled" type="checkbox" ${site.program.enabled ? "checked" : ""} aria-label="Enable rewards"></td><td><button class="btn sm" data-save-reward>Save</button></td></tr>`).join("")}</tbody></table></div><p id="notes-status" role="status"></p></div>
    <div class="card"><h2>Exchange liquidity</h2><p>System treasury: <b>${fmtNum(market.treasuryFthx)} FTHX</b>. Funding is an explicit financial action, not startup behavior. It consumes existing treasury FTHX and creates the approved native note liquidity through the unchanged Notes API.</p>
    <div class="table-wrap"><table><thead><tr><th>Pair</th><th>FTHX reserve</th><th>Note reserve</th><th>State</th></tr></thead><tbody>${market.markets.map(row => `<tr><td>${esc(row.symbol)} / FTHX</td><td>${fmtNum(row.baseReserve)}</td><td>${fmtNum(row.noteReserve)}</td><td>${row.reserved ? "Reserved; not tradable" : row.funded ? "Funded" : "Unfunded"}</td></tr>`).join("")}</tbody></table></div>
    <form id="notes-funding"><label>Unfunded eligible note<select name="symbol" required>${options(eligible.map(row => row.symbol), _q.market || "", "Choose note")}</select></label><p>Exact approval is <code>FUND &lt;symbol&gt; 1000000 FTHX 1000000 NOTES</code>. Review the selected note before confirming.</p><label>Approval<input name="approval" required autocomplete="off"></label><button class="btn" ${canFund ? "" : "disabled"}>Review pool funding</button><p role="status">${canFund ? "" : eligible.length ? "Insufficient treasury FTHX. No funding was performed." : "No eligible unfunded notes."}</p></form></div>
    <div class="card"><h2>Wallet balances</h2><form id="notes-wallet" class="row"><label>Wallet address<input name="address" pattern="0x[0-9a-fA-F]{40}" required></label><button class="btn">Look up</button></form><pre id="notes-balances"></pre></div>`, token);
  const rewardStatus = $("#notes-status"), balances = $("#notes-balances");
  const assertActive = () => { if (token !== state.seq) throw new Error("Administration view changed. Review the action again."); };
  const supplyForm = $("#fthx-supply"), fundingForm = $("#dollar-funding");
  if (supplyForm) {
    const requestId = crypto.randomUUID();
    supplyForm.addEventListener("input", () => {
      $("#fthx-supply-phrase").textContent = `INITIALIZE FTHX ${supplyForm.elements.supply.value} TO ${supplyForm.elements.owner.value.trim().toLowerCase()}`;
    });
    supplyForm.addEventListener("submit", async event => {
      event.preventDefault(); const button = $("button", supplyForm); button.disabled = true;
      try {
        assertActive();
        const supply = supplyForm.elements.supply.value, owner = supplyForm.elements.owner.value.trim().toLowerCase();
        const approval = supplyForm.elements.approval.value;
        if (approval !== `INITIALIZE FTHX ${supply} TO ${owner}`) throw new Error("Enter the exact one-time supply approval.");
        if (!confirm(`Permanently fix the circulating market supply at ${supply} FTHX and issue the difference to ${owner}? This cannot be repeated or increased. Locked settlement backing is separate.`)) return;
        assertActive();
        await api("/api/notes/fthx/supply", { json: { supply, owner, approval, requestId } });
        toast("Fixed FTHX supply initialized"); if (token === state.seq) await VIEWS.notes(_q, token);
      } catch (error) { console.error(error); $('[role="status"]', supplyForm).textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  const fundingAmounts = () => {
    const dollars = dollarUnits(fundingForm.elements.dollars.value);
    if (dollars * 100n % unit) throw new Error("The opening 100:1 ratio requires whole FTHX: use FTH$ increments of 0.01.");
    const fthx = dollars * 100n / unit;
    return { dollars: dollars.toString(), fthx: fthx.toString(), approval: `FUND FTH$ ${dollars} BASE_UNITS ${fthx} FTHX` };
  };
  async function completeFunding(request) {
    let signature;
    if (["prepared", "awaiting_signature"].includes(request.status) && request.message) {
      if (!window.ethereum) throw new Error("Select the funding wallet in an external wallet provider to authorize this FTH$ payment.");
      const owner = dollar.owner.toLowerCase(), accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts[0]?.toLowerCase() !== owner) throw new Error("Select the funding owner wallet before signing.");
      assertActive();
      signature = await window.ethereum.request({ method: "personal_sign", params: [
        "0x" + [...new TextEncoder().encode(request.message)].map(byte => byte.toString(16).padStart(2, "0")).join(""), owner,
      ] });
      if ((await window.ethereum.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== owner) throw new Error("Funding wallet changed while signing. Reload and resume the original request.");
    }
    assertActive();
    await api(`/api/notes/dollar-pool/${encodeURIComponent(request.id)}/complete`, { json: { owner: dollar.owner, signature } });
    toast("Initial liquidity funded"); if (token === state.seq) await VIEWS.notes(_q, token);
  }
  if (fundingForm) {
    const requestId = crypto.randomUUID();
    let pendingInput;
    fundingForm.elements.dollars.addEventListener("input", () => {
      try { const input = fundingAmounts(); $("#dollar-funding-phrase").textContent = `${input.fthx} FTHX required. Exact approval: ${input.approval}`; }
      catch (error) { $("#dollar-funding-phrase").textContent = error.message; }
    });
    fundingForm.addEventListener("submit", async event => {
      event.preventDefault(); const button = $("button", fundingForm); button.disabled = true;
      try {
        assertActive();
        const input = pendingInput || { ...fundingAmounts(), owner: dollar.owner, requestId };
        if (!pendingInput && fundingForm.elements.approval.value !== input.approval) throw new Error("Enter the exact initial pool funding approval.");
        if (!confirm(`${pendingInput ? "Resume the original funding request. " : ""}Commit ${exact(input.dollars)} existing FTH$ and ${input.fthx} FTHX from ${input.owner}? Initial capital has no LP withdrawal interface. Trades will change the opening 100:1 price.`)) return;
        assertActive(); pendingInput = input;
        const request = await api("/api/notes/dollar-pool/fund", { json: input });
        await completeFunding(request);
      } catch (error) { console.error(error); $("#dollar-funding-status").textContent = `${error.message} Reload this page to review any saved funding request before starting another.`; }
      finally { button.disabled = !dollar.pool.settlementEnabled; }
    });
  }
  for (const button of $$("[data-resume-dollar]")) button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      assertActive();
      const saved = dollar.requests.find(request => request.id === button.dataset.resumeDollar);
      if (!confirm(`Resume funding ${saved.id}: ${exact(saved.parameters.dollars)} FTH$ + ${saved.parameters.fthx} FTHX? Use this original request, not a replacement.`)) return;
      assertActive();
      const request = await api(`/api/notes/dollar-pool/${encodeURIComponent(saved.id)}/refresh`, { json: { owner: dollar.owner } });
      await completeFunding(request);
    } catch (error) { console.error(error); $("#dollar-funding-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
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
