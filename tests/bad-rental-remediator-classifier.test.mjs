// Tests for INC-18 / INC-16b — vendor classifier, IMEI correctness check,
// cooldown engine, and §H.2 forbidden-action property test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyVendor,
  FORBIDDEN_ACTIONS,
  ALLOWED_ACTIONS,
  ALL_SITUATION_IDS,
  normalizeMdn,
} from '../src/bad-rental-remediator/classifier.mjs';
import {
  checkImeiCorrectness,
  expectedDeviceType,
} from '../src/bad-rental-remediator/imei-check.mjs';
import {
  COOLDOWN_TABLE,
  canAttempt,
  nextReviewAt,
  idempotencyKey,
} from '../src/bad-rental-remediator/cooldown.mjs';

// ---------------------------------------------------------
// IMEI correctness check (§B)
// ---------------------------------------------------------

test('expectedDeviceType: wing_iot→router, atomic/helix/teltik→phone', () => {
  assert.equal(expectedDeviceType('wing_iot'), 'router');
  assert.equal(expectedDeviceType('atomic'), 'phone');
  assert.equal(expectedDeviceType('helix'), 'phone');
  assert.equal(expectedDeviceType('teltik'), 'phone');
  assert.equal(expectedDeviceType('other'), null);
});

test('checkImeiCorrectness: phone IMEI on Wing → imei_wrong_type', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'wing_iot', imei: '111111111111111' },
    pool: { device_type: 'phone' },
    gatewayImei: '111111111111111',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'imei_wrong_type');
});

test('checkImeiCorrectness: router IMEI on Atomic → imei_wrong_type', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'atomic', imei: '222222222222222' },
    pool: { device_type: 'router' },
    gatewayImei: '222222222222222',
    vendorImei: '222222222222222',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'imei_wrong_type');
});

test('checkImeiCorrectness: gateway IMEI differs from DB → imei_drift_gateway', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'atomic', imei: '333333333333333' },
    pool: { device_type: 'phone' },
    gatewayImei: '444444444444444',
    vendorImei: '333333333333333',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'imei_drift_gateway');
});

test('checkImeiCorrectness: vendor IMEI differs from DB (Atomic) → imei_drift_vendor', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'atomic', imei: '333333333333333' },
    pool: { device_type: 'phone' },
    gatewayImei: '333333333333333',
    vendorImei: '999999999999999',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'imei_drift_vendor');
});

test('checkImeiCorrectness: Wing has no vendor IMEI → still ok when pool+gateway match', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'wing_iot', imei: '555555555555555' },
    pool: { device_type: 'router' },
    gatewayImei: '555555555555555',
    vendorImei: null,
  });
  assert.equal(r.ok, true);
});

test('checkImeiCorrectness: IMEI not in pool', () => {
  const r = checkImeiCorrectness({
    sim: { vendor: 'helix', imei: '777777777777777' },
    pool: null,
    gatewayImei: '777777777777777',
    vendorImei: '777777777777777',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'imei_not_in_pool');
});

// ---------------------------------------------------------
// Cooldown engine (§G)
// ---------------------------------------------------------

test('COOLDOWN_TABLE matches §G specification', () => {
  assert.equal(COOLDOWN_TABLE.db_sync_upsert.maxAttempts, 1);
  assert.equal(COOLDOWN_TABLE.resend_online.maxAttempts, 2);
  assert.equal(COOLDOWN_TABLE.resend_online.cooldownMs, 60 * 60 * 1000);
  assert.equal(COOLDOWN_TABLE.atomic_ota.cooldownMs, 24 * 60 * 60 * 1000);
  assert.equal(COOLDOWN_TABLE.verify_send_sms.maxAttempts, 3);
  assert.equal(COOLDOWN_TABLE.verify_send_sms.cooldownMs, 60 * 1000);
  assert.equal(COOLDOWN_TABLE.classify_only.cooldownMs, 2 * 60 * 60 * 1000);
});

test('canAttempt: rejects when max_attempts reached', () => {
  const r = canAttempt({
    action: 'atomic_ota', priorAttempts: 1,
    lastAttemptAt: new Date('2026-01-01T00:00:00Z'),
    now: new Date('2026-01-03T00:00:00Z'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'max_attempts_reached');
});

test('canAttempt: rejects inside cooldown window', () => {
  const r = canAttempt({
    action: 'resend_online', priorAttempts: 1,
    lastAttemptAt: new Date('2026-01-01T00:00:00Z'),
    now: new Date('2026-01-01T00:30:00Z'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown_active');
  assert.equal(r.nextEligibleAt, '2026-01-01T01:00:00.000Z');
});

test('canAttempt: allows past cooldown', () => {
  const r = canAttempt({
    action: 'resend_online', priorAttempts: 1,
    lastAttemptAt: new Date('2026-01-01T00:00:00Z'),
    now: new Date('2026-01-01T01:01:00Z'),
  });
  assert.equal(r.ok, true);
});

test('canAttempt: db_sync_upsert has no cooldown', () => {
  const r = canAttempt({
    action: 'db_sync_upsert', priorAttempts: 0,
    lastAttemptAt: null, now: new Date(),
  });
  assert.equal(r.ok, true);
});

test('nextReviewAt: schedules cooldown forward', () => {
  const t = nextReviewAt({ action: 'atomic_ota', now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(t, '2026-01-02T00:00:00.000Z');
});

test('nextReviewAt: null cooldown returns null', () => {
  assert.equal(nextReviewAt({ action: 'db_sync_upsert', now: new Date() }), null);
});

test('idempotencyKey shapes per §G column 3', () => {
  assert.equal(idempotencyKey('db_sync_upsert',  { sim_id: 'S1' }), 'db_sync_upsert:S1');
  assert.equal(idempotencyKey('resend_online',   { report_id: 'R', sim_id: 'S', attempt_no: 2 }),
    'resend_online:R:S:2');
  assert.equal(idempotencyKey('atomic_restore',  { msisdn: '+15551112222' }),
    'atomic_restore:+15551112222');
  assert.equal(idempotencyKey('wing_put_dialable', { iccid: '8901240000000000001' }),
    'wing_put_dialable:8901240000000000001');
  assert.equal(idempotencyKey('teltik_reset_port', { mdn10: '5551112222' }),
    'teltik_reset_port:5551112222');
  assert.equal(idempotencyKey('verify_send_sms',
    { report_id: 'R', attempt_no: 1, nonce: 'abc12345' }),
    'verify_send_sms:R:1:abc12345');
  assert.equal(idempotencyKey('classify_only',
    { report_id: 'R', mode: 'A10' }), 'classify_only:R:A10');
});

test('idempotencyKey: missing field throws', () => {
  assert.throws(() => idempotencyKey('db_sync_upsert', {}), /missing_idempotency_field/);
});

// ---------------------------------------------------------
// Classifier — vendor pending (no vendor read) returns pending_vendor_read
// ---------------------------------------------------------

const baseSim = (vendor, overrides) => ({
  vendor, status: 'active', current_mdn_e164: '+15551112222', imei: '111111111111111',
  ...(overrides || {}),
});

test('classifyVendor: returns null for unknown vendor', () => {
  const r = classifyVendor({ sim: { vendor: 'other' } });
  assert.equal(r, null);
});

for (const vendor of ['atomic', 'wing_iot', 'helix', 'teltik']) {
  test(`classifyVendor: ${vendor} with no vendor view → pending_vendor_read`, () => {
    const r = classifyVendor({ sim: baseSim(vendor), vendorView: null });
    assert.equal(r.id, 'pending_vendor_read');
    assert.equal(r.vendor, vendor);
    assert.equal(r.auto_action, 'classify_only');
  });
}

// ---------------------------------------------------------
// Atomic A1..A10 fixtures
// ---------------------------------------------------------

test('A1 Atomic: active+delivered+reseller still bad → atomic_ota', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222', BLIMEI: '111111111111111' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: true,
  });
  assert.equal(r.id, 'A1');
  assert.equal(r.auto_action, 'atomic_ota');
  assert.equal(r.retry.cooldown_label, '24h');
});

test('A2 Atomic: vendor active, DB stale → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('atomic', { status: 'suspended' }),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'A2');
  assert.equal(r.auto_action, 'db_sync_upsert');
});

test('A3 Atomic: suspended → atomic_restore', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Suspended', MSISDN: '+15551112222' },
  });
  assert.equal(r.id, 'A3');
  assert.equal(r.auto_action, 'atomic_restore');
});

test('A4 Atomic: cancelled, no active rental → close_duplicate', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Cancelled' },
    cancelGuard: { activeRentalExists: false },
  });
  assert.equal(r.id, 'A4');
  assert.equal(r.auto_action, 'close_duplicate');
});

test('A4 Atomic: cancelled + active rental → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Deactivated' },
    cancelGuard: { activeRentalExists: true },
  });
  assert.equal(r.id, 'A4');
  assert.equal(r.auto_action, 'escalate');
  assert.equal(r.escalation_reason, 'vendor_cancelled_active_rental');
});

test('A5 Atomic: ICCID not found → escalate vendor_iccid_not_found', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { not_found: true },
  });
  assert.equal(r.id, 'A5');
  assert.equal(r.escalation_reason, 'vendor_iccid_not_found');
});

test('A6 Atomic: vendor active, webhook missing → resend_online (2 try, 1h)', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: false },
  });
  assert.equal(r.id, 'A6');
  assert.equal(r.auto_action, 'resend_online');
  assert.equal(r.retry.max_attempts, 2);
});

test('A7 Atomic: IMEI drift vendor (correct type) → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: false, reason: 'imei_drift_vendor' },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'A7');
  assert.equal(r.auto_action, 'db_sync_upsert');
});

test('A8 Atomic: IMEI wrong type → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: false, reason: 'imei_wrong_type' },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'A8');
  assert.equal(r.auto_action, 'escalate');
  assert.equal(r.escalation_reason, 'imei_wrong_type');
});

test('A9 Atomic: MDN differs DB vs vendor → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15559998888' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'A9');
  assert.equal(r.auto_action, 'db_sync_upsert');
});

test('A10 Atomic: unable to reproduce → classify_only, escalates after 3 ticks', () => {
  const r1 = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: false,
    priorAttempts: 0,
  });
  assert.equal(r1.id, 'A10');
  assert.equal(r1.auto_action, 'classify_only');

  const r2 = classifyVendor({
    sim: baseSim('atomic'),
    vendorView: { attStatus: 'Active', MSISDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: false,
    priorAttempts: 2,
  });
  assert.equal(r2.auto_action, 'escalate');
  assert.equal(r2.escalation_reason, 'unable_to_reproduce_recommendation');
});

// ---------------------------------------------------------
// Wing W1..W9 fixtures
// ---------------------------------------------------------

const WING_DIAL = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
const WING_NOND = 'Wing Tel Inc - ABIR 25Mbps SMS MO/MT US';

test('W1 Wing: active dialable, DB stale → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot', { status: 'suspended' }),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'W1');
});

test('W2 Wing: active, webhook missing → resend_online', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: false },
  });
  assert.equal(r.id, 'W2');
});

test('W3 Wing: active dialable + delivered + reseller bad → resend_online (no OTA)', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: true,
  });
  assert.equal(r.id, 'W3');
  assert.equal(r.auto_action, 'resend_online');
});

test('W4 Wing: not Activated → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Inactive', communicationPlan: WING_DIAL },
  });
  assert.equal(r.id, 'W4');
  assert.equal(r.auto_action, 'escalate');
});

test('W5 Wing: ICCID not found → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { not_found: true },
  });
  assert.equal(r.id, 'W5');
});

test('W6 Wing: vendor MDN differs → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15559998888' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'W6');
});

test('W7 Wing: ABIR plan (non-dialable) → wing_put_dialable', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_NOND, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'W7');
  assert.equal(r.auto_action, 'wing_put_dialable');
});

test('W8 Wing: phone IMEI on Wing → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15551112222' },
    imeiCheck: { ok: false, reason: 'imei_wrong_type' },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'W8');
});

test('W9 Wing: unable to reproduce', () => {
  const r = classifyVendor({
    sim: baseSim('wing_iot'),
    vendorView: { status: 'Activated', communicationPlan: WING_DIAL, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: false,
  });
  assert.equal(r.id, 'W9');
});

// ---------------------------------------------------------
// Helix H1..H9 fixtures
// ---------------------------------------------------------

test('H1 Helix: active, DB stale → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('helix', { status: 'suspended' }),
    vendorView: { state: 'Active', subscriberNumber: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'H1');
});

test('H2 Helix: active, webhook missing → resend_online', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Active', subscriberNumber: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: false },
  });
  assert.equal(r.id, 'H2');
});

test('H3 Helix: active + delivered + reseller bad → helix_ota', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Active', subscriberNumber: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: true,
  });
  assert.equal(r.id, 'H3');
  assert.equal(r.auto_action, 'helix_ota');
});

test('H4 Helix: suspended → helix_unsuspend', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Suspended' },
  });
  assert.equal(r.id, 'H4');
  assert.equal(r.auto_action, 'helix_unsuspend');
});

test('H5 Helix: cancelled, no active rental → close_duplicate', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Cancelled' },
    cancelGuard: { activeRentalExists: false },
  });
  assert.equal(r.id, 'H5');
  assert.equal(r.auto_action, 'close_duplicate');
});

test('H5 Helix: cancelled + active rental → escalate vendor_cancelled_active_rental', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Cancelled' },
    cancelGuard: { activeRentalExists: true },
  });
  assert.equal(r.escalation_reason, 'vendor_cancelled_active_rental');
});

test('H6 Helix: not found → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { not_found: true },
  });
  assert.equal(r.id, 'H6');
});

test('H7 Helix: MDN differs → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Active', subscriberNumber: '+15559998888' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'H7');
});

test('H8 Helix: IMEI wrong/drift → escalate (4.8 forbidden)', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Active', subscriberNumber: '+15551112222' },
    imeiCheck: { ok: false, reason: 'imei_drift_vendor' },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'H8');
  assert.equal(r.auto_action, 'escalate');
});

test('H9 Helix: unable to reproduce', () => {
  const r = classifyVendor({
    sim: baseSim('helix'),
    vendorView: { state: 'Active', subscriberNumber: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'H9');
});

// ---------------------------------------------------------
// Teltik T1..T11 fixtures
// ---------------------------------------------------------

test('T1 Teltik: healthy, DB stale → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('teltik', { status: 'suspended' }),
    vendorView: { port_status: 'active', MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T1');
});

test('T2 Teltik: webhook missing → resend_online', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: false },
  });
  assert.equal(r.id, 'T2');
});

test('T3 Teltik: healthy + delivered + reseller bad → teltik_reset_network', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
    recentResellerBadSignal: true,
  });
  assert.equal(r.id, 'T3');
  assert.equal(r.auto_action, 'teltik_reset_network');
});

test('T4 Teltik: port pending > 6h → teltik_reset_port', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'pending', port_pending_hours: 7, MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T4');
  assert.equal(r.auto_action, 'teltik_reset_port');
});

test('T5 Teltik: port offline → teltik_reset_port', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'offline', MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T5');
});

test('T6 Teltik: suspended, no active rental → close_duplicate', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { line_state: 'suspended' },
    cancelGuard: { activeRentalExists: false },
  });
  assert.equal(r.id, 'T6');
  assert.equal(r.auto_action, 'close_duplicate');
});

test('T7 Teltik: not found → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { not_found: true },
  });
  assert.equal(r.id, 'T7');
});

test('T8 Teltik: MDN differs → db_sync_upsert', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15559998888' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T8');
});

test('T9 Teltik: forward URL misconfigured → escalate (operator-only)', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15551112222', forward_url_misconfigured: true },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T9');
});

test('T10 Teltik: IMEI check fails → escalate', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15551112222' },
    imeiCheck: { ok: false, reason: 'imei_wrong_type' },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T10');
});

test('T11 Teltik: unable to reproduce', () => {
  const r = classifyVendor({
    sim: baseSim('teltik'),
    vendorView: { port_status: 'active', MDN: '+15551112222' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(r.id, 'T11');
});

// ---------------------------------------------------------
// MDN normalization
// ---------------------------------------------------------

test('normalizeMdn: strips +1 and non-digits', () => {
  assert.equal(normalizeMdn('+15551112222'), '5551112222');
  assert.equal(normalizeMdn('1 (555) 111-2222'), '5551112222');
  assert.equal(normalizeMdn('5551112222'), '5551112222');
  assert.equal(normalizeMdn(null), null);
});

// ---------------------------------------------------------
// §H.2 forbidden-action property test
// ---------------------------------------------------------

test('Property: FORBIDDEN_ACTIONS and ALLOWED_ACTIONS are disjoint', () => {
  for (const f of FORBIDDEN_ACTIONS) {
    assert.equal(ALLOWED_ACTIONS.includes(f), false, 'allowed leaked forbidden: ' + f);
  }
});

// Brute-force property test: enumerate a wide combinatorial space of inputs and
// assert the classifier never emits a §H.2 forbidden action.
test('Property: classifier never emits a forbidden action (combinatorial sweep)', () => {
  const vendors = ['atomic', 'wing_iot', 'helix', 'teltik'];
  const dbStatuses = ['active', 'suspended', 'cancelled', 'retired', 'pending', 'unknown'];
  const vendorStatuses = ['Active', 'Suspended', 'Cancelled', 'Deactivated', 'Inactive', 'Activated'];
  const plans = [WING_DIAL, WING_NOND, ''];
  const portStatuses = ['active', 'offline', 'pending', 'in_progress', ''];
  const imeiStates = [
    null,
    { ok: true },
    { ok: false, reason: 'imei_wrong_type' },
    { ok: false, reason: 'imei_drift_vendor' },
    { ok: false, reason: 'imei_drift_gateway' },
    { ok: false, reason: 'imei_not_in_pool' },
  ];
  const webhooks = [{ delivered: true }, { delivered: false }];
  const cancelGuards = [
    { activeRentalExists: false }, { activeRentalExists: true },
  ];
  const resellerSignals = [true, false];
  const priorAttemptCounts = [0, 1, 2, 5];
  const mdnPairs = [
    ['+15551112222', '+15551112222'],
    ['+15551112222', '+15559998888'],
  ];

  let combos = 0;
  const forbiddenSet = new Set(FORBIDDEN_ACTIONS);
  for (const vendor of vendors)
  for (const dbStatus of dbStatuses)
  for (const vStatus of vendorStatuses)
  for (const plan of plans)
  for (const port of portStatuses)
  for (const imei of imeiStates)
  for (const wh of webhooks)
  for (const cg of cancelGuards)
  for (const rs of resellerSignals)
  for (const pa of priorAttemptCounts)
  for (const [dbMdn, vendorMdn] of mdnPairs) {
    combos++;
    const sim = { vendor, status: dbStatus, current_mdn_e164: dbMdn, imei: '111111111111111' };
    const vendorView = {
      attStatus: vStatus, status: vStatus, state: vStatus,
      MSISDN: vendorMdn, MDN: vendorMdn, subscriberNumber: vendorMdn,
      communicationPlan: plan,
      port_status: port,
      port_pending_hours: port === 'pending' ? 7 : 0,
      line_state: vStatus.toLowerCase(),
    };
    let r;
    try {
      r = classifyVendor({
        sim, vendorView, imeiCheck: imei, webhook: wh,
        cancelGuard: cg, recentResellerBadSignal: rs, priorAttempts: pa,
      });
    } catch (e) {
      // §H.2 hard guard inside S(): rethrow with combo info to surface offender.
      throw new Error('classifier threw on combo: ' + e.message + ' / ' + JSON.stringify({ vendor, vStatus, plan, port }));
    }
    if (!r) continue;
    assert.equal(forbiddenSet.has(r.auto_action), false,
      'forbidden action ' + r.auto_action + ' for situation ' + r.id);
  }
  // Sanity: we actually exercised a meaningful number of combos.
  assert.ok(combos > 5000, 'expected >5000 combos, got ' + combos);
});

test('Property: every situation id the classifier emits is in ALL_SITUATION_IDS', () => {
  const seen = new Set();
  const vendors = ['atomic', 'wing_iot', 'helix', 'teltik'];
  const vendorStatuses = ['Active', 'Suspended', 'Cancelled', 'Deactivated', 'Inactive', 'Activated'];
  for (const vendor of vendors)
  for (const vStatus of vendorStatuses) {
    const r = classifyVendor({
      sim: { vendor, status: 'active', current_mdn_e164: '+15551112222', imei: '111111111111111' },
      vendorView: {
        attStatus: vStatus, status: vStatus, state: vStatus,
        MSISDN: '+15551112222', MDN: '+15551112222', subscriberNumber: '+15551112222',
        port_status: 'active',
      },
      imeiCheck: { ok: true },
      webhook: { delivered: true },
      cancelGuard: { activeRentalExists: false },
      recentResellerBadSignal: false,
      priorAttempts: 0,
    });
    if (r) seen.add(r.id);
  }
  for (const id of seen) {
    assert.ok(ALL_SITUATION_IDS.includes(id), 'situation id missing from ALL_SITUATION_IDS: ' + id);
  }
});

// ---------------------------------------------------------
// Teltik MDN boundary — classifier itself never strips digits
// ---------------------------------------------------------

test('Teltik MDN boundary: classifier never mutates sim.current_mdn_e164', () => {
  const sim = baseSim('teltik');
  const before = sim.current_mdn_e164;
  classifyVendor({
    sim,
    vendorView: { port_status: 'active', MDN: '+15559998888' },
    imeiCheck: { ok: true },
    webhook: { delivered: true },
  });
  assert.equal(sim.current_mdn_e164, before);
  // And the classifier never produces a 10-digit MDN in evidence — it leaves
  // both representations alone. teltik.mdn10(e164) at the API boundary is the
  // only place stripping happens.
});
