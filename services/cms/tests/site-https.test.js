"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setupSiteHTTPS } = require("../../../scripts/setup-site-https");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "featheral-https-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "current"));
  const hosts = ["pay.featheral.com", "world.featheral.com"];
  const manifest = path.join(root, "current", ".deployment-hosts.json");
  fs.writeFileSync(manifest, JSON.stringify({ hosts }));
  const nginxFile = path.join(root, "nginx");
  const original = "# Featheral managed gateway\nserver {\n server_name pay.featheral.com world.featheral.com;\n}\n";
  fs.writeFileSync(nginxFile, original);
  let valid = false;
  const commands = [], probes = [], logs = [];
  const options = { nginxFile, log: line => logs.push(line), probe: async host => {
    probes.push(host);
    if (!valid && host === hosts[0]) throw Object.assign(new Error("Wrong certificate"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    return { status: 200 };
  }, run(program, args) {
    commands.push({ program, args });
    if (program === "certbot") { valid = true; fs.writeFileSync(nginxFile, original + "# TLS configured\n"); }
  } };
  return { root, hosts, manifest, nginxFile, original, options, commands, probes, logs };
}
test("Sync provisions Pay HTTPS with only reviewed domains and verifies certificates and renewal", async t => {
  const f = fixture(t);
  await setupSiteHTTPS(f.root, f.hosts, "operator@example.com", f.options);
  const certbot = f.commands.find(command => command.program === "certbot");
  assert.deepEqual(certbot.args, ["--nginx", "--non-interactive", "--agree-tos", "--keep-until-expiring",
    "--expand", "--email", "operator@example.com", "--redirect", "-d", "pay.featheral.com", "-d", "world.featheral.com"]);
  assert.deepEqual(f.probes, [...f.hosts, ...f.hosts]);
  assert.ok(f.commands.some(command => command.program === "systemctl" && command.args.join(" ") === "is-active --quiet certbot.timer"));
  assert.ok(f.logs.some(line => line.includes("automatic renewal verified")));
});
test("Sync preserves valid certificates without requiring an email or changing Nginx", async t => {
  const f = fixture(t);
  await setupSiteHTTPS(f.root, f.hosts, "", { ...f.options, probe: async () => ({ status: 503 }) });
  assert.equal(f.commands.length, 0, "application errors do not trigger certificate issuance");
  assert.equal(fs.readFileSync(f.nginxFile, "utf8"), f.original);
});
test("Sync refuses undeployed hosts, unmanaged Nginx and missing certificate email", async t => {
  const f = fixture(t);
  await assert.rejects(setupSiteHTTPS(f.root, ["pay.featheral.com;id"], "", f.options), /Invalid reviewed/);
  await assert.rejects(setupSiteHTTPS(f.root, ["other.featheral.com"], "", f.options), /missing assigned sites/);
  assert.equal(f.probes.length, 0);
  await assert.rejects(setupSiteHTTPS(f.root, f.hosts, "", f.options), /certificate registration email/);
  fs.writeFileSync(f.nginxFile, "server_name pay.featheral.com world.featheral.com;");
  await assert.rejects(setupSiteHTTPS(f.root, f.hosts, "operator@example.com", f.options), /managed Nginx/);
  assert.equal(f.commands.length, 0);
});
test("transient HTTPS failures do not issue certificates or transfer data", async t => {
  const f = fixture(t);
  await assert.rejects(setupSiteHTTPS(f.root, f.hosts, "operator@example.com", {
    ...f.options, probe: async () => { throw Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }); },
  }), /HTTPS check failed/);
  assert.equal(f.commands.length, 0);
});
test("failed certificate issuance restores Nginx and does not report success", async t => {
  const f = fixture(t);
  await assert.rejects(setupSiteHTTPS(f.root, f.hosts, "operator@example.com", {
    ...f.options, run(program, args) {
      f.options.run(program, args);
      if (program === "certbot") throw new Error("ACME challenge failed");
    },
  }), /previous managed Nginx configuration restored.*ACME/);
  assert.equal(fs.readFileSync(f.nginxFile, "utf8"), f.original);
  assert.equal(f.commands.at(-1).program, "systemctl");
  assert.equal(f.logs.some(line => line.includes("automatic renewal verified")), false);
});
test("post-issuance invalid TLS or renewal failures restore Nginx", async t => {
  for (const renewalFailure of [true, false]) {
    const f = fixture(t);
    await assert.rejects(setupSiteHTTPS(f.root, f.hosts, "operator@example.com", {
      ...f.options, probe: async () => { throw Object.assign(new Error("Expired"), { code: "CERT_HAS_EXPIRED" }); },
      run(program, args) {
        f.options.run(program, args);
        if (renewalFailure && args.includes("certbot.timer")) throw new Error("Timer unavailable");
      },
    }), /previous managed Nginx configuration restored/);
    assert.equal(fs.readFileSync(f.nginxFile, "utf8"), f.original);
  }
});
