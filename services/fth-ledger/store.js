"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonical } = require("./codec");

const YEAR_PATTERN = /^\d{4}$/;
const DAY_PATTERN = /^(\d{4})-\d{2}-\d{2}\.jsonl$/;
const RELATIVE_FILE_PATTERN = /^(\d{4})\/(\d{4}-\d{2}-\d{2})\.jsonl$/;

// Append-only block files: <dir>/<YYYY>/<YYYY-MM-DD>.jsonl, one minified JSON block per line, filed
// by the block's UTC timestamp. Closed days never change, so they can be copied, rsynced, pinned, or
// served from any CDN; replicas only ever need the newest file to catch up.
class BlockStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.manifestCache = new Map();
  }

  static fileFor(timestampMs) {
    const day = new Date(timestampMs).toISOString().slice(0, 10);
    return `${day.slice(0, 4)}/${day}.jsonl`;
  }

  absolute(relative) {
    const match = RELATIVE_FILE_PATTERN.exec(relative);
    if (!match || match[1] !== match[2].slice(0, 4)) throw Object.assign(new Error("Unknown ledger file."), { status: 404 });
    return path.join(this.directory, match[1], `${match[2]}.jsonl`);
  }

  files() {
    const result = [];
    for (const year of fs.readdirSync(this.directory).filter((name) => YEAR_PATTERN.test(name)).sort()) {
      const yearDir = path.join(this.directory, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const day of fs.readdirSync(yearDir).sort()) {
        const match = DAY_PATTERN.exec(day);
        if (match && match[1] === year) result.push(`${year}/${day}`);
      }
    }
    return result;
  }

  // A crash mid-append can leave a partial last line; drop it so the next append starts cleanly.
  repairTail() {
    const files = this.files();
    if (!files.length) return false;
    const file = this.absolute(files[files.length - 1]);
    const content = fs.readFileSync(file);
    if (!content.length || content[content.length - 1] === 0x0a) return false;
    const keep = content.lastIndexOf(0x0a) + 1;
    fs.truncateSync(file, keep);
    return true;
  }

  append(block) {
    const relative = BlockStore.fileFor(block.t);
    const file = this.absolute(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, "a");
    try {
      fs.writeSync(descriptor, canonical(block) + "\n");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return relative;
  }

  // Only newline-terminated lines are complete blocks; a trailing partial line is still being written.
  *readFile(relative) {
    const content = fs.readFileSync(this.absolute(relative), "utf8");
    const end = content.lastIndexOf("\n");
    if (end < 0) return;
    for (const line of content.slice(0, end).split("\n")) {
      if (line) yield JSON.parse(line);
    }
  }

  *blocks(startFile = "") {
    for (const relative of this.files()) {
      if (startFile && relative < startFile) continue;
      for (const block of this.readFile(relative)) yield { block, file: relative };
    }
  }

  readBlock(relative, height) {
    for (const block of this.readFile(relative)) if (block.h === height) return block;
    return null;
  }

  rawFile(relative) {
    return fs.readFileSync(this.absolute(relative));
  }

  manifest() {
    return this.files().map((relative) => {
      const file = this.absolute(relative);
      const stat = fs.statSync(file);
      const cached = this.manifestCache.get(relative);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.entry;
      const content = fs.readFileSync(file);
      let first = null;
      let last = null;
      let blocks = 0;
      let transactions = 0;
      for (const block of this.readFile(relative)) {
        if (first === null) first = block.h;
        last = block.h;
        blocks += 1;
        transactions += block.x.length;
      }
      const entry = {
        file: relative,
        bytes: stat.size,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        firstHeight: first,
        lastHeight: last,
        blocks,
        transactions,
      };
      this.manifestCache.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
      return entry;
    });
  }
}

module.exports = { BlockStore, RELATIVE_FILE_PATTERN };
