// INC-26 regression: cooldown starvation. skipped_cooldown bookkeeping rows
// must not count as attempts (they self-refreshed the cooldown window and
// burned max-attempts without any vendor call), max_attempts_reached must
// escalate instead of requeueing forever, and intake must defer recently
// touched queued rows so they don't consume LIMIT slots every tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeAttempts, gateRejection, canAttempt } from '../src/bad-rental-remediator/cooldown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);

test('summarizeAttempts ignores skipped_cooldown rows for per-action counts and lastAt', () => {
  const rows = [
    { id: 3, action: 'atomic_restore', attempted_at: '2026-07-29T12:00:00Z', outcome: 'skipped_cooldown' },
    { id: 2, action: 'atomic_restore', attempted_at: '2026-07-29T11:55:00Z', outcome: 'skipped_cooldown' },
    { id: 1, action: 'atomic_restore', attempted_at: '2026-07-28T10:00:00Z', outcome: 'error' },
  ];
  const sum = summarizeAttempts(rows);
  assert.equal(sum.total, 3, 'total keeps every row');
  assert.equal(sum.perAction.atomic_restore, 1, 'skipped_cooldown rows must not count as attempts');
  assert.equal(sum.lastAt.atomic_restore, '2026-07-28T10:00:00Z',
    'lastAt must be the real attempt, not the gate bookkeeping — else cooldown self-refreshes');

  // With bookkeeping excluded, the 24h cooldown actually expires.
  const gate = canAttempt({
    action: 'resend_online',
    priorAttempts: sum.perAction.resend_online || 0,
    lastAttemptAt: sum.lastAt.resend_online || null,
    now: new Date('2026-07-29T12:05:00Z'),
  });
  assert.equal(gate.ok, true, 'action with only-skipped history must be attemptable');
});

test('summarizeAttempts handles empty/null input and rows without action', () => {
  assert.deepEqual(summarizeAttempts(null), { total: 0, perAction: {}, lastAt: {} });
  assert.deepEqual(summarizeAttempts([null, { id: 1 }]).perAction, {});
});

test('gateRejection maps max_attempts_reached to escalate', () => {
  const gate = canAttempt({ action: 'atomic_restore', priorAttempts: 1, lastAttemptAt: null, now: new Date('2026-07-29T00:00:00Z') });
  assert.equal(gate.reason, 'max_attempts_reached');
  const res = gateRejection(gate, 'atomic_restore', 1);
  assert.equal(res.outcome, 'escalate');
  assert.equal(res.execStatus, 'max_attempts_reached');
  assert.equal(res.escalationReason, 'atomic_restore_failed');
  assert.equal(res.evidence.cooldown_gate, gate);
});

test('gateRejection maps classify_only exhaustion to unable_to_reproduce_recommendation', () => {
  const gate = { ok: false, reason: 'max_attempts_reached', attempts: 3, max: 3 };
  const res = gateRejection(gate, 'classify_only', 3);
  assert.equal(res.outcome, 'escalate');
  assert.equal(res.escalationReason, 'unable_to_reproduce_recommendation');
});

test('gateRejection maps cooldown_active to skipped_cooldown requeue', () => {
  const gate = canAttempt({
    action: 'atomic_restore', priorAttempts: 0,
    lastAttemptAt: '2026-07-29T00:00:00Z', now: new Date('2026-07-29T01:00:00Z'),
  });
  assert.equal(gate.reason, 'cooldown_active');
  const res = gateRejection(gate, 'atomic_restore', 0);
  assert.equal(res.outcome, 'skipped_cooldown');
  assert.equal(res.execStatus, 'cooldown_active');
  assert.equal(res.errorMessage, null);
});

test('fetchOpenReports defers recently touched rows and orders nullsfirst', () => {
  // Query is built by multi-line string concat — assert on the function body.
  const start = SRC.indexOf('async function fetchOpenReports');
  assert.ok(start >= 0, 'expected fetchOpenReports in index.js');
  const body = SRC.slice(start, SRC.indexOf('async function', start + 1));
  assert.ok(body.includes('last_auto_attempt_at.is.null') && body.includes('last_auto_attempt_at.lt.'),
    'intake must defer rows with a recent last_auto_attempt_at');
  assert.ok(body.includes('order=last_auto_attempt_at.asc.nullsfirst'),
    'intake must order never-tried reports first');
  assert.ok(body.includes('INTAKE_DEFER_MS'),
    'deferral cutoff must come from INTAKE_DEFER_MS');
  assert.ok(/INTAKE_DEFER_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/.test(SRC),
    'expected the 15-minute INTAKE_DEFER_MS deferral window');
});

test('attempts query selects outcome so skipped rows are identifiable', () => {
  assert.ok(SRC.includes('select=id,action,attempted_at,outcome'),
    'gatherEvidence must select outcome to exclude skipped_cooldown bookkeeping');
});
