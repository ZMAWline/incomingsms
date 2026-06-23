// =========================================================
// §C SMS VERIFICATION — runner (INC-19 / INC-16c).
//
// Holds the IO orchestration that the pure verify.mjs deliberately avoids:
//   - Send the nonce SMS via SKYLINE_GATEWAY /send-sms (3 attempts, 60s gap)
//   - Persist verify_pending state on rental_reports so the poll survives
//     across cron ticks (no waitUntil dependency — a separate 1-min cron in
//     index.js drives `runVerifyPoll`).
//   - Resolve a pending verify by querying inbound_sms.
//   - Record the verify_send_attempt / verify_received / verify_send_failed /
//     verify_receive_timeout evidence rows.
//
// Public surface (consumed by index.js and, in 16d, by per-vendor flows):
//   startVerify(env, { report, sim, attemptNo })          → outcome row + state mutation
//   resolvePendingVerify(env, report)                     → 'match' | 'timeout' | 'still_pending' | 'no_pending'
//   runVerifyPoll(env)                                    → tick over all verify_pending reports
//   preResolveGate(env, { report, sim, evidence, vendorRead, autoAction,
//                         webhookDelivered, situationExtras, attemptNo })
//                                                        → { passed: bool, status, reason? }
//
// preResolveGate is the universal pre-resolve gate consumed by 16d. It runs
// §C.4 minus SMS first (a failing vendor read or webhook means there is no
// point sending a nonce yet). If the non-SMS predicate is clean it kicks off
// (or polls) §C.1–§C.3 and only returns passed=true when an inbound nonce
// has been recorded for the current attempt.
// =========================================================

import { mintNonce, buildVerifyBody, cleanRecheckPredicate } from './verify.mjs';

const RECEIVE_WINDOW_MS = 5 * 60 * 1000; // §C.3 — 5 min, 30 × 10s polls.
const SEND_MAX_ATTEMPTS = 3;             // §C.2
const SEND_RETRY_GAP_MS = 60 * 1000;     // §C.2
const VERIFY_POLL_BATCH = 50;

// ---------------------------------------------------------
// §C.1–§C.2 — send the nonce with up to 3 attempts, 60s apart.
//
// `sleep` is injected so the same code path drives the live runner
// (real setTimeout) and the unit fixtures (instant-resolve stub).
// ---------------------------------------------------------

export async function startVerify(env, opts) {
  const { report, sim, attemptNo, sleep = realSleep, now = () => new Date() } = opts;
  if (!report || !report.id) throw new Error('startVerify_missing_report');
  if (!sim || !sim.id || !sim.current_mdn_e164) throw new Error('startVerify_missing_sim');
  if (!sim.gateway_id || !sim.port) {
    return await recordSendFailed(env, report.id, attemptNo, 'missing_gateway_or_port', null);
  }
  if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET) {
    return await recordSendFailed(env, report.id, attemptNo, 'skyline_binding_missing', null);
  }

  const nonce = await mintNonce(report.id, attemptNo);
  const body  = buildVerifyBody({ reportId: report.id, simId: sim.id, nonce });

  let sendOk = false;
  let lastError = null;
  let sendRequestId = null;
  let sentAt = null;

  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await skylineSendSms(env, {
        gateway_id: sim.gateway_id,
        port: sim.port,
        to: sim.current_mdn_e164,
        message: body,
      });
      if (r.ok) {
        sendOk = true;
        sendRequestId = r.requestId || null;
        sentAt = now().toISOString();
        break;
      }
      lastError = 'skyline_status_' + r.status + (r.error ? ':' + r.error : '');
    } catch (err) {
      lastError = String(err && err.message || err);
    }
    if (attempt < SEND_MAX_ATTEMPTS) await sleep(SEND_RETRY_GAP_MS);
  }

  if (!sendOk) {
    return await recordSendFailed(env, report.id, attemptNo, lastError || 'unknown_send_error', nonce);
  }

  // Persist verify_pending on the report so the 1-min poll can pick it up.
  await patchReport(env, report.id, {
    auto_remediation_state: 'verify_pending',
    verify_pending_nonce: nonce,
    verify_pending_sent_at: sentAt,
  });

  await insertAttempt(env, {
    report_id: report.id,
    attempt_no: attemptNo,
    mode: 'verify_send',
    action: 'verify_send_sms',
    outcome: 'verify_send_attempt',
    evidence: { nonce, body, send_request_id: sendRequestId, to_number: sim.current_mdn_e164, sent_at: sentAt },
  });

  return { ok: true, status: 'verify_pending', nonce, sentAt };
}

async function recordSendFailed(env, reportId, attemptNo, errorMessage, nonce) {
  await insertAttempt(env, {
    report_id: reportId,
    attempt_no: attemptNo,
    mode: 'verify_send',
    action: 'verify_send_sms',
    outcome: 'verify_send_failed',
    evidence: { nonce: nonce || null, attempts: SEND_MAX_ATTEMPTS },
    error_message: errorMessage,
  });
  // Mark report as escalated — escalation wiring proper lands in 16f.
  await patchReport(env, reportId, {
    auto_remediation_state: 'escalated',
    escalation_reason: 'verify_send_failed',
    verify_pending_nonce: null,
    verify_pending_sent_at: null,
  });
  return { ok: false, status: 'verify_send_failed', error: errorMessage };
}

// ---------------------------------------------------------
// §C.3 — receive poll. Idempotent: called from the 1-min cron OR ad-hoc.
// Returns 'match' / 'timeout' / 'still_pending' / 'no_pending'.
// ---------------------------------------------------------

export async function resolvePendingVerify(env, report, opts) {
  const { now = () => new Date() } = opts || {};
  if (!report || !report.verify_pending_nonce || !report.verify_pending_sent_at) {
    return 'no_pending';
  }
  const sentAtMs = Date.parse(report.verify_pending_sent_at);
  if (!Number.isFinite(sentAtMs)) return 'no_pending';

  // Look up SIM for current_mdn_e164 if not on the report row already.
  const toNumber = report.verify_to_number || (await readSimE164(env, report.sim_id));
  if (!toNumber) return 'still_pending';

  const match = await findNonceInbound(env, {
    toNumber,
    nonce: report.verify_pending_nonce,
    afterIso: report.verify_pending_sent_at,
  });

  if (match) {
    await insertAttempt(env, {
      report_id: report.id,
      attempt_no: report.verify_attempt_no || 1,
      mode: 'verify_receive',
      action: 'classify_only',
      outcome: 'verify_received',
      evidence: {
        nonce: report.verify_pending_nonce,
        inbound_sms_id: match.id,
        received_at: match.received_at,
        from_number: match.from_number,
        to_number: match.to_number,
      },
    });
    // §C proof complete. The line received our nonce, so it can receive SMS
    // again — and the non-SMS predicate (vendor healthy + webhook delivered +
    // situation extras) already passed in preResolveGate BEFORE the nonce was
    // sent. So a received nonce is a definitive `remediated` close.
    //
    // Previously this re-queued the report; the action's 24h cooldown then
    // blocked the main tick from ever closing it, so verify_received reports
    // spun in 'queued' forever (0 remediated closes despite matched nonces).
    const closedAt = now().toISOString();
    await patchReport(env, report.id, {
      auto_remediation_state: 'done',
      status: 'remediated',
      remediation_action: 'other',
      closed_at: closedAt,
      verify_pending_nonce: null,
      verify_pending_sent_at: null,
    });
    // Mirror the dashboard/applyClassificationState timeline row for a remediated close.
    try {
      await fetch(env.SUPABASE_URL + '/rest/v1/rental_report_events', {
        method: 'POST',
        headers: supabaseHeaders(env, false),
        body: JSON.stringify({
          report_id: report.id,
          from_status: report.status || null,
          to_status: 'remediated',
          actor: 'auto-remediator',
          note: 'auto-remediator §C verified (inbound nonce received)',
          evidence: { source: 'auto_remediator', verify: 'received', inbound_sms_id: match.id },
        }),
      });
    } catch (e) {
      console.log('[Verify] remediated event log insert failed report=' + report.id + ': ' + e);
    }
    return 'match';
  }

  const nowMs = now().getTime();
  if (nowMs - sentAtMs > RECEIVE_WINDOW_MS) {
    await insertAttempt(env, {
      report_id: report.id,
      attempt_no: report.verify_attempt_no || 1,
      mode: 'verify_receive',
      action: 'classify_only',
      outcome: 'verify_receive_timeout',
      evidence: {
        nonce: report.verify_pending_nonce,
        to_number: toNumber,
        sent_at: report.verify_pending_sent_at,
        window_ms: RECEIVE_WINDOW_MS,
      },
      error_message: 'no inbound nonce within 5 min window',
    });
    await patchReport(env, report.id, {
      auto_remediation_state: 'escalated',
      escalation_reason: 'verify_receive_timeout',
      verify_pending_nonce: null,
      verify_pending_sent_at: null,
    });
    return 'timeout';
  }

  return 'still_pending';
}

export async function runVerifyPoll(env) {
  const rows = await fetchVerifyPendingReports(env, VERIFY_POLL_BATCH);
  let matched = 0, timedOut = 0, stillPending = 0;
  for (const r of rows) {
    try {
      // Prefer the report's own e164 (the reported current MDN) as the inbound
      // match number; readSimE164 is the fallback.
      const out = await resolvePendingVerify(env, { ...r, verify_to_number: r.verify_to_number || r.e164 });
      if (out === 'match') matched++;
      else if (out === 'timeout') timedOut++;
      else if (out === 'still_pending') stillPending++;
    } catch (err) {
      console.log('[VerifyPoll] report ' + r.id + ' error: ' + err);
    }
  }
  return { polled: rows.length, matched, timedOut, stillPending };
}

// ---------------------------------------------------------
// preResolveGate — universal §C gate consumed by 16d.
//
// Caller passes the situation's clean-recheck inputs MINUS sms (we own that).
// Behaviour:
//   - vendorRead/action/webhook/extras not clean → passed:false (no SMS sent)
//   - SMS not yet started     → start §C.1, return verify_pending
//   - SMS pending              → return verify_pending
//   - SMS timeout              → return verify_receive_timeout (escalated)
//   - SMS received             → re-run §C.4 with smsReceived=true → passed:true
// ---------------------------------------------------------

export async function preResolveGate(env, opts) {
  const { report, sim, vendorRead, autoAction, webhookDelivered,
          situationExtras, attemptNo = 1 } = opts;

  if (!report || !sim) return { passed: false, status: 'bad_input' };

  // §C.4.1–3 + extras — sms-less probe. If any fail, do not start §C.
  const probe = cleanRecheckPredicate({
    vendorRead, autoAction, webhookDelivered,
    smsReceived: true, situationExtras,
  });
  if (!probe.passed) return { passed: false, status: 'predicate_failed', reason: probe.reason };

  // Already pending — let the 1-min poll handle the transition; we just report state.
  if (report.auto_remediation_state === 'verify_pending'
      && report.verify_pending_nonce && report.verify_pending_sent_at) {
    const out = await resolvePendingVerify(env, { ...report, sim_id: sim.id, verify_to_number: sim.current_mdn_e164 });
    if (out === 'match')      return { passed: true,  status: 'verify_received' };
    if (out === 'timeout')    return { passed: false, status: 'verify_receive_timeout' };
    /* still_pending */       return { passed: false, status: 'verify_pending' };
  }

  // No pending verify — start §C.1.
  const started = await startVerify(env, { report, sim, attemptNo });
  if (!started.ok) return { passed: false, status: started.status, reason: started.error };
  return { passed: false, status: 'verify_pending' };
}

// ---------------------------------------------------------
// IO primitives — Supabase + SkyLine gateway.
// ---------------------------------------------------------

async function skylineSendSms(env, { gateway_id, port, to, message }) {
  const req = new Request(
    'https://skyline-gateway/send-sms?secret=' + encodeURIComponent(env.SKYLINE_SECRET),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateway_id, port, to, message }),
    },
  );
  const resp = await env.SKYLINE_GATEWAY.fetch(req);
  const status = resp.status;
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return {
    ok: resp.ok && (body == null || body.error == null || body.error === false || body.error === ''),
    status,
    error: body && (body.error || body.message) || null,
    requestId: body && (body.request_id || body.send_id || null),
    body,
  };
}

async function readSimE164(env, simId) {
  if (!simId) return null;
  // `sims` has no current_mdn_e164 column (schema: msisdn). Selecting it
  // returned HTTP 400 -> null -> the receive poll exited `still_pending`
  // forever and verify_pending reports never resolved (INC-25 column trap).
  // Read msisdn and synthesize E.164 to match inbound_sms.to_number (+1XXXXXXXXXX).
  const r = await supabaseGet(env,
    'sims?id=eq.' + encodeURIComponent(simId) + '&select=msisdn&limit=1');
  if (!r.ok) return null;
  const rows = await r.json();
  const msisdn = rows && rows[0] && rows[0].msisdn;
  return simMsisdnToE164(msisdn);
}

// National 10-digit msisdn ("2078989874") -> "+12078989874". Mirrors the
// worker's msisdnToE164 so the receive poll and the main tick agree on format.
function simMsisdnToE164(msisdn) {
  if (msisdn == null) return null;
  const s = String(msisdn).trim().replace(/[^\d]/g, '');
  if (!s) return null;
  if (s.length === 10) return '+1' + s;
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return s.startsWith('+') ? s : null;
}

async function findNonceInbound(env, { toNumber, nonce, afterIso }) {
  // §C.3 — match by to_number + body contains nonce + received_at > sent_at.
  // PostgREST `like` is sufficient — nonce is hex and never appears as a
  // substring of legitimate carrier messages.
  const pattern = '*' + nonce + '*';
  const q = 'inbound_sms?to_number=eq.' + encodeURIComponent(toNumber)
    + '&received_at=gt.' + encodeURIComponent(afterIso)
    + '&body=like.' + encodeURIComponent(pattern)
    + '&select=id,to_number,from_number,body,received_at'
    + '&order=received_at.desc&limit=1';
  const r = await supabaseGet(env, q);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function fetchVerifyPendingReports(env, limit) {
  const q = 'rental_reports?auto_remediation_state=eq.verify_pending'
    + '&select=id,sim_id,e164,status,verify_pending_nonce,verify_pending_sent_at'
    + '&order=verify_pending_sent_at.asc&limit=' + limit;
  const r = await supabaseGet(env, q);
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function insertAttempt(env, row) {
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_report_remediation_attempts', {
    method: 'POST',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.log('[Verify] attempt insert failed report=' + row.report_id + ' status=' + resp.status + ' body=' + txt);
  }
}

async function patchReport(env, reportId, patch) {
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/rental_reports?id=eq.' + encodeURIComponent(reportId), {
    method: 'PATCH',
    headers: supabaseHeaders(env, false),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.log('[Verify] report PATCH failed id=' + reportId + ' status=' + resp.status + ' body=' + txt);
  }
}

async function supabaseGet(env, path) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
}

function supabaseHeaders(env, returnRep) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    Prefer: returnRep ? 'return=representation' : 'return=minimal',
  };
}

function realSleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
