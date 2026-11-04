const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('ssh2');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hosts } = require('./site-pages');
const { sshTarget } = require('../../database/ssh-target');
const { StringDecoder } = require('node:string_decoder');
const { ZipFile } = require('yazl');

const error = (status, message) => Object.assign(new Error(message), { status });
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
async function fileHash(file, bytes) {
  const digest = crypto.createHash('sha256');
  if (bytes !== 0) for await (const chunk of fs.createReadStream(file, bytes === undefined ? {} : { end: bytes - 1 })) digest.update(chunk);
  return digest.digest('hex');
}
async function remoteHash(deployment, client, remote, seconds) {
  let digest;
  await deployment.execute(client, `sha256sum < ${quote(remote)}`, '', seconds, undefined,
    line => { if (/^[a-f0-9]{64}\s+\*?-\s*$/.test(line)) digest = line.slice(0, 64); });
  if (!digest) throw error(409, 'Target did not return a file checksum.');
  return digest;
}
async function checkSpace(deployment, client, directory, bytes, seconds) {
  let available;
  await deployment.execute(client, `df -Pk ${quote(directory)} | tail -1 | awk '{print $4}'`, '', seconds, undefined,
    line => { if (/^\d+$/.test(line.trim())) available = Number(line.trim()) * 1024; });
  if (!Number.isSafeInteger(available)) throw error(409, 'Target free disk space could not be verified. No transfer started.');
  if (available < bytes) throw error(409, `Insufficient target disk space: need at least ${bytes} bytes, available ${available}. Retained files and backups were not deleted.`);
}
async function uploadFile({ deployment, client, sftp, file, remote, bytes, digest, target, report = () => {}, signal }) {
  const seconds = target.sshTimeoutSeconds || 20, timeout = target.deploymentTimeoutSeconds || 900;
  if (signal?.aborted) throw signal.reason;
  if (fs.statSync(file).size !== bytes || await fileHash(file) !== digest) throw error(409, 'Source file changed after review. No bytes were sent.');
  const attrs = await deployment.transfer(client, callback => sftp.lstat(remote, (err, stat) =>
    err?.code === 2 ? callback(null, null) : callback(err, stat)), seconds);
  const offset = attrs?.size || 0;
  if (attrs && (!attrs.isFile() || !Number.isSafeInteger(attrs.size) || attrs.size < 0 || attrs.size > bytes))
    throw error(409, 'Target partial file has an invalid type or size. Refusing to overwrite it.');
  if (attrs && await remoteHash(deployment, client, remote, timeout) !== await fileHash(file, offset))
    throw error(409, 'Target file prefix differs from the reviewed source. Refusing to append or overwrite.');
  report(offset);
  if (attrs && offset === bytes) return;
  const handle = await deployment.transfer(client, callback => sftp.open(remote, attrs ? 'r+' : 'wx', 0o600, callback), seconds);
  let position = offset, timer;
  const destination = new Writable({ write(chunk, _encoding, callback) {
    if (signal?.aborted) return callback(signal.reason);
    sftp.write(handle, chunk, 0, chunk.length, position, err => {
      if (destination.destroyed) return;
      if (!err) { position += chunk.length; reset(); report(position); }
      callback(err);
    });
  } });
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { destination.destroy(error(504, 'File upload stalled. Retry to continue from its verified prefix.')); client.end(); }, timeout * 1000);
  };
  try { reset(); await pipeline(fs.createReadStream(file, { start: offset, highWaterMark: 256 * 1024 }), destination); }
  finally {
    clearTimeout(timer);
    // Pausing closes the handle cleanly; every acknowledged block is a verified-resumable prefix.
    if (signal?.aborted) await deployment.transfer(client, callback => sftp.close(handle, callback), seconds).catch(() => {});
    else if (!destination.errored) await deployment.transfer(client, callback => sftp.close(handle, callback), seconds);
  }
  if (await remoteHash(deployment, client, remote, timeout) !== digest) throw error(409, 'Uploaded file checksum failed. Activation was not started.');
}
function redactServerLog(text, secrets = []) {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(authorization|cookie|set-cookie|password|token|secret|api[_-]?key)\s*[:=]\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
const installerSteps = {
  provision: 'Provisioning Node, Nginx and Certbot.',
  'apt-update': 'Refreshing operating-system package indexes.',
  'apt-install': 'Installing Nginx, Certbot and system prerequisites.',
  'node-repository': 'Configuring the signed Node 24 package repository.',
  'node-update': 'Refreshing Node package indexes.',
  'node-install': 'Installing Node 24.',
  'node-check': 'Verifying Node 24 or newer.',
  'private-data': 'Checking private storage. Existing installations require restored data; brand-new installations require empty directories.',
  extract: 'Verifying and extracting the release ZIP, then checking every reviewed file.',
  'legacy-env': 'Checking for an unmigrated shared .env. Migrate it into Settings before deployment.',
  'link-data': 'Linking the existing private data into the release.',
  dependencies: 'Installing locked dependencies.',
  initialize: 'Initializing new empty storage and external encryption key. Gold disabled; financial writers unconfigured.',
  'runtime-settings': 'Loading encrypted runtime Settings and checking financial reader modes.',
  'world-dependencies': 'Installing locked World dependencies.',
  build: 'Building World and exporting ABIs.',
  'pm2-install': 'Installing the PM2 process manager.',
  'nginx-existing': 'Checking existing Nginx configuration. Unmanaged configuration requires review before replacement.',
  nginx: 'Validating Nginx and hostname routing.',
  dns: 'Verifying DNS resolution for the assigned hostnames.',
  activate: 'Activating the release and restarting PM2.',
  'import-pages': 'Importing published CMS pages. Reusing existing managed sites or creating published-only sites when the registry is empty.',
  'import-registry-missing': 'The release contains managed sites, but the remote managed-site registry is missing. Restore their matching CMS registry and private site data before deploying. Do not initialize a replacement registry.',
  'import-registry-mismatch': 'The remote managed-site registry does not match the reviewed sites. Restore the matching registry and private site data before deploying.',
  'import-template': 'Published content references a template missing from this release. Review the source content and tracked templates before deploying.',
  'import-fresh-conflict': 'Fresh managed-site creation refused existing sites or data. Use normal deployment after a successful import; never overwrite existing state.',
  'pm2-start': 'Starting the release with PM2.',
  health: 'Checking release identity and assigned site responses.',
  'pm2-startup': 'Saving PM2 state and configuring service startup.',
  https: 'Configuring HTTPS certificates and automatic renewal.',
  verified: 'HTTPS checks completed.',
};
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
  let tracked;
  const inventory = path.join(root, '.deployment-source.json');
  if (!fs.existsSync(path.join(root, '.git')) && fs.existsSync(inventory)) {
    const stored = JSON.parse(fs.readFileSync(inventory, 'utf8'));
    if (!Array.isArray(stored.files) || stored.files.some(file => typeof file !== 'string')) throw error(503, 'Invalid deployed Git-tracked source inventory.');
    tracked = stored.files.join('\0');
  } else {
    try { tracked = execFileSync('git', ['-C', root, 'ls-files', '--cached', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
    catch { throw error(503, 'Git-tracked release inventory is unavailable. Deploy from a Git working tree or a reviewed release.'); }
  }
  const canonicalRoot = fs.realpathSync(root);
  return [...new Set(tracked.split('\0').filter(Boolean))].filter(file => {
    const parts = file.split('/');
    if ((!roots.has(parts[0]) && !names.has(file)) || parts.some(part =>
      ['data', 'node_modules', 'dist', 'backups', 'keys', 'secrets'].includes(part) || part.startsWith('.'))
      || /\.(?:pem|sqlite|key|env)$/i.test(file)) return false;
    const absolute = path.resolve(root, ...parts);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw error(400, 'Invalid tracked release path.');
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (!fs.realpathSync(absolute).startsWith(canonicalRoot + path.sep)) throw error(400, 'Tracked release files cannot traverse linked directories.');
      return true;
    }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }).sort();
}
const digestFiles = (root, files) => {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  for (const file of files) {
    hash.update(file).update('\0');
    const fd = fs.openSync(path.join(root, ...file.split('/')), 'r');
    try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
    finally { fs.closeSync(fd); }
  }
  return hash.digest('hex');
};
async function prepareRelease(root, files, content, prepared) {
  const transfers = [];
  for (const name of files) {
    const source = path.join(root, ...name.split('/')), file = path.join(prepared, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (name.endsWith('.sh')) fs.writeFileSync(file, fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n'), { mode: 0o600 });
    else { fs.copyFileSync(source, file); fs.chmodSync(file, 0o600); }
    transfers.push({ name, file, bytes: fs.statSync(file).size, hash: await fileHash(file) });
  }
  for (const [name, text] of [['.cms-published.json', content], ['.deployment-source.json', JSON.stringify({ files })]]) {
    const file = path.join(prepared, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    transfers.push({ name, file, bytes: Buffer.byteLength(text), hash: await fileHash(file) });
  }
  const manifest = path.join(prepared, '.deployment-files.json');
  fs.writeFileSync(manifest, JSON.stringify(transfers.map(({ name, bytes, hash }) => ({ name, bytes, hash }))), { mode: 0o600 });
  transfers.push({ name: '.deployment-files.json', file: manifest, bytes: fs.statSync(manifest).size, hash: await fileHash(manifest) });
  const zip = new ZipFile(), archive = path.join(prepared, 'release.zip');
  const output = pipeline(zip.outputStream, fs.createWriteStream(archive, { mode: 0o600 }));
  for (const entry of transfers) zip.addFile(entry.file, entry.name, { mtime: new Date('2000-01-01T00:00:00Z'), mode: 0o100600 });
  zip.end();
  await output;
  return { file: archive, bytes: fs.statSync(archive).size, hash: await fileHash(archive),
    expandedBytes: transfers.reduce((sum, entry) => sum + entry.bytes, 0),
    installer: transfers.find(entry => entry.name === 'scripts/deploy-release.sh') };
}
class Deployment {
  constructor({ root, env = require("../../operations/runtime").environment(), settings, clientFactory = () => new Client(), snapshot = () => ({ integrated: [], managed: [] }), hostnames = () => hosts, sites,
    stateDirectory = path.join(root, 'data', 'deployment') }) {
    this.root = root; this.env = env; this.clientFactory = clientFactory;
    this.settings = settings;
    this.vault = settings;
    this.snapshot = snapshot;
    this.hostnames = hostnames;
    this.sites = sites || (() => this.hostnames().map(hostname => ({ key: hostname, hostname })));
    this.plans = new Map(); this.running = false; this.result = null; this.logs = [];
    this.stateDirectory = stateDirectory;
    this.statusFile = path.join(stateDirectory, 'status.json');
    if (fs.existsSync(this.statusFile)) {
      const previous = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
      this.logs = Array.isArray(previous.logs) ? previous.logs.slice(-200) : [];
      if (typeof previous.running !== 'boolean' || !Object.hasOwn(previous, 'result')) throw new Error('Invalid saved deployment status');
      this.result = previous.running ? { ...previous.result, success: false, error: 'The CMS restarted during a deployment. The remote systemd job may still be running; inspect each target log/status before retrying.' } : previous.result;
    }
  }
  plan(input = {}) {
    if (this.selfDeployment?.active()) throw error(409, 'Wait for the current self-sync job.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(400, 'Deployment plan options must be an object.');
    if (input.initialize !== undefined || input.freshManagedSites !== undefined) throw error(400, 'Installation is detected automatically. Reload Admin and review a new plan.');
    const config = this.settings ? this.settings.configuration() : this.vault && !this.env.DEPLOY_PASSWORD && !this.env.DEPLOY_KEY_FILE
      ? { ...this.vault.configuration(), email: this.env.DEPLOY_TLS_EMAIL } : configuration(this.env);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email || '')) throw error(400, 'Set a certificate registration email in Admin Settings.');
    const files = releaseFiles(this.root);
    const required = ['scripts/deploy-release.sh', 'scripts/serve.js', 'scripts/init-settings.js', 'package.json', 'ecosystem.config.cjs',
      'services/cms/lib/admin-auth.js', 'sites/admin.featheral.com/login.html', 'sites/admin.featheral.com/js/login.js'];
    const missing = required.filter(file => !files.includes(file));
    if (missing.length) throw error(400, `The Git-tracked release is missing required startup files: ${missing.join(', ')}. Track these application source files before deploying.`);
    const digest = digestFiles(this.root, files);
    const content = JSON.stringify(this.snapshot());
    const contentDigest = crypto.createHash('sha256').update(content).digest('hex');
    const domains = [...new Set(this.hostnames())];
    if (!domains.length || domains.some(host => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))) throw error(400, 'Deployment requires valid public hostnames');
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const targets = this.settings ? this.settings.deploymentTargets(this.sites()) : [{ id: 'shared', ...config, hosts: domains, urls: [] }];
    if (JSON.stringify([...new Set(targets.flatMap(target => target.hosts))].sort()) !== JSON.stringify([...domains].sort()))
      throw error(400, 'Deployment targets must cover every site hostname.');
    const targetDigest = crypto.createHash('sha256').update(JSON.stringify(targets)).digest('hex');
    this.plans.clear();
    this.plans.set(id, { config, files, digest, content, contentDigest, domains, createdAt, targets, targetDigest });
    return { id, digest, contentDigest, expiresAt: createdAt + 10 * 60_000, target: `${config.username}@${config.host}:${config.directory}`,
      targetDigest, targets: targets.map(({ password, keyFile, ...target }) => target),
      files: files.length, hosts: domains, enabled: this.settings ? this.settings.value.enabled : this.env.DEPLOY_ENABLED === 'true', walletApprovalRequired: Boolean(config.vault),
      ...(this.settings ? { settingsRevision: config.settingsRevision, uploadLimitMiB: config.uploadLimitMiB, requestTimeoutSeconds: config.requestTimeoutSeconds, deploymentTimeoutSeconds: config.deploymentTimeoutSeconds } : {}),
      steps: ['Compress reviewed Git-tracked source and published CMS metadata into a ZIP before upload. Verify its SHA256 and every extracted file. Retry resumes the verified ZIP prefix.',
        'Database/media replication remains a separately reviewed Site Sync: database entries transfer and verify first, then uploads. Complete required replica sync before activating dependent sites.',
        'Use each server’s own SSH credential; configure Nginx/HTTPS only for the hostnames assigned to that server. Point their DNS A/AAAA records to that server before deployment.',
        'Deploy separate servers first and the shared administration server last. A DB-only target runs no financial writers or other site services.',
        'Keep encrypted Settings, external bootstrap, signing keys, ledgers, media and CMS databases outside releases; never put them in Git.',
        'Automatically reuse existing storage and encryption keys. Only an empty shared Admin server is initialized; Gold stays disabled and financial writers unconfigured. Separate full-stack servers require restored data. Never replace existing private data.',
        'Automatically reuse the managed-site registry. If empty or absent, create published-only sites without source ownership, balances, rewards, uploads or history; conflicting data folders are refused. Media links may require replacement.',
        'Install locked dependencies; build World and export ABIs.',
        'Provision Node 24, PM2, Nginx and Certbot on Ubuntu/Debian using the verified SSH/sudo credential.',
        'Validate Nginx, apply upload/timeout limits, switch release, reload PM2, configure HTTPS and enable certificate renewal.',
        'Health-check all sites; restore the previous code release on failure without rolling back monetary data.'] };
  }
  status() { return { running: this.running, result: this.result, logs: this.logs }; }
  log(message) {
    this.logs.push({ at: Date.now(), message });
    if (this.logs.length > 200) this.logs.shift();
    this.persistStatus();
  }
  persistStatus() {
    fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
    const temporary = this.statusFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.status()), { mode: 0o600 });
    fs.renameSync(temporary, this.statusFile);
  }
  validate(input) {
    if (!(this.settings ? this.settings.value.enabled : this.env.DEPLOY_ENABLED === 'true')) throw error(403, 'Deployment is disabled. Review and enable deployment in Admin Settings.');
    if (this.settings?.busy) throw error(409, 'Wait for the Settings operation.');
    if (this.running || this.siteSync?.running || this.selfDeployment?.active()) throw error(409, 'Another deployment or site sync is running');
    const plan = this.plans.get(input?.planId);
    if (!plan || Date.now() - plan.createdAt > 10 * 60_000) throw error(400, 'Deployment plan expired or unavailable. Review a new plan.');
    if (input?.approval !== `DEPLOY ${plan.digest} ${plan.contentDigest}`) throw error(400, 'Enter the exact approval phrase from the reviewed deployment plan.');
    if (digestFiles(this.root, releaseFiles(this.root)) !== plan.digest) throw error(409, 'Source changed after the plan. Generate and review a new plan.');
    if (JSON.stringify(this.snapshot()) !== plan.content) throw error(409, 'CMS content changed after the plan. Generate a new plan.');
    if (JSON.stringify([...new Set(this.hostnames())]) !== JSON.stringify(plan.domains)) throw error(409, 'The site list changed after the plan. Generate a new plan.');
    if (plan.config.vault) {
      const current = this.vault.configuration();
      if (['username', 'host', 'directory', 'port', 'fingerprint', 'settingsRevision'].some(key => current[key] !== plan.config[key]))
        throw error(409, 'The vault SSH target changed after the plan. Generate a new plan.');
    }
    if (this.settings && crypto.createHash('sha256').update(JSON.stringify(this.settings.deploymentTargets(this.sites()))).digest('hex') !== plan.targetDigest)
      throw error(409, 'Site server assignments changed after review. Generate a new plan.');
    return plan;
  }
  approvalChallenge(input, context) {
    const plan = this.validate(input);
    if (!plan.config.vault) throw error(400, 'This deployment does not use a stored credential.');
    const binding = { planId: input.planId, digest: plan.digest, contentDigest: plan.contentDigest, ...(this.settings ? { targetDigest: plan.targetDigest } : {}), installation: 'auto' };
    return this.settings ? this.settings.challengeDeployment(binding, context, this.sites())
      : this.vault.challengeUse('DEPLOY REVIEWED RELEASE', binding, context);
  }
  launch(input, context) {
    const plan = this.validate(input);
    const binding = { planId: input.planId, digest: plan.digest, contentDigest: plan.contentDigest, ...(this.settings ? { targetDigest: plan.targetDigest } : {}), installation: 'auto' };
    const credential = this.settings ? this.settings.useDeployment(binding, context, input, this.sites())
      : plan.config.vault ? this.vault.use('DEPLOY REVIEWED RELEASE', binding, context, input) : null;
    void this.start(input, credential).catch(err => console.error('CMS deployment job rejected:', err.status || err.name));
    return this.status();
  }
  async connect(config) {
    const client = this.clientFactory();
    let observedFingerprint;
    try { await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject);
      client.connect({ host: config.host, port: config.port, username: config.username,
        ...(config.keyFile ? { privateKey: fs.readFileSync(config.keyFile) } : { password: config.password }),
        readyTimeout: (config.sshTimeoutSeconds || 15) * 1000,
        hostVerifier: key => {
          const actual = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          if (!config.fingerprint && config.trustOnFirstUse) { observedFingerprint = actual; return true; }
          return actual === config.fingerprint;
        } });
    }); } catch (err) { client.end(); throw err; }
    if (observedFingerprint) config.fingerprint = observedFingerprint;
    return client;
  }
  async execute(client, command, input = "", timeoutSeconds = 900, onPhase, onLog) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.end(); reject(error(504, 'Remote deployment timed out; inspect the server log before retrying.')); }, timeoutSeconds * 1000);
      client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      let failure;
      const reader = () => {
        const decoder = new StringDecoder('utf8');
        let output = '', dropping = false, privateKey = false;
        const lineReceived = line => {
          line = line.replace(/\r$/, '');
          if (privateKey) {
            if (/-----END [^-]*PRIVATE KEY-----/.test(line)) privateKey = false;
            return;
          }
          if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(line)) {
            privateKey = !/-----END [^-]*PRIVATE KEY-----/.test(line);
            onLog?.('[REDACTED PRIVATE KEY]');
            return;
          }
          const match = /^FEATHERAL_PHASE:([a-z-]+)$/.exec(line);
          if (match && Object.hasOwn(installerSteps, match[1])) { onPhase?.(match[1]); return; }
          const failed = /^FEATHERAL_FAILURE:([a-z-]+):([0-9]{1,3})$/.exec(line);
          if (!failure && failed && Object.hasOwn(installerSteps, failed[1]) && Number(failed[2]) > 0 && Number(failed[2]) <= 255) {
            failure = `Installer failed at ${failed[1]} (exit ${Number(failed[2])}). ${installerSteps[failed[1]]}`;
            onPhase?.(failed[1], Number(failed[2]));
          }
          if (!failed && line && !line.startsWith('FEATHERAL_PHASE:')) onLog?.(line);
        };
        const receive = text => {
          for (const part of text.split(/(?<=\n)/)) {
            const ended = part.endsWith('\n');
            if (!dropping) output += part;
            if (output.length > 65536) {
              onLog?.('[Deployment log line omitted: exceeds 64 KiB.]');
              output = ''; dropping = true;
            }
            if (ended) {
              if (!dropping) lineReceived(output.slice(0, -1));
              output = ''; dropping = false;
            }
          }
        };
        return { data: chunk => receive(decoder.write(chunk)), end: () => { receive(decoder.end()); if (output) lineReceived(output); } };
      };
      const stdout = reader(), stderr = reader();
      stream.on('data', stdout.data);
      stream.stderr.on('data', stderr.data);
      stream.once('error', err => { clearTimeout(timeout); reject(err); });
      stream.once('close', code => {
        clearTimeout(timeout);
        stdout.end(); stderr.end();
        if (code === 0 && !failure) return resolve();
        const err = error(502, failure || `Remote deployment command failed (exit ${code ?? 'unknown'}). Check the server deployment log.`);
        if (failure) err.publicMessage = failure;
        reject(err);
      });
      if (typeof stream.end === 'function') stream.end(input);
    }); });
  }
  async start(input, credential) {
    const plan = this.validate(input);
    const credentials = Array.isArray(credential) ? credential : [{ ...plan.config, id: 'shared', password: credential?.password || plan.config.password }];
    if (plan.config.vault && plan.targets.some(target => !credentials.find(item => item.id === target.id)?.password))
      throw error(403, 'Origin-wallet approval is required for every deployment target.');
    this.plans.delete(input.planId); this.running = true; this.result = null; this.logs = [];
    const temporary = this.stateDirectory;
    const prepared = path.join(temporary, crypto.randomUUID());
    const results = [];
    try {
      fs.mkdirSync(temporary, { recursive: true });
      fs.mkdirSync(prepared, { mode: 0o700 });
      this.log('Compressing reviewed source and published metadata into a release ZIP before upload.');
      const archive = await prepareRelease(this.root, plan.files, plan.content, prepared);
      if (digestFiles(this.root, plan.files) !== plan.digest) throw error(409, 'Source changed while preparing the release ZIP. Review a new plan.');
      this.log(`Release ZIP ready: ${archive.bytes} compressed bytes; ${archive.expandedBytes} extracted bytes.`);
      const releaseId = `release-${Date.now()}-${archive.hash.slice(0, 12)}`;
      const targets = [...plan.targets].sort((a, b) => Number(a.id === 'shared') - Number(b.id === 'shared'));
      for (const target of targets) {
        this.result = { success: false, targets: results, currentTarget: target.host, message: 'Deployment in progress; not yet verified.' };
        this.persistStatus();
        try {
          await this.deployTarget(target, credentials.find(item => item.id === target.id), archive, releaseId);
          results.push({ host: target.host, hosts: target.hosts, success: true });
          this.log(`${target.host}: deployment and HTTPS health checks verified.`);
        } catch (err) {
          results.push({ host: target.host, hosts: target.hosts, success: false, ...(err.publicMessage ? { error: err.publicMessage } : {}) });
          if (!err.publicMessage) this.log(`${target.host}: deployment failed; inspect the private server log before retrying.`);
          throw err;
        }
      }
      this.result = { success: true, digest: plan.digest, targets: results, completedAt: Date.now() };
      this.log('All deployment targets verified successfully.');
      return this.result;
    } catch (err) {
      this.result = { success: false, targets: results, completedAt: Date.now(), error: `${err.publicMessage || 'Deployment failed; inspect each target result and its remote deployment log.'} Verified servers are not rolled back across servers.` };
      this.log(`Deployment stopped (${err.status || 502}). Verified servers have not been rolled back across servers.`);
      console.error('CMS deployment failed:', err.code || err.status || err.name);
      throw error(err.status || 502, this.result.error);
    } finally {
      for (const item of credentials) item.password = '';
      if (credential && !Array.isArray(credential)) credential.password = '';
      if (fs.existsSync(prepared)) fs.rmSync(prepared, { recursive: true });
      this.running = false;
      this.persistStatus();
    }
  }
  async deployTarget(config, credential, archive, releaseId) {
    if (this.siteSync?.running) throw error(409, 'Wait for the current site sync.');
    let client;
    try {
      this.log(`${config.host}: connecting to SSH with the saved credential and pinned server key.`);
      client = await this.connect(config.vault ? { ...config, password: credential.password } : config);
      const remote = `${config.directory}/shared/deployment/${archive.hash}`;
      await this.execute(client, `mkdir -p ${quote(remote)} && rm -f ${quote(remote + '/cleanup-complete.json')}`, "", config.sshTimeoutSeconds || 20);
      await checkSpace(this, client, remote, archive.bytes + archive.expandedBytes + 512 * 1024 * 1024, config.sshTimeoutSeconds || 20);
      const sftp = await this.transfer(client, callback => client.sftp(callback), config.sshTimeoutSeconds || 20);
      this.log(`${config.host}: uploading the compressed release ZIP and installer. Verified partial uploads are resumed.`);
      try {
        for (const entry of [{ ...archive, name: 'release.zip' }, { ...archive.installer, name: 'deploy-release.sh' }]) {
          await uploadFile({ deployment: this, client, sftp, file: entry.file, remote: `${remote}/${entry.name}`, bytes: entry.bytes, digest: entry.hash, target: config });
          this.log(`${config.host}: checksum verified: ${entry.name}`);
        }
      } finally { sftp.end(); }
      this.log(`${config.host}: running setup, build, PM2, Nginx, certificates and health checks. Server output follows (credentials redacted).`);
      const secrets = [config.password, credential?.password, this.env.DEPLOY_PASSWORD,
        this.settings?.value.credential?.password,
        ...Object.values(this.settings?.value.siteServers || {}).map(profile => profile.credential?.password),
        ...require('../../operations/configuration').fields.filter(field => field.secret).flatMap(field => [this.settings?.value.runtime?.[field.name], this.env[field.name]])];
      const onLog = line => this.log(`${config.host}: ${redactServerLog(line, secrets)}`);
      const job = `systemd-run --wait --pipe --collect --unit=featheral-deployment --uid="$(id -u)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" /bin/bash ${quote(remote + '/deploy-release.sh')} ${quote(config.directory)} ${quote(releaseId)} ${quote(config.email)} ${quote(config.hosts.join(' '))} ${quote(config.uploadLimitMiB || 16)} ${quote(config.requestTimeoutSeconds || 90)} ${quote(config.id === 'shared')} ${quote(remote + '/release.zip')} ${quote(archive.hash)}`;
      if (this.settings) {
        const command = `IFS= read -r password; if [ "$(id -u)" = 0 ]; then printf '%s\\n' "$password" | ${job}; else printf '%s\\n' "$password" | sudo -S -p '' -v && printf '%s\\n' "$password" | sudo -n ${job}; fi`;
        await this.execute(client, command, credential.password + '\n', config.deploymentTimeoutSeconds, (phase, exitCode) => this.logPhase(config.host, phase, exitCode), onLog);
      } else await this.execute(client, `sudo -n ${job}`, "", 900, (phase, exitCode) => this.logPhase(config.host, phase, exitCode), onLog);
    } finally { client?.end(); }
  }
  logPhase(host, phase, exitCode) {
    if (Object.hasOwn(installerSteps, phase)) this.log(`${host}: ${exitCode ? `Installer failed at ${phase} (exit ${exitCode}). ` : ''}${installerSteps[phase]}`);
  }
  transfer(client, operation, seconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.end(); reject(error(504, 'SFTP transfer timed out. Inspect the target before retrying.')); }, seconds * 1000);
      try { operation((err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); }); }
      catch (err) { clearTimeout(timer); reject(err); }
    });
  }
}
module.exports = { Deployment, configuration, sshConfiguration, sshTarget, releaseFiles, digestFiles, prepareRelease, redactServerLog, uploadFile, fileHash, checkSpace };
