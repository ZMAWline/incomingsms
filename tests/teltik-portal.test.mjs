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
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : rows.length;
      return jsonRes(rows.slice(offset, offset + limit));
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

// --- pagination --------------------------------------------------------

// Regression: PostgREST silently caps a single response at its own
// db-max-rows setting regardless of a larger `limit=` in the request — a
// one-shot fetch under-reports once the fleet crosses that cap, with no
// error to notice. fetchAllHostedSims must page past it.
test('GET /api/lines pages past a PostgREST-style single-response cap to return the full fleet', async () => {
  const bigFleet = [];
  for (let i = 1; i <= 1500; i++) {
    bigFleet.push({ id: i, iccid: 'ICC' + i, vendor: 'teltik', gateway_host: null, status: 'active', sim_numbers: [{ e164: '+1212555' + String(i).padStart(4, '0') }] });
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/sims') {
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : bigFleet.length;
      return jsonRes(bigFleet.slice(offset, offset + limit));
    }
    if (u.pathname === '/rest/v1/rpc/get_hosting_port_status_summary') {
      const body = JSON.parse(init.body);
      return jsonRes(body.sim_ids.map((id) => ({
        sim_id: id, last_state: 'online', last_checked_at: null, last_source: 'cron',
        last_mdn: null, last_mdn_source: null, last_http_status: 200, last_error: null,
        checks_24h: 0, online_24h: 0, checks_7d: 0, online_7d: 0,
      })));
    }
    throw new Error('unexpected fetch ' + u.pathname);
  };
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/lines', {}, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.lines.length, 1500, 'all 1500 lines returned, not capped at one page');
  assert.equal(data.truncated, false);
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

// --- analytics ---------------------------------------------------------

function analyticsBackend({ dailyRows = [{ day: '2026-08-20', lines_checked: 10, online_lines: 8 }], resetCount = 5, capturedUrls = [] } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    capturedUrls.push(u.pathname + u.search);
    if (u.pathname === '/rest/v1/rpc/get_teltik_daily_uptime') {
      const body = JSON.parse(init.body);
      assert.equal(body.days_back, 30);
      return jsonRes(dailyRows);
    }
    if (u.pathname === '/rest/v1/rental_report_remediation_attempts') {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/' + resetCount },
      });
    }
    throw new Error('unexpected fetch ' + u.pathname);
  };
  return capturedUrls;
}

test('GET /api/analytics requires a session', async () => {
  analyticsBackend();
  const res = await teltikPortal.fetch(new Request('https://x/api/analytics'), ENV);
  assert.equal(res.status, 401);
});

test('GET /api/analytics returns the daily uptime series and a reset-attempts count', async () => {
  const dailyRows = [
    { day: '2026-08-19', lines_checked: 300, online_lines: 120 },
    { day: '2026-08-20', lines_checked: 320, online_lines: 140 },
  ];
  analyticsBackend({ dailyRows, resetCount: 143 });
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/analytics', {}, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.daily, dailyRows);
  assert.equal(data.reset_attempts_30d, 143);
});

test('GET /api/analytics excludes bookkeeping outcomes and scopes to teltik reset actions over 30 days', async () => {
  const urls = [];
  analyticsBackend({ capturedUrls: urls });
  const cookie = await loginCookie();
  await teltikPortal.fetch(authedRequest('https://x/api/analytics', {}, cookie), ENV);
  const attemptsUrl = urls.find((u) => u.startsWith('/rental_report_remediation_attempts') || u.includes('rental_report_remediation_attempts'));
  assert.ok(attemptsUrl, 'reset-attempts query was made');
  assert.match(attemptsUrl, /action=in\.\(teltik_reset_port,teltik_reset_network\)/);
  assert.match(attemptsUrl, /outcome=not\.in\.\(%22skipped_cooldown%22,%22skipped_sms_unavailable%22\)/);
  assert.match(attemptsUrl, /attempted_at=gte\./);
});

test('GET /api/analytics degrades to an empty series when the RPC returns nothing usable', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_daily_uptime') return new Response(null, { status: 500 });
    if (u.pathname === '/rest/v1/rental_report_remediation_attempts') {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    }
    throw new Error('unexpected fetch ' + u.pathname);
  };
  const cookie = await loginCookie();
  const res = await teltikPortal.fetch(authedRequest('https://x/api/analytics', {}, cookie), ENV);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.daily, []);
});
