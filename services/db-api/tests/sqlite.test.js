"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("../sqlite");

test("the DB API owns SQLite connection creation and lifecycle", () => {
  const before = sqlite.activeConnections;
  const db = sqlite.open(":memory:");
  assert.equal(sqlite.activeConnections, before + 1);
  db.exec("CREATE TABLE values_store (value TEXT NOT NULL)");
  db.prepare("INSERT INTO values_store VALUES (?)").run("native");
  assert.equal(db.prepare("SELECT value FROM values_store").get().value, "native");
  db.close();
  db.close();
  assert.equal(sqlite.activeConnections, before);
});

test("the DB API supports native readonly database handles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-db-api-"));
  const file = path.join(directory, "readonly.sqlite");
  try {
    const db = sqlite.open(file);
    try { db.exec("CREATE TABLE readonly_test (value INTEGER)"); }
    finally { db.close(); }
    const readOnly = sqlite.open(file, { readOnly: true });
    try { assert.throws(() => readOnly.exec("CREATE TABLE forbidden (value INTEGER)")); }
    finally { readOnly.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
