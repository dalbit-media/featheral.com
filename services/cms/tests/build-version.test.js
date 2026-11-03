"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { incrementBuild } = require("../../../scripts/build-admin-version");
const root = path.resolve(__dirname, "..", "..", "..");
function fixture(t, version = "01") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-build-version-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "build-version.js");
  fs.writeFileSync(file, `document.getElementById("admin-build-version").textContent = "v.${version}";\n`);
  return file;
}
test("Admin build numbers advance from v.01 with padding, survive reopen and render the generated version", t => {
  const file = fixture(t);
  assert.equal(incrementBuild(file), "v.02");
  assert.equal(incrementBuild(file), "v.03");
  const element = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { document: { getElementById: id => {
    assert.equal(id, "admin-build-version"); return element;
  } } });
  assert.equal(element.textContent, "v.03");
  const rollover = fixture(t, "99");
  assert.equal(incrementBuild(rollover), "v.100");
});
test("invalid or concurrently locked version records fail without changing the existing version", t => {
  const file = fixture(t);
  fs.writeFileSync(file + ".lock", "");
  assert.throws(() => incrementBuild(file), { code: "EEXIST" });
  assert.match(fs.readFileSync(file, "utf8"), /v\.01/);
  fs.unlinkSync(file + ".lock");
  fs.writeFileSync(file, "invalid");
  assert.throws(() => incrementBuild(file), /Invalid Admin build version/);
  assert.equal(fs.readFileSync(file, "utf8"), "invalid");
  assert.equal(fs.existsSync(file + ".lock"), false);
  assert.equal(fs.existsSync(file + ".tmp"), false);
});
test("the version is in the persistent Admin shell and advances only after a successful app build", () => {
  const manifest = require("../../../package.json");
  assert.equal(manifest.scripts.build, "npm run build:world");
  assert.equal(manifest.scripts["postbuild:world"], "node scripts/build-admin-version.js");
  const html = fs.readFileSync(path.join(root, "sites", "admin.featheral.com", "index.html"), "utf8");
  assert.match(html, /<section id="view"><\/section>\s*<footer id="admin-build-version"/);
  assert.match(html, /src="\/js\/build-version\.js"/);
});
