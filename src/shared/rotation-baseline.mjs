// Pure predicates for the expected-vs-actual rotation baseline and the
// delivery-gap check. Kept free of fetch/env so they are unit-testable
// (tests/rotation-baseline.test.mjs) — same pattern as rotation-playbook.mjs.
//
// Why this exists: runRotationReview() historically only tallied SIMs that
// DID rotate, so a night where 92 of 750 due SIMs rotated still reported
// "✅ all clear" (the 2026-05-22 PR-B fallout). These helpers define "due"
// exactly the way the rotation crons do, so the review and the catch-up
// sweep can count the silent misses.

// Non-teltik (atomic / helix / wing_iot) SIMs rotate nightly. A SIM is a
// "missed due" if it is in the eligible set (caller queries: status=active,
// reseller_sims active, rotation_eligible=true, vendor!=teltik) and neither
// rotated nor was activated since NY midnight. Mirrors mdn-rotator
// processBatch eligibility (src/mdn-rotator/index.js ~1419-1431).
export function isMissedDueNightly(sim, tonightStartIso) {
  if (!tonightStartIso) return false;
  const rotatedToday = !!(sim.last_mdn_rotated_at && sim.last_mdn_rotated_at >= tonightStartIso);
  const activatedToday = !!(sim.activated_at && sim.activated_at >= tonightStartIso);
  return !rotatedToday && !activatedToday;
}

// Teltik SIMs rotate on a per-SIM interval (default 48h). Mirrors
// teltik-worker rotateTeltikSims due-filter (src/teltik-worker/index.js ~634).
export function isTeltikDue(sim, nowMs) {
  if (!sim.last_mdn_rotated_at) return true;
  const intervalMs = (sim.rotation_interval_hours || 48) * 60 * 60 * 1000;
  return nowMs - new Date(sim.last_mdn_rotated_at).getTime() >= intervalMs;
}

// A delivery gap: the SIM rotated successfully but the reseller was never
// notified after that rotation. Mirrors runReconciliationSweep Bucket B
// (src/details-finalizer/index.js) — caller pre-filters to status=active,
// rotation_status=success, rotated within the lookback window.
export function isDeliveryGap(sim) {
  if (!sim.last_mdn_rotated_at) return false;
  return !sim.last_notified_at
    || new Date(sim.last_notified_at) < new Date(sim.last_mdn_rotated_at);
}

// The nightly rotation window is 4:00-15:59 UTC (mdn-rotator cron
// `0,20,40 4-15 * * *`). The catch-up sweep must NOT force-rotate
// missed-due SIMs inside the window: the cron may still be working through
// them, and although claim_rotation_slot dedups, there is no reason to race
// it. Failed-SIM remediation is safe at any hour (those rows are already
// stamped, so the cron skips them).
export function inNightlyRotationWindow(date) {
  const h = date.getUTCHours();
  return h >= 4 && h <= 15;
}
