// =========================================================
// Saved filters for the SIMs table, scoped to the calling account.
//
// PR #104 put these in localStorage, which made them per-browser. They are a
// per-person working set — the views an operator actually uses — so they now
// live in dashboard_saved_filters keyed by the authenticated principal.
//
// Ownership is the username the rest of the dashboard already treats as the
// principal's name: a real account's username, 'break-glass', or
// 'apikey:<name>'. Same string dashboard_audit_log.actor records, so a saved
// filter and the audit row that created it name the same caller. Ownership is
// never taken from the request — there is no `owner` field in any payload, and
// one caller cannot address another's filters at all, because every query is
// pinned to owner=eq.<caller>.
//
// Routes:
//   GET    /api/saved-filters          list mine
//   PUT    /api/saved-filters/:name    upsert mine
//   DELETE /api/saved-filters/:name    delete mine
//
// The role fence and the audit trail are applied upstream in index.js, the
// same as every other route: requiredRole() in shared/portal-auth.mjs
// classifies these (see SELF_SERVICE_ROUTES there — a viewer may save their
// own view), and withAuditLog() records the PUT and DELETE because they are
// not GETs. Nothing here needs to know either exists.
// =========================================================

const PREFIX = '/api/saved-filters';

// A name is a label in a chip row, so keep it to something that fits and that
// a person can read back. The length cap also bounds the URL, since the name
// is the path segment.
const MAX_NAME_LEN = 80;

// The captured view is small — a handful of arrays of ids and a list of column
// filters. 64 KB is far above anything the UI produces and far below anything
// that would make the table expensive to read. Rejecting at the API rather
// than letting Postgres take it keeps a runaway client from filling the table.
const MAX_FILTER_BYTES = 64 * 1024;

// Read "list mine" is one row per named view; nobody has hundreds, and the cap
// stops a pathological owner from turning a chip row into a page load.
const MAX_FILTERS_PER_OWNER = 200;

const SELECT_PUBLIC = 'id,name,filter,created_at,updated_at';

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

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

// --- pure helpers (unit-tested directly) ----------------------------------

// The principal's stable name. Returns null for anything that is not a usable
// identity, so a handler can refuse rather than write rows nobody owns.
export function savedFilterOwner(user) {
  const name = user && typeof user.username === 'string' ? user.username.trim() : '';
  return name ? name : null;
}

// Splits /api/saved-filters[/<name>] into a route decision. Returns null when
// the path is not ours at all, so index.js can carry on down the chain.
//
// The name is one path segment and arrives percent-encoded; anything with a
// slash in it would not round-trip, and `decodeURIComponent` throws on a
// malformed escape, so both are reported as a bad name rather than crashing
// the request.
export function parseSavedFilterPath(pathname) {
  const p = String(pathname || '');
  if (p !== PREFIX && !p.startsWith(PREFIX + '/')) return null;
  if (p === PREFIX || p === PREFIX + '/') return { name: null };
  const raw = p.slice(PREFIX.length + 1);
  if (raw.includes('/')) return { name: null, invalid: true };
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return { name: null, invalid: true }; }
  const name = normalizeSavedFilterName(decoded);
  return name === null ? { name: null, invalid: true } : { name };
}

// Trim, and refuse empties, over-long names and control characters. Control
// characters matter because the name is rendered into the chip row and echoed
// back in errors.
export function normalizeSavedFilterName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LEN) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// The stored view. Validated for shape and size, not for schema: the contents
// belong to the frontend's SIMS_COLUMNS registry and change with it, and the
// UI already drops filters naming a column that no longer exists. An array or
// a scalar would round-trip through jsonb but is never what the UI sends, so
// it is refused — a client sending one has a bug, and silently storing it
// would surface later as an unexplained broken chip.
export function validateSavedFilterBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const filter = body.filter;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return { ok: false, error: 'filter must be a JSON object' };
  }
  let encoded;
  try { encoded = JSON.stringify(filter); } catch { return { ok: false, error: 'filter is not serializable' }; }
  if (encoded.length > MAX_FILTER_BYTES) {
    return { ok: false, error: 'filter is too large (max ' + MAX_FILTER_BYTES + ' bytes)' };
  }
  return { ok: true, filter };
}

// --- handlers -------------------------------------------------------------

function ownerFilter(owner) {
  return 'owner=eq.' + encodeURIComponent(owner);
}

// Surfaces a database failure instead of swallowing it, the same reasoning as
// handleList in api-keys.mjs: "you have no saved filters" and "the table is
// unreachable" look identical in the chip row, and the wrong one of those
// invites the operator to rebuild a view they already have.
async function handleList(env, owner) {
  const r = await sb(env,
    'dashboard_saved_filters?' + ownerFilter(owner)
    + '&select=' + SELECT_PUBLIC
    + '&order=name.asc&limit=' + MAX_FILTERS_PER_OWNER);
  if (!r.ok) {
    return json({ ok: false, error: 'supabase_' + r.status, detail: (await r.text()).slice(0, 300) }, 502);
  }
  const rows = await r.json().catch(() => []);
  return json({ ok: true, filters: Array.isArray(rows) ? rows : [] });
}

async function handleUpsert(request, env, owner, name) {
  let body = {};
  try { body = await request.json(); } catch { body = null; }
  const check = validateSavedFilterBody(body);
  if (!check.ok) return json({ ok: false, error: check.error }, 400);

  // Checked before the write so the cap cannot be walked past one filter at a
  // time. One query answers both questions: how many this owner has, and
  // whether this name is among them — replacing an existing view is never a
  // new row, so it is never refused for being at the cap. A read failure
  // deliberately does not block the write; the cap is housekeeping, not a
  // security boundary.
  const existing = await sb(env,
    'dashboard_saved_filters?' + ownerFilter(owner)
    + '&select=name&limit=' + (MAX_FILTERS_PER_OWNER + 1));
  if (existing.ok) {
    const rows = await existing.json().catch(() => []);
    const names = Array.isArray(rows) ? rows.map((r) => r.name) : [];
    if (names.length >= MAX_FILTERS_PER_OWNER && !names.includes(name)) {
      return json({ ok: false, error: 'You have reached the limit of ' + MAX_FILTERS_PER_OWNER + ' saved filters' }, 409);
    }
  }

  const now = new Date().toISOString();
  const r = await sb(env, 'dashboard_saved_filters?on_conflict=owner,name', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ owner, name, filter: check.filter, updated_at: now }),
  });
  if (!r.ok) {
    return json({ ok: false, error: 'supabase_' + r.status, detail: (await r.text()).slice(0, 300) }, 502);
  }
  const rows = await r.json().catch(() => []);
  return json({ ok: true, filter: Array.isArray(rows) && rows[0] ? rows[0] : null });
}

async function handleDelete(env, owner, name) {
  const r = await sb(env,
    'dashboard_saved_filters?' + ownerFilter(owner) + '&name=eq.' + encodeURIComponent(name),
    { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!r.ok) {
    return json({ ok: false, error: 'supabase_' + r.status, detail: (await r.text()).slice(0, 300) }, 502);
  }
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return json({ ok: false, error: 'No saved filter named "' + name + '"' }, 404);
  }
  return json({ ok: true, deleted: rows[0].name });
}

// Returns a Response for /api/saved-filters*, or null to let index.js carry on.
export async function handleSavedFilterRoutes(request, env, url, user) {
  const route = parseSavedFilterPath(url.pathname);
  if (!route) return null;

  const owner = savedFilterOwner(user);
  if (!owner) {
    return json({ ok: false, error: 'unauthorized', message: 'Not authenticated' }, 401);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'not_configured', message: 'Saved filters are not configured' }, 503);
  }

  const method = String(request.method || '').toUpperCase();

  if (route.name === null) {
    if (route.invalid) {
      return json({ ok: false, error: 'name must be 1-' + MAX_NAME_LEN + ' characters' }, 400);
    }
    if (method === 'GET') return handleList(env, owner);
    return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
  }

  if (method === 'PUT') return handleUpsert(request, env, owner, route.name);
  if (method === 'DELETE') return handleDelete(env, owner, route.name);
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'PUT, DELETE' });
}

export { MAX_NAME_LEN, MAX_FILTER_BYTES, MAX_FILTERS_PER_OWNER };
