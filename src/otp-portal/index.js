// otp-portal — a small login-gated page for a trusted non-admin user. It
// hands out one free, temporary number from the existing storefront pool
// (shop_pool) and shows incoming SMS for it. No accounts beyond a single
// shared login, no money, no carrier calls: it only ever reads sims /
// sim_numbers / shop_pool / shop_rentals / inbound_sms and writes
// exclusively via the otp_portal_claim RPC (see
// supabase/migrations/20260819_otp_portal_assignments.sql), which also
// refuses to hand out a sim a paying storefront customer currently holds.
// There is no relayFetch here — Supabase is the only outbound call this
// worker ever makes (relayFetch is for calls to CF-proxied third-party
// APIs, per agent/constraints.md #11; this worker makes none).
//
// Auth is a single shared password (OTP_PORTAL_PASSWORD_HASH) verified
// locally with PBKDF2 — a wrong or missing login never touches Supabase.
// A successful login sets an HMAC-signed, HttpOnly session cookie
// (see auth.mjs). Once logged in, the existing per-browser assignment
// cookie (otpp_sid) keeps the same number stable across reloads exactly as
// before the login model was added.

import {
  vendorToCarrier,
  computeAvailableCandidates,
  pickRandom,
  filterAssignmentMessages,
} from './logic.mjs';
import { verifyPassword, signSession, verifySession, randomHex } from './auth.mjs';

const AUTH_COOKIE_NAME = 'otpp_auth';
const SID_COOKIE_NAME = 'otpp_sid';
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_LOGIN_TTL_MINUTES = 720; // 12h
const MAX_CLAIM_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Supabase (PostgREST) helpers — same shape as src/storefront/index.js,
// minus relayFetch (not needed: Supabase calls are exempt, and this worker
// makes no other outbound HTTP call).
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
  if (!res.ok) {
    throw new Error('PostgREST GET ' + res.status + ': ' + (await res.text().catch(() => '')));
  }
  return res.json();
}

// Returns { ok, status, text } so callers can distinguish "lost the race"
// (sim_taken, raised by the RPC) from a real failure.
async function sbRpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function selectIn(env, table, column, ids, rest) {
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids, 150)) {
    const list = part.map((v) => encodeURIComponent(v)).join(',');
    out.push(...(await sbSelect(env, `${table}?${column}=in.(${list})&${rest}`)));
  }
  return out;
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

function sidCookieHeader(value, maxAgeSeconds) {
  return `${SID_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function ttlMinutes(env) {
  const n = Number(env.ASSIGNMENT_TTL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MINUTES;
}

function loginTtlMinutes(env) {
  const n = Number(env.LOGIN_SESSION_TTL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOGIN_TTL_MINUTES;
}

// True only when the request carries a signature that verifies against
// OTP_PORTAL_SESSION_SECRET and hasn't expired. Pure local crypto — never
// touches Supabase, so a missing/expired/forged cookie can't leak anything
// about SMS data or trigger a DB call.
async function isAuthenticated(request, env) {
  if (!env.OTP_PORTAL_SESSION_SECRET) return false;
  const token = getCookie(request, AUTH_COOKIE_NAME);
  if (!token) return false;
  return verifySession(env.OTP_PORTAL_SESSION_SECRET, token);
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

// POST /login — verifies the shared password locally (PBKDF2) and, on
// success, sets a signed session cookie. Never calls Supabase: a wrong or
// missing password, or a missing OTP_PORTAL_PASSWORD_HASH/
// OTP_PORTAL_SESSION_SECRET secret, always fails before any DB access.
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  const password = (body && typeof body.password === 'string') ? body.password : '';

  if (!env.OTP_PORTAL_PASSWORD_HASH || !env.OTP_PORTAL_SESSION_SECRET || !password) {
    return json({ ok: false, error: 'invalid_credentials' }, 401);
  }
  const ok = await verifyPassword(password, env.OTP_PORTAL_PASSWORD_HASH);
  if (!ok) return json({ ok: false, error: 'invalid_credentials' }, 401);

  const minutes = loginTtlMinutes(env);
  const token = await signSession(env.OTP_PORTAL_SESSION_SECRET, minutes * 60000);
  return json({ ok: true }, 200, { 'Set-Cookie': authCookieHeader(token, minutes * 60) });
}

function handleLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearAuthCookieHeader() });
}

// ---------------------------------------------------------------------------
// Assignment logic
// ---------------------------------------------------------------------------

// Candidate pool: shop_pool sims that are active, have a current number, and
// aren't already spoken for (by a paying customer or another otp-portal
// session). Mirrors storefront's availableSims() query shape.
async function fetchCandidatePool(env) {
  const pool = await sbSelect(env, 'shop_pool?select=sim_id');
  const poolIds = pool.map((r) => r.sim_id);
  if (!poolIds.length) return [];

  const nowIso = new Date().toISOString();
  const [sims, numbers, activeRentals, activeAssignments] = await Promise.all([
    selectIn(env, 'sims', 'id', poolIds, 'status=eq.active&select=id,vendor'),
    selectIn(env, 'sim_numbers', 'sim_id', poolIds, 'valid_to=is.null&select=sim_id,e164'),
    selectIn(env, 'shop_rentals', 'sim_id', poolIds, 'status=eq.active&select=sim_id'),
    selectIn(env, 'otp_portal_assignments', 'sim_id', poolIds,
      `expires_at=gt.${encodeURIComponent(nowIso)}&select=sim_id`),
  ]);

  return computeAvailableCandidates({
    sims, numbers, activeShopRentals: activeRentals, activeAssignments,
  });
}

// Picks a random candidate and claims it via the RPC (advisory-lock
// serialized in Postgres — see the migration). On a lost race (another
// request claimed the same sim a moment ago) it drops that candidate and
// retries with a different one, up to MAX_CLAIM_ATTEMPTS.
async function tryClaim(env, minutes) {
  let candidates = await fetchCandidatePool(env);
  const attempts = Math.min(candidates.length, MAX_CLAIM_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const pick = pickRandom(candidates);
    if (!pick) break;
    const sessionId = randomHex(24);
    const carrier = vendorToCarrier(pick.vendor);
    const rpc = await sbRpc(env, 'otp_portal_claim', {
      p_session_token: sessionId,
      p_sim_id: pick.sim_id,
      p_e164: pick.e164,
      p_carrier: carrier,
      p_ttl_minutes: minutes,
    });
    if (rpc.ok) {
      const assignmentId = Number(JSON.parse(rpc.text));
      return { sessionId, assignmentId };
    }
    candidates = candidates.filter((c) => c.sim_id !== pick.sim_id);
  }
  return null;
}

async function loadAssignmentBySession(env, sessionId) {
  const rows = await sbSelect(env,
    `otp_portal_assignments?session_token=eq.${encodeURIComponent(sessionId)}` +
    '&select=sim_id,e164,carrier,assigned_at,expires_at&limit=1');
  return rows[0] || null;
}

async function loadAssignmentById(env, id) {
  const rows = await sbSelect(env,
    `otp_portal_assignments?id=eq.${id}&select=sim_id,e164,carrier,assigned_at,expires_at&limit=1`);
  return rows[0] || null;
}

// GET /api/state — returns the current session's assignment, claiming a
// fresh one if there isn't a live one yet. Sets the assignment cookie only
// when a new assignment is made; an existing valid cookie is left alone so
// the browser keeps the same number across reloads. Requires a valid login
// session — checked before any Supabase call.
async function handleState(request, env) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);

  const minutes = ttlMinutes(env);
  const existingSessionId = getCookie(request, SID_COOKIE_NAME);
  if (existingSessionId) {
    const a = await loadAssignmentBySession(env, existingSessionId);
    if (a && Date.parse(a.expires_at) > Date.now()) {
      return json({
        ok: true, has_number: true,
        e164: a.e164, carrier: a.carrier,
        assigned_at: a.assigned_at, expires_at: a.expires_at,
      });
    }
  }

  const claimed = await tryClaim(env, minutes);
  if (!claimed) {
    return json({ ok: true, has_number: false, no_number_available: true });
  }
  const a = await loadAssignmentById(env, claimed.assignmentId);
  return json(
    {
      ok: true, has_number: true,
      e164: a.e164, carrier: a.carrier,
      assigned_at: a.assigned_at, expires_at: a.expires_at,
    },
    200,
    { 'Set-Cookie': sidCookieHeader(claimed.sessionId, minutes * 60) },
  );
}

// GET /api/messages — SMS received on the assigned number at or after
// assignment time only. Requires a valid login session, checked before any
// Supabase call. No assignment cookie / no live assignment yet just means
// "nothing to show" (not an error) — the page only polls this once it has
// a number from /api/state.
async function handleMessages(request, env) {
  if (!(await isAuthenticated(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);

  const sessionId = getCookie(request, SID_COOKIE_NAME);
  const a = sessionId ? await loadAssignmentBySession(env, sessionId) : null;
  if (!a) return json({ ok: true, has_number: false, expired: false, messages: [] });

  const expired = Date.parse(a.expires_at) <= Date.now();
  const assignedAtMs = Date.parse(a.assigned_at);

  const sms = await sbSelect(env,
    `inbound_sms?sim_id=eq.${a.sim_id}` +
    `&received_at=gte.${encodeURIComponent(a.assigned_at)}` +
    '&select=to_number,from_number,body,received_at&order=received_at.desc&limit=100');
  const messages = filterAssignmentMessages(sms, { e164: a.e164, assignedAtMs });
  return json({ ok: true, has_number: true, expired, messages });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const PAGE_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b1220; color: #e6e9f0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 24px;
  }
  .card { width: 100%; max-width: 440px; background: #131c30; border: 1px solid #232f4a; border-radius: 16px; padding: 28px 24px; }
  .head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 14px; }
  h1 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #7c8db5; margin: 0; font-weight: 600; }
  .signout { background: none; border: none; color: #46557a; font-size: 12px; cursor: pointer; padding: 0; }
  .signout:hover { color: #7c8db5; }
  .number { font-size: 32px; font-weight: 700; letter-spacing: .01em; margin: 4px 0 4px; word-break: break-word; }
  .carrier { color: #7c8db5; font-size: 13px; margin-bottom: 20px; }
  .status { font-size: 13px; color: #7c8db5; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc84; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .messages { display: flex; flex-direction: column; gap: 10px; }
  .msg { background: #0e1626; border: 1px solid #202b46; border-radius: 12px; padding: 12px 14px; }
  .msg .from { font-size: 12px; color: #7c8db5; margin-bottom: 4px; }
  .msg .body { font-size: 15px; word-break: break-word; }
  .msg mark { background: #3ddc84; color: #06210f; padding: 0 4px; border-radius: 4px; font-weight: 700; }
  .empty { color: #7c8db5; font-size: 14px; text-align: center; padding: 24px 0; }
  .error { color: #ff8686; font-size: 14px; text-align: center; padding: 24px 0; }
  .refresh-note { font-size: 12px; color: #46557a; text-align: center; margin-top: 18px; }
  a { color: #3ddc84; }
  input {
    width: 100%; background: #0e1626; border: 1px solid #202b46; border-radius: 10px; padding: 12px 14px;
    color: #e6e9f0; font-size: 15px; margin-bottom: 14px;
  }
  input:focus { outline: none; border-color: #3ddc84; }
  button[type="submit"] {
    width: 100%; background: #3ddc84; color: #06210f; border: none; border-radius: 10px;
    padding: 12px 14px; font-size: 15px; font-weight: 700; cursor: pointer;
  }
  button[type="submit"]:disabled { opacity: .6; cursor: default; }
`;

function loginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <form id="login-form">
      <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
      <div id="login-err" class="error" style="display:none;padding:0 0 14px"></div>
      <button id="login-btn" type="submit">Sign in</button>
    </form>
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
      body: JSON.stringify({ password: document.getElementById('password').value }),
    })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'sign_in_failed'); }); })
      .then(function () { location.href = '/'; })
      .catch(function () {
        err.textContent = 'Incorrect password.';
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
<title>Your temporary number</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>Your temporary number</h1>
      <button class="signout" id="signout-btn" type="button">Sign out</button>
    </div>
    <div id="content">Loading…</div>
  </div>
<script>
(function () {
  var el = document.getElementById('content');
  var codeRe = /\\b\\d{4,8}\\b/g;

  document.getElementById('signout-btn').addEventListener('click', function () {
    fetch('/logout', { method: 'POST', credentials: 'include' }).finally(function () { location.href = '/'; });
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlight(body) {
    return esc(body).replace(codeRe, function (m) { return '<mark>' + m + '</mark>'; });
  }

  function renderNoNumber() {
    el.innerHTML = '<div class="empty">No numbers are available right now.<br>Try again in a few minutes.</div>';
  }
  function renderError() {
    el.innerHTML = '<div class="error">Something went wrong. Please refresh.</div>';
  }
  function renderExpired() {
    el.innerHTML = '<div class="empty">This number expired.<br><a href="/">Get a new one</a></div>';
  }
  function renderAssigned(state, messages) {
    var html = '<div class="number">' + esc(state.e164) + '</div>';
    html += '<div class="carrier">' + esc(state.carrier || '') + '</div>';
    html += '<div class="status"><span class="dot"></span>Waiting for your text…</div>';
    if (!messages.length) {
      html += '<div class="empty">No messages yet.</div>';
    } else {
      html += '<div class="messages">' + messages.map(function (m) {
        return '<div class="msg"><div class="from">from ' + esc(m.from_number) + '</div><div class="body">' + highlight(m.body) + '</div></div>';
      }).join('') + '</div>';
    }
    html += '<div class="refresh-note">Updates automatically every few seconds.</div>';
    el.innerHTML = html;
  }

  var currentState = null;
  var polling = false;
  var timer = null;

  function poll() {
    if (polling || !currentState) return;
    polling = true;
    fetch('/api/messages', { credentials: 'include' })
      .then(function (r) {
        if (r.status === 401) { if (timer) clearInterval(timer); location.href = '/'; return null; }
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.expired) { renderExpired(); if (timer) clearInterval(timer); return; }
        renderAssigned(currentState, data.messages || []);
      })
      .catch(function () {})
      .finally(function () { polling = false; });
  }

  fetch('/api/state', { credentials: 'include' })
    .then(function (r) {
      if (r.status === 401) { location.href = '/'; return null; }
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    })
    .then(function (data) {
      if (!data) return;
      if (!data.ok) throw new Error('bad_state');
      if (!data.has_number) { renderNoNumber(); return; }
      currentState = data;
      renderAssigned(currentState, []);
      poll();
      timer = setInterval(poll, 4000);
    })
    .catch(function () { renderError(); });
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
      if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'state' && method === 'GET') return handleState(request, env);
      if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'messages' && method === 'GET') return handleMessages(request, env);
      return notFound();
    } catch (e) {
      console.log('[OtpPortal] ' + method + ' ' + url.pathname + ' failed: ' + (e && e.stack || e));
      return json({ error: 'internal_error' }, 500);
    }
  },
};
