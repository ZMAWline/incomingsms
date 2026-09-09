// Structural regression test: every state-mutating dashboard route must be
// method-guarded.
//
// Before 2026-09-09 these nine routes were dispatched as a bare
// `if (url.pathname === '/api/cancel') { ... }` with no method check, so a
// plain GET — a prefetched link, a browser address bar, a crawler, an <img>
// tag — performed a real carrier action against real billable lines. Every
// caller in this repo already sent POST, so adding the guards broke nothing;
// the danger was always the request nobody wrote.
//
// This test reads src/dashboard/index.js as text (rather than booting the
// dispatcher) so it fails the moment the `&& request.method === 'POST'` is
// dropped from any of them, whatever the handler does afterwards.
//
// The role gate in src/shared/portal-auth.mjs is a separate, path-first layer
// and is deliberately NOT method-aware — see tests/portal-auth.test.mjs. These
// two tests guard each other: neither layer may be removed on the grounds that
// the other one exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'index.js'),
  'utf8',
);

// Routes that mutate state (carrier calls, DB writes, webhook sends) and must
// never be reachable by GET.
const GUARDED_ROUTES = [
  '/api/activate',
  '/api/cancel',
  '/api/suspend',
  '/api/restore',
  '/api/rotate-sim',
  '/api/fix-sim',
  '/api/send-test-sms',
  '/api/sim-online',
  '/api/debug-cancel',
];

// Every dispatcher line that tests this exact pathname. A route may legitimately
// appear more than once (GET list + POST write, as /api/qbo-mappings does), so
// collect them all rather than assuming one.
function dispatchLinesFor(route) {
  const needle = "url.pathname === '" + route + "'";
  return SRC.split('\n')
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.includes(needle));
}

test('each mutating route is dispatched at least once', () => {
  for (const route of GUARDED_ROUTES) {
    const hits = dispatchLinesFor(route);
    assert.ok(
      hits.length > 0,
      route + ' has no `url.pathname === ...` dispatch line — was it renamed? ' +
        'Update GUARDED_ROUTES here too, or the guard silently stops being tested.',
    );
  }
});

test('every mutating route is guarded with request.method === POST', () => {
  for (const route of GUARDED_ROUTES) {
    for (const { line, lineNo } of dispatchLinesFor(route)) {
      assert.ok(
        line.includes("request.method === 'POST'"),
        'src/dashboard/index.js:' + lineNo + ' dispatches ' + route +
          " without `&& request.method === 'POST'`. A bare GET would perform " +
          'a real carrier action. Line was:\n  ' + line.trim(),
      );
    }
  }
});

// No mutating route may be reachable by GET even in a second, separate branch
// (e.g. someone adding `if (pathname === '/api/cancel' && method === 'GET')`
// as a "read-only preview" that still calls the mutating handler).
test('no mutating route has a GET branch', () => {
  for (const route of GUARDED_ROUTES) {
    for (const { line, lineNo } of dispatchLinesFor(route)) {
      assert.ok(
        !line.includes("request.method === 'GET'"),
        'src/dashboard/index.js:' + lineNo + ' adds a GET branch for ' + route +
          ', which is a mutating route. Line was:\n  ' + line.trim(),
      );
    }
  }
});

// The nine routes are also the ALWAYS_MUTATING entries that the path-first role
// gate depends on. If someone deletes a route from portal-auth.mjs because "it
// has a POST guard now", the defence-in-depth layer is gone.
test('every mutating route stays in the ALWAYS_MUTATING role-gate list', async () => {
  const authSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'portal-auth.mjs'),
    'utf8',
  );
  const start = authSrc.indexOf('const ALWAYS_MUTATING');
  assert.notEqual(start, -1, 'ALWAYS_MUTATING list not found in portal-auth.mjs');
  const block = authSrc.slice(start, authSrc.indexOf('];', start));
  for (const route of GUARDED_ROUTES) {
    assert.ok(
      block.includes("'" + route + "'"),
      route + ' is missing from ALWAYS_MUTATING in src/shared/portal-auth.mjs. ' +
        'The method guard and the path-first role gate are two layers; keep both.',
    );
  }
});
