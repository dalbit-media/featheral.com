"use strict";
const fs = require("node:fs");
const path = require("node:path");
function incrementBuild(file) {
  const lock = file + ".lock", temporary = file + ".tmp";
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    const source = fs.readFileSync(file, "utf8");
    const match = /^document\.getElementById\("admin-build-version"\)\.textContent = "v\.(\d+)";\r?\n?$/.exec(source);
    if (!match) throw new Error("Invalid Admin build version. Restore its version record before building.");
    const next = Number(match[1]) + 1;
    if (!Number.isSafeInteger(next) || next < 2) throw new Error("Admin build version is outside the supported range.");
    const version = `v.${String(next).padStart(2, "0")}`;
    fs.writeFileSync(temporary, `document.getElementById("admin-build-version").textContent = "${version}";\n`);
    fs.renameSync(temporary, file);
    return version;
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
if (require.main === module) {
  const file = path.resolve(__dirname, "..", "sites", "admin.featheral.com", "js", "build-version.js");
  console.log(`Admin app build ${incrementBuild(file)}`);
}
module.exports = { incrementBuild };
