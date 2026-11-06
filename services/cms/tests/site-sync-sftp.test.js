"use strict";
// End-to-end: real ssh2 server, real SFTP writes to disk and real bash/sha256sum/find/df/xargs on the "target".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Server, Client, utils } = require("ssh2");
const { SiteSync } = require("../lib/site-sync");
const { Deployment } = require("../lib/deployment");

const windows = process.platform === "win32";
const bash = windows ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "/bin/bash";
const toRemote = file => windows ? file.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, "/") : file;
const fromRemote = remote => windows ? remote.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:/`) : remote;
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const { STATUS_CODE } = utils.sftp;

function write(base, relative, contents) {
  const file = path.join(base, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file;
}
function shim(directory, name, body) {
  fs.writeFileSync(path.join(directory, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

async function sshTarget(t, base) {
  const host = utils.generateKeyPairSync("ed25519");
  const blob = utils.parseKey(host.public).getPublicSSH();
  const fingerprint = `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  const shims = path.join(base, "shims"), applied = path.join(base, "applied.txt");
  fs.mkdirSync(shims);
  shim(shims, "id", "echo 0");
  shim(shims, "systemd-run", 'while [ "$1" != /bin/bash ]; do shift; done; shift; exec /bin/bash "$@"');
  // The receiver itself is Linux-only and unit-tested separately; here it records the verified invocation.
  shim(shims, "node", 'if [ "${2:-}" = --check-sites ]; then echo "Site sync readiness verified"; exit 0; fi; printf "%s\\n" "$@" > "$APPLIED"; echo FEATHERAL_SYNC:install; echo FEATHERAL_SYNC:health');
  const opened = [];
  const server = new Server({ hostKeys: [host.private] }, connection => {
    connection.on("authentication", context => context.method === "password" && context.password === "ssh-secret" ? context.accept() : context.reject(["password"]));
    connection.on("ready", () => connection.on("session", accept => {
      const session = accept();
      session.on("exec", (accept, _reject, info) => {
        const stream = accept();
        const child = spawn(bash, ["-c", info.command], { env: { ...process.env, APPLIED: windows ? toRemote(applied) : applied,
          PATH: [shims, path.dirname(bash), process.env.PATH].join(path.delimiter) } });
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false });
        stream.pipe(child.stdin);
        child.on("close", code => { stream.exit(code ?? 1); stream.end(); });
      });
      session.on("sftp", accept => {
        const sftp = accept(), handles = new Map();
        let next = 0;
        const attrs = file => { const stat = fs.lstatSync(file); return { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: 0, mtime: 0 }; };
        sftp.on("LSTAT", (id, remote) => {
          const file = fromRemote(remote);
          fs.existsSync(file) ? sftp.attrs(id, attrs(file)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
        });
        sftp.on("OPEN", (id, remote, flags) => {
          const mode = utils.sftp.flagsToString(flags);
          try {
            const fd = fs.openSync(fromRemote(remote), mode), handle = Buffer.alloc(4);
            handle.writeUInt32BE(++next); handles.set(next, fd); opened.push({ remote, mode });
            sftp.handle(id, handle);
          } catch { sftp.status(id, STATUS_CODE.FAILURE); }
        });
        sftp.on("WRITE", (id, handle, offset, data) => {
          fs.writeSync(handles.get(handle.readUInt32BE()), data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK);
        });
        sftp.on("CLOSE", (id, handle) => {
          const key = handle.readUInt32BE(); fs.closeSync(handles.get(key)); handles.delete(key); sftp.status(id, STATUS_CODE.OK);
        });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, fingerprint, opened, applied };
}

test("real SFTP sync uploads databases first, pauses mid-file, resumes from the prefix and verifies on the target", { skip: !fs.existsSync(bash) && "bash is unavailable" }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-sftp-sync-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "source"), targetRoot = path.join(base, "target");
  write(root, "data/fth-ledger/local-node/2026/2026-01-01.jsonl", '{"source":true}\n');
  write(root, "services/cms/data/site/manifest.json", '{"site":"source"}');
  for (let index = 0; index < 5; index++) write(root, `services/cms/data/site/uploads/photo-${index}.txt`, `upload ${index}`);
  write(root, "services/cms/data/site/uploads/video.bin", crypto.randomBytes(6 * 1024 * 1024));
  write(targetRoot, "current/services/operations/settings.js", "module.exports = {};");
  const remote = await sshTarget(t, base);

  const deployment = Object.assign(Object.create(Deployment.prototype), { running: false, clientFactory: () => new Client(),
    sites: () => [{ key: "gold", status: "ready" }] });
  const settings = { value: { revision: 1 }, environment: () => ({}) };
  let clock = 1_000_000;
  const service = new SiteSync({ root, settings, deployment, now: () => (clock += 1000) });
  service.target = () => ({ id: "shared", host: "127.0.0.1", port: remote.port, username: "root", password: "ssh-secret",
    fingerprint: remote.fingerprint, directory: toRemote(targetRoot), hosts: ["gold.featheral.com"], sshTimeoutSeconds: 20, deploymentTimeoutSeconds: 60 });
  let pauseRequested = false;
  const progress = service.progress.bind(service);
  service.progress = (percent, stage, details = {}) => {
    progress(percent, stage, details);
    if (!pauseRequested && stage.includes("video.bin") && details.transferredBytes > service.result.uploadSample.totalBytes - 6 * 1024 * 1024) {
      pauseRequested = true; service.pause({ site: "gold" });
    }
  };

  await service.startShared({ site: "gold", revision: 1 }, { session: "admin", origin: "https://admin.example" });
  await service.transferTask;
  assert.equal(service.status().phase, "paused", service.status().logs.map(log => log.message).join("\n"));
  const id = service.status().binding.id, staging = path.join(targetRoot, "shared", "site-sync", id, "snapshot");
  const partial = fs.statSync(path.join(staging, "cms", "site", "uploads", "video.bin")).size;
  assert.ok(partial > 0 && partial < 6 * 1024 * 1024, `partial prefix retained (${partial} bytes)`);
  assert.equal(fs.existsSync(remote.applied), false, "nothing is applied while paused");

  const snapshotFiles = remote.opened.filter(entry => entry.remote.includes("/snapshot/")).map(entry => entry.remote.split("/snapshot/")[1]);
  const firstUpload = snapshotFiles.findIndex(name => /\/uploads\//.test(name));
  assert.ok(firstUpload > 0 && snapshotFiles.slice(firstUpload).every(name => /\/uploads\//.test(name)), `databases first: ${snapshotFiles.join(", ")}`);
  const beforeResume = remote.opened.length;

  service.resume({ site: "gold" });
  await service.transferTask;
  const status = service.status();
  assert.equal(status.phase, "complete", status.logs.map(log => log.message).join("\n"));
  const resumed = remote.opened.slice(beforeResume).filter(entry => entry.remote.includes("/snapshot/"));
  assert.deepEqual(resumed.map(entry => [entry.remote.split("/snapshot/")[1], entry.mode]),
    [["cms/site/uploads/video.bin", "r+"], ["manifest.json", "wx"]], "only the partial file is reopened and appended");
  assert.ok(status.logs.some(log => /Skipped \d+ files already verified/.test(log.message)));

  const manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
  for (const entry of manifest.entries) assert.equal(sha(path.join(staging, ...entry.name.split("/"))), entry.hash, entry.name);
  const args = fs.readFileSync(remote.applied, "utf8").trim().split("\n");
  assert.match(args[0], /\/receiver-[a-f0-9]{16}\/scripts\/restore-site-sync\.js$/);
  assert.equal(sha(fromRemote(args[0])), sha(path.join(__dirname, "..", "..", "..", "scripts", "restore-site-sync.js")));
  assert.equal(args[2], toRemote(staging));
  assert.deepEqual(JSON.parse(args[5]), ["gold.featheral.com"]);
  assert.equal(fs.existsSync(path.join(service.directory, id)), false, "local snapshot removed after completion");
});
