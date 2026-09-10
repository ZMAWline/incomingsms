// Saved filters and computed columns for the SIMs table.
//
// These replace the fixed "Quick" preset chips. The preset predicates survive
// as computed columns, so the judgement they encoded (vendor-specific
// notification windows, a non-Success port-in code) is still expressible — and
// now combinable with any other filter and storable in a named view.
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
  assert.ok(a !== -1 && b !== -1, 'markers not found: ' + startMarker);
  return HTML.slice(a, b);
}

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const todayUTC = new Date().toISOString().slice(0, 10);

const ROWS = [
  // Notified 2h ago on ATOMIC (24h window) -> fresh. Rotated today.
  { id: 1, status: 'active', vendor: 'atomic', last_notified_at: iso(now - 2 * 3600e3),
    last_mdn_rotated_at: todayUTC + 'T04:00:00Z', last_sms_received: iso(now - 1 * 3600e3),
    atomic_portin_status_code: '00', reseller_id: 7 },
  // Notified 30h ago on ATOMIC -> stale. Not rotated today. No SMS in 12h.
  { id: 2, status: 'active', vendor: 'atomic', last_notified_at: iso(now - 30 * 3600e3),
    last_mdn_rotated_at: '2020-01-01T00:00:00Z', last_sms_received: iso(now - 20 * 3600e3),
    atomic_portin_status_code: null, reseller_id: null },
  // Notified 30h ago on Teltik (48h window) -> still fresh.
  { id: 3, status: 'active', vendor: 'teltik', last_notified_at: iso(now - 30 * 3600e3),
    last_mdn_rotated_at: todayUTC + 'T04:00:00Z', last_sms_received: iso(now - 1 * 3600e3),
    atomic_portin_status_code: '951', reseller_id: 9 },
  // Not active -> notify_stale is not meaningful, so false.
  { id: 4, status: 'canceled', vendor: 'atomic', last_notified_at: null,
    last_mdn_rotated_at: null, last_sms_received: null,
    atomic_portin_status_code: null, reseller_id: null },
];

function makeEngine() {
  const src = [
    slice('function simNotRotatedToday(s)', 'const SIMS_COLUMNS = ['),
    slice('const SIMS_COLUMNS = [', 'let simsColumnVis'),
    'function __setFilters(f) { simsColumnFilters = f; }',
    'function __columnKeys() { return SIMS_COLUMNS.map(function (c) { return c.key; }); }',
  ].join('\n');
  const sandbox = { tableState: { sims: { data: ROWS } }, console, Date, Number, Math, String, Array, Set, Map, JSON };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.__setFilters([]);
  return {
    filter: (filters) => {
      sandbox.__setFilters(filters);
      return [...sandbox.applySimsColumnFilters(ROWS).map((r) => r.id)];
    },
    columns: [...sandbox.__columnKeys()],
  };
}

test('computed columns carry the old preset logic', () => {
  const e = makeEngine();
  // Vendor-specific notification windows: 24h ATOMIC, 48h Teltik. Row 3 is
  // 30h stale by the ATOMIC rule but fresh by Teltik's, which is the whole
  // reason this cannot be a plain last_notified_at date filter.
  assert.deepStrictEqual(e.filter([{ col: 'notify_stale', op: 'is_true' }]), [2]);
  assert.deepStrictEqual(e.filter([{ col: 'not_rotated_today', op: 'is_true' }]), [2, 4]);
  // Any code other than '00' is a failure, including ones we have not seen.
  assert.deepStrictEqual(e.filter([{ col: 'portin_failed', op: 'is_true' }]), [3]);
  assert.deepStrictEqual(e.filter([{ col: 'no_sms_12h', op: 'is_true' }]), [2, 4]);
  assert.deepStrictEqual(e.filter([{ col: 'no_reseller', op: 'is_true' }]), [2, 4]);
});

test('computed columns combine with ordinary column filters', () => {
  const e = makeEngine();
  assert.deepStrictEqual(e.filter([
    { col: 'no_reseller', op: 'is_true' },
    { col: 'status', op: 'in', value: ['active'] },
  ]), [2]);
});

test('every removed preset still has a computed column', () => {
  const e = makeEngine();
  for (const key of ['notify_stale', 'not_rotated_today', 'portin_failed',
                     'stuck_provisioning', 'no_sms_12h', 'no_reseller']) {
    assert.ok(e.columns.includes(key), key + ' must exist as a computed column');
  }
});

test('the Quick preset chip row and its machinery are gone', () => {
  for (const gone of ['SIM_PRESETS', 'renderSimsPresetChips', 'toggleSimsPreset',
                      'data-preset=', 'sim-preset-chip', 'simsFilterState.presets']) {
    assert.ok(!HTML.includes(gone), gone + ' should have been removed with the presets');
  }
});

test('the stale-SIMs dashboard tile still filters, via the computed column', () => {
  const fn = HTML.slice(HTML.indexOf('function goToStaleSims'));
  const body = fn.slice(0, fn.indexOf('\n        }'));
  assert.match(body, /setSimsColumnFilter/, 'tile must apply a column filter');
  assert.match(body, /notify_stale/, 'tile must target the notify_stale column');
});

test('saved filters round-trip through storage', () => {
  const src = [
    slice('const SIMS_SAVED_FILTERS_KEY', '// --- Per-column filter popover'),
    'function __setState(fs, cf, ts) { simsFilterState = fs; simsColumnFilters = cf; tableState = ts; }',
  ].join('\n');

  const store = new Map();
  const sandbox = {
    console, JSON, Array, Object, String, Date,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    showToast: () => {},
    prompt: () => 'Teltik offline',
    confirm: () => true,
    document: { getElementById: () => null },
    simsFilterState: {
      status: ['active'], resellerIds: [], vendors: ['teltik'], gateways: [],
      activatedFrom: '', activatedTo: '', search: 'abc',
    },
    simsColumnFilters: [{ col: 'hosting_port_state', op: 'in', value: ['offline'] }],
    tableState: { sims: { sortKey: 'sms_count', sortDir: 'desc', page: 3 } },
    loadSims: () => {},
    renderSims: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  sandbox.saveCurrentSimsFilter();
  const saved = sandbox.loadSimsSavedFilters();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Teltik offline');
  assert.deepStrictEqual(saved[0].state.vendors, ['teltik']);
  assert.equal(saved[0].state.search, 'abc');
  assert.equal(saved[0].state.sortKey, 'sms_count');
  assert.deepStrictEqual(saved[0].state.columnFilters,
    [{ col: 'hosting_port_state', op: 'in', value: ['offline'] }]);

  // The stored copy must not alias live state.
  sandbox.simsColumnFilters.push({ col: 'vendor', op: 'in', value: ['atomic'] });
  assert.equal(sandbox.loadSimsSavedFilters()[0].state.columnFilters.length, 1,
    'a saved filter must not change when the live filters change');
});

test('applying a saved filter drops columns that no longer exist', () => {
  // simsColumnVis comes after the saved-filter block, so this one slice
  // already carries both the registry and the saved-filter functions.
  // simsColumnVis comes after the saved-filter block, so this one slice
  // already carries both the registry and the saved-filter functions. The
  // computed columns call the predicates while the array literal is built, so
  // those have to load first.
  const src = [
    slice('function simNotRotatedToday(s)', 'const SIMS_COLUMNS = ['),
    slice('const SIMS_COLUMNS = [', 'let simsColumnVis'),
    'function __filters() { return simsColumnFilters; }',
  ].join('\n');

  const store = new Map([['simsSavedFilters', JSON.stringify([{
    name: 'legacy',
    state: {
      status: ['active'], resellerIds: [], vendors: [], gateways: [],
      activatedFrom: '', activatedTo: '', search: '',
      columnFilters: [
        { col: 'sms_count', op: 'gt', value: 1 },
        { col: 'a_column_that_was_deleted', op: 'eq', value: 'x' },
      ],
    },
  }])]]);

  const sandbox = {
    console, JSON, Array, Object, String, Date, Number, Math, Set, Map,
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    showToast: () => {}, prompt: () => '', confirm: () => true,
    document: { getElementById: () => null },
    simsFilterState: { status: ['active'], resellerIds: [], vendors: [], gateways: [], activatedFrom: '', activatedTo: '', search: '' },
    simsColumnFilters: [],
    tableState: { sims: { sortKey: 'id', sortDir: 'asc', page: 1 } },
    loadSims: () => {}, renderSims: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  sandbox.applySimsSavedFilter('legacy');
  const applied = sandbox.__filters();
  assert.equal(applied.length, 1, 'the unknown column must be dropped, not matched blindly');
  assert.equal(applied[0].col, 'sms_count');
});
