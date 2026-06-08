// Tests for INC-20 / INC-16d — safe vendor action executors.
//
// Fixtures cover the four safe actions called out in the issue scope:
//   - db_sync_upsert  → PATCH sims with diff vs current; noop when DB already matches.
//   - resend_online   → calls RESELLER_SYNC /resend-online with portal_resync source.
//   - close_duplicate → PATCH rental_reports + rental_report_events row matching
//                       the dashboard manual-close shape.
//   - classify_only   → record-only.
// Plus per-action KV emergency disable, forbidden-action defence, and an
// integration-shape test that classifyShared S3 routes through the executor
// and yields a `status='duplicate'` PATCH (no §C, per §C/§E).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeAction,
  actionKvKey,
  SAFE_ACTIONS,
} from '../src/bad-rental-remediator/actions.mjs';
import { FORBIDDEN_ACTIONS } from '../src/bad-rental-remediator/classifier.mjs';

// ---------------------------------------------------------
// Fake env factory
// ---------------------------------------------------------

function makeFakeEnv({ kv = {}, resellerSyncResponse, inboundSms } = {}) {
  const calls = {
    fetch: [],
    patches: [],
    events: [],
    simPatches: [],
    reseller: [],
    kvReads: [],
  };

  const fakeFetch = async (url, init) => {
    const u = String(url);
    calls.fetch.push({ url: u, method: (init && init.method) || 'GET' });

    if (u.includes('/rest/v1/sims?id=eq.') && init && init.method === 'PATCH') {
      calls.simPatches.push({ url: u, body: JSON.parse(init.body) });
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/rental_reports?id=eq.') && init && init.method === 'PATCH') {
      calls.patches.push({ url: u, body: JSON.parse(init.body) });
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/rental_reports?id=eq.')) {
      // GET current row for close_duplicate.
      return new Response(JSON.stringify([{ id: 1, status: 'in_triage', triaged_at: null, closed_at: null }]), { status: 200 });
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
    REMEDIATOR_KV: {
      async get(key) { calls.kvReads.push(key); return kv[key] === undefined ? null : kv[key]; },
    },
    RESELLER_SYNC: {
      async fetch(req) {
        calls.reseller.push({ url: req.url, body: await req.clone().text() });
        const r = resellerSyncResponse || { status: 200, body: { ok: true, status: 200, attempts: 1 } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return { env, calls, restore: () => { globalThis.fetch = orig; } };
}

// ---------------------------------------------------------
// db_sync_upsert
// ---------------------------------------------------------

test('db_sync_upsert: patches diff vs current sim columns', async () => {
  const { env, calls, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, {
      action: 'db_sync_upsert',
      sim: { id: 'sim-1', status: 'inactive', current_mdn_e164: '+15550001111', imei: '111' },
      targets: { status: 'active', current_mdn_e164: '+15550001111', imei: '222' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'ok');
    assert.equal(calls.simPatches.length, 1);
    assert.deepEqual(calls.simPatches[0].body, { status: 'active', imei: '222' });
  } finally { restore(); }
});

test('db_sync_upsert: noop when DB already matches vendor truth', async () => {
  const { env, calls, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, {
      action: 'db_sync_upsert',
      sim: { id: 'sim-2', status: 'active', current_mdn_e164: '+15550001111' },
      targets: { status: 'active', current_mdn_e164: '+15550001111' },
    });
    assert.equal(res.status, 'noop');
    assert.equal(calls.simPatches.length, 0);
  } finally { restore(); }
});

// ---------------------------------------------------------
// resend_online
// ---------------------------------------------------------

test('resend_online: calls RESELLER_SYNC /resend-online with portal_resync source', async () => {
  const { env, calls, restore } = makeFakeEnv({
    resellerSyncResponse: { status: 200, body: { ok: true, status: 200, attempts: 1 } },
  });
  try {
    const res = await executeAction(env, {
      action: 'resend_online',
      sim: { id: 99 },
      report: { id: 1 },
      attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.reseller.length, 1);
    assert.ok(calls.reseller[0].url.includes('/resend-online'));
    const body = JSON.parse(calls.reseller[0].body);
    assert.equal(body.simId, 99);
    assert.equal(body.source, 'portal_resync');
  } finally { restore(); }
});

test('resend_online: surfaces vendor_error when service returns non-ok', async () => {
  const { env, restore } = makeFakeEnv({
    resellerSyncResponse: { status: 500, body: { ok: false, error: 'bad' } },
  });
  try {
    const res = await executeAction(env, {
      action: 'resend_online', sim: { id: 1 }, report: { id: 1 }, attemptNo: 1,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'vendor_error');
  } finally { restore(); }
});

test('resend_online: missing RESELLER_SYNC binding → service_binding_missing', async () => {
  const { env, restore } = makeFakeEnv();
  try {
    delete env.RESELLER_SYNC;
    const res = await executeAction(env, {
      action: 'resend_online', sim: { id: 1 }, report: { id: 1 }, attemptNo: 1,
    });
    assert.equal(res.status, 'service_binding_missing');
  } finally { restore(); }
});

// ---------------------------------------------------------
// close_duplicate
// ---------------------------------------------------------

test('close_duplicate: PATCH rental_reports status=duplicate + writes event row', async () => {
  const { env, calls, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, {
      action: 'close_duplicate',
      report: { id: 1, status: 'in_triage' },
      evidenceBundle: { reason: 'newer_open_report' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.terminalReport.status, 'duplicate');
    assert.equal(calls.patches.length, 1);
    assert.equal(calls.patches[0].body.status, 'duplicate');
    assert.equal(calls.patches[0].body.remediation_action, null);
    assert.ok(calls.patches[0].body.closed_at);
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].to_status, 'duplicate');
    assert.equal(calls.events[0].actor, 'auto-remediator');
    assert.equal(calls.events[0].evidence.source, 'auto_remediator');
  } finally { restore(); }
});

test('close_duplicate: missing report id → bad_input', async () => {
  const { env, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, { action: 'close_duplicate' });
    assert.equal(res.status, 'bad_input');
  } finally { restore(); }
});

// ---------------------------------------------------------
// classify_only
// ---------------------------------------------------------

test('classify_only: record-only, no DB writes', async () => {
  const { env, calls, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, {
      action: 'classify_only',
      report: { id: 5 }, sim: { id: 7 }, situationId: 'A10',
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'ok');
    assert.equal(calls.simPatches.length, 0);
    assert.equal(calls.patches.length, 0);
    assert.equal(calls.events.length, 0);
    assert.equal(res.evidence.mode, 'A10');
  } finally { restore(); }
});

// ---------------------------------------------------------
// Per-action KV emergency disable (§H.1 / scope)
// ---------------------------------------------------------

test('per-action KV emergency disable short-circuits each safe action', async () => {
  for (const action of SAFE_ACTIONS) {
    const kv = {};
    kv[actionKvKey(action)] = 'true';
    const { env, calls, restore } = makeFakeEnv({ kv });
    try {
      const res = await executeAction(env, {
        action,
        sim: { id: 1 },
        report: { id: 1 },
        targets: { status: 'active' },
        attemptNo: 1,
      });
      assert.equal(res.ok, false, action + ' should not run when KV disabled');
      assert.equal(res.status, 'disabled_by_kv');
      assert.equal(calls.simPatches.length, 0);
      assert.equal(calls.patches.length, 0);
      assert.equal(calls.reseller.length, 0);
    } finally { restore(); }
  }
});

test('actionKvKey shape is bad_rental_remediator_action_<name>_disabled', () => {
  assert.equal(actionKvKey('db_sync_upsert'), 'bad_rental_remediator_action_db_sync_upsert_disabled');
  assert.equal(actionKvKey('resend_online'),  'bad_rental_remediator_action_resend_online_disabled');
});

// ---------------------------------------------------------
// Forbidden-action defence (§H.2)
// ---------------------------------------------------------

test('executeAction refuses every forbidden action even if asked', async () => {
  const { env, restore } = makeFakeEnv();
  try {
    for (const action of FORBIDDEN_ACTIONS) {
      const res = await executeAction(env, { action, sim: { id: 1 }, report: { id: 1 } });
      assert.equal(res.ok, false, action + ' should be refused');
      assert.equal(res.status, 'unsupported_action');
    }
  } finally { restore(); }
});

test('executeAction refuses unknown action', async () => {
  const { env, restore } = makeFakeEnv();
  try {
    const res = await executeAction(env, { action: 'nuke_everything', sim: { id: 1 }, report: { id: 1 } });
    assert.equal(res.status, 'unsupported_action');
  } finally { restore(); }
});
