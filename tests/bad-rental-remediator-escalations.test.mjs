// Tests for INC-22 / INC-16f — operator escalations + vendor batch ticket.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATION_FAILURE_TYPES,
  ESCALATION_SINK,
  LEGACY_CREDENTIALS_ERROR,
  normalizeFailureType,
  groupEscalations,
  computeTickId,
  buildEscalationIssue,
  buildInboxSummary,
  buildVendorBatchIssue,
  buildIssueForRow,
  deliverEscalation,
  drainQueuedEscalations,
  fetchEscalationBacklog,
  flushEscalations,
  missingPaperclipCredentials,
  maybeOpenVendorBatchTickets,
  reserveEscalation,
} from '../src/bad-rental-remediator/escalations.mjs';

// ---------------------------------------------------------
// Failure-type normalization
// ---------------------------------------------------------

test('ESCALATION_FAILURE_TYPES enumerates the bad-rental operator failure types', () => {
  // BRR-FIX-SPEC R1/R3/R5/R6 added 5 distinct reasons: teltik_host_port_read_failed,
  // gateway_port_offline_unresolved, teltik_line_not_seated, verify_sms_disabled,
  // reprocessing_loop.
  assert.equal(ESCALATION_FAILURE_TYPES.length, 22);
  for (const t of [
    'verify_send_failed', 'verify_receive_timeout', 'vendor_active_no_sms',
    'vendor_iccid_not_found', 'imei_wrong_type', 'imei_drift_vendor',
    'vendor_cancelled_active_rental', 'wing_w7_dialable_retry_failed',
    'helix_unsuspend_failed', 'atomic_restore_failed', 'teltik_reset_failed',
    'teltik_gateway_port_offline', 'teltik_forward_url_misconfigured', 'unable_to_reproduce_recommendation',
    'vendor_read_failed', 'vendor_mdn_drift',
    'teltik_host_port_read_failed', 'gateway_port_offline_unresolved',
    'teltik_line_not_seated', 'verify_sms_disabled', 'reprocessing_loop',
    'generic',
  ]) assert.ok(ESCALATION_FAILURE_TYPES.includes(t), 'missing ' + t);
});

test('normalizeFailureType: pass-through known + alias mapping', () => {
  assert.equal(normalizeFailureType('verify_send_failed'), 'verify_send_failed');
  assert.equal(normalizeFailureType('wing_not_activated'), 'wing_w7_dialable_retry_failed');
  assert.equal(normalizeFailureType('insufficient_evidence'), 'generic');
  assert.equal(normalizeFailureType(null), 'generic');
  assert.equal(normalizeFailureType(''), 'generic');
  assert.equal(normalizeFailureType('helix_unsuspend_xyz'), 'helix_unsuspend_failed');
  assert.equal(normalizeFailureType('teltik_gateway_port_offline'), 'teltik_gateway_port_offline');
});

// ---------------------------------------------------------
// Grouping
// ---------------------------------------------------------

test('groupEscalations: collapses (vendor, failure_type) into one batch', () => {
  const candidates = [
    { vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 1 } },
    { vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 2 } },
    { vendor: 'atomic', failure_type: 'atomic_restore_failed', line_item: { report_id: 3 } },
    { vendor: 'helix', failure_type: 'verify_send_failed',      line_item: { report_id: 4 } },
  ];
  const groups = groupEscalations(candidates);
  assert.equal(groups.length, 3);
  const helixUnsuspend = groups.find(g => g.vendor === 'helix' && g.failure_type === 'helix_unsuspend_failed');
  assert.equal(helixUnsuspend.items.length, 2);
});

test('groupEscalations: vendor case normalized; missing → unknown', () => {
  const groups = groupEscalations([
    { vendor: 'HELIX', failure_type: 'generic', line_item: { report_id: 9 } },
    { vendor: undefined, failure_type: 'generic', line_item: { report_id: 10 } },
  ]);
  assert.equal(groups.length, 2);
  assert.ok(groups.find(g => g.vendor === 'helix'));
  assert.ok(groups.find(g => g.vendor === 'unknown'));
});

// ---------------------------------------------------------
// Tick id (dedup key)
// ---------------------------------------------------------

test('computeTickId: rounds down to 2h UTC slot', () => {
  assert.equal(computeTickId(new Date('2026-06-09T03:17:42Z')), '2026-06-09T02:00:00.000Z');
  assert.equal(computeTickId(new Date('2026-06-09T04:00:00Z')), '2026-06-09T04:00:00.000Z');
  // Two retries inside the same 2h tick produce the same id (dedup).
  assert.equal(
    computeTickId(new Date('2026-06-09T05:01:00Z')),
    computeTickId(new Date('2026-06-09T05:59:59Z')),
  );
});

// ---------------------------------------------------------
// Issue body
// ---------------------------------------------------------

test('buildEscalationIssue: includes vendor, failure_type, tick, per-line ids', () => {
  const { title, body } = buildEscalationIssue({
    vendor: 'helix',
    failure_type: 'helix_unsuspend_failed',
    items: [
      { report_id: 101, reseller_rental_id: 'RR-1', current_mdn: '+15555550100', iccid: '8901260...001', vendor: 'helix', situation_id: 'H4',
        attempts: [{ action: 'helix_unsuspend', outcome: 'failed', vendor_request_id: 'req-xyz' }],
        verify_state: { sent: true, received: false },
        suggested_next: 'Manually unsuspend.' },
    ],
    tickId: '2026-06-09T02:00:00.000Z',
    parentIssueId: 'INC-16',
  });
  assert.ok(title.includes('helix'));
  assert.ok(title.includes('helix_unsuspend_failed'));
  assert.ok(title.includes('1 rental'));
  assert.ok(body.includes('Report 101'));
  assert.ok(body.includes('RR-1'));
  assert.ok(body.includes('+15555550100'));
  assert.ok(body.includes('8901260...001'));
  assert.ok(body.includes('req-xyz'));
  assert.ok(body.includes('Parent: INC-16'));
});

// §H.3 forbidden surface: never include reseller-secret keys.
test('buildEscalationIssue: emits no `password`, `token`, `bearer`, `secret`, `api_key`', () => {
  const { body } = buildEscalationIssue({
    vendor: 'atomic',
    failure_type: 'atomic_restore_failed',
    items: [{ report_id: 1, iccid: 'x', attempts: [{ action: 'atomic_restore', outcome: 'failed' }] }],
    tickId: 't',
  });
  for (const banned of ['password', 'bearer ', 'api_key', 'secret', 'service_role_key']) {
    assert.equal(body.toLowerCase().includes(banned), false, 'leaked: ' + banned);
  }
});

// §H.4 vendor-batch ticket → vendor-side ICCID only, no reseller-facing ids.
test('buildVendorBatchIssue: ICCIDs only, no reseller identifiers', () => {
  const { title, body } = buildVendorBatchIssue({
    vendor: 'atomic',
    iccids: ['ICCID-1', 'ICCID-2', 'ICCID-3', 'ICCID-4', 'ICCID-5'],
    tickId: '2026-06-09T02:00:00.000Z',
    parentIssueId: 'INC-16',
  });
  assert.ok(title.includes('vendor-batch'));
  assert.ok(title.includes('atomic'));
  assert.ok(body.includes('ICCID-1'));
  assert.ok(body.includes('ICCID-5'));
  for (const banned of ['reseller_rental_id', 'reseller_id', 'rental_id']) {
    assert.equal(body.toLowerCase().includes(banned), false, 'leaked: ' + banned);
  }
});

// ---------------------------------------------------------
// flushEscalations — end-to-end with stubbed fetch
// ---------------------------------------------------------

function buildEnvWithFakeFetch({ insertConflicts = {} } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body || null });
    const u = String(url);
    if (u.includes('/rest/v1/operator_escalations') && (!init || init.method === 'POST')) {
      const body = JSON.parse(init.body);
      const key = body.tick_id + '|' + body.vendor + '|' + body.failure_type;
      if (insertConflicts[key]) {
        return new Response('conflict', { status: 409 });
      }
      const row = { id: 100 + calls.length, ...body };
      return new Response(JSON.stringify([row]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/rest/v1/operator_escalations') && init && init.method === 'PATCH') {
      return new Response(null, { status: 200 });
    }
    if (u.includes('/rest/v1/pending_review_items') && init && init.method === 'POST') {
      return new Response(JSON.stringify([{ id: 'PRI-' + calls.length }]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/issues')) {
      return new Response(JSON.stringify({ id: 'INC-AUTO-1' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/rest/v1/sims')) {
      // Used by maybeOpenVendorBatchTickets.
      return new Response(JSON.stringify([
        { iccid: 'A' }, { iccid: 'B' }, { iccid: 'C' }, { iccid: 'D' }, { iccid: 'E' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not stubbed: ' + u, { status: 500 });
  };
  return {
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      PAPERCLIP_API_URL: 'https://paperclip.example.com',
      PAPERCLIP_API_KEY: 'pck',
    },
    calls,
    restore() { globalThis.fetch = realFetch; },
  };
}

test('flushEscalations: groups by (vendor,failure_type), delivers one inbox item per batch', async () => {
  const { env, calls, restore } = buildEnvWithFakeFetch();
  try {
    const result = await flushEscalations(env, {
      now: new Date('2026-06-09T03:00:00Z'),
      candidates: [
        { vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 1 } },
        { vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 2 } },
        { vendor: 'atomic', failure_type: 'atomic_restore_failed', line_item: { report_id: 3 } },
      ],
    });
    assert.equal(result.batches, 2);
    assert.equal(result.reserved, 2);
    assert.equal(result.delivered, 2);
    const inboxPosts = calls.filter(c => c.method === 'POST' && c.url.includes('/pending_review_items'));
    assert.equal(inboxPosts.length, 2);
  } finally { restore(); }
});

test('flushEscalations: 409 on UNIQUE conflict → skipped_dedup, no Paperclip POST', async () => {
  const tickId = computeTickId(new Date('2026-06-09T03:00:00Z'));
  const { env, calls, restore } = buildEnvWithFakeFetch({
    insertConflicts: { [tickId + '|helix|helix_unsuspend_failed']: true },
  });
  try {
    const result = await flushEscalations(env, {
      now: new Date('2026-06-09T03:00:00Z'),
      candidates: [
        { vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 1 } },
      ],
    });
    assert.equal(result.skipped_dedup, 1);
    assert.equal(result.delivered, 0);
    assert.equal(calls.filter(c => c.url.includes('/api/issues')).length, 0);
  } finally { restore(); }
});

test('flushEscalations: Paperclip creds are not required for inbox delivery', async () => {
  const { env, calls, restore } = buildEnvWithFakeFetch();
  delete env.PAPERCLIP_API_URL;
  delete env.PAPERCLIP_API_KEY;
  try {
    const result = await flushEscalations(env, {
      now: new Date('2026-06-09T03:00:00Z'),
      candidates: [{ vendor: 'helix', failure_type: 'helix_unsuspend_failed', line_item: { report_id: 1 } }],
    });
    assert.equal(result.reserved, 1);
    assert.equal(result.delivered, 1);
    assert.equal(calls.filter(c => c.url.includes('/pending_review_items')).length, 1);
    assert.equal(calls.filter(c => c.url.includes('/api/issues')).length, 0);
  } finally { restore(); }
});

test('missingPaperclipCredentials: Paperclip is no longer required', () => {
  assert.deepEqual(missingPaperclipCredentials({}), []);
  assert.deepEqual(missingPaperclipCredentials({ PAPERCLIP_API_URL: 'https://paperclip.example' }), []);
  assert.deepEqual(missingPaperclipCredentials({ PAPERCLIP_API_URL: 'https://paperclip.example', PAPERCLIP_API_KEY: 'pck' }), []);
});

test('fetchEscalationBacklog: returns aggregate counts only and raises action alert', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).includes('/rest/v1/operator_escalations?status=not.in.(delivered,posted)'));
    assert.equal(init.headers.Prefer, 'count=exact');
    return new Response(JSON.stringify([
      { id: 1, status: 'queued', last_error: 'paperclip_credentials_missing', failure_type: 'verify_send_failed', vendor: 'atomic', created_at: '2026-08-01T00:00:00Z' },
      { id: 2, status: 'queued', last_error: 'paperclip_credentials_missing', failure_type: 'generic', vendor: 'teltik', created_at: '2026-08-02T00:00:00Z' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json', 'content-range': '0-1/2' } });
  };
  try {
    const out = await fetchEscalationBacklog({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv' });
    assert.equal(out.total, 2);
    assert.equal(out.by_vendor.atomic, 1);
    assert.equal(out.by_failure_type.generic, 1);
    assert.equal(out.needs_action, 2);
    assert.equal(out.legacy_paperclip_rows, 2);
    assert.equal(out.alert, true);
    assert.equal(out.sink.external_credentials_required, false);
    assert.equal(JSON.stringify(out).includes('line_items'), false);
    assert.equal(JSON.stringify(out).includes('+1555'), false);
  } finally { globalThis.fetch = realFetch; }
});

test('drainQueuedEscalations: dry-run needs no Paperclip creds and does not PATCH rows', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
    return new Response(JSON.stringify([
      { id: 1, status: 'queued', last_error: 'paperclip_credentials_missing', failure_type: 'verify_send_failed', vendor: 'atomic', created_at: '2026-08-01T00:00:00Z' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json', 'content-range': '0-0/1' } });
  };
  try {
    const out = await drainQueuedEscalations({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv' }, { dryRun: true });
    assert.equal(out.ok, true);
    assert.equal(out.delivered, 0);
    assert.equal(out.planned.length, 1);
    assert.equal(calls.some(c => c.method === 'PATCH'), false);
    assert.equal(calls.some(c => c.url.includes('/api/issues')), false);
  } finally { globalThis.fetch = realFetch; }
});

test('drainQueuedEscalations: dry-run previews counts without posting PII-bearing bodies', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
    const u = String(url);
    if (u.includes('status=not.in.(delivered,posted)')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json', 'content-range': '*/0' } });
    }
    if (u.includes('status=in.(queued,post_failed,delivery_failed)')) {
      return new Response(JSON.stringify([
        {
          id: 9,
          tick_id: '2026-08-01T00:00:00.000Z',
          vendor: 'atomic',
          failure_type: 'verify_send_failed',
          status: 'queued',
          last_error: 'paperclip_credentials_missing',
          report_ids: [101, 102],
          line_items: [{ report_id: 101, current_mdn: '+15551234567', iccid: '89014103211118510720' }],
          paperclip_issue_id: null,
          created_at: '2026-08-01T00:00:00Z',
        },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not stubbed', { status: 500 });
  };
  try {
    const out = await drainQueuedEscalations({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      PAPERCLIP_API_URL: 'https://paperclip.example.com',
      PAPERCLIP_API_KEY: 'pck',
    }, { dryRun: true, limit: 500 });
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true);
    assert.equal(out.limit, 200); // clamped
    assert.equal(out.planned.length, 1);
    assert.equal(out.planned[0].report_count, 2);
    assert.equal(out.planned[0].line_item_count, 1);
    assert.equal(JSON.stringify(out.planned).includes('+15551234567'), false);
    assert.equal(JSON.stringify(out.planned).includes('89014103211118510720'), false);
    assert.equal(calls.some(c => c.url.includes('/api/issues')), false);
  } finally { globalThis.fetch = realFetch; }
});

test('drainQueuedEscalations: posts one issue and stamps row, skipping already-posted rows', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
    const u = String(url);
    if (u.includes('status=not.in.(delivered,posted)')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json', 'content-range': '*/0' } });
    }
    if (u.includes('status=in.(queued,post_failed,delivery_failed)')) {
      return new Response(JSON.stringify([
        {
          id: 10,
          tick_id: '2026-08-01T00:00:00.000Z',
          vendor: 'atomic',
          failure_type: 'verify_send_failed',
          status: 'queued',
          last_error: 'paperclip_credentials_missing',
          report_ids: [101],
          line_items: [{ report_id: 101, current_mdn: '+155****4567', iccid: '8901410...0720' }],
          paperclip_issue_id: null,
        },
        { id: 11, status: 'post_failed', paperclip_issue_id: 'INC-OLD' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/pending_review_items')) {
      return new Response(JSON.stringify([{ id: 'PRI-10' }]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/rest/v1/operator_escalations') && init.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    return new Response('not stubbed', { status: 500 });
  };
  try {
    const out = await drainQueuedEscalations({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      PAPERCLIP_API_URL: 'https://paperclip.example.com',
      PAPERCLIP_API_KEY: 'pck',
    }, { dryRun: false, limit: 2 });
    assert.equal(out.delivered, 1);
    assert.equal(out.skipped, 1);
    assert.equal(calls.filter(c => c.url.includes('/pending_review_items')).length, 1);
    const patch = calls.find(c => c.method === 'PATCH');
    assert.ok(patch, 'expected row update');
    const patchBody = JSON.parse(patch.body);
    assert.equal(patchBody.status, 'delivered');
    assert.match(patchBody.paperclip_issue_id, /^inbox:/);
  } finally { globalThis.fetch = realFetch; }
});

test('buildIssueForRow: rebuilds vendor_batch payload from stored ICCID rows', () => {
  const issue = buildIssueForRow({
    tick_id: '2026-08-01T00:00:00.000Z',
    vendor: 'atomic',
    failure_type: 'vendor_batch',
    paperclip_parent_id: 'INC-16',
    line_items: [{ iccid: 'A' }, { iccid: 'B' }, { iccid: null }],
  });
  assert.ok(issue.title.includes('vendor-batch'));
  assert.ok(issue.body.includes('`A`'));
  assert.ok(issue.body.includes('`B`'));
  assert.equal(issue.body.includes('rental_id'), false);
});

// ---------------------------------------------------------
// §H.4 vendor-batch toggle gating
// ---------------------------------------------------------

function fakeKV(values) {
  return {
    async get(k) { return values[k] ?? null; },
  };
}

test('maybeOpenVendorBatchTickets: toggle off → no issue opened even when ≥5', async () => {
  const { env, calls, restore } = buildEnvWithFakeFetch();
  env.REMEDIATOR_KV = fakeKV({}); // all carriers default off
  try {
    const result = await maybeOpenVendorBatchTickets(env, { now: new Date('2026-06-09T03:00:00Z') });
    assert.equal(result.opened, 0);
    for (const v of result.vendors) assert.equal(v.enabled, false);
    assert.equal(calls.filter(c => c.url.includes('/api/issues')).length, 0);
  } finally { restore(); }
});

test('maybeOpenVendorBatchTickets: toggle on + 5 ICCIDs → exactly one ticket', async () => {
  const { env, calls, restore } = buildEnvWithFakeFetch();
  env.REMEDIATOR_KV = fakeKV({ vendor_batch_ticket_atomic: 'true' });
  try {
    const result = await maybeOpenVendorBatchTickets(env, { now: new Date('2026-06-09T03:00:00Z') });
    assert.equal(result.opened, 1);
    const inboxPosted = calls.filter(c => c.url.includes('/pending_review_items'));
    assert.equal(inboxPosted.length, 1);
    const body = JSON.parse(inboxPosted[0].body)[0];
    assert.ok(body.summary.includes('atomic'));
    assert.ok(body.details_md.includes('ICCID-1') === false); // sims-stub returns A..E
    assert.ok(body.details_md.includes('`A`'));
    assert.ok(body.details_md.includes('`E`'));
  } finally { restore(); }
});

// ---------------------------------------------------------
// reserveEscalation API contract
// ---------------------------------------------------------

test('reserveEscalation: returns null on 409', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 409 });
  try {
    const out = await reserveEscalation(
      { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      { tick_id: 't', vendor: 'helix', failure_type: 'verify_send_failed', report_ids: [], line_items: [] },
    );
    assert.equal(out, null);
  } finally { globalThis.fetch = realFetch; }
});
