// teltik-portal — a small login-gated page for Teltik support to see the
// live status of every line IncomingSMS hosts through them, and to trigger a
// port-status check or port reset themselves (per-line or in bulk) instead
// of relaying "line X is down" over WhatsApp.
//
// Deliberately a standalone worker (sibling to otp-portal), not a tab on the
// internal admin dashboard: the dashboard's Basic Auth is one shared
// password covering everything (all SIMs, resellers, financial data), so
// sharing that login would expose far more than line status. This worker
// has its own single shared login (auth.mjs, copied from otp-portal) and
// every Supabase query is scoped to Teltik-hosted lines only — the same
// gateway_host/vendor filter runHostingPortSweep already uses.
//
// Detection/history/uptime-% and the actual port-status read/reset-port call
// are NOT reimplemented here — this worker imports the real shared module
// (src/shared/hosting-port-status.mjs) used by the dashboard, the 12h cron,
// and bad-rental-remediator, so every check recorded from here lands in the
// same hosting_port_status_checks history and counts toward the same 24h/7d
// uptime numbers shown elsewhere.

import {
  checkAndRecordTeltikHostPort,
  runHostingPortSweep,
  resolveTeltikKnownMdn,
  toTeltik10Digit,
} from '../shared/hosting-port-status.mjs';
import { verifyPassword, signSession, verifySession, constantTimeEqual, foldUsername } from './auth.mjs';

const AUTH_COOKIE_NAME = 'tprt_auth';
const DEFAULT_LOGIN_TTL_MINUTES = 720; // 12h
const RESET_TIMEOUT_MS = 15000;
const LINES_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Supabase (PostgREST) helpers
// ---------------------------------------------------------------------------
function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
    ...(extra || {}),
  };
}

async function sbSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error('PostgREST GET ' + res.status + ': ' + (await res.text().catch(() => '')));
  return res.json();
}

async function sbRpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Every line this worker is allowed to touch — same host/vendor rule
// runHostingPortSweep uses: explicit teltik host, or no explicit host and
// teltik vendor. This filter is the actual security boundary (there's no
// DB-level RLS in this codebase): every query below goes through it.
const TELTIK_SCOPE = 'or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))';

async function fetchScopedSim(env, simId) {
  const rows = await sbSelect(env,
    'sims?select=id,iccid,vendor,gateway_host,status,sim_numbers(e164)'
    + '&sim_numbers.valid_to=is.null'
    + '&id=eq.' + encodeURIComponent(simId)
    + '&' + TELTIK_SCOPE + '&limit=1');
  const s = rows[0];
  if (!s) return null;
  return {
    id: s.id, iccid: s.iccid, vendor: s.vendor, gateway_host: s.gateway_host || 'teltik',
    db_current_mdn: (s.sim_numbers && s.sim_numbers[0] && s.sim_numbers[0].e164) || null,
  };
}

async function fetchHostedLines(env) {
  const sims = await sbSelect(env,
    'sims?select=id,iccid,vendor,gateway_host,status,sim_numbers(e164)'
    + '&sim_numbers.valid_to=is.null'
    + '&status=eq.active'
    + '&' + TELTIK_SCOPE
    + '&order=id.asc&limit=' + LINES_LIMIT);

  const ids = sims.map((s) => s.id);
  const summaryBySimId = {};
  for (const part of chunk(ids, 500)) {
    const rows = await sbRpc(env, 'get_hosting_port_status_summary', { sim_ids: part });
    if (Array.isArray(rows)) for (const row of rows) summaryBySimId[row.sim_id] = row;
  }

  return sims.map((s) => {
    const hp = summaryBySimId[s.id] || null;
    return {
      sim_id: s.id,
      iccid: s.iccid,
      // Current MDN: our DB's number for this line (sim_numbers).
      mdn: (s.sim_numbers && s.sim_numbers[0] && s.sim_numbers[0].e164) || null,
      // Hosted MDN: the number Teltik itself resolved the line by for the
      // last port-status check (hp.last_mdn) — can legitimately differ from
      // Current MDN, since Teltik's side doesn't see our MDN rotations (see
      // src/shared/teltik-known-mdn.mjs). A mismatch is useful signal, not
      // an error: it explains why a reset/check might target a number that
      // looks "wrong" at a glance.
      hosted_mdn: hp ? hp.last_mdn : null,
      hosted_mdn_source: hp ? hp.last_mdn_source : null,
      gateway_host: s.gateway_host || 'teltik',
      state: hp ? hp.last_state : null,
      checked_at: hp ? hp.last_checked_at : null,
      checks_24h: hp ? hp.checks_24h : 0,
      online_24h: hp ? hp.online_24h : 0,
      checks_7d: hp ? hp.checks_7d : 0,
      online_7d: hp ? hp.online_7d : 0,
    };
  });
}

// Mirrors the reset-port call into carrier_api_logs (same table the
// dashboard's own OTA-Refresh action and the shared port-status check log
// into) so a Teltik-triggered reset shows up in the internal API log audit
// trail. API key is never logged. Never throws — logging must not break the
// reset action itself.
async function logResetPortCarrierApi(env, { iccid, mdnDigits, httpStatus, ok, bodyJson, bodyText, error }) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/carrier_api_logs', {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        run_id: 'teltik_portal_reset_port_' + (iccid || 'unknown') + '_' + Date.now(),
        step: 'reset_port',
        iccid: iccid || null,
        imei: null,
        vendor: 'teltik',
        request_url: 'https://api.smsgateway.xyz/v1/reset-port?mdn=' + encodeURIComponent(mdnDigits || ''),
        request_method: 'GET',
        request_body: null,
        response_status: httpStatus,
        response_ok: !!ok,
        response_body_text: bodyText == null ? null : String(bodyText).slice(0, 5000),
        response_body_json: bodyJson,
        error: error || null,
        created_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) console.log('[TeltikPortal] carrier_api_logs mirror failed HTTP ' + resp.status);
  } catch (e) {
    console.log('[TeltikPortal] carrier_api_logs mirror exception: ' + (e && e.message || e));
  }
}

// Trigger a Teltik /v1/reset-port for one line, keyed by the Teltik-known
// MDN (same resolver every other reset-port caller in this codebase uses —
// never the possibly-stale DB current MDN alone). Bounded by an explicit
// timeout so one slow Teltik response can't hang the request indefinitely.
async function resetPort(env, sim) {
  if (!env.TELTIK_API_KEY) return { ok: false, error: 'teltik_credentials_missing' };
  const picked = await resolveTeltikKnownMdn(env, sim);
  const rawMdn = picked && picked.mdn;
  if (!rawMdn) return { ok: false, error: 'no_teltik_known_mdn' };
  const mdnDigits = toTeltik10Digit(rawMdn);

  const url = 'https://api.smsgateway.xyz/v1/reset-port'
    + '?apikey=' + encodeURIComponent(env.TELTIK_API_KEY)
    + '&mdn=' + encodeURIComponent(mdnDigits);
  const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + url : url;
  const headers = env.RELAY_KEY ? { 'x-relay-key': env.RELAY_KEY } : {};

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('reset-port timeout after ' + RESET_TIMEOUT_MS + 'ms')), RESET_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(fetchUrl, { method: 'GET', headers, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    const error = 'reset-port exception: ' + (e && e.message || e);
    await logResetPortCarrierApi(env, { iccid: sim.iccid, mdnDigits, httpStatus: null, ok: false, bodyJson: null, bodyText: null, error });
    return { ok: false, error };
  }
  clearTimeout(timer);

  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  // Teltik can return 200 with { success: false, message: ... } — check both.
  const bodySuccess = !body || body.success !== false;
  const ok = res.ok && bodySuccess;
  const errMsg = ok ? null : ((body && (body.message || body.error)) || (!res.ok ? 'HTTP ' + res.status : null) || 'reset_port_failed');
  await logResetPortCarrierApi(env, { iccid: sim.iccid, mdnDigits, httpStatus: res.status, ok, bodyJson: body, bodyText: text, error: errMsg });
  return { ok, http_status: res.status, mdn: mdnDigits, mdn_source: picked.source, detail: body || text, error: errMsg };
}

// ---------------------------------------------------------------------------
// Small response / request utilities
// ---------------------------------------------------------------------------
function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function notFound() {
  return new Response('Not found', { status: 404 });
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function authCookieHeader(value, maxAgeSeconds) {
  return `${AUTH_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearAuthCookieHeader() {
  return `${AUTH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function loginTtlMinutes(env) {
  const n = Number(env.LOGIN_SESSION_TTL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOGIN_TTL_MINUTES;
}

// True only when the request carries a signature that verifies against
// TELTIK_PORTAL_SESSION_SECRET and hasn't expired. Pure local crypto — never
// touches Supabase, so a missing/expired/forged cookie can't trigger a DB
// call or a vendor call.
async function isAuthenticated(request, env) {
  if (!env.TELTIK_PORTAL_SESSION_SECRET) return false;
  const token = getCookie(request, AUTH_COOKIE_NAME);
  if (!token) return false;
  return verifySession(env.TELTIK_PORTAL_SESSION_SECRET, token);
}

// ---------------------------------------------------------------------------
// Login / logout — same model as otp-portal: a single shared username +
// password verified locally (never touches Supabase on a wrong/missing
// credential), case-insensitive username / exact password, constant-time
// compares, both checks always run so a wrong username can't be timed apart
// from a wrong password.
// ---------------------------------------------------------------------------
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  const username = (body && typeof body.username === 'string') ? body.username.trim() : '';
  const password = (body && typeof body.password === 'string') ? body.password : '';

  if (!env.TELTIK_PORTAL_USERNAME || !env.TELTIK_PORTAL_PASSWORD_HASH || !env.TELTIK_PORTAL_SESSION_SECRET || !username || !password) {
    return json({ ok: false, error: 'invalid_credentials' }, 401);
  }
  const usernameOk = constantTimeEqual(foldUsername(username), foldUsername(env.TELTIK_PORTAL_USERNAME));
  const passwordOk = await verifyPassword(password, env.TELTIK_PORTAL_PASSWORD_HASH);
  if (!usernameOk || !passwordOk) return json({ ok: false, error: 'invalid_credentials' }, 401);

  const minutes = loginTtlMinutes(env);
  const token = await signSession(env.TELTIK_PORTAL_SESSION_SECRET, minutes * 60000);
  return json({ ok: true }, 200, { 'Set-Cookie': authCookieHeader(token, minutes * 60) });
}

function handleLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearAuthCookieHeader() });
}

// ---------------------------------------------------------------------------
// API — every handler checks the session before any Supabase/vendor call.
// ---------------------------------------------------------------------------
async function handleLinesList(request, env) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const lines = await fetchHostedLines(env);
    return json({ ok: true, lines });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
}

async function handleLineCheck(request, env, simId) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  const sim = await fetchScopedSim(env, simId);
  if (!sim) return json({ ok: false, error: 'line_not_found' }, 404);
  const result = await checkAndRecordTeltikHostPort(env, sim, { source: 'teltik_portal' });
  return json({ ok: true, result });
}

async function handleLineReset(request, env, simId) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  const sim = await fetchScopedSim(env, simId);
  if (!sim) return json({ ok: false, error: 'line_not_found' }, 404);
  const result = await resetPort(env, sim);
  return json({ ok: result.ok, result }, result.ok ? 200 : 502);
}

async function handleLinesCheckBulk(request, env) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { body = null; }
  const simIds = Array.isArray(body && body.sim_ids)
    ? body.sim_ids.map(Number).filter(Number.isFinite)
    : [];
  if (!simIds.length) return json({ ok: false, error: 'sim_ids required' }, 400);
  const summary = await runHostingPortSweep(env, { simIds, source: 'teltik_portal', concurrency: 5 });
  return json(summary, summary.ok === false ? 502 : 200);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const PAGE_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    background: #0b1220; color: #e6e9f0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 440px; background: #131c30; border: 1px solid #232f4a; border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #7c8db5; margin: 0 0 14px; font-weight: 600; }
  input {
    width: 100%; background: #0e1626; border: 1px solid #202b46; border-radius: 10px; padding: 12px 14px;
    color: #e6e9f0; font-size: 15px; margin-bottom: 14px;
  }
  input:focus { outline: none; border-color: #3ddc84; }
  button { font: inherit; }
  button[type="submit"], .btn-primary {
    background: #3ddc84; color: #06210f; border: none; border-radius: 10px;
    padding: 10px 16px; font-size: 14px; font-weight: 700; cursor: pointer;
  }
  button[type="submit"] { width: 100%; padding: 12px 14px; }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: #ff8686; font-size: 14px; text-align: center; padding: 0 0 14px; }

  .app-wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; flex-wrap: wrap; gap: 10px; }
  .topbar h1 { margin: 0; font-size: 18px; text-transform: none; letter-spacing: 0; color: #e6e9f0; }
  .topbar .sub { color: #7c8db5; font-size: 13px; margin-top: 2px; }
  .topbar-actions { display: flex; gap: 8px; align-items: center; }
  .btn-ghost { background: none; border: 1px solid #232f4a; color: #b7c2de; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
  .btn-ghost:hover { border-color: #3ddc84; color: #3ddc84; }

  .filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .filter-bar input[type="text"] { flex: 1; min-width: 220px; margin-bottom: 0; padding: 8px 12px; font-size: 13px; }
  .filter-bar select { background: #0e1626; border: 1px solid #202b46; border-radius: 8px; padding: 8px 10px; color: #e6e9f0; font-size: 13px; }
  .filter-bar select:focus, .filter-bar input:focus { outline: none; border-color: #3ddc84; }

  .bulk-bar { display: none; align-items: center; gap: 10px; background: #131c30; border: 1px solid #232f4a; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; color: #b7c2de; }
  .bulk-bar.visible { display: flex; }
  .btn-sm { border-radius: 8px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; }
  .btn-check { background: #274a6e; color: #cfe4ff; }
  .btn-reset { background: #6e2734; color: #ffd2d8; }
  .btn-cancel { background: none; border: 1px solid #3a4a6e; color: #8fa0c7; }

  .table-scroll { overflow-x: auto; border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; background: #131c30; border: 1px solid #232f4a; border-radius: 12px; overflow: hidden; font-size: 13.5px; }
  thead th { text-align: left; padding: 10px 12px; color: #7c8db5; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #202b46; white-space: nowrap; }
  thead th.sortable { cursor: pointer; user-select: none; }
  thead th.sortable:hover { color: #cfd9f0; }
  .sort-arrow { display: inline-block; width: 10px; font-size: 10px; opacity: .8; }
  .mdn-flag { color: #ffb84d; margin-left: 5px; cursor: help; font-size: 12px; }
  tbody td { padding: 10px 12px; border-bottom: 1px solid #182238; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #16213a; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #cfd9f0; }
  .muted { color: #5c6b8f; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .badge-online { background: rgba(61,220,132,.18); color: #3ddc84; }
  .badge-offline { background: rgba(255,90,90,.18); color: #ff8686; }
  .badge-unknown, .badge-error { background: rgba(180,180,180,.15); color: #aab4cc; }
  .row-actions button { margin-right: 6px; }
  .empty, .loading { text-align: center; color: #7c8db5; padding: 40px 0; }
  .status-line { font-size: 12px; color: #7c8db5; margin-top: 10px; min-height: 16px; }
`;

function loginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Teltik line status — sign in</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="login-wrap">
  <div class="card">
    <h1>Sign in</h1>
    <form id="login-form">
      <input id="username" name="username" type="text" autocomplete="username" placeholder="Username" required>
      <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
      <div id="login-err" class="error" style="display:none"></div>
      <button id="login-btn" type="submit">Sign in</button>
    </form>
  </div>
</div>
<script>
(function () {
  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var err = document.getElementById('login-err');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    fetch('/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'sign_in_failed'); }); })
      .then(function () { location.href = '/'; })
      .catch(function () {
        err.textContent = 'Incorrect username or password.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  });
})();
</script>
</body>
</html>`;
}

function appHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Teltik hosted lines</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="app-wrap">
  <div class="topbar">
    <div>
      <h1>Teltik hosted lines</h1>
      <div class="sub" id="summary-line">Loading…</div>
    </div>
    <div class="topbar-actions">
      <button class="btn-ghost" id="export-btn" type="button">Export CSV</button>
      <button class="btn-ghost" id="refresh-btn" type="button">Refresh</button>
      <button class="btn-ghost" id="signout-btn" type="button">Sign out</button>
    </div>
  </div>

  <div class="filter-bar">
    <input type="text" id="search-input" placeholder="Search ICCID, Current MDN or Hosted MDN…">
    <select id="status-filter">
      <option value="">All statuses</option>
      <option value="online">Online</option>
      <option value="offline">Offline</option>
      <option value="unknown">Unknown</option>
      <option value="error">Error</option>
    </select>
    <span class="muted" id="filter-count"></span>
  </div>

  <div class="bulk-bar" id="bulk-bar">
    <span id="bulk-count">0 selected</span>
    <button class="btn-sm btn-check" id="bulk-check-btn" type="button">Check selected</button>
    <button class="btn-sm btn-reset" id="bulk-reset-btn" type="button">Reset selected</button>
    <button class="btn-cancel" id="bulk-cancel-btn" type="button" style="display:none">Cancel</button>
  </div>

  <div id="table-wrap">
    <div class="loading">Loading lines…</div>
  </div>
  <div class="status-line" id="status-line"></div>
</div>
<script>
(function () {
  var lines = [];
  var selected = new Set();
  var bulkCancelled = false;
  var searchText = '';
  var statusFilter = '';
  var sortKey = null;
  var sortDir = 1; // 1 = asc, -1 = desc

  var COLUMNS = [
    { key: 'mdn', label: 'Current MDN' },
    { key: 'hosted_mdn', label: 'Hosted MDN' },
    { key: 'iccid', label: 'ICCID' },
    { key: 'state', label: 'Status' },
    { key: 'pct24', label: '24h up' },
    { key: 'pct7', label: '7d up' },
    { key: 'checked_at', label: 'Last checked' },
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function pct(online, checks) { return checks > 0 ? Math.round(100 * online / checks) + '%' : '—'; }

  function badge(state) {
    var cls = 'badge-unknown', label = state || 'unknown';
    if (state === 'online') cls = 'badge-online';
    else if (state === 'offline') cls = 'badge-offline';
    else if (state === 'error') cls = 'badge-error';
    return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  // Same normalization Teltik's own API uses (src/shared/teltik-known-mdn.mjs
  // toTeltik10Digit) — needed here only to compare Current vs Hosted MDN,
  // which are stored in different formats (+1E.164 vs bare 10-digit).
  function toTeltik10(mdn) {
    var digits = String(mdn || '').replace(/\\D/g, '');
    return (digits.length === 11 && digits.charAt(0) === '1') ? digits.slice(1) : digits;
  }
  function mdnMismatch(l) {
    if (!l.hosted_mdn || !l.mdn) return false;
    var cur = toTeltik10(l.mdn), hosted = toTeltik10(l.hosted_mdn);
    return cur.length === 10 && hosted.length === 10 && cur !== hosted;
  }

  document.getElementById('signout-btn').addEventListener('click', function () {
    fetch('/logout', { method: 'POST', credentials: 'include' }).finally(function () { location.href = '/'; });
  });
  document.getElementById('refresh-btn').addEventListener('click', function () { loadLines(); });

  function setStatus(msg) { document.getElementById('status-line').textContent = msg || ''; }

  function updateBulkBar() {
    var bar = document.getElementById('bulk-bar');
    var n = selected.size;
    if (n > 0) {
      bar.classList.add('visible');
      document.getElementById('bulk-count').textContent = n + ' selected';
    } else {
      bar.classList.remove('visible');
    }
  }

  function sortValue(l, key) {
    if (key === 'pct24') return l.checks_24h > 0 ? l.online_24h / l.checks_24h : -1;
    if (key === 'pct7') return l.checks_7d > 0 ? l.online_7d / l.checks_7d : -1;
    if (key === 'checked_at') return l.checked_at ? Date.parse(l.checked_at) : 0;
    return String(l[key] || '');
  }

  // Filter (search text over ICCID/Current MDN/Hosted MDN + status dropdown)
  // then sort — this is exactly what "Export CSV" also reads, so the export
  // always matches what's currently on screen.
  function visibleLines() {
    var q = searchText.trim().toLowerCase();
    var out = lines.filter(function (l) {
      if (statusFilter && (l.state || 'unknown') !== statusFilter) return false;
      if (!q) return true;
      return [l.iccid, l.mdn, l.hosted_mdn].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
    if (sortKey) {
      out.sort(function (a, b) {
        var av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
        if (av < bv) return -1 * sortDir;
        if (av > bv) return 1 * sortDir;
        return 0;
      });
    }
    return out;
  }

  function headerCell(col) {
    var arrow = sortKey === col.key ? (sortDir === 1 ? '▲' : '▼') : '';
    return '<th class="sortable" data-key="' + col.key + '">' + esc(col.label)
      + '<span class="sort-arrow">' + arrow + '</span></th>';
  }

  function render() {
    var wrap = document.getElementById('table-wrap');
    var visible = visibleLines();
    document.getElementById('filter-count').textContent = lines.length
      ? (visible.length === lines.length ? lines.length + ' lines' : visible.length + ' of ' + lines.length + ' lines')
      : '';
    if (!lines.length) { wrap.innerHTML = '<div class="empty">No Teltik-hosted lines found.</div>'; return; }
    if (!visible.length) { wrap.innerHTML = '<div class="empty">No lines match the current search/filter.</div>'; return; }
    var rows = visible.map(function (l) {
      var checked = selected.has(l.sim_id) ? ' checked' : '';
      var flag = mdnMismatch(l) ? '<span class="mdn-flag" title="Differs from Current MDN — Teltik knows this line by a different number">⚠</span>' : '';
      return '<tr data-id="' + l.sim_id + '">'
        + '<td><input type="checkbox" class="row-cb" data-id="' + l.sim_id + '"' + checked + '></td>'
        + '<td class="mono">' + esc(l.mdn || '—') + '</td>'
        + '<td class="mono">' + esc(l.hosted_mdn || '—') + flag + '</td>'
        + '<td class="mono">' + esc(l.iccid || '—') + '</td>'
        + '<td>' + badge(l.state) + '</td>'
        + '<td>' + pct(l.online_24h, l.checks_24h) + ' <span class="muted">(' + l.checks_24h + ')</span></td>'
        + '<td>' + pct(l.online_7d, l.checks_7d) + ' <span class="muted">(' + l.checks_7d + ')</span></td>'
        + '<td class="muted">' + esc(fmtTime(l.checked_at)) + '</td>'
        + '<td class="row-actions">'
          + '<button class="btn-sm btn-check" data-action="check" data-id="' + l.sim_id + '">Check</button>'
          + '<button class="btn-sm btn-reset" data-action="reset" data-id="' + l.sim_id + '">Reset</button>'
        + '</td>'
        + '</tr>';
    }).join('');
    var headers = '<th><input type="checkbox" id="select-all"></th>'
      + headerCell(COLUMNS[0]) + headerCell(COLUMNS[1]) + headerCell(COLUMNS[2]) + headerCell(COLUMNS[3])
      + headerCell(COLUMNS[4]) + headerCell(COLUMNS[5]) + headerCell(COLUMNS[6]) + '<th>Actions</th>';
    wrap.innerHTML = '<div class="table-scroll"><table>'
      + '<thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    document.getElementById('select-all').addEventListener('change', function (e) {
      visible.forEach(function (l) { if (e.target.checked) selected.add(l.sim_id); else selected.delete(l.sim_id); });
      render();
    });
    wrap.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
        render();
      });
    });
    wrap.querySelectorAll('.row-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = Number(cb.getAttribute('data-id'));
        if (cb.checked) selected.add(id); else selected.delete(id);
        updateBulkBar();
      });
    });
    wrap.querySelectorAll('[data-action="check"]').forEach(function (b) {
      b.addEventListener('click', function () { checkOne(Number(b.getAttribute('data-id'))); });
    });
    wrap.querySelectorAll('[data-action="reset"]').forEach(function (b) {
      b.addEventListener('click', function () { resetOne(Number(b.getAttribute('data-id'))); });
    });
    updateBulkBar();
  }

  function updateSummary() {
    var online = lines.filter(function (l) { return l.state === 'online'; }).length;
    var offline = lines.filter(function (l) { return l.state === 'offline'; }).length;
    document.getElementById('summary-line').textContent =
      lines.length + ' lines · ' + online + ' online · ' + offline + ' offline · as of ' + new Date().toLocaleTimeString();
  }

  function csvField(v) {
    var s = v == null ? '' : String(v);
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Exports exactly what's currently visible (search/filter/sort applied) —
  // "what you're looking at" is what gets exported, not the full unfiltered
  // fleet, so a filtered-to-offline export doesn't quietly include lines
  // that were never on screen.
  function exportCsv() {
    var visible = visibleLines();
    var header = ['ICCID', 'Current MDN', 'Hosted MDN', 'Status', '24h checks', '24h online', '7d checks', '7d online', 'Last checked'];
    var rows = visible.map(function (l) {
      return [l.iccid, l.mdn, l.hosted_mdn, l.state || 'unknown', l.checks_24h, l.online_24h, l.checks_7d, l.online_7d, l.checked_at || ''];
    });
    var csv = [header].concat(rows).map(function (r) { return r.map(csvField).join(','); }).join('\\r\\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'teltik-hosted-lines-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.getElementById('export-btn').addEventListener('click', exportCsv);
  document.getElementById('search-input').addEventListener('input', function (e) { searchText = e.target.value; render(); });
  document.getElementById('status-filter').addEventListener('change', function (e) { statusFilter = e.target.value; render(); });

  function loadLines() {
    setStatus('Loading…');
    fetch('/api/lines', { credentials: 'include' })
      .then(function (r) {
        if (r.status === 401) { location.href = '/'; return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (!data.ok) throw new Error(data.error || 'load_failed');
        lines = data.lines || [];
        render();
        updateSummary();
        setStatus('');
      })
      .catch(function (e) { setStatus('Failed to load: ' + e.message); });
  }

  function checkOne(id) {
    setStatus('Checking line ' + id + '…');
    fetch('/api/lines/' + id + '/check', { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function () { setStatus('Check complete.'); loadLines(); })
      .catch(function (e) { setStatus('Check failed: ' + e.message); });
  }

  function resetOne(id) {
    setStatus('Resetting line ' + id + '…');
    fetch('/api/lines/' + id + '/reset', { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setStatus(data.ok ? 'Reset triggered.' : 'Reset failed: ' + (data.result && data.result.error || data.error || 'unknown'));
        loadLines();
      })
      .catch(function (e) { setStatus('Reset failed: ' + e.message); });
  }

  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  document.getElementById('bulk-check-btn').addEventListener('click', function () {
    var ids = Array.from(selected);
    if (!ids.length) return;
    setStatus('Checking ' + ids.length + ' line(s)…');
    fetch('/api/lines/check-bulk', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_ids: ids }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setStatus('Checked ' + (data.total || ids.length) + ' line(s): '
          + (data.online || 0) + ' online, ' + (data.offline || 0) + ' offline.');
        loadLines();
      })
      .catch(function (e) { setStatus('Bulk check failed: ' + e.message); });
  });

  // Bulk reset is a paced sequential loop against the single-line endpoint —
  // Teltik's reset-port API is one-line-at-a-time with no bulk variant, and
  // this loop is externally triggerable (Teltik's own login), so it paces
  // itself rather than firing every request at once.
  document.getElementById('bulk-reset-btn').addEventListener('click', function () {
    var ids = Array.from(selected);
    if (!ids.length) return;
    bulkCancelled = false;
    var cancelBtn = document.getElementById('bulk-cancel-btn');
    cancelBtn.style.display = 'inline-block';
    cancelBtn.onclick = function () { bulkCancelled = true; };

    (async function () {
      var ok = 0, failed = 0;
      for (var i = 0; i < ids.length; i++) {
        if (bulkCancelled) { setStatus('Cancelled after ' + i + ' of ' + ids.length + '.'); break; }
        setStatus('Resetting ' + (i + 1) + ' of ' + ids.length + '…');
        try {
          var r = await fetch('/api/lines/' + ids[i] + '/reset', { method: 'POST', credentials: 'include' });
          var data = await r.json();
          if (data.ok) ok++; else failed++;
        } catch (e) { failed++; }
        if (i < ids.length - 1) await delay(600);
      }
      cancelBtn.style.display = 'none';
      setStatus('Bulk reset done: ' + ok + ' ok, ' + failed + ' failed.');
      loadLines();
    })();
  });

  loadLines();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts.length === 0 && method === 'GET') {
        const authed = await isAuthenticated(request, env);
        return new Response(authed ? appHtml() : loginHtml(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (parts.length === 1 && parts[0] === 'health' && method === 'GET') {
        return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      if (parts.length === 1 && parts[0] === 'login' && method === 'POST') return handleLogin(request, env);
      if (parts.length === 1 && parts[0] === 'logout' && method === 'POST') return handleLogout();

      if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'lines' && method === 'GET') return handleLinesList(request, env);
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'lines' && parts[2] === 'check-bulk' && method === 'POST') return handleLinesCheckBulk(request, env);
      if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'lines' && parts[3] === 'check' && method === 'POST') return handleLineCheck(request, env, parts[2]);
      if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'lines' && parts[3] === 'reset' && method === 'POST') return handleLineReset(request, env, parts[2]);

      return notFound();
    } catch (e) {
      console.log('[TeltikPortal] ' + method + ' ' + url.pathname + ' failed: ' + (e && e.stack || e));
      return json({ error: 'internal_error' }, 500);
    }
  },
};
