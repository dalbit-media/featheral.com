"use strict";
VIEWS.intranet = async (_q, token) => {
  renderSidebar("intranet"); setCrumbs("<b>App / organization &amp; HR</b>", '<a class="btn sm" id="open-intranet">Open App</a>');
  const local = location.hostname.endsWith(".localhost"), port = location.port ? `:${location.port}` : "";
  $("#open-intranet").href = `${location.protocol}//app.${local ? "localhost" : "featheral.com"}${port}/`;
  const data = await api("/api/intranet/admin"), { org } = data;
  const endpoint = "/api/intranet/admin";
  const memberOptions = selected => options(data.members.filter(member => member.status === "active").map(member => [member.address, `${member.address} / ${member.role}`]), selected, "Choose insider");
  setView(`<div class="card"><h2>Foundation members &amp; visitors</h2><p>Registration is open. Visitors qualify through ecosystem quizzes without approval. Learning levels unlock agendas; management roles and protected Admin credentials remain separately assigned.</p>
    <div class="table-wrap"><table><thead><tr><th>Wallet / introduction</th><th>Status</th><th>Role / level</th><th>Division / team</th><th></th></tr></thead><tbody>${data.members.map(member => {
      const enrollment = data.enrollments.find(row => row.address === member.address);
      return `<tr data-member="${esc(member.address)}"><td><code>${esc(member.address)}</code><p class="small">${esc(member.motivation)}</p>${enrollment ? `<p class="small">Experience: ${esc(enrollment.experience)} / Interests: ${esc(JSON.parse(enrollment.interests).join(", "))}</p>` : ""}</td><td><select name="status">${options(["visitor","active","suspended","rejected"], member.status)}</select></td><td><select name="role">${options(org.roles, member.role)}</select><select name="level">${options(org.levels, member.level)}</select></td><td><select name="division">${options(org.divisions.map(row => [row.id, row.name]), member.division)}</select><select name="team">${options(org.teams.filter(team => team.division === member.division).map(row => [row.id, row.name]), member.team)}</select></td><td><button class="btn sm" data-save-member>Save</button></td></tr>`;
    }).join("")}</tbody></table></div>${data.members.length ? "" : "<p>No visitors registered yet.</p>"}</div>
    <div class="card"><h2>Full ecosystem organization</h2><p>Foundation → five lean divisions → site leads → contributors. The chart is visible to every active member; all divisions and site agendas remain visible here.</p><div class="table-wrap"><table><thead><tr><th>Position</th><th>Reports to</th><th>Scope</th><th>Responsibility</th><th>Staffing</th></tr></thead><tbody>${org.positions.map(position => `<tr><td>${esc(position.name)} / ${esc(position.role)}</td><td>${esc(position.parent || "Foundation")}</td><td>${esc(position.division)} / ${esc(position.team)}</td><td>${esc(position.responsibility)}</td><td>${position.members.map(member => esc(member.address)).join("<br>") || "Vacant"}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Teams</h2><form id="work-team" class="row"><label>Division<select name="division">${options(org.divisions.map(row => [row.id,row.name]))}</select></label><label>New team<input name="name" maxlength="80" required></label><button class="btn">Create team</button></form></div>
    <div class="card"><h2>All-site agenda &amp; review</h2><button class="btn sm" id="admin-new-mission">New task</button><div class="table-wrap"><table><thead><tr><th>Task / level</th><th>Division / team</th><th>Assignee</th><th>Status</th><th></th></tr></thead><tbody>${data.missions.map(mission => `<tr><td>${esc(mission.title)} / ${esc(mission.min_level)}</td><td>${esc(mission.division)} / ${esc(mission.team)}</td><td>${esc(mission.assignee)}</td><td>${esc(mission.status)}</td><td><button class="btn sm" data-edit-mission="${esc(mission.id)}">Review / edit</button></td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Weekly FTHS compensation</h2><p>UTC Monday cycles. Strictly above 60% approved tasks: full base + completed-task incentives. At or below 60%: incentives only, no base, return to visitor and fresh orientation quizzes. No assigned tasks: no salary and membership stays.</p>
    <p>${data.policy ? "Current cycle is configured." : "Current cycle has no configured amounts; it cannot issue FTHS."} Changes apply next Monday, never retroactively. A member's base is frozen at their first assignment in the cycle.</p>
    <form id="weekly-policy">${org.levels.map(level => `<label>${esc(level)} weekly base (whole FTHS)<input name="${esc(level)}" type="number" min="0" max="1000000000" step="1" required value="${data.nextPolicy ? data.nextPolicy.rates[level] : ""}"></label>`).join("")}<label>Incentive per approved task (whole FTHS)<input name="incentive" type="number" min="0" max="1000000000" step="1" required value="${data.nextPolicy ? data.nextPolicy.incentive : ""}"></label><label>Exact approval: CONFIGURE WEEKLY FTHS<input name="approval" required autocomplete="off"></label><button class="btn">Configure next week</button><p id="payroll-status" role="status"></p></form><button class="btn sm" id="evaluate-week">Evaluate closed weeks</button>
    <div class="table-wrap"><table><thead><tr><th>Week / member</th><th>Approved / assigned</th><th>Base / incentive / total</th><th>Membership / reward</th></tr></thead><tbody>${data.payroll.map(row => `<tr><td>${new Date(row.period).toISOString().slice(0,10)}<br>${esc(row.address)}</td><td>${row.accomplished} / ${row.assigned}</td><td>${row.base} / ${row.incentive} / ${row.total} FTHS</td><td>${row.qualified ? "Retained" : "Visitor"} / ${esc(row.status)}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Independent Silver grants</h2><p>Issued native supply: <b>${fmtNum(data.silver.supply)} FTHS</b>. Weekly assigned work is paid only through compensation records, never twice through this form. No USD peg, guaranteed liquidity or employment entitlement.</p>
    <form id="silver-grant"><label>Recipient<select name="address" required>${memberOptions()}</select></label><label>Amount (whole FTHS)<input name="amount" type="number" min="1" max="1000000000" step="1" required></label><label>Reason<textarea name="reason" maxlength="1000" required></textarea></label><label>Exact approval: ISSUE &lt;amount&gt; FTHS<input name="approval" required autocomplete="off"></label><button class="btn">Review &amp; issue independent grant</button><p id="grant-status" role="status"></p></form>
    <p class="small">Liquidity is separate. Use Notes market funding to approve FTHS / FTHX liquidity; this form does not fund a pool.</p></div>
    <div class="card"><h2>Recent grants</h2>${data.grants.map(grant => `<p><b>${fmtNum(grant.amount)} FTHS</b> → ${esc(grant.address)}<br><small>${esc(grant.reason)} / ${fmtDate(new Date(grant.at).toISOString())}</small></p>`).join("") || "<p>No grants issued.</p>"}</div>
    <div class="card"><h2>Administrative audit</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${data.audit.map(row => `<tr><td>${fmtDate(new Date(row.at).toISOString())}</td><td>${esc(row.actor)}</td><td>${esc(row.action)}</td><td>${esc(row.target)}</td></tr>`).join("")}</tbody></table></div></div>`, token);
  const refresh = () => VIEWS.intranet(_q, token);
  $("#weekly-policy").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("button", event.target); submit.disabled = true;
    try {
      const values = new FormData(event.target);
      const rates = Object.fromEntries(org.levels.map(level => [level, Number(values.get(level))]));
      if (!confirm("Configure next week's FTHS reward policy? Closed weeks and current assignments will not change.")) return;
      await api(`${endpoint}/payroll-policy`, { method: "PUT", json: { rates, incentive: Number(values.get("incentive")), approval: values.get("approval") } });
      toast("Next week's policy saved"); await refresh();
    } catch (error) { console.error(error); $("#payroll-status").textContent = error.message; }
    finally { submit.disabled = false; }
  });
  $("#evaluate-week").addEventListener("click", async event => {
    event.target.disabled = true;
    try { await api(`${endpoint}/evaluate`, { json: {} }); await refresh(); }
    catch (error) { console.error(error); toast(error.message); event.target.disabled = false; }
  });
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
    const dialog = modal("Foundation task", `<form id="admin-mission"><label>Title<input name="title" value="${esc(current.title || "")}" maxlength="160" required></label><label>Brief &amp; acceptance criteria<textarea name="body" maxlength="6000" required>${esc(current.body || "")}</textarea></label><label>Division<select name="division">${options(org.divisions.map(row => [row.id,row.name]),current.division)}</select></label><label>Team<select name="team"></select></label><label>Minimum learning level<select name="min_level">${options(org.levels,current.min_level || "learning")}</select></label><label>Assignee<select name="assignee"></select></label><label>Status<select name="status">${options(org.states,current.status)}</select></label><label>Evidence / handover<textarea name="evidence" maxlength="6000">${esc(current.evidence || "")}</textarea></label><button class="btn">Save task</button><p role="status" id="admin-mission-status"></p></form>`);
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
