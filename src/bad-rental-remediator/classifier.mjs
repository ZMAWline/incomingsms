// =========================================================
// BAD-RENTAL REMEDIATOR — Vendor classifier (INC-18 / INC-16b)
//
// Pure logic. No vendor I/O, no DB I/O. Given a pre-fetched evidence
// bundle (DB + vendor read + IMEI check + webhook delivery state), returns
// a discriminated-union situation per Plan v4 §F.1–§F.4:
//
//   Atomic  : A1..A10
//   Wing IoT: W1..W9
//   Helix   : H1..H9
//   Teltik  : T1..T11
//
// Each situation carries:
//   { id, vendor, auto_action, retry, auto_resolve_when,
//     on_failure, evidence_bundle }
//
// auto_action is a token from §G; the worker reads it and decides
// whether to execute (gated by 16d/16e wiring). Until then, the worker
// records `classify_only`.
//
// Forbidden actions (§H.2) NEVER appear in a classifier output —
// property-tested in tests/bad-rental-remediator-classifier.test.mjs.
// =========================================================

// -----------------------------------------------------------------------
// Action vocabulary
// -----------------------------------------------------------------------

// §H.1 auto-allowed actions (worker may execute when wired)
export const ALLOWED_ACTIONS = Object.freeze([
  'db_sync_upsert',
  'resend_online',
  'atomic_ota',          // resendOtaProfile
  'atomic_restore',      // restoreSubscriber reasonCode=CR
  'wing_put_dialable',   // PUT NON ABIR plan
  'helix_ota',           // endpoint 4.11
  'helix_unsuspend',     // 4.6 reasonCode CR/35
  'teltik_reset_network',
  'teltik_reset_port',
  'teltik_sync_iccid',   // T12 — DB-only ICCID resync after a physical SIM swap
  'close_duplicate',     // §E
  'escalate',            // operator escalation
  'classify_only',       // record + reschedule, no side-effects
]);

// §H.2 ALWAYS operator-only. Classifier MUST never emit any of these.
export const FORBIDDEN_ACTIONS = Object.freeze([
  // rotation / swap / replacement
  'rotate_mdn', 'mdn_swap', 'sim_swap', 'sim_replace',
  // cancel / deactivate
  'atomic_cancel', 'atomic_suspend', 'atomic_deactivate',
  'helix_cancel', 'helix_resume_on_cancel',
  'wing_set_non_dialable',
  'teltik_change_number', 'teltik_sim_swap',
  // IMEI writes
  'imei_rewrite_gateway', 'imei_rewrite_vendor', 'helix_change_imei',
  // freeform reseller-facing
  'reseller_freeform_sms', 'reseller_freeform_message',
  // misc forbidden
  'helix_change_iccid', 'helix_change_plan', 'helix_update_ctn',
  'atomic_swap_msisdn', 'atomic_update_subscriber_info',
  'teltik_forward_url_change',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_ACTIONS);

// -----------------------------------------------------------------------
// Situation factory
// -----------------------------------------------------------------------

function S({ id, vendor, auto_action, retry, auto_resolve_when, on_failure, evidence_bundle, escalation_reason }) {
  if (FORBIDDEN_SET.has(auto_action)) {
    // Hard guard. Tests assert this never fires.
    throw new Error('classifier_forbidden_action:' + auto_action + ' for situation ' + id);
  }
  return Object.freeze({
    id,
    vendor,
    auto_action,
    retry: retry || { max_attempts: 0, cooldown_label: 'n/a' },
    auto_resolve_when: auto_resolve_when || 'n/a',
    on_failure: on_failure || 'operator',
    evidence_bundle: evidence_bundle || {},
    escalation_reason: escalation_reason || null,
  });
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

// classifyVendor(input) returns one Situation OR null if no vendor branch fits.
// Input shape (all pure data):
//   {
//     sim: { vendor, status, imei, current_mdn_e164, ... },
//     vendorView: { ... vendor-specific read result } | null,
//     imeiCheck: { ok, reason, db_imei, vendor_imei, gateway_imei, ... } | null,
//     webhook:   { delivered: bool, lastDeliveredAt, ... },
//     report:    { id, received_at, ... },
//     priorAttempts: int,  // count for classify_only ticks
//     cancelGuard: { activeRentalExists: bool, evidence },
//   }
export function classifyVendor(input) {
  const vendor = String(input?.sim?.vendor || '').toLowerCase();
  if (vendor === 'atomic')   return classifyAtomic(input);
  if (vendor === 'wing_iot') return classifyWing(input);
  if (vendor === 'helix')    return classifyHelix(input);
  if (vendor === 'teltik')   return classifyTeltik(input);
  return null;
}

// -----------------------------------------------------------------------
// §F.1 Atomic — A1..A10
// -----------------------------------------------------------------------

function classifyAtomic(input) {
  const sim = input.sim || {};
  const v = input.vendorView || null;
  const imei = input.imeiCheck || null;
  const wh = input.webhook || {};
  const priorClassifyOnly = input.priorAttempts || 0;

  // No vendor read yet — defer to classify_only.
  if (!v) return pendingVendorRead('atomic', sim);

  const status = String(v.attStatus || '').toLowerCase();

  // A5 — ICCID not found
  if (v.not_found) {
    return S({
      id: 'A5', vendor: 'atomic',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'vendor_iccid_not_found',
      evidence_bundle: { vendor_status: 'not_found' },
    });
  }

  // A4 — cancelled / deactivated (cancel-guard handled in worker §E; classifier just routes)
  if (status === 'cancelled' || status === 'canceled' || status === 'deactivated') {
    const active = input.cancelGuard && input.cancelGuard.activeRentalExists;
    return S({
      id: 'A4', vendor: 'atomic',
      auto_action: active ? 'escalate' : 'close_duplicate',
      retry: { max_attempts: 0, cooldown_label: 'n/a' },
      auto_resolve_when: active ? 'n/a' : 'cancel_guard_clean',
      on_failure: 'operator',
      escalation_reason: active ? 'vendor_cancelled_active_rental' : null,
      evidence_bundle: { vendor_status: status, cancel_guard: input.cancelGuard || null },
    });
  }

  // A3 — suspended
  if (status === 'suspended') {
    return S({
      id: 'A3', vendor: 'atomic',
      auto_action: 'atomic_restore',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'vendor_active_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { vendor_status: status },
    });
  }

  // From here on we expect vendor active.
  if (status !== 'active') {
    return S({
      id: 'A10', vendor: 'atomic',
      auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
      retry: { max_attempts: 3, cooldown_label: '2h' },
      on_failure: 'operator',
      escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
      evidence_bundle: { vendor_status: status, attempts: priorClassifyOnly },
    });
  }

  // A8 — IMEI wrong type
  if (imei && imei.ok === false && imei.reason === 'imei_wrong_type') {
    return S({
      id: 'A8', vendor: 'atomic',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'imei_wrong_type',
      evidence_bundle: { imei },
    });
  }

  // A7 — IMEI drift (vendor IMEI ≠ DB IMEI, both correct type)
  if (imei && imei.ok === false && imei.reason === 'imei_drift_vendor') {
    return S({
      id: 'A7', vendor: 'atomic',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { imei },
    });
  }

  // A2 — vendor Active, DB stale
  if (sim.status && String(sim.status).toLowerCase() !== 'active') {
    return S({
      id: 'A2', vendor: 'atomic',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_status: sim.status, vendor_status: status },
    });
  }

  // A9 — MDN differs DB vs vendor
  if (v.MSISDN && sim.current_mdn_e164 && normalizeMdn(v.MSISDN) !== normalizeMdn(sim.current_mdn_e164)) {
    return S({
      id: 'A9', vendor: 'atomic',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_mdn: sim.current_mdn_e164, vendor_mdn: v.MSISDN },
    });
  }

  // A6 — vendor active, webhook missing
  if (!wh.delivered) {
    return S({
      id: 'A6', vendor: 'atomic',
      auto_action: 'resend_online',
      retry: { max_attempts: 2, cooldown_label: '1h' },
      auto_resolve_when: 'webhook_delivered_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // A1 — vendor active, webhook delivered, reseller still reports bad
  if (wh.delivered) {
    // Distinguish A1 from A10: A1 has a recent reseller report signal; the worker
    // injects this as `input.recentResellerBadSignal=true`. Without that signal,
    // fall through to A10 unable-to-reproduce.
    if (input.recentResellerBadSignal) {
      return S({
        id: 'A1', vendor: 'atomic',
        auto_action: 'atomic_ota',
        retry: { max_attempts: 1, cooldown_label: '24h' },
        auto_resolve_when: 'sms_verified',
        on_failure: 'operator',
        evidence_bundle: { webhook: wh },
      });
    }
  }

  // A10 — unable to reproduce; classify_only up to 3 ticks @ 2h
  return S({
    id: 'A10', vendor: 'atomic',
    auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
    retry: { max_attempts: 3, cooldown_label: '2h' },
    auto_resolve_when: 'n/a',
    on_failure: 'operator',
    escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
    evidence_bundle: { webhook: wh, attempts: priorClassifyOnly },
  });
}

// -----------------------------------------------------------------------
// §F.2 Wing IoT — W1..W9
// -----------------------------------------------------------------------

const WING_DIALABLE_PLAN  = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
const WING_NONDIAL_PLAN   = 'Wing Tel Inc - ABIR 25Mbps SMS MO/MT US';

function classifyWing(input) {
  const sim = input.sim || {};
  const v = input.vendorView || null;
  const imei = input.imeiCheck || null;
  const wh = input.webhook || {};
  const priorClassifyOnly = input.priorAttempts || 0;

  if (!v) return pendingVendorRead('wing_iot', sim);

  if (v.not_found) {
    return S({
      id: 'W5', vendor: 'wing_iot',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'vendor_iccid_not_found',
      evidence_bundle: { vendor_status: 'not_found' },
    });
  }

  const status = String(v.status || '').toLowerCase();
  const plan = v.communicationPlan || '';

  // W4 — inactive/suspended
  if (status !== 'activated') {
    return S({
      id: 'W4', vendor: 'wing_iot',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'wing_not_activated',
      evidence_bundle: { vendor_status: status },
    });
  }

  // W8 — IMEI wrong type (phone IMEI on Wing SIM)
  if (imei && imei.ok === false && imei.reason === 'imei_wrong_type') {
    return S({
      id: 'W8', vendor: 'wing_iot',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'imei_wrong_type',
      evidence_bundle: { imei },
    });
  }

  // W7 — mode wrong (non-dialable plan but expected dialable). NEVER set non-dialable.
  if (plan === WING_NONDIAL_PLAN) {
    return S({
      id: 'W7', vendor: 'wing_iot',
      auto_action: 'wing_put_dialable',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'wing_get_dialable_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { plan },
    });
  }

  // W6 — MDN differs DB vs vendor
  if (v.MDN && sim.current_mdn_e164 && normalizeMdn(v.MDN) !== normalizeMdn(sim.current_mdn_e164)) {
    return S({
      id: 'W6', vendor: 'wing_iot',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_mdn: sim.current_mdn_e164, vendor_mdn: v.MDN },
    });
  }

  // W1 — vendor active dialable, DB stale
  if (sim.status && String(sim.status).toLowerCase() !== 'active') {
    return S({
      id: 'W1', vendor: 'wing_iot',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_status: sim.status },
    });
  }

  // W2 — active, webhook missing
  if (!wh.delivered) {
    return S({
      id: 'W2', vendor: 'wing_iot',
      auto_action: 'resend_online',
      retry: { max_attempts: 2, cooldown_label: '1h' },
      auto_resolve_when: 'webhook_delivered_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // W3 — active, dialable, webhook delivered, reseller still bad
  if (input.recentResellerBadSignal) {
    return S({
      id: 'W3', vendor: 'wing_iot',
      // Wing has no OTA — fall back to resend_online + §C SMS verify.
      auto_action: 'resend_online',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // W9 — unable to reproduce
  return S({
    id: 'W9', vendor: 'wing_iot',
    auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
    retry: { max_attempts: 3, cooldown_label: '2h' },
    auto_resolve_when: 'n/a',
    on_failure: 'operator',
    escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
    evidence_bundle: { attempts: priorClassifyOnly },
  });
}

// -----------------------------------------------------------------------
// §F.3 Helix — H1..H9
// -----------------------------------------------------------------------

function classifyHelix(input) {
  const sim = input.sim || {};
  const v = input.vendorView || null;
  const imei = input.imeiCheck || null;
  const wh = input.webhook || {};
  const priorClassifyOnly = input.priorAttempts || 0;

  if (!v) return pendingVendorRead('helix', sim);

  if (v.not_found) {
    return S({
      id: 'H6', vendor: 'helix',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'vendor_iccid_not_found',
      evidence_bundle: { vendor_status: 'not_found' },
    });
  }

  const status = String(v.state || v.status || '').toLowerCase();

  // H5 — cancelled (worker §E owns the close; classifier reports the situation)
  if (status === 'cancelled' || status === 'canceled') {
    const active = input.cancelGuard && input.cancelGuard.activeRentalExists;
    return S({
      id: 'H5', vendor: 'helix',
      auto_action: active ? 'escalate' : 'close_duplicate',
      retry: { max_attempts: 0, cooldown_label: 'n/a' },
      on_failure: 'operator',
      escalation_reason: active ? 'vendor_cancelled_active_rental' : null,
      evidence_bundle: { vendor_status: status, cancel_guard: input.cancelGuard || null },
    });
  }

  // H4 — suspended
  if (status === 'suspended') {
    return S({
      id: 'H4', vendor: 'helix',
      auto_action: 'helix_unsuspend',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'vendor_active_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { vendor_status: status },
    });
  }

  if (status !== 'active') {
    return S({
      id: 'H9', vendor: 'helix',
      auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
      retry: { max_attempts: 3, cooldown_label: '2h' },
      on_failure: 'operator',
      escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
      evidence_bundle: { vendor_status: status },
    });
  }

  // H8 — IMEI wrong / drift — operator-only (4.8 forbidden for auto)
  if (imei && imei.ok === false &&
      (imei.reason === 'imei_wrong_type' || imei.reason === 'imei_drift_vendor' || imei.reason === 'imei_drift_gateway')) {
    return S({
      id: 'H8', vendor: 'helix',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: imei.reason,
      evidence_bundle: { imei },
    });
  }

  // H1 — vendor active, DB stale
  if (sim.status && String(sim.status).toLowerCase() !== 'active') {
    return S({
      id: 'H1', vendor: 'helix',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_status: sim.status },
    });
  }

  // H7 — DB MDN differs from Helix
  const helixMdn = v.subscriberNumber || v.MDN || v.mdn;
  if (helixMdn && sim.current_mdn_e164 && normalizeMdn(helixMdn) !== normalizeMdn(sim.current_mdn_e164)) {
    return S({
      id: 'H7', vendor: 'helix',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_mdn: sim.current_mdn_e164, vendor_mdn: helixMdn },
    });
  }

  // H2 — active, webhook missing
  if (!wh.delivered) {
    return S({
      id: 'H2', vendor: 'helix',
      auto_action: 'resend_online',
      retry: { max_attempts: 2, cooldown_label: '1h' },
      auto_resolve_when: 'webhook_delivered_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // H3 — active, webhook delivered, reseller still bad → OTA refresh
  if (input.recentResellerBadSignal) {
    return S({
      id: 'H3', vendor: 'helix',
      auto_action: 'helix_ota',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // H9 — unable to reproduce
  return S({
    id: 'H9', vendor: 'helix',
    auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
    retry: { max_attempts: 3, cooldown_label: '2h' },
    on_failure: 'operator',
    escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
    evidence_bundle: { attempts: priorClassifyOnly },
  });
}

// -----------------------------------------------------------------------
// §F.4 Teltik — T1..T11
// -----------------------------------------------------------------------

function classifyTeltik(input) {
  const sim = input.sim || {};
  const v = input.vendorView || null;
  const imei = input.imeiCheck || null;
  const wh = input.webhook || {};
  const priorClassifyOnly = input.priorAttempts || 0;

  if (!v) return pendingVendorRead('teltik', sim);

  // T7 — ICCID/MDN not found
  if (v.not_found) {
    return S({
      id: 'T7', vendor: 'teltik',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'vendor_iccid_not_found',
      evidence_bundle: { vendor_status: 'not_found' },
    });
  }

  // T6 — suspended/cancelled at Teltik
  const vendorState = String(v.line_state || v.status || '').toLowerCase();
  if (vendorState === 'suspended' || vendorState === 'cancelled' || vendorState === 'canceled' || vendorState === 'terminated') {
    const active = input.cancelGuard && input.cancelGuard.activeRentalExists;
    return S({
      id: 'T6', vendor: 'teltik',
      auto_action: active ? 'escalate' : 'close_duplicate',
      retry: { max_attempts: 0, cooldown_label: 'n/a' },
      on_failure: 'operator',
      escalation_reason: active ? 'vendor_cancelled_active_rental' : null,
      evidence_bundle: { vendor_status: vendorState, cancel_guard: input.cancelGuard || null },
    });
  }

  // T12 — DB ICCID differs from Teltik's current ICCID (physical SIM-card swap).
  // Teltik 404s "Invalid ICCID" on any call keyed by the OLD iccid (change-number,
  // dashboard query), but the get-info BY MDN above still resolves the line and
  // returns the NEW iccid. Heal by syncing sims.iccid — the MDN is unchanged, so
  // there's no number churn and no reseller webhook. DB-only correction; the next
  // rotation window then rotates the line normally on the new iccid. Placed before
  // the port/IMEI/MDN branches so the identity is corrected first.
  if (v.iccid && sim.iccid && String(v.iccid) !== String(sim.iccid)) {
    return S({
      id: 'T12', vendor: 'teltik',
      auto_action: 'teltik_sync_iccid',
      retry: { max_attempts: 2, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_iccid: sim.iccid, vendor_iccid: v.iccid },
    });
  }

  // T9 — forward URL missing/wrong — operator-only (config)
  if (v.forward_url_misconfigured) {
    return S({
      id: 'T9', vendor: 'teltik',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: 'teltik_forward_url_misconfigured',
      evidence_bundle: { forward_url: v.forward_url || null },
    });
  }

  // T10 — IMEI check fails — operator-only
  if (imei && imei.ok === false) {
    return S({
      id: 'T10', vendor: 'teltik',
      auto_action: 'escalate',
      on_failure: 'operator',
      escalation_reason: imei.reason || 'imei_check_failed',
      evidence_bundle: { imei },
    });
  }

  const port = String(v.port_status || '').toLowerCase();

  // T4 — port stuck pending > 6h
  if ((port === 'pending' || port === 'in_progress' || port === 'in-progress') && v.port_pending_hours >= 6) {
    return S({
      id: 'T4', vendor: 'teltik',
      auto_action: 'teltik_reset_port',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'port_active_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { port_status: port, pending_hours: v.port_pending_hours },
    });
  }

  // T5 — port offline
  if (port === 'offline' || port === 'down') {
    return S({
      id: 'T5', vendor: 'teltik',
      auto_action: 'teltik_reset_port',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'port_online_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { port_status: port },
    });
  }

  // T8 — DB MDN differs from Teltik MDN
  if (v.MDN && sim.current_mdn_e164 && normalizeMdn(v.MDN) !== normalizeMdn(sim.current_mdn_e164)) {
    return S({
      id: 'T8', vendor: 'teltik',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_mdn: sim.current_mdn_e164, vendor_mdn: v.MDN },
    });
  }

  // T1 — vendor healthy, DB stale
  if (sim.status && String(sim.status).toLowerCase() !== 'active') {
    return S({
      id: 'T1', vendor: 'teltik',
      auto_action: 'db_sync_upsert',
      retry: { max_attempts: 1, cooldown_label: 'n/a' },
      auto_resolve_when: 'db_matches_vendor_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { db_status: sim.status },
    });
  }

  // T2 — webhook missing
  if (!wh.delivered) {
    return S({
      id: 'T2', vendor: 'teltik',
      auto_action: 'resend_online',
      retry: { max_attempts: 2, cooldown_label: '1h' },
      auto_resolve_when: 'webhook_delivered_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh },
    });
  }

  // T3 — healthy + delivered + reseller still bad → /reset-network then /reset-port
  if (input.recentResellerBadSignal) {
    return S({
      id: 'T3', vendor: 'teltik',
      // First retry uses /reset-network; the worker escalates to /reset-port on
      // second attempt within the cooldown window.
      auto_action: 'teltik_reset_network',
      retry: { max_attempts: 1, cooldown_label: '24h' },
      auto_resolve_when: 'port_online_and_sms_verified',
      on_failure: 'operator',
      evidence_bundle: { webhook: wh, port_status: port },
    });
  }

  // T11 — unable to reproduce
  return S({
    id: 'T11', vendor: 'teltik',
    auto_action: priorClassifyOnly >= 2 ? 'escalate' : 'classify_only',
    retry: { max_attempts: 3, cooldown_label: '2h' },
    on_failure: 'operator',
    escalation_reason: priorClassifyOnly >= 2 ? 'unable_to_reproduce_recommendation' : null,
    evidence_bundle: { attempts: priorClassifyOnly },
  });
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function pendingVendorRead(vendor, sim) {
  return S({
    id: 'pending_vendor_read', vendor,
    auto_action: 'classify_only',
    retry: { max_attempts: 3, cooldown_label: '2h' },
    auto_resolve_when: 'n/a',
    on_failure: 'operator',
    evidence_bundle: { db_status: sim.status || null },
  });
}

// Strip non-digits and drop leading country digit so E.164 vs 10-digit compare cleanly.
export function normalizeMdn(input) {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// Exposed for the worker so it can record `mode` consistently.
export const ALL_SITUATION_IDS = Object.freeze([
  'A1','A2','A3','A4','A5','A6','A7','A8','A9','A10',
  'W1','W2','W3','W4','W5','W6','W7','W8','W9',
  'H1','H2','H3','H4','H5','H6','H7','H8','H9',
  'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12',
  'pending_vendor_read',
]);
