const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Client } = require('ssh2');
const yazl = require('yazl');
const { hosts } = require('./site-pages');
const { sshTarget } = require('../../database/ssh-target');

const error = (status, message) => Object.assign(new Error(message), { status });
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function sshConfiguration(env) {
  const target = sshTarget(env);
  const password = env.DEPLOY_PASSWORD || '';
  const keyFile = env.DEPLOY_KEY_FILE || '';
  if (Boolean(password) === Boolean(keyFile)) throw error(400, 'Enroll the encrypted credential in Admin, or configure exactly one SSH authentication method (DEPLOY_KEY_FILE or legacy DEPLOY_PASSWORD).');
  if (keyFile && !path.isAbsolute(keyFile)) throw error(400, 'Set DEPLOY_KEY_FILE to an absolute server-side SSH private-key path');
  return { ...target, keyFile, password };
}
function configuration(env) {
  const config = sshConfiguration(env);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.DEPLOY_TLS_EMAIL || '')) throw error(400, 'Set DEPLOY_TLS_EMAIL for HTTPS certificate registration');
  return { ...config, email: env.DEPLOY_TLS_EMAIL };
}
function releaseFiles(root) {
  const roots = new Set(['sites', 'shared', 'services', 'scripts', 'contracts']);
  const names = new Set(['package.json', 'package-lock.json', 'hardhat.config.js', 'ecosystem.config.cjs']);
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['data', 'node_modules', 'dist', '.git', 'backups', '.ssh', 'keys', 'secrets'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && /\.(js|cjs|mjs|ts|json|css|html|md|svg|png|jpe?g|webp|gif|ico|txt|xml|webmanifest|sol|sh|woff2?|ttf|yaml|yml)$/i.test(entry.name)) files.push(relative);
    }
  };
  for (const directory of roots) walk(path.join(root, directory), directory + '/');
  for (const name of names) if (fs.existsSync(path.join(root, name))) files.push(name);
  return files.sort();
}
const digestFiles = (root, files) => {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(fs.readFileSync(path.join(root, ...file.split('/'))));
  return hash.digest('hex');
};
class Deployment {
  constructor({ root, env = require("../../operations/runtime").environment(), settings, clientFactory = () => new Client(), snapshot = () => ({ integrated: [], managed: [] }), hostnames = () => hosts,
    stateDirectory = path.join(root, 'data', 'deployment') }) {
    this.root = root; this.env = env; this.clientFactory = clientFactory;
    this.settings = settings;
    this.vault = settings;
    this.snapshot = snapshot;
    this.hostnames = hostnames;
    this.plans = new Map(); this.running = false; this.result = null;
    this.stateDirectory = stateDirectory;
    this.statusFile = path.join(stateDirectory, 'status.json');
    if (fs.existsSync(this.statusFile)) {
      const previous = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
      if (typeof previous.running !== 'boolean' || !Object.hasOwn(previous, 'result')) throw new Error('Invalid saved deployment status');
      this.result = previous.running ? { success: false, error: 'The CMS restarted during a deployment. The remote systemd job may still be running; inspect its log/status before retrying.' } : previous.result;
    }
  }
  plan() {
    const config = this.settings ? this.settings.configuration() : this.vault && !this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE
      ? { ...this.vault.configuration(), email: this.env.DEPLOY_TLS_EMAIL } : configuration(this.env);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email || '')) throw error(400, 'Set a certificate registration email in Admin Settings.');
    const files = releaseFiles(this.root);
    const digest = digestFiles(this.root, files);
    const content = JSON.stringify(this.snapshot());
    const contentDigest = crypto.createHash('sha256').update(content).digest('hex');
    const domains = [...new Set(this.hostnames())];
    if (!domains.length || domains.some(host => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))) throw error(400, 'Deployment requires valid public hostnames');
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.plans.clear();
    this.plans.set(id, { config, files, digest, content, contentDigest, domains, createdAt });
    return { id, digest, contentDigest, expiresAt: createdAt + 10 * 60_000, target: `${config.username}@${config.host}:${config.directory}`,
      files: files.length, hosts: domains, enabled: this.settings ? this.settings.value.enabled : this.env.DEPLOY_ENABLED === 'true', walletApprovalRequired: Boolean(config.vault),
      ...(this.settings ? { settingsRevision: config.settingsRevision, uploadLimitMiB: config.uploadLimitMiB, requestTimeoutSeconds: config.requestTimeoutSeconds, deploymentTimeoutSeconds: config.deploymentTimeoutSeconds } : {}),
      steps: ['Upload current local source and published CMS pages/themes by SFTP (not just committed files).',
        'Keep encrypted Settings, external bootstrap, signing keys, ledgers, media and CMS databases outside releases; never put them in Git.',
        'Require pre-provisioned private data, encrypted Settings and external bootstrap for the first deployment; do not create a new economy.',
        'Install locked dependencies; build World and export ABIs.',
        'Provision Node 24, PM2, Nginx and Certbot on Ubuntu/Debian using the verified SSH/sudo credential.',
        'Validate Nginx, apply upload/timeout limits, switch release, reload PM2, configure HTTPS and enable certificate renewal.',
        'Health-check all sites; restore the previous code release on failure without rolling back monetary data.'] };
  }
  status() { return { running: this.running, result: this.result }; }
  persistStatus() {
    fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
    const temporary = this.statusFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.status()), { mode: 0o600 });
    fs.renameSync(temporary, this.statusFile);
  }
  validate(input) {
    if (!(this.settings ? this.settings.value.enabled : this.env.DEPLOY_ENABLED === 'true')) throw error(403, 'Deployment is disabled. Review and enable deployment in Admin Settings.');
    if (this.settings?.busy) throw error(409, 'Wait for the Settings operation.');
    if (this.running) throw error(409, 'Another deployment is running');
    const plan = this.plans.get(input?.planId);
    if (!plan || Date.now() - plan.createdAt > 10 * 60_000 || input?.approval !== `DEPLOY ${plan.digest} ${plan.contentDigest}`) throw error(400, 'Review a fresh plan and provide its exact approval phrase');
    if (digestFiles(this.root, releaseFiles(this.root)) !== plan.digest) throw error(409, 'Source changed after the plan. Generate and review a new plan.');
    if (JSON.stringify(this.snapshot()) !== plan.content) throw error(409, 'CMS content changed after the plan. Generate a new plan.');
    if (JSON.stringify([...new Set(this.hostnames())]) !== JSON.stringify(plan.domains)) throw error(409, 'The site list changed after the plan. Generate a new plan.');
    if (plan.config.vault) {
      const current = this.vault.configuration();
      if (['username', 'host', 'directory', 'port', 'fingerprint', 'settingsRevision'].some(key => current[key] !== plan.config[key]))
        throw error(409, 'The vault SSH target changed after the plan. Generate a new plan.');
    }
    return plan;
  }
  approvalChallenge(input, context) {
    const plan = this.validate(input);
    if (!plan.config.vault) throw error(400, 'This deployment does not use a stored credential.');
    return this.vault.challengeUse('DEPLOY REVIEWED RELEASE', { planId: input.planId, digest: plan.digest, contentDigest: plan.contentDigest }, context);
  }
  launch(input, context) {
    const plan = this.validate(input);
    const credential = plan.config.vault ? this.vault.use('DEPLOY REVIEWED RELEASE',
      { planId: input.planId, digest: plan.digest, contentDigest: plan.contentDigest }, context, input) : null;
    void this.start(input, credential).catch(err => console.error('CMS deployment job rejected:', err.status || err.name));
    return this.status();
  }
  async connect(config) {
    const client = this.clientFactory();
    try { await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject);
      client.connect({ host: config.host, port: config.port, username: config.username,
        ...(config.keyFile ? { privateKey: fs.readFileSync(config.keyFile) } : { password: config.password }),
        readyTimeout: (config.sshTimeoutSeconds || 15) * 1000,
        hostVerifier: key => {
          const actual = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          return actual === config.fingerprint;
        } });
    }); } catch (err) { client.end(); throw err; }
    return client;
  }
  async execute(client, command, input = "", timeoutSeconds = 900) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.end(); reject(error(504, 'Remote deployment timed out; inspect the server log before retrying.')); }, timeoutSeconds * 1000);
      client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      // Remote output may contain environment values. Do not return it to browsers.
      stream.on('data', () => {}); stream.stderr.on('data', () => {});
      stream.once('error', err => { clearTimeout(timeout); reject(err); });
      stream.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(error(502, `Remote deployment command failed (exit ${code ?? 'unknown'}). Check the server deployment log.`)); });
      if (typeof stream.end === 'function') stream.end(input);
    }); });
  }
  async start(input, credential) {
    const plan = this.validate(input);
    if (plan.config.vault && !credential?.password) throw error(403, 'Origin-wallet approval is required to use the stored deployment credential.');
    this.plans.delete(input.planId); this.running = true; this.result = null;
    const temporary = this.stateDirectory;
    const archive = path.join(temporary, `${crypto.randomUUID()}.zip`);
    const bootstrap = archive + '.sh';
    let client;
    try {
      fs.mkdirSync(temporary, { recursive: true });
      this.persistStatus();
      const zip = new yazl.ZipFile();
      const captured = crypto.createHash('sha256');
      for (const file of plan.files) {
        const buffer = fs.readFileSync(path.join(this.root, ...file.split('/')));
        captured.update(file).update('\0').update(buffer);
        zip.addBuffer(buffer, file);
        if (file === 'scripts/deploy-release.sh') fs.writeFileSync(bootstrap, buffer, { mode: 0o600 });
      }
      if (captured.digest('hex') !== plan.digest) throw error(409, 'Source changed while preparing the archive. Review a new plan.');
      zip.addBuffer(Buffer.from(plan.content), '.cms-published.json');
      const writing = pipeline(zip.outputStream, fs.createWriteStream(archive, { mode: 0o600 }));
      zip.end(); await writing;
      client = await this.connect(plan.config.vault ? { ...plan.config, password: credential.password } : plan.config);
      const releaseId = `release-${Date.now()}-${plan.digest.slice(0, 12)}`;
      const remote = `${plan.config.directory}/releases/${releaseId}`;
      await this.execute(client, `mkdir -p ${quote(remote)}`, "", plan.config.sshTimeoutSeconds || 20);
      const sftp = await this.transfer(client, callback => client.sftp(callback), plan.config.sshTimeoutSeconds || 20);
      try {
        await this.transfer(client, callback => sftp.fastPut(archive, `${remote}/release.zip`, callback), plan.config.deploymentTimeoutSeconds || 900);
        await this.transfer(client, callback => sftp.fastPut(bootstrap, `${remote}/deploy-release.sh`, callback), plan.config.sshTimeoutSeconds || 20);
      } finally { sftp.end(); }
      if (this.settings) {
        const job = `systemd-run --wait --pipe --collect --unit=featheral-deployment --uid="$(id -u)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" /bin/bash ${quote(remote + '/deploy-release.sh')} ${quote(plan.config.directory)} ${quote(releaseId)} ${quote(plan.config.email)} ${quote(plan.domains.join(' '))} ${quote(plan.config.uploadLimitMiB)} ${quote(plan.config.requestTimeoutSeconds)}`;
        const command = `IFS= read -r password; if [ "$(id -u)" = 0 ]; then printf '%s\\n' "$password" | ${job}; else printf '%s\\n' "$password" | sudo -S -p '' -v && printf '%s\\n' "$password" | sudo -n ${job}; fi`;
        await this.execute(client, command,
          credential.password + '\n', plan.config.deploymentTimeoutSeconds);
      } else {
        await this.execute(client, `sudo -n systemd-run --wait --pipe --collect --unit=featheral-deployment --uid="$(id -u)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" /bin/bash ${quote(remote + '/deploy-release.sh')} ${quote(plan.config.directory)} ${quote(releaseId)} ${quote(plan.config.email)} ${quote(plan.domains.join(' '))}`);
      }
      this.result = { success: true, digest: plan.digest, completedAt: Date.now() };
      return this.result;
    } catch (err) {
      this.result = { success: false, completedAt: Date.now(), error: 'Deployment failed; inspect the remote deployment log. No success is assumed.' };
      console.error('CMS deployment failed:', err.code || err.status || err.name);
      throw error(err.status || 502, this.result.error);
    } finally {
      client?.end();
      if (credential) credential.password = '';
      fs.rmSync(archive, { force: true });
      fs.rmSync(bootstrap, { force: true });
      this.running = false;
      this.persistStatus();
    }
  }
  transfer(client, operation, seconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.end(); reject(error(504, 'SFTP transfer timed out. Inspect the target before retrying.')); }, seconds * 1000);
      try { operation((err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); }); }
      catch (err) { clearTimeout(timer); reject(err); }
    });
  }
}
module.exports = { Deployment, configuration, sshConfiguration, sshTarget, releaseFiles, digestFiles };
