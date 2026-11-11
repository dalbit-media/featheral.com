"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..", "..", "..");
const source = fs.readFileSync(path.join(root, "sites", "app.featheral.com", "app.js"), "utf8");
const owner = "0x" + "1".repeat(40), peer = "0x" + "2".repeat(40);
function fixture() {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ""; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, handler) { this.listeners[key] = handler; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    cloneNode() { const copy = new Node(this.tag); copy.children = [...this.children]; return copy; }
  }
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Node("div")); return nodes.get(id); };
  const document = { getElementById: get, createElement: tag => new Node(tag), querySelectorAll: () => [],
    querySelector: get, addEventListener() {}, body: new Node("body") };
  const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} };
  let request = async () => ({ missions: [] });
  vm.runInNewContext(`${source.slice(0, source.indexOf("  const hasWorldHandoff"))}
    window.test = { state, renderMissions, renderOverview, renderOrganization, renderProposal, eligibilityText, editMission, loadMissions };
  })();`, { window, document, console, URL, crypto: require("node:crypto"), setInterval() {}, clearTimeout() {},
    history: { replaceState() {} }, location: { hash: "", origin: "http://app.localhost" },
    fetch: async (...args) => {
      const data = await request(...args);
      return { ok: true, headers: { get: () => "application/json" }, json: async () => data };
    } });
  const ui = window.test;
  ui.state.me = { address: owner, profile: { username: "Fixture" }, silver: 0,
    member: { status: "active", role: "lead", level: "learning", division: "engineering", team: "engineering-general" },
    compensation: { period: 0, ends: 604800000, assigned: 5, accomplished: 3, threshold: 60, configured: false },
    org: { divisions: [{ id: "engineering", name: "Engineering" }], teams: [{ id: "engineering-general", division: "engineering", name: "General" }],
      levels: ["learning"], states: ["draft", "ready", "in_progress", "review", "done", "cancelled"] } };
  ui.state.members = [{ address: owner, team: "engineering-general" }, { address: peer, team: "engineering-general" }];
  return { ...ui, window, get, setRequest: value => { request = value; } };
}
const mission = (id, assignee, status, team = "engineering-general") => ({
  id, assignee, status, team, division: "engineering", min_level: "learning", title: `Mission ${id}`,
  body: "Verify acceptance criteria", revision: 1, todos: [{ id: "verify", label: "Verify", done: false }],
});
test("App mission views scope assigned, available, review and completed work and support search", () => {
  const ui = fixture();
  ui.state.missions = [mission("mine", owner, "in_progress"), mission("open", "", "ready"),
    mission("review", peer, "review"), mission("other-team", peer, "review", "engineering-wallet"), mission("done", owner, "done")];
  for (const [filter, expected] of [["mine", "mine"], ["available", "open"], ["review", "review"], ["done", "done"]]) {
    ui.state.missionFilter = filter; ui.renderMissions();
    assert.equal(ui.get("mission-list").children.length, 1);
    assert.equal(ui.get("mission-list").children[0].children[1].textContent, `Mission ${expected}`);
  }
  ui.state.missionFilter = "all"; ui.get("mission-search").value = "other-team"; ui.renderMissions();
  assert.equal(ui.get("mission-list").children.length, 1);
});
test("eligibility uses strict server threshold and explicitly distinguishes unconfigured/no-assignment records", () => {
  const ui = fixture(), pay = ui.state.me.compensation;
  assert.match(ui.eligibilityText(pay), /1 more approval.*no FTHS will be issued/s);
  assert.match(ui.eligibilityText({ ...pay, accomplished: 4, configured: true }), /Above the weekly base threshold.*after the cycle closes/s);
  assert.match(ui.eligibilityText({ ...pay, assigned: 0, accomplished: 0 }), /Membership is retained; no salary record/);
});
test("mission editor preserves authoritative states, snapshots todos and restricts self-managed checklist edits", () => {
  const ui = fixture(), work = mission("mine", owner, "ready"), states = [...ui.state.me.org.states];
  ui.editMission(work);
  assert.equal(ui.state.todoDefinitionsEditable, false);
  ui.state.missionTodos[0].done = true;
  assert.equal(work.todos[0].done, false);
  assert.deepEqual(ui.state.me.org.states, states);
  assert.deepEqual(ui.get("mission-status").children.map(option => option.value), ["ready", "in_progress"]);
  ui.editMission(mission("done", peer, "done"));
  assert.deepEqual(ui.state.me.org.states, states);
});
test("failed submission preserves evidence, todos and dialog; incomplete review never reaches the API", async () => {
  const ui = fixture(), work = mission("mine", owner, "in_progress");
  ui.state.me.member.role = "volunteer"; ui.editMission(work);
  ui.get("mission-status").value = "review"; ui.get("mission-evidence").value = "Evidence link";
  let requests = 0; ui.setRequest(async () => { requests++; throw new Error("API unavailable"); });
  const original = console.error; console.error = () => {};
  try {
    await ui.get("mission-form").listeners.submit({ preventDefault() {} });
    assert.equal(requests, 0);
    assert.match(ui.get("mission-error").textContent, /every todo/);
    ui.state.missionTodos[0].done = true;
    await ui.get("mission-form").listeners.submit({ preventDefault() {} });
    assert.equal(requests, 1);
    assert.equal(ui.get("mission-dialog").open, true);
    assert.equal(ui.get("mission-evidence").value, "Evidence link");
    assert.equal(ui.state.missionTodos[0].done, true);
    assert.equal(ui.get("save-mission").disabled, false);
  } finally { console.error = original; }
});
test("failed mission refresh exposes a retry without replacing previously loaded records", async () => {
  const ui = fixture(); ui.state.missions = [mission("mine", owner, "ready")]; ui.state.missionsLoaded = true;
  ui.setRequest(async () => { throw new Error("Offline"); });
  await assert.rejects(ui.loadMissions(), /Offline/);
  assert.equal(ui.state.missions.length, 1);
  assert.equal(ui.get("retry-missions").hidden, false);
  assert.match(ui.get("mission-load-status").textContent, /Showing last loaded/);
});
test("unchanged dashboard and mission refreshes preserve existing cards and keyboard focus targets", async () => {
  const ui = fixture(); ui.state.missions = [mission("mine", owner, "ready")]; ui.state.missionsLoaded = true;
  ui.renderOverview(); ui.renderMissions();
  const overviewCard = ui.get("next-missions").children[0], missionCard = ui.get("mission-list").children[0];
  ui.renderOverview();
  assert.equal(ui.get("next-missions").children[0], overviewCard);
  ui.setRequest(async () => ({ missions: ui.state.missions }));
  await ui.loadMissions();
  assert.equal(ui.get("mission-list").children[0], missionCard);
  ui.state.missions[0].title = "Updated delivery"; ui.renderOverview();
  assert.notEqual(ui.get("next-missions").children[0], overviewCard);
});
test("proposed organization covers every seeded site team without creating live permissions or payouts", () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "sites", "app.featheral.com", "org-setup.js"), "utf8"), { window });
  const setup = window.FeatheralOrgSetup;
  assert.equal(setup.divisions.length, 5);
  assert.equal(setup.divisions.flatMap(division => division.teams).length, 18);
  assert.ok(setup.divisions.every(division => division.persona.startsWith("Demo ") && division.skills && division.focus && division.experience));
  assert.ok(setup.divisions.flatMap(division => division.teams).every(team => team[2].startsWith("Demo ") && team.slice(3).every(Boolean)));
  const html = fs.readFileSync(path.join(root, "sites", "app.featheral.com", "index.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "controller IDs must remain unique");
  assert.match(html, /No new payout or stake-unlock flow is enabled/);
});
test("organization views render top-to-bottom icon cards for governance, divisions and teams", () => {
  const ui = fixture();
  const position = (id, parent, name, role, members = []) => ({ id, parent, name, role, members, responsibility: `${name} scope` });
  ui.state.me.org.positions = [
    position("foundation", null, "Foundation coordination", "director"),
    position("division-engineering", "foundation", "Engineering", "manager"),
    position("lead-wallet", "division-engineering", "Wallet lead", "lead"),
    position("contributors-wallet", "lead-wallet", "Wallet contributors", "contributor", [{ address: owner, level: "practitioner" }]),
  ];
  ui.renderOrganization();
  const liveText = ui.get("org-chart").children.flatMap(function walk(element) {
    return [element.textContent, ...element.children.flatMap(walk)];
  }).join(" ");
  assert.ok(liveText.indexOf("Foundation coordination") < liveText.indexOf("Engineering"));
  assert.ok(liveText.indexOf("Engineering") < liveText.indexOf("Wallet lead"));
  assert.ok(liveText.indexOf("Wallet lead") < liveText.indexOf("Wallet contributors"));
  assert.match(liveText, /🏛️|🧭|🛠️|👥/);
  assert.match(liveText, /You \/ practitioner/);

  ui.window.FeatheralOrgSetup = {
      principles: [], levels: [], cadence: "",
      coordination: { role: "Foundation coordinator", name: "Demo Atlas", experience: "Illustrative experience", focus: "Coordinates divisions." },
      divisions: [{ id: "engineering", name: "Engineering", persona: "Demo Forge", experience: "Illustrative experience",
        focus: "Builds products.", teams: [["wallet", "Wallet experience", "Demo Key", "6 years", "Wallet skills", "Wallet delivery."]] }],
  };
  ui.renderProposal();
  const proposalText = ui.get("org-proposal").children.flatMap(function walk(element) {
    return [element.textContent, ...element.children.flatMap(walk)];
  }).join(" ");
  assert.ok(proposalText.indexOf("Member governance") < proposalText.indexOf("Foundation coordinator"));
  assert.ok(proposalText.indexOf("Foundation coordinator") < proposalText.indexOf("Engineering"));
  assert.ok(proposalText.indexOf("Engineering") < proposalText.indexOf("Wallet experience"));
  assert.match(proposalText, /🏛️|🧭|🏢|👥/);
});
test("shared animations stay paused until the page, fonts and app have loaded", async () => {
  const css = fs.readFileSync(path.join(root, "shared", "site-links.css"), "utf8");
  assert.match(css, /html:not\(\.fth-ready\) \*:not\(\.page-transition-spinner\)[^{]*\{animation-play-state:paused!important;transition:none!important\}/);
  const classes = new Set(), attributes = new Set(["data-app-loading"]), events = [];
  let observer, onLoad;
  const documentElement = { classList: { contains: name => classes.has(name), add: name => classes.add(name) },
    hasAttribute: name => attributes.has(name) };
  const node = () => ({ dataset: {}, style: {}, children: [], append() {}, prepend() {}, setAttribute() {}, removeAttribute() {},
    replaceChildren() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, toggle() {} } });
  const document = { readyState: "interactive", documentElement, fonts: { ready: Promise.resolve() },
    body: node(), head: node(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    createElement: node, dispatchEvent: event => events.push(event.type) };
  const window = { location: new URL("http://world.localhost:8080/settlement/"), addEventListener: (type, callback) => { if (type === "load") onLoad = callback; } };
  class MutationObserver { constructor(callback) { observer = callback; } observe() {} disconnect() {} }
  const tick = () => new Promise(resolve => setTimeout(resolve, 50));
  vm.runInNewContext(fs.readFileSync(path.join(root, "shared", "site-links.js"), "utf8"),
    { window, document, URL, Event: class { constructor(type) { this.type = type; } }, MutationObserver, requestAnimationFrame: callback => setTimeout(callback, 0), setTimeout });
  await tick();
  assert.equal(classes.has("fth-ready"), false, "animations wait for window load");
  onLoad(); await tick();
  assert.equal(classes.has("fth-ready"), false, "animations wait for the app to finish rendering");
  attributes.delete("data-app-loading"); observer(); await tick();
  assert.equal(classes.has("fth-ready"), true);
  assert.deepEqual(events, ["featheral:ready"]);
});
test("App uses a standalone shell without losing shared site URLs", () => {
  const created = [];
  const document = { readyState: "complete", body: { dataset: { familyLayout: "true" } }, addEventListener() {},
    head: { append() {} }, querySelector: () => null, querySelectorAll: () => [],
    createElement: tag => { created.push(tag); return { dataset: {} }; } };
  const window = { location: new URL("http://app.localhost:8080/") };
  vm.runInNewContext(fs.readFileSync(path.join(root, "shared", "site-links.js"), "utf8"), { window, document, URL });
  assert.equal(document.body.dataset.standalone, "app");
  assert.equal(document.body.dataset.familyLayout, undefined);
  assert.equal(created.includes("footer"), false);
  assert.equal(window.FeatheralSites.url("world"), "http://world.localhost:8080/");
});
