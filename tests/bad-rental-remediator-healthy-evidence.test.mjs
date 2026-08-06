// HE1 healthy-evidence gate (t_ca8dac09).
//
// The gate exists to auto-resolve HEALTHY-BUT-NOISY bad-rental reports without
// ever touching a line that might really be broken. These tests pin the two
// properties that make that safe:
//
//   1. PROVIDER and HOST are SEPARATE evidence layers. An Atomic (AT&T service)
//      line can be physically hosted by Teltik, so "Atomic Active" and "Teltik
//      host port ONLINE" are different facts and BOTH must hold. A Teltik host
//      read must be keyed by the Teltik-known MDN, never blindly by the DB MDN.
//
//   2. USAGE PROOF is required and is anchored to THIS report/rental. Provider
//      + host healthy only means "nothing looks broken right now"; an inbound
//      SMS on this SIM, inside this rental's window, on a canonical number for
//      this SIM is what proves the renter's traffic actually flowed.
//
// Anything missing/unknown must NOT auto-resolve, and must say which layer
// failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateHealthyEvidence,
  evaluateProviderHealth,
  evaluateHostHealth,
  evaluateUsageProof,
  proofWindow,
  mdnKey,
  maskMdn,
  HE_REASONS,
  HEALTHY_EVIDENCE_OUTCOME,
  HEALTHY_EVIDENCE_REASON,
  MAX_READ_AGE_MS,
} from '../src/bad-rental-remediator/healthy-evidence.mjs';

import { executeAction } from '../src/bad-rental-remediator/actions.mjs';

const NOW = Date.parse('2026-08-06T15:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();

const CURRENT_MDN = '+15550006817';
const RETIRED_MDN = '+15550001111';

// ---------------------------------------------------------
// Fixtures — an Atomic-provider SIM physically hosted in a Teltik gateway.
// This is the case the provider/host split exists for (report #6817 class).
// ---------------------------------------------------------

function makeReport(over = {}) {
  return {
    id: 6817,
    sim_id: 'sim-6817',
    rental_id: 'r-6817',
    reseller_id: 'rs-1',
    e164: CURRENT_MDN,
    status: 'received',
    received_at: iso(NOW - 20 * MIN),
    ...over,
  };
}

function makeEvidence(over = {}) {
  const base = {
    sim: {
      id: 'sim-6817', iccid: '8901410327000006817', vendor: 'atomic',
      gateway_host: 'teltik', status: 'active', current_mdn_e164: CURRENT_MDN,
    },
    rental: { id: 'r-6817', sim_id: 'sim-6817', minted_at: iso(NOW - 6 * HOUR) },
    simNumber: null,
    currentSimNumberE164: CURRENT_MDN,
    gatewayOffline: false,
    // Provider layer: Atomic subscriber inquiry says Active.
    vendorRead: { ok: true, healthy: true, view: { not_found: false, attStatus: 'active', MSISDN: '5550006817' } },
    // Host layer: Teltik /v1/port-status ONLINE, keyed by the Teltik-known MDN.
    teltikKnownMdn: { mdn: CURRENT_MDN, source: 'teltik_inbound_sms_payload_mdn', received_at: iso(NOW - 30 * MIN) },
    teltikHostPortMdn: CURRENT_MDN,
    teltikHostPortMdnSource: 'teltik_inbound_sms_payload_mdn',
    teltikHostPortStatus: { online: true, status: 200, raw: 'online', checked_at: iso(NOW - MIN) },
    // Usage proof: an inbound SMS landed on this SIM 10 min before the report.
    inboundProof: {
      ok: true,
      error: null,
      rows: [{
        id: 991, sim_id: 'sim-6817', to_number: CURRENT_MDN,
        from_number: '+18005551234', received_at: iso(NOW - 30 * MIN), port: null,
      }],
    },
  };
  return { ...base, ...over };
}

function gate(over = {}, reportOver = {}) {
  return evaluateHealthyEvidence({
    report: makeReport(reportOver),
    evidence: makeEvidence(over),
    now: NOW,
  });
}

// ---------------------------------------------------------
// (1) All three classes present → auto-resolve, layers kept separate.
// ---------------------------------------------------------

test('HE1 passes when Atomic provider Active + Teltik host ONLINE + inbound SMS in window', () => {
  const r = gate();

  assert.equal(r.passed, true);
  assert.equal(r.reason, HEALTHY_EVIDENCE_REASON);
  assert.deepEqual(r.missing, []);

  // Provider layer — the CARRIER account, reported on its own.
  assert.equal(r.classes.provider.ok, true);
  assert.equal(r.classes.provider.vendor, 'atomic');
  assert.equal(r.classes.provider.state, 'active');

  // Host layer — the PHYSICAL gateway, reported on its own and keyed by the
  // Teltik-known MDN (not blindly by the DB current MDN).
  assert.equal(r.classes.host.ok, true);
  assert.equal(r.classes.host.host, 'teltik');
  assert.equal(r.classes.host.state, 'online');
  assert.equal(r.summary.host.mdn_source, 'teltik_inbound_sms_payload_mdn');

  // Usage layer — the concrete inbound SMS that proves delivery.
  assert.equal(r.classes.usage.ok, true);
  assert.equal(r.summary.usage.sms.inbound_sms_id, 991);
  assert.equal(r.summary.usage.sms.matched_via, 'sim_current_mdn');
  assert.equal(r.summary.usage.sms.received_at, iso(NOW - 30 * MIN));
});

test('provider and host are independent layers, not one folded signal', () => {
  // Atomic Active while the Teltik host port is offline: the provider verdict
  // must stay ok and ONLY the host verdict fails.
  const offline = makeEvidence({
    teltikHostPortStatus: { online: false, status: 200, raw: 'offline', checked_at: iso(NOW - MIN) },
  });
  assert.equal(evaluateProviderHealth(offline).ok, true, 'provider health must not read host state');
  assert.equal(evaluateHostHealth(offline, NOW).ok, false);

  // Mirror case: a Teltik-VENDOR line whose vendorRead.healthy folds port state
  // in. The provider layer must re-derive from line_state alone.
  const teltikVendor = makeEvidence({
    sim: { id: 's', vendor: 'teltik', gateway_host: 'teltik', current_mdn_e164: CURRENT_MDN },
    vendorRead: {
      ok: true,
      healthy: false, // folded (line active BUT port offline) — must not be used
      view: { not_found: false, line_state: 'active', port_status: 'offline', MDN: null },
    },
    teltikHostPortStatus: { online: false, status: 200, raw: 'offline', checked_at: iso(NOW - MIN) },
  });
  const provider = evaluateProviderHealth(teltikVendor);
  assert.equal(provider.ok, true, 'teltik line_state=active is provider-healthy on its own');
  assert.equal(provider.state, 'active');
  assert.equal(evaluateHostHealth(teltikVendor, NOW).reason, HE_REASONS.HOST_OFFLINE);
});

// ---------------------------------------------------------
// (2) Atomic Active but host offline / unknown → never auto-resolve.
// ---------------------------------------------------------

test('does NOT auto-resolve when Atomic is Active but the Teltik host port is OFFLINE', () => {
  const r = gate({ teltikHostPortStatus: { online: false, status: 200, raw: 'offline', checked_at: iso(NOW - MIN) } });

  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.HOST_OFFLINE);
  assert.ok(r.missing.includes(HE_REASONS.HOST_OFFLINE));
  assert.equal(r.classes.provider.ok, true, 'provider stays healthy — only the host failed');
});

test('does NOT auto-resolve when the Teltik host port read failed (unknown ≠ offline)', () => {
  const failedRead = gate({
    teltikHostPortStatus: { online: false, status: 500, error: 'port_read_failed', checked_at: iso(NOW - MIN) },
  });
  assert.equal(failedRead.passed, false);
  assert.equal(failedRead.reason, HE_REASONS.HOST_UNKNOWN);
  assert.equal(failedRead.summary.host.detail, 'port_read_failed');

  // No read at all is equally unknown.
  const noRead = gate({ teltikHostPortStatus: null });
  assert.equal(noRead.passed, false);
  assert.equal(noRead.reason, HE_REASONS.HOST_UNKNOWN);

  // An unusable read (status 0 wrapper) must not be read as "offline".
  const unusable = gate({ teltikHostPortStatus: { online: false, status: 0, error: 'no_mdn', checked_at: iso(NOW) } });
  assert.equal(unusable.reason, HE_REASONS.HOST_UNKNOWN);
});

test('host evidence gathered with the wrong MDN is rejected as stale, not accepted', () => {
  // A raw Teltik payload MDN exists, but the port-status read was keyed by the
  // DB current MDN instead — the read may describe a line Teltik no longer maps
  // to this SIM, so it cannot be proof.
  const r = gate({
    teltikKnownMdn: { mdn: '+15550009999', source: 'teltik_inbound_sms_payload_mdn', received_at: iso(NOW - HOUR) },
    teltikHostPortMdn: CURRENT_MDN,
    teltikHostPortMdnSource: 'db_current_mdn',
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.HOST_MDN_EVIDENCE_STALE);
  assert.equal(r.summary.host.detail, 'port_status_mdn_is_not_teltik_known_mdn');

  // The DB-MDN fallback IS legitimate when no raw Teltik MDN exists.
  const fallback = gate({
    teltikKnownMdn: { mdn: CURRENT_MDN, source: 'db_current_mdn', received_at: null },
    teltikHostPortMdnSource: 'db_current_mdn',
  });
  assert.equal(fallback.passed, true);
  assert.equal(fallback.summary.host.mdn_source, 'db_current_mdn');
});

test('a stale host port read is not proof of a healthy host right now', () => {
  const r = gate({
    teltikHostPortStatus: {
      online: true, status: 200, raw: 'online',
      checked_at: iso(NOW - MAX_READ_AGE_MS - MIN),
    },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.HOST_UNKNOWN);
  assert.equal(r.summary.host.detail, 'port_status_read_stale');
});

test('a host port read with no read-time is unknown, not fresh-by-default', () => {
  // MAX_READ_AGE_MS only means something if an unstamped read is refused:
  // otherwise a cached/replayed port status sails through the freshness guard
  // it exists to enforce.
  const r = gate({
    teltikHostPortStatus: { online: true, status: 200, raw: 'online' },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.HOST_UNKNOWN);
  assert.equal(r.summary.host.detail, 'port_status_read_age_unknown');
});

test('does NOT auto-resolve when the provider read failed or the line is not Active', () => {
  const readFailed = gate({ vendorRead: { ok: false, error: 'atomic_http_500' } });
  assert.equal(readFailed.passed, false);
  assert.equal(readFailed.reason, HE_REASONS.PROVIDER_UNKNOWN);
  assert.equal(readFailed.summary.provider.detail, 'atomic_http_500');
  assert.equal(readFailed.classes.host.ok, true, 'host stays healthy — only the provider failed');

  const suspended = gate({
    vendorRead: { ok: true, healthy: false, view: { not_found: false, attStatus: 'suspended' } },
  });
  assert.equal(suspended.passed, false);
  assert.equal(suspended.reason, HE_REASONS.PROVIDER_NOT_ACTIVE);
  assert.equal(suspended.summary.provider.state, 'suspended');
});

// ---------------------------------------------------------
// (3) Host ONLINE but no usage proof → never auto-resolve.
// ---------------------------------------------------------

test('does NOT auto-resolve when Teltik host is ONLINE but no inbound SMS proof exists', () => {
  const r = gate({ inboundProof: { ok: true, rows: [], error: null } });

  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.NO_USAGE_PROOF);
  assert.equal(r.classes.provider.ok, true);
  assert.equal(r.classes.host.ok, true);
  assert.equal(r.classes.usage.ok, false);
});

test('a failed inbound-SMS read is never treated as "no traffic"', () => {
  const r = gate({ inboundProof: { ok: false, rows: [], error: 'inbound_sms_http_400' } });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.USAGE_READ_FAILED);
  assert.notEqual(r.reason, HE_REASONS.NO_USAGE_PROOF);
});

// ---------------------------------------------------------
// (4) Usage proof from a different/stale rental or window.
// ---------------------------------------------------------

test('does NOT auto-resolve on an inbound SMS from outside the report window', () => {
  const r = gate({
    inboundProof: {
      ok: true, error: null,
      rows: [{ id: 12, sim_id: 'sim-6817', to_number: CURRENT_MDN, received_at: iso(NOW - 2 * 24 * HOUR) }],
    },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.USAGE_OUTSIDE_WINDOW);
});

test('does NOT auto-resolve on an inbound SMS that predates this rental', () => {
  // Same SIM, message 40 min before the report — but the rental only started
  // 10 min ago, so that traffic belongs to the PREVIOUS rental on this SIM.
  const r = gate({
    rental: { id: 'r-6817', sim_id: 'sim-6817', minted_at: iso(NOW - 10 * MIN) },
    inboundProof: {
      ok: true, error: null,
      rows: [{ id: 13, sim_id: 'sim-6817', to_number: CURRENT_MDN, received_at: iso(NOW - 40 * MIN) }],
    },
  }, { received_at: iso(NOW - 5 * MIN) });

  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.USAGE_OUTSIDE_WINDOW);
});

test('does NOT auto-resolve when the report/rental context itself has moved on', () => {
  const replaced = gate({ rental: { id: 'r-6817', sim_id: 'sim-OTHER', minted_at: iso(NOW - 6 * HOUR) } });
  assert.equal(replaced.passed, false);
  assert.equal(replaced.reason, HE_REASONS.REPORT_RENTAL_MISMATCH);
  assert.equal(replaced.summary.report_rental_match.detail, 'rental_sim_replaced');

  const historical = gate({ simNumber: { id: 5, e164: RETIRED_MDN, isHistorical: true } });
  assert.equal(historical.passed, false);
  assert.equal(historical.reason, HE_REASONS.REPORT_RENTAL_MISMATCH);

  const noRental = gate({ rental: null });
  assert.equal(noRental.passed, false);
  assert.equal(noRental.reason, HE_REASONS.REPORT_RENTAL_MISMATCH);
});

test('proofWindow clamps the pre-report lookback to the rental start', () => {
  const w = proofWindow({
    report: makeReport({ received_at: iso(NOW) }),
    rental: { minted_at: iso(NOW - 5 * MIN) },
    now: NOW,
  });
  assert.equal(w.startMs, NOW - 5 * MIN, 'rental start wins over the 30 min pre-report window');
  assert.equal(w.endMs, NOW, 'window never extends past now');
});

// ---------------------------------------------------------
// (5) Usage proof addressed to a non-canonical / retired number.
// ---------------------------------------------------------

test('does NOT auto-resolve on an inbound SMS addressed to a retired number', () => {
  const r = gate({
    inboundProof: {
      ok: true, error: null,
      rows: [{ id: 14, sim_id: 'sim-6817', to_number: RETIRED_MDN, received_at: iso(NOW - 10 * MIN) }],
    },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.USAGE_MDN_MISMATCH);
});

test('inbound SMS for a DIFFERENT sim is never usable as proof for this report', () => {
  const r = gate({
    inboundProof: {
      ok: true, error: null,
      rows: [{ id: 15, sim_id: 'sim-OTHER', to_number: CURRENT_MDN, received_at: iso(NOW - 10 * MIN) }],
    },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, HE_REASONS.NO_USAGE_PROOF);
});

test('Teltik-hosted lines may also match on the Teltik-known MDN', () => {
  // Teltik payload destinations lag our rotations, so a message recorded
  // against the Teltik-known MDN still proves delivery for this SIM.
  const teltikMdn = '+15550009999';
  const r = gate({
    teltikKnownMdn: { mdn: teltikMdn, source: 'teltik_inbound_sms_payload_mdn', received_at: iso(NOW - HOUR) },
    teltikHostPortMdn: teltikMdn,
    inboundProof: {
      ok: true, error: null,
      rows: [{ id: 16, sim_id: 'sim-6817', to_number: teltikMdn, received_at: iso(NOW - 10 * MIN) }],
    },
  });
  assert.equal(r.passed, true);
  assert.equal(r.summary.usage.sms.matched_via, 'teltik_known_mdn');
});

// ---------------------------------------------------------
// Evidence hygiene — audit rows must not carry full customer numbers.
// ---------------------------------------------------------

test('gate summary masks numbers and still carries ids/timestamps for audit', () => {
  const r = gate();
  const blob = JSON.stringify(r.summary);

  assert.ok(!blob.includes(CURRENT_MDN), 'full MDN must not appear in evidence');
  assert.ok(!blob.includes('5550006817'), 'bare 10-digit MDN must not appear either');
  assert.ok(!blob.includes('18005551234'), 'sender number must not appear');

  assert.equal(r.summary.usage.sms.to_number_masked, '***6817');
  assert.equal(r.summary.usage.sms.from_number_masked, '***1234');
  assert.equal(r.summary.report_id, 6817);
  assert.equal(r.summary.sim_id, 'sim-6817');
  assert.ok(r.summary.evaluated_at);
  assert.ok(r.summary.usage.window.start && r.summary.usage.window.end);
});

test('mdnKey/maskMdn normalize across E.164, national and raw payload forms', () => {
  assert.equal(mdnKey('+15550006817'), '5550006817');
  assert.equal(mdnKey('5550006817'), '5550006817');
  assert.equal(mdnKey('1-555-000-6817'), '5550006817');
  assert.equal(mdnKey('123'), null);
  assert.equal(maskMdn('+15550006817'), '***6817');
  assert.equal(maskMdn(null), null);
});

// ---------------------------------------------------------
// evaluateUsageProof directly — window boundaries.
// ---------------------------------------------------------

test('usage proof accepts a message shortly before the complaint, rejects one long after', () => {
  const inWindow = evaluateUsageProof({
    report: makeReport({ received_at: iso(NOW) }),
    evidence: makeEvidence({
      inboundProof: {
        ok: true, error: null,
        rows: [{ id: 21, sim_id: 'sim-6817', to_number: CURRENT_MDN, received_at: iso(NOW - 25 * MIN) }],
      },
    }),
    now: NOW,
  });
  assert.equal(inWindow.ok, true);

  const tooLate = evaluateUsageProof({
    report: makeReport({ received_at: iso(NOW - 20 * HOUR) }),
    evidence: makeEvidence({
      rental: { id: 'r-6817', sim_id: 'sim-6817', minted_at: iso(NOW - 24 * HOUR) },
      inboundProof: {
        ok: true, error: null,
        rows: [{ id: 22, sim_id: 'sim-6817', to_number: CURRENT_MDN, received_at: iso(NOW - MIN) }],
      },
    }),
    now: NOW,
  });
  assert.equal(tooLate.ok, false, 'a message 20h after the report is not proof for it');
  assert.equal(tooLate.reason, HE_REASONS.USAGE_OUTSIDE_WINDOW);
});

// ---------------------------------------------------------
// Executor — explicit action/reason + audit evidence on the close.
// ---------------------------------------------------------

function makeExecHarness() {
  const db = { report: { id: 6817, status: 'received', triaged_at: null, closed_at: null }, patches: [], events: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/rental_reports?id=eq.6817') && method === 'GET') {
      return new Response(JSON.stringify([db.report]), { status: 200 });
    }
    if (u.includes('/rental_reports?id=eq.6817') && method === 'PATCH') {
      const body = JSON.parse(init.body);
      db.patches.push(body);
      Object.assign(db.report, body);
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rental_report_events') && method === 'POST') {
      db.events.push(JSON.parse(init.body));
      return new Response('[]', { status: 201 });
    }
    return new Response('[]', { status: 200 });
  };
  return { db, env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' }, restore: () => { globalThis.fetch = orig; } };
}

test('healthy_evidence_auto_resolve writes an explicit remediated close plus audit evidence', async () => {
  const h = makeExecHarness();
  try {
    const healthy = gate().summary;
    const res = await executeAction(h.env, {
      action: 'healthy_evidence_auto_resolve',
      report: { id: 6817, status: 'received', rental_id: 'r-6817', sim_id: 'sim-6817', received_at: iso(NOW - 20 * MIN) },
      situationId: 'HE1',
      evidenceBundle: { situation_id: 'HE1', reason: HEALTHY_EVIDENCE_REASON },
      healthyEvidence: healthy,
    });

    assert.equal(res.ok, true);
    assert.equal(res.terminalReport.status, 'remediated');
    assert.equal(res.evidence.resolution, HEALTHY_EVIDENCE_OUTCOME);
    assert.equal(res.evidence.resolution_reason, HEALTHY_EVIDENCE_REASON);

    // Report row: terminal close in the DB-constrained shape.
    const patch = h.db.patches[0];
    assert.equal(patch.status, 'remediated');
    assert.equal(patch.remediation_action, 'other',
      'remediation_action is CHECK-constrained; the explicit reason rides the event/attempt');
    assert.ok(patch.closed_at);

    // Audit event: explicit action + reason + the evidence ids/timestamps.
    assert.equal(h.db.events.length, 1);
    const ev = h.db.events[0];
    assert.equal(ev.to_status, 'remediated');
    assert.equal(ev.actor, 'auto-remediator');
    assert.equal(ev.evidence.action, HEALTHY_EVIDENCE_OUTCOME);
    assert.equal(ev.evidence.resolution_reason, HEALTHY_EVIDENCE_REASON);
    assert.equal(ev.evidence.evidence_ids.report_id, 6817);
    assert.equal(ev.evidence.evidence_ids.inbound_sms_id, 991);
    assert.equal(ev.evidence.evidence_timestamps.inbound_sms_received_at, iso(NOW - 30 * MIN));
    assert.ok(ev.evidence.evidence_timestamps.host_port_checked_at);
    assert.ok(ev.evidence.evidence_timestamps.resolved_at);
    assert.equal(ev.evidence.healthy_evidence.passed, true);
  } finally { h.restore(); }
});

test('healthy_evidence_auto_resolve refuses to close without a PASSED gate', async () => {
  const h = makeExecHarness();
  try {
    const notProven = gate({ inboundProof: { ok: true, rows: [], error: null } }).summary;

    const missing = await executeAction(h.env, {
      action: 'healthy_evidence_auto_resolve',
      report: { id: 6817, status: 'received' },
      healthyEvidence: null,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.errorMessage, 'healthy_evidence_not_proven');

    const failed = await executeAction(h.env, {
      action: 'healthy_evidence_auto_resolve',
      report: { id: 6817, status: 'received' },
      healthyEvidence: notProven,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorMessage, 'healthy_evidence_not_proven');

    assert.equal(h.db.patches.length, 0, 'no report row may be closed without proof');
    assert.equal(h.db.events.length, 0);
  } finally { h.restore(); }
});
