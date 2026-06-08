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

const KILL_SWITCH_KEY = 'bad_rental_remediator_enabled';
const TICK_BUDGET_MS = 55_000; // §G: 60s tick budget, leave headroom.
const CONCURRENCY = 5;         // §G concurrency cap.
const INTAKE_LIMIT = 50;       // upper bound per tick.

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
    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'bad-rental-remediator' }, 200);
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env).catch(err => {
      console.log('[Remediator] scheduled error: ' + err);
    }));
  },
};

// ---------------------------------------------------------
// Top-level tick
// ---------------------------------------------------------

async function runTick(env) {
  const startedAt = Date.now();
  if (!(await killSwitchEnabled(env))) {
    console.log('[Remediator] kill-switch disabled; skipping tick.');
    return { skipped: 'kill_switch_off', processed: 0 };
  }
  const reports = await fetchOpenReports(env, INTAKE_LIMIT);
  console.log('[Remediator] fetched ' + reports.length + ' open reports.');

  let processed = 0, attempted = 0;
  const outcomes = {};

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
    }
  }
  const ms = Date.now() - startedAt;
  console.log('[Remediator] tick done in ' + ms + 'ms; processed=' + processed + ' outcomes=' + JSON.stringify(outcomes));
  return { processed, attempted, outcomes, ms };
}

async function processReportSafe(env, report) {
  try {
    return await processReport(env, report);
  } catch (err) {
    console.log('[Remediator] report ' + report.id + ' error: ' + err);
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
  await insertAttempt(env, {
    report_id: report.id,
    attempt_no: attemptNo,
    mode: classification.mode,
    action: classification.action,
    outcome: classification.outcome,
    evidence: classification.evidenceSummary || {},
    error_message: classification.errorMessage || null,
    next_review_at: classification.nextReviewAt || null,
  });

  // Update report-level auto state per classification.
  await applyClassificationState(env, report, classification);

  return {
    outcome: classification.outcome,
    mode: classification.mode,
    attemptInserted: true,
  };
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
  if (!evidence.rental) {
    return terminal('S4', 'close_duplicate', 'duplicate', {
      reason: 'no_rental_row',
    });
  }
  if (evidence.rentalEndedBeforeReport) {
    return terminal('S4', 'close_duplicate', 'duplicate', {
      reason: 'rental_ended_before_report',
      ended_at: evidence.rental.ended_at || null,
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

  // Nothing shared fired — vendor classifier (INC-16b) will own this on the
  // next tick. Record a no_change and leave the report queued.
  return nonTerminal('pending_vendor_classifier', 'classify_only', 'no_change', {
    reason: 'awaiting_vendor_classifier',
    vendor,
  });
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
  // (a) Any open rental referencing this sim_id.
  if (report.sim_id) {
    const q = 'rentals?sim_id=eq.' + encodeURIComponent(report.sim_id)
      + '&or=(ended_at.is.null,ended_at.gt.now())'
      + '&select=id,reseller_rental_id,started_at,ended_at&limit=5';
    const r = await supabaseGet(env, q);
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        out.activeRentalExists = true;
        out.evidence.open_rentals_by_sim_id = rows.map(x => ({
          rental_id: x.id, reseller_rental_id: x.reseller_rental_id,
          started_at: x.started_at, ended_at: x.ended_at,
        }));
      }
    }
  }
  // (b) Any open rental referencing this reseller_rental_id (same reseller).
  const rid = evidence.rental && evidence.rental.reseller_rental_id;
  if (rid && report.reseller_id) {
    const q = 'rentals?reseller_id=eq.' + encodeURIComponent(report.reseller_id)
      + '&reseller_rental_id=eq.' + encodeURIComponent(rid)
      + '&or=(ended_at.is.null,ended_at.gt.now())'
      + '&select=id,sim_id,reseller_rental_id,ended_at&limit=5';
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
    const r = await supabaseGet(env,
      'rentals?id=eq.' + encodeURIComponent(report.rental_id)
      + '&select=id,sim_id,reseller_id,reseller_rental_id,started_at,ended_at&limit=1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        evidence.rental = rows[0];
        if (rows[0].ended_at && report.received_at
            && new Date(rows[0].ended_at).getTime() < new Date(report.received_at).getTime()) {
          evidence.rentalEndedBeforeReport = true;
        }
      }
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
  const filter = '?id=eq.' + encodeURIComponent(report.id)
    + '&or=(auto_remediation_state.is.null,auto_remediation_state.eq.queued)';
  const patch = { auto_remediation_state: 'in_progress', last_auto_attempt_at: new Date().toISOString() };
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports' + filter, {
    method: 'PATCH',
    headers: supabaseHeaders(env, true),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    console.log('[Remediator] claim PATCH failed for report ' + report.id + ': ' + resp.status);
    return false;
  }
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows.length === 1;
}

async function applyClassificationState(env, report, classification) {
  const patch = { last_auto_attempt_at: new Date().toISOString() };
  if (classification.terminal) {
    if (classification.outcome === 'escalate') {
      patch.auto_remediation_state = 'escalated';
      if (classification.escalationReason) patch.escalation_reason = classification.escalationReason;
    } else if (classification.outcome === 'duplicate') {
      // Mark report as remediated/duplicate via the existing dashboard write path?
      // Per §D, the worker uses the existing status write path. For this scaffold
      // we mark the auto state and let the dashboard mirror the report status
      // when the worker calls the update endpoint. Until INC-16d wires the
      // status write, leave rental_reports.status untouched and only set
      // auto_remediation_state='done'. The attempt row preserves the decision.
      patch.auto_remediation_state = 'done';
    } else {
      patch.auto_remediation_state = 'done';
    }
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
