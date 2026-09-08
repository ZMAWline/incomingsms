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
