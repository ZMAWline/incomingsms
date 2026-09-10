// =========================================================
// Dashboard API keys: per-caller, role-scoped, revocable credentials.
//
// These exist so an external AI agent can drive the dashboard's own routes
// instead of calling Teltik/ATOMIC/Helix/Wing itself. Going through the same
// handlers a human operator's clicks go through is the whole point: the DB
// side effects (sims, sim_numbers, carrier_api_logs, system_errors,
// hosting_port_status_checks) happen identically, so the fleet's state never
// diverges from what a carrier actually did.
//
// A key is nothing more than a second way to authenticate. It resolves to the
// same shape resolveUser() returns, carries one of the same three roles, and
// is then handed to the same canAccess() matrix — an operator key is fenced
// exactly like an operator human, with no per-key route list to drift.
//
// Format: zmaw_<env>_<32 base62 chars>, env being 'test' or 'live'. Only the
// SHA-256 of the full string is stored, matching how dashboard_sessions and
// dashboard_invites treat their tokens: a read of dashboard_api_keys yields
// nothing usable. key_prefix (first 12 chars) exists only so the UI can tell
// two keys apart.
// =========================================================

import { sha256Hex, constantTimeEqual, isValidRole } from '../shared/portal-auth.mjs';

const KEY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_RANDOM_LEN = 32;
const KEY_PREFIX_LEN = 12;

// Anchored so a stray header value can never reach the DB lookup, and so the
// env segment is part of what is matched: a live key pasted into TEST is a
// format mismatch, not a silent 401 you have to guess at.
const KEY_FORMAT = /^zmaw_(test|live)_[0-9A-Za-z]{32}$/;

// Deliberately narrow: a name shows up in audit rows as `apikey:<name>` and in
// the UI, so keep it to something a human can read back over a call.
const KEY_NAME_FORMAT = /^[a-z0-9][a-z0-9._-]{1,62}$/i;

function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

function sb(env, path, init) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...(init || {}),
    headers: sbHeaders(env, init && init.headers),
  });
}

async function sbRows(env, path) {
  try {
    const r = await sb(env, path);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- key generation -------------------------------------------------------

// Rejection sampling rather than `byte % 62`: 256 is not a multiple of 62, so
// the naive modulo would make the first 8 letters of the alphabet ~1.5x more
// likely than the rest and quietly shave entropy off every key.
function randomBase62(n) {
  let out = '';
  while (out.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of bytes) {
      if (b >= 248) continue;             // 248 = 62 * 4, the largest usable multiple
      out += KEY_ALPHABET[b % KEY_ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

// 'test' on the dashboard-test worker, 'live' on production. Set from
// wrangler.toml [vars] / [env.test.vars]; an unset var falls back to 'live' so
// a missing var can never mint a key that claims to be harmless.
export function keyEnvLabel(env) {
  return String(env && env.DASHBOARD_ENV || '').toLowerCase() === 'test' ? 'test' : 'live';
}

export function generateApiKey(env) {
  return 'zmaw_' + keyEnvLabel(env) + '_' + randomBase62(KEY_RANDOM_LEN);
}

// --- authentication -------------------------------------------------------

// `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Basic auth is left
// alone — that is the break-glass path and must keep working.
export function readApiKeyHeader(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
  if (m) return m[1];
  const x = request.headers.get('X-Api-Key');
  return x ? x.trim() : null;
}

// True when the caller *presented* a key, regardless of whether it is valid.
// This is what decides that a failed request gets JSON rather than the HTML
// login page: an agent that gets served a login form sees a 200 and a wall of
// markup, which is far harder to diagnose than a 401.
export function hasApiKeyHeader(request) {
  return readApiKeyHeader(request) !== null;
}

// Resolve a key to a principal, or null. Same shape as resolveUser().
export async function resolveApiKeyUser(env, request, ctx) {
  const raw = readApiKeyHeader(request);
  if (!raw || !KEY_FORMAT.test(raw)) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const hash = await sha256Hex(raw);
  const rows = await sbRows(env,
    'dashboard_api_keys?key_hash=eq.' + encodeURIComponent(hash)
    + '&select=id,name,role,enabled,revoked_at,key_hash&limit=1');
  const row = rows[0];
  if (!row || row.enabled !== true || row.revoked_at) return null;

  // The equality filter above already did the matching, so this is
  // belt-and-braces: it means the comparison this code performs is itself
  // constant-time, and it fails closed if the query is ever loosened to a
  // prefix or ilike match during debugging.
  if (!constantTimeEqual(row.key_hash, hash)) return null;
  if (!isValidRole(row.role)) return null;

  // Fire-and-forget. A key must still work when this write fails, and it must
  // never add latency to the caller's request.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      sb(env, 'dashboard_api_keys?id=eq.' + encodeURIComponent(row.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }).catch(() => {})
    );
  }

  return {
    id: null,
    username: 'apikey:' + row.name,
    role: row.role,
    authType: 'api_key',
    keyName: row.name,
    sessionId: null,
  };
}

// --- key management routes ------------------------------------------------

const SELECT_PUBLIC = 'id,name,key_prefix,role,enabled,created_by,created_at,last_used_at,revoked_at';

async function handleList(env) {
  const keys = await sbRows(env,
    'dashboard_api_keys?select=' + SELECT_PUBLIC + '&order=created_at.desc&limit=500');
  return json({ ok: true, keys });
}

async function handleCreate(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const name = String((body && body.name) || '').trim();
  const role = String((body && body.role) || '').trim();

  if (!KEY_NAME_FORMAT.test(name)) {
    return json({ ok: false, error: 'name must be 2-63 characters: letters, digits, dot, dash or underscore' }, 400);
  }
  if (!isValidRole(role)) {
    return json({ ok: false, error: 'role must be admin, operator, or viewer' }, 400);
  }

  const clash = await sbRows(env,
    'dashboard_api_keys?name=eq.' + encodeURIComponent(name) + '&select=id&limit=1');
  if (clash.length) return json({ ok: false, error: 'A key named "' + name + '" already exists' }, 409);

  const key = generateApiKey(env);
  const r = await sb(env, 'dashboard_api_keys', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      name,
      key_hash: await sha256Hex(key),
      key_prefix: key.slice(0, KEY_PREFIX_LEN),
      role,
      created_by: (user && user.username) || null,
    }),
  });
  if (!r.ok) {
    // The UNIQUE index is the real arbiter; a racing create lands here.
    if (r.status === 409) return json({ ok: false, error: 'A key named "' + name + '" already exists' }, 409);
    return json({ ok: false, error: 'Could not create the key' }, 500);
  }
  const rows = await r.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (row) delete row.key_hash;

  // The plaintext key is returned exactly once, here, and is never
  // reconstructible afterwards. Same contract as invite tokens.
  return json({ ok: true, key, key_env: keyEnvLabel(env), api_key: row });
}

async function handleRevoke(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const name = String((body && body.name) || '').trim();
  if (!name) return json({ ok: false, error: 'name is required' }, 400);

  const r = await sb(env,
    'dashboard_api_keys?name=eq.' + encodeURIComponent(name) + '&revoked_at=is.null',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ enabled: false, revoked_at: new Date().toISOString() }),
    });
  if (!r.ok) return json({ ok: false, error: 'Could not revoke the key' }, 500);
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return json({ ok: false, error: 'No active key named "' + name + '"' }, 404);
  }
  rows.forEach((row) => { delete row.key_hash; });
  return json({ ok: true, revoked: rows[0] });
}

// Returns a Response for /api/keys*, or null to let index.js carry on.
//
// The admin role fence is applied upstream by canAccess() — /api/keys is in
// ADMIN_ONLY_ALL. The extra check here is a different rule: key management is
// off-limits to API keys of ANY role, so a leaked admin key cannot quietly
// mint itself a replacement or revoke the human's keys. Minting credentials
// stays something a signed-in person does.
export async function handleApiKeyRoutes(request, env, url, user) {
  const p = url.pathname;
  if (p !== '/api/keys' && p !== '/api/keys/revoke') return null;

  if (user && user.authType === 'api_key') {
    return json({
      ok: false,
      error: 'forbidden',
      required_role: 'admin',
      message: 'Key management requires a signed-in admin; API keys cannot manage API keys',
    }, 403);
  }

  if (p === '/api/keys' && request.method === 'GET') return handleList(env);
  if (p === '/api/keys' && request.method === 'POST') return handleCreate(request, env, user);
  if (p === '/api/keys/revoke' && request.method === 'POST') return handleRevoke(request, env);
  return json({ ok: false, error: 'method not allowed' }, 405);
}
