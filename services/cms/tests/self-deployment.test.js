"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const { Wallet } = require("ethers");
const { SelfDeployment, repository } = require("../../operations/self-deployment");
const { OriginApprovals } = require("../../database/approvals");
const { updateCheckout } = require("../../../scripts/self-deploy");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "self-deployment-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "releases", "release-1-aaaaaaaaaaaa");
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(root, path.join(directory, "current"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(root, ".deployment-hosts.json"), JSON.stringify({ primary: true,
    hosts: ["admin.featheral.com", "featheral.com"], uploadLimitMiB: 32, requestTimeoutSeconds: 120 }));
  const wallet = Wallet.createRandom(), context = { origin: "https://admin.featheral.com", session: "test", wallet: wallet.address };
  const settings = { value: { enabled: true, revision: 1 }, approvals: new OriginApprovals({ wallet: wallet.address }) };
  const calls = [], state = { active: false, failLaunch: false, busy: false };
  const command = (program, args) => {
    calls.push({ program, args });
    if (program === "systemctl") return { status: 0, stdout: state.active ? "active\n" : "inactive\n" };
    return { status: state.failLaunch ? 1 : 0 };
  };
  const deployment = { running: false };
  const service = new SelfDeployment({ root, settings, deployment, busy: () => state.busy, platform: "linux", uid: 1000, command });
  const signed = async () => {
    const challenge = service.challenge(context);
    return { challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) };
  };
  return { directory, root, settings, calls, state, deployment, service, context, signed, wallet };
}
test("self-sync is available only in the active Linux Admin release", t => {
  const f = fixture(t);
  assert.equal(f.service.status().available, true);
  f.service.platform = "win32";
  assert.equal(f.service.status().available, false);
  assert.throws(() => f.service.challenge(f.context), /Linux Admin/);
  f.service.platform = "linux";
  fs.writeFileSync(path.join(f.root, ".deployment-hosts.json"), JSON.stringify({ primary: false, hosts: ["gold.featheral.com"] }));
  assert.equal(f.service.status().available, false);
  assert.throws(() => f.service.challenge(f.context), /server running Admin/);
});
test("self-sync requires a revision- and session-bound wallet signature and starts an independent systemd job", async t => {
  const f = fixture(t);
  assert.throws(() => f.service.start({}, f.context), { status: 403 });
  const wrongRevision = await f.signed(); f.settings.value.revision++;
  assert.throws(() => f.service.start(wrongRevision, f.context), { status: 403 });
  const wrongSession = await f.signed();
  assert.throws(() => f.service.start(wrongSession, { ...f.context, session: "other" }), { status: 403 });
  const receipt = f.service.start(await f.signed(), f.context);
  assert.equal(receipt.running, true);
  const launch = f.calls.find(call => call.program === "sudo");
  assert.deepEqual(launch.args.slice(0, 3), ["-n", "systemd-run", "--collect"]);
  assert(launch.args.includes("--unit=featheral-deployment"));
  assert(launch.args.includes(path.join(f.root, "scripts", "self-deploy.js")));
  assert(!launch.args.some(arg => arg.includes("password")));
  f.state.active = true;
  assert.equal(f.service.status().running, true);
  const restored = new SelfDeployment({ ...f.service, command: f.service.command });
  assert.equal(restored.status().id, receipt.id);
  assert.throws(() => f.service.challenge(f.context), /current deployment/);
  f.state.active = false;
  assert.equal(f.service.status().phase, "uncertain");
  assert.throws(() => f.service.challenge(f.context), /interrupted self-sync/);
});
test("self-sync is independent of SSH upload deployment enablement and still requires wallet approval", async t => {
  const f = fixture(t);
  f.settings.value.enabled = false;
  assert.equal(f.service.status().available, true);
  assert.throws(() => f.service.start({}, f.context), { status: 403 });
  const receipt = f.service.start(await f.signed(), f.context);
  assert.equal(receipt.running, true);
  assert(f.calls.some(call => call.program === "sudo"));
  assert.equal(f.settings.value.enabled, false, "local self-sync must not enable remote SSH deployments");
});
test("self-sync rejects concurrent operations and fails explicitly when launch is denied", async t => {
  const f = fixture(t);
  f.state.busy = true;
  assert.throws(() => f.service.challenge(f.context), /Wait/);
  f.state.busy = false; f.deployment.running = true;
  assert.throws(() => f.service.challenge(f.context), /Wait/);
  f.deployment.running = false;
  fs.mkdirSync(path.join(f.directory, "shared"));
  fs.writeFileSync(path.join(f.directory, "shared", "site-sync.lock"), "locked");
  assert.throws(() => f.service.challenge(f.context), /Wait/);
  fs.unlinkSync(path.join(f.directory, "shared", "site-sync.lock"));
  const signed = await f.signed(); f.state.failLaunch = true;
  assert.throws(() => f.service.start(signed, f.context), /non-interactive sudo/);
  assert.equal(f.service.status().phase, "failed");
});
test("persistent checkout pulls the remote default branch and refuses dirty or unpushed code", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "self-deployment-git-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote"), checkout = path.join(directory, "checkout");
  fs.mkdirSync(remote);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(remote, "init", "-b", "trunk"); git(remote, "config", "user.email", "fixture@example.test"); git(remote, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(remote, "code.txt"), "first");
  git(remote, "add", "code.txt"); git(remote, "commit", "-m", "first");
  const commands = [];
  const command = async (program, args, cwd) => {
    commands.push(args);
    return execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  };
  let result = await updateCheckout(checkout, command, remote);
  assert.equal(result.branch, "trunk"); assert.equal(result.commit, git(remote, "rev-parse", "HEAD"));
  fs.writeFileSync(path.join(remote, "code.txt"), "second");
  git(remote, "commit", "-am", "second");
  result = await updateCheckout(checkout, command, remote);
  assert.equal(result.commit, git(remote, "rev-parse", "HEAD"));
  assert(commands.some(args => args.join(" ") === "pull --ff-only origin trunk"));
  fs.writeFileSync(path.join(checkout, "code.txt"), "local edit");
  await assert.rejects(updateCheckout(checkout, command, remote), /local changes/);
  git(checkout, "config", "user.email", "fixture@example.test"); git(checkout, "config", "user.name", "Fixture");
  git(checkout, "commit", "-am", "local commit");
  await assert.rejects(updateCheckout(checkout, command, remote), /unpushed commits/);
  git(checkout, "remote", "set-url", "origin", repository);
  await assert.rejects(updateCheckout(checkout, command, remote), /origin does not match/);
});
test("self-sync API requires the Admin host, authentication, same origin and wallet approval", async t => {
  const f = fixture(t), express = require("express"), http = require("node:http");
  const { once } = require("node:events");
  const { settingsApi } = require("../../operations/api");
  const app = express(); let authenticated = true;
  app.use("/api/settings", settingsApi({ settings: f.settings, selfDeployment: f.service,
    cmsAuth(req, res, next) {
      if (!authenticated) return res.sendStatus(401);
      req.adminWallet = f.wallet.address; req.adminSession = "test"; next();
    } }));
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (route, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/settings/self-sync" + route,
      method: body === undefined ? "GET" : "POST", headers: { Host: "admin.localhost", Origin: "http://admin.localhost",
        "Content-Type": "application/json", ...extraHeaders } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode,
        body: res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request("")).status, 200);
  assert.equal((await request("", undefined, { Host: "gold.localhost" })).status, 404);
  authenticated = false;
  assert.equal((await request("")).status, 401); authenticated = true;
  assert.equal((await request("/challenge", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("/start", {})).status, 403);
  const proof = await request("/challenge", {});
  assert.equal(proof.status, 200);
  const result = await request("/start", { challengeId: proof.body.challengeId, signature: await f.wallet.signMessage(proof.body.message) });
  assert.equal(result.status, 200); assert.equal(result.body.running, true);
});
for (const fails of [false, true, "preflight"]) test(`self-sync worker persists ${fails === "preflight" ? "preflight refusal without cutover" : fails ? "failure" : "verified completion"} across the restart`, async t => {
  const f = fixture(t), vm = require("node:vm"), { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream"), { createRequire } = require("node:module");
  const scriptFile = path.resolve(__dirname, "../../../scripts/self-deploy.js"), actualRequire = createRequire(scriptFile);
  const helper = require("../lib/deployment"), calls = [];
  const directory = path.join(f.directory, "shared", "self-deployment"), id = require("node:crypto").randomUUID();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ id, phase: "running", logs: [] }));
  const stdout = [];
  const spawn = (program, args, options) => {
    calls.push({ program, args, cwd: options.cwd });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit("close", 1);
    queueMicrotask(() => {
      let output = "";
      if (program === "git") {
        if (args[0] === "clone") {
          const checkout = args.at(-1);
          fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
          fs.mkdirSync(path.join(checkout, "sites"), { recursive: true });
          fs.writeFileSync(path.join(checkout, "scripts", "deploy-release.sh"), "#!/bin/bash\ntrue\n");
          fs.writeFileSync(path.join(checkout, "sites", "code.js"), "console.log('fresh code');");
        }
        if (args[0] === "remote") output = repository + "\n";
        if (args[0] === "ls-remote") output = "ref: refs/heads/trunk\tHEAD\n";
        if (args[0] === "rev-parse") output = "a".repeat(40) + "\n";
      } else {
        assert.equal(program, "/bin/bash");
        assert.equal(args.at(-1), "self");
        assert.equal(args[1], f.directory);
        assert.equal(args[3], "", "an existing HTTPS installation needs no outbound TLS registration email");
        assert.equal(args[5], "32", "preserve installed upload limits, not outbound deployment defaults");
        assert.equal(args[6], "120", "preserve installed request timeouts");
        assert.match(args[2], /^release-\d+-a{12}$/);
        assert.equal(fs.existsSync(args[8]), true, "fresh ZIP exists before the installer starts");
        output = fails ? "FEATHERAL_FAILURE:health:1\n" : "FEATHERAL_PHASE:verified\n";
      }
      child.stdout.end(output); child.stderr.end(); child.emit("close", program === "/bin/bash" && fails ? 1 : 0);
    });
    return child;
  };
  const moduleObject = { exports: {} };
  vm.runInNewContext(fs.readFileSync(scriptFile, "utf8"), {
    module: moduleObject,
    require(name) {
      if (name === "node:child_process") return { spawn };
      if (name === "../services/cms/lib/deployment") return { ...helper, releaseFiles: () => ["scripts/deploy-release.sh", "sites/code.js"] };
      if (name === "../services/operations/settings") return { OperationsSettings: class {
        constructor() { this.value = { tlsEmail: "", uploadLimitMiB: 16, requestTimeoutSeconds: 90 }; }
      } };
      if (name === "./deployment-preflight") return { readPolicy() {}, verifyCompatibility(candidate, previous) {
        assert.equal(candidate, path.join(directory, "checkout"));
        assert.equal(previous, f.root);
        if (fails === "preflight") throw new Error("Live reserve policy mismatch; activation refused before stopping gateway.");
      } };
      return actualRequire(name);
    },
    process: { platform: "linux", env: {} }, console: { log: line => stdout.push(line) }, setTimeout, clearTimeout, Buffer,
  });
  if (fails) await assert.rejects(moduleObject.exports.run(f.directory, id), fails === "preflight" ? /policy mismatch/ : /bash failed/);
  else await moduleObject.exports.run(f.directory, id);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "status.json")));
  assert.equal(receipt.phase, fails ? "failed" : "complete");
  assert.equal(receipt.running, false); assert(receipt.finishedAt);
  assert.equal(receipt.branch, "trunk"); assert.equal(receipt.commit, "a".repeat(40));
  assert.equal(fs.existsSync(path.join(directory, id)), false, "only job-specific package staging is cleaned");
  assert.equal(fs.existsSync(path.join(directory, "checkout")), true, "persistent Git checkout survives");
  assert(calls.some(call => call.program === "git" && call.args.join(" ") === "pull --ff-only origin trunk"));
  if (fails === "preflight") assert(!calls.some(call => call.program === "/bin/bash"), "incompatible source never reaches the installer");
});
