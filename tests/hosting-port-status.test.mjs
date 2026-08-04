// Canonical Teltik hosting port-status tracking (task t_a71decd6):
// normalization, recording, wrong-MDN retry, sweep, migration schema, and the
// wiring proofs that every check source (SIM query, teltik-host-check, bulk,
// cron, bad-rental-remediator) writes the same hosting_port_status_checks
// history and the Sims table shows the newest persisted status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeHostPortState,
  buildHostingPortCheckRow,
  toTeltik10Digit,
  checkAndRecordTeltikHostPort,
  runHostingPortSweep,
  CHECK_SOURCES,
} from '../src/shared/hosting-port-status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MIGRATION = read('migrations', '20260804_hosting_port_status_checks.sql');
const DASHBOARD_SRC = read('src', 'dashboard', 'index.js');
const DASHBOARD_HTML = read('src', 'dashboard', 'public', 'index.html');
const DASHBOARD_TOML = read('src', 'dashboard', 'wrangler.toml');
const REMEDIATOR_SRC = read('src', 'bad-rental-remediator', 'index.js');
const SHARED_SRC = read('src', 'shared', 'hosting-port-status.mjs');

// --- normalization: errors are never offline -------------------------------

test('normalizeHostPortState: only a successful response can say offline', () => {
  assert.equal(normalizeHostPortState(200, { port_status: 'online' }), 'online');
  assert.equal(normalizeHostPortState(200, { status: 'registered' }), 'online');
  assert.equal(normalizeHostPortState(200, { port_status: 'offline' }), 'offline');
  assert.equal(normalizeHostPortState(200, { state: 'down' }), 'offline');
  // Unrecognized-but-successful reads are unknown, not offline.
  assert.equal(normalizeHostPortState(200, { port_status: 'rebooting' }), 'unknown');
  assert.equal(normalizeHostPortState(200, {}), 'unknown');
  // Wrong MDN / HTTP failures / no response are error, never offline.
  assert.equal(normalizeHostPortState(400, { error: 'Invalid MDN' }), 'error');
  assert.equal(normalizeHostPortState(404, { port_status: 'offline' }), 'error');
  assert.equal(normalizeHostPortState(500, null), 'error');
  assert.equal(normalizeHostPortState(0, null), 'error');
  assert.equal(normalizeHostPortState(null, { port_status: 'online' }), 'error');
});

test('toTeltik10Digit strips +1/1 country prefix', () => {
  assert.equal(toTeltik10Digit('+19175550101'), '9175550101');
  assert.equal(toTeltik10Digit('19175550101'), '9175550101');
  assert.equal(toTeltik10Digit('9175550101'), '9175550101');
  assert.equal(toTeltik10Digit(null), '');
});

test('buildHostingPortCheckRow constrains state/source and stamps checked_at', () => {
  const row = buildHostingPortCheckRow({
    sim_id: 7, iccid: 'ICC', vendor: 'atomic', mdn: '9175550101',
    mdn_source: 'teltik_inbound_sms_payload_mdn', source: 'cron',
    http_status: 200, state: 'online', raw: { port_status: 'online' },
  });
  assert.equal(row.sim_id, 7);
  assert.equal(row.vendor, 'atomic', 'vendor stays the service provider');
  assert.equal(row.gateway_host, 'teltik');
  assert.equal(row.source, 'cron');
  assert.equal(row.state, 'online');
  assert.equal(row.attempt, 1);
  assert.ok(row.checked_at && !Number.isNaN(Date.parse(row.checked_at)));
  // Unknown source/state degrade safely instead of violating the DB CHECK.
  assert.equal(buildHostingPortCheckRow({ source: 'nonsense', state: 'weird' }).state, 'error');
  assert.equal(buildHostingPortCheckRow({ source: 'nonsense', state: 'online' }).source, 'single_query');
  for (const s of ['cron', 'manual_bulk', 'single_query', 'bad_rental_remediator']) {
    assert.ok(CHECK_SOURCES.includes(s), 'canonical source list covers ' + s);
  }
});

// --- behavior: check + record + wrong-MDN retry ----------------------------

const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function mockFetch(posted, { firstMdnFails = false } = {}) {
  return async (url, opts = {}) => {
    url = String(url);
    if (url.includes('/rest/v1/inbound_sms')) {
      return jsonResp([{ to_number: '+15550001111', received_at: '2026-08-04T00:00:00Z', raw: { destination: '9175550101' } }]);
    }
    if (url.includes('/rest/v1/hosting_port_status_checks')) {
      posted.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (url.includes('/rest/v1/sims')) {
      return jsonResp([
        { id: 1, iccid: 'ICC1', vendor: 'atomic', gateway_host: 'teltik', sim_numbers: [{ e164: '+15550001111' }] },
        { id: 2, iccid: 'ICC2', vendor: 'teltik', gateway_host: null, sim_numbers: [] },
      ]);
    }
    if (url.includes('/v1/port-status')) {
      const mdn = new URL(url).searchParams.get('mdn');
      if (firstMdnFails && mdn === '9175550101') return jsonResp({ error: 'Invalid MDN' }, 400);
      return jsonResp({ port_status: 'online' });
    }
    if (url.includes('/v1/get-phone-number')) return jsonResp({ msisdn: '9175550999' });
    throw new Error('unexpected fetch ' + url);
  };
}

const ENV = { SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'key', TELTIK_API_KEY: 'tk' };

test('checkAndRecordTeltikHostPort records via canonical recorder, keyed by payload MDN', async () => {
  const posted = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(posted);
  try {
    const r = await checkAndRecordTeltikHostPort(ENV,
      { id: 1, iccid: 'ICC1', vendor: 'atomic', gateway_host: 'teltik', db_current_mdn: '+15550001111' },
      { source: 'single_query' });
    assert.equal(r.state, 'online');
    assert.equal(r.retried, false);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].mdn, '9175550101', 'uses Teltik payload MDN, not DB current MDN');
    assert.equal(posted[0].mdn_source, 'teltik_inbound_sms_payload_mdn');
    assert.equal(posted[0].vendor, 'atomic', 'service vendor preserved for Teltik-hosted Atomic SIM');
    assert.equal(posted[0].source, 'single_query');
  } finally { globalThis.fetch = orig; }
});

test('wrong-MDN read records error (never offline), retries via ICCID lookup, records both attempts', async () => {
  const posted = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(posted, { firstMdnFails: true });
  try {
    const r = await checkAndRecordTeltikHostPort(ENV,
      { id: 1, iccid: 'ICC1', vendor: 'atomic', gateway_host: 'teltik', db_current_mdn: null },
      { source: 'manual_bulk' });
    assert.equal(posted.length, 2, 'both attempts audited');
    assert.equal(posted[0].state, 'error');
    assert.equal(posted[0].attempt, 1);
    assert.equal(posted[0].http_status, 400);
    assert.notEqual(posted[0].state, 'offline');
    assert.equal(posted[1].attempt, 2);
    assert.equal(posted[1].state, 'online');
    assert.equal(posted[1].mdn, '9175550999');
    assert.equal(posted[1].mdn_source, 'teltik_get_phone_number_retry');
    assert.equal(r.state, 'online');
    assert.equal(r.retried, true);
  } finally { globalThis.fetch = orig; }
});

test('runHostingPortSweep checks all Teltik-hosted SIMs and records with the given source', async () => {
  const posted = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(posted);
  try {
    const summary = await runHostingPortSweep(ENV, { source: 'cron' });
    assert.equal(summary.ok, true);
    assert.equal(summary.total, 2);
    assert.equal(summary.online, 2);
    assert.equal(summary.offline, 0);
    assert.equal(posted.length, 2);
    assert.ok(posted.every(p => p.source === 'cron'));
    const bySim = Object.fromEntries(posted.map(p => [p.sim_id, p]));
    assert.equal(bySim[1].vendor, 'atomic');
    assert.equal(bySim[2].vendor, 'teltik');
  } finally { globalThis.fetch = orig; }
});

// --- migration schema ------------------------------------------------------

test('migration creates the canonical table, indexes and summary RPC idempotently', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS hosting_port_status_checks/);
  for (const col of ['sim_id', 'iccid', 'vendor', 'gateway_host', 'mdn', 'mdn_source', 'source', 'attempt', 'http_status', 'state', 'raw', 'error', 'checked_at']) {
    assert.match(MIGRATION, new RegExp('^\\s*' + col + '\\s', 'm'), 'column ' + col);
  }
  assert.match(MIGRATION, /CHECK \(state IN \('online','offline','unknown','error'\)\)/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS idx_hpsc_sim_checked_at ON hosting_port_status_checks \(sim_id, checked_at DESC\)/);
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS idx_hpsc_checked_at/);
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION get_hosting_port_status_summary\(sim_ids bigint\[\]\)/);
  // Latest-by-sim derives from newest check; stats windows cover 24h and 7d.
  assert.match(MIGRATION, /DISTINCT ON \(c\.sim_id\)/);
  assert.match(MIGRATION, /ORDER BY c\.sim_id, c\.checked_at DESC/);
  assert.match(MIGRATION, /interval '24 hours'/);
  assert.match(MIGRATION, /interval '7 days'/);
});

// --- wiring: every source records to the same canonical history ------------

test('all Teltik port-status call sites route through the shared recorder', () => {
  // Single place that writes the table: the shared module.
  assert.match(SHARED_SRC, /\/rest\/v1\/hosting_port_status_checks/);
  assert.doesNotMatch(DASHBOARD_SRC, /rest\/v1\/hosting_port_status_checks/, 'dashboard uses the shared recorder, not direct table writes');
  assert.doesNotMatch(REMEDIATOR_SRC, /rest\/v1\/hosting_port_status_checks/, 'remediator uses the shared recorder, not direct table writes');
  // Dashboard: teltik-query + teltik-host-check + sweep all record.
  assert.match(DASHBOARD_SRC, /import \{ recordHostingPortCheck, buildHostingPortCheckRow, normalizeHostPortState, runHostingPortSweep \} from '\.\.\/shared\/hosting-port-status\.mjs'/);
  const dashboardRecordCalls = (DASHBOARD_SRC.match(/recordHostingPortCheck\(env,/g) || []).length;
  assert.ok(dashboardRecordCalls >= 2, 'teltik-query and teltik-host-check both record (got ' + dashboardRecordCalls + ')');
  // Remediator: both evidence read and resend-gate recheck record.
  assert.match(REMEDIATOR_SRC, /source: 'bad_rental_remediator'/);
  const remediatorRecordCalls = (REMEDIATOR_SRC.match(/recordHostPortRead\(env,/g) || []).length;
  assert.ok(remediatorRecordCalls >= 2, 'remediator records evidence read and recheck (got ' + remediatorRecordCalls + ')');
});

test('12h cron + manual run endpoint exist and share the sweep implementation', () => {
  assert.match(DASHBOARD_TOML, /\[triggers\]\ncrons = \["0 \*\/12 \* \* \*"\]/);
  assert.match(DASHBOARD_TOML, /\[env\.test\.triggers\]\ncrons = \[\]/);
  assert.match(DASHBOARD_SRC, /async scheduled\(event, env, ctx\)/);
  assert.match(DASHBOARD_SRC, /runHostingPortSweep\(env, \{ source: 'cron' \}\)/);
  assert.match(DASHBOARD_SRC, /\/api\/hosting-port-status\/run/);
  assert.match(DASHBOARD_SRC, /handleHostingPortStatusRun/);
  assert.match(SHARED_SRC, /concurrency = 5/);
  assert.match(SHARED_SRC, /maxSims = 200/);
});

test('/api/sims returns latest persisted host-port status + uptime from the summary RPC', () => {
  assert.match(DASHBOARD_SRC, /rpc\/get_hosting_port_status_summary/);
  assert.match(DASHBOARD_SRC, /hosting_port_state: hp \? hp\.last_state : null/);
  assert.match(DASHBOARD_SRC, /hosting_port_checked_at/);
  assert.match(DASHBOARD_SRC, /hosting_port_checks_24h/);
  assert.match(DASHBOARD_SRC, /hosting_port_online_7d/);
});

// --- UI --------------------------------------------------------------------

test('Sims table shows Host Port column from persisted data with source/uptime tooltip', () => {
  assert.match(DASHBOARD_HTML, /sortTable\('sims','hosting_port_state'\)/);
  assert.match(DASHBOARD_HTML, /hostPortCell\(sim\)/);
  assert.match(DASHBOARD_HTML, /hosting_port_state: 'Host Port'/, 'column visibility menu entry');
  assert.match(DASHBOARD_HTML, /never checked/);
  assert.match(DASHBOARD_HTML, /Uptime 24h/);
  assert.match(DASHBOARD_HTML, /Source: ' \+ \(sim\.hosting_port_source/);
  // Provider vs host display preserved: vendor badge still renders separately.
  assert.match(DASHBOARD_HTML, /\$\{vendorBadge\}/);
});

test('bulk Port Status action runs, summarizes and refreshes latest status', () => {
  assert.match(DASHBOARD_HTML, /onclick="bulkPortStatus\(\)"/);
  assert.match(DASHBOARD_HTML, /\/hosting-port-status\/run/);
  assert.match(DASHBOARD_HTML, /source: 'manual_bulk'/);
  assert.match(DASHBOARD_HTML, /Wrong-MDN retries/);
  // Refreshes the table after persisting so Host Port shows the new status.
  const fn = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('async function bulkPortStatus'));
  assert.match(fn.slice(0, fn.indexOf('\n        }')), /loadSims\(true\)/);
});

test('Rotation Audit widget removed from Sims page', () => {
  assert.doesNotMatch(DASHBOARD_HTML, /rotation-audit-widget/);
  assert.doesNotMatch(DASHBOARD_HTML, /loadRotationAudit/);
  assert.doesNotMatch(DASHBOARD_HTML, /showRotationAuditBucket/);
  assert.doesNotMatch(DASHBOARD_HTML, /reconcileNow/);
});

test('IMEI, Auto On/Off and OTA removed from SIM row quick actions without dead handlers', () => {
  assert.doesNotMatch(DASHBOARD_HTML, /title="Change IMEI"/);
  assert.doesNotMatch(DASHBOARD_HTML, /Auto: Off/);
  assert.doesNotMatch(DASHBOARD_HTML, /Auto: On/);
  assert.doesNotMatch(DASHBOARD_HTML, /setRotationEligible\(\$\{sim\.id\}/);
  assert.doesNotMatch(DASHBOARD_HTML, /async function setRotationEligible/, 'dead single-SIM handler removed');
  // The row template no longer has an OTA quick action (bulk menu + errors tab keep theirs).
  const rowStart = DASHBOARD_HTML.indexOf('function renderSims()');
  const rowEnd = DASHBOARD_HTML.indexOf('applySimsColumnVisibility();', rowStart);
  const renderSimsBody = DASHBOARD_HTML.slice(rowStart, rowEnd);
  assert.doesNotMatch(renderSimsBody, />OTA<\/button>/);
  assert.doesNotMatch(renderSimsBody, />IMEI<\/button>/);
});
