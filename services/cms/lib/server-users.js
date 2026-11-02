"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { SOURCE_ADDRESS } = require("../../gold-api/reserve");
const { sshConfiguration } = require("./deployment");
const fail = (status, message) => Object.assign(new Error(message), { status });

class ServerUsers {
  constructor({ deployment, env = process.env, auditFile, originWallet = SOURCE_ADDRESS, now = Date.now }) {
    this.deployment = deployment;
    this.env = env;
    this.auditFile = auditFile;
    this.changing = false;
    this.originWallet = ethers.getAddress(originWallet);
    this.now = now;
    this.approvals = new Map();
    this.approvalKey = crypto.randomBytes(32);
  }
  audit(action, outcome, host, credentialStored) {
    fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
    fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date().toISOString(), action, outcome, host,
      ...(typeof credentialStored === "boolean" ? { credentialStored } : {}) }) + "\n", { mode: 0o600 });
  }
  rootStatus() {
    let file;
    try { file = fs.openSync(this.auditFile, "r"); }
    catch (error) { if (error.code === "ENOENT") return { running: this.changing, last: null }; throw error; }
    try {
      const size = fs.fstatSync(file).size;
      if (!size) return { running: this.changing, last: null };
      const buffer = Buffer.alloc(Math.min(size, 16384));
      fs.readSync(file, buffer, 0, buffer.length, size - buffer.length);
      const lines = buffer.toString("utf8").trimEnd().split("\n");
      const last = JSON.parse(lines.at(-1));
      if (last.action !== "root-password-change" || typeof last.at !== "string" || typeof last.host !== "string"
        || !["requested", "verified", "not-submitted", "unverified-check-server"].includes(last.outcome))
        throw new Error("Invalid root-password audit status");
      return { running: this.changing, last: { at: last.at, host: last.host, outcome: last.outcome,
        ...(typeof last.credentialStored === "boolean" ? { credentialStored: last.credentialStored } : {}) } };
    } finally { fs.closeSync(file); }
  }
  async connect(config) {
    try { return await this.deployment.connect(config); }
    catch { throw fail(502, "SSH authentication or host verification failed. Check credentials, host fingerprint and server login policy."); }
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
        finish(fail(504, "Server operation timed out. Its result may be unknown; verify the server before retrying."));
        client.end();
      }, 20000);
      client.exec(command, (error, stream) => {
        if (error) return finish(fail(502, "The SSH server could not start the account operation."));
        stream.on("data", chunk => {
          if (finished) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) {
            finish(fail(502, "Server account output exceeds the supported size."));
            stream.close(); return;
          }
          chunks.push(Buffer.from(chunk));
        });
        // Never expose remote stderr: account tools may include sensitive input.
        stream.stderr.on("data", () => {});
        stream.once("error", () => finish(fail(502, "SSH account operation interrupted. Verify the server before retrying.")));
        stream.once("close", code => {
          if (code !== 0) return finish(fail(502, "Server account operation did not confirm success. Verify server state before retrying."));
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
    if (!this.vault) throw fail(503, "Credential vault is unavailable.");
    return this.vault.challengeUse("BROWSE SERVER ACCOUNTS", this.listBinding(input), context);
  }
  async list(input = {}, context) {
    const { page, query } = this.listBinding(input);
    if (!this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE && this.vault && !input.challengeId)
      throw fail(403, "Use Sign & browse stored credential to authorize a fresh server-account read with the origin wallet. Enroll the credential in Database & vault first.");
    const config = !this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE && this.vault
      ? this.vault.use("BROWSE SERVER ACCOUNTS", this.listBinding(input), context, input) : sshConfiguration(this.env);
    const client = await this.connect(config);
    let output;
    try { output = await this.command(client, "getent passwd"); } finally { client.end(); }
    const users = output.trimEnd().split("\n").filter(Boolean).map(line => {
      const fields = line.replace(/\r$/, "").split(":");
      if (fields.length !== 7 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]))
        throw fail(502, "Server returned an invalid account record.");
      return { username: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5], shell: fields[6] };
    }).sort((a, b) => a.uid - b.uid || a.username.localeCompare(b.username));
    const term = query.toLowerCase(), filtered = users.filter(user =>
      [user.username, String(user.uid), String(user.gid), user.home, user.shell].some(value => value.toLowerCase().includes(term)));
    const size = 50;
    return { target: config.host, total: filtered.length, accounts: users.length, page: Number(page), pageSize: size,
      users: filtered.slice((Number(page) - 1) * size, Number(page) * size) };
  }
  rootConfig(input) {
    if (this.vault?.busy) throw fail(409, "Credential enrollment is running. Wait before changing the root password.");
    if (this.vault?.env.DB_VAULT_KEY_FILE) this.vault.key().fill(0);
    const current = input?.currentPassword, next = input?.newPassword;
    if (typeof current !== "string" || !current || Buffer.byteLength(current) > 1024
      || typeof next !== "string" || next.length < 16 || Buffer.byteLength(next) > 256 || /[\x00-\x1f\x7f:]/.test(next))
      throw fail(400, "Supply the current root password and a new password of 16 or more characters (maximum 256 UTF-8 bytes), without colons or control characters.");
    if (current === next) throw fail(400, "The new password must differ from the current password.");
    if (input.confirmation !== "CHANGE ROOT PASSWORD") throw fail(400, "Enter the exact confirmation: CHANGE ROOT PASSWORD");
    if (this.changing || this.deployment.running) throw fail(409, "A password change or deployment is already running. Wait before retrying.");
    const base = sshConfiguration({ ...this.env, DEPLOY_KEY_FILE: "", DEPLOY_PASSWORD: current });
    const config = { ...base, username: "root", keyFile: "", password: current };
    return config;
  }
  binding(input, config, context) {
    return crypto.createHmac("sha256", this.approvalKey).update(JSON.stringify([
      input.currentPassword, input.newPassword, input.confirmation, config.host, config.port, config.directory,
      config.fingerprint, context.origin, context.session,
    ])).digest("hex");
  }
  challengeRoot(input, context) {
    if (!context?.origin || !context.session) throw fail(403, "An authenticated Admin session is required for wallet approval.");
    const config = this.rootConfig(input);
    const now = this.now(), expiresAt = now + 5 * 60000;
    for (const [id, approval] of this.approvals) if (approval.expiresAt <= now) this.approvals.delete(id);
    if (this.approvals.size >= 1000) throw fail(429, "Too many pending wallet approvals. Wait five minutes.");
    const challengeId = crypto.randomUUID();
    const target = `root@${config.host}:${config.port}${config.directory}`;
    const message = ["Featheral Admin server authorization", "", "Action: CHANGE ROOT PASSWORD",
      `Origin: ${context.origin}`, `Server: ${target}`, `SSH host key: ${config.fingerprint}`,
      `Wallet: ${this.originWallet}`, `Nonce: ${challengeId}`, `Issued at: ${new Date(now).toISOString()}`,
      `Expires at: ${new Date(expiresAt).toISOString()}`,
      "Approve only the exact root-password change prepared in this Admin session.",
      "No Ethereum transaction or token transfer. Never disclose your wallet private key."].join("\n");
    this.approvals.set(challengeId, { message, expiresAt, binding: this.binding(input, config, context) });
    return { challengeId, message, expiresAt, wallet: this.originWallet, target };
  }
  verifyApproval(input, config, context) {
    const approval = this.approvals.get(input.challengeId);
    this.approvals.delete(input.challengeId);
    if (!approval || approval.expiresAt <= this.now() || approval.binding !== this.binding(input, config, context))
      throw fail(403, "Wallet approval expired or does not match this Admin session, server or password change. Request a fresh approval.");
    let signer;
    try { signer = ethers.verifyMessage(approval.message, input.signature); }
    catch { throw fail(403, "Invalid origin-wallet approval signature."); }
    if (signer !== this.originWallet) throw fail(403, "Only the FTHG origin wallet may approve this password change.");
  }
  async changeRoot(input, context) {
    const config = this.rootConfig(input);
    if (!context?.origin || !context.session) throw fail(403, "An authenticated Admin session and origin-wallet approval are required.");
    this.verifyApproval(input, config, context);
    const next = input.newPassword;
    this.changing = true;
    let client, submitted = false;
    try {
      this.audit("root-password-change", "requested", config.host);
      client = await this.connect(config);
      if ((await this.command(client, "id -u")).trim() !== "0") throw fail(403, "Password change requires a verified root SSH session.");
      // stdin is the only channel carrying the new password; never interpolate it into a command.
      submitted = true;
      await this.command(client, "/usr/sbin/chpasswd", `root:${next}\n`);
      client.end(); client = null;
      const verification = await this.connect({ ...config, password: next });
      verification.end();
      let credentialStored = false;
      if (this.vault?.env.DB_VAULT_KEY_FILE) {
        try {
          const target = this.vault.target();
          if (["host", "port", "fingerprint", "directory"].some(key => target[key] !== config[key])) throw fail(409, "SSH target changed during password rotation.");
          this.vault.save(next, target); credentialStored = true;
        }
        catch (error) { console.error("Verified root password could not be stored in vault:", error.status || error.code || 500); }
      }
      this.audit("root-password-change", "verified", config.host, credentialStored);
      return { changed: true, verified: true, credentialStored, deploymentCredentialUpdateRequired: !credentialStored,
        message: credentialStored ? "Fresh SSH login verified; the new credential was saved encrypted in the internal ledger. No .env change is needed."
          : "Fresh SSH login verified. WARNING: the new credential is NOT stored in the vault. Open Database in Admin and enroll the new password before using stored-credential operations. No .env password is needed." };
    } catch (error) {
      this.audit("root-password-change", submitted ? "unverified-check-server" : "not-submitted", config.host);
      if (submitted) throw fail(502, "Password change could not be verified and may already have taken effect. Check access with the new password before retrying. Do not close your recovery session.");
      throw error;
    } finally { client?.end(); this.changing = false; }
  }
}
module.exports = { ServerUsers };
