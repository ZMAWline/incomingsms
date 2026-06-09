// =========================================================
// BAD-RENTAL REMEDIATOR WORKER (INC-17 / INC-16a scaffold)
//
// Scope per Plan v4 §O step 1
// (docs/superpowers/plans/2026-06-07-bad-rental-auto-remediation.md):
//   - Intake: resolve identifier → DB evidence (no vendor calls yet).
//   - Shared situations S1..S6 (already cancelled, already replaced,
//     duplicate, contract rejected, gateway offline, insufficient evidence).
//   - §E pre-close cancel-guard helper (S1 uses it).
//   - operator_locked / paused / verify_pending skip rules.
//   - KV kill-switch `bad_rental_remediator_enabled`.
//   - Records one rental_report_remediation_attempts row per processed
//     report with the classified outcome. No vendor writes, no SMS, no
//     reseller-facing message.
//
// Vendor classifier (16b), §C SMS verify (16c), safe write actions (16d),
// vendor restore/refresh (16e) and batched escalation (16f) are out of scope
// here and arrive on later branches.
// =========================================================

import { runVerifyPoll, preResolveGate } from './verify-runner.mjs';
import { executeAction } from './actions.mjs';
import { canAttempt } from './cooldown.mjs';
import { teltikPortStatus } from './vendor.mjs';
import { mdn10 } from './teltik.mjs';
import { flushEscalations, maybeOpenVendorBatchTickets, normalizeFailureType } from './escalations.mjs';

const KILL_SWITCH_KEY = 'bad_rental_remediator_enabled';
const LAST_MAIN_TICK_KEY = 'bad_rental_remediator_last_main_tick';
const LAST_VERIFY_POLL_KEY = 'bad_rental_remediator_last_verify_poll';
const ACTION_DISABLE_PREFIX = 'bad_rental_remediator_action_';
const ACTION_DISABLE_SUFFIX = '_disabled';
const TICK_BUDGET_MS = 55_000; // §G: 60s tick budget, leave headroom.
const CONCURRENCY = 5;         // §G concurrency cap.
const INTAKE_LIMIT = 50;       // upper bound per tick.
// INC-25: any row stuck in `in_progress` past this window with no progress
// is treated as an abandoned claim from a crashed/raced tick and reset to
// `queued` at the start of the next tick. 10 minutes is well above the 60s
// tick budget so an in-flight tick can never be reset out from under itself.
const STALE_CLAIM_MS = 10 * 60 * 1000;
// INC-25: KV-backed tick lock prevents Run-Now + cron from racing on the
// same queued rows (which manifested as `skipped_not_claimed=50, attempted=0`
// on the loser). TTL > TICK_BUDGET_MS so a crashed tick releases naturally.
const TICK_LOCK_KEY = 'bad_rental_remediator_main_tick_lock';
const TICK_LOCK_TTL_S = 120;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const result = await runTick(env);
      return json({ ok: true, result }, 200);
    }
    if (url.pathname === '/status') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const status = await buildStatus(env);
      return json({ ok: true, status }, 200);
    }
    if (url.pathname === '/kill-switch' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (!env.REMEDIATOR_KV) {
        return json({ ok: false, error: 'no_kv_binding' }, 500);
      }
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const enabled = body && body.enabled === true;
      await env.REMEDIATOR_KV.put(KILL_SWITCH_KEY, enabled ? 'true' : 'false');
      return json({ ok: true, kill_switch: enabled ? 'enabled' : 'disabled' }, 200);
    }
    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'bad-rental-remediator' }, 200);
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Two cron expressions are registered (§G):
    //   - '*/1 * * * *'  → §C receive-poll: walk verify_pending reports, look
    //                      for the nonce in inbound_sms, timeout-then-escalate.
    //   - '0 */2 * * *'  → main intake tick (S1..S6 + vendor classifier).
    // event.cron is the literal expression the trigger fired on.
    const cron = (event && event.cron) || '';
    if (cron === '*/1 * * * *') {
      const startedAt = Date.now();
      ctx.waitUntil((async () => {
        // INC-24: short-circuit if dormant (kill-switch off or missing creds) so
        // a misconfigured worker doesn't throw `undefined/rest/v1/...` once a
        // minute. Mirror what runTick does for the main cron.
        const dormancy = await verifyPollDormancyReason(env);
        if (dormancy) {
          console.log('[Remediator] verify-poll skipped: ' + dormancy);
          return recordLastTick(env, LAST_VERIFY_POLL_KEY, {
            completed_at: new Date().toISOString(),
            skipped: dormancy,
            dormancy_reason: dormancy,
            polled: 0, matched: 0, timed_out: 0, still_pending: 0,
            ms: Date.now() - startedAt,
          });
        }
        try {
          const r = await runVerifyPoll(env);
          console.log('[Remediator] verify-poll done ' + JSON.stringify(r));
          return recordLastTick(env, LAST_VERIFY_POLL_KEY, {
            completed_at: new Date().toISOString(),
            polled: (r && r.polled) || 0,
            matched: (r && r.matched) || 0,
            timed_out: (r && r.timedOut) || 0,
            still_pending: (r && r.stillPending) || 0,
            ms: Date.now() - startedAt,
          });
        } catch (err) {
          console.log('[Remediator] verify-poll error: ' + err);
          return recordLastTick(env, LAST_VERIFY_POLL_KEY, {
            completed_at: new Date().toISOString(),
            error: String(err),
            ms: Date.now() - startedAt,
          });
        }
      })());
      return;
    }
    ctx.waitUntil(runTick(env).catch(err => {
      console.log('[Remediator] scheduled error: ' + err);
    }));
  },
};

// Re-export the universal §C gate so 16d (per-vendor flows) can consume it
// without reaching into the runner module path.
export { preResolveGate, runVerifyPoll, startVerify, resolvePendingVerify } from './verify-runner.mjs';
export { cleanRecheckPredicate, mintNonce, buildVerifyBody } from './verify.mjs';

// ---------------------------------------------------------
// Top-level tick
// ---------------------------------------------------------

async function runTick(env) {
  const startedAt = Date.now();
  if (!(await killSwitchEnabled(env))) {
    console.log('[Remediator] kill-switch disabled; skipping tick.');
    const out = { skipped: 'kill_switch_off', processed: 0 };
    await recordLastTick(env, LAST_MAIN_TICK_KEY, { ...out, completed_at: new Date(startedAt).toISOString(), ms: 0, dormancy_reason: 'kill_switch_off' });
    return out;
  }
  if (!hasSupabaseCredentials(env)) {
    // INC-24: if a future SUPABASE_URL/SERVICE_ROLE_KEY outage strips the env,
    // emit a single missing_credentials dormancy summary instead of letting
    // every fetch throw `undefined/rest/v1/...`.
    console.log('[Remediator] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; skipping tick.');
    const out = { skipped: 'missing_credentials', processed: 0 };
    await recordLastTick(env, LAST_MAIN_TICK_KEY, { ...out, completed_at: new Date(startedAt).toISOString(), ms: 0, dormancy_reason: 'missing_credentials' });
    return out;
  }
  // INC-25: refuse to start a second main tick while another is running.
  // The previous symptom was Run-Now + cron racing on the same queued rows,
  // surfaced as `skipped_not_claimed=50, attempted=0` on the loser.
  const lockAcquired = await acquireTickLock(env);
  if (!lockAcquired) {
    console.log('[Remediator] tick skipped: another tick is holding the lock.');
    const out = { skipped: 'tick_in_progress', processed: 0 };
    await recordLastTick(env, LAST_MAIN_TICK_KEY, { ...out, completed_at: new Date(startedAt).toISOString(), ms: Date.now() - startedAt, dormancy_reason: 'tick_in_progress' });
    return out;
  }

  let staleRecovered = 0;
  let processed = 0, attempted = 0;
  const outcomes = {};
  const escalationCandidates = [];
  let reportsFetched = 0;
  try {
    // INC-25: release any rows abandoned in `in_progress` by a prior crashed
    // or raced tick before we fetch. Without this, those rows leak forever and
    // the queue depth chart misleads operators.
    staleRecovered = await recoverStaleClaims(env, STALE_CLAIM_MS);
    if (staleRecovered > 0) {
      console.log('[Remediator] recovered ' + staleRecovered + ' stale in_progress claims back to queued.');
    }

    const reports = await fetchOpenReports(env, INTAKE_LIMIT);
    reportsFetched = reports.length;
    console.log('[Remediator] fetched ' + reports.length + ' open reports.');

    for (let i = 0; i < reports.length; i += CONCURRENCY) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) {
        console.log('[Remediator] tick budget exceeded; stopping at ' + processed + '.');
        break;
      }
      const slice = reports.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map(r => processReportSafe(env, r)));
      for (const res of results) {
        processed++;
        if (res && res.outcome) {
          outcomes[res.outcome] = (outcomes[res.outcome] || 0) + 1;
          if (res.attemptInserted) attempted++;
        }
        if (res && res.escalationCandidate) escalationCandidates.push(res.escalationCandidate);
      }
    }
  } finally {
    await releaseTickLock(env);
  }

  // §H.3 — batched operator escalations for everything that escalated this tick.
  let escalationsResult = { batches: 0, posted: 0, reserved: 0, skipped_dedup: 0 };
  try {
    escalationsResult = await flushEscalations(env, {
      now: new Date(),
      candidates: escalationCandidates,
      parentIssueId: env.ESCALATION_PARENT_ISSUE_ID || null,
    });
  } catch (err) {
    console.log('[Remediator] flushEscalations error: ' + err);
  }

  // §H.4 — vendor batch tickets (toggle-gated per carrier, default off).
  let vendorBatch = { vendors: [], opened: 0 };
  try {
    vendorBatch = await maybeOpenVendorBatchTickets(env, {
      now: new Date(),
      parentIssueId: env.ESCALATION_PARENT_ISSUE_ID || null,
    });
  } catch (err) {
    console.log('[Remediator] vendor-batch error: ' + err);
  }

  const ms = Date.now() - startedAt;
  const dormancy_reason = reportsFetched === 0 ? 'no_open_reports' : null;
  console.log('[Remediator] tick done in ' + ms + 'ms; processed=' + processed
    + ' stale_recovered=' + staleRecovered
    + ' outcomes=' + JSON.stringify(outcomes)
    + ' escalations=' + JSON.stringify(escalationsResult)
    + ' vendor_batch=' + JSON.stringify(vendorBatch));
  const summary = {
    completed_at: new Date(Date.now()).toISOString(),
    processed,
    attempted,
    stale_recovered: staleRecovered,
    outcomes,
    escalations: escalationsResult,
    vendorBatch,
    ms,
    dormancy_reason,
  };
  await recordLastTick(env, LAST_MAIN_TICK_KEY, summary);
  return { processed, attempted, stale_recovered: staleRecovered, outcomes, escalations: escalationsResult, vendorBatch, ms };
}

async function recordLastTick(env, key, summary) {
  if (!env.REMEDIATOR_KV) return;
  try {
    await env.REMEDIATOR_KV.put(key, JSON.stringify(summary));
  } catch (err) {
    console.log('[Remediator] recordLastTick(' + key + ') failed: ' + err);
  }
}

async function buildStatus(env) {
  const enabled = await killSwitchEnabled(env);
  const [lastMain, lastVerify, openCounts, actionDisables] = await Promise.all([
    readJsonKv(env, LAST_MAIN_TICK_KEY),
    readJsonKv(env, LAST_VERIFY_POLL_KEY),
    fetchOpenCounts(env),
    listDisabledActions(env),
  ]);
  return {
    kill_switch: enabled ? 'enabled' : 'disabled',
    last_main_tick: lastMain,
    last_verify_poll: lastVerify,
    open_counts: openCounts,
    action_disables: actionDisables,
    schedule: {
      main_cron: '0 */2 * * *',
      verify_poll_cron: '*/1 * * * *',
      intake_limit: INTAKE_LIMIT,
      concurrency: CONCURRENCY,
      tick_budget_ms: TICK_BUDGET_MS,
    },
  };
}

async function readJsonKv(env, key) {
  if (!env.REMEDIATOR_KV) return null;
  try {
    const v = await env.REMEDIATOR_KV.get(key);
    return v ? JSON.parse(v) : null;
  } catch (err) {
    console.log('[Remediator] readJsonKv(' + key + ') failed: ' + err);
    return null;
  }
}

async function listDisabledActions(env) {
  if (!env.REMEDIATOR_KV || !env.REMEDIATOR_KV.list) return [];
  try {
    const out = [];
    let cursor;
    do {
      const page = await env.REMEDIATOR_KV.list({ prefix: ACTION_DISABLE_PREFIX, cursor });
      for (const k of page.keys || []) {
        if (!k.name.endsWith(ACTION_DISABLE_SUFFIX)) continue;
        const v = await env.REMEDIATOR_KV.get(k.name);
        if (v === 'true' || v === '1') {
          const action = k.name.slice(ACTION_DISABLE_PREFIX.length, -ACTION_DISABLE_SUFFIX.length);
          out.push(action);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  } catch (err) {
    console.log('[Remediator] listDisabledActions failed: ' + err);
    return [];
  }
}

async function fetchOpenCounts(env) {
  const out = { queued: 0, in_progress: 0, verify_pending: 0, operator_locked: 0, escalated: 0 };
  try {
    const q = "rental_reports?select=auto_remediation_state&status=in.(received,in_triage,remediated)&auto_remediation_state=in.(queued,in_progress,verify_pending,operator_locked,escalated)";
    const r = await supabaseGet(env, q);
    if (!r.ok) return out;
    const rows = await r.json();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const s = row.auto_remediation_state;
        if (s in out) out[s]++;
      }
    }
    // queued also includes the null/unclaimed open reports
    const q2 = "rental_reports?select=id&status=in.(received,in_triage)&or=(auto_remediation_state.is.null,auto_remediation_state.eq.queued)";
    const r2 = await supabaseGet(env, q2);
    if (r2.ok) {
      const rows2 = await r2.json();
      if (Array.isArray(rows2)) out.queued = rows2.length;
    }
  } catch (err) {
    console.log('[Remediator] fetchOpenCounts failed: ' + err);
  }
  return out;
}

async function processReportSafe(env, report) {
  try {
    return await processReport(env, report);
  } catch (err) {
    console.log('[Remediator] report ' + report.id + ' error: ' + err);
    // INC-25: if processReport threw after claimReport flipped the row to
    // `in_progress`, the row would otherwise leak forever and need the next
    // tick's stale-claim sweep to recover. Try a best-effort reset back to
    // `queued` so the next tick picks it up immediately.
    try { await releaseClaimedToQueued(env, report.id); } catch (_) { /* swallow */ }
    return { outcome: 'error', error: String(err) };
  }
}

// ---------------------------------------------------------
// Intake — resolve, classify shared situations, record attempt.
// ---------------------------------------------------------

async function processReport(env, report) {
  // CAS-style row lock: claim the report by setting auto_remediation_state.
  const claimed = await claimReport(env, report);
  if (!claimed) {
    return { outcome: 'skipped_not_claimed', attemptInserted: false };
  }

  const evidence = await gatherEvidence(env, report);
  const classification = await classifyShared(env, report, evidence);

  const attemptNo = (evidence.priorAttempts || 0) + 1;

  // INC-16d: execute the safe action returned by the classifier (if any).
  // Forbidden actions are rejected inside executeAction so a classifier bug
  // that emits one can never reach a vendor surface.
  const exec = await maybeExecuteAction(env, {
    report, evidence, classification, attemptNo,
  });

  await insertAttempt(env, {
    report_id: report.id,
    attempt_no: attemptNo,
    mode: classification.mode,
    action: classification.action,
    outcome: exec.outcome || classification.outcome,
    evidence: mergeEvidence(classification.evidenceSummary, exec.evidence),
    error_message: exec.errorMessage || classification.errorMessage || null,
    next_review_at: classification.nextReviewAt || null,
  });

  // Update report-level auto state per classification + executor result.
  await applyClassificationState(env, report, classification, exec);

  const escalationCandidate = buildEscalationCandidate(report, evidence, classification, exec, attemptNo);

  return {
    outcome: exec.outcome || classification.outcome,
    mode: classification.mode,
    attemptInserted: true,
    escalationCandidate,
  };
}

// ---------------------------------------------------------
// §H.3 escalation candidate
//
// Emits a candidate when the classifier or executor signals an operator
// escalation. The batcher groups by (vendor, failure_type, tick) and dedups
// against the operator_escalations table.
// ---------------------------------------------------------

function buildEscalationCandidate(report, evidence, classification, exec, attemptNo) {
  const classifierEsc = classification && classification.terminal && classification.outcome === 'escalate';
  const execFailed = exec && (exec.outcome === 'failed' || exec.outcome === 'verify_pending');
  const verifyTerm = exec && (exec.gateStatus === 'verify_send_failed' || exec.gateStatus === 'verify_receive_timeout');
  if (!classifierEsc && !verifyTerm && !(execFailed && classification.escalationReason)) {
    return null;
  }
  const sim = evidence && evidence.sim || {};
  const rental = evidence && evidence.rental || {};
  const reason = (classification && classification.escalationReason)
    || (exec && exec.gateStatus)
    || (exec && exec.execStatus)
    || 'generic';
  const vendor = String(sim.vendor || 'unknown').toLowerCase();
  const failure_type = normalizeFailureType(reason);
  return {
    vendor,
    failure_type,
    escalation_reason: reason,
    line_item: {
      report_id: report.id,
      reseller_rental_id: rental.reseller_rental_id || null,
      current_mdn: sim.current_mdn_e164 || null,
      iccid: sim.iccid || null,                       // operator-facing → OK per §H.3.
      vendor,
      situation_id: classification && classification.mode || null,
      attempts: buildAttemptsTable(exec, classification, attemptNo),
      latest_vendor_state: (classification && classification.evidenceSummary && classification.evidenceSummary.situation_evidence) || null,
      latest_webhook: (evidence && evidence.webhook) || null,
      verify_state: {
        sent: !!(exec && exec.gateStatus && exec.gateStatus !== 'verify_send_failed'),
        received: !!(exec && exec.gateStatus === 'verify_received'),
      },
      suggested_next: suggestNextAction(failure_type),
    },
  };
}

function buildAttemptsTable(exec, classification, attemptNo) {
  const out = [];
  if (classification) {
    out.push({ action: classification.action, outcome: classification.outcome });
  }
  if (exec && exec.execStatus) {
    out.push({
      action: classification && classification.action,
      outcome: exec.outcome || exec.execStatus,
      vendor_request_id: exec.evidence && (exec.evidence.vendor_request_id || exec.evidence.requestId) || null,
    });
  }
  return out;
}

function suggestNextAction(failure_type) {
  switch (failure_type) {
    case 'helix_unsuspend_failed':         return 'Manually unsuspend in Helix portal, then re-run remediator.';
    case 'atomic_restore_failed':          return 'Manually run ATOMIC restoreSubscriber via dashboard, then re-run remediator.';
    case 'wing_w7_dialable_retry_failed':  return 'Manually swap Wing line to dialable plan; verify activation.';
    case 'teltik_reset_failed':            return 'Run /reset-network and /reset-port via Teltik dashboard.';
    case 'teltik_forward_url_misconfigured':return 'Re-set forward URL via Teltik /set-forward, then verify.';
    case 'imei_wrong_type':                return 'Verify gateway IMEI matches vendor device_type (router vs phone).';
    case 'imei_drift_vendor':              return 'Reconcile vendor IMEI with on-port IMEI; consider re-OTA.';
    case 'vendor_iccid_not_found':         return 'Confirm ICCID is provisioned at vendor; may require re-activation.';
    case 'vendor_active_no_sms':           return 'SIM is active at vendor but not receiving SMS — inspect gateway logs.';
    case 'vendor_cancelled_active_rental': return 'Active reseller rental exists; do NOT close. Investigate cancellation.';
    case 'verify_send_failed':             return 'Gateway /send-sms failed 3×; check gateway connectivity and port.';
    case 'verify_receive_timeout':         return 'No inbound nonce within 5 min; inspect inbound path / vendor SMS.';
    case 'unable_to_reproduce_recommendation': return 'Exhausted 3 classify-only ticks; operator decision needed.';
    default: return 'Operator review required.';
  }
}

// ---------------------------------------------------------
// INC-16d action dispatcher
//
// Decides whether to invoke a safe action executor based on the classification,
// runs the §C pre-resolve gate when a `remediated` close is in play, and
// returns the outcome the worker should record. Forbidden actions are NEVER
// executed; the worker records `classify_only` and escalates instead.
// ---------------------------------------------------------

async function maybeExecuteAction(env, args) {
  const { report, evidence, classification, attemptNo } = args;
  const action = classification.action;

  // No-op cases — classification carries the truth, no executor needed.
  if (!action || action === 'escalate') {
    return { outcome: classification.outcome, evidence: null, errorMessage: null };
  }

  // 24h cooldown gate (§G). canAttempt rejects when prior attempts for this
  // action are still inside the cooldown window OR the action's max-attempts
  // cap is reached. classify_only / close_duplicate / db_sync_upsert have
  // cooldownMs=0 so they always pass here; the vendor restore/refresh actions
  // (INC-16e) are the ones this actually gates.
  const priorActionAttempts = (evidence.priorActionAttempts && evidence.priorActionAttempts[action]) || 0;
  const lastActionAttemptAt = evidence.lastActionAttemptAt && evidence.lastActionAttemptAt[action] || null;
  const gate = canAttempt({ action, priorAttempts: priorActionAttempts, lastAttemptAt: lastActionAttemptAt, now: new Date() });
  if (!gate.ok) {
    return {
      outcome: 'skipped_cooldown',
      evidence: { cooldown_gate: gate, action, prior_attempts: priorActionAttempts },
      errorMessage: null,
      execStatus: 'cooldown_active',
    };
  }

  // For S1 the worker has already cleared §E cancel-guard.
  const ctx = {
    action,
    report,
    sim: evidence.sim,
    situationId: classification.mode,
    evidenceBundle: classification.evidenceSummary,
    attemptNo,
  };

  // Per-action ctx enrichment for the INC-16e vendor calls. The executors
  // also derive these from sim.* as fallback but passing them explicitly
  // documents the intent at the call site.
  if (action === 'db_sync_upsert') {
    ctx.targets = classification.targets || {};
  } else if (action === 'atomic_ota' || action === 'atomic_restore' || action === 'helix_unsuspend') {
    ctx.msisdn = (evidence.sim && evidence.sim.current_mdn_e164) || null;
    if (action !== 'atomic_restore') ctx.iccid = (evidence.sim && evidence.sim.iccid) || null;
  } else if (action === 'helix_ota') {
    ctx.msisdn = (evidence.sim && evidence.sim.current_mdn_e164) || null;
    ctx.iccid  = (evidence.sim && evidence.sim.iccid) || null;
    ctx.ban    = (evidence.sim && (evidence.sim.att_ban || evidence.sim.helix_ban)) || null;
    ctx.subscriberNumber = ctx.msisdn;
  } else if (action === 'wing_put_dialable') {
    ctx.iccid = (evidence.sim && evidence.sim.iccid) || null;
  } else if (action === 'teltik_reset_network' || action === 'teltik_reset_port') {
    ctx.mdn = (evidence.sim && evidence.sim.current_mdn_e164) || null;
  }

  const res = await executeAction(env, ctx);

  // close_duplicate is exempt from §C (per §C/§E). It's the only safe action
  // that writes a terminal `remediated`-shaped close (here: 'duplicate').
  if (action === 'close_duplicate') {
    if (res.ok) {
      return {
        outcome: 'duplicate',
        evidence: { exec_status: res.status, ...(res.evidence || {}) },
        errorMessage: null,
        terminalReport: res.terminalReport || null,
        execStatus: res.status,
      };
    }
    return {
      outcome: 'failed',
      evidence: { exec_status: res.status, ...(res.evidence || {}) },
      errorMessage: res.errorMessage || 'close_duplicate_failed',
      execStatus: res.status,
    };
  }

  // classify_only — record-only.
  if (action === 'classify_only') {
    return {
      outcome: classification.outcome || 'no_change',
      evidence: { exec_status: res.status, ...(res.evidence || {}) },
      errorMessage: null,
      execStatus: res.status,
    };
  }

  // db_sync_upsert / resend_online — both are pre-resolve actions whose
  // terminal close requires §C SMS verification. We run the executor first
  // (so a vendor-side change is in place) then invoke preResolveGate.
  //
  // Until vendor reads (INC-16e) wire in, vendorRead is null and the gate
  // returns predicate_failed → no `remediated` write. That's intentional:
  // the action is recorded, evidence is captured, and the next tick will
  // re-evaluate once vendor reads exist.
  if (!res.ok && res.status !== 'noop') {
    return {
      outcome: 'failed',
      evidence: { exec_status: res.status, ...(res.evidence || {}) },
      errorMessage: res.errorMessage || (action + '_failed'),
      execStatus: res.status,
    };
  }

  const resolveGate = await preResolveGate(env, {
    report,
    sim: evidence.sim,
    vendorRead: classification.vendorReadHealth || null,
    autoAction: { completed: true, error: null },
    webhookDelivered: !!(evidence.webhook && evidence.webhook.delivered),
    situationExtras: classification.situationExtras || null,
    attemptNo,
  });

  if (resolveGate.passed) {
    return {
      outcome: 'remediated',
      evidence: {
        exec_status: res.status,
        gate_status: resolveGate.status,
        ...(res.evidence || {}),
      },
      errorMessage: null,
      terminalReport: { status: 'remediated', remediation_action: 'other' },
      execStatus: res.status,
    };
  }

  // Gate not passed — keep the report in flight, no terminal write.
  return {
    outcome: resolveGate.status === 'verify_pending' ? 'verify_pending' : (classification.outcome || 'no_change'),
    evidence: {
      exec_status: res.status,
      gate_status: resolveGate.status,
      gate_reason: resolveGate.reason || null,
      ...(res.evidence || {}),
    },
    errorMessage: null,
    execStatus: res.status,
    gateStatus: resolveGate.status,
  };
}

function mergeEvidence(a, b) {
  if (!a && !b) return {};
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

// ---------------------------------------------------------
// Shared situations S1..S6.
//
// S1 already cancelled        — SIM is cancelled / retired in DB and §E says no active rental.
// S2 already replaced         — rental's sim_id != reported sim_id (operator already swapped).
// S3 duplicate                — newer open or closed report exists for same (sim_id|reseller_rental_id).
// S4 contract rejected        — no rental row or rental ended before report received_at.
// S5 gateway offline          — SkyLine port-status reports gateway/port offline (SIM is fine, hardware is down).
// S6 insufficient evidence    — vendor unknown or evidence too sparse to act.
//
// Anything that does not fire S1..S6 falls through to vendor classifier
// (added by INC-16b). Until that ships, we record `pending_vendor_classifier`
// and let the report sit for next tick.
// ---------------------------------------------------------

async function classifyShared(env, report, evidence) {
  // S2 — already replaced. rental.sim_id has moved on from report.sim_id.
  if (evidence.rental && evidence.rental.sim_id && report.sim_id
      && evidence.rental.sim_id !== report.sim_id) {
    return terminal('S2', 'close_duplicate', 'duplicate', {
      reason: 'sim_already_replaced',
      rental_id: report.rental_id,
      current_sim_id: evidence.rental.sim_id,
      reported_sim_id: report.sim_id,
    });
  }

  // S3 — duplicate of newer open report (same sim_id, status received|in_triage).
  if (evidence.newerOpenReportId) {
    return terminal('S3', 'close_duplicate', 'duplicate', {
      reason: 'newer_open_report',
      newer_report_id: evidence.newerOpenReportId,
    });
  }

  // S4 — contract rejected / no active rental row at the time of report.
  // INC-25 followup: distinguish a true "no rental row" from a DB lookup error.
  // Previously a non-ok rentals GET (e.g. column-name mismatch causing HTTP 400)
  // left evidence.rental=null and closed the report as duplicate. Escalate
  // instead so an operator sees the masked failure.
  if (!evidence.rental && evidence.rentalLookupError && report.rental_id) {
    return terminal('S6', 'escalate', 'escalate', {
      reason: 'evidence_lookup_failed',
      lookup: 'rental',
      rental_id: report.rental_id,
      http_status: evidence.rentalLookupError.http_status,
      body: evidence.rentalLookupError.body,
    }, 'evidence_lookup_failed');
  }
  if (!evidence.rental) {
    return terminal('S4', 'close_duplicate', 'duplicate', {
      reason: 'no_rental_row',
    });
  }

  // S1 — already cancelled / retired SIM. Uses §E cancel-guard.
  if (evidence.sim && simIsCancelledOrRetired(evidence.sim)) {
    const guard = await cancelGuardCheck(env, report, evidence);
    if (guard.activeRentalExists) {
      return terminal('S1', 'escalate', 'escalate', {
        reason: 'vendor_cancelled_active_rental',
        sim_status: evidence.sim.status || null,
        active_rental_evidence: guard.evidence,
      }, 'vendor_cancelled_active_rental');
    }
    return terminal('S1', 'close_duplicate', 'duplicate', {
      reason: 'sim_cancelled_no_active_rental',
      sim_status: evidence.sim.status || null,
      cancelled_at: evidence.sim.deactivated_at || evidence.sim.retired_at || null,
    });
  }

  // S5 — gateway/port offline. Only consider when we have a sim with port info.
  if (evidence.sim && evidence.gatewayOffline) {
    return nonTerminal('S5', 'classify_only', 'no_change', {
      reason: 'gateway_port_offline',
      gateway_id: evidence.sim.gateway_id || null,
      port: evidence.sim.port || null,
    });
  }

  // S6 — unknown vendor or evidence too sparse.
  if (!evidence.sim || !evidence.sim.vendor) {
    return terminal('S6', 'escalate', 'escalate', {
      reason: 'insufficient_evidence_no_vendor',
    }, 'insufficient_evidence');
  }
  const vendor = String(evidence.sim.vendor || '').toLowerCase();
  if (!['atomic', 'wing_iot', 'helix', 'teltik'].includes(vendor)) {
    return terminal('S6', 'escalate', 'escalate', {
      reason: 'insufficient_evidence_unknown_vendor',
      vendor,
    }, 'insufficient_evidence');
  }

  // Nothing shared fired — hand off to the vendor classifier (INC-16b).
  // Vendor read + IMEI check are wired in 16d/16e; for now we pass nulls so the
  // classifier returns the pending_vendor_read situation and the worker records
  // a classify_only attempt. Cooldown engine schedules the next review.
  const { classifyVendor } = await import('./classifier.mjs');
  const { nextReviewAt }   = await import('./cooldown.mjs');
  const situation = classifyVendor({
    sim: evidence.sim,
    vendorView: null,
    imeiCheck: null,
    webhook: { delivered: false },
    report,
    priorAttempts: evidence.priorAttempts || 0,
    cancelGuard: { activeRentalExists: false, evidence: {} },
    recentResellerBadSignal: false,
  });
  if (!situation) {
    return terminal('S6', 'escalate', 'escalate', {
      reason: 'insufficient_evidence_unknown_vendor',
      vendor,
    }, 'insufficient_evidence');
  }
  const nra = nextReviewAt({ action: situation.auto_action, now: new Date() });
  return {
    mode: situation.id,
    action: situation.auto_action,
    outcome: situation.auto_action === 'classify_only' ? 'no_change' : 'classify_only',
    evidenceSummary: { situation_id: situation.id, vendor, situation_evidence: situation.evidence_bundle },
    terminal: false,
    nextReviewAt: nra,
  };
}

// ---------------------------------------------------------
// §E pre-close cancel-guard.
//
// Before closing a cancelled-SIM situation as `duplicate`, confirm there is no
// active reseller rental referencing this SIM or reseller_rental_id. The
// reseller-facing identifier surface is locked to (reseller_rental_id, current MDN)
// per Plan §K — we do NOT expose ICCID here.
// ---------------------------------------------------------

async function cancelGuardCheck(env, report, evidence) {
  const out = { activeRentalExists: false, evidence: {} };
  // INC-25 followup: `rentals` has no started_at/ended_at columns, so we
  // can't filter for "open" rentals by lifecycle timestamp. Any existing
  // rental row referencing this sim_id / reseller_rental_id is treated as
  // potentially active — this is conservative (it errs toward escalation
  // rather than silent close-as-duplicate).
  if (report.sim_id) {
    const q = 'rentals?sim_id=eq.' + encodeURIComponent(report.sim_id)
      + '&select=id,reseller_rental_id,rental_date,minted_at&limit=5';
    const r = await supabaseGet(env, q);
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        out.activeRentalExists = true;
        out.evidence.open_rentals_by_sim_id = rows.map(x => ({
          rental_id: x.id, reseller_rental_id: x.reseller_rental_id,
          rental_date: x.rental_date, minted_at: x.minted_at,
        }));
      }
    }
  }
  const rid = evidence.rental && evidence.rental.reseller_rental_id;
  if (rid && report.reseller_id) {
    const q = 'rentals?reseller_id=eq.' + encodeURIComponent(report.reseller_id)
      + '&reseller_rental_id=eq.' + encodeURIComponent(rid)
      + '&select=id,sim_id,reseller_rental_id,rental_date,minted_at&limit=5';
    const r = await supabaseGet(env, q);
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        out.activeRentalExists = true;
        out.evidence.open_rentals_by_reseller_rental_id = rows;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------
// Evidence gathering — DB only, no vendor calls.
// ---------------------------------------------------------

async function gatherEvidence(env, report) {
  const evidence = {
    sim: null,
    rental: null,
    rentalEndedBeforeReport: false,
    rentalLookupError: null,
    newerOpenReportId: null,
    gatewayOffline: false,
    priorAttempts: 0,
  };

  if (report.sim_id) {
    const r = await supabaseGet(env,
      'sims?id=eq.' + encodeURIComponent(report.sim_id)
      + '&select=id,iccid,vendor,status,deactivated_at,retired_at,gateway_id,port,current_mdn_e164&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) evidence.sim = rows[0];
    }
  }
  if (report.rental_id) {
    // INC-25 followup: `rentals` has no started_at/ended_at columns
    // (schema: rental_date, minted_at). Selecting them returned HTTP 400 and the
    // swallowed error was being mis-classified as `no_rental_row` (false S4
    // duplicate). Capture lookup failures explicitly so classifyShared can
    // escalate instead of closing as duplicate.
    const r = await supabaseGet(env,
      'rentals?id=eq.' + encodeURIComponent(report.rental_id)
      + '&select=id,sim_id,reseller_id,reseller_rental_id,rental_date,minted_at&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        evidence.rental = rows[0];
      }
    } else {
      let body = '';
      try { body = await r.text(); } catch { body = ''; }
      evidence.rentalLookupError = {
        http_status: r.status,
        body: (body || '').slice(0, 240),
      };
      console.log('[Remediator] rental lookup failed for report ' + report.id
        + ' rental_id=' + report.rental_id + ' status=' + r.status + ' body=' + body.slice(0, 240));
    }
  }
  // Newer open report for same sim_id?
  if (report.sim_id) {
    const r = await supabaseGet(env,
      'rental_reports?sim_id=eq.' + encodeURIComponent(report.sim_id)
      + '&id=gt.' + encodeURIComponent(report.id)
      + '&status=in.(received,in_triage)'
      + '&select=id&order=id.desc&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) evidence.newerOpenReportId = rows[0].id;
    }
  }
  // Prior attempt count.
  const ar = await supabaseGet(env,
    'rental_report_remediation_attempts?report_id=eq.' + encodeURIComponent(report.id)
    + '&select=id&order=id.desc&limit=50');
  if (ar.ok) {
    const rows = await ar.json();
    if (Array.isArray(rows)) evidence.priorAttempts = rows.length;
  }
  // S5 gateway-offline probe (only if we have gateway+port).
  if (evidence.sim && evidence.sim.gateway_id && evidence.sim.port && env.SKYLINE_GATEWAY) {
    try {
      const portStatus = await skylinePortStatus(env, evidence.sim.gateway_id, evidence.sim.port);
      if (portStatus && portStatus.offline) evidence.gatewayOffline = true;
    } catch (err) {
      console.log('[Remediator] skyline probe failed for report ' + report.id + ': ' + err);
    }
  }
  return evidence;
}

function simIsCancelledOrRetired(sim) {
  const s = String(sim.status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'deactivated'
      || s === 'retired'   || s === 'terminated';
}

async function skylinePortStatus(env, gatewayId, port) {
  const req = new Request('https://skyline-gateway/port-status?gateway_id='
    + encodeURIComponent(gatewayId) + '&port=' + encodeURIComponent(port),
    { method: 'GET' });
  const resp = await env.SKYLINE_GATEWAY.fetch(req);
  if (!resp.ok) return { offline: false };
  const body = await resp.json().catch(() => ({}));
  // Treat any explicit offline / not-registered signal as offline; conservative.
  const state = String(body && (body.status || body.state) || '').toLowerCase();
  const offline = state.includes('offline') || state.includes('not_registered')
                || state === 'down' || body?.online === false;
  return { offline, raw: state || null };
}

// ---------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------

function terminal(mode, action, outcome, evidenceSummary, escalationReason) {
  return { mode, action, outcome, evidenceSummary, terminal: true, escalationReason: escalationReason || null };
}
function nonTerminal(mode, action, outcome, evidenceSummary) {
  return { mode, action, outcome, evidenceSummary, terminal: false };
}

// ---------------------------------------------------------
// DB writes
// ---------------------------------------------------------

async function claimReport(env, report) {
  // CAS: only claim if current auto_remediation_state is NULL or 'queued'.
  // PostgREST treats `is.null` for null match. We chain two filters with `or`.
  //
  // NOTE: `Prefer: return=representation` alone re-applies the WHERE filter
  // to the response body, so a PATCH that mutates the filter column (here
  // queued → in_progress) returns `[]` even when the row WAS updated. That
  // made claimReport report `skipped_not_claimed` while the row sat stuck
  // in `in_progress` — the exact symptom that drove INC-25. Use
  // `count=exact` + Content-Range instead; the count reflects the actual
  // affected-row count and is unaffected by the post-image filter quirk.
  const filter = '?id=eq.' + encodeURIComponent(report.id)
    + '&or=(auto_remediation_state.is.null,auto_remediation_state.eq.queued)';
  const patch = { auto_remediation_state: 'in_progress', last_auto_attempt_at: new Date().toISOString() };
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports' + filter, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env, false), Prefer: 'return=minimal, count=exact' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    console.log('[Remediator] claim PATCH failed for report ' + report.id + ': ' + resp.status);
    return false;
  }
  return parseAffectedCount(resp) === 1;
}

function parseAffectedCount(resp) {
  const cr = resp.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+|\*)$/);
  if (!m) return 0;
  if (m[1] === '*') return 0;
  return parseInt(m[1], 10) || 0;
}

async function applyClassificationState(env, report, classification, exec) {
  const patch = { last_auto_attempt_at: new Date().toISOString() };
  const execOk = exec && (exec.execStatus === 'ok' || exec.execStatus === 'noop');
  if (classification.terminal) {
    if (classification.outcome === 'escalate') {
      patch.auto_remediation_state = 'escalated';
      if (classification.escalationReason) patch.escalation_reason = classification.escalationReason;
    } else if (classification.outcome === 'duplicate') {
      // INC-16d: close_duplicate executor already wrote rental_reports.status
      // = 'duplicate' and inserted the rental_report_events row matching the
      // dashboard's manual-close shape. Just mirror auto_remediation_state.
      patch.auto_remediation_state = execOk ? 'done' : 'queued';
      if (exec && exec.execStatus && !execOk) {
        patch.escalation_reason = exec.execStatus;
      }
    } else {
      patch.auto_remediation_state = 'done';
    }
  } else if (exec && exec.gateStatus === 'verify_pending') {
    // §C is in flight — verify-runner already set state=verify_pending and
    // populated verify_pending_*. Do not stomp those columns.
    return;
  } else if (exec && exec.outcome === 'remediated') {
    patch.auto_remediation_state = 'done';
    // Mirror the dashboard write path. remediation_action='other' is the
    // conservative default — A1/A6 etc. can refine in INC-16e.
    patch.status = 'remediated';
    patch.remediation_action = exec.terminalReport && exec.terminalReport.remediation_action || 'other';
    patch.closed_at = patch.last_auto_attempt_at;
  } else {
    // Leave queued so next tick picks it up.
    patch.auto_remediation_state = 'queued';
  }
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.' + encodeURIComponent(report.id), {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    console.log('[Remediator] state PATCH failed for report ' + report.id + ': ' + resp.status);
    return;
  }
  // Mirror the dashboard's rental_report_events row for the auto-remediated
  // terminal close so the timeline matches a manual close.
  if (patch.status === 'remediated') {
    try {
      await fetch(env.SUPABASE_URL + '/rest/v1/rental_report_events', {
        method: 'POST',
        headers: supabaseHeaders(env, false),
        body: JSON.stringify({
          report_id: report.id,
          from_status: report.status || null,
          to_status: 'remediated',
          actor: 'auto-remediator',
          note: 'auto-remediator §C verified',
          evidence: {
            source: 'auto_remediator',
            mode: classification.mode,
            action: classification.action,
            exec_status: exec && exec.execStatus,
            gate_status: exec && exec.gateStatus,
          },
        }),
      });
    } catch (e) {
      console.log('[Remediator] remediated event log insert failed: ' + e);
    }
  }
}

async function insertAttempt(env, row) {
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_report_remediation_attempts', {
    method: 'POST',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.log('[Remediator] attempt insert failed for report ' + row.report_id + ': ' + resp.status + ' ' + txt);
  }
}

// INC-25: bulk-reset abandoned `in_progress` claims back to `queued` so the
// next tick can pick them up. PostgREST returns the affected rows when we ask
// for representation, which lets us report a precise stale_recovered count.
async function recoverStaleClaims(env, thresholdMs) {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  // `last_auto_attempt_at < cutoff` OR `last_auto_attempt_at is null`
  // (defensive: a row marked in_progress with no timestamp shouldn't exist,
  // but if it does we still want it released).
  const filter = '?auto_remediation_state=eq.in_progress'
    + '&or=(last_auto_attempt_at.lt.' + encodeURIComponent(cutoff) + ',last_auto_attempt_at.is.null)'
    + '&status=in.(received,in_triage)';
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports' + filter, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(env, true), Prefer: 'return=representation,count=exact' },
      body: JSON.stringify({ auto_remediation_state: 'queued' }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.log('[Remediator] recoverStaleClaims failed: ' + resp.status + ' ' + txt);
      return 0;
    }
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    console.log('[Remediator] recoverStaleClaims error: ' + err);
    return 0;
  }
}

// INC-25: best-effort reset of a single in_progress row back to queued when
// processReport throws after claim succeeded. CAS filter avoids stomping a
// verify_pending / operator_locked / escalated row that some other path set.
async function releaseClaimedToQueued(env, reportId) {
  const filter = '?id=eq.' + encodeURIComponent(reportId)
    + '&auto_remediation_state=eq.in_progress';
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports' + filter, {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify({ auto_remediation_state: 'queued' }),
  });
  if (!resp.ok) {
    console.log('[Remediator] releaseClaimedToQueued failed for ' + reportId + ': ' + resp.status);
  }
}

async function acquireTickLock(env) {
  if (!env.REMEDIATOR_KV) return true; // no KV → no lock, single-instance fallback
  try {
    const existing = await env.REMEDIATOR_KV.get(TICK_LOCK_KEY);
    if (existing) return false;
    await env.REMEDIATOR_KV.put(TICK_LOCK_KEY, new Date().toISOString(), { expirationTtl: TICK_LOCK_TTL_S });
    return true;
  } catch (err) {
    console.log('[Remediator] acquireTickLock error: ' + err);
    return true; // fail-open: prefer running a tick over silently stalling
  }
}

async function releaseTickLock(env) {
  if (!env.REMEDIATOR_KV) return;
  try { await env.REMEDIATOR_KV.delete(TICK_LOCK_KEY); }
  catch (err) { console.log('[Remediator] releaseTickLock error: ' + err); }
}

async function fetchOpenReports(env, limit) {
  // Skip paused / operator_locked / verify_pending / escalated / done — these
  // are not the worker's to touch this tick.
  const select = 'id,reseller_id,sim_id,sim_number_id,rental_id,e164,status,received_at,auto_remediation_state';
  const q = 'rental_reports?status=in.(received,in_triage)'
    + '&or=(auto_remediation_state.is.null,auto_remediation_state.eq.queued)'
    + '&select=' + encodeURIComponent(select)
    + '&order=received_at.asc&limit=' + limit;
  const r = await supabaseGet(env, q);
  if (!r.ok) {
    const txt = await r.text();
    console.log('[Remediator] fetchOpenReports failed: ' + r.status + ' ' + txt);
    return [];
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------
// Plumbing
// ---------------------------------------------------------

function hasSupabaseCredentials(env) {
  return !!(env && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function verifyPollDormancyReason(env) {
  if (!hasSupabaseCredentials(env)) return 'missing_credentials';
  if (!(await killSwitchEnabled(env))) return 'kill_switch_off';
  return null;
}

async function killSwitchEnabled(env) {
  if (!env.REMEDIATOR_KV) return false;
  try {
    const v = await env.REMEDIATOR_KV.get(KILL_SWITCH_KEY);
    return v === 'true' || v === '1';
  } catch (err) {
    console.log('[Remediator] kill-switch read failed: ' + err);
    return false;
  }
}

function supabaseHeaders(env, returnRep) {
  const h = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
  h.Prefer = returnRep ? 'return=representation' : 'return=minimal';
  return h;
}

async function supabaseGet(env, path) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
