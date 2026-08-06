// Dashboard/API visibility for HE1 auto-resolutions (t_ca8dac09).
//
// Auto-resolved bad-rental reports carry their explicit action/reason on the
// remediation ATTEMPT row (rental_reports.remediation_action is
// CHECK-constrained to rotated|port_reset|sim_replaced|mdn_swapped|other), so
// the dashboard has to resolve them through rental_report_remediation_attempts.
// These tests exercise that real code path.
//
// The dashboard worker is ESM inside a CommonJS package and is normally bundled
// by wrangler, so instead of importing the whole module we lift the exact
// bad-rental helpers out of the source and run them in a vm with a stubbed
// fetch. That keeps the assertions on the shipped code, not a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

const OUTCOME = 'healthy_evidence_auto_resolved';
const REASON = 'confirmed_working';

// Slice one top-level function out of the source by brace matching.
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

function extractConst(name) {
  const m = SRC.match(new RegExp('^const\\s+' + name + '\\s*=.*$', 'm'));
  assert.ok(m, 'const not found in dashboard source: ' + name);
  return m[0];
}

// Build a sandbox holding the real helpers plus a scripted fetch.
function makeSandbox(routes) {
  const calls = [];
  const sandbox = {
    console,
    Response,
    URL,
    async fetch(url, init) {
      const u = String(url);
      calls.push(u);
      for (const [pattern, handler] of routes) {
        if (u.includes(pattern)) return handler(u, init);
      }
      return new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractConst('HEALTHY_EVIDENCE_OUTCOME'),
    extractConst('HEALTHY_EVIDENCE_REASON'),
    extractConst('HEALTHY_EVIDENCE_ACTION'),
    extractConst('MAX_REPORT_ID_FILTER'),
    extractFn('function chunkIds(ids, size = MAX_REPORT_ID_FILTER) {'),
    extractFn('async function supabaseGet(env, path) {'),
    extractFn('async function fetchAutoResolvedReportIds(env, outcome) {'),
    extractFn('async function handleHealthyEvidenceSummary(env, corsHeaders, url) {'),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  // `const` declarations evaluated in a vm context are lexical bindings, not
  // properties on the sandbox object. Expose the cap explicitly for tests that
  // assert request chunk sizes.
  Object.defineProperty(sandbox, 'MAX_REPORT_ID_FILTER', {
    value: vm.runInContext('MAX_REPORT_ID_FILTER', sandbox),
    enumerable: true,
    configurable: true,
  });
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------
// Filtering
// ---------------------------------------------------------

test('API resolves healthy_evidence_auto_resolved report ids from the attempts table', async () => {
  const { sandbox, calls } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse([
      { report_id: 6817 }, { report_id: 6818 }, { report_id: 6817 },
    ])],
  ]);

  // Array.from: the helper runs inside the vm realm, so its arrays carry the
  // sandbox's Array prototype and would fail a strict deep-equal on identity.
  const ids = Array.from(await sandbox.fetchAutoResolvedReportIds(ENV, OUTCOME));

  assert.deepEqual(ids.sort(), [6817, 6818], 'ids are de-duplicated');
  assert.ok(calls[0].includes('outcome=eq.' + OUTCOME), 'filters on the auto-resolution outcome');
});

test('an unknown auto_resolution value matches nothing instead of widening the list', async () => {
  const { sandbox, calls } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse([{ report_id: 1 }])],
  ]);

  assert.deepEqual(Array.from(await sandbox.fetchAutoResolvedReportIds(ENV, 'confirmed_working')), []);
  assert.deepEqual(Array.from(await sandbox.fetchAutoResolvedReportIds(ENV, '')), []);
  assert.equal(calls.length, 0, 'no query is issued for an unsupported value');
});

test('the id filter stays inside one URL when many reports have been auto-resolved', async () => {
  // `id=in.(...)` is spliced into a GET URL; an unbounded list of thousands of
  // ids builds a request line long enough to 414 instead of returning rows.
  const many = Array.from({ length: 1200 }, (_, i) => ({ report_id: 10000 + i }));
  const { sandbox } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse(many)],
  ]);

  const ids = Array.from(await sandbox.fetchAutoResolvedReportIds(ENV, OUTCOME));
  assert.equal(ids.length, sandbox.MAX_REPORT_ID_FILTER);
  assert.equal(ids[0], 10000, 'keeps the most recently auto-resolved reports');
});

test('summary endpoint chunks its report lookup instead of dropping reports', async () => {
  const attempts = Array.from({ length: 1200 }, (_, i) => ({
    report_id: 10000 + i, action: 'healthy_evidence_auto_resolve',
    outcome: OUTCOME, mode: 'HE1', attempted_at: '2026-08-06T14:00:00.000Z',
  }));
  const lookups = [];
  const { sandbox } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse(attempts)],
    ['/rental_reports?select=', (u) => {
      const ids = decodeURIComponent(u.match(/id=in\.\(([^)]*)\)/)[1]).split(',');
      lookups.push(ids.length);
      return jsonResponse(ids.map(id => ({
        id: Number(id), status: 'remediated', sims: { vendor: 'atomic', gateway_host: 'teltik' },
      })));
    }],
  ]);

  const resp = await sandbox.handleHealthyEvidenceSummary(
    ENV, {}, new URL('https://d/api/bad-rentals/healthy-evidence-summary?days=30'));
  const body = await resp.json();

  assert.equal(body.total, 1200);
  assert.equal(body.reports.length, 1200, 'every auto-resolved report is counted, none truncated');
  assert.equal(body.by_vendor.atomic, 1200);
  assert.ok(lookups.length > 1, 'the id filter is split across several requests');
  assert.ok(lookups.every(n => n <= sandbox.MAX_REPORT_ID_FILTER));
});

test('a failed attempts query yields no ids rather than an unfiltered report list', async () => {
  const { sandbox } = makeSandbox([
    ['/rental_report_remediation_attempts', () => new Response('boom', { status: 500 })],
  ]);
  assert.deepEqual(Array.from(await sandbox.fetchAutoResolvedReportIds(ENV, OUTCOME)), []);
});

test('handleBadRentals wires the auto_resolution filter and exposes the resolution per row', () => {
  // Filter plumbing.
  assert.match(SRC, /const autoResolution = \(url\.searchParams\.get\('auto_resolution'\) \|\| ''\)\.trim\(\);/);
  assert.match(SRC, /autoResolutionIds = await fetchAutoResolvedReportIds\(env, autoResolution\);/);
  assert.match(SRC, /query \+= '&id=in\.\(' \+ encodeURIComponent\(autoResolutionIds\.join\(','\)\) \+ '\)';/);
  // Auto-resolved reports are status='remediated', so ?auto_resolution without
  // an explicit ?status must not fall back to the open-only default filter.
  assert.match(SRC, /const includeAll = statusParam === 'all' \|\| \(!statusParam && !!autoResolution\);/);
  // Per-row exposure.
  assert.match(SRC, /auto_resolution: s \? s\.auto_resolution : null,/);
  assert.match(SRC, /auto_resolution_reason: \(s && s\.auto_resolution === HEALTHY_EVIDENCE_OUTCOME\)/);
  assert.match(SRC, /auto_resolved_at: s \? s\.auto_resolved_at : null,/);
  assert.match(SRC, /if \(a\.outcome === HEALTHY_EVIDENCE_OUTCOME && !attemptSummary\[k\]\.auto_resolution\)/);
});

// ---------------------------------------------------------
// Summary endpoint
// ---------------------------------------------------------

test('summary endpoint rolls up auto-resolved reports by vendor, host and status', async () => {
  const resolvedAt = '2026-08-06T14:00:00.000Z';
  const { sandbox } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse([
      { report_id: 6817, action: 'healthy_evidence_auto_resolve', outcome: OUTCOME, mode: 'HE1', attempted_at: resolvedAt },
      { report_id: 6818, action: 'healthy_evidence_auto_resolve', outcome: OUTCOME, mode: 'HE1', attempted_at: resolvedAt },
    ])],
    ['/rental_reports?select=', () => jsonResponse([
      {
        id: 6817, status: 'remediated', sim_id: 'sim-1', rental_id: 'r-1',
        received_at: '2026-08-06T13:00:00.000Z', closed_at: resolvedAt,
        auto_remediation_state: 'done', remediation_action: 'other',
        rentals: { reseller_rental_id: 'rr-1' },
        sims: { vendor: 'atomic', gateway_host: 'teltik' },
      },
      {
        id: 6818, status: 'remediated', sim_id: 'sim-2', rental_id: 'r-2',
        received_at: '2026-08-06T12:00:00.000Z', closed_at: resolvedAt,
        auto_remediation_state: 'done', remediation_action: 'other',
        rentals: { reseller_rental_id: 'rr-2' },
        sims: { vendor: 'teltik', gateway_host: 'teltik' },
      },
    ])],
  ]);

  const resp = await sandbox.handleHealthyEvidenceSummary(ENV, {}, new URL('https://d/api/bad-rentals/healthy-evidence-summary?days=7'));
  const body = await resp.json();

  assert.equal(resp.status, 200);
  assert.equal(body.resolution, OUTCOME);
  assert.equal(body.reason, REASON);
  assert.equal(body.window_days, 7);
  assert.equal(body.total, 2);
  // Provider (service) and host are summarized separately — an Atomic line
  // hosted on Teltik counts under atomic AND under the teltik host.
  assert.deepEqual(body.by_vendor, { atomic: 1, teltik: 1 });
  assert.deepEqual(body.by_gateway_host, { teltik: 2 });
  assert.deepEqual(body.by_status, { remediated: 2 });

  const one = body.reports.find(r => r.report_id === 6817);
  assert.equal(one.auto_resolution, OUTCOME);
  assert.equal(one.auto_resolution_reason, REASON);
  assert.equal(one.resolved_at, resolvedAt);
  assert.equal(one.vendor, 'atomic');
  assert.equal(one.gateway_host, 'teltik');
  assert.equal(one.reseller_rental_id, 'rr-1');

  // Operator rollup must not leak customer numbers.
  assert.ok(!/\+1\d{10}/.test(JSON.stringify(body)));
});

test('summary endpoint returns an empty rollup when nothing was auto-resolved', async () => {
  const { sandbox, calls } = makeSandbox([
    ['/rental_report_remediation_attempts', () => jsonResponse([])],
  ]);

  const resp = await sandbox.handleHealthyEvidenceSummary(ENV, {}, new URL('https://d/api/bad-rentals/healthy-evidence-summary'));
  const body = await resp.json();

  assert.equal(body.total, 0);
  assert.deepEqual(body.reports, []);
  assert.equal(body.window_days, 7, 'defaults to a 7 day window');
  assert.equal(calls.length, 1, 'no report lookup when there are no auto-resolutions');
});

test('summary endpoint surfaces upstream failures instead of reporting zero', async () => {
  const { sandbox } = makeSandbox([
    ['/rental_report_remediation_attempts', () => new Response('nope', { status: 500 })],
  ]);
  const resp = await sandbox.handleHealthyEvidenceSummary(ENV, {}, new URL('https://d/api/bad-rentals/healthy-evidence-summary'));
  assert.equal(resp.status, 502);
  const body = await resp.json();
  assert.equal(body.error, 'supabase_500');
});

test('summary route is registered on the dashboard worker', () => {
  assert.match(SRC, /url\.pathname === '\/api\/bad-rentals\/healthy-evidence-summary' && request\.method === 'GET'/);
  assert.match(SRC, /return handleHealthyEvidenceSummary\(env, corsHeaders, url\);/);
});
