// =========================================================
// dashboard_audit_log: one row per acting request against /api/*.
//
// This is the operator-intent layer, and it is deliberately separate from the
// two logs that already exist:
//   - system_errors     — failures only, written by handlers that notice one.
//   - carrier_api_logs  — one row per carrier HTTP call, no notion of caller.
// Neither answers "which caller suspended this line at 03:14", which is the
// question an autonomous agent driving the fleet makes urgent.
//
// Two rules shape everything below:
//
// 1. The actor comes from the authenticated principal, never from the request
//    body. Several handlers accept `body.actor` for display in their own
//    domain tables; that value is client-supplied and unverified, so it is
//    captured inside request_body like any other field and is NOT what lands
//    in the actor column.
//
// 2. Logging never blocks and never fails a request. The row is written from
//    ctx.waitUntil after the response object exists, and every path through
//    this module swallows its own errors. An audit trail that can take the
//    dashboard down is worse than no audit trail.
// =========================================================

// Carrier-touching reads. They are GETs at the route level but they spend
// carrier quota and are exactly what you want to see when an agent has been
// hammering something, so they are audited despite the method.
const AUDIT_GET_ROUTES = [
  '/api/helix-query', '/api/helix-query-bulk', '/api/wing-check',
  '/api/teltik-query', '/api/teltik-host-check', '/api/atomic-query',
  '/api/check-imei', '/api/keys',
];

// Cap on the stored body. Bulk activations and CSV uploads can be megabytes;
// a jsonb column full of them turns the audit table into the biggest thing in
// the database and buys nothing an operator would ever read.
const MAX_BODY_BYTES = 8192;

// Bodies here are large by design and hold nothing worth auditing beyond the
// fact of the call, which the row itself records.
const SKIP_BODY_ROUTES = ['/api/bill-audit/upload', '/api/import-teltik'];

// Anything whose field name reads like a credential. Over-redaction is the
// right failure mode: a redacted `monkey` field costs nothing, a logged
// password costs a rotation.
const SENSITIVE_FIELD = /secret|password|passwd|token|apikey|api_key|key|^pin$|credential/i;

function matchesRoute(pathname, list) {
  return list.some((r) => pathname === r || pathname.startsWith(r + '/'));
}

// Which requests earn a row: every acting request, plus the carrier reads.
// Plain GETs are the dashboard's polling traffic (/api/sims every few
// seconds, /api/stats, /api/errors) and would drown the table.
export function shouldAudit(method, pathname) {
  const p = String(pathname || '');
  if (!p.startsWith('/api/')) return false;
  const m = String(method || '').toUpperCase();
  if (m === 'OPTIONS') return false;
  if (m !== 'GET' && m !== 'HEAD') return true;
  return matchesRoute(p, AUDIT_GET_ROUTES);
}

export function redact(value, depth) {
  const d = depth || 0;
  if (value == null || d > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_FIELD.test(k) ? '[REDACTED]' : redact(value[k], d + 1);
    }
    return out;
  }
  return value;
}

function firstString(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const head = firstString(value[0]);
    if (!head) return null;
    return value.length > 1 ? head + ' +' + (value.length - 1) : head;
  }
  if (typeof value === 'object') return null;
  const s = String(value).trim();
  return s ? s.slice(0, 120) : null;
}

function pick(body, names) {
  for (const n of names) {
    const v = firstString(body[n]);
    if (v) return v;
  }
  return null;
}

// Pull the identifiers an operator would search by out of whatever shape the
// handler happens to take. Every route names these differently, so this is a
// best-effort lift, not a schema — request_body keeps the full picture.
export function extractSubject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { sim_id: null, iccid: null, mdn: null, action: null };
  }
  let iccid = pick(body, ['iccid', 'iccids', 'new_iccid']);
  // /api/activate posts `sims: [{ iccid, ... }]`.
  if (!iccid && Array.isArray(body.sims) && body.sims[0] && typeof body.sims[0] === 'object') {
    iccid = firstString(body.sims.map((s) => s && s.iccid).filter(Boolean));
  }
  let mdn = pick(body, ['mdn', 'msisdn', 'to_number', 'phone_number']);

  // /api/atomic-query takes one `identifier` that is an ICCID or an MDN.
  const identifier = firstString(body.identifier);
  if (identifier && !iccid && /^89\d{16,19}/.test(identifier)) iccid = identifier;
  else if (identifier && !mdn) mdn = identifier;

  return {
    sim_id: pick(body, ['sim_id', 'sim_ids', 'simId']),
    iccid,
    mdn,
    action: pick(body, ['action', 'op', 'requestType']),
  };
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || null;
}

// Read the request body for the audit row without disturbing the handler's
// own read. Must be called on a clone taken BEFORE the handler runs.
export async function captureBody(request, pathname) {
  if (matchesRoute(pathname, SKIP_BODY_ROUTES)) return { note: 'body not captured (bulk upload route)' };
  try {
    const text = await request.text();
    if (!text) return null;
    if (text.length > MAX_BODY_BYTES) {
      return { truncated: true, bytes: text.length, head: text.slice(0, 512) };
    }
    return redact(JSON.parse(text));
  } catch {
    return null;                            // not JSON, or already consumed
  }
}

// The authenticated principal, reduced to the three audit columns. `user` is
// whatever resolveUser / breakGlassUser / resolveApiKeyUser returned.
export function principal(user) {
  if (!user) return { actor: 'anonymous', actor_type: 'anonymous', role: null };
  if (user.authType === 'api_key') {
    return { actor: user.username, actor_type: 'api_key', role: user.role };
  }
  if (user.username === 'break-glass' && !user.id) {
    return { actor: 'break-glass', actor_type: 'break_glass', role: user.role };
  }
  return { actor: user.username, actor_type: 'user', role: user.role };
}

export function buildAuditRow(request, url, user, body, status, durationMs, error) {
  const who = principal(user);
  const subject = extractSubject(body);
  return {
    actor: who.actor,
    actor_type: who.actor_type,
    role: who.role,
    method: request.method,
    path: url.pathname,
    sim_id: subject.sim_id,
    iccid: subject.iccid,
    mdn: subject.mdn,
    action: subject.action,
    request_body: body == null ? null : body,
    status,
    ok: status >= 200 && status < 400,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    error: error ? String(error).slice(0, 1000) : null,
    ip: clientIp(request),
    user_agent: (request.headers.get('User-Agent') || '').slice(0, 300) || null,
  };
}

export function writeAuditRow(env, ctx, row) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
    const p = fetch(env.SUPABASE_URL + '/rest/v1/dashboard_audit_log', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    }).catch((e) => { console.log('[Audit] write failed: ' + (e && e.message || e)); });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch (e) {
    console.log('[Audit] write skipped: ' + (e && e.message || e));
  }
}

// --- the wrapper ----------------------------------------------------------

// Runs the dashboard's whole request chain, then logs it. `handler` fills in
// `audit.user` once the principal is known; everything else is derived here,
// so no individual route has to know that auditing exists.
export async function withAuditLog(request, env, ctx, handler) {
  const url = new URL(request.url);
  const audit = { user: null };
  const wanted = shouldAudit(request.method, url.pathname);
  const started = Date.now();

  // The clone has to be taken before the handler consumes the body, but it is
  // only read afterwards, so an unaudited request pays nothing.
  const bodyClone = (wanted && request.method !== 'GET' && request.method !== 'HEAD')
    ? request.clone() : null;

  let response;
  let thrown = null;
  try {
    response = await handler(request, env, ctx, audit);
  } catch (e) {
    thrown = e;
    response = new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (wanted) {
    try {
      const body = bodyClone ? await captureBody(bodyClone, url.pathname) : null;
      writeAuditRow(env, ctx, buildAuditRow(
        request, url, audit.user, body, response.status, Date.now() - started,
        thrown ? String(thrown && thrown.stack || thrown) : null
      ));
    } catch (e) {
      console.log('[Audit] skipped: ' + (e && e.message || e));
    }
  }

  if (thrown) console.log('[Dashboard] unhandled: ' + String(thrown && thrown.stack || thrown));
  return response;
}

// --- GET /api/audit-log ---------------------------------------------------

// Operator+ read (it is not in READ_ROUTES, so the path-first matrix already
// requires operator). Filters are substring on actor and path, which is what
// "show me what the agent did to port-in routes" actually needs.
export async function handleAuditLogQuery(env, url, corsHeaders) {
  const headers = { ...(corsHeaders || {}), 'Content-Type': 'application/json' };
  try {
    const limitRaw = parseInt(url.searchParams.get('limit') || '200', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;

    let q = 'dashboard_audit_log?select=id,ts,actor,actor_type,role,method,path,sim_id,iccid,mdn,'
      + 'action,status,ok,duration_ms,error,ip,request_body&order=ts.desc&limit=' + limit;

    const actor = (url.searchParams.get('actor') || '').trim();
    if (actor) q += '&actor=ilike.*' + encodeURIComponent(actor) + '*';

    const path = (url.searchParams.get('path') || '').trim();
    if (path) q += '&path=ilike.*' + encodeURIComponent(path) + '*';

    const since = (url.searchParams.get('since') || '').trim();
    if (since) {
      const t = Date.parse(since);
      if (!Number.isFinite(t)) {
        return new Response(JSON.stringify({ ok: false, error: 'since must be an ISO 8601 timestamp' }), { status: 400, headers });
      }
      q += '&ts=gte.' + encodeURIComponent(new Date(t).toISOString());
    }

    const res = await fetch(env.SUPABASE_URL + '/rest/v1/' + q, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'supabase_' + res.status, detail: (await res.text()).slice(0, 300) }), { status: 502, headers });
    }
    const rows = await res.json();
    return new Response(JSON.stringify({ ok: true, count: Array.isArray(rows) ? rows.length : 0, rows }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers });
  }
}
