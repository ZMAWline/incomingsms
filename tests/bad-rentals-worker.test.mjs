// Routing + auth-layer tests for src/bad-rentals/index.js.
// We mock global fetch (used by the worker to call Supabase PostgREST) and
// exercise the worker's `default.fetch` handler directly.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const bundle = '/tmp/bad-rentals.worker.bundle.test.mjs';

execFileSync('npx', ['--yes', 'esbuild',
  'src/bad-rentals/index.js',
  '--bundle', '--format=esm', '--outfile=' + bundle, '--log-level=error',
], { cwd: repo });

const mod = await import(bundle + '?cache=' + Date.now());
const worker = mod.default;

// ---- canned dataset (mirrors resolver test fixtures) ---------------------
const VALID_KEY = 'rsk_test_valid';
const DISABLED_KEY = 'rsk_test_disabled';

function ok(body) { return new Response(JSON.stringify(body), { status: 200 }); }

function makeFetchMock(state) {
  return async function (url, init) {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const p = decodeURIComponent(u.pathname + u.search);
    state.calls.push((init && init.method) || 'GET', p);

    // Auth lookup
    if (p.startsWith('/rest/v1/reseller_api_keys')) {
      if (p.includes('api_key=eq.' + VALID_KEY)) {
        return ok([{ id: 1, reseller_id: 3, enabled: true, resellers: { name: 'Maxime' } }]);
      }
      if (p.includes('api_key=eq.' + DISABLED_KEY)) {
        return ok([{ id: 2, reseller_id: 4, enabled: false, resellers: { name: 'Disabled' } }]);
      }
      return ok([]);
    }
    // Reseller-rental-id lookup
    if (p.startsWith('/rest/v1/rentals?') && p.includes('reseller_rental_id=eq.')) {
      const m = p.match(/reseller_rental_id=eq\.([^&]+)/);
      if (m && m[1] === '1617922') {
        return ok([{ id: 47111, sim_id: 3500, sim_number_id: 60362, e164: '+18126100326', minted_at: '2026-05-29T22:08:59Z' }]);
      }
      return ok([]);
    }
    // Dedup / status check
    if (p.startsWith('/rest/v1/rental_reports?') && (init && init.method !== 'POST')) {
      if (state.openReportExists) {
        return ok([{ id: 9001, status: 'received', received_at: '2026-06-04T00:00:00Z',
                     rental_id: 47111, sim_id: 3500, sim_number_id: 60362, e164: '+18126100326' }]);
      }
      return ok([]);
    }
    // Rate limit log lookups (empty = under limit)
    if (p.startsWith('/rest/v1/reseller_actions_log?')) return ok([]);
    // Insert rental_reports
    if (p === '/rest/v1/rental_reports' && init && init.method === 'POST') {
      return new Response(JSON.stringify([{
        id: 9002, rental_id: 47111, sim_id: 3500, sim_number_id: 60362,
        e164: '+18126100326', status: 'received', received_at: '2026-06-04T00:00:01Z',
      }]), { status: 201 });
    }
    // Append-only event + action log inserts: minimal 201
    if ((p === '/rest/v1/rental_report_events' || p === '/rest/v1/reseller_actions_log' ||
         p === '/rest/v1/rental_report_rejections') && init && init.method === 'POST') {
      return new Response('', { status: 201 });
    }
    return new Response('unhandled: ' + p, { status: 500 });
  };
}

const env = {
  SUPABASE_URL: 'http://supabase.local',
  SUPABASE_SERVICE_ROLE_KEY: 'srv_test',
};

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); failed++; }
}

console.log('bad-rentals worker:');

await test('GET / returns landing HTML', async () => {
  const state = { calls: [] };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/'), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type') || '', /text\/html/);
  const body = await r.text();
  assert.match(body, /Bad Rentals/);
  assert.match(body, /reseller_rental_id/);
});

await test('GET /healthz', async () => {
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/healthz'), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});

await test('POST /api/rentals/report-bad without auth → 401', async () => {
  const state = { calls: [] };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/rentals/report-bad', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reseller_rental_id: '1617922' }),
  }), env);
  assert.equal(r.status, 401);
});

await test('POST with disabled key → 401', async () => {
  const state = { calls: [] };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/rentals/report-bad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DISABLED_KEY },
    body: JSON.stringify({ reseller_rental_id: '1617922' }),
  }), env);
  assert.equal(r.status, 401);
});

await test('POST with sim_id is rejected by resolver → 400', async () => {
  const state = { calls: [] };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/rentals/report-bad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + VALID_KEY },
    body: JSON.stringify({ sim_id: 3500 }),
  }), env);
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /not accepted/);
});

await test('POST with valid reseller_rental_id → 200 insert', async () => {
  const state = { calls: [], openReportExists: false };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/rentals/report-bad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + VALID_KEY },
    body: JSON.stringify({ reseller_rental_id: '1617922', reason_code: 'no_sms_received' }),
  }), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.report_id, 9002);
  assert.equal(j.rental_id, 47111);
});

await test('POST dedup returns existing open report', async () => {
  const state = { calls: [], openReportExists: true };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/rentals/report-bad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + VALID_KEY },
    body: JSON.stringify({ reseller_rental_id: '1617922' }),
  }), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.deduped, true);
  assert.equal(j.report_id, 9001);
});

await test('Unknown route → 404', async () => {
  const state = { calls: [] };
  globalThis.fetch = makeFetchMock(state);
  const r = await worker.fetch(new Request('https://bad-rentals.incoming-sms.com/api/nope', {
    headers: { Authorization: 'Bearer ' + VALID_KEY },
  }), env);
  assert.equal(r.status, 404);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
