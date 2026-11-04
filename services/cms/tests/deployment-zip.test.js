"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { ZipFile } = require("yazl");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const { prepareRelease, fileHash } = require("../lib/deployment");
const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/deploy-release.sh"), "utf8").replace(/\r\n/g, "\n");
const extraction = script.slice(script.indexOf("step=extract\n"), script.indexOf("node -e 'const fs=require(\"node:fs\");fs.writeFileSync"));
test("self-sync reuses installed HTTPS without an outbound email; upload deployment still registers certificates", () => {
  const header = script.slice(0, script.indexOf('sudo_password=""'));
  const https = script.slice(script.indexOf("certificate_args=()"), script.indexOf("as_root install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy"));
  const run = (mode, email) => spawnSync(process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash",
    ["-c", `${header}\nas_root(){ printf 'ROOT:%s\\n' "$*"; }\nphase(){ :; }\n${https}`, "installer",
      "/opt/featheral", "release-1-aaaaaaaaaaaa", email, "admin.featheral.com", "32", "120", "true", "", "", mode],
    { encoding: "utf8", timeout: 10000 });
  const self = run("self", "");
  assert.equal(self.status, 0, self.stdout + self.stderr);
  assert.match(self.stdout, /Preserving installed HTTPS certificates/);
  assert.doesNotMatch(self.stdout, /ROOT:certbot/);
  assert.notEqual(run("upload", "").status, 0);
  const upload = run("upload", "fixture@example.test");
  assert.equal(upload.status, 0, upload.stdout + upload.stderr);
  assert.match(upload.stdout, /ROOT:certbot --nginx .*--email fixture@example.test/);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-zip-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"), prepared = path.join(directory, "prepared");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "sites"), { recursive: true });
  fs.mkdirSync(prepared);
  fs.writeFileSync(path.join(source, "scripts", "deploy-release.sh"), "#!/bin/bash\r\nset -eu\r\n");
  fs.writeFileSync(path.join(source, "sites", "index.html"), "<p>published code</p>\n".repeat(10000));
  return { directory, source, prepared };
}
function extract(directory, archive, hash) {
  return spawnSync(process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash", ["-c",
    `set -Eeuo pipefail\nphase(){ :; }\nshared="$FIXTURE_DIR"\nrelease="$FIXTURE_DIR/extracted"\narchive="$FIXTURE_ARCHIVE"\narchive_hash="$FIXTURE_HASH"\nmkdir -p "$release"\n${extraction}`],
  { encoding: "utf8", timeout: 10000, env: { ...process.env, FIXTURE_DIR: directory.replace(/\\/g, "/"),
    FIXTURE_ARCHIVE: archive.replace(/\\/g, "/"), FIXTURE_HASH: hash } });
}
async function zipEntries(file, entries) {
  const zip = new ZipFile(), output = pipeline(zip.outputStream, fs.createWriteStream(file));
  for (const [name, content, options] of entries) zip.addBuffer(Buffer.from(content), name, options);
  zip.end(); await output;
}
test("deployment creates a compressed reproducible ZIP and verifies extracted source and metadata", async t => {
  const f = fixture(t), files = ["scripts/deploy-release.sh", "sites/index.html"];
  const archive = await prepareRelease(f.source, files, '{"integrated":[],"managed":[]}', f.prepared);
  assert(archive.bytes < archive.expandedBytes / 2);
  assert.equal(archive.hash, await fileHash(archive.file));
  const other = path.join(f.directory, "other"); fs.mkdirSync(other);
  const second = await prepareRelease(f.source, files, '{"integrated":[],"managed":[]}', other);
  assert.equal(second.hash, archive.hash, "unchanged reviews reuse the same resumable archive digest");
  const result = extract(f.directory, archive.file, archive.hash);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const release = path.join(f.directory, "extracted");
  assert.equal(fs.readFileSync(path.join(release, "scripts", "deploy-release.sh"), "utf8"), "#!/bin/bash\nset -eu\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(release, ".deployment-files.json")));
  assert.equal(manifest.length, files.length + 2);
  assert.equal(fs.existsSync(path.join(release, "data")), false);
  assert.equal(fs.existsSync(path.join(release, ".git")), false);
});
test("ZIP digest mismatch and existing release contents fail before extracting", async t => {
  const f = fixture(t), archive = await prepareRelease(f.source, ["scripts/deploy-release.sh"], "{}", f.prepared);
  assert.notEqual(extract(f.directory, archive.file, "0".repeat(64)).status, 0);
  const sentinel = path.join(f.directory, "extracted", "keep.txt");
  fs.writeFileSync(sentinel, "preserve");
  assert.notEqual(extract(f.directory, archive.file, archive.hash).status, 0);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
});
for (const kind of ["traversal", "duplicate", "symlink", "unreviewed"]) test(`ZIP extraction rejects ${kind} entries`, async t => {
  const f = fixture(t), file = path.join(f.directory, "release.zip");
  const entries = [[".deployment-files.json", JSON.stringify([{ name: "expected.txt", bytes: 0,
    hash: crypto.createHash("sha256").update("").digest("hex") }])], ["expected.txt", ""]];
  if (kind === "symlink") entries.push(["safe.txt", "../../outside", { mode: 0o120777 }]);
  else entries.push(["safe.txt", "unexpected"]);
  if (kind === "duplicate") entries.push(["safe.txt", "duplicate"]);
  await zipEntries(file, entries);
  if (kind === "traversal") {
    const bytes = fs.readFileSync(file);
    for (let offset = bytes.indexOf("safe.txt"); offset !== -1; offset = bytes.indexOf("safe.txt", offset + 8))
      bytes.write("../x.txt", offset);
    fs.writeFileSync(file, bytes);
  }
  const result = extract(f.directory, file, await fileHash(file));
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.directory, "x.txt")), false);
  if (kind !== "unreviewed") assert.equal(fs.existsSync(path.join(f.directory, "extracted", "expected.txt")), false);
});
test("ZIP extraction rejects file checksum mismatches even when the archive digest is valid", async t => {
  const f = fixture(t), file = path.join(f.directory, "release.zip");
  await zipEntries(file, [[".deployment-files.json", JSON.stringify([{ name: "code.txt", bytes: 5,
    hash: crypto.createHash("sha256").update("right").digest("hex") }])], ["code.txt", "wrong"]]);
  const result = extract(f.directory, file, await fileHash(file));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release file checksum mismatch/);
});
