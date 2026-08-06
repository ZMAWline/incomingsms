// Bad Rental Review — daily escalation export (t_732f6de4).
//
// The export answers "which SIMs need escalating today, and to whom", split by
// SERVICE PROVIDER (sims.vendor) and GATEWAY HOST (sims.gateway_host). Those two
// axes must never collapse: an Atomic/AT&T line seated in a Teltik gateway
// escalates to Atomic for the provider claim and Teltik for the host claim, and
// must never be reported as a Teltik-provider line.
//
// The dashboard worker is ESM inside a CommonJS package and is normally bundled
// by wrangler, so — as in dashboard-healthy-evidence-api.test.mjs — we lift the
// real export functions out of the source and run them in a vm with a scripted
// fetch. The assertions run against the shipped code, not a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');

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

// The whole escalation-export region: constants, NY date maths, the cohort
// classifier, the CSV shape, the evidence fetchers and the handler.
function extractEscalationRegion() {
  const start = SRC.indexOf('const ESCALATION_EXPORT_TZ =');
  assert.notEqual(start, -1, 'escalation export region not found');
  const handler = extractFn('async function handleBadRentalEscalationExport(env, corsHeaders, url) {');
  const end = SRC.indexOf(handler) + handler.length;
  assert.ok(end > start, 'handler must live inside the escalation export region');
  return SRC.slice(start, end);
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
    extractFn('function csvEscape(value) {'),
    extractFn('async function handleTeltikPortOfflineExport(env, corsHeaders, url) {'),
    extractEscalationRegion(),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function parseCsv(text) {
  // Fixture data has no embedded commas/quotes in the fields we assert on, but
  // the recommended_action prose does — parse properly so column indexes hold.
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvObjects(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------
// Fixture: one NY day (2026-08-05) with four SIMs, one per cohort.
// ---------------------------------------------------------

function simRow({ id, iccid, vendor, gateway_host, e164 }) {
  return { id, iccid, msisdn: e164, vendor, gateway_host, sim_numbers: [{ e164, valid_to: null }] };
}

const REPORTS = [
  // Atomic PROVIDER line seated in a TELTIK gateway — zero inbound, host offline.
  {
    id: 7664, status: 'in_triage', reason_code: 'no_sms_received',
    received_at: '2026-08-05T08:47:00.000Z', sim_id: 640, rental_id: 'r-640',
    escalation_reason: null, auto_remediation_state: 'escalated', last_auto_attempt_at: '2026-08-05T09:00:00.000Z',
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-640' },
    sims: simRow({ id: 640, iccid: '89014103211118431688459', vendor: 'atomic', gateway_host: 'teltik', e164: '+13105552678' }),
  },
  {
    id: 7665, status: 'in_triage', reason_code: 'no_sms_received',
    received_at: '2026-08-05T18:12:00.000Z', sim_id: 640, rental_id: 'r-640b',
    escalation_reason: 'teltik_gateway_port_offline', auto_remediation_state: 'escalated', last_auto_attempt_at: null,
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-640b' },
    sims: simRow({ id: 640, iccid: '89014103211118431688459', vendor: 'atomic', gateway_host: 'teltik', e164: '+13105552678' }),
  },
  // Atomic provider / Teltik host — zero inbound, host port-status HTTP 400.
  {
    id: 7700, status: 'received', reason_code: 'no_sms_received',
    received_at: '2026-08-05T10:00:00.000Z', sim_id: 700, rental_id: 'r-700',
    escalation_reason: null, auto_remediation_state: null, last_auto_attempt_at: null,
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-700' },
    sims: simRow({ id: 700, iccid: '89014103211118431688483', vendor: 'atomic', gateway_host: 'teltik', e164: '+13105551086' }),
  },
  // TELTIK-PROVIDER line (vendor=teltik) on a Teltik host — line proven good,
  // host port offline now. Must stay separate from the Atomic rows above.
  {
    id: 7800, status: 'in_triage', reason_code: 'no_sms_received',
    received_at: '2026-08-05T12:30:00.000Z', sim_id: 800, rental_id: 'r-800',
    escalation_reason: 'teltik_reset_failed', auto_remediation_state: 'escalated', last_auto_attempt_at: null,
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-800' },
    sims: simRow({ id: 800, iccid: '89014103211118431699001', vendor: 'teltik', gateway_host: 'teltik', e164: '+13105559911' }),
  },
  // Healthy noise: provider active, host online, traffic flowing.
  {
    id: 7900, status: 'in_triage', reason_code: 'no_sms_received',
    received_at: '2026-08-05T13:00:00.000Z', sim_id: 900, rental_id: 'r-900',
    escalation_reason: null, auto_remediation_state: 'done', last_auto_attempt_at: null,
    resellers: { name: 'TrustOTP' }, rentals: { reseller_rental_id: 'rr-900' },
    sims: simRow({ id: 900, iccid: '89014103211118431699222', vendor: 'atomic', gateway_host: 'teltik', e164: '+13105557777' }),
  },
];

const HOST_CHECKS = [
  { sim_id: 640, state: 'offline', http_status: 200, error: null, mdn: '3105555324', mdn_source: 'teltik_get_phone_number_retry', checked_at: '2026-08-05T20:00:00.000Z', gateway_host: 'teltik', vendor: 'atomic' },
  { sim_id: 700, state: 'error', http_status: 400, error: 'Teltik port-status HTTP 400', mdn: '3105551086', mdn_source: 'teltik_inbound_sms_payload_mdn', checked_at: '2026-08-05T20:05:00.000Z', gateway_host: 'teltik', vendor: 'atomic' },
  { sim_id: 800, state: 'offline', http_status: 200, error: null, mdn: '3105559911', mdn_source: 'teltik_inbound_sms_payload_mdn', checked_at: '2026-08-05T20:10:00.000Z', gateway_host: 'teltik', vendor: 'teltik' },
  { sim_id: 900, state: 'online', http_status: 200, error: null, mdn: '3105557777', mdn_source: 'teltik_inbound_sms_payload_mdn', checked_at: '2026-08-05T20:15:00.000Z', gateway_host: 'teltik', vendor: 'atomic' },
];

const ATTEMPTS = [
  { report_id: 7800, action: 'teltik_reset_port', outcome: 'no_change', mode: 'TH5', attempted_at: '2026-08-05T13:00:00.000Z' },
  { report_id: 7664, action: 'classify_only', outcome: 'escalate', mode: 'TH2', attempted_at: '2026-08-05T09:00:00.000Z' },
];

// In-window inbound SMS: only the proven-good line (800) and the healthy one (900).
const INBOUND_IN_WINDOW = [
  { sim_id: 800, received_at: '2026-08-05T11:00:00.000Z' },
  { sim_id: 800, received_at: '2026-08-05T11:30:00.000Z' },
  { sim_id: 900, received_at: '2026-08-05T12:00:00.000Z' },
];

// Lifetime probe: 640 and 700 have never carried an inbound SMS.
const EVER = { 640: [], 700: [] };

function fixtureRoutes({ reports = REPORTS } = {}) {
  return [
    ['/rental_reports?select=', () => jsonResponse(reports)],
    ['/rental_report_remediation_attempts', () => jsonResponse(ATTEMPTS)],
    ['/hosting_port_status_checks', () => jsonResponse(HOST_CHECKS)],
    ['/inbound_sms?sim_id=eq.', (u) => {
      const m = /sim_id=eq\.(\d+)/.exec(u);
      return jsonResponse((m && EVER[m[1]]) || [{ id: 1 }]);
    }],
    ['/inbound_sms?sim_id=in.', (u) => {
      // Second page of any chunk is always empty — the handler stops there.
      if (/offset=(?!0\b)\d+/.test(u)) return jsonResponse([]);
      return jsonResponse(INBOUND_IN_WINDOW);
    }],
  ];
}

function exportUrl(qs) {
  return new URL('https://dashboard/api/bad-rentals/escalation-export' + (qs || ''));
}

// ---------------------------------------------------------
// Route registration
// ---------------------------------------------------------

test('escalation export route is registered and the old export stays as an alias', () => {
  assert.match(SRC, /url\.pathname === '\/api\/bad-rentals\/escalation-export' && request\.method === 'GET'/);
  assert.match(SRC, /return handleBadRentalEscalationExport\(env, corsHeaders, url\);/);
  // Old endpoint still routed — bookmarked links must not 404.
  assert.match(SRC, /url\.pathname === '\/api\/bad-rentals\/teltik-port-offline-export' && request\.method === 'GET'/);
  assert.match(SRC, /return handleTeltikPortOfflineExport\(env, corsHeaders, url\);/);
});

// ---------------------------------------------------------
// NY date range → UTC instants
// ---------------------------------------------------------

test('no date parameters means "needs escalation today" in New York', () => {
  const { sandbox } = makeSandbox([]);
  // 2026-08-06T01:30Z is still 2026-08-05 in New York (EDT). The range must
  // follow the NY day, not the UTC one.
  const range = sandbox.parseEscalationExportRange(exportUrl(''), Date.parse('2026-08-06T01:30:00Z'));
  assert.equal(range.error, undefined);
  assert.equal(range.start, '2026-08-05');
  assert.equal(range.end, '2026-08-05');
  assert.equal(range.is_today, true);
  assert.equal(range.start_utc, '2026-08-05T04:00:00.000Z');
  assert.equal(range.end_utc, '2026-08-06T04:00:00.000Z');
});

test('NY day boundaries follow DST (EST -5 in January, EDT -4 in August)', () => {
  const { sandbox } = makeSandbox([]);
  const winter = sandbox.parseEscalationExportRange(exportUrl('?start=2026-01-15&end=2026-01-15'), Date.now());
  assert.equal(winter.start_utc, '2026-01-15T05:00:00.000Z');
  assert.equal(winter.end_utc, '2026-01-16T05:00:00.000Z');

  const summer = sandbox.parseEscalationExportRange(exportUrl('?start=2026-08-05&end=2026-08-05'), Date.now());
  assert.equal(summer.start_utc, '2026-08-05T04:00:00.000Z');
  assert.equal(summer.end_utc, '2026-08-06T04:00:00.000Z');

  // A range spanning the spring-forward transition is still whole NY days.
  const across = sandbox.parseEscalationExportRange(exportUrl('?start=2026-03-07&end=2026-03-09'), Date.now());
  assert.equal(across.start_utc, '2026-03-07T05:00:00.000Z');
  assert.equal(across.end_utc, '2026-03-10T04:00:00.000Z');
});

test('?days=N walks back N New York days ending today', () => {
  const { sandbox } = makeSandbox([]);
  const range = sandbox.parseEscalationExportRange(exportUrl('?days=5'), Date.parse('2026-08-05T18:00:00Z'));
  assert.equal(range.start, '2026-08-01');
  assert.equal(range.end, '2026-08-05');
  assert.equal(range.days, 5);
});

test('bad ranges are refused with a plain-English message, not a silent empty CSV', () => {
  const { sandbox } = makeSandbox([]);
  const now = Date.parse('2026-08-05T18:00:00Z');
  assert.equal(sandbox.parseEscalationExportRange(exportUrl('?start=05/08/2026'), now).error, 'invalid_start');
  assert.match(sandbox.parseEscalationExportRange(exportUrl('?start=05/08/2026'), now).message, /YYYY-MM-DD/);
  assert.equal(sandbox.parseEscalationExportRange(exportUrl('?start=2026-08-05&end=2026-08-01'), now).error, 'end_before_start');
  assert.equal(sandbox.parseEscalationExportRange(exportUrl('?start=2020-01-01&end=2026-08-05'), now).error, 'range_too_large');
  assert.equal(sandbox.parseEscalationExportRange(exportUrl('?tz=Mars/Olympus'), now).error, 'invalid_tz');
});

test('an invalid range returns HTTP 400 with a readable message', async () => {
  const { sandbox, calls } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-01'));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'end_before_start');
  assert.match(body.message, /before start date/);
  assert.equal(calls.length, 0, 'no query is issued for an invalid range');
});

// ---------------------------------------------------------
// Query determinism
// ---------------------------------------------------------

test('the report query filters on the NY range converted to UTC, not on page state', async () => {
  const { sandbox, calls } = makeSandbox(fixtureRoutes());
  await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const reportCall = decodeURIComponent(calls.find(c => c.includes('/rental_reports?select=')));
  assert.ok(reportCall.includes('received_at=gte.2026-08-05T04:00:00.000Z'), reportCall);
  assert.ok(reportCall.includes('received_at=lt.2026-08-06T04:00:00.000Z'), reportCall);
  // Nothing in the query depends on the dashboard's status/issue-type filters.
  assert.ok(!reportCall.includes('status=in.'), 'export must not inherit the list view status filter');

  const inboundCall = decodeURIComponent(calls.find(c => c.includes('/inbound_sms?sim_id=in.')));
  assert.ok(inboundCall.includes('received_at=gte.2026-08-05T04:00:00.000Z'), inboundCall);
  assert.ok(inboundCall.includes('received_at=lt.2026-08-06T04:00:00.000Z'), inboundCall);
});

// ---------------------------------------------------------
// CSV shape, filename, cohorts, provider vs host
// ---------------------------------------------------------

test('CSV filename carries the NY date range — one date for a day, both for a range', () => {
  const { sandbox } = makeSandbox([]);
  const day = sandbox.buildEscalationExportFilename({ start: '2026-08-05', end: '2026-08-05' }, { scope: 'needs_escalation' });
  assert.equal(day, 'bad_rental_escalations_2026-08-05_ny.csv');

  const range = sandbox.buildEscalationExportFilename({ start: '2026-08-01', end: '2026-08-05' }, { scope: 'needs_escalation' });
  assert.equal(range, 'bad_rental_escalations_2026-08-01_to_2026-08-05_ny.csv');

  const all = sandbox.buildEscalationExportFilename({ start: '2026-08-05', end: '2026-08-05' }, { scope: 'all' });
  assert.equal(all, 'bad_rental_escalations_all_2026-08-05_ny.csv');

  const reason = sandbox.buildEscalationExportFilename(
    { start: '2026-08-05', end: '2026-08-05' },
    { scope: 'needs_escalation', escalation_reason: 'teltik_gateway_port_offline' });
  assert.equal(reason, 'bad_rental_escalations_teltik_gateway_port_offline_2026-08-05_ny.csv');
});

test('the CSV download is attachment-served with the range filename and a row count header', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('Content-Type'), /text\/csv/);
  assert.equal(resp.headers.get('Content-Disposition'),
    'attachment; filename="bad_rental_escalations_2026-08-05_ny.csv"');
  assert.equal(resp.headers.get('X-Escalation-Row-Count'), '3', 'three SIMs need escalation, the healthy one is excluded');
  assert.equal(resp.headers.get('X-Escalation-Range'), '2026-08-05..2026-08-05');
  assert.equal(resp.headers.get('X-Escalation-Tz'), 'America/New_York');
  assert.match(resp.headers.get('Access-Control-Expose-Headers'), /X-Escalation-Row-Count/);
});

test('CSV columns separate service provider from gateway host and carry the escalation evidence', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const csv = await resp.text();
  const header = parseCsv(csv)[0];

  for (const col of [
    'sim_id', 'service_provider', 'gateway_host', 'current_mdn', 'teltik_known_host_mdn', 'iccid',
    'report_ids', 'report_count', 'first_report_at_ny', 'last_report_at_ny',
    'cohort', 'classification', 'failure_type',
    'provider_evidence', 'host_evidence',
    'inbound_sms_count_window', 'inbound_sms_window_ny', 'inbound_sms_ever',
    'provider_escalation_target', 'host_escalation_target', 'recommended_escalation_target', 'recommended_action',
  ]) {
    assert.ok(header.includes(col), 'CSV is missing the ' + col + ' column');
  }
  // Provider and host are distinct columns AND distinct escalation targets.
  assert.ok(header.indexOf('service_provider') !== header.indexOf('gateway_host'));
  assert.ok(header.indexOf('provider_escalation_target') !== header.indexOf('host_escalation_target'));
});

test('an Atomic line hosted on Teltik escalates to BOTH and is never labelled Teltik-provider', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const rows = csvObjects(await resp.text());

  const c1a = rows.find(r => r.sim_id === '640');
  assert.ok(c1a, 'the zero-inbound host-offline SIM must be exported');
  assert.equal(c1a.service_provider, 'atomic', 'service provider stays Atomic for a Teltik-hosted Atomic line');
  assert.equal(c1a.gateway_host, 'teltik');
  assert.equal(c1a.cohort, 'C1a_zero_inbound_host_port_offline');
  assert.match(c1a.provider_escalation_target, /Atomic \/ AT&T \(service provider\)/);
  assert.match(c1a.host_escalation_target, /Teltik \(gateway host\)/);
  assert.match(c1a.recommended_escalation_target, /Atomic \/ AT&T \(service provider\) \+ Teltik \(gateway host\)/);
  assert.equal(c1a.failure_type, 'vendor_active_no_sms', 'provider claim is primary for the never-delivered cohort');
  // Evidence for both layers, and the host MDN Teltik knows the line by.
  assert.match(c1a.provider_evidence, /inbound SMS in window=0/);
  assert.match(c1a.provider_evidence, /inbound SMS ever=no/);
  assert.match(c1a.host_evidence, /port-status offline/);
  assert.equal(c1a.teltik_known_host_mdn, '3105555324');
  assert.equal(c1a.current_mdn, '+13105552678', 'customer MDN stays the provider number');
  assert.equal(c1a.iccid, '89014103211118431688459');
  assert.equal(c1a.report_count, '2');
  assert.equal(c1a.report_ids, '7664 7665');
  assert.equal(c1a.inbound_sms_ever, 'no');
  assert.match(c1a.recommended_action, /Atomic \/ AT&T/);
  assert.match(c1a.recommended_action, /Teltik/);
  // Report timestamps are rendered in NY time (08:47Z → 04:47, 18:12Z → 14:12).
  assert.equal(c1a.first_report_at_ny, '2026-08-05 04:47');
  assert.equal(c1a.last_report_at_ny, '2026-08-05 14:12');
  assert.equal(c1a.inbound_sms_window_ny, '2026-08-05 (NY)');
});

test('port-status HTTP 400 while the line resolves is the joint C1b host-unobservable cohort', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const rows = csvObjects(await resp.text());

  const c1b = rows.find(r => r.sim_id === '700');
  assert.ok(c1b);
  assert.equal(c1b.cohort, 'C1b_zero_inbound_host_port_status_400');
  assert.equal(c1b.service_provider, 'atomic');
  assert.equal(c1b.gateway_host, 'teltik');
  assert.match(c1b.host_evidence, /HTTP 400/);
  assert.match(c1b.provider_escalation_target, /Atomic/);
  assert.match(c1b.host_escalation_target, /Teltik \(gateway host\)/);
  assert.match(c1b.recommended_action, /get-info/);
});

test('a Teltik-PROVIDER line is exported separately from Atomic-provider lines on the same host', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const rows = csvObjects(await resp.text());

  const teltikProvider = rows.find(r => r.sim_id === '800');
  assert.ok(teltikProvider);
  assert.equal(teltikProvider.service_provider, 'teltik', 'this one really is a Teltik-provider line');
  assert.equal(teltikProvider.gateway_host, 'teltik');
  // Line proved itself in-window, so the fault is host-side only.
  assert.equal(teltikProvider.cohort, 'C3_host_port_offline_line_proven_good');
  assert.equal(teltikProvider.inbound_sms_count_window, '2');
  assert.equal(teltikProvider.provider_escalation_target, '', 'no provider claim for a line that delivered SMS');
  assert.match(teltikProvider.host_escalation_target, /Teltik \(gateway host\)/);
  assert.equal(teltikProvider.failure_type, 'teltik_gateway_port_offline');
  assert.match(teltikProvider.host_evidence, /port reset returned no_change\/failed/);
  assert.match(teltikProvider.recommended_action, /reset/);

  // The Atomic rows and the Teltik-provider row are distinguishable by provider.
  const providers = rows.map(r => r.service_provider).sort();
  assert.deepEqual(providers, ['atomic', 'atomic', 'teltik']);
});

test('healthy/no-fault SIMs are excluded by default and included only on request', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const defaultResp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const defaultRows = csvObjects(await defaultResp.text());
  assert.equal(defaultRows.length, 3);
  assert.equal(defaultRows.find(r => r.sim_id === '900'), undefined, 'the healthy SIM is not an escalation');

  const all = makeSandbox(fixtureRoutes());
  const allResp = await all.sandbox.handleBadRentalEscalationExport(
    ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05&scope=all'));
  const allRows = csvObjects(await allResp.text());
  assert.equal(allRows.length, 4);
  const healthy = allRows.find(r => r.sim_id === '900');
  assert.equal(healthy.cohort, 'C4_no_fault_found');
  assert.equal(healthy.recommended_escalation_target, '');
  assert.match(healthy.recommended_action, /No escalation/);
  assert.equal(allResp.headers.get('Content-Disposition'),
    'attachment; filename="bad_rental_escalations_all_2026-08-05_ny.csv"');
});

test('an empty range still returns a header-only CSV with a zero count, never an error', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes({ reports: [] }));
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('X-Escalation-Row-Count'), '0');
  const csv = await resp.text();
  assert.equal(parseCsv(csv).length, 1, 'header row only');
});

test('a failed report query surfaces a 502 with a message instead of an empty CSV', async () => {
  const { sandbox } = makeSandbox([
    ['/rental_reports?select=', () => new Response('boom', { status: 500 })],
  ]);
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  assert.equal(resp.status, 502);
  const body = await resp.json();
  assert.equal(body.error, 'supabase_500');
  assert.match(body.message, /2026-08-05/);
});

test('a failed lifetime-inbound probe reads as unknown, never as "never delivered"', async () => {
  const routes = fixtureRoutes();
  const { sandbox } = makeSandbox([
    ['/inbound_sms?sim_id=eq.', () => new Response('nope', { status: 500 })],
    ...routes,
  ]);
  const resp = await sandbox.handleBadRentalEscalationExport(ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05'));
  const rows = csvObjects(await resp.text());
  const c1a = rows.find(r => r.sim_id === '640');
  assert.equal(c1a.inbound_sms_ever, 'unknown');
  assert.equal(c1a.confidence, 'low', 'an unproven lifetime claim must not be sold as high confidence');
});

// ---------------------------------------------------------
// JSON mode (used for counts/preview and by the operator tooling)
// ---------------------------------------------------------

test('format=json returns the same rows plus totals split by provider and host', async () => {
  const { sandbox } = makeSandbox(fixtureRoutes());
  const resp = await sandbox.handleBadRentalEscalationExport(
    ENV, {}, exportUrl('?start=2026-08-05&end=2026-08-05&format=json'));
  const body = await resp.json();

  assert.equal(body.range.tz, 'America/New_York');
  assert.equal(body.range.start, '2026-08-05');
  assert.equal(body.range.start_utc, '2026-08-05T04:00:00.000Z');
  assert.equal(body.filename, 'bad_rental_escalations_2026-08-05_ny.csv');
  assert.equal(body.rows.length, 3);
  assert.equal(body.totals.needs_escalation, 3);
  assert.equal(body.totals.no_fault_found, 1);
  assert.deepEqual(body.totals.by_service_provider, { atomic: 2, teltik: 1 });
  assert.deepEqual(body.totals.by_gateway_host, { teltik: 3 });
  assert.deepEqual(body.totals.by_provider_host, { 'atomic on teltik': 2, 'teltik on teltik': 1 });
  assert.deepEqual(body.totals.by_cohort, {
    C1a_zero_inbound_host_port_offline: 1,
    C1b_zero_inbound_host_port_status_400: 1,
    C3_host_port_offline_line_proven_good: 1,
  });
});

// ---------------------------------------------------------
// Cohort classifier (pure)
// ---------------------------------------------------------

test('classifier keeps provider and host verdicts independent', () => {
  const { sandbox } = makeSandbox([]);
  const classify = sandbox.classifyEscalationGroup;

  const hostOfflineNeverDelivered = classify({
    vendor: 'atomic', gateway_host: 'teltik',
    host_check: { state: 'offline', http_status: 200 },
    inbound: { count_in_window: 0, ever: false },
  });
  assert.equal(hostOfflineNeverDelivered.escalate, true);
  assert.equal(hostOfflineNeverDelivered.cohort, 'C1a_zero_inbound_host_port_offline');
  assert.match(hostOfflineNeverDelivered.provider_escalation_target, /Atomic/);
  assert.match(hostOfflineNeverDelivered.host_escalation_target, /Teltik/);
  assert.equal(hostOfflineNeverDelivered.confidence, 'high');

  // Host offline on a line that demonstrably delivered SMS is host-only.
  const hostOfflineProvenGood = classify({
    vendor: 'atomic', gateway_host: 'teltik',
    host_check: { state: 'offline', http_status: 200 },
    inbound: { count_in_window: 4, ever: true },
  });
  assert.equal(hostOfflineProvenGood.cohort, 'C3_host_port_offline_line_proven_good');
  assert.equal(hostOfflineProvenGood.provider_escalation_target, '');
  assert.match(hostOfflineProvenGood.host_escalation_target, /Teltik \(gateway host\)/);

  // Everything healthy → no escalation at all.
  const healthy = classify({
    vendor: 'atomic', gateway_host: 'teltik',
    host_check: { state: 'online', http_status: 200 },
    inbound: { count_in_window: 3, ever: true },
  });
  assert.equal(healthy.escalate, false);
  assert.equal(healthy.cohort, 'C4_no_fault_found');
  assert.equal(healthy.recommended_escalation_target, '');

  // A read failure is host-unobservable, never "the port is down".
  const unobservable = classify({
    vendor: 'atomic', gateway_host: 'teltik',
    host_check: { state: 'error', http_status: 400 },
    inbound: { count_in_window: 0, ever: false },
  });
  assert.equal(unobservable.cohort, 'C1b_zero_inbound_host_port_status_400');
  assert.notEqual(unobservable.host_issue, 'teltik_gateway_port_offline');

  // Teltik as the SERVICE PROVIDER gets a provider label of its own.
  const teltikProvider = classify({
    vendor: 'teltik', gateway_host: 'teltik',
    host_check: { state: 'online', http_status: 200 },
    inbound: { count_in_window: 0, ever: false },
  });
  assert.equal(teltikProvider.cohort, 'P1_zero_inbound_host_reads_healthy');
  assert.equal(teltikProvider.provider_escalation_target, 'Teltik (service provider)');
  assert.equal(teltikProvider.host_escalation_target, '');
});

// ---------------------------------------------------------
// Old endpoint compatibility
// ---------------------------------------------------------

test('the old teltik-port-offline export still works and now carries a date range', async () => {
  const { sandbox, calls } = makeSandbox(fixtureRoutes());
  const oldUrl = new URL('https://dashboard/api/bad-rentals/teltik-port-offline-export');
  const resp = await sandbox.handleTeltikPortOfflineExport(ENV, {}, oldUrl);

  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('Content-Type'), /text\/csv/);
  const reportCall = decodeURIComponent(calls.find(c => c.includes('/rental_reports?select=')));
  assert.ok(reportCall.includes('escalation_reason=eq.teltik_gateway_port_offline'),
    'the alias keeps the original host-offline filter');
  assert.ok(reportCall.includes('received_at=gte.'), 'the alias is now bounded by a date range');
  const disposition = resp.headers.get('Content-Disposition');
  assert.match(disposition, /teltik_gateway_port_offline/);
  assert.match(disposition, /_to_\d{4}-\d{2}-\d{2}_ny\.csv/, 'filename carries the resolved NY range');
});

// ---------------------------------------------------------
// Frontend action
// ---------------------------------------------------------

test('the bad rentals tab exposes NY date controls and both export actions', () => {
  assert.match(HTML, /id="bad-rentals-export-start"[^>]*type="date"/);
  assert.match(HTML, /id="bad-rentals-export-end"[^>]*type="date"/);
  assert.match(HTML, /onclick="exportBadRentalEscalations\('today'\)"/);
  assert.match(HTML, /onclick="exportBadRentalEscalations\('range'\)"/);
  assert.match(HTML, /Needs escalation today/);
  assert.match(HTML, /id="bad-rentals-export-status"/);
  assert.match(HTML, /id="bad-rentals-export-all"/);
  // Dates default to today in New York.
  assert.match(HTML, /function nyTodayDate\(\)/);
  assert.match(HTML, /timeZone: 'America\/New_York'/);
  assert.match(HTML, /function initBadRentalExportDates\(\)/);
  assert.match(HTML, /initBadRentalExportDates\(\);/);
});

test('the export action shows loading, a success count, the filename and errors', () => {
  assert.match(HTML, /async function exportBadRentalEscalations\(mode\)/);
  // Loading state + disabled buttons.
  assert.match(HTML, /setBadRentalExportStatus\('Building export for /);
  assert.match(HTML, /b\.disabled = true;/);
  assert.match(HTML, /b\.disabled = false;/);
  // Success: filename + count.
  assert.match(HTML, /Downloaded ' \+ filename \+ ' — ' \+ n \+ ' SIM\(s\) needing escalation/);
  assert.match(HTML, /X-Escalation-Row-Count/);
  assert.match(HTML, /No SIMs need escalation for /);
  // Errors: server message, non-JSON body fallback, thrown errors.
  assert.match(HTML, /Export failed: ' \+ msg/);
  assert.match(HTML, /err && \(err\.message \|\| err\.error\)/);
  assert.match(HTML, /catch \(error\) \{\s*setBadRentalExportStatus\('Export failed: '/);
  assert.match(HTML, /End date ' \+ end \+ ' is before start date /);
});

test('the export downloads through fetch+blob with the server filename, not a bare navigation', () => {
  assert.match(HTML, /await fetch\(API_BASE \+ '\/bad-rentals\/escalation-export' \+ qs\)/);
  assert.match(HTML, /const blob = await resp\.blob\(\);/);
  assert.match(HTML, /URL\.createObjectURL\(blob\)/);
  assert.match(HTML, /a\.download = filename;/);
  assert.match(HTML, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(HTML, /function filenameFromDisposition\(disposition, fallback\)/);
  assert.match(HTML, /filename="\?\(\[\^";\]\+\)"\?/, 'parses the Content-Disposition filename');
  assert.match(HTML, /resp\.headers\.get\('Content-Disposition'\)/);
  // The silent-failure version must be gone.
  assert.ok(!/window\.location\.href = API_BASE \+ '\/bad-rentals\/teltik-port-offline-export'/.test(HTML),
    'the old silent window.location.href download must not remain');
  assert.match(HTML, /scope=' \+ \(allEl && allEl\.checked \? 'all' : 'needs_escalation'\)/);
});
