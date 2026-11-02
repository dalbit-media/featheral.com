"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { FileJournals } = require("./journal");
const { createDomainApi } = require("./domain");
class SystemDatabase {
  constructor(root) {
    this.directory = path.join(root, "data", "system-database");
  }
  open() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const journals = new FileJournals(fs.realpathSync(this.directory));
    return createDomainApi({ journals, sites: () => [] }).database("system");
  }
  settings() {
    if (!fs.existsSync(this.directory)) return { deleted: true, revision: 0 };
    return this.open().get("settings", "runtime");
  }
  saveSettings(envelope, revision) {
    return this.open().transact({ requestId: crypto.randomUUID(), changes: [
      { collection: "settings", id: "runtime", op: "put", expectedRevision: revision, value: envelope },
    ] });
  }
}
module.exports = { SystemDatabase };
