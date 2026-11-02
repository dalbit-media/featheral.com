"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { FileJournals, TOKENS } = require("../journal");
const { spawnSync } = require("node:child_process");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { at: Date.parse("2026-12-31T23:59:59Z") };
  return { directory, clock, store: new FileJournals(directory, { now: () => clock.at }) };
}
const change = (key = "wallet:a", value = { balance: "12345678901234567890" }, expectedRevision = 0) => ({ op: "put", key, value, expectedRevision });
test("token journals use explicit symbols, year/day directories and survive restart", t => {
  const f = fixture(t);
  for (const token of Object.values(TOKENS)) {
    const stream = `tokens/${token}`;
    f.store.transact(stream, { requestId: "initial-write", changes: [change()] });
    assert.ok(fs.existsSync(path.join(f.directory, "tokens", token, "2026", "2026-12-31", "0000000000000001.json")));
    assert.equal(new FileJournals(f.directory).get(stream, "wallet:a").value.balance, "12345678901234567890");
  }
});
test("one transaction atomically changes multiple documents; revisions reject stale writes without partial effects", t => {
  const { store } = fixture(t), name = "sites/app.featheral.com";
  store.transact(name, { requestId: "initial-write", changes: [change("alice", 9), change("bob", 1)] });
  assert.throws(() => store.transact(name, { requestId: "conflict-write", changes: [change("alice", 8, 1), change("bob", 2, 0)] }), { status: 409 });
  assert.equal(store.get(name, "alice").value, 9);
  assert.equal(store.summary(name).sequence, 1);
  store.transact(name, { requestId: "transfer-write", changes: [change("alice", 8, 1), change("bob", 2, 1)] });
  assert.equal(store.get(name, "alice").value + store.get(name, "bob").value, 10);
});
test("retries are immutable and idempotent, including after a restart", t => {
  const f = fixture(t), stream = "tokens/fths", request = { requestId: "immutable-request", changes: [change()] };
  const first = f.store.transact(stream, request);
  const retry = new FileJournals(f.directory).transact(stream, request);
  assert.equal(retry.hash, first.hash); assert.equal(retry.duplicate, true);
  assert.throws(() => f.store.transact(stream, { ...request, changes: [change("wallet:a", "different")] }), { status: 409 });
  assert.equal(f.store.summary(stream).sequence, 1);
});
test("UTC rollover maintains a single sequence and backward clocks are rejected", t => {
  const f = fixture(t), name = "tokens/fth-dollar";
  f.store.transact(name, { requestId: "first-request", changes: [change()] });
  f.clock.at += 2000;
  f.store.transact(name, { requestId: "second-request", changes: [change("wallet:b")] });
  const files = f.store.files(name);
  assert.deepEqual(files.map(item => item.day), ["2026-12-31", "2027-01-01"]);
  f.clock.at -= 10000;
  assert.throws(() => f.store.transact(name, { requestId: "backward-time", changes: [change("wallet:c")] }), { status: 503 });
  assert.equal(f.store.summary(name).sequence, 2);
});
test("deletions retain revisions and prevent resurrection with an old revision", t => {
  const { store } = fixture(t), name = "sites/app.featheral.com";
  store.transact(name, { requestId: "create-request", changes: [change("profile")] });
  store.transact(name, { requestId: "delete-request", changes: [{ key: "profile", expectedRevision: 1, op: "delete" }] });
  assert.deepEqual(store.get(name, "profile"), { revision: 2, deleted: true });
  assert.throws(() => store.transact(name, { requestId: "stale-request", changes: [change("profile")] }), { status: 409 });
  store.transact(name, { requestId: "restore-request", changes: [change("profile", "restored", 2)] });
  assert.equal(store.get(name, "profile").revision, 3);
});
test("integrity failures stop reads and writes without attempting repair", t => {
  const { store } = fixture(t), name = "tokens/fths";
  store.transact(name, { requestId: "initial-write", changes: [change()] });
  const file = store.files(name)[0].file;
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("12345678901234567890", "99999999901234567890"));
  assert.throws(() => store.summary(name), { status: 503 });
  assert.throws(() => store.transact(name, { requestId: "next-request", changes: [change("b")] }), { status: 503 });
  assert.equal(store.files(name).length, 1);
});
test("a missing or duplicated middle record cannot be silently replayed", t => {
  const { store } = fixture(t), name = "tokens/fthg";
  for (let i = 0; i < 3; i++) store.transact(name, { requestId: `request-${i}`, changes: [change(`wallet:${i}`)] });
  fs.unlinkSync(store.files(name)[1].file);
  assert.throws(() => store.summary(name), { status: 503 });
});
test("interrupted pending files are not committed; writer locks fail closed", t => {
  const { store, directory } = fixture(t), name = "tokens/fths";
  store.transact(name, { requestId: "initial-write", changes: [change()] });
  fs.writeFileSync(path.join(path.dirname(store.files(name)[0].file), ".pending-dead-beef"), "{");
  assert.equal(store.summary(name).sequence, 1);
  fs.writeFileSync(path.join(directory, "tokens", "fths", ".writer.lock"), '{"pid":999999}');
  assert.throws(() => store.transact(name, { requestId: "blocked-write", changes: [change("b")] }), { status: 409 });
  assert.equal(store.summary(name).sequence, 1);
});
test("namespace traversal, unsupported values, duplicate keys and fractional numbers are rejected", t => {
  const { store } = fixture(t);
  for (const name of ["../outside", "tokens/FTH$", "sites/../vault", "internal/other", "sites/a..b"])
    assert.throws(() => store.summary(name), { status: 400 });
  for (const changes of [[], [change("a", 0.1)], [{ ...change("a"), value: undefined }], [change("a", 1n)], [change("a"), change("a")], [change("a", NaN)]])
    assert.throws(() => store.transact("tokens/fths", { requestId: "bad-request", changes }), { status: 400 });
  assert.equal(store.summary("tokens/fths").sequence, 0);
});
test("metadata queries are bounded and never include document values", t => {
  const { store } = fixture(t), name = "sites/app.featheral.com";
  for (let i = 0; i < 55; i++) store.transact(name, { requestId: `request-${i}`, changes: [change(`message:${i}`, "private message")] });
  const records = store.records(name);
  assert.equal(records.length, 50); assert.equal(records[0].sequence, 55);
  assert.equal(store.records(name, 6)[0].sequence, 5);
  assert.ok(!JSON.stringify(records).includes("private message"));
});
test("oversized transactions fail before publication", t => {
  const { store } = fixture(t);
  assert.throws(() => store.transact("tokens/fths", { requestId: "large-request", changes: [change("a", "x".repeat(1024 * 1024))] }), { status: 413 });
  assert.equal(store.summary("tokens/fths").sequence, 0);
});
test("real writer-process interruption before or after publication never creates a partial transaction", t => {
  for (const published of [false, true]) {
    const { store, directory, clock } = fixture(t), name = "tokens/fths";
    store.transact(name, { requestId: "initial-write", changes: [change("alice", 9), change("bob", 1)] });
    const request = { requestId: "crash-request", changes: [change("alice", 8, 1), change("bob", 2, 1)] };
    const script = `
      const fs=require("node:fs");
      const {FileJournals}=require(${JSON.stringify(path.resolve(__dirname, "..", "journal.js"))});
      const original=fs.${published ? "unlinkSync" : "linkSync"};
      fs.${published ? "unlinkSync" : "linkSync"}=function(file,...args) {
        ${published ? 'if (file.includes(".pending-")) process.exit(87); return original.call(this,file,...args);' : "process.exit(86);"}
      };
      new FileJournals(${JSON.stringify(directory)},{now:()=>${clock.at}}).transact(${JSON.stringify(name)},${JSON.stringify(request)});
    `;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(child.status, published ? 87 : 86, child.stderr);
    assert.equal(store.summary(name).sequence, published ? 2 : 1);
    assert.equal(store.get(name, "alice").value, published ? 8 : 9);
    assert.equal(store.get(name, "bob").value, published ? 2 : 1);
    assert.throws(() => store.transact(name, request), { status: 409 });
    fs.unlinkSync(path.join(directory, "tokens", "fths", ".writer.lock"));
    assert.equal(store.transact(name, request).duplicate, published);
    assert.equal(store.summary(name).sequence, 2);
  }
});
