import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingInputError, isCalendarDate, isDateRange, sanitizeTiers, validateEffectiveDates } from '../src/dashboard/billing/validation.mjs';

test('billing dates distinguish leap days from impossible dates', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', null]) assert.equal(isCalendarDate(date), false);
  assert.equal(isDateRange('2026-10-01', '2026-10-01'), true);
  assert.equal(isDateRange('2026-10-02', '2026-10-01'), false);
  assert.throws(() => validateEffectiveDates('2026-10-02', '2026-10-01'), BillingInputError);
});

test('tier boundaries are inclusive, sorted and may end with an open range', () => {
  const original = [
    { min_count: '101', max_count: null, rate: '1.00' },
    { min_count: '0', max_count: '100', rate: '1.55' },
  ];
  assert.deepEqual(sanitizeTiers(original), [
    { min_count: 0, max_count: 100, rate: 1.55 },
    { min_count: 101, max_count: null, rate: 1 },
  ]);
  assert.equal(original[0].min_count, '101', 'validation must not mutate the submitted object');
});

test('ambiguous or malformed pricing tiers are rejected', () => {
  for (const tiers of [
    [], [null], [{ min_count: 0, max_count: null, rate: Infinity }],
    [{ min_count: null, max_count: null, rate: 1 }],
    [{ min_count: 0, max_count: 1.5, rate: 1 }],
    [{ min_count: 0, max_count: null, rate: 1 }, { min_count: 100, max_count: null, rate: 0.5 }],
  ]) assert.throws(() => sanitizeTiers(tiers), BillingInputError);
});
