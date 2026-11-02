const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(currentStatus = { running: false, logs: [] }) {
  const elements = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', disabled: false, textContent: '', listeners: {},
      replaceChildren(fragment) { this.children = fragment.children; this.textContent = fragment.children.map(child => child.textContent).join(''); },
      addEventListener(event, listener) { this.listeners[event] = listener; } });
    return elements.get(selector);
  };
  const plan = { id: 'reviewed', enabled: true, walletApprovalRequired: true, digest: 'source', contentDigest: 'content',
    expiresAt: Date.now() + 600000, target: 'root@server.example', files: 100, steps: ['Upload release'] };
  let failure, ready = true, confirmed = 0, signed = 0, poll;
  const context = vm.createContext({
    document: {
      createDocumentFragment: () => ({ children: [], append(child) { this.children.push(child); } }),
      createElement: () => ({ className: '', textContent: '' }),
      createTextNode: text => ({ textContent: text }),
    },
    VIEWS: {}, state: { seq: 1 }, location: { hash: '#/settings' }, viewCleanup: null, $: element,
    setInterval: callback => { poll = callback; return 1; }, clearInterval() {}, confirm: () => { confirmed++; return true; }, toast() {},
    async approveAdminAction() { signed++; return { challengeId: 'approved', signature: 'signed' }; },
    async api(url, options) {
      calls.push({ url, input: options?.json });
      if (url === '/api/deployment/status') return currentStatus;
      if (url === '/api/deployment/plan') return { ...plan };
      if (url.endsWith('/challenge')) {
        if (failure) { const error = failure; failure = null; throw error; }
        return { challengeId: 'approved' };
      }
      if (url.endsWith('/start')) return { running: true };
      throw new Error('Unexpected request: ' + url);
    },
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/admin.featheral.com/js/sites.js'), 'utf8');
  vm.runInContext(source, context);
  await context.mountDeploymentControls(1, () => ready);
  return { element, calls, plan, context, setFailure(error) { failure = error; }, setReady(value) { ready = value; },
    async refresh() { await poll(); },
    get confirmed() { return confirmed; }, get signed() { return signed; },
    async click(selector) { const control = element(selector); await control.listeners.click({ currentTarget: control }); },
    async enter(value) { const input = element('#deployment-approval'); input.value = value; await input.listeners.input(); } };
}

test('deployment waits for exact approval before requesting a wallet challenge and starts the signed release', async () => {
  const f = await fixture();
  await f.click('#deployment-plan');
  assert.equal(f.element('#deployment-start').disabled, true);
  for (const value of ['', 'DEPLOY', 'DEPLOY source wrong']) {
    await f.enter(value);
    assert.equal(f.element('#deployment-start').disabled, true);
    await f.click('#deployment-start');
  }
  assert.equal(f.confirmed, 0);
  assert.equal(f.calls.some(call => call.url.endsWith('/challenge')), false);
  await f.enter('DEPLOY source content');
  assert.equal(f.element('#deployment-start').disabled, false);
  await f.click('#deployment-start');
  assert.equal(f.signed, 1);
  const start = f.calls.find(call => call.url === '/api/database/deployment/start');
  assert.equal(start.input.planId, 'reviewed');
  assert.equal(start.input.approval, 'DEPLOY source content');
  assert.equal(start.input.signature, 'signed');
  assert.equal(f.element('#deployment-start').disabled, true);
});

test('challenge failure is visible and retryable; a new review clears the old approval', async () => {
  const f = await fixture();
  await f.click('#deployment-plan');
  await f.enter('DEPLOY source content');
  f.setFailure(new Error('Challenge API failed with 400'));
  await f.click('#deployment-start');
  assert.equal(f.element('#deployment-status').textContent, 'Challenge API failed with 400');
  assert.equal(f.element('#deployment-start').disabled, false);
  assert.equal(f.element('#deployment-approval').disabled, false);
  await f.click('#deployment-start');
  assert.equal(f.calls.filter(call => call.url.endsWith('/challenge')).length, 2);
  assert.ok(f.calls.some(call => call.url.endsWith('/start')));
  await f.click('#deployment-plan');
  assert.equal(f.element('#deployment-approval').value, '');
  assert.equal(f.element('#deployment-start').disabled, true);
});

test('expired plans and unsaved connections cannot request deployment challenges', async () => {
  const f = await fixture();
  f.plan.expiresAt = Date.now() - 1;
  await f.click('#deployment-plan');
  await f.enter('DEPLOY source content');
  assert.equal(f.element('#deployment-start').disabled, true);
  await f.click('#deployment-start');
  assert.match(f.element('#deployment-status').textContent, /expired/);
  f.plan.expiresAt = Date.now() + 600000;
  await f.click('#deployment-plan');
  f.setReady(false);
  await f.enter('DEPLOY source content');
  assert.equal(f.element('#deployment-start').disabled, true);
  await f.click('#deployment-start');
  assert.match(f.element('#deployment-status').textContent, /Connection settings changed/);
  assert.equal(f.calls.some(call => call.url.endsWith('/challenge')), false);
});

test('opening Settings shows failure details once in the console, with only a compact status above', async () => {
  const message = 'Installer failed at apt-update (exit 100). Refreshing operating-system package indexes.';
  const f = await fixture({ running: false, result: { success: false, error: message,
    targets: [{ host: 'server.example', hosts: ['featheral.com'], success: false, error: message }] },
    logs: [{ at: Date.now(), message: `server.example: ${message}` }] });
  assert.equal(f.element('#deployment-status').textContent, 'Deployment failed');
  assert.match(f.element('#deployment-console').textContent, /server.example: failed/);
  assert.ok(f.element('#deployment-console').textContent.includes(message));
  assert.equal(f.element('#deployment-console').textContent.split(message).length - 1, 1);
});
test('installation controls are absent and reviewing delegates detection to the installer', async () => {
  const f = await fixture();
  await f.click('#deployment-plan');
  const html = vm.runInContext('deploymentControlsHtml()', f.context);
  assert.doesNotMatch(html, /type="checkbox"|First installation options|deployment-initialize|deployment-fresh-sites/);
  assert.match(html, /detected automatically/);
  assert.match(html, /Live installer output/);
  assert.equal(JSON.stringify(f.calls.find(call => call.url === '/api/deployment/plan').input), '{}');
  assert.equal(f.element('#deployment-phrase').value, 'DEPLOY source content');
  assert.match(f.element('#deployment-summary').textContent, /1 server.*100 files/);
  assert.match(html, /<details class="deployment-technical"><summary>/);
  assert.doesNotMatch(html, /deployment-technical" open/);
  assert.equal(f.element('#deployment-plan').textContent, 'Refresh review');
  await f.enter('DEPLOY source content');
  assert.equal(f.element('#deployment-start').disabled, false);
});
test('review summary shows every target count while full connection details remain available', async () => {
  const f = await fixture();
  f.plan.targets = [
    { username: 'root', host: 'db.example', port: 22, directory: '/opt/featheral', hosts: ['db.featheral.com'] },
    { username: 'deploy', host: 'shared.example', port: 2222, directory: '/srv/featheral', hosts: ['admin.featheral.com', 'featheral.com'] },
  ];
  f.plan.hosts = ['db.featheral.com', 'admin.featheral.com', 'featheral.com'];
  await f.click('#deployment-plan');
  assert.match(f.element('#deployment-summary').textContent, /2 servers \| 3 sites \| 100 files/);
  assert.match(f.element('#deployment-details').textContent, /root@db.example:22\/opt\/featheral/);
  assert.match(f.element('#deployment-details').textContent, /deploy@shared.example:2222\/srv\/featheral/);
  await f.enter('DEPLOY source content');
  await f.click('#deployment-start');
  assert.equal(f.element('#deployment-phrase').value, '');
  assert.match(f.element('#deployment-summary').textContent, /submitted/);
});
test('deployment console displays installer stdout and stderr alongside progress markers', async () => {
  const f = await fixture({ running: true, logs: [
    { at: Date.now(), message: 'server.example: Building World and exporting ABIs.' },
    { at: Date.now(), message: 'server.example: added 250 packages' },
    { at: Date.now(), message: 'server.example: Error: build failed' },
  ] });
  assert.match(f.element('#deployment-console').textContent, /Building World[\s\S]*added 250 packages[\s\S]*Error: build failed/);
  assert.equal(f.element('#deployment-console').children[0].className, 'console-info');
  assert.equal(f.element('#deployment-console').children[4].className, 'console-error');
});
test('both consoles color severity without interpreting untrusted output as HTML', async () => {
  const f = await fixture();
  const input = '--- Nginx errors ---\nError: <img src=x onerror=alert(1)>\nWarning: deprecated\nHealth verified successfully\nBuilding app\nnormal line';
  f.context.logText = input;
  vm.runInContext('renderConsole($("#server-log-output"), logText)', f.context);
  const output = f.element('#server-log-output');
  assert.equal(output.textContent, input);
  assert.deepEqual(output.children.filter(child => child.className).map(child => child.className),
    ['console-source', 'console-error', 'console-warning', 'console-success', 'console-info']);
  const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/admin.featheral.com/js/sites.js'), 'utf8');
  assert.match(source, /option value="all"/);
  assert.match(source, /renderConsole\(output, data.text/);
});
test('polling preserves reading position and follows new output only near the console bottom', async () => {
  const status = { running: true, logs: [{ at: Date.now(), message: 'Started' }] };
  const f = await fixture(status);
  const consoleView = f.element('#deployment-console');
  Object.assign(consoleView, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
  status.logs.push({ at: Date.now(), message: 'Installing' });
  await f.refresh();
  assert.equal(consoleView.scrollTop, 100);
  consoleView.scrollTop = 590;
  status.logs.push({ at: Date.now(), message: 'Building' });
  await f.refresh();
  assert.equal(consoleView.scrollTop, 1000);
});
test('legacy failures without saved logs remain visible in the single console', async () => {
  const f = await fixture({ running: false, logs: [], result: { success: false, error: 'Remote deployment failed.' } });
  assert.equal(f.element('#deployment-status').textContent, 'Deployment failed');
  assert.equal(f.element('#deployment-console').textContent, 'Remote deployment failed.');
});
