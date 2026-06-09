// INC-25 Phase B: stale/historical rental-context classifier.
//
// Pure decision function applied BEFORE S1/S4/S6 fallthrough in classifyShared.
// Distinguishes four cases:
//
//   evidence_lookup_failed_rental  — rentals DB lookup errored (HTTP 400 etc.)
//   evidence_lookup_failed_sim     — sims DB lookup errored
//   old_rental_not_current         — sim_number_id points to a historical
//                                    sim_number (valid_to non-null) AND
//                                    report.e164 != sim's current MDN (msisdn).
//                                    Close as duplicate, NO vendor action.
//   stale_intake_mapping           — sim_number_id is historical BUT
//                                    report.e164 == sim's current MDN.
//                                    Intake attached a current-MDN report to
//                                    a stale rental. Escalate, NO vendor action.
//
// Returns null when none of these apply (caller falls through to S1/S4/S6).
//
// Inputs are plain objects:
//   report          — { id, e164, rental_id, sim_number_id, ... }
//   evidence        — { sim, rental, simNumber, currentSimNumberE164,
//                       rentalLookupError, simLookupError }
//
// Output shape mirrors the local `terminal(...)` helper in index.js:
//   { mode, action, outcome, evidenceSummary, terminal, escalationReason }

export function normalizeE164(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (t.startsWith('+')) return t;
  // National 10-digit US → +1XXXXXXXXXX.
  if (/^\d{10}$/.test(t)) return '+1' + t;
  // National 11-digit starting with 1 → +1XXXXXXXXXX.
  if (/^1\d{10}$/.test(t)) return '+' + t;
  return t;
}

export function classifyStaleContext({ report, evidence }) {
  if (!report || !evidence) return null;

  // (a) Rental DB lookup errored — never close as duplicate.
  if (evidence.rentalLookupError && report.rental_id) {
    return {
      mode: 'S6',
      action: 'escalate',
      outcome: 'escalate',
      evidenceSummary: {
        reason: 'evidence_lookup_failed',
        lookup: 'rental',
        rental_id: report.rental_id,
        http_status: evidence.rentalLookupError.http_status,
        body: evidence.rentalLookupError.body,
      },
      terminal: true,
      escalationReason: 'evidence_lookup_failed',
    };
  }

  // (b) SIM DB lookup errored — never close as duplicate / no_vendor.
  if (evidence.simLookupError && report.sim_id) {
    return {
      mode: 'S6',
      action: 'escalate',
      outcome: 'escalate',
      evidenceSummary: {
        reason: 'evidence_lookup_failed',
        lookup: 'sim',
        sim_id: report.sim_id,
        http_status: evidence.simLookupError.http_status,
        body: evidence.simLookupError.body,
      },
      terminal: true,
      escalationReason: 'evidence_lookup_failed',
    };
  }

  // Stale-rental-context branches require both a sim_number context and a sim.
  const sn = evidence.simNumber;
  const sim = evidence.sim;
  if (!sn || !sn.isHistorical) return null;

  const reportE164  = normalizeE164(report.e164);
  const currentE164 = normalizeE164(evidence.currentSimNumberE164 || (sim && sim.current_mdn_e164));

  // (c) Historical sim_number AND report.e164 differs from current SIM MDN.
  //     Old rental complaint not relevant to current customer/MDN — close as
  //     duplicate, no vendor action.
  if (currentE164 && reportE164 && reportE164 !== currentE164) {
    return {
      mode: 'S7a',
      action: 'close_duplicate',
      outcome: 'duplicate',
      evidenceSummary: {
        reason: 'old_rental_not_current',
        sim_number_id: report.sim_number_id || null,
        historical_e164: sn.e164 || null,
        historical_valid_to: sn.valid_to || null,
        report_e164: reportE164,
        current_e164: currentE164,
      },
      terminal: true,
      escalationReason: null,
    };
  }

  // (d) Historical sim_number BUT report.e164 == current SIM MDN. Intake
  //     attached the wrong rental/sim_number. Escalate — operator decides
  //     whether to re-resolve and resubmit. No vendor action.
  if (currentE164 && reportE164 && reportE164 === currentE164) {
    return {
      mode: 'S7b',
      action: 'escalate',
      outcome: 'escalate',
      evidenceSummary: {
        reason: 'stale_intake_mapping',
        sim_number_id: report.sim_number_id || null,
        historical_e164: sn.e164 || null,
        historical_valid_to: sn.valid_to || null,
        report_e164: reportE164,
        current_e164: currentE164,
      },
      terminal: true,
      escalationReason: 'stale_intake_mapping',
    };
  }

  // Historical sim_number but we can't compare MDNs (missing current). Escalate
  // — never silently fall through to vendor remediation against stale context.
  return {
    mode: 'S7b',
    action: 'escalate',
    outcome: 'escalate',
    evidenceSummary: {
      reason: 'stale_intake_mapping_indeterminate',
      sim_number_id: report.sim_number_id || null,
      historical_e164: sn.e164 || null,
      historical_valid_to: sn.valid_to || null,
      report_e164: reportE164,
      current_e164: currentE164,
    },
    terminal: true,
    escalationReason: 'stale_intake_mapping',
  };
}
