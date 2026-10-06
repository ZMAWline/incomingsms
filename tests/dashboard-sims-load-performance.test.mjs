import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');
function source(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const quiet = { error() {} };

for (const fail of [false, true]) {
  test(`SIMs start while summary is pending, even when summary ${fail ? 'fails' : 'succeeds'}`, async () => {
    const summary = deferred();
    const calls = [];
    const sandbox = {
      console: quiet, API_BASE: '/api', AbortController,
      setTimeout: () => 1, clearTimeout() {},
      hydrateSimsFromUrl() {},
      loadSims: () => calls.push('sims'), loadMessages: () => calls.push('messages'),
      fetch: () => summary.promise,
      document: { getElementById: () => ({}) },
      updateActiveRing() {}, renderDashboardCharts() {}, renderFreshness() {}, showToast() {},
    };
    vm.createContext(sandbox);
    vm.runInContext(source('async function loadData() {', 'function renderFreshness('), sandbox);
    const pending = sandbox.loadData();
    assert.deepEqual(calls, ['sims', 'messages']);
    summary.resolve(new Response(JSON.stringify({ total_sims: 4 }), { status: fail ? 500 : 200 }));
    await pending;
    assert.deepEqual(calls, ['sims', 'messages'], 'summary completion must not load the table twice');
  });
}

function tableHarness() {
  const sides = [];
  const pages = [];
  const renders = [];
  const menuUpdates = [];
  const sandbox = {
    console: quiet, API_BASE: '/api', URLSearchParams,
    clearTimeout() {}, _simsFetchTimer: null, _simsFetchSeq: 0,
    _simsLoaded: {}, lastSimsFetchedAt: 0, SIM_CACHE_MS: 1000, SIMS_FACETS: null,
    tableState: { sims: {} }, ensureSimsSavedFilters() {},
    simsFilterParams: () => new URLSearchParams('status=active'),
    simsPageParams: () => new URLSearchParams('page=1'),
    loadSimsStatusCounts() { const d = deferred(); sides.push(d); return d.promise; },
    loadSimsFacets() { const d = deferred(); sides.push(d); return d.promise; },
    fetch() { const d = deferred(); pages.push(d); return d.promise; },
    document: { getElementById: () => null }, showToast() {},
    renderSims() { renders.push(sandbox.tableState.sims.data); },
    populateSimsAddFilter() { menuUpdates.push('filters'); },
    setSimsCountBadges() { menuUpdates.push('counts'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source('async function loadSims(force = false) {', '\nfunction renderSims()'), sandbox);
  return { sandbox, sides, pages, renders, menuUpdates };
}
const pageResponse = id => new Response(JSON.stringify({ rows: [{ id }], total: 1 }));

test('ready SIM rows render before fleet counts; late counts update controls without rebuilding rows', async () => {
  const h = tableHarness();
  const pending = h.sandbox.loadSims(true);
  h.pages[0].resolve(pageResponse(7));
  await flush();
  assert.equal(h.renders.length, 1, 'unresolved fleet requests must not block the ready table');
  assert.equal(h.renders[0][0].id, 7);
  await pending;
  h.sides.forEach(d => d.resolve());
  await flush();
  assert.deepEqual(h.menuUpdates, ['filters', 'counts']);
  assert.equal(h.renders.length, 1);
});

test('late counts from an older SIM request do not refresh current controls', async () => {
  const h = tableHarness();
  const first = h.sandbox.loadSims(true);
  h.pages[0].resolve(pageResponse(1));
  await flush();
  const second = h.sandbox.loadSims(true);
  h.pages[1].resolve(pageResponse(2));
  await flush();
  h.sides.slice(0, 2).forEach(d => d.resolve());
  await flush();
  assert.deepEqual(h.menuUpdates, []);
  h.sides.slice(2).forEach(d => d.resolve());
  await Promise.all([first, second]);
  await flush();
  assert.deepEqual(h.menuUpdates, ['filters', 'counts']);
  assert.equal(h.sandbox.tableState.sims.data[0].id, 2);
});
