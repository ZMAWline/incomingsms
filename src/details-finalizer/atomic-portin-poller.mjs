/* ── ATOMIC port-in status finalizer ──────────────────────────────────────── */
// Read-only poll of ATOMIC's portinStatus for SIMs awaiting port-in
// completion (sims.port_in_pending = true, set by bulk-activator when a
// portinRequest is submitted — a distinct signal from rotation_status=
// 'mdn_pending', which runAtomicFinalizer's bucket already owns for stuck
// swapMSISDN recovery). Talks to ATOMIC only via mdn-rotator's
// /atomic-portin-status route (mdn-rotator holds the ATOMIC credentials, same
// as the /atomic-inquiry call in index.js).
//
// Terminal status codes that stop polling:
// - 948 "Port Request Does Not Exist" — the port was never created or was
//   cancelled on the carrier side. No point continuing to poll.
// - 910 "sim does not belong to this MVNO" — the SIM/ICCID is not under our
//   ATOMIC account. This is a configuration error, not a transient state.
// - 951 "Portin status fail.Conflict" (Result.reasonCode=CT) — the losing
//   carrier rejected the port. The real reason is embedded in the description
//   as "statusReasonCode - <XX> ~ statusReasonDescription - <text>" (seen: 8A
//   account number incorrect, 6B T-Mobile transfer PIN incorrect). Polling
//   cannot clear a rejection — the details must be corrected and the port
//   resubmitted — so stop and leave it for an operator.
// - 00 with Result.reasonCode=CO (Completed) — port completed successfully.
//   Immediately run regular ATOMIC subsriberInquiry by ICCID and auto-finalize
//   the SIM from that response. Only clear port_in_pending after that
//   finalization succeeds, so transient inquiry failures retry on the next
//   due check.
//
// For non-terminal codes (e.g., 01 Pending, 02 In Progress, etc.), we record
// the carrier's raw statusCode/description on the sims row and keep polling,
// backing off as the port ages (see portinPollInterval). A port that is still
// non-terminal after the max age stops polling and is escalated to
// system_errors. The dashboard's manual Check Port-In Status button remains
// read-only and available for operator review.
//
// Lives outside index.js so tests can import and run it; index.js passes in
// its Supabase and sim_numbers helpers.

import { isTeltikHosted } from '../shared/gateway-host.mjs';
import { ensureTeltikAlias, summarizeAliasResult } from '../shared/teltik-alias.mjs';
import { recordPortinStatusOutcome } from '../shared/atomic-portin-outcomes.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A 5-minute cron tick lands a few seconds either side of the exact interval.
// Without this grace a SIM checked 4m58s ago would wait a whole extra tick.
const TICK_GRACE_MS = MINUTE;

// Poll schedule by age of the port-in, measured from submission:
//   0–2 h   every ATOMIC_PORTIN_FAST_INTERVAL_MINUTES   (default 5)
//   2–24 h  every ATOMIC_PORTIN_MEDIUM_INTERVAL_MINUTES (default 30)
//   24 h+   every ATOMIC_PORTIN_SLOW_INTERVAL_MINUTES   (default 360)
//   ATOMIC_PORTIN_MAX_AGE_DAYS (default 14) — stop polling and escalate.
export function portinPollSchedule(env = {}) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    fastMs: num(env.ATOMIC_PORTIN_FAST_INTERVAL_MINUTES, 5) * MINUTE,
    mediumMs: num(env.ATOMIC_PORTIN_MEDIUM_INTERVAL_MINUTES, 30) * MINUTE,
    slowMs: num(env.ATOMIC_PORTIN_SLOW_INTERVAL_MINUTES, 360) * MINUTE,
    maxAgeMs: num(env.ATOMIC_PORTIN_MAX_AGE_DAYS, 14) * DAY,
  };
}

export function portinPollInterval(ageMs, schedule) {
  if (ageMs < 2 * HOUR) return schedule.fastMs;
  if (ageMs < DAY) return schedule.mediumMs;
  return schedule.slowMs;
}

// sims has no port-in submission column. bulk-activator opens a fresh
// sim_numbers row (valid_from = now) for the porting MSISDN in the same write
// that sets port_in_pending=true, so the open row's valid_from is the
// submission time. sims.created_at is the fallback for a row without one.
export function portinSubmittedAt(sim) {
  const numbers = Array.isArray(sim.sim_numbers) ? sim.sim_numbers : [];
  const times = numbers.map(n => Date.parse(n.valid_from)).filter(Number.isFinite);
  if (times.length > 0) return { at: Math.max(...times), source: 'sim_numbers.valid_from' };
  const created = Date.parse(sim.created_at);
  return Number.isFinite(created) ? { at: created, source: 'sims.created_at' } : { at: null, source: null };
}

// 'expired' | 'due' | 'wait'
export function portinPollDecision(sim, schedule, nowMs) {
  const submitted = portinSubmittedAt(sim);
  const ageMs = submitted.at === null ? 0 : nowMs - submitted.at;
  if (ageMs >= schedule.maxAgeMs) return 'expired';
  const checkedMs = Date.parse(sim.atomic_portin_checked_at);
  if (!Number.isFinite(checkedMs)) return 'due';
  return nowMs - checkedMs >= portinPollInterval(ageMs, schedule) - TICK_GRACE_MS ? 'due' : 'wait';
}

export function createAtomicPortinPoller(deps) {
  const {
    supabaseSelect,
    supabasePatch,
    supabaseInsert,
    closeCurrentNumber,
    insertNewNumber,
    logTeltikApiCall,
  } = deps;

  function pickAtomicInquiryField(data, keys) {
    const result = data?.result || {};
    for (const key of keys) {
      if (data && data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
      if (result && result[key] !== undefined && result[key] !== null && result[key] !== '') return result[key];
    }
    return null;
  }

  function normalizeAtomicMdn(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return null;
  }

  async function finalizeCompletedAtomicPortin(env, sim) {
    const inqUrl = `https://mdn-rotator/atomic-inquiry?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(sim.iccid)}`;
    const inqRes = await env.MDN_ROTATOR.fetch(inqUrl, { method: 'GET' });
    if (!inqRes.ok) {
      throw new Error(`subscriber inquiry ${inqRes.status}`);
    }
    const data = await inqRes.json().catch(() => ({}));
    if (!data.ok || data.statusCode !== '00') {
      throw new Error(`subscriber inquiry failed: ${data.description || data.statusCode || 'unknown'}`);
    }

    const attStatus = String(pickAtomicInquiryField(data, ['attStatus', 'status']) || '').trim();
    if (attStatus && attStatus.toLowerCase() !== 'active') {
      throw new Error(`subscriber inquiry not Active (got ${attStatus})`);
    }

    const msisdn = normalizeAtomicMdn(pickAtomicInquiryField(data, ['msisdn', 'MSISDN']));
    const e164 = msisdn ? `+1${msisdn}` : null;
    const patch = {
      status: 'active',
      status_reason: null,
      port_in_pending: false,
      rotation_status: 'success',
      rotation_fail_count: 0,
      rotation_eligible: true,
      last_activation_error: null,
      last_rotation_error: null,
    };

    if (msisdn) patch.msisdn = msisdn;
    const ban = pickAtomicInquiryField(data, ['ban', 'BAN', 'attBan', 'billingAccountNumber']);
    if (ban) patch.att_ban = String(ban);
    const imei = pickAtomicInquiryField(data, ['imei', 'IMEI', 'BLIMEI', 'blimei', 'billingImei']);
    if (imei) patch.imei = String(imei);
    const activationDate = pickAtomicInquiryField(data, ['activationDate', 'activatedAt', 'activation_date']);
    if (activationDate) {
      const parsed = new Date(activationDate);
      if (!isNaN(parsed.getTime())) patch.activated_at = parsed.toISOString();
    }
    const zipCode = pickAtomicInquiryField(data, ['zipCode', 'zip']);
    if (zipCode) patch.activation_zip = String(zipCode);

    if (e164) {
      const openRows = await supabaseSelect(env, `sim_numbers?select=e164&sim_id=eq.${encodeURIComponent(String(sim.id))}&valid_to=is.null&limit=1`);
      const openE164 = Array.isArray(openRows) && openRows[0] ? openRows[0].e164 : null;
      if (openE164 !== e164) {
        await closeCurrentNumber(env, sim.id);
        await insertNewNumber(env, sim.id, e164);
      }
    }

    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, patch);

    // Port completed: the Atomic line is live. If it is seated in a Teltik
    // gateway, make sure Teltik's nickname is the ICCID (idempotent read → POST
    // /v1/update-nickname → read back). Logged, never throws, never touches
    // vendor/gateway_host/msisdn.
    const teltikAlias = await ensureTeltikAliasAfterPortin(env, { ...sim, msisdn: msisdn || sim.msisdn });

    return {
      ok: true,
      msisdn,
      e164,
      attStatus,
      ban: ban || null,
      imei: imei || null,
      activated_at: patch.activated_at || null,
      teltik_alias: teltikAlias,
    };
  }

  async function ensureTeltikAliasAfterPortin(env, sim) {
    try {
      if (!sim || !isTeltikHosted(sim)) return null;
      const alias = await ensureTeltikAlias(env, {
        id: sim.id,
        iccid: sim.iccid,
        vendor: 'atomic',
        current_mdn_e164: sim.msisdn || null,
      });
      const summary = summarizeAliasResult(alias);
      console.log(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: teltik alias ${alias.ok ? 'OK' : 'FAILED'} action=${alias.action} reason=${alias.reason || 'none'} host_mdn=${alias.mdn10 || 'unresolved'}`);
      await logTeltikApiCall(env, {
        run_id: null,
        step: 'teltik_alias',
        iccid: sim.iccid,
        request_url: (alias.update && alias.update.url) || 'https://api.smsgateway.xyz/v1/update-nickname',
        request_method: alias.update ? 'POST' : 'GET',
        request_body: { nickname: sim.iccid, mdn: alias.mdn10 || null, action: alias.action },
        response_status: alias.update ? alias.update.http_status : (alias.ok ? 200 : 0),
        response_ok: !!alias.ok,
        response_body_text: JSON.stringify({ summary, trail: alias.trail }),
        response_body_json: summary,
        error: alias.ok ? null : `Teltik alias not verified: ${alias.reason}`,
      });
      return summary;
    } catch (e) {
      console.error(`[Finalizer/AtomicPortinStatus] SIM ${sim && sim.iccid}: teltik alias check crashed: ${e}`);
      return null;
    }
  }

  // Past the max age with no terminal carrier status: stop polling and tell an
  // operator. The system_errors row is written first so a failed insert leaves
  // port_in_pending=true and the next tick retries the escalation.
  async function expireStaleAtomicPortin(env, sim, schedule) {
    const submitted = portinSubmittedAt(sim);
    const maxAgeDays = schedule.maxAgeMs / DAY;
    const lastStatus = sim.atomic_portin_status_code
      ? `${sim.atomic_portin_status_code} — ${sim.atomic_portin_description || 'no description'}`
      : 'never answered';
    const message = `ATOMIC port-in had no final carrier status after ${maxAgeDays} days; polling stopped. Last portinStatus: ${lastStatus}`;
    await supabaseInsert(env, 'system_errors', [{
      source: 'details-finalizer',
      action: 'atomic_portin_max_age',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: message,
      error_details: {
        msisdn: sim.msisdn || null,
        submitted_at: submitted.at === null ? null : new Date(submitted.at).toISOString(),
        submitted_at_source: submitted.source,
        last_checked_at: sim.atomic_portin_checked_at || null,
        last_status_code: sim.atomic_portin_status_code || null,
        last_description: sim.atomic_portin_description || null,
        max_age_days: maxAgeDays,
      },
      severity: 'error',
      status: 'open',
    }]);
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      port_in_pending: false,
      status_reason: 'atomic_portin_max_age',
      last_activation_error: message,
    });
    console.log(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: MAX AGE - ${message}`);
    return message;
  }

  async function runAtomicPortinStatusFinalizer(env, limit) {
    if (!env.MDN_ROTATOR) {
      return { processed: 0, checked: 0, message: 'mdn_rotator_binding_missing' };
    }
    if (!env.ADMIN_RUN_SECRET) {
      return { processed: 0, checked: 0, message: 'admin_run_secret_missing' };
    }

    // Skip rows checked within the shortest interval in the query itself;
    // the per-SIM back-off is decided below. Stalest rows first, so SIMs that
    // are not due yet never crowd due ones out of the limit.
    const schedule = portinPollSchedule(env);
    const nowMs = Date.now();
    const recentCutoff = new Date(nowMs - (schedule.fastMs - TICK_GRACE_MS)).toISOString();
    const sims = (await supabaseSelect(
      env,
      `sims?select=id,iccid,msisdn,gateway_host,created_at,atomic_portin_status_code,atomic_portin_description,atomic_portin_checked_at,sim_numbers(valid_from)` +
      `&vendor=eq.atomic&status=eq.provisioning&port_in_pending=eq.true` +
      `&sim_numbers.valid_to=is.null` +
      `&or=(atomic_portin_checked_at.is.null,atomic_portin_checked_at.lt.${encodeURIComponent(recentCutoff)})` +
      `&order=atomic_portin_checked_at.asc.nullsfirst&limit=${limit}`
    )) || [];
    if (sims.length === 0) return { ok: true, processed: 0, checked: 0 };

    let processed = 0;
    let checked = 0;
    let errors = 0;
    let terminal = 0;
    let skipped = 0;
    let expired = 0;
    const results = [];

    // Carrier statusCode -> what it means for us. The carrier's own text is kept
    // verbatim in atomic_portin_description; these say why we stop polling.
    const TERMINAL_REASONS = {
      '948': 'port was never created or was cancelled on carrier side',
      '910': 'SIM/ICCID not under our ATOMIC account',
      '951': 'port rejected by the losing carrier — correct the details and resubmit; polling cannot clear a rejection',
    };
    const TERMINAL_CODES = new Set(Object.keys(TERMINAL_REASONS));
    const COMPLETED_REASON_CODES = new Set(['CO']);

    for (const sim of sims) {
      const decision = portinPollDecision(sim, schedule, nowMs);
      if (decision === 'wait') {
        skipped++;
        continue;
      }
      processed++;
      if (decision === 'expired') {
        try {
          const reason = await expireStaleAtomicPortin(env, sim, schedule);
          expired++;
          results.push({ iccid: sim.iccid, ok: true, expired: true, reason });
        } catch (e) {
          errors++;
          results.push({ iccid: sim.iccid, ok: false, error: String(e) });
          console.error(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: max-age escalation failed: ${e}`);
        }
        continue;
      }
      const msisdn = String(sim.msisdn || '').replace(/\D/g, '');
      if (!/^\d{10}$/.test(msisdn)) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: 'no valid 10-digit MSISDN on file' });
        continue;
      }
      try {
        const url = `https://mdn-rotator/atomic-portin-status?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&msisdn=${encodeURIComponent(msisdn)}&iccid=${encodeURIComponent(sim.iccid)}`;
        const res = await env.MDN_ROTATOR.fetch(url, { method: 'GET' });
        if (!res.ok) {
          errors++;
          results.push({ iccid: sim.iccid, ok: false, error: `portin-status ${res.status}` });
          continue;
        }
        const data = await res.json().catch(() => ({}));
        const statusCode = data.statusCode ?? null;
        const description = data.description ?? null;
        const result = data.result ?? null;
        const reasonCode = result?.reasonCode ?? null;
        const isTerminalCode = statusCode && TERMINAL_CODES.has(String(statusCode));
        const isCompleted = statusCode === '00' && reasonCode && COMPLETED_REASON_CODES.has(reasonCode);

        await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
          atomic_portin_status_code: statusCode,
          atomic_portin_description: description,
          atomic_portin_checked_at: new Date().toISOString(),
        });
        checked++;

        if (isTerminalCode || isCompleted) {
          await recordPortinStatusOutcome({
            patch: (body) => supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, body),
            iccid: sim.iccid, statusCode, description, result, msisdn,
          });
        }

        if (isTerminalCode) {
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            port_in_pending: false,
          });
          terminal++;
          const reason = `Atomic portinStatus returned ${statusCode} — ${TERMINAL_REASONS[String(statusCode)]}`;
          results.push({ iccid: sim.iccid, ok: true, statusCode, description, reasonCode, terminal: true, reason });
          console.log(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: TERMINAL - ${reason} (carrier said: ${description})`);
        } else if (isCompleted) {
          const finalized = await finalizeCompletedAtomicPortin(env, sim);
          terminal++;
          results.push({
            iccid: sim.iccid,
            ok: true,
            statusCode,
            description,
            reasonCode,
            terminal: true,
            finalized: true,
            ...finalized,
            reason: 'Port completed (reasonCode=CO). Auto-finalized from ATOMIC subsriberInquiry.',
          });
          console.log(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: COMPLETED - auto-finalized from subscriber inquiry`);
        } else {
          results.push({ iccid: sim.iccid, ok: true, statusCode, description, reasonCode, terminal: false });
          console.log(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: statusCode=${statusCode} reasonCode=${reasonCode} — continuing poll`);
        }
      } catch (e) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: String(e) });
        console.error(`[Finalizer/AtomicPortinStatus] SIM ${sim.iccid}: ${e}`);
      }
    }

    return { ok: true, processed, checked, errors, terminal, skipped, expired, results };
  }

  return { runAtomicPortinStatusFinalizer };
}
