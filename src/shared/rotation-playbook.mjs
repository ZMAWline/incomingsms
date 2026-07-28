// Rotation Review Playbook
//
// Each entry describes a known rotation failure pattern + how to remediate it.
// The /rotation-review endpoint in details-finalizer iterates through this list
// when classifying failed SIMs, and either auto-fixes (if `action` is something
// other than 'human_review') or surfaces the SIM in the report for operator
// review.
//
// Adding a new pattern = edit this file, deploy details-finalizer. No DB
// migration, no schema change. Order matters — first match wins.
//
// `match(err)` receives the SIM's `last_rotation_error` string; return true to
// claim the SIM. Keep the regex anchored / specific to avoid false positives.
//
// Actions:
//   - 'flip_to_mdn_pending'  PATCH sims SET status='provisioning', rotation_status='mdn_pending'.
//                            Finalizer's next 5-min tick will pick it up,
//                            call get-phone-number, sync the new MDN, fire
//                            number.online. Use when vendor rotated the SIM
//                            but our worker died before capturing the response.
//   - 'force_rotate'         Hit the worker's /rotate-sim?iccid=X&force=true.
//                            Bounded by maxAttempts in the playbook entry AND
//                            by the global 3-per-SIM-per-NY-day budget enforced
//                            via the `attempts_today` SQL helper.
//   - 'human_review'         Don't touch. Surface in the report's
//                            "Failures needing human review" section.

import { isTeltikInvalidIccidError } from './teltik-iccid.mjs';

export const PLAYBOOK = [
  // ── Teltik ──────────────────────────────────────────────────────────────
  {
    id: 'teltik_invalid_iccid',
    vendor: 'teltik',
    // Shared detector — catches the change-number 404 (body carries "Invalid
    // ICCID") AND the query-step 404 (error string omits the body). sync_iccid
    // re-verifies via get-info-by-MDN before patching, so a loose match is safe.
    match: (err) => isTeltikInvalidIccidError(err),
    action: 'sync_iccid',
    description: 'Teltik swapped the physical SIM card for this line — our DB has the old ICCID. Call /v1/get-info with the MDN to resolve the new ICCID, update sims.iccid, then flip to mdn_pending so the teltik finalizer picks up the current MDN.',
    safe: true,
  },
  {
    id: 'teltik_already_rotated',
    vendor: 'teltik',
    match: (err) => /Only 1 number change allowed/i.test(err || ''),
    action: 'flip_to_mdn_pending',
    description: 'Teltik rotated the SIM but our worker died before capturing the response (typical when CF killed the worker mid-parallel-drain). Teltik\'s own "1 per 48h" guard proves the rotation happened. Flipping to mdn_pending lets finalizer pick up the new MDN via get-phone-number.',
    safe: true,
  },
  {
    id: 'teltik_body_failed',
    vendor: 'teltik',
    match: (err) => /change-number body status=FAILED/i.test(err || ''),
    action: 'force_rotate',
    maxAttempts: 1,
    description: 'Teltik returned HTTP 200 with body status=FAILED for the change-number request. The bodies carry no reason field and a later retry typically succeeds (operator-observed pattern; auto-retry enabled 2026-06-12). No MDN was burned (FAILED = no rotation happened). If it keeps failing, the 3/day budget caps attempts and multi-day detection escalates after 3 consecutive days.',
    safe: true,
  },
  {
    id: 'teltik_mdn_unchanged',
    vendor: 'teltik',
    match: (err) => /MDN did not change within \d+m \(Teltik returned/i.test(err || ''),
    action: 'human_review',
    description: 'Teltik accepted the change-number request but get-phone-number kept returning the OLD MDN for 30 min. Possibly Teltik\'s internal queue is stuck for that SIM. Manual intervention recommended.',
    safe: false,
  },

  // ── Stuck-sweeper (any vendor) ──────────────────────────────────────────
  {
    id: 'stuck_sweeper',
    vendor: 'any',
    match: (err) => /^stuck in rotating/.test(err || ''),
    action: 'force_rotate',
    maxAttempts: 1,
    description: 'Worker died mid-rotation (CF wall-clock or relay timeout). claim_rotation_slot guarded against double-claim; safe to retry once. If retry returns "Only 1 per 48h" for teltik, the teltik_already_rotated playbook entry catches the second attempt.',
    safe: true,
  },

  // ── Atomic (apex PPU flow) ──────────────────────────────────────────────
  {
    id: 'atomic_ppu_exhausted',
    vendor: 'atomic',
    match: (err) => /PPU exhausted \d+ attempts/i.test(err || ''),
    action: 'force_rotate',
    maxAttempts: 1,
    description: 'All 3 PPU addresses rejected by AT&T verifier in one rotation attempt. Self-heal has quarantined the bad addresses; one more force-rotate likely picks fresh OSM entries and succeeds. If retry also exhausts, may need a pool refill (see /refill-pool).',
    safe: true,
  },
  {
    id: 'atomic_pre_swap_504',
    vendor: 'atomic',
    match: (err) => /pre-swap inquiry failed:\s*5\d\d/i.test(err || ''),
    action: 'force_rotate',
    maxAttempts: 2,
    description: 'AT&T returned 5xx on subsriberInquiry. Usually transient — their endpoint hiccups for a few minutes at a time. Retry with backoff.',
    safe: true,
  },
  {
    id: 'atomic_pre_swap_logical',
    vendor: 'atomic',
    match: (err) => /pre-swap inquiry failed:\s*(?!5\d\d)/i.test(err || '')
                 || /pre-swap inquiry failed:\s*Error!!unable to inquire/i.test(err || ''),
    action: 'human_review',
    description: 'AT&T pre-swap inquiry returned a non-5xx error (e.g., "unable to inquire subscriber profile"). Means the SIM\'s state at AT&T is wrong — wrong account, suspended/disconnected, ICCID mismatch. Won\'t self-heal.',
    safe: false,
  },
  {
    id: 'atomic_address_invalid',
    vendor: 'atomic',
    match: (err) => /UpdateSubscriberInfo failed: City is blank/i.test(err || '')
                 || /UpdateSubscriberInfo failed: Invalid MSISDN/i.test(err || ''),
    action: 'human_review',
    description: 'Address pool entry has incomplete data (missing city, etc.) OR the SIM\'s msisdn is in a bad state. First case = quarantine the address; second = SIM-level fix.',
    safe: false,
  },
  {
    id: 'swap_zip_rejected',
    vendor: 'atomic',
    match: (err) => /zipCode Not Supported/i.test(err || ''),
    action: 'human_review',
    description: 'AT&T (CINGULAR) does not support phone numbers in the zip code we tried to swap to. The PPU update succeeded but swapMSISDN refused. Pool entry should be removed for that zip, or the area-code map updated. Force-rotate will hit the same wall.',
    safe: false,
  },

  // ── Wing IoT ────────────────────────────────────────────────────────────
  {
    id: 'wing_iot_abir_stuck',
    vendor: 'wing_iot',
    match: (err) => /already on ABIR/i.test(err || '') || /non-dialable/i.test(err || ''),
    action: 'human_review',
    description: 'Wing IoT SIM is stuck on the non-dialable plan. Usually a per-SIM AT&T-side issue or daily plan-change quota. The mdn-rotator\'s stuck-wing remediation handles this in the regular cron; manual investigation only if it persists for 2+ days.',
    safe: false,
  },

  // ── Catch-all: transient transport errors (any vendor) ─────────────────
  // MUST stay last — specific entries above win first. Encodes the operator's
  // observed pattern "most failures go through once I retry": any failure
  // that looks like a network/vendor hiccup (5xx, relay 530, timeout, socket
  // drop) gets ONE automatic retry per run, still bounded by the 3/day budget
  // and the circuit breaker. Logical rejections (zip not supported, cancelled
  // at carrier, data mismatch) never match this and still escalate.
  {
    id: 'generic_transient',
    vendor: 'any',
    match: (err) => /\b5\d\d\b|timeout|timed out|network|fetch failed|TypeError|ECONN|socket|relay/i.test(err || ''),
    action: 'force_rotate',
    maxAttempts: 1,
    description: 'Unrecognized failure that looks transport-level (5xx/timeout/network). One bounded automatic retry; if it persists across days, multi-day detection escalates to the operator.',
    safe: true,
  },
];

// Resolve a failed SIM to its playbook entry. Returns null if no match.
export function classifyFailure(sim) {
  const err = sim.last_rotation_error || '';
  const vendor = sim.vendor || 'unknown';
  for (const entry of PLAYBOOK) {
    if (entry.vendor !== 'any' && entry.vendor !== vendor) continue;
    if (entry.match(err)) return entry;
  }
  return null;
}

// Bucket name used in the report when a SIM matched no playbook entry.
export const UNCLASSIFIED_BUCKET = 'unclassified';
