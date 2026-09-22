// =========================================================
// Pure decision logic for the offline SIM lifecycle.
//
// A Teltik-hosted line that goes offline used to stay assigned to the reseller,
// so the reseller counted our dead line as a broken rental. The hourly tick in
// src/bad-rental-remediator/offline-lifecycle.mjs turns the offline signal
// (hosting_port_status_checks) into three coupled effects: pause rotation, tell
// the reseller the rental is closed, unassign. Recovery reverses all three.
//
// Everything here is pure: no fetch, no env, no clock of its own (callers pass
// `now`). Same pattern as src/shared/rotation-baseline.mjs, and for the same
// reason: the interesting failure modes (flapping, midnight boundaries, an
// operator's manual rotation pause) are cheap to unit-test and expensive to
// reproduce against a live carrier.
//
// Two rules encoded here that the executor must never re-decide:
//   1. Inside the CURRENT rotation window we never rotate. The reseller gets
//      the same number back via a re-sent number.online; normal cadence rotates
//      it later. For Teltik a change-number inside the 48h window is rejected
//      outright (status=FAILED, src/teltik-worker/index.js), which would burn
//      rotation_fail_count for nothing.
//   2. rotation_eligible is only resumed when WE paused it
//      (rotation_pause_reason='host_offline'). NULL means an operator paused
//      the line and recovery must leave it alone.
// =========================================================

// Written to sims.rotation_pause_reason and reseller_sims.deactivated_reason
// when this lifecycle is the actor. Any other value (including NULL) means an
// operator acted, and recovery must not undo it.
export const OFFLINE_PAUSE_REASON = 'host_offline';
// data.reason on the number.offline webhook. Distinct from a rotation offline,
// which carries replaced_by instead.
export const OFFLINE_WEBHOOK_REASON = 'line_offline';
// Two consecutive offline checks before we act. One check is a blip; the second
// is a line. Combined with the offline_state latch this is the whole
// anti-flapping story on the way down.
export const MIN_CONSECUTIVE_OFFLINE_CHECKS = 2;
// A check older than this is history, not a reading. Without the bound, a tick
// that resumes after the prober was down for a day would act on yesterday's
// state; with it, the tick waits for fresh checks instead.
export const CHECK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Teltik lines rotate on a per-SIM interval; this mirrors the default used by
// rotateTeltikSims and isTeltikDue (src/shared/rotation-baseline.mjs).
export const DEFAULT_TELTIK_INTERVAL_HOURS = 48;

// Checks newest-first, tolerating any input order. Rows without a usable
// checked_at sort last rather than poisoning the comparison.
function newestFirst(checks) {
  return (Array.isArray(checks) ? checks : [])
    .filter((c) => c && typeof c.state === 'string')
    .map((c) => ({ ...c, _ts: Date.parse(c.checked_at || '') }))
    .sort((a, b) => (Number.isNaN(b._ts) ? -Infinity : b._ts) - (Number.isNaN(a._ts) ? -Infinity : a._ts));
}

function isFresh(check, now) {
  if (!check) return false;
  const ts = Date.parse(check.checked_at || '');
  if (Number.isNaN(ts)) return false;
  return nowMs(now) - ts <= CHECK_MAX_AGE_MS;
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const t = Date.parse(now);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

// A confirmed outage: the two newest checks both say offline, and the newest
// one is recent enough to be a reading. 'error' and 'unknown' never count as
// offline (normalizeHostPortState guarantees a read failure is 'error'), so a
// Teltik API outage can never mass-unassign the fleet.
export function shouldConfirmOffline(checks, now) {
  const ordered = newestFirst(checks);
  if (ordered.length < MIN_CONSECUTIVE_OFFLINE_CHECKS) return false;
  if (!isFresh(ordered[0], now)) return false;
  return ordered.slice(0, MIN_CONSECUTIVE_OFFLINE_CHECKS).every((c) => c.state === 'offline');
}

// A confirmed recovery: the newest check says online. One is enough on the way
// up, because the cost of acting early is a re-sent number.online, while the
// cost of waiting is a reseller holding a line we know works. The recovery
// cooldown in the executor is what stops a flapping line looping.
export function shouldConfirmOnline(checks, now) {
  const ordered = newestFirst(checks);
  if (!ordered.length) return false;
  if (!isFresh(ordered[0], now)) return false;
  return ordered[0].state === 'online';
}

// YYYY-MM-DD in America/New_York, DST-aware. Same Intl approach as
// midnightNYAfterInterval (src/reseller-sync/index.js) and nyNow
// (src/bad-rental-remediator/notify.mjs).
function nyDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
}

// Is the SIM still inside the rotation window it is currently serving?
//   teltik        : last_mdn_rotated_at + rotation_interval_hours > now.
//   atomic/helix  : last_mdn_rotated_at is the same America/New_York calendar
//                   day as now (those vendors rotate nightly).
// A SIM that has never rotated is NOT inside a window: there is no current
// number commitment to honour, so recovery may mint a fresh one.
export function insideRotationWindow(sim, now) {
  const last = sim && sim.last_mdn_rotated_at;
  if (!last) return false;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return false;
  const nowTs = nowMs(now);
  if ((sim.vendor || '') === 'teltik') {
    const hours = Number(sim.rotation_interval_hours) || DEFAULT_TELTIK_INTERVAL_HOURS;
    return lastMs + hours * 60 * 60 * 1000 > nowTs;
  }
  return nyDate(lastMs) === nyDate(nowTs);
}

// A SIM the lifecycle may act on at all. port_in_pending lines are mid-port:
// their MDN is about to change under us and the carrier is already mid-flight,
// so they are skipped entirely (see the PROD port-in poller side effect).
export function isLifecycleEligible(sim) {
  if (!sim) return false;
  if (sim.status !== 'active') return false;
  if (sim.port_in_pending === true) return false;
  return true;
}

// True when the SIM currently sits on an active reseller assignment.
function isAssigned(assignment) {
  return !!(assignment && assignment.active === true);
}

// True when the assignment is one WE closed and may therefore reopen.
function isRestorable(assignment) {
  return !!(assignment && assignment.active === false
    && assignment.deactivated_reason === OFFLINE_PAUSE_REASON);
}

// The OFFLINE transition, in execution order. The webhook goes out BEFORE the
// unassign because the webhook senders resolve the reseller through
// reseller_sims.active=true and early-return once the row is inactive.
// A never-assigned SIM gets the rotation pause and the latch only.
export function planOfflineActions(sim, assignment) {
  const actions = [];
  if (sim && sim.rotation_eligible !== false) {
    actions.push({ type: 'pause_rotation', reason: OFFLINE_PAUSE_REASON });
  }
  if (isAssigned(assignment)) {
    actions.push({
      type: 'send_offline_webhook',
      reason: OFFLINE_WEBHOOK_REASON,
      reseller_id: assignment.reseller_id,
    });
    actions.push({ type: 'unassign_reseller', reason: OFFLINE_PAUSE_REASON, reseller_id: assignment.reseller_id });
  }
  actions.push({ type: 'latch_offline' });
  return actions;
}

// The ONLINE transition, in execution order. Restoring the assignment is step
// one for the same reason the offline webhook is sent before the unassign: no
// number event can reach the reseller while reseller_sims.active is false.
export function planRecoveryActions(sim, assignment, now) {
  const actions = [];
  const restorable = isRestorable(assignment);
  if (restorable) {
    actions.push({ type: 'restore_assignment', reseller_id: assignment.reseller_id });
  }
  if (sim && sim.rotation_pause_reason === OFFLINE_PAUSE_REASON) {
    actions.push({ type: 'resume_rotation' });
  }
  if (restorable || isAssigned(assignment)) {
    if (insideRotationWindow(sim, now)) {
      // Same number, no carrier write: the reseller's current rental reopens
      // on the existing sim_number_id and normal cadence rotates it later.
      actions.push({ type: 'resend_online', reseller_id: (assignment && assignment.reseller_id) || null });
    } else {
      actions.push({
        type: 'force_rotate',
        vendor: (sim && sim.vendor) || null,
        // Rotation fires offline(old) + online(new) and mints the fresh rental
        // itself, so no separate webhook step follows.
        target: (sim && sim.vendor) === 'teltik' ? 'teltik_worker' : 'mdn_rotator',
      });
    }
  }
  actions.push({ type: 'latch_online' });
  return actions;
}
