// Durable Workers-page "Hosting Port Check" jobs: enqueue endpoint, status
// polling endpoint, scheduled-tick drain with persisted offsets/totals, lease
// reclaim, and the wiring proofs that the sweep no longer depends on a
// browser-side batch loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  enqueueHostingPortJob,
  getHostingPortJob,
  processHostingPortJobs,
  JOB_LEASE_MS,
} from '../src/shared/hosting-port-status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MIGRATION = read('migrations', '20260804_hosting_port_status_jobs.sql');
const DASHBOARD_SRC = read('src', 'dashboard', 'index.js');
const DASHBOARD_HTML = read('src', 'dashboard', 'public', 'index.html');
const DASHBOARD_TOML = read('src', 'dashboard', 'wrangler.toml');

const ENV = { SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'key', TELTIK_API_KEY: 'tk' };

const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

// In-memory hosting_port_status_jobs + sims fleet behind the PostgREST URLs
// the shared module uses. Evaluates the claimable or=() filter server-side so
// the optimistic-claim/lease semantics are actually exercised.
function jobsMock(state) {
  return async (url, opts = {}) => {
    url = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (url.includes('/rest/v1/hosting_port_status_jobs')) {
      if (method === 'POST') {
        const row = {
          id: 'job-' + (state.jobs.length + 1), source: 'manual_sweep',
          status: 'queued', next_offset: 0, max_sims: 200, batches: 0, total_available: null,
          totals: { checked: 0, online: 0, offline: 0, unknown: 0, error: 0, wrong_mdn_retries: 0 },
          error: null, created_by: null, started_at: null, finished_at: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          ...JSON.parse(opts.body),
        };
        state.jobs.push(row);
        return jsonResp([row], 201);
      }
      const staleMatch = url.match(/or=\(status\.eq\.queued,and\(status\.eq\.running,updated_at\.lt\.([^)]+)\)\)/);
      const claimable = j => j.status === 'queued'
        || (j.status === 'running' && j.updated_at < decodeURIComponent(staleMatch[1]));
      const idMatch = url.match(/id=eq\.([^&]+)/);
      if (method === 'PATCH') {
        const j = state.jobs.find(x => x.id === decodeURIComponent(idMatch[1]));
        if (!j || (staleMatch && !claimable(j))) return jsonResp([]);
        Object.assign(j, JSON.parse(opts.body));
        return jsonResp([j]);
      }
      if (idMatch) {
        const j = state.jobs.find(x => x.id === decodeURIComponent(idMatch[1]));
        return jsonResp(j ? [j] : []);
      }
      if (url.includes('status=in.(queued,running)')) {
        return jsonResp(state.jobs.filter(j => j.status === 'queued' || j.status === 'running').slice(0, 1));
      }
      if (staleMatch) return jsonResp(state.jobs.filter(claimable).slice(0, 1));
      return jsonResp([]);
    }
    if (url.includes('/rest/v1/hosting_port_status_checks')) {
      state.posted.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (url.includes('/rest/v1/carrier_api_logs')) return new Response(null, { status: 201 });
    if (url.includes('/rest/v1/sims')) {
      if (state.simsDown) throw new Error('supabase down');
      const params = new URL(url).searchParams;
      const off = Number(params.get('offset'));
      const lim = Number(params.get('limit'));
      const page = state.fleet.slice(off, off + lim);
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Range': off + '-' + (off + page.length - 1) + '/' + state.fleet.length },
      });
    }
    if (url.includes('/rest/v1/inbound_sms')) return jsonResp([]);
    if (url.includes('/v1/port-status')) return jsonResp({ port_status: 'online' });
    throw new Error('unexpected fetch ' + url);
  };
}

const makeFleet = n => Array.from({ length: n }, (_, i) =>
  // db_current_mdn fallback needs a valid e164; without it readTeltikPortStatus
  // skips with state 'error' and the mocked /v1/port-status is never reached.
  ({ id: i + 1, iccid: 'ICC' + (i + 1), vendor: 'teltik', gateway_host: null,
     sim_numbers: [{ e164: '+1202555010' + i }] }));

// --- enqueue ----------------------------------------------------------------

test('enqueueHostingPortJob creates one job and dedupes while a sweep is pending', async () => {
  const state = { jobs: [], posted: [], fleet: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = jobsMock(state);
  try {
    const first = await enqueueHostingPortJob(ENV, { maxSims: 200, createdBy: 'dashboard' });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');
    assert.equal(first.already_pending, false);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].created_by, 'dashboard');
    // Second click while pending: same job back, no duplicate sweep stacked.
    const second = await enqueueHostingPortJob(ENV, {});
    assert.equal(second.ok, true);
    assert.equal(second.already_pending, true);
    assert.equal(second.job_id, first.job_id);
    assert.equal(state.jobs.length, 1);
    // Status endpoint reads the same row.
    const job = await getHostingPortJob(ENV, first.job_id);
    assert.equal(job.id, first.job_id);
    assert.equal(job.status, 'queued');
  } finally { globalThis.fetch = orig; }
});

// --- scheduled drain --------------------------------------------------------

test('processHostingPortJobs drains one bounded batch per tick, persisting offset/totals until done', async () => {
  const state = { jobs: [], posted: [], fleet: makeFleet(5) };
  const orig = globalThis.fetch;
  globalThis.fetch = jobsMock(state);
  try {
    const { job_id } = await enqueueHostingPortJob(ENV, { maxSims: 2 });
    const job = () => state.jobs[0];

    // Tick 1: batch at offset 0. Progress persists server-side — no browser involved.
    let out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.deepEqual(out, { claimed: 1, batches: 1, finished: 0, failed: 0 });
    assert.equal(job().status, 'queued', 'ready for next tick');
    assert.equal(job().next_offset, 2, 'offset persisted after the batch');
    assert.equal(job().batches, 1);
    assert.equal(job().total_available, 5);
    assert.equal(job().totals.checked, 2);
    assert.ok(job().started_at, 'started_at stamped on first claim');

    // Tick 2: continues at the persisted offset.
    out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.equal(job().next_offset, 4);
    assert.equal(job().totals.checked, 4);

    // Tick 3: last partial batch finishes the job.
    out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.deepEqual(out, { claimed: 1, batches: 1, finished: 1, failed: 0 });
    assert.equal(job().status, 'done');
    assert.equal(job().next_offset, 5);
    assert.equal(job().totals.checked, 5);
    assert.equal(job().totals.online, 5);
    assert.equal(job().batches, 3);
    assert.ok(job().finished_at);

    // Every SIM checked exactly once, recorded with the job's source.
    assert.equal(state.posted.length, 5);
    assert.deepEqual(state.posted.map(p => p.sim_id).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.ok(state.posted.every(p => p.source === 'manual_sweep'));

    // Tick 4: nothing left to claim.
    out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.deepEqual(out, { claimed: 0, batches: 0, finished: 0, failed: 0 });
    assert.equal((await getHostingPortJob(ENV, job_id)).status, 'done');
  } finally { globalThis.fetch = orig; }
});

test('a running job with a fresh lease is not double-claimed; a stale one is reclaimed', async () => {
  const state = { jobs: [], posted: [], fleet: makeFleet(1) };
  const orig = globalThis.fetch;
  globalThis.fetch = jobsMock(state);
  try {
    await enqueueHostingPortJob(ENV, { maxSims: 2 });
    state.jobs[0].status = 'running';
    state.jobs[0].updated_at = new Date().toISOString(); // batch in flight elsewhere
    let out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.equal(out.claimed, 0, 'fresh running job left alone');
    assert.equal(state.posted.length, 0);

    // Crash recovery: lease expired -> reclaimed and finished.
    state.jobs[0].updated_at = new Date(Date.now() - JOB_LEASE_MS - 60_000).toISOString();
    out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.equal(out.claimed, 1);
    assert.equal(state.jobs[0].status, 'done');
    assert.equal(state.posted.length, 1);
  } finally { globalThis.fetch = orig; }
});

test('a batch whose sims query fails marks the job failed with the error', async () => {
  const state = { jobs: [], posted: [], fleet: makeFleet(3), simsDown: true };
  const orig = globalThis.fetch;
  globalThis.fetch = jobsMock(state);
  try {
    await enqueueHostingPortJob(ENV, { maxSims: 2 });
    const out = await processHostingPortJobs(ENV, { maxJobs: 1 });
    assert.deepEqual(out, { claimed: 1, batches: 0, finished: 0, failed: 1 });
    assert.equal(state.jobs[0].status, 'failed');
    assert.match(state.jobs[0].error, /sims_query_failed/);
    assert.ok(state.jobs[0].finished_at);
  } finally { globalThis.fetch = orig; }
});

// --- migration --------------------------------------------------------------

test('jobs migration is idempotent and matches what the code reads/writes', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS hosting_port_status_jobs/);
  for (const col of ['id', 'source', 'status', 'next_offset', 'max_sims', 'batches',
    'total_available', 'totals', 'error', 'created_by', 'started_at', 'finished_at', 'created_at', 'updated_at']) {
    assert.match(MIGRATION, new RegExp('^\\s*' + col + '\\s', 'm'), 'column ' + col);
  }
  assert.match(MIGRATION, /CHECK \(status IN \('queued','running','done','failed','cancelled'\)\)/);
  // source CHECK mirrors CHECK_SOURCES in src/shared/hosting-port-status.mjs.
  assert.match(MIGRATION, /CHECK \(source IN \('cron','manual_bulk','manual_sweep','single_query','bad_rental_remediator'\)\)/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS idx_hpsj_status_created_at\s+ON hosting_port_status_jobs \(status, created_at\)/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS idx_hpsj_updated_at\s+ON hosting_port_status_jobs \(updated_at\)/);
});

// --- wiring: durable job never depends on the browser -----------------------

test('POST /run with async:true enqueues and returns immediately; sync single-batch mode stays', () => {
  assert.match(DASHBOARD_SRC, /if \(body\.async === true && !simIds\) \{/);
  assert.match(DASHBOARD_SRC, /enqueueHostingPortJob\(env, \{ source: 'manual_sweep', maxSims, createdBy: 'dashboard' \}\)/);
  assert.match(DASHBOARD_SRC, /status: job\.ok \? 202 : 500/);
  // Synchronous mode still reachable for sim_ids bulk checks and tests.
  assert.match(DASHBOARD_SRC, /runHostingPortSweep\(env, \{ simIds, source, offset, maxSims \}\)/);
});

test('GET /api/hosting-port-status/jobs/:id polling endpoint exists', () => {
  assert.match(DASHBOARD_SRC, /url\.pathname\.startsWith\('\/api\/hosting-port-status\/jobs\/'\)/);
  assert.match(DASHBOARD_SRC, /handleHostingPortStatusJobGet/);
  assert.match(DASHBOARD_SRC, /getHostingPortJob\(env, jobId\)/);
});

test('scheduled handler drains jobs every tick but full-sweeps only on the 12h cron', () => {
  assert.match(DASHBOARD_TOML, /crons = \["0 \*\/12 \* \* \*", "\* \* \* \* \*"\]/);
  assert.match(DASHBOARD_SRC, /if \(event\.cron === '0 \*\/12 \* \* \*'\) \{/);
  assert.match(DASHBOARD_SRC, /processHostingPortJobs\(env, \{ maxJobs: 1 \}\)/);
  // The drain is NOT gated on the 12h cron: it appears after the closing brace
  // of the cron-only block, so every minute tick advances pending jobs.
  const scheduled = DASHBOARD_SRC.slice(DASHBOARD_SRC.indexOf('async scheduled(event, env, ctx)'));
  const cronBlockEnd = scheduled.indexOf('\n    }');
  assert.ok(scheduled.indexOf('processHostingPortJobs') > cronBlockEnd, 'job drain runs on every tick');
});

test('Workers page polls job status but the job itself runs server-side', () => {
  assert.match(DASHBOARD_HTML, /function pollHostingPortJob\(/);
  assert.match(DASHBOARD_HTML, /\/hosting-port-status\/jobs\/'? \+ jobId/);
  assert.match(DASHBOARD_HTML, /setInterval\(/);
  assert.match(DASHBOARD_HTML, /continues even if you close this page or browser/i, 'UI states the sweep outlives the browser');
});

// --- syntax: dashboard worker + frontend script still parse -----------------
// (Guards the hand-edited worker file and the inline frontend JS — a broken
// escape here historically shipped as "data not loading".)

test('dashboard worker parses as an ES module', () => {
  execFileSync(process.execPath, ['--input-type=module', '--check'], {
    input: DASHBOARD_SRC,
  });
});

test('frontend inline <script> blocks parse as JS', () => {
  const scripts = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'inline script found');
  for (const [, js] of scripts) {
    execFileSync(process.execPath, ['--check'], { input: js });
  }
});
