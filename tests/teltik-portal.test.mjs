// teltik-portal worker tests — login gating, Teltik-hosted-only scoping,
// per-line check/reset, and bulk check. Mocks fetch as a fake
// PostgREST/RPC/Teltik backend; no live DB or vendor API involved.
//
// Loaded via a data: URL import (same trick as tests/otp-portal.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashPassword } from '../src/teltik-portal/auth.mjs';

const authUrl = new URL('../src/teltik-portal/auth.mjs', import.meta.url).href;
const hostingPortStatusUrl = new URL('../src/shared/hosting-port-status.mjs', import.meta.url).href;
const workerSrc = (await readFile(new URL('../src/teltik-portal/index.js', import.meta.url), 'utf8'))
  .replace("'./auth.mjs'", JSON.stringify(authUrl))
  .replace("'../shared/hosting-port-status.mjs'", JSON.stringify(hostingPortStatusUrl));
const teltikPortal = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const realFetch = globalThis.fetch;

const USERNAME = 'teltik-support';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  TELTIK_API_KEY: 'tk',
  TELTIK_PORTAL_USERNAME: USERNAME,
  TELTIK_PORTAL_PASSWORD_HASH: PASSWORD_HASH,
  TELTIK_PORTAL_SESSION_SECRET: 'test-session-secret',
};

function jsonRes(data, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function loginCookie() {
  const res = await teltikPortal.fetch(new Request('https://x/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  }), ENV);
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('Set-Cookie');
  return setCookie.split(';')[0];
}

function authedRequest(url, init, cookie) {
  return new Request(url, { ...init, headers: { ...(init && init.headers), Cookie: cookie } });
}

// In-scope Teltik-hosted line (explicit host) and an out-of-scope line
// (different vendor, non-teltik host) — the scoping filter must exclude it
// from both the list and per-line actions.
const SIMS = [
  { id: 1, iccid: 'ICC1', vendor: 'atomic', gateway_host: 'teltik', status: 'active', sim_numbers: [{ e164: '+12125551111' }] },
  { id: 2, iccid: 'ICC2', vendor: 'teltik', gateway_host: null, status: 'active', sim_numbers: [{ e164: '+12125552222' }] },
  { id: 3, iccid: 'ICC3', vendor: 'atomic', gateway_host: 'skyline', status: 'active', sim_numbers: [{ e164: '+12125553333' }] },
];

function fakeBackend({ posted = [], apiLogs = [], resetSuccess = true } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';

    if (u.pathname === '/rest/v1/sims') {
      // Scoping filter: gateway_host.eq.teltik OR (gateway_host.is.null AND vendor.eq.teltik)
      const idParam = u.searchParams.get('id');
      let rows = SIMS.filter((s) => s.gateway_host === 'teltik' || (s.gateway_host == null && s.vendor === 'teltik'));
      if (idParam && idParam.startsWith('eq.')) {
        const id = Number(idParam.slice(3));
        rows = rows.filter((s) => s.id === id);
      }
      return jsonRes(rows);
    }
    if (u.pathname === '/rest/v1/rpc/get_hosting_port_status_summary') {
      const body = JSON.parse(init.body);
      return jsonRes(body.sim_ids.map((id) => ({
        sim_id: id, last_state: 'online', last_checked_at: '2026-08-19T00:00:00Z', last_source: 'cron',
        last_mdn: '2125551111', last_mdn_source: 'teltik_inbound_sms_payload_mdn', last_http_status: 200, last_error: null,
        checks_24h: 4, online_24h: 4, checks_7d: 28, online_7d: 26,
      })));
    }
    if (u.pathname === '/rest/v1/inbound_sms') {
      return jsonRes([]); // no payload MDN → falls to inventory/DB
    }
    if (u.pathname === '/v1/get-phone-number/') {
      return jsonRes({ msisdn: '2125551111' });
    }
    if (u.pathname === '/rest/v1/hosting_port_status_checks') {
      posted.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }
    if (u.pathname === '/rest/v1/carrier_api_logs') {
      apiLogs.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }
    if (u.pathname === '/v1/port-status') {
      return jsonRes({ port_status: 'online' });
    }
    if (u.pathname === '/v1/reset-port') {
      return resetSuccess ? jsonRes({ success: true, request_id: 'req_1' }) : jsonRes({ success: false, message: 'boom' }, 200);
    }
    throw new Error('unexpected fetch ' + u.pathname);
  };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

// --- auth gating -------------------------------------------------------

test('API routes 401 without a session cookie', async () => {
  fakeBackend();
  const res = await teltikPortal.fetch(new Request('https://x/api/lines'), ENV);
  assert.equal(res.status, 401);
});

test('GET / shows the login page when unauthenticated, the app page when authenticated', async () => {
  fakeBackend();
  const anon = await teltikPortal.fetch(new Request('https://x/'), ENV);
  const anonHtml = await anon.text();
  assert.ok(anonHtml.includes('Sign in'));

  const cookie = await loginCookie();
  const authed = await teltikPortal.fetch(authedRequest('https://x/', {}, cookie), ENV);
  const authedHtml = await authed.text();
  assert.ok(authedHtml.includes('Teltik hosted lines'));
});

test('wrong password never reaches Supabase and fails login', async () => {
  let sbCalled = false;
  globalThis.fetch = async (url) => { sbCalled = true; throw new Error('should not be called: ' + url); };
  const res = await teltikPortal.fetch(new Request('https://x/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: 'wrong' }),
  }), ENV);
  assert.equal(res.status, 401);
  assert.equal(sbCalled, false);
});

// --- scoping -------------------------------------------------------------

test('GET /api/lines returns only Teltik-hosted lines, excluding other gateway hosts', async () => {
  fakeBackend();
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines', {}, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  const ids = data.lines.map((l) => l.sim_id).sort();
  assert.deepEqual(ids, [1, 2], 'sim 3 (skyline host) excluded');
  assert.equal(data.lines.find((l) => l.sim_id === 1).state, 'online');
  assert.equal(data.lines.find((l) => l.sim_id === 1).online_7d, 26);
  // Current MDN (from sim_numbers) vs Hosted MDN (Teltik's own resolved MDN,
  // from get_hosting_port_status_summary.last_mdn) are distinct fields — the
  // portal surfaces both since they can legitimately differ.
  const line1 = data.lines.find((l) => l.sim_id === 1);
  assert.equal(line1.mdn, '+12125551111');
  assert.equal(line1.hosted_mdn, '2125551111');
});

test('per-line check/reset on an out-of-scope sim id returns 404, never calls Teltik', async () => {
  const posted = [], apiLogs = [];
  fakeBackend({ posted, apiLogs });
  const cookie = await loginCookie();

  const checkRes = await teltikPortal.fetch(authedRequest('https://x/api/lines/3/check', { method: 'POST' }, cookie), ENV);
  assert.equal(checkRes.status, 404);
  assert.equal(posted.length, 0);

  const resetRes = await teltikPortal.fetch(authedRequest('https://x/api/lines/3/reset', { method: 'POST' }, cookie), ENV);
  assert.equal(resetRes.status, 404);
  assert.equal(apiLogs.length, 0);
});

// --- per-line actions ------------------------------------------------------

test('POST /api/lines/:id/check records a check for an in-scope line', async () => {
  const posted = [];
  fakeBackend({ posted });
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines/1/check', { method: 'POST' }, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.result.state, 'online');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].sim_id, 1);
  assert.equal(posted[0].source, 'teltik_portal');
});

test('POST /api/lines/:id/reset succeeds and mirrors to carrier_api_logs without leaking the API key', async () => {
  const apiLogs = [];
  fakeBackend({ apiLogs, resetSuccess: true });
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines/1/reset', { method: 'POST' }, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(apiLogs.length, 1);
  assert.equal(apiLogs[0].step, 'reset_port');
  assert.equal(apiLogs[0].vendor, 'teltik');
  assert.equal(apiLogs[0].response_ok, true);
  assert.ok(!JSON.stringify(apiLogs).includes(ENV.TELTIK_API_KEY), 'API key never logged');
});

test('POST /api/lines/:id/reset surfaces a Teltik success:false body as a failure', async () => {
  fakeBackend({ resetSuccess: false });
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines/1/reset', { method: 'POST' }, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(res.status, 502);
  assert.match(data.result.error, /boom/);
});

// --- bulk check --------------------------------------------------------

test('POST /api/lines/check-bulk checks multiple in-scope lines and returns an aggregate summary', async () => {
  const posted = [];
  fakeBackend({ posted });
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines/check-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sim_ids: [1, 2] }),
  }, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.total, 2);
  assert.equal(data.online, 2);
  assert.equal(posted.length, 2);
});

test('POST /api/lines/check-bulk with no sim_ids is a 400, not a full-fleet sweep', async () => {
  fakeBackend();
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines/check-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sim_ids: [] }),
  }, cookie), ENV);
  assert.equal(res.status, 400);
});
