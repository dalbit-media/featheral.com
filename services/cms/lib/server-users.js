"use strict";
const { sshConfiguration, redactServerLog } = require("./deployment");
const fail = (status, message) => Object.assign(new Error(message), { status });
const serverLogs = [
  { id: "deployment", label: "Deployment installer", file: "shared/logs/deployment.log" },
  { id: "application", label: "Application stdout (PM2)", file: "shared/logs/app.log" },
  { id: "errors", label: "Application errors (PM2)", file: "shared/logs/error.log" },
  { id: "nginx-access", label: "Nginx access", file: "/var/log/nginx/access.log" },
  { id: "nginx-error", label: "Nginx errors", file: "/var/log/nginx/error.log" },
  { id: "certbot", label: "Certificate setup / renewal", file: "/var/log/letsencrypt/letsencrypt.log" },
];
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
class ServerUsers {
  constructor({ deployment, settings, env = require("../../operations/runtime").environment() }) {
    this.deployment = deployment; this.settings = settings; this.env = env;
  }
  async connect(config) {
    try { return await this.deployment.connect(config); }
    catch { throw fail(502, "SSH authentication or host verification failed. Check Settings, host fingerprint and server login policy."); }
  }
  command(client, command, input = "") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0, finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(fail(504, "Server operation timed out. Verify the server before retrying."));
        client.end();
      }, (this.settings?.value.sshTimeoutSeconds || 20) * 1000);
      client.exec(command, (error, stream) => {
        if (error) return finish(fail(502, "SSH could not start the operation."));
        stream.on("data", chunk => {
          if (finished) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) { finish(fail(502, "Server output exceeds the supported size.")); stream.close(); return; }
          chunks.push(Buffer.from(chunk));
        });
        stream.stderr.on("data", () => {});
        stream.once("error", () => finish(fail(502, "SSH operation interrupted. Verify the server before retrying.")));
        stream.once("close", code => {
          if (code !== 0) return finish(fail(502, "SSH operation did not confirm success. Check server state and sudo permissions."));
          finish(null, Buffer.concat(chunks).toString("utf8"));
        });
        stream.end(input);
      });
    });
  }
  listBinding({ page = "1", query = "" } = {}) {
    if (!/^[1-9]\d{0,6}$/.test(String(page)) || typeof query !== "string" || query.length > 100)
      throw fail(400, "Invalid account search or page.");
    return { page: String(page), query };
  }
  challengeList(input, context) {
    if (!this.vault) throw fail(503, "Configure credentials in Settings.");
    return this.vault.challengeUse("BROWSE SERVER ACCOUNTS", this.listBinding(input), context);
  }
  logCatalog() {
    return { logs: [{ id: "all", label: "All tracked logs + deployment progress" }, ...serverLogs.map(({ id, label }) => ({ id, label }))],
      targets: this.settings.deploymentTargets(this.deployment.sites()).map(({ id, host }) => ({ id, host })) };
  }
  logBinding(input = {}) {
    const target = this.settings.deploymentTargets(this.deployment.sites()).find(target => target.id === input.target);
    const log = serverLogs.find(log => log.id === input.log);
    if (!target || (!log && input.log !== "all")) throw fail(400, "Choose a configured deployment server and a listed log.");
    return { target: target.id, log: input.log, revision: this.settings.value.revision };
  }
  challengeLogs(input, context) {
    const binding = this.logBinding(input);
    return this.settings.approvals.challenge("READ SERVER LOG", binding, context, `${binding.target}: ${binding.log} (last 64 KiB, up to 400 lines per file${binding.log === "all" ? "; includes CMS deployment progress" : ""})`);
  }
  async readLogs(input, context) {
    const binding = this.logBinding(input);
    this.settings.approvals.consume("READ SERVER LOG", binding, context, input);
    const credentials = this.settings.deploymentTargets(this.deployment.sites(), true);
    const config = credentials.find(target => target.id === binding.target);
    const logs = binding.log === "all" ? serverLogs : serverLogs.filter(log => log.id === binding.log);
    let client;
    try {
      client = await this.connect(config);
      const secrets = [
        ...credentials.map(target => target.password),
        this.settings.value.credential?.password,
        ...Object.values(this.settings.value.siteServers || {}).map(profile => profile.credential?.password),
        ...require("../../operations/configuration").fields.filter(field => field.secret).map(field => this.settings.value.runtime?.[field.name]),
      ].filter(Boolean).sort((a, b) => b.length - a.length);
      const sources = [];
      if (binding.log === "all") {
        const progress = this.deployment.status();
        sources.push({ id: "progress", label: "Deployment progress (CMS)", text: redactServerLog(progress.logs.map(entry =>
          `[${new Date(entry.at).toISOString()}] ${entry.message}`).join("\n"), secrets) });
      }
      for (const log of logs) {
        const file = log.file.startsWith("/") ? log.file : `${config.directory}/${log.file}`;
        const read = `tail -c 65536 -- ${quote(file)} | tail -n 400`;
        const command = `IFS= read -r password; if [ "$(id -u)" = 0 ]; then /bin/bash -o pipefail -c ${quote(read)}; else printf '%s\\n' "$password" | sudo -S -p '' -- /bin/bash -o pipefail -c ${quote(read)}; fi`;
        try {
          const text = redactServerLog(await this.command(client, command, config.password + "\n"), secrets);
          sources.push({ id: log.id, label: log.label, text });
        } catch (error) {
          const message = `Could not read ${log.label} on ${config.host}. Check that the log file exists and the saved user has sudo access. ${error.message}`;
          if (binding.log !== "all") throw fail(error.status || 502, message);
          sources.push({ id: log.id, label: log.label, error: message });
          if (error.status === 504) {
            for (const remaining of logs.slice(logs.indexOf(log) + 1))
              sources.push({ id: remaining.id, label: remaining.label, error: "Not read: SSH connection timed out. Sign a new read to retry." });
            break;
          }
        }
      }
      const combined = binding.log === "all";
      const text = combined ? sources.map(source => `--- ${source.label} ---\n${source.error ? `ERROR: ${source.error}` : source.text || "(empty)"}`).join("\n\n") : sources[0].text;
      return { host: config.host, log: binding.log, text, sources,
        limit: `Last 64 KiB, up to 400 lines${combined ? " per remote file; CMS latest 200 events; grouped by source, not time-sorted" : ""}`, at: Date.now() };
    } finally { client?.end(); for (const credential of credentials) credential.password = ""; }
  }
  async list(input = {}, context) {
    const { page, query } = this.listBinding(input);
    if ((this.settings || !this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE && this.vault) && !input.challengeId)
      throw fail(403, "Use Sign & browse to approve an account read with the credential stored in Settings.");
    const config = this.settings || !this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE && this.vault
      ? this.vault.use("BROWSE SERVER ACCOUNTS", this.listBinding(input), context, input) : sshConfiguration(this.env);
    let client;
    try {
      client = await this.connect(config);
      const output = await this.command(client, "getent passwd");
      const users = output.trimEnd().split("\n").filter(Boolean).map(line => {
        const fields = line.replace(/\r$/, "").split(":");
        if (fields.length !== 7 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) throw fail(502, "Server returned an invalid account record.");
        return { username: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5], shell: fields[6] };
      }).sort((a, b) => a.uid - b.uid || a.username.localeCompare(b.username));
      const term = query.toLowerCase(), filtered = users.filter(user =>
        [user.username, String(user.uid), String(user.gid), user.home, user.shell].some(value => value.toLowerCase().includes(term)));
      const pageSize = 50;
      return { target: config.host, total: filtered.length, accounts: users.length, page: Number(page), pageSize,
        users: filtered.slice((Number(page) - 1) * pageSize, Number(page) * pageSize) };
    } finally { client?.end(); config.password = ""; }
  }
}
module.exports = { ServerUsers };
