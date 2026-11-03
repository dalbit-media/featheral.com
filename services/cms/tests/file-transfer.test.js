"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { checkSpace, uploadFile, fileHash } = require("../lib/deployment");
test("disk preflight enforces the exact byte threshold and fails closed on missing disk output", async () => {
  let available = "1024";
  const deployment = { execute: async (_client, command, _input, _seconds, _phase, onLog) => {
    assert.match(command, /^df -Pk/); if (available) onLog(available);
  } };
  await checkSpace(deployment, {}, "/srv/staging", 1024 * 1024, 20);
  await assert.rejects(checkSpace(deployment, {}, "/srv/staging", 1024 * 1024 + 1, 20), /Insufficient target disk space/);
  available = "";
  await assert.rejects(checkSpace(deployment, {}, "/srv/staging", 1, 20), /could not be verified/);
});
test("empty files are created, completed files are verified and skipped, and changed sources send no bytes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-file-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "empty"), target = { sshTimeoutSeconds: 1, deploymentTimeoutSeconds: 1 };
  fs.writeFileSync(file, "");
  const digest = await fileHash(file);
  let exists = false, opens = 0, writes = 0;
  const sftp = {
    lstat(_file, done) { exists ? done(null, { size: 0, isFile: () => true }) : done({ code: 2 }); },
    open(_file, flags, _mode, done) { assert.equal(flags, "wx"); opens++; exists = true; done(null, "handle"); },
    write() { writes++; }, close(_handle, done) { done(); },
  };
  const deployment = {
    transfer: (_client, fn) => new Promise((resolve, reject) => fn((err, result) => err ? reject(err) : resolve(result))),
    execute: async (_client, _command, _input, _seconds, _phase, onLog) => onLog(digest + "  -"),
  };
  const options = { deployment, client: {}, sftp, file, remote: "/srv/empty", bytes: 0, digest, target };
  await uploadFile(options); await uploadFile(options);
  assert.equal(opens, 1); assert.equal(writes, 0);
  fs.writeFileSync(file, "changed");
  await assert.rejects(uploadFile(options), /Source file changed/);
  assert.equal(opens, 1); assert.equal(writes, 0);
});
