// INC-3 follow-up — status-normalization unit tests for /api/sims/reports.
//
// Exercises src/shared/rental-report-status.js directly. The reseller-portal
// handler is a thin wrapper that turns the returned filter fragment into the
// PostgREST query, so covering the helper covers the behaviour.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const bundle = '/tmp/rental-report-status.bundle.test.' + process.pid + '.mjs';

execFileSync('npx', ['--yes', 'esbuild',
  'src/shared/rental-report-status.js',
  '--bundle', '--format=esm', '--outfile=' + bundle, '--log-level=error',
], { cwd: repo });

const { buildStatusFilter } = await import(bundle + '?cache=' + Date.now());

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ', name);
  } catch (err) {
    failed++;
    console.log('  FAIL', name);
    console.log('       ', err && err.message);
  }
}

console.log('rental-report-status.buildStatusFilter');

test('status=open expands to received,in_triage', () => {
  const r = buildStatusFilter('open');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(received,in_triage)');
});

test('status=resolved expands to remediated,unable_to_reproduce,duplicate', () => {
  const r = buildStatusFilter('resolved');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(remediated,unable_to_reproduce,duplicate)');
});

test('status=all produces no filter', () => {
  const r = buildStatusFilter('all');
  assert.equal(r.ok, true);
  assert.equal(r.filter, null);
});

test('literal status=received passes through as eq', () => {
  const r = buildStatusFilter('received');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=eq.received');
});

test('literal status=remediated passes through as eq', () => {
  const r = buildStatusFilter('remediated');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=eq.remediated');
});

test('literal status=in_triage passes through as eq', () => {
  const r = buildStatusFilter('in_triage');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=eq.in_triage');
});

test('literal status=unable_to_reproduce passes through as eq', () => {
  const r = buildStatusFilter('unable_to_reproduce');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=eq.unable_to_reproduce');
});

test('literal status=duplicate passes through as eq', () => {
  const r = buildStatusFilter('duplicate');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=eq.duplicate');
});

test('status=garbage returns bad_request with accepted list', () => {
  const r = buildStatusFilter('garbage');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_request');
  assert.ok(Array.isArray(r.accepted));
  assert.ok(r.accepted.includes('open'));
  assert.ok(r.accepted.includes('resolved'));
  assert.ok(r.accepted.includes('all'));
  assert.ok(r.accepted.includes('received'));
  assert.ok(r.accepted.includes('remediated'));
});

test('missing status (null) defaults to open', () => {
  const r = buildStatusFilter(null);
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(received,in_triage)');
});

test('missing status (undefined) defaults to open', () => {
  const r = buildStatusFilter(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(received,in_triage)');
});

test('empty string status defaults to open', () => {
  const r = buildStatusFilter('');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(received,in_triage)');
});

test('status is case-insensitive (Resolved → resolved)', () => {
  const r = buildStatusFilter('Resolved');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(remediated,unable_to_reproduce,duplicate)');
});

test('whitespace around status is trimmed', () => {
  const r = buildStatusFilter('  open  ');
  assert.equal(r.ok, true);
  assert.equal(r.filter, '&status=in.(received,in_triage)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
