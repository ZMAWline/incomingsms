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

// The saved-filter block, wired to a fake fetch and a fake localStorage so the
// whole per-account path — first load, the one-time migration off
// localStorage, save, rename, delete — can be exercised in-process.
function makeSavedFilterSandbox(opts) {
  const o = opts || {};
  const calls = [];
  const src = [
    slice('function simNotRotatedToday(s)', 'const SIMS_COLUMNS = ['),
    slice('const SIMS_COLUMNS = [', 'let simsColumnVis'),
    'function __cache() { return simsSavedFilters; }',
    'function __filters() { return simsColumnFilters; }',
    // The SIMS_COLUMNS slice re-declares simsFilterState/simsColumnFilters, so
    // the live state has to be installed after it runs, not before.
    'function __setLive(fs, cf) { simsFilterState = fs; simsColumnFilters = cf; }',
  ].join('\n');

  const store = new Map(o.storage || []);
  const server = new Map(o.server || []);   // name -> filter object
  const sandbox = {
    console, JSON, Array, Object, String, Date, Number, Math, Set, Map,
    encodeURIComponent, decodeURIComponent, Promise,
    API_BASE: '/api',
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    toasts: [],
    showToast: (msg, kind) => sandbox.toasts.push([msg, kind]),
    showTextPrompt: async () => (o.promptAnswer === undefined ? 'Teltik offline' : o.promptAnswer),
    showConfirm: async () => (o.confirmAnswer === undefined ? true : o.confirmAnswer),
    document: { getElementById: () => null },
    esc: (s) => String(s),
    simsFilterState: o.filterState || {
      status: ['active'], resellerIds: [], vendors: ['teltik'], gateways: [],
      activatedFrom: '', activatedTo: '', search: 'abc',
    },
    simsColumnFilters: o.columnFilters
      || [{ col: 'hosting_port_state', op: 'in', value: ['offline'] }],
    tableState: { sims: { sortKey: 'sms_count', sortDir: 'desc', page: 3, data: [] } },
    loadSims: () => {},
    renderSims: () => {},
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET';
      calls.push([method, url]);
      if (o.failAll) return { ok: false, status: 502, json: async () => ({ ok: false, error: 'supabase_502' }) };
      if (method === 'GET') {
        const filters = [...server.entries()]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([name, filter]) => ({ id: name, name, filter }));
        return { ok: true, status: 200, json: async () => ({ ok: true, filters }) };
      }
      const name = decodeURIComponent(url.slice('/api/saved-filters/'.length));
      if (method === 'PUT') {
        if (o.failWrites) return { ok: false, status: 502, json: async () => ({ ok: false, error: 'supabase_502' }) };
        server.set(name, JSON.parse(init.body).filter);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (method === 'DELETE') {
        if (!server.has(name)) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'missing' }) };
        server.delete(name);
        return { ok: true, status: 200, json: async () => ({ ok: true, deleted: name }) };
      }
      throw new Error('unexpected method ' + method);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.__setLive(sandbox.simsFilterState, sandbox.simsColumnFilters);
  return { sandbox, server, store, calls };
}

test('saved filters round-trip through the account API, not localStorage', async () => {
  const { sandbox, server, calls } = makeSavedFilterSandbox();

  await sandbox.saveCurrentSimsFilter();

  assert.deepStrictEqual(calls, [['PUT', '/api/saved-filters/Teltik%20offline']],
    'saving must be one PUT to the account, and must not touch any other route');
  const saved = server.get('Teltik offline');
  assert.ok(saved, 'the filter must exist on the server');
  assert.deepStrictEqual(saved.vendors, ['teltik']);
  assert.equal(saved.search, 'abc');
  assert.equal(saved.sortKey, 'sms_count');
  assert.deepStrictEqual(saved.columnFilters,
    [{ col: 'hosting_port_state', op: 'in', value: ['offline'] }]);

  // The stored copy must not alias live state.
  sandbox.simsColumnFilters.push({ col: 'vendor', op: 'in', value: ['atomic'] });
  assert.equal(server.get('Teltik offline').columnFilters.length, 1,
    'a saved filter must not change when the live filters change');

  // And the in-memory cache the chip row renders from is updated in step.
  assert.deepStrictEqual([...sandbox.__cache()].map((f) => f.name), ['Teltik offline']);
});

test('nothing is written to localStorage any more', async () => {
  const { sandbox, store } = makeSavedFilterSandbox();
  await sandbox.saveCurrentSimsFilter();
  assert.equal(store.get('simsSavedFilters'), undefined,
    'saved filters must not be persisted per-browser');
  assert.ok(!HTML.includes("localStorage.setItem(SIMS_SAVED_FILTERS_KEY"),
    'the localStorage write path must be gone');
});

test('a failed save surfaces an error and does not fake success', async () => {
  const { sandbox, server } = makeSavedFilterSandbox({ failWrites: true });
  await sandbox.saveCurrentSimsFilter();
  assert.equal(server.size, 0);
  assert.equal(sandbox.__cache().length, 0, 'the chip row must not show a filter that was never stored');
  assert.ok(sandbox.toasts.some(([, kind]) => kind === 'error'), 'the operator must be told');
});

test('legacy localStorage filters are uploaded once, then the key is cleared', async () => {
  const legacy = JSON.stringify([
    { name: 'from this browser', state: { status: ['active'], resellerIds: [], columnFilters: [] } },
    { name: 'already mine', state: { status: ['canceled'], resellerIds: [], columnFilters: [] } },
  ]);
  const { sandbox, server, store, calls } = makeSavedFilterSandbox({
    storage: [['simsSavedFilters', legacy]],
    // The account already has a view under this name, edited from another
    // machine; the account copy must win.
    server: [['already mine', { status: ['provisioning'], resellerIds: [], columnFilters: [] }]],
  });

  await sandbox.ensureSimsSavedFilters();

  assert.ok(calls.some(([m, u]) => m === 'PUT' && u.includes('from%20this%20browser')),
    'the browser-only filter must be uploaded');
  assert.ok(!calls.some(([m, u]) => m === 'PUT' && u.includes('already%20mine')),
    'a name the account already has must not be overwritten by the browser copy');
  assert.deepStrictEqual(server.get('already mine').status, ['provisioning']);
  assert.equal(store.get('simsSavedFilters'), undefined, 'localStorage must be cleared after the upload');
  assert.deepStrictEqual([...sandbox.__cache()].map((f) => f.name).sort(),
    ['already mine', 'from this browser']);

  // Second load must not re-upload anything.
  const before = calls.length;
  await sandbox.ensureSimsSavedFilters();
  assert.equal(calls.length, before, 'the migration is one-time');
});

test('a failed migration upload keeps localStorage so the next load retries', async () => {
  const legacy = JSON.stringify([{ name: 'keep me', state: { status: [], resellerIds: [], columnFilters: [] } }]);
  const { sandbox, store } = makeSavedFilterSandbox({
    storage: [['simsSavedFilters', legacy]],
    failWrites: true,
  });
  await sandbox.ensureSimsSavedFilters();
  assert.equal(store.get('simsSavedFilters'), legacy,
    'a filter that failed to upload must not be dropped');
  assert.ok(sandbox.toasts.some(([, kind]) => kind === 'error'));
});

test('delete goes to the account, not to a browser copy', async () => {
  const { sandbox, server, calls } = makeSavedFilterSandbox({
    server: [['mine', { status: [], resellerIds: [], columnFilters: [] }]],
  });
  await sandbox.ensureSimsSavedFilters();
  await sandbox.deleteSimsSavedFilter('mine');
  assert.ok(calls.some(([m, u]) => m === 'DELETE' && u === '/api/saved-filters/mine'));
  assert.equal(server.size, 0);
  assert.equal(sandbox.__cache().length, 0);
});

test('rename writes the new name before removing the old one', async () => {
  const { sandbox, server, calls } = makeSavedFilterSandbox({
    server: [['old name', { status: ['active'], resellerIds: [], columnFilters: [] }]],
    promptAnswer: 'new name',
  });
  await sandbox.ensureSimsSavedFilters();
  await sandbox.renameSimsSavedFilter('old name');

  const writes = calls.filter(([m]) => m === 'PUT' || m === 'DELETE').map(([m]) => m);
  assert.deepStrictEqual(writes, ['PUT', 'DELETE'],
    'write-then-delete: the other order can lose the view outright');
  assert.deepStrictEqual([...server.keys()], ['new name']);
  assert.deepStrictEqual(server.get('new name').status, ['active'], 'the view itself must survive the rename');
});

test('a rename whose delete fails leaves both copies rather than none', async () => {
  const { sandbox, server } = makeSavedFilterSandbox({
    server: [['old name', { status: ['active'], resellerIds: [], columnFilters: [] }]],
    promptAnswer: 'new name',
  });
  await sandbox.ensureSimsSavedFilters();
  const realFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    if (init && init.method === 'DELETE') return { ok: false, status: 502, json: async () => ({ ok: false, error: 'boom' }) };
    return realFetch(url, init);
  };
  await sandbox.renameSimsSavedFilter('old name');
  assert.deepStrictEqual([...server.keys()].sort(), ['new name', 'old name']);
  assert.ok(sandbox.toasts.some(([, kind]) => kind === 'error'));
});

test('applying a saved filter drops columns that no longer exist', async () => {
  const { sandbox } = makeSavedFilterSandbox({
    server: [['legacy', {
      status: ['active'], resellerIds: [], vendors: [], gateways: [],
      activatedFrom: '', activatedTo: '', search: '',
      columnFilters: [
        { col: 'sms_count', op: 'gt', value: 1 },
        { col: 'a_column_that_was_deleted', op: 'eq', value: 'x' },
      ],
    }]],
    filterState: { status: ['active'], resellerIds: [], vendors: [], gateways: [], activatedFrom: '', activatedTo: '', search: '' },
    columnFilters: [],
  });
  await sandbox.ensureSimsSavedFilters();

  sandbox.applySimsSavedFilter('legacy');
  const applied = sandbox.__filters();
  assert.equal(applied.length, 1, 'the unknown column must be dropped, not matched blindly');
  assert.equal(applied[0].col, 'sms_count');
});

test('the chip row distinguishes "still loading" from "you have none"', () => {
  const block = slice('const SIMS_SAVED_FILTERS_KEY', '// --- Per-column filter popover');
  assert.match(block, /simsSavedFiltersLoaded/,
    'an empty chip row before the fetch lands must not claim the account has no filters');
});

test('saved-filter dialogs use the in-page modals, never native ones', () => {
  const start = HTML.indexOf('const SIMS_SAVED_FILTERS_KEY');
  const block = HTML.slice(start, HTML.indexOf('// --- Per-column filter popover', start));
  assert.ok(!/[^.\w]prompt\s*\(/.test(block), 'must not call native prompt()');
  assert.ok(!/[^.\w]confirm\s*\(/.test(block), 'must not call native confirm()');
  assert.match(block, /showTextPrompt\(/, 'must use the in-page text prompt');
  assert.match(block, /showConfirm\(/, 'must use the in-page confirm');
});

test('showTextPrompt matches the existing modal markup', () => {
  const fn = HTML.slice(HTML.indexOf('function showTextPrompt'));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  assert.match(body, /bg-dark-800 border border-dark-600 rounded-xl/, 'same card treatment as showDatePrompt');
  assert.match(body, /Escape/, 'Escape must cancel');
  assert.match(body, /Enter/, 'Enter must submit');
});
