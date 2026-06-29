// =========================================================
// BAD-RENTAL REMEDIATOR — Safe vendor action executors
// (INC-20 / INC-16d  +  INC-21 / INC-16e).
//
// Scope per Plan v4 §F + §H.1:
//   - db_sync_upsert       → A2, A7, A9, W1, W6, H1, H7, T1, T8.  (16d)
//   - resend_online        → A6, W2, H2, T2.                       (16d)
//   - close_duplicate      → S1, S2, S3.                           (16d)
//   - classify_only        → A10, W9, H9, T11.                     (16d)
//   - atomic_ota           → A1.  resendOtaProfile.                 (16e)
//   - atomic_restore       → A3.  restoreSubscriber reasonCode=CR.  (16e)
//   - wing_put_dialable    → W7.  PUT NON-ABIR dialable plan.       (16e)
//   - helix_ota            → H3.  endpoint 4.11 reset-ota.          (16e)
//   - helix_unsuspend      → H4.  4.6 Unsuspend reasonCode CR/35.   (16e)
//   - teltik_reset_network → T3.  /v1/reset-network (10-digit MDN). (16e)
//   - teltik_reset_port    → T3/T4/T5. /v1/reset-port; 409=success. (16e)
//
// Every executor returns:
//   { ok, status, evidence?, errorMessage?, terminalReport?, vendorRequestId? }
//
// - `ok` is true iff the side-effect succeeded.
// - `status` is one of:
//     'ok' | 'disabled_by_kv' | 'unsupported_action' | 'bad_input' |
//     'service_binding_missing' | 'vendor_error' | 'db_error' | 'noop' |
//     'cached'  (idempotent re-call within cooldown returns the prior
//                vendor request_id without double-doing)
// - `terminalReport` (when set) carries { status, remediation_action?, duplicate_of? }
//
// §C SMS verification is NOT performed inside an executor. The worker invokes
// `preResolveGate` (verify-runner.mjs) around every pre-resolve action (db_sync,
// resend, OTA, restore/unsuspend, wing PUT dialable, teltik reset_*) before any
// `status='remediated'` close. `close_duplicate` is exempt per §C/§E.
//
// Per-action KV emergency disable: a key
//   `bad_rental_remediator_action_${action}_disabled`
// set to "true" / "1" short-circuits the executor with status='disabled_by_kv'.
// =========================================================

import { ALLOWED_ACTIONS, FORBIDDEN_ACTIONS } from './classifier.mjs';
import { COOLDOWN_TABLE, idempotencyKey } from './cooldown.mjs';
import {
  atomicResendOta, atomicRestoreSubscriber,
  wingPutDialable,
  helixOtaRefresh, helixUnsuspend,
  teltikResetNetwork, teltikResetPort,
} from './vendor.mjs';
import { mdn10 } from './teltik.mjs';

export const SAFE_ACTIONS = Object.freeze([
  'db_sync_upsert',
  'resend_online',
  'close_duplicate',
  'classify_only',
  // INC-21 / INC-16e
  'atomic_ota',
  'atomic_restore',
  'wing_put_dialable',
  'helix_ota',
  'helix_unsuspend',
  'teltik_reset_network',
  'teltik_reset_port',
  'teltik_sync_iccid',
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
    case 'db_sync_upsert':       return execDbSyncUpsert(env, ctx);
    case 'resend_online':        return execResendOnline(env, ctx);
    case 'close_duplicate':      return execCloseDuplicate(env, ctx);
    case 'classify_only':        return execClassifyOnly(env, ctx);
    case 'atomic_ota':           return execAtomicOta(env, ctx);
    case 'atomic_restore':       return execAtomicRestore(env, ctx);
    case 'wing_put_dialable':    return execWingPutDialable(env, ctx);
    case 'helix_ota':            return execHelixOta(env, ctx);
    case 'helix_unsuspend':      return execHelixUnsuspend(env, ctx);
    case 'teltik_reset_network': return execTeltikReset(env, ctx, 'teltik_reset_network');
    case 'teltik_reset_port':    return execTeltikReset(env, ctx, 'teltik_reset_port');
    case 'teltik_sync_iccid':    return execTeltikSyncIccid(env, ctx);
    default:                     return { ok: false, status: 'unsupported_action' };
  }
}

// ---------------------------------------------------------
// Vendor-action idempotency cache (Plan §G).
//
// Re-invoking the same vendor action within its cooldown returns the cached
// vendor request_id with status='cached' — no second HTTP call to the vendor.
// Key shape: bad_rental_remediator_idem:<idempotencyKey(action, ctx)>.
// TTL = action cooldownMs (seconds, capped to 60s minimum).
//
// Why cache here AND check cooldown in the worker? Two layers:
//   - worker-side cooldown skips the executor entirely when prior attempts
//     are still inside the cooldown window (avoids work).
//   - this cache makes the executor idempotent in case it does run again —
//     e.g. a retried tick, a manual /run, or future parallelization.
// ---------------------------------------------------------

function idemKvKey(key) { return 'bad_rental_remediator_idem:' + key; }

async function loadIdem(env, key) {
  if (!env || !env.REMEDIATOR_KV) return null;
  try {
    const raw = await env.REMEDIATOR_KV.get(idemKvKey(key));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch (err) {
    console.log('[Actions] idem cache read failed for ' + key + ': ' + err);
    return null;
  }
}

async function saveIdem(env, action, key, payload) {
  if (!env || !env.REMEDIATOR_KV) return;
  const cd = COOLDOWN_TABLE[action];
  if (!cd || !cd.cooldownMs) return;
  const ttl = Math.max(60, Math.floor(cd.cooldownMs / 1000));
  try {
    await env.REMEDIATOR_KV.put(idemKvKey(key), JSON.stringify(payload),
      { expirationTtl: ttl });
  } catch (err) {
    console.log('[Actions] idem cache write failed for ' + key + ': ' + err);
  }
}

// withIdempotency — wraps a vendor call. If a prior successful invocation
// for the same idempotency key is cached, returns it as status='cached'
// without calling fn. Otherwise runs fn and caches a successful result.
async function withIdempotency(env, action, idemCtx, fn) {
  let key;
  try { key = idempotencyKey(action, idemCtx); } catch (err) {
    return { ok: false, status: 'bad_input', errorMessage: String(err && err.message || err) };
  }
  const prior = await loadIdem(env, key);
  if (prior && prior.ok) {
    return {
      ok: true,
      status: 'cached',
      vendorRequestId: prior.vendorRequestId || null,
      evidence: { idempotency_key: key, cached_vendor_request_id: prior.vendorRequestId || null, cached_at: prior.ts || null },
    };
  }
  const res = await fn();
  if (res && res.ok) {
    await saveIdem(env, action, key, {
      ok: true, vendorRequestId: res.vendorRequestId || null, ts: nowIso(),
    });
  }
  return res;
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
// INC-16e — Atomic OTA refresh (A1 / resendOtaProfile)
// ---------------------------------------------------------

async function execAtomicOta(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const msisdn = ctx.msisdn || sim.current_mdn_e164;
  const iccid  = ctx.iccid  || sim.iccid;
  if (!msisdn || !iccid) {
    return { ok: false, status: 'bad_input', errorMessage: 'atomic_ota_missing_msisdn_or_iccid' };
  }
  return withIdempotency(env, 'atomic_ota',
    { report_id: ctx.report && ctx.report.id, attempt_no: ctx.attemptNo || 1 },
    async () => {
      const r = await atomicResendOta(env, { msisdn, iccid });
      return mapVendorResult(r, { msisdn, iccid });
    });
}

// ---------------------------------------------------------
// INC-16e — Atomic restoreSubscriber CR (A3)
// ---------------------------------------------------------

async function execAtomicRestore(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const msisdn = ctx.msisdn || sim.current_mdn_e164;
  if (!msisdn) {
    return { ok: false, status: 'bad_input', errorMessage: 'atomic_restore_missing_msisdn' };
  }
  return withIdempotency(env, 'atomic_restore', { msisdn }, async () => {
    const r = await atomicRestoreSubscriber(env, { msisdn });
    return mapVendorResult(r, { msisdn });
  });
}

// ---------------------------------------------------------
// INC-16e — Wing PUT NON-ABIR dialable plan (W7).
// NEVER PUTs the ABIR (non-dialable) plan.
// ---------------------------------------------------------

async function execWingPutDialable(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const iccid = ctx.iccid || sim.iccid;
  if (!iccid) return { ok: false, status: 'bad_input', errorMessage: 'wing_put_dialable_missing_iccid' };
  return withIdempotency(env, 'wing_put_dialable', { iccid }, async () => {
    const r = await wingPutDialable(env, { iccid });
    return mapVendorResult(r, { iccid });
  });
}

// ---------------------------------------------------------
// INC-16e — Helix 4.11 OTA refresh (H3)
// ---------------------------------------------------------

async function execHelixOta(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const ban              = ctx.ban || sim.att_ban || sim.helix_ban;
  const subscriberNumber = ctx.subscriberNumber || ctx.msisdn || sim.current_mdn_e164;
  const iccid            = ctx.iccid || sim.iccid;
  if (!ban || !subscriberNumber || !iccid) {
    return { ok: false, status: 'bad_input', errorMessage: 'helix_ota_missing_ban_subscriber_or_iccid' };
  }
  return withIdempotency(env, 'helix_ota',
    { report_id: ctx.report && ctx.report.id, attempt_no: ctx.attemptNo || 1 },
    async () => {
      const r = await helixOtaRefresh(env, { ban, subscriberNumber, iccid });
      return mapVendorResult(r, { ban, subscriberNumber, iccid });
    });
}

// ---------------------------------------------------------
// INC-16e — Helix 4.6 Unsuspend reasonCode CR/35 (H4)
// ---------------------------------------------------------

async function execHelixUnsuspend(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const subscriberNumber = ctx.subscriberNumber || ctx.msisdn || sim.current_mdn_e164;
  if (!subscriberNumber) {
    return { ok: false, status: 'bad_input', errorMessage: 'helix_unsuspend_missing_subscriber_number' };
  }
  return withIdempotency(env, 'helix_unsuspend',
    { report_id: ctx.report && ctx.report.id, attempt_no: ctx.attemptNo || 1 },
    async () => {
      const r = await helixUnsuspend(env, {
        subscriberNumber,
        mobilitySubscriptionId: ctx.mobilitySubscriptionId,
      });
      return mapVendorResult(r, { subscriberNumber });
    });
}

// ---------------------------------------------------------
// INC-16e — Teltik /v1/reset-network and /v1/reset-port.
// 10-digit MDN enforced at the teltik.mjs boundary (mdn10).
// 409 on /reset-port is treated as success (already in flight).
// ---------------------------------------------------------

async function execTeltikReset(env, ctx, action) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const raw = ctx.mdn || sim.current_mdn_e164;
  if (!raw) return { ok: false, status: 'bad_input', errorMessage: 'teltik_reset_missing_mdn' };
  const m10 = mdn10(raw);
  if (!m10 || m10.length !== 10) {
    return { ok: false, status: 'bad_input', errorMessage: 'teltik_reset_invalid_mdn:' + m10 };
  }
  return withIdempotency(env, action, { mdn10: m10 }, async () => {
    const r = action === 'teltik_reset_port'
      ? await teltikResetPort(env, { mdn: m10 })
      : await teltikResetNetwork(env, { mdn: m10 });
    // Teltik /reset-port 409 = already in flight → treat as success.
    if (action === 'teltik_reset_port' && r.status === 409) {
      return {
        ok: true, status: 'ok',
        vendorRequestId: r.requestId || null,
        evidence: { mdn10: m10, vendor_status: r.status, treated_as: 'already_in_flight', vendor_body: r.body },
      };
    }
    return mapVendorResult(r, { mdn10: m10 });
  });
}

// ---------------------------------------------------------
// teltik_sync_iccid — T12. A physical SIM-card swap changed the line's ICCID but
// not its MDN, so every call keyed by the old ICCID 404s "Invalid ICCID". The
// classifier resolved the line's CURRENT ICCID from a get-info-by-MDN read and
// passes it as ctx.newIccid; here we patch sims.iccid and clear the rotation-
// failure state so the next rotation window picks the line up normally. The MDN
// is unchanged → no sim_numbers row and no reseller webhook (mirrors the rotation
// playbook's sync_iccid heal). DB-only action — no vendor mutation. Idempotent:
// re-running once the DB already matches the vendor returns status='noop'.
// ---------------------------------------------------------
async function execTeltikSyncIccid(env, ctx) {
  const sim = ctx.sim;
  if (!sim || !sim.id) return { ok: false, status: 'bad_input', errorMessage: 'missing sim' };
  const newIccid = ctx.newIccid;
  if (!newIccid) return { ok: false, status: 'bad_input', errorMessage: 'teltik_sync_iccid_missing_iccid' };
  if (newIccid === sim.iccid) {
    return { ok: true, status: 'noop', evidence: { reason: 'iccid_already_matches_vendor', sim_id: sim.id } };
  }
  const patch = {
    iccid: newIccid,
    status: 'active',
    rotation_status: 'success',
    rotation_fail_count: 0,
    last_rotation_error: null,
    status_reason: 'ICCID swapped from ' + sim.iccid + ' to ' + newIccid + ' on ' + nowIso(),
  };
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
    evidence: { sim_id: sim.id, old_iccid: sim.iccid, new_iccid: newIccid },
  };
}

// ---------------------------------------------------------
// Vendor result → executor result projection.
// ---------------------------------------------------------

function mapVendorResult(r, ctxEvidence) {
  if (!r) return { ok: false, status: 'vendor_error', errorMessage: 'vendor_empty_response' };
  if (r.ok) {
    return {
      ok: true, status: 'ok',
      vendorRequestId: r.requestId || null,
      evidence: { ...(ctxEvidence || {}), vendor_status: r.status, vendor_request_id: r.requestId || null, vendor_body: redact(r.body) },
    };
  }
  // Distinguish missing-credentials/bad-input vs vendor HTTP errors.
  const errStr = String(r.error || '');
  if (errStr.endsWith('_credentials_missing') || errStr === 'missing_iccid'
      || errStr.startsWith('teltik_mdn_invalid')) {
    return { ok: false, status: 'bad_input', errorMessage: errStr };
  }
  return {
    ok: false, status: 'vendor_error',
    errorMessage: errStr || 'vendor_error',
    evidence: { ...(ctxEvidence || {}), vendor_status: r.status, vendor_body: redact(r.body) },
  };
}

// Strip anything credential-shaped from vendor bodies before persistence.
function redact(body) {
  if (!body || typeof body !== 'object') return body;
  const drop = new Set(['session', 'token', 'pin', 'password', 'apikey', 'authorization']);
  const out = Array.isArray(body) ? [] : {};
  for (const [k, v] of Object.entries(body)) {
    if (drop.has(String(k).toLowerCase())) continue;
    if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

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
