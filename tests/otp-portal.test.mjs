// otp-portal worker integration tests — login gating, per-browser assignment
// stability, SMS scope, no-number state, and (critically) that nothing but
// the otp_portal_claim RPC is ever written to. Mocks fetch as a fake
// PostgREST/RPC backend; no live DB, no carrier API involved (this worker
// makes no carrier calls at all).
//
// Loaded via a data: URL import (same trick as tests/sms-disable.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashPassword } from '../src/otp-portal/auth.mjs';

const logicUrl = new URL('../src/otp-portal/logic.mjs', import.meta.url).href;
const authUrl = new URL('../src/otp-portal/auth.mjs', import.meta.url).href;
const workerSrc = (await readFile(new URL('../src/otp-portal/index.js', import.meta.url), 'utf8'))
  .replace("'./logic.mjs'", JSON.stringify(logicUrl))
  .replace("'./auth.mjs'", JSON.stringify(authUrl));
const otpPortal = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const realFetch = globalThis.fetch;
const realRandom = Math.random;

const USERNAME = 'test-user';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  OTP_PORTAL_USERNAME: USERNAME,
  OTP_PORTAL_PASSWORD_HASH: PASSWORD_HASH,
  OTP_PORTAL_SESSION_SECRET: 'test-session-secret',
};

function jsonRes(data, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function parseIn(param) {
  if (!param || !param.startsWith('in.(')) return [];
  return param.slice(4, -1).split(',').map((s) => Number(decodeURIComponent(s)));
}

// Minimal fake PostgREST + RPC backend, backed by in-memory fixtures. Records
// every call so tests can assert on write scope, not just responses.
function fakeBackend({ pool = [], sims = [], numbers = [], shopRentals = [], messagesBySim = {}, forceTakenSims = new Set() }) {
  const assignments = [];
  let nextId = 1;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const method = (init && init.method) || 'GET';
    calls.push({ method, path: u.pathname + u.search });
    const qp = u.searchParams;

    if (u.pathname === '/rest/v1/shop_pool') {
      return jsonRes(pool.map((sim_id) => ({ sim_id })));
    }
    if (u.pathname === '/rest/v1/sims') {
      const ids = parseIn(qp.get('id'));
      const rows = sims.filter((s) => ids.includes(s.id));
      return jsonRes(rows.map((s) => ({ id: s.id, vendor: s.vendor })));
    }
    if (u.pathname === '/rest/v1/sim_numbers') {
      const ids = parseIn(qp.get('sim_id'));
      const rows = numbers.filter((n) => ids.includes(n.sim_id));
      return jsonRes(rows.map((n) => ({ sim_id: n.sim_id, e164: n.e164 })));
    }
    if (u.pathname === '/rest/v1/shop_rentals') {
      const raw = qp.get('sim_id') || '';
      const ids = parseIn(raw);
      const rows = shopRentals.filter((r) => ids.includes(r.sim_id) && r.status === 'active');
      return jsonRes(rows.map((r) => ({ sim_id: r.sim_id })));
    }
    if (u.pathname === '/rest/v1/otp_portal_assignments') {
      if (method !== 'GET') throw new Error('otp_portal_assignments must never be written directly, only via the RPC');
      const simIdParam = qp.get('sim_id');
      if (simIdParam && simIdParam.startsWith('in.')) {
        const ids = parseIn(simIdParam);
        const cutoffRaw = (qp.get('expires_at') || '').replace('gt.', '');
        const cutoff = cutoffRaw ? Date.parse(cutoffRaw) : -Infinity;
        const rows = assignments.filter((a) => ids.includes(a.sim_id) && Date.parse(a.expires_at) > cutoff);
        return jsonRes(rows.map((a) => ({ sim_id: a.sim_id })));
      }
      const sessionParam = qp.get('session_token');
      if (sessionParam) {
        const token = decodeURIComponent(sessionParam.replace('eq.', ''));
        const row = assignments.find((a) => a.session_token === token);
        return jsonRes(row ? [row] : []);
      }
      const idParam = qp.get('id');
      if (idParam) {
        const id = Number(idParam.replace('eq.', ''));
        const row = assignments.find((a) => a.id === id);
        return jsonRes(row ? [row] : []);
      }
      return jsonRes([]);
    }
    if (u.pathname === '/rest/v1/inbound_sms') {
      const simId = Number((qp.get('sim_id') || '').replace('eq.', ''));
      const gte = (qp.get('received_at') || '').replace('gte.', '');
      const cutoff = Date.parse(gte);
      const rows = (messagesBySim[simId] || []).filter((m) => Date.parse(m.received_at) >= cutoff);
      return jsonRes(rows);
    }
    if (u.pathname === '/rest/v1/rpc/otp_portal_claim') {
      const body = JSON.parse(init.body);
      const nowMs = Date.now();
      const taken =
        forceTakenSims.has(body.p_sim_id) ||
        assignments.some((a) => a.sim_id === body.p_sim_id && Date.parse(a.expires_at) > nowMs) ||
        shopRentals.some((r) => r.sim_id === body.p_sim_id && r.status === 'active');
      if (taken) return { ok: false, status: 400, text: async () => 'sim_taken' };
      const id = nextId++;
      const assignedAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + body.p_ttl_minutes * 60000).toISOString();
      assignments.push({
        id, session_token: body.p_session_token, sim_id: body.p_sim_id,
        e164: body.p_e164, carrier: body.p_carrier, assigned_at: assignedAt, expires_at: expiresAt,
      });
      return { ok: true, status: 200, text: async () => String(id) };
    }
    throw new Error('unexpected fetch: ' + u.pathname + u.search);
  };

  return { calls, assignments };
}

function req(path, { method = 'GET', cookies = {}, body } = {}) {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const headers = {};
  if (cookieStr) headers.Cookie = cookieStr;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request('https://otp-portal.test' + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cookieFromSetCookie(res, name) {
  // Response can carry multiple Set-Cookie headers; Headers#get only returns
  // the first, so read them all via getSetCookie (undici) with a fallback.
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('Set-Cookie')].filter(Boolean);
  for (const sc of all) {
    const m = sc.match(new RegExp(name + '=([^;]*)'));
    if (m) return m[1];
  }
  return null;
}

async function login(env = ENV) {
  const res = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } }),
    env,
  );
  const authCookie = cookieFromSetCookie(res, 'otpp_auth');
  return { res, authCookie };
}

// --- login required / bad login never touches the DB ------------------------

test('root page without a session shows the login page, not the app, and touches no DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(req('/'), ENV);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Sign in/);
  assert.equal(calls.length, 0, 'serving the login page never touches Supabase');
});

test('api/state and api/messages 401 without a valid session and never touch the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const state = await otpPortal.fetch(req('/api/state'), ENV);
  assert.equal(state.status, 401);
  const messages = await otpPortal.fetch(req('/api/messages'), ENV);
  assert.equal(messages.status, 401);

  assert.equal(calls.length, 0, 'no Supabase call happens before authentication');
});

test('wrong username is rejected and never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: 'not-yossi', password: PASSWORD } }),
    ENV,
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(cookieFromSetCookie(res, 'otpp_auth'), null, 'no session cookie on a failed login');
  assert.equal(calls.length, 0, 'username verification is pure local compare — never calls Supabase');
});

test('username matching is case-insensitive: lowercase, uppercase, and mixed-case all accepted with the correct password', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  for (const candidate of [USERNAME.toLowerCase(), USERNAME.toUpperCase(), '  ' + USERNAME.toUpperCase() + '  ']) {
    fakeBackend({});
    const res = await otpPortal.fetch(
      req('/login', { method: 'POST', body: { username: candidate, password: PASSWORD } }),
      ENV,
    );
    assert.equal(res.status, 200, `expected ${JSON.stringify(candidate)} to be accepted`);
    assert.ok(cookieFromSetCookie(res, 'otpp_auth'), 'sets a session cookie on success');
  }
});

test('a username that only differs by more than case is still rejected, and never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME.toUpperCase() + 'x', password: PASSWORD } }),
    ENV,
  );
  assert.equal(res.status, 401);
  assert.equal(cookieFromSetCookie(res, 'otpp_auth'), null);
  assert.equal(calls.length, 0, 'username verification is pure local compare — never calls Supabase');
});

test('wrong password is rejected and never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME, password: 'nope-not-it' } }),
    ENV,
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(cookieFromSetCookie(res, 'otpp_auth'), null, 'no session cookie on a failed login');
  assert.equal(calls.length, 0, 'password verification is pure local PBKDF2 — never calls Supabase');
});

test('missing username is rejected and never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { password: PASSWORD } }),
    ENV,
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('missing password body is rejected and never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(req('/login', { method: 'POST', body: { username: USERNAME } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('login with missing OTP_PORTAL_USERNAME, OTP_PORTAL_PASSWORD_HASH, or OTP_PORTAL_SESSION_SECRET always fails, never touches the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const noUsername = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } }),
    { ...ENV, OTP_PORTAL_USERNAME: undefined },
  );
  assert.equal(noUsername.status, 401);

  const noHash = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } }),
    { ...ENV, OTP_PORTAL_PASSWORD_HASH: undefined },
  );
  assert.equal(noHash.status, 401);

  const noSecret = await otpPortal.fetch(
    req('/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } }),
    { ...ENV, OTP_PORTAL_SESSION_SECRET: undefined },
  );
  assert.equal(noSecret.status, 401);

  assert.equal(calls.length, 0);
});

test('a forged/garbage session cookie is rejected without touching the DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});

  const res = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: 'garbage.not-a-real-token' } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

// --- good login creates a session -------------------------------------------

test('correct username and password sets a signed HttpOnly session cookie and serves the app page', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({});

  const { res, authCookie } = await login();
  assert.equal(res.status, 200);
  assert.ok(authCookie, 'login sets otpp_auth');
  const setCookieHeader = res.headers.get('Set-Cookie');
  assert.match(setCookieHeader, /HttpOnly/);
  assert.match(setCookieHeader, /Secure/);
  assert.match(setCookieHeader, /SameSite=Lax/);

  const page = await otpPortal.fetch(req('/', { cookies: { otpp_auth: authCookie } }), ENV);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Your temporary number/);
});

test('/health works without a session and reveals nothing', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({});
  const res = await otpPortal.fetch(req('/health'), ENV);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(calls.length, 0);
});

test('unknown routes 404 regardless of auth state', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({});
  const { authCookie } = await login();

  const loggedOut = await otpPortal.fetch(req('/nope'), ENV);
  assert.equal(loggedOut.status, 404);
  const loggedIn = await otpPortal.fetch(req('/api/nope', { cookies: { otpp_auth: authCookie } }), ENV);
  assert.equal(loggedIn.status, 404);
});

// --- logout -------------------------------------------------------------------

test('logout clears the session cookie and the root page reverts to the login screen', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({});
  const { authCookie } = await login();

  const logoutRes = await otpPortal.fetch(req('/logout', { method: 'POST', cookies: { otpp_auth: authCookie } }), ENV);
  assert.equal(logoutRes.status, 200);
  const cleared = logoutRes.headers.get('Set-Cookie');
  assert.match(cleared, /otpp_auth=;/);
  assert.match(cleared, /Max-Age=0/);

  // The cleared cookie value from the response is the empty string — simulate
  // the browser dropping the cookie entirely by omitting it on the next request.
  const after = await otpPortal.fetch(req('/'), ENV);
  const html = await after.text();
  assert.match(html, /Sign in/);

  const stateAfterLogout = await otpPortal.fetch(req('/api/state'), ENV);
  assert.equal(stateAfterLogout.status, 401);
});

// --- no-number-available -----------------------------------------------------

test('no numbers in the pool -> clear no-number state, nothing claimed', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({ pool: [] });
  const { authCookie } = await login();

  const res = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.has_number, false);
  assert.equal(body.no_number_available, true);
});

test('every candidate already rented or held -> no-number state', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({
    pool: [1],
    sims: [{ id: 1, vendor: 'atomic' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }],
    shopRentals: [{ sim_id: 1, status: 'active' }],
  });
  const { authCookie } = await login();

  const res = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const body = await res.json();
  assert.equal(body.has_number, false);
  assert.equal(body.no_number_available, true);
});

// --- random assignment + per-browser stability ------------------------------

test('assigns a number, keeps the same one across reloads for the same session cookie', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({
    pool: [1, 2, 3],
    sims: [{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'teltik' }, { id: 3, vendor: 'atomic' }],
    numbers: [
      { sim_id: 1, e164: '+13475551111' },
      { sim_id: 2, e164: '+13475552222' },
      { sim_id: 3, e164: '+13475553333' },
    ],
  });
  const { authCookie } = await login();

  const first = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const firstBody = await first.json();
  assert.equal(firstBody.has_number, true);
  const sid = cookieFromSetCookie(first, 'otpp_sid');
  assert.ok(sid, 'an assignment cookie is set on first assignment');

  const claimCallsAfterFirst = calls.filter((c) => c.path.includes('rpc/otp_portal_claim')).length;
  assert.equal(claimCallsAfterFirst, 1);

  // Same browser (both cookies) reloads twice — must see the identical number both times.
  const cookies = { otpp_auth: authCookie, otpp_sid: sid };
  const second = await otpPortal.fetch(req('/api/state', { cookies }), ENV);
  const secondBody = await second.json();
  const third = await otpPortal.fetch(req('/api/state', { cookies }), ENV);
  const thirdBody = await third.json();

  assert.equal(secondBody.e164, firstBody.e164);
  assert.equal(secondBody.assigned_at, firstBody.assigned_at);
  assert.equal(thirdBody.e164, firstBody.e164);

  const claimCallsAfterReloads = calls.filter((c) => c.path.includes('rpc/otp_portal_claim')).length;
  assert.equal(claimCallsAfterReloads, 1, 'reloading with the existing cookie never re-claims a number');
});

test('a different session (no/blank assignment cookie) gets its own independent assignment', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({
    pool: [1, 2],
    sims: [{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'teltik' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }, { sim_id: 2, e164: '+13475552222' }],
  });
  const { authCookie } = await login();

  const a = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const aBody = await a.json();
  const b = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV); // fresh request, no sid cookie
  const bBody = await b.json();

  assert.notEqual(aBody.e164, bBody.e164, 'two different browsers never share the same held number');
});

test('lost race on the first pick retries with a different candidate instead of failing', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; Math.random = realRandom; });
  fakeBackend({
    pool: [10, 11],
    sims: [{ id: 10, vendor: 'atomic' }, { id: 11, vendor: 'atomic' }],
    numbers: [{ sim_id: 10, e164: '+13475551010' }, { sim_id: 11, e164: '+13475551011' }],
    forceTakenSims: new Set([10]), // simulates someone else claiming it between query and claim
  });
  const { authCookie } = await login();
  Math.random = () => 0; // always "pick the first candidate" — forces the race on sim 10 first

  const res = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const body = await res.json();
  assert.equal(body.has_number, true);
  assert.equal(body.e164, '+13475551011', 'fell back to the other candidate after losing the race for sim 10');
});

// --- SMS scope ---------------------------------------------------------------

test('messages endpoint only returns SMS to the assigned number at/after assignment time', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  // messagesBySim is mutated in place after the assignment exists, so the mock
  // always reflects "SMS that has arrived so far" the way a live DB would.
  const messagesBySim = {
    1: [
      { to_number: '+13475551111', from_number: 'Google', body: 'old code 111111', received_at: '2020-01-01T00:00:00Z' },
    ],
  };
  const { assignments } = fakeBackend({
    pool: [1],
    sims: [{ id: 1, vendor: 'atomic' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }],
    messagesBySim,
  });
  const { authCookie } = await login();

  const state = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const sid = cookieFromSetCookie(state, 'otpp_sid');
  const assignedAtMs = Date.parse(assignments[0].assigned_at);

  // Arrives after assignment, right number — should show up.
  messagesBySim[1].push({
    to_number: '3475551111', from_number: 'Google', body: 'real code 654321',
    received_at: new Date(assignedAtMs + 5000).toISOString(),
  });
  // Arrives after assignment, wrong number — must not show up.
  messagesBySim[1].push({
    to_number: '+13475559999', from_number: 'Google', body: 'wrong number 222222',
    received_at: new Date(assignedAtMs + 6000).toISOString(),
  });

  const messagesRes = await otpPortal.fetch(
    req('/api/messages', { cookies: { otpp_auth: authCookie, otpp_sid: sid } }), ENV,
  );
  const messagesBody = await messagesRes.json();

  assert.equal(messagesRes.status, 200);
  assert.equal(messagesBody.messages.length, 1, 'only the post-assignment message to the assigned number is returned');
  assert.equal(messagesBody.messages[0].body, 'real code 654321');
  assert.equal(messagesBody.expired, false);
});

test('messages endpoint returns a no-number state (not an error) with no assignment cookie', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  fakeBackend({ pool: [] });
  const { authCookie } = await login();

  const res = await otpPortal.fetch(req('/api/messages', { cookies: { otpp_auth: authCookie } }), ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.has_number, false);
  assert.deepEqual(body.messages, []);
});

// --- no carrier / unexpected write side effects -----------------------------

test('a full login + assignment + poll cycle never calls anything but Supabase REST/RPC, and only writes via the claim RPC', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { calls } = fakeBackend({
    pool: [1],
    sims: [{ id: 1, vendor: 'atomic' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }],
    messagesBySim: { 1: [] },
  });
  const { authCookie } = await login();

  const state = await otpPortal.fetch(req('/api/state', { cookies: { otpp_auth: authCookie } }), ENV);
  const sid = cookieFromSetCookie(state, 'otpp_sid');
  const cookies = { otpp_auth: authCookie, otpp_sid: sid };
  await otpPortal.fetch(req('/api/messages', { cookies }), ENV);
  await otpPortal.fetch(req('/api/state', { cookies }), ENV);

  for (const c of calls) {
    assert.ok(c.path.startsWith('/rest/v1/'), 'every outbound call is Supabase REST/RPC: ' + c.path);
    if (c.method !== 'GET') {
      assert.equal(c.path.split('?')[0], '/rest/v1/rpc/otp_portal_claim',
        'the only non-GET call in the whole flow is the claim RPC: ' + c.method + ' ' + c.path);
    }
  }
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 1, 'exactly one claim, never re-claimed across a poll + reload');
  assert.equal(calls.length > 0, true, 'login itself made no Supabase calls, but the app flow did');
});
