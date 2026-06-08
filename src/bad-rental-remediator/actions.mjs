// =========================================================
// BAD-RENTAL REMEDIATOR — Safe vendor action executors (INC-20 / INC-16d).
//
// Scope per Plan v4 §F + §H.1 + the INC-20 issue:
//   - db_sync_upsert  → A2, A7, A9, W1, W6, H1, H7, T1, T8.
//   - resend_online   → A6, W2, H2, T2 (calls reseller-sync /resend-online).
//   - close_duplicate → S1, S2, S3 (rental_reports → status='duplicate'
//                       via the same write shape as /api/bad-rentals/:id/update).
//   - classify_only   → A10, W9, H9, T11 (record-only; cooldown handles cadence).
//
// Every executor returns:
//   { ok, status, evidence?, errorMessage?, terminalReport? }
//
// - `ok` is true iff the side-effect succeeded.
// - `status` is one of:
//     'ok' | 'disabled_by_kv' | 'unsupported_action' | 'bad_input' |
//     'service_binding_missing' | 'vendor_error' | 'db_error' | 'noop'
// - `terminalReport` (when set) carries { status, remediation_action?, duplicate_of? }
//   which the worker mirrors into rental_reports so the dashboard timeline
//   matches a manual close. Currently only `close_duplicate` sets this.
//
// §C SMS verification is NOT performed inside an executor. The worker invokes
// `preResolveGate` (verify-runner.mjs) around `db_sync_upsert` / `resend_online`
// before any `status='remediated'` close. `close_duplicate` is exempt per §C/§E.
//
// Per-action KV emergency disable: a key
//   `bad_rental_remediator_action_${action}_disabled`
// set to "true" / "1" short-circuits the executor with status='disabled_by_kv'.
// =========================================================

import { ALLOWED_ACTIONS, FORBIDDEN_ACTIONS } from './classifier.mjs';

export const SAFE_ACTIONS = Object.freeze([
  'db_sync_upsert',
  'resend_online',
  'close_duplicate',
  'classify_only',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_ACTIONS);

// ---------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------

export async function executeAction(env, ctx) {
  const action = ctx && ctx.action;
  if (!action) return { ok: false, status: 'bad_input', errorMessage: 'missing action' };
  if (FORBIDDEN_SET.has(action)) {
    // Defence in depth — classifier never emits these, but if a bug routes one
    // here we refuse and surface it so the caller can escalate.
    return { ok: false, status: 'unsupported_action', errorMessage: 'forbidden_action:' + action };
  }
  if (!SAFE_ACTIONS.includes(action)) {
    return { ok: false, status: 'unsupported_action', errorMessage: action };
  }
  if (!ALLOWED_ACTIONS.includes(action)) {
    // Belt + suspenders. Keeps the action vocabulary in lockstep with §H.1.
    return { ok: false, status: 'unsupported_action', errorMessage: 'not_in_allowed_actions:' + action };
  }
  if (await actionDisabledByKv(env, action)) {
    return { ok: false, status: 'disabled_by_kv', errorMessage: 'kv_emergency_disable' };
  }
  switch (action) {
    case 'db_sync_upsert':  return execDbSyncUpsert(env, ctx);
    case 'resend_online':   return execResendOnline(env, ctx);
    case 'close_duplicate': return execCloseDuplicate(env, ctx);
    case 'classify_only':   return execClassifyOnly(env, ctx);
    default:                return { ok: false, status: 'unsupported_action' };
  }
}

export function actionKvKey(action) {
  return 'bad_rental_remediator_action_' + action + '_disabled';
}

export async function actionDisabledByKv(env, action) {
  if (!env || !env.REMEDIATOR_KV) return false;
  try {
    const v = await env.REMEDIATOR_KV.get(actionKvKey(action));
    return v === 'true' || v === '1';
  } catch (err) {
    console.log('[Actions] KV read failed for ' + action + ': ' + err);
    return false;
  }
}

// ---------------------------------------------------------
// db_sync_upsert — write SIM truth from vendor read.
//
// ctx.targets is the subset of (status, current_mdn_e164, imei) the worker
// wants to sync. Idempotent at (sim_id): an upsert that would change nothing
// returns status='noop' so the attempt row records the deliberate skip.
// ---------------------------------------------------------

async function execDbSyncUpsert(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const targets = ctx.targets || {};
  const patch = {};
  if (targets.status            && targets.status            !== sim.status)            patch.status = targets.status;
  if (targets.current_mdn_e164  && targets.current_mdn_e164  !== sim.current_mdn_e164)  patch.current_mdn_e164 = targets.current_mdn_e164;
  if (targets.imei              && targets.imei              !== sim.imei)              patch.imei = targets.imei;

  if (Object.keys(patch).length === 0) {
    return { ok: true, status: 'noop', evidence: { reason: 'db_already_matches_vendor', sim_id: sim.id } };
  }

  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + encodeURIComponent(sim.id), {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { ok: false, status: 'db_error', errorMessage: 'sims_patch_' + resp.status + ':' + txt };
  }
  return {
    ok: true, status: 'ok',
    evidence: { sim_id: sim.id, patch, prior: pick(sim, ['status','current_mdn_e164','imei']) },
  };
}

// ---------------------------------------------------------
// resend_online — call reseller-sync /resend-online (force:true, salted).
//
// The endpoint already passes force:true and salts the message_id with the
// current ms timestamp (see resendOneSim in src/reseller-sync/index.js), so
// `(report_id, sim_id, attempt_no)` ordering at the cooldown layer combined
// with the timestamp salt is the per-attempt idempotency surface called out
// in Plan §G. Source is `portal_resync` (the only auto-allowed token today).
// ---------------------------------------------------------

async function execResendOnline(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  if (!env.RESELLER_SYNC) {
    return { ok: false, status: 'service_binding_missing', errorMessage: 'RESELLER_SYNC binding' };
  }
  const req = new Request('https://reseller-sync/resend-online', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-caller': 'reseller-portal' },
    body: JSON.stringify({ simId: Number(sim.id), source: 'portal_resync' }),
  });
  let resp, text, body;
  try {
    resp = await env.RESELLER_SYNC.fetch(req);
    text = await resp.text();
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  } catch (err) {
    return { ok: false, status: 'vendor_error', errorMessage: String(err && err.message || err) };
  }
  if (!resp.ok) {
    return {
      ok: false, status: 'vendor_error',
      errorMessage: 'resend_online_status_' + resp.status,
      evidence: { http_status: resp.status, body },
    };
  }
  return {
    ok: !!body.ok, status: body.ok ? 'ok' : 'vendor_error',
    errorMessage: body.ok ? null : (body.error || 'resend_online_not_ok'),
    evidence: {
      sim_id: sim.id,
      http_status: resp.status,
      vendor_response: { ok: body.ok, status: body.status, attempts: body.attempts },
    },
  };
}

// ---------------------------------------------------------
// close_duplicate — terminal close mirroring the dashboard write path.
//
// Same effect as POST /api/bad-rentals/:id/update with
//   { status:'duplicate', duplicate_of?, note?, actor:'auto-remediator' }
// so the timeline (`rental_report_events`) row shape matches a manual close.
//
// Per §C/§E: duplicate closures do NOT require §C SMS verification. The
// cancel-guard (§E) for S1 lives in the worker's `classifyShared` — by the
// time this executor runs, it's been cleared.
// ---------------------------------------------------------

async function execCloseDuplicate(env, ctx) {
  const report = ctx.report;
  if (!report || report.id === null || report.id === undefined) {
    return { ok: false, status: 'bad_input', errorMessage: 'missing report' };
  }
  const note = ctx.note || (ctx.evidenceBundle && ctx.evidenceBundle.reason)
    ? 'auto-remediator close_duplicate' + (ctx.note ? ': ' + ctx.note : '')
    : 'auto-remediator close_duplicate';
  const duplicateOf = Number.isFinite(Number(ctx.duplicateOf)) ? Number(ctx.duplicateOf) : null;
  const nowIso = new Date().toISOString();

  // Fetch current row so we preserve triaged_at / closed_at semantics like the
  // dashboard handler does — keeps audit timestamps coherent.
  const curResp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.'
    + encodeURIComponent(report.id) + '&select=id,status,triaged_at,closed_at', {
    headers: supabaseHeaders(env, false),
  });
  if (!curResp.ok) {
    return { ok: false, status: 'db_error', errorMessage: 'cur_get_' + curResp.status };
  }
  const curRows = await curResp.json().catch(() => []);
  const cur = (Array.isArray(curRows) && curRows.length) ? curRows[0] : {};
  const fromStatus = cur.status || report.status || null;

  const patch = {
    status: 'duplicate',
    updated_at: nowIso,
    remediation_action: null,
    duplicate_of: duplicateOf,
    closed_at: cur.closed_at || nowIso,
  };
  if (fromStatus === 'received' && !cur.triaged_at) patch.triaged_at = nowIso;

  const patchResp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.'
    + encodeURIComponent(report.id), {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(patch),
  });
  if (!patchResp.ok) {
    const txt = await patchResp.text().catch(() => '');
    return { ok: false, status: 'db_error', errorMessage: 'rental_reports_patch_' + patchResp.status + ':' + txt };
  }

  // rental_report_events row — same shape the dashboard write writes.
  const evidence = { source: 'auto_remediator' };
  if (ctx.evidenceBundle) evidence.classifier = ctx.evidenceBundle;
  if (duplicateOf) evidence.duplicate_of = duplicateOf;
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/rental_report_events', {
      method: 'POST',
      headers: supabaseHeaders(env, false),
      body: JSON.stringify({
        report_id: report.id,
        from_status: fromStatus,
        to_status: 'duplicate',
        actor: 'auto-remediator',
        note: note.slice(0, 500),
        evidence,
      }),
    });
  } catch (e) {
    console.log('[Actions] close_duplicate event log insert failed: ' + e);
  }

  return {
    ok: true, status: 'ok',
    terminalReport: { status: 'duplicate', duplicate_of: duplicateOf },
    evidence: { report_id: report.id, from_status: fromStatus, duplicate_of: duplicateOf },
  };
}

// ---------------------------------------------------------
// classify_only — record-only. Cooldown engine drives cadence and the
// classifier rolls A10/W9/H9/T11 to `escalate` after 3 ticks @ 2h.
// ---------------------------------------------------------

async function execClassifyOnly(_env, ctx) {
  return {
    ok: true, status: 'ok',
    evidence: { mode: ctx.situationId || null, reason: 'classify_only_tick' },
  };
}

// ---------------------------------------------------------
// Plumbing
// ---------------------------------------------------------

function supabaseHeaders(env, returnRep) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    Prefer: returnRep ? 'return=representation' : 'return=minimal',
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}
