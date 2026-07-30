// Report #6817 regression (Zalmen 2026-07-29): Atomic-provider SIM hosted on a
// Teltik/Celtic gateway. Required flow:
//   1. provider (Atomic) read first — TH5 port-offline only wins with
//      provider-active evidence; a suspended/cancelled line routes to the
//      vendor classifier (A3/A4) instead,
//   2. Teltik host port checked before resend_online,
//   3. port online → TH2 resend_online fires even while outbound SMS
//      verification is disabled (the resend is the remediation; it sends no
//      SMS), REGARDLESS of stale webhook-delivered evidence — never A1
//      atomic_ota for a hosted SIM,
//   3b. port read missing/failed → nonterminal pending_teltik_host_port_read,
//      no atomic_ota, no resend — retry next tick,
//   4. port offline → reset-port NOW, recheck DEFERRED (no in-tick sleep —
//      the old synchronous 30s wait per report blew the 55s tick budget):
//      the attempt records recheck pending with next_review_at ~30s out and
//      the report's last_auto_attempt_at is backdated so intake re-admits it
//      after the re-register window instead of the 15m defer. Next pass:
//      still offline + prior reset attempt → escalate
//      teltik_gateway_port_offline without resetting again;
//      online → NO remediated close off port state alone — the normal TH2
//      resend_online path runs.

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

function makeHarness({ attStatus = 'active', portStatuses = [], webhookDelivered = false } = {}) {
  const db = { report: null, attempts: [], urls: [] };
  db.report = {
    id: 6817, status: 'received', received_at: new Date().toISOString(),
    sim_id: 'sim-6817', sim_number_id: null, rental_id: 'r-6817', reseller_id: 'rs-1',
    e164: '+155****6817', auto_remediation_state: null, last_auto_attempt_at: null,
    reason_code: 'no_sms_received', attempts: 9,
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
      if (state === 'error') return new Response(JSON.stringify({ success: false, error: 'port_read_failed' }), { status: 500 });
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
      // Mirror fetchOpenReports' INTAKE_DEFER_MS eligibility so a backdated
      // last_auto_attempt_at (TH5 deferred recheck) re-admits the row.
      const r = db.report;
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const open = (r.status === 'received' || r.status === 'in_triage')
        && (r.auto_remediation_state == null || r.auto_remediation_state === 'queued')
        && (r.last_auto_attempt_at == null || r.last_auto_attempt_at < cutoff);
      return new Response(JSON.stringify(open ? [r] : []), { status: 200 });
    }
    if (u.includes('/rental_reports?sim_id=eq.') && method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/webhook_deliveries?') && method === 'GET') {
      return new Response(JSON.stringify(webhookDelivered ? [{ delivered_at: new Date().toISOString() }] : []), { status: 200 });
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
// (3) Port online + provider active is only assessment evidence. It must not
// tell the reseller `number.online` as first-line remediation for a
// no_sms_received complaint.
// ---------------------------------------------------------

test('7182: Atomic active + Teltik host port online → classify diagnostic, no first-line resend_online', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['online'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resellerSyncCalls(), 0, 'must not send number.online before proving/fixing SMS receipt');
    assert.equal(h.resetPortCalls(), 0, 'no reset when the port is already online');

    assert.equal(h.db.attempts.length, 1);
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH2');
    assert.equal(a.action, 'classify_only');
    assert.equal(a.outcome, 'no_change');
    assert.equal(a.evidence.reason, 'teltik_host_sms_unverified');
    assert.equal(a.evidence.pending_reason, 'sms_receipt_unverified_no_online_notification');
    assert.equal(a.evidence.disallowed_action, 'resend_online');

    // No terminal close off host/provider health alone — report stays open/queued.
    assert.equal(h.db.report.status, 'received');
    assert.equal(h.db.report.auto_remediation_state, 'queued');
  } finally { h.restore(); }
});

test('7182: stale webhook-delivered evidence still records TH2 diagnostic, never resend_online or A1 atomic_ota', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['online'], webhookDelivered: true });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resellerSyncCalls(), 0, 'delivered webhook history is not SMS receipt proof');
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH2');
    assert.equal(a.action, 'classify_only');
    assert.equal(a.outcome, 'no_change');
    assert.notEqual(a.mode, 'A1');
    assert.notEqual(a.action, 'atomic_ota');
    assert.notEqual(a.action, 'resend_online');
    assert.equal(a.evidence.webhook_delivered, true);
    assert.equal(a.evidence.pending_reason, 'sms_receipt_unverified_no_online_notification');
  } finally { h.restore(); }
});

test('6817: Teltik host port read unavailable → defer clearly, no A1 atomic_ota', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['error'] });
  try {
    await runTickViaWorker(h.env);

    assert.equal(h.resellerSyncCalls(), 0, 'no resend until the host port read is usable');
    assert.equal(h.resetPortCalls(), 0, 'no reset when port state is unknown, not known-offline');
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH2');
    assert.equal(a.action, 'classify_only');
    assert.equal(a.outcome, 'no_change');
    assert.equal(a.evidence.pending_reason, 'pending_teltik_host_port_read');
    assert.notEqual(a.mode, 'A1');
    assert.notEqual(a.action, 'atomic_ota');
    assert.equal(h.db.report.auto_remediation_state, 'queued');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (4) First TH5 pass: reset fires immediately, NO in-tick sleep. Attempt
// records recheck pending, next_review_at ~30s out; report requeues with a
// backdated last_auto_attempt_at so intake re-admits it in ~30s, not 15m.
// ---------------------------------------------------------

test('6817: first TH5 pass resets now, defers the recheck ~30s, never sleeps in the tick', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['offline'] });
  h.env.TELTIK_PORT_RECHECK_WAIT_MS = '30000'; // real product delay — must NOT be slept
  try {
    const t0 = Date.now();
    await runTickViaWorker(h.env);
    assert.ok(Date.now() - t0 < 5000, 'tick must not block on the 30s re-register window');

    assert.equal(h.resetPortCalls(), 1, 'reset-port must fire for the offline host port');
    assert.equal(h.portStatusCalls(), 1, 'no same-tick recheck — evidence read only');
    assert.equal(h.resellerSyncCalls(), 0, 'no resend while the host port is down');

    assert.equal(h.db.attempts.length, 1);
    const a = h.db.attempts[0];
    assert.equal(a.mode, 'TH5');
    assert.equal(a.action, 'teltik_reset_port');
    assert.equal(a.outcome, 'no_change');
    assert.equal(a.evidence.issue_type, 'Teltik gateway port offline');
    assert.equal(a.evidence.recheck, 'pending');
    assert.equal(a.evidence.recheck_delay_ms, 30000);
    const nra = new Date(a.next_review_at).getTime();
    assert.ok(nra >= t0 + 25000 && nra <= Date.now() + 35000, 'next_review_at must be ~30s out');

    // Requeued and re-eligible in ~30s: last_auto_attempt_at is backdated to
    // (now - INTAKE_DEFER_MS + 30s), i.e. older than 14 minutes ago but not
    // past the full 15m cutoff.
    assert.equal(h.db.report.status, 'received');
    assert.equal(h.db.report.auto_remediation_state, 'queued');
    const laa = new Date(h.db.report.last_auto_attempt_at).getTime();
    assert.ok(laa < Date.now() - 14 * 60 * 1000, 'must be backdated near the intake cutoff');
    assert.ok(laa > Date.now() - 15 * 60 * 1000, 'must stay ~30s short of eligible');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (4a) Deferred recheck pass, port STILL offline → escalate as Teltik port
// down (NOT deactivated/cancelled — Atomic is active) WITHOUT a second reset.
// ---------------------------------------------------------

test('6817: recheck pass still offline → escalated teltik_gateway_port_offline, no second reset', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['offline', 'offline'] });
  try {
    await runTickViaWorker(h.env); // pass 1: reset + recheck pending (wait 0 → immediately eligible)
    await runTickViaWorker(h.env); // pass 2: deferred recheck

    assert.equal(h.resetPortCalls(), 1, 'reset-port must fire exactly once across both passes');
    assert.equal(h.resellerSyncCalls(), 0, 'no resend while the host port is down');

    assert.equal(h.db.attempts.length, 2);
    const a = h.db.attempts[1];
    assert.equal(a.mode, 'TH5');
    assert.equal(a.action, 'escalate');
    assert.equal(a.outcome, 'escalate');
    assert.equal(a.evidence.issue_type, 'Teltik gateway port offline');
    assert.equal(a.evidence.prior_reset_attempts, 1);

    assert.equal(h.db.report.auto_remediation_state, 'escalated');
    assert.equal(h.db.report.escalation_reason, 'teltik_gateway_port_offline');
    assert.equal(h.db.report.status, 'received', 'escalation is operator-facing; report is not closed');
  } finally { h.restore(); }
});

// ---------------------------------------------------------
// (4b) Deferred recheck pass, port online → NO remediated close off port
// state alone and NO reseller `number.online`; TH2 records that SMS receipt is
// still unverified and leaves the report open.
// ---------------------------------------------------------

test('7182: recheck pass online → TH2 diagnostic, no false remediated closure or online resend', async () => {
  const h = makeHarness({ attStatus: 'active', portStatuses: ['offline', 'online'] });
  try {
    await runTickViaWorker(h.env); // pass 1: reset + recheck pending
    await runTickViaWorker(h.env); // pass 2: port online → TH2 diagnostic

    assert.equal(h.resetPortCalls(), 1, 'no second reset once the port is back online');
    assert.equal(h.resellerSyncCalls(), 0, 'port-online recheck alone must not send number.online');

    assert.equal(h.db.attempts.length, 2);
    assert.equal(h.db.attempts[0].mode, 'TH5');
    assert.equal(h.db.attempts[0].outcome, 'no_change');
    const a = h.db.attempts[1];
    assert.equal(a.mode, 'TH2');
    assert.equal(a.action, 'classify_only');
    assert.notEqual(a.outcome, 'remediated', 'port-online recheck alone must never close the report');
    assert.equal(a.outcome, 'no_change');
    assert.equal(a.evidence.reason, 'teltik_host_sms_unverified');

    assert.equal(h.db.report.status, 'received');
    assert.notEqual(h.db.report.status, 'remediated');
    assert.equal(h.db.report.auto_remediation_state, 'queued');
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
// Source pins: 30s default recheck delay, env-injectable, and NEVER slept
// inside the tick — deferral goes through next_review_at + the backdated
// last_auto_attempt_at intake window.
// ---------------------------------------------------------

test('TH5 recheck delay is 30s by default, env-injectable, and never slept in the tick', () => {
  assert.match(SRC, /const TELTIK_PORT_RECHECK_WAIT_MS = 30_000/);
  assert.match(SRC, /env\.TELTIK_PORT_RECHECK_WAIT_MS !== undefined\n\s*\? Number\(env\.TELTIK_PORT_RECHECK_WAIT_MS\) : TELTIK_PORT_RECHECK_WAIT_MS/);
  assert.ok(!SRC.includes('setTimeout'), 'the remediator worker must not sleep inside a tick');
  assert.match(SRC, /recheck: 'pending'/);
  assert.match(SRC, /intakeEligibleInMs/);
  assert.match(SRC, /Date\.now\(\) - INTAKE_DEFER_MS \+ exec\.intakeEligibleInMs/);
});
