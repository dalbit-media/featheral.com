"use strict";
VIEWS.intranet = async (_q, token) => {
  renderSidebar("intranet"); setCrumbs("<b>App / insider management</b>", '<a class="btn sm" id="open-intranet">Open App</a>');
  const local = location.hostname.endsWith(".localhost"), port = location.port ? `:${location.port}` : "";
  $("#open-intranet").href = `${location.protocol}//app.${local ? "localhost" : "featheral.com"}${port}/`;
  const data = await api("/api/intranet/admin"), { org } = data;
  const endpoint = "/api/intranet/admin";
  const memberOptions = selected => options(data.members.filter(member => member.status === "active").map(member => [member.address, `${member.address} / ${member.role}`]), selected, "Choose insider");
  setView(`<div class="card"><h2>Foundation insiders</h2><p>World profile → application → admin approval. Only Admin changes access, roles, learning levels and team assignments.</p>
    <div class="table-wrap"><table><thead><tr><th>Wallet / introduction</th><th>Status</th><th>Role / level</th><th>Division / team</th><th></th></tr></thead><tbody>${data.members.map(member => `<tr data-member="${esc(member.address)}"><td><code>${esc(member.address)}</code><p class="small">${esc(member.motivation)}</p></td><td><select name="status">${options(["pending","active","suspended","rejected"], member.status)}</select></td><td><select name="role">${options(org.roles, member.role)}</select><select name="level">${options(org.levels, member.level)}</select></td><td><select name="division">${options(org.divisions.map(row => [row.id, row.name]), member.division)}</select><select name="team">${options(org.teams.filter(team => team.division === member.division).map(row => [row.id, row.name]), member.team)}</select></td><td><button class="btn sm" data-save-member>Save</button></td></tr>`).join("")}</tbody></table></div>${data.members.length ? "" : "<p>No insider applications yet.</p>"}</div>
    <div class="card"><h2>Teams</h2><form id="work-team" class="row"><label>Division<select name="division">${options(org.divisions.map(row => [row.id,row.name]))}</select></label><label>New team<input name="name" maxlength="80" required></label><button class="btn">Create team</button></form></div>
    <div class="card"><h2>Missions &amp; review</h2><button class="btn sm" id="admin-new-mission">New mission</button><div class="table-wrap"><table><thead><tr><th>Mission</th><th>Team</th><th>Assignee</th><th>Status</th><th></th></tr></thead><tbody>${data.missions.map(mission => `<tr><td>${esc(mission.title)}</td><td>${esc(mission.team)}</td><td>${esc(mission.assignee)}</td><td>${esc(mission.status)}</td><td><button class="btn sm" data-edit-mission="${esc(mission.id)}">Review / edit</button></td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Featheral Silver / FTHS</h2><p>Issued native supply: <b>${fmtNum(data.silver.supply)} FTHS</b>. Whole-unit grants only. No automatic salary, USD peg, guaranteed liquidity or employment entitlement.</p>
    <form id="silver-grant"><label>Recipient<select name="address" required>${memberOptions()}</select></label><label>Amount (whole FTHS)<input name="amount" type="number" min="1" max="1000000000" step="1" required></label><label>Reason<textarea name="reason" maxlength="1000" required></textarea></label><label>Completed mission (optional; cannot be paid twice)<select name="mission">${options(data.missions.filter(mission => mission.status === "done").map(mission => [mission.id,mission.title]), "", "Independent approved grant")}</select></label><label>Exact approval: ISSUE &lt;amount&gt; FTHS<input name="approval" required autocomplete="off"></label><button class="btn">Review &amp; issue grant</button><p id="grant-status" role="status"></p></form>
    <p class="small">Liquidity is separate. Use Notes market funding to approve FTHS / FTHX liquidity; this form does not fund a pool.</p></div>
    <div class="card"><h2>Recent grants</h2>${data.grants.map(grant => `<p><b>${fmtNum(grant.amount)} FTHS</b> → ${esc(grant.address)}<br><small>${esc(grant.reason)} / ${fmtDate(new Date(grant.at).toISOString())}</small></p>`).join("") || "<p>No grants issued.</p>"}</div>
    <div class="card"><h2>Administrative audit</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${data.audit.map(row => `<tr><td>${fmtDate(new Date(row.at).toISOString())}</td><td>${esc(row.actor)}</td><td>${esc(row.action)}</td><td>${esc(row.target)}</td></tr>`).join("")}</tbody></table></div></div>`, token);
  const refresh = () => VIEWS.intranet(_q, token);
  for (const row of $$("[data-member]")) {
    $('select[name="division"]', row).addEventListener("change", event => {
      $('select[name="team"]', row).innerHTML = options(org.teams.filter(team => team.division === event.target.value).map(team => [team.id,team.name]));
    });
    $("[data-save-member]", row).addEventListener("click", async event => {
      event.target.disabled = true;
      try {
        const input = Object.fromEntries($$("select", row).map(select => [select.name, select.value]));
        await api(`${endpoint}/members/${row.dataset.member}`, { method: "PUT", json: input }); toast("Membership saved"); await refresh();
      } catch (error) { console.error(error); toast(error.message); event.target.disabled = false; }
    });
  }
  $("#work-team").addEventListener("submit", async event => {
    event.preventDefault();
    try { await api(`${endpoint}/teams`, { json: Object.fromEntries(new FormData(event.target)) }); await refresh(); }
    catch (error) { console.error(error); toast(error.message); }
  });
  let grantRequest = crypto.randomUUID();
  $("#silver-grant").addEventListener("input", () => { grantRequest = crypto.randomUUID(); });
  $("#silver-grant").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("button", event.target); submit.disabled = true;
    try {
      const input = Object.fromEntries(new FormData(event.target)); input.amount = Number(input.amount); input.request = grantRequest;
      if (!confirm(`Issue ${input.amount} native FTHS to ${input.address}?\n${input.reason}\nThis creates new Silver supply.`)) return;
      await api(`${endpoint}/grants`, { json: input }); toast("Grant recorded"); await refresh();
    } catch (error) { console.error(error); $("#grant-status").textContent = error.message; }
    finally { submit.disabled = false; }
  });
  function editMission(mission) {
    const current = mission || { status: "draft", division: org.divisions[0].id, team: org.teams.find(team => team.division === org.divisions[0].id).id };
    const dialog = modal("Foundation mission", `<form id="admin-mission"><label>Title<input name="title" value="${esc(current.title || "")}" maxlength="160" required></label><label>Brief &amp; acceptance criteria<textarea name="body" maxlength="6000" required>${esc(current.body || "")}</textarea></label><label>Division<select name="division">${options(org.divisions.map(row => [row.id,row.name]),current.division)}</select></label><label>Team<select name="team"></select></label><label>Assignee<select name="assignee"></select></label><label>Status<select name="status">${options(org.states,current.status)}</select></label><label>Evidence / handover<textarea name="evidence" maxlength="6000">${esc(current.evidence || "")}</textarea></label><button class="btn">Save mission</button><p role="status" id="admin-mission-status"></p></form>`);
    const form = $("#admin-mission", dialog);
    const assignees = () => { form.elements.assignee.innerHTML = options(data.members.filter(member => member.status === "active" && member.team === form.elements.team.value).map(member => [member.address,member.address]),current.assignee,"Unassigned"); };
    const teams = () => { form.elements.team.innerHTML = options(org.teams.filter(team => team.division === form.elements.division.value).map(team => [team.id,team.name]),current.team); assignees(); };
    teams(); form.elements.division.addEventListener("change", teams); form.elements.team.addEventListener("change", assignees);
    form.addEventListener("submit", async event => {
      event.preventDefault(); $("button", form).disabled = true;
      try {
        const input = Object.fromEntries(new FormData(form)); if (mission) input.revision = mission.revision;
        await api(`${endpoint}/missions${mission ? "/" + mission.id : ""}`, { method: mission ? "PUT" : "POST", json: input });
        closeModal(); await refresh();
      } catch (error) { console.error(error); $("#admin-mission-status").textContent = error.message; $("button", form).disabled = false; }
    });
  }
  $("#admin-new-mission").addEventListener("click", () => editMission());
  for (const button of $$("[data-edit-mission]")) button.addEventListener("click", () => editMission(data.missions.find(mission => mission.id === button.dataset.editMission)));
};
