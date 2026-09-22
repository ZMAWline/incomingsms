// =========================================================
// Offline SIM lifecycle executor (probe cron + hourly decision cron).
//
// Decisions live in src/shared/offline-lifecycle.mjs (pure, unit-tested). This
// file is the IO half: probe, read history, execute, record. It owns no policy
// beyond ordering and budgets.
//
// Both runs gate on OFFLINE_LIFECYCLE_ENABLED. Off (the default) means log and
// return, no query, no write, no carrier call.
//
// Candidates: SIMs on an active reseller assignment, plus SIMs already latched
// offline_state='offline'. Teltik-hosted and status=active only;
// port_in_pending lines are dropped.
//
// Probe run (PROBE_CRON, every 3 minutes): probe the candidates whose newest
// check is oldest, through checkAndRecordTeltikHostPort, the same recorder
// every other port-status caller uses. It is a separate invocation from the
// decision tick because ~4300 candidates cannot all be probed within 6h from an
// hourly tick without passing the per-invocation subrequest budget.
//
// Decision tick (hourly): read the newest checks for every candidate and run
// the pure planners. Execute at most OFFLINE_LIFECYCLE_MAX_ACTIONS transitions.
//
// OFFLINE_LIFECYCLE_DRY_RUN still probes (a probe only records a check row, the
// same thing read-only dashboard queries do), so the digest reflects real
// readings. The decision tick then makes no webhook send, no rotation and no
// write to sims or reseller_sims; the planned actions go to the existing Slack
// digest instead, which is the artifact to review before enabling writes.
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
  planOfflineActions, planRecoveryActions, offlineEpisodeStart,
  OFFLINE_PAUSE_REASON, OFFLINE_WEBHOOK_REASON, CHECK_HISTORY_WINDOW_MS,
} from '../shared/offline-lifecycle.mjs';
import { notifyOfflineLifecyclePlan } from './notify.mjs';
import { sbGetAll, sbPatch, sbRpc, SupabaseError } from '../shared/supabase-rest.mjs';

const CHECK_SOURCE = 'bad_rental_remediator';
// Per-SIM recovery cooldown. A line that flaps online/offline/online would
// otherwise re-send number.online (or worse, force-rotate) every hour.
const RECOVERY_COOLDOWN_KEY_PREFIX = 'bad_rental_remediator_offline_lifecycle_recovered:';
const RECOVERY_COOLDOWN_S = 60 * 60;
// Probe cadence. The probe cron fires 20 times an hour; each run probes
// ceil(candidates / PROBE_RUNS_PER_CYCLE) of the stalest candidates, so every
// candidate is visited within 100 runs (5h), inside the 6h freshness rule.
export const PROBE_RUNS_PER_CYCLE = 100;
// Subrequest ceiling per probe run. A probe costs about 5 subrequests (MDN
// resolve, port-status read, api-log mirror, check insert) and up to 9 on the
// wrong-MDN retry path. 50 x 9 = 450, plus the paged candidate queries and
// history reads (17 at 5000 candidates), stays under 500. 50 per run covers
// 5000 candidates per cycle.
export const MAX_PROBES_PER_RUN = 50;
const PROBE_CONCURRENCY = 5;
// Real transitions per tick. Every one of these can reach a carrier or a
// reseller, so the cap is the blast-radius control the flag protects.
const DEFAULT_MAX_ACTIONS = 25;
// SIMs per get_recent_hosting_port_checks call. The RPC returns one row per
// SIM, so this keeps each response under the 1000-row PostgREST limit.
const CHECK_BATCH = 500;
// Stop a probe run once it has spent this long, so a slow Teltik cannot keep
// the invocation open until the next run starts.
const PROBE_BUDGET_MS = 60_000;
// How much check history the planners get. Two rows decide an outage; a few
// more let offlineEpisodeStart find the start of a longer outage.
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

// The reads and writes below tolerate a PostgREST error on purpose: this
// sweep runs every cron tick, and one failed query or patch must not stop the
// rest of the fleet. A timeout or network error still throws.

// Every row of a query. `path` must carry a stable order. A failed page fails
// the whole read (empty list), the same outcome a failed single query had.
async function readAllOrEmpty(env, path) {
  try {
    return await sbGetAll(env, path);
  } catch (err) {
    if (!(err instanceof SupabaseError)) throw err;
    console.log('[OfflineLifecycle] query failed HTTP ' + err.status + ' ' + path.slice(0, 120));
    return [];
  }
}

async function rpcRowsOrEmpty(env, fn, args) {
  try {
    const rows = await sbRpc(env, fn, args);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (!(err instanceof SupabaseError)) throw err;
    console.log('[OfflineLifecycle] rpc ' + fn + ' failed HTTP ' + err.status);
    return [];
  }
}

// true when the patch landed. Never throws.
async function patchOk(env, path, body) {
  try {
    await sbPatch(env, path, body, { prefer: 'return=minimal' });
    return true;
  } catch (err) {
    if (err instanceof SupabaseError) {
      console.log('[OfflineLifecycle] PATCH failed HTTP ' + err.status + ' ' + path.slice(0, 120));
    } else {
      console.log('[OfflineLifecycle] PATCH exception: ' + (err && err.message || err));
    }
    return false;
  }
}

// gatewayHostOf() semantics in PostgREST: explicit teltik host, or no explicit
// host and teltik vendor. Same predicate runHostingPortSweep uses.
const TELTIK_HOST_FILTER = 'or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))';
const SIM_COLUMNS = 'id,iccid,vendor,gateway_host,status,port_in_pending,offline_state,offline_since,'
  + 'rotation_eligible,rotation_pause_reason,rotation_interval_hours,last_mdn_rotated_at,sim_numbers(e164)';
const ASSIGNMENT_COLUMNS = '(reseller_id,active,deactivated_reason)';

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
// column on the parent" in a single `or=`. The assigned query uses !inner, so
// the embed filter drops unassigned SIMs instead of only their embedded rows.
async function fetchCandidates(env) {
  const [assigned, latched] = await Promise.all([
    readAllOrEmpty(env, 'sims?select=' + SIM_COLUMNS + ',reseller_sims!inner' + ASSIGNMENT_COLUMNS
      + '&status=eq.active&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true'
      + '&' + TELTIK_HOST_FILTER + '&order=id.asc'),
    readAllOrEmpty(env, 'sims?select=' + SIM_COLUMNS + ',reseller_sims' + ASSIGNMENT_COLUMNS
      + '&status=eq.active&offline_state=eq.offline&sim_numbers.valid_to=is.null'
      + '&' + TELTIK_HOST_FILTER + '&order=id.asc'),
  ]);
  const byId = new Map();
  // The assigned query's embed only holds the active row, so the latched query
  // (unfiltered embed) wins on conflict: it is the only one that can carry a
  // deactivated_reason.
  for (const sim of assigned) byId.set(sim.id, sim);
  for (const sim of latched) byId.set(sim.id, sim);
  return [...byId.values()].map(shapeSim).filter(isLifecycleEligible);
}

// Newest checks per SIM, newest-first, from get_recent_hosting_port_checks.
// The RPC caps the history per SIM, so no SIM can starve the others.
async function fetchChecks(env, simIds, at) {
  const byId = new Map();
  const since = new Date(at.getTime() - CHECK_HISTORY_WINDOW_MS).toISOString();
  for (let i = 0; i < simIds.length; i += CHECK_BATCH) {
    const rows = await rpcRowsOrEmpty(env, 'get_recent_hosting_port_checks', {
      p_sim_ids: simIds.slice(i, i + CHECK_BATCH), p_per_sim: CHECKS_PER_SIM, p_since: since,
    });
    for (const row of rows) byId.set(row.sim_id, Array.isArray(row.checks) ? row.checks : []);
  }
  return byId;
}

// Probes per run: enough to visit every candidate within PROBE_RUNS_PER_CYCLE
// runs, capped by the subrequest budget.
export function probeLimitFor(candidateCount) {
  return Math.min(MAX_PROBES_PER_RUN, Math.ceil(candidateCount / PROBE_RUNS_PER_CYCLE));
}

// Epoch ms of a SIM's newest check, or -Infinity when it has none, so
// never-probed SIMs sort first.
function newestCheckMs(checks) {
  const ts = checks && checks[0] ? Date.parse(checks[0].checked_at || '') : NaN;
  return Number.isNaN(ts) ? -Infinity : ts;
}

async function probeSims(env, sims, startedAt) {
  let idx = 0;
  let probed = 0;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, sims.length || 1) }, async () => {
    while (idx < sims.length) {
      if (Date.now() - startedAt > PROBE_BUDGET_MS) return;
      const sim = sims[idx++];
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
  return probed;
}

// One probe run: the stalest candidates first. Ordering by the newest recorded
// check (from any source, not only this run) is what bounds every candidate's
// check age, even as SIMs join or leave the candidate list between runs.
// Runs in dry run too: recording a check row is not a lifecycle write.
export async function runOfflineProbeRun(env, { now } = {}) {
  const startedAt = Date.now();
  const at = now instanceof Date ? now : new Date();
  if (!offlineLifecycleEnabled(env)) {
    console.log('[OfflineLifecycle] OFFLINE_LIFECYCLE_ENABLED is not true; skipping probe run.');
    return { skipped: 'disabled', candidates: 0, probed: 0 };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[OfflineLifecycle] missing Supabase credentials; skipping probe run.');
    return { skipped: 'missing_credentials', candidates: 0, probed: 0 };
  }

  const candidates = await fetchCandidates(env);
  const checksBySim = await fetchChecks(env, candidates.map((s) => s.id), at);
  const limit = probeLimitFor(candidates.length);
  const stalest = candidates
    .map((sim) => ({ sim, newest: newestCheckMs(checksBySim.get(sim.id)) }))
    .sort((x, y) => x.newest - y.newest)
    .slice(0, limit)
    .map((x) => x.sim);
  const probed = await probeSims(env, stalest, startedAt);

  const summary = {
    candidates: candidates.length, probe_limit: limit, probed,
    // True when the candidate list outgrew what MAX_PROBES_PER_RUN can cover
    // within the freshness window.
    coverage_short: candidates.length > MAX_PROBES_PER_RUN * PROBE_RUNS_PER_CYCLE,
    ms: Date.now() - startedAt,
  };
  console.log('[OfflineLifecycle] probe run ' + JSON.stringify(summary));
  return summary;
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

// FINALIZER_RUN_SECRET is the hard credential reseller-sync checks; the header
// only identifies the caller in its logs.
async function callResellerSync(env, path, body) {
  if (!env.RESELLER_SYNC) return { ok: false, error: 'RESELLER_SYNC binding missing' };
  const url = 'https://reseller-sync' + path + '?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET || '');
  try {
    const resp = await env.RESELLER_SYNC.fetch(new Request(url, {
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

// Returns true (done), false (failed; the plan stops) or 'skipped' (nothing to
// do; the plan continues).
async function executeAction(env, sim, action, nowIso, ctx) {
  switch (action.type) {
    case 'pause_rotation':
      return patchOk(env, 'sims?id=eq.' + sim.id,
        { rotation_eligible: false, rotation_pause_reason: OFFLINE_PAUSE_REASON });
    case 'send_offline_webhook': {
      const result = await callResellerSync(env, '/send-offline',
        { simId: Number(sim.id), reason: OFFLINE_WEBHOOK_REASON, offlineSince: action.offline_since });
      // 412: the reseller has no enabled webhook. There is no one to notify,
      // and retrying every hour cannot change that, so the unassign proceeds.
      if (result.status === 412) {
        console.log('[OfflineLifecycle] sim=' + sim.id + ' reseller=' + action.reseller_id
          + ' has no enabled webhook; number.offline skipped, unassigning anyway');
        return 'skipped';
      }
      if (result.ok) ctx.notified = true;
      return result.ok;
    }
    case 'unassign_reseller':
      return patchOk(env, 'reseller_sims?sim_id=eq.' + sim.id + '&active=eq.true',
        { active: false, deactivated_reason: OFFLINE_PAUSE_REASON, deactivated_at: nowIso });
    case 'latch_offline':
      return patchOk(env, 'sims?id=eq.' + sim.id, {
        offline_state: 'offline',
        offline_since: action.offline_since || nowIso,
        offline_notified_at: ctx.notified ? nowIso : null,
      });
    case 'restore_assignment':
      return patchOk(env,
        'reseller_sims?sim_id=eq.' + sim.id + '&deactivated_reason=eq.' + OFFLINE_PAUSE_REASON,
        { active: true, deactivated_reason: null, deactivated_at: null });
    case 'resume_rotation':
      return patchOk(env, 'sims?id=eq.' + sim.id,
        { rotation_eligible: true, rotation_pause_reason: null });
    case 'resend_online':
      return (await callResellerSync(env, '/resend-online',
        { simId: Number(sim.id), source: 'portal_resync' })).ok;
    case 'force_rotate':
      return (await forceRotate(env, sim, action.target)).ok;
    case 'latch_online':
      return patchOk(env, 'sims?id=eq.' + sim.id, { offline_state: 'online', offline_since: null });
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
  const ctx = { notified: false };
  for (const action of actions) {
    const result = await executeAction(env, sim, action, nowIso, ctx);
    const ok = result === true || result === 'skipped';
    done.push(result === 'skipped' ? { type: action.type, ok, skipped: true } : { type: action.type, ok });
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
    return { skipped: 'disabled', candidates: 0, offline: 0, recovered: 0 };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[OfflineLifecycle] missing Supabase credentials; skipping tick.');
    return { skipped: 'missing_credentials', candidates: 0, offline: 0, recovered: 0 };
  }

  const dryRun = offlineLifecycleDryRun(env);
  const maxActions = positiveInt(env.OFFLINE_LIFECYCLE_MAX_ACTIONS, DEFAULT_MAX_ACTIONS);

  const candidates = await fetchCandidates(env);
  const checksBySim = await fetchChecks(env, candidates.map((s) => s.id), at);
  const nowIso = at.toISOString();
  const summary = {
    dry_run: dryRun,
    candidates: candidates.length,
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
      actions = planOfflineActions(sim, sim.assignment, offlineEpisodeStart(checks));
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
    dry_run: summary.dry_run, candidates: summary.candidates,
    offline: summary.offline, recovered: summary.recovered, cooling_down: summary.cooling_down,
    capped: summary.capped, ms: summary.ms,
  }));
  return summary;
}
