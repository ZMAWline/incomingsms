// Request values that reach a Supabase (PostgREST) URL.
//
// A PostgREST filter is plain query-string text: a raw `status` of
// "active&select=*" adds a select, and "active)or(id.gt.0" reshapes the filter.
// The dashboard now allow-lists values from a known set, requires ids to be
// positive whole numbers (parsePositiveInt), and turns a non-2xx Supabase
// answer into a 502 instead of passing the error object on as data.
//
// As in dashboard-public-bad-rental-csv-key.test.mjs, the real handlers are
// lifted out of src/dashboard/index.js and run in a vm with a scripted fetch,
// so these assertions run against the shipped code.

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

// The helper block: parsePositiveInt, the allow-lists, badRequest,
// SupabaseError, supabaseJson and errorResponse.
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
  'async function sbGet(env, path) {',
  'async function handleSims(env, corsHeaders, url) {',
  'async function loadSimStats(env, sims) {',
  'function simStatFields(simId, smsMap, hostPortMap) {',
  'async function handleErrors(env, corsHeaders, url) {',
  'async function handleActivationRunsList(env, corsHeaders, url) {',
  'async function handleSimOnline(request, env, corsHeaders) {',
  'async function handleAtomicSwapSim(request, env, corsHeaders) {',
  'async function handleDeleteSim(request, env, corsHeaders) {',
  'async function handleSimAction(request, env, corsHeaders) {',
];

// `respond(url)` decides each Supabase answer; default is an empty list.
function makeSandbox(respond = () => null) {
  const calls = [];
  const sandbox = {
    console,
    Response,
    URL,
    logSystemError: async () => {}, // handleSimAction logs failures; not under test
    ...simsQuery, // handleSims imports its query builder from sims-query.mjs
    async fetch(url) {
      const u = String(url);
      calls.push(u);
      const r = respond(u);
      if (r) return r;
      return new Response('[]', { status: 200, headers: { 'content-range': '*/0' } });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([extractHelpers(), ...HANDLERS.map(extractFn)].join('\n\n'), sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const CORS = {};
const url = (p) => new URL('https://dashboard' + p);
const jsonReq = (body) => ({ json: async () => body });
const supabaseDown = () => new Response('{"code":"PGRST000","message":"db down"}', { status: 503 });

// --- parsePositiveInt ------------------------------------------------------

test('parsePositiveInt accepts only positive whole numbers', () => {
  const { sandbox } = makeSandbox();
  const p = sandbox.parsePositiveInt;
  assert.equal(p(1), 1);
  assert.equal(p('42'), 42);
  for (const bad of ['1;drop', 'abc', '-1', '1.5', 1.5, -1, 0, '0', '', '01', ' 1', '1 ', null, undefined, {}, [1], 'eq.1', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(p(bad), null, 'should reject ' + JSON.stringify(bad));
  }
});

// --- /api/sims status filter ----------------------------------------------

// The paged table takes a comma list of statuses; ?all=1 keeps the original
// single-status parameter. Both allow-list every value.
for (const [status, all] of [['bogus', false], ['active&select=*', false], ['active)or(id.gt.0', false], ['active,bogus', false],
  ['bogus', true], ['active&select=*', true], ['active)or(id.gt.0', true], ['active,canceled', true]]) {
  test(`/api/sims${all ? '?all=1' : ''} rejects status=${status} with 400 and never queries`, async () => {
    const { sandbox, calls } = makeSandbox();
    const q = new URLSearchParams(all ? { all: '1', status } : { status });
    const resp = await sandbox.handleSims(ENV, CORS, url('/api/sims?' + q));
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Invalid status/);
    assert.equal(calls.length, 0);
  });
}

test('/api/sims passes a valid status through as an exact filter', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleSims(ENV, CORS, url('/api/sims?all=1&status=rotation_failed'));
  assert.equal(resp.status, 200);
  assert.ok(calls[0].includes('&status=eq.rotation_failed&'), calls[0]);
});

test('/api/sims rejects a non-numeric id with 400', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleSims(ENV, CORS, url('/api/sims?id=' + encodeURIComponent('1&select=*')));
  assert.equal(resp.status, 400);
  assert.equal(calls.length, 0);
});

test('/api/sims encodes an iccid lookup', async () => {
  const { sandbox, calls } = makeSandbox();
  await sandbox.handleSims(ENV, CORS, url('/api/sims?iccid=' + encodeURIComponent('8901&select=*')));
  assert.ok(calls[0].includes('&iccid=eq.8901%26select%3D*'), calls[0]);
});

for (const qs of ['status=active', 'all=1&status=active']) {
  test(`/api/sims?${qs} answers 502 when Supabase fails`, async () => {
    const { sandbox } = makeSandbox(supabaseDown);
    const resp = await sandbox.handleSims(ENV, CORS, url('/api/sims?' + qs));
    assert.equal(resp.status, 502);
    assert.match((await resp.json()).detail, /db down/);
  });
}

// --- /api/errors ------------------------------------------------------------

test('/api/errors rejects an unknown or injection-shaped status with 400', async () => {
  for (const status of ['closed', 'open&select=*', 'open)or(id.gt.0']) {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleErrors(ENV, CORS, url('/api/errors?' + new URLSearchParams({ status })));
    assert.equal(resp.status, 400, status);
    assert.equal(calls.length, 0);
  }
});

test('/api/errors passes a valid status through', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleErrors(ENV, CORS, url('/api/errors?status=acknowledged'));
  assert.equal(resp.status, 200);
  assert.ok(calls[0].endsWith('&status=eq.acknowledged'), calls[0]);
});

test('/api/errors answers 502 instead of treating a Supabase error as rows', async () => {
  const { sandbox } = makeSandbox(supabaseDown);
  const resp = await sandbox.handleErrors(ENV, CORS, url('/api/errors'));
  assert.equal(resp.status, 502);
  const body = await resp.json();
  assert.match(body.error, /Supabase query failed \(503\)/);
});

// --- /api/activation-runs ---------------------------------------------------

test('/api/activation-runs rejects a bad status or source with 400', async () => {
  for (const qs of ['status=nope', 'source=csv%26select%3D*', 'source=json)or(id.gt.0']) {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleActivationRunsList(ENV, CORS, url('/api/activation-runs?' + qs));
    assert.equal(resp.status, 400, qs);
    assert.equal(calls.length, 0);
  }
});

test('/api/activation-runs passes valid status and source through', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleActivationRunsList(ENV, CORS, url('/api/activation-runs?status=failed&source=csv'));
  assert.equal(resp.status, 200);
  assert.ok(calls[0].endsWith('&status=eq.failed&source=eq.csv'), calls[0]);
});

// --- sim_id in request bodies ----------------------------------------------

const BAD_SIM_IDS = ['1;drop', 'abc', '-1', '1.5', -1, 1.5, '1&select=*'];

test('/api/sim-online rejects malformed sim_id with 400', async () => {
  for (const sim_id of BAD_SIM_IDS) {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleSimOnline({ method: 'POST', ...jsonReq({ sim_id }) }, ENV, CORS);
    assert.equal(resp.status, 400, JSON.stringify(sim_id));
    assert.equal(calls.length, 0);
  }
});

test('/api/sim-online answers 502 when the SIM lookup fails', async () => {
  const { sandbox } = makeSandbox(supabaseDown);
  const resp = await sandbox.handleSimOnline({ method: 'POST', ...jsonReq({ sim_id: '7' }) }, ENV, CORS);
  assert.equal(resp.status, 502);
});

test('/api/sim-online builds the lookup from a clean id', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleSimOnline({ method: 'POST', ...jsonReq({ sim_id: '7' }) }, ENV, CORS);
  assert.equal(resp.status, 404); // empty list → SIM not found
  assert.ok(calls[0].endsWith('&id=eq.7'), calls[0]);
});

test('/api/atomic-swap-sim rejects malformed sim_id with 400', async () => {
  for (const sim_id of BAD_SIM_IDS) {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleAtomicSwapSim(jsonReq({ sim_id, new_iccid: '89010000000000000000' }), ENV, CORS);
    assert.equal(resp.status, 400, JSON.stringify(sim_id));
    assert.equal(calls.length, 0);
  }
});

test('/api/atomic-swap-sim answers 502 when the SIM lookup fails', async () => {
  const { sandbox } = makeSandbox(supabaseDown);
  const env = { ...ENV, ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p' };
  const resp = await sandbox.handleAtomicSwapSim(jsonReq({ sim_id: 7, new_iccid: '89010000000000000000' }), env, CORS);
  assert.equal(resp.status, 502);
});

test('/api/delete-sim rejects "1;drop" instead of deleting SIM 1', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleDeleteSim(jsonReq({ sim_id: '1;drop' }), ENV, CORS);
  assert.equal(resp.status, 400);
  assert.equal(calls.length, 0, 'nothing is deleted');
});

test('/api/sim-action rejects malformed sim_id with 400', async () => {
  for (const sim_id of BAD_SIM_IDS) {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleSimAction(jsonReq({ sim_id, action: 'rotate' }), ENV, CORS);
    assert.equal(resp.status, 400, JSON.stringify(sim_id));
    assert.equal(calls.length, 0);
  }
});

test('/api/sim-action answers 502 when the vendor lookup fails', async () => {
  const { sandbox } = makeSandbox(supabaseDown);
  const env = { ...ENV, ADMIN_RUN_SECRET: 's' };
  const resp = await sandbox.handleSimAction(jsonReq({ sim_id: 7, action: 'rotate' }), env, CORS);
  assert.equal(resp.status, 502);
});
