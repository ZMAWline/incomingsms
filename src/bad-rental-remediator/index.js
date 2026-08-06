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
import { cleanRecheckPredicate } from './verify.mjs';
import { executeAction } from './actions.mjs';
import { canAttempt, gateRejection, summarizeAttempts } from './cooldown.mjs';
import { teltikPortStatus, readVendorView } from './vendor.mjs';
import { mdn10 } from './teltik.mjs';
import {
  flushEscalations, maybeOpenVendorBatchTickets, normalizeFailureType,
  fetchEscalationBacklog, drainQueuedEscalations, DRAIN_DEFAULT_LIMIT,
} from './escalations.mjs';
import { classifyExpiredReport } from './stale-classifier.mjs';
import { isTeltikHosted } from '../shared/gateway-host.mjs';
import { smsSendingEnabled, SMS_UNAVAILABLE_MESSAGE } from '../shared/sms-availability.mjs';
import { resolveTeltikKnownMdn } from '../shared/teltik-known-mdn.mjs';
import { recordHostingPortCheck, buildHostingPortCheckRow, normalizeHostPortState } from '../shared/hosting-port-status.mjs';
import {
  evaluateHealthyEvidence, proofWindow,
  HEALTHY_EVIDENCE_MODE, HEALTHY_EVIDENCE_ACTION, HEALTHY_EVIDENCE_OUTCOME, HEALTHY_EVIDENCE_REASON,
} from './healthy-evidence.mjs';

const KILL_SWITCH_KEY = 'bad_rental_remediator_enabled';
const LAST_MAIN_TICK_KEY = 'bad_rental_remediator_last_main_tick';
const LAST_VERIFY_POLL_KEY = 'bad_rental_remediator_last_verify_poll';
const ACTION_DISABLE_PREFIX = 'bad_rental_remediator_action_';
const ACTION_DISABLE_SUFFIX = '_disabled';
const TICK_BUDGET_MS = 55_000; // §G: 60s tick budget, leave headroom.
const CONCURRENCY = 5;         // §G concurrency cap.
const INTAKE_LIMIT = 50;       // real actionable runs per tick (vendor/action/escalation attempts).
// INC-27: the 50 budget must count only real runs. Non-actionable rows —
// skipped_cooldown gate bookkeeping, duplicate/expired/stale DB-only
// dismissals, lost claim races — are scanned past instead of consuming the
// budget; without this, 50 stale prior-day reports blocked a same-day
// actionable report behind them every tick. SCAN_CAP bounds total rows
// fetched per tick so a pathological queue (e.g. claim PATCHes all failing)
// can never loop forever.
const NON_ACTIONABLE_OUTCOMES = new Set(['skipped_not_claimed', 'skipped_cooldown', 'skipped_sms_unavailable', 'duplicate']);
const SCAN_CAP = 400;
const EXPIRED_OPEN_SWEEP_CAP = 1000;
// INC-26: a queued row touched within this window is skipped by intake. Rows
// held only by an action cooldown (1h..24h) were re-fetched every 5-minute
// tick, recording skipped_cooldown 50× and starving newer reports out of the
// LIMIT 50 window. rental_reports has no next_review_at column, so defer on
// last_auto_attempt_at (set on every processed row) instead — schema-free.
const INTAKE_DEFER_MS = 15 * 60 * 1000;
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
const ISSUE_TELTIK_GATEWAY_PORT_OFFLINE = 'Teltik gateway port offline';
// TH5: how long Teltik gets to re-register the port after /reset-port before
// the deferred recheck pass. NOT slept inside the tick — it drives the
// attempt's next_review_at and the intake-eligibility backdate so the next
// tick performs the recheck (env TELTIK_PORT_RECHECK_WAIT_MS overrides;
// tests set 0).
const TELTIK_PORT_RECHECK_WAIT_MS = 30_000;
// HE1 usage-proof lookback. We fetch inbound SMS well BEYOND the proof window
// on purpose: healthy-evidence.mjs needs to distinguish "no traffic at all"
// from "traffic, but stale / addressed to a retired number", and that
// distinction is what keeps a different-rental message from auto-resolving
// today's report.
const INBOUND_PROOF_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_PROOF_LIMIT = 25;
// §3 post-proof notification. number.online is a reseller SYNC signal, not a
// remediation: it may only be sent AFTER the HE1 gate has already proved the
// line healthy. Off unless explicitly enabled.
const HEALTHY_EVIDENCE_NOTIFY_KEYS = ['HEALTHY_EVIDENCE_NOTIFY_RESEND'];

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
    // Escalation delivery backlog. Counts only — line_items carry MDNs and
    // ICCIDs and never leave the worker through this route.
    if (url.pathname === '/escalations/backlog') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      return json({ ok: true, backlog: await fetchEscalationBacklog(env) }, 200);
    }
    // Out-of-band drain of rows postEscalation left queued. Dry-run unless
    // `confirm=1`, so the default answer to "what would this post?" costs
    // nothing and posts nothing.
    if (url.pathname === '/escalations/drain' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const confirm = url.searchParams.get('confirm') === '1';
      const limit = parseInt(url.searchParams.get('limit') || '', 10) || DRAIN_DEFAULT_LIMIT;
      const result = await drainQueuedEscalations(env, { limit, dryRun: !confirm });
      return json({ ok: result.ok !== false, result }, result.ok === false ? 503 : 200);
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
    //   - '*/15 * * * *' → main intake tick (S1..S6 + vendor classifier).
    //                      (2h → */5 on 2026-06-12, → */15 on 2026-08-06.
    //                      Tick lock + claim CAS make any frequency safe;
    //                      idle ticks are one indexed query.)
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
// Test-only surface (tests/bad-rental-remediator-lifecycle.test.mjs).
export { maybeExecuteAction, gatherEvidence, suggestNextAction };

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
  let expiredOpenDismissed = 0;
  let expiredOpenScanned = 0;
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

    // Product rule: any bad-rental report that is not from today's New York
    // business day should be dismissed, even if it previously landed in an
    // escalated/verify_pending state. These rows are unsafe to remediate because
    // MDNs/rentals may already belong to a new rental. Do this DB-only sweep
    // before normal intake so old escalations do not sit open forever.
    const expiredSweep = await sweepExpiredOpenReports(env, EXPIRED_OPEN_SWEEP_CAP);
    expiredOpenDismissed = expiredSweep.dismissed;
    expiredOpenScanned = expiredSweep.scanned;
    if (expiredOpenDismissed > 0) {
      processed += expiredOpenDismissed;
      outcomes.duplicate = (outcomes.duplicate || 0) + expiredOpenDismissed;
      console.log('[Remediator] dismissed ' + expiredOpenDismissed + ' expired open reports (scanned=' + expiredOpenScanned + ').');
    }

    // INC-27: keep fetching batches until 50 REAL runs, the queue drains, or
    // the scan cap / tick budget stops us. Every processed row leaves the
    // intake window (terminal status, deferred last_auto_attempt_at, or an
    // in_progress claim by another tick), so re-fetching skips it — and
    // SCAN_CAP still bounds the loop if a row somehow doesn't.
    intake:
    while (attempted < INTAKE_LIMIT && reportsFetched < SCAN_CAP) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) {
        console.log('[Remediator] tick budget exceeded; stopping at ' + processed + '.');
        break;
      }
      const batchSize = Math.min(INTAKE_LIMIT, SCAN_CAP - reportsFetched);
      const reports = await fetchOpenReports(env, batchSize);
      if (reports.length === 0) break;
      reportsFetched += reports.length;
      console.log('[Remediator] fetched ' + reports.length + ' open reports (scanned=' + reportsFetched + ').');

      for (const report of reports) {
        if (attempted >= INTAKE_LIMIT) break intake;
        if (Date.now() - startedAt > TICK_BUDGET_MS) {
          console.log('[Remediator] tick budget exceeded; stopping at ' + processed + '.');
          break intake;
        }
        // Process one row at a time so we never fire more than 50 real actions.
        // Concurrency is intentionally traded for a strict real-run cap; skipped
        // and duplicate rows are cheap DB bookkeeping and the scan cap bounds
        // the total pass.
        const res = await processReportSafe(env, report);
        processed++;
        if (res && res.outcome) {
          outcomes[res.outcome] = (outcomes[res.outcome] || 0) + 1;
          // Only real actionable runs consume the budget; dismissals and
          // skips are counted in processed/outcomes above.
          if (res.attemptInserted && !NON_ACTIONABLE_OUTCOMES.has(res.outcome)) attempted++;
        }
        if (res && res.escalationCandidate) escalationCandidates.push(res.escalationCandidate);
      }
      if (reports.length < batchSize) break; // queue drained
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

  // Escalation rows that never reached Paperclip stay `queued` forever. Read
  // the depth every tick (one exact count) so a stuck sink shows up in the
  // logs and in `/status` -> last_main_tick instead of accumulating silently.
  let escalationBacklog = null;
  try {
    escalationBacklog = await fetchEscalationBacklog(env, { detail: false });
    if (escalationBacklog && escalationBacklog.alert) {
      console.log('[Remediator] ESCALATION SINK BLOCKED: ' + escalationBacklog.total
        + ' undelivered operator_escalations; missing env '
        + (escalationBacklog.sink.missing_env || []).join(',')
        + ' — drain via POST /escalations/drain?confirm=1 once provisioned.');
    }
  } catch (err) {
    console.log('[Remediator] escalation backlog probe error: ' + err);
  }

  const ms = Date.now() - startedAt;
  const dormancy_reason = reportsFetched === 0 ? 'no_open_reports' : null;
  console.log('[Remediator] tick done in ' + ms + 'ms; processed=' + processed
    + ' attempted=' + attempted
    + ' stale_recovered=' + staleRecovered
    + ' expired_open_dismissed=' + expiredOpenDismissed
    + ' outcomes=' + JSON.stringify(outcomes)
    + ' escalations=' + JSON.stringify(escalationsResult)
    + ' vendor_batch=' + JSON.stringify(vendorBatch));
  const summary = {
    completed_at: new Date(Date.now()).toISOString(),
    processed,
    attempted,
    scanned: reportsFetched,
    expired_open_dismissed: expiredOpenDismissed,
    expired_open_scanned: expiredOpenScanned,
    stale_recovered: staleRecovered,
    outcomes,
    escalations: escalationsResult,
    escalation_backlog: escalationBacklog,
    vendorBatch,
    ms,
    dormancy_reason,
  };
  await recordLastTick(env, LAST_MAIN_TICK_KEY, summary);
  return {
    processed,
    attempted,
    scanned: reportsFetched,
    expired_open_dismissed: expiredOpenDismissed,
    expired_open_scanned: expiredOpenScanned,
    stale_recovered: staleRecovered,
    outcomes,
    escalations: escalationsResult,
    escalation_backlog: escalationBacklog,
    vendorBatch,
    ms,
  };
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
  const [lastMain, lastVerify, openCounts, actionDisables, escalationBacklog] = await Promise.all([
    readJsonKv(env, LAST_MAIN_TICK_KEY),
    readJsonKv(env, LAST_VERIFY_POLL_KEY),
    fetchOpenCounts(env),
    listDisabledActions(env),
    fetchEscalationBacklog(env).catch(err => ({ error: String(err).slice(0, 200) })),
  ]);
  return {
    kill_switch: enabled ? 'enabled' : 'disabled',
    last_main_tick: lastMain,
    last_verify_poll: lastVerify,
    open_counts: openCounts,
    action_disables: actionDisables,
    escalation_backlog: escalationBacklog,
    schedule: {
      main_cron: '*/15 * * * *',
      verify_poll_cron: '*/1 * * * *',
      intake_limit: INTAKE_LIMIT,
      scan_cap: SCAN_CAP,
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
  // Count with PostgREST exact counts instead of materializing rows. The old
  // implementation fetched rows and was capped by the API page limit, so an
  // operator could see `escalated: 1000` even when the real number was just
  // "at least 1000". Open counts should only include open report statuses.
  const out = { queued: 0, in_progress: 0, verify_pending: 0, operator_locked: 0, escalated: 0 };
  try {
    out.queued = await supabaseExactCount(env,
      'rental_reports?select=id&status=in.(received,in_triage)&or=(auto_remediation_state.is.null,auto_remediation_state.eq.queued)');
    for (const state of ['in_progress', 'verify_pending', 'operator_locked', 'escalated']) {
      out[state] = await supabaseExactCount(env,
        'rental_reports?select=id&status=in.(received,in_triage)&auto_remediation_state=eq.' + state);
    }
  } catch (err) {
    console.log('[Remediator] fetchOpenCounts failed: ' + err);
  }
  return out;
}

async function sweepExpiredOpenReports(env, limit) {
  const q = 'rental_reports?status=in.(received,in_triage)'
    + '&or=(auto_remediation_state.is.null,auto_remediation_state.in.(queued,in_progress,verify_pending,escalated))'
    + '&select=' + encodeURIComponent('id,reseller_id,sim_id,sim_number_id,rental_id,e164,status,received_at,auto_remediation_state')
    + '&order=received_at.asc&limit=' + Math.max(1, Math.min(limit || EXPIRED_OPEN_SWEEP_CAP, EXPIRED_OPEN_SWEEP_CAP));
  const r = await supabaseGet(env, q);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.log('[Remediator] sweepExpiredOpenReports fetch failed: ' + r.status + ' ' + txt);
    return { scanned: 0, dismissed: 0, failed: 0 };
  }
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return { scanned: 0, dismissed: 0, failed: 0 };
  let dismissed = 0;
  let failed = 0;
  for (const report of rows) {
    const expired = classifyExpiredReport(report, new Date());
    if (!expired) continue;
    const res = await dismissExpiredReport(env, report, expired);
    if (res && res.outcome === 'duplicate') dismissed++;
    else failed++;
  }
  return { scanned: rows.length, dismissed, failed };
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

  // Product rule (Zalmen, 2026-07-29): reports not from today (New York day)
  // are dismissed immediately — MDN rotated and a new rental started, so
  // vendor action against a prior-day report can hit the wrong line. Checked
  // BEFORE gatherEvidence so no vendor read/call ever fires for these.
  // Today's reports fall through untouched (S1..S7/TH5 safeguards intact).
  const expired = classifyExpiredReport(report, new Date());
  if (expired) {
    return dismissExpiredReport(env, report, expired);
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
    // Executor may schedule its own review (TH5 deferred port recheck ~30s);
    // classifier's action-cadence default otherwise.
    next_review_at: exec.nextReviewAt || classification.nextReviewAt || null,
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
// Prior-day (expired) report dismissal — DB-only, no vendor calls.
//
// Reuses the close_duplicate executor so rental_reports.status='duplicate',
// closed_at/triaged_at semantics and the rental_report_events row match the
// dashboard's manual close exactly; applyClassificationState then mirrors
// auto_remediation_state='done'. On executor failure the row requeues and the
// next tick retries — never escalates, never touches a vendor.
// ---------------------------------------------------------

const EXPIRED_DISMISS_NOTE = 'dismissed expired/stale bad-rental report because report is from a prior day and rental/MDN may have moved on';

async function dismissExpiredReport(env, report, classification) {
  // Light DB-only attempt count — gatherEvidence is skipped on this path.
  let attemptNo = 1;
  const ar = await supabaseGet(env,
    'rental_report_remediation_attempts?report_id=eq.' + encodeURIComponent(report.id)
    + '&select=id&limit=200');
  if (ar.ok) {
    const rows = await ar.json().catch(() => []);
    if (Array.isArray(rows)) attemptNo = rows.length + 1;
  }

  const res = await executeAction(env, {
    action: 'close_duplicate',
    report,
    situationId: classification.mode,
    evidenceBundle: classification.evidenceSummary,
    note: EXPIRED_DISMISS_NOTE,
  });
  const exec = res.ok
    ? { outcome: 'duplicate', execStatus: res.status, errorMessage: null,
        evidence: { exec_status: res.status, ...(res.evidence || {}) } }
    : { outcome: 'failed', execStatus: res.status,
        errorMessage: res.errorMessage || 'close_duplicate_failed',
        evidence: { exec_status: res.status, ...(res.evidence || {}) } };

  await insertAttempt(env, {
    report_id: report.id,
    attempt_no: attemptNo,
    mode: classification.mode,
    action: classification.action,
    outcome: exec.outcome,
    evidence: mergeEvidence(classification.evidenceSummary, exec.evidence),
    error_message: exec.errorMessage,
    next_review_at: null,
  });

  await applyClassificationState(env, report, classification, exec);

  return {
    outcome: exec.outcome,
    mode: classification.mode,
    attemptInserted: true,
    escalationCandidate: null,
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
  const execFailed = exec && (exec.outcome === 'failed' || exec.outcome === 'verify_pending' || exec.outcome === 'escalate');
  const verifyTerm = exec && (exec.gateStatus === 'verify_send_failed' || exec.gateStatus === 'verify_receive_timeout');
  if (!classifierEsc && !verifyTerm && !(execFailed && (classification.escalationReason || exec.escalationReason))) {
    return null;
  }
  const sim = evidence && evidence.sim || {};
  const rental = evidence && evidence.rental || {};
  const reason = (exec && exec.escalationReason)
    || (classification && classification.escalationReason)
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
    case 'teltik_gateway_port_offline':    return 'Port reset did not bring Teltik port online — check gateway hardware / SIM seating via Teltik dashboard using the Teltik-known MDN.';
    case 'vendor_read_failed':             return 'Vendor status read kept failing (creds/identifier/API). Fix the read (check ICCID/MDN/subscription id), then requeue.';
    case 'vendor_mdn_drift':               return 'Provider MDN differs from DB MDN — run the MDN adopt/resync flow (rotator), then requeue.';
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

// Map an exhausted action to a §H.3 failure type normalizeFailureType
// recognizes. classify_only exhaustion is the "we looked 3 times and cannot
// reproduce" terminal; vendor actions map to their *_failed buckets.
function maxAttemptsEscalationReason(action) {
  if (action === 'classify_only') return 'unable_to_reproduce_recommendation';
  if (action === 'wing_put_dialable') return 'wing_w7_dialable_retry_failed';
  return action + '_failed';
}

async function maybeExecuteAction(env, args) {
  const { report, evidence, classification, attemptNo } = args;
  const action = classification.action;

  // No-op cases — classification carries the truth, no executor needed.
  if (!action || action === 'escalate') {
    return { outcome: classification.outcome, evidence: null, errorMessage: null };
  }

  // TEMPORARY (2026-07-29): outbound SMS is globally off, so §C verification
  // can never pass for actions whose terminal close needs it (resend_online,
  // db_sync_upsert, OTA/restore/reset — everything routed through
  // preResolveGate). Checked BEFORE the executor and the cooldown gate:
  // firing the vendor action would burn its §G max-attempt/cooldown budget
  // with no way to verify, and a maxed action must not escalate when its only
  // remaining blocker is the SMS switch. Recorded as a non-terminal
  // skipped_sms_unavailable bookkeeping row (excluded from summarizeAttempts);
  // the report requeues and the intake deferral paces retries until SMS is
  // back. TH5 teltik_reset_port is exempt — its terminal proof is the
  // port-status recheck, not SMS. A remaining resend_online exemption for
  // Teltik-hosted SIMs is notification-only and must not be used for
  // no_sms_received diagnosis; classifyShared/classifyVendor route those bad
  // reports to classify_only diagnostics until SMS receipt is proved or fixed.
  const teltikHostPortOnline = !!(evidence.sim && isTeltikHosted(evidence.sim)
    && evidence.teltikHostPortStatus && evidence.teltikHostPortStatus.online === true);
  // HEALTHY_EVIDENCE_ACTION is exempt: its proof is an inbound SMS that ALREADY
  // arrived plus live provider/host reads. Sending an outbound nonce would add
  // nothing, and blocking the close on the outbound kill switch would strand
  // provably-healthy reports in the queue.
  const needsSmsVerify = action !== 'close_duplicate' && action !== 'classify_only'
    && action !== HEALTHY_EVIDENCE_ACTION
    && !(classification.mode === 'TH5' && action === 'teltik_reset_port')
    && !(action === 'resend_online' && teltikHostPortOnline);
  if (needsSmsVerify && !smsSendingEnabled(env)) {
    return {
      outcome: 'skipped_sms_unavailable',
      evidence: { gate_status: 'sms_unavailable', gate_reason: SMS_UNAVAILABLE_MESSAGE, skipped_action: action },
      errorMessage: null,
      execStatus: 'sms_unavailable',
      gateStatus: 'sms_unavailable',
    };
  }

  // §G cooldown gate. canAttempt rejects when prior attempts for this action
  // are still inside the cooldown window OR the action's max-attempts cap is
  // reached. INC-26: cooldown_active requeues (intake deferral keeps the row
  // out of the next few ticks); max_attempts_reached escalates — requeueing a
  // maxed action can never succeed and was starving the queue forever.
  const priorActionAttempts = (evidence.priorActionAttempts && evidence.priorActionAttempts[action]) || 0;
  const lastActionAttemptAt = evidence.lastActionAttemptAt && evidence.lastActionAttemptAt[action] || null;
  const gate = canAttempt({ action, priorAttempts: priorActionAttempts, lastAttemptAt: lastActionAttemptAt, now: new Date() });
  if (!gate.ok) {
    // Attempt-cap exhaustion is TERMINAL. Unlike cooldown_active (which
    // expires), max_attempts_reached never clears — recording it as
    // skipped_cooldown left the report bouncing queued → skipped forever
    // with no operator signal. Escalate instead.
    if (gate.reason === 'max_attempts_reached') {
      // pending_vendor_read exhaustion is NOT "unable to reproduce" — the
      // vendor read itself kept failing (bad identifier, creds, API outage).
      // Categorize it as vendor_read_failed so the operator fixes the read
      // instead of chasing a phantom line problem.
      const readFailed = classification.mode === 'pending_vendor_read'
        || !!(classification.evidenceSummary && classification.evidenceSummary.vendor_read_error);
      return {
        outcome: 'escalate',
        evidence: { cooldown_gate: gate, action, prior_attempts: priorActionAttempts },
        errorMessage: null,
        execStatus: 'max_attempts_reached',
        escalationReason: (action === 'classify_only' && readFailed)
          ? 'vendor_read_failed'
          : maxAttemptsEscalationReason(action),
      };
    }
    return gateRejection(gate, action, priorActionAttempts);
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
    // Atomic (resendOtaProfile/restoreSubscriber) and Helix want a 10-digit
    // MSISDN — NOT E.164. current_mdn_e164 is "+1XXXXXXXXXX"; passing it raw
    // yields statusCode 512 "Invalid MSISDN". mdn10() collapses it to 10 digits.
    ctx.msisdn = mdn10((evidence.sim && evidence.sim.current_mdn_e164) || '') || null;
    ctx.subscriberNumber = ctx.msisdn;
    if (action !== 'atomic_restore') ctx.iccid = (evidence.sim && evidence.sim.iccid) || null;
  } else if (action === 'helix_ota') {
    ctx.msisdn = mdn10((evidence.sim && evidence.sim.current_mdn_e164) || '') || null;
    ctx.iccid  = (evidence.sim && evidence.sim.iccid) || null;
    ctx.ban    = (evidence.sim && (evidence.sim.att_ban || evidence.sim.helix_ban)) || null;
    ctx.subscriberNumber = ctx.msisdn;
  } else if (action === 'wing_put_dialable') {
    ctx.iccid = (evidence.sim && evidence.sim.iccid) || null;
  } else if (action === 'teltik_reset_network' || action === 'teltik_reset_port') {
    // Teltik reset endpoints are keyed by the MDN Teltik knows the line by —
    // rotations don't sync back, so prefer the Teltik-known MDN over DB current.
    ctx.mdn = (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn)
      || (evidence.sim && evidence.sim.current_mdn_e164) || null;
  } else if (action === HEALTHY_EVIDENCE_ACTION) {
    // The executor re-checks that the gate actually passed before it writes.
    ctx.healthyEvidence = classification.healthyEvidence
      || (evidence.healthyEvidenceGate && evidence.healthyEvidenceGate.summary) || null;
  } else if (action === 'teltik_sync_iccid') {
    // T12 — the current ICCID the classifier resolved from the get-info-by-MDN read.
    ctx.newIccid = (evidence.vendorRead && evidence.vendorRead.view && evidence.vendorRead.view.iccid) || null;
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

  // HE1 — terminal healthy-evidence close. Handled here, ABOVE the Teltik-host
  // and §C gate branches: the proof is already complete, so neither a nonce
  // send nor another port read may gate it.
  if (action === HEALTHY_EVIDENCE_ACTION) {
    if (!res.ok) {
      return {
        outcome: 'failed',
        evidence: { exec_status: res.status, ...(res.evidence || {}), ...(classification.evidenceSummary || {}) },
        errorMessage: res.errorMessage || 'healthy_evidence_auto_resolve_failed',
        execStatus: res.status,
      };
    }
    // §3 — post-proof reseller notification ONLY. number.online is sent after
    // the close, never as first-line remediation, and a failed notification
    // never un-resolves a proven-healthy report.
    const notify = await maybeNotifyOnlineAfterProof(env, { report, evidence, classification, attemptNo });
    return {
      outcome: HEALTHY_EVIDENCE_OUTCOME,
      evidence: {
        exec_status: res.status,
        resolution: HEALTHY_EVIDENCE_OUTCOME,
        resolution_reason: HEALTHY_EVIDENCE_REASON,
        post_proof_notification: notify,
        ...(res.evidence || {}),
        ...(classification.evidenceSummary || {}),
      },
      errorMessage: null,
      terminalReport: res.terminalReport || { status: 'remediated', remediation_action: 'other' },
      execStatus: res.status,
    };
  }

  // classify_only — record-only.
  if (action === 'classify_only') {
    return {
      outcome: classification.outcome || 'no_change',
      evidence: { exec_status: res.status, ...(res.evidence || {}), ...(classification.evidenceSummary || {}) },
      errorMessage: null,
      execStatus: res.status,
    };
  }

  // TH5: physical Teltik gateway port is offline. This path is keyed by
  // gateway_host, so Atomic/Wing/etc. SIMs hosted on Teltik are included while
  // carrier-vendor classification remains separate. Teltik reset-port is keyed
  // by the Teltik-known 10-digit MDN (ctx.mdn above); the deferred post-reset
  // recheck re-reads /v1/port-status keyed by that same MDN next pass.
  if (classification.mode === 'TH5' && action === 'teltik_reset_port') {
    if (!res.ok && res.status !== 'noop' && res.status !== 'cached') {
      return {
        outcome: 'failed',
        evidence: { exec_status: res.status, issue_type: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE, ...(res.evidence || {}) },
        errorMessage: res.errorMessage || 'teltik_gateway_port_reset_failed',
        execStatus: res.status,
        escalationReason: 'teltik_gateway_port_offline',
        issueType: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE,
      };
    }
    // Teltik needs a beat to re-register the port after /reset-port — but
    // sleeping 30s here blocked the whole tick per report and blew the 55s
    // budget (live tail 2026-07-29 02:55: fetched 50, processed 12). Defer
    // the recheck instead: record the reset with recheck pending, stamp the
    // attempt's next_review_at ~30s out, and backdate the report's
    // last_auto_attempt_at (via intakeEligibleInMs) so fetchOpenReports
    // re-admits the row after the re-register window, not the full 15m
    // intake defer. The next eligible pass reads /v1/port-status fresh:
    // still offline → the classifier sees the prior reset attempt and
    // escalates teltik_gateway_port_offline without resetting again;
    // online → TH5 skips and TH2 records SMS receipt as still unverified.
    // A post-reset online port proves the reset worked, NOT that the
    // reseller has its number back — never close `remediated` off port
    // state alone.
    const recheckDelayMs = env.TELTIK_PORT_RECHECK_WAIT_MS !== undefined
      ? Number(env.TELTIK_PORT_RECHECK_WAIT_MS) : TELTIK_PORT_RECHECK_WAIT_MS;
    return {
      outcome: 'no_change',
      evidence: {
        exec_status: res.status,
        issue_type: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE,
        initial_port_status: evidence.teltikHostPortStatus || null,
        recheck: 'pending',
        recheck_delay_ms: recheckDelayMs,
        ...(res.evidence || {}),
      },
      errorMessage: null,
      terminalReport: null,
      execStatus: res.status,
      escalationReason: null,
      issueType: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE,
      nextReviewAt: new Date(Date.now() + recheckDelayMs).toISOString(),
      intakeEligibleInMs: recheckDelayMs,
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

  // Teltik-HOSTED lines (any service vendor — Atomic/Wing on Teltik included)
  // have no Skyline gateway port, so the §C Skyline nonce send is impossible;
  // routing them through preResolveGate produced false `verify_send_failed`
  // escalations (missing_gateway_or_port is an automation limitation, not a
  // line fault). Substitute proof per host reality: provider read healthy AND
  // webhook delivered AND live Teltik port-status ONLINE keyed by the
  // Teltik-known MDN. Port online is the host-side SMS-delivery predicate
  // (§C.4.5); anything short of that defers — never a terminal close, never a
  // verify_send_failed escalation.
  if (evidence.sim && isTeltikHosted(evidence.sim)) {
    const hostMdn = (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn)
      || (evidence.sim && evidence.sim.current_mdn_e164) || null;
    let recheck = null;
    if (hostMdn) {
      try { recheck = await teltikPortStatus(env, { mdn: hostMdn }); }
      catch (err) { recheck = { online: false, status: 0, error: String(err && err.message || err) }; }
      await recordHostPortRead(env, evidence.sim, hostMdn,
        (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn) ? evidence.teltikKnownMdn.source : 'db_current_mdn',
        recheck);
    }
    const readOk = !!(recheck && recheck.status >= 200 && recheck.status < 300);
    const portOnline = readOk && recheck.online === true;

    // For Teltik-hosted Atomic/Wing/etc. lines, the safe resend rule has
    // already required provider healthy + host port online before selecting
    // resend_online (TH2). A successful resend is therefore allowed even when
    // outbound §C SMS probes are disabled; it is still recorded as
    // acted_sms_unverified instead of terminal remediated because number.online
    // is a reseller notification, not proof of renter SMS receipt.
    if (action === 'resend_online' && portOnline) {
      return {
        outcome: 'acted_sms_unverified',
        evidence: {
          exec_status: res.status,
          gate_status: smsSendingEnabled(env) ? 'provider_and_teltik_host_healthy' : 'sms_unavailable',
          gate_reason: smsSendingEnabled(env) ? null : SMS_UNAVAILABLE_MESSAGE,
          safe_to_resend_online: true,
          provider_status: 'healthy',
          provider_vendor: evidence.sim.vendor || null,
          host_status: 'healthy',
          host_provider: 'teltik',
          webhook_delivered_before_resend: !!(evidence.webhook && evidence.webhook.delivered),
          teltik_host_mdn: hostMdn,
          teltik_host_port_status: recheck || null,
          ...(classification.evidenceSummary || {}),
          ...(res.evidence || {}),
        },
        errorMessage: null,
        execStatus: res.status,
        gateStatus: smsSendingEnabled(env) ? 'provider_and_teltik_host_healthy' : 'sms_unavailable',
      };
    }

    const probe = cleanRecheckPredicate({
      vendorRead: classification.vendorReadHealth || null,
      autoAction: { completed: true, error: null },
      webhookDelivered: !!(evidence.webhook && evidence.webhook.delivered),
      smsReceived: portOnline,
      situationExtras: { requirePortOnline: true, portOnline },
    });
    // Not proven yet — defer (queued + next_review_at), keep the evidence of
    // exactly which predicate failed. A failed port READ is recorded as a read
    // failure, never treated as port offline.
    return {
      outcome: classification.outcome || 'no_change',
      evidence: {
        exec_status: res.status,
        gate_status: 'teltik_host_gate_deferred',
        gate_reason: probe.reason || null,
        teltik_host_mdn: hostMdn,
        teltik_host_port_status: recheck || null,
        ...(res.evidence || {}),
      },
      errorMessage: null,
      execStatus: res.status,
      gateStatus: 'teltik_host_gate_deferred',
    };
  }

  const resolveGate = await preResolveGate(env, {
    report,
    sim: evidence.sim,
    vendorRead: classification.vendorReadHealth || null,
    autoAction: { completed: true, error: null },
    // For resend_online the resend IS the webhook delivery attempt, so a
    // successful executor run satisfies §C.4's webhook predicate — pre-action
    // evidence necessarily saw no delivery (that's why A6 fired). Without this
    // the gate dies at predicate_failed and the exempted resend records
    // classify_only instead of acted_sms_unverified.
    webhookDelivered: (action === 'resend_online' && res.ok)
      || !!(evidence.webhook && evidence.webhook.delivered),
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
  // sms_unavailable HERE means the action DID run (we're past the executor)
  // but §C can't confirm it while outbound SMS is off — distinct from the
  // pre-exec skipped_sms_unavailable (nothing ran; budget-exempt bookkeeping).
  // acted_sms_unverified is NOT budget-exempt: the exempted resend_online must
  // consume its §G attempts or it would re-fire every eligible tick.
  return {
    outcome: resolveGate.status === 'verify_pending' ? 'verify_pending'
           : resolveGate.status === 'sms_unavailable' ? 'acted_sms_unverified'
           : (classification.outcome || 'no_change'),
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

// §3 — optional post-proof `number.online` resend.
//
// Deliberately NOT remediation: it runs only after the HE1 gate has already
// closed the report, so it can never be the system's first response to a bad
// report. Default OFF; enable with env HEALTHY_EVIDENCE_NOTIFY_RESEND=true (or
// the same-named KV key). Any failure is recorded and swallowed.
function healthyEvidenceNotifyEnabled(env) {
  for (const key of HEALTHY_EVIDENCE_NOTIFY_KEYS) {
    const v = env && env[key];
    if (v === true || v === 'true' || v === '1') return true;
  }
  return false;
}

async function maybeNotifyOnlineAfterProof(env, { report, evidence, classification, attemptNo }) {
  if (!healthyEvidenceNotifyEnabled(env)) {
    return { sent: false, skipped: 'disabled', reason: 'post_proof_notification_disabled' };
  }
  try {
    const res = await executeAction(env, {
      action: 'resend_online',
      report,
      sim: evidence.sim,
      situationId: HEALTHY_EVIDENCE_MODE,
      evidenceBundle: classification.evidenceSummary,
      attemptNo,
    });
    return {
      sent: !!res.ok,
      skipped: null,
      status: res.status || null,
      error: res.ok ? null : (res.errorMessage || 'resend_online_failed'),
      note: 'post_proof_notification_only',
    };
  } catch (err) {
    return { sent: false, skipped: null, status: 'error', error: String(err && err.message || err) };
  }
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

// Wrapper: run the situation ladder, then attach the HE1 verdict to whatever
// classification came back. Every attempt row for a report that reached the
// gate therefore carries WHICH evidence class was missing — so a report that
// escalates says "host unknown" or "no inbound proof" instead of leaving the
// operator to guess why it was not auto-resolved (§4).
async function classifyShared(env, report, evidence) {
  const verdict = await classifySharedLadder(env, report, evidence);
  const gate = evidence && evidence.healthyEvidenceGate;
  if (!verdict || !gate || verdict.mode === HEALTHY_EVIDENCE_MODE) return verdict;
  return {
    ...verdict,
    evidenceSummary: { ...(verdict.evidenceSummary || {}), healthy_evidence: gate.summary },
  };
}

async function classifySharedLadder(env, report, evidence) {
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

  // INC-25 Phase B: stale-context / lookup-error decisions BEFORE S1/S4/S6.
  // Catches the four cases the prior code conflated into S4 `no_rental_row`:
  //   - rentals DB lookup errored (HTTP 400, etc.)
  //   - sims DB lookup errored
  //   - report attached to a historical sim_number with current MDN mismatch
  //     (old rental complaint, close as duplicate, NO vendor action)
  //   - report attached to a historical sim_number but report.e164 == current
  //     SIM MDN (stale intake mapping, escalate, NO vendor action).
  const { classifyStaleContext } = await import('./stale-classifier.mjs');
  const staleVerdict = classifyStaleContext({ report, evidence });
  if (staleVerdict) return staleVerdict;

  // S4 — contract rejected / no active rental row at the time of report.
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

  // HE1 — HEALTHY EVIDENCE GATE (healthy-but-noisy reports).
  //
  // Runs AFTER the wrong-context dismissals (S2/S3/S7-stale/S4/S1 — a report
  // about a replaced, duplicated, historical or cancelled line is not "noisy",
  // it is misaddressed) and BEFORE every escalation or vendor write below.
  // That ordering is the whole point: nothing unsafe fires at a line we can
  // prove is working.
  //
  // All three evidence classes must hold — provider Active, host port ONLINE
  // (Teltik-known MDN when gateway_host='teltik'), and an inbound SMS inside
  // this report's/rental's window on a canonical number for this SIM. Any
  // missing or unknown layer falls through untouched: the ladder below then
  // classifies it precisely (TH5 port offline, TH2 pending host read, vendor
  // A*/W*/H*/T* situations), with the gate's own reason attached by the
  // wrapper above.
  const healthy = evaluateHealthyEvidence({ report, evidence, now: new Date() });
  evidence.healthyEvidenceGate = healthy;
  if (healthy.passed) {
    return {
      ...terminal(HEALTHY_EVIDENCE_MODE, HEALTHY_EVIDENCE_ACTION, HEALTHY_EVIDENCE_OUTCOME, {
        situation_id: HEALTHY_EVIDENCE_MODE,
        reason: HEALTHY_EVIDENCE_REASON,
        resolution_reason: HEALTHY_EVIDENCE_REASON,
        vendor: (evidence.sim && evidence.sim.vendor) || null,
        gateway_host: (evidence.sim && evidence.sim.gateway_host) || null,
        healthy_evidence: healthy.summary,
      }),
      healthyEvidence: healthy.summary,
    };
  }

  // TH5 — Teltik gateway-host port offline. This intentionally routes by
  // physical host, not service-provider vendor: an Atomic rental can be hosted
  // by Teltik and still needs Teltik reset-port. The reset key is the
  // TELTIK-KNOWN MDN (latest Teltik inbound SMS destination, falling back to
  // the SIM's current MDN) — never the reported/stale rental e164 or ICCID.
  if (evidence.sim && isTeltikHosted(evidence.sim) && evidence.teltikHostPortStatus) {
    const ps = evidence.teltikHostPortStatus;
    const statusOk = ps.status >= 200 && ps.status < 300;
    // Provider-first (Zalmen 2026-07-29, report #6817): when a clean carrier
    // read says the line is NOT active (suspended/cancelled/not found), the
    // vendor classifier owns the report (A3/A4/A5...) — a dead line explains
    // the outage better than the host port and a Teltik reset can't fix it.
    // Port-offline wins only with provider-active evidence, or when no usable
    // read exists. Teltik-vendor SIMs are exempt from this gate: their
    // `healthy` already folds in this same port state.
    const vr = evidence.vendorRead;
    const providerNotActive = String(evidence.sim.vendor || '').toLowerCase() !== 'teltik'
      && !!(vr && vr.ok === true && vr.healthy === false);
    if (statusOk && ps.online === false && !providerNotActive) {
      // Deferred TH5 recheck pass: a prior counted teltik_reset_port attempt
      // on this (same-day) report means the reset already fired and the port
      // is STILL offline after the re-register window — escalate to an
      // operator without burning another reset. Bookkeeping rows
      // (skipped_cooldown/skipped_sms_unavailable) are already excluded by
      // summarizeAttempts, and a failed reset escalated on its own tick.
      const priorResets = (evidence.priorActionAttempts && evidence.priorActionAttempts.teltik_reset_port) || 0;
      if (priorResets > 0) {
        return terminal('TH5', 'escalate', 'escalate', {
          reason: 'teltik_gateway_port_offline_after_reset',
          issue_type: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE,
          gateway_host: evidence.sim.gateway_host || null,
          vendor: evidence.sim.vendor || null,
          port_status: ps.raw || 'offline',
          prior_reset_attempts: priorResets,
          last_reset_at: (evidence.lastActionAttemptAt && evidence.lastActionAttemptAt.teltik_reset_port) || null,
        }, 'teltik_gateway_port_offline', ISSUE_TELTIK_GATEWAY_PORT_OFFLINE);
      }
      const resetMdn = (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn)
        || evidence.sim.current_mdn_e164 || '';
      return nonTerminal('TH5', 'teltik_reset_port', 'classify_only', {
        reason: 'teltik_gateway_port_offline',
        issue_type: ISSUE_TELTIK_GATEWAY_PORT_OFFLINE,
        gateway_host: evidence.sim.gateway_host || null,
        vendor: evidence.sim.vendor || null,
        current_mdn: evidence.sim.current_mdn_e164 || null,
        teltik_known_mdn: evidence.teltikKnownMdn || null,
        reset_mdn10: mdn10(resetMdn),
        port_status: ps.raw || 'offline',
        provider_active: (vr && vr.ok === true) ? !!vr.healthy : null,
      }, 'teltik_gateway_port_offline', ISSUE_TELTIK_GATEWAY_PORT_OFFLINE);
    }
  }

  // TH2 — non-Teltik-provider SIM hosted on a Teltik/Celtic gateway, provider
  // active. The HOST path owns assessment BEFORE the vendor classifier: stale
  // webhook-delivered evidence otherwise routes A1 atomic_ota. Zalmen's
  // 2026-07-30 rule: for bad-rental reports, `number.online` is allowed only
  // after BOTH sides are proven healthy — provider/carrier read OK and host
  // port online. This branch is exactly that proof for Atomic/Wing/Helix lines
  // physically hosted on Teltik: keep provider identity separate, use the
  // Teltik-known host MDN for the Teltik port read, and then resend the online
  // webhook as a reseller sync/notification. No usable port read → defer
  // nonterminal (pending_teltik_host_port_read) so the next tick retries — never
  // atomic_ota/resend on an unknown host port. Port offline is TH5 above;
  // provider not active is the vendor classifier's (A3/A4/...).
  if (evidence.sim && isTeltikHosted(evidence.sim)
      && String(evidence.sim.vendor || '').toLowerCase() !== 'teltik'
      && evidence.vendorRead && evidence.vendorRead.ok === true
      && evidence.vendorRead.healthy === true) {
    const ps = evidence.teltikHostPortStatus;
    const portReadOk = !!(ps && ps.status >= 200 && ps.status < 300);
    if (portReadOk && ps.online === true) {
      const { nextReviewAt } = await import('./cooldown.mjs');
      const hostMdn = (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn)
        || evidence.sim.current_mdn_e164 || null;
      return {
        ...nonTerminal('TH2', 'resend_online', 'no_change', {
          reason: 'provider_and_host_healthy_resend_online_safe',
          safe_to_resend_online: true,
          provider_status: 'healthy',
          provider_vendor: evidence.sim.vendor || null,
          provider_read: evidence.vendorRead.view || null,
          host_status: 'healthy',
          host_provider: 'teltik',
          gateway_host: evidence.sim.gateway_host || null,
          teltik_host_mdn: hostMdn,
          teltik_known_mdn: evidence.teltikKnownMdn || null,
          port_status: ps.raw || 'online',
          webhook_delivered_before_resend: !!(evidence.webhook && evidence.webhook.delivered),
        }),
        nextReviewAt: nextReviewAt({ action: 'resend_online', now: new Date() }),
        vendorReadHealth: { healthy: true },
        situationExtras: evidence.vendorRead.extras || null,
      };
    }
    if (!portReadOk) {
      return nonTerminal('TH2', 'classify_only', 'no_change', {
        reason: 'pending_teltik_host_port_read',
        pending_reason: 'pending_teltik_host_port_read',
        gateway_host: evidence.sim.gateway_host || null,
        vendor: evidence.sim.vendor || null,
        port_read: ps || null,
      });
    }
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
  // INC-16d/16e completion: the live vendor read (evidence.vendorRead, built by
  // readVendorView in gatherEvidence) is now passed in. When the read failed,
  // vendorRead.ok is false and we pass vendorView=null so the classifier defers
  // (pending_vendor_read / classify_only) instead of acting on a bad read.
  // imeiCheck stays null for now (classifier tolerates null — every IMEI branch
  // is guarded); the IMEI signal is a separate follow-up.
  const { classifyVendor, buildDbSyncTargets } = await import('./classifier.mjs');
  const { nextReviewAt }   = await import('./cooldown.mjs');
  const vr = evidence.vendorRead;
  const vendorView = (vr && vr.ok) ? vr.view : null;
  // The report itself is a fresh reseller "bad" signal, so the A1/W3/H3/T3
  // "active + webhook delivered, still reported bad → OTA/reset" branches apply.
  const cancelGuard = await cancelGuardCheck(env, report, evidence);
  const situation = classifyVendor({
    sim: evidence.sim,
    vendorView,
    imeiCheck: null,
    webhook: { delivered: !!(evidence.webhook && evidence.webhook.delivered) },
    report,
    // Classifier's priorAttempts drives the classify_only exhaustion branches
    // (A10 etc.) — feed it real classify_only attempts, not the total row
    // count, which skipped_cooldown bookkeeping rows inflate (INC-26).
    priorAttempts: (evidence.priorActionAttempts && evidence.priorActionAttempts.classify_only) || 0,
    cancelGuard,
    recentResellerBadSignal: true,
  });
  if (!situation) {
    return terminal('S6', 'escalate', 'escalate', {
      reason: 'insufficient_evidence_unknown_vendor',
      vendor,
    }, 'insufficient_evidence');
  }
  const nra = nextReviewAt({ action: situation.auto_action, now: new Date() });
  const isEscalate = situation.auto_action === 'escalate';
  const isDuplicate = situation.auto_action === 'close_duplicate';
  // db_sync_upsert was a permanent noop: nothing ever populated
  // classification.targets, so "vendor active / DB stale" reports verified and
  // closed while sims stayed stale. buildDbSyncTargets derives the concrete
  // patch from the live vendor read.
  let targets = null;
  if (situation.auto_action === 'db_sync_upsert') {
    // targets: buildDbSyncTargets(situation, evidence.sim, vendorView)
    targets = buildDbSyncTargets(situation, evidence.sim, vendorView);
    // A9/W6/H7 — vendor MDN differs from DB. Adopting the vendor MDN needs
    // the rotation bookkeeping (sim_numbers close+insert, reseller webhook) —
    // out of the remediator's safe-write set. A bare sims.msisdn patch would
    // half-sync state, so pure MDN drift escalates with both MDNs instead.
    if (targets && targets.msisdn && !targets.status) {
      const eb = situation.evidence_bundle || {};
      return terminal(situation.id, 'escalate', 'escalate', {
        situation_id: situation.id, vendor,
        reason: 'vendor_mdn_drift',
        db_mdn: eb.db_mdn || null,
        vendor_mdn: eb.vendor_mdn || null,
      }, 'vendor_mdn_drift');
    }
  }
  return {
    mode: situation.id,
    action: situation.auto_action,
    targets,
    outcome: isEscalate ? 'escalate'
           : isDuplicate ? 'duplicate'
           : situation.auto_action === 'classify_only' ? 'no_change' : 'classify_only',
    evidenceSummary: {
      situation_id: situation.id, vendor, situation_evidence: situation.evidence_bundle,
      vendor_read_error: (vr && vr.ok !== true) ? (vr.error || 'read_failed') : null,
    },
    terminal: isEscalate || isDuplicate,
    escalationReason: situation.escalation_reason || null,
    nextReviewAt: nra,
    // §C post-action gate inputs (consumed by maybeExecuteAction → preResolveGate).
    // vendorReadHealth must reflect a clean live read; situationExtras carries
    // teltik's requirePortOnline predicate.
    vendorReadHealth: (vr && vr.ok) ? { healthy: !!vr.healthy } : null,
    situationExtras: (vr && vr.extras) || null,
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
    simLookupError: null,
    simNumber: null,
    currentSimNumberE164: null,
    teltikHostPortStatus: null,
    newerOpenReportId: null,
    gatewayOffline: false,
    priorAttempts: 0,
    priorActionAttempts: {},   // per-action count — drives the §G cooldown gate
    lastActionAttemptAt: {},    // per-action latest attempted_at (ISO)
    webhook: { delivered: false, lastDeliveredAt: null },
    vendorRead: null,           // { ok, view, healthy, extras, raw } from readVendorView
    teltikKnownMdn: null,       // { mdn, source, received_at } — shared Teltik-known MDN resolver
    teltikHostPortMdn: null,    // the MDN the host port read was actually keyed by
    teltikHostPortMdnSource: null,
    inboundProof: null,         // { ok, rows, error } — HE1 usage-proof candidates
    healthyEvidenceGate: null,  // evaluateHealthyEvidence() verdict (set in classifyShared)
  };

  if (report.sim_id) {
    // INC-25 Phase A: `sims` has no `deactivated_at`/`retired_at`/`current_mdn_e164`
    // columns (schema: msisdn, status, activated_at, ...). Selecting them
    // returned HTTP 400 silently, leaving evidence.sim=null and falsely
    // escalating reports as `insufficient_evidence_no_vendor`. Synthesize
    // `current_mdn_e164` from `msisdn` (US national → +1XXXXXXXXXX) so
    // downstream code that reads `sim.current_mdn_e164` continues to work
    // without a coordinated cross-worker rewrite.
    const r = await supabaseGet(env,
      'sims?id=eq.' + encodeURIComponent(report.sim_id)
      + '&select=id,iccid,vendor,gateway_host,status,msisdn,activated_at,gateway_id,port,imei,att_ban,mobility_subscription_id&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const s = rows[0];
        s.current_mdn_e164 = s.msisdn ? msisdnToE164(s.msisdn) : null;
        evidence.sim = s;
      }
    } else {
      let body = '';
      try { body = await r.text(); } catch { body = ''; }
      evidence.simLookupError = {
        http_status: r.status,
        body: (body || '').slice(0, 240),
      };
      console.log('[Remediator] sim lookup failed for report ' + report.id
        + ' sim_id=' + report.sim_id + ' status=' + r.status + ' body=' + body.slice(0, 240));
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
  // INC-25 Phase A: sim_number context. Lets the classifier distinguish a
  // historical attachment (sim_number.valid_to set) from a current one, and
  // know what the SIM's current MDN is so we can compare against report.e164.
  if (report.sim_number_id) {
    const r = await supabaseGet(env,
      'sim_numbers?id=eq.' + encodeURIComponent(report.sim_number_id)
      + '&select=id,sim_id,e164,valid_from,valid_to&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        evidence.simNumber = {
          id: rows[0].id,
          sim_id: rows[0].sim_id,
          e164: rows[0].e164,
          valid_from: rows[0].valid_from,
          valid_to: rows[0].valid_to,
          isHistorical: rows[0].valid_to != null,
        };
      }
    }
  }
  if (report.sim_id) {
    const r = await supabaseGet(env,
      'sim_numbers?sim_id=eq.' + encodeURIComponent(report.sim_id)
      + '&valid_to=is.null&select=e164&order=valid_from.desc&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) evidence.currentSimNumberE164 = rows[0].e164;
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
  // Prior attempts — count overall AND per-action with last-attempt time. The
  // per-action maps drive the §G cooldown gate in maybeExecuteAction; without
  // them the gate always sees 0 attempts and would re-fire live vendor actions
  // every tick (carrier spam). `action` holds the action token (e.g.
  // 'atomic_restore'); `attempted_at` is the timestamp.
  // Guard marker: select=id,action,attempted_at,outcome
  // INC-26: summarizeAttempts excludes `skipped_cooldown` rows from the
  // per-action maps — those rows are gate bookkeeping, and counting them
  // refreshed the cooldown window every tick (never expiring) and burned the
  // max-attempts budget without any vendor call.
  const ar = await supabaseGet(env,
    'rental_report_remediation_attempts?report_id=eq.' + encodeURIComponent(report.id)
    + '&select=id,action,outcome,attempted_at&order=id.desc&limit=200');
  if (ar.ok) {
    const rows = await ar.json();
    if (Array.isArray(rows)) {
      // Operator requeue marker (dashboard "Requeue" on a false escalation):
      // rows are newest-first, so cutting at the marker excludes every attempt
      // made BEFORE the requeue from the per-action caps. Without this, a
      // report escalated by a since-fixed automation bug would re-escalate on
      // its first re-run via max_attempts_reached instead of getting a fresh
      // attempt budget. attempt_no keeps counting all rows.
      const requeueIdx = rows.findIndex(r => r && r.action === 'operator_requeue');
      const sum = summarizeAttempts(requeueIdx >= 0 ? rows.slice(0, requeueIdx) : rows);
      evidence.priorAttempts = rows.length;
      evidence.priorActionAttempts = sum.perAction;
      evidence.lastActionAttemptAt = sum.lastAt;
    }
  }
  // Webhook delivery signal (§C.4.3 + classifier A6/W2/H2/T2). Has a recent
  // delivered number.online webhook gone out for this SIM? Used both to route
  // (webhook missing → resend_online) and as a §C pre-resolve predicate.
  if (report.sim_id) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const wr = await supabaseGet(env,
      'webhook_deliveries?select=delivered_at'
      + '&sim_id=eq.' + encodeURIComponent(report.sim_id)
      + '&event_type=eq.number.online&status=eq.delivered'
      + '&delivered_at=gte.' + encodeURIComponent(since)
      + '&order=delivered_at.desc&limit=1');
    if (wr.ok) {
      const rows = await wr.json();
      if (Array.isArray(rows) && rows.length > 0) {
        evidence.webhook = { delivered: true, lastDeliveredAt: rows[0].delivered_at || null };
      }
    }
  }
  // Teltik-known MDN — the MDN the Teltik side still knows this line by.
  // Rotations don't sync back to Teltik, so any Teltik per-line call
  // (/v1/get-info, /v1/reset-port, /v1/reset-network) keyed by the DB current
  // MDN can 404/miss. Use the shared resolver for every Teltik per-line call:
  // latest raw Teltik inbound payload MDN → read-only Teltik inventory lookup
  // → DB current MDN as explicit final fallback. Needed for teltik-vendor SIMs
  // and for any SIM physically seated in a Teltik gateway (e.g. Atomic-in-Teltik).
  if (evidence.sim && (String(evidence.sim.vendor || '').toLowerCase() === 'teltik' || isTeltikHosted(evidence.sim))) {
    try {
      evidence.teltikKnownMdn = await resolveTeltikKnownMdn(env, {
        id: evidence.sim.id,
        iccid: evidence.sim.iccid,
        current_mdn_e164: evidence.sim.current_mdn_e164,
      });
    } catch (err) {
      console.log('[Remediator] teltik-known-mdn lookup failed for report ' + report.id + ': ' + err);
      evidence.teltikKnownMdn = null;
    }
  }
  // Live vendor status read — the input the classifier needs to choose a real
  // remediation action. On any failure readVendorView returns { ok:false } and
  // the classifier defers (pending_vendor_read) instead of acting on bad data.
  if (evidence.sim && evidence.sim.vendor) {
    try {
      evidence.vendorRead = await readVendorView(env, evidence.sim, {
        teltikKnownMdn: evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn || null,
      });
    } catch (err) {
      evidence.vendorRead = { ok: false, error: String(err && err.message || err) };
    }
    if (evidence.vendorRead && evidence.vendorRead.ok !== true) {
      console.log('[Remediator] vendor read not ok for report ' + report.id
        + ' vendor=' + evidence.sim.vendor + ' error=' + (evidence.vendorRead.error || 'unknown'));
    }
  }
  // Teltik-hosted port read is independent from carrier vendor read. Atomic or
  // Wing service-provider SIMs hosted by Teltik still need this host-level
  // status check and reset path. /v1/port-status is keyed by the Teltik-known
  // 10-digit MDN (same as get-info/reset-port — BRR #6938: without mdn Teltik
  // returns HTTP 400 "Please provide mdn parameter"). No usable MDN → the
  // wrapper returns status:0 (unusable read) and TH2 defers
  // pending_teltik_host_port_read.
  if (evidence.sim && isTeltikHosted(evidence.sim)) {
    const hostReadMdn = (evidence.teltikKnownMdn && evidence.teltikKnownMdn.mdn)
      || evidence.sim.current_mdn_e164 || null;
    const hostReadMdnSource = evidence.teltikKnownMdn
      ? evidence.teltikKnownMdn.source
      : (evidence.sim.current_mdn_e164 ? 'db_current_mdn' : null);
    try {
      evidence.teltikHostPortStatus = await teltikPortStatus(env, { mdn: hostReadMdn });
    } catch (err) {
      evidence.teltikHostPortStatus = { online: false, status: 0, error: String(err && err.message || err) };
    }
    // Stamp the provenance of THIS read. The HE1 host gate refuses to treat a
    // port read as proof unless it was keyed by the Teltik-known MDN and taken
    // recently — without these two fields it cannot tell correct-MDN evidence
    // from a read against a number Teltik may no longer associate with the line.
    if (evidence.teltikHostPortStatus && typeof evidence.teltikHostPortStatus === 'object') {
      evidence.teltikHostPortStatus.checked_at = new Date().toISOString();
    }
    evidence.teltikHostPortMdn = hostReadMdn;
    evidence.teltikHostPortMdnSource = hostReadMdnSource;
    await recordHostPortRead(env, evidence.sim, hostReadMdn, hostReadMdnSource, evidence.teltikHostPortStatus);
  }
  // HE1 usage proof — recent inbound SMS for THIS SIM. DB-only, one indexed
  // query. Matching/window logic lives in healthy-evidence.mjs (pure); this
  // just supplies candidates plus an explicit read-failure marker, because
  // "the read failed" must never be mistaken for "the line received nothing".
  if (report.sim_id) {
    const window = proofWindow({ report, rental: evidence.rental, now: new Date() });
    const anchorMs = window ? window.endMs : Date.now();
    const since = new Date(anchorMs - INBOUND_PROOF_LOOKBACK_MS).toISOString();
    // Upper-bound the read at the window end. `order=received_at.desc` +
    // limit returns the NEWEST rows, so on a busy SIM whose report is being
    // worked late (requeue, backlog) an unbounded read hands the gate 25
    // messages that all postdate the window and the real in-window proof is
    // never even fetched — the report then reads as "no proof" and escalates.
    // Bounding at the window end keeps the ability to see stale traffic BELOW
    // the window (the `inbound_sms_outside_report_window` signal) while making
    // sure in-window rows are always in the candidate set.
    const until = new Date(anchorMs).toISOString();
    try {
      const r = await supabaseGet(env,
        'inbound_sms?sim_id=eq.' + encodeURIComponent(report.sim_id)
        + '&received_at=gte.' + encodeURIComponent(since)
        + '&received_at=lte.' + encodeURIComponent(until)
        + '&select=id,sim_id,to_number,from_number,received_at,port'
        + '&order=received_at.desc&limit=' + INBOUND_PROOF_LIMIT);
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        evidence.inboundProof = { ok: true, rows: Array.isArray(rows) ? rows : [], error: null };
      } else {
        let body = '';
        try { body = await r.text(); } catch { body = ''; }
        evidence.inboundProof = { ok: false, rows: [], error: 'inbound_sms_http_' + r.status + ':' + body.slice(0, 120) };
      }
    } catch (err) {
      evidence.inboundProof = { ok: false, rows: [], error: String(err && err.message || err) };
    }
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

// INC-25 Phase A: convert US national msisdn ("3073845304") to e164
// ("+13073845304"). Returns null for empty/non-conforming input.
function msisdnToE164(msisdn) {
  if (msisdn == null) return null;
  const s = String(msisdn).trim().replace(/[^\d]/g, '');
  if (!s) return null;
  if (s.length === 10) return '+1' + s;
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return s.startsWith('+') ? s : null;
}

// Record a Teltik host port read into the canonical hosting_port_status_checks
// history (task t_a71decd6). ps is teltikPortStatus()'s return; a status:0
// unusable read records as error, never offline. Never throws.
async function recordHostPortRead(env, sim, mdn, mdnSource, ps) {
  if (!sim || !ps) return;
  await recordHostingPortCheck(env, buildHostingPortCheckRow({
    sim_id: sim.id || null,
    iccid: sim.iccid || null,
    vendor: sim.vendor || null,
    gateway_host: sim.gateway_host || 'teltik',
    mdn: mdn ? mdn10(mdn) || mdn : null,
    mdn_source: mdnSource || null,
    source: 'bad_rental_remediator',
    http_status: ps.status || null,
    state: normalizeHostPortState(ps.status, ps.body),
    raw: ps.body || null,
    error: ps.error || (ps.status && (ps.status < 200 || ps.status >= 300) ? 'teltik_port_status_http_' + ps.status : null),
  }));
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

function terminal(mode, action, outcome, evidenceSummary, escalationReason, issueType) {
  return { mode, action, outcome, evidenceSummary, terminal: true, escalationReason: escalationReason || null, issueType: issueType || null };
}
function nonTerminal(mode, action, outcome, evidenceSummary, escalationReason, issueType) {
  return { mode, action, outcome, evidenceSummary, terminal: false, escalationReason: escalationReason || null, issueType: issueType || null };
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
  const issueType = (exec && exec.issueType) || classification.issueType || null;
  if (issueType) patch.issue_type = issueType;
  // Default for every terminal/escalated branch; the queued branches override
  // with a real defer-until timestamp.
  patch.next_review_at = null;
  // INC-26: an executor-level escalate (incl. max_attempts_reached from the
  // gate) wins over the classification shape — checked first so a terminal
  // `duplicate` classification whose close_duplicate is maxed out escalates
  // instead of silently requeueing forever.
  if (exec && exec.outcome === 'escalate') {
    patch.auto_remediation_state = 'escalated';
    patch.escalation_reason = exec.escalationReason || classification.escalationReason || 'operator_review_required';
  } else if (classification.terminal) {
    if (classification.outcome === 'escalate') {
      patch.auto_remediation_state = 'escalated';
      if (classification.escalationReason) patch.escalation_reason = classification.escalationReason;
    } else if (classification.outcome === HEALTHY_EVIDENCE_OUTCOME) {
      // The executor already wrote status='remediated' + closed_at and the
      // audit event (mirroring close_duplicate). Only the auto state is ours.
      // A failed close requeues so the gate re-proves from fresh reads.
      patch.auto_remediation_state = execOk ? 'done' : 'queued';
      if (exec && exec.execStatus && !execOk) {
        patch.escalation_reason = exec.execStatus;
        patch.next_review_at = computeNextReviewAt(classification, exec, patch.last_auto_attempt_at);
      }
    } else if (classification.outcome === 'duplicate') {
      // INC-16d: close_duplicate executor already wrote rental_reports.status
      // = 'duplicate' and inserted the rental_report_events row matching the
      // dashboard's manual-close shape. Just mirror auto_remediation_state.
      patch.auto_remediation_state = execOk ? 'done' : 'queued';
      if (exec && exec.execStatus && !execOk) {
        patch.escalation_reason = exec.execStatus;
        patch.next_review_at = computeNextReviewAt(classification, exec, patch.last_auto_attempt_at);
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
  } else if (exec && exec.outcome === 'escalate') {
    patch.auto_remediation_state = 'escalated';
    patch.escalation_reason = exec.escalationReason || classification.escalationReason || 'operator_review_required';
  } else {
    // Leave queued so a later tick picks it up — parked until next_review_at
    // so the intake cron doesn't rescan rows that cannot progress yet.
    patch.auto_remediation_state = 'queued';
    patch.next_review_at = computeNextReviewAt(classification, exec, patch.last_auto_attempt_at);
    // Executor asked for an earlier re-run (TH5 deferred port recheck).
    // Pre-migration deployments have no next_review_at column (the 400-retry
    // below strips it), so also shorten the effective INTAKE_DEFER_MS deferral
    // by backdating last_auto_attempt_at: eligible again in intakeEligibleInMs.
    if (exec && Number.isFinite(exec.intakeEligibleInMs)) {
      patch.last_auto_attempt_at =
        new Date(Date.now() - INTAKE_DEFER_MS + exec.intakeEligibleInMs).toISOString();
    }
  }
  let resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.' + encodeURIComponent(report.id), {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(patch),
  });
  if (!resp.ok && resp.status === 400 && 'next_review_at' in patch) {
    // Migration 20260729 not applied yet — retry without the column rather
    // than leaving the row stuck in in_progress.
    const { next_review_at: _nr, ...legacy } = patch;
    resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.' + encodeURIComponent(report.id), {
      method: 'PATCH',
      headers: supabaseHeaders(env, false),
      body: JSON.stringify(legacy),
    });
  }
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

// When must a queued (non-terminal) report be looked at again?
//   - action inside its cooldown → the gate's precise nextEligibleAt;
//   - executor failed → 15 min (the next look converts it to a terminal
//     escalate via max_attempts, so don't sit on it for the action's 24h);
//   - Teltik-host gate deferred (action done, proof pending) → 15 min;
//   - otherwise the classification's own cadence (2h classify_only / 1h-24h
//     vendor actions), defaulting to 2h.
function computeNextReviewAt(classification, exec, nowIsoStr) {
  const nowMs = Date.parse(nowIsoStr || '') || Date.now();
  const gate = exec && exec.evidence && exec.evidence.cooldown_gate;
  if (exec && exec.execStatus === 'cooldown_active' && gate && gate.nextEligibleAt) {
    return gate.nextEligibleAt;
  }
  if (exec && (exec.outcome === 'failed' || exec.gateStatus === 'teltik_host_gate_deferred')) {
    return new Date(nowMs + 15 * 60 * 1000).toISOString();
  }
  // Executor-requested earlier re-run (TH5 deferred port recheck).
  if (exec && exec.nextReviewAt) return exec.nextReviewAt;
  if (classification && classification.nextReviewAt) return classification.nextReviewAt;
  return new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
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
  //
  // next_review_at gate: non-terminal outcomes park the row until its
  // next_review_at. Without this, rows inside a 2h/24h cooldown were
  // re-fetched every 5-min tick, burning the 50-row intake budget on
  // skipped_cooldown bookkeeping and starving reports 51+ forever.
  //
  // INC-26 starvation fix, two parts:
  //   1. Defer rows touched within INTAKE_DEFER_MS (last_auto_attempt_at is
  //      stamped on every processed row) so a cooldown-held row can't consume
  //      an intake slot every tick while ineligible.
  //   2. Order by last_auto_attempt_at nullsfirst so never-tried reports beat
  //      least-recently-tried ones even when the eligible backlog exceeds
  //      LIMIT — received_at asc alone let the oldest 50 rows starve the rest.
  const cutoff = new Date(Date.now() - INTAKE_DEFER_MS).toISOString();
  const select = 'id,reseller_id,sim_id,sim_number_id,rental_id,e164,reason_code,attempts,status,received_at,auto_remediation_state';
  const nowIso = encodeURIComponent(new Date().toISOString());
  const q = 'rental_reports?status=in.(received,in_triage)'
    + '&and=(or(auto_remediation_state.is.null,auto_remediation_state.eq.queued)'
    +   ',or(next_review_at.is.null,next_review_at.lte.' + nowIso + ')'
    +   ',or(last_auto_attempt_at.is.null,last_auto_attempt_at.lt.' + encodeURIComponent(cutoff) + '))'
    + '&select=' + encodeURIComponent(select)
    + '&order=last_auto_attempt_at.asc.nullsfirst,received_at.asc&limit=' + limit;
  let r = await supabaseGet(env, q);
  if (!r.ok && r.status === 400) {
    // Migration 20260729 (next_review_at) not applied yet — fall back to the
    // legacy query instead of going dormant on a column trap (INC-25 class).
    console.log('[Remediator] fetchOpenReports 400 (next_review_at missing?); using legacy query.');
    const legacy = 'rental_reports?status=in.(received,in_triage)'
      + '&and=(or(auto_remediation_state.is.null,auto_remediation_state.eq.queued)'
      +   ',or(last_auto_attempt_at.is.null,last_auto_attempt_at.lt.' + encodeURIComponent(cutoff) + '))'
      + '&select=' + encodeURIComponent(select)
      + '&order=last_auto_attempt_at.asc.nullsfirst,received_at.asc&limit=' + limit;
    r = await supabaseGet(env, legacy);
  }
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
    headers: { apikey: env['SUPABASE_SERVICE_ROLE_KEY'], Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
  });
}

async function supabaseExactCount(env, path) {
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: env['SUPABASE_SERVICE_ROLE_KEY'],
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  if (!resp.ok) return 0;
  const cr = resp.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+|\*)$/);
  if (!m || m[1] === '*') return 0;
  return parseInt(m[1], 10) || 0;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
