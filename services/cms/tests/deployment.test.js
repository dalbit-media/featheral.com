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
  assert.throws(() => deployment.validate({ planId: plan.id, approval: 'yes' }), { status: 400 });
  const approval = `DEPLOY ${plan.digest} ${plan.contentDigest}`;
  assert.doesNotThrow(() => deployment.validate({ planId: plan.id, approval }));
  content = [{ changed: true }];
  assert.throws(() => deployment.validate({ planId: plan.id, approval }), { status: 409 });
  assert.equal(deployment.status().running, false);
});
test('release archive selection includes current source and excludes private data, keys and dependencies', () => {
  const files = releaseFiles(root);
  assert.ok(files.includes('scripts/deploy-release.sh'));
  assert.ok(files.includes('ecosystem.config.cjs'));
  assert.ok(files.includes('sites/world.featheral.com/play/package.json'));
  assert.ok(files.every(file => !/(^|\/)(data|node_modules|dist|\.env)(\/|$)|\.(pem|sqlite|key)$/.test(file)));
});
test('remote script preserves private state and singleton PM2, validates Nginx, and rolls back only code', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'deploy-release.sh'), 'utf8');
  assert.match(script, /consistent offline backup/);
  assert.match(script, /trap rollback ERR/);
  assert.match(script, /nginx -t/);
  assert.match(script, /certbot --nginx/);
  assert.match(script, /health\.release!==process\.argv\[1\]/);
  assert.match(script, /--resolve "\$host:443:127\.0\.0\.1"/);
  assert.match(script, /startup systemd/);
  assert.match(script, /restore|restoring/);
  const pm2 = require('../../../ecosystem.config.cjs');
  assert.equal(pm2.apps[0].instances, 1);
  assert.equal(pm2.apps[0].args, 'start');
});
test('reviewed source is uploaded by SFTP and SSH failures never report success', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-deploy-test-'));
  const keyFile = path.join(temp, 'test-key');
  fs.writeFileSync(keyFile, 'mock key, not a credential');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const hostKey = Buffer.from('mock public host key');
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
  const uploads = [], commands = [];
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
      process.nextTick(() => stream.emit('close', command.startsWith('sudo -n systemd-run') ? 17 : 0));
    }
    sftp(callback) {
      callback(null, { fastPut(source, destination, done) {
        uploads.push({ destination, bytes: fs.readFileSync(source) }); done();
      }, end() {} });
    }
    end() {}
  }
  const deployment = new Deployment({ root, env: { ...env, DEPLOY_ENABLED: 'true', DEPLOY_KEY_FILE: keyFile, DEPLOY_HOST_KEY_SHA256: fingerprint },
    clientFactory: () => new FakeClient(), stateDirectory: temp });
  const plan = deployment.plan();
  await assert.rejects(deployment.start({ planId: plan.id, approval: `DEPLOY ${plan.digest} ${plan.contentDigest}` }), { status: 502 });
  assert.equal(uploads.length, 2);
  assert.ok(uploads[0].bytes.includes(Buffer.from('.cms-published.json')));
  assert.match(uploads[1].bytes.toString(), /set -Eeuo pipefail/);
  assert.ok(commands.some(command => command.startsWith('sudo -n systemd-run')));
  assert.equal(deployment.status().result.success, false);
  assert.equal(deployment.status().running, false);
});
