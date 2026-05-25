import { computeBillingBreakdown, estDateFromDate } from '../shared/billing.js';

const COOKIE_NAME = 'rp_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

const ATT_VENDORS = new Set(['wing_iot', 'atomic', 'helix']);
const TMOBILE_VENDORS = new Set(['teltik']);
function vendorToCarrier(vendor) {
  if (!vendor) return null;
  if (ATT_VENDORS.has(vendor)) return 'AT&T';
  if (TMOBILE_VENDORS.has(vendor)) return 'T-Mobile';
  return null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

async function sbGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
}

async function sbGetAll(env, pathWithoutLimit) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes('?') ? '&' : '?';
    const url = pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;
    const resp = await sbGet(env, url);
    if (!resp.ok) throw new Error('PostgREST: ' + resp.status + ' ' + (await resp.text()));
    const batch = await resp.json();
    if (!Array.isArray(batch)) return batch;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

async function sbPost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('PostgREST POST ' + res.status + ': ' + t);
  }
}

// --- Rate limits ---
// All windows expressed in seconds; counts are read from reseller_actions_log.
// Per spec §5.6:
//   portal_resync : 1 per reseller per 600s
//   portal_resend : 1 per (reseller, sim_id) per 300s AND 100 per reseller per 3600s
// On violation we return a structured object that the caller turns into HTTP 429.

async function countActionsSince(env, resellerId, action, sinceIsoSeconds, simId = null) {
  const since = new Date(Date.now() - sinceIsoSeconds * 1000).toISOString();
  let path =
    'reseller_actions_log?select=id' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&action=eq.' + encodeURIComponent(action) +
    '&created_at=gte.' + encodeURIComponent(since);
  if (simId != null) path += '&sim_id=eq.' + encodeURIComponent(simId);
  path += '&limit=1000';
  const resp = await sbGet(env, path);
  if (!resp.ok) return 0;
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function checkRateLimit(env, resellerId, action, simId = null) {
  if (action === 'portal_resync') {
    const recent = await countActionsSince(env, resellerId, 'portal_resync', 600);
    if (recent >= 1) return { allowed: false, retryAfter: 600, reason: 'Bulk resync allowed once per 10 minutes' };
    return { allowed: true };
  }
  if (action === 'portal_resend') {
    if (simId != null) {
      const perSim = await countActionsSince(env, resellerId, 'portal_resend', 300, simId);
      if (perSim >= 1) return { allowed: false, retryAfter: 300, reason: 'This SIM was resent within the last 5 minutes' };
    }
    const perHour = await countActionsSince(env, resellerId, 'portal_resend', 3600);
    if (perHour >= 100) return { allowed: false, retryAfter: 3600, reason: 'Per-reseller resend cap (100/hour) reached' };
    return { allowed: true };
  }
  return { allowed: true };
}

async function logAction(env, resellerId, action, simId = null) {
  try {
    await sbPost(env, 'reseller_actions_log', {
      reseller_id: Number(resellerId),
      action,
      sim_id: simId != null ? Number(simId) : null,
    });
  } catch (e) {
    console.log('[RateLimit] failed to log action: ' + e);
  }
}

function getCredFromRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
  if (m) return decodeURIComponent(m[1]);
  return null;
}

// PBKDF2-SHA256 password hashing using Web Crypto. Format mirrors Django:
// pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>.
const PBKDF2_ITERS = 100000;

function _u8ToB64(u8) { return btoa(String.fromCharCode.apply(null, u8)); }
function _b64ToU8(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
function _u8ToB64url(u8) { return _u8ToB64(u8).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function _b64urlToStr(b64u) {
  const pad = (4 - (b64u.length % 4)) % 4;
  return atob(b64u.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice(0, pad));
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    km, 256
  );
  return 'pbkdf2_sha256$' + PBKDF2_ITERS + '$' + _u8ToB64(salt) + '$' + _u8ToB64(new Uint8Array(bits));
}

async function verifyPassword(password, hashStr) {
  if (!hashStr || typeof hashStr !== 'string' || !hashStr.startsWith('pbkdf2_sha256$')) return false;
  const parts = hashStr.split('$');
  if (parts.length !== 4) return false;
  const iters = parseInt(parts[1], 10);
  if (!Number.isFinite(iters) || iters < 1000) return false;
  const salt = _b64ToU8(parts[2]);
  const expected = parts[3];
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    km, 256
  );
  const got = _u8ToB64(new Uint8Array(bits));
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// HMAC-signed session tokens: rps_<b64url(payload)>.<b64url(sig)>
// payload format: <resellerId>|<expiresAtMs>
async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return _u8ToB64url(new Uint8Array(sig));
}

async function signSession(env, resellerId, ttlMs) {
  const secret = env.PORTAL_SESSION_SECRET || '';
  if (!secret) throw new Error('PORTAL_SESSION_SECRET not configured');
  const expiresAt = Date.now() + (ttlMs || 30 * 24 * 60 * 60 * 1000);
  const payload = String(resellerId) + '|' + expiresAt;
  const sig = await hmacSign(secret, payload);
  return 'rps_' + _u8ToB64url(new TextEncoder().encode(payload)) + '.' + sig;
}

async function verifySession(env, token) {
  if (!token || !token.startsWith('rps_') || !env.PORTAL_SESSION_SECRET) return null;
  const rest = token.slice(4);
  const dot = rest.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadB64u = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let payload;
  try { payload = _b64urlToStr(payloadB64u); } catch { return null; }
  const expected = await hmacSign(env.PORTAL_SESSION_SECRET, payload);
  // constant-time-ish compare
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const idx = payload.lastIndexOf('|');
  if (idx < 1) return null;
  const resellerId = payload.slice(0, idx);
  const expiresAt = parseInt(payload.slice(idx + 1), 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { resellerId };
}

async function authenticate(request, env) {
  const cred = getCredFromRequest(request);
  if (!cred) return null;

  // Path 1 — API key (rsk_*)
  if (cred.startsWith('rsk_')) {
    const resp = await sbGet(env,
      'reseller_api_keys?select=id,reseller_id,enabled,resellers(name)' +
      '&api_key=eq.' + encodeURIComponent(cred) +
      '&limit=1'
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!row.enabled) return null;
    return { resellerId: String(row.reseller_id), keyId: row.id, name: row.resellers?.name || String(row.reseller_id) };
  }

  // Path 2 — signed session token (rps_*) from username/password login
  if (cred.startsWith('rps_')) {
    const sess = await verifySession(env, cred);
    if (!sess) return null;
    const resp = await sbGet(env,
      'resellers?select=id,name&id=eq.' + encodeURIComponent(sess.resellerId) + '&limit=1'
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return { resellerId: String(rows[0].id), name: rows[0].name || String(rows[0].id) };
  }

  return null;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function unauthorized() { return jsonResp({ error: 'unauthorized' }, 401); }
function notFound() { return jsonResp({ error: 'not found' }, 404); }
function badRequest(msg) { return jsonResp({ error: msg }, 400); }

function setSessionCookieHeader(value) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

async function handleLoginGet(url, env) {
  // Legacy magic-link flow: ?key=rsk_... → set API-key cookie.
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing ?key=', { status: 400 });
  const fakeReq = new Request('http://x/', { headers: { Authorization: 'Bearer ' + key } });
  const auth = await authenticate(fakeReq, env);
  if (!auth) return new Response('Invalid or revoked key', { status: 401 });
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': setSessionCookieHeader(key) },
  });
}

async function handleLoginPost(request, env) {
  let body;
  try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
  const username = (body && body.username || '').trim().toLowerCase();
  const password = body && body.password || '';
  if (!username || !password) return badRequest('Username and password required');

  const resp = await sbGet(env,
    'resellers?select=id,name,password_hash&username=eq.' + encodeURIComponent(username) + '&limit=1'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  // Constant-ish-time: always run verifyPassword even if user doesn't exist, to avoid
  // user-enumeration via timing differences. Use a known-good throwaway hash.
  const dummyHash = 'pbkdf2_sha256$' + PBKDF2_ITERS + '$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const row = (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
  const ok = row && row.password_hash
    ? await verifyPassword(password, row.password_hash)
    : (await verifyPassword(password, dummyHash), false);
  if (!ok) return jsonResp({ error: 'Invalid username or password' }, 401);

  const token = await signSession(env, row.id);
  return new Response(JSON.stringify({ ok: true, reseller_id: row.id, name: row.name }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookieHeader(token),
    },
  });
}

async function handleLogout(env) {
  const expired = `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': expired } });
}

async function handleMe(auth) {
  return jsonResp({ reseller_id: Number(auth.resellerId), name: auth.name });
}

async function handleCredentials(auth, env) {
  // Returns the reseller's own API keys in plaintext so they can copy them
  // into their integration. Safe because the request is already authenticated
  // for this reseller.
  const resp = await sbGet(env,
    'reseller_api_keys?select=id,api_key,enabled,created_at' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&order=enabled.desc,created_at.desc'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  const keys = (Array.isArray(rows) ? rows : []).map(r => ({
    id: r.id,
    api_key: r.api_key,
    enabled: r.enabled,
    created_at: r.created_at,
  }));
  return jsonResp({
    reseller_id: Number(auth.resellerId),
    name: auth.name,
    api_keys: keys,
  });
}

async function handleSims(auth, env, url) {
  const activeFilter = url && url.searchParams ? url.searchParams.get('active') : null;
  const activeClause =
    activeFilter === 'true'  ? '&active=eq.true'
  : activeFilter === 'false' ? '&active=eq.false'
  : '';
  const rows = await sbGetAll(env,
    'reseller_sims?select=sim_id,active,created_at,last_rental_id,sims(iccid,vendor,msisdn,status,activated_at,last_mdn_rotated_at,last_rotation_at,rotation_interval_hours)' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    activeClause +
    '&order=active.desc,sim_id.asc'
  );
  const out = (Array.isArray(rows) ? rows : []).map(r => {
    const sim = r.sims || {};
    const interval = sim.rotation_interval_hours || (sim.vendor === 'teltik' ? 48 : 24);
    // Prefer last_rotation_at (success-only) over last_mdn_rotated_at (attempt-time) so a
    // failed rotation doesn't push the displayed online_until forward by 48h.
    const baseTs = sim.last_rotation_at || sim.last_mdn_rotated_at || null;
    const start = baseTs || sim.activated_at || null;
    const expires = baseTs ? midnightNYAfterInterval(baseTs, interval) : null;
    return {
      sim_id: r.sim_id,
      active: r.active,
      assigned_at: r.created_at,
      rental_id: r.last_rental_id || null,
      iccid: sim.iccid || null,
      carrier: vendorToCarrier(sim.vendor),
      msisdn: sim.msisdn || null,
      status: sim.status || null,
      activated_at: sim.activated_at || null,
      start_at: start,
      online_until: expires,
      rotation_interval_hours: interval,
    };
  });
  return jsonResp(out);
}

// Mirrors reseller-sync's midnightNYAfterInterval — keep in sync.
function midnightNYAfterInterval(lastRotatedAt, intervalHours) {
  const baseDt = new Date(lastRotatedAt || Date.now());
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(baseDt);
  const [y, m, d] = nyDate.split('-').map(Number);
  const intervalDays = Math.ceil((intervalHours || 24) / 24);
  const probe = new Date(Date.UTC(y, m - 1, d + intervalDays, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || '';
  const offset = tzPart === 'EDT' ? '-04:00' : '-05:00';
  return probeNyDate + 'T00:00:00' + offset;
}

async function handleInvoices(auth, env) {
  const resp = await sbGet(env,
    'qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,created_at,qbo_customer_map!inner(reseller_id)' +
    '&qbo_customer_map.reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&order=week_start.desc'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  const out = (Array.isArray(rows) ? rows : []).map(r => ({
    id: r.id,
    week_start: r.week_start,
    week_end: r.week_end,
    sim_count: r.sim_count,
    total: r.total,
    status: r.status,
    paid_at: r.paid_at,
    created_at: r.created_at,
  }));
  return jsonResp(out);
}

async function handleInvoiceDetail(invoiceId, auth, env) {
  const resp = await sbGet(env,
    'qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,created_at,qbo_customer_map!inner(reseller_id)' +
    '&id=eq.' + encodeURIComponent(invoiceId) +
    '&qbo_customer_map.reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&limit=1'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) return notFound();
  const inv = rows[0];

  const breakdown = await computeBillingBreakdown(env, {
    resellerId: auth.resellerId,
    start: inv.week_start,
    end: inv.week_end,
  });

  return jsonResp({
    invoice: {
      id: inv.id,
      week_start: inv.week_start,
      week_end: inv.week_end,
      as_billed_sim_count: inv.sim_count,
      as_billed_total: inv.total,
      status: inv.status,
      paid_at: inv.paid_at,
      created_at: inv.created_at,
    },
    breakdown: {
      days: breakdown.days,
      daily_rate: breakdown.daily_rate,
      block_rate: breakdown.block_rate,
      note: 'Reconstructed from current SMS records. The invoiced total above is what you were billed; if SMS data was backfilled or rotation history changed after invoicing, individual day counts may differ slightly from what was billed.',
    },
  });
}

async function handleSimLifetime(simId, auth, env) {
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id,active,created_at,sims(iccid,vendor,msisdn,status,activated_at,rotation_interval_hours)' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&limit=1'
  );
  // Note: vendor is fetched for billing-block calc below; the API only exposes derived carrier.
  if (!ownResp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const ownRows = await ownResp.json();
  if (!Array.isArray(ownRows) || ownRows.length === 0) return notFound();
  const rs = ownRows[0];
  const assignedAt = rs.created_at;
  const assignedDate = assignedAt ? assignedAt.slice(0, 10) : null;
  const sim = rs.sims || {};
  const vendor = sim.vendor;
  const intervalH = sim.rotation_interval_hours || 48;

  const dailyResp = await sbGet(env,
    'sim_sms_daily?select=est_date,sms_count&sim_id=eq.' + encodeURIComponent(simId) +
    (assignedDate ? '&est_date=gte.' + assignedDate : '') +
    '&order=est_date.asc&limit=10000'
  );
  const dailyRows = dailyResp.ok ? await dailyResp.json() : [];
  const totalSms = (Array.isArray(dailyRows) ? dailyRows : []).reduce((s, d) => s + (d.sms_count || 0), 0);
  const activeDays = (Array.isArray(dailyRows) ? dailyRows : []).filter(d => (d.sms_count || 0) > 0).length;
  const smsDaysSet = new Set((Array.isArray(dailyRows) ? dailyRows : []).filter(d => (d.sms_count || 0) > 0).map(d => d.est_date));

  let billableUnits = activeDays;
  let unitLabel = 'SMS-days';
  if (vendor === 'teltik') {
    unitLabel = 'rotation blocks';
    const rotResp = await sbGetAll(env,
      'sim_numbers?select=valid_from&sim_id=eq.' + encodeURIComponent(simId) +
      (assignedAt ? '&valid_from=gte.' + encodeURIComponent(assignedAt) : '') +
      '&order=valid_from.asc'
    );
    const rotations = (Array.isArray(rotResp) ? rotResp : []).map(r => new Date(r.valid_from));
    let blocks = 0;
    const intervalMs = intervalH * 3600 * 1000;
    for (let i = 0; i < rotations.length; i++) {
      const rotStart = rotations[i];
      const rotNext = rotations[i + 1];
      const blockEnd = new Date(Math.min(
        rotStart.getTime() + intervalMs,
        rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY
      ));
      const startEst = estDateFromDate(rotStart);
      const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));
      let hasSms = false;
      let cur = startEst;
      while (cur <= endEstInclusive) {
        if (smsDaysSet.has(cur)) { hasSms = true; break; }
        const t = new Date(cur + 'T12:00:00Z');
        t.setUTCDate(t.getUTCDate() + 1);
        cur = estDateFromDate(t);
      }
      if (hasSms) blocks += 1;
    }
    billableUnits = blocks;
  }

  return jsonResp({
    sim_id: Number(simId),
    iccid: sim.iccid || null,
    carrier: vendorToCarrier(vendor),
    current_msisdn: sim.msisdn || null,
    status: sim.status || null,
    activated_at: sim.activated_at || null,
    assigned_at: assignedAt,
    currently_active: rs.active,
    total_sms_lifetime: totalSms,
    billable_units_lifetime: billableUnits,
    unit_label: unitLabel,
  });
}

async function handleResendOnline(simId, auth, env) {
  // 1. Ownership check — reseller must own this SIM and it must currently be active.
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id,active' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&active=eq.true' +
    '&limit=1'
  );
  if (!ownResp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const ownRows = await ownResp.json();
  if (!Array.isArray(ownRows) || ownRows.length === 0) {
    return jsonResp({ error: 'SIM not owned by this reseller or not currently active' }, 404);
  }

  // 2. Rate-limit check. Reject BEFORE calling reseller-sync (and before logging).
  const rl = await checkRateLimit(env, auth.resellerId, 'portal_resend', simId);
  if (!rl.allowed) {
    return jsonResp({ error: rl.reason, retry_after_seconds: rl.retryAfter }, 429);
  }

  // 3. Service-binding call to reseller-sync. Defense-in-depth header per Task 4's auth check.
  if (!env.RESELLER_SYNC) return jsonResp({ error: 'RESELLER_SYNC binding not configured' }, 500);
  let result;
  try {
    const upstream = await env.RESELLER_SYNC.fetch('https://reseller-sync.internal/resend-online', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Caller': 'reseller-portal' },
      body: JSON.stringify({ simId: Number(simId), source: 'portal_resend' }),
    });
    result = await upstream.json().catch(() => ({ ok: false, error: 'Non-JSON response from reseller-sync' }));
    if (!upstream.ok && !result.error) result.error = 'reseller-sync HTTP ' + upstream.status;
  } catch (e) {
    return jsonResp({ error: 'Resend pipeline unavailable: ' + String(e) }, 502);
  }

  // 4. Log the accepted action (whether or not the webhook delivered — the *attempt* counts).
  await logAction(env, auth.resellerId, 'portal_resend', simId);

  return jsonResp({
    ok: !!result.ok,
    delivered: !!result.ok,
    http_status: result.status || 0,
    rental_id: result.rental_id || null,
    error: result.error || null,
    note: 'Your system may return the same rental ID (replay) or a new one (treated as a fresh rental). We record whichever you return.',
  }, result.ok ? 200 : 502);
}

function loginHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reseller Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-slate-900 text-slate-200 min-h-screen flex items-center justify-center font-sans">
<div class="max-w-md w-full bg-slate-800 rounded-lg p-8 shadow-xl">
  <h1 class="text-2xl font-semibold mb-2">Reseller Portal</h1>
  <p class="text-slate-400 text-sm mb-6">Sign in with the username and password from your account manager.</p>
  <form id="login-form" class="space-y-4">
    <div>
      <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" required
        class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500">
    </div>
    <div>
      <label class="block text-xs uppercase tracking-wide text-slate-400 mb-1">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required
        class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500">
    </div>
    <div id="login-err" class="text-red-400 text-sm hidden"></div>
    <button id="login-btn" type="submit"
      class="w-full bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded px-4 py-2 transition">
      Sign in
    </button>
  </form>
  <div class="text-slate-500 text-xs mt-6 border-t border-slate-700 pt-4">
    Lost your credentials? Contact your account manager. Programmatic API access continues to use your API key.
  </div>
</div>
<script>
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-err');
  errEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    location.href = '/';
  } catch (err) {
    errEl.textContent = err.message || 'Sign-in failed';
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});
</script>
</body></html>`;
}

function portalHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reseller Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}</style>
</head><body class="bg-slate-900 text-slate-200 min-h-screen">
<div class="max-w-7xl mx-auto px-6 py-6">
  <header class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-semibold" id="reseller-name">Reseller Portal</h1>
      <p class="text-slate-400 text-sm">Read-only view of your SIM activity and past invoices.</p>
    </div>
    <div class="text-xs text-slate-500" id="reseller-meta"></div>
  </header>

  <nav class="border-b border-slate-700 mb-6 flex gap-1">
    <button data-tab="sims" class="tab-btn px-4 py-2 text-sm font-medium border-b-2 border-cyan-400 text-cyan-300">SIMs</button>
    <button data-tab="invoices" class="tab-btn px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200">Invoices</button>
    <button data-tab="api" class="tab-btn px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200">API Access</button>
  </nav>

  <section id="tab-sims" class="tab-panel">
    <div class="mb-3 flex items-center gap-3">
      <input id="sim-filter" type="text" placeholder="Filter by Rental ID, MDN, or ICCID" class="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm w-72">
      <span class="text-slate-500 text-xs" id="sim-summary"></span>
      <a href="/logout" class="ml-auto text-xs text-slate-400 hover:text-slate-200">Sign out</a>
    </div>
    <div id="sims-active"></div>
    <h3 class="mt-8 mb-2 text-slate-400 text-sm font-medium uppercase tracking-wide">Previously assigned</h3>
    <div id="sims-historical"></div>
  </section>

  <section id="tab-invoices" class="tab-panel hidden">
    <div id="invoices-list"></div>
  </section>

  <section id="tab-api" class="tab-panel hidden">
    <div class="bg-slate-800 rounded-lg border border-slate-700 p-5 mb-6">
      <h2 class="text-lg font-semibold mb-1">Your API Key</h2>
      <p class="text-slate-400 text-sm mb-4">Use this key to authenticate programmatic requests to the rental data API. Treat it like a password.</p>
      <div id="api-keys-list" class="space-y-2 text-sm">
        <div class="text-slate-500">Loading&hellip;</div>
      </div>
      <p class="text-xs text-slate-500 mt-3">Need a new key or to revoke an existing one? Contact your account manager.</p>
    </div>

    <div class="bg-slate-800 rounded-lg border border-slate-700 p-5">
      <h2 class="text-lg font-semibold mb-1">Active Rentals Endpoint</h2>
      <p class="text-slate-400 text-sm mb-4">Returns every SIM currently assigned and active for your account, including the rental ID, MDN, status, start, and expiration. JSON array.</p>
      <div class="space-y-3">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">URL</div>
          <div class="flex items-center gap-2">
            <code id="api-rentals-url" class="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs text-cyan-200 font-mono flex-1 break-all">https://portal.incoming-sms.com/api/sims?active=true</code>
            <button onclick="copyApiText('api-rentals-url')" class="px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">Copy</button>
          </div>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">Header</div>
          <div class="flex items-center gap-2">
            <code id="api-rentals-header" class="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs text-slate-300 font-mono flex-1 break-all">Authorization: Bearer YOUR_API_KEY</code>
            <button onclick="copyApiText('api-rentals-header')" class="px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">Copy</button>
          </div>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">cURL example</div>
          <div class="flex items-start gap-2">
            <pre id="api-rentals-curl" class="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs text-slate-300 font-mono flex-1 break-all whitespace-pre-wrap">curl -H "Authorization: Bearer YOUR_API_KEY" "https://portal.incoming-sms.com/api/sims?active=true"</pre>
            <button onclick="copyApiText('api-rentals-curl')" class="px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">Copy</button>
          </div>
        </div>
        <div class="text-xs text-slate-500">
          Drop the <code class="text-slate-300">?active=true</code> filter to include previously-assigned SIMs too.
        </div>
      </div>
    </div>
  </section>
</div>

<div id="modal-root" class="fixed inset-0 bg-black/60 hidden items-center justify-center z-50 p-4"></div>

<script>
const fmtUsd = n => '$' + Number(n || 0).toFixed(2);
const fmtDate = s => s ? new Date(s).toISOString().slice(0,10) : '';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let allSims = [];

function showModal(html) {
  const r = document.getElementById('modal-root');
  r.innerHTML = '<div class="bg-slate-800 rounded-lg max-w-4xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl">' +
    '<div class="flex justify-end mb-2"><button onclick="closeModal()" class="text-slate-400 hover:text-slate-100 text-xl leading-none">×</button></div>' +
    html + '</div>';
  r.classList.remove('hidden');
  r.classList.add('flex');
}
function closeModal() {
  const r = document.getElementById('modal-root');
  r.classList.add('hidden');
  r.classList.remove('flex');
  r.innerHTML = '';
}
document.getElementById('modal-root').addEventListener('click', e => { if (e.target.id === 'modal-root') closeModal(); });

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.dataset.tab === name) {
      b.classList.add('border-cyan-400','text-cyan-300');
      b.classList.remove('border-transparent','text-slate-400');
    } else {
      b.classList.remove('border-cyan-400','text-cyan-300');
      b.classList.add('border-transparent','text-slate-400');
    }
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  if (name === 'invoices') loadInvoices();
  if (name === 'api') loadApiCredentials();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

async function api(path) {
  const r = await fetch(path, { credentials: 'include' });
  if (r.status === 401) { window.location.href = '/'; return null; }
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

const fmtDateTime = s => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
};

function renderSimTable(sims, container, opts) {
  opts = opts || {};
  if (!sims.length) { container.innerHTML = '<div class="text-slate-500 text-sm py-4">None</div>'; return; }
  const rows = sims.map(s => '<tr class="hover:bg-slate-800 cursor-pointer" onclick="openLifetime(' + s.sim_id + ')">' +
    '<td class="px-3 py-2 text-slate-200 font-mono">' + (s.rental_id != null ? '#' + esc(s.rental_id) : '<span class="text-slate-600">—</span>') + '</td>' +
    '<td class="px-3 py-2 text-slate-200 font-mono">' + esc(s.msisdn || '—') + '</td>' +
    '<td class="px-3 py-2 text-slate-300">' + esc(s.status) + '</td>' +
    '<td class="px-3 py-2 text-slate-400 text-xs">' + (opts.showAssigned ? fmtDate(s.assigned_at) : esc(fmtDateTime(s.start_at))) + '</td>' +
    '<td class="px-3 py-2 text-slate-400 text-xs">' + (opts.showAssigned ? '' : esc(fmtDateTime(s.online_until))) + '</td>' +
    '</tr>').join('');
  const startLabel = opts.showAssigned ? 'Assigned' : 'Start';
  const expiresHeader = opts.showAssigned ? '' : '<th class="px-3 py-2 text-left">Expires</th>';
  const expiresPlaceholder = opts.showAssigned ? '<th class="px-3 py-2"></th>' : '';
  container.innerHTML =
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-800 text-slate-400 text-xs uppercase">' +
    '<tr><th class="px-3 py-2 text-left">Rental ID</th><th class="px-3 py-2 text-left">MDN</th><th class="px-3 py-2 text-left">Status</th><th class="px-3 py-2 text-left">' + startLabel + '</th>' +
    (opts.showAssigned ? expiresPlaceholder : expiresHeader) +
    '</tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + rows + '</tbody></table></div>';
}

function applySimFilter() {
  const q = document.getElementById('sim-filter').value.trim().toLowerCase();
  const filt = q ? allSims.filter(s =>
    String(s.rental_id||'').toLowerCase().includes(q) ||
    (s.msisdn||'').toLowerCase().includes(q) ||
    (s.iccid||'').toLowerCase().includes(q)
  ) : allSims;
  const active = filt.filter(s => s.active);
  const hist = filt.filter(s => !s.active);
  renderSimTable(active, document.getElementById('sims-active'), { showAssigned: false });
  renderSimTable(hist, document.getElementById('sims-historical'), { showAssigned: true });
  document.getElementById('sim-summary').textContent = active.length + ' active, ' + hist.length + ' previously assigned';
}

async function loadSims() {
  const sims = await api('/api/sims');
  if (!sims) return;
  allSims = sims;
  applySimFilter();
}
document.getElementById('sim-filter').addEventListener('input', applySimFilter);

function copyApiText(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const text = el.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.style.background;
    el.style.background = 'rgba(34,197,94,0.15)';
    setTimeout(() => { el.style.background = orig; }, 600);
  });
}

let _apiCredsLoaded = false;
async function loadApiCredentials() {
  if (_apiCredsLoaded) return;
  const list = document.getElementById('api-keys-list');
  list.innerHTML = '<div class="text-slate-500">Loading&hellip;</div>';
  try {
    const data = await api('/api/credentials');
    if (!data) return;
    const keys = (data.api_keys || []).filter(k => k.enabled);
    if (keys.length === 0) {
      list.innerHTML = '<div class="text-slate-500 italic">No API key issued yet. Contact your account manager to have one generated.</div>';
    } else {
      list.innerHTML = keys.map(k => (
        '<div class="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded px-3 py-2">' +
          '<code class="api-key-text text-cyan-200 font-mono text-xs flex-1 break-all" data-key="' + esc(k.api_key) + '">' + esc(k.api_key) + '</code>' +
          '<button onclick="copyKey(this)" class="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">Copy</button>' +
        '</div>'
      )).join('');
      // Use the first enabled key for the curl example.
      const firstKey = keys[0].api_key;
      const curlEl = document.getElementById('api-rentals-curl');
      if (curlEl) curlEl.textContent =
        'curl -H "Authorization: Bearer ' + firstKey + '" ' +
        '"https://portal.incoming-sms.com/api/sims?active=true"';
      const hdrEl = document.getElementById('api-rentals-header');
      if (hdrEl) hdrEl.textContent = 'Authorization: Bearer ' + firstKey;
    }
    _apiCredsLoaded = true;
  } catch (e) {
    list.innerHTML = '<div class="text-red-400">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function copyKey(btn) {
  const code = btn.previousElementSibling;
  if (!code) return;
  const text = code.getAttribute('data-key') || code.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  });
}

async function loadInvoices() {
  const invoices = await api('/api/invoices');
  if (!invoices) return;
  const list = document.getElementById('invoices-list');
  if (!invoices.length) { list.innerHTML = '<div class="text-slate-500 text-sm">No invoices yet.</div>'; return; }
  const rows = invoices.map(inv => {
    const isPaid = inv.status === 'paid';
    const badge = isPaid
      ? '<span class="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300">Paid' + (inv.paid_at ? ' ' + fmtDate(inv.paid_at) : '') + '</span>'
      : '<span class="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-600/40 text-slate-300">Unpaid</span>';
    return '<tr class="hover:bg-slate-800 cursor-pointer" onclick="openInvoice(' + inv.id + ')">' +
      '<td class="px-3 py-2 text-slate-300">' + esc(inv.week_start) + ' — ' + esc(inv.week_end) + '</td>' +
      '<td class="px-3 py-2 text-slate-300 text-right">' + esc(inv.sim_count) + '</td>' +
      '<td class="px-3 py-2 text-slate-100 font-medium text-right">' + fmtUsd(inv.total) + '</td>' +
      '<td class="px-3 py-2">' + badge + '</td>' +
      '<td class="px-3 py-2 text-cyan-400 text-xs">View →</td>' +
      '</tr>';
  }).join('');
  list.innerHTML =
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-800 text-slate-400 text-xs uppercase">' +
    '<tr><th class="px-3 py-2 text-left">Period</th><th class="px-3 py-2 text-right">Billable units</th><th class="px-3 py-2 text-right">Invoiced</th><th class="px-3 py-2 text-left">Status</th><th class="px-3 py-2"></th></tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + rows + '</tbody></table></div>';
}

async function openInvoice(id) {
  showModal('<div class="text-slate-400">Loading…</div>');
  const data = await api('/api/invoices/' + id);
  if (!data) return;
  const inv = data.invoice;
  const days = data.breakdown.days || [];
  const dayRows = days.map(d => '<tr><td class="px-3 py-2 text-slate-300">' + esc(d.date) + '</td>' +
    '<td class="px-3 py-2 text-slate-300 text-right">' + esc(d.sim_count) + '</td>' +
    '<td class="px-3 py-2 text-slate-300 text-right">' + fmtUsd(d.rate) + '</td>' +
    '<td class="px-3 py-2 text-slate-100 text-right">' + fmtUsd(d.amount) + '</td></tr>').join('');
  const isPaid = inv.status === 'paid';
  const badge = isPaid
    ? '<span class="px-2 py-1 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300 ml-2 align-middle">Paid' + (inv.paid_at ? ' ' + fmtDate(inv.paid_at) : '') + '</span>'
    : '<span class="px-2 py-1 text-xs font-medium rounded-full bg-slate-600/40 text-slate-300 ml-2 align-middle">Unpaid</span>';
  showModal(
    '<h2 class="text-lg font-semibold mb-1">Invoice ' + esc(inv.week_start) + ' — ' + esc(inv.week_end) + badge + '</h2>' +
    '<div class="mb-4 flex gap-6 text-sm">' +
      '<div><div class="text-slate-500">Invoiced amount</div><div class="text-2xl font-semibold text-cyan-300">' + fmtUsd(inv.as_billed_total) + '</div></div>' +
      '<div><div class="text-slate-500">Billable units</div><div class="text-2xl font-semibold text-slate-200">' + esc(inv.as_billed_sim_count) + '</div></div>' +
    '</div>' +
    '<div class="text-xs text-slate-400 mb-3 italic">' + esc(data.breakdown.note) + '</div>' +
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-900 text-slate-400 text-xs uppercase">' +
      '<tr><th class="px-3 py-2 text-left">Date (EST)</th><th class="px-3 py-2 text-right">Units</th><th class="px-3 py-2 text-right">Rate</th><th class="px-3 py-2 text-right">Amount</th></tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + (dayRows || '<tr><td colspan="4" class="px-3 py-4 text-slate-500 text-center">No billable activity in this period.</td></tr>') + '</tbody></table></div>'
  );
}

async function openLifetime(simId) {
  showModal('<div class="text-slate-400">Loading…</div>');
  const d = await api('/api/sims/' + simId + '/lifetime');
  if (!d) return;
  showModal(
    '<h2 class="text-lg font-semibold mb-1">SIM ' + esc(d.iccid) + '</h2>' +
    '<div class="text-slate-500 text-xs mb-4">Carrier ' + esc(d.carrier || '—') + ' · Status ' + esc(d.status) + ' · ' + (d.currently_active ? 'Currently active' : 'Previously assigned') + '</div>' +
    '<div class="grid grid-cols-2 gap-4 mb-4">' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Total SMS lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.total_sms_lifetime) + '</div></div>' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Billable ' + esc(d.unit_label) + ' lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.billable_units_lifetime) + '</div></div>' +
    '</div>' +
    '<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">' +
      '<dt class="text-slate-500">MSISDN (current)</dt><dd class="text-slate-200 font-mono">' + esc(d.current_msisdn || '—') + '</dd>' +
      '<dt class="text-slate-500">Activated</dt><dd class="text-slate-200">' + fmtDate(d.activated_at) + '</dd>' +
      '<dt class="text-slate-500">Assigned to you</dt><dd class="text-slate-200">' + fmtDate(d.assigned_at) + '</dd>' +
    '</dl>' +
    '<div class="text-xs text-slate-500 mt-4 italic">Lifetime totals are computed from the date this SIM was assigned to your account onward.</div>'
  );
}

(async () => {
  const me = await api('/api/me');
  if (!me) return;
  document.getElementById('reseller-name').textContent = me.name + ' — Portal';
  document.getElementById('reseller-meta').textContent = 'Account #' + me.reseller_id;
  loadSims();
})();
</script>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/login') {
      if (request.method === 'POST') return handleLoginPost(request, env);
      return handleLoginGet(url, env);
    }

    if (url.pathname === '/logout') {
      return handleLogout(env);
    }

    const auth = await authenticate(request, env);

    // API routes — must be authenticated
    if (url.pathname.startsWith('/api/')) {
      if (!auth) return unauthorized();
      if (url.pathname === '/api/me') return handleMe(auth, env);
      if (url.pathname === '/api/credentials') return handleCredentials(auth, env);
      if (url.pathname === '/api/sims') return handleSims(auth, env, url);
      if (url.pathname === '/api/invoices') return handleInvoices(auth, env);
      let m;
      if ((m = url.pathname.match(/^\/api\/invoices\/(\d+)$/))) return handleInvoiceDetail(m[1], auth, env);
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/lifetime$/))) return handleSimLifetime(m[1], auth, env);
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/resend-online$/)) && request.method === 'POST') return handleResendOnline(m[1], auth, env);
      return notFound();
    }

    // HTML routes
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!auth) {
        return new Response(loginHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response(portalHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};
