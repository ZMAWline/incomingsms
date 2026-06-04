// bad-rentals worker — dedicated surface for INC-3 bad-rental reporting.
//
// Lives at https://bad-rentals.incoming-sms.com.
//
// Auth:   Bearer reseller_api_keys.api_key (rsk_*) — same as portal.
// Schema: reuses rental_reports / rental_report_events / rental_report_rejections.
// Resolver contract: imported from src/shared/report-bad-resolver.js. Accepts
//                    ONLY reseller_rental_id or current e164. See module docs.
//
// Routes
//   GET  /                                  — public landing page (HTML)
//   GET  /healthz                           — liveness
//   POST /api/rentals/report-bad            — submit a bad-rental report
//   GET  /api/rentals/report-bad/status     — ?reseller_rental_id=… | ?e164=…
//   GET  /api/reports?status=open           — list this reseller's reports

import {
  resolveRentalForReport,
  normalizeE164,
  REPORT_REASON_CODES,
} from '../shared/report-bad-resolver.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

// ---------- PostgREST helpers (mirrors reseller-portal) ----------
async function sbGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
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

// ---------- Response helpers ----------
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
function unauthorized() { return jsonResp({ error: 'unauthorized' }, 401); }
function notFound() { return jsonResp({ error: 'not found' }, 404); }
function badRequest(msg) { return jsonResp({ error: msg }, 400); }

// ---------- Auth (Bearer rsk_* API key) ----------
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const cred = auth.slice(7).trim();
  if (!cred.startsWith('rsk_')) return null;
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
  return {
    resellerId: String(row.reseller_id),
    keyId: row.id,
    name: (row.resellers && row.resellers.name) || String(row.reseller_id),
  };
}

// ---------- Rate limits (mirrors portal_report_bad) ----------
async function countActionsSince(env, resellerId, action, sinceSeconds, simId = null) {
  const since = new Date(Date.now() - sinceSeconds * 1000).toISOString();
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

async function checkReportRateLimit(env, resellerId, simId) {
  if (simId != null) {
    const perSim = await countActionsSince(env, resellerId, 'portal_report_bad', 3600, simId);
    if (perSim >= 1) return { allowed: false, retryAfter: 3600, reason: 'This SIM was reported within the last hour' };
  }
  const perDay = await countActionsSince(env, resellerId, 'portal_report_bad', 86400);
  if (perDay >= 200) return { allowed: false, retryAfter: 86400, reason: 'Per-reseller daily cap (200) reached' };
  return { allowed: true };
}

async function logAction(env, resellerId, simId) {
  try {
    await sbPost(env, 'reseller_actions_log', {
      reseller_id: Number(resellerId),
      action: 'portal_report_bad',
      sim_id: simId != null ? Number(simId) : null,
    });
  } catch (e) {
    console.log('[bad-rentals] failed to log action: ' + e);
  }
}

async function logReportRejection(env, info) {
  try {
    const MAX_RAW = 8192;
    const rawText = info.rawBodyText == null ? null : String(info.rawBodyText).slice(0, MAX_RAW);
    await sbPost(env, 'rental_report_rejections', {
      reseller_id: info.resellerId != null ? Number(info.resellerId) : null,
      source: String(info.source || 'unknown'),
      rejection_code: String(info.code || 'bad_request'),
      rejection_message: info.message != null ? String(info.message).slice(0, 1000) : null,
      raw_payload: info.body !== undefined ? info.body : null,
      raw_body_text: rawText,
      http_status: info.status != null ? Number(info.status) : null,
    });
  } catch (e) {
    console.log('[bad-rentals] failed to log rejection: ' + e);
  }
}

// ---------- Core insert (dedup on open report for same rental) ----------
async function insertOrReturnExistingReport(env, resellerId, resolved, body, source) {
  const reasonCode = body.reason_code && REPORT_REASON_CODES.has(body.reason_code) ? body.reason_code : 'no_sms_received';
  const reasonNote = body.reason_note != null ? String(body.reason_note).slice(0, 500) : null;
  const attempts = body.attempts != null && Number.isFinite(Number(body.attempts)) ? Number(body.attempts) : null;
  const firstAttemptAt = body.first_attempt_at ? String(body.first_attempt_at) : null;
  const clientRequestId = body.client_request_id != null ? String(body.client_request_id).slice(0, 128) : null;

  if (resolved.rental_id != null) {
    const existing = await sbGet(env,
      'rental_reports?select=id,status,received_at,e164,sim_id,sim_number_id,rental_id' +
      '&reseller_id=eq.' + encodeURIComponent(resellerId) +
      '&rental_id=eq.' + encodeURIComponent(resolved.rental_id) +
      '&status=in.(received,in_triage)&limit=1'
    );
    if (existing.ok) {
      const rows = await existing.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const r = rows[0];
        return jsonResp({
          report_id: r.id,
          rental_id: r.rental_id,
          sim_id: r.sim_id,
          sim_number_id: r.sim_number_id,
          e164: r.e164,
          status: r.status,
          queued_at: r.received_at,
          deduped: true,
          note: 'A report for this rental is already open; returning the existing report_id.',
        });
      }
    }
  }

  const row = {
    reseller_id: Number(resellerId),
    rental_id: resolved.rental_id || null,
    sim_id: resolved.sim_id || null,
    sim_number_id: resolved.sim_number_id || null,
    e164: resolved.e164 || normalizeE164(body.e164) || '',
    reason_code: reasonCode,
    reason_note: reasonNote,
    attempts,
    first_attempt_at: firstAttemptAt,
    client_request_id: clientRequestId,
    status: 'received',
    raw_payload: body,
    source: source || null,
  };
  let insertResp;
  try {
    insertResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rental_reports`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    return jsonResp({ error: 'insert failed: ' + String(e) }, 502);
  }
  if (!insertResp.ok) {
    const t = await insertResp.text().catch(() => '');
    return jsonResp({ error: 'insert failed: ' + insertResp.status + ' ' + t }, 502);
  }
  const inserted = await insertResp.json();
  const r = Array.isArray(inserted) ? inserted[0] : inserted;

  try {
    await sbPost(env, 'rental_report_events', {
      report_id: r.id,
      from_status: null,
      to_status: 'received',
      actor: 'reseller',
      note: reasonNote,
      evidence: clientRequestId ? { client_request_id: clientRequestId } : null,
    });
  } catch (e) {
    console.log('[bad-rentals] event log insert failed: ' + e);
  }

  await logAction(env, resellerId, resolved.sim_id);

  return jsonResp({
    report_id: r.id,
    rental_id: r.rental_id,
    reseller_rental_id: body.reseller_rental_id || null,
    sim_id: r.sim_id,
    sim_number_id: r.sim_number_id,
    e164: r.e164,
    status: r.status,
    queued_at: r.received_at,
    expected_first_action_within_minutes: 60,
  });
}

// ---------- Handlers ----------

// POST /api/rentals/report-bad
async function handleReportBad(auth, env, request) {
  const source = 'bad-rentals/api/rentals/report-bad';
  let bodyText = '';
  try { bodyText = await request.text(); } catch { bodyText = ''; }
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    await logReportRejection(env, { resellerId: auth.resellerId, source,
      code: 'parse_error', message: 'request body was not valid JSON',
      rawBodyText: bodyText, status: 400 });
    return badRequest('JSON body required');
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    const shape = Array.isArray(body) ? 'array' : (body === null ? 'null' : typeof body);
    await logReportRejection(env, { resellerId: auth.resellerId, source,
      code: 'bad_request', message: 'body must be a JSON object (got ' + shape + ')',
      body, rawBodyText: bodyText, status: 400 });
    return badRequest('JSON object body required');
  }

  const resolved = await resolveRentalForReport(env, auth.resellerId, body, sbGet);
  if (!resolved.ok) {
    const status = resolved.code === 'not_found' ? 404
                 : resolved.code === 'ambiguous' ? 409
                 : 400;
    await logReportRejection(env, { resellerId: auth.resellerId, source,
      code: resolved.code, message: resolved.message, body, rawBodyText: bodyText, status });
    return jsonResp({ error: resolved.message, code: resolved.code, candidates: resolved.candidates }, status);
  }

  const rl = await checkReportRateLimit(env, auth.resellerId, resolved.sim_id);
  if (!rl.allowed) {
    await logReportRejection(env, { resellerId: auth.resellerId, source,
      code: 'rate_limited', message: rl.reason, body, rawBodyText: bodyText, status: 429 });
    return jsonResp({ error: rl.reason, retry_after_seconds: rl.retryAfter }, 429);
  }

  return insertOrReturnExistingReport(env, auth.resellerId, resolved, body, source);
}

// GET /api/rentals/report-bad/status?reseller_rental_id=… | ?e164=…
async function handleReportBadStatus(auth, env, url) {
  const resellerRentalId = url.searchParams.get('reseller_rental_id');
  const e164 = url.searchParams.get('e164');
  if (!resellerRentalId && !e164) {
    return badRequest('`reseller_rental_id` or `e164` query parameter required');
  }
  // Reuse resolver for parity with POST contract.
  const body = resellerRentalId ? { reseller_rental_id: resellerRentalId } : { e164 };
  const resolved = await resolveRentalForReport(env, auth.resellerId, body, sbGet);
  if (!resolved.ok) {
    const status = resolved.code === 'not_found' ? 404
                 : resolved.code === 'ambiguous' ? 409
                 : 400;
    return jsonResp({ error: resolved.message, code: resolved.code }, status);
  }
  const resp = await sbGet(env,
    'rental_reports?select=id,rental_id,sim_id,sim_number_id,e164,reason_code,reason_note,status,remediation_action,received_at,triaged_at,closed_at' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&rental_id=eq.' + encodeURIComponent(resolved.rental_id) +
    '&order=received_at.desc&limit=6'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  const list = Array.isArray(rows) ? rows : [];
  const open = list.find(r => r.status === 'received' || r.status === 'in_triage') || null;
  return jsonResp({
    rental_id: resolved.rental_id,
    sim_id: resolved.sim_id,
    e164: resolved.e164,
    open_report: open,
    history: list.filter(r => r !== open).slice(0, 5),
  });
}

// GET /api/reports?status=open
async function handleReportsList(auth, env, url) {
  const status = url.searchParams.get('status');
  const since = url.searchParams.get('since');
  let path = 'rental_reports?select=id,rental_id,sim_id,sim_number_id,e164,reason_code,reason_note,status,remediation_action,received_at,triaged_at,closed_at' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId);
  if (status === 'open') {
    path += '&status=in.(received,in_triage)';
  } else if (status && status !== 'all') {
    path += '&status=eq.' + encodeURIComponent(status);
  }
  if (since) path += '&received_at=gte.' + encodeURIComponent(since);
  path += '&order=received_at.desc&limit=500';
  const resp = await sbGet(env, path);
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  return jsonResp({ reports: Array.isArray(rows) ? rows : [] });
}

// ---------- Landing page ----------
function landingPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bad Rentals — Incoming SMS</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: #0b1220; color: #e2e8f0; line-height: 1.55; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 32px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 32px 0 12px; color: #93c5fd; }
  .sub { color: #94a3b8; margin: 0 0 24px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;
        padding: 14px 16px; overflow-x: auto; color: #cbd5e1; }
  code.inline { background: #0f172a; border: 1px solid #1e293b; border-radius: 4px;
                padding: 1px 6px; color: #cbd5e1; }
  .pill { display: inline-block; background: #1e293b; color: #93c5fd; border-radius: 999px;
          padding: 2px 10px; font-size: 12px; margin-right: 6px; }
  .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px;
          padding: 20px 22px; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; font-size: 14px; }
  th { color: #93c5fd; font-weight: 600; }
  input, button { font: inherit; border-radius: 6px; border: 1px solid #334155;
                  background: #0b1220; color: #e2e8f0; padding: 8px 12px; }
  input { width: 100%; box-sizing: border-box; margin: 4px 0 12px; }
  button { background: #2563eb; border-color: #2563eb; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  #status-out { white-space: pre-wrap; margin-top: 10px; }
  .ok  { color: #34d399; }
  .err { color: #f87171; }
  footer { color: #64748b; font-size: 12px; margin-top: 48px; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Bad Rentals</h1>
  <p class="sub">
    Dedicated surface for reporting rentals where the phone number is not
    receiving SMS, is delivering the wrong number, or is otherwise broken.
    Reports are queued for operator triage; remediation (rotate / port reset /
    replace) happens out-of-band and the status flows back through this API.
  </p>

  <div class="card">
    <span class="pill">Auth</span>
    <code class="inline">Authorization: Bearer rsk_…</code>
    &nbsp; &nbsp; <span class="pill">Base</span>
    <code class="inline">https://bad-rentals.incoming-sms.com</code>
  </div>

  <h2>What this surface accepts</h2>
  <p>The bad-rental contract is intentionally narrow. We will only act on
     identifiers that unambiguously name a current rental on your account:</p>
  <table>
    <tr><th>Field</th><th>Required</th><th>Notes</th></tr>
    <tr><td><code>reseller_rental_id</code></td><td>one of these two</td>
        <td>Your own rental id (string). Preferred.</td></tr>
    <tr><td><code>e164</code></td><td>one of these two</td>
        <td>The rental's <strong>current</strong> phone number (E.164). Historical numbers are rejected.</td></tr>
    <tr><td><code>reason_code</code></td><td>optional</td>
        <td>One of: <code>no_sms_received</code>, <code>wrong_number</code>, <code>delayed_sms</code>, <code>other</code>.</td></tr>
    <tr><td><code>reason_note</code></td><td>optional</td>
        <td>Free text, ≤ 500 chars.</td></tr>
    <tr><td><code>client_request_id</code></td><td>optional</td>
        <td>Your own idempotency tag.</td></tr>
  </table>
  <p class="sub" style="margin-top:8px">Explicitly <strong>rejected</strong>:
     <code>sim_id</code>, <code>iccid</code>, internal <code>rental_id</code>, and
     historical / original MDNs. A SIM may span multiple rentals over time, so
     these identifiers can't unambiguously name "this rental".</p>

  <h2>POST /api/rentals/report-bad</h2>
  <pre>curl -X POST \\
  -H "Authorization: Bearer rsk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"reseller_rental_id":"YOUR-RENTAL-ID","reason_code":"no_sms_received"}' \\
  https://bad-rentals.incoming-sms.com/api/rentals/report-bad</pre>
  <p class="sub">Rate limit: one report per SIM per hour, 200 reports per
     reseller per day. Submitting again while a report is open returns the
     existing <code>report_id</code> with <code>deduped: true</code>.</p>

  <h2>GET /api/rentals/report-bad/status</h2>
  <p>Look up the most recent report for one of your rentals.</p>
  <pre>curl -H "Authorization: Bearer rsk_…" \\
  "https://bad-rentals.incoming-sms.com/api/rentals/report-bad/status?reseller_rental_id=YOUR-RENTAL-ID"</pre>

  <h2>GET /api/reports?status=open</h2>
  <p>List all of your open reports.</p>
  <pre>curl -H "Authorization: Bearer rsk_…" \\
  "https://bad-rentals.incoming-sms.com/api/reports?status=open"</pre>

  <h2>Check a report status</h2>
  <div class="card">
    <label>API key (Bearer)</label>
    <input id="status-key" type="password" placeholder="rsk_…" autocomplete="off">
    <label>reseller_rental_id <em style="color:#64748b">or</em> e164</label>
    <input id="status-id" type="text" placeholder="e.g. 1617922  or  +17752002752">
    <button id="status-go">Check status</button>
    <div id="status-out"></div>
  </div>

  <footer>
    Incoming SMS · Bad Rentals API ·
    <a href="https://portal.incoming-sms.com">portal.incoming-sms.com</a>
    ·  This surface only handles bad-rental reports.
  </footer>
</div>
<script>
(function () {
  var btn = document.getElementById('status-go');
  var out = document.getElementById('status-out');
  btn.addEventListener('click', async function () {
    out.textContent = ''; out.className = '';
    var key = document.getElementById('status-key').value.trim();
    var id  = document.getElementById('status-id').value.trim();
    if (!key || !id) { out.textContent = 'API key and identifier are required.'; out.className = 'err'; return; }
    var qs = id.indexOf('+') === 0 || /^\\d{10,15}$/.test(id)
      ? 'e164=' + encodeURIComponent(id)
      : 'reseller_rental_id=' + encodeURIComponent(id);
    try {
      var r = await fetch('/api/rentals/report-bad/status?' + qs, {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      var j = await r.json();
      out.textContent = JSON.stringify(j, null, 2);
      out.className = r.ok ? 'ok' : 'err';
    } catch (e) {
      out.textContent = 'Request failed: ' + e;
      out.className = 'err';
    }
  });
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

// ---------- Router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/' && request.method === 'GET') return landingPage();
    if (url.pathname === '/healthz') {
      return jsonResp({ ok: true, service: 'bad-rentals' });
    }

    // All /api/* routes require auth.
    if (url.pathname.startsWith('/api/')) {
      const auth = await authenticate(request, env);
      if (!auth) return unauthorized();

      if (url.pathname === '/api/rentals/report-bad' && request.method === 'POST') {
        return handleReportBad(auth, env, request);
      }
      if (url.pathname === '/api/rentals/report-bad/status' && request.method === 'GET') {
        return handleReportBadStatus(auth, env, url);
      }
      if (url.pathname === '/api/reports' && request.method === 'GET') {
        return handleReportsList(auth, env, url);
      }
      return notFound();
    }

    return notFound();
  },
};
