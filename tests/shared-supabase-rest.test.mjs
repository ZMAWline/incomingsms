// Tests for src/shared/supabase-rest.mjs, the one Supabase PostgREST helper
// the workers share, plus a source scan that keeps migrated workers from
// growing their own copy again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sbHeaders, sbGet, sbGetAll, sbPost, sbPatch, sbDelete, sbRpc, SupabaseError, PAGE_SIZE,
} from '../src/shared/supabase-rest.mjs';

const ENV = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' };

// Replaces globalThis.fetch for one test. `respond(url, init)` returns
// { status, body, headers }; every call is recorded.
function fakeFetch(t, respond) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = '', headers = {} } = respond(String(url), init) || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text === '' ? null : text, { status, headers });
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('sbHeaders carries the service key and merges extra headers last', () => {
  assert.deepEqual(sbHeaders(ENV), {
    apikey: 'svc-key',
    Authorization: 'Bearer svc-key',
    Accept: 'application/json',
  });
  const h = sbHeaders(ENV, { Prefer: 'count=exact', Accept: 'text/csv' });
  assert.equal(h.Prefer, 'count=exact');
  assert.equal(h.Accept, 'text/csv');
});

test('sbGet hits /rest/v1/<path> with auth headers and returns rows', async (t) => {
  const calls = fakeFetch(t, () => ({ body: [{ id: 1 }, { id: 2 }] }));
  const rows = await sbGet(ENV, 'sims?select=id&status=eq.active');
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls[0].url, 'https://db.example/rest/v1/sims?select=id&status=eq.active');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.apikey, 'svc-key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer svc-key');
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  assert.equal(calls[0].init.body, undefined);
});

test('sbGet returns [] for an empty body', async (t) => {
  fakeFetch(t, () => ({ body: '' }));
  assert.deepEqual(await sbGet(ENV, 'sims?select=id'), []);
});

test('sbGet single returns the first row or null', async (t) => {
  let rows = [{ id: 7 }, { id: 8 }];
  fakeFetch(t, () => ({ body: rows }));
  assert.deepEqual(await sbGet(ENV, 'sims?select=id&limit=1', { single: true }), { id: 7 });
  rows = [];
  assert.equal(await sbGet(ENV, 'sims?select=id&limit=1', { single: true }), null);
});

test('sbGet count sends Prefer: count=exact and reads Content-Range', async (t) => {
  const calls = fakeFetch(t, () => ({ body: [{ id: 1 }], headers: { 'content-range': '0-0/4213' } }));
  const out = await sbGet(ENV, 'sims?select=id&limit=1', { count: 'exact' });
  assert.deepEqual(out, { rows: [{ id: 1 }], count: 4213 });
  assert.equal(calls[0].init.headers.Prefer, 'count=exact');
});

test('sbGet count is null when Content-Range has no total', async (t) => {
  fakeFetch(t, () => ({ body: [], headers: { 'content-range': '*/*' } }));
  assert.equal((await sbGet(ENV, 'sims?select=id', { count: 'exact' })).count, null);
});

test('a non-2xx response throws SupabaseError with status and body', async (t) => {
  fakeFetch(t, () => ({ status: 409, body: '{"code":"23505","message":"duplicate key"}' }));
  await assert.rejects(sbGet(ENV, 'sims?select=id'), (err) => {
    assert.ok(err instanceof SupabaseError);
    assert.equal(err.status, 409);
    assert.equal(err.body, '{"code":"23505","message":"duplicate key"}');
    assert.match(err.message, /^Supabase GET failed 409: /);
    return true;
  });
  for (const call of [
    () => sbPost(ENV, 'sims', [{}]),
    () => sbPatch(ENV, 'sims?id=eq.1', {}),
    () => sbDelete(ENV, 'sims?id=eq.1'),
    () => sbRpc(ENV, 'fn', {}),
    () => sbGetAll(ENV, 'sims?select=id&order=id.asc'),
  ]) {
    await assert.rejects(call(), SupabaseError);
  }
});

test('a timeout is a plain Error, not a SupabaseError', async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  t.after(() => { globalThis.fetch = real; });
  await assert.rejects(sbGet({ ...ENV, FETCH_TIMEOUT_SUPABASE_MS: 5 }, 'sims?select=id'), (err) => {
    assert.ok(!(err instanceof SupabaseError));
    assert.match(err.message, /timeout after 5ms/);
    return true;
  });
});

test('sbGetAll pages with limit/offset until a short page', async (t) => {
  const total = PAGE_SIZE * 2 + 3;
  const calls = fakeFetch(t, (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    const n = Math.max(0, Math.min(limit, total - offset));
    return { body: Array.from({ length: n }, (_, i) => ({ id: offset + i })) };
  });
  const rows = await sbGetAll(ENV, 'sims?select=id&order=id.asc');
  assert.equal(rows.length, total);
  assert.equal(rows[total - 1].id, total - 1);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2].url).searchParams.get('offset'), String(PAGE_SIZE * 2));
});

test('sbGetAll adds ? when the path has no query string', async (t) => {
  const calls = fakeFetch(t, () => ({ body: [] }));
  assert.deepEqual(await sbGetAll(ENV, 'gateways'), []);
  assert.equal(calls[0].url, `https://db.example/rest/v1/gateways?limit=${PAGE_SIZE}&offset=0`);
});

test('sbPost sends JSON with the Prefer header and returns the parsed body', async (t) => {
  const calls = fakeFetch(t, () => ({ status: 201, body: [{ id: 42 }] }));
  const out = await sbPost(ENV, 'sims', [{ iccid: '1' }], { prefer: 'return=representation' });
  assert.deepEqual(out, [{ id: 42 }]);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Prefer, 'return=representation');
  assert.equal(calls[0].init.body, JSON.stringify([{ iccid: '1' }]));
});

test('sbPost with return=minimal returns null for the empty 201', async (t) => {
  fakeFetch(t, () => ({ status: 201, body: '' }));
  assert.equal(await sbPost(ENV, 'sims', [{}], { prefer: 'return=minimal' }), null);
});

test('upsert: sbPost passes on_conflict in the path and merge-duplicates in Prefer', async (t) => {
  const calls = fakeFetch(t, () => ({ status: 201 }));
  await sbPost(ENV, 'sims?on_conflict=iccid', { iccid: '1' }, { prefer: 'resolution=merge-duplicates,return=minimal' });
  assert.equal(calls[0].url, 'https://db.example/rest/v1/sims?on_conflict=iccid');
  assert.equal(calls[0].init.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
});

test('sbPatch and sbDelete use their methods; no Prefer unless asked', async (t) => {
  const calls = fakeFetch(t, () => ({ status: 204 }));
  assert.equal(await sbPatch(ENV, 'sims?id=eq.1', { status: 'active' }), null);
  assert.equal(await sbDelete(ENV, 'sims?id=eq.1'), null);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.body, '{"status":"active"}');
  assert.equal(calls[0].init.headers.Prefer, undefined);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.body, undefined);
});

test('sbRpc posts args to /rest/v1/rpc/<fn> and returns scalars and rows', async (t) => {
  let body = true;
  const calls = fakeFetch(t, () => ({ body }));
  assert.equal(await sbRpc(ENV, 'claim_rotation_slot', { p_sim_id: 5 }), true);
  assert.equal(calls[0].url, 'https://db.example/rest/v1/rpc/claim_rotation_slot');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"p_sim_id":5}');
  body = [{ day: '2026-09-22', up: 0.99 }];
  assert.deepEqual(await sbRpc(ENV, 'get_teltik_daily_uptime'), body);
  assert.equal(calls[1].init.body, '{}');
});

test('raw: true returns the Response untouched and does not throw on a non-2xx', async (t) => {
  const calls = fakeFetch(t, (url) => (url.includes('missing') ? { status: 404, body: 'nope' } : { status: 201, body: [{ id: 1 }] }));
  const miss = await sbGet(ENV, 'missing?select=id', { raw: true });
  assert.ok(miss instanceof Response);
  assert.equal(miss.ok, false);
  assert.equal(miss.status, 404);
  assert.equal(await miss.text(), 'nope');
  const res = await sbPost(ENV, 'sims', [{ iccid: '1' }], { prefer: 'return=minimal', raw: true });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), [{ id: 1 }]);
  assert.equal(calls[1].init.headers.Prefer, 'return=minimal');
  assert.equal((await sbPatch(ENV, 'missing?id=eq.1', {}, { raw: true })).status, 404);
  assert.equal((await sbDelete(ENV, 'missing?id=eq.1', { raw: true })).status, 404);
  assert.equal((await sbRpc(ENV, 'missing', {}, { raw: true })).status, 404);
});

test('logRows: true asks for the rows back and logs how many a write touched', async (t) => {
  const calls = fakeFetch(t, () => ({ body: [{ id: 1 }, { id: 2 }] }));
  const logged = [];
  t.mock.method(console, 'log', (msg) => logged.push(msg));
  assert.deepEqual(await sbPatch(ENV, 'sims?id=in.(1,2)', { status: 'active' }, { logRows: true }), [{ id: 1 }, { id: 2 }]);
  await sbPost(ENV, 'sim_numbers', [{ sim_id: 1 }, { sim_id: 2 }], { logRows: true });
  assert.equal(calls[0].init.headers.Prefer, 'return=representation');
  assert.deepEqual(logged, ['[DB] PATCH result: 2 rows updated', '[DB] POST result: 2 rows inserted']);
});

// ---------------------------------------------------------------------------
// Source scan: a migrated worker must not define its own Supabase REST helper.
// ---------------------------------------------------------------------------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER_DEF = /^(?:export\s+)?(?:async\s+)?function\s+(sb(?:Headers|Get|GetAll|GetArray|Select|Post|Insert|Patch|Delete|Rpc|Upsert)|supabase(?:Headers|Get|GetArray|GetAllArray|GetOne|Select|SelectOne|Insert|Upsert|Patch|Delete|Rpc|ExactCount))\s*\(/gm;

// Workers still on a local copy, by file and helper name. Each would carry a
// TODO(shared-supabase) comment saying why. Empty since every worker moved
// over; keep it that way (use the raw / logRows options instead of a copy).
const NOT_YET_MIGRATED = {};

function workerSourceFiles() {
  const out = [];
  for (const worker of readdirSync(path.join(ROOT, 'src'))) {
    if (worker === 'shared' || worker === 'dashboard') continue;
    const dir = path.join(ROOT, 'src', worker);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (/\.(m?js)$/.test(f)) out.push(`src/${worker}/${f}`);
    }
  }
  return out;
}

test('no worker defines its own Supabase REST helper outside the allow-list', () => {
  const offenders = [];
  for (const rel of workerSourceFiles()) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const allowed = NOT_YET_MIGRATED[rel] || [];
    for (const m of src.matchAll(HELPER_DEF)) {
      if (!allowed.includes(m[1])) offenders.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'import these from src/shared/supabase-rest.mjs instead of redefining them');
});

test('every allow-listed helper still exists and is marked TODO(shared-supabase)', () => {
  for (const [rel, names] of Object.entries(NOT_YET_MIGRATED)) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const defined = [...src.matchAll(HELPER_DEF)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(defined.includes(name), `${rel} no longer defines ${name}: drop it from NOT_YET_MIGRATED`);
    }
    assert.match(src, /TODO\(shared-supabase\)/, `${rel} needs a TODO(shared-supabase) note`);
  }
});
