const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(currentStatus = { running: false, logs: [] }, selfStatus = { available: false, running: false, logs: [] }) {
  const elements = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', disabled: false, textContent: '', listeners: {},
      replaceChildren(fragment) { this.children = fragment.children; this.textContent = fragment.children.map(child => child.textContent).join(''); },
      addEventListener(event, listener) { this.listeners[event] = listener; } });
    return elements.get(selector);
  };
  const plan = { id: 'reviewed', enabled: true, walletApprovalRequired: true, digest: 'source', contentDigest: 'content',
    expiresAt: Date.now() + 600000, target: 'root@server.example', files: 100, steps: ['Upload release'] };
  let failure, signingFailure, startFailure, statusFailure, statusPending, ready = true, confirmed = 0, signed = 0, poll;
  const context = vm.createContext({
    document: {
      createDocumentFragment: () => ({ children: [], append(child) { this.children.push(child); } }),
      createElement: () => ({ className: '', textContent: '' }),
      createTextNode: text => ({ textContent: text }),
    },
    VIEWS: {}, state: { seq: 1 }, location: { hash: '#/settings' }, viewCleanup: null, $: element,
    setInterval: callback => { poll = callback; return 1; }, clearInterval() {}, confirm: () => { confirmed++; return true; }, toast() {},
    async approveAdminAction() {
      signed++;
      if (signingFailure) { const error = signingFailure; signingFailure = null; throw error; }
      return { challengeId: 'approved', signature: 'signed' };
    },
    async api(url, options) {
      calls.push({ url, input: options?.json, cache: options?.cache });
      if (url === '/api/deployment/status') return currentStatus;
      if (url === '/api/deployment/plan') return { ...plan };
      if (url === '/api/settings/self-sync') {
        if (statusFailure) throw statusFailure;
        if (statusPending) return statusPending;
        return selfStatus;
      }
      if (url.endsWith('/challenge')) {
        if (failure) { const error = failure; failure = null; throw error; }
        return { challengeId: 'approved' };
      }
      if (url.endsWith('/start')) {
        if (startFailure) { const error = startFailure; startFailure = null; throw error; }
        if (url === '/api/settings/self-sync/start') selfStatus = { ...selfStatus, running: true };
        return { running: true };
      }
      throw new Error('Unexpected request: ' + url);
    },
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../../../sites/admin.featheral.com/js/sites.js'), 'utf8');
  vm.runInContext(source, context);
  await context.mountDeploymentControls(1, () => ready);
  return { element, calls, plan, context, setFailure(error) { failure = error; }, setReady(value) { ready = value; },
    setSigningFailure(error) { signingFailure = error; },
    setStartFailure(error) { startFailure = error; },
    setStatusFailure(error) { statusFailure = error; },
    setStatusPending(promise) { statusPending = promise; },
    setSelfStatus(value) { selfStatus = value; },
    async refresh() { await poll(); },
    get confirmed() { return confirmed; }, get signed() { return signed; },
    async click(selector) { const control = element(selector); await control.listeners.click({ currentTarget: control }); },
    async enter(value) { const input = element('#deployment-approval'); input.value = value; await input.listeners.input(); } };
}

test('self-sync is signed, targets only the current Admin server and remains disabled while running', async () => {
  const f = await fixture(undefined, { available: true, running: false, phase: 'idle', logs: [] });
  assert.equal(f.element('#self-sync-start').disabled, false);
  await f.click('#self-sync-start');
  assert.equal(f.signed, 1); assert.equal(f.confirmed, 1);
  const start = f.calls.find(call => call.url === '/api/settings/self-sync/start');
  assert.equal(start.input.signature, 'signed');
  assert.equal(Object.hasOwn(start.input, 'target'), false);
  assert.equal(f.element('#self-sync-start').disabled, true);
  f.setSelfStatus({ available: true, running: false, phase: 'complete', message: 'Health verified', logs: [{ at: 1, message: '<build complete>' }] });
  await f.refresh();
  assert.match(f.element('#self-sync-status').textContent, /Health verified/);
  assert.match(f.element('#deployment-console').textContent, /Git self-sync[\s\S]*<build complete>/);
  assert.equal(f.element('#self-sync-start').disabled, false);
});
test('self-sync is unavailable locally and blocks uncertain jobs or unsaved Settings', async () => {
  const f = await fixture(undefined, { available: false, running: false, message: 'Linux Admin only', logs: [] });
  assert.equal(f.element('#self-sync-start').disabled, true);
  await f.click('#self-sync-start');
  assert.equal(f.signed, 0);
  f.setSelfStatus({ available: true, running: false, phase: 'uncertain', logs: [] });
  await f.click('#self-sync-refresh');
  assert.equal(f.element('#self-sync-start').disabled, true);
  f.setSelfStatus({ available: true, running: false, phase: 'idle', logs: [] });
  f.setReady(false);
  await f.click('#self-sync-refresh');
  assert.equal(f.element('#self-sync-start').disabled, true);
});
test('failed self-sync approval is shown and never launches a job', async () => {
  const f = await fixture(undefined, { available: true, running: false, phase: 'idle', logs: [] });
  f.setFailure(new Error('Approval unavailable'));
  await f.click('#self-sync-start');
  assert.equal(f.element('#self-sync-status').textContent, 'Self-sync not started: Approval unavailable');
  assert(!f.calls.some(call => call.url === '/api/settings/self-sync/start'));
  assert.equal(f.element('#self-sync-start').disabled, false);
});
test('refresh cannot hide a missing signing wallet behind an older successful run', async () => {
  const f = await fixture(undefined, { available: true, running: false, id: 'previous-job', phase: 'complete',
    startedAt: '2026-11-04T10:07:18.915Z', commit: 'a'.repeat(40), message: 'Health verified',
    logs: [{ at: 1, message: 'Previous build complete' }] });
  f.setSigningFailure(new Error('Connect the Admin signing wallet 0x123 in the header.'));
  await f.click('#self-sync-start');
  assert(!f.calls.some(call => call.url === '/api/settings/self-sync/start'));
  await f.click('#self-sync-refresh');
  assert.match(f.element('#self-sync-status').textContent, /Self-sync not started: Connect the Admin signing wallet/);
  assert.match(f.element('#self-sync-status').textContent, /Last recorded self-sync \(job previous-job/);
  const text = f.element('#deployment-console').textContent;
  assert.match(text, /Self-sync request in this browser[\s\S]*Self-sync not started: Connect the Admin signing wallet/);
  assert.match(text, /Last recorded self-sync[\s\S]*Previous build complete/);
  assert(f.calls.filter(call => call.url === '/api/settings/self-sync').every(call => call.cache === 'no-store'));
  assert.equal(f.element('#self-sync-start').disabled, false);
});
test('a lost start response reports uncertainty rather than claiming no job ran', async () => {
  const f = await fixture(undefined, { available: true, running: false, phase: 'idle', logs: [] });
  f.setStartFailure(new Error('Connection interrupted'));
  await f.click('#self-sync-start');
  assert.equal(f.element('#self-sync-start').disabled, true);
  await f.click('#self-sync-refresh');
  assert.match(f.element('#self-sync-status').textContent, /submission not confirmed: Connection interrupted/);
  assert.doesNotMatch(f.element('#self-sync-status').textContent, /Self-sync not started/);
  assert.match(f.element('#deployment-console').textContent, /inspect the job before retrying/);
});

test('self-sync reconnects after gateway restart errors without losing logs or enabling a second job', async () => {
  const f = await fixture(undefined, { available: true, running: false, phase: 'idle', logs: [] });
  f.setStatusFailure(Object.assign(new Error('HTTP 502 Bad Gateway'), { status: 502 }));
  await f.click('#self-sync-start');
  assert.equal(f.element('#self-sync-start').disabled, true);
  assert.match(f.element('#self-sync-status').textContent, /temporarily unreachable during self-sync/);
  assert.match(f.element('#deployment-console').textContent, /completion is not yet confirmed/);
  await f.click('#self-sync-start');
  assert.equal(f.calls.filter(call => call.url.endsWith('/self-sync/start')).length, 1);
  f.setStatusFailure(undefined);
  f.setSelfStatus({ available: true, running: true, phase: 'running', logs: [{ at: 1, message: 'Building release' }] });
  await f.refresh();
  assert.match(f.element('#deployment-console').textContent, /Building release/);
  assert.doesNotMatch(f.element('#deployment-console').textContent, /Self-sync status errors/);
  f.setStatusFailure(Object.assign(new Error('HTTP 503 Service Unavailable'), { status: 503 }));
  await f.refresh();
  assert.match(f.element('#deployment-console').textContent, /Building release/);
  f.setStatusFailure(undefined);
  f.setSelfStatus({ available: true, running: false, phase: 'complete', message: 'Health verified', logs: [] });
  await f.refresh();
  assert.match(f.element('#self-sync-status').textContent, /Health verified/);
  assert.equal(f.element('#self-sync-start').disabled, false);
  assert.doesNotMatch(f.element('#deployment-console').textContent, /Self-sync status errors/);
});
test('prolonged self-sync outage stays unconfirmed and reports inspection guidance', async () => {
  const f = await fixture(undefined, { available: true, running: true, phase: 'running', logs: [] });
  vm.runInContext('Date.now = () => 1000', f.context);
  f.setStatusFailure(Object.assign(new Error('HTTP 504 Gateway Timeout'), { status: 504 }));
  await f.refresh();
  vm.runInContext('Date.now = () => 121001', f.context);
  await f.refresh();
  assert.match(f.element('#self-sync-status').textContent, /Status refresh failed.*journalctl -u featheral-deployment/);
  assert.equal(f.element('#self-sync-start').disabled, true);
});
test('an idle status failure also disables sync until an automatic refresh succeeds', async () => {
  const f = await fixture(undefined, { available: true, running: false, phase: 'idle', logs: [] });
  f.setStatusFailure(new Error('Connection interrupted'));
  await f.click('#self-sync-refresh');
  assert.equal(f.element('#self-sync-start').disabled, true);
  assert.match(f.element('#self-sync-status').textContent, /Status refresh failed/);
  f.setStatusFailure(undefined);
  await f.refresh();
  assert.equal(f.element('#self-sync-start').disabled, false);
});
test('self-sync status polls never overlap and a disposed view ignores the response', async () => {
  const f = await fixture(undefined, { available: true, running: true, phase: 'running', logs: [] });
  let resolve;
  f.setStatusPending(new Promise(done => { resolve = done; }));
  const before = f.calls.length, pending = f.refresh();
  await f.click('#self-sync-refresh');
  assert.equal(f.calls.length, before + 1);
  const previous = f.element('#self-sync-status').textContent;
  f.context.state.seq++;
  resolve({ available: true, running: false, phase: 'complete', message: 'Old view response', logs: [] });
  await pending;
  assert.equal(f.element('#self-sync-status').textContent, previous);
});
test('Admin API errors keep HTTP status without dumping gateway HTML and retain JSON validation errors', async () => {
  const context = vm.createContext({ window: { addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => ({ addEventListener() {} }) },
    location: { hash: '#/settings', reload() {} } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../sites/admin.featheral.com/js/core.js'), 'utf8'), context);
  for (const contentType of ['text/html', 'text/plain']) {
    context.fetch = async () => new Response('<html><head><title>502 Bad Gateway</title></head></html>', {
      status: 502, statusText: 'Bad Gateway', headers: { 'content-type': contentType },
    });
    await assert.rejects(context.api('/api/settings/self-sync'), error =>
      error.status === 502 && error.message === 'HTTP 502 Bad Gateway');
  }
  context.fetch = async () => Response.json({ error: 'Wallet approval required' }, { status: 403 });
  await assert.rejects(context.api('/api/settings/self-sync'), error =>
    error.status === 403 && error.message === 'Wallet approval required');
  context.fetch = async () => new Response('Deployment is locked', { status: 409, headers: { 'content-type': 'text/plain' } });
  await assert.rejects(context.api('/api/settings/self-sync'), error =>
    error.status === 409 && error.message === 'Deployment is locked');
  context.fetch = async () => Response.json({ running: false });
  assert.equal((await context.api('/api/settings/self-sync')).running, false);
});

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
  assert.equal(f.element('#deployment-console').children[0].className, 'console-source');
  assert.equal(f.element('#deployment-console').children[2].className, 'console-info');
  assert.equal(f.element('#deployment-console').children[6].className, 'console-error');
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
  assert.equal(f.element('#deployment-console').textContent, '--- Upload deployment ---\nRemote deployment failed.');
});
test('one action panel and one console retain both operation logs without polling overwrites', async () => {
  const status = { running: true, logs: [{ at: 1, message: 'Upload verified' }] };
  const f = await fixture(status, { available: true, running: false, logs: [{ at: 2, message: 'Git build complete' }] });
  const html = vm.runInContext('deploymentControlsHtml()', f.context);
  assert.equal((html.match(/role="log"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="self-sync-console"/);
  const { parse } = require('parse5');
  const tree = parse(html), parents = new Map(), nodes = new Map();
  const walk = (node, parent) => {
    parents.set(node, parent);
    const id = node.attrs?.find(attr => attr.name === 'id')?.value;
    if (id) nodes.set(id, node);
    for (const child of node.childNodes || []) walk(child, node);
  };
  walk(tree);
  const section = node => node.tagName === 'section' ? node : section(parents.get(node));
  assert.equal(section(nodes.get('deployment-start')), section(nodes.get('self-sync-start')));
  const output = () => f.element('#deployment-console').textContent;
  assert.match(output(), /Upload deployment[\s\S]*Upload verified[\s\S]*Git self-sync[\s\S]*Git build complete/);
  status.logs.push({ at: 3, message: 'Upload complete' });
  await f.refresh();
  assert.match(output(), /Upload complete[\s\S]*Git self-sync[\s\S]*Git build complete/);
  f.setSelfStatus({ available: true, running: false, logs: [{ at: 4, message: '<unsafe> Git failed' }] });
  await f.click('#self-sync-refresh');
  assert.match(output(), /Upload complete[\s\S]*<unsafe> Git failed/);
  assert.equal(output().split('Upload complete').length - 1, 1);
  assert(!f.element('#deployment-console').children.some(child => child.innerHTML));
});
