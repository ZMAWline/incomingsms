// ATOMIC port-in status checker: read-only portinStatus lookup wired into
// mdn-rotator (holds ATOMIC creds), details-finalizer's periodic poll, and
// a dashboard "Check Port-In Status" action button. mdn-rotator/index.js and
// details-finalizer/index.js are large default-export Workers with no named
// exports, so — matching the convention in
// tests/hosting-port-status-jobs.test.mjs — these are wiring proofs against
// the raw source rather than direct function imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const MDN_ROTATOR = read('src', 'mdn-rotator', 'index.js');
const FINALIZER = read('src', 'details-finalizer', 'index.js');
const FINALIZER_TOML = read('src', 'details-finalizer', 'wrangler.toml');
const BULK_ACTIVATOR = read('src', 'bulk-activator', 'index.js');
const DASHBOARD_SRC = read('src', 'dashboard', 'index.js');
const DASHBOARD_HTML = read('src', 'dashboard', 'public', 'index.html');
const MIGRATION = read('migrations', '20260821_atomic_portin_status_columns.sql');

/* ── migration ────────────────────────────────────────────────────────── */

test('migration adds port_in_pending and atomic_portin_* columns, idempotently', () => {
  assert.match(MIGRATION, /ALTER TABLE sims ADD COLUMN IF NOT EXISTS port_in_pending BOOLEAN NOT NULL DEFAULT false/);
  assert.match(MIGRATION, /ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_code TEXT/);
  assert.match(MIGRATION, /ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_description TEXT/);
  assert.match(MIGRATION, /ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_checked_at TIMESTAMPTZ/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS idx_sims_atomic_port_in_pending/);
});

/* ── mdn-rotator: GET /atomic-portin-status ──────────────────────────────── */

test('mdn-rotator exposes GET /atomic-portin-status, secret-gated, MSISDN-only', () => {
  assert.match(MDN_ROTATOR, /url\.pathname === "\/atomic-portin-status" && request\.method === "GET"/);
  const routeStart = MDN_ROTATOR.indexOf('"/atomic-portin-status"');
  const routeEnd = MDN_ROTATOR.indexOf('if (url.pathname === "/remediate-stuck-wing"');
  assert.ok(routeStart > 0 && routeEnd > routeStart, 'route markers found');
  const route = MDN_ROTATOR.slice(routeStart, routeEnd);

  assert.match(route, /secret !== env\.ADMIN_RUN_SECRET/, 'requires ADMIN_RUN_SECRET');
  assert.match(route, /\/\^\\d\{10\}\$\/\.test\(msisdn\)/, 'requires a 10-digit MSISDN');
  assert.match(route, /lookupAtomicPortinStatus\(env, \{ msisdn, iccid \}\)/, 'delegates to the shared lookup helper');

  // Never builds a mutating port-in/activation request in this route.
  for (const forbidden of ['buildAtomicPortInRequest(', 'buildAtomicActivateRequest(', "requestType: 'Activate'", 'requestType: "Activate"']) {
    assert.ok(!route.includes(forbidden), `route must not reference "${forbidden}"`);
  }
});

test('lookupAtomicPortinStatus builds the request via buildAtomicPortInStatusRequest, logs step=portin_status vendor=atomic, and redacts the session', () => {
  const start = MDN_ROTATOR.indexOf('async function lookupAtomicPortinStatus');
  assert.ok(start > 0, 'lookupAtomicPortinStatus defined');
  const end = MDN_ROTATOR.indexOf('\nfunction redactAtomicSession', start);
  assert.ok(end > start, 'function body bounded');
  const fn = MDN_ROTATOR.slice(start, end);

  assert.match(fn, /buildAtomicPortInStatusRequest\(\{/);
  assert.match(fn, /step: 'portin_status'.*vendor: 'atomic'/s);
  assert.match(fn, /request_body: redactAtomicSession\(requestBody\)/, 'logged request body is redacted');
  // Only reads status — never patches sims/carrier state itself; callers own persistence.
  assert.ok(!fn.includes('supabasePatch'), 'lookup helper itself does not mutate the sims row');
});

test('redactAtomicSession blanks userName/token/pin before logging', () => {
  const start = MDN_ROTATOR.indexOf('function redactAtomicSession');
  const end = MDN_ROTATOR.indexOf('\nasync function logCarrierApiCall', start);
  const fn = MDN_ROTATOR.slice(start, end);
  for (const field of ['userName', 'token', 'pin']) {
    assert.match(fn, new RegExp(`session\\.${field} = '\\[REDACTED\\]'`));
  }
});

/* ── mdn-rotator: POST /sim-action action=portin_status ──────────────────── */

test('/sim-action accepts a "portin_status" action, ATOMIC-only, MSISDN-validated', () => {
  assert.match(MDN_ROTATOR, /const validActions = \[.*"portin_status"\]/);
  const start = MDN_ROTATOR.indexOf('if (action === "portin_status") {');
  assert.ok(start > 0, 'portin_status branch present');
  const end = MDN_ROTATOR.indexOf('// For rotate, delegate directly', start);
  assert.ok(end > start, 'branch bounded by the next action');
  const branch = MDN_ROTATOR.slice(start, end);

  assert.match(branch, /sim\.vendor !== "atomic"/, 'refuses non-ATOMIC SIMs');
  assert.match(branch, /\/\^\\d\{10\}\$\/\.test\(msisdn\)/, 'refuses a SIM with no valid MSISDN');
  assert.match(branch, /lookupAtomicPortinStatus\(env, \{ msisdn, iccid \}\)/, 'reuses the shared read-only lookup');
  assert.match(branch, /atomic_portin_status_code: lookup\.statusCode/, 'persists the carrier status code as-is');
  assert.match(branch, /atomic_portin_description: lookup\.description/, 'persists the carrier description as-is');
  assert.match(branch, /atomic_portin_checked_at: new Date\(\)\.toISOString\(\)/, 'stamps when it was checked');

  // No live carrier mutation from this action: never a port-in/cancel/update/
  // activation/suspend/resume/deactivate requestType or builder.
  for (const forbidden of [
    'portinRequest', 'portinCancel', 'portinUpdate',
    'buildAtomicPortInRequest(', 'buildAtomicActivateRequest(',
    'suspendSubscriber', 'reconnectSubscriber', 'deactivateSubscriber',
  ]) {
    assert.ok(!branch.includes(forbidden), `portin_status branch must not reference "${forbidden}"`);
  }
  // Only the read-only three status fields are patched — sims.status and
  // port_in_pending are left alone (no auto-completion from a manual check).
  const patchMatch = branch.match(/supabasePatch\(env, `sims\?id=eq\.[^`]*`, \{([\s\S]*?)\}\);/);
  assert.ok(patchMatch, 'supabasePatch call found in branch');
  const patchBody = patchMatch[1];
  assert.ok(!/\bstatus:/.test(patchBody), 'must not touch sims.status');
  assert.ok(!/\bport_in_pending:/.test(patchBody), 'must not clear/set port_in_pending itself');
});

/* ── details-finalizer ────────────────────────────────────────────────── */

test('details-finalizer runs the ATOMIC port-in status finalizer every tick (manual /run and scheduled)', () => {
  assert.match(FINALIZER, /const atomicPortinStatus = await runAtomicPortinStatusFinalizer\(env, limit\)/);
  assert.match(FINALIZER, /ctx\.waitUntil\(runAtomicPortinStatusFinalizer\(env, 50\)\)/);
});

test('runAtomicPortinStatusFinalizer polls only vendor=atomic, status=provisioning, port_in_pending=true SIMs', () => {
  const start = FINALIZER.indexOf('async function runAtomicPortinStatusFinalizer');
  assert.ok(start > 0, 'finalizer function defined');
  const end = FINALIZER.indexOf('/* ── Rotation Review', start);
  assert.ok(end > start, 'function body bounded');
  const fn = FINALIZER.slice(start, end);

  assert.match(fn, /vendor=eq\.atomic&status=eq\.provisioning&port_in_pending=eq\.true/);
  assert.match(fn, /env\.MDN_ROTATOR\.fetch\(url/, 'reaches ATOMIC only via the mdn-rotator service binding');
  assert.match(fn, /\/atomic-portin-status\?secret=/, 'calls the read-only status route, not a mutating one');
  assert.match(fn, /atomic_portin_status_code: data\.statusCode/);
  assert.match(fn, /atomic_portin_description: data\.description/);
  assert.match(fn, /atomic_portin_checked_at: new Date\(\)\.toISOString\(\)/);

  // Records the carrier's raw status only — does not interpret it into an
  // auto-transition of sims.status or clear port_in_pending itself.
  assert.ok(!fn.includes('status: '), 'finalizer must not set sims.status (no auto-completion)');
  assert.ok(!fn.includes('port_in_pending:'), 'finalizer must not clear port_in_pending itself');
  for (const forbidden of ['portinRequest', 'portinCancel', 'portinUpdate', 'swapMSISDN']) {
    assert.ok(!fn.includes(forbidden), `finalizer must not reference "${forbidden}"`);
  }
});

test('details-finalizer wrangler.toml documents the MDN_ROTATOR binding covers portinStatus polling', () => {
  assert.match(FINALIZER_TOML, /binding = "MDN_ROTATOR"/);
  assert.match(FINALIZER_TOML, /portinStatus polling/);
});

/* ── bulk-activator: sets port_in_pending on a submitted port-in ─────────── */

test('bulk-activator marks port_in_pending on ATOMIC upserts, explicitly true or false', () => {
  assert.match(BULK_ACTIVATOR, /portInPending: true, \/\/ marks this SIM for details-finalizer's portinStatus poll/);
  assert.match(BULK_ACTIVATOR, /payload\.port_in_pending = !!result\.portInPending/);
});

/* ── dashboard: exposes the fields and a manual action button ────────────── */

test('dashboard /api/sims query selects msisdn and the atomic_portin_* fields', () => {
  assert.match(DASHBOARD_SRC, /select=[^`]*\bmsisdn\b/);
  assert.match(DASHBOARD_SRC, /select=[^`]*\bport_in_pending\b/);
  assert.match(DASHBOARD_SRC, /select=[^`]*\batomic_portin_status_code\b/);
  assert.match(DASHBOARD_SRC, /select=[^`]*\batomic_portin_description\b/);
  assert.match(DASHBOARD_SRC, /select=[^`]*\batomic_portin_checked_at\b/);
});

test('dashboard /api/sims response actually forwards msisdn and the atomic_portin_* fields to the browser (not just selected from Supabase)', () => {
  // handleSims selects these columns from Supabase but was dropping them
  // before building the `formatted` response object, so sim.port_in_pending
  // and sim.msisdn were always undefined in the browser and the button never
  // rendered for anyone, regardless of vendor or pending state.
  const start = DASHBOARD_SRC.indexOf('async function handleSims');
  assert.ok(start > 0, 'handleSims defined');
  const end = DASHBOARD_SRC.indexOf('\nasync function handleMessages', start);
  assert.ok(end > start, 'function body bounded');
  const fn = DASHBOARD_SRC.slice(start, end);

  const mapStart = fn.indexOf('const formatted = filteredSims.map(sim => {');
  assert.ok(mapStart > 0, 'formatted map found');
  const objBody = fn.slice(mapStart, fn.indexOf('return new Response', mapStart));

  assert.match(objBody, /msisdn:\s*sim\.msisdn \|\| null/);
  assert.match(objBody, /port_in_pending:\s*sim\.port_in_pending \|\| false/);
  assert.match(objBody, /atomic_portin_status_code:\s*sim\.atomic_portin_status_code \|\| null/);
  assert.match(objBody, /atomic_portin_description:\s*sim\.atomic_portin_description \|\| null/);
  assert.match(objBody, /atomic_portin_checked_at:\s*sim\.atomic_portin_checked_at \|\| null/);
});

test('dashboard SIM detail modal shows a "Check Port-In Status" button for ATOMIC SIMs with an MSISDN, not gated on port_in_pending', () => {
  assert.match(DASHBOARD_HTML, /var canPortinStatus = sim\.vendor === 'atomic' && !!sim\.msisdn;/);
  assert.doesNotMatch(DASHBOARD_HTML, /var canPortinStatus = sim\.vendor === 'atomic' && !!sim\.port_in_pending;/);
  assert.match(DASHBOARD_HTML, /canPortinStatus \? '<button onclick="_sdPortinStatus\(\)"/);
  assert.match(DASHBOARD_HTML, /function _sdPortinStatus\(\) \{ if \(_sdCurrentSim\) simAction\(_sdCurrentSim\.id, 'portin_status'\); \}/);
});

test('dashboard SIM detail modal shows Port-In Status once checked, even after port_in_pending clears', () => {
  assert.match(DASHBOARD_HTML, /\(\(sim\.port_in_pending \|\| sim\.atomic_portin_checked_at\) \? _sdField\('Port-In Status'/);
});

test('dashboard action dispatch (simAction) is generic and reaches POST /sim-action for any action, including portin_status', () => {
  assert.match(DASHBOARD_HTML, /async function simAction\(simId, action, skipConfirm = false, extraBody = \{\}\)/);
  assert.match(DASHBOARD_HTML, /fetch\(`\$\{API_BASE\}\/sim-action`, \{/);
  assert.match(DASHBOARD_HTML, /body: JSON\.stringify\(Object\.assign\(\{ sim_id: simId, action \}, extraBody\)\)/);
});
