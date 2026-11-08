"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { once } = require("node:events");
const { spawnSync, spawn } = require("node:child_process");
const { stopReleaseGateways } = require("../../../scripts/stop-release-gateways");

function fixture(records, root = path.resolve("managed-release")) {
  const proc = path.resolve("proc-fixture"), signals = [];
  const processes = new Map(records.map(record => [record.pid, { cwd: root, start: "100", executable: "node", args: ["node", "scripts/serve.js"], ...record }]));
  const read = file => {
    const relative = path.relative(proc, file).split(path.sep);
    const record = processes.get(Number(relative[0]));
    if (!record) throw Object.assign(new Error("Process exited"), { code: "ENOENT" });
    return { record, field: relative[1] };
  };
  let time = 0;
  return {
    root, processes, signals,
    options: {
      proc, timeoutMs: 300, now: () => time, wait: async ms => { time += ms; },
      log() {},
      signal(pid, signal) { signals.push({ pid, signal }); processes.delete(pid); },
      filesystem: {
        statSync: file => ({ uid: processes.get(Number(path.basename(file)))?.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined) }),
        readdirSync: () => [...processes.keys()].map(String),
        realpathSync: file => file === root ? root : read(file).record.cwd,
        readlinkSync: file => path.join(path.resolve("bin"), read(file).record.executable),
        readFileSync(file) {
          const { record, field } = read(file);
          if (field === "cmdline") return record.args.join("\0") + "\0";
          if (field === "stat") return `${record.pid} (node gateway) ${[...Array(19).fill("0"), record.start].join(" ")}`;
          throw new Error("Unexpected process field");
        },
      },
    },
  };
}
test("shutdown signals only exact Node gateways in the verified managed release", async () => {
  const f = fixture([
    { pid: 10 }, { pid: 11, args: ["node", path.join(path.resolve("managed-release"), "scripts", "serve.js")] },
    { pid: 12, args: ["node", "scripts/other.js"] },
    { pid: 13, cwd: path.resolve("unrelated"), args: ["node", "scripts/serve.js"] },
    { pid: 14, executable: "npm" }, { pid: 15, args: ["node", "scripts/serve.js", "--unrecognized"] },
  ]);
  await stopReleaseGateways([f.root], f.options);
  assert.deepEqual(f.signals, [{ pid: 10, signal: "SIGTERM" }, { pid: 11, signal: "SIGTERM" }]);
  assert.deepEqual([...f.processes.keys()], [12, 13, 14, 15]);
});
test("shutdown waits for exit and refuses a concurrent writer if graceful termination times out", async () => {
  const f = fixture([{ pid: 10 }]);
  f.options.signal = (pid, signal) => f.signals.push({ pid, signal });
  await assert.rejects(stopReleaseGateways([f.root], f.options), /Refusing to start a competing financial writer/);
  assert.deepEqual(f.signals, [{ pid: 10, signal: "SIGTERM" }]);
  assert.equal(f.processes.size, 1);
});
test("shutdown handles disappearing processes and never signals a reused PID", async () => {
  const f = fixture([{ pid: 10 }]), originalRead = f.options.filesystem.readFileSync;
  let reads = 0;
  f.options.filesystem.readFileSync = file => {
    if (path.basename(file) === "stat" && ++reads === 2) f.processes.get(10).start = "200";
    return originalRead(file);
  };
  await stopReleaseGateways([f.root], f.options);
  assert.deepEqual(f.signals, []);
  const gone = fixture([{ pid: 11 }]);
  gone.options.signal = () => {
    gone.processes.clear();
    throw Object.assign(new Error("Exited"), { code: "ESRCH" });
  };
  await stopReleaseGateways([gone.root], gone.options);
});
test("shutdown surfaces permission and inspection errors instead of silently starting another writer", async () => {
  const f = fixture([{ pid: 10 }]);
  f.options.signal = () => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); };
  await assert.rejects(stopReleaseGateways([f.root], f.options), /Denied/);
  f.options.filesystem.readlinkSync = () => { throw Object.assign(new Error("Cannot inspect"), { code: "EACCES" }); };
  await assert.rejects(stopReleaseGateways([f.root], f.options), /Cannot inspect/);
  await assert.rejects(stopReleaseGateways([], f.options), /managed release directory/);
});
test("verified old gateway termination releases its TCP listener before the replacement starts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-lifecycle-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "serve.js"), `
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, ["scripts/serve.js"], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [address] = await once(child, "message"), exited = once(child, "exit");
  const probe = net.createServer();
  const blocked = once(probe, "error");
  probe.listen(address.port, "127.0.0.1");
  assert.equal((await blocked)[0].code, "EADDRINUSE");
  const f = fixture([{ pid: child.pid }], root);
  child.once("exit", () => f.processes.delete(child.pid));
  const options = process.platform === "linux" ? {} : {
    ...f.options, now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    signal: process.kill, timeoutMs: 10000,
  };
  await stopReleaseGateways([root], options);
  await exited;
  const replacement = net.createServer();
  t.after(() => replacement.close());
  replacement.listen(address.port, "127.0.0.1");
  await once(replacement, "listening");
  assert.equal(replacement.address().port, address.port);
});
test("installer deletes PM2, waits for verified old gateway exit, then starts the release; shutdown failure blocks start", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/deploy-release.sh"), "utf8").replace(/\r\n/g, "\n");
  const body = script.slice(script.indexOf("start_release() {"), script.indexOf('candidate="$release/nginx'));
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  for (const fail of [false, true]) {
    const result = spawnSync(bash, ["-c", `set -Eeuo pipefail
pm2=fixture_pm2
release=/new
previous=/old
fixture_pm2() { [[ "$1" == describe ]] || echo "pm2 $*"; }
node() { echo "shutdown $*"; ${fail ? "return 1" : ":"}; }
${body}
start_release /new`], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.match(result.stdout, /pm2 delete featheral\nshutdown \/new\/scripts\/stop-release-gateways.js \/new \/new \/old/);
    if (fail) assert.doesNotMatch(result.stdout, /pm2 start/);
    else assert.match(result.stdout, /pm2 start \/new\/ecosystem.config.cjs/);
  }
});
