"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state = { me: null, channel: null, channels: [], members: [], missions: [], messages: new Map(), view: "overview", document: null,
    config: null, polling: false, sending: false, draftRequest: null, mission: null, experience: null, interests: [],
    missionFilter: "mine", missionsLoaded: false, missionsRefreshedAt: 0, missionTodos: [], todoDefinitionsEditable: false, todoEditable: false,
    compensationKey: "", overviewKey: "" };
  let quizRetryTimer;
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
  const mobileNavigation = window.matchMedia("(max-width: 900px)");
  function setMenu(open, restoreFocus = true) {
    const visible = open && mobileNavigation.matches && state.me?.member?.status === "active";
    $("workspace-navigation").classList.toggle("is-open", visible);
    $("workspace-navigation").inert = mobileNavigation.matches && !visible;
    $("menu-backdrop").hidden = !visible;
    $("menu-toggle").setAttribute("aria-expanded", String(visible));
    document.body.classList.toggle("menu-open", visible);
    $("main-content").inert = visible;
    document.querySelector(".app-header").inert = visible;
    document.querySelector(".app-tabs").inert = visible;
    if (visible) requestAnimationFrame(() => {
      if ($("menu-toggle").getAttribute("aria-expanded") === "true") $("menu-close").focus();
    });
    else if (restoreFocus && mobileNavigation.matches) $("menu-toggle").focus();
  }
  $("menu-toggle").addEventListener("click", () => setMenu($("menu-toggle").getAttribute("aria-expanded") !== "true"));
  for (const id of ["menu-close", "menu-backdrop"]) $(id).addEventListener("click", () => setMenu(false));
  mobileNavigation.addEventListener("change", () => setMenu(false, false));
  document.addEventListener("keydown", event => {
    if ($("menu-toggle").getAttribute("aria-expanded") !== "true") return;
    if (event.key === "Escape") { event.preventDefault(); setMenu(false); }
    if (event.key === "Tab") {
      const choices = [...$("workspace-navigation").querySelectorAll("button:not([disabled])")];
      const first = choices[0], last = choices.at(-1);
      if (!$("workspace-navigation").contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  function show(view, updateUrl = true) {
    if (!["overview", "missions", "inbox", "people", "learning", "rewards", "account"].includes(view)) return;
    state.view = view;
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== view;
    for (const tab of document.querySelectorAll("[data-view]")) {
      if (tab.dataset.view === view) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    }
    if (view === "account" && updateUrl) void loadMe().catch(status);
    setMenu(false, false);
    if (updateUrl) history.replaceState(null, "", `#${view === "inbox" && state.channel ? "inbox/" + state.channel : view}`);
    if ((view === "missions" || view === "overview") && (updateUrl || !state.missionsLoaded)) void loadMissions().catch(status);
    if (view === "learning") renderLearning();
    if (view === "rewards") renderCompensation();
    $("main-content").focus({ preventScroll: true });
  }
  for (const tab of document.querySelectorAll("[data-view]")) tab.addEventListener("click", () => show(tab.dataset.view));
  async function signIn() {
    const destination = new URL(link("world", "/login/"));
    destination.searchParams.set("returnTo", new URL("/", location.origin).href);
    location.assign(destination.href);
  }
  action($("signin"), signIn);
  action($("check-profile"), loadMe);
  $("application").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("application").querySelector("[type=submit]"); submit.disabled = true;
    try { await api("/apply", { motivation: $("motivation").value, experience: state.experience, interests: state.interests }); await loadMe(); }
    catch (error) { status(error); } finally { submit.disabled = false; }
  });
  async function loadMe() {
    const previouslyActive = state.me?.member?.status === "active";
    state.me = await api("/me");
    state.me.learning.receivedAt = Date.now();
    const { member, profile, address, silver } = state.me, active = member?.status === "active";
    $("onboarding").hidden = active; $("workspace").hidden = !active;
    $("menu-toggle").hidden = !active;
    $("signin").hidden = true; $("signup").hidden = false;
    $("signup-title").textContent = profile?.username || "Complete your World profile";
    $("signup-status").textContent = !profile ? "Complete your public profile on World, then return here. App uses the same name, avatar, bio and wallet."
      : member?.status === "visitor" || !member ? "Your World profile is connected. Save your interests, then pass orientation one step at a time to promote it to App membership."
      : `Access ${member.status}. Contact an administrator about this restriction.`;
    $("application").hidden = !profile?.username || !profile.avatar || !profile.bio?.trim() || !["visitor", "active"].includes(member?.status);
    $(active ? "member-preferences" : "visitor-preferences").append($("application"));
    $("application").querySelector("[type=submit]").textContent = active ? "Save experience & interests" : "Save visitor registration";
    renderPreferences(true); renderLearning(); renderCompensation();
    $("visitor-preferences").open = !state.me.learning.enrollment;
    const root = $("profile-editor");
    $(active ? "account-profile" : "signup-profile").append(root);
    root.replaceChildren();
    if (profile) {
      const card = node("div", undefined, "shared-profile");
      if (profile.avatar) { const image = node("img"); image.src = profile.avatar; image.alt = ""; image.className = "avatar"; card.append(image); }
      card.append(node("strong", profile.username), node("p", profile.bio, "fine"));
      root.append(card);
    }
    const profileLink = node("a", profile ? "Edit shared profile on World" : "Set up your World profile");
    const profileUrl = new URL(link("world", "/account/")); profileUrl.searchParams.set("returnTo", new URL("/", location.origin).href);
    profileLink.href = profileUrl.href; root.append(profileLink);
    $("promotion-path").textContent = `World profile → ${active ? "App member" : "App visitor"} → Admin by explicit approval and assigned permissions. Quiz completion never grants Admin authority.`;
    if (!active) {
      clearPrivate();
      return;
    }
    $("identity").replaceChildren();
    if (profile?.avatar) {
      const avatar = node("img"); avatar.src = profile.avatar; avatar.alt = ""; avatar.className = "avatar"; $("identity").append(avatar);
    }
    $("identity").append(node("h2", profile?.username || short(address)), node("p", address, "fine"),
      node("p", `${member.role} / ${member.level}`), node("p", `${member.division} / ${member.team}`, "fine"));
    if (profile?.bio) $("identity").append(node("p", profile.bio));
    if (state.me.adminPermissions.length) {
      const admin = node("a", "Open assigned Admin workspace"); admin.href = link("admin", "/#/intranet"); $("identity").append(admin);
    }
    $("silver-balance").textContent = `${silver.toLocaleString()} FTHS`;
    $("header-member").textContent = profile?.username || short(address);
    $("sidebar-identity").replaceChildren(node("strong", profile?.username || short(address)),
      node("small", `${member.level} / ${member.role}`),
      node("small", state.me.org.teams.find(team => team.id === member.team)?.name || member.team));
    const directory = await api("/directory"); state.members = directory.members;
    renderPeople();
    renderOrganization();
    renderProposal();
    renderOverview();
    $("new-mission").hidden = !["lead", "manager", "director"].includes(member.role);
    await loadChannels();
    const requested = location.hash.match(/^#inbox\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (!state.channel && requested && state.channels.some(channel => channel.id === requested)) await openChannel(requested);
    await loadMissions();
    if (!previouslyActive) {
      const route = requested ? "inbox" : location.hash.slice(1) || state.view;
      show(["overview", "missions", "inbox", "people", "learning", "rewards", "account"].includes(route) ? route : "overview", false);
    }
  }
  function clearPrivate() {
    if (call) cleanupCall();
    state.channel = null; state.channels = []; state.members = []; state.missions = []; state.messages.clear();
    state.document = null; state.mission = null; state.config = null; state.draftRequest = null;
    state.missionsLoaded = false; state.missionTodos = []; state.view = "overview";
    state.compensationKey = ""; state.overviewKey = "";
    setMenu(false, false);
    $("menu-toggle").hidden = true;
    $("header-member").textContent = "";
    for (const id of ["messages", "channels", "mission-list", "people-list", "org-chart", "identity", "call-people",
      "sidebar-identity", "workspace-metrics", "next-missions", "workspace-eligibility", "reward-summary", "reward-record", "mission-todos",
      "member-compensation"]) $(id).replaceChildren();
    for (const id of ["document-dialog", "mission-dialog", "call-picker"]) if ($(id).open) $(id).close();
    for (const id of ["document-body", "mission-evidence", "mission-title", "mission-body", "message", "attachment"]) $(id).value = "";
    $("attachment-name").textContent = ""; $("silver-balance").textContent = ""; $("conversation").hidden = true;
    $("mission-search").value = ""; $("mission-count").textContent = ""; $("mission-load-status").textContent = "";
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
    clearTimeout(quizRetryTimer);
    if (!state.me) return;
    const active = state.me.member?.status === "active", root = $(active ? "member-learning" : "visitor-learning");
    $(active ? "visitor-learning" : "member-learning").replaceChildren();
    root.replaceChildren();
    if (!state.me.learning.enrollment || !["visitor", "active"].includes(state.me.member?.status)) return;
    const learning = state.me.learning, required = learning.steps.filter(course => course.level === learning.stage);
    root.append(node("h2", `${learning.stage} learning`),
      node("p", `${required.filter(course => course.passed).length} / ${required.length} current-level quizzes passed. Every required quiz needs ${learning.passPercent}%.`, "fine"));
    if (learning.stage === "steward") root.append(node("p", "You have completed the learning pathway. Management roles remain separately assigned."));
    const steps = node("ol", undefined, "learning-steps");
    for (const step of learning.steps) {
      const row = node("li", `${step.passed ? "Passed" : step.locked ? "Locked" : "Current"} · ${step.title}`);
      row.className = step.passed ? "passed" : step.locked ? "locked" : "current";
      if (!step.passed && !step.locked) row.setAttribute("aria-current", "step");
      steps.append(row);
    }
    root.append(steps);
    for (const course of learning.courses.filter(course => !course.progress?.passed)) {
      const card = node("section", undefined, "card lesson");
      card.append(node("h3", course.title), node("p", course.body));
      const destinations = node("div", undefined, "account-links");
      for (const site of course.sites) { const destination = node("a", site); destination.href = link(site); destination.target = "_blank"; destination.rel = "noopener"; destinations.append(destination); }
      card.append(destinations);
      const remaining = course.retryAt - (learning.serverNow + Date.now() - learning.receivedAt);
      if (remaining > 0) {
        const wait = node("p", `Retake available ${new Date(course.retryAt).toLocaleString()}. Wait at least 30 minutes after failure; the next step remains locked.`, "quiz-wait");
        wait.setAttribute("role", "status");
        quizRetryTimer = setTimeout(() => { void loadMe().catch(status); }, remaining + 100);
        card.append(wait, button("Check retake availability", loadMe)); root.append(card);
        continue;
      }
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
          await loadMe();
          $("status").textContent = `${course.title}: ${result.score}% / ${result.passed ? "Passed. The next step is available." : "Not passed. Wait at least 30 minutes before retaking."}`;
          $("status").hidden = false;
        } catch (error) {
          feedback.textContent = error.message; status(error);
          if ([409, 429].includes(error.status)) void loadMe().catch(status);
        }
        finally { submit.disabled = false; }
      });
      card.append(form); root.append(card);
    }
  }
  function renderCompensation() {
    if (!state.me) return;
    const key = JSON.stringify([state.me.address, state.me.member?.status, state.me.silver, state.me.compensation]);
    if (key === state.compensationKey) return;
    state.compensationKey = key;
    const active = state.me.member?.status === "active", root = $(active ? "member-compensation" : "visitor-compensation");
    $(active ? "visitor-compensation" : "member-compensation").replaceChildren(); root.replaceChildren();
    const pay = state.me.compensation;
    const card = node(active ? "section" : "details", undefined, "card");
    card.append(node(active ? "h2" : "summary", "Weekly contribution record"), node("p", `${new Date(pay.period).toISOString().slice(0, 10)} to ${new Date(pay.ends).toISOString().slice(0, 10)} / UTC Monday to Monday`));
    const percent = pay.assigned ? (pay.accomplished * 100 / pay.assigned).toFixed(1) : "0";
    const progress = node("progress"); progress.max = pay.assigned || 1; progress.value = pay.accomplished;
    progress.setAttribute("aria-label", "Approved weekly task completion");
    card.append(progress, node("p", `${pay.accomplished} / ${pay.assigned} assigned tasks approved (${percent}%)`),
      node("p", "Above 60%: configured base + completed-task incentives. At or below 60%: incentives only, no base, and return to visitor. No assignments: membership stays and no salary record.", "fine"));
    card.append(node("p", pay.configured ? `Configured weekly base: ${pay.base.toLocaleString()} FTHS. Incentive per approved task: ${pay.incentivePerTask.toLocaleString()} FTHS. Evaluated after the cycle closes.` : "Reward amounts are not configured for this cycle. No FTHS will be issued; completion and membership rules still apply.", "fine"));
    for (const record of pay.history) card.append(node("p", `${new Date(record.period).toISOString().slice(0, 10)} / ${record.accomplished}/${record.assigned} approved / Base ${record.base} + incentive ${record.incentive} = ${record.total} FTHS / ${record.qualified ? "membership retained" : "returned to visitor"}${record.configured ? "" : " / policy unconfigured"}`, "fine"));
    root.append(card);
    if (active) {
      $("reward-record").replaceChildren(card.cloneNode(true));
      const summary = $("reward-summary"); summary.replaceChildren(node("h2", `${state.me.silver.toLocaleString()} FTHS earned balance`),
        node("p", eligibilityText(pay)), node("p", "Existing weekly evaluation rules are unchanged. No manual payout is enabled from this workspace.", "fine"));
      renderOverview();
    }
  }
  function eligibilityText(pay) {
    if (!pay.assigned) return "No assigned tasks this week. Membership is retained; no salary record is created.";
    const qualified = pay.accomplished * 100 > pay.assigned * pay.threshold;
    const remaining = Math.max(0, Math.floor(pay.assigned * pay.threshold / 100) + 1 - pay.accomplished);
    return `${pay.accomplished}/${pay.assigned} independently approved. ${qualified ? "Above the weekly base threshold."
      : `${remaining} more approval${remaining === 1 ? "" : "s"} needed to exceed ${pay.threshold}%.`}
      ${pay.configured ? "Amounts are evaluated after the cycle closes, not on submission." : "This cycle is unconfigured: no FTHS will be issued."}`;
  }
  function managesMission(mission) {
    const member = state.me.member;
    return member.role === "director" || member.division === mission.division
      && (member.role === "manager" || member.role === "lead" && member.team === mission.team);
  }
  function missionTodos(mission) { return typeof mission.todos === "string" ? JSON.parse(mission.todos) : mission.todos || []; }
  function renderOverview() {
    if (state.me?.member?.status !== "active") return;
    const key = JSON.stringify([state.me.address, state.me.profile?.username, state.me.member, state.me.compensation,
      state.missionsLoaded, state.missions.map(mission => [mission.id, mission.title, mission.status, mission.assignee, mission.team])]);
    if (key === state.overviewKey) return;
    state.overviewKey = key;
    $("workspace-greeting").textContent = `Welcome, ${state.me.profile?.username || short(state.me.address)}`;
    const own = state.missions.filter(mission => mission.assignee === state.me.address && !["done", "cancelled"].includes(mission.status));
    const reviews = state.missions.filter(mission => mission.status === "review" && mission.assignee !== state.me.address && managesMission(mission));
    const metrics = $("workspace-metrics"); metrics.replaceChildren();
    for (const [value, label] of [[state.missionsLoaded ? own.length : "—", "Active missions"],
      [state.missionsLoaded ? reviews.length : "—", "Awaiting your review"],
      [`${state.me.compensation.accomplished}/${state.me.compensation.assigned}`, "Weekly approved"],
      [state.me.member.level, "Learning level"]]) {
      const card = node("div", undefined, "metric"); card.append(node("strong", String(value)), node("small", label)); metrics.append(card);
    }
    $("mission-count").textContent = state.missionsLoaded && own.length ? String(own.length) : "";
    const next = $("next-missions"); next.replaceChildren();
    for (const mission of [...reviews, ...own].slice(0, 4)) {
      const row = node("div", undefined, "next-mission");
      row.append(node("strong", mission.title), node("small", `${statusLabel(mission.status)} / ${mission.team}`),
        button(mission.status === "review" && mission.assignee !== state.me.address ? "Review evidence" : "Continue", () => editMission(mission)));
      next.append(row);
    }
    if (!next.children.length) next.append(node("p", state.missionsLoaded ? "You are up to date. Find an available team mission or continue learning." : "Mission data is not available yet. Open Missions to load or retry.", "fine"));
    $("workspace-eligibility").replaceChildren(node("p", eligibilityText(state.me.compensation)));
  }
  function renderProposal() {
    const plan = window.FeatheralOrgSetup, root = $("org-proposal"); root.replaceChildren();
    const notice = node("div", undefined, "proposal-notice");
    notice.append(node("strong", "Proposed operating model / fictional personnel"),
      node("p", "Every Demo persona, experience and skillset below is an illustrative staffing target. No accounts, positions or permissions are created. Actual members are in the Actual organization tab."));
    root.append(notice);
    const rules = node("ul"); for (const principle of plan.principles) rules.append(node("li", principle)); root.append(rules);
    function personaCard(persona, title) {
      const card = node("article", undefined, "card proposal-person");
      card.append(node("small", "FICTIONAL PLACEHOLDER"), node("h3", title), node("strong", persona.name),
        node("p", persona.experience, "fine"), node("p", `Skills: ${persona.skills}`, "fine"), node("p", `Focus: ${persona.focus}`));
      return card;
    }
    root.append(personaCard(plan.coordination, plan.coordination.role));
    const divisions = node("div", undefined, "proposal-divisions");
    for (const division of plan.divisions) {
      const section = node("details", undefined, "proposal-division"); section.open = division.id === state.me.member.division;
      section.append(node("summary", `${division.name} / ${division.teams.length} delivery teams`),
        personaCard({ ...division, name: division.persona }, "Proposed division manager"));
      const teams = node("div", undefined, "proposal-teams");
      for (const [id, name, alias, years, skills, focus] of division.teams) {
        const card = personaCard({ name: alias, experience: `Illustrative ${years}`, skills, focus }, `${name} / proposed lead`);
        card.append(node("p", `Team: ${division.id}-${id}. Lean pod: lead + 1–3 contributors; shared quality/reliability specialist and learning mentor.`, "fine"));
        teams.append(card);
      }
      section.append(teams); divisions.append(section);
    }
    root.append(divisions, node("h2", "Progression at every level"));
    const levels = node("div", undefined, "level-path");
    for (const [level, label, focus] of plan.levels) {
      const card = node("article", undefined, "card"); card.append(node("strong", `${level} / ${label}`), node("p", focus, "fine")); levels.append(card);
    }
    root.append(levels, node("h2", "Delivery cadence"), node("p", plan.cadence),
      node("p", "Cross-division squads: Identity & trust (Wallet / App / Admin); Commerce & rewards (Pay / Silver / Exchange / Dollar); World-building (World / Media / Learning); Reliability & evidence (DB / Ledger / Gold / Stats). Each squad has one accountable division owner and uses existing scoped missions.", "fine"));
  }
  for (const choice of document.querySelectorAll("[data-org-view]")) choice.addEventListener("click", () => {
    $("org-proposal").hidden = choice.dataset.orgView !== "proposal"; $("org-live").hidden = choice.dataset.orgView !== "live";
    for (const tab of document.querySelectorAll("[data-org-view]")) tab.setAttribute("aria-pressed", String(tab === choice));
  });
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
    const owner = state.me?.address;
    let data;
    $("mission-load-status").textContent = "Loading latest missions…"; $("retry-missions").hidden = true;
    try { data = await api("/missions"); }
    catch (error) {
      if (state.me?.address === owner) {
        $("mission-load-status").textContent = `Missions could not be refreshed: ${error.message}${state.missionsLoaded ? " Showing last loaded records." : ""}`;
        $("retry-missions").hidden = false;
      }
      throw error;
    }
    if (state.me?.address !== owner || state.me?.member?.status !== "active") return;
    const changed = !state.missionsLoaded || JSON.stringify(state.missions) !== JSON.stringify(data.missions);
    state.missions = data.missions; state.missionsLoaded = true; state.missionsRefreshedAt = Date.now();
    $("agenda-access").textContent = `Your level: ${state.me.member.level} / Division: ${state.me.member.division}. Higher-level agendas and private team resources remain gated.`;
    $("mission-load-status").textContent = "";
    if (changed) renderMissions();
    renderOverview();
  }
  const statusLabel = value => ({ draft: "Brief", ready: "Ready", in_progress: "In progress", review: "Awaiting review", done: "Approved", cancelled: "Cancelled" })[value] || value;
  function renderMissions() {
    $("mission-list").replaceChildren();
    const search = $("mission-search").value.trim().toLowerCase();
    const visible = state.missions.filter(mission => {
      const filter = state.missionFilter;
      return (!search || `${mission.title} ${mission.body} ${mission.team}`.toLowerCase().includes(search))
        && (filter === "all" || filter === "mine" && mission.assignee === state.me.address && !["done", "cancelled"].includes(mission.status)
          || filter === "available" && !mission.assignee && mission.status === "ready" && mission.team === state.me.member.team
          || filter === "review" && mission.status === "review" && mission.assignee !== state.me.address && managesMission(mission)
          || filter === "done" && mission.status === "done");
    });
    for (const mission of visible) {
      const card = node("article", undefined, `card mission-card status-${mission.status}`);
      const heading = node("div", undefined, "mission-card-heading");
      heading.append(node("span", statusLabel(mission.status), `status-chip ${mission.status}`), node("small", mission.min_level));
      const todos = missionTodos(mission), completed = todos.filter(todo => todo.done).length;
      card.append(heading, node("h2", mission.title), node("p", mission.body, "mission-brief"),
        node("small", mission.team), node("small", mission.assignee ? `Assigned: ${personName(mission.assignee)}` : "Not assigned"));
      if (todos.length) {
        const progress = node("progress"); progress.max = todos.length; progress.value = completed;
        progress.setAttribute("aria-label", `${completed} of ${todos.length} todos complete`);
        card.append(node("p", `${completed}/${todos.length} todos complete`, "fine"), progress);
      }
      const controls = node("div", undefined, "mission-card-actions");
      controls.append(button(mission.status === "review" && mission.assignee !== state.me.address && managesMission(mission)
        ? "Review evidence" : mission.assignee === state.me.address ? "Continue mission" : "View mission", () => editMission(mission)));
      if (!mission.assignee && mission.status === "ready" && mission.team === state.me.member.team)
        controls.append(button("Take mission", async () => {
          if (!confirm("Assign this task to you for this week's completion evaluation? Only approved completion counts.")) return;
          await api(`/missions/${mission.id}/claim`, { revision: mission.revision }); await loadMe();
          state.missionFilter = "mine"; updateMissionFilters(); renderMissions();
        }));
      card.append(controls);
      $("mission-list").append(card);
    }
    if (!visible.length) $("mission-list").append(node("p", "No missions match this view. Check Available or Division, or ask your team lead for a brief.", "empty-state"));
  }
  function updateMissionFilters() {
    for (const choice of document.querySelectorAll("[data-mission-filter]"))
      choice.setAttribute("aria-pressed", String(choice.dataset.missionFilter === state.missionFilter));
  }
  for (const choice of document.querySelectorAll("[data-mission-filter]")) choice.addEventListener("click", () => {
    state.missionFilter = choice.dataset.missionFilter; updateMissionFilters(); renderMissions();
  });
  $("mission-search").addEventListener("input", renderMissions);
  action($("retry-missions"), loadMissions);
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
    $("mission-dialog-title").textContent = mission ? "Mission / " + statusLabel(mission.status) : "Create mission";
    state.missionTodos = mission ? missionTodos(mission).map(todo => ({ ...todo })) : [];
    state.todoDefinitionsEditable = manager && (!mission || mission.assignee !== state.me.address) && editable;
    state.todoEditable = editable;
    renderMissionTodos();
    fillSelect($("mission-division"), state.me.org.divisions.map(division => [division.id, division.name]), mission?.division || member.division);
    missionTeamOptions(mission?.team || member.team, mission?.assignee || "");
    fillSelect($("mission-min_level"), state.me.org.levels.map(level => [level, level]), mission?.min_level || "learning");
    const states = manager && mission?.assignee !== state.me.address ? [...state.me.org.states]
      : ({ ready: ["ready", "in_progress"], in_progress: ["in_progress", "review"], review: ["review", "in_progress"] })[mission?.status] || [mission?.status || "draft"];
    if (mission && !states.includes(mission.status)) states.push(mission.status);
    fillSelect($("mission-status"), states.map(value => [value, statusLabel(value)]), mission?.status || "draft");
    $("mission-status").disabled = !editable; $("mission-evidence").disabled = !editable; $("save-mission").hidden = !editable;
    $("mission-workflow").textContent = "Checklist completion is self-reported progress. Review requires all todos and evidence. A different scoped manager approves the outcome; only approval counts toward weekly rewards.";
    const next = $("mission-next-actions"); next.replaceChildren();
    const transition = mission?.assignee === state.me.address
      ? ({ ready: ["in_progress", "Start mission"], in_progress: ["review", "Submit for review"], review: ["in_progress", "Continue revisions"] })[mission.status]
      : manager && mission?.status === "review" ? ["done", "Approve completion"] : null;
    if (editable && transition) {
      next.append(button(transition[1], () => {
        $("mission-status").value = transition[0]; $("mission-form").requestSubmit();
      }));
      if (manager && mission?.status === "review" && mission.assignee !== state.me.address)
        next.append(button("Request revisions", () => { $("mission-status").value = "in_progress"; $("mission-form").requestSubmit(); }));
    }
    $("mission-error").textContent = ""; $("mission-dialog").showModal();
  }
  action($("new-mission"), () => editMission());
  $("close-mission").addEventListener("click", () => $("mission-dialog").close());
  $("mission-dialog").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); $("mission-dialog").close(); }
  });
  function renderMissionTodos() {
    const root = $("mission-todos"); root.replaceChildren();
    $("add-mission-todo").hidden = !state.todoDefinitionsEditable;
    $("add-mission-todo").disabled = state.missionTodos.length >= 24;
    for (const todo of state.missionTodos) {
      const row = node("div", undefined, "mission-todo"), check = node("input");
      check.type = "checkbox"; check.checked = todo.done; check.disabled = !state.todoEditable;
      check.setAttribute("aria-label", `Complete ${todo.label || "todo"}`);
      check.addEventListener("change", () => { todo.done = check.checked; });
      const label = node("input"); label.value = todo.label; label.maxLength = 240; label.required = true;
      label.disabled = !state.todoDefinitionsEditable; label.setAttribute("aria-label", "Todo requirement");
      label.addEventListener("input", () => { todo.label = label.value; check.setAttribute("aria-label", `Complete ${todo.label || "todo"}`); });
      row.append(check, label);
      if (state.todoDefinitionsEditable) row.append(button("Remove", () => {
        state.missionTodos = state.missionTodos.filter(entry => entry !== todo); renderMissionTodos();
      }));
      root.append(row);
    }
    if (!state.missionTodos.length) root.append(node("p", "No checklist specified. The mission brief and evidence remain the acceptance criteria.", "fine"));
  }
  action($("add-mission-todo"), () => {
    if (!state.todoDefinitionsEditable || state.missionTodos.length >= 24) return;
    state.missionTodos.push({ id: crypto.randomUUID(), label: "", done: false }); renderMissionTodos();
    $("mission-todos").lastElementChild.querySelector('input[aria-label="Todo requirement"]').focus();
  });
  $("mission-form").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("save-mission");
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const input = Object.fromEntries(["title", "body", "division", "team", "assignee", "status", "evidence", "min_level"].map(field => [field, $("mission-" + field).value]));
      input.todos = state.missionTodos.map(todo => ({ ...todo }));
      if (["review", "done"].includes(input.status) && (input.todos.some(todo => !todo.done) || !input.evidence.trim()))
        throw new Error("Complete every todo and provide evidence before review or approval.");
      if (state.mission) input.revision = state.mission.revision;
      await api(`/missions${state.mission ? "/" + state.mission.id : ""}`, input, state.mission ? "PUT" : "POST");
      $("mission-dialog").close(); await loadMe();
      $("status").textContent = input.status === "review" ? "Mission submitted for independent review. Submission does not unlock rewards."
        : input.status === "done" ? "Mission completion approved. The weekly contribution record has been updated." : "Mission progress saved.";
      $("status").hidden = false;
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
    clearTimeout(quizRetryTimer);
    clearPrivate(); state.me = null; state.experience = null; state.interests = [];
    $("workspace").hidden = true; $("onboarding").hidden = false; $("signup").hidden = true; $("signin").hidden = false;
    $("promotion-path").textContent = "World profile → App membership → Admin by explicit approval.";
    $("status").hidden = true;
    for (const id of ["profile-editor", "visitor-learning", "member-learning", "visitor-compensation", "member-compensation", "experience-choices", "interest-choices"]) $(id).replaceChildren();
    $("motivation").value = "";
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
      if (!document.hidden) {
        await loadChannels(); await loadMessages();
        if (["missions", "overview"].includes(state.view) && Date.now() - state.missionsRefreshedAt >= 30000) await loadMissions();
      }
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
    else if (state.me?.member?.status === "active") show(location.hash.slice(1), false);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void tick(); });
  setInterval(() => void tick(), 3000);
  setMenu(false, false);
  const hasWorldHandoff = new URL(location.href).searchParams.has("worldAppSignIn");
  void (async () => {
    const url = new URL(location.href), code = url.searchParams.get("worldAppSignIn");
    if (code) {
      url.searchParams.delete("worldAppSignIn"); history.replaceState(null, "", url.href);
      await api("/world-login", { code });
    }
    await loadMe();
  })().catch(error => { if (error.status !== 401 || hasWorldHandoff) status(error); });
})();
