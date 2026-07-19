// Parked-SIM recovery decision logic (Teltik rotations).
//
// Background (SIM #8549): a Teltik SIM that hits the 5-fail cap parks at
// status='rotation_failed' and drops out of every retry query — the nightly
// review and catch-up sweep only look at rotation_status='failed' rows
// windowed to *tonight*, so a parked SIM sat report-only for 13 days. This
// module is the pure decision layer for the recovery stage in
// details-finalizer (runParkedTeltikRecovery): candidate detection, error
// classification, retry backoff and lifetime caps. Orchestration (vendor
// query, DB writes, budgets via remediation_attempts) stays in the worker.
//
// Scope is strictly vendor='teltik' (sims.vendor routes the API — never the
// hosting side; SIM #639 is Teltik-hosted but vendor='atomic' and must never
// see a Teltik API call).

export const PARKED_MIN_AGE_HOURS = 6;
export const PARKED_MAX_ROTATES_PER_RUN = 10;
export const PARKED_MAX_PROBES_PER_RUN = 30;
export const PARKED_DAILY_ROTATE_CAP = 1;
export const PARKED_LIFETIME_SAME_ERROR_CAP = 8;
export const PARKED_BACKOFF_DAILY_DAYS = 3;

// Timestamp the SIM got stuck at (same fallback chain as the review's stuck
// inventory).
export function parkedSince(sim) {
  return sim.last_rotation_at || sim.last_mdn_rotated_at || null;
}

// A recovery candidate is a teltik SIM parked at status='rotation_failed', or
// still active/provisioning with rotation_status='failed', older than 6h.
// The 6h floor keeps tonight's failures with the existing windowed playbook
// stages (and the teltik-worker in-window retry RPC).
export function isParkedCandidate(sim, nowMs = Date.now()) {
  if (sim.vendor !== 'teltik') return false;
  const parked = sim.status === 'rotation_failed'
    || (['active', 'provisioning'].includes(sim.status) && sim.rotation_status === 'failed');
  if (!parked) return false;
  const t = parkedSince(sim);
  return !t || new Date(t).getTime() < nowMs - PARKED_MIN_AGE_HOURS * 3600 * 1000;
}

// Classify last_rotation_error. transient=true means a bounded force-rotate is
// allowed; everything else escalates to the operator. Order matters: logical
// rejections win even when the text also contains transient-looking tokens.
export function classifyParkedError(err) {
  const e = String(err || '');
  if (/invalid iccid|msisdn not found|subscriber not found|deactivat|not eligible|suspend|cancel/i.test(e)) {
    return { class: 'logical', transient: false };
  }
  if (/change-number body status=FAILED/i.test(e)) return { class: 'teltik_body_failed', transient: true };
  if (/^stuck in rotating/i.test(e)) return { class: 'stuck_rotating', transient: true };
  if (/MDN did not change within \d+m/i.test(e)) return { class: 'mdn_unchanged_timeout', transient: true };
  if (/\b5\d\d\b|timeout|timed out|network|fetch failed|ECONN|socket|relay|TypeError/i.test(e)) {
    return { class: 'transient_transport', transient: true };
  }
  return { class: 'unknown', transient: false };
}

// Retry cadence: daily for the first PARKED_BACKOFF_DAILY_DAYS days parked,
// then only every 3rd day.
export function parkedBackoffAllows(sinceIso, nowMs = Date.now()) {
  if (!sinceIso) return true;
  const days = Math.floor((nowMs - new Date(sinceIso).getTime()) / 86400000);
  if (days <= PARKED_BACKOFF_DAILY_DAYS) return true;
  return days % 3 === 0;
}

// Lifetime hard stop: count prior failed parked_rotate attempts recorded with
// the same error class (recordAttempt stores `class=<cls>; <detail>` on fail).
export function countSameErrorFails(attempts, cls) {
  return (attempts || []).filter(a =>
    a.action === 'parked_rotate' && a.result === 'fail'
    && String(a.error || '').startsWith(`class=${cls}`)
  ).length;
}

// Core routing once the vendor has been queried. vendorMdnBare is the bare
// 10-digit MDN Teltik currently reports for the ICCID (null if unknown).
// If it already differs from our record, Teltik rotated and we only need the
// mdn_pending → finalizer flow — no rotation burned.
export function decideParkedAction(sim, vendorMdnBare) {
  if (sim.vendor !== 'teltik') return { action: 'skip', reason: 'vendor_guard' };
  if (vendorMdnBare && sim.msisdn && vendorMdnBare !== sim.msisdn) return { action: 'refresh' };
  const cls = classifyParkedError(sim.last_rotation_error);
  return { action: cls.transient ? 'rotate' : 'escalate', class: cls.class };
}
