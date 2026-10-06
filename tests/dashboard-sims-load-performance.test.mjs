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

// loadData() reloads only the tab on screen; other tabs load when opened.
function refreshHarness(tab) {
  const calls = [];
  const sandbox = {
    console: quiet, API_BASE: '/api', AbortController, lastSimsFetchedAt: 123,
    setTimeout: () => 1, clearTimeout() {},
    hydrateSimsFromUrl() {},
    loadSims: (force) => calls.push('sims:' + force), loadMessages: () => calls.push('messages'),
    loadMessagesPreview: () => calls.push('preview'),
    switchTab: (name, push) => calls.push('switchTab:' + name + ':' + push),
    fetch: (u) => { calls.push('fetch:' + u); return Promise.resolve(new Response('{}', { status: 200 })); },
    document: {
      getElementById: () => ({}),
      querySelector: () => ({ id: 'tab-' + tab }),
    },
    updateActiveRing() {}, renderDashboardCharts() {}, renderFreshness() {}, showToast() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source('function activeTabName() {', 'function renderFreshness('), sandbox);
  return { sandbox, calls };
}

test('Dashboard refresh loads the summary and the 5-message preview, not the SIMs table', async () => {
  const { sandbox, calls } = refreshHarness('dashboard');
  await sandbox.loadData();
  assert.deepEqual(calls, ['preview', 'fetch:/api/stats']);
});

test('SIMs refresh loads only the SIMs page', async () => {
  const { sandbox, calls } = refreshHarness('sims');
  await sandbox.loadData();
  assert.deepEqual(calls, ['sims:true']);
});

test('Messages refresh loads only the messages page', async () => {
  const { sandbox, calls } = refreshHarness('messages');
  await sandbox.loadData();
  assert.deepEqual(calls, ['messages']);
});

test('any other tab re-runs its own loader and invalidates the cached SIMs page', async () => {
  const { sandbox, calls } = refreshHarness('runs');
  await sandbox.loadData();
  assert.deepEqual(calls, ['switchTab:runs:false']);
  assert.equal(sandbox.lastSimsFetchedAt, 0);
});

test('boot loads nothing until a tab opens it', () => {
  const boot = html.slice(html.indexOf('setInterval(function () {'), html.indexOf("try { initTabFromUrl(); }"));
  assert.doesNotMatch(boot, /^\s*loadData\(\);/m, 'no unconditional loadData() at boot');
  assert.match(html, /if \(tabName === 'dashboard'\) loadDashboardHome\(\);/);
  assert.match(html, /if \(tabName === 'messages'\) loadMessages\(\);/);
});

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
