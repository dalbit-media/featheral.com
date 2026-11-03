const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Deployment, configuration, releaseFiles } = require('../lib/deployment');
const root = path.resolve(__dirname, '..', '..', '..');
const env = { DEPLOY_TARGET: 'featheral@server.example:/opt/featheral', DEPLOY_KEY_FILE: path.resolve('unused-test-key'),
  DEPLOY_HOST_KEY_SHA256: 'SHA256:' + 'a'.repeat(43), DEPLOY_TLS_EMAIL: 'ops@example.com' };
test('deployment console persists bounded progress and accepts only fixed installer phases, never raw server output', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-console-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const deployment = new Deployment({ root, env, stateDirectory });
  const client = { end() {}, exec(_command, callback) {
    const stream = new EventEmitter(); stream.stderr = new EventEmitter();
    stream.end = () => {
      stream.emit('data', Buffer.from('private password=do-not-expose\nFEATHERAL_PHA'));
      stream.emit('data', Buffer.from('SE:build\nFEATHERAL_PHASE:private-secret\n'));
      stream.stderr.emit('data', Buffer.from('private signing key'));
      stream.emit('close', 0);
    };
    callback(null, stream);
  } };
  await deployment.execute(client, 'fixture', '', 1, phase => deployment.logPhase('server.example', phase));
  assert.equal(deployment.status().logs.length, 1);
  assert.match(deployment.status().logs[0].message, /Building World/);
  assert.doesNotMatch(JSON.stringify(deployment.status()), /do-not-expose|private-secret|signing key/);
  assert.deepEqual(new Deployment({ root, env, stateDirectory }).status().logs, deployment.status().logs);
  for (let i = 0; i < 205; i++) deployment.log('Verified progress event');
  assert.equal(deployment.status().logs.length, 200);
});
test('installer failures stream safe step diagnostics and persist the failed target reason', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-failure-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const deployment = new Deployment({ root, env: { ...env, DEPLOY_ENABLED: 'true' }, stateDirectory });
  const client = { end() {}, exec(_command, callback) {
    const stream = new EventEmitter(); stream.stderr = new EventEmitter();
    stream.end = () => {
      stream.emit('data', Buffer.from('FEATHERAL_PHASE:apt-update\nprivate command output\nFEATHERAL_FAILURE:private-secret:1\nFEATHERAL_FAILURE:apt-update:'));
      stream.emit('data', Buffer.from('100\n'));
      assert.ok(deployment.status().logs.some(entry => entry.message.includes('Installer failed at apt-update (exit 100)')), 'failure streams before the remote command closes');
      stream.stderr.emit('data', Buffer.from('private password'));
      stream.emit('close', 100);
    };
    callback(null, stream);
  } };
  deployment.deployTarget = target => deployment.execute(client, 'fixture', '', 1, (phase, exitCode) => deployment.logPhase(target.host, phase, exitCode));
  const plan = deployment.plan();
  await assert.rejects(deployment.start({ planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` }),
    { status: 502, message: /Installer failed at apt-update \(exit 100\)/ });
  const status = deployment.status();
  assert.equal(status.running, false);
  assert.match(status.result.targets[0].error, /Refreshing operating-system package indexes/);
  assert.match(status.result.error, /apt-update/);
  assert.ok(status.logs.some(entry => entry.message.includes('Installer failed at apt-update (exit 100)')));
  assert.doesNotMatch(JSON.stringify(status), /private-secret|private command|private password/);
  assert.deepEqual(new Deployment({ root, env, stateDirectory }).status(), status);
});
test('specific import failure survives the shell generic failure marker without duplicated console output', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-import-error-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const deployment = new Deployment({ root, env, stateDirectory });
  const client = { end() {}, exec(_command, callback) {
    const stream = new EventEmitter(); stream.stderr = new EventEmitter();
    stream.end = () => {
      stream.emit('data', Buffer.from('FEATHERAL_FAILURE:import-registry-missing:1\nFEATHERAL_FAILURE:import-pages:1\n'));
      stream.emit('close', 1);
    };
    callback(null, stream);
  } };
  await assert.rejects(deployment.execute(client, 'fixture', '', 1,
    (phase, exitCode) => deployment.logPhase('featheral.com', phase, exitCode)),
    { status: 502, publicMessage: /import-registry-missing/ });
  assert.equal(deployment.status().logs.length, 1);
  assert.match(deployment.status().logs[0].message, /remote managed-site registry is missing/);
});
test('Linux installer emits a failed step before exiting on package or private-data errors', t => {
  const { spawnSync } = require('node:child_process');
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const diagnostic = script.slice(script.indexOf('phase()'), script.indexOf('exec > >'));
  const run = body => spawnSync(bash, ['-c', `set -Eeuo pipefail\nexec 3>&1\n${diagnostic}\n${body}`],
    { encoding: 'utf8', timeout: 10000 });
  const packages = script.slice(script.indexOf('step=apt-update'), script.indexOf('if ! command -v node'));
  const failedPackage = run(`as_root() { echo "private command output" >&2; return 100; }\n${packages}`);
  assert.equal(failedPackage.error, undefined);
  assert.equal(failedPackage.status, 100);
  assert.match(failedPackage.stdout, /FEATHERAL_PHASE:apt-update\nFEATHERAL_FAILURE:apt-update:100/);
  assert.doesNotMatch(failedPackage.stdout, /private command output/);
  const prerequisite = script.slice(script.indexOf('step=private-data'), script.indexOf('step=extract'));
  const missingData = run(`primary=false\nhostnames=featheral.com\nshared=/nonexistent-featheral-test-${crypto.randomUUID()}\n${prerequisite}`);
  assert.equal(missingData.status, 1);
  assert.match(missingData.stdout, /FEATHERAL_FAILURE:private-data:1/);
});
test('automatic installation shell guard creates only empty storage, reuses initialized storage and refuses ambiguous data', t => {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-new-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shared = path.join(directory, 'shared');
  fs.mkdirSync(shared);
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const diagnostic = script.slice(script.indexOf('phase()'), script.indexOf('exec > >'));
  const prerequisite = script.slice(script.indexOf('step=private-data'), script.indexOf('step=extract'));
  const run = () => spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
    ['-c', `set -Eeuo pipefail\nexec 3>&1\n${diagnostic}\nroot="$FIXTURE_DIR"\nshared="$root/shared"\nprimary=true\nhostnames="featheral.com admin.featheral.com"\n${prerequisite}\necho "Detected: $installation"`],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE_DIR: directory.replace(/\\/g, '/') } });
  assert.equal(run().status, 0);
  assert.match(run().stdout, /Detected: new/);
  assert.deepEqual(fs.readdirSync(path.join(shared, 'data')), []);
  const data = path.join(shared, 'data', 'existing.txt');
  fs.writeFileSync(data, 'preserve');
  assert.equal(run().status, 1);
  assert.equal(fs.readFileSync(data, 'utf8'), 'preserve');
  fs.rmSync(data);
  fs.mkdirSync(path.join(directory, 'current'));
  const existing = run();
  assert.equal(existing.status, 1);
  assert.match(existing.stdout, /FEATHERAL_FAILURE:private-data:1/);
  fs.mkdirSync(path.join(shared, 'data', 'system-database'));
  fs.mkdirSync(path.join(shared, 'bootstrap'));
  fs.writeFileSync(path.join(shared, 'bootstrap', 'bootstrap.json'), '{"preserve":true}');
  const initialized = run();
  assert.equal(initialized.status, 0);
  assert.match(initialized.stdout, /Detected: existing/);
  assert.equal(fs.readFileSync(path.join(shared, 'bootstrap', 'bootstrap.json'), 'utf8'), '{"preserve":true}');
});
test('installer tees stdout and stderr into both the console stream and persistent server log', t => {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-tee-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'logs'));
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const redirect = script.slice(script.indexOf('exec > >'), script.indexOf('echo "Starting'));
  const result = spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
    ['-c', `set -Eeuo pipefail\nexec 3>&1\nshared="$FIXTURE_DIR"\n${redirect}\necho "npm build output"\necho "installer error detail" >&2\n`],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE_DIR: directory.replace(/\\/g, '/') } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /npm build output\ninstaller error detail/);
  assert.equal(fs.readFileSync(path.join(directory, 'logs', 'deployment.log'), 'utf8'), result.stdout);
});
test('health retries avoid empty JSON errors and expose bounded application diagnostics on failure', t => {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-health-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'logs'));
  fs.writeFileSync(path.join(directory, 'logs', 'error.log'), 'Startup error: fixture failed\n');
  fs.writeFileSync(path.join(directory, 'logs', 'app.log'), 'Starting application\n');
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const health = script.slice(script.indexOf('healthy=false'), script.indexOf('for host in $hostnames; do\n  # CMS'));
  const run = body => spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
    ['-c', `set -Eeuo pipefail\nshared="$FIXTURE_DIR"\ngateway=127.0.0.1:8080\nrelease_id=fixture\nsleep() { :; }\n${body}\n${health}`],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, FIXTURE_DIR: directory.replace(/\\/g, '/') } });
  const unreachable = run('curl() { echo "connection refused" >&2; return 7; }');
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /after 60 attempts/);
  assert.match(unreachable.stdout, /Startup error: fixture failed/);
  assert.match(unreachable.stdout, /Starting application/);
  assert.equal(unreachable.stderr, '');
  const invalid = run('curl() { printf "not JSON"; }');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, '');
  const ready = run('curl() { printf \'{"status":"ok","release":"fixture"}\'; }');
  assert.equal(ready.status, 0);
  assert.equal(ready.stdout, '');
  assert.equal(ready.stderr, '');
});
test('site health probes simulate HTTPS on loopback and identify failing hosts without accepting errors', () => {
  const { spawnSync } = require('node:child_process');
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const internal = script.slice(script.indexOf('for host in $hostnames; do\n  # CMS'), script.indexOf('as_root systemctl enable --now nginx'));
  const external = script.slice(script.lastIndexOf('for host in $hostnames; do'), script.indexOf('echo "Deployment complete:'));
  const run = (check, mock, hosts = 'featheral.com admin.featheral.com') => spawnSync(
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
    ['-c', `set -Eeuo pipefail\ngateway=127.0.0.1:8080\nhostnames="${hosts}"\n${mock}\n${check}`],
    { encoding: 'utf8', timeout: 10000 });
  const forwarded = run(internal, `curl() { if [[ "$*" != *"X-Forwarded-Proto: https"* ]]; then printf 403; else printf 200; fi; }`);
  assert.equal(forwarded.status, 0);
  assert.match(forwarded.stdout, /admin.featheral.com returned HTTP 200/);
  for (const check of [internal, external]) {
    const adminAuth = run(check, 'curl() { printf 401; }', 'admin.featheral.com');
    assert.equal(adminAuth.status, 0);
    for (const status of [301, 403, 404, 500]) {
      const failed = run(check, `curl() { printf ${status}; }`, 'admin.featheral.com');
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, new RegExp(`admin.featheral.com returned HTTP ${status}`));
      assert.match(failed.stdout, /health failed: admin.featheral.com/);
    }
    const publicAuth = run(check, 'curl() { printf 401; }', 'featheral.com');
    assert.equal(publicAuth.status, 1);
    const connection = run(check, 'curl() { printf 000; return 7; }');
    assert.equal(connection.status, 1);
    assert.match(connection.stdout, /health failed: featheral.com/);
  }
});
test('deployment requires a valid server-side target and pinned host key without exposing credentials', () => {
  assert.throws(() => configuration({}), { status: 400 });
  for (const target of ['root@host:/', 'user@host:/opt/../home', 'user@host:/opt/x;id']) assert.throws(() => configuration({ ...env, DEPLOY_TARGET: target }), { status: 400 });
  assert.throws(() => configuration({ ...env, DEPLOY_HOST_KEY_SHA256: '' }), { status: 400 });
  const plan = new Deployment({ root, env }).plan();
  assert.equal(plan.enabled, false);
  assert.ok(!JSON.stringify(plan).includes(env.DEPLOY_KEY_FILE));
  assert.deepEqual(plan.hosts, require('../lib/site-pages').hosts);
});
test('root password authentication requires explicit configuration and never appears in plans or status', () => {
  const password = ' mock password with spaces ';
  const passwordEnv = { ...env, DEPLOY_TARGET: 'root@featheral.com:/opt/featheral', DEPLOY_KEY_FILE: '', DEPLOY_PASSWORD: password };
  const config = configuration(passwordEnv);
  assert.equal(config.username, 'root');
  assert.equal(config.host, 'featheral.com');
  assert.equal(config.password, password);
  assert.throws(() => configuration({ ...passwordEnv, DEPLOY_PASSWORD: '' }), { status: 400 });
  assert.throws(() => configuration({ ...passwordEnv, DEPLOY_KEY_FILE: env.DEPLOY_KEY_FILE }), { status: 400 });
  assert.throws(() => configuration({ ...passwordEnv, DEPLOY_HOST_KEY_SHA256: '' }), { status: 400 });
  assert.throws(() => configuration({ ...passwordEnv, DEPLOY_PORT: 'invalid' }), { status: 400 });
  const deployment = new Deployment({ root, env: passwordEnv });
  const plan = deployment.plan();
  assert.equal(plan.target, 'root@featheral.com:/opt/featheral');
  assert.equal(plan.enabled, false);
  assert.ok(!JSON.stringify({ plan, status: deployment.status() }).includes(password));
});
test('SSH password and key methods are mutually exclusive and both enforce host-key pinning', async () => {
  const hostKey = Buffer.from('mock server public host key');
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
  let received, ended = 0;
  class Client extends EventEmitter {
    connect(options) { received = options; process.nextTick(() => this.emit('ready')); }
    end() { ended++; }
  }
  const deployment = new Deployment({ root, env, clientFactory: () => new Client() });
  const client = await deployment.connect(configuration({ ...env, DEPLOY_KEY_FILE: '', DEPLOY_PASSWORD: 'mock-password', DEPLOY_HOST_KEY_SHA256: fingerprint }));
  assert.equal(received.password, 'mock-password');
  assert.ok(!Object.hasOwn(received, 'privateKey'));
  assert.equal(received.hostVerifier(hostKey), true);
  assert.equal(received.hostVerifier(Buffer.from('untrusted host key')), false);
  client.end();
  assert.equal(ended, 1);
});
test('SSH authentication errors close the connection without being mistaken for success', async () => {
  let ended = false;
  class Client extends EventEmitter {
    connect() { process.nextTick(() => this.emit('error', new Error('Authentication failed'))); }
    end() { ended = true; }
  }
  const deployment = new Deployment({ root, env, clientFactory: () => new Client() });
  await assert.rejects(deployment.connect(configuration({ ...env, DEPLOY_KEY_FILE: '', DEPLOY_PASSWORD: 'mock-password' })), /Authentication failed/);
  assert.equal(ended, true);
});
test('reviewed deployment is disabled by default and exact approval/content freshness is required', async () => {
  let content = [];
  const deployment = new Deployment({ root, env, snapshot: () => content });
  const plan = deployment.plan();
  await assert.rejects(deployment.start({ planId: plan.id }), { status: 403 });
  deployment.env = { ...env, DEPLOY_ENABLED: 'true' };
  assert.throws(() => deployment.validate({ planId: plan.id, approval: 'yes' }),
    { status: 400, message: 'Enter the exact approval phrase from the reviewed deployment plan.' });
  assert.throws(() => deployment.validate({ planId: 'expired', approval: 'yes' }),
    { status: 400, message: 'Deployment plan expired or unavailable. Review a new plan.' });
  const approval = `DEPLOY ${plan.digest} ${plan.contentDigest}`;
  assert.doesNotThrow(() => deployment.validate({ planId: plan.id, approval }));
  content = [{ changed: true }];
  assert.throws(() => deployment.validate({ planId: plan.id, approval }), { status: 409 });
  assert.equal(deployment.status().running, false);
});
test('release archive selection includes Git-tracked source and excludes private data, keys and dependencies', () => {
  const files = releaseFiles(root);
  assert.ok(files.includes('scripts/deploy-release.sh'));
  assert.ok(files.includes('ecosystem.config.cjs'));
  assert.ok(files.includes('sites/world.featheral.com/play/package.json'));
  assert.ok(files.every(file => !/(^|\/)(data|node_modules|dist|\.env)(\/|$)|\.(pem|sqlite|key)$/.test(file)));
});
test('Git-tracked release inventory excludes untracked, removed and private files', t => {
  const { execFileSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-git-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', directory]);
  const write = (file, content) => { const target = path.join(directory, ...file.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  write('package.json', '{}'); write('scripts/tracked.js', 'tracked source'); write('scripts/removed.js', 'removed');
  write('services/data/private.json', 'private'); write('shared/signing.key', 'private'); write('services/.env', 'private');
  execFileSync('git', ['-C', directory, 'add', '.']);
  write('scripts/untracked.js', 'not reviewed by Git'); write('scripts/tracked.js', 'updated tracked source');
  fs.rmSync(path.join(directory, 'scripts', 'removed.js'));
  assert.deepEqual(releaseFiles(directory), ['package.json', 'scripts/tracked.js']);
  assert.equal(fs.readFileSync(path.join(directory, 'scripts', 'tracked.js'), 'utf8'), 'updated tracked source');
});
test('a deployed release retains its reviewed Git-tracked inventory without shipping Git metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-release-inventory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.writeFileSync(path.join(directory, 'scripts', 'tracked.js'), 'source');
  fs.writeFileSync(path.join(directory, 'scripts', 'untracked.js'), 'excluded');
  fs.writeFileSync(path.join(directory, '.deployment-source.json'), JSON.stringify({ files: ['scripts/tracked.js'] }));
  assert.deepEqual(releaseFiles(directory), ['scripts/tracked.js']);
  fs.writeFileSync(path.join(directory, '.deployment-source.json'), JSON.stringify({ files: [42] }));
  assert.throws(() => releaseFiles(directory), { status: 503 });
});
test('installer hands a deployment-owned PM2 daemon to its persistent service before health checks', () => {
  const { spawnSync } = require('node:child_process');
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const startup = script.slice(script.indexOf('step=pm2-startup'), script.indexOf('step=health'));
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const run = (active, failStart = false) => spawnSync(bash, ['-c', `set -Eeuo pipefail
active=${active}
phase() { :; }
id() { echo fixture; }
pm2=pm2_fixture
pm2_fixture() { echo "pm2 $*"; }
as_root() {
  if [[ "$1 $2" == "systemctl is-active" ]]; then [[ "$active" == true ]]; return; fi
  if [[ "$1 $2" == "systemctl start" ]]; then
    echo "start $3"
    ${failStart ? 'return 1' : 'active=true'}
    return
  fi
  echo "startup"
}
${startup}
echo "health ready"`], { encoding: 'utf8', timeout: 10000 });
  const cold = run(false);
  assert.equal(cold.error, undefined);
  assert.equal(cold.status, 0);
  assert.match(cold.stdout, /pm2 save\nstartup\npm2 kill\nstart pm2-fixture\nhealth ready/);
  const warm = run(true);
  assert.equal(warm.status, 0);
  assert.match(warm.stdout, /pm2 save\nstartup\nhealth ready/);
  assert.doesNotMatch(warm.stdout, /pm2 kill|start pm2-fixture/);
  const failed = run(false, true);
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout, /health ready/);
});
test('managed Nginx streams uploads on fresh and existing TLS hosts without removing upload limits', t => {
  const { spawnSync } = require('node:child_process');
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const candidate = script.slice(script.indexOf("cat >\"$candidate\" <<'NGINX'"), script.indexOf('\nprevious='));
  const update = script.slice(script.indexOf('# Do not overwrite other virtual hosts.'), script.indexOf('\nas_root nginx -t\n# Resolve'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-streaming-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = (name, content, fresh = false) => {
    fs.writeFileSync(path.join(directory, name), content);
    const result = spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
      ['-c', `set -Eeuo pipefail
as_root() { "$@"; }
candidate=candidate.conf
hostnames=example.com
upload_mib=512
request_timeout=600
gateway=127.0.0.1:8080
${candidate}
nginx_file=${name}
had_nginx=true
${fresh ? 'cp "$candidate" "$nginx_file"' : ''}
${update}
${update}
cat "$nginx_file"`], { cwd: directory, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/proxy_request_buffering off;/g) || []).length, 1);
    assert.match(result.stdout, /client_max_body_size 512m;/);
    assert.match(result.stdout, /proxy_send_timeout 600s;/);
    return result.stdout;
  };
  const fresh = run('fresh.conf', '', true);
  assert.match(fresh, /proxy_request_buffering off;/);
  const tls = run('tls.conf', `server {
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_request_buffering on;
        proxy_read_timeout 30s;
    }
}
`);
  assert.match(tls, /listen 443 ssl;/);
  assert.match(tls, /ssl_certificate \/etc\/letsencrypt\/live\/example.com\/fullchain.pem;/);
});
test('remote script preserves private state and singleton PM2, validates Nginx, and rolls back only code', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(script, /consistent offline backup/);
  assert.match(script, /trap rollback ERR/);
  assert.match(script, /nginx -t/);
  assert.match(script, /certbot --nginx/);
  assert.match(script, /health\.release!==process\.argv\[1\]/);
  assert.match(script, /--resolve "\$host:443:127\.0\.0\.1"/);
  assert.match(script, /startup systemd/);
  assert.match(script, /restore|restoring/);
  assert.match(script, /hostnames" == db\.featheral\.com/);
  assert.match(script, /DB-only host has no financial writers/);
  assert.match(script, /deployment-hosts\.json/);
  assert.ok(script.indexOf('node scripts/import-site-pages.js') < script.indexOf('mv -Tf "$root/current.next" "$root/current"\nactivated=true'));
  for (const step of ['import-pages', 'pm2-start', 'health', 'pm2-startup']) assert.match(script, new RegExp(`step=${step}\\n\\s*phase "\\$step"`));
  const pm2 = require('../../../ecosystem.config.cjs');
  assert.equal(pm2.apps[0].instances, 1);
  assert.equal(pm2.apps[0].args, 'start');
});
test('deployment startup selects DB-only mode before loading CMS or financial services, without needing shared credentials', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'scripts', 'serve.js'), 'utf8');
  const prefix = source.slice(0, source.indexOf('const http = require("http");')) + '}';
  let listening, options;
  const fakeRoot = path.join(os.tmpdir(), 'db-startup-fixture');
  const manifest = { hosts: ['db.featheral.com'], primary: false, uploadLimitMiB: 24, requestTimeoutSeconds: 120 };
  const start = () => vm.runInNewContext(prefix, {
    __dirname: path.join(fakeRoot, 'scripts'), console: { log() {} }, process: { on() {} },
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return {
        existsSync: file => file.endsWith('.deployment-hosts.json'),
        readFileSync: () => JSON.stringify(manifest),
      };
      if (name === '../services/operations/configuration') return { assertDatabaseConfiguration() {} };
      if (name === '../services/operations/replica') return { readReplica: () => null, replicaEnvironment: (_root, env) => env };
      if (name === '../services/database/server') return { createSiteServer(config) {
        options = config;
        return { listen(port, host, callback) { listening = { port, host }; callback(); } };
      } };
      throw new Error('DB-only deployment loaded an unrelated service: ' + name);
    },
  });
  start();
  assert.deepEqual(listening, { port: 8080, host: '127.0.0.1' });
  assert.equal(options.root, fakeRoot);
  assert.equal(options.settings.value.uploadLimitMiB, 24);
  assert.equal(options.settings.value.requestTimeoutSeconds, 120);
  for (const [key, values] of [["uploadLimitMiB", [0, 1025, 1.5, null, "24"]], ["requestTimeoutSeconds", [4, 3601, 5.5]]]) {
    const original = manifest[key];
    for (const value of values) {
      manifest[key] = value;
      assert.throws(start, /Invalid deployment hostname or HTTP limit assignment/);
    }
    manifest[key] = original;
  }
});
test('reviewed source is uploaded by SFTP and SSH failures never report success', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-deploy-test-'));
  const keyFile = path.join(temp, 'test-key');
  fs.writeFileSync(keyFile, 'mock key, not a credential');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const hostKey = Buffer.from('mock public host key');
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
  const uploads = [], commands = [];
  const remoteFiles = new Map();
  class FakeClient extends EventEmitter {
    connect(options) {
      assert.equal(options.privateKey.toString(), 'mock key, not a credential');
      assert.ok(!Object.hasOwn(options, 'password'));
      assert.equal(options.hostVerifier(hostKey), true);
      assert.equal(options.hostVerifier(Buffer.from('another host')), false);
      process.nextTick(() => this.emit('ready'));
    }
    exec(command, callback) {
      commands.push(command);
      const stream = new EventEmitter(); stream.stderr = new EventEmitter();
      callback(null, stream);
      process.nextTick(() => {
        if (command.startsWith('df -Pk')) stream.emit('data', Buffer.from('999999999\n'));
        if (command.startsWith('sha256sum <')) {
          const remote = command.slice("sha256sum < '".length, -1);
          stream.emit('data', Buffer.from(crypto.createHash('sha256').update(remoteFiles.get(remote)).digest('hex') + '  -\n'));
        }
        if (command.startsWith('sudo -n systemd-run')) {
          stream.emit('data', Buffer.from('FEATHERAL_PHASE:build\nnpm build out'));
          stream.emit('data', Buffer.from('put\nfixture-runtime-secret\npassword=fixture-secret\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n'));
          stream.emit('data', Buffer.from('-----END PRIVATE KEY-----\n' + 'x'.repeat(65537)));
          stream.emit('data', Buffer.from('\noutput resumes\n'));
          stream.stderr.emit('data', Buffer.from('Error: build failed\nhttps://user:fixture-secret@example.com/\nlast unterminated error'));
        }
        stream.emit('close', command.startsWith('sudo -n systemd-run') ? 17 : 0);
      });
    }
    sftp(callback) {
      callback(null, {
        lstat(remote, done) { done(Object.assign(new Error('missing'), { code: 2 })); },
        open(remote, _flags, _mode, done) { remoteFiles.set(remote, Buffer.alloc(0)); uploads.push({ destination: remote }); done(null, remote); },
        write(remote, chunk, offset, length, _position, done) { remoteFiles.set(remote, Buffer.concat([remoteFiles.get(remote), chunk.subarray(offset, offset + length)])); done(); },
        close(_handle, done) { done(); }, end() {},
      });
    }
    end() {}
  }
  const deployment = new Deployment({ root, env: { ...env, DEPLOY_ENABLED: 'true', DEPLOY_KEY_FILE: keyFile, DEPLOY_HOST_KEY_SHA256: fingerprint, APP_VAPID_PRIVATE_KEY: 'fixture-runtime-secret' },
    clientFactory: () => new FakeClient(), stateDirectory: temp });
  const plan = deployment.plan();
  await assert.rejects(deployment.start({ planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` }), { status: 502 });
  assert.equal(uploads.length, plan.files + 3);
  assert.ok(uploads.some(entry => entry.destination.endsWith('/.cms-published.json')));
  assert(!uploads.some(entry => entry.destination.endsWith('.zip')));
  assert.match([...remoteFiles].find(([file]) => file.endsWith('/scripts/deploy-release.sh'))[1].toString(), /set -Eeuo pipefail/);
  assert.ok(commands.some(command => command.startsWith('sudo -n systemd-run')));
  assert.equal(deployment.status().result.success, false);
  assert.equal(deployment.status().running, false);
  const consoleText = JSON.stringify(deployment.status().logs);
  assert.match(consoleText, /npm build output/);
  assert.match(consoleText, /Error: build failed/);
  assert.match(consoleText, /last unterminated error/);
  assert.match(consoleText, /output resumes/);
  assert.match(consoleText, /line omitted/);
  assert.match(consoleText, /REDACTED/);
  assert.doesNotMatch(consoleText, /private-key-body|fixture-secret|fixture-runtime-secret/);
});
