"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileJournals } = require("../journal");
const { createDomainApi } = require("../domain");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-domain-db-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journals = new FileJournals(directory);
  const domain = createDomainApi({ journals, sites: () => ["app.featheral.com"] });
  return { domain, journals };
}

test("domain stores scope site and token data and preserve document revisions", t => {
  const { domain } = fixture(t);
  const site = domain.site("app.featheral.com");
  site.transact({ requestId: "create-profile", changes: [
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0, value: { balance: "12" } },
  ] });

  assert.deepEqual(site.get("profiles", "alice"), { revision: 1, deleted: false, value: { balance: "12" } });
  assert.deepEqual(domain.token("FTHG").get("profiles", "alice"), { revision: 0, deleted: true });
  assert.deepEqual(site.get("profiles", "missing"), { revision: 0, deleted: true });
});

test("named database stores isolate data and support atomic cross-collection writes", t => {
  const { domain, journals } = fixture(t);
  const cms = domain.database("cms");
  cms.transact({ requestId: "create-site-settings", changes: [
    { collection: "sites", id: "app.featheral.com", op: "put", expectedRevision: 0, value: { enabled: true } },
    { collection: "settings", id: "theme", op: "put", expectedRevision: 0, value: "dark" },
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0, value: { x: 1.25, y: -2.5 } },
  ] });

  assert.equal(cms.get("sites", "app.featheral.com").value.enabled, true);
  assert.deepEqual(cms.get("profiles", "alice").value, { x: 1.25, y: -2.5 });
  assert.equal(domain.database("notes").get("settings", "theme").deleted, true);
  assert.equal(journals.summary("databases/cms").sequence, 1);
});

test("domain transactions are atomic, optimistic, and idempotent", t => {
  const { domain } = fixture(t);
  const site = domain.site("app.featheral.com");
  const initial = { requestId: "initial-documents", changes: [
    { collection: "balances", id: "alice", op: "put", expectedRevision: 0, value: 9 },
    { collection: "balances", id: "bob", op: "put", expectedRevision: 0, value: 1 },
  ] };
  const first = site.transact(initial);
  assert.equal(site.transact(initial).duplicate, true);

  assert.throws(() => site.transact({ requestId: "stale-transfer", changes: [
    { collection: "balances", id: "alice", op: "put", expectedRevision: 1, value: 8 },
    { collection: "balances", id: "bob", op: "put", expectedRevision: 0, value: 2 },
  ] }), error => error.status === 409);
  assert.deepEqual(site.get("balances", "alice").value, 9);
  assert.deepEqual(site.get("balances", "bob").value, 1);
  assert.equal(site.transact(initial).sequence, first.sequence);
});

test("collection listing is bounded, ordered, cursor-based, and omits deleted documents", t => {
  const { domain } = fixture(t);
  const site = domain.site("app.featheral.com");
  site.transact({ requestId: "create-items", changes: ["a", "b", "c"].map(id => ({
    collection: "items", id, op: "put", expectedRevision: 0, value: { id },
  })) });
  site.transact({ requestId: "delete-item", changes: [
    { collection: "items", id: "b", op: "delete", expectedRevision: 1 },
  ] });

  const first = site.list("items", { limit: 1 });
  assert.deepEqual(first, { documents: [{ id: "a", revision: 1, value: { id: "a" } }], nextCursor: "a" });
  assert.deepEqual(site.list("items", { after: first.nextCursor }), {
    documents: [{ id: "c", revision: 1, value: { id: "c" } }],
    nextCursor: null,
  });
  assert.deepEqual(site.list("other"), { documents: [], nextCursor: null });
});

test("domain boundaries and invalid document operations fail explicitly", t => {
  const { domain } = fixture(t);
  assert.throws(() => domain.site("other.featheral.com"), error => error.status === 404);
  assert.throws(() => domain.token("UNKNOWN"), error => error.status === 404);
  assert.throws(() => domain.database("bad/name"), error => error.status === 400);
  assert.throws(() => domain.site("app.featheral.com").get("bad collection", "id"), error => error.status === 400);
  assert.throws(() => domain.site("app.featheral.com").list("profiles", { limit: 101 }), error => error.status === 400);
  assert.throws(() => domain.site("app.featheral.com").transact({ requestId: "invalid-change", changes: [
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0 },
  ] }), error => error.status === 400);
  assert.throws(() => domain.site("app.featheral.com").transact({ requestId: "duplicate-change", changes: [
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0, value: 1 },
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0, value: 2 },
  ] }), error => error.status === 400);
  const sparse = [];
  sparse[1] = "value";
  assert.throws(() => domain.site("app.featheral.com").transact({ requestId: "sparse-value", changes: [
    { collection: "profiles", id: "alice", op: "put", expectedRevision: 0, value: sparse },
  ] }), error => error.status === 400);
});
