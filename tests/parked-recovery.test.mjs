import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isParkedCandidate,
  parkedSince,
  classifyParkedError,
  parkedBackoffAllows,
  countSameErrorFails,
  decideParkedAction,
  PARKED_LIFETIME_SAME_ERROR_CAP,
} from '../src/shared/parked-recovery.mjs';

const NOW = Date.parse('2026-07-17T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

// ── SIM #8549 regression ────────────────────────────────────────────────────
// Parked at status='rotation_failed' since 2026-07-04 with a body=FAILED
// error — invisible to the tonight-windowed queries for 13 days. Must be a
// candidate and must route to a (bounded) force-rotate.
const SIM_8549 = {
  id: 8549, vendor: 'teltik', status: 'rotation_failed', rotation_status: 'failed',
  msisdn: '3092422988',
  last_rotation_at: '2026-07-04T08:45:43.372043Z',
  last_mdn_rotated_at: '2026-07-04T08:45:40Z',
  last_rotation_error: 'Error: change-number body status=FAILED: {"request_id":3441417,"status":"FAILED"}',
};

test('8549 regression: parked rotation_failed SIM aged 13 days is a candidate', () => {
  assert.equal(isParkedCandidate(SIM_8549, NOW), true);
});

test('8549 regression: body=FAILED routes to force-rotate when vendor MDN unchanged', () => {
  const d = decideParkedAction(SIM_8549, '3092422988');
  assert.equal(d.action, 'rotate');
  assert.equal(d.class, 'teltik_body_failed');
});

test('8549 regression: parkedSince prefers last_rotation_at', () => {
  assert.equal(parkedSince(SIM_8549), SIM_8549.last_rotation_at);
});

// ── Candidate detection ─────────────────────────────────────────────────────
test('active + rotation_status=failed aged > 6h is a candidate', () => {
  assert.equal(isParkedCandidate({
    vendor: 'teltik', status: 'active', rotation_status: 'failed',
    last_rotation_at: hoursAgo(7),
  }, NOW), true);
});

test('failure younger than 6h is NOT a candidate (tonight-windowed stages own it)', () => {
  assert.equal(isParkedCandidate({
    vendor: 'teltik', status: 'rotation_failed', rotation_status: 'failed',
    last_rotation_at: hoursAgo(2),
  }, NOW), false);
});

test('missing timestamps count as aged (candidate)', () => {
  assert.equal(isParkedCandidate({
    vendor: 'teltik', status: 'rotation_failed', rotation_status: 'failed',
  }, NOW), true);
});

test('healthy teltik SIM is not a candidate', () => {
  assert.equal(isParkedCandidate({
    vendor: 'teltik', status: 'active', rotation_status: 'success',
    last_rotation_at: daysAgo(10),
  }, NOW), false);
});

// ── Host-vs-vendor guard (SIM #639 lesson) ──────────────────────────────────
test('SIM 639 guard: vendor=atomic never a candidate even if teltik-hosted and parked', () => {
  assert.equal(isParkedCandidate({
    vendor: 'atomic', status: 'rotation_failed', rotation_status: 'failed',
    last_rotation_at: daysAgo(5),
  }, NOW), false);
});

test('SIM 639 guard: decideParkedAction refuses non-teltik vendor', () => {
  const d = decideParkedAction({ vendor: 'atomic', msisdn: '1112223333', last_rotation_error: 'change-number failed 502' }, '9998887777');
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'vendor_guard');
});

// ── Vendor-MDN-changed flip ─────────────────────────────────────────────────
test('vendor MDN differs → refresh (flip to mdn_pending), never force-rotate', () => {
  const d = decideParkedAction({ ...SIM_8549, msisdn: '3092422988' }, '7195550101');
  assert.equal(d.action, 'refresh');
});

test('vendor MDN unknown (null) falls through to error classification', () => {
  const d = decideParkedAction(SIM_8549, null);
  assert.equal(d.action, 'rotate');
});

// ── Error classification ────────────────────────────────────────────────────
test('transient classes allow rotate: 502, timeout, body=FAILED, stuck, mdn-unchanged', () => {
  for (const err of [
    'Error: change-number failed 502: error code: 502',
    'Error: change-number failed 500',
    'MDN did not change within 30m (Teltik returned 2624522454)',
    'stuck in rotating for 3h — worker died mid-rotation',
    'Error: change-number body status=FAILED: {"request_id":1}',
    'TypeError: fetch failed',
  ]) {
    assert.equal(classifyParkedError(err).transient, true, err);
  }
});

test('logical failures escalate, never force: invalid ICCID / not found / deactivated / not eligible', () => {
  for (const err of [
    'change-number failed 404: Invalid ICCID',
    'MSISDN not found',
    'Line is deactivated',
    'SIM not eligible for number change',
    'Account cancelled at carrier',
  ]) {
    const cls = classifyParkedError(err);
    assert.equal(cls.transient, false, err);
    assert.equal(decideParkedAction({ vendor: 'teltik', msisdn: '1', last_rotation_error: err }, '1').action, 'escalate', err);
  }
});

test('logical wins over transient tokens in the same error', () => {
  assert.equal(classifyParkedError('change-number failed 404: Invalid ICCID after 502 retry').transient, false);
});

test('unknown errors escalate', () => {
  assert.equal(classifyParkedError('some brand new failure mode').transient, false);
  assert.equal(classifyParkedError(null).transient, false);
});

// ── Backoff schedule ────────────────────────────────────────────────────────
test('backoff: daily for first 3 days parked', () => {
  for (const d of [0, 1, 2, 3]) {
    assert.equal(parkedBackoffAllows(daysAgo(d), NOW), true, `day ${d}`);
  }
});

test('backoff: after day 3 only every 3rd day', () => {
  assert.equal(parkedBackoffAllows(daysAgo(4), NOW), false);
  assert.equal(parkedBackoffAllows(daysAgo(5), NOW), false);
  assert.equal(parkedBackoffAllows(daysAgo(6), NOW), true);
  assert.equal(parkedBackoffAllows(daysAgo(7), NOW), false);
  assert.equal(parkedBackoffAllows(daysAgo(9), NOW), true);
  assert.equal(parkedBackoffAllows(daysAgo(12), NOW), true);
  assert.equal(parkedBackoffAllows(daysAgo(13), NOW), false);
});

test('backoff: unknown park time allows attempt', () => {
  assert.equal(parkedBackoffAllows(null, NOW), true);
});

// ── Lifetime same-error hard stop ───────────────────────────────────────────
test('countSameErrorFails counts only parked_rotate fails of the same class', () => {
  const attempts = [
    ...Array.from({ length: 8 }, () => ({ action: 'parked_rotate', result: 'fail', error: 'class=teltik_body_failed; status=500' })),
    { action: 'parked_rotate', result: 'fail', error: 'class=transient_transport; timeout' },
    { action: 'parked_rotate', result: 'ok', error: null },
    { action: 'force_rotate', result: 'fail', error: 'class=teltik_body_failed; x' },
  ];
  assert.equal(countSameErrorFails(attempts, 'teltik_body_failed'), 8);
  assert.equal(countSameErrorFails(attempts, 'transient_transport'), 1);
  assert.equal(countSameErrorFails(attempts, 'teltik_body_failed') >= PARKED_LIFETIME_SAME_ERROR_CAP, true);
});

test('countSameErrorFails: empty/undefined history is zero', () => {
  assert.equal(countSameErrorFails([], 'logical'), 0);
  assert.equal(countSameErrorFails(undefined, 'logical'), 0);
});
