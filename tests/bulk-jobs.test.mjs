// Server-side bulk jobs (src/dashboard/bulk-jobs.mjs): the SIMs/Errors bulk
// buttons post their selection once and the dashboard's queue consumer runs
// each SIM, so a locked phone no longer fails the rest of the batch.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  validateBulkJobRequest, runItemSteps, consumeBulkJobBatch, handleBulkJobRoutes,
  resolveJobUser, BULK_JOB_PATHS, MAX_ITEMS,
} from '../src/dashboard/bulk-jobs.mjs';
import { apiKeyMayAccess } from '../src/shared/portal-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const OPERATOR = { id: 'u-1', username: 'ops', role: 'operator', sessionId: 's-1' };
const VIEWER = { id: 'u-2', username: 'view', role: 'viewer', sessionId: 's-2' };
const JOB_ID = '11111111-2222-4333-8444-555555555555';

const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

// --- Supabase mock ---------------------------------------------------------
let calls;
let routes;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, method: init.method || 'GET', body });
    for (const [match, handler] of routes) {
      if (match(u, init.method || 'GET')) return handler(u, body);
    }
    return new Response(null, { status: 204 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const jsonRes = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const on = (method, fragment, handler) => routes.push([(u, m) => m === method && u.includes(fragment), handler]);

function simActionItem(simId) {
  return { sim_id: simId, steps: [{ path: '/api/sim-action', body: { sim_id: simId, action: 'ota_refresh' } }] };
}

// --- validation -------------------------------------------------------------

test('validate: accepts a well-formed job and normalizes items', () => {
  const v = validateBulkJobRequest({ kind: 'sim-action', title: 'Bulk ota', items: [simActionItem(7)] }, OPERATOR);
  assert.equal(v.error, undefined);
  assert.deepEqual(v.job, { kind: 'sim-action', title: 'Bulk ota', spacing_ms: 0 });
  assert.deepEqual(v.items[0], {
    seq: 0, sim_id: 7, label: null,
    steps: [{ path: '/api/sim-action', body: { sim_id: 7, action: 'ota_refresh' }, optional: false }],
  });
});

test('validate: a route outside the allowlist is refused', () => {
  const v = validateBulkJobRequest({
    kind: 'x', title: 't', items: [{ sim_id: 1, steps: [{ path: '/api/users', body: {} }] }],
  }, OPERATOR);
  assert.match(v.error, /not a bulk-job route/);
});

test('validate: the caller must be allowed to call every step route', () => {
  const v = validateBulkJobRequest({ kind: 'sim-action', title: 't', items: [simActionItem(1)] }, VIEWER);
  assert.equal(v.error, 'forbidden');
  assert.equal(v.status, 403);
});

test('validate: item count, step count and spacing are bounded', () => {
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => simActionItem(i));
  assert.match(validateBulkJobRequest({ kind: 'k', title: 't', items: many }, OPERATOR).error, /items must be/);
  const fourSteps = { sim_id: 1, steps: Array(4).fill({ path: '/api/sim-action', body: {} }) };
  assert.match(validateBulkJobRequest({ kind: 'k', title: 't', items: [fourSteps] }, OPERATOR).error, /steps must be/);
  assert.match(validateBulkJobRequest({ kind: 'k', title: 't', spacing_ms: 5000, items: [simActionItem(1)] }, OPERATOR).error, /spacing_ms/);
});

test('every allowlisted path is a real dashboard route', () => {
  const src = read('src', 'dashboard', 'index.js');
  for (const p of BULK_JOB_PATHS) {
    assert.ok(src.includes("url.pathname === '" + p + "'"), p + ' has no route in index.js');
  }
});

// --- step execution ----------------------------------------------------------

test('runItemSteps: dispatches as the job user and stops at the first failed required step', async () => {
  const seen = [];
  const dispatch = async (req, e, c, audit, asUser) => {
    seen.push({ path: new URL(req.url).pathname, user: asUser.username, body: await req.json() });
    return jsonRes({ ok: false, error: 'reseller not found' });
  };
  const out = await runItemSteps(env, {}, dispatch, OPERATOR, [
    { path: '/api/assign-reseller', body: { sim_id: 3, reseller_id: 9 } },
    { path: '/api/sim-online', body: { sim_id: 3 } },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.steps.length, 1, 'notify must not run after a failed assign');
  assert.deepEqual(seen, [{ path: '/api/assign-reseller', user: 'ops', body: { sim_id: 3, reseller_id: 9 } }]);
  assert.equal(out.steps[0].body.error, 'reseller not found');
});

test('runItemSteps: a failed optional step is recorded but does not fail the item', async () => {
  const dispatch = async (req) => new URL(req.url).pathname === '/api/teltik-host-check'
    ? jsonRes({ ok: false }, 502) : jsonRes({ ok: true, response: {} });
  const out = await runItemSteps(env, {}, dispatch, OPERATOR, [
    { path: '/api/atomic-query', body: { identifier: '8901' } },
    { path: '/api/teltik-host-check', body: {}, optional: true },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[1].ok, false);
});

// --- queue consumer ----------------------------------------------------------

function message(body) {
  const m = { body, acked: false, retried: false };
  m.ack = () => { m.acked = true; };
  m.retry = () => { m.retried = true; };
  return m;
}

function jobRow(extra) {
  return { id: JOB_ID, spacing_ms: 0, auth_type: 'session', created_by_user_id: 'u-1', created_by_role: 'operator', ...extra };
}

test('consumer: runs a claimed item, stores the result and settles the job', async () => {
  on('GET', '/bulk_jobs?id=eq.', () => jsonRes([jobRow()]));
  on('GET', '/dashboard_users?id=eq.u-1', () => jsonRes([{ id: 'u-1', username: 'ops', role: 'operator', status: 'active' }]));
  on('POST', '/rpc/claim_bulk_job_item', () => jsonRes([{ seq: 0, steps: simActionItem(5).steps }]));
  on('POST', '/rpc/settle_bulk_job', () => jsonRes('running'));
  const dispatched = [];
  const dispatch = async (req, e, c, audit, asUser) => { dispatched.push(asUser.username); return jsonRes({ ok: true }); };

  const msg = message({ job_id: JOB_ID, seq: 0 });
  await consumeBulkJobBatch({ messages: [msg] }, env, { waitUntil() {} }, dispatch);

  assert.deepEqual(dispatched, ['ops']);
  assert.ok(msg.acked);
  const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('bulk_job_items?job_id=eq.' + JOB_ID + '&seq=eq.0'));
  assert.equal(patch.body.status, 'done');
  assert.equal(patch.body.result.ok, true);
  assert.ok(calls.some(c => c.url.includes('/rpc/settle_bulk_job')));
});

test('consumer: an item that is no longer pending (redelivery, cancel) never runs', async () => {
  on('GET', '/bulk_jobs?id=eq.', () => jsonRes([jobRow()]));
  on('GET', '/dashboard_users', () => jsonRes([{ id: 'u-1', username: 'ops', role: 'operator', status: 'active' }]));
  on('POST', '/rpc/claim_bulk_job_item', () => jsonRes([]));
  let ran = false;
  const msg = message({ job_id: JOB_ID, seq: 0 });
  await consumeBulkJobBatch({ messages: [msg] }, env, {}, async () => { ran = true; return jsonRes({ ok: true }); });
  assert.equal(ran, false);
  assert.ok(msg.acked);
  assert.ok(!calls.some(c => c.method === 'PATCH'));
});

test('consumer: a disabled creator fails the item without running it', async () => {
  on('GET', '/bulk_jobs?id=eq.', () => jsonRes([jobRow()]));
  on('GET', '/dashboard_users', () => jsonRes([{ id: 'u-1', username: 'ops', role: 'operator', status: 'disabled' }]));
  on('POST', '/rpc/claim_bulk_job_item', () => jsonRes([{ seq: 0, steps: simActionItem(5).steps }]));
  on('POST', '/rpc/settle_bulk_job', () => jsonRes('done'));
  let ran = false;
  await consumeBulkJobBatch({ messages: [message({ job_id: JOB_ID, seq: 0 })] }, env, {}, async () => { ran = true; return jsonRes({ ok: true }); });
  assert.equal(ran, false);
  const patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.body.status, 'failed');
  assert.match(patch.body.result.error, /no longer active/);
});

test('consumer: a database failure before the claim retries the message', async () => {
  on('GET', '/bulk_jobs?id=eq.', () => jsonRes({ message: 'down' }, 503));
  const msg = message({ job_id: JOB_ID, seq: 0 });
  await consumeBulkJobBatch({ messages: [msg] }, env, {}, async () => jsonRes({ ok: true }));
  assert.ok(msg.retried);
  assert.ok(!msg.acked);
});

test('resolveJobUser: break-glass jobs stop once break-glass is switched off', async () => {
  const job = jobRow({ auth_type: 'break_glass', created_by_user_id: null, created_by_role: 'admin' });
  assert.equal((await resolveJobUser({ ...env, DASHBOARD_BREAK_GLASS: 'on' }, job)).role, 'admin');
  assert.equal(await resolveJobUser({ ...env, DASHBOARD_BREAK_GLASS: '' }, job), null);
});

// --- create route --------------------------------------------------------------

function createRequest(items) {
  return new Request('https://dash.test/api/bulk-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'sim-action', title: 'Bulk ota', items }),
  });
}

test('create: stores the job and items, then sends one message per item in batches of 100', async () => {
  const batches = [];
  const queueEnv = { ...env, BULK_JOBS_QUEUE: { async sendBatch(msgs) { batches.push(msgs); } } };
  const items = Array.from({ length: 250 }, (_, i) => simActionItem(i + 1));
  const res = await handleBulkJobRoutes(createRequest(items), queueEnv, new URL('https://dash.test/api/bulk-jobs'), OPERATOR, {});
  const body = await res.json();
  assert.equal(res.status, 202);
  assert.equal(body.total_items, 250);
  assert.deepEqual(batches.map(b => b.length), [100, 100, 50]);
  assert.deepEqual(batches[2][49].body, { job_id: body.job_id, seq: 249 });
  const jobInsert = calls.find(c => c.method === 'POST' && c.url.endsWith('/bulk_jobs'));
  assert.equal(jobInsert.body.created_by, 'ops');
  assert.equal(jobInsert.body.auth_type, 'session');
});

test('create: a queue failure cancels the unsent items and reports it', async () => {
  let n = 0;
  const queueEnv = { ...env, BULK_JOBS_QUEUE: { async sendBatch() { if (n++ === 1) throw new Error('queue down'); } } };
  on('POST', '/rpc/settle_bulk_job', () => jsonRes('running'));
  const items = Array.from({ length: 150 }, (_, i) => simActionItem(i + 1));
  const res = await handleBulkJobRoutes(createRequest(items), queueEnv, new URL('https://dash.test/api/bulk-jobs'), OPERATOR, {});
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /after 100 of 150/);
  const cancel = calls.find(c => c.method === 'PATCH' && c.url.includes('bulk_job_items?') && c.url.includes('seq=gte.100'));
  assert.equal(cancel.body.status, 'cancelled');
});

test('cancel: pending items are cancelled and the job is settled', async () => {
  on('POST', '/rpc/settle_bulk_job', () => jsonRes('cancelled'));
  const url = new URL('https://dash.test/api/bulk-jobs/' + JOB_ID + '/cancel');
  const res = await handleBulkJobRoutes(new Request(url, { method: 'POST' }), env, url, OPERATOR, {});
  assert.deepEqual(await res.json(), { ok: true, status: 'cancelled' });
  const itemPatch = calls.find(c => c.method === 'PATCH' && c.url.includes('bulk_job_items?job_id=eq.' + JOB_ID + '&status=eq.pending'));
  assert.equal(itemPatch.body.status, 'cancelled');
});

test('get: a poll re-reads 30 s before its cursor so late-committing items are not skipped', async () => {
  on('GET', '/bulk_jobs?id=eq.', () => jsonRes([{ id: JOB_ID, status: 'done', total_items: 2 }]));
  on('GET', '/bulk_job_items?', () => jsonRes([{ seq: 1, finished_at: '2026-09-25T10:00:05.000+00:00' }]));
  const url = new URL('https://dash.test/api/bulk-jobs/' + JOB_ID + '?since=' + encodeURIComponent('2026-09-25T10:00:40.000+00:00'));
  const res = await handleBulkJobRoutes(new Request(url), env, url, OPERATOR, {});
  const body = await res.json();
  const itemsCall = calls.find(c => c.url.includes('/bulk_job_items?'));
  assert.match(decodeURIComponent(itemsCall.url), /finished_at=gte\.2026-09-25T10:00:10\.000Z/);
  assert.equal(body.cursor, '2026-09-25T10:00:40.000+00:00', 'the cursor never moves backwards');
});

// --- wiring ----------------------------------------------------------------------

test('API keys cannot start bulk jobs', () => {
  assert.equal(apiKeyMayAccess('/api/bulk-jobs'), false);
  assert.equal(apiKeyMayAccess('/api/bulk-jobs/' + JOB_ID + '/cancel'), false);
});

test('index.js routes /api/bulk-jobs, consumes the queue and lets the consumer act as the job user', () => {
  const src = read('src', 'dashboard', 'index.js');
  assert.match(src, /async function handleDashboardRequest\(request, env, ctx, audit, asUser\)/);
  assert.match(src, /const user = asUser\s*\n\s*\|\| \(await resolveUser\(env, request\)\)/);
  assert.match(src, /handleBulkJobRoutes\(request, env, url, user, corsHeaders\)/);
  assert.match(src, /async queue\(batch, env, ctx\) \{\s*await consumeBulkJobBatch\(batch, env, ctx, handleDashboardRequest\);/);
});

test('wrangler.toml binds and consumes the bulk-jobs queue in PROD and TEST', () => {
  const toml = read('src', 'dashboard', 'wrangler.toml');
  for (const [prefix, queue] of [['queues', 'dashboard-bulk-jobs'], ['env.test.queues', 'dashboard-bulk-jobs-test']]) {
    assert.ok(toml.includes('[[' + prefix + '.producers]]\nqueue = "' + queue + '"\nbinding = "BULK_JOBS_QUEUE"'), prefix + ' producer');
    assert.ok(toml.includes('[[' + prefix + '.consumers]]\nqueue = "' + queue + '"\nmax_batch_size = 1'), prefix + ' consumer');
  }
});

// --- frontend -------------------------------------------------------------------

const HTML = read('src', 'dashboard', 'public', 'index.html');

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

test('no bulk button loops over SIMs with a fetch per SIM any more', () => {
  for (const fn of ['bulkSimAction(action)', 'bulkStatusChange(endpoint, label)', 'bulkSendOnline()',
    'bulkAssignReseller()', 'bulkAssignResellerAndNotify()', 'bulkModifyImei()', 'bulkDeleteSims()',
    'bulkErrorAction(action)', 'bulkRetryActivation()', 'bulkQuery()']) {
    const body = extract(HTML, 'async function ' + fn + ' {');
    assert.ok(body.includes('startBulkJob('), fn + ' should start a server-side job');
    assert.ok(!/for \(const \w+ of \w+\) \{[\s\S]*?await fetch\(/.test(body), fn + ' still loops fetches');
  }
});

function loadFormatters() {
  const sandbox = { teltikHostPortString: () => 'online', loadSims() {}, loadImeiPool() {}, loadErrors() {} };
  vm.createContext(sandbox);
  vm.runInContext([
    extract(HTML, 'function bulkJobError(body, status) {'),
    extract(HTML, 'function bulkStepGood(step) {'),
    extract(HTML, 'function simActionLine(who, step) {'),
    extract(HTML, 'function bulkQueryLine(who, steps) {'),
    'var BULK_JOB_KINDS = ' + extract(HTML, 'const BULK_JOB_KINDS = {').slice('const BULK_JOB_KINDS = '.length) + ';',
    extract(HTML, 'function formatBulkJobItem(kind, item) {'),
  ].join('\n'), sandbox);
  return sandbox;
}

const step = (path, ok, body, status = 200) => ({ path, ok, status, body });

test('frontend: Assign + Notify prints the same per-SIM lines as the old loop', () => {
  const { BULK_JOB_KINDS, formatBulkJobItem } = loadFormatters();
  const k = BULK_JOB_KINDS['assign-notify'];
  const fmt = (steps, status = 'done') => formatBulkJobItem(k, { seq: 0, sim_id: 4, status, result: { steps } });
  assert.equal(fmt([step('/api/assign-reseller', true, { ok: true }), step('/api/sim-online', true, { ok: true })]).line, 'SIM #4: assigned + notified');
  assert.equal(fmt([step('/api/assign-reseller', true, { ok: true })]).line, 'SIM #4: assigned (skipped notify — not active or no number)');
  assert.equal(fmt([step('/api/assign-reseller', true, { ok: true }), step('/api/sim-online', false, { ok: false, error: 'boom' }, 500)]).line, 'SIM #4: assigned, notify FAILED — boom');
  assert.equal(fmt([step('/api/assign-reseller', false, { ok: false, error: 'no reseller' })]).line, 'SIM #4: FAILED — no reseller');
  assert.deepEqual([...fmt([], 'cancelled').tally], ['cancelled']);
});

test('frontend: an interrupted item shows the server-side reason', () => {
  const { BULK_JOB_KINDS, formatBulkJobItem } = loadFormatters();
  const f = formatBulkJobItem(BULK_JOB_KINDS['sim-action'], { seq: 0, sim_id: 9, status: 'failed', result: { error: 'Interrupted: x' } });
  assert.equal(f.line, 'SIM #9: FAILED — Interrupted: x');
});

test('frontend: bulk query keeps the ATOMIC status line and the Teltik host tag', () => {
  const { BULK_JOB_KINDS, formatBulkJobItem } = loadFormatters();
  const atomic = { ok: true, response: { wholeSaleApi: { wholeSaleResponse: { Result: { attStatus: 'A' } } } }, db_update: { found: true, mdn_updated: true, mdn_new: '5551234567' } };
  const f = formatBulkJobItem(BULK_JOB_KINDS.query, {
    seq: 0, sim_id: 1, label: '8901', status: 'done',
    result: { steps: [step('/api/atomic-query', true, atomic), step('/api/teltik-host-check', true, { ok: true, mdn: '5551234567', mdn_source: 'teltik' })] },
  });
  assert.equal(f.line, '8901 [atomic]: A [MDN→5551234567] [Teltik host: port=online, mdn=5551234567 via teltik]');
});
