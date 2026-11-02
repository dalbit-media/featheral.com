"use strict";
const { open } = require("../db-api/sqlite");
const crypto = require("node:crypto");
const error = (status, message) => Object.assign(new Error(message), { status });
const isNativeNote = symbol => symbol === "FTH$" || symbol === "FTHX" || symbol === "FTHS";
const effectiveProgram = program => ({ ...program, enabled: isNativeNote(program.symbol) ? 0 : program.enabled });

function initialize(db) {
  const symbolIndexExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes_currency_symbols'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes_entries (
      id INTEGER PRIMARY KEY, address TEXT NOT NULL, amount INTEGER NOT NULL, kind TEXT NOT NULL,
      post_id INTEGER, other TEXT, at INTEGER NOT NULL, site TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT 'FTHX',
      source_id INTEGER, UNIQUE(site,source_id));
    CREATE INDEX IF NOT EXISTS notes_address ON notes_entries(address,symbol);
    CREATE INDEX IF NOT EXISTS notes_symbol_id ON notes_entries(symbol,id DESC);
    CREATE TABLE IF NOT EXISTS notes_currency_symbols(symbol TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS notes_entries_symbol_insert AFTER INSERT ON notes_entries
      BEGIN INSERT OR IGNORE INTO notes_currency_symbols(symbol) VALUES (NEW.symbol); END;
    CREATE TABLE IF NOT EXISTS notes_migrations(site TEXT PRIMARY KEY, entries INTEGER NOT NULL, total INTEGER NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notes_programs(site TEXT PRIMARY KEY, symbol TEXT NOT NULL, chance INTEGER NOT NULL, amount INTEGER NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notes_reactions(site TEXT NOT NULL, post_id INTEGER NOT NULL, reactor TEXT NOT NULL, author TEXT NOT NULL,
      kind TEXT NOT NULL, roll INTEGER NOT NULL, paid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(site,post_id,reactor));
  `);
  if (!symbolIndexExists) db.exec("INSERT OR IGNORE INTO notes_currency_symbols(symbol) SELECT DISTINCT symbol FROM notes_entries");
}

function migrate(source, target, site) {
  const rows = source.prepare("SELECT * FROM qprn_ledger ORDER BY id").all();
  const digest = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const existing = target.prepare("SELECT * FROM notes_migrations WHERE site=?").get(site);
  if (existing) {
    if (existing.digest !== digest) throw error(409, "Legacy FTHX changed after migration. Stop old writers before continuing.");
    return;
  }
  target.exec("BEGIN IMMEDIATE");
  try {
    const insert = target.prepare("INSERT INTO notes_entries(address,amount,kind,post_id,other,at,site,source_id) VALUES (?,?,?,?,?,?,?,?)");
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.amount)) throw error(409, "Invalid legacy FTHX amount");
      total += row.amount;
      if (!Number.isSafeInteger(total)) throw error(409, "Legacy FTHX total exceeds safe limits");
      insert.run(row.address.toLowerCase(), row.amount, row.kind, row.post_id, row.other, row.at, site, row.id);
    }
    const actual = target.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM notes_entries WHERE site=? AND source_id IS NOT NULL").get(site);
    if (actual.n !== rows.length || actual.total !== total) throw error(409, "FTHX migration verification failed");
    for (const row of source.prepare("SELECT * FROM like_rewards").all()) {
      target.prepare("INSERT OR IGNORE INTO notes_reactions VALUES (?,?,?,?,?,0,0,?)")
        .run(site, row.post_id, row.voter.toLowerCase(), "", "legacy-like", row.at);
    }
    target.prepare("INSERT INTO notes_migrations VALUES (?,?,?,?,?)").run(site, rows.length, total, digest, Date.now());
    target.exec("COMMIT");
  } catch (err) { target.exec("ROLLBACK"); throw err; }
}

class Notes {
  constructor(file) {
    this.file = file;
    this.db = open(file);
    initialize(this.db);
  }
  program(site) {
    return effectiveProgram(this.db.prepare("SELECT site,symbol,chance,amount,enabled FROM notes_programs WHERE site=?").get(site)
      || { site, symbol: "FTHX", chance: 10, amount: 1, enabled: 0 });
  }
  setProgram(site, input) {
    this.validateProgram(input);
    const { symbol, chance, amount, enabled } = input || {};
    this.db.prepare("INSERT INTO notes_programs VALUES (?,?,?,?,?) ON CONFLICT(site) DO UPDATE SET symbol=excluded.symbol,chance=excluded.chance,amount=excluded.amount,enabled=excluded.enabled")
      .run(site, symbol, chance, amount, +enabled);
    return this.program(site);
  }
  validateProgram(input) {
    const { symbol, chance, amount, enabled } = input || {};
    if (typeof symbol !== "string" || (!/^[A-Z][A-Z0-9$]{1,15}$/.test(symbol) && !require("./markets").PLACEHOLDERS.includes(symbol))
      || !Number.isInteger(chance) || chance < 1 || chance > 99
      || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000 || typeof enabled !== "boolean")
      throw error(400, "Use a currency symbol, chance 1–99%, amount 1–1000 and boolean enabled");
    if (isNativeNote(symbol) && enabled) throw error(409, "FTH$, FTHX and FTHS are system-native notes and cannot be earned through regular rewards. Choose a community note.");
  }
  balance(address, symbol = "FTHX") {
    return this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM notes_entries WHERE address=? AND symbol=?").get(address.toLowerCase(), symbol).n;
  }
  validateBalances() {
    const balances = this.db.prepare("SELECT SUM(amount) AS amount FROM notes_entries GROUP BY address,symbol").all();
    if (balances.some(row => !Number.isSafeInteger(row.amount) || row.amount < 0))
      throw error(409, "Global Notes balances are invalid. Restore the original datasets before enabling Notes.");
  }
  summary() {
    const custom = this.db.prepare("SELECT DISTINCT symbol FROM notes_programs WHERE symbol NOT IN ('FTH$','FTHX')").all();
    const placeholders = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_markets'").get()
      ? this.db.prepare("SELECT symbol FROM note_markets WHERE placeholder=1").all() : [];
    const symbols = [...new Set([...custom, ...placeholders].map(row => row.symbol))];
    return {
      currencies: [{ symbol: "FTH$", kind: "reserve-backed-ledger", rewards: "system-native" }, { symbol: "FTHX", kind: "global-credit", rewards: "system-native" },
        ...symbols.map(symbol => ({ symbol, kind: "unbacked-credit", placeholder: placeholders.some(row => row.symbol === symbol) }))],
      dollarApi: "/api/v1/",
      migrations: this.db.prepare("SELECT * FROM notes_migrations ORDER BY site").all(),
      programs: this.db.prepare("SELECT * FROM notes_programs ORDER BY site").all().map(effectiveProgram),
      reactions: this.db.prepare("SELECT COUNT(*) AS attempts,COALESCE(SUM(paid),0) AS awarded FROM notes_reactions").get(),
    };
  }
  close() { this.db.close(); }
}
module.exports = { Notes, initialize, migrate, isNativeNote, effectiveProgram };
