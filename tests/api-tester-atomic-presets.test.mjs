import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'api-tester-presets.js'), 'utf8');

function presetSource(key) {
  const start = PRESETS.indexOf(`'${key}':`);
  assert.ok(start >= 0, `missing preset ${key}`);
  const next = PRESETS.indexOf("\n  '", start + 1);
  return PRESETS.slice(start, next < 0 ? PRESETS.length : next);
}

test('API tester exposes every documented Atomic Wholesale operation', () => {
  for (const key of ['atomic.portinRequest', 'atomic.portinStatus', 'atomic.portinCancel', 'atomic.portinUpdate']) {
    assert.match(PRESETS, new RegExp(`'${key.replace('.', '\\.')}'\\s*:`));
  }
});

test('Atomic Wholesale presets use the documented envelope and request types', () => {
  const expected = {
    portinRequest: ['MSISDN', 'sim', 'eSim', 'BAN', 'imei', 'planCode', 'partnerTransactionId', 'subscriber', 'subscriberNewAddress', 'old_service_provider'],
    portinStatus: ['MSISDN'],
    portinCancel: ['MSISDN', 'zipCode'],
    portinUpdate: ['MSISDN', 'sim', 'imei', 'planCode', 'subscriber', 'subscriberNewAddress', 'old_service_provider'],
  };
  assert.match(PRESETS, /function atomicWholesaleBody[\s\S]*wholeSaleApi[\s\S]*session/);
  for (const [operation, fields] of Object.entries(expected)) {
    const source = presetSource(`atomic.${operation}`);
    assert.match(source, new RegExp(`(?:requestType: ['"]${operation}['"]|atomicWholesaleBody\\(env, ['"]${operation}['"])`));
    for (const field of fields) assert.match(source, new RegExp(`\\b${field}\\b`), `${operation} missing ${field}`);
  }
});

test('portinUpdate does not send fields excluded from the documented update shape', () => {
  const source = presetSource('atomic.portinUpdate');
  for (const field of ['eSim', 'BAN', 'partnerTransactionId']) {
    assert.doesNotMatch(source, new RegExp(`\\b${field}\\b`), `portinUpdate must not send ${field}`);
  }
});

test('read-only and cancel presets keep their documented field boundaries', () => {
  const status = presetSource('atomic.portinStatus');
  assert.match(status, /MSISDN: inputs\.msisdn/);
  assert.doesNotMatch(status, /partnerTransactionId|subscriber|old_service_provider|zipCode/);

  const cancel = presetSource('atomic.portinCancel');
  assert.match(cancel, /MSISDN: inputs\.msisdn/);
  assert.match(cancel, /zipCode: inputs\.zipCode/);
  assert.doesNotMatch(cancel, /partnerTransactionId|subscriber|old_service_provider/);
});
