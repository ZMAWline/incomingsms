import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadModule } from './helpers/load-worker.mjs';
import { hashPassword, verifyPassword, signDashboardSession, readDashboardSession, sha256Hex } from '../src/shared/portal-auth.mjs';
import { isUnexpired } from '../src/dashboard/auth/common.mjs';

const worker = (await loadModule('src/dashboard/index.js')).default;
const env = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'fake', DASHBOARD_SESSION_SECRET: 'test-secret' };
const password = 'a-long-test-password';
const password_hash = await hashPassword(password);
const cookie = 'dsh_auth=' + await signDashboardSession(env.DASHBOARD_SESSION_SECRET, 'session-1');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const originalFetch = globalThis.fetch;
let steps, unexpected, calls, session;
beforeEach(() => {
  steps = []; unexpected = []; calls = [];
  session = { id: 'session-1', expires_at: new Date(Date.now() + 3600000).toISOString(), revoked_at: null,
    dashboard_users: { id: 'user-1', username: 'Alice', role: 'viewer', status: 'active' } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    const call = { url, method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/dashboard_audit_log' && method === 'POST') return json({});
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/dashboard_sessions' && method === 'GET') return json([session]);
    const step = steps.shift();
    if (!step || url.origin !== env.SUPABASE_URL || url.pathname !== '/rest/v1/' + step.table || method !== step.method) {
      unexpected.push(`${method} ${url}`); throw Error('Unexpected fetch');
    }
    if (step.check) step.check(call);
    if (step.value instanceof Error) throw step.value;
    return json(step.value ?? {}, step.status || 200);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; assert.deepEqual(unexpected, []); assert.equal(steps.length, 0, 'all expected requests occurred'); });
const expect = (table, method, value, check, status) => steps.push({ table, method, value, check, status });
async function request(path, { body, auth = false, headers = {}, method = body ? 'POST' : 'GET', extraEnv = {} } = {}) {
  const pending = [];
  const response = await worker.fetch(new Request('https://dashboard.test' + path, { method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) }), { ...env, ...extraEnv,
    ASSETS: { fetch() { unexpected.push('private assets accessed'); throw Error('Unexpected asset access'); } } },
    { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  return response;
}
const user = () => ({ id: 'user-1', username: 'Alice', role: 'viewer', status: 'active', password_hash, failed_login_count: 0 });

test('login folds username, verifies password, persists session and issues signed secure cookie', async () => {
  expect('dashboard_users', 'GET', [user()], c => assert.equal(c.url.searchParams.get('username_folded'), 'eq.alice'));
  let stored;
  expect('dashboard_sessions', 'POST', {}, c => { stored = c.body; assert.equal(stored.user_id, 'user-1'); assert.ok(Date.parse(stored.expires_at) > Date.now()); });
  expect('dashboard_users', 'PATCH', {}, c => assert.equal(c.body.failed_login_count, 0));
  const res = await request('/auth/login', { body: { username: ' ALICE ', password } });
  assert.equal(res.status, 200);
  const header = res.headers.get('set-cookie');
  assert.match(header, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(await readDashboardSession(env.DASHBOARD_SESSION_SECRET, header.split(';')[0].slice(9)), stored.id);
});

test('bad password increments failures without issuing a session', async () => {
  expect('dashboard_users', 'GET', [user()]);
  expect('dashboard_users', 'PATCH', {}, c => assert.equal(c.body.failed_login_count, 1));
  const res = await request('/auth/login', { body: { username: 'alice', password: 'wrong' } });
  assert.equal(res.status, 401); assert.equal(res.headers.get('set-cookie'), null);
});

test('failed session persistence never logs the user in', async () => {
  expect('dashboard_users', 'GET', [user()]); expect('dashboard_sessions', 'POST', {}, null, 503);
  const res = await request('/auth/login', { body: { username: 'alice', password } });
  assert.equal(res.status, 500); assert.equal(res.headers.get('set-cookie'), null);
});

test('malformed auth cookies are rejected before reaching the database', async () => {
  for (const value of ['%ZZ', '%E0%A4%A', '%']) {
    const res = await request('/auth/me', { headers: { Cookie: 'other=1;dsh_auth=' + value } });
    assert.equal(res.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('cookie parsing accepts semicolons with or without whitespace', async () => {
  for (const separator of [';', '; ', ';\t']) {
    const res = await request('/auth/me', { headers: { Cookie: 'other=1' + separator + cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).username, 'Alice');
  }
});

test('sessions reject malformed, missing and non-string expiry timestamps', async () => {
  for (const expiresAt of ['invalid', '', null, 123, '2026-99-99T00:00:00Z']) {
    session.expires_at = expiresAt;
    assert.equal((await request('/auth/me', { auth: true })).status, 401);
  }
});

test('expiry is exclusive: a session or invite expiring now is already invalid', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(isUnexpired('2026-10-06T12:00:00Z', now), false);
  assert.equal(isUnexpired('2026-10-06T12:00:00.001Z', now), true);
  assert.equal(isUnexpired('invalid', now), false);
});

for (const failure of ['http', 'network']) {
  test(`logout ${failure} failure keeps the cookie so revocation can be retried`, async () => {
    expect('dashboard_sessions', 'PATCH', failure === 'network' ? new Error('offline') : {}, null, 503);
    const res = await request('/auth/logout', { auth: true, body: {} });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal((await res.json()).ok, false);
  });

  test(`password change reports partial success when ${failure} revocation fails`, async () => {
    expect('dashboard_users', 'GET', [user()]);
    let savedHash;
    expect('dashboard_users', 'PATCH', {}, c => { savedHash = c.body.password_hash; });
    expect('dashboard_sessions', 'PATCH', failure === 'network' ? new Error('offline') : {}, null, 503);
    const res = await request('/auth/change-password', { auth: true, body: { current_password: password, new_password: 'another-long-password' } });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.password_changed, true);
    assert.equal(data.other_sessions_signed_out, false);
    assert.equal(await verifyPassword('another-long-password', savedHash), true);
  });

  test(`user update reports partial success when ${failure} revocation fails`, async () => {
    session.dashboard_users.role = 'admin';
    expect('dashboard_users', 'GET', [{ id: 'user-2', role: 'viewer', status: 'active' }]);
    expect('dashboard_users', 'PATCH', {});
    expect('dashboard_sessions', 'PATCH', failure === 'network' ? new Error('offline') : {}, null, 503);
    const res = await request('/api/users/user-2', { auth: true, body: { status: 'disabled' } });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.user_updated, true);
    assert.equal(data.sessions_revoked, false);
  });
}

test('successful logout revokes the current session and clears the cookie', async () => {
  expect('dashboard_sessions', 'PATCH', {}, c => assert.equal(c.url.searchParams.get('id'), 'eq.session-1'));
  const res = await request('/auth/logout', { auth: true, body: {} });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

for (const state of ['revoked', 'expired', 'disabled']) test(`${state} session cannot authenticate`, async () => {
  if (state === 'revoked') session.revoked_at = new Date().toISOString();
  if (state === 'expired') session.expires_at = '2020-01-01T00:00:00Z';
  if (state === 'disabled') session.dashboard_users.status = 'disabled';
  assert.equal((await request('/auth/me', { auth: true })).status, 401);
});

test('unauthenticated JSON endpoints reject access and private assets serve only login HTML', async () => {
  for (const path of ['/api/users', '/auth/me']) assert.equal((await request(path)).status, 401);
  for (const path of ['/', '/static/dashboard-auth.js', '/accept-invite']) {
    const res = await request(path); assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length); for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s[1]));
    assert.doesNotMatch(html, /dashboard-auth\.js/);
  }
});

test('viewer changes own password and revokes other sessions, but cannot manage users or invites', async () => {
  expect('dashboard_users', 'GET', [user()]);
  let newHash;
  expect('dashboard_users', 'PATCH', {}, c => { newHash = c.body.password_hash; });
  expect('dashboard_sessions', 'PATCH', {}, c => {
    assert.equal(c.url.searchParams.get('user_id'), 'eq.user-1');
    assert.equal(c.url.searchParams.get('id'), 'neq.session-1'); assert.ok(c.body.revoked_at);
  });
  assert.equal((await request('/auth/change-password', { auth: true, body: { current_password: password, new_password: 'another-long-password' } })).status, 200);
  assert.equal(await verifyPassword('another-long-password', newHash), true);
  assert.equal((await request('/api/users', { auth: true })).status, 403);
  assert.equal((await request('/api/invites', { auth: true, body: { role: 'admin' } })).status, 403);
});

test('last active admin cannot be demoted; disabling another user requests immediate revocation', async () => {
  session.dashboard_users.role = 'admin';
  expect('dashboard_users', 'GET', [{ id: 'user-1', role: 'admin', status: 'active' }]);
  expect('dashboard_users', 'GET', [{ id: 'user-1' }]);
  assert.equal((await request('/api/users/user-1', { auth: true, body: { role: 'viewer' } })).status, 409);
  expect('dashboard_users', 'GET', [{ id: 'user-2', role: 'viewer', status: 'active' }]);
  expect('dashboard_users', 'PATCH', {}, c => assert.deepEqual(c.body, { status: 'disabled' }));
  expect('dashboard_sessions', 'PATCH', {}, c => { assert.equal(c.url.searchParams.get('user_id'), 'eq.user-2'); assert.ok(c.body.revoked_at); });
  assert.equal((await request('/api/users/user-2', { auth: true, body: { status: 'disabled' } })).status, 200);
});

const invitation = () => ({ id: 'invite-1', role: 'operator', expires_at: new Date(Date.now() + 3600000).toISOString(), consumed_at: null });
const acceptance = { token: 'invitation-token', username: ' NewUser ', password };
test('invites reject malformed expiry without creating an account', async () => {
  for (const expires_at of ['invalid', '', null, 123]) {
    expect('dashboard_invites', 'GET', [{ ...invitation(), expires_at }]);
    assert.equal((await request('/auth/accept-invite', { body: acceptance })).status, 400);
  }
});
test('invite acceptance derives role from invite and consumes it only after creating the account', async () => {
  expect('dashboard_invites', 'GET', [invitation()], c => assert.match(c.url.searchParams.get('token_hash'), /^eq\.[a-f0-9]{64}$/));
  expect('dashboard_users', 'GET', []);
  let hash;
  expect('dashboard_users', 'POST', [{ id: 'new', username: 'NewUser', role: 'operator' }], c => {
    assert.equal(c.body.role, 'operator'); assert.equal(c.body.username_folded, 'newuser'); hash = c.body.password_hash;
  });
  expect('dashboard_invites', 'PATCH', [{ id: 'invite-1' }], c => { assert.equal(c.url.searchParams.get('consumed_at'), 'is.null'); assert.equal(c.body.consumed_by, 'new'); });
  const res = await request('/auth/accept-invite', { body: { ...acceptance, role: 'admin' } });
  assert.equal(res.status, 200); assert.equal(await verifyPassword(password, hash), true);
});
for (const state of ['consumed', 'expired', 'duplicate']) test(`invite rejects ${state} without creating an account`, async () => {
  const inv = invitation(); if (state === 'consumed') inv.consumed_at = new Date().toISOString();
  if (state === 'expired') inv.expires_at = '2020-01-01T00:00:00Z';
  expect('dashboard_invites', 'GET', [inv]);
  if (state === 'duplicate') expect('dashboard_users', 'GET', [{ id: 'existing' }]);
  assert.equal((await request('/auth/accept-invite', { body: acceptance })).status, state === 'duplicate' ? 409 : 400);
});

test('racing invite redemption removes the account it could not bind to the invite', async () => {
  expect('dashboard_invites', 'GET', [invitation()]); expect('dashboard_users', 'GET', []);
  expect('dashboard_users', 'POST', [{ id: 'new', username: 'NewUser', role: 'operator' }]);
  expect('dashboard_invites', 'PATCH', []);
  expect('dashboard_users', 'DELETE', {}, c => assert.equal(c.url.searchParams.get('id'), 'eq.new'));
  assert.equal((await request('/auth/accept-invite', { body: acceptance })).status, 409);
});

test('session credentials take precedence over break-glass and API key credentials', async () => {
  const res = await request('/auth/me', { auth: true, headers: { Authorization: 'Basic ' + btoa('root:pw'), 'X-Api-Key': 'zmaw_live_' + 'a'.repeat(32) }, extraEnv: { DASHBOARD_BREAK_GLASS: 'on', DASHBOARD_AUTH: 'root:pw' } });
  assert.equal((await res.json()).role, 'viewer');
  assert.equal(calls.length, 1);
});

test('admin API keys cannot perform dangerous actions or manage keys', async () => {
  const raw = 'zmaw_live_' + 'a'.repeat(32), hash = await sha256Hex(raw);
  for (const path of ['/api/cancel', '/api/keys']) {
    expect('dashboard_api_keys', 'GET', [{ id: 'key-1', name: 'agent', role: 'admin', enabled: true, revoked_at: null, key_hash: hash }]);
    expect('dashboard_api_keys', 'PATCH', {});
    const res = await request(path, { body: {}, headers: { Authorization: 'Bearer ' + raw } });
    assert.equal(res.status, 403);
  }
});
