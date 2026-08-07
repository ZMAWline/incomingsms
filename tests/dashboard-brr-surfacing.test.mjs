// BRR dashboard surfacing (t_f479e342) — issue classification, escalation
// pipeline, manual next steps, inbox linkage.
//
// Same vm-lift-and-run pattern as dashboard-escalation-export.test.mjs: the
// dashboard worker is ESM bundled by wrangler, so real functions are sliced
// out of the source and executed in a vm with a scripted fetch. Assertions
// run against the shipped code, not a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');
const CLASSIFIER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'classifier.mjs'), 'utf8');

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

// The whole BRR classification/next-step/escalation-pipeline region: the
// BRR_SITUATION_LABELS table through the end of the backlog handler.
function extractBrrRegion() {
  const start = SRC.indexOf('const BRR_SITUATION_LABELS = {');
  assert.notEqual(start, -1, 'BRR_SITUATION_LABELS not found');
  const handler = extractFn('async function handleBadRentalEscalationsBacklog(env, corsHeaders) {');
  const end = SRC.indexOf(handler) + handler.length;
  assert.ok(end > start, 'backlog handler must live inside the BRR region');
  return SRC.slice(start, end);
}

function extractHealthyEvidenceConsts() {
  const start = SRC.indexOf('const HEALTHY_EVIDENCE_OUTCOME');
  assert.notEqual(start, -1, 'HEALTHY_EVIDENCE_OUTCOME not found');
  const end = SRC.indexOf('const HEALTHY_EVIDENCE_ACTION');
  const lineEnd = SRC.indexOf('\n', end);
  return SRC.slice(start, lineEnd);
}

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
    extractFn('async function supabaseGet(env, path) {'),
    extractFn('function issueTypeForBadRentalRow(r) {'),
    extractHealthyEvidenceConsts(),
    extractBrrRegion(),
    extractFn('async function callRemediator(env, path, init) {'),
    extractFn('function remediatorSecret(env) {'),
    extractFn('async function handleBadRentals(env, corsHeaders, url) {'),
    extractFn('async function handleBadRentalReport(id, env, corsHeaders) {'),
    extractFn('function enrichPendingItemRow(row) {'),
    extractFn('async function handlePendingItemsList(request, env, corsHeaders) {'),
    // Top-level `const` bindings inside a vm-executed script are not exposed
    // as properties of the context object (only `var`/function declarations
    // are) — so functions that close over BRR_SITUATION_LABELS work fine via
    // sandbox.brrIssueLabel(...), but the table itself needs an explicit
    // re-export for tests that read it directly.
    'globalThis.BRR_SITUATION_LABELS = BRR_SITUATION_LABELS;',
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function badRentalsUrl(qs) {
  return new URL('https://dashboard/api/bad-rentals' + (qs || ''));
}

// ---------------------------------------------------------
// 1. BRR_SITUATION_LABELS covers every classifier situation id.
// ---------------------------------------------------------

test('BRR_SITUATION_LABELS has a label for every situation id emitted by classifier.mjs', () => {
  const { sandbox } = makeSandbox([]);
  const ids = new Set();
  const re = /id:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(CLASSIFIER_SRC))) ids.add(m[1]);
  assert.ok(ids.size > 0, 'sanity: classifier.mjs must declare at least one situation id');
  const missing = [...ids].filter(id => !(id in sandbox.BRR_SITUATION_LABELS));
  assert.deepEqual(missing, [], 'BRR_SITUATION_LABELS is missing labels for: ' + missing.join(', '));
});

// ---------------------------------------------------------
// 2. brrManualNextStep guidance scenarios.
// ---------------------------------------------------------

test('escalated + teltik_gateway_port_offline tells the reviewer to seat the line or replace the SIM', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'in_triage', auto_remediation_state: 'escalated', escalation_reason: 'teltik_gateway_port_offline' },
    [], null);
  assert.ok(steps.length >= 1);
  assert.match(steps[0].action, /Seat the line/);
  assert.match(steps[0].detail, /gateway_id:0\/port:null/);
});

test('escalated + legacy paperclip error points at draining the backlog', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'in_triage', auto_remediation_state: 'escalated', escalation_reason: 'paperclip_credentials_missing' },
    [], null);
  assert.ok(steps.length >= 1);
  assert.match(steps[0].action, /Drain the legacy escalation backlog/);
  assert.match(steps[0].detail, /escalations\/drain/);
});

test('queued with no attempts yet needs no reviewer action', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'received', auto_remediation_state: 'queued', escalation_reason: null },
    [], null);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'No action needed yet');
});

test('operator_locked tells the reviewer to work it manually or resume auto', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'in_triage', auto_remediation_state: 'operator_locked', escalation_reason: null },
    [], null);
  assert.ok(steps.length >= 1);
  assert.match(steps[0].action, /Resume auto or continue manual remediation/);
});

test('remediated reports have nothing left to do', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'remediated', auto_remediation_state: 'done', escalation_reason: null },
    [{ mode: 'T1', outcome: 'success' }], null);
  // steps is an array from the vm's own realm — compare length/contents,
  // not deepEqual([]), which fails cross-realm on reference identity.
  assert.equal(steps.length, 0);
});

test('a TH2 no_change loop tells the reviewer to take over if it repeats for hours', () => {
  const { sandbox } = makeSandbox([]);
  const steps = sandbox.brrManualNextStep(
    { status: 'in_triage', auto_remediation_state: 'queued', escalation_reason: null },
    [{ mode: 'TH2', outcome: 'no_change' }], null);
  const modeStep = steps.find(s => /Take over if this repeats for hours/.test(s.action));
  assert.ok(modeStep, 'expected a TH2-specific step, got: ' + JSON.stringify(steps));
  assert.match(modeStep.detail, /Teltik host port read/);
});

// ---------------------------------------------------------
// 3. handleBadRentals list rows carry issue_label/escalation_label/manual_next_step.
// ---------------------------------------------------------

function simRow({ id, iccid, vendor, gateway_host, e164 }) {
  return { id, iccid, vendor, gateway_host, sim_numbers: [{ e164, valid_to: null }] };
}

test('handleBadRentals list rows include issue_label, escalation_label and manual_next_step', async () => {
  const reports = [{
    id: 5001, reseller_id: 1, e164: '+13105551234', reason_code: 'no_sms_received', reason_note: null,
    status: 'in_triage', sim_id: 55, sim_number_id: 1, rental_id: 10,
    remediation_action: null, duplicate_of: null,
    received_at: '2026-08-06T00:00:00.000Z', triaged_at: null, closed_at: null, updated_at: '2026-08-06T00:00:00.000Z',
    auto_remediation_state: 'escalated', last_auto_attempt_at: '2026-08-06T00:05:00.000Z',
    escalation_reason: 'teltik_gateway_port_offline',
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-5001' },
    sims: simRow({ id: 55, iccid: 'icc-5001', vendor: 'teltik', gateway_host: 'teltik', e164: '+13105551234' }),
    report_sim_number: null,
  }];
  const attempts = [
    { report_id: 5001, action: 'teltik_reset_port', outcome: 'escalate', attempted_at: '2026-08-06T00:05:00.000Z', attempt_no: 3, mode: 'TH5' },
  ];
  const { sandbox } = makeSandbox([
    ['/rental_reports?select=', () => jsonResponse(reports)],
    ['/rental_report_remediation_attempts', () => jsonResponse(attempts)],
  ]);
  const resp = await sandbox.handleBadRentals(ENV, {}, badRentalsUrl(''));
  assert.equal(resp.status, 200);
  const rows = await resp.json();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.issue_label, sandbox.BRR_SITUATION_LABELS.TH5);
  assert.equal(row.escalation_label, sandbox.BRR_SITUATION_LABELS.teltik_gateway_port_offline);
  assert.ok(row.manual_next_step, 'manual_next_step must be populated for an escalated report');
  assert.match(row.manual_next_step, /Seat the line/);
  // Every pre-existing field the frontend relies on stays intact.
  assert.equal(row.id, 5001);
  assert.equal(row.vendor, 'teltik');
  assert.equal(row.gateway_host, 'teltik');
  assert.equal(row.auto_attempts_count, 1);
  assert.equal(row.auto_attempts_last_mode, 'TH5');
});

// ---------------------------------------------------------
// 4. handleBadRentalReport includes escalation_pipeline and queries the right filter.
// ---------------------------------------------------------

test('handleBadRentalReport includes escalation_pipeline queried by report_ids=cs.{id}', async () => {
  const report = {
    id: 6002, reseller_id: 1, rental_id: 1, sim_id: 1, sim_number_id: 1, e164: '+13105551234',
    reason_code: 'no_sms_received', reason_note: null, attempts: 1, first_attempt_at: null, client_request_id: null,
    status: 'in_triage', remediation_action: null, duplicate_of: null,
    received_at: '2026-08-06T00:00:00.000Z', triaged_at: null, closed_at: null, updated_at: '2026-08-06T00:00:00.000Z',
    raw_payload: null, source: 'webhook',
    auto_remediation_state: 'escalated', last_auto_attempt_at: null, escalation_reason: 'teltik_gateway_port_offline',
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-6002' },
  };
  const escalationRows = [
    { id: 900, status: 'delivery_failed', last_error: 'paperclip 500', failure_type: 'teltik_gateway_port_offline', vendor: 'teltik', created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-05T00:00:00.000Z', paperclip_issue_id: null },
  ];
  const { sandbox, calls } = makeSandbox([
    ['/rental_reports?id=eq.', () => jsonResponse([report])],
    ['/rental_report_events?report_id=eq.', () => jsonResponse([])],
    ['/rental_report_remediation_attempts?report_id=eq.', () => jsonResponse([])],
    ['/operator_escalations?report_ids=cs.', () => jsonResponse(escalationRows)],
  ]);
  const resp = await sandbox.handleBadRentalReport('6002', ENV, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.escalation_pipeline.total, 1);
  assert.deepEqual(body.escalation_pipeline.rows, escalationRows);
  assert.equal(body.issue_label, sandbox.BRR_SITUATION_LABELS.teltik_gateway_port_offline);
  assert.equal(body.escalation_label, sandbox.BRR_SITUATION_LABELS.teltik_gateway_port_offline);
  assert.ok(Array.isArray(body.manual_next_steps) && body.manual_next_steps.length > 0);

  const pipelineCall = decodeURIComponent(calls.find(c => c.includes('/operator_escalations?report_ids=cs.')));
  assert.ok(pipelineCall.includes('report_ids=cs.{6002}'), pipelineCall);

  // Pre-existing fields stay intact.
  assert.equal(body.report.id, 6002);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.attempts, []);
  assert.ok('storage_note' in body);
});

// ---------------------------------------------------------
// 5. /api/bad-rentals/escalations backlog endpoint.
// ---------------------------------------------------------

test('handleBadRentalEscalationsBacklog proxies the remediator backlog when the binding is present', async () => {
  const { sandbox } = makeSandbox([]);
  const backlog = { total: 323, by_status: { queued: 323 }, legacy_paperclip_rows: 323, oldest_created_at: '2026-01-01T00:00:00.000Z', alert: true, sink: 'paperclip', remedy: 'run /escalations/drain' };
  const env = {
    ...ENV,
    BAD_RENTAL_REMEDIATOR: { fetch: async () => new Response(JSON.stringify({ backlog }), { status: 200 }) },
  };
  const resp = await sandbox.handleBadRentalEscalationsBacklog(env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.backlog, backlog);
});

test('handleBadRentalEscalationsBacklog tolerates a missing service binding', async () => {
  const { sandbox } = makeSandbox([]);
  const resp = await sandbox.handleBadRentalEscalationsBacklog(ENV, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unavailable');
});

test('the /api/bad-rentals/escalations route is registered ahead of the auth gate like its siblings', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/bad-rentals/escalations' && request.method === 'GET'");
  assert.notEqual(routeIdx, -1, 'route not registered');
  assert.match(SRC, /return handleBadRentalEscalationsBacklog\(env, corsHeaders\);/);
});

// ---------------------------------------------------------
// 6. pending-items enrichment for bad_rental_escalation rows.
// ---------------------------------------------------------

test('bad_rental_escalation rows are enriched with brr.report_id/vendor/situation parsed from details_md', () => {
  const { sandbox } = makeSandbox([]);
  const row = {
    id: 1, kind: 'bad_rental_escalation', status: 'open', created_at: '2026-08-06T00:00:00.000Z',
    summary: 'teltik / teltik_gateway_port_offline: 1 rental needs operator',
    details_md: '### Report 9001\n- vendor: `teltik`\n- situation: `T5`\n',
  };
  const enriched = sandbox.enrichPendingItemRow(row);
  assert.equal(enriched.brr.report_id, 9001);
  assert.equal(enriched.brr.vendor, 'teltik');
  assert.equal(enriched.brr.situation_id, 'T5');
  assert.equal(enriched.brr.issue_label, sandbox.BRR_SITUATION_LABELS.T5);
  // Original fields untouched.
  assert.equal(enriched.id, 1);
  assert.equal(enriched.summary, row.summary);
});

test('non-bad-rental kinds pass through enrichPendingItemRow unchanged', () => {
  const { sandbox } = makeSandbox([]);
  const row = { id: 2, kind: 'operator_question', status: 'open', summary: 'hi', details_md: '### Report 1234' };
  const enriched = sandbox.enrichPendingItemRow(row);
  assert.equal(enriched, row);
  assert.ok(!('brr' in enriched));
});

test('handlePendingItemsList enriches bad_rental_escalation rows end to end', async () => {
  const rows = [
    { id: 1, kind: 'bad_rental_escalation', status: 'open', created_at: '2026-08-06T00:00:00.000Z',
      summary: 'teltik escalation', details_md: '### Report 9001\n- vendor: `teltik`\n- situation: `T5`\n' },
    { id: 2, kind: 'operator_question', status: 'open', created_at: '2026-08-06T00:00:00.000Z', summary: 'q', details_md: null },
  ];
  const { sandbox } = makeSandbox([
    ['/pending_review_items?select=', () => jsonResponse(rows)],
  ]);
  const req = { url: 'https://dashboard/api/pending-items?status=open&limit=200' };
  const resp = await sandbox.handlePendingItemsList(req, ENV, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.rows.length, 2);
  const brrRow = body.rows.find(r => r.kind === 'bad_rental_escalation');
  const otherRow = body.rows.find(r => r.kind === 'operator_question');
  assert.equal(brrRow.brr.report_id, 9001);
  assert.ok(!('brr' in otherRow));
});

// ---------------------------------------------------------
// 7. Frontend markers.
// ---------------------------------------------------------

test('the report modal renders Reviewer next steps and Escalation pipeline blocks', () => {
  assert.match(HTML, /Reviewer next steps/);
  assert.match(HTML, /Escalation pipeline/);
  assert.match(HTML, /Issue classification/);
  assert.match(HTML, /data\.manual_next_steps/);
  assert.match(HTML, /data\.escalation_pipeline/);
});

test('the inbox render branches on kind === bad_rental_escalation', () => {
  assert.match(HTML, /it\.kind === 'bad_rental_escalation'/);
  assert.match(HTML, /Bad rental escalation/);
  assert.match(HTML, /openBadRentalReport\(\$\{escapeAttr\(String\(it\.brr\.report_id\)\)\}\)/);
});

test('the bad rentals tab header has an escalations backlog status line', () => {
  assert.match(HTML, /id="bad-rentals-escalations-backlog"/);
  assert.match(HTML, /function loadBadRentalEscalationsBacklog\(\)/);
  assert.match(HTML, /queued escalation/);
  assert.match(HTML, /loadBadRentalEscalationsBacklog\(\);/);
});

test('attempts table evidence renders as an expandable details block', () => {
  assert.match(HTML, /<summary class="cursor-pointer text-\[10px\] text-dark-400 hover:text-dark-200">Evidence<\/summary>/);
});
