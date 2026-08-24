// Regression tests for a real live bug found on dashboard-test.zalmen-531.workers.dev:
// direct/deep-link navigation to /activation-runs rendered the table header
// with zero rows even though GET /api/activation-runs?limit=5 returned a
// valid { runs, total, limit, offset } payload with 3 rows.
//
// Root cause (confirmed by actually executing the real inline <script> from
// index.html in a Node vm sandbox, simulating a direct load of
// /activation-runs — see the boot harness below):
//
//   1. `switchTab()` (defined early in the script) assigned
//      `activationRunsPage = 0` on its 'activation-runs' branch, but
//      `let activationRunsPage = 0;` was declared thousands of lines later,
//      right before loadActivationRuns(). A direct/deep-link page load runs
//      `initTabFromUrl()` at boot, which calls switchTab('activation-runs')
//      *before* the script has reached that later `let` declaration — so the
//      reference landed in the temporal dead zone and threw
//      "ReferenceError: Cannot access 'activationRunsPage' before
//      initialization". Because this happened as a synchronous top-level
//      statement, it aborted every remaining statement in the script block,
//      including the call to loadActivationRuns() itself — the tbody was
//      never touched and kept its static empty markup.
//   2. Once that crash is fixed, a second latent bug surfaced:
//      loadActivationRuns() (and loadActivationRunItems()) called a bare
//      `fmt(...)` date formatter that was never declared at module/global
//      scope — every other `fmt` in this file is a local const scoped to an
//      unrelated function. Any run with a truthy created_at/started_at/
//      finished_at threw "ReferenceError: fmt is not defined" inside the
//      row-rendering .map(), which was caught by loadActivationRuns' own
//      try/catch and replaced the whole table with an error row.
//
// Fix: the activation-runs tab state (`activationRunsPage`, etc.) now
// declares before switchTab is defined/called, switchTab's per-tab autoLoad
// dispatch is wrapped tab-by-tab in try/catch (so one tab's loader failure
// can never aborts another tab's rendering or the rest of page boot), and
// the two `fmt(...)` call sites use `new Date(x).toLocaleString()` directly,
// matching how every other renderer in this file formats dates.
//
// This file also proves the fix isolates the SIMs loader from the active
// tab: it mocks /api/sims to fail (the observed "Error loading SIMs" toast)
// and asserts Activation Runs still renders its rows regardless, since
// loadData()'s boot-time refresh and switchTab's per-tab autoLoad dispatch
// are independent, try/catch-isolated call chains.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// ---------------------------------------------------------------------
// 1. Structural guard: the activation-runs tab state must be declared
//    before switchTab is defined and before initTabFromUrl() is invoked at
//    boot, or a deep-link load re-triggers the temporal-dead-zone crash.
// ---------------------------------------------------------------------

test('activation-runs tab state is declared before switchTab and before the boot dispatch that can call it', () => {
  const declIdx = HTML.indexOf('let activationRunsPage = 0;');
  const switchTabIdx = HTML.indexOf('function switchTab(tabName');
  const bootCallIdx = HTML.lastIndexOf('initTabFromUrl();');

  assert.notEqual(declIdx, -1, 'activationRunsPage declaration not found');
  assert.notEqual(switchTabIdx, -1, 'switchTab definition not found');
  assert.notEqual(bootCallIdx, -1, 'initTabFromUrl() boot call not found');

  assert.ok(
    declIdx < switchTabIdx,
    'activationRunsPage must be declared before switchTab is defined — switchTab assigns it on its activation-runs branch'
  );
  assert.ok(
    switchTabIdx < bootCallIdx,
    'switchTab must be defined before the boot-time initTabFromUrl() call that can invoke it'
  );
});

test('no bare fmt(...) date-formatter call remains in the activation-runs renderers (fmt is only ever locally scoped elsewhere in this file)', () => {
  const s = HTML.indexOf('async function loadActivationRuns(');
  const e = HTML.indexOf('async function loadActivationRunItems(');
  assert.notEqual(s, -1);
  assert.notEqual(e, -1);
  const listSrc = HTML.slice(s, e);
  assert.ok(!/[^.\w]fmt\(/.test(listSrc), 'loadActivationRuns must not call an undeclared global fmt()');
});

// ---------------------------------------------------------------------
// 2. Full boot simulation: execute the real inline <script> content exactly
//    as a browser would, landing directly on /activation-runs, and assert
//    the 3 rows Hermes observed via the live API actually render — while
//    /api/sims fails at the same time, proving the failure is isolated.
// ---------------------------------------------------------------------

function extractAllInlineScripts(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let js = '';
  let m;
  while ((m = re.exec(html))) js += m[1] + '\n;\n';
  return js.replace('__HELIX_ENABLED__', 'false');
}

const FRONTEND_JS = extractAllInlineScripts(HTML);

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      if (force === undefined) (set.has(c) ? set.delete(c) : set.add(c));
      else if (force) set.add(c);
      else set.delete(c);
    },
  };
}

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    classList: makeClassList(),
    dataset: {},
    children: [],
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute: () => {},
    focus: () => {},
    select: () => {},
    click: () => {},
    remove: () => {},
    closest: () => null,
  };
}

// Boots the real dashboard frontend script in a vm sandbox, simulating a
// direct/deep-link load of `pathname`. `fetchRoutes` maps a substring match
// against the request URL to a Response.
async function bootDashboard(pathname, fetchRoutes) {
  const elementCache = new Map();
  const getElementById = (id) => {
    if (!elementCache.has(id)) elementCache.set(id, makeElement(id));
    return elementCache.get(id);
  };
  const document_ = {
    getElementById,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => makeElement('__created_' + tag),
    title: '',
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };
  const localStorageStore = new Map();
  const localStorage_ = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
  };

  async function fetchMock(url) {
    const u = String(url);
    for (const [pattern, handler] of fetchRoutes) {
      if (u.includes(pattern)) return handler(u);
    }
    return new Response('[]', { status: 200 });
  }

  const sandbox = {
    console,
    document: document_,
    location: { pathname, search: '', href: 'https://dashboard.test' + pathname, reload: () => {} },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    localStorage: localStorage_,
    fetch: fetchMock,
    Response, URL, URLSearchParams, AbortController, Request,
    // Real timers (so ordering/cancellation semantics like the /stats abort
    // controller and clearTimeout still work), but capped short so a toast's
    // real 10s auto-hide delay doesn't stall the test suite.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(ms || 0, 5), ...args),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Set, Map, JSON, Math,
    navigator: { clipboard: { writeText: async () => {} } },
    Chart: function Chart() {},
    tailwind: { config: {} },
    addEventListener: () => {},
    onerror: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  let syncThrow = null;
  try {
    vm.runInContext(FRONTEND_JS, sandbox, { filename: 'dashboard-inline-script.js' });
  } catch (e) {
    syncThrow = e;
  }

  // Flush the fire-and-forget async chains kicked off during boot
  // (loadData(), and switchTab's autoLoad dispatch to loadActivationRuns()).
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  return { sandbox, elementCache, syncThrow };
}

const LIVE_RUNS = [
  { id: '406036eb-4df0-4a1f-9f88-68a74c174919', status: 'failed', source: 'json', created_at: '2026-08-24T12:00:00Z', total_items: 1, failed_items: 1 },
  { id: 'b11b2839-69aa-4b94-8d81-07c1b99fb113', status: 'failed', source: 'json', created_at: '2026-08-24T12:01:00Z', total_items: 1, failed_items: 1 },
  { id: 'a48b19eb-3989-4aee-b7db-5a53d7730b08', status: 'failed', source: 'json', created_at: '2026-08-24T12:02:00Z', total_items: 1, failed_items: 1 },
];

function standardRoutes({ simsFail } = {}) {
  return [
    ['/api/activation-runs', () => new Response(JSON.stringify({ runs: LIVE_RUNS, total: LIVE_RUNS.length, limit: 5, offset: 0 }), { status: 200 })],
    ['/api/sims', () => (simsFail ? new Response('Internal Server Error', { status: 500 }) : new Response('[]', { status: 200 }))],
    ['/api/stats', () => new Response(JSON.stringify({ total_sims: 10, active_sims: 8, provisioning_sims: 1, messages_24h: 5 }), { status: 200 })],
    ['/api/messages', () => new Response('[]', { status: 200 })],
  ];
}

test('a direct load of /activation-runs boots without a synchronous throw', async () => {
  const { syncThrow } = await bootDashboard('/activation-runs', standardRoutes());
  assert.equal(syncThrow, null, 'boot script must not throw synchronously: ' + (syncThrow && syncThrow.stack));
});

test('a direct load of /activation-runs renders all 3 rows returned by the live API shape', async () => {
  const { elementCache } = await bootDashboard('/activation-runs', standardRoutes());
  const tbody = elementCache.get('activation-runs-tbody');
  assert.notEqual(tbody, undefined, 'loadActivationRuns must have touched #activation-runs-tbody');

  for (const run of LIVE_RUNS) {
    assert.ok(tbody.innerHTML.includes(run.id), `row for run ${run.id} must be rendered`);
  }
  assert.equal((tbody.innerHTML.match(/<tr/g) || []).length, 3, 'exactly 3 rows rendered, matching total:3 from the API');
  assert.ok(!tbody.innerHTML.includes('ReferenceError'), 'no ReferenceError (e.g. from an undeclared fmt()) leaked into the rendered rows');

  const countEl = elementCache.get('activation-runs-count');
  assert.equal(countEl.textContent, 'Showing 3 of 3 (page 1)');
});

test('a failing /api/sims does not block Activation Runs from rendering its rows', async () => {
  const { elementCache } = await bootDashboard('/activation-runs', standardRoutes({ simsFail: true }));
  const tbody = elementCache.get('activation-runs-tbody');

  for (const run of LIVE_RUNS) {
    assert.ok(tbody.innerHTML.includes(run.id), `Activation Runs must still render run ${run.id} even though /api/sims failed`);
  }
  assert.equal((tbody.innerHTML.match(/<tr/g) || []).length, 3);
});

test('landing on the dashboard tab (not activation-runs) never touches the activation-runs tbody', async () => {
  const { elementCache } = await bootDashboard('/', standardRoutes());
  assert.equal(elementCache.has('activation-runs-tbody'), false, 'loadActivationRuns must only run for the activation-runs tab');
});
