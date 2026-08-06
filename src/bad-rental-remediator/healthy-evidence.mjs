// =========================================================
// HEALTHY-EVIDENCE GATE (HE1) — pure logic, no IO.
//
// Purpose: a large share of bad-rental reports are NOISE. The line is fine,
// the renter did get their SMS, and the reseller reported anyway. Escalating
// those to an operator (or worse, firing a vendor OTA/restore/reset at a
// working line) is pure cost. This module decides — conservatively — whether a
// report is provably healthy so the remediator can close it as
// `healthy_evidence_auto_resolved` / `confirmed_working` instead.
//
// THREE INDEPENDENT EVIDENCE CLASSES, ALL REQUIRED:
//
//   1. PROVIDER / SERVICE side  — the CARRIER ACCOUNT (sims.vendor) says the
//      line is Active/OK: Atomic attStatus=active, Wing status=activated,
//      Helix state=active, Teltik line_state=active/activated.
//
//   2. HOST / SERVER side       — the PHYSICAL gateway (sims.gateway_host) is
//      serving the SIM. For gateway_host='teltik' that is a live
//      /v1/port-status ONLINE read keyed by the TELTIK-KNOWN MDN (latest raw
//      Teltik inbound-SMS payload destination; DB current MDN only as a
//      fallback when no raw MDN exists — see shared/teltik-known-mdn.mjs).
//      For Skyline-hosted SIMs the host signal is the Skyline port probe.
//
//   Provider and host are SEPARATE LAYERS and are never collapsed: an Atomic
//   (AT&T) line can be hosted by Teltik, so "Atomic Active" and "Teltik host
//   port ONLINE" are two different facts and BOTH must hold. Note that
//   vendor.mjs's `vendorRead.healthy` folds port state into the Teltik VENDOR
//   read; this module deliberately re-derives the provider layer from the
//   projected view so the two layers stay independent.
//
//   3. USAGE PROOF              — an inbound SMS actually landed on THIS SIM,
//      inside the report/rental window, addressed to a canonical number for
//      this SIM. This is the only class that proves the renter's traffic
//      flowed; provider+host healthy without it just means "nothing looks
//      broken right now".
//
// FRESHNESS is tied to the REPORT/RENTAL, never to a stale global status:
//   - the inbound SMS must fall inside [report−PRE, report+POST] and must not
//     predate the rental;
//   - provider and host reads must have been taken within MAX_READ_AGE_MS of
//     evaluation time (they are taken in the same tick, so this only guards a
//     future cached-read path).
//
// Anything missing or unknown → NO auto-resolve, and a PRECISE reason code so
// the operator sees which layer is unproven rather than a generic "unknown".
// =========================================================

import { isTeltikHosted, gatewayHostOf } from '../shared/gateway-host.mjs';

export const HEALTHY_EVIDENCE_MODE    = 'HE1';
export const HEALTHY_EVIDENCE_ACTION  = 'healthy_evidence_auto_resolve';
export const HEALTHY_EVIDENCE_OUTCOME = 'healthy_evidence_auto_resolved';
export const HEALTHY_EVIDENCE_REASON  = 'confirmed_working';

// Usage-proof window, anchored on the report. A message that arrived shortly
// BEFORE the complaint still proves the delivery path worked for this rental
// (resellers report minutes after the fact); the forward window covers the
// remediator picking the report up later in the same business day.
export const PROOF_PRE_REPORT_MS  = 30 * 60 * 1000;      // 30 min
export const PROOF_POST_REPORT_MS = 12 * 60 * 60 * 1000; // 12 h
// Provider/host reads older than this are not usable as "healthy right now".
export const MAX_READ_AGE_MS = 15 * 60 * 1000;

// Reason codes — one per way the gate can refuse. Kept explicit (not derived)
// so dashboards/tests can enumerate them.
export const HE_REASONS = Object.freeze({
  OK: HEALTHY_EVIDENCE_REASON,
  PROVIDER_UNKNOWN: 'provider_unknown_or_read_failed',
  PROVIDER_NOT_ACTIVE: 'provider_not_active',
  HOST_UNKNOWN: 'host_unknown_or_read_failed',
  HOST_OFFLINE: 'host_port_offline',
  HOST_MDN_EVIDENCE_STALE: 'host_mdn_evidence_stale',
  NO_USAGE_PROOF: 'no_inbound_sms_proof',
  USAGE_OUTSIDE_WINDOW: 'inbound_sms_outside_report_window',
  USAGE_MDN_MISMATCH: 'inbound_sms_mdn_mismatch',
  USAGE_READ_FAILED: 'inbound_proof_read_failed',
  REPORT_RENTAL_MISMATCH: 'report_rental_mismatch',
  REPORT_TIME_UNKNOWN: 'report_time_unknown',
});

// ---------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------

// Last 10 digits — the canonical comparison form for US MDNs across our
// sources (E.164 '+1XXXXXXXXXX', national 'XXXXXXXXXX', Teltik raw payloads).
export function mdnKey(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Never write a full customer-facing number into evidence/audit rows.
export function maskMdn(value) {
  const k = mdnKey(value);
  if (!k) return null;
  return '***' + k.slice(-4);
}

function ms(value) {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

// ---------------------------------------------------------
// Class 1 — provider / service side
//
// Re-derived from the PROJECTED vendor view rather than vendorRead.healthy so
// the Teltik vendor's port fold-in cannot masquerade as provider health.
// ---------------------------------------------------------

export function evaluateProviderHealth(evidence) {
  const sim = (evidence && evidence.sim) || null;
  const vendor = String((sim && sim.vendor) || '').toLowerCase();
  const read = (evidence && evidence.vendorRead) || null;

  if (!sim || !vendor) {
    return { ok: false, state: 'unknown', reason: HE_REASONS.PROVIDER_UNKNOWN, detail: 'no_vendor_on_sim' };
  }
  if (!read) {
    return { ok: false, state: 'unknown', vendor, reason: HE_REASONS.PROVIDER_UNKNOWN, detail: 'no_vendor_read' };
  }
  if (read.ok !== true) {
    return {
      ok: false, state: 'unknown', vendor,
      reason: HE_REASONS.PROVIDER_UNKNOWN,
      detail: read.error || 'vendor_read_failed',
    };
  }
  const view = read.view || null;
  if (!view || view.not_found === true) {
    return { ok: false, state: 'not_found', vendor, reason: HE_REASONS.PROVIDER_NOT_ACTIVE, detail: 'vendor_not_found' };
  }

  let state = null;
  let active = false;
  if (vendor === 'atomic') {
    state = view.attStatus || null;
    active = state === 'active';
  } else if (vendor === 'wing_iot') {
    state = view.status || null;
    active = state === 'activated';
  } else if (vendor === 'helix') {
    state = view.state || null;
    active = state === 'active';
  } else if (vendor === 'teltik') {
    // Provider layer ONLY. view.port_status belongs to the host layer and is
    // evaluated there — a Teltik line can be Active while its gateway port is
    // offline, and that must not auto-resolve.
    state = view.line_state || null;
    active = state === 'active' || state === 'activated';
  } else {
    return { ok: false, state: 'unknown', vendor, reason: HE_REASONS.PROVIDER_UNKNOWN, detail: 'unsupported_vendor' };
  }

  if (state === null || state === undefined || state === '') {
    return { ok: false, state: 'unknown', vendor, reason: HE_REASONS.PROVIDER_UNKNOWN, detail: 'vendor_state_absent' };
  }
  if (!active) {
    return { ok: false, state, vendor, reason: HE_REASONS.PROVIDER_NOT_ACTIVE, detail: 'vendor_state_' + state };
  }
  return { ok: true, state, vendor, reason: null, detail: null };
}

// ---------------------------------------------------------
// Class 2 — host / server side
//
// Teltik-hosted: a 2xx /v1/port-status ONLINE read taken with the Teltik-known
// MDN. A failed READ is `host_unknown_or_read_failed`, never "offline"; a read
// taken with an MDN other than the resolved Teltik-known one is
// `host_mdn_evidence_stale` (we refuse to accept proof gathered against a
// number Teltik may not associate with this line).
//
// Skyline-hosted: the S5 Skyline port probe. Absence of an offline signal is
// accepted because the usage proof below rides the same gateway path — a
// Skyline port that delivered an inbound SMS in-window IS the host proof.
// ---------------------------------------------------------

export function evaluateHostHealth(evidence, nowMs) {
  const sim = (evidence && evidence.sim) || null;
  if (!sim) {
    return { ok: false, applicable: true, host: null, reason: HE_REASONS.HOST_UNKNOWN, detail: 'no_sim' };
  }
  const host = gatewayHostOf(sim);

  if (!isTeltikHosted(sim)) {
    if (evidence.gatewayOffline === true) {
      return { ok: false, applicable: true, host, reason: HE_REASONS.HOST_OFFLINE, detail: 'skyline_port_offline' };
    }
    return { ok: true, applicable: true, host, state: 'skyline_no_offline_signal', reason: null, detail: null };
  }

  const ps = evidence.teltikHostPortStatus || null;
  if (!ps) {
    return { ok: false, applicable: true, host, reason: HE_REASONS.HOST_UNKNOWN, detail: 'no_port_status_read' };
  }
  const readOk = Number(ps.status) >= 200 && Number(ps.status) < 300;
  if (!readOk) {
    return {
      ok: false, applicable: true, host,
      reason: HE_REASONS.HOST_UNKNOWN,
      detail: ps.error || ('teltik_port_status_http_' + (ps.status || 0)),
    };
  }

  // MDN provenance — the read must have used the Teltik-known MDN.
  const known = evidence.teltikKnownMdn || null;
  const usedMdn = evidence.teltikHostPortMdn || null;
  if (!known || !known.mdn) {
    return { ok: false, applicable: true, host, reason: HE_REASONS.HOST_MDN_EVIDENCE_STALE, detail: 'no_teltik_known_mdn' };
  }
  if (!usedMdn || mdnKey(usedMdn) !== mdnKey(known.mdn)) {
    return {
      ok: false, applicable: true, host,
      reason: HE_REASONS.HOST_MDN_EVIDENCE_STALE,
      detail: 'port_status_mdn_is_not_teltik_known_mdn',
      mdn_used: maskMdn(usedMdn),
      mdn_expected: maskMdn(known.mdn),
    };
  }

  // Freshness. A read with no usable `checked_at` has no provenance in time, so
  // it is UNKNOWN — not "fresh by default". gatherEvidence stamps every read it
  // takes; anything unstamped came from somewhere we cannot vouch for (a cached
  // or replayed read), which is exactly what MAX_READ_AGE_MS exists to reject.
  const checkedAtMs = ms(ps.checked_at);
  if (!Number.isFinite(checkedAtMs)) {
    return {
      ok: false, applicable: true, host,
      reason: HE_REASONS.HOST_UNKNOWN,
      detail: 'port_status_read_age_unknown',
      checked_at: ps.checked_at || null,
    };
  }
  if (Number.isFinite(nowMs) && nowMs - checkedAtMs > MAX_READ_AGE_MS) {
    return {
      ok: false, applicable: true, host,
      reason: HE_REASONS.HOST_UNKNOWN,
      detail: 'port_status_read_stale',
      checked_at: ps.checked_at || null,
    };
  }

  if (ps.online !== true) {
    return { ok: false, applicable: true, host, reason: HE_REASONS.HOST_OFFLINE, detail: ps.raw || 'offline' };
  }
  return {
    ok: true, applicable: true, host, state: 'online', reason: null, detail: null,
    mdn_source: known.source || null,
    mdn_masked: maskMdn(known.mdn),
    checked_at: ps.checked_at || null,
  };
}

// ---------------------------------------------------------
// Usage-proof window — anchored on the report, clamped by the rental.
// ---------------------------------------------------------

export function proofWindow({ report, rental, now }) {
  const reportMs = ms(report && report.received_at);
  if (!Number.isFinite(reportMs)) return null;
  const nowMs = Number.isFinite(ms(now)) ? ms(now) : reportMs;
  let startMs = reportMs - PROOF_PRE_REPORT_MS;
  // A rental that started after our pre-window means anything earlier belongs
  // to a PREVIOUS rental on the same SIM — never usable as proof for this one.
  const rentalStartMs = ms((rental && (rental.minted_at || rental.rental_date)) || null);
  if (Number.isFinite(rentalStartMs) && rentalStartMs > startMs) startMs = rentalStartMs;
  const endMs = Math.min(nowMs, reportMs + PROOF_POST_REPORT_MS);
  return { startMs, endMs, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

// The set of numbers an inbound SMS may legitimately be addressed to for THIS
// SIM: the SIM's current MDN (sims.msisdn → E.164), the SIM's current
// sim_numbers row, and — for Teltik-hosted lines only — the Teltik-known MDN,
// because Teltik payload destinations lag our rotations. The REPORTED e164 is
// deliberately NOT canonical: a report naming a retired number is stale
// context (stale-classifier's job), not proof.
export function canonicalNumbersForSim(evidence) {
  const out = [];
  const sim = (evidence && evidence.sim) || null;
  if (sim && sim.current_mdn_e164) out.push({ key: mdnKey(sim.current_mdn_e164), source: 'sim_current_mdn' });
  if (evidence && evidence.currentSimNumberE164) {
    out.push({ key: mdnKey(evidence.currentSimNumberE164), source: 'sim_numbers_current' });
  }
  if (sim && isTeltikHosted(sim) && evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn) {
    out.push({ key: mdnKey(evidence.teltikKnownMdn.mdn), source: 'teltik_known_mdn' });
  }
  return out.filter(x => x.key);
}

// ---------------------------------------------------------
// Class 3 — usage proof
//
// evidence.inboundProof: { ok, rows, error } — rows are recent inbound_sms for
// this sim_id (wider than the window on purpose, so we can tell "nothing at
// all" from "something, but stale/for another number").
// ---------------------------------------------------------

export function evaluateUsageProof({ report, evidence, now }) {
  const proof = (evidence && evidence.inboundProof) || null;
  if (!proof || proof.ok !== true) {
    return {
      ok: false, reason: HE_REASONS.USAGE_READ_FAILED,
      detail: (proof && proof.error) || 'inbound_sms_read_missing',
    };
  }
  const window = proofWindow({ report, rental: evidence.rental || null, now });
  if (!window) {
    return { ok: false, reason: HE_REASONS.REPORT_TIME_UNKNOWN, detail: 'report_received_at_unparseable' };
  }

  const rows = Array.isArray(proof.rows) ? proof.rows : [];
  const simId = report && report.sim_id;
  const canonical = canonicalNumbersForSim(evidence);
  const canonicalKeys = new Set(canonical.map(c => c.key));

  let sawOutsideWindow = false;
  let sawMdnMismatch = false;

  for (const row of rows) {
    if (!row) continue;
    // Same-SIM match. The query filters on sim_id already; re-check so a
    // widened query can never smuggle another SIM's traffic in as proof.
    if (simId != null && row.sim_id != null && String(row.sim_id) !== String(simId)) continue;

    const atMs = ms(row.received_at);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < window.startMs || atMs > window.endMs) { sawOutsideWindow = true; continue; }

    const key = mdnKey(row.to_number);
    if (!key || !canonicalKeys.has(key)) { sawMdnMismatch = true; continue; }

    const matchedVia = (canonical.find(c => c.key === key) || {}).source || null;
    return {
      ok: true, reason: null, detail: null,
      window,
      sms: {
        inbound_sms_id: row.id != null ? row.id : null,
        sim_id: row.sim_id != null ? row.sim_id : null,
        received_at: row.received_at || null,
        to_number_masked: maskMdn(row.to_number),
        from_number_masked: maskMdn(row.from_number),
        matched_via: matchedVia,
        port: row.port != null ? row.port : null,
      },
    };
  }

  if (sawMdnMismatch) {
    return { ok: false, reason: HE_REASONS.USAGE_MDN_MISMATCH, detail: 'inbound_sms_to_number_not_canonical', window };
  }
  if (sawOutsideWindow) {
    return { ok: false, reason: HE_REASONS.USAGE_OUTSIDE_WINDOW, detail: 'inbound_sms_outside_report_rental_window', window };
  }
  return { ok: false, reason: HE_REASONS.NO_USAGE_PROOF, detail: 'no_inbound_sms_for_sim', window };
}

// ---------------------------------------------------------
// Report ↔ rental coherence.
//
// A report whose rental has since moved to a different SIM (S2) or that has no
// rental row at all is not a "healthy but noisy" report — it is a
// wrong-context report and must never auto-resolve off this SIM's evidence.
// ---------------------------------------------------------

export function evaluateReportRentalMatch({ report, evidence }) {
  const rental = (evidence && evidence.rental) || null;
  if (!rental) {
    return { ok: false, reason: HE_REASONS.REPORT_RENTAL_MISMATCH, detail: 'no_rental_row' };
  }
  if (report && report.sim_id != null && rental.sim_id != null
      && String(rental.sim_id) !== String(report.sim_id)) {
    return { ok: false, reason: HE_REASONS.REPORT_RENTAL_MISMATCH, detail: 'rental_sim_replaced' };
  }
  if (evidence && evidence.simNumber && evidence.simNumber.isHistorical) {
    return { ok: false, reason: HE_REASONS.REPORT_RENTAL_MISMATCH, detail: 'report_on_historical_sim_number' };
  }
  return { ok: true, reason: null, detail: null };
}

// ---------------------------------------------------------
// The gate.
//
// passed=true ONLY when report/rental coherence + all three evidence classes
// hold. Otherwise `missing` lists every failing class (so the operator sees
// the whole picture, not just the first failure) and `reason` is the most
// specific single code, ordered provider → host → usage.
// ---------------------------------------------------------

export function evaluateHealthyEvidence({ report, evidence, now }) {
  const nowMs = Number.isFinite(ms(now)) ? ms(now) : Date.now();
  const ev = evidence || {};

  const match    = evaluateReportRentalMatch({ report, evidence: ev });
  const provider = evaluateProviderHealth(ev);
  const host     = evaluateHostHealth(ev, nowMs);
  const usage    = evaluateUsageProof({ report, evidence: ev, now: nowMs });

  const missing = [];
  if (!match.ok)    missing.push(match.reason);
  if (!provider.ok) missing.push(provider.reason);
  if (!host.ok)     missing.push(host.reason);
  if (!usage.ok)    missing.push(usage.reason);

  const passed = match.ok && provider.ok && host.ok && usage.ok;
  const reason = passed ? HE_REASONS.OK : missing[0];

  const summary = {
    gate: HEALTHY_EVIDENCE_MODE,
    passed,
    reason,
    missing_classes: missing,
    evaluated_at: new Date(nowMs).toISOString(),
    report_id: report && report.id != null ? report.id : null,
    rental_id: report && report.rental_id != null ? report.rental_id : null,
    sim_id: report && report.sim_id != null ? report.sim_id : null,
    provider: {
      ok: provider.ok, vendor: provider.vendor || null, state: provider.state || null,
      reason: provider.reason || null, detail: provider.detail || null,
    },
    host: {
      ok: host.ok, host: host.host || null, state: host.state || null,
      reason: host.reason || null, detail: host.detail || null,
      mdn_source: host.mdn_source || null, mdn_masked: host.mdn_masked || null,
      checked_at: host.checked_at || null,
    },
    usage: {
      ok: usage.ok, reason: usage.reason || null, detail: usage.detail || null,
      window: usage.window || null,
      sms: usage.sms || null,
    },
    report_rental_match: { ok: match.ok, reason: match.reason || null, detail: match.detail || null },
  };

  return { passed, reason, missing, classes: { provider, host, usage, match }, summary };
}
