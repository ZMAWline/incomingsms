// Product rule (Zalmen, 2026-07-29, PR #26): bad-rental reports not from
// today (New York day) are dismissed immediately — MDN rotated and a new
// rental started, so vendor action against a prior-day report can hit the
// wrong line. These tests prove:
//   - prior-day reports classify as S8 close_duplicate BEFORE any vendor call
//     (the check sits between claimReport and gatherEvidence in processReport,
//     and the dismissal path contains no vendor-read call sites),
//   - today's reports return null and fall through to the normal pipeline,
//   - the executed close matches the dashboard manual-close event shape with
//     the audit note explaining the dismissal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nyDayOf,
  isPriorNyDay,
  classifyExpiredReport,
} from '../src/bad-rental-remediator/stale-classifier.mjs';
import { executeAction } from '../src/bad-rental-remediator/actions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);

// ---------------------------------------------------------
// NY-day helper
// ---------------------------------------------------------

test('isPriorNyDay uses the New York day, not UTC', () => {
  const now = new Date('2026-07-29T15:00:00Z'); // NY 2026-07-29 11:00 EDT
  // 03:30Z on the 29th is still 23:30 on the 28th in New York → prior day.
  assert.equal(isPriorNyDay('2026-07-29T03:30:00Z', now), true);
  // Same NY day → not prior.
  assert.equal(isPriorNyDay('2026-07-29T12:00:00Z', now), false);
  // Plainly yesterday.
  assert.equal(isPriorNyDay('2026-07-28T18:00:00Z', now), true);
  // A UTC timestamp late "today" in NY is still today.
  assert.equal(nyDayOf(new Date('2026-07-30T02:00:00Z')), '2026-07-29');
});

test('isPriorNyDay never fires on missing or garbled received_at', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  assert.equal(isPriorNyDay(null, now), false);
  assert.equal(isPriorNyDay(undefined, now), false);
  assert.equal(isPriorNyDay('', now), false);
  assert.equal(isPriorNyDay('not-a-date', now), false);
});

// ---------------------------------------------------------
// classifyExpiredReport
// ---------------------------------------------------------

test('prior-day report → terminal S8 close_duplicate, no escalation', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  const c = classifyExpiredReport({ id: 7, received_at: '2026-07-28T14:00:00Z' }, now);
  assert.ok(c, 'prior-day report must classify');
  assert.equal(c.mode, 'S8');
  assert.equal(c.action, 'close_duplicate');
  assert.equal(c.outcome, 'duplicate');
  assert.equal(c.terminal, true);
  assert.equal(c.escalationReason, null);
  assert.equal(c.evidenceSummary.reason, 'expired_prior_day_report');
  assert.equal(c.evidenceSummary.report_ny_day, '2026-07-28');
  assert.equal(c.evidenceSummary.today_ny_day, '2026-07-29');
});

test('today report → null (falls through to normal pipeline)', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  assert.equal(classifyExpiredReport({ id: 7, received_at: '2026-07-29T13:00:00Z' }, now), null);
  // NY-boundary: 03:30Z "today" is NY yesterday-evening only when now is a
  // later NY day — with now on the same NY day it must NOT dismiss.
  assert.equal(classifyExpiredReport({ id: 7, received_at: '2026-07-29T18:00:00Z' }, now), null);
});

test('missing received_at → null, never dismissed on absent evidence', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  assert.equal(classifyExpiredReport({ id: 7 }, now), null);
  assert.equal(classifyExpiredReport(null, now), null);
});

// ---------------------------------------------------------
// Ordering: dismissal happens before evidence gathering / vendor calls.
// (Same source-assertion style as the INC-26 starvation tests.)
// ---------------------------------------------------------

test('processReport checks classifyExpiredReport after claim, before gatherEvidence', () => {
  const start = SRC.indexOf('async function processReport(env, report)');
  assert.ok(start !== -1);
  const body = SRC.slice(start, SRC.indexOf('async function', start + 10));
  const claimIdx = body.indexOf('claimReport(');
  const expiredIdx = body.indexOf('classifyExpiredReport(');
  const evidenceIdx = body.indexOf('gatherEvidence(');
  assert.ok(claimIdx !== -1 && expiredIdx !== -1 && evidenceIdx !== -1);
  assert.ok(claimIdx < expiredIdx, 'expired check must run on a claimed row');
  assert.ok(expiredIdx < evidenceIdx,
    'expired check must run BEFORE gatherEvidence so no vendor read fires for prior-day reports');
});

test('dismissExpiredReport path contains no vendor call sites', () => {
  const start = SRC.indexOf('async function dismissExpiredReport');
  assert.ok(start !== -1);
  const body = SRC.slice(start, SRC.indexOf('// ------', start));
  for (const vendorCall of ['readVendorView', 'teltikPortStatus', 'skylinePortStatus', 'preResolveGate']) {
    assert.ok(!body.includes(vendorCall), 'dismissal must be DB-only, found ' + vendorCall);
  }
  assert.ok(body.includes("action: 'close_duplicate'"), 'dismissal must reuse the close_duplicate executor');
  assert.ok(SRC.includes('dismissed expired/stale bad-rental report because report is from a prior day and rental/MDN may have moved on'));
});

// ---------------------------------------------------------
// Event/audit shape — the executed close matches the dashboard manual close.
// Same fake-env pattern as bad-rental-remediator-actions.test.mjs.
// ---------------------------------------------------------

function makeFakeEnv() {
  const calls = { patches: [], events: [] };
  const fakeFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rest/v1/rental_reports?id=eq.') && init && init.method === 'PATCH') {
      calls.patches.push(JSON.parse(init.body));
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/rental_reports?id=eq.')) {
      return new Response(JSON.stringify([{ id: 9, status: 'received', triaged_at: null, closed_at: null }]), { status: 200 });
    }
    if (u.includes('/rest/v1/rental_report_events') && init && init.method === 'POST') {
      calls.events.push(JSON.parse(init.body));
      return new Response('[]', { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    REMEDIATOR_KV: { async get() { return null; } },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return { env, calls, restore: () => { globalThis.fetch = orig; } };
}

test('expired dismissal close matches manual close_duplicate event shape', async () => {
  const { env, calls, restore } = makeFakeEnv();
  try {
    const classification = classifyExpiredReport(
      { id: 9, received_at: '2026-07-28T14:00:00Z', status: 'received' },
      new Date('2026-07-29T15:00:00Z'),
    );
    const res = await executeAction(env, {
      action: 'close_duplicate',
      report: { id: 9, status: 'received' },
      situationId: classification.mode,
      evidenceBundle: classification.evidenceSummary,
      note: 'dismissed expired/stale bad-rental report because report is from a prior day and rental/MDN may have moved on',
    });
    assert.equal(res.ok, true);
    assert.equal(res.terminalReport.status, 'duplicate');

    assert.equal(calls.patches.length, 1);
    assert.equal(calls.patches[0].status, 'duplicate');
    assert.ok(calls.patches[0].closed_at, 'closed_at must be stamped');
    assert.ok(calls.patches[0].triaged_at, 'received report gets triaged_at like the dashboard close');

    assert.equal(calls.events.length, 1);
    const ev = calls.events[0];
    assert.equal(ev.actor, 'auto-remediator');
    assert.equal(ev.to_status, 'duplicate');
    assert.equal(ev.from_status, 'received');
    assert.ok(ev.note.includes('dismissed expired/stale bad-rental report because report is from a prior day and rental/MDN may have moved on'));
    assert.equal(ev.evidence.source, 'auto_remediator');
    assert.equal(ev.evidence.classifier.reason, 'expired_prior_day_report');
  } finally {
    restore();
  }
});
