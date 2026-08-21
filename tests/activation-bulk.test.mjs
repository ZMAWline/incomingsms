import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivationCsvTemplate,
  buildAtomicActivateRequest,
  buildAtomicPortInRequest,
  buildAtomicPortInStatusRequest,
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

test('complete port-in row with all required fields passes validation', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'yes',
    port_mdn: '+1 (212) 555-0199',
    port_account_number: ' ACCT12345 ',
    port_pin: ' 1234 ',
    port_first_name: 'John',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.sim.port_in, true);
  assert.equal(checked.sim.port_mdn, '2125550199');
  assert.equal(checked.sim.port_account_number, 'ACCT12345');
  assert.equal(checked.sim.port_pin, '1234');
  assert.equal(checked.sim.port_first_name, 'John');
  assert.equal(checked.sim.port_old_last_name, 'Smith');
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
  const base = { iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic', port_in: 'true', port_account_number: 'ACCT12345', port_pin: '1234', port_first_name: 'J', port_last_name: 'D', port_street_number: '1', port_street_name: 'S', port_zip: '75001', port_old_first_name: 'J', port_old_last_name: 'S' };
  const missing = validateActivationSim({ ...base });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /port_mdn is required/);

  const invalid = validateActivationSim({ ...base, port_mdn: '555' });
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
    port_first_name: 'John',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
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
    port_first_name: 'John',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /port_pin is required/);
});

test('missing port subscriber fields block a port-in row', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'true',
    port_mdn: '2125550199',
    port_account_number: 'ACCT12345',
    port_pin: '1234',
    port_first_name: '',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /port_first_name is required/);
});

test('missing port old_service_provider fields block a port-in row', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'true',
    port_mdn: '2125550199',
    port_account_number: 'ACCT12345',
    port_pin: '1234',
    port_first_name: 'John',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: '',
    port_old_last_name: 'Smith',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /port_old_first_name is required/);
});

test('non-ATOMIC vendor cannot port-in', () => {
  const checked = validateActivationSim({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'helix',
    port_in: 'true',
    port_mdn: '2125550199',
    port_account_number: 'ACCT12345',
    port_pin: '1234',
    port_first_name: 'John',
    port_last_name: 'Doe',
    port_street_number: '123',
    port_street_name: 'Main St',
    port_zip: '75001',
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /Port-in is currently supported only for ATOMIC/);
});

test('CSV template includes headers and new-number plus port-in examples', () => {
  const csv = buildActivationCsvTemplate();
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'iccid,imei,reseller_id,vendor,port_in,port_mdn,port_account_number,port_pin,port_first_name,port_last_name,port_street_number,port_street_name,port_zip,port_old_first_name,port_old_last_name');
  assert.match(lines[1], /atomic,false,,,,,,,,,,$/);
  assert.match(lines[2], /atomic,true,2125550199,ACCT12345,1234,John,Doe,123,Main St,75001,Jane,Smith$/);
});

test('bulk CSV accepts mixed rows and returns row-level errors', () => {
  const csv = [
    'iccid,imei,reseller_id,vendor,port_in,port_mdn,port_account_number,port_pin,port_first_name,port_last_name,port_street_number,port_street_name,port_zip,port_old_first_name,port_old_last_name',
    '89014103271467425631,123456789012345,1,atomic,false,,,,,,,,,,',
    '89014103271467425632,123456789012346,1,atomic,true,212-555-0199,ACCT12345,1234,John,Doe,123,Main St,75001,Jane,Smith',
    '89014103271467425633,123456789012347,1,atomic,true,,ACCT99999,9999,John,Doe,123,Main St,75001,Jane,Smith',
    '89014103271467425634,123456789012348,1,atomic,true,2125550299,ACCT88888,8888,,,,,,,',
  ].join('\n');
  const parsed = parseActivationCsv(csv);
  // Row 1: valid new-number activation. Row 2: valid, COMPLETE port-in (this is
  // the case the old blanket block used to reject outright — it must now pass).
  assert.equal(parsed.valid.length, 2);
  assert.equal(parsed.invalid.length, 2);
  assert.equal(parsed.valid[0].sim.port_mdn, '');
  assert.equal(parsed.valid[1].sim.port_mdn, '2125550199');
  assert.equal(parsed.valid[1].sim.port_old_last_name, 'Smith');
  // Row 3: missing port_mdn. Row 4: missing subscriber/old_service_provider fields.
  assert.match(parsed.invalid[0].errors.join('\n'), /port_mdn is required/);
  assert.match(parsed.invalid[1].errors.join('\n'), /port_first_name is required/);
});

// Regression: the outgoing ATOMIC payload must actually carry every field the
// UI/API collected and validated as required. This is what would have caught
// the original "carrier only supports portMdn" silent-new-number-activation risk
// if the mapping were ever dropped or only partially wired.
test('buildAtomicPortInRequest carries account/PIN/name/address into the outgoing payload', () => {
  const req = buildAtomicPortInRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    portMdn: '2125550199',
    portAccountNumber: 'ACCT12345',
    portPin: 'SECRETPIN',
    firstName: 'John',
    lastName: 'Doe',
    streetNumber: '123',
    streetName: 'Main St',
    zip: '75001',
    oldFirstName: 'Jane',
    oldLastName: 'Smith',
    partnerTransactionId: 'porttx1',
  });
  const wr = req.wholeSaleApi.wholeSaleRequest;
  assert.equal(wr.requestType, 'portinRequest');
  assert.equal(wr.MSISDN, '2125550199');
  assert.equal(wr.sim, '89014103271467425631');
  assert.equal(wr.imei, '123456789012345');
  assert.ok(wr.subscriber, 'subscriber block present');
  assert.equal(wr.subscriber.firstName, 'John');
  assert.equal(wr.subscriber.lastName, 'Doe');
  assert.equal(wr.subscriber.streetNumber, '123');
  assert.equal(wr.subscriber.streetName, 'Main St');
  assert.equal(wr.subscriber.zipCode, '75001');
  assert.ok(wr.old_service_provider, 'old_service_provider block present');
  assert.equal(wr.old_service_provider.billingAccountNumber, 'ACCT12345');
  assert.equal(wr.old_service_provider.billingAccountPassword, 'SECRETPIN');
  assert.equal(wr.old_service_provider.firstName, 'Jane');
  assert.equal(wr.old_service_provider.lastName, 'Smith');
});

test('buildAtomicPortInRequest uses a different requestType than Activate and never falls back to it', () => {
  const activate = buildAtomicActivateRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    address: { streetNumber: '1', streetName: 'Main St', zipCode: '75001' },
    portMdn: '',
    partnerTransactionId: 'tx3',
  });
  assert.equal(activate.wholeSaleApi.wholeSaleRequest.requestType, 'Activate');
  assert.ok(!('old_service_provider' in activate.wholeSaleApi.wholeSaleRequest));

  const portin = buildAtomicPortInRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    portMdn: '2125550199',
    portAccountNumber: 'ACCT12345',
    portPin: '1234',
    firstName: 'John',
    lastName: 'Doe',
    streetNumber: '123',
    streetName: 'Main St',
    zip: '75001',
    oldFirstName: 'Jane',
    oldLastName: 'Smith',
  });
  assert.equal(portin.wholeSaleApi.wholeSaleRequest.requestType, 'portinRequest');
});

test('buildAtomicPortInStatusRequest sends only requestType and MSISDN — no activation/port-in fields', () => {
  const req = buildAtomicPortInStatusRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    msisdn: '2125550199',
  });
  const wr = req.wholeSaleApi.wholeSaleRequest;
  assert.equal(wr.requestType, 'portinStatus');
  assert.equal(wr.MSISDN, '2125550199');
  assert.deepEqual(Object.keys(wr).sort(), ['MSISDN', 'requestType']);
  // Never carries sim/imei/subscriber/old_service_provider/planCode/BAN/eSim —
  // those belong only to portinRequest/portinUpdate and would risk mutating
  // the port instead of just reading its status.
  for (const key of ['sim', 'imei', 'subscriber', 'old_service_provider', 'planCode', 'BAN', 'eSim', 'partnerTransactionId']) {
    assert.ok(!(key in wr), `portinStatus request must not contain "${key}"`);
  }
  assert.deepEqual(req.wholeSaleApi.session, { userName: 'u', token: 't', pin: 'p' });
});

test('buildAtomicPortInStatusRequest uses a distinct requestType from portinRequest/Activate', () => {
  const status = buildAtomicPortInStatusRequest({ session: { userName: 'u', token: 't', pin: 'p' }, msisdn: '2125550199' });
  const portin = buildAtomicPortInRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    portMdn: '2125550199',
    portAccountNumber: 'ACCT12345',
    portPin: '1234',
    firstName: 'John', lastName: 'Doe',
    streetNumber: '123', streetName: 'Main St', zip: '75001',
    oldFirstName: 'Jane', oldLastName: 'Smith',
  });
  const activate = buildAtomicActivateRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    iccid: '89014103271467425631',
    imei: '123456789012345',
    address: { streetNumber: '1', streetName: 'Main St', zipCode: '75001' },
    portMdn: '',
    partnerTransactionId: 'tx4',
  });
  const types = new Set([
    status.wholeSaleApi.wholeSaleRequest.requestType,
    portin.wholeSaleApi.wholeSaleRequest.requestType,
    activate.wholeSaleApi.wholeSaleRequest.requestType,
  ]);
  assert.equal(types.size, 3, 'portinStatus, portinRequest, and Activate must be three distinct requestTypes');
});
