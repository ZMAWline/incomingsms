import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATOMIC_PORT_IN_BLOCKED_ERROR,
  buildActivationCsvTemplate,
  buildAtomicActivateRequest,
  parseActivationCsv,
  validateActivationSim,
} from '../src/shared/activation-bulk.mjs';

test('existing non-port ATOMIC activation stays blank portMdn', () => {
  const checked = validateActivationSim({ iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic' });
  assert.equal(checked.ok, true);
  assert.equal(checked.sim.port_in, false);
  assert.equal(checked.sim.port_mdn, '');
  const req = buildAtomicActivateRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: checked.sim.iccid,
    imei: checked.sim.imei,
    address: { streetNumber: '1', streetDirection: '', streetName: 'Main St', zipCode: '75001' },
    portMdn: checked.sim.port_mdn,
    partnerTransactionId: 'tx1',
  });
  assert.equal(req.wholeSaleApi.wholeSaleRequest.plan, 'EBNOVOICE');
  assert.equal(req.wholeSaleApi.wholeSaleRequest.portMdn, '');
});

test('complete port-in row is blocked until carrier field names are confirmed', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'yes',
    port_mdn: '+1 (212) 555-0199',
    port_account_number: ' ACCT12345 ',
    port_pin: ' 1234 ',
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.errors.join('\n'), ATOMIC_PORT_IN_BLOCKED_ERROR);
});

test('Atomic Activate request never contains customer port account number or PIN', () => {
  const req = buildAtomicActivateRequest({
    session: { userName: 'u', token: 't', pin: 'DEALER_PIN' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    address: { streetNumber: '1', streetName: 'Main St', zipCode: '75001' },
    portMdn: '',
    partnerTransactionId: 'tx2',
  });
  const serialized = JSON.stringify(req);
  assert.equal(req.wholeSaleApi.wholeSaleRequest.portMdn, '');
  assert.doesNotMatch(serialized, /ACCT12345|port_pin|port_account_number/);
});

test('missing or invalid portMdn blocks a port-in row', () => {
  const missing = validateActivationSim({ iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic', port_in: 'true', port_account_number: 'ACCT12345', port_pin: '1234' });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /port_mdn is required/);

  const invalid = validateActivationSim({ iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic', port_in: 'true', port_mdn: '555', port_account_number: 'ACCT12345', port_pin: '1234' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /10 digits/);
});

test('missing port account number blocks a port-in row', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'true',
    port_mdn: '2125550199',
    port_pin: '1234',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /port_account_number is required/);
});

test('missing port PIN blocks a port-in row', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'true',
    port_mdn: '2125550199',
    port_account_number: 'ACCT12345',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /port_pin is required/);
});

test('CSV template includes headers and new-number plus port-in examples', () => {
  const csv = buildActivationCsvTemplate();
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'iccid,imei,reseller_id,vendor,port_in,port_mdn,port_account_number,port_pin');
  assert.match(lines[1], /atomic,false,,,$/);
  assert.match(lines[2], /atomic,true,2125550199,ACCT12345,1234$/);
});

test('bulk CSV accepts mixed rows and returns row-level errors', () => {
  const csv = [
    'iccid,imei,reseller_id,vendor,port_in,port_mdn,port_account_number,port_pin',
    '89014103271467425631,123456789012345,1,atomic,false,,,',
    '89014103271467425632,123456789012346,1,atomic,true,212-555-0199,ACCT12345,1234',
    '89014103271467425633,123456789012347,1,atomic,true,,ACCT99999,9999',
  ].join('\n');
  const parsed = parseActivationCsv(csv);
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.invalid.length, 2);
  assert.equal(parsed.valid[0].sim.port_mdn, '');
  assert.match(parsed.invalid[0].errors.join('\n'), /Row 3: ATOMIC port-in is not yet available/);
  assert.match(parsed.invalid[1].errors.join('\n'), /port_mdn is required/);
});
