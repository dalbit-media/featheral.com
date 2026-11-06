"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Notes } = require("../../notes/ledger");
const { Creation } = require("../../notes/creation");
const { Workspace } = require("../../notes/workspace");
const { courses } = require("../../notes/work-learning");
const { weekStart, WEEK } = require("../../notes/workspace-hr");
test("an older read-only snapshot starts without creating or migrating HR tables", t => {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {});
  t.after(() => notes.close());
  const writer = new Workspace(notes, creation.markets);
  for (const name of ["work_enrollment", "work_learning", "work_positions", "work_pay_policy",
    "work_assignments", "work_payroll", "work_paid_missions"]) notes.db.exec(`DROP TABLE ${name}`);
  notes.db.exec("ALTER TABLE work_missions DROP COLUMN min_level");
  const before = notes.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  notes.db.readOnlyReplica = true; notes.db.exec("PRAGMA query_only=ON");
  const warnings = t.mock.method(console, "warn", () => {});
  const replica = new Workspace(notes, creation.markets);
  assert.throws(() => replica.hr.assertReady(), error => error.status === 503 && /writable source/.test(error.message));
  replica.hr.start(); assert.equal(replica.hr.timer, undefined);
  assert.deepEqual(notes.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), before);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(writer.hr.schemaReady, true);
});
test("a current read-only snapshot preserves HR records and disables evaluations", t => {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {});
  t.after(() => notes.close());
  const writer = new Workspace(notes, creation.markets);
  const before = writer.org();
  notes.db.readOnlyReplica = true; notes.db.exec("PRAGMA query_only=ON");
  const replica = new Workspace(notes, creation.markets);
  replica.hr.assertReady(); replica.hr.start(); replica.hr.settleDue();
  assert.equal(replica.hr.timer, undefined);
  assert.deepEqual(replica.org(), before);
});
function fixture(t) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {}), profiles = new Map();
  let now = Date.UTC(2026, 10, 2, 12);
  const workspace = new Workspace(notes, creation.markets, owner => profiles.get(owner), () => now);
  t.after(() => { workspace.hr.close(); notes.close(); });
  const owner = "0x" + "1".repeat(40), manager = "0x" + "2".repeat(40);
  async function enroll(address = owner, interest = "engineering") {
    profiles.set(address, { username: "Contributor" });
    await workspace.apply(address, { motivation: "Help with verified work", experience: "building", interests: [interest] });
    return address;
  }
  function pass(stage = "orientation", address = owner) {
    for (const course of courses.filter(row => row.level === stage)) workspace.hr.quiz(address, course.id, { answers: course.questions.map(question => question.answer) });
  }
  function configure(base = 100, incentive = 10) {
    return workspace.hr.configure("admin", { rates: Object.fromEntries(["orientation", "learning", "practitioner", "mentor", "steward"].map(level => [level, base])),
      incentive, approval: "CONFIGURE WEEKLY FTHS" });
  }
  function task(index, done = false, assignee = owner) {
    return workspace.saveMission("admin", { title: `Task ${index}`, body: "Deliver verified evidence", division: "engineering", team: "engineering-general",
      assignee, status: done ? "done" : "ready", evidence: done ? "Verified by reviewer" : "" }, null, true);
  }
  return { workspace, notes, profiles, owner, manager, enroll, pass, configure, task,
    setTime: value => { now = value; }, nextWeek: () => { now = weekStart(now) + WEEK; }, now: () => now };
}
test("orientation quizzes automatically grant membership at 80%, never management privileges", async t => {
  const f = fixture(t); await f.enroll();
  assert.equal(f.workspace.member(f.owner).status, "visitor");
  const course = courses[0], correct = course.questions.map(question => question.answer);
  const sixty = correct.map((answer, index) => index < 3 ? answer : (answer + 1) % 3);
  assert.equal(f.workspace.hr.quiz(f.owner, course.id, { answers: sixty }).passed, false);
  assert.equal(f.workspace.member(f.owner).status, "visitor");
  const eighty = correct.map((answer, index) => index < 4 ? answer : (answer + 1) % 3);
  assert.equal(f.workspace.hr.quiz(f.owner, course.id, { answers: eighty }).score, 80);
  f.pass();
  const member = f.workspace.active(f.owner);
  assert.equal(member.level, "learning"); assert.equal(member.role, "volunteer");
  assert.equal(member.division, "engineering"); assert.equal(member.team, "engineering-general");
  assert.equal(f.workspace.hr.learning(f.owner).courses.some(course => course.questions.some(question => "answer" in question)), false);
});
test("learning levels are sequential and membership is never trusted from quiz input", async t => {
  const f = fixture(t); await f.enroll();
  assert.throws(() => f.workspace.hr.quiz(f.owner, "delivery", { answers: [0, 1, 2, 0, 1], level: "steward" }), /current learning/);
  assert.throws(() => f.workspace.hr.quiz(f.owner, "ecosystem", { answers: [0] }), /every quiz/);
  assert.throws(() => f.workspace.hr.quiz(f.owner, "ecosystem", { answers: [0, 1, -1, 1, 2] }), /valid option/);
  f.pass(); f.pass("learning"); assert.equal(f.workspace.member(f.owner).level, "practitioner");
  f.pass("practitioner"); assert.equal(f.workspace.member(f.owner).level, "mentor");
  f.pass("mentor"); assert.equal(f.workspace.member(f.owner).level, "steward");
  assert.equal(f.workspace.member(f.owner).role, "volunteer");
});
test("experience and interests are required, validated and not public directory or organization data", async t => {
  const f = fixture(t); f.profiles.set(f.owner, { username: "Visitor" });
  await assert.rejects(f.workspace.apply(f.owner, { motivation: "Help" }), /experience/);
  await assert.rejects(f.workspace.apply(f.owner, { motivation: "Help", experience: "new", interests: ["engineering", "engineering"] }), /interest/);
  await f.enroll(); assert.equal((await f.workspace.me(f.owner)).org.positions.length, 0);
  f.pass();
  const org = f.workspace.org();
  assert.ok(org.positions.length >= 42);
  assert.ok(org.positions.some(position => position.id === "lead-wallet"));
  assert.ok(org.positions.some(position => position.id === "lead-silver"));
  assert.equal(JSON.stringify(org.positions).includes('"experience":'), false);
  assert.ok(org.positions.find(position => position.id === "contributors-engineering-general").members.some(member => member.address === f.owner));
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0, "registration and learning do not mint funds");
});
test("agenda is level-gated, task claims are team-bound and revision-safe, and self approval is denied", async t => {
  const f = fixture(t); await f.enroll(); f.pass();
  const advanced = f.workspace.saveMission("admin", { title: "Advanced", body: "Steward work", division: "engineering",
    team: "engineering-general", assignee: "", status: "ready", min_level: "steward" }, null, true);
  assert.equal(f.workspace.missions(f.owner).some(row => row.id === advanced.id), false);
  assert.throws(() => f.workspace.hr.claim(f.owner, advanced.id, { revision: 1 }), /unavailable/);
  const ready = f.workspace.missions(f.owner).find(row => row.id === "orientation-engineering");
  const claimed = f.workspace.hr.claim(f.owner, ready.id, { revision: ready.revision });
  assert.equal(claimed.assignee, f.owner);
  assert.throws(() => f.workspace.hr.claim(f.owner, ready.id, { revision: ready.revision }), /already assigned/);
  assert.throws(() => f.workspace.hr.claim(f.owner, "ecosystem-wallet", { revision: 1 }), /team/);
  f.workspace.setMember("admin", f.owner, { ...f.workspace.member(f.owner), role: "lead" });
  assert.throws(() => f.workspace.saveMission(f.owner, { ...claimed, status: "done", evidence: "Self-reviewed" }, claimed.id), /different manager/);
  assert.throws(() => f.workspace.saveMission(f.owner, { ...claimed, status: "cancelled" }, claimed.id), /different manager/);
});
for (const [completed, assigned, expectedBase, expectedTotal, active] of [[3, 5, 0, 30, false], [4, 5, 100, 140, true], [2, 3, 100, 120, true], [0, 5, 0, 0, false]]) {
  test(`${completed}/${assigned} weekly completion records exact base/incentive rule and ${active ? "retains" : "revokes"} membership`, async t => {
    const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek();
    for (let index = 0; index < assigned; index++) f.task(index, index < completed);
    assert.equal(f.notes.balance(f.owner, "FTHS"), 0);
    f.nextWeek(); f.workspace.hr.settleDue();
    const history = f.workspace.hr.compensation(f.owner).history;
    assert.equal(history[0].base, expectedBase); assert.equal(history[0].total, expectedTotal);
    assert.equal(history[0].accomplished, completed);
    assert.equal(f.notes.balance(f.owner, "FTHS"), expectedTotal);
    assert.equal(f.workspace.member(f.owner).status, active ? "active" : "visitor");
    f.workspace.hr.settleDue(); f.workspace.admin();
    assert.equal(f.notes.balance(f.owner, "FTHS"), expectedTotal, "retry cannot issue twice");
  });
}
test("failure removes every internal authorization, ends calls, preserves earned funds and requires fresh quizzes", async t => {
  const f = fixture(t); await f.enroll(); f.pass();
  await f.enroll(f.manager); f.pass("orientation", f.manager);
  f.configure(); f.nextWeek();
  const dm = f.workspace.direct(f.owner, f.manager);
  const file = f.workspace.send(f.manager, dm.id, { body: "Private", request: "file", attachment: { name: "private.txt", base64: Buffer.from("private").toString("base64") } });
  f.workspace.document(f.owner, dm.id, { body: "Internal", revision: 0 });
  const call = f.workspace.startCall(f.owner, { channel: dm.id, callee: f.manager });
  f.workspace.signal(f.manager, call.id, { type: "accept" });
  f.workspace.db.prepare("INSERT INTO work_push VALUES ('endpoint',?,'{}',0)").run(f.owner);
  for (let index = 0; index < 5; index++) f.task(index, index < 3);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.db.prepare("SELECT COUNT(*) AS n FROM work_calls WHERE id=? AND status!='ended'").get(call.id).n, 0);
  for (const operation of [
    () => f.workspace.missions(f.owner), () => f.workspace.channels(f.owner),
    () => f.workspace.messages(f.owner, dm.id), () => f.workspace.document(f.owner, dm.id),
    () => f.workspace.file(f.owner, file.file), () => f.workspace.signals(f.owner, call.id, 0),
  ]) assert.throws(operation, error => [403, 404].includes(error.status));
  assert.equal(f.workspace.db.prepare("SELECT COUNT(*) AS n FROM work_push WHERE address=?").get(f.owner).n, 0);
  assert.equal(f.workspace.hr.learning(f.owner).courses.every(course => !course.progress), true);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 30);
  f.pass(); assert.equal(f.workspace.active(f.owner).level, "learning");
});
test("no assignments keep membership and produce no salary history", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure();
  f.nextWeek(); f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.active(f.owner).status, "active");
  assert.equal(f.workspace.hr.compensation(f.owner).history.length, 0);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0);
});
test("all-cancelled assignments keep membership without recording salary", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek();
  const cancelled = f.task(0);
  f.workspace.saveMission("admin", { ...cancelled, status: "cancelled" }, cancelled.id, true);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.member(f.owner).status, "active");
  assert.equal(f.workspace.hr.compensation(f.owner).history.length, 0);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0);
});
test("demotion releases unfinished work but never reactivates withdrawn or draft tasks", async t => {
  const f = fixture(t); await f.enroll(); f.pass();
  const cancelled = f.task(0), draft = f.task(1), missed = f.task(2);
  f.workspace.saveMission("admin", { ...cancelled, status: "cancelled" }, cancelled.id, true);
  f.workspace.saveMission("admin", { ...draft, status: "draft" }, draft.id, true);
  f.nextWeek(); f.workspace.hr.settleDue();
  const get = id => f.workspace.db.prepare("SELECT * FROM work_missions WHERE id=?").get(id);
  assert.equal(f.workspace.member(f.owner).status, "visitor");
  assert.equal(get(cancelled.id).status, "cancelled"); assert.equal(get(draft.id).status, "draft");
  assert.equal(get(missed.id).status, "ready"); assert.equal(get(missed.id).assignee, "");
});
test("reassignment moves the denominator to the new assignee and cannot double-pay one task", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); await f.enroll(f.manager); f.pass("orientation", f.manager);
  f.configure(); f.nextWeek(); const original = f.task(0);
  const moved = f.workspace.saveMission("admin", { ...original, assignee: f.manager, status: "done", evidence: "Reviewed delivery" }, original.id, true);
  assert.equal(moved.assignee, f.manager);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.hr.compensation(f.owner).history.length, 0);
  assert.equal(f.workspace.member(f.owner).status, "active");
  assert.equal(f.notes.balance(f.manager, "FTHS"), 110);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0);
});
test("late approval evaluates the closed week first and cannot retroactively rescue membership", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek(); const missed = f.task(0);
  f.nextWeek();
  assert.throws(() => f.workspace.saveMission("admin", { ...missed, status: "done", evidence: "Late approval" }, missed.id, true), /changed/);
  assert.equal(f.workspace.member(f.owner).status, "visitor");
  assert.equal(f.workspace.hr.compensation(f.owner).history[0].accomplished, 0);
});
test("policies require every level, safe whole units and the exact approval phrase", t => {
  const f = fixture(t);
  assert.throws(() => f.workspace.hr.configure("admin", { rates: { learning: 100 }, incentive: 10, approval: "CONFIGURE WEEKLY FTHS" }), /every level/);
  assert.throws(() => f.configure(-1), /every level/);
  assert.throws(() => f.configure(1.5), /every level/);
  assert.throws(() => f.configure(100, Number.MAX_SAFE_INTEGER), /every level/);
  assert.throws(() => f.workspace.hr.configure("admin", { rates: { orientation: 0, learning: 100, practitioner: 200, mentor: 300, steward: 400 }, incentive: 10, approval: "approve" }), /confirm/);
  assert.equal(f.workspace.hr.policy(), null);
});
test("unconfigured cycles cannot mint reward or silently invent default salary", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.task(0, true);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.hr.compensation(f.owner).history[0].status, "unconfigured");
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0);
  assert.equal(f.workspace.member(f.owner).status, "active");
});
test("policy activates next Monday and existing assignments freeze their base through level advancement", async t => {
  const f = fixture(t); await f.enroll(); f.pass();
  const config = f.workspace.hr.configure("admin", { rates: { orientation: 0, learning: 100, practitioner: 200, mentor: 300, steward: 400 }, incentive: 10, approval: "CONFIGURE WEEKLY FTHS" });
  assert.equal(config.effective, weekStart(f.now()) + WEEK); assert.equal(f.workspace.hr.policy(), null);
  f.nextWeek(); f.task(0, true); f.pass("learning"); f.task(1, true);
  f.configure(900, 90); f.nextWeek(); f.workspace.hr.settleDue();
  const record = f.workspace.hr.compensation(f.owner).history[0];
  assert.equal(record.base, 100); assert.equal(record.incentive, 20); assert.equal(record.total, 120);
});
test("unfinished carryover is evaluated through missed weeks and cannot disappear during downtime", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek();
  for (let index = 0; index < 5; index++) f.task(index, index < 4);
  f.setTime(f.now() + 3 * WEEK); f.workspace.hr.settleDue();
  const records = f.workspace.hr.compensation(f.owner).history;
  assert.equal(records.length, 2);
  assert.equal(records[0].assigned, 1); assert.equal(records[0].accomplished, 0);
  assert.equal(f.workspace.member(f.owner).status, "visitor");
  assert.equal(f.notes.balance(f.owner, "FTHS"), 140);
});
test("cancelled assignments are excluded, but an assignee cannot remove their own denominator", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek();
  const done = f.task(0, true), cancelled = f.task(1);
  f.workspace.saveMission("admin", { ...cancelled, status: "cancelled" }, cancelled.id, true);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.hr.compensation(f.owner).history[0].assigned, 1);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 110);
  assert.throws(() => f.workspace.saveMission("admin", { ...done, status: "ready" }, done.id, true), /Paid completed/);
});
test("weekly assigned work cannot receive a second mission grant", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek(); const mission = f.task(0, true);
  assert.throws(() => f.workspace.grant("admin", { address: f.owner, amount: 10, reason: "Duplicate", mission: mission.id, request: "duplicate", approval: "ISSUE 10 FTHS" }), /weekly payroll/);
});
test("editing historical completed evidence cannot create a fresh weekly salary assignment", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek();
  const done = f.task(0, true); f.nextWeek(); f.workspace.hr.settleDue();
  f.workspace.saveMission("admin", { ...done, evidence: "Corrected public evidence" }, done.id, true);
  assert.equal(f.workspace.hr.compensation(f.owner).assigned, 0);
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.hr.compensation(f.owner).history.length, 1);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 110);
});
test("payroll failures roll back supply, records and access changes and remain retryable", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek(); f.task(0, true);
  f.workspace.db.exec("CREATE TRIGGER fail_payroll BEFORE INSERT ON work_payroll BEGIN SELECT RAISE(ABORT,'payroll disk failure'); END");
  f.nextWeek(); assert.throws(() => f.workspace.hr.settleDue(), /payroll disk failure/);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 0); assert.equal(f.workspace.member(f.owner).status, "active");
  assert.equal(f.workspace.db.prepare("SELECT COUNT(*) AS n FROM work_paid_missions").get().n, 0);
  f.workspace.db.exec("DROP TRIGGER fail_payroll"); f.workspace.hr.settleDue();
  assert.equal(f.notes.balance(f.owner, "FTHS"), 110);
});
test("suspension is not undone by failed weekly evaluation or quizzes", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.task(0);
  f.workspace.setMember("admin", f.owner, { ...f.workspace.member(f.owner), status: "suspended" });
  f.nextWeek(); f.workspace.hr.settleDue();
  assert.equal(f.workspace.member(f.owner).status, "suspended");
  assert.throws(() => f.workspace.hr.quiz(f.owner, "ecosystem", { answers: courses[0].questions.map(question => question.answer) }), /visitor/);
});
test("reinitialization migrates pending visitors, preserves earned rewards and does not duplicate hierarchy or payroll", async t => {
  const f = fixture(t); await f.enroll(); f.pass(); f.configure(); f.nextWeek(); f.task(0, true);
  f.nextWeek(); f.workspace.hr.settleDue();
  const count = f.workspace.org().positions.length;
  f.workspace.db.prepare("INSERT INTO work_members VALUES (?,'pending','volunteer','orientation','learning','learning-general','',?)").run(f.manager, f.now());
  const reopened = new Workspace(f.notes, new Creation(f.notes, {}).markets, address => f.profiles.get(address), f.now);
  reopened.hr.settleDue();
  assert.equal(reopened.member(f.manager).status, "visitor");
  assert.equal(reopened.member(f.owner).status, "active");
  assert.equal(reopened.org().positions.length, count);
  assert.equal(reopened.hr.compensation(f.owner).history.length, 1);
  assert.equal(f.notes.balance(f.owner, "FTHS"), 110);
  const teamCount = reopened.org().teams.length;
  reopened.addTeam("admin", { division: "engineering", name: "Accessibility" });
  assert.equal(reopened.org().teams.length, teamCount + 1);
  assert.equal(reopened.org().positions.length, count + 2);
});
