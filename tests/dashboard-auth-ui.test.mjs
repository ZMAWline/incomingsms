import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDashboardScripts } from '../scripts/dashboard-scripts.cjs';

const source = readFileSync(new URL('../src/dashboard/public/static/dashboard-auth.js', import.meta.url), 'utf8');
function harness(t) {
  const elements = new Map(), steps = [], calls = [], unexpected = [], toasts = [], redirects = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, { value: '', textContent: '', innerHTML: '', style: {},
        classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } } });
    }
    return elements.get(id);
  }
  const ctx = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [element('write-control')] },
    window: { location: { origin: 'https://dashboard.test', replace(path) { redirects.push(path); } } },
    showToast: (...args) => toasts.push(args), esc: String, fmtWhen: String,
    fetch: async (path, init = {}) => {
      calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const step = steps.shift();
      if (!step || step.path !== path) { unexpected.push(path); throw Error('Unexpected request'); }
      if (step.error) throw Error('offline');
      return new Response(JSON.stringify(step.data), { status: step.status || 200 });
    },
  });
  vm.runInContext(source, ctx);
  t.after(() => { assert.deepEqual(unexpected, []); assert.equal(steps.length, 0); });
  return { ctx, element, calls, toasts, redirects,
    expect(path, data, status = 200) { steps.push({ path, data, status }); },
    expectNetworkFailure(path) { steps.push({ path, error: true }); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
for (const role of ['viewer', 'operator', 'admin']) test(`${role} sees the corresponding navigation and write controls`, async t => {
  const h = harness(t); h.expect('/auth/me', { ok: true, username: 'Alice', role });
  await h.ctx.loadCurrentUser();
  assert.equal(h.element('nav-users').classList.contains('hidden'), role !== 'admin');
  assert.equal(h.element('nav-audit').classList.contains('hidden'), role === 'viewer');
  assert.equal(h.element('write-control').classList.contains('hidden'), role === 'viewer');
  assert.equal(h.element('current-user-badge').textContent, 'Alice · ' + role);
});

test('break-glass profile shows its explanation and hides self-service forms', async t => {
  const h = harness(t); h.expect('/auth/me', { ok: true, username: 'break-glass', role: 'admin', has_profile: false });
  await h.ctx.loadProfile();
  assert.equal(h.element('profile-forms').classList.contains('hidden'), true);
  assert.equal(h.element('profile-breakglass').classList.contains('hidden'), false);
});

for (const failure of ['http', 'network']) test(`failed ${failure} session check removes stale admin controls`, async t => {
  const h = harness(t);
  h.expect('/auth/me', { ok: true, username: 'Alice', role: 'admin' });
  await h.ctx.loadCurrentUser();
  assert.equal(h.element('write-control').classList.contains('hidden'), false);
  if (failure === 'network') h.expectNetworkFailure('/auth/me');
  else h.expect('/auth/me', { ok: false }, 401);
  await h.ctx.loadProfile();
  for (const id of ['nav-users', 'nav-audit', 'write-control', 'profile-forms']) {
    assert.equal(h.element(id).classList.contains('hidden'), true, id);
  }
  assert.equal(h.element('current-user-badge').textContent, 'Not signed in');
  assert.equal(vm.runInContext('CURRENT_USER', h.ctx), null);
});

for (const result of ['success', 'http', 'network']) test(`logout ${result} only redirects after confirmed success`, async t => {
  const h = harness(t);
  if (result === 'network') h.expectNetworkFailure('/auth/logout');
  else h.expect('/auth/logout', { ok: result === 'success', error: 'Could not sign out. Try again.' }, result === 'success' ? 200 : 502);
  await h.ctx.logout();
  assert.equal(h.calls[0].method, 'POST');
  assert.deepEqual(h.redirects, result === 'success' ? ['/'] : []);
  if (result !== 'success') assert.match(h.toasts[0][0], /Could not sign out/);
});

test('password partial success clears old credentials and explains the failed sign-out', async t => {
  const h = harness(t);
  h.element('pf-cur-pw').value = 'old-password';
  h.element('pf-new-pw').value = h.element('pf-new-pw2').value = 'new-long-password';
  const message = 'Password changed, but other sessions could not be signed out. Contact an administrator.';
  h.expect('/auth/change-password', { ok: false, password_changed: true, other_sessions_signed_out: false, error: message }, 502);
  await h.ctx.changePassword();
  for (const id of ['pf-cur-pw', 'pf-new-pw', 'pf-new-pw2']) assert.equal(h.element(id).value, '');
  assert.equal(h.element('pf-password-msg').textContent, message);
  assert.equal(h.element('pf-password-msg').style.color, '#991b1b');
});

for (const success of [true, false]) test(`password change ${success ? 'clears credentials after success' : 'shows server error without claiming success'}`, async t => {
  const h = harness(t);
  h.element('pf-cur-pw').value = 'old-password';
  h.element('pf-new-pw').value = h.element('pf-new-pw2').value = 'new-long-password';
  h.expect('/auth/change-password', success ? { ok: true } : { ok: false, error: 'Current password is incorrect' }, success ? 200 : 403);
  await h.ctx.changePassword();
  assert.deepEqual(h.calls[0], { path: '/auth/change-password', method: 'POST', body: { current_password: 'old-password', new_password: 'new-long-password' } });
  assert.equal(h.element('pf-cur-pw').value, success ? '' : 'old-password');
  assert.match(h.element('pf-password-msg').textContent, success ? /Password updated/ : /Current password is incorrect/);
});

test('mismatched passwords do not submit; successful username update refreshes profile', async t => {
  const h = harness(t); h.element('pf-new-pw').value = 'new-long-password'; h.element('pf-new-pw2').value = 'different';
  await h.ctx.changePassword(); assert.equal(h.calls.length, 0);
  assert.match(h.element('pf-password-msg').textContent, /do not match/);
  h.element('pf-username').value = ' NewName '; h.element('pf-username-pw').value = 'password';
  h.expect('/auth/change-username', { ok: true }); h.expect('/auth/me', { ok: true, username: 'NewName', role: 'viewer' });
  await h.ctx.changeUsername(); await settle();
  assert.deepEqual(h.calls[0].body, { username: 'NewName', current_password: 'password' });
  assert.equal(h.element('pf-username-pw').value, '');
  assert.equal(h.element('profile-username').textContent, 'NewName');
});

test('invite creation sends chosen role and displays usable link', async t => {
  const h = harness(t); h.element('invite-role').value = 'operator'; h.element('invite-username').value = ' Alice ';
  h.expect('/api/invites', { ok: true, accept_path: '/accept-invite?token=example' });
  h.expect('/api/users', { users: [], pending_invites: [] }); h.expect('/api/keys', { keys: [] });
  await h.ctx.createInvite(); await settle();
  assert.deepEqual(h.calls[0].body, { role: 'operator', username: 'Alice' });
  assert.equal(h.element('invite-link').value, 'https://dashboard.test/accept-invite?token=example');
  assert.equal(h.element('invite-result').classList.contains('hidden'), false);
});

test('key creation displays returned secret once and listing shows only the prefix', async t => {
  const h = harness(t); h.element('apikey-name').value = ' agent '; h.element('apikey-role').value = 'viewer';
  const key = 'zmaw_live_this-is-the-secret';
  h.expect('/api/keys', { ok: true, key });
  h.expect('/api/keys', { keys: [{ name: 'agent', role: 'viewer', enabled: true, key_prefix: 'zmaw_live_thi' }] });
  await h.ctx.createApiKey(); await settle();
  assert.deepEqual(h.calls[0].body, { name: 'agent', role: 'viewer' });
  assert.equal(h.element('apikey-plaintext').value, key);
  assert.equal(h.element('apikey-result').classList.contains('hidden'), false);
  assert.equal(h.element('apikey-name').value, '');
  assert.match(h.toasts[0][0], /Copy it now/);
  assert.doesNotMatch(h.element('apikeys-tbody').innerHTML, /this-is-the-secret/);
});

test('script loader executes classic scripts in document order and includes shipped auth globals', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-scripts-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'local.js'), 'order.push("local");');
  writeFileSync(join(dir, 'index.html'), '<script>var order = ["inline"];</script><script src="/local.js?v=1"></script><script src="https://cdn.test/vendor.js"></script><script type="application/json">not javascript</script><script>order.push("last");</script>');
  const ctx = vm.createContext({}); for (const script of readDashboardScripts(join(dir, 'index.html'))) vm.runInContext(script.source, ctx);
  assert.equal(JSON.stringify(ctx.order), '["inline","local","last"]');
  const scripts = readDashboardScripts(fileURLToPath(new URL('../src/dashboard/public/index.html', import.meta.url)));
  assert.equal(scripts.filter(s => s.filename.endsWith('/dashboard-auth.js')).length, 1);
  // Compiling all scripts catches cross-script lexical collisions as well as syntax errors.
  assert.doesNotThrow(() => new vm.Script(scripts.map(s => s.source).join('\n')));
  const authContext = vm.createContext({});
  const authScript = scripts.find(s => s.filename.endsWith('/dashboard-auth.js'));
  vm.runInContext(authScript.source, authContext);
  assert.equal(typeof authContext.loadCurrentUser, 'function');
  assert.equal(typeof authContext.changePassword, 'function');
});

test('script loader rejects missing files and paths or symlinks outside public', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-scripts-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pub = join(dir, 'public'); mkdirSync(pub); writeFileSync(join(dir, 'outside.js'), 'secret');
  symlinkSync(join(dir, 'outside.js'), join(pub, 'linked.js'));
  for (const src of ['/missing.js', '/../outside.js', '/linked.js']) {
    writeFileSync(join(pub, 'index.html'), `<script src="${src}"></script>`);
    assert.throws(() => readDashboardScripts(join(pub, 'index.html')), /ENOENT|escapes public directory/);
  }
});
