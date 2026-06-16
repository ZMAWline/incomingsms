import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMissedDueNightly,
  isTeltikDue,
  isDeliveryGap,
  inNightlyRotationWindow,
} from '../src/shared/rotation-baseline.mjs';

const TONIGHT = '2026-06-12T04:00:00Z'; // NY midnight as UTC ISO

test('isMissedDueNightly: never-rotated SIM is missed', () => {
  assert.equal(isMissedDueNightly({ last_mdn_rotated_at: null, activated_at: null }, TONIGHT), true);
});

test('isMissedDueNightly: rotated yesterday is missed', () => {
  assert.equal(isMissedDueNightly({ last_mdn_rotated_at: '2026-06-11T05:00:00Z', activated_at: null }, TONIGHT), true);
});

test('isMissedDueNightly: rotated tonight is not missed', () => {
  assert.equal(isMissedDueNightly({ last_mdn_rotated_at: '2026-06-12T05:10:00Z', activated_at: null }, TONIGHT), false);
});

test('isMissedDueNightly: activated today is not missed (new SIM grace)', () => {
  assert.equal(isMissedDueNightly({ last_mdn_rotated_at: null, activated_at: '2026-06-12T06:00:00Z' }, TONIGHT), false);
});

test('isMissedDueNightly: no tonightStart → never flags', () => {
  assert.equal(isMissedDueNightly({ last_mdn_rotated_at: null, activated_at: null }, null), false);
});

test('isTeltikDue: never rotated is due', () => {
  assert.equal(isTeltikDue({ last_mdn_rotated_at: null }, Date.parse('2026-06-12T12:00:00Z')), true);
});

test('isTeltikDue: 49h since rotation with default 48h interval is due', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  assert.equal(isTeltikDue({ last_mdn_rotated_at: '2026-06-10T11:00:00Z' }, now), true);
});

test('isTeltikDue: 47h since rotation is not due', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  assert.equal(isTeltikDue({ last_mdn_rotated_at: '2026-06-10T13:00:00Z' }, now), false);
});

test('isTeltikDue: honors per-SIM rotation_interval_hours', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  const sim = { last_mdn_rotated_at: '2026-06-11T11:00:00Z', rotation_interval_hours: 24 };
  assert.equal(isTeltikDue(sim, now), true);
});

test('isDeliveryGap: rotated, never notified', () => {
  assert.equal(isDeliveryGap({ last_mdn_rotated_at: '2026-06-12T05:00:00Z', last_notified_at: null }), true);
});

test('isDeliveryGap: notified before rotation (stale)', () => {
  assert.equal(isDeliveryGap({
    last_mdn_rotated_at: '2026-06-12T05:00:00Z',
    last_notified_at: '2026-06-11T05:00:00Z',
  }), true);
});

test('isDeliveryGap: notified after rotation is fine', () => {
  assert.equal(isDeliveryGap({
    last_mdn_rotated_at: '2026-06-12T05:00:00Z',
    last_notified_at: '2026-06-12T05:00:30Z',
  }), false);
});

test('isDeliveryGap: never rotated is not a gap', () => {
  assert.equal(isDeliveryGap({ last_mdn_rotated_at: null, last_notified_at: null }), false);
});

test('inNightlyRotationWindow: 4:00 and 15:59 UTC inside, 3:59 and 16:00 outside', () => {
  assert.equal(inNightlyRotationWindow(new Date('2026-06-12T04:00:00Z')), true);
  assert.equal(inNightlyRotationWindow(new Date('2026-06-12T15:59:00Z')), true);
  assert.equal(inNightlyRotationWindow(new Date('2026-06-12T03:59:00Z')), false);
  assert.equal(inNightlyRotationWindow(new Date('2026-06-12T16:00:00Z')), false);
  assert.equal(inNightlyRotationWindow(new Date('2026-06-12T22:00:00Z')), false);
});
