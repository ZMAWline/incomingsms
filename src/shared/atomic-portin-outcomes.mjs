const OPEN_PENDING_CODES = new Set(['OP', 'OPEN', 'PENDING']);
const SUCCESS_CODES = new Set(['CO', 'COMPLETED', 'CF']);

function reason(response = {}) {
  const result = response.Result || response.result || {};
  return {
    code: String(result.reasonCode ?? response.reasonCode ?? '').trim(),
    description: String(result.reasonDescription ?? response.reasonDescription ?? '').trim(),
  };
}

function isoPlusMinute(now) {
  return new Date(new Date(now).getTime() + 60_000).toISOString();
}

export function classifyPortinRequest({ httpStatus, response = {}, now = new Date().toISOString() }) {
  const r = reason(response);
  const accepted = httpStatus >= 200 && httpStatus < 300 && (response.statusCode == null || String(response.statusCode) === '00');
  const isOpenPending = OPEN_PENDING_CODES.has(r.code.toUpperCase()) || /\b(open|pending)\b/i.test(r.description);
  if (accepted && isOpenPending) {
    return {
      classification: 'pending', status: 'provisioning', reasonCode: r.code || null,
      reasonDescription: r.description || null, primaryError: null,
      statusCheckAt: null, statusCheckAttemptedAt: null,
    };
  }
  if (accepted) {
    return {
      classification: 'submitted', status: 'provisioning', reasonCode: r.code || null,
      reasonDescription: r.description || null, primaryError: null,
      statusCheckAt: isoPlusMinute(now), statusCheckAttemptedAt: null,
    };
  }
  return {
    classification: 'failed', status: 'error', reasonCode: r.code || null,
    reasonDescription: r.description || null,
    primaryError: { reasonCode: r.code || null, reasonDescription: r.description || null },
    statusCheckAt: null, statusCheckAttemptedAt: null,
  };
}

export function shouldCheckPortinStatus({ statusCheckAt, statusCheckAttemptedAt, now = new Date().toISOString() }) {
  return Boolean(statusCheckAt && !statusCheckAttemptedAt && new Date(now).getTime() >= new Date(statusCheckAt).getTime());
}

export function classifyPortinStatus({ httpStatus, response = {}, expectedMsisdn, initiation }) {
  const r = reason(response);
  const result = response.Result || response.result || {};
  const actual = String(result.MSISDN ?? result.msisdn ?? response.MSISDN ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const desc = String(response.description ?? r.description ?? '').trim();
  if (httpStatus >= 200 && httpStatus < 300 && SUCCESS_CODES.has(r.code.toUpperCase()) && actual === String(expectedMsisdn).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')) {
    if (r.code.toUpperCase() === 'CF') {
      return {
        classification: 'completed', status: 'provisioning',
        reasonCode: r.code, reasonDescription: r.description,
        statusCheckAt: null, statusCheckAttemptedAt: null,
        primaryError: null,
      };
    }
    return { classification: 'completed', status: 'active', primaryError: null };
  }
  if (/Port Request Does Not Exist/i.test(desc)) {
    return { classification: 'failed', status: 'error', primaryError: {
      reasonCode: initiation?.reasonCode || null,
      reasonDescription: initiation?.reasonDescription || null,
    }};
  }
  return { classification: 'failed', status: 'error', statusCheckAt: null, statusCheckAttemptedAt: null, primaryError: {
    reasonCode: initiation?.reasonCode || r.code || null,
    reasonDescription: initiation?.reasonDescription || r.description || desc || null,
  }};
}

// Records the reason behind a terminal portinStatus result (completed or
// failed) on the sims row. Never throws: a failed write is logged and the
// caller's finalization continues.
export async function recordPortinStatusOutcome({ patch, iccid, statusCode, description, result, msisdn, now = new Date().toISOString() }) {
  try {
    const outcome = classifyPortinStatus({
      httpStatus: 200,
      response: { statusCode, description, Result: result || {} },
      expectedMsisdn: msisdn,
    });
    await patch({
      atomic_portin_reason_code: outcome.primaryError?.reasonCode ?? result?.reasonCode ?? null,
      atomic_portin_reason_description: outcome.primaryError?.reasonDescription ?? result?.reasonDescription ?? description ?? null,
      atomic_portin_status_attempted_at: now,
    });
    return outcome.classification;
  } catch (e) {
    console.error(`[AtomicPortinOutcome] SIM ${iccid}: outcome write failed: ${e}`);
    return null;
  }
}

// ── atomic_portin_outcomes history rows ─────────────────────────────────────
// One row per final port-in result (completed / failed / abandoned), so the
// reason a port failed is still visible after the sims columns move on.

const SECRET_KEY = /(pin|password|account_?number)$/i;
const RAW_MAX_CHARS = 4000;

// Deep copy with every key named like pin / password / accountNumber removed
// (portPin, oldPassword, account_number, ...). Carrier responses can echo the
// request back; the PIN and account number must never reach this table.
export function scrubPortinResponse(value) {
  if (Array.isArray(value)) return value.map(scrubPortinResponse);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = scrubPortinResponse(v);
  }
  return out;
}

function rawSnippet(raw) {
  if (raw == null) return null;
  const scrubbed = scrubPortinResponse(raw);
  const text = JSON.stringify(scrubbed);
  return text.length <= RAW_MAX_CHARS ? scrubbed : { truncated: text.slice(0, RAW_MAX_CHARS) };
}

// The human reason inside an ATOMIC description. A 951 buries it as
// "... ~ statusReasonDescription - T-Mobile Number Transfer PIN is required
// or incorrect"; others read "Error!!Port Request Does Not Exist".
export function portinHumanReason(description) {
  const text = String(description ?? '').trim();
  if (!text) return null;
  const m = text.match(/statusReasonDescription\s*-\s*([^~]+)/i);
  const reason = (m ? m[1] : text.replace(/^Error!!/i, '')).trim();
  return reason || null;
}

export function buildPortinOutcomeRow({ simId = null, iccid, msisdn = null, outcome, source, carrierCode = null, reasonCode = null, description = null, reason, raw = null, now = new Date().toISOString() }) {
  return {
    sim_id: simId ?? null,
    iccid: String(iccid),
    msisdn: msisdn ? String(msisdn) : null,
    outcome,
    source,
    carrier_code: carrierCode == null ? null : String(carrierCode),
    carrier_reason_code: reasonCode == null || reasonCode === '' ? null : String(reasonCode),
    carrier_description: reason !== undefined ? reason : portinHumanReason(description),
    raw_response: rawSnippet(raw),
    recorded_at: now,
  };
}

// Inserts one outcomes row. Never throws: the history row is for operators,
// and a failed write must not undo or block the finalization it describes.
export async function recordPortinOutcomeRow({ insert, row }) {
  try {
    await insert('atomic_portin_outcomes', [row]);
    return true;
  } catch (e) {
    console.error(`[AtomicPortinOutcome] SIM ${row && row.iccid}: outcomes row write failed: ${e}`);
    return false;
  }
}
