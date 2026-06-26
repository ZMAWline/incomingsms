import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKYLINE_STATE_LABELS, formatGatewayState, parseIccidList } from '../src/shared/skyline-state.mjs';

test('SKYLINE_STATE_LABELS uses full reference labels verbatim', () => {
  assert.equal(SKYLINE_STATE_LABELS[3], 'Registered (ready)');
  assert.equal(SKYLINE_STATE_LABELS[0], 'No SIM card');
  assert.equal(SKYLINE_STATE_LABELS[6], 'Registration failed');
  assert.equal(SKYLINE_STATE_LABELS[16], 'Module response timeout');
  // code 10 is intentionally absent from the reference table
  assert.equal(Object.prototype.hasOwnProperty.call(SKYLINE_STATE_LABELS, 10), false);
});

test('formatGatewayState maps a known code to number + text', () => {
  assert.deepEqual(formatGatewayState(3), {
    state_code: 3,
    state_label: 'Registered (ready)',
    gateway_state: 'State 3 = Registered (ready)',
  });
});

test('formatGatewayState handles code 0 (No SIM card)', () => {
  assert.deepEqual(formatGatewayState(0), {
    state_code: 0,
    state_label: 'No SIM card',
    gateway_state: 'State 0 = No SIM card',
  });
});

test('formatGatewayState coerces numeric strings', () => {
  assert.deepEqual(formatGatewayState('6'), {
    state_code: 6,
    state_label: 'Registration failed',
    gateway_state: 'State 6 = Registration failed',
  });
});

test('formatGatewayState labels unknown codes as Unknown but keeps the number', () => {
  assert.deepEqual(formatGatewayState(10), {
    state_code: 10,
    state_label: 'Unknown',
    gateway_state: 'State 10 = Unknown',
  });
  assert.deepEqual(formatGatewayState(99), {
    state_code: 99,
    state_label: 'Unknown',
    gateway_state: 'State 99 = Unknown',
  });
});

test('formatGatewayState returns all-null for missing state', () => {
  const expected = { state_code: null, state_label: null, gateway_state: null };
  assert.deepEqual(formatGatewayState(null), expected);
  assert.deepEqual(formatGatewayState(undefined), expected);
  assert.deepEqual(formatGatewayState(''), expected);
});

test('parseIccidList: single iccid param', () => {
  assert.deepEqual(parseIccidList('8901A', null), ['8901A']);
});

test('parseIccidList: comma-separated iccids param', () => {
  assert.deepEqual(parseIccidList(null, '8901A,8901B'), ['8901A', '8901B']);
});

test('parseIccidList: merges both params, dedupes, preserves order (single first)', () => {
  assert.deepEqual(parseIccidList('8901A', '8901B,8901A'), ['8901A', '8901B']);
});

test('parseIccidList: trims whitespace and drops empties', () => {
  assert.deepEqual(parseIccidList(null, '8901A, 8901B , ,8901C'), ['8901A', '8901B', '8901C']);
});

test('parseIccidList: returns [] for empty input', () => {
  assert.deepEqual(parseIccidList(null, null), []);
  assert.deepEqual(parseIccidList('', ''), []);
});
