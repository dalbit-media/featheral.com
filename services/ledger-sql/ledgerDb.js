"use strict";

const { DatabaseSync } = require("node:sqlite");

const MAX_QUERY_LENGTH = 4000;
const MAX_ROWS = 500;
// Keeps the public console to plain reads; the connection is also switched to query_only while running.
const FORBIDDEN = /\b(recursive|randomblob|zeroblob|load_extension|pragma|attach|detach|vacuum)\b/i;

function sqlError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}

// A small embedded SQLite index (node:sqlite) over a hash-chained ledger. The block files stay the
// source of truth; this database is derived from them, rebuilt on start, and exposed read-only.
class LedgerDb {
  constructor({ schema, comments = {} }) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schema);
    this.comments = comments;
    this.tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    this.statements = new Map();
    this.closed = false;
  }

  prepared(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql, ...params) {
    return this.prepared(sql).run(...params);
  }

  all(sql, ...params) {
    return this.prepared(sql).all(...params).map((row) => ({ ...row }));
  }

  get(sql, ...params) {
    const row = this.prepared(sql).get(...params);
    return row ? { ...row } : null;
  }

  transaction(work) {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reset() {
    if (this.closed) return;
    for (const table of this.tables) this.db.exec(`DELETE FROM "${table}"`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // Runs one user-supplied SELECT. Reads are synchronous, so toggling query_only here cannot race writers.
  query(input, { maxRows = MAX_ROWS } = {}) {
    if (this.closed) throw sqlError("The ledger database is closed.", 503);
    const text = String(input ?? "").trim().replace(/;+\s*$/, "");
    if (!text) throw sqlError("Enter a SQL query.");
    if (text.length > MAX_QUERY_LENGTH) throw sqlError(`Queries are limited to ${MAX_QUERY_LENGTH} characters.`);
    if (!/^(select|with)\b/i.test(text)) throw sqlError("Only read-only SELECT queries are allowed.");
    if (text.includes(";")) throw sqlError("Only one statement is allowed.");
    const blocked = FORBIDDEN.exec(text);
    if (blocked) throw sqlError(`"${blocked[1].toLowerCase()}" is not allowed in the public SQL console.`);
    const started = process.hrtime.bigint();
    this.db.exec("PRAGMA query_only = 1");
    try {
      const statement = this.db.prepare(text);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      let truncated = false;
      for (const row of statement.iterate()) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(columns.map((name) => plain(row[name])));
      }
      return { columns, rows, rowCount: rows.length, truncated, maxRows, elapsedMs: Number((process.hrtime.bigint() - started) / 1000n) / 1000 };
    } catch (error) {
      if (error.status) throw error;
      throw sqlError(String(error.message || error).replace(/^SqliteError:\s*/, ""));
    } finally {
      this.db.exec("PRAGMA query_only = 0");
    }
  }

  schema() {
    return this.tables.map((name) => ({
      name,
      comment: this.comments[name] || "",
      rows: this.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n,
      columns: this.db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => ({ name: column.name, type: column.type, primaryKey: column.pk > 0 })),
    }));
  }
}

module.exports = { LedgerDb, MAX_ROWS, MAX_QUERY_LENGTH };
