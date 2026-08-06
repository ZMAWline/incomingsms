// t_688c3e93 — operating-loop drain regression.
//
// Proves a single runTick over a mixed batch ADVANCES every eligible report:
// each row ends fixed (remediated/duplicate), truly categorized (escalated
// with a specific reason + suggested next step), or explicitly deferred
// (queued with a concrete next_review_at). No silent stuck states, no false
// escalations from automation limitations (Teltik-hosted lines have no
// Skyline nonce path; a missing MDN is a read failure, not "port offline").
//
// Batch cases: stale in_progress recovery, Teltik-hosted Atomic online-port
// (remediated via host-aware verification), Teltik offline-port (reset →
// still offline → categorized), missing-MDN (deferred, not escalated),
// cooldown (deferred until the precise nextEligibleAt), unable-to-reproduce
// exhaustion, vendor-read-failure exhaustion (own category, not UTR),
// operator-requeued false escalation (fresh attempt budget → vendor action
// re-fires), duplicate close, Wing wrong-plan (SMS-disabled) → verify_pending,
// and skipped_cooldown-only history NOT escalating prematurely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/bad-rental-remediator/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const H = 60 * 60 * 1000;
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

const ABIR_PLAN = 'Wing Tel Inc - ABIR 25Mbps SMS MO/MT US';

// ---------------------------------------------------------------------------
// Scenario data
// ---------------------------------------------------------------------------

function makeReport(id, simId, rentalId, e164) {
  return {
    id, reseller_id: 'rs1', sim_id: simId, sim_number_id: null,
    rental_id: rentalId, e164, status: 'received',
    received_at: iso(NOW - 6 * H), auto_remediation_state: null,
  };
}

const SIMS = {
  1: { id: 1, iccid: '89A1', vendor: 'atomic', gateway_host: 'teltik',  status: 'active', msisdn: '3075550001', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  2: { id: 2, iccid: '89B2', vendor: 'teltik', gateway_host: 'teltik',  status: 'active', msisdn: '3075550002', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  3: { id: 3, iccid: '89C3', vendor: 'teltik', gateway_host: 'teltik',  status: 'active', msisdn: null,         activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  4: { id: 4, iccid: '89D4', vendor: 'atomic', gateway_host: 'skyline', status: 'active', msisdn: '3075550004', activated_at: null, gateway_id: 'gw1', port: 3,    imei: null, att_ban: null, mobility_subscription_id: null },
  5: { id: 5, iccid: '89E5', vendor: 'atomic', gateway_host: 'skyline', status: 'active', msisdn: '3075550005', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  6: { id: 6, iccid: '89F6', vendor: 'atomic', gateway_host: 'skyline', status: 'active', msisdn: '3075550006', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  7: { id: 7, iccid: '89G7', vendor: 'atomic', gateway_host: 'teltik',  status: 'active', msisdn: '3075550007', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  8: { id: 8, iccid: '89H8', vendor: 'atomic', gateway_host: 'skyline', status: 'active', msisdn: '3075550008', activated_at: null, gateway_id: null,  port: null, imei: null, att_ban: null, mobility_subscription_id: null },
  9: { id: 9, iccid: '89I9', vendor: 'wing_iot', gateway_host: 'skyline', status: 'active', msisdn: '3075550009', activated_at: null, gateway_id: 'gw2', port: 5, imei: null, att_ban: null, mobility_subscription_id: null },
  10:{ id: 10, iccid: '89J0', vendor: 'atomic', gateway_host: 'skyline', status: 'active', msisdn: '3075550010', activated_at: null, gateway_id: null, port: null, imei: null, att_ban: null, mobility_subscription_id: null },
};

const REPORTS = [
  makeReport(101, 1, 1001, '+13075550001'), // Teltik-hosted Atomic, port online → remediated
  makeReport(102, 2, 1002, '+13075550002'), // Teltik port offline → reset → still offline → categorized
  makeReport(103, 3, 1003, null),           // missing MDN → deferred (read failure, NOT port offline)
  makeReport(104, 4, 1004, '+13075550004'), // resend_online in cooldown → deferred until nextEligibleAt
  makeReport(105, 5, 1005, '+13075550005'), // 3 real classify_only → unable_to_reproduce escalation
  makeReport(106, 6, 1006, '+13075550006'), // vendor read fails ×3 → vendor_read_failed escalation
  makeReport(107, 7, 1007, '+13075550007'), // requeued false escalation → fresh budget → restore re-fires
  makeReport(108, 8, 1008, '+13075550008'), // newer open report → duplicate close
  makeReport(109, 9, 1009, '+13075550009'), // Wing ABIR (SMS-disabled plan) → put dialable → verify_pending
  makeReport(110, 10, 1010, '+13075550010'),// only skipped_cooldown history → NOT escalated (fresh real look)
];

const ATTEMPTS = {
  104: [
    { id: 41, action: 'resend_online', outcome: 'no_change', attempted_at: iso(NOW - 30 * 60 * 1000) },
  ],
  105: [
    { id: 53, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 3 * H) },
    { id: 52, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 6 * H) },
    { id: 51, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 9 * H) },
  ],
  106: [
    { id: 63, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 3 * H) },
    { id: 62, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 6 * H) },
    { id: 61, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 9 * H) },
  ],
  107: [
    // Newest first: the operator_requeue marker hides the older failed
    // attempts from the per-action caps (fresh budget after a bug fix).
    { id: 72, action: 'operator_requeue', outcome: 'requeued', attempted_at: iso(NOW - 10 * 60 * 1000) },
    { id: 71, action: 'atomic_restore',   outcome: 'failed',   attempted_at: iso(NOW - 2 * 24 * H) },
  ],
  110: [
    { id: 92, action: 'classify_only', outcome: 'skipped_cooldown', attempted_at: iso(NOW - 10 * 60 * 1000) },
    { id: 91, action: 'classify_only', outcome: 'skipped_cooldown', attempted_at: iso(NOW - 20 * 60 * 1000) },
  ],
};

// sim_id → webhook delivered?
const WEBHOOK_DELIVERED = new Set([1, 5, 6, 7, 8, 9, 10]);
// sim_id → latest inbound to_number (Teltik-known MDN)
const INBOUND = { 1: '3075550001', 2: '3075550002', 7: '3075550007' };
// mdn10 → teltik port state
const PORT_STATE = { 3075550001: 'online', 3075550002: 'offline', 3075550007: 'online' };
// iccid → atomic view
const ATOMIC = {
  '89A1': { statusCode: '00', attStatus: 'ACTIVE',    msisdn: '3075550001' },
  '89D4': { statusCode: '00', attStatus: 'ACTIVE',    msisdn: '3075550004' },
  '89E5': { statusCode: '00', attStatus: 'PENDING',   msisdn: '3075550005' },
  '89F6': { statusCode: '99', description: 'backend exploded' },
  '89G7': { statusCode: '00', attStatus: 'SUSPENDED', msisdn: '3075550007' },
  '89H8': { statusCode: '00', attStatus: 'ACTIVE',    msisdn: '3075550008' },
  '89J0': { statusCode: '00', attStatus: 'PENDING',   msisdn: '3075550010' },
};

// ---------------------------------------------------------------------------
// Fetch stub — minimal PostgREST + vendor router with write recording.
// ---------------------------------------------------------------------------

function jsonResp(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function buildHarness() {
  const writes = { patches: {}, attempts: [], events: [], escalations: [], calls: [] };
  let escId = 0;

  function recordPatch(reportId, body) {
    (writes.patches[reportId] ||= []).push(body);
  }

  const fetchStub = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const bodyRaw = (init && init.body) || null;
    writes.calls.push({ method, url, body: bodyRaw });
    const q = (name, re) => { const m = url.match(re); return m ? m[1] : null; };

    // ---- Supabase ----
    if (url.includes('/rest/v1/')) {
      if (method === 'PATCH' && url.includes('rental_reports?auto_remediation_state=eq.in_progress')) {
        return jsonResp([{ id: 900 }]); // stale claim recovered
      }
      if (method === 'PATCH' && url.includes('/rest/v1/rental_reports?id=eq.')) {
        const id = q('id', /id=eq\.(\d+)/);
        if (url.includes('&or=')) {
          // CAS claim — count via Content-Range
          return new Response(null, { status: 200, headers: { 'Content-Range': '0-0/1' } });
        }
        recordPatch(id, JSON.parse(bodyRaw));
        return jsonResp({});
      }
      if (method === 'GET' && url.includes('rental_reports?status=in.')) {
        return jsonResp(REPORTS);
      }
      if (method === 'GET' && url.includes('rental_reports?sim_id=eq.')) {
        const simId = Number(q('sim', /sim_id=eq\.(\d+)/));
        return jsonResp(simId === 8 ? [{ id: 200 }] : []); // newer open report only for R108
      }
      if (method === 'GET' && url.includes('rental_reports?id=eq.')) {
        const id = Number(q('id', /id=eq\.(\d+)/));
        return jsonResp([{ id, status: 'received', triaged_at: null, closed_at: null }]);
      }
      if (method === 'GET' && url.includes('/rest/v1/sims?id=eq.')) {
        const simId = Number(q('id', /id=eq\.(\d+)/));
        return jsonResp(SIMS[simId] ? [SIMS[simId]] : []);
      }
      if (method === 'GET' && url.includes('/rest/v1/rentals?id=eq.')) {
        const rid = Number(q('id', /id=eq\.(\d+)/));
        return jsonResp([{ id: rid, sim_id: rid - 1000, reseller_id: 'rs1', reseller_rental_id: 'RR-' + rid, rental_date: '2026-07-01', minted_at: iso(NOW - 30 * 24 * H) }]);
      }
      if (method === 'GET' && url.includes('/rest/v1/rentals?sim_id=eq.')) {
        const simId = Number(q('sim', /sim_id=eq\.(\d+)/));
        return jsonResp([{ id: 1000 + simId, reseller_rental_id: 'RR-' + (1000 + simId), rental_date: '2026-07-01', minted_at: iso(NOW - 30 * 24 * H) }]);
      }
      if (method === 'GET' && url.includes('/rest/v1/rentals?reseller_id=eq.')) {
        return jsonResp([]);
      }
      if (method === 'GET' && url.includes('/rest/v1/sim_numbers?')) {
        return jsonResp([]);
      }
      if (method === 'GET' && url.includes('rental_report_remediation_attempts?report_id=eq.')) {
        const rid = Number(q('rid', /report_id=eq\.(\d+)/));
        return jsonResp(ATTEMPTS[rid] || []);
      }
      if (method === 'POST' && url.includes('rental_report_remediation_attempts')) {
        writes.attempts.push(JSON.parse(bodyRaw));
        return jsonResp({}, 201);
      }
      if (method === 'GET' && url.includes('webhook_deliveries')) {
        const simId = Number(q('sim', /sim_id=eq\.(\d+)/));
        return jsonResp(WEBHOOK_DELIVERED.has(simId) ? [{ delivered_at: iso(NOW - 2 * H) }] : []);
      }
      if (method === 'GET' && url.includes('inbound_sms?sim_id=eq.')) {
        const simId = Number(q('sim', /sim_id=eq\.(\d+)/));
        return jsonResp(INBOUND[simId] ? [{ to_number: INBOUND[simId], received_at: iso(NOW - 1 * H) }] : []);
      }
      if (method === 'POST' && url.includes('rental_report_events')) {
        writes.events.push(JSON.parse(bodyRaw));
        return jsonResp({}, 201);
      }
      if (method === 'POST' && url.includes('operator_escalations')) {
        const row = JSON.parse(bodyRaw);
        writes.escalations.push(row);
        return jsonResp([{ id: ++escId, ...row }], 201);
      }
      if (method === 'PATCH' && url.includes('operator_escalations')) return jsonResp({});
      if (method === 'POST' && url.includes('pending_review_items')) return jsonResp({}, 201);
      return jsonResp([]);
    }

    // ---- Vendors ----
    if (url.includes('telgoo5.com')) {
      const body = JSON.parse(bodyRaw);
      const reqW = body.wholeSaleApi.wholeSaleRequest;
      if (reqW.requestType === 'subsriberInquiry') {
        const v = ATOMIC[reqW.sim] || null;
        if (!v) return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '01', description: 'subscriber not found' } } });
        if (v.statusCode !== '00') return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: v.statusCode, description: v.description } } });
        return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', Result: { attStatus: v.attStatus, MSISDN: v.msisdn } } } });
      }
      // resendOtaProfile / restoreSubscriber → success
      return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', partnerTransactionId: 'ptx-' + reqW.requestType } } });
    }
    if (url.includes('api.smsgateway.xyz/v1/get-info')) {
      const mdn = q('mdn', /mdn=(\d+)/);
      return jsonResp({ line_state: 'active', iccid: mdn === '3075550002' ? '89B2' : '89XX' });
    }
    if (url.includes('api.smsgateway.xyz/v1/port-status')) {
      const mdn = q('mdn', /mdn=(\d+)/);
      return jsonResp({ port_status: PORT_STATE[mdn] || 'offline' });
    }
    if (url.includes('api.smsgateway.xyz/v1/reset-port') || url.includes('api.smsgateway.xyz/v1/reset-network')) {
      return jsonResp({ ok: true, request_id: 'treq-1' });
    }
    if (url.includes('restapi19.att.com')) {
      if (method === 'PUT') return jsonResp({ requestId: 'wing-put-1' });
      return jsonResp({ status: 'ACTIVATED', communicationPlan: ABIR_PLAN, mdn: '3075550009' });
    }
    return jsonResp({});
  };

  const KV = {
    async get(key) { return key === 'bad_rental_remediator_enabled' ? 'true' : null; },
    async put() {}, async delete() {},
  };
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
    ADMIN_RUN_SECRET: 'sec',
    TELTIK_API_KEY: 'tk',
    ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p',
    WING_IOT_USERNAME: 'wu', WING_IOT_API_KEY: 'wk',
    SKYLINE_SECRET: 'sk',
    SKYLINE_GATEWAY: {
      async fetch(req) {
        const u = String(req.url || req);
        if (u.includes('/send-sms')) return jsonResp({ request_id: 'sky-1' });
        return jsonResp({ status: 'online' });
      },
    },
    RESELLER_SYNC: {
      async fetch() { return jsonResp({ ok: true, status: 'sent', attempts: 1 }); },
    },
    REMEDIATOR_KV: KV,
  };
  return { fetchStub, env, writes };
}

function lastPatch(writes, reportId, pred = () => true) {
  const arr = writes.patches[String(reportId)] || [];
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return null;
}

// ---------------------------------------------------------------------------

test('runTick drains a mixed batch: every eligible report fixed, categorized, or explicitly deferred', async () => {
  const orig = globalThis.fetch;
  const { fetchStub, env, writes } = buildHarness();
  globalThis.fetch = fetchStub;
  let result;
  try {
    const resp = await worker.fetch(new Request('https://r/run?secret=sec'), env);
    const out = await resp.json();
    assert.equal(out.ok, true);
    result = out.result;
  } finally {
    globalThis.fetch = orig;
  }

  // Stale in_progress claim recovered before intake.
  assert.equal(result.stale_recovered, 1);
  assert.equal(result.processed, REPORTS.length);

  // Intake eligibility query carries the next_review_at gate and only
  // null/queued states (escalated & verify_pending rows are not re-fetched).
  const intake = writes.calls.find(c => c.method === 'GET' && c.url.includes('rental_reports?status=in.') && c.url.includes('next_review_at'));
  assert.ok(intake, 'intake query includes next_review_at gate');
  assert.match(intake.url, /next_review_at\.is\.null,next_review_at\.lte\./);
  assert.match(intake.url, /auto_remediation_state\.is\.null,auto_remediation_state\.eq\.queued/);

  // R101 — Teltik-hosted Atomic with Atomic ACTIVE, host port online AND an
  // inbound SMS on the canonical number inside the report window. All three
  // HE1 evidence classes hold, so the report is a healthy-but-noisy complaint:
  // it closes `remediated` on proof (HE1) instead of firing the TH2
  // number.online resend first and sitting queued for SMS verification.
  const p101 = lastPatch(writes, 101, p => p.auto_remediation_state);
  assert.equal(p101.auto_remediation_state, 'done');
  const a101 = writes.attempts.find(a => a.report_id === 101);
  assert.ok(a101, 'an attempt row was written for 101');
  assert.equal(a101.mode, 'HE1');
  assert.equal(a101.action, 'healthy_evidence_auto_resolve');
  assert.equal(a101.outcome, 'healthy_evidence_auto_resolved');
  assert.equal(a101.evidence.resolution_reason, 'confirmed_working');
  // Provider and host stay SEPARATE facts on the evidence: Atomic is the
  // service provider, Teltik is only the gateway host.
  assert.equal(a101.evidence.healthy_evidence.provider.vendor, 'atomic');
  assert.equal(a101.evidence.healthy_evidence.host.host, 'teltik');
  assert.equal(a101.evidence.healthy_evidence.usage.ok, true);
  // §3: no blind resend before proof, and the post-proof notification is off
  // by default — nothing was sent at this line at all.
  assert.equal(a101.evidence.post_proof_notification.skipped, 'disabled');
  assert.ok(!writes.attempts.some(a => a.report_id === 101 && a.action === 'resend_online'),
    'HE1 closes on proof; no resend_online fires ahead of it');
  assert.ok(!writes.attempts.some(a => a.report_id === 101 && a.outcome === 'verify_send_failed'),
    'no false verify_send_failed for Teltik-hosted line');
  // The report row itself is the DB-constrained terminal close shape.
  const close101 = lastPatch(writes, 101, p => p.status === 'remediated');
  assert.ok(close101, 'report 101 closed remediated');
  assert.equal(close101.remediation_action, 'other',
    'remediation_action is CHECK-constrained; the explicit reason rides the attempt/event');
  assert.ok(writes.events.some(e => e.report_id === 101
    && e.to_status === 'remediated'
    && e.evidence && e.evidence.action === 'healthy_evidence_auto_resolved'
    && e.evidence.resolution_reason === 'confirmed_working'));

  // R102 — port offline: reset-port fired with the Teltik-known MDN, then
  // the nonblocking PR #34 path defers the port recheck instead of sleeping or
  // claiming terminal remediation.
  const reset102 = writes.calls.find(c => c.url.includes('/v1/reset-port') && c.url.includes('mdn=3075550002'));
  assert.ok(reset102, 'reset-port fired for 102');
  const p102 = lastPatch(writes, 102, p => p.auto_remediation_state);
  assert.equal(p102.auto_remediation_state, 'queued');
  assert.ok(p102.next_review_at, 'port-reset report deferred for recheck');
  assert.equal(p102.issue_type, 'Teltik gateway port offline');

  // R103 — missing MDN: no port probe fired for a null MDN, NOT escalated as
  // offline; deferred with a concrete next_review_at (read failure ≠ offline).
  const p103 = lastPatch(writes, 103, p => p.auto_remediation_state);
  assert.equal(p103.auto_remediation_state, 'queued');
  assert.ok(p103.next_review_at, 'deferred with next_review_at');
  assert.notEqual(p103.issue_type, 'Teltik gateway port offline');

  // R104 — with SMS temporarily disabled, the resend path is skipped without
  // burning retry budget or falsely escalating.
  const a104 = writes.attempts.find(a => a.report_id === 104);
  assert.equal(a104.outcome, 'skipped_sms_unavailable');
  const p104 = lastPatch(writes, 104, p => p.auto_remediation_state);
  assert.equal(p104.auto_remediation_state, 'queued');

  // R105 — three real classify_only looks exhausted → unable_to_reproduce.
  const p105 = lastPatch(writes, 105, p => p.auto_remediation_state);
  assert.equal(p105.auto_remediation_state, 'escalated');
  assert.equal(p105.escalation_reason, 'unable_to_reproduce_recommendation');

  // R106 — vendor read kept failing → its own category, NOT unable_to_reproduce.
  const p106 = lastPatch(writes, 106, p => p.auto_remediation_state);
  assert.equal(p106.auto_remediation_state, 'escalated');
  assert.equal(p106.escalation_reason, 'vendor_read_failed');

  // R107 — operator requeue marker grants a fresh budget: it must not
  // instantly re-escalate on max_attempts_reached.
  const p107 = lastPatch(writes, 107, p => p.auto_remediation_state);
  assert.equal(p107.auto_remediation_state, 'queued');
  assert.ok(p107.next_review_at, 'requeued report deferred, not stuck');
  assert.ok(!writes.attempts.some(a => a.report_id === 107 && a.evidence && a.evidence.cooldown_gate
    && a.evidence.cooldown_gate.reason === 'max_attempts_reached'),
    'no max_attempts re-escalation after requeue');

  // R108 — newer open report → duplicate close mirrored to done.
  const dup108 = lastPatch(writes, 108, p => p.status === 'duplicate');
  assert.ok(dup108, 'duplicate close written');
  const p108 = lastPatch(writes, 108, p => p.auto_remediation_state);
  assert.equal(p108.auto_remediation_state, 'done');

  // R109 — Wing on the SMS-disabled ABIR plan: does not start nonce verify;
  // it records SMS unavailable and remains queued for later.
  const p109 = lastPatch(writes, 109, p => p.auto_remediation_state);
  assert.equal(p109.auto_remediation_state, 'queued');
  assert.ok(writes.attempts.some(a => a.report_id === 109 && a.outcome === 'skipped_sms_unavailable'));

  // R110 — history is ONLY skipped_cooldown bookkeeping: this is the first
  // real look, so no premature unable_to_reproduce escalation.
  const p110 = lastPatch(writes, 110, p => p.auto_remediation_state);
  assert.equal(p110.auto_remediation_state, 'queued');
  assert.ok(p110.next_review_at, 'fresh report deferred to its classify cadence');
  assert.ok(!(writes.patches['110'] || []).some(p => p.auto_remediation_state === 'escalated'),
    'skipped_cooldown rows must not trigger escalation');

  // Escalation batches: exactly the three true categorizations, each grouped
  // by (vendor, failure_type).
  const escKeys = writes.escalations.map(e => e.vendor + '|' + e.failure_type).sort();
  assert.deepEqual(escKeys, [
    'atomic|unable_to_reproduce_recommendation',
    'atomic|vendor_read_failed',
  ]);

  // Drain invariant: EVERY report in the batch advanced — terminal state, or
  // queued with a concrete next_review_at, or verify_pending.
  for (const r of REPORTS) {
    const patches = writes.patches[String(r.id)] || [];
    const final = patches[patches.length - 1];
    assert.ok(final, 'report ' + r.id + ' got a state write');
    const st = final.auto_remediation_state;
    if (st === 'queued') {
      assert.ok(final.next_review_at, 'report ' + r.id + ' queued without next_review_at');
    } else {
      assert.ok(['done', 'escalated', 'verify_pending'].includes(st),
        'report ' + r.id + ' unexpected state ' + st);
    }
    if (st === 'escalated') {
      assert.ok(final.escalation_reason, 'report ' + r.id + ' escalated without a reason');
    }
  }
});

// ---------------------------------------------------------------------------
// Dashboard wiring — requeue endpoint + deferral surfacing exist.
// ---------------------------------------------------------------------------

test('dashboard exposes rerun-auto endpoint, marker insert, and next_review_at', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
  assert.match(dash, /\/api\/bad-rentals\/'\.length, -\('\/rerun-auto'/);
  assert.match(dash, /handleBadRentalRerunAuto/);
  assert.match(dash, /operator_requeue/);
  assert.match(dash, /next_review_at:\s*null/);

  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');
  assert.match(html, /badRentalsRerunAuto/);
  assert.match(html, /Rerun auto/);
});

test('verify poll releases verify_pending rows that lost their nonce', async () => {
  const orig = globalThis.fetch;
  const patches = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if ((init.method || 'GET') === 'GET' && u.includes('auto_remediation_state=eq.verify_pending')) {
      return jsonResp([{ id: 501, sim_id: 1, e164: '+13075550001', status: 'received', verify_pending_nonce: null, verify_pending_sent_at: null }]);
    }
    if ((init.method || 'GET') === 'PATCH' && u.includes('rental_reports?id=eq.501')) {
      patches.push(JSON.parse(init.body));
      return jsonResp({});
    }
    return jsonResp([]);
  };
  try {
    const { runVerifyPoll } = await import('../src/bad-rental-remediator/verify-runner.mjs');
    const out = await runVerifyPoll({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srk' });
    assert.equal(out.polled, 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].auto_remediation_state, 'queued');
  } finally {
    globalThis.fetch = orig;
  }
});
