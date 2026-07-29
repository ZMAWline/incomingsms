// Report #6817 regression (Zalmen 2026-07-29): Atomic-provider SIM hosted on a
// Teltik/Celtic gateway. Required flow:
//   1. provider (Atomic) read first — TH5 port-offline only wins with
//      provider-active evidence; a suspended/cancelled line routes to the
//      vendor classifier (A3/A4) instead,
//   2. Teltik host port checked before resend_online,
//   3. port online → resend_online fires even while outbound SMS verification
//      is disabled (the resend is the remediation; it sends no SMS),
//   4. port offline → reset-port, wait 30s (env-injectable), recheck:
//      still offline → escalate teltik_gateway_port_offline;
//      online → NO remediated close off port state alone — requeue so the
//      normal resend_online path runs next tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js');
const TMP_INDEX_PATH = path.join(__dirname, '..', 'src', 'bad-rental-remediator', '.tmp-teltik-host-port-index.mjs');
const SRC = fs.readFileSync(INDEX_PATH, 'utf8');

async function importWorker() {
  fs.writeFileSync(TMP_INDEX_PATH, SRC);
  try {
    return (await import(`${TMP_INDEX_PATH}?t=${Date.now()}`)).default;
  } finally {
    try { fs.unlinkSync(TMP_INDEX_PATH); } catch (_) { /* best effort */ }
  }
}

// ---------------------------------------------------------
// Harness: fake Supabase + Teltik + Atomic. One same-day report (#6817) for an
// Atomic-vendor SIM whose gateway_host is teltik.
// ---------------------------------------------------------

function makeHarness({ attStatus = 'active', portStatuses = [] } = {}) {
  const db = { report: null, attempts: [], urls: [] };
  db.report = {
    id: 6817, status: 'received', received_at: new Date().toISOString(),
    sim_id: 'sim-6817', sim_number_id: null, rental_id: 'r-6817', reseller_id: 'rs-1',
    e164: '+15550006817', auto_remediation_state: null, last_auto_attempt_at: null,
  };
  const sim = {
    id: 'sim-6817', iccid: '8901410327000006817', vendor: 'atomic', gateway_host: 'teltik',
    status: 'active', msisdn: '5550006817', gateway_id: null, port: null,
  };
  const rental = {
    id: 'r-6817', sim_id: 'sim-6817', reseller_id: 'rs-1',
    reseller_rental_id: 'rr-6817', rental_date: '2026-07-29', minted_at: new Date().toISOString(),
  };
  const kvStore = { bad_rental_remediator_enabled: 'true' };
  let portStatusCalls = 0;

  const fakeFetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    db.urls.push({ url: u, method });

    if (u.includes('api.smsgateway.xyz/v1/port-status')) {
      const state = portStatuses[Math.min(portStatusCalls, portStatuses.length - 1)];
      portStatusCalls++;
      return new Response(JSON.stringify({ success: true, status: state }), { status: 200 });
    }
    if (u.includes('api.smsgateway.xyz/v1/reset-port')) {
      return new Response(JSON.stringify({ success: true, request_id: 'rp-1' }), { status: 200 });
    }
    if (u.startsWith('https://atomic.test')) {
      return new Response(JSON.stringify({
        wholeSaleApi: { wholeSaleResponse: {
          statusCode: '00',
          Result: { attStatus, MSISDN: '5550006817' },
        } },
      }), { status: 200 });
    }

    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const r = db.report;
      const open = (r.status === 'received' || r.status === 'in_triage')
        && (r.auto_remediation_state == null || r.auto_remediation_state === 'queued')
        && !r.last_auto_attempt_at;
      return new Response(JSON.stringify(open ? [r] : []), { status: 200 });
    }
    if (u.includes('/rental_reports?sim_id=eq.') && method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress') && method === 'PATCH') {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rental_reports?id=eq.6817')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = db.report.auto_remediation_state == null
            || db.report.auto_remediation_state === 'queued';
          if (claimable) Object.assign(db.report, body);
          return new Response(null, {
            status: 204,
            headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' },
          });
        }
        Object.assign(db.report, body);
        return new Response('[]', { status: 200 });
      }
      return new Response(JSON.stringify([db.report]), { status: 200 });
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') {
        db.attempts.push(JSON.parse(init.body));
        return new Response('[]', { status: 201 });
      }
      return new Response(JSON.stringify(db.attempts), { status: 200 });
    }
    if (u.includes('/sims?id=eq.')) {
      return new Response(JSON.stringify([sim]), { status: 200 });
    }
    if (u.includes('/rentals?id=eq.')) {
      return new Response(JSON.stringify([rental]), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };

  let resellerSyncCalls = 0;
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    ADMIN_RUN_SECRET: 's',
    TELTIK_API_KEY: 'tk',
    TELTIK_PORT_RECHECK_WAIT_MS: '0', // mock the 30s wait out of the test
    ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p',
    ATOMIC_API_URL: 'https://atomic.test',
    REMEDIATOR_KV: {
      async get(k) { return kvStore[k] === undefined ? null : kvStore[k]; },
      async put(k, v) { kvStore[k] = v; },
      async delete(k) { delete kvStore[k]; },
    },
    RESELLER_SYNC: {
      async fetch() {
        resellerSyncCalls++;
        return new Response(JSON.stringify({ ok: true, status: 'sent' }), { status: 200 });
      },
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return {
    env, db,
    resellerSyncCalls: () => resellerSyncCalls,
    resetPortCalls: () => db.urls.filter(c => c.url.includes('/v1/reset-port')).length,
    portStatusCalls: () => portStatusCalls,
    restore: () => { globalThis.fetch = orig; },
  };
}

async function runTickViaWorker(env) {
  const worker = await importWorker();
  const resp = await worker.fetch(new Request('https://w/run?secret=s'), env);
  const body = await resp.json();
  assert.equal(body.ok, true);
  return body.result;
}

// ---------------------------------------------------------
// (3) Port online + A6 → resend_online fires even while SMS is disabled.
// ---------------------------------------------------------

test('6817: Atomic active + Teltik host port online → resend_online executes despite SMS kill switch', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['online'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resellerSyncCalls(), 1, 'reseller resend must fire — port online proves the host path works');
    assert.equal(h.resetPortCalls(), 0, 'no reset when the port is already online');

    assert.equal(h.db.attempts.length, 1);
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'A6');
    assert.equal(a.action, 'resend_online');
    assert.equal(a.outcome, 'acted_sms_unverified', 'the resend ran but §C cannot confirm it while SMS is off');
    assert.equal(a.evidence.exec_status, 'ok');
    assert.equal(a.evidence.gate_status, 'sms_unavailable');

    // No terminal close off an unverifiable resend — report stays open/queued.
    assert.equal(h.db.report.status, 'received');
    assert.equal(h.db.report.auto_remediation_state, 'queued');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (4a) Port offline → reset-port, wait, recheck still offline → escalate as
// Teltik port down (NOT deactivated/cancelled — Atomic is active).
// ---------------------------------------------------------

test('6817: Atomic active + Teltik host port offline, recheck still offline → escalated teltik_gateway_port_offline', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['offline', 'offline'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resetPortCalls(), 1, 'reset-port must fire for the offline host port');
    assert.ok(h.portStatusCalls() >= 2, 'port must be rechecked after the reset');
    assert.equal(h.resellerSyncCalls(), 0, 'no resend while the host port is down');

    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH5');
    assert.equal(a.action, 'teltik_reset_port');
    assert.equal(a.outcome, 'escalate');
    assert.equal(a.evidence.issue_type, 'Teltik gateway port offline');
    assert.equal(a.evidence.recheck_port_status.online, false);

    assert.equal(h.db.report.auto_remediation_state, 'escalated');
    assert.equal(h.db.report.escalation_reason, 'teltik_gateway_port_offline');
    assert.equal(h.db.report.status, 'received', 'escalation is operator-facing; report is not closed');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (4b) Port offline → reset-port, recheck online → NO remediated close;
// report requeues, eligible for the normal resend path next tick.
// ---------------------------------------------------------

test('6817: reset-port recheck online → no false remediated closure, report requeued for resend', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['offline', 'online'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resetPortCalls(), 1);
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH5');
    assert.equal(a.action, 'teltik_reset_port');
    assert.notEqual(a.outcome, 'remediated', 'port-online recheck alone must never close the report');
    assert.equal(a.outcome, 'no_change');
    assert.equal(a.evidence.issue_type, 'Teltik gateway port reset resolved');
    assert.equal(a.evidence.recheck_port_status.online, true);

    assert.equal(h.db.report.status, 'received');
    assert.notEqual(h.db.report.status, 'remediated');
    assert.equal(h.db.report.auto_remediation_state, 'queued', 'requeued so the resend path runs next tick');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (1) Provider NOT active → vendor classifier owns the report; TH5 must not
// fire off the offline host port.
// ---------------------------------------------------------

test('6817: Atomic suspended + Teltik host port offline → A3 vendor path, not TH5', async () => {
  const h = makeHarness({ attStatus: 'suspended', portStatuses: ['offline', 'offline'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resetPortCalls(), 0, 'suspended line is a carrier problem; no Teltik reset');
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'A3');
    assert.equal(a.action, 'atomic_restore');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// Source pins: 30s default wait, injectable for tests; sleep sits between
// reset and recheck.
// ---------------------------------------------------------

test('TH5 recheck waits 30s by default and the wait is env-injectable', () => {
  assert.match(SRC, /const TELTIK_PORT_RECHECK_WAIT_MS = 30_000/);
  assert.match(SRC, /env\.TELTIK_PORT_RECHECK_WAIT_MS !== undefined\n\s*\? Number\(env\.TELTIK_PORT_RECHECK_WAIT_MS\) : TELTIK_PORT_RECHECK_WAIT_MS/);
  const idx = SRC.indexOf('if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));');
  assert.ok(idx >= 0, 'expected an awaited setTimeout wait');
  const recheckIdx = SRC.indexOf('const recheck = await teltikPortStatus(env);');
  assert.ok(recheckIdx > idx, 'wait must happen BEFORE the port recheck');
});
