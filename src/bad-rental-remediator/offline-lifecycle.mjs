// =========================================================
// Offline SIM lifecycle executor (hourly cron branch).
//
// Decisions live in src/shared/offline-lifecycle.mjs (pure, unit-tested). This
// file is the IO half: probe, read history, execute, record. It owns no policy
// beyond ordering and budgets.
//
// One tick:
//   1. Gate on OFFLINE_LIFECYCLE_ENABLED. Off (the default) means log and
//      return, no query, no write, no carrier call.
//   2. Collect candidates: SIMs on an active reseller assignment, plus SIMs
//      already latched offline_state='offline'. Teltik-hosted and status=active
//      only; port_in_pending lines are dropped.
//   3. Probe a bounded slice of them through checkAndRecordTeltikHostPort, the
//      same recorder every other port-status caller uses. A KV cursor advances
//      each tick so the whole candidate set is covered over several hours
//      instead of blowing the per-invocation subrequest budget in one go.
//   4. Read the recent check history for every candidate and run the pure
//      planners. Execute at most OFFLINE_LIFECYCLE_MAX_ACTIONS transitions.
//
// OFFLINE_LIFECYCLE_DRY_RUN short-circuits steps 3 and 4's writes: no probe (a
// probe is a carrier call and a DB insert), no webhook, no rotation, no PATCH.
// The planned actions go to the existing Slack digest instead, which is the
// artifact to review before enabling writes in PROD.
//
// Reuse, not reimplementation, is the rule here:
//   number.offline   -> RESELLER_SYNC /send-offline
//   number.online    -> RESELLER_SYNC /resend-online  (mints/reopens the rental)
//   teltik rotate    -> TELTIK_WORKER /rotate-sim?force=true
//   atomic/helix rot -> MDN_ROTATOR   /rotate-sim?force=true
// The two /rotate-sim routes already existed; the /send-offline route is new
// (reseller-sync had no offline sender reachable by a service binding).
// =========================================================

import { checkAndRecordTeltikHostPort } from '../shared/hosting-port-status.mjs';
import {
  shouldConfirmOffline, shouldConfirmOnline, isLifecycleEligible,
  planOfflineActions, planRecoveryActions,
  OFFLINE_PAUSE_REASON, OFFLINE_WEBHOOK_REASON,
} from '../shared/offline-lifecycle.mjs';
import { notifyOfflineLifecyclePlan } from './notify.mjs';

const CHECK_SOURCE = 'bad_rental_remediator';
// KV cursor over the candidate list, so consecutive ticks probe different
// slices instead of re-checking the head of the fleet forever.
const PROBE_CURSOR_KEY = 'bad_rental_remediator_offline_lifecycle_cursor';
// Per-SIM recovery cooldown. A line that flaps online/offline/online would
// otherwise re-send number.online (or worse, force-rotate) every hour.
const RECOVERY_COOLDOWN_KEY_PREFIX = 'bad_rental_remediator_offline_lifecycle_recovered:';
const RECOVERY_COOLDOWN_S = 60 * 60;
// Each probe costs ~4-6 subrequests (MDN resolve, port-status read, api-log
// mirror, check insert). 100 keeps a tick well inside the ~1000 per-invocation
// cap once the transition writes below are counted too.
const DEFAULT_PROBE_LIMIT = 100;
const PROBE_CONCURRENCY = 5;
// Real transitions per tick. Every one of these can reach a carrier or a
// reseller, so the cap is the blast-radius control the flag protects.
const DEFAULT_MAX_ACTIONS = 25;
// Candidate scan bound. Well above the current assigned-line count; exists so a
// runaway query can never build an unbounded in-memory list.
const CANDIDATE_CAP = 2000;
// Stop probing (not deciding) once the tick has spent this long, so a slow
// Teltik never starves the decision half of the tick.
const PROBE_BUDGET_MS = 60_000;
// How much check history the planners get. Two rows decide an outage; a few
// more make the ordering robust against a retry attempt landing out of order.
const CHECKS_PER_SIM = 6;
const ROTATE_TIMEOUT_MS = 75_000;

export function offlineLifecycleEnabled(env) {
  return String(env && env.OFFLINE_LIFECYCLE_ENABLED) === 'true';
}

export function offlineLifecycleDryRun(env) {
  return String(env && env.OFFLINE_LIFECYCLE_DRY_RUN) === 'true';
}

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sbHeaders(env, prefer) {
  const h = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function sbGetArray(env, path) {
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, { headers: sbHeaders(env) });
  if (!resp.ok) {
    console.log('[OfflineLifecycle] query failed HTTP ' + resp.status + ' ' + path.slice(0, 120));
    return [];
  }
  const rows = await resp.json().catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

async function sbPatch(env, path, body) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      method: 'PATCH',
      headers: sbHeaders(env, 'return=minimal'),
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.log('[OfflineLifecycle] PATCH failed HTTP ' + resp.status + ' ' + path.slice(0, 120));
    return resp.ok;
  } catch (err) {
    console.log('[OfflineLifecycle] PATCH exception: ' + (err && err.message || err));
    return false;
  }
}

// gatewayHostOf() semantics in PostgREST: explicit teltik host, or no explicit
// host and teltik vendor. Same predicate runHostingPortSweep uses.
const TELTIK_HOST_FILTER = 'or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))';
const SIM_SELECT = 'id,iccid,vendor,gateway_host,status,port_in_pending,offline_state,offline_since,'
  + 'rotation_eligible,rotation_pause_reason,rotation_interval_hours,last_mdn_rotated_at,'
  + 'sim_numbers(e164),reseller_sims(reseller_id,active,deactivated_reason)';

// The assignment row the lifecycle cares about: the active one if there is one,
// otherwise the one we closed ourselves (the restore target).
function pickAssignment(sim) {
  const rows = Array.isArray(sim.reseller_sims) ? sim.reseller_sims : [];
  return rows.find((r) => r.active === true)
    || rows.find((r) => r.active === false && r.deactivated_reason === OFFLINE_PAUSE_REASON)
    || null;
}

function shapeSim(sim) {
  return {
    ...sim,
    db_current_mdn: (sim.sim_numbers && sim.sim_numbers[0] && sim.sim_numbers[0].e164) || null,
    assignment: pickAssignment(sim),
  };
}

// Assigned lines plus already-latched-offline lines, deduped by id. Two queries
// because PostgREST cannot express "embedded reseller_sims.active=true OR a
// column on the parent" in a single `or=`.
async function fetchCandidates(env) {
  const [assigned, latched] = await Promise.all([
    sbGetArray(env, 'sims?select=' + SIM_SELECT
      + '&status=eq.active&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true'
      + '&' + TELTIK_HOST_FILTER + '&order=id.asc&limit=' + CANDIDATE_CAP),
    sbGetArray(env, 'sims?select=' + SIM_SELECT
      + '&status=eq.active&offline_state=eq.offline&sim_numbers.valid_to=is.null'
      + '&' + TELTIK_HOST_FILTER + '&order=id.asc&limit=' + CANDIDATE_CAP),
  ]);
  const byId = new Map();
  // The assigned query filters the embedded reseller_sims rows down to the
  // active one, so the latched query (unfiltered embed) wins on conflict: it is
  // the only one that can carry a deactivated_reason.
  for (const sim of assigned) byId.set(sim.id, sim);
  for (const sim of latched) byId.set(sim.id, sim);
  return [...byId.values()].map(shapeSim).filter(isLifecycleEligible);
}

async function readCursor(env, total) {
  if (!env.REMEDIATOR_KV || !total) return 0;
  try {
    const raw = await env.REMEDIATOR_KV.get(PROBE_CURSOR_KEY);
    const n = parseInt(raw || '0', 10);
    return Number.isFinite(n) && n > 0 ? n % total : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(env, value) {
  if (!env.REMEDIATOR_KV) return;
  try {
    await env.REMEDIATOR_KV.put(PROBE_CURSOR_KEY, String(value));
  } catch (err) {
    console.log('[OfflineLifecycle] cursor write failed: ' + err);
  }
}

// Probe `limit` candidates starting at the persisted cursor, wrapping around.
async function probeSlice(env, candidates, limit, startedAt) {
  const total = candidates.length;
  const start = await readCursor(env, total);
  const slice = [];
  for (let i = 0; i < Math.min(limit, total); i++) slice.push(candidates[(start + i) % total]);

  let idx = 0;
  let probed = 0;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, slice.length || 1) }, async () => {
    while (idx < slice.length) {
      if (Date.now() - startedAt > PROBE_BUDGET_MS) return;
      const sim = slice[idx++];
      try {
        await checkAndRecordTeltikHostPort(env, {
          id: sim.id, iccid: sim.iccid, vendor: sim.vendor,
          gateway_host: sim.gateway_host || 'teltik', db_current_mdn: sim.db_current_mdn,
        }, { source: CHECK_SOURCE });
        probed++;
      } catch (err) {
        console.log('[OfflineLifecycle] probe exception sim=' + sim.id + ': ' + (err && err.message || err));
      }
    }
  });
  await Promise.all(workers);
  await writeCursor(env, total ? (start + slice.length) % total : 0);
  return { probed, slice_size: slice.length, cursor_from: start };
}

// Recent checks for the given SIMs, grouped newest-first per sim. One query, so
// the decision half of the tick costs a single subrequest.
async function fetchChecks(env, simIds) {
  if (!simIds.length) return new Map();
  const rows = await sbGetArray(env, 'hosting_port_status_checks?select=sim_id,state,checked_at'
    + '&sim_id=in.(' + simIds.join(',') + ')'
    + '&order=sim_id.asc,checked_at.desc'
    + '&limit=' + (simIds.length * CHECKS_PER_SIM));
  const byId = new Map();
  for (const row of rows) {
    const list = byId.get(row.sim_id) || [];
    if (list.length < CHECKS_PER_SIM) list.push(row);
    byId.set(row.sim_id, list);
  }
  return byId;
}

async function recoveryCoolingDown(env, simId) {
  if (!env.REMEDIATOR_KV) return false;
  try {
    return !!(await env.REMEDIATOR_KV.get(RECOVERY_COOLDOWN_KEY_PREFIX + simId));
  } catch {
    return false;
  }
}

async function markRecovered(env, simId) {
  if (!env.REMEDIATOR_KV) return;
  try {
    await env.REMEDIATOR_KV.put(RECOVERY_COOLDOWN_KEY_PREFIX + simId, new Date().toISOString(),
      { expirationTtl: RECOVERY_COOLDOWN_S });
  } catch (err) {
    console.log('[OfflineLifecycle] cooldown write failed: ' + err);
  }
}

// --- action executors -----------------------------------------------------

async function callResellerSync(env, path, body) {
  if (!env.RESELLER_SYNC) return { ok: false, error: 'RESELLER_SYNC binding missing' };
  try {
    const resp = await env.RESELLER_SYNC.fetch(new Request('https://reseller-sync' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-caller': 'reseller-portal' },
      body: JSON.stringify(body),
    }));
    const text = await resp.text().catch(() => '');
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { ok: resp.ok && parsed.ok === true, status: resp.status, response: parsed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// Same shape as forceRotateSim in src/details-finalizer/index.js: service
// binding (CF blocks worker -> public .workers.dev fetches) with the shared
// ADMIN_RUN_SECRET on the query string, which is what both /rotate-sim routes
// already check.
async function forceRotate(env, sim, target) {
  const worker = target === 'teltik_worker' ? env.TELTIK_WORKER : env.MDN_ROTATOR;
  if (!worker) return { ok: false, error: 'no service binding for target=' + target };
  if (!sim.iccid) return { ok: false, error: 'sim has no iccid' };
  const base = target === 'teltik_worker' ? 'https://teltik-worker' : 'https://mdn-rotator';
  const url = base + '/rotate-sim?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET || '')
    + '&iccid=' + encodeURIComponent(sim.iccid) + '&force=true';
  try {
    const resp = await worker.fetch(url, { method: 'POST', signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS) });
    const text = await resp.text().catch(() => '');
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { ok: resp.ok && parsed.ok === true, status: resp.status, response: parsed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function executeAction(env, sim, action, nowIso) {
  switch (action.type) {
    case 'pause_rotation':
      return sbPatch(env, 'sims?id=eq.' + sim.id,
        { rotation_eligible: false, rotation_pause_reason: OFFLINE_PAUSE_REASON });
    case 'send_offline_webhook':
      return (await callResellerSync(env, '/send-offline',
        { simId: Number(sim.id), reason: OFFLINE_WEBHOOK_REASON })).ok;
    case 'unassign_reseller':
      return sbPatch(env, 'reseller_sims?sim_id=eq.' + sim.id + '&active=eq.true',
        { active: false, deactivated_reason: OFFLINE_PAUSE_REASON, deactivated_at: nowIso });
    case 'latch_offline':
      return sbPatch(env, 'sims?id=eq.' + sim.id, {
        offline_state: 'offline',
        offline_since: sim.offline_since || nowIso,
        offline_notified_at: nowIso,
      });
    case 'restore_assignment':
      return sbPatch(env,
        'reseller_sims?sim_id=eq.' + sim.id + '&deactivated_reason=eq.' + OFFLINE_PAUSE_REASON,
        { active: true, deactivated_reason: null, deactivated_at: null });
    case 'resume_rotation':
      return sbPatch(env, 'sims?id=eq.' + sim.id,
        { rotation_eligible: true, rotation_pause_reason: null });
    case 'resend_online':
      return (await callResellerSync(env, '/resend-online',
        { simId: Number(sim.id), source: 'portal_resync' })).ok;
    case 'force_rotate':
      return (await forceRotate(env, sim, action.target)).ok;
    case 'latch_online':
      return sbPatch(env, 'sims?id=eq.' + sim.id, { offline_state: 'online', offline_since: null });
    default:
      console.log('[OfflineLifecycle] unknown action ' + action.type);
      return false;
  }
}

// Actions run in the order the planner produced them and the sequence stops on
// the first failure. That ordering is load-bearing on both sides: the offline
// webhook must precede the unassign, and the restore must precede any number
// event or rotation, because every sender resolves the reseller through
// reseller_sims.active=true.
async function executePlan(env, sim, actions, nowIso) {
  const done = [];
  for (const action of actions) {
    const ok = await executeAction(env, sim, action, nowIso);
    done.push({ type: action.type, ok });
    if (!ok) {
      console.log('[OfflineLifecycle] sim=' + sim.id + ' action ' + action.type + ' failed; stopping plan');
      break;
    }
  }
  return done;
}

// --- the tick -------------------------------------------------------------

export async function runOfflineLifecycleTick(env, { now } = {}) {
  const startedAt = Date.now();
  const at = now instanceof Date ? now : new Date();

  if (!offlineLifecycleEnabled(env)) {
    console.log('[OfflineLifecycle] OFFLINE_LIFECYCLE_ENABLED is not true; skipping tick.');
    return { skipped: 'disabled', candidates: 0, probed: 0, offline: 0, recovered: 0 };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[OfflineLifecycle] missing Supabase credentials; skipping tick.');
    return { skipped: 'missing_credentials', candidates: 0, probed: 0, offline: 0, recovered: 0 };
  }

  const dryRun = offlineLifecycleDryRun(env);
  const probeLimit = positiveInt(env.OFFLINE_LIFECYCLE_PROBE_LIMIT, DEFAULT_PROBE_LIMIT);
  const maxActions = positiveInt(env.OFFLINE_LIFECYCLE_MAX_ACTIONS, DEFAULT_MAX_ACTIONS);

  const candidates = await fetchCandidates(env);
  let probe = { probed: 0, slice_size: 0, cursor_from: 0 };
  if (!dryRun && candidates.length) {
    probe = await probeSlice(env, candidates, probeLimit, startedAt);
  }

  const checksBySim = await fetchChecks(env, candidates.map((s) => s.id));
  const nowIso = at.toISOString();
  const summary = {
    dry_run: dryRun,
    candidates: candidates.length,
    probed: probe.probed,
    probe_slice: probe.slice_size,
    probe_cursor_from: probe.cursor_from,
    offline: 0,
    recovered: 0,
    cooling_down: 0,
    capped: false,
    plans: [],
  };

  let acted = 0;
  for (const sim of candidates) {
    if (acted >= maxActions) { summary.capped = true; break; }
    const checks = checksBySim.get(sim.id) || [];
    const latched = sim.offline_state === 'offline';

    let kind = null;
    let actions = null;
    if (!latched && shouldConfirmOffline(checks, at)) {
      kind = 'offline';
      actions = planOfflineActions(sim, sim.assignment);
    } else if (latched && shouldConfirmOnline(checks, at)) {
      if (await recoveryCoolingDown(env, sim.id)) {
        summary.cooling_down++;
        continue;
      }
      kind = 'recovery';
      actions = planRecoveryActions(sim, sim.assignment, at);
    }
    if (!kind) continue;

    acted++;
    if (kind === 'offline') summary.offline++; else summary.recovered++;
    const plan = {
      sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, kind,
      reseller_id: (sim.assignment && sim.assignment.reseller_id) || null,
      actions: actions.map((a) => a.type),
    };
    if (!dryRun) {
      plan.results = await executePlan(env, sim, actions, nowIso);
      if (kind === 'recovery') await markRecovered(env, sim.id);
    }
    summary.plans.push(plan);
  }

  if (dryRun && summary.plans.length) {
    await notifyOfflineLifecyclePlan(env, summary.plans);
  }

  summary.ms = Date.now() - startedAt;
  console.log('[OfflineLifecycle] tick ' + JSON.stringify({
    dry_run: summary.dry_run, candidates: summary.candidates, probed: summary.probed,
    offline: summary.offline, recovered: summary.recovered, cooling_down: summary.cooling_down,
    capped: summary.capped, ms: summary.ms,
  }));
  return summary;
}
