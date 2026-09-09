// Fleet-wide SIM status counts for the filter menu.
//
// The menu used to count tableState.sims.data, the rows currently loaded. But
// status is filtered server-side — the default /api/sims query appends
// status=neq.canceled — so no cancelled row was ever present and the menu
// showed "Cancelled (0)" while hundreds existed. These pin the fix: the count
// comes from the table, not from what happens to be on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dashboardWorker = readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0;
  let started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    if (c === '}') {
      depth--;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated: ' + signature);
}

test('/api/sims/status-counts tallies every status in the table, not the loaded page', async () => {
  let capturedQuery = '';
  const sandbox = {
    Response,
    console,
    async supabaseGetAllArray(_env, query) {
      capturedQuery = query;
      return [
        ...Array.from({ length: 3 }, () => ({ status: 'active' })),
        ...Array.from({ length: 2 }, () => ({ status: 'canceled' })),
        { status: 'rotation_failed' },
        { status: null },
      ];
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(dashboardWorker, 'async function handleSimsStatusCounts(env, corsHeaders) {'), sandbox);

  const res = await sandbox.handleSimsStatusCounts({}, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  // No status predicate: the whole table is counted, cancelled included.
  assert.ok(!/status=/.test(capturedQuery), 'the tally must not filter by status');
  assert.equal(body.counts.active, 3);
  assert.equal(body.counts.canceled, 2, 'cancelled must be counted, not excluded');
  assert.equal(body.counts.rotation_failed, 1);
  assert.equal(body.counts.unknown, 1, 'a null status is bucketed rather than dropped');
  assert.equal(body.total, 7);
});

test('a failed tally degrades instead of breaking the filter menu', async () => {
  const sandbox = {
    Response,
    console,
    async supabaseGetAllArray() { throw new Error('PostgREST down'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(dashboardWorker, 'async function handleSimsStatusCounts(env, corsHeaders) {'), sandbox);

  const res = await sandbox.handleSimsStatusCounts({}, {});
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
});

test('the route is registered and does not collide with /api/sims', () => {
  assert.match(dashboardWorker, /url\.pathname === '\/api\/sims\/status-counts'/);
  // /api/sims is an exact match, so the sub-path cannot be shadowed by it.
  assert.match(dashboardWorker, /url\.pathname === '\/api\/sims'/);
});

test('the status menu prefers fleet-wide counts over loaded rows', () => {
  assert.match(dashboardHtml, /SIMS_STATUS_COUNTS/, 'menu must read the fleet-wide tally');
  assert.match(dashboardHtml, /const counts = SIMS_STATUS_COUNTS \|\| loaded/, 'and fall back to loaded rows');
  assert.match(dashboardHtml, /\/sims\/status-counts/, 'frontend must fetch the tally');
});

test('statuses missing from the hardcoded list still appear in the menu', () => {
  // rotation_failed exists in the fleet but was never in STATUS_OPTS, leaving
  // those SIMs unfilterable and uncounted.
  const fn = dashboardHtml.slice(dashboardHtml.indexOf('function openSimsFilterMenu'));
  const statusBranch = fn.slice(0, fn.indexOf("} else if (kind === 'vendor')"));
  assert.match(statusBranch, /known\.has\(st\)/, 'unknown statuses must be appended to the options');
  assert.match(statusBranch, /opts\.splice/, 'and inserted before the trailing server-flag option');
});
