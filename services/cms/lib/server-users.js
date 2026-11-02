"use strict";
const { sshConfiguration } = require("./deployment");
const fail = (status, message) => Object.assign(new Error(message), { status });
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
