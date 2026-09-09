// Per-column filtering and type-aware sorting for the SIMs table.
//
// The filter engine lives in the dashboard's inline <script>, so it is lifted
// out and run in a VM the same way the other frontend tests do it. What is
// being pinned here is behaviour, not markup: which rows survive each operator.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const a = HTML.indexOf(startMarker);
  const b = HTML.indexOf(endMarker, a);
  assert.ok(a !== -1 && b !== -1, 'filter engine markers not found: ' + startMarker);
  return HTML.slice(a, b);
}

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const ROWS = [
  { id: 1, status: 'active',       vendor: 'teltik',   hosting_port_state: 'online',  sms_count: 12, last_sms_received: iso(now - 2 * 3600e3),  port: '1A', rotation_eligible: true,  iccid: '8901410000000000001', reseller_name: 'Acme' },
  { id: 2, status: 'active',       vendor: 'atomic',   hosting_port_state: 'offline', sms_count: 0,  last_sms_received: null,                    port: '2B', rotation_eligible: false, iccid: '8901410000000000002', reseller_name: null },
  { id: 3, status: 'provisioning', vendor: 'teltik',   hosting_port_state: 'online',  sms_count: 5,  last_sms_received: iso(now - 40 * 3600e3), port: '1A', rotation_eligible: true,  iccid: '8901410000000000003', reseller_name: 'Beta' },
  { id: 4, status: 'suspended',    vendor: 'wing_iot', hosting_port_state: null,      sms_count: 99, last_sms_received: iso(now - 1 * 3600e3),  port: null, rotation_eligible: true,  iccid: '8901410000000000004', reseller_name: 'Acme' },
];

function makeEngine() {
  const src = [
    slice('const SIMS_COLUMNS = [', 'let simsColumnVis'),
    slice('function genericSort(arr, key, dir, table)', 'function normalizePastedSearch'),
    // simsColumnFilters and SIMS_COLUMNS are let/const, so they are lexical
    // bindings rather than properties of the sandbox object. Function
    // declarations do land on the sandbox, so they are the handles used here.
    'function __setFilters(f) { simsColumnFilters = f; }',
    'function __columnKeys() { return SIMS_COLUMNS.map(function (c) { return c.key; }); }',
  ].join('\n');

  const sandbox = { tableState: { sims: { data: ROWS } }, console, Date, Number, Math, String, Array, Set, Map };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.__setFilters([]);
  return {
    // Arrays built in the VM are from another realm, so compare by value.
    filter: (filters) => {
      sandbox.__setFilters(filters);
      return [...sandbox.applySimsColumnFilters(ROWS).map((r) => r.id)];
    },
    sort: (key, dir) => [...sandbox.genericSort(ROWS, key, dir, 'sims').map((r) => r.id)],
    distinct: (key) => [...sandbox.simsDistinctValues(key)],
    columns: [...sandbox.__columnKeys()],
  };
}

test('enum filters select and exclude by value, and handle blanks', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([{ col: 'status', op: 'in', value: ['active'] }]), [1, 2]);
  assert.deepStrictEqual(e.filter([{ col: 'status', op: 'not_in', value: ['active'] }]), [3, 4]);
  assert.deepStrictEqual(e.filter([{ col: 'hosting_port_state', op: 'in', value: ['online'] }]), [1, 3]);
  assert.deepStrictEqual(e.filter([{ col: 'hosting_port_state', op: 'in', value: ['offline'] }]), [2]);
  assert.deepStrictEqual(e.filter([{ col: 'hosting_port_state', op: 'blank' }]), [4]);
  assert.deepStrictEqual(e.filter([{ col: 'port', op: 'in', value: ['1A'] }]), [1, 3]);
  assert.deepStrictEqual(e.filter([{ col: 'vendor', op: 'in', value: ['teltik', 'atomic'] }]), [1, 2, 3]);
});

test('numeric filters compare as numbers, not strings', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([{ col: 'sms_count', op: 'gt', value: 5 }]), [1, 4]);
  assert.deepStrictEqual(e.filter([{ col: 'sms_count', op: 'eq', value: 0 }]), [2]);
  assert.deepStrictEqual(e.filter([{ col: 'sms_count', op: 'lte', value: 5 }]), [2, 3]);
  assert.deepStrictEqual(e.filter([{ col: 'sms_count', op: 'between', value: 1, value2: 20 }]), [1, 3]);
  // 99 vs 12: a string compare would put '12' above '99'.
  assert.deepStrictEqual(e.filter([{ col: 'sms_count', op: 'gte', value: 90 }]), [4]);
});

test('date filters support relative windows and blank checks', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([{ col: 'last_sms_received', op: 'within_h', value: 6 }]), [1, 4]);
  assert.deepStrictEqual(e.filter([{ col: 'last_sms_received', op: 'older_h', value: 24 }]), [3]);
  assert.deepStrictEqual(e.filter([{ col: 'last_sms_received', op: 'blank' }]), [2]);
  assert.deepStrictEqual(e.filter([{ col: 'last_sms_received', op: 'not_blank' }]), [1, 3, 4]);
});

test('boolean and text filters', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([{ col: 'rotation_eligible', op: 'is_false' }]), [2]);
  assert.deepStrictEqual(e.filter([{ col: 'rotation_eligible', op: 'is_true' }]), [1, 3, 4]);
  assert.deepStrictEqual(e.filter([{ col: 'iccid', op: 'contains', value: '0003' }]), [3]);
  assert.deepStrictEqual(e.filter([{ col: 'reseller_name', op: 'blank' }]), [2]);
});

test('multiple column filters AND together', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([
    { col: 'vendor', op: 'in', value: ['teltik'] },
    { col: 'hosting_port_state', op: 'in', value: ['online'] },
    { col: 'sms_count', op: 'gt', value: 5 },
  ]), [1]);
});

test('sorting is type-aware and puts blanks last in both directions', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.sort('sms_count', 'asc'), [2, 3, 1, 4]);
  assert.deepStrictEqual(e.sort('sms_count', 'desc'), [4, 1, 3, 2]);
  // Row 2 has no last_sms_received and must not lead the ascending sort.
  assert.deepStrictEqual(e.sort('last_sms_received', 'asc'), [3, 1, 4, 2]);
  assert.deepStrictEqual(e.sort('last_sms_received', 'desc'), [4, 1, 3, 2]);
  assert.deepStrictEqual(e.sort('hosting_port_state', 'asc'), [2, 1, 3, 4]);
});

test('distinct option lists skip blanks and are sorted', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.distinct('status'), ['active', 'provisioning', 'suspended']);
  assert.deepStrictEqual(e.distinct('hosting_port_state'), ['offline', 'online']);
});

test('every column the operator asked for is filterable', () => {
  const e = makeEngine();
  for (const key of ['hosting_port_state', 'port', 'vendor', 'status', 'sms_count', 'last_sms_received']) {
    assert.ok(e.columns.includes(key), key + ' must be in the filter registry');
  }
});

test('every visible sort header has a matching filter button', () => {
  const sortKeys = [...HTML.matchAll(/sortTable\('sims','([a-z_0-9]+)'\)/g)].map((m) => m[1]);
  assert.ok(sortKeys.length >= 13, 'expected the SIMs table to keep its sortable headers');
  for (const key of sortKeys) {
    assert.ok(
      HTML.includes('data-colfilter-btn="' + key + '"'),
      'column ' + key + ' is sortable but has no filter button'
    );
  }
});
