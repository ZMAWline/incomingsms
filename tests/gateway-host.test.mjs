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

test('falls back to vendor when column absent (teltik vendor => teltik host)', () => {
  assert.equal(gatewayHostOf({ vendor: 'teltik' }), TELTIK);
});

test('falls back to skyline for non-teltik vendors when column absent', () => {
  assert.equal(gatewayHostOf({ vendor: 'atomic' }), SKYLINE);
  assert.equal(gatewayHostOf({ vendor: 'helix' }), SKYLINE);
  assert.equal(gatewayHostOf({}), SKYLINE);
});

test('unknown gateway_host value falls back to derivation, never crashes', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'garbage', vendor: 'teltik' }), TELTIK);
});

test('isTeltikHosted / isSkylineHosted', () => {
  assert.equal(isTeltikHosted({ gateway_host: 'teltik' }), true);
  assert.equal(isTeltikHosted({ vendor: 'atomic', gateway_host: 'skyline' }), false);
  assert.equal(isSkylineHosted({ vendor: 'atomic' }), true);
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
