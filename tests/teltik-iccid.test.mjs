// Tests for the shared Teltik Invalid-ICCID detectors + heal-patch builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTeltikInvalidIccidResponse,
  isTeltikInvalidIccidError,
  iccidSwapStatusReason,
  iccidSwapPatch,
} from '../src/shared/teltik-iccid.mjs';

// ---- isTeltikInvalidIccidResponse (body-based) -------------------------

test('response detector: 404 + parsed object body', () => {
  assert.equal(isTeltikInvalidIccidResponse(404, { message: 'Invalid ICCID.' }), true);
});

test('response detector: 404 + JSON string body', () => {
  assert.equal(isTeltikInvalidIccidResponse(404, '{"message":"Invalid ICCID."}'), true);
});

test('response detector: 404 + plain text body', () => {
  assert.equal(isTeltikInvalidIccidResponse(404, 'Invalid ICCID'), true);
});

test('response detector: non-404 is not a match', () => {
  assert.equal(isTeltikInvalidIccidResponse(200, { message: 'Invalid ICCID.' }), false);
});

test('response detector: 404 with a different message is not a match', () => {
  assert.equal(isTeltikInvalidIccidResponse(404, { message: 'Rate limited' }), false);
});

// ---- isTeltikInvalidIccidError (string-based) --------------------------

test('error detector: change-number 404 with appended body', () => {
  assert.equal(isTeltikInvalidIccidError('change-number failed 404: {"message":"Invalid ICCID."}'), true);
});

test('error detector: query-step 404 (body NOT in the string)', () => {
  assert.equal(isTeltikInvalidIccidError('Teltik query HTTP 404 at 2026-06-29T20:24:48.492Z'), true);
  assert.equal(isTeltikInvalidIccidError('Teltik query failed: 404'), true);
});

test('error detector: unrelated errors do not match', () => {
  assert.equal(isTeltikInvalidIccidError('Only 1 number change allowed per 48h'), false);
  assert.equal(isTeltikInvalidIccidError('change-number body status=FAILED'), false);
  assert.equal(isTeltikInvalidIccidError(''), false);
  assert.equal(isTeltikInvalidIccidError(null), false);
});

// ---- patch builders -----------------------------------------------------

test('iccidSwapStatusReason composes the audit note', () => {
  assert.equal(
    iccidSwapStatusReason('OLD', 'NEW', '2026-06-29T00:00:00.000Z'),
    'ICCID swapped from OLD to NEW on 2026-06-29T00:00:00.000Z',
  );
});

test('iccidSwapPatch adopts new iccid + clears rotation-failure state', () => {
  const p = iccidSwapPatch('OLD', 'NEW', '2026-06-29T00:00:00.000Z');
  assert.equal(p.iccid, 'NEW');
  assert.equal(p.status, 'active');
  assert.equal(p.rotation_status, 'success');
  assert.equal(p.rotation_fail_count, 0);
  assert.equal(p.last_rotation_error, null);
  assert.match(p.status_reason, /ICCID swapped from OLD to NEW/);
});
