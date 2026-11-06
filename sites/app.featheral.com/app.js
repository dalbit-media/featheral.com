"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state = { me: null, channel: null, channels: [], members: [], missions: [], messages: new Map(), view: "inbox", document: null,
    config: null, polling: false, sending: false, draftRequest: null, mission: null, experience: null, interests: [] };
  let profileEditor;
  const short = value => `..${value.slice(-5)}`;
  const node = (tag, content, className) => {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  };
  const status = error => {
    console.error("Featheral App:", error);
    $("status").textContent = error.message || String(error); $("status").hidden = false;
  };
  async function api(path, body, method) {
    const response = await fetch(`/api/intranet${path}`, { credentials: "same-origin", cache: "no-store",
      method: method || (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? { accept: "application/json" } : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.headers.get("content-type")?.includes("json")) throw new Error(`App API unavailable (HTTP ${response.status}).`);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data;
  }
  function action(element, callback) {
    element.addEventListener("click", async () => {
      if (element.disabled) return;
      element.disabled = true;
      try { await callback(); } catch (error) { status(error); }
      finally { element.disabled = false; }
    });
  }
  function personName(address) { return address === state.me?.address ? "You" : state.members.find(member => member.address === address)?.username || short(address); }
  function button(label, callback) {
    const element = node("button", label); element.type = "button"; action(element, callback); return element;
  }
  function link(site, path = "/") { return window.FeatheralSites.url(site, path); }
  function show(view) {
    state.view = view;
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== view;
    for (const tab of document.querySelectorAll("[data-view]")) {
      if (tab.dataset.view === view) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    }
    if (view === "account") void loadMe().catch(status);
    if (view === "missions") void loadMissions().catch(status);
    if (view === "learning") renderLearning();
  }
  for (const tab of document.querySelectorAll("[data-view]")) tab.addEventListener("click", () => show(tab.dataset.view));
  async function signIn() {
    if (!window.FeatheralWallet) throw new Error("Wallet is still loading. Retry shortly.");
    const authorization = await window.FeatheralWallet.authenticate(address => api("/challenge", { address }));
    await api("/login", authorization); await loadMe();
  }
  action($("signin"), signIn);
  action($("check-profile"), loadMe);
  $("application").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("application").querySelector("[type=submit]"); submit.disabled = true;
    try { await api("/apply", { motivation: $("motivation").value, experience: state.experience, interests: state.interests }); await loadMe(); }
    catch (error) { status(error); } finally { submit.disabled = false; }
  });
  async function loadMe() {
    state.me = await api("/me");
    const { member, profile, address, silver } = state.me, active = member?.status === "active";
    $("onboarding").hidden = active; $("workspace").hidden = !active;
    $("signin").hidden = true; $("signup").hidden = false;
    $("signup-title").textContent = profile?.username || "Create your World profile";
    $("signup-status").textContent = !profile ? "You are a visitor. Set up your public name, avatar and bio here. Your World profile is shared across Featheral."
      : member?.status === "visitor" || !member ? "Welcome, visitor. Share your experience and interests, then pass all orientation quizzes. No admin approval is required."
      : `Access ${member.status}. Contact an administrator about this restriction.`;
    $("application").hidden = !profile || !["visitor", "active"].includes(member?.status);
    $(active ? "member-preferences" : "visitor-preferences").append($("application"));
    $("application").querySelector("[type=submit]").textContent = active ? "Save experience & interests" : "Save visitor registration";
    renderPreferences(true); renderLearning(); renderCompensation();
    const root = $("profile-editor");
    $(active ? "account-profile" : "signup-profile").append(root);
    if (!profileEditor) profileEditor = await window.FeatheralWorldProfile.mount(root, { address, onSaved: loadMe });
    else await profileEditor.load(address, true);
    if (!active) {
      clearPrivate();
      return;
    }
    function clearPrivate() {
      if (call) cleanupCall();
      state.channel = null; state.channels = []; state.members = []; state.missions = []; state.messages.clear();
      state.document = null; state.mission = null; state.config = null; state.draftRequest = null;
      for (const id of ["messages", "channels", "mission-list", "people-list", "org-chart", "identity", "call-people"]) $(id).replaceChildren();
      for (const id of ["document-dialog", "mission-dialog", "call-picker"]) if ($(id).open) $(id).close();
      for (const id of ["document-body", "mission-evidence", "mission-title", "mission-body", "message", "attachment"]) $(id).value = "";
      $("attachment-name").textContent = ""; $("silver-balance").textContent = ""; $("conversation").hidden = true;
    }
    $("identity").replaceChildren();
    if (profile?.avatar) {
      const avatar = node("img"); avatar.src = profile.avatar; avatar.alt = ""; avatar.className = "avatar"; $("identity").append(avatar);
    }
    $("identity").append(node("h2", profile?.username || short(address)), node("p", address, "fine"),
      node("p", `${member.role} / ${member.level}`), node("p", `${member.division} / ${member.team}`, "fine"));
    if (profile?.bio) $("identity").append(node("p", profile.bio));
    $("silver-balance").textContent = `${silver.toLocaleString()} FTHS`;
    const directory = await api("/directory"); state.members = directory.members;
    renderPeople();
    renderOrganization();
    $("new-mission").hidden = !["lead", "manager", "director"].includes(member.role);
    await loadChannels();
    const requested = location.hash.match(/^#inbox\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (!state.channel && requested && state.channels.some(channel => channel.id === requested)) await openChannel(requested);
  }
  function renderPreferences(reset = false) {
    const learning = state.me.learning;
    if (reset) {
      state.experience = learning.enrollment?.experience || null;
      state.interests = learning.enrollment?.interests || [];
      $("motivation").value = state.me.member?.motivation || "";
    }
    const paths = {
      seed: "M12 21V10M12 14C4 14 3 8 3 4c6 0 9 3 9 8M12 10c0-5 4-7 9-7 0 5-3 8-9 8",
      tools: "M14 4a6 6 0 0 0-7 7L3 18l3 3 7-7a6 6 0 0 0 7-7l-4 3-3-3z",
      settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
      people: "M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8M22 21v-3a7 7 0 0 0-4-6",
      code: "m8 5-6 7 6 7m8-14 6 7-6 7m-2-17-4 20",
      search: "M20 20l-5-5M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0",
      book: "M12 5v16M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-4-2-7-1-10 1",
    };
    function choices(root, values, multiple) {
      root.replaceChildren();
      root.setAttribute("role", multiple ? "group" : "radiogroup");
      root.setAttribute("aria-label", multiple ? "Work interests" : "Your experience");
      for (const value of values) {
        const choice = node("button", undefined, "interest-button"); choice.type = "button";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", paths[value.icon]);
        icon.append(path); choice.append(icon, node("span", value.label));
        if (!multiple) {
          choice.setAttribute("role", "radio");
          choice.tabIndex = (state.experience === value.id || !state.experience && value === values[0]) ? 0 : -1;
          choice.addEventListener("keydown", event => {
            const index = values.indexOf(value);
            let next;
            if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % values.length;
            else if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index + values.length - 1) % values.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = values.length - 1;
            else return;
            event.preventDefault(); state.experience = values[next].id; renderPreferences(); root.children[next].focus();
          });
        }
        choice.setAttribute(multiple ? "aria-pressed" : "aria-checked", String(multiple ? state.interests.includes(value.id) : state.experience === value.id));
        choice.addEventListener("click", () => {
          if (multiple) state.interests = state.interests.includes(value.id) ? state.interests.filter(key => key !== value.id) : [...state.interests, value.id];
          else state.experience = value.id;
          choices(root, values, multiple);
          root.children[values.indexOf(value)].focus();
        });
        root.append(choice);
      }
    }
    choices($("experience-choices"), learning.experience, false);
    choices($("interest-choices"), learning.interests, true);
  }
  function renderLearning() {
    if (!state.me) return;
    const active = state.me.member?.status === "active", root = $(active ? "member-learning" : "visitor-learning");
    $(active ? "visitor-learning" : "member-learning").replaceChildren();
    root.replaceChildren();
    if (!state.me.learning.enrollment || !["visitor", "active"].includes(state.me.member?.status)) return;
    const learning = state.me.learning, required = learning.courses.filter(course => course.level === learning.stage);
    root.append(node("h2", `${learning.stage} learning`),
      node("p", `${required.filter(course => course.progress?.passed).length} / ${required.length} current-level quizzes passed. Every required quiz needs ${learning.passPercent}%.`, "fine"));
    if (learning.stage === "steward") root.append(node("p", "You have completed the learning pathway. Management roles remain separately assigned."));
    for (const course of learning.courses) {
      const card = node("details", undefined, "card lesson"), summary = node("summary", `${course.title}${course.progress?.passed ? " / Passed" : ""}`);
      card.append(summary, node("p", course.body));
      const destinations = node("div", undefined, "account-links");
      for (const site of course.sites) { const destination = node("a", site); destination.href = link(site); destination.target = "_blank"; destination.rel = "noopener"; destinations.append(destination); }
      card.append(destinations);
      const form = node("form");
      course.questions.forEach((question, index) => {
        const field = node("fieldset"); field.append(node("legend", question.prompt));
        question.options.forEach((option, value) => {
          const label = node("label", undefined, "quiz-choice"), input = node("input");
          input.type = "radio"; input.name = `question-${index}`; input.value = String(value); input.required = true;
          label.append(input, node("span", option)); field.append(label);
        });
        form.append(field);
      });
      const submit = node("button", "Check quiz", "primary"); submit.type = "submit";
      const feedback = node("p", course.progress ? `Best score: ${course.progress.score}% / ${course.progress.attempts} attempts` : "", "fine");
      feedback.setAttribute("role", "status"); form.append(submit, feedback);
      form.addEventListener("submit", async event => {
        event.preventDefault(); submit.disabled = true;
        try {
          const values = new FormData(form), answers = course.questions.map((_, index) => Number(values.get(`question-${index}`)));
          const result = await api(`/learning/${course.id}/quiz`, { answers });
          feedback.textContent = `${result.score}% / ${result.passed ? "Passed" : "Review the lesson and retry"}`;
          if (result.passed) { await loadMe(); $("status").textContent = `${course.title}: ${result.score}% / Passed`; $("status").hidden = false; }
        } catch (error) { feedback.textContent = error.message; status(error); }
        finally { submit.disabled = false; }
      });
      card.append(form); root.append(card);
    }
  }
  function renderCompensation() {
    if (!state.me) return;
    const active = state.me.member?.status === "active", root = $(active ? "member-compensation" : "visitor-compensation");
    $(active ? "visitor-compensation" : "member-compensation").replaceChildren(); root.replaceChildren();
    const pay = state.me.compensation;
    const card = node("section", undefined, "card");
    card.append(node("h2", "Weekly contribution record"), node("p", `${new Date(pay.period).toISOString().slice(0, 10)} to ${new Date(pay.ends).toISOString().slice(0, 10)} / UTC Monday to Monday`));
    const percent = pay.assigned ? (pay.accomplished * 100 / pay.assigned).toFixed(1) : "0";
    const progress = node("progress"); progress.max = pay.assigned || 1; progress.value = pay.accomplished;
    progress.setAttribute("aria-label", "Approved weekly task completion");
    card.append(progress, node("p", `${pay.accomplished} / ${pay.assigned} assigned tasks approved (${percent}%)`),
      node("p", "Above 60%: configured base + completed-task incentives. At or below 60%: incentives only, no base, and return to visitor. No assignments: membership stays and no salary record.", "fine"));
    card.append(node("p", pay.configured ? `Configured weekly base: ${pay.base.toLocaleString()} FTHS. Incentive per approved task: ${pay.incentivePerTask.toLocaleString()} FTHS. Evaluated after the cycle closes.` : "Reward amounts are not configured for this cycle. No FTHS will be issued; completion and membership rules still apply.", "fine"));
    for (const record of pay.history) card.append(node("p", `${new Date(record.period).toISOString().slice(0, 10)} / ${record.accomplished}/${record.assigned} approved / Base ${record.base} + incentive ${record.incentive} = ${record.total} FTHS / ${record.qualified ? "membership retained" : "returned to visitor"}${record.configured ? "" : " / policy unconfigured"}`, "fine"));
    root.append(card);
  }
  function renderOrganization() {
    const root = $("org-chart"); root.replaceChildren();
    const positions = state.me.org.positions;
    function branch(parent) {
      const list = node("ul", undefined, "org-branches");
      for (const position of positions.filter(row => row.parent === parent)) {
        const item = node("li"), card = node("details", undefined, "org-position");
        card.open = parent === null || parent === "foundation";
        card.append(node("summary", `${position.name} / ${position.role}`), node("p", position.responsibility, "fine"));
        card.append(node("p", position.members.length ? position.members.map(member => `${personName(member.address)} / ${member.level}`).join(", ") : "Vacant / ready for responsible staffing", "fine"));
        item.append(card, branch(position.id)); list.append(item);
      }
      return list;
    }
    root.append(branch(null));
  }
  function renderPeople() {
    const root = $("people-list"); root.replaceChildren();
    for (const division of state.me.org.divisions) {
      const members = state.members.filter(member => member.division === division.id);
      if (!members.length) continue;
      root.append(node("h2", division.name));
      for (const team of state.me.org.teams.filter(team => team.division === division.id)) {
        const people = members.filter(member => member.team === team.id);
        if (!people.length) continue;
        const section = node("section", undefined, "card"); section.append(node("h3", team.name));
        for (const member of people) {
          const row = node("div", undefined, "person card"), details = node("div");
          details.append(node("strong", personName(member.address)), node("small", `${member.role} / ${member.level}`));
          row.title = member.address; row.append(details);
          if (member.address !== state.me.address) row.append(button("Message", async () => {
            const channel = await api("/direct", { address: member.address }); await loadChannels(); show("inbox"); await openChannel(channel.id);
          }));
          section.append(row);
        }
        root.append(section);
      }
    }
  }
  async function loadChannels() {
    const data = await api("/channels"); state.channels = data.channels;
    const root = $("channels"); root.replaceChildren();
    for (const channel of state.channels) {
      const choice = button("", () => openChannel(channel.id)); choice.className = "channel-choice";
      choice.append(node("span", channel.scope === "dm" ? personName(channel.peer) : channel.name));
      if (channel.unread) choice.append(node("span", String(channel.unread), "badge"));
      choice.setAttribute("aria-current", channel.id === state.channel ? "page" : "false");
      root.append(choice);
    }
    if (state.channel && !state.channels.some(channel => channel.id === state.channel)) {
      state.channel = null; $("conversation").hidden = true; $("inbox").classList.remove("has-channel");
    }
  }
  async function openChannel(key) {
    if (state.channel !== key && ($("message").value || $("attachment").files.length)
      && !confirm("Discard the unsent message before switching conversations?")) return;
    state.channel = key; state.messages.clear(); state.draftRequest = null;
    $("messages").replaceChildren(); $("message").value = ""; $("attachment").value = ""; $("attachment-name").textContent = "";
    $("conversation").hidden = false; $("inbox").classList.add("has-channel");
    const channel = state.channels.find(channel => channel.id === key);
    $("channel-title").textContent = channel?.scope === "dm" ? personName(channel.peer) : channel?.name || "Conversation";
    $("channel-scope").textContent = `${channel?.scope || ""} channel / restricted to current members`;
    await loadMessages(key);
    await loadChannels();
    $("message").focus({ preventScroll: true });
  }
  $("back-inbox").addEventListener("click", () => {
    $("inbox").classList.remove("has-channel"); $("conversation").hidden = true;
  });
  async function loadMessages(key = state.channel) {
    if (!key) return;
    const cursor = Math.max(0, ...state.messages.keys());
    const { messages } = await api(`/channels/${key}/messages?after=${cursor}`);
    if (key !== state.channel) return;
    const root = $("messages"), atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 60;
    for (const message of messages) {
      if (state.messages.has(message.id)) continue;
      state.messages.set(message.id, message);
      const item = node("article", undefined, `message${message.author === state.me.address ? " self" : ""}`);
      const header = node("small", `${personName(message.author)} / ${new Date(message.at).toLocaleString()}`);
      header.title = message.author;
      item.append(header, node("p", message.body));
      if (message.attachment) {
        const attachment = node("a", `${message.attachment.name} (${Math.ceil(message.attachment.size / 1024)} KiB)`);
        attachment.href = `/api/intranet/files/${message.attachment.id}`; attachment.download = message.attachment.name; item.append(attachment);
      }
      root.append(item);
    }
    $("older").hidden = cursor > 0 || messages.length < 100;
    if (!cursor || atBottom) root.scrollTop = root.scrollHeight;
    if (state.view === "inbox" && !$("conversation").hidden && !document.hidden && state.messages.size)
      await api(`/channels/${key}/read`, { message: Math.max(...state.messages.keys()) });
  }
  const invalidateDraft = () => { state.draftRequest = null; };
  $("message").addEventListener("input", invalidateDraft);
  $("attachment").addEventListener("change", () => {
    invalidateDraft(); $("attachment-name").textContent = $("attachment").files[0]?.name || "";
  });
  async function filePayload(file) {
    if (!file) return undefined;
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error("Choose a file up to 5 MiB.");
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("File could not be read."));
      reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file);
    });
    return { name: file.name, base64 };
  }
  $("composer").addEventListener("submit", async event => {
    event.preventDefault(); if (state.sending || !state.channel) return;
    state.sending = true; $("send").disabled = true;
    const key = state.channel, body = $("message").value, file = $("attachment").files[0];
    try {
      const attachment = await filePayload(file); state.draftRequest ||= crypto.randomUUID();
      await api(`/channels/${key}/messages`, { request: state.draftRequest, body, ...(attachment ? { attachment } : {}) });
      if (state.channel === key && $("message").value === body && $("attachment").files[0] === file) {
        $("message").value = ""; $("attachment").value = ""; $("attachment-name").textContent = ""; state.draftRequest = null;
      }
      await loadMessages(key); await loadChannels();
    } catch (error) { status(error); }
    finally { state.sending = false; $("send").disabled = false; }
  });
  action($("open-document"), async () => {
    state.document = await api(`/channels/${state.channel}/document`);
    $("document-body").value = state.document.body; $("document-status").textContent = `Revision ${state.document.revision}`;
    $("document-dialog").showModal();
  });
  action($("save-document"), async () => {
    if (!state.document) return;
    try {
      state.document = await api(`/channels/${state.document.channel}/document`, { body: $("document-body").value, revision: state.document.revision }, "PUT");
      $("document-status").textContent = `Saved / revision ${state.document.revision}`;
    } catch (error) { $("document-status").textContent = error.message; throw error; }
  });
  action($("reload-document"), async () => {
    if (!confirm("Replace your current draft with the latest saved notes?")) return;
    state.document = await api(`/channels/${state.document.channel}/document`);
    $("document-body").value = state.document.body; $("document-status").textContent = `Revision ${state.document.revision}`;
  });
  async function loadMissions() {
    const owner = state.me?.address, data = await api("/missions");
    if (state.me?.address !== owner || state.me?.member?.status !== "active") return;
    state.missions = data.missions;
    $("agenda-access").textContent = `Your level: ${state.me.member.level} / Division: ${state.me.member.division}. Higher-level agendas and private team resources remain gated.`;
    $("mission-list").replaceChildren();
    for (const mission of state.missions) {
      const card = node("article", undefined, "card");
      card.append(node("small", `${mission.status.replace("_", " ")} / ${mission.team} / ${mission.min_level}`), node("h2", mission.title),
        node("p", mission.body), node("small", mission.assignee ? `Assigned: ${personName(mission.assignee)}` : "Not assigned"),
        button("Open mission", () => editMission(mission)));
      if (!mission.assignee && mission.status === "ready" && mission.team === state.me.member.team)
        card.append(button("Take this task", async () => {
          if (!confirm("Assign this task to you for this week's completion evaluation? Only approved completion counts.")) return;
          await api(`/missions/${mission.id}/claim`, { revision: mission.revision }); await loadMe(); await loadMissions();
        }));
      $("mission-list").append(card);
    }
    if (!data.missions.length) $("mission-list").append(node("p", "Your team has no missions yet. Ask your lead for a brief.", "fine"));
  }
  function fillSelect(element, values, selected) {
    element.replaceChildren(...values.map(([value, name]) => {
      const option = node("option", name); option.value = value; option.selected = value === selected; return option;
    }));
  }
  function missionTeamOptions(selectedTeam, selectedAssignee) {
    const division = $("mission-division").value;
    fillSelect($("mission-team"), state.me.org.teams.filter(team => team.division === division).map(team => [team.id, team.name]), selectedTeam);
    fillSelect($("mission-assignee"), [["", "Unassigned"], ...state.members.filter(member => member.team === $("mission-team").value)
      .map(member => [member.address, personName(member.address)])], selectedAssignee);
  }
  $("mission-division").addEventListener("change", () => missionTeamOptions());
  $("mission-team").addEventListener("change", () => {
    fillSelect($("mission-assignee"), [["", "Unassigned"], ...state.members.filter(member => member.team === $("mission-team").value)
      .map(member => [member.address, personName(member.address)])], "");
  });
  function editMission(mission = null) {
    state.mission = mission; const member = state.me.member;
    const manager = member.role === "director" || member.division === (mission?.division || member.division)
      && (member.role === "manager" || member.role === "lead" && member.team === (mission?.team || member.team));
    const editable = manager && mission?.assignee !== state.me.address || mission?.assignee === state.me.address
      && ["ready", "in_progress", "review"].includes(mission.status) || !mission && manager;
    for (const field of ["title", "body", "division", "team", "assignee", "min_level"]) $("mission-" + field).disabled = !manager || !editable
      || mission?.assignee === state.me.address && ["division", "team", "assignee"].includes(field);
    $("mission-title").value = mission?.title || ""; $("mission-body").value = mission?.body || "";
    $("mission-evidence").value = mission?.evidence || "";
    fillSelect($("mission-division"), state.me.org.divisions.map(division => [division.id, division.name]), mission?.division || member.division);
    missionTeamOptions(mission?.team || member.team, mission?.assignee || "");
    fillSelect($("mission-min_level"), state.me.org.levels.map(level => [level, level]), mission?.min_level || "learning");
    const states = manager && mission?.assignee !== state.me.address ? state.me.org.states : ["ready", "in_progress", "review"];
    if (mission && !states.includes(mission.status)) states.push(mission.status);
    fillSelect($("mission-status"), states.map(value => [value, value.replace("_", " ")]), mission?.status || "draft");
    $("mission-status").disabled = !editable; $("mission-evidence").disabled = !editable; $("save-mission").hidden = !editable;
    $("mission-error").textContent = ""; $("mission-dialog").showModal();
  }
  action($("new-mission"), () => editMission());
  $("close-mission").addEventListener("click", () => $("mission-dialog").close());
  $("mission-form").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("mission-form").querySelector("button.primary"); submit.disabled = true;
    try {
      const input = Object.fromEntries(["title", "body", "division", "team", "assignee", "status", "evidence", "min_level"].map(field => [field, $("mission-" + field).value]));
      if (state.mission) input.revision = state.mission.revision;
      await api(`/missions${state.mission ? "/" + state.mission.id : ""}`, input, state.mission ? "PUT" : "POST");
      $("mission-dialog").close(); await loadMe(); await loadMissions();
    } catch (error) { $("mission-error").textContent = error.message; status(error); } finally { submit.disabled = false; }
  });
  async function config() { return state.config ||= await api("/config"); }
  async function registration() {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers.");
    await navigator.serviceWorker.register("/sw.js"); return navigator.serviceWorker.ready;
  }
  action($("notifications"), async () => {
    if (!("Notification" in window) || !("PushManager" in window)) throw new Error("Browser push is unavailable. On iOS, install App to your home screen first.");
    const settings = await config();
    if (!settings.pushPublicKey) throw new Error("An administrator must configure App VAPID keys before browser push is available.");
    const worker = await registration(), existing = await worker.pushManager.getSubscription();
    if (existing) {
      await api("/push", { endpoint: existing.endpoint }, "DELETE"); await existing.unsubscribe();
      $("notifications").textContent = "Enable notifications"; return;
    }
    if (await Notification.requestPermission() !== "granted") throw new Error("Notifications were not allowed. Change browser permissions to enable them.");
    const base64 = settings.pushPublicKey.replace(/-/g, "+").replace(/_/g, "/");
    const applicationServerKey = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    try { await api("/push", subscription.toJSON()); }
    catch (error) { await subscription.unsubscribe(); throw error; }
    $("notifications").textContent = "Disable notifications";
  });
  action($("signout"), async () => {
    await endCall();
    if ("serviceWorker" in navigator) {
      const worker = await navigator.serviceWorker.getRegistration(), subscription = await worker?.pushManager.getSubscription();
      if (subscription) { await api("/push", { endpoint: subscription.endpoint }, "DELETE"); await subscription.unsubscribe(); }
      for (const notification of await worker?.getNotifications() || []) notification.close();
    }
    await api("/logout", {});
    clearPrivate(); state.me = null; state.experience = null; state.interests = [];
    $("workspace").hidden = true; $("onboarding").hidden = false; $("signup").hidden = true; $("signin").hidden = false;
    $("messages").replaceChildren(); $("channels").replaceChildren(); $("message").value = ""; $("attachment").value = "";
  });
  action($("visitor-signout"), async () => { await api("/logout", {}); location.reload(); });
  let call = null, pc = null, mic = null, screen = null, videoSender = null, callCursor = 0, signalBusy = false, lastHeartbeat = 0;
  const candidateQueue = [];
  function cleanupCall() {
    pc?.close(); pc = null;
    for (const stream of [mic, screen]) for (const track of stream?.getTracks() || []) track.stop();
    mic = null; screen = null; call = null; videoSender = null; callCursor = 0; candidateQueue.length = 0;
    $("remote-video").srcObject = null; $("remote-audio").srcObject = null; $("local-video").srcObject = null;
    $("call-dialog").close();
  }
  async function endCall() {
    if (!call) return;
    try { await api(`/calls/${call.id}/signals`, { type: "end" }); }
    finally { cleanupCall(); }
  }
  function showCall(value) {
    call = value; const incoming = value.callee === state.me.address && value.status === "ringing";
    $("call-title").textContent = `${incoming ? "Incoming call" : "Call"} / ${personName(value.caller === state.me.address ? value.callee : value.caller)}`;
    $("call-status").textContent = value.status === "ringing" ? incoming ? "Accept to enable your microphone." : "Ringing..." : "Connecting...";
    $("accept-call").hidden = !incoming; $("mute-call").hidden = value.status !== "active"; $("share-screen").hidden = value.status !== "active";
    if (!$("call-dialog").open) $("call-dialog").showModal();
  }
  async function media() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Calls require a supported browser and HTTPS or localhost.");
    if (pc) return;
    const settings = await config();
    mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    pc = new RTCPeerConnection({ iceServers: settings.iceServers });
    videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
    for (const track of mic.getTracks()) pc.addTrack(track, mic);
    pc.onicecandidate = event => {
      if (event.candidate && call) void api(`/calls/${call.id}/signals`, { type: "candidate", candidate: event.candidate.toJSON() }).catch(status);
    };
    pc.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === "video") $("remote-video").srcObject = stream; else $("remote-audio").srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      $("call-status").textContent = pc.connectionState === "failed" ? "Connection failed. Ask an administrator to configure TURN for external networks."
        : `${pc.connectionState}${settings.turnConfigured ? "" : " / no TURN relay configured"}`;
    };
    $("share-screen").disabled = !navigator.mediaDevices.getDisplayMedia;
    $("share-screen").title = navigator.mediaDevices.getDisplayMedia ? "Choose a screen or window" : "Screen sharing is unavailable in this browser";
    $("mute-call").textContent = "Mute";
  }
  action($("start-call"), async () => {
    const available = state.channels.find(channel => channel.id === state.channel);
    $("call-people").replaceChildren();
    for (const member of state.members.filter(member => member.address !== state.me.address)) {
      if (available.scope === "dm" && member.address !== available.peer) continue;
      if (available.scope === "division" && member.division !== available.scope_id || available.scope === "team" && member.team !== available.scope_id) continue;
      $("call-people").append(button(`${personName(member.address)} / ${member.role}`, async () => {
        if (call) throw new Error("End the current call first.");
        try {
          await media();
          const started = await api("/calls", { channel: state.channel, callee: member.address });
          $("call-picker").close(); showCall(started);
        } catch (error) { cleanupCall(); throw error; }
      }));
    }
    $("call-picker").showModal();
  });
  action($("accept-call"), async () => {
    try { await media(); const accepted = await api(`/calls/${call.id}/signals`, { type: "accept" }); showCall(accepted); }
    catch (error) { await endCall(); throw error; }
  });
  action($("end-call"), endCall);
  $("call-dialog").addEventListener("cancel", event => { event.preventDefault(); void endCall().catch(status); });
  action($("mute-call"), () => {
    if (!mic) return;
    const enable = !mic.getAudioTracks()[0].enabled;
    for (const track of mic.getAudioTracks()) track.enabled = enable;
    $("mute-call").textContent = enable ? "Mute" : "Unmute";
  });
  async function stopScreen() {
    if (videoSender) await videoSender.replaceTrack(null);
    for (const track of screen?.getTracks() || []) track.stop();
    screen = null; $("local-video").srcObject = null; $("share-screen").textContent = "Share screen";
  }
  action($("share-screen"), async () => {
    if (!pc || !videoSender) throw new Error("Connect the call before sharing.");
    if (screen) return stopScreen();
    const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (!pc || !videoSender) { for (const track of captured.getTracks()) track.stop(); throw new Error("Call ended before sharing began."); }
    screen = captured;
    await videoSender.replaceTrack(screen.getVideoTracks()[0]);
    screen.getVideoTracks()[0].addEventListener("ended", () => void stopScreen().catch(status), { once: true });
    $("local-video").srcObject = screen; $("share-screen").textContent = "Stop sharing";
  });
  async function pollCall() {
    if (signalBusy) return;
    signalBusy = true;
    try {
      const { calls } = await api("/calls");
      if (!call && calls.length) showCall(calls[0]);
      if (!call) return;
      const key = call.id, result = await api(`/calls/${key}/signals?after=${callCursor}`);
      if (!call || call.id !== key) return;
      if (result.call.status === "ended") { cleanupCall(); return; }
      if (result.call.status === "active") {
        call = result.call; $("accept-call").hidden = true; $("mute-call").hidden = false; $("share-screen").hidden = false;
      }
      for (const signal of result.signals) {
        const input = signal.body;
        if (input.type === "end") { cleanupCall(); return; }
        if (input.type === "accept" && state.me.address === call.caller) {
          await media();
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
          await api(`/calls/${key}/signals`, { type: "offer", sdp: offer.sdp });
        } else if (input.type === "offer") {
          await media(); await pc.setRemoteDescription({ type: "offer", sdp: input.sdp });
          for (const candidate of candidateQueue.splice(0)) await pc.addIceCandidate(candidate);
          const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
          await api(`/calls/${key}/signals`, { type: "answer", sdp: answer.sdp });
        } else if (input.type === "answer") {
          await pc.setRemoteDescription({ type: "answer", sdp: input.sdp });
          for (const candidate of candidateQueue.splice(0)) await pc.addIceCandidate(candidate);
        } else if (input.type === "candidate") {
          if (pc?.remoteDescription) await pc.addIceCandidate(input.candidate); else candidateQueue.push(input.candidate);
        }
        callCursor = signal.id;
      }
      if (call && Date.now() - lastHeartbeat > 15000) {
        await api(`/calls/${key}/signals`, { type: "heartbeat" }); lastHeartbeat = Date.now();
      }
    } catch (error) {
      if (call) { $("call-status").textContent = error.message; if ([401, 403, 404, 409].includes(error.status)) cleanupCall(); }
      status(error);
    } finally { signalBusy = false; }
  }
  async function tick() {
    if (!state.me || state.me.member?.status !== "active" || state.polling) return;
    state.polling = true;
    try {
      const latest = await api("/me");
      if (latest.member?.status !== "active") { cleanupCall(); state.channel = null; state.messages.clear(); await loadMe(); return; }
      state.me = latest; renderCompensation();
      await pollCall();
      if (!document.hidden) { await loadChannels(); await loadMessages(); }
    } catch (error) {
      status(error);
      if ([401, 403].includes(error.status)) {
        clearPrivate(); state.me = null; state.experience = null; state.interests = [];
        $("workspace").hidden = true; $("onboarding").hidden = false; $("signin").hidden = false; $("signup").hidden = true;
      }
    } finally { state.polling = false; }
  }
  window.addEventListener("hashchange", () => {
    const key = location.hash.match(/^#inbox\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (key && state.channels.some(channel => channel.id === key)) { show("inbox"); void openChannel(key).catch(status); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void tick(); });
  setInterval(() => void tick(), 3000);
  loadMe().catch(error => { if (error.status !== 401) status(error); });
})();
