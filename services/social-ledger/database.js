"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_ROWS = 500;
const MAX_QUERY_LENGTH = 4000;
const FORBIDDEN = /\b(recursive|randomblob|zeroblob|load_extension|pragma|attach|detach|vacuum)\b/i;

// All connections are owned by the injected services/db-api/sqlite manager.
class FeedDatabase {
  constructor({ sqlite, file, schema, comments }) {
    if (!sqlite || typeof sqlite.open !== "function") throw new Error("World Feed Database requires an injected managed sqlite opener.");
    if (!file || file === ":memory:") throw new Error("World Feed Database requires a durable database file.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = sqlite.open(file);
    this.comments = comments;
    this.closed = false;
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
      this.transaction(() => this.db.exec(schema));
    } catch (error) {
      this.close();
      throw error;
    }
    this.tables = Object.keys(comments);
  }

  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params).map((row) => ({ ...row })); }
  get(sql, ...params) {
    const row = this.db.prepare(sql).get(...params);
    return row ? { ...row } : null;
  }

  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  query(input) {
    if (this.closed) throw Object.assign(new Error("The feed database is closed."), { status: 503 });
    const text = String(input ?? "").trim().replace(/;+\s*$/, "");
    if (!text || text.length > MAX_QUERY_LENGTH || !/^(select|with)\b/i.test(text) || text.includes(";") || FORBIDDEN.test(text)) {
      throw new Error(`Only one read-only SELECT query of at most ${MAX_QUERY_LENGTH} characters is allowed; unsafe SQL functions and recursive queries are forbidden.`);
    }
    const started = process.hrtime.bigint();
    this.db.exec("PRAGMA query_only = 1");
    try {
      const statement = this.db.prepare(text);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      let truncated = false;
      for (const row of statement.iterate()) {
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(columns.map((name) => {
          const value = row[name];
          return typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? `0x${Buffer.from(value).toString("hex")}` : value;
        }));
      }
      return { columns, rows, rowCount: rows.length, truncated, maxRows: MAX_ROWS, elapsedMs: Number((process.hrtime.bigint() - started) / 1000n) / 1000 };
    } finally {
      this.db.exec("PRAGMA query_only = 0");
    }
  }

  schema() {
    return this.tables.map((name) => ({
      name, comment: this.comments[name],
      rows: this.get(`SELECT count(*) AS n FROM "${name}"`).n,
      columns: this.all(`PRAGMA table_info("${name}")`).map((column) => ({ name: column.name, type: column.type, primaryKey: column.pk > 0 })),
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

module.exports = { FeedDatabase };
