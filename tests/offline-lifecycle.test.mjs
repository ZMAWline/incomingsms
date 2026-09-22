// Offline SIM lifecycle (branch `unassign-offline-sims-from-reseller`):
// pure-predicate cases for src/shared/offline-lifecycle.mjs, execution-order
// proofs for the executor, and wiring proofs that the migration, the cron and
// the service bindings actually exist.
//
// The two orderings asserted here are load-bearing and easy to break by
// "tidying" the planners: the number.offline webhook must go out BEFORE
// reseller_sims.active flips to false, and the assignment must be restored
// BEFORE any recovery webhook or rotation. Every webhook sender in this repo
// resolves the reseller through reseller_sims.active=true, so getting either
// backwards silently drops the reseller notification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shouldConfirmOffline, shouldConfirmOnline, insideRotationWindow,
  isLifecycleEligible, planOfflineActions, planRecoveryActions, offlineEpisodeStart,
  OFFLINE_PAUSE_REASON, OFFLINE_WEBHOOK_REASON, CHECK_MAX_AGE_MS, CHECK_HISTORY_WINDOW_MS,
} from '../src/shared/offline-lifecycle.mjs';
import {
  runOfflineLifecycleTick, runOfflineProbeRun, probeLimitFor,
  MAX_PROBES_PER_RUN, PROBE_RUNS_PER_CYCLE,
} from '../src/bad-rental-remediator/offline-lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MIGRATION = read('supabase', 'migrations', '20260922_sim_offline_lifecycle.sql');
const REMEDIATOR_SRC = read('src', 'bad-rental-remediator', 'index.js');
const REMEDIATOR_TOML = read('src', 'bad-rental-remediator', 'wrangler.toml');
const EXECUTOR_SRC = read('src', 'bad-rental-remediator', 'offline-lifecycle.mjs');
const RESELLER_SYNC_SRC = read('src', 'reseller-sync', 'index.js');

const NOW = new Date('2026-09-22T20:00:00Z'); // 16:00 America/New_York
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const check = (state, msAgo) => ({ state, checked_at: iso(msAgo) });

// --- confirmation predicates ----------------------------------------------

test('shouldConfirmOffline needs two consecutive fresh offline checks', () => {
  assert.equal(shouldConfirmOffline([check('offline', 0), check('offline', 3600_000)], NOW), true);
  // One blip is not an outage.
  assert.equal(shouldConfirmOffline([check('offline', 0), check('online', 3600_000)], NOW), false);
  assert.equal(shouldConfirmOffline([check('offline', 0)], NOW), false);
  assert.equal(shouldConfirmOffline([], NOW), false);
});

test('shouldConfirmOffline never treats a read failure as offline', () => {
  // normalizeHostPortState records HTTP errors and wrong-MDN rejections as
  // 'error', so a Teltik outage must not unassign the fleet.
  assert.equal(shouldConfirmOffline([check('error', 0), check('error', 3600_000)], NOW), false);
  assert.equal(shouldConfirmOffline([check('offline', 0), check('error', 3600_000)], NOW), false);
  assert.equal(shouldConfirmOffline([check('unknown', 0), check('offline', 3600_000)], NOW), false);
});

test('confirmation ignores stale history', () => {
  const stale = CHECK_MAX_AGE_MS + 60_000;
  assert.equal(shouldConfirmOffline([check('offline', stale), check('offline', stale + 1000)], NOW), false);
  assert.equal(shouldConfirmOnline([check('online', stale)], NOW), false);
});

test('only the newest check must be fresh; the prior one may be older', () => {
  // The prober visits each candidate about every 5h, so the check before the
  // newest one usually comes from the previous cycle.
  const older = CHECK_MAX_AGE_MS + 3600_000;
  assert.equal(shouldConfirmOffline([check('offline', 0), check('offline', older)], NOW), true);
  assert.equal(shouldConfirmOffline([check('offline', CHECK_MAX_AGE_MS + 1000), check('offline', older)], NOW), false);
  // The history window reaches back past the freshness rule, so the older
  // check is actually returned by the executor's read.
  assert.ok(CHECK_HISTORY_WINDOW_MS > CHECK_MAX_AGE_MS + 5 * 3600_000);
});

test('offlineEpisodeStart is the oldest check of the current offline run', () => {
  const first = [check('offline', 0), check('offline', 3600_000), check('online', 7200_000)];
  assert.equal(offlineEpisodeStart(first), iso(3600_000));
  // A second outage later the same day starts at a different check, so its
  // number.offline dedup id differs from the first outage's.
  const second = [check('offline', 0), check('offline', 1800_000), check('online', 2700_000),
    check('offline', 3600_000)];
  assert.equal(offlineEpisodeStart(second), iso(1800_000));
  assert.notEqual(offlineEpisodeStart(first), offlineEpisodeStart(second));
  assert.equal(offlineEpisodeStart([check('online', 0)]), null);
});

test('shouldConfirmOffline sorts by checked_at, not array order', () => {
  const unordered = [check('offline', 3600_000), check('offline', 0)];
  assert.equal(shouldConfirmOffline(unordered, NOW), true);
  // Newest is online even though it is listed second.
  assert.equal(shouldConfirmOffline([check('offline', 3600_000), check('online', 0)], NOW), false);
});

test('shouldConfirmOnline takes the newest check only', () => {
  assert.equal(shouldConfirmOnline([check('online', 0), check('offline', 3600_000)], NOW), true);
  assert.equal(shouldConfirmOnline([check('offline', 0), check('online', 3600_000)], NOW), false);
  assert.equal(shouldConfirmOnline([], NOW), false);
});

// --- rotation window ------------------------------------------------------

test('insideRotationWindow: teltik uses last_mdn_rotated_at + interval', () => {
  const teltik = (msAgo, hours) => ({
    vendor: 'teltik', rotation_interval_hours: hours, last_mdn_rotated_at: iso(msAgo),
  });
  assert.equal(insideRotationWindow(teltik(47 * 3600_000, 48), NOW), true);
  assert.equal(insideRotationWindow(teltik(49 * 3600_000, 48), NOW), false);
  // Missing interval falls back to 48h, the rotateTeltikSims default.
  assert.equal(insideRotationWindow({ vendor: 'teltik', last_mdn_rotated_at: iso(47 * 3600_000) }, NOW), true);
  // Never rotated: no number commitment to honour, so a fresh one is allowed.
  assert.equal(insideRotationWindow({ vendor: 'teltik', last_mdn_rotated_at: null }, NOW), false);
});

test('insideRotationWindow: atomic/helix use the America/New_York calendar day', () => {
  // 2026-09-22T05:00:00Z is 01:00 EDT on 09-22, the same NY day as NOW.
  assert.equal(insideRotationWindow({ vendor: 'atomic', last_mdn_rotated_at: '2026-09-22T05:00:00Z' }, NOW), true);
  assert.equal(insideRotationWindow({ vendor: 'helix', last_mdn_rotated_at: '2026-09-22T05:00:00Z' }, NOW), true);
  // 2026-09-22T03:30:00Z is 23:30 EDT on 09-21: the SAME UTC day, a DIFFERENT
  // NY day. A UTC-day comparison would wrongly report "inside the window" here
  // and suppress the fresh number the reseller is owed.
  assert.equal(insideRotationWindow({ vendor: 'atomic', last_mdn_rotated_at: '2026-09-22T03:30:00Z' }, NOW), false);
  // And the mirror case: a rotation almost 23 hours earlier that is STILL the
  // same NY day, which a naive "rotated in the last 24h" test would also get
  // right but a UTC-day test would not (the two are different UTC days).
  assert.equal(insideRotationWindow({ vendor: 'atomic', last_mdn_rotated_at: '2026-09-22T04:10:00Z' },
    new Date('2026-09-23T03:00:00Z')), true);
});

// --- eligibility ----------------------------------------------------------

test('isLifecycleEligible skips port_in_pending and non-active SIMs', () => {
  assert.equal(isLifecycleEligible({ status: 'active', port_in_pending: false }), true);
  assert.equal(isLifecycleEligible({ status: 'active', port_in_pending: null }), true);
  assert.equal(isLifecycleEligible({ status: 'active', port_in_pending: true }), false);
  assert.equal(isLifecycleEligible({ status: 'provisioning', port_in_pending: false }), false);
  assert.equal(isLifecycleEligible(null), false);
});

// --- offline plan ---------------------------------------------------------

const assigned = { reseller_id: 7, active: true };
const closedByUs = { reseller_id: 7, active: false, deactivated_reason: OFFLINE_PAUSE_REASON };

test('planOfflineActions sends the offline webhook BEFORE the unassign', () => {
  const sim = { id: 1, vendor: 'teltik', rotation_eligible: true };
  const types = planOfflineActions(sim, assigned).map((a) => a.type);
  assert.deepEqual(types, ['pause_rotation', 'send_offline_webhook', 'unassign_reseller', 'latch_offline']);
  const plan = planOfflineActions(sim, assigned, iso(3600_000));
  const webhook = plan.find((a) => a.type === 'send_offline_webhook');
  assert.equal(webhook.reason, OFFLINE_WEBHOOK_REASON);
  assert.equal(webhook.offline_since, iso(3600_000));
  assert.equal(plan.find((a) => a.type === 'latch_offline').offline_since, iso(3600_000));
});

test('planOfflineActions on a never-assigned SIM only pauses and latches', () => {
  const sim = { id: 1, vendor: 'teltik', rotation_eligible: true };
  assert.deepEqual(planOfflineActions(sim, null).map((a) => a.type), ['pause_rotation', 'latch_offline']);
});

test('planOfflineActions does not re-pause rotation an operator already paused', () => {
  const sim = { id: 1, vendor: 'teltik', rotation_eligible: false };
  assert.deepEqual(planOfflineActions(sim, assigned).map((a) => a.type),
    ['send_offline_webhook', 'unassign_reseller', 'latch_offline']);
});

// --- recovery plan --------------------------------------------------------

test('planRecoveryActions restores the assignment before any number event', () => {
  const sim = {
    id: 1, vendor: 'teltik', rotation_interval_hours: 48,
    rotation_pause_reason: OFFLINE_PAUSE_REASON, last_mdn_rotated_at: iso(10 * 3600_000),
  };
  const types = planRecoveryActions(sim, closedByUs, NOW).map((a) => a.type);
  assert.deepEqual(types, ['restore_assignment', 'resume_rotation', 'resend_online', 'latch_online']);
  assert.ok(types.indexOf('restore_assignment') < types.indexOf('resend_online'));
});

test('a teltik SIM inside its 48h window is re-sent online, never rotated', () => {
  const sim = {
    id: 1, vendor: 'teltik', rotation_interval_hours: 48,
    rotation_pause_reason: OFFLINE_PAUSE_REASON, last_mdn_rotated_at: iso(47 * 3600_000),
  };
  const types = planRecoveryActions(sim, closedByUs, NOW).map((a) => a.type);
  assert.ok(types.includes('resend_online'));
  assert.ok(!types.includes('force_rotate'));
});

test('a new window force-rotates through the vendor-correct worker', () => {
  const teltik = {
    id: 1, vendor: 'teltik', rotation_interval_hours: 48,
    rotation_pause_reason: OFFLINE_PAUSE_REASON, last_mdn_rotated_at: iso(49 * 3600_000),
  };
  const teltikRotate = planRecoveryActions(teltik, closedByUs, NOW).find((a) => a.type === 'force_rotate');
  assert.equal(teltikRotate.target, 'teltik_worker');

  const atomic = {
    id: 2, vendor: 'atomic',
    rotation_pause_reason: OFFLINE_PAUSE_REASON, last_mdn_rotated_at: '2026-09-21T20:00:00Z',
  };
  const atomicRotate = planRecoveryActions(atomic, closedByUs, NOW).find((a) => a.type === 'force_rotate');
  assert.equal(atomicRotate.target, 'mdn_rotator');
});

test('recovery leaves an operator-paused rotation alone', () => {
  const sim = {
    id: 1, vendor: 'teltik', rotation_interval_hours: 48,
    rotation_pause_reason: null, last_mdn_rotated_at: iso(10 * 3600_000),
  };
  const types = planRecoveryActions(sim, closedByUs, NOW).map((a) => a.type);
  assert.ok(!types.includes('resume_rotation'));
  assert.deepEqual(types, ['restore_assignment', 'resend_online', 'latch_online']);
});

test('recovery never force-rotates a line an operator paused, even in a new window', () => {
  // rotation_pause_reason NULL on a latched line: the operator had already
  // paused rotation before the outage, so pause_rotation never ran.
  const sim = {
    id: 1, vendor: 'teltik', rotation_interval_hours: 48, rotation_eligible: false,
    rotation_pause_reason: null, last_mdn_rotated_at: iso(60 * 3600_000),
  };
  assert.deepEqual(planRecoveryActions(sim, closedByUs, NOW).map((a) => a.type),
    ['restore_assignment', 'resend_online', 'latch_online']);
  const atomic = { id: 2, vendor: 'atomic', rotation_pause_reason: null, last_mdn_rotated_at: '2026-09-20T20:00:00Z' };
  assert.deepEqual(planRecoveryActions(atomic, closedByUs, NOW).map((a) => a.type),
    ['restore_assignment', 'resend_online', 'latch_online']);
});

test('recovery of a never-assigned SIM only clears the latch', () => {
  const sim = { id: 1, vendor: 'teltik', rotation_pause_reason: null, last_mdn_rotated_at: iso(10 * 3600_000) };
  assert.deepEqual(planRecoveryActions(sim, null, NOW).map((a) => a.type), ['latch_online']);
});

test('recovery ignores an assignment an operator closed for another reason', () => {
  const sim = { id: 1, vendor: 'teltik', rotation_pause_reason: null, last_mdn_rotated_at: iso(10 * 3600_000) };
  const operatorClosed = { reseller_id: 7, active: false, deactivated_reason: 'returned_by_reseller' };
  assert.deepEqual(planRecoveryActions(sim, operatorClosed, NOW).map((a) => a.type), ['latch_online']);
});

// --- executor harness -----------------------------------------------------

function makeHarness({ sims, checks, dryRun = false, enabled = true, resellerSync = null }) {
  const calls = [];
  const syncRequests = [];
  const patches = [];
  const rpcCalls = [];
  const kv = new Map();
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    ADMIN_RUN_SECRET: 'sek',
    FINALIZER_RUN_SECRET: 'fin',
    OFFLINE_LIFECYCLE_ENABLED: enabled ? 'true' : undefined,
    OFFLINE_LIFECYCLE_DRY_RUN: dryRun ? 'true' : undefined,
    REMEDIATOR_KV: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
    },
    RESELLER_SYNC: {
      fetch: async (req) => {
        const u = new URL(req.url);
        calls.push('RESELLER_SYNC ' + u.pathname);
        syncRequests.push({ path: u.pathname, secret: u.searchParams.get('secret'), body: await req.json() });
        if (resellerSync) return resellerSync(u.pathname);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    TELTIK_WORKER: {
      fetch: async (url) => {
        calls.push('TELTIK_WORKER ' + new URL(url).pathname);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    MDN_ROTATOR: {
      fetch: async (url) => {
        calls.push('MDN_ROTATOR ' + new URL(url).pathname);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  };

  const fakeFetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const table = (u.match(/\/rest\/v1\/([a-z_]+)/) || [])[1] || u;
    calls.push(method + ' ' + table);
    if (method === 'GET' && table === 'sims') {
      // The latched query carries offline_state=eq.offline; the assigned query
      // must use an inner embed so unassigned SIMs are dropped, not returned
      // with an empty reseller_sims list.
      const latched = u.includes('offline_state=eq.offline');
      const matched = !latched && !u.includes('reseller_sims!inner') ? sims
        : sims.filter((s) => (latched ? s.offline_state === 'offline'
          : (s.reseller_sims || []).some((r) => r.active === true)));
      // Mirror PostgREST paging, including the 1000-row max-rows clamp.
      const params = new URL(u).searchParams;
      const offset = Number(params.get('offset') || 0);
      const limit = Math.min(Number(params.get('limit') || Infinity), 1000);
      const rows = [...matched].sort((a, b) => a.id - b.id).slice(offset, offset + limit);
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (method === 'POST' && u.includes('/rest/v1/rpc/get_recent_hosting_port_checks')) {
      // Mirror the SQL: newest p_per_sim checks per SIM since p_since, one row
      // per SIM.
      const args = JSON.parse(init.body);
      rpcCalls.push(args);
      const out = [];
      for (const id of args.p_sim_ids) {
        const list = checks.filter((c) => c.sim_id === id && c.checked_at >= args.p_since)
          .sort((a, b) => b.checked_at.localeCompare(a.checked_at))
          .slice(0, args.p_per_sim)
          .map(({ state, checked_at }) => ({ state, checked_at }));
        if (list.length) out.push({ sim_id: id, checks: list });
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (method === 'PATCH') patches.push({ table, url: u, body: JSON.parse(init.body) });
    return new Response('[]', { status: 200 });
  };

  return { env, calls, syncRequests, patches, rpcCalls, fakeFetch };
}

async function withFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const OFFLINE_SIM = {
  id: 11, iccid: '8901', vendor: 'teltik', gateway_host: 'teltik', status: 'active',
  port_in_pending: false, offline_state: 'online', rotation_eligible: true,
  rotation_pause_reason: null, rotation_interval_hours: 48,
  last_mdn_rotated_at: '2026-09-22T10:00:00Z',
  sim_numbers: [{ e164: '+19175550101' }],
  reseller_sims: [{ reseller_id: 7, active: true, deactivated_reason: null }],
};

test('the tick is a no-op when OFFLINE_LIFECYCLE_ENABLED is unset', async () => {
  const h = makeHarness({
    sims: [OFFLINE_SIM],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
    enabled: false,
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.skipped, 'disabled');
  assert.deepEqual(h.calls, []);
});

test('dry run plans the offline transition but writes nothing', async () => {
  const h = makeHarness({
    sims: [OFFLINE_SIM],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
    dryRun: true,
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.dry_run, true);
  assert.equal(summary.offline, 1);
  assert.deepEqual(summary.plans[0].actions,
    ['pause_rotation', 'send_offline_webhook', 'unassign_reseller', 'latch_offline']);
  // Reads only: the two candidate GETs and the history RPC.
  assert.ok(h.calls.every((c) => c.startsWith('GET ') || c === 'POST rpc'), 'dry run made a write: ' + h.calls.join(', '));
  assert.equal(h.patches.length, 0);
  assert.ok(!h.calls.some((c) => /RESELLER_SYNC|TELTIK_WORKER|MDN_ROTATOR/.test(c)));
});

test('dry run still probes, so the digest reflects real readings', async () => {
  const h = makeHarness({ sims: [OFFLINE_SIM], checks: [], dryRun: true });
  const summary = await withFetch(h.fakeFetch, () => runOfflineProbeRun(h.env, { now: NOW }));
  assert.equal(summary.probed, 1);
  assert.ok(h.calls.includes('POST hosting_port_status_checks'), 'the probe must record a check row');
  assert.equal(h.patches.length, 0, 'a probe never writes sims or reseller_sims');
  assert.ok(!h.calls.some((c) => /RESELLER_SYNC|TELTIK_WORKER|MDN_ROTATOR/.test(c)));
});

test('the probe run is a no-op when OFFLINE_LIFECYCLE_ENABLED is unset', async () => {
  const h = makeHarness({ sims: [OFFLINE_SIM], checks: [], enabled: false });
  const summary = await withFetch(h.fakeFetch, () => runOfflineProbeRun(h.env, { now: NOW }));
  assert.equal(summary.skipped, 'disabled');
  assert.deepEqual(h.calls, []);
});

test('the probe run visits the stalest candidates first', async () => {
  const sims = [1, 2, 3, 4].map((id) => ({ ...OFFLINE_SIM, id, iccid: '890' + id }));
  const checks = [
    { sim_id: 1, ...check('online', 60_000) },
    { sim_id: 2, ...check('online', 4 * 3600_000) },
    // sim 3 has never been checked.
    { sim_id: 4, ...check('online', 2 * 3600_000) },
  ];
  const h = makeHarness({ sims, checks });
  const probedIds = [];
  const fetchSpy = async (url, init) => {
    if (String(url).includes('/hosting_port_status_checks') && init && init.method === 'POST') {
      probedIds.push(JSON.parse(init.body).sim_id);
    }
    return h.fakeFetch(url, init);
  };
  // 4 candidates -> ceil(4 / 100) = 1 probe per run.
  const summary = await withFetch(fetchSpy, () => runOfflineProbeRun(h.env, { now: NOW }));
  assert.equal(summary.probe_limit, 1);
  assert.deepEqual(probedIds, [3]);
});

test('every candidate is probed within 6h without passing ~500 subrequests', () => {
  // Probe cron: 20 runs an hour. PROBE_RUNS_PER_CYCLE runs must fit in 6h.
  assert.ok(PROBE_RUNS_PER_CYCLE / 20 < CHECK_MAX_AGE_MS / 3600_000);
  for (const n of [1, 100, 750, 1000, 4285, 5000]) {
    const limit = probeLimitFor(n);
    assert.ok(Math.ceil(n / limit) <= PROBE_RUNS_PER_CYCLE, 'n=' + n + ' needs more than one cycle');
  }
  assert.equal(probeLimitFor(4285), 43);
  assert.equal(probeLimitFor(10000), MAX_PROBES_PER_RUN);
  // Worst case per probe run at 5000 candidates: 9 subrequests per probe
  // (wrong-MDN retry path), 5 + 1 candidate pages, and 5000 / 500 history reads.
  assert.ok(MAX_PROBES_PER_RUN * 9 + 6 + 10 < 500);
});

test('candidate queries page past the 1000-row PostgREST clamp', async () => {
  const sims = Array.from({ length: 2500 }, (_, i) => ({ ...OFFLINE_SIM, id: 629 + i, iccid: 'i' + i }));
  const h = makeHarness({ sims, checks: [] });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.candidates, 2500);
  // Assigned query: pages of 1000, 1000, 500. Latched query: one empty page.
  assert.equal(h.calls.filter((c) => c === 'GET sims').length, 4);
});

test('the probe run reaches stale SIMs beyond the first page', async () => {
  // 2500 candidates; every SIM on the first page was checked recently, so the
  // stalest ones only exist on later pages.
  const sims = Array.from({ length: 2500 }, (_, i) => ({ ...OFFLINE_SIM, id: 1 + i, iccid: 'i' + i }));
  const checks = sims.map((s) => ({
    sim_id: s.id, ...check('online', s.id <= 1000 ? 60_000 : 4 * 3600_000 - s.id * 1000),
  }));
  const h = makeHarness({ sims, checks });
  const probedIds = [];
  const fetchSpy = async (url, init) => {
    if (String(url).includes('/hosting_port_status_checks') && init && init.method === 'POST') {
      probedIds.push(JSON.parse(init.body).sim_id);
    }
    return h.fakeFetch(url, init);
  };
  // 2500 candidates -> ceil(2500 / 100) = 25 probes, least recently checked first.
  const summary = await withFetch(fetchSpy, () => runOfflineProbeRun(h.env, { now: NOW }));
  assert.equal(summary.candidates, 2500);
  assert.equal(summary.probe_limit, 25);
  assert.deepEqual([...probedIds].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => 1001 + i));
});

test('the history read goes through the per-SIM capped RPC in batches', async () => {
  const sims = Array.from({ length: 600 }, (_, i) => ({ ...OFFLINE_SIM, id: 1000 + i }));
  const h = makeHarness({ sims, checks: [] });
  await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(h.rpcCalls.length, 2, '600 SIMs must be read in two batches of at most 500');
  assert.ok(h.rpcCalls.every((a) => a.p_sim_ids.length <= 500 && a.p_per_sim === 6));
  assert.equal(h.rpcCalls[0].p_since, new Date(NOW.getTime() - CHECK_HISTORY_WINDOW_MS).toISOString());
  assert.ok(!h.calls.includes('GET hosting_port_status_checks'), 'no unbounded history read');
});

test('unassigned SIMs are not candidates', async () => {
  const unassigned = { ...OFFLINE_SIM, id: 12, reseller_sims: [] };
  const h = makeHarness({ sims: [OFFLINE_SIM, unassigned], checks: [] });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.candidates, 1);
});

test('a live offline transition notifies the reseller before unassigning', async () => {
  const h = makeHarness({
    sims: [OFFLINE_SIM],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.offline, 1);
  assert.deepEqual(summary.plans[0].results.map((r) => r.type),
    ['pause_rotation', 'send_offline_webhook', 'unassign_reseller', 'latch_offline']);
  assert.ok(summary.plans[0].results.every((r) => r.ok));
  const sendOffline = h.calls.indexOf('RESELLER_SYNC /send-offline');
  const unassign = h.calls.indexOf('PATCH reseller_sims');
  assert.ok(sendOffline >= 0 && unassign >= 0);
  assert.ok(sendOffline < unassign, 'number.offline must precede the unassign');
  // The shared secret rides on every reseller-sync call, and the outage start
  // (the oldest offline check) keys the dedup id and becomes offline_since.
  const req = h.syncRequests.find((r) => r.path === '/send-offline');
  assert.equal(req.secret, 'fin');
  assert.equal(req.body.offlineSince, iso(3600_000));
  const latch = h.patches.find((p) => p.table === 'sims' && p.body.offline_state === 'offline');
  assert.equal(latch.body.offline_since, iso(3600_000));
  assert.equal(latch.body.offline_notified_at, NOW.toISOString());
});

test('a reseller with no webhook is still unassigned and latched, without retries', async () => {
  const h = makeHarness({
    sims: [OFFLINE_SIM],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
    resellerSync: () => new Response(JSON.stringify({ ok: false, status: 412 }), { status: 412 }),
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  const results = summary.plans[0].results;
  assert.deepEqual(results.map((r) => r.type),
    ['pause_rotation', 'send_offline_webhook', 'unassign_reseller', 'latch_offline']);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results[1].skipped, true);
  assert.ok(h.patches.some((p) => p.table === 'reseller_sims' && p.body.active === false));
  const latch = h.patches.find((p) => p.table === 'sims' && p.body.offline_state === 'offline');
  assert.ok(latch, 'the latch must be set so the next tick does not retry');
  assert.equal(latch.body.offline_notified_at, null, 'nobody was notified');
});

test('a non-412 /send-offline failure still stops the plan before the unassign', async () => {
  const h = makeHarness({
    sims: [OFFLINE_SIM],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
    resellerSync: () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.deepEqual(summary.plans[0].results.map((r) => r.type), ['pause_rotation', 'send_offline_webhook']);
  assert.ok(!h.patches.some((p) => p.table === 'reseller_sims'));
});

test('recovery of an operator-paused line re-sends online and never rotates or resumes', async () => {
  const sim = {
    ...OFFLINE_SIM, offline_state: 'offline', rotation_eligible: false,
    rotation_pause_reason: null,
    last_mdn_rotated_at: iso(60 * 3600_000),
    reseller_sims: [{ reseller_id: 7, active: false, deactivated_reason: OFFLINE_PAUSE_REASON }],
  };
  const h = makeHarness({ sims: [sim], checks: [{ sim_id: 11, ...check('online', 0) }] });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.recovered, 1);
  assert.ok(h.calls.includes('RESELLER_SYNC /resend-online'));
  assert.ok(!h.calls.some((c) => c.includes('/rotate-sim')));
  assert.ok(!h.patches.some((p) => p.body.rotation_eligible === true), 'rotation must stay paused');
});

test('recovery inside the teltik window re-sends online and never calls /rotate-sim', async () => {
  const sim = {
    ...OFFLINE_SIM, offline_state: 'offline', rotation_eligible: false,
    rotation_pause_reason: OFFLINE_PAUSE_REASON,
    last_mdn_rotated_at: iso(10 * 3600_000),
    reseller_sims: [{ reseller_id: 7, active: false, deactivated_reason: OFFLINE_PAUSE_REASON }],
  };
  const h = makeHarness({ sims: [sim], checks: [{ sim_id: 11, ...check('online', 0) }] });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.recovered, 1);
  assert.ok(h.calls.includes('RESELLER_SYNC /resend-online'));
  assert.ok(!h.calls.some((c) => c.includes('/rotate-sim')), 'inside the window nothing may rotate');
  const restore = h.calls.indexOf('PATCH reseller_sims');
  const resend = h.calls.indexOf('RESELLER_SYNC /resend-online');
  assert.ok(restore >= 0 && restore < resend, 'the assignment must be restored first');
});

test('recovery in a new window force-rotates after restoring the assignment', async () => {
  const sim = {
    ...OFFLINE_SIM, offline_state: 'offline', rotation_eligible: false,
    rotation_pause_reason: OFFLINE_PAUSE_REASON,
    last_mdn_rotated_at: iso(60 * 3600_000),
    reseller_sims: [{ reseller_id: 7, active: false, deactivated_reason: OFFLINE_PAUSE_REASON }],
  };
  const h = makeHarness({ sims: [sim], checks: [{ sim_id: 11, ...check('online', 0) }] });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.recovered, 1);
  const restore = h.calls.indexOf('PATCH reseller_sims');
  const rotate = h.calls.indexOf('TELTIK_WORKER /rotate-sim');
  assert.ok(restore >= 0 && rotate >= 0 && restore < rotate);
  assert.ok(!h.calls.includes('RESELLER_SYNC /resend-online'), 'rotation fires its own online event');
});

test('a port_in_pending SIM is never a lifecycle candidate', async () => {
  const h = makeHarness({
    sims: [{ ...OFFLINE_SIM, port_in_pending: true }],
    checks: [{ sim_id: 11, ...check('offline', 0) }, { sim_id: 11, ...check('offline', 3600_000) }],
  });
  const summary = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(summary.candidates, 0);
  assert.equal(summary.offline, 0);
});

test('the recovery cooldown stops a flapping line looping', async () => {
  const sim = {
    ...OFFLINE_SIM, offline_state: 'offline', rotation_eligible: false,
    rotation_pause_reason: OFFLINE_PAUSE_REASON,
    last_mdn_rotated_at: iso(10 * 3600_000),
    reseller_sims: [{ reseller_id: 7, active: false, deactivated_reason: OFFLINE_PAUSE_REASON }],
  };
  const h = makeHarness({ sims: [sim], checks: [{ sim_id: 11, ...check('online', 0) }] });
  await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  const second = await withFetch(h.fakeFetch, () => runOfflineLifecycleTick(h.env, { now: NOW }));
  assert.equal(second.recovered, 0);
  assert.equal(second.cooling_down, 1);
});

// --- wiring proofs --------------------------------------------------------

test('the migration adds every column and RPC the executor reads', () => {
  for (const needle of [
    'offline_state', 'offline_since', 'offline_notified_at', 'rotation_pause_reason',
    'deactivated_reason', 'deactivated_at', 'get_recent_hosting_port_checks',
  ]) {
    assert.ok(MIGRATION.includes(needle), 'migration is missing ' + needle);
  }
  assert.ok(/CHECK \(offline_state IN \('online', 'offline'\)\)/.test(MIGRATION));
  // Unused RPCs are not shipped.
  assert.ok(!MIGRATION.includes('get_teltik_recovered_lines'));
});

test('get_recent_hosting_port_checks caps the history per SIM in SQL', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION get_recent_hosting_port_checks'));
  assert.ok(fn.includes('row_number() OVER (PARTITION BY c.sim_id ORDER BY c.checked_at DESC)'));
  assert.ok(fn.includes('ranked.rn <= p_per_sim'));
  assert.ok(fn.includes('c.checked_at >= p_since'));
  assert.ok(fn.includes('c.sim_id = ANY (p_sim_ids)'));
  // One row per SIM keeps a 500-SIM batch under the 1000-row PostgREST limit.
  assert.ok(fn.includes('GROUP BY ranked.sim_id'));
  assert.ok(EXECUTOR_SRC.includes("'get_recent_hosting_port_checks'"));
});

test('the hourly cron, the probe cron and both rotate bindings are declared', () => {
  assert.ok(REMEDIATOR_TOML.includes('"0 * * * *"'), 'hourly cron missing from wrangler.toml');
  assert.ok(REMEDIATOR_TOML.includes('"2-59/3 * * * *"'), 'probe cron missing from wrangler.toml');
  for (const block of ['binding = "TELTIK_WORKER"', 'binding = "MDN_ROTATOR"']) {
    assert.ok(REMEDIATOR_TOML.includes(block), 'missing ' + block);
  }
  assert.ok(REMEDIATOR_TOML.includes('service = "teltik-worker-test"'));
  assert.ok(REMEDIATOR_TOML.includes('service = "mdn-rotator-test"'));
  assert.ok(REMEDIATOR_TOML.includes('OFFLINE_LIFECYCLE_ENABLED'));
});

test('scheduled() routes the hourly cron to the lifecycle, not the intake tick', () => {
  assert.ok(REMEDIATOR_SRC.includes("const OFFLINE_LIFECYCLE_CRON = '0 * * * *'"));
  assert.ok(REMEDIATOR_SRC.includes('if (cron === OFFLINE_LIFECYCLE_CRON)'));
  assert.ok(REMEDIATOR_SRC.includes('runOfflineLifecycleTick(env)'));
  assert.ok(REMEDIATOR_SRC.includes("const OFFLINE_PROBE_CRON = '2-59/3 * * * *'"));
  assert.ok(REMEDIATOR_SRC.includes('if (cron === OFFLINE_PROBE_CRON)'));
  assert.ok(REMEDIATOR_SRC.includes('runOfflineProbeRun(env)'));
});

test('the executor reuses the existing senders and rotate routes', () => {
  assert.ok(EXECUTOR_SRC.includes("'/send-offline'"));
  assert.ok(EXECUTOR_SRC.includes("'/resend-online'"));
  assert.ok(EXECUTOR_SRC.includes('/rotate-sim?secret='));
  assert.ok(EXECUTOR_SRC.includes('checkAndRecordTeltikHostPort'));
  // force_rotate is the ONLY path that may reach a rotate route.
  const rotateCalls = EXECUTOR_SRC.split('\n').filter((l) => l.includes('await forceRotate(env'));
  assert.equal(rotateCalls.length, 1);
});

test('reseller-sync /send-offline requires the shared secret, not the header', () => {
  const start = RESELLER_SYNC_SRC.indexOf('url.pathname === "/send-offline"');
  const route = RESELLER_SYNC_SRC.slice(start, RESELLER_SYNC_SRC.indexOf('\n    }\n', start));
  assert.ok(route.includes('if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET)'));
  assert.ok(!route.includes('internalOk'), 'the spoofable X-Internal-Caller header must not be enough');
  assert.ok(EXECUTOR_SRC.includes("'?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET"));
});

test('the number.offline dedup id includes the outage start', () => {
  const fn = RESELLER_SYNC_SRC.slice(RESELLER_SYNC_SRC.indexOf('async function sendOfflineForSim'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes("from: reason + ':' + offlineSince"));
  assert.ok(RESELLER_SYNC_SRC.includes('offlineSince (ISO timestamp) required'));
});

test('reseller-sync /send-offline carries reason=line_offline and no replaced_by', () => {
  assert.ok(RESELLER_SYNC_SRC.includes('url.pathname === "/send-offline"'));
  assert.ok(RESELLER_SYNC_SRC.includes("reason !== 'line_offline'"));
  const fn = RESELLER_SYNC_SRC.slice(RESELLER_SYNC_SRC.indexOf('async function sendOfflineForSim'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes('reseller_sims.active=eq.true'), 'must resolve through the active assignment');
  assert.ok(!body.includes('replaced_by'), 'a host-offline event replaces nothing');
});
