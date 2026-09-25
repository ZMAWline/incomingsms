// The Runs page: GET /api/runs lists activation runs and bulk jobs together
// (the dashboard_runs view), and a bulk run opens GET /api/bulk-jobs/:id?all=1.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { handleRunsList } from '../src/dashboard/runs.mjs';
import { handleBulkJobRoutes } from '../src/dashboard/bulk-jobs.mjs';
import { canAccess } from '../src/shared/portal-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const JOB_ID = '11111111-2222-4333-8444-555555555555';

let calls;
let respond;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  respond = () => new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return respond(String(url));
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const list = (qs = '') => handleRunsList(new URL('https://dash.test/api/runs' + qs), ENV, {});

test('runs list: newest first, one round-trip, count from Content-Range', async () => {
  const run = { id: 'r1', run_type: 'bulk', title: 'Bulk rotate — 2 SIMs', status: 'done' };
  respond = () => new Response(JSON.stringify([run]), { status: 200, headers: { 'content-range': '0-0/7' } });
  const res = await list();
  const body = await res.json();
  assert.deepEqual(body, { ok: true, runs: [run], total: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/dashboard_runs\?select=\*&order=created_at\.desc&limit=25&offset=0$/);
  assert.equal(calls[0].headers.Prefer, 'count=exact');
});

test('runs list: type and status filters, with "running" covering both tables', async () => {
  await list('?type=activation&status=running&limit=50&offset=50');
  assert.match(calls[0].url, /run_type=eq\.activation&status=in\.\(queued,processing,running\)&order=created_at\.desc&limit=50&offset=50$/);
});

test('runs list: a bad type or status is a 400 and never reaches Supabase', async () => {
  for (const qs of ['?type=nope', '?status=eq.done', '?status=done)or(id.gt.0']) {
    const res = await list(qs);
    assert.equal(res.status, 400, qs);
  }
  assert.equal(calls.length, 0);
});

test('runs list: an upstream failure is a visible 502, not an empty list', async () => {
  respond = () => new Response('{"message":"relation does not exist"}', { status: 404 });
  const res = await list();
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.runs, undefined);
});

test('bulk job detail ?all=1 returns every item with its steps, in selection order', async () => {
  respond = (u) => u.includes('/bulk_jobs?')
    ? new Response(JSON.stringify([{ id: JOB_ID, status: 'done', total_items: 2 }]), { status: 200 })
    : new Response(JSON.stringify([{ seq: 0 }, { seq: 1 }]), { status: 200 });
  const url = new URL('https://dash.test/api/bulk-jobs/' + JOB_ID + '?all=1');
  const res = await handleBulkJobRoutes(new Request(url), ENV, url, { username: 'v', role: 'viewer' }, {});
  const body = await res.json();
  assert.equal(body.items.length, 2);
  const itemsCall = calls.find(c => c.url.includes('/bulk_job_items?'));
  assert.match(itemsCall.url, /select=seq,sim_id,label,steps,status,result,started_at,finished_at&order=seq\.asc/);
  assert.ok(!itemsCall.url.includes('status=in.'), 'pending and running items are included');
});

test('viewers can read the Runs page but not start or cancel a bulk job', () => {
  assert.equal(canAccess('viewer', 'GET', '/api/runs'), true);
  assert.equal(canAccess('viewer', 'GET', '/api/bulk-jobs/' + JOB_ID), true);
  assert.equal(canAccess('viewer', 'POST', '/api/bulk-jobs'), false);
  assert.equal(canAccess('viewer', 'POST', '/api/bulk-jobs/' + JOB_ID + '/cancel'), false);
});

// --- frontend helpers ---------------------------------------------------------

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0, started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated: ' + signature);
}

function loadHelpers() {
  const sandbox = { teltikHostPortString: () => 'online', loadSims() {}, loadImeiPool() {}, loadErrors() {} };
  vm.createContext(sandbox);
  vm.runInContext([
    extract(HTML, 'function bulkJobError(body, status) {'),
    extract(HTML, 'function bulkStepGood(step) {'),
    extract(HTML, 'function simActionLine(who, step) {'),
    extract(HTML, 'function bulkQueryLine(who, steps) {'),
    'var BULK_JOB_KINDS = ' + extract(HTML, 'const BULK_JOB_KINDS = {').slice('const BULK_JOB_KINDS = '.length) + ';',
    extract(HTML, 'function formatBulkJobItem(kind, item) {'),
    extract(HTML, 'function bulkStepsLabel(steps) {'),
    extract(HTML, 'function bulkRunResultText(kindName, item) {'),
  ].join('\n'), sandbox);
  return sandbox;
}

test('a run line names the action and says what happened', () => {
  const { bulkStepsLabel, bulkRunResultText } = loadHelpers();
  assert.equal(bulkStepsLabel([{ path: '/api/sim-action', body: { action: 'rotate' } }]), 'rotate');
  assert.equal(bulkStepsLabel([{ path: '/api/assign-reseller', body: {} }, { path: '/api/sim-online', body: {} }]), 'assign-reseller → sim-online');

  const done = { seq: 0, sim_id: 4, status: 'done', result: { steps: [
    { path: '/api/assign-reseller', ok: true, status: 200, body: { ok: true } },
    { path: '/api/sim-online', ok: true, status: 200, body: { ok: true } },
  ] } };
  assert.equal(bulkRunResultText('assign-notify', done), 'assigned + notified');
  const failed = { seq: 1, sim_id: 5, status: 'failed', result: { steps: [
    { path: '/api/sim-action', ok: false, status: 200, body: { ok: false, error: 'SIM not found' } },
  ] } };
  assert.equal(bulkRunResultText('sim-action', failed), 'FAILED — SIM not found');
  assert.equal(bulkRunResultText('sim-action', { seq: 2, sim_id: 6, status: 'pending' }), '—');
  assert.equal(bulkRunResultText('sim-action', { seq: 3, sim_id: 7, status: 'cancelled' }), 'Cancelled before it started');
});

test('the Runs page replaced the Activation Runs page', () => {
  assert.ok(HTML.includes('id="tab-runs"'));
  assert.ok(!HTML.includes('id="tab-activation-runs"'));
  assert.ok(HTML.includes(`switchTab('runs', true, false);\n                        showActivationRunDetail(result.job_run_id);`));
});
