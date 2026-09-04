import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKYLINE, TELTIK,
  gatewayHostOf, isTeltikHosted, isSkylineHosted, gatewaySupports,
} from '../src/shared/gateway-host.mjs';

test('explicit gateway_host wins', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'teltik', vendor: 'atomic' }), TELTIK);
  assert.equal(gatewayHostOf({ gateway_host: 'skyline', vendor: 'teltik' }), SKYLINE);
});

// All live SIMs are Teltik-hosted as of 2026-09-04; the fallback must not
// derive SKYLINE from a non-teltik vendor. Doing so hands an atomic-vendor SIM
// the inverted capability set (setImei true / portReset false).
test('falls back to teltik when column absent, regardless of vendor', () => {
  assert.equal(gatewayHostOf({ vendor: 'teltik' }), TELTIK);
  assert.equal(gatewayHostOf({ vendor: 'atomic' }), TELTIK);
  assert.equal(gatewayHostOf({ vendor: 'helix' }), TELTIK);
  assert.equal(gatewayHostOf({ vendor: 'wing_iot' }), TELTIK);
  assert.equal(gatewayHostOf({}), TELTIK);
  assert.equal(gatewayHostOf(null), TELTIK);
});

// Regression guard: an explicit legacy 'skyline' row must still win over the
// fallback, so historical SkyLine-seated SIMs keep reporting their real host.
test('explicit skyline still wins over the teltik fallback', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'skyline', vendor: 'atomic' }), SKYLINE);
  assert.equal(gatewaySupports({ gateway_host: 'skyline', vendor: 'atomic' }, 'setImei'), true);
});

test('unknown gateway_host value falls back to teltik, never crashes', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'garbage', vendor: 'teltik' }), TELTIK);
  assert.equal(gatewayHostOf({ gateway_host: 'garbage', vendor: 'atomic' }), TELTIK);
});

test('isTeltikHosted / isSkylineHosted', () => {
  assert.equal(isTeltikHosted({ gateway_host: 'teltik' }), true);
  assert.equal(isTeltikHosted({ vendor: 'atomic', gateway_host: 'skyline' }), false);
  assert.equal(isTeltikHosted({ vendor: 'atomic' }), true);
  assert.equal(isSkylineHosted({ vendor: 'atomic' }), false);
  assert.equal(isSkylineHosted({ gateway_host: 'skyline' }), true);
});

// A vendor-less, host-less SIM must get the Teltik capability set: port resets
// available, IMEI writes refused. This is the case the old default got wrong.
test('capability matrix: bare SIM object gets teltik capabilities', () => {
  assert.equal(gatewaySupports({ vendor: 'atomic' }, 'portReset'), true);
  assert.equal(gatewaySupports({ vendor: 'atomic' }, 'setImei'), false);
  assert.equal(gatewaySupports({ vendor: 'atomic' }, 'skylineSms'), false);
});

test('capability matrix: skyline supports IMEI write, teltik does not', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'setImei'), true);
  assert.equal(gatewaySupports({ gateway_host: 'teltik' }, 'setImei'), false);
  assert.equal(gatewaySupports({ vendor: 'atomic', gateway_host: 'teltik' }, 'setImei'), false);
});

test('capability matrix: skyline supports AT-command SMS, teltik does not', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'skylineSms'), true);
  assert.equal(gatewaySupports({ gateway_host: 'teltik' }, 'skylineSms'), false);
});

test('capability matrix: unknown capability is false, not throw', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'nonexistent'), false);
});
