// Bad-rental lifecycle regression harness (t_688c3e93 follow-up patches A–F).
//
// Root cause covered: attempt-cap exhaustion had no terminal path — reports
// bounced queued → skipped_cooldown forever ("bad rental reviews never
// auto-resolve") — and skipped_cooldown bookkeeping rows inflated per-action
// attempt counts. Also covers the Teltik-hosted stale-MDN path: Teltik keys
// port-status/reset by the MDN it last saw (latest inbound_sms.to_number),
// not the provider-side sims.msisdn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maybeExecuteAction,
  gatherEvidence,
  suggestNextAction,
} from '../src/bad-rental-remediator/index.js';
import { normalizeFailureType } from '../src/bad-rental-remediator/escalations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'),
  'utf8'
);

const KV = { async get() { return null; }, async put() {} };

// Route stubbed fetch by URL substring; records every call.
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  return calls;
}

// ---- positive resolution ------------------------------------------------

test('TH5: reset-port succeeds → defers nonblocking port recheck, not terminally remediated', async () => {
  const orig = globalThis.fetch;
  const calls = stubFetch([
    ['/v1/reset-port', { ok: true, request_id: 'req-9' }],
    ['/v1/port-status', { port_status: 'online' }],
  ]);
  try {
    const exec = await maybeExecuteAction(
      { TELTIK_API_KEY: 'k', REMEDIATOR_KV: KV },
      {
        report: { id: 1 },
        evidence: {
          sim: { id: 7, current_mdn_e164: '+13075551111' },
          teltikMdn: null,
          priorActionAttempts: {},
          lastActionAttemptAt: {},
        },
        classification: { mode: 'TH5', action: 'teltik_reset_port', outcome: 'classify_only', evidenceSummary: {} },
        attemptNo: 1,
      });
    assert.equal(exec.outcome, 'no_change');
    assert.equal(exec.execStatus, 'ok');
    assert.equal(exec.escalationReason, null);
    assert.ok(exec.nextReviewAt, 'reset schedules deferred recheck');
    assert.equal(exec.evidence.recheck, 'pending');
    assert.ok(calls.some(u => u.includes('/v1/reset-port') && u.includes('mdn=3075551111')));
  } finally {
    globalThis.fetch = orig;
  }
});

// ---- unresolved escalation ----------------------------------------------

test('TH5: first reset succeeds but port still offline → defers before later escalation', async () => {
  const orig = globalThis.fetch;
  stubFetch([
    ['/v1/reset-port', { ok: true, request_id: 'req-10' }],
    ['/v1/port-status', { port_status: 'offline' }],
  ]);
  try {
    const exec = await maybeExecuteAction(
      { TELTIK_API_KEY: 'k', REMEDIATOR_KV: KV },
      {
        report: { id: 2 },
        evidence: {
          sim: { id: 8, current_mdn_e164: '+13075551111' },
          teltikMdn: null,
          priorActionAttempts: {},
          lastActionAttemptAt: {},
        },
        classification: { mode: 'TH5', action: 'teltik_reset_port', outcome: 'classify_only', evidenceSummary: {} },
        attemptNo: 1,
      });
    assert.equal(exec.outcome, 'no_change');
    assert.equal(exec.escalationReason, null);
    assert.ok(exec.nextReviewAt, 'first reset schedules deferred recheck');
  } finally {
    globalThis.fetch = orig;
  }
});

test('max_attempts_reached escalates terminally instead of re-queuing forever', async () => {
  const exec = await maybeExecuteAction({}, {
    report: { id: 3 },
    evidence: {
      sim: { id: 9 },
      priorActionAttempts: { teltik_reset_port: 1 }, // cap for this action is 1
      lastActionAttemptAt: {},
    },
    classification: { mode: 'TH5', action: 'teltik_reset_port', outcome: 'classify_only' },
    attemptNo: 2,
  });
  assert.equal(exec.outcome, 'escalate');
  assert.equal(exec.execStatus, 'max_attempts_reached');
  assert.equal(exec.escalationReason, 'teltik_reset_port_failed');
  // …and the reason lands in a real §H.3 batch bucket, not free-form.
  assert.equal(normalizeFailureType(exec.escalationReason), 'teltik_reset_failed');
});

test('classify_only exhaustion emits unable_to_reproduce_recommendation', async () => {
  const exec = await maybeExecuteAction({}, {
    report: { id: 4 },
    evidence: {
      sim: { id: 10 },
      priorActionAttempts: { classify_only: 3 },
      lastActionAttemptAt: {},
    },
    classification: { mode: 'S5', action: 'classify_only', outcome: 'no_change' },
    attemptNo: 4,
  });
  assert.equal(exec.outcome, 'escalate');
  assert.equal(exec.escalationReason, 'unable_to_reproduce_recommendation');
  assert.equal(normalizeFailureType(exec.escalationReason), 'unable_to_reproduce_recommendation');
});

test('active cooldown (not cap) still yields non-terminal skipped_cooldown', async () => {
  const exec = await maybeExecuteAction({}, {
    report: { id: 5 },
    evidence: {
      sim: { id: 11, gateway_host: 'teltik' },
      teltikHostPortStatus: { online: true, status: 200 },
      priorActionAttempts: { resend_online: 1 }, // cap 2, 1h cooldown
      lastActionAttemptAt: { resend_online: new Date(Date.now() - 60_000).toISOString() },
    },
    classification: { mode: 'TH2', action: 'resend_online', outcome: 'classify_only' },
    attemptNo: 2,
  });
  assert.equal(exec.outcome, 'skipped_cooldown');
  assert.equal(exec.execStatus, 'cooldown_active');
});

// ---- evidence gathering: attempt counting + Teltik-known MDN -------------

const SIM_ROW = {
  id: 42, iccid: '8901000', vendor: null, gateway_host: 'teltik', status: 'active',
  msisdn: '3075551111', activated_at: null, gateway_id: null, port: null,
  imei: null, att_ban: null, mobility_subscription_id: null,
};

const ATTEMPT_ROWS = [
  { id: 3, action: 'teltik_reset_port', outcome: 'skipped_cooldown', attempted_at: '2026-07-28T10:00:00Z' },
  { id: 2, action: 'teltik_reset_port', outcome: 'failed',           attempted_at: '2026-07-27T10:00:00Z' },
  { id: 1, action: 'classify_only',     outcome: 'no_change',        attempted_at: '2026-07-26T10:00:00Z' },
];

test('Teltik-hosted stale-MDN: port read keys on latest raw SMS payload MDN, and skipped_cooldown rows do not count as attempts', async () => {
  const orig = globalThis.fetch;
  const calls = stubFetch([
    ['/rest/v1/sims?', [SIM_ROW]],
    ['/rest/v1/rental_report_remediation_attempts', ATTEMPT_ROWS],
    ['/rest/v1/inbound_sms', [{
      to_number: '3075552222', // canonical/customer number; not the Teltik API key
      raw: { destination: '3075559999' },
      received_at: '2026-07-27T12:00:00Z',
    }]],
    ['/v1/port-status', { port_status: 'offline' }],
  ]);
  try {
    const evidence = await gatherEvidence(
      { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srk', TELTIK_API_KEY: 'k' },
      { id: 101, sim_id: 42 });

    // Patch C/D — raw Teltik payload MDN wins over stale sims.msisdn and canonical to_number.
    assert.equal(evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn, '3075559999');
    const portCall = calls.find(u => u.includes('/v1/port-status'));
    assert.ok(portCall, 'port-status probe fired');
    assert.match(portCall, /mdn=3075559999/);
    assert.doesNotMatch(portCall, /3075552222/);
    assert.doesNotMatch(portCall, /3075551111/);
    assert.equal(evidence.teltikHostPortStatus.online, false);

    // Patch B — skipped_cooldown excluded from per-action counts and cooldown clock.
    assert.equal(evidence.priorAttempts, 3); // attempt_no keeps counting all rows
    assert.equal(evidence.priorActionAttempts.teltik_reset_port, 1);
    assert.equal(evidence.priorActionAttempts.classify_only, 1);
    assert.equal(evidence.lastActionAttemptAt.teltik_reset_port, '2026-07-27T10:00:00Z');
  } finally {
    globalThis.fetch = orig;
  }
});

test('non-Teltik-hosted SIM: no inbound_sms lookup, no Teltik port probe', async () => {
  const orig = globalThis.fetch;
  const calls = stubFetch([
    ['/rest/v1/sims?', [{ ...SIM_ROW, gateway_host: 'skyline' }]],
  ]);
  try {
    const evidence = await gatherEvidence(
      { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srk', TELTIK_API_KEY: 'k' },
      { id: 102, sim_id: 42 });
    assert.equal(evidence.teltikKnownMdn, null);
    assert.equal(evidence.teltikHostPortStatus, null);
    assert.ok(!calls.some(u => u.includes('inbound_sms')));
    assert.ok(!calls.some(u => u.includes('port-status')));
  } finally {
    globalThis.fetch = orig;
  }
});

// ---- operator-facing next step ------------------------------------------

test('suggestNextAction covers teltik_gateway_port_offline (no generic fallback)', () => {
  const s = suggestNextAction('teltik_gateway_port_offline');
  assert.notEqual(s, 'Operator review required.');
  assert.match(s, /Teltik/);
});

test('dashboard sub-row surfaces escalation reason', () => {
  assert.match(DASHBOARD_HTML, /escalation_reason/);
});
