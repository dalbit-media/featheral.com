"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { canonical, sha256, ZERO_HASH } = require("../fth-ledger/codec");
const fail = (status, message) => Object.assign(new Error(message), { status });
const TOKENS = Object.freeze({ FTHG: "fthg", "FTH$": "fth-dollar", FTHX: "fthx", FTHS: "fths" });
const MAX_BYTES = 1024 * 1024;
function syncDirectory(directory) {
  // Node cannot open directory handles for fsync on Windows; files themselves are always flushed.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function namespace(value) {
  if (typeof value !== "string" || !/^(?:tokens\/(?:fthg|fth-dollar|fthx|fths)|sites\/[a-z0-9][a-z0-9.-]{0,199}|databases\/[a-z0-9][a-z0-9.-]{0,99}|internal\/vault)$/.test(value)
    || value.includes("..") || value.endsWith(".")) throw fail(400, "Invalid ledger namespace.");
  return value;
}
function jsonValue(value, integersOnly) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && (!integersOnly || Number.isSafeInteger(value))) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw fail(400, "Sparse arrays are not valid JSON values.");
      jsonValue(value[index], integersOnly);
    }
    return;
  }
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw fail(400, "Invalid document key.");
      jsonValue(child, integersOnly);
    }
    return;
  }
  throw fail(400, "Values must be JSON; token ledgers require safe integers or decimal strings for amounts.");
}
function canonicalDocuments(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDocuments).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalDocuments(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function canonicalRecord(value, integersOnly) {
  return integersOnly ? canonical(value) : canonicalDocuments(value);
}
function validateChanges(changes, integersOnly = false) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw fail(400, "A transaction needs 1–100 document changes.");
  const keys = new Set();
  for (const change of changes) {
    if (!change || typeof change.key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_$@./-]{0,199}$/.test(change.key) || keys.has(change.key)
      || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0
      || !["put", "delete"].includes(change.op)) throw fail(400, "Invalid or duplicate document change.");
    if (change.op === "put") jsonValue(change.value, integersOnly);
    if (change.op === "delete" && Object.hasOwn(change, "value")) throw fail(400, "Deleted documents cannot contain a value.");
    if (Object.keys(change).some(key => !["key", "expectedRevision", "op", "value"].includes(key))) throw fail(400, "Unknown document change field.");
    keys.add(change.key);
  }
}
class FileJournals {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.directory).toLowerCase() !== this.directory.toLowerCase()) throw fail(503, "Ledger root cannot contain symbolic links.");
  }
  safe(file) {
    const relative = path.relative(this.directory, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail(400, "Path is outside the ledger root.");
    let current = this.directory;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw fail(503, "Ledger paths cannot contain symbolic links.");
    }
    return file;
  }
  files(name) {
    const directory = this.safe(path.join(this.directory, ...namespace(name).split("/")));
    if (!fs.existsSync(directory)) return [];
    const files = [];
    for (const year of fs.readdirSync(directory)) {
      if (year === ".writer.lock") continue;
      if (!/^\d{4}$/.test(year)) throw fail(503, "Unexpected ledger directory entry.");
      const yearPath = this.safe(path.join(directory, year));
      for (const day of fs.readdirSync(yearPath)) {
        if (!new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(day) || new Date(day).toISOString().slice(0, 10) !== day)
          throw fail(503, "Invalid ledger day directory.");
        const dayPath = this.safe(path.join(yearPath, day));
        for (const file of fs.readdirSync(dayPath)) {
          if (/^\.pending-[0-9a-f-]+$/.test(file)) continue;
          if (!/^\d{16}\.json$/.test(file)) throw fail(503, "Unexpected ledger record file.");
          files.push({ file: this.safe(path.join(dayPath, file)), day, sequence: Number(file.slice(0, 16)) });
        }
      }
    }
    return files.sort((a, b) => a.sequence - b.sequence);
  }
  replay(name) {
    namespace(name);
    const documents = new Map(), requests = new Map(), records = [];
    let hash = ZERO_HASH, sequence = 0, lastAt = 0;
    for (const entry of this.files(name)) {
      if (entry.sequence !== sequence + 1 || fs.statSync(entry.file).size > MAX_BYTES) throw fail(503, "Ledger sequence or record size is invalid.");
      let record;
      try { record = JSON.parse(fs.readFileSync(entry.file, "utf8")); }
      catch { throw fail(503, "Ledger record is unreadable. No automatic repair was attempted."); }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw fail(503, "Ledger record has an invalid shape.");
      const { hash: digest, ...body } = record;
      if (record.version !== 1 || record.namespace !== name || record.sequence !== sequence + 1
        || record.previous !== hash || !Number.isSafeInteger(record.at) || record.at < lastAt
        || new Date(record.at).toISOString().slice(0, 10) !== entry.day
        || typeof record.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(record.requestId)
        || requests.has(record.requestId) || sha256(canonicalRecord(body, name.startsWith("tokens/"))) !== digest) throw fail(503, "Ledger integrity verification failed.");
      try { validateChanges(record.changes, name.startsWith("tokens/")); } catch { throw fail(503, "Ledger changes are invalid."); }
      for (const change of record.changes) {
        const revision = documents.get(change.key)?.revision || 0;
        if (revision !== change.expectedRevision) throw fail(503, "Ledger revision chain is invalid.");
        documents.set(change.key, { revision: revision + 1, deleted: change.op === "delete", ...(change.op === "put" ? { value: change.value } : {}) });
      }
      hash = digest; sequence++; lastAt = record.at;
      requests.set(record.requestId, record); records.push(record);
    }
    return { documents, requests, records, hash, sequence, lastAt };
  }
  get(name, key) {
    const entry = this.replay(name).documents.get(key);
    return entry ? structuredClone(entry) : { revision: 0, deleted: true };
  }
  transact(name, { requestId, changes }) {
    namespace(name); validateChanges(changes, name.startsWith("tokens/"));
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw fail(400, "A unique transaction request ID is required.");
    const directory = this.safe(path.join(this.directory, ...name.split("/")));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, ".writer.lock");
    let descriptor;
    try { descriptor = fs.openSync(lock, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw fail(409, "Ledger writer is busy or was interrupted. Inspect the writer lock before retrying."); throw error; }
    let temporary;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: this.now() })); fs.fsyncSync(descriptor);
      const state = this.replay(name);
      const existing = state.requests.get(requestId);
      if (existing) {
        if (canonicalRecord(existing.changes, name.startsWith("tokens/")) !== canonicalRecord(changes, name.startsWith("tokens/")))
          throw fail(409, "Transaction request ID conflicts with an existing transaction.");
        return { sequence: existing.sequence, hash: existing.hash, duplicate: true };
      }
      for (const change of changes) if ((state.documents.get(change.key)?.revision || 0) !== change.expectedRevision)
        throw fail(409, "Document changed. Reload its current revision before retrying.");
      const at = this.now();
      if (!Number.isSafeInteger(at) || at < state.lastAt) throw fail(503, "Ledger clock moved backward. No transaction was written.");
      const body = { version: 1, namespace: name, sequence: state.sequence + 1, previous: state.hash, at, requestId, changes };
      const record = { ...body, hash: sha256(canonicalRecord(body, name.startsWith("tokens/"))) };
      const bytes = canonicalRecord(record, name.startsWith("tokens/")) + "\n";
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail(413, "Ledger transaction exceeds 1 MiB.");
      const day = new Date(at).toISOString().slice(0, 10);
      const target = this.safe(path.join(directory, day.slice(0, 4), day));
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      syncDirectory(this.directory);
      syncDirectory(path.dirname(directory));
      syncDirectory(directory);
      syncDirectory(path.dirname(target));
      temporary = path.join(target, ".pending-" + crypto.randomUUID());
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // An exclusive hard-link publishes the complete, flushed record without replacing an existing sequence.
      fs.linkSync(temporary, path.join(target, String(body.sequence).padStart(16, "0") + ".json"));
      syncDirectory(target);
      fs.unlinkSync(temporary); temporary = null;
      return { sequence: record.sequence, hash: record.hash, duplicate: false };
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      fs.closeSync(descriptor); fs.unlinkSync(lock);
    }
  }
  summary(name) {
    const state = this.replay(name);
    return { namespace: name, sequence: state.sequence, hash: state.hash, documents: [...state.documents.values()].filter(row => !row.deleted).length,
      lastAt: state.lastAt || null };
  }
  records(name, before = Number.MAX_SAFE_INTEGER) {
    return this.replay(name).records.filter(record => record.sequence < before).slice(-50).reverse().map(record =>
      ({ sequence: record.sequence, hash: record.hash, previous: record.previous, at: record.at, changes: record.changes.length }));
  }
}
module.exports = { FileJournals, TOKENS, namespace, fail };
