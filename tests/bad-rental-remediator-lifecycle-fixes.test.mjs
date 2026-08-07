// BRR-FIX-SPEC.md — regression tests for R1/R2/R3/R4/R5/R7/R8.
//
// Each test builds its own minimal fetch stub (mirroring the pattern in
// tests/bad-rental-remediator-teltik-host-port-flow.test.mjs) so scenarios
// stay independent and easy to reason about.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/bad-rental-remediator/index.js';

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const H = 60 * 60 * 1000;

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function baseEnv(overrides = {}) {
  const kvStore = { bad_rental_remediator_enabled: 'true' };
  return {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    ADMIN_RUN_SECRET: 's',
    TELTIK_API_KEY: 'tk',
    ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p',
    ATOMIC_API_URL: 'https://atomic.test',
    REMEDIATOR_KV: {
      async get(k) { return kvStore[k] === undefined ? null : kvStore[k]; },
      async put(k, v) { kvStore[k] = v; },
      async delete(k) { delete kvStore[k]; },
    },
    RESELLER_SYNC: { async fetch() { return jsonResp({ ok: true, status: 'sent' }); } },
    ...overrides,
  };
}

async function runTickViaWorker(env) {
  const resp = await worker.fetch(new Request('https://w/run?secret=s'), env);
  const body = await resp.json();
  assert.equal(body.ok, true);
  return body.result;
}

// ---------------------------------------------------------------------------
// R1 — TH2/S5 distinct exhaustion + escalation, R4 — escalate audit event.
// ---------------------------------------------------------------------------

test('R1: TH2 pending host-port-read exhausts after 2 classify_only looks -> distinct escalate + audit event', async () => {
  const report = {
    id: 9001, status: 'received', received_at: iso(NOW - 2 * H), sim_id: 'sim-9001',
    sim_number_id: null, rental_id: 'r-9001', reseller_id: 'rs-1', e164: '+15550009001',
    auto_remediation_state: null, last_auto_attempt_at: null, reason_code: 'no_sms_received', attempts: 5,
  };
  const sim = {
    id: 'sim-9001', iccid: '890141000009001', vendor: 'atomic', gateway_host: 'teltik',
    status: 'active', msisdn: '5559009001', gateway_id: null, port: null,
  };
  const rental = {
    id: 'r-9001', sim_id: 'sim-9001', reseller_id: 'rs-1', reseller_rental_id: 'rr-9001',
    rental_date: '2026-07-01', minted_at: iso(NOW - 10 * 24 * H),
  };
  // Two PRIOR classify_only attempts already recorded for this report.
  const priorAttempts = [
    { id: 1, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 4 * H) },
    { id: 2, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 3 * H) },
  ];
  const events = [];

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    // Teltik port-status always errors -> port read never usable -> TH2 pending.
    if (u.includes('api.smsgateway.xyz/v1/port-status')) return jsonResp({ success: false }, 500);
    if (u.startsWith('https://atomic.test')) {
      return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', Result: { attStatus: 'active', MSISDN: '5559009001' } } } });
    }
    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const cutoff = iso(NOW - 15 * 60 * 1000);
      const open = (report.status === 'received') && (report.auto_remediation_state == null || report.auto_remediation_state === 'queued')
        && (report.last_auto_attempt_at == null || report.last_auto_attempt_at < cutoff);
      return jsonResp(open ? [report] : []);
    }
    if (u.includes('/rental_reports?sim_id=eq.')) return jsonResp([]);
    if (u.includes('/webhook_deliveries?')) return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress')) return jsonResp([]);
    if (u.includes('/rental_reports?id=eq.9001')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = report.auto_remediation_state == null || report.auto_remediation_state === 'queued';
          if (claimable) Object.assign(report, body);
          return new Response(null, { status: 204, headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' } });
        }
        Object.assign(report, body);
        return jsonResp([]);
      }
      return jsonResp([report]);
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') return jsonResp({}, 201);
      return jsonResp(priorAttempts);
    }
    if (u.includes('/rental_report_events') && method === 'POST') {
      events.push(JSON.parse(init.body));
      return jsonResp({}, 201);
    }
    if (u.includes('/sims?id=eq.')) return jsonResp([sim]);
    if (u.includes('/rentals?id=eq.')) return jsonResp([rental]);
    if (u.includes('pending_review_items')) return jsonResp([]);
    if (u.includes('operator_escalations')) {
      if (method === 'POST') return jsonResp([{ id: 1 }], 201);
      return jsonResp([]);
    }
    return jsonResp([]);
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await runTickViaWorker(baseEnv());
    assert.equal(report.auto_remediation_state, 'escalated');
    assert.equal(report.escalation_reason, 'teltik_host_port_read_failed');
    assert.ok(events.some(e => e.report_id === 9001
      && e.evidence && e.evidence.auto_remediation_state_to === 'escalated'
      && e.evidence.escalation_reason === 'teltik_host_port_read_failed'),
      'escalate transition wrote a rental_report_events row (R4)');
  } finally { globalThis.fetch = orig; }
});

test('R1: S5 gateway-port-offline exhausts after 2 classify_only looks -> gateway_port_offline_unresolved', async () => {
  const report = {
    id: 9002, status: 'received', received_at: iso(NOW - 2 * H), sim_id: 'sim-9002',
    sim_number_id: null, rental_id: 'r-9002', reseller_id: 'rs-1', e164: '+15550009002',
    auto_remediation_state: null, last_auto_attempt_at: null, reason_code: 'no_sms_received', attempts: 5,
  };
  const sim = {
    id: 'sim-9002', iccid: '890141000009002', vendor: 'atomic', gateway_host: 'skyline',
    status: 'active', msisdn: '5559009002', gateway_id: 'gw1', port: 3,
  };
  const rental = {
    id: 'r-9002', sim_id: 'sim-9002', reseller_id: 'rs-1', reseller_rental_id: 'rr-9002',
    rental_date: '2026-07-01', minted_at: iso(NOW - 10 * 24 * H),
  };
  const priorAttempts = [
    { id: 1, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 4 * H) },
    { id: 2, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - 3 * H) },
  ];

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const cutoff = iso(NOW - 15 * 60 * 1000);
      const open = (report.auto_remediation_state == null || report.auto_remediation_state === 'queued')
        && (report.last_auto_attempt_at == null || report.last_auto_attempt_at < cutoff);
      return jsonResp(open ? [report] : []);
    }
    if (u.includes('/rental_reports?sim_id=eq.')) return jsonResp([]);
    if (u.includes('/webhook_deliveries?')) return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress')) return jsonResp([]);
    if (u.includes('/rental_reports?id=eq.9002')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = report.auto_remediation_state == null || report.auto_remediation_state === 'queued';
          if (claimable) Object.assign(report, body);
          return new Response(null, { status: 204, headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' } });
        }
        Object.assign(report, body);
        return jsonResp([]);
      }
      return jsonResp([report]);
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') return jsonResp({}, 201);
      return jsonResp(priorAttempts);
    }
    if (u.includes('/rental_report_events') && method === 'POST') return jsonResp({}, 201);
    if (u.includes('/sims?id=eq.')) return jsonResp([sim]);
    if (u.includes('/rentals?id=eq.')) return jsonResp([rental]);
    if (u.includes('pending_review_items')) return jsonResp([]);
    if (u.includes('operator_escalations')) {
      if (method === 'POST') return jsonResp([{ id: 1 }], 201);
      return jsonResp([]);
    }
    // No SKYLINE_GATEWAY binding -> evidence.gatewayOffline never set via the
    // live probe; simulate S5 by having sim have no vendor (forces the S6
    // fallthrough) is wrong for this test, so instead we rely on the
    // gatewayOffline evidence flag directly not being reachable without a
    // binding — this test therefore exercises S5 through a SKYLINE_GATEWAY
    // stub below instead of this branch.
    return jsonResp([]);
  };

  const env = baseEnv({
    SKYLINE_GATEWAY: {
      async fetch() { return jsonResp({ status: 'offline', online: false }); },
    },
  });

  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await runTickViaWorker(env);
    assert.equal(report.auto_remediation_state, 'escalated');
    assert.equal(report.escalation_reason, 'gateway_port_offline_unresolved');
  } finally { globalThis.fetch = orig; }
});

// ---------------------------------------------------------------------------
// R3 — TH5 unseated-line detection: gateway_id:0/port:null -> distinct
// escalate, no reset-port call.
// ---------------------------------------------------------------------------

test('R3: Teltik host port offline + get-info shows gateway_id 0/port null -> teltik_line_not_seated, no reset', async () => {
  const report = {
    id: 9003, status: 'received', received_at: iso(NOW - 1 * H), sim_id: 'sim-9003',
    sim_number_id: null, rental_id: 'r-9003', reseller_id: 'rs-1', e164: '+15550009003',
    auto_remediation_state: null, last_auto_attempt_at: null, reason_code: 'no_sms_received', attempts: 3,
  };
  const sim = {
    id: 'sim-9003', iccid: '890141000009003', vendor: 'atomic', gateway_host: 'teltik',
    status: 'active', msisdn: '5559009003', gateway_id: null, port: null,
  };
  const rental = {
    id: 'r-9003', sim_id: 'sim-9003', reseller_id: 'rs-1', reseller_rental_id: 'rr-9003',
    rental_date: '2026-07-01', minted_at: iso(NOW - 10 * 24 * H),
  };
  let resetPortCalls = 0;

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('api.smsgateway.xyz/v1/port-status')) return jsonResp({ success: true, status: 'offline' });
    if (u.includes('api.smsgateway.xyz/v1/get-info')) return jsonResp({ gateway_id: 0, port: null, iccid: sim.iccid, line_state: 'active' });
    if (u.includes('api.smsgateway.xyz/v1/reset-port')) { resetPortCalls++; return jsonResp({ success: true, request_id: 'rp-1' }); }
    if (u.startsWith('https://atomic.test')) {
      return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', Result: { attStatus: 'active', MSISDN: '5559009003' } } } });
    }
    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const cutoff = iso(NOW - 15 * 60 * 1000);
      const open = (report.auto_remediation_state == null || report.auto_remediation_state === 'queued')
        && (report.last_auto_attempt_at == null || report.last_auto_attempt_at < cutoff);
      return jsonResp(open ? [report] : []);
    }
    if (u.includes('/rental_reports?sim_id=eq.')) return jsonResp([]);
    if (u.includes('/webhook_deliveries?')) return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress')) return jsonResp([]);
    if (u.includes('/rental_reports?id=eq.9003')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = report.auto_remediation_state == null || report.auto_remediation_state === 'queued';
          if (claimable) Object.assign(report, body);
          return new Response(null, { status: 204, headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' } });
        }
        Object.assign(report, body);
        return jsonResp([]);
      }
      return jsonResp([report]);
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') return jsonResp({}, 201);
      return jsonResp([]);
    }
    if (u.includes('/rental_report_events') && method === 'POST') return jsonResp({}, 201);
    if (u.includes('/sims?id=eq.')) return jsonResp([sim]);
    if (u.includes('/rentals?id=eq.')) return jsonResp([rental]);
    if (u.includes('pending_review_items')) return jsonResp([]);
    if (u.includes('operator_escalations')) {
      if (method === 'POST') return jsonResp([{ id: 1 }], 201);
      return jsonResp([]);
    }
    return jsonResp([]);
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await runTickViaWorker(baseEnv({ TELTIK_PORT_RECHECK_WAIT_MS: '0' }));
    assert.equal(resetPortCalls, 0, 'never resets an unseated line');
    assert.equal(report.auto_remediation_state, 'escalated');
    assert.equal(report.escalation_reason, 'teltik_line_not_seated');
  } finally { globalThis.fetch = orig; }
});

// ---------------------------------------------------------------------------
// R5 — reprocessing-loop backstop.
// ---------------------------------------------------------------------------

test('R5: report reprocessed 8+ times with no terminal state escalates reprocessing_loop', async () => {
  const report = {
    id: 9004, status: 'received', received_at: iso(NOW - 90 * 60 * 1000), sim_id: 'sim-9004',
    sim_number_id: null, rental_id: 'r-9004', reseller_id: 'rs-1', e164: '+15550009004',
    auto_remediation_state: null, last_auto_attempt_at: null, reason_code: 'no_sms_received', attempts: 3,
  };
  const sim = {
    id: 'sim-9004', iccid: '890141000009004', vendor: 'atomic', gateway_host: 'skyline',
    status: 'active', msisdn: '5559009004', gateway_id: null, port: null,
  };
  // No rental row -> S4 no_rental_row would normally close_duplicate (terminal)
  // — use a rental row instead + no vendor situation match to stay non-terminal
  // via classify_only. Simplest reliable non-terminal path: unknown vendor
  // string routes to S6 escalate (terminal) — so use a KNOWN vendor with a
  // vendor read failure, which routes to `pending_vendor_read` classify_only
  // (non-terminal) every tick.
  const rental = {
    id: 'r-9004', sim_id: 'sim-9004', reseller_id: 'rs-1', reseller_rental_id: 'rr-9004',
    rental_date: '2026-07-01', minted_at: iso(NOW - 10 * 24 * H),
  };
  const priorAttempts = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, action: 'classify_only', outcome: 'no_change', attempted_at: iso(NOW - (8 - i) * H),
  }));

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    // Atomic read always errors -> vendorRead.ok=false -> pending_vendor_read -> classify_only, non-terminal.
    if (u.startsWith('https://atomic.test')) return jsonResp({}, 500);
    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const cutoff = iso(NOW - 15 * 60 * 1000);
      const open = (report.auto_remediation_state == null || report.auto_remediation_state === 'queued')
        && (report.last_auto_attempt_at == null || report.last_auto_attempt_at < cutoff);
      return jsonResp(open ? [report] : []);
    }
    if (u.includes('/rental_reports?sim_id=eq.')) return jsonResp([]);
    if (u.includes('/webhook_deliveries?')) return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress')) return jsonResp([]);
    if (u.includes('/rental_reports?id=eq.9004')) {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = report.auto_remediation_state == null || report.auto_remediation_state === 'queued';
          if (claimable) Object.assign(report, body);
          return new Response(null, { status: 204, headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' } });
        }
        Object.assign(report, body);
        return jsonResp([]);
      }
      return jsonResp([report]);
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') return jsonResp({}, 201);
      return jsonResp(priorAttempts);
    }
    if (u.includes('/rental_report_events') && method === 'POST') return jsonResp({}, 201);
    if (u.includes('/sims?id=eq.')) return jsonResp([sim]);
    if (u.includes('/rentals?id=eq.')) return jsonResp([rental]);
    if (u.includes('pending_review_items')) return jsonResp([]);
    if (u.includes('operator_escalations')) {
      if (method === 'POST') return jsonResp([{ id: 1 }], 201);
      return jsonResp([]);
    }
    return jsonResp([]);
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const result = await runTickViaWorker(baseEnv());
    assert.equal(report.auto_remediation_state, 'escalated');
    assert.equal(report.escalation_reason, 'reprocessing_loop');
    // R5 minimum fix: field always present in the tick summary.
    assert.equal(typeof result.next_review_at_fallback_count, 'number');
  } finally { globalThis.fetch = orig; }
});

// ---------------------------------------------------------------------------
// R2 — bounded drain wired into the tick; R8 — inbox age-out wired into the
// tick. Verified together via an otherwise-empty tick (no open reports) so
// only the sweep/drain plumbing is exercised.
// ---------------------------------------------------------------------------

test('R2/R8: runTick drains bounded operator_escalations backlog and ages out stale inbox items', async () => {
  const staleItem = { id: 555, created_at: iso(NOW - 40 * 24 * H) };
  const escalationRow = {
    id: 77, tick_id: 't1', vendor: 'atomic', failure_type: 'generic',
    status: 'queued', report_ids: [1], line_items: [{ report_id: 1 }],
    paperclip_issue_id: null, created_at: iso(NOW - 60 * 24 * H),
  };
  const patches = { pendingItem: null, escalation: null };
  let inboxPosts = 0;

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/rental_reports?status=in.') && method === 'GET') return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress')) return jsonResp([]);
    if (u.includes('pending_review_items') && method === 'GET') return jsonResp([staleItem]);
    if (u.includes('pending_review_items?id=eq.555') && method === 'PATCH') {
      patches.pendingItem = JSON.parse(init.body);
      return jsonResp({});
    }
    if (u.includes('pending_review_items') && method === 'POST') { inboxPosts++; return jsonResp([{ id: 1000 + inboxPosts }], 201); }
    // Backlog reads (detail true and false) and the drain candidate query all
    // hit operator_escalations GET.
    if (u.includes('operator_escalations') && method === 'GET') return jsonResp([escalationRow]);
    if (u.includes('operator_escalations') && method === 'PATCH') {
      patches.escalation = JSON.parse(init.body);
      return jsonResp({});
    }
    return jsonResp([]);
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const result = await runTickViaWorker(baseEnv());
    // R2
    assert.ok(result.escalation_drain, 'tick summary carries escalation_drain');
    assert.equal(result.escalation_drain.delivered, 1, 'the queued escalation row was drained/delivered');
    assert.equal(patches.escalation && patches.escalation.status, 'delivered');
    assert.equal(inboxPosts, 1, 'drain delivered exactly one inbox item this tick (bounded)');
    // R8
    assert.equal(patches.pendingItem && patches.pendingItem.status, 'dismissed');
    assert.ok(patches.pendingItem && patches.pendingItem.resolved_at);
    assert.match(patches.pendingItem.operator_response, /auto-aged-out 30d/);
    assert.equal(result.escalation_inbox_aged_out.aged_out, 1);
  } finally { globalThis.fetch = orig; }
});

// ---------------------------------------------------------------------------
// R4 — claim recovery writes an audit event.
// ---------------------------------------------------------------------------

test('R4: stale in_progress claim recovery writes a claim_recovered audit event', async () => {
  const events = [];
  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/rental_reports?status=in.') && method === 'GET') return jsonResp([]);
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress') && method === 'PATCH') {
      return jsonResp([{ id: 900, status: 'received' }]);
    }
    if (u.includes('/rental_report_events') && method === 'POST') { events.push(JSON.parse(init.body)); return jsonResp({}, 201); }
    if (u.includes('pending_review_items')) return jsonResp([]);
    if (u.includes('operator_escalations')) return jsonResp([]);
    return jsonResp([]);
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const result = await runTickViaWorker(baseEnv());
    assert.equal(result.stale_recovered, 1);
    assert.ok(events.some(e => e.report_id === 900
      && e.actor === 'system'
      && e.evidence && e.evidence.reason === 'claim_recovered'
      && e.evidence.auto_remediation_state_from === 'in_progress'
      && e.evidence.auto_remediation_state_to === 'queued'));
  } finally { globalThis.fetch = orig; }
});
