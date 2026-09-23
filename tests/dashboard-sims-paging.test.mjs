// GET /api/sims pages, filters and sorts in the database.
//
// As in dashboard-query-input-validation.test.mjs, the real handler is lifted
// out of src/dashboard/index.js and run in a vm with a scripted fetch, so these
// assertions run against the shipped code and the PostgREST URL it builds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as simsQuery from '../src/dashboard/sims-query.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

function extractFn(signature) {
  const start = SRC.indexOf(signature);
  assert.notEqual(start, -1, 'function not found in dashboard source: ' + signature);
  let depth = 0;
  let started = false;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function: ' + signature);
}

function extractHelpers() {
  const start = SRC.indexOf('// ── Request values bound for a PostgREST URL');
  const end = SRC.indexOf('async function supabaseGet(env, path, extraHeaders) {');
  assert.ok(start !== -1 && end > start, 'helper block not found');
  return SRC.slice(start, end);
}

const HANDLERS = [
  'async function supabaseGet(env, path, extraHeaders) {',
  'async function supabaseGetAllArraySerial(env, pathWithoutLimit) {',
  'async function supabaseGetAllArray(env, pathWithoutLimit) {',
  'async function handleSims(env, corsHeaders, url) {',
  'async function loadSimStats(env, sims) {',
  'function simStatFields(simId, smsMap, hostPortMap) {',
  'async function handleSimsFacets(env, corsHeaders) {',
];

const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });

// `respond(url, init)` decides each answer; default is an empty page.
function makeSandbox(respond = () => null) {
  const calls = [];
  const sandbox = {
    console,
    Response,
    URL,
    ...simsQuery,
    loadLatestPortinOutcomes: async () => new Map(), // imported from portin-outcomes.mjs
    async fetch(u, init) {
      const s = String(u);
      calls.push({ url: s, init });
      const r = respond(s, init);
      if (r) return r;
      return new Response('[]', { status: 200, headers: { 'content-range': '*/0' } });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([extractHelpers(), ...HANDLERS.map(extractFn)].join('\n\n'), sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const url = (p) => new URL('https://dashboard' + p);
const get = (sandbox, qs) => sandbox.handleSims(ENV, {}, url('/api/sims?' + qs));
const simsCalls = (calls) => calls.filter(c => c.url.includes('/rest/v1/sims_dashboard?'));
const andParam = (u) => new URL(u).searchParams.get('and');

// --- page and page size ---------------------------------------------------

for (const [qs, limit, offset] of [
  ['', 100, 0],                             // defaults
  ['page=3&page_size=50', 50, 100],
  ['page=0&page_size=0', 1, 0],             // clamped up
  ['page=-4&page_size=100000', 500, 0],     // clamped to the 500 maximum
  ['page=abc&page_size=xyz', 100, 0],       // not numbers: defaults
]) {
  test(`/api/sims?${qs} asks the database for limit=${limit} offset=${offset}`, async () => {
    const { sandbox, calls } = makeSandbox();
    const resp = await get(sandbox, qs);
    assert.equal(resp.status, 200);
    const q = new URL(simsCalls(calls)[0].url).searchParams;
    assert.equal(q.get('limit'), String(limit));
    assert.equal(q.get('offset'), String(offset));
    assert.equal(simsCalls(calls)[0].init.headers.Prefer, 'count=exact');
    const body = await resp.json();
    assert.equal(body.page_size, limit);
  });
}

// --- sort ------------------------------------------------------------------

for (const qs of ['sort=bogus', 'sort=notify_stale', 'sort=id;drop', 'sort=id&dir=sideways']) {
  test(`/api/sims?${qs} is rejected with 400 before any query`, async () => {
    const { sandbox, calls } = makeSandbox();
    const resp = await get(sandbox, qs);
    assert.equal(resp.status, 400);
    assert.equal(calls.length, 0);
  });
}

for (const [qs, order] of [
  ['', 'id.desc'],
  ['sort=id&dir=asc', 'id.asc'],
  ['sort=reseller_name&dir=asc', 'reseller_name.asc.nullslast,id.desc'],
  ['sort=blimei&dir=desc', 'imei.desc.nullslast,id.desc'],
  ['sort=last_notified_at', 'last_notified_at.desc.nullslast,id.desc'],
]) {
  test(`/api/sims?${qs} orders by ${order}`, async () => {
    const { sandbox, calls } = makeSandbox();
    await get(sandbox, qs);
    assert.equal(new URL(simsCalls(calls)[0].url).searchParams.get('order'), order);
  });
}

// --- filters -> PostgREST ---------------------------------------------------

test('default page hides cancelled SIMs; include_cancelled=1 does not', async () => {
  let { sandbox, calls } = makeSandbox();
  await get(sandbox, '');
  assert.equal(andParam(simsCalls(calls)[0].url), '(status.neq.canceled)');
  ({ sandbox, calls } = makeSandbox());
  await get(sandbox, 'include_cancelled=1');
  assert.equal(andParam(simsCalls(calls)[0].url), null);
});

test('toolbar selections and column filters become one quoted and=() tree', async () => {
  const { sandbox, calls } = makeSandbox();
  const filters = [
    { col: 'iccid', op: 'contains', value: '8901' },
    { col: 'gateway_host', op: 'not_in', value: ['teltik'] },
    { col: 'sms_count', op: 'gt', value: 5 },           // derived: not in the tree
    { col: 'last_notified_at', op: 'blank' },
    { col: 'rotation_interval_hours', op: 'between', value: '48', value2: 12 },
    { col: 'port_in_pending', op: 'is_true' },
    { col: 'offline_since', op: 'after', value: '2026-09-01T04:00:00.000Z' },
  ];
  const qs = new URLSearchParams({
    status: 'active,suspended',
    reseller_ids: '7,none',
    vendors: 'teltik,unknown',
    gateways: 'GW1',
    activated_from: '2026-09-01',
    activated_to: '2026-09-02',
    filters: JSON.stringify(filters),
  });
  await get(sandbox, qs.toString());
  assert.equal(andParam(simsCalls(calls)[0].url), '(' + [
    'status.in.("active","suspended")',
    'or(reseller_id.is.null,reseller_id.in.(7))',
    'gateway_code.in.("GW1")',
    'vendor.in.("teltik","unknown")',
    'activated_at.gte."2026-09-01T00:00:00Z"',
    'activated_at.lte."2026-09-02T23:59:59.999Z"',
    'iccid.ilike."*8901*"',
    'or(gateway_host.is.null,gateway_host.eq."",gateway_host.not.in.("teltik"))',
    'last_notified_at.is.null',
    'and(rotation_interval_hours.gte.12,rotation_interval_hours.lte.48)',
    'port_in_pending.is.true',
    'offline_since.gte."2026-09-01T04:00:00.000Z"',
  ].join(',') + ')');
});

test('a filter value cannot break out of its quotes or add a parameter', async () => {
  const { sandbox, calls } = makeSandbox();
  const evil = 'x",id.gt.0)&select=*\\';
  const qs = new URLSearchParams({ filters: JSON.stringify([{ col: 'msisdn', op: 'eq', value: evil }]) });
  await get(sandbox, qs.toString());
  const u = new URL(simsCalls(calls)[0].url);
  assert.equal(u.searchParams.get('select').startsWith('id,iccid,imei,msisdn,'), true);
  assert.equal(u.searchParams.getAll('select').length, 1, 'no second select smuggled in');
  // The quote and backslash are escaped inside one quoted value (the backslash
  // doubled for LIKE, then doubled again for PostgREST's quoting).
  assert.equal(u.searchParams.get('and'), String.raw`(status.neq.canceled,msisdn.ilike."x\",id.gt.0)&select=*\\\\")`);
});

test('computed yes/no columns become condition trees, negated for "is no"', async () => {
  const { sandbox, calls } = makeSandbox();
  const qs = new URLSearchParams({
    include_cancelled: '1',
    filters: JSON.stringify([{ col: 'portin_failed', op: 'is_false' }, { col: 'no_reseller', op: 'is_true' }]),
  });
  await get(sandbox, qs.toString());
  assert.equal(andParam(simsCalls(calls)[0].url),
    '(not.and(atomic_portin_status_code.not.is.null,atomic_portin_status_code.neq."",atomic_portin_status_code.neq."00"),or(reseller_id.is.null))');
});

test('search matches every text column, ids exactly, and phone numbers with or without the leading 1', async () => {
  const { sandbox, calls } = makeSandbox();
  await get(sandbox, 'include_cancelled=1&search=' + encodeURIComponent('5551234567'));
  const tree = andParam(simsCalls(calls)[0].url);
  assert.match(tree, /^\(or\(iccid\.ilike\."\*5551234567\*",imei\.ilike/);
  assert.match(tree, /id\.eq\.5551234567/);
  assert.match(tree, /phone_number\.ilike\."\*15551234567\*",msisdn\.ilike\."\*15551234567\*"/);
});

test('a pasted list of more than 20 identifiers is matched with ilike(any) on identifier columns', async () => {
  const { sandbox, calls } = makeSandbox();
  const iccids = Array.from({ length: 25 }, (_, i) => '8901260' + String(1000000000000 + i));
  await get(sandbox, 'include_cancelled=1&search=' + encodeURIComponent(iccids.join('\n')));
  const tree = andParam(simsCalls(calls)[0].url);
  assert.match(tree, /^\(or\(iccid\.ilike\(any\)\.\{"\*89012601000000000000\*",/);
  assert.doesNotMatch(tree, /status\.ilike/, 'long lists skip the free-text columns');
});

for (const [qs, why] of [
  ['filters=not-json', 'bad JSON'],
  ['filters=' + encodeURIComponent('{"col":"iccid"}'), 'not an array'],
  ['filters=' + encodeURIComponent('[{"col":"password","op":"eq","value":"x"}]'), 'unknown column'],
  ['filters=' + encodeURIComponent('[{"col":"iccid","op":"gt","value":"x"}]'), 'operator not valid for the type'],
  ['filters=' + encodeURIComponent('[{"col":"sms_count","op":"eq","value":"many"}]'), 'number filter without a number'],
  ['filters=' + encodeURIComponent('[{"col":"activated_at","op":"after","value":"2026-09-01"}]'), 'date filter without an instant'],
  ['vendors=verizon', 'vendor outside the allow-list'],
  ['reseller_ids=1;drop', 'reseller id not a number'],
  ['activated_from=yesterday', 'date not YYYY-MM-DD'],
]) {
  test(`/api/sims rejects ${why} with 400 before any query`, async () => {
    const { sandbox, calls } = makeSandbox();
    const resp = await get(sandbox, qs);
    assert.equal(resp.status, 400);
    assert.equal(calls.length, 0);
  });
}

// --- response ----------------------------------------------------------------

test('total comes from the Content-Range header and rows are formatted', async () => {
  const { sandbox } = makeSandbox((u) => u.includes('/sims_dashboard?')
    ? json([{ id: 9, iccid: '8901', imei: '35', vendor: 'teltik', gateway_host: 'teltik', phone_number: '+15550001111', reseller_id: 3, reseller_name: 'R' }],
      { 'content-range': '100-100/5512' })
    : null);
  const resp = await get(sandbox, 'page=2&page_size=100');
  const body = await resp.json();
  assert.equal(body.total, 5512);
  assert.equal(body.page, 2);
  assert.equal(body.page_size, 100);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].blimei, '35');
  assert.equal(body.rows[0].phone_number, '+15550001111');
  assert.equal(body.rows[0].reseller_name, 'R');
  assert.equal(body.rows[0].sms_count, 0);
});

test('a page past the end (PostgREST 416) is an empty page, not an error', async () => {
  const { sandbox } = makeSandbox((u) => u.includes('/sims_dashboard?')
    ? new Response('{"code":"PGRST103"}', { status: 416, headers: { 'content-range': '*/42' } })
    : null);
  const resp = await get(sandbox, 'page=9');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body.rows, []);
  assert.equal(body.total, 42);
});

test('only the SIMs on the page are sent to the stats RPCs', async () => {
  const { sandbox, calls } = makeSandbox((u) => u.includes('/sims_dashboard?')
    ? json([{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'teltik', gateway_host: 'teltik' }], { 'content-range': '0-1/9000' })
    : null);
  await get(sandbox, 'page_size=2');
  const sms = calls.find(c => c.url.endsWith('rpc/get_sms_counts_24h'));
  assert.deepEqual(JSON.parse(sms.init.body), { sim_ids: [1, 2] });
  const hp = calls.find(c => c.url.endsWith('rpc/get_hosting_port_status_summary'));
  assert.deepEqual(JSON.parse(hp.init.body), { sim_ids: [2] });
});

test('?all=1 keeps the original bare-array response', async () => {
  const { sandbox, calls } = makeSandbox((u) => u.includes('/sims_dashboard?') ? json([{ id: 4, iccid: '8901' }]) : null);
  const resp = await get(sandbox, 'all=1&reseller_id=12');
  const body = await resp.json();
  assert.ok(Array.isArray(body));
  assert.equal(body[0].id, 4);
  const u = simsCalls(calls)[0].url;
  assert.ok(u.includes('&status=neq.canceled&reseller_id=eq.12&'), u);
});

test('?all=1 rejects a non-numeric reseller_id with 400', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await get(sandbox, 'all=1&reseller_id=' + encodeURIComponent('1&select=*'));
  assert.equal(resp.status, 400);
  assert.equal(calls.length, 0);
});

// --- derived (RPC) columns -----------------------------------------------------

test('a filter and sort on SMS count is done in the Worker over every matching SIM', async () => {
  const { sandbox, calls } = makeSandbox((u, init) => {
    if (u.includes('select=id%2Cgateway_host%2Cvendor') || u.includes('select=id,gateway_host,vendor')) {
      return json([{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'atomic' }, { id: 3, vendor: 'atomic' }, { id: 4, vendor: 'atomic' }],
        { 'content-range': '0-3/4' });
    }
    if (u.endsWith('rpc/get_sms_counts_24h')) {
      return json([{ sim_id: 1, sms_count: 9 }, { sim_id: 2, sms_count: 1 }, { sim_id: 3, sms_count: 30 }, { sim_id: 4, sms_count: 12 }]);
    }
    if (u.includes('id=in.')) {
      return json([{ id: 3, iccid: 'c' }, { id: 4, iccid: 'd' }]);
    }
    return null;
  });
  const qs = new URLSearchParams({
    sort: 'sms_count', dir: 'desc', page_size: '2',
    filters: JSON.stringify([{ col: 'sms_count', op: 'gte', value: 5 }]),
  });
  const resp = await get(sandbox, qs.toString());
  const body = await resp.json();
  assert.equal(body.total, 3, 'three SIMs have 5+ SMS');
  assert.deepEqual(body.rows.map(r => r.id), [3, 4], 'page 1 of the SMS-descending order');
  assert.deepEqual(body.rows.map(r => r.sms_count), [30, 12]);
  const pageFetch = calls.find(c => c.url.includes('id=in.'));
  assert.ok(pageFetch.url.includes('id=in.(3,4)'), pageFetch.url);
});

test('the no-SMS-in-12h column is derived from the last SMS time', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const f = { col: 'no_sms_12h', op: 'is_true' };
  assert.equal(simsQuery.matchesDerivedFilter({ last_sms_received: null }, f, now), true);
  assert.equal(simsQuery.matchesDerivedFilter({ last_sms_received: '2026-09-21T23:00:00Z' }, f, now), true);
  assert.equal(simsQuery.matchesDerivedFilter({ last_sms_received: '2026-09-22T11:00:00Z' }, f, now), false);
});

// --- helpers and facets --------------------------------------------------------

test('parseContentRangeTotal reads the total and rejects junk', () => {
  assert.equal(simsQuery.parseContentRangeTotal('0-99/5512'), 5512);
  assert.equal(simsQuery.parseContentRangeTotal('*/0'), 0);
  assert.equal(simsQuery.parseContentRangeTotal('0-99/*'), null);
  assert.equal(simsQuery.parseContentRangeTotal(null), null);
});

test('/api/sims/facets returns the fleet-wide counts from the RPC', async () => {
  const facets = { vendor: { teltik: 5000, atomic: 500 } };
  const { sandbox, calls } = makeSandbox((u) => u.endsWith('rpc/sims_dashboard_facets') ? json(facets) : null);
  const resp = await sandbox.handleSimsFacets(ENV, {});
  assert.deepEqual(await resp.json(), { ok: true, facets });
  assert.equal(calls[0].init.method, 'POST');
});

test('/api/sims/facets answers 502 when Supabase fails', async () => {
  const { sandbox } = makeSandbox(() => new Response('{"message":"db down"}', { status: 503 }));
  const resp = await sandbox.handleSimsFacets(ENV, {});
  assert.equal(resp.status, 502);
});

// --- browser ---------------------------------------------------------------------

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');

test('the SIMs table sends its state to the server and debounces filter edits by 300 ms', () => {
  assert.match(HTML, /const SIMS_FETCH_DEBOUNCE_MS = 300;/);
  const render = HTML.slice(HTML.indexOf('function renderSims()'), HTML.indexOf('tbody.innerHTML', HTML.indexOf('function renderSims()')));
  assert.match(render, /scheduleSimsFetch\(\)/, 'every render checks whether the page must be fetched');
  assert.doesNotMatch(render, /paginate\(/, 'the server pages, the browser does not');
  const params = HTML.slice(HTML.indexOf('function simsFilterParams()'), HTML.indexOf('function simsPageParams()'));
  for (const p of ['status', 'reseller_ids', 'vendors', 'gateways', 'activated_from', 'activated_to', 'search', 'filters', 'include_cancelled']) {
    assert.match(params, new RegExp("'" + p + "'"), 'must send ' + p);
  }
});
