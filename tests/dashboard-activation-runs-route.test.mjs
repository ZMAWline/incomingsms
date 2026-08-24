// Regression tests for two PR #69 preview bugs:
//
// 1. "Activation Runs" had no unique URL — TAB_ROUTES (the SPA's tab->path
//    map used for pushState and for resolving a direct/deep-link URL back to
//    a tab on load) was missing an 'activation-runs' entry, so the sidebar
//    link never updated the address bar and a direct visit to
//    /activation-runs fell back to the dashboard tab.
// 2. A just-submitted activation run was invisible: activateSims() showed a
//    toast and reloaded the aggregate dashboard stats, but never surfaced
//    the created run. The /activate response carries both `run_id` (a
//    queue-correlation string that matches no activation_runs row) and
//    `job_run_id` (the actual activation_runs.id) — only job_run_id can be
//    used to open the run detail view.
//
// The dashboard frontend is a single static HTML file with inline <script>,
// not a bundled module, so these lift the exact source text out of
// index.html/index.js and evaluate it, mirroring the pattern used by
// tests/dashboard-activate-json-response.test.mjs and
// tests/dashboard-healthy-evidence-api.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'function not found: ' + signature);
  let depth = 0, started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated function: ' + signature);
}

// ---------------------------------------------------------------------
// 1. Deep-link route for Activation Runs
// ---------------------------------------------------------------------

function loadRouteTables() {
  const start = HTML.indexOf('const TAB_ROUTES = {');
  assert.notEqual(start, -1, 'TAB_ROUTES not found in index.html');
  const end = HTML.indexOf("ROUTE_TO_TAB['/gateway']", start);
  assert.notEqual(end, -1, 'ROUTE_TO_TAB legacy alias not found in index.html');
  const stop = HTML.indexOf(';', end) + 1;
  const code = HTML.slice(start, stop);

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    TAB_ROUTES: vm.runInContext('TAB_ROUTES', sandbox),
    ROUTE_TO_TAB: vm.runInContext('ROUTE_TO_TAB', sandbox),
  };
}

test('Activation Runs has a dedicated route registered both ways', () => {
  const { TAB_ROUTES, ROUTE_TO_TAB } = loadRouteTables();
  assert.equal(TAB_ROUTES['activation-runs'], '/activation-runs');
  assert.equal(ROUTE_TO_TAB['/activation-runs'], 'activation-runs');
});

test('every tab in TAB_ROUTES has a matching tab-content element in the page', () => {
  const { TAB_ROUTES } = loadRouteTables();
  for (const tab of Object.keys(TAB_ROUTES)) {
    assert.ok(HTML.includes(`id="tab-${tab}"`), `missing #tab-${tab} element for route ${TAB_ROUTES[tab]}`);
  }
});

// ---------------------------------------------------------------------
// 2. Newly submitted run is surfaced, not just logged
// ---------------------------------------------------------------------

function grabHtmlFn(name) {
  const s = HTML.indexOf('function ' + name + '(');
  assert.notEqual(s, -1, name + ' not found in index.html');
  let d = 0, j = s, started = false;
  while (j < HTML.length) {
    if (HTML[j] === '{') { d++; started = true; }
    if (HTML[j] === '}') { if (--d === 0 && started) break; }
    j++;
  }
  return HTML.slice(s, j + 1);
}

test('activateSims opens the created run via job_run_id (not run_id) on success', () => {
  const fn = grabHtmlFn('activateSims');
  const successBranch = fn.slice(fn.indexOf('if (response.ok)'));
  assert.ok(
    /showActivationRunDetail\(\s*result\.job_run_id\s*\)/.test(successBranch),
    'activateSims should open the run detail view with result.job_run_id'
  );
  assert.ok(
    !/showActivationRunDetail\(\s*result\.run_id\s*\)/.test(successBranch),
    'must not use result.run_id — it is a queue-correlation string, not the activation_runs.id'
  );
});

test('the activation-runs source filter has no dead "dashboard" option', () => {
  // Backend only ever inserts source 'csv' or 'json' (see createActivationRun
  // callers in src/bulk-activator/index.js); a source="dashboard" <option>
  // can never match a row and silently hides every run while selected.
  const start = HTML.indexOf('id="ar-filter-source"');
  assert.notEqual(start, -1, 'source filter select not found');
  const end = HTML.indexOf('</select>', start);
  const block = HTML.slice(start, end);
  assert.ok(!/value="dashboard"/.test(block), 'source filter should not offer a value that never matches stored data');
});

// ---------------------------------------------------------------------
// 3. Default list filters don't hide newly created runs
// ---------------------------------------------------------------------

function makeSandbox(routes) {
  const calls = [];
  const sandbox = {
    console, Response, URL, URLSearchParams,
    async fetch(url) {
      const u = String(url);
      calls.push(u);
      for (const [pattern, handler] of routes) {
        if (u.includes(pattern)) return handler(u);
      }
      return new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractFn(SRC, 'async function supabaseGet(env, path) {'),
    extractFn(SRC, 'async function handleActivationRunsList(env, corsHeaders, url) {'),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

test('activation-runs list applies no status/source filter when none is requested', async () => {
  const freshRun = { id: 'new-run-uuid', source: 'json', status: 'queued', created_at: '2026-08-24T12:00:00Z' };
  const { sandbox, calls } = makeSandbox([
    ['/activation_runs', (u) => {
      if (u.includes('count=exact')) {
        return new Response('[]', { status: 200, headers: { 'content-range': '0-0/1' } });
      }
      return new Response(JSON.stringify([freshRun]), { status: 200 });
    }],
  ]);

  const url = new sandbox.URL('https://dashboard.test/api/activation-runs');
  const res = await sandbox.handleActivationRunsList(ENV, {}, url);
  const body = await res.json();

  assert.deepEqual(body.runs, [freshRun], 'a run with no explicit filter selection is returned');
  assert.ok(calls.some(c => c.includes('/activation_runs?select=*')), 'base query issued');
  assert.ok(!calls.some(c => c.includes('status=eq.')), 'no status filter applied when status is unset');
  assert.ok(!calls.some(c => c.includes('source=eq.')), 'no source filter applied when source is unset');
});

test('activation-runs list orders newest-first so a just-submitted run is on page one', async () => {
  const { sandbox, calls } = makeSandbox([
    ['/activation_runs', (u) => {
      if (u.includes('count=exact')) return new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } });
      return new Response('[]', { status: 200 });
    }],
  ]);
  const url = new sandbox.URL('https://dashboard.test/api/activation-runs');
  await sandbox.handleActivationRunsList(ENV, {}, url);
  assert.ok(calls.some(c => c.includes('order=created_at.desc')), 'newest runs sort first');
});
