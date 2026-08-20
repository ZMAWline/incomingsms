// Behavior check for the Activate SIMs modal's manual paste-line parser.
// Functions are extracted from the real frontend (src/dashboard/public/index.html)
// so the test exercises shipped code, matching the pattern used by
// dashboard-search-parse.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

function grabFn(name) {
  const s = html.indexOf('function ' + name + '(');
  assert.notEqual(s, -1, name + ' not found in index.html');
  let d = 0, j = s, started = false;
  while (j < html.length) {
    if (html[j] === '{') { d++; started = true; }
    if (html[j] === '}') { if (--d === 0 && started) break; }
    j++;
  }
  return html.slice(s, j + 1);
}

function grabConst(name) {
  const s = html.indexOf('const ' + name + ' =');
  assert.notEqual(s, -1, name + ' not found in index.html');
  const e = html.indexOf('];', s);
  assert.notEqual(e, -1, name + ' declaration not terminated with "];"');
  return html.slice(s, e + 2);
}

const ctx = vm.createContext({});
vm.runInContext(
  [
    grabConst('PORT_FIELD_KEYS'),
    grabFn('normalizeActivationPhone10'),
    grabFn('activationFlag'),
    grabFn('splitPasteFields'),
    grabFn('parseManualPortInRow'),
    grabFn('validateActivationRow'),
  ].join(';\n'),
  ctx
);
const { splitPasteFields, parseManualPortInRow, validateActivationRow } = ctx;

test('parseManualPortInRow: space-separated 5-field port-in row', () => {
  const row = parseManualPortInRow('89014103271467425631 123456789012345 2125550199 ACCT12345 1234');
  assert.equal(row.iccid, '89014103271467425631');
  assert.equal(row.imei, '123456789012345');
  assert.equal(row.reseller_id, '');
  assert.equal(row.port_mdn, '2125550199');
  assert.equal(row.port_account_number, 'ACCT12345');
  assert.equal(row.port_pin, '1234');
});

test('parseManualPortInRow: comma-separated 5-field port-in row', () => {
  const row = parseManualPortInRow('89014103271467425631,123456789012345,2125550199,ACCT12345,1234');
  assert.equal(row.iccid, '89014103271467425631');
  assert.equal(row.imei, '123456789012345');
  assert.equal(row.port_mdn, '2125550199');
  assert.equal(row.port_account_number, 'ACCT12345');
  assert.equal(row.port_pin, '1234');
});

test('parseManualPortInRow: tab-separated Google Sheets row (with mixed spacing)', () => {
  const row = parseManualPortInRow('89014103271467425631\t123456789012345\t 2125550199 \tACCT12345\t1234');
  assert.equal(row.iccid, '89014103271467425631');
  assert.equal(row.imei, '123456789012345');
  assert.equal(row.port_mdn, '2125550199');
  assert.equal(row.port_account_number, 'ACCT12345');
  assert.equal(row.port_pin, '1234');
});

test('parseManualPortInRow: mixed comma+whitespace spreadsheet paste', () => {
  const row = parseManualPortInRow('89014103271467425631,  123456789012345 ,2125550199,ACCT12345 ,1234');
  assert.equal(row.iccid, '89014103271467425631');
  assert.equal(row.imei, '123456789012345');
  assert.equal(row.port_mdn, '2125550199');
  assert.equal(row.port_account_number, 'ACCT12345');
  assert.equal(row.port_pin, '1234');
});

test('parseManualPortInRow: existing ICCID/IMEI/reseller 3-field row still parses', () => {
  const row = parseManualPortInRow('89014103271467425631\t123456789012345\t1');
  assert.equal(row.iccid, '89014103271467425631');
  assert.equal(row.imei, '123456789012345');
  assert.equal(row.reseller_id, '1');
  assert.equal(row.port_mdn, '');
  assert.equal(row.port_account_number, '');
  assert.equal(row.port_pin, '');
});

test('parseManualPortInRow: unrecognized field count returns null', () => {
  assert.equal(parseManualPortInRow('89014103271467425631 123456789012345'), null);
  assert.equal(parseManualPortInRow('89014103271467425631 123456789012345 1 2 2125550199 ACCT12345 1234'), null);
  assert.equal(parseManualPortInRow(''), null);
});

test('splitPasteFields: handles spaces, commas, tabs, and mixed separators', () => {
  assert.deepEqual(Array.from(splitPasteFields('a b c')), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(splitPasteFields('a,b,c')), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(splitPasteFields('a\tb\tc')), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(splitPasteFields('a,  b ,c')), ['a', 'b', 'c']);
});

test('validateActivationRow: port-in fields fill from a parsed 5-field paste row', () => {
  const { ok, sim, errors } = validateActivationRow({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '7',
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
    port_old_first_name: 'Jane',
    port_old_last_name: 'Smith',
  }, 1, 'atomic');
  assert.equal(errors.length, 0);
  assert.equal(ok, true);
  assert.equal(sim.port_mdn, '2125550199');
  assert.equal(sim.port_account_number, 'ACCT12345');
  assert.equal(sim.port_pin, '1234');
  assert.equal(sim.reseller_id, 7);
});

test('validateActivationRow: existing ICCID/IMEI/reseller (non-port-in) path still works', () => {
  const { ok, sim, errors } = validateActivationRow({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'false',
  }, 1, 'atomic');
  assert.equal(errors.length, 0);
  assert.equal(ok, true);
  assert.equal(sim.port_in, false);
  assert.equal(sim.port_mdn, '');
  assert.equal(sim.port_account_number, '');
  assert.equal(sim.port_pin, '');
});

test('validateActivationRow: port-in disabled does not require or fill MDN/account/PIN', () => {
  const { ok, sim, errors } = validateActivationRow({
    iccid: '89014103271467425631',
    imei: '123456789012345',
    reseller_id: '1',
    vendor: 'atomic',
    port_in: 'false',
    // Even if port fields are present on the input, port_in=false must not
    // require or surface them — matches "keep existing non-port-in paste
    // behavior intact".
    port_mdn: '2125550199',
    port_account_number: 'ACCT12345',
    port_pin: '1234',
  }, 1, 'atomic');
  assert.equal(errors.length, 0);
  assert.equal(ok, true);
  assert.equal(sim.port_mdn, '', 'port_mdn must stay empty when port-in is disabled');
  assert.equal(sim.port_account_number, '', 'port_account_number must stay empty when port-in is disabled');
  assert.equal(sim.port_pin, '', 'port_pin must stay empty when port-in is disabled');
});
