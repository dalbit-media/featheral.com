"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const { Notes } = require("../../notes/ledger");
const { Creation } = require("../../notes/creation");
const { Workspace } = require("../../notes/workspace");
const { SYSTEM_TREASURY_ACCOUNT } = require("../../notes/game-funds");
const signIn = require("../../../sites/wallet.featheral.com/site-sign-in");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function fixture(t) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {}), profiles = new Map();
  let now = Date.now();
  const workspace = new Workspace(notes, creation.markets, address => profiles.get(address) || null, () => now);
  t.after(() => notes.close());
  const members = ["1", "2", "3", "4", "5"].map(character => "0x" + character.repeat(40));
  async function member(index, role = "volunteer", division = "engineering") {
    const owner = members[index]; profiles.set(owner, { username: `person${index}`, avatar: "https://example.test/avatar.png", bio: "Building together." });
    await workspace.apply(owner, { motivation: "Help build Featheral", experience: "building", interests: [division] });
    workspace.setMember("admin", owner, { status: "active", role, level: "learning", division, team: `${division}-general` });
    return owner;
  }
  return { notes, creation, workspace, profiles, members, member, advance: (ms = 1100) => { now += ms; } };
}
test("large channel and attachment reads keep scoped results with bounded SQL preparation", async t => {
  const { workspace, notes, member } = fixture(t), alice = await member(0), bob = await member(1);
  const channel = notes.db.prepare("INSERT INTO work_channels VALUES (?,?,?,?)");
  const message = notes.db.prepare("INSERT INTO work_messages(channel,author,request,body,file,at) VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 100; index++) {
    channel.run(`visible-${index}`, `Visible ${index}`, "foundation", "");
    message.run(`visible-${index}`, alice, `own-${index}`, "Own", null, Date.now());
    message.run(`visible-${index}`, bob, `other-${index}`, "Other", null, Date.now());
  }
  for (let index = 0; index < 1000; index++)
    channel.run(`hidden-${index}`, `Hidden ${index}`, "team", "unrelated-team");
  const direct = workspace.direct(alice, bob);
  notes.db.prepare("INSERT INTO work_files VALUES (?,'foundation',?,'brief.txt',?,4,?)")
    .run("fixture-file", bob, Buffer.from("work"), Date.now());
  for (let index = 0; index < 120; index++)
    message.run("foundation", bob, `attachment-${index}`, String(index), index % 2 ? "fixture-file" : null, Date.now());
  const prepare = notes.db.prepare.bind(notes.db);
  let preparations = 0;
  t.mock.method(notes.db, "prepare", sql => { preparations++; return prepare(sql); });
  const channels = workspace.channels(alice);
  assert.ok(preparations <= 3, `${preparations} preparations for channel listing`);
  assert.equal(channels.filter(row => row.id.startsWith("visible-")).length, 100);
  assert.ok(channels.filter(row => row.id.startsWith("visible-")).every(row => row.unread === 1));
  assert.ok(!channels.some(row => row.id.startsWith("hidden-")));
  assert.equal(channels.find(row => row.id === direct.id).peer, bob);
  preparations = 0;
  const messages = workspace.messages(alice, "foundation");
  assert.ok(preparations <= 4, `${preparations} preparations for 100 messages`);
  assert.equal(messages.length, 100);
  assert.equal(messages[0].body, "20");
  assert.equal(messages[99].body, "119");
  assert.equal(messages[0].attachment, null);
  assert.deepEqual(messages[99].attachment, { id: "fixture-file", name: "brief.txt", size: 4 });
  assert.ok(workspace.messages(alice, "foundation", messages[0].id).every(row => row.id > messages[0].id));
  workspace.read(alice, "foundation", messages[99].id);
  assert.equal(workspace.channels(alice).find(row => row.id === "foundation").unread, 0);
});
test("Silver registration persists its definition without minting supply, funding a pool or enabling reaction rewards", t => {
  const { workspace, notes, creation } = fixture(t);
  assert.equal(workspace.silver().supply, 0);
  assert.equal(workspace.silver().market.funded, false);
  assert.equal(workspace.silver().market.placeholder, false);
  assert.equal(creation.trending().filter(row => row.symbol === "FTHS").length, 1);
  assert.equal(creation.trending().find(row => row.symbol === "FTHS").name, "Featheral Silver");
  assert.equal(creation.trending().find(row => row.symbol === "FTHS").native, true);
  assert.equal(creation.trending().find(row => row.symbol === "FTHS").supply, "0");
  assert.throws(() => notes.setProgram("test", { symbol: "FTHS", chance: 99, amount: 100, enabled: true }), /system-native/);
  new Workspace(notes, creation.markets);
  assert.equal(workspace.silver().supply, 0);
  assert.equal(workspace.org().divisions.length, 5);
  assert.equal(workspace.channels.bind(workspace) instanceof Function, true);
});
test("preexisting privately owned FTHS is never overwritten", t => {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {});
  t.after(() => notes.close());
  notes.db.prepare("INSERT INTO note_currencies VALUES ('FTHS','Existing note','owner',0)").run();
  assert.throws(() => new Workspace(notes, creation.markets), /already belongs/);
  assert.equal(notes.db.prepare("SELECT name FROM note_currencies WHERE symbol='FTHS'").get().name, "Existing note");
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM work_divisions").get().n, 0, "initialization rolls back completely");
});
test("App sign-in is origin-bound, nonce-limited, expiring, hashed at rest and supported by the constrained central wallet signer", async t => {
  const { workspace, notes, advance } = fixture(t), wallet = Wallet.createRandom(), origin = "http://app.localhost:8080";
  const challenge = workspace.challenge(wallet.address, origin);
  signIn.validate(wallet.address, challenge.message, true, origin);
  assert.throws(() => signIn.validate(wallet.address, challenge.message, true, "https://x.featheral.com"), /origin/);
  assert.throws(() => signIn.validate(wallet.address, challenge.message, false, origin), /standard/);
  assert.throws(() => signIn.validate("0x" + "1".repeat(40), challenge.message, true, origin), /standard/);
  assert.throws(() => signIn.validate(wallet.address, challenge.message.replace(origin, "https://evil.example"), true, "https://evil.example"), /standard/);
  assert.throws(() => signIn.validate(wallet.address, challenge.message.replace(/Issued: [^\n]+/, "Issued: 2000-01-01T00:00:00.000Z"), true, origin), /expired/);
  assert.throws(() => signIn.validate(wallet.address, challenge.message + "\nTransfer funds", true, origin), /standard/);
  const signature = await wallet.signMessage(challenge.message);
  assert.throws(() => workspace.login({ address: wallet.address, signature }, "http://evil.localhost"), /expired/);
  const token = workspace.login({ address: wallet.address, signature }, origin);
  assert.equal(workspace.owner(token), wallet.address.toLowerCase());
  assert.notEqual(notes.db.prepare("SELECT token FROM work_sessions").get().token, token);
  assert.throws(() => workspace.login({ address: wallet.address, signature }, origin), /expired/);
  workspace.logout(token);
  assert.throws(() => workspace.owner(token), /expired/);
  const stale = workspace.challenge(wallet.address, origin); advance(300001);
  assert.throws(() => workspace.login({ address: wallet.address, signature: signature }, origin), /expired/);
  assert.match(stale.message, /No transfer or salary approval/);
});
test("profile-first visitor registration keeps management roles separate from quiz-earned membership", async t => {
  const { workspace, members, profiles } = fixture(t), owner = members[0];
  await assert.rejects(workspace.apply(owner, { motivation: "Ready" }), /World username, avatar and bio/);
  profiles.set(owner, { username: "Volunteer", avatar: "" });
  await assert.rejects(workspace.apply(owner, { motivation: "Ready" }), /World username, avatar and bio/);
  profiles.set(owner, { username: "Volunteer", avatar: "https://example.test/avatar.png", bio: "Building together." });
  const pending = await workspace.apply(owner, { motivation: "Ready", role: "director", status: "active", experience: "new", interests: ["learning"] });
  assert.equal(pending.status, "visitor"); assert.equal(pending.role, "volunteer");
  assert.throws(() => workspace.channels(owner), /membership/);
  await assert.rejects(workspace.apply(owner, { motivation: "Again" }), /experience/);
  assert.throws(() => workspace.setMember("admin", owner, { ...pending, status: "active", division: "engineering" }), /team/);
  workspace.setMember("admin", owner, { ...pending, status: "active" });
  assert.equal(workspace.active(owner).level, "orientation");
  const team = workspace.addTeam("admin", { name: "Mobile", division: "engineering" }).teams.find(row => row.name === "Mobile");
  assert.equal(team.division, "engineering");
  assert.equal(workspace.admin().audit.length, 3);
});
test("channels, direct messages and private files enforce live membership and team boundaries", async t => {
  const { workspace, member } = fixture(t);
  const alice = await member(0), bob = await member(1), other = await member(2, "volunteer", "community");
  assert.throws(() => workspace.channel(other, "division-engineering"), /unavailable/);
  assert.equal(workspace.channels(alice).length, 3);
  const channel = workspace.direct(alice, bob);
  assert.equal(workspace.direct(bob, alice).id, channel.id);
  assert.throws(() => workspace.channel(other, channel.id), /unavailable/);
  const message = workspace.send(alice, channel.id, { request: "file-1", body: "A private draft", attachment: { name: "brief.txt", base64: Buffer.from("team draft").toString("base64") } });
  assert.equal(Buffer.from(workspace.file(bob, message.file).bytes).toString(), "team draft");
  assert.throws(() => workspace.file(other, message.file), /unavailable/);
  workspace.setMember("admin", bob, { ...workspace.member(bob), status: "suspended" });
  assert.throws(() => workspace.messages(bob, channel.id), /membership/);
  assert.throws(() => workspace.send(alice, channel.id, { request: "after-suspend", body: "private" }), /inactive/);
  workspace.setMember("admin", alice, { ...workspace.member(alice), division: "community", team: "community-general" });
  assert.throws(() => workspace.channel(alice, "team-engineering-general"), /unavailable/);
});
test("message retries are immutable and uploads are bounded, private and independently readable", async t => {
  const { workspace, member, advance } = fixture(t), alice = await member(0), bob = await member(1);
  const input = { request: "message-123", body: "Hello" }, first = workspace.send(alice, "foundation", input);
  assert.deepEqual(workspace.send(alice, "foundation", input), first);
  assert.throws(() => workspace.send(alice, "foundation", { ...input, body: "Changed" }), /parameters changed/);
  assert.throws(() => workspace.send(alice, "foundation", { request: "second", body: "Fast" }), /Wait/);
  advance();
  for (const attachment of [{ name: "../secret", base64: "YQ==" }, { name: "bad", base64: "!!" }, { name: "empty", base64: "" },
    { name: "large", base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }]) {
    assert.throws(() => workspace.send(alice, "foundation", { request: "invalid-file", body: "", attachment }));
  }
  assert.equal(workspace.messages(bob, "foundation").length, 1);
  assert.equal(workspace.channels(bob).find(row => row.id === "foundation").unread, 1);
  workspace.read(bob, "foundation", first.id); workspace.read(bob, "foundation", 0);
  assert.equal(workspace.channels(bob).find(row => row.id === "foundation").unread, 0);
  assert.throws(() => workspace.read(bob, "foundation", 999), /Invalid/);
  assert.throws(() => workspace.messages(bob, "foundation", -1), /cursor/);
});
test("shared documents reject lost updates and remain scoped to their channel", async t => {
  const { workspace, member } = fixture(t), alice = await member(0), bob = await member(1), other = await member(2, "volunteer", "community");
  assert.equal(workspace.document(alice, "division-engineering").revision, 0);
  workspace.document(alice, "division-engineering", { body: "Plan", revision: 0 });
  assert.throws(() => workspace.document(bob, "division-engineering", { body: "Old draft", revision: 0 }), /changed/);
  assert.equal(workspace.document(bob, "division-engineering").body, "Plan");
  assert.throws(() => workspace.document(other, "division-engineering"), /unavailable/);
  assert.equal(workspace.document(bob, "division-engineering", { body: "Better plan", revision: 1 }).revision, 2);
});
test("missions enforce scoped leadership, evidence, optimistic revision and separate admin Silver approval", async t => {
  const { workspace, notes, member } = fixture(t);
  const lead = await member(0, "lead"), intern = await member(1, "intern"), other = await member(2, "manager", "community");
  const input = { title: "Ship mobile onboarding", body: "Acceptance: tested signup", division: "engineering", team: "engineering-general", assignee: intern, status: "ready" };
  assert.throws(() => workspace.saveMission(intern, input), /scoped manager/);
  assert.throws(() => workspace.saveMission(other, input), /scope/);
  let mission = workspace.saveMission(lead, input);
  assert.equal(workspace.missions(other).some(row => row.id === mission.id), false);
  assert.throws(() => workspace.saveMission(intern, { ...mission, status: "done" }, mission.id), /manager/);
  mission = workspace.saveMission(intern, { revision: mission.revision, status: "in_progress" }, mission.id);
  assert.throws(() => workspace.saveMission(intern, { revision: mission.revision - 1, status: "review", evidence: "Test passed" }, mission.id), /changed/);
  assert.throws(() => workspace.saveMission(intern, { revision: mission.revision, status: "review" }, mission.id), /evidence/);
  mission = workspace.saveMission(intern, { revision: mission.revision, status: "review", evidence: "Test passed" }, mission.id);
  mission = workspace.saveMission(lead, { ...mission, status: "done" }, mission.id);
  assert.equal(notes.balance(intern, "FTHS"), 0, "mission approval never silently creates salary");
  const grant = { address: intern, amount: 50, reason: "Reviewed onboarding", mission: mission.id, request: "grant-1", approval: "ISSUE 50 FTHS" };
  assert.throws(() => workspace.grant("admin", grant), /weekly payroll/);
  const independent = { ...grant, mission: null };
  assert.equal(workspace.grant("admin", independent).amount, 50);
  workspace.grant("admin", independent);
  assert.equal(notes.balance(intern, "FTHS"), 50);
  assert.throws(() => workspace.grant("admin", { ...independent, amount: 51, approval: "ISSUE 51 FTHS" }), /parameters changed/);
  assert.throws(() => workspace.grant("admin", { ...grant, request: "grant-3", approval: "yes" }), /exact/);
});
test("FTHS trades execute against conserved native balances and feed Exchange history, not a fictional salary price", async t => {
  const { workspace, notes, creation, member } = fixture(t), owner = await member(0);
  assert.throws(() => creation.markets.quote("FTHS", "buy", 100), /unfunded/);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1000000,'fixture',0,'test')").run(SYSTEM_TREASURY_ACCOUNT);
  creation.markets.fund("FTHS", "FUND FTHS 1000000 FTHX 1000000 NOTES");
  workspace.grant("admin", { address: owner, amount: 100, reason: "Approved work", request: "trade-grant", approval: "ISSUE 100 FTHS" });
  const before = workspace.silver().supply;
  const quote = creation.markets.quote("FTHS", "sell", 100);
  const result = creation.markets.trade(owner, { symbol: "FTHS", side: "sell", amount: 100, minOutput: quote.output, requestId: "silver-trade-0001" });
  assert.ok(result.output > 0);
  assert.equal(notes.balance(owner, "FTHS"), 0);
  assert.equal(notes.balance(owner), result.output);
  assert.equal(workspace.silver().supply, before);
  assert.equal(creation.markets.history("FTHS").candles.length, 1);
  assert.equal(creation.markets.account(owner).trades[0].symbol, "FTHS");
});
test("mission todos persist progress, preserve requirements and gate independent review without issuing rewards", async t => {
  const { workspace, notes, member, creation } = fixture(t);
  const lead = await member(0, "lead"), contributor = await member(1), outsider = await member(2, "manager", "community");
  const todos = [{ id: "mobile", label: "Verify mobile layout", done: false }, { id: "evidence", label: "Attach test evidence", done: false }];
  let mission = workspace.saveMission(lead, { title: "Mobile workspace", body: "Deliver reviewed mobile UX", division: "engineering",
    team: "engineering-general", assignee: contributor, status: "ready", todos });
  assert.deepEqual(mission.todos, todos);
  assert.deepEqual(workspace.missions(contributor).find(row => row.id === mission.id).todos, todos);
  assert.deepEqual(workspace.admin().missions.find(row => row.id === mission.id).todos, todos);
  const update = (status, values = {}) => ({ revision: mission.revision, status, ...values });
  assert.throws(() => workspace.saveMission(contributor, update("ready", { todos: [] }), mission.id), { status: 403 });
  assert.throws(() => workspace.saveMission(contributor, update("ready", { todos: [{ ...todos[0], label: "Skip verification" }, todos[1]] }), mission.id), { status: 403 });
  assert.throws(() => workspace.saveMission(outsider, { ...mission, status: "in_progress" }, mission.id), { status: 404 });
  mission = workspace.saveMission(contributor, update("ready", { todos: [{ ...todos[0], done: true }, todos[1]] }), mission.id);
  assert.equal(mission.status, "ready", "saving checkbox progress does not require a status transition");
  const reopened = new Workspace(notes, creation.markets);
  assert.equal(reopened.missions(contributor).find(row => row.id === mission.id).todos[0].done, true);
  assert.throws(() => workspace.saveMission(contributor, { revision: mission.revision - 1, status: "in_progress" }, mission.id), { status: 409 });
  mission = workspace.saveMission(contributor, update("in_progress"), mission.id);
  assert.throws(() => workspace.saveMission(contributor, update("review", { evidence: "Tests passed" }), mission.id), /every checklist/);
  assert.throws(() => workspace.saveMission(lead, { ...mission, status: "done", evidence: "Reviewed" }, mission.id), /every checklist/);
  assert.throws(() => workspace.saveMission(contributor, update("review", { todos: todos.map(todo => ({ ...todo, done: true })) }), mission.id), /evidence/);
  mission = workspace.saveMission(contributor, update("review", { evidence: "Test run and screenshots attached", todos: todos.map(todo => ({ ...todo, done: true })) }), mission.id);
  assert.throws(() => workspace.saveMission(contributor, update("done"), mission.id), { status: 403 });
  mission = workspace.saveMission(lead, { ...mission, status: "done" }, mission.id);
  assert.equal(mission.status, "done");
  assert.equal(notes.balance(contributor, "FTHS"), 0);
  assert.equal(workspace.hr.compensation(contributor).accomplished, 1);
});
test("mission checklist validation rejects malformed entries and self-managed requirement removal", async t => {
  const { workspace, member } = fixture(t);
  const lead = await member(0, "lead");
  const input = { title: "Verify", body: "Verify evidence", division: "engineering", team: "engineering-general", assignee: lead, status: "ready" };
  for (const todos of ["[]", [{ id: "a", label: "", done: false }], [{ id: "a", label: "Test", done: 1 }],
    [{ id: "a", label: "Test", done: false, extra: true }], Array.from({ length: 25 }, (_, i) => ({ id: String(i), label: "Test", done: false })),
    [{ id: "a", label: "Test", done: false }, { id: "a", label: "Duplicate", done: false }]]) {
    assert.throws(() => workspace.saveMission(lead, { ...input, todos }), { status: 400 });
  }
  const mission = workspace.saveMission(lead, { ...input, todos: [{ id: "a", label: "Test", done: false }] });
  assert.throws(() => workspace.saveMission(lead, { ...mission, todos: [] }, mission.id), { status: 403 });
});
test("mission checklist and revision survive reopening an isolated writable database", async t => {
  t.mock.method(require("../../operations/replica"), "readReplica", () => null);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-mission-todos-")), file = path.join(directory, "notes.sqlite");
  let notes;
  t.after(() => { notes?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  notes = new Notes(file);
  let creation = new Creation(notes, {}), workspace = new Workspace(notes, creation.markets,
    () => ({ username: "Checklist fixture", avatar: "https://example.test/avatar.png", bio: "Isolated test account." }));
  const owner = "0x" + "1".repeat(40);
  await workspace.apply(owner, { motivation: "Verify persistent checklist", experience: "building", interests: ["engineering"] });
  workspace.setMember("fixture", owner, { status: "active", role: "contributor", level: "learning", division: "engineering", team: "engineering-general" });
  let mission = workspace.saveMission("fixture", { title: "Persistent delivery", body: "Verify restart", division: "engineering",
    team: "engineering-general", assignee: owner, status: "ready", todos: [{ id: "restart", label: "Restart verification", done: false }] }, null, true);
  mission = workspace.saveMission(owner, { revision: mission.revision, status: "ready", todos: [{ id: "restart", label: "Restart verification", done: true }] }, mission.id);
  notes.close(); notes = new Notes(file); creation = new Creation(notes, {}); workspace = new Workspace(notes, creation.markets);
  const restored = workspace.missions(owner).find(row => row.id === mission.id);
  assert.deepEqual(restored.todos, mission.todos);
  assert.equal(restored.revision, mission.revision);
  assert.equal(notes.balance(owner, "FTHS"), 0);
});
test("call invitations and media signaling require both participants, consent and current channel access", async t => {
  const { workspace, member, advance } = fixture(t), alice = await member(0), bob = await member(1), other = await member(2);
  const call = workspace.startCall(alice, { channel: "foundation", callee: bob });
  assert.throws(() => workspace.signal(alice, call.id, { type: "offer", sdp: "test" }), /Accept/);
  assert.throws(() => workspace.signal(alice, call.id, { type: "accept" }), /invited/);
  assert.throws(() => workspace.signals(other, call.id, 0), /not found/);
  assert.throws(() => workspace.startCall(other, { channel: "foundation", callee: alice }), /already/);
  workspace.signal(bob, call.id, { type: "accept" });
  workspace.signal(alice, call.id, { type: "offer", sdp: "v=0" });
  workspace.signal(bob, call.id, { type: "candidate", candidate: { candidate: "candidate:1" } });
  assert.equal(workspace.signals(bob, call.id, 0).signals[0].body.type, "offer");
  assert.throws(() => workspace.signal(alice, call.id, { type: "offer", sdp: "x".repeat(32001) }), /Invalid/);
  workspace.signal(bob, call.id, { type: "end" });
  assert.equal(workspace.calls(alice).length, 0);
  const abandoned = workspace.startCall(alice, { channel: "foundation", callee: bob });
  advance(30000);
  workspace.signal(alice, abandoned.id, { type: "heartbeat" });
  advance(30001);
  assert.equal(workspace.calls(alice).length, 0);
  assert.equal(workspace.signals(alice, abandoned.id, 0).call.status, "ended");
});
test("membership, private attachments, revisions and approved Silver survive reopening the Notes database without duplicate issuance", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-workspace-")), file = path.join(directory, "notes.sqlite");
  let notes;
  t.after(() => { notes?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  notes = new Notes(file);
  let creation = new Creation(notes, {}), workspace = new Workspace(notes, creation.markets, () => ({ username: "PersistentInsider", avatar: "https://example.test/avatar.png", bio: "Building together." }));
  const owner = "0x" + "1".repeat(40);
  await workspace.apply(owner, { motivation: "Persistent work", experience: "building", interests: ["learning"] });
  workspace.setMember("admin", owner, { status: "active", role: "volunteer", level: "learning", division: "learning", team: "learning-general" });
  const message = workspace.send(owner, "foundation", { request: "persistent-file", body: "Archive", attachment: { name: "work.txt", base64: Buffer.from("private work").toString("base64") } });
  workspace.document(owner, "foundation", { body: "Versioned work", revision: 0 });
  const input = { address: owner, amount: 7, reason: "Approved work", approval: "ISSUE 7 FTHS", request: "persistent-grant" };
  workspace.grant("admin", input);
  notes.close(); notes = new Notes(file); creation = new Creation(notes, {}); workspace = new Workspace(notes, creation.markets);
  assert.equal(workspace.active(owner).role, "volunteer");
  assert.equal(workspace.document(owner, "foundation").revision, 1);
  assert.equal(Buffer.from(workspace.file(owner, message.file).bytes).toString(), "private work");
  assert.equal(workspace.grant("admin", input).amount, 7);
  assert.equal(workspace.silver().supply, 7);
  assert.equal(workspace.admin().grants.length, 1);
  assert.equal(workspace.messages(owner, "foundation").length, 1);
});
