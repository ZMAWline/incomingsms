// Per-account saved filters: the routes, the ownership scoping, and where
// they sit in the role matrix.
//
// The point of this file is the scoping. A saved filter is keyed by the
// authenticated principal's username, and that username is never taken from
// anything the caller sends — so the tests below drive the real handler
// against a stub Supabase and assert on the PostgREST queries it built, which
// is where an ownership leak would actually show up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleSavedFilterRoutes,
  savedFilterOwner,
  parseSavedFilterPath,
  normalizeSavedFilterName,
  validateSavedFilterBody,
  MAX_NAME_LEN,
  MAX_FILTER_BYTES,
  MAX_FILTERS_PER_OWNER,
} from '../src/dashboard/saved-filters.mjs';
import { requiredRole, canAccess, apiKeyMayAccess } from '../src/shared/portal-auth.mjs';
import { shouldAudit } from '../src/dashboard/audit-log.mjs';

const ENV = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const USER = { id: 'u1', username: 'zalmen', role: 'admin' };

// A stub PostgREST. Records every request the handler makes and answers from
// an in-memory table, so the assertions can be about the query the handler
// built rather than about a mock's return value.
function stubSupabase(rows, overrides) {
  const requests = [];
  const table = [...(rows || [])];
  const o = overrides || {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const q = String(url).replace('https://db.example/rest/v1/', '');
    requests.push({ method, q, body: init && init.body ? JSON.parse(init.body) : null });
    if (o.status) {
      return new Response(o.body || 'boom', { status: o.status });
    }
    const ownerMatch = /owner=eq\.([^&]*)/.exec(q);
    const owner = ownerMatch ? decodeURIComponent(ownerMatch[1]) : null;
    const nameMatch = /[?&]name=eq\.([^&]*)/.exec(q);
    const name = nameMatch ? decodeURIComponent(nameMatch[1]) : null;
    const hit = table.filter((r) => (owner === null || r.owner === owner)
      && (name === null || r.name === name));

    if (method === 'GET') return Response.json(hit);
    if (method === 'DELETE') {
      for (const r of hit) table.splice(table.indexOf(r), 1);
      return Response.json(hit);
    }
    // POST with resolution=merge-duplicates, i.e. the upsert.
    const sent = JSON.parse(init.body);
    const existing = table.find((r) => r.owner === sent.owner && r.name === sent.name);
    if (existing) Object.assign(existing, sent);
    else table.push({ id: 'new', created_at: 'now', ...sent });
    return Response.json([table.find((r) => r.owner === sent.owner && r.name === sent.name)]);
  };
  return {
    requests,
    table,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

function req(method, path, body) {
  return new Request('https://dash.example' + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

async function call(method, path, user, body, rows, overrides) {
  const sb = stubSupabase(rows, overrides);
  try {
    const url = new URL('https://dash.example' + path);
    const res = await handleSavedFilterRoutes(req(method, path, body), ENV, url, user);
    const json = res ? await res.json().catch(() => null) : null;
    return { res, json, requests: sb.requests, table: sb.table };
  } finally {
    sb.restore();
  }
}

// --- ownership ------------------------------------------------------------

test('the owner is the authenticated username, for all three ways of authenticating', () => {
  assert.equal(savedFilterOwner({ username: 'zalmen', role: 'admin' }), 'zalmen');
  // break-glass and API keys have no dashboard_users row, which is exactly why
  // the column is text and not a FK to one.
  assert.equal(savedFilterOwner({ id: null, username: 'break-glass', role: 'admin' }), 'break-glass');
  assert.equal(savedFilterOwner({ id: null, username: 'apikey:agent-prod', role: 'operator' }), 'apikey:agent-prod');
  assert.equal(savedFilterOwner({ username: '   ' }), null);
  assert.equal(savedFilterOwner(null), null);
});

test('every query is pinned to the caller, so one account cannot read another', async () => {
  const rows = [
    { id: '1', owner: 'zalmen', name: 'mine', filter: { search: 'a' } },
    { id: '2', owner: 'someone-else', name: 'theirs', filter: { search: 'b' } },
  ];
  const { json, requests } = await call('GET', '/api/saved-filters', USER, undefined, rows);
  assert.equal(json.ok, true);
  assert.deepEqual(json.filters.map((f) => f.name), ['mine']);
  assert.match(requests[0].q, /owner=eq\.zalmen/);
});

test('the caller cannot smuggle an owner through the body', async () => {
  const { json, table } = await call('PUT', '/api/saved-filters/x', USER,
    { owner: 'someone-else', filter: { search: 'a' } }, []);
  assert.equal(json.ok, true);
  assert.equal(table.length, 1);
  assert.equal(table[0].owner, 'zalmen', 'ownership comes from the session, never the payload');
});

test('deleting only ever reaches the caller\'s own row', async () => {
  const rows = [
    { id: '1', owner: 'zalmen', name: 'shared-name', filter: {} },
    { id: '2', owner: 'someone-else', name: 'shared-name', filter: {} },
  ];
  const { json, table, requests } = await call('DELETE', '/api/saved-filters/shared-name', USER, undefined, rows);
  assert.equal(json.ok, true);
  assert.match(requests[0].q, /owner=eq\.zalmen/);
  assert.deepEqual(table.map((r) => r.owner), ['someone-else'],
    'the other account\'s identically-named filter must survive');
});

test('deleting a name the caller does not have is a 404, not a silent success', async () => {
  const { res, json } = await call('DELETE', '/api/saved-filters/nope', USER, undefined,
    [{ id: '2', owner: 'someone-else', name: 'nope', filter: {} }]);
  assert.equal(res.status, 404);
  assert.equal(json.ok, false);
});

// --- upsert ---------------------------------------------------------------

test('PUT is an upsert: the same name twice leaves one row', async () => {
  const sb = stubSupabase([]);
  try {
    const url = new URL('https://dash.example/api/saved-filters/view');
    await handleSavedFilterRoutes(req('PUT', '/api/saved-filters/view', { filter: { search: 'a' } }), ENV, url, USER);
    await handleSavedFilterRoutes(req('PUT', '/api/saved-filters/view', { filter: { search: 'b' } }), ENV, url, USER);
    assert.equal(sb.table.length, 1);
    assert.deepEqual(sb.table[0].filter, { search: 'b' });
    const upserts = sb.requests.filter((r) => r.method === 'POST');
    assert.equal(upserts.length, 2);
    assert.match(upserts[0].q, /on_conflict=owner,name/,
      'the unique (owner, name) index is what makes this an upsert rather than a duplicate');
  } finally {
    sb.restore();
  }
});

test('the upsert stamps updated_at so a replaced view is not frozen at creation', async () => {
  const { requests } = await call('PUT', '/api/saved-filters/view', USER, { filter: {} }, []);
  const post = requests.find((r) => r.method === 'POST');
  assert.ok(post.body.updated_at, 'updated_at must be sent');
  assert.ok(!Number.isNaN(Date.parse(post.body.updated_at)));
});

test('a filter that is not a JSON object is refused', async () => {
  for (const body of [{}, { filter: null }, { filter: 'nope' }, { filter: [1, 2] }, null]) {
    const { res, json } = await call('PUT', '/api/saved-filters/view', USER, body, []);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.ok, false);
  }
});

test('an oversized filter is refused by the API, not handed to Postgres', async () => {
  const big = { search: 'x'.repeat(MAX_FILTER_BYTES + 100) };
  const { res, requests } = await call('PUT', '/api/saved-filters/view', USER, { filter: big }, []);
  assert.equal(res.status, 400);
  assert.equal(requests.length, 0, 'nothing should reach the database');
});

test('the per-owner cap blocks a new name but never blocks replacing one', async () => {
  const full = [];
  for (let i = 0; i < MAX_FILTERS_PER_OWNER; i++) full.push({ id: String(i), owner: 'zalmen', name: 'v' + i, filter: {} });

  const blocked = await call('PUT', '/api/saved-filters/one-more', USER, { filter: {} }, full);
  assert.equal(blocked.res.status, 409);

  const allowed = await call('PUT', '/api/saved-filters/v3', USER, { filter: { search: 'z' } }, full);
  assert.equal(allowed.res.status, 200, 'editing an existing view is not a new row');
});

// --- names ----------------------------------------------------------------

test('names are trimmed, bounded, and free of control characters', () => {
  assert.equal(normalizeSavedFilterName('  Teltik offline  '), 'Teltik offline');
  assert.equal(normalizeSavedFilterName(''), null);
  assert.equal(normalizeSavedFilterName('   '), null);
  assert.equal(normalizeSavedFilterName('x'.repeat(MAX_NAME_LEN)), 'x'.repeat(MAX_NAME_LEN));
  assert.equal(normalizeSavedFilterName('x'.repeat(MAX_NAME_LEN + 1)), null);
  assert.equal(normalizeSavedFilterName('bad\nname'), null);
  assert.equal(normalizeSavedFilterName(42), null);
});

test('the path parser separates "not my route" from "bad name"', () => {
  assert.equal(parseSavedFilterPath('/api/sims'), null);
  assert.equal(parseSavedFilterPath('/api/saved-filters-other'), null);
  assert.deepEqual(parseSavedFilterPath('/api/saved-filters'), { name: null });
  assert.deepEqual(parseSavedFilterPath('/api/saved-filters/'), { name: null });
  assert.deepEqual(parseSavedFilterPath('/api/saved-filters/Teltik%20offline'), { name: 'Teltik offline' });
  // A malformed escape must be a 400, not an exception escaping the handler.
  assert.deepEqual(parseSavedFilterPath('/api/saved-filters/%E0%A4%A'), { name: null, invalid: true });
  assert.deepEqual(parseSavedFilterPath('/api/saved-filters/a/b'), { name: null, invalid: true });
});

test('a name with a slash or a % in it round-trips through the URL', async () => {
  const name = 'a/b 100% done';
  const path = '/api/saved-filters/' + encodeURIComponent(name);
  const { json, table } = await call('PUT', path, USER, { filter: { search: 'x' } }, []);
  assert.equal(json.ok, true);
  assert.equal(table[0].name, name, 'the encoded slash must not be read as a path separator');
});

test('a bad name on the collection path is a 400', async () => {
  const { res } = await call('GET', '/api/saved-filters/' + 'x'.repeat(MAX_NAME_LEN + 1), USER, undefined, []);
  assert.equal(res.status, 400);
});

// --- method and configuration handling ------------------------------------

test('unsupported methods are 405 with an Allow header, not a wrong-shaped 200', async () => {
  const collection = await call('POST', '/api/saved-filters', USER, {}, []);
  assert.equal(collection.res.status, 405);
  assert.equal(collection.res.headers.get('Allow'), 'GET');

  const item = await call('GET', '/api/saved-filters/view', USER, undefined, []);
  assert.equal(item.res.status, 405);
  assert.equal(item.res.headers.get('Allow'), 'PUT, DELETE');
});

test('paths that are not ours return null so the router carries on', async () => {
  const url = new URL('https://dash.example/api/sims');
  assert.equal(await handleSavedFilterRoutes(req('GET', '/api/sims'), ENV, url, USER), null);
});

test('an unusable principal is refused rather than writing an unowned row', async () => {
  const { res } = await call('GET', '/api/saved-filters', { username: '' }, undefined, []);
  assert.equal(res.status, 401);
});

test('a missing Supabase binding is a 503, not a crash', async () => {
  const url = new URL('https://dash.example/api/saved-filters');
  const res = await handleSavedFilterRoutes(req('GET', '/api/saved-filters'), {}, url, USER);
  assert.equal(res.status, 503);
});

test('a database failure on list is surfaced, not rendered as "you have none"', async () => {
  const { res, json } = await call('GET', '/api/saved-filters', USER, undefined, [], { status: 500 });
  assert.equal(res.status, 502);
  assert.equal(json.ok, false);
  assert.match(json.error, /supabase_500/);
});

// --- where this sits in the existing fences -------------------------------

test('a viewer may read and edit their own saved views', () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal(requiredRole(method, '/api/saved-filters'), 'viewer', method);
    assert.equal(requiredRole(method, '/api/saved-filters/my-view'), 'viewer', method);
    assert.ok(canAccess('viewer', method, '/api/saved-filters/my-view'));
  }
});

test('the self-service exception did not widen anything else', () => {
  // The default stays "a write needs operator, and a route nobody classified
  // is not a viewer read".
  assert.equal(requiredRole('POST', '/api/rotate-sim'), 'operator');
  assert.equal(requiredRole('GET', '/api/audit-log'), 'operator');
  assert.equal(requiredRole('POST', '/api/keys'), 'admin');
  assert.equal(requiredRole('POST', '/api/plan-rates'), 'admin');
  // A route whose name merely starts the same way must not inherit it.
  assert.equal(requiredRole('POST', '/api/saved-filters-export'), 'operator');
});

test('API keys reach saved filters — nothing here ends a line\'s life', () => {
  assert.ok(apiKeyMayAccess('/api/saved-filters'));
  assert.ok(apiKeyMayAccess('/api/saved-filters/my-view'));
  // And a key gets its own namespace, so the agent cannot see an operator's views.
  assert.equal(savedFilterOwner({ username: 'apikey:agent-prod', authType: 'api_key', role: 'operator' }),
    'apikey:agent-prod');
});

test('writes are audited and the list read is not, per the existing convention', () => {
  assert.equal(shouldAudit('PUT', '/api/saved-filters/view'), true);
  assert.equal(shouldAudit('DELETE', '/api/saved-filters/view'), true);
  // Plain GETs are the dashboard's polling traffic and would drown the table.
  assert.equal(shouldAudit('GET', '/api/saved-filters'), false);
});

test('validateSavedFilterBody accepts the shape the UI actually captures', () => {
  const captured = {
    status: ['active'], resellerIds: [], vendors: ['teltik'], gateways: [],
    activatedFrom: '', activatedTo: '', search: 'abc',
    columnFilters: [{ col: 'hosting_port_state', op: 'in', value: ['offline'] }],
    sortKey: 'sms_count', sortDir: 'desc',
  };
  const out = validateSavedFilterBody({ filter: captured });
  assert.equal(out.ok, true);
  assert.deepEqual(out.filter, captured);
});
