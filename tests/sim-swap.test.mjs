// Tests for src/shared/sim-swap.mjs — pure logic behind the ATOMIC SIM swap
// (change ICCID in place). No network/DB here; the dashboard handler is the
// thin glue that wires these to relayFetch + Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ICCID_RE,
  to10DigitMsisdn,
  resolveMsisdn,
  resolveZip,
  validateNewIccid,
  buildSwapSimRequest,
  isSwapSuccess,
  swapErrorMessage,
} from '../src/shared/sim-swap.mjs';

test('ICCID_RE matches a real 89-prefixed ICCID, rejects dummy/IMEI', () => {
  assert.ok(ICCID_RE.test('8901240197155370510'));   // 19 digits, 89-prefix
  assert.ok(!ICCID_RE.test('356719117453485'));        // 15-digit dummy
  assert.ok(!ICCID_RE.test('89012'));                  // too short
  assert.ok(!ICCID_RE.test('1234567890123456789'));    // no 89 prefix
});

test('to10DigitMsisdn strips +1 and non-digits', () => {
  assert.equal(to10DigitMsisdn('+13322408354'), '3322408354');
  assert.equal(to10DigitMsisdn('1-332-240-8354'), '3322408354');
  assert.equal(to10DigitMsisdn('3322408354'), '3322408354');
  assert.equal(to10DigitMsisdn(''), null);
  assert.equal(to10DigitMsisdn(null), null);
  assert.equal(to10DigitMsisdn('1234567'), null);       // too short
  assert.equal(to10DigitMsisdn('123456789012'), null);  // too long
});

test('resolveMsisdn prefers sims.msisdn, falls back to active e164', () => {
  assert.equal(resolveMsisdn({ msisdn: '3322408354' }), '3322408354');
  assert.equal(resolveMsisdn({ msisdn: null, sim_numbers: [{ e164: '+13322408354' }] }), '3322408354');
  assert.equal(resolveMsisdn({ msisdn: null, sim_numbers: [] }), null);
  assert.equal(resolveMsisdn({}), null);
  assert.equal(resolveMsisdn(null), null);
});

test('resolveZip prefers explicit input, falls back to activation_zip', () => {
  assert.equal(resolveZip('98104', { activation_zip: '10001' }), '98104');
  assert.equal(resolveZip('  ', { activation_zip: '10001' }), '10001');
  assert.equal(resolveZip('', { activation_zip: null }), null);
});

test('validateNewIccid enforces format, difference', () => {
  assert.deepEqual(validateNewIccid('8901240197155370510', '8901240197155370999'), { ok: true });
  assert.equal(validateNewIccid('356719117453485', '8901240197155370999').ok, false); // bad format
  assert.deepEqual(validateNewIccid('8901240197155370510', '8901240197155370510'), { ok: false, error: 'New ICCID is the same as the current ICCID' }); // same as current
  assert.deepEqual(validateNewIccid('', '8901240197155370999'), { ok: false, error: 'New ICCID is required' }); // missing
});

test('buildSwapSimRequest produces the wholeSaleApi envelope', () => {
  const req = buildSwapSimRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    msisdn: '3322408354',
    zipCode: '98104',
    newSim: '8901240197155370510',
  });
  assert.deepEqual(req, {
    wholeSaleApi: {
      session: { userName: 'u', token: 't', pin: 'p' },
      wholeSaleRequest: {
        requestType: 'swapSIM',
        MSISDN: '3322408354',
        zipCode: '98104',
        newSim: '8901240197155370510',
      },
    },
  });
});

test('isSwapSuccess / swapErrorMessage read the ATOMIC response', () => {
  const ok = { wholeSaleApi: { wholeSaleResponse: { statusCode: '00', description: 'OK' } } };
  const bad = { wholeSaleApi: { wholeSaleResponse: { statusCode: '14', description: 'Invalid SIM' } } };
  assert.equal(isSwapSuccess(ok), true);
  assert.equal(isSwapSuccess(bad), false);
  assert.equal(isSwapSuccess(null), false);
  assert.equal(swapErrorMessage(bad, 200), 'ATOMIC statusCode 14: Invalid SIM');
  assert.equal(swapErrorMessage(null, 502), 'ATOMIC swapSIM HTTP 502');
});
